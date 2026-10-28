"""Workflows (Oct 28 2026) - Task 10: the Tasks and Tickets pack.

  * every task / ticket event's sample is made of the entity's fields and
    its changes name the fields the event declares;
  * routers/task_util.log_activity is the one emit line: each mapped
    activity row becomes an outbox row with the right key and from / to
    (a ticket resolved or reopened emits its milestone key as well as the
    general status key; an unmapped row emits nothing);
  * a confidential ticket's `visible_to` refuses an outsider and the desk
    grant alone - its own people and HR only;
  * every action's plan and run: a permitted run-as user creates, comments,
    assigns and sets fields through the modules' own functions; a user
    without the project role is refused with the module's reason;
  * the three list sources;
  * the chain rule (spec 6.2): a workflow's task change runs the Tasks rules
    as the owner's edit would, and the activity rows those rules write are
    tagged with the current run; a person's own edit is not.

    cd backend && python -m pytest test_workflows_packs_tasks_tickets.py -q
"""
import importlib
import os
import tempfile
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import BackgroundTasks  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import task_automation  # noqa: E402
import task_notify  # noqa: E402
import ticket_notify  # noqa: E402
from routers import task_config, tasks as TASKS, tickets as TK  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext  # noqa: E402

# `workflows.emit` the attribute is the re-exported FUNCTION; the module is
# reached by its dotted path.
emit_mod = importlib.import_module("workflows.emit")

MANAGER = {"email": "boss@greensglobal.com", "role": "manager", "level": 3}
DESK = {"email": "desk@greensglobal.com", "role": "administrator", "level": 4}
SAM = {"email": "sam@greensglobal.com", "role": "employee", "level": 1}
PRIYA = {"email": "priya@greensglobal.com", "role": "employee", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "role": "employee", "level": 1}      # tickets grant, no more
OUTSIDER = {"email": "nobody@greensglobal.com", "role": "employee", "level": 1}
PEOPLE = (MANAGER, DESK, SAM, PRIYA, AGENT, OUTSIDER)
WF = SimpleNamespace(name="Welcome Flow", owner_email=MANAGER["email"])

TASK_KEYS = {"task.created", "task.status_changed", "task.assigned", "task.completed", "task.commented",
             "task.due_date_changed", "task.field_changed"}
TICKET_KEYS = {"ticket.filed", "ticket.assigned", "ticket.status_changed", "ticket.resolved", "ticket.reopened",
               "ticket.escalated", "ticket.commented", "ticket.approval_requested", "ticket.approval_decided"}


# ── fixtures ─────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    # No Graph calls: the modules' notification emails are stubbed where
    # each caller resolves the name.
    quiet = lambda *a, **kw: None   # noqa: E731
    saved = (task_notify.notify_task_event, TASKS.notify_task_event,
             ticket_notify.notify_ticket_event, TK.notify_ticket_event)
    task_notify.notify_task_event = quiet
    TASKS.notify_task_event = quiet
    ticket_notify.notify_ticket_event = quiet
    TK.notify_ticket_event = quiet
    yield
    (task_notify.notify_task_event, TASKS.notify_task_event,
     ticket_notify.notify_ticket_event, TK.notify_ticket_event) = saved
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.WorkflowEvent, models.Task, models.TaskComment, models.TaskActivity, models.TaskProject,
              models.TaskAutomationRule, models.TaskAutomationRun, models.TaskNotification,
              models.NexusNotification, models.TaskTicket, models.NexusEmployee, models.NexusRole,
              models.NexusGroup, models.NexusGroupMember, models.NexusSetting, models.TaskCustomField):
        s.query(m).delete()
    for u in PEOPLE:
        s.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], first_name=u["email"].split("@")[0].title(),
                                   status="active", company=""))
    s.add(models.NexusRole(email=DESK["email"], role="administrator"))
    s.add(models.NexusRole(email=MANAGER["email"], role="manager"))
    s.add(models.NexusGroup(id="g-desk", name="Service Desk", allowed_modules="tickets:editor"))
    s.add(models.NexusGroupMember(group_id="g-desk", email=AGENT["email"]))
    s.commit()
    s.query(models.WorkflowEvent).delete()      # the record observer's employee.created rows
    s.commit()
    cache.module_grants.invalidate()
    auth._role_cache.clear()
    emit_mod.refresh_subscribed(["task.commented"])     # the one high-volume key, subscribed for the tests
    yield s
    s.rollback()
    s.close()


def _outbox(db, key=None):
    db.commit()
    q = db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at, models.WorkflowEvent.id)
    if key:
        q = q.filter(models.WorkflowEvent.key == key)
    return q.all()


def _clear_outbox(db):
    db.commit()
    db.query(models.WorkflowEvent).delete()
    db.commit()


def _project(db, name="Ops", access_level="org", owner=MANAGER["email"], members=()):
    p = models.TaskProject(id=gen_id(), name=name, access_level=access_level, owner_email=owner,
                           member_emails=list(members), member_roles={}, created_at=now_iso(), modified_at=now_iso())
    db.add(p)
    db.commit()
    return p


