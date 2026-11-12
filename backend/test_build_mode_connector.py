"""The Nexus connector for Claude reaches Build Mode pins only (Neil,
11/12/2026): off until the server says so, a Build Token or nothing, the
token owner's own pins, and no tool that touches anything else."""
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
from routers import build_mode_connector as C  # noqa: E402
from routers import dev_notes as D  # noqa: E402
from routers import files as F  # noqa: E402

DEV = {"email": "dev@greensglobal.com", "role": "employee", "level": 1}
OTHER = {"email": "other@greensglobal.com", "role": "employee", "level": 1}
CURRENT = {"user": DEV}
GRANTS = {DEV["email"]: {"build-mode": 1}, OTHER["email"]: {"build-mode": 1}}

_app = FastAPI()
_app.include_router(D.router)
_app.include_router(C.router)
_app.dependency_overrides[auth.get_current_user] = lambda: CURRENT["user"]
_app.dependency_overrides[D._signed_in_user] = lambda: None if CURRENT.get("token") else CURRENT["user"]
client = TestClient(_app)
URL = "/build-connector/mcp"


@pytest.fixture(scope="module", autouse=True)
def _patched():
    models.Base.metadata.create_all(bind=database.engine)
    saved = (auth._grants_for, auth.is_global_admin, F.fetchable_url, D.CLAUDE_SEND_ON)
    auth._grants_for = lambda email, db: GRANTS.get(email.lower(), {})
    auth.is_global_admin = lambda user, db: False
    F.fetchable_url = lambda u: "signed:" + u
    D.CLAUDE_SEND_ON = True
    yield
    auth._grants_for, auth.is_global_admin, F.fetchable_url, D.CLAUDE_SEND_ON = saved
    database.engine.dispose()
    os.remove(_tmp.name)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setenv(C.SWITCH_ENV, "true")
    CURRENT.update(user=DEV, token=False)
    db = database.SessionLocal()
    for m in (models.DevNote, models.DevNoteSession, models.DevNoteToken, models.NexusNotification, models.NexusSetting, models.AuditLog):
        db.query(m).delete()
    db.commit()
    db.close()
    yield


def _token(user=DEV):
    CURRENT.update(user=user, token=False)
    r = client.post("/dev-notes/tokens", json={"label": "Claude"})
    assert r.status_code in (200, 201), r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def _sent_pin(user=DEV, comment="The count is wrong"):
    CURRENT.update(user=user, token=False)
    hdr = _token(user)
    client.get("/dev-notes/cli/whoami", headers=hdr)             # a Claude Code is listening: Send goes somewhere
    n = client.post("/dev-notes", json={"kind": "bug", "comment": comment, "route": "tasks",
                                        "target": {"selector": "#x", "source": {"file": "src/tasks/Home.jsx", "line": 12}}}).json()
    r = client.post("/dev-notes/dispatch", json={})
    assert r.status_code == 200, r.text
    return n, hdr


def _rpc(hdr, method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "method": method}
    if msg_id is not None:
        body["id"] = msg_id
    if params is not None:
        body["params"] = params
    return client.post(URL, json=body, headers=hdr)


def _tool(hdr, name, **args):
    out = _rpc(hdr, "tools/call", {"name": name, "arguments": args}).json()["result"]
    import json
    return out["isError"], (json.loads(out["content"][0]["text"]) if not out["isError"] else out["content"][0]["text"])


def test_off_until_the_server_says_so_and_a_build_token_or_nothing(monkeypatch):
    hdr = _token()
    monkeypatch.delenv(C.SWITCH_ENV, raising=False)
    assert _rpc(hdr, "tools/list").status_code == 404 and client.get(URL).status_code == 404
    monkeypatch.setenv(C.SWITCH_ENV, "TRUE")
    assert _rpc(hdr, "ping").json() == {"jsonrpc": "2.0", "id": 1, "result": {}}
    # no token, a browser session, a made-up or revoked token: nothing
    assert _rpc({}, "tools/list").status_code == 401
    assert _rpc({"Authorization": "Bearer eyJsession"}, "tools/list").status_code == 401
    assert _rpc({"Authorization": "Bearer nxbn_notreal"}, "tools/list").status_code == 401
    GRANTS.pop(DEV["email"])
    try:
        assert _rpc(hdr, "tools/list").status_code == 403      # the grant went away: so did the connector
    finally:
        GRANTS[DEV["email"]] = {"build-mode": 1}
    assert client.get(URL).status_code == 401 and client.get(URL, headers=hdr).status_code == 405


