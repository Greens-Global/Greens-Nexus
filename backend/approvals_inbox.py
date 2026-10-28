"""Approvals (Neil, Oct 27 2026): one screen listing everything waiting on the
signed-in person's decision, across modules.

    GET /approvals/inbox   (routers/approvals.py)

NO NEW APPROVAL PATHS. Every row is found by the module's OWN "waiting on me"
rule - the same function or list route its screen uses, called with the same
permission dependency - and every action on a row calls the module's EXISTING
endpoint from the browser (frontend/src/lib/approvalActions.js), so the same
permission checks run. A row that needs more than one click (a time sheet to
read, a document to sign, a purchase that needs a buyer picked) only opens the
item in its module. The modules keep their own screens.

The sidebar's "waiting on you" counts (routers/action_counts.py, PR #795) read
the same registry, so a count there never disagrees with this list.

A source (one per kind of approval)
-----------------------------------
A function `fn(db, user, ctx) -> list[dict]`, registered with
`@source(key, label, group)`:

  key    stable id ("time_off"); the per-source count in collect()["counts"]
  label  what the inbox calls it when it fails: "Couldn't load <label>"
  group  the filter chip it lands under (GROUPS below)
  ctx    a dict shared by every source of ONE collect() call - a cache for
         lookups more than one source needs (the approver user, names)

It returns rows built with `row(...)`. The rules for a source:

  * Reuse the module's rule; never re-derive it. Call the list route function
    or the module's own helper, through the same dependency its route uses.
  * Raise HTTPException (or let the module's dependency raise it) when the
    caller has no access to that module's approvals: it means "nothing waits
    on you here" and is NOT shown as an error.
  * Any other exception is isolated by collect(): that source is reported as
    {"source", "label"} in `errors`, and every other source still shows.
  * Scoped queries only - no query per row of the whole table. The nav count
    polls this every minute.
  * One row per decision. `count` > 1 when one row stands for several items
    (one time sheet review row per period, "4 people"); counts sum `count`.
  * `actions` use the vocabulary the frontend knows (A_* below); `link` is a
    nexus:navigate target ({view, sub} plus the bell action keys such as
    taskId / punchRequestId / timecard, lib/openTarget.js).

HR's sources (Oct 27 2026): time off awaiting HR's second approval
(time_off_hr), salary advances to decide or pay out, probation
recommendations and overdue decisions, HR letter requests, headcount
requests and India Contractor Extra Time claims - each the module's own
rule, decided through its own endpoint.

To add one: write the function here with @source, give its row
`kind` an entry in frontend/src/lib/approvalActions.js (which endpoint each
action key calls), and, if it should count on a module's tab too, read
collect()["counts"][key] in routers/action_counts.py. Add a test in
test_approvals_inbox.py.

Deliberately left out (the same choice the nav counts made): Time Sheet
review's never-submitted closed periods (timesheet_review.not_reviewed builds
a time card per person - too slow to poll). People > Time still lists them.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Callable

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import models

log = logging.getLogger(__name__)


# ── Chips ────────────────────────────────────────────────────────────────────

# (key, label) in the order the chips show.
GROUPS = [
    ("timeoff", "Time Off"),
    ("timesheets", "Time Sheets"),
    ("shifts", "Shifts"),
    ("money", "Money"),
    ("hiring", "Hiring"),
    ("signatures", "Signatures"),
]

# ── Actions (the frontend maps each row kind + action key to an endpoint) ────
# note: "none" | "optional" | "required" - whether the browser asks for one
# first (the module's own rule: a reimbursement sent back needs a reason).

A_APPROVE = {"key": "approve", "label": "Approve", "tone": "primary", "note": "none"}
A_REJECT = {"key": "reject", "label": "Reject", "tone": "plain", "note": "optional"}
A_DECLINE = {"key": "decline", "label": "Decline", "tone": "plain", "note": "optional"}
A_ACCEPT = {"key": "accept", "label": "Accept", "tone": "primary", "note": "none"}
A_SEND_BACK = {"key": "send_back", "label": "Send Back", "tone": "plain", "note": "required"}
A_YES = {"key": "yes", "label": "Yes", "tone": "primary", "note": "required"}
A_NO = {"key": "no", "label": "No", "tone": "plain", "note": "required"}


def a_open(label: str = "Open") -> dict:
    return {"key": "open", "label": label, "tone": "plain", "note": "none"}


# ── Registry ─────────────────────────────────────────────────────────────────

class Source:
    __slots__ = ("key", "label", "group", "fn")

    def __init__(self, key: str, label: str, group: str, fn: Callable):
        self.key, self.label, self.group, self.fn = key, label, group, fn


SOURCES: list[Source] = []


def source(key: str, label: str, group: str):
    """Register a source. Order of registration = order of the per-source
    counts; rows are sorted by age whatever the order."""
    if group not in {g for g, _ in GROUPS}:
        raise ValueError(f"unknown approvals group {group!r}")

    def deco(fn):
        SOURCES[:] = [s for s in SOURCES if s.key != key] + [Source(key, label, group, fn)]
        return fn
    return deco


def _iso(v) -> str:
    """Any stored timestamp as an aware UTC ISO string ('' when unreadable).
    Rows mix datetime.utcnow() (naive) and aware strings; the browser and the
    sort need one shape."""
    s = str(v or "").strip()
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def row(kind: str, rid: str, *, person_email: str = "", person_name: str = "", title: str, detail: str = "",
        created_at="", actions=(), link: dict | None = None, count: int = 1, for_name: str = "") -> dict:
    """One inbox line, the same shape for every source."""
    return {"key": f"{kind}:{rid}", "kind": kind, "id": rid,
            "person": {"email": (person_email or "").lower(), "name": person_name or person_email or ""},
            "title": title, "detail": detail or "", "createdAt": _iso(created_at),
            "actions": [dict(a) for a in actions], "link": link or {}, "count": max(1, int(count or 1)),
            "forName": for_name or ""}


def collect(db: Session, user: dict, only=None) -> dict:
    """Every source's rows, oldest waiting first.

    {"rows": [...], "counts": {source key: n}, "groups": {chip: n},
     "errors": [{"source", "label"}], "total": n}

    A source the caller has no access to (HTTPException) counts 0 quietly; a
    source that fails is listed in `errors` and the rest still show."""
    ctx: dict = {}
    rows, counts, errors = [], {}, []
    for s in SOURCES:
        if only is not None and s.key not in only:
            continue
        try:
            got = list(s.fn(db, user, ctx) or [])
        except HTTPException:
            got = []
        except Exception:   # noqa: BLE001 - one module failing never blanks the inbox
            log.exception("approvals source %s failed", s.key)
            try:
                db.rollback()
            except Exception:   # noqa: BLE001
                pass
            errors.append({"source": s.key, "label": s.label})
            continue
        for r in got:
            r["source"], r["group"] = s.key, s.group
        counts[s.key] = sum(r["count"] for r in got)
        rows += got
    # Oldest waiting first: an approval queue is first come, first served, and
    # the one waiting longest is the one most likely to be late (a leave that
    # starts soon, a pay period about to close). Undated rows go last.
    rows.sort(key=lambda r: (r["createdAt"] or "9999", r["key"]))
    groups: dict = {}
    for r in rows:
        groups[r["group"]] = groups.get(r["group"], 0) + r["count"]
    return {"rows": rows, "counts": counts, "groups": groups, "errors": errors,
            "total": sum(counts.values())}


# ── Shared lookups ───────────────────────────────────────────────────────────

def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _approver(db: Session, user: dict, ctx: dict) -> dict:
    """The user the approval list routes see (require_approval_read): the
    team-read gate, plus a live approval delegation's people. Raises the
    gate's HTTPException for someone who approves nothing there."""
    if "approver" not in ctx:
        from routers.timeclock import require_approval_read, require_team_read
        try:
            ctx["approver"] = require_approval_read(user=require_team_read(user={**user}, db=db), db=db)
        except HTTPException as e:
            ctx["approver"] = e
    if isinstance(ctx["approver"], HTTPException):
        raise ctx["approver"]
    return ctx["approver"]


