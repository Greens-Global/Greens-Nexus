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

  WHO      managers and above (role level 3+) who may read the job (its
           company wall), AND who hold the Accounting grant with the job's
           entity inside their entity access (routers/accounting
           .allowed_entities - the same limit every report read obeys). Anyone
           else never sees the tab or a figure.
  ACTUAL   posted ledger lines for the Project-Job on the entity, from the
           start of the books to today, on cost accounts only: cost of
           sales, operating and other expenses, and capitalized cost (an asset
           account that is not cash, a bank or a receivable - a self-storage
           build is capitalized into construction in progress). Revenue,
           liabilities, equity and cash are left out, so the AP and payment
           sides of a bill never count twice.
  BY       cost code = the Intacct item dimension when the lines carry it,
           else by GL account.
  BUDGET   the accounting app has no budget by Project-Job (its budget is per
           entity and account, /reports/budget), so the budget is the job's
           own contract value plus approved changes - labeled as such.
  COMMITTED the accounting app exposes no purchase orders, so this is what
           was asked for against the job in Nexus and not paid yet: tagged
           reimbursements (with their amounts) and tagged purchase requests
           (which carry no amount) - "Requested, Not Yet Billed".
  CHANGES  phase 3's change orders, read through job_changes(), which answers
           [] while that table does not exist - this branch stands alone.
  FORECAST worked out: actual + requested-not-billed + pending changes. A
           worked-out figure (forecast, variance, percent) is never drillable
           and says it is worked out.
