"""Helpers the Time, Shifts and Items packs share (underscore-prefixed, so
`load_packs()` never imports it as a pack of its own):

  * emails / a person's company and manager, read as plain SELECTs on the
    row's OWN connection - an entity's `company` callable gets only the row,
    and an observer emit runs inside a flush, where a second session or an
    ORM query (autoflush is off, but still) is the wrong tool;
  * the grant checks behind `may_use` / `visible_to` (auth's level table and
    `_module_level`, the same reads the routers make);
  * `attach_property`: a read-only Python attribute a pack adds to a model
    for a derived field (a checkout's due date, a time sheet's worked
    minutes) - never a column, never a name a column could take.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import object_session

import models


def emails(*vals) -> list[str]:
    out: list[str] = []
    for v in vals:
        if isinstance(v, (list, tuple, set)):
            vals2 = v
        else:
            vals2 = str(v or "").split(",")
        for e in vals2:
            e = str(e or "").strip().lower()
            if e and e not in out:
                out.append(e)
    return out


def _conn(db_or_row):
    """The connection to read on: a Session's own, or the session the row is
    attached to (None for a row no session holds)."""
    s = db_or_row if hasattr(db_or_row, "connection") else object_session(db_or_row)
    if s is None:
        return None
    try:
        return s.connection()
    except Exception:   # noqa: BLE001 - a closed session reads as nothing, never breaks an emit
        return None


def employee_columns(db_or_row, email: str, *cols: str) -> dict:
    """{col: value} of the nexus_employees row for `email` (lowercase match),
    {} when there is none."""
    em = (email or "").strip().lower()
    conn = _conn(db_or_row)
    if not em or conn is None or not cols:
        return {}
    t = models.NexusEmployee.__table__
    row = conn.execute(select(*[t.c[c] for c in cols]).where(func.lower(t.c.work_email) == em)
                       .order_by(t.c.deleted_at.asc())).first()
    return {c: row[i] for i, c in enumerate(cols)} if row is not None else {}


def person_company(db_or_row, email: str) -> str:
    return str(employee_columns(db_or_row, email, "company").get("company") or "")


def person_manager(db_or_row, email: str) -> list[str]:
    """The person's manager (and their backup manager when one is set)."""
    cols = employee_columns(db_or_row, email, "manager_email", "backup_manager_email")
    return [e for e in emails(cols.get("manager_email"), cols.get("backup_manager_email"))
            if e != (email or "").lower()]


def company_hr_contacts(db, company_id: str) -> list[str]:
    import hr_access
    return hr_access.hr_contacts(db, company_id or "")


def employee_row(db, email: str):
    """The NexusEmployee row for an email - the subject of the events about
    a person (period.closed, time.add_time_batch); None when unknown."""
    em = (email or "").strip().lower()
    if not em:
        return None
    return (db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == em)
            .order_by(models.NexusEmployee.deleted_at.asc()).first())


def group_company(db_or_row, group_id: str) -> str:
    """A shift group's company ('' = shared)."""
    gid = (group_id or "").strip()
    conn = _conn(db_or_row)
    if not gid or gid == "-" or conn is None:
        return ""
    t = models.ShiftGroup.__table__
    return str(conn.execute(select(t.c.company_id).where(t.c.id == gid)).scalar() or "")


def stored_value(row, attr: str):
    """The column's value as the database holds it right now (the from of a
    change not yet flushed); None for a row that is not persistent."""
    from sqlalchemy import inspect as sa_inspect
    conn = _conn(row)
    state = sa_inspect(row)
    if conn is None or state.identity is None:
        return None
    mapper = state.mapper
    col = mapper.get_property(attr).columns[0]
    stmt = select(col)
    for pk, val in zip(mapper.primary_key, state.identity):
        stmt = stmt.where(pk == val)
    return conn.execute(stmt.select_from(mapper.local_table)).scalar()


# ── grants ───────────────────────────────────────────────────────────────────
def level_of(user: Optional[dict]) -> int:
    return int((user or {}).get("level", 0) or 0)


def email_of(user: Optional[dict]) -> str:
    return ((user or {}).get("email") or "").strip().lower()


def is_admin(user: Optional[dict]) -> bool:
    import auth
    return level_of(user) >= auth._LEVELS["administrator"]


def is_manager(user: Optional[dict]) -> bool:
    import auth
    return level_of(user) >= auth._LEVELS["manager"]


def has_grant(db, user: Optional[dict], module: str, min_level: str = "viewer") -> bool:
    import auth
    em = email_of(user)
    if not em:
        return False
    return auth._module_level(em, module, db) >= auth._MODULE_LEVEL_RANK[min_level]


# ── derived attributes ───────────────────────────────────────────────────────
def attach_property(model, name: str, fn) -> None:
    """Add a read-only attribute to a model class for a derived catalog
    field. Refused when the name is taken (a column, a relationship, an
    earlier attach) - a pack never shadows a mapped attribute."""
    if name in model.__dict__ or hasattr(model, name):
        return
    setattr(model, name, property(fn))


def parse_dt(s) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(s or "").replace("Z", "+00:00"))
    except ValueError:
        return None
