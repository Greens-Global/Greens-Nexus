"""Workflows (Oct 28 2026) - Task 2: emit() and the outbox.

  * one outbox row per emit, in the caller's transaction, with the subject's
    fields, the from / to changes and the company;
  * an emit inside a SAVEPOINT that is rolled back leaves nothing;
  * an unknown key is one log line, never an exception;
  * a high-volume event is written only while a workflow subscribes;
  * an emit under CURRENT_RUN carries the run and its depth, and nothing is
    written past depth 2.

    cd backend && python -m pytest test_workflows_emit.py -q
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
import workflows  # noqa: E402
from workflows import catalog  # noqa: E402

# `workflows.emit` the attribute is the re-exported FUNCTION; the module is
# reached by its dotted path (`from workflows.emit import x` works too).
emit = importlib.import_module("workflows.emit")

ENTITY = "ent-emit"


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    # a throwaway high-volume event for the subscription test
    catalog.entity("punch", label="Punch", model=models.TimePunch, module="time",
                   company=lambda row: "", fields=[catalog.F("kind", "Kind", "text"),
                                                   catalog.F("employee_email", "Person", "person")])
    catalog.event("punch.in", entity="punch", label="Punch In", module="time", group="Time Clock",
                  sample={"kind": "in"}, volume="high")
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.WorkflowEvent, models.NexusEmployee, models.TimePunch, models.NexusSetting):
        s.query(m).delete()
    s.commit()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def employee_row(db):
    row = models.NexusEmployee(id="e-priya", work_email="Priya.Shah@greensglobal.com", first_name="Priya",
                               last_name="Shah", department="Operations", manager_email="Max@greensglobal.com",
                               status="active", company=ENTITY, start_date="2026-11-12",
                               personal={"dob": "1994-03-08"})
    db.add(row)
    db.commit()
    db.query(models.WorkflowEvent).delete()    # the observer's own created event
    db.commit()
    return row


@pytest.fixture
def punch_row(db):
    row = models.TimePunch(id="p-1", employee_email="priya.shah@greensglobal.com", kind="in",
                           at="2026-10-28T15:00:00+00:00")
    db.add(row)
    db.commit()
    db.query(models.WorkflowEvent).delete()
    db.commit()
    return row


def test_emit_writes_one_outbox_row_in_the_same_transaction(db, employee_row):
    workflows.emit(db, "employee.status_changed", subject=employee_row, actor="hr@x",
                   changes={"status": ("active", "offboarded")}, extra={"reason": "Resigned"})
    assert db.query(models.WorkflowEvent).count() == 1     # visible before the commit: same transaction
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.key == "employee.status_changed" and ev.entity == "employee"
    assert ev.payload["changes"]["status"] == {"from": "active", "to": "offboarded"}
    assert ev.company_id == employee_row.company and ev.wanted in (0, 1)
    assert ev.subject_id == "e-priya" and ev.actor == "hr@x" and ev.processed_at == "" and ev.depth == 0
    assert ev.payload["extra"] == {"reason": "Resigned"}
    sub = ev.payload["subject"]
    assert sub["name"] == "Priya Shah" and sub["manager_email"] == "max@greensglobal.com"
    assert sub["start_date"] == "2026-11-12" and sub["birthday"] == "1994-03-08"
    assert ev.payload["subjectLabel"] == "Priya Shah"


def test_emit_accepts_the_subject_id(db, employee_row):
    workflows.emit(db, "employee.status_changed", subject="e-priya")
    db.commit()
    assert db.query(models.WorkflowEvent).one().subject_id == "e-priya"


def test_emit_inside_rolled_back_savepoint_leaves_nothing(db, employee_row):
    class _Boom(Exception):
        pass
    try:
        with db.begin_nested():
            workflows.emit(db, "employee.status_changed", subject=employee_row)
            raise _Boom()
    except _Boom:
        pass
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0


def test_emit_with_unknown_key_logs_and_does_not_raise(db, employee_row, capsys):
    workflows.emit(db, "nope.nope", subject=employee_row)
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
    assert "emit skipped" in capsys.readouterr().out


def test_emit_with_missing_subject_logs_and_does_not_raise(db, capsys):
    workflows.emit(db, "employee.status_changed", subject="no-such-row")
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
    assert "emit skipped" in capsys.readouterr().out


def test_high_volume_event_is_written_only_when_subscribed(db, punch_row, monkeypatch):
    monkeypatch.setattr(emit, "subscribed", lambda k, db=None: False)
    workflows.emit(db, "punch.in", subject=punch_row)
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
    monkeypatch.setattr(emit, "subscribed", lambda k, db=None: True)
    workflows.emit(db, "punch.in", subject=punch_row)
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 1
    assert db.query(models.WorkflowEvent).one().wanted == 1


def test_subscribed_reads_the_setting_through_the_cache(db):
    import json
    db.add(models.NexusSetting(key=emit.SUBSCRIBED_KEY, value=json.dumps(["punch.in"])))
    db.commit()
    emit.refresh_subscribed([])
    assert emit.subscribed("punch.in", db) is False      # cache is fresh: not re-read yet
    emit._sub_cache["at"] = 0.0                           # make it stale
    assert emit.subscribed("punch.in", db) is True
    assert emit.subscribed("employee.created", db) is False


def test_emit_tags_caused_by_run_from_contextvar(db, employee_row):
    tok = emit.CURRENT_RUN.set(("run-1", 0))
    try:
        workflows.emit(db, "employee.status_changed", subject=employee_row)
    finally:
        emit.CURRENT_RUN.reset(tok)
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.caused_by_run == "run-1" and ev.depth == 1


def test_emit_past_depth_two_writes_nothing(db, employee_row):
    tok = emit.CURRENT_RUN.set(("run-2", 2))
    try:
        workflows.emit(db, "employee.status_changed", subject=employee_row)
    finally:
        emit.CURRENT_RUN.reset(tok)
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
