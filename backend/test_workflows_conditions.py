"""Workflows (Oct 28 2026) - Task 4: conditions.

One test per operator family with the trace checked: select is_any_of,
changed_to reads the event payload, date within_next_days uses the
context's today, groups OR / rows AND, an unknown field is false (never an
error), plus the text / number / person / people / bool tables.

    cd backend && python -m pytest test_workflows_conditions.py -q
"""
import os
import tempfile
from datetime import date

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog, conditions  # noqa: E402
from workflows.context import RunContext  # noqa: E402

TODAY = date(2026, 10, 28)


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    catalog.entity("thing", label="Thing", model=None, module="core",
                   fields=[catalog.F("title", "Title", "text"), catalog.F("status", "Status", "select"),
                           catalog.F("amount", "Amount", "money"), catalog.F("due", "Due", "date"),
                           catalog.F("owner", "Owner", "person"), catalog.F("people", "People", "people"),
                           catalog.F("urgent", "Urgent", "bool"), catalog.F("pay", "Pay", "number", visibility="comp")])
    global DB
    DB = database.SessionLocal()
    yield
    DB.close()
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


DB = None


def _ctx(subject=None, changes=None, run_as=None):
    sub = {"title": "Replace the Escondido gate", "status": "open", "amount": "1,250.50", "due": "2026-11-05",
           "owner": "Max@greensglobal.com", "people": ["a@x.com", "b@x.com"], "urgent": True, "pay": 10}
    sub.update(subject or {})
    return RunContext(db=DB, entity=catalog.ENTITIES["thing"], subject=None,
                      payload={"subject": sub, "changes": changes or {}, "extra": {}, "actor": ""},
                      run_as=run_as or {"email": "max@greensglobal.com", "level": 3}, today=TODAY)


def _one(field, op, value, **kw):
    ok, trace = conditions.evaluate([[{"field": field, "op": op, "value": value}]], _ctx(**kw))
    assert len(trace) == 1 and trace[0]["ok"] is ok
    return ok, trace[0]


def test_select_is_any_of():
    ok, t = _one("status", "is_any_of", ["Open", "closed"])
    assert ok and t["actual"] == "open" and t["group"] == 0
    assert not _one("status", "is_any_of", "done,closed")[0]
    assert _one("status", "is", "OPEN")[0] and _one("status", "is_not", "closed")[0]


def test_changed_to_reads_payload():
    ch = {"status": {"from": "open", "to": "resolved"}}
    ok, t = _one("status", "changed_to", "Resolved", changes=ch)
    assert ok and t["actual"] == "resolved"
    assert _one("status", "changed_from", "open", changes=ch)[0]
    ok, t = _one("status", "changed", None, changes=ch)
    assert ok and t["actual"] == {"from": "open", "to": "resolved"}
    assert not _one("status", "changed", None)[0]                       # nothing changed
    assert not _one("status", "changed_to", "resolved", changes={"title": {"from": "a", "to": "b"}})[0]


def test_date_within_next_days_uses_today():
    assert _one("due", "within_next_days", 14)[0]                       # 11/05 is 8 days out
    assert not _one("due", "within_next_days", 7)[0]
    assert _one("due", "within_last_days", 30, subject={"due": "2026-10-20"})[0]
    assert not _one("due", "within_last_days", 3, subject={"due": "2026-10-20"})[0]
    assert _one("due", "before", "2026-11-06")[0] and _one("due", "after", "2026-11-04")[0]
    assert _one("due", "is", "2026-11-05T00:00:00")[0]
    assert _one("due", "is_empty", None, subject={"due": ""})[0]
    assert not _one("due", "before", "not a date")[0]


def test_text_number_person_people_bool():
    assert _one("title", "contains", "escondido")[0] and not _one("title", "contains", "")[0]
    assert _one("title", "is_not_empty", None)[0] and _one("title", "is_empty", None, subject={"title": ""})[0]
    assert _one("amount", "gt", 1000)[0] and _one("amount", "lt", "2000")[0] and _one("amount", "is", 1250.5)[0]
    assert not _one("amount", "gt", "lots")[0]
    assert _one("owner", "is", "max@greensglobal.com")[0] and _one("owner", "is_not", "x@y.com")[0]
    assert _one("people", "includes", "B@x.com")[0] and _one("people", "is", ["b@x.com", "a@x.com"])[0]
    assert not _one("people", "includes", "c@x.com")[0]
    assert _one("urgent", "is", "yes")[0] and not _one("urgent", "is", False)[0]


def test_groups_or_rows_and():
    groups = [[{"field": "status", "op": "is", "value": "closed"}, {"field": "urgent", "op": "is", "value": True}],
              [{"field": "amount", "op": "gt", "value": 1000}, {"field": "title", "op": "contains", "value": "gate"}]]
    ok, trace = conditions.evaluate(groups, _ctx())
    assert ok and [t["ok"] for t in trace] == [False, True, True, True]
    assert [t["group"] for t in trace] == [0, 0, 1, 1]
    ok, _ = conditions.evaluate([[{"field": "status", "op": "is", "value": "closed"}],
                                 [{"field": "amount", "op": "lt", "value": 5}]], _ctx())
    assert not ok
    assert conditions.evaluate([], _ctx()) == (True, [])
    assert conditions.evaluate([{"field": "urgent", "op": "is", "value": True}], _ctx())[0]   # a flat list is one group


def test_unknown_field_is_false_not_error():
    ok, t = _one("nope", "is", "x")
    assert not ok and t["actual"] is None
    assert not _one("status", "gt", 3)[0]            # operator not for the type
    assert not _one("status", "", "x")[0]


def test_hidden_field_is_false_and_shows_no_value():
    ok, t = _one("pay", "gt", 1)
    assert not ok and t["actual"] is None
    assert _one("pay", "gt", 1, run_as={"email": "o@x.com", "level": 5})[0]
    assert not _one("pay", "changed_to", 10, changes={"pay": {"from": 5, "to": 10}})[0]
