"""A job's Money tab (Neil, 11/03/2026, plan phase 4) - the routes.

The rules are construction_money.py; the books are read ONLY through the
accounting proxy (routers/accounting._acct_get -> the accounting app's
/api/internal/reports/*, async httpx in a thread, the 5-minute cache) with
the caller's entity access applied exactly as on Reports (`allowed_entities`
+ `_with_children`; one entity travels as `location`). Nothing here touches
the accounting database or writes to the books.

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
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_money as money
from auth import get_current_user
from database import get_db
from routers import accounting as acct
from routers.construction import _log_activity, _may_review, _project, _visible_projects, now_iso

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,59}$")


def _today() -> str:
    return date.today().isoformat()


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
    spend = money.tagged_spend(db, p.id)
    return {
        "allowed": True, "jobId": p.id, "link": _link(p), "currency": (p.currency or "USD").upper(),
        "allowedEntities": acct.allowed_entities(user, db),
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
    out = {**ctx, "asOf": _today(), "mapped": bool(link["project"] and link["entity"]), "actual": None, "booksError": ""}
    if out["mapped"]:
        if not await _entity_ok(allowed, link["entity"]):
            # The job books to an entity the caller's accounting access does
            # not include: no figure from the books, not even a total.
            return {"allowed": False, "reason": "This job books to an entity outside your accounting access."}
        try:
            data = await acct._acct_get("/api/internal/reports/buckets", {
                "to": out["asOf"], "by": "item", "location": link["entity"], "project": link["project"]})
            out["actual"] = money.actual_from_buckets(data.get("rows") or [], data.get("labels") or {})
            link["entityName"] = await _entity_name(link["entity"])
        except HTTPException as e:
            out["booksError"] = str(e.detail)
    out.update(money.worked_out(
        actual=(out["actual"] or {}).get("amount") if out["actual"] else None,
        budget=out["budget"]["amount"], committed=out["committed"]["amount"],
        approved=out["changes"]["approved"], pending=out["changes"]["pending"]))
    return out


# ── Over Budget on the dashboard cards ──────────────────────────────────────
def _flag_context(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    jobs = []
    if int(user.get("level") or 0) >= money.MIN_LEVEL and money.has_accounting_grant(user, db):
        for p in _visible_projects(db, user):
            link = _link(p)
            if not (link["project"] and link["entity"]) or not p.contract_value:
                continue
            changes = money.job_changes(db, p.id)
            approved = sum(c["amount"] for c in changes if c["state"] == "approved")
            committed = money.requested_not_billed(money.tagged_spend(db, p.id), p.currency or "USD")["amount"]
            jobs.append({"id": p.id, **link, "budget": money.budget_of(p, approved)["amount"], "committed": committed})
        return {"jobs": jobs, "allowed": acct.allowed_entities(user, db)}
    return {"jobs": [], "allowed": set()}


@router.get("/money/flags")
async def money_flags(ctx: dict = Depends(_flag_context)):
    """{flags: {jobId: {overBudget}}} for the mapped jobs the caller may see
    the money of - one ledger read per entity (by Project-Job), cached like
    every report. A job whose books cannot be read is left out, never
    guessed."""
    by_entity: dict[str, list] = {}
    for j in ctx["jobs"]:
        by_entity.setdefault(j["entity"], []).append(j)
    flags = {}
    for entity, jobs in by_entity.items():
        if not await _entity_ok(ctx["allowed"], entity):
            continue
        try:
            data = await acct._acct_get("/api/internal/reports/buckets", {
                "to": _today(), "by": "project", "location": entity,
                "project": ",".join(sorted({j["project"] for j in jobs}))})
        except HTTPException:
            continue
        cost = money.cost_by_project(data.get("rows") or [])
        for j in jobs:
            actual = cost.get(j["project"], 0.0)
            flags[j["id"]] = {"overBudget": (actual + j["committed"]) > j["budget"] > 0}
    return {"flags": flags}


# ── Mapping a job to its Project-Job code ───────────────────────────────────
def _picker_context(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    if int(user.get("level") or 0) < money.MIN_LEVEL or not money.has_accounting_grant(user, db):
        raise HTTPException(403, "Mapping a job to the books needs a manager with Accounting access.")
    return {"allowed": acct.allowed_entities(user, db)}


@router.get("/books/projects")
async def book_projects(entity: str = "", ctx: dict = Depends(_picker_context)):
    """What the Edit Job picker offers: the entities the caller may read and,
    for the picked entity, the Project-Job codes. Company-wide accounting
    access lists every code on the ledger (/reports/dimensions?kind=project);
    a caller limited to certain entities may not read that list (it spans
    every entity), so they get the codes already on their entity's ledger
    lines (a by-Project-Job read of that entity) - `limited: true`."""
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
    if allowed is None:
        data = await acct._acct_get("/api/internal/reports/dimensions", {"kind": "project"})
        out["codes"] = [{"code": v.get("code"), "name": v.get("name") or "", "lines": v.get("lines")}
                        for v in data.get("values") or [] if v.get("code")]
    else:
        data = await acct._acct_get("/api/internal/reports/buckets", {"to": _today(), "by": "project", "location": entity})
        labels = data.get("labels") or {}
        codes = sorted({str(r.get("bucket") or "").strip() for r in data.get("rows") or []} - {""})
        out["codes"] = [{"code": c, "name": labels.get(c) or ""} for c in codes]
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
    return {"p": p, "db": db, "user": user, "allowed": acct.allowed_entities(user, db)}


def _save_link(db: Session, user: dict, p, code: str, entity: str) -> dict:
    was = _link(p)
    p.intacct_project_id, p.intacct_entity = code, entity
    p.modified_at = now_iso()
    words = f"mapped this job to Project-Job {code} on entity {entity}" if code else "cleared the job's Project-Job mapping"
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="edited",
                  actor_email=user["email"], detail=words)
    db.commit()
    return {"link": _link(p), "was": was}


@router.put("/projects/{project_id}/books")
async def map_books(body: BooksIn, ctx: dict = Depends(_map_context)):
    """Map the job to its existing Intacct Project-Job code and the entity it
    books to (Edit Job, managers with Accounting access). The caller must
    read the entity - the one it books to now and the new one - and the code
    must be on the books: on the ledger-wide list for company-wide access, on
    the entity's own lines for a caller limited to certain entities (a code
    with no lines yet is mapped by someone with company-wide access). Both
    empty clears the mapping."""
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
    else:
        data = await acct._acct_get("/api/internal/reports/buckets", {"to": _today(), "by": "project", "location": entity, "project": code})
        if not any(str(r.get("bucket") or "").strip() == code for r in data.get("rows") or []):
            raise HTTPException(422, f"Project-Job {code} has no lines on entity {entity} yet. Someone with company-wide accounting access can map it.")
    return await asyncio.to_thread(_save_link, ctx["db"], ctx["user"], p, code, entity)


# ── The job picker on a purchase request or a reimbursement ────────────────
@router.get("/spend-jobs")
def spend_jobs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Live jobs the caller may read (the company wall and the job's own
    lists), for the optional Job on a purchase request or a reimbursement:
    [{id, name, code}], the caller's own jobs first. Empty = no picker."""
    me = (user.get("email") or "").lower()
    rows = [p for p in _visible_projects(db, user)
            if (p.status or "active") in ("active", "on_hold") and not p.archived]
    mine = lambda p: me in {(e or "").lower() for e in (p.worker_emails or []) + (p.manager_emails or [])}  # noqa: E731
    rows.sort(key=lambda p: (not mine(p), (p.name or "").lower()))
    return {"jobs": [{"id": p.id, "name": p.name, "code": p.code or ""} for p in rows]}
