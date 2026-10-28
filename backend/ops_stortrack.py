"""Operations -> Market Rates, fed by StorTrack (Oct 2026).

StorTrack is a competitor rate feed that Cubby includes in our plan. Cubby
lands it in its BigQuery warehouse (`cubby-partner-data.analytics.stor_track`,
read through `cubby_warehouse.py`): per row, one of OUR Cubby facilities, one
competitor store near it, one unit size and type, the day it was collected,
and the store's regular / online / promotional price.

The import writes into the tables Market Rates already uses, so the low /
median / high and the suggested rate count StorTrack like any other source:

  ops_competitors        one per (our facility, store name + street + zip),
                         matched by `stortrack_key`, else by name and street
                         against a competitor staff already track; created
                         when missing. A competitor a manager removed stays
                         removed - its StorTrack rows are passed over.
  ops_competitor_rates   source "stortrack", observed_on = date_collected.
                         rate_cents = the REGULAR price (the standard rate,
                         which is what the website reader and staff record
                         too); online and promo prices ride along. One row per
                         (competitor, size and unit variant, date) - a second
                         import of the same day updates it in place. Like the
                         website reader, an unchanged price is written again
                         only once a week, so the history shows every move
                         without a row per store per size per day.

Incremental: each run reads from a few days before the newest date it has
already seen (late rows land), the first run from FRESH_DAYS back. The cursor
and the last outcome live in `nexus_settings` (key "stortrack_sync") so every
worker and every restart agrees.

No key (CUBBY_BQ_CREDENTIALS_JSON) = nothing runs and the screen says
"StorTrack not connected yet". Everything here blocks; call it in a thread.
"""
import bisect
import json
import os
import re
import threading
import uuid
from datetime import date, datetime, timedelta, timezone

import cubby_warehouse
from ops_market import FRESH_DAYS, size_key
import job_switch

SETTING_KEY = "stortrack_sync"
SOURCE = "stortrack"
ENTERED_BY = "stortrack"
OVERLAP_DAYS = 3          # re-read this many days before the newest one seen (late rows)
RECONFIRM_DAYS = 7        # an unchanged price gets a new row this often
RUNNING_STALE_MIN = 20    # a "running" mark older than this is a run that died
NOT_CONNECTED = "StorTrack not connected yet"

_lock = threading.Lock()


def every_hours() -> int:
    """How often the scheduled import runs (NEXUS_STORTRACK_HOURS, 2 to 24)."""
    try:
        return min(24, max(2, int(os.getenv("NEXUS_STORTRACK_HOURS", "6"))))
    except ValueError:
        return 6


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Normalizing one row ──────────────────────────────────────────────────────

def _norm(s) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower()).split())


_STREET = {"street": "st", "avenue": "ave", "road": "rd", "boulevard": "blvd", "drive": "dr", "highway": "hwy",
           "lane": "ln", "parkway": "pkwy", "court": "ct", "place": "pl", "north": "n", "south": "s",
           "east": "e", "west": "w", "suite": "ste"}


def _street(s) -> str:
    return " ".join(_STREET.get(w, w) for w in _norm(s).split())


def _zip5(z) -> str:
    m = re.search(r"\d{5}", str(z or ""))
    return m.group(0) if m else ""


def store_key(name, address, zip_code) -> str:
    return f"{_norm(name)}|{_street(address)}|{_zip5(zip_code)}"


def _flag(v):
    """StorTrack's 0/1 columns -> True / False, None when empty."""
    if v is None or v == "":
        return None
    try:
        return bool(int(float(v)))
    except (TypeError, ValueError):
        return str(v).strip().lower() in ("true", "yes", "y")


