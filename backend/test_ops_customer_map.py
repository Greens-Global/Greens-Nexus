"""Operations > Customer Map (ops_customer_geo.py + routers/ops_customer_map.py):
fingerprint skip vs re-geocode, street -> ZIP -> missing, rounding, no address
or name ever stored or returned, the shared Nominatim pacer, the current-
customer filter, ring counts, access and aggregation. Cubby and Nominatim are
fakes; httpx is booby-trapped so nothing leaves the test.
Run alone: python -m pytest test_ops_customer_map.py"""
import threading
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import asset_geocode
import models
import nominatim_pace
import ops_customer_geo as geo
from auth import get_current_user
from database import SessionLocal

FAC = "fac_tem"
FAC2 = "fac_esc"
ADDR = {"address": "41000 Main St", "address2": "Apt 4", "city": "Temecula", "state": "CA", "zip": "92590", "country": "US"}
SECRET_BITS = ("41000", "Main St", "Temecula", "92590", "Apt 4", "Jane", "Doe", "555", "@")


def _unit(fid, uid, cid, status="RENTED", group="10x10", rent=10000, move_in="2020-01-01"):
    return models.CubbyUnit(id=f"{fid}:{uid}", facility_id=fid, unit_id=uid, status=status, customer_id=cid,
                            data={"rentRoll": {"unitId": uid, "status": status, "customerId": cid, "pricingGroupName": group,
                                               "monthlyRentalAmount": rent, "moveInDate": move_in,
                                               "customerName": "Jane Doe"}})


