"""Item Management evidence rules (Nov 2026, H2 / M1).

  * an item is checked back in only by the person holding it, its allocator
    or an items manager - and only an items manager may give a reason
    instead of a return photo (checking it in for a holder who is not there);
  * the requester only CONFIRMS RECEIPT (pending_receipt -> allocated): they
    never take an approved item straight to "allocated", skipping the
    allocator and the handover photo;
  * a handed-over checkout (pending_receipt) is cancelled only through the
    manager's reconcile-state, never by a PATCH;
  * a permanent item's return needs a photo on the reassign path too, sending
    the return again keeps the photo it already has, and the holder never
    accepts their own return.

    python -m pytest test_items_evidence.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import (AssignmentCreate, AssignmentReturnAccept, AssignmentReturnInit, CheckoutStatusUpdate,
                           ReconcileStateIn)

U = kit.user


class CheckoutEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _co(self, status, **cols):
        kit.add_item(self.db, "it-1", status="checked_out" if status == "allocated" else "available")
        kit.add_checkout(self.db, "co-1", "it-1", status, **cols)

    def _patch(self, who, **body):
        return items.update_checkout("co-1", CheckoutStatusUpdate(**body), user=U(who), db=self.db)

    def test_only_the_holder_the_allocator_or_an_items_manager_checks_it_in(self):
        self._co("allocated")
        kit.refused(self, 403, self._patch, kit.SUP_A, status="returned", return_photo_url=kit.PHOTO)
        self.db.rollback()
        kit.refused(self, 403, self._patch, kit.EMP_A2, status="returned", return_photo_url=kit.PHOTO)
        self.db.rollback()
        self.assertEqual(self._patch(kit.ALLOC_A, status="returned", return_photo_url=kit.PHOTO)["status"], "returned")

    def test_a_reason_instead_of_a_photo_is_an_items_managers_alone(self):
        self._co("allocated")
        # The allocator has the item in hand: a photo, not a note.
        e = kit.refused(self, 400, self._patch, kit.ALLOC_A, status="returned", condition_note="Left on site")
        self.assertIn("return photo", e.detail)
        self.db.rollback()
        out = self._patch(kit.MGR_A, status="returned", condition_note="Force-returned - left on site")
        self.assertEqual(out["status"], "returned")

    def test_the_requester_never_hands_an_approved_item_to_themselves(self):
        self._co("approved")
        kit.refused(self, 403, self._patch, kit.EMP_A, status="allocated", checkout_photo_url=kit.PHOTO)
        self.db.rollback()
        row = self.db.get(models.ItemCheckout, "co-1")
        self.db.refresh(row)
        self.assertEqual(row.status, "approved")
        # The allocator hands it over; then the requester confirms receipt.
        self.assertEqual(self._patch(kit.ALLOC_A, status="pending_receipt")["status"], "pending_receipt")
        self.assertEqual(self._patch(kit.EMP_A, status="allocated", receipt_photo_url=kit.PHOTO)["status"], "allocated")

    def test_a_handed_over_item_is_not_cancelled_by_a_patch(self):
        self._co("pending_receipt", handed_over_at="2026-10-02T10:00:00+00:00")
        e = kit.refused(self, 409, self._patch, kit.EMP_A, status="cancelled")
        self.assertIn("handed over", e.detail)
        self.db.rollback()
        kit.refused(self, 409, self._patch, kit.MGR_A, status="cancelled")
        self.db.rollback()
        out = items.reconcile_item_state("it-1", ReconcileStateIn(cancel_checkout_id="co-1"),
                                         user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["cancelledCheckoutId"], "co-1")

    def test_who_acted_comes_from_the_session(self):
        self._co("pending")
        out = self._patch(kit.MGR_A, status="approved", assigned_allocator_email=kit.ALLOC_A,
                          resolved_by="Somebody Else")
        self.assertEqual(out["resolvedBy"], "Mia Alpha")
        out = self._patch(kit.ALLOC_A, status="allocated", checkout_photo_url=kit.PHOTO, allocated_by="Not Me")
        self.assertEqual(out["allocatedBy"], "Alan Alpha")

    def test_the_allocator_must_be_a_nexus_person(self):
        self._co("pending")
        kit.refused(self, 400, self._patch, kit.MGR_A, status="approved",
                    assigned_allocator_email="stranger@example.com")


class AssignmentEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        kit.add_item(self.db, "it-p", ownership="permanent", status="permanently_assigned",
                     assigned_to_email=kit.SUP_A)
        kit.add_assignment(self.db, "A1", "it-p", "active", assignee=kit.SUP_A)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _init(self, who, **body):
        return items.initiate_assignment_return("A1", AssignmentReturnInit(**body), user=U(who), db=self.db)

    def test_the_reassign_path_needs_a_return_photo(self):
        items.reassign_item("it-p", AssignmentCreate(assignee_email=kit.EMP_A2), user=U(kit.MGR_A), db=self.db)
        # The manager asked for it back - the holder still returns it with a photo.
        kit.refused(self, 400, self._init, kit.SUP_A, reason="normal")
        self.db.rollback()
        # Nor can the manager accept a return nobody photographed.
        e = kit.refused(self, 400, items.accept_assignment_return, "A1", AssignmentReturnAccept(),
                        user=U(kit.MGR_A), db=self.db)
        self.assertIn("photo", e.detail)
        self.db.rollback()
        self.assertEqual(self._init(kit.SUP_A, reason="normal", photo_url=kit.PHOTO)["returnReason"], "reassign")
        out = items.accept_assignment_return("A1", AssignmentReturnAccept(), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["status"], "closed")
        nxt = self.db.query(models.ItemAssignment).filter_by(item_id="it-p", status="pending_acceptance").one()
        self.assertEqual(nxt.assignee_email, kit.EMP_A2)

    def test_sending_the_return_again_keeps_the_photo_and_the_bell(self):
        self._init(kit.SUP_A, reason="normal", photo_url=kit.PHOTO, note="Screen fine")
        first = kit.bells(self.db, "perm_return", "A1")
        out = self._init(kit.SUP_A, reason="normal")
        self.assertEqual(out["returnPhotoUrl"], kit.PHOTO)
        self.assertEqual(out["returnNote"], "Screen fine")
        again = kit.bells(self.db, "perm_return", "A1")
        self.assertEqual(sorted(n.id for n in again), sorted(n.id for n in first))   # updated in place, never re-sent

    def test_the_holder_never_accepts_their_own_return(self):
        self._init(kit.SUP_A, reason="normal", photo_url=kit.PHOTO)
        kit.refused(self, 403, items.accept_assignment_return, "A1", AssignmentReturnAccept(),
                    user=U(kit.SUP_A), db=self.db)
        self.db.rollback()
        self.assertEqual(items.accept_assignment_return("A1", AssignmentReturnAccept(),
                                                        user=U(kit.MGR_A), db=self.db)["status"], "closed")

    def test_assignees_must_be_nexus_people(self):
        kit.add_item(self.db, "it-q", ownership="permanent")
        kit.refused(self, 400, items.assign_item, "it-q", AssignmentCreate(assignee_email="ghost@example.com"),
                    user=U(kit.MGR_A), db=self.db)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
