"""Clocked hours per store (Neil, 11/21/2026) - the Facility Scorecard's labor column.

Operations knew each store's occupancy, rent and past due, and the Time Clock
knew who clocked in where, but nothing put the two side by side. This says how
much time was worked at each store over the last few complete days, in
minutes (the screen reads them as hours:minutes, never decimal hours). HOURS
ONLY: never a pay rate, never a dollar figure, never a person's name - the
scorecard is read by people who may not see pay.

WHICH WORK SITE IS WHICH STORE: nothing links a Cubby facility to a Time Clock
work site, and the names differ ("GS Temecula", "Greens Storage Temecula"), so
they are tied by PLACE: a work site belongs to a store when the store's own
coordinates fall inside that site's geofence (its `radius_m`). A store may
have several sites (two gates, two lots) - their hours are added. A store with
no coordinates, or inside no site's geofence, simply has no hours to show.

WHAT COUNTS: each person's clock-in..clock-out time for the day
(`timeclock._day_summaries`, exact minutes, breaks out), credited to the work
site of that day's FIRST clock-in. Voided punches and paid-leave punches (a
Sick / Vacation job category) are not work at a store and are left out.
"""
import math
from datetime import date, timedelta

import models

DEFAULT_DAYS = 7
MAX_DAYS = 31


def _num(v):
    try:
        f = float(str(v).strip())
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def meters_between(lat1, lng1, lat2, lng2) -> float:
    """Ground distance between two points, in meters (haversine)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def sites_by_store(stores: list, sites: list) -> dict:
    """{store id: [site id]} by the geofence rule. `stores`: [{id, lat, lng}];
    `sites`: [{id, lat, lng, radius}] - the values as stored (strings are read)."""
    out = {}
    for s in stores:
        lat, lng = _num(s.get("lat")), _num(s.get("lng"))
        if lat is None or lng is None:
            continue
        hits = []
        for w in sites:
            wlat, wlng, rad = _num(w.get("lat")), _num(w.get("lng")), _num(w.get("radius"))
            if wlat is None or wlng is None or not rad or rad <= 0:
                continue
            if meters_between(lat, lng, wlat, wlng) <= rad:
                hits.append(str(w["id"]))
        if hits:
            out[str(s["id"])] = hits
    return out


def window(today: date, days: int = DEFAULT_DAYS) -> tuple:
    """(first, last) of the last `days` COMPLETE days: it ends yesterday, so a
    shift still running never makes today look short."""
    days = max(1, min(int(days or DEFAULT_DAYS), MAX_DAYS))
    last = today - timedelta(days=1)
    return (last - timedelta(days=days - 1)).isoformat(), last.isoformat()


def minutes_by_site(punches_by_person: dict) -> dict:
    """{site id: {"minutes", "people": set}} from each person's live punches in
    the window (oldest first). A day's worked minutes go to the site of that
    day's first clock-in; a day with no site on its first clock-in goes nowhere."""
    from routers.timeclock import _day_summaries, _leave_class
    out = {}
    for person, punches in punches_by_person.items():
        work = [p for p in punches if not _leave_class(getattr(p, "category", "") or "")]
        if not work:
            continue
        first_site = {}
        for p in work:
            if p.kind == "in" and p.local_date not in first_site:
                first_site[p.local_date] = str(p.work_site_id or "")
        for day, s in _day_summaries(work, 0).items():
            site, mins = first_site.get(day, ""), int(s.get("workedMin") or 0)
            if not site or mins <= 0:
                continue
            row = out.setdefault(site, {"minutes": 0, "people": set()})
            row["minutes"] += mins
            row["people"].add(person)
    return out


def hours(db, facility_ids, today: date, days: int = DEFAULT_DAYS) -> dict:
    """{"from", "to", "days", "stores": {facility id: {"minutes", "people", "sites"}}}
    for the stores given (None = every enabled one). A store tied to no work
    site is absent from `stores`; one tied to a site nobody clocked in at reads 0."""
    first, last = window(today, days)
    q = db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True))
    stores = [f for f in q.all() if facility_ids is None or f.facility_id in set(facility_ids)]
    sites = db.query(models.HrWorkSite).all()
    tied = sites_by_store(
        [{"id": f.facility_id, "lat": (f.data or {}).get("latitude"), "lng": (f.data or {}).get("longitude")} for f in stores],
        [{"id": w.id, "lat": w.latitude, "lng": w.longitude, "radius": w.radius_m} for w in sites])
    wanted = {sid for ids in tied.values() for sid in ids}
    by_person = {}
    if wanted:
        # Everyone who clocked in at one of these sites in the window - and ALL of their
        # punches in it, so a clock-out with no site on it still closes its shift.
        people = [e for (e,) in db.query(models.TimePunch.employee_email)
                  .filter(models.TimePunch.voided == 0, models.TimePunch.work_site_id.in_(wanted),
                          models.TimePunch.local_date >= first, models.TimePunch.local_date <= last).distinct().all()]
        if people:
            for p in (db.query(models.TimePunch)
                      .filter(models.TimePunch.voided == 0, models.TimePunch.employee_email.in_(people),
                              models.TimePunch.local_date >= first, models.TimePunch.local_date <= last)
                      .order_by(models.TimePunch.at).all()):
                by_person.setdefault((p.employee_email or "").lower(), []).append(p)
    per_site = minutes_by_site(by_person)
    names = {str(w.id): w.name or "" for w in sites}
    out = {}
    for fid, ids in tied.items():
        people = set()
        mins = 0
        for sid in ids:
            row = per_site.get(sid)
            if row:
                mins += row["minutes"]
                people |= row["people"]
        out[fid] = {"minutes": mins, "people": len(people), "sites": sorted(names.get(sid, "") for sid in ids)}
    return {"from": first, "to": last, "days": (date.fromisoformat(last) - date.fromisoformat(first)).days + 1, "stores": out}
