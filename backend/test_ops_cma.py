"""Operations > Rate Management as a CMA (ops_cma.py, routers/ops_cma.py):
the briefing's calculations, the guardrails, surveys / overrides / closed
competitors / import, Rate History, and Review & Push behind the Push to
Cubby switch (HTTP mocked - the real Cubby is never called; with the switch
off the fake fails the test on any Cubby write).

Throwaway SQLite. Run alone: python -m pytest test_ops_cma.py
"""
import atexit
import os
import tempfile
from datetime import date

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import ops_cma  # noqa: E402
import ops_cubby_push  # noqa: E402
import ops_rate_mgmt  # noqa: E402
from auth import get_current_user  # noqa: E402
from routers import facility_ops, ops_cma as cma_router, ops_rates  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


TODAY = date(2026, 10, 20)
FAC = "fac_fairfield"
# The mockup's 12' x 32' row: 114 units, 21 vacant, 1 offline, 92 occupied.
TYPES = [
    {"name": "12' x 32' Parking", "width": 12, "depth": 32, "parking": True, "total": 114, "rented": 92, "vacant": 21,
     "unavailable": 1, "street": 11400, "rentSum": 92 * 12274},
    {"name": "8' x 10'", "width": 8, "depth": 10, "parking": False, "total": 2, "rented": 0, "vacant": 2,
     "unavailable": 0, "street": 11900, "rentSum": 0},
]


def _groups():
    return [{"pricingGroupId": "pg_1232", "name": "12' x 32' Parking", "standardRate": 11400, "webRate": 11450,
             "walkInRate": 11450, "parking": True, "vehicleStorage": True},
            {"pricingGroupId": "pg_810", "name": "8' x 10'", "standardRate": 11900, "webRate": 11350, "walkInRate": 10200}]


def _is_read(url: str) -> bool:
    path = url.rsplit("/v1/", 1)[-1]
    return path.endswith("/search") or path.startswith("reports/")


class FakeCubby:
    """httpx.post: pricing group searches answer from `groups`; a write fails
    the test unless `writes`; change-rates updates `groups` (so the read-back
    matches) unless `ignore` (Cubby took it but did not change)."""

    def __init__(self):
        self.groups, self.calls, self.writes, self.ignore = _groups(), [], False, False

    def __call__(self, url, json=None, headers=None, timeout=None, **kw):
        assert _is_read(url) or self.writes, f"Cubby write with the switch off: {url}"
        path = url.rsplit("/v1/", 1)[-1]
        self.calls.append((path, json))

        class R:
            status_code = 200
        r = R()
        if path == "pricing-groups/change-rates":
            for x in json["pricingGroups"]:
                g = next(g for g in self.groups if g["pricingGroupId"] == x["pricingGroupId"])
                if not self.ignore:
                    g["standardRate"], g["webRate"] = x["standardRate"], x["webRate"]
            body = {"data": {}}
        else:
            body = {"data": {"pricingGroups": [dict(g) for g in self.groups],
                             "facilities": [{"facilityId": FAC, "contact": {"address": "5044 Peabody Road"}}]}}
        r.json = lambda: body
        return r

    def writes_sent(self):
        return [b for p, b in self.calls if not _is_read("x/v1/" + p)]


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.OpsRateDraft, models.OpsRatePush, models.OpsCompetitorRate, models.OpsCompetitor,
              models.OpsCmaSurvey, models.OpsCmaChange, models.OpsCmaSnapshot, models.OpsCmaEvent):
        s.query(m).delete()
    s.query(models.NexusSetting).filter(models.NexusSetting.key == ops_cubby_push.SETTINGS_KEY).delete()
    s.commit()
    yield s
    s.close()


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("CUBBY_API_KEY", "test-key")
    monkeypatch.delenv(ops_cubby_push.WRITE_KEY_ENV, raising=False)
    f = FakeCubby()
    monkeypatch.setattr(ops_rate_mgmt.httpx, "post", f)
    ops_rate_mgmt.forget()

    async def fake_facility(fid):
        if fid != FAC:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Facility not found")
        return {"id": FAC, "name": "Greens Storage Fairfield", "shortName": "Fairfield", "asOf": TODAY.isoformat(),
                "unitTypes": [dict(t) for t in TYPES]}
    monkeypatch.setattr(facility_ops, "_facility", fake_facility)
    monkeypatch.setattr(ops_rates, "_raw_rows", lambda fid: ([], []))
    return f


