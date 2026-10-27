"""Build Mode (routers/dev_notes.py): access, pins, sessions, Build Tokens,
the CLI loop, the merged-PR hook and the verify step. Own throwaway SQLite,
no network (storage signing and uploads are stubbed).

Run on its own: python -m pytest test_dev_notes.py
"""
import io
import json
import os
import tempfile
from datetime import datetime, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ.pop("SUPABASE_SERVICE_KEY", None)

import pytest  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import dev_notes as D  # noqa: E402
from routers import files as F  # noqa: E402

GA = {"email": "ga@greensglobal.com", "role": "owner", "level": 5}
DEV = {"email": "dev@greensglobal.com", "role": "employee", "level": 1}       # build-mode grant
ADMIN = {"email": "admin@greensglobal.com", "role": "administrator", "level": 4}  # no grant: no access

CURRENT = {"user": DEV}
GRANTS = {DEV["email"]: {"build-mode": 1}}
MEDIA = "https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/n1/screenshot-1.png"

_app = FastAPI()
_app.include_router(D.router)


def _fake_user():
    return CURRENT["user"]


def _fake_signed_in(request: Request):
    if request.headers.get("authorization", "").startswith("Bearer nxbn_"):
        return None
    return CURRENT["user"]


_app.dependency_overrides[auth.get_current_user] = _fake_user
_app.dependency_overrides[D._signed_in_user] = _fake_signed_in
client = TestClient(_app)


@pytest.fixture(scope="module", autouse=True)
def _patched_auth():
    models.Base.metadata.create_all(bind=database.engine)
    saved = (auth._grants_for, auth.is_global_admin, F.fetchable_url)
    # Send to Claude Code switched on (D.CLAUDE_SEND_ON, on since Oct 27); the
    # rule for it switched off has its own test.
    saved_send = D.CLAUDE_SEND_ON
    D.CLAUDE_SEND_ON = True
    auth._grants_for = lambda email, db: GRANTS.get(email.lower(), {})
    auth.is_global_admin = lambda user, db: user["email"] == GA["email"]
    F.fetchable_url = lambda u: "signed:" + u
    yield
    D.CLAUDE_SEND_ON = saved_send
    auth._grants_for, auth.is_global_admin, F.fetchable_url = saved
    database.engine.dispose()
    os.remove(_tmp.name)


@pytest.fixture(autouse=True)
def _clean():
    CURRENT["user"] = DEV
    GRANTS[DEV["email"]] = {"build-mode": 1}
    db = database.SessionLocal()
    for m in (models.DevNote, models.DevNoteSession, models.DevNoteToken,
              models.NexusNotification, models.NexusSetting, models.AuditLog, models.QaTestCase):
        db.query(m).delete()
    db.commit()
    db.close()
    yield


def _as(user):
    CURRENT["user"] = user


def _create(**fields):
    body = {"kind": "bug", "priority": "normal", "comment": "Button is misaligned",
            "route": "tasks", "sub": "home", "screenshotUrl": MEDIA}
    body.update(fields)
    r = client.post("/dev-notes", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _dispatch(**body):
    r = client.post("/dev-notes/dispatch", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _token():
    r = client.post("/dev-notes/tokens", json={"label": "MacBook"})
    assert r.status_code == 201, r.text
    return r.json()


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def _bells(type_=None):
    db = database.SessionLocal()
    try:
        q = db.query(models.NexusNotification)
        if type_:
            q = q.filter(models.NexusNotification.type == type_)
        return [{"type": b.type, "recipient": b.recipient, "title": b.title, "ref_id": b.ref_id,
                 "read_by": b.read_by} for b in q.all()]
    finally:
        db.close()


def _to_pr_open(token=None, pr=7, **fields):
    """open -> dispatched -> building -> pr_open, returns the note."""
    token = token or _token()["token"]
    n = _create(**fields)
    if n["status"] == "open":        # Send Instantly already dispatched it otherwise
        _dispatch()
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token))
    assert r.status_code == 200, r.text
    r = client.post("/dev-notes/cli/complete", headers=_hdr(token),
                    json={"noteIds": [n["id"]], "prUrl": f"https://github.com/x/y/pull/{pr}",
                          "prNumber": pr, "branch": "build/tasks-home-1024", "summary": "Aligned the button"})
    assert r.status_code == 200, r.text
    return r.json()["notes"][0]


def _mark_fixed(pr=7, sha="abc123"):
    db = database.SessionLocal()
    try:
        return D.mark_fixed_for_pr(db, pr, sha)
    finally:
        db.close()


# ── access ────────────────────────────────────────────────────────────────────
def test_admin_without_grant_is_not_enabled_and_everything_else_is_403():
    _as(ADMIN)
    r = client.get("/dev-notes/enabled")
    assert r.status_code == 200 and r.json() == {"enabled": False}
    for call in (lambda: client.get("/dev-notes"), lambda: client.get("/dev-notes/pins"),
                 lambda: client.post("/dev-notes", json={"comment": "x"}),
                 lambda: client.get("/dev-notes/settings"), lambda: client.post("/dev-notes/tokens", json={})):
        r = call()
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Build Mode is not enabled for you"


def test_grant_holder_and_global_admin_are_enabled():
    r = client.get("/dev-notes/enabled")
    assert r.json()["enabled"] is True
    assert r.json()["settings"] == {"sendInstantly": False, "dispatchTarget": "local", "pinsOnLoad": True,
                                    "teamsChatId": "", "teamsChatName": ""}
    _as(GA)
    assert client.get("/dev-notes/enabled").json()["enabled"] is True
    assert client.get("/dev-notes").status_code == 200


# ── pins and sessions ─────────────────────────────────────────────────────────
def test_create_joins_one_collecting_session_and_numbers_pins():
    a = _create()
    b = _create(comment="Second", kind="change", priority="nice")
    assert (a["number"], b["number"]) == (1, 2)
    assert a["sessionId"] == b["sessionId"] and a["status"] == "open"
    assert a["createdBy"] == DEV["email"] and a["screenshotUrl"] == MEDIA
    assert a["thread"] == [] and a["viewport"] == {} and a["prNumber"] == 0
    sessions = client.get("/dev-notes/sessions").json()
    assert len(sessions) == 1
    s = sessions[0]
    assert s["status"] == "collecting" and s["noteCount"] == 2 and s["createdBy"] == DEV["email"]
    assert s["title"].startswith("Build Session ") and "/" in s["title"]
    # snake_case input is accepted too
    c = _create(page_shot_url=MEDIA, build_id="b1")
    assert c["pageShotUrl"] == MEDIA and c["buildId"] == "b1" and c["number"] == 3


def test_send_instantly_dispatches_at_once():
    r = client.put("/dev-notes/settings", json={"sendInstantly": True})
    assert r.status_code == 200 and r.json()["sendInstantly"] is True
    n = _create()
    assert n["status"] == "dispatched" and n["dispatchedAt"]
    s = client.get("/dev-notes/sessions").json()[0]
    assert s["status"] == "sent" and s["dispatchedAt"]
    # the next pin starts a new collecting session
    m = _create()
    assert m["sessionId"] != n["sessionId"] and m["number"] == 1


def test_send_instantly_is_read_as_off_while_send_to_claude_is_switched_off(monkeypatch):
    # With CLAUDE_SEND_ON off a stored Send Instantly does not dispatch - a pin
    # only saves, and Done posts it to Teams.
    assert client.put("/dev-notes/settings", json={"sendInstantly": True}).status_code == 200
    monkeypatch.setattr(D, "CLAUDE_SEND_ON", False)
    n = _create()
    assert n["status"] == "open" and not n.get("dispatchedAt")
    assert client.put("/dev-notes/settings", json={"pinsOnLoad": True}).json()["sendInstantly"] is False


def test_dispatch_sends_the_collecting_session():
    a = _create()
    b = _create()
    out = _dispatch()
    assert out["session"]["status"] == "sent" and out["session"]["id"] == a["sessionId"]
    assert {n["id"] for n in out["notes"]} == {a["id"], b["id"]}
    assert all(n["status"] == "dispatched" and n["dispatchedAt"] for n in out["notes"])
    # nothing left to send
    assert client.post("/dev-notes/dispatch", json={}).status_code == 400
    # already-dispatched pins cannot be sent again
    r = client.post("/dev-notes/dispatch", json={"noteIds": [a["id"]]})
    assert r.status_code == 409


def test_dispatch_with_title_and_note_ids():
    a = _create()
    _create()
    out = _dispatch(noteIds=[a["id"]], title="Tasks Home polish")
    assert out["session"]["title"] == "Tasks Home polish"
    assert [n["id"] for n in out["notes"]] == [a["id"]]


def test_settings_refuse_github():
    r = client.put("/dev-notes/settings", json={"dispatchTarget": "github"})
    assert r.status_code == 400 and r.json()["detail"] == "GitHub dispatch is not available yet"
    r = client.put("/dev-notes/settings", json={"pinsOnLoad": False})
    assert r.json()["pinsOnLoad"] is False and r.json()["dispatchTarget"] == "local"
    assert client.get("/dev-notes/settings").json()["pinsOnLoad"] is False


def test_blocked_routes_are_announced_and_refused():
    assert client.get("/dev-notes/enabled").json()["blockedRoutes"] == ["pfs", "credvault"]
    for route in ("pfs", "credvault"):
        r = client.post("/dev-notes", json={"comment": "x", "route": route})
        assert r.status_code == 400 and r.json()["detail"] == "Build Mode is off on this screen"
    assert client.get("/dev-notes").json() == []


def test_actions_state_and_network_bodies_are_stored_and_capped():
    actions = [{"t": i, "type": "click", "label": f"b{i}", "selector": "button", "value": "", "view": "tasks", "sub": "home"}
               for i in range(40)]
    net = [{"method": "GET", "path": "/tasks", "status": 200, "ms": 12, "at": "x",
            "requestBody": "", "responseBody": "r" * 5000}]
    n = _create(actions=actions, state={"props": {"count": 3}}, networkLog=net,
                target={"selector": "button", "source": {"file": "src/tasks/Home.jsx", "line": 12, "col": 4}})
    assert len(n["actions"]) == 30 and n["actions"][0]["t"] == 10
    assert n["state"] == {"props": {"count": 3}}
    assert len(n["networkLog"][0]["responseBody"]) == 2048
    assert n["target"]["source"] == {"file": "src/tasks/Home.jsx", "line": 12, "col": 4}


