"""Operations > Tenants (routers/ops_tenants.py, Neil, 11/17/2026): the
directory, one tenant's record with its live re-read, and the access rules.
The rows are written by the real sync writer (cubby_sync._write_facility)
from fake Cubby payloads; nothing here calls Cubby.

Throwaway SQLite. Run alone: python -m pytest test_ops_tenants.py
"""
import atexit
import json
import os
import tempfile
import time
from datetime import date

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cubby  # noqa: E402
import cubby_sync  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import ops_access  # noqa: E402
import secret_box  # noqa: E402
from auth import get_current_user  # noqa: E402
from routers import ops_tenants  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

TODAY = date(2026, 11, 17)
ADMIN = {"email": "admin@greensglobal.com", "role": "administrator", "level": 4}
LEAD = "site.lead@greensglobal.com"


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


def _customer(cid, first, last, phone, email, company="", **more):
    return {"customerId": cid, "name": f"{first} {last}", "firstName": first, "lastName": last, "companyName": company,
            "updatedAt": "2026-11-01T10:00:00Z", "military": False,
            "dateOfBirth": "1970-02-03", "idType": "PASSPORT", "idNumber": "P5550001",
            "contact": {"address": "22 Oak Ave", "address2": "", "city": "Temecula", "state": "CA", "country": "US",
                        "zip": "92591", "email": email, "phone": phone},
            "communicationPreferences": {"sms": {"marketing": True, "suppressed": False, "suppressionReason": None},
                                         "email": {"marketing": False, "suppressed": False, "suppressionReason": None}},
            **more}


MARIA = _customer("cust_1", "Maria", "Lopez", "+1 (760) 555-0111", "Maria.Lopez@mail.test")
JOHN = _customer("cust_2", "John", "Smith", "+17605550122", "john@smithhauling.test", company="Smith Hauling")
ZED = _customer("cust_3", "Zed", "Former", "760-555-0133", "zed@mail.test")
OMAR = _customer("cust_5", "Omar", "Khan", "+1 951 555 0188", "omar@mail.test")
LENA = _customer("cust_9", "Lena", "Lead", "+17605550199", "lena@mail.test")


def _pulled_a() -> dict:
    return {
        "today": TODAY, "payments_from": date(2026, 9, 15),
        "rent_roll": [
            {"unitId": "a1", "unitName": "A101", "status": "RENTED", "width": 10, "depth": 10, "standardRate": 16000,
             "monthlyRentalAmount": 15000, "customerId": "cust_1", "customerName": "Maria Lopez", "paid": True,
             "paidThroughDate": "2026-11-30", "autoPayEnabled": True, "overlockNeeded": False, "overlockApplied": False,
             "pricingGroupName": "10x10", "moveInDate": "2025-03-01"},
            {"unitId": "a2", "unitName": "A102", "status": "RENTED", "width": 10, "depth": 20, "standardRate": 21000,
             "monthlyRentalAmount": 20000, "customerId": "cust_2", "customerName": "John Smith", "companyName": "Smith Hauling",
             "paid": False, "paidThroughDate": "2026-10-31", "autoPayEnabled": False, "overlockNeeded": True,
             "overlockApplied": False, "pricingGroupName": "10x20", "moveInDate": "2024-06-01"},
            {"unitId": "a3", "unitName": "B211", "status": "RENTED", "width": 5, "depth": 10, "standardRate": 9000,
             "monthlyRentalAmount": 8500, "customerId": "cust_2", "customerName": "John Smith", "paid": True,
             "paidThroughDate": "2026-11-30", "autoPayEnabled": True, "pricingGroupName": "5x10", "moveInDate": "2026-01-10"},
            {"unitId": "a4", "unitName": "C300", "status": "VACANT", "width": 10, "depth": 30, "standardRate": 30000,
             "pricingGroupName": "10x30"},
        ],
        "receivables": [{"unitId": "a2", "unitName": "A102", "customerId": "cust_2", "customerName": "John Smith",
                         "totalAmount": 4500, "ranges": [{"range": "RANGE_0_30", "amount": 4500}]}],
        "units": [{"unitId": u, "name": n} for u, n in (("a1", "A101"), ("a2", "A102"), ("a3", "B211"), ("a4", "C300"))],
        "leases": [
            {"leaseId": "l1", "unitId": "a1", "customerId": "cust_1", "moveInDate": "2025-03-01", "moveOutDate": None,
             "monthlyRentalAmount": 15000,
             "coverage": {"coverageType": "ORGANISATION", "coverageAmount": 500000, "premiumAmount": 1200},
             "alternativeContacts": [{"name": "Rosa Lopez", "phone": "+17605550144", "email": "rosa@mail.test"}],
             "storingVehicle": True, "vehicle": {"type": "RV", "licenseNumber": "7abc123", "state": "CA"}},
            {"leaseId": "l2", "unitId": "a2", "customerId": "cust_2", "moveInDate": "2024-06-01", "moveOutDate": None,
             "monthlyRentalAmount": 20000, "coverage": {"coverageType": "PRIVATE_POLICY"},
             "privatePolicyNumber": "PP-889", "privatePolicyExpirationDate": "2027-01-31",
             "scheduledMoveOut": {"moveOutDate": "2026-12-15", "reason": "RELOCATING"}},
            {"leaseId": "l3", "unitId": "a3", "customerId": "cust_2", "moveInDate": "2026-01-10", "moveOutDate": None,
             "monthlyRentalAmount": 8500},
            {"leaseId": "l4", "unitId": "a4", "customerId": "cust_3", "moveInDate": "2023-01-01", "moveOutDate": "2024-02-01",
             "monthlyRentalAmount": 25000},
        ],
        "leads": [{"leadId": "lead_1", "customerId": "cust_9", "status": "NEW", "createdAt": "2026-11-01T00:00:00Z"}],
        "customers": [MARIA, JOHN, ZED, LENA],
        "tasks": [],
        "access_codes": [{"code": "4821", "enabled": True, "customerId": "cust_1"},
                         {"code": "9053", "enabled": True, "customerId": "cust_2"}],
        "payments": [{"paymentId": f"pay_{i:02d}", "paymentDate": f"2026-10-{i:02d}", "createdAt": f"2026-10-{i:02d}T09:00:00Z",
                      "status": "SUCCEEDED" if i != 26 else "DECLINED", "amount": 20000 + i, "customerId": "cust_2",
                      "methodType": "CREDIT_CARD"} for i in range(1, 27)],
    }


