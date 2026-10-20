"""Operations > Reports (ops_reports.py) and the Report Builder
(ops_report_builder.py, routers/ops_reports.py). Cubby is faked - nothing
here calls it. Rows are written straight into the cubby_* tables WITH contact
details in them, to prove the reports never pass a Cubby row through. Runs on
the throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_ops_reports.py"""
import json
from datetime import date, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import graph_mail
import models
import ops_report_builder as builder
import ops_reports
from auth import get_current_user
from database import SessionLocal

TODAY = date(2026, 10, 15)
TABLES = (models.CubbyFacility, models.CubbyUnit, models.CubbyRental, models.CubbyCustomer, models.CubbyPayment,
          models.CubbyLead, models.CubbyReceivable, models.CubbyTask, models.OpsReportCache, models.OpsSavedReport,
          models.NexusNotification, models.NexusEmployee)
SECRETS = ("tenant@example.com", "5555550100", "1 Main St", "92590", "4242", "D1234567", "1980-01-01")
CONTACT = {"email": "tenant@example.com", "phone": "+15555550100", "address": {"line1": "1 Main St", "zip": "92590"}}


def _rr(uid, name, status, cust="", tenant="", rent=0, street=20000, w=10, d=10, group="10x10 Standard", **kw):
    return {"unitId": uid, "unitName": name, "status": status, "customerId": cust, "customerName": tenant, "width": w, "depth": d,
            "standardRate": street, "monthlyRentalAmount": rent, "pricingGroupName": group, "customerContact": CONTACT,
            "dateOfBirth": "1980-01-01", **kw}


def _seed():
    db = SessionLocal()
    try:
        for t in TABLES:
            db.query(t).delete()
        db.add(models.CubbyFacility(facility_id="fac_a", name="Greens Storage Temecula", time_zone="America/Los_Angeles",
                                    enabled=True, data={"name": "Greens Storage Temecula"}, synced_at="2026-10-15T15:00:00+00:00"))
        db.add(models.CubbyFacility(facility_id="fac_b", name="Greens Storage Murrieta", time_zone="America/Los_Angeles",
                                    enabled=True, data={"name": "Greens Storage Murrieta"}, synced_at="2026-10-15T15:00:00+00:00"))
        units = [
            ("fac_a", _rr("a1", "A1", "RENTED", "cust_1", "Ada Sample", 15000, paidThroughDate="2026-09-30", autoPayEnabled=True,
                          moveInDate="2025-03-01")),
            ("fac_a", _rr("a2", "A2", "RENTED", "cust_2", "Bea Lowe", 20000, w=10, d=20, group="10x20 Drive-Up", street=30000,
                          moveInDate="2026-10-02")),
            ("fac_a", _rr("a3", "A3", "VACANT")),
            ("fac_a", _rr("a4", "A4", "UNRENTABLE")),
            ("fac_b", _rr("b1", "B1", "RENTED", "cust_3", "Cy Park", 10000, moveInDate="2026-01-10")),
        ]
        for fid, rr in units:
            u = {"unitId": rr["unitId"], "name": rr["unitName"]}
            if rr["status"] == "UNRENTABLE":
                u["rentability"] = {"rentable": False, "unrentableReason": "REPAIRS_REQUIRED", "unrentableReasonNote": "Door off track"}
            db.add(models.CubbyUnit(id=f"{fid}:{rr['unitId']}", facility_id=fid, unit_id=rr["unitId"], unit_name=rr["unitName"],
                                    status=rr["status"], customer_id=rr["customerId"], data={"rentRoll": rr, "unit": u}))
        rentals = [("fac_a", "lease_1", "a1", "cust_1", "2025-03-01", "", 15000), ("fac_a", "lease_2", "a2", "cust_2", "2026-10-02", "", 20000),
                   ("fac_a", "lease_0", "a3", "cust_9", "2026-01-05", "2026-10-05", 18000), ("fac_b", "lease_3", "b1", "cust_3", "2026-01-10", "", 10000)]
        for fid, lid, uid, cid, mi, mo, rent in rentals:
            db.add(models.CubbyRental(id=f"{fid}:{lid}", facility_id=fid, lease_id=lid, unit_id=uid, customer_id=cid, move_in_date=mi,
                                      move_out_date=mo, data={"leaseId": lid, "monthlyRentalAmount": rent, "customer": CONTACT}))
        for fid, cid, name in (("fac_a", "cust_9", "Gone Tenant"), ("fac_a", "cust_l", "Lena Lead")):
            db.add(models.CubbyCustomer(id=f"{fid}:{cid}", facility_id=fid, customer_id=cid, name=name))
        pays = [("fac_a", "p1", "cust_1", "2026-10-03", "SUCCEEDED", 15000, "CREDIT_CARD"),
                ("fac_a", "p2", "cust_2", "2026-10-04", "SUCCEEDED", 20000, "ACH"),
                ("fac_a", "p3", "cust_1", "2026-10-06", "DECLINED", 15000, "CREDIT_CARD"),
                ("fac_b", "p4", "cust_3", "2026-09-20", "SUCCEEDED", 10000, "CASH")]
        for fid, pid, cid, day, st, amt, meth in pays:
            db.add(models.CubbyPayment(id=f"{fid}:{pid}", facility_id=fid, payment_id=pid, customer_id=cid, payment_date=day, status=st,
                                       amount_cents=amt, data={"methodType": meth, "reason": "Insufficient funds" if st == "DECLINED" else "",
                                                               "billingAddress": CONTACT["address"], "cardLastFour": "4242"}))
        db.add(models.CubbyLead(id="fac_a:l1", facility_id="fac_a", lead_id="l1", customer_id="cust_l", status="CONVERTED",
                                created_at="2026-10-08T10:00:00Z", data={"source": "WEBSITE", "contact": CONTACT}))
        db.add(models.CubbyLead(id="fac_a:l2", facility_id="fac_a", lead_id="l2", customer_id="cust_x", status="NEW",
                                created_at="2026-10-09T10:00:00Z", data={"source": "PHONE"}))
        db.add(models.CubbyReceivable(id="fac_a:a1:cust_1", facility_id="fac_a", unit_id="a1", customer_id="cust_1", total_cents=95108,
                                      data={"unitName": "A1", "customerName": "Ada Sample", "pricingGroupName": "10x10 Standard",
                                            "ranges": [{"range": "RANGE_0_30", "amount": 15000}, {"range": "RANGE_30_60", "amount": 80108}],
                                            "phoneNumber": "+15555550100"}))
        db.add(models.CubbyTask(id="fac_a:t1", facility_id="fac_a", task_id="t1", unit_id="a4", due_date="2026-10-20",
                                data={"title": "Fix door"}))
        db.add(models.NexusEmployee(id="e1", first_name="Ops", work_email="ops.manager@greensglobal.com", status="active"))
        db.add(models.NexusEmployee(id="e2", first_name="Other", work_email="other.manager@greensglobal.com", status="active"))
        db.add(models.NexusEmployee(id="e3", first_name="Gone", work_email="gone@greensglobal.com", status="offboarded"))
        db.commit()
    finally:
        db.close()