def test_bad_media_url_is_400():
    for bad in ("https://evil.example/x.png",
                "https://test.supabase.co/storage/v1/object/public/item-photos/dev-notes/x.png",
                "https://test.supabase.co/storage/v1/object/public/qa-evidence/other/x.png",
                "https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/../x.png",
                "data:image/png;base64,AAAA"):
        r = client.post("/dev-notes", json={"comment": "x", "screenshotUrl": bad})
        assert r.status_code == 400, bad
    r = client.post("/dev-notes", json={"comment": "x", "attachments": ["https://evil.example/x.png"]})
    assert r.status_code == 400
    r = client.post("/dev-notes", json={"comment": "x", "kind": "nope"})
    assert r.status_code == 400


def test_pins_shows_every_authors_live_pins_on_the_route():
    mine = _create(route="tasks")
    _as(GA)
    theirs = _create(route="tasks", sub="")
    _create(route="people")
    _as(DEV)
    ids = {p["id"] for p in client.get("/dev-notes/pins", params={"route": "tasks", "sub": "home"}).json()}
    assert ids == {mine["id"], theirs["id"]}
    # a dismissed pin leaves the screen and the default list
    r = client.patch(f"/dev-notes/{mine['id']}", json={"status": "dismissed"})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    assert mine["id"] not in {p["id"] for p in client.get("/dev-notes/pins", params={"route": "tasks"}).json()}
    assert mine["id"] not in {p["id"] for p in client.get("/dev-notes").json()}
    assert mine["id"] in {p["id"] for p in client.get("/dev-notes", params={"status": "dismissed"}).json()}
    r = client.patch(f"/dev-notes/{mine['id']}", json={"status": "open"})
    assert r.json()["status"] == "open"


def test_only_the_author_or_a_global_admin_edits_a_pin():
    _as(GA)
    n = _create()
    _as(DEV)
    assert client.patch(f"/dev-notes/{n['id']}", json={"comment": "mine now"}).status_code == 403
    r = client.post(f"/dev-notes/{n['id']}/thread", json={"text": "I see it too"})
    assert r.status_code == 200 and r.json()["thread"][-1]["by"] == DEV["email"]
    _as(GA)
    r = client.patch(f"/dev-notes/{n['id']}", json={"comment": "edited", "priority": "blocking"})
    assert r.json()["comment"] == "edited" and r.json()["priority"] == "blocking"


# ── Build Tokens ──────────────────────────────────────────────────────────────
def test_token_mint_use_and_revoke():
    minted = _token()
    assert minted["token"].startswith("nxbn_") and len(minted["token"]) == 5 + 43
    days = (datetime.fromisoformat(minted["expiresAt"]) - datetime.now(timezone.utc)).days
    assert 29 <= days <= 30
    listed = client.get("/dev-notes/tokens").json()
    assert len(listed) == 1 and "token" not in listed[0] and listed[0]["lastUsedAt"] == ""
    assert listed[0]["label"] == "MacBook"

    r = client.get("/dev-notes/cli/whoami", headers=_hdr(minted["token"]))
    assert r.status_code == 200 and r.json() == {"email": DEV["email"], "tokenLabel": "MacBook"}
    assert client.get("/dev-notes/tokens").json()[0]["lastUsedAt"] != ""

    assert client.get("/dev-notes/cli/whoami", headers=_hdr("nxbn_garbage")).status_code == 401

    # the owner lost access: the token stops working at once
    GRANTS[DEV["email"]] = {}
    assert client.get("/dev-notes/cli/whoami", headers=_hdr(minted["token"])).status_code == 403
    GRANTS[DEV["email"]] = {"build-mode": 1}

    r = client.delete(f"/dev-notes/tokens/{minted['id']}")
    assert r.status_code == 204
    assert client.get("/dev-notes/tokens").json()[0]["revokedAt"] != ""
    assert client.get("/dev-notes/cli/whoami", headers=_hdr(minted["token"])).status_code == 401

    # a signed-in user also passes the CLI gate, with no token label
    assert client.get("/dev-notes/cli/whoami").json() == {"email": DEV["email"], "tokenLabel": ""}


def test_token_reads_the_list_and_one_pin():
    token = _token()["token"]
    n = _create()
    _as(ADMIN)   # the browser session is somebody without access; the Bearer token decides
    r = client.get("/dev-notes", headers=_hdr(token))
    assert r.status_code == 200 and [x["id"] for x in r.json()] == [n["id"]]
    assert client.get(f"/dev-notes/{n['id']}", headers=_hdr(token)).json()["id"] == n["id"]
    assert client.get("/dev-notes/pins", headers=_hdr(token)).status_code == 403   # user routes stay user-only


def test_a_global_admin_sees_every_token_but_others_see_their_own():
    _token()
    _as(GA)
    _token()
    assert len(client.get("/dev-notes/tokens").json()) == 2
    _as(DEV)
    assert len(client.get("/dev-notes/tokens").json()) == 1


# ── the CLI loop ──────────────────────────────────────────────────────────────
def test_wait_claim_progress_reply_thread_complete():
    token = _token()["token"]
    h = _hdr(token)
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json() == {"notes": [], "sessions": []}

    n = _create(attachments=[MEDIA.replace("screenshot-1", "paste-2"), MEDIA.replace("screenshot-1", "after-3")])
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()["notes"] == []  # still open
    _dispatch()
    w = client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()
    assert [x["id"] for x in w["notes"]] == [n["id"]]
    assert w["sessions"][0]["id"] == n["sessionId"] and w["sessions"][0]["status"] == "sent"

    # claim: building, signed media, session building
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    c = r.json()["notes"][0]
    assert c["status"] == "building" and c["progress"] == "Picked up by Claude Code"
    assert r.json()["sessions"][0]["id"] == n["sessionId"] and r.json()["sessions"][0]["status"] == "building"
    assert r.json()["sessions"][0]["title"].startswith("Build Session ")
    assert "actions" in c and "state" in c and "verification" in c and c["purgeAt"] == ""
    assert set(c["media"]) == {"screenshot", "pageShot", "video", "contactSheet", "attachments", "beforeShots", "afterShots"}
    assert r.json()["skipped"] == []
    assert c["media"]["screenshot"] == "signed:" + MEDIA and c["media"]["video"] == ""
    assert c["media"]["attachments"] == ["signed:" + MEDIA.replace("screenshot-1", "paste-2")]
    assert c["media"]["afterShots"] == ["signed:" + MEDIA.replace("screenshot-1", "after-3")]
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "building"
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()["notes"] == []

    # progress
    r = client.post(f"/dev-notes/cli/progress/{n['id']}", json={"text": "Found the  button\nin TasksHome"}, headers=h)
    assert r.json()["progress"] == "Found the button in TasksHome" and r.json()["progressAt"]
    assert r.json()["thread"][-1]["kind"] == "progress" and r.json()["thread"][-1]["by"] == "claude"

    # needs input -> bell to the author, once
    for _ in range(2):
        r = client.post(f"/dev-notes/cli/reply/{n['id']}", json={"text": "Which button?", "needsInput": True}, headers=h)
        assert r.status_code == 200 and r.json()["status"] == "needs_input"
    bells = _bells("dev_note_reply")
    assert len(bells) == 1 and bells[0]["recipient"] == DEV["email"] and bells[0]["ref_id"] == n["id"]
    assert bells[0]["title"] == "Claude Replied On Pin #1"
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()["notes"] == []

    # the author answers: building again, and the watcher sees it
    r = client.post(f"/dev-notes/{n['id']}/thread", json={"text": "The Mark All Read one"})
    assert r.json()["status"] == "building" and r.json()["thread"][-1]["kind"] == "comment"
    w = client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()
    assert [x["id"] for x in w["notes"]] == [n["id"]]
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=h)
    assert r.status_code == 200 and r.json()["notes"][0]["status"] == "building"
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=h).json()["notes"] == []

    # complete -> pr_open on pin and session, PR fields, system entry, bell
    r = client.post("/dev-notes/cli/complete", headers=h,
                    json={"noteIds": [n["id"]], "prUrl": "https://github.com/x/y/pull/7", "prNumber": 7,
                          "branch": "build/tasks-home-1024", "summary": "Aligned the button"})
    assert r.status_code == 200, r.text
    p = r.json()["notes"][0]
    assert p["status"] == "pr_open" and p["prNumber"] == 7 and p["prUrl"].endswith("/pull/7")
    assert p["branch"] == "build/tasks-home-1024"
    assert p["thread"][-1]["kind"] == "system" and p["thread"][-1]["text"].startswith("PR #7 Open")
    s = r.json()["session"]
    assert s["status"] == "pr_open" and s["prNumber"] == 7 and s["branch"] == "build/tasks-home-1024"
    bells = _bells("dev_note_pr")
    assert len(bells) == 1 and bells[0]["recipient"] == DEV["email"] and bells[0]["ref_id"] == s["id"]
    assert bells[0]["title"].startswith("PR #7 Open For Build Session '")


def test_cli_wait_polls_then_returns_empty():
    token = _token()["token"]
    started = datetime.now(timezone.utc)
    r = client.get("/dev-notes/cli/wait", params={"timeout": 1}, headers=_hdr(token))
    assert r.status_code == 200 and r.json() == {"notes": [], "sessions": []}
    assert (datetime.now(timezone.utc) - started).total_seconds() >= 0.9
    assert client.get("/dev-notes/cli/wait", params={"timeout": 99}, headers=_hdr(token)).status_code == 422


def test_question_answered_is_done_without_a_pr():
    token = _token()["token"]
    n = _create(kind="question", comment="Why is this here?")
    _dispatch()
    client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token))
    r = client.post(f"/dev-notes/cli/reply/{n['id']}", json={"text": "It anchors the list", "answered": True},
                    headers=_hdr(token))
    assert r.json()["status"] == "done" and r.json()["thread"][-1]["kind"] == "claude"
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "done"


def test_attach_uploads_and_records_the_after_shot(monkeypatch):
    token = _token()["token"]
    seen = {}

    def fake_upload(note_id, kind, data, content_type):
        seen.update(note_id=note_id, kind=kind, size=len(data), ct=content_type)
        return f"https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/{note_id}/{kind}-1.png"

    monkeypatch.setattr(D, "_upload_bytes", fake_upload)
    n = _create()
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
    r = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                    files={"file": ("after.png", io.BytesIO(png), "image/png")}, data={"kind": "after"})
    assert r.status_code == 200, r.text
    assert seen == {"note_id": n["id"], "kind": "after", "size": len(png), "ct": "image/png"}
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["attachments"] == [r.json()["url"]]
    assert got["thread"][-1] == {**got["thread"][-1], "by": "claude", "kind": "claude", "text": "After:",
                                 "imageUrl": r.json()["url"]}
    assert "image_url" not in got["thread"][-1]
    # not an image, wrong kind, too big
    r = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                    files={"file": ("x.txt", io.BytesIO(b"hello"), "text/plain")}, data={"kind": "paste"})
    assert r.status_code == 400
    r = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                    files={"file": ("a.png", io.BytesIO(png), "image/png")}, data={"kind": "sideways"})
    assert r.status_code == 400
    r = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                    files={"file": ("a.png", io.BytesIO(png + b"0" * D.ATTACH_MAX_BYTES), "image/png")},
                    data={"kind": "paste"})
    assert r.status_code == 413


