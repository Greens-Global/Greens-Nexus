"""Kudos on Teams, both ways (Neil, 11/12/2026: "see if we can make it two
way meaning if someone reacts to it it should show on nexus too"; a channel
per company, Teams reactions count as Nexus thanks, a clap goes back, and
change notifications AND polling together).

OUT (perf_feedback.queue_teams_post / deliver_teams): a kudos is posted as
its sender into the company's channel (or group chat) from Settings >
Performance > Kudos on Teams, @mentioning the recipient, and the post's
message id is kept on the kudos (`teams_message_id`, `teams_post`).

BACK (this module): a Teams reaction or a channel-thread reply from a Nexus
colleague of the kudos' company IS that person's thanks - the same
`perf_kudos_thanks` row the Nexus button writes (`via='teams'`, the
emoji in `teams_reaction`, a reply's text as the note), so the recipient's
one bell grows in place and the recipient's own reaction is their Say Thanks.
A reaction taken off in Teams takes that thanks back (never the recipient's
reply - it stays, as in Nexus). The sender's own reactions are not thanks.
Reactors who are not colleagues there are counted only (`others`).

AND OUT AGAIN: a thanks added in Nexus puts a clap on the post as that
person (and, in a channel, its note as their reply in the thread); a Take
Back takes the clap off. Both ride the ticket Teams queue (kinds
`kudos_react` / `kudos_unreact`, `deliver_reaction`) - the one Teams queue.

HOW IT HEARS: Graph change notifications on each target's messages
(`teams_subscriptions`, delegated, renewed before the hour is out) mark a
kudos due at once (`/webhooks/teams/kudos`, routers/teams_webhook.py), and
the leader-only `kudos_teams_loop` reads due kudos every minute - the same
read for both, so polling is the backstop when a notification is lost or the
subscription could not be made: every 5 minutes for a day, 30 for a week,
3 hours to 30 days, then never.

NO LOOPS: the unique (kudos, person) key makes a mirrored change a no-op the
second time; a Nexus Take Back leaves a tombstone (`ignore`: person -> when)
so a reaction or reply made before it is not read back in, and a mirror
written after a read began (`touched`) is left alone by that read.

Reading needs the delegated read scopes (bff_session.GRAPH_KUDOS_*_READ_SCOPES,
admin consent for the channel one); until they are granted the read quietly
does nothing and the posts still go out. Blocking work only - every caller is
off the event loop (the loop uses to_thread, routes run in the threadpool).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html as html_lib
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

import job_switch
import models

GRAPH = "https://graph.microsoft.com/v1.0"
REACTION = "\U0001F44F"          # the clap a Nexus thanks puts on the post (Neil, 11/12/2026)
JOB_KEY = "kudos_teams"
SYNC_DAYS = 30                   # a post is read back for this long
SUB_LIFETIME_MIN = 55            # under Graph's hour, so no lifecycle URL is needed
SUB_RENEW_WITHIN_MIN = 20
SUB_RETRY_MIN = 15               # a target whose subscription could not be made waits this long
ERROR_RETRY_MIN = 15
WEBHOOK_PATH = "/webhooks/teams/kudos"
SKIPPED_TAKEN_BACK = "skipped: thanks taken back"
SKIPPED_NO_POST = "skipped: kudos has no Teams post"
# Teams' older reaction names, drawn as the emoji people saw.
LEGACY_EMOJI = {"like": "\U0001F44D", "heart": "❤️", "laugh": "\U0001F606",
                "surprised": "\U0001F62E", "sad": "\U0001F622", "angry": "\U0001F621"}


def _low(s) -> str:
    return (s or "").strip().lower()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat()


def emoji(reaction: str) -> str:
    """A stored reaction as people see it."""
    r = (reaction or "").strip()
    return LEGACY_EMOJI.get(r.lower(), r)


def post_of(k: models.PerfKudos) -> dict:
    return dict(k.teams_post or {}) if isinstance(k.teams_post, dict) else {}


def _set_post(k: models.PerfKudos, **changes) -> dict:
    tp = post_of(k)
    tp.update(changes)
    k.teams_post = tp   # a new dict: the JSON column only notices reassignment
    return tp


def target_key(tp: dict) -> str:
    if tp.get("type") == "channel":
        return f"channel:{tp.get('teamId', '')}:{tp.get('convId', '')}"
    return f"chat:{tp.get('convId', '')}"


def read_scopes(kind: str) -> str:
    import bff_session
    return bff_session.GRAPH_KUDOS_CHANNEL_READ_SCOPES if kind == "channel" else bff_session.GRAPH_KUDOS_CHAT_READ_SCOPES


def send_scopes(kind: str) -> str:
    import bff_session
    return bff_session.GRAPH_CHANNEL_SCOPES if kind == "channel" else bff_session.GRAPH_CHAT_SCOPES


def due_after(created_at: str, now: Optional[datetime] = None) -> str:
    """When a kudos post is next read back: 5 minutes while it is a day old,
    30 for a week, 3 hours to 30 days, then '' (never again)."""
    now = now or _now()
    try:
        made = datetime.fromisoformat((created_at or "").replace("Z", "+00:00"))
        if made.tzinfo is None:
            made = made.replace(tzinfo=timezone.utc)
    except ValueError:
        made = now
    age = now - made
    if age < timedelta(days=1):
        return _iso(now + timedelta(minutes=5))
    if age < timedelta(days=7):
        return _iso(now + timedelta(minutes=30))
    if age < timedelta(days=SYNC_DAYS):
        return _iso(now + timedelta(hours=3))
    return ""


# ── Tokens ───────────────────────────────────────────────────────────────────
# A delegated token lives about an hour; minting one is a refresh-token round
# trip that also rotates the session's refresh token. Kept per process for 40
# minutes, and a failure (no session, consent not granted) is not retried for
# 15, so a tenant without consent costs one refresh per person per quarter hour.

_tok_cache: dict = {}
_TOK_OK_SEC = 40 * 60
_TOK_FAIL_SEC = 15 * 60


def token_for(db: Session, email: str, scopes: str) -> str:
    import bff_session
    key = (_low(email), scopes)
    hit = _tok_cache.get(key)
    if hit and hit[1] > time.monotonic():
        return hit[0]
    tok = bff_session.graph_token_for_email(db, _low(email), scopes) if email else ""
    _tok_cache[key] = (tok, time.monotonic() + (_TOK_OK_SEC if tok else _TOK_FAIL_SEC))
    return tok


def _env_posters() -> list:
    from feature_requests import _env_posters as env
    return env()


def readers(k: models.PerfKudos) -> list:
    """Who may read the post back, in order: whoever posted it, the sender,
    the fallback posters, the recipient - each must be in the channel."""
    tp = post_of(k)
    out = [tp.get("poster", ""), k.from_email, *_env_posters(), k.to_email]
    return [e for e in dict.fromkeys(_low(x) for x in out) if e]


def _first_token(db: Session, emails: list, scopes: str):
    for who in emails:
        tok = token_for(db, who, scopes)
        if tok:
            return who, tok
    return "", ""


# ── Graph reads ──────────────────────────────────────────────────────────────

def _get(tok: str, url: str, params: Optional[dict] = None) -> dict:
    r = httpx.get(url if url.startswith("http") else f"{GRAPH}{url}",
                  headers={"Authorization": f"Bearer {tok}"}, params=params, timeout=15)
    if r.status_code >= 400:
        raise GraphError(r.status_code, r.text[:180])
    try:
        v = r.json()
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


class GraphError(RuntimeError):
    def __init__(self, status: int, text: str):
        super().__init__(f"Graph {status}: {text}")
        self.status = status


def email_for_id(db: Session, tok: str, aad_id: str) -> str:
    """The work email behind an Entra user id: the person the M365 sync
    linked to it, else looked up once through Graph and kept (TeamsUserMap). '' for someone Graph will not name (a guest elsewhere) -
    asked again after a week."""
    if not aad_id:
        return ""
    E = models.NexusEmployee
    emp = db.query(E.work_email).filter(E.m365_id == aad_id).first()   # linked by the M365 sync
    if emp is not None and emp[0]:
        return _low(emp[0])
    M = models.TeamsUserMap
    row = db.get(M, aad_id)
    week_ago = _iso(_now() - timedelta(days=7))
    if row is not None and (row.email or (row.updated_at or "") > week_ago):
        return row.email or ""
    email, name = "", ""
    try:
        u = _get(tok, f"/users/{aad_id}", {"$select": "id,mail,userPrincipalName,displayName"})
        email = _low(u.get("mail") or u.get("userPrincipalName"))
        name = (u.get("displayName") or "")[:120]
    except GraphError as e:
        if e.status not in (403, 404):
            raise
    if row is None:
        row = M(aad_id=aad_id)
        db.add(row)
    row.email, row.display_name, row.updated_at = email, name, _iso(_now())
    db.commit()
    return email


def id_for_email(db: Session, tok: str, email: str) -> str:
    """The Entra user id for a work email (a mention needs it); '' when Graph
    does not know them."""
    email = _low(email)
    if not email:
        return ""
    E = models.NexusEmployee
    emp = db.query(E.m365_id).filter(func.lower(E.work_email) == email, E.m365_id != "").first()   # the M365 sync's link
    if emp is not None:
        return emp[0]
    M = models.TeamsUserMap
    row = db.query(M).filter(M.email == email).first()
    if row is not None:
        return row.aad_id
    if not tok:
        return ""
    try:
        u = _get(tok, f"/users/{email}", {"$select": "id,mail,userPrincipalName,displayName"})
    except GraphError:
        return ""
    aad = u.get("id") or ""
    if aad:
        row = db.get(M, aad) or M(aad_id=aad)
        row.email, row.display_name, row.updated_at = email, (u.get("displayName") or "")[:120], _iso(_now())
        db.merge(row)
        db.commit()
    return aad


_SIG = re.compile(r"<p[^>]*data-nexus-sig[^>]*>.*?</p>", re.S | re.I)


def reply_text(body_html: str) -> str:
    """A thread reply's words, without Nexus's own signature line."""
    from feature_requests import html_to_text
    text = html_to_text(_SIG.sub("", body_html or ""))
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def fetch(db: Session, k: models.PerfKudos) -> dict:
    """Read the post back: its reactions and (in a channel) its thread
    replies, with every person's email. Raises GraphError / RuntimeError
    when nobody can read it. `gone` = the post itself was deleted."""
    import teams_post
    tp = post_of(k)
    kind = tp.get("type") or "chat"
    who, tok = _first_token(db, readers(k), read_scopes(kind))
    if not tok:
        raise RuntimeError("nobody with a Teams read session (sign-in or admin consent missing)")
    started = _iso(_now())
    path = teams_post.message_path(kind, tp.get("teamId", ""), tp.get("convId", ""), k.teams_message_id)
    try:
        msg = _get(tok, path)
    except GraphError as e:
        if e.status == 404:
            return {"gone": True, "fetchedAt": started, "reader": who}
        raise
    if msg.get("deletedDateTime"):
        return {"gone": True, "fetchedAt": started, "reader": who}
    reactions = []
    for r in msg.get("reactions") or []:
        uid = (((r.get("user") or {}).get("user") or {}).get("id")) or ""
        if uid:
            reactions.append({"aad": uid, "type": str(r.get("reactionType") or "")[:40],
                              "at": r.get("createdDateTime") or ""})
    replies = None
    if kind == "channel":
        replies, url, pages = [], f"{path}/replies", 0
        params = {"$top": "50"}
        while url and pages < 10:
            page = _get(tok, url, params)
            for rep in page.get("value") or []:
                uid = (((rep.get("from") or {}).get("user") or {}).get("id")) or ""
                if uid and not rep.get("deletedDateTime"):
                    replies.append({"id": rep.get("id") or "", "aad": uid, "at": rep.get("createdDateTime") or "",
                                    "text": reply_text((rep.get("body") or {}).get("content") or "")})
            url, params, pages = page.get("@odata.nextLink") or "", None, pages + 1
    emails = {}
    for uid in {x["aad"] for x in reactions} | {x["aad"] for x in (replies or [])}:
        emails[uid] = email_for_id(db, tok, uid)
    return {"gone": False, "fetchedAt": started, "reader": who, "reactions": reactions,
            "replies": replies, "emails": emails}


# ── Reconcile ────────────────────────────────────────────────────────────────

def _thanker(db: Session, k: models.PerfKudos, email: str) -> bool:
    """A Nexus colleague of the kudos' company - whose reaction is a thanks."""
    from perf_feedback import colleague
    emp = colleague(db, email)
    return emp is not None and (emp.company or "") == (k.company_id or "")


