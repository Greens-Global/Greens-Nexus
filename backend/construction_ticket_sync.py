"""Tickets <-> Jobs, two-way status (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2): Tickets ARE the
maintenance work orders; a ticket gets a Job ("Start Job") when it needs a
crew, materials or more than a day. The link is a ConstructionJobLink row
(kind 'ticket'). The ticket keeps its SLA, its queue and its needs-reply
flag.

ONE place, wired in database.py like feature_request_sync and cubby_tasks,
so EVERY path that moves either record syncs - never a per-route call:

  job -> complete       each linked ticket still open is Resolved AFTER the
                        job's commit, through the desk's own Mark Resolved
                        path (routers.tickets.update_ticket, as the person
                        who completed the job): the resolution note naming
                        the job, the history line, the requester's bell
                        "Your Ticket Was Resolved", the unread dot
                        (requester_update_at), the resolved email and Teams
                        message (notify_ticket_event, sent off the request).
                        Only tickets that person may act on (the desk's
                        own _may_patch_ticket / edit scope - a refusal leaves
                        the ticket as it was and is printed); never an Ask HR
                        ticket; a Resolved / Closed one is left alone.
  ticket reopened       a linked job that was Complete goes back to Active
  (Resolved / Closed    inside the same flush (the job is Construction's own
   -> anything open)    row; its activity line names the ticket by number,
                        never its subject). A job On Hold or Archived stays.

Nothing else moves: a resolved ticket does not complete its job (Neil /
coordinator, 11/03/2026), and a job put back to Active reopens nothing.

Why the resolve waits for the commit: inside a flush nothing may send mail
or open a second session, and the desk's path needs both. Because it runs
as an ordinary ticket save in its own session, every other hook - the
workflows observer, feature_request_sync, a maintenance PM sync - sees that
status change in that save's flush like any desk resolve, whatever order
the hooks are wired in.

Property tickets (property_links rule 5): resolving one makes it the
property's maintenance record, exactly like the desk's Mark Resolved; the
property link is never re-pointed and nothing is deleted. Errors are printed
and swallowed: a sync never fails the save that set it off.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone

from sqlalchemy import event, inspect

FROM_TICKET = "_nx_status_from_ticket"  # on a job this hook reopened
CLOSED = ("resolved", "closed")
_PENDING = "construction_ticket_sync_resolve"   # session.info: [(job id, job name, actor email)]
_MARKED = "construction_ticket_sync_marked"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _old(obj, attr: str):
    hist = getattr(inspect(obj).attrs, attr).history
    if not hist.has_changes():
        return None
    return hist.deleted[0] if hist.deleted else ""


def _links(session, models, *, project_id: str = "", ticket_id: str = ""):
    L = models.ConstructionJobLink
    q = session.query(L).filter(L.kind == "ticket", L.ended_at == "")
    q = q.filter(L.project_id == project_id) if project_id else q.filter(L.ref_id == ticket_id)
    return q.all()


def _mark(session, obj, flag: str) -> None:
    """Flag a row this hook wrote (so its own change is not echoed back);
    the flag is cleared after the flush either way."""
    setattr(obj, flag, True)
    session.info.setdefault(_MARKED, []).append((obj, flag))


# ── job complete -> its tickets resolved (after the commit) ─────────────────

def _in_thread(fn, *a, **kw) -> None:
    """Run the email / Teams sends off the request (BackgroundTasks' job, but
    there is no response to hang them on here). Tests swap SEND for inline."""
    threading.Thread(target=fn, args=a, kwargs=kw, daemon=True).start()


SEND = _in_thread


class _Later:
    """BackgroundTasks for update_ticket: queued sends go to SEND."""
    def add_task(self, fn, *a, **kw):
        SEND(fn, *a, **kw)


def resolve_tickets_for(job_id: str, job_name: str, actor_email: str) -> int:
    """Resolve the open tickets linked to a job that completed, each through
    the desk's update_ticket as `actor_email`, in a session of its own.
    Returns how many were resolved."""
    import models
    import task_automation
    from database import SessionLocal
    from fastapi import HTTPException
    from routers import tickets as tk
    db = SessionLocal()
    n = 0
    try:
        user = task_automation._person_user(db, actor_email) if actor_email else None
        if not user or user.get("external"):
            print(f"[construction-ticket-sync] job {job_id}: no person to resolve its tickets as ({actor_email!r})")
            return 0
        ids = [lk.ref_id for lk in _links(db, models, project_id=job_id)]
        for tid in ids:
            # No include_confidential: an Ask HR ticket is never in reach here.
            t = db.query(models.TaskTicket).filter(models.TaskTicket.id == tid).first()
            if t is None or (t.status or "") in CLOSED or (t.deleted_at or ""):
                continue
            try:
                tk.update_ticket(t.id, tk.TicketUpdate(
                    status="resolved", resolution="done",
                    resolution_note=f"The job {job_name} was completed in Construction."[:2000]),
                    _Later(), user=user, db=db)
                n += 1
            except HTTPException as e:   # not this person's to resolve, or the desk refuses it
                db.rollback()
                print(f"[construction-ticket-sync] ticket {tid} left open: {e.detail}")
            except Exception as e:   # noqa: BLE001 - one ticket never stops the rest
                db.rollback()
                print(f"[construction-ticket-sync] ticket {tid}: {e}")
    finally:
        db.close()
    return n


# ── ticket reopened -> its Complete job back to Active (inside the flush) ───

def reopen_jobs_for(session, ticket, actor_email: str = "") -> int:
    """Put a Complete job back to Active when its ticket is reopened."""
    import models
    import uuid
    if (getattr(ticket, "confidential_desk", "") or ""):
        return 0
    P = models.ConstructionProject
    n = 0
    ids = [lk.project_id for lk in _links(session, models, ticket_id=ticket.id)]
    for job in (session.query(P).filter(P.id.in_(ids), P.deleted_at == "").all() if ids else []):
        if (job.status or "active") != "complete":
            continue
        _mark(session, job, FROM_TICKET)
        job.status = "active"
        job.modified_at = _now()
        # The ticket by its number only - the job's readers may not see the ticket.
        session.add(models.ConstructionActivity(
            id=str(uuid.uuid4()), project_id=job.id, entity_kind="project", entity_id=job.id,
            type="reopened", actor_email=actor_email or "", at=_now(),
            detail=f"back to Active - its ticket {ticket.code or ''} was reopened".replace("  ", " ")))
        try:
            import workflows
            workflows.emit(session, "job.status_changed", subject=job, actor=actor_email or "",
                           changes={"status": ("complete", "active")}, extra={"reason": "ticket_reopened"})
        except Exception:   # noqa: BLE001 - emit never raises; belt and braces
            pass
        n += 1
    return n


def wire(session_factory) -> None:
    @event.listens_for(session_factory, "before_flush")
    def _job_ticket_status(session, _ctx, _instances):
        import models
        for obj in list(session.dirty):
            try:
                if isinstance(obj, models.ConstructionProject):
                    if getattr(obj, FROM_TICKET, False):
                        continue
                    old = _old(obj, "status")
                    if old is None or old == obj.status or (obj.status or "") != "complete":
                        continue
                    session.info.setdefault(_PENDING, []).append(
                        (obj.id, obj.name or "", getattr(obj, "_nx_actor", "") or ""))
                elif isinstance(obj, models.TaskTicket):
                    old = _old(obj, "status")
                    if old is None or old == obj.status:
                        continue
                    if (old or "") in CLOSED and (obj.status or "") not in CLOSED:
                        with session.no_autoflush:
                            reopen_jobs_for(session, obj, getattr(obj, "_nx_actor", "") or "")
            except Exception as e:   # noqa: BLE001 - a status sync must never fail the save
                print(f"[construction-ticket-sync] {type(obj).__name__} {getattr(obj, 'id', '')}: {e}")

    @event.listens_for(session_factory, "after_flush_postexec")
    def _clear_marks(session, _ctx):
        for obj, flag in session.info.pop(_MARKED, []):
            try:
                setattr(obj, flag, False)
            except Exception:   # noqa: BLE001
                pass

    @event.listens_for(session_factory, "after_commit")
    def _resolve_after_commit(session):
        pending = session.info.pop(_PENDING, [])
        seen = set()
        for job_id, name, actor in pending:
            if job_id in seen:
                continue
            seen.add(job_id)
            try:
                resolve_tickets_for(job_id, name, actor)
            except Exception as e:   # noqa: BLE001 - never fail the job's own save
                print(f"[construction-ticket-sync] job {job_id}: {e}")

    @event.listens_for(session_factory, "after_rollback")
    def _forget(session):
        session.info.pop(_PENDING, None)
