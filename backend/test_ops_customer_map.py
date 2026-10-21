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


def _unit(fid, uid, cid, status="RENTED", group="10x10"):
    return models.CubbyUnit(id=f"{fid}:{uid}", facility_id=fid, unit_id=uid, status=status, customer_id=cid,
                            data={"rentRoll": {"unitId": uid, "status": status, "customerId": cid, "pricingGroupName": group}})


@pytest.fixture
def db(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no real HTTP in tests")
    monkeypatch.setattr(httpx, "get", boom)
    monkeypatch.setattr(httpx, "post", boom)
    monkeypatch.setattr(httpx, "Client", boom)
    geo._zip_cache.clear()
    s = SessionLocal()
    for t in (models.OpsCustomerPoint, models.CubbyUnit, models.CubbyFacility):
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


def test_api_aggregates_counts_rings_and_coverage(client, db):
    _seed_points(db)
    r = client.get(f"/facility-ops/customer-map?facility={FAC}")
    assert r.status_code == 200
    body = r.json()
    assert [f["shortName"] for f in body["facilities"]] == ["Temecula"]
    assert body["facilities"][0]["lat"] == 33.5
    pts = sorted(body["points"], key=lambda p: p["lat"])
    assert pts == [{"lat": 33.51, "lng": -117.15, "facilityId": FAC, "count": 2, "precision": "street"},
                   {"lat": 33.9, "lng": -117.15, "facilityId": FAC, "count": 1, "precision": "zip"}]
    assert body["coverage"][FAC] == {"current": 3, "placed": 3, "zipOnly": 1, "missing": 0, "pending": 0}
    assert [x["count"] for x in body["rings"]] == [2, 2, 2, 2, 2, 3] and body["beyond"] == 0
    # Every facility; c1 at Escondido is still pending.
    allb = client.get("/facility-ops/customer-map").json()
    assert {f["id"] for f in allb["facilities"]} == {FAC, FAC2}
    assert allb["coverage"][FAC2]["pending"] == 1 and allb["total"]["current"] == 4
    assert client.get("/facility-ops/customer-map?facility=nope").status_code == 404
    # Nothing personal in the payload: no customer id, no name, no address.
    text = r.text + client.get("/facility-ops/customer-map").text
    for bit in ("c1", "c2", "c3", "customerId", "customer_id", "fingerprint",
                *(b for b in SECRET_BITS if b != "Temecula")):     # the facility's own name says Temecula
        assert bit not in text, bit


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
