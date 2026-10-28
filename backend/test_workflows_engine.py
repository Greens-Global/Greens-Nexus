"""Workflows (Oct 28 2026) - Task 7: the engine, the store and the runner.

  * an event starts only active workflows whose scope admits its company
    (a blank company never reaches a one-company workflow - Review Focus 1);
  * a conditions miss is a skipped run only with logSkips on;
  * steps run in order, each committed; a step that fails half-way through
    its sends is retried and never sends twice (Review Focus 2);
  * a Wait parks the run and a resume continues it; once per subject and
    the cooldown hold; the hourly cap pauses the workflow and bells the
    owner; no chaining by default and never past depth 2;
  * pause-all stops new runs but a run waiting on an approval finishes
    when the decision arrives (Review Focus 4); a company switch blocks
    that company only;
  * a Test writes a `test` run and no effects; Replay starts from the
    failed step; an owner who left pauses the workflow as needs_attention;
  * If / Else, For Each, fault steps, the runner's tick.

    cd backend && python -m pytest test_workflows_engine.py -q
"""
import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import workflows  # noqa: E402
from workflows import approvals, catalog, engine, runner, store, validate  # noqa: E402
from workflows import settings as wf_settings  # noqa: E402
from workflows.errors import TransientError  # noqa: E402

ENTITY, OTHER = "ent-eng", "ent-eng-other"
OWNER, PRIYA, MAX, HANA, GAIL = ("owen.eng@greensglobal.com", "priya.eng@greensglobal.com",
                                 "max.eng@greensglobal.com", "hana.eng@greensglobal.com",
                                 "gail.eng@greensglobal.com")
FLAKY = {"fail_once": True, "calls": []}
BOOM = {"on": True}


def _flaky_run(ctx, params):
    sent = ctx.step_output.setdefault("sent", [])
    for who in ["a@x.com", "b@x.com", "c@x.com"]:
        if who in sent:
            continue
        if who == "b@x.com" and FLAKY["fail_once"]:
            FLAKY["fail_once"] = False
            raise TransientError("Graph down")
        FLAKY["calls"].append(who)
        sent.append(who)
    return {"line": f"Sent to {len(sent)}", "sent": list(sent), "affected": []}


def _boom_run(ctx, params):
    if BOOM["on"]:
        raise RuntimeError("Kaboom")
    return {"line": "Boom done", "sent": [], "affected": []}


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    catalog.action("test.flaky", label="Flaky Send", module="core", params=[],
                   plan=lambda ctx, p: "Would send to 3", run=_flaky_run, needs_person=False)
    catalog.action("test.boom", label="Boom", module="core", params=[],
                   plan=lambda ctx, p: "Would boom", run=_boom_run, needs_person=False)
    catalog.list_source("test.people", label="Test People", entity="employee", module="hr", params=[],
                        fn=lambda db, ctx, p: db.query(models.NexusEmployee)
                        .filter(models.NexusEmployee.company == ENTITY, models.NexusEmployee.status == "active")
                        .order_by(models.NexusEmployee.work_email).all())
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Eng", hr_contact_email=HANA))
    s.add(models.HrEntity(id=OTHER, name="Other Eng"))
    for i, (email, first, company) in enumerate([(OWNER, "Owen", ENTITY), (PRIYA, "Priya", ENTITY), (MAX, "Max", ENTITY),
                                                 (HANA, "Hana", ENTITY), (GAIL, "Gail", ENTITY)]):
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Eng",
                                   company=company, status="active", manager_email=MAX if email == PRIYA else "",
                                   start_date="2026-11-12", department="Operations"))
    s.add(models.NexusEmployee(id="e-zed", work_email="zed.eng@greensglobal.com", first_name="Zed", last_name="Other",
                               company=OTHER, status="active", department="Sales"))
    # the catalog sample's manager, so a Test against the sample resolves a person
    s.add(models.NexusEmployee(id="e-sample-mgr", work_email="max.miller@greensglobal.com", first_name="Max",
                               last_name="Miller", company=ENTITY, status="active"))
    s.add(models.NexusRole(email=OWNER, role="manager"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusGroup(id="g-eng", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-eng", email=OWNER))
    s.add(models.NexusGroup(id="g-eng-hr", name="HR", allowed_modules="hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-eng-hr", email=HANA))
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
    s.commit()
    FLAKY.update(fail_once=True, calls=[])
    BOOM["on"] = True
    yield s
    s.rollback()
    s.close()


NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
          "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} is now {{ change.status.to }}"}}
NOTIFY2 = {"id": "n2", "kind": "action", "action": "notify",
           "params": {"to": [{"kind": "role", "value": "hr_contact"}], "title": "Second: {{ subject.name }}"}}
TRIGGER = {"kind": "event", "event": "employee.status_changed"}


def _wf(db, *, steps, trigger=None, conditions=None, settings=None, company=ENTITY, owner=OWNER, run_as="owner",
        name="Status Watch", publish=True):
    definition = {"v": 1, "trigger": trigger or TRIGGER, "conditions": conditions or [], "steps": steps,
                  "settings": {**validate.DEFAULT_SETTINGS, **(settings or {})}}
    wf = store.create(db, name=name, owner=owner, company_id=company, definition=definition, by=owner, run_as=run_as)
    db.commit()
    if publish:
        wf.tested_hash = validate.definition_hash(store.draft_of(wf))
        store.publish(db, wf, owner)
        db.commit()
    return wf


def _event(db, who="e-priya", key="employee.status_changed", changes=None, company_id=None, actor=HANA):
    row = db.get(models.NexusEmployee, who)
    workflows.emit(db, key, subject=row, actor=actor,
                   changes=changes if changes is not None else {"status": ("active", "offboarded")},
                   company_id=company_id)
    db.commit()
    return db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at.desc()).first()


