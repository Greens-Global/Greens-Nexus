"""Workflows (Oct 28 2026) - Task 5: definition validation.

  * a sound definition has no problems;
  * an unknown event is a problem at trigger.event; a template path that
    resolves to nothing names the step and the param;
  * the Nexus run-as refuses an action that needs a person; every-company
    scope needs a Global Admin; more than 25 steps is refused; an approval
    needs a branch per option;
  * definition_hash is stable across key order.

    cd backend && python -m pytest test_workflows_validate.py -q
"""
import os
import tempfile

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog, validate  # noqa: E402

GA = {"email": "gail.wf@greensglobal.com", "role": "owner", "level": 5}
EDITOR = {"email": "ed.wf@greensglobal.com", "role": "supervisor", "level": 2}
NOBODY = {"email": "nob.wf@greensglobal.com", "role": "employee", "level": 1}
NO_HR = {"email": "loop.wf@greensglobal.com", "role": "supervisor", "level": 2}   # Workflows editor, no HR grant
ENTITY = "ent-val"


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    # throwaway actions: the core pack's real ones land in Task 6 - these
    # keep their keys out of the way (`test.` prefix)
    catalog.action("test.notify", label="Send A Test Notification", module="core",
                   params=[catalog.P("to", "To", "recipients"), catalog.P("title", "Title", "template", max=120),
                           catalog.P("body", "Message", "template", max=1000, required=False)],
                   plan=lambda ctx, p: "", run=lambda ctx, p: {}, needs_person=False)
    catalog.action("test.create_task", label="Create A Test Task", module="tasks",
                   params=[catalog.P("title", "Title", "template", max=200),
                           catalog.P("assignee", "Assignee", "person", required=False)],
                   plan=lambda ctx, p: "", run=lambda ctx, p: {}, needs_person=True,
                   allowed=lambda ctx, p: "" if (ctx.run_as or {}).get("level", 0) >= 2 else "Needs a supervisor")
    catalog.action("test.webhook", label="Call A Test Webhook", module="core",
                   params=[catalog.P("url", "URL", "text")],
                   plan=lambda ctx, p: "", run=lambda ctx, p: {}, admin_only=True)
    catalog.list_source("test.people_starting", label="People Starting Soon", entity="employee", module="hr",
                        params=[catalog.P("days", "Days", "number", default=14)], fn=lambda db, ctx, p: [])
    s = database.SessionLocal()
    s.add(models.NexusGroup(id="g-wf", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-wf", email=EDITOR["email"]))
    s.add(models.NexusGroup(id="g-wf-nohr", name="Workflow Editors Without HR", allowed_modules="workflows:editor"))
    s.add(models.NexusGroupMember(group_id="g-wf-nohr", email=NO_HR["email"]))
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
    yield s
    s.rollback()
    s.close()


def _definition(**over):
    d = {
        "v": 1,
        "trigger": {"kind": "event", "event": "employee.field_changed",
                    "filters": [{"field": "department", "op": "changed_to", "value": "Sales"}]},
        "conditions": [[{"field": "status", "op": "is", "value": "active"}]],
        "steps": [
            {"id": "s1", "kind": "action", "action": "test.notify", "enabled": True,
             "params": {"to": [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}],
                        "title": "{{ subject.name }} moved to {{ change.department.to }}",
                        "body": "Since {{ subject.start_date | us_date }} by {{ actor.name }}"}},
            {"id": "s2", "kind": "if", "conditions": [{"field": "employment_type", "op": "is", "value": "intern"}],
             "then": [{"id": "s3", "kind": "wait", "params": {"mode": "duration", "minutes": 60}}],
             "else": [{"id": "s4", "kind": "stop"}], "enabled": True},
        ],
        "settings": {"oncePerSubject": True, "maxRunsPerHour": 50, "onError": "stop"},
    }
    d.update(over)
    return d


def _paths(problems):
    return [p.path for p in problems]


def test_valid_definition_has_no_problems(db):
    assert validate.validate(db, _definition(), owner=GA, run_as="owner", company_id=ENTITY) == []
    assert validate.validate(db, _definition(), owner=EDITOR, run_as="owner", company_id=ENTITY) == []


def test_owner_without_the_grant_is_a_problem(db):
    probs = validate.validate(db, _definition(), owner=NOBODY, run_as="owner", company_id=ENTITY)
    assert "owner" in _paths(probs)
    assert any("Workflows grant" in p.message for p in probs)


def test_unknown_event_is_a_problem_at_trigger_event(db):
    d = _definition(trigger={"kind": "event", "event": "nope.nope"})
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["trigger.event"] and "nope.nope" in probs[0].message


def test_missing_template_path_names_the_step_and_param(db):
    d = _definition()
    d["steps"][0]["params"]["title"] = "Hello {{ subject.nope }}"
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].params.title"]
    assert "subject.nope" in probs[0].message


