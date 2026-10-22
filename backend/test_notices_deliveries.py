"""
Workplace Notices deliveries (Neil, Oct 21 2026): the at-hire bundle once,
the yearly round (SB 294 held until THIS year's version is approved, HR
warned), separation notices to the personal email, HR sending an event
notice, and the SB 294 emergency contact (Labor Code 1555).

Throwaway sqlite; mail and storage stubbed. Run with:
python -m unittest test_notices_deliveries -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import date, timedelta

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit  # noqa: E402

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402
import notices_daily  # noqa: E402
from routers import notices as rn  # noqa: E402

MAILS = []
notices_daily.mail = lambda to, subject, lines, **kw: MAILS.append({"to": to, "subject": subject, "files": kw.get("attachments")}) or ""


class _Res:
    is_success, content, text = True, b"%PDF notice", ""


rn._storage_fetch = lambda bucket, path, timeout=60: _Res()


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CHARMI = "charmi@x.com"
TODAY = date.today()


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        MAILS.clear()
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeDelivery,
                  models.WorkplaceNoticeEvent, models.WorkplaceNoticeSite, models.WorkplaceNoticePerson,
                  models.NexusSetting, models.NexusNotification, models.NexusEmployee, models.HrEntity,
                  models.HrWorkSite, models.PayrollRate):
            self.db.query(m).delete()
        self.db.add_all([
            models.HrEntity(id="co", name="Greens", country="US", hr_contact_email=CHARMI),
            models.HrWorkSite(id="s", name="Escondido (GSE)", address="25260 N Centre City Pkwy, Escondido, CA 92026"),
            models.WorkplaceNoticeSite(site_id="s", kind="office"),
        ])
        self.db.commit()
        notices.ensure_catalog(self.db)
        notices.save_settings(self.db, "x", {"hireSince": (TODAY - timedelta(days=30)).isoformat()})
        self.db.commit()
        self.new = self.emp("new@x.com", start=TODAY.isoformat())
        self.old = self.emp("old@x.com", start="2020-01-06")

    def emp(self, email, start="2020-01-06", status="active", personal="", log=None, first=None):
        e = models.NexusEmployee(id=str(uuid.uuid4()), first_name=first or email.split("@")[0].title(), last_name="Test",
                                 work_email=email, personal_email=personal, company="co", work_site_id="s",
                                 status=status, start_date=start, status_log=log or [], deleted_at="",
                                 personal={"emergency": {"name": "Bob Test", "phone": "555-0100", "relationship": "Brother"}})
        self.db.add(e)
        self.db.commit()
        return e

    def ver(self, nid, eff=None, number=1):
        v = models.WorkplaceNoticeVersion(id=f"{nid}-{number}", notice_id=nid, number=number, status="approved",
                                          effective_date=(eff or TODAY - timedelta(days=60)).isoformat(), label=f"v{number}",
                                          files=[{"lang": "en", "path": f"p/{nid}", "name": f"{nid}.pdf", "sha256": "h"}])
        self.db.add(v)
        self.db.commit()
        return v

    def rows(self, reason, email=None):
        q = self.db.query(models.WorkplaceNoticeDelivery).filter_by(reason=reason)
        return q.filter_by(email=email).all() if email else q.all()

    def test_hire_bundle_once_and_only_for_new_hires(self):
        for nid in ("ca-dwc-hire", "ca-de2515", "ca-lc2810", "ca-sb294", "ca-mw"):
            self.ver(nid)
        self.assertEqual(notices_daily.deliver_hire(self.db), 3)    # DWC, DE 2515, SB 294 - never the filled form, never a poster
        got = {r.notice_id for r in self.rows("hire", "new@x.com")}
        self.assertEqual(got, {"ca-dwc-hire", "ca-de2515", "ca-sb294"})
        self.assertFalse(self.rows("hire", "old@x.com"))              # started before the module
        self.assertEqual(len(MAILS), 1)
        self.assertEqual(len(MAILS[0]["files"]), 3)
        self.assertEqual(notices_daily.deliver_hire(self.db), 0)    # once

    def test_yearly_round_waits_for_this_years_version(self):
        jan10 = date(TODAY.year, 1, 10)
        self.ver("ca-sb294", eff=date(TODAY.year - 1, 1, 2))          # last year's template
        self.assertEqual(notices_daily.deliver_annual(self.db, on=jan10), 0)
        # (the survivors and EITC notices, due in the same window with no version, warn too)
        warn = self.db.query(models.NexusNotification).filter_by(recipient=CHARMI, type="workplace_notice_hr", ref_id="ca-sb294").all()
        self.assertEqual(len(warn), 1)
        notices_daily.deliver_annual(self.db, on=jan10)               # not twice in a week
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(recipient=CHARMI, type="workplace_notice_hr", ref_id="ca-sb294").count(), 1)
        self.ver("ca-sb294", eff=date(TODAY.year, 1, 2), number=2)    # this year's, approved
        self.assertEqual(notices_daily.deliver_annual(self.db, on=jan10), 2)
        self.assertEqual({r.cycle for r in self.rows("annual")}, {str(TODAY.year)})
        self.assertEqual(notices_daily.deliver_annual(self.db, on=jan10), 0)

    def test_yearly_round_only_in_its_window(self):
        self.ver("ca-sb294", eff=date(TODAY.year, 1, 2))
        self.assertEqual(notices_daily.deliver_annual(self.db, on=date(TODAY.year, 3, 1)), 0)

    def test_separation_goes_to_personal_email(self):
        self.ver("ca-de2320")
        self.emp("gone@x.com", status="offboarded", personal="gone.home@gmail.com",
                 log=[{"to": "offboarded", "at": TODAY.isoformat()}])
        self.emp("longgone@x.com", status="offboarded", log=[{"to": "offboarded", "at": "2021-03-01"}])
        self.assertEqual(notices_daily.deliver_separation(self.db), 1)
        r = self.rows("separation")[0]
        self.assertEqual((r.email, r.sent_to), ("gone@x.com", "gone.home@gmail.com"))
        self.assertEqual(notices_daily.deliver_separation(self.db), 0)

    def test_hr_sends_an_event_notice(self):
        with self.assertRaises(HTTPException):                       # nothing approved yet
            rn.send_notice("ca-lc90", rn.SendIn(emails=["old@x.com"]), user={"email": CHARMI}, db=self.db)
        self.ver("ca-lc90")
        out = rn.send_notice("ca-lc90", rn.SendIn(emails=["old@x.com", "new@x.com"], note="Inspection notice received 10/22"),
                             user={"email": CHARMI}, db=self.db)
        self.assertEqual(out["sent"], 2)
        with self.assertRaises(HTTPException):
            rn.send_notice("ca-lc90", rn.SendIn(emails=["old@x.com"]), user={"email": "old@x.com"}, db=self.db)
        mine = rn.my_notices(user={"email": "old@x.com"}, db=self.db)
        self.assertEqual(mine["received"][0]["noticeId"], "ca-lc90")

    def test_emergency_contact(self):
        u = {"email": "old@x.com"}
        self.assertTrue(rn.my_emergency(user=u, db=self.db)["applies"])
        with self.assertRaises(HTTPException):
            rn.set_my_emergency(rn.EmergencyIn(choice="other", worksite=True), user=u, db=self.db)   # needs name + phone
        with self.assertRaises(HTTPException):
            rn.set_my_emergency(rn.EmergencyIn(choice="profile"), user=u, db=self.db)                # needs a when
        out = rn.set_my_emergency(rn.EmergencyIn(choice="profile", worksite=True), user=u, db=self.db)
        self.assertTrue(out["answered"])
        out = rn.set_my_emergency(rn.EmergencyIn(choice="decline"), user=u, db=self.db)
        row = self.db.get(models.WorkplaceNoticePerson, "old@x.com")
        self.assertEqual(row.sb294["choice"], "decline")
        self.assertEqual(row.sb294["history"][-1]["choice"], "profile")      # the earlier answer is kept

    def test_emergency_contact_is_california_only(self):
        self.db.add(models.HrWorkSite(id="tx", name="Houston", address="1 Main St, Houston, TX 77002"))
        self.db.commit()
        tx = self.emp("tx@x.com")
        tx.work_site_id = "tx"
        self.db.commit()
        self.assertFalse(rn.my_emergency(user={"email": "tx@x.com"}, db=self.db)["applies"])


if __name__ == "__main__":
    unittest.main()
