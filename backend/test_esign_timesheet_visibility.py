"""Signed Time Sheet envelopes open only for the employee, the approving
manager, the company's HR contact, a Full HR grant and Global Admins - and
never list in Documents (Neil, Oct 20 2026 hotfix: "Valinda should be able to
see this and Amy should be able to see it as a recipient and global admin and
HR should be able to see it, but not everyone"). Before this, any HR reader or
administrator saw every one. Other envelopes are unchanged.

    python -m unittest test_esign_timesheet_visibility -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
AMY = "amy.bolanos" + D          # the employee (the signer)
VALINDA = "valinda.mgr" + D      # her manager, who approved it - no HR grant
CONTACT = "hana.contact" + D     # the company's HR contact
HR_FULL = "fran.full" + D        # Full HR grant
HR_VIEW = "vic.viewer" + D       # HR Viewer: used to see every envelope
ADMIN = "ada.admin" + D          # Administrator role, not a Global Admin
GLOBAL = "gil.global" + D        # member of the Global Admins group
CO = "co-ts-vis"


class TimesheetEnvelopeVisibility(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.HrSignRequest, models.HrSignParty, models.HrSignEvent, models.TimesheetReview,
                  models.NexusEmployee, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                  models.HrEntity):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Oversite Management", hr_contact_email=CONTACT))
        for i, (em, first) in enumerate(((AMY, "Amy"), (VALINDA, "Valinda"), (CONTACT, "Hana"))):
            db.add(models.NexusEmployee(id=f"e{i}", first_name=first, last_name="Test", work_email=em,
                                        company=CO, status="active", manager_email=VALINDA if em == AMY else ""))
        db.add(models.NexusRole(email=ADMIN, role="administrator"))
        db.add(models.NexusGroup(id="g-full", name="HR Full", allowed_modules="hr:full"))
        db.add(models.NexusGroup(id="g-view", name="HR Viewers", allowed_modules="hr:viewer"))
        db.add(models.NexusGroup(id="g-global", name="Global Admins", allowed_modules="hr:viewer", is_global_admin=1))
        for g, em in (("g-full", HR_FULL), ("g-view", HR_VIEW), ("g-view", CONTACT), ("g-view", VALINDA),
                      ("g-global", GLOBAL)):
            db.add(models.NexusGroupMember(group_id=g, email=em))
        db.add(models.TimesheetReview(id="rv-amy", employee_email=AMY, period_start="2026-10-04",
                                      period_end="2026-10-17", pay_type="hourly", status="completed",
                                      manager_email=VALINDA, agreed_by=VALINDA, rounds=[]))
        for rid, kind, link in (("req-ts", "timesheet", "rv-amy"), ("req-offer", "", "")):
            db.add(models.HrSignRequest(id=rid, title=f"Envelope {rid}", source="pdf", status="completed",
                                        entity_id=CO, final_pdf_path=f"esign/{rid}.pdf", created_by=VALINDA,
                                        created_at="2026-10-20T00:00:00", link_kind=kind, link_id=link,
                                        certificate_html="<p>cert</p>"))
            db.add(models.HrSignParty(id=f"p-{rid}", request_id=rid, role_key="employee", name="Amy Bolanos",
                                      email=AMY, kind="internal", ordinal=1, party_role="signer",
                                      status="signed", token=f"tok-{rid}"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self._real = esign._storage_signed_url
        esign._storage_signed_url = lambda bucket, path, *a, **k: esign._StorageResult(
            True, json_data={"url": "http://storage/x", "expiresIn": 60})

    def tearDown(self):
        esign._storage_signed_url = self._real
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _reads(self, rid):
        return {
            "detail": self.client.get(f"/esign/requests/{rid}"),
            "download": self.client.get(f"/esign/requests/{rid}/download"),
            "holds": self.client.get(f"/esign/requests/{rid}/holds"),
            "uploads": self.client.get(f"/esign/requests/{rid}/uploads"),
        }

    def test_hr_viewers_and_administrators_no_longer_open_a_time_sheet(self):
        for who in (HR_VIEW, ADMIN):
            self._as(who)
            for name, r in self._reads("req-ts").items():
                self.assertEqual(r.status_code, 404, f"{who} {name}: {r.text}")   # does not admit it exists
        # Writes too: an administrator (HR write) cannot copy the signer's link or void it.
        self._as(ADMIN)
        self.assertEqual(self.client.get("/esign/requests/req-ts/parties/p-req-ts/link").status_code, 404)
        self.assertEqual(self.client.post("/esign/requests/req-ts/void").status_code, 404)

    def test_the_people_neil_named_still_open_it(self):
        for who in (CONTACT, HR_FULL, GLOBAL):
            self._as(who)
            for name, r in self._reads("req-ts").items():
                self.assertEqual(r.status_code, 200, f"{who} {name}: {r.text}")

    def test_the_approving_manager_opens_the_signed_copy_without_an_hr_grant(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter_by(email=VALINDA).delete()
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self._as(VALINDA)
        self.assertEqual(self.client.get("/esign/requests/req-ts/download").status_code, 200)
        # ...but not other envelopes, which stay HR-only
        self.assertIn(self.client.get("/esign/requests/req-offer/download").status_code, (401, 403))

    def test_time_sheets_never_list_in_documents(self):
        self._as(HR_FULL)
        ids = [r["id"] for r in self.client.get("/esign/requests").json()]
        self.assertIn("req-offer", ids)
        self.assertNotIn("req-ts", ids)
        hits = self.client.get("/documents/search?q=Amy").json()
        self.assertNotIn("req-ts", [h["id"] for h in hits if h.get("type") == "esign"])

    def test_other_envelopes_are_unchanged(self):
        self._as(HR_VIEW)
        for name, r in self._reads("req-offer").items():
            self.assertEqual(r.status_code, 200, f"{name}: {r.text}")


if __name__ == "__main__":
    unittest.main()
