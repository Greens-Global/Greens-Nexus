"""Nobody sets their own pay (Oct 20 2026, follow-up to the Oct 19 time-
integrity audit that stopped self-approval of time).

A manager's or administrator's team scope includes themself, so the pay
routes (PUT /timeclock/payroll/rate, PUT /hr/employees/{eid}/compensation, a
promotion letter that carries new pay) let them change their own rate. Now
403 on your own record: one Global Admin sets another's.

The one exception is the dead end: an owner (or anyone) who is the ONLY
person able to set pay at all. When nobody else holds the permission, the
change is allowed - otherwise their rate could never be set.
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

OWN_PAY = "You can't change your own pay - another administrator or HR sets it."

_GONE = ("inactive", "offboarded", "terminated")


def _same(a: str, b: str) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _left(db: Session, emails: set) -> set:
    """The people in `emails` whose employee record says they left."""
    from models import NexusEmployee
    if not emails:
        return set()
    rows = (db.query(NexusEmployee.work_email, NexusEmployee.status)
            .filter(NexusEmployee.work_email.in_(list(emails))).all())
    return {(em or "").lower() for em, st in rows if (st or "").lower() in _GONE}


def other_pay_setters(db: Session, me: str, *, min_level: int, module_id: str,
                      min_module_level: str = "editor", exclude_level: int = 0) -> set:
    """Everyone other than `me` who could pass the route's pay gate: a role at
    or above `min_level`, or an Access Group granting `module_id` at
    `min_module_level`+ (minus a role tier the route refuses outright,
    `exclude_level` - the manager tier never sees pay). People who left are
    not counted."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK
    from models import NexusGroup, NexusGroupMember, NexusRole
    mine = (me or "").strip().lower()
    levels = {}
    for em, role in db.query(NexusRole.email, NexusRole.role).all():
        levels[(em or "").lower()] = _LEVELS.get(role, 1)
    out = {em for em, lv in levels.items() if lv >= min_level}
    need = _MODULE_LEVEL_RANK[min_module_level]
    rows = (db.query(NexusGroupMember.email, NexusGroup.allowed_modules)
            .join(NexusGroup, NexusGroup.id == NexusGroupMember.group_id).all())
    for em, modules in rows:
        for part in (modules or "").split(","):
            mid, _, lvl = part.strip().partition(":")
            if mid == module_id and _MODULE_LEVEL_RANK.get(lvl, _MODULE_LEVEL_RANK["viewer"]) >= need:
                e = (em or "").lower()
                if not (exclude_level and levels.get(e, 1) == exclude_level):
                    out.add(e)
    out.discard(mine)
    out.discard("")
    return out - _left(db, out)


def own_pay_locked(db: Session, user: dict, employee_email: str, *, min_level: int, module_id: str,
                   exclude_level: int = 0) -> bool:
    """True when `employee_email` is the caller and someone else can set
    their pay - the screen shows it read-only. False on anyone else's record
    and for the sole person who can set pay at all (the dead end)."""
    if not _same(employee_email, user.get("email")):
        return False
    return bool(other_pay_setters(db, user.get("email"), min_level=min_level, module_id=module_id,
                                  exclude_level=exclude_level))


def refuse_own_pay(db: Session, user: dict, employee_email: str, *, min_level: int, module_id: str,
                   exclude_level: int = 0) -> None:
    """403 when the caller is changing their own pay - unless nobody else
    could ever set it (the sole-owner dead end)."""
    if own_pay_locked(db, user, employee_email, min_level=min_level, module_id=module_id,
                      exclude_level=exclude_level):
        raise HTTPException(403, OWN_PAY)


# The Pay & Benefits fields that set a rate, with the editor's defaults
# (COMP_DEFAULTS in HR.jsx) so a save that only fills in a default is not a
# change. Benefits and bank accounts are not pay settings.
_COMP_PAY = {"base": "", "payBasis": "salary", "frequency": "biweekly", "currency": "USD",
             "effectiveDate": "", "overtimeRule": ""}


def _norm(k: str, v, dflt=""):
    v = dflt if v is None or str(v).strip() == "" else str(v).strip()
    if k in ("base", "fullDayHours") and v != "":
        try:
            return float(v)
        except ValueError:
            return v
    return v.lower() if k in ("payBasis", "frequency", "overtimeRule") else v


def comp_pay_changed(db: Session, emp, incoming: dict) -> bool:
    """Does saving `incoming` change any pay field of `emp`'s record?"""
    from models import PayrollRate
    current, incoming = dict(getattr(emp, "compensation", None) or {}), dict(incoming or {})
    if any(_norm(k, current.get(k), d) != _norm(k, incoming.get(k), d) for k, d in _COMP_PAY.items()):
        return True
    if str(incoming.get("fullDayHours") or "").strip() == "":
        return False   # left blank: the time clock keeps what it has
    old = current.get("fullDayHours")
    if old in (None, "") and emp.work_email:
        # The editor pre-fills it from the time clock rate when the record has none.
        rate = db.query(PayrollRate).filter(PayrollRate.employee_email == emp.work_email.lower()).first()
        old = getattr(rate, "full_day_hours", None) if rate else None
    return _norm("fullDayHours", old, "8") != _norm("fullDayHours", incoming.get("fullDayHours"), "8")