def test_cli_verify_records_and_summarizes():
    token = _token()["token"]
    n = _create()
    _dispatch()
    client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token))
    r = client.post(f"/dev-notes/cli/verify/{n['id']}", headers=_hdr(token), json={
        "repro": {"script": "await page.click('button')", "before": "failing", "after": "passing"},
        "styleCheck": {"passed": True, "checks": [{"prop": "padding", "expected": "12px", "actual": "12px", "ok": True},
                                                   {"prop": "color", "expected": "#111", "actual": "#111", "ok": True},
                                                   {"prop": "gap", "expected": "8px", "actual": "8px", "ok": True}]},
        "visual": {"beforeUrl": MEDIA.replace("screenshot-1", "before-1"), "afterUrl": MEDIA.replace("screenshot-1", "after-1")},
    })
    assert r.status_code == 200, r.text
    v = r.json()["verification"]
    assert v["repro"]["before"] == "failing" and v["repro"]["after"] == "passing" and v["at"]
    assert v["styleCheck"]["passed"] is True and len(v["styleCheck"]["checks"]) == 3
    assert v["visual"]["afterUrl"].endswith("after-1.png")
    last = r.json()["thread"][-1]
    assert last["kind"] == "system" and last["by"] == "claude"
    assert last["text"] == "Repro: failing -> passing. Style check passed 3/3. Before and after shots attached."
    # it rides along in the claim output
    c = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).json()["notes"][0]
    assert c["verification"]["repro"]["after"] == "passing"
    # bad input
    r = client.post(f"/dev-notes/cli/verify/{n['id']}", headers=_hdr(token), json={"repro": {"before": "maybe", "after": "passing"}})
    assert r.status_code == 400
    r = client.post(f"/dev-notes/cli/verify/{n['id']}", headers=_hdr(token), json={"visual": {"afterUrl": "https://evil.example/a.png"}})
    assert r.status_code == 400
    assert client.post(f"/dev-notes/cli/verify/{n['id']}", headers=_hdr(token), json={}).status_code == 400


def test_purge_deletes_media_of_closed_pins_after_30_days(monkeypatch):
    deleted = []
    monkeypatch.setattr(D, "_delete_object", lambda u: deleted.append(u) or True)
    n = _create(attachments=[MEDIA.replace("screenshot-1", "paste-2")])
    r = client.patch(f"/dev-notes/{n['id']}", json={"status": "dismissed"})
    purge_at = r.json()["purgeAt"]
    days = (datetime.fromisoformat(purge_at) - datetime.now(timezone.utc)).days
    assert 29 <= days <= 30
    # reopening clears the purge date
    assert client.patch(f"/dev-notes/{n['id']}", json={"status": "open"}).json()["purgeAt"] == ""
    client.patch(f"/dev-notes/{n['id']}", json={"status": "dismissed"})
    live = _create()   # an open pin is never touched

    _as(GA)
    assert client.post("/dev-notes/purge").json() == {"purged": 0}   # not due yet
    db = database.SessionLocal()
    row = db.query(models.DevNote).filter(models.DevNote.id == n["id"]).first()
    row.purge_at = "2020-01-01T00:00:00+00:00"
    db.commit()
    db.close()
    assert client.post("/dev-notes/purge").json() == {"purged": 1}
    assert sorted(deleted) == sorted([MEDIA, MEDIA.replace("screenshot-1", "paste-2")])
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["screenshotUrl"] == "" and got["attachments"] == [] and got["thread"][-1]["text"] == "Media Purged"
    assert client.get(f"/dev-notes/{live['id']}").json()["screenshotUrl"] == MEDIA
    assert client.post("/dev-notes/purge").json() == {"purged": 0}   # nothing left
    # a refused delete keeps the URL for the next run
    monkeypatch.setattr(D, "_delete_object", lambda u: False)
    _as(DEV)
    m = _create()
    client.patch(f"/dev-notes/{m['id']}", json={"status": "dismissed"})
    db = database.SessionLocal()
    db.query(models.DevNote).filter(models.DevNote.id == m["id"]).update({"purge_at": "2020-01-01T00:00:00+00:00"})
    db.commit()
    db.close()
    _as(GA)
    assert client.post("/dev-notes/purge").json() == {"purged": 0}
    assert client.get(f"/dev-notes/{m['id']}").json()["screenshotUrl"] == MEDIA
    _as(DEV)
    assert client.post("/dev-notes/purge").status_code == 403


def test_stats():
    token = _token()["token"]
    assert client.get("/dev-notes/stats").json() == {
        "pins": {"total": 0, "open": 0, "building": 0, "prOpen": 0, "fixed": 0, "done": 0, "dismissed": 0},
        "medianPinToPrHours": None, "reopenRate": None, "firstClaimHitRate": None, "days": 90}
    # one pin all the way through with a "Found" first progress line, accepted
    a = _to_pr_open(token, pr=1)
    _mark_fixed(pr=1)
    client.post(f"/dev-notes/{a['id']}/verify", json={"accepted": True})
    # one with "Found" that was reopened; one open; one dismissed
    b = _create()
    _dispatch()
    client.post("/dev-notes/cli/claim", json={"noteIds": [b["id"]]}, headers=_hdr(token))
    client.post(f"/dev-notes/cli/progress/{b['id']}", json={"text": "Found frontend/src/tasks/Home.jsx"}, headers=_hdr(token))
    client.post("/dev-notes/cli/complete", headers=_hdr(token),
                json={"noteIds": [b["id"]], "prUrl": "https://github.com/x/y/pull/2", "prNumber": 2, "branch": "b"})
    _mark_fixed(pr=2)
    client.post(f"/dev-notes/{b['id']}/verify", json={"accepted": False})
    _create()
    d = _create()
    client.patch(f"/dev-notes/{d['id']}", json={"status": "dismissed"})
    s = client.get("/dev-notes/stats").json()
    assert s["pins"] == {"total": 4, "open": 2, "building": 0, "prOpen": 0, "fixed": 0, "done": 1, "dismissed": 1}
    assert s["medianPinToPrHours"] is not None and s["medianPinToPrHours"] < 1
    assert s["reopenRate"] == 0.5         # two reached fixed, one reopened
    assert s["firstClaimHitRate"] == 0.0  # a's first line was not "Found ...", b was reopened


def test_audit_rows_are_written():
    token = _token()["token"]
    p = _to_pr_open(token)
    _mark_fixed()
    client.post(f"/dev-notes/{p['id']}/verify", json={"accepted": False})
    r = client.get("/dev-notes/tokens").json()
    client.delete(f"/dev-notes/tokens/{r[0]['id']}")
    db = database.SessionLocal()
    try:
        rows = db.query(models.AuditLog).filter(models.AuditLog.resource_type == "dev-notes").all()
        actions = sorted({a.action for a in rows})
        assert actions == ["dev_note_claim", "dev_note_create", "dev_note_dispatch", "dev_note_reopen",
                           "dev_note_token_mint", "dev_note_token_revoke"]
        assert all(a.user_email == DEV["email"] and a.module == "settings" for a in rows)
        db.query(models.AuditLog).filter(models.AuditLog.resource_type == "dev-notes").delete()
        db.commit()
    finally:
        db.close()


# ── merge, verify ─────────────────────────────────────────────────────────────
def test_merged_pr_marks_pins_fixed_and_rings_the_author():
    p = _to_pr_open(pr=7)
    assert _mark_fixed(pr=99) == 0           # another PR: nothing
    assert _mark_fixed(pr=7, sha="deadbeef") == 1
    assert _mark_fixed(pr=7, sha="deadbeef") == 0   # idempotent
    got = client.get(f"/dev-notes/{p['id']}").json()
    assert got["status"] == "fixed" and got["fixedBuildId"] == "deadbeef" and got["fixedAt"]
    assert got["thread"][-1]["text"] == "Merged To Dev"
    bells = _bells("dev_note_fixed")
    assert len(bells) == 1 and bells[0]["title"] == "Pin #1 Fixed - Verify" and bells[0]["recipient"] == DEV["email"]
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "fixed"
    # a fixed pin still shows on the screen for its author to verify
    assert p["id"] in {x["id"] for x in client.get("/dev-notes/pins", params={"route": "tasks"}).json()}
    # bad input never raises
    assert _mark_fixed(pr="?") == 0


def test_verify_accept_is_done():
    p = _to_pr_open()
    _mark_fixed()
    r = client.post(f"/dev-notes/{p['id']}/verify", json={"accepted": True, "comment": "Looks right"})
    assert r.status_code == 200
    assert r.json()["status"] == "done" and r.json()["verifiedBy"] == DEV["email"] and r.json()["verifiedAt"]
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "done"
    assert p["id"] not in {x["id"] for x in client.get("/dev-notes/pins", params={"route": "tasks"}).json()}


def test_verify_reject_reopens_and_counts():
    p = _to_pr_open()
    _mark_fixed()
    r = client.post(f"/dev-notes/{p['id']}/verify", json={"accepted": False, "comment": "Still off by 2px"})
    assert r.status_code == 200
    got = r.json()
    assert got["status"] == "open" and got["reopenCount"] == 1
    assert got["thread"][-1]["kind"] == "system" and got["thread"][-1]["text"].startswith("Reopened")
    # with Send Instantly on, a reopened pin goes straight back out
    client.put("/dev-notes/settings", json={"sendInstantly": True})
    q = _to_pr_open(pr=8)
    _mark_fixed(pr=8)
    got = client.post(f"/dev-notes/{q['id']}/verify", json={"accepted": False}).json()
    assert got["status"] == "dispatched" and got["reopenCount"] == 1


