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

Review status (Charmi, Oct 15: "once a comment has been added should it
maintain the review - comment means that the review is answered?"): a line
is Open until someone writes its explanation, then Answered; a reviewer
Closes it (PUT /review) and may reopen it. Removing the explanation takes an
Answered line back to Open, never a Closed one - the sign-off stays.
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


def _status(note: str, closed: bool) -> str:
    """closed > answered (an explanation is written) > open."""
    return "closed" if closed else "answered" if note else "open"


def _ser(r) -> dict:
    note, closed = r.note or "", bool(r.closed)
    return {"accountNo": r.account_no, "note": note, "by": r.noted_by or "", "at": r.noted_at or "",
            "status": _status(note, closed), "closed": closed, "closedBy": (r.closed_by or "") if closed else "", "closedAt": (r.closed_at or "") if closed else ""}


def _empty(account: str) -> dict:
    return {"accountNo": account, "note": "", "by": "", "at": "", "status": "open", "closed": False, "closedBy": "", "closedAt": ""}


def _find(db, entity: str, period: str, account: str):
    return db.query(models.AccountingFluxNote).filter(
        models.AccountingFluxNote.entity == entity, models.AccountingFluxNote.period == period, models.AccountingFluxNote.account_no == account,
    ).first()


def _account(raw: str) -> str:
    account = (raw or "").strip()
    if not _ACCOUNT.fullmatch(account):
        raise HTTPException(status_code=400, detail="accountNo is required")
    return account


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
    for this entity set and period. Writing one answers the review; removing
    it reopens the review unless a reviewer has closed it."""
    entity, period = _key(body.entity, body.period)
    account = _account(body.accountNo)
    note = (body.note or "").strip()
    if len(note) > _NOTE_MAX:
        raise HTTPException(status_code=400, detail=f"A note holds up to {_NOTE_MAX} characters.")
    await _check_reach(scope, entity)
    me = scope["user"]["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            row = _find(db, entity, period, account)
            if not note:
                if not row:
                    return _empty(account)
                if row.closed:
                    # The sign-off outlives the explanation.
                    row.note, row.noted_by, row.noted_at = "", "", ""
                    db.commit()
                    return _ser(row)
                db.delete(row)
                db.commit()
                return _empty(account)
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


class ReviewBody(BaseModel):
    entity: str = "all"
    period: str
    accountNo: str
    closed: bool


@router.put("/review")
async def put_review(body: ReviewBody, scope: dict = Depends(entity_scope), _editor: dict = Depends(require_module_grant("accounting", "editor"))):
    """Close (sign off) or reopen the review of one account for this entity
    set and period. Reopening goes back to Answered when an explanation is
    written, else to Open."""
    entity, period = _key(body.entity, body.period)
    account = _account(body.accountNo)
    await _check_reach(scope, entity)
    me = scope["user"]["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            row = _find(db, entity, period, account)
            if body.closed:
                if not row:
                    row = models.AccountingFluxNote(id=str(uuid.uuid4()), entity=entity, period=period, account_no=account, note="", noted_by="", noted_at="")
                    db.add(row)
                row.closed, row.closed_by, row.closed_at = True, me, _now()
            else:
                if not row:
                    return _empty(account)
                if not (row.note or ""):
                    db.delete(row)
                    db.commit()
                    return _empty(account)
                row.closed, row.closed_by, row.closed_at = False, "", ""
            db.commit()
            return _ser(row)
        finally:
            db.close()
    return await asyncio.to_thread(_save)
