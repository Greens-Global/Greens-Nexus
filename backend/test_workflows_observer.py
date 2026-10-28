"""Workflows (Oct 28 2026) - Task 3: the record observer.

  * an observed field changing on an employee writes one field_changed row
    with the from / to; an unobserved field writes nothing;
  * a new employee writes one created row;
  * the observer never breaks the flush (emit raising is one log line);
  * nothing is observed for a run already at depth 2.

    cd backend && python -m pytest test_workflows_observer.py -q
"""
import importlib
import os
import tempfile

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog  # noqa: E402

observer = importlib.import_module("workflows.observer")
emit_mod = importlib.import_module("workflows.emit")


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
    for m in (models.WorkflowEvent, models.NexusEmployee):
        s.query(m).delete()
    s.commit()
    yield s
    s.rollback()
    s.close()


def _events(db):
    return db.query(models.WorkflowEvent).order_by(models.WorkflowEvent.at).all()


def _priya(db):
    row = models.NexusEmployee(id="e-priya", work_email="priya@greensglobal.com", first_name="Priya",
                               last_name="Shah", department="Ops", phone="1", status="active", company="ent-1")
    db.add(row)
    db.commit()
    return row


def test_create_emits_created(db):
    _priya(db)
    evs = _events(db)
    assert [e.key for e in evs] == ["employee.created"]
    assert evs[0].subject_id == "e-priya" and evs[0].company_id == "ent-1"
    assert evs[0].payload["subject"]["department"] == "Ops"


def test_observed_update_emits_field_changed_with_from_to(db):
    row = _priya(db)
    db.query(models.WorkflowEvent).delete()
    db.commit()
    row.department = "Sales"
    db.commit()
    evs = _events(db)
    assert len(evs) == 1 and evs[0].key == "employee.field_changed"
    assert evs[0].payload["changes"]["department"] == {"from": "Ops", "to": "Sales"}
    assert evs[0].payload["extra"] == {"field": "department"}
    assert evs[0].payload["subject"]["department"] == "Sales"


def test_two_observed_fields_emit_two_rows(db):
    row = _priya(db)
    db.query(models.WorkflowEvent).delete()
    db.commit()
    row.department = "Sales"
    row.status = "inactive"
    db.commit()
    changed = sorted(list(e.payload["changes"])[0] for e in _events(db))
    assert changed == ["department", "status"]


def test_unobserved_field_emits_nothing(db):
    row = _priya(db)
    db.query(models.WorkflowEvent).delete()
    db.commit()
    row.phone = "2"
    db.commit()
    assert _events(db) == []


def test_setting_the_same_value_emits_nothing(db):
    row = _priya(db)
    db.query(models.WorkflowEvent).delete()
    db.commit()
    row.department = "Ops"
    db.commit()
    assert _events(db) == []


def test_observer_never_breaks_the_flush(db, monkeypatch, capsys):
    def _boom(*a, **k):
        raise RuntimeError("outbox down")
    monkeypatch.setattr(observer, "emit", _boom)
    row = _priya(db)
    row.department = "Sales"
    db.commit()
    assert db.get(models.NexusEmployee, "e-priya").department == "Sales"
    assert "observer skipped" in capsys.readouterr().out


def test_nothing_observed_past_depth_two(db):
    tok = emit_mod.CURRENT_RUN.set(("run-9", 2))
    try:
        _priya(db)
    finally:
        emit_mod.CURRENT_RUN.reset(tok)
    assert _events(db) == []


def test_run_caused_change_is_tagged(db):
    row = _priya(db)
    db.query(models.WorkflowEvent).delete()
    db.commit()
    tok = emit_mod.CURRENT_RUN.set(("run-1", 0))
    try:
        row.department = "Sales"
        db.commit()
    finally:
        emit_mod.CURRENT_RUN.reset(tok)
    ev = _events(db)[0]
    assert ev.caused_by_run == "run-1" and ev.depth == 1
