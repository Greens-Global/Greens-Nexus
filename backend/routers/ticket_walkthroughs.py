"""Property Walkthrough - a line-by-line batch ticket creator (Neil, 10/05/2026).

"We go to a property, we find 19 to 20 different issues... create those 20
issues line by line... select different options in the ticket that this is
HVAC, this is plumbing, this is tile... and then it all hits that property."

One submit = one property, one department, one requester; N lines, each its
own ticket with its own help topic, priority, location, details and photos.

  * All or nothing. Every line is validated before anything is written; one
    bad line is a 422 naming the line and NOTHING is filed. A half-filed
    walkthrough is worse than none: the walker resubmits and the half that
    landed is filed twice.
  * Idempotent, with a precondition. The form makes batch_id (a UUID) when
    the walkthrough opens and keeps it until a submit is confirmed. The same
    id with the same lines (lines_hash) returns the tickets already filed
    (200, replayed) - safe for the phone that lost signal after the server
    committed. The same id with DIFFERENT lines is a 409 batch_mismatch that
    lists what was filed; it never claims the new lines were filed.
  * The code lock is taken only after every line is validated and every
    lookup is done, so the company's other ticket creates wait for the
    inserts alone, and a refused (422) batch never takes it.
  * Same rules as one ticket (routers/tickets.py): requester checked against
    the People list, company and service area derived server-side, SLA from
    priority, the approval gate from the type's switch, codes from the same
    sequence under the same lock, building teams only (property_links).
  * One notification per person per walkthrough, never one per line
    (CLAUDE.md): one bell each to assignees, the asset manager, the requester
    and the desk - deduped across roles - and one email each
    (ticket_notify.notify_walkthrough).
"""
import hashlib
import html as html_lib
import json
import os
import re
from collections import defaultdict
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import property_links
import ticket_taxonomy
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.task_util import gen_id, log_activity, now_iso, task_notify
from ticket_code import TICKET_CODE_DIGITS, ticket_no
from ticket_notify import _name_of, notify_walkthrough

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user)])

MAX_LINES = 50
MAX_PHOTOS_PER_LINE = 6
PRIORITIES = ("urgent", "high", "medium", "low")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Photos are uploaded by the form to the PRIVATE ticket-evidence bucket first;
# only that bucket's canonical URLs are accepted (api.js turns viewer URLs back
# into canonical ones on every JSON request). No data: URLs - 20 lines of
# base64 is the request that times out on a phone.
_EVIDENCE_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/ticket-evidence/" if _SUPABASE_URL else ""


def _photo_ok(url: str) -> bool:
    if _EVIDENCE_PREFIX:
        return url.startswith(_EVIDENCE_PREFIX)
    return url.startswith(("http://", "https://"))   # no storage configured (local dev)


class WalkLine(BaseModel):
    subject: Optional[str] = ""
    application: Optional[str] = ""      # the help topic ("Plumbing or Water Leak") or an Other answer
    priority: Optional[str] = "medium"
    type: Optional[str] = "incident"
    location: Optional[str] = ""         # unit / area - stored as typeFields.svc_unit
    description: Optional[str] = ""      # plain text; escaped into paragraphs server-side
    assignee_email: Optional[str] = ""   # desk callers only
    images: Optional[List[str]] = None   # canonical ticket-evidence URLs


class WalkthroughBody(BaseModel):
    batch_id: str
    property_asset_id: str
    hr_department_id: str
    company_id: Optional[str] = ""
    requester_email: Optional[str] = ""
    watcher_emails: Optional[List[str]] = None
    note: Optional[str] = ""
    lines: List[WalkLine] = []


def _desc_html(text: str) -> str:
    return "".join(f"<p>{html_lib.escape(line.strip())}</p>"
                   for line in (text or "").splitlines() if line.strip())


def _active_person(db: Session, email: str) -> bool:
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    return (emp is not None and (emp.status or "") != "offboarded"
            and not (getattr(emp, "deleted_at", "") or ""))


