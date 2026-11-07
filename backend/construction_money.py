"""A job's money (Neil, 11/03/2026, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr,
phase 4 "Money").

Neil's decision: money uses the EXISTING Intacct Project-Job dimension the
accounting reports already filter by (routers/accounting.py `project=`;
`/reports/dimensions?kind=project` lists the codes) - no accounting app
change. A job is mapped to its Project-Job code and the entity (Intacct
location) it books to (`construction_projects.intacct_project_id` /
`intacct_entity`), and everything posted is READ from the books through the
accounting proxy - never the accounting database, never a cost keyed into
Nexus (the Leasing rule).

This file holds the pure rules and the Nexus-side reads; the routes and the
accounting calls are routers/construction_money.py.

  WHO      managers and above (role level 3+) who may read the job and see
           its contract value (the job's own managers, or a manager by role
           inside its company - routers/construction._may_see_cost), AND who
           hold the Accounting grant with the job's entity inside their
           entity access (routers/accounting.allowed_entities - the same
           limit every report read obeys). Anyone else never sees the tab or
           a figure.
  ACTUAL   posted ledger lines (accrual book) for the Project-Job on the
           entity, from the start of the books to the jobsite's today, on
           cost accounts only: cost of sales, operating and other expenses,
           and capitalized cost - an asset account the chart of accounts
           (/api/internal/accounts: bank_kind, category, group) does not mark
           as cash or a bank, a receivable, a deposit, a due-from, escrow, a
           loan to someone, accumulated depreciation or a prepaid (a
           self-storage build is capitalized into construction in progress).
           Words in the ledger row's title decide only when the chart is
           unavailable. Revenue, liabilities, equity and cash are left out,
           so the AP and payment sides of a bill never count twice.
  BY       cost code = the Intacct item dimension when the lines carry it,
           else by GL account.
  BUDGET   the accounting app has no budget by Project-Job (its budget is per
           entity and account, /reports/budget), so the budget is the job's
           own contract value plus approved changes - labeled as such.
  COMMITTED the accounting app exposes no purchase orders, so this is what
           was approved against the job in Nexus and not yet approved for
           payment: tagged reimbursements their approver approved (HR not
           yet) - "Requested, Not Yet Billed". One HR approved is "Approved,
           Posting Soon" and one paid is "Paid" - listed, never summed (it
           may already be in Actual). A claim still with its approver is the
           employee's and never shown here. Purchase requests carry no
           amount: counted, not summed.
  CHANGES  phase 3's change orders (construction_change_orders), read
           through job_changes(): Signed = approved, Awaiting Approval / Sent =
           pending; draft, declined and void left out.
  FORECAST worked out, the standard estimate at completion: the larger of the
           budget with its pending changes (it already holds the approved
           ones) and actual + requested-not-billed. A worked-out figure
           (forecast, variance, percent) is never drillable and says so.
"""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

import models

# ── Who may see a job's money ───────────────────────────────────────────────
MIN_LEVEL = 3   # manager (auth._LEVELS)


def has_accounting_grant(user: dict, db: Session) -> bool:
    """require_module_grant("accounting", "viewer") without the raise: an
    administrator and above, or an Accounting Access Group grant."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level
    if int(user.get("level") or 0) >= _LEVELS["administrator"]:
        return True
    return _module_level(user["email"], "accounting", db) >= _MODULE_LEVEL_RANK["viewer"]


def money_gate(db: Session, user: dict, p) -> str:
    """'' when the caller may open this job's Money (the entity check, which
    needs the accounting app's entity tree, comes after), else why not."""
    from routers.construction import _may_read, _may_see_cost
    if int(user.get("level") or 0) < MIN_LEVEL:
        return "Money is for managers and above."
    if not _may_read(db, user, p) or not _may_see_cost(db, user, p):
        # The contract value rule: the job's own managers, or a manager by
        # role inside the job's company.
        return "You do not have access to this job's money."
    if not has_accounting_grant(user, db):
        return "Money needs Accounting access."
    return ""


# ── Cost accounts and grouping ──────────────────────────────────────────────
COST_SECTIONS = ("cogs", "expense", "other_expense")
# An asset that is not the job's cost. Read against the chart of accounts'
# own words (category, group, type, title) when the chart answers; against the
# ledger row's title alone only when it does not.
_NOT_COST_ASSET = re.compile(
    r"\b(cash|banks?|checking|chkg|savings|petty|money\s*market|receivables?|a/?r|undeposited|clearing"
    r"|deposits?|due\s+from|intercompany|escrow|loans?\s+(to|receivable)|notes?\s+receivable"
    r"|accum(ulated|\.)?\s*(depr|depreciation|amort|amortization)|prepaids?|prepayments?)\b",
    re.I)


