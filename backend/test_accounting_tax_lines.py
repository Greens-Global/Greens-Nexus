"""Accounting > Reports > Schedule C (draft): the account-to-line mapping
(10/27 triage item 18) - as tests. A row says which Schedule C line one GL
account adds into, for one entity or every entity; the Accounting grant
reads, its editor level writes; a limited person writes their own entities
only. Kept in Nexus - the accounting service is a recorder and is never
written to.

    python -m pytest test_accounting_tax_lines.py -q      (one file per process)
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

VIEWER = "viewer.taxline.test@greensglobal.com"      # accounting:viewer, no limit
EDITOR = "editor.taxline.test@greensglobal.com"      # accounting:editor, no limit
LIMITED = "limited.taxline.test@greensglobal.com"    # accounting:editor, entity 15000 only
GROUP_V = "grp-taxline-test-viewer"
GROUP_E = "grp-taxline-test-editor"
EVERYONE = (VIEWER, EDITOR, LIMITED)
ENTITIES = [
    {"code": "12000", "name": "Greens Global, Inc.", "parent_code": None},
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "15900", "name": "Escondido Annex", "parent_code": "15000"},
]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class TaxLineTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_V, name="Tax Line Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroup(id=GROUP_E, name="Tax Line Test Editors", allowed_modules="accounting:editor"))
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
            db.query(models.AccountingTaxLine).filter(models.AccountingTaxLine.set_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _put(self, entity, lines, form="schedule_c"):
        return self.client.put("/accounting/tax-lines", json={"form": form, "entity": entity, "lines": [{"accountNo": a, "line": l} for a, l in lines]})

    def test_save_read_override_and_remove(self):
        _as(EDITOR)
        r = self._put("", [("60100", "8"), ("62101", "21"), ("66000", "skip")])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted((x["accountNo"], x["line"], x["entity"]) for x in r.json()["lines"]),
                         [("60100", "8", ""), ("62101", "21", ""), ("66000", "skip", "")])
        # An entity's own row overrides the every-entity one; both come back for that entity.
        self.assertEqual(self._put("15000", [("62101", "22")]).status_code, 200)
        _as(VIEWER)
        got = self.client.get("/accounting/tax-lines?form=schedule_c&entity=15000").json()
        self.assertEqual(sorted((x["accountNo"], x["line"], x["entity"]) for x in got["lines"]),
                         [("60100", "8", ""), ("62101", "21", ""), ("62101", "22", "15000"), ("66000", "skip", "")])
        self.assertTrue(all(x["by"] == EDITOR for x in got["lines"]))
        # Every entity only, without a name.
        self.assertEqual(len(self.client.get("/accounting/tax-lines").json()["lines"]), 3)
        # The same account again replaces; an empty line removes; others stay.
        _as(EDITOR)
        self._put("", [("60100", "18"), ("66000", "")])
        lines = {x["accountNo"]: x["line"] for x in self.client.get("/accounting/tax-lines").json()["lines"]}
        self.assertEqual(lines, {"60100": "18", "62101": "21"})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AccountingTaxLine).filter(models.AccountingTaxLine.entity == "", models.AccountingTaxLine.account_no == "60100").count(), 1)
        finally:
            db.close()

    def test_viewer_reads_only_and_bad_input_is_refused(self):
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/tax-lines").json(), {"form": "schedule_c", "entity": "", "lines": []})
        self.assertEqual(self._put("", [("60100", "8")]).status_code, 403)
        _as(EDITOR)
        self.assertEqual(self._put("", [("60100", "99")]).status_code, 400)
        self.assertEqual(self._put("", [("", "8")]).status_code, 400)
        self.assertEqual(self._put("", [("60100", "8")], form="form_1120").status_code, 400)
        self.assertEqual(self._put("bad code!", [("60100", "8")]).status_code, 400)
        self.assertEqual(self.client.get("/accounting/tax-lines?form=nope").status_code, 400)

    def test_limited_caller_stays_inside_their_entities(self):
        _as(LIMITED)
        self.assertEqual(self._put("15000", [("62101", "21")]).status_code, 200)
        self.assertEqual(self._put("15900", [("62101", "21")]).status_code, 200)
        self.assertEqual(self._put("12000", [("62101", "21")]).status_code, 403)
        self.assertEqual(self._put("", [("62101", "21")]).status_code, 403)
        self.assertEqual(self.client.get("/accounting/tax-lines?entity=12000").status_code, 403)
        self.assertEqual(self.client.get("/accounting/tax-lines?entity=15000").status_code, 200)

    def test_nothing_is_sent_to_the_accounting_service(self):
        """Saving a mapping never calls the accounting app (and so never Intacct)."""
        calls = []
        real = accounting._acct_get

        async def spy(path, params):
            calls.append(path)
            return await real(path, params)
        accounting._acct_get = spy
        _as(EDITOR)
        self._put("", [("60100", "8")])
        self.assertTrue(all(p.endswith("/reports/locations") for p in calls), calls)


if __name__ == "__main__":
    unittest.main()
