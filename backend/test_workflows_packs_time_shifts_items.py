"""Workflows (Oct 28 2026) - Task 11: the Time, Shifts and Items pack.

  * every event's sample is a payload of its entity's fields and changes;
  * `timesheet_review._round` writes one outbox row with the status from / to
    (and `signing` for the rounds that send the envelope right after);
  * `period.closed` fires once per person and period from the period-close
    scan; `time.add_time_batch` once per Add Time batch;
  * `shift_log.record("shared", ...)` fires `shift.shared`, `record("copied",
    ...)` nothing;
  * a checkout / assignment status change fires the Items event from the
    record observer alone - routers/items.py is never imported here;
  * a punch pair fires `punch.in` then `punch.out` only while subscribed;
  * `may_use` admits an administrator (and the module's grant) and refuses
    an employee;
  * the four list sources, scoped to the run's company.

Binds its own throwaway SQLite. Run ONE file per process:
    cd backend && python -m pytest test_workflows_packs_time_shifts_items.py -q
"""
import importlib
import json
import os
import sys
import tempfile
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import shift_log  # noqa: E402
import timesheet_alerts as ta  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext  # noqa: E402

emit_mod = importlib.import_module("workflows.emit")

CO, CO2 = "ent-wf-time", "ent-wf-other"
PRIYA, MAX, HANA = "priya.wf@greensglobal.com", "max.wf@greensglobal.com", "hana.wf@greensglobal.com"
OTTO = "otto.wf@greensglobal.com"                      # the other company
ERIN, GAIL, IVY = "erin.wf@greensglobal.com", "gail.wf@greensglobal.com", "ivy.wf@greensglobal.com"
EMPLOYEE = {"email": ERIN, "role": "employee", "level": 1}
ADMIN = {"email": GAIL, "role": "administrator", "level": 4}
ITEMS_USER = {"email": IVY, "role": "employee", "level": 1}    # holds the Item Management grant
PACK_MODULES = ("time", "shifts", "items")
PS, PE = "2026-10-04", "2026-10-17"      # a bi-weekly pay period after REVIEW_LAUNCH
PDT = 420


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.WorkflowEvent, models.TimesheetReview, models.TimePunch, models.ScheduledShift,
              models.ShiftChangeLog, models.ShiftGroup, models.ItemCheckout, models.ItemAssignment,
              models.NexusNotification, models.HrEntity, models.NexusRole, models.NexusGroup,
              models.NexusGroupMember, models.PayrollRate, models.TimeApproval, models.NexusSetting):
        s.query(m).delete(synchronize_session=False)
    s.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
    s.commit()
    s.add(models.HrEntity(id=CO, name="Greens Storage", country="US", hr_contact_email=HANA))
    s.add(models.HrEntity(id=CO2, name="Other Co", country="US"))
    people = ((PRIYA, CO, MAX, "Priya"), (MAX, CO, "", "Max"), (HANA, CO, "", "Hana"), (OTTO, CO2, "", "Otto"),
              (ERIN, CO, MAX, "Erin"), (GAIL, CO, "", "Gail"), (IVY, CO, "", "Ivy"))
    for em, co, mgr, first in people:
        s.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Test", work_email=em, company=co,
                                   manager_email=mgr, status="active", deleted_at="", country="US"))
    s.add(models.NexusGroup(id="g-items", name="Store", allowed_modules="inventory:viewer"))
    s.add(models.NexusGroupMember(group_id="g-items", email=IVY))
    s.commit()
    s.query(models.WorkflowEvent).delete()      # the observer's created rows for the people above
    s.commit()
    emit_mod.refresh_subscribed([])
    cache.module_grants.invalidate()
    auth._role_cache.clear()
    yield s
    s.rollback()
    s.close()


def _events(db, key=None):
    q = db.query(models.WorkflowEvent)
    if key:
        q = q.filter(models.WorkflowEvent.key == key)
    return q.order_by(models.WorkflowEvent.at).all()


def _review(db, status="with_manager", rounds=None, email=PRIYA, start=PS, end=PE):
    r = models.TimesheetReview(id=str(uuid.uuid4()), employee_email=email, period_start=start, period_end=end,
                               pay_type="hourly", status=status, manager_email=MAX, rounds=rounds or [],
                               last_snapshot={}, created_at=_now(), updated_at=_now())
    db.add(r)
    db.commit()
    db.query(models.WorkflowEvent).delete()
    db.commit()
    return r


