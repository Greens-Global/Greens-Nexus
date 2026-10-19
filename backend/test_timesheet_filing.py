"""Retry filing a signed Time Sheet into Egnyte (Oct 20 2026): timesheet_filing.py.

  - a failed filing is retried after the backoff, not before, and stops once filed;
  - a filing that keeps failing stops after len(RETRY_AFTER_MIN) retries and
    tells the company's HR contact once;
  - nothing is retried while Egnyte is not connected, nor when it never failed.

On test_timesheet_review's real Nexus Sign fixture (its own throwaway database).

    python -m unittest test_timesheet_filing
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, HR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_filing as tf  # noqa: E402
from routers import esign  # noqa: E402
from services import egnyte as svc  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
