"""Approver delegation (Neil, Oct 17 2026): "Delegate My Approvals".

Someone who approves things names a stand-in for a date range (a vacation).
While the delegation is live, the approvals that route to the delegator ALSO
route to the delegate:

  * Time Sheet review - the delegate's Time Sheets to Review list and Approve /
    Send Back (timesheet_review.waiting_on / not_reviewed,
    routers/timesheet_reviews._reviewer_of);
  * punch-fix requests and punch-time edits - the queue and the decision
    (routers/timeclock list/decide routes);
  * time off - the list and the decision, confidential requests included
    (timeclock._TimeoffPrivacy.approvers).

How it widens - and why it is never wider than the delegator:

  * covered_people(delegator) is ONLY the people whose approvals route to the
    delegator by their own right: direct reports, the people they are Backup
    Manager for (backup_manager.managed_directly), and, as a company's HR
    contact, that company's people who have no manager. Not an HR grant's
    company-wide scope, not the Global Admin fallback queue, and never
    anything the delegator holds through a delegation of their own - so a
    delegate's own delegation does not pass items further (no chains).
  * delegated_people(delegate) adds only people the delegate does not already
    approve, inside the delegate's company walls (auth.company_scope), and
    only while the delegate could open the approval screens themselves
    (manager tier or an HR editor grant - the same gate every approve route
    keeps). The widening is applied ONLY by the approval routes' dependencies
    (timeclock.require_approval_read / require_approval_write), never to
    timecards, payroll, pay figures, People or monitoring.
  * The delegator keeps all their own access; nothing is moved, only added.

Two limits on making one (Neil, Oct 20 2026):

  * only while the delegator is OFF - every working day of the range sits
    inside their approved full-day time off or a company holiday
    (off_problem; weekends between are fine, a range of weekends alone is
    not);
  * only UP or ACROSS, never down - the stand-in is someone up the
    delegator's reporting line, a peer under the same manager, or someone at
    the delegator's role level or above, and never anyone in the delegator's
    own reporting tree (direct or indirect reports, the people they back up)
    - delegate_relation / eligible_delegates. A delegation made before the
    rule keeps working until it ends; serialize() flags it with a warning.

Every decision taken through a delegation records "by X for Y": the time
sheet review round carries `for`, a punch fix / time off decision note says
who it was decided for, and an audit_logs row is written (`acting_for`).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

# The longest one delegation may run - a stand-in for a leave, not a re-org
# (that is a manager change in People).
MAX_DAYS = 366


def _norm(email: str) -> str:
    return (email or "").strip().lower()


def _today_for(db: Session, email: str) -> str:
    """The person's local calendar date (their latest punch's offset)."""
    from routers.timeclock import _employee_today
    return _employee_today(db, _norm(email))


def _gone(db: Session, email: str, need_row: bool) -> bool:
    """Offboarded / inactive in People (a row that is not active or
    onboarding). `need_row`: no People row at all counts as gone too."""
    from models import NexusEmployee
    row = (db.query(NexusEmployee.status)
           .filter(func.lower(NexusEmployee.work_email) == _norm(email)).first())
    if row is None:
        return need_row
    return (row.status or "active") not in ("active", "onboarding")


def is_live(db: Session, d, today: str | None = None) -> bool:
    """Not revoked, today inside the range, and both people still active -
    a delegation whose delegator or stand-in left ends with them."""
    if d is None or (d.revoked_at or ""):
        return False
    t = today or _today_for(db, d.delegator_email)
    if not ((d.start_date or "") <= t <= (d.end_date or "")):
        return False
    return not _gone(db, d.delegate_email, True) and not _gone(db, d.delegator_email, False)


def _prefilter(q):
    """Rows that could be live today on ANY calendar (UTC +-1 day), before
    the per-delegator local-date check."""
    from models import ApprovalDelegation as D
    utc = datetime.now(timezone.utc).date()
    lo, hi = (utc - timedelta(days=1)).isoformat(), (utc + timedelta(days=1)).isoformat()
    return q.filter(D.revoked_at == "", D.start_date <= hi, D.end_date >= lo)


def live_for_delegate(db: Session, delegate: str) -> list:
    """The delegations naming `delegate` that are live right now."""
    from models import ApprovalDelegation as D
    me = _norm(delegate)
    if not me:
        return []
    rows = _prefilter(db.query(D).filter(D.delegate_email == me)).all()
    return sorted([d for d in rows if is_live(db, d)], key=lambda d: (d.start_date or "", d.delegator_email))


def any_live(db: Session) -> bool:
    """Is any delegation live right now (a cheap gate for per-row lookups)."""
    from models import ApprovalDelegation as D
    return any(is_live(db, d) for d in _prefilter(db.query(D)).all())


def live_from(db: Session, delegators) -> list:
    """The live delegations given by any of `delegators`."""
    from models import ApprovalDelegation as D
    who = sorted({_norm(e) for e in delegators or () if _norm(e)})
    if not who:
        return []
    rows = _prefilter(db.query(D).filter(D.delegator_email.in_(who))).all()
    return sorted([d for d in rows if is_live(db, d)], key=lambda d: (d.start_date or "", d.delegator_email))


def can_approve(db: Session, email: str) -> bool:
    """Could this person open the approval screens on their own: manager tier
    or an HR editor grant - require_team_write's gate."""
    from auth import _MODULE_LEVEL_RANK, _module_level, _role_for
    em = _norm(email)
    if not em:
        return False
    return _role_for(em, db)[1] >= 3 or _module_level(em, "hr", db) >= _MODULE_LEVEL_RANK["editor"]


