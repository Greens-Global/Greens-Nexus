"""Operations settings (routers/ops_settings.py + ops_cubby_push.py): the
Push to Cubby switch - OFF by default, who may flip it, and the audit row
every flip writes.

Throwaway SQLite. Run alone: python -m pytest test_ops_settings.py
"""
import atexit
import json
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import ops_cubby_push  # noqa: E402
from auth import get_current_user  # noqa: E402
from routers import ops_settings  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    s = database.SessionLocal()
    s.query(models.NexusSetting).filter(models.NexusSetting.key == ops_cubby_push.SETTINGS_KEY).delete()
    s.query(models.AuditLog).filter(models.AuditLog.action == ops_cubby_push.AUDIT_ACTION).delete()
    s.commit()
    s.close()
    monkeypatch.delenv(ops_cubby_push.WRITE_KEY_ENV, raising=False)
    grants = {}
    monkeypatch.setattr(auth, "_module_level", lambda email, mid, db: grants.get((email, mid), 0))
    return grants


def _client(level=4, role="administrator"):
    app = FastAPI()
    app.include_router(ops_settings.router)
    app.dependency_overrides[get_current_user] = lambda: {"email": f"{role}@greensglobal.com", "role": role, "level": level}
    return TestClient(app)


def test_the_switch_starts_off():
    r = _client().get("/facility-ops/settings").json()
    assert r["cubbyPushOn"] is False and r["writeConfigured"] is False and r["history"] == []
    assert r["canEdit"] is True and r["writeKeyEnv"] == "CUBBY_MANAGER_API_KEY"


def test_an_administrator_turns_it_on_and_off_and_each_flip_is_audited():
    c = _client()
    on = c.put("/facility-ops/settings", json={"cubbyPushOn": True}).json()
    assert on["cubbyPushOn"] is True and on["updatedBy"] == "administrator@greensglobal.com" and on["updatedAt"]
    off = c.put("/facility-ops/settings", json={"cubbyPushOn": False}).json()
    assert off["cubbyPushOn"] is False
    assert [(h["from"], h["to"], h["by"]) for h in off["history"]] == [
        (True, False, "administrator@greensglobal.com"), (False, True, "administrator@greensglobal.com")]
    s = database.SessionLocal()
    rows = s.query(models.AuditLog).filter(models.AuditLog.action == ops_cubby_push.AUDIT_ACTION).all()
    assert len(rows) == 2 and all(r.resource_id == "ops_cubby_push" and r.timestamp for r in rows)
    assert {json.dumps(json.loads(r.details), sort_keys=True) for r in rows} == {
        '{"from": false, "to": true}', '{"from": true, "to": false}'}
    assert ops_cubby_push.is_on(s) is False
    s.close()


def test_a_manager_sees_the_switch_but_cannot_flip_it():
    c = _client(3, "manager")
    assert c.get("/facility-ops/settings").json()["canEdit"] is False
    assert c.put("/facility-ops/settings", json={"cubbyPushOn": True}).status_code == 401
    s = database.SessionLocal()
    assert ops_cubby_push.is_on(s) is False
    s.close()


def test_an_operations_full_grant_can_flip_it(clean):
    clean[("ops@greensglobal.com", "operations")] = auth._MODULE_LEVEL_RANK["full"]
    c = _client(2, "ops")
    assert c.get("/facility-ops/settings").json()["canEdit"] is True
    assert c.put("/facility-ops/settings", json={"cubbyPushOn": True}).json()["cubbyPushOn"] is True


def test_an_operations_editor_grant_cannot(clean):
    clean[("ops@greensglobal.com", "operations")] = auth._MODULE_LEVEL_RANK["editor"]
    assert _client(2, "ops").put("/facility-ops/settings", json={"cubbyPushOn": True}).status_code == 401


def test_employees_cannot_even_read_it():
    assert _client(1, "employee").get("/facility-ops/settings").status_code == 401


def test_a_non_boolean_is_refused():
    assert _client().put("/facility-ops/settings", json={"cubbyPushOn": "yes please"}).status_code == 422


def test_a_broken_saved_value_reads_as_off():
    s = database.SessionLocal()
    s.add(models.NexusSetting(key=ops_cubby_push.SETTINGS_KEY, value="{not json"))
    s.commit()
    assert ops_cubby_push.is_on(s) is False
    s.close()


def test_status_says_ready_only_when_on_with_a_key(monkeypatch):
    s = database.SessionLocal()
    ops_cubby_push.save(s, True, {"email": "a@greensglobal.com"})
    assert ops_cubby_push.status(s) == {"pushOn": True, "writeConfigured": False, "pushReady": False}
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "k")
    assert ops_cubby_push.status(s)["pushReady"] is True
    s.close()
