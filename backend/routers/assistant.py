"""Nexus Assistant endpoints - see ai_assistant.py for the tool-dispatch engine.

Every route is authenticated; a conversation is always private to the user who
started it (no manager/admin override), and every tool the assistant can call
is scoped to the caller's own data - see ai_assistant.py's module docstring.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

import ai_assistant
import models
from database import get_db
from auth import get_current_user

router = APIRouter(prefix="/assistant", tags=["assistant"], dependencies=[Depends(get_current_user)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_owned_conversation(conversation_id: str, user: dict, db: Session) -> models.AiConversation:
    convo = db.query(models.AiConversation).filter(models.AiConversation.id == conversation_id).first()
    if not convo or convo.user_email != user["email"]:
        raise HTTPException(404, "Conversation not found")
    return convo


class AskIn(BaseModel):
    conversation_id: str | None = None
    message: str


@router.post("/ask")
def ask(body: AskIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not ai_assistant.configured():
        raise HTTPException(503, "The assistant is not configured on this environment (ANTHROPIC_API_KEY is not set)")
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "message is required")

    if body.conversation_id:
        convo = _get_owned_conversation(body.conversation_id, user, db)
        history_rows = (
            db.query(models.AiMessage)
            .filter(models.AiMessage.conversation_id == convo.id)
            .order_by(models.AiMessage.created_at.asc())
            .all()
        )
    else:
        convo = models.AiConversation(
            id=str(uuid.uuid4()), user_email=user["email"], title=message[:80],
            created_at=_now(), updated_at=_now(),
        )
        db.add(convo)
        history_rows = []

    history = [{"role": m.role, "content": m.content} for m in history_rows]
    try:
        reply, tools_used = ai_assistant.run_assistant_turn(user, db, history, message)
    except Exception as e:  # noqa: BLE001
        # 503, never a bare 502 - Cloudflare replaces an origin 502 with its own
        # branded HTML error page (see routers/egnyte.py's _ai_parse_rule for the
        # same convention and the incident that established it).
        print(f"[assistant] Claude call failed: {type(e).__name__}: {e}")
        raise HTTPException(503, "The assistant could not be reached - try again in a moment.")

    now = _now()
    db.add(models.AiMessage(
        id=str(uuid.uuid4()), conversation_id=convo.id, role="user",
        content=message, tool_calls=[], created_at=now,
    ))
    db.add(models.AiMessage(
        id=str(uuid.uuid4()), conversation_id=convo.id, role="assistant",
        content=reply, tool_calls=tools_used, created_at=now,
    ))
    convo.updated_at = now
    db.commit()

    return {"conversation_id": convo.id, "reply": reply}


@router.get("/conversations")
def list_conversations(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(models.AiConversation)
        .filter(models.AiConversation.user_email == user["email"])
        .order_by(models.AiConversation.updated_at.desc())
        .all()
    )
    return [{"id": r.id, "title": r.title, "updated_at": r.updated_at} for r in rows]


@router.get("/conversations/{conversation_id}/messages")
def get_messages(conversation_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    convo = _get_owned_conversation(conversation_id, user, db)
    rows = (
        db.query(models.AiMessage)
        .filter(models.AiMessage.conversation_id == convo.id)
        .order_by(models.AiMessage.created_at.asc())
        .all()
    )
    return [{"role": r.role, "content": r.content, "created_at": r.created_at} for r in rows]
