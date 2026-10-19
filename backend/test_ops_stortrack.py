"""Operations -> Market Rates fed by StorTrack (ops_stortrack.py, cubby_warehouse.py):
mapping warehouse rows onto competitors and rates, dedupe on re-import, the
incremental window, no key = no-op, the market stats counting StorTrack rows,
and who may press Sync StorTrack Now.

BigQuery is never called: `cubby_warehouse._client` is replaced by a fake that
records the query and its parameters. Throwaway SQLite.

Run alone: python -m pytest test_ops_stortrack.py
"""
import atexit
import json
import os
import tempfile
from datetime import date, datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cubby_warehouse  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import ops_market  # noqa: E402
import ops_stortrack  # noqa: E402
from auth import get_current_user  # noqa: E402
from routers import facility_ops  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


FAC = "fac_temecula"
FAKE_KEY = json.dumps({"type": "service_account", "project_id": "greens-nexus-bq",
                       "private_key": "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
                       "client_email": "nexus@greens-nexus-bq.iam.gserviceaccount.com"})


class FakeBigQuery:
    """Stands in for google.cloud.bigquery.Client: answers every query with
    the rows inside the requested window and records what was asked."""

    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def query(self, sql, job_config=None):
        if isinstance(job_config, dict):
            params = dict(job_config)
        else:   # the real QueryJobConfig, when the package is installed
            params = {p.name: p.value for p in job_config.query_parameters}
        self.queries.append((sql, params))
        since, until = params["since"], params["until"]
        hits = [r for r in self.rows if since <= _as_date(r["date_collected"]) <= until]

        class _Job:
            def result(self, timeout=None):
                return [dict(r) for r in hits]
        return _Job()


def _as_date(v):
    return v if isinstance(v, date) else date.fromisoformat(v)


def _row(store="Extra Space Storage", address="100 Main Street", zip_code="92590", day="2026-10-10",
         size="10x10", width=10, length=10, regular=150.0, online=135.0, promo_price=None, promo="",
         climate=0, drive_up=1, elevator=0, space_type="Unit", facility=FAC):
    return {"facility_id": facility, "competitor_weight": "1", "store_name": store, "address": address,
            "city": "Temecula", "state": "CA", "zip": zip_code, "class_type": "A",
            "date_collected": date.fromisoformat(day), "space_type": space_type, "size": size,
            "width": width, "length": length, "climate_controlled": climate, "has_elevator": elevator,
            "drive_up": drive_up, "regular_price": regular, "online_price": online,
            "promo_price": promo_price, "promo": promo, "org_id": "org_greens"}


@pytest.fixture
def db():
    s = database.SessionLocal()
    s.query(models.OpsCompetitorRate).delete()
    s.query(models.OpsCompetitor).delete()
    s.query(models.NexusSetting).filter(models.NexusSetting.key == ops_stortrack.SETTING_KEY).delete()
    s.commit()
    yield s
    s.close()


@pytest.fixture
def warehouse(monkeypatch):
    """A configured warehouse whose client is the fake. Returns a setter for its rows."""
    monkeypatch.setenv("CUBBY_BQ_CREDENTIALS_JSON", FAKE_KEY)
    monkeypatch.delenv("CUBBY_BQ_PROJECT", raising=False)
    fake = FakeBigQuery([])
    monkeypatch.setattr(cubby_warehouse, "_client", lambda: fake)
    return fake


def _rates(db, **filters):
    q = db.query(models.OpsCompetitorRate)
    for k, v in filters.items():
        q = q.filter(getattr(models.OpsCompetitorRate, k) == v)
    return q.order_by(models.OpsCompetitorRate.observed_on).all()


# ── No key ───────────────────────────────────────────────────────────────────

def test_no_key_means_nothing_runs_and_the_tab_says_not_connected(db, monkeypatch):
    monkeypatch.delenv("CUBBY_BQ_CREDENTIALS_JSON", raising=False)

    def boom():
        raise AssertionError("BigQuery must not be touched without a key")
    monkeypatch.setattr(cubby_warehouse, "_client", boom)
    assert cubby_warehouse.configured() is False
    assert cubby_warehouse.stor_track_rows(date(2026, 10, 1), date(2026, 10, 2)) == []
    assert ops_stortrack.sync(db)["status"] == "not_connected"
    assert ops_stortrack.sync_if_due()["status"] == "not_connected"
    st = ops_stortrack.status(db)
    assert st["connected"] is False and st["lastSyncedAt"] == "" and st["hint"]
    assert db.query(models.OpsCompetitor).count() == 0
    assert db.get(models.NexusSetting, ops_stortrack.SETTING_KEY) is None