GL_CASH = {"entries": [
    {"id": "1", "journalEntryId": "je1", "paymentTime": "2026-10-03T10:00:00", "amount": 15000, "direction": "DEBIT",
     "account": "CREDIT_CARD_PAYMENTS", "details": {"cardType": "visa", "cardLastFour": "4242", "customerId": "cust_1",
                                                   "customerName": "Ada Sample", "unitName": "A1", "email": "tenant@example.com"}},
    {"id": "2", "journalEntryId": "je1", "paymentTime": "2026-10-03T10:00:00", "amount": 14000, "direction": "CREDIT",
     "account": "RENT", "details": {"customerId": "cust_1", "customerName": "Ada Sample", "unitName": "A1"}},
    {"id": "3", "journalEntryId": "je1", "paymentTime": "2026-10-03T10:00:00", "amount": 1000, "direction": "CREDIT",
     "account": "TAX_STATE", "details": {"description": "7.25%", "customerId": "cust_1", "customerName": "Ada Sample", "unitName": "A1"}},
    {"id": "4", "journalEntryId": "je2", "paymentTime": "2026-10-04T10:00:00", "amount": 2500, "direction": "CREDIT",
     "account": "FEES", "details": {"description": "Admin Fee", "customerId": "cust_2", "customerName": "Bea Lowe", "unitName": "A2"}},
    {"id": "5", "journalEntryId": "je2", "paymentTime": "2026-10-04T10:00:00", "amount": 2500, "direction": "DEBIT",
     "account": "ACH_PAYMENTS", "details": {"customerId": "cust_2", "checkNumber": "1001"}},
    {"id": "6", "journalEntryId": "je3", "paymentTime": "2026-09-28T10:00:00", "amount": 999, "direction": "CREDIT",
     "account": "RENT", "details": {"customerId": "cust_2"}},   # outside the period
]}
GL_ACCRUAL = {"entries": [
    {"id": "a1", "journalEntryId": "je9", "entryTime": "2026-10-01T00:00:00", "customerId": "cust_1", "customerName": "Ada Sample",
     "unitId": "a1", "unitName": "A1", "account": "RENT", "mappedGlAccount": "Rental Income", "mappedGlAccountNumber": "4000",
     "taxCategory": "RENT_ENCLOSED_STORAGE", "explanation": "Rent", "debit": 0, "credit": 15000}]}
