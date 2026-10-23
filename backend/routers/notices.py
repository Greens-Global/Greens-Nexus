"""Workplace Notices - the HR library and its two-person approval
(Neil, Oct 21 2026: "there has to be an actual workflow and a manager
approval ... the HR manager has to click it off").

People > Notices. A notice's file never changes by itself: a new version is
prepared (uploaded, imported from Egnyte, or drafted by the watcher), then
SUBMITTED, then APPROVED by someone else - never the person who prepared or
submitted it. An approved version is frozen and goes live on its effective
date (notices.live_version). Nothing is deleted: a notice is retired, a
scheduled version is withdrawn, and every step is on the event log.

Who:
  prepare  = HR anywhere: an administrator, an Editor-or-higher HR grant, or a
             company's HR contact.
  approve  = Settings > Approvers when set (Charmi, to start - Pranshu, Oct 22:
             "we can decide later"), else an administrator, a Full HR grant
             or a company's HR contact. Never their own version.
Files live in the private hr-docs bucket under workplace-notices/ and are
streamed through this API (login required), as reimbursement receipts are.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import notices as core
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user, level_for
from database import get_db
from routers.esign import _storage_fetch, _storage_put
from routers.hr import _DOC_BUCKET

router = APIRouter(prefix="/notices", tags=["Workplace Notices"], dependencies=[Depends(get_current_user)])

NOTIFY_TYPE = "workplace_notice"
HR_ACTION = {"view": "hr", "sub": "hr-notices"}
MAX_FILE_BYTES = 20 * 1024 * 1024
FILE_TYPES = ("application/pdf", "image/png", "image/jpeg")
KINDS = ("poster", "handout", "form", "manual", "addendum", "policy", "contractor_code", "closures")
MODES = ("post", "deliver", "both", "read")
TRIGGERS = ("always", "hire", "annual", "hire_annual", "separation", "event", "election", "window")
STATUS_LABEL = {"draft": "Draft", "in_review": "Awaiting Approval", "approved": "Approved",
                "rejected": "Sent Back", "retired": "Withdrawn"}


# ── Who ──────────────────────────────────────────────────────────────────────

def _is_hr_contact(db: Session, me: str) -> bool:
    return db.query(models.HrEntity).filter(func.lower(models.HrEntity.hr_contact_email) == me).first() is not None


def can_manage(db: Session, me: str) -> bool:
    me = core.norm(me)
    if not me:
        return False
    if level_for(me, db) >= _LEVELS["administrator"]:
        return True
    if _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["editor"]:
        return True
    return _is_hr_contact(db, me)


def can_approve(db: Session, me: str, cfg: dict | None = None) -> bool:
    me = core.norm(me)
    cfg = cfg or core.settings(db)
    named = [core.norm(x) for x in (cfg.get("approvers") or []) if core.norm(x)]
    if named:
        return me in named
    if level_for(me, db) >= _LEVELS["administrator"]:
        return True
    if _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]:
        return True
    return _is_hr_contact(db, me)


def approvers(db: Session, cfg: dict | None = None) -> list:
    """Who hears that a version is waiting: the named approvers, else every
    company's HR contact."""
    cfg = cfg or core.settings(db)
    named = [core.norm(x) for x in (cfg.get("approvers") or []) if core.norm(x)]
    if named:
        return named
    return sorted({core.norm(r[0]) for r in db.query(models.HrEntity.hr_contact_email).all() if core.norm(r[0])})


def _require_manage(db: Session, user: dict) -> str:
    me = core.norm(user.get("email"))
    if not can_manage(db, me):
        raise HTTPException(403, "Only HR can manage Workplace Notices")
    return me


def _bell(db: Session, recipient: str, title: str, body: str, ref_id: str, actor: str = "", priority: int = 0,
          action: dict | None = None) -> None:
    recipient = core.norm(recipient)
    if not recipient:
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=NOTIFY_TYPE, recipient=recipient, title=title, body=body, ref_id=ref_id,
        item_name=title[:120], requested_by=actor, action=json.dumps(action or HR_ACTION), actioned=False,
        read_by="", company="", created_at=core.now_iso(), priority=priority))


# ── Serializers ──────────────────────────────────────────────────────────────

def _name_of(db: Session, email: str, cache: dict) -> str:
    email = core.norm(email)
    if not email:
        return ""
    if email not in cache:
        p = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == email).first()
        cache[email] = core.person_name(p) if p else email
    return cache[email]


def ser_version(db: Session, v, cache: dict) -> dict:
    return {"id": v.id, "noticeId": v.notice_id, "number": v.number, "label": v.label or f"Version {v.number}",
            "major": bool(v.major), "status": v.status, "statusLabel": STATUS_LABEL.get(v.status, v.status),
            "files": [{"lang": f.get("lang", "en"), "name": f.get("name", ""), "size": f.get("size", 0),
                       "sha256": f.get("sha256", "")} for f in (v.files or [])],
            "agencyRevision": v.agency_revision or "", "effectiveDate": v.effective_date or "",
            "summary": v.summary or "", "origin": v.origin or "manual",
            "preparedBy": _name_of(db, v.prepared_by, cache), "preparedByEmail": v.prepared_by or "",
            "preparedAt": v.prepared_at or "", "submittedAt": v.submitted_at or "",
            "approvedBy": _name_of(db, v.approved_by, cache), "approvedAt": v.approved_at or "",
            "reviewNote": v.review_note or "", "retiredAt": v.retired_at or ""}


def ser_notice(db: Session, n, rows: list, cache: dict, source=None) -> dict:
    live = core.live_version(db, n.id, rows=rows)
    sched = core.scheduled_version(db, n.id, rows=rows)
    pending = [v for v in rows if v.status in ("draft", "in_review")]
    if n.status != "active":
        state = "retired"
    elif any(v.status == "in_review" for v in rows):
        state = "awaiting_approval"
    elif live is None and n.kind != "closures":
        state = "needs_file"
    elif source is not None and source.last_changed_at and not any(
            (v.prepared_at or "") >= source.last_changed_at for v in rows):
        state = "source_changed"
    elif sched is not None:
        state = "scheduled"
    else:
        state = "current"
    review_due = ""
    if live is not None and live.effective_date:
        try:
            eff = date.fromisoformat(live.effective_date)
            months = int(n.review_every_months or 12)
            y, m = eff.year + (eff.month - 1 + months) // 12, (eff.month - 1 + months) % 12 + 1
            review_due = date(y, m, min(eff.day, 28)).isoformat()
            if review_due < core.today().isoformat() and state == "current":
                state = "review_due"
        except ValueError:
            pass
    return {"id": n.id, "title": n.title, "formCode": n.form_code or "", "agency": n.agency or "", "kind": n.kind,
            "area": n.area, "mode": n.mode, "trigger": n.trigger, "annualDue": n.annual_due or "",
            "window": n.window or [], "applies": n.applies or {}, "requiresAck": bool(n.requires_ack),
            "languages": n.languages or [], "sourceUrl": n.source_url or "", "notes": n.notes or "",
            "status": n.status, "state": state, "reviewDue": review_due, "sort": n.sort or 0,
            "live": ser_version(db, live, cache) if live else None,
            "scheduled": ser_version(db, sched, cache) if sched else None,
            "pending": [ser_version(db, v, cache) for v in pending],
            "source": {"url": source.url, "lastCheckedAt": source.last_checked_at or "",
                       "lastChangedAt": source.last_changed_at or "", "lastError": source.last_error or "",
                       "failCount": source.fail_count or 0} if source else None}


