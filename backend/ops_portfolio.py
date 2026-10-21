"""Operations > Portfolio: a Daily Flash for every property (Neil, Oct 20 2026).

CubeSmart's SmartView "Daily Flash" for the properties CubeSmart manages, done
for the whole company and for any set of properties a person picks: move-in /
move-out and square-foot occupancy trends (this year against last), occupancy
by status, revenue, allowances, net rentals and net revenue.

Two layers, so a new data source slots in without touching the arithmetic:

  1. A SOURCE turns its own rows into PropertyFacts (one dict per property, the
     shape documented on `PROPERTY_FACTS` below). `cubby_property` does it for
     the Cubby facilities; `register_source` is the door for CubeSmart-managed
     properties (another branch is adding their tables) and anything after.
  2. `build` aggregates any selection of PropertyFacts for a month. Pure - no
     I/O - so the tests feed it fixed rows.

Never invent a number. A figure the data cannot support comes back as None
with a note: months before a property's history starts ("No data before
cutover" - Cubby has payments from Sep 15 2026 only, and tenancies only as far
back as the move-outs it was given), revenue lines Cubby is not synced for
(Accrued Rent, Fees, Insurance, Merchandise, Discounts, Write Offs need its
accrual ledger), and the budget, which Nexus does not hold yet.

Money is integer cents. Tenant name, unit and money only - the same line the
Overview draws; nothing here is logged per tenant.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Callable

CUTOVER = date(2026, 9, 15)        # Cubby holds payments from this day on
TREND_MONTHS = 12

STATUSES = (("occupied", "Occupied"), ("vacant", "Vacant"), ("reserved", "Reserved"),
            ("damaged", "Damaged"), ("unrentable", "Unrentable"))
REVENUE_LINES = (("accruedRent", "Accrued Rent"), ("fees", "Fees"), ("insurance", "Insurance"),
                 ("merchandise", "Merchandise"))
ALLOWANCE_LINES = (("discount", "Discount"), ("writeOffs", "Write Offs"))
NO_LEDGER = ("Not available yet - Cubby's accrual ledger (reports/general-ledger/accrual) "
             "is not synced into Nexus.")
NO_BUDGET = "No Ops budget is set up in Nexus yet, so budget and variance columns are hidden."
NOT_CONNECTED = "Not Connected Yet"

# PropertyFacts - what a source hands `build` for one property:
PROPERTY_FACTS = {
    "id": "unique across sources, e.g. a Cubby facilityId or 'cubesmart:<store>'",
    "name": "full name", "shortName": "chip label",
    "source": "cubby | cubesmart | ...", "managedBy": "Greens | CubeSmart",
    "state": "two-letter state or ''", "market": "market name or ''",
    "connected": "False = listed in the picker as Not Connected Yet; nothing else is read",
    "asOf": "YYYY-MM-DD, the property's own today",
    "units": "[{id, name, type, status (STATUSES key), sqft, rent, tenant}] - storage only",
    "mailboxesExcluded": "count of mailbox units left out of `units`",
    "leases": "[{unitId, unit, tenant, moveIn, moveOut}] - storage units only",
    "historyFrom": "YYYY-MM-DD: moves and month-end occupancy are complete from here on",
    "payments": "[{date, amount, tenant}] - succeeded only",
    "paymentsFrom": "YYYY-MM-DD: payments are complete from here on",
    "ledger": "{'YYYY-MM': {accruedRent, fees, insurance, merchandise, discount, writeOffs}} or {} "
              "- month-to-date through the property's today for its current month",
}


# ── Mailboxes ─────────────────────────────────────────────────────────────────

def is_mailbox(row: dict) -> bool:
    """A mailbox rental, which is not storage space and stays out of storage
    occupancy. TODO(feat/ops-mailbox-occupancy): swap for the shared helper
    that branch adds once it merges - this local copy only reads the unit type
    and unit name."""
    text = f"{row.get('pricingGroupName') or ''} {row.get('type') or ''} {row.get('unitName') or ''}".lower()
    return "mailbox" in text or "mail box" in text


# ── Cubby -> PropertyFacts ────────────────────────────────────────────────────

def unit_status(rr: dict, unit: dict | None) -> str:
    """Rent-roll line (+ its units/search row) -> a STATUSES key. Cubby has no
    reserved or damaged status: `reserved` is a flag on a vacant unit, and an
    off-market unit says why in rentability.unrentableReason."""
    unit = unit or {}
    st = (rr.get("status") or "").upper()
    if st == "RENTED":
        return "occupied"
    reason = ((unit.get("rentability") or {}).get("unrentableReason") or "").upper()
    if st == "VACANT":
        return "reserved" if unit.get("reserved") else "vacant"
    if reason in ("REPAIRS_REQUIRED", "CLEANING_REQUIRED"):
        return "damaged"
    return "unrentable"


def _state(fac: dict) -> str:
    """Cubby keeps no address in Nexus (strip_pii drops it), so the state comes
    from the map pin. Rough boxes, enough to tell our states apart."""
    s = (fac.get("state") or "").strip().upper()
    if s:
        return s
    try:
        lat, lng = float(fac.get("latitude")), float(fac.get("longitude"))
    except (TypeError, ValueError):
        return ""
    if 32.5 <= lat <= 42.1 and -124.5 <= lng <= -114.1:
        # East of the diagonal border from Lake Tahoe to the Colorado River is Nevada / Arizona.
        border = -120.0 if lat >= 39 else -120.0 + (39 - lat) * 1.3425
        if lng <= border:
            return "CA"
    if 25.8 <= lat <= 36.6 and -106.7 <= lng <= -93.5:
        return "TX"
    return ""


def _market(fac: dict, state: str) -> str:
    m = (fac.get("market") or "").strip()
    if m:
        return m
    if state == "CA":
        try:
            return "Southern California" if float(fac.get("latitude")) < 35.0 else "Northern California"
        except (TypeError, ValueError):
            return "California"
    return state


def cubby_property(fac: dict, raw: dict) -> dict:
    """One Cubby facility (as cubby._rows() holds it) as PropertyFacts."""
    today: date = raw["today"]
    units_by_id = {u.get("unitId"): u for u in raw.get("units", [])}
    units, mailbox_ids, names = [], set(), {}
    for r in raw.get("rent_roll", []):
        uid = r.get("unitId")
        names[uid] = (r.get("unitName") or "").strip()
        if is_mailbox(r):
            mailbox_ids.add(uid)
            continue
        status = unit_status(r, units_by_id.get(uid))
        units.append({"id": uid, "name": names[uid], "type": (r.get("pricingGroupName") or "").strip(),
                      "status": status, "sqft": round((r.get("width") or 0) * (r.get("depth") or 0)),
                      "rent": (r.get("monthlyRentalAmount") or 0) if status == "occupied" else 0,
                      "tenant": (r.get("customerName") or "") if status == "occupied" else ""})
    tenant_of = {r.get("customerId"): r.get("customerName") or "" for r in raw.get("rent_roll", []) if r.get("customerId")}
    leases = [{"unitId": le.get("unitId"), "unit": names.get(le.get("unitId"), ""),
               "tenant": tenant_of.get(le.get("customerId"), ""),
               "moveIn": le.get("moveInDate") or "", "moveOut": le.get("moveOutDate") or ""}
              for le in raw.get("leases", []) if le.get("unitId") not in mailbox_ids]
    # Tenancies that ended before Cubby took over were only carried across so
    # far back. The earliest move-out on record is where the history of moves
    # is complete; with none at all, only the cutover is safe.
    outs = [le["moveOut"] for le in leases if le["moveOut"]]
    history_from = min(outs) if outs else CUTOVER.isoformat()
    history_from = history_from[:7] + "-01" if history_from[8:10] == "01" else _next_month_start(history_from)
    payments = [{"date": (p.get("createdAt") or "")[:10], "amount": p.get("amount") or 0,
                 "tenant": tenant_of.get(p.get("customerId"), "")}
                for p in raw.get("payments", []) if p.get("status") == "SUCCEEDED"]
    state = _state(fac)
    return {
        "id": fac["facilityId"], "name": fac.get("name") or "",
        "shortName": (fac.get("name") or "").replace("Greens Storage", "").strip() or (fac.get("name") or ""),
        "source": "cubby", "managedBy": "Greens", "state": state, "market": _market(fac, state),
        "connected": True, "asOf": today.isoformat(),
        "units": units, "mailboxesExcluded": len(mailbox_ids), "leases": leases,
        "historyFrom": history_from, "payments": payments,
        "paymentsFrom": CUTOVER.isoformat(),
        "ledger": {},
    }


def _next_month_start(iso: str) -> str:
    """A partial first month is not complete history: start at the next one."""
    y, m = int(iso[:4]), int(iso[5:7])
    return f"{y + (m == 12):04d}-{(m % 12) + 1:02d}-01"


# ── Other sources (CubeSmart-managed properties) ──────────────────────────────

_SOURCES: list[Callable[[], list[dict]]] = []


def register_source(loader: Callable[[], list[dict]]) -> None:
    """Add a source of PropertyFacts. `loader()` is blocking and returns a list
    of PropertyFacts dicts; a CubeSmart loader sets source='cubesmart',
    managedBy='CubeSmart', and connected=True once its figures are in."""
    if loader not in _SOURCES:
        _SOURCES.append(loader)


# Until the CubeSmart tables land, the CubeSmart-managed properties are one
# placeholder line in the picker: listed, never counted.
CUBESMART_PLACEHOLDER = {
    "id": "cubesmart:pending", "name": "TPM Properties (CubeSmart)", "shortName": "TPM (CubeSmart)",
    "source": "cubesmart", "managedBy": "CubeSmart", "state": "", "market": "", "connected": False,
}


def third_party_properties() -> list[dict]:
    out: list[dict] = []
    for loader in _SOURCES:
        try:
            out += loader() or []
        except Exception as e:  # noqa: BLE001 - one broken source must not blank the board
            print(f"[ops-portfolio] source skipped: {type(e).__name__}")
    if not any(p.get("source") == "cubesmart" for p in out):
        out.append(dict(CUBESMART_PLACEHOLDER))
    return out


# ── Budget ────────────────────────────────────────────────────────────────────

def budget_for(ids: list[str], month: str) -> dict | None:
    """The Ops budget for these properties and month, or None. Nexus holds no
    Ops budget yet (Neil's "Ops Budget Dashboard Mockup" is a sheet outside
    Nexus), so this is None and the board hides its budget columns. When one
    exists, return {revenue: {line: cents}, allowances: {line: cents},
    netRentalsMtd: n, netRentalsDaily: n, netRevenue: cents}."""
    return None


# ── Arithmetic ────────────────────────────────────────────────────────────────

def _ym(d: str) -> str:
    return d[:7]


def _shift(ym: str, months: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7]) - 1 + months
    return f"{y + m // 12:04d}-{m % 12 + 1:02d}"


def _month_end(ym: str) -> date:
    return date.fromisoformat(_shift(ym, 1) + "-01") - timedelta(days=1)


def _label(ym: str) -> str:
    names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    return f"{names[int(ym[5:7]) - 1]} '{ym[2:4]}"


def _covers(prop: dict, ym: str, key: str = "historyFrom") -> bool:
    """Is this month complete in this property's history?"""
    return ym + "-01" >= (prop.get(key) or "9999")


