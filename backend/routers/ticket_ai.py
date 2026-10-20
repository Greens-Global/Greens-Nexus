"""Ticket AI endpoints (Oct 2026) - see ticket_ai.py for the engine, the
models and the prompt-safety rules.

  GET  /ticket-ai/status                         anyone signed in: what may show
  GET  /ticket-ai/settings | PUT                 the desk's AI switch (manager+,
                                                 a supervisor under explicit desk access)
  POST /ticket-ai/suggest-topics                 anyone signed in: the create form's
                                                 Suggested Help Topic chips
  GET  /ticket-ai/tickets/{id}/summary           desk only: the cached AI Summary
  POST /ticket-ai/tickets/{id}/summary           desk only: Summarize / Refresh
  GET  /ticket-ai/tickets/{id}/suggested-topic   desk only: for a ticket with no topic

Why not GET /task-tickets/{id}/summary (routers/tickets.py)? That one is the
"name this ticket" card a task drawer shows, readable by any participant -
requester included. AI output is desk-only, so it is its own path rather than
a field on a response the requester can read.

Every endpoint is a plain `def`: FastAPI runs it in its threadpool, so the
model call (and its DB reads) never sit on the event loop (CLAUDE.md). A
model failure is a 424 with a sentence the screen shows as is - not a 5xx,
which api.js reads as "the server is down" (the reconnecting banner). The
drawer and the create form keep working without it.
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
import models
import ticket_ai
import ticket_roles
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.task_util import now_iso
from ticket_notify import _name_of

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user)])

FRIENDLY_FAIL = "The AI summary could not be made right now - try again in a minute."
TOO_MANY = "Too many requests - try again in a minute."


def _desk_ticket(db: Session, user: dict, ticket_id: str) -> models.TaskTicket:
    """The ticket, for a desk agent who may open it. Another company's ticket
    is 404 (the company wall, before any role check); off the desk is 403."""
    t = T._conversation_ticket_or_404(db, ticket_id)
    auth.assert_company(t.company_id or "", user, db)
    if not ticket_roles.can_work_queue(user, db):
        raise HTTPException(403, "AI features are for the service desk.")
    return t


def _name(db: Session, email: str) -> str:
    return _name_of(db, email) or email or ""


# ── Status and settings ─────────────────────────────────────────────────────

@router.get("/ticket-ai/status")
def ai_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return ticket_ai.status(db)


def _require_settings_editor(user: dict, db: Session) -> None:
    # The same rule as the desk's other settings (put_ticket_taxonomy_settings):
    # a manager, and under explicit desk access also a ticket supervisor.
    if user.get("level", 0) < 3:
        raise HTTPException(403, "Manager access or above is required.")
    if (ticket_roles.desk_access_mode(db) == ticket_roles.EXPLICIT
            and not ticket_roles.can_manage_desk(user, db)):
        raise HTTPException(403, "Only a ticket supervisor can change the desk's settings.")


@router.get("/ticket-ai/settings")
def get_ai_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {**ticket_ai.get_settings(db), **ticket_ai.status(db)}


class AiSettingsBody(BaseModel):
    enabled: bool


@router.put("/ticket-ai/settings")
def put_ai_settings(body: AiSettingsBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_settings_editor(user, db)
    ticket_ai.save_settings(db, body.enabled, user["email"])
    return {**ticket_ai.get_settings(db), **ticket_ai.status(db)}


# ── Suggested Help Topic ────────────────────────────────────────────────────

class SuggestBody(BaseModel):
    subject: Optional[str] = Field("", max_length=ticket_ai.SUBJECT_MAX * 4)
    description: Optional[str] = Field("", max_length=ticket_ai.SUGGEST_INPUT_MAX)
    department_id: Optional[str] = Field("", max_length=200)


def _suggest(db: Session, user: dict, subject: str, description: str, dept_name: str) -> dict:
    st = ticket_ai.status(db)
    if not st["suggestions"]:
        return {"suggestions": [], "ranked": "none", "enabled": False}
    if not ticket_ai.allow("suggest", user.get("email"), ticket_ai.SUGGEST_PER_MIN):
        raise HTTPException(429, TOO_MANY)
    use_llm = st["aiRanking"] and ticket_ai.allow("suggest_llm", user.get("email"), ticket_ai.SUGGEST_LLM_PER_MIN)
    out = ticket_ai.suggest(db, subject=subject or "", description=description or "",
                            dept_name=dept_name, use_llm=use_llm)
    return {**out, "enabled": True}


@router.post("/ticket-ai/suggest-topics")
def suggest_topics(body: SuggestBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Up to 3 of the department's configured help topics for what the
    requester has typed so far. Never auto-applied - the form shows chips."""
    dept_name = T.dept_name(db, body.department_id or "") if body.department_id else ""
    return _suggest(db, user, body.subject or "", body.description or "", dept_name)