def test_illegal_transitions_are_409():
    token = _token()["token"]
    n = _create()
    # verify needs fixed
    assert client.post(f"/dev-notes/{n['id']}/verify", json={"accepted": True}).status_code == 409
    # claim and complete need a dispatched / building pin
    assert client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).status_code == 409
    r = client.post("/dev-notes/cli/complete", headers=_hdr(token),
                    json={"noteIds": [n["id"]], "prUrl": "https://github.com/x/y/pull/1", "prNumber": 1, "branch": "b"})
    assert r.status_code == 409
    # reopen-from-dismissed only from dismissed
    assert client.patch(f"/dev-notes/{n['id']}", json={"status": "open"}).status_code == 409
    # any other status word through PATCH is refused
    assert client.patch(f"/dev-notes/{n['id']}", json={"status": "building"}).status_code == 400
    # a done pin cannot be dismissed
    p = _to_pr_open(token)
    _mark_fixed()
    client.post(f"/dev-notes/{p['id']}/verify", json={"accepted": True})
    assert client.patch(f"/dev-notes/{p['id']}", json={"status": "dismissed"}).status_code == 409
    # needs_input needs a pin Claude is working on
    r = client.post(f"/dev-notes/cli/reply/{p['id']}", json={"text": "?", "needsInput": True}, headers=_hdr(token))
    assert r.status_code == 409
    # a missing pin is 404
    assert client.get("/dev-notes/nope").status_code == 404


def test_session_title_from_client_names_only_a_new_session():
    a = _create(sessionTitle="Build Session 10/24/2026 9:15 AM")
    b = _create(sessionTitle="Something Else")      # joins a's session - the title stays
    assert a["sessionId"] == b["sessionId"]
    s = client.get("/dev-notes/sessions").json()[0]
    assert s["title"] == "Build Session 10/24/2026 9:15 AM"


def test_reclaim_does_not_stack_picked_up_entries():
    token = _token()["token"]
    n = _create()
    _dispatch()
    for _ in range(3):
        r = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token))
        assert r.status_code == 200, r.text
    thread = client.get(f"/dev-notes/{n['id']}").json()["thread"]
    picked = [e for e in thread if e["kind"] == "progress" and e["text"] == "Picked up by Claude Code"]
    assert len(picked) == 1
    # an answer in between needs a fresh entry so the pin leaves the wait set again
    client.post(f"/dev-notes/cli/reply/{n['id']}", json={"text": "Which one?", "needsInput": True}, headers=_hdr(token))
    client.post(f"/dev-notes/{n['id']}/thread", json={"text": "The left one."})
    assert any(x["id"] == n["id"] for x in client.get("/dev-notes/cli/wait?timeout=0", headers=_hdr(token)).json()["notes"])
    client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token))
    assert client.get("/dev-notes/cli/wait?timeout=0", headers=_hdr(token)).json()["notes"] == []


def test_client_id_and_bell_actions():
    import json as _json
    import uuid as _uuid
    want = str(_uuid.uuid4())
    n = _create(id=want)
    assert n["id"] == want
    r = client.post("/dev-notes", json={"kind": "bug", "comment": "x", "route": "tasks", "id": want})
    assert r.status_code == 409
    r = client.post("/dev-notes", json={"kind": "bug", "comment": "x", "route": "tasks", "id": "not-a-uuid"})
    assert r.status_code == 400
    # bells carry the action the bell navigates by
    note = _to_pr_open(pr=31)
    pr_bell = _bells("dev_note_pr")[-1]
    db = database.SessionLocal()
    try:
        rows = {b.type: _json.loads(b.action) for b in db.query(models.NexusNotification).all() if b.action}
    finally:
        db.close()
    assert rows["dev_note_pr"] == {"view": "dev-notes", "sub": f"session:{note['sessionId']}"}
    assert pr_bell["ref_id"] == note["sessionId"]
    _mark_fixed(pr=31)
    db = database.SessionLocal()
    try:
        fixed = [b for b in db.query(models.NexusNotification).filter(models.NexusNotification.type == "dev_note_fixed").all()]
    finally:
        db.close()
    assert _json.loads(fixed[-1].action) == {"view": "dev-notes", "sub": f"pin:{note['id']}"}


# ── review fixes (Oct 24 2026) ────────────────────────────────────────────────
def test_routes_live_at_dev_notes_and_the_slash_form_still_works():
    body = {"kind": "bug", "comment": "x", "route": "tasks"}
    assert client.post("/dev-notes", json=body).status_code == 201
    assert len(client.get("/dev-notes").json()) == 1
    r = client.get("/dev-notes/", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].endswith("/dev-notes")
    assert client.post("/dev-notes/", json=body).status_code == 201     # 307 replayed by the client
    assert len(client.get("/dev-notes/").json()) == 2


def test_a_never_dispatched_session_stays_collecting_whatever_its_pins_do():
    n = _create()
    client.patch(f"/dev-notes/{n['id']}", json={"status": "dismissed"})
    s = client.get("/dev-notes/sessions").json()[0]
    assert s["status"] == "collecting" and s["noteCount"] == 1 and s["dispatchedAt"] == ""
    client.patch(f"/dev-notes/{n['id']}", json={"status": "open"})
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "collecting"
    m = _create()                       # joins the same session
    assert m["sessionId"] == n["sessionId"] and m["number"] == 2
    out = _dispatch()                   # the Send button finds it
    assert out["session"]["status"] == "sent" and len(out["notes"]) == 2
    # after dispatch the pins drive it: dismiss both -> done
    for x in (n, m):
        client.patch(f"/dev-notes/{x['id']}", json={"status": "dismissed"})
    assert client.get("/dev-notes/sessions").json()[0]["status"] == "done"


def test_claim_and_complete_are_per_pin():
    token = _token()["token"]
    h = _hdr(token)
    a = _create()
    b = _create()
    _dispatch()
    client.patch(f"/dev-notes/{b['id']}", json={"status": "dismissed"})
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [a["id"], b["id"], "missing"]}, headers=h)
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["notes"]] == [a["id"]]
    assert r.json()["skipped"] == [
        {"id": b["id"], "number": 2, "status": "dismissed", "reason": "Pin #2 is dismissed and cannot be claimed"},
        {"id": "missing", "number": 0, "status": "", "reason": "Pin not found"},
    ]
    assert client.post("/dev-notes/cli/claim", json={"noteIds": [b["id"]]}, headers=h).status_code == 409
    assert client.post("/dev-notes/cli/claim", json={"noteIds": ["missing", "nope"]}, headers=h).status_code == 404
    done = {"prUrl": "https://github.com/x/y/pull/9", "prNumber": 9, "branch": "b"}
    r = client.post("/dev-notes/cli/complete", json={"noteIds": [a["id"], b["id"]], **done}, headers=h)
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["notes"]] == [a["id"]] and r.json()["notes"][0]["status"] == "pr_open"
    assert r.json()["skipped"][0]["id"] == b["id"] and r.json()["skipped"][0]["status"] == "dismissed"
    assert r.json()["session"]["prNumber"] == 9 and r.json()["sessions"][0]["id"] == a["sessionId"]
    assert client.post("/dev-notes/cli/complete", json={"noteIds": [b["id"]], **done}, headers=h).status_code == 409
    assert client.post("/dev-notes/cli/complete", json={"noteIds": ["missing"], **done}, headers=h).status_code == 404


def test_duplicate_collecting_sessions_collapse_to_the_oldest():
    a = _create()
    db = database.SessionLocal()
    try:
        dup = models.DevNoteSession(id="dup-session", title="Dup", status="collecting", created_by=DEV["email"],
                                    created_at="2099-01-01T00:00:00+00:00", updated_at="", note_count=1)
        db.add(dup)
        db.add(models.DevNote(id="stray", session_id="dup-session", number=1, status="open", comment="stray",
                              created_by=DEV["email"], created_at=D._now(), updated_at=D._now(),
                              thread=[], attachments=[], console_log=[], network_log=[], actions=[],
                              viewport={}, target={}, markup={}, edit={}, state={}, verification={}))
        db.commit()
        keep = D._collecting_session(db, DEV["email"])
        db.commit()
        assert keep.id == a["sessionId"]
        assert db.query(models.DevNoteSession).filter(models.DevNoteSession.id == "dup-session").first() is None
        stray = db.query(models.DevNote).filter(models.DevNote.id == "stray").first()
        assert stray.session_id == a["sessionId"] and stray.number == 2
        assert keep.note_count == 2
    finally:
        db.close()
    assert _create()["number"] == 3


def test_purge_clears_purge_at_and_writes_one_entry(monkeypatch):
    n = _create(attachments=[MEDIA.replace("screenshot-1", "paste-2")])
    client.patch(f"/dev-notes/{n['id']}", json={"status": "dismissed"})
    db = database.SessionLocal()
    db.query(models.DevNote).filter(models.DevNote.id == n["id"]).update({"purge_at": "2020-01-01T00:00:00+00:00"})
    db.commit()
    db.close()
    _as(GA)
    # storage refuses everything: no change, no entry, still due
    monkeypatch.setattr(D, "_delete_object", lambda u: False)
    for _ in range(2):
        assert client.post("/dev-notes/purge").json() == {"purged": 0}
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["screenshotUrl"] == MEDIA and got["purgeAt"] != "" and "Media Purged" not in got["thread"][-1]["text"]
    # one of two deleted: one entry, still due; a repeat failing run adds no second entry
    monkeypatch.setattr(D, "_delete_object", lambda u: u == MEDIA)
    assert client.post("/dev-notes/purge").json() == {"purged": 1}
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["screenshotUrl"] == "" and len(got["attachments"]) == 1 and got["purgeAt"] != ""
    assert got["thread"][-1]["text"] == "Media Purged (1 left for the next run)"
    assert client.post("/dev-notes/purge").json() == {"purged": 0}
    assert len([e for e in client.get(f"/dev-notes/{n['id']}").json()["thread"] if e["text"].startswith("Media Purged")]) == 1
    # the rest goes: purge_at blanked, still one entry, never selected again
    monkeypatch.setattr(D, "_delete_object", lambda u: True)
    assert client.post("/dev-notes/purge").json() == {"purged": 1}
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["attachments"] == [] and got["purgeAt"] == ""
    assert len([e for e in got["thread"] if e["text"].startswith("Media Purged")]) == 1
    assert client.post("/dev-notes/purge").json() == {"purged": 0}


def test_oversized_fields_are_413():
    r = client.post("/dev-notes", json={"comment": "x", "state": {"blob": "s" * (64 * 1024 + 1)}})
    assert r.status_code == 413 and r.json()["detail"] == "state is larger than 64 KB"
    r = client.post("/dev-notes", json={"comment": "c" * (20 * 1024 + 1)})
    assert r.status_code == 413 and r.json()["detail"] == "comment is larger than 20 KB"
    r = client.post("/dev-notes", json={"comment": "x", "transcript": "t" * (20 * 1024 + 1)})
    assert r.status_code == 413 and r.json()["detail"] == "transcript is larger than 20 KB"
    n = _create(transcript="t" * (10 * 1024), markup={"items": ["m"] * 1000})
    r = client.patch(f"/dev-notes/{n['id']}", json={"markup": {"blob": "s" * (64 * 1024 + 1)}})
    assert r.status_code == 413 and r.json()["detail"] == "markup is larger than 64 KB"


