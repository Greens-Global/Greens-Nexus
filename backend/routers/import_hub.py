"""Accounting > Tools > Import Hub - the bank statement rules (Charmi, 10/27
call, item 01). The table and why it is shared: import_hub_models.py.

The statement itself never comes here - the screen reads the file, applies
these rules and builds the Intacct import in the browser. Only the rules are
kept, so they apply again to the next statement. Reading takes the Accounting
grant; adding, changing and deleting take its editor level, like the flux
notes and the Schedule C mapping. A rule holds no ledger figures and no
entity, so there is no entity narrowing (routers/accounting.py's
entity_scope applies to ledger reads).
"""
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_module_grant
from database import get_db
from import_hub_models import AccountingStatementRule as Rule

router = APIRouter(prefix="/accounting/import-hub", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

MATCH_TYPES = ("contains", "equals", "starts_with")
DIRECTIONS = ("any", "in", "out")
_ACCOUNT = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
_CODE = re.compile(r"^[A-Za-z0-9 ._&/-]{0,60}$")
_MAX_RULES = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ser(r: Rule) -> dict:
    return {
        "id": r.id, "matchText": r.match_text or "", "matchType": r.match_type or "contains",
        "direction": r.direction or "any", "amount": r.amount,
        "account": r.account or "", "accountName": r.account_name or "",
        "vendorId": r.vendor_id or "", "vendorName": r.vendor_name or "",
        "customerId": r.customer_id or "", "customerName": r.customer_name or "",
        "priority": r.priority if r.priority is not None else 100, "active": bool(r.active),
        "notes": r.notes or "",
        "createdBy": r.created_by or "", "createdAt": r.created_at or "",
        "updatedBy": r.updated_by or "", "updatedAt": r.updated_at or "",
    }


class RuleBody(BaseModel):
    matchText: str
    matchType: str = "contains"
    direction: str = "any"
    amount: Optional[float] = None
    account: str
    accountName: str = ""
    vendorId: str = ""
    vendorName: str = ""
    customerId: str = ""
    customerName: str = ""
    priority: int = 100
    active: bool = True
    notes: str = ""


def _clean(body: RuleBody) -> dict:
    """The rule's fields, checked, with a plain reason for anything wrong."""
    text = " ".join((body.matchText or "").split())
    if not text:
        raise HTTPException(400, "Say what the description holds - the text the rule looks for.")
    if len(text) > 200:
        raise HTTPException(400, "The description text can be up to 200 characters.")
    if body.matchType not in MATCH_TYPES:
        raise HTTPException(400, "Match must be Contains, Equals or Starts With.")
    if body.direction not in DIRECTIONS:
        raise HTTPException(400, "Direction must be Any, Money In or Money Out.")
    amount = None
    if body.amount is not None:
        if body.amount != body.amount or abs(body.amount) > 1e12:
            raise HTTPException(400, "The amount is not a number.")
        amount = round(abs(float(body.amount)), 2)
        if amount == 0:
            amount = None
    account = (body.account or "").strip()
    if not _ACCOUNT.fullmatch(account):
        raise HTTPException(400, "Give the GL account number the matching lines post to.")
    vendor, customer = (body.vendorId or "").strip(), (body.customerId or "").strip()
    if not _CODE.fullmatch(vendor) or not _CODE.fullmatch(customer):
        raise HTTPException(400, "The vendor or customer ID has characters Intacct does not use.")
    if not 0 <= int(body.priority) <= 9999:
        raise HTTPException(400, "Priority runs from 0 to 9999 (lower runs first).")
    return {
        "match_text": text, "match_type": body.matchType, "direction": body.direction, "amount": amount,
        "account": account, "account_name": (body.accountName or "").strip()[:200],
        "vendor_id": vendor, "vendor_name": (body.vendorName or "").strip()[:200] if vendor else "",
        "customer_id": customer, "customer_name": (body.customerName or "").strip()[:200] if customer else "",
        "priority": int(body.priority), "active": 1 if body.active else 0,
        "notes": (body.notes or "").strip()[:1000],
    }


def _ordered(db: Session) -> list:
    return db.query(Rule).order_by(Rule.priority.asc(), Rule.created_at.asc()).all()


@router.get("/rules")
def list_rules(db: Session = Depends(get_db)):
    """Every rule, in the order the screen applies them (priority, then oldest first)."""
    return {"rules": [_ser(r) for r in _ordered(db)]}


@router.post("/rules")
def create_rule(body: RuleBody, user: dict = Depends(require_module_grant("accounting", "editor")), db: Session = Depends(get_db)):
    fields = _clean(body)
    if db.query(Rule).count() >= _MAX_RULES:
        raise HTTPException(400, f"Up to {_MAX_RULES} rules - delete the ones no longer used first.")
    me, now = (user.get("email") or "").lower(), _now()
    row = Rule(id=str(uuid.uuid4()), created_by=me, created_at=now, updated_by=me, updated_at=now, **fields)
    db.add(row)
    db.commit()
    return _ser(row)


@router.put("/rules/{rule_id}")
def update_rule(rule_id: str, body: RuleBody, user: dict = Depends(require_module_grant("accounting", "editor")), db: Session = Depends(get_db)):
    row = db.query(Rule).filter(Rule.id == rule_id).first()
    if not row:
        raise HTTPException(404, "That rule was deleted - refresh the list.")
    for k, v in _clean(body).items():
        setattr(row, k, v)
    row.updated_by, row.updated_at = (user.get("email") or "").lower(), _now()
    db.commit()
    return _ser(row)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: str, _user: dict = Depends(require_module_grant("accounting", "editor")), db: Session = Depends(get_db)):
    row = db.query(Rule).filter(Rule.id == rule_id).first()
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True}
