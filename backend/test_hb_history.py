"""Hummingbird history (Oct 21 2026): the loader (hb_load.py) on a small
hand-made export in HB's shapes - every name, contact and id below is FAKE -
the month rebuild (hb_history.py), the Ops Budget precedence and the admin
status endpoint. Run alone: python -m pytest test_hb_history.py"""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
import database
import hb_history as hh
import hb_load
import hb_models as hm
import models
import ops_budget as ob
from database import SessionLocal
from ops_budget_models import OpsBudgetFacility, OpsBudgetLoad, OpsMetricMonth
from routers import ops_budget as router_mod

APP = "appTEST"
FAKE_NAME, FAKE_EMAIL, FAKE_PHONE, FAKE_STREET = "Pat Fakename", "pat.fakename@example.com", "15550100199", "1 Nowhere Lane"
HB_TABLES = (hm.HbRateMonth, hm.HbReport, hm.HbReportRow, hm.HbLead, hm.HbLeaseMonth, hm.HbLease, hm.HbUnit,
             hm.HbProperty, hm.HbLoad)
ADMIN = {"email": "admin@example.com", "level": 4, "role": "administrator"}


@pytest.fixture(autouse=True)
def clean():
    models.Base.metadata.create_all(bind=database.engine)
    db = SessionLocal()
    for t in HB_TABLES + (OpsMetricMonth, OpsBudgetLoad, OpsBudgetFacility):
        db.query(t).delete()
    db.commit()
    db.close()
    yield


def wrap(data):
    return {"status": 200, "body": {"message": "success", "applicationData": {APP: [{"status": 200, "data": data}]}}}


def contact():
    return {"first": "Pat", "last": "Fakename", "email": FAKE_EMAIL, "Phones": [{"phone": FAKE_PHONE}],
            "Addresses": [{"Address": {"address": FAKE_STREET, "city": "Faketown", "zip": "00000"}}]}


def unit(uid, number, w, l, cat, state, price, typ="storage"):
    return {"id": uid, "number": number, "type": typ, "width": str(w), "length": str(l), "state": state,
            "description": f"Held for {FAKE_NAME}",
            "price": price, "set_rate": price + 5, "default_price": price + 5, "Category": {"name": cat + " "},
            "Lease": {"id": "x", "Tenants": [{"Contact": contact()}]}, "Address": {"address": FAKE_STREET}}


def lease(lid, uid, start, end=None, rent=100.0, status=1):
    return {"id": lid, "unit_id": uid, "start_date": start, "end_date": end, "moved_out": end, "rent": rent,
            "status": status, "Standing": {"name": "Lease Closed" if end else "Current"},
            "Unit": {"id": uid, "property_id": "P1", "type": "storage"}, "notes": f"called {FAKE_NAME}",
            "code": "1234", "Tenants": [{"Contact": contact()}], "CreatedBy": {"first": "Staff", "email": "staff@example.com"},
            "Metrics": {"has_autopay": True}}


def invoice(iid, due, amount, balance=0.0, typ="auto", status=1, prem=0.0):
    return {"id": iid, "due": due, "date": due, "period_start": due + " 00:00:00", "type": typ, "status": status,
            "subtotal": amount + prem, "total_tax": 0, "total_discounts": 0, "amount": amount + prem,
            "total_payments": amount + prem - balance, "balance": balance, "address": FAKE_STREET, "city": "Faketown"}


def detail(invoices, payments):
    return {"invoices": wrap({"invoices": invoices}), "ledger": wrap({"ledger": [
        {"date": d + " 00:00:00", "description": "payment", "charges": None, "payments": a, "status": "Successful."}
        for d, a in payments]}), "metrics": wrap({"metrics": {"has_autopay": False}})}


