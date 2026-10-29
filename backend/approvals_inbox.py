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
recommendations (past the end with none: passed by itself), HR letter requests, headcount
requests and India Contractor Extra Time claims - each the module's own
rule, decided through its own endpoint.

The rest (Oct 28 2026, "make sure all approvals go into that approval box"):
task approvals, ticket approvals, item checkouts / extensions / assignments /
returns, Tasks team and member requests, role changes, vendor and customer
changes, Credential Vault share requests, Knowledge Base reviews, construction
daily logs and HR packets to verify.

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
        created_at="", actions=(), link: dict | None = None, count: int = 1, for_name: str = "",
        facts=(), priority: str = "", due: str = "") -> dict:
    """One inbox line, the same shape for every source.

    `facts` (Neil, 10/28/2026: Review "gives them additional detail") are
    ("Label", "value") pairs the row's Review panel lists in full - the
    reason, the amount, the dates - where `detail` is one shortened line.
    Empty values are dropped, so a source can pass what it has.

    `priority` (Neil, 10/28/2026: "allow a sort by priority") is the
    module's own urgent / high / medium / low where it has one (a task, a
    ticket); `due` is the day the decision matters by (leave starts, a
    document expires, a letter is needed). collect() turns what is missing
    into one priority for every row - see _priority."""
    return {"key": f"{kind}:{rid}", "kind": kind, "id": rid,
            "priority": (priority or "").strip().lower(), "due": (due or "")[:10],
            "person": {"email": (person_email or "").lower(), "name": person_name or person_email or ""},
            "title": title, "detail": detail or "", "createdAt": _iso(created_at),
            "actions": [dict(a) for a in actions], "link": link or {}, "count": max(1, int(count or 1)),
            "forName": for_name or "",
            "facts": [{"label": str(k), "value": str(v).strip()} for k, v in facts
                      if v not in (None, "") and str(v).strip()]}


PRIORITIES = ("urgent", "high", "medium", "low")   # the Tasks scale, most pressing first


