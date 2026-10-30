"""Project-based weather for Construction (Neil, call of 10/30/2026).

Neil: "If we're doing construction at 8 to 10 other locations, [the
dashboard widget] doesn't actually help ... when we're working on GS
Temecula, it should pull that address, it should pull that weather." Six
people drove to a jobsite 600 miles away on a rainy morning because the
weather alerts only ever looked at a team's home site.

So every construction project is its own weather point:
  - `geocode(p)` turns the project's address into latitude / longitude the
    moment it is created or its address changes (Nominatim, through the
    same one-a-second pacer Asset Management uses - asset_geocode.paced_search);
    `backfill_loop` does the same once for the projects that existed before.
    A typed latitude / longitude is never overwritten.
  - `site_weather(p, units)` is one project's forecast through the widget's
    cache (routers/weather.forecast_for - Open-Meteo, 10 minutes a cell), cut
    down to what the Construction screens show: now, today, the next days,
    the first wet hour and a flag (rain / storm / wind / heat).

The rain flag follows the company's Weather Watch thresholds
(weather_watch.band_for: heads-up at 40% or 0.10 in, major at 70% and 0.5 in,
any chance at 1 in, a storm at 50%) so the strip, the chip on the schedule
and the advisory never disagree about the same sky. Wind and heat are the
two other go / no-go limits a jobsite reads: 25 mph is where boom lifts and
cranes stop (OSHA 1926.1431 makes 20 mph a decision point, manufacturers
commonly 20-30), 95 F is Cal/OSHA's high-heat trigger (T8 3395).
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

WIND_MPH = 25          # boom lifts / cranes: stop and decide
HEAT_F = 95            # Cal/OSHA 3395 high-heat procedures
BACKFILL_SEC = 15 * 60


def has_point(p) -> bool:
    return bool(p.latitude) and bool(p.longitude)


def geocode(p) -> bool:
    """Set the project's point from its address. True when a point was set.
    Never raises - a lookup failure leaves the project where it was and the
    next backfill pass tries again."""
    address = (p.address or "").strip()
    if not address:
        return False
    try:
        from asset_geocode import paced_search
        hit = paced_search(address)
    except Exception as e:  # noqa: BLE001 - a weather point is never worth a failed save
        log.warning("construction geocode failed for %r: %s", address[:60], e)
        return False
    if not hit:
        return False
    p.latitude, p.longitude = round(hit[0], 5), round(hit[1], 5)
    return True


def _flag(fc: dict, cfg: dict) -> tuple[str, str]:
    """(flag, detail) for the next two days: 'storm' / 'rain' (the Weather
    Watch band over the coming hours), 'wind', 'heat', or '' with ''."""
    from weather_watch import band_for
    hours = [{"chance": h.get("precipChance") or 0, "inches": h.get("precip") or 0, "code": h.get("code") or 0}
             for h in fc.get("hourly") or []]
    band = band_for(hours, cfg)
    days = (fc.get("daily") or [])[:2]
    if band["band"] in ("major", "warning") or band["storm"]:
        return ("storm" if band["storm"] else "rain", f"{band['chance']}% chance, {band['inches']:.2f} in")
    windy = max((d.get("windMax") or 0 for d in days), default=0)
    hot = max((d.get("high") or 0 for d in days), default=0)
    if band["band"] == "heads_up":
        return "rain", f"{band['chance']}% chance of rain"
    if windy >= WIND_MPH:
        return "wind", f"wind to {round(windy)} {fc.get('units', {}).get('wind', 'mph')}"
    if hot >= HEAT_F:
        return "heat", f"high of {round(hot)}{fc.get('units', {}).get('temp', '')}"
    return "", ""


def site_weather(p, units: str = "imperial", cfg: dict | None = None) -> dict:
    """One project's weather for the Construction screens. A project with no
    point says why instead of a forecast."""
    base = {"projectId": p.id, "name": p.name, "address": p.address or "",
            "latitude": p.latitude or 0.0, "longitude": p.longitude or 0.0}
    if not has_point(p):
        base["weather"] = None
        base["reason"] = "No map point yet - add the jobsite address." if not (p.address or "").strip() \
            else "Finding this address on the map..."
        return base
    from routers.weather import forecast_for
    if cfg is None:
        from weather_watch import DEFAULTS
        cfg = DEFAULTS
    fc = forecast_for(p.latitude, p.longitude, units)
    # The first hour that would earn a heads-up on its own: a storm, or the
    # company's heads-up chance or amount.
    wet = next((h for h in fc.get("hourly") or []
                if 95 <= (h.get("code") or 0) <= 99
                or (h.get("precipChance") or 0) >= cfg["headsUpChance"]
                or (h.get("precip") or 0) >= cfg["headsUpInches"]), None)
    flag, detail = _flag(fc, cfg)
    base["weather"] = {
        "timezone": fc.get("timezone") or "",
        "units": fc.get("units") or {},
        "current": fc.get("current") or {},
        "today": fc.get("today") or {},
        "daily": (fc.get("daily") or [])[:5],
        "rainFrom": wet["time"] if wet else "",
        "rainChance": (wet or {}).get("precipChance"),
        "flag": flag, "flagDetail": detail,
        "fetchedAt": fc.get("fetchedAt") or "",
    }
    return base


def watch_config(db: Session) -> dict:
    """The company's Weather Watch thresholds, else the defaults."""
    try:
        from weather_watch import get_config
        return get_config(db)
    except Exception:  # noqa: BLE001 - defaults are a fine answer for a flag
        from weather_watch import DEFAULTS
        return dict(DEFAULTS)


def backfill(db: Session, limit: int = 20) -> int:
    """Give every live project with an address and no point its point. Paced
    (one lookup a second), so `limit` bounds one pass."""
    import models
    rows = (db.query(models.ConstructionProject)
            .filter(models.ConstructionProject.deleted_at == "",
                    models.ConstructionProject.address != "",
                    models.ConstructionProject.latitude == 0.0).limit(limit).all())
    done = 0
    for p in rows:
        if geocode(p):
            done += 1
    if done:
        db.commit()
    return done


async def backfill_loop():
    """Every BACKFILL_SEC on the leader: the projects still without a point
    (an address Nominatim could not place is retried, quietly)."""
    from database import SessionLocal
    await asyncio.sleep(60)
    while True:
        try:
            def _pass():
                db = SessionLocal()
                try:
                    return backfill(db)
                finally:
                    db.close()
            n = await asyncio.to_thread(_pass)
            if n:
                print(f"[construction-weather] placed {n} project(s) on the map")
        except Exception as e:  # noqa: BLE001 - the loop must outlive one bad pass
            print(f"[construction-weather] backfill skipped: {e}")
        await asyncio.sleep(BACKFILL_SEC)
