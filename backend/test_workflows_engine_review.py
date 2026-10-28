"""Workflows (Oct 28 2026) - the engine correctness review, one regression
test per finding (each failed on the tree the review read):

  HIGH  1  a walk that raises is a failed run (owner belled), never one
           stuck `running`; a run stuck `running` is re-queued by the tick;
        2  outbox rows are claimed one at a time right before they run; a
           row whose handling raised is tried again (3 attempts, error kept);
        3  the step purge never touches a running / waiting run's rows;
  MEDIUM 4 a resume that raises gives the wait back; a stale claim is taken;
         5 Test and skipped runs do not count toward the hourly cap;
         6 two decisions at once resume the run once (and the sweep vs a
           decision); a resume into `expired` closes the ask;
         7 the date scan runs once per workflow + company per local day,
           narrows plain columns in SQL, and the tick runs it once a minute;
         8 a run fails at 10 minutes of active work; the outbox stops at
           the tick budget; waits run before the outbox;
         9 one broken pack does not silence the catalog or emit;
        10 a Jan 2 birthday with offset -7 fires on Dec 26; an
           anniversary never fires on the start date itself;
        11 a failed run_for gives the period / date back;
  LOW      bells that went out stay out when the next recipient fails;
           For Each keeps id + label per item; the wait queue and the marks
           are audit noise; `now` is the company clock.

    cd backend && python -m pytest test_workflows_engine_review.py -q
"""
import os
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

import audit_capture  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import workflows  # noqa: E402
from workflows import approvals, catalog, engine, runner, scheduler, store, validate  # noqa: E402
from workflows.context import RunContext  # noqa: E402

ENTITY = "ent-rev"
OWNER, PRIYA, MAX, HANA, GAIL = ("owen.rev@greensglobal.com", "priya.rev@greensglobal.com",
                                 "max.rev@greensglobal.com", "hana.rev@greensglobal.com",
                                 "gail.rev@greensglobal.com")
ZONE = ZoneInfo("America/Los_Angeles")
SLOW = {"seconds": 0.02}


def _slow_run(ctx, params):
    time.sleep(SLOW["seconds"])
    return {"line": "Slow done", "sent": [], "affected": []}


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    catalog.action("test.slow", label="Slow Step", module="core", params=[],
                   plan=lambda ctx, p: "Would be slow", run=_slow_run, needs_person=False)
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Rev", hr_contact_email=HANA))
    for email, first in [(OWNER, "Owen"), (PRIYA, "Priya"), (MAX, "Max"), (HANA, "Hana"), (GAIL, "Gail")]:
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Rev",
                                   company=ENTITY, status="active", manager_email=MAX if email == PRIYA else "",
                                   start_date="2026-11-12", department="Operations"))
    s.add(models.NexusEmployee(id="e-sample-mgr", work_email="max.miller@greensglobal.com", first_name="Max",
                               last_name="Miller", company=ENTITY, status="active"))
    s.add(models.NexusRole(email=OWNER, role="manager"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusGroup(id="g-rev", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-rev", email=OWNER))
    s.commit()
    s.close()
    auth._role_cache.clear()
    cache.module_grants.invalidate()
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.Workflow, models.WorkflowVersion, models.WorkflowEvent, models.WorkflowRun,
              models.WorkflowRunStep, models.WorkflowWait, models.WorkflowApproval, models.WorkflowSubjectMark,
              models.NexusNotification, models.NexusSetting, models.AuditLog):
        s.query(m).delete()
    s.query(models.NexusEmployee).filter(models.NexusEmployee.id.like("t-p%")).delete(synchronize_session=False)
    s.commit()
    yield s
    s.rollback()
    s.close()


NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
          "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} is now {{ change.status.to }}"}}
NOTIFY2 = {"id": "n2", "kind": "action", "action": "notify",
           "params": {"to": [{"kind": "role", "value": "hr_contact"}], "title": "Second: {{ subject.name }}"}}
