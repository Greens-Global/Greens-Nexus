"""Ask HR runs through Tickets (Neil, Oct 27 2026).

Ask HR used to be its own small queue (`hr_self_requests`: open -> resolved,
one answer, one attachment). It is now the Tickets module's confidential HR
desk (ticket_confidential.py):

  - a new request is filed with `tickets.file_ticket` (THE way a ticket is
    created) into the requester's company's HR desk: `confidential_desk="hr"`,
    the company's HR contact as the default assignee, the ticket SLAs from
    the desk settings, the thread, attachments, email and Teams of any ticket;
  - the form stays where people find it (My HR / Workday's Ask HR) with the
    same four kinds, kept on the ticket as `type_fields.askHrKind` and as its
    Help With (`application`);
  - My Requests lists the person's HR tickets with their status; requests
    resolved before the move stay in `hr_self_requests`, read-only, as
    Earlier Requests;
  - every OPEN old request is moved into a ticket once (`migrate_open`,
    startup and Settings-free admin action): idempotent - the old row gets
    `ticket_id` and a row that has one is never moved again. Nothing is
    deleted: the old row stays, with its message, attachment and author.
"""
import html as html_lib
import json
import uuid
from datetime import datetime, timezone

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import ticket_confidential

KINDS = ("document", "profile", "question", "other")
# The ticket's Help With - Title Case, one per kind (the old form's choices).
KIND_LABEL = {"document": "Document Update", "profile": "Profile Change",
              "question": "HR Question", "other": "Other HR Request"}
KIND_KEY = "askHrKind"          # type_fields key - not an svc_ question, so the drawer shows no field for it
EVIDENCE_BUCKET = "ticket-evidence"   # the ticket upload path's bucket (tickets/evidenceUpload.js)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _subject(kind: str, message: str) -> str:
    first = " ".join((message or "").split())
    if len(first) > 80:
        first = first[:79].rstrip() + "…"
    return f"{KIND_LABEL.get(kind, KIND_LABEL['other'])}: {first}" if first else KIND_LABEL.get(kind, "HR Request")


def _description(message: str) -> str:
    """The employee's words as the ticket's rich-text description - escaped,
    one paragraph per line, never interpreted as markup."""
    lines = [ln for ln in (message or "").replace("\r\n", "\n").split("\n")]
    return "".join(f"<p>{html_lib.escape(ln) if ln.strip() else '<br>'}</p>" for ln in lines).strip()


def kind_of(t) -> str:
    tf = t.type_fields if isinstance(t.type_fields, dict) else {}
    k = (tf.get(KIND_KEY) or "").strip()
    return k if k in KINDS else "other"


# ── Files: an old client's staged hr-docs file onto the ticket ──────────────

def _evidence_url(key: str) -> str:
    from routers.hr import _SUPABASE_URL
    return f"{_SUPABASE_URL}/storage/v1/object/public/{EVIDENCE_BUCKET}/{key}"


def copy_hr_doc_to_ticket(path: str, name: str) -> str:
    """Copy an Ask HR file staged in the private hr-docs bucket into the
    private ticket-evidence bucket (where every ticket attachment lives) -
    the canonical URL, or "" when storage refused or is not configured. The
    hr-docs original is left where it is."""
    import re
    import httpx
    from routers.hr import _DOC_BUCKET, _SUPABASE_URL, _storage_headers
    if not path:
        return ""
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", name or "document")[:120]
    key = f"ask-hr/{uuid.uuid4()}-{safe}"
    try:
        resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/copy",
                          headers={**_storage_headers(), "Content-Type": "application/json"},
                          json={"bucketId": _DOC_BUCKET, "sourceKey": path,
                                "destinationBucket": EVIDENCE_BUCKET, "destinationKey": key}, timeout=20)
    except Exception:   # noqa: BLE001 - storage down / not configured: the caller notes it
        return ""
    return _evidence_url(key) if resp.is_success else ""