def _priority(r: dict, today: date | None = None) -> str:
    """One priority per row: the higher of the module's own (a task's, a
    ticket's) and what the dates say - the day it matters by passed or is
    tomorrow = Urgent, within 3 days = High; waiting a week or more = High.
    Everything else is Medium; a module's Low stays Low unless a date
    raises it."""
    today = today or datetime.now(timezone.utc).date()
    own = r.get("priority") if r.get("priority") in PRIORITIES else ""
    rank = {p: i for i, p in enumerate(PRIORITIES)}
    best = rank.get(own, rank["medium"])
    try:
        left = (date.fromisoformat(r.get("due") or "") - today).days
    except ValueError:
        left = None
    if left is not None:
        best = min(best, rank["urgent"] if left <= 1 else rank["high"] if left <= 3 else best)
    try:
        waited = (today - datetime.fromisoformat(r["createdAt"]).date()).days if r.get("createdAt") else 0
    except ValueError:
        waited = 0
    if waited >= 7:
        best = min(best, rank["high"])
    return PRIORITIES[best]


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
            r["priority"] = _priority(r)
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
               for_name=t.get("forName") or "", due=t.get("startDate") or "",
               facts=(("Type", kind), ("Dates", span), ("Days", str(days) if days else ""),
                      ("Note", "" if t.get("redacted") else t.get("note") or ""),
                      ("First Approval", (t.get("firstApproverName") or t.get("firstApprover") or "") if hr else "")))


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
                       for_name=r.get("forName") or "",
                       facts=(("Day", day),
                              ("Punch", (f"{_KIND_WORD.get(r['punchKind'], r['punchKind'])} at {_clock(r['at'], r.get('timeZone') or '')}"
                                         if r["action"] == "add" else "Remove a punch")),
                              ("Reason", r.get("reason") or ""))))
    for p in list_pending_punch_edits(user=u, db=db):
        off = int(p.get("tzOffsetMin") or 0)
        title = (f"Punch Edit - {_us_day(p.get('localDate') or '')} {_KIND_WORD.get(p['kind'], p['kind'])} "
                 f"{_clock(p['at'], offset_min=off)} to {_clock(p['pendingAt'], offset_min=off)}")
        out.append(row("punch_edit", p["id"], person_email=p["email"], person_name=p.get("employeeName") or "",
                       title=title, detail=_short(p.get("editReason") or ""), created_at=p.get("editedAt"),
                       actions=(A_APPROVE, A_REJECT), link={"view": "hr", "sub": "hr-time"},
                       for_name=p.get("forName") or "",
                       facts=(("Day", _us_day(p.get("localDate") or "")),
                              ("Punch", _KIND_WORD.get(p["kind"], p["kind"])),
                              ("From", _clock(p["at"], offset_min=off)), ("To", _clock(p["pendingAt"], offset_min=off)),
                              ("Reason", p.get("editReason") or ""))))
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
                       actions=(a_open("Review"),), link=link, count=len(rs), for_name=for_name,
                       facts=(("Pay Period", span),
                              ("People", ", ".join(sorted(tsr.display_name(db, r.employee_email) for r in rs))
                               if len(rs) > 1 else ""))))
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
                       link={"view": "myhr", "sub": "timesheet"},
                       facts=(("Pay Period", span), ("Approved By", s.get("agreedBy") or ""))))
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
                       link={"view": "myhr", "sub": f"sign:{r['partyId']}"}, due=r.get("expiresOn") or "",
                       facts=(("Document", r.get("title") or ""),
                              ("Sent By", _name(db, ctx, sender) if sender else ""),
                              ("Expires", _us_day(r["expiresOn"]) if r.get("expiresOn") else ""))))
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
                       link={"view": "myhr", "sub": "reimbursements"},
                       facts=(("Amount", _money(float(r.amount or 0), r.currency or "USD")), ("For", r.item or ""),
                              ("Receipts", str(n) if n else "None attached"),
                              ("Approved By", _name(db, ctx, r.approved_by or r.approver_email) if step != "approver" else ""),
                              ("Step", "Your approval" if step == "approver" else "HR, after the approver"))))
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
                       link={"view": "myhr", "sub": "purchase"},
                       facts=(("Item", r.item or ""), ("Quantity", str(qty)), ("Reason", r.reason or ""))))
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
                       link={"view": "shifts", "sub": "requests"},
                       facts=(("Request", _shift_title(db, ctx, r)),
                              ("Teammate", _name(db, ctx, r.target_email) if r.target_email else ""),
                              ("Note", r.note or ""))))
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
                       link={"view": "myhr", "sub": "timeoff"},
                       facts=(("Request", _shift_title(db, ctx, r, mine=True)), ("Note", r.note or ""),
                              ("Next", "A manager approves it after you accept."))))
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
                       link={"view": "tasks", "sub": "mine", "taskId": t.id},
                       facts=(("Candidate", name), ("Role", role),
                              ("Votes So Far", str(sum(1 for v in s["votes"] if v.get("vote")))),
                              ("Final Call", "You" if final else _name(db, ctx, s["decider"]) if s.get("decider") else ""))))
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
                       link={"view": "tasks", "sub": "mine", "taskId": t.id},
                       facts=(("Candidate", name), ("Role", role), ("Due", _us_day(t.due_on) if t.due_on else ""))))
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
    reference, so it opens the person's Time Sheet, whose Salary Advances
    panel has it - Oct 29 2026)."""
    import salary_advance as sa
    if not _hr_anywhere(db, user):
        return []
    out = []
    for adv in sa.pending_for_hr(db, user):
        # An advance's amount is pay (sa.sees_pay); pending_for_hr already
        # keeps only what the caller can decide, which needs the pay grant.
        money = sa.money(adv.amount, adv.currency or "USD") if sa.sees_pay(db, user, adv.employee_email) else ""
        n = int(adv.installments or 1)
        link = sa.timesheet_link(adv.employee_email)
        who = adv.employee_name or _name(db, ctx, adv.employee_email)
        if adv.status == "requested":
            out.append(row("salary_advance", adv.id, person_email=adv.employee_email, person_name=who,
                           title=(f"Salary Advance - {money} ({_plural(n, 'pay period')})" if money
                                  else f"Salary Advance ({_plural(n, 'pay period')})"),
                           detail=_short(adv.reason or ""), created_at=adv.requested_at or adv.created_at,
                           actions=(A_APPROVE, A_DECLINE_WHY), link=link,
                           facts=(("Amount", money), ("Repaid Over", _plural(n, "pay period")), ("Reason", adv.reason or ""))))
        else:
            out.append(row("salary_advance_payout", adv.id, person_email=adv.employee_email, person_name=who,
                           title=f"Pay Out Salary Advance - {money}" if money else "Pay Out Salary Advance",
                           detail=f"Approved by {_name(db, ctx, adv.decided_by)}. Mark it Paid Out once it is paid.",
                           created_at=adv.decided_at or adv.updated_at, actions=(a_open("Pay Out"),), link=link,
                           facts=(("Amount", money), ("Repaid Over", _plural(n, "pay period")),
                                  ("Approved By", _name(db, ctx, adv.decided_by)), ("Reason", adv.reason or ""))))
    return out


@source("probation", "Probation", "people")
def _probation(db: Session, user: dict, ctx: dict) -> list:
    """Probation waiting on HR (hr_probation.is_hr_plus - the company's HR
    contact, an administrator / owner, a Full HR grant, in People scope): a
    manager's recommendation to finalize (Confirm / Extend: Approve inline,
    POST .../probation/approve, which also sends the letter; Decline with a
    note; End Employment opens the profile, where the Offboard flow starts).
    A probation past its end with nothing pending is no decision for HR any
    more: the daily pass makes it Passed Probation (Neil, Oct 29 2026), so
    only a recommendation - before or past the end - is a row here."""
    import hr_probation as hp
    if not _hr_anywhere(db, user):
        return []
    E = models.NexusEmployee
    out = []
    for emp in db.query(E).filter(E.status.in_(("active", "onboarding")), E.probation.isnot(None)).all():
        rec = hp.record(emp)
        if rec.get("status") not in hp.OPEN:
            continue
        pending = rec.get("pending") or {}
        if not pending or not hp.is_hr_plus(db, user, emp):
            continue
        name = hp.full_name(emp)
        link = {"view": "hr", "sub": f"hr-probation-{emp.id}"}
        what = hp.DECISION_LABELS.get(pending.get("decision"), "")
        to = f" To {_us_day(pending['newEndDate'])}" if pending.get("newEndDate") else ""
        reason = _short(pending.get("reason") or "")
        simple = pending.get("decision") in ("confirm", "extend")
        out.append(row("probation", emp.id, person_email=emp.work_email or "", person_name=name,
                       title=f"Probation - {what}{to}",
                       detail=f"Recommended by {_name(db, ctx, pending.get('by', ''))}" + (f": {reason}" if reason else "."),
                       created_at=pending.get("at"),
                       actions=(A_APPROVE, A_DECLINE_WHY) if simple else (a_open("Review"),), link=link,
                       facts=(("Recommendation", what), ("New End Date", _us_day(pending["newEndDate"]) if pending.get("newEndDate") else ""),
                              ("Probation Ends", _us_day(rec.get("endDate") or "") if rec.get("endDate") else ""),
                              ("Recommended By", _name(db, ctx, pending.get("by", ""))), ("Reason", pending.get("reason") or ""))))
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
                       link=dict(hl._HR_ACTION), due=r.needed_by or "",
                       facts=(("Letter", hl.type_label(r.letter_type)),
                              ("Needed By", _us_day(r.needed_by) if r.needed_by else ""), ("Purpose", r.purpose or ""))))
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
                       link={"view": "shifts", "sub": "headcount"},
                       facts=(("Role", r.role_title or ""), ("Openings", str(n)), ("Department", r.department or ""),
                              ("Location", r.location or ""), ("Target Start", _us_day(r.target_start) if r.target_start else ""),
                              ("Step", step), ("Justification", r.justification or ""))))
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
                       link={"view": "hr", "sub": "hr-time-extra"},
                       facts=(("Day", _us_day(c["date"])), ("Hours Claimed", _hm(c["claimedMin"])), ("Note", c.get("note") or ""))))
    return out


# ── Everything else that waits on a decision (Neil, 10/28/2026: "make sure
# all approvals go into that approval box") ──────────────────────────────────
# Each one is the module's own "waiting on me" rule, decided through the
# module's own endpoint (frontend/src/lib/approvalActions.js). A step that
# needs more than a note - an allocator to pick, a return photo to look at, a
# code to enter, a page or a log to read, a packet to check - opens the
# module instead.

GROUPS.append(("work", "Work"))
GROUPS.append(("equipment", "Equipment"))
GROUPS.append(("access", "Access"))

# Decisions the module takes without a note.
A_REJECT_PLAIN = {"key": "reject", "label": "Reject", "tone": "plain", "note": "none"}
A_REJECT_WHY = {"key": "reject", "label": "Reject", "tone": "plain", "note": "required"}
A_DENY = {"key": "deny", "label": "Deny", "tone": "plain", "note": "none"}
A_CHANGES = {"key": "changes", "label": "Request Changes", "tone": "plain", "note": "none"}
A_SEND_BACK_PLAIN = {"key": "send_back", "label": "Send Back", "tone": "plain", "note": "none"}


def _text(html: str) -> str:
    """A rich-text field (task / ticket description) as plain words."""
    from audit_capture import html_to_text
    return html_to_text(html or "") if "<" in (html or "") else (html or "").strip()


def _tasks_family(user: dict, db: Session) -> dict:
    """The Tasks routers' own dependencies, in their order: a Tasks or
    Tickets grant (require_any_module_grant), then a Tasks Owner counting as
    a manager inside the module (module_owner_acts_as). Raises 403 for
    someone who cannot open Tasks at all."""
    from auth import module_owner_acts_as, require_any_module_grant
    u = require_any_module_grant("tasks", "tickets")(user={**user}, db=db)
    return module_owner_acts_as("tasks", 3)(user=u, db=db)


@source("task_approval", "Task Approvals", "work")
def _task_approvals(db: Session, user: dict, ctx: dict) -> list:
    """Approval tasks waiting on the caller as an assignee (the Daily
    Briefing's rule, daily_briefing._red_rows: type "approval", approval
    pending, the caller among task_util.task_assignees). Decided the way the
    task drawer's Approval block does it - PATCH /tasks/{id} with the new
    approval_status, no note."""
    from routers.task_util import task_assignees
    me = _me(user)
    T = models.Task
    rows = [t for t in db.query(T).filter(T.type == "approval", T.approval_status == "pending",
                                          or_(T.deleted_at == "", T.deleted_at.is_(None))).all()
            if me in task_assignees(t)]
    if not rows:
        return []
    _tasks_family(user, db)
    out = []
    for t in rows:
        asker = (t.created_by or t.owner_email or "").lower()
        out.append(row("task_approval", t.id, person_email=asker, person_name=_name(db, ctx, asker) if asker else "",
                       title=f"Task Approval - {t.title or 'Untitled Task'}",
                       detail=_short(_text(t.description)) or (f"Due {_us_day(t.due_on)}." if t.due_on else ""),
                       created_at=t.created_at, actions=(A_APPROVE, A_CHANGES, A_REJECT_PLAIN),
                       priority=t.priority or "", due=t.due_on or "",
                       link={"view": "tasks", "sub": "mine", "taskId": t.id},
                       facts=(("Task", t.title or ""), ("Due", _us_day(t.due_on) if t.due_on else ""),
                              ("Created By", _name(db, ctx, asker) if asker else ""),
                              ("Description", _short(_text(t.description), 600)))))
    return out


@source("task_date_ask", "Due Date Requests", "work")
def _task_date_asks(db: Session, user: dict, ctx: dict) -> list:
    """Due-date asks put to the caller (task_due, Oct 13 / 21 2026 - the
    people the module's bell goes to, the Updates card's date_ask_for_me):
    an extension held for approval, where the caller is one of the
    proposal's approvers (the requester, an assignee's manager); or a new
    date an assignee proposed, where the caller asked for the work
    (task_due.requester_of). Never the caller's own ask, and never an
    extension on their own task unless they are a manager (respond_due
    refuses it). Approve / Decline with an optional note through POST
    /tasks/{id}/due/respond; suggesting a third date is on the task."""
    import task_due
    from routers.task_util import task_assignees
    me = _me(user)
    if not me:
        return []
    T = models.Task
    cands = []
    for t in (db.query(T).filter(T.due_agreement.in_((task_due.REQUESTED, "proposed")),
                                 or_(T.deleted_at == "", T.deleted_at.is_(None))).all()):
        p = t.due_proposal if isinstance(t.due_proposal, dict) else None
        if not p or (p.get("by") or "").lower() == me:
            continue
        ext = t.due_agreement == task_due.REQUESTED
        if ext and me not in [(x or "").lower() for x in (p.get("approvers") or [])]:
            continue
        if not ext and task_due.requester_of(t) != me:
            continue
        cands.append((t, p, ext))
    if not cands:
        return []
    u = _tasks_family(user, db)
    from routers.tasks import _wall_task
    out = []
    for t, p, ext in cands:
        if ext and me in task_assignees(t) and int(u.get("level", 0)) < 3:
            continue
        try:
            _wall_task(db, u, t.id)
        except HTTPException:
            continue
        asker = (p.get("by") or "").lower()
        now, wanted = _us_day(t.due_on or ""), _us_day(p.get("dueOn") or "")
        why = task_due.extension_reason(int(p.get("number") or 0), bool(p.get("overMonth")), p.get("baseline") or "") if ext else ""
        why = why[:1].upper() + why[1:]
        out.append(row("task_date_ask", t.id, person_email=asker, person_name=_name(db, ctx, asker) if asker else "",
                       title=(f"Due Date Extension - {t.title or 'Task'}" if ext else f"New Due Date - {t.title or 'Task'}"),
                       detail=f"{now or 'No date'} to {wanted}" + (f" - {_short(p.get('note'), 100)}" if p.get("note") else ""),
                       created_at=p.get("at") or t.modified_at, actions=(A_APPROVE, A_DECLINE),
                       priority=t.priority or "", due=t.due_on or "",
                       link={"view": "tasks", "sub": "mine", "taskId": t.id},
                       facts=(("Task", t.title or ""), ("Current Due Date", now or "None"), ("Asked For", wanted),
                              ("Asked By", _name(db, ctx, asker) if asker else ""),
                              ("Reason", p.get("note") or ""), ("Why It Needs Approval", why),
                              ("Start Date Moves To", _us_day(p["startOn"]) if p.get("startOn") else ""))))
    return out


@source("ticket_approval", "Ticket Approvals", "work")
def _ticket_approvals(db: Session, user: dict, ctx: dict) -> list:
    """Tickets whose named approver is the caller (the Daily Briefing's rule,
    daily_briefing._ticket_action_rows), inside the caller's company wall -
    decide_approval 404s on another company's ticket. A confidential HR
    ticket stays hidden (no include_confidential opt-in): decide_approval
    cannot load it either. Approve takes an optional note; a reject needs a
    reason (POST /task-tickets/{id}/approval)."""
    import auth
    import ticket_notify
    from ticket_code import display_number
    me = _me(user)
    T = models.TaskTicket
    rows = (db.query(T).filter(T.approval_status == "pending", func.lower(T.approver_email) == me)
            .order_by(T.created_at).all())
    if not rows:
        return []
    scope = auth.company_scope(user, db)
    # The approver's notice sends someone off the desk to Support, which
    # opens the same ticket (tickets.request_approval).
    view = "tickets" if ticket_notify.on_desk(db, me) else "support"
    out = []
    for t in rows:
        if not auth.company_ok(t.company_id or "", scope):
            continue
        num = display_number(t.code)
        who = (t.requester_email or "").lower()
        out.append(row("ticket_approval", t.id, person_email=who, person_name=_name(db, ctx, who) if who else "",
                       title=f"Ticket Approval - {'#' + num + ' ' if num else ''}{t.subject or 'Ticket'}",
                       detail=_short(_text(t.description)), created_at=t.created_at,
                       actions=(A_APPROVE, A_REJECT_WHY), priority=t.priority or "",
                       link={"view": view, "ticketId": t.id},
                       facts=(("Ticket", f"#{num}" if num else ""), ("Subject", t.subject or ""),
                              ("Type", (t.type or "").replace("_", " ").title()),
                              ("Priority", (t.priority or "").title()),
                              ("Requested By", _name(db, ctx, who) if who else ""),
                              ("Description", _short(_text(t.description), 600)))))
    return out


# ── Equipment (Item Management, routers/items.py - read, never edited) ───────

def _items_manager(db: Session, user: dict, ctx: dict) -> bool:
    if "items_mgr" not in ctx:
        from routers.items import _is_items_manager
        ctx["items_mgr"] = bool(_me(user)) and not user.get("external") and _is_items_manager(user, db)
    return ctx["items_mgr"]


@source("item_checkout", "Checkout Requests", "equipment")
def _item_checkouts(db: Session, user: dict, ctx: dict) -> list:
    """Checkout requests waiting for an items manager (update_checkout's
    approve gate, _is_items_manager): sent to the caller, or to no one in
    particular (an empty approver reaches every manager). ONE row per order,
    the way the bell shows it, never the caller's own. Approving picks who
    allocates the items, so Review opens Item Management > Checkouts."""
    if not _items_manager(db, user, ctx):
        return []
    me = _me(user)
    C = models.ItemCheckout
    rows = (db.query(C).filter(C.status == "pending",
                               or_(func.lower(C.approver_email) == me, C.approver_email == "", C.approver_email.is_(None)))
            .order_by(C.created_at).all())
    orders: dict = {}
    for c in rows:
        if (c.requested_by_email or "").lower() == me:
            continue
        orders.setdefault(c.order_id or c.id, []).append(c)
    out = []
    for oid, cs in orders.items():
        first = cs[0]
        names = [c.item_name for c in cs]
        days = sorted({int(c.days or 1) for c in cs})
        title = (f"Checkout Request - {first.item_name}" if len(cs) == 1
                 else f"Checkout Request - {first.item_name} and {_plural(len(cs) - 1, 'more item')}")
        who = (first.requested_by_email or "").lower()
        out.append(row("item_checkout", oid, person_email=who, person_name=first.requested_by or _name(db, ctx, who),
                       title=title, detail=_short(first.reason or ""), created_at=first.created_at,
                       actions=(a_open("Review"),), link={"view": "inventory", "sub": "checkouts"}, count=len(cs),
                       facts=(("Items", ", ".join(names)),
                              ("Days", ", ".join(str(d) for d in days)),
                              ("Reason", first.reason or ""), ("Department", first.department or ""),
                              ("Requested For", first.raised_by if (first.raised_by or "") != (first.requested_by or "") else ""),
                              ("Next", "Approving asks who allocates the items."))))
    return out


@source("item_extension", "Checkout Extensions", "equipment")
def _item_extensions(db: Session, user: dict, ctx: dict) -> list:
    """More days asked for on an item in use (resolve_extension's gate: an
    items manager), never the caller's own. Approve / Reject with an optional
    note through POST /items/checkouts/{id}/extension/resolve. The ask keeps
    no time of its own, so the row is dated by the checkout."""
    if not _items_manager(db, user, ctx):
        return []
    me = _me(user)
    C = models.ItemCheckout
    out = []
    for c in db.query(C).filter(C.extension_status == "pending").order_by(C.created_at).all():
        if (c.requested_by_email or "").lower() == me:
            continue
        n = int(c.extension_days or 0)
        who = (c.requested_by_email or "").lower()
        out.append(row("item_extension", c.id, person_email=who, person_name=c.requested_by or _name(db, ctx, who),
                       title=f"Checkout Extension - {c.item_name} (+{_plural(n, 'day')})",
                       detail=_short(c.extension_reason or ""), created_at=c.allocated_at or c.created_at,
                       actions=(A_APPROVE, A_REJECT), link={"view": "inventory", "sub": "checkouts"},
                       facts=(("Item", c.item_name or ""), ("More Days", str(n)),
                              ("Checked Out For", _plural(int(c.days or 1), "day")),
                              ("Reason", c.extension_reason or ""))))
    return out


@source("assignment_accept", "Items Assigned To You", "equipment")
def _assignments_to_accept(db: Session, user: dict, ctx: dict) -> list:
    """Items assigned to the caller to accept (accept_assignment: only the
    assignee). The photo is optional on acceptance (Neil, Jul 17), so Accept
    runs inline; Decline takes an optional note."""
    me = _me(user)
    if not me:
        return []
    A = models.ItemAssignment
    out = []
    for a in (db.query(A).filter(A.status == "pending_acceptance", func.lower(A.assignee_email) == me)
              .order_by(A.created_at).all()):
        by = (a.assigned_by_email or "").lower()
        out.append(row("assignment_accept", a.id, person_email=by, person_name=a.assigned_by or _name(db, ctx, by),
                       title=f"Accept Item - {a.item_name or 'Item'}",
                       detail=f"Assigned to you by {a.assigned_by or _name(db, ctx, by)}." if (a.assigned_by or by) else "",
                       created_at=a.created_at, actions=(A_ACCEPT, A_DECLINE),
                       link={"view": "inventory", "sub": "permanent"},
                       facts=(("Item", a.item_name or ""), ("Assigned By", a.assigned_by or (_name(db, ctx, by) if by else "")),
                              ("Next", "It becomes yours to look after once you accept."))))
    return out


_RETURN_WORD = {"normal": "Normal Return", "dead": "Item Dead", "lost": "Item Lost", "reassign": "Reassignment"}


@source("assignment_return", "Item Returns", "equipment")
def _assignment_returns(db: Session, user: dict, ctx: dict) -> list:
    """Permanent-item returns waiting for an items manager to accept (the
    Checkouts > Assignments "Returns to Accept" list), never the caller's own.
    Accepting puts the item back in stock or retires it after a look at the
    return photo, so Review opens that list."""
    if not _items_manager(db, user, ctx):
        return []
    me = _me(user)
    A = models.ItemAssignment
    out = []
    for a in db.query(A).filter(A.status == "return_initiated").order_by(A.return_initiated_at).all():
        if (a.assignee_email or "").lower() == me:
            continue
        why = _RETURN_WORD.get(a.return_reason or "normal", (a.return_reason or "").title())
        who = (a.assignee_email or "").lower()
        out.append(row("assignment_return", a.id, person_email=who, person_name=a.assignee_name or _name(db, ctx, who),
                       title=f"Item Return - {a.item_name or 'Item'}" + (f" ({why})" if a.return_reason not in ("", "normal", None) else ""),
                       detail=_short(a.return_note or ""), created_at=a.return_initiated_at or a.created_at,
                       actions=(a_open("Review"),), link={"view": "inventory", "sub": "assignment-returns"},
                       facts=(("Item", a.item_name or ""), ("Reason", why), ("Note", a.return_note or ""),
                              ("Photo", "Attached" if a.return_photo_url else ("None (lost)" if a.return_reason == "lost" else "None")),
                              ("Next Assignee", a.next_assignee_name or a.next_assignee_email or ""))))
    return out


# ── Tasks > Teams (routers/task_projects.py) ─────────────────────────────────

@source("task_member_request", "Team Member Requests", "work")
def _task_member_requests(db: Session, user: dict, ctx: dict) -> list:
    """Requests to add someone to a team or take them off (decide_member
    _request: administrators only), from the same list route the Teams screen
    reads (its company wall included), never the caller's own ask."""
    if int(user.get("level", 0)) < 4:
        return []
    from routers.task_projects import list_member_requests
    u = _tasks_family(user, db)
    me = _me(user)
    pending = [m for m in list_member_requests(user=u, db=db)
               if m.get("status") == "pending" and (m.get("requestedById") or "").lower() != me]
    if not pending:
        return []
    teams = {t.id: t.name for t in db.query(models.TaskTeam.id, models.TaskTeam.name)
             .filter(models.TaskTeam.id.in_(sorted({m["teamId"] for m in pending}))).all()}
    out = []
    for m in pending:
        who = (m.get("userId") or "").lower()
        team = teams.get(m["teamId"]) or "a team"
        remove = m.get("kind") == "remove"
        asker = (m.get("requestedById") or "").lower()
        out.append(row("task_member_request", m["id"], person_email=asker, person_name=_name(db, ctx, asker) if asker else "",
                       title=f"{'Remove From' if remove else 'Add To'} Team - {_name(db, ctx, who)} ({team})",
                       detail=f"{'Take' if remove else 'Add'} {_name(db, ctx, who)} {'off' if remove else 'to'} {team}.",
                       created_at=m.get("createdAt"), actions=(A_APPROVE, A_DENY), link={"view": "tasks", "sub": "teams"},
                       facts=(("Team", team), ("Person", _name(db, ctx, who)), ("Change", "Remove" if remove else "Add"),
                              ("Requested By", _name(db, ctx, asker) if asker else ""))))
    return out


