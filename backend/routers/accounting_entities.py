"""Accounting > Entities (Neil, 11/17/2026, plan https://claude.ai/artifact/JZmUfATX7NvH2Qq4kAkJb1).

One page per legal entity: who it is (the legal record), who owns it and
what it owns (the structure chart and the look-through), and how it is doing
(the books, read live). The rules are legal_entities.py.

One home for every fact:
  * the books name, parent and every figure - the accounting app, read live
    through routers/accounting._acct_get (its 5-minute cache), never stored;
  * the legal facts - `legal_entities`, keyed by the Intacct entity code; an
    entity that is also a Nexus company reads its legal name, EIN, address
    and signatory from Settings > Companies and keeps those columns blank;
  * ownership - a deal's members on their Investor Relations commitments
    (membership %), for an entity that IS a deal; `legal_entity_owners` for
    every other entity. A row for a deal's entity is refused (409);
  * an investor profile that is one of our entities - `ir_investors.
    legal_entity_code`, the step the chart climbs through;
  * management - Management Fee agreements (`accounting_ama_agreements`),
    else the entity's own `manager_code`.

Who sees what: the Accounting grant AND the entity inside the caller's
accounting entity access (with its sub-entities), exactly as Reports. An
entity outside it answers 404. Member names and percentages from Investor
Relations need the Investor Relations read gate as well; without it a deal's
members show as a count. Editing takes Accounting Editor; showing the whole
EIN, and marking an entity Dissolved or Sold, take Full (the reveal is a POST,
so the Audit Log keeps who looked). Investor Relations staff see a deal's
Legal line (no figures, EIN ending only) through the IR read gate alone
(Neil, 11/17/2026, decision 4).

Database work runs in sync dependencies or asyncio.to_thread; the async
handlers only await the accounting app.

  GET  /accounting/entities                       the list (legal record + deal + owners summary)
  GET  /accounting/entities/figures?codes=        cash, assets, liabilities, book equity per entity
  GET  /accounting/entities/structure             every entity, owner and link the caller may see
  GET  /accounting/entities/{code}                one entity's whole record
  PUT  /accounting/entities/{code}                save the legal record (rev)
  POST /accounting/entities/{code}/ein            the whole EIN (Full)
  GET  /accounting/entities/{code}/books          the entity's live figures
  GET  /accounting/entities/{code}/agreements     fees, leases, recurring expenses, construction jobs
  GET  /accounting/entities/{code}/suggestions    Fill From - values already in Nexus, never applied by themselves
  POST /accounting/entities/{code}/owners         add an owner (not for a deal's entity)
  PUT  /accounting/entities/{code}/owners/{id}    correct an owner row
  POST /accounting/entities/{code}/owners/{id}/end   the owner left (kept, never deleted)
  GET  /investor-relations/funds/{id}/legal       a deal's Legal line
  PUT  /investor-relations/investors/{id}/entity  an investor that is one of our entities
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

import investor_books as ib
import legal_entities as L
import maintenance_services
import models
import property_links
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user
from database import get_db
from routers import accounting as acct
from routers import investor_relations as ir

router = APIRouter(prefix="/accounting/entities", tags=["Accounting"])
ir_router = APIRouter(prefix="/investor-relations", tags=["Investor Relations"])

_MAX_FIGURE_CODES = 80
_INVESTOR_TYPE_WORDS = {"individual": "Individual", "llc": "LLC", "trust": "Trust", "ira": "IRA",
                        "corporation": "Corporation", "partnership": "Partnership"}
_FIGURE_SEM = asyncio.Semaphore(6)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _grant_at_least(user: dict, db: Session, level: str) -> bool:
    if int(user.get("level") or 0) >= _LEVELS["administrator"]:
        return True
    return _module_level(user["email"], "accounting", db) >= _MODULE_LEVEL_RANK[level]


def _ir_reader(user: dict, db: Session) -> bool:
    try:
        ir.require_ir_view(user, db)
        return True
    except HTTPException:
        return False


def _ctx(scope: dict = Depends(acct.entity_scope), db: Session = Depends(get_db)) -> dict:
    """The caller, their entity reach and what they may do. Sync: the
    threadpool runs it, so no query sits on the event loop."""
    user = scope["user"]
    return {"user": user, "db": db, "allowed": scope["allowed"],
            "edit": _grant_at_least(user, db, "editor"), "full": _grant_at_least(user, db, "full"),
            "ir": _ir_reader(user, db), "today": maintenance_services.local_today(db).isoformat()}


async def _books() -> list:
    data = await acct._acct_get("/api/internal/reports/locations", {})
    return [e for e in data.get("entities") or [] if e.get("code")]


async def _reach(allowed) -> Optional[set]:
    if allowed is None:
        return None
    return await acct._with_children(set(allowed)) if allowed else set()


def _in(reach, code: str) -> bool:
    return reach is None or code in reach


async def _visible(ctx: dict) -> tuple[list, Optional[set]]:
    if ctx["allowed"] is not None and not ctx["allowed"]:
        raise HTTPException(403, "No accounting entities have been assigned to you yet.")
    books, reach = await asyncio.gather(_books(), _reach(ctx["allowed"]))
    return [e for e in books if _in(reach, e["code"])], reach


async def _one(ctx: dict, code: str) -> tuple[dict, list, Optional[set]]:
    """The entity from the books, if the caller may read it - else 404, so a
    refusal never tells whether a code outside their access exists."""
    if not L.valid_code(code):
        raise HTTPException(404, "Entity not found")
    visible, reach = await _visible(ctx)
    e = next((x for x in visible if x["code"] == code), None)
    if not e:
        raise HTTPException(404, "Entity not found")
    return e, visible, reach


# ── Reading the records ──────────────────────────────────────────────────────
def _company_facts(c) -> dict:
    if not c:
        return {}
    digits = L.ein_digits(c.tax_id or "")
    return {"id": c.id, "name": c.name or "", "legalName": c.legal_name or c.name or "",
            "einLast4": digits[-4:] if len(digits) >= 4 else "",
            "address": c.physical_address or c.registered_address or "", "signatory": c.signatory or "",
            "state": c.region or ""}


class _Names:
    """Display names: legal name (the company's when linked), else the books
    name without its trailing dot, else the code."""

    def __init__(self, books: list, recs: dict, companies: dict):
        self.books = {e["code"]: e for e in books}
        self.recs, self.companies = recs, companies

    def legal(self, code: str) -> str:
        r = self.recs.get(code)
        if r is not None and r.company_id and r.company_id in self.companies:
            c = self.companies[r.company_id]
            return c.legal_name or c.name or ""
        return (r.legal_name if r is not None else "") or ""

    def of(self, code: str) -> str:
        return self.legal(code) or L.clean_name((self.books.get(code) or {}).get("name") or "") or code


def _load(db: Session, codes: list) -> dict:
    codes = list(dict.fromkeys(codes))
    recs = {r.code: r for r in db.query(models.LegalEntity).filter(models.LegalEntity.code.in_(codes)).all()} if codes else {}
    company_ids = {r.company_id for r in recs.values() if r.company_id}
    companies = {c.id: c for c in db.query(models.HrEntity).filter(models.HrEntity.id.in_(company_ids)).all()} if company_ids else {}
    deals = {f.intacct_entity: f for f in db.query(models.IrFund).filter(models.IrFund.intacct_entity.in_(codes)).all()} if codes else {}
    return {"recs": recs, "companies": companies, "deals": deals}


def _current(rows, today: str) -> list:
    return [r for r in rows if not r.until or r.until > today]


def _graph(db: Session, visible: list, reach, today: str, show_investors: bool, user: Optional[dict] = None,
           allowed_assets=None) -> dict:
    """The structure: every legal entity the caller may read, who owns each
    one and what it holds.

    nodes: {id: {id, kind, label, sub, shape, code?, status?, deal?, outside?}}
    edges: [{from, to, kind: owns | manages | holds, pct, source: ir | entity | fee | record, label}]
    `owners_of` is the walk look_through takes: {node: [(owner, pct)]}."""
    entities = [e for e in visible if L.kind_of(e["code"]) == "entity"]
    codes = [e["code"] for e in entities]
    data = _load(db, codes)
    recs, deals = data["recs"], data["deals"]
    # A record may say a "-1" code is an entity of its own, or a plain code a location.
    entities = [e for e in visible if L.kind_of(e["code"], getattr(recs.get(e["code"]), "kind", "")) == "entity"]
    codes = [e["code"] for e in entities]
    names = _Names(visible, recs, data["companies"])
    nodes: dict = {}
    edges: list = []

    def ent_node(code: str) -> str:
        nid = f"e:{code}"
        if nid not in nodes:
            r = recs.get(code)
            deal = deals.get(code)
            nodes[nid] = {"id": nid, "kind": "entity", "code": code, "label": names.of(code),
                          "sub": L.type_line(getattr(r, "entity_type", ""), getattr(r, "tax_class", "")) or code,
                          "shape": L.shape_of(getattr(r, "entity_type", ""), getattr(r, "tax_class", "")),
                          "taxClass": L.tax_class_of(getattr(r, "entity_type", ""), getattr(r, "tax_class", "")),
                          "status": getattr(r, "status", "") or "active",
                          "state": getattr(r, "formed_state", "") or "",
                          "deal": {"id": deal.id, "name": deal.name} if deal else None}
        return nid

    def hidden_node() -> str:
        nid = "x:outside"
        nodes.setdefault(nid, {"id": nid, "kind": "hidden", "label": "An entity outside your access", "sub": "",
                               "shape": "unknown"})
        return nid

    def entity_or_hidden(code: str) -> str:
        return ent_node(code) if code in codes or (_in(reach, code) and code in names.books) else hidden_node()

    for c in codes:
        ent_node(c)

    # Owners of a deal: its members on Investor Relations commitments.
    fund_ids = {deals[c].id: c for c in codes if c in deals}
    investors = {}
    if fund_ids:
        rows = db.query(models.IrCommitment).filter(models.IrCommitment.fund_id.in_(list(fund_ids)),
                                                    models.IrCommitment.status != "withdrawn").all()
        inv_ids = {r.investor_id for r in rows}
        investors = {v.id: v for v in db.query(models.IrInvestor).filter(models.IrInvestor.id.in_(inv_ids)).all()} if inv_ids else {}
        per: dict = {}
        for r in rows:
            k = (fund_ids[r.fund_id], r.investor_id)
            cur = per.setdefault(k, {"pct": None, "seen": False})
            cur["seen"] = True
            if r.membership_pct is not None:
                cur["pct"] = (cur["pct"] or 0.0) + float(r.membership_pct)
        grouped: dict = {}
        for (code, iid), v in per.items():
            inv = investors.get(iid)
            if inv is None:
                continue
            own = (inv.legal_entity_code or "").strip()
            if own:
                edges.append({"from": entity_or_hidden(own), "to": f"e:{code}", "kind": "owns", "pct": v["pct"], "source": "ir",
                              "investorId": iid})
            elif show_investors:
                nid = f"inv:{iid}"
                nodes.setdefault(nid, {"id": nid, "kind": "investor", "investorId": iid, "label": inv.display_name,
                                       "sub": _INVESTOR_TYPE_WORDS.get(inv.entity_type or "individual", "Investor"),
                                       "shape": L.investor_shape(inv.entity_type), "outside": True})
                edges.append({"from": nid, "to": f"e:{code}", "kind": "owns", "pct": v["pct"], "source": "ir", "investorId": iid})
            else:
                g = grouped.setdefault(code, {"n": 0, "pct": 0.0, "unknown": False})
                g["n"] += 1
                if v["pct"] is None:
                    g["unknown"] = True
                else:
                    g["pct"] += v["pct"]
        for code, g in grouped.items():
            nid = f"g:{code}"
            nodes[nid] = {"id": nid, "kind": "group", "label": f"{g['n']} {'Member' if g['n'] == 1 else 'Members'}",
                          "sub": "Investor Relations", "shape": "group", "count": g["n"]}
            edges.append({"from": nid, "to": f"e:{code}", "kind": "owns", "pct": round(g["pct"], 4) if g["pct"] else None,
                          "source": "ir"})

    # Owners of every other entity: legal_entity_owners.
    plain = [c for c in codes if c not in deals]
    if plain:
        rows = _current(db.query(models.LegalEntityOwner).filter(models.LegalEntityOwner.entity_code.in_(plain)).all(), today)
        need = {r.investor_id for r in rows if r.owner_kind == "investor" and r.investor_id} - set(investors)
        if need:
            investors.update({v.id: v for v in db.query(models.IrInvestor).filter(models.IrInvestor.id.in_(need)).all()})
        for r in rows:
            to = f"e:{r.entity_code}"
            if r.owner_kind == "entity":
                frm = entity_or_hidden(r.owner_code)
            elif r.owner_kind == "investor":
                inv = investors.get(r.investor_id)
                if inv is not None and (inv.legal_entity_code or "").strip():
                    frm = entity_or_hidden(inv.legal_entity_code.strip())
                else:
                    frm = f"inv:{r.investor_id}"
                    nodes.setdefault(frm, {"id": frm, "kind": "investor", "investorId": r.investor_id,
                                           "label": (inv.display_name if inv is not None and show_investors else "An Investor"),
                                           "sub": "Investor Relations",
                                           "shape": L.investor_shape(getattr(inv, "entity_type", "")), "outside": True})
            else:
                key = " ".join((r.owner_name or "").lower().split())
                frm = f"p:{key}"
                nodes.setdefault(frm, {"id": frm, "kind": "person", "label": r.owner_name or "Not Named", "sub": "",
                                       "shape": "individual"})
            edges.append({"from": frm, "to": to, "kind": "owns", "pct": r.pct, "source": "entity", "ownerId": r.id,
                          "label": r.owner_class or ""})

    # Who manages whom: Management Fee agreements, else the record's manager.
    managed = set()
    ama = db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.entity_code.in_(codes),
                                                         models.AccountingAmaAgreement.status != "Ended").all() if codes else []
    for a in ama:
        m = (a.manager_entity_code or "").strip()
        if not m or not _in(reach, m) or m not in names.books:
            continue
        edges.append({"from": ent_node(m), "to": f"e:{a.entity_code}", "kind": "manages", "pct": None, "source": "fee",
                      "label": _fee_words(a)})
        managed.add((m, a.entity_code))
    for c in codes:
        r = recs.get(c)
        m = (getattr(r, "manager_code", "") or "").strip()
        if m and (m, c) not in managed and _in(reach, m) and m in names.books:
            edges.append({"from": ent_node(m), "to": f"e:{c}", "kind": "manages", "pct": None, "source": "record",
                          "label": "Manager"})

    # What each entity holds: its properties in Asset Management.
    prop_ids: dict = {}
    for c in codes:
        r = recs.get(c)
        for pid in (getattr(r, "property_ids", None) or []):
            prop_ids.setdefault(str(pid), set()).add(c)
        d = deals.get(c)
        if d is not None and d.property_asset_id:
            prop_ids.setdefault(d.property_asset_id, set()).add(c)
    if prop_ids:
        for p in db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(list(prop_ids))).all():
            if not property_links.viewable(p, user or {}) or (p.payload or {}).get("deleted") \
                    or not property_links.in_scope(p, allowed_assets):
                continue
            nid = f"a:{p.id}"
            pl = p.payload or {}
            nodes[nid] = {"id": nid, "kind": "property", "assetId": p.id, "label": property_links.display_name(p),
                          "sub": ", ".join(x for x in (pl.get("city") or "", pl.get("state") or "") if x), "shape": "property"}
            for c in prop_ids[p.id]:
                edges.append({"from": f"e:{c}", "to": nid, "kind": "holds", "pct": None, "source": "record", "label": ""})

    owners_of: dict = {}
    for e in edges:
        if e["kind"] == "owns":
            owners_of.setdefault(e["to"], []).append((e["from"], e["pct"]))
    return {"nodes": nodes, "edges": edges, "owners_of": owners_of, "names": names, "recs": recs, "deals": deals,
            "companies": data["companies"], "investors": investors, "codes": codes}


def _graph_for(ctx: dict, visible: list, reach) -> dict:
    """_graph for the caller: their investor view and their property reach."""
    return _graph(ctx["db"], visible, reach, ctx["today"], ctx["ir"], ctx["user"],
                  property_links.asset_scope(ctx["db"], ctx["user"]))


def _fee_words(a) -> str:
    if a.fee_basis == "flat" and a.flat_amount is not None:
        return f"Manager - ${a.flat_amount:,.0f} {str(a.billing_frequency or 'Monthly').lower()}"
    if a.fee_rate is not None:
        return f"Manager - {a.fee_rate:g}% of revenue"
    return "Manager"


def _public_graph(g: dict) -> dict:
    return {"nodes": list(g["nodes"].values()), "edges": g["edges"]}


# ── The list ─────────────────────────────────────────────────────────────────
def _owned_by(code: str, g: dict) -> str:
    owners = [e for e in g["edges"] if e["to"] == f"e:{code}" and e["kind"] == "owns"]
    if not owners:
        return ""
    groups = [g["nodes"][e["from"]] for e in owners if g["nodes"].get(e["from"], {}).get("kind") == "group"]
    if groups:
        n = sum(x.get("count", 0) for x in groups) + len(owners) - len(groups)
        return f"{n} {'member' if n == 1 else 'members'}"
    if len(owners) == 1:
        return g["nodes"].get(owners[0]["from"], {}).get("label", "")
    return f"{len(owners)} {'members' if code in g['deals'] else 'owners'}"


def _row(e: dict, g: dict, kind: str) -> dict:
    code = e["code"]
    r = g["recs"].get(code)
    comp = _company_facts(g["companies"].get(r.company_id)) if r is not None and r.company_id else {}
    deal = g["deals"].get(code)
    et, tc = getattr(r, "entity_type", "") or "", getattr(r, "tax_class", "") or ""
    return {"code": code, "booksName": L.clean_name(e.get("name") or ""), "parentCode": e.get("parent_code") or "",
            "kind": kind, "recorded": r is not None, "legalName": g["names"].legal(code),
            "name": g["names"].of(code), "entityType": et, "taxClass": L.tax_class_of(et, tc),
            "typeLine": L.type_line(et, tc), "shape": L.shape_of(et, tc),
            "formedState": (getattr(r, "formed_state", "") or comp.get("state") or ""), "formedOn": getattr(r, "formed_on", "") or "",
            "status": getattr(r, "status", "") or "active",
            "einLast4": comp.get("einLast4") if comp else (getattr(r, "ein_last4", "") or ""),
            "deal": {"id": deal.id, "name": deal.name} if deal else None,
            "ownedBy": _owned_by(code, g) if kind == "entity" else "",
            "steward": getattr(r, "steward_email", "") or "", "companyId": getattr(r, "company_id", "") or ""}


def _list_sync(ctx: dict, visible: list, reach) -> dict:
    g = _graph_for(ctx, visible, reach)
    rows = []
    for e in visible:
        r = g["recs"].get(e["code"])
        kind = L.kind_of(e["code"], getattr(r, "kind", ""))
        row = _row(e, g, kind)
        if kind == "location":
            row["parentCode"] = L.parent_of_location(e["code"]) or row["parentCode"]
        rows.append(row)
    rows.sort(key=lambda x: (x["code"]))
    return {"entities": rows, "canEdit": ctx["edit"], "canFull": ctx["full"], "seesInvestors": ctx["ir"],
            "limited": ctx["allowed"] is not None}


@router.get("")
async def list_entities(ctx: dict = Depends(_ctx)):
    visible, reach = await _visible(ctx)
    return await asyncio.to_thread(_list_sync, ctx, visible, reach)


@router.get("/structure")
async def structure(ctx: dict = Depends(_ctx)):
    """Every entity, owner and link the caller may see - the Structure chart
    and each entity's own chart are drawn from this one read."""
    visible, reach = await _visible(ctx)
    g = await asyncio.to_thread(_graph_for, ctx, visible, reach)
    return {**_public_graph(g), "seesInvestors": ctx["ir"]}


async def _total(code: str, to: str, from_: Optional[str] = None) -> list:
    async with _FIGURE_SEM:
        data = await acct._acct_get("/api/internal/reports/buckets", {"to": to, "from": from_, "by": "total", "location": code})
    return data.get("rows") or []


@router.get("/figures")
async def figures(codes: str = Query(""), ctx: dict = Depends(_ctx)):
    """{figures: {code: {cash, assets, liabilities, bookEquity} | {error}}} -
    one cached balance-sheet read per entity, the same read a deal's figures use."""
    asked = [c for c in dict.fromkeys(acct._csv(codes)) if L.valid_code(c)][:_MAX_FIGURE_CODES]
    if not asked:
        return {"asOf": ctx["today"], "figures": {}}
    visible, _ = await _visible(ctx)
    ok = {e["code"] for e in visible}
    asked = [c for c in asked if c in ok]

    async def one(code):
        try:
            p = ib.property_figures(await _total(code, ctx["today"]), [])
            return code, {k: p[k] for k in ("cash", "assets", "liabilities", "bookEquity")}
        except HTTPException as e:
            return code, {"error": str(e.detail)}
    got = await asyncio.gather(*(one(c) for c in asked))
    return {"asOf": ctx["today"], "book": "accrual", "figures": dict(got)}


# ── One entity ───────────────────────────────────────────────────────────────
def _serialize(code: str, e: dict, g: dict, visible: list, ctx: dict) -> dict:
    db = ctx["db"]
    r = g["recs"].get(code)
    comp = _company_facts(g["companies"].get(r.company_id)) if r is not None and r.company_id else {}
    deal = g["deals"].get(code)
    kind = L.kind_of(code, getattr(r, "kind", ""))
    et, tc = getattr(r, "entity_type", "") or "", getattr(r, "tax_class", "") or ""
    nid = f"e:{code}"
    nodes = g["nodes"]

    def node_out(n_id):
        n = nodes.get(n_id) or {}
        return {k: n.get(k) for k in ("id", "kind", "label", "sub", "shape", "code", "investorId", "assetId", "status", "deal")}

    owners = [{**node_out(x["from"]), "pct": x["pct"], "source": x["source"], "ownerId": x.get("ownerId"), "role": x.get("label", "")}
              for x in g["edges"] if x["to"] == nid and x["kind"] == "owns"]
    owned = [{**node_out(x["to"]), "pct": x["pct"], "source": x["source"]}
             for x in g["edges"] if x["from"] == nid and x["kind"] == "owns"]
    managed_by = [{**node_out(x["from"]), "terms": x.get("label", "")} for x in g["edges"] if x["to"] == nid and x["kind"] == "manages"]
    manages = [{**node_out(x["to"]), "terms": x.get("label", "")} for x in g["edges"] if x["from"] == nid and x["kind"] == "manages"]
    holds = [node_out(x["to"]) for x in g["edges"] if x["from"] == nid and x["kind"] == "holds"]
    look = []
    for row in L.look_through(nid, g["owners_of"]):
        look.append({**node_out(row["id"]), "pct": row["pct"], "partlyUnknown": row["partlyUnknown"],
                     "via": [nodes.get(v, {}).get("label", "") for v in row["via"]]})
    history = []
    if deal is None:
        rows = db.query(models.LegalEntityOwner).filter(models.LegalEntityOwner.entity_code == code).all()
        history = [_owner_out(o, g) for o in sorted(rows, key=lambda o: (o.until == "", o.until or "", o.since or ""), reverse=True)
                   if o.until and o.until <= ctx["today"]]
    locations = [{"code": x["code"], "name": L.clean_name(x.get("name") or "")} for x in visible
                 if x["code"] != code and (L.parent_of_location(x["code"]) == code or x.get("parent_code") == code)]
    signers = list(getattr(r, "signers", None) or [])
    if comp and comp.get("signatory"):
        signers = [{"name": comp["signatory"], "title": "", "email": "", "fromCompany": True}]
    has_ein = bool(comp.get("einLast4")) if comp else bool(getattr(r, "ein_enc", ""))
    last4 = comp.get("einLast4", "") if comp else (getattr(r, "ein_last4", "") or "")
    return {
        "code": code, "kind": kind, "recorded": r is not None, "rev": getattr(r, "rev", 0) or 0,
        "booksName": L.clean_name(e.get("name") or ""), "parentCode": e.get("parent_code") or "", "parentName": L.clean_name(e.get("parent_name") or ""),
        "name": g["names"].of(code),
        "company": comp or None,
        "fromCompany": ["legalName", "ein", "address", "signers"] if comp else [],
        "legalName": comp.get("legalName", "") if comp else (getattr(r, "legal_name", "") or ""),
        "dba": getattr(r, "dba", "") or "",
        "entityType": et, "taxClass": L.tax_class_of(et, tc), "taxClassTyped": tc, "typeLine": L.type_line(et, tc),
        "shape": L.shape_of(et, tc),
        "formedState": getattr(r, "formed_state", "") or "", "formedOn": getattr(r, "formed_on", "") or "",
        "status": getattr(r, "status", "") or "active", "endedOn": getattr(r, "ended_on", "") or "",
        "hasEin": has_ein, "einMasked": L.mask_ein(last4), "einLast4": last4,
        "fiscalYearEnd": getattr(r, "fiscal_year_end", "") or "",
        "address": comp.get("address", "") if comp else (getattr(r, "address", "") or ""),
        "registeredAgent": getattr(r, "registered_agent", "") or "", "agentRenewsOn": getattr(r, "agent_renews_on", "") or "",
        "foreignStates": list(getattr(r, "foreign_states", None) or []),
        "management": getattr(r, "management", "") or "", "managerCode": getattr(r, "manager_code", "") or "",
        "managerName": getattr(r, "manager_name", "") or "",
        "signers": signers, "steward": getattr(r, "steward_email", "") or "",
        "propertyIds": list(getattr(r, "property_ids", None) or []), "egnyteFolder": getattr(r, "egnyte_folder", "") or "",
        "notes": getattr(r, "notes", "") or "",
        "updatedBy": getattr(r, "updated_by", "") or "", "updatedAt": getattr(r, "updated_at", "") or "",
        "deal": {"id": deal.id, "name": deal.name, "status": deal.status or "", "propertyAssetId": deal.property_asset_id or ""} if deal else None,
        "ownersHome": "ir" if deal else "entity",
        "owners": owners, "ownersTotal": L.total_pct(o["pct"] for o in owners), "ownerHistory": history,
        "owned": owned, "managedBy": managed_by, "manages": manages, "holds": holds, "lookThrough": look,
        "locations": locations,
        "canEdit": ctx["edit"], "canFull": ctx["full"], "seesInvestors": ctx["ir"],
    }


def _owner_out(o, g) -> dict:
    if o.owner_kind == "entity":
        label = g["names"].of(o.owner_code) if o.owner_code in g["names"].books else "An entity outside your access"
    elif o.owner_kind == "investor":
        inv = g["investors"].get(o.investor_id)
        label = inv.display_name if inv is not None else "An Investor"
    else:
        label = o.owner_name or ""
    return {"ownerId": o.id, "ownerKind": o.owner_kind, "label": label, "pct": o.pct, "ownerClass": o.owner_class or "",
            "since": o.since or "", "until": o.until or "", "notes": o.notes or ""}


@router.get("/{code}")
async def get_entity(code: str, ctx: dict = Depends(_ctx)):
    e, visible, reach = await _one(ctx, code)

    def work():
        g = _graph_for(ctx, visible, reach)
        return _serialize(code, e, g, visible, ctx)
    return await asyncio.to_thread(work)


# ── Saving the legal record ──────────────────────────────────────────────────
class EntityIn(BaseModel):
    rev: Optional[int] = None
    kind: Optional[str] = None
    companyId: Optional[str] = None
    legalName: Optional[str] = None
    dba: Optional[str] = None
    entityType: Optional[str] = None
    taxClass: Optional[str] = None
    formedState: Optional[str] = None
    formedOn: Optional[str] = None
    status: Optional[str] = None
    endedOn: Optional[str] = None
    ein: Optional[str] = None
    fiscalYearEnd: Optional[str] = None
    address: Optional[str] = None
    registeredAgent: Optional[str] = None
    agentRenewsOn: Optional[str] = None
    foreignStates: Optional[list] = None
    management: Optional[str] = None
    managerCode: Optional[str] = None
    managerName: Optional[str] = None
    signers: Optional[list] = None
    steward: Optional[str] = None
    propertyIds: Optional[list] = None
    egnyteFolder: Optional[str] = None
    notes: Optional[str] = None


def _text(v, field: str, cap: int = 300) -> str:
    s = " ".join(str(v or "").split()) if cap <= 300 else str(v or "").strip()
    if len(s) > cap:
        raise HTTPException(422, f"{field} is too long.")
    return s


def _apply(db: Session, user: dict, code: str, body: dict, ctx: dict, book_codes: set) -> dict:
    r = db.query(models.LegalEntity).filter(models.LegalEntity.code == code).first()
    if body.get("rev") is not None and r is not None and int(body["rev"]) != int(r.rev or 0):
        raise HTTPException(409, "Someone saved this entity since you opened it - reload to see their changes.")
    if body.get("rev") not in (None, 0) and r is None:
        raise HTTPException(409, "Someone changed this entity since you opened it - reload to see their changes.")
    new = r is None
    if new:
        r = models.LegalEntity(code=code, created_by=user["email"], created_at=_now(), rev=0, status="active",
                               foreign_states=[], signers=[], property_ids=[])
    try:
        if "kind" in body:
            if body["kind"] not in ("", "entity", "location"):
                raise ValueError("Kind must be entity or location.")
            r.kind = body["kind"]
        if "companyId" in body:
            cid = (body["companyId"] or "").strip()
            if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
                raise ValueError("That company is not in Settings > Companies.")
            r.company_id = cid
        if "entityType" in body:
            if body["entityType"] not in ("", *L.ENTITY_TYPES):
                raise ValueError("That is not an entity type.")
            r.entity_type = body["entityType"]
        if "taxClass" in body:
            if body["taxClass"] not in ("", *L.TAX_CLASSES):
                raise ValueError("That is not a tax classification.")
            r.tax_class = body["taxClass"]
        if "formedState" in body:
            r.formed_state = L.clean_state(body["formedState"], "State Formed")
        if "formedOn" in body:
            r.formed_on = L.clean_day(body["formedOn"], "Date Formed")
        if "status" in body:
            st = body["status"] or "active"
            if st not in L.STATUSES:
                raise ValueError("That is not a status.")
            if (st in L.ENDED) != ((r.status or "active") in L.ENDED) and not ctx["full"]:
                raise HTTPException(403, "Marking an entity Dissolved or Sold, or bringing it back, takes the Full level on Accounting.")
            r.status = st
        if "endedOn" in body:
            r.ended_on = L.clean_day(body["endedOn"], "Date Ended")
        if (r.status or "active") not in L.ENDED:
            r.ended_on = ""
        if "fiscalYearEnd" in body:
            r.fiscal_year_end = L.clean_mmdd(body["fiscalYearEnd"])
        if "agentRenewsOn" in body:
            r.agent_renews_on = L.clean_day(body["agentRenewsOn"], "Agent Renews On")
        if "foreignStates" in body:
            out = []
            for x in (body["foreignStates"] or [])[:60]:
                if not isinstance(x, dict):
                    continue
                st = L.clean_state(x.get("state"), "Also Registered In")
                if st and st not in {o["state"] for o in out}:
                    out.append({"state": st, "registeredOn": L.clean_day(x.get("registeredOn"), "Registered On")})
            r.foreign_states = out
        if "signers" in body:
            out = []
            for x in (body["signers"] or [])[:20]:
                if not isinstance(x, dict) or not str(x.get("name") or "").strip():
                    continue
                out.append({"name": _text(x.get("name"), "A signer's name", 120), "title": _text(x.get("title"), "A signer's title", 120),
                            "email": _text(x.get("email"), "A signer's email", 200).lower()})
            r.signers = out
    except ValueError as err:
        raise HTTPException(422, str(err))
    if "management" in body:
        if body["management"] not in ("", *L.MANAGEMENT):
            raise HTTPException(422, "That is not a way of managing an entity.")
        r.management = body["management"]
    if "managerCode" in body:
        m = (body["managerCode"] or "").strip()
        if m and (m == code or m not in book_codes):
            raise HTTPException(422, "The manager must be another entity on the books that you can read.")
        r.manager_code = m
    if "managerName" in body:
        r.manager_name = _text(body["managerName"], "Manager", 200)
    if "steward" in body:
        s = (body["steward"] or "").strip().lower()
        if s and not db.query(models.NexusEmployee.id).filter(models.NexusEmployee.work_email.ilike(s)).first():
            raise HTTPException(422, "The steward must be a person in Nexus People.")
        r.steward_email = s
    if "propertyIds" in body:
        allowed_assets = property_links.asset_scope(db, user)
        ids = [str(x) for x in dict.fromkeys(body["propertyIds"] or []) if str(x).strip()][:40]
        found = {p.id: p for p in db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(ids)).all()} if ids else {}
        keep = [i for i in (r.property_ids or []) if i not in found or not property_links.viewable(found[i], user)]
        bad = [i for i in ids if i not in found or not property_links.is_listed(found[i], user, allowed=allowed_assets)]
        if bad:
            raise HTTPException(422, "One of those properties is not in Asset Management, or not one you can see.")
        # A property the caller cannot see stays linked: they cannot unlink what they cannot see.
        r.property_ids = list(dict.fromkeys(ids + keep))
    for key, col, cap in (("dba", "dba", 200), ("address", "address", 400), ("registeredAgent", "registered_agent", 300),
                          ("egnyteFolder", "egnyte_folder", 500), ("notes", "notes", 4000)):
        if key in body:
            setattr(r, col, _text(body[key], key, cap))
    if "egnyteFolder" in body and r.egnyte_folder:
        f = r.egnyte_folder
        if not f.startswith("/Shared/") or ".." in f:
            raise HTTPException(422, "The Egnyte folder must be a folder under /Shared/.")
    if r.company_id:
        # The company's own legal name, EIN, address and signatory are the values.
        r.legal_name, r.ein_enc, r.ein_last4, r.address, r.signers = "", "", "", "", []
    else:
        if "legalName" in body:
            r.legal_name = _text(body["legalName"], "Legal Name", 200)
        if "ein" in body:
            raw = (body["ein"] or "").strip()
            if raw:
                if not L.valid_ein(raw):
                    raise HTTPException(422, "An EIN is nine digits, like 12-3456789.")
                import secret_box
                r.ein_enc = "enc:" + secret_box.encrypt(L.ein_digits(raw))
                r.ein_last4 = L.ein_digits(raw)[-4:]
            else:
                r.ein_enc, r.ein_last4 = "", ""
    r.rev = int(r.rev or 0) + 1
    r.updated_by, r.updated_at = user["email"], _now()
    if new:
        db.add(r)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(409, "Someone saved this entity at the same moment - reload and try again.")
    return {"code": code, "rev": r.rev}