def test_reclaim_keeps_claudes_progress():
    token = _token()["token"]
    n = _create()
    _dispatch()
    c = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).json()["notes"][0]
    assert c["progress"] == "Picked up by Claude Code" and c["progressAt"]
    client.post(f"/dev-notes/cli/progress/{n['id']}", json={"text": "Found Home.jsx"}, headers=_hdr(token))
    c = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).json()["notes"][0]
    assert c["progress"] == "Found Home.jsx"


def test_signed_media_is_blank_when_storage_cannot_sign():
    token = _token()["token"]
    n = _create()
    _dispatch()
    saved = F.fetchable_url
    F.fetchable_url = lambda u: u          # no service key: fetchable_url hands the input back
    try:
        c = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).json()["notes"][0]
    finally:
        F.fetchable_url = saved
    assert c["media"]["screenshot"] == "" and c["media"]["attachments"] == []


def test_before_shots(monkeypatch):
    token = _token()["token"]
    monkeypatch.setattr(D, "_upload_bytes", lambda note_id, kind, data, ct:
                        f"https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/{note_id}/{kind}-1.png")
    n = _create()
    _dispatch()
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 10
    before = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                         files={"file": ("b.png", io.BytesIO(png), "image/png")}, data={"kind": "before"}).json()["url"]
    after = client.post(f"/dev-notes/cli/attach/{n['id']}", headers=_hdr(token),
                        files={"file": ("a.png", io.BytesIO(png), "image/png")}, data={"kind": "after"}).json()["url"]
    got = client.get(f"/dev-notes/{n['id']}").json()
    assert got["attachments"] == [before, after]
    assert not any(e["imageUrl"] == before for e in got["thread"])        # before: no thread entry
    assert got["thread"][-1]["imageUrl"] == after                          # after: the "After:" entry
    m = client.post("/dev-notes/cli/claim", json={"noteIds": [n["id"]]}, headers=_hdr(token)).json()["notes"][0]["media"]
    assert m["beforeShots"] == ["signed:" + before] and m["afterShots"] == ["signed:" + after] and m["attachments"] == []


# ── v2: ownership (code_owners.py) ────────────────────────────────────────────
VISESH = {"email": "visesh.lodha@greensglobal.com", "role": "employee", "level": 1}
NEIL = {"email": "neil@greensglobal.com", "role": "employee", "level": 1}
DEV2 = {"email": "dev2@greensglobal.com", "role": "employee", "level": 1}
VISESH_FILE = {"selector": "button", "source": {"file": "src/views/InventoryManagement.jsx", "line": 10, "col": 4}}


def _held_pin(**fields):
    return _create(target=VISESH_FILE, route="inventory", **fields)


def _owner_bodies():
    db = database.SessionLocal()
    try:
        return [b.body for b in db.query(models.NexusNotification)
                .filter(models.NexusNotification.type == "dev_note_owner").all()]
    finally:
        db.close()


def test_enabled_and_owners_list_the_ownership_map():
    owners = client.get("/dev-notes/enabled").json()["owners"]
    assert {o["name"] for o in owners} == {"Visesh", "Neil"}
    assert "frontend/src/views/InventoryManagement.jsx" in next(o for o in owners if o["name"] == "Visesh")["paths"]
    token = _token()["token"]
    assert client.get("/dev-notes/owners", headers=_hdr(token)).json()["owners"] == owners
    assert client.get("/dev-notes/owners").status_code == 200


def test_pin_on_another_developers_file_is_held_and_rings_the_owner():
    n = _held_pin(ownerEmail="someone@else.com")      # a client value is ignored
    assert n["held"] is True and n["ownerEmail"] == VISESH["email"] and n["ownerName"] == "Visesh"
    assert n["ownerReleasedBy"] == "" and n["preview"] == {} and n["readyToCheck"] is False
    bells = _bells("dev_note_owner")
    assert len(bells) == 1 and bells[0]["recipient"] == VISESH["email"] and bells[0]["ref_id"] == n["id"]
    assert bells[0]["title"] == "Pin #1 On Your Area"
    body = _owner_bodies()[0]
    assert ("pinned inventory (frontend/src/views/InventoryManagement.jsx). It waits for you - "
            "release it to Claude Code or handle it yourself.") in body
    assert "Ask a Global Admin for the Build Mode grant if the link does not open." in body   # Visesh has no grant
    GRANTS[VISESH["email"]] = {"build-mode": 1}
    try:
        _held_pin()
        bodies = _owner_bodies()
        assert len(bodies) == 2 and sum("Ask a Global Admin" in b for b in bodies) == 1
    finally:
        GRANTS.pop(VISESH["email"], None)
    # no source file: no owner
    m = _create(ownerEmail=VISESH["email"])
    assert m["ownerEmail"] == "" and m["held"] is False


def test_not_held_when_the_author_owns_the_file_and_held_skips_send_instantly():
    GRANTS[NEIL["email"]] = {"build-mode": 1}
    try:
        _as(NEIL)
        n = _create(target={"source": {"file": "src/asset/lib/sync.js"}})
        assert n["ownerEmail"] == NEIL["email"] and n["held"] is False
        assert _bells("dev_note_owner") == []
        client.put("/dev-notes/settings", json={"sendInstantly": True})
        h = _held_pin()
        assert h["held"] is True and h["status"] == "open"          # never sent while held
        assert _create()["status"] == "dispatched"                  # an ordinary pin still is
    finally:
        GRANTS.pop(NEIL["email"], None)


def test_dispatch_skips_held_pins_and_names_them():
    a = _create()
    b = _held_pin()
    out = _dispatch()
    assert [n["id"] for n in out["notes"]] == [a["id"]]
    # the held pin left the sent session for a new collecting one, as its Pin #1
    assert out["held"] == [{"id": b["id"], "number": 1, "ownerName": "Visesh"}]
    got = client.get(f"/dev-notes/{b['id']}").json()
    assert got["status"] == "open" and got["sessionId"] != a["sessionId"] and got["number"] == 1
    new_s = next(s for s in client.get("/dev-notes/sessions").json() if s["id"] == got["sessionId"])
    assert new_s["status"] == "collecting"
    first_title = next(s for s in client.get("/dev-notes/sessions").json() if s["id"] == a["sessionId"])["title"]
    assert new_s["title"] == f"{first_title} (Held)"        # named after the session it left, not a UTC auto title
    assert got["thread"][-1]["text"] == f"Moved to Build Session '{new_s['title']}' as Pin #1"
    sent = next(s for s in client.get("/dev-notes/sessions").json() if s["id"] == a["sessionId"])
    assert sent["status"] == "sent" and sent["noteCount"] == 1
    # nothing unheld left: 400, and the detail names the held pins
    c = _held_pin()
    assert c["sessionId"] == got["sessionId"] and c["number"] == 2
    for body in ({}, {"noteIds": [c["id"]]}):
        r = client.post("/dev-notes/dispatch", json=body)
        assert r.status_code == 400, r.text
    assert client.post("/dev-notes/dispatch", json={}).json()["detail"] == (
        "No open pins to send - Pin #1 waits for Visesh; Pin #2 waits for Visesh")
    assert client.post("/dev-notes/dispatch", json={"noteIds": [c["id"]]}).json()["detail"] == (
        "No open pins to send - Pin #2 waits for Visesh")


def test_release_by_owner_or_global_admin_only():
    b = _held_pin()
    assert client.patch(f"/dev-notes/{b['id']}", json={"release": True}).status_code == 403   # the author
    GRANTS[DEV2["email"]] = {"build-mode": 1}
    GRANTS[VISESH["email"]] = {"build-mode": 1}
    try:
        _as(DEV2)
        assert client.patch(f"/dev-notes/{b['id']}", json={"release": True}).status_code == 403
        _as(VISESH)
        r = client.patch(f"/dev-notes/{b['id']}", json={"release": True})
        assert r.status_code == 200, r.text
        got = r.json()
        assert got["held"] is False and got["ownerReleasedBy"] == VISESH["email"] and got["ownerReleasedAt"]
        assert got["thread"][-1]["text"] == "Released To Claude Code by Visesh Lodha"
        assert got["status"] == "open"                                # Visesh does not Send Instantly
        assert client.patch(f"/dev-notes/{b['id']}", json={"release": True}).status_code == 200   # no-op again
        assert len([e for e in client.get(f"/dev-notes/{b['id']}").json()["thread"]
                    if e["text"].startswith("Released")]) == 1
        # the owner cannot edit the author's pin through the same route
        assert client.patch(f"/dev-notes/{b['id']}", json={"comment": "mine now"}).status_code == 403
        # the RELEASER's Send Instantly does not matter, the author's does
        _as(DEV)
        c = _held_pin()
        _as(VISESH)
        client.put("/dev-notes/settings", json={"sendInstantly": True})
        assert client.patch(f"/dev-notes/{c['id']}", json={"release": True}).json()["status"] == "open"
        _as(DEV)
        client.put("/dev-notes/settings", json={"sendInstantly": True})
        c2 = _held_pin()
        _as(VISESH)
        assert client.patch(f"/dev-notes/{c2['id']}", json={"release": True}).json()["status"] == "dispatched"
        _as(DEV)
        client.put("/dev-notes/settings", json={"sendInstantly": False})
        # a Global Admin may release too
        _as(DEV)
        d = _held_pin()
        _as(GA)
        assert client.patch(f"/dev-notes/{d['id']}", json={"release": True}).json()["held"] is False
        # a pin that was never held is a 409
        _as(DEV)
        e = _create()
        _as(GA)
        assert client.patch(f"/dev-notes/{e['id']}", json={"release": True}).status_code == 409
    finally:
        GRANTS.pop(DEV2["email"], None)
        GRANTS.pop(VISESH["email"], None)
    # the released pin now dispatches like any other
    _as(DEV)
    out = _dispatch(noteIds=[b["id"]])
    assert out["notes"][0]["status"] == "dispatched" and out["held"] == []