@source("task_team_approval", "Team Approvals", "work")
def _task_team_approvals(db: Session, user: dict, ctx: dict) -> list:
    """Personal teams their creators asked to make workspace teams
    (decide_team_approval: require_manager inside the Tasks routers, where a
    Tasks Owner counts as a manager), from list_teams, never the caller's own
    team. Send Back leaves it the creator's personal team - no note."""
    u = _tasks_family(user, db)
    if int(u.get("level", 0)) < 3:
        return []
    from routers.task_projects import list_teams
    me = _me(user)
    out = []
    for t in list_teams(user=u, db=db):
        if t.get("approvalStatus") != "pending" or (t.get("createdById") or "").lower() == me:
            continue
        by = (t.get("createdById") or "").lower()
        n = len(t.get("memberIds") or [])
        out.append(row("task_team_approval", t["id"], person_email=by, person_name=_name(db, ctx, by) if by else "",
                       title=f"Team Approval - {t.get('name') or 'Team'}",
                       detail=f"{_plural(n, 'member')}, {_plural(len(t.get('projectIds') or []), 'project')}. "
                              "Approving makes it a workspace team.",
                       created_at=t.get("requestedAt") or t.get("createdAt"),
                       actions=(A_APPROVE, A_SEND_BACK_PLAIN), link={"view": "tasks", "sub": "teams"},
                       facts=(("Team", t.get("name") or ""), ("Members", str(n)),
                              ("Projects", str(len(t.get("projectIds") or []))),
                              ("Created By", _name(db, ctx, by) if by else ""),
                              ("Send Back", "It stays the creator's personal team."))))
    return out