@router.put("/{code}")
async def save_entity(code: str, body: EntityIn, ctx: dict = Depends(_ctx)):
    if not ctx["edit"]:
        raise HTTPException(403, "Editing an entity takes the Editor level on Accounting.")
    _, visible, _ = await _one(ctx, code)
    data = body.model_dump(exclude_unset=True)
    return await asyncio.to_thread(_apply, ctx["db"], ctx["user"], code, data, ctx, {x["code"] for x in visible})


def _reveal(db: Session, code: str) -> str:
    import secret_box
    r = db.query(models.LegalEntity).filter(models.LegalEntity.code == code).first()
    if r is None:
        return ""
    if r.company_id:
        c = db.query(models.HrEntity).filter(models.HrEntity.id == r.company_id).first()
        return L.format_ein(c.tax_id or "") or (c.tax_id or "") if c else ""
    enc = r.ein_enc or ""
    if not enc:
        return ""
    try:
        return L.format_ein(secret_box.decrypt(enc[4:] if enc.startswith("enc:") else enc))
    except ValueError:
        raise HTTPException(409, "This EIN was saved under another key and cannot be read - type it again.")


@router.post("/{code}/ein")
async def reveal_ein(code: str, ctx: dict = Depends(_ctx)):
    """The whole EIN - Full level only. A POST, so the Audit Log records who
    asked and when; the number itself is never logged."""
    if not ctx["full"]:
        raise HTTPException(403, "Showing the whole EIN takes the Full level on Accounting.")
    await _one(ctx, code)
    return {"ein": await asyncio.to_thread(_reveal, ctx["db"], code)}


