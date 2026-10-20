"""Operations > Pricing Insights (Visesh, Oct 20 2026): "take account for all
this data ... create good insights - this would be really lifesaving for all".

Turns what the Cubby sync keeps (rent roll, units, leases, receivables -
cubby.py; pricing groups, discounts, our rate change history and tracked rent
increases - cubby_pricing.py) and the competitor rates Market Rates keeps
(StorTrack, websites, manual - ops_competitor_rates) into:

  - a ranked list of insights, each citing its own numbers
  - the sections of the Pricing Insights screen: Overview (per facility),
    Competitive Pricing, Trends, Standard Rates, ECRI, Revenue at Risk

No second calculation path: the market median and suggested rate come from
ops_market.compare (the Market Rates / Rate Management rule), tenants paying
under street from ops_revenue.tenant_rows, unit kinds from ops_unit_classes.
Every figure is computed from synced rows; when there are no competitor rates
the screen says "Connect StorTrack to compare with the market" ONCE instead of
producing market insights.

Pure functions up top (the tests feed them fixed rows). `load` / `payload`
at the bottom read the database and are blocking - call them in a thread.
Nothing here calls Cubby, and nothing here writes anywhere.

Tenant data: name, unit and money only (the same line Revenue Management
shows); never a phone, email or address.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import median

import ops_market
import ops_revenue
import ops_unit_classes as uc

# Cubby's own Standard Rates chips (Pricing > Standard rates).
SPIKE_NET = 3                 # > 3 net move-ins (or move-outs) in the last 7 days
LOW_OCC = 0.60                # pricing groups under 60% occupancy
LARGE_GAP = 0.20              # market target > 20% from today's rate
# Market position.
MARKET_GAP = 0.10             # 10% from the competitor median counts as above / below
FULL = 0.90
VACANT_OCC = 0.80
# Competitor moves.
MOVE_PCT = 0.10
MOVE_ALERT = 0.15             # a cut this deep is high severity
MOVE_DAYS = 7
# ECRI.
ECRI_MONTHS = 12
ECRI_HIGH_UPSIDE = 100_000    # $1,000 a month
SURVIVAL_DAYS = 60
SURVIVAL_MIN = 5
SURVIVAL_ALERT = 0.15
# Money at risk.
PAST_DUE_HIGH = 0.10
PAST_DUE_MED = 0.05
NEARBY_MILES = 15.0           # our other facilities shown in a facility's market grid
DISCOUNT_FULL = 0.90

SEVERITY = {"high": 0, "medium": 1, "low": 2}
KINDS = {
    "market-position": "Market Position",
    "competitor-move": "Competitor Moves",
    "move-in-spike": "Move-In Spikes",
    "move-out-spike": "Move-Out Spikes",
    "low-occupancy": "Low Occupancy",
    "no-move-ins": "No Move-Ins in 30 Days",
    "large-increase": "Large Increase Indicated",
    "large-decrease": "Large Decrease Indicated",
    "ecri": "ECRI",
    "revenue-risk": "Revenue at Risk",
    "discounts": "Discounts",
    "setup": "Setup",
}
CONNECT = "Connect StorTrack to compare with the market"


# ── Small helpers ────────────────────────────────────────────────────────────

def usd(cents) -> str:
    c = int(round(cents or 0))
    whole = c % 100 == 0
    return f"{'-' if c < 0 else ''}${abs(c) / 100:,.{0 if whole else 2}f}"


def plural(n: int, word: str) -> str:
    """'1 tenant' / '3 tenants'."""
    return f"{n} {word if n == 1 else word + 's'}"


def pct_text(x: float, digits: int = 0) -> str:
    return f"{abs(x) * 100:.{digits}f}%"


def _d(iso) -> date | None:
    try:
        return date.fromisoformat(str(iso or "")[:10])
    except ValueError:
        return None


def size_label(width, depth, parking: bool, climate) -> str:
    """'10x10 CC' / '10x10 NCC' / '10x10' / '12x30 Parking', like Cubby's Market Insights."""
    a, b = sorted((round(float(width or 0), 1), round(float(depth or 0), 1)))
    s = f"{a:g}x{b:g}"
    if parking:
        return f"{s} Parking"
    return f"{s} CC" if climate is True else f"{s} NCC" if climate is False else s


def column_key(width, depth, parking: bool, climate) -> str:
    a, b = sorted((round(float(width or 0), 1), round(float(depth or 0), 1)))
    c = "" if parking else ("cc" if climate is True else "ncc" if climate is False else "any")
    return f"{'P' if parking else 'S'}:{a:g}x{b:g}:{c}"


def market_target(market: int, rented: int, vacant: int) -> int:
    """Where ops_market's rule would put the rate with no 10% step limit: the
    market median moved by how full we are (ops_market._BANDS). Used for
    Cubby's Large Increase / Decrease chips."""
    rentable = rented + vacant
    occ = rented / rentable if rentable else 0.0
    _, factor, _ = next(b for b in ops_market._BANDS if occ >= b[0])
    return int(round(market * factor / 100.0)) * 100


def rate_at(current, changes: list[dict], when_iso: str):
    """A tracked rate as it was at `when_iso`: the old value of the first
    change after then, else today's value. `changes` = history rows of one
    group and field, oldest first."""
    for c in changes:
        if (c.get("changedAt") or "") > when_iso:
            return c.get("old")
    return current


def _avg(values) -> float | None:
    vals = [v for v in values if v]
    return sum(vals) / len(vals) if vals else None


def insight(fac: dict | None, kind: str, key: str, severity: str, title: str, detail: str,
            metrics: dict | None = None, action: str = "", link: dict | None = None, impact: int = 0) -> dict:
    fid = (fac or {}).get("id", "")
    return {"id": f"{kind}:{fid}:{key}", "facilityId": fid, "facility": (fac or {}).get("shortName", ""),
            "kind": kind, "kindLabel": KINDS.get(kind, kind), "severity": severity, "title": title, "detail": detail,
            "metrics": metrics or {}, "action": action, "link": link or {}, "impact": int(impact or 0)}


def rank(items: list[dict]) -> list[dict]:
    """High first, then the most money (or the biggest gap) first."""
    return sorted(items, key=lambda i: (SEVERITY.get(i["severity"], 9), -abs(i.get("impact") or 0), i["title"]))


# ── Pricing groups with their units, moves and market ────────────────────────

