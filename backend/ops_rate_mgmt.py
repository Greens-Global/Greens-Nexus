"""Operations -> Rate Management (Neil / Miranda, Oct 20 2026): the CMA screen.

Every unit type we rent (a Cubby pricing group), what it sells for, what the
competitors charge, the rule's suggestion, and a PROPOSED rate a person types.
Proposals are drafts (`ops_rate_drafts`) until a manager reviews them and
pushes them to Cubby; every push, failed tries included, is a row in
`ops_rate_pushes` - the history of OUR rates.

This is the ONE place Nexus writes to Cubby (cubby.py stays read-only): Cubby's
`POST /v1/pricing-groups/change-rates` (https://cubbystorage.github.io/docs/api/
#pricing-groups-change-rates) sets a pricing group's standardRate and webRate.
It needs an API key with Cubby's Manager role; a Search-role key answers 403.
Never called automatically - only from the Review & Push button, one unit type
per call, so each row gets its own result.

Words on the screen, in Cubby's terms:
  Set     the pricing group's standardRate (the in-store rate)
  Sell    its webRate - what a new customer pays online; Cubby falls back to
          the standard rate when no web rate is set
  Walk-In its walkInRate (shown, not changed: change-rates does not take it)

The market math is ops_market.compare, unchanged: the Sell rate is passed in as
the street rate, so the suggestion and the variance are both against what we
actually sell at. No second calculation path.

Pure functions up top (the tests feed them fixed rows); the Cubby calls at the
bottom are the only I/O, and they are blocking - call them in a thread.
"""
import os
import re
import threading
import time

import httpx

import cubby

GROUPS_TTL = 300.0           # a screen read of the pricing groups is at most 5 minutes old
VEHICLE = "Vehicle Storage"
SELF = "Self-Storage"
CATEGORIES = (SELF, VEHICLE)


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
    unit type the rent roll names that way cannot be pushed safely."""
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
    """What a push sends. The Set rate keeps its gap to the Sell rate unless
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
            "suggested": m.get("suggested"), "why": m.get("why") or "No competitor rate on file for this size.",
            "draft": d,
            "proposed": proposed,
            "proposedSet": p["newSet"] if p else None,
            "revDelta": (proposed - sell) * (t.get("vacant") or 0) if proposed is not None else 0,
            "ready": bool(d and (g or {}).get("pricingGroupId") and (proposed != sell or p["newSet"] != (g or {}).get("standardRate"))),
        })
    order = {c: i for i, c in enumerate(CATEGORIES)}
    rows.sort(key=lambda r: (order.get(r["category"], 9), r["width"] * r["depth"] or 1e9, r["name"]))
    return rows


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
        out.append(f"Cubby's pricing groups could not be read ({groups_error}), so nothing can be pushed right now.")
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
        out.append(f"Two Cubby pricing groups share the name {', '.join(dup[:3])}; rename one in Cubby to push it")
    return out


# ── Cubby (blocking I/O) ──────────────────────────────────────────────────────

def write_configured() -> bool:
    """A Manager-role Cubby key is set. Writes use it - the same one Revenue
    Management uses (ops_revenue.WRITE_KEY_ENV); the read-only sync key never writes."""
    import ops_revenue
    return bool(os.environ.get(ops_revenue.WRITE_KEY_ENV, "").strip())


def _call(path: str, body: dict, write: bool = False) -> dict:
    """POST to Cubby with the body as given (change-rates takes no `where`).
    `write` calls use the Manager-role key (CUBBY_MANAGER_API_KEY)."""
    if write:
        import ops_revenue
        key = os.environ.get(ops_revenue.WRITE_KEY_ENV, "").strip()
        if not key:
            raise cubby.CubbyError(503, f"{ops_revenue.WRITE_KEY_ENV} is not set - pushing rates needs a Manager-role Cubby key")
    else:
        key = cubby._key()
    try:
        r = httpx.post(f"{cubby.BASE}/{path}", json=body,
                       headers={"Authorization": f"Bearer {key}"}, timeout=60)
    except httpx.HTTPError as e:
        raise cubby.CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        data = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        data = {}
    if r.status_code != 200:
        errors = (data.get("errors") if isinstance(data, dict) else None) or [f"Cubby returned {r.status_code}"]
        msg = "; ".join(str(e) for e in errors)
        if r.status_code in (401, 403):
            msg += " - the API key may be a read-only (Search) key; changing rates needs a Manager-role key from Cubby"
        raise cubby.CubbyError(r.status_code, msg)
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


def change_rate(pricing_group_id: str, standard_rate: int, web_rate: int) -> dict:
    """One pricing group's new Set (standard) and Sell (web) rates, in cents."""
    return _call("pricing-groups/change-rates", {"pricingGroups": [
        {"pricingGroupId": pricing_group_id, "standardRate": int(standard_rate), "webRate": int(web_rate)}]}, write=True)


def address_of(fac: dict) -> str:
    c = (fac or {}).get("contact") or {}
    parts = [c.get("address"), c.get("city"), " ".join(x for x in (c.get("state"), c.get("zip")) if x)]
    return ", ".join(p for p in parts if p)
