"""Hummingbird history, rebuilt month by month from the hb_* tables (Oct 21 2026).

Neil (Oct 21): "the hummingbird rate history needs to get brought in and all
operating metrics from HB data." HB's reports only answer "as of today"
(month-to-date / year-to-date), so the months are rebuilt from the lease list,
the units and each lease's invoices and payments:

  * Where history starts: HB holds only the leases that were active when a
    site moved onto HB, plus everything after - a tenant who left before that
    is not in the export. So a site's history starts the month AFTER the first
    move-out HB recorded (`go_live`): Dec 2023 for Temecula, Valley Center,
    Murrieta and Escondido (move-outs from Nov 15 2023), Nov 2025 for
    Fairfield. It ends the month before Cubby (Aug 2026).
  * Occupied at month-end: leases with status 1 (0 = a move-in never
    completed) that started on or before the last day and had not moved out.
  * Rentable units: the unit is not offline at export (Inactive, Maintenance,
    Company, To Clean ...), or it was rented that month-end. HB keeps no unit
    status history.
  * Move-ins / move-outs: leases starting / ending in the month, transfers
    (HB's transfer report) left out - the Ops Budget rule. Square feet = the
    unit's width x length. Insured move-ins = HB's rental activity shows an
    insurance premium at move-in. Liens = move-outs HB marks as auctions.
  * Sell (web) rate: HB records a space's price at every move-in, move-out
    and transfer (space activity). A unit's rate at month-end is its last
    reading on or before that day (else its first reading after; the export's
    price is the final reading). A unit type's sell rate is the median of its
    units'. So a rate change shows from the first move-in / move-out after it.
  * In-place rent: a lease's rent in a month is its recurring (auto) invoice
    less any insurance premium on it, else the nearest such month, else its
    rent at export. Actual rental income = invoice subtotals by period start,
    less insurance and discounts (fees are not separable and stay in, about
    1% of rent).
  * Past due at month-end, per lease still renting (aging): an invoice
    amount still open at export was open at every month-end since it fell
    due; the paid parts are cleared by the ledger's payments oldest first.
    Aged from each invoice's due day: 1-30, 31-60, 61-90, 90+ days.

Not in HB's export, so left to the Ops Budget workbook: standard rate (HB
keeps today's set rate only) and so gross potential rent and economic
occupancy, tenants on autopay (today only), reservations and their
conversion, website visitors, reviews, tows.

Segments: the Ops Budget rule (ops_budget_cubby.segment_of) on the unit type
name - "Parking" = vehicle, "Storage" = self-storage; mailboxes,
deactivated spaces and "Other" count nowhere.

Writes: ops_metric_month rows with source `hummingbird` (scenario actual),
replacing that facility's earlier hummingbird rows; hb_rate_months for CMA
Rate History. Pure functions on dicts except `rebuild` / `rate_history`.
"""
from __future__ import annotations

import calendar
import statistics
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, timezone

import hb_models as hm
import ops_budget as ob
import ops_budget_cubby as obc

SOURCE = "hummingbird"
BY = "hb-history"
RENTABLE_STATES = {"leased", "available", "overlocked", "to overlock", "remove overlock", "reserved",
                   "future leased", "pending", "auction", "lien"}
METRIC_KEYS = ("total_units", "occupied_units", "total_sqft", "occupied_sqft", "rental_income", "avg_web_rate",
               "move_ins", "move_outs", "sqft_moved_in", "sqft_moved_out", "insured_rentals", "liens",
               "ar_1_30", "ar_31_60", "ar_61_90", "ar_90_plus")
NOT_PROVIDED = ("avg_standard_rate", "gpr", "autopay_tenants", "reservations", "reservations_converted", "leads",
                "website_visitors", "new_reviews", "avg_review_rating", "tows")


def month_end(month: str) -> str:
    y, m = int(month[:4]), int(month[5:7])
    return f"{month}-{calendar.monthrange(y, m)[1]:02d}"


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(a) - date.fromisoformat(b)).days


def norm_type(name: str) -> str:
    """Unit type names compared loosely: HB and Cubby differ in trailing
    spaces ("Parking - Asphalt, Drive-In ") and spacing."""
    return " ".join((name or "").lower().split())


# ── Pieces ────────────────────────────────────────────────────────────────────