def _validate_lines(db: Session, lines: list, desk: bool, gated: set) -> tuple:
    """Every problem on every line, at once - the form marks each card."""
    errors, clean = [], []

    def bad(i, field, msg):
        errors.append({"index": i, "field": field, "error": msg})

    for i, ln in enumerate(lines):
        before = len(errors)
        subject = " ".join((ln.subject or "").split())
        if not subject:
            bad(i, "subject", "Describe the issue.")
        elif len(subject) > 200:
            bad(i, "subject", "Keep the title under 200 characters.")
        application = " ".join((ln.application or "").split())
        if not application:
            bad(i, "application", "Pick what it is (HVAC, Plumbing...).")
        elif len(application) > 80:
            bad(i, "application", "Keep it under 80 characters.")
        priority = (ln.priority or "medium").strip().lower()
        if priority not in PRIORITIES:
            bad(i, "priority", "Unknown priority.")
        typ = (ln.type or "incident").strip()
        if typ not in ticket_taxonomy.TICKET_TYPES:
            bad(i, "type", "Unknown ticket type.")
        description = (ln.description or "").strip()
        if len(description) > 4000:
            bad(i, "description", "Keep the details under 4,000 characters.")
        location = " ".join((ln.location or "").split())[:120]
        images = [u.strip() for u in (ln.images or []) if isinstance(u, str) and u.strip()]
        if len(images) > MAX_PHOTOS_PER_LINE:
            bad(i, "images", f"Up to {MAX_PHOTOS_PER_LINE} photos a line.")
        elif any(not _photo_ok(u) for u in images):
            bad(i, "images", "A photo did not upload - remove it and add it again.")
        assignee = (ln.assignee_email or "").strip().lower()
        if assignee:
            if not desk:
                bad(i, "assignee_email", "Only the service desk can assign while filing.")
            elif not _active_person(db, assignee):
                bad(i, "assignee_email", "The assignee must be someone on the Nexus People list.")
            elif typ in gated:
                # create_ticket's 409, per line: a gated request cannot be born assigned.
                bad(i, "assignee_email", "This type needs approval first - leave it unassigned.")
        if len(errors) == before:
            clean.append({"subject": subject, "application": application, "priority": priority,
                          "type": typ, "description": _desc_html(description), "location": location,
                          "images": images, "assignee": assignee})
    return errors, clean


def _out(batch: models.TicketBatch, tickets: list, replayed: bool) -> dict:
    return {"batchId": batch.id,
            "property": {"id": batch.property_asset_id, "name": batch.property_name},
            "tickets": [T.ticket_to_dict(t) for t in tickets], "replayed": replayed}


def _fingerprint(body: WalkthroughBody, requester: str) -> str:
    """What makes two submits "the same walkthrough": property, team, requester
    and every line as the server will read it (whitespace-collapsed, so a
    resend of the same text always matches)."""
    def sq(v):
        return " ".join(str(v or "").split())
    doc = {"p": sq(body.property_asset_id), "d": sq(body.hr_department_id), "r": requester,
           "l": [[sq(ln.subject), sq(ln.application), sq(ln.priority).lower() or "medium",
                  sq(ln.type) or "incident", sq(ln.location), (ln.description or "").strip(),
                  sq(ln.assignee_email).lower(), [sq(u) for u in (ln.images or []) if sq(u)]]
                 for ln in (body.lines or [])]}
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode("utf-8")).hexdigest()


def _replay(db: Session, batch: models.TicketBatch, me: str, fp: str, response: Response) -> dict:
    """The same batch_id again. Replayed ONLY when it is the same person AND
    the same lines - a retry is safe only if it is the same request. A
    different body (another tab edited the draft, or lines were added after a
    lost response) is a 409 carrying what WAS filed, so the form can move the
    rest into a new walkthrough instead of reporting success and dropping
    them."""
    if (batch.created_by_email or "") != me:
        raise HTTPException(409, "This walkthrough was already submitted by someone else.")
    rows = (db.query(models.TaskTicket).filter(models.TaskTicket.batch_id == batch.id)
            .order_by(models.TaskTicket.code).all())
    if (batch.lines_hash or "") != fp:
        n = len(rows)
        raise HTTPException(409, {
            "code": "batch_mismatch",
            "message": f"This walkthrough was already filed with {n} line{'s' if n != 1 else ''}. "
                       "Lines added or changed after that were not filed - start a new walkthrough for them.",
            "property": {"id": batch.property_asset_id, "name": batch.property_name},
            "tickets": [T.ticket_to_dict(t) for t in rows]})
    response.status_code = 200
    return _out(batch, rows, replayed=True)