DISB = {"batches": [{"facilityId": "fac_a", "batchDate": "2026-10-05", "batchNumber": "po_1", "batchStatus": "paid",
                     "paymentProvider": "STRIPE", "methodType": "card", "amount": 15000, "merchantId": "acct_1"}],
        "transactions": [{"batchNumber": "po_1", "date": "2026-10-03", "amount": 15000, "status": "APPROVED", "type": "SALE",
                          "customerId": "cust_1", "customerName": "Ada Sample", "methodType": "CREDIT_CARD", "cardBrand": "VISA",
                          "lastFour": "4242"}]}
LEDGER = {"ledgers": [{"leaseId": "lease_1", "bookEntries": [
    {"type": "CHARGE", "entryTime": "2026-10-01T00:00:00", "amount": 15000, "amountPaid": 0,
     "details": {"category": "RENT", "accruesOn": "2026-10-01", "accruesThrough": "2026-10-31", "waive": False}},
    {"type": "PAYMENT", "entryTime": "2026-09-02T00:00:00", "amount": -15000, "details": {"method": "CREDIT_CARD", "cardLastFour": "4242"}}]}]}


class FakeCubby:
    def __init__(self):
        self.calls = []
        self.fail = False

    def __call__(self, path, body):
        self.calls.append((path, json.loads(json.dumps(body))))
        if self.fail:
            raise cubby.CubbyError(500, f"{path}: boom")
        where = body.get("where") or {}
        if path != "leases/get-compliances":
            assert where.get("facilityId") or where.get("facilityIds"), f"{path} unscoped"   # Cubby 403s an unscoped call
        if path == "reports/general-ledger/cash":
            return GL_CASH if where["startDate"] == "2026-10-01" else {"entries": []}
        if path == "reports/general-ledger/accrual":
            return GL_ACCRUAL if where["startDate"] == "2026-10-01" else {"entries": []}
        if path == "reports/merchant-services-disbursements":
            return DISB if where["facilityIds"] == ["fac_a"] and where["startDate"] == "2026-10-01" else {"batches": [], "transactions": []}
        if path == "leases/get-compliances":
            return {"compliances": [{"leaseId": lid, "documents": [
                {"type": "LEASE_AGREEMENT", "status": "SIGNATURE_NEEDED" if lid == "lease_1" else "APPROVED"},
                {"type": "IDENTITY", "status": "APPROVED"}]} for lid in body["leaseIds"]]}
        if path == "ledgers/search":
            return LEDGER
        raise AssertionError(f"unexpected call {path}")


@pytest.fixture
def fake(monkeypatch):
    _seed()
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: TODAY)
    f = FakeCubby()
    monkeypatch.setattr(ops_reports, "_cubby", f)
    ops_reports._ledger_cache.clear()
    return f


def _client(level=3, email="ops.manager@greensglobal.com"):
    from routers import ops_reports as r
    app = FastAPI()
    app.include_router(r.router)
    user = {"email": email, "role": "manager", "level": level}
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.fixture
def client(fake):
    c = _client()
    c.fake = fake
    return c


def _no_secrets(blob):
    text = json.dumps(blob) if not isinstance(blob, str) else blob
    for s in SECRETS:
        assert s not in text, f"{s} leaked"
    for k in ('"email"', '"phone"', '"address"', "cardLastFour", "lastFour", "checkNumber"):
        assert k not in text, f"{k} leaked"


# ── Catalog ──────────────────────────────────────────────────────────────────

def test_catalog_covers_every_cubby_report_endpoint_and_names_what_is_missing(client):
    out = client.get("/ops-reports/catalog").json()
    keys = {r["key"]: r for r in out["reports"]}
    # Cubby's reports/* endpoints: rent-roll, aged-receivables, general-ledger/cash, general-ledger/accrual,
    # merchant-services-disbursements.
    for k in ("rent-roll", "aged-receivables", "general-ledger-cash", "general-ledger-accrual", "merchant-disbursements"):
        assert keys[k]["source"] == "cubby"
    assert keys["inventory-activity"]["source"] == "unavailable"
    assert {r["category"] for r in out["reports"]} == set(out["categories"])


def test_every_report_runs_and_none_carries_contact_details(client):
    for r in client.get("/ops-reports/catalog").json()["reports"]:
        res = client.get(f"/ops-reports/run/{r['key']}", params={"start": "2026-10-01", "end": "2026-10-15"})
        assert res.status_code == 200, (r["key"], res.text)
        body = res.json()
        _no_secrets(body)
        if r["source"] == "unavailable":
            assert body["available"] is False and "Not Available From Cubby Yet" in body["notes"][0]
        else:
            assert body["columns"] and isinstance(body["rows"], list)