WAIT = {"id": "w1", "kind": "wait", "params": {"mode": "duration", "minutes": 60}}
APPROVAL = {"id": "ap1", "kind": "approval",
            "params": {"approvers": [{"kind": "manager"}], "mode": "any", "question": "Let {{ subject.name }} go?",
                       "options": ["Approve", "Decline"], "expireDays": 1},
            "branches": {"Approve": [{**NOTIFY2, "id": "y"}], "Decline": [{**NOTIFY2, "id": "d"}],
                         "expired": [{**NOTIFY2, "id": "x"}]}}
TRIGGER = {"kind": "event", "event": "employee.status_changed"}
USER_MAX = {"email": MAX, "role": "manager", "level": 3}


def _wf(db, *, steps, trigger=None, conditions=None, settings=None, name="Status Watch"):
    definition = {"v": 1, "trigger": trigger or TRIGGER, "conditions": conditions or [], "steps": steps,
                  "settings": {**validate.DEFAULT_SETTINGS, **(settings or {})}}
    wf = store.create(db, name=name, owner=OWNER, company_id=ENTITY, definition=definition, by=OWNER)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, OWNER)
    db.commit()
    return wf


def _event(db, who="e-priya", changes=None):
    row = db.get(models.NexusEmployee, who)
    workflows.emit(db, "employee.status_changed", subject=row, actor=HANA,
                   changes=changes if changes is not None else {"status": ("active", "offboarded")})
    db.commit()
    return db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at.desc()).first()


def _steps(db, run):
    return [s for s in store.run_steps(db, run) if s.kind != "conditions"]


def _bells(db, who):
    return db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who).all()


def _local(y, m, d, hh, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=ZONE).astimezone(timezone.utc)


def _person(db, pid, start_date):
    db.add(models.NexusEmployee(id=pid, work_email=f"{pid}@greensglobal.com", first_name=pid.title(), last_name="P",
                                company=ENTITY, status="active", start_date=start_date, manager_email=MAX))
    db.commit()


# ── HIGH 1: a walk that raises ───────────────────────────────────────────────
def test_walk_that_raises_marks_the_run_failed_and_bells_the_owner(db, monkeypatch):
    wf = _wf(db, steps=[NOTIFY, {"id": "i1", "kind": "if", "conditions": [], "then": [NOTIFY2], "else": []}])

    def boom(self, step, sid, ctx):
        raise RuntimeError("the branch blew up")
    monkeypatch.setattr(engine._Walk, "branch", boom)
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "failed" and run.error == "RuntimeError: the branch blew up"
    assert run.finished_at and run.summary.startswith("Failed: RuntimeError")
    assert [s.status for s in _steps(db, run)] == ["done"]            # the first step's row is kept
    assert db.query(models.WorkflowWait).count() == 0
    bell = _bells(db, OWNER)
    assert len(bell) == 1 and bell[0].title == "Workflow Failed: Status Watch" and "the branch blew up" in bell[0].body
    db.refresh(wf)
    assert wf.fail_count == 1 and wf.run_count == 1


def test_tick_requeues_a_run_stuck_running_and_finishes_it(db):
    wf = _wf(db, steps=[NOTIFY, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "succeeded" and db.query(models.NexusNotification).count() == 2
    # a worker died after the first step: the run says running, no wait row,
    # nothing touched for ten minutes, the second step never written
    ago = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == run.id,
                                            models.WorkflowRunStep.step_id == "n2").delete()
    db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == run.id).update(
        {"started_at": ago, "finished_at": ago}, synchronize_session=False)
    run.status, run.started_at, run.finished_at = "running", ago, ""
    db.query(models.NexusNotification).filter(models.NexusNotification.recipient == HANA).delete()
    # and one fresh run, under way right now, that must be left alone
    fresh = models.WorkflowRun(id="fresh", workflow_id=wf.id, workflow_name=wf.name, status="running",
                               started_at=datetime.now(timezone.utc).isoformat(), entity="employee", subject_id="e-priya")
    db.add(fresh)
    db.commit()
    assert engine.requeue_stuck(db) == 1
    wait = db.query(models.WorkflowWait).one()
    assert wait.run_id == run.id and wait.kind == "delay" and wait.state.get("stuck") is True
    assert engine.requeue_stuck(db) == 0                                  # queued once
    out = runner.tick()
    assert out["resumed"] == 1
    db.expire_all()
    run = db.get(models.WorkflowRun, run.id)
    assert run.status == "succeeded"
    assert [(s.step_id, s.status) for s in _steps(db, run)] == [("n1", "done"), ("n2", "done")]
    assert len(_bells(db, MAX)) == 1 and len(_bells(db, HANA)) == 1       # n1 was not done twice
    assert db.get(models.WorkflowRun, "fresh").status == "running"