# ── Owners of an entity that is not a deal ───────────────────────────────────
class OwnerIn(BaseModel):
    ownerKind: str = "person"
    ownerCode: Optional[str] = ""
    investorId: Optional[str] = ""
    ownerName: Optional[str] = ""
    pct: Optional[float] = None
    ownerClass: Optional[str] = ""
    since: Optional[str] = ""
    notes: Optional[str] = ""


def _owners_of_all(db: Session, today: str) -> dict:
    """The entity-to-entity ownership walk for the loop check: stored owners
    and Investor Relations commitments of investors that are our entities."""
    out: dict = {}
    for o in _current(db.query(models.LegalEntityOwner).all(), today):
        if o.owner_kind == "entity" and o.owner_code:
            out.setdefault(o.entity_code, []).append((o.owner_code, o.pct))
    inv = {v.id: v.legal_entity_code for v in db.query(models.IrInvestor).filter(models.IrInvestor.legal_entity_code != "").all()}
    if inv:
        funds = {f.id: f.intacct_entity for f in db.query(models.IrFund).filter(models.IrFund.intacct_entity != "").all()}
        for c in db.query(models.IrCommitment).filter(models.IrCommitment.investor_id.in_(list(inv))).all():
            if funds.get(c.fund_id):
                out.setdefault(funds[c.fund_id], []).append((inv[c.investor_id], c.membership_pct))
    return out


