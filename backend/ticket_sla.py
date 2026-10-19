"""Honest SLA for tickets (Oct 2026).

A ticket's SLA used to be `sla_due_on`, a UTC DATE: a 24-hour urgent ticket
filed at 9 AM "breached" only the next calendar day, nothing measured the
first response, waiting on the requester burned the clock, and nobody was told
at the moment of breach. This module is the one place that rule lives now:

- Two deadlines, both ISO UTC datetimes on the ticket: `first_response_due_at`
  (the first reply the requester can see) and `sla_due_at` (resolution).
  Both are created_at + the priority's target hours (ticket_taxonomy:
  firstResponseHours / slaTargetHours) + every completed pause.
  `sla_due_on` is still written - the UTC date of sla_due_at - for anything
  old that reads it.
- The clock PAUSES while the ticket waits on the requester (Waiting for User,
  legacy "waiting"), while it awaits approval (nobody may work it yet), and
  while it is resolved or closed. Leaving a paused
  status adds the paused time to both deadlines (to the first-response one
  only while nobody has responded yet), so a reopened ticket continues with
  the time it had left. Every status write goes through `set_status`; an
  approval decision that starts or ends the wait calls `sync`.
- Breached = the clock is running AND now is past the deadline - to the
  minute, never to the day.
- The first response is the first comment the requester can see (not an
  internal note) written by a DESK agent other than the requester
  (`note_comment`) - a cc'd colleague or an @mentioned employee never counts,
  and an agent who logged a phone call for someone counts once they reply.
  A ticket the assignee filed for themselves has no first-response clock.
  Resolving without a reply leaves first_response_at empty: it was never
  responded to; the clock just stops. Deleting the reply that stamped it
  keeps the stamp - a response was given.
- Breach alerts (`scan_breaches`, inside ticket_notify's leader-gated loop,
  in its worker thread): one rollup bell per person per local day, updated
  in place as more of their tickets breach.
  A kind (first response / resolution) alerts only while its alerted mark
  (sla_fr_alerted_at / sla_res_alerted_at) is empty; the mark is cleared only
  when a pause or a priority change moves that deadline back into the
  FUTURE - so breached, paused and resumed still late is no second bell, and
  a deadline moved out and then passed again alerts once more. Sent to the
  assignee (unassigned or no longer sendable: the service desk the ticket is
  announced to) and the department lead. Bell only - no email. On unless
  enabledEvents.sla_breach is switched off in Manage > Email Notifications.

Every hour counts (24/7). `deadline()` is the only "hours -> deadline" math,
so a business-hours calendar later replaces that one function.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

import models

WAITING_STATUSES = ("waiting_user", "waiting")       # "waiting" = legacy waiting-for-user
DONE_STATUSES = ("resolved", "closed")
PAUSED_STATUSES = WAITING_STATUSES + DONE_STATUSES
ALERT_KINDS = ("first_response", "resolution")
KIND_LABEL = {"first_response": "Response Overdue", "resolution": "Resolution Overdue"}
_CHUNK = 500


# ── Time helpers ─────────────────────────────────────────────────────────────

def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse(value) -> datetime | None:
    """An aware UTC datetime from a stored ISO string (a bare date reads as
    its UTC midnight), else None."""
    if not value:
        return None
    raw = str(value).strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def iso(d: datetime) -> str:
    """The one stored shape: "2026-10-19T15:00:00+00:00" (UTC, whole seconds),
    so stored deadlines compare as strings in SQL as well as in Python."""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def deadline(start: datetime, hours: float) -> datetime:
    """`hours` of SLA time after `start`. Every hour counts today (24/7) -
    THE place a business-hours calendar plugs in later."""
    return start + timedelta(hours=float(hours))


def local_day(value, zone: str = "") -> str:
    """The YYYY-MM-DD a stored UTC timestamp falls on in `zone` ("" if it
    does not parse). A bare date is returned as it is."""
    from zoneinfo import ZoneInfo
    raw = str(value or "")
    if len(raw) == 10:
        return raw
    d = parse(raw)
    if d is None:
        return ""
    try:
        tz = ZoneInfo(zone) if zone else timezone.utc
    except Exception:
        tz = timezone.utc
    return d.astimezone(tz).date().isoformat()


# ── Targets and deadlines ────────────────────────────────────────────────────

def targets(db: Session, priority: str) -> tuple:
    """(resolution hours, first-response hours) for a priority - one config
    read. Callers creating many tickets read it once per priority."""
    import ticket_taxonomy
    return ticket_taxonomy.sla_targets(db, priority or "medium")


def is_paused_status(status: str) -> bool:
    return (status or "") in PAUSED_STATUSES


def held(t) -> bool:
    """Should the clock be stopped - waiting on the requester, resolved /
    closed, or awaiting approval?"""
    return is_paused_status(t.status) or (t.approval_status or "") == "pending"


def running(t) -> bool:
    """Is the ticket's SLA clock running right now?"""
    return not (t.sla_paused_at or "") and not held(t)