def _names(db: Session, ctx: dict) -> dict:
    if "names" not in ctx:
        from routers.shift_requests import _names as shift_names
        ctx["names"] = shift_names(db)
    return ctx["names"]


def _name(db: Session, ctx: dict, email: str) -> str:
    em = (email or "").strip().lower()
    return _names(db, ctx).get(em) or em.split("@")[0].replace(".", " ").title()


def _us_day(iso: str) -> str:
    from routers.timeclock import _us_day as us_day
    return us_day(iso)


def _span(a: str, b: str) -> str:
    """'11/03/2026 to 11/05/2026', or one date when they are the same day."""
    return _us_day(a) if (a or "")[:10] == (b or "")[:10] else f"{_us_day(a)} to {_us_day(b)}"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _short(text: str, n: int = 140) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 3].rstrip() + "..."


# ── Time off (Team > Requests, People > Time) ────────────────────────────────

@source("time_off", "Time Off", "timeoff")
def _time_off(db: Session, user: dict, ctx: dict) -> list:
    """The time-off list's pending rows the caller can decide (canDecide) -
    the same call and rule the nav count and Team > Requests use."""
    from routers.timeclock import _TIMEOFF_LIST_LIMIT, list_timeoff
    u = _approver(db, user, ctx)
    out = []
    for t in list_timeoff(status="pending", from_="", to="", limit=_TIMEOFF_LIST_LIMIT, user=u, db=db):
        # A request the manager already approved that now waits for HR
        # (Second Approval By HR) is the time_off_hr source's row - each once.
        if t.get("canDecide") is False or t.get("awaitingHr"):
            continue
        out.append(_time_off_row("time_off", t))
    return out