def group_stats(groups: list[dict], raw: dict, today: date, rules: dict | None = None) -> list[dict]:
    """One row per active Cubby pricing group of a facility: Cubby's rates, the
    units it holds (from the rent roll), and move-ins / move-outs from the
    leases. `groups` are cubby_pricing_groups rows as dicts (see _group_dict)."""
    today_s = today.isoformat()
    rr = {str(r.get("unitId")): r for r in raw.get("rent_roll", []) if r.get("unitId")}
    unit_group: dict[str, str] = {}
    for u in raw.get("units", []):
        if u.get("unitId") and u.get("pricingGroupId"):
            unit_group[str(u["unitId"])] = str(u["pricingGroupId"])
    by_name: dict[str, str] = {}
    for g in groups:
        by_name.setdefault((g.get("name") or "").strip(), g["pricingGroupId"])
    for uid, r in rr.items():
        if uid not in unit_group:
            gid = by_name.get((r.get("pricingGroupName") or "").strip())
            if gid:
                unit_group[uid] = gid
    counts: dict[str, dict] = defaultdict(lambda: {"total": 0, "rented": 0, "vacant": 0, "unavailable": 0, "rentSum": 0})
    for uid, gid in unit_group.items():
        r = rr.get(uid)
        if r is None:
            continue
        c = counts[gid]
        c["total"] += 1
        if r.get("status") == "RENTED":
            c["rented"] += 1
            c["rentSum"] += int(r.get("monthlyRentalAmount") or 0)
        elif r.get("status") == "VACANT":
            c["vacant"] += 1
        else:
            c["unavailable"] += 1

    d7, d30 = (today - timedelta(days=7)).isoformat(), (today - timedelta(days=30)).isoformat()
    moves: dict[str, dict] = defaultdict(lambda: {"ins7": 0, "outs7": 0, "ins30": 0, "outs30": 0})
    for le in raw.get("leases", []):
        gid = str(le.get("pricingGroupId") or "") or unit_group.get(str(le.get("unitId") or ""), "")
        if not gid:
            continue
        mi, mo = str(le.get("moveInDate") or "")[:10], str(le.get("moveOutDate") or "")[:10]
        m = moves[gid]
        if mi and d30 < mi <= today_s:
            m["ins30"] += 1
            if mi > d7:
                m["ins7"] += 1
        if mo and d30 < mo <= today_s:
            m["outs30"] += 1
            if mo > d7:
                m["outs7"] += 1

    out = []
    for g in groups:
        gid = g["pricingGroupId"]
        kind = uc.unit_class(g.get("name"), rules)
        if kind == uc.EXCLUDED:
            continue
        c, m = counts.get(gid) or {"total": 0, "rented": 0, "vacant": 0, "unavailable": 0, "rentSum": 0}, moves.get(gid) or {}
        std = g.get("standard")
        area = g.get("area") or (g.get("width") or 0) * (g.get("depth") or 0)
        out.append({
            "groupId": gid, "name": g.get("name") or "", "kind": kind,
            "label": size_label(g.get("width"), g.get("depth"), g.get("parking"), g.get("climate")),
            # A group without a size (Cubby's 0x0 records) has no place in the market grid.
            "column": (column_key(g.get("width"), g.get("depth"), g.get("parking"), g.get("climate"))
                       if (g.get("width") or 0) >= 1 and (g.get("depth") or 0) >= 1 else ""),
            "width": g.get("width") or 0, "depth": g.get("depth") or 0, "area": round(area, 1),
            "parking": bool(g.get("parking")), "climate": g.get("climate"),
            "standard": std, "web": g.get("web"), "walkIn": g.get("walkIn"), "strike": g.get("strike"),
            "perSqFt": round(std / area) if std and area else None,     # cents per sq ft
            "lastChangedAt": g.get("lastChangedAt") or "", "trackedSince": g.get("firstSeenAt") or "",
            "valuePricingStatus": g.get("valuePricingStatus") or "",
            "discountIds": list(g.get("discountIds") or []),
            "total": c["total"], "rented": c["rented"], "vacant": c["vacant"], "unavailable": c["unavailable"],
            "occupancy": round(c["rented"] / c["total"], 4) if c["total"] else None,
            "averageRent": round(c["rentSum"] / c["rented"]) if c["rented"] else None,
            "ins7": m.get("ins7", 0), "outs7": m.get("outs7", 0), "net7": m.get("ins7", 0) - m.get("outs7", 0),
            "ins30": m.get("ins30", 0), "outs30": m.get("outs30", 0), "net30": m.get("ins30", 0) - m.get("outs30", 0),
        })
    out.sort(key=lambda r: (r["parking"], r["width"] * r["depth"] or 1e9, r["name"]))
    return out


def attach_market(rows: list[dict], observations: list[dict], competitors: dict[str, str], today: date) -> list[dict]:
    """Add the market (ops_market.compare, the one rule) to each group row:
    median, low, high, competitor count, suggested rate (10% step) and the
    uncapped market target behind Cubby's Large Increase / Decrease chips."""
    types = [{"name": r["name"], "width": r["width"], "depth": r["depth"], "parking": r["parking"],
              "total": r["total"], "rented": r["rented"], "vacant": r["vacant"], "street": r["standard"] or 0,
              "rentSum": (r["averageRent"] or 0) * r["rented"]} for r in rows]
    market = {m["name"]: m for m in ops_market.compare(types, observations, competitors, today)}
    for r in rows:
        m = market.get(r["name"]) or {}
        med = m.get("marketMedian")
        r["competitors"] = m.get("competitors", 0)
        r["marketMedian"], r["marketLow"], r["marketHigh"] = med, m.get("marketLow"), m.get("marketHigh")
        r["suggested"], r["why"] = m.get("suggested"), m.get("why") or ""
        r["vsMarket"] = round(r["standard"] / med - 1, 4) if med and r["standard"] else None
        enough = med and r["competitors"] >= ops_market.MIN_COMPETITORS and r["standard"]
        r["target"] = market_target(med, r["rented"], r["vacant"]) if enough else None
        r["targetGap"] = round(r["target"] / r["standard"] - 1, 4) if r["target"] else None
        r["flags"] = [f for f, on in (
            ("move-in-spike", r["net7"] > SPIKE_NET), ("move-out-spike", -r["net7"] > SPIKE_NET),
            ("large-increase", r["targetGap"] is not None and r["targetGap"] > LARGE_GAP),
            ("large-decrease", r["targetGap"] is not None and r["targetGap"] < -LARGE_GAP),
            ("low-occupancy", r["occupancy"] is not None and r["occupancy"] < LOW_OCC),
            ("no-move-ins", r["total"] > 0 and r["vacant"] > 0 and r["ins30"] == 0)) if on]
    return rows


# ── Overview ─────────────────────────────────────────────────────────────────

