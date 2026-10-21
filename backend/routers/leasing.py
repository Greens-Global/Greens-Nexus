"""Leasing and monthly recurring income (Neil and Charmi, Sep 25).

The company has two sources of income: the storage business and rent. Rent
was tracked in a workbook - one row per tenant, a pair of columns per month -
fed from the ledger by an add-in, and every month accounting read it to find
who had not paid and wrote to them by hand. This is that workbook as an app:

  - A LEASE is one tenant in one space. The tenant is an Intacct customer;
    the lease adds what Intacct cannot hold - the dates, the late-fee rule,
    and the rent as it changes over time (lease_rates).
  - Each month a lease EXPECTS its rent in force that month (pro-rated when
    the lease or a rate starts or ends mid-month), less any agreed deduction.
  - What was RECEIVED is what posted to the lease's rental income accounts for
    that customer in that month, read from the ledger through the accounting
    app's internal API. Nexus never opens the accounting database.
  - The difference is the answer to "did the tenant at 47385 pay?" for every
    tenant, every month, without anybody keying it.

A tenant who moves out is not overwritten: the lease is ended and the next
tenant gets a new lease that points back at it.

Oct 6 (Charmi, MRI feedback of 10/04):
  - "The auto sync import feature is not working here; when we manually added
    the customer number, the data populated." Root cause: what was received
    is read by CUSTOMER CODE, and nothing ever filled the code in - a lease
    typed with only the tenant's name (or with the name, or a differently
    cased code, in the code box) read nothing from the ledger, forever. Now
    every lease without a known code is matched to its Intacct customer by
    name (a unique match only, "Inc." / "LLC" / punctuation ignored) when the
    rent roll loads and whenever a lease is saved, and the link is kept
    (link_source 'auto-name'). New tenants: accounting_leasing's ledger sync.
  - The customer's own record (name, phone, address, email, Intacct status)
    comes from the Intacct customer mirror: GET /leasing/customers/{code}
    (the tenant popover, and anything else that asks - the MCP included). A
    lease whose customer is inactive in Intacct is flagged so the screen can
    hide it until Show Inactive; an ended lease is flagged as expired.
  - Balance, not Owed: expected less received, so a prepayment is a credit
    (negative) balance. Owed (only the months behind) stays for Outstanding.
  - A Notes column for the team: one note per lease with who wrote it and
    when (PUT /leasing/leases/{id}/note).
  - The rent roll takes entities (with their sub-entities) and customers.

Access: the Accounting grant (viewer reads, editor changes, full deletes). A
person limited to certain entities sees only the leases of those entities.
"""
import asyncio
import calendar
import re
import time
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting
from routers.accounting import entity_scope
from routers.accounting_mre import CUSTOM_MAX_MONTHS, FREQUENCIES