def _time_off_row(kind_key: str, t: dict) -> dict:
    from routers.timeclock import _timeoff_window
    span = _span(t["startDate"], t["endDate"]) + _timeoff_window(t.get("startTime") or "", t.get("endTime") or "")
    try:
        days = (date.fromisoformat(t["endDate"][:10]) - date.fromisoformat(t["startDate"][:10])).days + 1
    except (TypeError, ValueError):
        days = 0
    title = f"Time Off - {span}" + (f" ({_plural(days, 'day')})" if days > 1 else "")
    kind = (t.get("type") or "time off").replace("_", " ").title()
    note = "" if t.get("redacted") else _short(t.get("note") or "")
    detail = f"{kind}{' - ' + note if note else ''}"
    if kind_key == "time_off_hr":
        first = t.get("firstApproverName") or t.get("firstApprover") or "the manager"
        detail = f"{detail} - approved by {first}, waiting for HR"
    hr = kind_key == "time_off_hr"
    return row(kind_key, t["id"], person_email=t["email"], person_name=t.get("name") or "",
               title=title, detail=detail,
               # HR's wait starts when the manager said yes.
               created_at=(t.get("firstDecidedAt") if hr else "") or t.get("createdAt"),
               actions=(A_APPROVE, A_REJECT), link={"view": "hr", "sub": "hr-time-off" if hr else "hr-time"},
               for_name=t.get("forName") or "")


@source("time_off_hr", "Time Off Awaiting HR", "timeoff")
def _time_off_hr(db: Session, user: dict, ctx: dict) -> list:
    """Time off the manager approved that waits for the caller as HR (Second
    Approval By HR, leave depth Oct 27 2026) - routers/timeclock
    .timeoff_awaiting_hr, the People > Time > Time Off "Awaiting HR" list.
    Decided through POST /timeoff/{id}/hr-decision (HR need not hold the
    team approval rights the manager's PATCH asks for)."""
    from routers.timeclock import timeoff_awaiting_hr
    return [_time_off_row("time_off_hr", t) for t in timeoff_awaiting_hr(user=user, db=db)]


# ── Punch fixes and punch-time edits (People > Time > Punch requests) ────────

_KIND_WORD = {"in": "Clock-In", "out": "Clock-Out", "break_start": "Break Start", "break_end": "Break End"}


def _clock(at_utc: str, zone: str = "", offset_min: int | None = None) -> str:
    """A UTC punch time on the EMPLOYEE's clock, '6:15 PM' (Oct 19: the
    approver reads the time they asked for, not their own zone's)."""
    from routers.timeclock import _parse_iso, _us_time
    if offset_min is not None:
        return _us_time(at_utc, offset_min)
    dt = _parse_iso(at_utc)
    if not dt:
        return ""
    try:
        from zoneinfo import ZoneInfo
        local = dt.replace(tzinfo=timezone.utc).astimezone(ZoneInfo(zone)) if zone else dt
    except Exception:   # noqa: BLE001 - an unknown zone reads as UTC
        local = dt
    return local.strftime("%I:%M %p").lstrip("0")


@source("punch_fix", "Punch Fixes", "timesheets")
def _punch_fixes(db: Session, user: dict, ctx: dict) -> list:
    """Punch-fix requests - one row per person + kind + minute, the copies of
    the same fix being one decision (the server closes them together, Oct 7)
    - and pending punch-time edits. The same two list routes People > Time
    uses."""
    from routers.timeclock import list_pending_punch_edits, list_punch_requests
    u = _approver(db, user, ctx)
    out, seen = [], set()
    # Oldest first, so the row kept for a set of copies is the first asked.
    for r in reversed(list_punch_requests(status="pending", user=u, db=db)):
        key = (f"{r['employeeEmail'].lower()}|{r['punchKind']}|{(r['at'] or '')[:16]}"
               if r["action"] == "add" and r["at"] else r["id"])
        if key in seen:
            continue
        seen.add(key)
        day = _us_day(r.get("localDate") or "")
        if r["action"] == "add":
            title = f"Punch Fix - {day} {_KIND_WORD.get(r['punchKind'], r['punchKind'])} {_clock(r['at'], r.get('timeZone') or '')}".rstrip()
        else:
            title = f"Punch Fix - Remove A Punch On {day}"
        out.append(row("punch_fix", r["id"], person_email=r["employeeEmail"], person_name=r.get("employeeName") or "",
                       title=title, detail=_short(r.get("reason") or ""), created_at=r.get("createdAt"),
                       actions=(A_APPROVE, A_REJECT),
                       link={"view": "hr", "sub": "hr-time-requests", "punchRequestId": r["id"]},
                       for_name=r.get("forName") or ""))
    for p in list_pending_punch_edits(user=u, db=db):
        off = int(p.get("tzOffsetMin") or 0)
        title = (f"Punch Edit - {_us_day(p.get('localDate') or '')} {_KIND_WORD.get(p['kind'], p['kind'])} "
                 f"{_clock(p['at'], offset_min=off)} to {_clock(p['pendingAt'], offset_min=off)}")
        out.append(row("punch_edit", p["id"], person_email=p["email"], person_name=p.get("employeeName") or "",
                       title=title, detail=_short(p.get("editReason") or ""), created_at=p.get("editedAt"),
                       actions=(A_APPROVE, A_REJECT), link={"view": "hr", "sub": "hr-time"},
                       for_name=p.get("forName") or ""))
    return out