def history_window(leases: list[dict], export_day: str, last_month: str) -> tuple[str, str, str]:
    """(go-live day, first month, last month). '' when HB recorded no move-out."""
    ends = sorted(le["end_date"] for le in leases if le.get("status") == 1 and le.get("end_date"))
    if not ends:
        return "", "", ""
    first = ob.add_months(ends[0][:7], 1)
    last = min(last_month, ob.add_months(export_day[:7], -1)) if export_day else last_month
    return ends[0], first, last


def tenancies(leases: list[dict]) -> list[dict]:
    """Real tenancies: status 1, a start day, not ending before it began."""
    return [le for le in leases if le.get("status") == 1 and le.get("start_date")
            and not (le.get("end_date") and le["end_date"] < le["start_date"])]


def in_at(le: dict, day: str) -> bool:
    return le["start_date"] <= day and (not le.get("end_date") or le["end_date"] > day)


class PriceBook:
    """Each unit's sell-rate readings, oldest first."""

    def __init__(self, readings: dict[str, list[tuple[str, float]]]):
        self.days, self.vals = {}, {}
        for uid, obs in readings.items():
            obs = sorted(o for o in obs if o[1] is not None)
            if obs:
                self.days[uid] = [o[0] for o in obs]
                self.vals[uid] = [o[1] for o in obs]

    def at(self, uid: str, day: str):
        days = self.days.get(uid)
        if not days:
            return None
        i = bisect_right(days, day)
        return self.vals[uid][i - 1] if i else self.vals[uid][0]

    def count(self, uid: str, month: str) -> int:
        return sum(1 for d in self.days.get(uid, []) if d[:7] == month)


def rent_lookup(months: list[dict]) -> dict[str, dict[str, float]]:
    """{lease id: {YYYY-MM: rent}} from hb_lease_months."""
    out: dict[str, dict[str, float]] = defaultdict(dict)
    for r in months:
        if r.get("rent") is not None:
            out[r["lease_id"]][r["month"]] = r["rent"]
    return out


def rent_at(rents: dict[str, float], month: str, fallback):
    if not rents:
        return fallback
    if month in rents:
        return rents[month]
    before = [m for m in rents if m < month]
    if before:
        return rents[max(before)]
    return rents[min(rents)]


def aging(invoices: list[tuple], payments: list[tuple[str, float]], day: str) -> dict:
    """Past due on `day` for one lease: {ar_1_30, ar_31_60, ar_61_90, ar_90_plus}.

    invoices  (due day, amount, open at export) - the third item may be left out (0)
    payments  (day, amount) from the ledger

    An amount still open at export was open at every month-end since it fell
    due, so it counts in full, aged from its due day. The rest of each invoice
    was paid: the ledger's payments made by `day` clear those paid parts
    oldest first, and what they do not cover is owed on the newest. (HB's
    ledger can show one payment on each of a tenant's leases, so payments
    alone under-count what is owed.)"""
    out = {"ar_1_30": 0.0, "ar_31_60": 0.0, "ar_61_90": 0.0, "ar_90_plus": 0.0}

    def add(due_day, amt):
        late = _days(day, due_day)
        if late < 1 or amt <= 0:
            return
        key = "ar_1_30" if late <= 30 else "ar_31_60" if late <= 60 else "ar_61_90" if late <= 90 else "ar_90_plus"
        out[key] += amt
    due = sorted((x[0], float(x[1]), float(x[2]) if len(x) > 2 and x[2] else 0.0) for x in invoices if x[0] <= day)
    for d, _a, b in due:
        add(d, b)
    owed = sum(max(0.0, a - b) for _, a, b in due) - sum(a for d, a in payments if d <= day)
    for d, a, b in reversed(due):
        if owed <= 0.005:
            break
        take = min(max(0.0, a - b), owed)
        owed -= take
        add(d, take)
    return out


# ── One property ──────────────────────────────────────────────────────────────