def _shift(db, email=PRIYA, work_date="2026-11-02", published=1, **kw):
    row = models.ScheduledShift(id=str(uuid.uuid4()), employee_email=email, work_date=work_date, start_hhmm="07:00",
                                end_hhmm="15:30", label="Escondido", published=published, created_at=_now(), **kw)
    db.add(row)
    db.commit()
    return row


def _pack_events():
    return {k: ev for k, ev in catalog.EVENTS.items() if ev.module in PACK_MODULES}


# ── the catalog ──────────────────────────────────────────────────────────────
def test_pack_registers_the_events_and_list_sources():
    assert set(_pack_events()) == {
        "timesheet.review_changed", "period.closed", "time.add_time_batch", "punch.in", "punch.out",
        "shift.shared", "shift.changed", "shift.removed", "shift.claimed", "shift.no_show", "weather_call.decided",
        "item_checkout.created", "item_checkout.field_changed", "item_assignment.created",
        "item_assignment.field_changed",
    }
    assert {"timesheets.unsigned", "timesheets.not_reviewed", "shifts.open_tomorrow", "checkouts.overdue"} <= set(
        catalog.LIST_SOURCES)
    assert catalog.EVENTS["punch.in"].volume == "high" and catalog.EVENTS["punch.out"].volume == "high"
    for key in ("item_checkout", "item_assignment"):
        assert catalog.ENTITIES[key].observe and catalog.ENTITIES[key].observe_fields == ("status",)


def test_samples_validate():
    for key, ev in _pack_events().items():
        ent = catalog.ENTITIES[ev.entity]
        payload = catalog.sample_payload(ev)
        fields = {f.key for f in ent.fields}
        assert set(payload["subject"]) <= fields, key
        assert set(payload["changes"]) <= set(ev.changes), key
        for c in ev.changes:
            assert ent.field(c) is not None, (key, c)
        json.dumps(payload)
    json.dumps(catalog.snapshot())


def test_sample_payloads_render_through_the_context(db):
    ev = catalog.EVENTS["timesheet.review_changed"]
    ctx = RunContext(db=db, entity=catalog.ENTITIES["timesheet"], payload=catalog.sample_payload(ev),
                     run_as=ADMIN)
    assert ctx.resolve("subject.status") == "signing"
    assert ctx.resolve("change.status.from") == "with_manager"
    assert ctx.resolve("event.action") == "agreed"


# ── time ─────────────────────────────────────────────────────────────────────
def test_round_fires_one_row_with_from_and_to(db):
    r = _review(db)
    r.status = "with_employee"                      # set on an expired row: the from is read from the database
    tsr._round(db, r, by=MAX, action="sent_back", note="Fix Tuesday")
    assert db.query(models.WorkflowEvent).count() == 1      # same transaction
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.key == "timesheet.review_changed" and ev.entity == "timesheet" and ev.subject_id == r.id
    assert ev.payload["changes"]["status"] == {"from": "with_manager", "to": "with_employee"}
    assert ev.payload["extra"]["action"] == "sent_back" and ev.payload["extra"]["note"] == "Fix Tuesday"
    assert ev.actor == MAX and ev.company_id == CO
    sub = ev.payload["subject"]
    assert sub["employee"] == PRIYA and sub["period_start"] == PS and sub["reviewer"] == MAX
    assert sub["worked_min"] == 0 and sub["status"] == "with_employee"
    assert ev.payload["subjectLabel"].startswith("Time Sheet 10/04/2026 - 10/17/2026")


def test_agreed_round_reads_as_going_out_for_signature(db):
    r = _review(db)
    tsr._round(db, r, by=MAX, action="agreed", note="", with_changes=False)
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.payload["changes"]["status"] == {"from": "with_manager", "to": "signing"}


def test_worked_min_comes_from_the_newest_round(db):
    r = _review(db, rounds=[{"at": _ago(2), "by": PRIYA, "action": "submitted", "workedMin": 2400},
                            {"at": _ago(1), "by": MAX, "action": "sent_back", "workedMin": 2460}])
    assert r.wf_worked_min == 2460
    r.status = "with_employee"
    tsr._round(db, r, by=MAX, action="sent_back", note="Again")
    db.commit()
    assert db.query(models.WorkflowEvent).one().payload["subject"]["worked_min"] == 2460


