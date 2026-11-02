"""Forms & Checklists - fill, entries, review, PDF, CSV (Neil, 11/02/2026;
spec docs/superpowers/specs/2026-11-02-forms-design.md).

A form is a DocTemplate with doc_type 'form' - built, published, previewed,
duplicated and archived through routers/documents.py like every template.
This router is the FILL side and what comes after:

    GET  /forms/mine                        the forms this person may fill
    GET  /forms/{tid}                       the fill payload (released fields)
    POST /forms/{tid}/entries               submit (idempotent on entryKey)
    GET  /forms/entries                     the viewer's reach, filtered, paged
    GET  /forms/entries/{id}
    POST /forms/entries/{id}/review         reviewed | follow_up | closed + note
    POST /forms/entries/{id}/link           {ticketId | taskId | assetId}
    GET  /forms/entries/{id}/pdf
    GET  /forms/templates/{tid}/export.csv  one row per entry, one column per token

Who may fill and who sees entries: form_audience.py (one rule, shared with
Announcements). What the answers must obey: form_rules.py (the server checks
required / showIf / formats / repeat groups again at submit, drops hidden and
unknown tokens, validates every photo and signature URL with
routers.items._validate_photo_url, and works formulas out itself). Nothing
here changes an entry's state by itself - a person reviews it.

Workflows (the documents pack, workflows/packs/documents.py): ONE
`workflows.emit` at each choke point, inside the transaction, never after
the commit - `form.submitted` in submit_entry right after `db.add(row)`
(a retry on the same entryKey returns the first entry and emits nothing),
`form.reviewed` in review_entry after the status change. `extra` is the
stored answers FLAT plus `form` (the title), so `{{ event.<token> }}`
resolves in a workflow.
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
import form_audience
import form_entry_pdf
import form_rules
import workflows
from auth import get_current_user
from database import get_db
from models import DocFormEntry, DocTemplate, DocTemplateVersion, HrWorkSite, NexusEmployee, NexusNotification
from routers.documents import _content_disposition, _released, _require_template_manager
from routers.hr import company_sites
from routers.items import _validate_photo_url

router = APIRouter(prefix="/forms", tags=["forms"])

PAGE_SIZE = 50
SOURCES = ("web", "phone")
REVIEW_STATUSES = ("reviewed", "follow_up", "closed")
STATUSES = ("submitted",) + REVIEW_STATUSES
NOTICE_TYPE = "form_review"
NOTE_MAX = 2000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(s) -> str:
    return (s or "").strip().lower()


# ── Lookups ───────────────────────────────────────────────────────────────

def _names(db: Session, emails: set) -> dict:
    emails = {e for e in (_norm(x) for x in emails) if e}
    if not emails:
        return {}
    out = {}
    for e in db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email).in_(emails)).all():
        out[_norm(e.work_email)] = (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip() or e.work_email
    return out


def _site_names(db: Session, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {s.id: s.name for s in db.query(HrWorkSite).filter(HrWorkSite.id.in_(ids)).all()}


def _ser_entry(e: DocFormEntry, *, names: dict, sites: dict, reach: form_audience.Reach) -> dict:
    return {
        "id": e.id, "templateId": e.template_id, "templateVersion": e.template_version or 0,
        "title": e.title or "", "entryKey": e.entry_key,
        "answers": e.answers if isinstance(e.answers, dict) else {},
        "company": e.company or "", "workSiteId": e.work_site_id or "",
        "workSiteName": sites.get(e.work_site_id or "", ""),
        "shiftId": e.shift_id or "",
        "submittedBy": e.submitted_by or "",
        "submittedByName": names.get(_norm(e.submitted_by), e.submitted_by or ""),
        "submittedAt": e.submitted_at or "", "source": e.source or "web",
        "status": e.status or "submitted",
        "reviewerEmail": e.reviewer_email or "", "reviewedAt": e.reviewed_at or "",
        "reviewerName": names.get(_norm(e.reviewer_email), e.reviewer_email or "") if e.reviewer_email else "",
        "reviewNote": e.review_note or "",
        "linkedTicketId": e.linked_ticket_id or "", "linkedTaskId": e.linked_task_id or "",
        "linkedAssetId": e.linked_asset_id or "",
        "canReview": reach.can_review(e),
    }


def _serialize_many(db: Session, rows: list, reach: form_audience.Reach) -> list:
    names = _names(db, {r.submitted_by for r in rows} | {r.reviewer_email for r in rows if r.reviewer_email})
    sites = _site_names(db, {r.work_site_id for r in rows})
    return [_ser_entry(r, names=names, sites=sites, reach=reach) for r in rows]


def _form_template(db: Session, tid: str) -> DocTemplate:
    """A live form, or 404 - a document template is not a form, and a draft or
    an archived form is nobody's to fill."""
    tpl = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if tpl is None or (tpl.doc_type or "") != "form":
        raise HTTPException(404, "Form not found")
    return tpl