def _pulled_b() -> dict:
    return {
        "today": TODAY, "payments_from": date(2026, 9, 15), "payments": [], "receivables": [], "leads": [], "tasks": [],
        "rent_roll": [
            {"unitId": "b1", "unitName": "A101", "status": "RENTED", "width": 10, "depth": 10, "standardRate": 14000,
             "monthlyRentalAmount": 14000, "customerId": "cust_1", "customerName": "Maria Lopez", "paid": True,
             "paidThroughDate": "2026-12-31", "autoPayEnabled": False, "pricingGroupName": "10x10"},
            {"unitId": "b2", "unitName": "D5", "status": "RENTED", "width": 5, "depth": 5, "standardRate": 6000,
             "monthlyRentalAmount": 6000, "customerId": "cust_5", "customerName": "Omar Khan", "paid": True,
             "paidThroughDate": "2026-11-30", "autoPayEnabled": True, "pricingGroupName": "5x5"},
        ],
        "units": [{"unitId": "b1", "name": "A101"}, {"unitId": "b2", "name": "D5"}],
        "leases": [{"leaseId": "l5", "unitId": "b1", "customerId": "cust_1", "moveInDate": "2026-02-01", "moveOutDate": None},
                   {"leaseId": "l6", "unitId": "b2", "customerId": "cust_5", "moveInDate": "2026-05-01", "moveOutDate": None,
                    "storingVehicle": True, "vehicle": {"type": "MOTORCYCLE", "licenseNumber": "22M 4455", "state": "CA"}}],
        "customers": [MARIA, OMAR],
        "access_codes": [{"code": "7777", "enabled": False, "customerId": "cust_1"},
                         {"code": "3131", "enabled": True, "customerId": "cust_5"}],
    }


FACS = [({"facilityId": "fac_a", "name": "Greens Storage Temecula", "timeZone": "America/Los_Angeles"}, _pulled_a),
        ({"facilityId": "fac_b", "name": "Greens Storage Murrieta", "timeZone": "America/Los_Angeles"}, _pulled_b)]
SYNCED = "2026-11-17T08:00:00+00:00"


def _seed():
    db = database.SessionLocal()
    try:
        for fac, pulled in FACS:
            cubby_sync._write_facility(db, "Greens Storage", fac, pulled(), SYNCED)
        for row in (models.NexusEmployee(id="e1", first_name="Sita", last_name="Lead", work_email=LEAD),
                    models.NexusEmployee(id="e2", first_name="Ajay", last_name="Rao", work_email="Ajay.Rao@greensglobal.com",
                                         display_name="Ajay Kumar Rao"),
                    models.NexusGroup(id="grp_sites", name="Site Managers", is_job_role=1),
                    models.NexusGroup(id="grp_calls", name="Call Center"),
                    models.NexusGroupMember(group_id="grp_sites", email=LEAD)):
            db.add(row)
        db.commit()
    finally:
        db.close()


