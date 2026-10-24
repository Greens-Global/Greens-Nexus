"""Build Mode -> Teams mirror (build_mode_chat.py, Oct 25 2026).

  - Send with a chat picked: the pick is saved for next time, written on the
    session, and ONE card per session is queued (kind build_mode) with the
    pins grouped by module, their Where line and the marked-up shot inline.
  - No chat picked, nothing saved: nothing is queued.
  - Claude parks a pin (needs input): one question post; a merged PR: one
    "Fixed - please verify" post per session.
  - Save Report: a self-contained HTML file with every pin and its image.
  - Delivery posts as the author with hostedContents; an unreadable shot is
    dropped, the card still goes; no token = the reason stays on the row.

Own throwaway SQLite, no network. Run on its own:
python -m pytest test_build_mode_chat.py
"""
import os
import tempfile
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ.pop("SUPABASE_SERVICE_KEY", None)

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import build_mode_chat as C  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import teams_post  # noqa: E402
from routers import dev_notes as D  # noqa: E402

DEV = {"email": "dev@greensglobal.com", "role": "employee", "level": 1}
MEDIA = "https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/n1/screenshot-1.png"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20

_app = FastAPI()
_app.include_router(D.router)
_app.dependency_overrides[auth.get_current_user] = lambda: DEV
_app.dependency_overrides[D._signed_in_user] = lambda request=None: DEV
client = TestClient(_app)


@pytest.fixture(scope="module", autouse=True)
def _env():
    models.Base.metadata.create_all(bind=database.engine)
    saved = (auth._grants_for, auth.is_global_admin)
    auth._grants_for = lambda email, db: {"build-mode": 1}
    auth.is_global_admin = lambda user, db: False
    yield
    auth._grants_for, auth.is_global_admin = saved
    database.engine.dispose()
    os.remove(_tmp.name)


@pytest.fixture(autouse=True)
def _clean():
    db = database.SessionLocal()
    for m in (models.DevNote, models.DevNoteSession, models.NexusNotification, models.NexusSetting,
              models.AuditLog, models.TicketTeamsMessage):
        db.query(m).delete()
    db.commit()
    db.close()
    yield


