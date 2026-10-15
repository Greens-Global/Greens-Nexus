"""Cubby -> database sync (cubby_sync.py) and the database read path
(cubby.summary / lookup). Cubby is faked - nothing here calls it. Runs on the
throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_cubby_sync.py"""
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import cubby_sync
import models
from auth import get_current_user
from database import SessionLocal

TABLES = (models.CubbyFacility, models.CubbyUnit, models.CubbyRental, models.CubbyCustomer, models.CubbyPayment,
          models.CubbyLead, models.CubbyReceivable, models.CubbyTask, models.CubbySyncRun, models.CubbyDailySnapshot)

FACS = [
    {"facilityId": "fac_a", "name": "Greens Storage Temecula", "timeZone": "America/Los_Angeles", "enabled": True,
     "latitude": "33.4936", "longitude": "-117.1484", "phone": "+15555550000", "address": {"line1": "9 Office Rd"}},
    {"facilityId": "fac_b", "name": "Greens Storage Murrieta", "timeZone": "America/Los_Angeles", "enabled": True},
]
CONTACT = {"email": "tenant@example.com", "phone": "+15555550100", "address": {"line1": "1 Main St"}}


def _rows_for(fid: str) -> dict:
    p = fid[-1]
    return {
        "reports/rent-roll": {"entries": [
            {"unitId": f"{p}1", "unitName": f"{p.upper()}1", "status": "RENTED", "width": 10, "depth": 20, "standardRate": 20000,
             "monthlyRentalAmount": 18000, "customerId": f"cust_{p}1", "customerName": f"Tenant {p}1", "paid": False,
             "pricingGroupName": "10x20", "customerContact": CONTACT, "dateOfBirth": "1980-01-01", "moveInDate": "2025-01-01"},
            {"unitId": f"{p}2", "unitName": f"{p.upper()}2", "status": "VACANT", "width": 10, "depth": 20, "standardRate": 20000,
             "pricingGroupName": "10x20"},
        ]},
        "reports/aged-receivables": {"entries": [
            {"unitId": f"{p}1", "unitName": f"{p.upper()}1", "customerId": f"cust_{p}1", "customerName": f"Tenant {p}1",
             "totalAmount": 30000, "ranges": [{"range": "RANGE_0_30", "amount": 30000}], "phoneNumber": "+15555550101"}]},
        "units/search": {"units": [{"unitId": f"{p}1", "name": f"{p.upper()}1"}, {"unitId": f"{p}2", "name": f"{p.upper()}2"}]},
        "leases/search": {"leases": [{"leaseId": f"lease_{p}1", "unitId": f"{p}1", "customerId": f"cust_{p}1",
                                      "moveInDate": "2025-01-01", "moveOutDate": None,
                                      "customer": {"name": f"Tenant {p}1", "emailAddress": "t@example.com", "idNumber": "D1234567"}}]},
        "leads/search": {"leads": [{"leadId": f"lead_{p}", "customerId": f"cust_l{p}", "status": "NEW", "createdAt": "2026-10-01T00:00:00Z"}]},
        "customers/search": {"customers": [
            {"customerId": f"cust_l{p}", "firstName": "Robin", "lastName": "Lead", "contact": CONTACT, "driversLicense": "X99"},
            {"customerId": "cust_nobody", "name": "Not Referenced", "contact": CONTACT}]},
        "tasks/search": {"tasks": [{"taskId": f"task_{p}", "title": "Sweep aisle B", "dueDate": "2026-10-10"}]},
    }


