"""
Construction: telling people things, and cutting the weekly draft (Aug 2026).

The module had a full review workflow that notified nobody, and two cadence
fields (`report_day`, `week_starts_on`) that nothing read. Both failure modes
are silent by nature - a log sits unreviewed, a draft is never cut, and nothing
errors - so these tests assert the delivery itself, not just that the code runs.

The week arithmetic gets its own tests because it is the part that can be
confidently wrong: ConstructionProject counts 0=Sunday..6=Saturday and Python
counts Monday=0..Sunday=6, and inverting that cuts every draft on the wrong day
without ever raising.

Throwaway sqlite. No network: Graph is stubbed, and the report generator is
stubbed where a test is about scheduling rather than drafting.

Run with: python -m unittest test_construction_notify -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import date

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import construction_notify as notify
import construction_worker as worker
import database
import models

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


MANAGER = "neil@greensglobal.com"
WORKER = "sagar.shoundik@greensglobal.com"
EXEC = "investor@outside.example"


def _iso():
    return "2026-08-06T09:00:00+00:00"


class _Base(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.ConstructionProject, models.ConstructionDailyLog,
                  models.ConstructionWeeklyReport, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        self.project = models.ConstructionProject(
            id=str(uuid.uuid4()), name="Valley Center Phase 2", status="active",
            manager_emails=[MANAGER], worker_emails=[WORKER], executive_emails=[EXEC],
            week_starts_on=1, report_day=5, archived=False, deleted_at="",
            created_at=_iso(), modified_at=_iso())
        self.db.add(self.project)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _log(self, **kw):
        l = models.ConstructionDailyLog(
            id=str(uuid.uuid4()), project_id=self.project.id, author_email=WORKER,
            log_date=kw.get("log_date", "2026-08-05"), status=kw.get("status", "submitted"),
            review_note=kw.get("review_note", ""), reviewed_by=kw.get("reviewed_by", ""),
            created_at=_iso(), modified_at=_iso(), deleted_at="")
        self.db.add(l)
        self.db.commit()
        return l

    def _bells(self, recipient=None):
        q = self.db.query(models.NexusNotification)
        if recipient:
            q = q.filter(models.NexusNotification.recipient == recipient)
        return q.all()


class DailyLogNotificationTests(_Base):
    def test_submitting_a_log_tells_the_manager(self):
        notify.log_submitted(self.db, self.project, self._log())
        self.db.commit()
        bells = self._bells()
        self.assertEqual([b.recipient for b in bells], [MANAGER])
        self.assertIn("ready to review", bells[0].title)

    def test_a_manager_filing_their_own_log_is_not_told_about_it(self):
        l = self._log()
        l.author_email = MANAGER
        self.db.commit()
        notify.log_submitted(self.db, self.project, l)
        self.db.commit()
        self.assertEqual(self._bells(), [])

    def test_sending_a_log_back_delivers_the_managers_question(self):
        """The point of the whole change: review_note was written to the row and
        shown to nobody, so the one person who could answer never saw it."""
        l = self._log(status="needs_info", reviewed_by=MANAGER,
                      review_note="Which elevation is the crack on?")
        notify.log_reviewed(self.db, self.project, l)
        self.db.commit()
        bells = self._bells()
        self.assertEqual([b.recipient for b in bells], [WORKER])
        self.assertIn("Which elevation is the crack on?", bells[0].body)

    def test_a_send_back_with_no_note_still_says_something_useful(self):
        l = self._log(status="needs_info", reviewed_by=MANAGER, review_note="")
        notify.log_reviewed(self.db, self.project, l)
        self.db.commit()
        self.assertIn("more detail", self._bells()[0].body)

    def test_approval_tells_the_worker(self):
        l = self._log(status="approved", reviewed_by=MANAGER)
        notify.log_reviewed(self.db, self.project, l)
        self.db.commit()
        bells = self._bells()
        self.assertEqual([b.recipient for b in bells], [WORKER])
        self.assertIn("approved", bells[0].title.lower())

    def test_a_log_with_no_author_notifies_nobody_rather_than_everybody(self):
        """A blank recipient on nexus_notifications broadcasts to every manager
        in the company (CLAUDE.md). This module never wants that."""
        l = self._log(status="approved")
        l.author_email = ""
        notify.log_reviewed(self.db, self.project, l)
        self.db.commit()
        self.assertEqual(self._bells(), [])

    def test_the_bell_links_back_to_the_jobsite_dashboard(self):
        notify.log_submitted(self.db, self.project, self._log())
        self.db.commit()
        self.assertIn('"sub": "construction-dashboard"', self._bells()[0].action)


class PublishedReportTests(_Base):
    def setUp(self):
        super().setUp()
        self.sent = []
        self._real = notify.graph_mail.send_mail
        notify.graph_mail.send_mail = lambda **kw: self.sent.append(kw) or {"messageId": "m"}
        notify.graph_mail.DEFAULT_FROM_EMAIL = "nexus@greensglobal.com"

    def tearDown(self):
        notify.graph_mail.send_mail = self._real
        super().tearDown()

    def _report(self):
        r = models.ConstructionWeeklyReport(
            id=str(uuid.uuid4()), project_id=self.project.id, week_start="2026-08-03",
            week_end="2026-08-09", title="Slab poured on the east wing",
            status="published", version=1, created_at=_iso(), modified_at=_iso(),
            deleted_at="")
        self.db.add(r)
        self.db.commit()
        return r

    def test_publishing_emails_the_executives_with_the_pdf_attached(self):
        """A link is useless to an external investor - the report endpoint is
        authenticated, so the document itself has to travel."""
        err = notify.report_published(self.db, self.project, self._report(), b"%PDF-1.4 fake")
        self.assertEqual(err, "")
        self.assertEqual(self.sent[0]["to"], [EXEC])
        name, ctype, raw = self.sent[0]["attachments"][0]
        self.assertTrue(name.endswith(".pdf"))
        self.assertEqual(ctype, "application/pdf")
        self.assertEqual(raw, b"%PDF-1.4 fake")

    def test_an_oversized_pdf_is_linked_instead_of_attached(self):
        big = b"x" * (notify.MAX_ATTACH_BYTES + 1)
        notify.report_published(self.db, self.project, self._report(), big)
        self.assertIsNone(self.sent[0].get("attachments"))
        self.assertIn("too large to attach", self.sent[0]["html"])

    def test_a_project_with_no_executives_is_not_an_error(self):
        self.project.executive_emails = []
        self.db.commit()
        err = notify.report_published(self.db, self.project, self._report(), b"pdf")
        self.assertIn("no executive recipients", err)
        self.assertEqual(self.sent, [])

    def test_a_mail_failure_is_reported_to_the_managers_not_swallowed(self):
        """The report is published either way. What must not happen is everyone
        believing the executives received it."""
        def boom(**kw):
            raise RuntimeError("mailbox unreachable")
        notify.graph_mail.send_mail = boom
        err = notify.report_published(self.db, self.project, self._report(), b"pdf")
        self.db.commit()
        self.assertIn("mailbox unreachable", err)
        mgr = self._bells(MANAGER)
        self.assertIn("email failed", mgr[0].body)


class WeekArithmeticTests(unittest.TestCase):
    # 2026-08-06 is a Thursday.
    THU = date(2026, 8, 6)

    def test_the_model_and_python_weekday_numbering_are_reconciled(self):
        self.assertEqual(worker._model_weekday(date(2026, 8, 2)), 0)   # Sunday
        self.assertEqual(worker._model_weekday(date(2026, 8, 3)), 1)   # Monday
        self.assertEqual(worker._model_weekday(date(2026, 8, 8)), 6)   # Saturday

    def test_a_monday_week_starts_on_the_monday(self):
        self.assertEqual(worker.week_start_for(self.THU, 1), date(2026, 8, 3))

    def test_a_sunday_week_starts_on_the_sunday(self):
        """Crews on different sites run Sun-Sat or Mon-Sun; the report has to
        line up with the payroll week the superintendent thinks in."""
        self.assertEqual(worker.week_start_for(self.THU, 0), date(2026, 8, 2))

    def test_the_first_day_of_the_week_is_its_own_week_start(self):
        self.assertEqual(worker.week_start_for(date(2026, 8, 3), 1), date(2026, 8, 3))


class DraftSchedulerTests(_Base):
    def setUp(self):
        super().setUp()
        self.drafted = []
        self._real_gen = None
        import construction_report
        self._real_gen = construction_report.generate

        def fake_generate(db, project, week_start, actor):
            self.drafted.append((project.id, week_start, actor))
            r = models.ConstructionWeeklyReport(
                id=str(uuid.uuid4()), project_id=project.id, week_start=week_start,
                week_end="", title="draft", status="draft", version=1,
                created_at=_iso(), modified_at=_iso(), deleted_at="")
            db.add(r)
            db.flush()
            return r
        construction_report.generate = fake_generate
        self.construction_report = construction_report

    def tearDown(self):
        self.construction_report.generate = self._real_gen
        super().tearDown()

    FRI = date(2026, 8, 7)      # report_day 5 = Friday
    THU = date(2026, 8, 6)

    def test_a_draft_is_cut_on_the_projects_report_day(self):
        counts = worker.cut_due_drafts(self.FRI)
        self.assertEqual(counts["cut"], 1)
        self.assertEqual(self.drafted[0][1], "2026-08-03")   # the Monday of that week

    def test_nothing_is_cut_on_any_other_day(self):
        self.assertEqual(worker.cut_due_drafts(self.THU)["cut"], 0)
        self.assertEqual(self.drafted, [])

    def test_running_twice_on_the_same_day_drafts_once(self):
        """Idempotent by existence rather than by a timestamp, so a restart or a
        second tick is safe with no extra state to keep correct."""
        worker.cut_due_drafts(self.FRI)
        counts = worker.cut_due_drafts(self.FRI)
        self.assertEqual((counts["cut"], counts["skipped"]), (0, 1))
        self.assertEqual(len(self.drafted), 1)

    def test_a_report_a_manager_already_drafted_is_left_alone(self):
        self.db.add(models.ConstructionWeeklyReport(
            id=str(uuid.uuid4()), project_id=self.project.id, week_start="2026-08-03",
            status="published", version=2, created_at=_iso(), modified_at=_iso(),
            deleted_at=""))
        self.db.commit()
        self.assertEqual(worker.cut_due_drafts(self.FRI)["skipped"], 1)
        self.assertEqual(self.drafted, [])

    def test_archived_and_inactive_jobsites_are_skipped(self):
        self.project.status = "complete"
        self.db.commit()
        self.assertEqual(worker.cut_due_drafts(self.FRI)["cut"], 0)

    def test_one_failing_project_does_not_stop_the_others(self):
        other = models.ConstructionProject(
            id=str(uuid.uuid4()), name="Harbor View", status="active",
            manager_emails=[MANAGER], executive_emails=[], week_starts_on=1,
            report_day=5, archived=False, deleted_at="", created_at=_iso(),
            modified_at=_iso())
        self.db.add(other)
        self.db.commit()
        first = {"done": False}

        def half_broken(db, project, week_start, actor):
            if not first["done"]:
                first["done"] = True
                raise RuntimeError("model timeout")
            self.drafted.append((project.id, week_start, actor))
            r = models.ConstructionWeeklyReport(
                id=str(uuid.uuid4()), project_id=project.id, week_start=week_start,
                status="draft", version=1, created_at=_iso(), modified_at=_iso(),
                deleted_at="")
            db.add(r)
            db.flush()
            return r
        self.construction_report.generate = half_broken

        counts = worker.cut_due_drafts(self.FRI)
        self.assertEqual((counts["cut"], counts["failed"]), (1, 1))

    def test_the_managers_are_told_the_draft_is_waiting(self):
        worker.cut_due_drafts(self.FRI)
        bells = self.db.query(models.NexusNotification).filter(
            models.NexusNotification.recipient == MANAGER).all()
        self.assertTrue(any("drafted" in b.title.lower() for b in bells))


if __name__ == "__main__":
    unittest.main()