def _task(db, user=MANAGER, **kw):
    body = TASKS.TaskCreate(title=kw.pop("title", "Fix the gate"), **kw)
    out = TASKS.create_task(body, BackgroundTasks(), user=user, db=db)
    return db.query(models.Task).filter(models.Task.id == out["id"]).first()


def _patch(db, tid, user=MANAGER, **kw):
    return TASKS.update_task(tid, TASKS.TaskUpdate(**kw), BackgroundTasks(), user=user, db=db)


def _ticket(db, user=SAM, **kw):
    desk = "hr" if kw.pop("confidential", False) else ""
    body = TK.TicketBody(subject=kw.pop("subject", "Laptop will not start"), **kw)
    out = TK.file_ticket(body, BackgroundTasks(), user, db, arrived_by="test", confidential_desk=desk)
    return TK._ticket_or_404(db, out["id"], confidential=True)


def _tpatch(db, tid, user=DESK, **kw):
    return TK.update_ticket(tid, TK.TicketUpdate(**kw), BackgroundTasks(), user=user, db=db)


def _ctx(db, subject=None, user=MANAGER, entity="task", item=None, company=""):
    return RunContext(db=db, workflow=WF, entity=catalog.ENTITIES[entity], subject=subject, run_as=user,
                      today=date.today(), item=item, company_id=company)


# ── samples ──────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("key", sorted(TASK_KEYS | TICKET_KEYS))
def test_every_event_sample_is_made_of_entity_fields(key):
    ev = catalog.EVENTS[key]
    ent = catalog.ENTITIES[ev.entity]
    payload = catalog.sample_payload(ev)
    fields = {f.key for f in ent.fields}
    assert payload["subject"] and set(payload["subject"]) <= fields, key
    assert set(payload["changes"]) <= set(ev.changes), key
    for c in ev.changes:
        assert ent.field(c) is not None
    assert payload["extra"].get("activity"), key
    assert ev.module in ("tasks", "tickets") and ev.module in catalog.OPEN_MODULES


def test_task_commented_is_high_volume_and_the_rest_normal():
    assert catalog.EVENTS["task.commented"].volume == "high"
    assert all(catalog.EVENTS[k].volume == "normal" for k in (TASK_KEYS | TICKET_KEYS) - {"task.commented"})


def test_entities_and_actions_are_registered():
    assert catalog.ENTITIES["task"].model is models.Task and catalog.ENTITIES["ticket"].model is models.TaskTicket
    assert set(catalog.ENTITIES["task"].people) == {"assignees", "owner", "creator", "followers", "project_owner"}
    assert set(catalog.ENTITIES["ticket"].people) == {"assignee", "requester", "participants", "creator", "approver"}
    assert {k for k in catalog.ACTIONS if k.startswith("task.")} == {"task.create", "task.comment", "task.assign",
                                                                     "task.set_field"}
    assert {k for k in catalog.ACTIONS if k.startswith("ticket.")} == {"ticket.create", "ticket.comment",
                                                                       "ticket.assign", "ticket.set_status",
                                                                       "ticket.request_approval"}
    assert {"tasks.overdue", "tickets.unanswered", "tickets.breaching_sla"} <= set(catalog.LIST_SOURCES)
    assert all(a.needs_person for k, a in catalog.ACTIONS.items() if k.startswith(("task.", "ticket.")))


def test_links_and_labels(db):
    t = _task(db, title="Gate motor")
    link = catalog.ENTITIES["task"].link_for(t)
    assert link == {"view": "tasks", "sub": "mine", "taskId": t.id}
    assert catalog.ENTITIES["task"].label_for(t) == "Gate motor"
    k = _ticket(db, subject="Printer jam")
    assert catalog.ENTITIES["ticket"].link_for(k) == {"view": "tickets", "ticketId": k.id}
    assert catalog.ENTITIES["ticket"].label_for(k) == "Printer jam"


# ── the emit line: tasks ─────────────────────────────────────────────────────
def test_task_created_emits_one_row_with_the_subject_fields(db):
    p = _project(db)
    t = _task(db, title="Gate motor", project_id=p.id, assignee_emails=[SAM["email"]], due_on="2026-11-05")
    rows = _outbox(db)
    assert [r.key for r in rows] == ["task.created"]
    ev = rows[0]
    assert ev.entity == "task" and ev.subject_id == t.id and ev.actor == MANAGER["email"]
    sub = ev.payload["subject"]
    assert sub["title"] == "Gate motor" and sub["project"] == p.id and sub["assignees"] == [SAM["email"]]
    assert sub["due_date"] == "2026-11-05" and sub["completed"] is False and sub["status"] == "not_started"
    assert ev.payload["extra"]["activity"] == "created" and ev.caused_by_run == "" and ev.depth == 0


def test_task_status_change_emits_from_and_to(db):
    t = _task(db)
    _clear_outbox(db)
    _patch(db, t.id, status="in_progress")
    rows = _outbox(db, "task.status_changed")
    assert len(rows) == 1
    assert rows[0].payload["changes"] == {"status": {"from": "not_started", "to": "in_progress"}}
    assert rows[0].payload["subject"]["status"] == "in_progress"
    # starting work stamps the start date - its own detail row, as in the task's history
    others = [r for r in _outbox(db) if r.key != "task.status_changed"]
    assert [(r.key, r.payload["extra"]["field"]) for r in others] == [("task.field_changed", "Start Date")]


