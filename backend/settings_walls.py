"""Who may change what on the organization-wide settings screens
(Settings fix plan, 11/02/2026).

Three rules every Settings save route shares, so each says them in one line:

  - refuse_change: a key that is the WHOLE organization's (the mail plumbing,
    the Daily Briefing / Weekly Digest / Workforce Scorecard mode and test
    recipients - Neil, 11/02/2026) is changed by a Super Administrator only
    (auth.is_global_admin). A settings form sends its whole copy back, so
    only a CHANGE is refused - the ticket_inbound.clean_settings_patch
    pattern; everything else on the screen keeps its access.
  - people_scope: the work emails inside the caller's company wall, for the
    delivery logs and recipient lists (None = everyone).
  - require_company_wide: an organization-wide record (branding, shared
    rules, org-wide templates) needs company-wide access - a walled caller
    changes their own company's records only (the shift and pay settings
    keep timeclock._require_company_manage, which this matches for them).
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

SUPER_ONLY = "Only a Super Administrator can change this - it applies to every company."


def refuse_change(db: Session, user: dict, current: dict, patch: dict, keys, message: str = SUPER_ONLY) -> None:
    """403 when `patch` CHANGES one of `keys` and the caller is not a Super
    Administrator. An unchanged value sent back passes."""
    import auth
    import scoped_settings
    if scoped_settings.changed_keys(current, patch, keys) and not auth.is_global_admin(user, db):
        raise HTTPException(403, message)


def people_scope(db: Session, user: dict):
    """None (everyone) for an unwalled caller; else the lowercased work emails
    of the People inside their companies (an Administrator also reaches the
    people with no company - auth.admits_blank)."""
    import auth
    from models import NexusEmployee
    scope = auth.company_scope(user, db)
    if scope is None:
        return None
    blank = auth.admits_blank(scope)
    return {(e or "").strip().lower() for e, c in db.query(NexusEmployee.work_email, NexusEmployee.company).all()
            if e and (((c or "").strip() in scope) or (blank and not (c or "").strip()))}


def scope_query(db: Session, user: dict, q, column):
    """`q` narrowed to the rows whose `column` (an email) is inside the
    caller's company wall."""
    emails = people_scope(db, user)
    if emails is None:
        return q
    from sqlalchemy import false, func
    return q.filter(func.lower(column).in_(sorted(emails))) if emails else q.filter(false())


def in_scope(db: Session, user: dict, email: str) -> bool:
    emails = people_scope(db, user)
    return emails is None or (email or "").strip().lower() in emails


def require_company_wide(db: Session, user: dict, what: str, people: bool = False) -> None:
    """403 unless the caller has company-wide access: no company wall
    confines them (auth.company_scope is None - a Super Administrator, or a
    level 1-3 caller while the walls are off; an Administrator is always
    walled). `people`: a People (HR) setting, where a People grant limited
    to some companies, or to a manager's own team, confines them too."""
    import auth
    if auth.company_scope(user, db) is not None:
        raise HTTPException(403, f"{what} needs company-wide access")
    if people and auth.hr_scope(user, db) is not None:
        raise HTTPException(403, f"{what} needs company-wide access")