def _attach(db: Session, t, actor: str, name: str, url: str) -> None:
    """One file on the ticket, recorded the way the attachment route does
    (row + history line), without the requester's own bell."""
    from routers.task_util import gen_id, log_activity
    db.add(models.TaskAttachment(id=gen_id(), task_id=t.id, name=(name or "document")[:200], size="",
                                 kind="doc", url=url, added_at=_now(), added_by=actor))
    log_activity(db, type="attached", actor_email=actor, entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=f'attached "{name}"')


def _note_missing_file(db: Session, t, actor: str, name: str, path: str) -> None:
    """The file could not be copied: an internal note (HR only) says where it
    is, so it is never silently lost."""
    from routers.task_util import gen_id
    db.add(models.TaskComment(
        id=gen_id(), task_id=t.id, author_email="system", internal=True, created_at=_now(),
        body=(f"<p>The employee attached {html_lib.escape(name or 'a file')}, but it could not be copied "
              f"onto this ticket. It is kept in HR's documents storage at {html_lib.escape(path)}.</p>")))


# ── Filing ───────────────────────────────────────────────────────────────────

def file_ask_hr(db: Session, user: dict, kind: str, message: str, background_tasks: BackgroundTasks,
                attachment_path: str = "", attachment_name: str = "") -> dict:
    """A new Ask HR request, filed as a confidential HR ticket through
    tickets.file_ticket. `attachment_path` is an OLD client's hr-docs file
    (staged under self-requests/<email>/ by /myhr/requests/attachment); the
    current form attaches through the ticket upload path after filing."""
    from routers import tickets as T
    if kind not in KINDS:
        raise HTTPException(400, f"type must be one of {KINDS}")
    msg = (message or "").strip()
    if not msg:
        raise HTTPException(400, "Say what you need from HR")
    me = (user.get("email") or "").strip().lower()
    apath = (attachment_path or "").strip()
    if apath and not apath.startswith(f"self-requests/{me}/"):
        raise HTTPException(400, "Bad attachment")
    body = T.TicketBody(subject=_subject(kind, msg), description=_description(msg[:4000]),
                        type="other", priority="medium", requester_email=me,
                        application=KIND_LABEL[kind], type_fields={KIND_KEY: kind})
    out = T.file_ticket(body, background_tasks, user, db, confidential_desk=ticket_confidential.DESK_HR)
    if apath:
        t = ticket_confidential.include(db.query(models.TaskTicket)).filter(models.TaskTicket.id == out["id"]).first()
        url = copy_hr_doc_to_ticket(apath, attachment_name)
        if url:
            _attach(db, t, me, attachment_name or "document", url)
        else:
            _note_missing_file(db, t, me, attachment_name, apath)
        db.commit()
    return out


# ── The employee's My Requests ───────────────────────────────────────────────

def _my_hr_tickets(db: Session, me: str) -> list:
    T = models.TaskTicket
    return (ticket_confidential.include(db.query(T))
            .filter(func.lower(T.requester_email) == me, T.confidential_desk == ticket_confidential.DESK_HR)
            .order_by(T.created_at.desc()).limit(100).all())


def _latest_replies(db: Session, tickets: list) -> dict:
    """{ticket id: the newest public reply by someone other than the
    requester} - what "HR answered" means on My Requests."""
    if not tickets:
        return {}
    C = models.TaskComment
    req = {t.id: (t.requester_email or "").lower() for t in tickets}
    out: dict = {}
    for c in (db.query(C).filter(C.task_id.in_(list(req)), (C.internal.is_(False)) | (C.internal.is_(None)))
              .order_by(C.created_at.desc()).all()):
        if c.task_id in out or (c.author_email or "").lower() == req[c.task_id]:
            continue
        from routers.tickets import _comment_preview
        out[c.task_id] = {"authorId": (c.author_email or "").lower(), "preview": _comment_preview(c.body or "", 300),
                          "createdAt": c.created_at or ""}
    return out