def _fillable(db: Session, tid: str, user: dict) -> DocTemplate:
    tpl = _form_template(db, tid)
    if not form_audience.may_fill(db, tpl, user["email"], level=user.get("level", 0)):
        raise HTTPException(404, "Form not found")
    return tpl


def _defs(db: Session, tpl: DocTemplate) -> tuple:
    """(released field defs, released version)."""
    released = _released(db, tpl)
    return list(released.get("fieldDefs") or []), int(released.get("version") or tpl.version or 1)


def _entry_defs(db: Session, tpl: DocTemplate, version: int) -> list:
    """The field defs an entry was filled against: its pinned version's, as
    that version was published (DocTemplateVersion.field_defs), else - a
    version published before versions kept their fields - the released
    ones."""
    if version:
        v = (db.query(DocTemplateVersion)
             .filter(DocTemplateVersion.template_id == tpl.id, DocTemplateVersion.version_no == int(version)).first())
        if v is not None and isinstance(v.field_defs, list):
            return list(v.field_defs)
    return _defs(db, tpl)[0]


def _ser_form(tpl: DocTemplate, version: int) -> dict:
    return {"id": tpl.id, "title": tpl.name, "category": tpl.category or "other",
            "description": "", "version": version,
            "audience": tpl.audience or "company", "department": tpl.department or "",
            "workSiteId": tpl.work_site_id or "", "showOnShifts": bool(tpl.show_on_shifts)}


def _get_entry(db: Session, eid: str, reach: form_audience.Reach, *, lock: bool = False) -> DocFormEntry:
    q = db.query(DocFormEntry).filter(DocFormEntry.id == eid, DocFormEntry.deleted_at == "")
    if lock:
        q = q.with_for_update()
    row = q.first()
    if row is None or not reach(row):
        raise HTTPException(404, "Entry not found")
    return row


# ── Fill ──────────────────────────────────────────────────────────────────