def make_export(tmp_path):
    """Site P1 ("Testville"): 4 storage units + 1 parking + 1 mailbox. HB went
    live Nov 2023 (first move-out Nov 20 2023), so history starts Dec 2023."""
    units = [unit("U1", "A1", 10, 10, "Storage - Interior, Lower", "Leased", 120.0),
             unit("U2", "A2", 10, 10, "Storage - Interior, Lower", "Available", 120.0),
             unit("U3", "A3", 10, 20, "Storage - Drive-Up", "Leased", 200.0),
             unit("U4", "A4", 5, 5, "Storage - Interior, Lower", "Inactive", 50.0),
             unit("U5", "P1", 12, 30, "Parking - Gravel, Drive-In", "Leased", 150.0, "parking"),
             unit("U6", "M1", 0, 3, "mailbox", "Leased", 20.0, "mailbox")]
    active = [lease("L1", "U1", "2023-06-01", rent=110.0), lease("L3", "U3", "2024-01-10", rent=190.0),
              lease("L5", "U5", "2024-01-05", rent=150.0), lease("L6", "U6", "2024-01-05", rent=20.0)]
    closed = [lease("L2", "U2", "2023-05-01", "2023-11-20", rent=100.0),
              lease("L7", "U2", "2024-01-03", "2024-02-15", rent=115.0),   # transferred out to L3? no - plain move-out
              lease("L8", "U4", "2024-01-20", "2024-01-25", rent=50.0),    # transfer-out half
              lease("L0", "U2", "2024-03-01", rent=99.0, status=0)]       # never completed: counts nowhere
    nectar = {"meta": {"generated_at": "2024-03-12T07:00:00Z"},
              "properties": [{"summary": {"id": "P1", "name": " Greens Storage, Testville", "number": "09",
                                          "unit_count": 6, "Address": {"address": FAKE_STREET},
                                          "Phones": [{"phone": FAKE_PHONE}], "Emails": [{"email": FAKE_EMAIL}]},
                              "units": units, "space_groups": {"status": 200, "data": {"spaceGroups": []}}}],
              "leases": active, "tenants": [{"id": "T1", "Contact": contact()}],
              "leads": [{"id": "D1", "property_id": "P1", "created": "2024-01-02 10:00:00", "status": "converted",
                         "source": "Walk-In", "lease_id": "L3", "unit_id": "U3", "note": f"{FAKE_NAME} wants a unit",
                         "content": FAKE_EMAIL, "Contact": contact()}],
              "promotions": [{"id": "PR1", "name": "First Month Free"}]}
    historical = {"meta": {"generated_at": "2024-03-12T07:00:00Z"}, "all_leases": active + closed,
                  "new_historical_lease_details": {
                      "L7": detail([invoice("I71", "2024-01-03", 115.0), invoice("I72", "2024-02-03", 115.0)],
                                   [("2024-01-03", 115.0), ("2024-02-03", 115.0)])}}
    details = {"meta": {}, "lease_details": {
        # L1: Jan paid, Feb unpaid and still open at export -> 1-30 days late at Feb month-end.
        "L1": detail([invoice("I11", "2024-01-01", 110.0), invoice("I12", "2024-02-01", 110.0, balance=110.0)],
                     [("2024-01-02", 110.0)]),
        # L3: insurance on the invoice; rent = subtotal less the premium.
        "L3": detail([invoice("I31", "2024-02-10", 190.0, prem=12.0)], [("2024-02-10", 202.0)]),
        "L5": detail([invoice("I51", "2024-02-05", 150.0)], [("2024-02-05", 150.0)]),
        "L6": detail([], [])}}
    reports = {"meta": {"today": "2024-03-12", "generated_at": "2024-03-12T07:00:00Z"},
               "properties": [{"id": "P1", "name": " Greens Storage, Testville"}],
               "reports": {
                   "management-summary:P1": wrap({"report": {"totalUnits": {"count": 6}},
                                                  "company": {"firstname": "Pat", "lastname": "Fakename"}}),
                   "rental-activity:P1": wrap({"report": {
                       "rentalActivityMoveIn": [
                           {"property_id": "P1", "unit_id": "U3", "lease_id": "L3", "name": FAKE_NAME,
                            "company_name": "Fake Co", "contact_id": "C9", "move_in_date": "2024-01-10",
                            "insurance_premium": 12, "space_rate": 200, "rent": 190}],
                       "rentalActivityMoveOut": [
                           {"property_id": "P1", "unit_id": "U2", "lease_id": "L7", "name": FAKE_NAME,
                            "move_out_date": "2024-02-15", "auction": "Yes", "space_rate": 125}]}}),
                   "space-activity:all": wrap({"report": [
                       {"property_id": "P1", "space_number": "A2", "activity_date": "2023-11-20", "activity": "Move-Out",
                        "space_price": 100.0, "tenant_name": FAKE_NAME, "tenant_rent": 100.0, "lease_id": "L2"},
                       {"property_id": "P1", "space_number": "A2", "activity_date": "2024-01-03", "activity": "Move-In",
                        "space_price": 115.0, "tenant_name": FAKE_NAME, "tenant_rent": 115.0, "lease_id": "L7"}]}),
                   "transfer:P1": wrap({"report": [
                       {"property_id": "P1", "tenant_name": FAKE_NAME, "transfer_date": "2024-01-25",
                        "out_lease_id": "L8", "in_lease_id": "L9", "user_name": "Staff Person", "notes": FAKE_EMAIL}]}),
                   "coverage-details:P1": wrap([
                       {"property_id": "P1", "invoice_id": "I31", "lease_id": "L3", "insurance_premium": 12,
                        "tenant_first_name": "Pat", "tenant_last_name": "Fakename", "tenant_email": FAKE_EMAIL,
                        "tenant_phone": FAKE_PHONE, "tenant_address_1": FAKE_STREET, "invoice_period_start": "2024-02-10"}]),
               }}
    for name, doc in (("greens_storage_nectar_prod_export.json", nectar),
                      ("greens_storage_prod_historical_leases_export.json", historical),
                      ("greens_storage_prod_lease_details.json", details),
                      ("greens_storage_prod_reports_export.json", reports)):
        (tmp_path / name).write_text(json.dumps(doc), encoding="utf-8")
    return hb_load.find_files(str(tmp_path))