def _runs(db, wf=None):
    q = db.query(models.WorkflowRun)
    if wf is not None:
        q = q.filter(models.WorkflowRun.workflow_id == wf.id)
    return q.order_by(models.WorkflowRun.started_at).all()


def _steps(db, run):
    return [s for s in store.run_steps(db, run) if s.kind != "conditions"]


# ── matching ─────────────────────────────────────────────────────────────────
def test_event_matches_active_workflow_in_scope_and_not_other_company(db):
    mine = _wf(db, steps=[NOTIFY], company=ENTITY)
    everyone = _wf(db, steps=[NOTIFY], company="", owner=GAIL, name="Everyone")
    draft = _wf(db, steps=[NOTIFY], publish=False, name="Draft")
    ev_mine = _event(db, "e-priya")
    ev_other = _event(db, "e-zed")
    ev_blank = _event(db, "e-priya", company_id="")
    assert {w.id for w in engine.match(db, ev_mine)} == {mine.id, everyone.id}
    assert {w.id for w in engine.match(db, ev_other)} == {everyone.id}
    # a blank company never reaches a one-company workflow (the entity has a company)
    assert engine.match(db, ev_blank) == []
    assert draft.status == "draft"


def test_conditions_fail_logs_skip_only_when_logSkips(db):
    quiet = _wf(db, steps=[NOTIFY], conditions=[[{"field": "department", "op": "is", "value": "Sales"}]])
    ev = _event(db)
    assert engine.handle_event(db, ev) == [] and _runs(db) == []
    loud = _wf(db, steps=[NOTIFY], conditions=[[{"field": "department", "op": "is", "value": "Sales"}]],
               settings={"logSkips": True}, name="Loud")
    runs = engine.handle_event(db, _event(db))
    assert [r.workflow_id for r in runs] == [loud.id]
    assert runs[0].status == "skipped" and runs[0].summary == "Conditions did not match"
    out = store.serialize_run(db, runs[0], steps=True)
    assert out["trace"][0]["field"] == "department" and out["trace"][0]["actual"] == "Operations"
    assert out["conditionsPassed"] is False
    assert quiet.run_count == 0


# ── steps ────────────────────────────────────────────────────────────────────
def test_steps_run_in_order_and_commit_each(db):
    wf = _wf(db, steps=[NOTIFY, NOTIFY2])
    runs = engine.handle_event(db, _event(db))
    run = runs[0]
    assert run.status == "succeeded" and run.subject_label == "Priya Eng" and run.company_id == ENTITY
    rows = _steps(db, run)
    assert [r.step_id for r in rows] == ["n1", "n2"] and all(r.status == "done" for r in rows)
    assert rows[0].detail == "Notified Max Eng: Priya Eng is now offboarded"
    assert rows[0].input["rendered"]["title"] == "Priya Eng is now offboarded"
    assert rows[0].output["sent"] == [MAX]
    notes = db.query(models.NexusNotification).all()
    assert {n.recipient for n in notes} == {MAX, HANA}
    db.refresh(wf)
    assert wf.run_count == 1 and wf.last_run_at == run.finished_at
    assert run.summary == "Notified Hana Eng: Second: Priya Eng"
    assert db.get(models.WorkflowSubjectMark, (wf.id, "employee", "e-priya")) is not None
    # the run names its version and the event
    out = store.serialize_run(db, run, steps=True)
    assert out["version"] == 1 and out["event"]["key"] == "employee.status_changed"
    assert out["subjectLink"] == {"view": "hr", "sub": "people:e-priya"}


