"""Workflows (Oct 28 2026) - Task 8: Ask For Approval.

  * the ask creates one Approvals inbox row per approver (the step's
    options as buttons) and bells them;
  * a non-approver gets 403; the subject cannot decide their own ask
    unless the step allows it;
  * a decision resumes the run into the option's branch;
  * `all` waits for everyone (a decline decides at once), `sequence` asks
    one approver at a time; a live stand-in may decide for an approver;
  * expiry resumes the `expired` branch;
  * the inbox row's Open is the SUBJECT record's link (the run link rides
    along as `runLink`) and an employee approver with no Workflows grant
    decides through POST /workflows/approvals/{id}/decide.

    cd backend && python -m pytest test_workflows_approvals.py -q
"""
import os
import tempfile
from datetime import date, datetime, timedelta, timezone

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import approvals_inbox  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import workflows  # noqa: E402
from workflows import approvals, catalog, engine, store, validate  # noqa: E402

ENTITY = "ent-apr"
OWNER, PRIYA, MAX, HANA, DEE, GAIL = ("owen.apr@greensglobal.com", "priya.apr@greensglobal.com",
                                      "max.apr@greensglobal.com", "hana.apr@greensglobal.com",
                                      "dee.apr@greensglobal.com", "gail.apr@greensglobal.com")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Apr", hr_contact_email=HANA))
    for email, first, mgr in [(OWNER, "Owen", ""), (PRIYA, "Priya", MAX), (MAX, "Max", ""), (HANA, "Hana", ""),
                              (DEE, "Dee", ""), (GAIL, "Gail", "")]:
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Apr",
                                   company=ENTITY, status="active", manager_email=mgr, start_date="2026-11-12"))
    s.add(models.NexusRole(email=OWNER, role="manager"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusRole(email=DEE, role="manager"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusGroup(id="g-apr", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-apr", email=OWNER))
    s.add(models.NexusGroup(id="g-apr-hr", name="HR", allowed_modules="hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-apr-hr", email=HANA))
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


@pytest.fixture(scope="module")
def client():
    return TestClient(main.app)


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.Workflow, models.WorkflowVersion, models.WorkflowEvent, models.WorkflowRun,
              models.WorkflowRunStep, models.WorkflowWait, models.WorkflowApproval, models.WorkflowSubjectMark,
              models.NexusNotification, models.ApprovalDelegation):
        s.query(m).delete()
    s.commit()
    yield s
    s.rollback()
    s.close()


def as_user(email: str) -> None:
    os.environ["NEXUS_DEV_EMAIL"] = email
    auth._role_cache.clear()


def _user(email, level=3):
    return {"email": email, "role": "manager" if level == 3 else "employee", "level": level}


YES = {"id": "y", "kind": "action", "action": "notify",
       "params": {"to": [{"kind": "self"}], "title": "Approved: {{ subject.name }}"}}
NO = {"id": "n", "kind": "action", "action": "notify",
      "params": {"to": [{"kind": "self"}], "title": "Declined: {{ subject.name }}"}}
EXP = {"id": "x", "kind": "action", "action": "notify",
       "params": {"to": [{"kind": "self"}], "title": "Expired: {{ subject.name }}"}}


def _approval(approvers, mode="any", **extra):
    return {"id": "ap1", "kind": "approval",
            "params": {"approvers": approvers, "mode": mode, "question": "Let {{ subject.name }} go?",
                       "options": ["Approve", "Decline"], **extra},
            "branches": {"Approve": [YES], "Decline": [NO], "expired": [EXP]}}


def _wf(db, step, name="Leaver Check"):
    definition = {"v": 1, "trigger": {"kind": "event", "event": "employee.status_changed"}, "conditions": [],
                  "steps": [step], "settings": dict(validate.DEFAULT_SETTINGS)}
    wf = store.create(db, name=name, owner=OWNER, company_id=ENTITY, definition=definition, by=OWNER)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, OWNER)
    db.commit()
    return wf


def _run(db, who="e-priya"):
    row = db.get(models.NexusEmployee, who)
    workflows.emit(db, "employee.status_changed", subject=row, actor=HANA, changes={"status": ("active", "offboarded")})
    db.commit()
    ev = db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at.desc()).first()
    return engine.handle_event(db, ev)[0]


def _ask(db):
    return db.query(models.WorkflowApproval).one()


def _notes(db, who):
    return [n.title for n in db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who).all()]


