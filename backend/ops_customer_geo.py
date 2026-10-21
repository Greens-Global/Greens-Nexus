"""Operations > Customer Map (Neil, Oct 21 2026): where each storage
facility's current customers live, as rounded points around the facility.

Neil: "Need a map built of customers with their addresses plotted against the
location of the current storages. 1 mile radius line, 2 mile radius line, 3,
5, 10, 50 miles."

THE JOB (customer_geo_loop, main.py lifespan, deployed worker, in a thread):
every few hours, per Greens facility synced from Cubby, read the facility's
customers from Cubby (customers/search), keep the CURRENT ones, and for each
build the address in memory only:

    "<address>, <city>, <state> <zip>, <country>"

A SHA-256 fingerprint of the normalized address (salted with the customer id)
is compared with the stored row: unchanged -> skipped; new or changed ->
looked up at street level on Nominatim; a miss falls back to the ZIP
("<zip>, <state>, USA", precision `zip`); no ZIP and no street hit ->
`missing`. Misses and ZIP-only points are tried again after RETRY_DAYS.
Customers who are no longer current lose their row. Each pass does at most
BATCH lookups and the next one carries on (the stored fingerprints are the
bookmark), so the first ~3,300 addresses take an hour or two.

PRIVACY (Cubby sync rule, cubby_sync.strip_pii): what is stored is ONLY the
facility id, the Cubby customer id, the point rounded to 3 decimals (about
100 m), its precision, the fingerprint and when it was placed. The address is
never written to the database, a log line, an error or a payload; log lines
carry counts and exception TYPES only.

NOMINATIM: one request a second for the whole process, shared with the asset
map loop through nominatim_pace.wait_turn().

"Current customer" = a customer on a RENTED line of the facility's rent roll
(the synced cubby_units rows), the same tenants Operations counts - units
switched off in Unit Classes do not count. Someone renting at two facilities
is a customer of each, so they have a point for each.
"""
import asyncio
import hashlib
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

BATCH = 300                  # addresses looked at per pass (each 1-2 Nominatim calls)
RETRY_DAYS = 30              # a miss / ZIP-only point is tried again after this
EVERY_SEC = 4 * 3600         # a full pass every four hours
MORE_SEC = 15                # ...or soon again while there is a backlog
COMMIT_EVERY = 25
DECIMALS = 3                 # about 110 m of latitude
RINGS = (1, 2, 3, 5, 10, 50)
EARTH_MILES = 3958.8

STREET, ZIP, MISSING = "street", "zip", "missing"

_ZIP = re.compile(r"^\s*(\d{5})(?:-\d{4})?\s*$")
_US = {"", "us", "usa", "united states", "united states of america"}
_zip_cache: dict[str, Optional[tuple]] = {}      # "<zip>|<state>" -> point; a ZIP is not personal


# ── Addresses (in memory only) ────────────────────────────────────────────────

