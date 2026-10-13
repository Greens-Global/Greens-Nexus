"""Cubby (the storage facilities' management system) -> Operations module.

Read-only. Nexus never writes to Cubby: site staff take payments, sign leases
and edit tenants there. What Nexus adds is the view Cubby does not give - all
facilities side by side, what needs a person today, and a daily history.

Cubby's API is action-style JSON over POST (https://cubbystorage.github.io/
docs/api/). Two things bite:
  - every search must be scoped to ONE organization or facility. An unscoped
    search answers 403 "Access Denied", which reads like a bad key and is not.
  - there is no paging and no webhook, so a refresh is a full pull: seven calls
    per facility, run ten at a time and cached (see `summary`).

Money is integer cents end to end, as Cubby sends it; the screen formats it.

Tenant details: the payload carries a tenant's name, unit and what they owe -
what a manager needs to make a collections call - and a link into Cubby for
the rest. Phone, email, address, date of birth and ID number never leave this
module, and nothing here is logged per tenant.
"""
import asyncio
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

BASE = os.environ.get("CUBBY_BASE_URL", "https://api.cubbystorage.com/v1").rstrip("/")
APP_URL = "https://app.cubbystorage.com"
DEFAULT_TZ = "America/Los_Angeles"
CACHE_TTL = 600.0            # a screen read is at most 10 minutes old
SYNC_EVERY_SEC = 15 * 60     # the deployed worker re-reads Cubby this often, so nobody has to press Refresh
ACTIVITY_DAYS = 400          # daily move and payment history sent to the screen (its period selector)
HISTORY_MONTHS = 36
FAILED_DAYS = 31             # failed payments are listed row by row this far back

AGING = ("RANGE_0_30", "RANGE_30_60", "RANGE_60_90", "RANGE_90_120", "RANGE_120_PLUS", "RANGE_UNKNOWN")
AGING_KEYS = {"RANGE_0_30": "d0_30", "RANGE_30_60": "d30_60", "RANGE_60_90": "d60_90",
              "RANGE_90_120": "d90_120", "RANGE_120_PLUS": "d120_plus", "RANGE_UNKNOWN": "unknown"}
OPEN_LEAD = {"NEW", "IN_PROGRESS_HOT", "IN_PROGRESS_COLD", "ON_HOLD", "RESERVATION"}
FAILED_PAYMENT = {"DECLINED", "REJECTED", "FAILED", "DIRECT_DEBIT_RETURN", "DISPUTED"}


class CubbyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _key() -> str:
    return os.environ.get("CUBBY_API_KEY", "").strip()


def configured() -> bool:
    return bool(_key())


def _post(path: str, where: dict) -> dict:
    try:
        r = httpx.post(f"{BASE}/{path}", json={"where": where},
                       headers={"Authorization": f"Bearer {_key()}"}, timeout=60)
    except httpx.HTTPError as e:
        raise CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        body = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        body = {}
    if r.status_code != 200:
        errors = body.get("errors") or [f"Cubby returned {r.status_code}"]
        raise CubbyError(r.status_code, f"{path}: {'; '.join(str(e) for e in errors)}")
    return body.get("data") or {}


# ── Pull ──────────────────────────────────────────────────────────────────────

def _facility_today(fac: dict) -> date:
    try:
        return datetime.now(ZoneInfo(fac.get("timeZone") or DEFAULT_TZ)).date()
    except Exception:  # noqa: BLE001 - an unknown zone name must not sink the pull
        return datetime.now(ZoneInfo(DEFAULT_TZ)).date()


def _facility_calls(fac: dict, today: date) -> dict:
    fid = fac["facilityId"]
    scope = {"facilityId": fid}
    return {
        "rent_roll": ("reports/rent-roll", {"facilityIds": [fid], "throughDate": today.isoformat()}, "entries"),
        "receivables": ("reports/aged-receivables", {"facilityIds": [fid]}, "entries"),
        "units": ("units/search", scope, "units"),
        "leases": ("leases/search", scope, "leases"),
        "leads": ("leads/search", scope, "leads"),
        "tasks": ("tasks/search", {**scope, "status": "OPEN"}, "tasks"),
        # Both bounds, always: with either one missing Cubby quietly answers
        # with the last month only.
        "payments": ("payments/search", {**scope, "paymentDateOnOrAfter": (today - timedelta(days=ACTIVITY_DAYS)).isoformat(),
                                         "paymentDateOnOrBefore": today.isoformat()}, "payments"),
    }


