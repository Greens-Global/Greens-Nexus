"""Operations > Pricing Insights: the pricing sync (cubby_pricing.py - change
history only on change, tracked rent increases, read-only Cubby calls) and the
insights engine (ops_insights.py - each rule on synthetic rows, ranking, the
StorTrack notice, the endpoint). Cubby is faked - nothing here calls it, and
the fake FAILS the test on any Cubby call that is not a read.

Runs on the throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_ops_insights.py
"""
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import cubby_pricing
import cubby_sync
import models
import ops_insights as oi
import ops_rate_mgmt
from auth import get_current_user
from database import SessionLocal

TODAY = date(2026, 10, 20)
FAC = {"id": "fac_e", "name": "Greens Storage Escondido", "shortName": "Escondido", "asOf": "2026-10-20",
       "units": {"total": 20, "rented": 18, "vacant": 2, "unavailable": 0}, "area": {"total": 2000},
       "rent": {"rentRoll": 300000}, "pastDue": {"total": 0, "tenants": 0, "rows": []}}


def _days(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def group(gid="pg_1010", name="10' x 10' Climate", w=10, d=10, std=19900, **over):
    return {"pricingGroupId": gid, "name": name, "width": w, "depth": d, "area": w * d, "parking": False,
            "climate": True, "standard": std, "web": std - 500, "walkIn": std, "strike": None,
            "valuePricingStatus": "NOT_CONFIGURED", "discountIds": [], "lastChangedAt": "", "firstSeenAt": "2026-09-01T00:00:00+00:00",
            **over}


def raw_for(gid="pg_1010", total=20, rented=19, rent=15000, street=19900, leases=None, receivables=None):
    """A rent roll of `total` units in one group, the first `rented` rented."""
    rr, units = [], []
    for i in range(total):
        uid = f"u{i}"
        units.append({"unitId": uid, "pricingGroupId": gid})
        row = {"unitId": uid, "unitName": f"A{i}", "pricingGroupName": "10' x 10' Climate", "standardRate": street,
               "status": "RENTED" if i < rented else "VACANT"}
        if i < rented:
            row.update({"monthlyRentalAmount": rent, "customerId": f"c{i}", "customerName": f"Tenant {i}",
                        "moveInDate": "2024-06-01"})
        rr.append(row)
    return {"today": TODAY, "rent_roll": rr, "units": units, "leases": leases or [], "receivables": receivables or []}


def obs(cid, rate, day=None, w=10, d=10, climate=None, created="1"):
    return {"competitor_id": cid, "width": w, "depth": d, "parking": False, "rate_cents": rate,
            "observed_on": day or _days(2), "created_at": created, "climate": climate, "source": "stortrack"}


COMPS = {"c1": {"name": "Extra Space", "address": "1 A St", "distanceMiles": 1.2},
         "c2": {"name": "Prime Storage", "address": "2 B St", "distanceMiles": 2.5},
         "c3": {"name": "Storage Outlet", "address": "3 C St", "distanceMiles": 4.0}}


def rows_for(raw, groups, observations=(), comps=COMPS):
    return oi.attach_market(oi.group_stats(groups, raw, TODAY), list(observations),
                            {k: v["name"] for k, v in comps.items()}, TODAY)


# ── Labels ───────────────────────────────────────────────────────────────────

def test_size_labels_read_like_cubbys_market_insights():
    assert oi.size_label(10, 10, False, True) == "10x10 CC"
    assert oi.size_label(10, 5, False, False) == "5x10 NCC"
    assert oi.size_label(12, 30, True, None) == "12x30 Parking"
    assert oi.column_key(20, 10, False, None) == oi.column_key(10, 20, False, None) == "S:10x20:any"


# ── Group stats and Cubby's Standard Rates chips ─────────────────────────────

def test_group_stats_counts_units_and_moves_from_the_leases():
    leases = [{"leaseId": f"l{i}", "unitId": f"u{i}", "pricingGroupId": "pg_1010", "moveInDate": _days(2)} for i in range(5)]
    leases.append({"leaseId": "lx", "unitId": "u9", "moveInDate": "2024-01-01", "moveOutDate": _days(20)})
    [r] = rows_for(raw_for(leases=leases), [group()])
    assert (r["total"], r["rented"], r["vacant"]) == (20, 19, 1)
    assert r["occupancy"] == 0.95
    assert (r["ins7"], r["outs7"], r["net7"], r["ins30"], r["outs30"]) == (5, 0, 5, 5, 1)
    assert r["perSqFt"] == 199 and r["label"] == "10x10 CC"
    assert "move-in-spike" in r["flags"] and "no-move-ins" not in r["flags"]
    [i] = [x for x in oi.chip_insights(FAC, [r]) if x["kind"] == "move-in-spike"]
    assert i["severity"] == "medium" and "5 net move-ins in the last 7 days (5 in, 0 out)" in i["detail"]
    assert i["link"]["filters"] == {"insight": "move-in-spike"}


def test_move_out_spike_low_occupancy_and_no_move_ins():
    leases = [{"leaseId": f"l{i}", "unitId": f"u{i}", "moveInDate": "2024-01-01", "moveOutDate": _days(1)} for i in range(4)]
    [r] = rows_for(raw_for(total=10, rented=5, leases=leases), [group()])
    kinds = {i["kind"]: i for i in oi.chip_insights(FAC, [r])}
    assert kinds["move-out-spike"]["severity"] == "high" and "4 net move-outs" in kinds["move-out-spike"]["detail"]
    assert "50% full (5 of 10 units, 5 vacant)" in kinds["low-occupancy"]["detail"]
    assert kinds["no-move-ins"]["severity"] == "medium"          # 5 vacant
    assert kinds["low-occupancy"]["title"] == "10x10 CC Only 50% Full"


def test_mailboxes_and_excluded_groups_raise_no_chips():
    [r] = rows_for(raw_for(total=10, rented=1), [group(name="Mailbox Small")])
    assert r["kind"] == "mailbox" and oi.chip_insights(FAC, [r]) == []


# ── Market position (ops_market.compare, the one rule) ───────────────────────

def test_below_market_while_full_is_room_to_raise():
    o = [obs("c1", 22000, climate=True), obs("c2", 23000, climate=True), obs("c3", 24000, climate=True)]
    [r] = rows_for(raw_for(rented=19, street=19900), [group(std=19900)], o)
    assert r["marketMedian"] == 23000 and r["competitors"] == 3
    [i] = oi.market_insights(FAC, [r])
    assert i["severity"] == "high" and i["title"] == "10x10 CC Below Market at 95% Full"
    assert "13% below the market median ($199 vs $230, 3 competitors) while 95% full: room to raise." in i["detail"]


def test_above_market_with_vacancy_and_above_market_full_hold():
    o = [obs("c1", 16000), obs("c2", 17000), obs("c3", 18000)]
    [r] = rows_for(raw_for(rented=10), [group(std=19900)], o)
    [i] = oi.market_insights(FAC, [r])
    assert i["severity"] == "high" and "17% above the market median ($199 vs $170" in i["detail"] and "10 vacant (50% full)" in i["detail"]
    [r] = rows_for(raw_for(rented=19), [group(std=19900)], o)
    [i] = oi.market_insights(FAC, [r])
    assert i["severity"] == "low" and i["title"].endswith(": Hold")


def test_one_competitor_is_not_a_market():
    [r] = rows_for(raw_for(rented=19), [group(std=19900)], [obs("c1", 30000)])
    assert oi.market_insights(FAC, [r]) == [] and r["target"] is None


def test_large_increase_indicated_uses_the_uncapped_market_target():
    o = [obs("c1", 30000), obs("c2", 31000), obs("c3", 32000)]
    [r] = rows_for(raw_for(rented=19), [group(std=19900)], o)
    # Suggested is held to a 10% step; the target behind the chip is not.
    assert r["suggested"] == 21900 and r["target"] == 32600 and r["targetGap"] > 0.2
    assert "large-increase" in r["flags"]
    [i] = [x for x in oi.chip_insights(FAC, [r]) if x["kind"] == "large-increase"]
    assert "$326" in i["detail"] and "$199" in i["detail"]


# ── Competitor moves ─────────────────────────────────────────────────────────

def test_a_competitor_cut_of_15_percent_in_the_last_week_is_high():
    o = [obs("c1", 20000, _days(20), climate=True), obs("c1", 16000, _days(3), climate=True),
         obs("c2", 20000, _days(20)), obs("c2", 19000, _days(1)),                       # 5%: not a move
         obs("c3", 20000, _days(40)), obs("c3", 15000, _days(12))]                       # too long ago
    moves = oi.competitor_moves(o, COMPS, TODAY)
    assert [(m["competitor"], m["change"]) for m in moves] == [("Extra Space", -0.2)]
    [i] = oi.move_insights(FAC, moves)
    assert i["severity"] == "high" and i["title"] == "Extra Space Cut 10x10 CC 20%"
    assert "from $200 to $160 (-20.0%) on 10/17/2026" in i["detail"]


# ── Competitive grid and trends ──────────────────────────────────────────────

def test_competitive_grid_rows_counts_and_colors():
    o = [obs("c1", 22000, climate=True), obs("c2", 24000), obs("c1", 9000, w=5, d=5, climate=False)]
    rows = rows_for(raw_for(), [group(std=19900)], o)
    grid = oi.competitive([{"facilityId": "fac_e", "facility": "Escondido", "rows": rows, "main": True}], o, COMPS, TODAY)
    cols = {c["key"]: c for c in grid["columns"]}
    # Prime Storage's 10x10 does not say CC; we have one 10x10 variant, so it lands there.
    assert cols["S:10x10:cc"]["competitors"] == 2 and cols["S:10x10:cc"]["median"] == 23000
    assert cols["S:5x5:ncc"]["label"] == "5x5 NCC"
    ours = grid["rows"][0]
    assert ours["kind"] == "ours" and ours["cells"]["S:10x10:cc"]["rate"] == 19900
    assert ours["cells"]["S:10x10:cc"]["vsMarket"] == round(19900 / 23000 - 1, 4)
    assert [r["name"] for r in grid["rows"][1:]] == ["Extra Space", "Prime Storage"]


def test_trends_compare_with_1_7_30_days_ago_from_both_histories():
    o = [obs("c1", 20000, _days(40)), obs("c1", 22000, _days(3)), obs("c2", 20000, _days(40))]
    rows = rows_for(raw_for(), [group(std=19900)], o)
    ours = [{"facilityId": "fac_e", "facility": "Escondido", "rows": rows}]
    grid = oi.competitive(ours, o, COMPS, TODAY)
    now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
    hist = {("pg_1010", "standardRate"): [{"old": 18000, "new": 19900, "changedAt": (now - timedelta(days=5)).isoformat()}]}
    t = oi.trends(ours, hist, o, COMPS, grid["columns"], TODAY, now.isoformat())
    key = "S:10x10:cc"
    assert t["my"][key] == 19900 and t["competitors"][key] == 21000
    assert t["myChange"]["1"][key] == 0.0 and t["myChange"]["7"][key] == round(19900 / 18000 - 1, 4)
    assert t["competitorChange"]["1"][key] == 0.0 and t["competitorChange"]["7"][key] == 0.05


def test_rate_at_reads_the_old_value_of_the_first_later_change():
    ch = [{"old": 100, "new": 120, "changedAt": "2026-10-10"}, {"old": 120, "new": 150, "changedAt": "2026-10-15"}]
    assert oi.rate_at(150, ch, "2026-10-01") == 100
    assert oi.rate_at(150, ch, "2026-10-12") == 120
    assert oi.rate_at(150, ch, "2026-10-19") == 150


# ── ECRI ─────────────────────────────────────────────────────────────────────

def test_ecri_candidates_scheduled_early_and_survival():
    raw = raw_for(total=4, rented=4, rent=15000, street=19900)
    raw["rent_roll"][1]["moveInDate"] = "2026-06-01"                       # 4 months in
    raw["leases"] = [
        {"leaseId": "l0", "unitId": "u0", "moveInDate": "2024-06-01"},
        {"leaseId": "l1", "unitId": "u1", "moveInDate": "2026-06-01", "rentChangeScheduledDate": "2026-11-15",
         "rentChangeNewRentAmount": 16500},
        {"leaseId": "l2", "unitId": "u2", "moveInDate": "2024-06-01"},
        {"leaseId": "l3", "unitId": "u3", "moveInDate": "2024-06-01"},
        # Six tenants raised in July; two moved out inside 60 days.
        *[{"leaseId": f"j{i}", "unitId": f"x{i}", "moveInDate": "2023-01-01",
           "moveOutDate": "2026-08-10" if i < 2 else None} for i in range(6)],
    ]
    tracked = [{"leaseId": f"j{i}", "effective": "2026-07-01", "old": 10000, "new": 11000} for i in range(6)]
    e = oi.ecri(raw, tracked, [], TODAY)
    assert e["candidateCount"] == 3 and e["upside"] == 3 * 4900          # u0, u2, u3; u1 is scheduled
    assert e["candidates"][0]["tenant"] and "phone" not in e["candidates"][0] and "email" not in e["candidates"][0]
    assert [s["unit"] for s in e["scheduled"]] == ["A1"] and e["early"] == 1 and e["scheduledLift"] == 1500
    [jul] = e["survival"]
    assert (jul["month"], jul["increases"], jul["moveOuts"], jul["windowOpen"]) == ("2026-07", 6, 2, False)
    assert jul["revenueGained"] == 4 * 1000
    items = {i["id"].split(":")[-1] if "survival" not in i["id"] else "survival": i for i in oi.ecri_insights(FAC, e, TODAY)}
    assert "bringing them to street adds $147 a month" in items["candidates"]["detail"]
    assert items["candidates"]["link"] == {"tab": "revenue", "facilityId": "fac_e"}
    assert items["scheduled"]["detail"] == "1 increase at Escondido takes effect by 11/15/2026, adding $15 a month."
    assert items["scheduled"]["title"] == "1 Rent Increase Scheduled"
    assert items["early"]["severity"] == "medium"
    assert "2 of 6 tenants" in items["survival"]["detail"] and "07/2026" in items["survival"]["title"]


# ── Revenue at risk, discounts, ranking ─────────────────────────────────────

def test_past_due_concentration_and_vacancy_loss():
    fac = {**FAC, "pastDue": {"total": 40000, "tenants": 7, "rows": [
        {"tenant": f"T{i}", "unit": f"A{i}", "amount": a, "oldest": "d30_60"} for i, a in enumerate((20000, 8000, 4000, 3000, 2000, 2000, 1000))]}}
    rows = rows_for(raw_for(rented=15), [group(std=19900)])
    risk = oi.revenue_risk(fac, rows)
    assert risk["vacancyLoss"] == 5 * 19900 and risk["pastDue"]["top5Share"] == round(37000 / 40000, 4)
    items = {i["id"]: i for i in oi.risk_insights(fac, risk)}
    pd = items["revenue-risk:fac_e:past-due"]
    assert pd["severity"] == "high" and "7 tenants at Escondido owe $400, 13% of the $3,000 monthly rent roll; the top 5 tenants owe 92% of it." == pd["detail"]
    assert "Vacant units at Escondido are $995 a month" in items["revenue-risk:fac_e:vacancy"]["detail"]


def test_move_in_specials_on_full_groups_one_insight_per_facility():
    rows = rows_for(raw_for(rented=19), [group(discountIds=["d1", "d2", "d3"])])
    disc = {"d1": oi.discount_view({"name": "5% Senior 55+", "type": "PERPETUAL", "status": "PUBLISHED", "active": True,
                                    "applicationMethod": "PERCENT_DEDUCTED", "percentage": 5}),
            "d2": oi.discount_view({"name": "Old Promo", "type": "PERIODIC", "status": "ARCHIVED", "active": False}),
            "d3": oi.discount_view({"name": "First Month $1", "type": "PERIODIC", "status": "PUBLISHED", "active": True,
                                    "applicationMethod": "AMOUNT_DEDUCTED", "amount": 18900})}
    [i] = oi.discount_insights(FAC, rows, disc)
    assert i["title"] == "Move-In Specials on 1 Full Unit Type"
    assert i["detail"] == "1 unit type at Escondido is over 90% full and still offers a move-in special: 10' x 10' Climate (95%, First Month $1)."
    assert disc["d1"]["band"] == "5% off" and disc["d3"]["band"] == "$189 off"
    # Affinity discounts alone are a policy, not a price signal.
    rows = rows_for(raw_for(rented=19), [group(discountIds=["d1"])])
    assert oi.discount_insights(FAC, rows, disc) == []


def test_ranking_is_severity_then_money():
    a = oi.insight(FAC, "ecri", "a", "low", "A", "", impact=10**9)
    b = oi.insight(FAC, "ecri", "b", "high", "B", "", impact=1)
    c = oi.insight(FAC, "ecri", "c", "high", "C", "", impact=500)
    assert [i["title"] for i in oi.rank([a, b, c])] == ["C", "B", "A"]


def test_every_insight_text_follows_the_house_style():
    """Title Case titles, US dates, no em dashes, no ISO dates in user text."""
    o = [obs("c1", 20000, _days(20)), obs("c1", 15000, _days(3)), obs("c2", 23000), obs("c3", 24000)]
    leases = [{"leaseId": f"l{i}", "unitId": f"u{i}", "moveInDate": _days(2)} for i in range(5)]
    raw = raw_for(leases=leases)
    b = oi.facility_bundle(FAC, raw, [group()], {}, o, COMPS, {}, [], [], [], TODAY, "2026-10-20T12:00:00+00:00")
    assert b["insights"]
    for i in b["insights"]:
        assert "—" not in i["title"] + i["detail"]
        assert not re.search(r"\d{4}-\d{2}-\d{2}", i["title"] + i["detail"]), i["detail"]
        words = [w for w in i["title"].replace(":", " ").split() if w[0].isalpha()]
        small = {"a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"}
        assert all(w[0].isupper() or w in small for w in words), i["title"]


# ── The pricing sync: change history only on change ──────────────────────────

def test_rate_changes_only_when_a_value_moved():
    old = {"standard_cents": 100, "web_cents": 90, "walk_in_cents": 100, "strike_cents": None}
    assert cubby_pricing.rate_changes(None, {**old}) == []                   # first sighting: no "before"
    assert cubby_pricing.rate_changes(old, {**old}) == []
    assert cubby_pricing.rate_changes(old, {**old, "web_cents": 95}) == [("webRate", 90, 95)]


def test_climate_comes_from_cubbys_features_first():
    assert cubby_pricing.climate_of({"features": ["Not climate controlled"], "name": "10x10 Climate"}) is False
    assert cubby_pricing.climate_of({"features": ["Climate controlled", "Elevator"]}) is True
    assert cubby_pricing.climate_of({"features": [], "parking": True}) is False
    assert cubby_pricing.climate_of({"features": [], "name": "10' x 10'"}) is None


def _clear():
    db = SessionLocal()
    try:
        for t in (models.CubbyPricingGroup, models.CubbyRateHistory, models.CubbyRentChange, models.CubbyDiscount,
                  models.CubbyValuePricingStrategy, models.CubbyRental, models.CubbyFacility, models.CubbyUnit,
                  models.CubbySyncRun, models.CubbyCustomer, models.CubbyLead, models.CubbyReceivable,
                  models.CubbyTask, models.CubbyPayment, models.CubbyDailySnapshot, models.OpsCompetitor,
                  models.OpsCompetitorRate):
            db.query(t).delete()
        db.commit()
    finally:
        db.close()


def _cg(gid, std, web=None, name="10' x 10'"):
    return {"pricingGroupId": gid, "name": name, "width": 10, "depth": 10, "area": 100, "standardRate": std,
            "webRate": web if web is not None else std, "walkInRate": std, "features": ["Climate controlled"],
            "discounts": ["d1"], "availableUnits": 1, "rentableUnits": 1, "valuePricingStatus": "NOT_CONFIGURED"}


def test_write_groups_records_history_only_when_a_rate_moves():
    _clear()
    db = SessionLocal()
    try:
        assert cubby_pricing.write_groups(db, "fac_e", [_cg("g1", 10000), _cg("g2", 20000)], "2026-10-20T01:00:00", "2026-10-19") \
            == {"groups": 2, "changes": 0}
        db.commit()
        cubby_pricing.write_groups(db, "fac_e", [_cg("g1", 10000), _cg("g2", 20000)], "2026-10-20T01:15:00", "2026-10-19")
        db.commit()
        assert db.query(models.CubbyRateHistory).count() == 0
        out = cubby_pricing.write_groups(db, "fac_e", [_cg("g1", 11000, web=10500)], "2026-10-20T01:30:00", "2026-10-19")
        db.commit()
        assert out == {"groups": 1, "changes": 4}                 # standard, web, walk-in on g1; g2 gone
        hist = {(h.pricing_group_id, h.field): (h.old_value, h.new_value) for h in db.query(models.CubbyRateHistory).all()}
        assert hist == {("g1", "standardRate"): (10000, 11000), ("g1", "webRate"): (10000, 10500),
                        ("g1", "walkInRate"): (10000, 11000), ("g2", "active"): (1, 0)}
        g1 = db.get(models.CubbyPricingGroup, "fac_e:g1")
        assert g1.last_changed_at == "2026-10-20T01:30:00" and g1.climate is True and g1.discount_ids == ["d1"]
        assert db.get(models.CubbyPricingGroup, "fac_e:g2").active is False
    finally:
        db.close()


def test_rent_change_plan_tracks_scheduled_applied_and_canceled():
    leases = [{"facilityId": "f", "leaseId": "l1", "unitId": "u1", "monthlyRentalAmount": 10000,
               "rentChangeScheduledDate": "2026-11-01", "rentChangeNewRentAmount": 11000},
              {"facilityId": "f", "leaseId": "l9", "moveOutDate": "2026-10-01",
               "rentChangeScheduledDate": "2026-11-01", "rentChangeNewRentAmount": 11000}]
    adds, ups = cubby_pricing.rent_change_plan({}, leases, "2026-10-20")
    assert [(a["id"], a["old_cents"], a["new_cents"], a["status"]) for a in adds] == [("f:l1:2026-11-01", 10000, 11000, "scheduled")]
    existing = {"f:l1:2026-11-01": {"status": "scheduled", "new_cents": 11000, "effective_date": "2026-11-01"}}
    assert cubby_pricing.rent_change_plan(existing, leases, "2026-10-20") == ([], {})      # unchanged: nothing written
    assert cubby_pricing.rent_change_plan(existing, [], "2026-10-20")[1] == {"f:l1:2026-11-01": {"status": "canceled"}}
    assert cubby_pricing.rent_change_plan(existing, [], "2026-11-02")[1] == {"f:l1:2026-11-01": {"status": "applied"}}


# ── The sync end to end, read-only ───────────────────────────────────────────

def _is_read(url: str) -> bool:
    path = url.rsplit("/v1/", 1)[-1]
    return path.endswith("/search") or path.startswith("reports/")


class FakeHttp:
    """Stands in for httpx.post (cubby_pricing goes through ops_rate_mgmt._call).
    FAILS the test on any Cubby call that is not a read."""

    def __init__(self):
        self.calls, self.groups = [], {"fac_e": [_cg("g1", 10000)]}

    def __call__(self, url, json=None, headers=None, timeout=None, **kw):
        assert _is_read(url), f"Nexus must never write to Cubby, but it called {url}"
        path = url.rsplit("/v1/", 1)[-1]
        self.calls.append((path, json))
        assert path == "pricing-groups/search" and json["where"].get("facilityId")       # scoped, always

        class R:
            status_code = 200
        body = {"data": {"pricingGroups": self.groups.get(json["where"]["facilityId"], []),
                         "discounts": [{"discountId": "d1", "name": "5% Teacher", "type": "PERPETUAL", "active": True,
                                        "status": "PUBLISHED", "applicationMethod": "PERCENT_DEDUCTED",
                                        "applicationPercentage": 5,
                                        "pricingGroups": [{"pricingGroupId": "g1", "name": "10' x 10'", "visibility": "ALL"}]}],
                         "valuePricingStrategies": []}}
        r = R()
        r.json = lambda: body
        return r


def _cubby_post(path, where):
    if path == "organizations/search":
        return {"organizations": [{"organizationId": "org_1", "name": "Greens Storage"}]}
    if path == "facilities/search":
        return {"facilities": [{"facilityId": "fac_e", "name": "Greens Storage Escondido", "timeZone": "America/Los_Angeles"}]}
    if path == "leases/search":
        return {"leases": [{"leaseId": "l1", "unitId": "u1", "customerId": "c1", "moveInDate": "2024-01-01",
                            "monthlyRentalAmount": 10000, "rentChangeScheduledDate": "2026-11-01",
                            "rentChangeNewRentAmount": 11000, "pricingGroupId": "g1"}]}
    if path == "reports/rent-roll":
        return {"entries": [{"unitId": "u1", "unitName": "A1", "status": "RENTED", "standardRate": 10000,
                             "monthlyRentalAmount": 10000, "customerId": "c1", "customerName": "Pat Tenant",
                             "pricingGroupName": "10' x 10'", "width": 10, "depth": 10}]}
    key = {"reports/aged-receivables": "entries", "units/search": "units", "leads/search": "leads",
           "customers/search": "customers", "tasks/search": "tasks", "payments/search": "payments"}[path]
    return {key: [{"unitId": "u1", "pricingGroupId": "g1", "name": "A1"}] if path == "units/search" else []}


@pytest.fixture
def synced(monkeypatch):
    _clear()
    monkeypatch.setenv("CUBBY_API_KEY", "test-key")
    fake = FakeHttp()
    monkeypatch.setattr(ops_rate_mgmt.httpx, "post", fake)     # the httpx module itself: every caller is guarded
    monkeypatch.setattr(cubby, "_post", _cubby_post)
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: TODAY)
    cubby.forget()
    oi.forget()
    return fake