# ── HIGH 2: the outbox claim ─────────────────────────────────────────────────
def test_outbox_rows_are_claimed_one_at_a_time_and_a_failed_row_is_retried(db, monkeypatch):
    _wf(db, steps=[NOTIFY])
    first, second = _event(db), _event(db, who="e-max")
    seen = []
    real = engine.handle_event

    def handle(db_, ev):
        other = db_.get(models.WorkflowEvent, second.id if ev.id == first.id else first.id)
        seen.append((ev.id, other.processed_at))
        if ev.id == first.id and len(seen) == 1:
            raise RuntimeError("tick died here")
        return real(db_, ev)
    monkeypatch.setattr(engine, "handle_event", handle)
    out = runner.tick()
    assert (out["events"], out["runs"]) == (2, 1)
    # the first row was the only one claimed while it ran
    assert seen[0] == (first.id, "")
    db.expire_all()
    row = db.get(models.WorkflowEvent, first.id)
    assert row.processed_at == "" and row.attempts == 1 and row.error == "RuntimeError: tick died here"
    assert db.get(models.WorkflowEvent, second.id).processed_at != ""
    # the next tick tries it again and it goes through
    out = runner.tick()
    assert (out["events"], out["runs"]) == (1, 1)
    db.expire_all()
    row = db.get(models.WorkflowEvent, first.id)
    assert row.processed_at != "" and row.attempts == 2 and row.error == ""
    assert db.query(models.WorkflowRun).count() == 2


def test_an_event_that_keeps_failing_stops_after_three_attempts_with_its_error(db, monkeypatch):
    _wf(db, steps=[NOTIFY])
    ev = _event(db)
    monkeypatch.setattr(engine, "handle_event", lambda db_, e: (_ for _ in ()).throw(RuntimeError("always")))
    for n in (1, 2, 3):
        assert runner.tick()["events"] == 1
        db.expire_all()
        assert db.get(models.WorkflowEvent, ev.id).attempts == n
    row = db.get(models.WorkflowEvent, ev.id)
    assert row.processed_at != "" and row.error == "RuntimeError: always"
    assert runner.tick()["events"] == 0                                    # final: not tried a fourth time


# ── HIGH 3: the step purge ───────────────────────────────────────────────────
def test_step_purge_keeps_the_rows_of_a_waiting_run(db):
    _wf(db, steps=[NOTIFY, WAIT, NOTIFY2])
    _wf(db, steps=[NOTIFY2], name="Plain")
    waiting, done = engine.handle_event(db, _event(db))
    assert waiting.status == "waiting" and done.status == "succeeded"
    old = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat()
    db.query(models.WorkflowRunStep).update({"started_at": old}, synchronize_session=False)
    db.commit()
    runner.purge(db)
    assert db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == done.id).count() == 0
    kept = db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == waiting.id).all()
    assert {s.step_id for s in kept} >= {"n1", "w1"}
    # and the resume does not send n1 again
    before = len(_bells(db, MAX))
    run = engine.resume(db, db.query(models.WorkflowWait).one())
    assert run.status == "succeeded" and len(_bells(db, MAX)) == before