def _moves(prop: dict, start: str, end: str) -> tuple[int, int]:
    ins = sum(1 for le in prop["leases"] if start <= le["moveIn"] <= end)
    outs = sum(1 for le in prop["leases"] if le["moveOut"] and start <= le["moveOut"] <= end)
    return ins, outs


def _area(prop: dict) -> dict:
    return {u["id"]: u["sqft"] for u in prop["units"]}


def sqft_occupancy(prop: dict, ym: str) -> tuple[int, int] | None:
    """(occupied sq ft, total sq ft) at the end of `ym` (today for the
    current month), from unit sizes. None before the property's history."""
    total = sum(u["sqft"] for u in prop["units"])
    if ym == prop["asOf"][:7]:
        return sum(u["sqft"] for u in prop["units"] if u["status"] == "occupied"), total
    if not _covers(prop, ym) or ym > prop["asOf"][:7]:
        return None
    end = _month_end(ym).isoformat()
    area = _area(prop)
    occupied = sum(area.get(le["unitId"], 0) for le in prop["leases"]
                   if le["moveIn"] and le["moveIn"] <= end and not (le["moveOut"] and le["moveOut"] <= end))
    return occupied, total


def _sum_or_none(values):
    """Add per-property figures; one property without the figure = no total."""
    values = list(values)
    if not values or any(v is None for v in values):
        return None
    return sum(values)


