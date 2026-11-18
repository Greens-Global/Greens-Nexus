"""Cubby -> database sync (cubby_sync.py) and the database read path
(cubby.summary / lookup). Cubby is faked - nothing here calls it. Runs on the
throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_cubby_sync.py

Since 11/17/2026 (Neil) the sync also keeps a read-only copy of tenant
contact details in ops_tenants / ops_lease_extras (Operations > Tenants);
the cubby_* tables and their blobs stay stripped, which the first test and
the tenant tests at the end both pin."""
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import cubby_sync
import models
import secret_box
from auth import get_current_user
from database import SessionLocal

TABLES = (models.CubbyFacility, models.CubbyUnit, models.CubbyRental, models.CubbyCustomer, models.CubbyPayment,
          models.CubbyLead, models.CubbyReceivable, models.CubbyTask, models.CubbySyncRun, models.CubbyDailySnapshot,
          models.OpsTenant, models.OpsLeaseExtra)

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
                                      "customer": {"name": f"Tenant {p}1", "emailAddress": "t@example.com", "idNumber": "D1234567"},
                                      "alternativeContacts": [{"name": "Sam Backup", "phone": "+15555550177", "email": "sam@alt.test"}],
                                      "storingVehicle": True,
                                      "vehicle": {"type": "RV", "licenseNumber": "7abc 123", "state": "CA"}},
                                     {"leaseId": f"lease_{p}0", "unitId": f"{p}2", "customerId": f"cust_{p}0",
                                      "moveInDate": "2024-01-01", "moveOutDate": "2024-06-30"}]},
        "leads/search": {"leads": [{"leadId": f"lead_{p}", "customerId": f"cust_l{p}", "status": "NEW", "createdAt": "2026-10-01T00:00:00Z"}]},
        "customers/search": {"customers": [
            {"customerId": f"cust_l{p}", "firstName": "Robin", "lastName": "Lead", "contact": CONTACT, "driversLicense": "X99"},
            {"customerId": f"cust_{p}1", "name": f"Tenant {p}1", "firstName": "Tenant", "lastName": f"{p}1",
             "companyName": "Acme Hauling", "updatedAt": "2026-10-14T10:00:00Z", "military": True,
             "dateOfBirth": "1975-05-05", "idType": "DRIVERS_LICENSE", "idNumber": "N7654321",
             "contact": {"address": "22 Oak Ave", "address2": "Apt 4", "city": "Temecula", "state": "CA", "country": "US",
                         "zip": "92591", "email": f"Tenant.{p}1@Mail.test", "phone": "+1 (555) 555-0142"},
             "communicationPreferences": {"sms": {"marketing": False, "suppressed": False, "suppressionReason": None},
                                          "email": {"marketing": True, "suppressed": False, "suppressionReason": None}}},
            {"customerId": f"cust_{p}0", "name": f"Former {p}0", "contact": {"phone": "555-555-0155"}},
            {"customerId": "cust_nobody", "name": "Not Referenced", "contact": CONTACT}]},
        "tasks/search": {"tasks": [{"taskId": f"task_{p}", "title": "Sweep aisle B", "dueDate": "2026-10-10"}]},
    }