def test_task_assignment_emits_assignees_from_and_to(db):
    t = _task(db)
    _clear_outbox(db)
    _patch(db, t.id, assignee_emails=[SAM["email"]])
    rows = _outbox(db)
    assert [r.key for r in rows] == ["task.assigned"]
    ch = rows[0].payload["changes"]["assignees"]
    assert ch["from"] == [] and ch["to"] == [SAM["email"]]


def test_task_completion_emits_completed(db):
    t = _task(db)
    _clear_outbox(db)
    _patch(db, t.id, completed=True)
    rows = _outbox(db)
    assert [r.key for r in rows] == ["task.completed"]
    assert rows[0].payload["changes"]["completed"] == {"from": False, "to": True}
    assert rows[0].payload["subject"]["status"] == "completed" and rows[0].payload["subject"]["completed"] is True


def test_task_due_date_change_emits_from_and_to(db):
    t = _task(db, due_on="2026-11-05")
    _clear_outbox(db)
    _patch(db, t.id, due_on="2026-11-12")
    rows = _outbox(db, "task.due_date_changed")
    assert len(rows) == 1
    assert rows[0].payload["changes"] == {"due_date": {"from": "2026-11-05", "to": "2026-11-12"}}


def test_task_priority_change_emits_field_changed(db):
    t = _task(db)
    _clear_outbox(db)
    _patch(db, t.id, priority="high")
    rows = _outbox(db)
    assert [r.key for r in rows] == ["task.field_changed"]
    assert rows[0].payload["changes"] == {"priority": {"from": "medium", "to": "high"}}
    assert rows[0].payload["extra"]["field"] == "Priority"


def test_task_comment_emits_only_while_subscribed(db):
    from routers.task_util import create_comment
    t = _task(db)
    _clear_outbox(db)
    create_comment(db, t, actor_email=MANAGER["email"], body="On it")
    assert [r.key for r in _outbox(db)] == ["task.commented"]
    _clear_outbox(db)
    emit_mod.refresh_subscribed([])
    create_comment(db, t, actor_email=MANAGER["email"], body="Still on it")
    assert _outbox(db) == []


def test_unmapped_task_activity_emits_nothing(db):
    t = _task(db)
    _clear_outbox(db)
    TASKS.delete_task(t.id, BackgroundTasks(), user=MANAGER, db=db)
    assert _outbox(db) == []


# ── the emit line: tickets ───────────────────────────────────────────────────
def test_ticket_filed_emits_one_row(db):
    k = _ticket(db, subject="Printer jam", priority="high", type="incident")
    rows = _outbox(db)
    assert [r.key for r in rows] == ["ticket.filed"]
    ev = rows[0]
    assert ev.entity == "ticket" and ev.subject_id == k.id and ev.actor == SAM["email"]
    sub = ev.payload["subject"]
    assert sub["title"] == "Printer jam" and sub["priority"] == "high" and sub["requester"] == SAM["email"]
    assert sub["type"] == "incident" and sub["status"] == "open" and sub["confidential_desk"] == ""
    assert ev.payload["extra"] == {"activity": "created", "confidentialDesk": ""}
    assert sub["created_at"] and sub["sla_due"]


def test_ticket_assignment_emits_assignee_and_the_auto_in_progress(db):
    k = _ticket(db)
    _clear_outbox(db)
    _tpatch(db, k.id, assignee_email=AGENT["email"])
    keys = sorted(r.key for r in _outbox(db))
    assert keys == ["ticket.assigned", "ticket.status_changed"]
    a = _outbox(db, "ticket.assigned")[0]
    assert a.payload["changes"] == {"assignee": {"from": "", "to": AGENT["email"]}}
    s = _outbox(db, "ticket.status_changed")[0]
    assert s.payload["changes"] == {"status": {"from": "open", "to": "in_progress"}}


def test_ticket_resolved_emits_status_changed_and_resolved(db):
    k = _ticket(db)
    _tpatch(db, k.id, assignee_email=AGENT["email"])
    _clear_outbox(db)
    _tpatch(db, k.id, status="resolved", resolution_note="Replaced the fuser")
    rows = _outbox(db)
    assert sorted(r.key for r in rows) == ["ticket.resolved", "ticket.status_changed"]
    for r in rows:
        assert r.payload["changes"] == {"status": {"from": "in_progress", "to": "resolved"}}


def test_ticket_reopened_emits_status_changed_and_reopened(db):
    k = _ticket(db)
    _tpatch(db, k.id, status="resolved", resolution_note="Done")
    _clear_outbox(db)
    _tpatch(db, k.id, user=SAM, status="reopened", reopen_reason="Still jammed")
    rows = _outbox(db)
    assert sorted(r.key for r in rows) == ["ticket.reopened", "ticket.status_changed"]
    assert rows[0].payload["changes"]["status"] == {"from": "resolved", "to": "reopened"}
    assert rows[0].actor == SAM["email"]


