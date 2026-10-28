"""Confidential ticket desks (Neil, Oct 27 2026) - Ask HR runs through Tickets.

A ticket whose `confidential_desk` is set ("hr" - the only desk today) is one
person's private matter with HR: a document update, a profile change, a
question about pay or leave. It is filed through `tickets.file_ticket` like any
other ticket (codes, SLAs, the thread, attachments, email and Teams all work),
but it is NOT the service desk's to read.

Who may read one (`may_read`):
  - the ticket's own people - requester, whoever filed it, watchers the
    requester or HR added, the assignee (tickets._ticket_readers);
  - HR for the ticket's company (`is_hr_for`): the company's HR contact
    (People > Companies), an administrator / owner / Global Admin inside the
    company wall, or a Full HR grant whose HR scope admits the company.
Being on the ticket desk (an agent or supervisor grant) is NOT enough, and
neither is being a manager.

Hidden everywhere by default. database.py's do_orm_execute hook leaves these
rows out of EVERY ORM query on task_tickets (subqueries and joins included):
ticket reports, dashboards, Insights, the daily briefing, My Work, header
search, AI summaries, overdue reminders, the property and item ticket lists,
and any reader written later that does not know this rule. A path that checks
`may_read` itself opts in with `.execution_options(include_confidential=True)`
(`include(q)` below) - fail closed: a reader that forgets sees nothing, never
someone's HR request.

The service desk never hears about them either: the "new ticket to assign"
bell, the desk's emails and the SLA breach alert go to `hr_audience` (the HR
contact, else the company's administrators) instead of the desk roster.
"""
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

import models

DESK_HR = "hr"
DESKS = (DESK_HR,)
DESK_LABEL = {DESK_HR: "HR"}


def is_confidential(t) -> bool:
    return bool((getattr(t, "confidential_desk", "") or "").strip())


def include(q):
    """`q` with confidential tickets let through the global hook - ONLY for a
    caller that checks may_read (or narrows to the caller's own tickets)
    before anything leaves the server."""
    return q.execution_options(include_confidential=True)


def confidential_ids(db: Session) -> set:
    """Every confidential ticket id (deleted ones too) - for filtering rows of
    OTHER tables that are keyed by ticket id (delivery logs, activity)."""
    T = models.TaskTicket
    return {i for (i,) in db.query(T.id).execution_options(include_confidential=True, include_deleted=True)
            .filter(func.coalesce(T.confidential_desk, "") != "").all()}


def hr_contacts(db: Session, company_id: str) -> list:
    """The company's HR contact(s) - People > Companies; one email or a
    comma list."""
    if not company_id:
        return []
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == company_id).first()
    raw = (getattr(ent, "hr_contact_email", "") or "") if ent else ""
    return list(dict.fromkeys(e.strip().lower() for e in raw.split(",") if e.strip()))


def _who(db: Session, user_or_email) -> dict:
    """A user dict for `user_or_email` - the signed-in caller as given, or one
    built from someone's stored role the way get_current_user builds it (a
    bell recipient, a background job)."""
    import auth
    if isinstance(user_or_email, dict):
        return user_or_email
    email = (user_or_email or "").strip().lower()
    return {"email": email, "level": auth.level_for(email, db)}


def is_hr_for(db: Session, user_or_email, company_id: str) -> bool:
    """HR for `company_id` - the same people timesheet_review.is_hr trusts
    (the HR contact, an administrator, a Full HR grant), each inside their
    own reach: an administrator's company wall, a Full HR grant's HR scope."""
    who = _who(db, user_or_email)
    # Once per company per request: a list checks every confidential row.
    memo = who.setdefault("_hr_for", {}) if isinstance(user_or_email, dict) else {}
    key = company_id or ""
    if key not in memo:
        memo[key] = _is_hr_for(db, who, key)
    return memo[key]


def _is_hr_for(db: Session, who: dict, company_id: str) -> bool:
    import auth
    me = (who.get("email") or "").strip().lower()
    if not me or who.get("external"):
        return False
    if me in hr_contacts(db, company_id or ""):
        return True
    if int(who.get("level", 0) or 0) >= auth._LEVELS["administrator"] or auth.is_global_admin(who, db):
        return auth.company_ok(company_id or "", auth.company_scope(who, db))
    if auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["full"]:
        scope = auth.hr_scope(who, db)
        if auth.is_team_scope(scope):
            return False
        return scope is None or (company_id or "") in scope
    return False