# ── Time Sheets: review (People > Time) and signatures (Workday) ─────────────

@source("timesheet_review", "Time Sheet Reviews", "timesheets")
def _timesheet_reviews(db: Session, user: dict, ctx: dict) -> list:
    """Time sheets submitted to the caller (timesheet_review.waiting_on - the
    reviewer, the person's manager now, a Backup Manager, the Global Admin
    fallback and a live delegation), one row per pay period. Reviewing means
    reading the hours, so the row opens People > Time."""
    import approval_delegation
    import timesheet_review as tsr
    me = _me(user)
    reviews = tsr.waiting_on(db, me)
    if not reviews:
        return []
    deleg = approval_delegation.delegated_people(db, me)
    emps = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email).in_(sorted({r.employee_email.lower() for r in reviews}))).all()}
    periods: dict = {}
    for r in reviews:
        periods.setdefault((r.period_start, r.period_end), []).append(r)
    out = []
    for (start, end), rs in periods.items():
        sent = []
        for r in rs:
            last = next((e for e in reversed(r.rounds or []) if e.get("action") in ("submitted", "resubmitted")), {})
            sent.append(_iso(last.get("at") or r.updated_at) or "9999")
        fors = {deleg.get(r.employee_email.lower(), "") for r in rs}
        for_name = tsr.display_name(db, next(iter(fors))) if len(fors) == 1 and "" not in fors else ""
        span = _span(start, end)
        if len(rs) == 1:
            r = rs[0]
            person, email, link = tsr.display_name(db, r.employee_email), r.employee_email, tsr._reviewer_action(r)
            title = f"Time Sheet Review - {span}"
        else:
            places = {((emps.get(r.employee_email.lower()).location if emps.get(r.employee_email.lower()) else "") or "").strip()
                      for r in rs}
            person = places.pop() if len(places) == 1 and "" not in places else "Your Team"
            email, link = "", {"view": "hr", "sub": "hr-time"}
            title = f"Time Sheet Review - {span} ({len(rs)} people)"
        out.append(row("timesheet_review", f"{start}|{end}", person_email=email, person_name=person, title=title,
                       detail="Read the hours, then Review & Approve or Send Back.", created_at=min(sent),
                       actions=(a_open("Review"),), link=link, count=len(rs), for_name=for_name))
    return out


@source("timesheet_sign", "Time Sheets To Sign", "timesheets")
def _timesheets_to_sign(db: Session, user: dict, ctx: dict) -> list:
    """Time Sheet envelopes waiting on the caller's signature
    (timesheet_review.to_sign - the Workday > Time Sheet card)."""
    import timesheet_review as tsr
    me = _me(user)
    out = []
    for s in tsr.to_sign(db, me):
        own = (s["employeeEmail"] or "").lower() == me
        span = _span(s["periodStart"], s["periodEnd"])
        title = ("Sign Your Updated Time Sheet" if s.get("needsResign") else "Sign Time Sheet") + f" - {span}"
        detail = f"Approved by {s['agreedBy']}." if s.get("agreedBy") else ""
        out.append(row("timesheet_sign", s["partyId"] or s["id"], person_email=s["employeeEmail"],
                       person_name="You" if own else s.get("name") or "", title=title, detail=detail,
                       created_at=s.get("agreedAt"), actions=(a_open("Review & Sign"),),
                       link={"view": "myhr", "sub": "timesheet"}))
    return out


# ── Nexus Sign (Workday > Documents to Sign) ─────────────────────────────────