@pytest.fixture
def db(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no real HTTP in tests")
    monkeypatch.setattr(httpx, "get", boom)
    monkeypatch.setattr(httpx, "post", boom)
    monkeypatch.setattr(httpx, "Client", boom)
    geo._zip_cache.clear()
    s = SessionLocal()
    for t in (models.OpsCustomerPoint, models.CubbyUnit, models.CubbyFacility, models.OpsCompetitor):
        s.query(t).delete()
    s.add(models.CubbyFacility(facility_id=FAC, name="Greens Storage Temecula", enabled=True,
                               data={"latitude": "33.5000", "longitude": "-117.1500"}))
    s.add(models.CubbyFacility(facility_id=FAC2, name="Greens Storage Escondido", enabled=True,
                               data={"latitude": "33.1200", "longitude": "-117.0800"}))
    s.add(models.CubbyFacility(facility_id="fac_gone", name="Old", enabled=False, data={}))
    s.add_all([
        _unit(FAC, "u1", "c1"), _unit(FAC, "u2", "c2"), _unit(FAC, "u3", "c3"),
        _unit(FAC, "u4", "c4", status="VACANT"),                         # not a tenant
        _unit(FAC, "u5", "c5", group="0' x 0' Deactivated"),             # switched-off record
        _unit(FAC2, "e1", "c1"),                                         # c1 rents at both
        _unit("fac_gone", "g1", "c9"),
    ])
    s.commit()
    yield s
    s.rollback()
    s.close()


def _customers(contacts):
    """read_customers fake: what customers/search returns, names and all."""
    def read(fid):
        return [{"customerId": cid, "firstName": "Jane", "lastName": "Doe", "email": "jane@example.com",
                 "phone": "555-0100", "contact": contacts.get((fid, cid), contacts.get(cid))}
                for cid in ("c1", "c2", "c3", "c4", "c5", "c9")]
    return read


def _fetch(asked, table):
    def fetch(q):
        asked.append(q)
        return table.get(q)
    return fetch


def test_current_customer_filter(db):
    cur = geo.current_customers(db)
    assert cur == {FAC: {"c1", "c2", "c3"}, FAC2: {"c1"}}


def test_street_then_zip_then_missing_with_rounding(db):
    contacts = {
        "c1": ADDR,
        "c2": {"address": "1 Nowhere Rd", "city": "Temecula", "state": "CA", "zip": "92591", "country": "US"},
        "c3": {"address": "2 Nowhere Rd", "city": "Temecula", "state": "CA", "zip": "", "country": "US"},
    }
    asked = []
    table = {"41000 Main St, Temecula, CA 92590, US": (33.512345, -117.148765),
             "92591, CA, USA": (33.4999, -117.1001)}
    res = geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert res["more"] is False
    rows = {(r.facility_id, r.customer_id): r for r in db.query(models.OpsCustomerPoint).all()}
    assert set(rows) == {(FAC, "c1"), (FAC, "c2"), (FAC, "c3"), (FAC2, "c1")}
    c1 = rows[(FAC, "c1")]
    assert (c1.lat, c1.lng, c1.precision) == (33.512, -117.149, "street")
    c2 = rows[(FAC, "c2")]
    assert (c2.lat, c2.lng, c2.precision) == (33.5, -117.1, "zip")
    c3 = rows[(FAC, "c3")]
    assert (c3.lat, c3.lng, c3.precision) == (None, None, "missing")
    # The address2 never goes out; the ZIP fallback only after the street missed.
    assert "Apt 4" not in " ".join(asked)
    assert asked.index("1 Nowhere Rd, Temecula, CA 92591, US") < asked.index("92591, CA, USA")


def test_fingerprint_skips_unchanged_and_relooks_changed(db):
    contacts = {"c1": ADDR, "c2": ADDR, "c3": ADDR}
    asked = []
    table = {"41000 Main St, Temecula, CA 92590, US": (33.51, -117.14), "9 Oak Ave, Temecula, CA 92590, US": (33.52, -117.13)}
    geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert len(asked) == 4                          # c1 (twice: two facilities), c2, c3
    asked.clear()
    geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert asked == []                              # nothing changed, nothing asked
    # Only spacing / case changed: same fingerprint.
    contacts["c2"] = {**ADDR, "address": "41000  main st", "city": "TEMECULA"}
    geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert asked == []
    contacts["c3"] = {**ADDR, "address": "9 Oak Ave"}
    geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert asked == ["9 Oak Ave, Temecula, CA 92590, US"]
    assert db.get(models.OpsCustomerPoint, f"{FAC}:c3").lat == 33.52


def test_batches_resume_and_a_service_error_stops_the_pass(db):
    contacts = {"c1": ADDR, "c2": ADDR, "c3": ADDR}
    asked = []
    table = {"41000 Main St, Temecula, CA 92590, US": (33.51, -117.14)}
    res = geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table), limit=2)
    assert res["more"] and db.query(models.OpsCustomerPoint).count() == 2
    def angry(q):
        raise RuntimeError("nominatim 429")
    res = geo.geocode_pass(db, read_customers=_customers(contacts), fetch=angry)
    assert res["more"] and db.query(models.OpsCustomerPoint).count() == 2
    res = geo.geocode_pass(db, read_customers=_customers(contacts), fetch=_fetch(asked, table))
    assert not res["more"] and db.query(models.OpsCustomerPoint).count() == 4


def test_customers_no_longer_current_lose_their_row(db):
    contacts = {"c1": ADDR, "c2": ADDR, "c3": ADDR}
    fetch = _fetch([], {"41000 Main St, Temecula, CA 92590, US": (33.51, -117.14)})
    geo.geocode_pass(db, read_customers=_customers(contacts), fetch=fetch)
    db.get(models.CubbyUnit, f"{FAC}:u2").status = "VACANT"
    db.commit()
    res = geo.geocode_pass(db, read_customers=_customers(contacts), fetch=fetch)
    assert res["dropped"] == 1 and db.get(models.OpsCustomerPoint, f"{FAC}:c2") is None