"""
from __future__ import annotations

import re

from sqlalchemy import inspect
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
    from routers.construction import _may_read
    if int(user.get("level") or 0) < MIN_LEVEL:
        return "Money is for managers and above."
    if not _may_read(db, user, p):
        return "You do not have access to this job."
    if not has_accounting_grant(user, db):
        return "Money needs Accounting access."
    return ""


# ── Cost accounts and grouping ──────────────────────────────────────────────
COST_SECTIONS = ("cogs", "expense", "other_expense")
_NOT_COST_ASSET = re.compile(
    r"\b(cash|bank|banks|checking|chkg|savings|petty|money\s*market|receivables?|a/?r|undeposited|clearing|deposits?\s+in\s+transit)\b",
    re.I)


def is_cost_account(row: dict) -> bool:
    """Does a ledger account count toward the job's cost? Cost of sales and
    expenses always; an asset account when it is capitalized cost (not cash,
    a bank account or a receivable)."""
    section = str(row.get("section") or "").lower()
    if section in COST_SECTIONS:
        return True
    if section == "asset":
        return not row.get("bank_kind") and not _NOT_COST_ASSET.search(str(row.get("title") or ""))
    return False


def _net(row: dict) -> float:
    return round(float(row.get("debit") or 0) - float(row.get("credit") or 0), 2)


def actual_from_buckets(rows: list, labels: dict | None = None) -> dict:
    """The job's actual cost from a `/reports/buckets?by=item` answer (one row
    per account and item code). Answers {amount, by: 'item'|'account', rows:
    [{key, code, label, amount, accounts: [{account_no, title, section,
    amount}]}], left: [{account_no, title, section, amount}]} - `left` is the
    lines on the Project-Job that are not cost (shown, never added)."""
    labels = labels or {}
    cost, left = [], {}
    for r in rows or []:
        if is_cost_account(r):
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


def cost_by_project(rows: list) -> dict:
    """{project code: actual cost} from a `/reports/buckets?by=project` answer
    (the dashboard's Over Budget flag - one read per entity)."""
    out: dict[str, float] = {}
    for r in rows or []:
        if not is_cost_account(r):
            continue
        code = str(r.get("bucket") or "").strip()
        if code:
            out[code] = round(out.get(code, 0.0) + _net(r), 2)
    return out


# ── Change orders (phase 3) ─────────────────────────────────────────────────
APPROVED_CHANGE = {"approved", "signed", "executed", "accepted"}
PENDING_CHANGE = {"pending", "submitted", "priced", "sent", "in_review", "awaiting_signature", "pending_approval", "open"}


def _change_amount(r) -> float:
    for k in ("amount", "cost_amount", "price", "total", "value"):
        v = getattr(r, k, None)
        if isinstance(v, (int, float)):
            return round(float(v), 2)
    cents = getattr(r, "amount_cents", None)
    return round(float(cents) / 100, 2) if isinstance(cents, (int, float)) else 0.0


def job_changes(db: Session, project_id: str) -> list:
    """The job's change orders as [{id, title, status, state: approved|pending,
    amount}] - read only, from phase 3's table when it exists, [] when it
    does not (this branch stands alone). Rejected, void and draft change
    orders are left out."""
    model = getattr(models, "ConstructionChangeOrder", None)
    if model is None:
        return []
    try:
        if not inspect(db.get_bind()).has_table(model.__tablename__):
            return []
        col = getattr(model, "project_id", None) or getattr(model, "job_id", None)
        if col is None:
            return []
        q = db.query(model).filter(col == project_id)
        if hasattr(model, "deleted_at"):
            q = q.filter(model.deleted_at == "")
        rows = q.all()
    except Exception as e:   # noqa: BLE001 - a table of another shape never breaks Money
        print(f"[construction-money] change orders for {project_id}: {e}")
        return []
    out = []
    for r in rows:
        status = str(getattr(r, "status", "") or "").lower()
        state = "approved" if status in APPROVED_CHANGE else "pending" if status in PENDING_CHANGE else ""
        if not state:
            continue
        out.append({"id": getattr(r, "id", ""), "title": getattr(r, "title", "") or getattr(r, "name", "") or "",
                    "number": getattr(r, "number", None) or getattr(r, "code", "") or "",
                    "status": status, "state": state, "amount": _change_amount(r)})
    return out


# ── Spend tagged to the job in Nexus ────────────────────────────────────────
PR_OPEN = {"pending_manager", "manager_approved", "ordered"}
PR_RECEIVED = {"fulfilled", "asset_allocated", "return_initiated", "returned", "asset_lost"}
RB_OPEN = {"submitted", "sent_back", "approver_approved", "hr_approved"}
RB_PAID = {"paid"}


def tagged_spend(db: Session, project_id: str) -> dict:
    """Purchase requests and reimbursements tagged to the job. Nothing here
    is a posted figure: an open one is "Requested, Not Yet Billed"; a paid
    reimbursement reaches the books when accounting posts it (no reliable
    line-by-line match exists, so it is listed, never added to Actual)."""
    R = models.Requisition
    E = models.ExpenseReimbursement
    prs = (db.query(R).filter(R.job_id == project_id, R.status != "rejected")
           .order_by(R.created_at.desc()).limit(200).all())
    rbs = (db.query(E).filter(E.job_id == project_id, E.status.notin_(("rejected", "canceled")))
           .order_by(E.created_at.desc()).limit(200).all())
    pr_rows = [{
        "id": r.id, "item": r.item or "", "quantity": int(r.quantity or 1), "requestedBy": r.employee_name or r.employee_email or "",
        "status": r.status or "", "createdAt": r.created_at or "",
        "stage": "requested" if (r.status or "") in PR_OPEN else "received",
    } for r in prs]
    rb_rows = [{
        "id": r.id, "item": r.item or "", "vendor": r.vendor or "", "amount": round(float(r.amount or 0), 2),
        "currency": (r.currency or "USD").upper(), "requestedBy": r.employee_name or r.employee_email or "",
        "status": r.status or "", "purchaseDate": r.purchase_date or "", "paidOn": r.paid_on or "",
        "stage": "paid" if (r.status or "") in RB_PAID else "requested",
    } for r in rbs]
    return {"purchaseRequests": pr_rows, "reimbursements": rb_rows}


def requested_not_billed(spend: dict, currency: str = "USD") -> dict:
    """The committed figure: open reimbursements in the job's currency (a
    claim in another currency is listed, never converted). Purchase requests
    carry no amount, so they are counted, not summed."""
    cur = (currency or "USD").upper()
    rb_open = [r for r in spend.get("reimbursements") or [] if r["stage"] == "requested"]
    same = [r for r in rb_open if r["currency"] == cur]
    return {"amount": round(sum(r["amount"] for r in same), 2),
            "reimbursements": len(same), "otherCurrency": len(rb_open) - len(same),
            "purchaseRequests": sum(1 for r in spend.get("purchaseRequests") or [] if r["stage"] == "requested")}


def worked_out(*, actual: float | None, budget: float, committed: float, approved: float, pending: float) -> dict:
    """The figures worked out from the others - never posted, never drillable.
    With no actual from the books (the job is not mapped, or the books could
    not be read) nothing is worked out: a forecast without the actual would
    read as a job that has spent nothing."""
    if actual is None:
        return {"forecast": None, "variance": None, "percentSpent": None, "overBudget": False}
    act = float(actual)
    forecast = round(act + committed + pending, 2)
    return {"forecast": forecast, "variance": round(budget - forecast, 2) if budget else None,
            "percentSpent": round(act / budget, 4) if budget else None,
            "overBudget": bool(budget) and (act + committed) > budget}


def budget_of(p, approved_changes: float) -> dict:
    cv = round(float(getattr(p, "contract_value", 0) or 0), 2)
    return {"amount": round(cv + approved_changes, 2) if cv else 0.0, "contractValue": cv,
            "approvedChanges": round(approved_changes, 2), "source": "contract"}


# ── Tagging a request to a job ──────────────────────────────────────────────
def check_job_tag(db: Session, user: dict, job_id: str | None) -> str:
    """The job a purchase request or a reimbursement may be tagged with: ''
    (none), or a live job the caller may read (the construction walls - a
    job behind them is refused the same way as one that does not exist)."""
    jid = (job_id or "").strip()[:64]
    if not jid:
        return ""
    from fastapi import HTTPException
    from routers.construction import _may_read
    p = (db.query(models.ConstructionProject)
         .filter(models.ConstructionProject.id == jid, models.ConstructionProject.deleted_at == "").first())
    if p is None or not _may_read(db, user, p):
        raise HTTPException(422, "Pick a job you are on.")
    return jid


def job_names(db: Session, ids) -> dict:
    """{job id: name} to show the tag on a request the reader may already
    see (a name only - no figure, no reach beyond the request itself)."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    P = models.ConstructionProject
    return {r.id: r.name for r in db.query(P.id, P.name).filter(P.id.in_(ids), P.deleted_at == "").all()}
