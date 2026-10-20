"""Retry filing a signed Time Sheet into Egnyte (Oct 20 2026): timesheet_filing.py.

  - a failed filing is retried after the backoff, not before, and stops once filed;
  - a filing that keeps failing stops after len(RETRY_AFTER_MIN) retries and
    tells the company's HR contact once;
  - nothing is retried while Egnyte is not connected, nor when it never failed;
  - (Oct 20) it is filed in <person>/Timesheets & Attendance (an existing
    Timesheets folder keeps being used) as
    'YYYY-MM-DD - <Name> Time Sheet - MM-DD-YYYY to MM-DD-YYYY (signed) - <id8>.pdf'.

On test_timesheet_review's real Nexus Sign fixture (its own throwaway database).

    python -m unittest test_timesheet_filing
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, HR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import egnyte_wiring  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
import timesheet_filing as tf  # noqa: E402
from routers import esign  # noqa: E402
from services import egnyte as svc  # noqa: E402

_REAL_PUSH = esign._egnyte_push      # FilingRetryTests stubs it per test
HR_ROOT = "/Shared/#Entities/Greens Test Co/Human Resources"
ERIN = f"{HR_ROOT}/Employees/Erin Test"


def _later(minutes):
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


class FilingRetryTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.HrSignEvent).delete()
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        self._cfg = svc.configured
        svc.configured = lambda: True
        self.pushes = []
        self.ok = False
        esign._egnyte_push = self._push

    def tearDown(self):
        svc.configured = self._cfg
        super().tearDown()

    def _push(self, db, req, blob):
        self.pushes.append(len(blob))
        return (True, "filed in Egnyte /Shared/HR/Erin Test/Timesheets/x.pdf") if self.ok \
            else (False, "Egnyte copy failed (ReadTimeout)")

    def _signed(self):
        r = self._to_signing()
        rid = r.sign_request_id
        self._sign(self._parties(rid)["employee"])
        self.assertEqual(self._r().status, "completed")
        return rid

    def _events(self, rid):
        self.db.expire_all()
        return [(e.type, e.detail) for e in self.db.query(models.HrSignEvent)
                .filter(models.HrSignEvent.request_id == rid,
                        models.HrSignEvent.type.in_(("archived", "archive_failed", tf.GAVE_UP)))
                .order_by(models.HrSignEvent.seq)]

    def test_retried_after_the_backoff_then_filed(self):
        rid = self._signed()
        self.assertEqual(self._events(rid), [("archive_failed", "Egnyte copy failed (ReadTimeout)")])
        self.assertEqual(tf.process_due(_later(1), self.db), {"filed": 0, "failed": 0, "gave_up": 0})
        self.ok = True
        self.assertEqual(tf.process_due(_later(6), self.db)["filed"], 1)
        self.assertGreater(self.pushes[-1], 1000)              # the sealed PDF itself
        self.assertEqual(self._events(rid)[-1][0], "archived")
        self.assertTrue(self._events(rid)[-1][1].startswith("Retry 1: filed in Egnyte"))
        n = len(self.pushes)
        tf.process_due(_later(500), self.db)                   # filed: never again
        self.assertEqual(len(self.pushes), n)

    def test_gives_up_after_the_last_retry_and_tells_hr_once(self):
        rid = self._signed()
        for minutes in (6, 40, 130):
            self.assertEqual(tf.process_due(_later(minutes), self.db)["failed"], 1)
        self.assertEqual(tf.process_due(_later(400), self.db)["gave_up"], 1)
        self.assertEqual(tf.process_due(_later(900), self.db), {"filed": 0, "failed": 0, "gave_up": 0})
        self.assertEqual([t for t, _d in self._events(rid)],
                         ["archive_failed"] * 4 + [tf.GAVE_UP])
        self.db.expire_all()
        (bell,) = self.db.query(models.NexusNotification).filter_by(recipient=HR).filter(
            models.NexusNotification.ref_id == f"ts_filing:{rid}").all()
        self.assertEqual(bell.title, "Time Sheet Not Filed in Egnyte")
        self.assertIn("file it by hand", bell.body)

    def test_nothing_while_egnyte_is_not_connected(self):
        rid = self._signed()
        svc.configured = lambda: False
        n = len(self.pushes)
        self.assertEqual(tf.process_due(_later(60), self.db), {"filed": 0, "failed": 0, "gave_up": 0})
        self.assertEqual(len(self.pushes), n)
        self.assertEqual(len(self._events(rid)), 1)

    def test_a_filing_that_never_failed_is_left_alone(self):
        self.ok = True
        rid = self._signed()
        n = len(self.pushes)
        tf.process_due(_later(60), self.db)
        self.assertEqual(len(self.pushes), n)
        self.assertEqual(self._events(rid)[0][0], "archived")


class FolderAndNameTests(ReviewCase):
    """Neil, Oct 20: <Company>/Human Resources/Employees/<Name>/Timesheets &
    Attendance, named for the day the employee signed and the period."""

    def setUp(self):
        super().setUp()
        self.tree = {"/": ["Shared"], "/Shared": ["#Entities"], "/Shared/#Entities": ["Greens Test Co"],
                     "/Shared/#Entities/Greens Test Co": ["Human Resources"],
                     HR_ROOT: ["Contractors", "Employees"], f"{HR_ROOT}/Employees": ["Erin Test"],
                     ERIN: ["Confidential", "Contractor Documents"]}
        self.uploads = []
        self._real = [(svc, "configured", svc.configured), (svc, "create_folder", svc.create_folder),
                      (svc, "upload_file", svc.upload_file),
                      (egnyte_wiring, "_list_children", egnyte_wiring._list_children)]
        svc.configured = lambda: True
        svc.create_folder = lambda path, token=None: {}
        svc.upload_file = lambda path, content, token=None: self.uploads.append(path) or {}
        egnyte_wiring._list_children = lambda parent: self.tree.get(svc.norm(parent or "/"))

    def tearDown(self):
        for obj, name, real in self._real:
            setattr(obj, name, real)
        super().tearDown()

    def _req(self):
        r = self._to_signing()
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        req.completed_at = "2026-10-20T05:30:00+00:00"
        return req

    def _name(self, req, day="2026-10-20"):
        span = f"{tsr.us_date(self.start)} to {tsr.us_date(self.end)}".replace("/", "-")
        return f"{day} - Erin Test Time Sheet - {span} (signed) - {req.id[:8]}.pdf"

    def test_a_new_person_folder_gets_timesheets_and_attendance(self):
        self.assertEqual(tsr.egnyte_folder(self.db, self._req()), f"{ERIN}/Timesheets & Attendance")

    def test_an_existing_timesheets_folder_keeps_being_used(self):
        self.tree[ERIN].append("Timesheets")
        self.assertEqual(tsr.egnyte_folder(self.db, self._req()), f"{ERIN}/Timesheets")

    def test_timesheets_and_attendance_wins_when_both_exist(self):
        self.tree[ERIN] += ["Timesheets", "timesheets & attendance"]
        self.assertEqual(tsr.egnyte_folder(self.db, self._req()), f"{ERIN}/timesheets & attendance")

    def test_the_file_name(self):
        req = self._req()
        name = tsr.egnyte_filename(self.db, req)
        self.assertEqual(name, self._name(req))
        self.assertNotIn("/", name)

    def test_the_signing_day_is_the_employees_own(self):
        for p in self.db.query(models.TimePunch).all():
            p.tz_offset_min = 420                  # Pacific: 05:30 UTC is still the 19th
        req = self._req()
        self.assertEqual(tsr.egnyte_filename(self.db, req), self._name(req, "2026-10-19"))

    def test_filed_there_under_that_name_with_the_path_encoded(self):
        req = self._req()
        ok, note = _REAL_PUSH(self.db, req, b"%PDF-1.4")
        target = f"{ERIN}/Timesheets & Attendance/{self._name(req)}"
        self.assertEqual((ok, self.uploads), (True, [target]))
        self.assertEqual(note, f"filed in Egnyte {target}")
        self.assertIn("/%23Entities/", svc._url_path(target))
        self.assertIn("/Timesheets%20%26%20Attendance/", svc._url_path(target))

    def test_other_envelopes_keep_the_generic_name(self):
        req = self._req()
        req.link_kind, req.egnyte_folder = "", "/Shared/Signed"
        _REAL_PUSH(self.db, req, b"%PDF-1.4")
        (path,) = self.uploads
        self.assertTrue(path.startswith("/Shared/Signed/Time Sheet - Erin Test - "), path)
        self.assertTrue(path.endswith(f" - {req.id[:8]} (signed).pdf"), path)

    def test_my_documents_shows_the_folder_to_the_employee(self):
        self.assertFalse(egnyte_wiring.is_excluded_child("Timesheets & Attendance"))
        self.assertTrue(egnyte_wiring.is_excluded_child("Confidential"))


if __name__ == "__main__":
    unittest.main()
