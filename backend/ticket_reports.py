"""Ticket Reports (Oct 2026) - Tickets > Reports, its CSV, and the Monday
Weekly Ticket Report email to desk supervisors.

ONE builder (`build_report`) serves the screen, the CSV and the email, the
same way workforce_scorecard.build_report does - never add a second
calculation path.

What it reads:
- Visibility is exactly the ticket list's (routers/tickets.ListScope - the
  company wall, and off the desk only the tickets the caller may open). A
  report can never show a ticket the list hides.
- SLA facts come from the Honest SLA columns (ticket_sla.py): sla_due_at,
  first_response_due_at, first_response_at, sla_paused_at, sla_paused_min,
  and ticket_sla.breached for "breached now". Deadlines are never
  re-derived here.
- One column-only query over task_tickets, bounded to the tickets that can
  matter for the range (open now, or created / resolved / due since the
  range began), plus one query over the activity trail for reopens. No ORM
  rows, no relationships, no per-ticket queries.

The numbers:
- Created / resolved: created_at / resolved_at inside the range (the
  viewer's local days). Backlog change = created - resolved (net flow).
- First response time: first_response_at - created_at, wall clock, for
  tickets created in the range that got one.
- Resolution time: resolved_at - created_at MINUS sla_paused_min (the time
  the ticket sat waiting on the requester or on approval, and any earlier
  resolved spell) - the time the SLA clock actually ran.
- SLA met % (resolution): tickets resolved in the range that carry a
  deadline; met = resolved_at <= sla_due_at (a row with only the old date:
  its UTC resolve date <= sla_due_on - ticketMeta.js slaMet).
- First response met %: tickets created in the range with a first-response
  clock (not one its assignee filed for themselves); a reply by the
  deadline is met, no reply with the deadline passed (before any current
  pause) is missed; resolved without a reply, or not due yet, is left out -
  the same "none" ticketMeta.js firstResponseState gives them.
- Reopened: tickets whose status was changed to Reopened inside the range
  (the "status_changed" activity line), counted once each.
- Aging: open tickets whose clock is running, by SLA clock age (created to
  now, minus completed pauses). A ticket waiting on the requester or
  pending approval is not aging - it is counted under Paused.
- Per agent: the assignee, when they are an active desk agent of a company
  their tickets belong to (ticket_auto_assign.desk_agent_for - the
  /task-tickets/desk-agents definition). Unassigned is its own row; an
  assignee who is not on the desk is grouped under "Not on the Desk".

Weekly email (`weekly_loop`, started in main.py's lifespan, every scan in a
worker thread): Monday from 7:00 AM in each recipient's own zone
(ticket_notify._zone_for), for the previous Monday-Sunday, built by
build_report scoped to that person. Recipients: ticket supervisors
(ticket_roles.can_manage_desk) who are active internal staff, have not
opted out (NexusPersonPref.ticket_weekly_report) and have tickets in scope.
The desk-wide switch is enabledEvents.weekly_report in the ticket
notification settings (on by default). TicketReportEmailLog, unique on
(recipient, week_start), is claimed BEFORE the send - a restart or a second
worker never sends the same week twice.
"""
import asyncio
import csv
import io
import re
import statistics
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import ticket_sla

PRIORITIES = ("urgent", "high", "medium", "low")
PRIORITY_LABEL = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}
# Mirrors TICKET_TYPE_META in frontend/src/tickets/ticketMeta.js.
TYPE_LABEL = {
    "bug": "Bug Report", "incident": "Incident", "service_request": "Service Request",
    "feature_request": "Feature Request", "task": "Task", "question": "Question",
    "change_request": "Change / Enhancement", "access_request": "Access Request",
    "request": "Request", "other": "Other",
}
# Mirrors SERVICE_AREAS in frontend/src/tickets/ticketMeta.js.
SERVICE_AREA_LABEL = {
    "email": "Email & Microsoft 365", "collab": "Teams & Phone", "tasks": "Tasks & Dashboard",
    "files": "Files & Storage", "knowledge": "Knowledge & SOPs", "storageops": "Storage Operations",
    "finance": "Finance Apps", "hr": "HR & Payroll", "assets": "Assets & Inventory",
    "network": "Network & Internet", "security": "Security & Cameras", "web": "Website & Marketing",
    "hardware": "Hardware & Remote Help", "facilities": "Buildings & Maintenance", "general": "General",
}
SOURCE_LABEL = {"email": "Email", "in_app": "In-App"}
AGE_BUCKETS = (("0-1", "0-1 Days", 1), ("1-3", "1-3 Days", 3), ("3-7", "3-7 Days", 7),
               ("7-14", "7-14 Days", 14), ("14-30", "14-30 Days", 30), ("30+", "30+ Days", None))
FILTER_KEYS = ("company", "department", "type", "priority", "assignee", "service_area")
MAX_RANGE_DAYS = 366
DAILY_UP_TO_DAYS = 31
UNASSIGNED, OTHER = "", "__other__"
SEND_HOUR = 7                  # Monday 7:00 AM in the recipient's own zone
SCAN_EVERY_SEC = 10 * 60
_FALLBACK_ZONE = "America/Los_Angeles"


