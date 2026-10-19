"""Operations > Portfolio (ops_portfolio.py): the Daily Flash arithmetic on
fixed rows - no Cubby, no database. Run alone: python -m pytest test_ops_portfolio.py"""
from datetime import date

import ops_portfolio as op

TODAY = date(2026, 10, 20)


def _rr(uid, status, w=10, d=10, rent=0, group="10x10", **extra):
    row = {"unitId": uid, "unitName": uid.upper(), "status": status, "width": w, "depth": d,
           "pricingGroupName": group, "standardRate": 10000}
    if status == "RENTED":
        row.update({"customerId": f"c_{uid}", "customerName": f"Tenant {uid}", "monthlyRentalAmount": rent})
    row.update(extra)
    return row


def _fac(fid, name, lat="33.49", lng="-117.14"):
    return {"facilityId": fid, "name": f"Greens Storage {name}", "latitude": lat, "longitude": lng}


def _raw(rent_roll, units=(), leases=(), payments=()):
    return {"today": TODAY, "rent_roll": list(rent_roll), "units": list(units),
            "leases": list(leases), "payments": list(payments)}


def _lease(uid, move_in, move_out=""):
    return {"unitId": uid, "customerId": f"c_{uid}", "moveInDate": move_in, "moveOutDate": move_out}


A = op.cubby_property(_fac("fa", "Temecula"), _raw(
    [_rr("a1", "RENTED", 10, 10, 10000), _rr("a2", "RENTED", 10, 20, 20000), _rr("a3", "VACANT", 10, 30),
     _rr("a4", "VACANT", 5, 5), _rr("a5", "UNAVAILABLE", 10, 10), _rr("a6", "UNAVAILABLE", 10, 10),
     _rr("m1", "RENTED", 1, 1, 1500, group="Mailbox"), _rr("m2", "VACANT", 1, 1, group="Mail Box")],
    units=[{"unitId": "a4", "reserved": True},
           {"unitId": "a5", "rentability": {"unrentableReason": "REPAIRS_REQUIRED"}},
           {"unitId": "a6", "rentability": {"unrentableReason": "USED_BY_FACILITY"}}],
    leases=[_lease("a1", "2024-03-10"), _lease("a2", "2026-10-02"), _lease("a3", "2025-01-05", "2026-10-20"),
            _lease("a3", "2023-06-01", "2024-12-15"), _lease("m1", "2026-10-03")],
    payments=[{"createdAt": "2026-10-05T10:00:00", "amount": 10000, "status": "SUCCEEDED", "customerId": "c_a1"},
              {"createdAt": "2026-10-06T10:00:00", "amount": 99999, "status": "DECLINED", "customerId": "c_a2"},
              {"createdAt": "2026-09-16T10:00:00", "amount": 5000, "status": "SUCCEEDED", "customerId": "c_a2"}]))

# A second facility whose history only starts at the cutover (no move-outs on record).
B = op.cubby_property(_fac("fb", "Fairfield", lat="38.25", lng="-122.04"), _raw(
    [_rr("b1", "RENTED", 10, 10, 15000), _rr("b2", "VACANT", 10, 10)],
    leases=[_lease("b1", "2026-10-20")],
    payments=[{"createdAt": "2026-10-10T10:00:00", "amount": 15000, "status": "SUCCEEDED", "customerId": "c_b1"}]))


def test_mailboxes_left_out_of_storage_occupancy():
    assert op.is_mailbox({"pricingGroupName": "Mailbox"}) and op.is_mailbox({"pricingGroupName": "Mail Box - Small"})
    assert not op.is_mailbox({"pricingGroupName": "10x10 Climate"})
    assert A["mailboxesExcluded"] == 2
    assert {u["id"] for u in A["units"]} == {"a1", "a2", "a3", "a4", "a5", "a6"}
    assert all(le["unitId"] != "m1" for le in A["leases"])     # a mailbox move-in is not a storage rental
    out = op.build([A], None, None)
    assert out["total"]["mailboxesExcluded"] == 2
    assert out["total"]["netRentals"]["mtd"] == {"ins": 1, "outs": 1}


def test_occupancy_by_status_and_square_feet():
    out = op.build([A], None, None)
    occ = {r["key"]: r for r in out["total"]["occupancy"]}
    assert occ["occupied"]["units"] == 2 and occ["occupied"]["sqft"] == 300
    assert occ["vacant"]["units"] == 1 and occ["vacant"]["sqft"] == 300
    assert occ["reserved"]["units"] == 1 and occ["reserved"]["sqft"] == 25
    assert occ["damaged"]["units"] == 1 and occ["unrentable"]["units"] == 1
    assert out["total"]["totalSqft"] == 825
    assert occ["occupied"]["sqftPct"] == round(300 / 825 * 100, 2)
    assert occ["occupied"]["unitPct"] == round(2 / 6 * 100, 2)