def chart_index(accounts) -> dict | None:
    """{account_no: chart row} from /api/internal/accounts; None when the
    chart is unavailable (the rules then fall back to titles)."""
    if accounts is None:
        return None
    return {str(a.get("account_no") or ""): a for a in accounts if isinstance(a, dict) and a.get("account_no")}


def is_cost_account(row: dict, chart: dict | None = None) -> bool:
    """Does a ledger account count toward the job's cost? Cost of sales and
    expenses always; an asset account when it is capitalized cost - the
    chart of accounts says it is not a bank (bank_kind) and its category,
    group, type or title is none of cash, receivables, deposits, due-from,
    escrow, loans to, accumulated depreciation or prepaid. A statistical
    account never counts."""
    section = str(row.get("section") or "").lower()
    acct = chart.get(str(row.get("account_no") or "")) if chart else None
    if acct is not None:
        if acct.get("statistical"):
            return False
        section = str(acct.get("section") or section).lower()
    if section in COST_SECTIONS:
        return True
    if section != "asset":
        return False
    if acct is not None:
        if acct.get("bank_kind"):
            return False
        words = " ".join(str(acct.get(k) or "") for k in ("category", "group", "account_type", "title"))
        return not _NOT_COST_ASSET.search(words)
    return not row.get("bank_kind") and not _NOT_COST_ASSET.search(str(row.get("title") or ""))


def _net(row: dict) -> float:
    return round(float(row.get("debit") or 0) - float(row.get("credit") or 0), 2)


def actual_from_buckets(rows: list, labels: dict | None = None, chart: dict | None = None) -> dict:
    """The job's actual cost from a `/reports/buckets?by=item` answer (one row
    per account and item code). Answers {amount, by: 'item'|'account', rows:
    [{key, code, label, amount, accounts: [{account_no, title, section,
    amount}]}], left: [{account_no, title, section, amount}]} - `left` is the
    lines on the Project-Job that are not cost (shown, never added)."""
    labels = labels or {}
    cost, left = [], {}
    for r in rows or []:
        if is_cost_account(r, chart):
            cost.append(r)
        else:
            k = str(r.get("account_no") or "")
            cur = left.setdefault(k, {"account_no": k, "title": r.get("title") or "", "section": r.get("section") or "", "amount": 0.0})
            cur["amount"] = round(cur["amount"] + _net(r), 2)
    by_item = any(str(r.get("bucket") or "").strip() for r in cost)
    groups: dict[str, dict] = {}
    for r in cost:
        acct = str(r.get("account_no") or "")
        if by_item:
            code = str(r.get("bucket") or "").strip()
            key = code or "-"
            label = (labels.get(code) or code) if code else "No Cost Code"
        else:
            code, key, label = acct, acct, str(r.get("title") or acct)
        g = groups.setdefault(key, {"key": key, "code": code, "label": label, "amount": 0.0, "accounts": {}})
        a = g["accounts"].setdefault(acct, {"account_no": acct, "title": r.get("title") or "", "section": r.get("section") or "", "amount": 0.0})
        a["amount"] = round(a["amount"] + _net(r), 2)
        g["amount"] = round(g["amount"] + _net(r), 2)
    out = []
    for g in groups.values():
        accounts = sorted(g["accounts"].values(), key=lambda a: a["account_no"])
        out.append({**g, "accounts": accounts})
    # Cost codes in code order, "No Cost Code" last; accounts by number.
    out.sort(key=lambda g: (g["key"] == "-", g["code"] or g["key"]))
    return {"amount": round(sum(g["amount"] for g in out), 2), "by": "item" if by_item else "account",
            "rows": out, "left": sorted((v for v in left.values() if v["amount"]), key=lambda a: a["account_no"])}


def cost_by_project(rows: list, chart: dict | None = None) -> dict:
    """{project code: actual cost} from a `/reports/buckets?by=project` answer
    (the dashboard's Over Budget flag - one read per entity)."""
    out: dict[str, float] = {}
    for r in rows or []:
        if not is_cost_account(r, chart):
            continue
        code = str(r.get("bucket") or "").strip()
        if code:
            out[code] = round(out.get(code, 0.0) + _net(r), 2)
    return out


