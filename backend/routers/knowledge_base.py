"""Knowledge Base module — DB-backed SOP / Manual / Guide library.

Lifecycle: draft -> in_review -> approved (or changes_requested back to owner);
approved docs can be archived. Anyone signed in can author a draft and submit it;
managers (level >= 3) review/approve/archive. The rich nested body is stored as a
JSON string on the model (see models.KbDocument) and (de)serialised here so the
frontend always works with structured objects.

The "Format with Claude" endpoint mirrors the existing server-side Anthropic call
in routers/items.py — the API key lives server-side only. It always returns 200:
if the proxy/key/network is unavailable it falls back to a local heuristic
formatter so the editor feature never hard-fails.
"""
import os
import json
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from auth import get_current_user, require_level

router = APIRouter(prefix="/knowledge-base", tags=["Knowledge Base"], dependencies=[Depends(get_current_user)])

# Greens Global's real departments (mirrors the frontend DEPARTMENTS list).
DEPT_ABBR = {
    "Operations": "OPS", "Revenue Management": "RM", "Real Estate Development": "RED",
    "People (HR)": "HR", "Finance & Accounting": "FIN", "IT": "IT",
    "Marketing": "MKT", "Admin": "ADM",
}

_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
# Quality-sensitive formatting task — kept in one constant so it's trivially
# swappable (e.g. to claude-haiku-4-5-20251001 to match items.py / cut cost).
_AI_MODEL = "claude-opus-4-8"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return _now()[:10]


def _new_id() -> str:
    return "kb_" + uuid.uuid4().hex[:12]


def _dept_prefix(departments: list[str]) -> str:
    if not departments:
        return "COR"
    if len(departments) == 1:
        return DEPT_ABBR.get(departments[0], "COR")
    return "COR"  # multi-department docs are corporate-wide


def _next_doc_code(departments: list[str], db: Session) -> str:
    prefix = _dept_prefix(departments)
    nums = []
    for (code,) in db.query(models.KbDocument.doc_code).all():
        if code and code.startswith(prefix + "-"):
            try:
                nums.append(int(code.split("-")[1]))
            except (ValueError, IndexError):
                pass
    return f"{prefix}-{(max(nums) + 1 if nums else 1):03d}"


def _blank_body() -> dict:
    return {
        "purpose": "", "scopeText": "", "materials": [], "responsibilities": [],
        "definitions": [], "procedure": [], "safety": [], "references": [],
    }


def _serialize(d: models.KbDocument) -> dict:
    try:
        body = json.loads(d.body or "{}")
    except (ValueError, TypeError):
        body = {}
    try:
        history = json.loads(d.revision_history or "[]")
    except (ValueError, TypeError):
        history = []
    return {
        "id": d.id,
        "doc_code": d.doc_code or "",
        "title": d.title,
        "doc_type": d.doc_type,
        "departments": [s for s in (d.departments or "").split(",") if s],
        "status": d.status,
        "owner_email": d.owner_email or "",
        "owner_name": d.owner_name or "",
        "reviewer_email": d.reviewer_email or "",
        "reviewer_name": d.reviewer_name or "",
        "version": d.version,
        "effective_date": d.effective_date or "",
        "body": {**_blank_body(), **(body if isinstance(body, dict) else {})},
        "review_note": d.review_note or "",
        "revision_history": history,
        "created_by": d.created_by or "",
        "created_at": d.created_at or "",
        "updated_at": d.updated_at or "",
    }


def _can_edit(d: models.KbDocument, user: dict) -> bool:
    if user["level"] >= 3:  # manager+
        return True
    return d.owner_email == user["email"] and d.status in ("draft", "changes_requested")