def test_ticket_in_progress_move_emits_status_changed_only(db):
    k = _ticket(db)
    _clear_outbox(db)
    _tpatch(db, k.id, status="in_progress")
    assert [r.key for r in _outbox(db)] == ["ticket.status_changed"]


def test_ticket_comment_and_escalation_emit(db):
    k = _ticket(db)
    _clear_outbox(db)
    TK.post_ticket_comment(db, k, DESK, "Looking into it", False, BackgroundTasks())
    assert [r.key for r in _outbox(db)] == ["ticket.commented"]
    _clear_outbox(db)
    TK.escalate_ticket(k.id, BackgroundTasks(), user=DESK, db=db)
    rows = _outbox(db)
    assert [r.key for r in rows] == ["ticket.escalated"] and rows[0].actor == DESK["email"]


def test_ticket_approval_requested_and_decided_emit(db):
    k = _ticket(db, type="access_request")
    assert k.approval_status == "pending"
    _clear_outbox(db)
    TK.request_approval(k.id, TK.ApprovalRequestBody(approver_email=PRIYA["email"], note="Please"),
                        BackgroundTasks(), user=DESK, db=db)
    rows = _outbox(db)
    assert [r.key for r in rows] == ["ticket.approval_requested"]
    assert rows[0].payload["extra"]["approver"] == PRIYA["email"]
    _clear_outbox(db)
    TK.decide_approval(k.id, TK.ApprovalBody(decision="approve", note="Fine"), BackgroundTasks(), user=PRIYA, db=db)
    rows = _outbox(db, "ticket.approval_decided")
    assert len(rows) == 1
    assert rows[0].payload["changes"] == {"approval_status": {"from": "pending", "to": "approved"}}
    assert rows[0].payload["extra"]["decision"] == "approve" and rows[0].actor == PRIYA["email"]


def test_confidential_ticket_row_carries_its_desk_in_extra(db):
    k = _ticket(db, confidential=True)
    rows = _outbox(db, "ticket.filed")
    assert len(rows) == 1 and rows[0].payload["extra"]["confidentialDesk"] == "hr"
    assert rows[0].payload["subject"]["confidential_desk"] == "hr"


# ── visibility ───────────────────────────────────────────────────────────────
def test_confidential_ticket_is_visible_to_its_people_and_hr_only(db):
    k = _ticket(db, confidential=True)
    ent = catalog.ENTITIES["ticket"]
    assert ent.can_see(db, SAM, k)                      # the requester
    assert not ent.can_see(db, OUTSIDER, k)             # an outsider
    assert not ent.can_see(db, AGENT, k)                # the desk grant alone never opens it
    assert not ent.can_see(db, MANAGER, k)              # nor being a manager
    assert ent.can_see(db, DESK, k)                     # an administrator counts as HR for the company
    plain = _ticket(db)
    assert ent.can_see(db, AGENT, plain) and ent.can_see(db, SAM, plain) and not ent.can_see(db, OUTSIDER, plain)


def test_confidential_ticket_loads_for_the_entity_but_not_for_a_plain_query(db):
    k = _ticket(db, confidential=True)
    assert catalog.ENTITIES["ticket"].load_row(db, k.id) is not None
    assert db.query(models.TaskTicket).filter(models.TaskTicket.id == k.id).first() is None


def test_restricted_task_is_visible_to_its_people_only(db):
    p = _project(db, access_level="restricted", members=[SAM["email"]])
    t = _task(db, project_id=p.id, assignee_emails=[SAM["email"]])
    ent = catalog.ENTITIES["task"]
    assert ent.can_see(db, SAM, t) and ent.can_see(db, MANAGER, t)
    assert not ent.can_see(db, PRIYA, t) and not ent.can_see(db, OUTSIDER, t)


# ── actions: tasks ───────────────────────────────────────────────────────────
def test_task_create_plans_and_runs_as_the_run_as_user(db):
    p = _project(db, name="Ops")
    src = _task(db, title="Onboard Priya")
    act = catalog.ACTIONS["task.create"]
    params = {"title": "Laptop for {{ subject.title }}", "project": p.id, "assignee": [{"kind": "person", "value": SAM["email"]}],
              "dueInDays": 3, "priority": "high", "description": "Order it"}
    ctx = _ctx(db, src, user=MANAGER)
    assert act.allowed(ctx, params) == ""
    plan = act.plan(ctx, params)
    assert plan.startswith('Would create task "Laptop for Onboard Priya" in Ops, assigned to sam@greensglobal.com, due ')
    _clear_outbox(db)
    out = act.run(ctx, params)
    assert out["affected"][0]["entity"] == "task" and out["line"].startswith('Created task "Laptop for Onboard Priya" in Ops')
    made = db.query(models.Task).filter(models.Task.id == out["affected"][0]["id"]).one()
    assert made.title == "Laptop for Onboard Priya" and made.project_id == p.id and made.priority == "high"
    assert made.assignee_emails == [SAM["email"]] and made.created_by == MANAGER["email"]
    assert made.due_on == (date.today() + timedelta(days=3)).isoformat()
    assert made.description == "Order it\n\nCreated by Workflow: Welcome Flow"
    assert [r.key for r in _outbox(db)] == ["task.created"]