def first_response_applies(t) -> bool:
    """No first-response clock on a ticket its own assignee filed for
    themselves - there is nobody to respond to."""
    requester = (t.requester_email or "").strip().lower()
    return not requester or requester != (t.assignee_email or "").strip().lower()


def _set_due(t, due: datetime) -> None:
    t.sla_due_at = iso(due)
    t.sla_due_on = due.date().isoformat()


def _rearm(t, now: datetime) -> None:
    """A deadline moved back into the future may alert again once it passes;
    one still in the past keeps its mark (that breach was already told)."""
    due = parse(t.sla_due_at)
    if due is not None and due > now:
        t.sla_res_alerted_at = ""
    fr_due = parse(t.first_response_due_at)
    if fr_due is not None and fr_due > now:
        t.sla_fr_alerted_at = ""


def recompute(t, tgt: tuple, now: datetime | None = None) -> None:
    """Both deadlines from created_at + the targets + every completed pause.
    Called when a ticket is created and when its priority changes. A paused
    ticket stays paused (its current pause is added when it resumes)."""
    now = now or utcnow()
    created = parse(t.created_at) or now
    extra = timedelta(minutes=int(t.sla_paused_min or 0))
    _set_due(t, deadline(created, tgt[0]) + extra)
    if not (t.first_response_at or ""):
        t.first_response_due_at = iso(deadline(created, tgt[1]) + extra)
    elif not (t.first_response_due_at or ""):
        t.first_response_due_at = iso(deadline(created, tgt[1]))
    _rearm(t, now)
    _sync_pause(t, now)


def start(t, tgt: tuple, now: datetime | None = None) -> None:
    """A new ticket's SLA: deadlines from its created_at, nothing responded,
    no alerts, paused at once if it is born waiting / resolved / closed."""
    t.sla_paused_min = 0
    t.sla_paused_at = ""
    t.first_response_at = ""
    t.first_response_due_at = ""
    t.sla_fr_alerted_at = ""
    t.sla_res_alerted_at = ""
    recompute(t, tgt, now)


def _sync_pause(t, now: datetime | None = None) -> None:
    now = now or utcnow()
    paused = bool(t.sla_paused_at or "")
    if held(t):
        if not paused:
            t.sla_paused_at = iso(now)
        return
    if not paused:
        return
    since = parse(t.sla_paused_at)
    t.sla_paused_at = ""
    if since is None:
        return
    mins = max(0, int(round((now - since).total_seconds() / 60)))
    if not mins:
        return
    delta = timedelta(minutes=mins)
    due = parse(t.sla_due_at)
    if due is not None:
        _set_due(t, due + delta)
    fr_due = parse(t.first_response_due_at)
    if fr_due is not None and not (t.first_response_at or ""):
        t.first_response_due_at = iso(fr_due + delta)
    t.sla_paused_min = int(t.sla_paused_min or 0) + mins
    _rearm(t, now)


def sync(t, now: datetime | None = None) -> None:
    """Start or end a pause after something other than the status changed
    whether the clock should run - an approval request or decision."""
    _sync_pause(t, now)


def set_status(t, status: str, now: datetime | None = None) -> None:
    """THE way a ticket's status changes: the write plus the clock - entering
    a waiting / resolved / closed status pauses it, leaving one resumes it
    with the paused time added to the deadlines."""
    t.status = status
    _sync_pause(t, now)


