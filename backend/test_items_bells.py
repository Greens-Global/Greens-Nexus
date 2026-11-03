"""Item Management bells (Nov 2026, H3 / M4).

  * the company on a bell is stamped from an EMAIL (the requester's), never
    the display name - which always gave '' and so, with the walls armed,
    hid every items broadcast from every walled manager;
  * an extension, a return to accept and a checkout request with no
    approver picked go to NAMED people - the approver, else the items
    managers of the item's company (the manager tier, or an Inventory grant
    at Editor) - never the requester, and the '' broadcast only when that
    company has nobody to name; one bell per person per workflow, and every
    copy clears when it is decided;
  * an order with a rejected item still gets its "Request confirmed", and
    the allocator's "Hand over" and the requester's "Confirm receipt" bells
    clear (or shrink) as items are handed over, confirmed or cancelled.

    python -m pytest test_items_bells.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import (AssignmentReturnInit, CheckoutIn, CheckoutStatusUpdate, ExtensionRequest,
                           ExtensionResolve, ReconcileStateIn)

U = kit.user
A_MANAGERS = {kit.MGR_A, kit.MGR_A2, kit.OWNER}   # company A's manager tier and above


def _live(db, ntype, ref):
    db.flush()
    return [n for n in kit.bells(db, ntype, ref) if not n.actioned]


class TargetedBellTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_an_extension_goes_to_the_items_managers_of_the_items_company(self):
        kit.add_item(self.db, "it-1", status="checked_out")
        kit.add_checkout(self.db, "co-1", "it-1", "allocated", requester=kit.MGR_A2)
        items.request_extension("co-1", ExtensionRequest(days=2, reason="Trip ran long"), user=U(kit.MGR_A2), db=self.db)
        rows = _live(self.db, "extension_pending", "co-1")
        self.assertEqual({n.recipient for n in rows}, A_MANAGERS - {kit.MGR_A2})   # never the requester
        self.assertEqual({n.company for n in rows}, {kit.COA})
        items.resolve_extension("co-1", ExtensionResolve(action="approve"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(_live(self.db, "extension_pending", "co-1"), [])           # every copy clears

    def test_the_approver_alone_when_one_was_picked(self):
        kit.add_item(self.db, "it-2", status="checked_out")
        kit.add_checkout(self.db, "co-2", "it-2", "allocated", approver=kit.MGR_A)
        items.request_extension("co-2", ExtensionRequest(days=1, reason="r"), user=U(kit.EMP_A), db=self.db)
        self.assertEqual([n.recipient for n in _live(self.db, "extension_pending", "co-2")], [kit.MGR_A])

    def test_an_inventory_editor_grant_counts_as_an_items_manager(self):
        self.db.add(models.NexusGroup(id="grp-inv", name="Item Desk", allowed_modules="inventory:editor"))
        self.db.add(models.NexusGroupMember(group_id="grp-inv", email=kit.EMP_A2))
        self.db.commit()
        kit.add_item(self.db, "it-3")
        items.create_checkout(CheckoutIn(item_id="it-3", item_name="x", requested_by="Erin",
                                         requested_by_email=kit.EMP_A, raised_by="Erin", reason="Site"),
                              user=U(kit.EMP_A), db=self.db)
        co = self.db.query(models.ItemCheckout).filter_by(item_id="it-3").one()
        rows = _live(self.db, "checkout_pending", co.id)
        self.assertEqual({n.recipient for n in rows}, A_MANAGERS | {kit.EMP_A2})
        items.update_checkout(co.id, CheckoutStatusUpdate(status="rejected"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(_live(self.db, "checkout_pending", co.id), [])

    def test_a_company_with_nobody_to_name_falls_back_to_the_stamped_broadcast(self):
        kit.add_item(self.db, "it-c", "ent-nobody", ownership="permanent", status="permanently_assigned")
        kit.add_assignment(self.db, "A9", "it-c", "active", assignee=kit.EMP_A, by="")
        items.initiate_assignment_return("A9", AssignmentReturnInit(reason="normal", photo_url=kit.PHOTO),
                                         user=U(kit.EMP_A), db=self.db)
        rows = _live(self.db, "perm_return", "A9")
        self.assertEqual([(n.recipient, n.company) for n in rows], [("", "ent-nobody")])

    def test_a_return_goes_to_the_companys_items_managers_and_the_assigner(self):
        kit.add_item(self.db, "it-p", ownership="permanent", status="permanently_assigned")
        kit.add_assignment(self.db, "A1", "it-p", "active", assignee=kit.EMP_A, by=kit.MGR_B)
        items.initiate_assignment_return("A1", AssignmentReturnInit(reason="dead", photo_url=kit.PHOTO),
                                         user=U(kit.EMP_A), db=self.db)
        rows = _live(self.db, "perm_return", "A1")
        self.assertEqual({n.recipient for n in rows}, A_MANAGERS | {kit.MGR_B})
        self.assertTrue(all(n.title.startswith("ITEM DEAD") for n in rows))


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


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
