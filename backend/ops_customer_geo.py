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
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional
import job_switch

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

def _rented_lines(db, fids=None):
    """(facility_id, customer_id, rentRoll dict) for every RENTED rent-roll line
    of an enabled facility (or of `fids`); Unit Classes' switched-off records
    are left out. The one walk both the geocode job and the map read."""
    import cubby
    import models as m
    import ops_unit_classes as uc
    rules = cubby._rules()
    if fids is None:
        fids = [f.facility_id for f in db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True)).all()]
    fids = list(fids)
    if not fids:
        return
    for u in (db.query(m.CubbyUnit)
              .filter(m.CubbyUnit.facility_id.in_(fids), m.CubbyUnit.status == "RENTED", m.CubbyUnit.customer_id != "")
              .all()):
        rr = (u.data or {}).get("rentRoll") or {}
        if uc.unit_class(rr.get("pricingGroupName"), rules) == uc.EXCLUDED:
            continue
        yield u.facility_id, u.customer_id, rr


def current_customers(db) -> dict[str, set]:
    """{facility_id: {customer_id}} - customers on a RENTED rent-roll line of
    an enabled facility; Unit Classes' switched-off records do not count."""
    import models as m
    fids = [f.facility_id for f in db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True)).all()]
    out: dict[str, set] = {fid: set() for fid in fids}
    for fid, cid, _rr in _rented_lines(db, fids):
        out[fid].add(cid)
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
    if job_switch.off("customer_geo"):   # Workflows > Automations switch
        return {"looked": 0, "placed": 0, "dropped": 0, "more": False}
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
#
# Trade area analysis (Visesh, Oct 22 2026, Phase 1): the payload is the
# customers AGGREGATED by (facility, rounded point, precision, unit kind,
# tenure bucket, rent band) with a count and a rent sum - never a customer id,
# name or address. Distances, percentiles, the distance distribution, the
# Outside 50 Miles card, competitor counts and the overlap between Greens
# stores are computed here, on the filtered set, so the map and the numbers
# beside it always agree (the screen only sums groups for a hover).

KINDS = ("storage", "vehicle")
TENURES = ("under90d", "under1y", "1to3y", "over3y", "unknown")
TENURE_DAYS = (90, 365, 3 * 365)
BUCKETS = ((0, 1), (1, 2), (2, 3), (3, 5), (5, 10), (10, 50), (50, None))
PERCENTILES = (50, 80, 90)
COMPETITOR_RINGS = (3, 5, 10)
COMPETITOR_REACH = 50        # competitors drawn within this many miles of a shown facility
MIN_RENT_GROUP = 3                          # smallest group whose rent sum is sent
POINT_COLS = ("lat", "lng", "facility", "zip", "kind", "tenure", "band", "count", "rent", "miles", "closer")


def miles_between(a_lat, a_lng, b_lat, b_lng) -> float:
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_MILES * math.asin(min(1.0, math.sqrt(h)))


def kind_of(groups: list) -> str:
    """A customer renting only parking spaces (pricing group name contains
    "Parking" - ops_budget_cubby.segment_of's rule) is a vehicle / RV
    customer; anyone with a storage unit (or a mailbox) is storage."""
    names = [str(g or "").lower() for g in groups]
    return "vehicle" if names and all("parking" in n for n in names) else "storage"


def tenure_of(move_in: str, today: date) -> str:
    try:
        d = date.fromisoformat(str(move_in or "")[:10])
    except ValueError:
        return "unknown"
    days = (today - d).days
    for key, limit in zip(TENURES, TENURE_DAYS):
        if days < limit:
            return key
    return "over3y"


def percentile(sorted_values: list, p: float) -> Optional[float]:
    """Nearest-rank percentile of an ascending list: the smallest value with at
    least p% of the values at or below it. None for an empty list."""
    if not sorted_values:
        return None
    k = max(0, math.ceil(p / 100 * len(sorted_values)) - 1)
    return sorted_values[min(k, len(sorted_values) - 1)]


def median(sorted_values: list) -> Optional[float]:
    n = len(sorted_values)
    if not n:
        return None
    mid = n // 2
    return sorted_values[mid] if n % 2 else (sorted_values[mid - 1] + sorted_values[mid]) / 2


