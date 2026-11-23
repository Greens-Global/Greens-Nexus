"""Operations > Reports: Cubby's report list, interactive (Neil, Ops review, Oct 20 2026).

Cubby's own Reports page exports Excel or PDF - a summary you cannot click
into. Here every report is a table: a facility and a period, sortable,
searchable, a tenant name opens their units, payments, balance and ledger, a
unit opens its history, and the CSV is what is on screen.

Where each report comes from (CATALOG says it per report):
  cubby      - one of Cubby's own reports/* endpoints. Rent roll and aged
               receivables are already copied into the cubby_* tables every
               15 minutes (cubby_sync.py). The general ledgers (cash and
               accrual), merchant services disbursements and lease compliance
               are read here, per facility and month, and kept in
               ops_report_cache (below).
  nexus      - Cubby has no API for it (occupancy statistics, vacant units,
               management summary, move-in/move-out detail, payment detail,
               receipts summary, leads activity), so it is built from the
               rows the sync already keeps.
  unavailable- neither: listed so nobody hunts for it (inventory activity -
               Cubby's API has the product catalog but no sales or stock
               movements).

Every result also carries `summary` (3-6 headline figures), `facilities`
(one, several via `facility_ids`, or all) and the `options` it ran with
(REPORT_OPTIONS whitelists them per report; the catalog describes them so
the screen can draw them). Accounts Receivable (`ar-activity`) rolls each
lease's balance from the accrual ledger; the old `accounts-receivable` key
is Aged Receivables (ALIASES).

Cache (data volume): Cubby has no paging and a month of ledger lines is a big
answer, so a (report, facility, month) answer is kept in ops_report_cache.
The current month is re-read after CURRENT_TTL, the month before for a few
days after it closes (late postings), anything older is kept. A failed
re-read serves the last good copy with a note. One Cubby call per key at a
time; several keys run FETCH_WORKERS at once. Everything here is blocking -
the router runs it in a thread (CLAUDE.md).

Privacy (same rule as the existing exports): tenant name, unit and money only.
Rows are built from whitelisted fields, never by passing a Cubby row through,
and every Cubby answer is cleaned (cubby_sync.strip_pii + card/check digits)
before it is cached. No phone, email or address in any report or export.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

import httpx

import cubby
import cubby_sync

CURRENT_TTL = 30 * 60            # the current month's ledger / disbursements
RECENT_TTL = 6 * 3600            # last month, for RECENT_DAYS after it closed
RECENT_DAYS = 5
COMPLIANCE_TTL = 6 * 3600
LEDGER_TTL = 10 * 60             # a tenant's ledger, in this worker's memory
FETCH_WORKERS = 5
MAX_LIVE_MONTHS = 12             # a ledger report spans at most a year of months
MAX_ROWS = 20000                 # a ledger detail report stops here and says so
COMPLIANCE_BATCH = 100

NOT_CONNECTED = cubby_sync.NOT_CONFIGURED
_DIGITS = {"cardlastfour", "lastfour", "checknumber", "accountnumber", "routingnumber"}

CATEGORIES = ["Rent and Occupancy", "Receivables and Collections", "Receipts and Accounting", "Coverage", "Activity"]

# key: (title, category, what it is, source, uses the period)
CATALOG = {
    "facility-portfolio": ("Facility Portfolio", "Rent and Occupancy",
                           "One line per facility: occupancy, rent roll, delinquency, autopay and coverage now, plus receipts, "
                           "moves and leads over the period, with a portfolio total.", "nexus", True),
    "rent-roll": ("Rent Roll", "Rent and Occupancy",
                  "Every unit: status, tenant, street rate, rent, paid-through date, autopay, overlock and balance.", "cubby", False),
    "occupancy-statistics": ("Occupancy Statistics", "Rent and Occupancy",
                             "Occupied and vacant units, area and rent by unit type (pricing group).", "nexus", False),
    "gross-potential": ("Gross Potential Analysis", "Rent and Occupancy",
                        "Actual against potential rent by unit type: vacancy loss, rate variance and economic occupancy, "
                        "with the units behind every line.", "nexus", False),
    "vacant-units": ("Vacant Units", "Rent and Occupancy",
                     "Every unit not rented: size, type, street rate, why it is off the market and how long it has been empty.", "nexus", False),
    "management-summary": ("Management Summary", "Rent and Occupancy",
                           "One line per facility: occupancy, rent, moves and receipts for the period and year to date, past due, leads.", "nexus", True),
    "historical-management-summary": ("Historical Management Summary", "Rent and Occupancy",
                                      "Management figures split by day, week, month, quarter or year: occupancy at each period end, "
                                      "moves, receipts and leads, one line per facility and period.", "nexus", True),
    "ar-activity": ("Accounts Receivable", "Receivables and Collections",
                    "Every change to what tenants owe in the period - charges, payments, waivers, discounts, refunds - "
                    "rolled from the beginning to the ending balance, lease by lease.", "cubby", True),
    "aged-receivables": ("Aged Receivables", "Receivables and Collections",
                         "Every lease that owes money, its balance split into 30, 60, 90 and 120-day buckets.", "cubby", False),
    "balances-summary": ("Balances Summary", "Receivables and Collections",
                         "Receivables, prepaid rent, deposits and credits held per facility through a selected date, "
                         "tenant by tenant.", "cubby", False),
    "credits-issued": ("Credits Issued", "Receivables and Collections",
                       "Every credit given and every rent, fee or damage charge waived in the period: facility, tenant, unit, "
                       "amount, date and the reason Cubby recorded.", "cubby", True),
    "payment-detail": ("Payment Detail", "Receivables and Collections",
                       "Every payment in the period: tenant, units, method, status and amount.", "nexus", True),
    "receipts-summary": ("Receipts Summary", "Receivables and Collections",
                         "Money received in the period by payment method, with failed and refunded payments counted.", "nexus", True),
    "merchant-disbursements": ("Merchant Services Disbursements", "Receivables and Collections",
                               "Card and ACH payouts to the bank by batch, with the payments in each batch.", "cubby", True),
    "receipts-by-charge-type": ("Receipts by Charge Type", "Receipts and Accounting",
                                "Cash basis: what the money received paid for - rent, fees, insurance, tax, deposits, prepaid.", "cubby", True),
    "receipts-by-tax-category": ("Receipts by Tax Category", "Receipts and Accounting",
                                 "Cash basis: tax collected by tax and rate, with the receipts it was collected on.", "cubby", True),
    "general-ledger-cash": ("General Ledger (Cash)", "Receipts and Accounting",
                            "Cubby's cash basis journal, line by line, for the period.", "cubby", True),
    "general-ledger-accrual": ("General Ledger (Accrual)", "Receipts and Accounting",
                               "Cubby's accrual basis journal, line by line, with tax category and GL mapping.", "cubby", True),
    "coverage-roll": ("Coverage Roll", "Coverage",
                      "Every lease with tenant protection coverage at any point in the period: plan, coverage amount, "
                      "premium and start date.", "nexus", True),
    "coverage-activity": ("Coverage Activity", "Coverage",
                          "Leases with coverage money moving in the period: premium charged, paid and returned (refunds and "
                          "failed payments). Enrolled leases with no activity are left out.", "cubby", True),
    "move-in-move-out-detail": ("Move-In / Move-Out Detail", "Activity",
                                "Every move-in and move-out in the period with unit, tenant, rent and length of stay.", "nexus", True),
    "leads-activity": ("Leads Activity", "Activity",
                       "Leads created in the period: status (reserved, converted, lost), source and target move-in.", "nexus", True),
    "lease-compliance": ("Lease Compliance", "Activity",
                         "Active leases with incomplete documents: lease agreement, coverage, ID, vehicle.", "cubby", False),
    "inventory-activity": ("Inventory Activity", "Activity",
                           "Retail sales and stock movements. Not Available From Cubby Yet: Cubby's API lists the product "
                           "catalog but no sales or stock movements.", "unavailable", True),
}


# An old key the screen or a saved link may still use -> the report it is now.
ALIASES = {"accounts-receivable": "aged-receivables"}

# Point in time "through a selected date": the period's `end` is that date
# (the screen shows one date picker); `period` stays false.
DATE_REPORTS = {"balances-summary"}

# The options a report takes (the whitelist): run() drops anything else.
OPTION_DEFS = {
    "occupiedOnly": {"label": "Show Only Occupied Units", "type": "bool", "default": False,
                     "help": "Leaves vacant and off-market units out."},
    "ignoreParking": {"label": "Ignore Parking Units", "type": "bool", "default": False,
                      "help": "Leaves out units whose unit type is parking (the pricing group name says Parking)."},
    "ignoreBadDebt": {"label": "Ignore Bad Debt", "type": "bool", "default": False,
                      "help": "Leaves out every journal that touches the Bad Debt account (write-offs and their recoveries)."},
    "includePrivate": {"label": "Include Private Policies", "type": "bool", "default": False,
                       "help": "Also lists leases covered by the tenant's own insurance policy instead of the facility plan."},
    "excludeMailboxes": {"label": "Exclude Mailboxes", "type": "bool", "default": False,
                         "help": "Leaves out units whose unit type is a mailbox (Settings > Operations > Unit Classes)."},
    "excludeNonStandard": {"label": "Exclude Non-Standard Units", "type": "bool", "default": False,
                           "help": "Leaves out units that are not storage anyone shops for: $0 Business Class, the dump station, "
                                   "residential and commercial units, utility rooms, and any unit at $1 or less."},
    "includeDiscounts": {"label": "Include Discounts and Promotions", "type": "bool", "default": False,
                         "help": "Also lists the discounts promotions took off rent. They are applied by the promotion, "
                                 "not issued by anyone."},
    "split": {"label": "Split By", "type": "select", "default": "month",
              "choices": [{"value": "day", "label": "Day"}, {"value": "week", "label": "Week"}, {"value": "month", "label": "Month"},
                          {"value": "quarter", "label": "Quarter"}, {"value": "year", "label": "Year"}],
              "help": "One line per facility for every period of this length."},
}
REPORT_OPTIONS = {
    "facility-portfolio": ["ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "rent-roll": ["occupiedOnly", "excludeMailboxes", "excludeNonStandard"],
    "occupancy-statistics": ["ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "gross-potential": ["ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "vacant-units": ["ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "management-summary": ["ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "historical-management-summary": ["split", "ignoreParking", "excludeMailboxes", "excludeNonStandard"],
    "credits-issued": ["includeDiscounts"],
    "receipts-by-charge-type": ["ignoreBadDebt"],
    "receipts-by-tax-category": ["ignoreBadDebt"],
    "general-ledger-cash": ["ignoreBadDebt"],
    "coverage-roll": ["includePrivate"],
}


def catalog() -> dict:
    return {"categories": CATEGORIES,
            "reports": [{"key": k, "title": t, "category": c, "about": a, "source": s, "period": p,
                         "pointInTime": k in DATE_REPORTS,
                         "options": [{"key": o, **OPTION_DEFS[o]} for o in REPORT_OPTIONS.get(k, [])]}
                        for k, (t, c, a, s, p) in CATALOG.items()],
            "aliases": dict(ALIASES), "presets": preset_catalog()}


def parse_options(kind: str, raw: dict | None) -> dict:
    """The report's options with their defaults, from whatever the caller sent
    (query strings or real values). Keys the report does not take are dropped."""
    raw = raw or {}
    out = {}
    for key in REPORT_OPTIONS.get(kind, []):
        spec = OPTION_DEFS[key]
        v = raw.get(key, spec["default"])
        if spec["type"] == "bool":
            if isinstance(v, str):
                s = v.strip().lower()
                if s not in ("", "true", "false", "1", "0", "yes", "no", "on", "off"):
                    raise ReportError(422, f"{spec['label']} is true or false")
                v = s in ("true", "1", "yes", "on")
            out[key] = bool(v)
        else:
            v = str(v or spec["default"]).strip().lower()
            if v not in {c["value"] for c in spec["choices"]}:
                raise ReportError(422, f"{spec['label']} must be one of: {', '.join(c['label'] for c in spec['choices'])}")
            out[key] = v
    return out


class ReportError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── Small helpers ─────────────────────────────────────────────────────────────

def _col(key, label, type_="text", total=False):
    return {"key": key, "label": label, "type": type_, "total": total}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_day(v) -> str:
    s = str(v or "")[:10]
    return s if len(s) == 10 and s[4] == "-" else ""


def _pct(part, whole):
    return round(part / whole * 100, 1) if whole else None


def _tidy(v: str) -> str:
    v = str(v or "")
    return " ".join(w.capitalize() for w in v.split("_")) if v.isupper() or "_" in v else v


def _clean(value):
    """A Cubby answer without contact / identity fields or card and check digits."""
    value = cubby_sync.strip_pii(value)

    def drop(v):
        if isinstance(v, dict):
            return {k: drop(x) for k, x in v.items() if str(k).lower().replace("_", "") not in _DIGITS}
        if isinstance(v, list):
            return [drop(x) for x in v]
        return v
    return drop(value)


def parse_period(start: str, end: str, today: date) -> tuple[str, str]:
    """(start, end) as YYYY-MM-DD, defaulting to this month to date."""
    try:
        a = date.fromisoformat(start) if start else today.replace(day=1)
        b = date.fromisoformat(end) if end else today
    except ValueError:
        raise ReportError(422, "Dates must be real calendar dates") from None
    if a > b:
        raise ReportError(422, "The period starts after it ends")
    if (b - a).days > 3 * 366:
        raise ReportError(422, "A period can cover three years at most")
    return a.isoformat(), b.isoformat()


def months_between(start: str, end: str) -> list[str]:
    y, m = int(start[:4]), int(start[5:7])
    out = []
    while f"{y:04d}-{m:02d}" <= end[:7]:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# ── The database side (rows cubby_sync keeps) ─────────────────────────────────

def _facilities(db, ids: list[str] | None) -> list[dict]:
    import models as m
    q = db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True))
    out = []
    every = q.all()
    if ids and set(ids) - {f.facility_id for f in every}:
        raise ReportError(404, "Facility not found")
    for f in every:
        if ids and f.facility_id not in ids:
            continue
        fac = {**(f.data or {}), "facilityId": f.facility_id, "name": f.name or "", "timeZone": f.time_zone or cubby.DEFAULT_TZ}
        out.append({"id": f.facility_id, "name": f.name or "", "short": cubby._short(fac), "today": cubby._facility_today(fac),
                    "syncedAt": f.synced_at or ""})
    out.sort(key=lambda f: f["short"])
    if ids and not out:
        raise ReportError(404, "Facility not found")
    return out


class Data:
    """The synced rows for some facilities, read once per report. Blocking."""

    def __init__(self, db, facility_ids: list[str] | None = None, opts: dict | None = None):
        import models as m
        self.db = db
        self.facs = _facilities(db, facility_ids)
        self.ids = [f["id"] for f in self.facs]
        self.fac = {f["id"]: f for f in self.facs}
        self.today = max((f["today"] for f in self.facs), default=datetime.now(timezone.utc).date())
        self.m = m
        self.opts = opts or {}
        self._all_units = None
        self._units = None
        self._names = None
        self._rules = None
        self._skipped = None

    def rows(self, model, *extra):
        if not self.ids:
            return []
        return self.db.query(model).filter(model.facility_id.in_(self.ids), *extra).all()

    @property
    def parking(self) -> set:
        """{(fid, unit_id)} of parking units - only filled when the report was
        asked to ignore them."""
        if not self.opts.get("ignoreParking"):
            return set()
        return {k for k, u in self.all_units.items() if _is_parking(u["type"])}

    @property
    def rules(self) -> dict:
        """The mailbox / non-standard words (ops_unit_classes), read once."""
        if self._rules is None:
            import ops_unit_classes as uc
            try:
                self._rules = uc.load(self.db)
            except Exception:  # noqa: BLE001 - a settings blip must not sink a report
                self._rules = uc.DEFAULTS
        return self._rules

    def skip_type(self, unit_type: str, street=None) -> bool:
        """Is a unit of this type (and street rate) left out by the report's
        switches - Ignore Parking, Exclude Mailboxes, Exclude Non-Standard?"""
        import ops_unit_classes as uc
        if self.opts.get("ignoreParking") and _is_parking(unit_type):
            return True
        if self.opts.get("excludeMailboxes") and uc.unit_class(unit_type, self.rules) == uc.MAILBOX:
            return True
        return bool(self.opts.get("excludeNonStandard") and uc.is_nonstandard(unit_type, street, self.rules))

    @property
    def skipped(self) -> set:
        """{(fid, unit_id)} every switch leaves out (empty when none is on)."""
        if self._skipped is None:
            on = any(self.opts.get(k) for k in ("ignoreParking", "excludeMailboxes", "excludeNonStandard"))
            self._skipped = {k for k, u in self.all_units.items() if self.skip_type(u["type"], u["street"])} if on else set()
        return self._skipped

    @property
    def units(self) -> dict:
        """all_units without the units the report's switches leave out."""
        if self._units is None:
            skip = self.skipped
            self._units = {k: u for k, u in self.all_units.items() if k not in skip}
        return self._units

    @property
    def all_units(self) -> dict:
        """{(fid, unit_id): flat unit} - the rent-roll line and the units/search row."""
        if self._all_units is None:
            out = {}
            for u in self.rows(self.m.CubbyUnit):
                d = u.data or {}
                rr, un = d.get("rentRoll") or {}, d.get("unit") or {}
                rent = un.get("rentability") or {}
                w, dp = rr.get("width") or un.get("width") or 0, rr.get("depth") or un.get("depth") or 0
                try:
                    w, dp = float(w), float(dp)
                except (TypeError, ValueError):
                    w, dp = 0.0, 0.0
                status = (rr.get("status") or u.status or "").upper()
                out[(u.facility_id, u.unit_id)] = {
                    "fid": u.facility_id, "id": u.unit_id, "name": (u.unit_name or "").strip(),
                    "type": (rr.get("pricingGroupName") or "").strip() or "Other",
                    "w": w, "d": dp, "area": round(w * dp), "size": f"{w:g}x{dp:g}" if w and dp else "",
                    "status": status, "statusLabel": "Rented" if status == "RENTED" else "Vacant" if status == "VACANT" else "Off Market",
                    "street": int(rr.get("standardRate") or 0),
                    "rent": int(rr.get("monthlyRentalAmount") or 0) if status == "RENTED" else 0,
                    "customerId": (u.customer_id or rr.get("customerId") or "") if status == "RENTED" else "",
                    "tenant": (rr.get("customerName") or "") if status == "RENTED" else "",
                    "company": (rr.get("companyName") or "") if status == "RENTED" else "",
                    "moveIn": _iso_day(rr.get("moveInDate")) if status == "RENTED" else "",
                    "paidThrough": _iso_day(rr.get("paidThroughDate")) if status == "RENTED" else "",
                    "autoPay": bool(rr.get("autoPayEnabled")) if status == "RENTED" else False,
                    "overlocked": bool(rr.get("overlockApplied")),
                    "reason": (rent.get("unrentableReason") or "") if rent.get("rentable") is False else "",
                    "note": (rent.get("unrentableReasonNote") or "")[:160] if rent.get("rentable") is False else "",
                    "prepaid": int(rr.get("prepaid") or 0) if status == "RENTED" else 0,
                    "deposit": int(rr.get("deposit") or 0) if status == "RENTED" else 0,
                    "credit": int(rr.get("credit") or 0) if status == "RENTED" else 0,
                    "lastChange": _iso_day(rr.get("lastRentChangeDate")) if status == "RENTED" else "",
                }
            self._all_units = out
        return self._all_units

    @property
    def names(self) -> dict:
        """{(fid, customer_id): name} - customers, rent roll and receivables."""
        if self._names is None:
            out = {}
            for c in self.rows(self.m.CubbyCustomer):
                if c.name:
                    out[(c.facility_id, c.customer_id)] = c.name
            for u in self.all_units.values():
                if u["customerId"] and u["tenant"]:
                    out[(u["fid"], u["customerId"])] = u["tenant"]
            for r in self.rows(self.m.CubbyReceivable):
                n = (r.data or {}).get("customerName")
                if r.customer_id and n:
                    out.setdefault((r.facility_id, r.customer_id), n)
            self._names = out
        return self._names

    def name(self, fid, cid) -> str:
        return self.names.get((fid, cid), "") if cid else ""

    def unit_names_of(self) -> dict:
        """{(fid, customer_id): "A1, B2"} - units a tenant rents now."""
        out = defaultdict(list)
        for u in self.all_units.values():
            if u["customerId"]:
                out[(u["fid"], u["customerId"])].append(u["name"])
        return {k: ", ".join(sorted(v)) for k, v in out.items()}

    def rentals(self) -> list[dict]:
        out = []
        skip = self.skipped
        for r in self.rows(self.m.CubbyRental):
            if (r.facility_id, r.unit_id) in skip:
                continue
            d = r.data or {}
            u = self.all_units.get((r.facility_id, r.unit_id)) or {}
            cov = d.get("coverage") or {}
            out.append({"fid": r.facility_id, "leaseId": r.lease_id, "unitId": r.unit_id, "unit": u.get("name", ""),
                        "type": u.get("type", "Other"), "area": u.get("area", 0), "customerId": r.customer_id,
                        "moveIn": _iso_day(r.move_in_date), "moveOut": _iso_day(r.move_out_date),
                        "rent": int(d.get("monthlyRentalAmount") or 0),
                        "covType": (cov.get("coverageType") or "").upper(), "covAmount": int(cov.get("coverageAmount") or 0),
                        "premium": int(cov.get("premiumAmount") or 0), "covStart": _iso_day(cov.get("startDate")),
                        "policyExpires": _iso_day(d.get("privatePolicyExpirationDate")),
                        "policyOnFile": bool(d.get("privatePolicyNumber")),
                        "nextRentDate": _iso_day(d.get("rentChangeScheduledDate")),
                        "nextRent": int(d["rentChangeNewRentAmount"]) if d.get("rentChangeNewRentAmount") is not None else None})
        return out

    def payments(self, start: str, end: str) -> list[dict]:
        P = self.m.CubbyPayment
        out = []
        for p in self.rows(P, P.payment_date >= start, P.payment_date <= end):
            d = p.data or {}
            out.append({"fid": p.facility_id, "id": p.payment_id, "date": _iso_day(p.payment_date), "customerId": p.customer_id,
                        "amount": int(p.amount_cents or 0), "status": (p.status or "").upper(),
                        "method": d.get("methodType") or "", "reason": (d.get("reason") or "")[:200]})
        return out

    def receivables(self) -> list[dict]:
        out = []
        skip = self.skipped
        for r in self.rows(self.m.CubbyReceivable):
            d = r.data or {}
            if (r.facility_id, r.unit_id) in skip or (
                    (r.facility_id, r.unit_id) not in self.all_units and self.skip_type(d.get("pricingGroupName") or "")):
                continue
            by = {x.get("range"): int(x.get("amount") or 0) for x in d.get("ranges") or []}
            out.append({"fid": r.facility_id, "unitId": r.unit_id, "customerId": r.customer_id,
                        "unit": (d.get("unitName") or "").strip(), "type": (d.get("pricingGroupName") or "").strip(),
                        "tenant": d.get("customerName") or self.name(r.facility_id, r.customer_id),
                        "total": int(r.total_cents or 0), "buckets": by})
        return out

    def leads(self) -> list[dict]:
        out = []
        for ld in self.rows(self.m.CubbyLead):
            d = ld.data or {}
            out.append({"fid": ld.facility_id, "customerId": ld.customer_id, "status": (ld.status or "").upper(),
                        "created": _iso_day(ld.created_at), "source": (d.get("customSource") or d.get("source") or "").strip(),
                        "targetMoveIn": _iso_day(d.get("targetMoveInDate"))})
        return out