# ── People: role changes (routers/hr_life_events.py, role_change.py) ─────────

@source("role_change", "Role Changes", "people")
def _role_changes(db: Session, user: dict, ctx: dict) -> list:
    """Role change requests from before Oct 22 still pending: the People
    list route's rows the caller can decide (canDecide = role_change
    .can_change_roles), never one about the caller (decide refuses it).
    Approve / Decline (an optional note) through the request's own routes."""
    import role_change as rc
    if not rc.can_change_roles(db, user):
        return []
    from routers.hr_life_events import list_role_change_requests
    me = _me(user)
    out = []
    for r in list_role_change_requests(employee_id="", email="", user=user, db=db):
        if not r.get("canDecide") or (r.get("employeeEmail") or "").lower() == me:
            continue
        asker = r.get("requestedByName") or _name(db, ctx, r.get("requestedBy") or "")
        out.append(row("role_change", r["id"], person_email=r.get("employeeEmail") or "",
                       person_name=r.get("employeeName") or "",
                       title=f"Role Change - {r.get('toRoleName') or 'New Role'}",
                       detail=_short(r.get("reason") or ""), created_at=r.get("createdAt"),
                       actions=(A_APPROVE, A_DECLINE), link={"view": "hr", "sub": rc.deep_link_sub(r["id"])},
                       facts=(("From", r.get("fromTitle") or ""), ("To", r.get("toRoleName") or ""),
                              ("Reason", r.get("reason") or ""), ("Requested By", asker))))
    return out