def _r2(v):
    return None if v is None else round(v, 2)


def ring_counts(distances: list) -> dict:
    """{"rings": [{"miles", "count"}] (within, cumulative), "beyond": n, "placed": n}."""
    return {"rings": [{"miles": r, "count": sum(1 for d in distances if d <= r)} for r in RINGS],
            "beyond": sum(1 for d in distances if d > RINGS[-1]), "placed": len(distances)}


def trade_stats(distances: list) -> dict:
    """The Trade Area Statistics for one set of customer distances (miles):
    50 / 80 / 90% radii, median and average, the distance distribution
    (each bucket includes its upper edge, like the rings: 0-1 holds exactly
    1 mile) and the ring counts."""
    d = sorted(distances)
    buckets = []
    for lo, hi in BUCKETS:
        c = sum(1 for x in d if (x > lo or lo == 0) and (hi is None or x <= hi))
        buckets.append({"min": lo, "max": hi, "count": c})
    return {
        "radii": {str(p): _r2(percentile(d, p)) for p in PERCENTILES},
        "median": _r2(median(d)),
        # Average over customers within the outer ring: a few far-away
        # addresses (moved, billing) dragged it to ~80 mi (Oct 22).
        "mean": _r2(sum(x for x in d if x <= RINGS[-1]) / n50) if (n50 := sum(1 for x in d if x <= RINGS[-1])) else None,
        "meanAll": _r2(sum(d) / len(d)) if d else None,
        "buckets": buckets,
        **ring_counts(d),
    }


def rent_bands(rents: list) -> list:
    """Quartile bands of monthly rent (dollars): [{"band", "min", "max"}];
    band 0 is up to the 25th percentile, band 3 above the 75th."""
    r = sorted(rents)
    if not r:
        return []
    cuts = [percentile(r, p) for p in (25, 50, 75)]
    edges = [r[0], *cuts, r[-1]]
    out = []
    for i in range(4):
        inside = [x for x in r if edges[i] <= x <= edges[i + 1]] if i else [x for x in r if x <= edges[1]]
        # The band's median stands in for a group too small to carry its own
        # rent (privacy, Oct 22) - shared by a quarter of all customers.
        out.append({"band": i, "min": round(edges[i], 2), "max": round(edges[i + 1], 2),
                    "median": round(median(inside), 2) if inside else None})
    return out


def band_of(rent: float, bands: list) -> int:
    for b in bands[:3]:
        if rent <= b["max"]:
            return b["band"]
    return 3 if bands else 0


def _profiles(db, fids: list, today: date) -> dict:
    """{(facility_id, customer_id): {"kind", "tenure", "rent"}} from the synced
    rent roll: every rented line the customer has at that facility (rent is
    their total monthly rent in dollars, tenure counts from their earliest
    move-in there)."""
    lines: dict[tuple, dict] = {}
    for fid, cid, rr in _rented_lines(db, fids):
        p = lines.setdefault((fid, cid), {"groups": [], "rent": 0.0, "moveIn": ""})
        p["groups"].append(rr.get("pricingGroupName"))
        try:
            p["rent"] += float(rr.get("monthlyRentalAmount") or 0)
        except (TypeError, ValueError):
            pass
        mi = str(rr.get("moveInDate") or "")[:10]
        if mi and (not p["moveIn"] or mi < p["moveIn"]):
            p["moveIn"] = mi
    return {k: {"kind": kind_of(p["groups"]), "tenure": tenure_of(p["moveIn"], today), "rent": p["rent"] / 100}
            for k, p in lines.items()}


