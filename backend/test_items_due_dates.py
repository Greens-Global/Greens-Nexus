"""One clock for checkout due dates (Nov 2026, M3 - item_due.py).

  * the clock starts at the HANDOVER (handed_over_at), not at the receipt
    confirmation (allocated_at) that can come days later - before, two of
    the four readers started at allocated_at;
  * the due DATE is read in the borrower's own zone (their Shift preset's,
    else their company's team zone), not as a UTC date: an item handed over
    at 7 PM in California is not "due a day late";
  * the catalog, the checkout payload, the overdue reminders and the
    Workflows pack all read the same helper.

    python -m pytest test_items_due_dates.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest
from datetime import date, datetime, timezone
from unittest import mock

import equipment_reminders
import item_due
import models
import routers.shift_requests  # noqa: F401 - loaded, as in the app: item_due may read Shifts settings
import shift_expect
from routers import items

U = kit.user
# 7 PM in California on 11/01 is 02:00 UTC on 11/02 (and 7:30 AM 11/02 in India).
EVENING_LA = "2026-11-02T02:00:00+00:00"


class DueDateTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _co(self, **cols):
        kit.add_item(self.db, "it-1", status="checked_out")
        kit.add_checkout(self.db, "co-1", "it-1", "allocated", days=3, **cols)
        return self.db.get(models.ItemCheckout, "co-1")

    def test_the_clock_starts_at_the_handover_not_the_receipt(self):
        co = self._co(handed_over_at="2026-10-01T15:00:00+00:00", allocated_at="2026-10-03T15:00:00+00:00")
        self.assertEqual(item_due.due_at(co), datetime(2026, 10, 4, 15, 0, tzinfo=timezone.utc))
        self.assertEqual(equipment_reminders.checkout_due_date(co, "America/Los_Angeles"), date(2026, 10, 4))

    def test_the_due_date_is_the_borrowers_local_date(self):
        co = self._co(handed_over_at=EVENING_LA, allocated_at=EVENING_LA)
        self.assertEqual(item_due.due_date(co, "America/Los_Angeles"), date(2026, 11, 4))
        self.assertEqual(item_due.due_date(co, "Asia/Kolkata"), date(2026, 11, 5))
        # A UTC date would have said 11/05 for the California borrower too.
        self.assertEqual(item_due.due_at(co).date(), date(2026, 11, 5))

    def test_the_zone_is_the_shift_presets_then_the_companys(self):
        self.assertEqual(item_due.zone_for(self.db, kit.EMP_A), shift_expect.team_tz(self.db, kit.COA))
        with mock.patch.object(shift_expect, "team_tz", side_effect=lambda _db, c="": "Asia/Kolkata" if c == kit.COB else "America/Los_Angeles"):
            self.assertEqual(item_due.zone_for(self.db, kit.EMP_B), "Asia/Kolkata")
        self.db.add(models.Shift(id="sh-ist", name="IST", timezone="Asia/Kolkata"))
        self.db.add(models.ShiftAssignment(id="sa-1", employee_email=kit.EMP_A, shift_id="sh-ist"))
        self.db.commit()
        self.assertEqual(item_due.zone_for(self.db, kit.EMP_A), "Asia/Kolkata")

    def test_the_catalog_and_the_payload_read_the_same_clock(self):
        self._co(handed_over_at=EVENING_LA, allocated_at="2026-11-03T10:00:00+00:00")
        row = next(i for i in items.list_items(user=U(kit.MGR_A), db=self.db) if i["id"] == "it-1")
        self.assertEqual(row["activeDueDate"], "2026-11-05T02:00:00+00:00")
        self.assertEqual(row["activeDueDay"], "2026-11-04")              # the borrower's California date
        co = next(c for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db) if c["id"] == "co-1")
        self.assertEqual((co["dueAt"], co["dueDate"]), ("2026-11-05T02:00:00+00:00", "2026-11-04"))

    def test_no_due_date_before_the_handover(self):
        kit.add_item(self.db, "it-2")
        kit.add_checkout(self.db, "co-2", "it-2", "approved")
        co = next(c for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db) if c["id"] == "co-2")
        self.assertEqual((co["dueAt"], co["dueDate"]), ("", ""))

    def test_overdue_days_count_in_the_borrowers_zone(self):
        self._co(handed_over_at=EVENING_LA, allocated_at=EVENING_LA)
        # 11/04 in California (the due date) while it is already 11/05 in UTC.
        with mock.patch.object(equipment_reminders, "_today", return_value=date(2026, 11, 4)):
            cfg = {"overdue": {"enabled": True, "onDueDate": True, "everyDays": 1, "maxReminders": 3,
                               "notifyOwnerAfterDays": 99}}
            sent = equipment_reminders.run_overdue_checkouts(self.db, cfg)
        self.assertEqual(sent, 1)
        self.db.flush()
        note = kit.bells(self.db, "checkout_overdue", "co-1")[0]
        self.assertTrue(note.title.startswith("Due Today"), note.title)
        self.assertIn("11/04/2026", note.body)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