def _is_parking(unit_type: str) -> bool:
    # Cubby's pricing groups carry a parking flag, but the sync keeps only the
    # group's name - and every parking group is named "... Parking - ...".
    return "parking" in (unit_type or "").lower()


def _link(fid, cid="", uid=""):
    return {"_f": fid, "_c": cid or "", "_u": uid or ""}


FAILED = cubby.FAILED_PAYMENT
REFUNDED = {"REFUNDED", "REFUND_INITIATED"}


# ── Reports built from the synced rows ────────────────────────────────────────

def _rent_roll(d: Data, start, end):
    owed = {(r["fid"], r["unitId"]): r["total"] for r in d.receivables()}
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("type", "Unit Type"), _col("size", "Size"),
            _col("status", "Status"), _col("tenant", "Tenant", "tenant"), _col("company", "Company"),
            _col("moveIn", "Move-In Date", "date"), _col("street", "Street Rate", "money", True),
            _col("rent", "Monthly Rent", "money", True), _col("variance", "Rent vs Street", "money", True),
            _col("paidThrough", "Paid Through", "date"), _col("autoPay", "Autopay"), _col("overlocked", "Overlocked"),
            _col("balance", "Balance Due", "money", True)]
    rows = []
    for u in sorted(d.units.values(), key=lambda u: (d.fac[u["fid"]]["short"], u["name"])):
        rented = u["status"] == "RENTED"
        if d.opts.get("occupiedOnly") and not rented:
            continue
        rows.append({**_link(u["fid"], u["customerId"], u["id"]), "facility": d.fac[u["fid"]]["short"], "unit": u["name"],
                     "type": u["type"], "size": u["size"], "status": u["statusLabel"], "tenant": u["tenant"], "company": u["company"],
                     "moveIn": u["moveIn"], "street": u["street"], "rent": u["rent"] if rented else None,
                     "variance": (u["rent"] - u["street"]) if rented else None, "paidThrough": u["paidThrough"],
                     "autoPay": ("Yes" if u["autoPay"] else "No") if rented else "", "overlocked": "Yes" if u["overlocked"] else "No",
                     "balance": owed.get((u["fid"], u["id"]), 0) if rented else None})
    return cols, rows, []


AGING_COLS = [("RANGE_0_30", "0-30 Days"), ("RANGE_30_60", "31-60 Days"), ("RANGE_60_90", "61-90 Days"),
              ("RANGE_90_120", "91-120 Days"), ("RANGE_120_PLUS", "120+ Days")]


def _receivables(d: Data, start, end):
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("type", "Unit Type"), _col("tenant", "Tenant", "tenant"),
            _col("total", "Total Due", "money", True)] + [_col(k.lower(), label, "money", True) for k, label in AGING_COLS]
    rows = []
    for r in sorted(d.receivables(), key=lambda r: -r["total"]):
        rows.append({**_link(r["fid"], r["customerId"], r["unitId"]), "facility": d.fac[r["fid"]]["short"], "unit": r["unit"],
                     "type": r["type"], "tenant": r["tenant"], "total": r["total"],
                     **{k.lower(): r["buckets"].get(k, 0) for k, _ in AGING_COLS}})
    notes = ["Balances as of the last Cubby sync. The Accounts Receivable report rolls a period forward (beginning "
             "balance, charges, payments, ending balance); click a tenant to see their ledger."]
    return cols, rows, notes


def _occupancy(d: Data, start, end):
    groups: dict = {}
    for u in d.units.values():
        g = groups.setdefault((u["fid"], u["type"]), {"units": 0, "rented": 0, "vacant": 0, "off": 0, "area": 0, "rentedArea": 0,
                                                      "streets": [], "rent": 0, "potential": 0, "days": []})
        g["units"] += 1
        g["area"] += u["area"]
        g["potential"] += u["street"]
        g["streets"].append(u["street"])
        if u["status"] == "RENTED":
            g["rented"] += 1
            g["rentedArea"] += u["area"]
            g["rent"] += u["rent"]
        elif u["status"] == "VACANT":
            g["vacant"] += 1
            days = _days_vacant(d, u)[1]
            if days is not None:
                g["days"].append(days)
        else:
            g["off"] += 1
    cols = [_col("facility", "Facility"), _col("type", "Unit Type"), _col("units", "Units", "int", True),
            _col("rented", "Occupied", "int", True), _col("vacant", "Vacant", "int", True), _col("off", "Off Market", "int", True),
            _col("occ", "Unit Occupancy", "pct"), _col("area", "Area (Sq Ft)", "area", True),
            _col("rentedArea", "Occupied Sq Ft", "area", True), _col("areaOcc", "Area Occupancy", "pct"),
            _col("street", "Street Rate", "money"), _col("avgRent", "Average Rent", "money"),
            _col("potential", "Gross Potential Rent", "money", True), _col("rent", "Actual Rent", "money", True),
            _col("econ", "Economic Occupancy", "pct"), _col("avgDaysVacant", "Average Days Vacant", "int"),
            _col("maxDaysVacant", "Longest Vacant (Days)", "int")]
    rows = []
    for (fid, t), g in sorted(groups.items(), key=lambda kv: (d.fac[kv[0][0]]["short"], kv[0][1])):
        rows.append({**_link(fid), "facility": d.fac[fid]["short"], "type": t, "units": g["units"], "rented": g["rented"],
                     "vacant": g["vacant"], "off": g["off"], "occ": _pct(g["rented"], g["units"]), "area": g["area"],
                     "rentedArea": g["rentedArea"], "areaOcc": _pct(g["rentedArea"], g["area"]),
                     "street": max(set(g["streets"]), key=g["streets"].count) if g["streets"] else 0,
                     "avgRent": round(g["rent"] / g["rented"]) if g["rented"] else None,
                     "potential": g["potential"], "rent": g["rent"], "econ": _pct(g["rent"], g["potential"]),
                     "avgDaysVacant": round(sum(g["days"]) / len(g["days"])) if g["days"] else None,
                     "maxDaysVacant": max(g["days"]) if g["days"] else None})
    return cols, rows, ["Days vacant count from each vacant unit's last move-out in Cubby; a unit never rented in Cubby "
                        "is left out of both. The Vacant Units report lists every unit with its own count."]


