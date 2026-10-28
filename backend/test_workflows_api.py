"""Workflows (Oct 28 2026) - Task 8: the API under /workflows.

  * a viewer lists only their company's (and every-company) workflows and
    may not create; an editor creates a draft, cannot publish it untested,
    and after a Test publishes a version (an AuditLog row is written);
  * pause-all is for Global Admins only; Run needs a manual trigger;
  * the runs Actions view lists what each step did; the automations
    register lists the Tasks rules and the jobs and toggles a rule through
    the Tasks endpoint; every built-in template the catalog can serve
    validates for a Global Admin;
  * settings: the org row, a company override and its reset; the catalog
    marks new entries; recent events feed the Test.

    cd backend && python -m pytest test_workflows_api.py -q
"""
import os
import tempfile
from urllib.parse import quote

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import workflows  # noqa: E402
from workflows import catalog, store, templates, validate  # noqa: E402

ENTITY, OTHER = "ent-api", "ent-api-other"
GAIL, EDDIE, VERA, NOB, MAX, HANA, ZED = ("gail.api@greensglobal.com", "eddie.api@greensglobal.com",
                                          "vera.api@greensglobal.com", "nob.api@greensglobal.com",
                                          "max.api@greensglobal.com", "hana.api@greensglobal.com",
                                          "zed.api@greensglobal.com")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Api", hr_contact_email=HANA))
    s.add(models.HrEntity(id=OTHER, name="Other Api"))
    people = [(GAIL, "Gail", ENTITY, ""), (EDDIE, "Eddie", ENTITY, MAX), (VERA, "Vera", ENTITY, MAX),
              (NOB, "Nob", ENTITY, MAX), (MAX, "Max", ENTITY, ""), (HANA, "Hana", ENTITY, ""), (ZED, "Zed", OTHER, "")]
    for email, first, company, mgr in people:
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Api",
                                   company=company, status="active", manager_email=mgr, start_date="2026-11-12",
                                   department="Operations"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusRole(email=EDDIE, role="supervisor"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusRole(email=ZED, role="manager"))
    s.add(models.NexusGroup(id="g-api-ed", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-api-ed", email=EDDIE))
    s.add(models.NexusGroupMember(group_id="g-api-ed", email=ZED))
    s.add(models.NexusGroup(id="g-api-vw", name="Workflow Viewers", allowed_modules="workflows:viewer"))
    s.add(models.NexusGroupMember(group_id="g-api-vw", email=VERA))
    s.add(models.NexusGroup(id="g-api-hr", name="HR", allowed_modules="hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-api-hr", email=HANA))
    s.add(models.NexusSetting(key="company_walls", value="on"))
    s.add(models.TaskAutomationRule(id="rule-1", name="Urgent To Max", trigger={"type": "priority_changed", "value": "urgent"},
                                    actions=[{"type": "add_assignee", "value": MAX}], enabled=True, created_at="2026-10-01"))
    s.commit()
    s.close()
    auth._role_cache.clear()
    cache.module_grants.invalidate()
    try:
        cache.settings_config.invalidate()
    except AttributeError:
        pass
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
              models.NexusNotification, models.AuditLog):
        s.query(m).delete()
    s.query(models.NexusSetting).filter(models.NexusSetting.key.like("workflows.%")).delete(synchronize_session=False)
    s.commit()
    yield s
    s.rollback()
    s.close()


def as_user(email: str) -> None:
    os.environ["NEXUS_DEV_EMAIL"] = email
    auth._role_cache.clear()


NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
          "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} is now {{ change.status.to }}"}}
DEFINITION = {"v": 1, "trigger": {"kind": "event", "event": "employee.status_changed", "filters": []},
              "conditions": [], "steps": [NOTIFY], "settings": dict(validate.DEFAULT_SETTINGS)}


def _published(db, *, owner=EDDIE, company=ENTITY, name="Status Watch", definition=None):
    wf = store.create(db, name=name, owner=owner, company_id=company, definition=definition or DEFINITION, by=owner)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, owner)
    db.commit()
    return wf


def _event(db, who="e-vera"):
    row = db.get(models.NexusEmployee, who)
    workflows.emit(db, "employee.status_changed", subject=row, actor=HANA, changes={"status": ("active", "offboarded")})
    db.commit()
    return db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at.desc()).first()