def test_a_bad_key_is_reported_without_echoing_it(monkeypatch):
    monkeypatch.setenv("CUBBY_BQ_CREDENTIALS_JSON", "{not json BEGIN PRIVATE KEY secret-bits")
    with pytest.raises(cubby_warehouse.WarehouseError) as e:
        cubby_warehouse.billing_project()
    assert "secret-bits" not in str(e.value) and "PRIVATE" not in str(e.value)


def test_the_billing_project_defaults_to_the_keys_own(monkeypatch):
    monkeypatch.setenv("CUBBY_BQ_CREDENTIALS_JSON", FAKE_KEY)
    monkeypatch.delenv("CUBBY_BQ_PROJECT", raising=False)
    assert cubby_warehouse.billing_project() == "greens-nexus-bq"
    monkeypatch.setenv("CUBBY_BQ_PROJECT", "greens-billing")
    assert cubby_warehouse.billing_project() == "greens-billing"


def test_the_query_names_only_the_columns_it_uses_and_takes_parameters():
    sql = cubby_warehouse.stor_track_sql()
    assert "SELECT *" not in sql and "`cubby-partner-data.analytics.stor_track`" in sql
    assert "@since" in sql and "@until" in sql and "regular_price" in sql and "org_id" not in sql


# ── Mapping ──────────────────────────────────────────────────────────────────

def test_rows_become_competitors_and_regular_price_rates(db, warehouse):
    warehouse.rows = [
        _row(),
        _row(size="10x20", width=None, length=None, regular=None, online=210.0),   # size from text, online as fallback
        _row(climate=1, drive_up=0, elevator=1, regular=175.0, online=160.0, promo_price=87.5, promo="50% off first month"),
        _row(store="Public Storage", address="9 Winchester Road", space_type="Parking", size="10x30",
             width=10, length=30, regular=120.0, online=None),
        _row(store="No Price Storage", regular=None, online=None),   # unusable
    ]
    out = ops_stortrack.sync(db, "manual", "ops.manager@greensglobal.com")
    assert out["status"] == "ok" and out["competitorsAdded"] == 2 and out["ratesWritten"] == 4

    comps = {c.name: c for c in db.query(models.OpsCompetitor).all()}
    assert set(comps) == {"Extra Space Storage", "Public Storage"}
    es = comps["Extra Space Storage"]
    assert es.facility_id == FAC and es.active and es.watch is False
    assert es.stortrack_key == "extra space storage|100 main st|92590"
    assert es.address == "100 Main Street, Temecula, CA 92590"

    rows = _rates(db, competitor_id=es.id)
    assert all(r.source == "stortrack" and r.observed_on == "2026-10-10" for r in rows)
    plain = next(r for r in rows if r.width == 10 and r.depth == 10 and r.climate is False)
    assert (plain.rate_cents, plain.online_cents, plain.promo_cents, plain.drive_up) == (15000, 13500, None, True)
    cc = next(r for r in rows if r.climate)
    assert (cc.rate_cents, cc.online_cents, cc.promo_cents, cc.promo, cc.elevator) == (17500, 16000, 8750, "50% off first month", True)
    big = next(r for r in rows if r.depth == 20)
    assert big.rate_cents == 21000 and big.online_cents == 21000   # no regular price: the online one stands in
    park = _rates(db, competitor_id=comps["Public Storage"].id)[0]
    assert park.parking is True and park.rate_cents == 12000

    st = ops_stortrack.status(db)
    assert st["connected"] and st["lastStatus"] == "ok" and st["lastSyncedAt"] and st["newestCollected"] == "2026-10-10"