def test_unknown_report_and_bad_period(client):
    assert client.get("/ops-reports/run/nope").status_code == 404
    assert client.get("/ops-reports/run/payment-detail", params={"start": "2026-10-10", "end": "2026-10-01"}).status_code == 422
    assert client.get("/ops-reports/run/rent-roll", params={"facility_id": "fac_zzz"}).status_code == 404


# ── Reports from the synced rows ─────────────────────────────────────────────

def test_rent_roll_rows_link_to_tenant_and_unit(client):
    out = client.get("/ops-reports/run/rent-roll", params={"facility_id": "fac_a"}).json()
    a1 = next(r for r in out["rows"] if r["unit"] == "A1")
    assert (a1["tenant"], a1["rent"], a1["street"], a1["variance"], a1["balance"]) == ("Ada Sample", 15000, 20000, -5000, 95108)
    assert (a1["_f"], a1["_c"], a1["_u"]) == ("fac_a", "cust_1", "a1")
    assert out["facility"] == "Temecula" and len(out["rows"]) == 4
    assert out["totals"]["balance"] == 95108


def test_accounts_receivable_buckets(client):
    out = client.get("/ops-reports/run/accounts-receivable").json()
    row = out["rows"][0]
    assert (row["tenant"], row["total"], row["range_0_30"], row["range_30_60"]) == ("Ada Sample", 95108, 15000, 80108)


def test_occupancy_and_vacant_units(client):
    occ = client.get("/ops-reports/run/occupancy-statistics", params={"facility_id": "fac_a"}).json()
    std = next(r for r in occ["rows"] if r["type"] == "10x10 Standard")
    assert (std["units"], std["rented"], std["vacant"], std["off"], std["occ"]) == (3, 1, 1, 1, 33.3)
    assert std["potential"] == 60000 and std["rent"] == 15000 and std["econ"] == 25.0
    vac = client.get("/ops-reports/run/vacant-units", params={"facility_id": "fac_a"}).json()
    by = {r["unit"]: r for r in vac["rows"]}
    assert set(by) == {"A3", "A4"}
    assert by["A3"]["vacantSince"] == "2026-10-05" and by["A3"]["daysVacant"] == 10
    assert by["A4"]["reason"] == "Repairs Required" and by["A4"]["status"] == "Off Market"


def test_management_summary_counts_the_period_and_the_year(client):
    out = client.get("/ops-reports/run/management-summary", params={"start": "2026-10-01", "end": "2026-10-15"}).json()
    a = next(r for r in out["rows"] if r["facility"] == "Temecula")
    assert (a["moveIns"], a["moveOuts"], a["receipts"], a["failed"], a["leads"], a["converted"]) == (1, 1, 35000, 1, 2, 1)
    b = next(r for r in out["rows"] if r["facility"] == "Murrieta")
    assert b["receipts"] == 0 and b["receiptsYtd"] == 10000
    assert out["totals"]["facility"] == "All Facilities" and out["totals"]["units"] == 5 and out["totals"]["receiptsYtd"] == 45000


def test_moves_payments_receipts_and_leads(client):
    p = {"start": "2026-10-01", "end": "2026-10-15"}
    moves = client.get("/ops-reports/run/move-in-move-out-detail", params=p).json()["rows"]
    assert {(r["kind"], r["unit"]) for r in moves} == {("Move-In", "A2"), ("Move-Out", "A3")}
    out = next(r for r in moves if r["kind"] == "Move-Out")
    assert out["tenant"] == "Gone Tenant" and out["stay"] == 273
    pays = client.get("/ops-reports/run/payment-detail", params=p).json()
    assert len(pays["rows"]) == 3 and pays["totals"]["amount"] == 50000
    assert next(r for r in pays["rows"] if r["paymentId"] == "p1")["units"] == "A1"
    rs = client.get("/ops-reports/run/receipts-summary", params=p).json()["rows"]
    cc = next(r for r in rs if r["method"] == "Credit Card")
    assert (cc["count"], cc["amount"], cc["failed"]) == (1, 15000, 1)
    leads = client.get("/ops-reports/run/leads-activity", params=p).json()["rows"]
    assert {(r["tenant"], r["status"]) for r in leads} == {("Lena Lead", "Converted"), ("", "New")}


# ── Cubby's live reports: cache, failure, privacy ─────────────────────────────

