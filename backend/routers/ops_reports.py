"""Operations > Reports and the Report Builder (Neil, Ops review, Oct 20 2026).

  GET  /ops-reports/catalog                  Cubby's report list, grouped, with where each comes from
  GET  /ops-reports/run/{kind}               one report: facility_id or facility_ids (comma-separated),
                                             start, end (YYYY-MM-DD), the report's options (catalog)
  GET  /ops-reports/tenant                   drill-down: a tenant's units, tenancies, balance, payments
  GET  /ops-reports/tenant/ledger            ...and their Cubby ledger, read live
  GET  /ops-reports/unit                     drill-down: a unit and every tenancy it has had
  GET  /ops-reports/builder/registry         the datasets, dimensions, fields the builder may use
  POST /ops-reports/builder/run              run a spec
  GET/POST/PATCH/DELETE /ops-reports/saved   saved reports (own + shared), share, send now

Same door as the rest of Operations (supervisors and above, or the
Operations grant). Saving, sharing, scheduling and sending are for managers
and above or the Operations editor grant. Everything blocking (database,
Cubby, Graph) runs in a thread.
"""
import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

import cubby
import models
import ops_report_builder as builder
import ops_reports
from auth import company_of, get_current_user, require_level_or_module
from database import get_db

router = APIRouter(
    prefix="/ops-reports",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)
_manage = require_level_or_module(3, "operations", "editor")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


