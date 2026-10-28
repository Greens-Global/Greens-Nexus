"""Workflows (Oct 28 2026) - Task 8: Describe It.

  * without ANTHROPIC_API_KEY the draft is refused (the route answers 503);
  * with a key, the model's JSON is parsed, normalized and validated like
    a hand-built definition - problems come back, nothing is published.

    cd backend && python -m pytest test_workflows_describe.py -q
"""
import json
import os
import tempfile

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from workflows import catalog, describe  # noqa: E402

GA = {"email": "gail.desc@greensglobal.com", "role": "owner", "level": 5}


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.NexusEmployee(id="e-gail", work_email=GA["email"], first_name="Gail", status="active"))
    s.commit()
    s.close()
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


def test_describe_503_without_key(db, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert not describe.configured()
    with pytest.raises(describe.NotConfigured):
        describe.draft(db, GA, "When someone leaves, tell their manager")


def test_describe_parses_and_validates(db, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    seen = {}
    answer = {"definition": {
        "v": 1,
        "trigger": {"kind": "event", "event": "employee.status_changed",
                    "filters": [{"field": "status", "op": "changed_to", "value": "offboarded"}]},
        "conditions": [],
        "steps": [{"id": "s1", "kind": "action", "action": "notify",
                   "params": {"to": [{"kind": "manager"}], "title": "{{ subject.name }} has left"}},
                  {"id": "s2", "kind": "action", "action": "notify",
                   "params": {"to": [{"kind": "manager"}], "title": "Pay was {{ subject.pay }}"}}],
        "settings": {}}, "notes": "Assumed the manager is the right person."}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"content": [{"type": "text", "text": "Here you go:\n" + json.dumps(answer)}]}

    class _Client:
        def __init__(self, timeout):
            seen["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, *, headers, json):
            seen.update(url=url, headers=headers, body=json)
            return _Resp()
    monkeypatch.setattr(httpx, "Client", _Client)
    out = describe.draft(db, GA, "When someone is offboarded, tell their manager", company_id="")
    assert seen["url"] == "https://api.anthropic.com/v1/messages" and seen["headers"]["x-api-key"] == "sk-test"
    assert seen["body"]["model"] == "claude-sonnet-5-5" and "employee.status_changed" in seen["body"]["system"]
    assert "ACTIONS" in seen["body"]["system"] and seen["timeout"] == 60
    assert out["notes"] == "Assumed the manager is the right person."
    d = out["definition"]
    assert d["v"] == 1 and d["settings"]["maxRunsPerHour"] == 100 and d["steps"][0]["id"] == "s1"
    assert out["problems"] == [{"path": "steps[1].params.title", "message": "{{ subject.pay }} is not a field here"}]


def test_parse_accepts_a_bare_definition_and_refuses_prose():
    d, notes = describe.parse('{"trigger": {"kind": "manual", "entity": "employee"}, "steps": []}')
    assert d["trigger"]["kind"] == "manual" and notes == ""
    assert describe.parse("I cannot do that.") == (None, "")
    assert describe.parse('{"notes": "x"}') == (None, "")