def can_delegate(db: Session, email: str) -> bool:
    """Approvals route to this person AND they can act on them - a Backup
    Manager below the manager tier has people but no approve rights, so
    nothing to hand on."""
    return can_approve(db, email) and bool(covered_people(db, email))


def covered_people(db: Session, delegator: str) -> set:
    """The people whose approvals route to `delegator` by their own right -
    what a delegation hands on. Never the delegator, never anything they hold
    through a delegation (no chains)."""
    import backup_manager
    from models import HrEntity, NexusEmployee
    me = _norm(delegator)
    if not me:
        return set()
    out = set(backup_manager.managed_directly(db, me))
    # A company's HR contact is the lead approver for its people with NO
    # manager on file (timeclock._visible_emails, Oct 16).
    for ent in db.query(HrEntity).filter(func.lower(HrEntity.hr_contact_email) == me).all():
        out |= {_norm(e.work_email) for e in db.query(NexusEmployee)
                .filter(NexusEmployee.company == ent.id, NexusEmployee.status.in_(["active", "onboarding"])).all()
                if e.work_email and not (e.manager_email or "").strip()}
    return out - {me, ""}


def _walls(db: Session, email: str):
    """The person's company scope (None = no wall applies)."""
    from auth import company_scope, level_for
    em = _norm(email)
    return company_scope({"email": em, "level": level_for(em, db)}, db)


def _company(db: Session, email: str) -> str:
    from models import NexusEmployee
    row = db.query(NexusEmployee.company).filter(func.lower(NexusEmployee.work_email) == _norm(email)).first()
    return (row.company if row else "") or ""


def _inside(scope, company: str) -> bool:
    return scope is None or (bool(company) and company in scope)


def delegated_people(db: Session, delegate: str) -> dict:
    """{employee email: delegator email} - the people `delegate` approves
    ONLY because of a live delegation: everyone the delegate already reaches
    in their own right (their whole normal approval scope - directs, backups,
    HR-contact people, HR / team scope) is left out, so a "For X" mark, a
    round's `for` and the audit row only ever mean "because of X". Empty when
    no delegation is live, or when the delegate can no longer open the
    approval screens."""
    from auth import level_for
    from routers.timeclock import _visible_emails
    me = _norm(delegate)
    rows = live_for_delegate(db, me)
    if not rows or not can_approve(db, me):
        return {}
    own = _visible_emails(db, {"email": me, "level": level_for(me, db)})
    if own is None:
        return {}            # they already reach everyone - nothing is "for" anyone
    scope = _walls(db, me)
    out: dict = {}
    for d in rows:
        dg = _norm(d.delegator_email)
        # The delegator must still be able to act on these approvals
        # themselves - a delegation never hands on more than they hold.
        if dg == me or not can_approve(db, dg):
            continue
        for em in sorted(covered_people(db, dg)):
            if em == me or em in own or em in out:
                continue
            if not _inside(scope, _company(db, em)):
                continue
            out[em] = dg
    return out