def test_receipts_by_charge_type_from_the_cash_ledger_with_drill_lines(client):
    out = client.get("/ops-reports/run/receipts-by-charge-type", params={"facility_id": "fac_a", "start": "2026-10-01", "end": "2026-10-15"}).json()
    by = {r["charge"]: r for r in out["rows"]}
    assert set(by) == {"Rent", "State Tax", "Fees"}               # payment accounts are not charges
    assert (by["Rent"]["amount"], by["Fees"]["amount"], by["State Tax"]["amount"]) == (14000, 2500, 1000)
    sub = out["groups"][by["Rent"]["_sub"]]
    assert sub["rows"][0]["tenant"] == "Ada Sample" and sub["rows"][0]["_u"] == "a1"
    tax = client.get("/ops-reports/run/receipts-by-tax-category", params={"facility_id": "fac_a", "start": "2026-10-01", "end": "2026-10-15"}).json()
    by = {(r["tax"], r["rate"]): r for r in tax["rows"]}
    assert by[("State Tax", "7.25%")]["collected"] == 1000 and by[("State Tax", "7.25%")]["taxable"] == 14000
    assert by[("Not Taxed", "")]["taxable"] == 2500


def test_live_reports_are_cached_per_facility_and_month(client):
    p = {"facility_id": "fac_a", "start": "2026-09-01", "end": "2026-10-15"}
    client.get("/ops-reports/run/general-ledger-cash", params=p)
    first = len(client.fake.calls)
    assert first == 2                                                  # September and October, one call each
    client.get("/ops-reports/run/receipts-by-charge-type", params=p)    # same ledger, same months
    assert len(client.fake.calls) == first
    db = SessionLocal()
    try:
        keys = {r.id for r in db.query(models.OpsReportCache).all()}
        stored = json.dumps([r.payload for r in db.query(models.OpsReportCache).all()])
    finally:
        db.close()
    assert keys == {"gl-cash:fac_a:2026-09", "gl-cash:fac_a:2026-10"}
    _no_secrets(stored)                                                # cleaned BEFORE it is kept


def test_ttl_current_month_short_recent_month_longer_old_month_kept():
    assert ops_reports.ttl_for("2026-10", TODAY) == ops_reports.CURRENT_TTL
    assert ops_reports.ttl_for("2026-09", date(2026, 10, 2)) == ops_reports.RECENT_TTL
    assert ops_reports.ttl_for("2026-08", TODAY) > 30 * 86400


def test_a_failed_refresh_serves_the_last_copy_with_a_note(client, monkeypatch):
    p = {"facility_id": "fac_a", "start": "2026-10-01", "end": "2026-10-15"}
    client.get("/ops-reports/run/general-ledger-cash", params=p)
    monkeypatch.setattr(ops_reports, "CURRENT_TTL", -1)                # force a re-read
    client.fake.fail = True
    out = client.get("/ops-reports/run/general-ledger-cash", params=p).json()
    assert out["rows"] and any("boom" in n for n in out["notes"])


def test_no_cache_and_cubby_down_is_424_and_no_key_is_503(client, monkeypatch):
    client.fake.fail = True
    r = client.get("/ops-reports/run/general-ledger-accrual", params={"start": "2026-10-01", "end": "2026-10-15"})
    assert r.status_code == 424
    monkeypatch.delenv("CUBBY_API_KEY")
    r = client.get("/ops-reports/run/merchant-disbursements", params={"start": "2026-10-01", "end": "2026-10-15"})
    assert r.status_code == 503 and "CUBBY_API_KEY" in r.json()["detail"]


def test_ledger_period_is_capped(client):
    r = client.get("/ops-reports/run/general-ledger-cash", params={"start": "2025-01-01", "end": "2026-10-15"})
    assert r.status_code == 422


def test_disbursements_and_compliance(client):
    out = client.get("/ops-reports/run/merchant-disbursements", params={"start": "2026-10-01", "end": "2026-10-15"}).json()
    assert len(out["rows"]) == 1 and out["rows"][0]["batch"] == "po_1" and out["rows"][0]["count"] == 1
    assert out["groups"][out["rows"][0]["_sub"]]["rows"][0]["tenant"] == "Ada Sample"
    comp = client.get("/ops-reports/run/lease-compliance").json()
    assert [(r["unit"], r["leaseAgreement"]) for r in comp["rows"]] == [("A1", "Signature Needed")]
    calls = [b for p, b in client.fake.calls if p == "leases/get-compliances"]
    assert sorted(sum((b["leaseIds"] for b in calls), [])) == ["lease_1", "lease_2", "lease_3"]   # active leases only