def _vacant_since(d: Data) -> dict:
    """{(fid, unit_id): the last move-out day} - when each unit came empty
    (B14, vacancy duration). A unit never rented in Cubby has none."""
    if getattr(d, "_since", None) is None:
        last_out = {}
        for r in d.rentals():
            if r["moveOut"] and r["moveOut"] > last_out.get((r["fid"], r["unitId"]), ""):
                last_out[(r["fid"], r["unitId"])] = r["moveOut"]
        d._since = last_out
    return d._since


def _days_vacant(d: Data, u: dict) -> tuple[str, int | None]:
    """(vacant since, days) for a unit that is not rented; ("", None) for a
    rented one or one Cubby has never seen rented."""
    if u["status"] == "RENTED":
        return "", None
    since = _vacant_since(d).get((u["fid"], u["id"]), "")
    return since, ((d.fac[u["fid"]]["today"] - date.fromisoformat(since)).days if since else None)


def _vacant(d: Data, start, end):
    last_out = _vacant_since(d)
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("type", "Unit Type"), _col("size", "Size"),
            _col("area", "Area (Sq Ft)", "area", True), _col("street", "Street Rate", "money", True), _col("status", "Status"),
            _col("reason", "Reason"), _col("note", "Note"), _col("vacantSince", "Vacant Since", "date"),
            _col("daysVacant", "Days Vacant", "int")]
    rows = []
    for u in sorted(d.units.values(), key=lambda u: (d.fac[u["fid"]]["short"], u["name"])):
        if u["status"] == "RENTED":
            continue
        since = last_out.get((u["fid"], u["id"]), "")
        days = (d.fac[u["fid"]]["today"] - date.fromisoformat(since)).days if since else None
        rows.append({**_link(u["fid"], "", u["id"]), "facility": d.fac[u["fid"]]["short"], "unit": u["name"], "type": u["type"],
                     "size": u["size"], "area": u["area"], "street": u["street"], "status": u["statusLabel"],
                     "reason": _tidy(u["reason"]) if u["status"] != "VACANT" else "", "note": u["note"],
                     "vacantSince": since, "daysVacant": days})
    return cols, rows, ["Vacant Since is the last move-out Cubby has for the unit; blank when it has never been rented in Cubby."]


def _management(d: Data, start, end):
    ytd = f"{end[:4]}-01-01"
    pays = d.payments(min(start, ytd), end)
    rentals = d.rentals()
    rec = d.receivables()
    leads = d.leads()
    per = {fid: defaultdict(int) for fid in d.ids}
    for u in d.units.values():
        x = per[u["fid"]]
        x["units"] += 1
        x["area"] += u["area"]
        x["potential"] += u["street"]
        if u["status"] == "RENTED":
            x["rented"] += 1
            x["rentedArea"] += u["area"]
            x["rentRoll"] += u["rent"]
            x["autoPay"] += 1 if u["autoPay"] else 0
    for r in rentals:
        x = per[r["fid"]]
        x["moveIns"] += 1 if start <= r["moveIn"] <= end else 0
        x["moveOuts"] += 1 if r["moveOut"] and start <= r["moveOut"] <= end else 0
    for p in pays:
        x = per[p["fid"]]
        if p["status"] == "SUCCEEDED":
            if start <= p["date"] <= end:
                x["receipts"] += p["amount"]
            if ytd <= p["date"] <= end:
                x["receiptsYtd"] += p["amount"]
        elif p["status"] in FAILED and start <= p["date"] <= end:
            x["failed"] += 1
    for r in rec:
        per[r["fid"]]["pastDue"] += r["total"]
        per[r["fid"]]["pastDueTenants"] += 1
    for ld in leads:
        if start <= ld["created"] <= end and ld["status"] != "DUPLICATE":
            per[ld["fid"]]["leads"] += 1
            per[ld["fid"]]["converted"] += 1 if ld["status"] == "CONVERTED" else 0
    cols = [_col("facility", "Facility"), _col("units", "Units", "int", True), _col("rented", "Rented", "int", True),
            _col("occ", "Unit Occupancy", "pct"), _col("areaOcc", "Area Occupancy", "pct"),
            _col("rentRoll", "Rent Roll", "money", True), _col("potential", "Gross Potential Rent", "money", True),
            _col("econ", "Economic Occupancy", "pct"), _col("moveIns", "Move-Ins", "int", True),
            _col("moveOuts", "Move-Outs", "int", True), _col("net", "Net Move-Ins", "int", True),
            _col("receipts", "Receipts", "money", True), _col("receiptsYtd", "Receipts Year to Date", "money", True),
            _col("failed", "Failed Payments", "int", True), _col("pastDue", "Past Due", "money", True),
            _col("pastDueTenants", "Tenants Past Due", "int", True), _col("leads", "New Leads", "int", True),
            _col("converted", "Leads Converted", "int", True), _col("autoPay", "On Autopay", "pct")]

    def line(x, label, fid=""):
        return {**_link(fid), "facility": label, "units": x["units"], "rented": x["rented"], "occ": _pct(x["rented"], x["units"]),
                "areaOcc": _pct(x["rentedArea"], x["area"]), "rentRoll": x["rentRoll"], "potential": x["potential"],
                "econ": _pct(x["rentRoll"], x["potential"]), "moveIns": x["moveIns"], "moveOuts": x["moveOuts"],
                "net": x["moveIns"] - x["moveOuts"], "receipts": x["receipts"], "receiptsYtd": x["receiptsYtd"],
                "failed": x["failed"], "pastDue": x["pastDue"], "pastDueTenants": x["pastDueTenants"], "leads": x["leads"],
                "converted": x["converted"], "autoPay": _pct(x["autoPay"], x["rented"])}
    rows = [line(per[fid], d.fac[fid]["short"], fid) for fid in d.ids]
    total = defaultdict(int)
    for x in per.values():
        for k, v in x.items():
            total[k] += v
    return cols, rows, [], line(total, "All Facilities")


def _moves(d: Data, start, end):
    cols = [_col("facility", "Facility"), _col("date", "Date", "date"), _col("kind", "Move"), _col("unit", "Unit", "unit"),
            _col("type", "Unit Type"), _col("area", "Area (Sq Ft)", "area", True), _col("tenant", "Tenant", "tenant"),
            _col("rent", "Rent", "money", True), _col("stay", "Length of Stay (Days)", "int")]
    rows = []
    for r in d.rentals():
        base = {**_link(r["fid"], r["customerId"], r["unitId"]), "facility": d.fac[r["fid"]]["short"], "unit": r["unit"],
                "type": r["type"], "area": r["area"], "tenant": d.name(r["fid"], r["customerId"]), "rent": r["rent"]}
        if r["moveIn"] and start <= r["moveIn"] <= end:
            rows.append({**base, "date": r["moveIn"], "kind": "Move-In", "stay": None})
        if r["moveOut"] and start <= r["moveOut"] <= end:
            stay = (date.fromisoformat(r["moveOut"]) - date.fromisoformat(r["moveIn"])).days if r["moveIn"] else None
            rows.append({**base, "date": r["moveOut"], "kind": "Move-Out", "stay": stay})
    rows.sort(key=lambda r: (r["date"], r["facility"], r["unit"]), reverse=True)
    return cols, rows, []


def _payment_detail(d: Data, start, end):
    units_of = d.unit_names_of()
    cols = [_col("facility", "Facility"), _col("date", "Date", "date"), _col("tenant", "Tenant", "tenant"),
            _col("units", "Units Rented"), _col("method", "Method"), _col("status", "Status"),
            _col("amount", "Amount", "money", True), _col("reason", "Reason"), _col("paymentId", "Cubby Payment ID")]
    rows = [{**_link(p["fid"], p["customerId"]), "facility": d.fac[p["fid"]]["short"], "date": p["date"],
             "tenant": d.name(p["fid"], p["customerId"]) or ("Former Tenant" if p["customerId"] else ""),
             "units": units_of.get((p["fid"], p["customerId"]), ""), "method": _tidy(p["method"]), "status": _tidy(p["status"]),
             "amount": p["amount"], "reason": p["reason"], "paymentId": p["id"]}
            for p in d.payments(start, end)]
    rows.sort(key=lambda r: (r["date"], r["facility"]), reverse=True)
    return cols, rows, ["Cubby has payments from 09/15/2026 on (the cutover). A payment names the tenant, not the unit."]


def _receipts_summary(d: Data, start, end):
    agg = defaultdict(lambda: {"count": 0, "amount": 0, "failed": 0, "failedAmount": 0, "refunded": 0, "refundedAmount": 0})
    for p in d.payments(start, end):
        x = agg[(p["fid"], p["method"] or "OTHER")]
        if p["status"] == "SUCCEEDED":
            x["count"] += 1
            x["amount"] += p["amount"]
        elif p["status"] in FAILED:
            x["failed"] += 1
            x["failedAmount"] += p["amount"]
        elif p["status"] in REFUNDED:
            x["refunded"] += 1
            x["refundedAmount"] += p["amount"]
    cols = [_col("facility", "Facility"), _col("method", "Payment Method"), _col("count", "Payments", "int", True),
            _col("amount", "Received", "money", True), _col("share", "Share of Received", "pct"),
            _col("failed", "Failed", "int", True), _col("failedAmount", "Failed Amount", "money", True),
            _col("refunded", "Refunded", "int", True), _col("refundedAmount", "Refunded Amount", "money", True)]
    fac_total = defaultdict(int)
    for (fid, _), x in agg.items():
        fac_total[fid] += x["amount"]
    rows = [{**_link(fid), "facility": d.fac[fid]["short"], "method": _tidy(meth), **x, "share": _pct(x["amount"], fac_total[fid])}
            for (fid, meth), x in sorted(agg.items(), key=lambda kv: (d.fac[kv[0][0]]["short"], -kv[1]["amount"]))]
    return cols, rows, []


def _leads(d: Data, start, end):
    cols = [_col("facility", "Facility"), _col("created", "Created", "date"), _col("tenant", "Lead", "tenant"),
            _col("status", "Status"), _col("source", "Source"), _col("targetMoveIn", "Target Move-In", "date"),
            _col("days", "Days Since Created", "int")]
    rows = []
    for ld in d.leads():
        if not (ld["created"] and start <= ld["created"] <= end):
            continue
        rows.append({**_link(ld["fid"], ld["customerId"]), "facility": d.fac[ld["fid"]]["short"], "created": ld["created"],
                     "tenant": d.name(ld["fid"], ld["customerId"]), "status": _tidy(ld["status"]), "source": _tidy(ld["source"]),
                     "targetMoveIn": ld["targetMoveIn"],
                     "days": (d.fac[ld["fid"]]["today"] - date.fromisoformat(ld["created"])).days})
    rows.sort(key=lambda r: r["created"], reverse=True)
    return cols, rows, []


# ── Cubby's live reports, cached per facility and month ───────────────────────

_key_locks: dict[str, threading.Lock] = {}
_klock = threading.Lock()


def _cubby(path: str, body: dict) -> dict:
    """One Cubby call with the whole body (get-compliances takes no "where").
    Blocking. Raises cubby.CubbyError."""
    key = cubby._key()
    if not key:
        raise cubby.CubbyError(503, NOT_CONNECTED)
    try:
        r = httpx.post(f"{cubby.BASE}/{path}", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=60)
    except httpx.HTTPError as e:
        raise cubby.CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        out = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        out = {}
    if r.status_code != 200:
        errors = (out.get("errors") if isinstance(out, dict) else None) or [f"Cubby returned {r.status_code}"]
        raise cubby.CubbyError(r.status_code, f"{path}: {'; '.join(str(e) for e in errors)}")
    return (out.get("data") if isinstance(out, dict) else None) or {}


def ttl_for(month: str, today: date) -> float:
    if month >= today.isoformat()[:7]:
        return CURRENT_TTL
    nxt = date(int(month[:4]) + (month[5:7] == "12"), int(month[5:7]) % 12 + 1, 1)
    return RECENT_TTL if (today - nxt).days < RECENT_DAYS else 400 * 86400.0


def _age(stamp: str) -> float:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def cached(kind: str, facility_id: str, period: str, ttl: float, fetch) -> tuple[dict, str, str]:
    """(payload, fetched_at, warning). The last good copy within `ttl`, else
    `fetch()` (cleaned, then kept); a failed fetch falls back to the last copy
    with the error as the warning. Blocking."""
    import models
    from database import SessionLocal
    key = f"{kind}:{facility_id}:{period}"
    with _klock:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        db = SessionLocal()
        try:
            row = db.get(models.OpsReportCache, key)
            hit = (row.payload or {}, row.fetched_at) if row else None
        finally:
            db.close()
        if hit and _age(hit[1]) < ttl:
            return hit[0], hit[1], ""
        try:
            if not cubby.configured():
                raise cubby.CubbyError(503, NOT_CONNECTED)
            payload = _clean(fetch())
        except cubby.CubbyError as e:
            if hit:
                return hit[0], hit[1], e.message
            raise
        stamp = _now_iso()
        db = SessionLocal()
        try:
            row = db.get(models.OpsReportCache, key)
            if row is None:
                row = models.OpsReportCache(id=key, kind=kind, facility_id=facility_id, period=period)
                db.add(row)
            row.payload, row.fetched_at = payload, stamp
            db.commit()
        finally:
            db.close()
        return payload, stamp, ""


def _months_for(start: str, end: str) -> list[str]:
    months = months_between(start, end)
    if len(months) > MAX_LIVE_MONTHS:
        raise ReportError(422, f"This report reads Cubby month by month: pick {MAX_LIVE_MONTHS} months or fewer")
    return months


def _gather(d: Data, kind: str, start: str, end: str, fetch_for) -> tuple[list, list[str], str]:
    """[(facility, month, payload)], warnings, oldest fetched_at - every
    (facility, month) of the period, FETCH_WORKERS at a time."""
    jobs = [(f, mo) for f in d.facs for mo in _months_for(start, end)]
    if not jobs:
        return [], [], ""

    def one(job):
        f, mo = job
        return f, mo, *cached(kind, f["id"], mo, ttl_for(mo, f["today"]), lambda: fetch_for(f["id"], mo))
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        got = list(pool.map(one, jobs))
    warnings = sorted({f"{f['short']}: {w}" for f, _, _, _, w in got if w})
    stamps = [s for *_, s, _ in got if s]
    return [(f, mo, p) for f, mo, p, _, _ in got], warnings, min(stamps) if stamps else ""


def _gl_fetch(path):
    def go(fid, month):
        data = _cubby(path, {"where": {"facilityId": fid, "startDate": f"{month}-01", "reportRelativeDuration": "M"}})
        return {"entries": data.get("entries") or []}
    return go


