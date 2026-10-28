"""Workflows (Oct 28 2026) - Task 1: models, RLS lines, NOISE tables and the
catalog registries (workflows/catalog.py).

  * the eight tables exist after create_all and each has its RLS line in
    main.py's Postgres migration list; the outbox and the step log are NOISE
    for the field-level audit;
  * registering an event for an entity nobody registered raises, and so does
    a duplicate key;
  * serialize() hides HR / comp fields from a person without the grant, and
    the shape is the one the builder renders (entities / events / actions /
    listSources / operators / filters / generatedAt);
  * snapshot() is deterministic; the lock file matches it (xfail until the
    packs land in Task 8).

    cd backend && python -m pytest test_workflows_catalog.py -q
"""
import json
import os
import tempfile

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import audit_capture  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog  # noqa: E402

TABLES = ("workflows", "workflow_versions", "workflow_events", "workflow_runs", "workflow_run_steps",
          "workflow_waits", "workflow_approvals", "workflow_subject_marks")
EMP = "erin.wf@greensglobal.com"
HRP = "hana.wf@greensglobal.com"
GA = "gail.wf@greensglobal.com"


@pytest.fixture(scope="module")
def db():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.NexusEmployee(id="e-erin", work_email=EMP, first_name="Erin", status="active"))
    s.add(models.NexusEmployee(id="e-hana", work_email=HRP, first_name="Hana", status="active"))
    s.add(models.NexusGroup(id="g-hr", name="HR", allowed_modules="hr:full"))
    s.add(models.NexusGroupMember(group_id="g-hr", email=HRP))
    s.commit()
    yield s
    s.close()
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def employee_user():
    return {"email": EMP, "role": "employee", "level": 1}


@pytest.fixture
def hr_user():
    cache.module_grants.invalidate()
    auth._role_cache.clear()
    return {"email": HRP, "role": "employee", "level": 1}


def test_tables_exist_after_create_all():
    for t in TABLES:
        assert t in models.Base.metadata.tables


def test_rls_lines_present_in_postgres_migrations():
    src = open("main.py", encoding="utf-8").read()
    for t in TABLES:
        assert f'"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY"' in src, t


def test_noise_tables_include_outbox_and_steps():
    assert {"workflow_events", "workflow_run_steps"} <= audit_capture.NOISE_TABLES


def test_registering_an_event_with_unknown_entity_raises():
    with pytest.raises(ValueError):
        catalog.event("x.y", entity="nope", label="X", module="m", group="g", sample={})(lambda: None)


def test_registering_a_duplicate_key_raises(db):
    with pytest.raises(ValueError):
        catalog.event("employee.created", entity="employee", label="Again", module="hr", group="People",
                      sample={})(lambda: None)


def test_serialize_hides_hr_fields_from_a_non_hr_user(db, employee_user):
    cat = catalog.serialize(db, employee_user)
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    assert all(f["visibility"] == "all" for f in emp["fields"])


def test_serialize_shows_hr_fields_to_the_hr_grant(db, hr_user):
    cat = catalog.serialize(db, hr_user)
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    assert any(f["visibility"] == "hr" for f in emp["fields"])
    assert not any(f["visibility"] == "comp" for f in emp["fields"])


def test_hr_events_need_the_hr_grant(db, employee_user, hr_user):
    assert not any(e["module"] == "hr" for e in catalog.serialize(db, employee_user)["events"])
    assert any(e["key"] == "employee.field_changed" for e in catalog.serialize(db, hr_user)["events"])


def test_serialize_shape_is_the_builder_contract(db, hr_user):
    cat = catalog.serialize(db, hr_user)
    assert set(cat) == {"entities", "events", "actions", "listSources", "operators", "filters", "generatedAt"}
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    assert set(emp) == {"key", "label", "module", "fields", "dates", "people"}
    assert all({"key", "label", "type", "visibility"} <= set(f) for f in emp["fields"])
    dept = next(f for f in emp["fields"] if f["key"] == "department")
    # a string options name is served as the registered source's list
    # (Task 6, option sources); the snapshot keeps the name
    assert dept["type"] == "select" and isinstance(dept["options"], list)
    snap_dept = next(f for e in catalog.snapshot()["entities"] if e["key"] == "employee"
                     for f in e["fields"] if f["key"] == "department")
    assert snap_dept["options"] == "departments"
    assert all(set(d) == {"key", "label", "yearly"} for d in emp["dates"])
    assert any(d["key"] == "start_date" and d["yearly"] and d["label"] == "Work Anniversary" for d in emp["dates"])
    assert all(set(p) == {"key", "label"} for p in emp["people"])
    assert {p["key"] for p in emp["people"]} == {"self", "manager", "hr_contact"}
    ev = next(e for e in cat["events"] if e["key"] == "employee.field_changed")
    assert set(ev) == {"key", "entity", "label", "module", "group", "changes", "volume"}
    assert set(cat["operators"]) == {"text", "number", "money", "date", "datetime", "select", "person", "people", "bool"}
    assert {"key": "is_any_of", "label": "is any of"} in cat["operators"]["select"]
    assert {"key": "within_next_days", "label": "within the next N days"} in cat["operators"]["date"]
    assert {"key": "us_date", "label": "US date (MM/DD/YYYY)"} in cat["filters"]
    assert cat["generatedAt"].endswith("+00:00")


def test_serialize_hides_admin_only_actions_from_non_admins(db, employee_user):
    @catalog.action("test.admin_thing", label="Admin Thing", module="core", params=[],
                    plan=lambda ctx, p: "", run=lambda ctx, p: {}, admin_only=True)
    def _x():
        pass
    keys = {a["key"] for a in catalog.serialize(db, employee_user)["actions"]}
    assert "test.admin_thing" not in keys
    keys = {a["key"] for a in catalog.serialize(db, {"email": GA, "role": "owner", "level": 5})["actions"]}
    assert "test.admin_thing" in keys
    act = next(a for a in catalog.serialize(db, {"email": GA, "role": "owner", "level": 5})["actions"]
               if a["key"] == "test.admin_thing")
    assert set(act) == {"key", "label", "module", "params", "needsPerson", "adminOnly"}


def test_action_param_shape(db):
    @catalog.action("test.param_shape", label="Param Shape", module="core",
                    params=[catalog.P("title", "Title", "template", max=120, hint="Short"),
                            catalog.P("mode", "Mode", "select", required=False, options=["any", "all"], default="any")],
                    plan=lambda ctx, p: "", run=lambda ctx, p: {})
    def _x():
        pass
    act = next(a for a in catalog.serialize(db, {"email": GA, "role": "owner", "level": 5})["actions"]
               if a["key"] == "test.param_shape")
    assert act["params"][0] == {"key": "title", "label": "Title", "type": "template", "required": True,
                                "max": 120, "options": None, "default": None, "hint": "Short"}
    assert act["params"][1]["options"] == [{"value": "any", "label": "any"}, {"value": "all", "label": "all"}]


def test_snapshot_is_deterministic(db):
    a, b = catalog.snapshot(), catalog.snapshot()
    assert a == b
    json.dumps(a)   # no callables, no dates
    assert "generatedAt" not in a


@pytest.mark.xfail(strict=False, reason="packs land in Task 8")
def test_lock_matches_committed_snapshot(db):
    assert catalog.lock_matches("workflows/catalog.lock.json"), (
        "run: python -c 'import workflows.catalog as c; c.load_packs(); c.write_lock(\"workflows/catalog.lock.json\")'")