@router.get("/mine")
def my_forms(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The live forms this person may fill, by name - what Workday's Fill a
    Form tile, the shift card (`workSiteId` + `showOnShifts`), the + menu
    and the Quick Actions dock list."""
    rows = form_audience.fillable_for(db, user["email"], level=user.get("level", 0))
    return [_ser_form(t, t.published_version or t.version or 1) for t in rows]


class EntryIn(BaseModel):
    entryKey: str
    answers: dict
    workSiteId: Optional[str] = ""
    shiftId: Optional[str] = ""
    source: Optional[str] = "web"
    gps: Optional[dict] = None


def _check_file_urls(defs: list, answers: dict) -> None:
    """Every photo / signature / image / file value must be one of our storage
    URLs (routers.items._validate_photo_url) - inside repeat rows too."""
    def check(d, v):
        label = d.get("label") or d.get("token")
        if d.get("type") == "photo":
            for u in (v if isinstance(v, list) else [v]):
                if isinstance(u, str):
                    _validate_photo_url(u, label)
        elif d.get("type") in ("signature", "image", "file") and isinstance(v, str):
            _validate_photo_url(v, label)

    for d in defs:
        g = form_rules.group_of(d)
        if g:
            for row in (answers.get(g) or []):
                if isinstance(row, dict) and d["token"] in row:
                    check(d, row[d["token"]])
        elif d["token"] in answers:
            check(d, answers[d["token"]])


def _same_key(db: Session, key: str, tid: str, me: str):
    """The entry already filed under `key`, or None. 409 when the key is
    another person's or another form's - a key never opens someone else's
    entry."""
    row = db.query(DocFormEntry).filter(DocFormEntry.entry_key == key).first()
    if row is None:
        return None
    if _norm(row.submitted_by) != me or row.template_id != tid:
        raise HTTPException(409, "That entry key belongs to another entry")
    return row


@router.post("/{tid}/entries")
def submit_entry(tid: str, body: EntryIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """File one entry. The same entryKey a second time (a retry after a
    dropped signal) returns the first entry, never a second row."""
    key = (body.entryKey or "").strip()[:80]
    if not key:
        raise HTTPException(400, "entryKey is required")
    me = _norm(user["email"])
    # Before the fill check: a retry of an entry already filed returns it even
    # when the form was archived (or the person moved out of its audience)
    # since the first send.
    existing = _same_key(db, key, tid, me)
    if existing is not None:
        return _serialize_many(db, [existing], form_audience.viewer_reach(db, user))[0]
    tpl = _fillable(db, tid, user)

    defs, version = _defs(db, tpl)
    source = (body.source or "web").strip().lower()
    if source not in SOURCES:
        raise HTTPException(400, f"source must be one of {', '.join(SOURCES)}")
    answers = form_rules.clean(defs, body.answers or {})
    errors = form_rules.validate(defs, answers)
    if errors:
        raise HTTPException(400, {"message": "Check the form", "errors": errors})
    _check_file_urls(defs, answers)
    answers = form_rules.compute(defs, answers)
    if isinstance(body.gps, dict):
        stamp = form_rules._coerce({"type": "gps"}, body.gps)
        if isinstance(stamp, dict) and "lat" in stamp and "lng" in stamp:
            answers["_location"] = stamp

    # A site form is filed at its site whatever the client sent; any other
    # form at one of the submitter's company's sites (the list the fill
    # screen offers), or at none.
    company = auth.company_of(me, db)
    if tpl.work_site_id:
        site_id = tpl.work_site_id
    else:
        site_id = (body.workSiteId or "").strip()
        if site_id and site_id not in {s.id for s in company_sites(db, company)}:
            raise HTTPException(400, "Unknown work site")
    now = _now_iso()
    row = DocFormEntry(id=str(uuid.uuid4()), template_id=tpl.id, template_version=version,
                       title=tpl.name, entry_key=key, answers=answers,
                       company=company, work_site_id=site_id,
                       shift_id=(body.shiftId or "").strip()[:80], submitted_by=me, submitted_at=now,
                       source=source, status="submitted", deleted_at="")
    db.add(row)
    workflows.emit(db, "form.submitted", subject=row, actor=me, extra={**answers, "form": tpl.name})
    try:
        db.commit()
    except IntegrityError:
        # Two retries raced: the first one's row is the entry - when it is
        # this person's, on this form (the same check as before the insert).
        db.rollback()
        row = _same_key(db, key, tpl.id, me)
        if row is None:
            raise HTTPException(409, "Could not file the entry - try again")
    db.refresh(row)
    return _serialize_many(db, [row], form_audience.viewer_reach(db, user))[0]


# ── Entries ───────────────────────────────────────────────────────────────

def _day_bounds(from_: str, to: str) -> tuple:
    """ISO bounds for YYYY-MM-DD query dates (the API speaks ISO; screens
    show MM/DD/YYYY). Bad text = no bound."""
    lo = hi = ""
    try:
        if from_:
            lo = date.fromisoformat(from_[:10]).isoformat()
        if to:
            hi = (date.fromisoformat(to[:10]) + timedelta(days=1)).isoformat()
    except ValueError:
        pass
    return lo, hi


@router.get("/entries")
def list_entries(template: str = "", site: str = "", status: str = "", from_: str = Query("", alias="from"),
                 to: str = "", person: str = "", page: int = 1,
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Entries within the caller's reach, newest first, 50 a page."""
    reach = form_audience.viewer_reach(db, user)
    q = db.query(DocFormEntry).filter(DocFormEntry.deleted_at == "")
    if template:
        q = q.filter(DocFormEntry.template_id == template)
    if site:
        q = q.filter(DocFormEntry.work_site_id == site)
    if status:
        if status not in STATUSES:
            raise HTTPException(400, f"status must be one of {', '.join(STATUSES)}")
        q = q.filter(DocFormEntry.status == status)
    if person:
        q = q.filter(func.lower(DocFormEntry.submitted_by) == _norm(person))
    lo, hi = _day_bounds(from_, to)
    if lo:
        q = q.filter(DocFormEntry.submitted_at >= lo)
    if hi:
        q = q.filter(DocFormEntry.submitted_at < hi)
    rows = [r for r in q.order_by(DocFormEntry.submitted_at.desc()).all() if reach(r)]
    page = max(1, int(page or 1))
    start = (page - 1) * PAGE_SIZE
    return {"items": _serialize_many(db, rows[start:start + PAGE_SIZE], reach),
            "total": len(rows), "page": page, "pageSize": PAGE_SIZE}


@router.get("/entries/{eid}")
def get_entry(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach)
    out = _serialize_many(db, [row], reach)[0]
    # The labels and sections the entry was filled with (its pinned version).
    tpl = db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
    out["fieldDefs"] = _entry_defs(db, tpl, row.template_version or 0) if tpl is not None else []
    return out


class ReviewIn(BaseModel):
    status: str
    note: Optional[str] = ""


def _bell_submitter(db: Session, entry: DocFormEntry, reviewer: str) -> None:
    """One bell per entry to its submitter, rewritten in place (CLAUDE.md:
    one notification per workflow, updated in place)."""
    from notify_company import notification_company
    to = _norm(entry.submitted_by)
    if not to or to == _norm(reviewer):
        return
    word = form_entry_pdf.STATUS_WORDS.get(entry.status, entry.status.title())
    title = f"{entry.title} {word}"
    who = form_entry_pdf.person_name(db, reviewer)
    when = form_entry_pdf.us_datetime(entry.submitted_at, form_entry_pdf.person_zone(db, to))   # the reader's clock
    body = f"{who} marked your {entry.title} from {when} as {word}."
    if entry.review_note:
        body += f" Note: {entry.review_note}"
    # The sub opens THIS entry beside the list (views/Documents.jsx -> FormsTab).
    action = json.dumps({"view": "documents", "sub": f"documents-forms:entry:{entry.id}", "entryId": entry.id,
                         "label": "Open Entry"})
    ref = f"form-entry:{entry.id}"
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == NOTICE_TYPE, NexusNotification.ref_id == ref,
                   NexusNotification.recipient == to).with_for_update().first())
    if row is None:
        db.add(NexusNotification(id=str(uuid.uuid4()), type=NOTICE_TYPE, recipient=to, title=title, body=body,
                                 ref_id=ref, item_name=entry.title or "", requested_by=_norm(reviewer),
                                 action=action, actioned=False, read_by="",
                                 company=notification_company(db, entry.submitted_by, reviewer),
                                 created_at=_now_iso(), priority=1 if entry.status == "follow_up" else 0))
        return
    row.title, row.body, row.action = title, body, action
    row.read_by, row.actioned, row.created_at = "", False, _now_iso()
    row.priority = 1 if entry.status == "follow_up" else 0