# ── listing and creating ─────────────────────────────────────────────────────
def test_viewer_lists_only_scope(client, db):
    _published(db, name="Mine")
    _published(db, owner=ZED, company=OTHER, name="Theirs")
    _published(db, owner=GAIL, company="", name="Everyone")
    as_user(VERA)
    names = sorted(w["name"] for w in client.get("/workflows?scope=all").json())
    assert names == ["Everyone", "Mine"]
    row = next(w for w in client.get("/workflows?scope=company").json() if w["name"] == "Mine")
    assert row["companyName"] == "Greens Api" and row["ownerName"] == "Eddie Api" and row["status"] == "active"
    assert row["triggerText"] == "When Person Status Changes" and row["version"] == 1 and "definition" not in row
    assert client.get("/workflows?scope=mine").json() == []
    assert client.post("/workflows", json={"name": "No", "companyId": ""}).status_code == 403
    as_user(NOB)
    assert client.get("/workflows").status_code == 403
    as_user(GAIL)
    assert len(client.get("/workflows?scope=all").json()) == 3
    assert [w["name"] for w in client.get("/workflows?scope=all&q=their").json()] == ["Theirs"]
    assert client.get("/workflows?q=their").json() == []        # the default scope is the caller's company


def test_editor_creates_draft_and_cannot_publish_untested(client, db):
    as_user(EDDIE)
    r = client.post("/workflows", json={"name": "New One", "companyId": ""})
    assert r.status_code == 201, r.text
    wf = r.json()
    assert wf["status"] == "draft" and wf["companyId"] == ENTITY        # blank = the editor's own company
    assert wf["ownerEmail"] == EDDIE and wf["testedCurrent"] is False and wf["draft"]["v"] == 1
    r = client.put(f"/workflows/{wf['id']}/draft", json={"definition": DEFINITION, "name": "Status Watch"})
    assert r.status_code == 200 and r.json()["name"] == "Status Watch" and r.json()["problems"] == []
    assert r.json()["hasDraft"] and r.json()["testedCurrent"] is False
    r = client.post(f"/workflows/{wf['id']}/publish", json={"note": ""})
    assert r.status_code == 422 and r.json()["detail"] == "Test this workflow before publishing"
    # a draft with problems says which
    bad = {**DEFINITION, "steps": [{**NOTIFY, "params": {**NOTIFY["params"], "title": "{{ subject.nope }}"}}]}
    client.put(f"/workflows/{wf['id']}/draft", json={"definition": bad})
    r = client.post(f"/workflows/{wf['id']}/publish", json={"note": ""})
    assert r.status_code == 422 and r.json()["detail"]["problems"][0]["path"] == "steps[0].params.title"
    # another company is not the editor's to pick; every company needs a Global Admin
    assert client.put(f"/workflows/{wf['id']}/draft", json={"definition": DEFINITION, "companyId": OTHER}).status_code == 404
    assert client.put(f"/workflows/{wf['id']}/draft", json={"definition": DEFINITION, "companyId": ""}).status_code == 403
    assert client.put(f"/workflows/{wf['id']}/draft", json={"definition": DEFINITION, "runAs": "nexus"}).status_code == 403
    # a viewer may not edit it; Zed (another company) does not see it
    as_user(VERA)
    assert client.put(f"/workflows/{wf['id']}/draft", json={"definition": DEFINITION}).status_code == 403
    as_user(ZED)
    assert client.get(f"/workflows/{wf['id']}").status_code == 404


