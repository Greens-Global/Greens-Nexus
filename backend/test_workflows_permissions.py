"""Workflows (Oct 28 2026) - the permissions and privacy review of the
module (findings H3, H4, H5, M3, M4, M5, M6, M7, L1, L4; the rest sit in
the engine, emit, context, validate and pack files):

  * an every-company workflow is a Global Admin's alone to edit, publish,
    pause, run or re-own - a one-company full user sees it, no more;
  * re-own never hands a workflow to someone with a higher role or a
    higher Workflows grant than the caller, or outside their companies;
  * a publish or restore by someone other than the owner validates the
    definition against the publisher too (the union of the problems);
  * runs, run details, the Actions view and the overview stay behind the
    company wall - the RECORD's company, not only the workflow's;
  * an archived workflow is neither published nor restored (409);
  * Preview A Schedule needs edit rights and shows only what the caller
    may see; a manual run needs edit rights;
  * Settings for a company's full-level user carry no organization-only
    keys (webhook hosts, which hosts hold a secret, the Nexus switch);
  * an external identity is never a recipient; a recipient outside the
    record's company is dropped whatever the entity's own rule says;
  * recent events for a Test are only the records the caller may see.

    cd backend && python -m pytest test_workflows_permissions.py -q
"""
import os
import tempfile

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
from workflows import catalog, engine, recipients, store, validate  # noqa: E402
from workflows.context import RunContext  # noqa: E402

ENTITY, OTHER = "ent-perm", "ent-perm-other"
GAIL = "gail.perm@greensglobal.com"       # Global Admin (owner role)
FULL = "fay.perm@greensglobal.com"        # Workflows full, manager role, ENTITY - manages Eddie and Vera
FULL2 = "fern.perm@greensglobal.com"      # Workflows full, manager role, OTHER
EDDIE = "eddie.perm@greensglobal.com"     # Workflows editor + hr:viewer, supervisor, ENTITY
EDNA = "edna.perm@greensglobal.com"       # another editor in ENTITY (not an owner of anything)
VERA = "vera.perm@greensglobal.com"       # Workflows viewer, ENTITY
MAX = "max.perm@greensglobal.com"         # manager role, no grant, ENTITY
HANA = "hana.perm@greensglobal.com"       # HR contact of ENTITY
TOP = "tess.perm@greensglobal.com"        # an employee holding the Workflows OWNER grant (rank 4)
EXT = "ext.perm@partner.example"          # an external identity in ENTITY
ZED = "zed.perm@greensglobal.com"         # Workflows editor, OTHER


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    # a record kind only Gail may see, for the recent-events filter (H6)
    catalog.entity("test_perm_secret", label="Secret Record", model=models.NexusEmployee, module="core",
                   company=lambda row: row.company, people={"self": lambda db, row: [row.work_email]},
                   fields=[catalog.F("name", "Name", "text", path="__label__")],
                   label_of=lambda row: f"{row.first_name} {row.last_name}",
                   visible_to=lambda db, user, row: (user or {}).get("email") == GAIL)
    catalog.event("test_perm_secret.changed", entity="test_perm_secret", label="Secret Record Changes",
                  module="core", group="Test", sample={"name": "Vera Perm"})
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Perm", hr_contact_email=HANA))
    s.add(models.HrEntity(id=OTHER, name="Other Perm"))
    people = [(GAIL, "Gail", ENTITY, ""), (FULL, "Fay", ENTITY, ""), (FULL2, "Fern", OTHER, ""),
              (EDDIE, "Eddie", ENTITY, FULL), (EDNA, "Edna", ENTITY, MAX), (VERA, "Vera", ENTITY, FULL),
              (MAX, "Max", ENTITY, ""), (HANA, "Hana", ENTITY, ""), (TOP, "Tess", ENTITY, MAX),
              (EXT, "Ext", ENTITY, MAX), (ZED, "Zed", OTHER, "")]
    for email, first, company, mgr in people:
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Perm",
                                   company=company, status="active", manager_email=mgr, start_date="2026-11-12",
                                   department="Operations",
                                   identity_type="external" if email == EXT else "internal"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusRole(email=FULL, role="manager"))
    s.add(models.NexusRole(email=FULL2, role="manager"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusRole(email=EDDIE, role="supervisor"))
    s.add(models.NexusGroup(id="g-perm-full", name="Workflow Managers", allowed_modules="workflows:full"))
    s.add(models.NexusGroupMember(group_id="g-perm-full", email=FULL))
    s.add(models.NexusGroupMember(group_id="g-perm-full", email=FULL2))
    s.add(models.NexusGroup(id="g-perm-ed", name="Workflow Editors", allowed_modules="workflows:editor,hr:viewer"))
    s.add(models.NexusGroupMember(group_id="g-perm-ed", email=EDDIE))
    s.add(models.NexusGroupMember(group_id="g-perm-ed", email=EDNA))
    s.add(models.NexusGroupMember(group_id="g-perm-ed", email=ZED))
    s.add(models.NexusGroup(id="g-perm-vw", name="Workflow Viewers", allowed_modules="workflows:viewer"))
    s.add(models.NexusGroupMember(group_id="g-perm-vw", email=VERA))
    s.add(models.NexusGroup(id="g-perm-top", name="Workflow Owners", allowed_modules="workflows:owner"))
    s.add(models.NexusGroupMember(group_id="g-perm-top", email=TOP))
    s.add(models.NexusSetting(key="company_walls", value="on"))
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


def _user(db, email: str) -> dict:
    from task_automation import _person_user
    return _person_user(db, email)


NOTIFY = {"id": "n1", "kind": "action", "action": "notify",
          "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} is now {{ change.status.to }}"}}