def pull() -> dict:
    """Everything the module shows, straight from Cubby. Blocking - call it in a thread."""
    orgs = _post("organizations/search", {}).get("organizations", [])
    facilities = []
    for org in orgs:
        facilities += _post("facilities/search", {"organizationId": org["organizationId"]}).get("facilities", [])
    facilities = [f for f in facilities if f.get("enabled", True)]
    facilities.sort(key=lambda f: (f.get("internalName") or f.get("name") or "").strip())
    raws = [{"today": _facility_today(f)} for f in facilities]
    jobs = [(i, name, call) for i, f in enumerate(facilities)
            for name, call in _facility_calls(f, raws[i]["today"]).items()]
    with ThreadPoolExecutor(max_workers=10) as pool:
        for (i, name, call), data in zip(jobs, pool.map(lambda j: _post(j[2][0], j[2][1]), jobs)):
            raws[i][name] = data.get(call[2], [])
    return {"organization": (orgs[0].get("name") if orgs else ""), "facilities": facilities, "raw": raws}


# ── Figures (pure: no I/O, so the tests can feed them fixed rows) ─────────────

def _months_back(today: date, n: int) -> list[str]:
    out, y, m = [], today.year, today.month
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


def _month_end(ym: str, today: date) -> date:
    y, m = int(ym[:4]), int(ym[5:7])
    nxt = date(y + (m == 12), (m % 12) + 1, 1)
    return min(nxt - timedelta(days=1), today)


def _tenant_url(customer_id: str) -> str:
    return f"{APP_URL}/tenants/{customer_id}" if customer_id else ""


