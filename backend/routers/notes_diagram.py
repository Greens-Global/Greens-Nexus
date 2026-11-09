"""Diagram From a Sentence (Neil, 11/08/2026): OFF, and an extra OFF gate.

"Bring in the AI as long as it is toggled off as a setting ... cannot be
toggled on until a super administrator such as Visesh or Neil enables it and
connects an AI API, which we do not want to do yet."

The board's diagram sheet has a "From a Sentence" box: a sentence would go to
the house AI call (kb_ai._call - the same path the Knowledge Base tools use,
never a new client) and come back as text in the diagram grammar
(frontend/src/notes/board/diagram/graph.js) for the person to review in the
text box before anything is placed. It runs ONLY when BOTH are true:

  1. AI is on for Nexus - ai_switch: NEXUS_AI_ENABLED=true on the server (an
     Azure app setting only Neil or Visesh sets) AND a key the switch left in
     place (kb_ai.available(), the same "not set up" check every AI path
     reads). Nothing here can change either.
  2. The organization setting `diagramAiEnabled` (NexusSetting
     `notes.diagram_ai`, default false), changed by a Super Administrator
     only, and refused (409) while AI is off - so no client can switch it on
     ahead of AI.

Either one off -> 403 {code: 'ai_off'} and nothing is called. This setting
is an extra OFF gate only: it can never turn AI on by itself (test_ai_switch
pins the master switch; test_notes_diagram pins this route).
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ai_switch
import kb_ai
import models
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/notes/diagram", tags=["Notes"])

SETTING_KEY = "notes.diagram_ai"
AI_OFF = ("Turned off. A Super Administrator (Neil or Visesh) must enable AI for Nexus "
          "and connect an AI service first.")
MAX_SENTENCE = 1000


def ai_available() -> bool:
    """AI is on for Nexus: the master switch AND a key it left in place."""
    return ai_switch.enabled() and kb_ai.available()


def _stored(db: Session) -> bool:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING_KEY).first()
    try:
        return bool(row) and json.loads(row.value or "{}").get("enabled") is True
    except (TypeError, ValueError, AttributeError):
        return False


def settings(db: Session) -> dict:
    """What the screens may show. `diagramAiEnabled` reads false while AI is
    off, whatever is stored."""
    on = ai_available()
    return {"diagramAiEnabled": on and _stored(db), "aiAvailable": on}


@router.get("/settings")
def get_settings(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    return settings(db)


class SettingsIn(BaseModel):
    diagramAiEnabled: bool = False


@router.put("/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    import settings_walls
    settings_walls.require_super_admin_for_org(db, user, "Diagram From a Sentence")
    if body.diagramAiEnabled and not ai_available():
        raise HTTPException(409, AI_OFF)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTING_KEY)
        db.add(row)
    now = datetime.now(timezone.utc).isoformat()
    row.value = json.dumps({"enabled": bool(body.diagramAiEnabled)})
    row.updated_by = user["email"]
    row.updated_at = now
    db.add(models.AuditLog(timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
                           action=f"Turned Diagram From a Sentence {'on' if body.diagramAiEnabled else 'off'}",
                           resource_type="settings", resource_id=SETTING_KEY))
    db.commit()
    return settings(db)


class SentenceIn(BaseModel):
    sentence: str = ""


_SYSTEM = """You write diagrams for a whiteboard in this text grammar and nothing else.
One idea per line. Arrows: `=>` the main flow, `->` a normal arrow, `-.->` a dashed arrow (setup, a sync, an occasional link).
A label goes inside an arrow: `=yes=>`, `-yes->`, `-.nightly.->` (always a space before a labeled arrow).
A name ending in `?` is a decision, `(Start)` a start or end, `{Note}` a note. `Gate | lock` puts a Lucide icon on a box.
A line ending in `:` opens a group; indent its members two spaces under it; one group may sit inside another, no deeper.
Use Title Case names, American English, no em dashes. Output ONLY the diagram text, no code fences, no commentary."""


@router.post("/from-sentence")
def from_sentence(body: SentenceIn, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    # Plain `def`: FastAPI runs it in its threadpool, off the event loop.
    if not ai_available() or not _stored(db):
        raise HTTPException(403, {"code": "ai_off", "message": AI_OFF})
    sentence = (body.sentence or "").strip()
    if not sentence:
        raise HTTPException(400, "Describe the diagram in a sentence first.")
    if len(sentence) > MAX_SENTENCE:
        raise HTTPException(400, f"That is too long - keep it under {MAX_SENTENCE} characters.")
    try:
        out = kb_ai._call(_SYSTEM, sentence, max_tokens=1500, timeout=60, use_fast=True)
    except kb_ai.AiError as e:
        raise HTTPException(502, str(e))
    text = re.sub(r"^```\w*\s*|\s*```$", "", (out or "").strip()).replace("—", "-")
    if not text:
        raise HTTPException(502, "Nothing came back. Try other words.")
    return {"text": text[:8000]}