DEFINITION = {"v": 1, "trigger": {"kind": "event", "event": "employee.status_changed", "filters": []},
              "conditions": [], "steps": [NOTIFY], "settings": dict(validate.DEFAULT_SETTINGS)}
MANUAL = {**DEFINITION, "trigger": {"kind": "manual", "entity": "employee"},
          "steps": [{"id": "n1", "kind": "action", "action": "notify",
                     "params": {"to": [{"kind": "manager"}], "title": "Checked {{ subject.name }}"}}]}
SCHEDULE = {**DEFINITION, "trigger": {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company",
                                      "entity": "employee"},
            "steps": [{"id": "n1", "kind": "action", "action": "notify",
                       "params": {"to": [{"kind": "global_admins"}], "title": "Tick"}}]}
OPEN = {**DEFINITION, "trigger": {"kind": "event", "event": "ticket.filed", "filters": []},
        "steps": [{"id": "n1", "kind": "action", "action": "notify",
                   "params": {"to": [{"kind": "requester"}], "title": "Filed {{ subject.title }}"}}]}


def _published(db, *, owner=EDDIE, company=ENTITY, name="Status Watch", definition=None, run_as="owner"):
    wf = store.create(db, name=name, owner=owner, company_id=company, definition=definition or DEFINITION, by=owner,
                      run_as=run_as)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    store.publish(db, wf, owner)
    db.commit()
    return wf


def _event(db, who="e-vera", key="employee.status_changed"):
    row = db.get(models.NexusEmployee, who)
    workflows.emit(db, key, subject=row, actor=HANA, changes={"status": ("active", "offboarded")})
    db.commit()
    return db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at.desc()).first()


# ── H4: every-company workflows are a Global Admin's alone ───────────────────
def test_every_company_workflow_is_only_a_global_admins_to_change(client, db):
    wf = _published(db, owner=GAIL, company="", name="Everyone", definition=MANUAL)
    fay, gail = _user(db, FULL), _user(db, GAIL)
    assert store.can_see(db, fay, wf) and not store.can_edit(db, fay, wf)
    assert store.can_edit(db, gail, wf)
    as_user(FULL)
    assert client.get(f"/workflows/{wf.id}").status_code == 200
    assert client.put(f"/workflows/{wf.id}/draft", json={"definition": MANUAL}).status_code == 403
    assert client.post(f"/workflows/{wf.id}/publish", json={}).status_code == 403
    assert client.post(f"/workflows/{wf.id}/status", json={"status": "paused"}).status_code == 403
    assert client.post(f"/workflows/{wf.id}/reown", json={"owner": FULL}).status_code == 403
    assert client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"}).status_code == 403
    assert client.post(f"/workflows/{wf.id}/versions/1/restore").status_code == 403
    db.refresh(wf)
    assert wf.owner_email == GAIL and wf.status == "active"
    as_user(GAIL)
    assert client.put(f"/workflows/{wf.id}/draft", json={"definition": MANUAL}).status_code == 200


# ── H3: re-own ───────────────────────────────────────────────────────────────
def test_reown_never_hands_more_access_than_the_caller_has(client, db):
    wf = _published(db)
    as_user(FULL)                                                     # manager (3), Workflows full (3)
    r = client.post(f"/workflows/{wf.id}/reown", json={"owner": GAIL})
    assert r.status_code == 403 and "higher role" in r.json()["detail"]
    r = client.post(f"/workflows/{wf.id}/reown", json={"owner": TOP})
    assert r.status_code == 403 and "higher Workflows grant" in r.json()["detail"]
    r = client.post(f"/workflows/{wf.id}/reown", json={"owner": FULL2})
    assert r.status_code == 403 and "outside your companies" in r.json()["detail"]
    r = client.post(f"/workflows/{wf.id}/reown", json={"owner": EXT})
    assert r.status_code == 422
    db.refresh(wf)
    assert wf.owner_email == EDDIE
    r = client.post(f"/workflows/{wf.id}/reown", json={"owner": MAX})     # same level, no grant: allowed
    assert r.status_code == 200 and r.json()["ownerEmail"] == MAX
    assert r.json()["status"] == "needs_attention"                         # Max cannot run an HR workflow
    as_user(GAIL)
    assert client.post(f"/workflows/{wf.id}/reown", json={"owner": TOP}).status_code == 200


