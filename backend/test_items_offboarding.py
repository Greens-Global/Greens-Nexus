"""Offboarding takes the equipment back cleanly (Nov 2026, M8 - force_return_person).

HR offboarding returns what a leaver holds, cancels what they asked for and
closes their assignments (routers.items.force_return_person). It now also:
  * clears a pending extension on a returned checkout, with the managers'
    extension bell;
  * actions the approval and hand-over bells of what it cancels;
  * drops a reassignment in flight and tells the person who was promised
    the item and the manager who started it.

    python -m pytest test_items_offboarding.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items

U = kit.user


class OffboardingTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_everything_comes_back_and_nothing_is_left_waiting(self):
        db = self.db
        kit.add_item(db, "it-1", status="checked_out")
        kit.add_item(db, "it-2")
        kit.add_item(db, "it-p", ownership="permanent", status="permanently_assigned", assigned_to_email=kit.EMP_A)
        kit.add_checkout(db, "co-1", "it-1", "allocated", extension_status="pending", extension_days=3,
                         extension_reason="Trip")
        kit.add_checkout(db, "co-2", "it-2", "approved")
        kit.add_assignment(db, "A1", "it-p", "return_initiated", assignee=kit.EMP_A, return_reason="reassign",
                           next_assignee_email=kit.EMP_A2, next_assignee_name="Evan Alpha")
        for ntype, ref, to in (("extension_pending", "co-1", kit.MGR_A), ("allocate_request", "co-2", kit.ALLOC_A),
                               ("perm_return", "A1", kit.MGR_A)):
            items._notify(db, type=ntype, recipient=to, title=ntype, body="", ref_id=ref)
        db.commit()

        out = items.force_return_person(db, kit.EMP_A, kit.MGR_A)
        db.commit()
        self.assertEqual(out, {"checkouts": 2, "assignments": 1})
        co1 = db.get(models.ItemCheckout, "co-1")
        self.assertEqual((co1.status, co1.extension_status, co1.extension_days), ("returned", "", 0))
        self.assertEqual(db.get(models.ItemCheckout, "co-2").status, "cancelled")
        self.assertEqual([n for n in kit.bells(db) if not n.actioned and n.type in
                          ("extension_pending", "allocate_request", "perm_return")], [])
        a = db.get(models.ItemAssignment, "A1")
        self.assertEqual((a.status, a.next_assignee_email), ("closed", ""))
        told = {n.recipient for n in kit.bells(db, "perm_update") if n.title.startswith("Reassignment cancelled")}
        self.assertEqual(told, {kit.EMP_A2, kit.MGR_A})
        self.assertEqual(db.get(models.Item, "it-p").status, "available")


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