class FakeCubby:
    def __init__(self):
        self.calls = []
        self.fail = {}             # facility id -> path that answers 500
        self.down = False          # every call fails
        self.codes_denied = set()  # facility ids whose access-codes/search answers 403
        self.no_pii = False        # the key has no PII access: customers come without their contact block
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
        if path == "access-codes/search":
            if fid in self.codes_denied:
                raise cubby.CubbyError(403, "access-codes/search: Access Denied")
            p = fid[-1]
            return {"accessCodes": [{"code": f"48{p}15", "enabled": False, "customerId": f"cust_{p}1"},
                                    {"code": f"73{p}91", "enabled": True, "customerId": f"cust_{p}1"},
                                    {"code": "0000", "enabled": True, "customerId": "cust_elsewhere"}]}
        if path == "customers/search" and self.no_pii:
            return {"customers": [{k: v for k, v in c.items() if k != "contact"}
                                  for c in _rows_for(fid)[path]["customers"]]}
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
    assert len(_q(models.CubbyUnit)) == 4 and len(_q(models.CubbyRental)) == 4
    assert len(_q(models.CubbyLead)) == 2 and len(_q(models.CubbyReceivable)) == 2 and len(_q(models.CubbyTask)) == 2
    assert [p.amount_cents for p in _q(models.CubbyPayment)] == [10000]
    custs = {c.customer_id: c.name for c in _q(models.CubbyCustomer, facility_id="fac_a")}
    # name only, and only someone a row points at
    assert custs == {"cust_la": "Robin Lead", "cust_a1": "Tenant a1", "cust_a0": "Former a0"}
    fac = _q(models.CubbyFacility, facility_id="fac_a")[0]
    assert fac.organization == "Greens Storage" and fac.payments_synced_through == "2026-10-15" and fac.synced_at
    assert "phone" not in fac.data and "address" not in fac.data and fac.data["latitude"] == "33.4936"
    stored = repr([(r.data) for t in (models.CubbyUnit, models.CubbyRental, models.CubbyReceivable, models.CubbyPayment,
                                      models.CubbyLead, models.CubbyTask) for r in _q(t)])
    stored += repr([(c.customer_id, c.name) for c in _q(models.CubbyCustomer)])
    for secret in ("example.com", "5555550100", "5555550101", "1 Main St", "1980-01-01", "D1234567", "92590", "X99",
                   "22 Oak Ave", "92591", "Mail.test", "mail.test", "555-0142", "5555550142", "1975-05-05", "N7654321",
                   "Sam Backup", "5555550177", "alt.test", "7abc 123", "7ABC 123", "73a91", "48a15"):
        assert secret not in stored                                  # the cubby_* tables stay stripped (Neil, 11/17/2026)
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
    assert len(_q(models.CubbyRental, facility_id="fac_b")) == 2        # last good copy stays
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
    windows = sorted((w["paymentDateOnOrAfter"], w["paymentDateOnOrBefore"]) for p, w in fake.calls
                     if p == "payments/search" and w["facilityId"] == "fac_a")   # sorted: the pool does not keep the order
    assert windows[0] == ("2026-09-15", "2026-09-30") and windows[-1] == ("2027-01-01", "2027-01-20")
    assert len(windows) == 5                                           # Sep..Jan, one per month
    # Next run: only the last 45 days are read again; a decline lands, the old row stays.
    fake.calls.clear()
    fake.payments["fac_a"] = [_pay("late", "2026-12-20", status="DECLINED")]
    cubby_sync.sync_all("schedule")
    windows = sorted((w["paymentDateOnOrAfter"], w["paymentDateOnOrBefore"]) for p, w in fake.calls
                     if p == "payments/search" and w["facilityId"] == "fac_a")   # sorted: the pool does not keep the order
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


# ── Tenant details (Operations > Tenants, Neil, 11/17/2026) ──────────────────

def _everything_stored() -> str:
    """Every column of every row the sync wrote, as text."""
    db = SessionLocal()
    try:
        return repr([[getattr(r, c.name) for c in t.__table__.columns] for t in TABLES for r in db.query(t).all()])
    finally:
        db.close()