def _gl_lines(d: Data, start, end, basis: str):
    path = "reports/general-ledger/cash" if basis == "cash" else "reports/general-ledger/accrual"
    got, warnings, stamp = _gather(d, f"gl-{basis}", start, end, _gl_fetch(path))
    lines = []
    for f, _, payload in got:
        for e in payload.get("entries") or []:
            det = e.get("details") or {}
            when = _iso_day(e.get("paymentTime") or e.get("entryTime")) if basis == "cash" else _iso_day(e.get("entryTime"))
            if not (start <= when <= end):
                continue
            amount = int(e.get("amount") or 0)
            debit = int(e.get("debit") or 0) if basis == "accrual" else (amount if e.get("direction") == "DEBIT" else 0)
            credit = int(e.get("credit") or 0) if basis == "accrual" else (amount if e.get("direction") == "CREDIT" else 0)
            lines.append({"fid": f["id"], "facility": f["short"], "date": when, "journal": e.get("journalEntryId") or "",
                          "account": e.get("account") or "", "debit": debit, "credit": credit,
                          "customerId": e.get("customerId") or det.get("customerId") or "",
                          "tenant": e.get("customerName") or det.get("customerName") or "",
                          "unitId": e.get("unitId") or "", "unit": (e.get("unitName") or det.get("unitName") or "").strip(),
                          "description": (det.get("description") or e.get("explanation") or "")[:200],
                          "taxCategory": e.get("taxCategory") or "", "glAccount": e.get("mappedGlAccount") or "",
                          "glNumber": e.get("mappedGlAccountNumber") or ""})
    if d.opts.get("ignoreBadDebt"):
        bad = {(x["fid"], x["journal"]) for x in lines if x["account"] == "BAD_DEBT"}
        lines = [x for x in lines if (x["fid"], x["journal"]) not in bad]
    return lines, warnings, stamp


def _unit_id(d: Data, fid: str, name: str) -> str:
    if not hasattr(d, "_by_name"):
        d._by_name = {(u["fid"], u["name"]): u["id"] for u in d.units.values()}
    return d._by_name.get((fid, (name or "").strip().upper()), "") or d._by_name.get((fid, (name or "").strip()), "")


def _gl_detail(d: Data, start, end, basis: str):
    lines, warnings, stamp = _gl_lines(d, start, end, basis)
    cols = [_col("facility", "Facility"), _col("date", "Date", "date"), _col("account", "Account")]
    if basis == "accrual":
        cols += [_col("glAccount", "GL Account"), _col("taxCategory", "Tax Category")]
    cols += [_col("description", "Description"), _col("tenant", "Tenant", "tenant"), _col("unit", "Unit", "unit"),
             _col("debit", "Debit", "money", True), _col("credit", "Credit", "money", True)]
    lines.sort(key=lambda x: (x["date"], x["facility"], x["journal"]))
    notes = list(warnings)
    if len(lines) > MAX_ROWS:
        notes.append(f"Showing the first {MAX_ROWS:,} of {len(lines):,} lines. Pick one facility or a shorter period for the rest.")
        lines = lines[:MAX_ROWS]
    rows = [{**_link(x["fid"], x["customerId"], x["unitId"] or _unit_id(d, x["fid"], x["unit"])), "facility": x["facility"],
             "date": x["date"], "account": _account(x["account"]),
             "glAccount": " ".join(v for v in (x["glNumber"], x["glAccount"]) if v), "taxCategory": _tidy(x["taxCategory"]),
             "description": x["description"], "tenant": x["tenant"], "unit": x["unit"], "debit": x["debit"] or None,
             "credit": x["credit"] or None} for x in lines]
    return cols, rows, notes, None, stamp


ACCOUNT_LABEL = {
    "ACCOUNT_RECEIVABLE": "Accounts Receivable", "RENT": "Rent", "INSURANCE": "Insurance", "FEES": "Fees",
    "DISCOUNTS": "Discounts", "TAX_STATE": "State Tax", "TAX_LOCAL": "Local Tax", "PREPAID_RENT": "Prepaid",
    "CREDIT_CARD_PAYMENTS": "Credit Card", "OFFLINE_CARD_PAYMENTS": "Offline Card", "CASH_PAYMENTS": "Cash",
    "ACH_PAYMENTS": "ACH", "ACSS_PAYMENTS": "ACSS", "CHECK_PAYMENTS": "Check", "MONEYORDER_PAYMENTS": "Money Order",
    "VENMO_PAYMENTS": "Venmo", "PAYPAL_PAYMENTS": "PayPal", "ZELLE_PAYMENTS": "Zelle", "CASH_APP_PAYMENTS": "Cash App",
    "E_TRANSFER_PAYMENTS": "E-Transfer", "ONLINE_BANKING_PAYMENTS": "Online Banking", "DEPOSIT": "Deposit",
    "OLD_SYSTEM": "Imported Balance", "OLD_SYSTEM_DEPOSIT": "Imported Deposit", "DAMAGE": "Damage",
    "RETAINED_DEPOSIT": "Retained Deposit", "BAD_DEBT": "Bad Debt", "GIVEN_CREDITS": "Given Credits", "CREDITS": "Credits",
    "USED_CREDITS": "Used Credits", "EXTERNAL_ACCOUNT": "External Account", "WAIVED_FEES": "Waived Fees",
    "WAIVED_DAMAGE": "Waived Damage", "WAIVED_RENT": "Waived Rent", "AUCTION": "Auctions", "EXTERNAL_AUCTION": "External Auction",
    "ACCOUNTS_PAYABLE": "Accounts Payable", "RETAIL_SALES": "Retail Sales",
}


def _account(a: str) -> str:
    return ACCOUNT_LABEL.get(a) or _tidy(a)


def _is_payment_account(a: str) -> bool:
    return a.endswith("_PAYMENTS")


def _receipts_by_charge(d: Data, start, end):
    lines, warnings, stamp = _gl_lines(d, start, end, "cash")
    agg = defaultdict(lambda: {"amount": 0, "lines": []})
    for x in lines:
        if _is_payment_account(x["account"]) or x["account"] == "ACCOUNT_RECEIVABLE":
            continue
        g = agg[(x["fid"], x["account"])]
        g["amount"] += x["credit"] - x["debit"]
        g["lines"].append(x)
    cols = [_col("facility", "Facility"), _col("charge", "Charge Type"), _col("amount", "Received", "money", True),
            _col("share", "Share", "pct"), _col("lines", "Lines", "int", True)]
    fac_total = defaultdict(int)
    for (fid, _), g in agg.items():
        fac_total[fid] += g["amount"]
    rows, groups = [], {}
    for (fid, acct), g in sorted(agg.items(), key=lambda kv: (d.fac[kv[0][0]]["short"], -kv[1]["amount"])):
        sub = f"{fid}:{acct}"
        groups[sub] = _line_rows(d, g["lines"])
        rows.append({**_link(fid), "_sub": sub, "facility": d.fac[fid]["short"], "charge": _account(acct), "amount": g["amount"],
                     "share": _pct(g["amount"], fac_total[fid]), "lines": len(g["lines"])})
    return cols, rows, warnings + ["Cash basis, from Cubby's general ledger: credits less debits on each charge account "
                                   "for payments made in the period. Click a line for the payments behind it."], None, stamp, groups


def _line_rows(d: Data, lines: list[dict]) -> dict:
    cols = [_col("date", "Date", "date"), _col("tenant", "Tenant", "tenant"), _col("unit", "Unit", "unit"),
            _col("description", "Description"), _col("amount", "Amount", "money", True)]
    rows = [{**_link(x["fid"], x["customerId"], x["unitId"] or _unit_id(d, x["fid"], x["unit"])), "date": x["date"],
             "tenant": x["tenant"], "unit": x["unit"], "description": x["description"], "amount": x["credit"] - x["debit"]}
            for x in sorted(lines, key=lambda x: x["date"])[:2000]]
    return {"columns": cols, "rows": rows}


def _receipts_by_tax(d: Data, start, end):
    lines, warnings, stamp = _gl_lines(d, start, end, "cash")
    by_journal = defaultdict(list)
    for x in lines:
        by_journal[(x["fid"], x["journal"])].append(x)
    agg = defaultdict(lambda: {"tax": 0, "taxable": 0, "payments": set()})
    for (fid, j), group in by_journal.items():
        revenue = sum(x["credit"] - x["debit"] for x in group
                      if x["account"] in ("RENT", "FEES", "INSURANCE", "RETAIL_SALES", "DAMAGE", "DISCOUNTS"))
        taxes = [x for x in group if x["account"] in ("TAX_STATE", "TAX_LOCAL")]
        if not taxes:
            if revenue:
                g = agg[(fid, "Not Taxed", "")]
                g["taxable"] += revenue
                g["payments"].add(j)
            continue
        for t in taxes:
            g = agg[(fid, _account(t["account"]), t["description"])]
            g["tax"] += t["credit"] - t["debit"]
            g["taxable"] += revenue
            g["payments"].add(j)
    cols = [_col("facility", "Facility"), _col("tax", "Tax"), _col("rate", "Rate"), _col("taxable", "Receipts Taxed", "money"),
            _col("collected", "Tax Collected", "money", True), _col("payments", "Payments", "int", True)]
    rows = [{**_link(fid), "facility": d.fac[fid]["short"], "tax": tax, "rate": rate, "taxable": g["taxable"],
             "collected": g["tax"], "payments": len(g["payments"])}
            for (fid, tax, rate), g in sorted(agg.items(), key=lambda kv: (d.fac[kv[0][0]]["short"], kv[0][1], kv[0][2]))]
    return cols, rows, warnings + ["Cash basis, from Cubby's general ledger. Receipts Taxed is the rent, fees and insurance "
                                   "paid in the same payments the tax was collected on."], None, stamp


def _disbursements(d: Data, start, end):
    def fetch(fid, month):
        data = _cubby("reports/merchant-services-disbursements",
                      {"where": {"facilityIds": [fid], "startDate": f"{month}-01", "reportRelativeDuration": "M"}})
        return {"batches": data.get("batches") or [], "transactions": data.get("transactions") or []}
    got, warnings, stamp = _gather(d, "disbursements", start, end, fetch)
    cols = [_col("facility", "Facility"), _col("batchDate", "Batch Date", "date"), _col("batch", "Batch Number"),
            _col("provider", "Provider"), _col("method", "Method"), _col("status", "Status"),
            _col("amount", "Amount", "money", True), _col("count", "Payments", "int", True)]
    rows, groups, seen = [], {}, set()
    for f, _, payload in got:
        tx_by = defaultdict(list)
        for t in payload.get("transactions") or []:
            tx_by[t.get("batchNumber") or ""].append(t)
        for b in payload.get("batches") or []:
            when = _iso_day(b.get("batchDate"))
            num = b.get("batchNumber") or ""
            if not (start <= when <= end) or (f["id"], num) in seen:
                continue
            seen.add((f["id"], num))
            txs = tx_by.get(num, [])
            sub = f"{f['id']}:{num}"
            groups[sub] = {"columns": [_col("date", "Date", "date"), _col("tenant", "Tenant", "tenant"), _col("type", "Type"),
                                       _col("method", "Method"), _col("status", "Status"), _col("amount", "Amount", "money", True)],
                           "rows": [{**_link(f["id"], t.get("customerId") or ""), "date": _iso_day(t.get("date")),
                                     "tenant": t.get("customerName") or "", "type": _tidy(t.get("type") or ""),
                                     "method": _tidy(t.get("methodType") or t.get("cardBrand") or ""),
                                     "status": _tidy(t.get("status") or t.get("payabliStatus") or ""),
                                     "amount": int(t.get("amount") or 0)} for t in txs]}
            rows.append({**_link(f["id"]), "_sub": sub, "facility": f["short"], "batchDate": when, "batch": num,
                         "provider": _tidy(b.get("paymentProvider") or ""), "method": _tidy(b.get("methodType") or ""),
                         "status": _tidy(b.get("batchStatus") or ""), "amount": int(b.get("amount") or 0), "count": len(txs)})
    rows.sort(key=lambda r: (r["batchDate"], r["facility"]), reverse=True)
    return cols, rows, warnings + ["Click a batch for the payments in it."], None, stamp, groups


DOC_TYPES = [("LEASE_AGREEMENT", "leaseAgreement", "Lease Agreement"), ("COVERAGE", "coverage", "Coverage"),
             ("IDENTITY", "identity", "Identity"), ("VEHICLE", "vehicle", "Vehicle")]
DOC_OK = {"APPROVED", "NOT_REQUIRED"}


def _compliance(d: Data, start, end):
    active = defaultdict(list)
    for r in d.rentals():
        if r["leaseId"] and not r["leaseId"].startswith("h") and (not r["moveOut"] or r["moveOut"] > d.fac[r["fid"]]["today"].isoformat()):
            active[r["fid"]].append(r)
    warnings, stamps, rows = [], [], []
    for f in d.facs:
        leases = active.get(f["id"], [])
        if not leases:
            continue
        ids = sorted(r["leaseId"] for r in leases)

        def fetch(ids=ids):
            out = []
            for i in range(0, len(ids), COMPLIANCE_BATCH):
                out += _cubby("leases/get-compliances", {"leaseIds": ids[i:i + COMPLIANCE_BATCH]}).get("compliances") or []
            return {"compliances": out}
        payload, stamp, warn = cached("compliance", f["id"], "current", COMPLIANCE_TTL, fetch)
        if warn:
            warnings.append(f"{f['short']}: {warn}")
        stamps.append(stamp)
        by_lease = {r["leaseId"]: r for r in leases}
        for c in payload.get("compliances") or []:
            r = by_lease.get(c.get("leaseId"))
            if not r:
                continue
            docs = {x.get("type"): (x.get("status") or "").upper() for x in c.get("documents") or []}
            missing = [label for t, _, label in DOC_TYPES if docs.get(t) and docs[t] not in DOC_OK]
            if not missing:
                continue
            rows.append({**_link(f["id"], r["customerId"], r["unitId"]), "facility": f["short"], "unit": r["unit"],
                         "tenant": d.name(f["id"], r["customerId"]), "moveIn": r["moveIn"],
                         **{key: _tidy(docs.get(t, "")) for t, key, _ in DOC_TYPES}, "missing": len(missing)})
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("tenant", "Tenant", "tenant"),
            _col("moveIn", "Move-In Date", "date")] + [_col(key, label) for _, key, label in DOC_TYPES] + \
           [_col("missing", "Documents Open", "int", True)]
    rows.sort(key=lambda r: (r["facility"], r["unit"]))
    return cols, rows, warnings, None, min(stamps) if stamps else ""


# ── Receivables rolled forward, balances, coverage (Oct 20 2026) ─────────────
#
# The accrual ledger is complete back to each lease's first day: balances
# brought over from the old system were posted as "Transferred Lease balance"
# journals (OLD_SYSTEM against receivables) on their own old dates, so the
# ledger from the start nets to Cubby's aged receivables to the cent (checked
# on Temecula, Oct 20 2026). Reading every month since the oldest lease is
# hundreds of Cubby calls, so a balance on a date is taken from the other end:
# today's balance (the synced aged receivables / rent roll) less what posted
# after that date - the same figure, only the period and the months since are
# read (and those are cached).

AR_CATS = [("rent", "Rent"), ("insurance", "Insurance"), ("fees", "Fees"), ("stateTax", "State Tax"),
           ("localTax", "Local Tax"), ("prepaid", "Prepaid"), ("deposit", "Deposit"), ("other", "Other"),
           ("waivedRent", "Waived Rent"), ("waivedFees", "Waived Fees"), ("discounts", "Discounts"),
           ("payments", "Payments"), ("refunds", "Refunds"), ("reversals", "Reversals")]
