"""Task Module - config & misc router: saved views, automation rules, templates,
intake forms, custom fields, tickets, the module's own notification bell, and the
changelog/"What's New" feature. Single router, absolute paths, email-keyed.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Optional, Any
import os
import json
import subprocess
import httpx
import models
from database import get_db
from auth import get_current_user, require_level, require_manager, require_any_module_grant
from routers.task_util import now_iso, gen_id

router = APIRouter(tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets"))])


def _nz(v):
    return v if v not in ("", None) else None


# ── Saved views (per user) ───────────────────────────────────────────────────
def saved_view_to_dict(s: models.TaskSavedView) -> dict:
    return {"id": s.id, "ownerId": _nz(s.owner_email), "name": s.name, "view": s.view or "list",
            "filters": s.filters if isinstance(s.filters, dict) else {},
            "sort": s.sort if isinstance(s.sort, dict) else {}, "group": s.group or "none",
            "scope": s.scope or "task"}


class SavedViewBody(BaseModel):
    id: Optional[str] = None
    name: str
    view: Optional[str] = "list"
    filters: Optional[dict] = None
    sort: Optional[dict] = None
    group: Optional[str] = "none"


@router.get("/task-saved-views")
def list_saved_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.TaskSavedView)
            .filter(models.TaskSavedView.owner_email == user["email"].lower(),
                    models.TaskSavedView.scope != "ticket").all())
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-saved-views", status_code=201)
def create_saved_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", scope="task", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-saved-views/{view_id}", status_code=204)
def delete_saved_view(view_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSavedView).filter(models.TaskSavedView.id == view_id).delete()
    db.commit()



# ── Automation rules ─────────────────────────────────────────────────────────
def rule_to_dict(r: models.TaskAutomationRule) -> dict:
    return {"id": r.id, "name": r.name,
            "trigger": r.trigger if isinstance(r.trigger, dict) else {},
            "actions": r.actions if isinstance(r.actions, list) else [], "enabled": bool(r.enabled)}


class RuleBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH (e.g. enabled toggle) can send partial bodies; required on create (guarded below)
    trigger: Optional[dict] = None
    actions: Optional[list] = None
    enabled: Optional[bool] = None


@router.get("/task-automation-rules")
def list_rules(db: Session = Depends(get_db)):
    return [rule_to_dict(r) for r in db.query(models.TaskAutomationRule).all()]


@router.post("/task-automation-rules", status_code=201, dependencies=[Depends(require_manager)])
def create_rule(body: RuleBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Rule name is required")
    r = models.TaskAutomationRule(id=body.id or gen_id(), name=body.name, trigger=body.trigger or {},
                                  actions=body.actions or [],
                                  enabled=True if body.enabled is None else bool(body.enabled),
                                  created_at=now_iso())
    db.add(r)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.patch("/task-automation-rules/{rule_id}", dependencies=[Depends(require_manager)])
def update_rule(rule_id: str, body: RuleBody, db: Session = Depends(get_db)):
    r = db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.delete("/task-automation-rules/{rule_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_rule(rule_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).delete()
    db.commit()


# ── Templates ────────────────────────────────────────────────────────────────
def template_to_dict(t: models.TaskTemplate) -> dict:
    return {"id": t.id, "name": t.name, "description": t.description or "",
            "patch": t.patch if isinstance(t.patch, dict) else {},
            "subtaskTitles": t.subtask_titles or []}


class TemplateBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    patch: Optional[dict] = None
    subtask_titles: Optional[list] = None


@router.get("/task-templates")
def list_templates(db: Session = Depends(get_db)):
    return [template_to_dict(t) for t in db.query(models.TaskTemplate).all()]


@router.post("/task-templates", status_code=201, dependencies=[Depends(require_manager)])
def create_template(body: TemplateBody, db: Session = Depends(get_db)):
    t = models.TaskTemplate(id=body.id or gen_id(), name=body.name, description=body.description or "",
                            patch=body.patch or {}, subtask_titles=body.subtask_titles or [],
                            created_at=now_iso())
    db.add(t)
    db.commit()
    db.refresh(t)
    return template_to_dict(t)


@router.delete("/task-templates/{template_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_template(template_id: str, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    # Soft delete -> Recycle Bin, like every other deletable thing in the
    # module. The row stays, hidden by database.py's _hide_soft_deleted hook.
    t = (db.query(models.TaskTemplate).execution_options(include_deleted=True)
         .filter(models.TaskTemplate.id == template_id).first())
    if t:
        t.deleted_at = now_iso()
        t.deleted_by = user["email"]
    db.commit()


# ── Intake forms ─────────────────────────────────────────────────────────────
def intake_form_to_dict(f: models.TaskIntakeForm) -> dict:
    return {"id": f.id, "title": f.title, "fields": f.fields if isinstance(f.fields, list) else [],
            "targetProjectId": _nz(f.target_project_id)}


class IntakeFormBody(BaseModel):
    id: Optional[str] = None
    title: str
    fields: Optional[list] = None
    target_project_id: Optional[str] = ""


@router.get("/task-intake-forms")
def list_intake_forms(db: Session = Depends(get_db)):
    return [intake_form_to_dict(f) for f in db.query(models.TaskIntakeForm).all()]


@router.post("/task-intake-forms", status_code=201, dependencies=[Depends(require_manager)])
def create_intake_form(body: IntakeFormBody, db: Session = Depends(get_db)):
    f = models.TaskIntakeForm(id=body.id or gen_id(), title=body.title, fields=body.fields or [],
                              target_project_id=body.target_project_id or "", created_at=now_iso())
    db.add(f)
    db.commit()
    db.refresh(f)
    return intake_form_to_dict(f)


@router.delete("/task-intake-forms/{form_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_intake_form(form_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).delete()
    db.commit()


# ── Custom fields ────────────────────────────────────────────────────────────
_FIELD_PALETTE = ["#2563eb", "#0d9488", "#16a34a", "#7c3aed", "#d97706",
                  "#dc2626", "#db2777", "#0891b2", "#4f46e5", "#475569"]


def normalize_field_options(options, ) -> list:
    """Select options as [{id,label,color}].

    Rows written before options carried colors hold plain strings, and the task
    editors still send plain strings today, so both shapes have to read back the
    same or every existing select field would render blank. A missing color is
    assigned from the palette by position rather than left empty, so a field
    always has usable chips."""
    out = []
    for i, o in enumerate(options or []):
        if o is None:
            continue   # str(None) is "None", which would become a real option
        if isinstance(o, dict):
            label = str(o.get("label") or o.get("id") or "").strip()
            if not label:
                continue
            out.append({"id": str(o.get("id") or label), "label": label,
                        "color": o.get("color") or _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
        else:
            label = str(o).strip()
            if label:
                out.append({"id": label, "label": label, "color": _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
    return out


def _as_list(raw) -> list:
    """The list-typed kinds (multiselect, people) accept a bare scalar too - a
    field converted from select/text still holds one, and the Asana importer
    seeds a single value the same way."""
    if isinstance(raw, (list, tuple, set)):
        return list(raw)
    return [raw] if raw not in ("", None) else []


def _select_option_id(f: models.TaskCustomField, raw) -> str:
    """One select/multiselect value as its option id, or "" if it matches no
    option. Accepts either the id or the label - the task editors have
    historically sent plain labels, and Asana always sends the label."""
    allowed = {o["id"]: o for o in normalize_field_options(f.options or [])}
    by_label = {o["label"]: o["id"] for o in allowed.values()}
    key = str(raw)
    if key in allowed:
        return key
    if key in by_label:
        return by_label[key]
    # Case-insensitive last resort: Asana's option names and a hand-typed Nexus
    # option routinely differ only by case, and dropping the value over that
    # left the cell blank with no indication anything had arrived.
    lower = {lbl.strip().lower(): oid for lbl, oid in by_label.items()}
    return lower.get(key.strip().lower(), "")


def coerce_custom_field_values(db: Session, values) -> dict:
    """Store custom-field values in the shape their field declares.

    The column is a free JSON dict, so before this every value arrived as
    whatever the widget produced - numbers as strings, dates in whatever the
    input emitted, and selects holding labels that were no longer options after
    the field was edited. Nothing downstream could group, sort, or roll them up
    on that. Coercing here keeps the mess out of every reader.

    Unknown field ids are dropped (the field was deleted); a value that can't be
    coerced is dropped rather than stored wrong. Never raises - inbound Asana
    tasks come through the same create path and must not be rejected."""
    if not isinstance(values, dict) or not values:
        return {}
    defs = {f.id: f for f in db.query(models.TaskCustomField).all()}
    out = {}
    for fid, raw in values.items():
        f = defs.get(fid)
        if f is None or raw in ("", None):
            continue
        kind = (f.type or "text").lower()
        try:
            if kind == "number":
                n = float(raw)
                out[fid] = int(n) if n.is_integer() else n
            elif kind == "checkbox":
                out[fid] = raw if isinstance(raw, bool) else str(raw).strip().lower() in ("1", "true", "yes", "on")
            elif kind == "date":
                out[fid] = str(raw)[:10]
            elif kind == "select":
                out[fid] = _select_option_id(f, raw)
                if not out[fid]:
                    out.pop(fid)
            elif kind == "multiselect":
                # A list of option ids. Order is normalized to the field's own
                # option order so two equal sets can never digest differently
                # and make an unchanged task look changed on every Asana pull.
                order = [o["id"] for o in normalize_field_options(f.options or [])]
                ids = {oid for oid in (_select_option_id(f, v) for v in _as_list(raw)) if oid}
                out[fid] = [oid for oid in order if oid in ids]
                if not out[fid]:
                    out.pop(fid)
            elif kind == "people":
                # A list of Nexus work emails, lowercased and deduped. Sorted for
                # the same digest-stability reason as multiselect above.
                emails = sorted({str(v).strip().lower() for v in _as_list(raw)
                                 if str(v or "").strip() and "@" in str(v)})
                out[fid] = emails
                if not out[fid]:
                    out.pop(fid)
            else:
                out[fid] = str(raw)
        except (TypeError, ValueError):
            continue
    return out


def field_applies_to(f: models.TaskCustomField, project_id: str) -> bool:
    """Empty project_ids = a global field (every project), which is what every
    field was before scoping existed."""
    ids = [p for p in (f.project_ids or []) if p]
    return not ids or (project_id or "") in ids


_APPLIES_TO_KINDS = ("task", "project")


def _parse_applies_to(raw) -> list:
    """applies_to is stored as a JSON-encoded array string (e.g. '["task",
    "project"]') so a field can live on both entities at once. Rows written
    before multi-select existed (or seeded directly via SQL, like the
    built-in Location field) hold a bare 'task'/'project' string instead -
    both shapes read back the same rather than needing a backfill."""
    if not raw:
        return ["task"]
    if isinstance(raw, list):
        kinds = raw
    else:
        try:
            parsed = json.loads(raw)
            kinds = parsed if isinstance(parsed, list) else [parsed]
        except (TypeError, ValueError):
            kinds = [raw]   # legacy plain 'task' / 'project' string
    out = [k for k in _APPLIES_TO_KINDS if k in kinds]
    return out or ["task"]


def _dump_applies_to(kinds) -> str:
    out = [k for k in _APPLIES_TO_KINDS if k in (kinds or [])]
    return json.dumps(out or ["task"])


def custom_field_to_dict(f: models.TaskCustomField) -> dict:
    return {"id": f.id, "name": f.name, "description": _nz(f.description), "type": f.type or "text",
            "options": normalize_field_options(f.options if isinstance(f.options, list) else []),
            "projectIds": [p for p in (f.project_ids or []) if p],
            "required": bool(f.required), "readOnly": bool(f.read_only),
            "appliesTo": _parse_applies_to(f.applies_to)}


class CustomFieldBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    type: Optional[str] = "text"
    options: Optional[list] = None
    project_ids: Optional[list] = None
    required: Optional[bool] = None
    read_only: Optional[bool] = None
    applies_to: Optional[list] = None


@router.get("/task-custom-fields")
def list_custom_fields(db: Session = Depends(get_db)):
    return [custom_field_to_dict(f) for f in db.query(models.TaskCustomField).all()]


@router.post("/task-custom-fields", status_code=201)
def create_custom_field(body: CustomFieldBody, db: Session = Depends(get_db)):
    f = models.TaskCustomField(id=body.id or gen_id(), name=body.name, description=body.description or "",
                               type=body.type or "text",
                               options=normalize_field_options(body.options or []),
                               project_ids=[p for p in (body.project_ids or []) if p],
                               required=bool(body.required), read_only=bool(body.read_only),
                               applies_to=_dump_applies_to(body.applies_to))
    db.add(f)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.patch("/task-custom-fields/{field_id}")
def update_custom_field(field_id: str, body: CustomFieldBody, db: Session = Depends(get_db)):
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    if "options" in data:
        data["options"] = normalize_field_options(data["options"] or [])
    if "project_ids" in data:
        data["project_ids"] = [p for p in (data["project_ids"] or []) if p]
    if "applies_to" in data:
        data["applies_to"] = _dump_applies_to(data["applies_to"])
    for k, v in data.items():
        setattr(f, k, v)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.delete("/task-custom-fields/{field_id}", status_code=204)
def delete_custom_field(field_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).delete()
    db.commit()



# ── Asana, after the integration (removed Sep 2026) ─────────────────────────
@router.get("/asana-legacy/audit", dependencies=[Depends(require_manager)])
def asana_legacy_audit(limit: int = 200, db: Session = Depends(get_db)):
    """Read-only: every Nexus row still pointing at Asana-hosted content (dead
    now the workspace is gone), and the row counts of the archived asana_*
    tables. See asana_legacy.py."""
    import asana_legacy
    return asana_legacy.audit(db, limit=max(1, min(limit, 1000)))


# ── OCR (mobile "scan text" - quick-add ABC scanner) ─────────────────────────
# Extracts text from an uploaded photo via Tesseract. The engine (pytesseract +
# the `tesseract` binary) must be present on the host; if it isn't we return 501
# so the client can degrade gracefully instead of 500-ing.
# ── AI rephrase (task description editor) ────────────────────────────────────
_REPHRASE_MODEL = "claude-opus-5"
_REPHRASE_MAX_CHARS = 8000


class RephraseBody(BaseModel):
    text: str
    tone: Optional[str] = "clear"   # clear | concise | formal | friendly


_REPHRASE_TONES = {
    "clear": "Rewrite it to be clearer and better organized.",
    "concise": "Rewrite it to be as short as possible while keeping every fact.",
    "formal": "Rewrite it in a professional, formal register.",
    "friendly": "Rewrite it in a warm, approachable register.",
}


@router.post("/task-ai/rephrase")
def task_ai_rephrase(body: RephraseBody):
    """Rephrase a task description. Returns the suggestion only - the editor shows
    it beside the original and the user accepts or rejects it, so nothing is
    overwritten server-side.

    Plain text in, plain text out: the client sends the editor's text content and
    re-inserts the result as a paragraph, which keeps the model away from the
    document's HTML structure entirely. Same httpx-to-api.anthropic.com shape as
    routers/help.py and routers/hr_interviews.py rather than a new SDK dependency.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Nothing to rephrase.")
    if len(text) > _REPHRASE_MAX_CHARS:
        raise HTTPException(400, f"That's too long to rephrase (limit {_REPHRASE_MAX_CHARS} characters).")
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI rephrasing isn't configured on this server (no ANTHROPIC_API_KEY).")

    instruction = _REPHRASE_TONES.get((body.tone or "clear"), _REPHRASE_TONES["clear"])
    prompt = (
        "The following is the description of a task in an internal company work-tracking "
        "tool. " + instruction + "\n\n"
        "Rules:\n"
        "- Keep every fact, name, date, number, and link exactly as given. Do not invent details.\n"
        "- Keep it in American English.\n"
        "- Preserve the paragraph and list structure of the original.\n"
        "- Output ONLY the rewritten description. No preamble, no quotes, no code fences, "
        "no commentary about what you changed.\n\n"
        "DESCRIPTION:\n" + text
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
                    "model": _REPHRASE_MODEL,
                    "max_tokens": 4000,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:   # noqa: BLE001
        print(f"[task-ai] rephrase failed: {e}")
        raise HTTPException(502, "The rephrase service didn't respond. Try again.")

    # A safety decline comes back as a normal 200 with stop_reason "refusal" and
    # empty content - check it before reading blocks, or this returns "" as if it
    # had succeeded.
    if data.get("stop_reason") == "refusal":
        raise HTTPException(422, "The model declined to rewrite that text.")
    out = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if not out:
        raise HTTPException(502, "The rephrase service returned nothing. Try again.")
    return {"text": out, "model": _REPHRASE_MODEL}


@router.post("/task-ocr")
async def task_ocr(image: UploadFile = File(...)):
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty image")
    try:
        import io
        from PIL import Image
        import pytesseract
    except Exception:
        raise HTTPException(501, "OCR engine is not installed on the server")
    try:
        img = Image.open(io.BytesIO(raw))
        text = pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError:
        raise HTTPException(501, "Tesseract binary is not available on the server")
    except Exception as exc:
        raise HTTPException(500, f"Could not read the image: {exc}")
    return {"text": (text or "").strip()}


# ── Notifications (module's own bell) ────────────────────────────────────────
def notification_to_dict(n: models.TaskNotification) -> dict:
    return {"id": n.id, "kind": n.kind or "", "title": n.title or "", "body": n.body or "",
            "forUserId": n.for_email or "", "requestId": _nz(n.request_id),
            "departmentId": _nz(n.department_id), "taskId": _nz(n.task_id),
            "read": bool(n.read), "createdAt": n.created_at or ""}


@router.get("/task-notifications")
def list_notifications(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    q = db.query(models.TaskNotification)
    if user["level"] >= 4:  # admins also see the "admins" fan-out
        q = q.filter(or_(models.TaskNotification.for_email == email,
                         models.TaskNotification.for_email == "admins"))
    else:
        q = q.filter(models.TaskNotification.for_email == email)
    rows = q.order_by(models.TaskNotification.created_at.desc()).limit(500).all()
    return [notification_to_dict(n) for n in rows]


@router.post("/task-notifications/{notif_id}/read")
def mark_notification_read(notif_id: str, db: Session = Depends(get_db)):
    n = db.query(models.TaskNotification).filter(models.TaskNotification.id == notif_id).first()
    if not n:
        raise HTTPException(404, "Notification not found")
    n.read = True
    db.commit()
    return {"ok": True}


@router.post("/task-notifications/read-all")
def mark_all_read(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    targets = [email] + (["admins"] if user["level"] >= 4 else [])
    db.query(models.TaskNotification).filter(
        models.TaskNotification.for_email.in_(targets),
        models.TaskNotification.read == False,  # noqa: E712
    ).update({models.TaskNotification.read: True}, synchronize_session=False)
    db.commit()
    return {"ok": True}


# ── Changelog / What's New ───────────────────────────────────────────────────
def changelog_entry_to_dict(e: models.TaskChangelogEntry) -> dict:
    payload = e.payload if isinstance(e.payload, dict) else {}
    return {**payload, "id": e.id, "createdAt": e.created_at or "", "updatedAt": e.updated_at or ""}


def changelog_comment_to_dict(c: models.TaskChangelogComment) -> dict:
    return {"id": c.id, "entryId": c.entry_id, "authorId": _nz(c.author_email),
            "body": c.body or "", "createdAt": c.created_at or ""}


class ChangelogEntryBody(BaseModel):
    id: Optional[str] = None
    payload: dict[str, Any]


class ChangelogCommentBody(BaseModel):
    id: Optional[str] = None
    body: str


@router.get("/task-changelog")
def list_changelog(db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogEntry).order_by(models.TaskChangelogEntry.created_at.desc()).all()
    return [changelog_entry_to_dict(e) for e in rows]


def _mark_changelog_seen(db: Session, email: str) -> None:
    """Whoever just published an entry has obviously seen it - stamp their own
    row so the eye-icon badge doesn't light up for their own publish."""
    email = (email or "").lower().strip()
    if not email:
        return
    row = db.query(models.ChangelogSeen).filter(models.ChangelogSeen.email == email).first()
    now = now_iso()
    if row:
        row.last_seen_at = now
    else:
        db.add(models.ChangelogSeen(email=email, last_seen_at=now))


@router.post("/task-changelog", status_code=201)
def create_changelog(body: ChangelogEntryBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    e = models.TaskChangelogEntry(id=body.id or gen_id(), payload=body.payload or {},
                                  created_at=now, updated_at=now)
    db.add(e)
    if (body.payload or {}).get("status") == "Released":
        _mark_changelog_seen(db, user["email"])
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.patch("/task-changelog/{entry_id}")
def update_changelog(entry_id: str, body: ChangelogEntryBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    e.payload = body.payload or {}
    e.updated_at = now_iso()
    if (body.payload or {}).get("status") == "Released":
        _mark_changelog_seen(db, user["email"])
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.get("/task-changelog/unseen")
def get_changelog_unseen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Powers the red-dot eye icon next to the profile pill: true when a
    published (Released) entry exists that is newer than this user's last
    visit to What's New."""
    rows = db.query(models.TaskChangelogEntry).all()
    latest = ""
    for e in rows:
        payload = e.payload if isinstance(e.payload, dict) else {}
        if payload.get("status") != "Released":
            continue
        key = payload.get("releasedAt") or e.created_at or ""
        if key > latest:
            latest = key
    if not latest:
        return {"unseen": False}
    seen = db.query(models.ChangelogSeen).filter(
        models.ChangelogSeen.email == user["email"].lower()).first()
    return {"unseen": not seen or (seen.last_seen_at or "") < latest}


@router.post("/task-changelog/seen")
def mark_changelog_seen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _mark_changelog_seen(db, user["email"])
    db.commit()
    return {"ok": True}


@router.delete("/task-changelog/{entry_id}", status_code=204)
def delete_changelog(entry_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).delete()
    db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.entry_id == entry_id).delete()
    db.commit()


@router.get("/task-changelog/{entry_id}/comments")
def list_changelog_comments(entry_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogComment).filter(
        models.TaskChangelogComment.entry_id == entry_id).all()
    return [changelog_comment_to_dict(c) for c in rows]


@router.post("/task-changelog/{entry_id}/comments", status_code=201)
def add_changelog_comment(entry_id: str, body: ChangelogCommentBody,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = models.TaskChangelogComment(id=body.id or gen_id(), entry_id=entry_id,
                                    author_email=user["email"].lower(), body=body.body or "",
                                    created_at=now_iso())
    db.add(c)
    db.commit()
    db.refresh(c)
    return changelog_comment_to_dict(c)


# ── Generate changelog drafts from git commits ───────────────────────────────
# Admin clicks "Generate from git" in Manage → we pull recent commits (GitHub API
# in prod, local `git log` in dev), ask Claude to cluster them into a few
# user-facing, plain-English "What's New" entries, and file them as origin='pr'
# / status='Pending Review'. They then flow through the normal review → publish.
_AI_MODEL = "claude-opus-4-8"
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
_GITHUB_REPO = os.getenv("GITHUB_REPO", "Greens-Global/Greens-Nexus")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_CHANGE_TYPES = ["Bug Fix", "Performance", "New Feature", "Security Update",
                 "Hotfix", "Maintenance", "Improvement"]


def deployment_branch() -> str:
    """Which branch THIS deployment IS - "dev", "main", or "" off Azure.

    Derived from WEBSITE_SITE_NAME the same way app_url.py splits dev from prod
    ("dev" anywhere in the name), so neither App Service needs configuring;
    NEXUS_CHANGELOG_BRANCH overrides it if the naming ever stops matching. Read
    fresh on every call rather than cached at import, for app_url.py's
    documented reason: during warm-up the value can arrive slot-suffixed, and
    prod deploys through a staging slot.

    "" means no deployment identity (a laptop) - callers decide what that
    means for them, which is why tracked_branch() below is separate.
    """
    override = os.getenv("NEXUS_CHANGELOG_BRANCH", "").strip()
    if override:
        return override
    site = os.getenv("WEBSITE_SITE_NAME", "").strip().lower()
    if not site:
        return ""
    return "dev" if "dev" in site else "main"


def tracked_branch() -> str:
    """The branch this deployment summarises: which commits it reads, and the
    only merges its changelog reacts to. Off Azure there is no deployment to
    speak of, so it reads dev - the repo's default branch, and what a laptop
    would have gotten anyway."""
    return deployment_branch() or "dev"


def _is_noise(subject: str) -> bool:
    s = (subject or "").strip().lower()
    return not s or s.startswith("merge ")


def _recent_commits(limit: int = 80) -> tuple[list[dict], str]:
    """Return ([{sha, author, date, subject, body}], source). Prefers the GitHub
    API (works on the deployed backend, which has no working tree); falls back to
    a local `git log` when a repo is present (dev)."""
    if _GITHUB_TOKEN:
        try:
            with httpx.Client(timeout=30) as client:
                r = client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}/commits",
                    params={"per_page": min(limit, 100), "sha": tracked_branch()},
                    headers={"Authorization": f"Bearer {_GITHUB_TOKEN}",
                             "Accept": "application/vnd.github+json"},
                )
                r.raise_for_status()
            out = []
            for row in r.json():
                commit = row.get("commit", {}) or {}
                subject, _, cbody = (commit.get("message", "") or "").partition("\n")
                out.append({"sha": row.get("sha", ""),
                            "author": (commit.get("author") or {}).get("name", ""),
                            "date": (commit.get("author") or {}).get("date", ""),
                            "subject": subject.strip(), "body": cbody.strip()})
            return out, "github"
        except Exception as e:  # noqa: BLE001
            print(f"[changelog] GitHub fetch failed, trying local git: {e}")
    try:
        sep, rec = "\x1f", "\x1e"
        fmt = sep.join(["%H", "%an", "%aI", "%s", "%b"]) + rec
        raw = subprocess.check_output(
            ["git", "-C", _REPO_ROOT, "log", f"-n{limit}", "--no-merges", f"--pretty=format:{fmt}"],
            text=True, encoding="utf-8", errors="replace",
        )
        out = []
        for chunk in raw.split(rec):
            chunk = chunk.strip("\n")
            if not chunk.strip():
                continue
            parts = chunk.split(sep)
            if len(parts) < 4:
                continue
            out.append({"sha": parts[0], "author": parts[1], "date": parts[2],
                        "subject": parts[3], "body": parts[4] if len(parts) > 4 else ""})
        return out, "git"
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] local git log failed: {e}")
        return [], "none"


def _known_shas(db: Session) -> set[str]:
    """8-char prefixes of every commit already summarised into an entry."""
    seen: set[str] = set()
    for e in db.query(models.TaskChangelogEntry).all():
        payload = e.payload if isinstance(e.payload, dict) else {}
        for s in (payload.get("commitShas") or []):
            if s:
                seen.add(s[:8])
    return seen


def _cluster_commits(commits: list[dict]) -> list[dict]:
    """Ask Claude to fold the commits into a few plain-English feature entries."""
    if not _ANTHROPIC_API_KEY or not commits:
        return []
    lines = []
    for c in commits:
        line = f"- [{c['sha'][:8]}] {c['subject']}"
        if c.get("body"):
            line += f" - {c['body'][:240].replace(chr(10), ' ')}"
        lines.append(line)
    commit_block = "\n".join(lines)
    prompt = (
        "You turn a list of git commits from the Nexus internal staff portal "
        "(\"Nexus\") into a short changelog for NON-TECHNICAL business users.\n\n"
        "Group related commits into a small number of user-facing updates (usually 1-6). "
        "SKIP commits that are pure chores, refactors, tests, docs, build/CI, dependency "
        "bumps, or internal plumbing with no visible effect - if nothing is user-facing, "
        "return an empty array. Never use commit hashes, branch names, ticket IDs, code "
        "identifiers, or engineering jargon in the text. Be concrete about the user-visible effect.\n\n"
        f"Allowed \"type\" values: {', '.join(_CHANGE_TYPES)}.\n\n"
        "Return ONLY a JSON array (no prose, no code fences). Each element:\n"
        '{ "title": string (short, plain English, no jargon),\n'
        '  "description": string (1-3 sentences a non-technical user understands),\n'
        '  "type": one of the allowed values,\n'
        '  "module": string (product area, e.g. HR, Dashboard, Tasks, Item Management),\n'
        '  "businessImpact": string (one sentence: the plain-English payoff),\n'
        '  "whatsChanged": string[] (2-5 short plain-English bullets),\n'
        '  "commitShas": string[] (the 8-char hashes from the list you grouped into this entry) }\n\n'
        f"COMMITS:\n{commit_block}"
    )
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _ANTHROPIC_API_KEY,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": _AI_MODEL, "max_tokens": 6000,
                      "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end == -1:
            return []
        parsed = json.loads(text[start:end + 1])
        return parsed if isinstance(parsed, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] cluster failed: {e}")
        return []


def generate_changelog_from_commits(db: Session, author_email: str = "") -> dict:
    """Core of "Generate from git": pull recent commits, ask Claude to cluster
    them into plain-English draft entries, file them as Pending Review. Shared
    by the manual endpoint below and, since Sep 2026, the GitHub webhook
    (routers/github_webhook.py), which calls this from a background thread
    right after a dev/main merge - so it has no signed-in `user` to attribute
    the drafts to (author_email defaults to "", which the UI shows as
    "Unknown"), and returns an {"error": ...} dict instead of raising, since a
    background caller has no HTTP response to attach an exception to."""
    if not _ANTHROPIC_API_KEY:
        return {"error": "AI is not configured (ANTHROPIC_API_KEY missing)."}
    commits, source = _recent_commits()
    if source == "none":
        return {"error": "Could not read commit history (no GitHub token and no local repo)."}
    known = _known_shas(db)
    fresh = [c for c in commits if not _is_noise(c["subject"]) and c["sha"][:8] not in known]
    if not fresh:
        return {"created": 0, "scanned": len(commits), "source": source,
                "message": "No new commits to summarise since the last update."}

    drafts = _cluster_commits(fresh[:40])
    created = []
    now = now_iso()
    for d in drafts:
        if not isinstance(d, dict) or not (d.get("title") and d.get("description")):
            continue
        ctype = d.get("type") if d.get("type") in _CHANGE_TYPES else "Improvement"
        shas = [s[:8] for s in (d.get("commitShas") or []) if isinstance(s, str)]
        payload = {
            "title": str(d["title"]).strip(),
            "description": str(d["description"]).strip(),
            "type": ctype,
            "module": str(d.get("module") or "").strip(),
            "version": "unreleased",
            "environment": "Production",
            "releasedAt": now[:16],
            "authorId": (author_email or "").lower(),
            "businessImpact": str(d.get("businessImpact") or "").strip() or None,
            "whatsChanged": [str(x).strip() for x in (d.get("whatsChanged") or []) if str(x).strip()][:5],
            "commitShas": shas,
            "origin": "pr",
            "status": "Pending Review",
        }
        e = models.TaskChangelogEntry(id=gen_id(), payload=payload, created_at=now, updated_at=now)
        db.add(e)
        created.append(e)
    db.commit()
    for e in created:
        db.refresh(e)
    return {"created": len(created), "scanned": len(fresh), "source": source,
            "entries": [changelog_entry_to_dict(e) for e in created]}


@router.post("/task-changelog/generate")
def generate_changelog(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    result = generate_changelog_from_commits(db, user["email"])
    if "error" in result:
        raise HTTPException(503, result["error"])
    return result