def test_no_address_name_or_contact_is_ever_stored(db):
    contacts = {"c1": ADDR, "c2": {**ADDR, "zip": "92591"}, "c3": None}
    geo.geocode_pass(db, read_customers=_customers(contacts),
                     fetch=_fetch([], {"41000 Main St, Temecula, CA 92590, US": (33.51, -117.14)}))
    cols = [c.name for c in models.OpsCustomerPoint.__table__.columns]
    assert cols == ["id", "facility_id", "customer_id", "lat", "lng", "precision", "fingerprint", "geocoded_at"]
    for r in db.query(models.OpsCustomerPoint).all():
        blob = repr([getattr(r, c) for c in cols])
        for bit in SECRET_BITS:
            assert bit not in blob, bit
        assert len(r.fingerprint) == 64


def test_rings_haversine():
    assert geo.miles_between(33.5, -117.15, 33.5, -117.15) == 0
    # One degree of latitude is about 69 miles.
    assert 68.9 < geo.miles_between(33.0, -117.0, 34.0, -117.0) < 69.2
    out = geo.ring_counts([0.4, 1.0, 1.5, 2.9, 4.0, 9.0, 49.0, 51.0, 300.0])
    assert [r["count"] for r in out["rings"]] == [2, 3, 4, 5, 6, 7]
    assert (out["beyond"], out["placed"]) == (2, 9)


@pytest.fixture
def client(db, monkeypatch):
    from routers import ops_customer_map as router_mod
    app = FastAPI()
    app.include_router(router_mod.router)
    user = {"email": "ops.manager@greensglobal.com", "role": "manager", "level": 3}
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    c.user, c.router_mod = user, router_mod
    return c


def _seed_points(db):
    P = models.OpsCustomerPoint
    db.add_all([
        P(id=f"{FAC}:c1", facility_id=FAC, customer_id="c1", lat=33.51, lng=-117.15, precision="street", fingerprint="x"),
        P(id=f"{FAC}:c2", facility_id=FAC, customer_id="c2", lat=33.51, lng=-117.15, precision="street", fingerprint="x"),
        P(id=f"{FAC}:c3", facility_id=FAC, customer_id="c3", lat=33.9, lng=-117.15, precision="zip", fingerprint="x"),
        P(id=f"{FAC}:c4", facility_id=FAC, customer_id="c4", lat=33.0, lng=-117.0, precision="street", fingerprint="x"),  # not current
    ])
    db.commit()


def _rows(body):
    cols = body["pointCols"]
    return [dict(zip(cols, r)) for r in body["points"]]


def _no_personal_bits(text):
    for bit in ("c1", "c2", "c3", "customerId", "customer_id", "fingerprint", "Jane", "Doe", "customerName",
                *(b for b in SECRET_BITS if b != "Temecula")):     # the facility's own name says Temecula
        assert bit not in text, bit


def test_api_aggregates_counts_rings_and_coverage(client, db):
    _seed_points(db)
    r = client.get(f"/facility-ops/customer-map?facility={FAC}")
    assert r.status_code == 200
    body = r.json()
    assert [f["shortName"] for f in body["facilities"]] == ["Temecula"]
    assert body["facilities"][0]["lat"] == 33.5
    assert [g["shortName"] for g in body["greens"]] == ["Escondido", "Temecula"]
    tem = 1                                          # Temecula's index in `greens`
    pts = sorted(_rows(body), key=lambda p: p["lat"])
    assert [(p["lat"], p["lng"], p["facility"], p["zip"], p["count"]) for p in pts] == [
        (33.51, -117.15, tem, 0, 2), (33.9, -117.15, tem, 1, 1)]
    assert 0.6 < pts[0]["miles"] < 0.75 and 27 < pts[1]["miles"] < 28
    assert body["coverage"][FAC] == {"current": 3, "placed": 3, "zipOnly": 1, "missing": 0, "pending": 0}
    st = body["stats"]
    assert [x["count"] for x in st["rings"]] == [2, 2, 2, 2, 2, 3] and st["beyond"] == 0 and st["placed"] == 3
    assert body["byFacility"][FAC]["rings"] == st["rings"]
    # Every facility; c1 at Escondido is still pending.
    allb = client.get("/facility-ops/customer-map").json()
    assert {f["id"] for f in allb["facilities"]} == {FAC, FAC2}
    assert allb["coverage"][FAC2]["pending"] == 1 and allb["total"]["current"] == 4
    assert client.get("/facility-ops/customer-map?facility=nope").status_code == 404
    # Nothing personal in the payload: no customer id, no name, no address.
    _no_personal_bits(r.text + client.get("/facility-ops/customer-map").text)