def _punch(db, em, kind, local):
    at = (datetime.strptime(local, "%Y-%m-%dT%H:%M") + timedelta(minutes=PDT)).strftime("%Y-%m-%dT%H:%M:%S")
    db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=em, kind=kind, at=at, local_date=local[:10],
                            tz_offset_min=PDT, voided=0, created_at=at, source="web", geo_status=""))


def test_punch_links_to_the_time_sheet_of_its_period(db):
    db.add(models.PayrollRate(employee_email=PRIYA, pay_type="hourly", hourly_rate=20.0, overtime_rule="federal",
                              currency="USD"))
    _punch(db, PRIYA, "in", "2026-10-05T08:00")
    db.commit()
    row = db.query(models.TimePunch).filter(models.TimePunch.employee_email == PRIYA).one()
    ent = catalog.ENTITIES["punch"]
    link = ent.link_for(row, db)
    assert link["view"] == "hr" and link["sub"] == "hr-time" and link["timecard"] == PRIYA
    assert link["start"] == PS and link["payType"] == "hourly"              # the period the punch falls in
    assert ent.link_for(row) == {"view": "hr", "sub": "hr-time", "timecard": PRIYA}   # no session: no period
    ts = catalog.ENTITIES["timesheet"]
    assert set(ts.link_for(models.TimesheetReview(employee_email=PRIYA, period_start=PS, period_end=PE,
                                                  pay_type="hourly"))) == {"view", "sub", "timecard", "start", "payType"}


def test_period_closed_fires_once_per_person_and_period(db):
    db.add(models.PayrollRate(employee_email=PRIYA, pay_type="hourly", hourly_rate=20.0, overtime_rule="federal",
                              currency="USD"))
    _punch(db, PRIYA, "in", "2026-10-05T08:00")
    _punch(db, PRIYA, "out", "2026-10-05T16:00")
    db.commit()
    now = datetime(2026, 10, 19, 18, 0, tzinfo=timezone.utc)
    ta.scan(db, now_utc=now)
    evs = _events(db, "period.closed")
    assert len(evs) == 1
    ev = evs[0]
    assert ev.entity == "employee" and ev.subject_id == f"emp-{PRIYA}" and ev.company_id == CO
    assert ev.payload["extra"] == {"start": PS, "end": PE, "payType": "hourly", "approver": MAX}
    assert ev.payload["subject"]["work_email"] == PRIYA
    ta.scan(db, now_utc=now + timedelta(hours=1))          # the next tick: the same notice, no new row
    assert len(_events(db, "period.closed")) == 1


def test_add_time_batch_fires_one_event_with_the_dates(db):
    from routers import timeclock as T
    d1 = (date.today() - timedelta(days=9)).isoformat()
    d2 = (date.today() - timedelta(days=8)).isoformat()
    days = [T.AddTimeDay(date=d, in_at=f"{d}T15:00:00", out_at=f"{d}T23:00:00") for d in (d1, d2)]
    res = T.add_time(T.AddTimeIn(employee_email=PRIYA, reason="Paper time sheet from the site", days=days,
                                 tz_offset_min=PDT), user=ADMIN, db=db)
    assert res["added"] == 2
    evs = _events(db, "time.add_time_batch")
    assert len(evs) == 1
    ev = evs[0]
    assert ev.entity == "employee" and ev.subject_id == f"emp-{PRIYA}" and ev.actor == GAIL
    assert ev.payload["extra"]["dates"] == [d1, d2] and ev.payload["extra"]["batchId"] == res["batchId"]
    assert ev.payload["extra"]["minutes"] == 960 and ev.payload["extra"]["source"] == "manager"
    assert _events(db, "punch.in") == []                     # nobody subscribed: the high-volume rows stay off


def test_punch_pair_fires_in_then_out_only_when_subscribed(db):
    _punch(db, PRIYA, "in", "2026-10-28T08:00")
    db.commit()
    assert _events(db) == []
    emit_mod.refresh_subscribed(["punch.in", "punch.out"])
    _punch(db, PRIYA, "in", "2026-10-29T08:00")
    db.commit()
    _punch(db, PRIYA, "out", "2026-10-29T16:00")
    db.commit()
    evs = _events(db)
    assert [e.key for e in evs] == ["punch.in", "punch.out"]
    assert evs[0].entity == "punch" and evs[0].company_id == CO
    assert evs[0].payload["subject"]["employee"] == PRIYA and evs[0].payload["subject"]["kind"] == "in"
    assert evs[0].payload["subject"]["local_date"] == "2026-10-29"
    assert evs[1].payload["subject"]["kind"] == "out"
    emit_mod.refresh_subscribed([])
    _punch(db, PRIYA, "in", "2026-10-30T08:00")
    db.commit()
    assert len(_events(db)) == 2