def hr_companies(db: Session, user: dict):
    """The companies whose confidential tickets this caller reads as HR:
    None = every company, else a set (possibly empty). Mirrors is_hr_for -
    the SQL side of a list; is_hr_for / may_read stays the exact check."""
    import auth
    me = (user.get("email") or "").strip().lower()
    if not me or user.get("external"):
        return set()
    out = {e.id for e in db.query(models.HrEntity.id, models.HrEntity.hr_contact_email).all()
           if me in [x.strip().lower() for x in (e.hr_contact_email or "").split(",")]}
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"] or auth.is_global_admin(user, db):
        scope = auth.company_scope(user, db)
        if scope is None:
            return None
        out |= set(scope)
    elif auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["full"]:
        scope = auth.hr_scope(user, db)
        if scope is None:
            return None
        if not auth.is_team_scope(scope):
            out |= set(scope)
    return out


def readers(t) -> set:
    from routers.tickets import _ticket_readers
    return _ticket_readers(t)


def may_read(db: Session, user_or_email, t) -> bool:
    """May this person open ticket `t` at all? Always True for an ordinary
    ticket - its own rules (the desk, participants) decide those."""
    if not is_confidential(t):
        return True
    who = _who(db, user_or_email)
    me = (who.get("email") or "").strip().lower()
    return bool(me) and (me in readers(t) or is_hr_for(db, who, t.company_id or ""))


def may_work(db: Session, user_or_email, t) -> bool:
    """May this person work a confidential ticket - edit, assign, resolve,
    read internal notes: its assignee or HR for its company. Its requester
    and watchers read and reply only."""
    who = _who(db, user_or_email)
    me = (who.get("email") or "").strip().lower()
    return bool(me) and (me == (t.assignee_email or "").strip().lower()
                         or is_hr_for(db, who, t.company_id or ""))


def visible_filter(db: Session, user: dict):
    """SQL condition: the ordinary tickets plus the confidential ones this
    caller may read (a loose participant match + their HR companies). Use on
    a query opted in with include(); may_read stays the final guard."""
    T = models.TaskTicket
    me = (user.get("email") or "").strip().lower()
    conds = [func.coalesce(T.confidential_desk, "") == ""]
    if me:
        conds += [func.lower(func.coalesce(c, "")) == me
                  for c in (T.requester_email, T.created_by_email, T.assignee_email, T.approver_email)]
        conds.append(func.lower(cast(T.watcher_emails, String)).like(f'%"{me}"%'))
    comps = hr_companies(db, user)
    if comps is None:
        conds.append(func.coalesce(T.confidential_desk, "") != "")
    elif comps:
        conds.append(func.coalesce(T.company_id, "").in_(sorted(comps)))
    return or_(*conds)


def _active(db: Session, email: str) -> bool:
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == (email or "").strip().lower()).first())
    return (emp is not None and (emp.status or "") not in ("offboarded", "inactive")
            and not (getattr(emp, "deleted_at", "") or ""))


def hr_audience(db: Session, t) -> list:
    """Who hears about a confidential ticket where the desk would: the
    company's HR contact(s) still on the People list, else the company's
    administrators (HR when there is no HR contact - the same fallback time
    sheets and reimbursements use). Never the requester."""
    requester = (t.requester_email or "").strip().lower()
    people = [e for e in hr_contacts(db, t.company_id or "") if _active(db, e)]
    if not people:
        from routers.tickets import _company_admins
        people = _company_admins(db, t.company_id or "")
    return [e for e in dict.fromkeys(people) if e and e != requester]


def default_assignee(db: Session, company_id: str, requester: str) -> str:
    """The HR desk's default assignee: the company's first HR contact still on
    the People list - never the requester themselves (HR asking HR goes to the
    administrators instead, through the unassigned path)."""
    requester = (requester or "").strip().lower()
    for e in hr_contacts(db, company_id):
        if e != requester and _active(db, e):
            return e
    return ""
