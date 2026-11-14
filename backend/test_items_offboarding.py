"""Offboarding and the equipment (Nov 2026, M8 - force_return_person; Return
Pending, Neil 11/14/2026).

When HR marks someone Left, routers.items.force_return_person:
  * cancels what they asked for and was never handed over (with its
    approval and hand-over bells), and assignments they never accepted;
  * leaves what is physically still with them OUT - Return Pending - never
    back in stock by itself: the item keeps pointing at the leaver as its
    last holder and nobody else can borrow it or be assigned it;
  * clears a pending extension with the managers' extension bell;
  * drops a reassignment in flight and tells the person who was promised
    the item and the manager who started it.
Received or Lost (settle_return_pending - the exit and Item Management)
closes it the ordinary way: Received needs the return photo, Lost marks the
item Lost.

    python -m pytest test_items_offboarding.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

from fastapi import HTTPException

import models
from routers import items

U = kit.user


def _leave(db, email):
    db.query(models.NexusEmployee).filter_by(work_email=email).update({"status": "offboarded"})
    db.commit()


class OffboardingTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _out_with_them(self):
        db = self.db
        kit.add_item(db, "it-1", status="checked_out")
        kit.add_item(db, "it-2")
        kit.add_item(db, "it-p", ownership="permanent", status="permanently_assigned", assigned_to_email=kit.EMP_A)
        kit.add_checkout(db, "co-1", "it-1", "allocated", extension_status="pending", extension_days=3,
                         extension_reason="Trip")
        kit.add_checkout(db, "co-2", "it-2", "approved")
        kit.add_assignment(db, "A1", "it-p", "return_initiated", assignee=kit.EMP_A, return_reason="reassign",
                           next_assignee_email=kit.EMP_A2, next_assignee_name="Evan Alpha")
        for ntype, ref, to in (("extension_pending", "co-1", kit.MGR_A), ("allocate_request", "co-2", kit.ALLOC_A)):
            items._notify(db, type=ntype, recipient=to, title=ntype, body="", ref_id=ref)
        db.commit()
        out = items.force_return_person(db, kit.EMP_A, kit.MGR_A)
        db.commit()
        _leave(db, kit.EMP_A)
        return out

    def test_what_is_still_out_stays_out_as_return_pending(self):
        db = self.db
        out = self._out_with_them()
        self.assertEqual(out, {"checkouts": 1, "assignments": 0, "returnPending": 2})
        co1 = db.get(models.ItemCheckout, "co-1")
        self.assertEqual((co1.status, co1.extension_status, co1.extension_days), ("allocated", "", 0))
        self.assertTrue(co1.holder_left_at)
        self.assertEqual(db.get(models.Item, "it-1").status, "checked_out")          # never back in stock by itself
        self.assertEqual(db.get(models.ItemCheckout, "co-2").status, "cancelled")
        self.assertEqual([n for n in kit.bells(db) if not n.actioned and n.type in
                          ("extension_pending", "allocate_request")], [])
        a = db.get(models.ItemAssignment, "A1")
        self.assertEqual((a.status, a.return_reason, a.next_assignee_email), ("return_initiated", "offboarded", ""))
        it = db.get(models.Item, "it-p")
        self.assertEqual((it.status, it.assigned_to_email), ("permanently_assigned", kit.EMP_A))   # still theirs
        told = {n.recipient for n in kit.bells(db, "perm_update") if n.title.startswith("Reassignment cancelled")}
        self.assertEqual(told, {kit.EMP_A2, kit.MGR_A})
        # Nobody else can be assigned it or borrow it meanwhile.
        kit.refused(self, 409, items.assign_item, "it-p", items.AssignmentCreate(assignee_email=kit.EMP_A2),
                    user=U(kit.MGR_A), db=db)
        rows = items.return_pending_rows(db, [kit.EMP_A])[kit.EMP_A]
        self.assertEqual(sorted((r["kind"], r["id"], r["returnPending"]) for r in rows),
                         [("assignment", "A1", True), ("checkout", "co-1", True)])

    def test_received_needs_the_photo_and_closes_it(self):
        db = self.db
        self._out_with_them()
        with self.assertRaises(HTTPException) as e:
            items.settle_return_pending(db, "assignment", "A1", outcome="received", actor_email=kit.MGR_A)
        self.assertEqual(e.exception.status_code, 400)
        db.rollback()
        items.settle_return_pending(db, "assignment", "A1", outcome="received", actor_email=kit.MGR_A,
                                    photo_url=kit.PHOTO, photo_name="back.jpg")
        items.settle_return_pending(db, "checkout", "co-1", outcome="received", actor_email=kit.MGR_A,
                                    photo_url=kit.PHOTO)
        db.commit()
        a = db.get(models.ItemAssignment, "A1")
        self.assertEqual((a.status, a.disposition, a.return_photo_url), ("closed", "stock", kit.PHOTO))
        it = db.get(models.Item, "it-p")
        self.assertEqual((it.status, it.assigned_to_email, it.op_status or ""), ("available", "", ""))
        co = db.get(models.ItemCheckout, "co-1")
        self.assertEqual((co.status, db.get(models.Item, "it-1").status), ("returned", "available"))
        self.assertEqual(items.return_pending_rows(db, [kit.EMP_A])[kit.EMP_A], [])
        with self.assertRaises(HTTPException) as e:          # already back
            items.settle_return_pending(db, "checkout", "co-1", outcome="lost", actor_email=kit.MGR_A)
        self.assertEqual(e.exception.status_code, 409)

    def test_lost_marks_the_item_lost(self):
        db = self.db
        self._out_with_them()
        items.settle_return_pending(db, "checkout", "co-1", outcome="lost", actor_email=kit.MGR_A)
        items.settle_return_pending(db, "assignment", "A1", outcome="lost", actor_email=kit.MGR_A)
        db.commit()
        for iid in ("it-1", "it-p"):
            it = db.get(models.Item, iid)
            self.assertEqual((it.op_status, it.op_status_person_email), ("lost", kit.EMP_A))
        self.assertEqual(db.get(models.ItemAssignment, "A1").return_reason, "lost")

    def test_received_only_for_someone_who_left_and_only_by_an_items_manager(self):
        db = self.db
        kit.add_item(db, "it-3", status="checked_out")
        kit.add_checkout(db, "co-3", "it-3", "allocated")
        with self.assertRaises(HTTPException) as e:          # still working: the ordinary return
            items.settle_return_pending(db, "checkout", "co-3", outcome="received", actor_email=kit.MGR_A,
                                        photo_url=kit.PHOTO)
        self.assertEqual(e.exception.status_code, 409)
        db.rollback()
        _leave(db, kit.EMP_A)
        kit.refused(self, 403, items.settle_return_pending_route, "checkout", "co-3", "received",
                    items.ReturnPendingIn(photo_url=kit.PHOTO), user=U(kit.EMP_A2), db=db)
        items.settle_return_pending_route("checkout", "co-3", "received", items.ReturnPendingIn(photo_url=kit.PHOTO),
                                          user=U(kit.MGR_A), db=db)
        self.assertEqual(db.get(models.ItemCheckout, "co-3").status, "returned")

    def test_a_leaving_allocator_hands_the_handover_back_to_the_desk(self):
        db = self.db
        kit.add_item(db, "it-9")
        kit.add_checkout(db, "co-9", "it-9", "approved", requester=kit.EMP_A2, allocator=kit.ALLOC_A)
        items._notify(db, type="allocate_request", recipient=kit.ALLOC_A, title="Hand over: Item it-9",
                      body="", ref_id="co-9")
        db.commit()
        out = items.force_return_person(db, kit.ALLOC_A, kit.MGR_A)
        db.commit()
        self.assertEqual(out, {"checkouts": 0, "assignments": 0, "returnPending": 0})   # nothing of their own
        co = db.get(models.ItemCheckout, "co-9")
        self.assertEqual((co.status, co.assigned_allocator_email), ("approved", ""))
        self.assertTrue(all(n.actioned for n in kit.bells(db, "allocate_request", "co-9")))
        ask = [n for n in kit.bells(db, "allocator_needed", "co-9") if not n.actioned]
        self.assertEqual([(n.recipient, n.company) for n in ask], [("", kit.COA)])
        # An items manager hands it over: the ask clears.
        items.update_checkout("co-9", items.CheckoutStatusUpdate(status="allocated", checkout_photo_url=kit.PHOTO),
                              user=U(kit.MGR_A), db=db)
        db.flush()
        self.assertTrue(all(n.actioned for n in kit.bells(db, "allocator_needed", "co-9")))


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
