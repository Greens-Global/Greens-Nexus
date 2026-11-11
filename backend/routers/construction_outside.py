"""Outside parties on a Job (Construction Round Three item 4, Neil,
11/11/2026, plan https://claude.ai/artifact/VqZSQRz41ffF1VGouJUKLJ).

Two ways in for someone outside the company, decided by Neil ("both if
needed"):

  LINKS (this module) - one record, no login, for a one-off action:
    rfi   an architect or engineer reads one RFI (question and files) and
          answers it, with files of their own;
    sub   a subcontractor sees their open punch items on one job (the items
          a manager gave their Intacct VENDORID) and marks each one Done
          with a photo. Verify stays inside.
  GUESTS - an Entra guest who works in Nexus regularly is put on a job's
          crew like anyone else; the construction reads already confine
          them to the jobs they are on (routers/construction._may_read),
          and a guest is refused as a job manager (the money opens there).

A link (models.ConstructionOutsideLink) is a random token shown ONCE - only
its SHA-256 is stored - that expires (1 to 60 days, 14 by default), may be
revoked, counts its uses and logs every action on the job's activity with
the outside person's name. Every write runs AS THE PERSON WHO SENT THE LINK
(as a workflow runs as its owner): their reach is checked again at each
use, and a sender who left or lost the job ends the link. Files never touch
the browser's storage session: the server checks the type and size and
puts them in the job's own construction-media folder (the same canonical
links and Egnyte sweep as every job file); what the page shows of the
job's files are short signed URLs (construction_storage.fetch_url).

The public routes are /construction-outside/<token>: SENSITIVE_PREFIXES
(30 a minute per IP), TOKEN_PATH_PREFIXES (the trip log never records a
token) and a body cap in middleware_hardening. They are sync routes, so the
storage upload and the queries run in FastAPI's threadpool, never on the
event loop.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_company
import construction_notify
import models
import vendor_compliance as vc
from app_url import app_url
from auth import get_current_user
from database import get_db
from routers.construction import _log_activity, _may_review, _me, _project, now_iso
from services import construction_storage as storage

router = APIRouter(prefix="/construction", tags=["Construction"], dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/construction-outside", tags=["Construction Outside Links"])

KINDS = ("rfi", "sub")
DEFAULT_DAYS, MAX_DAYS = 14, 60
MAX_FILES, MAX_FILE_BYTES = 3, 20 * 1024 * 1024
FILE_TYPES = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
              "image/heic": "heic", "image/heif": "heif"}
PHOTO_TYPES = {k: v for k, v in FILE_TYPES.items() if k.startswith("image/")}
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
GONE = "This link has expired or was turned off. Ask the person who sent it for a new one."


def _hash(token: str) -> str:
    return hashlib.sha256((token or "").encode()).hexdigest()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _when(s: str):
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def link_url(token: str) -> str:
    return f"{app_url()}/outside/{token}"


def is_live(link, now: datetime | None = None) -> bool:
    exp = _when(link.expires_at)
    return not link.revoked_at and exp is not None and exp > (now or datetime.now(timezone.utc))


def link_to_dict(link, names: dict | None = None) -> dict:
    names = names or {}
    return {"id": link.id, "projectId": link.project_id, "kind": link.kind, "refId": link.ref_id,
            "name": link.name or "", "email": link.email or "", "createdBy": link.created_by or "",
            "createdByName": names.get((link.created_by or "").lower(), ""), "createdAt": link.created_at or "",
            "expiresAt": link.expires_at or "", "revokedAt": link.revoked_at or "", "uses": link.uses or 0,
            "lastUsedAt": link.last_used_at or "", "live": is_live(link)}


# ── Staff: send, list, revoke ────────────────────────────────────────────────

def _target(db: Session, p, kind: str, ref_id: str) -> str:
    """What the link is for, in words - or a 422 when it is not this job's."""
    if kind == "rfi":
        r = db.query(models.ConstructionRfi).filter(models.ConstructionRfi.id == ref_id,
                                                     models.ConstructionRfi.deleted_at == "").first()
        if r is None or r.project_id != p.id:
            raise HTTPException(422, "Pick an RFI from this job.")
        if (r.status or "open") != "open":
            raise HTTPException(409, "Only an open RFI can be sent out to answer.")
        return " ".join(x for x in ((r.number or "").strip(), (r.subject or "").strip()) if x) or "an RFI"
    if ref_id not in {lk.ref_id for lk in vc.live_subs(db, [p.id])}:
        raise HTTPException(422, "Pick a sub that is on this job.")
    row = db.get(models.VendorCompliance, ref_id)
    return (row.vendor_name if row is not None else "") or ref_id


