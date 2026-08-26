"""Task table preferences - how ONE user arranges the columns of the Task
module's list views (order and width, per table).

Self-service only, no admin gate: every read and write is scoped to the
caller's own email, and nothing here widens what anyone can see - it only
records how they arrange columns of data they already have access to. The
same posture as link_layouts.py, and models.py's TaskTablePref docstring
carries the data-shape rationale.

Deliberately dumb about what a column IS. The client owns the column
vocabulary (it changes whenever a list gains a column), so an order is
stored as an opaque list of strings and validated only for shape and size.
A key that no longer exists is dropped by the client at read time, which is
what lets a retired column disappear without a migration here.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import TaskTablePref

router = APIRouter(prefix="/task-prefs", tags=["Task Prefs"], dependencies=[Depends(get_current_user)])

# Caps so a malformed or hostile client can't grow the document without bound.
# Comfortably above the widest list (the Task List with every custom field).
MAX_TABLES = 40
MAX_COLS = 200
MAX_KEY = 64
MIN_WIDTH, MAX_WIDTH = 40, 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(db: Session, email: str, create: bool = False) -> TaskTablePref | None:
    row = db.query(TaskTablePref).filter(TaskTablePref.owner_email == email).first()
    if row is None and create:
        row = TaskTablePref(id=str(uuid.uuid4()), owner_email=email, prefs={},
                            created_at=_now(), updated_at=_now())
        db.add(row)
        db.flush()
    return row


class TablePrefIn(BaseModel):
    order:     list[str] | None = None
    widths:    dict[str, int] | None = None
    hidden:    list[str] | None = None   # columns this person has hidden
    collapsed: list[str] | None = None   # group sections they keep closed
    view:      str | None = None         # list | board | calendar | ...
    group:     str | None = None         # what the list is grouped by
    sort:      dict | None = None        # {"key": ..., "dir": "asc"|"desc"}


def _clean(body: TablePrefIn) -> dict:
    """Keep only what we can store safely. Anything out of range is dropped
    rather than rejected - a single bad width should not cost someone the
    reorder they just made."""
    out: dict = {}
    if body.order is not None:
        seen, order = set(), []
        for key in body.order:
            k = (key or "").strip()
            if k and len(k) <= MAX_KEY and k not in seen:
                seen.add(k)
                order.append(k)
            if len(order) >= MAX_COLS:
                break
        out["order"] = order
    # Both are opaque key lists, same rules as `order`: an empty list is a real
    # value (nothing hidden / nothing collapsed), NOT "unset" - that distinction
    # is what lets a person re-open a section that ships collapsed by default.
    for name, val in (("hidden", body.hidden), ("collapsed", body.collapsed)):
        if val is None:
            continue
        seen, keys = set(), []
        for key in val:
            k = (key or "").strip()
            if k and len(k) <= MAX_KEY and k not in seen:
                seen.add(k)
                keys.append(k)
            if len(keys) >= MAX_COLS:
                break
        out[name] = keys
    # The view/group/sort a person left the screen on. Short opaque strings -
    # the client owns both vocabularies, and an unknown value simply falls back
    # to that screen's default at read time.
    for name, val in (("view", body.view), ("group", body.group)):
        if val is None:
            continue
        v = (val or "").strip()
        if v and len(v) <= MAX_KEY:
            out[name] = v
    if body.sort is not None:
        key = str(body.sort.get("key", "")).strip()
        direction = str(body.sort.get("dir", "asc")).strip().lower()
        if key and len(key) <= MAX_KEY and direction in ("asc", "desc"):
            out["sort"] = {"key": key, "dir": direction}
    if body.widths is not None:
        widths = {}
        for key, val in list(body.widths.items())[:MAX_COLS]:
            k = (key or "").strip()
            if not k or len(k) > MAX_KEY:
                continue
            try:
                w = int(val)
            except (TypeError, ValueError):
                continue
            if MIN_WIDTH <= w <= MAX_WIDTH:
                widths[k] = w
        out["widths"] = widths
    return out


@router.get("")
def get_prefs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every table this user has arranged. Absent = they use the defaults,
    which is not an error - a person who has never dragged a column has no row."""
    row = _row(db, user["email"].lower())
    return {"prefs": (row.prefs or {}) if row else {}}


@router.put("/{table}")
def set_table_prefs(table: str, body: TablePrefIn,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    table = (table or "").strip()
    if not table or len(table) > MAX_KEY:
        raise HTTPException(400, "Invalid table id")
    row = _row(db, user["email"].lower(), create=True)
    prefs = dict(row.prefs or {})
    if table not in prefs and len(prefs) >= MAX_TABLES:
        raise HTTPException(400, "Too many saved table layouts")
    # Merged, not replaced: the width save and the order save are separate
    # calls, and a width write must not wipe the order the user just set.
    prefs[table] = {**prefs.get(table, {}), **_clean(body)}
    row.prefs = prefs           # reassigned, not mutated - JSON columns only
    row.updated_at = _now()     # detect a change when the object is replaced
    db.commit()
    return {"prefs": prefs}


@router.delete("/{table}")
def reset_table_prefs(table: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put ONE table back to its defaults."""
    row = _row(db, user["email"].lower())
    if not row:
        return {"prefs": {}}
    prefs = dict(row.prefs or {})
    prefs.pop((table or "").strip(), None)
    row.prefs = prefs
    row.updated_at = _now()
    db.commit()
    return {"prefs": prefs}


@router.delete("")
def reset_all_prefs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put EVERY table back to its defaults - the "restore all" the UI offers."""
    row = _row(db, user["email"].lower())
    if row:
        row.prefs = {}
        row.updated_at = _now()
        db.commit()
    return {"prefs": {}}
