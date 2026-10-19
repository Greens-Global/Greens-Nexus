"""Operations > Reports and the Report Builder (Neil, Ops review, Oct 20 2026).

  GET  /ops-reports/catalog                  Cubby's report list, grouped, with where each comes from
  GET  /ops-reports/run/{kind}               one report: facility_id, start, end (YYYY-MM-DD)
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

from fastapi import APIRouter, Depends, HTTPException
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
async def run_report(kind: str, facility_id: str = "", start: str = "", end: str = ""):
    return await _call(ops_reports.run, kind, facility_id, start, end)


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
