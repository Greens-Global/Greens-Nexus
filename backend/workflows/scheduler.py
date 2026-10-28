"""Schedules and date triggers (spec 6.3).

A schedule (`every: day | week | month`, `days`, `time`, zone = the
company's Shifts timeZone) runs once per period per workflow per company:
the dedupe key `wf:<id>:<company>:<period>` is claimed by inserting a
WorkflowSubjectMark row (its composite primary key makes the claim
atomic across processes); a period whose time has passed and was never
claimed is caught up on the next tick, never twice. An every-company
workflow runs once per company; its subject is the company.

A date trigger (`entity`, `field`, `offsetDays`, `time`, optional
`yearly`) fires once per subject per date. The scan is cheap and rare:
the runner looks once a minute and, per workflow and company, once per
local day after the trigger time (a `dates` mark, `<company>:<date>`);
when the field is a plain column the rows are narrowed in SQL to the
three days around `today - offset` (a yearly field - birthday, work
anniversary - matches month and day in any year after the value's own,
so the Python check reads those rows). Dedupe key `wf:<id>:<subject>:<date>`.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import ColumnProperty
from sqlalchemy.orm.attributes import InstrumentedAttribute

import models
from workflows import catalog
from workflows.emit import read_path
from workflows.engine import _hhmm, company_zone, now_in

CLAIM_ENTITY = "dedupe"
DATES_ENTITY = "dates"          # the once-per-day scan mark: subject "<company>:<local date>"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def companies_for(db, wf: models.Workflow) -> list[str]:
    if wf.company_id:
        return [wf.company_id]
    return [r.id for r in db.query(models.HrEntity).order_by(models.HrEntity.name).all()]


# ── schedules ────────────────────────────────────────────────────────────────
def period_key(trigger: dict, local: datetime) -> str:
    """The period `local` falls in, '' when the schedule is not due today
    (wrong weekday / day of month) or its time has not come yet."""
    every = str(trigger.get("every") or "day")
    days = [int(d) for d in (trigger.get("days") or []) if str(d).lstrip("-").isdigit()]
    hh, mm = _hhmm(trigger.get("time") or "08:00")
    if (local.hour, local.minute) < (hh, mm):
        return ""
    if every == "day":
        return local.date().isoformat()
    if every == "week":
        if days and local.isoweekday() not in days:
            return ""
        return f"{local.date().isoformat()}"            # one run per listed weekday
    if every == "month":
        if days and local.day not in days:
            return ""
        return local.date().isoformat()
    return ""


def due_schedules(db, now_utc: Optional[datetime] = None) -> list[tuple[models.Workflow, str, str]]:
    """(workflow, company_id, period) for every schedule due now and not
    yet claimed."""
    now_utc = now_utc or _now()
    out = []
    for wf in db.query(models.Workflow).filter(models.Workflow.status == "active").all():
        trig = wf.trigger if isinstance(wf.trigger, dict) else {}
        if trig.get("kind") != "schedule":
            continue
        for cid in companies_for(db, wf):
            local = now_in(company_zone(db, cid), now_utc)
            period = period_key(trig, local)
            if not period:
                continue
            if claimed(db, wf, f"wf:{wf.id}:{cid}:{period}"):
                continue
            out.append((wf, cid, period))
    return out


# ── date triggers ────────────────────────────────────────────────────────────
def _date_of(ent: catalog.EntityDef, row, field_key: str):
    f = ent.field(field_key)
    raw = read_path(row, (f.path if f is not None and f.path else field_key))
    if raw is None or raw == "":
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def fires_today(trigger: dict, value: date, today: date) -> bool:
    """Whether a record whose date is `value` fires on `today`. A yearly
    date is tried in the year before, the year of and the year after today
    (a Jan 2 birthday with offset -7 fires on Dec 26) and only in a year
    AFTER the value's own - an anniversary never fires on the start date
    itself."""
    off = int(trigger.get("offsetDays") or 0)
    yearly = bool(trigger.get("yearly"))
    if not yearly:
        return value + timedelta(days=off) == today
    for year in (today.year - 1, today.year, today.year + 1):
        if year <= value.year:
            continue
        try:
            candidate = value.replace(year=year)
        except ValueError:                      # Feb 29
            candidate = value.replace(year=year, day=28)
        if candidate + timedelta(days=off) == today:
            return True
    return False


def date_window(trigger: dict, today: date) -> Optional[tuple[str, str]]:
    """The ISO (lo, hi) a plain date column must fall in to fire on `today`
    - the day `today - offset` with one day of slack on either side (a
    value stored with a time, a zone a day ahead or behind) - or None for
    a yearly field, whose year is anything."""
    if trigger.get("yearly"):
        return None
    off = int(trigger.get("offsetDays") or 0)
    target = today - timedelta(days=off)
    return (target - timedelta(days=1)).isoformat(), (target + timedelta(days=1)).isoformat()


def column_for(ent: catalog.EntityDef, field_key: str):
    """The model column behind a date field when it is a plain column (no
    path into JSON, no derived value), else None - then only the Python
    check can read it."""
    if ent.model is None:
        return None
    f = ent.field(field_key)
    name = str(f.path if f is not None and f.path else field_key)
    if not name or "." in name or name.startswith("__"):
        return None
    col = getattr(ent.model, name, None)
    if isinstance(col, InstrumentedAttribute) and isinstance(getattr(col, "property", None), ColumnProperty):
        return col
    return None


def _date_trigger(wf: models.Workflow):
    """(trigger, entity, field) for an active date workflow whose field is
    a registered date, else None."""
    trig = wf.trigger if isinstance(wf.trigger, dict) else {}
    if trig.get("kind") != "date":
        return None
    ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
    fld = str(trig.get("field") or "")
    if ent is None or ent.model is None or not any(d.key == fld for d in ent.dates):
        return None
    return trig, ent, fld


def date_scans(db, wf: models.Workflow, now_utc: Optional[datetime] = None) -> list[tuple[str, datetime]]:
    """(company_id, local now) for each company in the workflow's scope
    whose trigger time has passed today - the scans the runner owes."""
    found = _date_trigger(wf)
    if found is None:
        return []
    trig = found[0]
    now_utc = now_utc or _now()
    hh, mm = _hhmm(trig.get("time") or "08:00")
    out = []
    for cid in companies_for(db, wf):
        local = now_in(company_zone(db, cid), now_utc)
        if (local.hour, local.minute) >= (hh, mm):
            out.append((cid, local))
    return out


def due_dates_for(db, wf: models.Workflow, now_utc: Optional[datetime] = None) -> list[tuple[object, str]]:
    """(subject row, local date) for every row in scope this date trigger
    fires for today and has not yet claimed. Rows are narrowed in SQL when
    the field is a plain column; every row is then checked in Python in
    its own company's zone."""
    found = _date_trigger(wf)
    if found is None:
        return []
    trig, ent, fld = found
    now_utc = now_utc or _now()
    hh, mm = _hhmm(trig.get("time") or "08:00")
    q = db.query(ent.model)
    col = column_for(ent, fld)
    if col is not None and not trig.get("yearly"):
        # the local date differs by at most a day across zones: one window
        # wide enough for every company in scope
        days = {now_in(company_zone(db, cid), now_utc).date() for cid in companies_for(db, wf)} or {now_utc.date()}
        windows = [date_window(trig, d) for d in sorted(days)]
        q = q.filter(col >= min(w[0] for w in windows), col <= max(w[1] for w in windows))
    zones: dict = {}
    out = []
    for row in q.all():
        cid = ent.company_of(row)
        if wf.company_id and cid != wf.company_id:
            continue
        if cid not in zones:
            zones[cid] = company_zone(db, cid)
        local = now_in(zones[cid], now_utc)
        if (local.hour, local.minute) < (hh, mm):
            continue
        value = _date_of(ent, row, fld)
        if value is None or not fires_today(trig, value, local.date()):
            continue
        sid = str(getattr(row, "id", "") or "")
        if claimed(db, wf, f"wf:{wf.id}:{sid}:{local.date().isoformat()}"):
            continue
        out.append((row, local.date().isoformat()))
    return out