def test_trade_stats_on_a_known_set():
    d = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 6.0, 20.0, 80.0]
    s = geo.trade_stats(d)
    # Nearest rank: 50% -> 5th value, 80% -> 8th, 90% -> 9th.
    assert s["radii"] == {"50": 2.5, "80": 6.0, "90": 20.0}
    assert s["median"] == 2.75 and s["meanAll"] == 12.05
    assert s["mean"] == 4.5                      # the average leaves out the one 50+ mile customer (Oct 22)
    assert [(b["min"], b["max"], b["count"]) for b in s["buckets"]] == [
        (0, 1, 2), (1, 2, 2), (2, 3, 2), (3, 5, 1), (5, 10, 1), (10, 50, 1), (50, None, 1)]
    assert sum(b["count"] for b in s["buckets"]) == len(d)
    assert s["beyond"] == 1 and s["placed"] == 10
    empty = geo.trade_stats([])
    assert empty["radii"] == {"50": None, "80": None, "90": None} and empty["median"] is None and empty["mean"] is None
    assert geo.percentile([7.0], 90) == 7.0


def test_kind_tenure_and_rent_buckets():
    today = geo.date(2026, 10, 22)
    assert geo.kind_of(["Parking - RV, Uncovered"]) == "vehicle"
    assert geo.kind_of(["Parking - RV", "10' x 10' Storage"]) == "storage"     # a storage unit makes them storage
    assert geo.kind_of(["0' x 3' mailbox"]) == "storage"
    assert geo.tenure_of("2026-09-01", today) == "under90d"
    assert geo.tenure_of("2026-07-24", today) == "under1y"                     # 90 days ago
    assert geo.tenure_of("2025-10-23", today) == "under1y"
    assert geo.tenure_of("2024-01-01", today) == "1to3y"
    assert geo.tenure_of("2019-05-01", today) == "over3y"
    assert geo.tenure_of("", today) == "unknown"
    bands = geo.rent_bands([50, 100, 150, 200, 250, 300, 350, 400])
    assert [(b["min"], b["max"]) for b in bands] == [(50, 100), (100, 200), (200, 300), (300, 400)]
    assert [geo.band_of(x, bands) for x in (50, 100, 101, 200, 300, 301, 400)] == [0, 0, 1, 1, 2, 3, 3]


def _trade_area_seed(db):
    """Temecula: c1 storage (moved in this month, $100), c2 RV parking ($300,
    2 years), c3 storage + parking ($50 + $250, 5 years) placed 100+ miles
    away; Escondido: c1, who lives next to Temecula."""
    for u in db.query(models.CubbyUnit).all():
        db.delete(u)
    db.commit()
    db.add_all([
        _unit(FAC, "u1", "c1", group="10' x 10' Storage", rent=10000, move_in="2026-10-01"),
        _unit(FAC, "u2", "c2", group="Parking - RV, Uncovered", rent=30000, move_in="2024-06-01"),
        _unit(FAC, "u3", "c3", group="5' x 5' Storage", rent=5000, move_in="2021-01-01"),
        _unit(FAC, "u3b", "c3", group="Parking - Asphalt", rent=25000, move_in="2022-01-01"),
        _unit(FAC2, "e1", "c1", group="10' x 10' Storage", rent=20000, move_in="2026-08-01"),
    ])
    P = models.OpsCustomerPoint
    db.add_all([
        P(id=f"{FAC}:c1", facility_id=FAC, customer_id="c1", lat=33.51, lng=-117.15, precision="street", fingerprint="x"),
        P(id=f"{FAC}:c2", facility_id=FAC, customer_id="c2", lat=33.55, lng=-117.15, precision="street", fingerprint="x"),
        P(id=f"{FAC}:c3", facility_id=FAC, customer_id="c3", lat=35.0, lng=-115.5, precision="zip", fingerprint="x"),
        P(id=f"{FAC2}:c1", facility_id=FAC2, customer_id="c1", lat=33.51, lng=-117.15, precision="street", fingerprint="x"),
    ])
    db.commit()


