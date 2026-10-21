"""Operations > Ops Budget (Oct 21 2026): each facility's monthly results
against budget and against the same period last year, for owners at a glance.

Sources -> one table (ops_budget_models.OpsMetricMonth) -> this module -> the
API (routers/ops_budget.py). The screen never calculates a figure.

  Workbook  budgets, and actuals before Sep 2026 for whatever HB lacks (ops_budget_workbook.py)
  HB        Hummingbird actuals before Sep 2026, rebuilt from the HB export
            (hb_load.py -> hb_* tables -> hb_history.rebuild, source `hummingbird`)
  Cubby     actuals from Sep 2026, derived from the synced cubby_* tables by
            the snapshot job (ops_budget_cubby.py)
  Later     website visitors (analytics) and reviews - "Pending API" until then

Rules (the ops team's briefing, Oct 19 2026):
  * Flow metrics are summed over a period, snapshot metrics are the period's
    last month (month-end). Fiscal YTD runs from the facility's fiscal-year
    start (Setup B4) through the selected month. Prior year = the same month
    or range minus 12 months. Budget only for months in the current budget
    year, else blank.
  * Rates are recomputed from the period's counts, never averaged and never
    stored. A missing input or a zero denominator is a dash (None), never 0%.
  * Variance = actual - comparison. Percentages as points; everything else as
    the difference plus the percent change. Higher-better / lower-better /
    neutral per metric; neutral and even are never colored.
  * Cubby wins for actuals from Sep 2026 (when it has a value). Before Sep
    2026 Hummingbird wins for every metric it provides, then the workbook
    (Neil, Oct 21 2026). Tows always come from the workbook.

Everything here except `load_rows` / `facilities` is pure, so the tests feed
it fixed rows. Aggregates only: nothing here knows a tenant.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

TZ = "America/Los_Angeles"
CUBBY_FROM = "2026-09"           # Cubby is the actuals source from this month on
HISTORY_FROM = "2023-01"         # the earliest month the month picker offers
WORKBOOK_ONLY = {"tows"}         # never from an API

SEGMENTS = {"self_storage": "Self-Storage", "vehicle": "Vehicle Storage"}
SEGMENT_SENTENCE = {"self_storage": "Self-storage", "vehicle": "Vehicle storage"}
SCENARIOS = ("actual", "budget")
SOURCES = ("workbook", "cubby_api", "analytics_api", "reviews_api", "hummingbird")

# The five Greens sites (operator-managed stores are out of scope).
FACILITIES = [
    ("escondido", "Greens Storage Escondido", "Escondido"),
    ("fairfield", "Greens Storage Fairfield", "Fairfield"),
    ("murrieta", "Greens Storage Murrieta", "Murrieta"),
    ("temecula", "Greens Storage Temecula", "Temecula"),
    ("valley-center", "Greens Storage Valley Center", "Valley Center"),
]

# Which API connections are live. Until they are, their metrics read
# "Pending API" wherever no value was loaded.
LIVE_APIS = {"analytics_api": False, "reviews_api": False}

SECTIONS = [
    ("occupancy", "Occupancy"),
    ("pricing", "Pricing"),
    ("activity", "Rental Activity"),
    ("funnel", "Sales Funnel"),
    ("ancillary", "Ancillary & Customer"),
    ("collections", "Collections (Month-End)"),
    ("liens", "Liens & Tows"),
]


def _m(key, label, section, kind, unit, better, aliases=(), api=None, vehicle_only=False):
    return {"key": key, "label": label, "section": section, "kind": kind, "unit": unit, "better": better,
            "aliases": list(aliases), "api": api, "vehicleOnly": vehicle_only}


# kind: flow (summed) | snapshot (month-end) | rate (computed, never stored)
# unit: count | sqft | money (whole dollars) | rate (dollars and cents) | pct (a fraction)
# better: up | down | neutral
# The list order IS the display order of the All numbers table.
METRICS = [
    _m("total_units", "Total rentable units", "occupancy", "snapshot", "count", "neutral",
       ["Total units", "Rentable units", "Total rentable units #"]),
    _m("occupied_units", "Occupied units", "occupancy", "snapshot", "count", "up",
       ["Units occupied", "Rented units", "Units rented"]),
    _m("unit_occupancy", "Unit occupancy", "occupancy", "rate", "pct", "up"),
    _m("total_sqft", "Total rentable sq ft", "occupancy", "snapshot", "sqft", "neutral",
       ["Total rentable square feet", "Rentable sq ft", "Total sq ft", "Total square feet"]),
    _m("occupied_sqft", "Occupied sq ft", "occupancy", "snapshot", "sqft", "up",
       ["Occupied square feet", "Rented sq ft", "Sq ft occupied"]),
    _m("sqft_occupancy", "Sq ft occupancy", "occupancy", "rate", "pct", "up"),
    _m("gpr", "Gross potential rent", "occupancy", "flow", "money", "neutral", ["GPR", "Gross potential"]),
    _m("rental_income", "Actual rental income", "occupancy", "flow", "money", "up",
       ["Rental income", "Actual rent", "Rental revenue", "Actual rental revenue"]),
    _m("economic_occupancy", "Economic occupancy", "occupancy", "rate", "pct", "up"),

    _m("avg_standard_rate", "Avg standard rate", "pricing", "snapshot", "rate", "up",
       ["Average standard rate", "Standard rate", "Avg street rate", "Average street rate"]),
    _m("avg_web_rate", "Avg web rate", "pricing", "snapshot", "rate", "up",
       ["Average web rate", "Web rate", "Avg online rate"]),
    _m("web_vs_standard", "Web rate vs standard", "pricing", "rate", "pct", "neutral"),

    _m("move_ins", "Move-ins", "activity", "flow", "count", "up", ["Move ins", "Rentals", "Move-ins (excl transfers)"]),
    _m("move_outs", "Move-outs", "activity", "flow", "count", "down", ["Move outs", "Vacates", "Move-outs (excl transfers)"]),
    _m("net_rentals", "Net rentals", "activity", "rate", "count", "up"),
    _m("sqft_moved_in", "Sq ft moved in", "activity", "flow", "sqft", "up", ["Square feet moved in", "Move-in sq ft"]),
    _m("sqft_moved_out", "Sq ft moved out", "activity", "flow", "sqft", "down", ["Square feet moved out", "Move-out sq ft"]),
    _m("net_sqft", "Net sq ft movement", "activity", "rate", "sqft", "up"),

    _m("website_visitors", "Website visitors", "funnel", "flow", "count", "up", ["Web visitors", "Visitors"],
       api="analytics_api"),
    _m("reservations", "Reservations", "funnel", "flow", "count", "up", ["Reservations made", "New reservations"]),
    _m("visitor_to_reservation", "Website visitor to reservation", "funnel", "rate", "pct", "up", api="analytics_api"),
    _m("reservations_converted", "Reservations converted", "funnel", "flow", "count", "up",
       ["Reservations converted to move-ins", "Converted reservations", "Reservations moved in"]),
    _m("reservation_to_move_in", "Reservation to move-in", "funnel", "rate", "pct", "up"),
    _m("leads", "Leads", "funnel", "flow", "count", "up", ["Inquiries", "New leads", "Leads (excl duplicates)"]),
    _m("lead_to_move_in", "Lead to move-in", "funnel", "rate", "pct", "up"),

    _m("insured_rentals", "New rentals with insurance", "ancillary", "flow", "count", "up",
       ["New rentals with insurance / protection", "New rentals with protection", "New rentals with insurance/protection",
        "Insured move-ins", "New rentals with coverage"]),
    _m("insurance_take_rate", "Insurance take-rate", "ancillary", "rate", "pct", "up"),
    _m("autopay_tenants", "Tenants on autopay", "ancillary", "snapshot", "count", "up", ["Autopay tenants", "Tenants on auto pay"]),
    _m("autopay_pct", "Autopay", "ancillary", "rate", "pct", "up"),
    _m("new_reviews", "New online reviews", "ancillary", "flow", "count", "up", ["New reviews", "Online reviews"],
       api="reviews_api"),
    _m("avg_review_rating", "Average review rating", "ancillary", "snapshot", "rate1", "up",
       ["Avg review rating", "Review rating"], api="reviews_api"),

    _m("ar_1_30", "Past due 1-30 days", "collections", "snapshot", "money", "down",
       ["Past due 0-30 days", "Past due 1-30", "AR 1-30", "AR 0-30", "Past due under 30 days"]),
    _m("ar_31_60", "Past due 31-60 days", "collections", "snapshot", "money", "down", ["Past due 31-60", "AR 31-60"]),
    _m("ar_61_90", "Past due 61-90 days", "collections", "snapshot", "money", "down", ["Past due 61-90", "AR 61-90"]),
    _m("ar_90_plus", "Past due 90+ days", "collections", "snapshot", "money", "down",
       ["Past due 90+", "Past due over 90 days", "Past due 91+ days", "AR 90+", "Past due 90 plus days"]),
    _m("total_past_due", "Total past due", "collections", "rate", "money", "down"),
    _m("share_over_30", "Share over 30 days", "collections", "rate", "pct", "down"),

    _m("liens", "Liens completed", "liens", "flow", "count", "neutral", ["Liens", "Lien sales completed", "Auctions completed"]),
    _m("tows", "Tows completed", "liens", "flow", "count", "neutral", ["Tows"], vehicle_only=True),
]
BY_KEY = {m["key"]: m for m in METRICS}
INPUTS = [m["key"] for m in METRICS if m["kind"] != "rate"]
RATES = [m["key"] for m in METRICS if m["kind"] == "rate"]


def metrics_for(segment: str) -> list[dict]:
    return [m for m in METRICS if not (m["vehicleOnly"] and segment != "vehicle")]


def definitions(segment: str) -> list[dict]:
    """The registry as the API sends it (no aliases)."""
    return [{k: v for k, v in m.items() if k != "aliases"} for m in metrics_for(segment)]


# ── Months ────────────────────────────────────────────────────────────────────

def ym(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def add_months(month: str, n: int) -> str:
    y, m = int(month[:4]), int(month[5:7])
    i = y * 12 + (m - 1) + n
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def month_range(start: str, end: str) -> list[str]:
    out, m = [], start
    while m <= end:
        out.append(m)
        m = add_months(m, 1)
    return out


def first_of(month: str) -> str:
    return f"{month}-01"


def valid_month(month: str) -> bool:
    return bool(re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month or ""))


def today_local() -> date:
    return datetime.now(ZoneInfo(TZ)).date()


def default_month(today: date | None = None) -> str:
    """The last finished month - month-end figures are final then."""
    return add_months(ym(today or today_local()), -1)


def fiscal_start(month: str, fiscal_start_month: int) -> str:
    """The first month of the fiscal year `month` falls in."""
    fs = fiscal_start_month if 1 <= (fiscal_start_month or 0) <= 12 else 1
    y, m = int(month[:4]), int(month[5:7])
    return f"{y if m >= fs else y - 1:04d}-{fs:02d}"


def period_months(month: str, period: str, fiscal_start_month: int = 1) -> list[str]:
    if period == "ytd":
        return month_range(fiscal_start(month, fiscal_start_month), month)
    return [month]


MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
               "October", "November", "December")


def month_label(month: str, long: bool = False) -> str:
    name = MONTH_NAMES[int(month[5:7]) - 1]
    return f"{name if long else name[:3]} {month[:4]}"


# ── Picking a source ──────────────────────────────────────────────────────────

def source_order(metric: str, month: str) -> list[str]:
    """Whose value counts for an ACTUAL, best first."""
    if metric in WORKBOOK_ONLY:
        return ["workbook"]
    api = BY_KEY.get(metric, {}).get("api")
    if month >= CUBBY_FROM:
        return [s for s in ("cubby_api", api) if s] + ["workbook", "hummingbird"]
    return ["hummingbird", "workbook"] + [s for s in ("cubby_api", api) if s]


def resolve(by_source: dict, metric: str, month: str, scenario: str = "actual"):
    """(value, source, other value) for one metric-month. `by_source` maps a
    source to its value (None = blank). The other value is the next source's,
    for reconciling Cubby against the workbook while both run."""
    if scenario == "budget":
        v = by_source.get("workbook")
        return v, ("workbook" if v is not None else ""), None
    picked = None
    for s in source_order(metric, month):
        v = by_source.get(s)
        if v is None:
            continue
        if picked is None:
            picked = (v, s)
        else:
            return picked[0], picked[1], v
    return (picked[0], picked[1], None) if picked else (None, "", None)


def table(rows) -> dict:
    """{(scenario, month 'YYYY-MM'): {metric: {source: value}}} from
    OpsMetricMonth-shaped rows (objects or dicts)."""
    out: dict = {}
    for r in rows:
        g = (lambda k: r[k]) if isinstance(r, dict) else (lambda k: getattr(r, k))
        key = (g("scenario"), g("month")[:7])
        out.setdefault(key, {}).setdefault(g("metric"), {})[g("source")] = g("value")
    return out


def month_values(tbl: dict, scenario: str, month: str) -> tuple[dict, dict]:
    """({metric: value}, {metric: (source, other value)}) for one month."""
    raw = tbl.get((scenario, month), {})
    vals, meta = {}, {}
    for key in INPUTS:
        v, src, alt = resolve(raw.get(key, {}), key, month, scenario)
        vals[key] = v
        if src:
            meta[key] = (src, alt)
    return vals, meta


# ── Calculation ───────────────────────────────────────────────────────────────

def _div(a, b):
    if a is None or b is None or b == 0:
        return None
    return a / b


def _sub(a, b):
    return None if a is None or b is None else a - b


def derive(v: dict) -> dict:
    """Inputs -> inputs plus every rate. Pure."""
    out = dict(v)
    g = v.get
    out["unit_occupancy"] = _div(g("occupied_units"), g("total_units"))
    out["sqft_occupancy"] = _div(g("occupied_sqft"), g("total_sqft"))
    out["economic_occupancy"] = _div(g("rental_income"), g("gpr"))
    ratio = _div(g("avg_web_rate"), g("avg_standard_rate"))
    out["web_vs_standard"] = None if ratio is None else ratio - 1
    out["net_rentals"] = _sub(g("move_ins"), g("move_outs"))
    out["net_sqft"] = _sub(g("sqft_moved_in"), g("sqft_moved_out"))
    out["visitor_to_reservation"] = _div(g("reservations"), g("website_visitors"))
    out["reservation_to_move_in"] = _div(g("reservations_converted"), g("reservations"))
    out["lead_to_move_in"] = _div(g("move_ins"), g("leads"))
    out["insurance_take_rate"] = _div(g("insured_rentals"), g("move_ins"))
    out["autopay_pct"] = _div(g("autopay_tenants"), g("occupied_units"))
    buckets = [g("ar_1_30"), g("ar_31_60"), g("ar_61_90"), g("ar_90_plus")]
    total = None if any(b is None for b in buckets) else sum(buckets)
    out["total_past_due"] = total
    out["share_over_30"] = None if total is None else _div(sum(buckets[1:]), total)
    return out


def aggregate(per_month: list[dict]) -> dict:
    """Inputs over a period: flows summed (a dash if any month is blank),
    snapshots from the last month. `per_month` is oldest first."""
    if not per_month:
        return dict.fromkeys(INPUTS)
    out = {}
    for key in INPUTS:
        if BY_KEY[key]["kind"] == "flow":
            vals = [m.get(key) for m in per_month]
            out[key] = None if any(x is None for x in vals) else sum(vals)
        else:
            out[key] = per_month[-1].get(key)
    return out


def in_budget_year(months: list[str], budget_year_start: str) -> bool:
    if not budget_year_start or not valid_month(budget_year_start):
        return False
    end = add_months(budget_year_start, 11)
    return all(budget_year_start <= m <= end for m in months)


# ── Variance ──────────────────────────────────────────────────────────────────

_ROUND = {"count": 0, "sqft": 0, "money": 0, "rate": 2, "rate1": 1}


def variance(metric: str, actual, comp) -> dict | None:
    """actual - comparison. None when either side is missing.
    status: better | worse | even | neutral; arrow: up | down | None."""
    if actual is None or comp is None:
        return None
    m = BY_KEY[metric]
    diff = actual - comp
    if m["unit"] == "pct":
        pts = diff * 100
        even = round(pts, 1) == 0
        out = {"diff": diff, "pts": pts, "pctChange": None}
    else:
        even = round(diff, _ROUND.get(m["unit"], 0)) == 0
        out = {"diff": diff, "pts": None, "pctChange": (diff / abs(comp)) if comp else None}
    arrow = None if even else ("up" if diff > 0 else "down")
    if even:
        status = "even"
    elif m["better"] == "neutral":
        status = "neutral"
    else:
        status = "better" if (diff > 0) == (m["better"] == "up") else "worse"
    return {**out, "arrow": arrow, "status": status, "even": even}


# ── Words (server-built sentences: US formats, American English) ──────────────

def fmt_value(metric: str, v) -> str:
    if v is None:
        return "-"
    unit = BY_KEY[metric]["unit"]
    if unit == "pct":
        return f"{v * 100:.1f}%"
    if unit == "money":
        return f"{'-' if v < 0 else ''}${abs(round(v)):,}"
    if unit == "rate":
        return f"{'-' if v < 0 else ''}${abs(v):,.2f}"
    if unit == "rate1":
        return f"{v:.1f}"
    return f"{round(v):,}"


def fmt_diff(metric: str, diff) -> str:
    """The size of a difference, no sign: '1.8 pts', '$10,700', '$11.60', '13'."""
    unit = BY_KEY[metric]["unit"]
    if unit == "pct":
        return f"{abs(diff) * 100:.1f} pts"
    return fmt_value(metric, abs(diff))


def _money_words(v) -> str:
    return f"${abs(round(v)):,}"


# The summary card (Going well / Needs attention).
VS_LAST_YEAR = [("unit_occupancy", "Unit occupancy"), ("economic_occupancy", "Economic occupancy"),
                ("rental_income", "Rental income"), ("avg_standard_rate", "Standard rate")]
VS_PLAN = [("net_rentals", "Net rentals"), ("move_outs", "Move-outs"), ("reservation_to_move_in", "Reservation conversion"),
           ("autopay_pct", "Autopay"), ("insurance_take_rate", "Insurance take-rate"), ("total_past_due", "Unpaid rent"),
           ("share_over_30", "Share of unpaid rent over 30 days")]
LIST_MAX = 4


def summary(segment: str, period: str, month: str, actual: dict, budget: dict, prior: dict) -> dict:
    """The headline and the two lists. Each metric once, in order; even or
    missing comparisons are left out. Lists show at most LIST_MAX each;
    `attentionCount` is every item that needs attention."""
    good, bad = [], []
    for key, name in VS_LAST_YEAR:
        var = variance(key, actual.get(key), prior.get(key))
        if not var or var["status"] not in ("better", "worse"):
            continue
        words = "up" if var["diff"] > 0 else "down"
        item = {"metric": key, "name": name,
                "text": f"{name} is {fmt_value(key, actual[key])}, {words} {fmt_diff(key, var['diff'])} from last year.",
                "rest": f" is {fmt_value(key, actual[key])}, {words} {fmt_diff(key, var['diff'])} from last year.",
                "arrow": var["arrow"]}
        (good if var["status"] == "better" else bad).append(item)
    for key, name in VS_PLAN:
        var = variance(key, actual.get(key), budget.get(key))
        if not var or var["status"] not in ("better", "worse"):
            continue
        rest = f" is {fmt_value(key, actual[key])} against a plan of {fmt_value(key, budget[key])}."
        item = {"metric": key, "name": name, "text": name + rest, "rest": rest, "arrow": var["arrow"]}
        (good if var["status"] == "better" else bad).append(item)

    who = SEGMENT_SENTENCE.get(segment, "This site")
    when = "the same month last year" if period == "month" else "this time last year"
    occ = actual.get("unit_occupancy")
    inc, inc_py = actual.get("rental_income"), prior.get("rental_income")
    if occ is not None and inc is not None and inc_py is not None:
        diff = inc - inc_py
        if round(diff) == 0:
            head = f"{who} is {fmt_value('unit_occupancy', occ)} full and earning the same rent as {when}"
        else:
            head = (f"{who} is {fmt_value('unit_occupancy', occ)} full and earning {_money_words(diff)} "
                    f"{'more' if diff > 0 else 'less'} rent than {when}")
    elif occ is not None:
        head = f"{who} is {fmt_value('unit_occupancy', occ)} full"
    elif inc is not None and inc_py is not None:
        diff = inc - inc_py
        head = (f"{who} is earning the same rent as {when}" if round(diff) == 0 else
                f"{who} is earning {_money_words(diff)} {'more' if diff > 0 else 'less'} rent than {when}")
    else:
        head = ""
    n = len(bad)
    if head:
        if n:
            head += f", but {n} {'item needs' if n == 1 else 'items need'} attention."
        else:
            head += "."
    else:
        head = (f"There are not enough figures for {who.lower()} in {month_label(month, long=True)} yet."
                if period == "month" else f"There are not enough figures for {who.lower()} this fiscal year yet.")
    return {"headline": head, "goingWell": good[:LIST_MAX], "needsAttention": bad[:LIST_MAX],
            "goingWellCount": len(good), "attentionCount": n}


def funnel_takeaway(actual: dict) -> str:
    leads, ins = actual.get("leads"), actual.get("move_ins")
    if not leads or ins is None:
        return ""
    out = f"Out of every 10 inquiries, about {round(ins / leads * 10)} became a rental."
    return out + f" {round(ins):,} move-ins in total, including walk-ins who never reserved."


def inout_takeaway(points: list[dict]) -> str:
    ins = [p.get("move_ins") for p in points]
    outs = [p.get("move_outs") for p in points]
    if not points or any(v is None for v in ins + outs):
        return ""
    a, b = round(sum(ins)), round(sum(outs))
    net = a - b
    tail = "no net change" if net == 0 else f"a net {'gain' if net > 0 else 'loss'} of {abs(net):,}"
    return f"{a:,} customers moved in and {b:,} moved out over the last {len(points)} months, {tail}."


def occupancy_takeaway(points: list[dict]) -> str:
    vals = [p.get("unit_occupancy") for p in points if p.get("unit_occupancy") is not None]
    if len(vals) < 2:
        return ""
    first, last = vals[0], vals[-1]
    a, b = f"{first * 100:.1f}%", f"{last * 100:.1f}%"
    if a == b:
        line = f"Units rented held at {b} over two years."
    else:
        line = f"Units rented {'rose' if last > first else 'fell'} from {a} to {b} over two years."
    return line + " The gap between the lines is rent lost to discounts, vacancies and late payers."


def rate_takeaway(points: list[dict]) -> str:
    if not points:
        return ""
    last = points[-1]
    std, web = last.get("avg_standard_rate"), last.get("avg_web_rate")
    out = []
    year_ago = points[-13].get("avg_standard_rate") if len(points) >= 13 else None
    if std is not None and year_ago:
        ch = (std / year_ago - 1) * 100
        out.append(f"The standard rate is {'up' if ch >= 0 else 'down'} {abs(ch):.1f}% from a year ago." if round(ch, 1)
                   else "The standard rate is the same as a year ago.")
    if std is not None and web is not None:
        gap = std - web
        if round(gap) > 0:
            out.append(f"Online customers pay about ${round(gap):,} a month less.")
        elif round(gap) < 0:
            out.append(f"Online customers pay about ${abs(round(gap)):,} a month more.")
        else:
            out.append("Online customers pay about the same.")
    return " ".join(out)


# ── The report ────────────────────────────────────────────────────────────────

def _months_needed(month: str, period: str, fsm: int) -> list[str]:
    months = period_months(month, period, fsm)
    return [add_months(m, -12) for m in months] + months


def build_report(tbl: dict, *, facility: dict, segment: str, month: str, period: str) -> dict:
    """GET /ops-budget's body from the metric table of one facility + segment."""
    fsm = facility.get("fiscalStartMonth") or 1
    months = period_months(month, period, fsm)
    prior_months = [add_months(m, -12) for m in months]

    def series(scenario, ms):
        vals, metas = [], []
        for mo in ms:
            v, meta = month_values(tbl, scenario, mo)
            vals.append(v)
            metas.append(meta)
        return vals, metas

    act_m, act_meta = series("actual", months)
    pri_m, _ = series("actual", prior_months)
    actual = derive(aggregate(act_m))
    prior = derive(aggregate(pri_m))
    budget_ok = in_budget_year(months, facility.get("budgetYearStart") or "")
    budget = derive(aggregate(series("budget", months)[0])) if budget_ok else derive(dict.fromkeys(INPUTS))

    # Where each actual came from (the last month for a snapshot, every month for a flow).
    def source_of(key):
        m = BY_KEY[key]
        if m["kind"] == "rate":
            return None
        metas = act_meta[-1:] if m["kind"] == "snapshot" else act_meta
        srcs = sorted({meta[key][0] for meta in metas if key in meta})
        return "+".join(srcs) if srcs else None

    rows = []
    for m in metrics_for(segment):
        k = m["key"]
        pending = bool(m["api"]) and not LIVE_APIS.get(m["api"], False) and actual.get(k) is None
        alt = None
        if m["kind"] == "snapshot" and act_meta and k in act_meta[-1]:
            alt = act_meta[-1][k][1]
        elif m["kind"] == "flow" and act_meta and all(k in meta for meta in act_meta):
            alts = [meta[k][1] for meta in act_meta]
            alt = None if any(a is None for a in alts) else sum(alts)
        rows.append({
            "key": k, "label": m["label"], "section": m["section"], "unit": m["unit"], "kind": m["kind"],
            "better": m["better"], "isRate": m["kind"] == "rate", "pending": pending,
            "budget": budget.get(k), "actual": actual.get(k), "lastYear": prior.get(k),
            "vsBudget": variance(k, actual.get(k), budget.get(k)),
            "vsLastYear": variance(k, actual.get(k), prior.get(k)),
            "source": source_of(k), "otherSource": alt,
        })
    return {
        "facility": facility, "segment": segment, "segmentLabel": SEGMENTS[segment],
        "month": month, "monthLabel": month_label(month), "monthLong": month_label(month, long=True),
        "period": period, "periodMonths": months, "priorMonths": prior_months,
        "periodLabel": (month_label(month, long=True) if period == "month"
                        else f"{month_label(months[0])} - {month_label(month)}"),
        "budgetAvailable": budget_ok and any(budget.get(k) is not None for k in INPUTS),
        "summary": summary(segment, period, month, actual, budget, prior),
        "funnelTakeaway": funnel_takeaway(actual),
        "sections": [{"key": k, "label": label} for k, label in SECTIONS],
        "metrics": rows,
        "notes": notes(segment),
    }


