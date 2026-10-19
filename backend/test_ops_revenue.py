"""Operations > Revenue Management (ops_revenue.py + routers/ops_revenue.py):
eligibility, cap math, preview totals, the batch lifecycle, permissions and
the Cubby push - with Cubby faked (no HTTP leaves the test). Runs on the
throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_ops_revenue.py"""
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import models
import ops_revenue as rev
from auth import get_current_user
from database import SessionLocal

TODAY = date(2026, 10, 20)
FAC = {"facilityId": "fac_t", "name": "Greens Storage Temecula", "timeZone": "America/Los_Angeles"}
S = dict(rev.DEFAULT_STRATEGY, name="Annual 8%")


def _unit(uid, rent, street, move_in="2024-01-10", **extra):
    row = {"unitId": uid, "unitName": uid.upper(), "status": "RENTED", "standardRate": street,
           "monthlyRentalAmount": rent, "customerId": f"cust_{uid}", "customerName": f"Tenant {uid}",
           "pricingGroupName": "10x10", "moveInDate": move_in, "paidThroughDate": "2026-10-31"}
    row.update(extra)
    return row


def _raw():
    return {
        "today": TODAY,
        "rent_roll": [
            _unit("a1", 10000, 15000),                                        # long stay, well under street
            _unit("a2", 14500, 15000),                                        # 8% would pass street: capped
            _unit("a3", 10000, 15000, move_in="2026-06-01"),                  # too new
            _unit("a4", 10000, 15000, lastRentChangeDate="2026-05-01"),       # raised recently (Cubby)
            _unit("a5", 10000, 15000),                                        # owes money
            _unit("a6", 0, 15000),                                            # comped
            _unit("a7", 16000, 15000),                                        # already above street
            _unit("b1", 20000, 25000, pricingGroupName="10x20"),
            {"unitId": "v1", "unitName": "V1", "status": "VACANT", "standardRate": 15000, "pricingGroupName": "10x10"},
        ],
        "receivables": [{"unitId": "a5", "totalAmount": 5000}],
        "leases": [{"leaseId": f"lease_{u}", "unitId": u, "customerId": f"cust_{u}", "moveInDate": "2024-01-10",
                    "moveOutDate": None} for u in ("a1", "a2", "a3", "a4", "a5", "a6", "a7")]
        + [{"leaseId": "lease_b1", "unitId": "b1", "customerId": "cust_b1", "moveInDate": "2024-01-10",
            "rentChangeScheduledDate": "2026-11-01", "rentChangeNewRentAmount": 21000},
           {"leaseId": "lease_old", "unitId": "a1", "moveInDate": "2020-01-01", "moveOutDate": "2023-12-31"}],
    }


# ── Pure rules ────────────────────────────────────────────────────────────────

def test_months_between_counts_whole_months():
    assert rev.months_between(date(2026, 1, 15), date(2026, 2, 14)) == 0
    assert rev.months_between(date(2026, 1, 15), date(2026, 2, 15)) == 1
    assert rev.months_between(date(2025, 10, 20), date(2026, 10, 20)) == 12
    assert rev.months_between(None, TODAY) is None


def test_tenant_rows_gap_balance_and_last_change():
    rows = {t["unit"]: t for t in rev.tenant_rows(_raw(), nexus_last={"lease_a1": "2025-03-01"})}
    assert "V1" not in rows                                     # vacant units are not tenants
    a1 = rows["A1"]
    assert (a1["leaseId"], a1["gap"], a1["gapPct"]) == ("lease_a1", 5000, 33.3)   # the active lease, not the old one
    assert (a1["lastIncrease"], a1["lastIncreaseSource"]) == ("2025-03-01", "nexus")
    assert rows["A4"]["lastIncreaseSource"] == "cubby" and rows["A4"]["monthsSinceIncrease"] == 5
    assert rows["A5"]["balance"] == 5000
    assert rows["B1"]["scheduled"] == {"date": "2026-11-01", "amount": 21000}
    assert a1["monthsStayed"] == 33