# ── Money: vendor and customer changes (routers/accounting_partners.py) ──────

_PARTNER_FIELDS = {"displayName": "Print As", "name": "Name", "email": "Email", "phone": "Phone",
                   "address.line1": "Address Line 1", "address.line2": "Address Line 2", "address.city": "City",
                   "address.state": "State", "address.zip": "ZIP", "address.country": "Country",
                   "terms": "Terms", "status": "Status", "taxId": "Tax ID"}


@source("accounting_partner_change", "Vendor And Customer Changes", "money")
def _partner_changes(db: Session, user: dict, ctx: dict) -> list:
    """Vendor / customer change requests to approve (the decide routes'
    _decide: a manager who holds the Accounting grant, or its Full level),
    never the caller's own. Only for a caller with NO entity limit
    (entity_scope's allowed is None): the Accounting screen holds a limited
    person to the partners of their entities, which needs the Intacct records
    - too slow to poll - so they decide on that screen. Approve / Decline
    (an optional note) through POST /accounting/partners/changes/{id}/..."""
    from auth import require_module_grant
    from routers.accounting import entity_scope
    from routers.accounting_partners import _decide
    _decide(user={**user}, db=db)
    scope = entity_scope(user=require_module_grant("accounting", "viewer")(user={**user}, db=db), db=db)
    if scope["allowed"] is not None:
        return []
    me = _me(user)
    P = models.AccountingPartnerChange
    out = []
    for r in db.query(P).filter(P.status == "pending").order_by(P.requested_at).limit(500).all():
        if (r.requested_by or "").lower() == me:
            continue
        label = "Vendor" if r.kind == "vendor" else "Customer"
        changes = r.changes if isinstance(r.changes, dict) else {}
        names = [_PARTNER_FIELDS.get(f, f) for f in changes]
        # The from -> to values are what the Accounting screen's requests list
        # shows the same (unlimited) people; the tax ID only ever by name.
        values = [(f"{_PARTNER_FIELDS.get(f, f)}", f"{(v or {}).get('from') or '(blank)'} to {(v or {}).get('to') or '(blank)'}")
                  for f, v in changes.items() if f != "taxId" and isinstance(v, dict)]
        who = (r.requested_by or "").lower()
        out.append(row("accounting_partner_change", r.id, person_email=who, person_name=_name(db, ctx, who) if who else "",
                       title=f"{label} Change - {r.partner_name or r.partner_id}",
                       detail=_short(", ".join(names)), created_at=r.requested_at,
                       actions=(A_APPROVE, A_DECLINE),
                       link={"view": "accounting", "sub": "partners" if r.kind == "vendor" else "customers"},
                       facts=((label, f"{r.partner_name or ''} ({r.partner_id})" if r.partner_id else r.partner_name or ""),
                              ("Fields", ", ".join(names)), *values, ("Note", r.note or ""))))
    return out


