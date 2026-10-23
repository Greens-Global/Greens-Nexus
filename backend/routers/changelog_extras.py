"""What's New, the second half (Oct 16 2026): following and the weekly digest,
the private RSS feed, hints on the screen an update changed, helpful votes
and feature requests, edit history, bulk actions, and reach insights (read
rate, trends, the most-reacted updates). The entries, reactions, comments
and views themselves live in routers/task_config.py; who may see an update
is changelog_reach.visible() everywhere.

Reading routes need a signed-in user only (externals reach them through the
"/task-changelog" prefix in auth._EXTERNAL_BASE_PREFIXES); managing routes
take require_level(3), like Manage's other actions. The feed is PUBLIC: a
signed link whose token is the credential (the shift calendar's pattern,
routers/shift_ical.py).
"""
import base64
import hashlib
import hmac
import json
import secrets
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional
from xml.sax.saxutils import escape

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import changelog_reach as reach
import models
import secret_box
from app_url import app_url, public_base
from auth import get_current_user, require_level
from database import get_db
from routers.task_util import gen_id, now_iso

router = APIRouter(tags=["What's New"])

_SECRET = secret_box.signing_secret("nexus-changelog-feed-DEV-ONLY-key-set-NEXUS_VAULT_KEY")
_CONTEXT = b"changelog-feed:v1:"
_SIG_LEN = 16
FEED_ITEMS = 50
HINT_DAYS = 14
TREND_WEEKS = 12


def _entries(db: Session) -> list:
    return db.query(models.TaskChangelogEntry).all()


def _entry_or_404(db: Session, entry_id: str) -> models.TaskChangelogEntry:
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    return e


# ── Me: since my last visit, what I follow, my feed ────────────────────────

def _sub(db: Session, email: str, create: bool = False):
    row = db.query(models.ChangelogSubscription).filter(models.ChangelogSubscription.email == email).first()
    if row is None and create:
        row = models.ChangelogSubscription(email=email, modules=[], categories=[], digest=False, feed_salt="")
        db.add(row)
    return row


def _sub_dict(row) -> dict:
    return {"modules": list(row.modules or []) if row else [], "categories": list(row.categories or []) if row else [],
            "digest": bool(row.digest) if row else False}


@router.get("/task-changelog/me")
def changelog_me(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """`sinceAt`: updates released after it are new since this person's last
    visit. Opening What's New stamps the visit (POST /task-changelog/seen),
    which may land before or after this read - both orders give the same
    answer, because a visit in progress (seen in the last 30 minutes) reads
    the visit before it."""
    email = (user["email"] or "").lower()
    seen = db.query(models.ChangelogSeen).filter(models.ChangelogSeen.email == email).first()
    last = (seen.last_seen_at if seen else "") or ""
    prev = (seen.prev_seen_at if seen else "") or ""
    at = reach._instant(last)
    in_visit = bool(at and datetime.now(timezone.utc) - at <= timedelta(minutes=30))
    return {"sinceAt": (prev if in_visit else last) or "", "lastSeenAt": last,
            "subscription": _sub_dict(_sub(db, email)), "admin": int(user.get("level") or 0) >= reach.ADMIN_LEVEL}


class SubscriptionBody(BaseModel):
    modules: list[str] = []
    categories: list[str] = []
    digest: bool = False


@router.put("/task-changelog/subscription")
def save_subscription(body: SubscriptionBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user["email"] or "").lower()
    row = _sub(db, email, create=True)
    row.modules = sorted({m.strip().lower() for m in body.modules if m and m.strip()})[:50]
    row.categories = sorted({c.strip().lower() for c in body.categories if c and c.strip()})[:20]
    row.digest = bool(body.digest)
    row.updated_at = now_iso()
    db.commit()
    return _sub_dict(row)


# ── Private RSS feed ───────────────────────────────────────────────────────

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_token(email: str, salt: str) -> str:
    payload = json.dumps({"e": (email or "").lower(), "s": salt}, separators=(",", ":")).encode()
    return _b64(payload + hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN])


def parse_token(token: str) -> Optional[dict]:
    try:
        raw = _unb64(token)
        payload, sig = raw[:-_SIG_LEN], raw[-_SIG_LEN:]
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
        if len(sig) != _SIG_LEN or not hmac.compare_digest(want, sig):
            return None
        data = json.loads(payload)
        return {"email": str(data["e"]), "salt": str(data["s"])}
    except Exception:  # noqa: BLE001 - any malformed token is just "not found"
        return None


def _feed_link(db: Session, email: str, rotate: bool = False) -> dict:
    row = _sub(db, email, create=True)
    if rotate or not (row.feed_salt or ""):
        row.feed_salt = secrets.token_urlsafe(12)
        row.updated_at = now_iso()
        db.commit()
    base = public_base() or "http://localhost:8000"
    return {"url": f"{base}/task-changelog-feed/{make_token(email, row.feed_salt)}.xml"}