def _through(month: str, as_of: str) -> str:
    """The last day counted in `month`: today in the current month, else its end."""
    return as_of if month == as_of[:7] else _month_end(month).isoformat()


def property_block(prop: dict, month: str) -> dict:
    """Every figure for one property and month. `build` adds blocks up."""
    through = _through(month, prop["asOf"])
    start = month + "-01"
    py_month = _shift(month, -12)
    py_through = f"{py_month}-{min(int(through[8:10]), _month_end(py_month).day):02d}"

    # Occupancy by status (as of today).
    occ = {k: {"units": 0, "sqft": 0} for k, _ in STATUSES}
    for u in prop["units"]:
        occ[u["status"]]["units"] += 1
        occ[u["status"]]["sqft"] += u["sqft"]

    # Trends: the 12 months ending in `month`, and the same months a year back.
    trend = []
    for i in range(TREND_MONTHS - 1, -1, -1):
        ym = _shift(month, -i)
        pym = _shift(ym, -12)
        row = {"month": ym}
        for tag, m in (("cy", ym), ("py", pym)):
            if m > prop["asOf"][:7] or not _covers(prop, m):
                row[tag] = None
                continue
            ins, outs = _moves(prop, m + "-01", _through(m, prop["asOf"]))
            sq = sqft_occupancy(prop, m)
            row[tag] = {"moveIns": ins, "moveOuts": outs, "sqftOccupied": sq[0] if sq else None,
                        "sqftTotal": sq[1] if sq else None}
        trend.append(row)

    # Net rentals.
    d_in, d_out = _moves(prop, through, through)
    m_in, m_out = _moves(prop, start, through)
    py = _moves(prop, py_month + "-01", py_through) if _covers(prop, py_month) else None
    window_from = _shift(month, -(TREND_MONTHS - 1)) + "-01"
    moves = sorted(
        [{"date": le["moveIn"], "kind": "in", "unit": le["unit"], "tenant": le["tenant"]}
         for le in prop["leases"] if window_from <= le["moveIn"] <= through]
        + [{"date": le["moveOut"], "kind": "out", "unit": le["unit"], "tenant": le["tenant"]}
           for le in prop["leases"] if le["moveOut"] and window_from <= le["moveOut"] <= through],
        key=lambda r: (r["date"], r["unit"]), reverse=True)

    # Revenue: what the ledger carries (nothing for Cubby yet), plus the cash
    # actually collected, which Cubby's payments do support.
    ledger_cy = (prop.get("ledger") or {}).get(month)
    ledger_py = (prop.get("ledger") or {}).get(py_month)
    lines = {}
    for key, _ in REVENUE_LINES + ALLOWANCE_LINES:
        lines[key] = {"mtd": (ledger_cy or {}).get(key), "priorYear": (ledger_py or {}).get(key)}
    pays = [p for p in prop["payments"] if start <= p["date"] <= through]
    collected_py = (sum(p["amount"] for p in prop["payments"] if py_month + "-01" <= p["date"] <= py_through)
                    if _covers(prop, py_month, "paymentsFrom") else None)
    collected_cy = sum(p["amount"] for p in pays) if _covers(prop, month, "paymentsFrom") else None

    return {
        "id": prop["id"], "shortName": prop["shortName"], "through": through,
        "occupancy": occ, "mailboxesExcluded": prop.get("mailboxesExcluded", 0),
        "trend": trend,
        "netRentals": {"daily": {"ins": d_in, "outs": d_out}, "mtd": {"ins": m_in, "outs": m_out},
                       "priorYear": ({"ins": py[0], "outs": py[1]} if py else None)},
        "lines": lines,
        "collected": {"mtd": collected_cy, "priorYear": collected_py},
        "rentRoll": sum(u["rent"] for u in prop["units"]),
        "lists": {
            "units": [{**u, "facility": prop["shortName"]} for u in prop["units"]],
            "moves": [{**r, "facility": prop["shortName"]} for r in moves],
            "payments": sorted(({**p, "facility": prop["shortName"]} for p in pays), key=lambda p: p["date"], reverse=True),
        },
        "historyFrom": prop["historyFrom"], "paymentsFrom": prop["paymentsFrom"],
    }