def _seed_facility(db):
    db.add(OpsBudgetFacility(id="testville", name="Greens Storage Testville", short_name="Testville", sort_order=9))
    db.commit()


def _load(tmp_path, rebuild=True):
    files = make_export(tmp_path)
    db = SessionLocal()
    _seed_facility(db) if not db.get(OpsBudgetFacility, "testville") else None
    try:
        return hb_load.load(db, files, by="tester@example.com", rebuild=rebuild, log=lambda *_: None)
    finally:
        db.close()


def _metric(db, metric, month, seg="self_storage"):
    r = db.get(OpsMetricMonth, ob.row_id("testville", seg, month, "actual", metric, "hummingbird"))
    return None if r is None else r.value


# ── Privacy ───────────────────────────────────────────────────────────────────

def test_clean_drops_contacts_names_notes_and_codes():
    raw = {"id": "L1", "rent": 10, "notes": "x", "code": "1234", "Tenants": [1], "tenant_name": "x",
           "Contact": {"first": "x"}, "contact_id": "C1", "first": "x", "last": "y", "company_name": "z",
           "Unit": {"number": "A1", "Address": {"address": "x"}, "email": "x"}, "last_payment_date": "2024-01-01",
           "Standing": {"name": "Current"}}
    out = hb_load.clean(raw)
    assert out == {"id": "L1", "rent": 10, "Unit": {"number": "A1"}, "last_payment_date": "2024-01-01",
                   "Standing": {"name": "Current"}}


def test_no_personal_data_reaches_any_table(tmp_path):
    _load(tmp_path)
    db = SessionLocal()
    blob = []
    for model in HB_TABLES:
        for r in db.query(model).all():
            blob.append(json.dumps(hh._cols(model, [r])[0], default=str))
    db.close()
    text = "\n".join(blob)
    for secret in (FAKE_NAME, "Fakename", FAKE_EMAIL, FAKE_PHONE, FAKE_STREET, "Faketown", "Fake Co", "Staff Person",
                   "staff@example.com", "1234\"", "wants a unit"):
        assert secret not in text, secret
    assert "tenant_name" not in text and "contact_id" not in text


# ── Loader ────────────────────────────────────────────────────────────────────

def test_load_writes_every_table_and_a_log(tmp_path):
    out = _load(tmp_path)
    assert out["status"] == "ok" and out["by"] == "tester@example.com"
    c = out["counts"]
    assert c["hb_properties"] == 1 and c["hb_units"] == 6 and c["hb_leases"] == 8 and c["hb_leads"] == 1
    assert c["hb_report_rows"] == 6 and c["hb_lease_months"] >= 5 and c["ops_metric_month"] > 0
    assert {f["name"] for f in out["files"]} >= {"greens_storage_prod_reports_export.json"}
    assert all(len(f["sha256"]) == 64 for f in out["files"])
    db = SessionLocal()
    p = db.get(hm.HbProperty, "P1")
    assert (p.short_name, p.ops_facility_id, p.go_live) == ("Testville", "testville", "2023-11-20")
    u = db.get(hm.HbUnit, "U1")
    assert u.unit_type == "10' x 10' Storage - Interior, Lower" and u.price == 120.0 and u.set_rate == 125.0
    le = db.get(hm.HbLease, "L1")
    assert le.has_autopay == 0 and le.end_date == "" and le.status == 1      # the active lease's detail metrics win
    lm = db.get(hm.HbLeaseMonth, "L3:2024-02")
    assert lm.rent == 190.0 and lm.insurance == 12.0 and lm.charged == 202.0 and lm.paid == 202.0
    db.close()