def test_it_speaks_the_protocol_and_offers_build_mode_tools_only():
    hdr = _token()
    init = _rpc(hdr, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and init["capabilities"] == {"tools": {}} and init["serverInfo"]["name"] == "nexus-build-mode"
    assert _rpc(hdr, "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]["protocolVersion"] == C.PROTOCOLS[0]
    assert _rpc(hdr, "notifications/initialized", msg_id=None).status_code == 202       # a notification gets no answer
    tools = _rpc(hdr, "tools/list").json()["result"]["tools"]
    assert [t["name"] for t in tools] == ["my_pins", "get_pin", "claim_pins", "post_progress", "reply", "complete"]
    assert all(t["inputSchema"]["type"] == "object" and t["description"] for t in tools)
    assert _rpc(hdr, "resources/list").json()["error"]["code"] == -32601
    assert _rpc(hdr, "tools/call", {"name": "run_sql", "arguments": {}}).json()["error"]["code"] == -32602
    assert client.post(URL, json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}], headers=hdr).json()["error"]["code"] == -32600


def test_a_pin_is_worked_end_to_end_through_the_tools():
    n, hdr = _sent_pin()
    err, pins = _tool(hdr, "my_pins")
    assert not err and [(p["id"], p["status"]) for p in pins] == [(n["id"], "Sent")]
    err, pin = _tool(hdr, "get_pin", id=n["id"])
    assert not err and pin["comment"] == "The count is wrong" and pin["target"]["source"] == {"file": "src/tasks/Home.jsx", "line": 12}
    assert not _tool(hdr, "claim_pins", ids=[n["id"]])[0]
    assert _tool(hdr, "post_progress", id=n["id"], text="Reading the handler")[1]["status"] == "Building"
    assert _tool(hdr, "reply", id=n["id"], text="Which count - the tab or the header?", needs_input=True)[1]["status"] == "Needs Input"
    CURRENT.update(user=DEV, token=False)
    client.post(f"/dev-notes/{n['id']}/thread", json={"text": "The tab"})
    assert not _tool(hdr, "claim_pins", ids=[n["id"]])[0]
    err, _ = _tool(hdr, "complete", ids=[n["id"]], pr_url="https://github.com/Greens-Global/Greens-Nexus/pull/77", branch="claude/build-x")
    assert not err
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["status"] == "pr_open" and got["prNumber"] == 77
    assert got["progress"] and any(e["text"] == "Which count - the tab or the header?" for e in got["thread"])
    # a refusal is the tool's answer, not a crash: the pin has a PR now
    err, why = _tool(hdr, "claim_pins", ids=[n["id"]])
    assert err and "cannot be claimed" in why


def test_a_token_reaches_only_the_pins_its_owner_sent():
    mine, hdr = _sent_pin(DEV, "Mine")
    theirs, their_hdr = _sent_pin(OTHER, "Theirs")
    assert [p["id"] for p in _tool(hdr, "my_pins")[1]] == [mine["id"]]
    assert [p["id"] for p in _tool(their_hdr, "my_pins")[1]] == [theirs["id"]]
    for name, args in (("get_pin", {"id": theirs["id"]}), ("post_progress", {"id": theirs["id"], "text": "x"}),
                       ("reply", {"id": theirs["id"], "text": "x"}), ("claim_pins", {"ids": [theirs["id"]]}),
                       ("complete", {"ids": [theirs["id"]], "pr_url": "https://github.com/x/y/pull/1", "branch": "b"})):
        err, why = _tool(hdr, name, **args)
        assert err, name
    CURRENT.update(user=OTHER, token=False)
    assert client.get(f"/dev-notes/{theirs['id']}").json()["status"] == "dispatched"        # untouched


def test_the_connector_file_touches_build_mode_and_nothing_else():
    import pathlib
    import re
    src = pathlib.Path(C.__file__).read_text()
    assert set(re.findall(r"^from models import (.+)$", src, re.M)) == {"DevNote"}
    assert "anthropic" not in src.lower().replace("no call to anthropic", "").replace("`anthropic_api_key`", "")
    assert "httpx" not in src and "requests" not in src.replace("pull requests", "")