def _versions_by_notice(db: Session) -> dict:
    out: dict = {}
    for v in db.query(models.WorkplaceNoticeVersion).all():
        out.setdefault(v.notice_id, []).append(v)
    return out


# ── Library ──────────────────────────────────────────────────────────────────

@router.get("/library")
def library(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    if core.ensure_catalog(db):
        db.commit()
    cfg = core.settings(db)
    by = _versions_by_notice(db)
    srcs = {s.notice_id: s for s in db.query(models.WorkplaceNoticeSource).all()}
    cache: dict = {}
    rows = db.query(models.WorkplaceNotice).order_by(models.WorkplaceNotice.sort, models.WorkplaceNotice.title).all()
    items = [ser_notice(db, n, by.get(n.id, []), cache, srcs.get(n.id)) for n in rows]
    queue = [v for n in items for v in n["pending"] if v["status"] == "in_review"]
    return {"notices": items, "queue": queue, "canApprove": can_approve(db, me, cfg),
            "approvers": [{"email": e, "name": _name_of(db, e, cache)} for e in approvers(db, cfg)],
            "unplaced": core.unplaced(db), "settings": cfg}


@router.get("/notice/{nid}")
def notice_detail(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_manage(db, user)
    n = db.get(models.WorkplaceNotice, nid)
    if n is None:
        raise HTTPException(404, "Notice not found")
    rows = core.versions_of(db, nid)
    cache: dict = {}
    out = ser_notice(db, n, rows, cache, db.get(models.WorkplaceNoticeSource, nid))
    out["versions"] = [ser_version(db, v, cache) for v in rows]
    out["events"] = [{"at": e.at, "actor": _name_of(db, e.actor, cache) or e.actor, "action": e.action,
                      "versionId": e.version_id or "", "detail": e.detail or {}}
                     for e in db.query(models.WorkplaceNoticeEvent).filter(models.WorkplaceNoticeEvent.notice_id == nid)
                     .order_by(models.WorkplaceNoticeEvent.at.desc()).limit(200).all()]
    return out


class NoticeIn(BaseModel):
    title: str
    form_code: str = ""
    agency: str = ""
    kind: str = "poster"
    area: str = "US"
    mode: str = "post"
    trigger: str = "always"
    annual_due: str = ""
    window: List[str] = []
    applies: dict = {}
    requires_ack: bool = False
    languages: List[str] = ["en"]
    source_url: str = ""
    notes: str = ""
    review_every_months: int = 12


_AREA_RE = re.compile(r"^(US|IN|US-[A-Z]{2}(:[A-Z .'-]{2,40})?)$")


def _clean_notice(body: NoticeIn) -> dict:
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(400, "Give the notice a title")
    area = (body.area or "US").strip().upper()
    if not _AREA_RE.match(area):
        raise HTTPException(400, "Area must be US, IN, a state like US-CA, or a city like US-CA:SAN DIEGO")
    if body.kind not in KINDS or body.mode not in MODES or body.trigger not in TRIGGERS:
        raise HTTPException(400, "Unknown kind, mode or trigger")
    if body.annual_due and not re.match(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$", body.annual_due):
        raise HTTPException(400, "The yearly due date is MM-DD, like 02-01")
    url = (body.source_url or "").strip()
    if url and not url.startswith("https://"):
        raise HTTPException(400, "The official source must be an https:// link")
    months = int(body.review_every_months or 12)
    if not 1 <= months <= 36:
        raise HTTPException(400, "Review every 1 to 36 months")
    return dict(title=title[:200], form_code=(body.form_code or "").strip()[:40], agency=(body.agency or "").strip()[:80],
                kind=body.kind, area=area, mode=body.mode, trigger=body.trigger, annual_due=body.annual_due or "",
                window=[w for w in (body.window or [])][:2], applies=body.applies or {},
                requires_ack=bool(body.requires_ack), languages=[x for x in (body.languages or ["en"])][:12],
                source_url=url, notes=(body.notes or "").strip()[:2000], review_every_months=months)


@router.post("/notice", status_code=201)
def create_notice(body: NoticeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    clean = _clean_notice(body)
    n = models.WorkplaceNotice(id=str(uuid.uuid4()), **clean, status="active", sort=900,
                               created_by=me, created_at=core.now_iso(), updated_by=me, updated_at=core.now_iso())
    db.add(n)
    if clean["source_url"]:
        db.add(models.WorkplaceNoticeSource(notice_id=n.id, url=clean["source_url"]))
    core.log_event(db, me, "notice_created", n.id, title=n.title)
    db.commit()
    return notice_detail(n.id, user, db)


@router.patch("/notice/{nid}")
def update_notice(nid: str, body: NoticeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Who a notice is for and how it is handled is a compliance decision:
    every change is logged with what it was before."""
    me = _require_manage(db, user)
    n = db.get(models.WorkplaceNotice, nid)
    if n is None:
        raise HTTPException(404, "Notice not found")
    clean = _clean_notice(body)
    before = {k: getattr(n, k) for k in clean if getattr(n, k) != clean[k]}
    if not before:
        return notice_detail(nid, user, db)
    for k, v in clean.items():
        setattr(n, k, v)
    n.updated_by, n.updated_at = me, core.now_iso()
    src = db.get(models.WorkplaceNoticeSource, nid)
    if clean["source_url"] and src is None:
        db.add(models.WorkplaceNoticeSource(notice_id=nid, url=clean["source_url"]))
    elif src is not None and src.url != clean["source_url"]:
        src.url, src.last_hash, src.fail_count, src.last_error = clean["source_url"], "", 0, ""
    core.log_event(db, me, "notice_changed", nid, before={k: v for k, v in before.items()},
                   after={k: clean[k] for k in before})
    db.commit()
    return notice_detail(nid, user, db)


class ReasonIn(BaseModel):
    reason: str = ""


@router.post("/notice/{nid}/retire")
def retire_notice(nid: str, body: ReasonIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    n = db.get(models.WorkplaceNotice, nid)
    if n is None:
        raise HTTPException(404, "Notice not found")
    if not (body.reason or "").strip():
        raise HTTPException(400, "Say why this notice no longer applies")
    n.status = "retired" if n.status == "active" else "active"
    n.updated_by, n.updated_at = me, core.now_iso()
    core.log_event(db, me, "notice_retired" if n.status == "retired" else "notice_restored", nid,
                   reason=body.reason.strip()[:500])
    db.commit()
    return notice_detail(nid, user, db)


# ── Versions ─────────────────────────────────────────────────────────────────

class VersionIn(BaseModel):
    label: str = ""
    effective_date: str = ""
    major: bool = True
    summary: str = ""
    agency_revision: str = ""


def _get_version(db: Session, vid: str, lock: bool = False):
    q = db.query(models.WorkplaceNoticeVersion).filter(models.WorkplaceNoticeVersion.id == vid)
    v = (q.with_for_update() if lock else q).first()
    if v is None:
        raise HTTPException(404, "Version not found")
    return v


def _editable(v) -> None:
    if v.status not in ("draft", "rejected"):
        raise HTTPException(409, "An approved or submitted version cannot be changed - prepare a new version")


def _clean_version(body: VersionIn) -> dict:
    eff = (body.effective_date or "").strip()
    if eff:
        try:
            date.fromisoformat(eff)
        except ValueError:
            raise HTTPException(400, "The effective date must be a date")
    return dict(label=(body.label or "").strip()[:60], effective_date=eff, major=bool(body.major),
                summary=(body.summary or "").strip()[:4000], agency_revision=(body.agency_revision or "").strip()[:60])


def new_version(db: Session, notice_id: str, actor: str, origin: str = "manual", **fields):
    number = (db.query(func.max(models.WorkplaceNoticeVersion.number))
              .filter(models.WorkplaceNoticeVersion.notice_id == notice_id).scalar() or 0) + 1
    v = models.WorkplaceNoticeVersion(id=str(uuid.uuid4()), notice_id=notice_id, number=number, status="draft",
                                      origin=origin, files=[], prepared_by=core.norm(actor),
                                      prepared_at=core.now_iso(), **fields)
    db.add(v)
    core.log_event(db, actor, "version_created", notice_id, v.id, number=number, origin=origin)
    return v


@router.post("/notice/{nid}/versions", status_code=201)
def create_version(nid: str, body: VersionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    if db.get(models.WorkplaceNotice, nid) is None:
        raise HTTPException(404, "Notice not found")
    v = new_version(db, nid, me, **_clean_version(body))
    db.commit()
    return ser_version(db, v, {})


@router.patch("/versions/{vid}")
def update_version(vid: str, body: VersionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    v = _get_version(db, vid, lock=True)
    _editable(v)
    for k, val in _clean_version(body).items():
        setattr(v, k, val)
    core.log_event(db, me, "version_edited", v.notice_id, v.id)
    db.commit()
    return ser_version(db, v, {})


def store_file(db: Session, v, data: bytes, name: str, ctype: str, lang: str, actor: str) -> dict:
    """Put a file on a draft version (replacing the same language's file)."""
    lang = (lang or "en").strip().lower()[:5] or "en"
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", name or "notice.pdf")[:120]
    path = f"workplace-notices/{v.notice_id}/{v.id}/{lang}-{uuid.uuid4().hex[:8]}-{safe}"
    res = _storage_put(_DOC_BUCKET, path, data, ctype or "application/pdf")
    if not res.is_success:
        raise HTTPException(502, f"Storage upload failed: {res.text[:200]}")
    rec = {"lang": lang, "path": path, "name": name or safe, "size": len(data), "type": ctype or "application/pdf",
           "sha256": hashlib.sha256(data).hexdigest()}
    v.files = [f for f in (v.files or []) if f.get("lang") != lang] + [rec]
    core.log_event(db, actor, "file_added", v.notice_id, v.id, lang=lang, name=rec["name"], sha256=rec["sha256"])
    return rec


@router.post("/versions/{vid}/files")
def upload_file(vid: str, file: UploadFile = File(...), lang: str = Form("en"), source: str = Form(""),
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    v = _get_version(db, vid, lock=True)
    _editable(v)
    ctype = (file.content_type or "").lower()
    if ctype not in FILE_TYPES:
        raise HTTPException(400, "A notice is a PDF (or a PNG / JPEG of the poster)")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "That file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(400, "File too large (max 20 MB)")
    store_file(db, v, data, file.filename or "notice.pdf", ctype, lang, me)
    if source == "egnyte":
        v.origin = "egnyte"
    db.commit()
    return ser_version(db, v, {})


@router.post("/versions/{vid}/files/remove")
def remove_file(vid: str, body: dict, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a file off a DRAFT (the stored object is kept; the log says so)."""
    me = _require_manage(db, user)
    v = _get_version(db, vid, lock=True)
    _editable(v)
    lang = str((body or {}).get("lang") or "en")
    if not any(f.get("lang") == lang for f in (v.files or [])):
        raise HTTPException(404, "No file in that language")
    v.files = [f for f in (v.files or []) if f.get("lang") != lang]
    core.log_event(db, me, "file_removed", v.notice_id, v.id, lang=lang)
    db.commit()
    return ser_version(db, v, {})


def file_bytes(v, lang: str = "en") -> tuple[bytes, dict]:
    files = v.files or []
    f = next((x for x in files if x.get("lang") == lang), None) or next((x for x in files if x.get("lang") == "en"), None) \
        or (files[0] if files else None)
    if f is None:
        raise HTTPException(404, "This version has no file")
    res = _storage_fetch(_DOC_BUCKET, f["path"])
    if not res.is_success:
        raise HTTPException(502, "Could not open the file")
    return res.content, f


@router.get("/versions/{vid}/file")
def version_file(vid: str, lang: str = "en", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The file, streamed. Approved versions open for anyone signed in (they
    are the company's notices); drafts only for HR."""
    v = _get_version(db, vid)
    if v.status != "approved" and not can_manage(db, user.get("email")):
        raise HTTPException(404, "Version not found")
    data, f = file_bytes(v, lang)
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", f.get("name") or "notice.pdf")
    return Response(content=data, media_type=f.get("type") or "application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{safe}"',
                             "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/versions/{vid}/submit")
def submit_version(vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    v = _get_version(db, vid, lock=True)
    _editable(v)
    n = db.get(models.WorkplaceNotice, v.notice_id)
    if not (v.files or []) and (n is None or n.kind != "closures"):
        raise HTTPException(400, "Add the file before sending it for approval")
    if not v.effective_date:
        raise HTTPException(400, "Set the date this version takes effect")
    if not (v.summary or "").strip():
        raise HTTPException(400, "Say in a sentence what changed (or 'First version')")
    v.status, v.submitted_at, v.review_note = "in_review", core.now_iso(), ""
    core.log_event(db, me, "version_submitted", v.notice_id, v.id)
    title = n.title if n else "A notice"
    for a in approvers(db):
        if a not in (me, core.norm(v.prepared_by)):
            _bell(db, a, "Notice to Approve", f"{title}: version {v.number} takes effect "
                  f"{_us(v.effective_date)}. Review it in People > Notices.", v.id, actor=me, priority=1)
    db.commit()
    return ser_version(db, v, {})


def _us(iso: str) -> str:
    try:
        d = date.fromisoformat(iso)
        return f"{d.month:02d}/{d.day:02d}/{d.year}"
    except (TypeError, ValueError):
        return iso or ""


class ReviewIn(BaseModel):
    decision: str          # approve | send_back
    note: str = ""
    effective_date: str = ""   # the approver may set when it takes effect (a watcher draft: usually 01/01)


@router.post("/versions/{vid}/review")
def review_version(vid: str, body: ReviewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = core.norm(user.get("email"))
    if not can_approve(db, me):
        raise HTTPException(403, "Only a notice approver can approve")
    v = _get_version(db, vid, lock=True)
    if v.status != "in_review":
        raise HTTPException(409, "This version is not waiting for approval")
    if me == core.norm(v.prepared_by):
        raise HTTPException(403, "Someone else has to approve a version you prepared")
    submitter = next((e.actor for e in db.query(models.WorkplaceNoticeEvent)
                      .filter(models.WorkplaceNoticeEvent.version_id == v.id,
                              models.WorkplaceNoticeEvent.action.in_(("version_submitted", "file_added", "version_edited")))
                      .all() if core.norm(e.actor) == me), None)
    if submitter:
        raise HTTPException(403, "Someone else has to approve a version you worked on")
    n = db.get(models.WorkplaceNotice, v.notice_id)
    note = (body.note or "").strip()[:2000]
    if body.decision == "approve":
        eff = (body.effective_date or "").strip()
        if eff and eff != v.effective_date:
            try:
                date.fromisoformat(eff)
            except ValueError:
                raise HTTPException(400, "The effective date must be a date")
            core.log_event(db, me, "version_date_set", v.notice_id, v.id, before=v.effective_date, after=eff)
            v.effective_date = eff
        v.status, v.approved_by, v.approved_at, v.review_note = "approved", me, core.now_iso(), note
        core.log_event(db, me, "version_approved", v.notice_id, v.id, effectiveDate=v.effective_date,
                       files=[{"lang": f.get("lang"), "sha256": f.get("sha256")} for f in (v.files or [])])
        _bell(db, v.prepared_by, "Notice Approved", f"{n.title if n else 'A notice'}: version {v.number} "
              f"goes live {_us(v.effective_date)}.", v.id, actor=me)
    elif body.decision == "send_back":
        if not note:
            raise HTTPException(400, "Say what needs to change")
        v.status, v.review_note = "rejected", note
        core.log_event(db, me, "version_sent_back", v.notice_id, v.id, note=note)
        _bell(db, v.prepared_by, "Notice Sent Back", f"{n.title if n else 'A notice'}: {note}", v.id, actor=me,
              priority=1)
    else:
        raise HTTPException(400, "Approve or send back")
    db.commit()
    return ser_version(db, v, {})


@router.post("/versions/{vid}/withdraw")
def withdraw_version(vid: str, body: ReasonIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Pull back a version that is not live yet (a draft, or approved for a
    future date). A live version is replaced by a newer one, never withdrawn."""
    me = _require_manage(db, user)
    v = _get_version(db, vid, lock=True)
    if v.status == "approved" and (v.effective_date or "") <= core.today().isoformat():
        raise HTTPException(409, "This version is live - prepare a new version to replace it")
    if v.status == "retired":
        raise HTTPException(409, "Already withdrawn")
    if not (body.reason or "").strip():
        raise HTTPException(400, "Say why")
    if v.status == "approved" and not can_approve(db, me):
        raise HTTPException(403, "Only a notice approver can withdraw an approved version")
    v.status, v.retired_at = "retired", core.now_iso()
    core.log_event(db, me, "version_withdrawn", v.notice_id, v.id, reason=body.reason.strip()[:500])
    db.commit()
    return ser_version(db, v, {})


# ── Settings, people ─────────────────────────────────────────────────────────

class SettingsIn(BaseModel):
    approvers: Optional[List[str]] = None
    countCompaniesTogether: Optional[bool] = None
    yearlyAck: Optional[bool] = None
    yearlyAckDueDays: Optional[int] = None
    ackDueDays: Optional[int] = None
    eVerify: Optional[bool] = None
    txWorkersComp: Optional[str] = None
    languages: Optional[List[str]] = None
    elections: Optional[List[str]] = None
    watcherOn: Optional[bool] = None


@router.get("/settings")
def get_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_manage(db, user)
    return core.settings(db)


@router.put("/settings")
def put_settings(body: SettingsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Who approves is itself an approver's call (else anyone in HR could name
    themselves and approve their own drafts)."""
    me = _require_manage(db, user)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "approvers" in patch:
        if not can_approve(db, me):
            raise HTTPException(403, "Only a notice approver can change who approves")
        patch["approvers"] = sorted({core.norm(x) for x in patch["approvers"] if core.norm(x)})
    if "txWorkersComp" in patch and patch["txWorkersComp"] not in ("subscriber", "non_subscriber"):
        raise HTTPException(400, "Texas workers' comp is subscriber or non_subscriber")
    for d in patch.get("elections") or []:
        try:
            date.fromisoformat(d)
        except ValueError:
            raise HTTPException(400, f"{d} is not a date")
    for k in ("yearlyAckDueDays", "ackDueDays"):
        if k in patch and not 1 <= int(patch[k]) <= 90:
            raise HTTPException(400, "Due days are 1 to 90")
    cfg = core.save_settings(db, me, patch)
    db.commit()
    return cfg


class PersonIn(BaseModel):
    notice_state: str = ""
    notice_city: str = ""
    language: str = ""


@router.put("/person/{email}")
def set_person(email: str, body: PersonIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR places a person Nexus cannot (a remote worker's home state)."""
    me = _require_manage(db, user)
    em = core.norm(email)
    st = (body.notice_state or "").strip().upper()
    if st and st not in core.work_state.ABBRS:
        raise HTTPException(400, "Use the 2-letter state, like CA")
    row = db.get(models.WorkplaceNoticePerson, em)
    if row is None:
        row = models.WorkplaceNoticePerson(email=em, sb294={})
        db.add(row)
    before = {"state": row.notice_state or "", "city": row.notice_city or "", "language": row.language or ""}
    row.notice_state, row.notice_city = st, (body.notice_city or "").strip()[:60]
    row.language = (body.language or "").strip().lower()[:5]
    row.updated_by, row.updated_at = me, core.now_iso()
    core.log_event(db, me, "person_placed", email=em, before=before,
                   after={"state": st, "city": row.notice_city, "language": row.language})
    db.commit()
    return {"ok": True}


@router.get("/events")
def events(limit: int = 200, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_manage(db, user)
    cache: dict = {}
    rows = db.query(models.WorkplaceNoticeEvent).order_by(models.WorkplaceNoticeEvent.at.desc()).limit(min(limit, 1000)).all()
    titles = {r[0]: r[1] for r in db.query(models.WorkplaceNotice.id, models.WorkplaceNotice.title).all()}
    return [{"at": e.at, "actor": _name_of(db, e.actor, cache) or e.actor, "action": e.action,
             "noticeId": e.notice_id, "notice": titles.get(e.notice_id, ""), "detail": e.detail or {}} for e in rows]


# ── Workday > Workplace Notices (everyone) ───────────────────────────────────

def _me(db: Session, user: dict):
    me = core.norm(user.get("email"))
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == me).first()
    return me, emp


def _ver_brief(v) -> dict | None:
    if v is None:
        return None
    return {"id": v.id, "label": v.label or f"Version {v.number}", "effectiveDate": v.effective_date or "",
            "summary": v.summary or "", "langs": [f.get("lang", "en") for f in (v.files or [])], "major": bool(v.major)}


@router.get("/my")
def my_notices(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What this person sees: their manual and policies (with what they owe),
    the notices posted for where they work, and what was given to them."""
    if core.ensure_catalog(db):
        db.commit()
    me, emp = _me(db, user)
    if emp is None:
        return {"placed": False, "documents": [], "posted": [], "received": [], "context": None}
    cfg = core.settings(db)
    pc, ns = core.notices_for(db, emp, cfg=cfg)
    by = _versions_by_notice(db)
    acks = core.my_acks(db, me)
    numbers = core.version_numbers(db)
    sites = core.site_info(db)
    docs, posted = [], []
    for n in ns:
        rows = by.get(n.id, [])
        live = core.live_version(db, n.id, rows=rows)
        if n.kind in core.DOC_KINDS:
            st = core.ack_state(db, n, pc, cfg, rows, acks.get(n.id, []), numbers)
            docs.append({"id": n.id, "title": n.title, "kind": n.kind, "area": n.area, "notes": n.notes or "",
                         "requiresAck": bool(n.requires_ack), "live": _ver_brief(live), "ack": st})
        elif core.shown_now(n, cfg) and n.mode in ("post", "both"):
            posted.append({"id": n.id, "title": n.title, "formCode": n.form_code or "", "agency": n.agency or "",
                           "area": n.area, "live": _ver_brief(live)})
    titles = {n.id: n.title for n in db.query(models.WorkplaceNotice).all()}
    vlabels = {v.id: (v.label or f"Version {v.number}") for vs in by.values() for v in vs}
    received = [{"id": r.id, "noticeId": r.notice_id, "title": titles.get(r.notice_id, ""), "versionId": r.version_id,
                 "versionLabel": vlabels.get(r.version_id, ""), "reason": r.reason, "channel": r.channel,
                 "sentAt": r.sent_at or r.created_at, "viewedAt": r.viewed_at or "", "acknowledgedAt": r.acknowledged_at or ""}
                for r in db.query(models.WorkplaceNoticeDelivery)
                .filter(models.WorkplaceNoticeDelivery.email == me,
                        models.WorkplaceNoticeDelivery.reason.notin_(("portal",)))
                .order_by(models.WorkplaceNoticeDelivery.created_at.desc()).limit(200).all()]
    return {"placed": bool(pc["state"]) or pc["country"] != "US", "documents": docs, "posted": posted,
            "received": received,
            "context": {"country": pc["country"], "state": pc["state"], "stateLabel": pc["stateLabel"],
                        "cities": pc["cities"], "workerType": pc["workerType"],
                        "sites": [{"id": s, "name": sites[s]["name"]} for s in pc["siteIds"] if s in sites]},
            "name": core.person_name(emp)}


def _names_match(typed: str, real: str) -> bool:
    """As the Knowledge Base's sign-off (routers/kb.py)."""
    n = lambda s: re.sub(r"[^a-z]", "", (s or "").lower())  # noqa: E731
    t, r = n(typed), n(real)
    if not r or "@" in (real or ""):
        return len(t) >= 3
    return t == r or (len(t) >= 3 and (t in r or r in t))


class AckIn(BaseModel):
    version_id: str
    typed_name: str
    lang: str = "en"


def _client(request) -> tuple[str, str]:
    if request is None:
        return "", ""
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = fwd or (request.client.host if request.client else "")
    return ip[:64], (request.headers.get("user-agent") or "")[:300]


@router.post("/my/{nid}/acknowledge")
def acknowledge(nid: str, body: AckIn, request: Request = None, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """I received and read it. Stores who, when, from where, and the
    fingerprint of the exact file - and only for the live version."""
    me, emp = _me(db, user)
    if emp is None:
        raise HTTPException(403, "Only people in Nexus People acknowledge notices")
    n = db.get(models.WorkplaceNotice, nid)
    if n is None or not n.requires_ack:
        raise HTTPException(404, "Nothing to acknowledge")
    cfg = core.settings(db)
    if not core.applies(n, core.person_context(db, emp), cfg):
        raise HTTPException(404, "This document is not one of yours")
    live = core.live_version(db, nid)
    if live is None or live.id != body.version_id:
        raise HTTPException(409, "A newer version is out - reload and read that one")
    real = core.person_name(emp)
    typed = (body.typed_name or "").strip()
    if not _names_match(typed, real):
        raise HTTPException(422, f"Type your full name as it appears in Nexus: {real}")
    f = next((x for x in (live.files or []) if x.get("lang") == body.lang), None) or next(iter(live.files or []), {})
    ip, ua = _client(request)
    stamp = core.now_iso()
    db.add(models.WorkplaceNoticeDelivery(
        id=str(uuid.uuid4()), notice_id=nid, version_id=live.id, email=me, reason="acknowledge", channel="portal",
        lang=f.get("lang", "en"), sent_at=stamp, viewed_at=stamp, acknowledged_at=stamp, typed_name=typed[:120],
        ip=ip, user_agent=ua, content_hash=f.get("sha256", ""), created_by=me, created_at=stamp))
    core.log_event(db, me, "acknowledged", nid, live.id, sha256=f.get("sha256", ""))
    db.commit()
    return {"ok": True, "acknowledgedAt": stamp}


@router.post("/my/view/{vid}")
def record_view(vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The person opened this version: one row per person and version (the
    first open is kept), and any copy delivered to them counts as opened."""
    me, emp = _me(db, user)
    v = _get_version(db, vid)
    if emp is None or v.status != "approved":
        return {"ok": False}
    stamp = core.now_iso()
    have = (db.query(models.WorkplaceNoticeDelivery)
            .filter(models.WorkplaceNoticeDelivery.email == me, models.WorkplaceNoticeDelivery.version_id == vid,
                    models.WorkplaceNoticeDelivery.reason == "portal").first())
    if have is None:
        db.add(models.WorkplaceNoticeDelivery(id=str(uuid.uuid4()), notice_id=v.notice_id, version_id=vid, email=me,
                                              reason="portal", channel="portal", sent_at=stamp, viewed_at=stamp,
                                              created_by=me, created_at=stamp))
    for d in (db.query(models.WorkplaceNoticeDelivery)
              .filter(models.WorkplaceNoticeDelivery.email == me, models.WorkplaceNoticeDelivery.version_id == vid,
                      models.WorkplaceNoticeDelivery.viewed_at == "").all()):
        d.viewed_at = stamp
    db.commit()
    return {"ok": True}


@router.get("/my/closures")
def my_closures(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Office Closure Calendar: the company Holiday Calendar from today
    through the next 12 months - days no work is requested, never leave."""
    me, emp = _me(db, user)
    if emp is None or not emp.company:
        return {"days": []}
    t = core.today()
    lo, hi = t.isoformat(), date(t.year + 1, t.month, min(t.day, 28)).isoformat()
    rows = (db.query(models.HrCompanyHoliday)
            .filter(models.HrCompanyHoliday.company_id == emp.company, models.HrCompanyHoliday.date >= lo,
                    models.HrCompanyHoliday.date <= hi)
            .order_by(models.HrCompanyHoliday.date).all())
    return {"days": [{"date": r.date, "name": r.name} for r in rows]}


def owed_count(db: Session, me: str) -> int:
    """Workday red dot: documents this person still has to acknowledge."""
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == core.norm(me)).first()
    if emp is None:
        return 0
    return len(core.owed(db, emp))


# ── HR sends a notice (events: an injury, a leave, an inspection) ───────────

class SendIn(BaseModel):
    emails: List[str]
    note: str = ""


@router.post("/notice/{nid}/send")
def send_notice(nid: str, body: SendIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Give the live version to the people HR picks - the DWC-1 claim form
    after an injury, DE 2320 on a leave of absence, the inspection notice.
    Each person gets an email with the file and a dated delivery row."""
    import notices_daily
    me = _require_manage(db, user)
    n = db.get(models.WorkplaceNotice, nid)
    if n is None:
        raise HTTPException(404, "Notice not found")
    live = core.live_version(db, nid)
    if live is None:
        raise HTTPException(409, "Approve a version with its file first")
    emails = sorted({core.norm(e) for e in body.emails or [] if core.norm(e)})
    if not emails or len(emails) > 200:
        raise HTTPException(400, "Pick 1 to 200 people")
    people = (db.query(models.NexusEmployee)
              .filter(func.lower(models.NexusEmployee.work_email).in_(emails)).all())
    if len(people) != len(emails):
        raise HTTPException(400, "Everyone must be in Nexus People")
    note = (body.note or "").strip()[:500]
    sent = 0
    for e in people:
        sent += notices_daily.send_bundle(db, e, [(n, live)], "manual", actor=me,
                                          intro=note or "Please read this notice and keep it for your records:")
    db.commit()
    return {"sent": sent}


# ── SB 294 emergency contact (California Labor Code 1555) ───────────────────
# Each California employee may name an emergency contact to be told if they
# are arrested or detained at work (and, separately, during work hours off
# site). Optional for them; offering it is the employer's duty - the offer is
# the Workday card plus the Know Your Rights notice.

class EmergencyIn(BaseModel):
    choice: str                 # profile | other | decline
    name: str = ""
    phone: str = ""
    relationship: str = ""
    worksite: bool = False
    offsite: bool = False


def _sb294_out(db: Session, emp, row) -> dict:
    s = (row.sb294 if row else None) or {}
    em = ((emp.personal or {}).get("emergency") or {}) if emp is not None else {}
    return {"answered": bool(s.get("answeredAt")), "choice": s.get("choice", ""), "name": s.get("name", ""),
            "phone": s.get("phone", ""), "relationship": s.get("relationship", ""),
            "worksite": bool(s.get("worksite")), "offsite": bool(s.get("offsite")), "answeredAt": s.get("answeredAt", ""),
            "profile": {"name": em.get("name", ""), "phone": em.get("phone", ""), "relationship": em.get("relationship", "")}}


def sb294_applies(db: Session, emp) -> bool:
    n = db.get(models.WorkplaceNotice, "ca-sb294")
    return bool(emp is not None and n is not None and core.applies(n, core.person_context(db, emp), core.settings(db)))


@router.get("/my/emergency")
def my_emergency(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, emp = _me(db, user)
    if not sb294_applies(db, emp):
        return {"applies": False}
    return {"applies": True, **_sb294_out(db, emp, db.get(models.WorkplaceNoticePerson, me))}


@router.put("/my/emergency")
def set_my_emergency(body: EmergencyIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, emp = _me(db, user)
    if not sb294_applies(db, emp):
        raise HTTPException(404, "This applies to California employees")
    if body.choice not in ("profile", "other", "decline"):
        raise HTTPException(400, "Pick an option")
    rec = {"choice": body.choice, "worksite": False, "offsite": False, "name": "", "phone": "", "relationship": ""}
    if body.choice != "decline":
        if not (body.worksite or body.offsite):
            raise HTTPException(400, "Pick when they should be told, or choose No Thanks")
        rec.update(worksite=bool(body.worksite), offsite=bool(body.offsite))
        if body.choice == "other":
            name, phone = (body.name or "").strip(), (body.phone or "").strip()
            if not name or not re.sub(r"\D", "", phone):
                raise HTTPException(400, "Give their name and phone number")
            rec.update(name=name[:120], phone=phone[:40], relationship=(body.relationship or "").strip()[:60])
        else:
            em = (emp.personal or {}).get("emergency") or {}
            if not (em.get("name") and em.get("phone")):
                raise HTTPException(400, "Your profile has no emergency contact yet - add one there or name someone here")
    row = db.get(models.WorkplaceNoticePerson, me)
    if row is None:
        row = models.WorkplaceNoticePerson(email=me, sb294={})
        db.add(row)
    stamp = core.now_iso()
    old = dict(row.sb294 or {})
    history = list(old.get("history") or []) + [{"at": stamp, **{k: v for k, v in old.items() if k != "history"}}] if old else []
    row.sb294 = {**rec, "answeredAt": stamp, "history": history[-20:]}
    row.updated_by, row.updated_at = me, stamp
    core.log_event(db, me, "emergency_contact_set", "ca-sb294", choice=body.choice)
    db.commit()
    return {"applies": True, **_sb294_out(db, emp, row)}


# ── Calendar, the December review, Check Now ─────────────────────────────────

@router.get("/calendar")
def notice_calendar(year: int = 0, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import notices_watcher
    _require_manage(db, user)
    y = year or core.today().year
    return {"year": y, "items": notices_watcher.calendar(db, y)}


def _review_out(db: Session, r, year: str) -> dict:
    import notices_watcher
    cache: dict = {}
    signed = r is not None and r.status == "signed"
    return {"year": year, "status": r.status if r else "not_open", "openedAt": r.opened_at if r else "",
            "signedBy": _name_of(db, r.signed_by, cache) if signed else "", "signedAt": r.signed_at if signed else "",
            "typedName": r.typed_name if signed else "", "note": r.note if signed else "",
            "items": (r.items if signed else notices_watcher.review_items(db, year)), "canSign": False}


@router.get("/review/{year}")
def get_review(year: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    if not re.fullmatch(r"20\d\d", year):
        raise HTTPException(400, "A year like 2027")
    out = _review_out(db, db.get(models.WorkplaceNoticeReview, year), year)
    out["canSign"] = can_approve(db, me)
    return out


@router.post("/review/{year}/open")
def open_review(year: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Open a year's review before 12/01 (the first year, or to start early)."""
    import notices_watcher
    me = _require_manage(db, user)
    if not re.fullmatch(r"20\d\d", year):
        raise HTTPException(400, "A year like 2027")
    notices_watcher.open_review(db, year)
    db.commit()
    return get_review(year, {"email": me}, db)


class SignIn(BaseModel):
    typed_name: str
    note: str = ""


@router.post("/review/{year}/sign")
def sign_review(year: str, body: SignIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The approver signs that every notice was checked for the year. What it
    covered is frozen with the signature."""
    import notices_watcher
    me = core.norm(user.get("email"))
    if not can_approve(db, me):
        raise HTTPException(403, "Only a notice approver signs the review")
    r = db.query(models.WorkplaceNoticeReview).filter(models.WorkplaceNoticeReview.id == year).with_for_update().first()
    if r is None:
        raise HTTPException(404, "Open the review first")
    if r.status == "signed":
        raise HTTPException(409, "Already signed")
    _me_, emp = _me(db, user)
    real = core.person_name(emp) if emp else me
    if not _names_match(body.typed_name, real):
        raise HTTPException(422, f"Type your full name as it appears in Nexus: {real}")
    items = notices_watcher.review_items(db, year)
    open_items = [i for i in items if i["state"] in ("needs_file", "awaiting_approval", "source_changed")]
    if open_items and not (body.note or "").strip():
        raise HTTPException(400, f"{len(open_items)} notices still need a file or an approval - say why you are signing anyway")
    r.status, r.items, r.signed_by, r.typed_name = "signed", items, me, body.typed_name.strip()[:120]
    r.signed_at, r.note = core.now_iso(), (body.note or "").strip()[:2000]
    core.log_event(db, me, "review_signed", year=year, items=len(items), open=len(open_items))
    db.commit()
    return get_review(year, user, db)


@router.post("/notice/{nid}/check")
def check_now(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Check this notice's official source now (one request)."""
    import notices_watcher
    me = _require_manage(db, user)
    n = db.get(models.WorkplaceNotice, nid)
    src = db.get(models.WorkplaceNoticeSource, nid)
    if n is None or src is None or not src.url:
        raise HTTPException(404, "This notice has no official source to check")
    result = notices_watcher.check_source(db, src, n)
    core.log_event(db, me, "checked_now", nid, result=result)
    db.commit()
    return {"result": result, "lastError": src.last_error or ""}


# ── Paper posters at each site ───────────────────────────────────────────────
# Online copies supplement the paper ones; they never replace them for the
# office and the job sites (DOL FAB 2020-7, OSHA 1903.2). Each Location
# Library site has the posters its state, city, kind and headcount call for;
# a site lead (or HR) confirms each current version is up with a photo.

MAX_PHOTO_BYTES = 15 * 1024 * 1024


def site_board(db: Session, site_id: str, cfg: dict | None = None, ctx: dict | None = None,
               rows: list | None = None, by: dict | None = None, confirmed: dict | None = None) -> dict:
    """{required: [{noticeId, title, versionId, label, status, confirmedAt, confirmedBy}], missing}."""
    cfg = cfg or core.settings(db)
    ctx = ctx if ctx is not None else {}
    by = by if by is not None else _versions_by_notice(db)
    if confirmed is None:
        confirmed = {}
        for p in db.query(models.WorkplaceNoticePosting).filter(models.WorkplaceNoticePosting.site_id == site_id,
                                                                models.WorkplaceNoticePosting.status == "confirmed").all():
            confirmed.setdefault((p.site_id, p.version_id), p)
    out = []
    for n in core.site_notices(db, site_id, cfg, rows=rows, ctx=ctx):
        live = core.live_version(db, n.id, rows=by.get(n.id, []))
        p = confirmed.get((site_id, live.id)) if live else None
        out.append({"noticeId": n.id, "title": n.title, "formCode": n.form_code or "", "area": n.area,
                    "versionId": live.id if live else "", "label": (live.label if live else "") or "",
                    "status": "confirmed" if p else ("no_file" if live is None else "missing"),
                    "confirmedAt": p.confirmed_at if p else "", "confirmedBy": p.confirmed_by if p else "",
                    "postingId": p.id if p else ""})
    return {"required": out, "missing": sum(1 for x in out if x["status"] == "missing")}


@router.get("/sites")
def sites(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_manage(db, user)
    cfg = core.settings(db)
    ctx: dict = {}
    info = core.site_info(db, ctx)
    rows = (db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active")
            .order_by(models.WorkplaceNotice.sort).all())
    by = _versions_by_notice(db)
    confirmed: dict = {}
    for p in db.query(models.WorkplaceNoticePosting).filter(models.WorkplaceNoticePosting.status == "confirmed").all():
        confirmed.setdefault((p.site_id, p.version_id), p)
    cache: dict = {}
    out = []
    for sid, s in sorted(info.items(), key=lambda kv: kv[1]["name"].lower()):
        b = site_board(db, sid, cfg, ctx, rows, by, confirmed)
        out.append({**s, "leadName": _name_of(db, s["lead"], cache), **b})
    return {"sites": out}


class SiteIn(BaseModel):
    kind: str = ""
    city: str = ""
    lead_email: str = ""


@router.put("/sites/{site_id}")
def set_site(site_id: str, body: SiteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    if db.get(models.HrWorkSite, site_id) is None:
        raise HTTPException(404, "Not in the Location Library")
    if body.kind and body.kind not in core.SITE_KINDS:
        raise HTTPException(400, "Kind is office, jobsite or storage")
    lead = core.norm(body.lead_email)
    if lead and db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == lead).first() is None:
        raise HTTPException(400, "The site lead must be someone in Nexus People")
    row = db.get(models.WorkplaceNoticeSite, site_id)
    if row is None:
        row = models.WorkplaceNoticeSite(site_id=site_id)
        db.add(row)
    before = {"kind": row.kind or "", "city": row.city or "", "lead": row.lead_email or ""}
    row.kind, row.city, row.lead_email = body.kind, (body.city or "").strip()[:60], lead
    row.updated_by, row.updated_at = me, core.now_iso()
    core.log_event(db, me, "site_set", site=site_id, before=before, after={"kind": body.kind, "city": row.city, "lead": lead})
    db.commit()
    return {"ok": True}


def _may_confirm(db: Session, me: str, site_id: str) -> bool:
    row = db.get(models.WorkplaceNoticeSite, site_id)
    return can_manage(db, me) or bool(row and core.norm(row.lead_email) == me)


@router.get("/my-sites")
def my_sites(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The sites I lead - their posters to put up and confirm."""
    me = core.norm(user.get("email"))
    ids = [r.site_id for r in db.query(models.WorkplaceNoticeSite).filter(func.lower(models.WorkplaceNoticeSite.lead_email) == me).all()]
    info = core.site_info(db)
    return {"sites": [{**info[s], **site_board(db, s)} for s in ids if s in info]}


@router.post("/sites/{site_id}/confirm")
def confirm_posting(site_id: str, notice_ids: str = Form(...), note: str = Form(""), photo: UploadFile = File(...),
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """These posters are up at this site - one photo can show several."""
    me = core.norm(user.get("email"))
    if not _may_confirm(db, me, site_id):
        raise HTTPException(403, "Only the site lead or HR confirms this site's posters")
    ctype = (photo.content_type or "").lower()
    if not ctype.startswith("image/"):
        raise HTTPException(400, "The proof is a photo of the posters on the wall")
    data = photo.file.read()
    if not data or len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, "The photo is empty or over 15 MB")
    ids = [x.strip() for x in (notice_ids or "").split(",") if x.strip()]
    board = {x["noticeId"]: x for x in site_board(db, site_id)["required"]}
    todo = [board[i] for i in ids if i in board and board[i]["versionId"]]
    if not todo:
        raise HTTPException(400, "Pick the posters this photo shows")
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", photo.filename or "photo.jpg")[:80]
    path = f"workplace-notices/sites/{site_id}/{uuid.uuid4().hex[:10]}-{safe}"
    res = _storage_put(_DOC_BUCKET, path, data, ctype)
    if not res.is_success:
        raise HTTPException(502, f"Storage upload failed: {res.text[:200]}")
    stamp = core.now_iso()
    for x in todo:
        db.add(models.WorkplaceNoticePosting(id=str(uuid.uuid4()), site_id=site_id, notice_id=x["noticeId"],
                                             version_id=x["versionId"], status="confirmed", photo_path=path,
                                             note=(note or "").strip()[:500], confirmed_by=me, confirmed_at=stamp,
                                             created_at=stamp))
    core.log_event(db, me, "posting_confirmed", site=site_id, notices=[x["noticeId"] for x in todo], photo=path)
    db.commit()
    return site_board(db, site_id)


@router.get("/postings/{pid}/photo")
def posting_photo(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = db.get(models.WorkplaceNoticePosting, pid)
    if p is None or not _may_confirm(db, core.norm(user.get("email")), p.site_id):
        raise HTTPException(404, "Not found")
    res = _storage_fetch(_DOC_BUCKET, p.photo_path)
    if not res.is_success:
        raise HTTPException(502, "Could not open the photo")
    return Response(content=res.content, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


# ── Coverage and the audit record ────────────────────────────────────────────

def _hire_missing(db: Session, e, pc: dict, cfg: dict, rows: list, by: dict, delivered: set) -> list:
    """At-hire notices this new hire has not been given (people who started
    before the module are out of scope - they were onboarded on paper)."""
    since = cfg.get("hireSince") or ""
    if not e.start_date or not since or e.start_date[:10] < since:
        return []
    out = []
    for n in rows:
        if n.trigger in ("hire", "hire_annual") and n.mode in ("deliver", "both") and n.kind != "form" \
                and core.applies(n, pc, cfg) and core.live_version(db, n.id, rows=by.get(n.id, [])) \
                and (pc["email"], n.id) not in delivered:
            out.append(n.title)
    return out


@router.get("/coverage")
def coverage(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Per person: what they still owe, what they were not given, where they
    are placed, and (California) the emergency contact question; plus the
    totals HR reports on."""
    _require_manage(db, user)
    cfg = core.settings(db)
    emps = core.active_people(db)
    ctx = core.preload(db, emps)
    rows = (db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active")
            .order_by(models.WorkplaceNotice.sort).all())
    by = _versions_by_notice(db)
    numbers = core.version_numbers(db)
    delivered = {(core.norm(e), n) for e, n in db.query(models.WorkplaceNoticeDelivery.email,
                                                          models.WorkplaceNoticeDelivery.notice_id)
                 .filter(models.WorkplaceNoticeDelivery.reason == "hire").all()}
    sb = db.get(models.WorkplaceNotice, "ca-sb294")
    people = []
    for e in emps:
        pc = core.person_context(db, e, ctx)
        owed = core.owed(db, e, ctx, cfg, by, rows, numbers)
        sb_row = ctx["people"].get(pc["email"])
        people.append({
            "email": pc["email"], "name": core.person_name(e), "company": pc["company"], "country": pc["country"],
            "state": pc["state"], "stateLabel": pc["stateLabel"], "workerType": pc["workerType"],
            "owed": [{"title": n.title, "due": st["due"], "overdue": st["overdue"], "reason": st["reason"]} for n, st in owed],
            "notGiven": _hire_missing(db, e, pc, cfg, rows, by, delivered),
            "emergency": ("" if not (sb is not None and core.applies(sb, pc, cfg))
                          else ("answered" if (sb_row and (sb_row.sb294 or {}).get("answeredAt")) else "open")),
        })
    people.sort(key=lambda p: (-len([o for o in p["owed"] if o["overdue"]]), -len(p["owed"]), p["name"].lower()))

    def unplaced(p):
        return p["country"] == "US" and p["workerType"] == "employee" and not p["state"]
    # Complete = placed and nothing owed: someone with no state only got the federal notices (e2e, Oct 23).
    return {"people": people, "totals": {
        "people": len(people),
        "allDone": sum(1 for p in people if not (p["owed"] or p["notGiven"] or p["emergency"] == "open" or unplaced(p))),
        "owing": sum(1 for p in people if p["owed"]), "overdue": sum(1 for p in people if any(o["overdue"] for o in p["owed"])),
        "notGiven": sum(1 for p in people if p["notGiven"]), "unplaced": sum(1 for p in people if unplaced(p)),
        "emergencyOpen": sum(1 for p in people if p["emergency"] == "open")}}


def _csv(name: str, header: list, rows: list) -> Response:
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "private, no-store"})


_REC_HEADER = ["Person", "Email", "Notice", "Form", "Version", "Version Effective", "What Happened", "Channel", "Sent To",
               "Sent", "Opened", "Acknowledged", "Typed Name", "IP", "Device", "File Fingerprint (SHA-256)", "Email Error"]
_WHAT = {"hire": "Given at hire", "annual": "Yearly notice", "separation": "Given at separation", "manual": "Sent by HR",
         "acknowledge": "Acknowledged", "portal": "Opened in Nexus", "new_version": "New version"}


def _us_dt(iso: str) -> str:
    """MM/DD/YYYY hh:mm AM/PM UTC for the record (US format everywhere)."""
    if not iso:
        return ""
    try:
        from datetime import datetime as _dt
        t = _dt.fromisoformat(iso.replace("Z", "+00:00"))
        return t.strftime("%m/%d/%Y %I:%M %p UTC")
    except ValueError:
        return iso


def _record_rows(db: Session, q) -> list:
    titles = {n.id: (n.title, n.form_code or "") for n in db.query(models.WorkplaceNotice).all()}
    vers = {v.id: v for v in db.query(models.WorkplaceNoticeVersion).all()}
    cache: dict = {}
    out = []
    for r in q.order_by(models.WorkplaceNoticeDelivery.created_at).all():
        v = vers.get(r.version_id)
        t, f = titles.get(r.notice_id, ("", ""))
        out.append([_name_of(db, r.email, cache), r.email, t, f, (v.label or f"Version {v.number}") if v else "",
                    _us(v.effective_date) if v else "", _WHAT.get(r.reason, r.reason), r.channel, r.sent_to or "",
                    _us_dt(r.sent_at), _us_dt(r.viewed_at), _us_dt(r.acknowledged_at), r.typed_name or "",
                    r.ip or "", r.user_agent or "", r.content_hash or "", r.error or ""])
    return out


@router.get("/export/person/{email}")
def export_person(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everything one person was given, opened and acknowledged - the answer
    to "show me what this employee received, and when"."""
    me = _require_manage(db, user)
    em = core.norm(email)
    rows = _record_rows(db, db.query(models.WorkplaceNoticeDelivery).filter(models.WorkplaceNoticeDelivery.email == em))
    core.log_event(db, me, "exported", scope="person", email=em, rows=len(rows))
    db.commit()
    return _csv(f"workplace-notices-{em.split('@')[0]}.csv", _REC_HEADER, rows)


@router.get("/export/notice/{nid}")
def export_notice(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everyone a notice went to, and who acknowledged which version."""
    me = _require_manage(db, user)
    if db.get(models.WorkplaceNotice, nid) is None:
        raise HTTPException(404, "Notice not found")
    rows = _record_rows(db, db.query(models.WorkplaceNoticeDelivery).filter(models.WorkplaceNoticeDelivery.notice_id == nid))
    core.log_event(db, me, "exported", nid, scope="notice", rows=len(rows))
    db.commit()
    return _csv(f"workplace-notice-{nid}.csv", _REC_HEADER, rows)


@router.get("/export/all")
def export_all(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _require_manage(db, user)
    rows = _record_rows(db, db.query(models.WorkplaceNoticeDelivery))
    core.log_event(db, me, "exported", scope="all", rows=len(rows))
    db.commit()
    return _csv("workplace-notices-record.csv", _REC_HEADER, rows)


@router.get("/export/versions")
def export_versions(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every version of every notice: when it was in effect, who prepared and
    approved it, and the fingerprint of each file."""
    me = _require_manage(db, user)
    titles = {n.id: (n.title, n.form_code or "", n.area) for n in db.query(models.WorkplaceNotice).all()}
    cache: dict = {}
    rows = []
    for v in (db.query(models.WorkplaceNoticeVersion)
              .order_by(models.WorkplaceNoticeVersion.notice_id, models.WorkplaceNoticeVersion.number).all()):
        t, f, a = titles.get(v.notice_id, ("", "", ""))
        rows.append([t, f, a, v.number, v.label or "", STATUS_LABEL.get(v.status, v.status), _us(v.effective_date),
                     v.agency_revision or "", v.summary or "", _name_of(db, v.prepared_by, cache) or v.prepared_by,
                     _us_dt(v.prepared_at), _name_of(db, v.approved_by, cache), _us_dt(v.approved_at), v.origin or "",
                     "; ".join(f"{x.get('lang')}:{x.get('sha256', '')}" for x in (v.files or []))])
    core.log_event(db, me, "exported", scope="versions", rows=len(rows))
    db.commit()
    return _csv("workplace-notice-versions.csv",
                ["Notice", "Form", "Area", "Number", "Label", "Status", "Effective", "Agency Revision", "What Changed",
                 "Prepared By", "Prepared", "Approved By", "Approved", "Origin", "Files (language:SHA-256)"], rows)