def overview_row(fac: dict, raw: dict, rows: list[dict], today: date) -> dict:
    """Cubby's Pricing > Overview line for one facility."""
    today_s, month = today.isoformat(), today.isoformat()[:7]
    d60, d30 = (today - timedelta(days=60)).isoformat(), (today - timedelta(days=30)).isoformat()
    ins_month = ins60 = outs60 = 0
    for le in raw.get("leases", []):
        mi, mo = str(le.get("moveInDate") or "")[:10], str(le.get("moveOutDate") or "")[:10]
        if mi and mi <= today_s:
            ins_month += mi[:7] == month
            ins60 += mi > d60
        if mo and d60 < mo <= today_s:
            outs60 += 1
    rented = [r for r in raw.get("rent_roll", []) if r.get("status") == "RENTED"]
    priced = [r for r in rows if r["total"] > 0]
    ins30_by = {r["groupId"]: r["ins30"] for r in rows}
    units = fac.get("units") or {}
    return {
        "facilityId": fac["id"], "facility": fac.get("shortName") or fac.get("name") or "",
        "units": units.get("total", 0), "rented": units.get("rented", 0),
        "pricingGroups": len(priced),
        "tenants": len({r.get("customerId") for r in rented if r.get("customerId")}),
        "area": (fac.get("area") or {}).get("total", 0),
        "monthlyRent": (fac.get("rent") or {}).get("rentRoll", 0),
        "occupancy": round(units.get("rented", 0) / units["total"], 4) if units.get("total") else None,
        "moveInsMonth": ins_month, "moveIns60": ins60, "moveOuts60": outs60,
        "lowOccGroups": sum(1 for r in priced if r["kind"] == uc.STORAGE and (r["occupancy"] or 0) < LOW_OCC),
        "zeroMoveInGroups": sum(1 for r in priced if r["kind"] == uc.STORAGE and not ins30_by.get(r["groupId"])),
        "since30": d30,
    }


def overview_totals(rows: list[dict]) -> dict:
    keys = ("units", "rented", "pricingGroups", "tenants", "area", "monthlyRent", "moveInsMonth", "moveIns60",
            "moveOuts60", "lowOccGroups", "zeroMoveInGroups")
    t = {k: sum(r.get(k) or 0 for r in rows) for k in keys}
    t["occupancy"] = round(t["rented"] / t["units"], 4) if t["units"] else None
    t["facility"] = "Total"
    return t


# ── Competitive pricing and trends ───────────────────────────────────────────

def latest_by_column(observations: list[dict], today: date, our_columns: set[str]) -> dict[str, dict[str, dict]]:
    """{column: {competitor_id: newest fresh observation}}. A competitor rate
    that does not say climate or not goes to our only variant of that size
    when we have exactly one, else to its own column."""
    cutoff = (today - timedelta(days=ops_market.FRESH_DAYS)).isoformat()
    variants: dict[str, list[str]] = defaultdict(list)
    for c in our_columns:
        variants[c.rsplit(":", 1)[0]].append(c)
    out: dict[str, dict[str, dict]] = {}
    for o in observations:
        day = o.get("observed_on") or ""
        if day < cutoff or day > today.isoformat() or not o.get("rate_cents"):
            continue
        col = column_key(o.get("width"), o.get("depth"), bool(o.get("parking")), o.get("climate"))
        if col.endswith(":any"):
            mine = variants.get(col.rsplit(":", 1)[0], [])
            if len(mine) == 1:
                col = mine[0]
        held = out.setdefault(col, {}).get(o["competitor_id"])
        if held is None or (day, o.get("created_at") or "", -o["rate_cents"]) > (held["observed_on"], held.get("created_at") or "", -held["rate_cents"]):
            out[col][o["competitor_id"]] = o
    return out


def _col_label(col: str) -> str:
    kind, size, c = col.split(":")
    w, d = size.split("x")
    return size_label(w, d, kind == "P", True if c == "cc" else False if c == "ncc" else None)


def _col_order(col: str):
    kind, size, c = col.split(":")
    w, d = (float(x) for x in size.split("x"))
    return (kind == "P", w * d, w, {"cc": 0, "ncc": 1, "any": 2, "": 3}.get(c, 4))


def competitive(ours: list[dict], observations: list[dict], competitors: dict[str, dict], today: date) -> dict:
    """Cubby's Market Insights grid. `ours` = [{facilityId, facility, address,
    rows (group rows), main}] - the facility first, then our nearby ones;
    `competitors` = {id: {name, address, distanceMiles}}."""
    our_cols = {r["column"] for f in ours for r in f["rows"] if r["standard"] and r["kind"] != uc.MAILBOX and r["column"]}
    latest = latest_by_column([o for o in observations if o["competitor_id"] in competitors], today, our_cols)
    cols = sorted(our_cols | set(latest), key=_col_order)
    comp_median = {c: (median([o["rate_cents"] for o in latest.get(c, {}).values()]) if latest.get(c) else None) for c in cols}
    rows = []
    for f in ours:
        cells = {}
        for r in f["rows"]:
            if not r["standard"] or r["kind"] == uc.MAILBOX or not r["column"]:
                continue
            held = cells.get(r["column"])
            if held is None or r["standard"] < held["rate"]:
                med = comp_median.get(r["column"])
                cells[r["column"]] = {"rate": r["standard"], "groups": 1 + (held or {}).get("groups", 0),
                                      "vsMarket": round(r["standard"] / med - 1, 4) if med else None}
            else:
                held["groups"] += 1
        rows.append({"kind": "ours", "facilityId": f["facilityId"], "name": f["facility"], "address": f.get("address", ""),
                     "main": bool(f.get("main")), "cells": cells})
    comp_rows = []
    for cid, c in competitors.items():
        cells = {col: {"rate": o["rate_cents"], "observedOn": o["observed_on"], "source": o.get("source") or "manual"}
                 for col, by in latest.items() for k, o in by.items() if k == cid}
        if cells:
            comp_rows.append({"kind": "competitor", "id": cid, "name": c.get("name", ""), "address": c.get("address", ""),
                              "distanceMiles": c.get("distanceMiles") or 0, "cells": cells})
    comp_rows.sort(key=lambda r: (r["distanceMiles"] or 999, r["name"]))
    return {
        "columns": [{"key": c, "label": _col_label(c), "competitors": len(latest.get(c, {})),
                     "median": int(round(comp_median[c])) if comp_median.get(c) is not None else None} for c in cols],
        "rows": rows + comp_rows,
        "hasMarket": bool(latest),
    }


