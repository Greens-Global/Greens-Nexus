"""The built-in automation off switch (Oct 28 2026, job_switch.py).

  * off() is False when nothing is set, True after set_off, served from a
    30-second cache that a refresh re-reads, and never raises - a database
    that cannot be reached means every job is ON;
  * a gated tick (reminders.run_daily_scan) returns its empty result before
    it opens a session, so nothing is written;
  * POST /workflows/automations/jobs/{key}/off is Global Admin only, 404s
    an unknown key, writes an automation.off / automation.on AuditLog row,
    and GET /workflows/automations carries `off` on every job.

    cd backend && python -m pytest test_job_switch.py -q
"""
import json
import os
import tempfile

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import job_switch  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import reminders  # noqa: E402
from workflows import automations  # noqa: E402

GAIL, MAX, VERA = "gail.js@greensglobal.com", "max.js@greensglobal.com", "vera.js@greensglobal.com"
ENTITY = "ent-js"


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Switch"))
    for email, first in ((GAIL, "Gail"), (MAX, "Max"), (VERA, "Vera")):
        s.add(models.NexusEmployee(id=f"e-{first.lower()}", work_email=email, first_name=first, last_name="Switch",
                                   company=ENTITY, status="active"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    # Max holds the module at full level: still not enough for the switch.
    s.add(models.NexusGroup(id="g-js-full", name="Workflow Managers", allowed_modules="workflows:full"))
    s.add(models.NexusGroupMember(group_id="g-js-full", email=MAX))
    s.add(models.NexusGroup(id="g-js-view", name="Workflow Viewers", allowed_modules="workflows:viewer"))
    s.add(models.NexusGroupMember(group_id="g-js-view", email=VERA))
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
    s.query(models.NexusSetting).filter(models.NexusSetting.key == job_switch.KEY).delete(synchronize_session=False)
    s.query(models.AuditLog).delete()
    s.commit()
    job_switch.invalidate()
    yield s
    s.rollback()
    s.close()


@pytest.fixture(scope="module")
def client():
    return TestClient(main.app)


def as_user(email: str) -> None:
    os.environ["NEXUS_DEV_EMAIL"] = email
    auth._role_cache.clear()


# ── off() ────────────────────────────────────────────────────────────────────
def test_off_is_false_when_nothing_is_set(db):
    assert job_switch.off("reminders") is False
    assert job_switch.off("") is False
    assert job_switch.off_keys(db) == []


def test_set_off_turns_a_job_off_and_back_on(db):
    assert job_switch.set_off(db, "reminders", True, GAIL) == ["reminders"]
    db.commit()
    assert job_switch.off("reminders") is True
    assert job_switch.off("noshow") is False
    row = db.get(models.NexusSetting, job_switch.KEY)
    assert json.loads(row.value) == ["reminders"] and row.updated_by == GAIL and row.updated_at
    # idempotent, and the list keeps order and uniqueness
    job_switch.set_off(db, "reminders", True, GAIL)
    job_switch.set_off(db, "noshow", True, GAIL)
    db.commit()
    assert job_switch.off_keys(db) == ["reminders", "noshow"]
    job_switch.set_off(db, "reminders", False, GAIL)
    db.commit()
    assert job_switch.off_keys(db) == ["noshow"]
    assert job_switch.off("reminders") is False and job_switch.off("noshow") is True


def test_off_is_cached_and_refreshed(db, monkeypatch):
    job_switch.set_off(db, "scorecard", True, GAIL)
    db.commit()
    assert job_switch.off("scorecard") is True
    # The row changes underneath: the cache still answers until its window ends.
    db.get(models.NexusSetting, job_switch.KEY).value = "[]"
    db.commit()
    assert job_switch.off("scorecard") is True
    monkeypatch.setattr(job_switch.time, "monotonic", lambda: job_switch._cache["at"] + job_switch.CACHE_SEC + 1)
    assert job_switch.off("scorecard") is False


def test_off_never_raises_and_means_on_when_the_database_is_unreachable(db, monkeypatch):
    job_switch.set_off(db, "scorecard", True, GAIL)
    db.commit()
    job_switch.invalidate()

    def boom():
        raise RuntimeError("no database")
    monkeypatch.setattr(database, "SessionLocal", boom)
    assert job_switch.off("scorecard") is False
    # ...and the dead database is not asked again inside the window
    calls = []
    monkeypatch.setattr(database, "SessionLocal", lambda: calls.append(1) or boom())
    assert job_switch.off("scorecard") is False
    assert calls == []
    # A bad row reads as nothing switched off.
    monkeypatch.undo()
    db.get(models.NexusSetting, job_switch.KEY).value = "{not json"
    db.commit()
    job_switch.invalidate()
    assert job_switch.off("scorecard") is False
    assert job_switch.off_keys(db) == []


# ── a gated tick ─────────────────────────────────────────────────────────────
def test_a_gated_tick_returns_early_without_touching_the_database(db, monkeypatch):
    def never():
        raise AssertionError("the tick opened a session while switched off")
    job_switch.set_off(db, "reminders", True, GAIL)
    db.commit()
    monkeypatch.setattr(reminders, "SessionLocal", never)
    assert reminders.run_daily_scan() == 0
    assert db.query(models.NexusNotification).count() == 0
    # on again: the real scan runs (an empty database sends nothing)
    job_switch.set_off(db, "reminders", False, GAIL)
    db.commit()
    monkeypatch.undo()
    assert reminders.run_daily_scan() == 0


def test_every_register_key_is_distinct():
    keys = [j["key"] for j in automations.jobs()]
    assert len(keys) == len(set(keys))
    for k in ("reminders", "task_notify", "ticket_notify", "noshow", "meal_watch", "break_watch", "kb_daily",
              "life_events", "cubby_snapshot", "cma_push", "stortrack_sync", "construction_ai"):
        assert k in keys


# ── the route ────────────────────────────────────────────────────────────────
def test_switch_is_global_admin_only_and_audited(client, db):
    as_user(MAX)
    assert client.post("/workflows/automations/jobs/reminders/off", json={"off": True}).status_code == 403
    as_user(VERA)
    assert client.post("/workflows/automations/jobs/reminders/off", json={"off": True}).status_code == 403
    assert job_switch.off_keys(db) == []
    as_user(GAIL)
    assert client.post("/workflows/automations/jobs/no-such-job/off", json={"off": True}).status_code == 404
    # the runner has the Pause All switch instead; it is never on the list
    assert client.post("/workflows/automations/jobs/workflows/off", json={"off": True}).status_code == 409
    assert next(j for j in automations.jobs() if j["key"] == "workflows")["switch"] is False
    r = client.post("/workflows/automations/jobs/reminders/off", json={"off": True})
    assert r.status_code == 200, r.text
    assert r.json()["key"] == "reminders" and r.json()["off"] is True and r.json()["label"] == "Item Reminders"
    db.expire_all()
    assert job_switch.off_keys(db) == ["reminders"]
    assert job_switch.off("reminders") is True
    # everyone who can see the register sees the state
    as_user(VERA)
    jobs = client.get("/workflows/automations").json()["jobs"]
    assert next(j for j in jobs if j["key"] == "reminders")["off"] is True
    assert next(j for j in jobs if j["key"] == "noshow")["off"] is False
    as_user(GAIL)
    r = client.post("/workflows/automations/jobs/reminders/off", json={"off": False})
    assert r.status_code == 200 and r.json()["off"] is False
    db.expire_all()
    assert job_switch.off_keys(db) == []
    rows = db.query(models.AuditLog).filter(models.AuditLog.action.like("automation.%")).order_by(models.AuditLog.id).all()
    assert [a.action for a in rows] == ["automation.off", "automation.on"]
    assert rows[0].user_email == GAIL and rows[0].module == "workflows" and rows[0].resource_id == "reminders"
    assert json.loads(rows[0].details) == {"label": "Item Reminders"}