def _check_owner(db: Session, code: str, body: dict, book_codes: set, today: str, exclude_id: str = "") -> dict:
    if db.query(models.IrFund.id).filter(models.IrFund.intacct_entity == code).first():
        raise HTTPException(409, "This entity is a deal - its members are kept on the deal in Investor Relations.")
    kind = body.get("ownerKind") or "person"
    if kind not in L.OWNER_KINDS:
        raise HTTPException(422, "An owner is an entity, an investor or a person.")
    try:
        pct = L.clean_pct(body.get("pct"))
        since = L.clean_day(body.get("since"), "Since")
    except ValueError as err:
        raise HTTPException(422, str(err))
    out = {"owner_kind": kind, "owner_code": "", "investor_id": "", "owner_name": "", "pct": pct, "since": since,
           "owner_class": _text(body.get("ownerClass"), "Class", 80), "notes": _text(body.get("notes"), "Notes", 500)}
    if kind == "entity":
        oc = (body.get("ownerCode") or "").strip()
        if not oc or oc not in book_codes:
            raise HTTPException(422, "Pick an entity on the books that you can read.")
        if L.owns_cycle(code, oc, _owners_of_all(db, today)):
            raise HTTPException(422, "That would make the entity own itself through the chain.")
        out["owner_code"] = oc
    elif kind == "investor":
        iid = (body.get("investorId") or "").strip()
        if not iid or not db.query(models.IrInvestor.id).filter(models.IrInvestor.id == iid).first():
            raise HTTPException(422, "Pick an investor from Investor Relations.")
        out["investor_id"] = iid
    else:
        name = _text(body.get("ownerName"), "Owner", 160)
        if not name:
            raise HTTPException(422, "Type the owner's name.")
        out["owner_name"] = name
    others = [o for o in _current(db.query(models.LegalEntityOwner).filter(models.LegalEntityOwner.entity_code == code).all(), today)
              if o.id != exclude_id]
    if L.total_pct([o.pct for o in others] + [pct]) > 100.0001:
        raise HTTPException(422, f"The owners would add up to more than 100% ({L.total_pct([o.pct for o in others] + [pct]):g}%).")
    return out