def test_task_create_runs_no_tasks_rule(db):
    task_config.create_rule(task_config.RuleBody(name="Everything new is urgent", trigger={"type": "created"},
                                                 actions=[{"type": "set_priority", "value": "urgent"}],
                                                 conditions=[], enabled=True), user=MANAGER, db=db)
    out = catalog.ACTIONS["task.create"].run(_ctx(db, None), {"title": "Quiet", "priority": "low"})
    made = db.query(models.Task).filter(models.Task.id == out["affected"][0]["id"]).one()
    assert made.priority == "low"
    assert db.query(models.TaskAutomationRun).count() == 0


def test_task_create_is_refused_without_the_project_role(db):
    p = _project(db, name="Finance", access_level="restricted", members=[PRIYA["email"]])
    act = catalog.ACTIONS["task.create"]
    params = {"title": "Close the books", "project": p.id}
    reason = act.allowed(_ctx(db, None, user=SAM), params)
    assert reason == 'You need at least editor access to "Finance".'
    with pytest.raises(RuntimeError, match='Could not create the task: You need at least editor access to "Finance".'):
        act.run(_ctx(db, None, user=SAM), params)
    assert db.query(models.Task).count() == 0
    assert act.allowed(_ctx(db, None, user=PRIYA), params) == ""


def test_task_create_needs_a_person(db):
    act = catalog.ACTIONS["task.create"]
    assert act.allowed(_ctx(db, None, user=None), {"title": "x"}) == "Create Task needs a person's identity."
    with pytest.raises(RuntimeError, match="needs a person"):
        act.run(_ctx(db, None, user=None), {"title": "x"})


def test_task_comment_plans_and_runs(db):
    t = _task(db, title="Gate motor")
    act = catalog.ACTIONS["task.comment"]
    ctx = _ctx(db, t, user=SAM)
    params = {"text": "Due {{ subject.due_date | default:'soon' }}"}
    assert act.plan(ctx, params) == 'Would comment on "Gate motor": Workflow: Welcome Flow - Due soon'
    out = act.run(ctx, params)
    c = db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id).one()
    assert c.body == "Workflow: Welcome Flow - Due soon" and c.author_email == SAM["email"]
    assert out["affected"] == [{"entity": "task", "id": t.id, "label": "Gate motor"}]


def test_task_comment_is_refused_without_the_commenter_role(db):
    p = _project(db, name="Finance", access_level="restricted", members=[PRIYA["email"]])
    t = _task(db, project_id=p.id)
    act = catalog.ACTIONS["task.comment"]
    reason = act.allowed(_ctx(db, t, user=SAM), {"text": "hi"})
    assert reason == 'You need at least commenter access to "Finance".'
    with pytest.raises(RuntimeError, match="Could not comment: You need at least commenter access"):
        act.run(_ctx(db, t, user=SAM), {"text": "hi"})
    assert db.query(models.TaskComment).count() == 0


def test_task_assign_adds_then_replaces_through_update_task(db):
    t = _task(db, title="Gate motor", assignee_emails=[SAM["email"]])
    act = catalog.ACTIONS["task.assign"]
    ctx = _ctx(db, t, user=MANAGER)
    params = {"to": [{"kind": "person", "value": PRIYA["email"]}]}
    assert act.allowed(ctx, params) == ""
    assert act.plan(ctx, params) == 'Would add priya@greensglobal.com to "Gate motor"'
    _clear_outbox(db)
    out = act.run(ctx, params)
    db.refresh(t)
    assert t.assignee_emails == [SAM["email"], PRIYA["email"]] and "priya" in out["line"]
    assert [r.key for r in _outbox(db)] == ["task.assigned"]
    out = act.run(ctx, {**params, "mode": "replace"})
    db.refresh(t)
    assert t.assignee_emails == [PRIYA["email"]]
    assert act.plan(ctx, {**params, "mode": "replace"}) == 'Would assign priya@greensglobal.com to "Gate motor"'


def test_task_assign_is_refused_for_a_viewer(db):
    p = _project(db, name="Finance", access_level="restricted", members=[PRIYA["email"]])
    t = _task(db, project_id=p.id)
    act = catalog.ACTIONS["task.assign"]
    params = {"to": [{"kind": "person", "value": PRIYA["email"]}]}
    assert act.allowed(_ctx(db, t, user=SAM), params) == 'You need at least editor access to "Finance".'
    with pytest.raises(RuntimeError, match="Could not assign the task: You need at least editor access"):
        act.run(_ctx(db, t, user=SAM), params)


