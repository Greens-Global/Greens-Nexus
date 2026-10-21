"""Operations -> Rate Management (Neil / Miranda, Oct 20 2026): the CMA screen.

Every unit type we rent (a Cubby pricing group), what it sells for, what the
competitors charge, the rule's suggestion, and a PROPOSED rate a person types.
Proposals are drafts (`ops_rate_drafts`) until someone enters them in Cubby BY
HAND and marks them entered here; each mark is a row in `ops_rate_pushes`
(status "entered") - the history of OUR rates. (Rows from before Oct 20 2026
carry the old ok / failed / skipped statuses; they stay as history.)

This module only READS Cubby's pricing groups (`pricing-groups/search`);
`_call` refuses any other path. The one write (`pricing-groups/change-rates`)
lives in ops_cubby_push.py behind the Operations "Push to Cubby" switch, OFF
by default (Visesh, Oct 20-21 2026). While it is off, staff change rates in
Cubby by hand, using the review and the printable checklist.

Words on the screen, in Cubby's terms:
  Set     the pricing group's standardRate (the in-store rate)
  Sell    its webRate - what a new customer pays online; Cubby falls back to
          the standard rate when no web rate is set
  Walk-In its walkInRate (shown for reference)

The market math is ops_market.compare, unchanged: the Sell rate is passed in as
the street rate, so the suggestion and the variance are both against what we
actually sell at. No second calculation path.

Pure functions up top (the tests feed them fixed rows); the Cubby read at the
bottom is the only I/O, and it is blocking - call it in a thread.
"""
import math
import re
import threading
import time
from datetime import date

import httpx

import cubby
import ops_market

GROUPS_TTL = 300.0           # a screen read of the pricing groups is at most 5 minutes old
VEHICLE = "Vehicle Storage"
SELF = "Self-Storage"
CATEGORIES = (SELF, VEHICLE)

# The plain-language summary (Visesh, Oct 20 2026: "which competitor and all
# that data and what are we lacking").
STALE_DAYS = 30              # a competitor rate older than this is flagged as old (it still counts until FRESH_DAYS)
THIN_COMPETITORS = 3         # fewer competitor rates than this for a size and the median can swing on one price
AT_MARKET = 0.03             # within 3% of the median reads "At Market"
ODD_CENTS = 100              # a Sell rate of $1 or less is a placeholder, not a price
ODD_SET_GAP = 0.5            # Sell more than 50% away from Set looks like a typo
# The occupancy bands of ops_market._BANDS, as short words for the reason chip.
_BAND_WORDS = ((0.92, "Nearly Full"), (0.85, "Healthy"), (0.70, "Some Vacancy"), (0.0, "Vacancy"))


# ── Pure ──────────────────────────────────────────────────────────────────────

def category(unit_type: dict, group: dict | None = None) -> str:
    """Self-Storage or Vehicle Storage. Cubby's own flags first, then the name."""
    if group and (group.get("vehicleStorage") or group.get("parking")):
        return VEHICLE
    if unit_type.get("parking") or re.search(r"\b(parking|rv|boat|vehicle|auto|car)\b", (unit_type.get("name") or "").lower()):
        return VEHICLE
    return SELF


def group_index(groups: list[dict]) -> dict[str, dict | None]:
    """{pricing group name: group}. Two groups with one name map to None: a
    unit type the rent roll names that way cannot be matched safely."""
    out: dict[str, dict | None] = {}
    for g in groups or []:
        name = (g.get("name") or "").strip()
        out[name] = None if name in out else g
    return out


def sell_of(group: dict | None) -> int | None:
    if not group:
        return None
    web = group.get("webRate")
    return web if web is not None else group.get("standardRate")


def priced_types(unit_types: list[dict], idx: dict) -> list[dict]:
    """The facility's unit types with `street` = the Sell rate when Cubby's
    pricing group is known, so ops_market.compare prices against what we sell at."""
    out = []
    for t in unit_types:
        g = idx.get(t["name"])
        sell = sell_of(g)
        out.append({**t, "street": sell if sell is not None else t.get("street") or 0})
    return out