def _get_or_404(doc_id: str, db: Session) -> models.KbDocument:
    d = db.query(models.KbDocument).filter(models.KbDocument.id == doc_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Document not found")
    return d


# ---- request models -------------------------------------------------------
class KbDocIn(BaseModel):
    title: str = ""
    doc_type: str = "SOP"
    departments: list[str] = []
    reviewer_email: str = ""
    reviewer_name: str = ""
    version: str = "0.1"
    effective_date: str = ""
    body: dict = {}


class ReviewIn(BaseModel):
    decision: str            # "approve" | "request_changes"
    note: str = ""


class AiFormatIn(BaseModel):
    content: str = ""
    title: str = ""
    departments: list[str] = []


# ---- CRUD -----------------------------------------------------------------
@router.get("/documents")
def list_documents(db: Session = Depends(get_db)):
    rows = db.query(models.KbDocument).all()
    rows.sort(key=lambda d: d.updated_at or "", reverse=True)
    return [_serialize(d) for d in rows]


@router.get("/documents/{doc_id}")
def get_document(doc_id: str, db: Session = Depends(get_db)):
    return _serialize(_get_or_404(doc_id, db))


@router.post("/documents", status_code=201)
def create_document(payload: KbDocIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")
    now = _now()
    d = models.KbDocument(
        id=_new_id(),
        doc_code=_next_doc_code(payload.departments, db),
        title=payload.title.strip(),
        doc_type=payload.doc_type or "SOP",
        departments=",".join(payload.departments),
        status="draft",
        owner_email=user["email"],
        owner_name=user.get("name") or user["email"],
        reviewer_email=payload.reviewer_email,
        reviewer_name=payload.reviewer_name,
        version=payload.version or "0.1",
        effective_date=payload.effective_date,
        body=json.dumps({**_blank_body(), **(payload.body or {})}),
        revision_history=json.dumps([
            {"version": payload.version or "0.1", "date": _today(), "author": user["email"], "notes": "Created."}
        ]),
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return _serialize(d)


@router.patch("/documents/{doc_id}")
def update_document(doc_id: str, payload: KbDocIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = _get_or_404(doc_id, db)
    if not _can_edit(d, user):
        raise HTTPException(status_code=403, detail="You can't edit this document")
    if payload.title.strip():
        d.title = payload.title.strip()
    d.doc_type = payload.doc_type or d.doc_type
    d.departments = ",".join(payload.departments)
    d.reviewer_email = payload.reviewer_email
    d.reviewer_name = payload.reviewer_name
    if payload.version:
        d.version = payload.version
    d.effective_date = payload.effective_date
    d.body = json.dumps({**_blank_body(), **(payload.body or {})})
    if not d.doc_code:
        d.doc_code = _next_doc_code(payload.departments, db)
    d.updated_at = _now()
    db.commit()
    db.refresh(d)
    return _serialize(d)


@router.post("/documents/{doc_id}/submit")
def submit_document(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = _get_or_404(doc_id, db)
    if not (d.owner_email == user["email"] or user["level"] >= 3):
        raise HTTPException(status_code=403, detail="Only the owner or a manager can submit")
    if d.status not in ("draft", "changes_requested"):
        raise HTTPException(status_code=400, detail="Only drafts can be submitted for review")
    if not d.reviewer_email:
        raise HTTPException(status_code=400, detail="Select a reviewing manager before submitting")
    d.status = "in_review"
    d.updated_at = _now()
    _push_history(d, {"version": d.version, "date": _today(), "author": user["email"], "notes": "Submitted for review."})
    db.commit()
    return _serialize(d)


@router.post("/documents/{doc_id}/review")
def review_document(doc_id: str, payload: ReviewIn, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    d = _get_or_404(doc_id, db)
    if d.status != "in_review":
        raise HTTPException(status_code=400, detail="Document is not awaiting review")
    if payload.decision == "approve":
        first_publish = (d.version or "").startswith("0.")
        d.status = "approved"
        if first_publish:
            d.version = "1.0"
        if not d.effective_date:
            d.effective_date = _today()
        d.review_note = payload.note
        _push_history(d, {"version": d.version, "date": _today(), "author": user["email"], "notes": "Approved & published."})
    elif payload.decision == "request_changes":
        if not payload.note.strip():
            raise HTTPException(status_code=400, detail="A note is required when requesting changes")
        d.status = "changes_requested"
        d.review_note = payload.note
        _push_history(d, {"version": d.version, "date": _today(), "author": user["email"], "notes": f"Changes requested: {payload.note}"})
    else:
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'request_changes'")
    d.updated_at = _now()
    db.commit()
    return _serialize(d)


@router.post("/documents/{doc_id}/archive")
def archive_document(doc_id: str, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    d = _get_or_404(doc_id, db)
    d.status = "archived"
    d.updated_at = _now()
    _push_history(d, {"version": d.version, "date": _today(), "author": user["email"], "notes": "Archived."})
    db.commit()
    return _serialize(d)


def _push_history(d: models.KbDocument, entry: dict) -> None:
    try:
        hist = json.loads(d.revision_history or "[]")
    except (ValueError, TypeError):
        hist = []
    hist.insert(0, entry)
    d.revision_history = json.dumps(hist)


# ---- AI format ------------------------------------------------------------
_STD_SCHEMA = (
    'Return ONLY a JSON object (no markdown, no preamble) with this exact shape:\n'
    '{"title":string,"purpose":string,"scopeText":string,"materials":[string],'
    '"responsibilities":[{"role":string,"duty":string}],'
    '"definitions":[{"term":string,"def":string}],'
    '"procedure":[{"text":string,"detail":string}],"safety":[string],"references":[string]}\n'
    '- "procedure" is ordered; "text" is a concise imperative step, "detail" is an optional '
    'clarifying note ("" if none).\n'
    '- "materials" lists tools/equipment/required items. Keep wording professional and practical. '
    'Do not invent specifics; leave arrays empty if unknown.'
)


def _normalize_sop(o: dict) -> dict:
    o = o or {}
    def arr(x):
        return x if isinstance(x, list) else []
    return {
        "title": o.get("title", ""),
        "purpose": o.get("purpose", ""),
        "scopeText": o.get("scopeText") or o.get("scope", ""),
        "materials": [s if isinstance(s, str) else s.get("text", "") for s in arr(o.get("materials"))],
        "responsibilities": [{"role": r.get("role") or r.get("who", ""), "duty": r.get("duty") or r.get("responsibility", "")} for r in arr(o.get("responsibilities")) if isinstance(r, dict)],
        "definitions": [{"term": r.get("term", ""), "def": r.get("def") or r.get("definition", "")} for r in arr(o.get("definitions")) if isinstance(r, dict)],
        "procedure": [({"text": s, "detail": ""} if isinstance(s, str) else {"text": s.get("text") or s.get("step", ""), "detail": s.get("detail", "")}) for s in arr(o.get("procedure"))],
        "safety": [s if isinstance(s, str) else s.get("text", "") for s in arr(o.get("safety"))],
        "references": [s if isinstance(s, str) else s.get("text", "") for s in arr(o.get("references"))],
    }


def _heuristic_format(text: str, title: str) -> dict:
    """Offline fallback when the AI proxy is unavailable — best-effort structuring."""
    out = _normalize_sop({})
    out["title"] = title
    steps, refs, safety, materials = [], [], [], []
    purpose = ""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        clean = line.lstrip("-*•0123456789.) ").strip()
        if not clean:
            continue
        low = line.lower()
        if low.startswith(("purpose", "objective")) and (":" in line or "-" in line):
            purpose = line.split(":", 1)[-1].strip() if ":" in line else line.split("-", 1)[-1].strip()
        elif low.startswith(("materials", "tools", "equipment", "required")) and (":" in line):
            materials.append(line.split(":", 1)[-1].strip())
        elif any(w in clean.lower() for w in ("warning", "caution", "do not", "never", "must not", "safety")):
            safety.append(clean)
        elif any(w in clean.lower() for w in ("see ", "refer", "reference", "per ")) and len(clean) < 80:
            refs.append(clean)
        elif not purpose:
            purpose = clean
        else:
            steps.append(clean)
    out["purpose"] = purpose
    out["materials"] = materials
    out["safety"] = safety
    out["references"] = refs
    out["procedure"] = [{"text": s, "detail": ""} for s in steps]
    return out


@router.post("/ai-format")
def ai_format(payload: AiFormatIn, user: dict = Depends(get_current_user)):
    source = (payload.content or "").strip() or "\n".join(filter(None, [payload.title, ""]))
    if not source.strip():
        raise HTTPException(status_code=400, detail="Provide raw content or a title for the AI to work from")
    if not _ANTHROPIC_API_KEY:
        return {"source": "heuristic", "sop": _heuristic_format(payload.content, payload.title)}
    depts = ", ".join(payload.departments) or "Company-wide"
    prompt = (
        "You are a technical-documentation specialist for Greens Global, a self-storage and "
        "commercial real estate operator. Convert the source material into a standardized SOP.\n\n"
        f"{_STD_SCHEMA}\n\nDepartments: {depts}\nWorking title: {payload.title or '(none)'}\n\n"
        f'SOURCE MATERIAL:\n"""\n{payload.content}\n"""'
    )
    try:
        with httpx.Client(timeout=60) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": _ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _AI_MODEL,
                    "max_tokens": 2000,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            r.raise_for_status()
            data = r.json()
        text = "".join(blk.get("text", "") for blk in data.get("content", []) if blk.get("type") == "text")
        text = text.replace("```json", "").replace("```", "").strip()
        return {"source": "ai", "sop": _normalize_sop(json.loads(text))}
    except Exception as e:  # network, key, model, or parse failure — degrade gracefully
        print(f"[kb ai-format] falling back to heuristic: {e}")
        return {"source": "heuristic", "sop": _heuristic_format(payload.content, payload.title)}
