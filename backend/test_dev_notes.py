"""Build Mode (routers/dev_notes.py): access, pins, sessions, Build Tokens,
the CLI loop, the merged-PR hook and the verify step. Own throwaway SQLite,
no network (storage signing and uploads are stubbed).

Run on its own: python -m pytest test_dev_notes.py
"""
import io
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
    auth._grants_for = lambda email, db: GRANTS.get(email.lower(), {})
    auth.is_global_admin = lambda user, db: user["email"] == GA["email"]
    F.fetchable_url = lambda u: "signed:" + u
    yield
    auth._grants_for, auth.is_global_admin, F.fetchable_url = saved
    database.engine.dispose()
    os.remove(_tmp.name)


@pytest.fixture(autouse=True)
def _clean():
    CURRENT["user"] = DEV
    GRANTS[DEV["email"]] = {"build-mode": 1}
    db = database.SessionLocal()
    for m in (models.DevNote, models.DevNoteSession, models.DevNoteToken,
              models.NexusNotification, models.NexusSetting, models.AuditLog):
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


def _to_pr_open(token=None, pr=7):
    """open -> dispatched -> building -> pr_open, returns the note."""
    token = token or _token()["token"]
    n = _create()
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
