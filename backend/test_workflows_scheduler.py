"""Workflows (Oct 28 2026) - Task 7: schedules and date triggers.

  * a daily schedule fires once per company per period, in the company's
    zone, and catches up a period whose time passed - never twice;
  * a weekly schedule fires only on its listed days; an every-company
    schedule runs once per company with the company as the subject;
  * a date trigger with offset -14 fires on the right day; a yearly date
    (work anniversary) matches month and day;
  * the claim on the dedupe key is atomic (the composite primary key).

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

ENTITY, OTHER = "ent-sch", "ent-sch-other"
GAIL, PRIYA, MAX = "gail.sch@greensglobal.com", "priya.sch@greensglobal.com", "max.sch@greensglobal.com"
ZONE = ZoneInfo("America/Los_Angeles")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    # a throwaway record kind only Max may see (H6): the person rows, read
    # through a rule that refuses the Global Admin who owns the workflow
    catalog.entity("test_dated_secret", label="Dated Secret", model=models.NexusEmployee, module="core",
                   company=lambda row: row.company,
                   people={"self": lambda db, row: [row.work_email], "manager": lambda db, row: [row.manager_email]},
                   fields=[catalog.F("name", "Name", "text", path="__label__"),
                           catalog.F("start_date", "Start Date", "date")],
                   dates=["start_date"], label_of=lambda row: f"{row.first_name} {row.last_name}",
                   visible_to=lambda db, user, row: (user or {}).get("email") == MAX)
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


def test_date_trigger_never_runs_on_a_record_the_owner_may_not_see(db):
    """H6: the date scan finds the row, the claim is taken, but no run
    starts (a skipped row says why when logSkips is on) - nothing about
    the record reaches anyone."""
    trigger = {"kind": "date", "entity": "test_dated_secret", "field": "start_date", "offsetDays": 0, "time": "08:00"}
    definition = {"v": 1, "trigger": trigger, "conditions": [], "steps": [DATE_NOTIFY],
                  "settings": {**validate.DEFAULT_SETTINGS, "logSkips": True}}
    wf = store.create(db, name="Secret Dates", owner=GAIL, company_id=ENTITY, definition=definition, by=GAIL)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, GAIL)
    db.commit()
    _person(db, "e-psecret", "2026-11-03")
    assert len(scheduler.due_dates(db, _local(2026, 11, 3, 9, 0))) == 1
    assert runner.fire_dates(db, _local(2026, 11, 3, 9, 0)) == 1      # the skipped row is all that is written
    run = db.query(models.WorkflowRun).one()
    assert run.status == "skipped" and run.summary == "Not visible to the owner" and run.subject_id == "e-psecret"
    assert db.query(models.NexusNotification).count() == 0
    assert runner.fire_dates(db, _local(2026, 11, 3, 10, 0)) == 0        # claimed: never retried the same day


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
