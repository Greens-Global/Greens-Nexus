"""Operations > Ops Budget - the API (Oct 21 2026).

  GET  /ops-budget/facilities         the five sites, the months each has, the default month
  GET  /ops-budget?facility=&segment=&month=&period=month|ytd
                                      every metric's budget, actual and prior year with
                                      variances, the summary headline and lists
  GET  /ops-budget/trend?facility=&segment=&months=24[&month=]
                                      month-end actuals for the charts, with their takeaways
  POST /ops-budget/upload             the Ops Budget workbook: commit=false -> preview,
                                      commit=true -> upsert (admins only)
  GET  /ops-budget/loads              uploads and Cubby snapshot runs (admins only)
  GET  /ops-budget/loads/{id}/file    the workbook as uploaded (admins only)
  POST /ops-budget/snapshot           run the Cubby month-end snapshot now (admins only)

Reads: the Operations door, like /facility-ops (supervisors and above, or an
Operations grant); every reader sees all five sites until per-site access is
decided. Writes: administrators, or an Operations Owner grant. Aggregates only
- no tenant name or contact detail is stored or returned. Endpoints are plain
`def` (FastAPI's threadpool): the parse and the queries block.
"""
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import ops_budget as ob
import ops_budget_cubby
import ops_budget_workbook as wbk
from auth import _module_level, require_level_or_module
from database import get_db
from ops_budget_models import OpsBudgetLoad

router = APIRouter(prefix="/ops-budget", tags=["Operations"])

require_read = require_level_or_module(2, "operations", "viewer")
require_admin = require_level_or_module(4, "operations", "owner")


def _can_upload(user: dict, db: Session) -> bool:
    try:
        return user.get("level", 0) >= 4 or _module_level(user["email"], "operations", db) >= 4
    except Exception:  # noqa: BLE001 - a grant lookup blip only hides the button
        return False


def _facility(db: Session, fid: str):
    fac = ob.facility(db, fid)
    if fac is None:
        raise HTTPException(404, "No such facility")
    return fac


def _check(segment: str, month: str, period: str = "month"):
    if segment not in ob.SEGMENTS:
        raise HTTPException(422, "segment must be self_storage or vehicle")
    if period not in ("month", "ytd"):
        raise HTTPException(422, "period must be month or ytd")
    if not ob.valid_month(month):
        raise HTTPException(422, "month must be YYYY-MM")
    if month < ob.HISTORY_FROM or month > ob.ym(ob.today_local()):
        raise HTTPException(422, "That month is outside the Ops Budget history")


def _load_json(r: OpsBudgetLoad) -> dict:
    return {"id": r.id, "facilityId": r.facility_id, "kind": r.kind, "fileName": r.file_name or "",
            "fileSize": r.file_size or 0, "months": len(r.months or []), "rows": r.rows_written or 0,
            "unknownHeaders": r.unknown_headers or [], "missingHeaders": r.missing_headers or [],
            "warnings": (r.warnings or [])[:50], "status": r.status, "error": r.error or "",
            "by": r.loaded_by or "", "at": r.loaded_at or ""}


@router.get("/facilities")
def list_facilities(user: dict = Depends(require_read), db: Session = Depends(get_db)):
    facs = ob.facilities(db)
    last = {}
    for r in (db.query(OpsBudgetLoad.facility_id, OpsBudgetLoad.loaded_at, OpsBudgetLoad.kind)
              .order_by(OpsBudgetLoad.loaded_at.desc()).limit(500).all()):
        last.setdefault((r[0], r[2]), r[1])
    for f in facs:
        f["dataRange"] = ob.data_range(db, f["id"])
        f["lastWorkbookAt"] = last.get((f["id"], "workbook"), "")
        f["lastCubbyAt"] = last.get((f["id"], "cubby"), "")
    return {"facilities": facs, "defaultMonth": ob.default_month(), "currentMonth": ob.ym(ob.today_local()),
            "historyFrom": ob.HISTORY_FROM, "cubbyFrom": ob.CUBBY_FROM, "segments": ob.SEGMENTS,
            "canUpload": _can_upload(user, db)}


@router.get("")
def report(facility: str, segment: str = "self_storage", month: str = "", period: str = "month",
           user: dict = Depends(require_read), db: Session = Depends(get_db)):
    month = month or ob.default_month()
    _check(segment, month, period)
    fac = _facility(db, facility)
    out = ob.report_for(db, fac, segment, month, period)
    out["definitions"] = ob.definitions(segment)
    return out


@router.get("/trend")
def trend(facility: str, segment: str = "self_storage", months: int = 24, month: str = "",
          user: dict = Depends(require_read), db: Session = Depends(get_db)):
    month = month or ob.default_month()
    _check(segment, month)
    if not 2 <= months <= 60:
        raise HTTPException(422, "months must be between 2 and 60")
    return ob.trend_for(db, _facility(db, facility), segment, month, months)


@router.post("/upload")
def upload(file: UploadFile = File(...), facility_id: str = Form(""), commit: bool = Form(False),
           user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    raw = file.file.read(wbk.MAX_BYTES + 1)
    try:
        preview = wbk.build_preview(db, raw, file.filename or "", facility_id)
    except wbk.WorkbookError as e:
        raise HTTPException(400, str(e)) from e
    shown = wbk.public(preview)
    if not commit:
        return {**shown, "saved": False}
    if preview["errors"]:
        raise HTTPException(400, preview["errors"][0])
    try:
        result = wbk.save(db, preview, raw, by=user.get("email") or "")
    except wbk.WorkbookError as e:
        db.rollback()
        raise HTTPException(400, str(e)) from e
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(409, "Another upload for this site was saving at the same time. Try again.") from e
    return {**shown, **result, "saved": True}


@router.get("/loads")
def loads(facility: str = "", user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    q = db.query(OpsBudgetLoad)
    if facility:
        q = q.filter(OpsBudgetLoad.facility_id == facility)
    return {"loads": [_load_json(r) for r in q.order_by(OpsBudgetLoad.loaded_at.desc()).limit(50).all()]}


@router.get("/loads/{load_id}/file")
def load_file(load_id: str, user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    r = db.get(OpsBudgetLoad, load_id)
    if r is None or r.kind != "workbook" or not r.file_bytes:
        raise HTTPException(404, "No such upload")
    name = (r.file_name or "ops-budget.xlsx").replace('"', "")
    return Response(content=r.file_bytes,
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/snapshot")
def snapshot_now(user: dict = Depends(require_admin)):
    """Write this month's Cubby actuals now instead of waiting for the next run."""
    return {"results": ops_budget_cubby.snapshot_all()}