def acting_for(db: Session, actor: str, employee: str) -> str:
    """The delegator `actor` is standing in for on `employee`'s approval, or
    '' when the actor approves them in their own right (or not at all)."""
    em, me = _norm(employee), _norm(actor)
    if not em or not me or em == me:
        return ""
    return delegated_people(db, me).get(em, "")


def stand_ins(db: Session, employee: str, approvers) -> list:
    """[(delegate, delegator)] - the live stand-ins of `approvers` who would
    see `employee`'s request: the delegator approves them in their own right,
    the delegate can open the approval screens and sits inside the walls.
    For notifying the stand-in of a NEW item (one notice per workflow)."""
    em = _norm(employee)
    if not em:
        return []
    out, seen = [], set()
    for d in live_from(db, approvers):
        dg, dl = _norm(d.delegator_email), _norm(d.delegate_email)
        if dl in seen or dl in (em, dg):
            continue
        if em not in covered_people(db, dg) or not can_approve(db, dl) or not can_approve(db, dg):
            continue
        if not _inside(_walls(db, dl), _company(db, em)):
            continue
        seen.add(dl)
        out.append((dl, dg))
    return out


# -- Up or across only, and only while off (Neil, Oct 20 2026) ---------------

RELATION_LABEL = {"above": "Up Your Reporting Line", "peer": "Same Manager", "level": "Same Level or Above"}


def _org(db: Session) -> dict:
    """{email: (manager, backup manager)} for everyone in People - one read."""
    from models import NexusEmployee
    out = {}
    for em, mgr, bk in db.query(NexusEmployee.work_email, NexusEmployee.manager_email,
                                NexusEmployee.backup_manager_email).all():
        em = _norm(em)
        if em:
            out[em] = (_norm(mgr), _norm(bk))
    return out


def _chain_up(org: dict, me: str) -> list:
    """The delegator's manager, their manager, and so on (loops stop)."""
    out, seen, cur = [], {me}, org.get(me, ("", ""))[0]
    while cur and cur not in seen:
        out.append(cur)
        seen.add(cur)
        cur = org.get(cur, ("", ""))[0]
    return out


def _below(org: dict, me: str) -> set:
    """Everyone under `me`: direct and indirect reports, and the people `me`
    is set as Backup Manager for (and theirs)."""
    kids: dict = {}
    for em, (mgr, bk) in org.items():
        for boss in {mgr, bk} - {"", em}:
            kids.setdefault(boss, set()).add(em)
    out, todo = set(), [me]
    while todo:
        for k in kids.get(todo.pop(), ()):
            if k not in out and k != me:
                out.add(k)
                todo.append(k)
    return out


def delegate_relation(db: Session, delegator: str, delegate: str, org: dict | None = None) -> str:
    """How `delegate` sits against `delegator`: 'above' (up the reporting
    line), 'peer' (same manager), 'level' (same role level or higher, outside
    the delegator's own tree) - or '' when they are below the delegator, which
    a delegation may never go to."""
    from auth import level_for
    dg, dl = _norm(delegator), _norm(delegate)
    if not dg or not dl or dg == dl:
        return ""
    org = org if org is not None else _org(db)
    if dl in _below(org, dg):
        return ""
    if dl in _chain_up(org, dg):
        return "above"
    mgr = org.get(dg, ("", ""))[0]
    if mgr and org.get(dl, ("", ""))[0] == mgr:
        return "peer"
    if level_for(dl, db) >= level_for(dg, db):
        return "level"
    return ""


def eligible_delegates(db: Session, delegator: str) -> list:
    """[{email, name, relation, relationLabel}] - who may cover `delegator`'s
    approvals: an active Nexus People row, up or across (delegate_relation),
    able to approve and inside the delegator's company walls. The picker's
    list and the server's rule are this one function."""
    from models import NexusEmployee
    dg = _norm(delegator)
    if not dg:
        return []
    org = _org(db)
    company = _company(db, dg)
    out = []
    for e in (db.query(NexusEmployee.work_email)
              .filter(NexusEmployee.status.in_(["active", "onboarding"])).all()):
        em = _norm(e.work_email)
        if not em or em == dg:
            continue
        rel = delegate_relation(db, dg, em, org)
        if not rel or not can_approve(db, em) or not _inside(_walls(db, em), company):
            continue
        out.append({"email": em, "name": display_name(db, em), "relation": rel,
                    "relationLabel": RELATION_LABEL[rel]})
    order = {"above": 0, "peer": 1, "level": 2}
    return sorted(out, key=lambda p: (order[p["relation"]], p["name"].lower()))