@source("nexus_sign", "Documents To Sign", "signatures")
def _documents_to_sign(db: Session, user: dict, ctx: dict) -> list:
    """Nexus Sign documents where it is the caller's turn - Time Sheets left
    to their own source, the same filter the Documents to Sign card uses."""
    from routers.esign import my_signatures
    out = []
    for r in my_signatures(user=user, db=db):
        if not r["myTurn"] or r.get("linkKind") == "timesheet":
            continue
        sender = r.get("from") or ""
        out.append(row("nexus_sign", r["partyId"], person_email=sender, person_name=_name(db, ctx, sender) if sender else "",
                       title=r.get("title") or "Document To Sign",
                       detail=f"Expires {_us_day(r['expiresOn'])}." if r.get("expiresOn") else "",
                       created_at=r.get("createdAt"), actions=(a_open("Review & Sign"),),
                       link={"view": "myhr", "sub": f"sign:{r['partyId']}"}))
    return out


# ── Money: reimbursements and purchase requests (Workday) ────────────────────

@source("reimbursement", "Reimbursements", "money")
def _reimbursements(db: Session, user: dict, ctx: dict) -> list:
    """Claims waiting on the caller: as the chosen approver, or as HR once the
    approver said yes and the receipt is in (routers/reimbursements.waiting_on
    - the same gates the decide route checks)."""
    from routers.reimbursements import _money, waiting_on
    out = []
    for r, step in waiting_on(db, _me(user)):
        n = len(r.receipts or [])
        if step == "approver":
            sent = next((h.get("at") for h in reversed(r.history or []) if h.get("action") in ("submitted", "resubmitted")),
                        r.created_at)
            detail = _short(r.item or "")
        else:
            sent = r.approved_at or r.updated_at
            detail = _short(f"{r.item or ''} - approved by {_name(db, ctx, r.approved_by or r.approver_email)}, with HR")
        title = f"Reimbursement - {_money(float(r.amount or 0), r.currency or 'USD')}" + (f" ({_plural(n, 'receipt')})" if n else "")
        out.append(row("reimbursement", r.id, person_email=r.employee_email, person_name=r.employee_name or "",
                       title=title, detail=detail, created_at=sent, actions=(A_APPROVE, A_SEND_BACK),
                       link={"view": "myhr", "sub": "reimbursements"}))
    return out


@source("purchase_request", "Purchase Requests", "money")
def _purchase_requests(db: Session, user: dict, ctx: dict) -> list:
    """Purchase requests waiting on the caller (routers/requisitions
    .waiting_on: the approver the request was sent to). Approving picks who
    buys it, so the row opens Workday > Purchase Requests."""
    from routers.requisitions import waiting_on
    out = []
    for r in waiting_on(db, user):
        qty = int(r.quantity or 1)
        out.append(row("purchase_request", r.id, person_email=r.employee_email, person_name=r.employee_name or "",
                       title=f"Purchase Request - {r.item}" + (f" ({qty})" if qty > 1 else ""),
                       detail=_short(r.reason or ""), created_at=r.created_at, actions=(a_open("Review"),),
                       link={"view": "myhr", "sub": "purchase"}))
    return out


# ── Shifts: manager decisions and a teammate's yes (Team, Workday) ───────────

# Trading (swaps, offers, open-shift claims, releases) is switched on per
# company and OFF by default (Settings > Shifts & Scheduling): with a kind off
# nobody can MAKE such a request (shift_requests.create_request refuses it),
# so a company that never turned it on has none of these rows. One made
# before a switch-off stays decidable in Team > Requests and on the Workday
# card, so it stays here too - hiding it would leave the nav count and those
# screens disagreeing with this list.

def _shift_title(db: Session, ctx: dict, r: models.ShiftRequest, *, mine: bool = False) -> str:
    from routers.shift_requests import _when
    when = _when(r.shift_date, r.shift_start, r.shift_end)
    if r.kind == "open":
        return f"Open Shift - {when}"
    if r.kind == "release":
        return f"Release Shift - {when}"
    other = "your" if mine else f"{_name(db, ctx, r.target_email)}'s"
    if r.kind == "swap":
        return f"Shift Swap - {when} for {other} {_when(r.target_date, r.target_start, r.target_end)}"
    return f"Shift Offer - {when}" + ("" if mine else f" to {_name(db, ctx, r.target_email)}")