class FakeCubby:
    def __init__(self):
        self.calls = []
        self.fail = {}             # facility id -> path that answers 500
        self.down = False          # every call fails
        self.payments = {"fac_a": [], "fac_b": []}

    def __call__(self, path, where):
        self.calls.append((path, dict(where)))
        if self.down:
            raise cubby.CubbyError(0, "Cubby could not be reached (ConnectError)")
        if path == "organizations/search":
            return {"organizations": [{"organizationId": "org_1", "name": "Greens Storage"}]}
        if path == "facilities/search":
            assert where == {"organizationId": "org_1"}                     # always scoped
            return {"facilities": FACS}
        fid = where.get("facilityId") or (where.get("facilityIds") or [None])[0]
        assert fid, f"{path} unscoped"                                       # Cubby answers 403 to an unscoped search
        if self.fail.get(fid) == path:
            raise cubby.CubbyError(500, f"{path}: boom")
        if path == "payments/search":
            a, b = where["paymentDateOnOrAfter"], where["paymentDateOnOrBefore"]   # both bounds, always
            return {"payments": [x for x in self.payments[fid] if a <= x["paymentDate"] <= b]}
        return _rows_for(fid)[path]


@pytest.fixture
def fake(monkeypatch):
    db = SessionLocal()
    try:
        for t in TABLES:
            db.query(t).delete()
        db.commit()
    finally:
        db.close()
    cubby.forget()
    monkeypatch.delenv("CUBBY_API_KEY", raising=False)     # each test says whether this server has the key
    f = FakeCubby()
    monkeypatch.setattr(cubby, "_post", f)
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: date(2026, 10, 15))
    return f


def _q(model, **flt):
    db = SessionLocal()
    try:
        return db.query(model).filter_by(**flt).all()
    finally:
        db.close()


def _pay(pid, day, status="SUCCEEDED", amount=10000, cust="cust_a1"):
    return {"paymentId": pid, "paymentDate": day, "createdAt": f"{day}T09:00:00Z", "status": status, "amount": amount,
            "customerId": cust, "methodType": "CREDIT_CARD", "billingAddress": {"zip": "92590"}}


def test_sync_writes_the_rows_and_never_stores_contact_details(fake):
    fake.payments["fac_a"] = [_pay("p1", "2026-10-01")]
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "ok"
    assert len(_q(models.CubbyUnit)) == 4 and len(_q(models.CubbyRental)) == 2
    assert len(_q(models.CubbyLead)) == 2 and len(_q(models.CubbyReceivable)) == 2 and len(_q(models.CubbyTask)) == 2
    assert [p.amount_cents for p in _q(models.CubbyPayment)] == [10000]
    custs = {c.customer_id: c.name for c in _q(models.CubbyCustomer, facility_id="fac_a")}
    assert custs == {"cust_la": "Robin Lead"}                        # name only, and only someone a row points at
    fac = _q(models.CubbyFacility, facility_id="fac_a")[0]
    assert fac.organization == "Greens Storage" and fac.payments_synced_through == "2026-10-15" and fac.synced_at
    assert "phone" not in fac.data and "address" not in fac.data and fac.data["latitude"] == "33.4936"
    stored = repr([(r.data) for t in (models.CubbyUnit, models.CubbyRental, models.CubbyReceivable, models.CubbyPayment,
                                      models.CubbyLead, models.CubbyTask) for r in _q(t)])
    for secret in ("example.com", "5555550100", "5555550101", "1 Main St", "1980-01-01", "D1234567", "92590", "X99"):
        assert secret not in stored
    run = _q(models.CubbySyncRun)[0]
    assert run.status == "ok" and run.finished_at and run.facilities["fac_a"]["counts"]["units"] == 2
    # The day's history row comes from the database after the run.
    assert {s.facility_id for s in _q(models.CubbyDailySnapshot)} == {"fac_a", "fac_b"}


def test_a_failing_facility_keeps_its_rows_and_the_run_is_partial(fake):
    cubby_sync.sync_all("schedule")
    fake.fail["fac_b"] = "leases/search"
    fake.payments["fac_a"] = [_pay("p2", "2026-10-14")]
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "partial"
    assert len(_q(models.CubbyRental, facility_id="fac_b")) == 1        # last good copy stays
    assert len(_q(models.CubbyUnit, facility_id="fac_b")) == 2
    assert len(_q(models.CubbyPayment, facility_id="fac_a")) == 1       # the healthy one moved on
    runs = sorted(_q(models.CubbySyncRun), key=lambda r: r.started_at)
    assert runs[-1].status == "partial" and "Murrieta" in runs[-1].error and "boom" in runs[-1].error
    assert "CUBBY_API_KEY" not in runs[-1].error
    fake.down = True
    assert cubby_sync.sync_all("schedule")["status"] == "failed"
    assert len(_q(models.CubbyUnit)) == 4                              # an outage wipes nothing