def plan(old_set: int | None, old_sell: int, proposed: int, proposed_set: int | None) -> dict:
    """The new rates to enter in Cubby. The Set rate keeps its gap to the Sell rate unless
    someone typed a Set rate of its own."""
    if proposed_set is not None:
        new_set = proposed_set
    elif old_set is not None:
        new_set = old_set + (proposed - (old_sell or 0))
    else:
        new_set = proposed
    return {"newSell": proposed, "newSet": max(new_set, 0)}


def build_rows(unit_types: list[dict], market_rows: list[dict], idx: dict, drafts: dict[str, dict]) -> list[dict]:
    """One row per unit type, in the screen's order (category, then size)."""
    by_name = {r["name"]: r for r in market_rows}
    rows = []
    for t in unit_types:
        g = idx.get(t["name"])
        m = by_name.get(t["name"]) or {}
        sell = sell_of(g)
        if sell is None:
            sell = t.get("street") or 0
        total = t.get("total") or 0
        median = m.get("marketMedian")
        d = drafts.get(t["name"])
        proposed = d["proposed"] if d else None
        p = plan(g.get("standardRate") if g else None, sell, proposed, d.get("proposedSet")) if d else None
        variance = sell - median if (median is not None and sell) else None
        offline_only = bool(total) and (t.get("unavailable") or 0) == total
        suggested, why = m.get("suggested"), m.get("why") or "No competitor rate on file for this size."
        if offline_only:
            suggested, why = None, "Every unit of this type is offline - nothing to price."
        elif suggested is not None and sell <= ODD_CENTS:
            suggested, why = None, "Our Sell rate looks like a placeholder. Fix it in Cubby first, then compare."
        rows.append({
            "name": t["name"], "category": category(t, g),
            "groupId": (g or {}).get("pricingGroupId") or "",
            "ambiguous": t["name"] in idx and idx[t["name"]] is None,
            "width": t.get("width") or 0, "depth": t.get("depth") or 0, "parking": bool(t.get("parking")),
            "total": total, "rented": t.get("rented") or 0, "vacant": t.get("vacant") or 0,
            "offline": t.get("unavailable") or 0,
            "occupancy": round((t.get("rented") or 0) / total, 4) if total else 0,
            "set": g.get("standardRate") if g else (t.get("street") or 0),
            "sell": sell,
            "walkIn": g.get("walkInRate") if g else None,
            "valuePricing": (g or {}).get("valuePricingStatus") or "",
            "competitors": m.get("competitors", 0),
            "marketLow": m.get("marketLow"), "marketHigh": m.get("marketHigh"), "marketMedian": median,
            "lowestBy": m.get("lowestBy", ""), "newestObservation": m.get("newestObservation", ""),
            "sources": m.get("sources", []),
            "variance": variance,
            "variancePct": round(variance / median, 4) if variance is not None and median else None,
            "suggested": suggested, "why": why,
            "offlineOnly": offline_only,
            "hasWeb": bool(g and g.get("webRate") is not None),
            "hasWalkIn": bool(g and g.get("walkInRate") is not None),
            "draft": d,
            "proposed": proposed,
            "proposedSet": p["newSet"] if p else None,
            "revDelta": (proposed - sell) * (t.get("vacant") or 0) if proposed is not None else 0,
            "ready": bool(d and (g or {}).get("pricingGroupId") and (proposed != sell or p["newSet"] != (g or {}).get("standardRate"))),
        })
    for r in rows:
        r["position"] = position(r)
        r["reason"], r["held"] = reason(r)
        r["suggestedDelta"] = (r["suggested"] - r["sell"]) * r["vacant"] if r["suggested"] is not None else 0
    order = {c: i for i, c in enumerate(CATEGORIES)}
    rows.sort(key=lambda r: (order.get(r["category"], 9), r["width"] * r["depth"] or 1e9, r["name"]))
    return rows


