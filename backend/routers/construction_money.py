"""A job's Money tab (Neil, 11/03/2026, plan phase 4) - the routes.

The rules are construction_money.py; the books are read ONLY through the
accounting proxy (routers/accounting._acct_get -> the accounting app's
/api/internal/*, async httpx in a thread, the 5-minute cache) with the
caller's entity access applied exactly as on Reports (`allowed_entities` +
`_with_children`; one entity travels as `location`). Nothing here touches
the accounting database or writes to the books. Every figure is the accrual
book (the accounting app's default - the drill-downs ask for it by name).

Database reads run in SYNC dependencies (FastAPI's threadpool) and writes in
asyncio.to_thread, so no query ever sits on the event loop (CLAUDE.md, the
Aug 2 freeze); the async handlers only await the accounting app.

  GET  /construction/projects/{id}/money   the tab (or {allowed: false})
  GET  /construction/money/flags            Over Budget per job, dashboard cards
  GET  /construction/books/projects         the Edit Job picker: Project-Job codes
  PUT  /construction/projects/{id}/books    map the job to a code and an entity
  GET  /construction/spend-jobs             jobs a request may be tagged with
"""
from __future__ import annotations

import asyncio
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_company
import construction_money as money
from auth import get_current_user
from database import get_db
from routers import accounting as acct
from routers.construction import _log_activity, _may_review, _may_see_cost, _project, _visible_projects, now_iso

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,59}$")


def _today(db: Session, p) -> str:
    """The jobsite's own today (its zone, else its company's team zone)."""
    return construction_company.local_today(db, p).isoformat()


def _link(p) -> dict:
    return {"project": (getattr(p, "intacct_project_id", "") or ""), "entity": (getattr(p, "intacct_entity", "") or "")}


async def _entity_ok(allowed, entity: str) -> bool:
    """Is `entity` inside the caller's accounting entity access (None = all)?"""
    if allowed is None:
        return True
    if not allowed or not entity:
        return False
    return entity in await acct._with_children(set(allowed))


async def _entity_name(entity: str) -> str:
    try:
        data = await acct._acct_get("/api/internal/reports/locations", {})
    except HTTPException:
        return ""
    for e in data.get("entities") or []:
        if e.get("code") == entity:
            return e.get("name") or ""
    return ""


async def _chart() -> dict | None:
    """The chart of accounts (bank_kind, category, group per account) that
    decides which asset accounts are capitalized cost - read through the
    proxy's 5-minute cache; None when the accounting app has no chart route
    (the rules fall back to titles)."""
    try:
        data = await acct._acct_get("/api/internal/accounts", {"status": "all"})
    except HTTPException:
        return None
    raw = data.get("accounts") if isinstance(data.get("accounts"), list) else data.get("rows")
    return money.chart_index(raw) if isinstance(raw, list) else None