def test_failed_step_mid_run_does_not_resend_on_retry(db):
    wf = _wf(db, steps=[{"id": "f1", "kind": "action", "action": "test.flaky", "params": {}}, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "waiting"
    row = _steps(db, run)[0]
    assert row.status == "waiting" and row.attempt == 1 and row.output["sent"] == ["a@x.com"]
    assert "Retry 1 of 3" in row.detail
    wait = db.query(models.WorkflowWait).one()
    assert wait.kind == "retry" and wait.step_id == "f1"
    due = datetime.fromisoformat(wait.due_at)
    assert timedelta(seconds=50) < due - datetime.now(timezone.utc) <= timedelta(minutes=1)
    # the retry: only b and c go out
    run = engine.resume(db, wait)
    assert run.status == "succeeded"
    assert FLAKY["calls"] == ["a@x.com", "b@x.com", "c@x.com"]
    row = _steps(db, run)[0]
    assert row.status == "done" and row.attempt == 2 and row.output["sent"] == ["a@x.com", "b@x.com", "c@x.com"]
    assert _steps(db, run)[1].status == "done"
    assert db.query(models.WorkflowWait).count() == 0
    db.refresh(wf)
    assert wf.run_count == 1 and wf.fail_count == 0


def test_transient_failure_gives_up_after_three_attempts_and_bells_owner(db):
    _wf(db, steps=[{"id": "f1", "kind": "action", "action": "test.flaky", "params": {}}])
    FLAKY["fail_once"] = True
    run = engine.handle_event(db, _event(db))[0]
    for _ in range(2):
        FLAKY["fail_once"] = True
        run = engine.resume(db, db.query(models.WorkflowWait).one())
    FLAKY["fail_once"] = True
    assert run.status == "waiting"
    run = engine.resume(db, db.query(models.WorkflowWait).one())
    assert run.status == "failed" and "Failed after 4 attempts" in run.error
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OWNER).one()
    assert bell.title == "Workflow Failed: Status Watch" and bell.priority == 1


def test_wait_parks_run_and_resume_continues(db):
    wf = _wf(db, steps=[NOTIFY, {"id": "w1", "kind": "wait", "params": {"mode": "duration", "minutes": 60}}, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "waiting"
    rows = _steps(db, run)
    assert [r.status for r in rows] == ["done", "waiting"]
    wait = db.query(models.WorkflowWait).one()
    assert wait.kind == "delay" and wait.run_id == run.id
    assert timedelta(minutes=59) < datetime.fromisoformat(wait.due_at) - datetime.now(timezone.utc) <= timedelta(minutes=60)
    assert db.query(models.NexusNotification).count() == 1
    run = engine.resume(db, wait)
    assert run.status == "succeeded"
    assert [r.status for r in _steps(db, run)] == ["done", "done", "done"]
    assert db.query(models.NexusNotification).count() == 2
    db.refresh(wf)
    assert wf.run_count == 1


def test_once_per_subject_and_cooldown(db):
    once = _wf(db, steps=[NOTIFY], settings={"oncePerSubject": True})
    assert len(engine.handle_event(db, _event(db))) == 1
    assert engine.handle_event(db, _event(db)) == []
    assert len(engine.handle_event(db, _event(db, "e-max", changes={"status": ("active", "inactive")}))) == 1
    cool = _wf(db, steps=[NOTIFY], settings={"cooldownHours": 2, "logSkips": True}, name="Cool")
    first = [r for r in engine.handle_event(db, _event(db)) if r.workflow_id == cool.id][0]
    assert first.status == "succeeded"
    again = [r for r in engine.handle_event(db, _event(db)) if r.workflow_id == cool.id][0]
    assert again.status == "skipped" and "Cooldown" in again.summary
    mark = db.get(models.WorkflowSubjectMark, (cool.id, "employee", "e-priya"))
    mark.last_run_at = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    db.commit()
    later = [r for r in engine.handle_event(db, _event(db)) if r.workflow_id == cool.id][0]
    assert later.status == "succeeded"
    assert once.run_count == 2


def test_runs_per_hour_cap_pauses_workflow_and_bells_owner(db):
    wf = _wf(db, steps=[NOTIFY], settings={"maxRunsPerHour": 2})
    assert len(engine.handle_event(db, _event(db))) == 1
    assert len(engine.handle_event(db, _event(db))) == 1
    assert engine.handle_event(db, _event(db)) == []
    db.refresh(wf)
    assert wf.status == "needs_attention" and wf.paused_reason == "Paused: ran 2 times in an hour (the cap is 2)"
    bells = db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == f"wf-attention:{wf.id}").all()
    assert {b.recipient for b in bells} == {OWNER, GAIL}
    assert bells[0].title == "Workflow Needs Attention: Status Watch"
    # paused: the next event does not even match
    assert engine.match(db, _event(db)) == []
    # the audit row says the system paused it
    log = db.query(models.AuditLog).filter(models.AuditLog.action == "workflow.needs_attention").one()
    assert log.user_email == engine.NEXUS_ACTOR and log.module == "workflows"


def test_no_chaining_by_default_and_depth_cap_2(db):
    plain = _wf(db, steps=[NOTIFY])
    down = _wf(db, steps=[NOTIFY], settings={"allowDownstream": True}, name="Downstream")
    run = engine.handle_event(db, _event(db))
    assert len(run) == 2
    other_run = next(r for r in run if r.workflow_id == plain.id)
    # an event a run caused
    tok = workflows.CURRENT_RUN.set((other_run.id, 0))
    try:
        ev1 = _event(db)
    finally:
        workflows.CURRENT_RUN.reset(tok)
    assert ev1.caused_by_run == other_run.id and ev1.depth == 1
    assert [w.id for w in engine.match(db, ev1)] == [down.id]
    # an event caused by the downstream run itself (depth 1) -> depth 2 events start nothing
    down_run = [r for r in engine.handle_event(db, ev1)][0]
    assert down_run.depth == 1
    tok = workflows.CURRENT_RUN.set((down_run.id, 1))
    try:
        ev2 = _event(db)
    finally:
        workflows.CURRENT_RUN.reset(tok)
    assert ev2.depth == 2 and engine.match(db, ev2) == []
    # a workflow never reacts to its own run
    tok = workflows.CURRENT_RUN.set((down_run.id, 0))
    try:
        ev3 = _event(db)
    finally:
        workflows.CURRENT_RUN.reset(tok)
    assert engine.match(db, ev3) == []


APPROVAL = {"id": "ap1", "kind": "approval",
            "params": {"approvers": [{"kind": "manager"}], "mode": "any", "question": "Let {{ subject.name }} go?",
                       "options": ["Approve", "Decline"]},
            "branches": {"Approve": [NOTIFY2], "Decline": [{"id": "st", "kind": "stop"}]}}


def test_paused_all_blocks_new_runs_but_approval_resume_finishes(db):
    _wf(db, steps=[APPROVAL])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "waiting"
    ap = db.query(models.WorkflowApproval).one()
    assert ap.approvers == [MAX] and ap.question == "Let Priya Eng go?" and ap.outcome == ""
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MAX).one()
    assert bell.title == "Approval Needed: Status Watch"
    wf_settings.pause_all(db, True, GAIL)
    db.commit()
    assert engine.handle_event(db, _event(db)) == []
    assert runner.tick()["events"] == 0          # the tick claims nothing while paused
    result = approvals.decide(db, ap, {"email": MAX, "role": "manager", "level": 3}, "Approve", "fine")
    assert result["decided"] and result["runStatus"] == "succeeded"
    run = db.get(models.WorkflowRun, run.id)
    assert run.status == "succeeded"
    rows = _steps(db, run)
    assert [r.step_id for r in rows] == ["ap1", "ap1/Approve/n2"]
    assert rows[0].output["outcome"] == "Approve" and rows[1].status == "done"
    assert db.query(models.NexusNotification).filter(models.NexusNotification.recipient == HANA).count() == 1
    wf_settings.pause_all(db, False, GAIL)
    db.commit()


def test_company_switch_blocks_that_company_only(db):
    _wf(db, steps=[NOTIFY], company="", owner=GAIL, settings={"logSkips": True})
    wf_settings.save(db, OTHER, {"enabled": False}, GAIL)
    db.commit()
    assert wf_settings.get(db, OTHER)["enabled"] is False and wf_settings.get(db, ENTITY)["enabled"] is True
    mine = engine.handle_event(db, _event(db, "e-priya"))[0]
    other = engine.handle_event(db, _event(db, "e-zed"))[0]
    assert mine.status == "succeeded"
    assert other.status == "skipped" and "switched off" in other.summary


# ── the dry run, replay, health ──────────────────────────────────────────────
def test_plan_only_writes_test_run_and_no_effects(db):
    wf = _wf(db, steps=[NOTIFY, {"id": "w1", "kind": "wait", "params": {"mode": "duration", "minutes": 30}}, APPROVAL],
             publish=False)
    assert not store.tested_current(wf)
    run = engine.test_run(db, wf, by=OWNER)
    assert run.status == "test" and run.subject_label == "Priya Shah"      # the catalog sample
    rows = _steps(db, run)
    assert [(r.step_id, r.status) for r in rows] == [("n1", "planned"), ("w1", "planned"), ("ap1", "planned")]
    assert rows[0].detail == "Would notify Max Miller: Priya Shah is now offboarded"
    assert rows[1].detail.startswith("20") and "T" in rows[1].detail       # the ISO time it would wait until
    assert rows[2].detail.startswith("Would ask the manager")
    assert db.query(models.NexusNotification).count() == 0 and db.query(models.WorkflowApproval).count() == 0
    assert db.query(models.WorkflowWait).count() == 0
    db.refresh(wf)
    assert store.tested_current(wf) and wf.last_tested_at
    # a real recent event as the subject
    ev = _event(db)
    run = engine.test_run(db, wf, event=ev, by=OWNER)
    assert run.subject_label == "Priya Eng" and run.event_id == ev.id
    out = store.serialize_run(db, run, steps=True)
    assert out["steps"][0]["detail"] == "Would notify Max Eng: Priya Eng is now offboarded"
    # an edit after the test needs a new test
    d = store.draft_of(wf)
    d["steps"][0]["params"]["title"] = "Changed"
    store.save_draft(db, wf, d, OWNER)
    db.commit()
    assert not store.tested_current(wf)
    with pytest.raises(store.NotTested):
        store.publish(db, wf, OWNER)


def test_replay_starts_from_failed_step(db):
    wf = _wf(db, steps=[NOTIFY, {"id": "b1", "kind": "action", "action": "test.boom", "params": {}}, NOTIFY2])
    run = engine.handle_event(db, _event(db))[0]
    assert run.status == "failed" and run.error == "Boom: RuntimeError: Kaboom"
    assert [r.status for r in _steps(db, run)] == ["done", "failed"]
    db.refresh(wf)
    assert wf.fail_count == 1
    assert db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MAX).count() == 1
    BOOM["on"] = False
    new = engine.replay(db, run, OWNER)
    assert new.status == "succeeded" and new.replay_of == run.id and new.trigger_kind == "replay"
    assert [(r.step_id, r.status) for r in _steps(db, new)] == [("n1", "done"), ("b1", "done"), ("n2", "done")]
    # the first step was not run again
    assert db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MAX).count() == 1
    assert db.query(models.NexusNotification).filter(models.NexusNotification.recipient == HANA).count() == 1
    with pytest.raises(ValueError):
        engine.replay(db, new, OWNER)