def _client(level=3, role="manager"):
    app = FastAPI()
    app.include_router(ops_rates.router)
    app.include_router(cma_router.router)
    app.dependency_overrides[get_current_user] = lambda: {"email": f"{role}@greensglobal.com", "role": role, "level": level}
    return TestClient(app)


def _comp(db, cid, name, active=True, closed=False, price_source=""):
    db.add(models.OpsCompetitor(id=cid, facility_id=FAC, name=name, active=active, closed=closed,
                                price_source=price_source, created_at="1"))


def _rate(db, cid, w, d, cents, day="2026-10-15", source="manual", parking=True, **kw):
    db.add(models.OpsCompetitorRate(id=f"{cid}-{w}x{d}-{cents}-{source}-{day}", competitor_id=cid, facility_id=FAC,
                                    width=w, depth=d, parking=parking, rate_cents=cents, observed_on=day,
                                    source=source, created_at=day, **kw))


def _mockup_market(db):
    """Three comps for 12 x 32 parking: $110, $110, $154 (avg $124.67), plus a
    closed StorQuest at $90 that must not count."""
    for cid, name in (("tri", "Tri-City Boat & RV"), ("almond", "Almond Acres"), ("sps", "Security Public Storage")):
        _comp(db, cid, name)
    _comp(db, "sq", "StorQuest", active=False, closed=True)
    _rate(db, "tri", 12, 32, 11000)
    _rate(db, "almond", 12, 32, 11000)
    _rate(db, "sps", 12, 32, 15400, source="web")
    _rate(db, "sq", 12, 32, 9000)
    db.commit()


def _switch(db, on=True):
    ops_cubby_push.save(db, on, {"email": "admin@greensglobal.com"})


# ── Pure: calculations ───────────────────────────────────────────────────────

def test_keep_ending_holds_the_50_cents():
    assert ops_cma.keep_ending(11958.5, 11450) == 11950
    assert ops_cma.keep_ending(11958.5, 11400) == 12000
    assert ops_cma.keep_ending(8540, 8500) == 8500


def test_suggestion_rules_match_the_mockup():
    # 12' x 32': 80.7% occupied, $114.50 vs $124.67 -> raise halfway, .50 kept.
    s, why, move = ops_cma.suggest(11450, 12467, 0.807, 3, 114, False)
    assert (s, move) == (11950, "raise") and why.startswith("Raise halfway to market")
    assert ops_cma.suggest(13150, 13130, 0.833, 2, 6, False)[1] == "Hold - at market"
    assert ops_cma.suggest(8500, 10000, 0.662, 1, 142, False)[1] == "Hold - only 1 comp; add a manual rate before changing"
    assert "demand issue" in ops_cma.suggest(11350, 13353, 0.0, 6, 2, False)[1]
    assert ops_cma.suggest(10400, 13130, 0, 2, 11, True) == (None, "All units offline - nothing to price", "none")
    s, why, move = ops_cma.suggest(15000, 12000, 0.40, 3, 10, False)
    assert move == "lower" and s == 13500


def test_market_excludes_closed_and_uses_one_set_for_low_high_avg():
    comps = {"a": {"name": "A"}, "b": {"name": "B"}, "c": {"name": "C"}}       # "x" (closed) is not in it
    obs = [{"competitor_id": k, "width": 12, "depth": 32, "parking": True, "rate_cents": v, "observed_on": "2026-10-15",
            "source": "manual"} for k, v in (("a", 11000), ("b", 11000), ("c", 15400), ("x", 9000))]
    m = ops_cma.pick_comps({"name": "12' x 32' Parking", "width": 12, "depth": 32, "parking": True}, obs, comps, TODAY)
    assert (m["low"], m["high"], m["avg"], m["count"]) == (11000, 15400, 12467, 3)


