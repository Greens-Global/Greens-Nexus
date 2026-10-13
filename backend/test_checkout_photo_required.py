"""Checkout photos are evidence, and the server is what asks for them.

The screens already ask for a photo at the handover, the receipt and the
return; the endpoint only checked where a photo came from, so a request made
without one went through. These hold the rule on the server, and the ways out
of it that are deliberate: a photo-optional item (keys), a lost item, the
allocator's "employee takes the photo" handover, and a manager checking an
item back in for somebody who never opened the app.

Run with: python -m unittest test_checkout_photo_required -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers import items
from routers.items import CheckoutStatusUpdate, update_checkout


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

STORAGE = "https://nexus-test.supabase.co/storage/v1/object/public/"
PHOTO = STORAGE + "checkout-photos/co-1/1.jpg"
EMP = {"email": "erin@greensglobal.com", "level": 1}
ALLOCATOR = {"email": "alan@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}


class CheckoutPhotoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.ItemCheckout, models.Item, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        # Storage origin and the realtime ping are environment, not the rule.
        self._real = (items._STORAGE_PREFIX, items._fire_item_event)
        items._STORAGE_PREFIX = STORAGE
        items._fire_item_event = lambda *a, **k: None

    def tearDown(self):
        items._STORAGE_PREFIX, items._fire_item_event = self._real
        self.db.close()

    def _checkout(self, status, *, picture_required=True, **cols):
        self.db.add(models.Item(id="it-1", name="Laser Level", picture_required=picture_required,
                                status="available" if status in ("approved", "pending_receipt") else "checked_out"))
        self.db.add(models.ItemCheckout(
            id="co-1", item_id="it-1", item_name="Laser Level", requested_by="Erin Test",
            requested_by_email=EMP["email"], raised_by="Erin Test", status=status,
            assigned_allocator_email=ALLOCATOR["email"], created_at="2026-10-01T10:00:00", **cols))
        self.db.commit()

    def _patch(self, user, **body):
        return update_checkout("co-1", CheckoutStatusUpdate(**body), user=user, db=self.db)

    def _refused(self, user, message, **body):
        with self.assertRaises(HTTPException) as e:
            self._patch(user, **body)
        self.assertEqual((e.exception.status_code, e.exception.detail), (400, message))
        self.db.rollback()
        row = self.db.get(models.ItemCheckout, "co-1")
        self.db.refresh(row)
        return row

    # ── Handover ──────────────────────────────────────────────────────────────

    def test_a_direct_handover_needs_a_photo(self):
        self._checkout("approved")
        row = self._refused(ALLOCATOR, "A handover photo is required", status="allocated")
        self.assertEqual((row.status, row.handed_over_at or ""), ("approved", ""))
        self.assertEqual(self.db.get(models.Item, "it-1").status, "available")
        out = self._patch(ALLOCATOR, status="allocated", checkout_photo_url=PHOTO, checkout_photo_name="1.jpg")
        self.assertEqual((out["status"], out["checkoutPhotoUrl"]), ("allocated", PHOTO))

    def test_a_handover_photo_already_on_the_row_counts(self):
        self._checkout("approved", checkout_photo_url=PHOTO)
        self.assertEqual(self._patch(ALLOCATOR, status="allocated")["status"], "allocated")
        self.assertEqual(self.db.get(models.ItemCheckout, "co-1").checkout_photo_url, PHOTO)

    def test_employee_takes_the_photo_handover_asks_for_none_yet(self):
        # The allocator's other choice: hand it over now, the employee
        # photographs it when they confirm receipt.
        self._checkout("approved")
        self.assertEqual(self._patch(ALLOCATOR, status="pending_receipt")["status"], "pending_receipt")

    # ── Receipt ───────────────────────────────────────────────────────────────

    def test_confirming_receipt_needs_a_photo(self):
        self._checkout("pending_receipt")
        row = self._refused(EMP, "A receipt photo is required", status="allocated")
        self.assertEqual((row.status, row.allocated_at or ""), ("pending_receipt", ""))
        out = self._patch(EMP, status="allocated", receipt_photo_url=PHOTO)
        self.assertEqual((out["status"], out["receiptPhotoUrl"]), ("allocated", PHOTO))

    # ── Return ────────────────────────────────────────────────────────────────

    def test_a_return_needs_a_photo(self):
        self._checkout("allocated")
        row = self._refused(EMP, "A return photo is required (unless the item is lost)",
                            status="returned", condition="damaged", condition_note="Cracked housing")
        self.assertEqual((row.status, row.returned_at or ""), ("allocated", ""))
        self.assertEqual(self.db.get(models.Item, "it-1").status, "checked_out")
        self.assertEqual(self._patch(EMP, status="returned", return_photo_url=PHOTO)["status"], "returned")

    def test_a_blank_url_is_not_a_photo(self):
        self._checkout("allocated")
        self._refused(EMP, "A return photo is required (unless the item is lost)",
                      status="returned", return_photo_url="   ")

    def test_a_lost_item_is_returned_without_one(self):
        self._checkout("allocated")
        self.assertEqual(self._patch(EMP, status="returned", condition="lost")["status"], "returned")
        self.assertEqual(self.db.get(models.Item, "it-1").op_status, "lost")

    def test_a_manager_checks_it_in_for_the_holder_with_a_reason(self):
        self._checkout("allocated")
        self._refused(BOSS, "A return photo is required (unless the item is lost)", status="returned")
        out = self._patch(BOSS, status="returned", condition_note="Force-returned by Neil - left on site")
        self.assertEqual(out["status"], "returned")

    def test_the_holder_cannot_use_the_reason_instead_of_a_photo(self):
        self._checkout("allocated")
        self._refused(EMP, "A return photo is required (unless the item is lost)",
                      status="returned", condition_note="Force-returned by Erin - no camera")

    # ── Photo-optional items and the origin check ─────────────────────────────

    def test_a_photo_optional_item_needs_none_at_any_step(self):
        self._checkout("approved", picture_required=False)
        self.assertEqual(self._patch(ALLOCATOR, status="allocated")["status"], "allocated")
        self.assertEqual(self._patch(EMP, status="returned")["status"], "returned")

    def test_a_photo_optional_receipt_needs_none(self):
        self._checkout("pending_receipt", picture_required=False)
        self.assertEqual(self._patch(EMP, status="allocated")["status"], "allocated")

    def test_a_photo_from_somewhere_else_is_still_refused(self):
        self._checkout("approved")
        self._refused(ALLOCATOR, "checkout_photo_url must be a Supabase storage URL",
                      status="allocated", checkout_photo_url="https://example.com/fake.jpg")


if __name__ == "__main__":
    unittest.main()
