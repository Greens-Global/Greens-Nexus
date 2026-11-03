"""Borrowable types, Add Item's serial and the Activity Log's date range
(Items redesign, Neil 11/02/2026).

  * every item type has a Borrowable switch: by default on for a type people
    check out (it has temporary items, or none yet) and off for a
    permanent-only type - counted over EVERY company, since the type list is
    shared; only a Super Administrator changes it (review 11/02/2026), Use
    the Default puts the rule back, and a checkout of a type switched off is
    refused - except for an items manager;
  * a type name may hold "/" and "Tool" finds "Tools";
  * a type's longest loan is 0 (no cap) to 90 days;
  * Add Item takes the unit's own serial (free, or a 409), blank = GG-#####;
  * GET /items/audit-log filters by a start / end instant on the server.

    python -m pytest test_items_borrowable.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import CheckoutIn, ItemCreate, ItemTypeSettingsIn

U = kit.user


def _settings(db, name, who=kit.MGR_A):
    return next(t for t in items.list_item_type_settings(user=U(who), db=db) if t["name"] == name)


class _Resp:
    headers: dict = {}


class BorrowableTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        self.db.query(models.ItemType).delete()
        for i, n in enumerate(("Tools", "Computer", "Keys")):
            self.db.add(models.ItemType(name=n, sort_order=i))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_the_default_follows_what_the_type_holds(self):
        kit.add_item(self.db, "t1", item_type="Tools")
        kit.add_item(self.db, "c1", item_type="Computer", ownership="permanent")
        self.assertTrue(_settings(self.db, "Tools")["borrowable"])
        self.assertFalse(_settings(self.db, "Computer")["borrowable"])     # permanent-only
        self.assertTrue(_settings(self.db, "Keys")["borrowable"])          # no items yet
        self.assertIsNone(_settings(self.db, "Computer")["borrowableSet"])
        self.assertEqual(_settings(self.db, "Tools")["loanCapDays"], 90)

    def test_an_admins_switch_wins_and_use_default_puts_the_rule_back(self):
        kit.add_item(self.db, "t2", item_type="Tools")
        items.update_item_type_settings("tools", ItemTypeSettingsIn(borrowable=False, max_loan_days=14),
                                        user=U(kit.OWNER), db=self.db)
        row = _settings(self.db, "Tools")
        self.assertEqual((row["borrowable"], row["borrowableSet"], row["maxLoanDays"], row["loanCapDays"]),
                         (False, False, 14, 14))
        e = kit.refused(self, 400, items.create_checkout,
                        CheckoutIn(item_id="t2", item_name="x", requested_by="Evan", requested_by_email=kit.EMP_A2,
                                   raised_by="Evan", reason="Site visit"),
                        user=U(kit.EMP_A2), db=self.db)
        self.assertIn("not borrowable", e.detail)
        self.db.rollback()
        # An items manager may still check one out, for themselves or a crew member.
        ok = items.create_checkout(CheckoutIn(item_id="t2", item_name="x", requested_by="Evan", requested_by_email=kit.EMP_A2,
                                              raised_by="Mia", reason="Crew job"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(ok["status"], "pending")
        items.update_item_type_settings("Tools", ItemTypeSettingsIn(use_default=True), user=U(kit.OWNER), db=self.db)
        self.assertTrue(_settings(self.db, "Tools")["borrowable"])

    def test_only_a_super_administrator_changes_it_and_the_loan_is_bounded(self):
        e = kit.refused(self, 403, items.update_item_type_settings, "Tools", ItemTypeSettingsIn(borrowable=False),
                        user=U(kit.MGR_A), db=self.db)
        self.assertEqual(e.detail, "Only a Super Administrator can change this.")
        self.assertFalse(_settings(self.db, "Tools", kit.MGR_A)["canEdit"])
        self.assertTrue(_settings(self.db, "Tools", kit.OWNER)["canEdit"])
        kit.refused(self, 400, items.update_item_type_settings, "Tools", ItemTypeSettingsIn(max_loan_days=91),
                    user=U(kit.OWNER), db=self.db)
        kit.refused(self, 404, items.update_item_type_settings, "Nope", ItemTypeSettingsIn(borrowable=True),
                    user=U(kit.OWNER), db=self.db)

    def test_the_default_reads_every_company_but_counts_show_only_your_own(self):
        kit.add_item(self.db, "t3", kit.COB, item_type="Keys")
        kit.add_item(self.db, "p3", kit.COA, item_type="Keys", ownership="permanent")
        with kit.walls():
            a = _settings(self.db, "Keys", kit.MGR_A)
            # Company A holds only a permanent key, but B lends keys: borrowable for all.
            self.assertTrue(a["borrowable"])
            self.assertEqual((a["temporaryCount"], a["permanentCount"]), (0, 1))
            self.assertEqual(_settings(self.db, "Keys", kit.MGR_B)["temporaryCount"], 1)

    def test_names_with_a_slash_and_plural_folding(self):
        self.db.add(models.ItemType(name="Radios/Phones", sort_order=9))
        self.db.commit()
        items.update_item_type_settings("Radios/Phones", ItemTypeSettingsIn(max_loan_days=3), user=U(kit.OWNER), db=self.db)
        self.assertEqual(_settings(self.db, "Radios/Phones")["maxLoanDays"], 3)
        self.assertEqual(items._type_row(self.db, "tool").name, "Tools")
        self.assertEqual(items._loan_cap(self.db, "Radios/Phones"), 3)
        paths = {getattr(rt, "path", "") for rt in items.router.routes}
        self.assertIn("/items/types/{name:path}", paths)


class SerialAndAuditTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_add_item_keeps_a_typed_serial_and_refuses_a_taken_one(self):
        out = items.create_item(ItemCreate(name="Drill", serial_number=" SN-77 "), _Resp(), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["serialNumber"], "SN-77")
        e = kit.refused(self, 409, items.create_item, ItemCreate(name="Drill 2", serial_number="sn-77"), _Resp(),
                        user=U(kit.MGR_A), db=self.db)
        self.assertIn("already used", e.detail)
        self.db.rollback()
        auto = items.create_item(ItemCreate(name="Saw"), _Resp(), user=U(kit.MGR_A), db=self.db)
        self.assertTrue(auto["serialNumber"].startswith("GG-"))

    def test_the_activity_log_date_range_runs_on_the_server(self):
        kit.add_item(self.db, "it-1")
        for i, ts in enumerate(("2026-10-30T23:00:00+00:00", "2026-11-01T08:00:00+00:00", "2026-11-02T07:59:00+00:00")):
            self.db.add(models.AuditLog(timestamp=ts, user_email=kit.MGR_A, action=f"Item Updated {i}",
                                        resource_type="items", resource_id="it-1", details="{}"))
        self.db.commit()
        # 11/01 in California: 07:00 UTC on 11/01 to 07:00 UTC on 11/02.
        out = items.items_audit_log(start="2026-11-01T00:00:00-07:00", end="2026-11-02T00:00:00-07:00",
                                    user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["rows"][0]["action"], "Item Updated 1")
        kit.refused(self, 400, items.items_audit_log, start="yesterday", user=U(kit.MGR_A), db=self.db)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