def position(row: dict) -> str:
    """Where our Sell rate sits: below | at | above the market median, none
    (no market rate for the size) or offline (nothing to price)."""
    if row.get("offlineOnly"):
        return "offline"
    if row.get("variancePct") is None:
        return "none"
    if abs(row["variancePct"]) <= AT_MARKET:
        return "at"
    return "below" if row["variancePct"] < 0 else "above"


def reason(row: dict) -> tuple[str, bool]:
    """(short reason for the suggestion, whether the 10% step held it back):
    the occupancy band in a word or two and which way the suggestion moves,
    e.g. "Nearly Full: Raise". The full sentence stays in `why`."""
    if row.get("suggested") is None:
        return "", False
    rentable = (row.get("rented") or 0) + (row.get("vacant") or 0)
    occ = (row.get("rented") or 0) / rentable if rentable else 0.0
    band = next(w for floor, w in _BAND_WORDS if occ >= floor)
    move = row["suggested"] - (row.get("sell") or 0)
    verb = "Raise" if move > 0 else "Lower" if move < 0 else "Hold"
    return f"{band}: {verb}", "Held to a" in (row.get("why") or "")


def distance_miles(stored, origin: tuple | None, lat, lng) -> float | None:
    """A competitor's distance: the one recorded on it, else straight-line
    miles from our facility when both points are known, else None."""
    if stored:
        return round(float(stored), 1)
    if not origin or origin[0] is None or origin[1] is None or lat is None or lng is None:
        return None
    la1, lo1, la2, lo2 = map(math.radians, (origin[0], origin[1], lat, lng))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return round(3958.8 * 2 * math.asin(math.sqrt(h)), 1)


def size_comps(unit_type: dict, observations: list[dict], competitors: dict[str, dict], today: date) -> list[dict]:
    """Competitor by competitor for one unit type: the same newest-fresh
    observation per competitor that ops_market.compare takes the low / median
    / high from (same size key, same climate preference, active competitors
    only), cheapest first. `competitors` is {id: {"name", "distanceMiles"}}.
    `observations` carry ops_market's keys plus online_cents / promo_cents /
    promo / space_type when the source gave them."""
    if not unit_type.get("width") or not unit_type.get("depth"):
        return []
    market = ops_market.latest_rates(observations, today, ops_market.unit_climate(unit_type.get("name")))
    key = ops_market.size_key(unit_type["width"], unit_type["depth"], bool(unit_type.get("parking")))
    out = []
    for cid, o in (market.get(key) or {}).items():
        c = competitors.get(cid)
        if not c:
            continue
        try:
            age = (today - date.fromisoformat(o["observed_on"])).days
        except (TypeError, ValueError):
            age = None
        out.append({
            "competitorId": cid, "competitor": c.get("name") or "", "distanceMiles": c.get("distanceMiles"),
            "rate": o["rate_cents"], "online": o.get("online_cents"), "promoRate": o.get("promo_cents"),
            "promo": o.get("promo") or "", "observedOn": o["observed_on"], "ageDays": age,
            "stale": age is not None and age > STALE_DAYS, "source": o.get("source") or "manual",
            "climate": o.get("climate"), "spaceType": o.get("space_type") or "",
        })
    out.sort(key=lambda x: (x["rate"], x["distanceMiles"] is None, x["distanceMiles"] or 0, x["competitor"]))
    return out


def headline(rows: list[dict]) -> dict:
    """The summary's numbers: how many unit types sit below / at / above the
    market, and what taking every Suggested rate is worth a month (on vacant
    units at the new rate - the same rule as Change per Month)."""
    pos = [r["position"] for r in rows]
    raises = sum(r["suggestedDelta"] for r in rows if r["suggestedDelta"] > 0)
    cuts = sum(r["suggestedDelta"] for r in rows if r["suggestedDelta"] < 0)
    return {
        "below": pos.count("below"), "at": pos.count("at"), "above": pos.count("above"),
        "noMarket": pos.count("none"), "offline": pos.count("offline"),
        "suggestions": sum(1 for r in rows if r["suggested"] is not None and r["suggested"] != r["sell"]),
        "upside": raises + cuts, "raises": raises, "cuts": cuts,
    }