# ── Change orders (phase 3, construction_models.ConstructionChangeOrder) ───
# Signed through Nexus Sign = approved (signing is what moves the contract);
# waiting on the internal approver or sent for the owner's signature =
# pending. Draft, declined and void change orders are left out.
APPROVED_CHANGE = {"signed"}
PENDING_CHANGE = {"awaiting_approval", "sent"}


def job_changes(db: Session, project_id: str) -> list:
    """The job's change orders as [{id, number, title, status, state:
    approved|pending, amount}] - read only, from construction_change_orders
    (phase 3, routers/construction_handover.py owns every write)."""
    co = models.ConstructionChangeOrder
    rows = (db.query(co)
            .filter(co.project_id == project_id, co.deleted_at == "",
                    co.status.in_(APPROVED_CHANGE | PENDING_CHANGE))
            .order_by(co.number, co.created_at).all())
    return [{"id": r.id, "title": r.title or "", "number": r.number or "",
             "status": r.status, "state": "approved" if r.status in APPROVED_CHANGE else "pending",
             "amount": round(float(r.amount or 0.0), 2)} for r in rows]


# ── Spend tagged to the job in Nexus ────────────────────────────────────────
PR_OPEN = {"pending_manager", "manager_approved", "ordered"}
PR_RECEIVED = {"fulfilled", "asset_allocated", "return_initiated", "returned", "asset_lost"}
# Reimbursements shown on the job: approved by their approver or later only.
# approver_approved = Requested, Not Yet Billed (the committed figure);
# hr_approved = Approved, Posting Soon and paid = Paid - listed, never summed.
RB_STAGE = {"approver_approved": "requested", "hr_approved": "posting", "paid": "paid"}


def _pr_rows(rows) -> list:
    return [{
        "id": r.id, "item": r.item or "", "quantity": int(r.quantity or 1), "requestedBy": r.employee_name or r.employee_email or "",
        "status": r.status or "", "createdAt": r.created_at or "",
        "stage": "requested" if (r.status or "") in PR_OPEN else "received",
    } for r in rows]


def _rb_row(r, show_filer: bool) -> dict:
    return {
        "id": r.id, "item": r.item or "", "vendor": r.vendor or "", "amount": round(float(r.amount or 0), 2),
        "currency": (r.currency or "USD").upper(),
        "requestedBy": (r.employee_name or r.employee_email or "") if show_filer else "",
        "status": r.status or "", "purchaseDate": r.purchase_date or "", "paidOn": r.paid_on or "",
        "stage": RB_STAGE.get(r.status or "", "requested"),
    }


def _may_see_filer(db: Session, viewer: str, r) -> bool:
    """Who filed a claim is the employee's, their approver's and HR's
    (timesheet_review.is_hr - as on the Reimbursements screen)."""
    me = (viewer or "").strip().lower()
    if not me:
        return False
    if me in ((r.employee_email or "").lower(), (r.approver_email or "").lower()):
        return True
    import timesheet_review
    return bool(timesheet_review.is_hr(db, me, r.employee_email))


def tagged_spend(db: Session, project_id: str, viewer: str = "") -> dict:
    """Purchase requests and reimbursements tagged to the job. Nothing here
    is a posted figure. Reimbursements show from their approver's approval
    on (a claim still with its approver is the employee's), with the filer's
    name only for the employee, their approver and HR (`viewer`). A paid one
    reaches the books when accounting posts it (no reliable line-by-line
    match exists), so it is listed, never added."""
    R = models.Requisition
    E = models.ExpenseReimbursement
    prs = (db.query(R).filter(R.job_id == project_id, R.status != "rejected")
           .order_by(R.created_at.desc()).limit(200).all())
    rbs = (db.query(E).filter(E.job_id == project_id, E.status.in_(tuple(RB_STAGE)))
           .order_by(E.created_at.desc()).limit(200).all())
    return {"purchaseRequests": _pr_rows(prs),
            "reimbursements": [_rb_row(r, _may_see_filer(db, viewer, r)) for r in rbs]}


def committed_by_job(db: Session, jobs) -> dict:
    """{job id: requested-not-billed amount} for many jobs in ONE read (the
    dashboard's Over Budget flags): approver-approved reimbursements in each
    job's currency."""
    cur = {p.id: (p.currency or "USD").upper() for p in jobs}
    if not cur:
        return {}
    E = models.ExpenseReimbursement
    out = {jid: 0.0 for jid in cur}
    for jid, amount, currency in (db.query(E.job_id, E.amount, E.currency)
                                  .filter(E.job_id.in_(tuple(cur)), E.status == "approver_approved").all()):
        if (currency or "USD").upper() == cur.get(jid):
            out[jid] = round(out[jid] + float(amount or 0), 2)
    return out


