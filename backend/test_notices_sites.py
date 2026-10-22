"""
Workplace Notices - paper posters at each site: the posters a site needs,
confirmed per CURRENT version with a photo by the site lead or HR, a new
version reopening it, and the lead hearing about new posters.

Throwaway sqlite; storage and mail stubbed. Run with:
python -m unittest test_notices_sites -v
"""
import io
import os
import tempfile
import unittest
import uuid
from datetime import date, timedelta

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit  # noqa: E402

from fastapi import HTTPException, UploadFile  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402
import notices_daily  # noqa: E402
from routers import notices as rn  # noqa: E402

notices_daily.mail = lambda *a, **k: ""


class _Res:
    is_success, content, text = True, b"jpg", ""


rn._storage_put = lambda *a, **k: _Res()
rn._storage_fetch = lambda *a, **k: _Res()


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CHARMI, LEAD, OTHER = "charmi@x.com", "lead@x.com", "other@x.com"


def photo():
    return UploadFile(file=io.BytesIO(b"jpg"), filename="wall.jpg", headers={"content-type": "image/jpeg"})


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticePosting,
                  models.WorkplaceNoticeSite, models.WorkplaceNoticeEvent, models.NexusSetting,
                  models.NexusNotification, models.NexusEmployee, models.HrEntity, models.HrWorkSite,
                  models.HrCompanyWorkSite):
            self.db.query(m).delete()
        self.db.add_all([
            models.HrEntity(id="co", name="Greens", country="US", hr_contact_email=CHARMI),
            models.HrWorkSite(id="job", name="Downtown Job", address="1 Main St, San Diego, CA 92101"),
            models.HrCompanyWorkSite(id="co:job", company_id="co", site_id="job"),
        ])
        for em in (CHARMI, LEAD, OTHER):
            self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name=em[:4], work_email=em, company="co",
                                             status="active", deleted_at=""))
        self.db.commit()
        notices.ensure_catalog(self.db)
        self.db.commit()
        rn.set_site("job", rn.SiteIn(kind="jobsite", lead_email=LEAD), user={"email": CHARMI}, db=self.db)

    def ver(self, nid, number=1, eff=None):
        v = models.WorkplaceNoticeVersion(id=f"{nid}-{number}", notice_id=nid, number=number, status="approved",
                                          effective_date=(eff or date.today() - timedelta(days=5)).isoformat(),
                                          label=f"v{number}", files=[{"lang": "en", "path": "p", "sha256": "h"}])
        self.db.add(v)
        self.db.commit()
        return v

    def board(self):
        return {x["noticeId"]: x for x in rn.site_board(self.db, "job")["required"]}

    def test_board_follows_site_kind_and_city(self):
        b = self.board()
        for nid in ("ca-mw", "ca-wo16", "ca-emergency", "sd-mw", "fed-flsa"):
            self.assertIn(nid, b)
        self.assertNotIn("ca-wo4", b)
        self.assertEqual(b["ca-mw"]["status"], "no_file")

    def test_lead_confirms_with_a_photo_and_a_new_version_reopens(self):
        self.ver("ca-mw")
        self.assertEqual(self.board()["ca-mw"]["status"], "missing")
        with self.assertRaises(HTTPException) as c:
            rn.confirm_posting("job", notice_ids="ca-mw", note="", photo=photo(), user={"email": OTHER}, db=self.db)
        self.assertEqual(c.exception.status_code, 403)
        rn.confirm_posting("job", notice_ids="ca-mw", note="Break room", photo=photo(), user={"email": LEAD}, db=self.db)
        self.assertEqual(self.board()["ca-mw"]["status"], "confirmed")
        self.ver("ca-mw", 2, eff=date.today())
        self.assertEqual(self.board()["ca-mw"]["status"], "missing")      # the 2027 poster is not up yet
        self.assertEqual(len(rn.my_sites(user={"email": LEAD}, db=self.db)["sites"]), 1)

    def test_photo_is_required_to_be_an_image(self):
        self.ver("ca-mw")
        pdf = UploadFile(file=io.BytesIO(b"%PDF"), filename="x.pdf", headers={"content-type": "application/pdf"})
        with self.assertRaises(HTTPException):
            rn.confirm_posting("job", notice_ids="ca-mw", note="", photo=pdf, user={"email": LEAD}, db=self.db)

    def test_lead_must_be_in_people(self):
        with self.assertRaises(HTTPException):
            rn.set_site("job", rn.SiteIn(kind="jobsite", lead_email="nobody@x.com"), user={"email": CHARMI}, db=self.db)

    def test_lead_hears_about_new_posters(self):
        self.ver("ca-mw", eff=date.today())
        notices_daily.announce(self.db)
        bells = self.db.query(models.NexusNotification).filter_by(recipient=LEAD, type="workplace_notice_site").all()
        self.assertEqual(len(bells), 1)
        self.assertIn("California Minimum Wage", bells[0].body)

    def test_sites_list_for_hr(self):
        out = rn.sites(user={"email": CHARMI}, db=self.db)["sites"]
        self.assertEqual(out[0]["kind"], "jobsite")
        self.assertEqual(out[0]["city"], "SAN DIEGO")
        with self.assertRaises(HTTPException):
            rn.sites(user={"email": OTHER}, db=self.db)


if __name__ == "__main__":
    unittest.main()