def _cents(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(round(f * 100)) if 0 < f < 100000 else None


def _dims(row):
    try:
        w, d = float(row.get("width") or 0), float(row.get("length") or 0)
    except (TypeError, ValueError):
        w = d = 0
    if w > 0 and d > 0:
        return w, d
    m = re.search(r"(\d+(?:\.\d+)?)\s*'?\s*[x×*]\s*(\d+(?:\.\d+)?)", str(row.get("size") or ""), re.I)
    return (float(m.group(1)), float(m.group(2))) if m else (0, 0)


_PARKING = re.compile(r"parking|vehicle|\brv\b|boat|auto|car\b", re.I)


def _day(v) -> str:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "")[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return ""


def normalize(row: dict):
    """One warehouse row -> what the import needs, or None when it cannot be
    used (no facility, no store, no size, no price)."""
    fid = str(row.get("facility_id") or "").strip()
    name = " ".join(str(row.get("store_name") or "").split())
    day = _day(row.get("date_collected"))
    w, d = _dims(row)
    regular, online, promo = _cents(row.get("regular_price")), _cents(row.get("online_price")), _cents(row.get("promo_price"))
    rate = regular or online       # the standard rate; online only when the regular one is missing
    if not (fid and name and day and w and d and rate):
        return None
    space = " ".join(str(row.get("space_type") or "").split())[:60]
    return {
        "facility_id": fid, "name": name[:120],
        "address": " ".join(str(row.get("address") or "").split()),
        "city": " ".join(str(row.get("city") or "").split()), "state": str(row.get("state") or "").strip(),
        "zip": _zip5(row.get("zip")), "class_type": str(row.get("class_type") or "").strip(),
        "key": store_key(name, row.get("address"), row.get("zip")),
        "day": day, "width": w, "depth": d, "parking": bool(_PARKING.search(space)),
        "space_type": space, "climate": _flag(row.get("climate_controlled")),
        "drive_up": _flag(row.get("drive_up")), "elevator": _flag(row.get("has_elevator")),
        "rate_cents": rate, "online_cents": online, "promo_cents": promo,
        "promo": " ".join(str(row.get("promo") or "").split())[:200],
    }


def variant(r) -> tuple:
    """Size and unit type: what one price is a price OF."""
    get = r.get if isinstance(r, dict) else (lambda k: getattr(r, k))
    return (size_key(get("width"), get("depth"), bool(get("parking"))), get("climate"), get("drive_up"),
            get("elevator"), (get("space_type") or "").lower())


def _prices(r) -> tuple:
    get = r.get if isinstance(r, dict) else (lambda k: getattr(r, k))
    return (get("rate_cents"), get("online_cents"), get("promo_cents"), get("promo") or "")


# ── The import ───────────────────────────────────────────────────────────────

def _full_address(n: dict) -> str:
    tail = " ".join(x for x in (n["state"], n["zip"]) if x)
    return ", ".join(x for x in (n["address"], n["city"], tail) if x)[:240]


def _match(n: dict, comps: list):
    for c in comps:
        if (c.stortrack_key or "") == n["key"]:
            return c
    street = _street(n["address"])
    for c in comps:
        if c.stortrack_key or _norm(c.name) != _norm(n["name"]):
            continue
        theirs = _street(c.address)
        if street and theirs and (theirs.startswith(street) or street.startswith(theirs)):
            return c
    return None


def import_rows(db, rows: list[dict], now: datetime = None) -> dict:
    """Write warehouse rows into ops_competitors / ops_competitor_rates and
    commit. Safe to run again over the same rows."""
    import models
    now_s = (now or _now()).isoformat()
    usable = sorted(filter(None, (normalize(r) for r in rows)), key=lambda n: n["day"])
    counts = {"rowsRead": len(rows), "rowsUsable": len(usable), "competitorsAdded": 0,
              "ratesWritten": 0, "ratesUpdated": 0, "unchanged": 0, "skippedRemoved": 0}
    if not usable:
        return counts

    by_fac: dict[str, list] = {}
    for n in usable:
        by_fac.setdefault(n["facility_id"], []).append(n)

    for fid, items in by_fac.items():
        comps = db.query(models.OpsCompetitor).filter(models.OpsCompetitor.facility_id == fid).all()
        # An active competitor is matched before a removed one of the same store.
        comps.sort(key=lambda c: (not c.active, c.created_at or ""))
        ids = [c.id for c in comps]
        series: dict[tuple, list] = {}     # (competitor, variant) -> rows sorted by day
        if ids:
            for r in (db.query(models.OpsCompetitorRate)
                      .filter(models.OpsCompetitorRate.competitor_id.in_(ids), models.OpsCompetitorRate.source == SOURCE)
                      .all()):
                series.setdefault((r.competitor_id, variant(r)), []).append(r)
        for lst in series.values():
            lst.sort(key=lambda r: r.observed_on or "")

        for n in items:
            c = _match(n, comps)
            if c is None:
                c = models.OpsCompetitor(
                    id=str(uuid.uuid4()), facility_id=fid, name=n["name"], address=_full_address(n),
                    distance_miles=0, website="", rates_url="", watch=False, active=True,
                    notes=f"Added from StorTrack{' (Class ' + n['class_type'] + ')' if n['class_type'] else ''}.",
                    stortrack_key=n["key"], created_by=ENTERED_BY, created_at=now_s)
                db.add(c)
                comps.append(c)
                counts["competitorsAdded"] += 1
            elif not c.stortrack_key:
                c.stortrack_key = n["key"]
            if not c.active:
                counts["skippedRemoved"] += 1
                continue
            lst = series.setdefault((c.id, variant(n)), [])
            days = [r.observed_on or "" for r in lst]
            i = bisect.bisect_right(days, n["day"])
            prev = lst[i - 1] if i else None
            if prev is not None and prev.observed_on == n["day"]:
                if _prices(prev) != _prices(n):     # the feed corrected that day
                    prev.rate_cents, prev.online_cents, prev.promo_cents, prev.promo = _prices(n)
                    counts["ratesUpdated"] += 1
                else:
                    counts["unchanged"] += 1
                continue
            stale = (date.fromisoformat(n["day"]) - timedelta(days=RECONFIRM_DAYS)).isoformat()
            if prev is not None and _prices(prev) == _prices(n) and (prev.observed_on or "") >= stale:
                counts["unchanged"] += 1     # the same price, seen again this week
                continue
            row = models.OpsCompetitorRate(
                id=str(uuid.uuid4()), competitor_id=c.id, facility_id=fid, width=n["width"], depth=n["depth"],
                parking=n["parking"], rate_cents=n["rate_cents"], online_cents=n["online_cents"],
                promo_cents=n["promo_cents"], promo=n["promo"], climate=n["climate"], drive_up=n["drive_up"],
                elevator=n["elevator"], space_type=n["space_type"], observed_on=n["day"], source=SOURCE,
                entered_by=ENTERED_BY, created_at=now_s)
            db.add(row)
            lst.insert(i, row)
            counts["ratesWritten"] += 1
    db.commit()
    return counts


# ── Sync state ───────────────────────────────────────────────────────────────

def _read_state(db) -> dict:
    import models
    row = db.get(models.NexusSetting, SETTING_KEY)
    try:
        return json.loads(row.value) if row and row.value else {}
    except ValueError:
        return {}


def _write_state(db, state: dict, by: str = "") -> None:
    import models
    row = db.get(models.NexusSetting, SETTING_KEY)
    if row is None:
        row = models.NexusSetting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps(state)
    row.updated_by = by or ENTERED_BY
    row.updated_at = _now().isoformat()
    db.commit()


def status(db) -> dict:
    """What the Market Rates tab shows. Never raises."""
    try:
        s = _read_state(db)
    except Exception:  # noqa: BLE001 - a status line must not break the tab
        db.rollback()
        s = {}
    connected = cubby_warehouse.configured()
    return {"connected": connected, "everyHours": every_hours(),
            "running": _running(s), "lastSyncedAt": s.get("lastSyncedAt", ""),
            "lastStatus": s.get("lastStatus", ""), "lastDetail": s.get("lastDetail", ""),
            "newestCollected": s.get("lastCollected", ""),
            "hint": "" if connected else "Rates from the StorTrack feed start appearing here once the Cubby warehouse key is set on this server."}


def _running(s: dict) -> bool:
    if s.get("lastStatus") != "running":
        return False
    try:
        return _now() - datetime.fromisoformat(s.get("startedAt", "")) < timedelta(minutes=RUNNING_STALE_MIN)
    except ValueError:
        return False


def window(state: dict, today: date) -> tuple[date, date]:
    """(since, until) for the next read: a few days before the newest date
    already seen, else FRESH_DAYS back; through tomorrow (time zones)."""
    try:
        since = date.fromisoformat(state.get("lastCollected", "")) - timedelta(days=OVERLAP_DAYS)
    except ValueError:
        since = today - timedelta(days=FRESH_DAYS)
    return max(since, today - timedelta(days=FRESH_DAYS)), today + timedelta(days=1)


def sync(db, trigger: str = "schedule", by: str = "") -> dict:
    """One incremental import. Returns {"status": ...}; "busy" when another
    run holds the lock (this worker) or the running mark (any worker)."""
    if not cubby_warehouse.configured():
        return {"status": "not_connected", "detail": NOT_CONNECTED}
    if not _lock.acquire(blocking=False):
        return {"status": "busy"}
    try:
        state = _read_state(db)
        if _running(state):
            return {"status": "busy"}
        started = _now()
        _write_state(db, {**state, "lastStatus": "running", "startedAt": started.isoformat(), "trigger": trigger}, by)
        since, until = window(state, started.date())
        try:
            rows = cubby_warehouse.stor_track_rows(since, until)
            counts = import_rows(db, rows, started)
        except Exception as e:  # noqa: BLE001 - recorded on the state row, never raised to the loop
            db.rollback()
            detail = str(e) if isinstance(e, cubby_warehouse.WarehouseError) else f"The import failed ({type(e).__name__})"
            print(f"[stortrack] sync failed: {detail}")
            _write_state(db, {**state, "lastStatus": "error", "lastDetail": detail[:300],
                              "lastAttemptAt": _now().isoformat(), "trigger": trigger}, by)
            return {"status": "error", "detail": detail}
        newest = max((_day(r.get("date_collected")) for r in rows), default="")
        detail = (f"Read {counts['rowsRead']} rows; {counts['ratesWritten']} new rates, "
                  f"{counts['competitorsAdded']} competitors added")
        _write_state(db, {"lastStatus": "ok", "lastDetail": detail, "lastSyncedAt": _now().isoformat(),
                          "lastAttemptAt": _now().isoformat(), "trigger": trigger,
                          "lastCollected": max(newest, state.get("lastCollected", "")),
                          "since": since.isoformat(), **counts}, by)
        print(f"[stortrack] {trigger}: {detail}")
        return {"status": "ok", "detail": detail, **counts}
    finally:
        _lock.release()


def due(db) -> bool:
    """Has the scheduled interval passed since the last attempt?"""
    s = _read_state(db)
    last = s.get("lastAttemptAt") or s.get("lastSyncedAt") or ""
    try:
        return _now() - datetime.fromisoformat(last) >= timedelta(hours=every_hours())
    except ValueError:
        return True


def sync_if_due() -> dict:
    """The scheduled run, hung off the Cubby sync loop (every 15 minutes) and
    acting only every `every_hours()`. Blocking - call it in a thread."""
    if job_switch.off("stortrack_sync"):   # Workflows > Automations switch
        return {"status": "off"}
    if not cubby_warehouse.configured():
        return {"status": "not_connected"}
    from database import SessionLocal
    db = SessionLocal()
    try:
        if not due(db):
            return {"status": "not_due"}
        return sync(db, "schedule")
    finally:
        db.close()