def test_on_error_continue_and_fault_steps(db):
    fault = [{"id": "fx", "kind": "action", "action": "notify",
              "params": {"to": [{"kind": "owner"}], "title": "Fault: {{ workflow.name }}"}}]
    _wf(db, steps=[{"id": "b1", "kind": "action", "action": "test.boom", "params": {}}, NOTIFY2],
        settings={"onError": "continue", "faultSteps": fault})
    run = engine.handle_event(db, _event(db))[0]
    # continue: the second step still ran, the run succeeded with the failure on the step
    assert run.status == "succeeded"
    assert [r.status for r in _steps(db, run)] == ["failed", "done"]
    _wf(db, steps=[{"id": "b1", "kind": "action", "action": "test.boom", "params": {}}, NOTIFY2],
        settings={"onError": "stop", "faultSteps": fault}, name="Stopper")
    runs = engine.handle_event(db, _event(db))
    failed = next(r for r in runs if r.workflow_name == "Stopper")
    assert failed.status == "failed"
    rows = _steps(db, failed)
    assert [(r.step_id, r.status) for r in rows] == [("b1", "failed"), ("fault/fx", "done")]
    owner_bells = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OWNER).all()
    assert {b.title for b in owner_bells} == {"Fault: Stopper", "Workflow Failed: Stopper"}