def test_task_set_field_status_priority_and_custom(db):
    f = models.TaskCustomField(id="cf-1", name="Vendor", type="text", options=[], project_ids=[])
    db.add(f)
    db.commit()
    t = _task(db, title="Gate motor")
    act = catalog.ACTIONS["task.set_field"]
    ctx = _ctx(db, t, user=MANAGER)
    assert act.plan(ctx, {"field": "status", "value": "in_progress"}) == 'Would set status to in_progress on "Gate motor"'
    assert act.allowed(ctx, {"field": "custom_field", "value": "x"}) == "Pick the custom field to set."
    _clear_outbox(db)
    act.run(ctx, {"field": "status", "value": "in_progress"})
    act.run(ctx, {"field": "priority", "value": "Urgent"})
    out = act.run(ctx, {"field": "custom_field", "customFieldId": "cf-1", "value": "{{ actor.email | default:'Acme' }}"})
    db.refresh(t)
    assert t.status == "in_progress" and t.priority == "urgent" and t.custom_field_values == {"cf-1": "Acme"}
    assert out["line"] == 'Set Vendor to Acme on "Gate motor"'
    fc = _outbox(db, "task.field_changed")
    assert sorted(f for r in fc for f in r.payload["changes"]) == ["priority", "start_date"]
    custom = [r for r in fc if r.payload["extra"].get("fieldId") == "cf-1"]
    assert len(custom) == 1 and custom[0].payload["changes"] == {}     # a custom field rides in extra, not changes
    assert len(_outbox(db, "task.status_changed")) == 1
    with pytest.raises(RuntimeError, match="is not a priority|Unknown priority"):
        act.run(ctx, {"field": "priority", "value": "sky-high"})


# ── actions: tickets ─────────────────────────────────────────────────────────
def test_ticket_create_plans_and_runs(db):
    src = _task(db, title="Onboard Priya")
    act = catalog.ACTIONS["ticket.create"]
    ctx = _ctx(db, src, user=MANAGER)
    params = {"subject": "Laptop for {{ subject.title }}", "type": "access_request", "priority": "high",
              "requester": [{"kind": "person", "value": PRIYA["email"]}], "description": "New starter"}
    assert act.allowed(ctx, params) == ""
    assert act.plan(ctx, params) == 'Would file a high access request ticket "Laptop for Onboard Priya" for priya@greensglobal.com'
    _clear_outbox(db)
    out = act.run(ctx, params)
    k = TK._ticket_or_404(db, out["affected"][0]["id"])
    assert k.subject == "Laptop for Onboard Priya" and k.requester_email == PRIYA["email"]
    assert k.created_by_email == MANAGER["email"] and k.source == "workflow" and k.priority == "high"
    assert k.description == "New starter\n\nCreated by Workflow: Welcome Flow"
    assert k.approval_status == "pending"          # the module's gate still applies
    assert out["line"].startswith(f'Filed ticket {k.code} "Laptop for Onboard Priya" for priya@greensglobal.com')
    assert [r.key for r in _outbox(db)] == ["ticket.filed"]


def test_ticket_create_assignee_is_the_desks_alone(db):
    act = catalog.ACTIONS["ticket.create"]
    params = {"subject": "x", "assignee": [{"kind": "person", "value": AGENT["email"]}]}
    assert "not a ticket agent" in act.allowed(_ctx(db, None, user=SAM), params)
    assert act.allowed(_ctx(db, None, user=DESK), params) == ""
    out = act.run(_ctx(db, None, user=DESK), params)
    k = TK._ticket_or_404(db, out["affected"][0]["id"])
    assert k.assignee_email == AGENT["email"] and k.status == "in_progress"


def test_ticket_comment_reply_and_internal_note(db):
    k = _ticket(db, subject="Printer jam")
    act = catalog.ACTIONS["ticket.comment"]
    params = {"text": "We are on it"}
    assert act.plan(_ctx(db, k, user=DESK, entity="ticket"), params) == \
        'Would add a reply on "Printer jam": Workflow: Welcome Flow - We are on it'
    _clear_outbox(db)
    out = act.run(_ctx(db, k, user=DESK, entity="ticket"), params)
    c = db.query(models.TaskComment).filter(models.TaskComment.task_id == k.id).one()
    assert c.body == "Workflow: Welcome Flow - We are on it" and not c.internal
    assert out["line"] == f'Added a reply on {k.code} "Printer jam"'
    assert [r.key for r in _outbox(db)] == ["ticket.commented"]
    # the requester may reply, never write an internal note; an outsider nothing
    assert act.allowed(_ctx(db, k, user=SAM, entity="ticket"), params) == ""
    assert "only the service desk writes internal notes" in act.allowed(_ctx(db, k, user=SAM, entity="ticket"),
                                                                        {**params, "internal": True})
    assert act.allowed(_ctx(db, k, user=OUTSIDER, entity="ticket"), params) == "You don't have access to this ticket"
    with pytest.raises(RuntimeError, match="Could not comment: You don't have access to this ticket"):
        act.run(_ctx(db, k, user=OUTSIDER, entity="ticket"), params)
    _clear_outbox(db)
    act.run(_ctx(db, k, user=AGENT, entity="ticket"), {**params, "internal": True})
    notes = [c for c in db.query(models.TaskComment).filter(models.TaskComment.task_id == k.id).all() if c.internal]
    assert len(notes) == 1
    rows = _outbox(db, "ticket.commented")
    assert len(rows) == 1 and rows[0].payload["extra"]["internal"] is True