_seed()


@pytest.fixture
def client(monkeypatch):
    db = database.SessionLocal()
    try:
        db.query(models.OpsAccessRule).delete()
        db.query(models.AuditLog).delete()
        db.commit()
        # Each test starts from what the sync wrote (one of them changes a tenant through the live re-read).
        for fac, pulled in FACS:
            cubby_sync._write_facility(db, "Greens Storage", fac, pulled(), SYNCED)
        db.commit()
    finally:
        db.close()
    monkeypatch.delenv("CUBBY_API_KEY", raising=False)     # each test says whether this server can reach Cubby
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: TODAY)
    app = FastAPI()
    app.include_router(ops_tenants.router)
    user = dict(ADMIN)
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    c.user = user
    return c


def _as(client, email=LEAD, level=2):
    client.user.clear()
    client.user.update({"email": email, "role": "supervisor" if level < 4 else "administrator", "level": level})


def _rule(kind, sid, facilities, details=True):
    db = database.SessionLocal()
    try:
        db.add(models.OpsAccessRule(id=f"{kind}-{sid}", subject_type=kind, subject_id=sid,
                                    facility_ids=facilities, tenant_details=details))
        db.commit()
    finally:
        db.close()


def _q(model, **flt):
    db = database.SessionLocal()
    try:
        return db.query(model).filter_by(**flt).all()
    finally:
        db.close()


def _names(client, **params):
    body = client.get("/facility-ops/tenants", params=params).json()
    return [(r["name"], r["facilityId"]) for r in body["rows"]], body["total"]


# ── Who gets in ───────────────────────────────────────────────────────────────

def test_without_tenant_details_the_directory_and_the_record_are_403(client):
    _as(client, level=3)                                               # a Manager with no rule
    for url in ("/facility-ops/tenants", "/facility-ops/tenants/cust_1"):
        r = client.get(url)
        assert r.status_code == 403 and r.json() == {"detail": "You do not have access to tenant details."}
    assert client.get("/facility-ops/access/me").json() == {"facilities": None, "tenantDetails": False, "canManage": False}
    _rule("person", LEAD, ["fac_a"], details=False)                    # facilities alone do not open tenant details
    assert client.get("/facility-ops/tenants").status_code == 403
    assert _q(models.AuditLog) == []                                   # nothing was opened


def test_the_operations_door_comes_first(client):
    _as(client, "nobody@greensglobal.com", level=1)
    _rule("person", "nobody@greensglobal.com", [], details=True)
    assert client.get("/facility-ops/tenants").status_code == 401
    assert client.get("/facility-ops/access/me").status_code == 401


def test_a_rule_limits_the_facilities(client):
    _as(client)
    _rule("group", "grp_sites", ["fac_b"])                             # through the job role they belong to
    assert client.get("/facility-ops/access/me").json() == {"facilities": ["fac_b"], "tenantDetails": True, "canManage": False}
    assert _names(client, status="all") == ([("Maria Lopez", "fac_b"), ("Omar Khan", "fac_b")], 2)
    assert _names(client, status="all", facility="fac_a") == ([], 0)   # asking for the other one finds nothing
    assert _names(client, status="all", q="smith") == ([], 0)
    assert client.get("/facility-ops/tenants/cust_2").status_code == 404   # only at a facility they do not see
    rec = client.get("/facility-ops/tenants/cust_1").json()            # at both: only theirs comes back
    assert [f["facilityId"] for f in rec["facilities"]] == ["fac_b"] and [le["leaseId"] for le in rec["leases"]] == ["l5"]
    assert json.loads(_q(models.AuditLog, action="ops_tenant_opened")[0].details)["facilities"] == ["fac_b"]


def test_an_administrator_sees_every_facility(client):
    assert client.get("/facility-ops/access/me").json() == {"facilities": None, "tenantDetails": True, "canManage": True}
    assert _names(client, status="current")[1] == 4


# ── The directory ─────────────────────────────────────────────────────────────