def build(units: list[dict], leases: list[dict], months: list[dict], activity: dict, *, export_day: str,
          last_month: str, rules=None) -> dict:
    """Everything for one HB property.

    units     hb_units rows (id, number, unit_type, width, length, state, price)
    leases    hb_leases rows (id, unit_id, status, start_date, end_date, rent)
    months    hb_lease_months rows (lease_id, month, rent, invoiced, discounts, insurance, data{inv, pay})
    activity  {"prices": [(unit number, day, price)], "insured": {lease ids}, "auction": {lease ids},
               "transfer_in": {lease ids}, "transfer_out": {lease ids}}
    Returns {"goLive", "first", "last", "metrics": {(segment, month): {metric: value}},
             "rates": [hb_rate_months rows], "warnings"}."""
    warnings: list[str] = []
    go_live, first, last = history_window(leases, export_day, last_month)
    out = {"goLive": go_live, "first": first, "last": last, "metrics": {}, "rates": [], "warnings": warnings}
    if not first or first > last:
        warnings.append("HB recorded no move-out before Cubby, so there is no month to rebuild.")
        return out
    unit = {u["id"]: u for u in units}
    by_number = {u.get("number"): u["id"] for u in units}
    seg_of = {u["id"]: obc.segment_of(u.get("unit_type") or "", rules) for u in units}
    area = {u["id"]: (u.get("width") or 0) * (u.get("length") or 0) for u in units}
    online = {u["id"] for u in units if (u.get("state") or "").strip().lower() in RENTABLE_STATES}

    readings: dict[str, list] = defaultdict(list)
    for number, day, price in activity.get("prices") or []:
        uid = by_number.get(number)
        if uid and day and price is not None:
            readings[uid].append((day, float(price)))
    for u in units:
        if u.get("price") is not None and export_day:
            readings[u["id"]].append((export_day, float(u["price"])))
    book = PriceBook(readings)

    ten = [le for le in tenancies(leases) if le.get("unit_id") in unit]
    rents = rent_lookup(months)
    money_inv: dict[str, list] = defaultdict(list)
    money_pay: dict[str, list] = defaultdict(list)
    income: dict[tuple[str, str], float] = defaultdict(float)
    lease_seg = {le["id"]: seg_of.get(le["unit_id"]) for le in ten}
    for r in months:
        lid = r["lease_id"]
        data = r.get("data") or {}
        money_inv[lid] += [(x["d"], float(x["a"]), float(x.get("b") or 0)) for x in data.get("inv") or []]
        money_pay[lid] += [(x["d"], float(x["a"])) for x in data.get("pay") or []]
        seg = lease_seg.get(lid)
        if seg:
            income[(seg, r["month"])] += (r.get("invoiced") or 0) - (r.get("insurance") or 0) - (r.get("discounts") or 0)

    t_in, t_out = activity.get("transfer_in") or set(), activity.get("transfer_out") or set()
    insured, auction = activity.get("insured") or set(), activity.get("auction") or set()
    segments = sorted({s for s in seg_of.values() if s})
    types: dict[str, list[str]] = defaultdict(list)
    for u in units:
        if seg_of[u["id"]]:
            types[u["unit_type"]].append(u["id"])

    for month in ob.month_range(first, last):
        eom = month_end(month)
        rented = {}
        for le in ten:
            if in_at(le, eom):
                rented.setdefault(le["unit_id"], le)
        for seg in segments:
            uids = [uid for uid, s in seg_of.items() if s == seg]
            rentable = [uid for uid in uids if uid in online or uid in rented]
            occ = [uid for uid in uids if uid in rented]
            v = {k: 0.0 for k in METRIC_KEYS}
            v["total_units"], v["occupied_units"] = len(rentable), len(occ)
            v["total_sqft"] = round(sum(area[u] for u in rentable), 1)
            v["occupied_sqft"] = round(sum(area[u] for u in occ), 1)
            v["rental_income"] = round(income.get((seg, month), 0.0), 2)
            prices = [p for p in (book.at(u, eom) for u in rentable) if p is not None]
            v["avg_web_rate"] = round(sum(prices) / len(prices), 4) if prices else None
            for le in ten:
                if seg_of.get(le["unit_id"]) != seg:
                    continue
                if le["start_date"][:7] == month and le["id"] not in t_in:
                    v["move_ins"] += 1
                    v["sqft_moved_in"] += area[le["unit_id"]]
                    if le["id"] in insured:
                        v["insured_rentals"] += 1
                if (le.get("end_date") or "")[:7] == month and le["id"] not in t_out:
                    v["move_outs"] += 1
                    v["sqft_moved_out"] += area[le["unit_id"]]
                    if le["id"] in auction:
                        v["liens"] += 1
            for uid in occ:
                le = rented[uid]
                for k, amt in aging(money_inv.get(le["id"], []), money_pay.get(le["id"], []), eom).items():
                    v[k] += amt
            for k in ("ar_1_30", "ar_31_60", "ar_61_90", "ar_90_plus"):
                v[k] = round(v[k], 2)
            out["metrics"][(seg, month)] = v
        for name, uids in types.items():
            rentable = [u for u in uids if u in online or u in rented]
            occ = [u for u in uids if u in rented]
            pool = rentable or uids
            prices = [p for p in (book.at(u, eom) for u in pool) if p is not None]
            in_place = [r for r in (rent_at(rents.get(rented[u]["id"], {}), month, rented[u].get("rent")) for u in occ)
                        if r is not None]
            out["rates"].append({
                "unit_type": name, "month": month,
                "sell_cents": int(round(statistics.median(prices) * 100)) if prices else None,
                "rent_cents": int(round(sum(in_place) / len(in_place) * 100)) if in_place else None,
                "units": len(rentable), "occupied": len(occ),
                "observations": sum(book.count(u, month) for u in uids),
            })
    return out