def _mail(link, p, token: str, what: str, sender_name: str) -> None:
    """The link by email (best effort - the link is also shown to the sender)."""
    url = link_url(token)
    ask = ("answer this RFI" if link.kind == "rfi" else "mark your punch items done, with a photo of each")
    html = f"""
      <div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 4px;font-size:19px">{escape(p.name or '')}</h2>
        <p style="font-size:14px;line-height:1.5">{escape(sender_name)} asked you to {escape(ask)}: <b>{escape(what)}</b>.</p>
        <p><a href="{escape(url, quote=True)}" style="font-size:14px">Open It</a> - no sign-in needed.</p>
        <p style="color:#666;font-size:12px">The link is for you only and works until
          {escape(construction_notify._us(link.expires_at[:10]))}.</p>
      </div>"""
    subject = (f"RFI to Answer - {p.name}" if link.kind == "rfi" else f"Your Punch List - {p.name}")
    why = construction_notify._send(to=[link.email], subject=subject, html=html)
    if why:
        print(f"[construction-outside] mail for {link.id}: {why}")


class LinkIn(BaseModel):
    kind: str
    ref_id: str
    name: Optional[str] = ""
    email: Optional[str] = ""
    days: Optional[int] = DEFAULT_DAYS
    send_email: Optional[bool] = True


@router.post("/projects/{job_id}/outside-links", status_code=201)
def send_link(job_id: str, body: LinkIn, background_tasks: BackgroundTasks,
              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A link for one outside person: the RFI to answer, or a sub's punch
    list. The URL is in this answer ONLY - it is never stored."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager sends an outside link.")
    if body.kind not in KINDS:
        raise HTTPException(422, "A link is for an RFI or a sub.")
    ref = (body.ref_id or "").strip()[:64]
    what = _target(db, p, body.kind, ref)
    email = (body.email or "").strip().lower()[:200]
    if email and not _EMAIL.match(email):
        raise HTTPException(422, f"{email!r} is not an email address")
    if body.send_email and not email:
        raise HTTPException(422, "Add their email to send the link, or copy it instead.")
    days = max(1, min(MAX_DAYS, int(body.days or DEFAULT_DAYS)))
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    link = models.ConstructionOutsideLink(
        id=str(uuid.uuid4()), project_id=p.id, kind=body.kind, ref_id=ref,
        name=" ".join((body.name or "").split())[:120], email=email, token_hash=_hash(token),
        created_by=_me(user), created_at=_iso(now), expires_at=_iso(now + timedelta(days=days)),
        revoked_at="", revoked_by="", last_used_at="", uses=0)
    db.add(link)
    _log_activity(db, project_id=p.id, entity_kind="outside_link", entity_id=link.id, type="outside_link_sent",
                  actor_email=_me(user), detail=f"sent {link.name or email or 'an outside person'} a link for {what}"[:500])
    db.commit()
    if body.send_email:
        sender = construction_company.people_names(db, {_me(user)}).get(_me(user)) or _me(user)
        background_tasks.add_task(_mail, link, p, token, what, sender)
    return {**link_to_dict(link), "url": link_url(token), "what": what}