def test_release_moves_a_pin_out_of_a_sent_session_and_follows_the_authors_send_instantly():
    GRANTS[VISESH["email"]] = {"build-mode": 1}
    try:
        # created held under Send Instantly: the next instant pin sends the
        # session it sits in, so it is left in a sent session
        client.put("/dev-notes/settings", json={"sendInstantly": True})
        h = _held_pin()
        other = _create()
        assert other["sessionId"] == h["sessionId"] and other["status"] == "dispatched"
        _as(VISESH)
        got = client.patch(f"/dev-notes/{h['id']}", json={"release": True}).json()
        assert got["sessionId"] != h["sessionId"] and got["number"] == 1
        texts = [e["text"] for e in got["thread"]]
        assert texts[-2].startswith("Released To Claude Code by ")
        assert texts[-1].startswith("Moved to Build Session '") and texts[-1].endswith("' as Pin #1")
        assert got["status"] == "dispatched"                  # the author Sends Instantly, as in create
        s = next(x for x in client.get("/dev-notes/sessions").json() if x["id"] == got["sessionId"])
        assert s["status"] == "sent"
        # author not instant: moved into the existing collecting session and left open
        _as(DEV)
        client.put("/dev-notes/settings", json={"sendInstantly": False})
        k = _held_pin()
        _create()
        _dispatch()                                          # k is moved by dispatch already
        k_now = client.get(f"/dev-notes/{k['id']}").json()
        collecting = k_now["sessionId"]
        fresh = _create()
        assert fresh["sessionId"] == collecting
        _as(VISESH)
        got = client.patch(f"/dev-notes/{k['id']}", json={"release": True}).json()
        assert got["status"] == "open" and got["sessionId"] == collecting       # already collecting: not moved again
        assert got["thread"][-1]["text"].startswith("Released To Claude Code by ")
    finally:
        GRANTS.pop(VISESH["email"], None)


def test_claim_skips_held_pins():
    token = _token()["token"]
    a = _create()
    b = _held_pin()
    _dispatch()
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [a["id"], b["id"]]}, headers=_hdr(token))
    assert r.status_code == 200, r.text
    assert [n["id"] for n in r.json()["notes"]] == [a["id"]]
    assert r.json()["skipped"][0]["reason"] == "Pin #1 waits for Visesh - it is in their area"   # moved: #1 of a new session
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [b["id"]]}, headers=_hdr(token))
    assert r.status_code == 409 and r.json()["detail"] == "Pin #1 waits for Visesh - it is in their area"


# ── v2: Ready To Check ────────────────────────────────────────────────────────
def _preview(n, token, url="http://localhost:5174/tasks/home", **extra):
    body = {"url": url, "branch": "build/tasks-home-1024", "prNumber": 7, "host": "neils-mbp", **extra}
    return client.post(f"/dev-notes/cli/preview/{n['id']}", headers=_hdr(token), json=body)


def test_preview_post_rules():
    token = _token()["token"]
    n = _create()
    assert _preview(n, token).status_code == 409                    # open, not pr_open
    p = _to_pr_open(token)
    for bad in ("https://evil.example/x", "http://evil.example:5174/", "http://localhost:@evil.example/x",
                "http://localhost/no-port", "http://user:pw@localhost:5174/", "javascript:alert(1)", ""):
        r = _preview(p, token, url=bad)
        assert r.status_code == 400, (bad, r.text)
    r = _preview(p, token)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["readyToCheck"] is True and got["status"] == "pr_open"
    pv = got["preview"]
    assert (pv["url"], pv["branch"], pv["prNumber"], pv["host"]) == (
        "http://localhost:5174/tasks/home", "build/tasks-home-1024", 7, "neils-mbp") and pv["startedAt"]
    assert got["thread"][-1]["text"] == "Ready To Check - runs on neils-mbp"
    again = _preview(p, token, url="http://127.0.0.1:5174/tasks/home").json()      # a restart replaces it
    assert again["preview"]["url"] == "http://127.0.0.1:5174/tasks/home"
    assert len([e for e in again["thread"] if e["text"].startswith("Ready To Check")]) == 1


def test_preview_accept_then_merge_goes_straight_to_done():
    token = _token()["token"]
    p = _to_pr_open(token)
    assert client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).status_code == 409   # no preview yet
    _preview(p, token)
    GRANTS[DEV2["email"]] = {"build-mode": 1}
    try:
        _as(DEV2)
        assert client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).status_code == 403
    finally:
        GRANTS.pop(DEV2["email"], None)
    _as(DEV)
    assert client.post(f"/dev-notes/{p['id']}/preview-verdict", json={}).status_code == 400
    r = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["previewVerdict"] == "accepted" and got["previewVerdictAt"] and got["readyToCheck"] is False
    assert got["status"] == "pr_open" and got["verifiedBy"] == DEV["email"]
    assert got["thread"][-1]["text"] == "Checked On The Preview"
    assert client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).status_code == 409
    assert _mark_fixed() == 1
    done = client.get(f"/dev-notes/{p['id']}").json()
    assert done["status"] == "done" and done["purgeAt"] and done["fixedBuildId"] == "abc123"
    assert done["thread"][-1]["text"] == "Merged To Dev - checked on the preview before merge"
    assert _bells("dev_note_fixed") == []
    s = client.get("/dev-notes/sessions").json()
    assert next(x for x in s if x["id"] == done["sessionId"])["status"] == "done"


def test_preview_reopen_goes_back_to_claude_on_the_same_branch():
    token = _token()["token"]
    p = _to_pr_open(token)
    _preview(p, token)
    r = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": False})
    assert r.status_code == 400
    r = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": False, "comment": "Still 2px off"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["status"] == "building" and got["previewVerdict"] == "reopened" and got["readyToCheck"] is False
    # counts as a reopen, like the post-merge one
    assert p["reopenCount"] == 0 and p["progress"] == "Picked up by Claude Code"
    assert got["reopenCount"] == 1 and got["progress"] == "" and got["progressAt"] == ""
    last = got["thread"][-1]
    assert last["kind"] == "comment" and last["by"] == DEV["email"] and last["text"] == "Still 2px off"
    assert got["thread"][-2]["text"] == "Reopened On The Preview"
    waiting = client.get("/dev-notes/cli/wait?timeout=0", headers=_hdr(token)).json()["notes"]
    assert [n["id"] for n in waiting] == [p["id"]] and waiting[0]["previewVerdict"] == "reopened"
    c = client.post("/dev-notes/cli/claim", json={"noteIds": [p["id"]]}, headers=_hdr(token))
    assert c.status_code == 200 and c.json()["notes"][0]["status"] == "building"
    assert client.get("/dev-notes/cli/wait?timeout=0", headers=_hdr(token)).json()["notes"] == []
    r = client.post("/dev-notes/cli/complete", headers=_hdr(token),
                    json={"noteIds": [p["id"]], "prUrl": "https://github.com/x/y/pull/7", "prNumber": 7,
                          "branch": "build/tasks-home-1024"})
    assert r.status_code == 200, r.text
    again = r.json()["notes"][0]
    assert again["status"] == "pr_open" and again["preview"] == {} and again["previewVerdict"] == ""
    assert again["previewVerdictAt"] == "" and again["readyToCheck"] is False
    # merged without a new Accept: the ordinary Fixed - Verify path
    assert _mark_fixed() == 1
    assert client.get(f"/dev-notes/{p['id']}").json()["status"] == "fixed"
    assert len(_bells("dev_note_fixed")) == 1


# ── v2: regression tests ──────────────────────────────────────────────────────
ACTIONS = [{"t": 1, "type": "click", "label": "Mark All Read", "selector": "button"},
           {"t": 2, "type": "input", "label": "Search", "value": "***"},
           {"t": 3, "type": "scroll", "label": ""}]


def _repro_pin(token, repro=None, pr=7, **fields):
    fields.setdefault("route", "inventory")
    fields.setdefault("sub", "checkouts")
    fields.setdefault("actions", ACTIONS)
    p = _to_pr_open(token, pr=pr, **fields)
    script = f"test('[{p['id']}] Pin #{p['number']} - Button is misaligned', async ({{ page }}) => {{}});"
    body = {"script": script, "before": "failing", "after": "passing", "kind": "e2e"}
    body.update(repro or {})
    r = client.post(f"/dev-notes/cli/verify/{p['id']}", headers=_hdr(token), json={"repro": body})
    assert r.status_code == 200, r.text
    assert r.json()["verification"]["repro"]["kind"] == body["kind"]
    return p


def _cases():
    db = database.SessionLocal()
    try:
        return db.query(models.QaTestCase).all()
    finally:
        db.close()


def _promote_again(note_id):
    db = database.SessionLocal()
    try:
        D.promote_regression(db, db.query(models.DevNote).filter(models.DevNote.id == note_id).first(), DEV)
    finally:
        db.close()


def test_preview_accept_promotes_the_repro_to_the_regression_suite(monkeypatch):
    from routers import qa as Q
    monkeypatch.setattr(Q, "_ENABLED", True)
    token = _token()["token"]
    p = _repro_pin(token)
    _preview(p, token)
    got = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).json()
    assert got["regressionCaseId"] == p["id"]
    assert [e["text"] for e in got["thread"]][-2:] == [
        "Checked On The Preview", "Regression test ready - it joins the suite when the PR merges"]
    cases = _cases()
    assert len(cases) == 1
    c = cases[0]
    assert c.id == p["id"] and c.module == "Item Management" and c.feature == "inventory > checkouts"
    assert c.title == f"Pin #{p['number']} - Button is misaligned"
    assert c.steps == ["Click Mark All Read", "Fill Search"]
    assert c.expected == "Fixed by PR #7: Aligned the button"
    # not merged yet: a draft, which the nightly run (active cases only) skips
    assert (c.priority, c.case_type, c.source, c.status, c.created_by) == (
        "Medium", "Regression", "build-mode", "draft", DEV["email"])
    assert f"[{p['id']}]" in c.e2e_spec
    # the merge makes it active
    assert _mark_fixed() == 1
    assert _cases()[0].status == "active"
    texts = [e["text"] for e in client.get(f"/dev-notes/{p['id']}").json()["thread"]]
    assert texts[-2:] == ["Merged To Dev - checked on the preview before merge", "Added To The Regression Suite"]
    _promote_again(p["id"])          # idempotent: a second promotion is a no-op
    assert len(_cases()) == 1
    assert len([e for e in client.get(f"/dev-notes/{p['id']}").json()["thread"]
                if e["text"] == "Added To The Regression Suite"]) == 1


def test_post_merge_accept_promotes_too(monkeypatch):
    from routers import qa as Q
    monkeypatch.setattr(Q, "_ENABLED", True)
    token = _token()["token"]
    p = _repro_pin(token, route="timeclock", priority="blocking")
    _mark_fixed()
    got = client.post(f"/dev-notes/{p['id']}/verify", json={"accepted": True}).json()
    assert got["status"] == "done" and got["regressionCaseId"] == p["id"]
    assert got["thread"][-1]["text"] == "Added To The Regression Suite"
    c = _cases()[0]
    assert c.module == "Time Clock" and c.priority == "High" and c.feature == "timeclock > checkouts"
    assert c.status == "active"                  # merged already: straight into the suite