def _days(s: str, e: str) -> list:
    try:
        a, b = date.fromisoformat(s), date.fromisoformat(e)
    except ValueError:
        return []
    return [(a + timedelta(days=i)) for i in range((b - a).days + 1)] if b >= a else []


def off_ranges(db: Session, email: str, today: str | None = None) -> list:
    """[{start, end, label, kind}] - the person's approved full-day time off
    and company holidays from `today` on (a year ahead): the days a
    delegation may cover. A part-day request (a doctor's appointment) is not
    being off."""
    from models import NexusEmployee, TimeOffRequest
    em = _norm(email)
    if not em:
        return []
    t = today or _today_for(db, em)
    out = []
    for r in (db.query(TimeOffRequest)
              .filter(func.lower(TimeOffRequest.employee_email) == em, TimeOffRequest.status == "approved",
                      TimeOffRequest.end_date >= t).all()):
        if (r.start_time or "") or (r.end_time or "") or not r.start_date or not r.end_date:
            continue
        out.append({"start": max(r.start_date, t), "end": r.end_date, "kind": "timeoff",
                    "label": "Approved Time Off"})
    emp = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == em).first()
    if emp is not None:
        from routers.timeclock import _company_holidays_for_many
        horizon = (date.fromisoformat(t) + timedelta(days=MAX_DAYS)).isoformat()
        for d, h in sorted(_company_holidays_for_many(db, {em: emp}, t, horizon).get(em, {}).items()):
            if (h.get("type") or "mandatory") == "mandatory":
                out.append({"start": d, "end": d, "kind": "holiday", "label": h.get("name") or "Company Holiday"})
    return sorted(out, key=lambda r: (r["start"], r["end"]))


def off_problem(db: Session, email: str, start: str, end: str) -> str:
    """'' when every working day of start..end is inside the person's approved
    full-day time off or a company holiday (and at least one day is), else
    why not."""
    from routers.timeclock import _us_day
    days = _days(start, end)
    covered = set()
    if days:
        for r in off_ranges(db, email, today=days[0].isoformat()):
            covered |= {d.isoformat() for d in _days(r["start"], r["end"])}
    if not any(d.isoformat() in covered for d in days):
        return "You can delegate your approvals only for days you are off - pick dates inside your approved time off."
    for d in days:
        if d.isoformat() not in covered and d.weekday() < 5:
            return (f"{_us_day(d.isoformat())} is not inside your approved time off. Delegate only the days "
                    "you are off.")
    return ""


def display_name(db: Session, email: str) -> str:
    from routers.timeclock import _display_name
    return _display_name(db, email)


def by_for(db: Session, actor: str, delegator: str) -> str:
    """'Max Test for Dana Boss' - the audit wording."""
    return f"{display_name(db, actor)} for {display_name(db, delegator)}"


def audit(db: Session, actor: str, delegator: str, action: str, resource_type: str, resource_id: str,
          employee: str = "") -> None:
    """An audit_logs row for a decision taken through a delegation, on top of
    the request's own row the audit middleware writes: says who it was for."""
    import models
    if not delegator:
        return
    db.add(models.AuditLog(
        timestamp=datetime.now(timezone.utc).isoformat(), user_email=_norm(actor), user_role="delegate",
        action=f"{action} (by {by_for(db, actor, delegator)})", resource_type=resource_type,
        resource_id=resource_id or "",
        details=json.dumps({"acting_for": _norm(delegator), "employee": _norm(employee)})))


# ── Validation (the routes call these) ───────────────────────────────────────

def _day(v: str, what: str) -> str:
    from fastapi import HTTPException
    try:
        return date.fromisoformat((v or "").strip()[:10]).isoformat()
    except ValueError:
        raise HTTPException(422, f"Pick the {what}.")