def test_the_sync_stores_pricing_reads_only_and_tracks_changes(synced):
    assert cubby_sync.sync_all("schedule")["status"] == "ok"
    assert synced.calls and all(_is_read("https://x/v1/" + p) for p, _ in synced.calls)
    db = SessionLocal()
    try:
        assert db.get(models.CubbyPricingGroup, "fac_e:g1").standard_cents == 10000
        d = db.get(models.CubbyDiscount, "d1")
        assert d.name == "5% Teacher" and d.percentage == 5 and d.facility_ids == ["fac_e"]
        [rc] = db.query(models.CubbyRentChange).all()
        assert (rc.old_cents, rc.new_cents, rc.status) == (10000, 11000, "scheduled")
        run = db.query(models.CubbySyncRun).first()
        assert run.facilities["fac_e"]["pricing"] == "ok"
    finally:
        db.close()
    # Nothing moved: no history. Then Cubby's rate moves: one row per field that moved.
    cubby_sync.sync_all("manual")
    synced.groups["fac_e"] = [_cg("g1", 12000)]
    db = SessionLocal()
    try:
        db.query(models.CubbySyncRun).delete()
        db.commit()
    finally:
        db.close()
    cubby_sync.sync_all("schedule")
    db = SessionLocal()
    try:
        fields = sorted(h.field for h in db.query(models.CubbyRateHistory).all())
        assert fields == ["standardRate", "walkInRate", "webRate"]
    finally:
        db.close()


