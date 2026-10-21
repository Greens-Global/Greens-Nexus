"""Operations > Ops Budget: actuals derived from the synced Cubby tables
(ops_budget_cubby.py) - segment rule, month-end snapshot, transfers, lead
marks, and the job writing ops_metric_month with Cubby winning from Sep 2026.
Nothing here calls Cubby. Run alone: python -m pytest test_ops_budget_cubby.py"""
from datetime import date

import pytest

import database
import models
import ops_budget as ob
import ops_budget_cubby as oc
from database import SessionLocal
from ops_budget_models import OpsBudgetFacility, OpsBudgetLeadMark, OpsBudgetLoad, OpsMetricMonth

FID = "cub-esc"


def rr(uid, group, status="RENTED", w=10, d=10, std=10000, autopay=False, gid=""):
    return {"unitId": uid, "unitName": f"U{uid}", "pricingGroupName": group, "pricingGroupId": gid, "status": status,
            "width": w, "depth": d, "standardRate": std, "autoPayEnabled": autopay, "customerName": "Never Stored"}


RENT_ROLL = [
    rr("1", "10' x 10' Storage - Interior", autopay=True, gid="g1"),
    rr("2", "10' x 10' Storage - Interior", gid="g1"),
    rr("3", "10' x 10' Storage - Interior", status="VACANT", gid="g1"),
    rr("4", "10' x 20' Storage - Drive Up", status="UNRENTABLE", w=10, d=20),    # off market: not rentable
    rr("5", "12' x 30' Parking - Uncovered", w=12, d=30, std=15000, autopay=True),
    rr("6", "0' x 3' mailbox", w=0, d=3, std=1500),
    rr("7", "0' x 0' Deactivated", std=0),
    rr("8", "Other", std=5000),
]


def test_segment_rule():
    assert oc.segment_of("10' x 10' Storage - Interior") == "self_storage"
    assert oc.segment_of("Vehicle Storage - Parking Covered") == "vehicle"
    assert oc.segment_of("12' x 30' Parking - Uncovered") == "vehicle"
    assert oc.segment_of("0' x 3' mailbox") is None
    assert oc.segment_of("Storage - Deactivated") is None
    assert oc.segment_of("Other") is None


def test_month_end_snapshot_values():
    recs = [{"unitId": "1", "ranges": [{"range": "RANGE_0_30", "amount": 4820}, {"range": "RANGE_30_60", "amount": 1640}]},
            {"unitId": "5", "ranges": [{"range": "RANGE_90_120", "amount": 100}, {"range": "RANGE_120_PLUS", "amount": 190},
                                       {"range": "RANGE_UNKNOWN", "amount": 999}]},
            {"unitId": "6", "ranges": [{"range": "RANGE_0_30", "amount": 500}]}]          # a mailbox: nowhere
    web = {("g1", "10' x 10' Storage - Interior"): 9000}
    v = oc.snapshot_values(RENT_ROLL, recs, web)
    ss, vs = v["self_storage"], v["vehicle"]
    assert ss["total_units"] == 3 and ss["occupied_units"] == 2 and ss["autopay_tenants"] == 1
    assert ss["total_sqft"] == 300 and ss["occupied_sqft"] == 200
    assert ss["gpr"] == 300 and ss["avg_standard_rate"] == 100 and ss["avg_web_rate"] == 90
    assert ss["ar_1_30"] == 48.2 and ss["ar_31_60"] == 16.4 and ss["ar_61_90"] == 0 and ss["ar_90_plus"] == 0
    assert vs["total_units"] == 1 and vs["occupied_sqft"] == 360 and vs["avg_web_rate"] is None
    assert vs["ar_90_plus"] == 2.9                                                       # unknown range left out


def test_a_segment_the_site_lacks_is_blank_not_zero():
    v = oc.snapshot_values([rr("1", "Storage 5x5")], [], {})
    assert v["vehicle"]["total_units"] is None and v["vehicle"]["avg_standard_rate"] is None


