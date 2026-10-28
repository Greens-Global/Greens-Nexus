"""Workflows (Oct 28 2026) - Task 7: schedules and date triggers.

  * a daily schedule fires once per company per period, in the company's
    zone, and catches up a period whose time passed - never twice;
  * a weekly schedule fires only on its listed days; an every-company
    schedule runs once per company with the company as the subject;
  * a date trigger with offset -14 fires on the right day; a yearly date
    (work anniversary) matches month and day;
  * the claim on the dedupe key is atomic (the composite primary key);
  * the owner digest goes on Monday at 8:00 AM Pacific, once per owner per
    ISO week, only with the setting on and only on the deployed API.

    cd backend && python -m pytest test_workflows_scheduler.py -q
"""
import os
import tempfile
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog, engine, runner, scheduler, store, validate  # noqa: E402
from workflows import settings as wf_settings  # noqa: E402

ENTITY, OTHER = "ent-sch", "ent-sch-other"
GAIL, PRIYA, MAX = "gail.sch@greensglobal.com", "priya.sch@greensglobal.com", "max.sch@greensglobal.com"
ZONE = ZoneInfo("America/Los_Angeles")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Sch"))
    s.add(models.HrEntity(id=OTHER, name="Other Sch"))
    s.add(models.NexusEmployee(id="e-gail", work_email=GAIL, first_name="Gail", last_name="Admin", company=ENTITY,
                               status="active"))
    s.add(models.NexusEmployee(id="e-max", work_email=MAX, first_name="Max", last_name="Sch", company=ENTITY,
                               status="active"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
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
    for m in (models.Workflow, models.WorkflowVersion, models.WorkflowRun, models.WorkflowRunStep,
              models.WorkflowWait, models.WorkflowSubjectMark, models.NexusNotification, models.NexusSetting):
        s.query(m).delete()
    s.query(models.NexusEmployee).filter(models.NexusEmployee.id.like("e-p%")).delete(synchronize_session=False)
    s.commit()
    yield s
    s.rollback()
    s.close()


NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
          "params": {"to": [{"kind": "global_admins"}], "title": "Tick for {{ subject.name }}"}}
DATE_NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
               "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} starts {{ subject.start_date | us_date }}"}}


def _wf(db, trigger, *, steps=None, company=ENTITY, name="Sched"):
    definition = {"v": 1, "trigger": trigger, "conditions": [], "steps": steps or [NOTIFY],
                  "settings": dict(validate.DEFAULT_SETTINGS)}
    wf = store.create(db, name=name, owner=GAIL, company_id=company, definition=definition, by=GAIL)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, GAIL)
    db.commit()
    return wf


def _local(y, m, d, hh, mm=0) -> datetime:
    """A UTC instant for that local wall time in the company zone."""
    return datetime(y, m, d, hh, mm, tzinfo=ZONE).astimezone(ZoneInfo("UTC"))


def _person(db, pid, start_date, manager=MAX):
    db.add(models.NexusEmployee(id=pid, work_email=f"{pid}@greensglobal.com", first_name=pid.title(), last_name="P",
                                company=ENTITY, status="active", start_date=start_date, manager_email=manager))
    db.commit()