def trends(ours: list[dict], history: dict[tuple, list[dict]], observations: list[dict],
           competitors: dict, columns: list[dict], today: date, now_iso: str) -> dict:
    """Cubby's Trends grid: per column, My Locations average and Competitors
    average now, and each one's change vs 1 / 7 / 30 days ago. Ours from
    cubby_rate_history (rate_at), theirs from the competitor rate history."""
    comp_obs = [o for o in observations if o["competitor_id"] in competitors]
    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    out = {"columns": [c["key"] for c in columns], "my": {}, "competitors": {}, "myChange": {}, "competitorChange": {}}
    our_cols = {r["column"] for f in ours for r in f["rows"] if r["standard"] and r["column"]}
    snaps = {0: latest_by_column(comp_obs, today, our_cols)}
    for days in (1, 7, 30):
        snaps[days] = latest_by_column(comp_obs, today - timedelta(days=days), our_cols)
    for c in columns:
        key = c["key"]
        mine_rows = [r for f in ours for r in f["rows"] if r["column"] == key and r["standard"] and r["kind"] != uc.MAILBOX]
        my_now = _avg(r["standard"] for r in mine_rows)
        comp_now = _avg(o["rate_cents"] for o in snaps[0].get(key, {}).values())
        out["my"][key] = round(my_now) if my_now else None
        out["competitors"][key] = round(comp_now) if comp_now else None
        for days in (1, 7, 30):
            when = (now - timedelta(days=days)).isoformat()
            # Only groups Nexus was already tracking then, compared like for like.
            known = [r for r in mine_rows if (r.get("trackedSince") or "") <= when]
            now_known = _avg(r["standard"] for r in known)
            then_mine = _avg(rate_at(r["standard"], history.get((r["groupId"], "standardRate"), []), when) for r in known)
            then_comp = _avg(o["rate_cents"] for o in snaps[days].get(key, {}).values())
            out["myChange"].setdefault(str(days), {})[key] = (
                round(now_known / then_mine - 1, 4) if now_known and then_mine else None)
            out["competitorChange"].setdefault(str(days), {})[key] = (
                round(comp_now / then_comp - 1, 4) if comp_now and then_comp else None)
    return out


def competitor_moves(observations: list[dict], competitors: dict, today: date,
                     days: int = MOVE_DAYS, threshold: float = MOVE_PCT) -> list[dict]:
    """A competitor that changed a size by `threshold` or more within `days`
    (the same reading as ops_market_engine.rate_moves, on plain rows)."""
    series: dict[tuple, list] = defaultdict(list)
    for o in observations:
        if o["competitor_id"] in competitors and o.get("rate_cents") and (o.get("observed_on") or "") <= today.isoformat():
            series[(o["competitor_id"], column_key(o.get("width"), o.get("depth"), bool(o.get("parking")), o.get("climate")))].append(o)
    since = (today - timedelta(days=days)).isoformat()
    out = []
    for (cid, col), rows in series.items():
        rows.sort(key=lambda o: (o["observed_on"], o.get("created_at") or ""), reverse=True)
        newest = first = rows[0]
        before = None
        for o in rows[1:]:
            if o["rate_cents"] != newest["rate_cents"]:
                before = o
                break
            first = o
        if before is None or first["observed_on"] < since:
            continue
        change = (newest["rate_cents"] - before["rate_cents"]) / before["rate_cents"]
        if abs(change) + 1e-9 < threshold:
            continue
        out.append({"competitorId": cid, "competitor": competitors[cid].get("name", ""), "column": col,
                    "label": _col_label(col), "oldRate": before["rate_cents"], "newRate": newest["rate_cents"],
                    "change": round(change, 4), "date": first["observed_on"],
                    "withinDay": first["observed_on"] >= (today - timedelta(days=1)).isoformat()})
    out.sort(key=lambda m: (-abs(m["change"]), m["competitor"]))
    return out


# ── ECRI ─────────────────────────────────────────────────────────────────────

def ecri(raw: dict, tracked: list[dict], nexus_entered: list[dict], today: date) -> dict:
    """Candidates (paying under street, 12+ months since move-in or the last
    increase, nothing scheduled), increases Cubby has scheduled, and monthly
    survival: of the increases that took effect, how many tenants moved out
    within 60 days. Tenant name, unit and money only."""
    today_s = today.isoformat()
    tenants = ops_revenue.tenant_rows(raw)
    cands, scheduled = [], []
    for t in tenants:
        since = t["monthsSinceIncrease"] if t["monthsSinceIncrease"] is not None else t["monthsStayed"]
        if t["scheduled"] and t["scheduled"]["date"] >= today_s:
            scheduled.append({"unit": t["unit"], "tenant": t["tenant"], "unitType": t["unitType"], "rent": t["rent"],
                              "newRent": t["scheduled"]["amount"], "change": t["scheduled"]["amount"] - t["rent"],
                              "changePct": round(t["scheduled"]["amount"] / t["rent"] - 1, 4) if t["rent"] else None,
                              "effective": t["scheduled"]["date"], "monthsStayed": t["monthsStayed"],
                              "early": t["monthsStayed"] is not None and t["monthsStayed"] < ECRI_MONTHS, "url": t["url"]})
            continue
        if t["rent"] > 0 and t["gap"] > 0 and since is not None and since >= ECRI_MONTHS and not t["scheduled"]:
            cands.append({"unit": t["unit"], "tenant": t["tenant"], "unitType": t["unitType"], "rent": t["rent"],
                          "street": t["street"], "gap": t["gap"], "gapPct": t["gapPct"], "monthsStayed": t["monthsStayed"],
                          "monthsSinceIncrease": t["monthsSinceIncrease"], "lastIncrease": t["lastIncrease"],
                          "balance": t["balance"], "url": t["url"]})
    cands.sort(key=lambda r: -r["gap"])
    scheduled.sort(key=lambda r: r["effective"])

    # Survival. Tracked Cubby changes plus rent changes staff marked entered in Nexus, once per lease and date.
    move_out = {str(le.get("leaseId") or ""): str(le.get("moveOutDate") or "")[:10] for le in raw.get("leases", [])}
    seen, months = set(), defaultdict(lambda: {"increases": 0, "pctSum": 0.0, "moveOuts": 0, "gained": 0, "open": 0})
    for c in list(tracked) + list(nexus_entered):
        lid, eff = c.get("leaseId") or "", c.get("effective") or ""
        old, new = int(c.get("old") or 0), int(c.get("new") or 0)
        if not lid or not eff or eff > today_s or old <= 0 or new <= old or (lid, eff) in seen:
            continue
        seen.add((lid, eff))
        m = months[eff[:7]]
        m["increases"] += 1
        m["pctSum"] += new / old - 1
        mo = move_out.get(lid, "")
        end = (_d(eff) + timedelta(days=SURVIVAL_DAYS)).isoformat()
        if mo and eff <= mo <= end:
            m["moveOuts"] += 1
        else:
            m["gained"] += new - old
        if end > today_s:
            m["open"] += 1
    survival = [{"month": k, "increases": v["increases"], "averageIncrease": round(v["pctSum"] / v["increases"], 4),
                 "moveOuts": v["moveOuts"], "survival": round(1 - v["moveOuts"] / v["increases"], 4),
                 "revenueGained": v["gained"], "windowOpen": v["open"] > 0}
                for k, v in sorted(months.items(), reverse=True)]
    return {"candidates": cands, "candidateCount": len(cands), "upside": sum(r["gap"] for r in cands),
            "scheduled": scheduled, "scheduledLift": sum(r["change"] for r in scheduled),
            "early": sum(1 for r in scheduled if r["early"]), "survival": survival}


