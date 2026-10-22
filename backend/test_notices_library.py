"""
Workplace Notices HR library (Neil, Oct 21 2026): prepare -> submit ->
approve by SOMEONE ELSE -> live on its effective date. Approved = frozen.

Throwaway sqlite; storage is an in-memory dict. Run with:
python -m unittest test_notices_library -v
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
from routers import notices as rn  # noqa: E402

STORE = {}


class _Res:
    def __init__(self, ok, content=b"", text=""):
        self.is_success, self.content, self.text = ok, content, text


def _put(bucket, path, data, ctype, upsert=False):
    STORE[(bucket, path)] = data
    return _Res(True)


def _fetch(bucket, path, timeout=60):
    return _Res((bucket, path) in STORE, STORE.get((bucket, path), b""), "missing")


rn._storage_put = _put
rn._storage_fetch = _fetch


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CHARMI = "charmi@x.com"     # the company's HR contact - prepares and approves
PRANSHU = "pranshu@x.com"   # administrator
EMP = "emp@x.com"
U_CHARMI = {"email": CHARMI, "level": 1}
U_PRANSHU = {"email": PRANSHU, "level": 4}
U_EMP = {"email": EMP, "level": 1}
PDF = b"%PDF-1.4 test poster"


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeSource,
                  models.WorkplaceNoticeEvent, models.WorkplaceNoticePerson, models.NexusSetting,
                  models.NexusNotification, models.NexusEmployee, models.HrEntity, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="co", name="Greens", country="US", hr_contact_email=CHARMI))
        self.db.add(models.NexusRole(email=PRANSHU, role="administrator"))
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="Emp", work_email=EMP, company="co",
                                         status="active", deleted_at=""))
        self.db.commit()
        notices.ensure_catalog(self.db)
        self.db.commit()

    def draft(self, user, nid="ca-mw", eff=None, summary="2027 minimum wage $17.40"):
        v = rn.create_version(nid, rn.VersionIn(label="2027", effective_date=(eff or date.today()).isoformat(),
                                                summary=summary), user=user, db=self.db)
        up = UploadFile(file=io.BytesIO(PDF), filename="MW-2027.pdf", headers={"content-type": "application/pdf"})
        rn.upload_file(v["id"], file=up, lang="en", source="", user=user, db=self.db)
        return v["id"]

    def test_employee_cannot_open_library(self):
        with self.assertRaises(HTTPException) as c:
            rn.library(user=U_EMP, db=self.db)
        self.assertEqual(c.exception.status_code, 403)

    def test_library_lists_catalog_with_needs_file(self):
        out = rn.library(user=U_CHARMI, db=self.db)
        mw = next(n for n in out["notices"] if n["id"] == "ca-mw")
        self.assertEqual(mw["state"], "needs_file")
        self.assertTrue(out["canApprove"])

    def test_two_people_approve(self):
        vid = self.draft(U_CHARMI)
        rn.submit_version(vid, user=U_CHARMI, db=self.db)
        with self.assertRaises(HTTPException) as c:
            rn.review_version(vid, rn.ReviewIn(decision="approve"), user=U_CHARMI, db=self.db)
        self.assertEqual(c.exception.status_code, 403)
        rn.review_version(vid, rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)
        live = notices.live_version(self.db, "ca-mw")
        self.assertEqual(live.id, vid)
        self.assertEqual(live.approved_by, PRANSHU)
        acts = [e.action for e in self.db.query(models.WorkplaceNoticeEvent).filter_by(version_id=vid).all()]
        for a in ("version_created", "file_added", "version_submitted", "version_approved"):
            self.assertIn(a, acts)
        # the preparer heard about it
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(recipient=CHARMI, title="Notice Approved").count())

    def test_someone_who_uploaded_cannot_approve(self):
        v = rn.create_version("ca-mw", rn.VersionIn(effective_date=date.today().isoformat(), summary="x"),
                              user=U_CHARMI, db=self.db)
        up = UploadFile(file=io.BytesIO(PDF), filename="a.pdf", headers={"content-type": "application/pdf"})
        rn.upload_file(v["id"], file=up, lang="en", source="", user=U_PRANSHU, db=self.db)
        rn.submit_version(v["id"], user=U_CHARMI, db=self.db)
        with self.assertRaises(HTTPException):
            rn.review_version(v["id"], rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)

    def test_submit_needs_file_date_and_summary(self):
        v = rn.create_version("ca-mw", rn.VersionIn(effective_date=date.today().isoformat(), summary="x"),
                              user=U_CHARMI, db=self.db)
        with self.assertRaises(HTTPException):
            rn.submit_version(v["id"], user=U_CHARMI, db=self.db)
        vid = self.draft(U_CHARMI, summary="")
        with self.assertRaises(HTTPException):
            rn.submit_version(vid, user=U_CHARMI, db=self.db)

    def test_approved_is_frozen(self):
        vid = self.draft(U_CHARMI)
        rn.submit_version(vid, user=U_CHARMI, db=self.db)
        rn.review_version(vid, rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)
        with self.assertRaises(HTTPException) as c:
            rn.update_version(vid, rn.VersionIn(summary="changed"), user=U_CHARMI, db=self.db)
        self.assertEqual(c.exception.status_code, 409)
        up = UploadFile(file=io.BytesIO(b"%PDF other"), filename="b.pdf", headers={"content-type": "application/pdf"})
        with self.assertRaises(HTTPException):
            rn.upload_file(vid, file=up, lang="en", source="", user=U_CHARMI, db=self.db)
        with self.assertRaises(HTTPException):     # live versions are replaced, never withdrawn
            rn.withdraw_version(vid, rn.ReasonIn(reason="oops"), user=U_PRANSHU, db=self.db)

    def test_send_back_needs_a_note_and_reopens(self):
        vid = self.draft(U_CHARMI)
        rn.submit_version(vid, user=U_CHARMI, db=self.db)
        with self.assertRaises(HTTPException):
            rn.review_version(vid, rn.ReviewIn(decision="send_back"), user=U_PRANSHU, db=self.db)
        rn.review_version(vid, rn.ReviewIn(decision="send_back", note="Wrong year"), user=U_PRANSHU, db=self.db)
        rn.update_version(vid, rn.VersionIn(effective_date=date.today().isoformat(), summary="fixed"),
                          user=U_CHARMI, db=self.db)
        rn.submit_version(vid, user=U_CHARMI, db=self.db)

    def test_scheduled_version_goes_live_on_its_date(self):
        old = self.draft(U_CHARMI, eff=date.today() - timedelta(days=200), summary="2026")
        rn.submit_version(old, user=U_CHARMI, db=self.db)
        rn.review_version(old, rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)
        new = self.draft(U_CHARMI, eff=date.today() + timedelta(days=70), summary="2027")
        rn.submit_version(new, user=U_CHARMI, db=self.db)
        rn.review_version(new, rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)
        self.assertEqual(notices.live_version(self.db, "ca-mw").id, old)
        lib = {n["id"]: n for n in rn.library(user=U_CHARMI, db=self.db)["notices"]}
        self.assertEqual(lib["ca-mw"]["state"], "scheduled")
        self.assertEqual(notices.live_version(self.db, "ca-mw", on=date.today() + timedelta(days=70)).id, new)
        # a scheduled version can be withdrawn by an approver, with a reason
        rn.withdraw_version(new, rn.ReasonIn(reason="Wrong file"), user=U_PRANSHU, db=self.db)
        self.assertIsNone(notices.scheduled_version(self.db, "ca-mw"))

    def test_named_approvers(self):
        rn.put_settings(rn.SettingsIn(approvers=[CHARMI]), user=U_PRANSHU, db=self.db)
        vid = self.draft(U_PRANSHU)
        rn.submit_version(vid, user=U_PRANSHU, db=self.db)
        # an administrator is no longer an approver once approvers are named
        self.assertFalse(rn.can_approve(self.db, PRANSHU))
        rn.review_version(vid, rn.ReviewIn(decision="approve"), user=U_CHARMI, db=self.db)
        # and only an approver can change who approves
        with self.assertRaises(HTTPException):
            rn.put_settings(rn.SettingsIn(approvers=[PRANSHU]), user=U_PRANSHU, db=self.db)

    def test_file_streams_only_when_approved_or_hr(self):
        vid = self.draft(U_CHARMI)
        with self.assertRaises(HTTPException):
            rn.version_file(vid, user=U_EMP, db=self.db)
        self.assertEqual(rn.version_file(vid, user=U_CHARMI, db=self.db).body, PDF)
        rn.submit_version(vid, user=U_CHARMI, db=self.db)
        rn.review_version(vid, rn.ReviewIn(decision="approve"), user=U_PRANSHU, db=self.db)
        self.assertEqual(rn.version_file(vid, user=U_EMP, db=self.db).body, PDF)

    def test_notice_changes_are_logged_with_before(self):
        n = self.db.get(models.WorkplaceNotice, "ca-mw")
        body = rn.NoticeIn(title=n.title, form_code=n.form_code, agency=n.agency, kind=n.kind, area="US-CA",
                           mode=n.mode, trigger=n.trigger, applies={"minHeadcount": 5}, source_url=n.source_url)
        rn.update_notice("ca-mw", body, user=U_CHARMI, db=self.db)
        ev = self.db.query(models.WorkplaceNoticeEvent).filter_by(notice_id="ca-mw", action="notice_changed").one()
        self.assertIn("applies", ev.detail["before"])
        with self.assertRaises(HTTPException):
            rn.update_notice("ca-mw", rn.NoticeIn(title="x", area="CALIFORNIA"), user=U_CHARMI, db=self.db)

    def test_retire_needs_reason(self):
        with self.assertRaises(HTTPException):
            rn.retire_notice("ca-mw", rn.ReasonIn(reason=""), user=U_CHARMI, db=self.db)
        rn.retire_notice("ca-mw", rn.ReasonIn(reason="No CA staff"), user=U_CHARMI, db=self.db)
        self.assertEqual(self.db.get(models.WorkplaceNotice, "ca-mw").status, "retired")


if __name__ == "__main__":
    unittest.main()