def test_publish_after_test_bumps_version_and_writes_audit(client, db):
    as_user(EDDIE)
    wf = client.post("/workflows", json={"name": "Status Watch", "definition": DEFINITION}).json()
    r = client.post(f"/workflows/{wf['id']}/test", json={})
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["status"] == "test" and t["subjectLabel"] == "Priya Shah" and t["testedCurrent"] is True
    assert t["steps"][0]["status"] == "planned" and t["steps"][0]["detail"].startswith("Would notify")
    assert t["trace"] == [] and t["conditionsPassed"] is True
    r = client.post(f"/workflows/{wf['id']}/publish", json={"note": "go"})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["status"] == "active" and r.json()["hasDraft"] is False
    log = db.query(models.AuditLog).filter(models.AuditLog.action == "workflow.publish").one()
    assert log.user_email == EDDIE and log.resource_id == wf["id"] and log.module == "workflows"
    versions = client.get(f"/workflows/{wf['id']}/versions").json()
    assert versions == [{"version": 1, "publishedBy": EDDIE, "publishedByName": "Eddie Api",
                         "publishedAt": versions[0]["publishedAt"], "note": "go"}]
    assert client.get(f"/workflows/{wf['id']}/versions/1").json()["definition"]["steps"][0]["id"] == "n1"
    # a second version and the diff
    d2 = {**DEFINITION, "steps": [NOTIFY, {"id": "s2", "kind": "stop"}]}
    client.put(f"/workflows/{wf['id']}/draft", json={"definition": d2})
    client.post(f"/workflows/{wf['id']}/test", json={})
    assert client.post(f"/workflows/{wf['id']}/publish", json={}).json()["version"] == 2
    assert client.get(f"/workflows/{wf['id']}/diff?a=1&b=2").json() == {"lines": ["Step 2 added: Stop"]}
    assert client.post(f"/workflows/{wf['id']}/versions/1/restore").json()["version"] == 3
    # pause / resume / archive through status
    r = client.post(f"/workflows/{wf['id']}/status", json={"status": "paused", "reason": "testing"})
    assert r.json()["status"] == "paused" and r.json()["pausedReason"] == "testing" and r.json()["pausedBy"] == EDDIE
    assert client.post(f"/workflows/{wf['id']}/status", json={"status": "active"}).json()["status"] == "active"
    assert client.post(f"/workflows/{wf['id']}/status", json={"status": "archived"}).json()["status"] == "archived"
    assert client.get("/workflows?scope=mine").json() == []
    assert client.get("/workflows?scope=mine&status=archived").json()[0]["id"] == wf["id"]
    as_user(GAIL)
    r = client.post(f"/workflows/{wf['id']}/reown", json={"owner": MAX})
    assert r.status_code == 200 and r.json()["ownerEmail"] == MAX
    assert client.post(f"/workflows/{wf['id']}/reown", json={"owner": "nobody@x.com"}).status_code == 422
    r = client.post(f"/workflows/{wf['id']}/duplicate", json={"name": "Copy", "companyId": ""})
    assert r.status_code == 201 and r.json()["status"] == "draft" and r.json()["companyId"] == ""


# ── switches and runs ────────────────────────────────────────────────────────
def test_pause_all_is_global_admin_only(client, db):
    as_user(EDDIE)
    assert client.post("/workflows/settings/pause-all", json={"paused": True}).status_code == 403
    as_user(GAIL)
    r = client.post("/workflows/settings/pause-all", json={"paused": True})
    assert r.status_code == 200 and r.json()["pausedAll"] is True and r.json()["pausedBy"] == GAIL
    assert client.get("/workflows/overview").json()["pausedAll"]["paused"] is True
    r = client.post("/workflows/settings/pause-all", json={"paused": False})
    assert r.json() == {"pausedAll": False, "pausedBy": "", "pausedAt": ""}
    assert db.query(models.AuditLog).filter(models.AuditLog.action.like("workflows.%")).count() == 2