def check_new(db: Session, delegator: str, delegate: str, start: str, end: str) -> tuple[str, str]:
    """Refuse a delegation that may not be made; returns the clean (start, end).
    Overlaps are REFUSED, not replaced: an approver who already handed a range
    to someone revokes it first, so nobody loses a stand-in they were told
    about without seeing it happen."""
    from fastapi import HTTPException
    from models import ApprovalDelegation as D, NexusEmployee
    dg, dl = _norm(delegator), _norm(delegate)
    # First, before anything about the picked person is judged: someone with
    # nothing to delegate learns nothing about whether an email can approve.
    if not can_delegate(db, dg):
        raise HTTPException(409, "There are no approvals routed to you to delegate.")
    if not dl:
        raise HTTPException(422, "Pick who covers your approvals.")
    if dl == dg:
        raise HTTPException(422, "Pick someone other than yourself.")
    person = (db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == dl).first())
    if not person or (person.status or "active") not in ("active", "onboarding"):
        raise HTTPException(422, "Pick someone from the Nexus People list.")
    if not can_approve(db, dl):
        raise HTTPException(422, f"{display_name(db, dl)} can't approve time sheets, punch fixes or time off. "
                                 "Pick a manager, or someone with an HR editor grant.")
    if not _inside(_walls(db, dl), _company(db, dg)):
        raise HTTPException(422, f"{display_name(db, dl)} works in another company and can't cover these approvals.")
    # Up or across, never down (Neil, Oct 20): never someone in your own team.
    if not delegate_relation(db, dg, dl):
        raise HTTPException(422, f"{display_name(db, dl)} is below {display_name(db, dg)} in the reporting line. "
                                 "Approvals go up or across while you are off - pick your manager, someone above "
                                 "them, or a peer.")
    s, e = _day(start, "first day"), _day(end, "last day")
    if e < s:
        raise HTTPException(422, "The last day is before the first day.")
    if e < _today_for(db, dg):
        raise HTTPException(422, "That range is already over.")
    # Only while off (Neil, Oct 20): the range sits inside approved time off.
    why = off_problem(db, dg, s, e)
    if why:
        raise HTTPException(422, why)
    if (date.fromisoformat(e) - date.fromisoformat(s)).days >= MAX_DAYS:
        raise HTTPException(422, "A delegation can run for up to a year. For a longer change, update the "
                                 "manager in People.")
    clash = (db.query(D).filter(D.delegator_email == dg, D.revoked_at == "",
                                D.start_date <= e, D.end_date >= s).first())
    if clash:
        from routers.timeclock import _us_span
        raise HTTPException(409, f"{display_name(db, clash.delegate_email)} already covers "
                                 f"{_us_span(clash.start_date, clash.end_date)}. Revoke that first, or pick "
                                 "days that don't overlap.")
    return s, e


def warnings_for(db: Session, d, org: dict | None = None) -> list:
    """Why a current delegation would not be allowed today (made before the
    Oct 20 rules, or the time off under it changed). It keeps working until
    it ends - the list just says so."""
    out = []
    if not delegate_relation(db, d.delegator_email, d.delegate_email, org):
        out.append(f"{display_name(db, d.delegate_email)} is below {display_name(db, d.delegator_email)} in the "
                   "reporting line - new delegations go only up or across. This one keeps working until it ends.")
    if off_problem(db, d.delegator_email, d.start_date or "", d.end_date or ""):
        out.append("These days are not all inside approved time off. This one keeps working until it ends.")
    return out


def serialize(db: Session, d, today: str | None = None, org: dict | None = None) -> dict:
    t = today or _today_for(db, d.delegator_email)
    state = ("revoked" if d.revoked_at else "ended" if (d.end_date or "") < t
             else "active" if (d.start_date or "") <= t else "upcoming")
    warnings = warnings_for(db, d, org) if state in ("active", "upcoming") else []
    return {"id": d.id, "delegatorEmail": d.delegator_email, "delegatorName": display_name(db, d.delegator_email),
            "delegateEmail": d.delegate_email, "delegateName": display_name(db, d.delegate_email),
            "startDate": d.start_date, "endDate": d.end_date, "note": d.note or "",
            "createdBy": d.created_by or "", "createdByName": display_name(db, d.created_by) if d.created_by else "",
            "createdAt": d.created_at or "", "revokedAt": d.revoked_at or "", "revokedBy": d.revoked_by or "",
            "state": state, "warnings": warnings}