def build_trend(tbl: dict, *, segment: str, end: str, months: int = 24) -> dict:
    window = month_range(add_months(end, -(months - 1)), end)
    points = []
    for mo in window:
        v = derive(month_values(tbl, "actual", mo)[0])
        points.append({"month": mo, "label": month_label(mo), **{k: v.get(k) for k in (
            "unit_occupancy", "economic_occupancy", "avg_standard_rate", "avg_web_rate", "move_ins", "move_outs")}})
    last12 = points[-12:]
    return {
        "segment": segment, "end": end, "points": points,
        "takeaways": {"inout": inout_takeaway(last12), "occupancy": occupancy_takeaway(points),
                      "rates": rate_takeaway(points)},
    }


def notes(segment: str) -> list[str]:
    out = [f"Actuals come from Cubby from {month_label(CUBBY_FROM, long=True)} on. Before that they come from "
           "Hummingbird where it has the figure, and from the Ops Budget workbook for the rest.",
           "Rates are worked out from the period's counts, never averaged. A dash means a figure is missing."]
    if segment == "vehicle":
        out.append("Tows come from the workbook only.")
    return out


# ── Database (blocking - call in a thread or from a plain `def` endpoint) ─────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_seeded(db) -> None:
    from ops_budget_models import OpsBudgetFacility
    have = {f.id for f in db.query(OpsBudgetFacility).all()}
    added = False
    for i, (fid, name, short) in enumerate(FACILITIES):
        if fid not in have:
            db.add(OpsBudgetFacility(id=fid, name=name, short_name=short, fiscal_start_month=1, sort_order=i,
                                     updated_at=now_iso(), updated_by="seed"))
            added = True
    if added:
        db.commit()


