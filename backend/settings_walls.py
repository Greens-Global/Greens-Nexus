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
  - require_super_admin_for_org: a record every company shares (Brand
    Color, Email Appearance, the ticket Property Rules, the California
    minimum wage, the interview questionnaires, the leave policies, the
    signature sender overrides) is changed by a Super Administrator only
    (Neil, 11/02/2026) - an Administrator or any lower tier, walled or not,
    whatever grants they hold, is refused and edits only their own
    company's copy where one exists. (The shift and pay settings' tenant
    rows keep timeclock._require_company_manage.)
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


def is_super_admin(db: Session, user: dict) -> bool:
    """A Super Administrator: level 5, or a member of a group flagged
    is_global_admin (auth.is_global_admin)."""
    import auth
    return bool(auth.is_global_admin(user, db))


def require_super_admin_for_org(db: Session, user: dict, what: str = "") -> None:
    """403 unless the caller is a Super Administrator - for a record every
    company shares (see the module docstring). `what` is unused in the
    message (kept so a caller can say what it guards)."""
    if not is_super_admin(db, user):
        raise HTTPException(403, ORG_RECORD_REFUSED)


ORG_RECORD_REFUSED = "Only a Super Administrator can change this - every company shares it."