def apply(db: Session, k: models.PerfKudos, state: dict) -> dict:
    """Bring the kudos' thanks in line with what the post shows. The caller
    holds the kudos row lock and commits. Returns what changed."""
    import perf_feedback as pf
    import performance as perf
    T = models.PerfKudosThanks
    out = {"added": 0, "removed": 0, "updated": 0}
    if state.get("gone"):
        return out
    tp = post_of(k)
    sender, to = _low(k.from_email), _low(k.to_email)
    ignore, touched = tp.get("ignore") or {}, tp.get("touched") or {}
    fetched_at = state.get("fetchedAt") or ""
    emails = state.get("emails") or {}

    def skip(email: str, at: str) -> bool:
        ts = ignore.get(email)
        return bool(ts) and (not at or at <= ts)

    people: dict = {}
    others = set()
    for r in state.get("reactions") or []:
        email = _low(emails.get(r["aad"]))
        if email == sender:
            continue
        if not email or not _thanker(db, k, email):
            others.add(r["aad"])
            continue
        if not skip(email, r["at"]):
            people.setdefault(email, {}).setdefault("reaction", r["type"])
    replies = state.get("replies")
    for rep in replies or []:
        email = _low(emails.get(rep["aad"]))
        if not email or email == sender or not _thanker(db, k, email) or skip(email, rep["at"]):
            continue
        people.setdefault(email, {}).setdefault("reply", rep)

    rows = {_low(t.from_email): t for t in db.query(T).filter(T.kudos_id == k.id).all()}
    grew = False
    for email, got in people.items():
        if touched.get(email, "") >= fetched_at and fetched_at:
            continue   # Nexus mirrored a change for them after this read began
        rep = got.get("reply")
        t = rows.get(email)
        if t is None:
            t = T(id=perf.new_id(), kudos_id=k.id, from_email=email, created_at=perf.now_iso(), via="teams",
                  note=(rep["text"] if rep else "")[:pf.THANKS_NOTE_MAX], teams_reaction=got.get("reaction", ""),
                  teams_reply_id=rep["id"] if rep else "")
            db.add(t)
            db.flush()
            rows[email] = t
            out["added"] += 1
            if email == to:
                pf.recipient_said_thanks(db, k, t)
            else:
                grew = True
            continue
        changed = False
        if got.get("reaction") and t.teams_reaction != got["reaction"]:
            t.teams_reaction, changed = got["reaction"], True
        if not got.get("reaction") and t.teams_reaction and replies is not None and rep:
            t.teams_reaction, changed = "", True   # the clap is off, the reply keeps it
        if rep and not (t.note or "").strip():
            t.note, t.teams_reply_id, changed = rep["text"][:pf.THANKS_NOTE_MAX], rep["id"], True
        out["updated"] += int(changed)
    for email, t in list(rows.items()):
        if email == to or email in people:
            continue
        if fetched_at and touched.get(email, "") >= fetched_at:
            continue
        if fetched_at and (t.created_at or "") >= fetched_at:
            continue   # added in Nexus while this read was out
        from_teams = (t.via or "") == "teams" or bool(t.teams_reaction) or (bool(t.teams_reply_id) and replies is not None)
        if from_teams:
            db.delete(t)
            out["removed"] += 1
    if out["added"] or out["removed"]:
        db.flush()
        if grew or out["removed"]:
            pf.recount_bell(db, k, grew=grew)
    _set_post(k, others=len(others), error="")
    return out


