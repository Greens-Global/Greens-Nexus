"""Investor Relations, live from the books (Neil, 11/11/2026) - the routes.

The rules are investor_books.py. A deal links to the Intacct ENTITY it is
(ir_funds.intacct_entity, e.g. 67000 Greens Austin, LLC); an investor profile
links to their own partner equity ACCOUNTS (ir_investors.intacct_accounts,
e.g. 30016,31010,32013 for Neil Kadakia). Every figure is read live through
the accounting proxy (routers/accounting._acct_get, its 5-minute cache, the
accrual book) - nothing here touches the accounting database, writes to the
books or keys a figure into Nexus.

Who sees what: the Investor Relations read gate, AND the Accounting grant,
AND the entity inside the caller's accounting entity access (exactly as on
Reports and on a Construction job's Money). Someone without it gets
{allowed: false, reason} - never a figure. Linking and importing take the
Investor Relations editor gate plus the same Accounting checks.

Database reads run in SYNC dependencies (the threadpool) and writes in
asyncio.to_thread, so no query sits on the event loop; the async handlers
only await the accounting app.

  GET  /investor-relations/books/entities          entities holding partner capital (the link picker, Import)
  GET  /investor-relations/books/partners          the investors in the chart of accounts (the link picker)
  PUT  /investor-relations/funds/{id}/books        link a deal to its entity
  PUT  /investor-relations/investors/{id}/books    link a profile to its partner accounts
  GET  /investor-relations/funds/{id}/books        a deal's live figures and members
  GET  /investor-relations/funds-books             every linked deal's headline figures
  GET  /investor-relations/investors/{id}/books    a profile's live positions, entity by entity
  POST /investor-relations/books/import            a deal and its members' profiles from one entity
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import investor_books as ib
import maintenance_services
from construction_money import has_accounting_grant
from database import get_db
from models import IrCommitment, IrFund, IrInvestor
from routers import accounting as acct
from routers import investor_relations as ir

router = APIRouter(prefix="/investor-relations", tags=["Investor Relations"])

NO_GRANT = "Live figures come from Intacct and need Accounting access."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _accounts_of(v: IrInvestor) -> list:
    return [a for a in (v.intacct_accounts or "").split(",") if a]


def _investor_of(db: Session) -> dict:
    """{account_no: (investor_id, display_name)} for every linked account."""
    out = {}
    for v in db.query(IrInvestor).filter(IrInvestor.intacct_accounts != "").all():
        for a in _accounts_of(v):
            out[a] = (v.id, v.display_name)
    return out


def _deal_of(db: Session) -> dict:
    """{entity code: (fund_id, name)} for every linked deal."""
    return {f.intacct_entity: (f.id, f.name)
            for f in db.query(IrFund).filter(IrFund.intacct_entity != "").all()}


def _ctx(user: dict, db: Session) -> dict:
    return {"user": user, "db": db, "why": "" if has_accounting_grant(user, db) else NO_GRANT,
            "allowed": acct.allowed_entities(user, db),
            # The company's day (its team zone), not the server's UTC one.
            "today": maintenance_services.local_today(db).isoformat()}


def _view_ctx(user: dict = Depends(ir.require_ir_view), db: Session = Depends(get_db)) -> dict:
    return _ctx(user, db)


def _edit_ctx(user: dict = Depends(ir.require_ir_edit), db: Session = Depends(get_db)) -> dict:
    ctx = _ctx(user, db)
    if ctx["why"]:
        raise HTTPException(403, "Linking to Intacct needs Accounting access.")
    return ctx


def _off(why: str) -> dict:
    return {"allowed": False, "reason": why}


async def _reach(allowed) -> Optional[set]:
    """The entity codes the caller may read, with their sub-entities; None = every one."""
    if allowed is None:
        return None
    return await acct._with_children(set(allowed)) if allowed else set()


async def _entity_ok(allowed, entity: str) -> bool:
    reach = await _reach(allowed)
    return bool(entity) and (reach is None or entity in reach)


async def _entity_names() -> dict:
    data = await acct._acct_get("/api/internal/reports/locations", {})
    return {e.get("code"): e.get("name") or "" for e in data.get("entities") or [] if e.get("code")}


async def _chart(ctx: dict) -> list:
    """The chart of accounts (or, until the accounting app has its chart
    route, the accounts on the ledger of the entities the caller may read) -
    exactly what Records > General Ledger Accounts shows the caller."""
    data = await acct.list_accounts({"user": ctx["user"], "allowed": ctx["allowed"]})
    return data.get("accounts") or []


async def _by_entity(ctx: dict) -> tuple[dict, dict, dict]:
    """One read of every entity column the caller may see, from the start of
    the books: ({entity: {account: balance}}, {account: title}, {entity: name})."""
    location, locations = await acct._limit({"user": ctx["user"], "allowed": ctx["allowed"]}, None, None)
    data = await acct._acct_get("/api/internal/reports/buckets",
                                {"to": ctx["today"], "by": "entity", "location": location, "locations": locations})
    rows = data.get("rows") or []
    titles = ib.titles(rows)
    return ib.balances(rows, by_bucket=True), titles, data.get("labels") or {}


async def _entity_total(entity: str, today: str, from_: Optional[str] = None) -> list:
    data = await acct._acct_get("/api/internal/reports/buckets",
                                {"to": today, "from": from_, "by": "total", "location": entity})
    return data.get("rows") or []


# ── Pickers ──────────────────────────────────────────────────────────────────
def _deals_ctx(ctx: dict = Depends(_view_ctx)) -> dict:
    return {**ctx, "deals": _deal_of(ctx["db"])}


@router.get("/books/entities")
async def book_entities(ctx: dict = Depends(_deals_ctx)):
    """Entities holding partner capital the caller may read, biggest first:
    [{code, name, partnerCapital, members, fundId, fundName}]."""
    if ctx["why"]:
        return _off(ctx["why"])
    try:
        by_entity, titles, labels = await _by_entity(ctx)
    except HTTPException as e:
        return _off(str(e.detail))
    out = []
    for code, bal in by_entity.items():
        rows = ib.members(bal, titles, {})
        if not rows:
            continue
        deal = ctx["deals"].get(code) or ("", "")
        out.append({"code": code, "name": labels.get(code) or code, "members": len(rows),
                    "partnerCapital": ib.r2(sum(r["balance"] for r in rows)),
                    "fundId": deal[0], "fundName": deal[1]})
    out.sort(key=lambda e: -e["partnerCapital"])
    return {"allowed": True, "entities": out}


def _partners_ctx(ctx: dict = Depends(_view_ctx)) -> dict:
    return {**ctx, "investorOf": _investor_of(ctx["db"])}


@router.get("/books/partners")
async def book_partners(ctx: dict = Depends(_partners_ctx)):
    """The investors in the chart of accounts, one per name, with the profile
    each account is linked to: [{key, name, accounts: [{accountNo, title,
    kind, active, investorId, investorName}]}]."""
    if ctx["why"]:
        return _off(ctx["why"])
    try:
        partners = ib.partners_from_chart(await _chart(ctx))
    except HTTPException as e:
        return _off(str(e.detail))
    for p in partners:
        for a in p["accounts"]:
            inv = ctx["investorOf"].get(a["accountNo"]) or ("", "")
            a["investorId"], a["investorName"] = inv
    return {"allowed": True, "partners": partners}


# ── Linking ──────────────────────────────────────────────────────────────────
class EntityIn(BaseModel):
    entity: Optional[str] = ""


def _commit_once(db: Session, entity: str) -> None:
    """Commit; the unique index on ir_funds.intacct_entity turns a second
    deal on one entity (two clicks at once) into a 409, never a duplicate."""
    from sqlalchemy.exc import IntegrityError
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Entity {entity} was just linked to another deal - reload and try again.")


def _save_fund_entity(db: Session, fund_id: str, entity: str) -> dict:
    f = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    if entity:
        other = db.query(IrFund).filter(IrFund.intacct_entity == entity, IrFund.id != fund_id).first()
        if other:
            raise HTTPException(409, f"Entity {entity} is already linked to the deal \"{other.name}\".")
    f.intacct_entity = entity
    f.updated_at = _now()
    _commit_once(db, entity)
    return {"fundId": f.id, "intacctEntity": entity}


def _fund_ctx(fund_id: str, ctx: dict = Depends(_edit_ctx)) -> dict:
    f = ctx["db"].query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    return {**ctx, "was": f.intacct_entity or ""}


@router.put("/funds/{fund_id}/books")
async def link_fund(fund_id: str, body: EntityIn, ctx: dict = Depends(_fund_ctx)):
    """Link a deal to the Intacct entity it is ('' unlinks). The caller must
    read both the entity it links to now and the new one; one entity is one deal."""
    entity = (body.entity or "").strip()
    if ctx["was"] and not await _entity_ok(ctx["allowed"], ctx["was"]):
        raise HTTPException(403, "This deal is linked to an entity outside your accounting access.")
    if entity:
        if not ib.valid_code(entity):
            raise HTTPException(422, "That is not an Intacct entity code.")
        # Access first, so a refusal never tells whether a code outside it exists.
        if not await _entity_ok(ctx["allowed"], entity):
            raise HTTPException(403, f"Your accounting access does not include entity {entity}.")
        if entity not in await _entity_names():
            raise HTTPException(422, f"Entity {entity} is not on the books.")
    return await asyncio.to_thread(_save_fund_entity, ctx["db"], fund_id, entity)


class AccountsIn(BaseModel):
    accounts: list[str] = []


def _save_investor_accounts(db: Session, investor_id: str, accounts: list) -> dict:
    v = db.query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not v:
        raise HTTPException(404, "Investor not found")
    taken = {a: who for a, who in _investor_of(db).items() if who[0] != investor_id and a in accounts}
    if taken:
        a, who = sorted(taken.items())[0]
        raise HTTPException(409, f"Account {a} is already linked to {who[1]}.")
    v.intacct_accounts = ",".join(accounts)
    v.updated_at = _now()
    db.commit()
    return {"investorId": v.id, "intacctAccounts": accounts}


def _investor_ctx(investor_id: str, ctx: dict = Depends(_edit_ctx)) -> dict:
    v = ctx["db"].query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not v:
        raise HTTPException(404, "Investor not found")
    return {**ctx, "current": set(_accounts_of(v))}


@router.put("/investors/{investor_id}/books")
async def link_investor(investor_id: str, body: AccountsIn, ctx: dict = Depends(_investor_ctx)):
    """Link a profile to its partner equity accounts ([] unlinks). Every
    account must be an investor's account in the chart (300xx E&C, 310xx
    Contribution, 320xx Distribution), and no account belongs to two profiles."""
    accounts = sorted({str(a).strip() for a in body.accounts or [] if str(a).strip()})
    if len(accounts) > 60:
        raise HTTPException(422, "That is too many accounts for one investor.")
    if accounts:
        known = {a["accountNo"] for p in ib.partners_from_chart(await _chart(ctx)) for a in p["accounts"]}
        # An account already linked may stay even if it left the chart; only
        # a NEW link has to be an investor's account.
        bad = [a for a in accounts if a not in known and a not in ctx["current"]]
        if bad:
            raise HTTPException(422, f"{', '.join(bad)} is not an investor's equity account in Intacct.")
    return await asyncio.to_thread(_save_investor_accounts, ctx["db"], investor_id, accounts)


# ── Live figures ─────────────────────────────────────────────────────────────
def _deal_ctx(fund_id: str, ctx: dict = Depends(_view_ctx)) -> dict:
    db = ctx["db"]
    f = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    # What Nexus's own records say each investor paid in and got back, to set
    # beside the books (a gap means a call or distribution was not recorded) -
    # read only when the books will be shown.
    nexus = {}
    pairs = [] if ctx["why"] or not f.intacct_entity else \
        db.query(IrCommitment.investor_id).filter(IrCommitment.fund_id == f.id).distinct().all()
    for (iid,) in pairs:
        a = ir._capital_account(db, f, iid)
        if a:
            nexus[iid] = {"called": ib.r2(a["called"]), "distributed": ib.r2(a["distributed"])}
    return {**ctx, "fundId": f.id, "entity": f.intacct_entity or "", "investorOf": _investor_of(db), "nexus": nexus}


@router.get("/funds/{fund_id}/books")
async def deal_books(ctx: dict = Depends(_deal_ctx)):
    """A deal's live figures from its entity: the property (cash, assets,
    liabilities, book equity, this year's revenue and net income) and every
    member's capital (E&C, contributed, distributed, balance, share), each
    member with what Nexus recorded beside it."""
    if ctx["why"]:
        return _off(ctx["why"])
    entity, today = ctx["entity"], ctx["today"]
    out = {"allowed": True, "linked": bool(entity), "entity": entity, "asOf": today, "book": "accrual"}
    if not entity:
        return out
    if not await _entity_ok(ctx["allowed"], entity):
        return _off("This deal's entity is outside your accounting access.")
    try:
        bs, pl, names = await asyncio.gather(_entity_total(entity, today), _entity_total(entity, today, today[:4] + "-01-01"),
                                             _entity_names())
    except HTTPException as e:
        return {**out, "booksError": str(e.detail)}
    titles = ib.titles(bs)
    rows = ib.members(ib.balances(bs), titles, ctx["investorOf"])
    for r in rows:
        if r["investorId"] in ctx["nexus"]:
            r["nexus"] = ctx["nexus"][r["investorId"]]
    return {**out, "entityName": names.get(entity, ""), "property": ib.property_figures(bs, pl),
            "partnerCapital": ib.r2(sum(r["balance"] for r in rows)), "members": rows}


@router.get("/funds-books")
async def deals_books(ctx: dict = Depends(_deals_ctx)):
    """{allowed, deals: {fundId: {entity, partnerCapital, bookEquity, cash}}}
    for every linked deal the caller may read - one cached read per entity.
    A deal whose books cannot be read carries `error` instead."""
    if ctx["why"]:
        return _off(ctx["why"])
    reach = await _reach(ctx["allowed"])
    deals = [(code, fid) for code, (fid, _) in ctx["deals"].items() if reach is None or code in reach]
    today = ctx["today"]

    async def one(code: str):
        try:
            bs = await _entity_total(code, today)
        except HTTPException as e:
            return {"entity": code, "error": str(e.detail)}
        p = ib.property_figures(bs, [])
        return {"entity": code, "partnerCapital": ib.r2(sum(ib.balances(bs).values())),
                "bookEquity": p["bookEquity"], "cash": p["cash"]}
    figures = await asyncio.gather(*(one(code) for code, _ in deals))
    return {"allowed": True, "asOf": today, "deals": {fid: fig for (_, fid), fig in zip(deals, figures)}}


def _positions_ctx(investor_id: str, ctx: dict = Depends(_view_ctx)) -> dict:
    v = ctx["db"].query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not v:
        raise HTTPException(404, "Investor not found")
    return {**ctx, "accounts": _accounts_of(v), "name": v.display_name, "deals": _deal_of(ctx["db"])}


@router.get("/investors/{investor_id}/books")
async def investor_books(ctx: dict = Depends(_positions_ctx)):
    """A profile's live capital in every entity the caller may read, from its
    linked accounts: [{entity, name, ec, contributed, distributed, balance,
    fundId}], plus the total."""
    if ctx["why"]:
        return _off(ctx["why"])
    out = {"allowed": True, "accounts": ctx["accounts"], "asOf": ctx["today"], "positions": [], "total": 0.0}
    if not ctx["accounts"]:
        return out
    try:
        by_entity, titles, labels = await _by_entity(ctx)
    except HTTPException as e:
        return {**out, "booksError": str(e.detail)}
    mine = set(ctx["accounts"])
    me = {a: ("me", ctx["name"]) for a in mine}
    for code, bal in by_entity.items():
        rows = ib.members({a: v for a, v in bal.items() if a in mine}, titles, me)
        if rows:
            r = rows[0]
            deal = ctx["deals"].get(code) or ("", "")
            out["positions"].append({"entity": code, "name": labels.get(code) or code, "accounts": r["accounts"],
                                     "ec": r["ec"], "contributed": r["contributed"], "distributed": r["distributed"],
                                     "balance": r["balance"], "fundId": deal[0], "fundName": deal[1]})
    out["positions"].sort(key=lambda p: -p["balance"])
    out["total"] = ib.r2(sum(p["balance"] for p in out["positions"]))
    return out


# ── Import a deal's members from the books ──────────────────────────────────
class ImportIn(BaseModel):
    entity: str


def _import(db: Session, user: dict, entity: str, entity_name: str, members: list, partners: list) -> dict:
    """The deal for `entity` (the one linked to it, else a new one) and a
    linked profile for every member: a profile already linked keeps its
    links; one with the same name and no links yet is linked; anyone else
    gets a new profile. Nothing is deleted, no commitment is invented."""
    now = _now()
    f = db.query(IrFund).filter(IrFund.intacct_entity == entity).with_for_update().first()
    fund_created = False
    if not f:
        f = IrFund(id=str(uuid.uuid4()), name=entity_name or entity, entity_name=entity_name, status="active",
                   intacct_entity=entity, created_by=user["email"], created_at=now, updated_at=now)
        db.add(f)
        fund_created = True
    family = {p["key"]: [a["accountNo"] for a in p["accounts"]] for p in partners}
    linked_to = _investor_of(db)
    by_name = {}
    for v in db.query(IrInvestor).all():
        if not _accounts_of(v):
            by_name.setdefault(ib.partner_key(v.display_name), v)
    created = linked = kept = 0
    for m in members:
        if m["investorId"]:
            kept += 1
            continue
        key = ib.partner_key(m["name"])
        # The partner's whole account family from the chart, minus any account
        # another profile already holds.
        accounts = sorted({a for a in family.get(key, []) + m["accounts"] if a not in linked_to})
        # A profile already holding part of this family (a new account added
        # in Intacct later) takes the rest - never a second profile.
        holder = next((linked_to[a][0] for a in family.get(key, []) if a in linked_to), "")
        v = db.get(IrInvestor, holder) if holder else by_name.pop(key, None)
        if v:
            accounts = sorted(set(_accounts_of(v)) | set(accounts))
            linked += 1
        else:
            v = IrInvestor(id=str(uuid.uuid4()), display_name=m["name"], entity_type=ib.entity_type_of(m["name"]),
                           status="active", notes="Added from the Intacct partner accounts.",
                           created_by=user["email"], created_at=now)
            db.add(v)
            created += 1
        v.intacct_accounts = ",".join(accounts)
        v.updated_at = now
        for a in accounts:
            linked_to[a] = (v.id, v.display_name)
    _commit_once(db, entity)
    return {"fundId": f.id, "fundCreated": fund_created, "created": created, "linked": linked, "kept": kept}


def _import_ctx(ctx: dict = Depends(_edit_ctx)) -> dict:
    return {**ctx, "investorOf": _investor_of(ctx["db"])}


@router.post("/books/import")
async def import_entity(body: ImportIn, ctx: dict = Depends(_import_ctx)):
    """Bring one entity in from the books: its deal and a profile for each
    member, every profile linked to its partner accounts."""
    entity = (body.entity or "").strip()
    if not ib.valid_code(entity):
        raise HTTPException(422, "That is not an Intacct entity code.")
    if not await _entity_ok(ctx["allowed"], entity):
        raise HTTPException(403, f"Your accounting access does not include entity {entity}.")
    names = await _entity_names()
    if entity not in names:
        raise HTTPException(422, f"Entity {entity} is not on the books.")
    bs, chart = await asyncio.gather(_entity_total(entity, ctx["today"]), _chart(ctx))
    titles = ib.titles(bs)
    members = ib.members(ib.balances(bs), titles, ctx["investorOf"])
    if not members:
        raise HTTPException(422, f"Entity {entity} has no partner capital on the books.")
    return await asyncio.to_thread(_import, ctx["db"], ctx["user"], entity, names[entity], members,
                                   ib.partners_from_chart(chart))