def gaps(rows: list[dict], comps_by_name: dict[str, list[dict]], groups_ok: bool = True,
         competitors: list[dict] | None = None) -> list[dict]:
    """What the comparison is missing, each with the unit types it touches
    (in full) and what to do about it. Empty lists are left out."""
    live = [r for r in rows if not r.get("offlineOnly")]
    sized = [r for r in live if r.get("width") and r.get("depth")]
    out = []
    first = ("odd", "no_market", "thin", "stale", "no_web_walkin", "no_distance", "ambiguous", "no_size", "offline")

    def add(key, title, items, action):
        if items:
            out.append({"key": key, "title": title, "count": len(items), "items": items, "action": action})

    add("no_size", "No Size in Cubby", [r["name"] for r in live if not (r.get("width") and r.get("depth"))],
        "Competitor rates match by size. Give these a width and depth in Cubby, or leave them (mailboxes and the like have no market).")
    add("no_market", "No Competitor Rate", [r["name"] for r in sized if not r["competitors"]],
        "Add a competitor rate for these sizes by hand under Manage Competitors, or ask StorTrack to cover them.")
    add("thin", f"Fewer Than {THIN_COMPETITORS} Competitors",
        [f"{r['name']} ({r['competitors']})" for r in sized if 0 < r["competitors"] < THIN_COMPETITORS],
        "One price can swing the median. Record rates from more competitors for these sizes.")
    stale = []
    for r in sized:
        old = [c for c in comps_by_name.get(r["name"], []) if c["stale"]]
        if old:
            stale.append(f"{r['name']} ({len(old)} of {len(comps_by_name[r['name']])})")
    add("stale", f"Competitor Rates Older Than {STALE_DAYS} Days", stale,
        "Click Refresh Websites, or record newer rates by hand. Old rates still count until they are "
        f"{ops_market.FRESH_DAYS} days old.")
    odd = []
    for r in rows:
        if not r["total"]:
            continue
        sell, set_ = r["sell"] or 0, r.get("set") or 0
        if sell <= ODD_CENTS:
            odd.append(f"{r['name']} (Sell ${sell / 100:,.2f})")
        elif set_ and abs(sell - set_) / set_ > ODD_SET_GAP:
            odd.append(f"{r['name']} (Sell ${sell / 100:,.2f} vs Set ${set_ / 100:,.2f})")
    add("odd", "Our Rates That Look Wrong", odd,
        "Check these pricing groups in Cubby: a $0 or $0.01 rate is a placeholder, and Sell should sit near Set.")
    if groups_ok:
        add("no_web_walkin", "No Walk-In or Web Rate",
            [f"{r['name']} ({' and '.join(x for x, ok in (('Walk-In', r.get('hasWalkIn')), ('Web', r.get('hasWeb'))) if not ok)})"
             for r in live if r.get("groupId") and not (r.get("hasWalkIn") and r.get("hasWeb"))],
            "Set the missing rate on these pricing groups in Cubby. Without a Web rate, Sell is the Set rate.")
    add("no_distance", "Competitors With No Distance",
        [c["name"] for c in competitors or [] if c.get("distanceMiles") is None],
        "Add each one's address or distance under Manage Competitors so you can tell which are closest.")
    add("ambiguous", "Two Cubby Pricing Groups Share a Name", [r["name"] for r in rows if r.get("ambiguous")],
        "Rename one of them in Cubby so it can be priced here.")
    add("offline", "Offline Only", [f"{r['name']} ({r['offline']})" for r in rows if r.get("offlineOnly")],
        "These are offline units - nothing to price.")
    out.sort(key=lambda g: first.index(g["key"]))
    return out