def test_reloading_replaces_rows_instead_of_adding(tmp_path):
    first = _load(tmp_path)
    second = _load(tmp_path)
    db = SessionLocal()
    assert db.query(hm.HbLease).count() == 8 and db.query(hm.HbReportRow).count() == 6
    assert db.query(hm.HbLoad).count() == 2
    assert first["counts"]["ops_metric_month"] == second["counts"]["ops_metric_month"]
    n = db.query(OpsMetricMonth).filter(OpsMetricMonth.source == "hummingbird").count()
    assert n == first["counts"]["ops_metric_month"]                      # replaced, not doubled
    db.close()


def test_cli_refuses_a_shared_database_without_yes(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@db.example.com:5432/postgres")
    assert hb_load.main(["somewhere"]) == 2
    out = capsys.readouterr().out
    assert "secret" not in out and "db.example.com" in out


# ── The rebuild ───────────────────────────────────────────────────────────────

def test_months_start_after_go_live_and_stop_before_cubby(tmp_path):
    _load(tmp_path)
    db = SessionLocal()
    months = sorted({r.month for r in db.query(OpsMetricMonth).filter(OpsMetricMonth.source == "hummingbird")})
    assert months[0] == "2023-12-01" and months[-1] == "2024-02-01"     # export Mar 12 2024 -> last full month Feb
    db.close()


def test_occupancy_moves_and_segments(tmp_path):
    _load(tmp_path)
    db = SessionLocal()
    # Dec 2023: only L1 in (L2 left Nov 20). Rentable = U1, U2, U3 (U4 is Inactive and empty).
    assert _metric(db, "occupied_units", "2023-12") == 1 and _metric(db, "total_units", "2023-12") == 3
    # Jan 2024: L1, L3, L7 in; L8 came and went (a transfer-out half: not a move-out, but a move-in).
    assert _metric(db, "occupied_units", "2024-01") == 3
    assert _metric(db, "total_units", "2024-01") == 3
    assert _metric(db, "move_ins", "2024-01") == 3 and _metric(db, "move_outs", "2024-01") == 0
    assert _metric(db, "sqft_moved_in", "2024-01") == 100 + 200 + 25
    assert _metric(db, "insured_rentals", "2024-01") == 1
    # Feb: L7 moved out by auction.
    assert _metric(db, "move_outs", "2024-02") == 1 and _metric(db, "liens", "2024-02") == 1
    assert _metric(db, "occupied_sqft", "2024-02") == 100 + 200
    # Parking is vehicle storage; the mailbox counts nowhere.
    assert _metric(db, "occupied_units", "2024-02", "vehicle") == 1
    assert db.query(OpsMetricMonth).filter(OpsMetricMonth.metric == "occupied_units",
                                           OpsMetricMonth.source == "hummingbird").count() == 6   # 3 months x 2 segments
    db.close()


def test_rent_income_rates_and_past_due(tmp_path):
    _load(tmp_path)
    db = SessionLocal()
    # Feb income: L1 110 + L3 190 (202 less 12 insurance) + L7 115.
    assert _metric(db, "rental_income", "2024-02") == 415
    # L1's Feb invoice is still open at export: 28 days late on Feb 29.
    assert _metric(db, "ar_1_30", "2024-02") == 110 and _metric(db, "ar_31_60", "2024-02") == 0
    # Web rate: U1 120, U2 115 (its Jan 3 reading), U3 200 -> average of the rentable units.
    assert _metric(db, "avg_web_rate", "2024-01") == pytest.approx((120 + 115 + 200) / 3)
    for missing in hh.NOT_PROVIDED:
        assert _metric(db, missing, "2024-01") is None
    r = db.get(hm.HbRateMonth, "P1|10' x 10' Storage - Interior, Lower|2024-01")
    assert r.units == 2 and r.occupied == 2 and r.sell_cents == int(round((120 + 115) / 2 * 100))
    assert r.rent_cents == int(round((110 + 115) / 2 * 100)) and r.observations == 1
    assert db.get(hm.HbRateMonth, "P1|10' x 10' Storage - Interior, Lower|2023-12").sell_cents == 11000   # U1 120, U2 100
    db.close()


def test_aging_counts_open_invoices_and_clears_paid_ones_oldest_first():
    inv = [("2024-01-01", 100.0, 0.0), ("2024-02-01", 100.0, 0.0), ("2024-03-01", 100.0, 40.0)]
    pays = [("2024-01-05", 100.0)]
    a = hh.aging(inv, pays, "2024-03-31")
    # Feb's 100 was paid after Mar 31 (FIFO: only Jan was covered) -> 59 days late; Mar's paid part 60 also unpaid then.
    assert a == {"ar_1_30": 100.0, "ar_31_60": 100.0, "ar_61_90": 0.0, "ar_90_plus": 0.0}
    assert hh.aging(inv, pays + [("2024-03-20", 200.0)], "2024-03-31")["ar_1_30"] == 40.0
    assert hh.aging([("2024-03-31", 50.0, 50.0)], [], "2024-03-31") == {k: 0.0 for k in a}   # due today: not late


# ── Ops Budget precedence ─────────────────────────────────────────────────────

def test_hummingbird_beats_the_workbook_before_cubby_and_cubby_wins_after():
    assert ob.resolve({"workbook": 5, "hummingbird": 6}, "move_ins", "2026-08") == (6, "hummingbird", 5)
    assert ob.resolve({"workbook": 5, "hummingbird": None}, "move_ins", "2026-08") == (5, "workbook", None)
    assert ob.resolve({"workbook": 5, "hummingbird": 6, "cubby_api": 7}, "move_ins", "2026-09") == (7, "cubby_api", 5)
    assert ob.resolve({"hummingbird": 6}, "move_ins", "2026-10") == (6, "hummingbird", None)
    assert ob.resolve({"workbook": 2, "hummingbird": 9}, "tows", "2026-01") == (2, "workbook", None)
    assert ob.resolve({"workbook": 3, "hummingbird": 9}, "move_ins", "2026-01", "budget") == (3, "workbook", None)


def test_report_reads_hummingbird_over_the_workbook(tmp_path):
    _load(tmp_path)
    db = SessionLocal()
    ob.upsert(db, [("testville", "self_storage", "2024-02", "actual", "move_outs", 9),
                   ("testville", "self_storage", "2024-02", "actual", "gpr", 900)], source="workbook", by="t")
    db.commit()
    rep = ob.report_for(db, db.get(OpsBudgetFacility, "testville"), "self_storage", "2024-02", "month")
    by = {m["key"]: m for m in rep["metrics"]}
    assert by["move_outs"]["actual"] == 1 and by["move_outs"]["source"] == "hummingbird" and by["move_outs"]["otherSource"] == 9
    assert by["gpr"]["actual"] == 900 and by["gpr"]["source"] == "workbook"     # HB has no GPR: the workbook's stands
    trend = ob.trend_for(db, db.get(OpsBudgetFacility, "testville"), "self_storage", "2024-02", 3)
    assert [round(p["unit_occupancy"], 4) for p in trend["points"]] == [round(1 / 3, 4), 1.0, round(2 / 3, 4)]
    db.close()


# ── Admin status endpoint ─────────────────────────────────────────────────────

def _client(user):
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[auth.get_current_user] = lambda: user
    return TestClient(app)


def test_status_is_admin_only_and_lists_each_site(tmp_path):
    _load(tmp_path)
    r = _client(ADMIN).get("/ops-budget/hummingbird")
    assert r.status_code == 200
    body = r.json()
    site = body["sites"][0]
    assert site["shortName"] == "Testville" and site["first"] == "2023-12" and site["last"] == "2024-02"
    assert site["leases"] == 8 and site["units"] == 6 and site["goLive"] == "2023-11-20"
    assert body["loads"][0]["status"] == "ok" and "gpr" in body["notProvided"]
    viewer = {"email": "v@example.com", "level": 2, "role": "supervisor"}
    assert _client(viewer).get("/ops-budget/hummingbird").status_code in (401, 403)
    facs = _client(ADMIN).get("/ops-budget/facilities").json()
    assert next(f for f in facs["facilities"] if f["id"] == "testville")["lastHummingbirdAt"]
    assert facs["hummingbirdTo"] == "2026-08"
