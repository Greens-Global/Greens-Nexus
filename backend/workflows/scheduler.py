"""Schedules and date triggers (spec 6.3).

A schedule (`every: day | week | month`, `days`, `time`, zone = the
company's Shifts timeZone) runs once per period per workflow per company:
the dedupe key `wf:<id>:<company>:<period>` is claimed by inserting a
WorkflowSubjectMark row (its composite primary key makes the claim
atomic across processes); a period whose time has passed and was never
claimed is caught up on the next tick, never twice. An every-company
workflow runs once per company; its subject is the company.

A date trigger (`entity`, `field`, `offsetDays`, `time`, optional
`yearly`) fires once per subject per date: every row of the entity in the
workflow's scope is read, the field's date plus the offset compared with
today in the subject's company zone (a yearly field - birthday, work
anniversary - matches month and day). Dedupe key `wf:<id>:<subject>:<date>`.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError

import models
from workflows import catalog
from workflows.emit import read_path
from workflows.engine import _hhmm, company_zone, now_in

CLAIM_ENTITY = "dedupe"


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
    off = int(trigger.get("offsetDays") or 0)
    yearly = bool(trigger.get("yearly"))
    if yearly:
        try:
            this_year = value.replace(year=today.year)
        except ValueError:                      # Feb 29
            this_year = value.replace(year=today.year, day=28)
        return this_year + timedelta(days=off) == today and value <= today
    return value + timedelta(days=off) == today


def due_dates(db, now_utc: Optional[datetime] = None) -> list[tuple[models.Workflow, object, str]]:
    """(workflow, subject row, date) for every date trigger that fires
    today for a row in scope and was not yet claimed."""
    now_utc = now_utc or _now()
    out = []
    zones: dict = {}
    for wf in db.query(models.Workflow).filter(models.Workflow.status == "active").all():
        trig = wf.trigger if isinstance(wf.trigger, dict) else {}
        if trig.get("kind") != "date":
            continue
        ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
        fld = str(trig.get("field") or "")
        if ent is None or ent.model is None or not any(d.key == fld for d in ent.dates):
            continue
        hh, mm = _hhmm(trig.get("time") or "08:00")
        for row in db.query(ent.model).all():
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
            out.append((wf, row, local.date().isoformat()))
    return out


# ── claims ───────────────────────────────────────────────────────────────────
def claimed(db, wf: models.Workflow, dedupe_key: str) -> bool:
    return db.get(models.WorkflowSubjectMark, (wf.id, CLAIM_ENTITY, dedupe_key)) is not None


def claim(db, wf: models.Workflow, dedupe_key: str) -> bool:
    """Insert-or-skip on the composite key: True when this process won."""
    return claim_mark(db, wf.id, CLAIM_ENTITY, dedupe_key)


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
