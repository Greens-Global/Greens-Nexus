"""Operations -> Rate Management (ops_rate_mgmt.py, routers/ops_rates.py):
the CMA rows built on ops_market.compare, proposed-rate drafts, Mark Entered
in Cubby (HTTP mocked - the real Cubby is never called), who may do what, and
the log that is our rate history. Nexus never writes to Cubby (Oct 20 2026):
the fake fails the test on any Cubby call that is not a read.

Throwaway SQLite. Run alone: python -m pytest test_ops_rate_mgmt.py
"""
import atexit
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cubby  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import ops_rate_mgmt  # noqa: E402
from auth import get_current_user  # noqa: E402
from routers import facility_ops, ops_rates  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


FAC = "fac_fairfield"
TYPES = [
    {"name": "8' x 10'", "width": 8, "depth": 10, "parking": False, "total": 10, "rented": 5, "vacant": 4,
     "unavailable": 1, "street": 11900, "rentSum": 5 * 11000},
    {"name": "12' x 30' Parking", "width": 12, "depth": 30, "parking": True, "total": 11, "rented": 0, "vacant": 0,
     "unavailable": 11, "street": 10400, "rentSum": 0},
    {"name": "10' x 20'", "width": 10, "depth": 20, "parking": False, "total": 20, "rented": 18, "vacant": 2,
     "unavailable": 0, "street": 20000, "rentSum": 18 * 19000},
]
GROUPS = [
    {"pricingGroupId": "pg_810", "name": "8' x 10'", "standardRate": 11900, "webRate": 11350, "walkInRate": 10200,
     "parking": False, "vehicleStorage": False},
    {"pricingGroupId": "pg_1230", "name": "12' x 30' Parking", "standardRate": 10400, "webRate": None,
     "parking": True, "vehicleStorage": True},
    {"pricingGroupId": "pg_1020", "name": "10' x 20'", "standardRate": 20000, "webRate": 19500, "parking": False},
]


def _facility():
    return {"id": FAC, "name": "Greens Storage Fairfield", "shortName": "Fairfield", "asOf": "2026-10-20",
            "unitTypes": [dict(t) for t in TYPES]}


def _is_read(url: str) -> bool:
    """A Cubby call Nexus may make: a `*/search` or one of Cubby's `reports/*`."""
    path = url.rsplit("/v1/", 1)[-1]
    return path.endswith("/search") or path.startswith("reports/")


class FakeCubby:
    """Stands in for httpx.post: answers the pricing group search and FAILS the
    test on any Cubby call that is not a read - Nexus never writes to Cubby."""

    def __init__(self):
        self.calls, self.status = [], 200

    def __call__(self, url, json=None, headers=None, timeout=None, **kw):
        assert _is_read(url), f"Nexus must never write to Cubby, but it called {url}"
        self.calls.append((url.rsplit("/v1/", 1)[-1], json))

        class R:
            pass
        r = R()
        if self.status != 200:
            r.status_code, body = self.status, {"status": self.status, "errors": ["Access Denied"]}
        else:
            r.status_code, body = 200, {"status": 200, "data": {"pricingGroups": [dict(g) for g in GROUPS], "facilities": [
                {"facilityId": FAC, "billingCycle": "MONTHLY",
                 "contact": {"address": "5044 Peabody Road", "city": "Fairfield", "state": "CA", "zip": "94533"}}]}}
        r.json = lambda: body
        return r


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.OpsRateDraft, models.OpsRatePush, models.OpsCompetitorRate, models.OpsCompetitor):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


@pytest.fixture
def cubby_api(monkeypatch):
    monkeypatch.setenv("CUBBY_API_KEY", "test-key")
    fake = FakeCubby()
    monkeypatch.setattr(ops_rate_mgmt.httpx, "post", fake)   # the httpx module itself: every caller is guarded
    ops_rate_mgmt.forget()

    async def fake_facility(fid):
        if fid != FAC:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Facility not found")
        return _facility()
    monkeypatch.setattr(facility_ops, "_facility", fake_facility)
    return fake


def _client(level=3, role="manager"):
    app = FastAPI()
    app.include_router(ops_rates.router)
    app.dependency_overrides[get_current_user] = lambda: {"email": f"{role}@greensglobal.com", "role": role, "level": level}
    return TestClient(app)


def _comps(db, rates=((10500, 12000, 15000), (18000, 21000))):
    """Three competitors with 8x10 rates, two with 10x20 rates."""
    for i, name in enumerate(("StorQuest", "Extra Space", "Public Storage")):
        db.add(models.OpsCompetitor(id=f"c{i}", facility_id=FAC, name=name, active=True, created_at="1"))
    db.add(models.OpsCompetitor(id="gone", facility_id=FAC, name="Closed Storage", active=False, created_at="1"))
    for i, cents in enumerate(rates[0]):
        db.add(models.OpsCompetitorRate(id=f"a{i}", competitor_id=f"c{i}", facility_id=FAC, width=8, depth=10,
                                        rate_cents=cents, observed_on="2026-10-15", source="manual", created_at="1"))
    for i, cents in enumerate(rates[1]):
        db.add(models.OpsCompetitorRate(id=f"b{i}", competitor_id=f"c{i}", facility_id=FAC, width=10, depth=20,
                                        rate_cents=cents, observed_on="2026-10-14", source="stortrack", created_at="1"))
    db.commit()