async def _call(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except ops_reports.ReportError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except builder.SpecError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except cubby.CubbyError as e:
        if e.status == 503:
            raise HTTPException(status_code=503, detail=e.message) from e
        # 424, never 502: Cloudflare replaces a 502 body and hides the reason.
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e


@router.get("/catalog")
def get_catalog():
    return ops_reports.catalog()


@router.get("/run/{kind}")
async def run_report(kind: str, request: Request, facility_id: str = "", start: str = "", end: str = "",
                     facility_ids: str = ""):
    ids = [i for i in facility_ids.split(",") if i.strip()] or None
    opts = {k: v for k, v in request.query_params.items() if k in ops_reports.OPTION_DEFS}
    return await _call(ops_reports.run, kind, facility_id, start, end, ids, opts)


@router.get("/tenant")
async def tenant(facility_id: str, customer_id: str):
    return await _call(ops_reports.tenant, facility_id, customer_id)


@router.get("/tenant/ledger")
async def tenant_ledger(facility_id: str, customer_id: str):
    return await _call(ops_reports.tenant_ledger, facility_id, customer_id)


@router.get("/unit")
async def unit(facility_id: str, unit_id: str):
    return await _call(ops_reports.unit, facility_id, unit_id)


# ── Builder ───────────────────────────────────────────────────────────────────

class RunBody(BaseModel):
    spec: dict[str, Any]


@router.get("/builder/registry")
def get_registry():
    return builder.registry()


@router.post("/builder/run")
async def builder_run(body: RunBody):
    return await _call(builder.run, body.spec)


# ── Saved reports ─────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _out(r: models.OpsSavedReport, me: str, level: int) -> dict:
    return {"id": r.id, "name": r.name, "spec": r.spec or {}, "shared": bool(r.shared), "owner": r.owner_email,
            "mine": r.owner_email == me, "canEdit": r.owner_email == me or level >= 4,
            "schedule": r.schedule or "", "scheduleDay": r.schedule_day or 0, "recipients": list(r.recipients or []),
            "lastSentAt": r.last_sent_at or "", "lastError": r.last_error or "",
            "createdAt": r.created_at, "updatedAt": r.updated_at}


class SavedBody(BaseModel):
    name: Optional[str] = None
    spec: Optional[dict[str, Any]] = None
    shared: Optional[bool] = None
    schedule: Optional[str] = None
    scheduleDay: Optional[int] = None
    recipients: Optional[list[str]] = None


def _recipients(db: Session, emails: list[str]) -> list[str]:
    """Nexus People only (CLAUDE.md: the curated list, never the GAL)."""
    clean = sorted({(e or "").strip().lower() for e in emails if (e or "").strip()})
    if len(clean) > builder.MAX_RECIPIENTS:
        raise HTTPException(status_code=422, detail=f"Send to {builder.MAX_RECIPIENTS} people at most")
    if any(not _EMAIL.match(e) for e in clean):
        raise HTTPException(status_code=422, detail="Every recipient needs a valid work email")
    if not clean:
        return []
    E = models.NexusEmployee
    known = {(r[0] or "").lower() for r in db.query(E.work_email)
             .filter(E.work_email.in_(clean), or_(E.status.is_(None), E.status.notin_(("inactive", "offboarded")))).all()}
    unknown = [e for e in clean if e not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Not in Nexus People: {', '.join(unknown[:5])}")
    return clean


def _apply(db: Session, row: models.OpsSavedReport, body: SavedBody) -> None:
    if body.name is not None:
        name = body.name.strip()[:120]
        if not name:
            raise HTTPException(status_code=422, detail="Give the report a name")
        row.name = name
    if body.spec is not None:
        try:
            row.spec = builder.validate(body.spec)
        except builder.SpecError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        if len(json.dumps(row.spec)) > 8000:
            raise HTTPException(status_code=422, detail="That report is too large to save")
    if body.shared is not None:
        row.shared = bool(body.shared)
    if body.recipients is not None:
        row.recipients = _recipients(db, body.recipients)
    if body.schedule is not None:
        if body.schedule not in builder.SCHEDULES:
            raise HTTPException(status_code=422, detail="A schedule is weekly, monthly or none")
        row.schedule = body.schedule
    if body.scheduleDay is not None:
        row.schedule_day = body.scheduleDay
    if row.schedule == "weekly" and not 0 <= (row.schedule_day or 0) <= 6:
        raise HTTPException(status_code=422, detail="Pick a weekday")
    if row.schedule == "monthly" and not 1 <= (row.schedule_day or 0) <= 28:
        raise HTTPException(status_code=422, detail="Pick a day of the month from 1 to 28")
    if row.schedule and not row.recipients:
        raise HTTPException(status_code=422, detail="A scheduled report needs at least one recipient")


def _visible(db: Session, me: str):
    R = models.OpsSavedReport
    return db.query(R).filter(or_(R.owner_email == me, R.shared.is_(True))).order_by(R.name).all()


def _own(db: Session, report_id: str, user: dict) -> models.OpsSavedReport:
    row = db.get(models.OpsSavedReport, report_id)
    me = user["email"].lower()
    if not row or not (row.owner_email == me or row.shared):
        raise HTTPException(status_code=404, detail="Report not found")
    if row.owner_email != me and user.get("level", 0) < 4:
        raise HTTPException(status_code=403, detail="Only the person who saved this report can change it")
    return row


@router.get("/saved")
def list_saved(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    return {"reports": [_out(r, me, user.get("level", 0)) for r in _visible(db, me)]}


@router.post("/saved", status_code=201)
def create_saved(body: SavedBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    if body.spec is None or not (body.name or "").strip():
        raise HTTPException(status_code=422, detail="A saved report needs a name and a report")
    me = user["email"].lower()
    row = models.OpsSavedReport(id=builder.new_id(), owner_email=me, name="", spec={}, shared=False, schedule="",
                                schedule_day=0, recipients=[], created_at=_now(), updated_at=_now(), last_sent_period="")
    _apply(db, row, body)
    db.add(row)
    db.commit()
    return {"report": _out(row, me, user.get("level", 0))}


@router.patch("/saved/{report_id}")
def update_saved(report_id: str, body: SavedBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    row = _own(db, report_id, user)
    _apply(db, row, body)
    row.updated_at = _now()
    if body.schedule is not None or body.scheduleDay is not None:
        row.last_error = ""
    db.commit()
    return {"report": _out(row, user["email"].lower(), user.get("level", 0))}


@router.delete("/saved/{report_id}")
def delete_saved(report_id: str, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    row = _own(db, report_id, user)
    db.delete(row)
    db.commit()
    return {"ok": True}


class ShareBody(BaseModel):
    recipient: str
    message: Optional[str] = ""


@router.post("/saved/{report_id}/share")
def share_saved(report_id: str, body: ShareBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    """Share with the Operations team and tell one person on their bell
    (server-side, like Accounting's shared reports)."""
    import uuid
    row = _own(db, report_id, user)
    me = user["email"].lower()
    who = _recipients(db, [body.recipient])
    if not who:
        raise HTTPException(status_code=422, detail="Pick a person to share with")
    if who[0] == me:
        raise HTTPException(status_code=422, detail="That is you")
    row.shared = True
    note = (body.message or "").strip()[:600]
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="ops_report_shared", recipient=who[0],
        title=f"An Ops Report Was Shared With You: {row.name}",
        body=(note + " " if note else "") + "Open Operations, Reports, then Report Builder.",
        ref_id=row.id, item_name=row.name, requested_by=me,
        action=json.dumps({"view": "operations", "sub": "reports"}), actioned=False, read_by="",
        company=company_of(me, db), created_at=_now(), priority=0,
    ))
    db.commit()
    return {"report": _out(row, me, user.get("level", 0)), "recipient": who[0]}


class SendBody(BaseModel):
    to_me: bool = False


@router.post("/saved/{report_id}/send")
async def send_saved(report_id: str, body: SendBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    """Email it now - to its recipients, or only to the caller (a test)."""
    import graph_mail
    row = await asyncio.to_thread(_own, db, report_id, user)
    if not graph_mail.graph_configured() or not graph_mail.DEFAULT_FROM_EMAIL:
        raise HTTPException(status_code=503, detail="Email is not set up on this server")
    to = [user["email"].lower()] if body.to_me else None
    try:
        return await _call(builder.send_report, db, row, "", to)
    except graph_mail.GraphMailError as e:
        raise HTTPException(status_code=424, detail=f"The email was not sent: {str(e)[:300]}") from e


# ── Downloads: XLSX / PDF / CSV (Oct 20 2026, ops_report_export.py) ──────────
#   GET  /ops-reports/export/{kind}?format=xlsx|pdf|csv&facility_ids=a,b&start=&end=&options={json}
#   POST /ops-reports/builder/export?format=...   {spec, name}
# Same door as running the report: anyone who can open Operations > Reports.

from urllib.parse import quote  # noqa: E402

from fastapi import Query, Response  # noqa: E402

import ops_report_export as export  # noqa: E402
import ops_report_schedules as schedules  # noqa: E402


def _file(data: bytes, media: str, fname: str) -> Response:
    ascii_name = fname.encode("ascii", "ignore").decode() or "report"
    return Response(content=data, media_type=media, headers={
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(fname)}",
        "Cache-Control": "no-store"})


def _fmt(value: str) -> str:
    fmt = (value or "xlsx").strip().lower()
    if fmt not in export.MEDIA:
        raise HTTPException(status_code=422, detail="A format is xlsx, pdf or csv")
    return fmt


def _ids(facility_ids: str, facility_id: str = "") -> list[str]:
    ids = [x.strip() for x in (facility_ids or "").split(",") if x.strip()]
    if facility_id and facility_id.strip() and not ids:
        ids = [facility_id.strip()]
    if len(ids) > 50 or any(len(x) > 80 for x in ids):
        raise HTTPException(status_code=422, detail="Pick up to 50 facilities")
    return ids


def _options(raw) -> dict:
    if raw in (None, "", {}):
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise HTTPException(status_code=422, detail="Report options are a JSON object") from None
    if not isinstance(raw, dict) or len(raw) > 20 or not all(
            isinstance(k, str) and len(k) <= 40 and (v is None or isinstance(v, (bool, int, float)) or
                                                      (isinstance(v, str) and len(v) <= 80)) for k, v in raw.items()):
        raise HTTPException(status_code=422, detail="Report options are up to 20 simple switches")
    return raw


def _export_catalog(kind: str, ids: list[str], start: str, end: str, options: dict, fmt: str):
    result = export.run_report(kind, ids, start, end, options)
    if result.get("available") is False:
        raise ops_reports.ReportError(422, "That report is not available from Cubby yet")
    return export.render(result, fmt)


@router.get("/export/{kind}")
async def export_report(kind: str, format: str = Query("xlsx"), facility_ids: str = "", facility_id: str = "",
                        start: str = "", end: str = "", options: str = ""):
    data, media, fname = await _call(_export_catalog, kind, _ids(facility_ids, facility_id), start, end,
                                     _options(options), _fmt(format))
    return _file(data, media, fname)


class BuilderExportBody(BaseModel):
    spec: dict[str, Any]
    name: Optional[str] = ""


def _export_builder(spec: dict, name: str, fmt: str):
    return export.render(export.from_builder(builder.run(spec), name), fmt)


@router.post("/builder/export")
async def builder_export(body: BuilderExportBody, format: str = Query("xlsx")):
    data, media, fname = await _call(_export_builder, body.spec, (body.name or "").strip()[:120], _fmt(format))
    return _file(data, media, fname)


# ── Scheduled catalog reports (ops_report_schedules.py) ──────────────────────
#   GET/POST /ops-reports/schedules, PATCH/DELETE /ops-reports/schedules/{id},
#   POST /ops-reports/schedules/{id}/send  {to_me}
# Listing: your own, the ones you receive, and every one for level 4+.
# Creating and changing: managers and above or the Operations editor grant;
# a schedule is changed by its owner or level 4+ (the saved-report rule).

def _sched_out(r: models.OpsReportSchedule, me: str, level: int) -> dict:
    meta = ops_reports.CATALOG.get(r.kind)
    return {"id": r.id, "name": r.name, "kind": r.kind, "title": meta[0] if meta else r.kind,
            "facilityIds": list(r.facility_ids or []), "period": r.period or {}, "periodLabel": schedules.period_label(r.period),
            "options": r.options or {}, "format": r.format, "frequency": r.frequency, "day": r.day or 0, "hour": r.hour or 0,
            "includeWeekends": bool(r.include_weekends), "active": bool(r.active), "recipients": list(r.recipients or []),
            "describe": schedules.describe(r), "lastSentAt": r.last_sent_at or "", "lastError": r.last_error or "",
            "owner": r.owner_email, "mine": r.owner_email == me, "canEdit": r.owner_email == me or level >= 4,
            "nextRunAt": schedules.next_run_at(r), "createdAt": r.created_at, "updatedAt": r.updated_at}


class ScheduleBody(BaseModel):
    name: Optional[str] = None
    kind: Optional[str] = None
    facilityIds: Optional[list[str]] = None
    period: Optional[dict[str, Any]] = None
    options: Optional[dict[str, Any]] = None
    format: Optional[str] = None
    frequency: Optional[str] = None
    day: Optional[int] = None
    hour: Optional[int] = None
    includeWeekends: Optional[bool] = None
    active: Optional[bool] = None
    recipients: Optional[list[str]] = None


def _sched_apply(db: Session, row: models.OpsReportSchedule, body: ScheduleBody) -> None:
    if body.name is not None:
        name = body.name.strip()[:120]
        if not name:
            raise HTTPException(status_code=422, detail="Give the schedule a name")
        row.name = name
    if body.kind is not None:
        meta = ops_reports.CATALOG.get(body.kind)
        if not meta or meta[3] == "unavailable":
            raise HTTPException(status_code=422, detail="Pick a report")
        row.kind = body.kind
    if body.facilityIds is not None:
        ids = _ids(",".join(body.facilityIds))
        if ids:
            known = {r[0] for r in db.query(models.CubbyFacility.facility_id)
                     .filter(models.CubbyFacility.facility_id.in_(ids), models.CubbyFacility.enabled.is_(True)).all()}
            if set(ids) - known:
                raise HTTPException(status_code=422, detail="One of those facilities is not in Nexus")
        row.facility_ids = ids
    if body.period is not None:
        period = {"mode": body.period.get("mode") or "current", "unit": body.period.get("unit") or "month"}
        try:
            schedules.resolve_period(period, datetime.now(timezone.utc).date())
        except schedules.ScheduleError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        row.period = period
    if body.options is not None:
        row.options = _options(body.options)
    if body.format is not None:
        if body.format not in schedules.FORMATS:
            raise HTTPException(status_code=422, detail="A format is xlsx, pdf or csv")
        row.format = body.format
    if body.frequency is not None:
        if body.frequency not in schedules.FREQUENCIES:
            raise HTTPException(status_code=422, detail="Send it daily, weekly or monthly")
        row.frequency = body.frequency
    if body.day is not None:
        row.day = body.day
    if body.hour is not None:
        if not 0 <= body.hour <= 23:
            raise HTTPException(status_code=422, detail="Pick an hour of the day")
        row.hour = body.hour
    if body.includeWeekends is not None:
        row.include_weekends = bool(body.includeWeekends)
    if body.active is not None:
        row.active = bool(body.active)
    if body.recipients is not None:
        row.recipients = _recipients(db, body.recipients)
    if row.frequency == "weekly" and not 0 <= (row.day or 0) <= 6:
        raise HTTPException(status_code=422, detail="Pick a weekday")
    if row.frequency == "monthly" and not 1 <= (row.day or 0) <= 28:
        raise HTTPException(status_code=422, detail="Pick a day of the month from 1 to 28")
    if not row.recipients:
        raise HTTPException(status_code=422, detail="A scheduled report needs at least one recipient")


def _sched_restart(row: models.OpsReportSchedule) -> None:
    """A new or re-timed schedule starts at its NEXT occurrence: the one that
    already passed today (or this week / month) is not sent late."""
    row.last_sent_period = schedules.due_period(row, schedules.local_now())
    row.last_error = ""


def _sched_own(db: Session, schedule_id: str, user: dict) -> models.OpsReportSchedule:
    row = db.get(models.OpsReportSchedule, schedule_id)
    me = user["email"].lower()
    level = user.get("level", 0)
    if not row or not (row.owner_email == me or level >= 4 or me in (row.recipients or [])):
        raise HTTPException(status_code=404, detail="Schedule not found")
    if row.owner_email != me and level < 4:
        raise HTTPException(status_code=403, detail="Only the person who made this schedule can change it")
    return row


@router.get("/schedules")
def list_schedules(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    level = user.get("level", 0)
    rows = db.query(models.OpsReportSchedule).order_by(models.OpsReportSchedule.name).all()
    seen = [r for r in rows if level >= 4 or r.owner_email == me or me in (r.recipients or [])]
    return {"schedules": [_sched_out(r, me, level) for r in seen],
            "frequencies": [{"key": k, "label": v} for k, v in schedules.FREQUENCIES.items()],
            "formats": [{"key": k, "label": v} for k, v in schedules.FORMATS.items()],
            "units": [{"key": k, "label": v} for k, v in schedules.UNITS.items()],
            "weekdays": schedules.WEEKDAYS, "timeZone": schedules.TZ}


@router.post("/schedules", status_code=201)
def create_schedule(body: ScheduleBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    if not (body.name or "").strip() or not body.kind:
        raise HTTPException(status_code=422, detail="A schedule needs a name and a report")
    me = user["email"].lower()
    row = models.OpsReportSchedule(
        id=builder.new_id(), owner_email=me, name="", kind="", facility_ids=[], period={"mode": "previous", "unit": "month"},
        options={}, format="xlsx", frequency="weekly", day=0, hour=7, include_weekends=False, active=True, recipients=[],
        last_sent_period="", last_sent_at="", last_attempt_at="", last_error="", created_at=_now(), updated_at=_now())
    _sched_apply(db, row, body)
    _sched_restart(row)
    db.add(row)
    db.commit()
    return {"schedule": _sched_out(row, me, user.get("level", 0))}


@router.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: str, body: ScheduleBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    row = _sched_own(db, schedule_id, user)
    was_active = bool(row.active)
    _sched_apply(db, row, body)
    retimed = any(v is not None for v in (body.frequency, body.day, body.hour, body.includeWeekends))
    if retimed or (row.active and not was_active):
        _sched_restart(row)
    elif any(v is not None for v in (body.kind, body.facilityIds, body.period, body.options, body.format, body.recipients)):
        row.last_error = ""
    row.updated_at = _now()
    db.commit()
    return {"schedule": _sched_out(row, user["email"].lower(), user.get("level", 0))}


@router.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: str, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    row = _sched_own(db, schedule_id, user)
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/schedules/{schedule_id}/send")
async def send_schedule(schedule_id: str, body: SendBody, user: dict = Depends(_manage), db: Session = Depends(get_db)):
    """Email it now - to its recipients, or only to the caller (a test).
    Does not count as the period's scheduled send."""
    import graph_mail
    row = await asyncio.to_thread(_sched_own, db, schedule_id, user)
    if not graph_mail.graph_configured() or not graph_mail.DEFAULT_FROM_EMAIL:
        raise HTTPException(status_code=503, detail="Email is not set up on this server")
    to = [user["email"].lower()] if body.to_me else None
    try:
        out = await _call(schedules.send, row, to)
    except schedules.ScheduleError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except graph_mail.GraphMailError as e:
        raise HTTPException(status_code=424, detail=f"The email was not sent: {str(e)[:300]}") from e
    if not body.to_me:
        row.last_sent_at, row.last_error = _now(), ""
        await asyncio.to_thread(db.commit)
    return out