def test_a_tracked_competitor_is_matched_by_name_and_street_and_a_removed_one_stays_removed(db, warehouse):
    db.add(models.OpsCompetitor(id="c-manual", facility_id=FAC, name="Extra Space Storage",
                                address="100 Main St., Temecula, CA", active=True, created_at="1"))
    db.add(models.OpsCompetitor(id="c-gone", facility_id=FAC, name="Public Storage",
                                address="9 Winchester Rd", active=False, created_at="1"))
    db.commit()
    warehouse.rows = [_row(), _row(store="Public Storage", address="9 Winchester Road")]
    out = ops_stortrack.sync(db)
    assert out["competitorsAdded"] == 0 and out["skippedRemoved"] == 1 and out["ratesWritten"] == 1
    assert db.get(models.OpsCompetitor, "c-manual").stortrack_key == "extra space storage|100 main st|92590"
    assert _rates(db, competitor_id="c-gone") == []
    assert db.get(models.OpsCompetitor, "c-gone").active is False


# ── Dedupe ───────────────────────────────────────────────────────────────────

def test_a_second_import_of_the_same_rows_writes_nothing(db, warehouse):
    warehouse.rows = [_row(), _row(climate=1, regular=175.0)]
    ops_stortrack.sync(db)
    first = len(_rates(db))
    db.query(models.NexusSetting).filter(models.NexusSetting.key == ops_stortrack.SETTING_KEY).delete()
    db.commit()   # forget the cursor: the same window is read again
    again = ops_stortrack.sync(db)
    assert again["ratesWritten"] == 0 and again["unchanged"] == 2 and len(_rates(db)) == first == 2
    assert db.query(models.OpsCompetitor).count() == 1


def test_one_row_per_competitor_size_type_and_day_a_correction_updates_it(db, warehouse):
    warehouse.rows = [_row(), _row()]           # the feed repeated itself
    assert ops_stortrack.sync(db)["ratesWritten"] == 1
    warehouse.rows = [_row(regular=155.0)]       # the feed corrected that day
    db.query(models.NexusSetting).delete()
    db.commit()
    out = ops_stortrack.sync(db)
    assert out["ratesUpdated"] == 1 and out["ratesWritten"] == 0
    assert [r.rate_cents for r in _rates(db)] == [15500]


def test_an_unchanged_price_is_written_again_only_weekly_and_a_change_at_once(db, warehouse):
    warehouse.rows = [_row(day=d) for d in ("2026-10-01", "2026-10-02", "2026-10-05", "2026-10-09")] \
        + [_row(day="2026-10-10", regular=165.0)]
    ops_stortrack.sync(db)
    assert [(r.observed_on, r.rate_cents) for r in _rates(db)] == [
        ("2026-10-01", 15000), ("2026-10-09", 15000), ("2026-10-10", 16500)]
    # Re-reading the whole window, late days included, adds nothing.
    db.query(models.NexusSetting).delete()
    db.commit()
    assert ops_stortrack.sync(db)["ratesWritten"] == 0


# ── Incremental window ───────────────────────────────────────────────────────

def test_the_first_run_reads_fresh_days_back_and_later_runs_from_the_newest_day_seen(db, warehouse):
    today = datetime.now(timezone.utc).date()
    seen = (today - timedelta(days=2)).isoformat()
    warehouse.rows = [_row(day=seen)]
    ops_stortrack.sync(db)
    _, first = warehouse.queries[-1]
    assert first["since"] == today - timedelta(days=ops_market.FRESH_DAYS)
    assert first["until"] == today + timedelta(days=1)

    ops_stortrack.sync(db)
    _, second = warehouse.queries[-1]
    assert second["since"] == date.fromisoformat(seen) - timedelta(days=ops_stortrack.OVERLAP_DAYS)


def test_the_schedule_acts_only_when_due(db, warehouse):
    assert ops_stortrack.sync_if_due()["status"] == "ok"
    assert ops_stortrack.sync_if_due()["status"] == "not_due"
    assert len(warehouse.queries) == 1


def test_a_warehouse_failure_is_recorded_not_raised(db, warehouse, monkeypatch):
    def broken():
        raise cubby_warehouse.WarehouseError("BigQuery did not answer (Forbidden)")
    monkeypatch.setattr(cubby_warehouse, "_client", broken)
    out = ops_stortrack.sync(db)
    assert out["status"] == "error" and "Forbidden" in out["detail"]
    st = ops_stortrack.status(db)
    assert st["lastStatus"] == "error" and not st["running"]