# ── the ask ──────────────────────────────────────────────────────────────────
def test_ask_creates_inbox_row_for_each_approver(client, db):
    _wf(db, _approval([{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}]))
    run = _run(db)
    assert run.status == "waiting"
    ap = _ask(db)
    assert ap.approvers == [MAX, HANA] and ap.mode == "any" and ap.question == "Let Priya Apr go?"
    assert ap.subject_label == "Priya Apr" and ap.subject_link == {"view": "hr", "sub": "people:e-priya"}
    assert ap.workflow_name == "Leaver Check" and ap.options == ["Approve", "Decline"]
    assert _notes(db, MAX) == ["Approval Needed: Leaver Check"] and _notes(db, HANA) == ["Approval Needed: Leaver Check"]
    for who in (MAX, HANA):
        rows = approvals_inbox.collect(db, _user(who))["rows"]
        row = next(r for r in rows if r["kind"] == "workflow")
        assert row["id"] == ap.id and row["title"] == "Leaver Check: Let Priya Apr go?"
        assert [a["key"] for a in row["actions"]] == ["Approve", "Decline", "open"]
        # Open lands on the person the ask is about, never the run (an
        # approver may hold no Workflows grant); the run link rides along
        assert row["actions"][0]["tone"] == "primary" and row["link"] == {"view": "hr", "sub": "people:e-priya"}
        assert row["runLink"] == {"view": "workflows", "sub": f"run:{run.id}"}
        assert row["group"] == "workflows"
    assert not [r for r in approvals_inbox.collect(db, _user(PRIYA, 1))["rows"] if r["kind"] == "workflow"]
    as_user(MAX)
    assert client.get("/me/action-counts").json()["counts"]["workflows"] == {"overview": 1}


def test_employee_approver_without_grant_opens_subject_and_decides(client, db):
    """An approver who is an employee with no `workflows` grant (Hana: no
    role row, hr:viewer only - the HR contact): the inbox row is hers with
    the subject's link, GET /workflows/runs/{id} is refused, and the
    decision goes through (the decide route carries no grant)."""
    _wf(db, _approval([{"kind": "role", "value": "hr_contact"}]))
    run = _run(db)
    ap = _ask(db)
    assert ap.approvers == [HANA]
    rows = [r for r in approvals_inbox.collect(db, _user(HANA, 1))["rows"] if r["kind"] == "workflow"]
    assert len(rows) == 1 and rows[0]["id"] == ap.id
    assert rows[0]["link"] == {"view": "hr", "sub": "people:e-priya"}
    assert rows[0]["runLink"] == {"view": "workflows", "sub": f"run:{run.id}"}
    assert rows[0]["title"] == "Leaver Check: Let Priya Apr go?" and rows[0]["person"]["name"] == "Priya Apr"
    # an older row with no stored link resolves it again from the run
    ap.subject_link = {}
    db.commit()
    assert approvals.subject_link(db, ap) == {"view": "hr", "sub": "people:e-priya"}
    as_user(HANA)
    assert client.get(f"/workflows/runs/{run.id}").status_code == 403
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"})
    assert r.status_code == 200 and r.json()["decided"] and r.json()["runStatus"] == "succeeded"
    assert _notes(db, PRIYA) == ["Approved: Priya Apr"]


def test_decide_by_non_approver_403(client, db):
    _wf(db, _approval([{"kind": "manager"}]))
    _run(db)
    ap = _ask(db)
    as_user(DEE)
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"})
    assert r.status_code == 403
    as_user(MAX)
    assert client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Maybe"}).status_code == 409
    assert client.post("/workflows/approvals/nope/decide", json={"option": "Approve"}).status_code == 404


def test_self_cannot_decide_unless_allowed(client, db):
    _wf(db, _approval([{"kind": "self"}, {"kind": "manager"}]))
    _run(db)
    ap = _ask(db)
    assert ap.approvers == [MAX]           # the subject was dropped
    _wf(db, _approval([{"kind": "self"}, {"kind": "manager"}], allowSelf=True), name="Self OK")
    db.query(models.WorkflowApproval).delete()
    db.commit()
    runs = engine.handle_event(db, db.query(models.WorkflowEvent).first())
    ap2 = next(a for a in db.query(models.WorkflowApproval).all() if a.workflow_name == "Self OK")
    assert ap2.approvers == [PRIYA, MAX]
    as_user(PRIYA)
    r = client.post(f"/workflows/approvals/{ap2.id}/decide", json={"option": "Approve", "note": "yes please"})
    assert r.status_code == 200 and r.json()["decided"] and r.json()["runStatus"] == "succeeded"
    assert len(runs) == 2


def test_decide_resumes_run_into_the_option_branch(client, db):
    _wf(db, _approval([{"kind": "manager"}]))
    run = _run(db)
    ap = _ask(db)
    as_user(MAX)
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Decline", "note": "not yet"})
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "Decline" and body["responses"][0] == {"email": MAX, "option": "Decline", "note": "not yet",
                                                                      "at": body["responses"][0]["at"]}
    db.expire_all()
    run = db.get(models.WorkflowRun, run.id)
    assert run.status == "succeeded"
    steps = [s for s in store.run_steps(db, run) if s.kind != "conditions"]
    assert [(s.step_id, s.status) for s in steps] == [("ap1", "done"), ("ap1/Decline/n", "done")]
    assert steps[0].detail == "Outcome: Decline"
    assert _notes(db, PRIYA) == ["Declined: Priya Apr"]
    ap = _ask(db)
    assert ap.outcome == "Decline" and ap.decided_at
    assert not [x for x in approvals_inbox.collect(db, _user(MAX))["rows"] if x["kind"] == "workflow"]
    assert client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"}).status_code == 409