def ser_ticket(t, reply: dict | None, attachments: list) -> dict:
    """An HR ticket in the old Ask HR shape (old clients read id / type /
    message / status / response), plus what the ticket adds."""
    status = t.status if (t.status and t.status != "new") else "open"
    import re
    plain = re.sub(r"\s+", " ", html_lib.unescape(re.sub(r"<[^>]+>", " ", t.description or ""))).strip()
    return {"id": t.id, "source": "ticket", "ticketId": t.id, "code": t.code or "",
            "subject": t.subject or "", "type": kind_of(t),
            "message": plain, "status": status, "assigneeId": (t.assignee_email or "") or None,
            "attachmentName": attachments[0] if attachments else "", "attachmentNames": attachments,
            "response": (reply or {}).get("preview", ""), "responseBy": (reply or {}).get("authorId", ""),
            "responseAt": (reply or {}).get("createdAt", ""),
            "resolvedBy": "", "resolvedAt": t.resolved_at or "", "createdAt": t.created_at or "",
            "modifiedAt": t.modified_at or "", "requesterUpdateAt": t.requester_update_at or "",
            "requesterSeenAt": t.requester_seen_at or "", "readOnly": False}


def ser_earlier(r) -> dict:
    """A request from before the move - read-only."""
    return {"id": r.id, "source": "earlier", "ticketId": r.ticket_id or "", "code": "",
            "email": r.employee_email, "name": r.employee_name, "type": r.type, "message": r.message,
            "status": r.status, "attachmentName": r.attachment_name or "",
            "response": r.response or "", "resolvedBy": r.resolved_by or "",
            "resolvedAt": r.resolved_at or "", "createdAt": r.created_at, "readOnly": True}


def my_requests(db: Session, me: str) -> list:
    """My HR tickets (newest first), then my Earlier Requests - the old rows
    that were never moved into a ticket (resolved before the move)."""
    me = (me or "").strip().lower()
    tickets = _my_hr_tickets(db, me)
    replies = _latest_replies(db, tickets)
    names: dict = {}
    if tickets:
        A = models.TaskAttachment
        for a in (db.query(A.task_id, A.name).filter(A.task_id.in_([t.id for t in tickets]))
                  .order_by(A.added_at).all()):
            names.setdefault(a.task_id, []).append(a.name or "")
    out = [ser_ticket(t, replies.get(t.id), names.get(t.id, [])) for t in tickets]
    R = models.HrSelfRequest
    earlier = (db.query(R).filter(func.lower(R.employee_email) == me,
                                  func.coalesce(R.ticket_id, "") == "")
               .order_by(R.created_at.desc()).limit(100).all())
    return out + [ser_earlier(r) for r in earlier]


# ── HR's side ────────────────────────────────────────────────────────────────

def desk_tickets(db: Session, user: dict, open_only: bool = False) -> list:
    """The HR desk for this caller: the confidential HR tickets they WORK -
    assigned to them, or in a company they are HR for (may_work, the final
    guard on every row) - never their own requests."""
    import auth
    me = (user.get("email") or "").strip().lower()
    T = models.TaskTicket
    q = (ticket_confidential.include(db.query(T))
         .filter(T.confidential_desk == ticket_confidential.DESK_HR)
         .filter(ticket_confidential.visible_filter(db, user)))
    scope = auth.company_scope(user, db)
    if scope is not None:
        q = q.filter(func.coalesce(T.company_id, "").in_(sorted(scope)))
    if open_only:
        q = q.filter(func.coalesce(T.status, "").notin_(("resolved", "closed")))
    return [t for t in q.order_by(T.created_at.desc()).limit(500).all()
            if (t.requester_email or "").strip().lower() != me and ticket_confidential.may_work(db, user, t)]


def waiting_on(db: Session, user: dict) -> int:
    """HR > People's Ask HR count: open HR tickets I work - assigned to me, or
    nobody's yet in a company I am HR for."""
    me = (user.get("email") or "").strip().lower()
    n = 0
    for t in desk_tickets(db, user, open_only=True):
        who = (t.assignee_email or "").strip().lower()
        if who == me or (not who and ticket_confidential.is_hr_for(db, user, t.company_id or "")):
            n += 1
    return n