def _pin(**fields):
    body = {"kind": "bug", "priority": "normal", "comment": "Button is misaligned", "route": "tasks", "sub": "home",
            "screenshotUrl": MEDIA, "target": {"source": {"file": "src/tasks/Home.jsx", "line": 142}}}
    body.update(fields)
    r = client.post("/dev-notes", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _rows():
    db = database.SessionLocal()
    try:
        return db.query(models.TicketTeamsMessage).filter_by(kind=C.KIND).order_by(models.TicketTeamsMessage.created_at).all()
    finally:
        db.close()


def test_send_with_a_chat_queues_one_card_per_session_and_remembers_the_pick():
    a = _pin()
    _pin(route="tickets", sub="", comment="Priority chip is the wrong color", kind="change")
    with mock.patch("routers.tickets._deliver_teams_dm"):
        r = client.post("/dev-notes/dispatch", json={"teamsChatId": "19:abc@thread.v2", "teamsChatName": "Nexus - Feedback and Bugs"})
    assert r.status_code == 200, r.text
    assert r.json()["session"]["teamsChatId"] == "19:abc@thread.v2"
    assert r.json()["session"]["teamsChatName"] == "Nexus - Feedback and Bugs"
    st = client.get("/dev-notes/settings").json()
    assert st["teamsChatId"] == "19:abc@thread.v2" and st["teamsChatName"] == "Nexus - Feedback and Bugs"
    rows = _rows()
    assert len(rows) == 1
    row = rows[0]
    assert row.chat_id == "19:abc@thread.v2" and row.agent_email == DEV["email"] and row.ticket_id == a["sessionId"]
    html = row.html
    assert "<strong>Build Session</strong>" in html and "2 pins" in html
    assert "<strong>Tasks</strong>" in html and "<strong>Tickets</strong>" in html   # grouped by module
    assert "#1 Bug" in html and "Button is misaligned" in html and "#2 Change" in html
    assert "Where: frontend/src/tasks/Home.jsx:142" in html
    assert html.count('<img data-nx-src="') == 2 and MEDIA in html
    assert f"/dev-notes?pin={a['id']}" in html


def test_no_chat_means_no_post():
    _pin()
    with mock.patch("routers.tickets._deliver_teams_dm"):
        assert client.post("/dev-notes/dispatch", json={}).status_code == 200
    assert _rows() == []


def test_saved_pick_is_used_when_the_send_names_none_and_an_empty_id_clears_it():
    client.put("/dev-notes/settings", json={"teamsChatId": "19:abc@thread.v2", "teamsChatName": "Dev chat"})
    _pin()
    with mock.patch("routers.tickets._deliver_teams_dm"):
        r = client.post("/dev-notes/dispatch", json={})
    assert r.json()["session"]["teamsChatName"] == "Dev chat" and len(_rows()) == 1
    _pin()
    with mock.patch("routers.tickets._deliver_teams_dm"):
        r = client.post("/dev-notes/dispatch", json={"teamsChatId": ""})
    assert r.json()["session"]["teamsChatId"] == "" and len(_rows()) == 1
    assert client.get("/dev-notes/settings").json()["teamsChatId"] == ""


def test_question_and_fixed_posts_follow_the_session_chat():
    a = _pin()
    with mock.patch("routers.tickets._deliver_teams_dm"):
        client.post("/dev-notes/dispatch", json={"teamsChatId": "19:abc@thread.v2", "teamsChatName": "Dev chat"})
        assert client.post("/dev-notes/cli/claim", json={"noteIds": [a["id"]]}).status_code == 200
        r = client.post(f"/dev-notes/cli/reply/{a['id']}", json={"text": "Should the chip be red or orange?", "needsInput": True})
        assert r.status_code == 200, r.text
    rows = _rows()
    assert len(rows) == 2 and "Pin #1 Needs Your Answer" in rows[1].html and "red or orange" in rows[1].html
    with mock.patch("routers.tickets._deliver_teams_dm"):
        client.post(f"/dev-notes/cli/complete", json={"noteIds": [a["id"]], "prUrl": "https://github.com/x/y/pull/7", "prNumber": 7, "branch": "fix/x"})
    db = database.SessionLocal()
    try:
        assert D.mark_fixed_for_pr(db, 7, "abc123") == 1
    finally:
        db.close()
    rows = _rows()
    assert len(rows) == 3 and "Fixed - Please Verify" in rows[2].html and "#7" in rows[2].html and "#1" in rows[2].html


def test_report_is_one_html_file_with_every_pin_and_its_image():
    _pin()
    _pin(route="accounting", sub="", comment="Total is off by the tax", screenshotUrl="")
    sid = client.get("/dev-notes/sessions").json()[0]["id"]
    with mock.patch.object(C, "_read_image", return_value=(PNG, "image/png")):
        r = client.get(f"/dev-notes/sessions/{sid}/report")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert 'attachment; filename="Build Session' in r.headers["content-disposition"]
    body = r.text
    assert "<h2>Accounting</h2>" in body and "<h2>Tasks</h2>" in body
    assert "Button is misaligned" in body and "Total is off by the tax" in body
    assert "Where: frontend/src/tasks/Home.jsx:142" in body
    assert body.count("data:image/png;base64,") == 1       # only the pin that has a shot


def test_hosted_images_swap_in_and_unreadable_ones_drop_out():
    html = f'<p>x</p><img data-nx-src="{MEDIA}"><img data-nx-src="https://test.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/n2/s.png">'
    reads = iter([(PNG, "image/png"), None])
    with mock.patch.object(C, "_read_image", side_effect=lambda u: next(reads)):
        out, hosted = C.with_hosted_images(html)
    assert out == '<p>x</p><img src="../hostedContents/1/$value" style="max-width:480px">'
    assert len(hosted) == 1 and hosted[0]["@microsoft.graph.temporaryId"] == "1" and hosted[0]["contentType"] == "image/png"


def test_deliver_posts_as_the_author_and_keeps_the_reason_without_a_token():
    _pin()
    with mock.patch("routers.tickets._deliver_teams_dm"):
        client.post("/dev-notes/dispatch", json={"teamsChatId": "19:abc@thread.v2", "teamsChatName": "Dev chat"})
    db = database.SessionLocal()
    try:
        row = db.query(models.TicketTeamsMessage).filter_by(kind=C.KIND).first()
        with mock.patch("bff_session.graph_token_for_email", return_value=""):
            assert teams_post.deliver_ticket_row(db, row) is False
        assert row.sent == 0 and "no usable session token" in row.send_error
        posted = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            posted["url"], posted["json"] = url, json
            return mock.Mock(status_code=201, text="")
        row.attempts, row.last_try_at = 0, ""     # outside the claim window again
        db.commit()
        with mock.patch("bff_session.graph_token_for_email", return_value="tok"), \
             mock.patch.object(C, "_read_image", return_value=(PNG, "image/png")), \
             mock.patch.object(C.httpx, "post", side_effect=fake_post):
            assert teams_post.deliver_ticket_row(db, row) is True
        assert row.sent == 1 and row.send_error == ""
        assert posted["url"].endswith("/chats/19:abc@thread.v2/messages")
        assert "Sent by Nexus" in posted["json"]["body"]["content"]
        assert "../hostedContents/1/$value" in posted["json"]["body"]["content"]
        assert len(posted["json"]["hostedContents"]) == 1
    finally:
        db.close()