def test_eligibility_rules_and_cap_math():
    rows = rev.tenant_rows(_raw())
    out = {r["unit"]: r for r in (rev.propose(S, t, date(2026, 12, 1)) for t in rows)}
    assert out["A1"]["eligible"] and out["A1"]["newRent"] == 10800 and out["A1"]["increasePct"] == 8.0
    assert out["A2"]["newRent"] == 15000 and out["A2"]["capped"]                  # 15660 capped at street
    assert "Moved in less than 12 months" in out["A3"]["reasons"][0]
    assert "Rent changed less than 12 months" in out["A4"]["reasons"][0]
    assert out["A5"]["reasons"] == ["Has a balance due"]
    assert "Comped" in out["A6"]["reasons"][0]
    assert out["A7"]["reasons"] == ["Already at or above the cap"]
    assert "already scheduled in Cubby" in out["B1"]["reasons"][0]
    # Balance rule off: A5 qualifies.
    assert rev.propose({**S, "skipBalance": False}, next(t for t in rows if t["unit"] == "A5"), TODAY)["eligible"]


def test_cap_variants_amount_and_rounding():
    t = rev.tenant_rows(_raw())[1]                                                # A2: 14500 vs street 15000
    plus = rev.propose({**S, "capMode": "street_plus", "capPct": 3}, t, TODAY)
    assert plus["newRent"] == 15450                                              # street + 3%
    none = rev.propose({**S, "capMode": "none"}, t, TODAY)
    assert none["newRent"] == 15700                                              # 15660 rounded to a whole dollar
    exact = rev.propose({**S, "capMode": "none", "roundDollar": False}, t, TODAY)
    assert exact["newRent"] == 15660
    amt = rev.propose({**S, "method": "amount", "increaseCents": 2500, "capMode": "none"}, t, TODAY)
    assert amt["newRent"] == 17000 and amt["increase"] == 2500


def test_months_count_to_the_effective_date():
    t = next(x for x in rev.tenant_rows(_raw()) if x["unit"] == "A4")           # changed 05/01/2026
    assert not rev.propose(S, t, date(2027, 4, 30))["eligible"]
    assert rev.propose(S, t, date(2027, 5, 1))["eligible"]


def test_preview_totals():
    rows = rev.in_scope(rev.tenant_rows(_raw()), {"type": "unit_type", "unitType": "10x10"})
    out = rev.preview(S, rows, date(2026, 12, 1))
    t = out["totals"]
    assert (t["inScope"], t["eligible"], t["skipped"]) == (7, 2, 5)
    assert t["currentMonthly"] == 24500 and t["monthlyIncrease"] == 800 + 500
    assert t["annualIncrease"] == 1300 * 12 and t["newMonthly"] == 25800
    assert t["capped"] == 1 and t["avgIncreasePct"] == 5.3
    assert out["rows"][0]["unit"] == "A1"                                        # biggest increase first
    assert sum(t["skippedBy"].values()) == 5


def test_notice_dates():
    assert rev.earliest_effective(TODAY, 30) == date(2026, 11, 19)
    assert rev.notice_date(date(2026, 12, 1), 30) == date(2026, 11, 1)


# ── Endpoints ─────────────────────────────────────────────────────────────────

TABLES = (models.OpsRevenueStrategy, models.OpsRevenueBatch, models.OpsRevenueChange, models.OpsRevenueAudit)


class FakeWrite:
    def __init__(self):
        self.calls = []
        self.when = "2026-12-01"
        self.refuse = False

    def __call__(self, path, body):
        self.calls.append((path, body))
        if path == "leases/get-rent-change-schedules":
            return {"rentChangeSchedules": [{"leaseId": body["leaseIds"][0], "rentChangeDate": self.when,
                                             "noticeDate": "2026-11-01"}]}
        if path == "leases/change-rents":
            if self.refuse:
                raise cubby.CubbyError(400, "leases/change-rents: Lease is closed")
            return {}
        raise AssertionError(path)