def due_dates(db, now_utc: Optional[datetime] = None) -> list[tuple[models.Workflow, object, str]]:
    """(workflow, subject row, date) for every date trigger that fires
    today for a row in scope and was not yet claimed."""
    out = []
    for wf in db.query(models.Workflow).filter(models.Workflow.status == "active").all():
        for row, day in due_dates_for(db, wf, now_utc):
            out.append((wf, row, day))
    return out


# ── claims ───────────────────────────────────────────────────────────────────
def claimed(db, wf: models.Workflow, dedupe_key: str) -> bool:
    return db.get(models.WorkflowSubjectMark, (wf.id, CLAIM_ENTITY, dedupe_key)) is not None


def claimed_mark(db, workflow_id: str, entity: str, subject_id: str) -> bool:
    return db.get(models.WorkflowSubjectMark, (workflow_id, entity, subject_id)) is not None


def claim(db, wf: models.Workflow, dedupe_key: str) -> bool:
    """Insert-or-skip on the composite key: True when this process won."""
    return claim_mark(db, wf.id, CLAIM_ENTITY, dedupe_key)


def release(db, wf: models.Workflow, dedupe_key: str) -> None:
    """Give a claim back: the run it guarded never started (run_for
    raised), so the period / date may run again on the next tick."""
    release_mark(db, wf.id, CLAIM_ENTITY, dedupe_key)


def release_mark(db, workflow_id: str, entity: str, subject_id: str) -> None:
    M = models.WorkflowSubjectMark
    try:
        (db.query(M).filter(M.workflow_id == workflow_id, M.entity == entity, M.subject_id == subject_id)
         .delete(synchronize_session=False))
        db.commit()
    except Exception as e:   # noqa: BLE001 - a claim that cannot be released stays claimed; the log says so
        db.rollback()
        print(f"[workflows] claim {entity}:{subject_id} of {workflow_id} not released: {type(e).__name__}: {str(e)[:120]}")


def claim_mark(db, workflow_id: str, entity: str, subject_id: str) -> bool:
    """The atomic claim behind every once-only job: a WorkflowSubjectMark row
    on (workflow_id, entity, subject_id); True when this process inserted
    it. The owner digest claims (owner email, "digest", ISO week)."""
    if db.get(models.WorkflowSubjectMark, (workflow_id, entity, subject_id)) is not None:
        return False
    try:
        with db.begin_nested():
            db.add(models.WorkflowSubjectMark(workflow_id=workflow_id, entity=entity, subject_id=subject_id,
                                              last_run_at=_now().isoformat()))
            db.flush()
    except IntegrityError:
        return False
    db.commit()
    return True
