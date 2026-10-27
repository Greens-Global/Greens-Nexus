"""Accounting > Reports > Schedule C (draft): the account-to-line mapping
(Neil, Viral, 10/27 triage item 18 - "map each and every account number ...
with whatever the mapping code we have").

The figures come from the ledger through routers/accounting.py like every
other statement; only the mapping lives here, in Nexus's own table
(accounting_tax_lines). Nothing is written to Intacct. A mapping row says
which line of the form one GL account adds into, for one entity or for every
entity ('' - an entity's own row overrides it). Reading takes the Accounting
grant; writing takes its editor level, like the flux notes. A person limited
to certain entities reads every mapping that applies to theirs and writes
their own entities' rows only - the every-entity mapping needs unlimited
access.
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

router = APIRouter(prefix="/accounting/tax-lines", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

# The lines an account can add into, per form. Part I income (1, 2, 4, 6),
# Part II expenses (8-27b) and line 30 (business use of home); 3, 5, 7, 28,
# 29 and 31 are worked out from these. "skip" = not on this form.
FORMS = {
    "schedule_c": {
        "1", "2", "4", "6", "8", "9", "10", "11", "12", "13", "14", "15", "16a", "16b", "17", "18", "19",
        "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27a", "27b", "30", "skip",
    },
}
_ENTITY = re.compile(r"^[A-Za-z0-9_-]{1,20}$")
_ACCOUNT = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
_MAX_LINES = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _form(raw: str) -> str:
    form = (raw or "").strip().lower()
    if form not in FORMS:
        raise HTTPException(status_code=400, detail=f"form must be one of {', '.join(sorted(FORMS))}")
    return form


def _entity(raw: str) -> str:
    entity = (raw or "").strip()
    if entity and not _ENTITY.fullmatch(entity):
        raise HTTPException(status_code=400, detail="entity must be an entity code, or empty for every entity")
    return entity


async def _check_write(scope: dict, entity: str) -> None:
    """A limited caller writes their own entities' mapping only."""
    allowed = scope["allowed"]
    if allowed is None:
        return
    if not entity:
        raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities - pick one of them to save its mapping.")
    if entity not in await accounting._with_children(allowed):
        raise HTTPException(status_code=403, detail=f"Your accounting access does not include entity {entity}.")


def _ser(r) -> dict:
    return {"accountNo": r.account_no, "line": r.line, "entity": r.entity or "", "by": r.set_by or "", "at": r.set_at or ""}


@router.get("")
async def list_lines(form: str = "schedule_c", entity: str = "", scope: dict = Depends(entity_scope)):
    """The mapping for every entity, plus `entity`'s own rows when one is named."""
    form, entity = _form(form), _entity(entity)
    if entity and scope["allowed"] is not None and entity not in await accounting._with_children(scope["allowed"]):
        raise HTTPException(status_code=403, detail=f"Your accounting access does not include entity {entity}.")

    def _load():
        db = SessionLocal()
        try:
            wanted = [""] + ([entity] if entity else [])
            rows = db.query(models.AccountingTaxLine).filter(models.AccountingTaxLine.form == form, models.AccountingTaxLine.entity.in_(wanted)).all()
            return [_ser(r) for r in rows]
        finally:
            db.close()
    return {"form": form, "entity": entity, "lines": await asyncio.to_thread(_load)}


class LinePick(BaseModel):
    accountNo: str
    line: str = ""


class LinesBody(BaseModel):
    form: str = "schedule_c"
    entity: str = ""
    lines: list[LinePick]


@router.put("")
async def put_lines(body: LinesBody, scope: dict = Depends(entity_scope), _editor: dict = Depends(require_module_grant("accounting", "editor"))):
    """Set (or, with an empty line, remove) the line of each account given,
    for one entity or every entity. Accounts not given are left as they are."""
    form, entity = _form(body.form), _entity(body.entity)
    if len(body.lines) > _MAX_LINES:
        raise HTTPException(status_code=400, detail=f"Up to {_MAX_LINES} accounts at a time.")
    picks = {}
    for p in body.lines:
        account = (p.accountNo or "").strip()
        line = (p.line or "").strip().lower()
        if not _ACCOUNT.fullmatch(account):
            raise HTTPException(status_code=400, detail="accountNo is required")
        if line and line not in FORMS[form]:
            raise HTTPException(status_code=400, detail=f"{line} is not a line of this form")
        picks[account] = line
    await _check_write(scope, entity)
    me = scope["user"]["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            have = {r.account_no: r for r in db.query(models.AccountingTaxLine).filter(
                models.AccountingTaxLine.form == form, models.AccountingTaxLine.entity == entity,
                models.AccountingTaxLine.account_no.in_(list(picks))).all()} if picks else {}
            for account, line in picks.items():
                row = have.get(account)
                if not line:
                    if row:
                        db.delete(row)
                    continue
                if row:
                    if row.line != line:
                        row.line, row.set_by, row.set_at = line, me, _now()
                else:
                    db.add(models.AccountingTaxLine(id=str(uuid.uuid4()), form=form, entity=entity, account_no=account, line=line, set_by=me, set_at=_now()))
            db.commit()
            rows = db.query(models.AccountingTaxLine).filter(models.AccountingTaxLine.form == form, models.AccountingTaxLine.entity.in_(["", entity] if entity else [""])).all()
            return [_ser(r) for r in rows]
        finally:
            db.close()
    return {"form": form, "entity": entity, "lines": await asyncio.to_thread(_save)}