def test_manual_only_drops_website_reads_and_a_lock_beats_a_newer_read():
    comps = {"a": {"name": "A", "priceSource": "manual"}, "b": {"name": "B"}}
    base = {"width": 10, "depth": 20, "parking": True}
    obs = [{**base, "competitor_id": "a", "rate_cents": 16260, "observed_on": "2026-10-19", "source": "web"},
           {**base, "competitor_id": "a", "rate_cents": 15000, "observed_on": "2026-10-01", "source": "manual"},
           {**base, "competitor_id": "b", "rate_cents": 14000, "observed_on": "2026-10-10", "source": "override",
            "locked_until": "2026-11-09"},
           {**base, "competitor_id": "b", "rate_cents": 16000, "observed_on": "2026-10-19", "source": "web"}]
    m = ops_cma.pick_comps({"name": "10' x 20' Parking", **base}, obs, comps, TODAY)
    assert {c["competitor"]: c["rate"] for c in m["comps"]} == {"A": 15000, "B": 14000}
    assert next(c for c in m["comps"] if c["competitor"] == "B")["locked"] is True
    # After the lock ends the newer website read wins again.
    m = ops_cma.pick_comps({"name": "10' x 20' Parking", **base}, obs, comps, date(2026, 11, 20))
    assert next(c for c in m["comps"] if c["competitor"] == "B")["rate"] == 16000


def test_nearest_size_is_flagged_and_a_staff_match_counts_for_that_type():
    comps = {"a": {"name": "A"}, "b": {"name": "B"}}
    obs = [{"competitor_id": "a", "width": 12, "depth": 30, "parking": True, "rate_cents": 13000, "observed_on": "2026-10-15"},
           {"competitor_id": "b", "width": 10, "depth": 10, "parking": True, "rate_cents": 9000, "observed_on": "2026-10-15",
            "matched_unit_type": "12' x 26' Parking"}]
    m = ops_cma.pick_comps({"name": "12' x 32' Parking", "width": 12, "depth": 32, "parking": True}, obs, comps, TODAY)
    assert m["nearest"] == "12' x 30'" and m["count"] == 1
    m = ops_cma.pick_comps({"name": "12' x 26' Parking", "width": 12, "depth": 26, "parking": True}, obs, comps, TODAY)
    assert [c["competitor"] for c in m["comps"]] == ["B"] and m["nearest"] == ""    # matched beats nearest
    t = [{"name": "8' x 10'", "width": 8, "depth": 10}, {"name": "10' x 20'", "width": 10, "depth": 20}]
    assert ops_cma.nearest_type(8, 10, False, t) == {"name": "8' x 10'", "exact": True, "note": ""}
    assert ops_cma.nearest_type(10, 15, False, t)["name"] == "10' x 20'"
    assert ops_cma.parse_size("8'x10' drive-up") == (8.0, 10.0) and ops_cma.parse_size("big") is None


def test_guardrails():
    g = ops_cma.guard(11450, 11950, 11400, 11900, 11000, "", TODAY)
    assert g == {"needsOwner": False, "notes": [], "blocks": []}
    g = ops_cma.guard(10000, 11500, None, None, None, "", TODAY)
    assert g["needsOwner"] and "over 10%" in g["notes"][0]
    g = ops_cma.guard(11450, 10500, None, None, 11000, "", TODAY)
    assert g["needsOwner"] and any("market low" in n for n in g["notes"])
    g = ops_cma.guard(11450, 12000, None, None, None, "", TODAY)
    assert "use $119.50" in g["blocks"][0] or "use $120.50" in g["blocks"][0]
    g = ops_cma.guard(11400, 11900, None, None, None, "2026-10-16", TODAY)
    assert "10/16/2026" in g["blocks"][0] and "7 days" in g["blocks"][0]
    assert ops_cma.guard(11400, 11900, None, None, None, "2026-10-12", TODAY)["blocks"] == []


def test_days_vacant_averages_the_vacant_units_since_their_last_move_out():
    rr = [{"unitId": "u1", "status": "VACANT", "pricingGroupName": "A"},
          {"unitId": "u2", "status": "VACANT", "pricingGroupName": "A"},
          {"unitId": "u3", "status": "VACANT", "pricingGroupName": "A"},
          {"unitId": "u4", "status": "RENTED", "pricingGroupName": "A"}]
    leases = [{"unitId": "u1", "moveOutDate": "2026-10-10"}, {"unitId": "u1", "moveOutDate": "2026-01-01"},
              {"unitId": "u2", "moveOutDate": "2026-09-30"}]
    assert ops_cma.days_vacant(rr, leases, TODAY) == {"A": {"avg": 15, "known": 2, "vacant": 3}}