@source("shift_request", "Shift Requests", "shifts")
def _shift_requests(db: Session, user: dict, ctx: dict) -> list:
    """The Team > Requests inbox's `pending` rule (shift_requests.inbox /
    _decidable), never a request the caller is part of."""
    from routers.shift_requests import _decidable
    from routers.timeclock import _visible_emails, require_schedule_write
    u = require_schedule_write(user={**user}, db=db)
    scope, me, cache = _visible_emails(db, u), u["email"].lower(), {}
    out = []
    for r in (db.query(models.ShiftRequest).filter(models.ShiftRequest.status == "pending_manager")
              .order_by(models.ShiftRequest.created_at).all()):
        if me in (r.requester_email, r.target_email) or not _decidable(db, r, scope, me, cache):
            continue
        out.append(row("shift_request", r.id, person_email=r.requester_email, person_name=_name(db, ctx, r.requester_email),
                       title=_shift_title(db, ctx, r), detail=_short(r.note or ""),
                       created_at=r.peer_decided_at or r.created_at, actions=(A_APPROVE, A_DECLINE),
                       link={"view": "shifts", "sub": "requests"}))
    return out


@source("shift_peer", "Shift Swaps", "shifts")
def _shift_swaps_for_me(db: Session, user: dict, ctx: dict) -> list:
    """A teammate's swap / offer waiting for the caller's yes - upcoming
    shifts only (Workday > Time Off's Shift Requests card)."""
    me = _me(user)
    R = models.ShiftRequest
    out = []
    for r in (db.query(R).filter(R.target_email == me, R.status == "pending_peer",
                                 or_(R.shift_date == "", R.shift_date >= date.today().isoformat()))
              .order_by(R.created_at).all()):
        out.append(row("shift_peer", r.id, person_email=r.requester_email, person_name=_name(db, ctx, r.requester_email),
                       title=_shift_title(db, ctx, r, mine=True), detail=_short(r.note or ""),
                       created_at=r.created_at, actions=(A_ACCEPT, A_DECLINE),
                       link={"view": "myhr", "sub": "timeoff"}))
    return out


# ── Hiring: screening and the decision vote (tasks, hiring_*.py) ─────────────

def _open_tasks_for(db: Session, me: str, task_ids: list) -> dict:
    """{task id: Task} for the open tasks among `task_ids` assigned to me."""
    if not task_ids:
        return {}
    out = {}
    for t in (db.query(models.Task).filter(models.Task.id.in_(task_ids),
                                           or_(models.Task.completed.is_(False), models.Task.completed.is_(None))).all()):
        who = {(e or "").strip().lower() for e in (t.assignee_emails or [])} | {(t.assignee_email or "").strip().lower()}
        if me in who:
            out[t.id] = t
    return out


@source("hiring_vote", "Hiring Votes", "hiring")
def _hiring_votes(db: Session, user: dict, ctx: dict) -> list:
    """Candidates in Decision whose "Decide on" task names the caller and who
    have no Yes / No from them yet this round (hiring_decision.summary - the
    candidate card's own "who has not answered"). Voting is a comment on that
    task that starts with Yes or No and says why - the module's only path."""
    import hiring_decision
    me = _me(user)
    C = models.HrCandidate
    cands = (db.query(C).filter(C.stage == "decision", or_(C.decision == "", C.decision.is_(None)),
                                C.decision_task_id != "").all())
    tasks = _open_tasks_for(db, me, [c.decision_task_id for c in cands])
    out = []
    for c in cands:
        t = tasks.get(c.decision_task_id)
        if t is None:
            continue
        s = hiring_decision.summary(db, c)
        mine = next((v for v in s["votes"] if v["email"] == me), None)
        if mine is not None and mine["vote"]:
            continue
        name = f"{c.first_name or ''} {c.last_name or ''}".strip()
        role = c.role_title or c.department or ""
        final = s["decider"] == me
        detail = (f"{role} - " if role else "") + ("you make the final call." if final else "say Yes or No and why.")
        out.append(row("hiring_vote", t.id, person_email="", person_name=role or "Hiring",
                       title=f"Hiring Vote - {name}", detail=detail[:1].upper() + detail[1:],
                       created_at=t.created_at, actions=(A_YES, A_NO),
                       link={"view": "tasks", "sub": "mine", "taskId": t.id}))
    return out


@source("hiring_screen", "Candidate Screening", "hiring")
def _hiring_screens(db: Session, user: dict, ctx: dict) -> list:
    """Screening tasks ("Screen <name>") still open and assigned to the
    caller (hiring_screening.start). Screening is reading the resume and
    writing notes on the task, so the row opens it."""
    me = _me(user)
    C = models.HrCandidate
    cands = (db.query(C).filter(C.screen_task_id != "", C.stage.notin_(("rejected", "hired"))).all())
    tasks = _open_tasks_for(db, me, [c.screen_task_id for c in cands])
    out = []
    for c in cands:
        t = tasks.get(c.screen_task_id)
        if t is None:
            continue
        name = f"{c.first_name or ''} {c.last_name or ''}".strip()
        role = c.role_title or c.department or ""
        out.append(row("hiring_screen", t.id, person_email="", person_name=role or "Hiring",
                       title=f"Screen Candidate - {name}",
                       detail=f"Due {_us_day(t.due_on)}." if t.due_on else "Read the resume and add your notes.",
                       created_at=t.created_at, actions=(a_open("Open Task"),),
                       link={"view": "tasks", "sub": "mine", "taskId": t.id}))
    return out