# ── Access: Credential Vault share requests (routers/credvault.py) ───────────

@source("credvault_request", "Credential Requests", "access")
def _credvault_requests(db: Session, user: dict, ctx: dict) -> list:
    """Share requests the caller may decide (credvault.list_requests: the
    credential's owner or backup owner, or an admin, inside the company
    wall), behind the vault's own grant. Approving goes through the vault's
    code step, so it opens Credential Vault > Approvals; Deny runs inline."""
    from auth import require_module_grant
    from routers.credvault import list_requests
    u = require_module_grant("credvault")(user={**user}, db=db)
    me = _me(user)
    out = []
    for r in list_requests(user=u, db=db):
        who = (r.get("requestedByEmail") or "").lower()
        if who == me:
            continue
        to = (r.get("sharedToEmail") or "").lower()
        when = (datetime.fromtimestamp(r["ts"] / 1000, tz=timezone.utc).isoformat() if r.get("ts") else "")
        out.append(row("credvault_request", r["id"], person_email=who, person_name=r.get("requestedBy") or "",
                       title=f"Credential Access - {r.get('cred') or 'Credential'} ({r.get('duration') or '1 Hour'})",
                       detail=f"For {_name(db, ctx, to)}." if to and to != who else "",
                       created_at=when, actions=(a_open("Review"), A_DENY),
                       link={"view": "credvault", "sub": "approvals"},
                       facts=(("Credential", r.get("cred") or ""), ("Department", r.get("dept") or ""),
                              ("Duration", r.get("duration") or ""),
                              ("Access For", _name(db, ctx, to) if to and to != who else ""))))
    return out