# ── First response ───────────────────────────────────────────────────────────

def counts_as_response(t, author_email: str, internal: bool, desk: bool) -> bool:
    """A comment the requester can see, from a desk agent who is not the
    requester. The filer is not excluded: an agent who logged a call for
    someone and then replies has responded."""
    who = (author_email or "").strip().lower()
    if internal or not who or not desk:
        return False
    return who != (t.requester_email or "").strip().lower()


def _is_desk(db: Session, email: str) -> bool:
    """Is this address a desk agent (ticket_roles.can_work_queue), judged the
    way get_current_user builds a signed-in user."""
    import auth
    import ticket_roles
    email = (email or "").strip().lower()
    if not email:
        return False
    rec = auth._external_record(email) or {}
    who = {"email": email, "level": auth.level_for(email, db), "external": bool(rec.get("external"))}
    return ticket_roles.can_work_queue(who, db)


def note_comment(db: Session, t, user: dict, internal: bool, at: str) -> bool:
    """Stamp first_response_at on the first qualifying comment (`user` is
    the signed-in author). True when this comment was it. Deleting that
    comment later keeps the stamp - the response was given."""
    import ticket_roles
    if (t.first_response_at or "") or internal:
        return False
    if not counts_as_response(t, user.get("email"), internal, ticket_roles.can_work_queue(user, db)):
        return False
    t.first_response_at = iso(parse(at) or utcnow())
    return True


# ── Breach ───────────────────────────────────────────────────────────────────

def resolution_breached(t, now: datetime | None = None) -> bool:
    due = parse(t.sla_due_at)
    return bool(due is not None and running(t) and (now or utcnow()) > due)


def response_breached(t, now: datetime | None = None) -> bool:
    if (t.first_response_at or "") or not first_response_applies(t):
        return False
    due = parse(t.first_response_due_at)
    return bool(due is not None and running(t) and (now or utcnow()) > due)


def breached(t, now: datetime | None = None) -> bool:
    """THE "is this ticket's SLA breached" answer (routers/tickets.py
    _sla_breached, dashboards, My Team): resolution_breached, or - for a row
    with no datetime yet - the old due-date compare."""
    if t.sla_due_at or "":
        return resolution_breached(t, now)
    if not (t.sla_due_on or "") or (t.status or "") in DONE_STATUSES:
        return False
    return t.sla_due_on < iso(now or utcnow())[:10]


def breached_filter(now_s: str):
    """SQL for "the resolution SLA is breached" (resolution_breached), with
    the old date compare for a row that has no datetime yet."""
    T = models.TaskTicket
    today = now_s[:10]
    open_ = and_(T.status.notin_(PAUSED_STATUSES),
                 or_(T.approval_status.is_(None), T.approval_status != "pending"))
    not_paused = or_(T.sla_paused_at.is_(None), T.sla_paused_at == "")
    no_at = or_(T.sla_due_at.is_(None), T.sla_due_at == "")
    return and_(open_, or_(and_(T.sla_due_at != "", not_paused, T.sla_due_at < now_s),
                           and_(no_at, T.sla_due_on != "", T.sla_due_on < today)))


def _alerts_due(t, now: datetime) -> list:
    """The kinds breached now and not alerted yet (their mark is empty)."""
    out = []
    if response_breached(t, now) and not (t.sla_fr_alerted_at or ""):
        out.append("first_response")
    if resolution_breached(t, now) and not (t.sla_res_alerted_at or ""):
        out.append("resolution")
    return out


def _desk_for(db: Session, t, cfg: dict) -> list:
    """Who hears for an unassigned ticket: the service desk configured for
    its company (else the flat roster), then the Ticket Administrator, and
    only then every administrator (ticket_notify.ticket_agents' last
    fallback)."""
    import ticket_notify
    roster = list((cfg.get("agentEmailsByCompany") or {}).get(t.company_id or "") or []) if t.company_id else []
    roster = roster or list(cfg.get("agentEmails") or [])
    desk = [e for e in ticket_notify._dedupe(roster) if ticket_notify._is_sendable(db, e)]
    if not desk:
        admin = (cfg.get("ticketAdminEmail") or "").strip().lower()
        desk = [admin] if admin and ticket_notify._is_sendable(db, admin) else []
    if not desk:
        desk = [e for e in ticket_notify.ticket_agents(db, cfg, t.company_id) if ticket_notify._is_sendable(db, e)]
    return desk