def facility_json(f) -> dict:
    return {"id": f.id, "name": f.name or "", "shortName": f.short_name or "",
            "fiscalStartMonth": f.fiscal_start_month or 1, "budgetYearStart": f.budget_year_start or "",
            "historyStart": f.history_start or "", "cubbyFacilityId": f.cubby_facility_id or ""}


def facilities(db) -> list[dict]:
    from ops_budget_models import OpsBudgetFacility
    ensure_seeded(db)
    return [facility_json(f) for f in db.query(OpsBudgetFacility).order_by(OpsBudgetFacility.sort_order).all()]


def facility(db, fid: str):
    from ops_budget_models import OpsBudgetFacility
    ensure_seeded(db)
    return db.get(OpsBudgetFacility, fid)


def load_rows(db, facility_id: str, segment: str, months: list[str]):
    from ops_budget_models import OpsMetricMonth as M
    if not months:
        return []
    return (db.query(M.scenario, M.month, M.metric, M.source, M.value)
            .filter(M.facility_id == facility_id, M.segment == segment,
                    M.month >= first_of(min(months)), M.month <= first_of(max(months))).all())


def rows_as_dicts(rows) -> list[dict]:
    return [{"scenario": r[0], "month": r[1], "metric": r[2], "source": r[3], "value": r[4]} for r in rows]