def test_flows_exclude_transfers_count_insurance_and_square_feet():
    leases = [
        {"unitId": "1", "customerId": "a", "moveInDate": "2026-10-03", "coverage": {"premiumAmount": 1200}},
        {"unitId": "2", "customerId": "b", "moveInDate": "2026-10-05", "coverage": {"premiumAmount": 0}},
        # c transfers from unit 3 into unit 2's neighbor on the same day - neither side counts
        {"unitId": "3", "customerId": "c", "moveInDate": "2025-01-01", "moveOutDate": "2026-10-10"},
        {"unitId": "4", "customerId": "c", "moveInDate": "2026-10-10"},
        {"unitId": "5", "customerId": "d", "moveInDate": "2024-01-01", "moveOutDate": "2026-10-20"},
        {"unitId": "6", "customerId": "e", "moveInDate": "2026-10-01"},                 # mailbox: nowhere
    ]
    out = oc.flow_values(["2026-10"], RENT_ROLL, leases, [], {}, {})
    ss, vs = out[("self_storage", "2026-10")], out[("vehicle", "2026-10")]
    assert ss["move_ins"] == 2 and ss["move_outs"] == 0 and ss["insured_rentals"] == 1
    assert ss["sqft_moved_in"] == 200
    assert vs["move_outs"] == 1 and vs["sqft_moved_out"] == 360


def test_lead_marks_reservations_and_conversions():
    # First run in Oct: L1 created in Oct and reserved now; L2 created in Aug, already converted -> 'before'.
    leads = [{"leadId": "L1", "status": "RESERVATION", "createdAt": "2026-10-02T10:00:00Z"},
             {"leadId": "L2", "status": "CONVERTED", "createdAt": "2026-08-02T10:00:00Z"},
             {"leadId": "L3", "status": "DUPLICATE", "createdAt": "2026-10-04T10:00:00Z"},
             {"leadId": "L4", "status": "NEW", "createdAt": "2026-10-05T10:00:00Z", "unitId": "5"}]
    marks = oc.update_marks({}, leads, "2026-10")
    assert marks["L1"]["reserved"] == "2026-10" and marks["L2"]["converted"] == "before"
    # Next month L1 moves in, L4 reserves.
    leads2 = [{**leads[0], "status": "CONVERTED"}, leads[1], leads[2], {**leads[3], "status": "RESERVATION"}]
    marks2 = oc.update_marks(marks, leads2, "2026-11")
    assert marks2["L1"] == {"created": "2026-10", "reserved": "2026-10", "converted": "2026-11"}
    out = oc.flow_values(["2026-10", "2026-11"], RENT_ROLL, [], leads2, marks2, {})
    assert out[("self_storage", "2026-10")]["leads"] == 1          # L1 only: L3 is a duplicate, L4 is vehicle
    assert out[("vehicle", "2026-10")]["leads"] == 1
    assert out[("self_storage", "2026-10")]["reservations"] == 1
    assert out[("self_storage", "2026-11")]["reservations_converted"] == 1
    assert out[("vehicle", "2026-11")]["reservations"] == 1


# ── The job, on the tables ───────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean():
    models.Base.metadata.create_all(bind=database.engine)
    db = SessionLocal()
    for t in (OpsMetricMonth, OpsBudgetLoad, OpsBudgetLeadMark, OpsBudgetFacility, models.CubbyFacility,
              models.CubbyUnit, models.CubbyRental, models.CubbyLead, models.CubbyReceivable, models.CubbyPricingGroup):
        db.query(t).delete()
    db.commit()
    db.close()
    yield


