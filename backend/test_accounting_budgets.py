"""Accounting > Budget proxy (contract B1/B2, Oct 2): the entity limit is
enforced on every read and write, one entity travels as `location`, the
save carries the editor, and a 404 from the accounting app (route not
shipped yet) is passed on as 501. The accounting service is a recorder.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_budgets.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_budgets  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.budget.test@greensglobal.com"     # accounting:editor, no limit
LIMITED = "limited.budget.test@greensglobal.com"   # accounting:editor, entity 15000 only
VIEWER = "viewer.budget.test@greensglobal.com"     # accounting:viewer - reads, cannot save
GROUP_E, GROUP_V = "grp-budget-test-editor", "grp-budget-test-viewer"
EVERYONE = (EDITOR, LIMITED, VIEWER)
ENTITIES = [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "15900", "name": "Annex", "parent_code": "15000"}, {"code": "90000", "name": "Family Trust", "parent_code": None}]
UPSTREAM = {"ok": True, "location": "15000", "year": 2026, "source": "nexus", "updated_at": "2026-10-01T10:00:00Z", "updated_by": "charmi@greensglobal.com",
            "rows": [{"account_no": "61101", "title": "Professional Fees", "months": [1, 2, 3]}]}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class BudgetProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_E, name="Budget Test Editors", allowed_modules="accounting:editor"))
            db.add(models.NexusGroup(id=GROUP_V, name="Budget Test Viewers", allowed_modules="accounting:viewer"))
            for em in (EDITOR, LIMITED):
                db.add(models.NexusGroupMember(group_id=GROUP_E, email=em))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusAccessScope(id="scope-budget-test", email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.gets, self.puts = [], []

        async def fake_get(params):
            self.gets.append(params)
            return dict(UPSTREAM)

        async def fake_put(payload):
            self.puts.append(payload)
            return dict(UPSTREAM, rows=[{"accountNo": r["accountNo"], "title": "", "months": r["months"]} for r in payload["rows"]])

        async def fake_acct(path, params):
            return {"ok": True, "entities": ENTITIES}
        self._get, accounting_budgets._get = accounting_budgets._get, fake_get
        self._put, accounting_budgets._put = accounting_budgets._put, fake_put
        self._acct, accounting._acct_get = accounting._acct_get, fake_acct

    def tearDown(self):
        accounting_budgets._get, accounting_budgets._put = self._get, self._put
        accounting._acct_get = self._acct
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_E, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_E, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_read_shapes_the_rows_and_passes_the_entity(self):
        _as(EDITOR)
        r = self.client.get("/accounting/budgets?location=90000&year=2026")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.gets[-1], {"location": "90000", "year": 2026})
        out = r.json()
        self.assertEqual(out["updatedBy"], "charmi@greensglobal.com")
        self.assertEqual(out["rows"], [{"accountNo": "61101", "title": "Professional Fees", "months": [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]}])
        self.client.get("/accounting/budgets?location=90000&year=2026&source=intacct")
        self.assertEqual(self.gets[-1], {"location": "90000", "year": 2026, "source": "intacct"})
        self.assertEqual(self.client.get("/accounting/budgets?year=2026").status_code, 422)
        self.assertEqual(self.client.get("/accounting/budgets?location=90000&year=1999").status_code, 400)

    def test_limited_caller_reads_only_their_entities(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/budgets?location=15000&year=2026").status_code, 200)
        self.assertEqual(self.client.get("/accounting/budgets?location=15900&year=2026").status_code, 200, "a child entity comes with its parent")
        self.assertEqual(self.client.get("/accounting/budgets?location=90000&year=2026").status_code, 403)
        self.assertEqual(self.client.put("/accounting/budgets", json={"location": "90000", "year": 2026, "rows": []}).status_code, 403)
        self.assertEqual([g["location"] for g in self.gets], ["15000", "15900"], "nothing outside the limit reaches the accounting service")
        self.assertEqual(self.puts, [])

    def test_save_carries_the_editor_and_twelve_months(self):
        _as(EDITOR)
        r = self.client.put("/accounting/budgets", json={"location": "15000", "year": 2026, "rows": [{"accountNo": "61101", "months": [100, 200.555]}, {"accountNo": " ", "months": []}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.puts[-1], {"location": "15000", "year": 2026, "by": EDITOR, "rows": [{"accountNo": "61101", "months": [100.0, 200.56, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}]})
        self.assertEqual(r.json()["rows"][0]["months"][1], 200.56)
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/budgets?location=15000&year=2026").status_code, 200)
        self.assertEqual(self.client.put("/accounting/budgets", json={"location": "15000", "year": 2026, "rows": []}).status_code, 403, "a viewer reads but cannot save")

    def test_not_available_until_the_accounting_app_ships_it(self):
        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_budgets._NOT_READY)
        accounting_budgets._get = missing
        _as(EDITOR)
        r = self.client.get("/accounting/budgets?location=15000&year=2026")
        self.assertEqual(r.status_code, 501)
        self.assertEqual(r.json()["detail"], "Not available yet - the accounting app needs its update.")

    def test_upstream_404_maps_to_501(self):
        class R:
            status_code = 404

            def json(self):
                return {"ok": False, "error": "Not found"}
        with self.assertRaises(HTTPException) as cm:
            accounting_budgets._answer(R())
        self.assertEqual(cm.exception.status_code, 501)


if __name__ == "__main__":
    unittest.main()
