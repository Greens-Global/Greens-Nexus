"""Closed notifications + 30-day retention (Neil, 10/01): clearing a bell
notification closes it for that person instead of deleting it, Restore
brings it back, the list carries 30 days of history, and the sweep removes
what is older.

    python -m unittest test_notifications_closed
"""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import database
import main
import models
import notification_retention
from routers.notifications import retention_cutoff

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    for _sql in ("ALTER TABLE nexus_notifications ADD COLUMN priority INTEGER DEFAULT 0",
                 "ALTER TABLE nexus_notifications ADD COLUMN closed_by VARCHAR DEFAULT ''"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

ME = "ncl.me@greensglobal.com"
OTHER = "ncl.other@greensglobal.com"


def _row(recipient, days_ago=0, **kw):
    when = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return models.NexusNotification(
        id=f"ncl-{uuid.uuid4()}", type=kw.get("type", "custom_alert"), recipient=recipient,
        title=kw.get("title", "Hello"), body="", ref_id="", item_name="", requested_by="",
        action="", actioned=False, read_by="", closed_by=kw.get("closed_by", ""),
        created_at=when.isoformat(), priority=kw.get("priority", 0))


class ClosedNotificationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ME
        self._cleanup()
        auth.invalidate_role_cache()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).filter(models.NexusNotification.id.like("ncl-%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _add(self, *rows):
        db = database.SessionLocal()
        try:
            for r in rows:
                db.add(r)
            db.commit()
            return [r.id for r in rows]
        finally:
            db.close()

    def _mine(self):
        r = self.client.get("/notifications")
        self.assertEqual(r.status_code, 200, r.text)
        return {n["id"]: n for n in r.json() if n["id"].startswith("ncl-")}

    def test_clear_closes_and_restore_brings_back(self):
        (nid,) = self._add(_row(ME, title="Sign your timecard", priority=1))
        self.assertFalse(self._mine()[nid]["closed"])
        # Clear = close, the row stays.
        r = self.client.delete(f"/notifications/{nid}")
        self.assertEqual(r.status_code, 200, r.text)
        mine = self._mine()
        self.assertIn(nid, mine, "a cleared notification is kept, not deleted")
        self.assertTrue(mine[nid]["closed"])
        self.assertEqual(mine[nid]["priority"], 1)
        # Restore.
        r = self.client.patch(f"/notifications/{nid}/restore")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self._mine()[nid]["closed"])

    def test_closing_is_per_person(self):
        # A broadcast to managers: one manager closing it must not close it for another.
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ME, role="manager", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        try:
            (nid,) = self._add(_row("", title="Order waiting"))
            self.client.delete(f"/notifications/{nid}")
            db = database.SessionLocal()
            try:
                row = db.query(models.NexusNotification).filter(models.NexusNotification.id == nid).first()
                self.assertEqual(row.closed_by, ME)
            finally:
                db.close()
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.NexusRole).filter(models.NexusRole.email == ME).delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()
            auth.invalidate_role_cache()

    def test_only_the_recipient_clears(self):
        (nid,) = self._add(_row(OTHER, title="Not mine"))
        r = self.client.delete(f"/notifications/{nid}")
        self.assertEqual(r.status_code, 403)
        r = self.client.patch(f"/notifications/{nid}/restore")
        self.assertEqual(r.status_code, 403)

    def test_thirty_days_of_history_then_the_sweep(self):
        fresh, old_closed, ancient = self._add(
            _row(ME, days_ago=1, title="Fresh"),
            _row(ME, days_ago=29, title="Old but kept", closed_by=ME),
            _row(ME, days_ago=31, title="Gone"),
        )
        mine = self._mine()
        self.assertIn(fresh, mine)
        self.assertIn(old_closed, mine)
        self.assertTrue(mine[old_closed]["closed"])
        self.assertNotIn(ancient, mine, "past 30 days is out of the list even before the sweep")
        self.assertLess(retention_cutoff(), datetime.now(timezone.utc).isoformat())
        # The sweep removes only what is past the window.
        removed = notification_retention.sweep_batch()
        self.assertGreaterEqual(removed, 1)
        db = database.SessionLocal()
        try:
            ids = {r.id for r in db.query(models.NexusNotification.id).filter(models.NexusNotification.id.like("ncl-%")).all()}
        finally:
            db.close()
        self.assertIn(fresh, ids)
        self.assertIn(old_closed, ids)
        self.assertNotIn(ancient, ids)


if __name__ == "__main__":
    unittest.main()