# ── Pure ─────────────────────────────────────────────────────────────────────

def test_sell_is_the_web_rate_and_falls_back_to_the_standard_rate():
    assert ops_rate_mgmt.sell_of(GROUPS[0]) == 11350
    assert ops_rate_mgmt.sell_of(GROUPS[1]) == 10400
    assert ops_rate_mgmt.sell_of(None) is None


def test_the_set_rate_keeps_its_gap_unless_one_is_typed():
    assert ops_rate_mgmt.plan(11900, 11350, 11850, None) == {"newSell": 11850, "newSet": 12400}
    assert ops_rate_mgmt.plan(11900, 11350, 11850, 12500) == {"newSell": 11850, "newSet": 12500}
    assert ops_rate_mgmt.plan(None, 11350, 11850, None)["newSet"] == 11850


def test_two_groups_with_one_name_are_not_matched():
    idx = ops_rate_mgmt.group_index([{"name": "A", "pricingGroupId": "1"}, {"name": "A", "pricingGroupId": "2"}])
    assert idx["A"] is None


def test_rows_group_by_category_and_price_against_the_sell_rate(db, cubby_api):
    _comps(db)
    v = _client().get(f"/facility-ops/rates?facility_id={FAC}").json()
    names = [(r["category"], r["name"]) for r in v["rows"]]
    assert names == [("Self-Storage", "8' x 10'"), ("Self-Storage", "10' x 20'"), ("Vehicle Storage", "12' x 30' Parking")]
    r = v["rows"][0]
    assert (r["set"], r["sell"], r["walkIn"], r["groupId"]) == (11900, 11350, 10200, "pg_810")
    assert (r["marketLow"], r["marketMedian"], r["marketHigh"], r["competitors"]) == (10500, 12000, 15000, 3)
    assert r["variance"] == 11350 - 12000 and r["suggested"] is not None   # ops_market.compare on the Sell rate
    assert r["offline"] == 1 and r["occupancy"] == 0.5
    assert v["compSet"] == {"active": 3, "web": 0, "stortrack": 2, "manual": 1, "closed": 1}
    assert v["kpis"]["rateable"] == 2 and v["kpis"]["belowMarket"] == 1 and v["kpis"]["offline"] == 12
    assert any("fully offline" in a for a in v["attention"])
    assert v["address"] == "5044 Peabody Road, Fairfield, CA 94533"
    assert v["canMark"] is True and v["canEdit"] is True
    assert "canPush" not in v and "pushConnected" not in v


def test_the_screen_still_opens_when_cubby_pricing_groups_fail(db, cubby_api, monkeypatch):
    monkeypatch.delenv("CUBBY_API_KEY")
    v = _client().get(f"/facility-ops/rates?facility_id={FAC}").json()
    assert v["cubbyGroups"]["ok"] is False and v["rows"][0]["groupId"] == "" and v["rows"][0]["sell"] == 11900
    assert "could not be read" in v["attention"][0] and "push" not in v["attention"][0]


# ── Drafts ───────────────────────────────────────────────────────────────────

def test_a_draft_is_saved_with_who_and_when_replaced_in_place_and_cleared(db, cubby_api):
    c = _client()
    v = c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115}).json()
    r = v["rows"][0]
    assert r["proposed"] == 11500 and r["proposedSet"] == 12050 and r["ready"] is True
    assert r["draft"]["updatedBy"] == "manager@greensglobal.com" and r["draft"]["updatedAt"]
    assert r["revDelta"] == (11500 - 11350) * 4 and v["kpis"]["ready"] == 1
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 118, "proposed_set": 125})
    rows = db.query(models.OpsRateDraft).all()
    assert len(rows) == 1 and (rows[0].proposed_cents, rows[0].proposed_set_cents, rows[0].pricing_group_id) == (11800, 12500, "pg_810")
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": None})
    db.expire_all()
    assert db.query(models.OpsRateDraft).count() == 0


def test_a_draft_for_an_unknown_unit_type_is_a_404(db, cubby_api):
    r = _client().put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "99 x 99", "proposed": 10})
    assert r.status_code == 404


def test_supervisors_look_but_do_not_propose_or_mark(db, cubby_api):
    sup = _client(2, "supervisor")
    assert sup.get(f"/facility-ops/rates?facility_id={FAC}").status_code == 200
    assert sup.get(f"/facility-ops/rates?facility_id={FAC}").json()["canMark"] is False
    assert sup.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115}).status_code == 401
    assert sup.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"]}).status_code == 401
    assert _client(1, "employee").get(f"/facility-ops/rates?facility_id={FAC}").status_code == 401