# ── schedules ────────────────────────────────────────────────────────────────
def test_daily_schedule_fires_once_per_company_period(db):
    wf = _wf(db, {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"})
    assert scheduler.due_schedules(db, _local(2026, 11, 3, 7, 59)) == []
    due = scheduler.due_schedules(db, _local(2026, 11, 3, 8, 0))
    assert [(w.id, cid, period) for w, cid, period in due] == [(wf.id, ENTITY, "2026-11-03")]
    assert runner.fire_schedules(db, _local(2026, 11, 3, 9, 30)) == 1
    run = db.query(models.WorkflowRun).one()
    assert run.status == "succeeded" and run.trigger_kind == "schedule" and run.subject_label == "Greens Sch"
    assert run.dedupe_key == f"wf:{wf.id}:{ENTITY}:2026-11-03" and run.entity == "company"
    assert db.query(models.NexusNotification).one().title == "Tick for Greens Sch"
    # the same period never fires again, the next day does
    assert runner.fire_schedules(db, _local(2026, 11, 3, 23, 0)) == 0
    assert runner.fire_schedules(db, _local(2026, 11, 4, 8, 5)) == 1
    assert db.query(models.WorkflowRun).count() == 2


def test_weekly_schedule_only_on_listed_days(db):
    _wf(db, {"kind": "schedule", "every": "week", "days": [1], "time": "08:00", "zone": "company"})
    assert scheduler.due_schedules(db, _local(2026, 11, 3, 9, 0)) == []      # a Tuesday
    assert len(scheduler.due_schedules(db, _local(2026, 11, 2, 9, 0))) == 1  # Monday
    _wf(db, {"kind": "schedule", "every": "month", "days": [1], "time": "08:00", "zone": "company"}, name="Monthly")
    due = scheduler.due_schedules(db, _local(2027, 2, 1, 9, 0))       # a Monday that is the 1st
    assert sorted(w.name for w, _c, _p in due) == ["Monthly", "Sched"] and all(p == "2027-02-01" for _w, _c, p in due)


def test_every_company_schedule_runs_once_per_company(db):
    wf = _wf(db, {"kind": "schedule", "every": "day", "days": [], "time": "06:00", "zone": "company"}, company="")
    assert runner.fire_schedules(db, _local(2026, 11, 3, 6, 30)) == 2
    runs = db.query(models.WorkflowRun).order_by(models.WorkflowRun.subject_label).all()
    assert [(r.subject_label, r.company_id) for r in runs] == [("Greens Sch", ENTITY), ("Other Sch", OTHER)]
    assert {r.dedupe_key for r in runs} == {f"wf:{wf.id}:{ENTITY}:2026-11-03", f"wf:{wf.id}:{OTHER}:2026-11-03"}
    assert runner.fire_schedules(db, _local(2026, 11, 3, 7, 0)) == 0


# ── date triggers ────────────────────────────────────────────────────────────
def test_date_trigger_offset_minus_14_fires_on_the_right_day(db):
    wf = _wf(db, {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": -14, "time": "08:00"},
             steps=[DATE_NOTIFY])
    _person(db, "e-p14", "2026-11-17")
    _person(db, "e-p13", "2026-11-16")
    assert scheduler.due_dates(db, _local(2026, 11, 3, 7, 0)) == []        # before 8:00
    due = scheduler.due_dates(db, _local(2026, 11, 3, 8, 0))
    assert [(w.id, row.id, day) for w, row, day in due] == [(wf.id, "e-p14", "2026-11-03")]
    assert runner.fire_dates(db, _local(2026, 11, 3, 8, 0)) == 1
    run = db.query(models.WorkflowRun).one()
    assert run.subject_id == "e-p14" and run.trigger_kind == "date" and run.status == "succeeded"
    assert db.query(models.NexusNotification).one().title == "E-P14 P starts 11/17/2026"
    assert runner.fire_dates(db, _local(2026, 11, 3, 12, 0)) == 0
    assert runner.fire_dates(db, _local(2026, 11, 2, 9, 0)) == 1          # the other person's day
    assert db.query(models.WorkflowRun).count() == 2


def test_yearly_date_matches_month_day(db):
    wf = _wf(db, {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": 0, "time": "08:00",
                  "yearly": True}, steps=[DATE_NOTIFY])
    _person(db, "e-pann", "2021-11-03")
    _person(db, "e-pnew", "2027-11-03")      # starts next year: no anniversary yet
    due = scheduler.due_dates(db, _local(2026, 11, 3, 9, 0))
    assert [(w.id, row.id) for w, row, _d in due] == [(wf.id, "e-pann")]
    assert scheduler.fires_today({"yearly": True, "offsetDays": 0}, date(2024, 2, 29), date(2026, 2, 28))
    assert not scheduler.fires_today({"offsetDays": 0}, date(2021, 11, 3), date(2026, 11, 3))
    assert scheduler.fires_today({"offsetDays": 3}, date(2026, 11, 3), date(2026, 11, 6))


def test_date_trigger_stays_in_the_workflow_company(db):
    _wf(db, {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": 0, "time": "08:00"},
        steps=[DATE_NOTIFY], company=OTHER)
    _person(db, "e-pmine", "2026-11-03")
    assert scheduler.due_dates(db, _local(2026, 11, 3, 9, 0)) == []


# ── claims ───────────────────────────────────────────────────────────────────
def test_claim_is_atomic_on_dedupe_key(db):
    wf = _wf(db, {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"})
    assert scheduler.claim(db, wf, "wf:x:1") is True
    assert scheduler.claim(db, wf, "wf:x:1") is False
    other = database.SessionLocal()
    try:
        wf2 = other.get(models.Workflow, wf.id)
        assert scheduler.claim(other, wf2, "wf:x:1") is False
        assert scheduler.claim(other, wf2, "wf:x:2") is True
    finally:
        other.close()
    assert scheduler.claimed(db, wf, "wf:x:2")


def test_schedule_tick_through_the_runner(db):
    _wf(db, {"kind": "schedule", "every": "day", "days": [], "time": "00:00", "zone": "company"})
    out = runner.tick(now=_local(2026, 11, 3, 10, 0))
    assert out["scheduled"] == 1
    assert runner.tick(now=_local(2026, 11, 3, 11, 0))["scheduled"] == 0
    assert engine.company_zone(db, ENTITY) == "America/Los_Angeles"
    # a period a tick missed (the API was down at 00:00) is caught up, once
    assert runner.tick(now=_local(2026, 11, 5, 23, 0))["scheduled"] == 1
    assert runner.tick(now=_local(2026, 11, 5, 23, 30))["scheduled"] == 0
    assert (date(2026, 11, 5) - timedelta(days=1)).isoformat() == "2026-11-04"


# ── the owner digest ─────────────────────────────────────────────────────────
def _run_rows(db, wf, started, status, lines):
    rid = f"run-{started.isoformat()}-{status}-{wf.id[:6]}"
    db.add(models.WorkflowRun(id=rid, workflow_id=wf.id, workflow_name=wf.name, version=1, trigger_kind="schedule",
                              entity="company", subject_id=ENTITY, subject_label="Greens Sch", company_id=ENTITY,
                              status=status, started_at=started.isoformat(), finished_at=started.isoformat()))
    for i, line in enumerate(lines):
        db.add(models.WorkflowRunStep(id=f"{rid}-s{i}", run_id=rid, workflow_id=wf.id, step_id=f"n{i}", kind="action",
                                      action="notify", label="Send A Notification", status="done",
                                      started_at=started.isoformat(), detail=line))
    db.commit()


def test_owner_digest_monday_once_per_owner_with_the_setting_on(db, monkeypatch):
    import graph_mail
    import leader
    sent = []
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: sent.append(kw) or {"messageId": "m1"})
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    daily = {"kind": "schedule", "every": "day", "days": [], "time": "23:00", "zone": "company"}
    wf = _wf(db, daily, name="Daily Tick")
    other = _wf(db, daily, company=OTHER, name="Other Tick")
    monday = _local(2026, 11, 2, 8, 0)
    assert monday.astimezone(ZONE).isoweekday() == 1
    week = "{}-W{:02d}".format(*monday.astimezone(ZONE).isocalendar()[:2])
    _run_rows(db, wf, monday - timedelta(days=1), "succeeded", ["Notified Max Sch: Tick for Greens Sch"])
    _run_rows(db, wf, monday - timedelta(days=2), "succeeded", ["Notified Max Sch: Tick for Greens Sch"])
    _run_rows(db, wf, monday - timedelta(days=3), "failed", ["Emailed Max Sch: Weekly"])
    _run_rows(db, wf, monday - timedelta(days=9), "failed", ["Notified Max Sch: too old"])   # outside the 7 days
    _run_rows(db, other, monday - timedelta(days=1), "succeeded", ["Notified Max Sch: Other"])
    # off by default: nothing goes, nothing is claimed
    assert runner.send_owner_digests(db, monday) == 0 and sent == []
    assert db.get(models.WorkflowSubjectMark, (GAIL, "digest", week)) is None
    wf_settings.save(db, "", {"ownerDigest": True}, GAIL)
    wf_settings.save(db, OTHER, {"ownerDigest": False}, GAIL)      # that company switched it off
    db.commit()
    assert runner.digest_week(_local(2026, 11, 2, 7, 59)) == "" and runner.digest_week(_local(2026, 11, 1, 9, 0)) == ""
    assert runner.send_owner_digests(db, _local(2026, 11, 2, 7, 59)) == 0     # not 8:00 yet
    assert runner.send_owner_digests(db, _local(2026, 11, 1, 9, 0)) == 0      # Sunday
    assert runner.send_owner_digests(db, monday) == 1
    mail = sent[0]
    assert mail["to"] == [GAIL] and mail["subject"] == "Your Workflows This Week"
    assert "Hello Gail," in mail["html"] and "10/26/2026 to 11/02/2026" in mail["html"]
    assert "Daily Tick: 3 runs, 1 failed" in mail["html"]
    assert "Notified Max Sch: Tick for Greens Sch" in mail["html"] and "Emailed Max Sch: Weekly" in mail["html"]
    assert "too old" not in mail["html"] and "Other Tick" not in mail["html"]
    assert "/workflows" in mail["html"] and "Open In Nexus" in mail["html"]
    # claimed for the week: a later tick that Monday sends nothing; next Monday sends again
    assert db.get(models.WorkflowSubjectMark, (GAIL, "digest", week)) is not None
    assert runner.send_owner_digests(db, _local(2026, 11, 2, 12, 0)) == 0
    assert runner.send_owner_digests(db, _local(2026, 11, 9, 8, 30)) == 1 and len(sent) == 2
    # a laptop never mails and never claims
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: False)
    assert runner.send_owner_digests(db, _local(2026, 11, 16, 8, 30)) == 0
    assert db.get(models.WorkflowSubjectMark, (GAIL, "digest", week[:-2] + "47")) is None
    # the tick carries it
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    assert runner.tick(now=_local(2026, 11, 16, 8, 30))["digests"] == 1 and len(sent) == 3
    assert runner.tick(now=_local(2026, 11, 16, 8, 35))["digests"] == 0