def _bells(db: Session, batch: models.TicketBatch, tickets: list, actor: str, desk: list) -> None:
    """One bell per person for the whole walkthrough. Someone in two roles
    hears once - assignee first (most actionable), then the asset manager,
    the requester, the desk. The walker hears nothing about their own act."""
    n = len(tickets)
    s = "s" if n > 1 else ""
    name = batch.property_name
    span = (ticket_no(tickets[0].code) if n == 1
            else f"{ticket_no(tickets[0].code)} to {ticket_no(tickets[-1].code)}")
    who = _name_of(db, actor) or actor
    told = {actor}

    by_assignee = defaultdict(list)
    for t in tickets:
        if t.assignee_email:
            by_assignee[t.assignee_email.lower()].append(t)
    for em, ts in by_assignee.items():
        if em in told:
            continue
        task_notify(db, kind="ticket_assigned", for_email=em,
                    title=f"You were assigned {len(ts)} ticket{'s' if len(ts) > 1 else ''} at {name}",
                    body="; ".join(f"{ticket_no(t.code)} {t.subject}" for t in ts)[:500],
                    ticket_id=ts[0].id if len(ts) == 1 else "",
                    nexus_action={"view": "tickets", "label": "View Ticket" if len(ts) == 1 else "View Tickets"})
        told.add(em)

    mgr = (batch.asset_manager_email or "").lower()
    if mgr and mgr not in told:
        task_notify(db, kind="ticket_property", for_email=mgr, title=f"{n} new ticket{s} at {name}",
                    body=f"Walkthrough by {who}: {span}"[:500],
                    nexus_action={"view": "property-asset", "sub": f"tickets:{batch.property_asset_id}",
                                  "label": "View Property"})
        told.add(mgr)

    req = (batch.requester_email or "").lower()
    if req and req not in told:
        task_notify(db, kind="ticket_received", for_email=req,
                    title=f"{n} ticket{s} raised for you at {name}", body=f"{span} - filed by {who}"[:500],
                    nexus_action={"view": "support", "label": "View Tickets"})
        told.add(req)

    to_assign = [t for t in tickets if not t.assignee_email and (t.approval_status or "none") != "pending"]
    to_route = [t for t in tickets if (t.approval_status or "none") == "pending"]
    if to_assign or to_route:
        parts = ([f"{len(to_assign)} to assign"] if to_assign else []) + \
                ([f"{len(to_route)} to route for approval"] if to_route else [])
        for em in dict.fromkeys(e.lower() for e in desk):
            if em in told:
                continue
            task_notify(db, kind="ticket_needs_assignment", for_email=em,
                        title=f"Walkthrough at {name}: {n} new ticket{s}",
                        body=f"{span} - {', '.join(parts)}. Filed by {who}."[:500],
                        nexus_action={"view": "tickets", "label": "View Tickets"})
            told.add(em)