def _add_moves(blocks, pick):
    vals = [pick(b) for b in blocks]
    if not vals or any(v is None for v in vals):
        return None
    return {"ins": sum(v["ins"] for v in vals), "outs": sum(v["outs"] for v in vals)}


def aggregate(blocks: list[dict]) -> dict:
    """Add property blocks into one block of the same figures."""
    occ = {k: {"units": sum(b["occupancy"][k]["units"] for b in blocks),
               "sqft": sum(b["occupancy"][k]["sqft"] for b in blocks)} for k, _ in STATUSES}
    total_units = sum(v["units"] for v in occ.values())
    total_sqft = sum(v["sqft"] for v in occ.values())
    occupancy = [{"key": k, "label": label, "units": occ[k]["units"], "sqft": occ[k]["sqft"],
                  "unitPct": round(occ[k]["units"] / total_units * 100, 2) if total_units else None,
                  "sqftPct": round(occ[k]["sqft"] / total_sqft * 100, 2) if total_sqft else None}
                 for k, label in STATUSES]

    trend = []
    for i, first in enumerate(blocks[0]["trend"] if blocks else []):
        row = {"month": first["month"], "label": _label(first["month"])}
        for tag in ("cy", "py"):
            cells = [b["trend"][i][tag] for b in blocks]
            if any(c is None for c in cells):
                row[tag] = None
                continue
            occ_sq = _sum_or_none(c["sqftOccupied"] for c in cells)
            tot_sq = _sum_or_none(c["sqftTotal"] for c in cells)
            row[tag] = {"moveIns": sum(c["moveIns"] for c in cells), "moveOuts": sum(c["moveOuts"] for c in cells),
                        "sqftPct": round(occ_sq / tot_sq * 100, 2) if occ_sq is not None and tot_sq else None}
        trend.append(row)

    def line(key, label):
        return {"key": key, "label": label,
                "mtd": _sum_or_none(b["lines"][key]["mtd"] for b in blocks),
                "priorYear": _sum_or_none(b["lines"][key]["priorYear"] for b in blocks)}
    revenue = [line(k, lbl) for k, lbl in REVENUE_LINES]
    allowances = [line(k, lbl) for k, lbl in ALLOWANCE_LINES]
    rev_total = _sum_or_none(r["mtd"] for r in revenue)
    allow_total = _sum_or_none(a["mtd"] for a in allowances)
    rev_py = _sum_or_none(r["priorYear"] for r in revenue)
    allow_py = _sum_or_none(a["priorYear"] for a in allowances)

    return {
        "occupancy": occupancy, "totalUnits": total_units, "totalSqft": total_sqft,
        "mailboxesExcluded": sum(b["mailboxesExcluded"] for b in blocks),
        "trend": trend,
        "netRentals": {"daily": _add_moves(blocks, lambda b: b["netRentals"]["daily"]),
                       "mtd": _add_moves(blocks, lambda b: b["netRentals"]["mtd"]),
                       "priorYear": _add_moves(blocks, lambda b: b["netRentals"]["priorYear"])},
        "revenue": revenue, "allowances": allowances,
        "revenueTotal": {"mtd": rev_total, "priorYear": rev_py},
        "allowanceTotal": {"mtd": allow_total, "priorYear": allow_py},
        # Allowances are stored as positive amounts and taken off.
        "netRevenue": {"mtd": rev_total - allow_total if rev_total is not None and allow_total is not None else None,
                       "priorYear": rev_py - allow_py if rev_py is not None and allow_py is not None else None},
        "collected": {"mtd": _sum_or_none(b["collected"]["mtd"] for b in blocks),
                      "priorYear": _sum_or_none(b["collected"]["priorYear"] for b in blocks)},
        "rentRoll": sum(b["rentRoll"] for b in blocks),
        "lists": {k: sorted((r for b in blocks for r in b["lists"][k]),
                            key=lambda r: r.get("date") or r.get("name") or "", reverse=k != "units")
                  for k in ("units", "moves", "payments")},
    }