def test_aggregates_only_the_selected_properties():
    both = op.build([A, B], None, None)
    assert both["selected"] == ["fa", "fb"]
    occ = {r["key"]: r for r in both["total"]["occupancy"]}
    assert occ["occupied"]["units"] == 3 and both["total"]["totalUnits"] == 8
    assert both["total"]["netRentals"]["daily"] == {"ins": 1, "outs": 1}   # b1 moved in, a3 moved out today
    assert both["total"]["collected"]["mtd"] == 25000                     # succeeded payments only
    only_b = op.build([A, B], ["fb"], None)
    assert only_b["selected"] == ["fb"] and only_b["total"]["totalUnits"] == 2
    assert [p["shortName"] for p in only_b["byProperty"]] == ["Fairfield"]
    assert {p["facility"] for p in only_b["total"]["lists"]["units"]} == {"Fairfield"}


def test_square_foot_trend_from_unit_sizes():
    out = op.build([A], None, "2026-10")
    by = {r["month"]: r for r in out["total"]["trend"]}
    assert by["2026-10"]["cy"]["sqftPct"] == round(300 / 825 * 100, 2)          # today, from the rent roll
    # End of Sep 2026: a1 (100) and a3 (300) occupied; a2 moved in Oct 2.
    assert by["2026-09"]["cy"]["sqftPct"] == round(400 / 825 * 100, 2)


def test_prior_year_blank_where_history_is_missing():
    # A's earliest move-out is Dec 15 2024, so its history is complete from Jan 2025.
    assert A["historyFrom"] == "2025-01-01"
    a = op.build([A], None, "2026-10")
    by = {r["month"]: r for r in a["total"]["trend"]}
    assert by["2026-10"]["py"] is not None and by["2026-01"]["py"] is not None
    assert by["2025-12"]["py"] is None and by["2025-11"]["py"] is None        # Dec / Nov 2024: before the history
    assert a["total"]["netRentals"]["priorYear"] == {"ins": 0, "outs": 0}
    # B has no move-out on record: only the cutover is safe, so no prior year at all.
    assert B["historyFrom"] == "2026-10-01"
    both = op.build([A, B], None, "2026-10")
    assert all(r["py"] is None for r in both["total"]["trend"])
    assert both["total"]["netRentals"]["priorYear"] is None
    assert both["total"]["collected"]["priorYear"] is None                   # payments start Sep 15 2026
    assert any("No data before cutover" in n for n in both["notes"])
    # September is only half in Cubby, so its collections are not shown as a month.
    sep = op.build([A], None, "2026-09")
    assert sep["total"]["collected"]["mtd"] is None


def test_no_budget_and_no_ledger_are_said_not_guessed():
    out = op.build([A], None, None, budget=None)
    assert out["budget"]["available"] is False and out["budget"]["note"] == op.NO_BUDGET
    assert all(r["mtd"] is None for r in out["total"]["revenue"])
    assert out["total"]["netRevenue"]["mtd"] is None
    assert op.NO_LEDGER in out["notes"] and op.NO_BUDGET in out["notes"]
    assert op.budget_for(["fa"], "2026-10") is None


def test_ledger_from_another_source_slots_in():
    led = {**B, "id": "cs:1", "shortName": "Austin", "source": "cubesmart", "managedBy": "CubeSmart",
           "ledger": {"2026-10": {"accruedRent": 100, "fees": 10, "insurance": 5, "merchandise": 1, "discount": 20, "writeOffs": 3},
                      "2025-10": {"accruedRent": 90, "fees": 9, "insurance": 4, "merchandise": 0, "discount": 10, "writeOffs": 0}}}
    out = op.build([led], None, "2026-10")
    assert out["total"]["revenueTotal"]["mtd"] == 116
    assert out["total"]["netRevenue"] == {"mtd": 93, "priorYear": 93}
    # Mixed with a Cubby facility (no ledger), the total is not shown rather than undercounted.
    mixed = op.build([A, led], None, "2026-10")
    assert mixed["total"]["revenueTotal"]["mtd"] is None


def test_not_connected_properties_are_listed_never_counted():
    props = [A, dict(op.CUBESMART_PLACEHOLDER)]
    out = op.build(props, None, None)
    meta = {p["id"]: p for p in out["properties"]}
    assert meta["cubesmart:pending"]["status"] == op.NOT_CONNECTED
    assert out["selected"] == ["fa"]
    picked = op.build(props, ["fa", "cubesmart:pending"], None)
    assert picked["notConnected"] == ["CubeSmart-Managed"]
    assert any("not connected yet" in n for n in picked["notes"])
    assert any(p["source"] == "cubesmart" for p in op.third_party_properties())


def test_groups_from_the_map_pin():
    assert A["state"] == "CA" and A["market"] == "Southern California"
    assert B["state"] == "CA" and B["market"] == "Northern California"
    assert op._state({"latitude": "36.17", "longitude": "-115.14"}) == ""        # Las Vegas is not California
    assert op._state({"latitude": "30.27", "longitude": "-97.74"}) == "TX"