_AR_ACCOUNT = {"RENT": "rent", "INSURANCE": "insurance", "FEES": "fees", "DAMAGE": "fees", "TAX_STATE": "stateTax",
               "TAX_LOCAL": "localTax", "PREPAID_RENT": "prepaid", "DEPOSIT": "deposit", "OLD_SYSTEM_DEPOSIT": "deposit",
               "WAIVED_RENT": "waivedRent", "WAIVED_FEES": "waivedFees", "WAIVED_DAMAGE": "waivedFees",
               "DISCOUNTS": "discounts"}
CHARGE_CATS = ("rent", "insurance", "fees", "stateTax", "localTax", "deposit")


def _ar_cat(x: dict) -> str:
    a = x["account"]
    if _is_payment_account(a):
        if x["debit"] >= x["credit"]:
            return "payments"
        return "refunds" if "refund" in (x["description"] or "").lower() else "reversals"
    return _AR_ACCOUNT.get(a, "other")


def _day_after(day: str) -> str:
    from datetime import timedelta
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _key_of(d: Data, x: dict) -> tuple:
    return (x["fid"], x["customerId"], x["unitId"] or _unit_id(d, x["fid"], x["unit"]))


def _after(d: Data, end: str, accounts: dict) -> tuple[dict, list, str]:
    """{account: {key: net}} posted after `end` through today, from the accrual
    ledger; `accounts` maps account -> +1 (debit-normal) or -1 (credit-normal)."""
    out = {a: defaultdict(int) for a in accounts}
    today = d.today.isoformat()
    if end >= today:
        return out, [], ""
    lines, warnings, stamp = _gl_lines(d, _day_after(end), today, "accrual")
    for x in lines:
        sign = accounts.get(x["account"])
        if sign:
            out[x["account"]][_key_of(d, x)] += sign * (x["debit"] - x["credit"])
    return out, warnings, stamp


def _tenant_label(d: Data, fid, cid, fallback="") -> str:
    return d.name(fid, cid) or fallback or ("Former Tenant" if cid else "")


def _ar_activity(d: Data, start, end):
    today = d.today.isoformat()
    lines, warnings, stamp = _gl_lines(d, start, max(end, today), "accrual")
    with_ar = {(x["fid"], x["journal"]) for x in lines if x["account"] == "ACCOUNT_RECEIVABLE"}
    now = defaultdict(int)
    for r in d.receivables():
        now[(r["fid"], r["customerId"], r["unitId"])] += r["total"]
    act = defaultdict(lambda: defaultdict(int))
    after = defaultdict(int)
    label = {}
    for x in lines:
        k = _key_of(d, x)
        label.setdefault(k, (x["tenant"], x["unit"]))
        is_ar = x["account"] == "ACCOUNT_RECEIVABLE"
        if x["date"] > end:
            if is_ar:
                after[k] += x["debit"] - x["credit"]
            continue
        if is_ar:
            act[k]["_net"] += x["debit"] - x["credit"]
        elif (x["fid"], x["journal"]) in with_ar:
            act[k][_ar_cat(x)] += x["credit"] - x["debit"]
    rows = []
    for k in set(now) | set(act) | set(after):
        fid, cid, uid = k
        a = act.get(k, {})
        ending = now.get(k, 0) - after.get(k, 0)
        net = a.get("_net", 0)
        cats = {c: a.get(c, 0) for c, _ in AR_CATS}
        # Lines with no counterpart in the journal (a balance moved between two
        # leases) still change the balance: whatever the columns miss is Other.
        cats["other"] += net - sum(cats.values())
        begin = ending - net
        if not (begin or ending or any(cats.values())):
            continue
        tenant, unit_name = label.get(k, ("", ""))
        u = d.all_units.get((fid, uid)) or {}
        rows.append({**_link(fid, cid, uid), "facility": d.fac[fid]["short"], "accountType": "Lease" if uid else "Tenant Account",
                     "tenant": _tenant_label(d, fid, cid, tenant), "unit": u.get("name") or unit_name,
                     "beginning": begin, **cats, "ending": ending})
    rows.sort(key=lambda r: (r["facility"], r["unit"], r["tenant"]))
    cols = ([_col("facility", "Facility"), _col("accountType", "Account Type"), _col("tenant", "Tenant", "tenant"),
             _col("unit", "Unit", "unit"), _col("beginning", "Beginning AR Balance", "money", True)]
            + [_col(c, lbl, "money", True) for c, lbl in AR_CATS] + [_col("ending", "Ending AR Balance", "money", True)])
    notes = warnings + [
        "From Cubby's accrual ledger. Each column is what it did to the balance: charges add, payments, waivers and "
        "discounts subtract, so Beginning + every column = Ending.",
        "Balances are today's aged receivables less what posted after the period - Cubby's ledger nets to the same figure "
        "from each lease's first day, imported balances included."]
    return cols, rows, notes, None, stamp


def _balances(d: Data, start, end):
    """Point in time: what is held on each balance account through `end`."""
    accounts = {"ACCOUNT_RECEIVABLE": 1, "PREPAID_RENT": -1, "DEPOSIT": -1, "OLD_SYSTEM_DEPOSIT": -1, "CREDITS": -1}
    after, warnings, stamp = _after(d, end, accounts)
    bal = defaultdict(lambda: defaultdict(int))
    for r in d.receivables():
        bal[(r["fid"], r["customerId"], r["unitId"])]["ar"] += r["total"]
    for u in d.units.values():
        if u["customerId"]:
            k = (u["fid"], u["customerId"], u["id"])
            for f in ("prepaid", "deposit", "credit"):
                bal[k][f] += u[f]
    field = {"ACCOUNT_RECEIVABLE": "ar", "PREPAID_RENT": "prepaid", "DEPOSIT": "deposit", "OLD_SYSTEM_DEPOSIT": "deposit",
             "CREDITS": "credit"}
    for acct, by in after.items():
        for k, v in by.items():
            bal[k][field[acct]] -= v
    sub_cols = [_col("tenant", "Tenant", "tenant"), _col("unit", "Unit", "unit"), _col("ar", "Accounts Receivable", "money", True),
                _col("prepaid", "Prepaid Rent", "money", True), _col("deposit", "Deposits", "money", True),
                _col("credit", "Credits", "money", True), _col("net", "Net Owed", "money", True)]
    per = {fid: {"ar": 0, "prepaid": 0, "deposit": 0, "credit": 0, "tenants": 0, "lines": []} for fid in d.ids}
    for (fid, cid, uid), b in bal.items():
        if not any(b.values()) or fid not in per:
            continue
        p = per[fid]
        for f in ("ar", "prepaid", "deposit", "credit"):
            p[f] += b[f]
        p["tenants"] += 1
        p["lines"].append({**_link(fid, cid, uid), "tenant": _tenant_label(d, fid, cid),
                           "unit": (d.all_units.get((fid, uid)) or {}).get("name", ""),
                           "ar": b["ar"], "prepaid": b["prepaid"], "deposit": b["deposit"], "credit": b["credit"],
                           "net": b["ar"] - b["prepaid"] - b["credit"]})
    rows, groups = [], {}
    for fid in d.ids:
        p = per[fid]
        sub = f"{fid}:balances"
        groups[sub] = {"columns": sub_cols, "rows": sorted(p["lines"], key=lambda r: (r["unit"], r["tenant"]))}
        rows.append({**_link(fid), "_sub": sub, "facility": d.fac[fid]["short"], "ar": p["ar"], "prepaid": p["prepaid"],
                     "deposit": p["deposit"], "credit": p["credit"], "net": p["ar"] - p["prepaid"] - p["credit"],
                     "tenants": p["tenants"]})
    cols = [_col("facility", "Facility"), _col("ar", "Accounts Receivable", "money", True),
            _col("prepaid", "Prepaid Rent", "money", True), _col("deposit", "Deposits", "money", True),
            _col("credit", "Credits", "money", True), _col("net", "Net Owed", "money", True),
            _col("tenants", "Accounts With a Balance", "int", True)]
    notes = warnings + ["Through the selected date: today's balances less what Cubby's accrual ledger posted after it. "
                        "Net Owed is receivables less prepaid rent and credits. Click a facility for every tenant."]
    return cols, rows, notes, None, stamp, groups


COVERAGE_LABEL = {"ORGANISATION": "Facility Plan", "ORGANIZATION": "Facility Plan", "PRIVATE_POLICY": "Private Policy"}


def _coverage_label(t: str) -> str:
    return COVERAGE_LABEL.get(t) or (_tidy(t) if t and t != "NONE" else "None")


def _coverage_roll(d: Data, start, end):
    kinds = {"ORGANISATION", "ORGANIZATION"} | ({"PRIVATE_POLICY"} if d.opts.get("includePrivate") else set())
    rows = []
    for r in d.rentals():
        if r["covType"] not in kinds or not r["moveIn"] or r["moveIn"] > end or (r["moveOut"] and r["moveOut"] < start):
            continue
        if r["covStart"] and r["covStart"] > end:
            continue
        rows.append({**_link(r["fid"], r["customerId"], r["unitId"]), "facility": d.fac[r["fid"]]["short"], "unit": r["unit"],
                     "tenant": _tenant_label(d, r["fid"], r["customerId"]), "coverage": _coverage_label(r["covType"]),
                     "covAmount": r["covAmount"] or None, "premium": r["premium"] or None,
                     "covStart": r["covStart"] or r["moveIn"], "moveIn": r["moveIn"], "moveOut": r["moveOut"],
                     "policyExpires": r["policyExpires"],
                     "policyOnFile": ("Yes" if r["policyOnFile"] else "No") if r["covType"] == "PRIVATE_POLICY" else ""})
    rows.sort(key=lambda r: (r["facility"], r["unit"]))
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("tenant", "Tenant", "tenant"),
            _col("coverage", "Coverage"), _col("covAmount", "Coverage Amount", "money", True),
            _col("premium", "Monthly Premium", "money", True), _col("covStart", "Coverage Start", "date"),
            _col("moveIn", "Move-In Date", "date"), _col("moveOut", "Move-Out Date", "date")]
    if d.opts.get("includePrivate"):
        cols += [_col("policyOnFile", "Policy On File"), _col("policyExpires", "Policy Expires", "date")]
    return cols, rows, ["From the coverage on each lease in Cubby (the last sync). Coverage Start is the lease's move-in "
                        "when Cubby has no start date; a lease that changed plans shows the plan it has now."]


def _coverage_activity(d: Data, start, end):
    accrual, w1, s1 = _gl_lines(d, start, end, "accrual")
    cash, w2, s2 = _gl_lines(d, start, end, "cash")
    act = defaultdict(lambda: {"charged": 0, "paid": 0, "returned": 0})
    label = {}
    for x in accrual:
        if x["account"] == "INSURANCE":
            k = _key_of(d, x)
            act[k]["charged"] += x["credit"] - x["debit"]
            label.setdefault(k, (x["tenant"], x["unit"]))
    for x in cash:
        if x["account"] == "INSURANCE":
            k = _key_of(d, x)
            act[k]["paid"] += x["credit"]
            act[k]["returned"] += x["debit"]
            label.setdefault(k, (x["tenant"], x["unit"]))
    cov = {}
    for r in d.rentals():
        cov.setdefault((r["fid"], r["customerId"], r["unitId"]), r)
        if not r["moveOut"]:
            cov[(r["fid"], r["customerId"], r["unitId"])] = r
    rows = []
    for k, a in act.items():
        if not any(a.values()):
            continue
        fid, cid, uid = k
        r = cov.get(k) or {}
        tenant, unit_name = label.get(k, ("", ""))
        rows.append({**_link(fid, cid, uid), "facility": d.fac[fid]["short"], "unit": r.get("unit") or unit_name,
                     "tenant": _tenant_label(d, fid, cid, tenant), "coverage": _coverage_label(r.get("covType", "")),
                     "premium": r.get("premium") or None, **a, "net": a["paid"] - a["returned"],
                     "unpaid": a["charged"] - a["paid"] + a["returned"]})
    rows.sort(key=lambda r: (r["facility"], r["unit"]))
    cols = [_col("facility", "Facility"), _col("unit", "Unit", "unit"), _col("tenant", "Tenant", "tenant"),
            _col("coverage", "Coverage"), _col("premium", "Monthly Premium", "money"),
            _col("charged", "Premium Charged", "money", True), _col("paid", "Paid", "money", True),
            _col("returned", "Refunded or Failed", "money", True), _col("net", "Net Paid", "money", True),
            _col("unpaid", "Charged Not Paid", "money", True)]
    stamps = [s for s in (s1, s2) if s]
    return cols, rows, sorted(set(w1 + w2)) + [
        "Premium Charged is the Insurance account in Cubby's accrual ledger; Paid and Refunded or Failed are the same "
        "account in the cash ledger (a refund or a returned payment takes the premium back)."], None, min(stamps) if stamps else ""


def _per_facility(d: Data, start, end) -> dict:
    """The figures Facility Portfolio adds up, per facility."""
    per = {fid: defaultdict(int) for fid in d.ids}
    active = {}
    today = d.today.isoformat()
    for r in d.rentals():
        x = per[r["fid"]]
        x["moveIns"] += 1 if r["moveIn"] and start <= r["moveIn"] <= end else 0
        x["moveOuts"] += 1 if r["moveOut"] and start <= r["moveOut"] <= end else 0
        if r["moveIn"] and r["moveIn"] <= today and (not r["moveOut"] or r["moveOut"] > today):
            active[(r["fid"], r["unitId"])] = r
    for u in d.units.values():
        x = per[u["fid"]]
        x["units"] += 1
        x["area"] += u["area"]
        if u["status"] == "RENTED":
            x["rented"] += 1
            x["rentedArea"] += u["area"]
            x["rentRoll"] += u["rent"]
            x["autoPay"] += 1 if u["autoPay"] else 0
            r = active.get((u["fid"], u["id"])) or {}
            x["covered"] += 1 if r.get("covType") in ("ORGANISATION", "ORGANIZATION") else 0
            x["insured"] += 1 if r.get("covType") in ("ORGANISATION", "ORGANIZATION", "PRIVATE_POLICY") else 0
    for p in d.payments(start, end):
        if p["status"] == "SUCCEEDED":
            per[p["fid"]]["receipts"] += p["amount"]
    for r in d.receivables():
        per[r["fid"]]["pastDue"] += r["total"]
        per[r["fid"]]["pastDueUnits"] += 1
    for ld in d.leads():
        if ld["created"] and start <= ld["created"] <= end and ld["status"] != "DUPLICATE":
            per[ld["fid"]]["leads"] += 1
            per[ld["fid"]]["converted"] += 1 if ld["status"] == "CONVERTED" else 0
    return per


