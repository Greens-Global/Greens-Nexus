"""The asset workspace save (PUT /property-assets/workspace), one file per
process like every backend test: the stale guard, the wipe guard, the
activity-log cap. Run: .venv/bin/python -m pytest test_property_assets.py"""
import os
import tempfile
import unittest

from fastapi import HTTPException

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database                                       # noqa: E402
import models                                         # noqa: E402
from routers import property_assets as PA             # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}


def ws(props, logs=None, base_ts=None):
    return PA.Workspace(properties=props, logs=logs or [], baseTs=base_ts)


class WorkspaceSaveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _save(self, props, **kw):
        return PA.put_workspace(ws(props, **kw), db=self.db, user=ADMIN)

    def test_first_save_lands_and_stamps_a_server_ts(self):
        out = self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}])
        self.assertEqual(out["properties"], 2)
        self.assertGreater(out["_ts"], 0)
        self.assertEqual(PA.get_workspace(db=self.db, user=ADMIN)["_ts"], out["_ts"])

    def test_a_stale_copy_is_refused(self):
        first = self._save([{"id": "a", "name": "A"}])["_ts"]
        with self.assertRaises(HTTPException) as cm:
            self._save([{"id": "a", "name": "A (old tab)"}], base_ts=first - 1)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn("stale", cm.exception.detail)
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A")

    def test_a_copy_without_a_base_ts_is_stale_too(self):
        """Every client sends baseTs now; one that does not predates the guard and
        must pull before it may replace a populated portfolio."""
        self._save([{"id": "a", "name": "A"}])
        with self.assertRaises(HTTPException) as cm:
            self._save([{"id": "a", "name": "A (legacy)"}], base_ts=None)
        self.assertEqual(cm.exception.status_code, 409)

    def test_a_current_copy_saves(self):
        first = self._save([{"id": "a", "name": "A"}])["_ts"]
        out = self._save([{"id": "a", "name": "A2"}], base_ts=first)
        self.assertGreaterEqual(out["_ts"], first)
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A2")

    def test_an_empty_copy_never_wipes_a_portfolio(self):
        first = self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}])["_ts"]
        with self.assertRaises(HTTPException) as cm:
            self._save([], base_ts=first)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(self.db.query(models.PropertyAsset).count(), 2)

    def test_the_activity_log_is_capped_per_asset_newest_first(self):
        logs = [{"id": f"l{i}", "propertyId": "a", "ts": f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z", "action": "edited"} for i in range(PA.LOG_CAP_PER_ASSET + 40)]
        logs += [{"id": "other", "propertyId": "b", "ts": "2025-01-01T00:00:00Z", "action": "added"}]
        self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], logs=logs)
        kept = self.db.query(models.PropertyActivityLog).filter(models.PropertyActivityLog.property_id == "a").all()
        self.assertEqual(len(kept), PA.LOG_CAP_PER_ASSET)
        ids = {r.id for r in kept}
        self.assertIn(f"l{PA.LOG_CAP_PER_ASSET + 39}", ids)     # the newest stays
        self.assertNotIn("l0", ids)                               # the oldest goes
        self.assertEqual(self.db.query(models.PropertyActivityLog).filter(models.PropertyActivityLog.property_id == "b").count(), 1)


if __name__ == "__main__":
    unittest.main()
