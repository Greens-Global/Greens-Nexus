"""Tickets <-> Jobs, two-way status (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2): Tickets ARE the
maintenance work orders; a ticket gets a Job ("Start Job") when it needs a
crew, materials or more than a day. The link is a ConstructionJobLink row
(kind 'ticket'). The ticket keeps its SLA, its queue and its needs-reply
flag - nothing here touches them beyond the one status write below.

ONE before_flush hook (wired in database.py, like feature_request_sync and
cubby_tasks), so EVERY path that moves either record syncs - never a
per-route call:

  job -> complete       each linked ticket that is still open is Resolved
                        (resolution "done", a note naming the job, a line in
                        the ticket's history). A ticket already Resolved or
                        Closed is left alone.
  ticket reopened       a linked job that was Complete goes back to Active
  (Resolved / Closed    (a line in the job's activity log). A job On Hold
   -> anything open)    or Archived is left alone.

Nothing else moves: a resolved ticket does not complete its job (a job may
carry more than one ticket, and a ticket resolved early is a desk call), and
a job put back to Active does not reopen its tickets.

Property tickets (property_links rule 5): resolving one makes it the
property's maintenance record, exactly like the desk's Mark Resolved; the
property link is never re-pointed and nothing is deleted. Each side carries
a transient flag while this hook writes it so the other half never echoes.
Errors are printed and swallowed: a sync never fails the save that set it off.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import event, inspect

FROM_JOB = "_nx_status_from_job"        # on a ticket this hook resolved
FROM_TICKET = "_nx_status_from_ticket"  # on a job this hook reopened
CLOSED = ("resolved", "closed")


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


_MARKED = "construction_ticket_sync_marked"


def _mark(session, obj, flag: str) -> None:
    """Flag a row this hook wrote (so its own change is not echoed back);
    the flag is cleared after the flush either way."""
    setattr(obj, flag, True)
    session.info.setdefault(_MARKED, []).append((obj, flag))


def resolve_tickets_for(session, job, actor_email: str = "") -> int:
    """Resolve the open tickets linked to a job that just completed."""
    import models
    import ticket_sla
    from routers.task_util import log_activity
    n = 0
    ids = [lk.ref_id for lk in _links(session, models, project_id=job.id)]
    if not ids:
        return 0
    T = models.TaskTicket
    rows = (session.query(T).filter(T.id.in_(ids))
            .execution_options(include_confidential=True).all())
    now = _now()
    for t in rows:
        if (t.status or "") in CLOSED or (t.deleted_at or ""):
            continue
        _mark(session, t, FROM_JOB)
        ticket_sla.set_status(t, "resolved")
        t.resolved_at = t.resolved_at or now
        t.resolution = t.resolution or "done"
        t.resolution_note = (f"The job {job.name} was completed in Construction."
                             + (f" {t.resolution_note}" if t.resolution_note else ""))[:2000]
        t.modified_at = now
        log_activity(session, type="status_changed", actor_email=actor_email or "",
                     entity_kind="ticket", entity_id=t.id, entity_code=t.code or "",
                     entity_title=t.subject or "",
                     detail=f"changed status to Resolved (the job {job.name} was completed)")
        n += 1
    return n


def reopen_jobs_for(session, ticket, actor_email: str = "") -> int:
    """Put a Complete job back to Active when its ticket is reopened."""
    import models
    import uuid
    P = models.ConstructionProject
    n = 0
    ids = [lk.project_id for lk in _links(session, models, ticket_id=ticket.id)]
    for job in (session.query(P).filter(P.id.in_(ids), P.deleted_at == "").all() if ids else []):
        if (job.status or "active") != "complete":
            continue
        _mark(session, job, FROM_TICKET)
        job.status = "active"
        job.modified_at = _now()
        session.add(models.ConstructionActivity(
            id=str(uuid.uuid4()), project_id=job.id, entity_kind="project", entity_id=job.id,
            type="reopened", actor_email=actor_email or "", at=_now(),
            detail=f"back to Active - the ticket {ticket.code or ticket.subject or ''} was reopened".strip()))
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
                        setattr(obj, FROM_TICKET, False)
                        continue
                    old = _old(obj, "status")
                    if old is None or old == obj.status or (obj.status or "") != "complete":
                        continue
                    with session.no_autoflush:
                        resolve_tickets_for(session, obj, getattr(obj, "_nx_actor", "") or "")
                elif isinstance(obj, models.TaskTicket):
                    if getattr(obj, FROM_JOB, False):
                        setattr(obj, FROM_JOB, False)
                        continue
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