def _clean(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip(" ,")


def zip_of(contact: dict) -> str:
    m = _ZIP.match(str((contact or {}).get("zip") or ""))
    return m.group(1) if m else ""


def is_us(contact: dict) -> bool:
    return _clean((contact or {}).get("country")).lower().replace(".", "") in _US


def street_query(contact: dict) -> str:
    """'<address>, <city>, <state> <zip>, <country>', or '' without a street.
    address2 (a suite or apartment) is left out - it only confuses the lookup."""
    c = contact or {}
    street = _clean(c.get("address"))
    if not street:
        return ""
    tail = " ".join(x for x in (_clean(c.get("state")), _clean(c.get("zip"))) if x)
    country = _clean(c.get("country")) or "USA"
    return ", ".join(x for x in (street, _clean(c.get("city")), tail, country) if x)


def zip_query(contact: dict) -> str:
    z = zip_of(contact)
    if not z or not is_us(contact):
        return ""
    return ", ".join(x for x in (z, _clean((contact or {}).get("state")), "USA") if x)


def fingerprint(customer_id: str, contact: dict) -> str:
    """SHA-256 of the normalized address (street, city, state, zip, country),
    salted with the customer id. Same address -> same fingerprint."""
    c = contact or {}
    parts = [re.sub(r"[^a-z0-9]+", " ", str(c.get(k) or "").lower()).strip()
             for k in ("address", "city", "state", "zip", "country")]
    return hashlib.sha256(f"{customer_id}|{'|'.join(parts)}".encode()).hexdigest()


def rounded(point) -> tuple:
    return round(float(point[0]), DECIMALS), round(float(point[1]), DECIMALS)


def place(contact: dict, fetch: Callable[[str], Optional[tuple]]) -> tuple:
    """(lat, lng, precision) for one address. `fetch(query) -> (lat, lng) | None`
    may raise when the service is unhappy - the caller stops the pass."""
    q = street_query(contact)
    if q:
        hit = fetch(q)
        if hit:
            return (*rounded(hit), STREET)
    zq = zip_query(contact)
    if zq:
        if zq not in _zip_cache:
            _zip_cache[zq] = fetch(zq)
        hit = _zip_cache[zq]
        if hit:
            return (*rounded(hit), ZIP)
    return None, None, MISSING


def _paced_fetch(query: str) -> Optional[tuple]:
    import asset_geocode
    import nominatim_pace
    nominatim_pace.wait_turn()           # one a second, shared with the asset map loop
    return asset_geocode._nominatim_search(query)


# ── Current customers (from the synced Cubby tables) ──────────────────────────

def current_customers(db) -> dict[str, set]:
    """{facility_id: {customer_id}} - customers on a RENTED rent-roll line of
    an enabled facility; Unit Classes' switched-off records do not count."""
    import cubby
    import models as m
    import ops_unit_classes as uc
    rules = cubby._rules()
    fids = [f.facility_id for f in db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True)).all()]
    out: dict[str, set] = {fid: set() for fid in fids}
    if not fids:
        return out
    for u in (db.query(m.CubbyUnit)
              .filter(m.CubbyUnit.facility_id.in_(fids), m.CubbyUnit.status == "RENTED", m.CubbyUnit.customer_id != "")
              .all()):
        group = ((u.data or {}).get("rentRoll") or {}).get("pricingGroupName")
        if uc.unit_class(group, rules) == uc.EXCLUDED:
            continue
        out[u.facility_id].add(u.customer_id)
    return out


def _read_customers(facility_id: str) -> list[dict]:
    import cubby
    return cubby._post("customers/search", {"facilityId": facility_id}).get("customers", [])


def _due(row, fp: str, now: datetime) -> bool:
    if row is None or row.fingerprint != fp:
        return True
    if row.precision == STREET:
        return False
    try:
        at = datetime.fromisoformat(str(row.geocoded_at or "").replace("Z", "+00:00"))
    except ValueError:
        return True
    return now - at > timedelta(days=RETRY_DAYS)


def geocode_pass(db, read_customers=None, fetch=None, limit: int = BATCH) -> dict:
    """One pass. Blocking. {"looked": n, "placed": n, "dropped": n, "more": bool}.
    `read_customers(facility_id)` and `fetch(query)` are injectable for tests."""
    import models as m
    P = m.OpsCustomerPoint
    read_customers = read_customers or _read_customers
    fetch = fetch or _paced_fetch
    now = datetime.now(timezone.utc)
    current = current_customers(db)

    # Customers who are no longer current (or whose facility left Cubby) lose their row.
    dropped = 0
    for row in db.query(P).all():
        if row.customer_id not in current.get(row.facility_id, ()):
            db.delete(row)
            dropped += 1
    db.commit()

    looked = placed = since_commit = 0
    more = False
    stop = False
    for fid in sorted(current):
        if stop:
            break
        wanted = current[fid]
        if not wanted:
            continue
        stored = {r.customer_id: r for r in db.query(P).filter(P.facility_id == fid).all()}
        try:
            customers = read_customers(fid)
        except Exception as e:  # noqa: BLE001 - one facility's Cubby read must not stop the pass
            print(f"[customer-map] {fid}: customers not read ({type(e).__name__})")
            more = True
            continue
        contacts = {}
        for c in customers:
            cid = str(c.get("customerId") or "")
            if cid in wanted and cid not in contacts:
                contacts[cid] = c.get("contact") or {}
        del customers
        for cid in sorted(wanted):
            contact = contacts.get(cid) or {}
            fp = fingerprint(cid, contact)
            row = stored.get(cid)
            if not _due(row, fp, now):
                continue
            if looked >= limit:
                more = True
                stop = True
                break
            if not street_query(contact) and not zip_query(contact):
                lat, lng, precision = None, None, MISSING        # nothing to look up
            else:
                try:
                    lat, lng, precision = place(contact, fetch)
                except Exception as e:  # noqa: BLE001 - the service is unhappy; carry on next pass
                    print(f"[customer-map] lookup stopped ({type(e).__name__})")
                    more = stop = True
                    break
                looked += 1
            if row is None:
                row = P(id=f"{fid}:{cid}", facility_id=fid, customer_id=cid)
                db.add(row)
                stored[cid] = row
            row.lat, row.lng, row.precision = lat, lng, precision
            row.fingerprint, row.geocoded_at = fp, now.isoformat()
            placed += lat is not None
            since_commit += 1
            if since_commit >= COMMIT_EVERY:
                db.commit()
                since_commit = 0
        contacts.clear()
    db.commit()
    return {"looked": looked, "placed": placed, "dropped": dropped, "more": more}