# ── M7: a publish by a non-owner is checked against the publisher ────────────
def test_publish_and_restore_by_a_non_owner_validate_against_the_publisher_too(client, db):
    wf = _published(db)                                               # Eddie (hr:viewer) owns an HR workflow
    as_user(FULL)                                                     # Fay: full, no HR grant
    assert client.put(f"/workflows/{wf.id}/draft", json={"definition": DEFINITION, "name": "Status Watch 2"}).status_code == 200
    assert client.post(f"/workflows/{wf.id}/test", json={}).status_code == 200
    r = client.post(f"/workflows/{wf.id}/publish", json={})
    assert r.status_code == 422, r.text
    assert {"path": "trigger.event", "message": "You may not build on Person Status Changes"} in r.json()["detail"]["problems"]
    r = client.post(f"/workflows/{wf.id}/versions/1/restore")
    assert r.status_code == 422
    db.refresh(wf)
    assert wf.version == 1 and isinstance(wf.draft, dict)
    assert store.publisher_problems(db, wf, EDDIE) == []               # the owner: nothing extra
    assert [p.path for p in store.publisher_problems(db, wf, FULL)] == ["trigger.event"]
    as_user(EDDIE)
    assert client.post(f"/workflows/{wf.id}/publish", json={}).status_code == 200
    # a workflow the publisher may build on publishes as before
    wf2 = _published(db, definition=OPEN, name="Open")
    as_user(FULL)
    client.put(f"/workflows/{wf2.id}/draft", json={"definition": OPEN})
    client.post(f"/workflows/{wf2.id}/test", json={})
    assert client.post(f"/workflows/{wf2.id}/publish", json={}).status_code == 200


# ── H5: runs stay behind the company wall ────────────────────────────────────
def test_runs_of_an_every_company_workflow_stay_behind_the_wall(client, db):
    wf = _published(db, owner=GAIL, company="", name="Everyone")
    mine = engine.handle_event(db, _event(db, "e-vera"))[0]
    theirs = engine.handle_event(db, _event(db, "e-zed"))[0]
    assert mine.status == "succeeded" and theirs.status == "succeeded" and theirs.company_id == OTHER
    as_user(VERA)
    assert [r["id"] for r in client.get("/workflows/runs").json()["items"]] == [mine.id]
    assert [r["id"] for r in client.get(f"/workflows/runs?workflow={wf.id}").json()["items"]] == [mine.id]
    assert [a["runId"] for a in client.get("/workflows/runs?kind=actions").json()["items"]] == [mine.id]
    assert client.get(f"/workflows/runs/{mine.id}").status_code == 200
    assert client.get(f"/workflows/runs/{theirs.id}").status_code == 404
    ov = client.get("/workflows/overview").json()
    assert ov["last24h"]["runs"] == 1 and [r["id"] for r in ov["recent"]] == [mine.id]
    as_user(ZED)
    assert [r["id"] for r in client.get("/workflows/runs").json()["items"]] == [theirs.id]
    assert client.get(f"/workflows/runs/{mine.id}").status_code == 404
    as_user(FULL)
    assert client.post(f"/workflows/runs/{theirs.id}/cancel").status_code == 404
    as_user(GAIL)
    assert len(client.get("/workflows/runs").json()["items"]) == 2


# ── M3: archived ─────────────────────────────────────────────────────────────
def test_archived_workflow_is_neither_published_nor_restored(client, db):
    wf = _published(db)
    store.set_status(db, wf, "archived", EDDIE)
    db.commit()
    as_user(EDDIE)
    assert client.post(f"/workflows/{wf.id}/publish", json={}).status_code == 409
    assert client.post(f"/workflows/{wf.id}/versions/1/restore").status_code == 409
    with pytest.raises(store.Archived):
        store.publish(db, wf, EDDIE)
    db.refresh(wf)
    assert wf.status == "archived" and wf.version == 1