def test_current_former_all_and_the_order(client):
    assert _names(client) == _names(client, status="current")          # current is what the screen opens on
    assert _names(client, status="current") == ([("John Smith", "fac_a"), ("Maria Lopez", "fac_a"),
                                                 ("Maria Lopez", "fac_b"), ("Omar Khan", "fac_b")], 4)
    assert _names(client, status="former") == ([("Zed Former", "fac_a")], 1)
    # All: current first, then the name. A lead never rented, so she is no tenant - not even a former one.
    assert _names(client, status="all") == ([("John Smith", "fac_a"), ("Maria Lopez", "fac_a"), ("Maria Lopez", "fac_b"),
                                             ("Omar Khan", "fac_b"), ("Zed Former", "fac_a")], 5)
    assert _names(client, status="all", q="lena") == ([], 0)
    assert _q(models.OpsTenant, id="fac_a:cust_9")[0].name == "Lena Lead"      # though the sync keeps her row
    assert client.get("/facility-ops/tenants", params={"status": "everyone"}).status_code == 422


def test_the_state_choice_narrows_to_its_facilities(client):
    # The page's State picker sends the facilities of that state by id; one
    # the caller cannot see or that does not exist adds nothing.
    assert _names(client, facilities="fac_b,fac_nowhere") == ([("Maria Lopez", "fac_b"), ("Omar Khan", "fac_b")], 2)
    assert _names(client, facilities="fac_a, fac_b")[1] == 4
    assert _names(client, facility="fac_a", facilities="fac_b") == ([], 0)     # both narrow


def test_paging_and_the_total(client):
    seen = []
    for offset in (0, 2, 4):
        body = client.get("/facility-ops/tenants", params={"status": "all", "limit": 2, "offset": offset}).json()
        assert body["total"] == 5 and len(body["rows"]) == (2 if offset < 4 else 1)
        seen += [(r["name"], r["facilityId"]) for r in body["rows"]]
    assert seen == _names(client, status="all")[0]
    assert _names(client, status="all", limit=2, offset=10) == ([], 5)
    assert client.get("/facility-ops/tenants", params={"limit": 0}).status_code == 422
    assert client.get("/facility-ops/tenants", params={"limit": 5000}).status_code == 422


def test_search(client):
    def find(q, **more):
        return _names(client, status="all", q=q, **more)[0]
    assert find("lopez") == [("Maria Lopez", "fac_a"), ("Maria Lopez", "fac_b")]                # a name
    assert find("LOPEZ  maria") == find("lopez")                                                # any case, any order
    assert find("lopez", facility="fac_b") == [("Maria Lopez", "fac_b")]
    assert find("smith hauling") == [("John Smith", "fac_a")]                                   # the company
    assert find("maria.lopez@MAIL.test") == find("lopez")                                       # the email
    assert find("b211") == [("John Smith", "fac_a")]                                            # a unit
    assert find("smith a102") == [("John Smith", "fac_a")] and find("lopez b211") == []         # every word must be there
    assert find("7abc123") == [("Maria Lopez", "fac_a")]                                        # a plate
    assert find("22m4455") == find("22M 4455") == [("Omar Khan", "fac_b")]                      # with or without its space
    assert find("(951) 555-0188") == [("Omar Khan", "fac_b")]                                   # a phone number, however typed
    assert find("5550133") == [("Zed Former", "fac_a")] and find("0133") == [("Zed Former", "fac_a")]
    assert find("013") == []                                                                    # under four digits is no phone
    assert find("9053") == [("John Smith", "fac_a")] and find(" 3131 ") == [("Omar Khan", "fac_b")]   # a gate code, exactly
    assert find("905") == [] and find("90530") == []
    assert find("100%") == [] and find("_") == []                                               # % and _ are just characters


def test_a_directory_row(client):
    body = client.get("/facility-ops/tenants", params={"status": "all"}).json()
    assert body["syncedAt"] == SYNCED
    rows = {(r["customerId"], r["facilityId"]): r for r in body["rows"]}
    assert rows[("cust_2", "fac_a")] == {
        "customerId": "cust_2", "facilityId": "fac_a", "facilityName": "Temecula", "name": "John Smith",
        "companyName": "Smith Hauling", "phone": "+17605550122", "email": "john@smithhauling.test",
        "units": ["A102", "B211"], "current": True, "balanceCents": 4500,
        "paidThrough": "2026-10-31",        # two units: the one furthest behind
        "autopay": False,                   # ... and only one of the two is on autopay
        "plates": []}
    maria = rows[("cust_1", "fac_a")]
    assert (maria["autopay"], maria["paidThrough"], maria["balanceCents"], maria["plates"]) == (True, "2026-11-30", 0, ["7ABC123"])
    assert rows[("cust_1", "fac_b")]["autopay"] is False and rows[("cust_1", "fac_b")]["facilityName"] == "Murrieta"
    zed = rows[("cust_3", "fac_a")]
    assert (zed["current"], zed["units"], zed["autopay"], zed["paidThrough"]) == (False, [], None, "")
    assert "gate" not in json.dumps(body).lower()                      # the list never carries a gate code