def test_build_map_buckets_filters_outside_and_overlap(db):
    _trade_area_seed(db)
    today = geo.date(2026, 10, 22)
    body = geo.build_map(db, facility=FAC, today=today)
    rows = sorted(_rows(body), key=lambda p: p["lat"])
    k, t = body["kinds"], body["tenures"]
    assert [(k[p["kind"]], t[p["tenure"]], p["rent"], p["count"]) for p in rows] == [
        ("storage", "under90d", None, 1), ("vehicle", "1to3y", None, 1), ("storage", "over3y", None, 1)]   # 1-person groups: no rent
    assert [b["max"] for b in body["rentBands"]] == [100.0, 300.0, 300.0, 300.0]
    assert [p["band"] for p in rows] == [0, 1, 1]
    st = body["stats"]
    assert st["customers"] == 3 and st["placed"] == 3
    assert st["outside50"] == {"count": 1, "regions": [{"state": "CA", "count": 1}]}
    assert body["byFacility"][FAC]["vehiclePct"] == 33.3
    # Overlap: nobody at Temecula lives closer to Escondido...
    assert body["byFacility"][FAC]["closer"] == [] and st["overlap"] == 0
    # ...but Escondido's c1 lives next to Temecula.
    esc = geo.build_map(db, facility=FAC2, today=today)
    assert esc["byFacility"][FAC2]["closer"] == [{"facilityId": FAC, "shortName": "Temecula", "count": 1}]
    assert esc["stats"]["overlap"] == 1
    assert esc["greens"][_rows(esc)[0]["closer"]]["id"] == FAC
    # Filters change the points AND the numbers together.
    veh = geo.build_map(db, facility=FAC, kind="vehicle", today=today)
    assert [r["count"] for r in _rows(veh)] == [1] and veh["stats"]["customers"] == 1
    assert veh["filters"] == {"kind": "vehicle", "since": "all", "band": "all"}
    new = geo.build_map(db, facility=FAC, since="90", today=today)
    assert [(r["count"], r["rent"]) for r in _rows(new)] == [(1, None)] and new["stats"]["outside50"]["count"] == 0
    year = geo.build_map(db, since="365", today=today)
    assert year["stats"]["customers"] == 2                       # Temecula c1 + Escondido c1
    top = geo.build_map(db, facility=FAC, band="1", today=today)
    assert [r["band"] for r in _rows(top)] == [1, 1] and top["stats"]["customers"] == 2   # the $300 band only
    junk = geo.build_map(db, facility=FAC, kind="boats", since="7", band="9", today=today)
    assert junk["filters"] == {"kind": "all", "since": "all", "band": "all"} and junk["stats"]["customers"] == 3
    # All facilities: one comparison row each; each customer measured from their own store.
    allb = geo.build_map(db, today=today)
    assert set(allb["byFacility"]) == {FAC, FAC2}
    assert allb["byFacility"][FAC2]["customers"] == 1 and allb["byFacility"][FAC2]["radii"]["50"] > 25
    assert allb["stats"]["customers"] == 4


