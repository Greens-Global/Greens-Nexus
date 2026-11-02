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
here changes an entry's state by itself - a person reviews it. The Workflows
events (form.submitted / form.reviewed) are the documents pack's (Task 2).
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
from auth import get_current_user
from database import get_db
from models import DocFormEntry, DocTemplate, HrWorkSite, NexusEmployee, NexusNotification
from routers.documents import _content_disposition, _released
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
        "reviewNote": e.review_note or "",
        "linkedTicketId": e.linked_ticket_id or "", "linkedTaskId": e.linked_task_id or "",
        "linkedAssetId": e.linked_asset_id or "",
        "canReview": reach.can_review(e),
    }


def _serialize_many(db: Session, rows: list, reach: form_audience.Reach) -> list:
    names = _names(db, {r.submitted_by for r in rows})
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


@router.post("/{tid}/entries")
def submit_entry(tid: str, body: EntryIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """File one entry. The same entryKey a second time (a retry after a
    dropped signal) returns the first entry, never a second row."""
    key = (body.entryKey or "").strip()[:80]
    if not key:
        raise HTTPException(400, "entryKey is required")
    tpl = _fillable(db, tid, user)
    me = _norm(user["email"])
    existing = db.query(DocFormEntry).filter(DocFormEntry.entry_key == key).first()
    if existing is not None:
        if _norm(existing.submitted_by) != me or existing.template_id != tpl.id:
            raise HTTPException(409, "That entry key belongs to another entry")
        return _serialize_many(db, [existing], form_audience.viewer_reach(db, user))[0]

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

    site_id = (body.workSiteId or "").strip() or (tpl.work_site_id or "")
    if site_id and db.query(HrWorkSite.id).filter(HrWorkSite.id == site_id).first() is None:
        raise HTTPException(400, "Unknown work site")
    now = _now_iso()
    row = DocFormEntry(id=str(uuid.uuid4()), template_id=tpl.id, template_version=version,
                       title=tpl.name, entry_key=key, answers=answers,
                       company=auth.company_of(me, db), work_site_id=site_id,
                       shift_id=(body.shiftId or "").strip()[:80], submitted_by=me, submitted_at=now,
                       source=source, status="submitted", deleted_at="")
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Two retries raced: the first one's row is the entry.
        db.rollback()
        row = db.query(DocFormEntry).filter(DocFormEntry.entry_key == key).first()
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
    return _serialize_many(db, [row], reach)[0]


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
    body = f"{who} marked your {entry.title} from {form_entry_pdf.us_datetime(entry.submitted_at)} as {word}."
    if entry.review_note:
        body += f" Note: {entry.review_note}"
    action = json.dumps({"view": "documents", "sub": "documents-forms", "entryId": entry.id, "label": "Open Entry"})
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
    row.status = status
    row.reviewer_email = _norm(user["email"])
    row.reviewed_at = _now_iso()
    row.review_note = (body.note or "").strip()[:NOTE_MAX]
    _bell_submitter(db, row, user["email"])
    db.commit(); db.refresh(row)
    return _serialize_many(db, [row], reach)[0]


class LinkIn(BaseModel):
    ticketId: Optional[str] = None
    taskId: Optional[str] = None
    assetId: Optional[str] = None


@router.post("/entries/{eid}/link")
def link_entry(eid: str, body: LinkIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Remember the ticket / task / asset made from this entry (the record
    itself is created through the existing calls)."""
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach, lock=True)
    if body.ticketId is None and body.taskId is None and body.assetId is None:
        raise HTTPException(400, "Nothing to link")
    if body.ticketId is not None:
        row.linked_ticket_id = (body.ticketId or "").strip()[:80]
    if body.taskId is not None:
        row.linked_task_id = (body.taskId or "").strip()[:80]
    if body.assetId is not None:
        row.linked_asset_id = (body.assetId or "").strip()[:80]
    db.commit(); db.refresh(row)
    return _serialize_many(db, [row], reach)[0]


@router.get("/entries/{eid}/pdf")
def entry_pdf(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    reach = form_audience.viewer_reach(db, user)
    row = _get_entry(db, eid, reach)
    tpl = db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
    if tpl is None:
        raise HTTPException(404, "Form not found")
    defs, _version = _defs(db, tpl)
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
    sites = [{"id": s.id, "name": s.name} for s in company_sites(db, company)]
    out = _ser_form(tpl, version)
    out.update({"fieldDefs": defs, "sections": form_rules.sections(defs), "workSites": sites})
    return out



# ── Export ────────────────────────────────────────────────────────────────

META_COLUMNS = ("entryId", "form", "templateVersion", "submittedBy", "submittedByName", "submittedAt",
                "workSiteId", "workSiteName", "shiftId", "source", "status", "reviewerEmail", "reviewedAt",
                "reviewNote", "linkedTicketId", "linkedTaskId", "linkedAssetId")


def _csv_rows(defs: list, entries: list) -> list:
    """Header + one row per entry: the meta columns, then one column per
    token in form order. A repeat group's token holds its rows' values
    joined with ' | '; photo URLs are joined with spaces."""
    tokens = [d["token"] for d in defs if d.get("token")]
    by_token = {d["token"]: d for d in defs if d.get("token")}
    rows = [list(META_COLUMNS) + tokens]
    for e in entries:
        answers = e["answers"]
        meta = [e["id"], e["title"], e["templateVersion"], e["submittedBy"], e["submittedByName"],
                form_entry_pdf.us_datetime(e["submittedAt"]), e["workSiteId"], e["workSiteName"], e["shiftId"],
                e["source"], form_entry_pdf.STATUS_WORDS.get(e["status"], e["status"]), e["reviewerEmail"],
                form_entry_pdf.us_datetime(e["reviewedAt"]), e["reviewNote"], e["linkedTicketId"],
                e["linkedTaskId"], e["linkedAssetId"]]
        values = []
        for t in tokens:
            d = by_token[t]
            g = form_rules.group_of(d)
            if g:
                group_rows = answers.get(g) if isinstance(answers.get(g), list) else []
                values.append(" | ".join(form_entry_pdf.value_text(d, r.get(t)) for r in group_rows
                                         if isinstance(r, dict)))
            else:
                values.append(form_entry_pdf.value_text(d, answers.get(t)))
        rows.append(meta + values)
    return rows


@router.get("/templates/{tid}/export.csv")
def export_csv(tid: str, from_: str = Query("", alias="from"), to: str = "", status: str = "", site: str = "",
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every entry of one form the caller may see, as CSV."""
    tpl = _form_template(db, tid)
    reach = form_audience.viewer_reach(db, user)
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
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    for line in _csv_rows(defs, entries):
        writer.writerow(["" if v is None else v for v in line])
    name = f"{tpl.name} entries {date.today().strftime('%m-%d-%Y')}"
    return Response(content=buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": _content_disposition(name, "csv")})