# ── One tenant ────────────────────────────────────────────────────────────────

def test_the_record_from_the_stored_copy(client):
    r = client.get("/facility-ops/tenants/cust_2")
    assert r.status_code == 200
    rec = r.json()
    assert set(rec) == {"customerId", "cubbyUrl", "name", "firstName", "lastName", "companyName", "military", "contact", "commPrefs",
                        "facilities", "leases", "payments", "live", "storedAsOf"}
    assert (rec["customerId"], rec["name"], rec["firstName"], rec["lastName"], rec["companyName"], rec["military"]) == \
        ("cust_2", "John Smith", "John", "Smith", "Smith Hauling", False)
    assert rec["contact"] == {"phone": "+17605550122", "email": "john@smithhauling.test", "address": "22 Oak Ave",
                              "address2": "", "city": "Temecula", "state": "CA", "zip": "92591", "country": "US"}
    assert rec["commPrefs"]["sms"] == {"marketing": True, "suppressed": False, "suppressionReason": None}
    assert rec["facilities"] == [{"facilityId": "fac_a", "facilityName": "Temecula", "gateCode": "9053", "gateCodeEnabled": True}]
    # No key on this server (local dev): no call out, the stored copy, and it says so.
    assert rec["live"]["ok"] is False and rec["live"]["error"] == "Cubby is not connected on this server." and rec["live"]["asOf"]
    assert rec["storedAsOf"] == SYNCED

    assert [le["leaseId"] for le in rec["leases"]] == ["l3", "l2"]     # the newest move-in first
    l2 = rec["leases"][1]
    assert l2 == {"leaseId": "l2", "facilityId": "fac_a", "facilityName": "Temecula", "unitId": "a2", "unitName": "A102",
                  "unitSize": "10x20", "moveIn": "2024-06-01", "moveOut": "", "rentCents": 20000, "paidThrough": "2026-10-31",
                  "paid": False, "autopay": False, "balanceCents": 4500, "overlockNeeded": True,
                  "coverage": {"type": "Private Policy", "premiumCents": 0, "amountCents": 0},
                  "privatePolicy": {"number": "PP-889", "expires": "2027-01-31"},
                  "scheduledMoveOut": {"date": "2026-12-15", "reason": "RELOCATING"},
                  "vehicle": None, "altContacts": []}
    l3 = rec["leases"][0]
    assert (l3["unitName"], l3["rentCents"], l3["paid"], l3["autopay"], l3["balanceCents"], l3["overlockNeeded"]) == \
        ("B211", 8500, True, True, 0, False)
    assert (l3["coverage"], l3["privatePolicy"], l3["scheduledMoveOut"]) == (None, None, None)

    assert len(rec["payments"]) == 24                                  # newest first, 24 at most
    assert rec["payments"][0] == {"paymentId": "pay_26", "date": "2026-10-26", "amountCents": 20026,
                                  "status": "DECLINED", "method": "CREDIT_CARD"}   # Cubby's codes; the screen words them
    assert [p["date"] for p in rec["payments"]] == sorted((p["date"] for p in rec["payments"]), reverse=True)
    # Never anywhere: date of birth, ID type, ID number.
    for never in ("1970-02-03", "PASSPORT", "P5550001"):
        assert never not in r.text


def test_the_record_spans_the_facilities_and_carries_the_lease_extras(client):
    rec = client.get("/facility-ops/tenants/cust_1").json()
    assert rec["facilities"] == [{"facilityId": "fac_a", "facilityName": "Temecula", "gateCode": "4821", "gateCodeEnabled": True},
                                 {"facilityId": "fac_b", "facilityName": "Murrieta", "gateCode": "7777", "gateCodeEnabled": False}]
    by = {le["leaseId"]: le for le in rec["leases"]}
    assert set(by) == {"l1", "l5"}
    assert by["l1"]["vehicle"] == {"type": "RV", "plate": "7ABC123", "state": "CA"}
    assert by["l1"]["altContacts"] == [{"name": "Rosa Lopez", "phone": "+17605550144", "email": "rosa@mail.test"}]
    assert by["l1"]["coverage"] == {"type": "Facility Plan", "premiumCents": 1200, "amountCents": 500000}
    assert (by["l5"]["facilityName"], by["l5"]["unitName"], by["l5"]["rentCents"], by["l5"]["vehicle"]) == ("Murrieta", "A101", 14000, None)
    assert rec["contact"]["email"] == "maria.lopez@mail.test" and rec["payments"] == []