def test_tenant_contact_details_are_kept_in_ops_tenants_only(fake):
    fake.payments["fac_a"] = [_pay("p1", "2026-10-01")]
    logged = len(_q(models.AuditChange))
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "ok" and "warnings" not in out["facilities"]["fac_a"]
    counts = out["facilities"]["fac_a"]["counts"]
    assert (counts["tenants"], counts["tenants_with_phone"], counts["lease_extras"]) == (3, 3, 1)

    rows = {t.customer_id: t for t in _q(models.OpsTenant, facility_id="fac_a")}
    assert set(rows) == {"cust_a1", "cust_a0", "cust_la"}             # everyone a row points at; never cust_nobody
    t = rows["cust_a1"]
    assert t.id == "fac_a:cust_a1" and (t.name, t.first_name, t.last_name, t.company_name) == ("Tenant a1", "Tenant", "a1", "Acme Hauling")
    assert (t.email, t.phone, t.phone_digits) == ("tenant.a1@mail.test", "+1 (555) 555-0142", "15555550142")
    assert (t.address, t.address2, t.city, t.state, t.zip, t.country) == ("22 Oak Ave", "Apt 4", "Temecula", "CA", "92591", "US")
    assert t.military is True and t.comm_prefs["email"]["marketing"] is True
    assert t.cubby_updated_at == "2026-10-14T10:00:00Z" and t.synced_at
    assert t.current is True and t.unit_names == "A1"
    for word in ("tenant a1", "acme hauling", "tenant.a1@mail.test", "a1", "7abc 123", "7abc123"):
        assert word in t.search_text
    # The gate code: encrypted at rest, the enabled one of the two, found by its keyed hash.
    assert "73a91" not in t.gate_code and secret_box.decrypt(t.gate_code) == "73a91" and t.gate_code_enabled is True
    assert t.gate_code_hash == cubby_sync.gate_code_hash(" 73a91 ") and "73a91" not in t.gate_code_hash
    assert cubby_sync.gate_code_hash("") == ""

    former, lead = rows["cust_a0"], rows["cust_la"]
    assert former.current is False and former.unit_names == "" and former.phone_digits == "5555550155"
    assert former.gate_code == "" and former.gate_code_hash == ""
    assert lead.current is False and lead.name == "Robin Lead" and lead.email == "tenant@example.com"

    extra = _q(models.OpsLeaseExtra, facility_id="fac_a")
    assert [(e.id, e.lease_id, e.customer_id, e.unit_id) for e in extra] == [("fac_a:lease_a1", "lease_a1", "cust_a1", "a1")]
    assert extra[0].alt_contacts == [{"name": "Sam Backup", "phone": "+15555550177", "email": "sam@alt.test"}]
    assert (extra[0].vehicle_type, extra[0].vehicle_plate, extra[0].vehicle_state) == ("RV", "7ABC 123", "CA")

    # Never stored, in any table: date of birth, ID type, ID number.
    everything = _everything_stored()
    for never in ("1975-05-05", "1980-01-01", "N7654321", "D1234567", "DRIVERS_LICENSE", "X99"):
        assert never not in everything
    # And a synced-in copy is not a change anyone audits: no phone number in the change log.
    assert len(_q(models.AuditChange)) == logged


def test_a_second_sync_replaces_the_tenant_rows(fake):
    cubby_sync.sync_all("schedule")
    cubby_sync.sync_all("schedule")
    assert len(_q(models.OpsTenant)) == 6 and len(_q(models.OpsLeaseExtra)) == 2


def test_a_403_on_gate_codes_is_a_warning_not_a_failure(fake):
    fake.codes_denied = {"fac_a"}
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "ok" and out["facilities"]["fac_a"]["status"] == "ok"
    assert out["facilities"]["fac_a"]["warnings"] == ["access_codes: access-codes/search: Access Denied"]
    assert "warnings" not in out["facilities"]["fac_b"]
    run = _q(models.CubbySyncRun)[0]
    assert run.status == "ok" and run.error == "" and run.facilities["fac_a"]["warnings"]
    a = {t.customer_id: t for t in _q(models.OpsTenant, facility_id="fac_a")}
    assert a["cust_a1"].gate_code == "" and a["cust_a1"].gate_code_hash == "" and a["cust_a1"].phone   # the rest is there
    b = {t.customer_id: t for t in _q(models.OpsTenant, facility_id="fac_b")}
    assert secret_box.decrypt(b["cust_b1"].gate_code) == "73b91"
    assert len(_q(models.CubbyUnit)) == 4                              # and the facility's figures were saved


def test_a_key_without_pii_access_gives_blank_contact_fields(fake):
    fake.no_pii = True
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "ok"
    counts = out["facilities"]["fac_a"]["counts"]
    assert (counts["tenants"], counts["tenants_with_phone"]) == (3, 0)
    t = _q(models.OpsTenant, id="fac_a:cust_a1")[0]
    assert t.name == "Tenant a1" and t.current is True and t.unit_names == "A1"
    assert (t.email, t.phone, t.phone_digits, t.address, t.city, t.zip) == ("", "", "", "", "", "")


def test_a_broken_tenant_write_keeps_the_last_copy_and_the_facility(fake, monkeypatch, capsys):
    cubby_sync.sync_all("schedule")

    def half_done(db, fid, tenants, extras):                           # the delete went through, the insert did not
        t = models.OpsTenant.__table__
        db.execute(t.delete().where(t.c.facility_id == fid))
        raise ValueError("+1 (555) 555-0142")
    monkeypatch.setattr(cubby_sync, "_write_tenants", half_done)
    out = cubby_sync.sync_all("schedule")
    assert out["status"] == "ok"
    fac = out["facilities"]["fac_a"]
    assert fac["warnings"] == ["tenants: kept from the previous sync (ValueError)"] and fac["counts"]["units"] == 2
    assert len(_q(models.OpsTenant, facility_id="fac_a")) == 3         # the previous rows
    assert "555-0142" not in capsys.readouterr().out                   # the type only, never a value