def test_run_endpoint_requires_manual_trigger(client, db):
    wf = _published(db)
    as_user(EDDIE)
    r = client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"})
    assert r.status_code == 409 and "manual" in r.json()["detail"]
    manual = {**DEFINITION, "trigger": {"kind": "manual", "entity": "employee"},
              "steps": [{"id": "n1", "kind": "action", "action": "notify",
                         "params": {"to": [{"kind": "manager"}], "title": "Checked {{ subject.name }}"}}]}
    wf2 = _published(db, name="By Hand", definition=manual)
    r = client.post(f"/workflows/{wf2.id}/run", json={"subjectId": "e-vera"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded" and r.json()["startedBy"] == EDDIE and r.json()["triggerKind"] == "manual"
    assert db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MAX).one().title == "Checked Vera Api"
    assert client.post(f"/workflows/{wf2.id}/run", json={"subjectId": "e-zed"}).status_code == 404   # other company
    as_user(VERA)
    assert client.post(f"/workflows/{wf2.id}/run", json={"subjectId": "e-vera"}).status_code == 403


def test_runs_actions_view_lists_affected_rows(client, db):
    from workflows import engine
    _published(db)
    engine.handle_event(db, _event(db))
    as_user(VERA)
    r = client.get("/workflows/runs?kind=runs&limit=10")
    assert r.status_code == 200
    runs = r.json()
    assert runs["next"] is None and len(runs["items"]) == 1
    run = runs["items"][0]
    assert run["status"] == "succeeded" and run["subjectLabel"] == "Vera Api" and run["workflowName"] == "Status Watch"
    r = client.get("/workflows/runs?kind=actions")
    acts = r.json()["items"]
    assert len(acts) == 1 and acts[0]["action"] == "notify" and acts[0]["actionLabel"] == "Send A Notification"
    assert acts[0]["sent"] == [MAX] and acts[0]["line"] == "Notified Max Api: Vera Api is now offboarded"
    assert acts[0]["runId"] == run["id"] and acts[0]["affected"] == []
    detail = client.get(f"/workflows/runs/{run['id']}").json()
    assert detail["steps"][0]["output"]["sent"] == [MAX] and detail["event"]["key"] == "employee.status_changed"
    assert detail["subjectLink"] == {"view": "hr", "sub": "people:e-vera"}
    # keyset paging
    engine.handle_event(db, _event(db, "e-nob"))
    page = client.get("/workflows/runs?limit=1").json()
    assert page["next"] and len(page["items"]) == 1
    page2 = client.get(f"/workflows/runs?limit=1&before={page['next']}").json()
    assert page2["items"][0]["id"] != page["items"][0]["id"]
    # the cursor is (started_at, id): runs that started on the same instant are never dropped or repeated
    engine.handle_event(db, _event(db, "e-nob"))
    from datetime import datetime, timedelta, timezone
    same = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    for r_ in db.query(models.WorkflowRun).all():
        r_.started_at = same
    for s_ in db.query(models.WorkflowRunStep).all():
        s_.started_at = same
    db.commit()
    for kind_ in ("runs", "actions"):
        seen, cursor = [], ""
        for _ in range(10):
            pg = client.get(f"/workflows/runs?kind={kind_}&limit=1" + (f"&before={quote(cursor)}" if cursor else "")).json()
            seen += [x["id"] for x in pg["items"]]
            cursor = pg["next"]
            if not cursor:
                break
        whole = [x["id"] for x in client.get(f"/workflows/runs?kind={kind_}&limit=100").json()["items"]]
        assert len(whole) >= 3 and len(seen) == len(set(seen)) == len(whole) and set(seen) == set(whole), (kind_, seen)
    assert "|" in page["next"]
    # a viewer may not replay or cancel; the owner may
    assert client.post(f"/workflows/runs/{run['id']}/replay").status_code == 403
    as_user(EDDIE)
    assert client.post(f"/workflows/runs/{run['id']}/replay").status_code == 409     # not failed
    assert client.post(f"/workflows/runs/{run['id']}/cancel").status_code == 409     # not waiting
    ov = client.get("/workflows/overview").json()
    assert ov["last24h"] == {"runs": 3, "succeeded": 3, "failed": 0, "waiting": 0} and len(ov["recent"]) == 3
    assert ov["needsAttention"] == [] and ov["counts"]["active"] == 1


def test_overview_needs_attention_and_nav_count(client, db):
    wf = _published(db)
    store.set_status(db, wf, "needs_attention", "workflows@nexus", "Paused: ran 100 times in an hour")
    db.commit()
    as_user(EDDIE)
    ov = client.get("/workflows/overview").json()
    assert ov["needsAttention"] == [{"id": wf.id, "name": "Status Watch", "reason": "Paused: ran 100 times in an hour",
                                     "since": ov["needsAttention"][0]["since"]}]
    counts = client.get("/me/action-counts").json()["counts"]
    assert counts["workflows"] == {"overview": 1}
    # switching it back on re-checks the health
    assert client.post(f"/workflows/{wf.id}/status", json={"status": "active"}).json()["status"] == "active"


# ── the register, templates, settings ────────────────────────────────────────
def test_automations_lists_task_rules_and_jobs_and_toggles(client, db):
    as_user(VERA)
    r = client.get("/workflows/automations")
    assert r.status_code == 200
    data = r.json()
    rule = next(x for x in data["taskRules"] if x["id"] == "rule-1")
    assert rule["enabled"] is True and rule["triggerText"] == "When a task's priority changes to urgent"
    assert rule["companyId"] == "" and rule["runCount"] == 0 and rule["runsLink"]["view"] == "tasks"
    assert len(data["jobs"]) >= 30 and all({"key", "label", "what", "every", "settingLink"} <= set(j) for j in data["jobs"])
    assert next(j for j in data["jobs"] if j["key"] == "workflows")["every"] == "Every 5 seconds"
    # a viewer below manager tier cannot switch a Tasks rule; a manager can
    assert client.post("/workflows/automations/task-rules/rule-1/enabled", json={"enabled": False}).status_code == 403
    as_user(GAIL)
    r = client.post("/workflows/automations/task-rules/rule-1/enabled", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    db.expire_all()
    assert db.get(models.TaskAutomationRule, "rule-1").enabled is False
    client.post("/workflows/automations/task-rules/rule-1/enabled", json={"enabled": True})


def test_templates_all_validate(client, db):
    ga = {"email": GAIL, "role": "owner", "level": 5}
    assert len(templates.TEMPLATES) == 9
    # every pack is loaded: no template has a need the catalog does not meet
    for t in templates.TEMPLATES:
        assert templates.missing(t) == [], (t["key"], templates.missing(t))
        probs = validate.validate(db, t["definition"], owner=ga, run_as="owner", company_id="")
        assert probs == [], (t["key"], [p.to_dict() for p in probs])
    as_user(VERA)
    served = client.get("/workflows/templates").json()
    assert {t["key"] for t in served} == {t["key"] for t in templates.TEMPLATES if not templates.missing(t)}
    assert all({"key", "name", "module", "description", "definition", "blanks", "requires"} <= set(t) for t in served)
    assert client.post("/workflows/templates/new_hire_welcome/use", json={"name": "Welcome"}).status_code == 403
    as_user(EDDIE)
    r = client.post("/workflows/templates/new_hire_welcome/use", json={"name": "Welcome", "companyId": ENTITY})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "draft" and r.json()["blanks"] == ["steps[1].params.body"] and r.json()["problems"] == []
    assert client.post("/workflows/templates/nope/use", json={"name": "x"}).status_code == 404
    # a full-level user saves a company template and sees it in the gallery
    as_user(GAIL)
    wf = _published(db, owner=GAIL)
    r = client.post(f"/workflows/{wf.id}/save-as-template", json={"name": "Our Status Watch"})
    assert r.status_code == 201 and r.json()["module"] == "custom" and r.json()["companyId"] == ENTITY
    assert any(t["name"] == "Our Status Watch" for t in client.get("/workflows/templates").json())
    as_user(EDDIE)
    assert client.post(f"/workflows/{wf.id}/save-as-template", json={}).status_code == 403


def test_settings_roundtrip_and_override_reset(client, db):
    as_user(EDDIE)
    assert client.get("/workflows/settings").status_code == 403
    as_user(GAIL)
    r = client.get("/workflows/settings")
    assert r.status_code == 200
    s = r.json()
    assert s["enabled"] is True and s["pausedAll"] is False and s["webhookHosts"] == [] and s["override"] is False
    assert {"id": ENTITY, "name": "Greens Api", "own": True} in s["companies"] and "webhookSecrets" not in s
    r = client.put("/workflows/settings", json={"webhookHosts": ["Hooks.Example.com"], "maxRunsPerHourCap": 900,
                                                 "webhookSecrets": {"hooks.example.com": "s3cret"}, "nexusRunAs": True})
    assert r.status_code == 200
    s = r.json()
    assert s["webhookHosts"] == ["hooks.example.com"] and s["maxRunsPerHourCap"] == 500      # clamped
    assert s["webhookSecretsSet"] == ["hooks.example.com"] and s["nexusRunAs"] is True
    r = client.put(f"/workflows/settings?company={ENTITY}", json={"enabled": False, "maxRecipientsCap": 20})
    assert r.json()["enabled"] is False and r.json()["override"] is True and r.json()["maxRecipientsCap"] == 20
    # the company switch travels with every workflow of that company (the list shows "Paused: company switch")
    wf = _published(db, owner=GAIL, name="Switched Off")
    every = _published(db, owner=GAIL, company="", name="Everywhere")
    assert client.get(f"/workflows/{wf.id}").json()["companyEnabled"] is False
    assert client.get(f"/workflows/{every.id}").json()["companyEnabled"] is True
    rows = {w["id"]: w for w in client.get("/workflows?scope=all").json()}
    assert rows[wf.id]["companyEnabled"] is False and rows[every.id]["companyEnabled"] is True
    assert r.json()["nexusRunAs"] is True                                                  # org-only, still read
    assert client.get("/workflows/settings").json()["enabled"] is True
    r = client.put(f"/workflows/settings?company={ENTITY}", json={"override": False})
    assert r.json()["override"] is False and r.json()["enabled"] is True
    assert client.get(f"/workflows/{wf.id}").json()["companyEnabled"] is True
    assert client.get(f"/workflows/settings?company={OTHER}").status_code == 200
    assert client.get("/workflows/settings?company=nope").status_code == 404


def test_catalog_marks_new_entries_and_recent_events_feed_the_test(client, db):
    as_user(EDDIE)
    cat = client.get("/workflows/catalog").json()
    assert cat["newSince"] == [] and cat["lastSeen"] == ""     # a first visit: nothing is new
    assert any(e["key"] == "employee.status_changed" for e in cat["events"])
    assert client.post("/workflows/catalog/seen").status_code == 200
    catalog.action("test.api_new", label="New Thing", module="core", params=[], plan=lambda c, p: "", run=lambda c, p: {},
                   needs_person=False)
    cat = client.get("/workflows/catalog").json()
    assert cat["newSince"] == ["test.api_new"] and cat["lastSeen"]
    wf = _published(db)
    ev = _event(db)
    _event(db, "e-zed")      # another company's event is not offered
    rows = client.get(f"/workflows/{wf.id}/recent-events").json()
    assert [r["id"] for r in rows] == [ev.id] and rows[0]["subjectLabel"] == "Vera Api" and rows[0]["actor"] == HANA
    r = client.post(f"/workflows/{wf.id}/test", json={"eventId": ev.id})
    assert r.status_code == 200 and r.json()["subjectLabel"] == "Vera Api"
    assert r.json()["steps"][0]["detail"] == "Would notify Max Api: Vera Api is now offboarded"
    assert client.post(f"/workflows/{wf.id}/test", json={"eventId": "nope"}).status_code == 404
    sched = {**DEFINITION, "trigger": {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"},
             "steps": [{"id": "n1", "kind": "action", "action": "notify",
                        "params": {"to": [{"kind": "global_admins"}], "title": "Tick {{ subject.name }}"}}]}
    wf2 = _published(db, owner=GAIL, company="", name="Daily", definition=sched)
    as_user(GAIL)
    r = client.post(f"/workflows/{wf2.id}/preview-schedule")
    assert r.status_code == 200 and r.json()["count"] == 2 and r.json()["items"][0]["label"] == "Greens Api"
    assert client.get(f"/workflows/{wf2.id}/recent-events").json() == []


def test_catalog_serves_hr_custom_fields_from_the_db(client, db):
    # a custom field HR registers is `custom.<key>` on the employee entity on the next catalog call
    db.add(models.EmployeeCustomField(id="cf-api-shirt", field_key="shirt_size_api", label="Shirt Size",
                                      field_type="dropdown", options=["S", "M", "L"], visibility="employee_view"))
    db.add(models.EmployeeCustomField(id="cf-api-cert", field_key="cert_due_api", label="Certification Due",
                                      field_type="date", visibility="hr_only"))
    db.commit()
    as_user(VERA)                                                   # a viewer with no HR grant
    cat = client.get("/workflows/catalog").json()
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    shirt = next(f for f in emp["fields"] if f["key"] == "custom.shirt_size_api")
    assert shirt["type"] == "select" and [o["value"] for o in shirt["options"]] == ["S", "M", "L"]
    assert shirt["visibility"] == "all"
    assert not any(f["key"] == "custom.cert_due_api" for f in emp["fields"])     # HR Only stays with HR
    as_user(EDDIE)                                                  # workflows editor with the HR grant
    cat = client.get("/workflows/catalog").json()
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    cert = next(f for f in emp["fields"] if f["key"] == "custom.cert_due_api")
    assert cert["type"] == "date" and cert["visibility"] == "hr"
    assert {"key": "custom.cert_due_api", "label": "Certification Due", "yearly": False} in emp["dates"]
    # the set-custom-field action offers the field by key
    act = next(a for a in cat["actions"] if a["key"] == "hr.set_custom_field")
    fld = next(p for p in act["params"] if p["type"] in ("select", "entity_ref") and isinstance(p["options"], list)
               and any(o["value"] == "shirt_size_api" for o in p["options"]))
    assert fld


def test_describe_503_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    as_user(EDDIE)
    r = client.post("/workflows/describe", json={"text": "When someone is offboarded, tell their manager"})
    assert r.status_code == 503
