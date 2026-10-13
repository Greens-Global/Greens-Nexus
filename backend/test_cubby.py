"""Operations figures (cubby.py): the arithmetic behind the screen, on fixed
rows - no Cubby, no database. Run alone: python -m pytest test_cubby.py"""
from datetime import date

import cubby

FAC = {"facilityId": "fac_1", "name": "Greens Storage Temecula", "timeZone": "America/Los_Angeles"}


def _unit(uid, status, street, rent=None, **extra):
    row = {"unitId": uid, "unitName": uid.upper(), "status": status, "width": 10.0, "depth": 20.0,
           "standardRate": street, "pricingGroupName": "10' x 20' ", "autoPayEnabled": False,
           "overlockApplied": False}
    if status == "RENTED":
        row.update({"customerId": f"cust_{uid}", "customerName": f"Tenant {uid}", "monthlyRentalAmount": rent,
                    "paid": True, "overlockNeeded": False, "paidThroughDate": "2026-10-31", "moveInDate": "2025-01-01"})
    row.update(extra)
    return row


def _raw(**over):
    raw = {
        "today": date(2026, 10, 13),
        "rent_roll": [
            _unit("a1", "RENTED", 20000, 18000, autoPayEnabled=True),
            _unit("a2", "RENTED", 20000, 21000, overlockNeeded=True, paid=False),
            _unit("a3", "RENTED", 20000, 20000, overlockApplied=True, paid=True),
            _unit("a4", "VACANT", 20000),
            _unit("a5", "UNAVAILABLE", 20000),
        ],
        "receivables": [{"customerId": "cust_a2", "customerName": "Tenant a2", "unitName": "A2", "totalAmount": 30000,
                         "ranges": [{"range": "RANGE_0_30", "amount": 21000}, {"range": "RANGE_30_60", "amount": 9000},
                                    {"range": "RANGE_60_90", "amount": 0}]}],
        "units": [{"unitId": "a5", "rentability": {"rentable": False, "unrentableReason": "REPAIRS_REQUIRED", "unrentableReasonNote": "Door"}}],
        "leases": [
            {"customerId": "cust_a1", "unitId": "a1", "moveInDate": "2025-01-01", "moveOutDate": None,
             "coverage": {"coverageType": "ORGANISATION"}, "scheduledMoveOut": {"moveOutDate": "2026-10-20"}},
            {"customerId": "cust_a2", "unitId": "a2", "moveInDate": "2026-10-02", "moveOutDate": None},
            {"customerId": "cust_a3", "unitId": "a3", "moveInDate": "2026-09-10", "moveOutDate": None},
            {"customerId": "cust_old", "unitId": "a4", "moveInDate": "2025-03-01", "moveOutDate": "2026-10-05"},
        ],
        "leads": [{"status": "NEW", "createdAt": "2026-10-01T00:00:00Z", "customerId": "cust_l1"},
                  {"status": "CONVERTED", "createdAt": "2026-09-01T00:00:00Z"},
                  {"status": "DUPLICATE", "createdAt": "2026-09-01T00:00:00Z"}],
        "tasks": [{"title": "Sweep aisle B", "dueDate": "2026-10-10", "unitId": None},
                  {"title": "Check gate", "dueDate": "2026-10-20", "unitId": "a1"}],
        "payments": [{"createdAt": "2026-10-12T09:00:00", "amount": 18000, "status": "SUCCEEDED", "customerId": "cust_a1"},
                     {"createdAt": "2026-09-20T09:00:00", "amount": 5000, "status": "SUCCEEDED", "customerId": "cust_a3"},
                     {"createdAt": "2026-10-11T09:00:00", "amount": 21000, "status": "DECLINED", "reason": "Insufficient funds",
                      "methodType": "CREDIT_CARD", "customerId": "cust_a2"}],
    }
    raw.update(over)
    return raw


def test_units_rent_and_pricing():
    f = cubby.summarize_facility(FAC, _raw())
    assert f["shortName"] == "Temecula"
    assert f["units"] == {"total": 5, "rented": 3, "vacant": 1, "unavailable": 1}
    assert f["area"] == {"total": 1000, "rented": 600}
    assert f["rent"]["rentRoll"] == 59000
    assert f["rent"]["vacantPotential"] == 20000
    # Only a1 is under street; a2 pays more than street and must not offset it.
    assert (f["rent"]["belowStreetGap"], f["rent"]["belowStreetCount"]) == (2000, 1)
    assert f["autoPay"] == 1 and f["protected"] == 1
    assert f["offMarket"] == [{"unit": "A5", "type": "10' x 20'", "reason": "REPAIRS_REQUIRED", "note": "Door", "street": 20000}]


