"""Third-party managed properties (CubeSmart, Operations Oct 20 2026): the
report parser on the fixture files, the upload preview and upsert, the Ops
facility blocks, the Site Model overlay and the nightly fetch that stays OFF.
Nothing here reaches CubeSmart - fixtures only. Runs on the throwaway SQLite
conftest gives the run. Run alone: python -m pytest test_third_party.py"""
import os
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import database
import models  # noqa: F401 - the shared tables, for create_all
import third_party
import third_party_fetch
import third_party_parse as tpp
from database import SessionLocal
from routers import site_models
from routers import third_party as tp_router
from third_party_models import (ThirdPartyFlashDay, ThirdPartyImport, ThirdPartyProperty, ThirdPartyRentRoll,
                                ThirdPartySreMonth)

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "third_party")
TABLES = (ThirdPartySreMonth, ThirdPartyFlashDay, ThirdPartyRentRoll, ThirdPartyImport, ThirdPartyProperty)
USER = {"email": "ops@example.com", "level": 3, "name": "Ops Person"}
FAKE_USER = "fixture-user@example.com"
FAKE_PASS = "Fixture-Not-A-Real-Password-0001"


def _raw(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


@pytest.fixture(autouse=True)
def clean():
    models.Base.metadata.create_all(bind=database.engine)
    db = SessionLocal()
    for t in TABLES:
        db.query(t).delete()
    db.commit()
    db.close()
    for k in (third_party_fetch.SWITCH, "CUBESMART_USERNAME", "CUBESMART_PASSWORD"):
        os.environ.pop(k, None)
    yield


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(tp_router.router)
    app.dependency_overrides[tp_router.require_read] = lambda: USER
    app.dependency_overrides[tp_router.require_write] = lambda: USER
    return TestClient(app)


def _upload(client, name, commit=False, **form):
    data = {"commit": "true" if commit else "false", **form}
    return client.post("/third-party/upload", files={"file": (name, _raw(name))}, data=data)


# ── Parsing the fixtures ─────────────────────────────────────────────────────

def test_the_sre_summary_reads_by_label_whatever_the_month_order():
    got = tpp.parse_sre(tpp.read_sheets(_raw("cubesmart_sre_summary.xlsx"), "sre.xlsx"))
    oct26 = got["stores"]["6992"]["2026-10"]
    assert oct26["total_cubes_avail"] == 2926 and oct26["rented_during_month"] == 42
    assert oct26["vacated_during_month"] == 58 and oct26["net_rentals"] == -16 and oct26["cubes_occ_eom"] == 2491
    assert oct26["pct_rented_cube"] == 85.1 and oct26["pct_rented_sqft"] == 91.7 and oct26["los_days"] == 399
    # the Revenue & AR table runs oldest first on the sheet - still lands on the right month
    assert oct26["rental_revenue"] == 173504 and oct26["promo_discounts"] == -3133 and oct26["ar_total"] == 9640
    assert got["stores"]["6992"]["2025-08"]["rental_revenue"] == 167900
    assert len(got["stores"]["6992"]) == 15


def test_the_long_sre_layout_and_shuffled_columns_read_too():
    got = tpp.parse_sre(tpp.read_sheets(_raw("cubesmart_sre_summary_long.csv"), "sre.csv"))
    sep = got["stores"]["4568"]["2026-09"]
    assert sep == {"net_rentals": -3, "cubes_occ_eom": 742, "vacated_during_month": 31, "total_cubes_avail": 886,
                   "rented_during_month": 28, "pct_rented_sqft": 88.4, "rental_revenue": 71240.0, "ar_total": 4120.0}


def test_the_daily_flash_tables_read_into_one_day():
    got = tpp.parse_flash(tpp.read_sheets(_raw("cubesmart_daily_flash.xlsx"), "flash.xlsx"))
    d = got["stores"]["6992"]["2026-10-19"]
    assert (d["move_ins_day"], d["move_ins_mtd"], d["move_ins_mtd_budget"], d["move_ins_mtd_py"]) == (3, 42, 60, 59)
    assert (d["move_outs_day"], d["move_outs_mtd"], d["move_outs_mtd_budget"], d["move_outs_mtd_py"]) == (1, 58, 61, 64)
    assert (d["total_cubes"], d["occupied_cubes"], d["vacant_cubes"], d["reserved_cubes"], d["damaged_cubes"], d["unrentable_cubes"]) == (2926, 2491, 414, 9, 1, 11)
    assert d["occupied_sqft"] == 290558 and d["total_sqft"] == 316874   # SQFT came before Cubes on this sheet
    assert (d["accrued_rent_mtd"], d["accrued_rent_budget"], d["accrued_rent_py"]) == (173504, 173841, 166957)
    assert d["revenue_mtd"] == 192761 and d["discount_mtd"] == -3133 and d["write_offs_mtd"] == -1227
    assert d["net_revenue_mtd"] == 188402 and d["net_revenue_py"] == 177665
    assert got["unknown"] == []


def test_the_long_flash_layout_reads_one_row_per_day():
    got = tpp.parse_flash(tpp.read_sheets(_raw("cubesmart_daily_flash_long.csv"), "flash.csv"))
    days = got["stores"]["6093"]
    assert sorted(days) == ["2026-10-17", "2026-10-18"]
    assert days["2026-10-18"]["move_ins_mtd"] == 10 and days["2026-10-18"]["accrued_rent_py"] == 61840


def test_the_rent_roll_reads_four_columns_and_never_a_customer():
    got = tpp.parse_rent_roll(tpp.read_sheets(_raw("cubesmart_rent_roll.csv"), "rr.csv"))
    units = got["stores"]["6992"]
    assert got["asOf"] == "2026-09-30" and len(units) == 9 and got["bad"] == 1
    assert {"n": "5052", "size": "10X10", "attr": "CE"} in units
    assert "Fixture Tenant" not in repr(got) and "FIXTURE" not in repr(got)
    assert all(set(u) == {"n", "size", "attr"} for u in units)
    # the Financials workbook's Rent Roll sheet, filtered to one store
    fin = tpp.parse_rent_roll(tpp.read_sheets(_raw("cubesmart_financials_2026-09-30.xlsx"), "f.xlsx"), store="6992")
    assert [u["n"] for u in fin["stores"]["6992"]] == ["1000", "1001", "2001", "5052"]
    assert "Fixture" not in repr(fin)


def test_number_and_month_cells_as_qlik_exports_them():
    assert tpp.num("2,926") == 2926 and tpp.num("(1,227)") == -1227 and tpp.num("$1,215.13") == 1215.13
    assert tpp.num("NA") is None and tpp.num("-") is None and tpp.num(0.851, pct=True) == 85.1
    assert tpp.month_of("Oct-2026") == "2026-10" and tpp.month_of("Oct-26") == "2026-10" and tpp.month_of("10/2026") == "2026-10"
    assert tpp.month_of("Rented During Month") is None
    with pytest.raises(tpp.ParseError):
        tpp.read_sheets(b"", "x.csv")


# ── Upload: preview, then save ───────────────────────────────────────────────

def test_the_preview_validates_and_saves_nothing(client):
    r = _upload(client, "cubesmart_sre_summary.xlsx")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "sre" and body["saved"] is False and body["errors"] == []
    assert body["properties"][0]["shortName"] == "Austin" and body["properties"][0]["managedLabel"] == "TPM · CubeSmart"
    assert len(body["rows"]) == 15 and body["rows"][0]["period"] == "2026-10" and body["rows"][0]["replaces"] is False
    db = SessionLocal()
    assert db.query(ThirdPartySreMonth).count() == 0
    db.close()


def test_a_file_for_another_store_is_refused(client):
    r = _upload(client, "cubesmart_daily_flash.xlsx", property_id="cubesmart-4568")   # the file says 6992 (Austin)
    assert r.status_code == 200 and r.json()["errors"] and "Austin" in r.json()["errors"][0]
    r = _upload(client, "cubesmart_daily_flash.xlsx", commit=True, property_id="cubesmart-4568")
    assert r.status_code == 400


def test_the_rent_roll_preview_never_echoes_a_customer(client):
    r = _upload(client, "cubesmart_rent_roll.csv")
    assert r.status_code == 200
    assert "Fixture Tenant" not in r.text and "FIXTURE" not in r.text
    assert r.json()["rows"][0]["values"]["rentedUnits"] == 9
    assert any("1 rows were skipped" in w for w in r.json()["warnings"])
    assert "units" not in r.json()["rows"][0]          # the list itself stays server-side


def test_saving_upserts_by_property_and_month_and_day(client):
    assert _upload(client, "cubesmart_sre_summary.xlsx", commit=True).json()["saved"] is True
    assert _upload(client, "cubesmart_daily_flash.xlsx", commit=True).json()["saved"] is True
    again = _upload(client, "cubesmart_sre_summary.xlsx").json()
    assert all(r["replaces"] for r in again["rows"])
    _upload(client, "cubesmart_sre_summary.xlsx", commit=True)
    _upload(client, "cubesmart_daily_flash.xlsx", commit=True)
    db = SessionLocal()
    assert db.query(ThirdPartySreMonth).count() == 15
    assert db.query(ThirdPartyFlashDay).count() == 1
    assert db.query(ThirdPartyImport).filter(ThirdPartyImport.via == "upload").count() == 4
    # a changed figure replaces the stored one
    row = db.query(ThirdPartySreMonth).filter(ThirdPartySreMonth.month == "2026-09").one()
    assert row.rented_during_month == 105
    db.close()
    csv = ("Store,Month,Rented During Month,Tot Cubes Avail\n6992,Sep-2026,111,2926\n").encode()
    r = client.post("/third-party/upload", files={"file": ("fix.csv", csv)}, data={"commit": "true"})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    row = db.query(ThirdPartySreMonth).filter(ThirdPartySreMonth.month == "2026-09").one()
    assert row.rented_during_month == 111 and row.vacated_during_month == 120   # untouched columns kept
    assert db.query(ThirdPartySreMonth).count() == 15
    db.close()


def test_a_rent_roll_with_no_date_asks_for_one(client):
    csv = b"Store,Cube,Cube Dimensions,Cube Attribute\n6992,1000,10X10,CD\n"
    r = client.post("/third-party/upload", files={"file": ("roll.csv", csv)}, data={"commit": "false"})
    assert r.json()["errors"] and "As Of" in r.json()["errors"][0]
    r = client.post("/third-party/upload", files={"file": ("roll.csv", csv)}, data={"commit": "true", "as_of": "09/30/2026"})
    assert r.status_code == 200 and r.json()["saved"] is True


# ── Operations ───────────────────────────────────────────────────────────────

def test_ops_kpis_come_from_the_uploaded_reports(client):
    _upload(client, "cubesmart_sre_summary.xlsx", commit=True)
    _upload(client, "cubesmart_daily_flash.xlsx", commit=True)
    db = SessionLocal()
    out = third_party.ops_facilities(db, today=date(2026, 10, 20))
    db.close()
    by = {f["shortName"]: f for f in out["facilities"]}
    assert set(by) == {"Austin", "Sachse", "Georgetown"}
    a = by["Austin"]
    assert a["id"] == "tp:cubesmart-6992" and a["managedLabel"] == "TPM · CubeSmart"
    assert a["state"] == "TX"     # the State filter (Oct 21)
    assert a["units"] == {"total": 2926, "rented": 2491, "vacant": 414, "unavailable": 21}
    assert a["area"] == {"total": 316874, "rented": 290558}
    assert a["moves"]["insMtd"] == 42 and a["moves"]["outsMtd"] == 58
    assert a["rent"]["rentRoll"] == 187220 * 100            # September, the newest complete month
    assert a["pastDue"]["total"] == 9640 * 100 and a["pastDue"]["buckets"]["d0_30"] == 6210 * 100
    assert a["history"][-1] == {"month": "2026-10", "moveIns": 42, "moveOuts": 58, "rented": 2491}
    # October's moves come from the Daily Flash (MTD on its day), other months from the SRE
    daily = {d["date"]: d for d in a["moves"]["daily"]}
    assert daily["2026-10-19"] == {"date": "2026-10-19", "ins": 42, "outs": 58}
    assert daily["2026-09-30"] == {"date": "2026-09-30", "ins": 105, "outs": 120}
    tp = a["thirdParty"]
    assert tp["dataAsOf"] == "2026-10-19" and tp["dataAsOfText"] == "10/19/2026" and tp["stale"] is False
    assert tp["flash"]["revenue"][0] == {"key": "accrued_rent", "label": "Accrued Rent", "mtd": 17350400, "budget": 17384100, "py": 16695700}
    assert tp["sre"][0]["month"] == "2026-10" and tp["siteModelId"] == "greens-storage-austin"
    # a store with nothing uploaded is listed, empty, and flagged stale
    assert by["Sachse"]["units"]["total"] == 0 and by["Sachse"]["thirdParty"]["stale"] is True
    # every key the Operations screen's combine() reads is there
    for k in ("units", "area", "rent", "pastDue", "locks", "history", "moves", "rentChanges", "unitTypes",
              "belowStreet", "offMarket", "leads", "tasks", "payments", "autoPay", "protected"):
        assert k in a
    assert client.get("/third-party/ops-facilities").status_code == 200


def test_a_week_old_flash_is_stale():
    _ = SessionLocal()
    p = ThirdPartyProperty(id="x", source="cubesmart", store_number="1", name="X", short_name="X")
    f = ThirdPartyFlashDay(id="f", property_id="x", day="2026-10-10", occupied_cubes=5, total_cubes=10, vacant_cubes=5)
    block = third_party.facility_block(p, [], [f], None, None, today=date(2026, 10, 20))
    assert block["thirdParty"]["stale"] is True and block["thirdParty"]["dataAsOfText"] == "10/10/2026"
    _.close()


def test_the_site_model_paints_occupancy_from_the_newest_rent_roll(client):
    model = site_models.load_model("greens-storage-austin")
    before = site_models.with_live(model)
    assert before["live"]["source"] == "file" and "08/31/2026" in before["live"]["system"]
    _upload(client, "cubesmart_rent_roll.csv", commit=True)
    after = site_models.with_live(model)
    live = after["live"]
    assert live["source"] == "file" and live["system"] == "CubeSmart rent roll, 09/30/2026" and live["asOf"] == "2026-09-30"
    leased = {u["n"] for u in after["units"] if u["l"]}
    assert "5052" in leased and "1000" in leased
    assert len(leased) <= 12                                  # everything else on the model is vacant now
    assert "9001" in {u["n"] for u in live["unplaced"]}      # on the roll, not on the model
    # the customer view still carries no occupancy
    pub = site_models.public_view(after)
    assert all("l" not in u for u in pub["units"])


# ── The nightly fetch stays off ──────────────────────────────────────────────

class SpySource(third_party_fetch.CubeSmartSource):
    def __init__(self, error=None):
        self.calls = 0
        self.error = error

    def fetch(self, prop, day):
        self.calls += 1
        if self.error:
            raise third_party_fetch.FetchError(self.error)
        return []


def _enable_austin():
    db = SessionLocal()
    third_party.ensure_seeded(db)
    db.query(ThirdPartyProperty).filter(ThirdPartyProperty.id == "cubesmart-6992").update({"fetch_enabled": True})
    db.commit()
    return db


def test_the_fetch_is_off_by_default_and_never_calls_out():
    assert third_party_fetch.enabled() is False
    spy = SpySource()
    db = _enable_austin()
    assert third_party_fetch.run_nightly(db, date(2026, 10, 20), {"cubesmart": spy}) == {"ran": False, "reason": "off"}
    assert spy.calls == 0
    # the switch alone is not enough: no credentials in the environment, no request
    os.environ[third_party_fetch.SWITCH] = "on"
    out = third_party_fetch.run_nightly(db, date(2026, 10, 20), {"cubesmart": spy})
    assert out["stores"] == {"cubesmart-6992": "not configured"} and spy.calls == 0
    # a store that is not switched on is never fetched, credentials or not
    os.environ["CUBESMART_USERNAME"], os.environ["CUBESMART_PASSWORD"] = FAKE_USER, FAKE_PASS
    db.query(ThirdPartyProperty).update({"fetch_enabled": False})
    db.commit()
    assert third_party_fetch.run_nightly(db, date(2026, 10, 20), {"cubesmart": spy})["stores"] == {}
    assert spy.calls == 0
    db.close()


def test_the_real_cubesmart_source_refuses_without_scraping():
    src = third_party_fetch.CubeSmartSource()
    assert src.configured() is False
    with pytest.raises(third_party_fetch.FetchNotConfigured):
        src.fetch(None, date(2026, 10, 20))
    os.environ["CUBESMART_USERNAME"], os.environ["CUBESMART_PASSWORD"] = FAKE_USER, FAKE_PASS
    with pytest.raises(third_party_fetch.FetchNotConfigured):   # no endpoint confirmed: still nothing is requested
        src.fetch(None, date(2026, 10, 20))


def test_no_credential_reaches_a_log_or_the_database(capsys, client):
    os.environ[third_party_fetch.SWITCH] = "on"
    os.environ["CUBESMART_USERNAME"], os.environ["CUBESMART_PASSWORD"] = FAKE_USER, FAKE_PASS
    spy = SpySource(error=f"login refused for {FAKE_USER} with {FAKE_PASS} at https://x/?p={FAKE_PASS}")
    db = _enable_austin()
    out = third_party_fetch.run_nightly(db, date(2026, 10, 20), {"cubesmart": spy})
    assert spy.calls == 1
    row = db.query(ThirdPartyImport).filter(ThirdPartyImport.via == "fetch").one()
    db.close()
    printed = capsys.readouterr().out
    for text in (row.error, printed, repr(out)):
        assert FAKE_PASS not in text and FAKE_USER not in text
    assert "***" in row.error and row.status == "failed"
    status = client.get("/third-party/fetch").json()
    assert status["enabled"] is True and status["sources"]["cubesmart"]["configured"] is True
    assert FAKE_PASS not in repr(status) and FAKE_USER not in repr(status)
    assert FAKE_PASS not in client.get("/third-party/imports").text