def _meta(p: dict) -> dict:
    return {k: p.get(k, "") for k in ("id", "name", "shortName", "source", "managedBy", "state", "market")} | {
        "connected": bool(p.get("connected")), "status": "" if p.get("connected") else NOT_CONNECTED,
        "historyFrom": p.get("historyFrom", ""), "paymentsFrom": p.get("paymentsFrom", "")}


def build(properties: list[dict], ids: list[str] | None, month: str | None,
          budget: dict | None = None) -> dict:
    """The board for the properties in `ids` (None or empty = every connected
    property) and `month` (YYYY-MM, default the current one). Pure."""
    connected = [p for p in properties if p.get("connected")]
    as_of = max((p["asOf"] for p in connected), default=date.today().isoformat())
    month = month if (month and len(month) == 7 and month <= as_of[:7]) else as_of[:7]
    want = set(ids or [])
    chosen = [p for p in properties if not want or p["id"] in want]
    used = [p for p in chosen if p.get("connected")]
    skipped = [p["shortName"] for p in chosen if not p.get("connected")]
    blocks = [property_block(p, month) for p in used]
    total = aggregate(blocks)
    notes = []
    if skipped:
        notes.append(f"{', '.join(skipped)}: {NOT_CONNECTED.lower()}, so not counted.")
    if any(r["py"] is None for r in total["trend"]) or total["netRentals"]["priorYear"] is None:
        notes.append("No data before cutover: months before a property's history in Cubby are left blank, not estimated.")
    if all(r["mtd"] is None for r in total["revenue"]):
        notes.append(NO_LEDGER)
    if budget is None:
        notes.append(NO_BUDGET)
    if total["mailboxesExcluded"]:
        notes.append(f"{total['mailboxesExcluded']} mailbox rentals are left out of storage occupancy.")
    by_property = [{"id": b["id"], "shortName": b["shortName"], **{k: v for k, v in aggregate([b]).items() if k != "lists"}}
                   for b in blocks]
    return {
        "asOf": as_of, "month": month, "monthLabel": _label(month), "through": _through(month, as_of),
        "properties": [_meta(p) for p in properties],
        "selected": [p["id"] for p in used], "notConnected": skipped,
        "budget": {"available": budget is not None, "note": "" if budget is not None else NO_BUDGET, "figures": budget},
        "cutover": CUTOVER.isoformat(),
        "total": total, "byProperty": by_property, "notes": notes,
    }


# ── Read (blocking - call in a thread) ────────────────────────────────────────

def portfolio(ids: list[str] | None = None, month: str | None = None) -> dict:
    import cubby
    props = [cubby_property(f, r) for f, r in cubby._rows()]
    props += third_party_properties()
    chosen = [p["id"] for p in props if p.get("connected") and (not ids or p["id"] in ids)]
    return build(props, ids, month, budget_for(chosen, month or ""))
