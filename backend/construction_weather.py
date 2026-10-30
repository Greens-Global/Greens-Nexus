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


# ── The daily update (Neil, 10/30/2026: "give everyone the update every day
# of what the weather actually is") ──────────────────────────────────────────
#
# Each active jobsite's people - its managers, crew and executives - hear
# tomorrow's weather at that site the evening before (from EVENING_HOUR, site
# time) and again early in the morning only if the forecast changed
# (MORNING_FROM..MORNING_TO). One bell and one email per person covers every
# site they are on; a site that would earn a flag leads. What has been sent is
# kept in one NexusSetting row, per project and day, so a restart sends
# nothing twice. The crew's "are we on or off?" call at 6 AM is the thing
# this exists to end - the decision itself stays with Weather Call.
SETTINGS_KEY = "construction_weather_sent"
NOTICE_KEY = "construction-weather"
EVENING_HOUR = 17
MORNING_FROM, MORNING_TO = 5, 9
TICK_SEC = 15 * 60
KEEP_DAYS = 3
FLAG_WORDS = {"rain": "Rain", "storm": "Storms", "wind": "Wind", "heat": "Heat"}


def _sent(db: Session) -> dict:
    import json
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    try:
        v = json.loads(row.value) if row and row.value else {}
    except (TypeError, ValueError):
        v = {}
    return v if isinstance(v, dict) else {}


def _save_sent(db: Session, marks: dict, today: str) -> None:
    import json
    from datetime import date, timedelta
    import models
    keep = (date.fromisoformat(today) - timedelta(days=KEEP_DAYS)).isoformat()
    marks = {pid: {d: s for d, s in days.items() if d >= keep} for pid, days in marks.items()}
    marks = {pid: days for pid, days in marks.items() if days}
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if row is None:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value, row.updated_by = json.dumps(marks), "construction_weather"


def day_outlook(fc: dict, day: str, cfg: dict) -> dict | None:
    """One site's forecast for `day` (YYYY-MM-DD, site time): the daily row
    plus the first wet hour of that day the hourly data covers, and the facts
    the notice uses. None when the forecast does not reach that day."""
    row = next((d for d in fc.get("daily") or [] if d.get("date") == day), None)
    if not row:
        return None
    wet = next((h for h in fc.get("hourly") or [] if (h.get("time") or "")[:10] == day
                and (95 <= (h.get("code") or 0) <= 99
                     or (h.get("precipChance") or 0) >= cfg["headsUpChance"]
                     or (h.get("precip") or 0) >= cfg["headsUpInches"])), None)
    chance = row.get("precipChance") or 0
    inches = row.get("precipSum") or 0
    storm = 95 <= (row.get("code") or 0) <= 99
    if storm or (chance >= cfg["majorChance"] and inches >= cfg["majorInches"]) or inches >= cfg["anyChanceInches"]:
        flag = "storm" if storm else "rain"
    elif chance >= cfg["headsUpChance"] or inches >= cfg["headsUpInches"]:
        flag = "rain"
    elif (row.get("windMax") or 0) >= WIND_MPH:
        flag = "wind"
    elif (row.get("high") or 0) >= HEAT_F:
        flag = "heat"
    else:
        flag = ""
    units = fc.get("units") or {}
    return {"date": day, "code": row.get("code"), "high": row.get("high"), "low": row.get("low"),
            "chance": chance, "inches": inches, "windMax": row.get("windMax"),
            "rainFrom": (wet or {}).get("time", ""), "flag": flag,
            "tempUnit": units.get("temp", "°F"), "windUnit": units.get("wind", "mph")}


def fingerprint(o: dict) -> str:
    """What counts as 'the forecast changed': the sky, the degrees, the
    chance of rain to the nearest ten, and the hour rain starts."""
    return f"{o['code']}|{round(o['high'] or 0)}|{round(o['low'] or 0)}|{int((o['chance'] or 0) // 10) * 10}|{(o['rainFrom'] or '')[11:13]}"


def sky_words(code) -> str:
    """WMO code -> words (the frontend's weatherLib.sky, for notices)."""
    c = int(code or 0)
    if c == 0:
        return "Sunny"
    if c == 1:
        return "Mostly Sunny"
    if c == 2:
        return "Partly Cloudy"
    if c == 3:
        return "Cloudy"
    if c in (45, 48):
        return "Fog"
    if 51 <= c <= 57:
        return "Drizzle"
    if 61 <= c <= 67:
        return "Heavy Rain" if c == 65 else "Light Rain" if c == 61 else "Rain"
    if 71 <= c <= 77 or c in (85, 86):
        return "Snow"
    if 80 <= c <= 82:
        return "Showers"
    if c >= 95:
        return "Thunderstorms"
    return "-"