def report_for(db, fac, segment: str, month: str, period: str) -> dict:
    fj = facility_json(fac)
    rows = rows_as_dicts(load_rows(db, fac.id, segment, _months_needed(month, period, fj["fiscalStartMonth"])))
    return build_report(table(rows), facility=fj, segment=segment, month=month, period=period)


def trend_for(db, fac, segment: str, end: str, months: int) -> dict:
    window = month_range(add_months(end, -(months - 1)), end)
    rows = rows_as_dicts(load_rows(db, fac.id, segment, window))
    return build_trend(table(rows), segment=segment, end=end, months=months)


def data_range(db, facility_id: str) -> dict:
    """First and last month holding any actual value, per segment."""
    from sqlalchemy import func

    from ops_budget_models import OpsMetricMonth as M
    out = {}
    for seg, lo, hi in (db.query(M.segment, func.min(M.month), func.max(M.month))
                        .filter(M.facility_id == facility_id, M.scenario == "actual", M.value.isnot(None))
                        .group_by(M.segment).all()):
        out[seg] = {"first": (lo or "")[:7], "last": (hi or "")[:7]}
    return out


# ── Writing values (shared by the workbook loader and the Cubby job) ──────────

def row_id(fac: str, seg: str, month: str, scenario: str, metric: str, source: str) -> str:
    return f"{fac}:{seg}:{first_of(month)}:{scenario}:{metric}:{source}"


