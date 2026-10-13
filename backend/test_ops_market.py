"""Operations -> Market Rates, unit lookup and report exports: the arithmetic
and the matching, on fixed rows. No Cubby, no database, no model call.
Run alone: python -m pytest test_ops_market.py"""
from datetime import date

import cubby
import ops_market

TODAY = date(2026, 10, 13)
NAMES = {"c1": "StorQuest", "c2": "Extra Space", "c3": "Public Storage"}


def _type(name="10' x 20' Storage", w=10, d=20, parking=False, rented=90, vacant=10, street=20000):
    return {"name": name, "width": w, "depth": d, "parking": parking, "total": rented + vacant,
            "rented": rented, "vacant": vacant, "street": street, "rentSum": rented * 19000}


def _obs(cid, cents, on="2026-10-01", w=10, d=20, parking=False, created="1"):
    return {"competitor_id": cid, "width": w, "depth": d, "parking": parking, "rate_cents": cents,
            "observed_on": on, "created_at": created}


def test_a_size_matches_either_way_round_and_parking_is_its_own_market():
    assert ops_market.size_key(10, 20, False) == ops_market.size_key(20, 10, False)
    assert ops_market.size_key(10, 20, False) != ops_market.size_key(10, 20, True)
    assert ops_market.size_key(10, 20, False) != ops_market.size_key(10, 25, False)


def test_the_market_is_each_competitors_newest_fresh_rate():
    obs = [_obs("c1", 18000, "2026-08-01"), _obs("c1", 21000, "2026-10-01"),   # c1 raised its rate
           _obs("c2", 23000), _obs("c3", 15000, "2026-01-05")]                  # c3 is stale
    row = ops_market.compare([_type()], obs, NAMES, TODAY)[0]
    assert (row["competitors"], row["marketLow"], row["marketMedian"], row["marketHigh"]) == (2, 21000, 22000, 23000)
    assert row["lowestBy"] == "StorQuest"


def test_a_removed_competitor_stops_counting():
    obs = [_obs("c1", 21000), _obs("c2", 23000), _obs("gone", 9000)]
    row = ops_market.compare([_type()], obs, NAMES, TODAY)[0]
    assert (row["competitors"], row["marketLow"]) == (2, 21000)


def test_no_suggestion_from_a_single_competitor():
    row = ops_market.compare([_type()], [_obs("c1", 21000)], NAMES, TODAY)[0]
    assert row["suggested"] is None and "one more" in row["why"]
    empty = ops_market.compare([_type()], [], NAMES, TODAY)[0]
    assert empty["suggested"] is None and empty["marketMedian"] is None


def test_the_suggestion_follows_occupancy_and_never_jumps_more_than_ten_percent():
    full, why = ops_market.suggest(20000, 20000, rented=95, vacant=5)
    assert full == 21000 and "nearly full" in why                 # 5% over the market
    healthy, _ = ops_market.suggest(20000, 20000, rented=88, vacant=12)
    assert healthy == 20000
    empty, _ = ops_market.suggest(20000, 20000, rented=50, vacant=50)
    assert empty == 18600                                         # 7% under
    # The market is far above us: step 10%, not all the way.
    capped, why = ops_market.suggest(10000, 20000, rented=95, vacant=5)
    assert capped == 11000 and "10% step" in why


def test_the_monthly_impact_is_counted_on_vacant_units_and_ranks_the_table():
    types = [_type("Small", 5, 5, rented=95, vacant=5, street=10000), _type("Big", 10, 30, rented=60, vacant=40, street=30000)]
    obs = [_obs("c1", 10000, w=5, d=5), _obs("c2", 10000, w=5, d=5),
           _obs("c1", 30000, w=10, d=30), _obs("c2", 30000, w=10, d=30)]
    rows = ops_market.compare(types, obs, NAMES, TODAY)
    assert [r["name"] for r in rows] == ["Big", "Small"]           # the bigger money first
    big = rows[0]
    assert big["suggested"] == 27900 and big["change"] == -2100 and big["monthlyImpact"] == -2100 * 40
    assert rows[1]["monthlyImpact"] == 500 * 5


# ── lookup and report exports ────────────────────────────────────────────────

def _pulled():
    fac = {"facilityId": "fac_1", "name": "Greens Storage Temecula"}
    rr = [
        {"unitId": "u1", "unitName": "B211", "status": "RENTED", "pricingGroupName": "10' x 20' ", "width": 10, "depth": 20,
         "standardRate": 20000, "monthlyRentalAmount": 18000, "customerId": "cust_1", "customerName": "Pat Example",
         "paidThroughDate": "2026-09-30", "moveInDate": "2025-01-15", "autoPayEnabled": False, "overlockApplied": True,
         "contact": {"email": "pat@example.com", "phone": "+15555550100"}},
        {"unitId": "u2", "unitName": "B212", "status": "VACANT", "pricingGroupName": "10' x 20' ", "width": 10, "depth": 20,
         "standardRate": 20000, "overlockApplied": False},
        {"unitId": "u3", "unitName": "AB21", "status": "RENTED", "pricingGroupName": "5' x 5'", "width": 5, "depth": 5,
         "standardRate": 6000, "monthlyRentalAmount": 6000, "customerId": "cust_2", "customerName": "Lee Sample",
         "paidThroughDate": "2026-10-31", "moveInDate": "2024-06-01", "autoPayEnabled": True, "overlockApplied": False},
    ]
    recv = [{"unitId": "u1", "unitName": "B211", "pricingGroupName": "10' x 20' ", "customerName": "Pat Example",
             "totalAmount": 14450, "ranges": [{"range": "RANGE_0_30", "amount": 14450}]}]
    return {"facilities": [fac], "raw": [{"today": TODAY, "rent_roll": rr, "receivables": recv}]}


def _with_rows(monkeypatch):
    p = _pulled()
    monkeypatch.setattr(cubby, "_rows", lambda: list(zip(p["facilities"], p["raw"])))


def test_lookup_finds_a_unit_from_its_start_and_a_tenant_by_name(monkeypatch):
    _with_rows(monkeypatch)
    assert [r["unit"] for r in cubby.lookup("b21")] == ["B211", "B212"]      # not AB21
    hit = cubby.lookup("B211")[0]
    assert (hit["status"], hit["tenant"], hit["balance"], hit["overlocked"]) == ("rented", "Pat Example", 14450, True)
    assert [r["unit"] for r in cubby.lookup("sample")] == ["AB21"]
    vacant = cubby.lookup("b212")[0]
    assert (vacant["status"], vacant["tenant"], vacant["url"]) == ("vacant", "", "")
    assert cubby.lookup("b") == []                                           # one letter is not a search


def test_reports_export_money_and_us_dates_and_no_contact_details(monkeypatch):
    _with_rows(monkeypatch)
    rr = cubby.report("rent-roll")
    assert rr["title"] == "Rent Roll" and rr["asOf"] == "2026-10-13"
    row = dict(zip(rr["columns"], next(r for r in rr["rows"] if r[1] == "B211")))
    assert row["Monthly Rent"] == "180.00" and row["Rent vs Street"] == "-20.00"
    assert row["Paid Through"] == "09/30/2026" and row["Move-In Date"] == "01/15/2025" and row["Balance Due"] == "144.50"
    assert "example.com" not in repr(rr) and "5555550100" not in repr(rr)
    ar = cubby.report("aged-receivables")
    assert dict(zip(ar["columns"], ar["rows"][0]))["0-30 Days"] == "144.50"
    assert cubby.report("rent-roll", "fac_other")["rows"] == []