# ── Help Center: Knowledge Base reviews (routers/kb.py) ──────────────────────

@source("kb_review", "Page Reviews", "work")
def _kb_reviews(db: Session, user: dict, ctx: dict) -> list:
    """Pages and revisions waiting for the caller's approval (kb._review_queue
    - kb_access.can_approve: the named reviewer, the collection owner or a
    Knowledge Base manager, never the author) that were SENT to the caller:
    the named reviewer, else the collection's owner - the person the "Waiting
    for Your Review" bell goes to. Any manager may approve any page, but the
    queue in Help Center > Manage is where they do that; listing every page
    for every manager here would bury their own approvals. Reviewing means
    reading the page, so Review opens it."""
    import kb_access
    from routers.kb import _review_queue
    me = _me(user)
    if not me:
        return []
    D, R = models.KbDocument, models.KbRevision
    owned = {c.id for c in db.query(models.KbCollection.id).filter(func.lower(models.KbCollection.owner_email) == me).all()}
    pages = db.query(D.id, D.reviewer_email, D.collection_id).filter(D.status == "in_review").all()
    revs = db.query(R.id, R.doc_id, R.reviewer_email).filter(R.status == "in_review").all()
    if not pages and not revs:
        return []
    doc_cols = dict(db.query(D.id, D.collection_id).filter(D.id.in_(sorted({r.doc_id for r in revs}))).all()) if revs else {}

    def sent_to_me(reviewer: str, cid: str) -> bool:
        reviewer = (reviewer or "").strip().lower()
        if reviewer:
            return reviewer == me
        return bool(cid) and (cid in owned or kb_access.collection_owner(db, cid) == me)
    mine = ({("page", p.id) for p in pages if sent_to_me(p.reviewer_email, p.collection_id)}
            | {("revision", r.id) for r in revs if sent_to_me(r.reviewer_email, doc_cols.get(r.doc_id, ""))})
    if not mine:
        return []
    out = []
    for p in _review_queue(db, user):
        rev = p.get("kind") == "revision"
        rid = p.get("revision_id") if rev else p["id"]
        if ("revision" if rev else "page", rid) not in mine:
            continue
        where = " / ".join(c.get("name", "") for c in (p.get("collection") or []) if isinstance(c, dict))
        out.append(row("kb_review", f"{'revision' if rev else 'page'}:{rid}", person_email=p.get("author_email") or "",
                       person_name=p.get("author_name") or "",
                       title=f"{'Revision Review' if rev else 'Page Review'} - {p.get('title') or 'Page'}",
                       detail=_short(p.get("change_note") or p.get("summary") or ""),
                       created_at=p.get("submitted_at"), actions=(a_open("Review"),),
                       link={"view": "sop", "sub": f"{'revision' if rev else 'review'}:{rid}"},
                       facts=(("Page", p.get("title") or ""), ("Type", p.get("type_label") or ""),
                              ("Collection", where), ("Change", (p.get("change_kind") or "").title() if rev else "New page"),
                              ("Note", p.get("change_note") or ""))))
    return out


# ── Operations: construction daily logs (routers/construction.py) ────────────