def test_promotions_validate_and_read_like_cubby():
    p = {"name": "Fall Promo", "calculation": "percent", "amount": 50, "periods": 2, "start": "2026-11-01",
         "end": "2026-12-31", "unitTypes": ["12' x 26' Parking"]}
    assert ops_cma.validate_promo(p) == [] and ops_cma.promo_text(p) == "First 2 months 50% off"
    assert ops_cma.promo_text({"calculation": "first_month_1"}) == "$1 first month"
    assert "end date is before" in " ".join(ops_cma.validate_promo({**p, "end": "2026-10-01"}))
    assert ops_cma.validate_promo({**p, "unitTypes": []})


def test_import_rows_are_checked_one_by_one():
    rows = [{"Competitor": "Tri-City", "Their Size": "12 x 32", "Kind": "Parking", "Street Rate": "$110",
             "Survey Date": "10/15/2026"},
            {"Competitor": "Nobody", "Their Size": "huge", "Kind": "Boat", "Street Rate": "abc", "Survey Date": "13/40/2026"}]
    out = ops_cma.read_import(rows, {"tri-city": "tri"}, TYPES, TODAY)
    assert out[0]["ok"] and out[0]["street"] == 11000 and out[0]["matchedUnitType"] == "12' x 32' Parking"
    assert out[0]["observedOn"] == "2026-10-15" and out[0]["row"] == 2
    errs = " ".join(out[1]["errors"])
    for bit in ("not in this facility", "Their Size", "Street Rate", "Survey Date"):
        assert bit in errs


# ── The overview row (routers/ops_rates) ─────────────────────────────────────

def test_the_overview_row_matches_the_mockup(db, fake):
    _mockup_market(db)
    v = _client().get(f"/facility-ops/rates?facility_id={FAC}").json()
    r = next(x for x in v["rows"] if x["name"] == "12' x 32' Parking")
    assert (r["marketLow"], r["marketHigh"], r["marketAvg"], r["competitors"]) == (11000, 15400, 12467, 3)
    assert r["variance"] == 11450 - 12467 and r["variancePct"] == round(-1017 / 12467, 4)
    assert r["suggested"] == 11950 and r["move"] == "raise"
    assert r["occupancy"] == round(92 / 114, 4) and r["avgRent"] == 12274
    assert [c["competitor"] for c in r["comps"]] and "StorQuest" not in [c["competitor"] for c in r["comps"]]
    assert v["compSet"]["closed"] == 1 and r["algorithmWebRate"] is None and r["webRate"] == 11450
    c = _client()
    v = c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": "12' x 32' Parking", "proposed": 119.5}).json()
    r = next(x for x in v["rows"] if x["name"] == "12' x 32' Parking")
    assert r["revDelta"] == 500 * 92                                     # (proposed - sell) x OCCUPIED: +$460
    assert db.query(models.OpsCmaSnapshot).filter(models.OpsCmaSnapshot.unit_type == "12' x 32' Parking").count() == 1


# ── Comp set, surveys, overrides, import ─────────────────────────────────────

def test_a_survey_saves_its_rates_matched_to_our_types(db, fake):
    _comp(db, "almond", "Almond Acres")
    db.commit()
    c = _client()
    body = {"facility_id": FAC, "competitor_id": "almond", "survey_date": "2026-10-15", "method": "phone",
            "surveyed_by": "JW", "special": "1st month $1", "admin_fee": 25, "insurance": "$12 / month, required",
            "rates": [{"their_size": "12 x 32", "kind": "parking", "access": "Gravel - Open - Drive-In", "street": 110},
                      {"their_size": "12 x 30", "kind": "parking", "street": 105, "online": 99}]}
    out = c.post("/facility-ops/cma/surveys", json=body)
    assert out.status_code == 201
    comp = next(x for x in out.json()["competitors"] if x["id"] == "almond")
    assert comp["lastSurvey"]["adminFee"] == 2500 and comp["lastSurvey"]["by"] == "JW" and comp["badge"] == "manual"
    near = next(x for x in comp["rates"] if x["theirSize"] == "12 x 30")
    assert near["matchedUnitType"] == "12' x 32' Parking" and near["note"].startswith("Nearest size")
    v = c.get(f"/facility-ops/rates?facility_id={FAC}").json()
    r = next(x for x in v["rows"] if x["name"] == "12' x 32' Parking")
    assert r["comps"][0]["adminFee"] == 2500 and r["promoCount"] == 1 and r["adminFeeLow"] == 2500
    assert c.post("/facility-ops/cma/surveys", json={**body, "survey_date": "2030-01-01"}).status_code == 422
    assert _client(2, "supervisor").post("/facility-ops/cma/surveys", json=body).status_code == 401
    ev = db.query(models.OpsCmaEvent).one()
    assert ev.kind == "manual" and "Almond Acres" in ev.text