def activity_from_rows(rows: list[dict]) -> dict:
    """hb_report_rows (one property) -> build()'s `activity`."""
    act = {"prices": [], "insured": set(), "auction": set(), "transfer_in": set(), "transfer_out": set()}
    for r in rows:
        d = r.get("data") or {}
        kind = r.get("kind")
        if kind == "space_activity":
            act["prices"].append((d.get("space_number"), r.get("day"), d.get("space_price")))
        elif kind == "move_in" and (d.get("insurance_premium") or 0) > 0:
            act["insured"].add(r.get("lease_id"))
        elif kind == "move_out" and str(d.get("auction") or "").lower() == "yes":
            act["auction"].add(r.get("lease_id"))
        elif kind == "transfer":
            if d.get("in_lease_id"):
                act["transfer_in"].add(d["in_lease_id"])
            if d.get("out_lease_id"):
                act["transfer_out"].add(d["out_lease_id"])
    return act


# ── Database (blocking) ───────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cols(model, rows) -> list[dict]:
    names = [c.name for c in model.__table__.columns]
    return [{n: getattr(r, n) for n in names} for r in rows]


def rebuild(db, by: str = BY, as_of: str = "") -> list[dict]:
    """Recompute every HB property's months and write them. One summary per site."""
    import uuid

    import ops_unit_classes as uc
    from ops_budget_models import OpsBudgetLoad, OpsMetricMonth
    rules = uc.load(db)
    last_month = ob.add_months(ob.CUBBY_FROM, -1)
    stamp = _now()
    out = []
    for p in db.query(hm.HbProperty).order_by(hm.HbProperty.number).all():
        export_day = as_of or (p.exported_at or "")[:10]
        units = _cols(hm.HbUnit, db.query(hm.HbUnit).filter(hm.HbUnit.property_id == p.id).all())
        leases = _cols(hm.HbLease, db.query(hm.HbLease).filter(hm.HbLease.property_id == p.id).all())
        months = _cols(hm.HbLeaseMonth, db.query(hm.HbLeaseMonth).filter(hm.HbLeaseMonth.property_id == p.id).all())
        acts = activity_from_rows(_cols(hm.HbReportRow, db.query(hm.HbReportRow)
                                        .filter(hm.HbReportRow.property_id == p.id).all()))
        got = build(units, leases, months, acts, export_day=export_day, last_month=last_month, rules=rules)
        p.go_live = got["goLive"]
        metric_rows = 0
        if p.ops_facility_id:
            db.query(OpsMetricMonth).filter(OpsMetricMonth.facility_id == p.ops_facility_id,
                                            OpsMetricMonth.source == SOURCE).delete(synchronize_session=False)
            load_id = str(uuid.uuid4())
            values = [(p.ops_facility_id, seg, month, "actual", k, val)
                      for (seg, month), vals in got["metrics"].items() for k, val in vals.items()]
            metric_rows = ob.upsert(db, values, source=SOURCE, by=by, load_id=load_id, stamp=stamp)
            db.add(OpsBudgetLoad(id=load_id, facility_id=p.ops_facility_id, kind="hummingbird",
                                 file_name="Hummingbird export", months=ob.month_range(got["first"], got["last"]) if got["first"] else [],
                                 rows_written=metric_rows, warnings=got["warnings"], status="ok",
                                 loaded_by=by, loaded_at=stamp))
        else:
            got["warnings"].append("Not matched to an Ops Budget facility, so no Ops Budget months were written.")
        db.query(hm.HbRateMonth).filter(hm.HbRateMonth.property_id == p.id).delete(synchronize_session=False)
        rows = [hm.HbRateMonth(id=f"{p.id}|{r['unit_type']}|{r['month']}", property_id=p.id, built_at=stamp, **r)
                for r in got["rates"]]
        db.add_all(rows)
        db.commit()
        out.append({"propertyId": p.id, "name": p.name, "shortName": p.short_name, "facilityId": p.ops_facility_id,
                    "goLive": got["goLive"], "first": got["first"], "last": got["last"],
                    "units": len(units), "leases": len(leases), "metricRows": metric_rows, "rateRows": len(rows),
                    "warnings": got["warnings"]})
    return out