def _portfolio(d: Data, start, end):
    per = _per_facility(d, start, end)
    cols = [_col("facility", "Facility"), _col("units", "Units", "int", True), _col("rented", "Occupied", "int", True),
            _col("occ", "Unit Occupancy", "pct"), _col("areaOcc", "Area Occupancy", "pct"),
            _col("rentRoll", "Rent Roll", "money", True), _col("pastDue", "Past Due", "money", True),
            _col("delinquency", "Delinquency", "pct"), _col("pastDueUnits", "Units Past Due", "int", True),
            _col("autoPay", "On Autopay", "pct"), _col("covered", "Facility Coverage", "pct"),
            _col("insured", "Covered or Insured", "pct"), _col("receipts", "Receipts", "money", True),
            _col("moveIns", "Move-Ins", "int", True), _col("moveOuts", "Move-Outs", "int", True),
            _col("net", "Net Move-Ins", "int", True), _col("leads", "New Leads", "int", True),
            _col("converted", "Leads Converted", "int", True), _col("conversion", "Lead Conversion", "pct")]

    def line(x, label, fid=""):
        return {**_link(fid), "facility": label, "units": x["units"], "rented": x["rented"], "occ": _pct(x["rented"], x["units"]),
                "areaOcc": _pct(x["rentedArea"], x["area"]), "rentRoll": x["rentRoll"], "pastDue": x["pastDue"],
                "delinquency": _pct(x["pastDue"], x["rentRoll"]), "pastDueUnits": x["pastDueUnits"],
                "autoPay": _pct(x["autoPay"], x["rented"]), "covered": _pct(x["covered"], x["rented"]),
                "insured": _pct(x["insured"], x["rented"]), "receipts": x["receipts"], "moveIns": x["moveIns"],
                "moveOuts": x["moveOuts"], "net": x["moveIns"] - x["moveOuts"], "leads": x["leads"],
                "converted": x["converted"], "conversion": _pct(x["converted"], x["leads"])}
    rows = [line(per[fid], d.fac[fid]["short"], fid) for fid in d.ids]
    total = defaultdict(int)
    for x in per.values():
        for k, v in x.items():
            total[k] += v
    return cols, rows, ["Occupancy, rent roll, past due, autopay and coverage are as of the last Cubby sync; receipts, "
                        "moves and leads are the period's. Delinquency is past due as a share of the monthly rent roll."], \
        line(total, "All Facilities")


def _gross_potential(d: Data, start, end):
    groups: dict = {}
    for u in d.units.values():
        g = groups.setdefault((u["fid"], u["type"]), {"units": 0, "rented": 0, "vacant": 0, "off": 0, "potential": 0,
                                                      "actual": 0, "loss": 0, "variance": 0, "list": []})
        g["units"] += 1
        g["potential"] += u["street"]
        g["list"].append(u)
        if u["status"] == "RENTED":
            g["rented"] += 1
            g["actual"] += u["rent"]
            g["variance"] += u["rent"] - u["street"]
        else:
            g["vacant" if u["status"] == "VACANT" else "off"] += 1
            g["loss"] += u["street"]
    sub_cols = [_col("unit", "Unit", "unit"), _col("size", "Size"), _col("status", "Status"), _col("tenant", "Tenant", "tenant"),
                _col("street", "Street Rate", "money", True), _col("rent", "Monthly Rent", "money", True),
                _col("variance", "Rent vs Street", "money", True), _col("moveIn", "Move-In Date", "date")]
    rows, subs = [], {}
    for (fid, t), g in sorted(groups.items(), key=lambda kv: (d.fac[kv[0][0]]["short"], kv[0][1])):
        sub = f"{fid}:{t}"
        subs[sub] = {"columns": sub_cols, "rows": [
            {**_link(u["fid"], u["customerId"], u["id"]), "unit": u["name"], "size": u["size"], "status": u["statusLabel"],
             "tenant": u["tenant"], "street": u["street"], "rent": u["rent"] if u["status"] == "RENTED" else None,
             "variance": (u["rent"] - u["street"]) if u["status"] == "RENTED" else None, "moveIn": u["moveIn"]}
            for u in sorted(g["list"], key=lambda u: u["name"])]}
        rows.append({**_link(fid), "_sub": sub, "facility": d.fac[fid]["short"], "type": t, "units": g["units"],
                     "rented": g["rented"], "vacant": g["vacant"], "off": g["off"], "occ": _pct(g["rented"], g["units"]),
                     "potential": g["potential"], "actual": g["actual"], "loss": g["loss"], "variance": g["variance"],
                     "econ": _pct(g["actual"], g["potential"])})
    cols = [_col("facility", "Facility"), _col("type", "Unit Type"), _col("units", "Units", "int", True),
            _col("rented", "Occupied", "int", True), _col("vacant", "Vacant", "int", True), _col("off", "Off Market", "int", True),
            _col("occ", "Unit Occupancy", "pct"), _col("potential", "Gross Potential Rent", "money", True),
            _col("actual", "Actual Rent", "money", True), _col("loss", "Vacancy Loss", "money", True),
            _col("variance", "Rate Variance", "money", True), _col("econ", "Economic Occupancy", "pct")]
    return cols, rows, ["Gross potential is the street (standard) rate on every unit; Cubby's API has no target rate. "
                        "Gross Potential = Actual Rent + Vacancy Loss - Rate Variance. Click a line for its units."], \
        None, "", subs


SPLITS = {"day", "week", "month", "quarter", "year"}
MAX_BUCKETS = 120


def buckets(start: str, end: str, split: str) -> list[tuple[str, str, str]]:
    """[(label, from, to)] covering start..end, cut at whole days, weeks
    (Sunday to Saturday), months, quarters or years; the ends are clipped."""
    from datetime import timedelta
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    out = []
    cur = a
    while cur <= b:
        if split == "day":
            lo, hi, label = cur, cur, cur.strftime("%m/%d/%Y")
        elif split == "week":
            lo = cur - timedelta(days=(cur.weekday() + 1) % 7)
            hi, label = lo + timedelta(days=6), f"Week of {lo.strftime('%m/%d/%Y')}"
        elif split == "month":
            lo = cur.replace(day=1)
            hi = date(lo.year + (lo.month == 12), lo.month % 12 + 1, 1) - timedelta(days=1)
            label = lo.strftime("%B %Y")
        elif split == "quarter":
            q = (cur.month - 1) // 3
            lo = date(cur.year, q * 3 + 1, 1)
            hi = date(cur.year + (q == 3), (q * 3 + 3) % 12 + 1, 1) - timedelta(days=1)
            label = f"Q{q + 1} {cur.year}"
        else:
            lo, hi, label = date(cur.year, 1, 1), date(cur.year, 12, 31), str(cur.year)
        out.append((label, max(lo, a).isoformat(), min(hi, b).isoformat()))
        if len(out) > MAX_BUCKETS:
            raise ReportError(422, f"That is more than {MAX_BUCKETS} periods: pick a shorter period or split by a longer one")
        cur = hi + timedelta(days=1)
    return out


def _historical(d: Data, start, end):
    split = d.opts.get("split") or "month"
    cuts = buckets(start, end, split)
    rentals = d.rentals()
    pays = d.payments(start, end)
    leads = d.leads()
    units = defaultdict(int)
    for u in d.units.values():
        units[u["fid"]] += 1
    today = d.today.isoformat()
    rows = []
    for label, a, b in cuts:
        at = min(b, today)
        per = {fid: defaultdict(int) for fid in d.ids}
        for r in rentals:
            x = per[r["fid"]]
            x["moveIns"] += 1 if r["moveIn"] and a <= r["moveIn"] <= b else 0
            x["moveOuts"] += 1 if r["moveOut"] and a <= r["moveOut"] <= b else 0
            if r["moveIn"] and r["moveIn"] <= at and (not r["moveOut"] or r["moveOut"] > at):
                x["occupied"] += 1
                x["rentRoll"] += r["rent"]
        for p in pays:
            if a <= p["date"] <= b:
                if p["status"] == "SUCCEEDED":
                    per[p["fid"]]["receipts"] += p["amount"]
                elif p["status"] in FAILED:
                    per[p["fid"]]["failed"] += 1
        for ld in leads:
            if ld["created"] and a <= ld["created"] <= b and ld["status"] != "DUPLICATE":
                per[ld["fid"]]["leads"] += 1
                per[ld["fid"]]["converted"] += 1 if ld["status"] == "CONVERTED" else 0
        for fid in d.ids:
            x = per[fid]
            rows.append({**_link(fid), "period": label, "from": a, "to": b, "facility": d.fac[fid]["short"],
                         "units": units[fid], "occupied": x["occupied"], "occ": _pct(x["occupied"], units[fid]),
                         "rentRoll": x["rentRoll"], "moveIns": x["moveIns"], "moveOuts": x["moveOuts"],
                         "net": x["moveIns"] - x["moveOuts"], "receipts": x["receipts"], "failed": x["failed"],
                         "leads": x["leads"], "converted": x["converted"]})
    cols = [_col("period", "Period"), _col("from", "From", "date"), _col("to", "To", "date"), _col("facility", "Facility"),
            _col("units", "Units", "int"), _col("occupied", "Occupied at Period End", "int"), _col("occ", "Unit Occupancy", "pct"),
            _col("rentRoll", "Rent Roll at Period End", "money"), _col("moveIns", "Move-Ins", "int", True),
            _col("moveOuts", "Move-Outs", "int", True), _col("net", "Net Move-Ins", "int", True),
            _col("receipts", "Receipts", "money", True), _col("failed", "Failed Payments", "int", True),
            _col("leads", "New Leads", "int", True), _col("converted", "Leads Converted", "int", True)]
    return cols, rows, ["Occupied units and rent roll at each period end are rebuilt from Cubby's lease history at each "
                        "lease's current rent; Units is today's count. Receipts start at the cutover (09/15/2026)."]


# ── Credits Issued (Oct 28 2026 call, B13) ───────────────────────────────────
#
# Cubby posts every credit to the accrual ledger: GIVEN_CREDITS when someone
# issues account credit ("Issued credits to account: Referral to ..."), the
# WAIVED_* accounts when a charge is waived ("Waive: Rent"), DISCOUNTS when a
# promotion takes money off rent (left out unless asked: nobody issued it).
# The debit is the credit; a line on the credit side reverses one. USED_CREDITS
# / CREDITS are a tenant spending credit they already had - not new credit.
# Cubby's ledger carries no employee on any line (checked on dev, 11/23/2026:
# no user, creator or employee field on 26,000 cash and accrual lines), so the
# report says so instead of showing an empty Issued By column.

CREDIT_KINDS = {"GIVEN_CREDITS": "Credit Given", "WAIVED_RENT": "Rent Waived", "WAIVED_FEES": "Fee Waived",
                "WAIVED_DAMAGE": "Damage Waived"}
_REASON_PREFIXES = ("issued credits to account:", "waive:", "waived:")


def _credit_reason(text: str) -> str:
    t = (text or "").strip()
    low = t.lower()
    for p in _REASON_PREFIXES:
        if low.startswith(p):
            return t[len(p):].strip()
    return t


def _credits(d: Data, start, end):
    lines, warnings, stamp = _gl_lines(d, start, end, "accrual")
    kinds = dict(CREDIT_KINDS)
    if d.opts.get("includeDiscounts"):
        kinds["DISCOUNTS"] = "Discount"
    rows = []
    for x in lines:
        kind = kinds.get(x["account"])
        amount = x["debit"] - x["credit"]
        if not kind or not amount:
            continue
        uid = x["unitId"] or _unit_id(d, x["fid"], x["unit"])
        if (x["fid"], uid) in d.skipped:
            continue
        rows.append({**_link(x["fid"], x["customerId"], uid), "facility": x["facility"], "date": x["date"],
                     "tenant": _tenant_label(d, x["fid"], x["customerId"], x["tenant"]), "unit": x["unit"],
                     "kind": kind if amount > 0 else f"{kind} (Reversed)", "reason": _credit_reason(x["description"]),
                     "amount": amount})
    rows.sort(key=lambda r: (r["date"], r["facility"], r["unit"]), reverse=True)
    cols = [_col("facility", "Facility"), _col("date", "Date", "date"), _col("tenant", "Tenant", "tenant"),
            _col("unit", "Unit", "unit"), _col("kind", "Kind"), _col("reason", "Reason"),
            _col("amount", "Amount", "money", True)]
    notes = warnings + [
        "From Cubby's accrual ledger: credits given to a tenant's account and charges waived, each on the day it posted. "
        "A reversed line takes one back.",
        "Cubby's ledger does not record which employee issued a credit, so this report cannot show who did."]
    if not d.opts.get("includeDiscounts"):
        notes.append("Promotion discounts are left out - turn on Include Discounts and Promotions to list them.")
    return cols, rows, notes, None, stamp


BUILDERS = {
    "credits-issued": _credits,
    "rent-roll": _rent_roll, "aged-receivables": _receivables, "occupancy-statistics": _occupancy,
    "vacant-units": _vacant, "management-summary": _management, "move-in-move-out-detail": _moves,
    "payment-detail": _payment_detail, "receipts-summary": _receipts_summary, "leads-activity": _leads,
    "general-ledger-cash": lambda d, a, b: _gl_detail(d, a, b, "cash"),
    "general-ledger-accrual": lambda d, a, b: _gl_detail(d, a, b, "accrual"),
    "receipts-by-charge-type": _receipts_by_charge, "receipts-by-tax-category": _receipts_by_tax,
    "merchant-disbursements": _disbursements, "lease-compliance": _compliance,
    "ar-activity": _ar_activity, "balances-summary": _balances, "coverage-roll": _coverage_roll,
    "coverage-activity": _coverage_activity, "facility-portfolio": _portfolio, "gross-potential": _gross_potential,
    "historical-management-summary": _historical,
}


def _totals(cols, rows) -> dict:
    out = {}
    for c in cols:
        if c["total"]:
            out[c["key"]] = sum(r.get(c["key"]) or 0 for r in rows)
    return out


# ── Headline figures (summary) ────────────────────────────────────────────────

def _s(label, value, type_="money"):
    return {"label": label, "value": value, "type": type_}


def _n(rows, pred=None) -> int:
    return sum(1 for r in rows if pred is None or pred(r))


def _sum(rows, key, pred=None) -> int:
    return sum(r.get(key) or 0 for r in rows if pred is None or pred(r))


def _sum_rent_roll(rows, t, d):
    units = len(d.units)          # every unit, also when the rows show only occupied ones
    rented = _n(rows, lambda r: r["status"] == "Rented")
    return [_s("Units", units, "int"), _s("Occupied", rented, "int"), _s("Unit Occupancy", _pct(rented, units), "pct"),
            _s("Rent Roll", t.get("rent") or 0), _s("Past Due", t.get("balance") or 0),
            _s("On Autopay", _pct(_n(rows, lambda r: r["autoPay"] == "Yes"), rented), "pct")]


def _sum_management(rows, t):
    return [_s("Unit Occupancy", t.get("occ"), "pct"), _s("Rent Roll", t.get("rentRoll") or 0),
            _s("Receipts", t.get("receipts") or 0), _s("Net Move-Ins", t.get("net") or 0, "int"),
            _s("Past Due", t.get("pastDue") or 0), _s("New Leads", t.get("leads") or 0, "int")]