@router.get("/ticket-ai/tickets/{ticket_id}/suggested-topic")
def ticket_suggested_topic(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The drawer's Suggested Help Topic, for a ticket filed without one.
    Built from the subject and description only (the requester's own words)."""
    t = _desk_ticket(db, user, ticket_id)
    if (t.application or "").strip():
        return {"suggestions": [], "ranked": "none", "enabled": ticket_ai.status(db)["suggestions"]}
    return _suggest(db, user, t.subject or "", t.description or "", T.dept_name(db, t.hr_department_id or ""))


# ── AI Summary ──────────────────────────────────────────────────────────────

class SummaryBody(BaseModel):
    refresh: Optional[bool] = False


def _audience(db: Session, t: models.TaskTicket, user: dict) -> tuple:
    internal_ok = T._sees_internal(db, t, user, True)
    return ("internal" if internal_ok else "public"), internal_ok


def _row_out(db: Session, row, current_fp: str, audience: str) -> dict:
    out = {"available": True, "audience": audience, "includesInternal": audience == "internal",
           "summary": None, "stale": False, "generatedAt": "", "generatedBy": ""}
    if row is None:
        return out
    try:
        content = json.loads(row.content or "{}")
    except (TypeError, ValueError):
        return out
    if not isinstance(content, dict):
        return out
    out.update({
        "summary": {k: ticket_ai.clean_output(content.get(k)) for k in ("issue", "tried", "state", "next_step")},
        "stale": row.fingerprint != current_fp,
        "generatedAt": row.generated_at or "",
        "generatedBy": _name(db, row.generated_by or ""),
    })
    return out


def _cached(db: Session, ticket_id: str, audience: str):
    return db.query(models.TicketAiSummary).filter(models.TicketAiSummary.id == f"{ticket_id}:{audience}").first()


@router.get("/ticket-ai/tickets/{ticket_id}/summary")
def get_ticket_summary(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _desk_ticket(db, user, ticket_id)
    if not ticket_ai.status(db)["summaries"]:
        return {"available": False}
    audience, internal_ok = _audience(db, t, user)
    fp = ticket_ai.fingerprint(t, ticket_ai.visible_comments(db, t.id, internal_ok), audience)
    return _row_out(db, _cached(db, t.id, audience), fp, audience)


@router.post("/ticket-ai/tickets/{ticket_id}/summary")
def make_ticket_summary(ticket_id: str, body: SummaryBody = SummaryBody(),
                        user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Summarize (or Refresh). A summary still current for this audience is
    returned as is - nothing is regenerated until something changed - unless
    `refresh` asks for a new one anyway."""
    t = _desk_ticket(db, user, ticket_id)
    if not ticket_ai.status(db)["summaries"]:
        raise HTTPException(409, "AI features are turned off for the service desk.")
    audience, internal_ok = _audience(db, t, user)
    comments = ticket_ai.visible_comments(db, t.id, internal_ok)
    fp = ticket_ai.fingerprint(t, comments, audience)
    row = _cached(db, t.id, audience)
    if row is not None and row.fingerprint == fp and not body.refresh:
        return {**_row_out(db, row, fp, audience), "cached": True}
    if not ticket_ai.allow("summary", user.get("email"), ticket_ai.SUMMARY_PER_MIN):
        raise HTTPException(429, TOO_MANY)
    try:
        content = ticket_ai.generate_summary(t, comments, lambda e: _name(db, e), internal_ok)
    except ticket_ai.AiUnavailable as e:
        print(f"[ticket_ai] summary failed for {t.id}: {e}")
        raise HTTPException(424, FRIENDLY_FAIL)
    values = {"ticket_id": t.id, "audience": audience, "company_id": t.company_id or "", "fingerprint": fp,
              "content": json.dumps(content), "model": ticket_ai.SUMMARY_MODEL,
              "generated_by": (user.get("email") or "").lower(), "generated_at": now_iso()}
    row = _cached(db, t.id, audience)
    if row is None:
        row = models.TicketAiSummary(id=f"{t.id}:{audience}", **values)
        db.add(row)
    else:
        for k, v in values.items():
            setattr(row, k, v)
    try:
        db.commit()
    except IntegrityError:
        # Two agents summarized at once - the other insert won; take ours over it.
        db.rollback()
        row = _cached(db, t.id, audience)
        for k, v in values.items():
            setattr(row, k, v)
        db.commit()
    return {**_row_out(db, row, fp, audience), "cached": False}