def test_closing_a_competitor_takes_it_out_of_the_averages(db, fake):
    _mockup_market(db)
    c = _client()
    cs = c.post("/facility-ops/cma/competitors/sps/close", json={"closed": True, "note": "STORE now at this address"}).json()
    sps = next(x for x in cs["competitors"] if x["id"] == "sps")
    assert sps["closed"] and sps["badge"] == "closed" and cs["counts"]["closed"] == 2
    r = next(x for x in c.get(f"/facility-ops/rates?facility_id={FAC}").json()["rows"] if x["name"] == "12' x 32' Parking")
    assert (r["marketHigh"], r["competitors"]) == (11000, 2)
    c.post("/facility-ops/cma/competitors/sps/close", json={"closed": False})
    r = next(x for x in c.get(f"/facility-ops/rates?facility_id={FAC}").json()["rows"] if x["name"] == "12' x 32' Parking")
    assert r["competitors"] == 3


def test_an_override_locks_for_30_days(db, fake):
    _mockup_market(db)
    c = _client()
    cs = c.post("/facility-ops/cma/overrides", json={"competitor_id": "sps", "width": 12, "depth": 32, "parking": True,
                                                     "rate": 140, "reason": "Phone quote lower than site", "lock": True}).json()
    sps = next(x for x in cs["competitors"] if x["id"] == "sps")
    assert sps["lockedOverrides"] == 1
    _rate(db, "sps", 12, 32, 15900, day="2026-10-20", source="web")     # a newer website read
    db.commit()
    r = next(x for x in c.get(f"/facility-ops/rates?facility_id={FAC}").json()["rows"] if x["name"] == "12' x 32' Parking")
    assert next(x for x in r["comps"] if x["competitor"] == "Security Public Storage")["rate"] == 14000


def test_import_previews_then_saves_the_good_rows(db, fake):
    _comp(db, "tri", "Tri-City Boat & RV")
    db.commit()
    rows = [{"Competitor": "Tri-City Boat & RV", "Their Size": "12 x 32", "Kind": "Parking", "Street Rate": "110",
             "Survey Date": "10/15/2026", "Admin Fee": "20"},
            {"Competitor": "Ghost", "Their Size": "12 x 32", "Street Rate": "110"}]
    c = _client()
    pre = c.post("/facility-ops/cma/import", json={"facility_id": FAC, "rows": rows}).json()
    assert (pre["ok"], pre["errors"], pre["saved"]) == (1, 1, 0) and db.query(models.OpsCompetitorRate).count() == 0
    done = c.post("/facility-ops/cma/import", json={"facility_id": FAC, "rows": rows, "commit": True}).json()
    assert done["saved"] == 1
    r = db.query(models.OpsCompetitorRate).one()
    assert (r.rate_cents, r.matched_unit_type, r.source) == (11000, "12' x 32' Parking", "manual")
    assert db.query(models.OpsCmaSurvey).one().admin_fee_cents == 2000


# ── Review & Push ────────────────────────────────────────────────────────────

def _propose(c, dollars=119.5, name="12' x 32' Parking"):
    c.put("/facility-ops/rates/draft", json={"facility_id": FAC, "unit_type": name, "proposed": dollars})


def _apply(c, mode="entered", role="ops_manager", rid="req-00000001", send="immediate", **kw):
    return c.post("/facility-ops/cma/review/apply", json={"facility_id": FAC, "request_id": rid, "rates": ["12' x 32' Parking"],
                                                          "approver_role": role, "send": send, "mode": mode, **kw})


def test_review_lists_the_change_with_why_and_who_it_affects(db, fake):
    _mockup_market(db)
    c = _client()
    _propose(c)
    rv = c.get(f"/facility-ops/cma/review?facility_id={FAC}").json()
    item = rv["rates"][0]
    assert (item["nowWeb"], item["newWeb"], item["change"]) == (11450, 11950, "Rate Increase")
    assert item["why"] == "81% occupied, 8.2% below market avg ($124.67)"
    assert item["affects"] == "New move-ins - 21 vacant spaces" and item["effective"] == "2026-11-01"
    assert item["needsOwner"] is False and item["blocks"] == [] and rv["pushOn"] is False
    assert rv["roles"] == {"ops_manager": True, "owner": False}


