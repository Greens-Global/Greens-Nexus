"""Item Management company walls (Nov 2026, H1).

An item belongs to its company (items.company_id); a checkout and an
assignment to their ITEM's company. With the walls armed, a walled manager
lists only their companies' rows and an act on another company's row
answers 404 - on every route, and in the Approvals sources that feed the
nav counts. The parties to a row (requester, allocator, assignee) always
reach their own row. With the walls off, nothing changes; a Super
Administrator is never walled.

    python -m pytest test_items_walls.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import approvals_inbox
import models
from routers import items
from routers.items import (AssignmentCreate, AssignmentReturnAccept, AutoPhotoRequest, BulkAssignLocationIn,
                           BulkAssignPersonIn, BulkDeleteRequest, BulkUpdateRequest, CheckoutIn,
                           CheckoutStatusUpdate, ExtensionResolve, ReconcileStateIn, RestoreRequest)

A, B = kit.COA, kit.COB
U = kit.user


class ItemWallTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        kit.add_item(self.db, "it-a", A)
        kit.add_item(self.db, "it-b", B)
        kit.add_item(self.db, "it-pa", A, ownership="permanent")
        kit.add_item(self.db, "it-pb", B, ownership="permanent")
        kit.add_checkout(self.db, "co-a", "it-a", "pending", requester=kit.EMP_A, allocator="")
        kit.add_checkout(self.db, "co-b", "it-b", "pending", requester=kit.EMP_B, allocator="")
        kit.add_assignment(self.db, "as-a", "it-pa", "return_initiated", assignee=kit.EMP_A,
                           return_reason="normal", return_photo_url=kit.PHOTO)
        kit.add_assignment(self.db, "as-b", "it-pb", "return_initiated", assignee=kit.EMP_B, by=kit.MGR_B,
                           return_reason="normal", return_photo_url=kit.PHOTO)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── lists ────────────────────────────────────────────────────────────────
    def test_lists_keep_only_the_callers_companies(self):
        with kit.walls():
            self.assertEqual({c["id"] for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db)}, {"co-a"})
            self.assertEqual({c["id"] for c in items.list_checkouts(user=U(kit.MGR_B), db=self.db)}, {"co-b"})
            self.assertEqual({a["id"] for a in items.list_assignments(user=U(kit.MGR_A), db=self.db)}, {"as-a"})
            self.assertEqual({i["id"] for i in items.list_items(user=U(kit.MGR_A), db=self.db)}, {"it-a", "it-pa"})
            # A Super Administrator is never walled.
            self.assertEqual({c["id"] for c in items.list_checkouts(user=U(kit.OWNER), db=self.db)}, {"co-a", "co-b"})

    def test_walls_off_changes_nothing(self):
        with kit.walls(False):
            self.assertEqual({c["id"] for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db)}, {"co-a", "co-b"})
            self.assertEqual({a["id"] for a in items.list_assignments(user=U(kit.MGR_A), db=self.db)}, {"as-a", "as-b"})

    def test_a_party_always_sees_their_own_row(self):
        # Beth (company B) asked for company A's item before the walls were armed.
        kit.add_checkout(self.db, "co-x", "it-a", "approved", requester=kit.EMP_B, allocator=kit.ALLOC_A)
        with kit.walls():
            self.assertIn("co-x", {c["id"] for c in items.list_checkouts(user=U(kit.EMP_B), db=self.db)})
            self.assertIn("co-x", {c["id"] for c in items.list_checkouts(user=U(kit.ALLOC_A), db=self.db)})
            self.assertNotIn("co-x", {c["id"] for c in items.list_checkouts(user=U(kit.MGR_B), db=self.db)})

    def test_pickers_offer_only_people_inside_the_scope(self):
        with kit.walls():
            emails = {p["email"] for p in items.list_approvers(user=U(kit.EMP_A), db=self.db)}
        self.assertIn(kit.MGR_A, emails)
        self.assertNotIn(kit.MGR_B, emails)

    # ── one row, another company: 404 ─────────────────────────────────────────
    def test_acts_on_another_companys_rows_answer_404(self):
        mgr = U(kit.MGR_A)
        kit.add_checkout(self.db, "co-bx", "it-b", "allocated", requester=kit.EMP_B, allocator=kit.MGR_B,
                         extension_status="pending", extension_days=2, handed_over_at="2026-10-02T10:00:00+00:00")
        db = self.db
        with kit.walls():
            kit.refused(self, 404, items.update_checkout, "co-b",
                        CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A), user=mgr, db=db)
            kit.refused(self, 404, items.update_checkout, "co-b",
                        CheckoutStatusUpdate(status="rejected"), user=mgr, db=db)
            kit.refused(self, 404, items.resolve_extension, "co-bx", ExtensionResolve(action="approve"), user=mgr, db=db)
            kit.refused(self, 404, items.reconcile_item_state, "it-b", ReconcileStateIn(), user=mgr, db=db)
            kit.refused(self, 404, items.assign_item, "it-pb", AssignmentCreate(assignee_email=kit.EMP_A), user=mgr, db=db)
            kit.refused(self, 404, items.reassign_item, "it-pb", AssignmentCreate(assignee_email=kit.EMP_A), user=mgr, db=db)
            kit.refused(self, 404, items.cancel_assignment, "as-b", user=mgr, db=db)
            kit.refused(self, 404, items.accept_assignment_return, "as-b", AssignmentReturnAccept(), user=mgr, db=db)
            kit.refused(self, 404, items.delete_item, "it-b", user=U(kit.OWNER) | {"level": 3}, db=db)
            kit.refused(self, 404, items.assign_item_to_location, "it-b", items.AssignLocationIn(location="Yard"),
                        user=mgr, db=db)
            kit.refused(self, 404, items.create_checkout,
                        CheckoutIn(item_id="it-b", item_name="x", requested_by="Erin", requested_by_email=kit.EMP_A,
                                   raised_by="Erin", reason="Site"), user=U(kit.EMP_A), db=db)
            kit.refused(self, 404, items.update_item, "it-b", items.ItemUpdate(name="Mine now"), user=mgr, db=db)
        self.assertEqual(db.get(models.ItemCheckout, "co-b").status, "pending")

    def test_bulk_routes_skip_another_companys_items(self):
        mgr = U(kit.MGR_A)
        db = self.db
        with kit.walls():
            out = items.bulk_update_items(BulkUpdateRequest(ids=["it-a", "it-b"], fields={"location": "Yard"}),
                                          user=mgr, db=db)
            self.assertEqual(out["updated"], 1)
            items.bulk_assign_to_location(BulkAssignLocationIn(ids=["it-a", "it-b"], location="Dock"), user=mgr, db=db)
            out = items.bulk_assign_to_person(BulkAssignPersonIn(ids=["it-pa", "it-pb"], assignee_email=kit.EMP_A2),
                                              user=mgr, db=db)
            self.assertEqual(out["assigned"], 0)   # it-pa still has its live return; it-pb is not theirs
            out = items.bulk_delete_items(BulkDeleteRequest(ids=["it-b"]), user=mgr, db=db)
            self.assertEqual((out["deleted"], out["notFound"]), (0, ["it-b"]))
        db.expire_all()
        self.assertEqual(db.get(models.Item, "it-b").location, "")
        self.assertEqual(db.get(models.Item, "it-a").location, "Dock")

    def test_recycle_bin_restore_and_photos_stay_inside_the_wall(self):
        db = self.db
        for iid in ("it-a", "it-b"):
            db.get(models.Item, iid).deleted_at = "2026-10-20T10:00:00+00:00"
        db.commit()
        mgr = U(kit.MGR_A)
        with kit.walls():
            self.assertEqual({i["id"] for i in items.list_deleted_items(user=mgr, db=db)}, {"it-a"})
            kit.refused(self, 404, items.restore_item, "it-b", user=mgr, db=db)
            self.assertEqual(items.bulk_restore_items(RestoreRequest(ids=["it-a", "it-b"]), user=mgr, db=db),
                             {"restored": 1})
            items._SUPABASE_URL, items._SUPABASE_SERVICE_KEY = "https://x", "k"
            try:
                out = items.auto_fill_photos(AutoPhotoRequest(item_ids=["it-pb"]), user=mgr, db=db)
            finally:
                items._SUPABASE_URL, items._SUPABASE_SERVICE_KEY = "", ""
            self.assertEqual(out["results"][0]["status"], "not_found")

    def test_report_and_audit_log_stay_inside_the_wall(self):
        db = self.db
        db.add(models.AuditLog(timestamp="2026-10-02T10:00:00", user_email=kit.MGR_B, action="Updated item it-b",
                               resource_type="items", resource_id="it-b", details="{}"))
        db.add(models.AuditLog(timestamp="2026-10-02T10:00:01", user_email=kit.MGR_A, action="Updated item it-a",
                               resource_type="items", resource_id="it-a", details="{}"))
        db.add(models.AuditLog(timestamp="2026-10-02T10:00:02", user_email=kit.MGR_B, action="Edited multiple items",
                               resource_type="items", resource_id="", details="{}"))
        db.commit()
        with kit.walls():
            rows = items._report_rows(db, department=None, item_type=None, status=None,
                                      scope=items._scope(U(kit.MGR_A), db))
            self.assertEqual([r[0] for r in rows], ["Item it-a"])
            log = items.items_audit_log(user=U(kit.MGR_A), db=db)
            self.assertEqual([r["resource_id"] for r in log["rows"]], ["it-a"])
            self.assertEqual(log["total"], 1)
            everyone = items.items_audit_log(user=U(kit.OWNER), db=db)
            self.assertEqual(everyone["total"], 3)

    # ── Approvals: the same wall, so the nav counts agree ────────────────────
    def test_approvals_sources_and_counts_follow_the_wall(self):
        db = self.db
        kit.add_checkout(db, "co-bext", "it-b", "allocated", requester=kit.EMP_B, allocator=kit.MGR_B,
                         extension_status="pending", extension_days=2)
        with kit.walls():
            out = approvals_inbox.collect(db, U(kit.MGR_A))
            keys = {r["key"] for r in out["rows"] if r["group"] == "equipment"}
            self.assertEqual(keys, {"item_checkout:co-a", "assignment_return:as-a"})
            self.assertEqual(out["counts"].get("item_extension", 0), 0)
            out_b = approvals_inbox.collect(db, U(kit.MGR_B))
            keys_b = {r["key"] for r in out_b["rows"] if r["group"] == "equipment"}
            self.assertEqual(keys_b, {"item_checkout:co-b", "assignment_return:as-b", "item_extension:co-bext"})
        with kit.walls(False):
            out = approvals_inbox.collect(db, U(kit.MGR_A))
            self.assertEqual(out["counts"]["item_checkout"], 2)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
