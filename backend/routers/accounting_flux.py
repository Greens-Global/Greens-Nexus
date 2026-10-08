"""Accounting > Reports > Flux Analysis: the explanation notes (Neil, 10/02:
"MRE needs to be discussed with Charmi / Flux Analysis" - the first cut is
this period against the one before it, per account, with the variance over
a threshold flagged and an explanation kept per account and period).

The figures come from the ledger through routers/accounting.py like every
other statement; only the notes live here, in Nexus's own table
(accounting_flux_notes). A note belongs to an entity set, an account and a
period, so the same close finds the same explanation. Reading takes the
Accounting grant; writing takes its editor level, like close commentary. A
person limited to certain entities reads and writes notes for those only.
"""
import asyncio
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting
from routers.accounting import entity_scope

router = APIRouter(prefix="/accounting/flux-notes", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

_PERIOD = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$")
_ENTITY = re.compile(r"^(all|[A-Za-z0-9_-]{1,20}(,[A-Za-z0-9_-]{1,20}){0,60})$")
_ACCOUNT = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
_NOTE_MAX = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key(entity: str, period: str) -> tuple[str, str]:
    entity = ",".join(sorted(set(accounting._csv(entity)))) or "all"
    if not _ENTITY.fullmatch(entity):
        raise HTTPException(status_code=400, detail="entity must be entity codes or 'all'")
    if not _PERIOD.fullmatch(period or ""):
        raise HTTPException(status_code=400, detail="period must be <from>_<to> as YYYY-MM-DD")
    return entity, period


async def _check_reach(scope: dict, entity: str) -> None:
    """A limited caller only touches notes of entities they may read."""
    allowed = scope["allowed"]
    if allowed is None:
        return
    if entity == "all" or not allowed:
        raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities - pick them on the report.")
    reach = await accounting._with_children(allowed)
    outside = [c for c in entity.split(",") if c not in reach]
    if outside:
        raise HTTPException(status_code=403, detail=f"Your accounting access does not include entity {', '.join(outside)}.")


def _ser(r) -> dict:
    return {"accountNo": r.account_no, "note": r.note or "", "by": r.noted_by or "", "at": r.noted_at or ""}


@router.get("")
async def list_notes(entity: str = "all", period: str = "", scope: dict = Depends(entity_scope)):
    """Every explanation kept for this entity set and period."""
    entity, period = _key(entity, period)
    await _check_reach(scope, entity)

    def _load():
        db = SessionLocal()
        try:
            rows = db.query(models.AccountingFluxNote).filter(models.AccountingFluxNote.entity == entity, models.AccountingFluxNote.period == period).all()
            return [_ser(r) for r in rows]
        finally:
            db.close()
    return {"entity": entity, "period": period, "notes": await asyncio.to_thread(_load)}


class NoteBody(BaseModel):
    entity: str = "all"
    period: str
    accountNo: str
    note: str = ""


@router.put("")
async def put_note(body: NoteBody, scope: dict = Depends(entity_scope), _editor: dict = Depends(require_module_grant("accounting", "editor"))):
    """Write (or, with an empty note, remove) the explanation on one account
    for this entity set and period."""
    entity, period = _key(body.entity, body.period)
    account = (body.accountNo or "").strip()
    if not _ACCOUNT.fullmatch(account):
        raise HTTPException(status_code=400, detail="accountNo is required")
    note = (body.note or "").strip()
    if len(note) > _NOTE_MAX:
        raise HTTPException(status_code=400, detail=f"A note holds up to {_NOTE_MAX} characters.")
    await _check_reach(scope, entity)
    me = scope["user"]["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            row = db.query(models.AccountingFluxNote).filter(
                models.AccountingFluxNote.entity == entity, models.AccountingFluxNote.period == period, models.AccountingFluxNote.account_no == account,
            ).first()
            if not note:
                if row:
                    db.delete(row)
                    db.commit()
                return {"accountNo": account, "note": "", "by": "", "at": ""}
            if row:
                row.note, row.noted_by, row.noted_at = note, me, _now()
            else:
                row = models.AccountingFluxNote(id=str(uuid.uuid4()), entity=entity, period=period, account_no=account, note=note, noted_by=me, noted_at=_now())
                db.add(row)
            db.commit()
            return _ser(row)
        finally:
            db.close()
    return await asyncio.to_thread(_save)