@pytest.fixture
def client(monkeypatch):
    db = SessionLocal()
    try:
        for t in TABLES:
            db.query(t).delete()
        db.commit()
    finally:
        db.close()
    from routers import ops_revenue as router_mod
    monkeypatch.setattr(router_mod, "_facility_rows", lambda fid: (FAC, _raw()) if fid == "fac_t" else (None, None))
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: TODAY)
    monkeypatch.delenv(rev.WRITE_KEY_ENV, raising=False)
    fake = FakeWrite()
    monkeypatch.setattr(rev, "_write", fake)

    def no_http(*a, **k):
        raise AssertionError("no real HTTP in tests")
    monkeypatch.setattr(httpx, "post", no_http)
    app = FastAPI()
    app.include_router(router_mod.router)
    user = {"email": "ops.manager@greensglobal.com", "role": "manager", "level": 3}
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    c.user, c.fake = user, fake
    return c


STRAT = {"name": "Annual 8%", "method": "percent", "increase_pct": 8, "cap_mode": "street",
         "min_months_in": 12, "min_months_since": 12, "skip_balance": True, "notice_days": 30}


def _plan(c, **over):
    sid = c.post("/facility-ops/revenue/strategies", json=STRAT).json()["id"]
    body = {"facility_id": "fac_t", "strategy_id": sid, "scope": {"type": "unit_type", "unitType": "10x10"},
            "effective_date": "2026-12-01", **over}
    return body


def test_supervisors_and_employees_are_refused(client):
    for level in (1, 2):
        client.user.update({"level": level, "role": "supervisor" if level == 2 else "employee",
                            "email": f"person{level}@greensglobal.com"})
        assert client.get("/facility-ops/revenue/tenants?facility_id=fac_t").status_code == 401
        assert client.get("/facility-ops/revenue/strategies").status_code == 401


def test_tenants_endpoint(client):
    r = client.get("/facility-ops/revenue/tenants?facility_id=fac_t").json()
    assert len(r["tenants"]) == 8 and r["unitTypes"] == ["10x10", "10x20"] and r["writeEnabled"] is False
    assert client.get("/facility-ops/revenue/tenants?facility_id=nope").status_code == 404


def test_strategy_validation(client):
    assert client.post("/facility-ops/revenue/strategies", json={**STRAT, "increase_pct": 0}).status_code == 422
    assert client.post("/facility-ops/revenue/strategies", json={**STRAT, "notice_days": 0}).status_code == 422
    sid = client.post("/facility-ops/revenue/strategies", json=STRAT).json()["id"]
    assert client.put(f"/facility-ops/revenue/strategies/{sid}", json={**STRAT, "name": "Renamed"}).json()["name"] == "Renamed"
    assert client.delete(f"/facility-ops/revenue/strategies/{sid}").status_code == 200
    assert client.get("/facility-ops/revenue/strategies").json()["strategies"] == []


def test_preview_saves_nothing_and_enforces_notice(client):
    body = _plan(client)
    r = client.post("/facility-ops/revenue/preview", json=body)
    assert r.status_code == 200
    j = r.json()
    assert j["totals"]["eligible"] == 2 and j["totals"]["monthlyIncrease"] == 1300 and j["noticeDate"] == "2026-11-01"
    db = SessionLocal()
    try:
        assert db.query(models.OpsRevenueBatch).count() == 0
    finally:
        db.close()
    early = client.post("/facility-ops/revenue/preview", json={**body, "effective_date": "2026-11-10"})
    assert early.status_code == 422 and "11/19/2026" in early.json()["detail"]
    one = client.post("/facility-ops/revenue/preview", json={**body, "scope": {"type": "tenant", "keys": ["lease_a1"]}})
    assert one.json()["totals"]["eligible"] == 1 and one.json()["scopeLabel"] == "Tenant a1 (A1)"
    inline = client.post("/facility-ops/revenue/preview", json={**{k: v for k, v in body.items() if k != "strategy_id"},
                                                                "strategy": {**STRAT, "increase_pct": 10}})
    assert inline.json()["totals"]["monthlyIncrease"] == 1000 + 500


