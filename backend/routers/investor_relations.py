"""Investor Relations (Jul 2026) - GP-side capital-management platform for
single-purpose-LLC deals and small syndications (not blind-pool PE funds).

A deal directory (one deal per property/project, called "Fund" internally -
see models.py), an investor/member directory, capital commitments, capital
calls, distributions, computed capital-account statements (DPI/TVPI/XIRR), a
document data room, and an investor-updates feed.

Two surfaces live here. Everything up to the "Investor portal" section is
GP-side admin, gated at supervisor+/manager+/administrator. That section adds a
separate, deliberately narrow read-only surface (/portal/*) for external
investors logging in as Entra B2B guests, scoped server-side to the one deal
they were granted - a portal grant never satisfies the admin gates. Nothing
here fans notifications out to investors; the GP communicates via the updates
feed and the data room.

Scope notes (deliberate):
- Distributions are allocated pro-rata by commitment amount. preferred_return_pct
  and gp_promote_pct on the deal are INFORMATIONAL - there is no tiered waterfall
  engine in v1. The GP models the split when creating the distribution.
- There is no interim NAV mark: a deal's unrealized value is simply called
  capital not yet distributed back (at cost), zero once exited. Single-purpose
  LLCs are not independently appraised between raise and sale, so a fabricated
  mark-to-market would mislead rather than help.
- Rows relate by string ids only (no ORM relationships), matching models.py.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database import get_db
from auth import require_level, require_level_or_module, scoped_ids, invalidate_role_cache
from models import (
    IrCapitalCall,
    IrCapitalCallAllocation,
    IrCommitment,
    IrDistribution,
    IrDistributionAllocation,
    IrDocument,
    IrFund,
    IrInvestor,
    IrUpdate,
    NexusAccessScope,
    NexusEmployee,
    NexusGroup,
    NexusGroupMember,
    NexusNotification,
)

router = APIRouter(prefix="/investor-relations", tags=["Investor Relations"])

_LEVELS = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

# Supervisors+ can view; managers (or an "investor-relations" editor grant) can
# edit; administrators (or a "full" grant) can delete/seed - mirrors items.py.
# These are the GP-admin gates ONLY - an investor-portal grant (below) never
# satisfies them, so a portal account can never reach the admin endpoints that
# list every investor/deal. See "Investor portal" section further down for the
# separate, deliberately narrower gate those endpoints use instead.
require_ir_view  = require_level(_LEVELS["supervisor"])
require_ir_edit  = require_level_or_module(_LEVELS["manager"], "investor-relations", "editor")
require_ir_admin = require_level_or_module(_LEVELS["administrator"], "investor-relations", "full")

# Name of the pre-seeded Access Group (routers/groups.py STARTER_GROUPS) that
# grant_portal_access wires investors into - reused rather than duplicated so
# an admin can see/manage every portal investor in one place (Access Manager).
_PORTAL_GROUP_NAME = "Investor"

_FUND_STATUSES       = ("raising", "active", "exited")
_INVESTOR_TYPES      = ("individual", "llc", "trust", "ira", "corporation", "partnership")
_ACCREDITED_STATUSES = ("unverified", "self_certified", "verified")
_KYC_STATUSES        = ("pending", "in_review", "cleared", "flagged")
_INVESTOR_STATUSES   = ("active", "inactive", "prospect")
_COMMITMENT_STATUSES = ("pending", "active", "closed", "withdrawn")
_CALL_STATUSES       = ("draft", "issued", "closed")
_CALL_ALLOC_STATUSES = ("pending", "paid", "overdue", "waived")
_DIST_STATUSES       = ("draft", "issued", "paid")
_DIST_ALLOC_STATUSES = ("pending", "paid")
_DIST_TYPES          = ("return_of_capital", "preferred_return", "profit_split", "mixed")
_DOC_CATEGORIES      = ("subscription_agreement", "k1", "ppm", "quarterly_report",
                        "capital_call_notice", "distribution_notice", "other")
# Commitments that count toward a fund's raise (closed/withdrawn don't).
_COUNTED_COMMITMENTS = ("pending", "active")

_SUPABASE_URL = os.getenv("SUPABASE_URL", "")

# Valid document URL prefix - only allow URLs pointing to our own Supabase
# storage so external links cannot masquerade as signed docs (same guard as
# items.py's _validate_photo_url).
_STORAGE_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/" if _SUPABASE_URL else None


def _validate_doc_url(url: Optional[str], field: str) -> None:
    """Raise 400 if url is non-empty and does not originate from our storage bucket."""
    if not url or not url.strip():
        return
    if _STORAGE_PREFIX and not url.startswith(_STORAGE_PREFIX):
        raise HTTPException(400, f"{field} must be a Supabase storage URL")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _iso_date(s: Optional[str], field: str) -> str:
    """Normalize a client-supplied date to a bare YYYY-MM-DD string ('' passes
    through). Dates are stored date-only so string comparison sorts
    chronologically and _xirr never mixes aware/naive datetimes."""
    s = (s or "").strip()
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        raise HTTPException(400, f"{field} must be an ISO date (YYYY-MM-DD)")


def _require_enum(value: str, allowed: tuple, field: str) -> str:
    if value not in allowed:
        raise HTTPException(400, f"Invalid {field}. Must be one of: {', '.join(allowed)}")
    return value


def _fmt_money(x: float) -> str:
    return f"${(x or 0):,.2f}"


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str,
            ref_id: str = "") -> None:
    """Server-side notification row (employees get 403 on the notifications POST
    API, so this is the ONLY reliable channel). No commit here - the calling
    endpoint commits once at the end. One notification per issue action; never
    fanned out per investor (there is no investor-facing login yet)."""
    row = NexusNotification(
        id=str(uuid.uuid4()),
        type=type,
        recipient=recipient.lower() if recipient else "",
        title=title,
        body=body,
        ref_id=ref_id,
        item_name="",
        requested_by="",
        action="",
        actioned=False,
        read_by="",
        created_at=_now_iso(),
    )
    db.add(row)


# ── Name lookup maps (batch - never N+1 in a list serializer) ────────────────

def _fund_names(db: Session, fund_ids) -> dict:
    ids = {f for f in fund_ids if f}
    if not ids:
        return {}
    return {r.id: r.name for r in db.query(IrFund.id, IrFund.name).filter(IrFund.id.in_(ids)).all()}


def _investor_names(db: Session, investor_ids) -> dict:
    ids = {i for i in investor_ids if i}
    if not ids:
        return {}
    return {r.id: r.display_name
            for r in db.query(IrInvestor.id, IrInvestor.display_name).filter(IrInvestor.id.in_(ids)).all()}


# ── Serializers ───────────────────────────────────────────────────────────────

def _serialize_fund(f: IrFund, *, committed=0.0, called=0.0, distributed=0.0,
                    investor_count=0) -> dict:
    return {
        "id":                 f.id,
        "name":               f.name,
        "entityName":         f.entity_name or "",
        "strategy":           f.strategy or "",
        "propertyName":       f.property_name or "",
        "propertyAssetId":    f.property_asset_id or "",
        "status":             f.status or "raising",
        "targetRaise":        float(f.target_raise or 0),
        "minimumInvestment":  float(f.minimum_investment or 0),
        "preferredReturnPct": float(f.preferred_return_pct or 0),
        "gpPromotePct":       float(f.gp_promote_pct or 0),
        "targetIrrPct":       float(f.target_irr_pct or 0),
        "targetMultiple":     float(f.target_multiple or 0),
        "holdPeriodYears":    float(f.hold_period_years or 0),
        "inceptionDate":      f.inception_date or "",
        "closeDate":          f.close_date or "",
        "exitDate":           f.exit_date or "",
        "fundManagerEmail":   f.fund_manager_email or "",
        "description":        f.description or "",
        "thesis":             f.thesis or "",
        "createdBy":          f.created_by or "",
        "createdAt":          f.created_at or "",
        "updatedAt":          f.updated_at or "",
        "totalCommitted":     round(committed, 2),
        "totalCalled":        round(called, 2),
        "totalDistributed":   round(distributed, 2),
        "investorCount":      investor_count,
    }


def _serialize_investor(v: IrInvestor, *, committed=0.0, fund_count=0, portal_fund_ids=None) -> dict:
    return {
        "id":                     v.id,
        "displayName":            v.display_name,
        "entityType":             v.entity_type or "individual",
        "email":                  v.email or "",
        "phone":                  v.phone or "",
        "address":                v.address or "",
        "accreditedStatus":       v.accredited_status or "unverified",
        "kycStatus":              v.kyc_status or "pending",
        "taxIdOnFile":            bool(v.tax_id_on_file),
        "relationshipOwnerEmail": v.relationship_owner_email or "",
        "notes":                  v.notes or "",
        "status":                 v.status or "active",
        "createdBy":              v.created_by or "",
        "createdAt":              v.created_at or "",
        "updatedAt":              v.updated_at or "",
        "totalCommitted":         round(committed, 2),
        "fundCount":              fund_count,
        # Deal ids this investor has been granted login/portal access to (see
        # the "Investor portal" section) - [] means no portal access at all.
        "portalFundIds":          sorted(portal_fund_ids or []),
    }


def _portal_fund_ids_by_email(db: Session, emails) -> dict:
    """Batch lookup - {lowercased email: {fund_id, ...}} - of every deal each
    email has been granted portal access to. Never N+1 per investor row."""
    emails = {e.lower() for e in emails if e}
    if not emails:
        return {}
    rows = (db.query(NexusAccessScope)
            .filter(NexusAccessScope.module_id == "investor-relations",
                    NexusAccessScope.email.in_(emails)).all())
    out: dict = {}
    for r in rows:
        out.setdefault(r.email, set()).add(r.scope_id)
    return out


def _serialize_commitment(c: IrCommitment, fund_names: dict, investor_names: dict) -> dict:
    return {
        "id":               c.id,
        "fundId":           c.fund_id,
        "fundName":         fund_names.get(c.fund_id, ""),
        "investorId":       c.investor_id,
        "investorName":     investor_names.get(c.investor_id, ""),
        "commitmentAmount": float(c.commitment_amount or 0),
        "units":            float(c.units or 0),
        "subscriptionDate": c.subscription_date or "",
        "status":           c.status or "pending",
        "signedDocUrl":     c.signed_doc_url or "",
        "signedDocName":    c.signed_doc_name or "",
        "createdBy":        c.created_by or "",
        "createdAt":        c.created_at or "",
        "updatedAt":        c.updated_at or "",
    }


def _serialize_call(c: IrCapitalCall, fund_names: dict, *, paid=0.0, pending=0.0,
                    alloc_count=0) -> dict:
    return {
        "id":              c.id,
        "fundId":          c.fund_id,
        "fundName":        fund_names.get(c.fund_id, ""),
        "callNumber":      c.call_number or 1,
        "title":           c.title or "",
        "purpose":         c.purpose or "",
        "totalAmount":     float(c.total_amount or 0),
        "noticeDate":      c.notice_date or "",
        "dueDate":         c.due_date or "",
        "status":          c.status or "draft",
        "createdBy":       c.created_by or "",
        "createdAt":       c.created_at or "",
        "updatedAt":       c.updated_at or "",
        "paidAmount":      round(paid, 2),
        "pendingAmount":   round(pending, 2),
        "allocationCount": alloc_count,
    }


def _serialize_call_alloc(a: IrCapitalCallAllocation, investor_names: dict) -> dict:
    return {
        "id":           a.id,
        "callId":       a.call_id,
        "fundId":       a.fund_id,
        "investorId":   a.investor_id,
        "investorName": investor_names.get(a.investor_id, ""),
        "commitmentId": a.commitment_id or "",
        "amount":       float(a.amount or 0),
        "status":       a.status or "pending",
        "paidDate":     a.paid_date or "",
        "paidAmount":   float(a.paid_amount or 0),
    }


def _serialize_distribution(d: IrDistribution, fund_names: dict, *, paid=0.0,
                            pending=0.0, alloc_count=0) -> dict:
    return {
        "id":                 d.id,
        "fundId":             d.fund_id,
        "fundName":           fund_names.get(d.fund_id, ""),
        "distributionNumber": d.distribution_number or 1,
        "title":              d.title or "",
        "distributionType":   d.distribution_type or "return_of_capital",
        "totalAmount":        float(d.total_amount or 0),
        "distributionDate":   d.distribution_date or "",
        "status":             d.status or "draft",
        "createdBy":          d.created_by or "",
        "createdAt":          d.created_at or "",
        "updatedAt":          d.updated_at or "",
        "paidAmount":         round(paid, 2),
        "pendingAmount":      round(pending, 2),
        "allocationCount":    alloc_count,
    }


def _serialize_dist_alloc(a: IrDistributionAllocation, investor_names: dict) -> dict:
    return {
        "id":             a.id,
        "distributionId": a.distribution_id,
        "fundId":         a.fund_id,
        "investorId":     a.investor_id,
        "investorName":   investor_names.get(a.investor_id, ""),
        "commitmentId":   a.commitment_id or "",
        "amount":         float(a.amount or 0),
        "status":         a.status or "pending",
        "paidDate":       a.paid_date or "",
    }


def _serialize_document(d: IrDocument, fund_names: dict, investor_names: dict) -> dict:
    return {
        "id":           d.id,
        "fundId":       d.fund_id or "",
        "fundName":     fund_names.get(d.fund_id, "") if d.fund_id else "",
        "investorId":   d.investor_id or "",
        "investorName": investor_names.get(d.investor_id, "") if d.investor_id else "",
        "category":     d.category or "other",
        "title":        d.title,
        "fileUrl":      d.file_url or "",
        "fileName":     d.file_name or "",
        "uploadedBy":   d.uploaded_by or "",
        "createdAt":    d.created_at or "",
    }


def _serialize_update(u: IrUpdate, fund_names: dict) -> dict:
    return {
        "id":        u.id,
        "fundId":    u.fund_id or "",
        "fundName":  fund_names.get(u.fund_id, "") if u.fund_id else "",
        "title":     u.title,
        "body":      u.body or "",
        "pinned":    bool(u.pinned),
        "createdBy": u.created_by or "",
        "createdAt": u.created_at or "",
    }


# ── Aggregate rollups (grouped SQL - never per-row loops) ─────────────────────

def _fund_rollups(db: Session, fund_id: Optional[str] = None):
    """Three grouped queries → ({fund_id: (committed, investor_count)},
    {fund_id: called}, {fund_id: distributed})."""
    committed_q = (db.query(IrCommitment.fund_id,
                            func.sum(IrCommitment.commitment_amount),
                            func.count(func.distinct(IrCommitment.investor_id)))
                   .filter(IrCommitment.status.in_(_COUNTED_COMMITMENTS))
                   .group_by(IrCommitment.fund_id))
    called_q = (db.query(IrCapitalCallAllocation.fund_id,
                         func.sum(IrCapitalCallAllocation.paid_amount))
                .filter(IrCapitalCallAllocation.status == "paid")
                .group_by(IrCapitalCallAllocation.fund_id))
    dist_q = (db.query(IrDistributionAllocation.fund_id,
                       func.sum(IrDistributionAllocation.amount))
              .filter(IrDistributionAllocation.status == "paid")
              .group_by(IrDistributionAllocation.fund_id))
    if fund_id:
        committed_q = committed_q.filter(IrCommitment.fund_id == fund_id)
        called_q    = called_q.filter(IrCapitalCallAllocation.fund_id == fund_id)
        dist_q      = dist_q.filter(IrDistributionAllocation.fund_id == fund_id)
    committed   = {fid: (float(total or 0), int(cnt or 0)) for fid, total, cnt in committed_q.all()}
    called      = {fid: float(total or 0) for fid, total in called_q.all()}
    distributed = {fid: float(total or 0) for fid, total in dist_q.all()}
    return committed, called, distributed


def _investor_rollups(db: Session, investor_id: Optional[str] = None) -> dict:
    """{investor_id: (total_committed, distinct_fund_count)} over pending/active
    commitments."""
    q = (db.query(IrCommitment.investor_id,
                  func.sum(IrCommitment.commitment_amount),
                  func.count(func.distinct(IrCommitment.fund_id)))
         .filter(IrCommitment.status.in_(_COUNTED_COMMITMENTS))
         .group_by(IrCommitment.investor_id))
    if investor_id:
        q = q.filter(IrCommitment.investor_id == investor_id)
    return {iid: (float(total or 0), int(cnt or 0)) for iid, total, cnt in q.all()}


def _call_rollups(db: Session, call_ids: list):
    """({call_id: alloc_count}, {call_id: paid_sum}, {call_id: pending_sum}).
    pending counts allocations still owed (pending + overdue); waived owe nothing."""
    if not call_ids:
        return {}, {}, {}
    A = IrCapitalCallAllocation
    counts = {cid: int(n or 0) for cid, n in
              db.query(A.call_id, func.count(A.id))
                .filter(A.call_id.in_(call_ids)).group_by(A.call_id).all()}
    paid = {cid: float(total or 0) for cid, total in
            db.query(A.call_id, func.sum(A.paid_amount))
              .filter(A.call_id.in_(call_ids), A.status == "paid").group_by(A.call_id).all()}
    pending = {cid: float(total or 0) for cid, total in
               db.query(A.call_id, func.sum(A.amount))
                 .filter(A.call_id.in_(call_ids), A.status.in_(("pending", "overdue")))
                 .group_by(A.call_id).all()}
    return counts, paid, pending


def _dist_rollups(db: Session, dist_ids: list):
    """({dist_id: alloc_count}, {dist_id: paid_sum}, {dist_id: pending_sum})."""
    if not dist_ids:
        return {}, {}, {}
    A = IrDistributionAllocation
    counts = {did: int(n or 0) for did, n in
              db.query(A.distribution_id, func.count(A.id))
                .filter(A.distribution_id.in_(dist_ids)).group_by(A.distribution_id).all()}
    paid = {did: float(total or 0) for did, total in
            db.query(A.distribution_id, func.sum(A.amount))
              .filter(A.distribution_id.in_(dist_ids), A.status == "paid")
              .group_by(A.distribution_id).all()}
    pending = {did: float(total or 0) for did, total in
               db.query(A.distribution_id, func.sum(A.amount))
                 .filter(A.distribution_id.in_(dist_ids), A.status == "pending")
                 .group_by(A.distribution_id).all()}
    return counts, paid, pending


# ── Pro-rata allocation engine ────────────────────────────────────────────────

def _pro_rata(total_amount: float, commitments: list) -> list:
    """Split total_amount across commitments pro-rata by commitment_amount,
    rounded to cents, with the LAST allocation absorbing rounding drift so the
    parts sum EXACTLY to total_amount. Returns [(commitment, amount), ...].
    Returns [] when there is nothing to pro-rate over (no commitments, or all
    commitment amounts are zero) - a zero-allocation call/distribution is a
    valid state; the GP can re-total a draft later to regenerate."""
    commitments = list(commitments)
    base = sum(float(c.commitment_amount or 0) for c in commitments)
    if not commitments or base <= 0:
        return []
    total = float(total_amount or 0)
    out, running = [], 0.0
    for c in commitments[:-1]:
        amt = round(total * float(c.commitment_amount or 0) / base, 2)
        out.append((c, amt))
        running += amt
    out.append((commitments[-1], round(total - running, 2)))
    return out


def _active_commitments(db: Session, fund_id: str) -> list:
    """Active commitments for a fund in a DETERMINISTIC order, so regenerating a
    draft's allocations reproduces the same split (the last row absorbs the
    rounding drift - its identity must be stable)."""
    return (db.query(IrCommitment)
            .filter(IrCommitment.fund_id == fund_id, IrCommitment.status == "active")
            .order_by(IrCommitment.created_at, IrCommitment.id).all())


def _generate_call_allocations(db: Session, call: IrCapitalCall, commitments: list) -> int:
    """One pending allocation per active commitment, pro-rata by commitment
    amount. If the fund has no active commitments yet, the call simply gets zero
    allocations (valid - the GP can add commitments and re-total the draft to
    regenerate; there is deliberately no separate regenerate endpoint in v1)."""
    n = 0
    for c, amt in _pro_rata(call.total_amount, commitments):
        db.add(IrCapitalCallAllocation(
            id=str(uuid.uuid4()), call_id=call.id, fund_id=call.fund_id,
            investor_id=c.investor_id, commitment_id=c.id,
            amount=amt, status="pending", paid_date="", paid_amount=0,
        ))
        n += 1
    return n


def _generate_dist_allocations(db: Session, dist: IrDistribution, commitments: list) -> int:
    n = 0
    for c, amt in _pro_rata(dist.total_amount, commitments):
        db.add(IrDistributionAllocation(
            id=str(uuid.uuid4()), distribution_id=dist.id, fund_id=dist.fund_id,
            investor_id=c.investor_id, commitment_id=c.id,
            amount=amt, status="pending", paid_date="",
        ))
        n += 1
    return n


# ── Capital-account math (XIRR / DPI / TVPI) ──────────────────────────────────

def _xirr(cashflows: list) -> Optional[float]:
    """cashflows: list of (iso_date 'YYYY-MM-DD', amount). Returns an annualized
    rate, or None if there are fewer than 2 flows or no solution is found."""
    if len(cashflows) < 2:
        return None
    dates = [datetime.fromisoformat(d) for d, _ in cashflows]
    t0 = min(dates)

    def npv(rate):
        total = 0.0
        for d, amt in cashflows:
            days = (datetime.fromisoformat(d) - t0).days
            total += amt / ((1 + rate) ** (days / 365.0))
        return total

    rate = 0.1
    for _ in range(100):
        f = npv(rate)
        h = 1e-6
        deriv = (npv(rate + h) - f) / h
        if abs(deriv) < 1e-9:
            break
        new_rate = rate - f / deriv
        if abs(new_rate - rate) < 1e-6:
            return new_rate
        rate = max(new_rate, -0.999)
    # Newton didn't converge - fall back to bisection over a wide range
    lo, hi = -0.9, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-6:
            return mid
        if f_lo * f_mid < 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def _capital_account(db: Session, fund: IrFund, investor_id: str) -> Optional[dict]:
    """fund: IrFund row. Returns None if the investor has no commitment in this fund."""
    commitments = db.query(IrCommitment).filter(
        IrCommitment.fund_id == fund.id, IrCommitment.investor_id == investor_id).all()
    if not commitments:
        return None
    committed = sum(c.commitment_amount for c in commitments)
    commitment_ids = {c.id for c in commitments}

    call_allocs = db.query(IrCapitalCallAllocation).filter(
        IrCapitalCallAllocation.fund_id == fund.id,
        IrCapitalCallAllocation.investor_id == investor_id,
        IrCapitalCallAllocation.status == "paid").all()
    dist_allocs = db.query(IrDistributionAllocation).filter(
        IrDistributionAllocation.fund_id == fund.id,
        IrDistributionAllocation.investor_id == investor_id,
        IrDistributionAllocation.status == "paid").all()

    called = sum(a.paid_amount for a in call_allocs)
    distributed = sum(a.amount for a in dist_allocs)
    unfunded = max(committed - called, 0.0)
    dpi = distributed / called if called > 0 else 0.0

    # No interim NAV mark for a single-purpose-LLC deal (see module docstring),
    # so TVPI/IRR are only meaningful once the deal has actually exited -- at
    # that point every dollar of value has been realized through a
    # distribution, so cash-flow-only figures are accurate. Computing them
    # while the deal is still active would price capital that is simply still
    # invested as though it were lost (a deeply negative IRR for a perfectly
    # healthy ongoing deal). DPI (cash actually returned so far) is the
    # honest number to show in the meantime; TVPI/IRR stay unset.
    if fund.status == "exited":
        tvpi = dpi
        cashflows = [(a.paid_date, -a.paid_amount) for a in call_allocs if a.paid_date]
        cashflows += [(a.paid_date, a.amount) for a in dist_allocs if a.paid_date]
        irr = _xirr(cashflows) if len(cashflows) >= 2 else None
    else:
        tvpi = None
        irr = None

    return {
        "committed": committed, "called": called, "unfunded": unfunded,
        "distributed": distributed, "dpi": dpi, "tvpi": tvpi,
        "irrPct": round(irr * 100, 2) if irr is not None else None,
        "unrealized": 0.0, "commitment_ids": commitment_ids,
    }


# ── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/dashboard")
def get_dashboard(user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    # "Fund" is the internal/DB name for a single deal (SPV/syndication) --
    # see module docstring. Response keys keep the fund* names for API stability.
    total_committed = float(
        db.query(func.sum(IrCommitment.commitment_amount))
          .filter(IrCommitment.status.in_(_COUNTED_COMMITMENTS)).scalar() or 0)
    total_called = float(
        db.query(func.sum(IrCapitalCallAllocation.paid_amount))
          .filter(IrCapitalCallAllocation.status == "paid").scalar() or 0)
    total_distributed = float(
        db.query(func.sum(IrDistributionAllocation.amount))
          .filter(IrDistributionAllocation.status == "paid").scalar() or 0)

    funds = db.query(IrFund).all()
    fund_map = {f.id: f for f in funds}
    deals_by_status = {s: 0 for s in _FUND_STATUSES}
    for f in funds:
        if (f.status or "raising") in deals_by_status:
            deals_by_status[f.status or "raising"] += 1

    # Average IRR / MOIC across every (fund, investor) position with capital in
    # the ground - same math the capital-accounts screen shows. Only exited
    # positions have a real (non-None) TVPI/IRR (see _capital_account) - this
    # naturally averages realized performance only, not still-active deals.
    pairs = db.query(IrCommitment.fund_id, IrCommitment.investor_id).distinct().all()
    irrs, moics = [], []
    for fid, iid in pairs:
        fund = fund_map.get(fid)
        if not fund:
            continue
        acct = _capital_account(db, fund, iid)
        if not acct or acct["called"] <= 0:
            continue
        if acct["tvpi"] is not None:
            moics.append(acct["tvpi"])
        if acct["irrPct"] is not None:
            irrs.append(acct["irrPct"])

    # Issued calls by soonest due date (undated ones last).
    issued_calls = db.query(IrCapitalCall).filter(IrCapitalCall.status == "issued").all()
    issued_calls.sort(key=lambda c: c.due_date or "9999-12-31")
    issued_calls = issued_calls[:5]
    fnames = _fund_names(db, [c.fund_id for c in issued_calls])
    _, _, call_pending = _call_rollups(db, [c.id for c in issued_calls])
    upcoming = [{
        "id": c.id, "fundId": c.fund_id, "fundName": fnames.get(c.fund_id, ""),
        "title": c.title or "", "dueDate": c.due_date or "",
        "totalAmount": float(c.total_amount or 0),
        "pendingAmount": round(call_pending.get(c.id, 0.0), 2),
    } for c in issued_calls]

    recent_dists = (db.query(IrDistribution)
                    .filter(IrDistribution.status.in_(("issued", "paid")))
                    .order_by(IrDistribution.distribution_date.desc()).limit(5).all())
    dnames = _fund_names(db, [d.fund_id for d in recent_dists])
    recent_distributions = [{
        "id": d.id, "fundId": d.fund_id, "fundName": dnames.get(d.fund_id, ""),
        "title": d.title or "", "distributionDate": d.distribution_date or "",
        "totalAmount": float(d.total_amount or 0),
    } for d in recent_dists]

    updates = (db.query(IrUpdate)
               .order_by(IrUpdate.pinned.desc(), IrUpdate.created_at.desc())
               .limit(5).all())
    unames = _fund_names(db, [u.fund_id for u in updates])
    recent_updates = [{
        "id": u.id, "fundId": u.fund_id or "",
        "fundName": unames.get(u.fund_id, "") if u.fund_id else "",
        "title": u.title, "createdAt": u.created_at or "", "pinned": bool(u.pinned),
    } for u in updates]

    return {
        "totalCommitted":       round(total_committed, 2),
        "totalCalled":          round(total_called, 2),
        "totalDistributed":     round(total_distributed, 2),
        "totalUnfunded":        round(max(total_committed - total_called, 0.0), 2),
        "fundCount":            len(funds),
        "activeFundCount":      deals_by_status["active"],
        "investorCount":        int(db.query(func.count(IrInvestor.id)).scalar() or 0),
        "avgIrrPct":            round(sum(irrs) / len(irrs), 2) if irrs else None,
        "avgMoic":              round(sum(moics) / len(moics), 2) if moics else None,
        "fundsByStatus":        deals_by_status,
        "upcomingCapitalCalls": upcoming,
        "recentDistributions":  recent_distributions,
        "recentUpdates":        recent_updates,
    }


# ── Funds ─────────────────────────────────────────────────────────────────────

class FundIn(BaseModel):
    name:               str
    entityName:         Optional[str] = ""
    strategy:           Optional[str] = ""
    propertyName:       Optional[str] = ""
    propertyAssetId:    Optional[str] = ""
    status:             Optional[str] = "raising"
    targetRaise:        Optional[float] = 0
    minimumInvestment:  Optional[float] = 0
    preferredReturnPct: Optional[float] = 8.0
    gpPromotePct:       Optional[float] = 20.0
    targetIrrPct:       Optional[float] = 0
    targetMultiple:     Optional[float] = 0
    holdPeriodYears:    Optional[float] = 0
    inceptionDate:      Optional[str] = ""
    closeDate:          Optional[str] = ""
    exitDate:           Optional[str] = ""
    fundManagerEmail:   Optional[str] = ""
    description:        Optional[str] = ""
    thesis:             Optional[str] = ""


class FundUpdate(BaseModel):
    name:               Optional[str] = None
    entityName:         Optional[str] = None
    strategy:           Optional[str] = None
    propertyName:       Optional[str] = None
    propertyAssetId:    Optional[str] = None
    status:             Optional[str] = None
    targetRaise:        Optional[float] = None
    minimumInvestment:  Optional[float] = None
    preferredReturnPct: Optional[float] = None
    gpPromotePct:       Optional[float] = None
    targetIrrPct:       Optional[float] = None
    targetMultiple:     Optional[float] = None
    holdPeriodYears:    Optional[float] = None
    inceptionDate:      Optional[str] = None
    closeDate:          Optional[str] = None
    exitDate:           Optional[str] = None
    fundManagerEmail:   Optional[str] = None
    description:        Optional[str] = None
    thesis:             Optional[str] = None


@router.get("/funds")
def list_funds(user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    funds = db.query(IrFund).order_by(IrFund.created_at.desc()).all()
    committed, called, distributed = _fund_rollups(db)
    out = []
    for f in funds:
        cm, cnt = committed.get(f.id, (0.0, 0))
        out.append(_serialize_fund(f, committed=cm, called=called.get(f.id, 0.0),
                                   distributed=distributed.get(f.id, 0.0), investor_count=cnt))
    return out


@router.post("/funds", status_code=201)
def create_fund(body: FundIn, user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    status = (body.status or "raising").strip()
    _require_enum(status, _FUND_STATUSES, "status")
    now = _now_iso()
    f = IrFund(
        id=str(uuid.uuid4()),
        name=name,
        entity_name=(body.entityName or "").strip(),
        strategy=(body.strategy or "").strip(),
        property_name=(body.propertyName or "").strip(),
        property_asset_id=(body.propertyAssetId or "").strip(),
        status=status,
        target_raise=float(body.targetRaise or 0),
        minimum_investment=float(body.minimumInvestment or 0),
        preferred_return_pct=float(body.preferredReturnPct if body.preferredReturnPct is not None else 8.0),
        gp_promote_pct=float(body.gpPromotePct if body.gpPromotePct is not None else 20.0),
        target_irr_pct=float(body.targetIrrPct or 0),
        target_multiple=float(body.targetMultiple or 0),
        hold_period_years=float(body.holdPeriodYears or 0),
        inception_date=_iso_date(body.inceptionDate, "inceptionDate"),
        close_date=_iso_date(body.closeDate, "closeDate"),
        exit_date=_iso_date(body.exitDate, "exitDate"),
        fund_manager_email=(body.fundManagerEmail or "").lower().strip(),
        description=(body.description or "").strip(),
        thesis=(body.thesis or "").strip(),
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(f)
    db.commit()
    return _serialize_fund(f)


@router.get("/funds/{fund_id}")
def get_fund(fund_id: str, user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    f = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    committed, called, distributed = _fund_rollups(db, fund_id=fund_id)
    cm, cnt = committed.get(f.id, (0.0, 0))
    return _serialize_fund(f, committed=cm, called=called.get(f.id, 0.0),
                           distributed=distributed.get(f.id, 0.0), investor_count=cnt)


@router.patch("/funds/{fund_id}")
def update_fund(fund_id: str, body: FundUpdate, user: dict = Depends(require_ir_edit),
                db: Session = Depends(get_db)):
    f = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    if body.name is not None:
        n = body.name.strip()
        if not n:
            raise HTTPException(400, "Name cannot be empty")
        f.name = n
    if body.status is not None:
        f.status = _require_enum(body.status.strip(), _FUND_STATUSES, "status")
    if body.entityName         is not None: f.entity_name          = body.entityName.strip()
    if body.strategy           is not None: f.strategy             = body.strategy.strip()
    if body.propertyName       is not None: f.property_name        = body.propertyName.strip()
    if body.propertyAssetId    is not None: f.property_asset_id    = body.propertyAssetId.strip()
    if body.targetRaise        is not None: f.target_raise         = float(body.targetRaise)
    if body.minimumInvestment  is not None: f.minimum_investment   = float(body.minimumInvestment)
    if body.preferredReturnPct is not None: f.preferred_return_pct = float(body.preferredReturnPct)
    if body.gpPromotePct       is not None: f.gp_promote_pct       = float(body.gpPromotePct)
    if body.targetIrrPct       is not None: f.target_irr_pct       = float(body.targetIrrPct)
    if body.targetMultiple     is not None: f.target_multiple      = float(body.targetMultiple)
    if body.holdPeriodYears    is not None: f.hold_period_years    = float(body.holdPeriodYears)
    if body.inceptionDate      is not None: f.inception_date       = _iso_date(body.inceptionDate, "inceptionDate")
    if body.closeDate          is not None: f.close_date           = _iso_date(body.closeDate, "closeDate")
    if body.exitDate           is not None: f.exit_date            = _iso_date(body.exitDate, "exitDate")
    if body.fundManagerEmail   is not None: f.fund_manager_email   = body.fundManagerEmail.lower().strip()
    if body.description        is not None: f.description          = body.description.strip()
    if body.thesis             is not None: f.thesis               = body.thesis.strip()
    f.updated_at = _now_iso()
    db.commit()
    committed, called, distributed = _fund_rollups(db, fund_id=fund_id)
    cm, cnt = committed.get(f.id, (0.0, 0))
    return _serialize_fund(f, committed=cm, called=called.get(f.id, 0.0),
                           distributed=distributed.get(f.id, 0.0), investor_count=cnt)


@router.delete("/funds/{fund_id}")
def delete_fund(fund_id: str, user: dict = Depends(require_ir_admin), db: Session = Depends(get_db)):
    f = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not f:
        raise HTTPException(404, "Deal not found")
    if db.query(IrCommitment).filter(IrCommitment.fund_id == fund_id).count():
        raise HTTPException(409, "Cannot delete a deal that has commitments - remove them first")
    db.delete(f)
    db.commit()
    return {"ok": True}


# ── Investors ─────────────────────────────────────────────────────────────────

class InvestorIn(BaseModel):
    displayName:            str
    entityType:             Optional[str] = "individual"
    email:                  Optional[str] = ""
    phone:                  Optional[str] = ""
    address:                Optional[str] = ""
    accreditedStatus:       Optional[str] = "unverified"
    kycStatus:              Optional[str] = "pending"
    taxIdOnFile:            Optional[bool] = False
    relationshipOwnerEmail: Optional[str] = ""
    notes:                  Optional[str] = ""
    status:                 Optional[str] = "active"


class InvestorUpdate(BaseModel):
    displayName:            Optional[str] = None
    entityType:             Optional[str] = None
    email:                  Optional[str] = None
    phone:                  Optional[str] = None
    address:                Optional[str] = None
    accreditedStatus:       Optional[str] = None
    kycStatus:              Optional[str] = None
    taxIdOnFile:            Optional[bool] = None
    relationshipOwnerEmail: Optional[str] = None
    notes:                  Optional[str] = None
    status:                 Optional[str] = None


@router.get("/investors")
def list_investors(user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    investors = db.query(IrInvestor).order_by(IrInvestor.display_name).all()
    rollups = _investor_rollups(db)
    portal_ids = _portal_fund_ids_by_email(db, (v.email for v in investors))
    out = []
    for v in investors:
        cm, cnt = rollups.get(v.id, (0.0, 0))
        out.append(_serialize_investor(v, committed=cm, fund_count=cnt,
                                       portal_fund_ids=portal_ids.get((v.email or "").lower())))
    return out


@router.post("/investors", status_code=201)
def create_investor(body: InvestorIn, user: dict = Depends(require_ir_edit),
                    db: Session = Depends(get_db)):
    name = (body.displayName or "").strip()
    if not name:
        raise HTTPException(400, "Display name cannot be empty")
    entity_type = (body.entityType or "individual").strip()
    _require_enum(entity_type, _INVESTOR_TYPES, "entityType")
    accredited = (body.accreditedStatus or "unverified").strip()
    _require_enum(accredited, _ACCREDITED_STATUSES, "accreditedStatus")
    kyc = (body.kycStatus or "pending").strip()
    _require_enum(kyc, _KYC_STATUSES, "kycStatus")
    status = (body.status or "active").strip()
    _require_enum(status, _INVESTOR_STATUSES, "status")
    now = _now_iso()
    v = IrInvestor(
        id=str(uuid.uuid4()),
        display_name=name,
        entity_type=entity_type,
        email=(body.email or "").lower().strip(),
        phone=(body.phone or "").strip(),
        address=(body.address or "").strip(),
        accredited_status=accredited,
        kyc_status=kyc,
        tax_id_on_file=bool(body.taxIdOnFile),
        relationship_owner_email=(body.relationshipOwnerEmail or "").lower().strip(),
        notes=(body.notes or "").strip(),
        status=status,
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(v)
    db.commit()
    return _serialize_investor(v)


@router.patch("/investors/{investor_id}")
def update_investor(investor_id: str, body: InvestorUpdate,
                    user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    v = db.query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not v:
        raise HTTPException(404, "Investor not found")
    if body.displayName is not None:
        n = body.displayName.strip()
        if not n:
            raise HTTPException(400, "Display name cannot be empty")
        v.display_name = n
    if body.entityType is not None:
        v.entity_type = _require_enum(body.entityType.strip(), _INVESTOR_TYPES, "entityType")
    if body.accreditedStatus is not None:
        v.accredited_status = _require_enum(body.accreditedStatus.strip(), _ACCREDITED_STATUSES, "accreditedStatus")
    if body.kycStatus is not None:
        v.kyc_status = _require_enum(body.kycStatus.strip(), _KYC_STATUSES, "kycStatus")
    if body.status is not None:
        v.status = _require_enum(body.status.strip(), _INVESTOR_STATUSES, "status")
    if body.email                  is not None: v.email                    = body.email.lower().strip()
    if body.phone                  is not None: v.phone                    = body.phone.strip()
    if body.address                is not None: v.address                  = body.address.strip()
    if body.taxIdOnFile            is not None: v.tax_id_on_file           = bool(body.taxIdOnFile)
    if body.relationshipOwnerEmail is not None: v.relationship_owner_email = body.relationshipOwnerEmail.lower().strip()
    if body.notes                  is not None: v.notes                    = body.notes.strip()
    v.updated_at = _now_iso()
    db.commit()
    rollups = _investor_rollups(db, investor_id=investor_id)
    cm, cnt = rollups.get(v.id, (0.0, 0))
    portal_ids = _portal_fund_ids_by_email(db, [v.email]).get((v.email or "").lower())
    return _serialize_investor(v, committed=cm, fund_count=cnt, portal_fund_ids=portal_ids)


@router.delete("/investors/{investor_id}")
def delete_investor(investor_id: str, user: dict = Depends(require_ir_admin),
                    db: Session = Depends(get_db)):
    v = db.query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not v:
        raise HTTPException(404, "Investor not found")
    if db.query(IrCommitment).filter(IrCommitment.investor_id == investor_id).count():
        raise HTTPException(409, "Cannot delete an investor with commitments - remove them first")
    db.delete(v)
    db.commit()
    return {"ok": True}


# ── Commitments ───────────────────────────────────────────────────────────────

class CommitmentIn(BaseModel):
    fundId:           str
    investorId:       str
    commitmentAmount: float
    units:            Optional[float] = 0
    subscriptionDate: Optional[str] = ""
    status:           Optional[str] = "pending"
    signedDocUrl:     Optional[str] = ""
    signedDocName:    Optional[str] = ""


class CommitmentUpdate(BaseModel):
    commitmentAmount: Optional[float] = None
    units:            Optional[float] = None
    subscriptionDate: Optional[str] = None
    status:           Optional[str] = None
    signedDocUrl:     Optional[str] = None
    signedDocName:    Optional[str] = None


@router.get("/commitments")
def list_commitments(fund_id: Optional[str] = None, investor_id: Optional[str] = None,
                     user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    q = db.query(IrCommitment)
    if fund_id:
        q = q.filter(IrCommitment.fund_id == fund_id)
    if investor_id:
        q = q.filter(IrCommitment.investor_id == investor_id)
    rows = q.order_by(IrCommitment.created_at.desc()).all()
    fnames = _fund_names(db, [c.fund_id for c in rows])
    inames = _investor_names(db, [c.investor_id for c in rows])
    return [_serialize_commitment(c, fnames, inames) for c in rows]


@router.post("/commitments", status_code=201)
def create_commitment(body: CommitmentIn, user: dict = Depends(require_ir_edit),
                      db: Session = Depends(get_db)):
    fund = db.query(IrFund).filter(IrFund.id == body.fundId).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    investor = db.query(IrInvestor).filter(IrInvestor.id == body.investorId).first()
    if not investor:
        raise HTTPException(404, "Investor not found")
    if float(body.commitmentAmount or 0) < 0:
        raise HTTPException(400, "commitmentAmount cannot be negative")
    status = (body.status or "pending").strip()
    _require_enum(status, _COMMITMENT_STATUSES, "status")
    _validate_doc_url(body.signedDocUrl, "signedDocUrl")
    now = _now_iso()
    c = IrCommitment(
        id=str(uuid.uuid4()),
        fund_id=fund.id,
        investor_id=investor.id,
        commitment_amount=float(body.commitmentAmount or 0),
        units=float(body.units or 0),
        subscription_date=_iso_date(body.subscriptionDate, "subscriptionDate"),
        status=status,
        signed_doc_url=(body.signedDocUrl or "").strip(),
        signed_doc_name=(body.signedDocName or "").strip(),
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(c)
    db.commit()
    return _serialize_commitment(c, {fund.id: fund.name}, {investor.id: investor.display_name})


@router.patch("/commitments/{commitment_id}")
def update_commitment(commitment_id: str, body: CommitmentUpdate,
                      user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    c = db.query(IrCommitment).filter(IrCommitment.id == commitment_id).first()
    if not c:
        raise HTTPException(404, "Commitment not found")
    if body.signedDocUrl is not None:
        _validate_doc_url(body.signedDocUrl, "signedDocUrl")
        c.signed_doc_url = body.signedDocUrl.strip()
    if body.commitmentAmount is not None:
        if float(body.commitmentAmount) < 0:
            raise HTTPException(400, "commitmentAmount cannot be negative")
        c.commitment_amount = float(body.commitmentAmount)
    if body.status is not None:
        c.status = _require_enum(body.status.strip(), _COMMITMENT_STATUSES, "status")
    if body.units            is not None: c.units             = float(body.units)
    if body.subscriptionDate is not None: c.subscription_date = _iso_date(body.subscriptionDate, "subscriptionDate")
    if body.signedDocName    is not None: c.signed_doc_name   = body.signedDocName.strip()
    c.updated_at = _now_iso()
    db.commit()
    fnames = _fund_names(db, [c.fund_id])
    inames = _investor_names(db, [c.investor_id])
    return _serialize_commitment(c, fnames, inames)


@router.delete("/commitments/{commitment_id}")
def delete_commitment(commitment_id: str, user: dict = Depends(require_ir_admin),
                      db: Session = Depends(get_db)):
    c = db.query(IrCommitment).filter(IrCommitment.id == commitment_id).first()
    if not c:
        raise HTTPException(404, "Commitment not found")
    paid_calls = db.query(IrCapitalCallAllocation).filter(
        IrCapitalCallAllocation.commitment_id == commitment_id,
        IrCapitalCallAllocation.status == "paid").count()
    paid_dists = db.query(IrDistributionAllocation).filter(
        IrDistributionAllocation.commitment_id == commitment_id,
        IrDistributionAllocation.status == "paid").count()
    if paid_calls or paid_dists:
        raise HTTPException(409, "Cannot delete a commitment with paid capital-call or "
                                 "distribution allocations against it")
    # Unpaid allocations referencing it are left in place - an issued call's
    # allocations must keep summing to its total; a DRAFT call can simply be
    # re-totaled (PATCH totalAmount) to regenerate without this commitment.
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── Capital calls ─────────────────────────────────────────────────────────────

class CapitalCallIn(BaseModel):
    fundId:      str
    title:       str
    purpose:     Optional[str] = ""
    totalAmount: float
    noticeDate:  Optional[str] = ""
    dueDate:     Optional[str] = ""


class CapitalCallUpdate(BaseModel):
    title:       Optional[str] = None
    purpose:     Optional[str] = None
    totalAmount: Optional[float] = None
    noticeDate:  Optional[str] = None
    dueDate:     Optional[str] = None
    status:      Optional[str] = None


def _serialize_calls(db: Session, calls: list) -> list:
    fnames = _fund_names(db, [c.fund_id for c in calls])
    counts, paid, pending = _call_rollups(db, [c.id for c in calls])
    return [_serialize_call(c, fnames, paid=paid.get(c.id, 0.0),
                            pending=pending.get(c.id, 0.0),
                            alloc_count=counts.get(c.id, 0)) for c in calls]


@router.get("/capital-calls")
def list_capital_calls(fund_id: Optional[str] = None,
                       user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    q = db.query(IrCapitalCall)
    if fund_id:
        q = q.filter(IrCapitalCall.fund_id == fund_id)
    calls = q.order_by(IrCapitalCall.created_at.desc()).all()
    return _serialize_calls(db, calls)


@router.post("/capital-calls", status_code=201)
def create_capital_call(body: CapitalCallIn, user: dict = Depends(require_ir_edit),
                        db: Session = Depends(get_db)):
    fund = db.query(IrFund).filter(IrFund.id == body.fundId).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    if float(body.totalAmount or 0) < 0:
        raise HTTPException(400, "totalAmount cannot be negative")
    max_num = (db.query(func.max(IrCapitalCall.call_number))
               .filter(IrCapitalCall.fund_id == fund.id).scalar() or 0)
    now = _now_iso()
    call = IrCapitalCall(
        id=str(uuid.uuid4()),
        fund_id=fund.id,
        call_number=int(max_num) + 1,
        title=(body.title or "").strip(),
        purpose=(body.purpose or "").strip(),
        total_amount=float(body.totalAmount or 0),
        notice_date=_iso_date(body.noticeDate, "noticeDate"),
        due_date=_iso_date(body.dueDate, "dueDate"),
        status="draft",
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(call)
    _generate_call_allocations(db, call, _active_commitments(db, fund.id))
    db.commit()
    return _serialize_calls(db, [call])[0]


@router.patch("/capital-calls/{call_id}")
def update_capital_call(call_id: str, body: CapitalCallUpdate,
                        user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    call = db.query(IrCapitalCall).filter(IrCapitalCall.id == call_id).first()
    if not call:
        raise HTTPException(404, "Capital call not found")

    if body.totalAmount is not None and float(body.totalAmount) != float(call.total_amount or 0):
        # Re-totaling deletes and regenerates the pro-rata allocations, so it is
        # only allowed while the call is still a draft - an issued call's
        # allocation amounts are the notice the investors were sent.
        if call.status != "draft":
            raise HTTPException(400, "totalAmount can only be changed while the call is a draft")
        if float(body.totalAmount) < 0:
            raise HTTPException(400, "totalAmount cannot be negative")
        call.total_amount = float(body.totalAmount)
        db.query(IrCapitalCallAllocation).filter(
            IrCapitalCallAllocation.call_id == call.id).delete(synchronize_session=False)
        _generate_call_allocations(db, call, _active_commitments(db, call.fund_id))

    if body.title      is not None: call.title       = body.title.strip()
    if body.purpose    is not None: call.purpose     = body.purpose.strip()
    if body.noticeDate is not None: call.notice_date = _iso_date(body.noticeDate, "noticeDate")
    if body.dueDate    is not None: call.due_date    = _iso_date(body.dueDate, "dueDate")

    if body.status is not None:
        new_status = _require_enum(body.status.strip(), _CALL_STATUSES, "status")
        prev = call.status
        call.status = new_status
        if new_status == "issued" and prev != "issued":
            fund = db.query(IrFund).filter(IrFund.id == call.fund_id).first()
            if fund and fund.fund_manager_email:
                _notify(db, type="ir_capital_call_issued", recipient=fund.fund_manager_email,
                        title=f"Capital Call Issued - {fund.name}",
                        body=(f"Capital Call #{call.call_number}"
                              f"{' (' + call.title + ')' if call.title else ''} for "
                              f"{_fmt_money(call.total_amount)} has been issued"
                              f"{', due ' + call.due_date if call.due_date else ''}."),
                        ref_id=call.id)

    call.updated_at = _now_iso()
    db.commit()
    return _serialize_calls(db, [call])[0]


@router.get("/capital-calls/{call_id}/allocations")
def list_call_allocations(call_id: str, user: dict = Depends(require_ir_view),
                          db: Session = Depends(get_db)):
    call = db.query(IrCapitalCall).filter(IrCapitalCall.id == call_id).first()
    if not call:
        raise HTTPException(404, "Capital call not found")
    allocs = (db.query(IrCapitalCallAllocation)
              .filter(IrCapitalCallAllocation.call_id == call_id)
              .order_by(IrCapitalCallAllocation.amount.desc(), IrCapitalCallAllocation.id).all())
    inames = _investor_names(db, [a.investor_id for a in allocs])
    return [_serialize_call_alloc(a, inames) for a in allocs]


class CallAllocationUpdate(BaseModel):
    status:     Optional[str] = None
    paidDate:   Optional[str] = None
    paidAmount: Optional[float] = None


@router.patch("/capital-call-allocations/{allocation_id}")
def update_call_allocation(allocation_id: str, body: CallAllocationUpdate,
                           user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    a = db.query(IrCapitalCallAllocation).filter(
        IrCapitalCallAllocation.id == allocation_id).first()
    if not a:
        raise HTTPException(404, "Allocation not found")
    if body.paidDate is not None:
        a.paid_date = _iso_date(body.paidDate, "paidDate")
    if body.paidAmount is not None:
        if float(body.paidAmount) < 0:
            raise HTTPException(400, "paidAmount cannot be negative")
        a.paid_amount = float(body.paidAmount)
    if body.status is not None:
        status = _require_enum(body.status.strip(), _CALL_ALLOC_STATUSES, "status")
        a.status = status
        if status == "paid":
            if body.paidAmount is None:
                a.paid_amount = float(a.amount or 0)   # default: paid in full
            # A paid allocation needs a date for the IRR cash-flow - default to
            # today rather than silently dropping it from the XIRR series.
            if not a.paid_date:
                a.paid_date = _today()
        else:
            # Un-paying (or waiving) clears the payment record unless this PATCH
            # explicitly set it - the rollups filter on status, but stale
            # paid fields would mislead anyone reading the row.
            if body.paidAmount is None:
                a.paid_amount = 0
            if body.paidDate is None:
                a.paid_date = ""
    db.commit()
    inames = _investor_names(db, [a.investor_id])
    return _serialize_call_alloc(a, inames)


# ── Distributions ─────────────────────────────────────────────────────────────

class DistributionIn(BaseModel):
    fundId:           str
    title:            str
    distributionType: Optional[str] = "return_of_capital"
    totalAmount:      float
    distributionDate: Optional[str] = ""


class DistributionUpdate(BaseModel):
    title:            Optional[str] = None
    distributionType: Optional[str] = None
    totalAmount:      Optional[float] = None
    distributionDate: Optional[str] = None
    status:           Optional[str] = None


def _serialize_distributions(db: Session, dists: list) -> list:
    fnames = _fund_names(db, [d.fund_id for d in dists])
    counts, paid, pending = _dist_rollups(db, [d.id for d in dists])
    return [_serialize_distribution(d, fnames, paid=paid.get(d.id, 0.0),
                                    pending=pending.get(d.id, 0.0),
                                    alloc_count=counts.get(d.id, 0)) for d in dists]


@router.get("/distributions")
def list_distributions(fund_id: Optional[str] = None,
                       user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    q = db.query(IrDistribution)
    if fund_id:
        q = q.filter(IrDistribution.fund_id == fund_id)
    dists = q.order_by(IrDistribution.created_at.desc()).all()
    return _serialize_distributions(db, dists)


@router.post("/distributions", status_code=201)
def create_distribution(body: DistributionIn, user: dict = Depends(require_ir_edit),
                        db: Session = Depends(get_db)):
    fund = db.query(IrFund).filter(IrFund.id == body.fundId).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    if float(body.totalAmount or 0) < 0:
        raise HTTPException(400, "totalAmount cannot be negative")
    dist_type = (body.distributionType or "return_of_capital").strip()
    _require_enum(dist_type, _DIST_TYPES, "distributionType")
    max_num = (db.query(func.max(IrDistribution.distribution_number))
               .filter(IrDistribution.fund_id == fund.id).scalar() or 0)
    now = _now_iso()
    dist = IrDistribution(
        id=str(uuid.uuid4()),
        fund_id=fund.id,
        distribution_number=int(max_num) + 1,
        title=(body.title or "").strip(),
        distribution_type=dist_type,
        total_amount=float(body.totalAmount or 0),
        distribution_date=_iso_date(body.distributionDate, "distributionDate"),
        status="draft",
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(dist)
    _generate_dist_allocations(db, dist, _active_commitments(db, fund.id))
    db.commit()
    return _serialize_distributions(db, [dist])[0]


@router.patch("/distributions/{distribution_id}")
def update_distribution(distribution_id: str, body: DistributionUpdate,
                        user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    dist = db.query(IrDistribution).filter(IrDistribution.id == distribution_id).first()
    if not dist:
        raise HTTPException(404, "Distribution not found")

    if body.totalAmount is not None and float(body.totalAmount) != float(dist.total_amount or 0):
        if dist.status != "draft":
            raise HTTPException(400, "totalAmount can only be changed while the distribution is a draft")
        if float(body.totalAmount) < 0:
            raise HTTPException(400, "totalAmount cannot be negative")
        dist.total_amount = float(body.totalAmount)
        db.query(IrDistributionAllocation).filter(
            IrDistributionAllocation.distribution_id == dist.id).delete(synchronize_session=False)
        _generate_dist_allocations(db, dist, _active_commitments(db, dist.fund_id))

    if body.title is not None:
        dist.title = body.title.strip()
    if body.distributionType is not None:
        dist.distribution_type = _require_enum(body.distributionType.strip(), _DIST_TYPES, "distributionType")
    if body.distributionDate is not None:
        dist.distribution_date = _iso_date(body.distributionDate, "distributionDate")

    if body.status is not None:
        new_status = _require_enum(body.status.strip(), _DIST_STATUSES, "status")
        prev = dist.status
        dist.status = new_status
        if new_status == "paid" and prev != "paid":
            # Marking the WHOLE distribution paid settles its still-pending
            # allocations (the normal "wired everyone today" flow). Partial
            # payment is done per-allocation while the distribution stays issued.
            pay_date = dist.distribution_date or _today()
            for a in db.query(IrDistributionAllocation).filter(
                    IrDistributionAllocation.distribution_id == dist.id,
                    IrDistributionAllocation.status == "pending").all():
                a.status = "paid"
                a.paid_date = pay_date
        if new_status in ("issued", "paid") and prev != new_status:
            fund = db.query(IrFund).filter(IrFund.id == dist.fund_id).first()
            if fund and fund.fund_manager_email:
                verb = "Issued" if new_status == "issued" else "Paid"
                _notify(db, type=f"ir_distribution_{new_status}", recipient=fund.fund_manager_email,
                        title=f"Distribution {verb} - {fund.name}",
                        body=(f"Distribution #{dist.distribution_number}"
                              f"{' (' + dist.title + ')' if dist.title else ''} for "
                              f"{_fmt_money(dist.total_amount)} is now {new_status}"
                              f"{', dated ' + dist.distribution_date if dist.distribution_date else ''}."),
                        ref_id=dist.id)

    dist.updated_at = _now_iso()
    db.commit()
    return _serialize_distributions(db, [dist])[0]


@router.get("/distributions/{distribution_id}/allocations")
def list_dist_allocations(distribution_id: str, user: dict = Depends(require_ir_view),
                          db: Session = Depends(get_db)):
    dist = db.query(IrDistribution).filter(IrDistribution.id == distribution_id).first()
    if not dist:
        raise HTTPException(404, "Distribution not found")
    allocs = (db.query(IrDistributionAllocation)
              .filter(IrDistributionAllocation.distribution_id == distribution_id)
              .order_by(IrDistributionAllocation.amount.desc(), IrDistributionAllocation.id).all())
    inames = _investor_names(db, [a.investor_id for a in allocs])
    return [_serialize_dist_alloc(a, inames) for a in allocs]


class DistAllocationUpdate(BaseModel):
    status:   Optional[str] = None
    paidDate: Optional[str] = None


@router.patch("/distribution-allocations/{allocation_id}")
def update_dist_allocation(allocation_id: str, body: DistAllocationUpdate,
                           user: dict = Depends(require_ir_edit), db: Session = Depends(get_db)):
    a = db.query(IrDistributionAllocation).filter(
        IrDistributionAllocation.id == allocation_id).first()
    if not a:
        raise HTTPException(404, "Allocation not found")
    if body.paidDate is not None:
        a.paid_date = _iso_date(body.paidDate, "paidDate")
    if body.status is not None:
        status = _require_enum(body.status.strip(), _DIST_ALLOC_STATUSES, "status")
        a.status = status
        if status == "paid":
            # `amount` IS what's paid once status='paid'; only the date needs a
            # default (the IRR cash-flow requires one).
            if not a.paid_date:
                a.paid_date = _today()
        elif body.paidDate is None:
            a.paid_date = ""
    db.commit()
    inames = _investor_names(db, [a.investor_id])
    return _serialize_dist_alloc(a, inames)


# ── Capital accounts (computed, read-only) ────────────────────────────────────

def _account_row(fund: IrFund, investor_id: str, investor_name: str, acct: dict,
                 as_of: str) -> dict:
    return {
        "fundId":       fund.id,
        "fundName":     fund.name,
        "investorId":   investor_id,
        "investorName": investor_name,
        "committed":    round(acct["committed"], 2),
        "called":       round(acct["called"], 2),
        "unfunded":     round(acct["unfunded"], 2),
        "distributed":  round(acct["distributed"], 2),
        "dpi":          round(acct["dpi"], 4),
        "tvpi":         round(acct["tvpi"], 4) if acct["tvpi"] is not None else None,
        "irrPct":       acct["irrPct"],
        "asOf":         as_of,
    }


@router.get("/capital-accounts")
def list_capital_accounts(fund_id: Optional[str] = None, investor_id: Optional[str] = None,
                          user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    pairs_q = db.query(IrCommitment.fund_id, IrCommitment.investor_id).distinct()
    if fund_id:
        pairs_q = pairs_q.filter(IrCommitment.fund_id == fund_id)
    if investor_id:
        pairs_q = pairs_q.filter(IrCommitment.investor_id == investor_id)
    pairs = pairs_q.all()
    fund_ids = {p[0] for p in pairs}
    funds = ({f.id: f for f in db.query(IrFund).filter(IrFund.id.in_(fund_ids)).all()}
             if fund_ids else {})
    inames = _investor_names(db, [p[1] for p in pairs])
    as_of = _today()
    out = []
    for fid, iid in pairs:
        fund = funds.get(fid)
        if not fund:
            continue
        acct = _capital_account(db, fund, iid)
        if acct is None:
            continue
        out.append(_account_row(fund, iid, inames.get(iid, ""), acct, as_of))
    out.sort(key=lambda r: (r["fundName"], r["investorName"]))
    return out


@router.get("/capital-accounts/{investor_id}/{fund_id}")
def get_capital_account(investor_id: str, fund_id: str,
                        user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    fund = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    investor = db.query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not investor:
        raise HTTPException(404, "Investor not found")
    acct = _capital_account(db, fund, investor_id)
    if acct is None:
        raise HTTPException(404, "This investor has no commitment in this fund")

    # Cash-flow statement lines - the SAME paid allocations the IRR used.
    call_allocs = db.query(IrCapitalCallAllocation).filter(
        IrCapitalCallAllocation.fund_id == fund.id,
        IrCapitalCallAllocation.investor_id == investor_id,
        IrCapitalCallAllocation.status == "paid").all()
    dist_allocs = db.query(IrDistributionAllocation).filter(
        IrDistributionAllocation.fund_id == fund.id,
        IrDistributionAllocation.investor_id == investor_id,
        IrDistributionAllocation.status == "paid").all()
    call_ids = {a.call_id for a in call_allocs}
    dist_ids = {a.distribution_id for a in dist_allocs}
    calls = ({c.id: c for c in db.query(IrCapitalCall).filter(IrCapitalCall.id.in_(call_ids)).all()}
             if call_ids else {})
    dists = ({d.id: d for d in db.query(IrDistribution).filter(IrDistribution.id.in_(dist_ids)).all()}
             if dist_ids else {})

    flows = []
    for a in call_allocs:
        if not a.paid_date:
            continue
        parent = calls.get(a.call_id)
        label = f"Capital Call #{parent.call_number}" if parent else "Capital Call"
        flows.append({"date": a.paid_date, "type": "call", "label": label,
                      "amount": -float(a.paid_amount or 0)})
    for a in dist_allocs:
        if not a.paid_date:
            continue
        parent = dists.get(a.distribution_id)
        label = f"Distribution #{parent.distribution_number}" if parent else "Distribution"
        flows.append({"date": a.paid_date, "type": "distribution", "label": label,
                      "amount": float(a.amount or 0)})
    flows.sort(key=lambda x: (x["date"], x["label"]))

    row = _account_row(fund, investor_id, investor.display_name, acct, _today())
    row["cashFlows"] = flows
    return row


# ── Documents ─────────────────────────────────────────────────────────────────

class DocumentIn(BaseModel):
    fundId:     Optional[str] = ""
    investorId: Optional[str] = ""
    category:   Optional[str] = "other"
    title:      str
    fileUrl:    Optional[str] = ""
    fileName:   Optional[str] = ""


@router.get("/documents")
def list_documents(fund_id: Optional[str] = None, investor_id: Optional[str] = None,
                   category: Optional[str] = None,
                   user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    q = db.query(IrDocument)
    if fund_id:
        q = q.filter(IrDocument.fund_id == fund_id)
    if investor_id:
        q = q.filter(IrDocument.investor_id == investor_id)
    if category:
        q = q.filter(IrDocument.category == category)
    rows = q.order_by(IrDocument.created_at.desc()).all()
    fnames = _fund_names(db, [d.fund_id for d in rows])
    inames = _investor_names(db, [d.investor_id for d in rows])
    return [_serialize_document(d, fnames, inames) for d in rows]


@router.post("/documents", status_code=201)
def create_document(body: DocumentIn, user: dict = Depends(require_ir_edit),
                    db: Session = Depends(get_db)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(400, "Title cannot be empty")
    category = (body.category or "other").strip()
    _require_enum(category, _DOC_CATEGORIES, "category")
    # Empty fileUrl is allowed (placeholder rows - the frontend renders a
    # "no file attached" state); a non-empty one must be our Supabase storage.
    _validate_doc_url(body.fileUrl, "fileUrl")
    fund_id = (body.fundId or "").strip()
    investor_id = (body.investorId or "").strip()
    if fund_id and not db.query(IrFund).filter(IrFund.id == fund_id).first():
        raise HTTPException(404, "Deal not found")
    if investor_id and not db.query(IrInvestor).filter(IrInvestor.id == investor_id).first():
        raise HTTPException(404, "Investor not found")
    d = IrDocument(
        id=str(uuid.uuid4()),
        fund_id=fund_id,
        investor_id=investor_id,
        category=category,
        title=title,
        file_url=(body.fileUrl or "").strip(),
        file_name=(body.fileName or "").strip(),
        uploaded_by=user["email"],
        created_at=_now_iso(),
    )
    db.add(d)
    db.commit()
    fnames = _fund_names(db, [d.fund_id])
    inames = _investor_names(db, [d.investor_id])
    return _serialize_document(d, fnames, inames)


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, user: dict = Depends(require_ir_admin),
                    db: Session = Depends(get_db)):
    d = db.query(IrDocument).filter(IrDocument.id == document_id).first()
    if not d:
        raise HTTPException(404, "Document not found")
    db.delete(d)
    db.commit()
    return {"ok": True}


# ── Updates ───────────────────────────────────────────────────────────────────

class UpdateIn(BaseModel):
    fundId: Optional[str] = ""
    title:  str
    body:   Optional[str] = ""
    pinned: Optional[bool] = False


class UpdatePatch(BaseModel):
    title:  Optional[str] = None
    body:   Optional[str] = None
    pinned: Optional[bool] = None


@router.get("/updates")
def list_updates(fund_id: Optional[str] = None,
                 user: dict = Depends(require_ir_view), db: Session = Depends(get_db)):
    q = db.query(IrUpdate)
    if fund_id:
        q = q.filter(IrUpdate.fund_id == fund_id)
    rows = q.order_by(IrUpdate.pinned.desc(), IrUpdate.created_at.desc()).all()
    fnames = _fund_names(db, [u.fund_id for u in rows])
    return [_serialize_update(u, fnames) for u in rows]


@router.post("/updates", status_code=201)
def create_update(body: UpdateIn, user: dict = Depends(require_ir_edit),
                  db: Session = Depends(get_db)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(400, "Title cannot be empty")
    fund_id = (body.fundId or "").strip()
    if fund_id and not db.query(IrFund).filter(IrFund.id == fund_id).first():
        raise HTTPException(404, "Deal not found")
    u = IrUpdate(
        id=str(uuid.uuid4()),
        fund_id=fund_id,
        title=title,
        body=(body.body or "").strip(),
        pinned=bool(body.pinned),
        created_by=user["email"],
        created_at=_now_iso(),
    )
    db.add(u)
    db.commit()
    fnames = _fund_names(db, [u.fund_id])
    return _serialize_update(u, fnames)


@router.patch("/updates/{update_id}")
def patch_update(update_id: str, body: UpdatePatch, user: dict = Depends(require_ir_edit),
                 db: Session = Depends(get_db)):
    u = db.query(IrUpdate).filter(IrUpdate.id == update_id).first()
    if not u:
        raise HTTPException(404, "Update not found")
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(400, "Title cannot be empty")
        u.title = t
    if body.body   is not None: u.body   = body.body.strip()
    if body.pinned is not None: u.pinned = bool(body.pinned)
    db.commit()
    fnames = _fund_names(db, [u.fund_id])
    return _serialize_update(u, fnames)


@router.delete("/updates/{update_id}")
def delete_update(update_id: str, user: dict = Depends(require_ir_admin),
                  db: Session = Depends(get_db)):
    u = db.query(IrUpdate).filter(IrUpdate.id == update_id).first()
    if not u:
        raise HTTPException(404, "Update not found")
    db.delete(u)
    db.commit()
    return {"ok": True}


# ── Investor portal (external/guest login + row-level deal access) ──────────────────────
# Lets a real external investor (not Greens staff) log in via an Entra B2B
# guest account and see ONLY their own deal(s) -- a separate, deliberately
# narrow read-only surface below, never the admin endpoints above. Granting
# access does three things atomically:
#   1. creates a lightweight guest HR record for the investor's email if none
#      exists yet (so there is something for IT to actually invite -- see
#      docs/External-Users-Phase4.md; that Entra invite is a manual step this
#      app cannot automate, it needs Graph API admin credentials we do not have),
#   2. adds that email to the pre-seeded "Investor" Access Group (routers/
#      groups.py STARTER_GROUPS), which grants the investor-relations module
#      at viewer level -- and ONLY viewer, this group must never be able to
#      edit or delete GP data,
#   3. adds a NexusAccessScope row (module_id="investor-relations",
#      scope_type="fund", scope_id=<deal>) scoping them to that ONE deal.
# Revoking removes just that scope row -- the HR record and group membership
# are left alone since the investor may still hold access to other deals.

class PortalAccessIn(BaseModel):
    investorId: str
    fundId:     str


def _ensure_investor_group(db: Session, actor_email: str) -> NexusGroup:
    """Get-or-create the "Investor" Access Group, making sure it grants
    investor-relations at viewer level (never higher)."""
    group = db.query(NexusGroup).filter(NexusGroup.name == _PORTAL_GROUP_NAME).first()
    now = _now_iso()
    if not group:
        group = NexusGroup(id=str(uuid.uuid4()), name=_PORTAL_GROUP_NAME,
                           allowed_modules="investor-relations:viewer",
                           created_by=actor_email, created_at=now)
        db.add(group)
        db.flush()
        return group
    mods = [p.strip() for p in (group.allowed_modules or "").split(",") if p.strip()]
    if not any(p.split(":")[0] == "investor-relations" for p in mods):
        mods.append("investor-relations:viewer")
        group.allowed_modules = ",".join(mods)
    return group


@router.post("/portal-access/grant", status_code=201)
def grant_portal_access(body: PortalAccessIn, user: dict = Depends(require_ir_edit),
                        db: Session = Depends(get_db)):
    investor = db.query(IrInvestor).filter(IrInvestor.id == body.investorId).first()
    if not investor:
        raise HTTPException(404, "Investor not found")
    fund = db.query(IrFund).filter(IrFund.id == body.fundId).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    email = (investor.email or "").lower().strip()
    if not email:
        raise HTTPException(400, "This investor needs an email on file before granting portal access")
    if not db.query(IrCommitment).filter(IrCommitment.investor_id == investor.id,
                                         IrCommitment.fund_id == fund.id).first():
        raise HTTPException(400, "This investor has no commitment in this deal yet - add one first")

    now = _now_iso()
    employee = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == email).first()
    employee_created = False
    needs_invite_reminder = False
    if not employee:
        first, _, last = investor.display_name.partition(" ")
        employee = NexusEmployee(
            id=str(uuid.uuid4()), first_name=first or investor.display_name, last_name=last,
            work_email=email, job_title="Investor", status="active", identity_type="guest",
            created_by=user["email"], created_at=now, updated_at=now,
        )
        db.add(employee)
        employee_created = True
        needs_invite_reminder = True
    elif (employee.identity_type or "internal") == "internal":
        raise HTTPException(409, f"{email} already belongs to an internal Nexus employee "
                                 f"record - grant portal access to a different email, or "
                                 f"ask IT to review that account first")
    elif (employee.identity_type or "internal") == "external":
        # 'external' = HR-record-only, no login capability -- portal access
        # requires a real login, so upgrade this record to a guest account.
        employee.identity_type = "guest"
        employee.updated_at = now
        needs_invite_reminder = True

    group = _ensure_investor_group(db, user["email"])
    if not db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group.id,
                                             NexusGroupMember.email == email).first():
        db.add(NexusGroupMember(group_id=group.id, email=email, added_by=user["email"], added_at=now))

    if not db.query(NexusAccessScope).filter(NexusAccessScope.email == email,
                                             NexusAccessScope.module_id == "investor-relations",
                                             NexusAccessScope.scope_id == fund.id).first():
        db.add(NexusAccessScope(id=str(uuid.uuid4()), email=email, module_id="investor-relations",
                                scope_type="fund", scope_id=fund.id,
                                created_by=user["email"], created_at=now))
    db.commit()
    invalidate_role_cache(email)
    return {
        "granted": True,
        "employeeCreated": employee_created,
        "identityType": employee.identity_type,
        "nextStep": (
            f"{email} now has a guest HR record and access to this deal, but still needs an "
            f"actual Entra ID guest invite before they can sign in - send one from Entra "
            f"Admin Center -> External Identities -> Invite (see docs/External-Users-Phase4.md). "
            f"This app cannot send that invite automatically."
        ) if needs_invite_reminder else None,
    }


@router.delete("/portal-access/{investor_id}/{fund_id}")
def revoke_portal_access(investor_id: str, fund_id: str, user: dict = Depends(require_ir_edit),
                         db: Session = Depends(get_db)):
    investor = db.query(IrInvestor).filter(IrInvestor.id == investor_id).first()
    if not investor:
        raise HTTPException(404, "Investor not found")
    email = (investor.email or "").lower().strip()
    row = db.query(NexusAccessScope).filter(NexusAccessScope.email == email,
                                            NexusAccessScope.module_id == "investor-relations",
                                            NexusAccessScope.scope_id == fund_id).first()
    if row:
        db.delete(row)
        db.commit()
        invalidate_role_cache(email)
    return {"revoked": True}


def _my_visible_fund_ids(user: dict, db: Session):
    """None = unrestricted (supervisor+ GP staff -- the normal admin path).
    Otherwise this caller reached investor-relations ONLY through the
    "Investor" group's viewer grant, so a missing/empty scope must mean
    "sees nothing" -- deliberately NOT the generic scoped_ids() fallback
    (which returns None, i.e. unrestricted, for anyone who is not
    identity_type='external'). IR rows carry other people's financial and
    KYC data, so a viewer-only grant with no explicit fund scope defaults to
    zero visibility here, never everything."""
    if user["level"] >= _LEVELS["supervisor"]:
        return None
    allowed = scoped_ids(user["email"], "investor-relations", db)
    return allowed if allowed is not None else set()


# Admits supervisor+ GP staff (the normal path) OR anyone the "Investor"
# group has granted investor-relations at viewer level -- an external
# investor account never reaches anything above this line in the file.
require_ir_portal = require_level_or_module(_LEVELS["supervisor"], "investor-relations", "viewer")


def _my_investor_record(user: dict, db: Session):
    return db.query(IrInvestor).filter(func.lower(IrInvestor.email) == user["email"]).first()


@router.get("/portal/my-deals")
def portal_my_deals(user: dict = Depends(require_ir_portal), db: Session = Depends(get_db)):
    """The investor-portal landing list: every deal the caller is BOTH scoped
    to AND actually holds a commitment in (belt-and-suspenders -- a scope row
    someone forgot to clean up should never surface a deal with no real
    investment behind it)."""
    fund_ids = _my_visible_fund_ids(user, db)
    if fund_ids is not None and not fund_ids:
        return []
    investor = _my_investor_record(user, db)
    if not investor:
        return []
    committed_fund_ids = {c.fund_id for c in db.query(IrCommitment)
                          .filter(IrCommitment.investor_id == investor.id).all()}
    if fund_ids is not None:
        committed_fund_ids &= fund_ids
    if not committed_fund_ids:
        return []
    funds = db.query(IrFund).filter(IrFund.id.in_(committed_fund_ids)).all()
    out = []
    for f in funds:
        acct = _capital_account(db, f, investor.id)
        if not acct:
            continue
        out.append({
            "fundId": f.id, "fundName": f.name, "entityName": f.entity_name or "",
            "strategy": f.strategy or "", "propertyName": f.property_name or "",
            "status": f.status or "raising",
            "committed": round(acct["committed"], 2), "called": round(acct["called"], 2),
            "unfunded": round(acct["unfunded"], 2), "distributed": round(acct["distributed"], 2),
            "dpi": round(acct["dpi"], 4),
            "tvpi": round(acct["tvpi"], 4) if acct["tvpi"] is not None else None,
            "irrPct": acct["irrPct"],
        })
    out.sort(key=lambda r: r["fundName"])
    return out


@router.get("/portal/deals/{fund_id}")
def portal_deal_detail(fund_id: str, user: dict = Depends(require_ir_portal), db: Session = Depends(get_db)):
    """Full deal detail for the portal: capital account, dated cash-flow
    ledger, fund-wide + investor-specific documents, and updates. 404 (not
    403) on any scoping mismatch -- an investor probing other fund ids should
    not be able to distinguish "not yours" from "does not exist."""
    fund_ids = _my_visible_fund_ids(user, db)
    if fund_ids is not None and fund_id not in fund_ids:
        raise HTTPException(404, "Deal not found")
    investor = _my_investor_record(user, db)
    if not investor:
        raise HTTPException(404, "Deal not found")
    fund = db.query(IrFund).filter(IrFund.id == fund_id).first()
    if not fund:
        raise HTTPException(404, "Deal not found")
    if not db.query(IrCommitment).filter(IrCommitment.investor_id == investor.id,
                                         IrCommitment.fund_id == fund_id).first():
        raise HTTPException(404, "Deal not found")

    acct = _capital_account(db, fund, investor.id)
    if not acct:
        raise HTTPException(404, "Deal not found")

    call_allocs = db.query(IrCapitalCallAllocation).filter(
        IrCapitalCallAllocation.fund_id == fund.id, IrCapitalCallAllocation.investor_id == investor.id,
        IrCapitalCallAllocation.status == "paid").all()
    dist_allocs = db.query(IrDistributionAllocation).filter(
        IrDistributionAllocation.fund_id == fund.id, IrDistributionAllocation.investor_id == investor.id,
        IrDistributionAllocation.status == "paid").all()
    call_ids = {a.call_id for a in call_allocs}
    dist_ids = {a.distribution_id for a in dist_allocs}
    calls = ({c.id: c for c in db.query(IrCapitalCall).filter(IrCapitalCall.id.in_(call_ids)).all()}
             if call_ids else {})
    dists = ({d.id: d for d in db.query(IrDistribution).filter(IrDistribution.id.in_(dist_ids)).all()}
             if dist_ids else {})
    flows = []
    for a in call_allocs:
        if not a.paid_date:
            continue
        parent = calls.get(a.call_id)
        flows.append({"date": a.paid_date, "type": "call",
                      "label": f"Capital Call #{parent.call_number}" if parent else "Capital Call",
                      "amount": -float(a.paid_amount or 0)})
    for a in dist_allocs:
        if not a.paid_date:
            continue
        parent = dists.get(a.distribution_id)
        flows.append({"date": a.paid_date, "type": "distribution",
                      "label": f"Distribution #{parent.distribution_number}" if parent else "Distribution",
                      "amount": float(a.amount or 0)})
    flows.sort(key=lambda x: (x["date"], x["label"]))

    docs = (db.query(IrDocument)
            .filter(IrDocument.fund_id == fund.id,
                    or_(IrDocument.investor_id == "", IrDocument.investor_id == investor.id))
            .order_by(IrDocument.created_at.desc()).all())
    updates = (db.query(IrUpdate)
               .filter(or_(IrUpdate.fund_id == fund.id, IrUpdate.fund_id == ""))
               .order_by(IrUpdate.pinned.desc(), IrUpdate.created_at.desc()).all())
    fnames = {fund.id: fund.name}
    inames = {investor.id: investor.display_name}

    return {
        "fundId": fund.id, "fundName": fund.name, "entityName": fund.entity_name or "",
        "strategy": fund.strategy or "", "propertyName": fund.property_name or "",
        "status": fund.status or "raising", "description": fund.description or "",
        "thesis": fund.thesis or "", "inceptionDate": fund.inception_date or "",
        "closeDate": fund.close_date or "", "exitDate": fund.exit_date or "",
        "committed": round(acct["committed"], 2), "called": round(acct["called"], 2),
        "unfunded": round(acct["unfunded"], 2), "distributed": round(acct["distributed"], 2),
        "dpi": round(acct["dpi"], 4),
        "tvpi": round(acct["tvpi"], 4) if acct["tvpi"] is not None else None,
        "irrPct": acct["irrPct"], "asOf": _today(),
        "cashFlows": flows,
        "documents": [_serialize_document(d, fnames, inames) for d in docs],
        "updates": [_serialize_update(u, fnames) for u in updates],
    }