def test_ticket_assign_runs_as_an_agent_and_refuses_a_requester(db):
    k = _ticket(db, subject="Printer jam")
    act = catalog.ACTIONS["ticket.assign"]
    params = {"to": [{"kind": "person", "value": AGENT["email"]}]}
    assert act.plan(_ctx(db, k, user=AGENT, entity="ticket"), params) == 'Would assign "Printer jam" to agent@greensglobal.com'
    assert "only the service desk assigns tickets" in act.allowed(_ctx(db, k, user=SAM, entity="ticket"), params)
    with pytest.raises(RuntimeError, match="Could not assign: .*only the service desk assigns tickets"):
        act.run(_ctx(db, k, user=SAM, entity="ticket"), params)
    _clear_outbox(db)
    out = act.run(_ctx(db, k, user=AGENT, entity="ticket"), params)
    db.refresh(k)
    assert k.assignee_email == AGENT["email"] and k.assigned_by_email == AGENT["email"] and k.status == "in_progress"
    assert out["line"] == f'Assigned {k.code} "Printer jam" to agent@greensglobal.com'
    assert sorted(r.key for r in _outbox(db)) == ["ticket.assigned", "ticket.status_changed"]
    assert act.run(_ctx(db, k, user=AGENT, entity="ticket"), params)["line"].startswith("agent@greensglobal.com already holds")


def test_ticket_set_status_resolves_with_a_note(db):
    k = _ticket(db, subject="Printer jam")
    act = catalog.ACTIONS["ticket.set_status"]
    params = {"status": "resolved", "note": "Replaced the fuser"}
    assert act.plan(_ctx(db, k, user=DESK, entity="ticket"), params) == \
        'Would move "Printer jam" to Resolved with the note: Replaced the fuser'
    assert act.allowed(_ctx(db, None, user=OUTSIDER, entity="ticket"), params).endswith("change a ticket's status.")
    assert act.allowed(_ctx(db, k, user=OUTSIDER, entity="ticket"), params) == "You don't have access to this ticket"
    _clear_outbox(db)
    act.run(_ctx(db, k, user=DESK, entity="ticket"), params)
    db.refresh(k)
    assert k.status == "resolved" and k.resolution_note == "Replaced the fuser"
    assert sorted(r.key for r in _outbox(db)) == ["ticket.resolved", "ticket.status_changed"]
    # resolving a ticket still being worked needs the write-up - the desk's own rule, with its words
    fresh = _ticket(db, subject="No write-up")
    with pytest.raises(RuntimeError, match="Could not set the status: .*resolution"):
        act.run(_ctx(db, fresh, user=DESK, entity="ticket"), {"status": "resolved"})
    db.refresh(fresh)
    assert fresh.status == "open"


def test_ticket_request_approval_runs_as_a_supervisor(db):
    k = _ticket(db, type="access_request")
    plain = _ticket(db)
    act = catalog.ACTIONS["ticket.request_approval"]
    params = {"approver": [{"kind": "person", "value": PRIYA["email"]}], "note": "Please sign off"}
    assert act.plan(_ctx(db, k, user=DESK, entity="ticket"), params) == 'Would send "Laptop will not start" to priya@greensglobal.com for approval'
    # the desk access mode is legacy here, where every desk grant supervises - a plain employee never does
    assert "not a ticket supervisor" in act.allowed(_ctx(db, k, user=SAM, entity="ticket"), params)
    with pytest.raises(RuntimeError, match="Could not request approval: .*not a ticket supervisor"):
        act.run(_ctx(db, k, user=SAM, entity="ticket"), params)
    assert act.allowed(_ctx(db, plain, user=DESK, entity="ticket"), params) == "This ticket does not require approval."
    assert act.allowed(_ctx(db, None, user=DESK, entity="ticket"), params) == ""
    _clear_outbox(db)
    out = act.run(_ctx(db, k, user=DESK, entity="ticket"), params)
    db.refresh(k)
    assert k.approver_email == PRIYA["email"] and "for approval" in out["line"]
    assert [r.key for r in _outbox(db)] == ["ticket.approval_requested"]


def test_actions_need_a_record_of_their_kind(db):
    t = _task(db)
    with pytest.raises(RuntimeError, match="needs a ticket as its record"):
        catalog.ACTIONS["ticket.comment"].run(_ctx(db, t, user=DESK), {"text": "x"})
    k = _ticket(db)
    with pytest.raises(RuntimeError, match="needs a task as its record"):
        catalog.ACTIONS["task.comment"].run(_ctx(db, k, user=DESK, entity="ticket"), {"text": "x"})
    # a For Each item names the record by id
    out = catalog.ACTIONS["task.comment"].run(_ctx(db, None, user=MANAGER, item={"id": t.id}), {"text": "hello"})
    assert out["affected"][0]["id"] == t.id