def test_mode_all_waits_for_everyone_and_sequence_asks_one_at_a_time(client, db):
    wf_all = _wf(db, _approval([{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}], mode="all"))
    run = _run(db)
    ap = _ask(db)
    as_user(MAX)
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"})
    assert r.json()["decided"] is False and r.json()["outcome"] == ""
    db.expire_all()
    assert db.get(models.WorkflowRun, run.id).status == "waiting"
    assert client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"}).status_code == 403  # answered
    as_user(HANA)
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"})
    assert r.json()["decided"] is True and r.json()["outcome"] == "Approve"
    db.expire_all()
    assert db.get(models.WorkflowRun, run.id).status == "succeeded" and _notes(db, PRIYA) == ["Approved: Priya Apr"]
    # sequence: only the first approver is asked, then the next (the first
    # workflow is paused so the same event starts only the new one)
    store.set_status(db, wf_all, "paused", OWNER)
    db.query(models.WorkflowApproval).delete()
    db.query(models.NexusNotification).delete()
    db.commit()
    _wf(db, _approval([{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}], mode="sequence"), name="Seq")
    runs = engine.handle_event(db, db.query(models.WorkflowEvent).first())
    seq = next(a for a in db.query(models.WorkflowApproval).all() if a.workflow_name == "Seq")
    assert approvals.current_approvers(seq) == [MAX]
    assert _notes(db, MAX) and not [n for n in _notes(db, HANA) if n.startswith("Approval")]
    assert not [x for x in approvals_inbox.collect(db, _user(HANA))["rows"] if x["id"] == seq.id]
    as_user(HANA)
    assert client.post(f"/workflows/approvals/{seq.id}/decide", json={"option": "Approve"}).status_code == 403
    as_user(MAX)
    assert client.post(f"/workflows/approvals/{seq.id}/decide", json={"option": "Approve"}).json()["decided"] is False
    assert [n for n in _notes(db, HANA) if n.startswith("Approval")]        # now Hana is asked
    db.expire_all()
    assert approvals.current_approvers(_ask_named(db, "Seq")) == [HANA]
    as_user(HANA)
    assert client.post(f"/workflows/approvals/{seq.id}/decide", json={"option": "Decline"}).json()["outcome"] == "Decline"
    assert len(runs) == 1


def _ask_named(db, name):
    return next(a for a in db.query(models.WorkflowApproval).all() if a.workflow_name == name)


def test_delegate_may_decide_for_approver(client, db):
    _wf(db, _approval([{"kind": "manager"}]))
    _run(db)
    ap = _ask(db)
    today = date.today().isoformat()
    db.add(models.ApprovalDelegation(id="d1", delegator_email=MAX, delegate_email=DEE, start_date=today,
                                     end_date=today, created_by=MAX, created_at=today))
    db.commit()
    rows = [r for r in approvals_inbox.collect(db, _user(DEE))["rows"] if r["kind"] == "workflow"]
    assert rows and rows[0]["forName"] == "Max Apr"
    as_user(DEE)
    r = client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"})
    assert r.status_code == 200 and r.json()["responses"][0]["for"] == MAX and r.json()["decided"]


def test_expiry_resumes_expired_branch_and_reminder_bells_once(client, db):
    _wf(db, _approval([{"kind": "manager"}], remindDays=1, expireDays=3))
    run = _run(db)
    ap = _ask(db)
    wait = db.query(models.WorkflowWait).one()
    assert wait.kind == "approval" and wait.due_at
    assert approvals.sweep(db, datetime.now(timezone.utc)) == {"reminded": 0, "expired": 0}
    out = approvals.sweep(db, datetime.now(timezone.utc) + timedelta(days=1, minutes=1))
    assert out == {"reminded": 1, "expired": 0} and _ask(db).reminded_at
    assert approvals.sweep(db, datetime.now(timezone.utc) + timedelta(days=2))["reminded"] == 0
    out = approvals.sweep(db, datetime.now(timezone.utc) + timedelta(days=3, minutes=1))
    assert out["expired"] == 1
    db.expire_all()
    assert _ask(db).outcome == "expired" and db.get(models.WorkflowRun, run.id).status == "succeeded"
    assert _notes(db, PRIYA) == ["Expired: Priya Apr"]
    assert client.post(f"/workflows/approvals/{ap.id}/decide", json={"option": "Approve"}).status_code in (403, 409)
