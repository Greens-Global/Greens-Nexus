"""Hosted Build Mode previews (build_preview.py, routers/build_preview_auth.py):
which addresses count as our previews, the dev-site handoff, and the claim
that turns a single-use code plus its verifier into the preview's session.
Own throwaway SQLite, no network.

Run on its own: python -m pytest test_build_preview.py
"""
import os
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_APP_URL"] = "https://dev.nexus.greensglobal.com"
os.environ.pop("NEXUS_PREVIEW_HOST_SUFFIX", None)

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import bff_session  # noqa: E402
import build_preview as BP  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import auth_bff  # noqa: E402
from routers import build_preview_auth as R  # noqa: E402

DEV = "dev@greensglobal.com"          # Build Mode grant
OTHER = "someone@greensglobal.com"    # no grant
GRANTS = {DEV: {"build-mode": 2}}
SESSION = {"email": ""}
PREVIEW = "https://0d332dc0.greens-nexus-dev.pages.dev"

_app = FastAPI()
_app.include_router(R.router)
client = TestClient(_app, base_url="https://testserver")


@pytest.fixture(scope="module", autouse=True)
def _patched():
    models.Base.metadata.create_all(bind=database.engine)
    saved = (auth._grants_for, auth._email_from_session, bff_session.CLIENT_SECRET, auth_bff.APP_URL)
    auth._grants_for = lambda email, db: GRANTS.get(email.lower(), {})
    auth._email_from_session = lambda request: SESSION["email"]
    bff_session.CLIENT_SECRET = "test-only-secret"
    auth_bff.APP_URL = "https://dev.nexus.greensglobal.com"
    yield
    auth._grants_for, auth._email_from_session, bff_session.CLIENT_SECRET, auth_bff.APP_URL = saved
    database.engine.dispose()
    os.remove(_tmp.name)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setenv("NEXUS_APP_URL", "https://dev.nexus.greensglobal.com")
    monkeypatch.delenv("NEXUS_PREVIEW_HOST_SUFFIX", raising=False)
    SESSION["email"] = DEV
    db = database.SessionLocal()
    for m in (models.ExternalLoginCode, models.ServerSession, models.AuditLog):
        db.query(m).delete()
    db.commit()
    db.close()
    yield


VERIFIER = "v" * 43
CHALLENGE = BP.challenge_of(VERIFIER)


def _handoff(to=PREVIEW, nxt="/tasks/home", challenge=CHALLENGE):
    return client.get("/auth/preview-handoff", params={"to": to, "next": nxt, "challenge": challenge},
                      follow_redirects=False)


def _code_from(resp):
    loc = resp.headers["location"]
    assert loc.startswith(PREVIEW + "/tasks/home#nx_preview=")
    return loc.split("#nx_preview=", 1)[1]


# ── which addresses are ours ─────────────────────────────────────────────────
def test_on_only_for_the_dev_api(monkeypatch):
    assert BP.host_suffix() == ".greens-nexus-dev.pages.dev"
    monkeypatch.setenv("NEXUS_APP_URL", "https://nexus.greensglobal.com")
    assert BP.host_suffix() == ""                               # production: off
    monkeypatch.setenv("NEXUS_PREVIEW_HOST_SUFFIX", "previews.example.dev")
    assert BP.host_suffix() == ".previews.example.dev"          # named explicitly
    monkeypatch.setenv("NEXUS_PREVIEW_HOST_SUFFIX", "off")
    monkeypatch.setenv("NEXUS_APP_URL", "https://dev.nexus.greensglobal.com")
    assert BP.host_suffix() == ""                               # "off" wins anywhere


def test_preview_origin_is_one_of_ours_exactly():
    assert BP.preview_origin(PREVIEW) == PREVIEW
    assert BP.preview_origin(PREVIEW + "/") == PREVIEW
    assert BP.preview_origin("https://Claude-Hopeful-Brown.greens-nexus-dev.pages.dev") == \
        "https://claude-hopeful-brown.greens-nexus-dev.pages.dev"
    for bad in ("http://0d332dc0.greens-nexus-dev.pages.dev",            # not https
                "https://greens-nexus-dev.pages.dev",                    # the project itself
                "https://a.b.greens-nexus-dev.pages.dev",                # two labels
                "https://x.greens-nexus-dev.pages.dev.evil.example",
                "https://evil-greens-nexus-dev.pages.dev",
                "https://a@x.greens-nexus-dev.pages.dev",
                "https://x.greens-nexus-dev.pages.dev:8443",
                "https://x.greens-nexus-dev.pages.dev/path",
                "https://x.greens-nexus-dev.pages.dev?x=1",
                "https://-x.greens-nexus-dev.pages.dev",
                "javascript:alert(1)", ""):
        assert BP.preview_origin(bad) == "", bad