def _add_owner(db: Session, user: dict, code: str, body: dict, book_codes: set, today: str) -> dict:
    vals = _check_owner(db, code, body, book_codes, today)
    o = models.LegalEntityOwner(id=str(uuid.uuid4()), entity_code=code, created_by=user["email"], created_at=_now(),
                                updated_by=user["email"], updated_at=_now(), until="", **vals)
    db.add(o)
    db.commit()
    return {"ownerId": o.id}


def _fix_owner(db: Session, user: dict, code: str, owner_id: str, body: dict, book_codes: set, today: str) -> dict:
    o = db.query(models.LegalEntityOwner).filter(models.LegalEntityOwner.id == owner_id, models.LegalEntityOwner.entity_code == code).first()
    if o is None:
        raise HTTPException(404, "Owner not found")
    if o.until and o.until <= today:
        raise HTTPException(409, "This owner has already left - add them again instead.")
    vals = _check_owner(db, code, body, book_codes, today, exclude_id=o.id)
    for k, v in vals.items():
        setattr(o, k, v)
    o.updated_by, o.updated_at = user["email"], _now()
    db.commit()
    return {"ownerId": o.id}


def _end_owner(db: Session, user: dict, code: str, owner_id: str, until: str, today: str) -> dict:
    o = db.query(models.LegalEntityOwner).filter(models.LegalEntityOwner.id == owner_id, models.LegalEntityOwner.entity_code == code).first()
    if o is None:
        raise HTTPException(404, "Owner not found")
    if o.until and o.until <= today:
        raise HTTPException(409, "This owner has already left.")
    try:
        day = L.clean_day(until, "Left On") or today
    except ValueError as err:
        raise HTTPException(422, str(err))
    if o.since and day < o.since:
        raise HTTPException(422, "An owner cannot leave before they joined.")
    o.until = day
    o.updated_by, o.updated_at = user["email"], _now()
    db.commit()
    return {"ownerId": o.id, "until": day}