def test_a_former_tenant_and_an_unknown_one(client):
    rec = client.get("/facility-ops/tenants/cust_3").json()
    le = rec["leases"][0]
    assert (le["moveOut"], le["rentCents"], le["paid"], le["autopay"], le["paidThrough"]) == ("2024-02-01", 25000, None, None, "")
    assert rec["facilities"][0]["gateCode"] == ""
    assert client.get("/facility-ops/tenants/cust_nobody").status_code == 404
    assert len(_q(models.AuditLog, action="ops_tenant_opened")) == 1   # a 404 opened nothing


def _live(monkeypatch, answer):
    """Give this server a Cubby key and answer its live reads with `answer(path, where)`."""
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    calls = []

    def read(path, where):
        calls.append((path, dict(where)))
        return answer(path, where)
    monkeypatch.setattr(ops_tenants, "_cubby_read", read)
    return calls


def test_a_live_read_is_returned_and_updates_the_stored_copy(client, monkeypatch):
    moved = _customer("cust_1", "Maria", "Lopez-Reyes", "+1 (760) 555-0666", "maria.reyes@mail.test",
                      dateOfBirth="1970-02-03", idNumber="P5550001")

    def answer(path, where):
        if path == "customers/search":
            # Cubby is trusted for nothing: a row for somebody else is ignored.
            return {"customers": [_customer("cust_other", "Wrong", "Person", "+10000000000", "wrong@mail.test"), moved]}
        return {"accessCodes": [{"code": "5150" if where["facilityId"] == "fac_a" else "7777", "enabled": True,
                                 "customerId": "cust_1"},
                                {"code": "0001", "enabled": True, "customerId": "cust_other"}]}
    calls = _live(monkeypatch, answer)
    logged = len(_q(models.AuditChange))

    rec = client.get("/facility-ops/tenants/cust_1").json()
    assert rec["live"]["ok"] is True and rec["live"]["error"] == "" and rec["live"]["asOf"] > SYNCED
    assert (rec["name"], rec["lastName"]) == ("Maria Lopez-Reyes", "Lopez-Reyes")
    assert rec["contact"]["phone"] == "+1 (760) 555-0666" and rec["contact"]["email"] == "maria.reyes@mail.test"
    assert [(f["gateCode"], f["gateCodeEnabled"]) for f in rec["facilities"]] == [("5150", True), ("7777", True)]
    assert rec["storedAsOf"] == rec["live"]["asOf"]
    # Every live search is scoped to a facility and to this customer.
    assert sorted(calls, key=str) == sorted([("customers/search", {"facilityId": "fac_a", "customerId": "cust_1"}),
                                             ("access-codes/search", {"facilityId": "fac_a", "customerId": "cust_1"}),
                                             ("access-codes/search", {"facilityId": "fac_b", "customerId": "cust_1"})], key=str)

    for fid, code in (("fac_a", "5150"), ("fac_b", "7777")):
        t = _q(models.OpsTenant, id=f"{fid}:cust_1")[0]
        assert (t.name, t.phone, t.phone_digits, t.email) == ("Maria Lopez-Reyes", "+1 (760) 555-0666", "17605550666", "maria.reyes@mail.test")
        assert secret_box.decrypt(t.gate_code) == code and t.gate_code_hash == cubby_sync.gate_code_hash(code)
        assert t.gate_code_enabled is True and t.synced_at == rec["live"]["asOf"]
        assert "lopez-reyes" in t.search_text and t.current is True
    assert "7abc123" in _q(models.OpsTenant, id="fac_a:cust_1")[0].search_text    # the plate is still searchable
    # The directory finds them by the new values at once, and no longer by the old code.
    assert _names(client, q="5550666")[0] == [("Maria Lopez-Reyes", "fac_a"), ("Maria Lopez-Reyes", "fac_b")]
    assert _names(client, q="5150")[0] == [("Maria Lopez-Reyes", "fac_a")] and _names(client, q="4821")[0] == []
    # Nobody else's row moved, the cubby_* copy is untouched, and nothing went into the change log.
    assert _q(models.OpsTenant, id="fac_a:cust_2")[0].synced_at == SYNCED
    assert _q(models.CubbyCustomer, id="fac_a:cust_1")[0].name == "Maria Lopez"
    assert len(_q(models.AuditChange)) == logged
    everything = repr([[getattr(t, c.name) for c in models.OpsTenant.__table__.columns] for t in _q(models.OpsTenant)])
    assert "1970-02-03" not in everything and "P5550001" not in everything

    # Opened again with nothing new in Cubby: live, and the stored copy is left alone.
    before = _q(models.OpsTenant, id="fac_a:cust_1")[0]
    again = client.get("/facility-ops/tenants/cust_1").json()
    after = _q(models.OpsTenant, id="fac_a:cust_1")[0]
    assert again["live"]["ok"] is True and (after.synced_at, after.gate_code) == (before.synced_at, before.gate_code)