def _sum_ar(rows, t):
    charges = sum(t.get(c) or 0 for c in CHARGE_CATS)
    return [_s("Beginning Balance", t.get("beginning") or 0), _s("Charges", charges),
            _s("Payments", (t.get("payments") or 0) + (t.get("refunds") or 0) + (t.get("reversals") or 0)),
            _s("Waivers and Discounts", sum(t.get(c) or 0 for c in ("waivedRent", "waivedFees", "discounts"))),
            _s("Ending Balance", t.get("ending") or 0), _s("Accounts", len(rows), "int")]


def _sum_occupancy(rows, t):
    longest = [r["maxDaysVacant"] for r in rows if r.get("maxDaysVacant") is not None]
    return [_s("Units", t.get("units") or 0, "int"), _s("Occupied", t.get("rented") or 0, "int"),
            _s("Unit Occupancy", _pct(t.get("rented") or 0, t.get("units") or 0), "pct"),
            _s("Area Occupancy", _pct(t.get("rentedArea") or 0, t.get("area") or 0), "pct"),
            _s("Economic Occupancy", _pct(t.get("rent") or 0, t.get("potential") or 0), "pct"),
            _s("Longest Vacant (Days)", max(longest) if longest else None, "int")]


def _sum_moves(rows, t):
    ins, outs = _n(rows, lambda r: r["kind"] == "Move-In"), _n(rows, lambda r: r["kind"] == "Move-Out")
    stays = [r["stay"] for r in rows if r.get("stay") is not None]
    return [_s("Move-Ins", ins, "int"), _s("Move-Outs", outs, "int"), _s("Net Move-Ins", ins - outs, "int"),
            _s("Average Stay (Days)", round(sum(stays) / len(stays)) if stays else None, "int")]


SUMMARIES = {
    "rent-roll": _sum_rent_roll,
    "occupancy-statistics": _sum_occupancy,
    "vacant-units": lambda rows, t: [
        _s("Vacant", _n(rows, lambda r: r["status"] == "Vacant"), "int"), _s("Off Market", _n(rows, lambda r: r["status"] != "Vacant"), "int"),
        _s("Vacant Sq Ft", t.get("area") or 0, "int"), _s("Street Rent Not Collected", t.get("street") or 0),
        _s("Average Days Vacant", (lambda v: round(sum(v) / len(v)) if v else None)([r["daysVacant"] for r in rows if r["daysVacant"] is not None]), "int")],
    "management-summary": _sum_management,
    "facility-portfolio": lambda rows, t: [
        _s("Unit Occupancy", t.get("occ"), "pct"), _s("Rent Roll", t.get("rentRoll") or 0), _s("Delinquency", t.get("delinquency"), "pct"),
        _s("On Autopay", t.get("autoPay"), "pct"), _s("Receipts", t.get("receipts") or 0), _s("Net Move-Ins", t.get("net") or 0, "int")],
    "gross-potential": lambda rows, t: [
        _s("Gross Potential Rent", t.get("potential") or 0), _s("Actual Rent", t.get("actual") or 0), _s("Vacancy Loss", t.get("loss") or 0),
        _s("Rate Variance", t.get("variance") or 0), _s("Economic Occupancy", _pct(t.get("actual") or 0, t.get("potential") or 0), "pct")],
    "historical-management-summary": lambda rows, t: [
        _s("Periods", len({r["period"] for r in rows}), "int"), _s("Move-Ins", t.get("moveIns") or 0, "int"),
        _s("Move-Outs", t.get("moveOuts") or 0, "int"), _s("Receipts", t.get("receipts") or 0), _s("New Leads", t.get("leads") or 0, "int")],
    "ar-activity": _sum_ar,
    "aged-receivables": lambda rows, t: [
        _s("Total Due", t.get("total") or 0), _s("Accounts", len(rows), "int"),
        _s("Over 30 Days", (t.get("total") or 0) - (t.get("range_0_30") or 0)),
        _s("Over 90 Days", (t.get("range_90_120") or 0) + (t.get("range_120_plus") or 0))],
    "balances-summary": lambda rows, t: [
        _s("Accounts Receivable", t.get("ar") or 0), _s("Prepaid Rent", t.get("prepaid") or 0), _s("Deposits", t.get("deposit") or 0),
        _s("Credits", t.get("credit") or 0), _s("Net Owed", t.get("net") or 0), _s("Accounts With a Balance", t.get("tenants") or 0, "int")],
    "payment-detail": lambda rows, t: [
        _s("Received", _sum(rows, "amount", lambda r: r["status"] == "Succeeded")), _s("Payments", len(rows), "int"),
        _s("Failed", _n(rows, lambda r: r["status"].upper().replace(" ", "_") in FAILED), "int"),
        _s("Refunded", _sum(rows, "amount", lambda r: r["status"].upper().replace(" ", "_") in REFUNDED))],
    "receipts-summary": lambda rows, t: [
        _s("Received", t.get("amount") or 0), _s("Payments", t.get("count") or 0, "int"), _s("Failed", t.get("failed") or 0, "int"),
        _s("Refunded", t.get("refundedAmount") or 0),
        _s("Top Method", max(rows, key=lambda r: r["amount"])["method"] if rows else "", "text")],
    "merchant-disbursements": lambda rows, t: [
        _s("Disbursed", t.get("amount") or 0), _s("Batches", len(rows), "int"), _s("Payments", t.get("count") or 0, "int")],
    "receipts-by-charge-type": lambda rows, t: [
        _s("Received", t.get("amount") or 0)] + [
        _s(lbl, _sum(rows, "amount", lambda r, lbl=lbl: r["charge"] == lbl)) for lbl in ("Rent", "Fees", "Insurance")],
    "receipts-by-tax-category": lambda rows, t: [
        _s("Tax Collected", t.get("collected") or 0), _s("Receipts Taxed", _sum(rows, "taxable", lambda r: r["tax"] != "Not Taxed")),
        _s("Receipts Not Taxed", _sum(rows, "taxable", lambda r: r["tax"] == "Not Taxed"))],
    "general-ledger-cash": lambda rows, t: [
        _s("Lines", len(rows), "int"), _s("Debits", t.get("debit") or 0), _s("Credits", t.get("credit") or 0)],
    "general-ledger-accrual": lambda rows, t: [
        _s("Lines", len(rows), "int"), _s("Debits", t.get("debit") or 0), _s("Credits", t.get("credit") or 0)],
    "move-in-move-out-detail": _sum_moves,
    "credits-issued": lambda rows, t: [
        _s("Credits Issued", t.get("amount") or 0), _s("Lines", len(rows), "int"),
        _s("Credits Given", _sum(rows, "amount", lambda r: r["kind"].startswith("Credit Given"))),
        _s("Waivers", _sum(rows, "amount", lambda r: "Waived" in r["kind"])),
        _s("Tenants", len({(r["_f"], r["_c"]) for r in rows if r["_c"]}), "int")],
    "leads-activity": lambda rows, t: [
        _s("New Leads", len(rows), "int"), _s("Converted", _n(rows, lambda r: r["status"] == "Converted"), "int"),
        _s("Conversion", _pct(_n(rows, lambda r: r["status"] == "Converted"), len(rows)), "pct"),
        _s("Reserved", _n(rows, lambda r: r["status"] == "Reserved"), "int")],
    "lease-compliance": lambda rows, t: [
        _s("Leases With Open Documents", len(rows), "int"), _s("Documents Open", t.get("missing") or 0, "int"),
        _s("Unsigned Lease Agreements", _n(rows, lambda r: r.get("leaseAgreement") not in ("", "Approved", "Not Required")), "int")],
    "coverage-roll": lambda rows, t: [
        _s("Leases Covered", len(rows), "int"), _s("Facility Plan", _n(rows, lambda r: r["coverage"] == "Facility Plan"), "int"),
        _s("Monthly Premium", t.get("premium") or 0), _s("Coverage Amount", t.get("covAmount") or 0)],
    "coverage-activity": lambda rows, t: [
        _s("Leases", len(rows), "int"), _s("Premium Charged", t.get("charged") or 0), _s("Paid", t.get("paid") or 0),
        _s("Refunded or Failed", t.get("returned") or 0)],
}


# ── Preset columns and the person's columns (Oct 28 2026 call, B5 / B10) ─────
#
# A library of ready-made columns any report can take, as Hummingbird had:
# each is read from the synced Cubby rows for the unit or tenant a report line
# already points at (`_u` / `_c`), so a line about no one unit (a unit type, a
# facility) leaves it blank. The person's arrangement - which columns show and
# in what order, the sort and the column filters - travels as report options
# (SHAPE_OPTIONS) so a memorized or scheduled report, and every export, comes
# out exactly as it was on screen.

def _unit_class_label(d: Data, u: dict) -> str:
    import ops_unit_classes as uc
    kind = uc.unit_class(u["type"], d.rules)
    if kind == uc.MAILBOX:
        return "Mailbox"
    if kind == uc.EXCLUDED:
        return "Switched Off"
    if uc.is_nonstandard(u["type"], u["street"], d.rules):
        return "Non-Standard"
    return "Vehicle Storage" if _is_parking(u["type"]) else "Self Storage"


def _months_since(d: Data, u: dict, day: str):
    if not day:
        return None
    try:
        a, b = date.fromisoformat(day), d.fac[u["fid"]]["today"]
    except (ValueError, KeyError):
        return None
    return max(0, (b.year - a.year) * 12 + b.month - a.month - (b.day < a.day))


class _PresetCtx:
    """What the preset getters read, each built once per report."""

    def __init__(self, d: Data):
        self.d = d
        self._owed = self._lease = self._tenant = None

    @property
    def owed(self) -> dict:
        if self._owed is None:
            self._owed = defaultdict(int)
            for r in self.d.receivables():
                self._owed[(r["fid"], r["unitId"])] += r["total"]
        return self._owed

    @property
    def lease(self) -> dict:
        """{(fid, unit_id): the unit's current lease}."""
        if self._lease is None:
            self._lease = {}
            for r in self.d.rentals():
                today = self.d.fac[r["fid"]]["today"].isoformat()
                if not r["moveOut"] or r["moveOut"] > today:
                    self._lease[(r["fid"], r["unitId"])] = r
        return self._lease

    @property
    def tenant(self) -> dict:
        """{(fid, customer_id): {units, rent, balance}} - every unit they rent now."""
        if self._tenant is None:
            out = defaultdict(lambda: {"units": [], "rent": 0, "balance": 0})
            for u in self.d.all_units.values():
                if u["customerId"]:
                    t = out[(u["fid"], u["customerId"])]
                    t["units"].append(u["name"])
                    t["rent"] += u["rent"]
            for r in self.d.receivables():
                if r["customerId"]:
                    out[(r["fid"], r["customerId"])]["balance"] += r["total"]
            self._tenant = dict(out)
        return self._tenant


_COVERAGE = {"ORGANISATION": "Facility Plan", "ORGANIZATION": "Facility Plan", "PRIVATE": "Own Policy"}


def _lease_of(c, u) -> dict:
    return c.lease.get((u["fid"], u["id"])) or {}


# key: (label, type, level, getter(ctx, unit or tenant)) - level "unit" reads
# the unit the line points at, "tenant" the tenant.
PRESETS = {
    "unitType": ("Unit Type", "text", "unit", lambda c, u: u["type"]),
    "unitClass": ("Unit Class", "text", "unit", lambda c, u: _unit_class_label(c.d, u)),
    "unitSize": ("Size", "text", "unit", lambda c, u: u["size"]),
    "unitArea": ("Area (Sq Ft)", "area", "unit", lambda c, u: u["area"] or None),
    "unitStatus": ("Unit Status", "text", "unit", lambda c, u: u["statusLabel"]),
    "tenantName": ("Tenant Name", "tenant", "unit", lambda c, u: u["tenant"]),
    "streetRate": ("Street Rate", "money", "unit", lambda c, u: u["street"]),
    "monthlyRent": ("Monthly Rent", "money", "unit", lambda c, u: u["rent"] if u["status"] == "RENTED" else None),
    "rentVsStreet": ("Rent vs Street", "money", "unit",
                     lambda c, u: (u["rent"] - u["street"]) if u["status"] == "RENTED" else None),
    "moveInDate": ("Move-In Date", "date", "unit", lambda c, u: u["moveIn"]),
    "monthsRented": ("Months Rented", "int", "unit", lambda c, u: _months_since(c.d, u, u["moveIn"])),
    "paidThrough": ("Paid Through", "date", "unit", lambda c, u: u["paidThrough"]),
    "autopay": ("Autopay", "text", "unit", lambda c, u: ("Yes" if u["autoPay"] else "No") if u["status"] == "RENTED" else ""),
    "overlocked": ("Overlocked", "text", "unit", lambda c, u: "Yes" if u["overlocked"] else "No"),
    "balanceDue": ("Balance Due", "money", "unit",
                   lambda c, u: c.owed.get((u["fid"], u["id"]), 0) if u["status"] == "RENTED" else None),
    "prepaid": ("Prepaid", "money", "unit", lambda c, u: u["prepaid"] or None),
    "depositHeld": ("Deposit Held", "money", "unit", lambda c, u: u["deposit"] or None),
    "creditOnAccount": ("Credit on Account", "money", "unit", lambda c, u: u["credit"] or None),
    "lastRentChange": ("Last Rent Change", "date", "unit", lambda c, u: u["lastChange"]),
    "monthsSinceChange": ("Months Since Rent Change", "int", "unit",
                          lambda c, u: _months_since(c.d, u, u["lastChange"] or u["moveIn"]) if u["status"] == "RENTED" else None),
    "nextRentDate": ("Next Rent Change", "date", "unit", lambda c, u: _lease_of(c, u).get("nextRentDate", "")),
    "nextRent": ("Next Rent", "money", "unit", lambda c, u: _lease_of(c, u).get("nextRent")),
    "coverage": ("Coverage", "text", "unit", lambda c, u: _COVERAGE.get(_lease_of(c, u).get("covType", ""), "")),
    "premium": ("Monthly Premium", "money", "unit", lambda c, u: _lease_of(c, u).get("premium") or None),
    "vacantSince": ("Vacant Since", "date", "unit", lambda c, u: _days_vacant(c.d, u)[0]),
    "daysVacant": ("Days Vacant", "int", "unit", lambda c, u: _days_vacant(c.d, u)[1]),
    "tenantUnits": ("Units Rented by Tenant", "text", "tenant", lambda c, t: ", ".join(sorted(t["units"]))),
    "tenantUnitCount": ("Number of Units Rented", "int", "tenant", lambda c, t: len(t["units"]) or None),
    "tenantRent": ("Tenant Monthly Rent", "money", "tenant", lambda c, t: t["rent"] or None),
    "tenantBalance": ("Tenant Balance Due", "money", "tenant", lambda c, t: t["balance"]),
}
PRESET_TOTALS = {"money"}
PRESET_PREFIX = "p_"

# Report options that shape the table rather than pick its data. Strings, so
# they ride the same simple options as every switch (routers/ops_reports._options).
SHAPE_OPTIONS = ("addColumns", "showColumns", "hideColumns", "sortBy", "filters")
MAX_SHAPE_LEN = 2000


def preset_catalog() -> list[dict]:
    return [{"key": k, "column": PRESET_PREFIX + k, "label": lbl, "type": t, "level": lvl}
            for k, (lbl, t, lvl, _) in PRESETS.items()]