def test_owner_gone_marks_needs_attention(db):
    wf = _wf(db, steps=[NOTIFY])
    assert engine.check_health(db, wf) == ""
    owner = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == OWNER).one()
    owner.status = "offboarded"
    db.commit()
    try:
        assert engine.check_health(db, wf) == "Paused: the owner is no longer a current person"
        assert runner.check_health(db) == 1
        db.refresh(wf)
        assert wf.status == "needs_attention"
    finally:
        owner.status = "active"
        db.commit()
    gone = _wf(db, steps=[{"id": "x", "kind": "action", "action": "notify",
                           "params": {"to": [{"kind": "self"}], "title": "x"}}], name="Gone")
    gone.steps = [{"id": "x", "kind": "action", "action": "vanished.action", "params": {}}]
    db.commit()
    assert engine.check_health(db, gone) == "Paused: the action vanished.action no longer exists"


def test_if_else_and_for_each(db):
    steps = [{"id": "i1", "kind": "if", "conditions": [{"field": "department", "op": "is", "value": "Sales"}],
              "then": [{"id": "t1", "kind": "stop"}], "else": [NOTIFY]},
             {"id": "fe", "kind": "for_each", "source": {"key": "test.people", "params": {}}, "as": "item",
              "steps": [{"id": "e1", "kind": "action", "action": "notify",
                         "params": {"to": [{"kind": "self"}], "title": "Hello {{ item.name }}"}}]}]
    run = engine.handle_event(db, _event(db))[0] if _wf(db, steps=steps) else None
    assert run.status == "succeeded"
    rows = _steps(db, run)
    ids = [r.step_id for r in rows]
    assert ids[:3] == ["i1", "i1/n1", "fe"]
    assert rows[0].output["branch"] == "else" and rows[0].detail == "Took the Else branch"
    assert rows[2].output["count"] == 6 and rows[2].detail == "6 items"
    assert ids[3:] == [f"fe#{i}/e1" for i in range(6)]
    assert rows[3].label == "Send A Notification - Gail Eng" and rows[3].detail == "Notified Gail Eng: Hello Gail Eng"
    assert db.query(models.NexusNotification).count() == 7


