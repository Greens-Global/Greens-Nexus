"""Items audit: Undo from the values recorded WITH the edit, and every step labeled (Nov 2026, H4).

  * Undo of an edit puts back the before-values audit_capture recorded for
    that very request (audit_changes, joined by request_id) - the `fields`
    a client sends are ignored, and so are the request bodies other audit
    rows copied (stale for bulk edits, imports, assign-location, clears);
  * an edit with no such record, or one a LATER change of the same field
    followed (whatever made it), is refused with a 409 - never a silent
    overwrite of the newer value;
  * the restored values pass the edit rules (storage-only photos, ownership
    that does not strand a live checkout, a serial nobody else uses -> 409);
  * a second Undo of the same entry is refused (the row is locked and marked
    undone); undoing an add or a delete needs the delete level (a Super
    Administrator or a Full Inventory grant), like DELETE / restore;
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
import audit_capture
import models
from routers import items
from routers.items import AuditUndoRequest, CheckoutStatusUpdate, ItemUpdate

U = kit.user
OLD_PHOTO = kit.STORAGE + "item-photos/old.jpg"
NEW_PHOTO = kit.STORAGE + "item-photos/new.jpg"


class AuditUndoTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        self.db.query(models.AuditChange).delete()
        self.db.commit()
        kit.add_item(self.db, "it-u", ownership="transient", photo_url=OLD_PHOTO, serial_number="GG-00001")
        self.n = 0

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _request(self, action, fn):
        """Run `fn` the way a request does (its own audit context, so the
        change capture records it) and write the request's audit row."""
        ctx, token = audit_capture.begin_request("/items/it-u", "PATCH")
        try:
            fn()
            self.db.commit()
        finally:
            audit_capture.end_request(token)
        self.n += 1
        row = models.AuditLog(timestamp=f"2026-10-01T10:00:{self.n:02d}", user_email=kit.MGR_A, user_role="",
                              action=action, resource_type="items", resource_id="it-u",
                              details=json.dumps({"path": "/items/it-u"}), ip_address="",
                              request_id=ctx.request_id)
        self.db.add(row)
        self.db.commit()
        return row.id

    def _edit(self, **fields):
        return self._request("Updated item it-u", lambda: items.update_item(
            "it-u", ItemUpdate(**fields), user=U(kit.MGR_A), db=self.db))

    def _undo(self, audit_id, fields=None, who=kit.MGR_A):
        return items.undo_audit_entry(AuditUndoRequest(audit_id=audit_id, fields=fields), user=U(who), db=self.db)

    def _item(self):
        self.db.expire_all()
        return self.db.get(models.Item, "it-u")

    def test_the_before_values_are_the_ones_recorded_with_the_edit(self):
        edit = self._edit(photo_url=NEW_PHOTO, make="Canon")
        self._undo(edit, fields={"photo_url": "https://evil.example/x.jpg", "op_status": "bogus",
                                 "ownership_type": "permanent"})
        item = self._item()
        self.assertEqual((item.photo_url, item.make or "", item.ownership_type, item.op_status or ""),
                         (OLD_PHOTO, "", "transient", ""))

    def test_an_edit_with_no_recorded_before_values_is_refused(self):
        self.db.add(models.AuditLog(id=900, timestamp="2026-09-01T10:00:00", user_email=kit.MGR_A,
                                    action="Updated item it-u", resource_type="items", resource_id="it-u",
                                    details=json.dumps({"make": "Nikon"}), request_id=""))
        self.db.commit()
        e = kit.refused(self, 409, self._undo, 900, fields={"make": "Nikon"})
        self.assertIn("no record", e.detail)

    def test_a_later_change_of_the_same_field_blocks_the_undo(self):
        first = self._edit(make="Canon")
        # A later change the audit rows could not thread (a bulk edit has no
        # item id there) - still recorded per item by the change capture.
        self._request("Edited multiple items", lambda: items.bulk_update_items(
            items.BulkUpdateRequest(ids=["it-u"], fields={"make": "Nikon"}), user=U(kit.MGR_A), db=self.db))
        e = kit.refused(self, 409, self._undo, first)
        self.assertIn("changed again", e.detail)
        self.assertEqual(self._item().make, "Nikon")
        # A later change of ANOTHER field does not block it.
        loc = self._edit(location="Yard")
        second = self._edit(model="EOS")
        self._undo(second)
        self.assertEqual(self._item().model or "", "")
        self._undo(loc)
        self.assertEqual(self._item().location or "", "")

    def test_restored_values_pass_the_edit_rules(self):
        # A legacy outside photo URL is not put back.
        item = self._item()
        item.photo_url = "https://elsewhere.example/p.jpg"
        self.db.commit()
        edit = self._edit(photo_url=NEW_PHOTO)
        kit.refused(self, 400, self._undo, edit)
        self.db.rollback()
        # Ownership is not flipped under a live checkout.
        flip = self._edit(ownership_type="permanent")
        kit.add_checkout(self.db, "co-1", "it-u", "pending")
        kit.refused(self, 409, self._undo, flip)

    def test_a_serial_someone_else_uses_is_a_409(self):
        def renumber():
            self.db.get(models.Item, "it-u").serial_number = "GG-00003"
        change = self._request("Updated item it-u", renumber)
        kit.add_item(self.db, "it-other", serial_number="GG-00001")
        e = kit.refused(self, 409, self._undo, change)
        self.assertIn("GG-00001", e.detail)

    def test_the_same_entry_is_undone_once(self):
        edit = self._edit(make="Nikon")
        self.assertEqual(self._undo(edit)["undone_id"], edit)
        e = kit.refused(self, 409, self._undo, edit)
        self.assertIn("already undone", e.detail)

    def test_undoing_an_add_or_a_delete_needs_the_delete_level(self):
        self.db.add(models.AuditLog(id=901, timestamp="2026-10-01T09:00:00", user_email=kit.MGR_A,
                                    action="Added item", resource_type="items", resource_id="it-u", details="{}"))
        self.db.commit()
        kit.refused(self, 403, self._undo, 901, who=kit.MGR_A)
        self.db.rollback()
        self._undo(901, who=kit.OWNER)
        self.assertTrue(self._item().deleted_at)


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