def _keys(raw) -> list[str]:
    items = raw if isinstance(raw, (list, tuple)) else str(raw or "").split(",")
    return [k for k in dict.fromkeys(str(x).strip() for x in items) if k][:80]


def split_shape(options: dict | None) -> tuple[dict, dict]:
    """(the report's own options, the shape options)."""
    options = dict(options or {})
    shape = {k: options.pop(k) for k in SHAPE_OPTIONS if k in options}
    for v in shape.values():
        if isinstance(v, str) and len(v) > MAX_SHAPE_LEN:
            raise ReportError(422, "That column setup is too long to keep")
    return options, shape


def _add_presets(d: Data, cols: list, rows: list, keys: list[str]) -> list:
    wanted = [k for k in keys if k in PRESETS]
    if not wanted:
        return cols
    ctx = _PresetCtx(d)
    have = {c["key"] for c in cols}
    for k in wanted:
        label, type_, level, fn = PRESETS[k]
        key = PRESET_PREFIX + k
        if key in have:
            continue
        cols = cols + [_col(key, label, type_, type_ in PRESET_TOTALS)]
        for r in rows:
            v = None
            if level == "unit" and r.get("_u"):
                u = d.all_units.get((r.get("_f"), r["_u"]))
                v = fn(ctx, u) if u else None
            elif level == "tenant" and r.get("_c"):
                t = ctx.tenant.get((r.get("_f"), r["_c"]))
                v = fn(ctx, t) if t else None
            r[key] = None if v == "" else v
    return cols


def _filters(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, str):
        import json
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ReportError(422, "Column filters are a JSON object") from None
    return raw if isinstance(raw, dict) else {}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def filter_rows(cols: list, rows: list, raw) -> list:
    """The column filters a person set (frontend/src/operations/columnControls.js
    is the same rule): text that contains any of the words (commas between
    them), a number between `min` and `max` in the column's own units (cents
    for money), or a list of exact `values`."""
    spec = _filters(raw)
    by = {c["key"]: c for c in cols}
    tests = []
    for key, f in spec.items():
        if key not in by or not isinstance(f, dict):
            continue
        q = str(f.get("q") or "").strip().lower()
        lo, hi, vals = _num(f.get("min")), _num(f.get("max")), f.get("values")
        if isinstance(vals, list) and vals:
            allowed = {str(x) for x in vals}
            tests.append(lambda r, k=key, a=allowed: str(r.get(k) if r.get(k) is not None else "") in a)
        if q:
            words = [w.strip() for w in q.split(",") if w.strip()]
            tests.append(lambda r, k=key, w=words: any(x in str(r.get(k) or "").lower() for x in w))
        if by[key]["type"] == "date":
            # A date column takes YYYY-MM-DD bounds and compares them as days.
            dlo, dhi = str(f.get("min") or "")[:10], str(f.get("max") or "")[:10]
            if dlo:
                tests.append(lambda r, k=key, lo=dlo: bool(r.get(k)) and str(r[k])[:10] >= lo)
            if dhi:
                tests.append(lambda r, k=key, hi=dhi: bool(r.get(k)) and str(r[k])[:10] <= hi)
            continue
        if lo is not None:
            tests.append(lambda r, k=key, lo=lo: _num(r.get(k)) is not None and _num(r.get(k)) >= lo)
        if hi is not None:
            tests.append(lambda r, k=key, hi=hi: _num(r.get(k)) is not None and _num(r.get(k)) <= hi)
    return [r for r in rows if all(t(r) for t in tests)] if tests else rows


NUMERIC = {"money", "int", "num", "pct", "area"}


def sort_rows(cols: list, rows: list, raw) -> list:
    """`key:asc` / `key:desc`; blanks last whichever way (as the screen sorts)."""
    key, _, way = str(raw or "").partition(":")
    col = next((c for c in cols if c["key"] == key), None)
    if not col:
        return rows
    desc = way.strip().lower() == "desc"
    has = [r for r in rows if r.get(key) not in (None, "")]
    blank = [r for r in rows if r.get(key) in (None, "")]
    if col["type"] in NUMERIC:
        has.sort(key=lambda r: _num(r[key]) or 0, reverse=desc)
    else:
        has.sort(key=lambda r: str(r[key]).casefold(), reverse=desc)
    return has + blank


def show_columns(cols: list, raw, hide=None) -> list:
    """The columns in the order the person arranged them (`showColumns`: those
    first, then any column the order does not know - new in a release), less
    the ones they hid (`hideColumns`); a key not in this report is skipped.
    The same rule as the screen (columnControls.arrange): never no columns."""
    keys, hidden = _keys(raw), set(_keys(hide))
    by = {c["key"]: c for c in cols}
    ordered = [by[k] for k in keys if k in by] + [c for c in cols if c["key"] not in keys]
    return [c for c in ordered if c["key"] not in hidden] or ordered[:1]


def _facility_label(db, d: Data, picked: bool) -> str:
    if not picked or not d.facs:
        return "All Facilities"
    if len(d.facs) == 1:
        return d.facs[0]["short"]
    every = db.query(d.m.CubbyFacility).filter(d.m.CubbyFacility.enabled.is_(True)).count()
    return "All Facilities" if len(d.facs) >= every else f"{len(d.facs)} Facilities"


def run(kind: str, facility_id: str = "", start: str = "", end: str = "",
        facility_ids: list[str] | None = None, options: dict | None = None) -> dict:
    """One report as {columns, rows, totals, summary, groups, notes...}.
    `facility_ids` (a list) wins over `facility_id`; `options` is whitelisted
    per report (REPORT_OPTIONS). Blocking."""
    from database import SessionLocal
    kind = ALIASES.get(kind, kind)
    meta = CATALOG.get(kind)
    if not meta:
        raise ReportError(404, "No such report")
    title, category, about, source, timed = meta
    ids = list(dict.fromkeys(i.strip() for i in (facility_ids or []) if i and i.strip())) or ([facility_id] if facility_id else None)
    own, shape = split_shape(options)
    opts = parse_options(kind, own)
    db = SessionLocal()
    try:
        d = Data(db, ids, opts)
        # A one-date report takes only `end`; a past date must not trip the
        # "starts after it ends" check against the default month start.
        a, b = parse_period(start or (end if kind in DATE_REPORTS else ""), end, d.today)
        if kind in DATE_REPORTS and not start:
            a = b
        base = {"key": kind, "title": title, "category": category, "about": about, "source": source,
                "period": {"from": a, "to": b} if timed else None,
                "asOf": b if kind in DATE_REPORTS else d.today.isoformat(),
                "facility": _facility_label(db, d, bool(ids)), "facilities": [f["short"] for f in d.facs],
                "facilityIds": [f["id"] for f in d.facs], "options": opts,
                "syncedAt": min((f["syncedAt"] for f in d.facs), default=""), "groups": {}}
        if source == "unavailable":
            return {**base, "available": False, "columns": [], "rows": [], "totals": {}, "notes": [about],
                    "summary": [_s("Status", "Not Available From Cubby Yet", "text")]}
        out = BUILDERS[kind](d, a, b)
        cols, rows = out[0], out[1]
        cols = _add_presets(d, cols, rows, _keys(shape.get("addColumns")))
    finally:
        db.close()
    notes = out[2]
    total_row = out[3] if len(out) > 3 else None
    fetched = out[4] if len(out) > 4 else ""
    groups = out[5] if len(out) > 5 else {}
    totals = total_row if total_row is not None else _totals(cols, rows)
    fn = SUMMARIES.get(kind)
    summary = (fn(rows, totals, d) if fn is _sum_rent_roll else fn(rows, totals)) if fn else [_s("Rows", len(rows), "int")]
    # The person's arrangement. The headline figures stay the whole report's;
    # filtered lines get a total of their own, and an added money column a total.
    every = len(rows)
    filtered = filter_rows(cols, rows, shape.get("filters"))
    if len(filtered) != every:
        rows = filtered
        totals = _totals(cols, rows)
    rows = sort_rows(cols, rows, shape.get("sortBy"))
    for c in cols:
        if c["total"] and c["key"].startswith(PRESET_PREFIX) and c["key"] not in totals:
            totals[c["key"]] = sum(r.get(c["key"]) or 0 for r in rows)
    return {**base, "available": True, "columns": show_columns(cols, shape.get("showColumns"), shape.get("hideColumns")), "allColumns": cols,
            "rows": rows, "totals": totals, "summary": summary, "notes": notes, "groups": groups,
            "fetchedAt": fetched or base["syncedAt"], "rowsBeforeFilters": every,
            "shape": {k: v for k, v in shape.items() if v}}


# ── Drill-down ────────────────────────────────────────────────────────────────

def tenant(facility_id: str, customer_id: str) -> dict:
    """One tenant at one facility: units now, tenancies, balance, payments.
    No contact details - the name and a link into Cubby. Blocking."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        d = Data(db, [facility_id])
        name = d.name(facility_id, customer_id)
        units = [u for u in d.units.values() if u["customerId"] == customer_id]
        rentals = [r for r in d.rentals() if r["customerId"] == customer_id]
        rec = [r for r in d.receivables() if r["customerId"] == customer_id]
        P = d.m.CubbyPayment
        pays = (db.query(P).filter(P.facility_id == facility_id, P.customer_id == customer_id)
                .order_by(P.payment_date.desc()).limit(200).all())
        if not (name or units or rentals or rec or pays):
            raise ReportError(404, "Tenant not found")
        today = d.fac[facility_id]["today"]
        return {
            "facilityId": facility_id, "facility": d.fac[facility_id]["short"], "customerId": customer_id,
            "name": name or "Former Tenant", "cubbyUrl": cubby._tenant_url(customer_id),
            "units": [{"unitId": u["id"], "unit": u["name"], "type": u["type"], "size": u["size"], "rent": u["rent"],
                       "street": u["street"], "paidThrough": u["paidThrough"], "moveIn": u["moveIn"],
                       "autoPay": u["autoPay"], "overlocked": u["overlocked"]} for u in sorted(units, key=lambda u: u["name"])],
            "rentals": [{"unitId": r["unitId"], "unit": r["unit"], "moveIn": r["moveIn"], "moveOut": r["moveOut"], "rent": r["rent"],
                         "stayDays": ((date.fromisoformat(r["moveOut"]) if r["moveOut"] else today) - date.fromisoformat(r["moveIn"])).days
                         if r["moveIn"] else None}
                        for r in sorted(rentals, key=lambda r: r["moveIn"], reverse=True)],
            "balance": {"total": sum(r["total"] for r in rec),
                        "lines": [{"unitId": r["unitId"], "unit": r["unit"], "total": r["total"],
                                   **{k.lower(): r["buckets"].get(k, 0) for k, _ in AGING_COLS}} for r in rec]},
            "payments": [{"date": _iso_day(p.payment_date), "amount": int(p.amount_cents or 0), "status": _tidy((p.status or "").upper()),
                          "method": _tidy((p.data or {}).get("methodType") or ""), "reason": ((p.data or {}).get("reason") or "")[:200]}
                         for p in pays],
            "leases": [r["leaseId"] for r in rentals if r["leaseId"] and not r["leaseId"].startswith("h")],
        }
    finally:
        db.close()


_ledger_cache: dict[str, tuple[float, dict]] = {}


def tenant_ledger(facility_id: str, customer_id: str) -> dict:
    """The tenant's Cubby ledger, lease by lease (charges, payments, credits),
    read live - cached LEDGER_TTL in this worker. Blocking."""
    info = tenant(facility_id, customer_id)
    key = f"{facility_id}:{customer_id}"
    hit = _ledger_cache.get(key)
    if hit and time.monotonic() - hit[0] < LEDGER_TTL:
        return hit[1]
    unit_of = {}
    from database import SessionLocal
    db = SessionLocal()
    try:
        d = Data(db, [facility_id])
        for r in d.rentals():
            unit_of[r["leaseId"]] = r["unit"]
    finally:
        db.close()
    leases = info["leases"][:8]
    entries = []
    for lease in leases:
        data = _clean(_cubby("ledgers/search", {"where": {"leaseId": lease, "facilityId": facility_id}}))
        for led in data.get("ledgers") or []:
            for e in led.get("bookEntries") or []:
                det = e.get("details") or {}
                kind = (e.get("type") or "").upper()
                what = det.get("category") if kind == "CHARGE" else det.get("method") if kind == "PAYMENT" else det.get("source") or ""
                entries.append({"unit": unit_of.get(lease, ""), "date": _iso_day(e.get("entryTime")), "type": _tidy(kind),
                                "category": _tidy(what or ""), "description": (det.get("description") or det.get("explanation") or "")[:160],
                                "amount": int(e.get("amount") or 0),
                                "paid": int(e.get("amountPaid") or 0) if kind == "CHARGE" else None,
                                "waived": bool(det.get("waive")),
                                "accrues": " - ".join(v for v in (_iso_day(det.get("accruesOn")), _iso_day(det.get("accruesThrough"))) if v)})
    entries.sort(key=lambda e: e["date"], reverse=True)
    out = {"facilityId": facility_id, "customerId": customer_id, "entries": entries[:500], "leases": len(leases)}
    _ledger_cache[key] = (time.monotonic(), out)
    return out


def unit(facility_id: str, unit_id: str) -> dict:
    """One unit: what it is, who rents it, every tenancy it has had. Blocking."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        d = Data(db, [facility_id])
        u = d.units.get((facility_id, unit_id))
        if not u:
            raise ReportError(404, "Unit not found")
        rentals = sorted((r for r in d.rentals() if r["unitId"] == unit_id), key=lambda r: r["moveIn"], reverse=True)
        owed = next((r for r in d.receivables() if r["unitId"] == unit_id), None)
        T = d.m.CubbyTask
        tasks = db.query(T).filter(T.facility_id == facility_id, T.unit_id == unit_id).all()
        today = d.fac[facility_id]["today"]
        return {
            "facilityId": facility_id, "facility": d.fac[facility_id]["short"], "unitId": unit_id, "unit": u["name"],
            "type": u["type"], "size": u["size"], "area": u["area"], "status": u["statusLabel"], "street": u["street"],
            "rent": u["rent"], "reason": _tidy(u["reason"]), "note": u["note"], "overlocked": u["overlocked"],
            "tenant": {"customerId": u["customerId"], "name": u["tenant"]} if u["customerId"] else None,
            "paidThrough": u["paidThrough"], "autoPay": u["autoPay"], "balance": owed["total"] if owed else 0,
            "history": [{"customerId": r["customerId"], "tenant": d.name(facility_id, r["customerId"]) or "Former Tenant",
                         "moveIn": r["moveIn"], "moveOut": r["moveOut"], "rent": r["rent"],
                         "stayDays": ((date.fromisoformat(r["moveOut"]) if r["moveOut"] else today) - date.fromisoformat(r["moveIn"])).days
                         if r["moveIn"] else None} for r in rentals],
            "tasks": [{"title": ((t.data or {}).get("title") or "").strip()[:160], "dueDate": _iso_day(t.due_date)} for t in tasks],
        }
    finally:
        db.close()
