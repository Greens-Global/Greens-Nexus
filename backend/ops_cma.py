"""Operations > Rate Management as a CMA (Competitive Market Analysis) -
Miranda's Dev/IT briefing and mockup (Oct 19-21 2026). It replaces the five
monthly Excel CMAs (GSE, GSF, GSM, GST, GSVC).

Pure functions only (the tests feed them fixed rows); the routes are
routers/ops_rates.py (the overview table) and routers/ops_cma.py (comp set,
surveys, overrides, import, history, review & push).

Calculations, exactly as the briefing (per unit type, the latest observation
per ACTIVE competitor):
  - Market low / high / avg EXCLUDE us and closed competitors, one set for
    all three (the GSF workbook read F-N for the range and F-M for the avg).
  - Variance $ = our Sell (web) rate - market avg; Variance % = Variance $ /
    market avg.
  - Revenue delta / month = (proposed - current Sell) x OCCUPIED units.
  - Occupancy = occupied / total units; vacant = unleased and rentable;
    offline = not rentable.
  - Suggested (to confirm with ops): raise halfway to the market avg when
    80%+ occupied and more than 2% below it; lower halfway toward it when
    under 50% occupied and more than 5% above it; otherwise hold. Hold when
    fewer than 2 comps. A rate ending in .50 keeps its .50 ending.
  - Competitor units match ours by size and kind, never by row position. No
    exact size -> the nearest size, and the row says "nearest size". A row a
    person matched to one of our unit types in a survey counts for THAT type.
Which observation is a competitor's price for a size: the newest one in the
last FRESH_DAYS, except that a staff override with a lock (source
"override", locked_until on or after today) beats newer website / StorTrack
reads until the lock ends. A competitor set to "Manual only" counts only
staff-entered rates.

Guardrails for Review & Push (enforced server-side): a change of more than
10%, or below the market low, needs the Owner as approver; a rate ending in
.50 keeps the .50; one pricing group cannot change twice within 7 days.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

import ops_market

FRESH_DAYS = ops_market.FRESH_DAYS
MIN_COMPS = 2
LOCK_DAYS = 30
RAISE_OCC, RAISE_GAP = 0.80, 0.02
LOWER_OCC, LOWER_GAP = 0.50, 0.05
AT_MARKET = 0.02
OWNER_STEP = 0.10
REPUSH_DAYS = 7
NEAREST_SPREAD = 0.5          # a "nearest size" may differ by at most half the area

METHODS = {"phone": "Phone Call", "drive_by": "Drive-By", "walk_in": "Walk-In / Mystery Shop", "flyer": "Flyer / Signage"}
STORAGE_ACCESS = ("Drive-Up", "Interior", "Climate")
PARKING_ACCESS = ("Gravel - Open - Drive-In", "Asphalt - Open - Drive-In", "Covered", "Pull-Thru")
CALCULATIONS = {"percent": "Percent Off", "fixed": "Fixed Amount Off", "first_month_1": "$1 First Month"}


# ── Sizes ────────────────────────────────────────────────────────────────────

_SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*['’]?\s*(?:x|X|×|\*|by)\s*(\d+(?:\.\d+)?)")


def parse_size(text) -> tuple[float, float] | None:
    """"8 x 10", "8'x10'", "10X20 parking" -> (8.0, 10.0). None when no size."""
    m = _SIZE.search(str(text or ""))
    if not m:
        return None
    w, d = float(m.group(1)), float(m.group(2))
    return (w, d) if w > 0 and d > 0 and w <= 200 and d <= 400 else None


def size_label(width, depth) -> str:
    return f"{float(width or 0):g}' x {float(depth or 0):g}'"


def nearest_type(width: float, depth: float, parking: bool, unit_types: list[dict]) -> dict:
    """Our unit type for a competitor's size: the exact size and kind first,
    else the nearest by area of the same kind. {"name", "exact", "note"};
    name "" when we have nothing of that kind."""
    key = ops_market.size_key(width, depth, parking)
    same = [t for t in unit_types if t.get("width") and t.get("depth") and bool(t.get("parking")) == bool(parking)]
    for t in same:
        if ops_market.size_key(t["width"], t["depth"], bool(t.get("parking"))) == key:
            return {"name": t["name"], "exact": True, "note": ""}
    if not same:
        return {"name": "", "exact": False, "note": "We have no unit of this kind"}
    area = width * depth
    t = min(same, key=lambda x: (abs(x["width"] * x["depth"] - area), x["name"]))
    return {"name": t["name"], "exact": False, "note": f"Nearest size to their {size_label(width, depth)}"}


# ── Money ────────────────────────────────────────────────────────────────────

def keep_ending(new_cents: float, old_cents: int | None) -> int:
    """Round a computed rate: to the nearest $x.50 when today's rate ends in
    .50 (Miranda's rates keep their .50), else to the nearest dollar."""
    if old_cents is not None and int(old_cents) % 100 == 50:
        return int(round((new_cents - 50) / 100.0)) * 100 + 50
    return int(round(new_cents / 100.0)) * 100


# ── The market for one unit type ─────────────────────────────────────────────

def _lock_active(o: dict, today: date) -> bool:
    return (o.get("source") == "override") and (o.get("locked_until") or "") >= today.isoformat()


def pick_comps(unit_type: dict, observations: list[dict], competitors: dict[str, dict], today: date) -> dict:
    """Competitor by competitor for one of our unit types, and the market
    figures from that ONE set.

    unit_type     {"name", "width", "depth", "parking"}
    observations  dicts with ops_market's keys (competitor_id, width, depth,
                  parking, rate_cents, observed_on, created_at, climate,
                  source) plus online_cents, promo, matched_unit_type,
                  locked_until, size_note when known
    competitors   {id: {"name", "distanceMiles", "priceSource", "special",
                  "adminFee", "insurance", "surveyDate"}} - ACTIVE ones only
                  (closed and removed ones are simply not in it)
    Returns {"comps", "low", "high", "avg", "count", "nearest"}."""
    out = {"comps": [], "low": None, "high": None, "avg": None, "count": 0, "nearest": ""}
    name = unit_type.get("name") or ""
    cutoff = (today - timedelta(days=FRESH_DAYS)).isoformat()

    def usable(o):
        c = competitors.get(o.get("competitor_id"))
        if not c or not o.get("rate_cents") or (o.get("observed_on") or "") < cutoff:
            return False
        if c.get("priceSource") == "manual" and o.get("source") in ("web", "stortrack"):
            return False
        return True
    valid = [o for o in observations if usable(o)]
    matched = [o for o in valid if (o.get("matched_unit_type") or "") == name and name]
    free = [o for o in valid if not o.get("matched_unit_type")]
    mine = list(matched)
    if unit_type.get("width") and unit_type.get("depth"):
        parking = bool(unit_type.get("parking"))
        key = ops_market.size_key(unit_type["width"], unit_type["depth"], parking)
        exact = [o for o in free if ops_market.size_key(o.get("width"), o.get("depth"), bool(o.get("parking"))) == key]
        mine += exact
        if not mine:
            area = unit_type["width"] * unit_type["depth"]
            sizes: dict[str, list] = {}
            for o in free:
                if bool(o.get("parking")) != parking or not o.get("width") or not o.get("depth"):
                    continue
                sizes.setdefault(ops_market.size_key(o["width"], o["depth"], parking), []).append(o)
            best = None
            for k, lst in sizes.items():
                a = lst[0]["width"] * lst[0]["depth"]
                gap = abs(a - area) / area
                if gap <= NEAREST_SPREAD and (best is None or gap < best[0]):
                    best = (gap, k, lst)
            if best:
                mine = best[2]
                out["nearest"] = size_label(mine[0]["width"], mine[0]["depth"])
    if not mine:
        return out
    climate = ops_market.unit_climate(name)

    def rank(o):
        fits = climate is None or o.get("climate") is None or bool(o["climate"]) == climate
        return (_lock_active(o, today), fits, o.get("observed_on") or "", o.get("created_at") or "", -o["rate_cents"])
    held: dict[str, dict] = {}
    for o in mine:
        cur = held.get(o["competitor_id"])
        if cur is None or rank(o) > rank(cur):
            held[o["competitor_id"]] = o
    comps = []
    for cid, o in held.items():
        c = competitors[cid]
        comps.append({
            "competitorId": cid, "competitor": c.get("name") or "", "distanceMiles": c.get("distanceMiles"),
            "rate": o["rate_cents"], "online": o.get("online_cents"),
            "promo": o.get("promo") or c.get("special") or "",
            "adminFee": c.get("adminFee"), "insurance": c.get("insurance") or "",
            "observedOn": o.get("observed_on") or "", "source": o.get("source") or "manual",
            "locked": _lock_active(o, today), "lockedUntil": o.get("locked_until") or "",
            "theirSize": size_label(o.get("width"), o.get("depth")),
            "matched": bool(o.get("matched_unit_type")), "note": o.get("size_note") or "",
            "priceSource": c.get("priceSource") or "",
        })
    comps.sort(key=lambda x: (x["distanceMiles"] is None, x["distanceMiles"] or 0, x["competitor"]))
    rates = [c["rate"] for c in comps]
    out.update({"comps": comps, "low": min(rates), "high": max(rates), "avg": int(round(sum(rates) / len(rates))),
                "count": len(rates)})
    return out


# ── The suggestion ───────────────────────────────────────────────────────────

def suggest(sell: int, avg: int | None, occupancy: float, comps: int, total: int, offline_only: bool) -> tuple[int | None, str, str]:
    """(suggested Sell rate in cents or None, the reason, the move:
    raise | lower | hold | none). Holds suggest today's rate."""
    if offline_only:
        return None, "All units offline - nothing to price", "none"
    if not total or not sell:
        return None, "No rate to compare - check this pricing group in Cubby", "none"
    if comps < MIN_COMPS or not avg:
        if comps == 0:
            return sell, "Hold - no comps for this size; add a manual rate before changing", "hold"
        return sell, "Hold - only 1 comp; add a manual rate before changing", "hold"
    gap = (sell - avg) / avg
    if occupancy >= RAISE_OCC and gap < -RAISE_GAP:
        return keep_ending(sell + (avg - sell) / 2, sell), "Raise halfway to market: 80%+ occupied, below avg", "raise"
    if occupancy < LOWER_OCC and gap > LOWER_GAP:
        return keep_ending(sell - (sell - avg) / 2, sell), "Lower toward market: under 50% occupied, above avg", "lower"
    if abs(gap) <= AT_MARKET:
        return sell, "Hold - at market", "hold"
    if gap < 0:
        if occupancy < LOWER_OCC:
            return sell, "Hold - already below market; occupancy is a demand issue, not price", "hold"
        return sell, "Hold - below market, but under 80% occupied", "hold"
    if occupancy >= LOWER_OCC:
        return sell, "Hold - above market, but 50%+ occupied", "hold"
    return sell, "Hold - only a little above market", "hold"


def algorithm_web_rate(row: dict) -> int | None:
    """Miranda's rate algorithm's Web Rate for a unit type ("predetermined by
    our rate algorithms which I can provide", Oct 21 2026). NOT PROVIDED YET:
    returns None, and the Web Rate column shows Cubby's current web rate.
    Drop the algorithm in here - it gets the overview row (occupancy, days
    vacant, our rates, market low / high / avg, comps) and returns cents."""
    return None


# ── Days vacant ──────────────────────────────────────────────────────────────

def days_vacant(rent_roll: list[dict], leases: list[dict], today: date) -> dict[str, dict]:
    """{pricing group name: {"avg", "known", "vacant"}} - the average days the
    group's VACANT units have been unrented, counted from the last move-out
    Cubby has for each unit (a unit never rented in Cubby has no start and is
    left out of the average, counted in `vacant` only)."""
    last_out: dict[str, str] = {}
    t = today.isoformat()
    for le in leases or []:
        uid, mo = le.get("unitId") or "", (le.get("moveOutDate") or "")[:10]
        if uid and mo and mo <= t and mo > last_out.get(uid, ""):
            last_out[uid] = mo
    out: dict[str, dict] = {}
    for r in rent_roll or []:
        if r.get("status") != "VACANT":
            continue
        g = out.setdefault((r.get("pricingGroupName") or "Other").strip(), {"days": [], "vacant": 0})
        g["vacant"] += 1
        since = last_out.get(r.get("unitId") or "")
        if since:
            try:
                g["days"].append(max(0, (today - date.fromisoformat(since)).days))
            except ValueError:
                pass
    return {k: {"avg": round(sum(v["days"]) / len(v["days"])) if v["days"] else None,
                "known": len(v["days"]), "vacant": v["vacant"]} for k, v in out.items()}


# ── Guardrails ───────────────────────────────────────────────────────────────

def _usd(c) -> str:
    return f"${(c or 0) / 100:,.2f}"


def guard(old_web: int | None, new_web: int, old_standard: int | None, new_standard: int | None,
          market_low: int | None, last_change_on: str, today: date) -> dict:
    """{"needsOwner", "notes", "blocks"} for one rate change. `notes` explain
    why the Owner must approve; `blocks` stop the change outright."""
    notes, blocks = [], []
    needs_owner = False
    if old_web:
        step = abs(new_web - old_web) / old_web
        if step > OWNER_STEP:
            needs_owner = True
            notes.append(f"Changes the web rate {round(step * 100, 1)}% (over 10%) - needs the Owner's approval")
    if market_low and new_web < market_low:
        needs_owner = True
        notes.append(f"Below the market low ({_usd(market_low)}) - needs the Owner's approval")
    for label, old, new in (("web", old_web, new_web), ("standard", old_standard, new_standard)):
        if new is None or old is None:
            continue
        if int(old) % 100 == 50 and int(new) % 100 != 50:
            blocks.append(f"Keep the .50 ending on the {label} rate: use {_usd(keep_ending(new, old))}")
    if last_change_on:
        try:
            last = date.fromisoformat(last_change_on[:10])
            if (today - last).days < REPUSH_DAYS:
                blocks.append(f"This pricing group changed on {last.strftime('%m/%d/%Y')} - "
                              f"it can't change again within {REPUSH_DAYS} days")
        except ValueError:
            pass
    return {"needsOwner": needs_owner, "notes": notes, "blocks": blocks}


# ── Promotions (Cubby: discounts) ────────────────────────────────────────────

def promo_text(p: dict) -> str:
    """"First 2 months 50% off", "$25 off for 3 months", "$1 first month"."""
    calc = p.get("calculation")
    periods = int(p.get("periods") or 1)
    months = "month" if periods == 1 else f"{periods} months"
    if calc == "first_month_1":
        return "$1 first month"
    amount = float(p.get("amount") or 0)
    if calc == "percent":
        return f"First {months} {amount:g}% off"
    return f"${amount:,.2f} off for {'1 month' if periods == 1 else months}"


def validate_promo(p: dict) -> list[str]:
    errs = []
    if not (p.get("name") or "").strip():
        errs.append("Give the promotion a name")
    if p.get("calculation") not in CALCULATIONS:
        errs.append("Pick how the discount is calculated")
    if p.get("calculation") in ("percent", "fixed"):
        try:
            a = float(p.get("amount"))
        except (TypeError, ValueError):
            a = 0
        if a <= 0 or (p.get("calculation") == "percent" and a > 100):
            errs.append("Enter the discount amount" if p.get("calculation") == "fixed" else "Enter a percent between 1 and 100")
    try:
        n = int(p.get("periods") or 0)
    except (TypeError, ValueError):
        n = 0
    if n < 1 or n > 24:
        errs.append("Number of periods must be 1 to 24")
    s, e = p.get("start") or "", p.get("end") or ""
    try:
        if s:
            date.fromisoformat(s)
        if e:
            date.fromisoformat(e)
    except ValueError:
        errs.append("Dates must be real calendar dates")
    else:
        if s and e and e < s:
            errs.append("The end date is before the start date")
    if not p.get("unitTypes"):
        errs.append("Pick at least one pricing group")
    return errs


# ── Import (manual competitor rates from CSV / XLS) ──────────────────────────

IMPORT_COLUMNS = ["Competitor", "Their Size", "Kind", "Surface / Access", "Street Rate", "Online Rate",
                  "Survey Date", "Special", "Admin Fee", "Compares To"]


def _money(v) -> int | None:
    s = re.sub(r"[$,\s]", "", str(v or ""))
    if not s:
        return None
    try:
        n = float(s)
    except ValueError:
        return -1
    return int(round(n * 100)) if n > 0 else -1


def _day(v, today: date) -> str | None:
    s = str(v or "").strip()
    if not s:
        return today.isoformat()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    try:
        d = date(int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else date.fromisoformat(s[:10])
    except (ValueError, AttributeError):
        return None
    return d.isoformat() if d <= today else None


def read_import(rows: list[dict], competitors: dict[str, str], unit_types: list[dict], today: date) -> list[dict]:
    """Each imported row checked: {"row", "ok", "errors", ...parsed}.
    `rows` are {column header: cell}; `competitors` is {lowercased name: id}
    (active ones); `unit_types` our types for the match."""
    out = []
    types = {t["name"].lower(): t["name"] for t in unit_types}
    for i, r in enumerate(rows, start=2):           # row 1 is the header
        g = {str(k).strip().lower(): v for k, v in (r or {}).items()}
        errs = []
        name = str(g.get("competitor") or "").strip()
        cid = competitors.get(name.lower())
        if not name:
            errs.append("No competitor")
        elif not cid:
            errs.append(f"{name} is not in this facility's comp set - add it first")
        size = parse_size(g.get("their size"))
        if not size:
            errs.append("Their Size must read like 10 x 20")
        kind = str(g.get("kind") or "storage").strip().lower()
        parking = kind.startswith("park") or kind in ("rv", "vehicle", "boat")
        if kind and not (parking or kind.startswith("stor")):
            errs.append("Kind must be Storage or Parking")
        street = _money(g.get("street rate"))
        online = _money(g.get("online rate"))
        if street is None or street < 0:
            errs.append("Street Rate must be a dollar amount")
        if online is not None and online < 0:
            errs.append("Online Rate must be a dollar amount")
        day = _day(g.get("survey date"), today)
        if day is None:
            errs.append("Survey Date must be MM/DD/YYYY and not in the future")
        fee = _money(g.get("admin fee"))
        if fee is not None and fee < 0:
            errs.append("Admin Fee must be a dollar amount")
        match = str(g.get("compares to") or "").strip()
        matched = ""
        if match:
            matched = types.get(match.lower(), "")
            if not matched:
                errs.append(f"Compares To: {match} is not one of our unit types")
        elif size:
            matched = nearest_type(size[0], size[1], parking, unit_types)["name"]
        out.append({"row": i, "ok": not errs, "errors": errs, "competitor": name, "competitorId": cid or "",
                    "width": size[0] if size else None, "depth": size[1] if size else None, "parking": parking,
                    "access": str(g.get("surface / access") or "").strip()[:60],
                    "street": street if street and street > 0 else None, "online": online if online and online > 0 else None,
                    "observedOn": day or "", "special": str(g.get("special") or "").strip()[:200],
                    "adminFee": fee if fee and fee > 0 else None, "matchedUnitType": matched})
    return out