def _competitors(db, shown: list) -> list:
    """Active, open comp-set competitors with a map position, once each (the
    same store can be on two facilities' lists), within COMPETITOR_REACH of a
    shown facility: [{"name", "lat", "lng", "miles", "near": {facility_id: miles}}]."""
    import models as m
    if not shown:
        return []
    seen, out = set(), []
    rows = (db.query(m.OpsCompetitor)
            .filter(m.OpsCompetitor.active.is_(True), m.OpsCompetitor.lat.isnot(None), m.OpsCompetitor.lng.isnot(None))
            .all())
    for c in rows:
        if c.closed:
            continue
        key = c.stortrack_key or f"{(c.name or '').strip().lower()}|{round(c.lat, 3)}|{round(c.lng, 3)}"
        if key in seen:
            continue
        seen.add(key)
        near = {f["id"]: miles_between(f["lat"], f["lng"], c.lat, c.lng) for f in shown}
        if min(near.values()) > COMPETITOR_REACH:
            continue
        out.append({"name": c.name or "Competitor", "lat": round(c.lat, 4), "lng": round(c.lng, 4),
                    "miles": _r2(min(near.values())), "near": near})
    out.sort(key=lambda c: (c["miles"], c["name"]))
    return out


def _within(competitors: list, fid: Optional[str] = None) -> dict:
    """{"3": n, "5": n, "10": n} - competitors within each distance of one
    facility, or of the nearest shown facility when `fid` is None."""
    def dist(c):
        return c["near"].get(fid) if fid else min(c["near"].values())
    return {str(r): sum(1 for c in competitors if dist(c) is not None and dist(c) <= r) for r in COMPETITOR_RINGS}