# ── Revenue at risk ──────────────────────────────────────────────────────────

def revenue_risk(fac: dict, rows: list[dict]) -> dict:
    vac = sorted(({"groupId": r["groupId"], "name": r["name"], "label": r["label"], "vacant": r["vacant"],
                   "standard": r["standard"], "loss": r["vacant"] * (r["standard"] or 0)}
                  for r in rows if r["kind"] == uc.STORAGE and r["vacant"] and r["standard"]), key=lambda v: -v["loss"])
    pd = fac.get("pastDue") or {}
    owed = sorted((r for r in pd.get("rows", []) if (r.get("amount") or 0) > 0), key=lambda r: -(r.get("amount") or 0))
    total = pd.get("total") or 0
    top5 = sum(r.get("amount") or 0 for r in owed[:5])
    return {
        "vacancy": vac[:12], "vacancyLoss": sum(v["loss"] for v in vac),
        "pastDue": {"total": total, "tenants": pd.get("tenants") or 0, "rentRoll": (fac.get("rent") or {}).get("rentRoll", 0),
                    "top": [{"tenant": r.get("tenant") or "", "unit": r.get("unit") or "", "amount": r.get("amount") or 0,
                             "oldest": r.get("oldest") or "", "url": r.get("url") or ""} for r in owed[:5]],
                    "top5Share": round(top5 / total, 4) if total else None},
    }


# ── Insight rules (each returns a list) ──────────────────────────────────────

def _link(section: str, facility_id: str, **filters) -> dict:
    return {"tab": "pricing", "section": section, "facilityId": facility_id, "filters": filters}