def test_accrual_ledger_carries_gl_mapping_and_tax_category(client):
    out = client.get("/ops-reports/run/general-ledger-accrual", params={"start": "2026-10-01", "end": "2026-10-15"}).json()
    row = out["rows"][0]
    assert (row["glAccount"], row["taxCategory"], row["credit"]) == ("4000 Rental Income", "Rent Enclosed Storage", 15000)


# ── Drill-down ───────────────────────────────────────────────────────────────

def test_tenant_drill_down(client):
    out = client.get("/ops-reports/tenant", params={"facility_id": "fac_a", "customer_id": "cust_1"}).json()
    assert out["name"] == "Ada Sample" and [u["unit"] for u in out["units"]] == ["A1"]
    assert out["balance"]["total"] == 95108 and len(out["payments"]) == 2 and out["rentals"][0]["stayDays"] == 593
    assert out["cubbyUrl"].endswith("/tenants/cust_1")
    _no_secrets(out)
    led = client.get("/ops-reports/tenant/ledger", params={"facility_id": "fac_a", "customer_id": "cust_1"}).json()
    assert [e["type"] for e in led["entries"]] == ["Charge", "Payment"] and led["entries"][0]["accrues"] == "2026-10-01 - 2026-10-31"
    _no_secrets(led)
    assert client.get("/ops-reports/tenant", params={"facility_id": "fac_a", "customer_id": "nobody"}).status_code == 404


def test_unit_drill_down_has_its_history(client):
    out = client.get("/ops-reports/unit", params={"facility_id": "fac_a", "unit_id": "a3"}).json()
    assert out["status"] == "Vacant" and out["tenant"] is None
    assert [(h["tenant"], h["moveOut"]) for h in out["history"]] == [("Gone Tenant", "2026-10-05")]
    a4 = client.get("/ops-reports/unit", params={"facility_id": "fac_a", "unit_id": "a4"}).json()
    assert a4["reason"] == "Repairs Required" and a4["tasks"][0]["title"] == "Fix door"
    assert client.get("/ops-reports/unit", params={"facility_id": "fac_a", "unit_id": "zz"}).status_code == 404


# ── Builder ──────────────────────────────────────────────────────────────────

def _spec(**kw):
    s = {"dataset": "units", "dimensions": ["facility"],
         "measures": [{"id": "rent", "agg": "sum", "field": "rent"}, {"id": "occ_sqft", "agg": "sum", "field": "occupied_area"}],
         "formulas": [{"id": "per_sqft", "label": "Rent per Occupied Sq Ft", "expr": "rent / occ_sqft / 100", "format": "money"}]}
    s.update(kw)
    return s


def test_builder_formula_metric_revenue_per_occupied_square_foot(client):
    out = client.post("/ops-reports/builder/run", json={"spec": _spec()}).json()
    a = next(r for r in out["rows"] if r["facility"] == "Temecula")
    assert a["rent"] == 35000 and a["occ_sqft"] == 300 and a["per_sqft"] == pytest.approx(35000 / 300 / 100)
    assert out["totals"]["rent"] == 45000
    assert [c["type"] for c in out["columns"]] == ["text", "money", "area", "money"]


@pytest.mark.parametrize("bad", [
    {"dataset": "secrets"},
    {"dimensions": ["email"]},
    {"measures": [{"id": "x", "agg": "sum", "field": "customer_email"}]},
    {"measures": [{"id": "x", "agg": "median", "field": "rent"}]},
    {"measures": [{"id": "X; DROP", "agg": "count"}]},
    {"formulas": [{"id": "f", "expr": "__import__('os')", "format": "number"}]},
    {"formulas": [{"id": "f", "expr": "rent ** 2", "format": "number"}]},
    {"formulas": [{"id": "f", "expr": "unknown_measure / 2", "format": "number"}]},
    {"formulas": [{"id": "f", "expr": "(rent / 2", "format": "number"}]},
    {"filters": [{"dimension": "tenant", "values": ["x"]}]},
    {"period": "forever"},
])
def test_builder_registry_refuses_anything_not_whitelisted(client, bad):
    r = client.post("/ops-reports/builder/run", json={"spec": _spec(**bad)})
    assert r.status_code == 422, bad


def test_formula_math_and_division_by_zero():
    tree = builder.parse_formula("(a + b) * 2 - -c / d", {"a", "b", "c", "d"})
    assert builder.evaluate(tree, {"a": 1, "b": 2, "c": 4, "d": 2}) == 8
    assert builder.evaluate(builder.parse_formula("a / b", {"a", "b"}), {"a": 1, "b": 0}) is None
    assert builder.evaluate(builder.parse_formula("a / b", {"a", "b"}), {"a": None, "b": 2}) is None