# ── the runner ───────────────────────────────────────────────────────────────
def test_runner_tick_claims_and_processes_once(db):
    wf = _wf(db, steps=[NOTIFY])
    ev = _event(db)
    out = runner.tick()
    assert out["events"] == 1 and out["runs"] == 1
    db.expire_all()
    ev = db.get(models.WorkflowEvent, ev.id)
    assert ev.processed_at and ev.attempts == 1
    assert runner.tick()["events"] == 0
    assert len(_runs(db, wf)) == 1
    # the subscribed-key setting names the active workflows' events
    row = db.get(models.NexusSetting, "workflows.subscribed")
    assert row is not None and "employee.status_changed" in row.value


def test_runner_tick_claims_nothing_off_the_deployed_worker(db, monkeypatch):
    # a laptop on the shared Postgres wins the lease but must drain nothing
    wf = _wf(db, steps=[NOTIFY])
    ev = _event(db)
    real = runner.may_run_here
    monkeypatch.setattr(runner, "may_run_here", lambda: False)
    out = runner.tick()
    assert out["skipped"] == "not the deployed worker" and out["events"] == 0 and out["runs"] == 0
    db.expire_all()
    assert db.get(models.WorkflowEvent, ev.id).processed_at == "" and _runs(db, wf) == []
    monkeypatch.setattr(runner, "may_run_here", lambda: True)
    assert runner.tick()["events"] == 1
    # the real rule: the deployed API, or this process's own SQLite (the tests)
    import leader
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: False)
    assert real() is True
    import types
    import database
    monkeypatch.setattr(database, "engine", types.SimpleNamespace(url=types.SimpleNamespace(get_backend_name=lambda: "postgresql")))
    assert real() is False
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    assert real() is True