@router.post("/{code}/owners", status_code=201)
async def add_owner(code: str, body: OwnerIn, ctx: dict = Depends(_ctx)):
    if not ctx["edit"]:
        raise HTTPException(403, "Editing an entity takes the Editor level on Accounting.")
    _, visible, _ = await _one(ctx, code)
    return await asyncio.to_thread(_add_owner, ctx["db"], ctx["user"], code, body.model_dump(), {x["code"] for x in visible}, ctx["today"])


@router.put("/{code}/owners/{owner_id}")
async def fix_owner(code: str, owner_id: str, body: OwnerIn, ctx: dict = Depends(_ctx)):
    if not ctx["edit"]:
        raise HTTPException(403, "Editing an entity takes the Editor level on Accounting.")
    _, visible, _ = await _one(ctx, code)
    return await asyncio.to_thread(_fix_owner, ctx["db"], ctx["user"], code, owner_id, body.model_dump(), {x["code"] for x in visible}, ctx["today"])


class EndIn(BaseModel):
    until: Optional[str] = ""


@router.post("/{code}/owners/{owner_id}/end")
async def end_owner(code: str, owner_id: str, body: EndIn, ctx: dict = Depends(_ctx)):
    if not ctx["edit"]:
        raise HTTPException(403, "Editing an entity takes the Editor level on Accounting.")
    await _one(ctx, code)
    return await asyncio.to_thread(_end_owner, ctx["db"], ctx["user"], code, owner_id, body.until or "", ctx["today"])


