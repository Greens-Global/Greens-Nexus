"""
Workplace Notices coverage and the audit record: who still owes what, who
was not given their at-hire notices, the CSV record for one person / one
notice / every version, US date formats in it, and every export logged.

Throwaway sqlite. Run with: python -m unittest test_notices_coverage -v
"""
import csv
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

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402
from routers import notices as rn  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CHARMI = "charmi@x.com"
HR = {"email": CHARMI}


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeDelivery,
                  models.WorkplaceNoticeEvent, models.WorkplaceNoticePerson, models.WorkplaceNoticeSite,
                  models.NexusSetting, models.NexusEmployee, models.HrEntity, models.HrWorkSite):
            self.db.query(m).delete()
        self.db.add_all([models.HrEntity(id="co", name="Greens", country="US", hr_contact_email=CHARMI),
                         models.HrWorkSite(id="s", name="Escondido", address="1 A St, Escondido, CA 92026")])
        self.db.commit()
        notices.ensure_catalog(self.db)
        notices.save_settings(self.db, "x", {"hireSince": (date.today() - timedelta(days=10)).isoformat()})
        for em, start in (("amy@x.com", date.today().isoformat()), ("old@x.com", "2020-01-06")):
            self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name=em[:3].title(), last_name="Test", work_email=em,
                                             company="co", work_site_id="s", status="active", start_date=start, deleted_at=""))
        for nid in ("manual-core", "ca-dwc-hire"):
            self.db.add(models.WorkplaceNoticeVersion(id=f"{nid}-1", notice_id=nid, number=1, status="approved", label="v1",
                                                      effective_date=(date.today() - timedelta(days=30)).isoformat(),
                                                      prepared_by="watcher", approved_by=CHARMI,
                                                      files=[{"lang": "en", "path": "p", "sha256": "abc123"}]))
        self.db.add(models.WorkplaceNoticeDelivery(id="d1", notice_id="manual-core", version_id="manual-core-1",
                                                   email="old@x.com", reason="acknowledge", channel="portal",
                                                   sent_at="2026-10-01T15:30:00+00:00", acknowledged_at="2026-10-01T15:30:00+00:00",
                                                   typed_name="Old Test", ip="10.0.0.1", content_hash="abc123"))
        self.db.commit()

    def test_coverage(self):
        out = rn.coverage(user=HR, db=self.db)
        people = {p["email"]: p for p in out["people"]}
        self.assertEqual([o["title"] for o in people["amy@x.com"]["owed"]], ["Greens Employee Manual"])
        self.assertEqual(people["amy@x.com"]["notGiven"], ["Workers' Comp Time of Hire Notice"])
        self.assertEqual(people["old@x.com"]["owed"], [])
        self.assertEqual(people["old@x.com"]["notGiven"], [])       # onboarded before the module
        self.assertEqual(people["amy@x.com"]["emergency"], "open")    # California: SB 294 question
        self.assertEqual(out["totals"]["owing"], 1)
        with self.assertRaises(HTTPException):
            rn.coverage(user={"email": "amy@x.com"}, db=self.db)

    def test_person_record(self):
        resp = rn.export_person("old@x.com", user=HR, db=self.db)
        rows = list(csv.reader(io.StringIO(resp.body.decode())))
        self.assertEqual(rows[0][0], "Person")
        rec = dict(zip(rows[0], rows[1]))
        self.assertEqual(rec["Notice"], "Greens Employee Manual")
        self.assertEqual(rec["Acknowledged"], "10/01/2026 03:30 PM UTC")
        self.assertEqual(rec["File Fingerprint (SHA-256)"], "abc123")
        self.assertEqual(self.db.query(models.WorkplaceNoticeEvent).filter_by(action="exported").count(), 1)

    def test_notice_and_versions_records(self):
        rows = list(csv.reader(io.StringIO(rn.export_notice("manual-core", user=HR, db=self.db).body.decode())))
        self.assertEqual(len(rows), 2)
        vrows = list(csv.reader(io.StringIO(rn.export_versions(user=HR, db=self.db).body.decode())))
        hdr = vrows[0]
        mc = next(dict(zip(hdr, r)) for r in vrows[1:] if r[0] == "Greens Employee Manual")
        self.assertEqual(mc["Files (language:SHA-256)"], "en:abc123")
        self.assertEqual(mc["Prepared By"], "watcher")


if __name__ == "__main__":
    unittest.main()