# ── M5 / M6: preview and manual runs need edit rights ────────────────────────
def test_preview_schedule_needs_edit_rights_and_shows_only_what_the_caller_sees(client, db):
    wf = _published(db, owner=FULL, definition=SCHEDULE, name="Daily")
    as_user(VERA)
    assert client.post(f"/workflows/{wf.id}/preview-schedule").status_code == 403
    as_user(EDNA)                                                     # an editor who does not own it
    assert client.post(f"/workflows/{wf.id}/preview-schedule").status_code == 403
    as_user(FULL)                                                     # sees herself and her reports
    r = client.post(f"/workflows/{wf.id}/preview-schedule")
    assert r.status_code == 200 and sorted(i["label"] for i in r.json()["items"]) == ["Eddie Perm", "Fay Perm", "Vera Perm"]
    every = _published(db, owner=GAIL, company="", definition=SCHEDULE, name="Every Day")
    assert client.post(f"/workflows/{every.id}/preview-schedule").status_code == 403
    as_user(GAIL)
    assert client.post(f"/workflows/{every.id}/preview-schedule").json()["count"] == 11


def test_manual_run_needs_edit_rights(client, db):
    wf = _published(db, definition=MANUAL, name="By Hand")
    as_user(EDNA)
    assert client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"}).status_code == 403
    as_user(ZED)
    assert client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"}).status_code == 404
    as_user(FULL)
    assert client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"}).status_code == 200
    as_user(EDDIE)
    assert client.post(f"/workflows/{wf.id}/run", json={"subjectId": "e-vera"}).status_code == 200


# ── L1: settings ─────────────────────────────────────────────────────────────
def test_settings_hide_the_organization_only_keys_from_a_company_full_user(client, db):
    as_user(GAIL)
    client.put("/workflows/settings", json={"webhookHosts": ["hooks.example.com"], "nexusRunAs": True,
                                            "webhookSecrets": {"hooks.example.com": "s3cret"}})
    as_user(FULL)
    for path in ("/workflows/settings", f"/workflows/settings?company={ENTITY}"):
        s = client.get(path).json()
        assert "webhookHosts" not in s and "webhookSecretsSet" not in s and "nexusRunAs" not in s
        assert s["enabled"] is True and "maxRecipientsCap" in s
    s = client.put(f"/workflows/settings?company={ENTITY}", json={"enabled": False}).json()
    assert s["enabled"] is False and s["override"] is True and "webhookHosts" not in s
    assert client.put("/workflows/settings", json={"nexusRunAs": False}).status_code == 403
    as_user(GAIL)
    s = client.get("/workflows/settings").json()
    assert s["webhookHosts"] == ["hooks.example.com"] and s["webhookSecretsSet"] == ["hooks.example.com"]
    assert s["nexusRunAs"] is True


# ── L4 / M4: recipients ──────────────────────────────────────────────────────
def test_externals_and_people_outside_the_records_company_are_never_recipients(db):
    company = catalog.ENTITIES["company"]
    ctx = RunContext(db=db, entity=company, subject=db.get(models.HrEntity, ENTITY), run_as=_user(db, GAIL),
                     company_id=ENTITY)
    spec = [{"kind": "person", "value": EXT}, {"kind": "person", "value": ZED}, {"kind": "person", "value": EDDIE}]
    got, dropped = recipients.resolve(ctx, spec, cap=50)
    assert got == [EDDIE] and dropped == 2            # the company entity has no rule of its own: the wall still holds
    got, dropped = recipients.resolve(ctx, [{"kind": "global_admins"}, {"kind": "person", "value": FULL2}], cap=50)
    assert got == [GAIL] and dropped == 1
    # a record with no company is shared: the wall drops nobody
    ctx = RunContext(db=db, entity=None, subject=None, run_as=_user(db, GAIL), company_id="")
    assert recipients.resolve(ctx, [{"kind": "person", "value": ZED}], cap=50) == ([ZED], 0)


# ── H6: recent events for a Test ─────────────────────────────────────────────
def test_recent_events_offer_only_records_the_caller_may_see(client, db):
    definition = {**DEFINITION, "trigger": {"kind": "event", "event": "test_perm_secret.changed", "filters": []},
                  "steps": [{"id": "n1", "kind": "action", "action": "notify",
                             "params": {"to": [{"kind": "self"}], "title": "{{ subject.name }}"}}]}
    wf = _published(db, owner=GAIL, definition=definition, name="Secret Watch")
    _event(db, "e-vera", key="test_perm_secret.changed")
    _event(db, "e-max", key="test_perm_secret.changed")
    as_user(VERA)
    assert client.get(f"/workflows/{wf.id}/recent-events").json() == []
    as_user(GAIL)
    rows = client.get(f"/workflows/{wf.id}/recent-events").json()
    assert sorted(r["subjectLabel"] for r in rows) == ["Max Perm", "Vera Perm"]
