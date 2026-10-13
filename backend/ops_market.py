"""Operations -> Market Rates: our street rate against what nearby facilities
charge for the same size, and a suggested rate.

Where the competitor numbers come from - two sources, told apart by `source`:

  manual   a person looked the rate up (the competitor's website, a phone
           call, a drive-by) and recorded it here with the date.
  web      `ops_market_engine.py` read it from the competitor's own public
           pricing page: once a day, as an identified reader that obeys the
           site's robots.txt, with every rate checked against the page text
           before it is kept. A site that blocks automated readers, or loads
           its prices with scripts, is not read - it stays a manual entry.

Which facilities are nearby comes from OpenStreetMap (same module); a person
still chooses which of them to track. Nothing in THIS module does any of that
I/O. Every observation is kept, so a competitor's rate has a history. A feed
from a rate-data provider can write the same rows later with another `source`.

The suggestion is a rule a manager can check by hand, not a model's opinion:

    market   = the median of competitors' latest rates for that size
    target   = market moved by how full we are (nearly full: a little above
               market; half empty: a little below)
    suggest  = target, but never more than 10% away from today's street rate
               in one step, rounded to the dollar

It needs at least two competitors for a size; with fewer it says so instead of
guessing. The written analysis (`analyze`) is Claude reading that same table -
it explains and prioritizes, it does not produce the numbers.

Pure functions up top (the tests feed them fixed rows); the model call at the
bottom is the only I/O.
"""
from datetime import date, timedelta
from statistics import median

FRESH_DAYS = 120       # an observation older than this no longer counts as "the market"
MIN_COMPETITORS = 2
MAX_STEP = 0.10        # never suggest moving a street rate more than 10% at once

# How full we are -> where we should sit against the market median.
_BANDS = (
    (0.92, 1.05, "nearly full, so there is room to sit a little above the market"),
    (0.85, 1.00, "healthy occupancy, so match the market"),
    (0.70, 0.97, "some vacancy, so sit just under the market to fill it"),
    (0.00, 0.93, "a lot of vacancy, so price under the market until it fills"),
)


def size_key(width, depth, parking: bool) -> str:
    """10x20 and 20x10 are the same unit; parking and storage are different markets."""
    a, b = sorted((round(float(width or 0), 1), round(float(depth or 0), 1)))
    return f"{'P' if parking else 'S'}:{a:g}x{b:g}"


def latest_rates(observations: list[dict], today: date) -> dict[str, dict[str, dict]]:
    """{size_key: {competitor_id: newest fresh observation}}."""
    cutoff = (today - timedelta(days=FRESH_DAYS)).isoformat()
    out: dict[str, dict[str, dict]] = {}
    for o in observations:
        if (o.get("observed_on") or "") < cutoff or not o.get("rate_cents"):
            continue
        key = size_key(o.get("width"), o.get("depth"), bool(o.get("parking")))
        held = out.setdefault(key, {}).get(o["competitor_id"])
        if held is None or (o["observed_on"], o.get("created_at") or "") > (held["observed_on"], held.get("created_at") or ""):
            out[key][o["competitor_id"]] = o
    return out


def suggest(street: int, market: int, rented: int, vacant: int) -> tuple[int, str]:
    """(suggested street rate in cents, why)."""
    rentable = rented + vacant
    occ = rented / rentable if rentable else 0.0
    _, factor, why = next(b for b in _BANDS if occ >= b[0])
    target = market * factor
    capped = min(max(target, street * (1 - MAX_STEP)), street * (1 + MAX_STEP)) if street else target
    cents = int(round(capped / 100.0)) * 100
    note = f"{round(occ * 100)}% occupied: {why}."
    if street and abs(capped - target) > 50:
        note += f" Held to a {round(MAX_STEP * 100)}% step from today's rate."
    return cents, note