def build_map(db, facility: str = "all", state: str = "", kind: str = "all", since: str = "all",
              band: str = "all", today: Optional[date] = None) -> Optional[dict]:
    """What the screen draws. None when `facility` is not a Greens facility.
    kind: all | storage | vehicle; since: all | 90 | 365 (moved in within that
    many days); band: all | 0-3 (rent quartile of the customers on the map,
    before the filters, so a band means the same thing whatever else is on)."""
    import cubby
    import models as m
    from ops_portfolio import _state as state_of
    today = today or datetime.now(timezone.utc).date()
    greens = []
    for f in db.query(m.CubbyFacility).filter(m.CubbyFacility.enabled.is_(True)).all():
        d = {**(f.data or {}), "facilityId": f.facility_id, "name": f.name or (f.data or {}).get("name") or ""}
        greens.append({"id": f.facility_id, "name": d["name"], "shortName": cubby._short(d),
                       "lat": cubby._coord(d.get("latitude"), 90), "lng": cubby._coord(d.get("longitude"), 180),
                       "state": state_of(d)})
    greens.sort(key=lambda f: (f["shortName"], f["id"]))
    facs = greens
    if state:
        facs = [f for f in facs if f["state"] == state.upper()]
    if facility and facility != "all":
        facs = [f for f in facs if f["id"] == facility]
        if not facs:
            return None
    ids = {f["id"] for f in facs}
    index = {f["id"]: i for i, f in enumerate(greens)}
    by_id = {f["id"]: f for f in greens}
    pinned = [f for f in greens if f["lat"] is not None and f["lng"] is not None]
    shown = [f for f in facs if f["lat"] is not None and f["lng"] is not None]
    shown_ids = {f["id"] for f in shown}
    current = {fid: c for fid, c in current_customers(db).items() if fid in ids}
    profiles = _profiles(db, sorted(ids), today) if ids else {}

    P = m.OpsCustomerPoint
    coverage = {fid: {"current": len(current.get(fid, ())), "placed": 0, "zipOnly": 0, "missing": 0, "pending": 0}
                for fid in ids}
    seen = {fid: 0 for fid in ids}
    placed = []                                     # (row, profile) for every customer on the map
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
        prof = profiles.get((r.facility_id, r.customer_id)) or {"kind": "storage", "tenure": "unknown", "rent": 0.0}
        placed.append((r.facility_id, r.lat, r.lng, r.precision == ZIP, prof))
    for fid, cov in coverage.items():
        cov["pending"] = max(0, cov["current"] - seen[fid])
    total = {k: sum(c[k] for c in coverage.values()) for k in ("current", "placed", "zipOnly", "missing", "pending")}

    bands = rent_bands([p["rent"] for *_, p in placed])
    want_kind = kind if kind in KINDS else "all"
    want_tenures = {"90": TENURES[:1], "365": TENURES[:2]}.get(str(since))
    want_band = int(band) if str(band) in ("0", "1", "2", "3") else None

    groups: dict[tuple, list] = {}                  # key -> [count, rent]
    for fid, lat, lng, is_zip, p in placed:
        if want_kind != "all" and p["kind"] != want_kind:
            continue
        if want_tenures and p["tenure"] not in want_tenures:
            continue
        b = band_of(p["rent"], bands)
        if want_band is not None and b != want_band:
            continue
        key = (fid, lat, lng, is_zip, KINDS.index(p["kind"]), TENURES.index(p["tenure"]), b)
        g = groups.setdefault(key, [0, 0.0])
        g[0] += 1
        g[1] += p["rent"]

    # Distances (to the customer's own facility) and the nearest Greens store.
    nearest: dict[tuple, tuple] = {}
    distances: list = []
    per_fac: dict[str, list] = {fid: [] for fid in ids}
    customers = {fid: 0 for fid in ids}
    vehicles = {fid: 0 for fid in ids}
    closer: dict[str, dict] = {fid: {} for fid in ids}
    outside: dict[str, int] = {}
    rows = []
    for key in sorted(groups, key=lambda k: (index[k[0]], k[1], k[2], k[3:])):
        fid, lat, lng, is_zip, k, t, b = key
        count, rent = groups[key]
        f = by_id[fid]
        customers[fid] += count
        vehicles[fid] += count if k == 1 else 0
        miles = closer_idx = None
        if fid in shown_ids:
            miles = miles_between(f["lat"], f["lng"], lat, lng)
            if (fid, lat, lng) not in nearest:
                best = min(pinned, key=lambda o: miles_between(o["lat"], o["lng"], lat, lng))
                nearest[(fid, lat, lng)] = (best["id"], miles_between(best["lat"], best["lng"], lat, lng))
            best_id, best_miles = nearest[(fid, lat, lng)]
            if best_id != fid and best_miles < miles:
                closer_idx = index[best_id]
                closer[fid][best_id] = closer[fid].get(best_id, 0) + count
            distances.extend([miles] * count)
            per_fac[fid].extend([miles] * count)
            if miles > RINGS[-1]:
                region = state_of({"latitude": lat, "longitude": lng}) or "Other"
                outside[region] = outside.get(region, 0) + count
        # Rent only for a group of 3+ customers: one person's rent at a ~100 m
        # point is too close to their door (Oct 22).
        rows.append([lat, lng, index[fid], int(is_zip), k, t, b, count,
                     round(rent, 2) if count >= MIN_RENT_GROUP else None, _r2(miles), closer_idx])

    competitors = _competitors(db, shown)
    by_facility = {}
    for fid in sorted(ids, key=lambda i: index[i]):
        n = customers[fid]
        by_facility[fid] = {
            **trade_stats(per_fac[fid]),
            "customers": n,
            "vehiclePct": round(100 * vehicles[fid] / n, 1) if n else None,
            "closer": sorted(({"facilityId": o, "shortName": by_id[o]["shortName"], "count": c}
                              for o, c in closer[fid].items()), key=lambda x: (-x["count"], x["shortName"])),
            "competitorsWithin": _within(competitors, fid) if fid in shown_ids else None,
        }
    regions = sorted(({"state": s, "count": c} for s, c in outside.items()), key=lambda x: (-x["count"], x["state"]))
    return {
        "facilities": facs,
        "greens": [{"id": f["id"], "shortName": f["shortName"], "lat": f["lat"], "lng": f["lng"]} for f in greens],
        "pointCols": list(POINT_COLS),
        "points": rows,
        "kinds": list(KINDS),
        "tenures": list(TENURES),
        "rentBands": bands,
        "filters": {"kind": want_kind, "since": str(since) if want_tenures else "all",
                    "band": "all" if want_band is None else str(want_band)},
        "coverage": coverage,
        "total": total,
        "stats": {**trade_stats(distances),
                  "customers": sum(customers.values()),
                  "outside50": {"count": sum(outside.values()), "regions": regions[:5]},
                  "overlap": sum(sum(c.values()) for c in closer.values()),
                  "competitorsWithin": _within(competitors) if shown else None},
        "byFacility": by_facility,
        "competitors": [{"name": c["name"], "lat": c["lat"], "lng": c["lng"], "miles": c["miles"]} for c in competitors],
    }