def test_batch_lifecycle_and_push(client, monkeypatch):
    b = client.post("/facility-ops/revenue/batches", json=_plan(client)).json()
    assert b["status"] == "draft" and b["count"] == 2 and b["monthlyIncrease"] == 1300
    # The same tenants cannot go into a second open batch.
    again = client.post("/facility-ops/revenue/preview", json=_plan(client)).json()
    assert again["totals"]["eligible"] == 0
    bid = b["id"]
    a2 = next(c for c in b["changes"] if c["unit"] == "A2")
    assert client.delete(f"/facility-ops/revenue/batches/{bid}/changes/{a2['id']}").json()["count"] == 1
    # Out of order: cannot be Applied or Notified from Draft.
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "applied"}).status_code == 409
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "notified"}).status_code == 409
    a1 = next(c for c in b["changes"] if c["unit"] == "A1")
    push = f"/facility-ops/revenue/batches/{bid}/changes/{a1['id']}/push"
    assert client.post(push, json={}).status_code == 503                          # no Manager-role key
    monkeypatch.setenv(rev.WRITE_KEY_ENV, "test-key-not-real")
    assert client.post(push, json={}).status_code == 409                          # not approved yet
    assert client.get(f"/facility-ops/revenue/batches/{bid}/letters.pdf").status_code == 409
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "approved"}).json()["status"] == "approved"
    pdf = client.get(f"/facility-ops/revenue/batches/{bid}/letters.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    # Cubby's next date differs: stop and say so, nothing written.
    client.fake.when = "2026-12-05"
    r = client.post(push, json={})
    assert r.status_code == 409 and r.json()["detail"]["cubbyDate"] == "2026-12-05"
    assert [p for p, _ in client.fake.calls] == ["leases/get-rent-change-schedules"]
    client.fake.when = "2026-12-01"
    client.fake.refuse = True
    assert client.post(push, json={}).status_code == 424
    client.fake.refuse = False
    out = client.post(push, json={}).json()
    row = next(c for c in out["changes"] if c["id"] == a1["id"])
    assert row["status"] == "pushed" and row["pushedBy"] == "ops.manager@greensglobal.com"
    assert client.fake.calls[-1] == ("leases/change-rents", {"leases": [
        {"leaseId": "lease_a1", "newRentAmount": 10800, "rentChangeDate": "2026-12-01", "noticeDate": "2026-11-01"}]})
    assert client.post(push, json={}).status_code == 409                          # never twice
    actions = [a["action"] for a in out["audit"]]
    assert actions.count("push_failed") == 1 and "pushed" in actions and "approved" in actions
    # Applied needs the letters out first, then everything in Cubby.
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "notified"}).status_code == 200
    done = client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "applied"})
    assert done.status_code == 200 and done.json()["inCubby"] == 1
    exp = client.get(f"/facility-ops/revenue/batches/{bid}/export").json()
    assert exp["rows"][0][1] == "Tenant a1" and exp["rows"][0][9] == "12/01/2026" and exp["rows"][0][11] == "Yes"


def test_checklist_path_without_the_api(client):
    b = client.post("/facility-ops/revenue/batches", json=_plan(client)).json()
    bid = b["id"]
    client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "approved"})
    client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "notified"})
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "applied"}).status_code == 409
    for c in b["changes"]:
        assert client.post(f"/facility-ops/revenue/batches/{bid}/changes/{c['id']}/entered").status_code == 200
    assert client.post(f"/facility-ops/revenue/batches/{bid}/status", json={"status": "applied"}).json()["status"] == "applied"
    assert client.fake.calls == []
    # Applied rows count as the last increase from now on (the effective date is still ahead: pending).
    t = {x["unit"]: x for x in client.get("/facility-ops/revenue/tenants?facility_id=fac_t").json()["tenants"]}
    assert t["A1"]["pending"]["status"] == "applied"


def test_cancel(client):
    b = client.post("/facility-ops/revenue/batches", json=_plan(client)).json()
    r = client.post(f"/facility-ops/revenue/batches/{b['id']}/status", json={"status": "canceled", "note": "Wrong date"})
    assert r.json()["status"] == "canceled" and "Wrong date" in r.json()["note"]
    assert client.post("/facility-ops/revenue/preview", json=_plan(client)).json()["totals"]["eligible"] == 2