def kpis(rows: list[dict]) -> dict:
    """The four cards above the table (the competitive set card is the router's)."""
    rateable = [r for r in rows if r["marketMedian"] and r["sell"]]
    sell_sum = sum(r["sell"] for r in rateable)
    med_sum = sum(r["marketMedian"] for r in rateable)
    total = sum(r["total"] for r in rows)
    rented = sum(r["rented"] for r in rows)
    return {
        "vsMarket": round(sell_sum / med_sum - 1, 4) if med_sum else None,
        "rateable": len(rateable),
        "belowMarket": sum(1 for r in rateable if r["sell"] < r["marketMedian"]),
        "occupancy": round(rented / total, 4) if total else 0,
        "units": total, "rented": rented, "offline": sum(r["offline"] for r in rows),
        "ready": sum(1 for r in rows if r["ready"]),
        "readyDelta": sum(r["revDelta"] for r in rows if r["ready"]),
    }


def attention(rows: list[dict], groups_error: str = "") -> list[str]:
    """Short sentences for the Needs Attention card, most useful first."""
    out = []
    if groups_error:
        out.append(f"Cubby's pricing groups could not be read ({groups_error}), so Sell and Set show the rent roll's standard rate.")
    single = [r["name"] for r in rows if r["competitors"] == 1]
    if single:
        out.append(f"{len(single)} unit {'type relies' if len(single) == 1 else 'types rely'} on a single comp: {', '.join(single[:4])}")
    for r in rows:
        if r["total"] and r["offline"] == r["total"]:
            out.append(f"{r['name']} is fully offline ({r['offline']} units)")
    bare = [r["name"] for r in rows if not r["competitors"] and r["vacant"]]
    if bare:
        out.append(f"No competitor rate for {len(bare)} unit {'type' if len(bare) == 1 else 'types'} with vacancy: {', '.join(bare[:4])}")
    dup = [r["name"] for r in rows if r["ambiguous"]]
    if dup:
        out.append(f"Two Cubby pricing groups share the name {', '.join(dup[:3])}; rename one in Cubby to price it here")
    return out


# ── Cubby (blocking I/O) ──────────────────────────────────────────────────────

def _call(path: str, body: dict) -> dict:
    """One Cubby READ (a `*/search`), with the body as given. Never route a
    write through here - writes go through ops_cubby_push (behind the switch)."""
    if not path.endswith("/search"):
        raise ValueError(f"Nexus only reads from Cubby; {path} is not a search")
    try:
        r = httpx.post(f"{cubby.BASE}/{path}", json=body,
                       headers={"Authorization": f"Bearer {cubby._key()}"}, timeout=60)
    except httpx.HTTPError as e:
        raise cubby.CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        data = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        data = {}
    if r.status_code != 200:
        errors = (data.get("errors") if isinstance(data, dict) else None) or [f"Cubby returned {r.status_code}"]
        raise cubby.CubbyError(r.status_code, "; ".join(str(e) for e in errors))
    return (data.get("data") if isinstance(data, dict) else None) or {}


_cache: dict[str, tuple[float, list, dict]] = {}
_lock = threading.Lock()


def pricing_groups(facility_id: str, fresh: bool = False) -> tuple[list[dict], dict]:
    """(pricing groups, facility details) for one facility. Raises CubbyError."""
    if not cubby.configured():
        raise cubby.CubbyError(503, "Cubby is not connected on this server")
    with _lock:
        hit = _cache.get(facility_id)
    if hit and not fresh and time.monotonic() - hit[0] < GROUPS_TTL:
        return hit[1], hit[2]
    data = _call("pricing-groups/search", {"where": {"facilityId": facility_id}, "expansions": ["facilities"]})
    groups = data.get("pricingGroups") or []
    fac = next((f for f in data.get("facilities") or [] if f.get("facilityId") == facility_id), {})
    with _lock:
        _cache[facility_id] = (time.monotonic(), groups, fac)
    return groups, fac


def forget(facility_id: str = "") -> None:
    with _lock:
        if facility_id:
            _cache.pop(facility_id, None)
        else:
            _cache.clear()


def address_of(fac: dict) -> str:
    c = (fac or {}).get("contact") or {}
    parts = [c.get("address"), c.get("city"), " ".join(x for x in (c.get("state"), c.get("zip")) if x)]
    return ", ".join(p for p in parts if p)