router = APIRouter(prefix="/leasing", tags=["Leasing"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")
_full = require_module_grant("accounting", "full")

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONTH = re.compile(r"^\d{4}-\d{2}$")
STATUSES = ("active", "ended", "vacant")
# Oct 7 (Charmi): MRI is one list of every recurring income source.
# Oct 14 (Priyanka): CAM (common area maintenance) is a type of its own -
# a tenant, a space and lease dates, like a lease.
INCOME_TYPES = ("lease", "interest", "loan_payment", "other", "cam")
DEFAULT_INCOME_ACCOUNTS = ["41101"]
_PAID_WITHIN = 0.5   # dollars: a payment this close to what was expected is paid in full


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _d(s: str) -> Optional[date]:
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


# ── Shapes ───────────────────────────────────────────────────────────────────
# Oct 15 (Charmi + Neil): the lease term is a pick - Annual, Month to Month or
# Custom with a whole number of months - never free text a typo can break.
TERM_TYPES = ("annual", "month_to_month", "custom")
TERM_MAX_MONTHS = 600
_TERM_MONTHS = re.compile(r"^(\d{1,3}) ?(?:months?|mos?|mths?)(?: lease| term)?$")
_TERM_YEARS = re.compile(r"^(\d{1,2}|one|two|three|four|five) ?(?:years?|yrs?)(?: lease| term)?$")
_WORD_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}


def parse_term(text: str) -> Optional[tuple[str, Optional[int]]]:
    """The old free-text Lease Terms read as a term, best-effort: "Annual",
    "12 months", "1 year" -> annual; "Month to month", "MTM" -> month to
    month; "18 months", "2 years" -> custom. None when it cannot be read."""
    s = " ".join(re.sub(r"[^a-z0-9.]+", " ", (text or "").lower()).split()).strip(" .")
    if not s:
        return None
    if s in ("annual", "annually", "yearly", "annual lease", "annual term", "annual renewal"):
        return ("annual", 12)
    if s in ("mtm", "m2m", "month to month", "monthly", "month to month lease"):
        return ("month_to_month", None)
    m = _TERM_MONTHS.match(s)
    if m:
        n = int(m.group(1))
        if n == 12:
            return ("annual", 12)
        return ("custom", n) if 0 < n <= TERM_MAX_MONTHS else None
    m = _TERM_YEARS.match(s)
    if m:
        y = _WORD_NUM.get(m.group(1)) or int(m.group(1))
        if y == 1:
            return ("annual", 12)
        return ("custom", y * 12) if 0 < y * 12 <= TERM_MAX_MONTHS else None
    return None


def term_label(kind: str, months: Optional[int]) -> str:
    if kind == "annual":
        return "Annual"
    if kind == "month_to_month":
        return "Month to Month"
    if kind == "custom" and months:
        return f"Custom - {months} Months"
    return ""


def _term_out(l: models.Lease) -> dict:
    """The lease's term: the pick when one was saved, else the old free text
    read best-effort. Text that cannot be read is handed back as-is
    (termLegacy) so nothing is lost and the form asks for a pick."""
    kind = getattr(l, "term_type", "") or ""
    months = getattr(l, "term_months", None)
    legacy = ""
    if kind not in TERM_TYPES:
        kind, months = "", None
        parsed = parse_term(l.lease_terms or "")
        if parsed:
            kind, months = parsed
        else:
            legacy = (l.lease_terms or "").strip()
    if kind == "annual":
        months = 12
    elif kind == "month_to_month":
        months = None
    return {"termType": kind, "termMonths": months, "termLabel": term_label(kind, months) or legacy, "termLegacy": legacy}


def _clean_term(body) -> dict:
    kind = (body.termType or "").strip()
    if not kind:
        return {"term_type": "", "term_months": None}
    if kind not in TERM_TYPES:
        raise HTTPException(status_code=400, detail="Pick a lease term: Annual, Month to Month or Custom.")
    if kind == "annual":
        return {"term_type": kind, "term_months": 12}
    if kind == "month_to_month":
        return {"term_type": kind, "term_months": None}
    n = body.termMonths
    if n is None or isinstance(n, bool) or int(n) != n or not 1 <= int(n) <= TERM_MAX_MONTHS:
        raise HTTPException(status_code=400, detail=f"A custom lease term is a whole number of months, 1 to {TERM_MAX_MONTHS}.")
    return {"term_type": kind, "term_months": int(n)}


def lease_step(lease: dict) -> int:
    """How many months apart a source falls due (Oct 22, Priyanka: Semi-Annual
    in MRI like MRE): 1 for '' / monthly - every row saved before Oct 22 - 3
    quarterly, 6 semi-annual, 12 annual, N for Custom (every N months; a
    Custom source with no period reads as monthly). MRE's step_months."""
    freq = lease.get("frequency") or "monthly"
    if freq == "custom":
        try:
            n = int(lease.get("frequencyMonths") or 0)
        except (TypeError, ValueError):
            n = 0
        return n if 1 <= n <= CUSTOM_MAX_MONTHS else 1
    return FREQUENCIES.get(freq) or 1


def _frequency_out(l: models.Lease) -> dict:
    freq = getattr(l, "frequency", "") or "monthly"
    if freq not in FREQUENCIES:
        freq = "monthly"
    return {"frequency": freq, "frequencyMonths": int(getattr(l, "frequency_months", 0) or 0) if freq == "custom" else 0}


def _stale_out(row) -> Optional[dict]:
    """The Possibly Ended flag the daily recurring_stale scan sets, or None."""
    since = getattr(row, "stale_since", "") or ""
    return {"since": since, "lastPaid": getattr(row, "stale_last_paid", "") or "", "taskId": getattr(row, "stale_task_id", "") or ""} if since else None


def _rate_out(r: models.LeaseRate) -> dict:
    return {"id": r.id, "startDate": r.start_date, "rent": _r2(r.rent), "cam": _r2(r.cam), "other": _r2(r.other), "note": r.note or ""}


def _lease_out(l: models.Lease, rates: list[models.LeaseRate], names: Optional[dict] = None) -> dict:
    by = getattr(l, "team_note_by", "") or ""
    return {
        "id": l.id, "propertyName": l.property_name, "region": l.region or "", "tenancy": l.tenancy or "external",
        "landlord": l.landlord or "", "entityCode": l.entity_code or "",
        "incomeAccounts": l.income_accounts if isinstance(l.income_accounts, list) and l.income_accounts else list(DEFAULT_INCOME_ACCOUNTS),
        "customerId": l.customer_id or "", "tenantName": l.tenant_name or "", "contactName": l.contact_name or "",
        "phone": l.phone or "", "email": l.email or "", "mailingAddress": l.mailing_address or "",
        "leaseStart": l.lease_start or "", "leaseEnd": l.lease_end or "", "securityDeposit": _r2(l.security_deposit),
        "leaseTerms": l.lease_terms or "", "lateFee": _r2(l.late_fee), "dueDay": l.due_day or 1, "graceDays": l.grace_days if l.grace_days is not None else 5,
        "status": l.status or "active", "notes": l.notes or "", "replacesId": l.replaces_id or "",
        "rates": [_rate_out(r) for r in sorted(rates, key=lambda r: r.start_date or "")],
        "teamNote": {"text": getattr(l, "team_note", "") or "", "by": by, "byName": (names or {}).get(by, by), "at": getattr(l, "team_note_at", "") or ""},
        "linkSource": getattr(l, "link_source", "") or "",
        "incomeType": (getattr(l, "income_type", "") or "lease") if (getattr(l, "income_type", "") or "lease") in INCOME_TYPES else "lease",
        **_term_out(l),
        **_frequency_out(l),
        "possiblyEnded": _stale_out(l),
    }


class RateBody(BaseModel):
    startDate: str
    rent: float = 0
    cam: Optional[float] = 0
    other: Optional[float] = 0
    note: Optional[str] = ""


class LeaseBody(BaseModel):
    propertyName: str
    region: Optional[str] = ""
    tenancy: Optional[str] = "external"
    landlord: Optional[str] = ""
    entityCode: Optional[str] = ""
    incomeAccounts: Optional[list[str]] = None
    customerId: Optional[str] = ""
    tenantName: Optional[str] = ""
    contactName: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    mailingAddress: Optional[str] = ""
    leaseStart: Optional[str] = ""
    leaseEnd: Optional[str] = ""
    securityDeposit: Optional[float] = 0
    leaseTerms: Optional[str] = ""
    lateFee: Optional[float] = 0
    dueDay: Optional[int] = 1
    graceDays: Optional[int] = 5
    status: Optional[str] = "active"
    notes: Optional[str] = ""
    rates: Optional[list[RateBody]] = None
    incomeType: Optional[str] = "lease"
    termType: Optional[str] = ""
    termMonths: Optional[float] = None   # checked to be a whole number in _clean_term
    # Oct 22: None (an older screen that does not send it) keeps what is saved.
    frequency: Optional[str] = None
    frequencyMonths: Optional[int] = None


def _clean(body: LeaseBody) -> dict:
    name = (body.propertyName or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name the property or space.")
    for label, v in (("Lease start", body.leaseStart), ("Lease end", body.leaseEnd)):
        if v and not _ISO.match(v):
            raise HTTPException(status_code=400, detail=f"{label} must be a date (YYYY-MM-DD).")
    if body.leaseStart and body.leaseEnd and body.leaseEnd < body.leaseStart:
        raise HTTPException(status_code=400, detail="The lease ends before it starts.")
    status = body.status if body.status in STATUSES else "active"
    kind = body.incomeType if body.incomeType in INCOME_TYPES else "lease"
    if status != "vacant" and not (body.tenantName or "").strip():
        raise HTTPException(status_code=400, detail="Name the tenant, or mark the space vacant." if kind in ("lease", "cam") else "Name who pays it.")
    due = int(body.dueDay or 1)
    if not 1 <= due <= 28:
        raise HTTPException(status_code=400, detail="The due day is between 1 and 28.")
    accounts = [str(a).strip() for a in (body.incomeAccounts or []) if str(a).strip()][:10] or list(DEFAULT_INCOME_ACCOUNTS)
    return {
        "property_name": name[:200], "region": (body.region or "")[:120], "tenancy": body.tenancy if body.tenancy in ("external", "internal") else "external",
        "landlord": (body.landlord or "")[:200], "entity_code": (body.entityCode or "").strip()[:40], "income_accounts": accounts,
        "customer_id": (body.customerId or "").strip()[:60], "tenant_name": (body.tenantName or "").strip()[:200],
        "contact_name": (body.contactName or "")[:200], "phone": (body.phone or "")[:60], "email": (body.email or "").strip()[:200],
        "mailing_address": (body.mailingAddress or "")[:300], "lease_start": body.leaseStart or "", "lease_end": body.leaseEnd or "",
        "security_deposit": float(body.securityDeposit or 0), "lease_terms": (body.leaseTerms or "")[:200], "late_fee": float(body.lateFee or 0),
        "due_day": due, "grace_days": max(0, min(int(body.graceDays if body.graceDays is not None else 5), 60)),
        "status": status, "notes": (body.notes or "")[:1000], "income_type": kind,
        **_clean_term(body),
        **_clean_frequency(body),
    }


def _clean_frequency(body) -> dict:
    """'' is stored for monthly, the value every row had before Oct 22, so a
    monthly source saves exactly as it always did."""
    if body.frequency is None:
        return {}
    freq = (body.frequency or "").strip() or "monthly"
    if freq not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="Frequency is monthly, quarterly, semi-annual, annual or custom.")
    months = int(body.frequencyMonths or 0)
    if freq == "custom" and not 1 <= months <= CUSTOM_MAX_MONTHS:
        raise HTTPException(status_code=400, detail=f"A custom frequency needs its period: every 1 to {CUSTOM_MAX_MONTHS} months.")
    return {"frequency": "" if freq == "monthly" else freq, "frequency_months": months if freq == "custom" else 0}


def _clean_rates(rates: Optional[list[RateBody]]) -> list[dict]:
    out, seen = [], set()
    for r in (rates or [])[:60]:
        if not _ISO.match(r.startDate or ""):
            raise HTTPException(status_code=400, detail="Each rent needs the date it starts (YYYY-MM-DD).")
        if r.startDate in seen:
            raise HTTPException(status_code=400, detail="Two rents start on the same date.")
        if min(r.rent or 0, r.cam or 0, r.other or 0) < 0:
            raise HTTPException(status_code=400, detail="Rent cannot be negative.")
        seen.add(r.startDate)
        out.append({"start_date": r.startDate, "rent": float(r.rent or 0), "cam": float(r.cam or 0), "other": float(r.other or 0), "note": (r.note or "")[:200]})
    return sorted(out, key=lambda r: r["start_date"])


# ── Who sees which leases ────────────────────────────────────────────────────
async def _reach(scope: dict) -> Optional[set]:
    """Entity codes the caller may read, or None when they are not limited."""
    if scope["allowed"] is None:
        return None
    return await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()


def _visible(leases: list, reach: Optional[set]) -> list:
    return leases if reach is None else [l for l in leases if (l.entity_code or "") in reach]


def _load_all() -> tuple[list, dict, dict]:
    leases, rates, months, _names = _load_all_named()
    return leases, rates, months


def _load_all_named() -> tuple[list, dict, dict, dict]:
    """The leases, their rents and months, and the names of the people who
    wrote the team notes (email -> display name)."""
    db = SessionLocal()
    try:
        leases = db.query(models.Lease).order_by(models.Lease.property_name, models.Lease.lease_start).all()
        rates: dict[str, list] = {}
        for r in db.query(models.LeaseRate).all():
            rates.setdefault(r.lease_id, []).append(r)
        months = {m.id: {"adjustment": _r2(m.adjustment), "note": m.note or ""} for m in db.query(models.LeaseMonth).all()}
        names = {e: accounting._display_name(e, db) for e in {l.team_note_by for l in leases if l.team_note_by}}
        db.expunge_all()
        return leases, rates, months, names
    finally:
        db.close()


# ── The Intacct customer behind a lease (Oct 6) ─────────────────────────────
_INACTIVE = ("inactive", "false", "f", "no", "closed", "disabled")
_SUFFIX = re.compile(r"\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc|the)\b")
_PARTNERS_DOWN: dict[str, float] = {}     # 'until': monotonic time to try the partners route again
_PARTNERS_RETRY = 600.0


def customer_active(status) -> bool:
    """Intacct's customer STATUS: anything but inactive is active (an unknown status too)."""
    return str(status or "").strip().lower() not in _INACTIVE


def norm_name(s: str) -> str:
    """A customer name as it is compared: case, punctuation, "&" and the
    company suffixes (Inc., LLC, Corp...) do not count."""
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return " ".join(_SUFFIX.sub(" ", s).split())


def _address_text(a) -> str:
    if isinstance(a, str):
        return a.strip()
    if not isinstance(a, dict):
        return ""
    city = ", ".join(x for x in (a.get("city") or "", " ".join(x for x in (a.get("state") or "", a.get("zip") or "") if x)) if x)
    return ", ".join(x for x in (a.get("line1") or "", a.get("line2") or "", city, a.get("country") or "") if x)


async def _partner_customers() -> list[dict]:
    """Intacct's customer records with their contact details, through the
    same source Accounting > Vendors & Customers reads (accounting_partners,
    contract V1). Tests replace this."""
    from routers import accounting_partners
    return [accounting_partners._record(p) for p in await accounting_partners._get({"kind": "customer"}) if isinstance(p, dict)]


async def customer_directory() -> dict[str, dict]:
    """code -> {code, name, status, active, phone, email, address, source}.
    The customer list on the ledger (code, name, and the status when the
    mirror sends it) overlaid with the full Intacct record where the
    accounting app serves it. Either source failing leaves the other; both
    failing is an empty directory - never an error on the screen."""
    out: dict[str, dict] = {}
    try:
        data = await accounting._acct_get("/api/internal/reports/dimensions", {"kind": "customer"})
        for v in data.get("values") or []:
            code = str(v.get("code") or "").strip()
            if code:
                st = v.get("status") or ""
                out[code] = {"code": code, "name": v.get("name") or "", "status": st, "active": customer_active(st), "phone": "", "email": "", "address": "", "source": "ledger"}
    except Exception:  # noqa: BLE001 - the directory is a best effort
        pass
    if _PARTNERS_DOWN.get("until", 0) <= time.monotonic():
        try:
            for r in await _partner_customers():
                code = (r.get("id") or "").strip()
                if not code:
                    continue
                cur = out.get(code) or {"code": code, "name": "", "status": "", "active": True, "phone": "", "email": "", "address": "", "source": "intacct"}
                cur.update({"name": r.get("displayName") or r.get("name") or cur["name"], "phone": r.get("phone") or "", "email": r.get("email") or "",
                            "address": _address_text(r.get("address")), "source": "intacct"})
                if r.get("status"):
                    cur["status"], cur["active"] = r["status"], customer_active(r["status"])
                out[code] = cur
        except Exception:  # noqa: BLE001 - not shipped yet (501) or down: names and codes still come from the ledger
            _PARTNERS_DOWN["until"] = time.monotonic() + _PARTNERS_RETRY
    return out


def customer_index(directory: dict[str, dict]) -> dict:
    names: dict[str, list[str]] = {}
    for code, c in directory.items():
        n = norm_name(c.get("name") or "")
        if n:
            names.setdefault(n, []).append(code)
    return {"exact": set(directory), "codes": {c.lower(): c for c in directory}, "names": names}


def resolve_customer(customer_id: str, tenant_name: str, index: dict) -> Optional[str]:
    """The Intacct customer code a lease should carry, or None to leave it as
    it is. A known code stays; a code in the wrong case is corrected; a NAME
    typed in the code box, or an empty code with the tenant's name, is
    matched by name - only when exactly one customer has that name."""
    cid = (customer_id or "").strip()
    if cid:
        if cid in index["exact"]:
            return cid
        hit = index["codes"].get(cid.lower())
        if hit:
            return hit
        named = index["names"].get(norm_name(cid)) or []
        return named[0] if len(named) == 1 else None
    named = index["names"].get(norm_name(tenant_name)) or []
    return named[0] if len(named) == 1 else None


def _apply_links(links: list[tuple[str, str]], who: str = "ledger-sync") -> None:
    if not links:
        return
    db = SessionLocal()
    try:
        now = _now()
        for lease_id, code in links:
            row = db.query(models.Lease).filter(models.Lease.id == lease_id).first()
            if row:
                row.customer_id, row.link_source, row.updated_by, row.updated_at = code, "auto-name", who, now
        db.commit()
    finally:
        db.close()


def links_for(leases: list[dict], index: dict) -> list[tuple[str, str]]:
    """(lease id, code) for every lease whose customer code should change."""
    out = []
    for l in leases:
        if l["status"] == "vacant":
            continue
        code = resolve_customer(l["customerId"], l["tenantName"], index)
        if code and code != l["customerId"]:
            out.append((l["id"], code))
    return out


async def autolink(leases: list[dict], directory: Optional[dict] = None) -> list[dict]:
    """Link the leases to their Intacct customers in place (the dicts change
    and the database is written); returns what was linked."""
    directory = directory if directory is not None else await customer_directory()
    if not directory:
        return []
    links = links_for(leases, customer_index(directory))
    if not links:
        return []
    await asyncio.to_thread(_apply_links, links)
    by_id = dict(links)
    done = []
    for l in leases:
        if l["id"] in by_id:
            done.append({"leaseId": l["id"], "propertyName": l["propertyName"], "tenantName": l["tenantName"], "from": l["customerId"], "customerId": by_id[l["id"]]})
            l["customerId"], l["linkSource"] = by_id[l["id"]], "auto-name"
    return done


async def _link_fields(fields: dict) -> dict:
    """A lease being saved without a known customer code gets one by name."""
    if fields.get("status") == "vacant" or not (fields.get("customer_id") or fields.get("tenant_name")):
        return fields
    directory = await customer_directory()
    if not directory:
        return fields
    code = resolve_customer(fields.get("customer_id") or "", fields.get("tenant_name") or "", customer_index(directory))
    if code and code != fields.get("customer_id"):
        return {**fields, "customer_id": code, "link_source": "auto-name"}
    return fields


# ── The arithmetic (pure) ────────────────────────────────────────────────────
def expected_for_month(lease: dict, year: int, month: int) -> Optional[float]:
    """What the lease expects for one calendar month, or None when the lease is
    not in force at all that month. Pro-rated by the day: a lease that starts
    on the 16th of a 30-day month expects half, and a rent that goes up on the
    1st of April is the new rent for all of April.

    Oct 7 (Charmi: Expected 2,201.61 against Received 22,750.00 for a 2,275 a
    month lease paid January to October): the first rent applies from the
    lease start even when its own start date is later. New Lease used to
    default the first rent's start to the day the lease was typed in, so a
    lease in force since January expected nothing until that day and 30/31
    of a month after it."""
    start, end = _d(lease["leaseStart"]), _d(lease["leaseEnd"])
    rates = lease["rates"]
    if not rates:
        return None
    if lease_step(lease) > 1:
        return _expected_periodic(lease, year, month, start, end)
    days = calendar.monthrange(year, month)[1]
    total, in_force = 0.0, 0
    for day in range(1, days + 1):
        today = date(year, month, day)
        if (start and today < start) or (end and today > end):
            continue
        rate = None
        for r in rates:                                   # sorted by start date
            if r["startDate"] <= today.isoformat():
                rate = r
        if rate is None and start:
            rate = rates[0]                               # in force from the lease start
        if rate is None:
            continue
        in_force += 1
        total += (rate["rent"] + rate["cam"] + rate["other"]) / days
    return _r2(total) if in_force else None


def due_this_month(lease: dict, year: int, month: int) -> bool:
    """Whether a source that is not monthly falls due this month: every
    lease_step months counted from the lease start month (else the first
    rent's month), like MRE's due_in_month. A monthly source is always due."""
    step = lease_step(lease)
    if step == 1:
        return True
    anchor = (lease.get("leaseStart") or (lease["rates"][0]["startDate"] if lease.get("rates") else "") or "")[:7]
    if not _MONTH.match(anchor):
        return True
    gap = (year * 12 + month - 1) - (int(anchor[:4]) * 12 + int(anchor[5:7]) - 1)
    return gap >= 0 and gap % step == 0


def _expected_periodic(lease: dict, year: int, month: int, start: Optional[date], end: Optional[date]) -> Optional[float]:
    """A quarterly / semi-annual / annual / custom source (Oct 22): None when
    it is not in force any day of the month, 0 in a month it does not fall
    due, else the whole amount in force on its first day in force that month
    (an amount per occurrence - not pro-rated)."""
    rates = lease["rates"]
    days = calendar.monthrange(year, month)[1]
    for day in range(1, days + 1):
        today = date(year, month, day)
        if (start and today < start) or (end and today > end):
            continue
        rate = None
        for r in rates:
            if r["startDate"] <= today.isoformat():
                rate = r
        if rate is None and start:
            rate = rates[0]
        if rate is None:
            continue
        if not due_this_month(lease, year, month):
            return 0.0
        return _r2(rate["rent"] + rate["cam"] + rate["other"])
    return None


_OPEN = ("short", "unpaid", "late", "due")


def apply_credits(cells: list[dict]) -> None:
    """A payment that covers more than one month (Oct 22, Charmi: 47385 RCR
    paid 7,025 in May - "It was paid for 2 months" - and March stayed a red 0
    with a 3,440 balance). What a month received above what it expected is a
    credit, and credits settle the OLDEST open month first (short, unpaid,
    late, still due), then the months ahead (prepaid). Only how each month
    reads changes: a month settled in full is 'covered' (coveredBy names the
    months whose payment settled it), a month part-settled keeps its status
    with `covered` showing how much. The stored receipts, each month's
    expected / received / balance, and so every Balance and total, are
    untouched - expected less received is the same sum either way. A row
    with no month paid over expected is left exactly as it was."""
    def counted(c):
        return c.get("inForce") and not c.get("outside") and c.get("status") not in ("upcoming", "unknown")
    sources = [[c, -c["balance"]] for c in cells if counted(c) and c.get("balance", 0) < -_PAID_WITHIN]
    if not sources:
        return
    past = [c for c in cells if counted(c) and c.get("status") in _OPEN and c.get("balance", 0) > _PAID_WITHIN]
    ahead = [c for c in cells if c.get("inForce") and not c.get("outside") and c.get("status") == "upcoming" and c.get("balance", 0) > _PAID_WITHIN]
    for c in past + ahead:
        need, got, by = c["balance"], 0.0, []
        for src in sources:
            if need - got <= 0.005:
                break
            if src[1] <= 0.005:
                continue
            t = _r2(min(src[1], need - got))
            src[1] = _r2(src[1] - t)
            got = _r2(got + t)
            by.append(src[0]["month"])
            src[0]["appliedTo"] = [*src[0].get("appliedTo", []), c["month"]]
            src[0]["applied"] = _r2(src[0].get("applied", 0) + t)
        if not got:
            break
        c["covered"], c["coveredBy"] = got, by
        if got >= need - _PAID_WITHIN:
            if c["status"] == "upcoming":
                c["prepaid"] = True
            else:
                c["status"], c["lateFee"] = "covered", 0


def month_status(expected: float, received: float, lease: dict, year: int, month: int, today: date) -> str:
    """paid | short | unpaid | late | due | upcoming | none."""
    this = (today.year, today.month)
    if (year, month) > this:
        return "upcoming"
    if expected <= _PAID_WITHIN and received <= _PAID_WITHIN:
        return "none"
    if received >= expected - _PAID_WITHIN:
        return "paid"
    if (year, month) == this:
        if today.day <= (lease["dueDay"] or 1) + (lease["graceDays"] or 0):
            return "due"
        return "short" if received > _PAID_WITHIN else "late"
    return "short" if received > _PAID_WITHIN else "unpaid"


def rent_roll(leases: list[dict], months: dict, receipts: dict, year: int, today: date) -> dict:
    """The year, lease by lease and month by month. `receipts` is
    {(customer_id, 'YYYY-MM'): {gl_code: credit - debit}} for a tenant read
    consolidated, {(entity_code, customer_id, 'YYYY-MM'): ...} for one read per
    entity (see _receipts); `months` is {'<lease_id>:<YYYY-MM>': {adjustment, note}}."""
    rows = []
    totals = [{"month": f"{year}-{m:02d}", "expected": 0.0, "received": 0.0} for m in range(1, 13)]
    for lease in leases:
        cells, to_date, outside = [], 0.0, []
        for m in range(1, 13):
            key = f"{year}-{m:02d}"
            extra = months.get(f"{lease['id']}:{key}") or {"adjustment": 0, "note": ""}
            base = expected_for_month(lease, year, m)
            cid = lease["customerId"]
            posted = (receipts.get((lease.get("entityCode", ""), cid, key)) or receipts.get((cid, key), {})) if cid else {}
            by_account = {code: _r2(v) for code, v in posted.items() if code in lease["incomeAccounts"]}
            received = _r2(sum(by_account.values()))
            if base is None and abs(received) <= _PAID_WITHIN and not extra["note"]:
                cells.append({"month": key, "inForce": False})
                continue
            if base is None:
                # Oct 7: money posted in a month the lease is not in force
                # (before its start, after its end) is shown, never counted -
                # it used to count as received against nothing expected and
                # read as a 20.5K "prepayment" credit. It usually means the
                # Lease Start is wrong; the row says so.
                if abs(received) > _PAID_WITHIN:
                    outside.append({"month": key, "received": received})
                cells.append({"month": key, "inForce": True, "outside": True, "expected": 0, "received": received, "byAccount": by_account, "balance": 0,
                              "status": "outside", "adjustment": extra["adjustment"], "note": extra["note"], "lateFee": 0})
                continue
            expected = _r2(max(0.0, (base or 0) - extra["adjustment"]))
            status = month_status(expected, received, lease, year, m, today)
            balance = _r2(expected - received)
            if status not in ("upcoming",):
                to_date = _r2(to_date + balance)
                totals[m - 1]["expected"] = _r2(totals[m - 1]["expected"] + expected)
                totals[m - 1]["received"] = _r2(totals[m - 1]["received"] + received)
            cell = {"month": key, "inForce": True, "expected": expected, "received": received, "byAccount": by_account, "balance": balance, "status": status,
                    "adjustment": extra["adjustment"], "note": extra["note"],
                    "lateFee": _r2(lease["lateFee"]) if status in ("late", "short", "unpaid") and lease["lateFee"] else 0}
            if lease_step(lease) > 1 and not due_this_month(lease, year, m):
                cell["offCycle"] = True       # Oct 22: in force, but not a month it falls due
            cells.append(cell)
        apply_credits(cells)
        behind = [c for c in cells if c.get("status") in ("late", "short", "unpaid")]
        rows.append({"lease": lease, "months": cells, "balanceToDate": to_date, "monthsBehind": len(behind),
                     "owed": _r2(sum(c["balance"] - c.get("covered", 0) for c in behind)), "lateFees": _r2(sum(c["lateFee"] for c in behind)),
                     "outsideLease": {"months": [o["month"] for o in outside], "received": _r2(sum(o["received"] for o in outside))}})
    return {"year": year, "asOf": today.isoformat(), "rows": rows, "totals": totals,
            "summary": {"leases": len([r for r in rows if r["lease"]["status"] == "active"]),
                        "behind": len([r for r in rows if r["monthsBehind"]]),
                        "owed": _r2(sum(r["owed"] for r in rows)),
                        "balance": _r2(sum(r["balanceToDate"] for r in rows)),
                        "expectedToDate": _r2(sum(t["expected"] for t in totals)),
                        "receivedToDate": _r2(sum(t["received"] for t in totals))}}


async def _receipts(scope: dict, leases: list[dict], year: int, every: Optional[list] = None) -> dict:
    """What each tenant posted to the leases' income accounts, month by month.

    One consolidated /by-customer read for tenants whose leases all sit on one
    entity. The accounting app reads that report across EVERY entity, so a
    tenant renting on two entities (one Intacct customer, two leases, the same
    income account) would show both entities' rent as received on each lease -
    those tenants get one month read per entity instead (keyed with the entity;
    rent_roll looks that key up first). `every` is the whole lease table (ORM
    rows), so a tenant counts as multi-entity even when the caller cannot see
    the other lease. An entity-limited caller reads per entity for every lease:
    the consolidated report would carry postings from entities outside their
    limit."""
    out: dict = {}
    if not leases:
        return out
    entities_of: dict[str, set] = {}
    for l in (every if every is not None else []):
        if l.customer_id:
            entities_of.setdefault(l.customer_id, set()).add(l.entity_code or "")
    for l in leases:
        if l["customerId"]:
            entities_of.setdefault(l["customerId"], set()).add(l["entityCode"])
    limited = scope.get("allowed") is not None
    split = {c for c, codes in entities_of.items() if limited or len(codes) > 1}

    async def entity_read(code: str, cust: str) -> dict:
        location, _ = await accounting._limit(scope, code, None)    # 403 for an entity outside the caller's reach
        return await accounting._acct_get("/api/internal/reports/buckets", {
            "from": f"{year}-01-01", "to": f"{year}-12-31", "by": "month", "location": location, "customer": cust})

    pairs = list(dict.fromkeys((l["entityCode"], l["customerId"]) for l in leases if l["customerId"] and l["customerId"] in split))
    for (code, cust), data in zip(pairs, await asyncio.gather(*[entity_read(code, cust) for code, cust in pairs])):
        for r in data.get("rows") or []:
            if not r.get("bucket") or r.get("account_no") is None:
                continue
            cell = out.setdefault((code, cust, str(r["bucket"])[:7]), {})
            acct = str(r["account_no"])
            cell[acct] = _r2(cell.get(acct, 0) + (r.get("credit") or 0) - (r.get("debit") or 0))

    customers = sorted({l["customerId"] for l in leases if l["customerId"] and l["customerId"] not in split})
    accounts = sorted({a for l in leases for a in l["incomeAccounts"]})
    # 400 customers a call is the accounting app's limit; nobody has that many tenants, but the loop is cheap.
    for i in range(0, len(customers), 300):
        data = await accounting._acct_get("/api/internal/reports/by-customer", {
            "from": f"{year}-01-01", "to": f"{year}-12-31", "customers": ",".join(customers[i:i + 300]), "accounts": ",".join(accounts)})
        for r in data.get("rows") or []:
            cell = out.setdefault((r["customer"], r["month"]), {})
            cell[r["account_no"]] = _r2(cell.get(r["account_no"], 0) + (r.get("credit") or 0) - (r.get("debit") or 0))
    return out


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/leases")
async def list_leases(scope: dict = Depends(entity_scope)):
    leases, rates, _, names = await asyncio.to_thread(_load_all_named)
    reach = await _reach(scope)
    return [_lease_out(l, rates.get(l.id, []), names) for l in _visible(leases, reach)]


def _csv(v: Optional[str]) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def expired(lease: dict, today: date) -> bool:
    """An ended lease, or one whose end date has passed."""
    return lease["status"] == "ended" or bool(lease["leaseEnd"] and lease["leaseEnd"] < today.isoformat())


@router.get("/rent-roll")
async def get_rent_roll(year: Optional[int] = None, entities: Optional[str] = None, customers: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """Expected against received, every lease, every month of one year.
    `entities` (codes, each with its sub-entities) and `customers` (codes)
    narrow it. Each row says whether the lease has expired and whether its
    customer is still active in Intacct, with the customer's record."""
    today = date.today()
    year = year or today.year
    if not 2000 <= year <= today.year + 1:
        raise HTTPException(status_code=400, detail="Pick a year up to next year.")
    leases, rates, months, names = await asyncio.to_thread(_load_all_named)
    reach = await _reach(scope)
    shown = [_lease_out(l, rates.get(l.id, []), names) for l in _visible(leases, reach)]
    asked = _csv(entities)
    if asked:
        await accounting._limit(scope, None, ",".join(asked))       # 403 for an entity outside the caller's reach
        within = await accounting._with_children(set(asked))
        shown = [l for l in shown if l["entityCode"] in within]
    directory = await customer_directory()
    linked = await autolink(shown, directory)
    picked = set(_csv(customers))
    if picked:
        shown = [l for l in shown if l["customerId"] in picked]
    warning = ""
    try:
        receipts = await _receipts(scope, shown, year, every=leases)
    except HTTPException as e:
        # The leases and what they expect are Nexus's own; the ledger being
        # unreachable must not blank the screen. Say so, and show zero received.
        receipts, warning = {}, f"Payments could not be read from the ledger ({e.detail}). Expected rent is shown; received is not."
    out = rent_roll(shown, months, receipts, year, today)
    for r in out["rows"]:
        c = directory.get(r["lease"]["customerId"]) if r["lease"]["customerId"] else None
        r["customer"] = c
        r["customerActive"] = c["active"] if c else True
        r["expired"] = expired(r["lease"], today)
    out["summary"].update({"inactive": sum(1 for r in out["rows"] if not r["customerActive"]), "expired": sum(1 for r in out["rows"] if r["expired"])})
    out["linked"] = linked
    out["customerDetails"] = any(c.get("source") == "intacct" for c in directory.values())
    if warning:
        out["warning"] = warning
        for r in out["rows"]:
            for c in r["months"]:
                if c.get("inForce") and c["status"] != "upcoming":
                    c["status"] = "unknown"
            r["monthsBehind"], r["owed"], r["lateFees"], r["balanceToDate"] = 0, 0, 0, 0
        out["summary"].update({"behind": 0, "owed": 0, "balance": 0})
    return out


@router.get("/customers")
async def customers(scope: dict = Depends(entity_scope)):
    """Intacct customers, for picking the tenant (with the status when known).
    A person limited to certain entities gets only the customers of the
    leases they may read - the same rule as one customer's record below."""
    data = await accounting._acct_get("/api/internal/reports/dimensions", {"kind": "customer"})
    reach = await _reach(scope)
    if reach is not None:
        leases, _, _ = await asyncio.to_thread(_load_all)
        mine = {l.customer_id for l in _visible(leases, reach) if l.customer_id}
        data = {"values": [v for v in data.get("values") or [] if v.get("code") in mine]}
    contacts = await _partner_contacts()
    return {"customers": [{"code": v["code"], "name": v.get("name") or "", "status": v.get("status") or "", "active": customer_active(v.get("status")),
                           **contacts.get(v["code"], {"phone": "", "email": "", "address": ""})} for v in data.get("values") or []]}


async def _partner_contacts() -> dict[str, dict]:
    """code -> {phone, email, address} from Intacct's customer records (Charmi,
    Oct 15: picking the tenant fills the lease form's empty contact fields).
    Read-only, through the same cached partners read as the customer card;
    the accounting app sends no contact person, so Primary Contact is not
    filled. Down or not shipped: no contacts, never an error."""
    if _PARTNERS_DOWN.get("until", 0) > time.monotonic():
        return {}
    out: dict[str, dict] = {}
    try:
        for r in await _partner_customers():
            code = (r.get("id") or "").strip()
            if code:
                out[code] = {"phone": r.get("phone") or "", "email": r.get("email") or "", "address": _address_text(r.get("address"))}
    except Exception:  # noqa: BLE001 - names and codes still come from the ledger
        _PARTNERS_DOWN["until"] = time.monotonic() + _PARTNERS_RETRY
    return out


@router.get("/customers/{code}")
async def customer_detail(code: str, scope: dict = Depends(entity_scope)):
    """One tenant's customer record (Charmi, 10/04: hovering the tenant's name
    shows the name, telephone, address and email): Intacct's record where the
    accounting app serves it, else what the lease itself keeps, with the
    leases the caller may read. A person limited to certain entities reads
    only the customers of their own leases."""
    code = (code or "").strip()
    leases, rates, _, names = await asyncio.to_thread(_load_all_named)
    reach = await _reach(scope)
    mine = [_lease_out(l, rates.get(l.id, []), names) for l in _visible(leases, reach) if (l.customer_id or "") == code]
    if reach is not None and not mine:
        raise HTTPException(status_code=403, detail="Your accounting access does not include that customer.")
    c = (await customer_directory()).get(code)
    if not c and not mine:
        raise HTTPException(status_code=404, detail="Customer not found.")
    c = {**(c or {"code": code, "name": "", "status": "", "active": True, "phone": "", "email": "", "address": "", "source": "lease"}), "contactName": ""}
    # What the lease keeps fills what Intacct did not send - the active lease first.
    for l in sorted(mine, key=lambda x: (x["status"] != "active", x["leaseStart"])):
        for k, v in (("name", l["tenantName"]), ("phone", l["phone"]), ("email", l["email"]), ("address", l["mailingAddress"]), ("contactName", l["contactName"])):
            if not c.get(k) and v:
                c[k] = v
    c["leases"] = [{"id": l["id"], "propertyName": l["propertyName"], "entityCode": l["entityCode"], "status": l["status"], "leaseStart": l["leaseStart"], "leaseEnd": l["leaseEnd"]} for l in mine]
    return c


async def _must_reach(scope: dict, entity_code: str) -> None:
    reach = await _reach(scope)
    if reach is not None and (entity_code or "") not in reach:
        raise HTTPException(status_code=403, detail="Your accounting access does not include that entity.")


def _save_lease(lease_id: Optional[str], fields: dict, rates: Optional[list[dict]], user: dict, replaces: str = "", end_previous: str = "") -> dict:
    db = SessionLocal()
    try:
        now = _now()
        if lease_id:
            row = db.query(models.Lease).filter(models.Lease.id == lease_id).first()
            if not row:
                raise HTTPException(status_code=404, detail="Lease not found.")
        else:
            row = models.Lease(id=str(uuid.uuid4()), property_name="", created_by=user["email"], created_at=now, replaces_id=replaces)
            db.add(row)
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_by, row.updated_at = user["email"], now
        if rates is not None:
            db.query(models.LeaseRate).filter(models.LeaseRate.lease_id == row.id).delete(synchronize_session=False)
            for r in rates:
                db.add(models.LeaseRate(id=str(uuid.uuid4()), lease_id=row.id, **r))
        if replaces:
            old = db.query(models.Lease).filter(models.Lease.id == replaces).first()
            if old:
                old.status = "ended"
                if end_previous and (not old.lease_end or old.lease_end > end_previous):
                    old.lease_end = end_previous
                old.updated_by, old.updated_at = user["email"], now
        db.commit()
        kept = db.query(models.LeaseRate).filter(models.LeaseRate.lease_id == row.id).all()
        return _lease_out(row, kept)
    finally:
        db.close()


@router.post("/leases", status_code=201)
async def create_lease(body: LeaseBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = await _link_fields(_clean(body))
    await _must_reach(scope, fields["entity_code"])
    return await asyncio.to_thread(_save_lease, None, fields, _clean_rates(body.rates), user)


def _entity_of(lease_id: str) -> str:
    db = SessionLocal()
    try:
        row = db.query(models.Lease).filter(models.Lease.id == lease_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Lease not found.")
        return row.entity_code or ""
    finally:
        db.close()


@router.put("/leases/{lease_id}")
async def update_lease(lease_id: str, body: LeaseBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = await _link_fields(_clean(body))
    await _must_reach(scope, await asyncio.to_thread(_entity_of, lease_id))
    await _must_reach(scope, fields["entity_code"])
    return await asyncio.to_thread(_save_lease, lease_id, fields, _clean_rates(body.rates) if body.rates is not None else None, user)


class ReplaceBody(LeaseBody):
    movedOut: Optional[str] = ""   # the last day of the tenant who is leaving


@router.post("/leases/{lease_id}/replace", status_code=201)
async def replace_tenant(lease_id: str, body: ReplaceBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """A new tenant in the same space. The old lease is ended, never
    overwritten, and the new one points back at it."""
    fields = await _link_fields(_clean(body))
    if body.movedOut and not _ISO.match(body.movedOut):
        raise HTTPException(status_code=400, detail="The move-out date must be a date (YYYY-MM-DD).")
    await _must_reach(scope, await asyncio.to_thread(_entity_of, lease_id))
    await _must_reach(scope, fields["entity_code"])
    return await asyncio.to_thread(_save_lease, None, fields, _clean_rates(body.rates), user, lease_id, body.movedOut or "")


class MonthBody(BaseModel):
    adjustment: Optional[float] = 0
    note: Optional[str] = ""


@router.put("/leases/{lease_id}/months/{month}")
async def set_month(lease_id: str, month: str, body: MonthBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """An agreed deduction for one month, and the note that explains it."""
    if not _MONTH.match(month):
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    if (body.adjustment or 0) < 0:
        raise HTTPException(status_code=400, detail="A deduction cannot be negative.")
    await _must_reach(scope, await asyncio.to_thread(_entity_of, lease_id))

    def work():
        db = SessionLocal()
        try:
            key = f"{lease_id}:{month}"
            row = db.query(models.LeaseMonth).filter(models.LeaseMonth.id == key).first()
            note, adj = (body.note or "").strip()[:600], float(body.adjustment or 0)
            if not note and not adj:
                if row:
                    db.delete(row)
                    db.commit()
                return {"month": month, "adjustment": 0, "note": ""}
            if not row:
                row = models.LeaseMonth(id=key, lease_id=lease_id, month=month)
                db.add(row)
            row.adjustment, row.note, row.updated_by, row.updated_at = adj, note, user["email"], _now()
            db.commit()
            return {"month": month, "adjustment": _r2(adj), "note": note}
        finally:
            db.close()
    return await asyncio.to_thread(work)


class NoteBody(BaseModel):
    note: Optional[str] = ""


@router.put("/leases/{lease_id}/note")
async def set_note(lease_id: str, body: NoteBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """The team's note on a lease - the rent roll's Notes column (Charmi,
    10/04). One note per lease, edited in place, with who wrote it and when."""
    await _must_reach(scope, await asyncio.to_thread(_entity_of, lease_id))

    def work():
        db = SessionLocal()
        try:
            row = db.query(models.Lease).filter(models.Lease.id == lease_id).first()
            if not row:
                raise HTTPException(status_code=404, detail="Lease not found.")
            text = (body.note or "").strip()[:1000]
            row.team_note, row.team_note_by, row.team_note_at = text, (user["email"] if text else ""), (_now() if text else "")
            db.commit()
            return {"text": row.team_note, "by": row.team_note_by, "byName": accounting._display_name(row.team_note_by, db) if row.team_note_by else "", "at": row.team_note_at}
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.delete("/leases/{lease_id}", status_code=204)
async def delete_lease(lease_id: str, user: dict = Depends(_full), scope: dict = Depends(entity_scope)):
    """For a lease entered by mistake. A tenant who left is ENDED, not deleted."""
    await _must_reach(scope, await asyncio.to_thread(_entity_of, lease_id))

    def work():
        db = SessionLocal()
        try:
            db.query(models.LeaseRate).filter(models.LeaseRate.lease_id == lease_id).delete(synchronize_session=False)
            db.query(models.LeaseMonth).filter(models.LeaseMonth.lease_id == lease_id).delete(synchronize_session=False)
            db.query(models.Lease).filter(models.Lease.id == lease_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(work)