@router.post("/ticket-walkthroughs", status_code=201)
def create_walkthrough(body: WalkthroughBody, background_tasks: BackgroundTasks, response: Response,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").strip().lower()
    if not property_links.may_walkthrough(db, user):
        raise HTTPException(403, "Property Walkthrough is for the service desk and the Asset Management team.")
    batch_id = (body.batch_id or "").strip().lower()
    if not _UUID.match(batch_id):
        raise HTTPException(422, {"message": "This form is out of date - reload the page and try again.", "lines": []})
    requester = T._valid_requester(db, user, body.requester_email)
    fp = _fingerprint(body, requester)

    # 1. The common retry: already filed -> replay (or 409 on different lines)
    #    without validating anything or taking any lock.
    existing = db.get(models.TicketBatch, batch_id)
    if existing is not None:
        return _replay(db, existing, me, fp, response)

    # 2. Validate everything and do every lookup with NO lock held.
    lines = body.lines or []
    if not lines:
        raise HTTPException(422, {"message": "Add at least one line.", "lines": []})
    if len(lines) > MAX_LINES:
        raise HTTPException(422, {"message": f"A walkthrough takes up to {MAX_LINES} lines - "
                                             "submit the rest as a second walkthrough.", "lines": []})
    prop = property_links.require_linkable(db, body.property_asset_id, user)
    dept_id = (body.hr_department_id or "").strip()
    if not dept_id or not T.dept_name(db, dept_id):
        raise HTTPException(422, {"message": "Pick the team that will handle these.", "lines": []})
    if not property_links.department_takes_property(db, dept_id):
        raise HTTPException(422, {"message": "Pick a building or site team - this team's tickets "
                                             "aren't linked to properties.", "lines": []})
    company_id = T._intake_company(db, user, body.company_id, requester)
    desk = T._has_desk_grant(user, db)
    gated = {k for k in ticket_taxonomy.TICKET_TYPES if ticket_taxonomy.requires_approval(db, k)}
    errors, clean = _validate_lines(db, lines, desk, gated)
    if errors:
        n_bad = len({e["index"] for e in errors})
        raise HTTPException(422, {"message": f"{n_bad} line{'s' if n_bad > 1 else ''} need attention - "
                                             "nothing was filed yet.", "lines": errors})
    now = now_iso()
    prop_name = property_links.display_name(prop)
    manager = property_links.manager_email(db, prop)      # loads every property + People: before the lock
    desk_list = list(T._it_admins(db, company_id))
    # The walker and requester watch (as on any ticket). The asset manager is
    # told once (_bells) and NOT made a watcher - property_links rule 6.
    watchers = T._with_creator(body.watcher_emails, requester, me)
    service_areas = {c["application"]: T.service_area_for(db, c["application"]) for c in clean}
    sla = {p: T._sla_due_from_priority(db, now, p) for p in {c["priority"] for c in clean}}

    # 3. Lock, re-check (a twin of this request may have committed while we
    #    validated - Postgres shows its row once the lock is granted), issue a
    #    contiguous range of codes, insert. Nothing slow happens from here on.
    T._lock_ticket_codes(db)
    existing = db.get(models.TicketBatch, batch_id)
    if existing is not None:
        return _replay(db, existing, me, fp, response)
    batch = models.TicketBatch(id=batch_id, lines_hash=fp, property_asset_id=prop.id, property_name=prop_name,
                               created_by_email=me, requester_email=requester, company_id=company_id,
                               hr_department_id=dept_id, asset_manager_email=manager,
                               note=" ".join((body.note or "").split())[:500], created_at=now)
    db.add(batch)
    first_no = T._highest_ticket_no(db) + 1
    tickets = []
    for n, c in enumerate(clean):
        t = models.TaskTicket(
            id=gen_id(), code=f"{first_no + n:0{TICKET_CODE_DIGITS}d}", subject=c["subject"],
            description=c["description"], type=c["type"], status="open", priority=c["priority"],
            requester_email=requester, created_by_email=me,
            assignee_email=c["assignee"], assigned_by_email=me if c["assignee"] else "",
            department_id="", company_id=company_id, hr_department_id=dept_id, linked_task_id="",
            tags=[], images=[], watcher_emails=list(watchers), resolution="", custom_field_values={},
            type_fields={"svc_unit": c["location"]} if c["location"] else {}, links=[], task_ids=[],
            component="", csat_rating=0, csat_comment="", application=c["application"],
            service_area=service_areas[c["application"]], sla_due_on=sla[c["priority"]], resolved_at="",
            created_at=now, modified_at=now, property_asset_id=prop.id, property_name=prop_name,
            batch_id=batch_id, approver_email="",
            approval_status="pending" if c["type"] in gated else "none")
        if t.assignee_email:
            t.status = "in_progress"   # born assigned = already being worked (create_ticket's rule)
        db.add(t)
        for k, url in enumerate(c["images"]):
            db.add(models.TaskAttachment(id=gen_id(), task_id=t.id, name=f"Photo {k + 1}", size="",
                                         kind="image", url=url, added_at=now, added_by=me))
        log_activity(db, type="created", actor_email=me, entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code, entity_title=t.subject,
                     detail=json.dumps({**T._ticket_snapshot(t), "walkthrough": batch_id,
                                        "property": prop_name}))
        tickets.append(t)
    batch.ticket_ids = [t.id for t in tickets]
    batch.ticket_count = len(tickets)
    _bells(db, batch, tickets, me, desk_list)
    try:
        db.commit()
    except IntegrityError:
        # Anything the lock did not foresee (e.g. a PK collision): replay.
        db.rollback()
        again = db.get(models.TicketBatch, batch_id)
        if again is None:
            raise
        return _replay(db, again, me, fp, response)
    background_tasks.add_task(notify_walkthrough, batch_id, me)
    return _out(batch, tickets, replayed=False)