def run_pass() -> dict:
    from database import SessionLocal
    db = SessionLocal()
    try:
        return geocode_pass(db)
    finally:
        db.close()


async def customer_geo_loop():
    import cubby
    from leader import is_background_leader
    await asyncio.sleep(120)                        # let startup and the first Cubby sync settle
    while True:
        if not is_background_leader() or not cubby.configured():
            await asyncio.sleep(300)
            continue
        wait = EVERY_SEC
        try:
            res = await asyncio.to_thread(run_pass)
            if res["looked"] or res["dropped"]:
                print(f"[customer-map] looked up {res['looked']}, placed {res['placed']}, dropped {res['dropped']}")
            if res["more"]:
                wait = MORE_SEC
        except Exception as e:  # noqa: BLE001
            print(f"[customer-map] loop error: {type(e).__name__}")
            wait = 600
        await asyncio.sleep(wait)


# ── The map (read side, for routers/ops_customer_map.py) ──────────────────────

def miles_between(a_lat, a_lng, b_lat, b_lng) -> float:
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_MILES * math.asin(min(1.0, math.sqrt(h)))


def ring_counts(distances: list) -> dict:
    """{"rings": [{"miles", "count"}] (within, cumulative), "beyond": n, "placed": n}."""
    return {"rings": [{"miles": r, "count": sum(1 for d in distances if d <= r)} for r in RINGS],
            "beyond": sum(1 for d in distances if d > RINGS[-1]), "placed": len(distances)}


def build_map(db, facility: str = "all", state: str = "") -> Optional[dict]:
    """What the screen draws. None when `facility` is not a Greens facility."""
    import cubby
    import models as m
    from ops_portfolio import _state as state_of
    facs = []
    for f in db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True)).all():
        d = {**(f.data or {}), "facilityId": f.facility_id, "name": f.name or (f.data or {}).get("name") or ""}
        facs.append({"id": f.facility_id, "name": d["name"], "shortName": cubby._short(d),
                     "lat": cubby._coord(d.get("latitude"), 90), "lng": cubby._coord(d.get("longitude"), 180),
                     "state": state_of(d)})
    facs.sort(key=lambda f: f["shortName"])
    if state:
        facs = [f for f in facs if f["state"] == state.upper()]
    if facility and facility != "all":
        facs = [f for f in facs if f["id"] == facility]
        if not facs:
            return None
    ids = {f["id"] for f in facs}
    current = {fid: c for fid, c in current_customers(db).items() if fid in ids}
    by_id = {f["id"]: f for f in facs}

    P = m.OpsCustomerPoint
    groups: dict[tuple, int] = {}
    coverage = {fid: {"current": len(current.get(fid, ())), "placed": 0, "zipOnly": 0, "missing": 0, "pending": 0}
                for fid in ids}
    seen = {fid: 0 for fid in ids}
    distances = []
    for r in db.query(P).filter(P.facility_id.in_(ids)).all() if ids else []:
        if r.customer_id not in current.get(r.facility_id, ()):
            continue                                # left since the last pass
        cov = coverage[r.facility_id]
        seen[r.facility_id] += 1
        if r.lat is None or r.lng is None:
            cov["missing"] += 1
            continue
        cov["placed"] += 1
        cov["zipOnly"] += r.precision == ZIP
        key = (r.facility_id, r.lat, r.lng, r.precision)
        groups[key] = groups.get(key, 0) + 1
        f = by_id[r.facility_id]
        if f["lat"] is not None and f["lng"] is not None:
            distances.append(miles_between(f["lat"], f["lng"], r.lat, r.lng))
    for fid, cov in coverage.items():
        cov["pending"] = max(0, cov["current"] - seen[fid])
    total = {k: sum(c[k] for c in coverage.values()) for k in ("current", "placed", "zipOnly", "missing", "pending")}
    return {
        "facilities": facs,
        "points": [{"lat": lat, "lng": lng, "facilityId": fid, "count": n, "precision": prec}
                   for (fid, lat, lng, prec), n in sorted(groups.items(), key=lambda kv: kv[0][:3])],
        "coverage": coverage,
        "total": total,
        **ring_counts(distances),
    }
