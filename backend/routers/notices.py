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

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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