def test_switch_off_ends_in_mark_entered_and_never_writes(db, fake):
    _mockup_market(db)
    c = _client()
    _propose(c)
    assert _apply(c, mode="push").status_code == 403                    # the switch is off
    out = _apply(c).json()
    assert out["results"][0]["status"] == "entered" and fake.writes_sent() == []
    push = db.query(models.OpsRatePush).one()
    assert (push.status, push.new_sell_cents, push.pushed_by) == ("entered", 11950, "manager@greensglobal.com")
    assert db.query(models.OpsRateDraft).count() == 0
    # Idempotent: the same click again answers the same, records nothing new.
    again = _apply(c).json()
    assert again["replayed"] is True and db.query(models.OpsCmaChange).count() == 1


def test_owner_needed_over_10_percent_and_blocked_twice_in_7_days(db, fake):
    _mockup_market(db)
    c = _client(4, "administrator")
    _propose(c, 140.5)                                                   # +22.7%
    out = _apply(c, rid="req-a0000001").json()
    assert out["results"][0]["status"] == "blocked" and "Owner" in out["results"][0]["detail"]
    assert _apply(c, role="owner", rid="req-a0000002").json()["results"][0]["status"] == "entered"
    _propose(c, 141.5)
    out = _apply(c, role="owner", rid="req-a0000003").json()
    assert out["results"][0]["status"] == "blocked" and "7 days" in out["results"][0]["detail"]
    assert _client(3, "manager").post("/facility-ops/cma/review/apply", json={
        "facility_id": FAC, "request_id": "req-a0000004", "rates": ["x"], "approver_role": "owner"}).status_code == 403


def test_push_with_the_switch_on_reads_back_and_can_revert(db, fake, monkeypatch):
    _mockup_market(db)
    _switch(db)
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "k")
    fake.writes = True
    c = _client()
    _propose(c)
    out = _apply(c, mode="push").json()
    res = out["results"][0]
    assert res["status"] == "pushed" and res["readbackWeb"] == 11950 and "read back" in res["detail"]
    assert fake.writes_sent() == [{"pricingGroups": [{"pricingGroupId": "pg_1232", "standardRate": 11900, "webRate": 11950}]}]
    assert db.query(models.OpsRatePush).one().status == "ok"
    rv = c.post(f"/facility-ops/cma/changes/{res['id']}/revert").json()
    assert fake.writes_sent()[-1]["pricingGroups"][0]["webRate"] == 11450
    first = next(x for x in rv["decided"] if x["id"] == res["id"])
    assert first["status"] == "reverted" and any(x["revertOf"] == res["id"] and x["status"] == "pushed" for x in rv["decided"])


def test_a_push_that_does_not_read_back_is_failed_and_can_be_retried(db, fake, monkeypatch):
    _mockup_market(db)
    _switch(db)
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "k")
    fake.writes, fake.ignore = True, True
    c = _client()
    _propose(c)
    res = _apply(c, mode="push").json()["results"][0]
    assert res["status"] == "failed" and "did not read back" in res["detail"]
    fake.ignore = False
    rv = c.post(f"/facility-ops/cma/changes/{res['id']}/retry").json()
    assert next(x for x in rv["decided"] if x["id"] == res["id"])["status"] == "pushed"


def test_a_future_effective_date_queues_until_the_day(db, fake, monkeypatch):
    _mockup_market(db)
    _switch(db)
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "k")
    fake.writes = True
    c = _client()
    _propose(c)
    res = _apply(c, mode="push", send="effective", effective_date="2026-11-01").json()["results"][0]
    assert res["status"] == "approved" and "11/01/2026" in res["detail"] and fake.writes_sent() == []
    assert cma_router.run_due(db, date(2026, 10, 31)) == 0
    _switch(db, False)                                                  # switched off before the day: nothing goes
    assert cma_router.run_due(db, date(2026, 11, 1)) == 0 and fake.writes_sent() == []
    _switch(db, True)
    assert cma_router.run_due(db, date(2026, 11, 1)) == 1
    assert db.get(models.OpsCmaChange, res["id"]).status == "pushed"