# ── No push: Nexus only reads from Cubby (Visesh, Oct 20 2026) ───────────────

def test_the_push_route_is_gone(db, cubby_api):
    r = _client(4, "administrator").post("/facility-ops/rates/push",
                                         json={"facility_id": FAC, "unit_types": ["8' x 10'"], "confirm": True})
    assert r.status_code in (404, 405)
    assert not hasattr(ops_rate_mgmt, "change_rate") and not hasattr(ops_rate_mgmt, "write_configured")


def test_no_endpoint_writes_to_cubby(db, cubby_api):
    """Every route on the screen, end to end, with httpx.post failing on any
    Cubby URL that is not a `*/search` or `reports/*` read."""
    _comps(db)
    c = _client(4, "administrator")
    assert c.get(f"/facility-ops/rates?facility_id={FAC}").status_code == 200
    assert c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115}).status_code == 200
    assert c.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"]}).status_code == 200
    assert c.get(f"/facility-ops/rates/history?facility_id={FAC}&unit_type=8' x 10'").status_code == 200
    assert cubby_api.calls and all(_is_read("https://x/v1/" + path) for path, _ in cubby_api.calls)


def test_the_read_helper_refuses_a_write_path(cubby_api):
    with pytest.raises(ValueError):
        ops_rate_mgmt._call("pricing-groups/change-rates", {})
    assert cubby_api.calls == []


# ── Mark Entered in Cubby ────────────────────────────────────────────────────

def test_mark_entered_records_who_and_when_and_clears_the_draft(db, cubby_api):
    c = _client()
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115})
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "10' x 20'", "proposed": 200})
    out = c.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'", "10' x 20'"]}).json()
    assert [r["status"] for r in out["results"]] == ["entered", "entered"]
    assert {r["detail"] for r in out["results"]} == {"Entered in Cubby by hand"}
    db.expire_all()
    assert db.query(models.OpsRateDraft).count() == 0
    log = db.query(models.OpsRatePush).order_by(models.OpsRatePush.unit_type).all()
    assert len(log) == 2 and {p.batch_id for p in log} == {out["batchId"]}
    p = next(x for x in log if x.unit_type == "8' x 10'")
    assert (p.old_set_cents, p.old_sell_cents, p.new_set_cents, p.new_sell_cents) == (11900, 11350, 12050, 11500)
    assert p.monthly_delta_cents == 150 * 4 and p.pushed_by == "manager@greensglobal.com" and p.pushed_at
    assert p.status == "entered" and p.pricing_group_id == "pg_810"
    assert len(out["view"]["pushes"]) == 2 and all(r["proposed"] is None for r in out["view"]["rows"])


def test_mark_entered_keeps_the_rates_the_review_showed(db, cubby_api):
    """Once staff typed the new rate in Cubby a fresh read already shows it, so
    the record's "from" side is what the person reviewed."""
    c = _client()
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115})
    c.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"],
                                                "seen": {"8' x 10'": {"set": 11000, "sell": 10500}}})
    p = db.query(models.OpsRatePush).one()
    assert (p.old_set_cents, p.old_sell_cents, p.new_sell_cents, p.new_set_cents) == (11000, 10500, 11500, 12000)
    assert p.monthly_delta_cents == 1000 * 4


def test_mark_entered_skips_what_has_no_draft(db, cubby_api):
    r = _client().post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"]}).json()
    assert r["results"][0]["status"] == "skipped"


def test_mark_entered_works_while_cubby_cannot_be_read(db, cubby_api):
    c = _client()
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115})
    cubby_api.status = 503
    ops_rate_mgmt.forget()
    r = c.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"],
                                                    "seen": {"8' x 10'": {"set": 11900, "sell": 11350}}})
    assert r.status_code == 200 and r.json()["results"][0]["status"] == "entered"


# ── History ──────────────────────────────────────────────────────────────────

def test_history_shows_our_entered_rates_and_the_competitors_rates_for_that_size(db, cubby_api):
    _comps(db)
    c = _client()
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "8' x 10'", "proposed": 115})
    c.post("/facility-ops/rates/entered", json={"facility_id": FAC, "unit_types": ["8' x 10'"]})
    h = c.get(f"/facility-ops/rates/history?facility_id={FAC}&unit_type=8' x 10'").json()
    assert [(p["oldSell"], p["newSell"], p["status"]) for p in h["ours"]] == [(11350, 11500, "entered")]
    assert sorted(x["rate"] for x in h["competitors"]) == [10500, 12000, 15000]
    assert {x["competitor"] for x in h["competitors"]} == {"StorQuest", "Extra Space", "Public Storage"}


def test_cubby_errors_never_leak_the_key(cubby_api):
    cubby_api.status = 403
    with pytest.raises(cubby.CubbyError) as e:
        ops_rate_mgmt.pricing_groups(FAC, fresh=True)
    assert "test-key" not in e.value.message