def test_competitors_deduped_counted_and_named(db):
    _trade_area_seed(db)
    C = models.OpsCompetitor
    db.add_all([
        C(id="k1", facility_id=FAC, name="Public Storage", lat=33.52, lng=-117.15, active=True),      # ~1.4 mi
        C(id="k1b", facility_id=FAC2, name="Public Storage", lat=33.52, lng=-117.15, active=True),    # same store, other list
        C(id="k2", facility_id=FAC, name="Extra Space", lat=33.56, lng=-117.15, active=True),         # ~4.1 mi
        C(id="k3", facility_id=FAC, name="CubeSmart", lat=33.62, lng=-117.15, active=True),           # ~8.3 mi
        C(id="k4", facility_id=FAC, name="Closed Co", lat=33.5, lng=-117.151, active=False, closed=True),
        C(id="k5", facility_id=FAC, name="No Pin", active=True),
        C(id="k6", facility_id=FAC, name="Far Away", lat=40.0, lng=-110.0, active=True),
    ])
    db.commit()
    body = geo.build_map(db, facility=FAC)
    assert [c["name"] for c in body["competitors"]] == ["Public Storage", "Extra Space", "CubeSmart"]
    assert set(body["competitors"][0]) == {"name", "lat", "lng", "miles"}
    assert body["stats"]["competitorsWithin"] == {"3": 1, "5": 2, "10": 3}
    assert body["byFacility"][FAC]["competitorsWithin"] == {"3": 1, "5": 2, "10": 3}
    # From Escondido (~27 mi south) none are within 10 miles; All counts the nearest shown store.
    allb = geo.build_map(db)
    assert allb["byFacility"][FAC2]["competitorsWithin"] == {"3": 0, "5": 0, "10": 0}
    assert allb["stats"]["competitorsWithin"] == {"3": 1, "5": 2, "10": 3}


def test_api_filters_and_privacy(client, db):
    _trade_area_seed(db)
    r = client.get(f"/facility-ops/customer-map?facility={FAC}&kind=vehicle&since=all&band=all")
    assert r.status_code == 200 and r.json()["stats"]["customers"] == 1
    texts = [r.text] + [client.get(f"/facility-ops/customer-map?{q}").text
                        for q in ("", f"facility={FAC2}", "since=90", "band=3")]
    _no_personal_bits("".join(texts))
    body = client.get("/facility-ops/customer-map").json()
    # Every point row is numbers only - nothing a person can be found by.
    assert body["pointCols"] == ["lat", "lng", "facility", "zip", "kind", "tenure", "band", "count", "rent", "miles", "closer"]
    for row in body["points"]:
        assert all(v is None or isinstance(v, (int, float)) for v in row)
    # A group under 3 customers carries no rent - one person's rent at a ~100 m point is too close (Oct 22).
    ci, ri = body["pointCols"].index("count"), body["pointCols"].index("rent")
    assert any(row[ci] < 3 for row in body["points"])
    for row in body["points"]:
        assert (row[ri] is None) == (row[ci] < 3)


def test_access_managers_and_ops_full_only(client, monkeypatch):
    for level in (1, 2):
        client.user.update({"level": level, "email": f"person{level}@greensglobal.com"})
        assert client.get("/facility-ops/customer-map").status_code == 403
    import auth
    monkeypatch.setattr(client.router_mod, "_module_level",
                        lambda email, mid, db: auth._MODULE_LEVEL_RANK["full"] if mid == "operations" else 0)
    assert client.get("/facility-ops/customer-map").status_code == 200
    monkeypatch.setattr(client.router_mod, "_module_level", lambda email, mid, db: auth._MODULE_LEVEL_RANK["editor"])
    assert client.get("/facility-ops/customer-map").status_code == 403
    client.user.update({"level": 4})
    assert client.get("/facility-ops/customer-map").status_code == 200


def test_shared_pacer_serializes_both_loops(monkeypatch):
    monkeypatch.setattr(nominatim_pace, "MIN_GAP_SECONDS", 0.05)
    stamps = []
    lock = threading.Lock()

    def fake_search(q):
        with lock:
            stamps.append(time.monotonic())
        return (33.0, -117.0)
    monkeypatch.setattr(asset_geocode, "_nominatim_search", fake_search)

    def asset_loop():
        for _ in range(5):
            asset_geocode.paced_search("asset")

    def customer_loop():
        for _ in range(5):
            geo._paced_fetch("customer")
    threads = [threading.Thread(target=asset_loop), threading.Thread(target=customer_loop)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    stamps.sort()
    assert len(stamps) == 10
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert min(gaps) >= 0.045, gaps