def sync_one(kid: str) -> dict:
    """Read one kudos post back and apply it, on its own session. The Graph
    reads happen BEFORE the row lock (minting a token commits); the apply
    holds the kudos row lock, as the thanks routes do."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        k = db.get(models.PerfKudos, kid)
        if k is None or k.hidden_at or not k.teams_message_id:
            return {"skipped": True}
        try:
            state = fetch(db, k)
        except Exception as e:   # noqa: BLE001 - recorded on the kudos, tried again later
            k = db.get(models.PerfKudos, kid)
            _set_post(k, error=str(e)[:200])
            k.teams_sync_due_at = _iso(_now() + timedelta(minutes=ERROR_RETRY_MIN)) if due_after(k.created_at) else ""
            db.commit()
            return {"error": str(e)[:200]}
        k = (db.query(models.PerfKudos).filter(models.PerfKudos.id == kid)
             .with_for_update().populate_existing().first())
        if k is None or k.hidden_at:
            db.rollback()
            return {"skipped": True}
        out = apply(db, k, state)
        k.teams_synced_at = _iso(_now())
        k.teams_sync_due_at = "" if state.get("gone") else due_after(k.created_at)
        db.commit()
        return out
    finally:
        db.close()


def sync_due(limit: int = 20) -> int:
    """Read back every kudos whose turn has come (a notification marked it,
    or its polling time passed)."""
    from database import SessionLocal
    K = models.PerfKudos
    db = SessionLocal()
    try:
        now = _iso(_now())
        ids = [r[0] for r in (db.query(K.id)
               .filter(K.teams_message_id != "", K.hidden_at == "", K.teams_sync_due_at != "",
                       K.teams_sync_due_at <= now)
               .order_by(K.teams_sync_due_at.asc()).limit(limit).all())]
    finally:
        db.close()
    for kid in ids:
        sync_one(kid)
    return len(ids)


# ── Nexus -> Teams: the clap ─────────────────────────────────────────────────

def _queue(db: Session, k: models.PerfKudos, email: str, kind: str, reaction: str):
    from routers.task_util import gen_id
    import performance as perf
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=k.id, agent_email=_low(email), requester_email=_low(email),
                                    html=reaction, chat_id=post_of(k).get("convId", ""), created_at=perf.now_iso(),
                                    kind=kind)
    db.add(row)
    return row


def mirror_thanks(db: Session, k: models.PerfKudos, t: models.PerfKudosThanks):
    """A thanks added in Nexus: queue the clap (and, in a channel, the note
    as their reply). None when the kudos has no post or the thanks came from
    Teams already."""
    if not k.teams_message_id or (t.via or "") == "teams" or t.teams_reaction:
        return None
    return _queue(db, k, t.from_email, "kudos_react", REACTION)


def mirror_take_back(db: Session, k: models.PerfKudos, taken: dict):
    """A thanks taken back in Nexus: a clap still waiting is never sent; one
    on the post is taken off; the tombstone keeps what they did in Teams
    before now from coming back in. Returns the queued row, or None."""
    if not k.teams_message_id:
        return None
    import performance as perf
    email = _low(taken.get("email"))
    M = models.TicketTeamsMessage
    for row in db.query(M).filter(M.kind == "kudos_react", M.ticket_id == k.id, M.agent_email == email, M.sent == 0).all():
        row.sent, row.send_error = 1, SKIPPED_TAKEN_BACK
    tp = post_of(k)
    _set_post(k, ignore={**(tp.get("ignore") or {}), email: perf.now_iso()})
    if taken.get("reaction"):
        return _queue(db, k, email, "kudos_unreact", taken["reaction"])
    return None


def deliver_reaction(db: Session, row) -> bool:
    """One delivery attempt for a claimed kudos_react / kudos_unreact row
    (teams_post.deliver_ticket_row), as the person themselves. Commits."""
    import teams_post
    T = models.PerfKudosThanks
    on = (row.kind or "") == "kudos_react"
    who = _low(row.agent_email)
    k = db.get(models.PerfKudos, row.ticket_id)
    if k is None or not k.teams_message_id:
        row.sent, row.send_error = 1, SKIPPED_NO_POST
        db.commit()
        return False
    if on and db.query(T).filter(T.kudos_id == k.id, T.from_email == who).first() is None:
        row.sent, row.send_error = 1, SKIPPED_TAKEN_BACK
        db.commit()
        return False
    tp = post_of(k)
    kind = tp.get("type") or "chat"
    try:
        tok = token_for(db, who, send_scopes(kind))
        if not tok:
            raise RuntimeError("no usable Teams session for them (signed out everywhere, or consent missing)")
        path = teams_post.message_path(kind, tp.get("teamId", ""), tp.get("convId", ""), k.teams_message_id)
        try:
            teams_post.set_reaction(tok, path, row.html or REACTION, on=on)
        except RuntimeError as e:
            if on or "404" not in str(e):
                raise   # taking off a clap that is already gone is done
        reply_id = ""
        t = db.query(T).filter(T.kudos_id == k.id, T.from_email == who).first()
        if on and t is not None and kind == "channel" and (t.note or "").strip() and not t.teams_reply_id:
            rep = teams_post.send_channel_reply(tok, tp.get("teamId", ""), tp.get("convId", ""), k.teams_message_id,
                                                f"<p>{html_lib.escape(t.note.strip())}</p>")
            reply_id = rep.get("id") or ""
    except Exception as e:   # noqa: BLE001 - kept on the row; the sweep tries again
        row.send_error = str(e)[:300]
        db.commit()
        return False
    import performance as perf
    k = (db.query(models.PerfKudos).filter(models.PerfKudos.id == k.id)
         .with_for_update().populate_existing().first())
    t = db.query(T).filter(T.kudos_id == k.id, T.from_email == who).first()
    if on and t is not None:
        t.teams_reaction = row.html or REACTION
        if reply_id:
            t.teams_reply_id = reply_id
    tp = post_of(k)
    _set_post(k, touched={**(tp.get("touched") or {}), who: perf.now_iso()})
    row.sent, row.send_error = 1, ""
    db.commit()
    return True


# ── Change notifications ─────────────────────────────────────────────────────

def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode()).hexdigest()


def notification_url() -> str:
    """The public https address Graph calls; '' when there is none (a
    laptop), and then only the polling runs."""
    import app_url
    base = app_url.public_base()
    return f"{base}{WEBHOOK_PATH}" if base.startswith("https://") else ""


def _resource(tp: dict) -> str:
    if tp.get("type") == "channel":
        return f"/teams/{tp.get('teamId', '')}/channels/{tp.get('convId', '')}/messages"
    return f"/chats/{tp.get('convId', '')}/messages"


_create_wait: dict = {}   # target key -> monotonic time before which no new subscription is tried


def _graph_write(method: str, tok: str, url: str, body: Optional[dict] = None) -> dict:
    r = httpx.request(method, f"{GRAPH}{url}", headers={"Authorization": f"Bearer {tok}",
                                                        "Content-Type": "application/json"},
                      json=body, timeout=20)
    if r.status_code >= 400:
        raise GraphError(r.status_code, r.text[:180])
    try:
        v = r.json()
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def ensure_subscriptions() -> dict:
    """One live subscription per channel or chat that has a kudos post still
    being read back: renewed when under 20 minutes are left, made again with
    the next reader when renewal fails, dropped when the target has no live
    post. Nothing without a public https address."""
    from database import SessionLocal
    url = notification_url()
    out = {"made": 0, "renewed": 0, "dropped": 0}
    if not url:
        return out
    K, S = models.PerfKudos, models.TeamsSubscription
    db = SessionLocal()
    try:
        now = _now()
        since = _iso(now - timedelta(days=SYNC_DAYS))
        targets: dict = {}
        for k in (db.query(K).filter(K.teams_message_id != "", K.hidden_at == "", K.created_at >= since)
                  .order_by(K.created_at.desc()).limit(500).all()):
            tp = post_of(k)
            if not tp.get("convId"):
                continue
            key = target_key(tp)
            entry = targets.setdefault(key, {"tp": tp, "who": []})
            entry["who"].extend(readers(k))
        subs = {s.target_key: s for s in db.query(S).filter(S.purpose == "kudos").all()}
        for key, s in list(subs.items()):
            if key in targets:
                continue
            tok = token_for(db, s.owner_email, read_scopes("channel" if key.startswith("channel:") else "chat"))
            if tok:
                try:
                    _graph_write("DELETE", tok, f"/subscriptions/{s.id}")
                except GraphError:
                    pass   # it lapses within the hour anyway
            db.delete(s)
            db.commit()
            out["dropped"] += 1
        expiry = _iso(now + timedelta(minutes=SUB_LIFETIME_MIN))
        for key, entry in targets.items():
            tp = entry["tp"]
            kind = tp.get("type") or "chat"
            s = subs.get(key)
            if s is not None and (s.expires_at or "") > _iso(now + timedelta(minutes=SUB_RENEW_WITHIN_MIN)):
                continue
            if s is not None:
                tok = token_for(db, s.owner_email, read_scopes(kind))
                try:
                    if not tok:
                        raise RuntimeError("owner has no read session")
                    _graph_write("PATCH", tok, f"/subscriptions/{s.id}", {"expirationDateTime": expiry})
                    s.expires_at, s.updated_at = expiry, _iso(now)
                    db.commit()
                    out["renewed"] += 1
                    continue
                except Exception:   # noqa: BLE001 - made again below
                    db.delete(s)
                    db.commit()
            if _create_wait.get(key, 0) > time.monotonic():
                continue
            secret = secrets.token_urlsafe(32)
            made = None
            for who in dict.fromkeys(entry["who"]):
                tok = token_for(db, who, read_scopes(kind))
                if not tok:
                    continue
                try:
                    made = _graph_write("POST", tok, "/subscriptions", {
                        "changeType": "created,updated,deleted", "notificationUrl": url,
                        "resource": _resource(tp), "expirationDateTime": expiry,
                        "clientState": secret, "includeResourceData": False})
                except GraphError as e:
                    print(f"[kudos-teams] subscription for {key} as {who} refused: {e}")
                    continue
                if made.get("id"):
                    db.add(S(id=made["id"], purpose="kudos", target_key=key, resource=_resource(tp), owner_email=who,
                             client_state_hash=_hash(secret), expires_at=made.get("expirationDateTime") or expiry,
                             created_at=_iso(now), updated_at=_iso(now)))
                    db.commit()
                    out["made"] += 1
                    break
            if not (made and made.get("id")):
                _create_wait[key] = time.monotonic() + SUB_RETRY_MIN * 60
    finally:
        db.close()
    return out


_MSG = re.compile(r"messages\('([^']+)'\)|messages/([^/?']+)")


def note_notifications(items: list) -> list:
    """Graph's notifications: each one whose subscription and clientState are
    ours marks the kudos post it is about due now. Returns the kudos ids.
    Never trusts a notification for more than "read this post again"."""
    from database import SessionLocal
    if not isinstance(items, list):
        return []
    K, S = models.PerfKudos, models.TeamsSubscription
    db = SessionLocal()
    found = []
    try:
        for it in items[:100]:
            if not isinstance(it, dict):
                continue
            s = db.get(S, str(it.get("subscriptionId") or ""))
            if s is None or not hmac.compare_digest(_hash(str(it.get("clientState") or "")), s.client_state_hash or ""):
                continue
            resource = str(it.get("resource") or "")
            m = _MSG.search(resource)
            mid = (m.group(1) or m.group(2)) if m else ""
            if not mid:
                continue
            for k in db.query(K).filter(K.teams_message_id == mid, K.hidden_at == "").all():
                if target_key(post_of(k)) != s.target_key:
                    continue   # the same message id in another conversation
                k.teams_sync_due_at = _iso(_now())
                found.append(k.id)
        db.commit()
    finally:
        db.close()
    return list(dict.fromkeys(found))


# ── The loop ─────────────────────────────────────────────────────────────────

def tick() -> dict:
    if job_switch.off(JOB_KEY):   # Workflows > Automations switch
        return {}
    out = {}
    try:
        out["subscriptions"] = ensure_subscriptions()
    except Exception as e:   # noqa: BLE001 - the reads below still run
        print(f"[kudos-teams] subscriptions failed: {e}")
    out["synced"] = sync_due()
    return out


async def kudos_teams_loop():
    """Leader-gated (main.py). Every minute; all blocking work in a thread
    (CLAUDE.md: never block the event loop)."""
    while True:
        try:
            out = await asyncio.to_thread(tick)
            if out.get("synced") or any((out.get("subscriptions") or {}).values()):
                print(f"[kudos-teams] {out}")
        except Exception as e:
            print(f"[kudos-teams] tick failed: {e}")
        await asyncio.sleep(60)