def _hour12(iso: str) -> str:
    h = int(iso[11:13])
    return f"{h % 12 or 12} {'PM' if h >= 12 else 'AM'}"


def _us_day(day: str) -> str:
    from datetime import date
    d = date.fromisoformat(day)
    return f"{d.strftime('%a')} {d.month:02d}/{d.day:02d}/{d.year}"


def site_line(name: str, o: dict) -> str:
    """'GS Temecula: Light Rain, 52-66°, rain from 7 AM (75%)'"""
    wet_sky = 51 <= int(o["code"] or 0) <= 99
    if o["rainFrom"]:
        rain = f"rain from {_hour12(o['rainFrom'])} ({o['chance']}%)"
    elif o["chance"] >= 20 or wet_sky:      # a drizzly sky never reads "no rain expected"
        rain = f"{o['chance']}% chance of rain"
    else:
        rain = "no rain expected"
    extra = ""
    if o["flag"] == "wind":
        extra = f", wind to {round(o['windMax'] or 0)} {o['windUnit']}"
    elif o["flag"] == "heat":
        extra = ", high heat"
    return f"{name}: {sky_words(o['code'])}, {round(o['low'] or 0)}-{round(o['high'] or 0)}°, {rain}{extra}"


def _people(p) -> set:
    return {(e or "").strip().lower()
            for e in (p.manager_emails or []) + (p.worker_emails or []) + (p.executive_emails or [])
            if (e or "").strip()}


def _email_html(slot: str, day: str, items: list) -> tuple:
    from html import escape
    import email_theme
    from app_url import app_url
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    title = "Jobsite Weather For Tomorrow" if slot == "evening" else "Jobsite Weather Changed For Today"
    subject = f"{title} - {_us_day(day)}"
    flagged = [i for i in items if i["o"]["flag"]]
    many = "s" if len(items) != 1 else ""
    th = ("padding:6px 10px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;"
          "color:#374151;text-align:left;background:#f9fafb")
    td = "padding:7px 10px;border-top:1px solid #e5e7eb;font-size:13px"
    rows = []
    for i in items:
        o = i["o"]
        rain = (f"from {_hour12(o['rainFrom'])} · " if o["rainFrom"] else "") + f"{o['chance']}%"
        rows.append(
            f"<tr><td style='{td};font-weight:600'>{escape(i['name'])}</td>"
            f"<td style='{td}'>{escape(sky_words(o['code']))}</td>"
            f"<td style='{td};text-align:right;white-space:nowrap'>{round(o['low'] or 0)} / {round(o['high'] or 0)}{escape(o['tempUnit'])}</td>"
            f"<td style='{td};text-align:right;white-space:nowrap'>{escape(rain)}</td>"
            f"<td style='{td};text-align:right;white-space:nowrap'>{round(o['windMax'] or 0)} {escape(o['windUnit'])}</td>"
            f"<td style='{td};color:#b91c1c;font-weight:600'>{escape(FLAG_WORDS.get(o['flag'], ''))}</td></tr>")
    if flagged:
        lead = (f"{len(flagged)} of your {len(items)} jobsite{many} may lose work to the weather: "
                + "; ".join(escape(site_line(i["name"], i["o"])) for i in flagged) + ".")
    else:
        lead = f"No rain, wind or heat is expected at your jobsite{many}."
    link = f"{app_url()}/construction/construction-dashboard"
    html = (
        "<div style=\"background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif\">"
        "<table align=\"center\" width=\"640\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:640px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse\">"
        f"<tr><td style=\"background:{band};padding:16px 28px\">{theme.logo_block()}</td></tr>"
        "<tr><td style=\"padding:24px 28px 0\">"
        f"<div style=\"font-size:20px;font-weight:600;color:#111827\">{escape(title)}</div>"
        f"<div style=\"font-size:14px;line-height:1.55;color:#374151;margin-top:8px\">{escape(_us_day(day))}. {lead}</div>"
        "</td></tr>"
        "<tr><td style=\"padding:18px 28px 0\">"
        "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border:1px solid #e5e7eb;border-collapse:collapse\">"
        f"<tr><th style=\"{th}\">Jobsite</th><th style=\"{th}\">Sky</th><th style=\"{th};text-align:right\">Low / High</th>"
        f"<th style=\"{th};text-align:right\">Rain</th><th style=\"{th};text-align:right\">Wind</th><th style=\"{th}\">Watch</th></tr>"
        f"{''.join(rows)}</table></td></tr>"
        "<tr><td style=\"padding:24px 28px 28px\">"
        f"<a href=\"{escape(link)}\" style=\"display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px\">Open Construction</a>"
        "</td></tr>"
        "<tr><td style=\"background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280\">"
        "You get this because you are on these jobsites in Nexus Construction. Whether the crew works is the "
        f"weather call your manager makes in Nexus. Forecast by Open-Meteo.{theme.footer_lines()}"
        "</td></tr></table></div>")
    return subject, html