@source("construction_log_review", "Daily Log Reviews", "work")
def _construction_logs(db: Session, user: dict, ctx: dict) -> list:
    """Daily logs submitted on a jobsite where the caller is one of the
    project's named managers (the people the "Daily Log Ready to Review"
    bell goes to), still to approve - the review queue's statuses, and only
    projects the caller may review (_may_review). Never the caller's own
    log. A manager by role reviews any project on the review queue; only the
    named ones are asked, so only theirs wait here."""
    from routers.construction import _emails, _may_review, _visible_projects
    me = _me(user)
    if not me:
        return []
    P, L = models.ConstructionProject, models.ConstructionDailyLog
    named = [p for p in db.query(P).filter(P.deleted_at == "").all() if me in _emails(p.manager_emails)]
    if not named:
        return []
    projects = {p.id: p for p in _visible_projects(db, user) if p.id in {n.id for n in named} and _may_review(user, p)}
    if not projects:
        return []
    out = []
    for lg in (db.query(L).filter(L.project_id.in_(sorted(projects)), L.status.in_(("submitted", "processed")),
                                  L.deleted_at == "").order_by(L.log_date).all()):
        if (lg.author_email or "").lower() == me:
            continue
        p = projects[lg.project_id]
        who = (lg.author_email or "").lower()
        flags = len(lg.ai_safety_flags or [])
        out.append(row("construction_log_review", lg.id, person_email=who, person_name=_name(db, ctx, who) if who else "",
                       title=f"Daily Log - {p.name} ({_us_day(lg.log_date)})",
                       detail=_short(lg.ai_summary or lg.notes_raw or "") or "Read the log, then approve it or ask for more.",
                       created_at=lg.submitted_at or lg.created_at, actions=(a_open("Review"),),
                       link={"view": "ops", "sub": "construction-dashboard"},
                       facts=(("Jobsite", p.name or ""), ("Day", _us_day(lg.log_date)),
                              ("Crew", str(lg.crew_size) if lg.crew_size else ""),
                              ("Hours", f"{lg.hours_worked:g}" if lg.hours_worked else ""),
                              ("Weather", lg.weather or ""),
                              ("Safety Flags", str(flags) if flags else ""),
                              ("AI Summary", "Still being read" if not lg.ai_processed_at else ""))))
    return out


# ── People: HR packets to verify (hr_packet_docs.py) ─────────────────────────

def _packet_verifier(db: Session, ev, setting, cache: dict) -> str:
    """Who verifies this packet today - hr_packet_docs.resolve_role on the
    verify role, with the parts of event_ctx a verify role reads (the
    company, its role owners, the manager). event_ctx itself also renders
    the Details Form for pay values, too heavy to poll every minute;
    test_approvals_inbox checks both answer the same."""
    import hr_checklists as hc
    import hr_life_events as hle
    import hr_packet_docs as hpd
    d = ev.inputs or {}
    vrole = d.get("verifier_role") or setting.verify_role or "hr"
    eid = ev.entity_id or ""
    if ("entity", eid) not in cache:
        cache[("entity", eid)] = db.query(models.HrEntity).filter(models.HrEntity.id == eid).first() if eid else None
    entity = cache[("entity", eid)]
    if ev.kind in hle.CANDIDATE_KINDS:
        cand = db.query(models.HrCandidate).filter(models.HrCandidate.id == ev.candidate_id).first()
        ctx = hle.hire_ctx(db, cand, d, entity, ev.created_by or "") if cand else {"entity": entity, "owners": {}}
    else:
        if ("owners", eid) not in cache:
            cache[("owners", eid)] = hc.role_owners(db, eid)
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == ev.employee_id).first()
        ctx = {"entity": entity, "owners": cache[("owners", eid)],
               "manager_email": ((emp.manager_email if emp else "") or "").lower()}
    return hpd.resolve_role(db, vrole, ctx)


def _verify_label(db: Session, role: str) -> str:
    import hr_checklists as hc
    import hr_packet_docs as hpd
    return hpd.ROLE_LABELS.get(role) or hc.role_label(db, role)


@source("hr_packet_verify", "Packets To Verify", "people")
def _hr_packets_to_verify(db: Session, user: dict, ctx: dict) -> list:
    """HR packets (offer, hiring packet, promotion, separation, probation
    letter) generated and waiting for the caller as their verifier - the
    person the packet's Verified By role resolves to today (verify_and_send's
    own rule), never one the caller started when the packet asks for a
    second person. Verifying means checking every document, so Verify And
    Send opens the packet. No pay is shown here."""
    import hr_life_events as hle
    me = _me(user)
    if not me or user.get("external"):
        return []
    E = models.HrLifeEvent
    events = db.query(E).filter(E.status == "review").order_by(E.created_at).all()
    if not events:
        return []
    settings = {s.id: s for s in db.query(models.HrPacketSetting)
                .filter(models.HrPacketSetting.id.in_(sorted({e.setting_id for e in events if e.setting_id}))).all()}
    cache: dict = {}
    out = []
    for ev in events:
        setting = settings.get(ev.setting_id)
        if setting is None or _packet_verifier(db, ev, setting, cache) != me:
            continue
        if setting.verify_distinct and (ev.created_by or "").lower() == me:
            continue
        what = hle.event_title(ev)
        d = ev.inputs or {}
        company = cache.get(("entity", ev.entity_id or ""))
        sub = "hr-hiring" if ev.kind in hle.CANDIDATE_KINDS and not ev.employee_id else "hr-people"
        out.append(row("hr_packet_verify", ev.id, person_email="" if ev.kind in hle.CANDIDATE_KINDS else ev.subject_email or "",
                       person_name=ev.subject_name or "",
                       title=f"Verify {what} - {ev.subject_name or 'Packet'}",
                       detail="Check the documents, then Verify And Send - nothing goes out until you do.",
                       created_at=ev.updated_at or ev.created_at, actions=(a_open("Verify And Send"),),
                       link={"view": "hr", "sub": sub},
                       facts=(("Packet", setting.name or what), ("Person", ev.subject_name or ""),
                              ("Company", company.name if company else ""),
                              ("Role", d.get("job_title") or ""),
                              ("Effective", _us_day(ev.effective_date) if ev.effective_date else ""),
                              ("Started By", _name(db, ctx, ev.created_by) if ev.created_by else ""),
                              ("Verified By", _verify_label(db, d.get("verifier_role") or setting.verify_role or "hr")))))
    return out


# Workflows (Oct 28 2026): an Ask For Approval step's question, with the
# step's own options as buttons. The source lives with the engine
# (workflows/approvals.py) and registers itself on import.
GROUPS.append(("workflows", "Workflows"))
import workflows.approvals  # noqa: E402,F401 - registers the "workflow" source