def test_a_comped_unit_is_not_a_rent_increase_candidate():
    raw = _raw()
    raw["rent_roll"].append(_unit("a6", "RENTED", 20000, 0))
    f = cubby.summarize_facility(FAC, raw)
    assert (f["rent"]["belowStreetGap"], f["rent"]["belowStreetCount"]) == (2000, 1)
    assert [r["unit"] for r in f["belowStreet"]] == ["A1"]


def test_past_due_and_locks():
    f = cubby.summarize_facility(FAC, _raw())
    pd = f["pastDue"]
    assert (pd["total"], pd["tenants"]) == (30000, 1)
    assert pd["buckets"]["d0_30"] == 21000 and pd["buckets"]["d30_60"] == 9000
    assert pd["rows"][0]["oldest"] == "d30_60"
    assert pd["rows"][0]["url"].endswith("/tenants/cust_a2")
    assert [r["unit"] for r in f["locks"]["toPlace"]] == ["A2"]
    assert [r["unit"] for r in f["locks"]["toRemove"]] == ["A3"]


def test_moves_history_counts_who_was_in_at_month_end():
    f = cubby.summarize_facility(FAC, _raw())
    assert (f["moves"]["insMtd"], f["moves"]["outsMtd"]) == (1, 1)
    assert [r["unit"] for r in f["moves"]["movingOut"]] == ["A1"]
    by_month = {h["month"]: h for h in f["history"]}
    assert len(f["history"]) == 36 and f["history"][-1]["month"] == "2026-10"
    assert by_month["2026-08"]["rented"] == 2    # a1 and the tenant who has since left
    assert by_month["2026-09"]["rented"] == 3
    assert by_month["2026-10"]["rented"] == 3    # one out, one in


def test_leads_tasks_payments():
    f = cubby.summarize_facility(FAC, _raw())
    assert (f["leads"]["total"], f["leads"]["open"], f["leads"]["converted"]) == (2, 1, 1)
    assert f["leads"]["rows"][0]["tenant"] == ""              # no customer list given: blank, not a crash
    raw = _raw(customers=[{"customerId": "cust_l1", "name": "", "firstName": "Robin", "lastName": "Lead",
                           "contact": {"phone": "+15555550199"}}])
    named = cubby.summarize_facility(FAC, raw)
    assert named["leads"]["rows"][0]["tenant"] == "Robin Lead"
    assert "5555550199" not in repr(named)                    # only the name is taken from the customer list
    assert (f["tasks"]["open"], f["tasks"]["overdue"]) == (2, 1)
    assert f["tasks"]["rows"][0]["title"] == "Sweep aisle B"
    assert f["payments"]["collectedMtd"] == 18000            # September's payment is not this month's
    assert len(f["payments"]["daily"]) == 400
    assert f["payments"]["daily"][-2] == {"date": "2026-10-12", "collected": 18000, "failed": 0}
    assert {"date": "2026-10-05", "ins": 0, "outs": 1} in f["moves"]["daily"]
    assert {"date": "2026-10-02", "ins": 1, "outs": 0} in f["moves"]["daily"]
    assert f["payments"]["failed"][0]["reason"] == "Insufficient funds"


def test_no_contact_details_leave_the_module():
    raw = _raw()
    raw["rent_roll"][0]["contact"] = {"email": "x@example.com", "phone": "+15555550100", "address": "1 Main St"}
    text = repr(cubby.summarize_facility(FAC, raw))
    assert "example.com" not in text and "5555550100" not in text and "1 Main St" not in text


def test_empty_facility_does_not_crash():
    f = cubby.summarize_facility(FAC, {"today": date(2026, 10, 13), "rent_roll": [], "receivables": [], "units": [],
                                       "leases": [], "leads": [], "tasks": [], "payments": []})
    assert f["units"]["total"] == 0 and f["pastDue"]["total"] == 0 and f["unitTypes"] == []


def test_a_tenant_with_two_units_keeps_them_apart():
    raw = _raw()
    # The tenant in A2 (past due, no autopay) also rents A7, which is paid and on autopay.
    raw["rent_roll"].append(_unit("a7", "RENTED", 20000, 20000, customerId="cust_a2", customerName="Tenant a2", autoPayEnabled=True))
    raw["receivables"][0]["unitId"] = "a2"
    f = cubby.summarize_facility(FAC, raw)
    assert f["pastDue"]["rows"][0]["autoPay"] is False          # A2's own setting, not A7's
    assert f["payments"]["failed"][0]["unit"] == "A2, A7"       # the payment row names the tenant only


def test_a_facility_carries_its_map_position_for_the_nearby_search():
    f = cubby.summarize_facility({**FAC, "latitude": 33.5, "longitude": -117.15}, _raw())
    assert (f["lat"], f["lng"]) == (33.5, -117.15)
    bare = cubby.summarize_facility(FAC, _raw())
    assert bare["lat"] is None and bare["lng"] is None