def test_a_server_without_the_key_never_calls_cubby_for_pricing(monkeypatch):
    monkeypatch.delenv("CUBBY_API_KEY", raising=False)
    monkeypatch.setattr(ops_rate_mgmt.httpx, "post", lambda *a, **k: pytest.fail("called Cubby"))
    assert cubby_pricing.sync([{"facilityId": "fac_e"}]) == {}


def test_no_write_path_exists_in_the_pricing_engine():
    with pytest.raises(ValueError):
        ops_rate_mgmt._call("pricing-groups/change-rates", {})
    here = Path(__file__).parent
    for name in ("cubby_pricing.py", "ops_insights.py", "routers/ops_insights.py"):
        src = (here / name).read_text(encoding="utf-8")
        code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
        for write in ('"pricing-groups/change-rates"', '"leases/change-rents"', "httpx.post", "_post(", "/cancel\"", "/update\"", "/create\""):
            assert write not in code, f"{name} must not call {write}"


# ── The payload and the endpoint ─────────────────────────────────────────────

def test_payload_without_competitor_rates_says_connect_storTrack_once(synced):
    cubby_sync.sync_all("schedule")
    oi.forget()
    p = oi.payload("")
    assert p["notices"] == [oi.CONNECT]
    assert [i["kind"] for i in p["insights"]].count("setup") == 1
    assert not any(i["kind"] in ("market-position", "competitor-move") for i in p["insights"])
    assert p["overview"]["rows"][0]["facility"] == "Escondido" and p["overview"]["totals"]["facility"] == "Total"
    assert p["facility"] is None
    one = oi.payload("fac_e")
    assert one["facility"]["standardRates"][0]["groupId"] == "g1"
    assert one["facility"]["ecri"]["scheduled"][0]["newRent"] == 11000