def test_comp_field_in_a_template_is_refused_for_a_non_comp_owner(db):
    catalog.ENTITIES["employee"].fields.append(catalog.F("pay", "Pay", "money", visibility="comp",
                                                         path="compensation.base"))
    try:
        d = _definition()
        d["steps"][0]["params"]["title"] = "Pay {{ subject.pay }}"
        probs = validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY)
        assert _paths(probs) == ["steps[0].params.title"]
        assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []
        d["conditions"] = [[{"field": "pay", "op": "gt", "value": 1}]]
        probs = validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY)
        assert "conditions[0][0].field" in _paths(probs)
    finally:
        catalog.ENTITIES["employee"].fields.pop()


def test_nexus_run_as_refuses_create_task(db):
    d = _definition()
    d["steps"].append({"id": "s5", "kind": "action", "action": "test.create_task",
                       "params": {"title": "Set up {{ subject.name }}"}})
    assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []
    probs = validate.validate(db, d, owner=GA, run_as="nexus", company_id=ENTITY)
    assert _paths(probs) == ["steps[2].action"] and "Nexus" in probs[0].message
    probs = validate.validate(db, d, owner=EDITOR, run_as="nexus", company_id=ENTITY)
    assert "runAs" in _paths(probs)


def test_action_allowed_rule_runs_against_the_sample(db):
    d = _definition(steps=[{"id": "s1", "kind": "action", "action": "test.create_task",
                            "params": {"title": "x"}}])
    assert validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY) == []
    probs = validate.validate(db, d, owner={**NOBODY, "level": 4}, run_as="owner", company_id=ENTITY)
    assert validate.validate(db, d, owner={**NOBODY, "level": 1}, run_as="owner", company_id=ENTITY)
    assert probs == []


def test_every_company_needs_global_admin(db):
    probs = validate.validate(db, _definition(), owner=EDITOR, run_as="owner", company_id="")
    assert _paths(probs) == ["companyId"]
    assert validate.validate(db, _definition(), owner=GA, run_as="owner", company_id="") == []


def test_admin_only_action_needs_global_admin(db):
    d = _definition(steps=[{"id": "s1", "kind": "action", "action": "test.webhook", "params": {"url": "https://x"}}])
    assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []
    probs = validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].action"]


def test_too_many_steps(db):
    steps = [{"id": f"s{i}", "kind": "stop"} for i in range(26)]
    probs = validate.validate(db, _definition(steps=steps), owner=GA, run_as="owner", company_id=ENTITY)
    assert "steps" in _paths(probs) and any("25" in p.message for p in probs)
    # nested steps count too
    inner = [{"id": f"n{i}", "kind": "stop"} for i in range(24)]
    steps = [{"id": "a", "kind": "if", "conditions": [], "then": inner, "else": []},
             {"id": "b", "kind": "stop"}, {"id": "c", "kind": "stop"}]
    probs = validate.validate(db, _definition(steps=steps), owner=GA, run_as="owner", company_id=ENTITY)
    assert "steps" in _paths(probs)


def test_duplicate_and_missing_step_ids(db):
    steps = [{"id": "s1", "kind": "stop"}, {"id": "s1", "kind": "stop"}, {"kind": "stop"}]
    probs = validate.validate(db, _definition(steps=steps), owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[1].id", "steps[2].id"]


def test_approval_needs_branch_per_option(db):
    step = {"id": "ap", "kind": "approval",
            "params": {"approvers": [{"kind": "manager"}], "mode": "any", "question": "OK for {{ subject.name }}?",
                       "options": ["Approve", "Decline"], "remindDays": 2},
            "branches": {"Approve": [{"id": "y", "kind": "stop"}]}}
    probs = validate.validate(db, _definition(steps=[step]), owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].branches.Decline"]
    step["branches"]["Decline"] = []
    assert validate.validate(db, _definition(steps=[step]), owner=GA, run_as="owner", company_id=ENTITY) == []
    step["params"]["options"] = ["Only"]
    probs = validate.validate(db, _definition(steps=[step]), owner=GA, run_as="owner", company_id=ENTITY)
    assert "steps[0].params.options" in _paths(probs)
    step["params"]["options"] = ["Approve", "Decline"]
    step["params"]["approvers"] = []
    probs = validate.validate(db, _definition(steps=[step]), owner=GA, run_as="owner", company_id=ENTITY)
    assert "steps[0].params.approvers" in _paths(probs)


def test_conditions_filters_and_recipients_are_checked(db):
    d = _definition(conditions=[[{"field": "nope", "op": "is", "value": "x"},
                                 {"field": "status", "op": "gt", "value": 1},
                                 {"field": "start_date", "op": "within_next_days", "value": "soon"},
                                 {"field": "department", "op": "is", "value": ""}]])
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["conditions[0][0].field", "conditions[0][1].op", "conditions[0][2].value",
                             "conditions[0][3].value"]
    d = _definition(trigger={"kind": "event", "event": "employee.created",
                             "filters": [{"field": "status", "op": "changed_to", "value": "active"}]})
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    # created carries no change: the filter's changed_to and the title's {{ change.department.to }}
    assert _paths(probs) == ["trigger.filters[0].op", "steps[0].params.title"]
    d = _definition()
    d["steps"][0]["params"]["to"] = [{"kind": "person", "value": "not-an-email"}, {"kind": "assignees"},
                                     {"kind": "role", "value": "boss"}]
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].params.to[0]", "steps[0].params.to[1]", "steps[0].params.to[2]"]