def test_runner_resumes_due_waits(db):
    wf = _wf(db, steps=[NOTIFY, {"id": "w1", "kind": "wait", "params": {"mode": "duration", "minutes": 1}}, NOTIFY2])
    _event(db)
    assert runner.tick()["runs"] == 1
    run = _runs(db, wf)[0]
    assert run.status == "waiting"
    assert runner.tick()["resumed"] == 0
    out = runner.tick(now=datetime.now(timezone.utc) + timedelta(minutes=2))
    assert out["resumed"] == 1
    db.expire_all()
    assert db.get(models.WorkflowRun, run.id).status == "succeeded"


def test_runner_purges_old_rows_and_reports_wanted_ones(db):
    old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    db.add(models.WorkflowEvent(id="old-1", key="employee.status_changed", entity="employee", at=old, processed_at="",
                                wanted=1, payload={}))
    db.add(models.WorkflowEvent(id="old-2", key="employee.status_changed", entity="employee", at=old, processed_at="",
                                wanted=0, payload={}))
    db.commit()
    out = runner.tick(force_purge=True)
    assert out["purged"] == 2 and db.query(models.WorkflowEvent).count() == 0
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == "wf-outbox-dropped").all()
    assert {b.recipient for b in bell} == {GAIL} and "1 event a workflow wanted" in bell[0].body


# ── the store ────────────────────────────────────────────────────────────────
def test_publish_writes_version_audit_and_refuses_problems(db):
    wf = _wf(db, steps=[NOTIFY], publish=False)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    ver = store.publish(db, wf, OWNER, note="first")
    db.commit()
    assert wf.version == 1 and wf.status == "active" and wf.draft is None and ver.note == "first"
    log = db.query(models.AuditLog).filter(models.AuditLog.action == "workflow.publish").one()
    assert log.resource_id == wf.id and log.module == "workflows" and log.user_email == OWNER
    d = store.draft_of(wf)
    d["steps"][0]["params"]["title"] = "{{ subject.nope }}"
    store.save_draft(db, wf, d, OWNER)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    with pytest.raises(store.ValidationError) as e:
        store.publish(db, wf, OWNER)
    assert e.value.problems[0].path == "steps[0].params.title"
    # the published definition kept running meanwhile
    assert store.definition_of(wf)["steps"][0]["params"]["title"] == NOTIFY["params"]["title"]
    out = store.serialize(db, wf, full=True)
    assert out["problems"][0]["path"] == "steps[0].params.title" and out["hasDraft"] and out["versions"] == 1
    assert out["triggerText"] == "When Person Status Changes" and out["ownerName"] == "Owen Eng"


def test_diff_restore_and_duplicate(db):
    wf = _wf(db, steps=[NOTIFY])
    d = store.draft_of(wf)
    d["steps"][0]["params"]["to"] = [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}]
    d["steps"].append({"id": "s2", "kind": "stop"})
    d["settings"]["maxRunsPerHour"] = 10
    store.save_draft(db, wf, d, OWNER)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, OWNER)
    db.commit()
    v1, v2 = store.version(db, wf, 1), store.version(db, wf, 2)
    lines = store.diff(v1.definition, v2.definition)
    assert lines == ["Step 1 (Send A Notification): to changed from the manager to the manager and the HR contact",
                     "Step 2 added: Stop", "Setting maxRunsPerHour changed from 100 to 10"]
    assert store.diff(v1.definition, v1.definition) == ["No changes"]
    store.restore(db, wf, 1, OWNER)
    db.commit()
    assert wf.version == 3 and len(store.definition_of(wf)["steps"]) == 1
    copy = store.duplicate(db, wf, GAIL, name="Copy")
    db.commit()
    assert copy.status == "draft" and copy.owner_email == GAIL and copy.draft["steps"] == store.definition_of(wf)["steps"]
    assert [v.version for v in store.versions(db, wf)] == [3, 2, 1]


def test_visibility_and_edit_rights(db):
    mine = _wf(db, steps=[NOTIFY])
    other = _wf(db, steps=[NOTIFY], company=OTHER, owner=GAIL, name="Other")
    owner = {"email": OWNER, "role": "manager", "level": 3}
    ga = {"email": GAIL, "role": "owner", "level": 5}
    nobody = {"email": PRIYA, "role": "employee", "level": 1}
    assert store.can_edit(db, owner, mine) and not store.can_edit(db, owner, other)
    assert store.can_edit(db, ga, other) and store.can_see(db, ga, mine)
    assert store.visible_workflows(db, nobody).count() == 0
    assert store.visible_workflows(db, ga).count() == 2
    assert store.grant_rank(db, owner) == 2 and store.grant_rank(db, ga) == 4