def test_pin_links_and_next_paths():
    assert BP.preview_url_ok(PREVIEW + "/tasks/home?x=1")
    assert not BP.preview_url_ok("https://evil.example/tasks")
    assert not BP.preview_url_ok("https://x.greens-nexus-dev.pages.dev:444/")
    assert BP.safe_next("/tasks/home?x=1") == "/tasks/home?x=1"
    for bad in ("//evil.example/x", "https://evil.example", "/\\evil", "tasks", "/a\nb", ""):
        assert BP.safe_next(bad) == "/", bad


# ── the handoff on the dev site ──────────────────────────────────────────────
def test_handoff_hands_a_code_in_the_fragment():
    r = _handoff()
    assert r.status_code == 302, r.text
    code = _code_from(r)
    assert len(code) >= 40
    assert r.headers["referrer-policy"] == "no-referrer"
    db = database.SessionLocal()
    row = db.query(models.ExternalLoginCode).one()
    assert row.purpose == "preview" and row.email == DEV and row.channel == PREVIEW
    assert code not in row.code_hash                       # kept only as a hash
    db.close()


def test_handoff_signs_in_to_the_dev_site_first():
    SESSION["email"] = ""
    r = _handoff()
    assert r.status_code == 302
    loc = urlparse(r.headers["location"])
    assert (loc.scheme, loc.netloc, loc.path) == ("https", "dev.nexus.greensglobal.com", "/api/auth/login")
    back = parse_qs(loc.query)["next"][0]
    assert back.startswith("/api/auth/preview-handoff?")
    assert parse_qs(urlparse(back).query)["to"] == [PREVIEW]


def test_handoff_refuses_what_is_not_ours():
    assert _handoff(to="https://evil.example").status_code == 400
    assert _handoff(challenge="short").status_code == 400
    SESSION["email"] = OTHER
    assert _handoff().status_code == 403                    # no Build Mode
    db = database.SessionLocal()
    assert db.query(models.ExternalLoginCode).count() == 0
    db.close()


def test_handoff_off_on_production(monkeypatch):
    monkeypatch.setenv("NEXUS_APP_URL", "https://nexus.greensglobal.com")
    assert _handoff().status_code == 404


def test_handoff_keeps_the_path_only():
    r = _handoff(nxt="//evil.example/x")
    assert r.headers["location"].startswith(PREVIEW + "/#nx_preview=")


# ── the claim on the preview ─────────────────────────────────────────────────
def _claim(code, verifier=VERIFIER, origin=PREVIEW):
    headers = {"origin": origin} if origin else {}
    return client.post("/auth/preview-claim", json={"code": code, "verifier": verifier}, headers=headers)


def test_claim_sets_the_preview_session_once():
    code = _code_from(_handoff())
    r = _claim(code)
    assert r.status_code == 200, r.text
    assert bff_session.SESSION_COOKIE in r.cookies and bff_session.CSRF_COOKIE in r.cookies
    db = database.SessionLocal()
    sess = db.query(models.ServerSession).one()
    assert sess.user_email == DEV and sess.id == r.cookies[bff_session.SESSION_COOKIE]
    db.close()
    assert _claim(code).status_code == 401                  # single use


def test_claim_needs_the_verifier():
    code = _code_from(_handoff())
    assert _claim(code, verifier="w" * 43).status_code == 401
    db = database.SessionLocal()
    assert db.query(models.ServerSession).count() == 0
    db.close()
    assert _claim(code).status_code == 200                  # the code alone was never enough


def test_claim_refuses_another_preview_and_late_codes():
    code = _code_from(_handoff())
    assert _claim(code, origin="https://other.greens-nexus-dev.pages.dev").status_code == 401
    code = _code_from(_handoff())
    db = database.SessionLocal()
    row = db.query(models.ExternalLoginCode).filter(models.ExternalLoginCode.consumed_at == "").one()
    row.expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    db.commit()
    db.close()
    assert _claim(code).status_code == 401


def test_claim_checks_the_grant_again():
    code = _code_from(_handoff())
    GRANTS[DEV] = {}
    try:
        assert _claim(code).status_code == 401
    finally:
        GRANTS[DEV] = {"build-mode": 2}