def test_builder_datasets_dimensions_filters_and_pct(client):
    spec = {"dataset": "payments", "dimensions": ["method"], "period": "custom", "from": "2026-10-01", "to": "2026-10-15",
            "measures": [{"id": "n", "agg": "count"}, {"id": "ok", "agg": "sum", "field": "succeeded"}],
            "formulas": [{"id": "rate", "label": "Success Rate", "expr": "ok / n", "format": "pct"}],
            "filters": [{"dimension": "facility", "values": ["Temecula"]}], "sort": {"by": "n", "desc": True}}
    out = client.post("/ops-reports/builder/run", json={"spec": spec}).json()
    assert out["rows"][0]["method"] == "Credit Card" and out["rows"][0]["rate"] == 50.0
    assert out["totals"]["n"] == 3 and out["period"]["from"] == "2026-10-01"
    moves = client.post("/ops-reports/builder/run", json={"spec": {
        "dataset": "moves", "dimensions": ["kind"], "period": "this-month",
        "measures": [{"id": "n", "agg": "count"}, {"id": "net", "agg": "sum", "field": "net"}]}}).json()
    assert {r["kind"]: r["n"] for r in moves["rows"]} == {"Move-In": 1, "Move-Out": 1} and moves["totals"]["net"] == 0
    for ds, field in (("rentals", "rent"), ("leads", "converted")):
        r = client.post("/ops-reports/builder/run", json={"spec": {"dataset": ds, "dimensions": ["facility"], "period": "all",
                                                                    "measures": [{"id": "m", "agg": "sum", "field": field}]}})
        assert r.status_code == 200 and r.json()["rows"]


def test_registry_lists_the_datasets(client):
    reg = client.get("/ops-reports/builder/registry").json()
    assert {d["key"] for d in reg["datasets"]} == {"units", "rentals", "payments", "leads", "moves"}


# ── Saved, shared, scheduled ─────────────────────────────────────────────────

def test_saving_needs_a_manager_or_the_editor_grant(fake):
    sup = _client(level=2, email="sup@greensglobal.com")
    assert sup.post("/ops-reports/builder/run", json={"spec": _spec()}).status_code == 200      # a supervisor runs reports
    r = sup.post("/ops-reports/saved", json={"name": "Mine", "spec": _spec()})
    assert r.status_code == 401
    emp = _client(level=1, email="emp@greensglobal.com")
    assert emp.get("/ops-reports/catalog").status_code == 401


def test_saved_reports_are_private_until_shared_and_only_the_owner_edits(client):
    r = client.post("/ops-reports/saved", json={"name": "Rent per Sq Ft", "spec": _spec()})
    assert r.status_code == 201
    rid = r.json()["report"]["id"]
    other = _client(email="other.manager@greensglobal.com")
    assert other.get("/ops-reports/saved").json()["reports"] == []
    s = client.post(f"/ops-reports/saved/{rid}/share", json={"recipient": "other.manager@greensglobal.com", "message": "Have a look"})
    assert s.status_code == 200
    seen = other.get("/ops-reports/saved").json()["reports"]
    assert [x["name"] for x in seen] == ["Rent per Sq Ft"] and seen[0]["canEdit"] is False
    assert other.patch(f"/ops-reports/saved/{rid}", json={"name": "Hijack"}).status_code == 403
    db = SessionLocal()
    try:
        n = db.query(models.NexusNotification).filter_by(recipient="other.manager@greensglobal.com", type="ops_report_shared").one()
        assert "Shared With You" in n.title and json.loads(n.action) == {"view": "operations", "sub": "reports"}
    finally:
        db.close()
    assert client.delete(f"/ops-reports/saved/{rid}").status_code == 200


def test_a_saved_spec_is_validated_and_a_schedule_needs_nexus_people(client):
    assert client.post("/ops-reports/saved", json={"name": "Bad", "spec": {"dataset": "units", "measures": [{"id": "x", "agg": "sum", "field": "ssn"}]}}).status_code == 422
    rid = client.post("/ops-reports/saved", json={"name": "Weekly", "spec": _spec()}).json()["report"]["id"]
    assert client.patch(f"/ops-reports/saved/{rid}", json={"schedule": "weekly", "scheduleDay": 0}).status_code == 422
    assert client.patch(f"/ops-reports/saved/{rid}", json={"schedule": "weekly", "scheduleDay": 0,
                                                            "recipients": ["someone@gmail.com"]}).status_code == 422
    assert client.patch(f"/ops-reports/saved/{rid}", json={"schedule": "weekly", "scheduleDay": 0,
                                                            "recipients": ["gone@greensglobal.com"]}).status_code == 422
    assert client.patch(f"/ops-reports/saved/{rid}", json={"schedule": "monthly", "scheduleDay": 31,
                                                            "recipients": ["ops.manager@greensglobal.com"]}).status_code == 422
    ok = client.patch(f"/ops-reports/saved/{rid}", json={"schedule": "weekly", "scheduleDay": 0,
                                                          "recipients": ["Ops.Manager@greensglobal.com"]})
    assert ok.status_code == 200 and ok.json()["report"]["recipients"] == ["ops.manager@greensglobal.com"]


