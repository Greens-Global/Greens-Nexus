"""Signed offer and promotion letters print pay, so only Pay & Benefits holders
can download them, copy a signer's link, re-point a signer, or open the filed
copy from People > Documents (Oct 14). Before this, any HR reader could
download a sealed offer letter with the salary in it.

    python -m unittest test_esign_pay_gate -v
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
from routers import hr as hr_router  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
ADMIN = "ada.admin" + D        # administrator, no Pay & Benefits grant
HR_ONLY = "hal.hr" + D         # People editor, no Pay & Benefits grant
HR_COMP = "cara.comp" + D      # People editor + Pay & Benefits
OWNER = "olive.owner" + D      # owner: pay without a grant
CO = "co-pay-gate"


class _Resp:
    is_success = True

    def json(self):
        return {"signedURL": "/object/sign/x?token=t"}


class PayGateTests(unittest.TestCase):
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
        for m in (models.HrSignRequest, models.HrSignParty, models.HrSignEvent, models.HrDocument,
                  models.NexusEmployee, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                  models.HrEntity):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Pay Gate Co"))
        db.add(models.NexusEmployee(id="emp-jane", first_name="Jane", last_name="Doe",
                                    work_email="jane.doe" + D, company=CO, status="active"))
        db.add(models.NexusRole(email=ADMIN, role="administrator"))
        db.add(models.NexusRole(email=OWNER, role="owner"))
        db.add(models.NexusGroup(id="g-hr", name="People Editors", allowed_modules="hr:editor"))
        db.add(models.NexusGroup(id="g-comp", name="People + Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        db.add(models.NexusGroupMember(group_id="g-hr", email=HR_ONLY))
        db.add(models.NexusGroupMember(group_id="g-comp", email=HR_COMP))
        for rid, pays in (("req-pay", 1), ("req-plain", 0)):
            db.add(models.HrSignRequest(id=rid, title=f"Offer {rid}", source="template", status="pending",
                                        employee_id="emp-jane", entity_id=CO, final_pdf_path=f"esign/{rid}.pdf",
                                        created_by=OWNER, created_at="2026-10-14T00:00:00", prints_pay=pays))
            db.add(models.HrSignParty(id=f"p-{rid}", request_id=rid, role_key="employee", name="Jane Doe",
                                      email="jane.doe@gmail.com", kind="external", ordinal=1,
                                      party_role="signer", status="notified", token=f"tok-{rid}"))
            db.add(models.HrDocument(id=f"doc-{rid}", employee_id="emp-jane", kind="contract",
                                     file_name="Offer.pdf", storage_path=f"esign/{rid}.pdf", size_bytes=1,
                                     uploaded_by=OWNER, created_at="2026-10-14T00:00:00"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self._patched = [(esign, "_storage_signed_url", esign._storage_signed_url),
                         (hr_router.httpx, "post", hr_router.httpx.post),
                         (hr_router, "_storage_headers", hr_router._storage_headers)]
        esign._storage_signed_url = lambda bucket, path, *a, **k: esign._StorageResult(
            True, json_data={"url": "http://storage/x", "expiresIn": 60})
        hr_router.httpx.post = lambda *a, **k: _Resp()
        hr_router._storage_headers = lambda: {}

    def tearDown(self):
        for obj, name, orig in self._patched:
            setattr(obj, name, orig)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _calls(self, rid):
        return {
            "download": self.client.get(f"/esign/requests/{rid}/download"),
            "link": self.client.get(f"/esign/requests/{rid}/parties/p-{rid}/link"),
            "fix": self.client.patch(f"/esign/requests/{rid}/parties/p-{rid}", json={"name": "Jane A. Doe"}),
            "filed": self.client.get(f"/hr/documents/doc-{rid}/url"),
        }

    def test_without_pay_access_every_way_to_the_pay_letter_is_closed(self):
        for who in (ADMIN, HR_ONLY):
            self._as(who)
            for name, r in self._calls("req-pay").items():
                self.assertEqual(r.status_code, 403, f"{who} {name}: {r.text}")
                self.assertIn("Pay & Benefits", r.text)

    def test_a_letter_without_pay_stays_open_to_any_hr_reader(self):
        for who in (ADMIN, HR_ONLY):
            self._as(who)
            for name, r in self._calls("req-plain").items():
                self.assertEqual(r.status_code, 200, f"{who} {name}: {r.text}")

    def test_pay_access_opens_the_pay_letter(self):
        for who in (HR_COMP, OWNER):
            self._as(who)
            for name, r in self._calls("req-pay").items():
                self.assertEqual(r.status_code, 200, f"{who} {name}: {r.text}")

    def test_the_detail_screen_is_told_up_front(self):
        self._as(HR_ONLY)
        r = self.client.get("/esign/requests/req-pay")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["printsPay"])
        self.assertTrue(r.json()["payLocked"])
        self._as(HR_COMP)
        self.assertFalse(self.client.get("/esign/requests/req-pay").json()["payLocked"])
        self.assertNotIn("payLocked", self.client.get("/esign/requests/req-plain").json())

    def test_metadata_stays_readable(self):
        # The list and the detail carry no document bytes - they stay HR-read.
        self._as(HR_ONLY)
        self.assertEqual(self.client.get("/esign/requests").status_code, 200)
        self.assertEqual(self.client.get("/esign/requests/req-pay").status_code, 200)


if __name__ == "__main__":
    unittest.main()