# ── The tab ─────────────────────────────────────────────────────────────────
def _money_context(project_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Everything the tab needs from Nexus, read in the threadpool: the gate,
    the mapping, the caller's entity limit, the tagged spend, the changes."""
    p = _project(db, project_id, user)            # 404 behind the wall
    why = money.money_gate(db, user, p)
    if why:
        return {"allowed": False, "reason": why}
    changes = money.job_changes(db, p.id)
    approved = round(sum(c["amount"] for c in changes if c["state"] == "approved"), 2)
    pending = round(sum(c["amount"] for c in changes if c["state"] == "pending"), 2)
    spend = money.tagged_spend(db, p.id, viewer=user.get("email") or "")
    return {
        "allowed": True, "jobId": p.id, "link": _link(p), "currency": (p.currency or "USD").upper(),
        "asOf": _today(db, p), "allowedEntities": acct.allowed_entities(user, db),
        "budget": money.budget_of(p, approved),
        "changes": {"rows": changes, "approved": approved, "pending": pending},
        "spend": spend, "committed": money.requested_not_billed(spend, p.currency or "USD"),
        "canMap": _may_review(db, user, p),
    }


@router.get("/projects/{project_id}/money")
async def job_money(ctx: dict = Depends(_money_context)):
    """The job's Money: budget, requested-not-billed, actual to date (posted,
    by cost code or GL account, every figure drillable on the screen),
    approved and pending changes, and the worked-out forecast. A caller who
    may not see it gets {allowed: false, reason} - never a figure."""
    if not ctx["allowed"]:
        return {"allowed": False, "reason": ctx["reason"]}
    allowed = ctx.pop("allowedEntities")
    link = ctx["link"]
    out = {**ctx, "book": "accrual", "mapped": bool(link["project"] and link["entity"]), "actual": None, "booksError": ""}
    if out["mapped"]:
        if not await _entity_ok(allowed, link["entity"]):
            # The job books to an entity the caller's accounting access does
            # not include: no figure from the books, not even a total.
            return {"allowed": False, "reason": "This job books to an entity outside your accounting access."}
        try:
            data = await acct._acct_get("/api/internal/reports/buckets", {
                "to": out["asOf"], "by": "item", "location": link["entity"], "project": link["project"]})
            out["actual"] = money.actual_from_buckets(data.get("rows") or [], data.get("labels") or {}, await _chart())
            link["entityName"] = await _entity_name(link["entity"])
        except HTTPException as e:
            out["booksError"] = str(e.detail)
    out.update(money.worked_out(
        actual=(out["actual"] or {}).get("amount") if out["actual"] else None,
        budget=out["budget"]["amount"], committed=out["committed"]["amount"], pending=out["changes"]["pending"]))
    return out


# ── Over Budget on the dashboard cards ──────────────────────────────────────
def _flag_context(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The mapped jobs the caller may see the money of (the same gate as the
    tab), with each job's budget and requested-not-billed read in one pass."""
    if int(user.get("level") or 0) < money.MIN_LEVEL or not money.has_accounting_grant(user, db):
        return {"jobs": [], "allowed": set()}
    rows = [p for p in _visible_projects(db, user)
            if _may_see_cost(db, user, p) and p.contract_value and (p.intacct_project_id or "") and (p.intacct_entity or "")]
    committed = money.committed_by_job(db, rows)
    jobs = []
    for p in rows:
        changes = money.job_changes(db, p.id)
        approved = sum(c["amount"] for c in changes if c["state"] == "approved")
        jobs.append({"id": p.id, **_link(p), "today": _today(db, p),
                     "budget": money.budget_of(p, approved)["amount"], "committed": committed.get(p.id, 0.0),
                     "pending": sum(c["amount"] for c in changes if c["state"] == "pending")})
    return {"jobs": jobs, "allowed": acct.allowed_entities(user, db)}


@router.get("/money/flags")
async def money_flags(ctx: dict = Depends(_flag_context)):
    """{flags: {jobId: {overBudget}}} for the mapped jobs the caller may see
    the money of - one ledger read per entity and day (by Project-Job),
    cached like every report. A job whose books cannot be read, or that
    books to an entity outside the caller's access, is left out."""
    groups: dict[tuple, list] = {}
    for j in ctx["jobs"]:
        groups.setdefault((j["entity"], j["today"]), []).append(j)
    flags = {}
    chart = await _chart() if groups else None
    for (entity, today), jobs in groups.items():
        if not await _entity_ok(ctx["allowed"], entity):
            continue
        try:
            data = await acct._acct_get("/api/internal/reports/buckets", {
                "to": today, "by": "project", "location": entity,
                "project": ",".join(sorted({j["project"] for j in jobs}))})
        except HTTPException:
            continue
        cost = money.cost_by_project(data.get("rows") or [], chart)
        for j in jobs:
            actual = cost.get(j["project"], 0.0)
            # The Program table (Round Two, 11/05/2026) reads the same figures
            # the Money tab shows, for the same readers.
            w = money.worked_out(actual=actual, budget=j["budget"], committed=j["committed"], pending=j["pending"])
            flags[j["id"]] = {"overBudget": (actual + j["committed"]) > j["budget"] > 0,
                              "actual": round(actual, 2), "budget": j["budget"], "forecast": w.get("forecast")}
    return {"flags": flags}


# ── Mapping a job to its Project-Job code ───────────────────────────────────
def _picker_context(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    if int(user.get("level") or 0) < money.MIN_LEVEL or not money.has_accounting_grant(user, db):
        raise HTTPException(403, "Mapping a job to the books needs a manager with Accounting access.")
    from datetime import date
    return {"allowed": acct.allowed_entities(user, db), "today": date.today().isoformat()}


async def _codes_on_entity(entity: str, today: str, code: str = "") -> dict:
    """{code: name} of the Project-Job codes with lines on `entity`."""
    params = {"to": today, "by": "project", "location": entity}
    if code:
        params["project"] = code
    data = await acct._acct_get("/api/internal/reports/buckets", params)
    labels = data.get("labels") or {}
    return {c: labels.get(c) or "" for c in {str(r.get("bucket") or "").strip() for r in data.get("rows") or []} - {""}}


@router.get("/books/projects")
async def book_projects(entity: str = "", ctx: dict = Depends(_picker_context)):
    """What the Edit Job picker offers: the entities the caller may read and,
    for the picked entity, the Project-Job codes, each with `onEntity` (it
    has lines on that entity). Company-wide accounting access lists every
    code on the ledger (/reports/dimensions?kind=project); a caller limited
    to certain entities may not read that list (it spans every entity), so
    they get the codes already on their entity's lines - `limited: true`."""
    allowed = ctx["allowed"]
    loc = await acct._acct_get("/api/internal/reports/locations", {})
    entities = loc.get("entities") or []
    if allowed is not None:
        reach = await acct._with_children(set(allowed)) if allowed else set()
        entities = [e for e in entities if e.get("code") in reach]
    out = {"limited": allowed is not None, "entities": [{"code": e.get("code"), "name": e.get("name") or ""} for e in entities],
           "codes": [], "entity": entity}
    if not entity:
        return out
    if not await _entity_ok(allowed, entity):
        raise HTTPException(403, f"Your accounting access does not include entity {entity}.")
    on_entity = await _codes_on_entity(entity, ctx["today"])
    if allowed is None:
        data = await acct._acct_get("/api/internal/reports/dimensions", {"kind": "project"})
        out["codes"] = [{"code": v.get("code"), "name": v.get("name") or "", "lines": v.get("lines"), "onEntity": v.get("code") in on_entity}
                        for v in data.get("values") or [] if v.get("code")]
    else:
        out["codes"] = [{"code": c, "name": on_entity[c], "onEntity": True} for c in sorted(on_entity)]
    return out


class BooksIn(BaseModel):
    intacctProjectId: Optional[str] = ""
    intacctEntity: Optional[str] = ""


def _map_context(project_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    p = _project(db, project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can change this project.")
    why = money.money_gate(db, user, p)
    if why:
        raise HTTPException(403, why)
    return {"p": p, "db": db, "user": user, "allowed": acct.allowed_entities(user, db), "today": _today(db, p)}


def _save_link(db: Session, user: dict, p, code: str, entity: str, warning: str = "") -> dict:
    was = _link(p)
    p.intacct_project_id, p.intacct_entity = code, entity
    p.modified_at = now_iso()
    words = f"mapped this job to Project-Job {code} on entity {entity}" if code else "cleared the job's Project-Job mapping"
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="edited",
                  actor_email=user["email"], detail=words)
    db.commit()
    return {"link": _link(p), "was": was, "warning": warning}


@router.put("/projects/{project_id}/books")
async def map_books(body: BooksIn, ctx: dict = Depends(_map_context)):
    """Map the job to its existing Intacct Project-Job code and the entity it
    books to (Edit Job, managers with Accounting access). The caller must
    read the entity - the one it books to now and the new one. With
    company-wide access the code must be on the books (the ledger-wide
    list); a code with no lines on the chosen entity yet saves with a
    `warning` (Money reads nothing until lines post). A caller limited to
    certain entities cannot read the ledger-wide list, so a code with no
    lines on their entity saves with a warning too. Both empty clears it."""
    p, allowed = ctx["p"], ctx["allowed"]
    code = (body.intacctProjectId or "").strip()
    entity = (body.intacctEntity or "").strip()
    was = _link(p)
    if was["entity"] and not await _entity_ok(allowed, was["entity"]):
        raise HTTPException(403, "This job books to an entity outside your accounting access.")
    if not code and not entity:
        return await asyncio.to_thread(_save_link, ctx["db"], ctx["user"], p, "", "")
    if not code or not entity:
        raise HTTPException(422, "Pick both the Project-Job and the entity it books to.")
    if not _CODE.match(code) or not _CODE.match(entity):
        raise HTTPException(422, "That is not a Project-Job code.")
    if not await _entity_ok(allowed, entity):
        raise HTTPException(403, f"Your accounting access does not include entity {entity}.")
    if allowed is None:
        data = await acct._acct_get("/api/internal/reports/dimensions", {"kind": "project"})
        known = {str(v.get("code") or "") for v in data.get("values") or []}
        if code not in known:
            raise HTTPException(422, f"Project-Job {code} is not on the books.")
    warning = ""
    if code not in await _codes_on_entity(entity, ctx["today"], code):
        warning = (f"Project-Job {code} has no lines on entity {entity} yet - Money will show nothing until costs post to it."
                   if allowed is None else
                   f"Project-Job {code} has no lines on entity {entity} yet, and your accounting access cannot check it against "
                   "the other entities. Money will show nothing until costs post to it.")
    return await asyncio.to_thread(_save_link, ctx["db"], ctx["user"], p, code, entity, warning)


# ── The job picker on a purchase request or a reimbursement ────────────────
@router.get("/spend-jobs")
def spend_jobs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Jobs the caller may read (the company wall and the job's own lists)
    that take spend - not archived (a completed one still takes late
    receipts) - for the optional Job on a purchase request or a
    reimbursement: [{id, name, code}], the caller's own jobs first."""
    me = (user.get("email") or "").lower()
    rows = [p for p in _visible_projects(db, user) if money.taggable(p)]
    mine = lambda p: me in {(e or "").lower() for e in (p.worker_emails or []) + (p.manager_emails or [])}  # noqa: E731
    rows.sort(key=lambda p: (not mine(p), (p.status or "active") == "complete", (p.name or "").lower()))
    return {"jobs": [{"id": p.id, "name": p.name, "code": p.code or ""} for p in rows]}