def property_for(db, short: str):
    s = (short or "").strip().lower()
    if not s:
        return None
    for p in db.query(hm.HbProperty).all():
        if (p.short_name or "").strip().lower() == s:
            return p
    return None


def _usd(c) -> str:
    return "-" if c is None else f"${c / 100:,.2f}"


def rate_history(db, short_name: str, unit_type: str) -> dict:
    """{"points", "log", "first", "last"} for one site and unit type - CMA
    Rate History's Hummingbird months. Points are dated at month-end."""
    p = property_for(db, short_name)
    if p is None:
        return {"points": [], "log": [], "first": "", "last": ""}
    want = norm_type(unit_type)
    rows = [r for r in db.query(hm.HbRateMonth).filter(hm.HbRateMonth.property_id == p.id)
            .order_by(hm.HbRateMonth.month).all() if norm_type(r.unit_type) == want]
    points, log = [], []
    prev = None
    for r in rows:
        points.append({"date": month_end(r.month), "sell": r.sell_cents, "standard": None, "avgRent": r.rent_cents,
                       "occupied": r.occupied, "total": r.units, "marketAvg": None, "marketLow": None,
                       "marketHigh": None, "comps": 0, "source": SOURCE})
        if prev is not None and r.sell_cents is not None and prev != r.sell_cents:
            day = f"{r.month}-01"
            log.append({"at": day, "date": day, "source": SOURCE, "by": "",
                        "text": f"Sell rate {_usd(prev)} -> {_usd(r.sell_cents)}"})
        if r.sell_cents is not None:
            prev = r.sell_cents
    return {"points": points, "log": log, "first": rows[0].month if rows else "", "last": rows[-1].month if rows else ""}


def status(db) -> dict:
    """The admin panel: the last loads and what each site holds."""
    from sqlalchemy import func

    import hb_load
    loads = [hb_load.load_json(r) for r in db.query(hm.HbLoad).order_by(hm.HbLoad.started_at.desc()).limit(5).all()]
    counts = {}
    for model, key in ((hm.HbUnit, "units"), (hm.HbLease, "leases"), (hm.HbLeaseMonth, "leaseMonths"),
                       (hm.HbLead, "leads"), (hm.HbReportRow, "reportRows")):
        for pid, n in db.query(model.property_id, func.count(model.id)).group_by(model.property_id).all():
            counts.setdefault(pid, {})[key] = n
    rate = {pid: (lo, hi, n) for pid, lo, hi, n in db.query(hm.HbRateMonth.property_id, func.min(hm.HbRateMonth.month),
                                                             func.max(hm.HbRateMonth.month),
                                                             func.count(func.distinct(hm.HbRateMonth.unit_type)))
            .group_by(hm.HbRateMonth.property_id).all()}
    sites = []
    for p in db.query(hm.HbProperty).order_by(hm.HbProperty.number).all():
        lo, hi, n = rate.get(p.id, ("", "", 0))
        sites.append({"id": p.id, "name": p.name, "shortName": p.short_name, "number": p.number,
                      "facilityId": p.ops_facility_id or "", "goLive": p.go_live or "", "exportedAt": p.exported_at or "",
                      "first": lo or "", "last": hi or "", "unitTypes": n, **counts.get(p.id, {})})
    return {"loads": loads, "sites": sites, "notProvided": list(NOT_PROVIDED),
            "command": 'python -m hb_load "<folder with the HB JSON files>"'}