# ── The books ────────────────────────────────────────────────────────────────
@router.get("/{code}/books")
async def entity_books(code: str, ctx: dict = Depends(_ctx)):
    """The entity's live figures (accrual): balance sheet from the start of
    the books, this year's and the last 12 months' revenue and net income.
    The accounts behind each figure ride along for the drill-down."""
    await _one(ctx, code)
    today = ctx["today"]
    t12 = (date.fromisoformat(today) - timedelta(days=365) + timedelta(days=1)).isoformat()
    try:
        bs, ytd, last12 = await asyncio.gather(_total(code, today), _total(code, today, today[:4] + "-01-01"), _total(code, today, t12))
    except HTTPException as e:
        return {"asOf": today, "error": str(e.detail)}
    p = ib.property_figures(bs, ytd)
    p12 = ib.property_figures([], last12)
    return {"asOf": today, "book": "accrual", "yearFrom": today[:4] + "-01-01", "t12From": t12,
            **p, "revenueT12": p12["revenueYtd"], "netIncomeT12": p12["netIncomeYtd"],
            "partnerCapital": ib.r2(sum(ib.balances(bs).values()))}


# ── Agreements ───────────────────────────────────────────────────────────────
def _agreements(ctx: dict, code: str, names: dict) -> dict:
    db, user = ctx["db"], ctx["user"]
    nm = lambda c: L.clean_name(names.get(c, "")) or c  # noqa: E731
    ama = db.query(models.AccountingAmaAgreement).filter(
        (models.AccountingAmaAgreement.entity_code == code) | (models.AccountingAmaAgreement.manager_entity_code == code)).all()
    fees = [{"id": a.id, "role": "managed" if a.entity_code == code else "manager",
             "other": a.manager_entity_code if a.entity_code == code else a.entity_code,
             "otherName": nm(a.manager_entity_code if a.entity_code == code else a.entity_code),
             "status": a.status or "", "terms": _fee_words(a).replace("Manager - ", ""), "billing": a.billing_frequency or "",
             "start": a.start_date or "", "end": a.end_date or "", "agreementUrl": a.agreement_url or ""}
            for a in ama if (a.entity_code == code and (not a.manager_entity_code or a.manager_entity_code in names))
            or (a.manager_entity_code == code and a.entity_code in names)]
    leases = [{"id": x.id, "tenant": x.tenant_name or "", "property": x.property_name or "", "tenancy": x.tenancy or "",
               "start": x.lease_start or "", "end": x.lease_end or ""}
              for x in db.query(models.Lease).filter(models.Lease.entity_code == code).all()]
    leases = [x for x in leases if not x["end"] or x["end"] >= ctx["today"]]
    mre = [{"id": x.id, "vendor": x.vendor_name or "", "category": x.category or "", "frequency": x.frequency or ""}
           for x in db.query(models.RecurringExpense).filter(models.RecurringExpense.entity_code == code).all()
           if (x.status or "active") != "ended" and (not x.end_date or x.end_date >= ctx["today"])]
    jobs = []
    try:
        from construction_models import ConstructionProject
        from routers.construction import _may_read
        for p in db.query(ConstructionProject).filter(ConstructionProject.intacct_entity == code).all():
            if _may_read(db, user, p):
                jobs.append({"id": p.id, "name": p.name or "", "code": p.code or "", "status": p.status or "",
                             "jobType": getattr(p, "job_type", "") or ""})
    except Exception:  # Construction unreadable must never take the page down
        jobs = []
    return {"fees": fees, "leases": leases, "recurring": mre, "jobs": jobs}


@router.get("/{code}/agreements")
async def entity_agreements(code: str, ctx: dict = Depends(_ctx)):
    """Management fees (as the managed or the manager entity), leases, the
    recurring expenses and the construction jobs on this entity - each opens
    its own module. Loans come from Loans' own by-entity read."""
    _, visible, _ = await _one(ctx, code)
    names = {x["code"]: x.get("name") or "" for x in visible}
    return await asyncio.to_thread(_agreements, ctx, code, names)