def summarize_facility(fac: dict, raw: dict) -> dict:
    today: date = raw["today"]
    today_s = today.isoformat()
    month = today_s[:7]
    rr = raw["rent_roll"]

    rented = [r for r in rr if r.get("status") == "RENTED"]
    vacant = [r for r in rr if r.get("status") == "VACANT"]
    held = [r for r in rr if r.get("status") not in ("RENTED", "VACANT")]

    def area(rows):
        return round(sum((r.get("width") or 0) * (r.get("depth") or 0) for r in rows))

    rent_roll = sum(r.get("monthlyRentalAmount") or 0 for r in rented)
    street_rented = sum(r.get("standardRate") or 0 for r in rented)
    vacant_potential = sum(r.get("standardRate") or 0 for r in vacant)

    unit_name = {r["unitId"]: (r.get("unitName") or "").strip() for r in rr}
    by_customer = {r["customerId"]: r for r in rented if r.get("customerId")}
    by_unit = {r["unitId"]: r for r in rented}
    # A tenant can rent several units. Cubby's payment rows name the tenant
    # only, so a payment is shown against all of that tenant's units.
    units_of = defaultdict(list)
    for r in rented:
        if r.get("customerId"):
            units_of[r["customerId"]].append((r.get("unitName") or "").strip())
    unit_reason = {u["unitId"]: (u.get("rentability") or {}) for u in raw["units"]}

    # Unit types: where the empty units and the pricing room are.
    groups: dict[str, dict] = {}
    for r in rr:
        name = (r.get("pricingGroupName") or "Other").strip()
        g = groups.setdefault(name, {"name": name, "total": 0, "rented": 0, "vacant": 0, "unavailable": 0,
                                     "street": r.get("standardRate") or 0, "rentSum": 0, "vacantPotential": 0,
                                     "width": r.get("width") or 0, "depth": r.get("depth") or 0,
                                     "parking": "parking" in name.lower()})
        g["total"] += 1
        if r.get("status") == "RENTED":
            g["rented"] += 1
            g["rentSum"] += r.get("monthlyRentalAmount") or 0
        elif r.get("status") == "VACANT":
            g["vacant"] += 1
            g["vacantPotential"] += r.get("standardRate") or 0
        else:
            g["unavailable"] += 1
    unit_types = sorted(groups.values(), key=lambda g: (-g["vacantPotential"], g["name"]))

    # Tenants paying under today's street rate (rent-increase candidates). A
    # lease at $0 is a comped unit (an owner's, the facility's), not a tenant to
    # raise, so it stays out of the list and the gap.
    below = [r for r in rented if (r.get("standardRate") or 0) > (r.get("monthlyRentalAmount") or 0) > 0]
    below.sort(key=lambda r: (r.get("standardRate") or 0) - (r.get("monthlyRentalAmount") or 0), reverse=True)
    below_gap = sum((r.get("standardRate") or 0) - (r.get("monthlyRentalAmount") or 0) for r in below)

    # Receivables.
    buckets = dict.fromkeys(AGING_KEYS.values(), 0)
    past_due_rows = []
    for e in raw["receivables"]:
        amounts = {AGING_KEYS.get(x.get("range"), "unknown"): x.get("amount") or 0 for x in e.get("ranges", [])}
        for k, v in amounts.items():
            buckets[k] += v
        oldest = next((AGING_KEYS[k] for k in reversed(AGING[:5]) if amounts.get(AGING_KEYS[k])), "d0_30")
        row = by_unit.get(e.get("unitId")) or {}   # the unit that owes, not the tenant's other units
        past_due_rows.append({
            "unit": (e.get("unitName") or "").strip(), "tenant": e.get("customerName") or "",
            "amount": e.get("totalAmount") or 0, "oldest": oldest, "buckets": amounts,
            "autoPay": bool(row.get("autoPayEnabled")), "overlocked": bool(row.get("overlockApplied")),
            "paidThrough": row.get("paidThroughDate") or "", "url": _tenant_url(e.get("customerId")),
        })
    past_due_rows.sort(key=lambda r: -r["amount"])
    past_due = sum(r["amount"] for r in past_due_rows)

    # Locks: place one on a unit Cubby flags, take one off a unit that has paid.
    def lock_row(r):
        return {"unit": (r.get("unitName") or "").strip(), "tenant": r.get("customerName") or "",
                "paidThrough": r.get("paidThroughDate") or "", "url": _tenant_url(r.get("customerId"))}
    to_lock = [lock_row(r) for r in rented if r.get("overlockNeeded") and not r.get("overlockApplied")]
    to_unlock = [lock_row(r) for r in rented if r.get("overlockApplied") and r.get("paid")]

    # Move-ins and move-outs, from the leases themselves.
    leases = raw["leases"]
    months = _months_back(today, HISTORY_MONTHS)
    since = (today - timedelta(days=ACTIVITY_DAYS)).isoformat()
    moved_in, moved_out = defaultdict(int), defaultdict(int)
    move_days: dict[str, list] = {}
    for le in leases:
        mi, mo = le.get("moveInDate") or "", le.get("moveOutDate") or ""
        if mi and mi <= today_s:
            moved_in[mi[:7]] += 1
            if mi >= since:
                move_days.setdefault(mi, [0, 0])[0] += 1
        if mo and mo <= today_s:
            moved_out[mo[:7]] += 1
            if mo >= since:
                move_days.setdefault(mo, [0, 0])[1] += 1
    history = []
    for ym in months:
        end = _month_end(ym, today).isoformat()
        occupied = sum(1 for le in leases
                       if (le.get("moveInDate") or "9") <= end and not ((le.get("moveOutDate") or "") and le["moveOutDate"] <= end))
        history.append({"month": ym, "moveIns": moved_in.get(ym, 0), "moveOuts": moved_out.get(ym, 0), "rented": occupied})

    active = [le for le in leases if not ((le.get("moveOutDate") or "") and le["moveOutDate"] <= today_s)]

    def lease_row(le, when):
        row = by_customer.get(le.get("customerId")) or {}
        return {"unit": unit_name.get(le.get("unitId"), ""), "tenant": row.get("customerName") or "",
                "date": when, "url": _tenant_url(le.get("customerId"))}
    moving_out = sorted((lease_row(le, (le.get("scheduledMoveOut") or {}).get("moveOutDate") or "")
                         for le in active if le.get("scheduledMoveOut")), key=lambda r: r["date"])
    moving_in = sorted((lease_row(le, le["moveInDate"]) for le in active if (le.get("moveInDate") or "") > today_s),
                       key=lambda r: r["date"])
    rent_changes = [le for le in active if le.get("rentChangeScheduledDate") and le.get("rentChangeNewRentAmount") is not None]
    protected = sum(1 for le in active if (le.get("coverage") or {}).get("coverageType") == "ORGANISATION")

    # Leads.
    now = datetime.now(timezone.utc)

    def age_days(iso):
        try:
            return max(0, (now - datetime.fromisoformat((iso or "").replace("Z", "+00:00"))).days)
        except ValueError:
            return 0
    leads = raw["leads"]
    lead_status = defaultdict(int)
    for ld in leads:
        lead_status[ld.get("status") or "UNKNOWN"] += 1
    open_leads = sorted(({
        "status": ld.get("status") or "", "source": (ld.get("customSource") or ld.get("source") or "").strip(),
        "createdAt": ld.get("createdAt") or "", "ageDays": age_days(ld.get("createdAt")),
        "targetMoveIn": ld.get("targetMoveInDate") or "", "url": _tenant_url(ld.get("customerId")),
    } for ld in leads if ld.get("status") in OPEN_LEAD), key=lambda r: -r["ageDays"])
    counted = [ld for ld in leads if ld.get("status") != "DUPLICATE"]

    # Tasks (open only).
    tasks = sorted(({
        "title": (t.get("title") or "").strip(), "dueDate": t.get("dueDate") or "",
        "overdue": bool(t.get("dueDate")) and t["dueDate"] < today_s, "unit": unit_name.get(t.get("unitId"), ""),
    } for t in raw["tasks"]), key=lambda t: t["dueDate"] or "9")

    # Payments, day by day. Cubby only has them from the day a facility moved
    # onto it, so the early part of the window is simply empty.
    daily: dict[str, dict] = {}
    for i in range(ACTIVITY_DAYS - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        daily[d] = {"date": d, "collected": 0, "failed": 0}
    failed_rows, collected_mtd = [], 0
    for p in raw["payments"]:
        d = (p.get("createdAt") or "")[:10]
        ok = p.get("status") == "SUCCEEDED"
        if ok and d[:7] == month:
            collected_mtd += p.get("amount") or 0
        if d in daily:
            if ok:
                daily[d]["collected"] += p.get("amount") or 0
            elif p.get("status") in FAILED_PAYMENT:
                daily[d]["failed"] += 1
        if p.get("status") in FAILED_PAYMENT and d >= (today - timedelta(days=FAILED_DAYS)).isoformat():
            row = by_customer.get(p.get("customerId")) or {}
            failed_rows.append({"date": d, "amount": p.get("amount") or 0, "method": p.get("methodType") or "",
                                "reason": p.get("reason") or "", "tenant": row.get("customerName") or "",
                                "unit": ", ".join(sorted(units_of.get(p.get("customerId"), []))), "url": _tenant_url(p.get("customerId"))})
    failed_rows.sort(key=lambda r: r["date"], reverse=True)

    return {
        "id": fac["facilityId"],
        "name": fac.get("name") or "",
        "shortName": (fac.get("name") or "").replace("Greens Storage", "").strip() or (fac.get("name") or ""),
        "asOf": today_s,
        "units": {"total": len(rr), "rented": len(rented), "vacant": len(vacant), "unavailable": len(held)},
        "area": {"total": area(rr), "rented": area(rented)},
        "rent": {"rentRoll": rent_roll, "streetRented": street_rented, "vacantPotential": vacant_potential,
                 "belowStreetGap": below_gap, "belowStreetCount": len(below)},
        "autoPay": sum(1 for r in rented if r.get("autoPayEnabled")),
        "protected": protected,
        "pastDue": {"total": past_due, "tenants": len(past_due_rows), "buckets": buckets, "rows": past_due_rows},
        "locks": {"toPlace": to_lock, "toRemove": to_unlock, "applied": sum(1 for r in rr if r.get("overlockApplied"))},
        "history": history,
        "moves": {"insMtd": moved_in.get(month, 0), "outsMtd": moved_out.get(month, 0),
                  "movingOut": moving_out, "movingIn": moving_in,
                  "daily": [{"date": d, "ins": v[0], "outs": v[1]} for d, v in sorted(move_days.items())]},
        "rentChanges": {"count": len(rent_changes),
                        "lift": sum((le.get("rentChangeNewRentAmount") or 0) - (le.get("monthlyRentalAmount") or 0) for le in rent_changes)},
        "unitTypes": unit_types,
        "belowStreet": [{"unit": (r.get("unitName") or "").strip(), "tenant": r.get("customerName") or "",
                         "type": (r.get("pricingGroupName") or "").strip(), "rent": r.get("monthlyRentalAmount") or 0,
                         "street": r.get("standardRate") or 0, "moveIn": r.get("moveInDate") or "",
                         "lastChange": r.get("lastRentChangeDate") or "", "url": _tenant_url(r.get("customerId"))}
                        for r in below[:40]],
        "offMarket": sorted(({"unit": (r.get("unitName") or "").strip(), "type": (r.get("pricingGroupName") or "").strip(),
                              "reason": unit_reason.get(r["unitId"], {}).get("unrentableReason") or "OTHER",
                              "note": unit_reason.get(r["unitId"], {}).get("unrentableReasonNote") or "",
                              "street": r.get("standardRate") or 0} for r in held), key=lambda r: r["unit"]),
        "leads": {"total": len(counted), "open": len(open_leads), "reserved": lead_status.get("RESERVATION", 0),
                  "converted": lead_status.get("CONVERTED", 0), "byStatus": dict(lead_status), "rows": open_leads},
        "tasks": {"open": len(tasks), "overdue": sum(1 for t in tasks if t["overdue"]), "rows": tasks},
        "payments": {"collectedMtd": collected_mtd, "daily": list(daily.values()), "failed": failed_rows},
    }


def build(pulled: dict) -> dict:
    return {
        "organization": pulled.get("organization") or "",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "facilities": [summarize_facility(f, r) for f, r in zip(pulled["facilities"], pulled["raw"])],
    }


# ── Daily history ─────────────────────────────────────────────────────────────
# Cubby reports today only. One row per facility per day is what lets the
# screen show whether past-due money and the rent roll are going up or down.

def save_snapshots(payload: dict) -> None:
    import models
    from database import SessionLocal
    stamp = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    try:
        for f in payload["facilities"]:
            sid = f"{f['id']}:{f['asOf']}"
            row = db.get(models.CubbyDailySnapshot, sid)
            if row is None:
                row = models.CubbyDailySnapshot(id=sid, facility_id=f["id"], snapshot_date=f["asOf"])
                db.add(row)
            row.units_total = f["units"]["total"]
            row.units_rented = f["units"]["rented"]
            row.units_vacant = f["units"]["vacant"]
            row.units_unavailable = f["units"]["unavailable"]
            row.area_total = f["area"]["total"]
            row.area_rented = f["area"]["rented"]
            row.rent_roll_cents = f["rent"]["rentRoll"]
            row.vacant_potential_cents = f["rent"]["vacantPotential"]
            row.past_due_cents = f["pastDue"]["total"]
            row.past_due_tenants = f["pastDue"]["tenants"]
            row.autopay_count = f["autoPay"]
            row.captured_at = stamp
        db.commit()
    finally:
        db.close()


def load_trend(days: int = 120) -> list[dict]:
    import models
    from database import SessionLocal
    since = (datetime.now(ZoneInfo(DEFAULT_TZ)).date() - timedelta(days=days)).isoformat()
    db = SessionLocal()
    try:
        rows = (db.query(models.CubbyDailySnapshot)
                .filter(models.CubbyDailySnapshot.snapshot_date >= since)
                .order_by(models.CubbyDailySnapshot.snapshot_date).all())
        return [{"date": r.snapshot_date, "facilityId": r.facility_id, "rented": r.units_rented,
                 "total": r.units_total, "rentRoll": r.rent_roll_cents, "pastDue": r.past_due_cents,
                 "pastDueTenants": r.past_due_tenants} for r in rows]
    finally:
        db.close()


# ── Cached read ───────────────────────────────────────────────────────────────

_cache: tuple[float, dict] | None = None
_pulled: dict | None = None     # the raw rows behind _cache, for lookup and the report exports
_lock = threading.Lock()
STALE_OK = 12 * 3600.0       # past this, a reader waits for a pull instead of seeing old figures


def _refresh() -> dict:
    global _cache, _pulled
    pulled = pull()
    payload = build(pulled)
    try:
        save_snapshots(payload)
        payload["trend"] = load_trend()
    except Exception as e:  # noqa: BLE001 - history is a bonus; today's figures still show
        print(f"[cubby] snapshot skipped: {type(e).__name__}")
        payload["trend"] = []
    _cache = (time.monotonic(), payload)
    _pulled = pulled
    return payload


def _refresh_quietly() -> None:
    if not _lock.acquire(blocking=False):
        return   # a pull is already running
    try:
        _refresh()
    except Exception as e:  # noqa: BLE001 - the reader already has the older answer
        print(f"[cubby] background refresh failed: {type(e).__name__}: {getattr(e, 'message', '')}")
    finally:
        _lock.release()


def summary(fresh: bool = False) -> dict:
    """The module's payload. Blocking (Cubby HTTP + DB) - call it in a thread.

    A full pull takes several seconds, so a reader never waits for one when
    there is an answer to show: under 10 minutes old it is served as is; older
    than that it is still served, and a pull starts behind it for the next
    reader. Only an empty cache, a very old one, or Refresh waits. One pull at
    a time - a second caller waits for the first and shares its answer."""
    hit = _cache
    age = time.monotonic() - hit[0] if hit else None
    if hit and not fresh:
        if age < CACHE_TTL:
            return hit[1]
        if age < STALE_OK:
            threading.Thread(target=_refresh_quietly, daemon=True).start()
            return hit[1]
    with _lock:
        hit = _cache
        # 30s floor on a forced refresh, so a held-down button cannot hammer Cubby.
        if hit and time.monotonic() - hit[0] < (30.0 if fresh else CACHE_TTL):
            return hit[1]
        return _refresh()


# ── Lookup and report exports (read from the same pull the screen shows) ─────

def _rows() -> list[tuple[dict, dict]]:
    """[(facility, raw rows)] behind the cached summary. Blocking."""
    summary()
    return list(zip(_pulled["facilities"], _pulled["raw"])) if _pulled else []


def _short(fac: dict) -> str:
    return (fac.get("name") or "").replace("Greens Storage", "").strip() or (fac.get("name") or "")


def _us(iso: str) -> str:
    """YYYY-MM-DD -> MM/DD/YYYY, for an export a person reads."""
    return f"{iso[5:7]}/{iso[8:10]}/{iso[:4]}" if len(iso or "") >= 10 else ""


def _dollars(cents) -> str:
    return f"{(cents or 0) / 100:.2f}"


def lookup(q: str, limit: int = 12) -> list[dict]:
    """Find a unit or a tenant across every facility - the question staff open
    Cubby for most ("is B211 paid?", "what does this tenant rent?"). Blocking."""
    q = (q or "").strip().lower()
    if len(q) < 2:
        return []
    out = []
    for fac, raw in _rows():
        owed = {e.get("unitId"): e.get("totalAmount") or 0 for e in raw["receivables"]}
        for r in raw["rent_roll"]:
            unit = (r.get("unitName") or "").strip()
            tenant = r.get("customerName") or ""
            # A unit number is matched from its start ("b2" finds B211, not AB21); a name anywhere.
            rank = 0 if unit.lower() == q else 1 if unit.lower().startswith(q) else 2 if q in tenant.lower() else None
            if rank is None:
                continue
            rented = r.get("status") == "RENTED"
            out.append((rank, unit, {
                "facility": _short(fac), "facilityId": fac["facilityId"], "unit": unit,
                "type": (r.get("pricingGroupName") or "").strip(),
                "status": "rented" if rented else "vacant" if r.get("status") == "VACANT" else "off-market",
                "street": r.get("standardRate") or 0,
                "tenant": tenant if rented else "", "rent": r.get("monthlyRentalAmount") or 0 if rented else 0,
                "balance": owed.get(r["unitId"], 0) if rented else 0,
                "paidThrough": r.get("paidThroughDate") or "" if rented else "",
                "moveIn": r.get("moveInDate") or "" if rented else "",
                "autoPay": bool(r.get("autoPayEnabled")) if rented else False,
                "overlocked": bool(r.get("overlockApplied")),
                "url": _tenant_url(r.get("customerId")) if rented else "",
            }))
    out.sort(key=lambda t: (t[0], t[1]))
    return [row for _, _, row in out[:limit]]


REPORTS = {"rent-roll": "Rent Roll", "aged-receivables": "Aged Receivables"}


def report(kind: str, facility_id: str = "") -> dict:
    """A Cubby report as columns and rows, ready to save as a spreadsheet.
    Tenant name, unit and money only - the same line the screen draws: no
    phone, email or address leaves here. Blocking."""
    cols: list[str] = []
    rows: list[list] = []
    as_of = ""
    for fac, raw in _rows():
        if facility_id and fac["facilityId"] != facility_id:
            continue
        as_of = raw["today"].isoformat()
        name = _short(fac)
        if kind == "rent-roll":
            cols = ["Facility", "Unit", "Unit Type", "Width", "Depth", "Status", "Tenant", "Company", "Move-In Date",
                    "Street Rate", "Monthly Rent", "Rent vs Street", "Paid Through", "Autopay", "Overlocked", "Balance Due"]
            owed = {e.get("unitId"): e.get("totalAmount") or 0 for e in raw["receivables"]}
            for r in sorted(raw["rent_roll"], key=lambda r: (r.get("unitName") or "")):
                rented = r.get("status") == "RENTED"
                rows.append([
                    name, (r.get("unitName") or "").strip(), (r.get("pricingGroupName") or "").strip(),
                    r.get("width") or "", r.get("depth") or "", (r.get("status") or "").title(),
                    r.get("customerName") or "", r.get("companyName") or "", _us(r.get("moveInDate") or ""),
                    _dollars(r.get("standardRate")), _dollars(r.get("monthlyRentalAmount")) if rented else "",
                    _dollars((r.get("monthlyRentalAmount") or 0) - (r.get("standardRate") or 0)) if rented else "",
                    _us(r.get("paidThroughDate") or ""), ("Yes" if r.get("autoPayEnabled") else "No") if rented else "",
                    "Yes" if r.get("overlockApplied") else "No", _dollars(owed.get(r["unitId"], 0)) if rented else "",
                ])
        elif kind == "aged-receivables":
            cols = ["Facility", "Unit", "Unit Type", "Tenant", "Total Due"] + ["0-30 Days", "31-60 Days", "61-90 Days", "91-120 Days", "120+ Days"]
            for e in sorted(raw["receivables"], key=lambda e: -(e.get("totalAmount") or 0)):
                by = {x.get("range"): x.get("amount") or 0 for x in e.get("ranges", [])}
                rows.append([name, (e.get("unitName") or "").strip(), (e.get("pricingGroupName") or "").strip(),
                             e.get("customerName") or "", _dollars(e.get("totalAmount"))]
                            + [_dollars(by.get(k)) for k in AGING[:5]])
        else:
            raise CubbyError(404, "No such report")
    return {"title": REPORTS[kind], "asOf": as_of, "columns": cols, "rows": rows}


async def cubby_snapshot_loop():
    """Started from main.py on the deployed API only. Re-reads Cubby every 15
    minutes, so the screen is current without anybody pressing Refresh and the
    daily history keeps going on days nobody opens it. Blocking work runs in a
    thread (CLAUDE.md: never on the event loop)."""
    await asyncio.sleep(180)
    while True:
        try:
            if configured():
                await asyncio.to_thread(summary, True)
        except Exception as e:  # noqa: BLE001
            print(f"[cubby] loop error: {type(e).__name__}: {getattr(e, 'message', '')}")
        await asyncio.sleep(SYNC_EVERY_SEC)