def _seed(db):
    db.add(models.CubbyFacility(facility_id=FID, name="Greens Storage Escondido", time_zone="America/Los_Angeles", enabled=True))
    for r in RENT_ROLL:
        db.add(models.CubbyUnit(id=f"{FID}:{r['unitId']}", facility_id=FID, unit_id=r["unitId"], status=r["status"],
                                data={"rentRoll": r, "unit": None}))
    db.add(models.CubbyRental(id=f"{FID}:L1", facility_id=FID, lease_id="L1", unit_id="1", customer_id="a",
                              move_in_date="2026-09-12", data={"unitId": "1", "customerId": "a", "moveInDate": "2026-09-12",
                                                               "coverage": {"premiumAmount": 900}}))
    db.add(models.CubbyRental(id=f"{FID}:L2", facility_id=FID, lease_id="L2", unit_id="2", customer_id="b",
                              move_in_date="2026-10-02", data={"unitId": "2", "customerId": "b", "moveInDate": "2026-10-02"}))
    db.add(models.CubbyReceivable(id=f"{FID}:1:a", facility_id=FID, unit_id="1", customer_id="a", total_cents=1000,
                                  data={"unitId": "1", "ranges": [{"range": "RANGE_0_30", "amount": 1000}]}))
    db.add(models.CubbyPricingGroup(id=f"{FID}:g1", facility_id=FID, pricing_group_id="g1",
                                    name="10' x 10' Storage - Interior", web_cents=9000, standard_cents=10000, active=True))
    db.commit()


def test_the_job_writes_this_month_and_rebuilds_flows_from_sep_2026():
    db = SessionLocal()
    try:
        _seed(db)
        links = oc._facility_links(db)
        assert [(f.id, c.facility_id) for f, c in links] == [("escondido", FID)]
        fac, cf = links[0]
        oc.run_facility(db, fac, cf, date(2026, 10, 21), None)
        db.commit()
        q = db.query(OpsMetricMonth).filter_by(facility_id="escondido", source="cubby_api", scenario="actual")

        def get(seg, mo, k):
            row = q.filter_by(segment=seg, month=f"{mo}-01", metric=k).first()
            return "absent" if row is None else row.value
        assert get("self_storage", "2026-10", "occupied_units") == 2
        assert get("self_storage", "2026-10", "avg_web_rate") == 90
        assert get("self_storage", "2026-10", "ar_1_30") == 10
        assert get("self_storage", "2026-10", "move_ins") == 1
        assert get("self_storage", "2026-09", "move_ins") == 1 and get("self_storage", "2026-09", "insured_rentals") == 1
        assert get("self_storage", "2026-09", "occupied_units") == "absent"     # a past month-end is never invented
        assert get("self_storage", "2026-08", "move_ins") == "absent"           # before Cubby: the workbook's
        assert get("vehicle", "2026-10", "total_units") == 1
        assert db.get(OpsBudgetFacility, "escondido").cubby_facility_id == FID
        log = db.get(OpsBudgetLoad, "cubby:escondido:2026-10")
        assert log is not None and log.kind == "cubby" and log.rows_written > 0

        # A month later the October snapshot stays as it was; November gets its own.
        db.query(models.CubbyUnit).filter_by(unit_id="3").delete()
        db.commit()
        oc.run_facility(db, fac, cf, date(2026, 11, 2), None)
        db.commit()
        assert get("self_storage", "2026-10", "total_units") == 3
        assert get("self_storage", "2026-11", "total_units") == 2

        # Precedence in the report: Cubby's move-ins for Sep win over the workbook's.
        ob.upsert(db, [("escondido", "self_storage", "2026-09", "actual", "move_ins", 7),
                       ("escondido", "self_storage", "2026-09", "actual", "rental_income", 5000)],
                  source="workbook", by="t")
        db.commit()
        rep = ob.report_for(db, fac, "self_storage", "2026-09", "month")
        mi = next(m for m in rep["metrics"] if m["key"] == "move_ins")
        inc = next(m for m in rep["metrics"] if m["key"] == "rental_income")
        assert mi["actual"] == 1 and mi["source"] == "cubby_api" and mi["otherSource"] == 7
        assert inc["actual"] == 5000 and inc["source"] == "workbook"
    finally:
        db.close()


def test_snapshot_all_runs_each_site_on_its_own():
    db = SessionLocal()
    try:
        _seed(db)
    finally:
        db.close()
    out = oc.snapshot_all()
    assert set(out) == {"escondido"} and "error" not in out["escondido"]