def earlier_for_hr(db: Session, user: dict) -> list:
    """Earlier Requests for HR - the old rows of the people this caller is HR
    for, read-only (moved ones point at their ticket)."""
    R = models.HrSelfRequest
    comps = ticket_confidential.hr_companies(db, user)
    q = db.query(R)
    if comps is not None:
        if not comps:
            return []
        q = (q.join(models.NexusEmployee,
                    func.lower(models.NexusEmployee.work_email) == func.lower(R.employee_email))
              .filter(models.NexusEmployee.company.in_(sorted(comps))))
    return [ser_earlier(r) for r in q.order_by(R.created_at.desc()).limit(300).all()]


# ── The move: open hr_self_requests -> tickets (idempotent) ─────────────────

def _migrate_row(db: Session, r) -> str:
    """One open request -> one confidential HR ticket, quietly (no bells or
    emails for a request that was already waiting). Keeps the author, the
    original date, the message, the attachment and HR's answer if it had
    one. Returns the ticket id. Does not commit."""
    from routers import tickets as T
    from routers.task_util import gen_id, log_activity
    import ticket_sla
    me = (r.employee_email or "").strip().lower()
    kind = r.type if r.type in KINDS else "other"
    company = T.company_for(db, me)
    created = r.created_at or _now()
    t = models.TaskTicket(
        id=gen_id(), code=T._next_ticket_code(db), subject=_subject(kind, r.message or ""),
        description=_description(r.message or ""), type="other", status="open", priority="medium",
        requester_email=me, created_by_email=me, assignee_email="", company_id=company,
        hr_department_id="", department_id="", linked_task_id="", tags=[], images=[], watcher_emails=[],
        resolution="", custom_field_values={}, type_fields={KIND_KEY: kind}, links=[], task_ids=[],
        component="", csat_rating=0, csat_comment="", application=KIND_LABEL[kind],
        service_area=ticket_confidential.DESK_HR, approval_status="none", approver_email="",
        sla_due_on="", resolved_at="", created_at=created, modified_at=_now(), source="",
        confidential_desk=ticket_confidential.DESK_HR)
    # The SLA clock starts when it reaches the desk, not on the original date
    # (an old request is not born breached - nobody could have met it).
    t_created = t.created_at
    t.created_at = _now()
    ticket_sla.start(t, ticket_sla.targets(db, t.priority))
    t.created_at = t_created
    assignee = ticket_confidential.default_assignee(db, company, me)
    if assignee:
        t.assignee_email = assignee
        ticket_sla.set_status(t, "in_progress")
    db.add(t)
    log_activity(db, type="created", actor_email=me, entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject,
                 detail=json.dumps({**T._ticket_snapshot(t), "movedFromAskHr": r.id}))
    if r.attachment_path:
        url = copy_hr_doc_to_ticket(r.attachment_path, r.attachment_name)
        if url:
            _attach(db, t, me, r.attachment_name or "document", url)
        else:
            _note_missing_file(db, t, me, r.attachment_name, r.attachment_path)
    if (r.response or "").strip():
        db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email=(r.resolved_by or "").lower() or me,
                                  body=_description(r.response), internal=False,
                                  created_at=r.resolved_at or _now()))
        t.last_comment_at = r.resolved_at or _now()
    r.ticket_id = t.id
    return t.id


def migrate_open(db: Session) -> dict:
    """Move every open, not-yet-moved Ask HR request into a ticket. Safe to
    re-run: a row with a ticket_id is skipped, each row is re-read under a
    lock and committed on its own, and one failure leaves the rest moving."""
    R = models.HrSelfRequest
    ids = [i for (i,) in db.query(R.id).filter(R.status == "open", func.coalesce(R.ticket_id, "") == "").all()]
    moved, failed = 0, 0
    for rid in ids:
        try:
            r = db.query(R).filter(R.id == rid).with_for_update().first()
            if r is None or (r.ticket_id or "") or r.status != "open":
                db.rollback()
                continue
            _migrate_row(db, r)
            db.commit()
            moved += 1
        except Exception as e:   # noqa: BLE001 - one bad row must not stop the rest
            db.rollback()
            failed += 1
            print(f"[ask-hr] could not move request {rid}: {e}")
    return {"moved": moved, "failed": failed, "remaining": len(ids) - moved}