# ── 4: a resume that raises ──────────────────────────────────────────────────
def test_resume_that_raises_gives_the_wait_back_and_a_stale_claim_is_taken(db, monkeypatch):
    _wf(db, steps=[NOTIFY, WAIT, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    wait = db.query(models.WorkflowWait).one()
    real = engine.resume
    calls = {"n": 0}

    def flaky(db_, w, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("resume blew up")
        return real(db_, w, **kw)
    monkeypatch.setattr(engine, "resume", flaky)
    at = datetime.now(timezone.utc) + timedelta(minutes=61)
    assert runner.resume_due(db, at) == 0
    db.expire_all()
    wait = db.get(models.WorkflowWait, wait.id)
    assert wait is not None and wait.claimed_at == ""
    assert timedelta(seconds=59) < datetime.fromisoformat(wait.due_at) - at <= timedelta(minutes=1)
    # a claim another process took and never finished is taken after ten minutes
    wait.claimed_at = (at - timedelta(minutes=11)).isoformat()
    wait.due_at = (at - timedelta(minutes=12)).isoformat()
    db.commit()
    assert runner.resume_due(db, at - timedelta(minutes=5)) == 0          # claimed 6 minutes ago: left alone
    assert runner.resume_due(db, at) == 1
    db.expire_all()
    assert db.get(models.WorkflowRun, run.id).status == "succeeded"


# ── 5: the hourly cap ────────────────────────────────────────────────────────
def test_hourly_cap_counts_neither_test_nor_skipped_runs(db):
    wf = _wf(db, steps=[NOTIFY], conditions=[[{"field": "department", "op": "is", "value": "Operations"}]],
             settings={"maxRunsPerHour": 2, "logSkips": True})
    for _ in range(2):
        run = engine.handle_event(db, _event(db, who="e-sample-mgr"))[0]   # no department: a logged skip
        assert run.status == "skipped"
    assert engine.test_run(db, wf, by=OWNER).status == "test"
    assert engine.test_run(db, wf, by=OWNER).status == "test"
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "succeeded"
    db.refresh(wf)
    assert wf.status == "active"
    # real runs still count: the third one hits the cap
    assert engine.handle_event(db, _event(db))[0].status == "succeeded"
    assert engine.handle_event(db, _event(db))[0].status == "skipped"
    db.refresh(wf)
    assert wf.status == "needs_attention" and "ran 2 times in an hour" in wf.paused_reason


# ── 6: one decision ──────────────────────────────────────────────────────────
def test_two_decisions_at_once_resume_the_run_once(db):
    wf = _wf(db, steps=[APPROVAL])
    run = engine.handle_event(db, _event(db))[0]
    ap = db.query(models.WorkflowApproval).one()
    other = database.SessionLocal()
    try:
        stale = other.get(models.WorkflowApproval, ap.id)          # a second worker holding the open ask
        assert stale.outcome == ""
        first = approvals.decide(db, ap, USER_MAX, "Decline")
        assert first["decided"] and first["runStatus"] == "succeeded"
        with pytest.raises(ValueError, match="already decided"):
            approvals.decide(other, stale, USER_MAX, "Approve")
        other.expire_all()
        assert other.get(models.WorkflowApproval, ap.id).outcome == "Decline"
    finally:
        other.close()
    db.expire_all()
    run = db.get(models.WorkflowRun, run.id)
    assert [(s.step_id, s.status) for s in _steps(db, run)] == [("ap1", "done"), ("ap1/Decline/d", "done")]
    assert len(_bells(db, HANA)) == 1
    db.refresh(wf)
    assert wf.run_count == 1


def test_expiry_sweep_and_a_decision_cannot_both_win(db):
    _wf(db, steps=[APPROVAL])
    engine.handle_event(db, _event(db))
    ap = db.query(models.WorkflowApproval).one()
    other = database.SessionLocal()
    try:
        stale = other.get(models.WorkflowApproval, ap.id)
        out = approvals.sweep(db, datetime.now(timezone.utc) + timedelta(days=1, minutes=1))
        assert out["expired"] == 1
        with pytest.raises(ValueError, match="already decided"):
            approvals.decide(other, stale, USER_MAX, "Approve")
    finally:
        other.close()
    db.expire_all()
    assert db.query(models.WorkflowApproval).one().outcome == "expired"
    assert len(_bells(db, HANA)) == 1


def test_claim_wait_is_atomic_and_a_runner_expiry_closes_the_ask(db):
    _wf(db, steps=[APPROVAL])
    run = engine.handle_event(db, _event(db))[0]
    wait = db.query(models.WorkflowWait).one()
    assert engine.claim_wait(db, wait.id) is True
    assert engine.claim_wait(db, wait.id) is False
    db.expire_all()
    db.get(models.WorkflowWait, wait.id).claimed_at = ""
    db.commit()
    # the runner's resume of the expired wait (not the sweep) closes the ask too
    assert runner.resume_due(db, datetime.now(timezone.utc) + timedelta(days=1, minutes=1)) == 1
    db.expire_all()
    ap = db.query(models.WorkflowApproval).one()
    assert ap.outcome == "expired" and ap.decided_at
    assert db.get(models.WorkflowRun, run.id).status == "succeeded"


# ── 7: the date scan ─────────────────────────────────────────────────────────
DATE_NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
               "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} starts {{ subject.start_date | us_date }}"}}


def test_date_scan_runs_once_per_company_and_local_day(db, monkeypatch):
    wf = _wf(db, trigger={"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": -14,
                          "time": "08:00"}, steps=[DATE_NOTIFY])
    _person(db, "t-p14", "2026-11-17")
    assert runner.fire_dates(db, _local(2026, 11, 3, 7, 0)) == 0           # before 8:00: no scan, no mark
    assert not scheduler.claimed_mark(db, wf.id, "dates", f"{ENTITY}:2026-11-03")
    assert runner.fire_dates(db, _local(2026, 11, 3, 8, 0)) == 1
    assert scheduler.claimed_mark(db, wf.id, "dates", f"{ENTITY}:2026-11-03")
    _person(db, "t-p14b", "2026-11-17")                                  # added after the scan
    monkeypatch.setattr(scheduler, "due_dates_for", lambda *a, **k: pytest.fail("the rows must not be read again today"))
    assert runner.fire_dates(db, _local(2026, 11, 3, 12, 0)) == 0
    monkeypatch.undo()
    assert runner.fire_dates(db, _local(2026, 11, 4, 8, 0)) == 0           # the next day scans again (nothing due)
    assert scheduler.claimed_mark(db, wf.id, "dates", f"{ENTITY}:2026-11-04")


def test_date_scan_narrows_a_plain_column_in_sql(db, monkeypatch):
    emp = catalog.ENTITIES["employee"]
    assert scheduler.column_for(emp, "start_date") is not None
    assert scheduler.column_for(emp, "probation_end") is None            # inside JSON: Python reads it
    assert scheduler.date_window({"offsetDays": -14}, date(2026, 11, 3)) == ("2026-11-16", "2026-11-18")
    assert scheduler.date_window({"offsetDays": -14, "yearly": True}, date(2026, 11, 3)) is None
    _wf(db, trigger={"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": -14, "time": "08:00"},
        steps=[DATE_NOTIFY])
    _person(db, "t-pnear", "2026-11-17")
    _person(db, "t-pfar", "2027-05-01")
    checked = []
    real = scheduler._date_of
    monkeypatch.setattr(scheduler, "_date_of", lambda ent, row, fld: checked.append(row.id) or real(ent, row, fld))
    due = scheduler.due_dates(db, _local(2026, 11, 3, 9, 0))
    assert [row.id for _w, row, _d in due] == ["t-pnear"]
    assert "t-pnear" in checked and "t-pfar" not in checked and "e-priya" not in checked


def test_tick_runs_the_date_scan_once_a_minute(db, monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "fire_dates", lambda db_, now=None: calls.append(now) or 0)
    runner._last_dates = 0.0
    runner.tick()
    runner.tick()
    assert len(calls) == 1
    runner.tick(force_dates=True)
    assert len(calls) == 2


# ── 8: caps and the tick budget ──────────────────────────────────────────────
def test_run_fails_at_ten_minutes_of_active_work(db):
    _wf(db, steps=[{"id": "s1", "kind": "action", "action": "test.slow", "params": {}}, WAIT, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "waiting" and 0.02 <= float(run.active_seconds) < 5
    run.active_seconds = engine.RUN_ACTIVE_SECONDS + 1                    # ten minutes of work already on the row
    db.commit()
    run = engine.resume(db, db.query(models.WorkflowWait).one())
    assert run.status == "failed"
    assert "10 minutes of active work" in run.error and run.error.startswith("Send A Notification")
    assert [(s.step_id, s.status) for s in _steps(db, run)] == [("s1", "done"), ("w1", "done"), ("n2", "failed")]
    assert len(_bells(db, HANA)) == 0 and len(_bells(db, OWNER)) == 1


def test_tick_budget_stops_taking_rows(db, monkeypatch):
    _wf(db, steps=[NOTIFY])
    for who in ("e-priya", "e-max", "e-hana"):
        _event(db, who=who)
    monkeypatch.setattr(runner, "TICK_BUDGET_SECONDS", 0)
    assert runner.tick()["events"] == 1                                   # one row per tick, never zero
    assert runner.tick()["events"] == 1
    monkeypatch.setattr(runner, "TICK_BUDGET_SECONDS", 20)
    assert runner.tick()["events"] == 1
    assert runner.tick()["events"] == 0
    assert db.query(models.WorkflowRun).count() == 3


def test_tick_resumes_waits_and_sweeps_approvals_before_the_outbox(db, monkeypatch):
    order = []
    monkeypatch.setattr(engine, "requeue_stuck", lambda db_, now=None: order.append("requeue") or 0)
    monkeypatch.setattr(runner, "resume_due", lambda db_, now=None, limit=100: order.append("resume") or 0)
    monkeypatch.setattr(approvals, "sweep", lambda db_, now=None: order.append("sweep") or {})
    monkeypatch.setattr(runner, "process_events", lambda db_, now=None, **kw: order.append("events") or (0, 0))
    monkeypatch.setattr(runner, "fire_schedules", lambda db_, now=None: order.append("schedules") or 0)
    runner.tick()
    assert order == ["requeue", "resume", "sweep", "events", "schedules"]


# ── 9: a broken pack ─────────────────────────────────────────────────────────
def test_one_broken_pack_does_not_silence_the_catalog_or_emit(db, monkeypatch, capsys):
    import importlib
    real = importlib.import_module

    def broken(name, *a, **kw):
        if name == "workflows.packs.tickets":
            raise ImportError("tickets pack is broken today")
        return real(name, *a, **kw)
    monkeypatch.setattr(catalog, "_packs_loaded", False)
    monkeypatch.setattr(catalog.importlib, "import_module", broken)
    catalog.load_errors.clear()
    catalog.load_packs()
    assert catalog._packs_loaded is True
    assert catalog.load_errors == {"tickets": "ImportError: tickets pack is broken today"}
    assert "[workflows] pack tickets failed to load: ImportError: tickets pack is broken today" in capsys.readouterr().out
    catalog.load_packs()                                                   # no second import, no second line
    assert capsys.readouterr().out == ""
    _wf(db, steps=[NOTIFY])
    ev = _event(db)
    assert ev is not None and ev.key == "employee.status_changed"
    assert "emit skipped" not in capsys.readouterr().out
    catalog.load_errors.clear()


# ── 10: yearly dates ─────────────────────────────────────────────────────────
def test_yearly_dates_look_across_the_year_end_and_never_fire_on_day_zero(db):
    yearly = {"yearly": True, "offsetDays": -7}
    assert scheduler.fires_today(yearly, date(2000, 1, 2), date(2026, 12, 26))        # Jan 2 birthday, 7 days out
    assert not scheduler.fires_today(yearly, date(2000, 1, 2), date(2026, 12, 25))
    assert scheduler.fires_today({"yearly": True, "offsetDays": 5}, date(2010, 12, 30), date(2026, 1, 4))
    assert scheduler.fires_today({"yearly": True, "offsetDays": 0}, date(2021, 11, 3), date(2026, 11, 3))
    assert not scheduler.fires_today({"yearly": True, "offsetDays": 0}, date(2026, 11, 3), date(2026, 11, 3))
    assert not scheduler.fires_today({"yearly": True, "offsetDays": -7}, date(2026, 11, 10), date(2026, 11, 3))
    assert scheduler.fires_today({"yearly": True, "offsetDays": 0}, date(2024, 2, 29), date(2026, 2, 28))
    # through the scan: the Dec 26 tick finds the Jan 2 start, not today's starter
    _wf(db, trigger={"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": -7, "time": "08:00",
                     "yearly": True}, steps=[DATE_NOTIFY])
    _person(db, "t-pjan", "2000-01-02")
    _person(db, "t-ptoday", "2026-12-26")
    due = scheduler.due_dates(db, _local(2026, 12, 26, 9, 0))
    assert [row.id for _w, row, _d in due] == ["t-pjan"]


# ── 11: a failed run_for ─────────────────────────────────────────────────────
def test_failed_run_for_gives_the_period_and_the_date_back(db, monkeypatch):
    sched = _wf(db, trigger={"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"},
                steps=[NOTIFY2], name="Daily")
    dated = _wf(db, trigger={"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": 0,
                             "time": "08:00"}, steps=[DATE_NOTIFY], name="Dated")
    _person(db, "t-pday", "2026-11-03")
    real = engine.run_for
    fails = {"n": 2}

    def flaky(db_, wf, **kw):
        if fails["n"]:
            fails["n"] -= 1
            raise RuntimeError("run_for blew up")
        return real(db_, wf, **kw)
    monkeypatch.setattr(engine, "run_for", flaky)
    at = _local(2026, 11, 3, 9, 0)
    assert runner.fire_schedules(db, at) == 0
    assert not scheduler.claimed(db, sched, f"wf:{sched.id}:{ENTITY}:2026-11-03")
    assert runner.fire_dates(db, at) == 0
    assert not scheduler.claimed(db, dated, f"wf:{dated.id}:t-pday:2026-11-03")
    assert not scheduler.claimed_mark(db, dated.id, "dates", f"{ENTITY}:2026-11-03")   # the day is not done
    assert runner.fire_schedules(db, at) == 1 and runner.fire_dates(db, at) == 1
    assert scheduler.claimed(db, sched, f"wf:{sched.id}:{ENTITY}:2026-11-03")
    assert scheduler.claimed_mark(db, dated.id, "dates", f"{ENTITY}:2026-11-03")
    assert runner.fire_schedules(db, at) == 0 and runner.fire_dates(db, at) == 0


# ── LOW ──────────────────────────────────────────────────────────────────────
def test_bells_that_went_out_stay_out_when_the_next_recipient_fails(db, monkeypatch):
    import notify_rollup
    real = notify_rollup.upsert_rollup
    calls = []

    def flaky(db_, **kw):
        calls.append(kw["recipient"])
        if len(calls) == 2:
            raise RuntimeError("the second bell failed")
        return real(db_, **kw)
    monkeypatch.setattr(notify_rollup, "upsert_rollup", flaky)
    _wf(db, steps=[{"id": "n1", "kind": "action", "action": "notify",
                    "params": {"to": [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}],
                               "title": "Hello {{ subject.name }}"}}])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "failed" and calls[:2] == [MAX, HANA]           # (the third bell is the owner's)
    step = _steps(db, run)[0]
    assert step.status == "failed" and step.output["sent"] == [MAX]
    assert len(_bells(db, MAX)) == 1 and len(_bells(db, HANA)) == 0        # what `sent` says went out, went out


def test_wait_queue_and_marks_are_audit_noise():
    assert {"workflow_waits", "workflow_subject_marks"} <= audit_capture.NOISE_TABLES


def test_now_is_the_company_clock(db):
    ctx = RunContext(db=db, zone="Asia/Kolkata")
    assert ctx.resolve("now").endswith("+05:30")
    assert RunContext(db=db, zone="America/Los_Angeles").resolve("now").endswith(("-07:00", "-08:00"))