def test_due_period():
    tz = builder.ZoneInfo(builder.TZ)
    mon_6am = datetime(2026, 10, 19, 6, 0, tzinfo=tz)
    mon_8am = datetime(2026, 10, 19, 8, 0, tzinfo=tz)
    assert builder.due_period("weekly", 0, mon_6am) == ""
    assert builder.due_period("weekly", 0, mon_8am) == "2026-10-19"
    assert builder.due_period("weekly", 4, mon_8am) == ""                     # Friday this week, not yet
    assert builder.due_period("monthly", 1, mon_8am) == "2026-10"
    assert builder.due_period("monthly", 25, mon_8am) == ""
    assert builder.due_period("", 0, mon_8am) == ""


def test_schedule_sends_once_per_period_with_csv_and_retries_a_failure(client, monkeypatch):
    rid = client.post("/ops-reports/saved", json={"name": "Weekly Rent", "spec": _spec(), "schedule": "weekly", "scheduleDay": 0,
                                                  "recipients": ["ops.manager@greensglobal.com", "other.manager@greensglobal.com"]}).json()["report"]["id"]
    sent = []
    monkeypatch.setattr(graph_mail, "graph_configured", lambda: True)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: sent.append(kw) or {})
    now = datetime(2026, 10, 19, 8, 0, tzinfo=builder.ZoneInfo(builder.TZ))
    assert builder.scan_once(now) == 1
    assert builder.scan_once(now) == 0                                        # once per period
    mail = sent[0]
    assert mail["to"] == ["ops.manager@greensglobal.com", "other.manager@greensglobal.com"]
    assert mail["subject"].startswith("Ops Report: Weekly Rent") and "10/15/2026" in mail["subject"]
    name, ctype, data = mail["attachments"][0]
    assert ctype == "text/csv" and name.endswith(".csv")
    csv_text = data.decode("utf-8-sig")
    assert csv_text.splitlines()[0] == "Facility,Sum of Monthly Rent (Rented Units),Sum of Occupied Sq Ft,Rent per Occupied Sq Ft"
    _no_secrets(csv_text + mail["html"])
    # Next week: a failure gives the claim back, and is not retried within the hour.
    def boom(**kw):
        raise graph_mail.GraphMailError("Graph is down")
    monkeypatch.setattr(graph_mail, "send_mail", boom)
    later = datetime(2026, 10, 26, 8, 0, tzinfo=builder.ZoneInfo(builder.TZ))
    assert builder.scan_once(later) == 0
    db = SessionLocal()
    try:
        row = db.get(models.OpsSavedReport, rid)
        assert row.last_sent_period == "2026-10-19" and "Graph is down" in row.last_error
    finally:
        db.close()
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: sent.append(kw) or {})
    assert builder.scan_once(later) == 0                                      # within the hour: wait
    monkeypatch.setattr(builder, "RETRY_AFTER_SEC", -1)
    assert builder.scan_once(later) == 1


def test_send_now_to_me(client, monkeypatch):
    rid = client.post("/ops-reports/saved", json={"name": "Now", "spec": _spec()}).json()["report"]["id"]
    sent = []
    monkeypatch.setattr(graph_mail, "graph_configured", lambda: True)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: sent.append(kw) or {})
    r = client.post(f"/ops-reports/saved/{rid}/send", json={"to_me": True})
    assert r.status_code == 200 and sent[0]["to"] == ["ops.manager@greensglobal.com"]


def test_warm_up_reads_this_month_once_and_then_serves_the_cache(client):
    assert builder.warm() == 2
    n = len(client.fake.calls)
    assert {p for p, _ in client.fake.calls} == {"reports/general-ledger/cash", "reports/merchant-services-disbursements"}
    assert builder.warm() == 2 and len(client.fake.calls) == n          # within the TTL: no Cubby call


def test_csv_escapes_formula_text():
    res = {"columns": [{"key": "facility", "label": "Facility", "type": "text"}, {"key": "m", "label": "M", "type": "money"}],
           "rows": [{"facility": "=HYPERLINK(1)", "m": -500}]}
    line = builder.to_csv(res).splitlines()[1]
    assert line.startswith("'=HYPERLINK") and line.endswith("-5.00")
