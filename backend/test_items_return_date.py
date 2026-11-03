"""Borrow asks for a return DATE (Neil, 11/02/2026 - item_due's rule).

  * a request carries the date picked on the calendar; `days` is that date
    minus the borrower's today, and the date is capped by the item type's
    longest loan (0 = the 90-day ceiling);
  * the due date is the date picked when the item changes hands on or before
    the day of the request, else the same loan length counted from the
    handover;
  * an extension picks a new date: the extra days are the new date minus the
    current due date, and approving it moves the picked date with it.

    python -m pytest test_items_return_date.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest
from datetime import date
from unittest import mock

import item_due
import models
from routers import items
from routers.items import CheckoutIn, ExtensionRequest, ExtensionResolve

U = kit.user
TODAY = date(2026, 11, 2)


def _request(iid, **kw):
    return CheckoutIn(item_id=iid, item_name="x", requested_by="Evan", requested_by_email=kit.EMP_A2,
                      raised_by="Evan", reason="Site visit", **kw)


class ReturnDateTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        self.db.query(models.ItemType).delete()
        self.db.commit()
        self.today = mock.patch.object(item_due, "local_today", return_value=TODAY)
        self.today.start()

    def tearDown(self):
        self.today.stop()
        self.db.rollback()
        self.db.close()

    def _type(self, name="Tools", **cols):
        self.db.add(models.ItemType(name=name, sort_order=0, **cols))
        self.db.commit()

    def test_the_picked_date_sets_the_loan_length_and_is_stored(self):
        kit.add_item(self.db, "it-1", item_type="Tools")
        out = items.create_checkout(_request("it-1", due_date="2026-11-09"), user=U(kit.EMP_A2), db=self.db)
        self.assertEqual(out["days"], 7)
        self.assertEqual(out["requestedDueDate"], "2026-11-09")
        self.assertEqual(self.db.get(models.ItemCheckout, out["id"]).requested_due_date, "2026-11-09")

    def test_today_or_a_past_date_is_refused(self):
        kit.add_item(self.db, "it-2", item_type="Tools")
        e = kit.refused(self, 400, items.create_checkout, _request("it-2", due_date="2026-11-02"),
                        user=U(kit.EMP_A2), db=self.db)
        self.assertIn("after today", e.detail)

    def test_the_type_caps_the_date(self):
        self._type("Tools", max_loan_days=5)
        kit.add_item(self.db, "it-3", item_type="Tools")
        e = kit.refused(self, 400, items.create_checkout, _request("it-3", due_date="2026-11-09"),
                        user=U(kit.EMP_A2), db=self.db)
        self.assertIn("up to 5 days", e.detail)
        self.assertIn("11/07/2026", e.detail)               # US format, the last date allowed
        self.db.rollback()
        ok = items.create_checkout(_request("it-3", due_date="2026-11-07"), user=U(kit.EMP_A2), db=self.db)
        self.assertEqual(ok["days"], 5)

    def test_no_type_cap_is_the_90_day_ceiling_and_a_days_request_is_capped_too(self):
        kit.add_item(self.db, "it-4", item_type="Tools")
        kit.refused(self, 400, items.create_checkout, _request("it-4", due_date="2027-02-01"),
                    user=U(kit.EMP_A2), db=self.db)
        self.db.rollback()
        self._type("Tools", max_loan_days=3)
        kit.refused(self, 400, items.create_checkout, _request("it-4", days=4), user=U(kit.EMP_A2), db=self.db)

    def test_a_handover_on_the_day_of_the_request_is_due_on_the_picked_date(self):
        kit.add_item(self.db, "it-5", status="checked_out")
        kit.add_checkout(self.db, "co-5", "it-5", "allocated", requester=kit.EMP_A2, days=7,
                         created_at="2026-11-02T17:00:00+00:00", handed_over_at="2026-11-02T22:00:00+00:00",
                         requested_due_date="2026-11-09")
        co = self.db.get(models.ItemCheckout, "co-5")
        self.assertEqual(item_due.due_date(co, "America/Los_Angeles"), date(2026, 11, 9))

    def test_a_late_handover_keeps_the_loan_length_from_the_handover(self):
        # Asked on 11/02 for 11/09 (7 days); handed over 11/05 -> due 11/12.
        kit.add_item(self.db, "it-6", status="checked_out")
        kit.add_checkout(self.db, "co-6", "it-6", "allocated", requester=kit.EMP_A2, days=7,
                         created_at="2026-11-02T17:00:00+00:00", handed_over_at="2026-11-05T17:00:00+00:00",
                         requested_due_date="2026-11-09")
        co = self.db.get(models.ItemCheckout, "co-6")
        self.assertEqual(item_due.due_date(co, "America/Los_Angeles"), date(2026, 11, 12))
        payload = next(c for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db) if c["id"] == "co-6")
        self.assertEqual(payload["dueDate"], "2026-11-12")

    def test_an_extension_picks_a_new_date_and_approval_moves_the_picked_date(self):
        kit.add_item(self.db, "it-7", status="checked_out")
        kit.add_checkout(self.db, "co-7", "it-7", "allocated", requester=kit.EMP_A2, days=7,
                         created_at="2026-11-02T17:00:00+00:00", handed_over_at="2026-11-02T18:00:00+00:00",
                         requested_due_date="2026-11-09")
        e = kit.refused(self, 400, items.request_extension, "co-7",
                        ExtensionRequest(new_due_date="2026-11-09", reason="More work"), user=U(kit.EMP_A2), db=self.db)
        self.assertIn("11/09/2026", e.detail)
        self.db.rollback()
        out = items.request_extension("co-7", ExtensionRequest(new_due_date="2026-11-13", reason="More work"),
                                      user=U(kit.EMP_A2), db=self.db)
        self.assertEqual(out["extensionDays"], 4)
        done = items.resolve_extension("co-7", ExtensionResolve(action="approve"), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(done["days"], 11)
        self.assertEqual(done["requestedDueDate"], "2026-11-13")
        self.assertEqual(done["dueDate"], "2026-11-13")

    def test_an_extension_must_land_after_the_borrowers_today(self):
        # Overdue since 10/30: a new date of 11/01 is after the due date but already past.
        kit.add_item(self.db, "it-9", status="checked_out")
        kit.add_checkout(self.db, "co-9", "it-9", "allocated", requester=kit.EMP_A2, days=3,
                         created_at="2026-10-27T17:00:00+00:00", handed_over_at="2026-10-27T18:00:00+00:00")
        e = kit.refused(self, 400, items.request_extension, "co-9", ExtensionRequest(new_due_date="2026-11-01", reason="x"),
                        user=U(kit.EMP_A2), db=self.db)
        self.assertIn("after today", e.detail)

    def test_a_loan_at_the_ceiling_says_how_to_go_on(self):
        kit.add_item(self.db, "it-10", status="checked_out")
        kit.add_checkout(self.db, "co-10", "it-10", "allocated", requester=kit.EMP_A2, days=90,
                         handed_over_at="2026-10-01T18:00:00+00:00")
        e = kit.refused(self, 400, items.request_extension, "co-10", ExtensionRequest(days=1, reason="x"),
                        user=U(kit.EMP_A2), db=self.db)
        self.assertIn("already at the 90-day limit - ask an items manager to return and re-lend it", e.detail)

    def test_the_borrow_window_is_the_borrowers_own(self):
        self._type("Tools", max_loan_days=5)
        kit.add_item(self.db, "it-11", item_type="Tools")
        out = items.borrow_window(item_ids="it-11", for_email=kit.EMP_A, user=U(kit.EMP_A2), db=self.db)
        self.assertEqual(out["today"], "2026-11-02")
        self.assertEqual(out["items"]["it-11"], {"first": "2026-11-03", "last": "2026-11-07", "capDays": 5, "available": True})
        self.assertEqual(out["for"], kit.EMP_A)

    def test_the_payload_says_overdue_in_the_borrowers_zone(self):
        kit.add_item(self.db, "it-12", status="checked_out")
        kit.add_checkout(self.db, "co-12", "it-12", "allocated", requester=kit.EMP_A2, days=2,
                         created_at="2026-10-27T17:00:00+00:00", handed_over_at="2026-10-27T18:00:00+00:00")
        row = next(c for c in items.list_checkouts(user=U(kit.MGR_A), db=self.db) if c["id"] == "co-12")
        self.assertEqual((row["overdue"], row["dueToday"], row["borrowerToday"]), (True, False, "2026-11-02"))

    def test_an_extension_past_the_ceiling_is_refused(self):
        kit.add_item(self.db, "it-8", status="checked_out")
        kit.add_checkout(self.db, "co-8", "it-8", "allocated", requester=kit.EMP_A2, days=88,
                         handed_over_at="2026-10-01T18:00:00+00:00")
        kit.refused(self, 400, items.request_extension, "co-8", ExtensionRequest(days=5, reason="More work"),
                    user=U(kit.EMP_A2), db=self.db)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
