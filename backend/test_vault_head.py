"""Credentials (11/13/2026): the department head's code, weak / leaked passwords
refused, the expiry and needs-attention alerts, and the import template.

  - Adding (and editing, trashing, recovering, deleting, importing, handing
    over) a login needs a code the department's head receives - never the
    person asking. A verified code opens ten minutes for that department.
    The head, the backup head and a Super Administrator need none; a
    department with no head goes to the Super Administrators.
  - A weak password, or one found in a breach, is refused with the field named.
  - A weak / leaked / reused password alerts once, then weekly.
  - The import template's Company and Department columns are dropdowns.

Throwaway sqlite. Run with: python -m pytest test_vault_head.py
"""
import io
import unittest
from unittest import mock

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import credvault as CV  # noqa: E402

D = "@greensglobal.com"
EMP, HEAD, BOSS, OTHER = "em.employee" + D, "he.head" + D, "bo.boss" + D, "ot.other" + D
SITE = "si.site" + D
CO = "co-lv"
GOOD = "Corr3ct-Horse-Battery!"


class HeadCodeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.hibp = mock.patch("vault_breach.pwned_count", return_value=0).start()
        self.addCleanup(mock.patch.stopall)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.VaultCredential, models.VaultAccessLog, models.VaultOtpChallenge,
                      models.VaultOtpSession, models.HrDepartment, models.VaultCredentialAudience)
            for em in (EMP, HEAD, OTHER):
                kit.person(db, em)
            kit.person(db, BOSS, role="owner")
            for em in (EMP, HEAD, OTHER):
                kit.grant(db, em, "credvault:editor")
            db.add(models.HrDepartment(id="d-ops", company_id=CO, name="Operations", lead_email=HEAD, backup_email=""))
            db.add(models.HrDepartment(id="d-it", company_id=CO, name="IT", lead_email="", backup_email=""))
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def _post(self, who, body):
        kit.as_(who)
        return self.client.post("/credvault/credentials", json={"name": "Gate", "dept": "Operations", "companyId": CO, "secret": GOOD, **body})

    def _db(self):
        db = database.SessionLocal()
        self.addCleanup(db.close)
        return db

    def test_adding_a_login_waits_for_the_heads_code(self):
        r = self._post(EMP, {})
        self.assertEqual(r.status_code, 403, r.text)
        d = r.json()["detail"]
        self.assertEqual(d["code"], "head_code_required")
        self.assertEqual([(s["dept"], s["companyId"]) for s in d["scopes"]], [("Operations", CO)])
        # The code goes to the head - by bell (and email) - never to the person asking.
        got = self.client.post("/credvault/head-code/request", json={"companyId": CO, "dept": "Operations", "action": "add Gate"}).json()
        bells = self._db().query(models.NexusNotification).filter(models.NexusNotification.type == "vault_head_code").all()
        self.assertEqual([b.recipient for b in bells], [HEAD])
        self.assertIn(got["devCode"], bells[0].body)
        self.assertIn("add Gate", bells[0].body)
        bad = self.client.post("/credvault/head-code/verify", json={"challengeId": got["challengeId"], "code": "000000", "companyId": CO, "dept": "Operations"})
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post("/credvault/head-code/verify", json={"challengeId": got["challengeId"], "code": got["devCode"], "companyId": CO, "dept": "Operations"})
        self.assertEqual(ok.status_code, 200, ok.text)
        cid = self._post(EMP, {}).json()["id"]                       # within the window: saves
        kit.as_(EMP)
        self.assertEqual(self.client.post(f"/credvault/credentials/{cid}/transfer", json={"ownerEmail": OTHER}).status_code, 200)
        self.assertTrue(any(log.action == "Head Approved" for log in self._db().query(models.VaultAccessLog).all()))

    def test_the_head_and_a_super_administrator_need_no_code(self):
        self.assertEqual(self._post(HEAD, {}).status_code, 200)
        self.assertEqual(self._post(BOSS, {"name": "Gate 2"}).status_code, 200)

    def test_a_department_with_no_head_asks_the_super_administrators(self):
        d = self._post(EMP, {"dept": "IT"}).json()["detail"]
        self.assertTrue(d["scopes"][0]["fallback"])
        self.client.post("/credvault/head-code/request", json={"companyId": CO, "dept": "IT"})
        bells = self._db().query(models.NexusNotification).filter(models.NexusNotification.type == "vault_head_code").all()
        self.assertEqual([b.recipient for b in bells], [BOSS])

    def test_moving_to_the_trash_asks_too(self):
        cid = self._post(HEAD, {"backupOwner": EMP}).json()["id"]
        kit.as_(EMP)
        r = self.client.delete(f"/credvault/credentials/{cid}")
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (403, "head_code_required"))

    def test_weak_and_leaked_passwords_are_refused(self):
        r = self._post(HEAD, {"secret": "short1"})
        self.assertEqual((r.status_code, r.json()["detail"]["code"], r.json()["detail"]["field"]), (400, "weak_password", "secret"))
        self.hibp.return_value = 9
        r = self._post(HEAD, {"secret": GOOD})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (400, "breached_password"))

    def test_needs_attention_alerts_once_then_weekly_to_owner_and_head(self):
        cid = self._post(HEAD, {"backupOwner": OTHER}).json()["id"]
        db = self._db()
        db.get(models.VaultCredential, cid).strength = "weak"     # an older login - new weak ones are refused
        db.commit()
        self.assertEqual(CV.rotation_reminders(db), 1)
        self.assertEqual(CV.rotation_reminders(db), 0)
        bells = db.query(models.NexusNotification).filter(models.NexusNotification.type == "vault_attention").all()
        self.assertEqual({b.recipient for b in bells}, {HEAD, OTHER})
        self.assertIn("weak", bells[0].body)

    def test_access_groups_narrow_the_departments_none_picked_is_all(self):
        # 11/13/2026: Operations + "Site Managers" = only the site managers in Operations.
        db = self._db()
        kit.person(db, SITE)
        kit.grant(db, SITE, "credvault:editor")
        for em, dept in ((EMP, "Operations"), (OTHER, "Operations"), (SITE, "IT")):
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == em).update({"department": dept})
        db.add(models.NexusGroup(id="g-site", name="Site Managers"))
        db.add(models.NexusGroupMember(group_id="g-site", email=EMP))
        db.add(models.NexusGroupMember(group_id="g-site", email=SITE))
        db.commit()
        kit.refresh()
        auds = [{"kind": "department", "value": f"{CO}:Operations", "level": "open"}]
        wide = self._post(BOSS, {"name": "Wide", "audiences": auds}).json()["id"]
        narrow = self._post(BOSS, {"name": "Narrow", "audiences": auds + [{"kind": "only_group", "value": "g-site", "level": "open"}]}).json()["id"]

        def access(who, cid):
            kit.as_(who)
            return next(c for c in self.client.get("/credvault/credentials").json() if c["id"] == cid)["access"]
        self.assertEqual((access(EMP, wide), access(OTHER, wide)), ("department", "department"))   # none picked = all
        self.assertEqual(access(EMP, narrow), "department")      # in Operations and a site manager
        self.assertEqual(access(OTHER, narrow), "request")       # in Operations, not a site manager
        self.assertEqual(access(SITE, narrow), "request")        # a site manager, not in Operations
        labels = [a["label"] for a in next(c for c in self.client.get("/credvault/credentials").json() if c["id"] == narrow)["audiences"]]
        self.assertIn("Only Site Managers", labels)

    def test_the_import_template_has_company_and_department_dropdowns(self):
        import openpyxl
        kit.as_(EMP)
        r = self.client.get("/credvault/import-template")
        self.assertEqual(r.status_code, 200, r.text)
        wb = openpyxl.load_workbook(io.BytesIO(r.content))
        self.assertEqual([c.value for c in wb["Logins"][1]][:5], ["Name", "Company", "Department", "Username", "Password"])
        lists = {str(v.sqref): v.formula1 for v in wb["Logins"].data_validations.dataValidation}
        self.assertEqual(lists["B2:B501"], "CompanyNames")
        self.assertIn("INDIRECT", lists["C2:C501"])
        self.assertEqual(sorted(c.value for c in wb["Lists"]["D"][1:] if c.value), ["IT", "Operations"])


if __name__ == "__main__":
    unittest.main()