@router.get("/projects/{job_id}/outside-links")
def list_links(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager sees the outside links.")
    L = models.ConstructionOutsideLink
    rows = db.query(L).filter(L.project_id == p.id).order_by(L.created_at.desc()).all()
    names = construction_company.people_names(db, {(r.created_by or "").lower() for r in rows})
    return {"links": [link_to_dict(r, names) for r in rows]}


@router.post("/outside-links/{link_id}/revoke")
def revoke_link(link_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    link = db.get(models.ConstructionOutsideLink, link_id)
    if link is None:
        raise HTTPException(404, "Not found")
    p = _project(db, link.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager turns a link off.")
    if not link.revoked_at:
        link.revoked_at, link.revoked_by = now_iso(), _me(user)
        _log_activity(db, project_id=p.id, entity_kind="outside_link", entity_id=link.id, type="outside_link_revoked",
                      actor_email=_me(user), detail=f"turned off the link for {link.name or link.email or 'an outside person'}")
        db.commit()
    return link_to_dict(link)


class PunchSubIn(BaseModel):
    vendor_id: Optional[str] = ""


@router.post("/punch/{task_id}/sub")
def set_punch_sub(task_id: str, body: PunchSubIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Give a punch item to one of the job's subs ('' = our own crew)."""
    from routers.construction_jobs import _meta, _punch_task
    job, _tp, t = _punch_task(db, task_id, user)
    if not _may_review(db, user, job):
        raise HTTPException(403, "Only a job manager gives a punch item to a sub.")
    vid = (body.vendor_id or "").strip()[:64]
    if vid and vid not in {lk.ref_id for lk in vc.live_subs(db, [job.id])}:
        raise HTTPException(422, "Pick a sub that is on this job.")
    m = _meta(db, job, t.id)
    m.sub_vendor_id, m.modified_at = vid, now_iso()
    db.commit()
    return {"taskId": t.id, "subVendorId": vid}


# ── The public page ──────────────────────────────────────────────────────────

def _resolve(db: Session, token: str, kind: str | None = None):
    """(link, job, sender) for a live token, else 404 / 410. The sender must
    still exist and still manage the job - the link acts as them."""
    import task_automation
    if not _TOKEN.match(token or ""):
        raise HTTPException(404, "This link is not valid.")
    L = models.ConstructionOutsideLink
    link = db.query(L).filter(L.token_hash == _hash(token)).first()
    if link is None:
        raise HTTPException(404, "This link is not valid.")
    if kind and link.kind != kind:
        raise HTTPException(404, "This link is not valid.")
    if not is_live(link):
        raise HTTPException(410, GONE)
    p = db.get(models.ConstructionProject, link.project_id)
    sender = task_automation._person_user(db, link.created_by or "")
    if p is None or p.deleted_at or sender is None or not _may_review(db, sender, p):
        raise HTTPException(410, GONE)
    # A sub taken off the job loses their punch list at once (review, 11/11/2026).
    if link.kind == "sub" and link.ref_id not in {lk.ref_id for lk in vc.live_subs(db, [p.id])}:
        raise HTTPException(410, GONE)
    return link, p, sender


def _touch(link) -> None:
    link.uses = int(link.uses or 0) + 1
    link.last_used_at = now_iso()


def _signed(url: str, project_id: str) -> str:
    try:
        return storage.fetch_url(url, project_id)
    except Exception:   # noqa: BLE001 - a file that cannot be signed is left off, never a 500
        return ""


def _file_name(url: str) -> str:
    return (url or "").rsplit("/", 1)[-1].split("?", 1)[0] or "File"


def _who(link) -> str:
    name = link.name or ""
    return f"{name} <{link.email}>" if name and link.email else (name or link.email or "Outside link")


def _punch_items(db: Session, p, vendor_id: str) -> list:
    import construction_tasks
    tp = construction_tasks.task_project(db, p)
    sec = construction_tasks.punch_section(db, tp, create=False) if tp else None
    if tp is None or sec is None:
        return []
    M = models.ConstructionPunchMeta
    metas = {m.task_id: m for m in db.query(M).filter(M.project_id == p.id, M.sub_vendor_id == vendor_id).all()}
    if not metas:
        return []
    T = models.Task
    tasks = (db.query(T).filter(T.id.in_(list(metas)), T.project_id == tp.id, T.section_id == sec.id,
                                (T.deleted_at == "") | (T.deleted_at.is_(None))).all())
    return [(t, metas[t.id]) for t in sorted(tasks, key=lambda t: (bool(t.completed), t.due_on or "9999", t.title or ""))]


@public_router.get("/{token}")
def outside_page(token: str, db: Session = Depends(get_db)):
    """What the outside person sees: the job, who it is for, and the RFI or
    the sub's punch items. Names and words only - never money, never anyone
    else's records."""
    link, p, _sender = _resolve(db, token)
    _touch(link)
    db.commit()
    out = {"kind": link.kind, "job": {"name": p.name or "", "address": p.address or ""},
           "for": link.name or "", "expiresAt": link.expires_at, "today": construction_company.local_today(db, p).isoformat()}
    if link.kind == "rfi":
        r = db.get(models.ConstructionRfi, link.ref_id)
        if r is None or r.deleted_at:
            raise HTTPException(410, GONE)
        out["rfi"] = {"number": r.number or "", "subject": r.subject or "", "question": r.question or "",
                      "dueOn": r.due_on or "", "status": r.status or "open", "answer": r.answer or "",
                      "answeredOn": r.answered_on or "", "answeredBy": r.answered_by or "",
                      "files": [{"name": _file_name(u), "url": _signed(u, p.id)} for u in (r.document_urls or [])]}
        out["canAnswer"] = (r.status or "open") == "open"
    else:
        row = db.get(models.VendorCompliance, link.ref_id)
        out["sub"] = {"name": (row.vendor_name if row is not None else "") or link.ref_id}
        out["items"] = [{"id": t.id, "title": t.title or "", "notes": (t.description or "")[:1000],
                         "location": m.location_text or "", "dueOn": t.due_on or "", "done": bool(t.completed),
                         "doneAt": m.done_at or "", "photoUrl": _signed(m.done_photo_url, p.id) if m.done_photo_url else ""}
                        for t, m in _punch_items(db, p, link.ref_id)]
    return out


def _read(f: UploadFile, types: dict) -> dict:
    """One uploaded file, checked (type, size) and read - nothing stored yet,
    so a bad file later in the same request leaves nothing behind."""
    ctype = (f.content_type or "").lower().split(";")[0].strip()
    if ctype not in types:
        raise HTTPException(422, "Attach a PDF or a photo." if "application/pdf" in types else "Attach a photo.")
    data = f.file.read(MAX_FILE_BYTES + 1)
    if not data:
        raise HTTPException(422, "That file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "Each file can be at most 20 MB.")
    return {"data": data, "mime": ctype, "ext": types[ctype],
            "name": re.sub(r"[^A-Za-z0-9 ._-]", "_", f.filename or "")[-120:]}


def _put(p, got: dict) -> dict:
    """A checked file into the job's construction-media folder; its canonical URL."""
    from routers import esign
    prefix = storage.public_prefix()
    if not prefix:
        raise HTTPException(503, "File storage is not set up on this server.")
    path = f"construction/{p.id}/outside-{uuid.uuid4().hex}.{got['ext']}"
    if not esign._storage_put(storage.BUCKET, path, got["data"], got["mime"]).is_success:
        raise HTTPException(503, "The file could not be saved just now - please try again in a minute.")
    return {"url": prefix + path, "path": path, "mime": got["mime"], "size": len(got["data"]), "name": got["name"]}


@public_router.post("/{token}/answer")
def outside_answer(token: str, answer: str = Form(""), files: List[UploadFile] = File(default=[]),
                   db: Session = Depends(get_db)):
    """The RFI's answer, with up to three files. Once: the RFI is then
    Answered and the page reads it back."""
    link, p, sender = _resolve(db, token, "rfi")
    text = (answer or "").strip()
    if len(text) < 2:
        raise HTTPException(422, "Write the answer first.")
    if len(files or []) > MAX_FILES:
        raise HTTPException(422, f"Attach at most {MAX_FILES} files.")
    R = models.ConstructionRfi
    r = db.query(R).filter(R.id == link.ref_id, R.deleted_at == "").with_for_update().first()
    if r is None:
        raise HTTPException(410, GONE)
    if (r.status or "open") != "open":
        raise HTTPException(409, "This RFI was already answered.")
    checked = [_read(f, FILE_TYPES) for f in (files or []) if f is not None and (f.filename or f.content_type)]
    stored = [_put(p, g) for g in checked]
    today = construction_company.local_today(db, p).isoformat()
    r.answer, r.status, r.answered_on = text[:6000], "answered", today
    r.answered_by = _who(link)[:200]
    r.document_urls = list(r.document_urls or []) + [s["url"] for s in stored]
    r.modified_at = now_iso()
    _touch(link)
    what = " ".join(x for x in ((r.number or "").strip(), (r.subject or "").strip()) if x) or "an RFI"
    _log_activity(db, project_id=p.id, entity_kind="rfi", entity_id=r.id, type="answered_outside",
                  actor_email=_me(sender), detail=f"{_who(link)} answered {what} through an outside link"[:500])
    from routers.construction import _emit
    _emit(db, "rfi.answered", r, sender, changes={"status": ("open", "answered")})
    for who in {(link.created_by or "").lower(), (r.responder_email or "").lower()} - {""}:
        construction_notify.bell(
            db, kind="rfi_answered_outside", recipient=who, ref_id=r.id, family=("rfi_answered_outside",),
            title=f"RFI Answered - {p.name}", body=f"{link.name or link.email or 'The outside party'} answered {what}.",
            requested_by=_me(sender), label="Open RFIs", sub=f"project:{p.id}:rfis", company=p.company_id or "")
    db.commit()
    return {"ok": True, "answeredOn": today, "files": len(stored)}


@public_router.post("/{token}/done/{task_id}")
def outside_done(token: str, task_id: str, background_tasks: BackgroundTasks, photo: UploadFile = File(...),
                 note: str = Form(""), db: Session = Depends(get_db)):
    """A sub's punch item Done, with a photo of the finished work - through
    Tasks' own update_task, as the link's sender. Verify stays inside."""
    from routers import tasks as tasks_router
    from routers.construction_field import JobMediaBody, make_media
    from routers.construction_jobs import _meta
    link, p, sender = _resolve(db, token, "sub")
    pairs = {t.id: (t, m) for t, m in _punch_items(db, p, link.ref_id)}
    if task_id not in pairs:
        raise HTTPException(404, "That punch item is not on your list.")
    # One Done per item however often the phone resends (review, 11/11/2026):
    # the task row is locked before it is read as not done.
    t = db.query(models.Task).filter(models.Task.id == task_id).with_for_update().first()
    if t is None or t.completed:
        raise HTTPException(409, "That punch item is already done.")
    s = _put(p, _read(photo, PHOTO_TYPES))
    media = make_media(db, sender, p, JobMediaBody(kind="photo", url=s["url"], storage_path=s["path"], mime_type=s["mime"],
                                                   size_bytes=s["size"], original_name=s["name"],
                                                   description=(f"Done - {link.name or link.email}: {note.strip()}" if note.strip()
                                                                else f"Done - {link.name or link.email}")[:500]),
                       task_id=t.id, extra_tags=("punch",))
    meta = _meta(db, p, t.id)
    meta.done_media_id, meta.done_photo_url = media.id, media.url or ""
    # Who did it: the outside person's email, else their name (a copy-only link has no email).
    meta.done_by = ((link.email or "").lower() or link.name or "outside link")[:200]
    meta.done_at, meta.modified_at = now_iso(), now_iso()
    _touch(link)
    _log_activity(db, project_id=p.id, entity_kind="punch", entity_id=t.id, type="done_outside",
                  actor_email=_me(sender), detail=f"{_who(link)} marked {t.title or 'a punch item'} Done through an outside link"[:500])
    db.flush()
    tasks_router.update_task(t.id, tasks_router.TaskUpdate(completed=True), background_tasks, sender, db)
    return {"ok": True, "id": t.id}