BELL_TYPE = "task_ticket_sla_breach"


def _upsert_bell(db: Session, email: str, items: list, now: datetime) -> None:
    """ONE rollup bell per person per local day, updated in place (the
    shift_notify._upsert_bell pattern): newly breached tickets are added to
    the day's row, a ticket's two kinds share one line, and the row goes back
    to the top, unread. A row the person already actioned stays as history."""
    import json
    import ticket_notify
    from routers.task_util import gen_id
    from ticket_code import ticket_no
    day = local_day(iso(now), ticket_notify._zone_for(db, email))
    ref = f"ticket-sla-breach:{day}"
    N = models.NexusNotification
    row = (db.query(N).filter(N.recipient == email, N.ref_id == ref, N.type == BELL_TYPE,
                              N.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(N.created_at.desc()).first())
    listed: list = []
    if row is not None:
        try:
            listed = list((json.loads(row.action or "{}") or {}).get("slaBreaches") or [])
        except (TypeError, ValueError):
            listed = []
    listed = [e for e in listed if isinstance(e, dict)]
    by_id = {e.get("id"): e for e in listed}
    for t, kinds in items:
        e = by_id.get(t.id)
        if e is None:
            e = {"id": t.id, "code": t.code or "", "subject": t.subject or "", "kinds": []}
            by_id[t.id] = e
            listed.append(e)
        e["kinds"] = [k for k in ALERT_KINDS if k in set(e.get("kinds") or []) | set(kinds)]
    n = len(listed)
    title = "SLA Breached on 1 Ticket" if n == 1 else f"SLA Breached on {n} Tickets"
    body = ", ".join(f"{ticket_no(e['code'])} {e['subject']} ({' + '.join(KIND_LABEL[k] for k in e['kinds'])})"
                     for e in listed)[:300]
    action = {"view": "tickets", "label": "View Ticket" if n == 1 else "View Tickets", "slaBreaches": listed}
    if n == 1:
        action["ticketId"] = listed[0]["id"]
    stamp = now.isoformat()
    if row is not None:
        row.title, row.body, row.action, row.created_at, row.read_by = title, body, json.dumps(action), stamp, ""
        return
    db.add(N(id=gen_id(), type=BELL_TYPE, recipient=email, title=title, body=body, ref_id=ref,
             item_name="", requested_by="", action=json.dumps(action), actioned=False, read_by="",
             created_at=stamp))


def scan_breaches(db: Session, now: datetime | None = None) -> int:
    """One pass: alert every new breach. Returns how many people were told.
    Blocking DB work - only ever called from a worker thread."""
    import ticket_notify
    import ticket_overdue
    from routers.task_util import log_activity

    cfg = ticket_notify.get_settings(db)
    if not cfg["enabledEvents"].get("sla_breach", True):
        return 0
    now = now or utcnow()
    now_s = iso(now)
    T = models.TaskTicket
    def blank(col):
        return or_(col.is_(None), col == "")
    # Only the candidates - breached AND not alerted yet - are loaded and
    # locked; a ticket already told about its breach is not touched again.
    rows = (db.query(T)
            .filter(T.status.notin_(PAUSED_STATUSES), blank(T.sla_paused_at),
                    or_(T.approval_status.is_(None), T.approval_status != "pending"),
                    or_(and_(T.sla_due_at != "", T.sla_due_at < now_s, blank(T.sla_res_alerted_at)),
                        and_(blank(T.first_response_at), T.first_response_due_at != "",
                             T.first_response_due_at < now_s, blank(T.sla_fr_alerted_at),
                             or_(T.assignee_email.is_(None),
                                 func.lower(T.requester_email) != func.lower(T.assignee_email)))))
            .with_for_update().all())
    found = []
    for t in rows:
        kinds = _alerts_due(t, now)
        if not kinds:
            continue
        if "first_response" in kinds:
            t.sla_fr_alerted_at = t.first_response_due_at
        if "resolution" in kinds:
            t.sla_res_alerted_at = t.sla_due_at
        found.append((t, kinds))
    if not found:
        db.commit()
        return 0
    db.commit()   # marked before sending: at most once

    by_person: dict = {}   # email -> [(ticket, kinds)]
    for t, kinds in found:
        assignee = (t.assignee_email or "").strip().lower()
        told = []
        if assignee and ticket_notify._is_sendable(db, assignee):
            told.append((assignee, "assignee"))
        else:   # unassigned, or the assignee left: the desk hears instead
            told += [(e, "service desk") for e in _desk_for(db, t, cfg)]
        lead, _dept = ticket_overdue._lead_of(db, t)
        if not lead:
            log_activity(db, type="notify_gap", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail="SLA breached with no department lead set - the lead alert was not sent")
        elif ticket_notify._is_sendable(db, lead):
            told.append((lead, "department lead"))
        seen = set()
        names = []
        for email, role in told:
            if email in seen:
                continue
            seen.add(email)
            by_person.setdefault(email, []).append((t, kinds))
            names.append(f"{email} ({role})")
        what = " and ".join("first response target" if k == "first_response" else "resolution target"
                            for k in kinds)
        log_activity(db, type="sla_breach_alert", actor_email="system", entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"Missed the {what} - alerted {', '.join(names) if names else 'nobody'}")
    db.commit()

    for email, items in by_person.items():
        _upsert_bell(db, email, items, now)   # the main bell - it needs them
    db.commit()
    return len(by_person)


# ── Backfill ─────────────────────────────────────────────────────────────────

def backfill(db: Session, now: datetime | None = None) -> int:
    """Startup, idempotent: every ticket with no sla_due_at gets both
    deadlines from its created_at, its first response from the earliest
    qualifying comment, and a pause starting now if it is waiting / done
    (past pauses are not reconstructed). Every deadline ALREADY past is
    marked alerted, so a deploy never fires a flood of breach bells for old
    tickets. Chunked; one config read per priority."""
    now = now or utcnow()
    T, C = models.TaskTicket, models.TaskComment
    ids = [i for (i,) in db.query(T.id).execution_options(include_deleted=True)
           .filter(or_(T.sla_due_at.is_(None), T.sla_due_at == "")).all()]
    cache: dict = {}
    desk: dict = {}   # author -> is a desk agent (judged by their role today)
    done = 0
    for k in range(0, len(ids), _CHUNK):
        chunk = ids[k:k + _CHUNK]
        tickets = db.query(T).execution_options(include_deleted=True).filter(T.id.in_(chunk)).all()
        replies: dict = {}
        for tid, author, created in (db.query(C.task_id, C.author_email, C.created_at)
                                     .filter(C.task_id.in_(chunk),
                                             or_(C.internal.is_(False), C.internal.is_(None)))
                                     .order_by(C.created_at).all()):
            replies.setdefault(tid, []).append((author or "", created or ""))
        for t in tickets:
            p = t.priority or "medium"
            if p not in cache:
                cache[p] = targets(db, p)
            t.sla_paused_min = int(t.sla_paused_min or 0)
            t.sla_paused_at = ""
            first = ""
            for author, at in replies.get(t.id, []):
                a = (author or "").strip().lower()
                if a and a not in desk:
                    desk[a] = _is_desk(db, a)
                if at and counts_as_response(t, a, False, desk.get(a, False)):
                    first = iso(parse(at) or now)
                    break
            t.first_response_at = first
            t.first_response_due_at = ""
            recompute(t, cache[p], now)   # also starts the pause for a waiting / done ticket
            t.sla_fr_alerted_at = (t.first_response_due_at
                                   if not first and first_response_applies(t)
                                   and (parse(t.first_response_due_at) or now) < now else "")
            t.sla_res_alerted_at = t.sla_due_at if (parse(t.sla_due_at) or now) < now else ""
            done += 1
        db.commit()
    return done
