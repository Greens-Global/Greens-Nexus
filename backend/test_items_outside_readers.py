"""Item Management data read OUTSIDE routers/items.py obeys the same rules (Nov 2026 review).

The daily briefing and Insights read the checkout / assignment tables
directly. They now go through the Item Management wall
(routers.items.walled_item_rows) and, for the decisions, the Approvals
sources themselves - so the briefing, the Insights "Inventory Requests"
count and its drill-down, and the Approvals badge always agree:
  * a walled manager counts / is briefed on their companies' items only;
  * an extension or a return to check in is briefed to an ITEMS MANAGER
    (never their own), not to anyone who happens to have reports;
  * a Reassign the holder has not returned with a photo yet waits on no one
    (accept-return refuses it - it belongs to the Recover path).

    python -m pytest test_items_outside_readers.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import approvals_inbox
import daily_briefing
from routers import dashboards

U = kit.user


class OutsideReaderTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        kit.add_item(self.db, "it-a", kit.COA)
        kit.add_item(self.db, "it-b", kit.COB)
        kit.add_checkout(self.db, "co-a", "it-a", "pending", allocator="")
        kit.add_checkout(self.db, "co-b", "it-b", "pending", requester=kit.EMP_B, allocator="")
        kit.add_checkout(self.db, "ext-a", "it-a", "allocated", extension_status="pending", extension_days=2)
        kit.add_checkout(self.db, "ext-b", "it-b", "allocated", requester=kit.EMP_B, extension_status="pending",
                         extension_days=2)
        kit.add_item(self.db, "ip-a", kit.COA, ownership="permanent", status="permanently_assigned")
        kit.add_item(self.db, "ip-b", kit.COB, ownership="permanent", status="permanently_assigned")
        kit.add_item(self.db, "ip-r", kit.COA, ownership="permanent", status="permanently_assigned")
        kit.add_assignment(self.db, "ret-a", "ip-a", "return_initiated", return_reason="normal", return_photo_url=kit.PHOTO)
        kit.add_assignment(self.db, "ret-b", "ip-b", "return_initiated", assignee=kit.EMP_B, return_reason="normal",
                           return_photo_url=kit.PHOTO)
        # Reassigned by a manager, not yet returned by the holder: no photo.
        kit.add_assignment(self.db, "ret-r", "ip-r", "return_initiated", return_reason="reassign",
                           next_assignee_email=kit.EMP_A2)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_insights_count_and_drilldown_stay_inside_the_wall(self):
        with kit.walls():
            self.assertEqual(dashboards._inventory_pending(self.db, U(kit.MGR_A)).count(), 1)
            self.assertEqual({c.id for c in dashboards._inventory_pending(self.db, U(kit.MGR_B)).all()}, {"co-b"})
            self.assertEqual(dashboards._inventory_pending(self.db, U(kit.OWNER)).count(), 2)
        with kit.walls(False):
            self.assertEqual(dashboards._inventory_pending(self.db, U(kit.MGR_A)).count(), 2)

    def test_the_briefing_agrees_with_the_approvals_badge(self):
        with kit.walls():
            rows = daily_briefing._item_action_rows(self.db, kit.MGR_A, False)
            ext = [r["title"] for r in rows if r["title"].startswith("Approve Extension")]
            self.assertEqual(ext, ["Approve Extension: Item it-a"])
            know = daily_briefing._item_needs_to_know_rows(self.db, kit.MGR_A, "2026-01-01", False)
            ret = [r["title"] for r in know if r["title"].startswith("Return Pending")]
            self.assertEqual(ret, ["Return Pending Confirmation: Item ip-a"])
            counts = approvals_inbox.collect(self.db, U(kit.MGR_A))["counts"]
            self.assertEqual((counts.get("item_extension", 0), counts.get("assignment_return", 0)),
                             (len(ext), len(ret)))
        # Somebody with reports but no items-manager role is not briefed on them.
        self.assertEqual([r for r in daily_briefing._item_action_rows(self.db, kit.EMP_A2, True)
                          if r["title"].startswith("Approve Extension")], [])

    def test_an_unreturned_reassign_waits_on_no_one(self):
        keys = {r["key"] for r in approvals_inbox._assignment_returns(self.db, U(kit.OWNER), {})}
        self.assertIn("assignment_return:ret-a", keys)
        self.assertNotIn("assignment_return:ret-r", keys)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