# ── The market counts StorTrack ──────────────────────────────────────────────

def _facility(name="10' x 10' Storage"):
    return {"id": FAC, "shortName": "Temecula", "asOf": "2026-10-13",
            "unitTypes": [{"name": name, "width": 10, "depth": 10, "parking": False, "total": 100,
                           "rented": 90, "vacant": 10, "street": 14000, "rentSum": 90 * 13000}]}


def test_the_low_median_high_and_suggestion_include_stortrack_rows(db, warehouse):
    db.add(models.OpsCompetitor(id="c-manual", facility_id=FAC, name="Corner Storage", active=True, created_at="1"))
    db.add(models.OpsCompetitorRate(id="r-manual", competitor_id="c-manual", facility_id=FAC, width=10, depth=10,
                                    rate_cents=12000, observed_on="2026-10-05", source="manual", created_at="1"))
    db.commit()
    warehouse.rows = [_row(store="Extra Space Storage", regular=150.0),
                      _row(store="Public Storage", address="9 Winchester Rd", regular=160.0)]
    ops_stortrack.sync(db)
    m = facility_ops._market(db, _facility())
    row = m["rows"][0]
    assert (row["competitors"], row["marketLow"], row["marketMedian"], row["marketHigh"]) == (3, 12000, 15000, 16000)
    assert row["suggested"] is not None and row["sources"] == ["manual", "stortrack"]
    assert m["stortrack"]["connected"] is True and m["stortrack"]["lastStatus"] == "ok"
    rates = next(c for c in m["competitors"] if c["name"] == "Extra Space Storage")["rates"]
    assert rates[0]["source"] == "stortrack" and rates[0]["online"] == 13500


def test_a_climate_unit_is_priced_against_the_climate_variant(db, warehouse):
    warehouse.rows = [_row(store=s, address=a, climate=0, regular=100.0) for s, a in (("A Storage", "1 A St"), ("B Storage", "2 B St"))] \
        + [_row(store=s, address=a, climate=1, regular=180.0) for s, a in (("A Storage", "1 A St"), ("B Storage", "2 B St"))]
    ops_stortrack.sync(db)
    cc = facility_ops._market(db, _facility("10x10 Climate Controlled"))["rows"][0]
    plain = facility_ops._market(db, _facility("10x10 Non-Climate"))["rows"][0]
    unsaid = facility_ops._market(db, _facility("10' x 10'"))["rows"][0]
    assert cc["marketMedian"] == 18000 and plain["marketMedian"] == 10000
    assert unsaid["marketMedian"] == 10000   # a name that does not say: the lower variant of the day


# ── Sync StorTrack Now ───────────────────────────────────────────────────────

def _client(level, role):
    app = FastAPI()
    app.include_router(facility_ops.router)
    app.dependency_overrides[get_current_user] = lambda: {"email": f"{role}@greensglobal.com", "role": role, "level": level}
    return TestClient(app)


def test_sync_now_is_for_managers_and_above(db, warehouse):
    warehouse.rows = [_row()]
    assert _client(2, "supervisor").post("/facility-ops/market/stortrack/sync").status_code == 401
    assert _client(1, "employee").post("/facility-ops/market/stortrack/sync").status_code == 401
    r = _client(3, "manager").post("/facility-ops/market/stortrack/sync")
    assert r.status_code == 200 and r.json()["result"]["ratesWritten"] == 1
    assert _client(4, "administrator").post("/facility-ops/market/stortrack/sync").status_code == 200


def test_sync_now_without_a_key_says_not_connected(db, monkeypatch):
    monkeypatch.delenv("CUBBY_BQ_CREDENTIALS_JSON", raising=False)
    r = _client(3, "manager").post("/facility-ops/market/stortrack/sync")
    assert r.status_code == 503 and r.json()["detail"] == "StorTrack not connected yet"


def test_sync_now_while_one_runs_is_a_409(db, warehouse):
    ops_stortrack._write_state(db, {"lastStatus": "running", "startedAt": datetime.now(timezone.utc).isoformat()})
    assert _client(3, "manager").post("/facility-ops/market/stortrack/sync").status_code == 409