def test_voided_and_break_punches_are_not_events(db):
    emit_mod.refresh_subscribed(["punch.in", "punch.out"])
    db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=PRIYA, kind="break_start", at="2026-10-29T19:00:00",
                            local_date="2026-10-29", voided=0))
    db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=PRIYA, kind="in", at="2026-10-29T15:00:00",
                            local_date="2026-10-29", voided=1))
    db.commit()
    assert _events(db) == []


# ── shifts ───────────────────────────────────────────────────────────────────
def test_shift_log_shared_fires_and_copied_does_not(db):
    row = _shift(db, group_id="")
    before = shift_log.snapshot(row)
    shift_log.record(db, "shared", row, MAX, before=before, after=before, publish_id="pub-1")
    db.commit()
    evs = _events(db)
    assert [e.key for e in evs] == ["shift.shared"]
    ev = evs[0]
    assert ev.entity == "shift" and ev.subject_id == row.id and ev.actor == MAX and ev.company_id == CO
    sub = ev.payload["subject"]
    assert sub["employee"] == PRIYA and sub["work_date"] == "2026-11-02" and sub["start"] == "07:00"
    assert sub["status"] == "shared"
    assert ev.payload["extra"]["action"] == "shared" and ev.payload["extra"]["publishId"] == "pub-1"
    assert ev.payload["extra"]["before"]["email"] == PRIYA
    shift_log.record(db, "copied", row, MAX, before=before, after=before)
    shift_log.record(db, "created", row, MAX, after=before)
    shift_log.record(db, "weather", row, MAX, before=before, after=before, reason="cancel: rain")
    db.commit()
    assert len(_events(db)) == 1
    assert db.query(models.ShiftChangeLog).count() == 4      # the log itself is untouched


def test_shift_log_action_map(db):
    row = _shift(db)
    for action, key in (("edited", "shift.changed"), ("moved", "shift.changed"), ("assigned", "shift.changed"),
                        ("removed", "shift.removed"), ("cleared", "shift.removed"), ("discarded", "shift.removed"),
                        ("claimed", "shift.claimed"), ("swapped", "shift.claimed")):
        db.query(models.WorkflowEvent).delete()
        db.commit()
        shift_log.record(db, action, row, MAX, before=shift_log.snapshot(row))
        db.commit()
        assert [e.key for e in _events(db)] == [key], action
    db.query(models.WorkflowEvent).delete()
    db.commit()
    shift_log.record(db, "released", {"id": row.id, "email": PRIYA, "date": row.work_date}, MAX)
    shift_log.record(db, "offered", row, MAX)
    db.commit()
    assert _events(db) == []


def test_open_shift_status_and_company_from_the_team(db):
    db.add(models.ShiftGroup(id="team-1", name="Escondido", company_id=CO2))
    db.commit()
    row = _shift(db, email="", open_slots=2, group_id="team-1")
    assert row.wf_status == "open"
    ent = catalog.ENTITIES["shift"]
    assert ent.company_of(row) == CO2
    assert ent.link_for(row) == {"view": "shifts", "sub": "schedule:2026-11-02:team-1"}