def _send_email(to: list, subject: str, html: str) -> int:
    from weather_watch import _send_email as send
    return send(to, subject, html)


def _deliver(db: Session, recipient: str, slot: str, day: str, items: list) -> None:
    """One bell (rewritten in place) and one email for this person."""
    import notify_rollup
    items = sorted(items, key=lambda i: (not i["o"]["flag"], i["name"].lower()))
    flagged = [i for i in items if i["o"]["flag"]]
    title = "Weather At Your Jobsites Tomorrow" if slot == "evening" else "Jobsite Weather Changed For Today"
    line = " · ".join(site_line(i["name"], i["o"]) for i in items)
    notify_rollup.upsert_rollup(db, recipient=recipient, key=NOTICE_KEY, title=title, line=line,
                                action={"view": "ops", "sub": "construction-dashboard"}, replace=True,
                                priority=1 if flagged else 0)
    subject, html = _email_html(slot, day, items)
    _send_email([recipient], subject, html)


def tick(db: Session, now=None) -> dict:
    """One pass over the active jobsites with a point: for each, by its own
    clock, the evening notice for tomorrow (once) or the morning notice for
    today (once, and only when the forecast changed since the evening, or no
    evening notice went). Returns what was sent."""
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo
    import models
    from routers.weather import forecast_for
    now = now or datetime.now(timezone.utc)
    cfg = watch_config(db)
    marks = _sent(db)
    per_person: dict = {}          # (email, slot, day) -> [items]
    touched = False
    rows = (db.query(models.ConstructionProject)
            .filter(models.ConstructionProject.deleted_at == "",
                    models.ConstructionProject.status == "active",
                    models.ConstructionProject.archived == False).all())   # noqa: E712 - SQLAlchemy expression
    for p in rows:
        if not has_point(p) or not _people(p):
            continue
        try:
            fc = forecast_for(p.latitude, p.longitude, "imperial")
            local = now.astimezone(ZoneInfo(fc.get("timezone") or "UTC"))
        except Exception as e:  # noqa: BLE001 - one site's outage never stops the rest
            log.warning("construction weather for %s skipped: %s", p.name, e)
            continue
        if local.hour >= EVENING_HOUR:
            slot, day = "evening", (local.date() + timedelta(days=1)).isoformat()
        elif MORNING_FROM <= local.hour < MORNING_TO:
            slot, day = "morning", local.date().isoformat()
        else:
            continue
        o = day_outlook(fc, day, cfg)
        if not o:
            continue
        fp = fingerprint(o)
        done = marks.setdefault(p.id, {}).setdefault(day, {})
        if slot in done:
            continue
        if slot == "morning" and done.get("evening") == fp:
            continue                                   # same forecast as last night: quiet
        done[slot] = fp
        touched = True
        for em in _people(p):
            per_person.setdefault((em, slot, day), []).append({"name": p.name, "o": o})
    for (em, slot, day), items in per_person.items():
        try:
            _deliver(db, em, slot, day, items)
        except Exception as e:  # noqa: BLE001 - one address never stops the others
            log.warning("construction weather notice to %s failed: %s", em, e)
    if touched:
        _save_sent(db, marks, now.date().isoformat())
    db.commit()
    return {"notices": len(per_person), "people": len({k[0] for k in per_person})}


async def daily_loop():
    """Every TICK_SEC on the leader; the pass is DB and HTTP work, in a thread."""
    from database import SessionLocal
    await asyncio.sleep(120)
    while True:
        try:
            def _pass():
                db = SessionLocal()
                try:
                    return tick(db)
                finally:
                    db.close()
            s = await asyncio.to_thread(_pass)
            if s.get("notices"):
                print(f"[construction-weather] {s}")
        except Exception as e:  # noqa: BLE001 - the loop must outlive one bad pass
            print(f"[construction-weather] pass skipped: {e}")
        await asyncio.sleep(TICK_SEC)
