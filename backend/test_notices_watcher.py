"""
Workplace Notices watcher, calendar and Annual Notice Review (Neil, Oct 21
2026: auto update, but an internal check). A fake fetcher stands in for the
agencies; storage is an in-memory dict.

Run with: python -m unittest test_notices_watcher -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import date

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit  # noqa: E402

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402
import notices_watcher as nw  # noqa: E402
from routers import notices as rn  # noqa: E402

STORE = {}


class _Res:
    def __init__(self, ok, content=b"", text=""):
        self.is_success, self.content, self.text = ok, content, text


rn._storage_put = lambda b, p, d, c, upsert=False: STORE.__setitem__((b, p), d) or _Res(True)
rn._storage_fetch = lambda b, p, timeout=60: _Res((b, p) in STORE, STORE.get((b, p), b""))


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CHARMI, PRANSHU = "charmi@x.com", "pranshu@x.com"
WEB = {}


def fake(url):
    if url not in WEB:
        return 404, "text/html", b""
    v = WEB[url]
    if isinstance(v, Exception):
        raise v
    return 200, ("application/pdf" if v.startswith(b"%PDF") else "text/html"), v


class WatcherTests(unittest.TestCase):
    def setUp(self):
        WEB.clear()
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeSource,
                  models.WorkplaceNoticeEvent, models.WorkplaceNoticeReview, models.NexusSetting,
                  models.NexusNotification, models.NexusEmployee, models.HrEntity, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="co", name="Greens", country="US", hr_contact_email=CHARMI))
        self.db.add(models.NexusRole(email=PRANSHU, role="administrator"))
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="Charmi", last_name="Test", work_email=CHARMI,
                                         company="co", status="active", deleted_at=""))
        self.db.commit()
        notices.ensure_catalog(self.db)
        self.db.commit()
        self.n = self.db.get(models.WorkplaceNotice, "ca-mw")
        self.src = self.db.get(models.WorkplaceNoticeSource, "ca-mw")

    def check(self, on=None):
        r = nw.check_source(self.db, self.src, self.n, on=on or date(2026, 10, 22), fetcher=fake)
        self.db.commit()
        return r

    def pending(self):
        return [v for v in notices.versions_of(self.db, "ca-mw") if v.status == "in_review"]

    def hr_bells(self):
        return self.db.query(models.NexusNotification).filter_by(recipient=CHARMI, type="workplace_notice_hr").count()

    def test_first_sight_drafts_the_official_file(self):
        WEB[self.src.url] = b"%PDF-1.4 MW-2026"
        self.assertEqual(self.check(), "drafted")
        (v,) = self.pending()
        self.assertEqual(v.prepared_by, "watcher")
        self.assertEqual(self.hr_bells(), 1)
        self.assertEqual(self.check(), "same")
        self.assertEqual(len(self.pending()), 1)
        # one person approves it (the watcher prepared it), choosing the date
        rn.review_version(v.id, rn.ReviewIn(decision="approve", effective_date="2026-01-01"),
                          user={"email": CHARMI}, db=self.db)
        self.assertEqual(notices.live_version(self.db, "ca-mw").effective_date, "2026-01-01")

    def test_a_changed_pdf_waits_for_approval(self):
        WEB[self.src.url] = b"%PDF-1.4 v1"
        self.check()
        WEB[self.src.url] = b"%PDF-1.4 v2"
        self.assertEqual(self.check(), "drafted")
        self.assertEqual(len(self.pending()), 2)
        self.assertIsNone(notices.live_version(self.db, "ca-mw"))   # nothing published by the watcher

    def test_a_changed_page_alerts_without_a_draft(self):
        src = self.db.get(models.WorkplaceNoticeSource, "ca-eitc")
        n = self.db.get(models.WorkplaceNotice, "ca-eitc")
        WEB[src.url] = b"<html><script>x=1</script><p>EITC notice text</p></html>"
        self.assertEqual(nw.check_source(self.db, src, n, fetcher=fake), "baseline")
        WEB[src.url] = b"<html><script>x=2</script><p>EITC notice text</p></html>"     # only a script changed
        self.assertEqual(nw.check_source(self.db, src, n, fetcher=fake), "same")
        WEB[src.url] = b"<html><p>EITC notice text, revised</p></html>"
        self.assertEqual(nw.check_source(self.db, src, n, fetcher=fake), "changed")
        self.db.commit()
        self.assertFalse(notices.versions_of(self.db, "ca-eitc"))
        lib = {x["id"]: x for x in rn.library(user={"email": CHARMI}, db=self.db)["notices"]}
        self.assertEqual(lib["ca-eitc"]["state"], "needs_file")       # no file yet wins over the change

    def test_three_failures_alert_once(self):
        for _ in range(5):
            self.assertEqual(self.check(), "failed")
        self.assertEqual(self.src.fail_count, 5)
        self.assertEqual(self.hr_bells(), 1)

    def test_next_years_file_from_september(self):
        WEB[self.src.url] = b"%PDF-1.4 MW-2026"
        self.check(on=date(2026, 8, 1))
        WEB["https://www.dir.ca.gov/iwc/MW-2027.pdf"] = b"%PDF-1.4 MW-2027"
        self.assertEqual(self.check(on=date(2026, 8, 15)), "same")          # not before September
        self.assertEqual(self.check(on=date(2026, 9, 15)), "moved")
        self.assertEqual(self.src.url, "https://www.dir.ca.gov/iwc/MW-2027.pdf")
        self.assertEqual(self.n.source_url, "https://www.dir.ca.gov/iwc/MW-2027.pdf")
        self.assertEqual(len(self.pending()), 2)

    def test_recently_checked_sources_are_skipped(self):
        WEB[self.src.url] = b"%PDF-1.4 a"
        self.check()
        out = nw.run_watcher(fetcher=fake, pace=0)
        self.assertNotIn("drafted", out)       # ca-mw was checked minutes ago

    def test_calendar(self):
        items = {i["key"]: i for i in nw.calendar(self.db, 2026)}
        self.assertEqual(items["jan1-2026"]["date"], "2026-01-01")
        self.assertEqual(items["due-ca-sb294-2026"]["date"], "2026-02-01")
        self.assertEqual(items["vote-2026-11-03"]["date"], "2026-10-24")
        self.assertEqual(items["review-2027"]["date"], "2026-12-01")
        self.assertEqual(items["window-ca-300a-2026"]["date"], "2026-02-01")

    def test_annual_review(self):
        self.assertEqual(nw.review_pass(self.db, on=date(2026, 11, 30)), 0)
        self.assertGreaterEqual(nw.review_pass(self.db, on=date(2026, 12, 1)), 1)
        r = rn.get_review("2027", user={"email": CHARMI}, db=self.db)
        self.assertEqual(r["status"], "open")
        self.assertTrue(r["canSign"])
        with self.assertRaises(HTTPException):          # notices still need files: a reason is required
            rn.sign_review("2027", rn.SignIn(typed_name="Charmi Test"), user={"email": CHARMI}, db=self.db)
        with self.assertRaises(HTTPException):          # the typed name must be theirs
            rn.sign_review("2027", rn.SignIn(typed_name="Someone", note="x"), user={"email": CHARMI}, db=self.db)
        out = rn.sign_review("2027", rn.SignIn(typed_name="Charmi Test", note="Waiting on counsel for the manual"),
                             user={"email": CHARMI}, db=self.db)
        self.assertEqual(out["status"], "signed")
        self.assertTrue(out["items"])
        with self.assertRaises(HTTPException):
            rn.sign_review("2027", rn.SignIn(typed_name="Charmi Test", note="x"), user={"email": CHARMI}, db=self.db)


if __name__ == "__main__":
    unittest.main()