@router.post("/entries/{eid}/review")
def review_entry(eid: str, body: ReviewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Reviewed, Needs Follow-Up or Closed, with a note - by the submitter's
    manager, a manager of the site's team, HR++ or an administrator. Never
    your own (403). The submitter gets one bell."""
    status = (body.status or "").strip().lower()
    if status not in REVIEW_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(REVIEW_STATUSES)}")
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach, lock=True)
    if not reach.can_review(row):
        raise HTTPException(403, "You cannot review your own form")
    prev_status = row.status or "submitted"
    row.status = status
    row.reviewer_email = _norm(user["email"])
    row.reviewed_at = _now_iso()
    row.review_note = (body.note or "").strip()[:NOTE_MAX]
    _bell_submitter(db, row, user["email"])
    answers = row.answers if isinstance(row.answers, dict) else {}
    workflows.emit(db, "form.reviewed", subject=row, actor=row.reviewer_email,
                   changes={"status": (prev_status, status)},
                   extra={**answers, "form": row.title or "", "decision": status, "note": row.review_note})
    db.commit(); db.refresh(row)
    return _serialize_many(db, [row], reach)[0]


class LinkIn(BaseModel):
    ticketId: Optional[str] = None
    taskId: Optional[str] = None
    assetId: Optional[str] = None


def _ticket_ok(db: Session, user: dict, scope, tid: str) -> bool:
    """The ticket exists, sits inside the caller's company walls, and - a
    confidential one - is theirs to read (ticket_confidential.may_read)."""
    import ticket_confidential
    from models import TaskTicket
    t = (db.query(TaskTicket).execution_options(include_confidential=True)
         .filter(TaskTicket.id == tid).first())
    return (t is not None and auth.company_ok(t.company_id or "", scope, shared_when_blank=True)
            and ticket_confidential.may_read(db, user, t))


def _task_ok(db: Session, scope, tid: str) -> bool:
    """The task exists (not trashed) inside the caller's company walls."""
    from models import Task
    from routers.task_util import task_company
    t = db.query(Task).filter(Task.id == tid).first()
    if t is None:
        return False
    company = task_company(t, auth.company_of_email_map(db)) if scope is not None else ""
    return auth.company_ok(company, scope, shared_when_blank=True)


def _asset_ok(db: Session, user: dict, aid: str) -> bool:
    """The asset exists, is not in the Trash, and is not a private asset the
    caller may not see (property_links.viewable). Assets carry no company."""
    import property_links
    from models import PropertyAsset
    prop = db.get(PropertyAsset, aid)
    return property_links.viewable(prop, user) and not (prop.payload or {}).get("deleted")


@router.post("/entries/{eid}/link")
def link_entry(eid: str, body: LinkIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Remember the ticket / task / asset made from this entry (the record
    itself is created through the existing calls). Only someone who may
    review the entry links it, and only to a record they may see; a blank
    id clears the link."""
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach, lock=True)
    if not reach.can_review(row):
        raise HTTPException(403, "Only a reviewer can link this entry")
    if body.ticketId is None and body.taskId is None and body.assetId is None:
        raise HTTPException(400, "Nothing to link")
    ticket_id = (body.ticketId or "").strip()[:80]
    task_id = (body.taskId or "").strip()[:80]
    asset_id = (body.assetId or "").strip()[:80]
    if ticket_id and not _ticket_ok(db, user, reach.scope, ticket_id):
        raise HTTPException(404, "Ticket not found")
    if task_id and not _task_ok(db, reach.scope, task_id):
        raise HTTPException(404, "Task not found")
    if asset_id and not _asset_ok(db, user, asset_id):
        raise HTTPException(404, "Asset not found")
    if body.ticketId is not None:
        row.linked_ticket_id = ticket_id
    if body.taskId is not None:
        row.linked_task_id = task_id
    if body.assetId is not None:
        row.linked_asset_id = asset_id
    db.commit(); db.refresh(row)
    return _serialize_many(db, [row], reach)[0]


@router.get("/entries/{eid}/pdf")
def entry_pdf(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach)
    tpl = db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
    if tpl is None:
        raise HTTPException(404, "Form not found")
    defs = _entry_defs(db, tpl, row.template_version or 0)
    pdf = form_entry_pdf.render(db, row, tpl, defs)
    name = f"{row.title or tpl.name} {form_entry_pdf.us_date(row.submitted_at).replace('/', '-')}"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": _content_disposition(name, "pdf")})


# Declared after /entries so "/forms/entries" never matches {tid}.
@router.get("/{tid}")
def fill_payload(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the fill screen renders: the released field defs, the section
    headings, and the work sites the person may pick."""
    tpl = _fillable(db, tid, user)
    defs, version = _defs(db, tpl)
    company = auth.company_of(user["email"], db)
    sites = [{"id": s.id, "name": s.name, "lat": s.latitude, "lng": s.longitude} for s in company_sites(db, company)]
    out = _ser_form(tpl, version)
    out.update({"fieldDefs": defs, "sections": form_rules.sections(defs), "workSites": sites})
    return out



# ── Export ────────────────────────────────────────────────────────────────

META_COLUMNS = ("entryId", "form", "templateVersion", "submittedBy", "submittedByName", "submittedAt",
                "workSiteId", "workSiteName", "shiftId", "source", "status", "reviewerEmail", "reviewedAt",
                "reviewNote", "linkedTicketId", "linkedTaskId", "linkedAssetId")


_CSV_FORMULA_LEADS = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(cell):
    """A text cell a spreadsheet would run as a formula ("=HYPERLINK(..)",
    "+1", "@SUM") gets a leading apostrophe, so it opens as text. Numbers
    are left as they are."""
    if isinstance(cell, str) and cell.startswith(_CSV_FORMULA_LEADS):
        return "'" + cell
    return cell


def _csv_value(d: dict, v):
    """One answer's cell: a number stays a number (a negative one is not a
    formula), any text goes through csv_safe."""
    text = form_entry_pdf.value_text(d, v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return text
    return csv_safe(text)


def _csv_rows(defs: list, entries: list, defs_by_version: dict | None = None, zone: str = "") -> list:
    """Header + one row per entry: the meta columns, then one column per
    token in form order. A repeat group's token holds its rows' values
    joined with ' | '; photo URLs are joined with spaces. Every text cell
    goes through csv_safe. `defs_by_version` ({version: defs}) reads each
    entry's answers with the fields of the version it was filled on. Times
    read in `zone` (the exporter's)."""
    tokens = [d["token"] for d in defs if d.get("token")]
    columns = {d["token"]: d for d in defs if d.get("token")}
    rows = [list(META_COLUMNS) + tokens]
    for e in entries:
        answers = e["answers"]
        pinned = (defs_by_version or {}).get(e["templateVersion"]) or []
        by_token = {**columns, **{d["token"]: d for d in pinned if d.get("token") in columns}}
        meta = [e["id"], e["title"], e["templateVersion"], e["submittedBy"], e["submittedByName"],
                form_entry_pdf.us_datetime(e["submittedAt"], zone), e["workSiteId"], e["workSiteName"], e["shiftId"],
                e["source"], form_entry_pdf.STATUS_WORDS.get(e["status"], e["status"]), e["reviewerEmail"],
                form_entry_pdf.us_datetime(e["reviewedAt"], zone), e["reviewNote"], e["linkedTicketId"],
                e["linkedTaskId"], e["linkedAssetId"]]
        meta = [csv_safe(v) for v in meta]
        values = []
        for t in tokens:
            d = by_token[t]
            g = form_rules.group_of(d)
            if g:
                group_rows = answers.get(g) if isinstance(answers.get(g), list) else []
                cells = [r.get(t) for r in group_rows if isinstance(r, dict)]
                joined = " | ".join(form_entry_pdf.value_text(d, v) for v in cells)
                numeric = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in cells)
                values.append(joined if numeric else csv_safe(joined))
            else:
                values.append(_csv_value(d, answers.get(t)))
        rows.append(meta + values)
    return rows


def _may_export(db: Session, tpl: DocTemplate, user: dict, reach: form_audience.Reach) -> bool:
    """Who may pull a form's CSV at all: someone who may fill it (their own
    rows), someone who manages the template, or someone whose reach goes
    beyond their own entries - an administrator, a manager with people or
    team sites, HR for the form's company or their own. Anyone else gets the
    same 404 as for a form that does not exist."""
    if form_audience.may_fill(db, tpl, user["email"], level=user.get("level", 0)):
        return True
    try:
        _require_template_manager(db, user, tpl.department or "")
        return True
    except HTTPException:
        pass
    if reach.admin or reach.team or reach.team_sites:
        return True
    companies = {form_audience.template_company(db, tpl), auth.company_of(user["email"], db)}
    return any(reach.hr_for(c) for c in companies if c)


@router.get("/templates/{tid}/export.csv")
def export_csv(tid: str, from_: str = Query("", alias="from"), to: str = "", status: str = "", site: str = "",
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every entry of one form the caller may see, as CSV."""
    tpl = _form_template(db, tid)
    reach = form_audience.viewer_reach(db, user)
    if not _may_export(db, tpl, user, reach):
        raise HTTPException(404, "Form not found")
    if status and status not in STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(STATUSES)}")
    defs, _version = _defs(db, tpl)
    q = db.query(DocFormEntry).filter(DocFormEntry.template_id == tpl.id, DocFormEntry.deleted_at == "")
    if status:
        q = q.filter(DocFormEntry.status == status)
    if site:
        q = q.filter(DocFormEntry.work_site_id == site)
    lo, hi = _day_bounds(from_, to)
    if lo:
        q = q.filter(DocFormEntry.submitted_at >= lo)
    if hi:
        q = q.filter(DocFormEntry.submitted_at < hi)
    rows = [r for r in q.order_by(DocFormEntry.submitted_at.asc()).all() if reach(r)]
    entries = _serialize_many(db, rows, reach)
    # Each entry reads with its pinned version's fields; a token only an
    # older version had still gets its column, after the current ones.
    by_version = {v: _entry_defs(db, tpl, v) for v in sorted({e["templateVersion"] for e in entries}, reverse=True)}
    have = {d.get("token") for d in defs}
    for vdefs in by_version.values():
        for d in vdefs:
            if d.get("token") and d["token"] not in have:
                defs = defs + [d]
                have.add(d["token"])
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    for line in _csv_rows(defs, entries, by_version, form_entry_pdf.person_zone(db, user["email"])):
        writer.writerow(["" if v is None else v for v in line])
    name = f"{tpl.name} entries {date.today().strftime('%m-%d-%Y')}"
    return Response(content=buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": _content_disposition(name, "csv")})