def test_a_live_failure_falls_back_to_the_stored_copy(client, monkeypatch):
    def cubby_says_no(path, where):
        raise cubby.CubbyError(500, f"{path}: boom")
    _live(monkeypatch, cubby_says_no)
    rec = client.get("/facility-ops/tenants/cust_1").json()
    assert rec["live"]["ok"] is False and "boom" in rec["live"]["error"]
    assert rec["contact"]["phone"] == "+1 (760) 555-0111" and rec["facilities"][0]["gateCode"] == "4821"
    assert rec["storedAsOf"] == SYNCED and _q(models.OpsTenant, id="fac_a:cust_1")[0].synced_at == SYNCED

    def gate_codes_denied(path, where):                                # the customer read works, the gate codes do not
        if path == "access-codes/search":
            raise cubby.CubbyError(403, "access-codes/search: Access Denied")
        return {"customers": [_customer("cust_1", "Changed", "Name", "+19999999999", "changed@mail.test")]}
    _live(monkeypatch, gate_codes_denied)
    rec = client.get("/facility-ops/tenants/cust_1").json()
    # The customer read decides: this WAS live. A key that may not read gate
    # codes must not make every open say "Cubby could not be reached", and
    # the gate code the sync stored stays.
    assert rec["live"] == {"ok": True, "asOf": rec["live"]["asOf"], "error": ""}
    assert rec["name"] == "Changed Name" and rec["contact"]["phone"] == "+19999999999"
    assert rec["facilities"][0]["gateCode"] == "4821"

    def breaks(path, where):
        raise RuntimeError("+1 (760) 555-0111 sk-secret-key")
    _live(monkeypatch, breaks)
    r = client.get("/facility-ops/tenants/cust_1")
    assert r.json()["live"]["error"] == "RuntimeError" and "sk-secret-key" not in r.text   # the type only - never the message

    _live(monkeypatch, lambda path, where: {"customers": [], "accessCodes": []})
    assert client.get("/facility-ops/tenants/cust_1").json()["live"]["error"] == "Cubby did not return this tenant."


def test_a_slow_cubby_is_given_up_on(client, monkeypatch):
    monkeypatch.setattr(ops_tenants, "LIVE_LIMIT_SEC", 0.2)

    def slow(path, where):
        time.sleep(1.0)
        return {"customers": [MARIA], "accessCodes": []}
    _live(monkeypatch, slow)
    # (The test client waits for the worker threads when it closes its loop, so
    # the call is not timed here: the answer itself says the wait was cut short.)
    rec = client.get("/facility-ops/tenants/cust_1").json()
    assert rec["live"]["ok"] is False and rec["live"]["error"] == "Cubby took too long to answer."
    assert rec["facilities"][0]["gateCode"] == "4821"


def test_every_open_is_one_audit_row(client):
    _as(client)
    _rule("person", LEAD, [])
    client.get("/facility-ops/tenants")                                # the list is not an open
    client.get("/facility-ops/tenants/cust_2")
    client.get("/facility-ops/tenants/cust_2")
    rows = _q(models.AuditLog)
    assert len(rows) == 2
    for row in rows:
        assert (row.action, row.resource_type, row.resource_id, row.user_email) == ("ops_tenant_opened", "ops_tenant", "cust_2", LEAD)
        assert json.loads(row.details) == {"facilities": ["fac_a"], "live": False} and row.timestamp
        assert "7605550122" not in row.details and "9053" not in row.details


# ── The access rules ──────────────────────────────────────────────────────────

def test_only_an_administrator_or_operations_full_manages_the_rules(client, monkeypatch):
    _as(client, level=3)
    body = {"subjectType": "person", "subjectId": LEAD, "facilityIds": [], "tenantDetails": True}
    assert client.get("/facility-ops/access").status_code == 403
    assert client.put("/facility-ops/access", json=body).status_code == 403
    assert client.delete("/facility-ops/access/x").status_code == 403
    assert _q(models.OpsAccessRule) == []
    monkeypatch.setattr(ops_access.auth, "_module_level", lambda email, mid, db: 3 if mid == "operations" else 0)
    assert client.get("/facility-ops/access/me").json()["canManage"] is True
    assert client.put("/facility-ops/access", json=body).status_code == 200


