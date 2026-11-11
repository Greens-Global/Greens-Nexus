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
  POST /construction/projects/{id}/commitments          a subcontract or PO (Round Two item 8)
  PATCH /construction/commitments/{id}                  edit; a new amount needs a reason
  POST /construction/commitments/{id}/waivers           a lien waiver received
  POST /construction/commitments/{id}/waivers/{w}/remove
  GET  /construction/projects/{id}/cost-codes           the commitment's cost code picker (Round Three)
"""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_company
import construction_money as money
import models
from auth import get_current_user
from database import get_db
from routers import accounting as acct
from routers.construction import _DAY, _log_activity, _may_review, _may_see_cost, _project, _visible_projects, now_iso

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
        "commitmentRows": money.job_commitments(db, p.id),
    }


async def _billed(link: dict, as_of: str, chart) -> dict:
    """What each vendor billed on the job's Project-Job (cost lines only)."""
    data = await acct._acct_get("/api/internal/reports/buckets", {
        "to": as_of, "by": "vendor", "location": link["entity"], "project": link["project"]})
    return money.billed_by_vendor(data.get("rows") or [], chart)


@router.get("/projects/{project_id}/money")
async def job_money(ctx: dict = Depends(_money_context)):
    """The job's Money: budget, requested-not-billed, actual to date (posted,
    by cost code or GL account, every figure drillable on the screen),
    approved and pending changes, and the worked-out forecast. A caller who
    may not see it gets {allowed: false, reason} - never a figure."""
    if not ctx["allowed"]:
        return {"allowed": False, "reason": ctx["reason"]}
    allowed = ctx.pop("allowedEntities")
    commitments = ctx.pop("commitmentRows")
    link = ctx["link"]
    out = {**ctx, "book": "accrual", "mapped": bool(link["project"] and link["entity"]), "actual": None, "client": None,
           "booksError": ""}
    billed = None
    if out["mapped"]:
        if not await _entity_ok(allowed, link["entity"]):
            # The job books to an entity the caller's accounting access does
            # not include: no figure from the books, not even a total.
            return {"allowed": False, "reason": "This job books to an entity outside your accounting access."}
        try:
            data = await acct._acct_get("/api/internal/reports/buckets", {
                "to": out["asOf"], "by": "item", "location": link["entity"], "project": link["project"]})
            chart = await _chart()
            out["actual"] = money.actual_from_buckets(data.get("rows") or [], data.get("labels") or {}, chart)
            # Round Three (11/11/2026): billed to and received from the client,
            # from the same read.
            out["client"] = money.client_side(data.get("rows") or [], chart)
            link["entityName"] = await _entity_name(link["entity"])
            if commitments:
                billed = await _billed(link, out["asOf"], chart)
        except HTTPException as e:
            out["booksError"] = str(e.detail)
    out["commitments"] = money.commitments_view(commitments, billed)
    out["committedByCode"] = money.committed_by_code(commitments)
    # The forecast adds what is committed and not billed yet (Round Two item 8).
    out.update(money.worked_out(
        actual=(out["actual"] or {}).get("amount") if out["actual"] else None,
        budget=out["budget"]["amount"], committed=out["committed"]["amount"] + out["commitments"]["open"],
        pending=out["changes"]["pending"]))
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
                     "pending": sum(c["amount"] for c in changes if c["state"] == "pending"),
                     "commitments": money.job_commitments(db, p.id)})
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
            committed = j["committed"]
            if j["commitments"]:
                # A job with commitments reads its vendors' billing too (one
                # cached read per such job) - the same figure as the tab.
                try:
                    billed = await _billed(j, today, chart)
                except HTTPException:
                    continue
                committed += money.commitments_view(j["commitments"], billed)["open"]
            # The Program table (Round Two, 11/05/2026) reads the same figures
            # the Money tab shows, for the same readers.
            w = money.worked_out(actual=actual, budget=j["budget"], committed=committed, pending=j["pending"])
            flags[j["id"]] = {"overBudget": (actual + committed) > j["budget"] > 0,
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


# ── Commitments and lien waivers (Round Two item 8, Neil, 11/06/2026) ───────
# Kept by the job's managers who may also see its money (the Money tab's
# gate) - a commitment is a dollar figure. The vendor must be on Intacct's
# list (the same read as a sub); billed-to-date is the books' (job_money).
_TITLE_MAX, _NOTE_MAX, _WAIVERS_MAX = 200, 2000, 120


def _commit_ctx(project_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    p = _project(db, project_id, user)            # 404 behind the wall
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager keeps the commitments.")
    why = money.money_gate(db, user, p)
    if why:
        raise HTTPException(403, why)
    return {"p": p, "db": db, "user": user, "allowed": acct.allowed_entities(user, db), "today": _today(db, p)}


def _found_ctx(commitment_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    c = db.get(models.ConstructionCommitment, commitment_id)
    if c is None:
        raise HTTPException(404, "Not found")
    return {**_commit_ctx(c.project_id, user, db), "c": c}


async def _entity_gate(ctx: dict) -> None:
    ent = ctx["p"].intacct_entity or ""
    if ent and not await _entity_ok(ctx["allowed"], ent):
        raise HTTPException(403, "This job books to an entity outside your accounting access.")


def _amount(v, what: str = "The amount") -> float:
    try:
        x = round(float(v), 2)
    except (TypeError, ValueError):
        raise HTTPException(422, f"{what} must be a number.")
    if x < 0 or x > 1_000_000_000:
        raise HTTPException(422, f"{what} must be between 0 and 1,000,000,000.")
    return x


def _retainage(v) -> float:
    x = _amount(v or 0, "Retainage")
    if x > money.MAX_RETAINAGE:
        raise HTTPException(422, f"Retainage is at most {money.MAX_RETAINAGE:g}%.")
    return x


def _file(url, project_id: str) -> str:
    from routers.construction_handover import _one_url
    return _one_url(str(url or ""), project_id)


def _dollars(v) -> str:
    return f"${float(v or 0):,.2f}"


def _cost_code(v) -> str:
    code = (v or "").strip()
    if code and not _CODE.match(code):
        raise HTTPException(422, "That is not a cost code.")
    return code


class CommitmentIn(BaseModel):
    kind: Optional[str] = "subcontract"
    vendor_id: str
    cost_code: Optional[str] = ""
    title: Optional[str] = ""
    amount: float
    retainage_pct: Optional[float] = 0
    contract_url: Optional[str] = ""
    contract_name: Optional[str] = ""
    notes: Optional[str] = ""


def _create(ctx: dict, body: CommitmentIn, vid: str, vendor_name: str) -> dict:
    db, p, me = ctx["db"], ctx["p"], (ctx["user"].get("email") or "").lower()
    C = models.ConstructionCommitment
    prefix = money.COMMIT_PREFIX[body.kind]
    top = 0
    for (n,) in db.query(C.number).filter(C.project_id == p.id, C.number.like(f"{prefix}-%")).all():
        try:
            top = max(top, int(str(n).split("-")[-1]))
        except ValueError:
            continue
    amount = _amount(body.amount)
    if amount <= 0:
        raise HTTPException(422, "A commitment needs an amount.")
    c = C(id=str(uuid.uuid4()), project_id=p.id, number=f"{prefix}-{top + 1:03d}", kind=body.kind, vendor_id=vid,
          vendor_name=vendor_name, title=(body.title or "").strip()[:_TITLE_MAX], original_amount=amount, amount=amount,
          retainage_pct=_retainage(body.retainage_pct), status="active", contract_url=_file(body.contract_url, p.id),
          contract_name=(body.contract_name or "").strip()[:_TITLE_MAX], waivers=[],
          notes=(body.notes or "").strip()[:_NOTE_MAX], cost_code=_cost_code(body.cost_code),
          created_by=me, created_at=now_iso(), modified_at=now_iso())
    db.add(c)
    _log_activity(db, project_id=p.id, entity_kind="commitment", entity_id=c.id, type="commitment_added", actor_email=me,
                  detail=f"{c.number} {vendor_name}: {_dollars(amount)}")
    db.commit()
    return {"ok": True, "id": c.id, "number": c.number}


@router.post("/projects/{project_id}/commitments", status_code=201)
async def add_commitment(body: CommitmentIn, ctx: dict = Depends(_commit_ctx)):
    """A subcontract or purchase order with one of Intacct's vendors."""
    await _entity_gate(ctx)
    if body.kind not in money.COMMIT_PREFIX:
        raise HTTPException(422, "A commitment is a subcontract or a purchase order.")
    vid = (body.vendor_id or "").strip()[:60]
    if not vid:
        raise HTTPException(422, "Pick a vendor.")
    from routers.construction_subs import _vendor
    v = await _vendor(vid)
    if v is None:
        raise HTTPException(422, f"Vendor {vid} is not on the Intacct vendor list.")
    return await asyncio.to_thread(_create, ctx, body, vid, v["displayName"] or v["name"] or vid)


class CommitmentPatch(BaseModel):
    title: Optional[str] = None
    cost_code: Optional[str] = None
    amount: Optional[float] = None
    reason: Optional[str] = ""
    retainage_pct: Optional[float] = None
    contract_url: Optional[str] = None
    contract_name: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None


def _patch(ctx: dict, body: CommitmentPatch) -> dict:
    db, p, me = ctx["db"], ctx["p"], (ctx["user"].get("email") or "").lower()
    C = models.ConstructionCommitment
    c = db.query(C).filter(C.id == ctx["c"].id).with_for_update().first()
    if c.status == "void":
        raise HTTPException(409, "This commitment is void.")
    if body.amount is not None:
        new = _amount(body.amount)
        if new != round(float(c.amount or 0), 2):
            reason = (body.reason or "").strip()[:300]
            if len(reason) < 3:
                raise HTTPException(422, "Say why the amount changed.")
            db.add(models.ConstructionActivity(
                id=str(uuid.uuid4()), project_id=p.id, entity_kind="commitment", entity_id=c.id,
                type="commitment_changed", actor_email=me, at=now_iso(),
                detail=f"{c.number} {_dollars(c.amount)} -> {_dollars(new)}: {reason}"[:500],
                before={"amount": c.amount}, after={"amount": new, "reason": reason}))
            c.amount = new
    if body.retainage_pct is not None:
        c.retainage_pct = _retainage(body.retainage_pct)
    if body.title is not None:
        c.title = body.title.strip()[:_TITLE_MAX]
    if body.cost_code is not None:
        c.cost_code = _cost_code(body.cost_code)
    if body.contract_url is not None:
        c.contract_url = _file(body.contract_url, p.id)
    if body.contract_name is not None:
        c.contract_name = body.contract_name.strip()[:_TITLE_MAX]
    if body.notes is not None:
        c.notes = body.notes.strip()[:_NOTE_MAX]
    if body.status is not None and body.status != c.status:
        if body.status not in money.COMMIT_STATUSES:
            raise HTTPException(422, "Status is Active, Closed or Void.")
        _log_activity(db, project_id=p.id, entity_kind="commitment", entity_id=c.id, type=f"commitment_{body.status}",
                      actor_email=me, detail=f"{c.number} {c.status} -> {body.status}")
        c.status = body.status
    c.modified_at = now_iso()
    db.commit()
    return {"ok": True, "id": c.id}


@router.patch("/commitments/{commitment_id}")
async def edit_commitment(body: CommitmentPatch, ctx: dict = Depends(_found_ctx)):
    """Edit a commitment. A new amount needs a reason (kept with before and
    after on the job's activity); Closed means it bills nothing more; Void
    takes it out of every figure. Never deleted."""
    await _entity_gate(ctx)
    return await asyncio.to_thread(_patch, ctx, body)


class WaiverIn(BaseModel):
    kind: str
    through_on: str
    amount: Optional[float] = 0
    received_on: Optional[str] = ""
    file_url: Optional[str] = ""
    file_name: Optional[str] = ""


def _add_waiver(ctx: dict, body: WaiverIn) -> dict:
    db, p, me = ctx["db"], ctx["p"], (ctx["user"].get("email") or "").lower()
    C = models.ConstructionCommitment
    c = db.query(C).filter(C.id == ctx["c"].id).with_for_update().first()
    if c.status == "void":
        raise HTTPException(409, "This commitment is void.")
    if len(c.waivers or []) >= _WAIVERS_MAX:
        raise HTTPException(422, "This commitment holds as many waivers as it can.")
    w = {"id": str(uuid.uuid4()), "kind": body.kind, "throughOn": body.through_on,
         "amount": _amount(body.amount or 0), "receivedOn": body.received_on or ctx["today"],
         "fileUrl": _file(body.file_url, p.id), "fileName": (body.file_name or "").strip()[:_TITLE_MAX],
         "by": me, "at": now_iso()}
    c.waivers = [*(c.waivers or []), w]           # a new list, so the JSON change is seen
    c.modified_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind="commitment", entity_id=c.id, type="waiver_received", actor_email=me,
                  detail=f"{c.number} {money.WAIVER_KINDS[body.kind]} lien waiver through {body.through_on}")
    db.commit()
    return {"ok": True, "id": w["id"]}


@router.post("/commitments/{commitment_id}/waivers", status_code=201)
async def add_waiver(body: WaiverIn, ctx: dict = Depends(_found_ctx)):
    """A lien waiver received from the vendor: its kind, the day it is
    through, the amount, and the signed copy. The vendor's own (state) form
    is what is kept - Nexus never writes waiver wording."""
    await _entity_gate(ctx)
    if body.kind not in money.WAIVER_KINDS:
        raise HTTPException(422, "Pick the kind of waiver.")
    if not _DAY.match(body.through_on or ""):
        raise HTTPException(422, "Through needs a date.")
    if body.received_on and not _DAY.match(body.received_on):
        raise HTTPException(422, "Received needs a date.")
    return await asyncio.to_thread(_add_waiver, ctx, body)


def _remove_waiver(ctx: dict, waiver_id: str) -> dict:
    db, p, me = ctx["db"], ctx["p"], (ctx["user"].get("email") or "").lower()
    C = models.ConstructionCommitment
    c = db.query(C).filter(C.id == ctx["c"].id).with_for_update().first()
    ws = [dict(w) for w in (c.waivers or [])]
    hit = next((w for w in ws if w.get("id") == waiver_id and not w.get("removedAt")), None)
    if hit is None:
        raise HTTPException(404, "Not found")
    hit["removedAt"], hit["removedBy"] = now_iso(), me
    c.waivers, c.modified_at = ws, now_iso()
    _log_activity(db, project_id=p.id, entity_kind="commitment", entity_id=c.id, type="waiver_removed", actor_email=me,
                  detail=f"{c.number} waiver through {hit.get('throughOn', '')} removed")
    db.commit()
    return {"ok": True}


@router.post("/commitments/{commitment_id}/waivers/{waiver_id}/remove")
async def remove_waiver(waiver_id: str, ctx: dict = Depends(_found_ctx)):
    await _entity_gate(ctx)
    return await asyncio.to_thread(_remove_waiver, ctx, waiver_id)


# ── Cost codes for a commitment (Round Three item 2, 11/11/2026) ───────────
@router.get("/projects/{project_id}/cost-codes")
async def job_cost_codes(ctx: dict = Depends(_commit_ctx)):
    """The cost codes (Intacct items) a commitment on this job may carry.
    Company-wide accounting access lists every item on the ledger
    (/reports/dimensions?kind=item); a caller limited to certain entities
    cannot read that list, so they get the items already on the job's
    entity's lines. Codes on the job's own lines come first."""
    await _entity_gate(ctx)
    p, allowed = ctx["p"], ctx["allowed"]
    entity = p.intacct_entity or ""
    on_job: dict = {}
    if entity and p.intacct_project_id:
        data = await acct._acct_get("/api/internal/reports/buckets", {
            "to": ctx["today"], "by": "item", "location": entity, "project": p.intacct_project_id})
        labels = data.get("labels") or {}
        on_job = {c: labels.get(c) or "" for c in {str(r.get("bucket") or "").strip() for r in data.get("rows") or []} - {""}}
    codes: dict = {}
    if allowed is None:
        data = await acct._acct_get("/api/internal/reports/dimensions", {"kind": "item"})
        codes = {str(v.get("code")): v.get("name") or "" for v in data.get("values") or [] if v.get("code")}
    elif entity:
        data = await acct._acct_get("/api/internal/reports/buckets", {"to": ctx["today"], "by": "item", "location": entity})
        labels = data.get("labels") or {}
        codes = {c: labels.get(c) or "" for c in {str(r.get("bucket") or "").strip() for r in data.get("rows") or []} - {""}}
    codes.update(on_job)
    rows = [{"code": c, "name": n, "onJob": c in on_job} for c, n in codes.items()]
    rows.sort(key=lambda r: (not r["onJob"], r["code"]))
    return {"codes": rows, "limited": allowed is not None}
