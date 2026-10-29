"""Help Center (Oct 2026): Ask Nexus, the failed-search record, Was This
Helpful? and Known Issues.

  POST /help-center/ask           Ask Nexus - one answer from the written Nexus
                                  guide and the Knowledge Base, with sources.
                                  DOCS ONLY: it never reads tickets, HR records
                                  or anything about the asker (the full AI
                                  Assistant stays hidden - Neil, Sep 21 2026).
  POST /help-center/search-log    A Help search that found nothing, an answer
                                  the sources did not cover, or "searched, then
                                  filed a ticket" - into kb_search_log with its
                                  source, so Knowledge Base > Manage > Health
                                  lists it beside the Knowledge Base's own.
  POST /help-center/feedback      Was This Helpful? - one vote per person per
                                  guide article / answer, changed in place.
  GET  /help-center/signals       Help Signals (administrators): the No votes,
                                  the failed help searches, searched-then-
                                  ticketed.
  GET  /help-center/known-issues  What is broken right now (everyone); an
  PUT  /help-center/known-issues  administrator posts, edits and clears them.

The guide (docsContent.js) lives in the browser, so the CLIENT picks the guide
sections for a question with its own search and the reader's role filter
(docsAccess) and sends them; they are capped and stripped here. The Knowledge
Base pages are picked HERE from the pages the caller may read (the same
`_published` wall as /kb/ask), so an unpublished or walled page never reaches
the model.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import kb_ai
import kb_blocks
import kb_search
import models
from auth import get_current_user, require_administrator
from database import get_db

router = APIRouter(prefix="/help-center", tags=["Help Center"], dependencies=[Depends(get_current_user)])

GUIDE_SECTIONS_MAX = 6
GUIDE_TEXT_MAX = 4000
KB_PAGES_MAX = 4
QUESTION_MAX = 1000

# Ask Nexus costs a model call, so each person gets this many an hour - in
# this worker (the in-process pattern of the request limiter). Plenty for a
# person; a stop for a stuck loop or a script.
ASKS_PER_HOUR = 20
_asks: dict[str, deque] = {}
_asks_lock = threading.Lock()

KNOWN_ISSUES_KEY = "help_known_issues"
KNOWN_ISSUES_MAX = 10
SEVERITIES = ("info", "warning", "outage")
# "Until" is a calendar day; it ends at the end of that day for the company.
COMPANY_ZONE = ZoneInfo("America/Los_Angeles")

SEARCH_SOURCES = ("help", "ticket-form", "ask")
HELP_SOURCES = SEARCH_SOURCES


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_rate_limit() -> None:
    """Test seam."""
    with _asks_lock:
        _asks.clear()


def _take_ask(email: str) -> bool:
    """One ask for this person, if they have one left this hour."""
    now = time.monotonic()
    with _asks_lock:
        q = _asks.setdefault(email, deque())
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= ASKS_PER_HOUR:
            return False
        q.append(now)
        return True


# ── Ask Nexus ────────────────────────────────────────────────────────────────

class GuideIn(BaseModel):
    id: str = ""
    title: str = ""
    text: str = ""


class AskIn(BaseModel):
    question: str
    guide: list[GuideIn] = []


def _kb_pages(db: Session, user: dict, q: str) -> list[dict]:
    # The same wall /kb/ask reads through - published pages this person may see.
    from routers.kb import _published
    pub = _published(db, user)
    res = kb_search.search(db, pub, q, limit=KB_PAGES_MAX)
    by_id = {d.id: d for d in pub}
    out = []
    for r in res["results"][:KB_PAGES_MAX]:
        d = by_id.get(r["id"])
        if not d:
            continue
        out.append({"kind": "kb", "id": d.id, "code": d.doc_code or "", "title": d.title,
                    "text": d.content_text or kb_blocks.plain_text(kb_blocks.loads(d.blocks))})
    return out


@router.post("/ask")
def ask(body: AskIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = (body.question or "").strip()[:QUESTION_MAX]
    if not q:
        raise HTTPException(422, "Ask something")
    email = (user["email"] or "").lower()
    guide = []
    for g in (body.guide or [])[:GUIDE_SECTIONS_MAX]:
        gid, title, text = (g.id or "").strip()[:200], (g.title or "").strip()[:300], (g.text or "").strip()[:GUIDE_TEXT_MAX]
        if gid and text:
            guide.append({"kind": "guide", "id": gid, "title": title, "text": text})
    sources = guide + _kb_pages(db, user, q)
    public = [{k: v for k, v in s.items() if k != "text"} for s in sources]
    if not kb_ai.available():
        return {"answer": "", "sources": public[:5], "grounded": False, "offline": True}
    if not _take_ask(email):
        raise HTTPException(429, f"You have asked Nexus {ASKS_PER_HOUR} questions in the last hour. Try again later, or file a ticket.")
    if not sources:
        kb_search.log_miss(db, q, 0, email, source="ask", floor=10 ** 6)
        db.commit()
        return {"answer": "", "sources": [], "grounded": False, "offline": False}
    try:
        out = kb_ai.answer_help(q, sources)
    except kb_ai.AiError as e:
        return {"answer": "", "sources": public[:5], "grounded": False, "offline": True, "error": str(e)}
    used = [public[i] for i in out["sources"]]
    if not out["grounded"]:
        kb_search.log_miss(db, q, len(used), email, source="ask", floor=10 ** 6)
        db.commit()
    return {"answer": out["answer"], "sources": used, "grounded": out["grounded"], "offline": False}


# ── Failed searches ──────────────────────────────────────────────────────────

class SearchLogIn(BaseModel):
    q: str
    results: int = 0
    source: str = "help"


@router.post("/search-log", status_code=204)
def search_log(body: SearchLogIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.source not in SEARCH_SOURCES:
        raise HTTPException(422, "Unknown search box")
    # A Help search is a miss only with nothing at all; searching and then
    # filing a ticket anyway, or an answer the sources did not cover, always is.
    floor = 1 if body.source == "help" else 10 ** 6
    kb_search.log_miss(db, body.q, max(0, int(body.results or 0)), (user["email"] or "").lower(), source=body.source, floor=floor)
    db.commit()


# ── Was This Helpful? ────────────────────────────────────────────────────────

class FeedbackIn(BaseModel):
    target_kind: str
    target_id: str = ""
    helpful: bool
    note: str = ""
    question: str = ""
    title: str = ""


def answer_key(question: str) -> str:
    return hashlib.sha1(" ".join((question or "").lower().split()).encode()).hexdigest()[:16]


@router.post("/feedback")
def feedback(body: FeedbackIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    kind = body.target_kind
    if kind not in ("guide", "answer"):
        raise HTTPException(422, "Unknown kind")
    question = (body.question or "").strip()[:QUESTION_MAX]
    target = answer_key(question) if kind == "answer" else (body.target_id or "").strip()[:300]
    if not target or (kind == "answer" and not question):
        raise HTTPException(422, "Nothing to rate")
    email = (user["email"] or "").lower()
    row = (db.query(models.HelpFeedback)
           .filter(models.HelpFeedback.user_email == email, models.HelpFeedback.target_kind == kind,
                   models.HelpFeedback.target_id == target).first())
    now = _now()
    if not row:
        row = models.HelpFeedback(id=uuid.uuid4().hex, user_email=email, target_kind=kind, target_id=target, created_at=now)
        db.add(row)
    row.helpful = bool(body.helpful)
    # A Yes clears an earlier "what was missing" note; a No keeps the newest.
    row.note = "" if body.helpful else (body.note or "").strip()[:1000]
    row.question = question
    row.title = (body.title or "").strip()[:300] or row.title or ""
    row.updated_at = now
    db.commit()
    return {"ok": True, "helpful": row.helpful}


# ── Help Signals ─────────────────────────────────────────────────────────────

@router.get("/signals")
def signals(days: int = 90, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    days = max(1, min(int(days or 90), 365))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = db.query(models.HelpFeedback).filter(models.HelpFeedback.updated_at >= since).all()
    agg: dict[tuple, dict] = {}
    yes = no = 0
    for r in rows:
        if r.helpful:
            yes += 1
        else:
            no += 1
        a = agg.setdefault((r.target_kind, r.target_id), {
            "kind": r.target_kind, "id": r.target_id, "title": r.title or "", "question": r.question or "",
            "yes": 0, "no": 0, "notes": [], "last": ""})
        a["yes" if r.helpful else "no"] += 1
        a["title"] = a["title"] or r.title or ""
        if not r.helpful and r.note:
            a["notes"].append({"note": r.note, "at": r.updated_at})
        a["last"] = max(a["last"], r.updated_at or "")
    # Most No votes first; among equals, the most recent.
    not_helpful = sorted((a for a in agg.values() if a["no"]), key=lambda a: a["last"], reverse=True)
    not_helpful.sort(key=lambda a: -a["no"])
    for a in not_helpful:
        a["notes"] = sorted(a["notes"], key=lambda n: n["at"], reverse=True)[:3]
    month_ago = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    ticketed = sum(r.count or 0 for r in db.query(models.KbSearchLog)
                   .filter(models.KbSearchLog.source == "ticket-form", models.KbSearchLog.day >= month_ago).all())
    return {
        "votes": {"yes": yes, "no": no},
        "not_helpful": not_helpful[:30],
        "failed_searches": kb_search.misses(db, days=30, limit=25, sources=HELP_SOURCES),
        "ticketed_after_search": ticketed,
    }


# ── Known Issues ─────────────────────────────────────────────────────────────

class IssueIn(BaseModel):
    id: str = ""
    title: str
    note: str = ""
    severity: str = "info"
    until: str = ""          # YYYY-MM-DD, the last day it shows; "" = until cleared
    posted_by: Optional[str] = None
    posted_at: Optional[str] = None


class IssuesIn(BaseModel):
    issues: list[IssueIn]


def _company_today() -> str:
    return datetime.now(COMPANY_ZONE).date().isoformat()


def _load_issues(db: Session) -> list[dict]:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == KNOWN_ISSUES_KEY).first()
    if not row or not row.value:
        return []
    try:
        v = json.loads(row.value)
    except (TypeError, ValueError):
        return []
    return [i for i in v if isinstance(i, dict)] if isinstance(v, list) else []


def _live(issue: dict, today: str) -> bool:
    until = issue.get("until") or ""
    return not until or until >= today


@router.get("/known-issues")
def known_issues(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    today = _company_today()
    issues = _load_issues(db)
    can_edit = user["level"] >= 4
    for i in issues:
        i["expired"] = not _live(i, today)
    return {"issues": issues if can_edit else [i for i in issues if not i["expired"]], "canEdit": can_edit}


@router.put("/known-issues")
def save_known_issues(body: IssuesIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    if len(body.issues) > KNOWN_ISSUES_MAX:
        raise HTTPException(422, f"At most {KNOWN_ISSUES_MAX} known issues at a time")
    before = {i.get("id"): i for i in _load_issues(db)}
    now, email = _now(), (user["email"] or "").lower()
    out = []
    for i in body.issues:
        title = (i.title or "").strip()[:120]
        if not title:
            raise HTTPException(422, "Every known issue needs a title")
        if i.severity not in SEVERITIES:
            raise HTTPException(422, "Severity is Info, Warning or Outage")
        until = (i.until or "").strip()[:10]
        if until:
            try:
                datetime.strptime(until, "%Y-%m-%d")
            except ValueError as e:
                raise HTTPException(422, "Until must be a date") from e
        prev = before.get(i.id) if i.id else None
        out.append({"id": i.id if prev else uuid.uuid4().hex[:12], "title": title, "note": (i.note or "").strip()[:500],
                    "severity": i.severity, "until": until,
                    "posted_by": (prev or {}).get("posted_by") or email, "posted_at": (prev or {}).get("posted_at") or now,
                    "updated_at": now})
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == KNOWN_ISSUES_KEY).first()
    if not row:
        row = models.NexusSetting(key=KNOWN_ISSUES_KEY)
        db.add(row)
    row.value = json.dumps(out)
    row.updated_by = email
    row.updated_at = now
    db.commit()
    return known_issues(user=user, db=db)