def test_the_rules_are_listed_saved_changed_and_removed(client):
    got = client.get("/facility-ops/access").json()
    assert got == {"rules": [],
                   "facilities": [{"id": "fac_b", "name": "Murrieta"}, {"id": "fac_a", "name": "Temecula"}],
                   "groups": [{"id": "grp_calls", "name": "Call Center", "isJobRole": False},
                              {"id": "grp_sites", "name": "Site Managers", "isJobRole": True}]}

    r = client.put("/facility-ops/access", json={"subjectType": "person", "subjectId": " AJAY.RAO@greensglobal.com ",
                                                 "facilityIds": ["fac_a", "fac_a"], "tenantDetails": True})
    assert r.status_code == 200
    rule = r.json()["rule"]
    assert rule == {"id": rule["id"], "subjectType": "person", "subjectId": "ajay.rao@greensglobal.com",
                    "subjectName": "Ajay Kumar Rao", "facilityIds": ["fac_a"], "tenantDetails": True,
                    "updatedBy": "admin@greensglobal.com", "updatedAt": rule["updatedAt"]}
    assert r.json()["rules"] == [rule] and set(r.json()) == {"rules", "facilities", "groups", "rule"}
    client.put("/facility-ops/access", json={"subjectType": "group", "subjectId": "grp_sites", "facilityIds": [], "tenantDetails": False})
    listed = client.get("/facility-ops/access").json()["rules"]
    assert [(x["subjectType"], x["subjectName"], x["facilityIds"], x["tenantDetails"]) for x in listed] == [
        ("group", "Site Managers", [], False), ("person", "Ajay Kumar Rao", ["fac_a"], True)]

    # The same subject again changes their one rule.
    again = client.put("/facility-ops/access", json={"subjectType": "person", "subjectId": "ajay.rao@greensglobal.com",
                                                     "facilityIds": ["fac_b"], "tenantDetails": False}).json()["rule"]
    assert again["id"] == rule["id"] and (again["facilityIds"], again["tenantDetails"]) == (["fac_b"], False)
    assert len(_q(models.OpsAccessRule)) == 2
    row = _q(models.OpsAccessRule, id=rule["id"])[0]
    assert (row.created_by, row.updated_by) == ("admin@greensglobal.com", "admin@greensglobal.com") and row.created_at <= row.updated_at

    # It is what the person then reaches.
    _as(client, "ajay.rao@greensglobal.com")
    assert client.get("/facility-ops/access/me").json() == {"facilities": ["fac_b"], "tenantDetails": False, "canManage": False}
    _as(client, ADMIN["email"], level=4)

    saved = [json.loads(a.details) for a in _q(models.AuditLog, action="ops_access_rule_saved")]
    assert len(saved) == 3 and all(a.resource_type == "ops_access_rule" for a in _q(models.AuditLog))
    assert saved[0] == {"subjectType": "person", "subjectId": "ajay.rao@greensglobal.com", "from": None,
                        "to": {"facilityIds": ["fac_a"], "tenantDetails": True}}
    assert saved[2]["from"] == {"facilityIds": ["fac_a"], "tenantDetails": True} and saved[2]["to"]["facilityIds"] == ["fac_b"]

    gone = client.delete(f"/facility-ops/access/{rule['id']}")
    assert gone.status_code == 200 and [x["subjectId"] for x in gone.json()["rules"]] == ["grp_sites"]
    assert client.delete(f"/facility-ops/access/{rule['id']}").status_code == 404
    deleted = _q(models.AuditLog, action="ops_access_rule_deleted")
    assert len(deleted) == 1 and deleted[0].resource_id == rule["id"]
    assert json.loads(deleted[0].details)["from"] == {"facilityIds": ["fac_b"], "tenantDetails": False}


def test_a_rule_is_validated(client):
    def put(**body):
        base = {"subjectType": "person", "subjectId": LEAD, "facilityIds": [], "tenantDetails": True}
        return client.put("/facility-ops/access", json={**base, **body})
    assert put(subjectId="stranger@elsewhere.test").status_code == 422      # not in Nexus People
    assert put(subjectId="").status_code == 422
    assert put(subjectType="group", subjectId="grp_nothing").status_code == 422
    assert put(subjectType="group", subjectId=LEAD).status_code == 422      # a person is not a group
    assert put(subjectType="team", subjectId="grp_sites").status_code == 422
    assert put(facilityIds=["fac_a", "fac_zzz"]).status_code == 422         # not a Cubby facility
    assert put(facilityIds="fac_a").status_code == 422
    assert client.put("/facility-ops/access", json={"subjectType": "person"}).status_code == 422
    assert _q(models.OpsAccessRule) == [] and _q(models.AuditLog) == []
    assert put(subjectType="Group", subjectId="grp_calls", facilityIds=["fac_b"]).status_code == 200