def test_promotions_are_approved_then_entered_by_hand(db, fake, monkeypatch):
    _mockup_market(db)
    _switch(db)
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "k")
    c = _client()
    p = c.post("/facility-ops/cma/promos", json={"facility_id": FAC, "name": "Fall Promo", "calculation": "percent",
                                                 "amount": 50, "periods": 2, "start": "2026-11-01", "end": "2026-12-31",
                                                 "unit_types": ["12' x 32' Parking"], "reason": "66% occupied"})
    assert p.status_code == 201 and p.json()["promoText"] == "First 2 months 50% off"
    rv = c.get(f"/facility-ops/cma/review?facility_id={FAC}").json()
    assert rv["promos"][0]["affects"] == "New move-ins only - 21 vacant spaces"
    out = c.post("/facility-ops/cma/review/apply", json={"facility_id": FAC, "request_id": "req-p0000001",
                                                         "promos": [p.json()["id"]], "approver_role": "ops_manager",
                                                         "mode": "push"}).json()
    assert out["results"][0]["status"] == "approved" and "cannot create or end a discount" in out["results"][0]["detail"]
    assert fake.writes_sent() == []                                    # no discount API: never pushed
    rv = c.post(f"/facility-ops/cma/changes/{p.json()['id']}/entered").json()
    assert next(x for x in rv["decided"] if x["id"] == p.json()["id"])["status"] == "entered"
    bad = c.post("/facility-ops/cma/promos", json={"facility_id": FAC, "name": "X", "calculation": "percent", "amount": 0,
                                                   "unit_types": []})
    assert bad.status_code == 422


def test_reject_returns_it_to_the_proposer(db, fake):
    _mockup_market(db)
    c = _client()
    _propose(c)
    rv = c.post("/facility-ops/cma/review/reject", json={"facility_id": FAC, "rates": ["12' x 32' Parking"],
                                                         "note": "Wait for the Nov survey"}).json()
    assert rv["rates"] == [] and rv["decided"][0]["status"] == "rejected" and rv["decided"][0]["note"] == "Wait for the Nov survey"
    assert _client(2, "supervisor").post("/facility-ops/cma/review/reject", json={"facility_id": FAC}).status_code == 401


def test_revert_with_the_switch_off_proposes_the_old_rate(db, fake):
    _mockup_market(db)
    c = _client()
    _propose(c)
    res = _apply(c).json()["results"][0]
    c.post(f"/facility-ops/cma/changes/{res['id']}/revert")
    d = db.query(models.OpsRateDraft).one()
    assert d.proposed_cents == 11450 and d.note.startswith("Revert to the rates before 10/")
    assert fake.writes_sent() == []


# ── Rate History ─────────────────────────────────────────────────────────────

def test_history_has_points_cards_and_a_change_log(db, fake):
    _mockup_market(db)
    c = _client()
    c.post("/facility-ops/cma/competitors/sq/close", json={"closed": False})
    c.post("/facility-ops/cma/competitors/sq/close", json={"closed": True, "note": "STORE now at this address"})
    c.get(f"/facility-ops/rates?facility_id={FAC}")                     # writes today's snapshot
    db.add(models.CubbyRateHistory(id="h1", facility_id=FAC, pricing_group_id="pg_1232", group_name="12' x 32' Parking",
                                   field="standardRate", old_value=11450, new_value=11400,
                                   changed_at="2026-10-01T12:00:00+00:00", changed_on="2026-10-01"))
    db.commit()
    h = c.get(f"/facility-ops/cma/history?facility_id={FAC}&unit_type=12' x 32' Parking").json()
    last = h["points"][-1]
    assert last["date"] == "2026-10-20" and last["sell"] == 11450 and last["marketAvg"] == 12467
    assert h["cards"]["gap"] == 11450 - 12467 and h["cards"]["rentVsSell"] == 12274 - 11450
    sources = {e["source"] for e in h["log"]}
    assert {"comp_set", "cubby", "website"} <= sources
    assert any("$114.50 -> $114.00" in e["text"] for e in h["log"])
    assert h["workbookImport"]["available"] is False
    assert c.get(f"/facility-ops/cma/history?facility_id={FAC}&unit_type=nope").status_code == 404