def upsert(db, values: list[tuple], *, source: str, by: str, load_id: str = "", stamp: str = "") -> int:
    """Write [(facility, segment, 'YYYY-MM', scenario, metric, value)] for one
    source in the open session (the caller commits). A None value clears a row
    that exists and creates none. Returns the rows written."""
    from ops_budget_models import OpsMetricMonth as M
    if not values:
        return 0
    stamp = stamp or now_iso()
    ids = {row_id(f, s, mo, sc, k, source): (f, s, mo, sc, k, v) for f, s, mo, sc, k, v in values}
    existing = {}
    keys = list(ids)
    for i in range(0, len(keys), 500):
        for r in db.query(M).filter(M.id.in_(keys[i:i + 500])).all():
            existing[r.id] = r
    written = 0
    for rid, (f, s, mo, sc, k, v) in ids.items():
        r = existing.get(rid)
        if r is None:
            if v is None:
                continue
            db.add(M(id=rid, facility_id=f, segment=s, month=first_of(mo), scenario=sc, metric=k, value=float(v),
                     source=source, load_id=load_id, loaded_at=stamp, loaded_by=by))
            written += 1
        elif r.value != (None if v is None else float(v)):
            r.value = None if v is None else float(v)
            r.load_id, r.loaded_at, r.loaded_by = load_id, stamp, by
            written += 1
    return written
