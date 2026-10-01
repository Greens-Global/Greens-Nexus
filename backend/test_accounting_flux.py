"""Accounting > Reports > Flux Analysis explanation notes (Neil, 10/02) - as
tests. A note is kept per entity set, account and period; the Accounting
grant reads, its editor level writes; a person limited to certain entities
touches notes for those only. The accounting service is a recorder.

    python -m pytest test_accounting_flux.py -q      (one file per process)
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.flux.test@greensglobal.com"      # accounting:viewer, no limit
EDITOR = "editor.flux.test@greensglobal.com"      # accounting:editor, no limit
LIMITED = "limited.flux.test@greensglobal.com"    # accounting:editor, entity 15000 only
GROUP_V = "grp-flux-test-viewer"
GROUP_E = "grp-flux-test-editor"
EVERYONE = (VIEWER, EDITOR, LIMITED)
ENTITIES = [
    {"code": "12000", "name": "Greens Global, Inc.", "parent_code": None},
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "15900", "name": "Escondido Annex", "parent_code": "15000"},
]
PERIOD = "2026-09-01_2026-09-30"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class FluxNoteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_V, name="Flux Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroup(id=GROUP_E, name="Flux Test Editors", allowed_modules="accounting:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=EDITOR))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=LIMITED))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

        async def fake_get(path, params):
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            return {"ok": True}
        self._get = accounting._acct_get
        accounting._acct_get = fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_V, GROUP_E))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_V, GROUP_E))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingFluxNote).filter(models.AccountingFluxNote.period == PERIOD).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_write_read_replace_and_remove(self):
        _as(EDITOR)
        r = self.client.put("/accounting/flux-notes", json={"entity": "15000", "period": PERIOD, "accountNo": "62101", "note": "  Roof repair at Escondido, one-time. "})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["accountNo"], r.json()["note"], r.json()["by"]), ("62101", "Roof repair at Escondido, one-time.", EDITOR))
        self.assertTrue(r.json()["at"].startswith("20"))
        # The same key again replaces, never a second row.
        self.client.put("/accounting/flux-notes", json={"entity": "15000", "period": PERIOD, "accountNo": "62101", "note": "Roof repair, insured."})
        _as(VIEWER)
        notes = self.client.get(f"/accounting/flux-notes?entity=15000&period={PERIOD}").json()["notes"]
        self.assertEqual([(n["accountNo"], n["note"]) for n in notes], [("62101", "Roof repair, insured.")])
        # Another period or entity set is its own page of notes; codes read in any order.
        self.assertEqual(self.client.get("/accounting/flux-notes?entity=15000&period=2026-08-01_2026-08-31").json()["notes"], [])
        _as(EDITOR)
        self.client.put("/accounting/flux-notes", json={"entity": "56000,15000", "period": PERIOD, "accountNo": "41000", "note": "New tenant."})
        self.assertEqual(self.client.get(f"/accounting/flux-notes?entity=15000,56000&period={PERIOD}").json()["entity"], "15000,56000")
        self.assertEqual(len(self.client.get(f"/accounting/flux-notes?entity=15000,56000&period={PERIOD}").json()["notes"]), 1)
        # An empty note removes the row.
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "15000", "period": PERIOD, "accountNo": "62101", "note": ""}).json()["note"], "")
        self.assertEqual(self.client.get(f"/accounting/flux-notes?entity=15000&period={PERIOD}").json()["notes"], [])

    def test_viewer_reads_only_and_bad_input_is_refused(self):
        _as(VIEWER)
        self.assertEqual(self.client.get(f"/accounting/flux-notes?period={PERIOD}").json(), {"entity": "all", "period": PERIOD, "notes": []})
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "all", "period": PERIOD, "accountNo": "62101", "note": "x"}).status_code, 403)
        _as(EDITOR)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"period": "September", "accountNo": "62101", "note": "x"}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"period": PERIOD, "accountNo": "", "note": "x"}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"period": PERIOD, "accountNo": "62101", "note": "x" * 2001}).status_code, 400)
        self.assertEqual(self.client.get("/accounting/flux-notes?entity=all&period=nope").status_code, 400)

    def test_limited_caller_stays_inside_their_entities(self):
        _as(LIMITED)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "15000", "period": PERIOD, "accountNo": "62101", "note": "Ours."}).status_code, 200)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "15900", "period": PERIOD, "accountNo": "62101", "note": "Child is ours too."}).status_code, 200)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "12000", "period": PERIOD, "accountNo": "62101", "note": "Not ours."}).status_code, 403)
        self.assertEqual(self.client.put("/accounting/flux-notes", json={"entity": "all", "period": PERIOD, "accountNo": "62101", "note": "Everyone."}).status_code, 403)
        self.assertEqual(self.client.get(f"/accounting/flux-notes?entity=12000&period={PERIOD}").status_code, 403)
        self.assertEqual(self.client.get(f"/accounting/flux-notes?period={PERIOD}").status_code, 403)
        self.assertEqual(len(self.client.get(f"/accounting/flux-notes?entity=15000&period={PERIOD}").json()["notes"]), 1)


if __name__ == "__main__":
    unittest.main()