def requested_not_billed(spend: dict, currency: str = "USD") -> dict:
    """The committed figure: reimbursements approved by their approver and not
    yet by HR, in the job's currency (a claim in another currency is listed,
    never converted). Purchase requests carry no amount, so they are counted."""
    cur = (currency or "USD").upper()
    rb_open = [r for r in spend.get("reimbursements") or [] if r["stage"] == "requested"]
    same = [r for r in rb_open if r["currency"] == cur]
    return {"amount": round(sum(r["amount"] for r in same), 2),
            "reimbursements": len(same), "otherCurrency": len(rb_open) - len(same),
            "purchaseRequests": sum(1 for r in spend.get("purchaseRequests") or [] if r["stage"] == "requested")}


def worked_out(*, actual: float | None, budget: float, committed: float, pending: float) -> dict:
    """The figures worked out from the others - never posted, never drillable.
    Forecast at completion is the standard one: the larger of the budget with
    its pending changes (it already holds the approved ones) and what is
    spent and requested. With no actual from the books (not mapped, or the
    books unreadable) nothing is worked out - a forecast without the actual
    would read as a job that has spent nothing."""
    if actual is None:
        return {"forecast": None, "variance": None, "percentSpent": None, "overBudget": False}
    act = float(actual)
    forecast = round(max(budget + pending, act + committed), 2)
    return {"forecast": forecast, "variance": round(budget - forecast, 2) if budget else None,
            "percentSpent": round(act / budget, 4) if budget else None,
            "overBudget": bool(budget) and (act + committed) > budget}


def budget_of(p, approved_changes: float) -> dict:
    cv = round(float(getattr(p, "contract_value", 0) or 0), 2)
    return {"amount": round(cv + approved_changes, 2) if cv else 0.0, "contractValue": cv,
            "approvedChanges": round(approved_changes, 2), "source": "contract"}


# ── Tagging a request to a job ──────────────────────────────────────────────
def taggable(p) -> bool:
    """A job takes new spend unless it is archived; a completed one still
    does (late receipts and the last invoices)."""
    return not p.archived and (p.status or "active") != "archived"


def check_job_tag(db: Session, user: dict, job_id: str | None) -> str:
    """The job a purchase request or a reimbursement may be tagged with: ''
    (none), or a job that is not archived and that the caller may read (the
    construction walls - a job behind them is refused the same way as one
    that does not exist)."""
    jid = (job_id or "").strip()[:64]
    if not jid:
        return ""
    from fastapi import HTTPException
    from routers.construction import _may_read
    p = (db.query(models.ConstructionProject)
         .filter(models.ConstructionProject.id == jid, models.ConstructionProject.deleted_at == "").first())
    if p is None or not _may_read(db, user, p):
        raise HTTPException(422, "Pick a job you are on.")
    if not taggable(p):
        raise HTTPException(422, "That job is archived. Pick a live job.")
    return jid


def job_names(db: Session, ids) -> dict:
    """{job id: name} to show the tag on a request the reader may already
    see (a name only - no figure, no reach beyond the request itself)."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    P = models.ConstructionProject
    return {r.id: r.name for r in db.query(P.id, P.name).filter(P.id.in_(ids), P.deleted_at == "").all()}


# ── Commitments and lien waivers (Round Two item 8, Neil, 11/06/2026) ───────
# A commitment is a subcontract or purchase order with one of Intacct's
# vendors (construction_models.ConstructionCommitment). What was billed
# against it is READ from the books: the job's Project-Job lines for that
# vendor (/reports/buckets?by=vendor), cost accounts only - never typed.
# OPEN = what is committed and not billed yet, per vendor: the live
# commitments' amounts less what the vendor has billed on the job (never
# below zero; a vendor whose commitments are all closed owes nothing more).
# The forecast reads actual + open commitments + requested-not-billed, so a
# commitment billed in full is never counted twice.
COMMIT_PREFIX = {"subcontract": "SC", "purchase_order": "PO"}
COMMIT_KIND_LABEL = {"subcontract": "Subcontract", "purchase_order": "Purchase Order"}
COMMIT_STATUSES = ("active", "closed", "void")
WAIVER_KINDS = {"conditional_progress": "Conditional Progress", "unconditional_progress": "Unconditional Progress",
                "conditional_final": "Conditional Final", "unconditional_final": "Unconditional Final"}
MAX_RETAINAGE = 20.0


def job_commitments(db: Session, project_id: str) -> list:
    """The job's commitments that are not void, in number order."""
    C = models.ConstructionCommitment
    return (db.query(C).filter(C.project_id == project_id, C.status != "void")
            .order_by(C.number, C.created_at).all())


