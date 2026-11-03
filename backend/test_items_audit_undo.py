"""Items audit: Undo rebuilt on the server, and every step labeled (Nov 2026, H4).

  * Undo of an edit puts back the values the AUDIT LOG says the item had
    before - the `fields` a client sends are ignored, so Undo can no longer
    write an outside photo URL, an unknown status or a stranded ownership;
  * the rebuilt values pass the edit rules (storage-only photos, ownership
    that does not strand a live checkout, a serial nobody else uses -> 409);
  * a second Undo of the same entry is refused (the row is locked and
    marked undone);
  * assignment steps, extensions, reconcile, bulk assign, the cart and item
    types are labeled for what they are (they all read "Added item" before),
    and the steps whose path names a checkout or an assignment say which
    item on the response (X-Item-Id).

    python -m pytest test_items_audit_undo.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import json
import unittest

from fastapi import Response

import audit
import models
from routers import items
from routers.items import AuditUndoRequest, CheckoutStatusUpdate

U = kit.user
OLD_PHOTO = kit.STORAGE + "item-photos/old.jpg"
NEW_PHOTO = kit.STORAGE + "item-photos/new.jpg"


class AuditUndoTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        kit.add_item(self.db, "it-u", ownership="transient", photo_url=NEW_PHOTO, serial_number="GG-00001")
        self.n = 0

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _log(self, action, **fields):
        self.n += 1
        row = models.AuditLog(timestamp=f"2026-10-01T10:00:{self.n:02d}", user_email=kit.MGR_A, user_role="",
                              action=action, resource_type="items", resource_id="it-u",
                              details=json.dumps({"path": "/items/it-u", **fields}), ip_address="")
        self.db.add(row)
        self.db.commit()
        return row.id

    def _undo(self, audit_id, fields=None):
        return items.undo_audit_entry(AuditUndoRequest(audit_id=audit_id, fields=fields), user=U(kit.MGR_A), db=self.db)

    def test_the_previous_values_come_from_the_log_not_the_client(self):
        self._log("Added item", name="Cam", photo_url=OLD_PHOTO, ownership_type="transient")
        edit = self._log("Updated item it-u", photo_url=NEW_PHOTO)
        self._undo(edit, fields={"photo_url": "https://evil.example/x.jpg", "op_status": "bogus",
                                 "ownership_type": "permanent"})
        item = self.db.get(models.Item, "it-u")
        self.assertEqual((item.photo_url, item.ownership_type, item.op_status or ""), (OLD_PHOTO, "transient", ""))
        undo_row = self.db.query(models.AuditLog).filter(models.AuditLog.details.contains('"undo_of"')).one()
        self.assertEqual(json.loads(undo_row.details)["photo_url"], OLD_PHOTO)

    def test_a_change_with_no_earlier_record_has_nothing_to_restore(self):
        edit = self._log("Updated item it-u", make="Canon")
        e = kit.refused(self, 400, self._undo, edit, fields={"make": "Nikon"})
        self.assertIn("Nothing to restore", e.detail)

    def test_restored_values_pass_the_edit_rules(self):
        # An old entry recorded an outside photo URL: it is not put back.
        self._log("Added item", photo_url="https://elsewhere.example/p.jpg")
        edit = self._log("Updated item it-u", photo_url=NEW_PHOTO)
        kit.refused(self, 400, self._undo, edit)
        self.db.rollback()
        # Ownership is not flipped under a live checkout.
        self._log("Updated item it-u", ownership_type="permanent")
        flip = self._log("Updated item it-u", ownership_type="transient")
        kit.add_checkout(self.db, "co-1", "it-u", "allocated")
        kit.refused(self, 409, self._undo, flip)

    def test_a_serial_someone_else_uses_is_a_409(self):
        kit.add_item(self.db, "it-other", serial_number="GG-00002")
        self._log("Added item", serial_number="GG-00002")
        edit = self._log("Updated item it-u", serial_number="GG-00001")
        e = kit.refused(self, 409, self._undo, edit)
        self.assertIn("GG-00002", e.detail)

    def test_the_same_entry_is_undone_once(self):
        self._log("Added item", make="Canon")
        edit = self._log("Updated item it-u", make="Nikon")
        self.assertEqual(self._undo(edit)["undone_id"], edit)
        e = kit.refused(self, 409, self._undo, edit)
        self.assertIn("already undone", e.detail)


class AuditLabelTests(unittest.TestCase):
    def test_every_items_step_is_named(self):
        d = audit._describe
        self.assertEqual(d("POST", "/items/assignments/ASG-1/accept"), ("Accepted assignment ASG-1", ""))
        self.assertEqual(d("POST", "/items/assignments/ASG-1/initiate-return"), ("Started return of assignment ASG-1", ""))
        self.assertEqual(d("POST", "/items/assignments/ASG-1/accept-return"), ("Checked in return of assignment ASG-1", ""))
        self.assertEqual(d("POST", "/items/assignments/ASG-1/cancel"), ("Recovered assignment ASG-1", ""))
        self.assertEqual(d("POST", "/items/checkouts/ICHK-1/extension"), ("Asked for more days on checkout ICHK-1", "ICHK-1"))
        self.assertEqual(d("POST", "/items/checkouts/ICHK-1/extension/resolve"), ("Decided extension on checkout ICHK-1", "ICHK-1"))
        self.assertEqual(d("POST", "/items/it-9/reconcile-state"), ("Reconciled item state it-9", "it-9"))
        self.assertEqual(d("POST", "/items/bulk-assign")[0], "Assigned multiple items to a person")
        self.assertEqual(d("POST", "/items/bulk-assign-location")[0], "Moved multiple items to a location")
        self.assertEqual(d("POST", "/items/cart")[0], "Put item in cart")
        self.assertEqual(d("POST", "/items/types")[0], "New item type")
        # The real adds and edits keep their words (the Activity feed reads them).
        self.assertEqual(d("POST", "/items")[0], "Added item")
        self.assertEqual(d("PATCH", "/items/it-9"), ("Updated item it-9", "it-9"))
        for path in ("/items/assignments/ASG-1/accept", "/items/checkouts/ICHK-1/extension", "/items/cart",
                     "/items/bulk-assign", "/items/types", "/items/it-9/reconcile-state"):
            label = d("POST", path)[0].lower()
            self.assertFalse(any(w in label for w in ("added", "updated", "edited", "imported")), path)

    def test_checkout_and_assignment_steps_name_their_item(self):
        db = kit.fresh()
        try:
            kit.add_item(db, "it-h", status="available")
            kit.add_checkout(db, "co-h", "it-h", "approved")
            resp = Response()
            items.update_checkout("co-h", CheckoutStatusUpdate(status="pending_receipt"), user=U(kit.ALLOC_A),
                                  db=db, response=resp)
            self.assertEqual(resp.headers.get("x-item-id"), "it-h")
        finally:
            db.close()


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