# ── list sources ─────────────────────────────────────────────────────────────
def test_tasks_overdue_lists_open_past_due_tasks_the_run_as_may_see(db):
    old = (date.today() - timedelta(days=5)).isoformat()
    p = _project(db, name="Finance", access_level="restricted", members=[PRIYA["email"]])
    late = _task(db, title="Late", due_on=old)
    _patch(db, _task(db, title="Done", due_on=old).id, completed=True)
    _task(db, title="Not yet", due_on=(date.today() + timedelta(days=2)).isoformat())
    hidden = _task(db, title="Hidden", due_on=old, project_id=p.id)
    src = catalog.LIST_SOURCES["tasks.overdue"]
    assert {t.id for t in src.fn(db, _ctx(db, None, user=MANAGER), {"days": 0})} == {late.id, hidden.id}
    assert [t.id for t in src.fn(db, _ctx(db, None, user=SAM), {"days": 0})] == [late.id]
    assert src.fn(db, _ctx(db, None, user=MANAGER), {"days": 10}) == []


def test_tickets_unanswered_and_breaching_sla(db):
    k = _ticket(db, subject="Old and silent")
    k.created_at = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    answered = _ticket(db, subject="Answered")
    answered.created_at = k.created_at
    answered.first_response_at = now_iso()
    fresh = _ticket(db, subject="Just filed")
    breaching = _ticket(db, subject="Breaching")
    breaching.sla_due_at = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    db.commit()
    un = catalog.LIST_SOURCES["tickets.unanswered"]
    assert [t.subject for t in un.fn(db, _ctx(db, None, user=DESK, entity="ticket"), {"businessDays": 3})] == ["Old and silent"]
    assert {t.subject for t in un.fn(db, _ctx(db, None, user=DESK, entity="ticket"), {"businessDays": 0})} == \
        {"Old and silent", "Just filed", "Breaching"}
    assert un.fn(db, _ctx(db, None, user=OUTSIDER, entity="ticket"), {"businessDays": 0}) == []
    assert [t.subject for t in un.fn(db, _ctx(db, None, user=SAM, entity="ticket"), {"businessDays": 3})] == ["Old and silent"]
    br = catalog.LIST_SOURCES["tickets.breaching_sla"]
    assert [t.subject for t in br.fn(db, _ctx(db, None, user=DESK, entity="ticket"), {})] == ["Breaching"]
    assert fresh.id not in [t.id for t in br.fn(db, _ctx(db, None, user=DESK, entity="ticket"), {})]


def test_list_sources_scope_to_the_workflows_company(db):
    old = (date.today() - timedelta(days=5)).isoformat()
    t = _task(db, title="Late", due_on=old)
    t.company_id = "co-a"
    db.commit()
    src = catalog.LIST_SOURCES["tasks.overdue"]
    assert [x.id for x in src.fn(db, _ctx(db, None, user=MANAGER, company="co-a"), {})] == [t.id]
    assert src.fn(db, _ctx(db, None, user=MANAGER, company="co-b"), {}) == []


# ── the chain rule (spec 6.2) ────────────────────────────────────────────────
def test_workflow_task_change_runs_tasks_rules_and_tags_their_events(db):
    task_config.create_rule(task_config.RuleBody(
        name="Started work is high", trigger={"type": "status_changed", "value": "in_progress"},
        actions=[{"type": "set_priority", "value": "high"}], conditions=[], enabled=True), user=MANAGER, db=db)
    t = _task(db, title="Gate motor")
    _clear_outbox(db)
    # a workflow's step (CURRENT_RUN set) changes the status as the owner
    tok = emit_mod.CURRENT_RUN.set(("run-1", 1))
    try:
        catalog.ACTIONS["task.set_field"].run(_ctx(db, t, user=MANAGER), {"field": "status", "value": "in_progress"})
    finally:
        emit_mod.CURRENT_RUN.reset(tok)
    db.refresh(t)
    assert t.priority == "high"                                   # the Tasks rule ran, as on the owner's edit
    rows = _outbox(db)
    assert {r.key for r in rows} == {"task.field_changed", "task.status_changed"}
    status = [r for r in rows if r.key == "task.status_changed"]
    rule = [r for r in rows if r.key == "task.field_changed" and "priority" in r.payload["changes"]]
    assert len(status) == 1 and status[0].actor == MANAGER["email"]
    assert len(rule) == 1 and rule[0].actor == task_automation.AUTOMATION_ACTOR
    assert rule[0].payload["changes"] == {"priority": {"from": "medium", "to": "high"}}
    assert all(r.caused_by_run == "run-1" and r.depth == 2 for r in rows)
    acts = db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == t.id,
                                                models.TaskActivity.actor_email == task_automation.AUTOMATION_ACTOR).all()
    assert acts, "the rule's own activity rows are written as automation@nexus"
    # a plain person edit (no CURRENT_RUN): the rule runs again on the way back and nothing is tagged
    _patch(db, t.id, status="not_started")
    _patch(db, t.id, priority="medium")
    _clear_outbox(db)
    _patch(db, t.id, status="in_progress")
    rows = _outbox(db)
    assert {r.key for r in rows} == {"task.status_changed", "task.field_changed"}
    assert all(r.caused_by_run == "" and r.depth == 0 for r in rows)


def test_a_run_past_depth_two_emits_nothing_for_its_task_change(db):
    t = _task(db)
    _clear_outbox(db)
    tok = emit_mod.CURRENT_RUN.set(("run-9", 2))
    try:
        _patch(db, t.id, status="in_progress")
    finally:
        emit_mod.CURRENT_RUN.reset(tok)
    assert _outbox(db) == []