def test_no_case_when_the_testing_module_is_off(monkeypatch):
    from routers import qa as Q
    monkeypatch.setattr(Q, "_ENABLED", False)
    token = _token()["token"]
    p = _repro_pin(token)
    _preview(p, token)
    got = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).json()
    assert got["regressionCaseId"] == "" and _cases() == []
    assert got["thread"][-1]["text"] == "Regression test not added - the Testing module is off on this deployment"
    _promote_again(p["id"])          # a second Accept path: still one entry
    assert len([e for e in client.get(f"/dev-notes/{p['id']}").json()["thread"]
                if e["text"].startswith("Regression test not added")]) == 1


def test_no_case_for_python_repros_unfixed_repros_non_bugs_or_unstamped_specs(monkeypatch):
    from routers import qa as Q
    monkeypatch.setattr(Q, "_ENABLED", True)
    token = _token()["token"]
    pins = [
        _repro_pin(token, pr=11, repro={"kind": "python"}),
        _repro_pin(token, pr=12, repro={"before": "passing"}),
        _repro_pin(token, pr=13, repro={"after": "skipped"}),
        _repro_pin(token, pr=14, kind="change"),
        _repro_pin(token, pr=15, repro={"script": "test('Pin #1 - no id', async () => {});"}),
    ]
    for p in pins:
        _preview(p, token, prNumber=p["prNumber"])
        got = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True}).json()
        assert got["previewVerdict"] == "accepted" and got["regressionCaseId"] == "", p
        assert not any("Regression" in e["text"] for e in got["thread"])
    assert _cases() == []
    # the repro kind is validated; an old client without it stores "python"
    p = pins[0]
    assert client.post(f"/dev-notes/cli/verify/{p['id']}", headers=_hdr(token),
                       json={"repro": {"before": "failing", "after": "passing", "kind": "ruby"}}).status_code == 400
    r = client.post(f"/dev-notes/cli/verify/{p['id']}", headers=_hdr(token),
                    json={"repro": {"before": "failing", "after": "passing"}})
    assert r.json()["verification"]["repro"]["kind"] == "python"


def test_promotion_failure_never_breaks_the_verdict(monkeypatch):
    from routers import qa as Q
    monkeypatch.setattr(Q, "_ENABLED", True)

    def boom(n):
        raise RuntimeError("boom")
    monkeypatch.setattr(D, "_steps", boom)
    token = _token()["token"]
    p = _repro_pin(token)
    _preview(p, token)
    r = client.post(f"/dev-notes/{p['id']}/preview-verdict", json={"accepted": True})
    assert r.status_code == 200, r.text
    assert r.json()["previewVerdict"] == "accepted" and r.json()["regressionCaseId"] == ""
    assert _cases() == []


def test_v2_columns_have_migration_lines_in_both_lists():
    from pathlib import Path
    text = (Path(__file__).resolve().parent / "main.py").read_text()
    split = text.index("    migrations = [")
    sqlite_part, pg_part = text[:split], text[split:]
    cols = ("owner_email", "owner_name", "owner_released_by", "owner_released_at", "preview",
            "preview_verdict", "preview_verdict_at", "regression_case_id")
    for col in cols:
        assert col in models.DevNote.__table__.columns
        assert f'"ALTER TABLE dev_notes ADD COLUMN {col} ' in sqlite_part, col
        assert f'"ALTER TABLE dev_notes ADD COLUMN IF NOT EXISTS {col} ' in pg_part, col
    # The Ready To Check preview frontend runs on :5174, which every branch's
    # CORS list has carried since 06/18/2026 - so a preview of a branch cut
    # before Build Mode v2 still reaches its own backend. No new origin.
    assert '"http://localhost:5174"' in text and ':5180' not in text


# ── v2 review fixes ───────────────────────────────────────────────────────────
def _two_pins_on_one_pr(token, pr=7):
    a = _create()
    b = _create(comment="Second")
    _dispatch()
    client.post("/dev-notes/cli/claim", json={"noteIds": [a["id"], b["id"]]}, headers=_hdr(token))
    r = client.post("/dev-notes/cli/complete", headers=_hdr(token),
                    json={"noteIds": [a["id"], b["id"]], "prUrl": f"https://github.com/x/y/pull/{pr}",
                          "prNumber": pr, "branch": "build/x", "summary": "Fixed both"})
    assert r.status_code == 200, r.text
    return r.json()["notes"]


def test_pr_merged_mid_rework_keeps_the_pin_and_drops_the_pr():
    token = _token()["token"]
    a, b = _two_pins_on_one_pr(token)
    _preview(a, token)
    _preview(b, token)
    client.post(f"/dev-notes/{b['id']}/preview-verdict", json={"accepted": False, "comment": "Still wrong"})
    assert _mark_fixed() == 2
    got_a = client.get(f"/dev-notes/{a['id']}").json()
    assert got_a["status"] == "fixed"
    got_b = client.get(f"/dev-notes/{b['id']}").json()
    assert got_b["status"] == "building"
    assert (got_b["prNumber"], got_b["prUrl"], got_b["branch"], got_b["preview"], got_b["previewVerdict"]) == (0, "", "", {}, "")
    texts = [e["text"] for e in got_b["thread"]]
    assert "PR #7 merged while this pin was being reworked - the rework comes in a new PR" in texts
    assert texts[-1] == "Still wrong"                    # the author's comment stays last ...
    waiting = client.get("/dev-notes/cli/wait?timeout=0", headers=_hdr(token)).json()["notes"]
    assert [n["id"] for n in waiting] == [b["id"]]       # ... so Claude Code still picks the rework up
    bells = _bells("dev_note_rework")
    assert len(bells) == 1 and bells[0]["recipient"] == DEV["email"] and bells[0]["ref_id"] == b["id"]
    assert bells[0]["title"] == f"Pin #{b['number']} Needs A New PR"
    assert _mark_fixed() == 0                            # nothing left on that PR
    # a pin waiting on the author (needs_input) keeps that status too
    c = _to_pr_open(token, pr=9)
    _preview(c, token, prNumber=9)
    client.post(f"/dev-notes/{c['id']}/preview-verdict", json={"accepted": False, "comment": "No"})
    client.post("/dev-notes/cli/claim", json={"noteIds": [c["id"]]}, headers=_hdr(token))
    client.post(f"/dev-notes/cli/reply/{c['id']}", headers=_hdr(token), json={"text": "Which one?", "needsInput": True})
    assert _mark_fixed(pr=9) == 1
    got_c = client.get(f"/dev-notes/{c['id']}").json()
    assert got_c["status"] == "needs_input" and got_c["prNumber"] == 0
    assert got_c["thread"][-1]["text"].startswith("PR #9 merged while this pin was being reworked")


def test_branch_change_resets_accepted_verdicts():
    token = _token()["token"]
    a, b = _two_pins_on_one_pr(token)
    assert _preview(a, token, commit="zzz").status_code == 400                  # not a sha
    _preview(a, token, commit="abc1234")
    _preview(b, token, commit="abc1234")
    acc = client.post(f"/dev-notes/{a['id']}/preview-verdict", json={"accepted": True}).json()
    assert acc["preview"]["verdictCommit"] == "abc1234" and acc["preview"]["commit"] == "abc1234"
    client.post(f"/dev-notes/{b['id']}/preview-verdict", json={"accepted": False, "comment": "Fix b"})
    # b is reworked on the same branch and completed again: a's Accept no longer covers the branch
    client.post("/dev-notes/cli/claim", json={"noteIds": [b["id"]]}, headers=_hdr(token))
    client.post("/dev-notes/cli/complete", headers=_hdr(token),
                json={"noteIds": [b["id"]], "prUrl": "https://github.com/x/y/pull/7", "prNumber": 7, "branch": "build/x"})
    got_a = client.get(f"/dev-notes/{a['id']}").json()
    assert got_a["previewVerdict"] == "" and got_a["verifiedBy"] == "" and got_a["readyToCheck"] is True
    assert got_a["thread"][-1]["text"] == "The branch changed after you checked it - check it again on the preview"
    # Accept again; the same commit posted again keeps the verdict ...
    client.post(f"/dev-notes/{a['id']}/preview-verdict", json={"accepted": True})
    kept = _preview(a, token, commit="abc1234").json()
    assert kept["previewVerdict"] == "accepted" and kept["preview"]["verdictCommit"] == "abc1234"
    # ... a different commit resets every Accept on the PR
    moved = _preview(b, token, commit="def5678").json()
    assert moved["previewVerdict"] == ""
    got_a = client.get(f"/dev-notes/{a['id']}").json()
    assert got_a["previewVerdict"] == "" and got_a["readyToCheck"] is True
    assert len([e for e in got_a["thread"] if e["text"].startswith("The branch changed")]) == 2


def test_per_caller_flags_and_is_global_admin():
    token = _token()["token"]
    held = _held_pin()
    p = _to_pr_open(token, pr=21)
    _preview(p, token, prNumber=21)
    mine = {n["id"]: n for n in client.get("/dev-notes").json()}
    assert mine[held["id"]]["canRelease"] is False                 # the author is not the owner
    assert mine[p["id"]]["canVerdict"] is True                     # the author, Ready To Check
    assert mine[held["id"]]["canVerdict"] is False
    assert client.get("/dev-notes/enabled").json()["isGlobalAdmin"] is False
    GRANTS[VISESH["email"]] = {"build-mode": 1}
    GRANTS[DEV2["email"]] = {"build-mode": 1}
    try:
        _as(VISESH)
        assert client.get(f"/dev-notes/{held['id']}").json()["canRelease"] is True
        _as(DEV2)
        got = client.get(f"/dev-notes/{p['id']}").json()
        assert got["canVerdict"] is False and got["canRelease"] is False
    finally:
        GRANTS.pop(VISESH["email"], None)
        GRANTS.pop(DEV2["email"], None)
    _as(GA)
    assert client.get("/dev-notes/enabled").json()["isGlobalAdmin"] is True
    ga_view = client.get(f"/dev-notes/{held['id']}").json()
    assert ga_view["canRelease"] is True
    assert client.get(f"/dev-notes/{p['id']}").json()["canVerdict"] is True
    # Fixed - Verify counts for canVerdict too
    _as(DEV)
    _mark_fixed(pr=21)
    assert client.get(f"/dev-notes/{p['id']}").json()["canVerdict"] is True
    # the Global Admin check runs once per request, not once per pin
    for _ in range(3):
        _create()
    calls = []
    real = auth.is_global_admin
    auth.is_global_admin = lambda user, db: calls.append(1) or real(user, db)
    try:
        assert len(client.get("/dev-notes").json()) >= 5
    finally:
        auth.is_global_admin = real
    assert len(calls) == 2           # the access check + the flags