def billed_by_vendor(rows: list, chart: dict | None = None) -> dict:
    """{vendor id: {amount, accounts: [{account_no, title, amount}]}} from a
    `/reports/buckets?by=vendor` answer on the job's Project-Job - cost
    accounts only (the same rule as Actual), so the AP side never counts."""
    out: dict[str, dict] = {}
    for r in rows or []:
        vid = str(r.get("bucket") or "").strip()
        if not vid or not is_cost_account(r, chart):
            continue
        v = out.setdefault(vid, {"amount": 0.0, "accounts": {}})
        acct = str(r.get("account_no") or "")
        a = v["accounts"].setdefault(acct, {"account_no": acct, "title": r.get("title") or "", "amount": 0.0})
        a["amount"] = round(a["amount"] + _net(r), 2)
        v["amount"] = round(v["amount"] + _net(r), 2)
    return {k: {"amount": v["amount"], "accounts": sorted(v["accounts"].values(), key=lambda a: a["account_no"])}
            for k, v in out.items()}


def live_waivers(c) -> list:
    return [w for w in (c.waivers or []) if isinstance(w, dict) and not w.get("removedAt")]


def last_waiver(c) -> dict | None:
    """The waiver that reaches furthest (latest through date), or None."""
    ws = live_waivers(c)
    return max(ws, key=lambda w: (str(w.get("throughOn") or ""), str(w.get("at") or ""))) if ws else None


def commitments_view(commitments, billed: dict | None) -> dict:
    """The Money tab's commitments: each row with Billed to Date (None when the
    books were not read), Remaining and Retainage Held (worked out, only when
    the vendor has one commitment on the job - two share the vendor's lines),
    and its last waiver. `total` = the live commitments' amounts; `open` =
    committed, not yet billed (what the forecast adds)."""
    by_vendor: dict[str, list] = {}
    for c in commitments:
        by_vendor.setdefault(c.vendor_id or "", []).append(c)
    rows, open_total = [], 0.0
    for vid, cs in by_vendor.items():
        got = billed.get(vid) if billed is not None else None
        b = got["amount"] if got else (0.0 if billed is not None else None)
        live = [c for c in cs if c.status == "active"]
        if live:
            amt = sum(float(c.amount or 0) for c in cs)
            open_total += max(0.0, amt - (b or 0.0)) if b is not None else sum(float(c.amount or 0) for c in live)
        shared = len(cs) > 1
        for c in cs:
            amount = round(float(c.amount or 0), 2)
            alone = b is not None and not shared
            remaining = 0.0 if c.status == "closed" else (round(max(0.0, amount - b), 2) if alone else None)
            lw = last_waiver(c)
            rows.append({
                "id": c.id, "number": c.number or "", "kind": c.kind or "subcontract",
                "kindLabel": COMMIT_KIND_LABEL.get(c.kind or "", "Subcontract"),
                "vendorId": vid, "vendorName": c.vendor_name or vid, "title": c.title or "",
                "originalAmount": round(float(c.original_amount or 0), 2), "amount": amount,
                "retainagePct": float(c.retainage_pct or 0), "status": c.status or "active",
                "contractUrl": c.contract_url or "", "contractName": c.contract_name or "", "notes": c.notes or "",
                "billed": b, "billedAccounts": (got or {}).get("accounts", []), "sharedVendor": shared,
                "remaining": remaining,
                "retainageHeld": round(b * float(c.retainage_pct or 0) / 100, 2) if alone and c.retainage_pct else None,
                "waivers": live_waivers(c), "lastWaiver": lw,
                # A vendor that billed with no waiver on file is the lien risk.
                "waiverMissing": bool(b and b > 0 and lw is None),
            })
    rows.sort(key=lambda r: (r["number"], r["vendorName"]))
    return {"rows": rows, "total": round(sum(r["amount"] for r in rows), 2), "open": round(open_total, 2),
            "billedKnown": billed is not None}