# ── items (observer only) ────────────────────────────────────────────────────
def test_checkout_status_change_fires_the_items_event_from_the_observer(db):
    assert "routers.items" not in sys.modules              # Visesh's file is never imported, never touched
    co = models.ItemCheckout(id="co-1", item_id="it-1", item_name="Hammer Drill", item_type="Tool",
                             requested_by="Priya Test", requested_by_email=PRIYA, raised_by="Priya Test",
                             days=3, status="pending", created_at=_ago(1), approver_email=MAX)
    db.add(co)
    db.commit()
    evs = _events(db)
    assert [e.key for e in evs] == ["item_checkout.created"]
    assert evs[0].payload["subject"]["item_name"] == "Hammer Drill" and evs[0].company_id == CO
    db.query(models.WorkflowEvent).delete()
    db.commit()
    co.status = "approved"
    db.flush()
    assert db.query(models.WorkflowEvent).count() == 1       # written by the flush, inside the transaction
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.key == "item_checkout.field_changed" and ev.entity == "item_checkout" and ev.subject_id == "co-1"
    assert ev.payload["changes"]["status"] == {"from": "pending", "to": "approved"}
    assert ev.payload["extra"] == {"field": "status"}
    sub = ev.payload["subject"]
    assert sub["requested_by_email"] == PRIYA and sub["approver_email"] == MAX and sub["days"] == 3
    assert sub["due_date"] == (datetime.now(timezone.utc) - timedelta(days=1) + timedelta(days=3)).date().isoformat()
    assert ev.payload["subjectLabel"] == "Hammer Drill - Priya Test"
    co.condition_note = "scratched"                          # not an observed field
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 1


def test_assignment_status_change_fires_from_the_observer(db):
    a = models.ItemAssignment(id="as-1", item_id="it-2", item_name="MacBook Pro 14", assignee_email=PRIYA,
                              assignee_name="Priya Test", assigned_by_email=IVY, status="pending_acceptance",
                              created_at=_now())
    db.add(a)
    db.commit()
    assert [e.key for e in _events(db)] == ["item_assignment.created"]
    db.query(models.WorkflowEvent).delete()
    db.commit()
    a.status = "active"
    a.accepted_at = _now()
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.key == "item_assignment.field_changed"
    assert ev.payload["changes"]["status"] == {"from": "pending_acceptance", "to": "active"}
    assert ev.payload["subject"]["assignee_email"] == PRIYA and ev.payload["subject"]["assigned_by_email"] == IVY
    ent = catalog.ENTITIES["item_assignment"]
    assert ent.people["self"](db, a) == [PRIYA] and ent.people["manager"](db, a) == [MAX]
    assert ent.people["assigned_by"](db, a) == [IVY]
    assert ent.link_for(a) == {"view": "inventory", "sub": "permanent"}
    assert catalog.ENTITIES["item_checkout"].link_for(a) == {"view": "inventory", "sub": "checkouts"}


def test_items_visible_to_the_person_their_manager_and_the_grant(db):
    co = models.ItemCheckout(id="co-2", item_id="it-1", item_name="Drill", requested_by="Priya",
                             requested_by_email=PRIYA, raised_by="Priya", days=1, status="pending",
                             created_at=_now())
    db.add(co)
    db.commit()
    ent = catalog.ENTITIES["item_checkout"]
    assert ent.can_see(db, {"email": PRIYA, "level": 1}, co)
    assert ent.can_see(db, {"email": MAX, "level": 1}, co)
    assert ent.can_see(db, ITEMS_USER, co)
    assert ent.can_see(db, ADMIN, co)
    assert not ent.can_see(db, EMPLOYEE, co)
    assert ent.can_see(db, None, co)      # Nexus reads every record's public fields (permissions review H6)


# ── access ───────────────────────────────────────────────────────────────────
def test_may_use_admits_an_administrator_and_refuses_an_employee(db):
    for key, ev in _pack_events().items():
        assert catalog.may_use_event(db, ADMIN, ev), key
        assert not catalog.may_use_event(db, EMPLOYEE, ev), key
        assert not catalog.may_use_event(db, None, ev), key


def test_may_use_follows_each_modules_grant(db):
    keys = {e["key"] for e in catalog.serialize(db, ITEMS_USER)["events"]}
    assert "item_checkout.field_changed" in keys and "item_assignment.created" in keys
    assert "timesheet.review_changed" not in keys and "shift.shared" not in keys
    manager = {"email": MAX, "role": "manager", "level": 3}
    keys = {e["key"] for e in catalog.serialize(db, manager)["events"]}
    assert "shift.shared" in keys and "weather_call.decided" in keys and "shift.no_show" in keys
    assert "timesheet.review_changed" not in keys and "item_checkout.field_changed" not in keys
    db.add(models.NexusGroup(id="g-hr", name="HR", allowed_modules="hr:viewer"))
    db.add(models.NexusGroupMember(group_id="g-hr", email=HANA))
    db.commit()
    cache.module_grants.invalidate()
    auth._role_cache.clear()
    keys = {e["key"] for e in catalog.serialize(db, {"email": HANA, "role": "employee", "level": 1})["events"]}
    assert {"timesheet.review_changed", "period.closed", "punch.in", "shift.shared"} <= keys
    assert "item_checkout.field_changed" not in keys