def test_payments_backfill_then_read_only_the_recent_window(fake, monkeypatch):
    fake.payments["fac_a"] = [_pay("old", "2026-09-20"), _pay("late", "2026-12-20")]
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: date(2027, 1, 20))
    cubby_sync.sync_all("schedule")
    windows = [(w["paymentDateOnOrAfter"], w["paymentDateOnOrBefore"]) for p, w in fake.calls
               if p == "payments/search" and w["facilityId"] == "fac_a"]
    assert windows[0] == ("2026-09-15", "2026-09-30") and windows[-1] == ("2027-01-01", "2027-01-20")
    assert len(windows) == 5                                           # Sep..Jan, one per month
    # Next run: only the last 45 days are read again; a decline lands, the old row stays.
    fake.calls.clear()
    fake.payments["fac_a"] = [_pay("late", "2026-12-20", status="DECLINED")]
    cubby_sync.sync_all("schedule")
    windows = [(w["paymentDateOnOrAfter"], w["paymentDateOnOrBefore"]) for p, w in fake.calls
               if p == "payments/search" and w["facilityId"] == "fac_a"]
    assert windows == [("2026-12-06", "2026-12-31"), ("2027-01-01", "2027-01-20")]
    pays = {p.payment_id: p.status for p in _q(models.CubbyPayment, facility_id="fac_a")}
    assert pays == {"old": "SUCCEEDED", "late": "DECLINED"}


def test_payment_window_helpers():
    assert cubby_sync.payments_from("", date(2027, 3, 1)) == date(2026, 9, 15)
    assert cubby_sync.payments_from("2027-02-28", date(2027, 3, 1)) == date(2027, 1, 15)
    assert cubby_sync.payments_from("2026-09-30", date(2026, 10, 15)) == date(2026, 9, 15)
    assert cubby_sync.month_windows(date(2026, 12, 30), date(2027, 1, 2)) == [
        (date(2026, 12, 30), date(2026, 12, 31)), (date(2027, 1, 1), date(2027, 1, 2))]


def test_reads_come_from_the_database_without_calling_cubby(fake):
    cubby_sync.sync_all("schedule")
    cubby.forget()
    fake.down = True
    fake.calls.clear()
    data = cubby.summary()
    assert fake.calls == []
    assert [f["shortName"] for f in data["facilities"]] == ["Murrieta", "Temecula"]
    tem = data["facilities"][1]
    assert tem["units"] == {"total": 2, "rented": 1, "vacant": 1, "unavailable": 0}
    assert tem["pastDue"]["total"] == 30000 and tem["leads"]["rows"][0]["tenant"] == "Robin Lead"
    assert (tem["lat"], tem["lng"]) == (33.4936, -117.1484)
    assert data["syncStatus"] == "ok" and data["syncedAt"] and data["fetchedAt"] == data["syncedAt"]
    assert data["syncRunning"] is False and tem["syncedAt"]
    assert cubby.lookup("a1")[0]["balance"] == 30000
    assert cubby.report("rent-roll", "fac_a")["rows"][0][1] == "A1"
    assert fake.calls == []


def test_an_empty_database_reads_cubby_once_and_starts_a_sync(fake, monkeypatch):
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    kicked = []
    monkeypatch.setattr(cubby, "_kick_sync", lambda: kicked.append(1))
    data = cubby.summary()
    assert data["syncStatus"] == "live" and len(data["facilities"]) == 2 and kicked == [1]
    assert any(p == "reports/rent-roll" for p, _ in fake.calls)


def test_one_run_at_a_time(fake):
    rid = cubby_sync.claim("schedule")
    assert rid
    assert cubby_sync.sync_all("schedule") == {"status": "skipped"}
    assert cubby_sync.status()["running"] is True
    cubby_sync.run_claimed(rid)
    assert cubby_sync.status()["running"] is False and cubby_sync.status()["last"]["status"] == "ok"