def test_required_params_and_unknown_params(db):
    d = _definition(steps=[{"id": "s1", "kind": "action", "action": "test.notify",
                            "params": {"to": [{"kind": "self"}], "extra": 1}}])
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].params.title", "steps[0].params.extra"]
    d["steps"][0]["params"]["title"] = "x" * 121
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert any(p.path == "steps[0].params.title" and "120" in p.message for p in probs)


def test_disabled_step_is_not_checked(db):
    d = _definition(steps=[{"id": "s1", "kind": "action", "action": "nope", "enabled": False},
                           {"id": "s2", "kind": "stop"}])
    assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []


def test_schedule_date_manual_triggers_and_for_each(db):
    sched = {"kind": "schedule", "every": "week", "days": [1], "time": "08:00", "zone": "company"}
    steps = [{"id": "fe", "kind": "for_each", "source": {"key": "test.people_starting", "params": {"days": 14}},
              "as": "item", "steps": [{"id": "n", "kind": "action", "action": "test.notify",
                                       "params": {"to": [{"kind": "global_admins"}],
                                                  "title": "{{ item.name }} starts {{ item.start_date | us_date }}"}}]}]
    d = _definition(trigger=sched, conditions=[], steps=steps)
    assert validate.validate(db, d, owner=GA, run_as="nexus", company_id="") == []
    bad = dict(sched, every="hour", time="8am", days=["mon"])
    probs = validate.validate(db, _definition(trigger=bad, conditions=[], steps=steps), owner=GA, run_as="owner",
                              company_id=ENTITY)
    assert _paths(probs) == ["trigger.every", "trigger.days", "trigger.time"]
    plain = [{"id": "p1", "kind": "action", "action": "test.notify",
              "params": {"to": [{"kind": "self"}], "title": "{{ subject.name }} on {{ today | us_date }}"}}]
    date_t = {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": -14, "time": "08:00"}
    assert validate.validate(db, _definition(trigger=date_t, conditions=[], steps=plain), owner=GA, run_as="owner",
                             company_id=ENTITY) == []
    # a date trigger carries no change: the default steps' {{ change.department.to }} is a problem
    probs = validate.validate(db, _definition(trigger=date_t, conditions=[]), owner=GA, run_as="owner",
                              company_id=ENTITY)
    assert _paths(probs) == ["steps[0].params.title"]
    probs = validate.validate(db, _definition(trigger=dict(date_t, field="department"), conditions=[], steps=plain),
                              owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["trigger.field"]
    assert validate.validate(db, _definition(trigger={"kind": "manual", "entity": "employee"}, conditions=[],
                                             steps=plain), owner=GA, run_as="owner", company_id=ENTITY) == []
    probs = validate.validate(db, _definition(trigger={"kind": "manual", "entity": "thing"}, conditions=[],
                                              steps=plain), owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["trigger.entity"]
    steps[0]["source"] = {"key": "nope"}
    probs = validate.validate(db, _definition(trigger=sched, conditions=[], steps=steps), owner=GA, run_as="owner",
                              company_id=ENTITY)
    assert "steps[0].source" in _paths(probs)


def test_for_each_needs_the_lists_module_grant_and_hides_item_fields(db):
    """H2: a For Each over an HR list needs the HR grant like an HR event
    does, and the nested templates see the item as the owner would - a
    comp field is not a field for a non-comp owner."""
    sched = {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"}
    steps = [{"id": "fe", "kind": "for_each", "source": {"key": "test.people_starting", "params": {"days": 14}},
              "as": "item", "steps": [{"id": "n", "kind": "action", "action": "test.notify",
                                       "params": {"to": [{"kind": "global_admins"}], "title": "{{ item.name }}"}}]}]
    d = _definition(trigger=sched, conditions=[], steps=steps)
    probs = validate.validate(db, d, owner=NO_HR, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["steps[0].source"] and "People Starting Soon" in probs[0].message
    assert validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY) == []
    catalog.ENTITIES["employee"].fields.append(catalog.F("pay", "Pay", "money", visibility="comp",
                                                         path="compensation.base"))
    try:
        d["steps"][0]["steps"][0]["params"]["title"] = "{{ item.name }} earns {{ item.pay }}"
        probs = validate.validate(db, d, owner=EDITOR, run_as="owner", company_id=ENTITY)
        assert _paths(probs) == ["steps[0].steps[0].params.title"] and "item.pay" in probs[0].message
        assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []
    finally:
        catalog.ENTITIES["employee"].fields.pop()


def test_date_and_manual_triggers_need_the_modules_grant_and_a_visible_date(db):
    """M1: a date or manual trigger on a module's records needs that
    module's grant like an event does, and a date the owner may not see is
    refused."""
    plain = [{"id": "p1", "kind": "action", "action": "test.notify",
              "params": {"to": [{"kind": "self"}], "title": "{{ subject.name }} on {{ today | us_date }}"}}]
    date_t = {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": 0, "time": "08:00"}
    probs = validate.validate(db, _definition(trigger=date_t, conditions=[], steps=plain), owner=NO_HR,
                              run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["trigger.entity"] and "Person" in probs[0].message
    probs = validate.validate(db, _definition(trigger={"kind": "manual", "entity": "employee"}, conditions=[],
                                              steps=plain), owner=NO_HR, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["trigger.entity"]
    assert validate.validate(db, _definition(trigger=date_t, conditions=[], steps=plain), owner=EDITOR,
                             run_as="owner", company_id=ENTITY) == []
    emp = catalog.ENTITIES["employee"]
    emp.fields.append(catalog.F("pay_review", "Pay Review", "date", visibility="comp", path="compensation.review"))
    emp.dates.append(catalog.D("pay_review", "Pay Review"))
    try:
        hidden = dict(date_t, field="pay_review")
        probs = validate.validate(db, _definition(trigger=hidden, conditions=[], steps=plain), owner=EDITOR,
                                  run_as="owner", company_id=ENTITY)
        assert _paths(probs) == ["trigger.field"] and probs[0].message == "You may not use Pay Review"
        assert validate.validate(db, _definition(trigger=hidden, conditions=[], steps=plain), owner=GA,
                                 run_as="owner", company_id=ENTITY) == []
    finally:
        emp.fields.pop()
        emp.dates.pop()


def test_settings_caps(db):
    d = _definition(settings={"maxRunsPerHour": 501, "maxRecipients": 201, "onError": "retry", "bogus": 1,
                              "cooldownHours": -1})
    probs = validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["settings.maxRunsPerHour", "settings.maxRecipients", "settings.cooldownHours",
                             "settings.onError", "settings.bogus"]
    d = _definition(settings={"onError": "continue", "faultSteps": [{"id": "f1", "kind": "action", "action": "test.notify",
                                                                     "params": {"to": [{"kind": "owner"}],
                                                                                "title": "Failed: {{ workflow.name }}"}}]})
    assert validate.validate(db, d, owner=GA, run_as="owner", company_id=ENTITY) == []


def test_bad_shape_and_version(db):
    probs = validate.validate(db, {"v": 2, "trigger": "x", "steps": "y"}, owner=GA, run_as="owner", company_id=ENTITY)
    assert _paths(probs) == ["v", "trigger", "steps"]
    assert validate.validate(db, "nope", owner=GA, run_as="owner", company_id=ENTITY)[0].path == ""


def test_hash_is_stable_across_key_order():
    a = {"v": 1, "trigger": {"kind": "manual", "entity": "employee"}, "steps": [{"id": "s", "kind": "stop"}]}
    b = {"steps": [{"kind": "stop", "id": "s"}], "trigger": {"entity": "employee", "kind": "manual"}, "v": 1}
    assert validate.definition_hash(a) == validate.definition_hash(b)
    assert validate.definition_hash(a) != validate.definition_hash({**a, "v": 2})
    assert len(validate.definition_hash(a)) == 64