def test_owner_of_endpoint():
    r = client.get("/dev-notes/owner-of", params={"path": "src/views/InventoryManagement.jsx"})
    assert r.json() == {"owner": {"name": "Visesh", "email": VISESH["email"]}, "held": True}
    assert client.get("/dev-notes/owner-of", params={"path": "src/tasks/X.jsx"}).json() == {"owner": None, "held": False}
    GRANTS[NEIL["email"]] = {"build-mode": 1}
    try:
        _as(NEIL)
        got = client.get("/dev-notes/owner-of", params={"path": "./src/asset/lib/sync.js"}).json()
        assert got == {"owner": {"name": "Neil", "email": NEIL["email"]}, "held": False}
    finally:
        GRANTS.pop(NEIL["email"], None)
    _as(ADMIN)
    assert client.get("/dev-notes/owner-of", params={"path": "src/x.jsx"}).status_code == 403


def test_held_session_title_is_truncated_to_120_and_never_doubled():
    _create()
    h = _held_pin()
    _dispatch(title="A" * 150)
    moved = client.get(f"/dev-notes/{h['id']}").json()
    s = next(x for x in client.get("/dev-notes/sessions").json() if x["id"] == moved["sessionId"])
    assert s["title"] == "A" * 113 + " (Held)" and len(s["title"]) == 120
    # sent again with the held pin still in it: no "(Held) (Held)"
    _create()
    _dispatch()
    again = client.get(f"/dev-notes/{h['id']}").json()
    s2 = next(x for x in client.get("/dev-notes/sessions").json() if x["id"] == again["sessionId"])
    assert again["sessionId"] != moved["sessionId"] and s2["title"] == s["title"]
    assert D._held_title(None) == ""


def test_stopping_a_preview_ends_ready_to_check_and_keeps_an_accept():
    token = _token()["token"]
    a, b = _two_pins_on_one_pr(token)
    _preview(a, token)
    _preview(b, token)
    client.post(f"/dev-notes/{b['id']}/preview-verdict", json={"accepted": True})
    r = client.delete(f"/dev-notes/cli/preview/{a['id']}", headers=_hdr(token))
    assert r.status_code == 204 and r.content == b""
    got = client.get(f"/dev-notes/{a['id']}").json()
    assert got["preview"] == {} and got["readyToCheck"] is False and got["status"] == "pr_open"
    assert got["thread"][-1]["text"] == "Preview stopped - it comes back when Claude Code restarts it"
    # idempotent: no preview, nothing happens
    before = len(got["thread"])
    assert client.delete(f"/dev-notes/cli/preview/{a['id']}", headers=_hdr(token)).status_code == 204
    assert len(client.get(f"/dev-notes/{a['id']}").json()["thread"]) == before
    # an accepted pin keeps its verdict and gets no entry (it was not Ready To Check)
    n_b = len(client.get(f"/dev-notes/{b['id']}").json()["thread"])
    assert client.delete(f"/dev-notes/cli/preview/{b['id']}").status_code == 204       # a signed-in user works too
    got_b = client.get(f"/dev-notes/{b['id']}").json()
    assert got_b["preview"] == {"verdictCommit": ""} and got_b["previewVerdict"] == "accepted"
    assert got_b["readyToCheck"] is False and len(got_b["thread"]) == n_b
    assert client.delete("/dev-notes/cli/preview/nope", headers=_hdr(token)).status_code == 404
    # a restart makes it Ready To Check again
    assert _preview(a, token).json()["readyToCheck"] is True


def test_a_stopped_preview_keeps_the_verdict_commit_so_a_new_commit_still_resets_it():
    token = _token()["token"]
    a, b = _two_pins_on_one_pr(token)
    _preview(a, token, commit="abc1234")
    _preview(b, token, commit="abc1234")
    client.post(f"/dev-notes/{a['id']}/preview-verdict", json={"accepted": True})
    assert client.delete(f"/dev-notes/cli/preview/{a['id']}", headers=_hdr(token)).status_code == 204
    got = client.get(f"/dev-notes/{a['id']}").json()
    assert got["preview"] == {"verdictCommit": "abc1234"} and got["previewVerdict"] == "accepted"
    assert got["readyToCheck"] is False
    # stopping again: no url, nothing changes
    assert client.delete(f"/dev-notes/cli/preview/{a['id']}", headers=_hdr(token)).status_code == 204
    assert client.get(f"/dev-notes/{a['id']}").json()["preview"] == {"verdictCommit": "abc1234"}
    # the PR moves to a new commit (seen on b's preview): a's Accept is reset
    _preview(b, token, commit="def5678")
    got = client.get(f"/dev-notes/{a['id']}").json()
    assert got["previewVerdict"] == "" and got["readyToCheck"] is False      # still no url
    assert got["thread"][-1]["text"] == "The branch changed after you checked it - check it again on the preview"


def test_names_come_from_task_notify_and_lookup_errors_are_not_swallowed(monkeypatch):
    import task_notify
    monkeypatch.setattr(task_notify, "_name_of", lambda db, email: f"Name Of {email}")
    db = database.SessionLocal()
    try:
        assert D._name_of(db, "X@Y.com") == "Name Of x@y.com"
    finally:
        db.close()

    def broken(email, db):
        raise RuntimeError("database is down")
    monkeypatch.setattr(auth, "_role_for", broken)
    # a swallowed error would leave a Postgres transaction aborted: it must surface
    with pytest.raises(RuntimeError):
        client.post("/dev-notes", json={"comment": "x", "route": "inventory", "target": VISESH_FILE})


def test_daily_purge_pass_audits_only_when_something_went(monkeypatch):
    monkeypatch.setattr(D, "_delete_object", lambda u: True)
    db = database.SessionLocal()
    db.query(models.AuditLog).filter(models.AuditLog.user_email == "build-mode-purge").delete()
    db.commit()
    db.close()
    _as(DEV)
    n = _create()
    assert client.patch(f"/dev-notes/{n['id']}", json={"status": "dismissed"}).json()["purgeAt"] != ""
    assert D._purge_pass() == 0   # not due yet: no audit row
    db = database.SessionLocal()
    assert db.query(models.AuditLog).filter(models.AuditLog.user_email == "build-mode-purge").count() == 0
    db.query(models.DevNote).filter(models.DevNote.id == n["id"]).update({"purge_at": "2020-01-01T00:00:00+00:00"})
    db.commit()
    db.close()
    assert D._purge_pass() == 1
    assert client.get(f"/dev-notes/{n['id']}").json()["screenshotUrl"] == ""
    db = database.SessionLocal()
    rows = db.query(models.AuditLog).filter(models.AuditLog.user_email == "build-mode-purge").all()
    assert [(r.action, r.user_role, json.loads(r.details)) for r in rows] == [("dev_note_purge", "system", {"purged": 1, "by": "daily"})]
    db.close()


def test_daily_purge_loop_keeps_going_after_a_failed_run(monkeypatch):
    import asyncio
    calls, sleeps = [], []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("storage is down")
        return 2

    async def fake_sleep(sec):
        sleeps.append(sec)
        if len(sleeps) > 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(D, "_purge_pass", flaky)
    monkeypatch.setattr(D.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(D.purge_media_loop())
    assert len(calls) == 2 and sleeps == [600, D.PURGE_LOOP_SEC, D.PURGE_LOOP_SEC]


def test_daily_purge_is_wired_for_the_deployed_worker_only():
    src = open(os.path.join(os.path.dirname(__file__), "main.py")).read()
    block = src[src.index("from routers.dev_notes import purge_media_loop") - 300:]
    assert "is_deployed_worker()" in block[:400]


# ── A sent pin goes to its sender's Claude Code only (Oct 26 2026) ────────────
def test_a_sent_pin_reaches_only_the_senders_watcher():
    dev_token = _token()["token"]
    _as(GA)
    ga_token = _token()["token"]
    _as(DEV)
    p = _create()
    _dispatch()
    assert client.get(f"/dev-notes/{p['id']}").json()["dispatchedBy"] == DEV["email"]
    # Someone else's watcher neither sees it nor can claim it ...
    assert client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=_hdr(ga_token)).json()["notes"] == []
    r = client.post("/dev-notes/cli/claim", json={"noteIds": [p["id"]]}, headers=_hdr(ga_token))
    assert r.status_code == 409 and "Claude Code, not yours" in r.json()["detail"]
    assert client.get(f"/dev-notes/{p['id']}").json()["status"] == "dispatched"
    # ... the sender's does.
    waiting = client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=_hdr(dev_token)).json()["notes"]
    assert [n["id"] for n in waiting] == [p["id"]]
    assert client.post("/dev-notes/cli/claim", json={"noteIds": [p["id"]]}, headers=_hdr(dev_token)).status_code == 200


def test_a_pin_sent_before_the_rule_belongs_to_its_author():
    token = _token()["token"]
    p = _create()
    _dispatch()
    db = database.SessionLocal()
    db.query(models.DevNote).filter_by(id=p["id"]).update({"dispatched_by": ""})
    db.commit(); db.close()
    waiting = client.get("/dev-notes/cli/wait", params={"timeout": 0}, headers=_hdr(token)).json()["notes"]
    assert [n["id"] for n in waiting] == [p["id"]]


def test_claude_connection_is_the_callers_own_watcher():
    out = client.get("/dev-notes/claude-connection").json()
    assert out["connected"] is False and out["lastSeen"] == "" and "apiBase" in out
    minted = _token()
    client.get("/dev-notes/cli/whoami", headers=_hdr(minted["token"]))      # the watcher's first call
    out = client.get("/dev-notes/claude-connection").json()
    assert out["connected"] is True and out["lastSeen"]
    # Someone else's connection is not mine
    _as(GA)
    assert client.get("/dev-notes/claude-connection").json()["connected"] is False
    _as(DEV)
    # A watcher silent for longer than CONNECTED_SEC is not connected; a revoked token never is
    db = database.SessionLocal()
    db.query(models.DevNoteToken).filter_by(id=minted["id"]).update({"last_used_at": "2020-01-01T00:00:00+00:00"})
    db.commit(); db.close()
    assert client.get("/dev-notes/claude-connection").json()["connected"] is False
    client.get("/dev-notes/cli/whoami", headers=_hdr(minted["token"]))
    assert client.delete(f"/dev-notes/tokens/{minted['id']}").status_code == 204
    assert client.get("/dev-notes/claude-connection").json()["connected"] is False