@router.get("/task-changelog/feed-link")
def feed_link(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _feed_link(db, (user["email"] or "").lower())


@router.post("/task-changelog/feed-link/rotate")
def rotate_feed_link(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A new link; the old one stops working at once."""
    return _feed_link(db, (user["email"] or "").lower(), rotate=True)


def build_feed(db: Session, email: str) -> str:
    ctx = reach.viewer(db, {"email": email, "level": reach._level(db, email)})
    ctx["admin"] = False                      # a feed shows what everyone in their place reads
    rows = []
    for e in _entries(db):
        p = reach.payload_of(e)
        if reach.visible(p, ctx) and reach.status_of(p) == "Released" and not p.get("hidden"):
            rows.append((reach._instant(p.get("releasedAt") or e.created_at) or datetime.now(timezone.utc), e.id, p))
    rows.sort(key=lambda r: r[0], reverse=True)
    base = app_url()
    items = []
    for at, eid, p in rows[:FEED_ITEMS]:
        link = f"{base}/whats-new?entry={eid}"
        desc = p.get("description") or ""
        if p.get("actionRequired"):
            desc = f"Action required: {p['actionRequired']}\n\n{desc}"
        items.append(
            "<item>"
            f"<title>{escape(p.get('title') or 'Update')}</title>"
            f"<link>{escape(link)}</link><guid isPermaLink=\"false\">nexus-whats-new-{escape(eid)}</guid>"
            f"<category>{escape(p.get('type') or 'Update')}</category>"
            f"<pubDate>{at.strftime('%a, %d %b %Y %H:%M:%S +0000')}</pubDate>"
            f"<description>{escape(desc)}</description>"
            "</item>")
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
            "<title>What's New in Nexus</title>"
            f"<link>{escape(base)}/whats-new</link>"
            "<description>Updates, releases and changes across Nexus.</description>"
            + "".join(items) + "</channel></rss>")


@router.get("/task-changelog-feed/{token}.xml")
def changelog_feed(token: str, db: Session = Depends(get_db)):
    """PUBLIC: a feed reader's fetch. A bad or rotated link is a plain 404."""
    data = parse_token(token)
    if not data:
        return PlainTextResponse("Not found", status_code=404)
    row = _sub(db, data["email"])
    if row is None or not (row.feed_salt or "") or not hmac.compare_digest(row.feed_salt, data["salt"]):
        return PlainTextResponse("Not found", status_code=404)
    return Response(content=build_feed(db, data["email"]), media_type="application/rss+xml; charset=utf-8",
                    headers={"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
                             "Referrer-Policy": "no-referrer"})


# ── Hints on the screen an update changed ──────────────────────────────────

@router.get("/task-changelog/hints")
def changelog_hints(view: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the card on this screen says (payload.screen = a Nexus view id):
    first any open known issue or rollback and any coming removal
    (changelog_lifecycle.screen_notices, whatever their age), then updates
    released in the last 14 days, newest first. Small on purpose: it is
    asked on every screen change."""
    view = (view or "").strip()
    if not view:
        return []
    ctx = reach.viewer(db, user)
    ctx["admin"] = False
    floor = datetime.now(timezone.utc) - timedelta(days=HINT_DAYS)
    out = []
    for e in _entries(db):
        p = reach.payload_of(e)
        if p.get("screen") != view or not reach.visible(p, ctx):
            continue
        at = reach._instant(p.get("releasedAt") or e.created_at)
        if at and at > floor:
            out.append({"id": e.id, "kind": "new", "title": p.get("title") or "Update", "type": p.get("type") or "Update",
                        "releasedAt": at.isoformat(), "actionRequired": p.get("actionRequired") or "",
                        "tour": bool(p.get("tour")), "stamp": ""})
    out.sort(key=lambda r: r["releasedAt"], reverse=True)
    from routers.changelog_lifecycle import screen_notices
    return (screen_notices(db, view, ctx) + out[:3])[:6]


# ── Helpful votes and feature requests ─────────────────────────────────────

class FeedbackBody(BaseModel):
    kind: str = "helpful"                 # helpful | request
    helpful: Optional[bool] = None
    note: str = ""


def _feedback_summary(db: Session, entry_id: str, email: str) -> dict:
    rows = db.query(models.ChangelogFeedback).filter(models.ChangelogFeedback.entry_id == entry_id,
                                                     models.ChangelogFeedback.kind == "helpful").all()
    mine = next((r for r in rows if r.email == email), None)
    return {"yes": sum(1 for r in rows if r.helpful), "no": sum(1 for r in rows if not r.helpful),
            "mine": None if mine is None else bool(mine.helpful)}


@router.get("/task-changelog/{entry_id}/feedback")
def get_feedback(entry_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _feedback_summary(db, entry_id, (user["email"] or "").lower())


@router.post("/task-changelog/{entry_id}/feedback")
def give_feedback(entry_id: str, body: FeedbackBody, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db), background_tasks: BackgroundTasks = None):
    """Helpful? one vote per person (pressing the same answer again takes it
    back). A feature request needs a note and can be sent any number of times."""
    e = _entry_or_404(db, entry_id)
    email = (user["email"] or "").lower()
    if not reach.visible(reach.payload_of(e), reach.viewer(db, user)):
        raise HTTPException(404, "Changelog entry not found")
    F = models.ChangelogFeedback
    if body.kind == "request":
        note = (body.note or "").strip()
        if not note:
            raise HTTPException(400, "Say what you would like")
        # Filed as a Feature Request ticket, like every request (feature_requests.py).
        import feature_requests
        feature_requests.file_from_whats_new(db, user, background_tasks or BackgroundTasks(), note, entry_id=entry_id)
        return {"ok": True, **_feedback_summary(db, entry_id, email)}
    if body.kind != "helpful" or body.helpful is None:
        raise HTTPException(400, "Say whether it helped")
    mine = db.query(F).filter(F.entry_id == entry_id, F.email == email, F.kind == "helpful").first()
    if mine and bool(mine.helpful) == body.helpful and not (body.note or "").strip():
        db.delete(mine)
    elif mine:
        mine.helpful, mine.note, mine.created_at = int(body.helpful), (body.note or mine.note or "")[:2000], now_iso()
    else:
        db.add(F(id=gen_id(), entry_id=entry_id, email=email, kind="helpful", helpful=int(body.helpful),
                 note=(body.note or "")[:2000], created_at=now_iso()))
    db.commit()
    return _feedback_summary(db, entry_id, email)


@router.get("/task-changelog-admin/feedback")
def list_feedback(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Every note and feature request, newest first, for Manage - requests
    with their status (changelog_lifecycle)."""
    from routers.changelog_lifecycle import request_dict, with_tickets
    titles = {e.id: (reach.payload_of(e).get("title") or "Update", reach.status_of(reach.payload_of(e)) == "Released")
              for e in _entries(db)}
    rows = (db.query(models.ChangelogFeedback).order_by(models.ChangelogFeedback.created_at.desc()).all())
    out = []
    for r in rows:
        if r.kind == "request":
            gone = "(deleted update)" if r.entry_id else ""
            out.append({**request_dict(r, titles), "kind": "request", "helpful": True,
                        "entryTitle": titles[r.entry_id][0] if r.entry_id in titles else gone})
        elif (r.note or "").strip():
            out.append({"id": r.id, "entryId": r.entry_id, "entryTitle": titles.get(r.entry_id, ("(deleted update)",))[0],
                        "email": r.email, "kind": r.kind, "helpful": bool(r.helpful), "note": r.note or "", "at": r.created_at})
    return with_tickets(db, out)


# ── Edit history ───────────────────────────────────────────────────────────

@router.get("/task-changelog/{entry_id}/history")
def entry_history(entry_id: str, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    rows = (db.query(models.ChangelogEntryHistory).filter(models.ChangelogEntryHistory.entry_id == entry_id)
            .order_by(models.ChangelogEntryHistory.at.desc()).all())
    return [{"id": r.id, "at": r.at, "by": r.by_email, "action": r.action, "changes": r.changes or {}} for r in rows]


# ── Bulk actions ───────────────────────────────────────────────────────────

class BulkBody(BaseModel):
    ids: list[str]
    action: str                 # hide | show | pin | unpin | delete | publish | category | module
    value: Optional[str] = None


BULK_ACTIONS = ("hide", "show", "pin", "unpin", "delete", "publish", "category", "module")


@router.post("/task-changelog-admin/bulk")
def bulk_action(body: BulkBody, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    from routers import task_config
    if body.action not in BULK_ACTIONS:
        raise HTTPException(400, "Unknown action")
    if body.action in ("category", "module") and not (body.value or "").strip():
        raise HTTPException(400, "Pick a value")
    ids = list(dict.fromkeys(i for i in body.ids if i))[:500]
    rows = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id.in_(ids)).all()
    me = (user["email"] or "").lower()
    if body.action == "delete":
        for e in rows:
            task_config.delete_changelog(e.id, db)
        return {"done": len(rows), "deleted": [e.id for e in rows]}
    released = []
    for e in rows:
        before = dict(reach.payload_of(e))
        if body.action == "publish":
            task_config._publish(e, me, db)
            released.append(e)
            continue
        p = dict(before)
        if body.action in ("hide", "show"):
            p["hidden"] = body.action == "hide"
        elif body.action in ("pin", "unpin"):
            p["pinned"] = body.action == "pin"
            p["pinnedAt"] = now_iso() if p["pinned"] else ""
        elif body.action == "category":
            p["type"] = body.value.strip()
        elif body.action == "module":
            p["module"] = body.value.strip()
        e.payload = p
        e.updated_at = now_iso()
        action = {"hide": "hidden", "show": "shown", "pin": "pinned", "unpin": "unpinned"}.get(body.action, "edit")
        reach.record_history(db, e.id, me, action, reach.diff(before, p))
    db.commit()
    if released:
        reach.on_released(db, released)
    return {"done": len(rows), "entries": [task_config.changelog_entry_to_dict(e) for e in rows]}


# ── Audience choices, and reach insights ───────────────────────────────────

@router.get("/task-changelog-admin/audience-options")
def audience_options(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """The companies an update can be aimed at (modules come from the screen's
    own module list)."""
    return {"companies": [{"id": h.id, "name": h.name or h.id}
                          for h in db.query(models.HrEntity).order_by(models.HrEntity.name).all()]}


def _week_start(at: datetime) -> str:
    d = at.astimezone(timezone.utc).date()
    return (d - timedelta(days=d.weekday())).isoformat()


@router.get("/task-changelog-admin/insights")
def insights(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Read rate per update (people who saw it / people it is for), weekly
    trends for the last 12 weeks, the most-reacted updates and the helpful
    votes."""
    pop = reach.population(db)
    viewers: dict = {}
    tours: Counter = Counter()
    for v in db.query(models.ChangelogEntryView).all():
        viewers.setdefault(v.entry_id, set()).add(v.email)
        if v.tour_done_at:
            tours[v.entry_id] += 1
    reactions = Counter(r.entry_id for r in db.query(models.ChangelogReaction).all())
    helpful: dict = {}
    for f in db.query(models.ChangelogFeedback).filter(models.ChangelogFeedback.kind == "helpful").all():
        h = helpful.setdefault(f.entry_id, {"yes": 0, "no": 0})
        h["yes" if f.helpful else "no"] += 1
    requests = Counter(f.entry_id for f in db.query(models.ChangelogFeedback)
                       .filter(models.ChangelogFeedback.kind == "request").all())

    per, released = {}, []
    for e in _entries(db):
        p = reach.payload_of(e)
        if reach.status_of(p) != "Released":
            continue
        aud = reach.audience_of(p, pop)
        seen = viewers.get(e.id, set())
        reached = len(seen & aud) if aud else 0
        per[e.id] = {"audience": len(aud), "reached": reached,
                     "readRate": round(100 * reached / len(aud)) if aud else None,
                     "helpful": helpful.get(e.id, {"yes": 0, "no": 0}), "requests": requests.get(e.id, 0),
                     "toursDone": tours.get(e.id, 0)}
        released.append((e, p))

    # Weekly trends (Monday weeks, UTC), the last 12 including this one.
    now = datetime.now(timezone.utc)
    weeks = [_week_start(now - timedelta(weeks=i)) for i in range(TREND_WEEKS - 1, -1, -1)]
    series = {w: {"week": w, "published": 0, "views": 0, "reactions": 0, "comments": 0} for w in weeks}

    def bump(at, key, n=1):
        if at and (w := _week_start(at)) in series:
            series[w][key] += n

    for e, p in released:
        bump(reach._instant(p.get("releasedAt") or e.created_at), "published")
    for v in db.query(models.ChangelogEntryView).all():
        bump(reach._instant(v.first_at), "views", v.views or 1)
    for r in db.query(models.ChangelogReaction).all():
        bump(reach._instant(r.created_at), "reactions")
    for c in db.query(models.TaskChangelogComment).all():
        bump(reach._instant(c.created_at), "comments")

    top = sorted(((reactions.get(e.id, 0), e.id, p.get("title") or "Update", p.get("type") or "Update")
                  for e, p in released if reactions.get(e.id)), reverse=True)[:5]
    rates = [s["readRate"] for s in per.values() if s["readRate"] is not None]
    votes_yes = sum(h["yes"] for h in helpful.values())
    votes_no = sum(h["no"] for h in helpful.values())
    return {
        "entries": per,
        "trends": [series[w] for w in weeks],
        "topReacted": [{"id": i, "title": t, "type": ty, "reactions": n} for n, i, t, ty in top],
        "averageReadRate": round(sum(rates) / len(rates)) if rates else None,
        "population": len(pop["people"]),
        "helpful": {"yes": votes_yes, "no": votes_no,
                    "rate": round(100 * votes_yes / (votes_yes + votes_no)) if votes_yes + votes_no else None},
    }