def market_insights(fac: dict, rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        med, std, occ = r.get("marketMedian"), r["standard"], r["occupancy"]
        if r["kind"] != uc.STORAGE or not med or not std or occ is None or r["competitors"] < ops_market.MIN_COMPETITORS:
            continue
        gap = std / med - 1
        o = round(occ * 100)
        nums = f"({usd(std)} vs {usd(med)}, {r['competitors']} competitors)"
        where = f"{r['label']} ({r['name']}) at {fac['shortName']}"
        metrics = {"standard": std, "marketMedian": med, "gap": round(gap, 4), "occupancy": occ, "vacant": r["vacant"]}
        link = _link("standard", fac["id"], group=r["groupId"])
        if gap <= -MARKET_GAP and occ >= FULL:
            out.append(insight(fac, "market-position", r["groupId"], "high", f"{r['label']} Below Market at {o}% Full",
                               f"{where} is {pct_text(gap)} below the market median {nums} while {o}% full: room to raise.",
                               metrics, "Review the street rate in Rate Management.", link, impact=(med - std) * max(r["total"], 1)))
        elif gap >= MARKET_GAP and occ < VACANT_OCC:
            out.append(insight(fac, "market-position", r["groupId"], "high", f"{r['label']} Above Market With Vacancy",
                               f"{where} is {pct_text(gap)} above the market median {nums} with {r['vacant']} vacant ({o}% full).",
                               metrics, "Consider moving toward the market to fill the vacant units.", link,
                               impact=(std - med) * max(r["vacant"], 1)))
        elif gap >= MARKET_GAP and occ >= FULL:
            out.append(insight(fac, "market-position", r["groupId"], "low", f"{r['label']} Above Market and {o}% Full: Hold",
                               f"{where} is {pct_text(gap)} above the market median {nums} and still {o}% full: hold.",
                               metrics, "Hold the rate; demand supports it.", link, impact=0))
        elif gap <= -MARKET_GAP:
            out.append(insight(fac, "market-position", r["groupId"], "medium", f"{r['label']} Below Market",
                               f"{where} is {pct_text(gap)} below the market median {nums} at {o}% occupancy.",
                               metrics, "Check whether a smaller increase still fills the vacant units.", link,
                               impact=(med - std) * max(r["vacant"], 1)))
    return out


def chip_insights(fac: dict, rows: list[dict]) -> list[dict]:
    """Cubby's Standard Rates chips, per pricing group."""
    out = []
    for r in rows:
        if r["kind"] != uc.STORAGE or not r["total"] or not r["column"]:     # no size = not a real unit type
            continue
        o = round((r["occupancy"] or 0) * 100)
        where = f"{r['name']} at {fac['shortName']}"
        base = {"net7": r["net7"], "ins7": r["ins7"], "outs7": r["outs7"], "vacant": r["vacant"], "occupancy": r["occupancy"]}
        if "move-in-spike" in r["flags"]:
            out.append(insight(fac, "move-in-spike", r["groupId"], "medium", f"Move-In Spike: {r['label']}",
                               f"{where} had {r['net7']} net move-ins in the last 7 days ({r['ins7']} in, {r['outs7']} out); "
                               f"{r['vacant']} vacant left at {o}% occupancy.", base,
                               "Demand is up: test a higher street rate.", _link("standard", fac["id"], insight="move-in-spike"),
                               impact=r["net7"]))
        if "move-out-spike" in r["flags"]:
            out.append(insight(fac, "move-out-spike", r["groupId"], "high", f"Move-Out Spike: {r['label']}",
                               f"{where} had {-r['net7']} net move-outs in the last 7 days ({r['ins7']} in, {r['outs7']} out); "
                               f"now {o}% full.", base, "Check recent rent increases and competitor prices for this size.",
                               _link("standard", fac["id"], insight="move-out-spike"), impact=-r["net7"]))
        if "low-occupancy" in r["flags"] and r["total"] >= 2:
            out.append(insight(fac, "low-occupancy", r["groupId"], "medium", f"{r['label']} Only {o}% Full",
                               f"{where} is {o}% full ({r['rented']} of {r['total']} units, {r['vacant']} vacant) at "
                               f"{usd(r['standard'] or 0)}.", base, "Review the rate, discounts and marketing for this size.",
                               _link("standard", fac["id"], insight="low-occupancy"),
                               impact=r["vacant"] * (r["standard"] or 0)))
        if "no-move-ins" in r["flags"]:
            out.append(insight(fac, "no-move-ins", r["groupId"], "medium" if r["vacant"] >= 5 else "low",
                               f"No Move-Ins in 30 Days: {r['label']}",
                               f"{where} has had no move-ins in 30 days with {r['vacant']} vacant at {usd(r['standard'] or 0)}.",
                               base, "Check the rate against the market and the web listing.",
                               _link("standard", fac["id"], insight="no-move-ins"), impact=r["vacant"] * (r["standard"] or 0)))
        for flag, word in (("large-increase", "Increase"), ("large-decrease", "Decrease")):
            if flag in r["flags"]:
                out.append(insight(fac, flag, r["groupId"], "medium", f"Large {word} Indicated: {r['label']}",
                                   f"The market points {r['name']} at {fac['shortName']} to {usd(r['target'])}, "
                                   f"{pct_text(r['targetGap'])} {'above' if r['targetGap'] > 0 else 'below'} today's {usd(r['standard'])} "
                                   f"(market median {usd(r['marketMedian'])}, {o}% full).",
                                   {"standard": r["standard"], "target": r["target"], "targetGap": r["targetGap"],
                                    "marketMedian": r["marketMedian"], "suggested": r["suggested"]},
                                   "Step toward it: the suggested rate moves at most 10% at a time.",
                                   _link("standard", fac["id"], insight=flag), impact=abs(r["target"] - r["standard"]) * max(r["vacant"], 1)))
    return out


def move_insights(fac: dict, moves: list[dict]) -> list[dict]:
    out = []
    for m in moves:
        cut = m["change"] < 0
        sev = "high" if cut and -m["change"] >= MOVE_ALERT else "medium"
        when = "in the last day" if m["withinDay"] else "in the last 7 days"
        out.append(insight(fac, "competitor-move", f"{m['competitorId']}:{m['column']}", sev,
                           f"{m['competitor']} {'Cut' if cut else 'Raised'} {m['label']} {pct_text(m['change'])}",
                           f"{m['competitor']} moved {m['label']} from {usd(m['oldRate'])} to {usd(m['newRate'])} "
                           f"({'-' if cut else '+'}{pct_text(m['change'], 1)}) on {ops_revenue.us_date(m['date'])}, {when}.",
                           {"oldRate": m["oldRate"], "newRate": m["newRate"], "change": m["change"], "date": m["date"]},
                           "Compare it with our rate for this size." if cut else "Room to follow if we are full.",
                           _link("competitive", fac["id"], column=m["column"]), impact=abs(m["newRate"] - m["oldRate"])))
    return out


def ecri_insights(fac: dict, e: dict, today: date) -> list[dict]:
    out = []
    if e["candidateCount"]:
        out.append(insight(fac, "ecri", "candidates", "high" if e["upside"] >= ECRI_HIGH_UPSIDE else "medium",
                           f"{plural(e['candidateCount'], 'Tenant')} Below Street for 12+ Months",
                           f"{plural(e['candidateCount'], 'tenant')} at {fac['shortName']} "
                           f"{'has' if e['candidateCount'] == 1 else 'have'} paid under the street rate for 12+ months "
                           f"with no increase; bringing {'it' if e['candidateCount'] == 1 else 'them'} to street adds "
                           f"{usd(e['upside'])} a month.",
                           {"tenants": e["candidateCount"], "upside": e["upside"]},
                           "Build a rent change in Revenue Management.", {"tab": "revenue", "facilityId": fac["id"]},
                           impact=e["upside"]))
    if e["scheduled"]:
        last = max(r["effective"] for r in e["scheduled"])
        n = len(e["scheduled"])
        out.append(insight(fac, "ecri", "scheduled", "low", f"{plural(n, 'Rent Increase')} Scheduled",
                           f"{plural(n, 'increase')} at {fac['shortName']} {'takes' if n == 1 else 'take'} effect by "
                           f"{ops_revenue.us_date(last)}, "
                           f"adding {usd(e['scheduledLift'])} a month.",
                           {"count": len(e["scheduled"]), "lift": e["scheduledLift"]}, "Watch move-outs after they land.",
                           _link("ecri", fac["id"]), impact=e["scheduledLift"]))
    if e["early"]:
        out.append(insight(fac, "ecri", "early", "medium", f"{plural(e['early'], 'Increase')} in a Tenant's First 12 Months",
                           f"{plural(e['early'], 'scheduled increase')} at {fac['shortName']} "
                           f"{'lands' if e['early'] == 1 else 'land'} before the tenant's 12th month.",
                           {"count": e["early"]}, "Check them against the first-year increase limit.", _link("ecri", fac["id"])))
    for s in e["survival"]:
        if s["windowOpen"] or s["increases"] < SURVIVAL_MIN or 1 - s["survival"] < SURVIVAL_ALERT:
            continue
        ym = s["month"]
        out.append(insight(fac, "ecri", f"survival:{ym}", "medium", f"High Move-Outs After {ym[5:7]}/{ym[:4]} Increases",
                           f"{s['moveOuts']} of {s['increases']} tenants at {fac['shortName']} moved out within {SURVIVAL_DAYS} days "
                           f"of an increase in {ym[5:7]}/{ym[:4]} (average +{pct_text(s['averageIncrease'], 1)}).",
                           {"increases": s["increases"], "moveOuts": s["moveOuts"], "survival": s["survival"]},
                           "Consider smaller increases for this group of tenants.", _link("ecri", fac["id"])))
    return out


def risk_insights(fac: dict, risk: dict) -> list[dict]:
    out = []
    loss, roll = risk["vacancyLoss"], (fac.get("rent") or {}).get("rentRoll", 0)
    if loss and risk["vacancy"]:
        top = risk["vacancy"][0]
        share = loss / (roll + loss) if roll + loss else 0
        out.append(insight(fac, "revenue-risk", "vacancy", "medium" if share >= 0.15 else "low",
                           f"Vacancy Costs {usd(loss)} a Month",
                           f"Vacant units at {fac['shortName']} are {usd(loss)} a month at the street rate; the largest is "
                           f"{top['name']} ({top['vacant']} vacant, {usd(top['loss'])}).",
                           {"vacancyLoss": loss, "share": round(share, 4)}, "Start with the unit types losing the most.",
                           _link("risk", fac["id"]), impact=loss))
    pd = risk["pastDue"]
    if pd["total"] and roll:
        ratio = pd["total"] / roll
        if ratio >= PAST_DUE_MED:
            conc = f"; the top 5 tenants owe {pct_text(pd['top5Share'])} of it" if pd["top5Share"] is not None and pd["tenants"] > 5 else ""
            out.append(insight(fac, "revenue-risk", "past-due", "high" if ratio >= PAST_DUE_HIGH else "medium",
                               f"Past Due Is {pct_text(ratio)} of Rent",
                               f"{plural(pd['tenants'], 'tenant')} at {fac['shortName']} {'owes' if pd['tenants'] == 1 else 'owe'} "
                               f"{usd(pd['total'])}, {pct_text(ratio)} of the "
                               f"{usd(roll)} monthly rent roll{conc}.",
                               {"pastDue": pd["total"], "ratio": round(ratio, 4), "top5Share": pd["top5Share"]},
                               "Work the Collections list.", {"tab": "collections", "facilityId": fac["id"]}, impact=pd["total"]))
    return out


def discount_insights(fac: dict, rows: list[dict], discounts: dict[str, dict]) -> list[dict]:
    """ONE insight per facility: unit types over 90% full that still carry a
    move-in special (Cubby's PERIODIC discounts - a price cut for the first
    months). Affinity discounts (Senior, Teacher, Referral - ONE_TIME and
    PERPETUAL) are a policy, not a price signal, so they do not count."""
    hits = []
    for r in rows:
        if r["kind"] != uc.STORAGE or r["occupancy"] is None or r["occupancy"] <= DISCOUNT_FULL or r["total"] < 2:
            continue
        live = [discounts[d] for d in r["discountIds"]
                if d in discounts and discounts[d].get("live") and discounts[d].get("type") == "PERIODIC"]
        if live:
            hits.append((r, live))
    if not hits:
        return []
    hits.sort(key=lambda h: -h[0]["occupancy"])
    names = "; ".join(f"{r['name']} ({round(r['occupancy'] * 100)}%, {', '.join(d['name'] for d in live[:2])})"
                      for r, live in hits[:3]) + (f"; and {len(hits) - 3} more" if len(hits) > 3 else "")
    return [insight(fac, "discounts", "full-specials", "medium", f"Move-In Specials on {plural(len(hits), 'Full Unit Type')}",
                    f"{plural(len(hits), 'unit type')} at {fac['shortName']} {'is' if len(hits) == 1 else 'are'} over "
                    f"{round(DISCOUNT_FULL * 100)}% full and still {'offers' if len(hits) == 1 else 'offer'} a move-in special: {names}.",
                    {"groups": len(hits)}, "Consider pulling move-in specials on these sizes in Cubby.",
                    _link("discounts", fac["id"]), impact=len(hits))]


def discount_view(d: dict) -> dict:
    """A cubby_discounts row as the screen shows it, with `live` = offered now."""
    method = d.get("applicationMethod") or ""
    if "PERCENT" in method and d.get("percentage") is not None:
        band = f"{d['percentage']:g}% off"
    elif d.get("amount") is not None:
        band = f"{usd(d['amount'])} off"
    else:
        band = ""
    return {**d, "band": band, "live": d.get("active") is not False and (d.get("status") or "PUBLISHED") == "PUBLISHED"}


# ── One facility ─────────────────────────────────────────────────────────────

def facility_bundle(fac: dict, raw: dict, groups: list[dict], history: dict[tuple, list[dict]],
                    observations: list[dict], competitors: dict[str, dict], discounts: dict[str, dict],
                    tracked: list[dict], nexus_entered: list[dict], nearby: list[dict],
                    today: date, now_iso: str, rules: dict | None = None, market_on: bool = True,
                    rows: list[dict] | None = None) -> dict:
    """Everything the screen shows for one facility, plus its insights.
    `nearby` = [{"fac", "rows"}] our other facilities close by (their group rows);
    `rows` = this facility's group rows when the caller already built them."""
    if rows is None:
        rows = attach_market(group_stats(groups, raw, today, rules), observations,
                             {k: v.get("name", "") for k, v in competitors.items()}, today)
    for r in rows:
        r["discounts"] = [{"name": discounts[d]["name"], "band": discounts[d]["band"], "visibility": v}
                          for d in r["discountIds"] if d in discounts and discounts[d].get("live")
                          for v in [next((p.get("visibility") for p in discounts[d].get("pricingGroups") or []
                                          if p.get("pricingGroupId") == r["groupId"]), "")]]
    ours = [{"facilityId": fac["id"], "facility": fac["shortName"], "address": fac.get("address", ""), "rows": rows, "main": True}]
    ours += [{"facilityId": n["fac"]["id"], "facility": n["fac"]["shortName"], "address": n["fac"].get("address", ""),
              "rows": n["rows"], "main": False, "miles": n.get("miles")} for n in nearby]
    comp = competitive(ours, observations, competitors, today)
    trend = trends(ours, history, observations, competitors, comp["columns"], today, now_iso)
    moves = competitor_moves(observations, competitors, today)
    e = ecri(raw, tracked, nexus_entered, today)
    risk = revenue_risk(fac, rows)
    items = chip_insights(fac, rows) + ecri_insights(fac, e, today) + risk_insights(fac, risk) + discount_insights(fac, rows, discounts)
    if market_on:
        items += market_insights(fac, rows) + move_insights(fac, moves)
    return {
        "facilityId": fac["id"], "facility": fac["shortName"], "name": fac.get("name", ""), "asOf": today.isoformat(),
        "overview": overview_row(fac, raw, rows, today),
        "standardRates": rows, "competitive": comp, "trends": trend, "moves": moves,
        "ecri": {**e, "candidates": e["candidates"][:100]}, "risk": risk,
        "insights": rank(items),
    }


# ── Loading (blocking: database) ─────────────────────────────────────────────

def _group_dict(g) -> dict:
    return {"pricingGroupId": g.pricing_group_id, "name": g.name or "", "width": g.width or 0, "depth": g.depth or 0,
            "area": g.area or 0, "parking": bool(g.parking or g.vehicle_storage), "climate": g.climate,
            "standard": g.standard_cents, "web": g.web_cents, "walkIn": g.walk_in_cents, "strike": g.strike_cents,
            "valuePricingStatus": g.value_pricing_status or "", "discountIds": list(g.discount_ids or []),
            "lastChangedAt": g.last_changed_at or "", "firstSeenAt": g.first_seen_at or ""}


def _miles(a: dict, b: dict):
    if None in (a.get("lat"), a.get("lng"), b.get("lat"), b.get("lng")):
        return None
    import ops_market_engine
    return ops_market_engine.miles_between(a["lat"], a["lng"], b["lat"], b["lng"])


def compute() -> dict:
    """Every Cubby facility's bundle and the merged, ranked insight list.
    Blocking (reads the database through cubby.summary and the pricing tables)."""
    import cubby
    import models as m
    from database import SessionLocal
    summary = cubby.summary()
    raws = {f["facilityId"]: raw for f, raw in cubby._rows()}
    facs = [f for f in summary.get("facilities", []) if f["id"] in raws]
    rules = cubby._rules()
    now_iso = datetime.now(timezone.utc).isoformat()
    db = SessionLocal()
    try:
        groups: dict[str, list] = defaultdict(list)
        pricing_synced = ""
        for g in db.query(m.CubbyPricingGroup).filter(m.CubbyPricingGroup.active.is_(True)).all():
            groups[g.facility_id].append(_group_dict(g))
            pricing_synced = max(pricing_synced, g.synced_at or "")
        since = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        history: dict[tuple, list] = defaultdict(list)
        for h in (db.query(m.CubbyRateHistory).filter(m.CubbyRateHistory.changed_at >= since)
                  .order_by(m.CubbyRateHistory.changed_at).all()):
            history[(h.pricing_group_id, h.field)].append({"old": h.old_value, "new": h.new_value, "changedAt": h.changed_at})
        discounts = {d.discount_id: discount_view({
            "id": d.discount_id, "name": d.name or "", "type": d.type or "", "status": d.status or "", "active": d.active,
            "applicationMethod": d.application_method or "", "amount": d.amount_cents, "percentage": d.percentage,
            "pricingGroups": d.pricing_groups or [], "facilityIds": d.facility_ids or []}) for d in db.query(m.CubbyDiscount).all()}
        comps: dict[str, dict] = defaultdict(dict)
        for c in db.query(m.OpsCompetitor).filter(m.OpsCompetitor.active == True).all():  # noqa: E712
            comps[c.facility_id][c.id] = {"name": c.name or "", "address": c.address or "", "distanceMiles": c.distance_miles or 0}
        cutoff = (date.today() - timedelta(days=ops_market.FRESH_DAYS + 35)).isoformat()
        obs: dict[str, list] = defaultdict(list)
        for r in db.query(m.OpsCompetitorRate).filter(m.OpsCompetitorRate.observed_on >= cutoff).all():
            obs[r.facility_id].append({"competitor_id": r.competitor_id, "width": r.width, "depth": r.depth,
                                       "parking": bool(r.parking), "rate_cents": r.rate_cents, "observed_on": r.observed_on,
                                       "created_at": r.created_at, "climate": r.climate, "source": r.source or "manual"})
        tracked: dict[str, list] = defaultdict(list)
        for r in db.query(m.CubbyRentChange).filter(m.CubbyRentChange.status != "canceled").all():
            tracked[r.facility_id].append({"leaseId": r.lease_id, "effective": r.effective_date, "old": r.old_cents, "new": r.new_cents})
        entered: dict[str, list] = defaultdict(list)
        batches = {b.id: b.effective_date for b in db.query(m.OpsRevenueBatch).all()}
        for c in db.query(m.OpsRevenueChange).filter(m.OpsRevenueChange.status.in_(ops_revenue.IN_CUBBY)).all():
            entered[c.facility_id].append({"leaseId": c.lease_id, "effective": c.cubby_change_date or batches.get(c.batch_id, ""),
                                           "old": c.current_cents, "new": c.new_cents})
        try:
            import ops_stortrack
            stortrack = ops_stortrack.status(db)
        except Exception:  # noqa: BLE001 - a status line must not sink the screen
            stortrack = {"connected": False}
    finally:
        db.close()

    market_on = any(obs.get(f["id"]) for f in facs)
    base_rows = {}
    for f in facs:
        today = _d(f["asOf"]) or date.today()
        base_rows[f["id"]] = attach_market(group_stats(groups.get(f["id"], []), raws[f["id"]], today, rules),
                                           obs.get(f["id"], []), {k: v["name"] for k, v in comps.get(f["id"], {}).items()}, today)
    bundles = {}
    for f in facs:
        today = _d(f["asOf"]) or date.today()
        near = []
        for o in facs:
            if o["id"] == f["id"]:
                continue
            miles = _miles(f, o)
            if miles is not None and miles <= NEARBY_MILES:
                near.append({"fac": o, "rows": base_rows[o["id"]], "miles": round(miles, 1)})
        near.sort(key=lambda n: n["miles"])
        bundles[f["id"]] = facility_bundle(f, raws[f["id"]], groups.get(f["id"], []), history, obs.get(f["id"], []),
                                           comps.get(f["id"], {}), discounts, tracked.get(f["id"], []), entered.get(f["id"], []),
                                           near, today, now_iso, rules, market_on, rows=base_rows[f["id"]])
        bundles[f["id"]]["hasGroups"] = bool(groups.get(f["id"]))
        bundles[f["id"]]["hasMarket"] = bool(obs.get(f["id"]))
    notices = []
    if not market_on:
        notices.append(CONNECT)
    if not pricing_synced:
        notices.append("Cubby's pricing groups have not been synced yet. They arrive with the next Cubby sync (every 15 minutes).")
    insights = rank([i for b in bundles.values() for i in b["insights"]])
    if not market_on:
        insights.append(insight(None, "setup", "stortrack", "low", "Connect StorTrack to Compare With the Market",
                                "No competitor rates are on file for any facility, so market position and competitor moves "
                                "are not shown. StorTrack fills them once the Cubby warehouse key is set; website and "
                                "manual rates in Rate Management count too.", {}, "Ask an administrator to set CUBBY_BQ_CREDENTIALS_JSON.",
                                {"tab": "market"}))
    ov = [b["overview"] for b in bundles.values()]
    return {
        "generatedAt": now_iso, "syncedAt": summary.get("syncedAt") or "", "pricingSyncedAt": pricing_synced,
        "organization": summary.get("organization") or "",
        "market": {"connected": market_on, "stortrack": stortrack},
        "notices": notices, "kinds": [{"key": k, "label": v} for k, v in KINDS.items()],
        "discounts": sorted(discounts.values(), key=lambda d: d["name"]),
        "overview": {"rows": ov, "totals": overview_totals(ov)},
        "insights": insights, "bundles": bundles,
        "facilities": [{"id": f["id"], "name": f["shortName"]} for f in facs],
    }


# ── Cache: recomputed after each sync (cubby_sync calls forget) or when the
# newest sync / competitor rate changes, at most every few minutes otherwise.

TTL = 600.0
_cache: dict = {}
_lock = threading.Lock()


def _stamp() -> str:
    import models as m
    from database import SessionLocal
    from sqlalchemy import func
    db = SessionLocal()
    try:
        run = db.query(func.max(m.CubbySyncRun.finished_at)).scalar() or ""
        rate = db.query(func.max(m.OpsCompetitorRate.created_at)).scalar() or ""
        return f"{run}|{rate}"
    finally:
        db.close()


def forget() -> None:
    with _lock:
        _cache.clear()


def all_data() -> dict:
    """The cached computation. Blocking."""
    try:
        stamp = _stamp()
    except Exception:  # noqa: BLE001 - a stamp failure just means recompute on TTL
        stamp = ""
    hit = _cache.get("v")
    if hit and hit[0] == stamp and time.monotonic() - hit[1] < TTL:
        return hit[2]
    with _lock:
        hit = _cache.get("v")
        if hit and hit[0] == stamp and time.monotonic() - hit[1] < TTL:
            return hit[2]
        data = compute()
        _cache["v"] = (stamp, time.monotonic(), data)
        return data


def payload(facility_id: str = "") -> dict:
    """GET /facility-ops/insights: the overview and insights for every
    facility (or one), and one facility's sections. Blocking."""
    data = all_data()
    bundles = data["bundles"]
    pick = facility_id if facility_id in bundles else ""
    insights = [i for i in data["insights"] if not pick or i["facilityId"] in (pick, "")]
    return {k: v for k, v in data.items() if k not in ("bundles", "insights")} | {
        "facilityId": pick, "insights": insights, "facility": bundles.get(pick)}