# ── list sources ─────────────────────────────────────────────────────────────
def _ctx(db, company_id=""):
    return RunContext(db=db, run_as=ADMIN, company_id=company_id, today=date.today())


def test_timesheets_unsigned_lists_cards_waiting_longer_than_n_days(db):
    old = _review(db, status="signing", rounds=[{"at": _ago(5), "by": MAX, "action": "agreed"}])
    _review(db, status="signing", rounds=[{"at": _ago(1), "by": MAX, "action": "agreed"}], start="2026-10-18",
            end="2026-10-31")
    other = _review(db, status="approved", rounds=[{"at": _ago(9), "by": MAX, "action": "approved"}], email=OTTO)
    _review(db, status="completed", rounds=[{"at": _ago(9), "by": MAX, "action": "agreed"}], email=ERIN)
    fn = catalog.LIST_SOURCES["timesheets.unsigned"].fn
    assert {r.id for r in fn(db, _ctx(db), {"days": 3})} == {old.id, other.id}
    assert [r.id for r in fn(db, _ctx(db, CO), {"days": 3})] == [old.id]
    assert [r.id for r in fn(db, _ctx(db, CO2), {})] == [other.id]
    assert len(fn(db, _ctx(db), {"days": 0})) == 3          # 0 = every card out for a signature


def test_timesheets_not_reviewed_lists_closed_periods_still_with_the_manager(db):
    past = _review(db, status="with_manager")
    future_end = (date.today() + timedelta(days=5)).isoformat()
    _review(db, status="with_manager", start=(date.today() - timedelta(days=8)).isoformat(), end=future_end)
    _review(db, status="with_employee", email=ERIN)
    other = _review(db, status="with_manager", email=OTTO)
    fn = catalog.LIST_SOURCES["timesheets.not_reviewed"].fn
    assert {r.id for r in fn(db, _ctx(db), {})} == {past.id, other.id}
    assert [r.id for r in fn(db, _ctx(db, CO), {})] == [past.id]


def test_shifts_open_tomorrow(db):
    db.add(models.ShiftGroup(id="team-co", name="Escondido", company_id=CO))
    db.add(models.ShiftGroup(id="team-other", name="Austin", company_id=CO2))
    db.add(models.ShiftGroup(id="team-shared", name="Floaters", company_id=""))
    db.commit()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    mine = _shift(db, email="", work_date=tomorrow, open_slots=1, group_id="team-co")
    shared = _shift(db, email="", work_date=tomorrow, open_slots=2, group_id="team-shared")
    theirs = _shift(db, email="", work_date=tomorrow, open_slots=1, group_id="team-other")
    _shift(db, email="", work_date=tomorrow, open_slots=1, group_id="team-co", published=0)      # a draft
    _shift(db, email="", work_date=date.today().isoformat(), open_slots=1, group_id="team-co")  # today
    _shift(db, email=PRIYA, work_date=tomorrow, group_id="team-co")                             # assigned
    fn = catalog.LIST_SOURCES["shifts.open_tomorrow"].fn
    assert {r.id for r in fn(db, _ctx(db), {})} == {mine.id, shared.id, theirs.id}
    assert {r.id for r in fn(db, _ctx(db, CO), {})} == {mine.id, shared.id}


def test_checkouts_overdue(db):
    def co(cid, email, handed_days_ago, days, status="allocated"):
        row = models.ItemCheckout(id=cid, item_id="it", item_name=f"Item {cid}", requested_by="x",
                                  requested_by_email=email, raised_by="x", days=days, status=status,
                                  created_at=_ago(handed_days_ago + 1), handed_over_at=_ago(handed_days_ago))
        db.add(row)
        return row
    late = co("late", PRIYA, 10, 3)
    co("fine", PRIYA, 1, 3)
    co("back", PRIYA, 10, 3, status="returned")
    other = co("other", OTTO, 10, 3)
    db.commit()
    fn = catalog.LIST_SOURCES["checkouts.overdue"].fn
    assert {r.id for r in fn(db, _ctx(db), {})} == {late.id, other.id}
    assert [r.id for r in fn(db, _ctx(db, CO), {})] == [late.id]
    assert late.wf_due_date < date.today().isoformat()