# ── Demo seed ─────────────────────────────────────────────────────────────────

@router.post("/seed-demo-data")
def seed_demo_data(user: dict = Depends(require_ir_admin), db: Session = Depends(get_db)):
    """Populate a realistic demo book of business (3 funds, 14 investors,
    commitments/calls/distributions spread over the past ~18 months). Idempotent:
    refuses to run if any fund already exists."""
    if db.query(IrFund).count() > 0:
        return {"seeded": False, "reason": "Demo data already exists"}

    me = user["email"]
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    def d(days_back: int) -> str:
        return (now - timedelta(days=days_back)).date().isoformat()

    def ts(days_back: int) -> str:
        return (now - timedelta(days=days_back)).isoformat()

    def _id() -> str:
        return str(uuid.uuid4())

    # Funds ------------------------------------------------------------------
    fund_mf3 = IrFund(
        id=_id(), name="Multifamily Growth Fund III",
        entity_name="MF Growth III, LLC", strategy="Value-Add Multifamily",
        property_name="Cypress Grove Apartments (312 units)", status="active",
        target_raise=25000000, minimum_investment=100000,
        preferred_return_pct=8.0, gp_promote_pct=20.0, target_irr_pct=16.0,
        target_multiple=1.8, hold_period_years=5, inception_date=d(420),
        close_date="", exit_date="", fund_manager_email=me,
        description="Value-add repositioning of Class B multifamily in high-growth Sunbelt submarkets.",
        thesis="Buy below replacement cost, renovate unit interiors, push rents to market, refinance in year 3.",
        created_by=me, created_at=ts(420), updated_at=now_iso)
    fund_ocean = IrFund(
        id=_id(), name="Oceanview Value-Add Partners II",
        entity_name="Oceanview VA Partners II, LP", strategy="Coastal Value-Add Multifamily",
        property_name="Oceanview Terrace (188 units)", status="active",
        target_raise=12000000, minimum_investment=50000,
        preferred_return_pct=8.0, gp_promote_pct=20.0, target_irr_pct=15.0,
        target_multiple=1.7, hold_period_years=4, inception_date=d(540),
        close_date=d(400), exit_date="", fund_manager_email=me,
        description="Fully-subscribed coastal multifamily repositioning; refinanced after Phase I renovations.",
        thesis="Under-managed coastal asset with 22% loss-to-lease; renovate, restaff, refinance.",
        created_by=me, created_at=ts(540), updated_at=now_iso)
    fund_sunbelt = IrFund(
        id=_id(), name="Sunbelt Industrial Income Fund",
        entity_name="Sunbelt Industrial, LLC", strategy="Core-Plus Industrial",
        property_name="", status="raising",
        target_raise=15000000, minimum_investment=250000,
        preferred_return_pct=7.0, gp_promote_pct=20.0, target_irr_pct=14.0,
        target_multiple=1.6, hold_period_years=7, inception_date=d(60),
        close_date="", exit_date="", fund_manager_email=me,
        description="Income-focused portfolio of shallow-bay industrial across Texas and the Carolinas.",
        thesis="Aggregate small-tenant industrial at a basis institutional buyers can't reach, sell as a portfolio.",
        created_by=me, created_at=ts(60), updated_at=now_iso)
    for f in (fund_mf3, fund_ocean, fund_sunbelt):
        db.add(f)

    # Investors ----------------------------------------------------------------
    inv_specs = [
        # (name, entity_type, email, accredited, kyc, status, rel_owner, tax_id)
        ("Robert & Diane Castellano",                    "individual",  "rcastellano@example.com",   "verified",       "cleared",   "active",   me, True),
        ("Meridian Capital Holdings LLC",                "llc",         "invest@meridiancap.example", "verified",      "cleared",   "active",   "", True),
        ("The Harold Weintraub Revocable Trust",         "trust",       "hweintraub@example.com",    "verified",       "cleared",   "active",   me, True),
        ("Anjali Mehta",                                 "individual",  "anjali.mehta@example.com",  "self_certified", "cleared",   "active",   "", True),
        ("Brightstone Family Office LLC",                "llc",         "ops@brightstonefo.example", "verified",       "cleared",   "active",   me, True),
        ("Equity Trust Co. FBO James J. O'Rourke IRA",   "ira",         "jorourke@example.com",      "verified",       "cleared",   "active",   "", True),
        ("Marcus & Lena Feldman",                        "individual",  "mfeldman@example.com",      "verified",       "cleared",   "active",   "", True),
        ("Tidewater Ventures LP",                        "partnership", "lp@tidewaterventures.example", "verified",    "in_review", "active",   "", True),
        ("Sandra Okafor",                                "individual",  "sandra.okafor@example.com", "self_certified", "cleared",   "active",   me, True),
        ("Kessler Brothers Properties Inc.",             "corporation", "office@kesslerbros.example", "verified",     "cleared",   "active",   "", True),
        ("Priya & Dev Raghunathan",                      "individual",  "praghunathan@example.com",  "verified",       "cleared",   "active",   "", True),
        ("Bluff Creek Holdings LLC",                     "llc",         "manager@bluffcreek.example", "self_certified", "in_review", "active",  "", False),
        ("Thomas Grady",                                 "individual",  "tgrady@example.com",        "self_certified", "pending",   "active",   "", False),
        ("Helen Marsh",                                  "individual",  "helen.marsh@example.com",   "unverified",     "pending",   "prospect", me, False),
    ]
    investors = []
    for i, (name, etype, email, accr, kyc, status, rel, tax) in enumerate(inv_specs):
        v = IrInvestor(
            id=_id(), display_name=name, entity_type=etype, email=email,
            phone=f"+1 (555) 01{i:02d}-{1000 + 37 * i}", address="",
            accredited_status=accr, kyc_status=kyc, tax_id_on_file=tax,
            relationship_owner_email=rel, notes="", status=status,
            created_by=me, created_at=ts(520 - 10 * i), updated_at=now_iso)
        db.add(v)
        investors.append(v)

    # Commitments ----------------------------------------------------------------
    # NOTE: autoflush=False - these rows aren't visible to queries yet, so the
    # call/distribution builders below work off these Python lists, never a query.
    def _mk_commitment(fund, investor, amount, days_back, status="active"):
        c = IrCommitment(
            id=_id(), fund_id=fund.id, investor_id=investor.id,
            commitment_amount=amount, units=amount / 1000.0,
            subscription_date=d(days_back), status=status,
            signed_doc_url="", signed_doc_name="",
            created_by=me, created_at=ts(days_back), updated_at=now_iso)
        db.add(c)
        return c

    mf3_specs = [(0, 750000, 400), (1, 2000000, 395), (2, 1000000, 380),
                 (3, 250000, 340), (4, 1500000, 300), (5, 400000, 260),
                 (6, 500000, 200), (7, 1250000, 130)]
    mf3_commitments = [_mk_commitment(fund_mf3, investors[i], amt, back)
                       for i, amt, back in mf3_specs]      # 7.65M of 25M raised

    ocean_specs = [(1, 2000000, 540), (4, 1750000, 535), (8, 300000, 530),
                   (9, 1500000, 520), (10, 650000, 515), (11, 800000, 505),
                   (2, 1200000, 495), (0, 900000, 480), (6, 400000, 470),
                   (7, 2000000, 450), (3, 500000, 430)]
    ocean_commitments = [_mk_commitment(fund_ocean, investors[i], amt, back)
                         for i, amt, back in ocean_specs]  # 12.0M - fully committed

    sunbelt_commitments = [
        _mk_commitment(fund_sunbelt, investors[1], 2000000, 45),
        _mk_commitment(fund_sunbelt, investors[8], 500000, 30),
        _mk_commitment(fund_sunbelt, investors[12], 250000, 20, status="pending"),
    ]
    commitments_created = len(mf3_commitments) + len(ocean_commitments) + len(sunbelt_commitments)

    # Capital calls ---------------------------------------------------------------
    def _mk_call(fund, number, title, purpose, total, notice_back, due_back, status,
                 commitments):
        call = IrCapitalCall(
            id=_id(), fund_id=fund.id, call_number=number, title=title,
            purpose=purpose, total_amount=total, notice_date=d(notice_back),
            due_date=d(due_back), status=status,
            created_by=me, created_at=ts(notice_back), updated_at=now_iso)
        db.add(call)
        allocs = []
        for c, amt in _pro_rata(total, commitments):
            a = IrCapitalCallAllocation(
                id=_id(), call_id=call.id, fund_id=fund.id, investor_id=c.investor_id,
                commitment_id=c.id, amount=amt, status="pending", paid_date="",
                paid_amount=0)
            db.add(a)
            allocs.append(a)
        return call, allocs

    def _pay(allocs, days_back):
        for a in allocs:
            a.status = "paid"
            a.paid_date = d(days_back)
            a.paid_amount = a.amount

    # Fund III - 50% called at acquisition, 25% renovation draw, 15% in flight.
    active_mf3 = [c for c in mf3_commitments if c.status == "active"]
    _, a1 = _mk_call(fund_mf3, 1, "Initial Capital Call - Acquisition",
                     "Close on Cypress Grove Apartments.", 3825000, 390, 360, "closed", active_mf3)
    _pay(a1, 365)
    _, a2 = _mk_call(fund_mf3, 2, "Renovation Draw",
                     "Phase I interior renovations (96 units).", 1912500, 200, 170, "closed", active_mf3)
    _pay(a2, 175)
    _, a3 = _mk_call(fund_mf3, 3, "Capital Call #3 - Phase II Renovations",
                     "Phase II interiors plus amenity package.", 1147500, 40, 10, "issued", active_mf3)
    _pay(a3[:5], 12)                      # most already funded
    a3[5].status = a3[6].status = "pending"
    a3[7].status = "overdue"              # due date (10 days ago) has passed

    # Oceanview - fully called across two closed calls.
    active_ocean = [c for c in ocean_commitments if c.status == "active"]
    _, b1 = _mk_call(fund_ocean, 1, "Initial Capital Call - Closing",
                     "Acquisition closing and reserves.", 7200000, 520, 490, "closed", active_ocean)
    _pay(b1, 495)
    _, b2 = _mk_call(fund_ocean, 2, "Final Capital Call",
                     "Renovation budget and working capital.", 4800000, 430, 400, "closed", active_ocean)
    _pay(b2, 405)
    calls_created = 5

    # Distributions ---------------------------------------------------------------
    def _mk_dist(fund, number, title, dist_type, total, date_back, status, commitments,
                 pay_back=None):
        dist = IrDistribution(
            id=_id(), fund_id=fund.id, distribution_number=number, title=title,
            distribution_type=dist_type, total_amount=total,
            distribution_date=d(date_back), status=status,
            created_by=me, created_at=ts(date_back), updated_at=now_iso)
        db.add(dist)
        for c, amt in _pro_rata(total, commitments):
            a = IrDistributionAllocation(
                id=_id(), distribution_id=dist.id, fund_id=fund.id,
                investor_id=c.investor_id, commitment_id=c.id, amount=amt,
                status="paid" if pay_back is not None else "pending",
                paid_date=d(pay_back) if pay_back is not None else "")
            db.add(a)
        return dist

    _mk_dist(fund_mf3, 1, "Q2 2026 Preferred Return Distribution", "preferred_return",
             300000, 30, "paid", active_mf3, pay_back=30)
    _mk_dist(fund_ocean, 1, "2025 Annual Preferred Return", "preferred_return",
             960000, 220, "paid", active_ocean, pay_back=220)
    _mk_dist(fund_ocean, 2, "Refinance Proceeds - Return of Capital", "return_of_capital",
             2400000, 90, "paid", active_ocean, pay_back=90)
    dists_created = 3

    # Documents (file_url deliberately empty - no real files in demo data; the
    # frontend renders a "no file attached" state) -------------------------------
    docs = [
        IrDocument(id=_id(), fund_id=fund_mf3.id, investor_id="", category="ppm",
                   title="Private Placement Memorandum - Multifamily Growth Fund III",
                   file_url="", file_name="", uploaded_by=me, created_at=ts(415)),
        IrDocument(id=_id(), fund_id=fund_ocean.id, investor_id=investors[1].id,
                   category="subscription_agreement",
                   title="Subscription Agreement - Meridian Capital Holdings LLC",
                   file_url="", file_name="", uploaded_by=me, created_at=ts(538)),
        IrDocument(id=_id(), fund_id=fund_ocean.id, investor_id=investors[2].id,
                   category="k1",
                   title="2025 Schedule K-1 - The Harold Weintraub Revocable Trust",
                   file_url="", file_name="", uploaded_by=me, created_at=ts(130)),
        IrDocument(id=_id(), fund_id=fund_mf3.id, investor_id="", category="quarterly_report",
                   title="Q2 2026 Quarterly Report - Cypress Grove",
                   file_url="", file_name="", uploaded_by=me, created_at=ts(18)),
        IrDocument(id=_id(), fund_id=fund_sunbelt.id, investor_id="", category="ppm",
                   title="Private Placement Memorandum - Sunbelt Industrial Income Fund",
                   file_url="", file_name="", uploaded_by=me, created_at=ts(55)),
    ]
    for doc in docs:
        db.add(doc)

    # Updates ---------------------------------------------------------------------
    updates = [
        IrUpdate(id=_id(), fund_id="", title="Welcome to the Investor Relations Portal",
                 body="All fund reporting, capital-call notices, and distribution statements now live here.",
                 pinned=True, created_by=me, created_at=ts(90)),
        IrUpdate(id=_id(), fund_id=fund_mf3.id, title="Cypress Grove Renovation - Phase I Complete",
                 body="96 units renovated; achieved rents are running 9% ahead of underwriting.",
                 pinned=False, created_by=me, created_at=ts(45)),
        IrUpdate(id=_id(), fund_id=fund_ocean.id, title="Refinance Closed - $2.4M Return of Capital Distributed",
                 body="The Oceanview Terrace refinance closed at a 5.9% fixed rate; 20% of capital returned.",
                 pinned=False, created_by=me, created_at=ts(85)),
        IrUpdate(id=_id(), fund_id=fund_sunbelt.id, title="Sunbelt Industrial Income Fund Now Open to New Investors",
                 body="First close targeted for later this quarter; two seed assets under LOI.",
                 pinned=False, created_by=me, created_at=ts(55)),
    ]
    for u in updates:
        db.add(u)

    db.commit()
    return {
        "seeded": True,
        "fundsCreated": 3,
        "investorsCreated": len(investors),
        "commitmentsCreated": commitments_created,
        "capitalCallsCreated": calls_created,
        "distributionsCreated": dists_created,
        "documentsCreated": len(docs),
        "updatesCreated": len(updates),
    }