# ── Fill From ────────────────────────────────────────────────────────────────
def _suggest(ctx: dict, code: str, e: dict, visible: list, reach) -> dict:
    db, user = ctx["db"], ctx["user"]
    books_name = L.clean_name(e.get("name") or "")
    key = ib.partner_key(books_name)
    out: dict = {}
    deal = db.query(models.IrFund).filter(models.IrFund.intacct_entity == code).first()
    if deal is not None and deal.entity_name:
        out["legalName"] = {"value": deal.entity_name.strip(), "from": f"the deal {deal.name} in Investor Relations"}
    elif books_name:
        out["legalName"] = {"value": books_name, "from": "the name on the books"}
    members = 0
    if deal is not None:
        members = len({c.investor_id for c in db.query(models.IrCommitment).filter(models.IrCommitment.fund_id == deal.id,
                                                                                    models.IrCommitment.status != "withdrawn").all()})
    t = L.guess_type(out.get("legalName", {}).get("value", books_name), members)
    if t:
        out["entityType"] = {"value": t, "from": "the name" + (f" and its {members} members" if members else "")}
    for c in db.query(models.HrEntity).all():
        if key and key in (ib.partner_key(c.legal_name or ""), ib.partner_key(c.name or "")):
            out["companyId"] = {"value": c.id, "label": c.legal_name or c.name, "from": "Settings > Companies"}
            break
    ama = db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.entity_code == code,
                                                         models.AccountingAmaAgreement.status != "Ended").first()
    if ama is not None and ama.manager_entity_code and _in(reach, ama.manager_entity_code):
        out["managerCode"] = {"value": ama.manager_entity_code, "from": "its Management Fee agreement"}
        out["management"] = {"value": "manager", "from": "its Management Fee agreement"}
    allowed_assets = property_links.asset_scope(db, user)
    props = []
    if deal is not None and deal.property_asset_id:
        props.append(deal.property_asset_id)
    if key:
        for p in db.query(models.PropertyAsset).all():
            owner = ib.partner_key(str((p.payload or {}).get("entity") or ""))
            if owner and owner == key and property_links.is_listed(p, user, allowed=allowed_assets):
                props.append(p.id)
    if props:
        found = {p.id: p for p in db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(props)).all()}
        props = [{"id": i, "name": property_links.display_name(found[i])} for i in dict.fromkeys(props)
                 if i in found and property_links.is_listed(found[i], user, allowed=allowed_assets)]
        if props:
            out["propertyIds"] = {"value": [p["id"] for p in props], "labels": [p["name"] for p in props],
                                  "from": "Asset Management (its owner field) and the deal"}
    return {"code": code, "suggestions": out}


@router.get("/{code}/suggestions")
async def suggestions(code: str, ctx: dict = Depends(_ctx)):
    """Values Nexus already holds for this entity, each with where it came
    from. The screen offers them; nothing is saved until the person saves."""
    e, visible, reach = await _one(ctx, code)
    return await asyncio.to_thread(_suggest, ctx, code, e, visible, reach)


# ── Investor Relations ───────────────────────────────────────────────────────
def _legal_line(db: Session, fund_id: str) -> dict:
    f = db.query(models.IrFund).filter(models.IrFund.id == fund_id).first()
    if f is None:
        raise HTTPException(404, "Deal not found")
    if not f.intacct_entity:
        return {"linked": False}
    r = db.query(models.LegalEntity).filter(models.LegalEntity.code == f.intacct_entity).first()
    if r is None:
        return {"linked": True, "entity": f.intacct_entity, "recorded": False}
    comp = _company_facts(db.query(models.HrEntity).filter(models.HrEntity.id == r.company_id).first()) if r.company_id else {}
    last4 = comp.get("einLast4", "") if comp else (r.ein_last4 or "")
    return {"linked": True, "entity": f.intacct_entity, "recorded": True,
            "legalName": comp.get("legalName", "") if comp else (r.legal_name or ""),
            "typeLine": L.type_line(r.entity_type or "", r.tax_class or ""), "shape": L.shape_of(r.entity_type or "", r.tax_class or ""),
            "formedState": r.formed_state or "", "formedOn": r.formed_on or "", "status": r.status or "active",
            "einMasked": L.mask_ein(last4), "egnyteFolder": r.egnyte_folder or ""}


@ir_router.get("/funds/{fund_id}/legal")
def fund_legal(fund_id: str, user: dict = Depends(ir.require_ir_view), db: Session = Depends(get_db)):
    """A deal's Legal line from Accounting > Entities: legal name, type, state
    and date formed, status and the EIN's ending - never a figure, so the
    Investor Relations read gate alone opens it (Neil, 11/17/2026)."""
    return _legal_line(db, fund_id)


class InvestorEntityIn(BaseModel):
    code: Optional[str] = ""


def _link_investor(db: Session, investor_id: str, code: str) -> dict:
    v = db.query(models.IrInvestor).filter(models.IrInvestor.id == investor_id).first()
    if v is None:
        raise HTTPException(404, "Investor not found")
    if code:
        other = db.query(models.IrInvestor).filter(models.IrInvestor.legal_entity_code == code, models.IrInvestor.id != investor_id).first()
        if other is not None:
            raise HTTPException(409, f"Entity {code} is already linked to the investor \"{other.display_name}\".")
    v.legal_entity_code = code
    v.updated_at = _now()
    db.commit()
    return {"investorId": v.id, "legalEntityCode": code}


def _ir_link_ctx(investor_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    ir.require_ir_edit(user=user, db=db)
    if not _grant_at_least(user, db, "viewer"):
        raise HTTPException(403, "Linking an investor to one of our entities needs Accounting access.")
    v = db.query(models.IrInvestor).filter(models.IrInvestor.id == investor_id).first()
    if v is None:
        raise HTTPException(404, "Investor not found")
    return {"user": user, "db": db, "allowed": acct.allowed_entities(user, db), "was": v.legal_entity_code or ""}


@ir_router.put("/investors/{investor_id}/entity")
async def link_investor_entity(investor_id: str, body: InvestorEntityIn, ctx: dict = Depends(_ir_link_ctx)):
    """This investor IS one of our entities ('' unlinks): Greens Global Inv 1,
    LLC investing in a deal. The caller must read both the entity it links to
    now and the new one; one entity is one investor profile."""
    code = (body.code or "").strip()
    reach = await _reach(ctx["allowed"])
    if ctx["allowed"] is not None and not ctx["allowed"]:
        raise HTTPException(403, "No accounting entities have been assigned to you yet.")
    if ctx["was"] and not _in(reach, ctx["was"]):
        raise HTTPException(403, "This investor is linked to an entity outside your accounting access.")
    if code:
        if not L.valid_code(code) or not _in(reach, code):
            raise HTTPException(403, f"Your accounting access does not include entity {code}.")
        if code not in {e["code"] for e in await _books()}:
            raise HTTPException(422, f"Entity {code} is not on the books.")
    return await asyncio.to_thread(_link_investor, ctx["db"], investor_id, code)