# ── HR (Oct 27 2026): salary advances, probation, HR letters, headcount ──────
# Each one reads its module's own "waiting on HR" rule (salary_advance
# .pending_for_hr, hr_probation.is_hr_plus, hr_letters.hr_companies,
# routers/hiring._can_decide) and decides through the module's existing
# endpoint. A step that needs more than a click (paying an advance out,
# reviewing a letter before it is issued, ending someone's employment) opens
# the module instead.

# A decline the module refuses without a reason.
A_DECLINE_WHY = {"key": "decline", "label": "Decline", "tone": "plain", "note": "required"}

GROUPS.append(("people", "People"))


def _hr_anywhere(db: Session, user: dict) -> bool:
    """Could the caller be HR (timesheet_review.is_hr's doors: administrator /
    owner, a Full HR grant, a company's HR contact) for anyone? A cheap gate
    so the per-person rules below only run for HR - the nav count polls."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_team_limited
    me = _me(user)
    if not me or user.get("external"):
        return False
    if int(user.get("level", 0)) >= _LEVELS["administrator"]:
        return True
    if not hr_team_limited(user) and _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]:
        return True
    return db.query(models.HrEntity.id).filter(func.lower(models.HrEntity.hr_contact_email) == me).first() is not None


@source("salary_advance", "Salary Advances", "money")
def _salary_advances(db: Session, user: dict, ctx: dict) -> list:
    """Salary advances waiting on the caller as HR (salary_advance
    .pending_for_hr - GET /salary-advances/pending): a request to decide
    (Approve / Decline inline, POST /salary-advances/{id}/decide), or an
    approved advance to pay out (Mark Paid Out asks for the method and the
    reference, so it opens the Salary Advances card)."""
    import salary_advance as sa
    if not _hr_anywhere(db, user):
        return []
    out = []
    for adv in sa.pending_for_hr(db, user):
        # An advance's amount is pay (sa.sees_pay); pending_for_hr already
        # keeps only what the caller can decide, which needs the pay grant.
        money = sa.money(adv.amount, adv.currency or "USD") if sa.sees_pay(db, user, adv.employee_email) else ""
        n = int(adv.installments or 1)
        link = {"view": "myhr", "sub": "salary-advances"}
        who = adv.employee_name or _name(db, ctx, adv.employee_email)
        if adv.status == "requested":
            out.append(row("salary_advance", adv.id, person_email=adv.employee_email, person_name=who,
                           title=(f"Salary Advance - {money} ({_plural(n, 'pay period')})" if money
                                  else f"Salary Advance ({_plural(n, 'pay period')})"),
                           detail=_short(adv.reason or ""), created_at=adv.requested_at or adv.created_at,
                           actions=(A_APPROVE, A_DECLINE_WHY), link=link))
        else:
            out.append(row("salary_advance_payout", adv.id, person_email=adv.employee_email, person_name=who,
                           title=f"Pay Out Salary Advance - {money}" if money else "Pay Out Salary Advance",
                           detail=f"Approved by {_name(db, ctx, adv.decided_by)}. Mark it Paid Out once it is paid.",
                           created_at=adv.decided_at or adv.updated_at, actions=(a_open("Pay Out"),), link=link))
    return out


@source("probation", "Probation", "people")
def _probation(db: Session, user: dict, ctx: dict) -> list:
    """Probation waiting on HR (hr_probation.is_hr_plus - the company's HR
    contact, an administrator / owner, a Full HR grant, in People scope): a
    manager's recommendation to finalize (Confirm / Extend: Approve inline,
    POST .../probation/approve, which also sends the letter; Decline with a
    note; End Employment opens the profile, where the Offboard flow starts),
    and a probation past its end date with no decision (opens the profile)."""
    import hr_probation as hp
    if not _hr_anywhere(db, user):
        return []
    E = models.NexusEmployee
    today = hp._today()
    out = []
    for emp in db.query(E).filter(E.status.in_(("active", "onboarding")), E.probation.isnot(None)).all():
        rec = hp.record(emp)
        if rec.get("status") not in hp.OPEN:
            continue
        pending = rec.get("pending") or {}
        end = hp._parse(rec.get("endDate", ""))
        overdue = end is not None and end < today
        if not (pending or overdue) or not hp.is_hr_plus(db, user, emp):
            continue
        name = hp.full_name(emp)
        link = {"view": "hr", "sub": f"hr-probation-{emp.id}"}
        if pending:
            what = hp.DECISION_LABELS.get(pending.get("decision"), "")
            to = f" To {_us_day(pending['newEndDate'])}" if pending.get("newEndDate") else ""
            reason = _short(pending.get("reason") or "")
            simple = pending.get("decision") in ("confirm", "extend")
            out.append(row("probation", emp.id, person_email=emp.work_email or "", person_name=name,
                           title=f"Probation - {what}{to}",
                           detail=f"Recommended by {_name(db, ctx, pending.get('by', ''))}" + (f": {reason}" if reason else "."),
                           created_at=pending.get("at"),
                           actions=(A_APPROVE, A_DECLINE_WHY) if simple else (a_open("Review"),), link=link))
        else:
            out.append(row("probation_due", emp.id, person_email=emp.work_email or "", person_name=name,
                           title=f"Probation Ended {_us_day(end.isoformat())} - Decide",
                           detail="Confirm, extend or end their employment on their profile.",
                           created_at=f"{end.isoformat()}T00:00:00", actions=(a_open("Decide"),), link=link))
    return out


@source("hr_letter", "HR Letters", "people")
def _hr_letters(db: Session, user: dict, ctx: dict) -> list:
    """Letters employees requested that wait on HR for their company
    (hr_letters.hr_companies - the GET /letter-requests/queue rule), Requested
    or In Review. Issuing means reading the letter first, so Review opens the
    HR Letters card; Decline (a reason is required) runs inline."""
    import hr_letters as hl
    comps = hl.hr_companies(db, user)
    if comps is not None and not comps:
        return []
    R = models.HrLetterRequest
    q = db.query(R).filter(R.status.in_(("requested", "in_review")))
    if comps is not None:
        q = q.filter(R.company_id.in_(sorted(comps)))
    me = _me(user)
    out = []
    for r in q.order_by(R.created_at).limit(200).all():
        if (r.employee_email or "").lower() == me:
            continue
        bits = [b for b in (f"Needed by {_us_day(r.needed_by)}" if r.needed_by else "", _short(r.purpose or "", 100)) if b]
        out.append(row("hr_letter", r.id, person_email=r.employee_email or "",
                       person_name=r.employee_name or _name(db, ctx, r.employee_email),
                       title=f"HR Letter - {hl.type_label(r.letter_type)}", detail=" - ".join(bits),
                       created_at=r.created_at, actions=(a_open("Review"), A_DECLINE_WHY),
                       link=dict(hl._HR_ACTION)))
    return out


@source("headcount", "Headcount Requests", "hiring")
def _headcount(db: Session, user: dict, ctx: dict) -> list:
    """Headcount requests waiting on the caller (routers/hiring._can_decide):
    the department line's step, then HR's. Approve / Decline (a reason is
    required) through POST /hiring/headcount/{id}/decide."""
    from routers.hiring import _can_decide
    H = models.HrHeadcountRequest
    out = []
    for r in db.query(H).filter(H.status == "awaiting_approval").order_by(H.submitted_at).all():
        if not _can_decide(db, user, r):
            continue
        n = int(r.openings or 1)
        step = "Department approval" if r.step == "department" else "HR approval - the department approved it"
        where = " - ".join(b for b in (r.department or "", r.location or "") if b)
        out.append(row("headcount", r.id, person_email=r.requested_by or "", person_name=_name(db, ctx, r.requested_by),
                       title=f"Headcount Request - {r.role_title or 'New Role'}" + (f" ({n})" if n > 1 else ""),
                       detail=f"{step}." + (f" {where}." if where else ""),
                       created_at=r.submitted_at or r.created_at, actions=(A_APPROVE, A_DECLINE_WHY),
                       link={"view": "shifts", "sub": "headcount"}))
    return out


@source("extra_time", "Extra Time", "timesheets")
def _extra_time(db: Session, user: dict, ctx: dict) -> list:
    """India Contractor Extra Time claims waiting on the caller as a named
    approver (routers/extra_time.waiting_on - the company's HR contact, else
    the Global Admins; never their own). Approve takes every hour claimed
    (POST /extra-time/claims/{id}/decide - the server checks the day's
    limit); approving FEWER hours is done on People > Time > Extra Time, which
    Review opens. Decline needs a reason the contractor sees."""
    from routers.extra_time import _hm, waiting_on
    out = []
    for c in waiting_on(db, _me(user)):
        out.append(row("extra_time", c["id"], person_email=c["employeeEmail"], person_name=c.get("name") or "",
                       title=f"Extra Time - {_us_day(c['date'])} ({_hm(c['claimedMin'])})",
                       detail=_short(c.get("note") or ""), created_at=c.get("createdAt"),
                       actions=(A_APPROVE, A_DECLINE_WHY, a_open("Review")),
                       link={"view": "hr", "sub": "hr-time-extra"}))
    return out