class RangeError(ValueError):
    """A start / end the report cannot use - the endpoint answers 422."""


# ── Small helpers ────────────────────────────────────────────────────────────

def _zone(name: str):
    try:
        return ZoneInfo(name or _FALLBACK_ZONE)
    except Exception:
        return ZoneInfo(_FALLBACK_ZONE)


def us_day(d: date) -> str:
    return d.strftime("%m/%d/%Y")


def _hours(minutes) -> float | None:
    return None if minutes is None else round(minutes / 60.0, 1)


def _median(values: list):
    return statistics.median(values) if values else None


def _mean(values: list):
    return sum(values) / len(values) if values else None


def _pct(num: int, den: int):
    return round(100.0 * num / den) if den else None


def _minutes(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 60.0


def normalize_subject(s: str) -> str:
    """The recurring-subject key (the old Reports tab's idea): lower case,
    digits dropped, anything not a letter is a space, spaces collapsed."""
    s = re.sub(r"[0-9]+", "", (s or "").lower())
    s = re.sub(r"[^a-z ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def viewer_for(db: Session, email: str) -> dict:
    """A signed-in user dict for `email`, judged the way get_current_user
    builds one (ticket_sla._is_desk does the same) - for the weekly email,
    which has no request."""
    import auth
    email = (email or "").strip().lower()
    rec = auth._external_record(email) or {}
    return {"email": email, "level": auth.level_for(email, db), "external": bool(rec.get("external"))}


def resolve_range(start: str, end: str, zone: str, now: datetime | None = None) -> tuple:
    """(start_date, end_date), inclusive local days. Blank = the last 30
    days ending today in the viewer's zone."""
    today = (now or ticket_sla.utcnow()).astimezone(_zone(zone)).date()
    try:
        e = date.fromisoformat(end) if end else today
        s = date.fromisoformat(start) if start else e - timedelta(days=29)
    except ValueError:
        raise RangeError("Dates must look like 2026-10-19.")
    if e < s:
        raise RangeError("The end date is before the start date.")
    if (e - s).days + 1 > MAX_RANGE_DAYS:
        raise RangeError(f"A report covers at most {MAX_RANGE_DAYS} days.")
    return s, e


def clean_filters(raw: dict | None) -> dict:
    out = {}
    for k in FILTER_KEYS:
        v = str((raw or {}).get(k) or "").strip()
        if v and v != "all":
            out[k] = v.lower() if k in ("assignee", "priority", "type") else v
    return out


# ── The query ────────────────────────────────────────────────────────────────

def _columns():
    T = models.TaskTicket
    cols = [T.id, T.code, T.subject, T.type, T.status, T.priority, T.requester_email,
            T.assignee_email, T.created_by_email, T.approver_email, T.approval_status,
            T.watcher_emails, T.company_id, T.hr_department_id, T.application, T.service_area,
            T.csat_rating, T.created_at, T.resolved_at, T.sla_due_at, T.sla_due_on,
            T.first_response_due_at, T.first_response_at, T.sla_paused_at, T.sla_paused_min]
    # Email-to-ticket adds task_tickets.source; until it lands every ticket
    # is an in-app one.
    src = getattr(T, "source", None)
    if src is not None:
        cols.append(src.label("source"))
    return cols


def _load(db: Session, user: dict, lo: datetime, filters: dict) -> list:
    from routers.tickets import ListScope
    T = models.TaskTicket
    scope = ListScope(db, user)
    # A day of margin on the string compare: stored timestamps are ISO UTC,
    # and the exact range test is done in Python on parsed values below.
    since = (lo - timedelta(days=1)).date().isoformat()
    q = scope.apply(db.query(*_columns()))
    q = q.filter(or_(T.deleted_at.is_(None), T.deleted_at == ""))
    q = q.filter(or_(T.status.notin_(ticket_sla.DONE_STATUSES), T.created_at >= since,
                     T.resolved_at >= since, T.sla_due_at >= since))
    if filters.get("company"):
        q = q.filter(T.company_id == filters["company"])
    if filters.get("department"):
        q = q.filter(T.hr_department_id == filters["department"])
    if filters.get("type"):
        q = q.filter(T.type == filters["type"])
    if filters.get("priority"):
        q = q.filter(T.priority == filters["priority"])
    if filters.get("service_area"):
        q = q.filter(T.service_area == filters["service_area"])
    rows = [r for r in q.all() if scope.admits(r)]
    who = filters.get("assignee")
    if who == "unassigned":
        rows = [r for r in rows if not (r.assignee_email or "").strip()]
    elif who:
        rows = [r for r in rows if (r.assignee_email or "").strip().lower() == who]
    return rows


def _reopened_ids(db: Session, lo: datetime, hi: datetime, ids: set) -> set:
    A = models.TaskActivity
    since = (lo - timedelta(days=1)).date().isoformat()
    out = set()
    for tid, at in (db.query(A.entity_id, A.at)
                    .filter(A.entity_kind == "ticket", A.type == "status_changed",
                            A.detail.like("%Reopened%"), A.at >= since).all()):
        when = ticket_sla.parse(at)
        if tid in ids and when is not None and lo <= when < hi:
            out.add(tid)
    return out


# ── Per-ticket facts ─────────────────────────────────────────────────────────

class _Fact:
    """The parsed facts of one row, computed once."""
    __slots__ = ("r", "created", "resolved", "done", "due", "fr_at", "fr_due", "running",
                 "paused_min", "assignee")

    def __init__(self, r, now: datetime):
        self.r = r
        self.created = ticket_sla.parse(r.created_at)
        self.done = (r.status or "") in ticket_sla.DONE_STATUSES
        self.resolved = ticket_sla.parse(r.resolved_at) if self.done else None
        self.due = ticket_sla.parse(r.sla_due_at)
        self.fr_at = ticket_sla.parse(r.first_response_at)
        self.fr_due = ticket_sla.parse(r.first_response_due_at)
        self.running = ticket_sla.running(r)
        self.paused_min = int(r.sla_paused_min or 0)
        self.assignee = (r.assignee_email or "").strip().lower()

    def first_response_min(self):
        if self.created is None or self.fr_at is None:
            return None
        return max(0.0, _minutes(self.created, self.fr_at))

    def resolution_min(self):
        """Created to resolved, minus the time the clock was paused."""
        if self.created is None or self.resolved is None:
            return None
        return max(0.0, _minutes(self.created, self.resolved) - self.paused_min)

    def clock_age_min(self, now: datetime):
        """How long the SLA clock has run on an open ticket: created to now
        (to the start of the current pause, when paused), minus every
        completed pause."""
        if self.created is None:
            return None
        end = ticket_sla.parse(self.r.sla_paused_at) if self.r.sla_paused_at else None
        return max(0.0, _minutes(self.created, end or now) - self.paused_min)

    def sla_met(self):
        """True / False for a resolved ticket that carries a deadline, else
        None (not measured)."""
        if self.resolved is None:
            return None
        if self.due is not None:
            return self.resolved <= self.due
        if self.r.sla_due_on:
            return (self.r.resolved_at or "")[:10] <= self.r.sla_due_on
        return None

    def fr_met(self, now: datetime):
        """True / False when the first-response target can be judged, else
        None: no clock (filed by its own assignee), resolved without a
        reply, or not due yet."""
        if self.fr_due is None or not ticket_sla.first_response_applies(self.r):
            return None
        if self.fr_at is not None:
            return self.fr_at <= self.fr_due
        if self.done:
            return None
        ref = ticket_sla.parse(self.r.sla_paused_at) if self.r.sla_paused_at else now
        return False if self.fr_due < (ref or now) else None

    def breached_now(self, now: datetime) -> bool:
        return not self.done and ticket_sla.breached(self.r, now)


def _in(d: datetime | None, lo: datetime, hi: datetime) -> bool:
    return d is not None and lo <= d < hi


def _age_bucket(minutes: float) -> str:
    days = minutes / 1440.0
    for key, _label, upper in AGE_BUCKETS:
        if upper is None or days < upper:
            return key
    return AGE_BUCKETS[-1][0]


def _source_of(r) -> str:
    return "email" if (getattr(r, "source", "") or "").strip().lower() == "email" else "in_app"


# ── The builder ──────────────────────────────────────────────────────────────

def build_report(db: Session, viewer_email: str, *, start: str = "", end: str = "",
                 filters: dict | None = None, user: dict | None = None,
                 now: datetime | None = None, include_tickets: bool = False) -> dict:
    """THE Ticket Report for `viewer_email`, over the local days start..end
    (inclusive, YYYY-MM-DD; blank = the last 30 days) in their zone. `user`
    is the signed-in user dict when there is one (the endpoint); the weekly
    email builds it from the address. `include_tickets` adds the per-ticket
    rows the CSV prints."""
    import ticket_notify
    from ticket_auto_assign import desk_agent_for
    from ticket_code import ticket_no

    now = now or ticket_sla.utcnow()
    user = user or viewer_for(db, viewer_email)
    zone = ticket_notify._zone_for(db, user["email"])
    tz = _zone(zone)
    s_day, e_day = resolve_range(start, end, zone, now)
    lo = datetime.combine(s_day, dtime.min, tz).astimezone(timezone.utc)
    hi = datetime.combine(e_day + timedelta(days=1), dtime.min, tz).astimezone(timezone.utc)
    filters = clean_filters(filters)

    rows = _load(db, user, lo, filters)
    facts = [_Fact(r, now) for r in rows]
    reopened = _reopened_ids(db, lo, hi, {f.r.id for f in facts})

    created_f = [f for f in facts if _in(f.created, lo, hi)]
    resolved_f = [f for f in facts if _in(f.resolved, lo, hi)]
    open_f = [f for f in facts if not f.done]

    fr_mins = [m for m in (f.first_response_min() for f in created_f) if m is not None]
    res_mins = [m for m in (f.resolution_min() for f in resolved_f) if m is not None]
    sla = [m for m in (f.sla_met() for f in resolved_f) if m is not None]
    frm = [m for m in (f.fr_met(now) for f in created_f) if m is not None]
    csat = [int(f.r.csat_rating) for f in resolved_f if int(f.r.csat_rating or 0) > 0]

    kpis = {
        "created": len(created_f),
        "resolved": len(resolved_f),
        "openNow": len(open_f),
        "backlogChange": len(created_f) - len(resolved_f),
        "firstResponseMedianHours": _hours(_median(fr_mins)),
        "firstResponseAvgHours": _hours(_mean(fr_mins)),
        "firstResponseCount": len(fr_mins),
        "resolutionMedianHours": _hours(_median(res_mins)),
        "slaMetPct": _pct(sum(sla), len(sla)),
        "slaMeasured": len(sla),
        "firstResponseMetPct": _pct(sum(frm), len(frm)),
        "firstResponseMeasured": len(frm),
        "breachedNow": sum(1 for f in open_f if f.breached_now(now)),
        "reopened": len(reopened),
        "csatAvg": round(_mean(csat), 2) if csat else None,
        "csatCount": len(csat),
    }

    # Aging - running clocks only; paused tickets are their own line.
    aging = {k: {"key": k, "label": lab, "total": 0, "byPriority": {p: 0 for p in PRIORITIES}}
             for k, lab, _u in AGE_BUCKETS}
    paused = {"total": 0, "byPriority": {p: 0 for p in PRIORITIES}, "waitingOnRequester": 0,
              "pendingApproval": 0}
    for f in open_f:
        p = f.r.priority if f.r.priority in PRIORITIES else "medium"
        if not f.running:
            paused["total"] += 1
            paused["byPriority"][p] += 1
            if (f.r.approval_status or "") == "pending":
                paused["pendingApproval"] += 1
            else:
                paused["waitingOnRequester"] += 1
            continue
        age = f.clock_age_min(now)
        if age is None:
            continue
        b = aging[_age_bucket(age)]
        b["total"] += 1
        b["byPriority"][p] += 1

    # Trend - per local day up to 31 days, else per week (Monday).
    daily = (e_day - s_day).days + 1 <= DAILY_UP_TO_DAYS

    def bucket_of(d: date) -> date:
        return d if daily else d - timedelta(days=d.weekday())

    trend = {}
    cur = bucket_of(s_day)
    while cur <= e_day:
        trend[cur] = {"key": cur.isoformat(), "label": us_day(cur), "created": 0, "resolved": 0, "breached": 0}
        cur += timedelta(days=1 if daily else 7)

    def bump(when: datetime, field: str) -> None:
        b = trend.get(bucket_of(when.astimezone(tz).date()))
        if b is not None:
            b[field] += 1

    for f in created_f:
        bump(f.created, "created")
    for f in resolved_f:
        bump(f.resolved, "resolved")
    for f in facts:
        if not _in(f.due, lo, hi):
            continue
        missed = (f.resolved > f.due) if f.resolved is not None else (not f.done and f.breached_now(now))
        if missed:
            bump(f.due, "breached")

    # Per agent.
    # Names in one query (two with the role fallback), not one per person -
    # the CSV names every requester in the range.
    wanted = {f.assignee for f in facts if f.assignee}
    if include_tickets:
        wanted |= {(f.r.requester_email or "").strip().lower() for f in facts if f.r.requester_email}
    names = _names(db, wanted)

    def name_of(email: str) -> str:
        return names.get(email) or email

    agent_cache: dict = {}

    def is_agent(email: str, company: str) -> bool:
        key = (email, company or "")
        if key not in agent_cache:
            agent_cache[key] = desk_agent_for(db, email, company or "")
        return agent_cache[key]

    companies_of: dict = {}
    for f in facts:
        if f.assignee:
            companies_of.setdefault(f.assignee, set()).add(f.r.company_id or "")
    agent_ok = {e: any(is_agent(e, c) for c in sorted(cs)) for e, cs in companies_of.items()}

    def agent_key(f) -> str:
        if not f.assignee:
            return UNASSIGNED
        return f.assignee if agent_ok.get(f.assignee) else OTHER

    groups: dict = {}

    def group(key: str) -> dict:
        if key not in groups:
            groups[key] = {"open": 0, "resolved": 0, "fr": [], "res": [], "sla": [], "csat": [], "oldest": None}
        return groups[key]

    for f in open_f:
        g = group(agent_key(f))
        g["open"] += 1
        age = f.clock_age_min(now)
        if age is not None and (g["oldest"] is None or age > g["oldest"]):
            g["oldest"] = age
    for f in resolved_f:
        g = group(agent_key(f))
        g["resolved"] += 1
        m = f.resolution_min()
        if m is not None:
            g["res"].append(m)
        met = f.sla_met()
        if met is not None:
            g["sla"].append(met)
        if int(f.r.csat_rating or 0) > 0:
            g["csat"].append(int(f.r.csat_rating))
    for f in created_f:
        m = f.first_response_min()
        if m is not None:
            group(agent_key(f))["fr"].append(m)

    agents = []
    for key, g in groups.items():
        kind = "unassigned" if key == UNASSIGNED else "other" if key == OTHER else "agent"
        label = "Unassigned" if key == UNASSIGNED else "Not on the Desk" if key == OTHER else name_of(key)
        agents.append({
            "email": key if kind == "agent" else "", "name": label, "kind": kind,
            "open": g["open"], "resolved": g["resolved"],
            "firstResponseMedianHours": _hours(_median(g["fr"])),
            "resolutionMedianHours": _hours(_median(g["res"])),
            "slaMetPct": _pct(sum(g["sla"]), len(g["sla"])),
            "csatAvg": round(_mean(g["csat"]), 2) if g["csat"] else None,
            "oldestOpenDays": round(g["oldest"] / 1440.0, 1) if g["oldest"] is not None else None,
        })
    agents.sort(key=lambda a: ({"agent": 0, "other": 1, "unassigned": 2}[a["kind"]],
                               -(a["open"] + a["resolved"]), a["name"].lower()))

    # Breakdowns - created / resolved in the range, open now.
    dept_names = {d.id: d.name or "" for d in db.query(models.HrDepartment.id, models.HrDepartment.name).all()}
    company_names = {c.id: c.name or "" for c in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    dims = {
        "type": (lambda r: r.type or "request", lambda k: TYPE_LABEL.get(k) or k.replace("_", " ").title()),
        "priority": (lambda r: r.priority or "medium", lambda k: PRIORITY_LABEL.get(k) or k.title()),
        "department": (lambda r: r.hr_department_id or "", lambda k: dept_names.get(k) or ("No Department" if not k else "Unknown Department")),
        "helpTopic": (lambda r: r.application or "", lambda k: k or "Not Set"),
        "serviceArea": (lambda r: r.service_area or "", lambda k: SERVICE_AREA_LABEL.get(k) or ("Not Set" if not k else k)),
        "company": (lambda r: r.company_id or "", lambda k: company_names.get(k) or ("No Company" if not k else "Unknown Company")),
        "source": (_source_of, lambda k: SOURCE_LABEL.get(k, k)),
    }
    breakdowns = {}
    for dim, (key_of, label_of) in dims.items():
        acc: dict = {}

        def row(k: str) -> dict:
            if k not in acc:
                acc[k] = {"key": k, "label": label_of(k), "created": 0, "resolved": 0, "open": 0}
            return acc[k]
        for f in created_f:
            row(key_of(f.r))["created"] += 1
        for f in resolved_f:
            row(key_of(f.r))["resolved"] += 1
        for f in open_f:
            row(key_of(f.r))["open"] += 1
        order = list(PRIORITIES) if dim == "priority" else None
        out = list(acc.values())
        if order:
            out.sort(key=lambda x: order.index(x["key"]) if x["key"] in order else len(order))
        else:
            out.sort(key=lambda x: (-(x["created"] + x["open"]), x["label"].lower()))
        breakdowns[dim] = out

    # Top recurring subjects among the tickets created in the range.
    rec: dict = {}
    for f in sorted(created_f, key=lambda f: f.created, reverse=True):
        k = normalize_subject(f.r.subject)
        if not k:
            continue
        e = rec.setdefault(k, {"label": f.r.subject or k, "count": 0})
        e["count"] += 1
    recurring = sorted((e for e in rec.values() if e["count"] >= 2), key=lambda e: (-e["count"], e["label"].lower()))[:8]

    report = {
        "range": {"start": s_day.isoformat(), "end": e_day.isoformat(),
                  "label": f"{us_day(s_day)} - {us_day(e_day)}", "zone": zone,
                  "granularity": "day" if daily else "week", "generatedAt": ticket_sla.iso(now)},
        "filters": filters,
        "kpis": kpis,
        "aging": {"buckets": list(aging.values()), "paused": paused, "priorities": list(PRIORITIES)},
        "trend": list(trend.values()),
        "agents": agents,
        "breakdowns": breakdowns,
        "recurring": recurring,
        "hasTickets": bool(created_f or resolved_f or open_f),
    }
    if include_tickets:
        keep = {id(f) for f in created_f + resolved_f + open_f}
        shown = [f for f in facts if id(f) in keep]
        shown.sort(key=lambda f: f.created or now, reverse=True)
        report["tickets"] = [{
            "ticket": ticket_no(f.r.code) or f.r.id, "subject": f.r.subject or "",
            "company": company_names.get(f.r.company_id or "", ""),
            "department": dept_names.get(f.r.hr_department_id or "", ""),
            "type": TYPE_LABEL.get(f.r.type or "request", f.r.type or ""),
            "priority": PRIORITY_LABEL.get(f.r.priority or "", f.r.priority or ""),
            "status": _status_label(f.r.status),
            "assignee": name_of(f.assignee) if f.assignee else "Unassigned",
            "requester": name_of((f.r.requester_email or "").lower()) if f.r.requester_email else "",
            "helpTopic": f.r.application or "",
            "serviceArea": SERVICE_AREA_LABEL.get(f.r.service_area or "", ""),
            "source": SOURCE_LABEL[_source_of(f.r)],
            "created": ticket_notify._fmt(f.r.created_at, zone),
            "firstResponse": ticket_notify._fmt(f.r.first_response_at, zone),
            "resolved": ticket_notify._fmt(f.r.resolved_at, zone) if f.done else "",
            "slaDue": ticket_notify._fmt(f.r.sla_due_at or f.r.sla_due_on, zone),
            "firstResponseHours": _hours(f.first_response_min()),
            "resolutionHours": _hours(f.resolution_min()) if f.done else None,
            "resolutionSla": _sla_word(f, now),
            "firstResponseSla": {True: "Met", False: "Missed", None: ""}[f.fr_met(now)],
            "csat": int(f.r.csat_rating or 0) or "",
        } for f in shown]
    return report


def _names(db: Session, emails: set) -> dict:
    """{email: display name} the way ticket_notify._name_of words them (the
    People record, else the role's display name, else the address's local
    part), batched."""
    from sqlalchemy import func
    emails = {e for e in emails if e}
    out: dict = {}
    if not emails:
        return out
    E = models.NexusEmployee
    for email, first, last in (db.query(E.work_email, E.first_name, E.last_name)
                               .filter(func.lower(E.work_email).in_(sorted(emails))).all()):
        full = f"{first or ''} {last or ''}".strip()
        if full:
            out[(email or "").lower()] = full
    rest = sorted(emails - set(out))
    if rest:
        for email, shown in (db.query(models.NexusRole.email, models.NexusRole.display_name)
                             .filter(models.NexusRole.email.in_(rest)).all()):
            if shown:
                out[(email or "").lower()] = shown
    for email in emails - set(out):
        local = email.split("@", 1)[0]
        out[email] = " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p) or email
    return out


def _status_label(status: str) -> str:
    import ticket_mail_templates as tmpl
    return tmpl.status_label(status or "")


def _sla_word(f: _Fact, now: datetime) -> str:
    met = f.sla_met()
    if met is not None:
        return "Met" if met else "Missed"
    if f.done:
        return ""
    if f.breached_now(now):
        return "Breached"
    return "Paused" if not f.running else "On Track"


# ── CSV ──────────────────────────────────────────────────────────────────────

CSV_TICKET_COLUMNS = (
    ("Ticket", "ticket"), ("Subject", "subject"), ("Company", "company"), ("Department", "department"),
    ("Type", "type"), ("Priority", "priority"), ("Status", "status"), ("Assignee", "assignee"),
    ("Requester", "requester"), ("Help Topic", "helpTopic"), ("Service Area", "serviceArea"),
    ("Source", "source"), ("Created", "created"), ("First Response", "firstResponse"),
    ("Resolved", "resolved"), ("SLA Due", "slaDue"), ("First Response (Hours)", "firstResponseHours"),
    ("Resolution (Hours)", "resolutionHours"), ("Resolution SLA", "resolutionSla"),
    ("First Response SLA", "firstResponseSla"), ("CSAT", "csat"),
)
CSV_AGENT_COLUMNS = (
    ("Agent", "name"), ("Open", "open"), ("Resolved", "resolved"),
    ("Median First Response (Hours)", "firstResponseMedianHours"),
    ("Median Resolution (Hours)", "resolutionMedianHours"), ("SLA Met %", "slaMetPct"),
    ("Avg CSAT", "csatAvg"), ("Oldest Open (Days)", "oldestOpenDays"),
)


def _blank(v):
    return "" if v is None else v


def to_csv(report: dict) -> str:
    """The per-ticket rows, then the per-agent table, from one report."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"Ticket Report {report['range']['label']}"])
    w.writerow([])
    w.writerow([h for h, _k in CSV_TICKET_COLUMNS])
    for t in report.get("tickets") or []:
        w.writerow([_blank(t.get(k)) for _h, k in CSV_TICKET_COLUMNS])
    w.writerow([])
    w.writerow(["Per Agent"])
    w.writerow([h for h, _k in CSV_AGENT_COLUMNS])
    for a in report["agents"]:
        w.writerow([_blank(a.get(k)) for _h, k in CSV_AGENT_COLUMNS])
    return buf.getvalue()


def csv_filename(report: dict) -> str:
    s = date.fromisoformat(report["range"]["start"]).strftime("%m-%d-%Y")
    e = date.fromisoformat(report["range"]["end"]).strftime("%m-%d-%Y")
    return f"ticket-report-{s}-to-{e}.csv"


# ── Per-person opt-out ───────────────────────────────────────────────────────

def weekly_opted_in(db: Session, email: str) -> bool:
    row = db.get(models.NexusPersonPref, (email or "").strip().lower())
    return row is None or int(row.ticket_weekly_report if row.ticket_weekly_report is not None else 1) != 0


def set_weekly_opt_in(db: Session, email: str, on: bool) -> bool:
    email = (email or "").strip().lower()
    row = db.get(models.NexusPersonPref, email)
    if row is None:
        row = models.NexusPersonPref(email=email)
        db.add(row)
    row.ticket_weekly_report = 1 if on else 0
    row.updated_at = ticket_sla.iso(ticket_sla.utcnow())
    db.commit()
    return bool(on)


# ── Weekly email ─────────────────────────────────────────────────────────────

def _candidates(db: Session) -> list:
    """Everyone who could hold a desk role: administrators / owners, and
    the members of an Access Group granting tasks or tickets - the people
    /task-tickets/desk-agents checks."""
    emails = {r.email for r in db.query(models.NexusRole.email)
              .filter(models.NexusRole.role.in_(["administrator", "owner"])).all() if r.email}
    for email, mods in (db.query(models.NexusGroupMember.email, models.NexusGroup.allowed_modules)
                        .join(models.NexusGroup, models.NexusGroup.id == models.NexusGroupMember.group_id).all()):
        if any(p.strip().partition(":")[0] in ("tasks", "tickets") for p in (mods or "").split(",")):
            emails.add(email)
    return sorted({(e or "").strip().lower() for e in emails if e})


def is_recipient(db: Session, email: str) -> bool:
    """A ticket supervisor (ticket_roles.can_manage_desk), active internal
    staff on the People list, who has not opted out."""
    import ticket_roles
    from routers.tickets import _internal_person
    if not _internal_person(db, email):
        return False
    if not ticket_roles.can_manage_desk(viewer_for(db, email), db):
        return False
    return weekly_opted_in(db, email)


def week_due(db: Session, email: str, now: datetime) -> date | None:
    """The Monday of the week to report, when the email is due for `email`
    now: Monday from SEND_HOUR in their own zone, for the previous
    Monday-Sunday, unless that week is already logged."""
    import ticket_notify
    local = now.astimezone(_zone(ticket_notify._zone_for(db, email)))
    if local.isoweekday() != 1 or local.time() < dtime(SEND_HOUR, 0):
        return None
    ws = local.date() - timedelta(days=7)
    L = models.TicketReportEmailLog
    if db.query(L.id).filter(L.recipient == email, L.week_start == ws.isoformat()).first() is not None:
        return None
    return ws


def recipients_due(db: Session, now: datetime) -> list:
    """[(email, week_start)] due now."""
    out = []
    for email in _candidates(db):
        ws = week_due(db, email, now)
        if ws is not None and is_recipient(db, email):
            out.append((email, ws))
    return out


def _fmt_hours(h) -> str:
    if h is None:
        return "-"
    return f"{h:.1f} hrs" if h < 48 else f"{h / 24:.1f} days"


def _fmt_pct(p) -> str:
    return "-" if p is None else f"{p}%"


def render_email(report: dict, first_name: str, base_url: str, logo_url: str = "") -> tuple:
    """(subject, html) - the ticket emails' card shell (dark-green header,
    inline styles, layout tables), with the report's numbers."""
    import email_theme
    th = email_theme.current()
    k = report["kpis"]
    rng = report["range"]["label"]
    url = f"{(base_url or '').rstrip('/')}/tickets?view=reports" if base_url else "#"
    brand = th.color("#0f3d2e")
    subject = f"Weekly Ticket Report {rng}"

    def tile(label: str, value: str, color: str = "#111827") -> str:
        return (f"<td width='25%' valign='top' style='padding:6px'>"
                f"<div style='border:1px solid #e5e7eb;border-radius:10px;padding:12px 10px;text-align:center'>"
                f"<div style='font-size:20px;font-weight:700;color:{color}'>{escape(value)}</div>"
                f"<div style='font-size:11.5px;color:#6b7280;margin-top:3px'>{escape(label)}</div></div></td>")

    tiles = [
        tile("Created", str(k["created"])), tile("Resolved", str(k["resolved"])),
        tile("Open Now", str(k["openNow"])),
        tile("Breached Now", str(k["breachedNow"]), "#dc2626" if k["breachedNow"] else "#111827"),
        tile("SLA Met", _fmt_pct(k["slaMetPct"])), tile("First Response Met", _fmt_pct(k["firstResponseMetPct"])),
        tile("Median First Response", _fmt_hours(k["firstResponseMedianHours"])),
        tile("Median Resolution", _fmt_hours(k["resolutionMedianHours"])),
    ]
    tiles_html = ("<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse'>"
                  f"<tr>{''.join(tiles[:4])}</tr><tr>{''.join(tiles[4:])}</tr></table>")

    th_style = ("padding:7px 8px;border-bottom:1px solid #e5e7eb;font-size:11.5px;color:#6b7280;"
                "font-weight:700;text-align:left")
    td_style = "padding:7px 8px;border-bottom:1px solid #f0f1f3;font-size:12.5px;color:#1f2937"

    def table(headers: list, body_rows: list) -> str:
        head = "".join(f"<th style='{th_style}'>{escape(h)}</th>" for h in headers)
        body = "".join("<tr>" + "".join(f"<td style='{td_style}'>{escape(str(c))}</td>" for c in r) + "</tr>"
                       for r in body_rows)
        return (f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse'>"
                f"<tr>{head}</tr>{body}</table>")

    def section(title: str, inner: str) -> str:
        return (f"<tr><td style='padding:18px 28px 0'><h3 style='margin:0 0 8px;font-size:14.5px;color:#111827'>"
                f"{escape(title)}</h3>{inner}</td></tr>")

    aging = report["aging"]
    aging_rows = [[b["label"], b["total"]] + [b["byPriority"][p] for p in PRIORITIES] for b in aging["buckets"]]
    aging_rows.append(["Paused", aging["paused"]["total"]] + [aging["paused"]["byPriority"][p] for p in PRIORITIES])
    agents = report["agents"][:12]
    agent_rows = [[a["name"], a["open"], a["resolved"], _fmt_hours(a["firstResponseMedianHours"]),
                   _fmt_pct(a["slaMetPct"]), "-" if a["oldestOpenDays"] is None else f"{a['oldestOpenDays']} days"]
                  for a in agents]
    pri_rows = [[b["label"], b["created"], b["resolved"], b["open"]] for b in report["breakdowns"]["priority"]]

    sections = section("Open Tickets by Age", table(["Age", "Total"] + [PRIORITY_LABEL[p] for p in PRIORITIES], aging_rows))
    if agent_rows:
        sections += section("By Agent", table(["Agent", "Open", "Resolved", "Median First Response", "SLA Met", "Oldest Open"], agent_rows))
    if pri_rows:
        sections += section("By Priority", table(["Priority", "Created", "Resolved", "Open"], pri_rows))
    if report["recurring"]:
        rec = "".join(f"<div style='font-size:12.5px;color:#1f2937;padding:3px 0'>{escape(e['label'])} "
                      f"<span style='color:#6b7280'>({e['count']} tickets)</span></div>" for e in report["recurring"][:5])
        sections += section("Recurring Subjects", rec)

    hello = f"Hi {first_name}," if first_name else "Hi,"
    intro = (f"{hello} here is how the service desk did last week ({rng}), for the tickets you can see. "
             f"Reopened: {k['reopened']}. Backlog change: {k['backlogChange']:+d}.")
    html = f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr><td style="background:{brand};padding:18px 28px">{th.logo_block(logo_url)}</td></tr>
    <tr><td style="padding:26px 28px 4px">
      <div style="font-size:11.5px;color:#9ca3af;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">{escape(rng)}</div>
      <h2 style="margin:0 0 10px;font-size:19px;color:#111827;line-height:1.35">Weekly Ticket Report</h2>
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:#374151">{escape(intro)}</p>
    </td></tr>
    <tr><td style="padding:12px 22px 0">{tiles_html}</td></tr>
    {sections}
    <tr><td style="padding:24px 28px 28px;text-align:center">
      <a href="{escape(url)}" style="display:inline-block;background:{brand};color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 28px;border-radius:8px">Open Ticket Reports</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
      You get this every Monday because you supervise the service desk. To stop it, turn off Weekly Email on the Tickets &gt; Reports tab.{th.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return subject, html


def send_weekly(db: Session, email: str, ws: date, now: datetime | None = None) -> str:
    """Build, claim and send one person's report for the week starting `ws`.
    Returns the logged status (sent / failed / empty), or "" when another
    worker already holds the week. Commits."""
    import graph_mail
    import ticket_notify
    from app_url import app_url
    now = now or ticket_sla.utcnow()
    report = build_report(db, email, start=ws.isoformat(), end=(ws + timedelta(days=6)).isoformat(), now=now)
    k = report["kpis"]
    row = models.TicketReportEmailLog(
        id=str(uuid.uuid4()), recipient=email, week_start=ws.isoformat(),
        status="sending" if report["hasTickets"] else "empty",
        created_count=k["created"], resolved_count=k["resolved"], open_count=k["openNow"],
        created_at=ticket_sla.iso(now))
    db.add(row)
    try:
        db.commit()          # the claim - unique on (recipient, week_start)
    except IntegrityError:
        db.rollback()
        return ""
    if not report["hasTickets"]:
        return "empty"
    cfg = ticket_notify.get_settings(db)
    emp = (db.query(models.NexusEmployee.first_name)
           .filter(models.NexusEmployee.work_email == email).first())
    subject, html = render_email(report, ((emp.first_name if emp else "") or "").strip(), app_url(),
                                 cfg.get("logoUrl") or "")
    try:
        graph_mail.send_mail(from_email=(cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip(),
                             to=[email], cc=None, subject=subject, html=html,
                             reply_to=cfg.get("replyTo") or "")
        row.status, row.sent_at = "sent", ticket_sla.iso(ticket_sla.utcnow())
    except graph_mail.GraphMailError as e:
        row.status, row.error = "failed", str(e)[:1000]
    db.commit()
    return row.status


def scan_once(now: datetime | None = None) -> int:
    """One pass of the weekly email. Blocking DB + Graph work - only ever
    run in a worker thread (weekly_loop)."""
    import ticket_notify
    from database import SessionLocal
    db = SessionLocal()
    sent = 0
    try:
        if not ticket_notify.get_settings(db)["enabledEvents"].get("weekly_report", True):
            return 0
        now = now or ticket_sla.utcnow()
        for email, ws in recipients_due(db, now):
            try:
                if send_weekly(db, email, ws, now) == "sent":
                    sent += 1
            except Exception as e:
                db.rollback()
                print(f"[ticket-reports] weekly email failed for {email}: {e}")
        return sent
    finally:
        db.close()


async def weekly_loop():
    """Started once from main.py's lifespan. The scan runs in a worker
    thread (asyncio.to_thread) so its DB queries and Graph sends never block
    the event loop."""
    await asyncio.sleep(150)
    while True:
        try:
            n = await asyncio.to_thread(scan_once)
            if n:
                print(f"[ticket-reports] weekly report sent to {n} people")
        except Exception as e:
            print(f"[ticket-reports] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
