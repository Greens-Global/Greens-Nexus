"""
Per-page AI help. Every page in Nexus gets a "?" that shows a short, friendly
"how to use this page" guide. Claude writes it on first view; it's cached in
page_help and can be regenerated on demand (Neil: AI keeps it current, no human
authoring). Falls back gracefully when the AI proxy is unavailable.
"""
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

import models
from database import get_db
from auth import get_current_user, require_level

router = APIRouter(prefix="/help", tags=["help"])

_AI_MODEL = "claude-opus-4-8"
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Lightweight, curated descriptions for the pages we know well, so Claude writes
# accurate help instead of guessing. Anything not listed is generated from the
# page label alone (still useful, more general). This is the "training" input
# Neil described - extend it as modules mature.
PAGE_NOTES = {
    "inventory": (
        "Item Management: the catalogue of every physical company item (each unit is one row). "
        "Tabs: Catalog (browse/search/filter items and request a checkout via the cart), "
        "Manage (admins add/edit/import items, batch-edit fields or photos, assign to a person or "
        "location, export/report, Recycle Bin), Audit Log (every change with who/when and Undo), "
        "Who Has What (holdings by person or location), My Items (your checkouts), and Purchase Requests."
    ),
    "sop": (
        "Knowledge Base: every SOP, manual and guide. Search or Ask AI, read a document, sign it off "
        "when required, comment, and managers review/approve/archive. Authors create a draft, can format "
        "it with Claude, attach images, translate it, and address review comments with Claude. Learn tab "
        "hosts training courses and quizzes."
    ),
    "property-asset": (
        "Asset Management / Property Portfolio: company properties with their details, equipment "
        "warranties, inspections, as-built plans and documents, utilities/authorities, vendors, permits "
        "and a timeline. Use the cards to open a property and its tabs."
    ),
    "dashboard": (
        "Your home dashboard: a snapshot of what needs your attention across modules - notifications, "
        "pending items, and quick links into each area."
    ),
    "inventory:audit": (
        "Item Audit Log: a day-by-day activity feed of every change to items. Each card reads in plain "
        "English; expand it for the field-by-field before/after. You can Undo an add, edit or delete, and "
        "'Open item' jumps to the item (or the Recycle Bin if it was deleted)."
    ),
}


def _fallback(label: str) -> str:
    return (
        f"## {label}\n\n"
        f"Help for **{label}** is being prepared. This page is part of the Greens Nexus staff portal - "
        "use the tabs and buttons on the page to navigate, and the search/filter controls to find what "
        "you need. A manager can regenerate this guide from the help panel."
    )


def _generate(page_key: str, label: str) -> tuple[str, str]:
    """Return (markdown, source). source = 'ai' | 'fallback'."""
    if not _ANTHROPIC_API_KEY:
        return _fallback(label), "fallback"
    note = PAGE_NOTES.get(page_key) or PAGE_NOTES.get(page_key.split(":")[0]) or ""
    prompt = (
        "You write short, friendly in-app help for pages of Greens Global's internal staff portal "
        '("Nexus"), used by non-technical employees at a self-storage and commercial real-estate '
        "operator.\n\n"
        f"PAGE: {label}\n"
        f"{('WHAT THIS PAGE DOES: ' + note) if note else ''}\n\n"
        "Write a concise 'How to use this page' guide in GitHub-flavoured Markdown:\n"
        "- One or two friendly sentences explaining what the page is for.\n"
        "- Then a '### What you can do here' heading with 3-6 short bullet points of the key actions.\n"
        "- Optionally a final '**Tip:**' line.\n"
        "Keep it under ~180 words, plain language, no jargon. Address the reader as 'you'. "
        "Do NOT invent specific buttons or features you are unsure about - stay general where unsure. "
        "Output ONLY the Markdown, with no preamble or code fences."
    )
    try:
        with httpx.Client(timeout=90) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": _ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _AI_MODEL,
                    "max_tokens": 900,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            r.raise_for_status()
            data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        return (text or _fallback(label)), ("ai" if text else "fallback")
    except Exception as e:  # noqa: BLE001
        print(f"[help] generation failed for {page_key}: {e}")
        return _fallback(label), "fallback"


def _serialize(row: models.PageHelp) -> dict:
    return {
        "page_key": row.page_key, "label": row.label, "title": row.title,
        "content": row.content, "source": row.source, "updated_at": row.updated_at,
    }


def _ensure(page_key: str, label: str, db: Session, actor: str, force: bool = False) -> models.PageHelp:
    row = db.query(models.PageHelp).filter(models.PageHelp.page_key == page_key).first()
    if row and not force:
        return row
    content, source = _generate(page_key, label or (row.label if row else page_key))
    if not row:
        row = models.PageHelp(page_key=page_key)
        db.add(row)
    row.label = label or row.label or page_key
    row.title = label or row.label
    row.content = content
    row.source = source
    row.updated_at = _now()
    row.updated_by = actor
    db.commit()
    return row


@router.get("/page")
def get_page_help(key: str, label: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Cached help for a page key (e.g. 'inventory' or 'inventory:audit').
    Generated by Claude on first view, then served from cache."""
    row = _ensure(key, label, db, user.get("email", ""))
    return _serialize(row)


class RegenIn(BaseModel):
    key: str
    label: str = ""


@router.post("/page/regenerate")
def regenerate_page_help(body: RegenIn, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Force a fresh AI rewrite of a page's help (managers)."""
    row = _ensure(body.key, body.label, db, user.get("email", ""), force=True)
    return _serialize(row)