def compare(unit_types: list[dict], observations: list[dict], competitors: dict[str, str], today: date) -> list[dict]:
    """One row per unit type we rent. `unit_types` are a facility's blocks from
    cubby.summarize_facility; `competitors` is {id: name}."""
    market = latest_rates(observations, today)
    rows = []
    for t in unit_types:
        if not t.get("width") or not t.get("depth"):
            continue
        seen = [o for cid, o in market.get(size_key(t["width"], t["depth"], t.get("parking")), {}).items() if cid in competitors]
        rates = sorted(o["rate_cents"] for o in seen)
        row = {
            "name": t["name"], "width": t["width"], "depth": t["depth"], "parking": bool(t.get("parking")),
            "total": t["total"], "rented": t["rented"], "vacant": t["vacant"],
            "street": t.get("street") or 0,
            "averageRent": round(t["rentSum"] / t["rented"]) if t.get("rented") else 0,
            "competitors": len(rates),
            "marketLow": rates[0] if rates else None, "marketHigh": rates[-1] if rates else None,
            "marketMedian": int(round(median(rates))) if rates else None,
            "lowestBy": competitors.get(min(seen, key=lambda o: o["rate_cents"])["competitor_id"], "") if seen else "",
            "newestObservation": max((o["observed_on"] for o in seen), default=""),
            "suggested": None, "why": "", "change": 0, "monthlyImpact": 0,
        }
        if len(rates) >= MIN_COMPETITORS and row["street"]:
            row["suggested"], row["why"] = suggest(row["street"], row["marketMedian"], t["rented"], t["vacant"])
            row["change"] = row["suggested"] - row["street"]
            # What the change is worth on the units a new street rate actually reaches: the vacant ones.
            row["monthlyImpact"] = row["change"] * t["vacant"]
        elif rates:
            row["why"] = f"Only {len(rates)} competitor rate on file for this size. Record one more to get a suggestion."
        else:
            row["why"] = "No competitor rate on file for this size."
        rows.append(row)
    rows.sort(key=lambda r: (r["suggested"] is None, -abs(r["monthlyImpact"]), r["name"]))
    return rows


# ── Written analysis ─────────────────────────────────────────────────────────

_ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One sentence: where this facility sits against its market."},
        "findings": {"type": "array", "items": {"type": "string"},
                     "description": "3 to 5 short findings, each citing figures from the table."},
        "actions": {"type": "array", "items": {"type": "string"},
                    "description": "Up to 4 concrete next steps, most valuable first."},
        "gaps": {"type": "array", "items": {"type": "string"},
                 "description": "What data is missing or stale that would change the picture. Empty if none."},
    },
    "required": ["headline", "findings", "actions", "gaps"],
    "additionalProperties": False,
}

_ANALYSIS_SYSTEM = (
    "You are a revenue analyst for a self-storage operator. You are given one facility's unit types with "
    "our street rate, our average in-place rent, occupancy, and the low / median / high of nearby "
    "competitors' recorded rates, plus a rule-based suggested rate for each. Write for a facility manager.\n"
    "Rules: use ONLY the figures provided - never invent a competitor, a rate, or a market fact. Money in the "
    "data is in US dollars. If a size has fewer than two competitor rates, say the data is too thin instead "
    "of drawing a conclusion. Prefer the few changes worth the most money. Plain American English, no "
    "em dashes, no marketing language, no hedging filler."
)


def analyze(facility_name: str, rows: list[dict], competitor_names: list[str]) -> dict:
    """Blocking (one Claude call). Call it in a thread."""
    import construction_ai   # the repo's one Messages helper: structured output, fallbacks, error mapping

    def usd(c):
        return None if c is None else round(c / 100, 2)
    table = [{
        "unitType": r["name"], "units": r["total"], "rented": r["rented"], "vacant": r["vacant"],
        "ourStreetRate": usd(r["street"]), "ourAverageRent": usd(r["averageRent"]),
        "competitorsWithARate": r["competitors"], "marketLow": usd(r["marketLow"]),
        "marketMedian": usd(r["marketMedian"]), "marketHigh": usd(r["marketHigh"]),
        "lowestPricedCompetitor": r["lowestBy"], "newestObservation": r["newestObservation"],
        "suggestedStreetRate": usd(r["suggested"]), "ruleReason": r["why"],
    } for r in rows]
    import json
    text = (f"Facility: {facility_name}\nCompetitors tracked: {', '.join(competitor_names) or 'none'}\n"
            f"Unit types (JSON):\n{json.dumps(table)}")
    return construction_ai._call(system=_ANALYSIS_SYSTEM, content=[{"type": "text", "text": text}],
                                 schema=_ANALYSIS_SCHEMA, effort="medium", max_tokens=3000)