def test_a_dead_run_does_not_hold_the_lock_forever(fake):
    db = SessionLocal()
    db.add(models.CubbySyncRun(id="dead", trigger="schedule", started_at="2026-10-01T00:00:00+00:00", status="running"))
    db.commit()
    db.close()
    assert cubby_sync.sync_all("schedule")["status"] == "ok"
    assert _q(models.CubbySyncRun, id="dead")[0].status == "failed"


# ── Refresh ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client(fake, monkeypatch):
    from routers import facility_ops
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    started = []
    monkeypatch.setattr(cubby_sync, "run_in_background", lambda rid: started.append(rid))
    app = FastAPI()
    app.include_router(facility_ops.router)
    user = {"email": "ops.manager@greensglobal.com", "role": "manager", "level": 3}
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    c.user, c.started, c.fake = user, started, fake
    return c


def test_refresh_starts_a_background_sync_and_refuses_a_second(client):
    r = client.post("/facility-ops/sync")
    assert r.status_code == 200 and client.started == [r.json()["runId"]]
    run = _q(models.CubbySyncRun, id=r.json()["runId"])[0]
    assert run.trigger == "manual" and run.requested_by == "ops.manager@greensglobal.com"
    again = client.post("/facility-ops/sync")
    assert again.status_code == 409 and "already running" in again.json()["detail"]
    assert client.get("/facility-ops/sync").json()["running"] is True
    cubby_sync.run_claimed(run.id)
    soon = client.post("/facility-ops/sync")
    assert soon.status_code == 429                                     # one per few minutes


def test_refresh_needs_the_operations_door(client):
    client.user.update({"role": "employee", "level": 1, "email": "someone@greensglobal.com"})
    assert client.post("/facility-ops/sync").status_code == 401
    assert client.started == []


# ── No key on this server (Oct 15: prod never had CUBBY_API_KEY set) ─────────

def test_reads_need_no_key_when_the_tables_are_filled(client, monkeypatch):
    cubby_sync.sync_all("schedule")
    cubby.forget()
    monkeypatch.delenv("CUBBY_API_KEY")
    r = client.get("/facility-ops/summary")
    assert r.status_code == 200
    body = r.json()
    assert len(body["facilities"]) == 2 and body["cubbyConfigured"] is False and body["syncStatus"] == "ok"
    assert client.get("/facility-ops/lookup?q=a1").json()["results"][0]["unit"] == "A1"
    assert client.get("/facility-ops/report/rent-roll").status_code == 200
    assert client.get("/facility-ops/sync").json()["configured"] is False


def test_no_key_and_empty_tables_says_not_configured(client, monkeypatch):
    monkeypatch.delenv("CUBBY_API_KEY")
    r = client.get("/facility-ops/summary")
    assert r.status_code == 200
    assert r.json()["syncStatus"] == "not_configured" and r.json()["facilities"] == []
    assert client.fake.calls == []                                      # no live pull without a key


def test_the_loop_records_a_missing_key_once_an_hour(fake, capsys):
    assert cubby_sync.record_not_configured() is True
    assert cubby_sync.record_not_configured() is False                 # 15 minutes later: no second row
    rows = _q(models.CubbySyncRun, status="not_configured")
    assert len(rows) == 1 and "CUBBY_API_KEY" in rows[0].error
    assert capsys.readouterr().out.count("CUBBY_API_KEY is not set") == 1
    st = cubby_sync.status()
    assert st["last"]["status"] == "not_configured" and st["running"] is False
    db = SessionLocal()
    db.query(models.CubbySyncRun).update({"started_at": "2026-10-01T00:00:00+00:00"})
    db.commit()
    db.close()
    assert cubby_sync.record_not_configured() is True                  # an hour on, it is recorded again


def test_refresh_without_a_key_is_503_with_the_message(client, monkeypatch):
    monkeypatch.delenv("CUBBY_API_KEY")
    r = client.post("/facility-ops/sync")
    assert r.status_code == 503 and "set CUBBY_API_KEY" in r.json()["detail"]
    assert client.started == []
