"""Lost items stay lost until found (Nov 2026, M1 / M2).

A checkout returned as lost, or a permanent item whose return is accepted as
lost, records op_status "lost" (with the person); until an items manager
marks it found (changes the status), it cannot be put in a cart, requested,
approved, handed over, assigned, reassigned or bulk-assigned - and a
reassignment in flight is dropped with a notice instead of handing a lost
item to the next person.

    python -m pytest test_items_lost.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import (AssignmentCreate, AssignmentReturnAccept, AssignmentReturnInit, BulkAssignPersonIn,
                           CartAddBody, CheckoutIn, CheckoutStatusUpdate, ItemUpdate)

U = kit.user


def _request(iid):
    return CheckoutIn(item_id=iid, item_name="x", requested_by="Evan", requested_by_email=kit.EMP_A2,
                      raised_by="Evan", reason="Site visit")


class LostItemTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_a_checkout_returned_lost_cannot_go_out_again_until_found(self):
        kit.add_item(self.db, "it-1", status="checked_out")
        kit.add_checkout(self.db, "co-1", "it-1", "allocated")
        items.update_checkout("co-1", CheckoutStatusUpdate(status="returned", condition="lost"),
                              user=U(kit.EMP_A), db=self.db)
        self.assertEqual(self.db.get(models.Item, "it-1").op_status, "lost")
        evan = U(kit.EMP_A2)
        e = kit.refused(self, 400, items.create_checkout, _request("it-1"), user=evan, db=self.db)
        self.assertIn("marked Lost", e.detail)
        self.db.rollback()
        kit.refused(self, 400, items.add_to_cart, CartAddBody(item_id="it-1", item_name="x"), user=evan, db=self.db)
        self.db.rollback()
        # An items manager marks it found; it can be asked for again.
        items.update_item("it-1", ItemUpdate(op_status="in_storage"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(items.create_checkout(_request("it-1"), user=evan, db=self.db)["status"], "pending")

    def test_a_request_in_flight_is_not_approved_or_handed_over_once_lost(self):
        kit.add_item(self.db, "it-2", op_status="lost")
        kit.add_checkout(self.db, "co-2", "it-2", "pending")
        kit.refused(self, 400, items.update_checkout, "co-2",
                    CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A),
                    user=U(kit.MGR_A), db=self.db)

    def test_a_lost_permanent_item_is_not_assigned(self):
        kit.add_item(self.db, "it-p", ownership="permanent", op_status="lost")
        mgr = U(kit.MGR_A)
        kit.refused(self, 400, items.assign_item, "it-p", AssignmentCreate(assignee_email=kit.EMP_A), user=mgr, db=self.db)
        self.db.rollback()
        out = items.bulk_assign_to_person(BulkAssignPersonIn(ids=["it-p"], assignee_email=kit.EMP_A), user=mgr, db=self.db)
        self.assertEqual((out["assigned"], out["skipped"]), (0, ["it-p"]))

    def test_a_return_accepted_as_lost_marks_the_item_lost_and_drops_the_reassignment(self):
        kit.add_item(self.db, "it-p", ownership="permanent", status="permanently_assigned",
                     assigned_to_email=kit.EMP_A)
        kit.add_assignment(self.db, "A1", "it-p", "active", assignee=kit.EMP_A)
        mgr = U(kit.MGR_A)
        items.reassign_item("it-p", AssignmentCreate(assignee_email=kit.EMP_A2), user=mgr, db=self.db)
        items.initiate_assignment_return("A1", AssignmentReturnInit(reason="lost"), user=U(kit.EMP_A), db=self.db)
        items.accept_assignment_return("A1", AssignmentReturnAccept(disposition="stock"), user=mgr, db=self.db)
        item = self.db.get(models.Item, "it-p")
        self.assertEqual((item.op_status, item.op_status_person_email), ("lost", kit.EMP_A))
        self.assertEqual(self.db.query(models.ItemAssignment).filter_by(status="pending_acceptance").count(), 0)
        told = {n.recipient for n in kit.bells(self.db, "perm_update") if n.title.startswith("Reassignment cancelled")}
        self.assertEqual(told, {kit.EMP_A2, kit.MGR_A})


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