def test_payload_with_competitor_rates_has_market_insights(synced):
    cubby_sync.sync_all("schedule")
    db = SessionLocal()
    try:
        for i, rate in enumerate((15000, 16000, 17000)):
            db.add(models.OpsCompetitor(id=f"c{i}", facility_id="fac_e", name=f"Comp {i}", active=True, created_at="1"))
            db.add(models.OpsCompetitorRate(id=f"r{i}", competitor_id=f"c{i}", facility_id="fac_e", width=10, depth=10,
                                            rate_cents=rate, observed_on=_days(2), source="stortrack", created_at=f"{i}"))
        db.commit()
    finally:
        db.close()
    p = oi.payload("fac_e")
    assert p["notices"] == [] and p["market"]["connected"] is True
    kinds = {i["kind"] for i in p["insights"]}
    assert "market-position" in kinds and "setup" not in kinds
    grid = p["facility"]["competitive"]
    assert [r["name"] for r in grid["rows"]] == ["Escondido", "Comp 0", "Comp 1", "Comp 2"]


def test_the_endpoint_is_behind_the_operations_door(synced):
    cubby_sync.sync_all("schedule")
    from routers import ops_insights as router
    app = FastAPI()
    app.include_router(router.router)
    app.dependency_overrides[get_current_user] = lambda: {"email": "m@greensglobal.com", "role": "manager", "level": 3}
    r = TestClient(app).get("/facility-ops/insights?facility_id=fac_e")
    assert r.status_code == 200 and r.json()["facilityId"] == "fac_e"
    app.dependency_overrides[get_current_user] = lambda: {"email": "e@greensglobal.com", "role": "employee", "level": 1}
    assert TestClient(app).get("/facility-ops/insights").status_code in (401, 403)
