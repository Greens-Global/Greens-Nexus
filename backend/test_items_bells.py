"""Item Management bells (Nov 2026, H3 / M4, narrowed by review).

  * the company on a bell is stamped from an EMAIL (the requester's) or the
    item's company - never the display name, which always gave '' and so,
    with the walls armed, hid every items broadcast from every walled manager;
  * an extension, a return to accept and a checkout request with no
    approver picked reach exactly who saw them before - the managers'
    broadcast, now stamped with the ITEM's company (every manager with the
    walls off; that company's managers once armed) - plus, by name (and so
    by Web Push), the Inventory desk below the manager tier: Inventory grant
    holders at Editor / Full whose own scope admits the item's company. The
    manager tier is never named, so a push never goes to every manager;
  * an approver who was picked gets it alone; every copy clears together;
  * an order still gets its "Request confirmed" when an item was rejected -
    also when the LAST item to settle is the rejection or a cancel - and the
    allocator's "Hand over" and the requester's "Confirm receipt" bells
    shrink and clear as items move; a holder's "Please return" clears when
    they send the return.

    python -m pytest test_items_bells.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import (AssignmentCreate, AssignmentReturnInit, CheckoutIn, CheckoutStatusUpdate,
                           ExtensionRequest, ExtensionResolve, ReconcileStateIn)

U = kit.user


def _live(db, ntype, ref):
    db.flush()
    return [n for n in kit.bells(db, ntype, ref) if not n.actioned]


def _desk(db, *emails):
    db.add(models.NexusGroup(id="grp-inv", name="Item Desk", allowed_modules="inventory:editor"))
    for em in emails:
        db.add(models.NexusGroupMember(group_id="grp-inv", email=em))
    db.commit()


class TargetedBellTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_an_extension_is_the_stamped_broadcast_plus_the_desk(self):
        _desk(self.db, kit.EMP_A2, kit.MGR_A2, kit.EMP_B)
        kit.add_item(self.db, "it-1", status="checked_out")
        kit.add_checkout(self.db, "co-1", "it-1", "allocated")
        with kit.walls():
            items.request_extension("co-1", ExtensionRequest(days=2, reason="Trip ran long"), user=U(kit.EMP_A), db=self.db)
        rows = _live(self.db, "extension_pending", "co-1")
        # The broadcast (company A) + Evan by name. Max is a manager: he sees the
        # broadcast, never a named copy. Beth's scope (company B) does not reach it.
        self.assertEqual(sorted((n.recipient, n.company) for n in rows), [("", kit.COA), (kit.EMP_A2, kit.COA)])
        items.resolve_extension("co-1", ExtensionResolve(action="approve"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(_live(self.db, "extension_pending", "co-1"), [])           # every copy clears

    def test_walls_off_the_desk_reaches_every_company(self):
        _desk(self.db, kit.EMP_B)
        kit.add_item(self.db, "it-1", status="checked_out")
        kit.add_checkout(self.db, "co-1", "it-1", "allocated")
        with kit.walls(False):
            items.request_extension("co-1", ExtensionRequest(days=1, reason="r"), user=U(kit.EMP_A), db=self.db)
        self.assertEqual({n.recipient for n in _live(self.db, "extension_pending", "co-1")}, {"", kit.EMP_B})

    def test_the_approver_alone_when_one_was_picked(self):
        kit.add_item(self.db, "it-2", status="checked_out")
        kit.add_checkout(self.db, "co-2", "it-2", "allocated", approver=kit.MGR_A)
        items.request_extension("co-2", ExtensionRequest(days=1, reason="r"), user=U(kit.EMP_A), db=self.db)
        self.assertEqual([n.recipient for n in _live(self.db, "extension_pending", "co-2")], [kit.MGR_A])

    def test_a_request_with_no_approver_and_its_clearing(self):
        _desk(self.db, kit.EMP_A2)
        kit.add_item(self.db, "it-3")
        items.create_checkout(CheckoutIn(item_id="it-3", item_name="x", requested_by="Erin",
                                         requested_by_email=kit.EMP_A, raised_by="Erin", reason="Site"),
                              user=U(kit.EMP_A), db=self.db)
        co = self.db.query(models.ItemCheckout).filter_by(item_id="it-3").one()
        rows = _live(self.db, "checkout_pending", co.id)
        self.assertEqual(sorted(n.recipient for n in rows), ["", kit.EMP_A2])
        self.assertEqual({n.company for n in rows}, {kit.COA})
        items.update_checkout(co.id, CheckoutStatusUpdate(status="rejected"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(_live(self.db, "checkout_pending", co.id), [])

    def test_the_approver_must_reach_the_items_company(self):
        kit.add_item(self.db, "it-4")
        body = CheckoutIn(item_id="it-4", item_name="x", requested_by="Erin", requested_by_email=kit.EMP_A,
                          raised_by="Erin", reason="Site", approver_email=kit.MGR_B)
        with kit.walls():
            # Bob (company B) is not offered and cannot be addressed for company A's item.
            emails = {p["email"] for p in items.list_approvers(item_id="it-4", user=U(kit.OWNER), db=self.db)}
            self.assertIn(kit.MGR_A, emails)
            self.assertNotIn(kit.MGR_B, emails)
            kit.refused(self, 400, items.create_checkout, body, user=U(kit.OWNER), db=self.db)

    def test_a_company_with_nobody_to_name_gets_the_stamped_broadcast(self):
        kit.add_item(self.db, "it-c", "ent-nobody", ownership="permanent", status="permanently_assigned")
        kit.add_assignment(self.db, "A9", "it-c", "active", assignee=kit.EMP_A, by="")
        items.initiate_assignment_return("A9", AssignmentReturnInit(reason="normal", photo_url=kit.PHOTO),
                                         user=U(kit.EMP_A), db=self.db)
        rows = _live(self.db, "perm_return", "A9")
        self.assertEqual([(n.recipient, n.company) for n in rows], [("", "ent-nobody")])

    def test_sending_the_return_clears_the_holders_please_return(self):
        kit.add_item(self.db, "it-p", ownership="permanent", status="permanently_assigned")
        kit.add_assignment(self.db, "A1", "it-p", "active", assignee=kit.EMP_A)
        items.reassign_item("it-p", AssignmentCreate(assignee_email=kit.EMP_A2), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(len(_live(self.db, "perm_assign", "A1")), 1)
        items.initiate_assignment_return("A1", AssignmentReturnInit(reason="dead", photo_url=kit.PHOTO),
                                         user=U(kit.EMP_A), db=self.db)
        self.assertEqual(_live(self.db, "perm_assign", "A1"), [])
        rows = _live(self.db, "perm_return", "A1")
        self.assertTrue(rows and all(n.title.startswith("ITEM DEAD") for n in rows))


class OrderBellTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        for iid in ("it-1", "it-2", "it-3"):
            kit.add_item(self.db, iid)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _patch(self, cid, who, **body):
        return items.update_checkout(cid, CheckoutStatusUpdate(**body), user=U(who), db=self.db)

    def test_request_confirmed_fires_when_a_sibling_was_rejected(self):
        kit.add_checkout(self.db, "co-1", "it-1", "pending", order="ORD")
        kit.add_checkout(self.db, "co-2", "it-2", "pending", order="ORD")
        self._patch("co-1", kit.MGR_A, status="rejected")
        self._patch("co-2", kit.MGR_A, status="approved", assigned_allocator_email=kit.ALLOC_A)
        self._patch("co-2", kit.ALLOC_A, status="allocated", checkout_photo_url=kit.PHOTO)
        self.db.flush()
        titles = [n.title for n in kit.bells(self.db, "allocated", "ORD")]
        self.assertIn("Request confirmed: 1 item with you", titles)

    def test_request_confirmed_fires_when_the_last_item_to_settle_is_a_rejection(self):
        kit.add_checkout(self.db, "co-1", "it-1", "pending", order="ORD")
        kit.add_checkout(self.db, "co-2", "it-2", "pending", order="ORD")
        self._patch("co-1", kit.MGR_A, status="approved", assigned_allocator_email=kit.ALLOC_A)
        self._patch("co-1", kit.ALLOC_A, status="allocated", checkout_photo_url=kit.PHOTO)
        self.assertEqual([n for n in _live(self.db, "allocated", "ORD") if n.title.startswith("Request confirmed")], [])
        self._patch("co-2", kit.MGR_A, status="rejected")
        titles = [n.title for n in _live(self.db, "allocated", "ORD")]
        self.assertEqual(titles.count("Request confirmed: 1 item with you"), 1)

    def test_nothing_with_them_sends_no_request_confirmed(self):
        kit.add_checkout(self.db, "co-1", "it-1", "pending", order="ORD")
        self._patch("co-1", kit.MGR_A, status="rejected")
        self.assertEqual([n for n in kit.bells(self.db, "allocated", "ORD")], [])

    def test_handover_and_receipt_bells_shrink_and_clear(self):
        for cid, iid in (("co-1", "it-1"), ("co-2", "it-2"), ("co-3", "it-3")):
            kit.add_checkout(self.db, cid, iid, "pending", order="ORD", allocator="")
        for cid in ("co-1", "co-2", "co-3"):
            self._patch(cid, kit.MGR_A, status="approved", assigned_allocator_email=kit.ALLOC_A)
        hand = _live(self.db, "allocate_request", "ORD")
        self.assertEqual([n.title for n in hand], ["Hand over 3 items to Erin"])
        self._patch("co-1", kit.ALLOC_A, status="pending_receipt")
        self.assertEqual([n.title for n in _live(self.db, "allocate_request", "ORD")], ["Hand over 2 items to Erin"])
        self._patch("co-2", kit.ALLOC_A, status="pending_receipt")
        self._patch("co-3", kit.MGR_A, status="cancelled")      # cancelled on Erin's behalf before handover
        self.assertEqual(_live(self.db, "allocate_request", "ORD"), [])       # nothing left to hand over
        receipt = [n for n in _live(self.db, "allocated", "ORD") if n.title.startswith("Confirm receipt")]
        self.assertEqual([n.title for n in receipt], ["Confirm receipt: 2 items"])
        self._patch("co-1", kit.EMP_A, status="allocated", receipt_photo_url=kit.PHOTO)
        receipt = [n for n in _live(self.db, "allocated", "ORD") if n.title.startswith("Confirm receipt")]
        self.assertEqual([n.title for n in receipt], ["Confirm receipt: 1 item"])
        # The manager cancels the last unconfirmed handover: the bell goes.
        items.reconcile_item_state("it-2", ReconcileStateIn(cancel_checkout_id="co-2"), user=U(kit.MGR_A), db=self.db)
        receipt = [n for n in _live(self.db, "allocated", "ORD") if n.title.startswith("Confirm receipt")]
        self.assertEqual(receipt, [])


class HandOverBellTests(unittest.TestCase):
    """Review 11/02/2026: the allocator's hand-over bell carries the Hand Over
    action (it was written with action "" so the button never showed), and an
    items manager can name a new allocator after offboarding."""

    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_the_hand_over_bell_has_its_action(self):
        import json
        from routers.items import CheckoutStatusUpdate
        kit.add_item(self.db, "hb-1")
        kit.add_checkout(self.db, "hb-co", "hb-1", "pending", allocator="")
        items.update_checkout("hb-co", CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A,
                                                            assigned_allocator_name="Alan"), user=U(kit.MGR_A), db=self.db)
        bell = kit.bells(self.db, "allocate_request", "hb-co")[0]
        self.assertEqual(json.loads(bell.action)["kind"], "allocate")

    def test_pick_a_new_allocator(self):
        import json
        from routers.items import AllocatorIn
        kit.add_item(self.db, "hb-2")
        kit.add_checkout(self.db, "hb-co2", "hb-2", "approved", allocator="")
        kit.refused(self, 403, items.set_checkout_allocator, "hb-co2", AllocatorIn(allocator_email=kit.ALLOC_A), user=U(kit.EMP_A), db=self.db)
        out = items.set_checkout_allocator("hb-co2", AllocatorIn(allocator_email=kit.ALLOC_A), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["assignedAllocatorEmail"], kit.ALLOC_A)
        bell = [n for n in kit.bells(self.db, "allocate_request", "hb-co2") if n.recipient == kit.ALLOC_A][0]
        self.assertEqual(json.loads(bell.action)["kind"], "allocate")
        with kit.walls():
            kit.refused(self, 404, items.set_checkout_allocator, "hb-co2", AllocatorIn(allocator_email=kit.ALLOC_A), user=U(kit.MGR_B), db=self.db)



def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
