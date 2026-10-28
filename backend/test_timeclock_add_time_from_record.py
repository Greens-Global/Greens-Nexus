"""Add Time From Record (Neil, Oct 27 2026): HR keys in a time sheet that was
kept outside Nexus - a template day laid over a range of up to 62 days, then
one row per day, each editable on its own (times, breaks, Sick Day / Vacation,
Off, Skip, Replace). HR only (hr_access.is_hr_for), every row judged by the
existing day-state / lock / overlap / punch-order rules with a dry run first,
one reason and an optional source document per batch, a source tag on every
punch (card, PDF, audit), one Undo for the batch, one notice to the employee.

Run with: python -m pytest test_timeclock_add_time_from_record.py
"""
import io
import json
import os
import tempfile
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException, UploadFile  # noqa: E402
from starlette.datastructures import Headers  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import scoped_settings  # noqa: E402
import timesheet_pdf  # noqa: E402
import timesheet_review  # noqa: E402
from routers import timeclock as T  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}. Run it on its own.")


_assert_isolated()

CO, CO_IN, CO_OTHER = "co-rec", "co-rec-in", "co-rec-other"
HR = "hr.rec@greensglobal.com"            # the HR contact of both companies (People Editor grant)
HR_USER = {"email": HR, "level": 2}
ADMIN = "admin.rec@greensglobal.com"      # a Global Admin
ADMIN_USER = {"email": ADMIN, "level": 4}
FULL = "full.rec@greensglobal.com"        # a Full People grant, unscoped
FULL_USER = {"email": FULL, "level": 2}
OUT = "out.rec@greensglobal.com"          # a Full People grant scoped to another company
OUT_USER = {"email": OUT, "level": 2}
MGR = "mgr.rec@greensglobal.com"          # Dean's manager - not HR
MGR_USER = {"email": MGR, "level": 3}
EMP = "dean.rec@greensglobal.com"
EMP_USER = {"email": EMP, "level": 1}
PEER = "pat.rec@greensglobal.com"         # an employee looking at a coworker
PEER_USER = {"email": PEER, "level": 1}
IND = "ira.rec@greensglobal.com"          # an India contractor on fixed pay
TZ = 420                                  # Pacific (PDT)
TZ_IN = -330                              # India
REASON = "Paper time sheet for September - entered by HR"
# Two pay periods: 09/06 - 09/19 and 09/20 - 10/03 (all past).
P1 = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]   # Mon - Fri
P2 = ["2026-09-21", "2026-09-22", "2026-09-23"]                               # Mon - Wed


def _utc(ds, hhmm, tz=TZ):
    """A wall time on `ds` in the zone `tz` (JS offset) as stored UTC."""
    t = datetime.fromisoformat(f"{ds}T{hhmm}:00") + timedelta(minutes=tz)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


def row(ds, in_h="08:30", out_h="17:00", breaks=(("12:00", "12:30"),), tz=TZ, **kw):
    return T.RecordRow(date=ds, in_at=_utc(ds, in_h, tz), out_at=_utc(ds, out_h, tz), tz_offset_min=tz,
                       breaks=[T.DupBreak(start_at=_utc(ds, a, tz), end_at=_utc(ds, b, tz)) for a, b in breaks], **kw)


class AddTimeFromRecordTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        auth.invalidate_role_cache()
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.TimeApproval, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.ScheduledShift, models.ShiftAssignment, models.Shift, models.HrEntity, models.NexusRole,
                  models.PunchRequest, models.TimeEntryBatch, models.TimesheetReview, models.HrSignRequest,
                  models.NexusNotification, models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
                  models.PayrollRate, models.NexusSetting, models.AuditLog):
            self.db.query(m).delete()
        self.db.query(models.NexusEmployee).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Rec", country="US", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO_IN, name="Greens India", country="IN", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO_OTHER, name="Other Co", country="US"))
        for i, (em, first, co, extra) in enumerate([
                (EMP, "Dean", CO, {"manager_email": MGR}), (HR, "Hana", CO, {}), (PEER, "Pat", CO, {"manager_email": MGR}),
                (MGR, "Mo", CO, {}), (FULL, "Fay", CO, {}), (OUT, "Ola", CO_OTHER, {}),
                (IND, "Ira", CO_IN, {"employment_type": "contractor"})]):
            self.db.add(models.NexusEmployee(id=f"e-rec-{i}", first_name=first, last_name="Test", work_email=em,
                                             company=co, country="IN" if co == CO_IN else "US", status="active",
                                             deleted_at="", **extra))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator"))
        # The HR contact holds People Editor for their company (how they open a card at all).
        self.db.add(models.NexusGroup(id="g-rec-hr", name="HR Editors", allowed_modules="hr:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-rec-hr", email=HR))
        self.db.add(models.NexusAccessScope(id="s-rec-hr", email=HR, module_id="hr", scope_type="entity", scope_id=CO))
        self.db.add(models.NexusAccessScope(id="s-rec-hr2", email=HR, module_id="hr", scope_type="entity", scope_id=CO_IN))
        self.db.add(models.NexusGroup(id="g-rec-full", name="HR Full", allowed_modules="hr:full"))
        self.db.add(models.NexusGroupMember(group_id="g-rec-full", email=FULL))
        self.db.add(models.NexusGroupMember(group_id="g-rec-full", email=OUT))
        self.db.add(models.NexusAccessScope(id="s-rec-out", email=OUT, module_id="hr", scope_type="entity",
                                            scope_id=CO_OTHER))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.close()

    # -- helpers ---------------------------------------------------------------
    def _rec(self, rows, user=HR_USER, em=EMP, start=P1[0], end=P2[-1], **kw):
        kw.setdefault("reason", REASON)
        return T.duplicate_day(T.DuplicateDayIn(employee_email=em, rows=rows, start=start, end=end, **kw),
                               user=user, db=self.db)

    def _live(self, ds=None, em=EMP):
        q = self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == em, models.TimePunch.voided == 0)
        if ds:
            q = q.filter(models.TimePunch.local_date == ds)
        return q.order_by(models.TimePunch.at).all()

    def _punch(self, ds, kind, at, tz=TZ, em=EMP, **kw):
        self.db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=em, kind=kind, at=at, local_date=ds,
                                     tz_offset_min=tz, voided=0, created_at=at, **kw))

    def _status(self, code, fn, *a, **kw):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **kw)
        self.assertEqual(e.exception.status_code, code, e.exception.detail)
        return e.exception.detail

    # -- who may ---------------------------------------------------------------
    def test_hr_contact_global_admin_and_full_hr_may(self):
        for who in (HR_USER, ADMIN_USER, FULL_USER):
            res = self._rec([row(P1[0])], user=who, dry_run=True)
            self.assertEqual(res["days"][0]["action"], "add", who)
            days = T.record_days(EMP, P1[0], P1[-1], user=who, db=self.db)
            self.assertEqual(len(days["days"]), 5)

    def test_manager_employee_own_card_and_out_of_scope_hr_are_refused(self):
        for who in (MGR_USER, EMP_USER, PEER_USER, OUT_USER):
            for dry in (True, False):
                self._status(403, self._rec, [row(P1[0])], user=who, dry_run=dry)
            self._status(403, T.record_days, EMP, P1[0], P1[-1], user=who, db=self.db)
        self._status(403, self._rec, [row(P1[0])], em=HR, dry_run=True)        # HR on their own card
        self._status(403, self._rec, [row(P1[0])], user=ADMIN_USER, em=ADMIN, dry_run=True)
        self.assertEqual(self._live(), [])

    def test_reason_and_62_day_cap(self):
        self._status(400, self._rec, [row(P1[0])], reason="  ")
        end = (date.fromisoformat(P1[0]) + timedelta(days=62)).isoformat()
        self.assertIn("62 days", self._status(400, self._rec, [row(P1[0])], end=end, dry_run=True))
        ok = (date.fromisoformat(P1[0]) + timedelta(days=61)).isoformat()
        self.assertEqual(self._rec([row(P1[0])], end=ok, dry_run=True)["added"], 1)
        self._status(400, T.record_days, EMP, P1[0], end, user=HR_USER, db=self.db)
        # A row outside the range, or a day twice, is a bad request.
        self._status(400, self._rec, [row("2026-08-01")], dry_run=True)
        self._status(400, self._rec, [row(P1[0]), row(P1[0])], dry_run=True)

    # -- the grid: preview, per-row overrides, write ---------------------------
    def test_range_across_two_pay_periods_with_per_row_overrides(self):
        rows = [row(P1[3]),                                            # the template day
                row(P1[4], "09:00", "13:00", breaks=()),               # custom times
                row(P2[0], "08:00", "16:00", breaks=(), category="Sick Day"),
                row(P2[1], "08:00", "16:00", breaks=(), category="Vacation"),
                row(P2[2], "07:00", "18:00", breaks=(("10:00", "10:15"), ("12:00", "12:45"))),
                T.RecordRow(date=P1[2], kind="off")]                    # Off, nothing on the day
        plan = self._rec(rows, dry_run=True)
        self.assertTrue(plan["dryRun"])
        got = {d["date"]: (d["action"], d["minutes"]) for d in plan["days"]}
        self.assertEqual(got, {P1[3]: ("add", 480), P1[4]: ("add", 240), P2[0]: ("add", 480),
                               P2[1]: ("add", 480), P2[2]: ("add", 600), P1[2]: ("off", 0)})
        self.assertEqual(self._live(), [])
        res = self._rec(rows)
        self.assertTrue(res["batchId"].startswith("dup-"))
        self.assertEqual((res["added"], res["totalMin"]), (5, 2280))
        self.assertEqual([(p.kind, p.category) for p in self._live(P2[0])], [("in", "Sick Day"), ("out", "")])
        self.assertEqual(len(self._live(P2[2])), 6)   # in, two breaks, out
        self.assertEqual(self._live(P1[2]), [])
        card = T._compute_timecard(self.db, EMP, "2026-09-20", "2026-10-03")
        days = {d["date"]: d for d in card["days"]}
        self.assertEqual(card["totals"].get("sickMin"), 480)
        self.assertEqual(card["totals"].get("vacationMin"), 480)
        self.assertEqual(days[P2[2]]["workedMin"], 600)
        # Both pay periods carry the batch; one batch row, one reason.
        b = self.db.query(models.TimeEntryBatch).one()
        self.assertEqual((b.id, b.range_start, b.range_end, b.reason, b.created_by),
                         (res["batchId"], P1[0], P2[-1], REASON, HR))
        self.assertEqual(sorted(b.days), sorted([P1[3], P1[4], P2[0], P2[1], P2[2]]))

    def test_existing_punches_skip_unless_replace_and_off_clears(self):
        for ds in (P1[0], P1[1]):
            self._punch(ds, "in", _utc(ds, "10:00"))
            self._punch(ds, "out", _utc(ds, "14:00"))
        self.db.commit()
        old = {p.id for p in self._live(P1[0])}
        plan = self._rec([row(P1[0]), T.RecordRow(date=P1[1], kind="off")], dry_run=True)
        by = {d["date"]: d for d in plan["days"]}
        self.assertEqual((by[P1[0]]["action"], by[P1[0]]["existingMin"]), ("skip", 240))
        self.assertIn("Replace", by[P1[0]]["reason"])
        self.assertEqual(by[P1[1]]["action"], "skip")
        res = self._rec([row(P1[0], replace=True), T.RecordRow(date=P1[1], kind="off", replace=True)])
        by = {d["date"]: d for d in res["days"]}
        self.assertEqual((by[P1[0]]["action"], by[P1[0]]["replaces"]), ("replace", 2))
        self.assertEqual((by[P1[1]]["action"], res["cleared"]), ("clear", 1))
        self.assertEqual(self._live(P1[1]), [])
        self.assertEqual(len(self._live(P1[0])), 4)
        gone = self.db.query(models.TimePunch).filter(models.TimePunch.id.in_(old)).all()
        self.assertTrue(all(p.voided == 1 and p.replaced_by_batch == res["batchId"] for p in gone))
        # One Undo takes the whole batch back, the cleared day included - HR's only.
        self._status(403, T.duplicate_day_undo, res["batchId"], user=MGR_USER, db=self.db)
        out = T.duplicate_day_undo(res["batchId"], user=HR_USER, db=self.db)
        self.assertEqual((out["voided"], out["restored"]), (4, 4))
        self.assertEqual({p.id for p in self._live(P1[0])}, old)
        self.assertEqual(len(self._live(P1[1])), 2)
        b = self.db.query(models.TimeEntryBatch).one()
        self.assertEqual(b.undone_by, HR)

    def test_finalized_period_refused_per_row_and_pending_fix_not_replaceable(self):
        self.db.add(models.TimeApproval(id="f-rec", employee_email=EMP, kind="final", period_start="2026-09-06",
                                        period_end="2026-09-19", revoked=0))
        self._punch(P2[1], "in", _utc(P2[1], "10:00"))
        self._punch(P2[1], "out", _utc(P2[1], "14:00"))
        self.db.add(models.PunchRequest(id="pr-rec", employee_email=EMP, action="add", punch_kind="in",
                                        at=_utc(P2[1], "09:00"), local_date=P2[1], status="pending"))
        self.db.commit()
        res = self._rec([row(P1[3]), row(P2[0]), row(P2[1], replace=True)])
        by = {d["date"]: d for d in res["days"]}
        self.assertEqual(by[P1[3]]["action"], "skip")
        self.assertIn("finalized", by[P1[3]]["reason"].lower())
        self.assertEqual(by[P2[0]]["action"], "add")
        self.assertEqual(by[P2[1]]["action"], "skip")
        self.assertIn("punch fix request", by[P2[1]]["reason"])
        self.assertEqual(self._live(P1[3]), [])
        # The grid reads the lock and the pending fix before anything is tried.
        days = {d["date"]: d for d in T.record_days(EMP, P1[0], P2[-1], user=HR_USER, db=self.db)["days"]}
        self.assertIn("finalized", days[P1[3]]["locked"].lower())
        self.assertTrue(days[P2[1]]["pendingFix"])
        self.assertEqual([p["kind"] for s in days[P2[1]]["shifts"] for p in s["punches"]], ["in", "out"])

    def test_future_days_are_never_written(self):
        today = T._employee_today(self.db, EMP)
        tomorrow = (date.fromisoformat(today) + timedelta(days=1)).isoformat()
        res = self._rec([row(tomorrow)], start=today, end=tomorrow)
        self.assertEqual((res["days"][0]["action"], res["days"][0]["reason"]), ("skip", "This day has not happened yet."))
        self.assertEqual(res["batchId"], "")
        # Today's shift that ends later than now is refused as well.
        late = T.RecordRow(date=today, in_at=(datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
                           out_at=(datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S"),
                           tz_offset_min=TZ)
        res = self._rec([late], start=today, end=today, dry_run=True)
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertEqual(self._live(), [])
        days = T.record_days(EMP, today, tomorrow, user=HR_USER, db=self.db)["days"]
        self.assertEqual([d["future"] for d in days], [False, True])

    def test_bad_rows_say_why_without_failing_the_batch(self):
        res = self._rec([row(P1[0], "17:00", "09:00", breaks=()),
                         row(P1[1], breaks=(("07:00", "07:30"),)),
                         row(P1[2], breaks=(("12:00", "12:30"),), category="Sick Day"),
                         row(P1[3])], dry_run=True)
        by = {d["date"]: d for d in res["days"]}
        self.assertIn("after the clock-in", by[P1[0]]["reason"])
        self.assertIn("inside the shift", by[P1[1]]["reason"])
        self.assertIn("no breaks", by[P1[2]]["reason"])
        self.assertEqual(by[P1[3]]["action"], "add")
        # A row overlapping the next row's overnight time is refused, not doubled.
        night = T.RecordRow(date=P1[0], in_at=_utc(P1[0], "20:00"), out_at=_utc(P1[1], "06:00"), tz_offset_min=TZ)
        res = self._rec([night, T.RecordRow(date=P1[1], in_at=_utc(P1[1], "05:00"), out_at=_utc(P1[1], "09:00"),
                                            tz_offset_min=TZ)], dry_run=True)
        by = {d["date"]: d for d in res["days"]}
        self.assertEqual((by[P1[0]]["action"], by[P1[0]]["minutes"]), ("add", 600))
        self.assertEqual(by[P1[1]]["action"], "skip")
        self.assertIn("overlaps", by[P1[1]]["reason"])

    # -- the tag ----------------------------------------------------------------
    def test_source_tag_on_punches_card_pdf_and_audit(self):
        res = self._rec([row(P1[0]), row(P1[1])])
        rows = self._live(P1[0])
        self.assertTrue(all(p.entry_source == "hr_record" and p.batch_id == res["batchId"] and p.note == REASON
                            and p.source == "manual" and p.created_by == HR for p in rows))
        card = T._compute_timecard(self.db, EMP, "2026-09-06", "2026-09-19")
        meta = card["punchMeta"][rows[0].id]
        self.assertEqual((meta["entrySource"], meta["source"], meta["recordReason"], meta["batchId"]),
                         ("hr_record", "Entered By HR From Record", REASON, res["batchId"]))
        # The PDF's footnote for the day says so, with the reason (and does not repeat it).
        day = next(d for d in card["days"] if d["date"] == P1[0])
        g = timesheet_pdf._Grid(["c"] * 11)
        timesheet_pdf._note_line(g, P1[0], day["segments"], {"notes": {}, "punch_meta": card["punchMeta"],
                                                             "names_in": lambda s: s})
        text = g.rows[-1][0].text
        self.assertIn("Entered By HR From Record:", text)
        self.assertEqual(text.count(REASON), 1)
        r = models.TimesheetReview(employee_email=EMP, period_start="2026-09-06", period_end="2026-09-19",
                                   pay_type="hourly", rounds=[], status="paper")
        pdf, _spot = timesheet_review.build_pdf(self.db, r)
        self.assertTrue(pdf.startswith(b"%PDF"))
        # The employee's own card carries the tag and the reason; the audit row is there.
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20))
        self.db.commit()
        mine = T.my_payroll("2026-09-14", user=EMP_USER, db=self.db)
        self.assertEqual([b["reason"] for b in mine["recordBatches"]], [REASON])
        self.assertNotIn("docName", mine["recordBatches"][0])
        audit = self.db.query(models.AuditLog).filter(models.AuditLog.resource_id == res["batchId"]).one()
        self.assertEqual(json.loads(audit.details)["employee"], EMP)

    def test_source_document_is_stored_privately_and_only_hr_opens_it(self):
        calls = []

        class Resp:
            is_success = True
            text = ""

            def __init__(self, body=None):
                self._b = body or {}

            def json(self):
                return self._b

        def fake_post(url, **kw):
            calls.append(url)
            return Resp({"signedURL": "/object/sign/hr-docs/x?token=t"} if "/sign/" in url else {})
        real, real_headers = T.httpx.post, T._storage_headers
        T.httpx.post, T._storage_headers = fake_post, lambda: {"Authorization": "Bearer service"}
        try:
            up = UploadFile(file=io.BytesIO(b"%PDF-1.4 sheet"), filename="Sept sheet.pdf",
                            headers=Headers({"content-type": "application/pdf"}))
            staged = T.record_source_doc(EMP, file=up, user=HR_USER, db=self.db)
            self.assertTrue(staged["path"].startswith(f"time-records/{EMP}/"))
            self.assertIn(f"/storage/v1/object/{T._DOC_BUCKET}/time-records/{EMP}/", calls[0])
            self.assertEqual(T._DOC_BUCKET, "hr-docs")
            # Not a picture or a PDF, or not HR: refused.
            bad = UploadFile(file=io.BytesIO(b"x"), filename="a.exe", headers=Headers({"content-type": "application/x-msdownload"}))
            self._status(400, T.record_source_doc, EMP, file=bad, user=HR_USER, db=self.db)
            up2 = UploadFile(file=io.BytesIO(b"%PDF"), filename="a.pdf", headers=Headers({"content-type": "application/pdf"}))
            self._status(403, T.record_source_doc, EMP, file=up2, user=MGR_USER, db=self.db)
            # A path staged for someone else cannot be attached.
            self._status(400, self._rec, [row(P1[0])], source_doc_path=f"time-records/{PEER}/x.pdf")
            res = self._rec([row(P1[0])], source_doc_path=staged["path"], source_doc_name=staged["name"])
            b = self.db.query(models.TimeEntryBatch).one()
            self.assertEqual((b.doc_path, b.doc_name), (staged["path"], "Sept sheet.pdf"))
            link = T.record_source_doc_url(res["batchId"], user=HR_USER, db=self.db)
            self.assertIn("/sign/hr-docs/", link["url"])
            self._status(403, T.record_source_doc_url, res["batchId"], user=MGR_USER, db=self.db)
            self._status(403, T.record_source_doc_url, res["batchId"], user=EMP_USER, db=self.db)
            # HR's card names the document; the employee's never does.
            card = T._compute_timecard(self.db, EMP, "2026-09-06", "2026-09-19")
            T._card_record_batches(self.db, HR_USER, EMP, card)
            self.assertEqual(card["recordBatches"][0]["docName"], "Sept sheet.pdf")
            card2 = T._compute_timecard(self.db, EMP, "2026-09-06", "2026-09-19")
            T._card_record_batches(self.db, EMP_USER, EMP, card2)
            self.assertNotIn("docName", card2["recordBatches"][0])
        finally:
            T.httpx.post, T._storage_headers = real, real_headers

    # -- review, notice ---------------------------------------------------------
    def test_a_card_out_for_signature_comes_back_for_the_employee_to_sign(self):
        self.db.add(models.HrSignRequest(id="sr-rec", title="Time Sheet", status="pending"))
        self.db.add(models.TimesheetReview(id="r-rec", employee_email=EMP, period_start="2026-09-06",
                                           period_end="2026-09-19", pay_type="hourly", status="signing",
                                           sign_request_id="sr-rec", rounds=[]))
        self.db.add(models.TimesheetReview(id="r-rec2", employee_email=EMP, period_start="2026-09-20",
                                           period_end="2026-10-03", pay_type="hourly", status="approved", rounds=[]))
        self.db.commit()
        self._rec([row(P1[3]), row(P2[0])])
        self.db.expire_all()
        r = self.db.query(models.TimesheetReview).filter_by(id="r-rec").one()
        self.assertEqual((r.status, r.sign_request_id), ("approved", ""))   # the employee signs the updated card
        self.assertEqual(self.db.query(models.HrSignRequest).filter_by(id="sr-rec").one().status, "voided")
        self.assertEqual([x["action"] for x in r.rounds], ["hr_edited"])
        self.assertIn("added time from a record", r.rounds[0]["note"])
        r2 = self.db.query(models.TimesheetReview).filter_by(id="r-rec2").one()
        self.assertEqual((r2.status, r2.agreed_fingerprint), ("approved", ""))
        self.assertEqual([x["action"] for x in r2.rounds], ["hr_edited"])

    def test_one_notice_to_the_employee_per_batch(self):
        self._rec([row(d) for d in P1])
        n = (self.db.query(models.NexusNotification)
             .filter(models.NexusNotification.recipient == EMP,
                     models.NexusNotification.title == "HR Added Time From A Record").all())
        self.assertEqual(len(n), 1)
        self.assertIn("09/14/2026 - 09/23/2026", n[0].body)
        self.assertIn(REASON, n[0].body)
        self.assertNotIn("2026-09", n[0].body)   # US dates only

    # -- India contractor --------------------------------------------------------
    def test_india_contractor_credit_from_entered_hours(self):
        scoped_settings.save(self.db, "timeclock_india_contractor", "", {"mode": "on", "startDate": "2026-09-01"}, ADMIN)
        self.db.add(models.PayrollRate(employee_email=IND, pay_type="fixed", monthly_salary=90000, currency="INR"))
        self.db.commit()
        days = T.record_days(IND, P1[0], P1[-1], user=HR_USER, db=self.db)
        self.assertEqual(days["india"], {"fullMin": 480, "halfMin": 240})
        self.assertTrue(all(d["india"] for d in days["days"]))
        res = self._rec([row(P1[0], "09:00", "18:00", breaks=(("13:00", "13:30"),), tz=TZ_IN),   # 8.5 h - Full
                         row(P1[1], "09:00", "14:00", breaks=(), tz=TZ_IN),                     # 5 h - Half
                         row(P1[2], "09:00", "12:00", breaks=(), tz=TZ_IN),                     # 3 h - None
                         row(P1[3], "09:00", "18:00", breaks=(), category="Sick Day", tz=TZ_IN)],
                        em=IND, start=P1[0], end=P1[-1], dry_run=True)
        self.assertEqual({d["date"]: d.get("credit") for d in res["days"]},
                         {P1[0]: "full", P1[1]: "half", P1[2]: "none", P1[3]: "leave"})
        self.assertEqual(res["days"][0]["workedMin"], 510)
        # Someone the policy does not cover gets no credit at all.
        plain = self._rec([row(P1[0])], dry_run=True)
        self.assertNotIn("credit", plain["days"][0])
        self.assertIsNone(T.record_days(EMP, P1[0], P1[-1], user=HR_USER, db=self.db)["india"])

    def test_working_days_flag_for_the_grid(self):
        self.db.add(models.HrCompanyHoliday(id="h-rec", company_id=CO, date=P1[2], name="Founders Day"))
        self.db.commit()
        days = {d["date"]: d for d in T.record_days(EMP, P1[0], "2026-09-20", user=HR_USER, db=self.db)["days"]}
        self.assertEqual([ds for ds, d in sorted(days.items()) if d["working"]], [P1[0], P1[1], P1[3], P1[4]])
        self.assertIn("Founders Day", days[P1[2]]["leftOut"])


if __name__ == "__main__":
    unittest.main()
