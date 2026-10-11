"""Weather watch - the automated rain advisory for shift groups (Weather Call,
Phase 1; Neil, Oct 10 2026).

Every WEATHER_SCAN_SEC the leader instance looks two days ahead at every
watched shift group: a group with weather alerts on, a work site that has
coordinates, and a company that is switched on in Settings > Shifts >
Weather Alerts (the feature ships behind a per-company switch). For each
day the group has published shifts, the forecast for the SCHEDULED HOURS
is banded:

    quiet     nothing
    heads_up  rain likely enough to glance at - an icon on the schedule and,
              when the setting is on, one quiet line in the group's Teams
              chat; never a bell
    major     rain that should make someone decide (Neil: "it must be major
              if we want it not to be an issue") - the ADVISORY: a priority
              bell to the group's weather deciders and the company's
              managers, an email to the deciders, a post in the group's
              Teams chat, and a weather line as the day's note
    warning   an active National Weather Service warning for the site -
              the advisory, at once, quiet hours or not

The band per group and day is kept in weather_outlook (what the schedule
grid reads - the grid never calls a weather service); every advisory sent
is a weather_advisories row, which is also the dedupe: one advisory per
group, day and band, re-sent only when the band changes. A day that was
advised and then eases below Major gets one quiet "eased" bell.

Nexus never cancels work by itself: the advisory informs; the call (Phase
2) is a person's. Forecasts come from Open-Meteo (hourly rain chance,
amount and weather code, in the site's own zone), warnings from the NWS
alerts feed (US only, free, no key; any other country simply has none).
Both are cached ten minutes per site and both fail soft - a provider
outage means no advisory this tick, never an error.

All of this is synchronous DB and HTTP work: the loop runs it in a thread
(CLAUDE.md: never block the event loop), and the manual "Check Now" route
is a plain `def` (FastAPI's threadpool).
"""
import asyncio
import json
import time
import threading
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy.orm import Session

import models
from app_url import app_url
from database import SessionLocal

SETTINGS_KEY = "weather_watch_config"
WEATHER_SCAN_SEC = 30 * 60
LOOKAHEAD_DAYS = 2
OUTLOOK_KEEP_DAYS = 14
# Hysteresis: a forecast hovering at the line must not page people every
# half hour. An easing is announced only once the advisory is an hour old,
# and a day that eased is not re-advised as Major for three hours (a
# WARNING always goes).
EASE_AFTER_MIN = 60
READVISE_AFTER_MIN = 180
_TIMEOUT = 10.0
_CACHE_TTL = 10 * 60
_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
_UA = {"User-Agent": "GreensNexus/1.0 (https://nexus.greensglobal.com)", "Accept": "application/geo+json"}
_DEFAULT_TZ = "America/Los_Angeles"

# The NWS events that mean "do not plan outdoor work as usual" on their own.
WARNING_EVENTS = {"Flash Flood Warning", "Flood Warning", "Severe Thunderstorm Warning", "High Wind Warning",
                  "Winter Storm Warning", "Tornado Warning", "Blizzard Warning", "Ice Storm Warning",
                  "Tropical Storm Warning", "Hurricane Warning"}
BANDS = ("quiet", "heads_up", "major", "warning")
BAND_RANK = {b: i for i, b in enumerate(BANDS)}

# Defaults are deliberately HIGH (Neil): the advisory is rare and trusted.
DEFAULTS = {
    "companies": {},          # {HrEntity.id: True} - a company is watched only when switched on
    "majorChance": 70,        # % chance in any scheduled hour, together with majorInches...
    "majorInches": 0.5,       # ...inches expected over the scheduled hours
    "anyChanceInches": 1.0,   # this much rain is Major whatever the chance
    "headsUpChance": 40,
    "headsUpInches": 0.10,
    "stormChance": 50,        # a thunderstorm hour at this chance is Major
    "quietStart": "21:00",    # advisories wait through the night (site time)...
    "quietEnd": "05:00",
    "headsUpTeams": True,     # a heads-up posts one quiet Teams line
    "smsDefault": True,       # Phase 2: the crew notice texts by default
}
_RANGES = {"majorChance": (0, 100), "headsUpChance": (0, 100), "stormChance": (0, 100),
           "majorInches": (0, 20), "anyChanceInches": (0, 20), "headsUpInches": (0, 20)}

_cache: dict = {}
_lock = threading.Lock()


# ── Settings ──────────────────────────────────────────────────────────────

def _hhmm_ok(v) -> bool:
    try:
        h, m = (int(x) for x in str(v).split(":"))
        return 0 <= h < 24 and 0 <= m < 60
    except (TypeError, ValueError):
        return False


def get_config(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    cfg = json.loads(json.dumps(DEFAULTS))
    if row and row.value:
        try:
            saved = json.loads(row.value)
        except (TypeError, ValueError):
            saved = {}
        if isinstance(saved, dict):
            for k, v in saved.items():
                if k not in DEFAULTS:
                    continue
                if k == "companies":
                    cfg[k] = {str(c): bool(on) for c, on in (v or {}).items()} if isinstance(v, dict) else {}
                elif k in _RANGES:
                    try:
                        lo, hi = _RANGES[k]
                        cfg[k] = max(lo, min(hi, float(v)))
                    except (TypeError, ValueError):
                        pass
                elif k in ("quietStart", "quietEnd"):
                    if _hhmm_ok(v):
                        cfg[k] = str(v)
                else:
                    cfg[k] = bool(v)
    for k in ("majorChance", "headsUpChance", "stormChance"):
        cfg[k] = int(cfg[k])
    return cfg


def save_config(db: Session, patch: dict, by: str) -> dict:
    """Merge `patch` (camelCase keys as in DEFAULTS) into the saved config.
    Values are clamped to sane ranges; bad times are refused."""
    cfg = get_config(db)
    for k, v in (patch or {}).items():
        if k not in DEFAULTS or v is None:
            continue
        if k == "companies":
            if isinstance(v, dict):
                merged = dict(cfg["companies"])
                merged.update({str(c): bool(on) for c, on in v.items()})
                cfg["companies"] = {c: on for c, on in merged.items() if on}   # keep the list to the ones on
        elif k in _RANGES:
            lo, hi = _RANGES[k]
            try:
                cfg[k] = max(lo, min(hi, float(v)))
            except (TypeError, ValueError):
                raise ValueError(f"{k} must be a number.")
        elif k in ("quietStart", "quietEnd"):
            if not _hhmm_ok(v):
                raise ValueError("Quiet hours need times like 21:00 and 05:00.")
            cfg[k] = str(v)
        else:
            cfg[k] = bool(v)
    if cfg["headsUpChance"] > cfg["majorChance"]:
        raise ValueError("The heads-up chance must not be above the major chance.")
    for k in ("majorChance", "headsUpChance", "stormChance"):
        cfg[k] = int(cfg[k])
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = by
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return cfg


def company_enabled(cfg: dict, company_id: str) -> bool:
    return bool(company_id) and bool((cfg.get("companies") or {}).get(company_id))


# ── Providers (cached, fail soft) ─────────────────────────────────────────

def _cached(key, fetch):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]
    value = fetch()
    with _lock:
        if len(_cache) > 500:
            _cache.clear()
        _cache[key] = (now, value)
    return value


def _round(lat, lon) -> tuple:
    return round(float(lat), 2), round(float(lon), 2)


def fetch_forecast(lat, lon) -> dict | None:
    """{"timezone", "hours": [{time, chance, inches, code}]} for the next
    four days in the site's own zone - or None when the provider is down."""
    la, lo = _round(lat, lon)

    def fetch():
        try:
            r = httpx.get(_FORECAST_URL, params={
                "latitude": la, "longitude": lo, "timezone": "auto", "forecast_days": 4,
                "hourly": "precipitation_probability,precipitation,weather_code",
                "precipitation_unit": "inch"}, timeout=_TIMEOUT)
            r.raise_for_status()
            raw = r.json()
        except (httpx.HTTPError, ValueError):
            return None
        h = raw.get("hourly") or {}
        times = h.get("time") or []
        chance, precip, code = h.get("precipitation_probability") or [], h.get("precipitation") or [], h.get("weather_code") or []
        hours = []
        for i, t in enumerate(times):
            hours.append({"time": t, "chance": int(chance[i] or 0) if i < len(chance) and chance[i] is not None else 0,
                          "inches": float(precip[i] or 0) if i < len(precip) and precip[i] is not None else 0.0,
                          "code": int(code[i] or 0) if i < len(code) and code[i] is not None else 0})
        return {"timezone": raw.get("timezone") or "", "hours": hours}
    return _cached(("fc", la, lo), fetch)


def fetch_alerts(lat, lon) -> list:
    """Active NWS alerts at the point: [{event, headline, onset, ends}].
    Empty outside the US, and empty when the feed is down."""
    la, lo = _round(lat, lon)

    def fetch():
        try:
            r = httpx.get(_NWS_ALERTS_URL, params={"point": f"{la},{lo}"}, headers=_UA, timeout=_TIMEOUT)
            if r.status_code >= 400:
                return []
            raw = r.json()
        except (httpx.HTTPError, ValueError):
            return []
        out = []
        for f in raw.get("features") or []:
            p = f.get("properties") or {}
            out.append({"event": p.get("event") or "", "headline": p.get("headline") or "",
                        "onset": p.get("onset") or p.get("effective") or "", "ends": p.get("ends") or p.get("expires") or ""})
        return out
    return _cached(("nws", la, lo), fetch)


# ── Banding ───────────────────────────────────────────────────────────────

def _minutes(hhmm: str) -> int:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
        return h * 60 + m
    except ValueError:
        return 0


def scheduled_window(shifts: list) -> tuple:
    """(start_min, end_min) covering every shift that day; a shift that runs
    past midnight stretches the window to the end of the day."""
    starts, ends = [], []
    for s in shifts:
        a, b = _minutes(s.start_hhmm), _minutes(s.end_hhmm)
        starts.append(a)
        ends.append(24 * 60 if b <= a else b)
    return (min(starts) if starts else 0, max(ends) if ends else 24 * 60)


def hours_in_window(forecast: dict, day: str, start_min: int, end_min: int) -> list:
    out = []
    for h in forecast.get("hours") or []:
        if not h["time"].startswith(day):
            continue
        hm = _minutes(h["time"][11:16])
        if hm < end_min and hm + 60 > start_min:
            out.append(h)
    return out


def _alert_covers(a: dict, day: str) -> bool:
    """Does an NWS alert touch this calendar day (by its local onset/ends)?"""
    onset, ends = (a.get("onset") or "")[:10], (a.get("ends") or "")[:10]
    if onset and onset > day:
        return False
    if ends and ends < day:
        return False
    return True


def band_for(hours: list, cfg: dict, alerts: list = (), day: str = "") -> dict:
    """The band for one group-day from the hours in its scheduled window."""
    chance = max((h["chance"] for h in hours), default=0)
    inches = round(sum(h["inches"] for h in hours), 2)
    storm = any(95 <= h["code"] <= 99 and h["chance"] >= cfg["stormChance"] for h in hours)
    warnings = sorted({a["event"] for a in alerts if a.get("event") in WARNING_EVENTS and (not day or _alert_covers(a, day))})
    if warnings:
        band = "warning"
    elif (chance >= cfg["majorChance"] and inches >= cfg["majorInches"]) or inches >= cfg["anyChanceInches"] or storm:
        band = "major"
    elif chance >= cfg["headsUpChance"] or inches >= cfg["headsUpInches"]:
        band = "heads_up"
    else:
        band = "quiet"
    return {"band": band, "chance": chance, "inches": inches, "storm": storm, "alerts": warnings}


# ── Who is told ───────────────────────────────────────────────────────────

def group_company(db: Session, g, member_emails: list, people: dict = None) -> str:
    """A shift group is cross-company by design; for the per-company switch
    it belongs to the company most of its members work for, else its
    creator's. '' when nobody is tagged."""
    people = people if people is not None else _people(db)
    counts = Counter((people[e].company or "") for e in member_emails if e in people and (people[e].company or ""))
    if counts:
        return counts.most_common(1)[0][0]
    me = people.get((g.created_by or "").lower())
    return (me.company or "") if me else ""


def company_managers(db: Session, company_id: str) -> list:
    if not company_id:
        return []
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == company_id).first()
    if not ent:
        return []
    out = [str(e).strip().lower() for e in (ent.manager_emails or []) if str(e).strip()]
    if not out and (ent.manager_email or "").strip():
        out = [ent.manager_email.strip().lower()]
    return list(dict.fromkeys(out))


def deciders_for(db: Session, g, company_id: str) -> tuple:
    """(deciders, everyone_told): the people who make the call, and the full
    advisory audience - deciders (else the group's schedulers) plus the
    company's managers. Only active people in People."""
    from routers.timeclock import _schedulers, _weather_deciders
    people = _people(db)
    deciders = [e for e in _weather_deciders(g) if e in people] or [e for e in _schedulers(g) if e in people]
    managers = [e for e in company_managers(db, company_id) if e in people]
    return deciders, list(dict.fromkeys(deciders + managers))


def _people(db: Session) -> dict:
    return {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee).all()
            if e.work_email and (e.status or "active") == "active" and not (e.deleted_at or "")}


# ── Formatting ────────────────────────────────────────────────────────────

def _t12(minutes: int) -> str:
    h, m = divmod(max(0, min(24 * 60, minutes)), 60)
    if h == 24:
        return "midnight"
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _day_label(day: str) -> str:
    try:
        d = datetime.strptime(day, "%Y-%m-%d")
        return f"{d.strftime('%a')} {d.strftime('%m/%d')}"
    except ValueError:
        return day


def _us(day: str) -> str:
    try:
        return datetime.strptime(day, "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return day


def summary_line(o: dict) -> str:
    """One sentence about a group-day, for the bell, the note and Teams."""
    window = f"{_t12(o['windowStart'])} - {_t12(o['windowEnd'])}"
    if o["band"] == "warning":
        return f"{', '.join(o['alerts'])} in force. Rain {o['chance']}%, {o['inches']:.2f} in during {window}."
    what = "Thunderstorms" if o.get("storm") else "Major rain" if o["band"] == "major" else "Rain likely"
    return f"{what}: {o['chance']}% chance, {o['inches']:.2f} in expected during {window}."


def _link(day: str, group_id: str) -> str:
    return f"{app_url()}/shifts/schedule:{day}:{group_id}"


# ── Delivery (each one a module function so a test can stand it in) ───────

def _bell(db: Session, recipient: str, ref_id: str, title: str, body: str, *, action: dict, company: str,
          priority: int) -> None:
    """One bell per (person, ref_id), refreshed in place while it is still
    open - like shift_notify._upsert_bell."""
    now = datetime.now(timezone.utc).isoformat()
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is not None:
        row.title, row.body, row.created_at, row.read_by, row.priority = title, body, now, "", priority
        row.action = json.dumps(action)
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient, title=title, body=body,
        ref_id=ref_id, item_name="", requested_by="", action=json.dumps(action), actioned=False, read_by="",
        company=company or "", created_at=now, priority=priority))


def _post_teams(db: Session, g, html: str, as_emails: list) -> str:
    """Post into the group's bound chat or channel as the first of
    `as_emails` with a live Nexus session (Nexus posts to Teams as a person).
    Returns 'ok' or the reason it did not go."""
    import bff_session
    import teams_post
    chat_id = (g.teams_chat_id or "").strip()
    if not chat_id:
        return "no Teams chat or channel bound to the group"
    channel = (getattr(g, "teams_target", "") or "chat") == "channel"
    scopes = bff_session.GRAPH_CHANNEL_SCOPES if channel else bff_session.GRAPH_CHAT_SCOPES
    last = "no decider or scheduler is signed in to Nexus"
    for em in as_emails:
        try:
            tok = bff_session.graph_token_for_email(db, em, scopes)
        except Exception as e:   # noqa: BLE001 - try the next person
            last = f"{em}: {e}"
            continue
        if not tok:
            continue
        try:
            if channel:
                teams_post.send_channel_message(tok, g.teams_team_id or "", chat_id, html)
            else:
                teams_post.send_chat_message(tok, chat_id, html)
            return "ok"
        except Exception as e:   # noqa: BLE001
            last = f"{em}: {str(e)[:160]}"
    return last


def _email_html(group_name: str, site_name: str, day: str, o: dict, hours: list, link: str) -> tuple:
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    title = "Weather Warning" if o["band"] == "warning" else "Weather Advisory"
    subject = f"{title}: {group_name}, {_day_label(day)}"
    rows = "".join(
        f"<tr><td style='padding:6px 10px;border-top:1px solid #e5e7eb;font-size:13px;white-space:nowrap'>{escape(_t12(_minutes(h['time'][11:16])))}</td>"
        f"<td style='padding:6px 10px;border-top:1px solid #e5e7eb;font-size:13px;text-align:right'>{h['chance']}%</td>"
        f"<td style='padding:6px 10px;border-top:1px solid #e5e7eb;font-size:13px;text-align:right'>{h['inches']:.2f} in</td></tr>"
        for h in hours)
    th = "padding:6px 10px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#374151;text-align:left;background:#f9fafb"
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(title)} for {escape(group_name)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{escape(_day_label(day))} ({escape(_us(day))}) at {escape(site_name or 'the work site')}: {escape(summary_line(o))}
      {o['shifts']} shift{'' if o['shifts'] == 1 else 's'} and {o['people']} {'person is' if o['people'] == 1 else 'people are'} scheduled. Make the weather call in Nexus so the crew hears early.</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse">
        <tr><th style="{th}">Hour</th><th style="{th};text-align:right">Chance</th><th style="{th};text-align:right">Rain</th></tr>{rows}
      </table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(link)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open the Schedule</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this email because you make the weather call for {escape(group_name)} in Nexus. Forecast by Open-Meteo; warnings by the National Weather Service.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return subject, html


def _send_email(to: list, subject: str, html: str) -> int:
    import graph_mail
    if not to or not graph_mail.graph_configured():
        return 0
    sent = 0
    for em in to:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[em], cc=None, subject=subject, html=html)
            sent += 1
        except Exception as e:   # noqa: BLE001 - never fail the advisory for one address
            print(f"[weather-watch] email to {em} failed: {e}")
    return sent


def _set_day_note(db: Session, group_id: str, day: str, text: str) -> bool:
    """The weather line as the group's day note - only when the day has no
    note or its note is already a weather line (a person's own note stays)."""
    row = (db.query(models.ScheduleDayNote)
           .filter(models.ScheduleDayNote.work_date == day, models.ScheduleDayNote.group_id == group_id).first())
    if row and (row.note or "").strip() and not (row.note or "").startswith("Weather:"):
        return False
    if not row:
        row = models.ScheduleDayNote(id=str(uuid.uuid4()), work_date=day, group_id=group_id)
        db.add(row)
    row.note, row.updated_by, row.updated_at = text[:200], "weather", datetime.now(timezone.utc).isoformat()
    return True


# ── The scan ──────────────────────────────────────────────────────────────

def _local_now(tz: str, now_utc: datetime) -> datetime:
    try:
        return now_utc.astimezone(ZoneInfo(tz or _DEFAULT_TZ))
    except Exception:   # noqa: BLE001 - an odd zone from the provider
        return now_utc.astimezone(ZoneInfo(_DEFAULT_TZ))


def in_quiet_hours(cfg: dict, local: datetime) -> bool:
    cur = local.hour * 60 + local.minute
    a, b = _minutes(cfg["quietStart"]), _minutes(cfg["quietEnd"])
    if a == b:
        return False
    return (a <= cur < b) if a < b else (cur >= a or cur < b)


def _age_minutes(row, now_utc: datetime) -> float:
    try:
        return (now_utc - datetime.fromisoformat(row.created_at)).total_seconds() / 60
    except (TypeError, ValueError):
        return 10 ** 6


def _last_advisory(db: Session, group_id: str, day: str):
    return (db.query(models.WeatherAdvisory)
            .filter(models.WeatherAdvisory.group_id == group_id, models.WeatherAdvisory.work_date == day)
            .order_by(models.WeatherAdvisory.created_at.desc()).first())


def _upsert_outlook(db: Session, g, day: str, o: dict, hours: list, tz: str) -> None:
    oid = f"{g.id}:{day}"
    row = db.query(models.WeatherOutlook).filter(models.WeatherOutlook.id == oid).first()
    if not row:
        row = models.WeatherOutlook(id=oid, group_id=g.id, work_date=day)
        db.add(row)
    row.band, row.chance, row.inches, row.storm = o["band"], int(o["chance"]), float(o["inches"]), 1 if o["storm"] else 0
    row.alerts_json = json.dumps(o["alerts"])
    row.window_start, row.window_end = _t12(o["windowStart"]), _t12(o["windowEnd"])
    row.hourly_json = json.dumps(hours)
    row.shifts, row.people, row.timezone = int(o["shifts"]), int(o["people"]), tz or ""
    row.updated_at = datetime.now(timezone.utc).isoformat()


def _record(db: Session, g, day: str, o: dict, hours: list, recipients: list, channels: dict, band: str = "",
            now_utc: datetime = None) -> None:
    """created_at is the scan's clock, which the hysteresis measures against."""
    db.add(models.WeatherAdvisory(
        id=str(uuid.uuid4()), group_id=g.id, work_date=day, band=band or o["band"], chance=int(o["chance"]),
        inches=float(o["inches"]), storm=1 if o.get("storm") else 0, alerts_json=json.dumps(o.get("alerts") or []),
        window_start=_t12(o["windowStart"]), window_end=_t12(o["windowEnd"]), recipients_json=json.dumps(recipients),
        channels_json=json.dumps(channels), snapshot_json=json.dumps(hours),
        created_at=(now_utc or datetime.now(timezone.utc)).isoformat()))


def _advise(db: Session, g, site, company_id: str, day: str, o: dict, hours: list, now_utc: datetime = None) -> dict:
    """Send the Major / Warning advisory for one group-day. Returns what went where."""
    deciders, told = deciders_for(db, g, company_id)
    link_sub = f"schedule:{day}:{g.id}"
    action = {"view": "shifts", "sub": link_sub}
    headline = f"{'Weather warning' if o['band'] == 'warning' else 'Rain expected'} for {g.name} on {_day_label(day)}"
    body = f"{summary_line(o)} {o['shifts']} shift{'' if o['shifts'] == 1 else 's'} scheduled. Make the weather call."
    for em in told:
        _bell(db, em, f"weather:{g.id}:{day}", headline, body, action=action, company=company_id, priority=1)
    channels = {"bell": len(told)}
    note = f"Weather: {summary_line(o)} Weather call pending."
    channels["dayNote"] = _set_day_note(db, g.id, day, note)
    db.commit()
    link = _link(day, g.id)
    html = (f"<p><b>{'⚠️ Weather warning' if o['band'] == 'warning' else '🌧️ Weather advisory'} for {escape(g.name)} - "
            f"{escape(_day_label(day))}</b><br>{escape(summary_line(o))} {o['shifts']} shift{'' if o['shifts'] == 1 else 's'} scheduled"
            f"{' at ' + escape(site.name) if site is not None and site.name else ''}. "
            f"The weather call is pending: <a href=\"{escape(link)}\">open the schedule</a>.</p>")
    try:
        channels["teams"] = _post_teams(db, g, html, told)
    except Exception as e:   # noqa: BLE001
        channels["teams"] = f"failed: {str(e)[:160]}"
    try:
        subject, mail_html = _email_html(g.name, site.name if site is not None else "", day, o, hours, link)
        channels["email"] = _send_email(deciders, subject, mail_html)
    except Exception as e:   # noqa: BLE001
        channels["email"] = f"failed: {str(e)[:160]}"
    _record(db, g, day, o, hours, told, channels, now_utc=now_utc)
    db.commit()
    return channels


def _heads_up(db: Session, g, company_id: str, day: str, o: dict, hours: list, now_utc: datetime = None) -> dict:
    """The quiet Teams line for a heads-up day (Neil: no bell)."""
    deciders, told = deciders_for(db, g, company_id)
    html = (f"<p>🌦️ Heads-up for {escape(g.name)} - {escape(_day_label(day))}: {escape(summary_line(o))} "
            f"No action needed yet; Nexus will advise if it turns major.</p>")
    try:
        result = _post_teams(db, g, html, told)
    except Exception as e:   # noqa: BLE001
        result = f"failed: {str(e)[:160]}"
    channels = {"teams": result}
    _record(db, g, day, o, hours, [], channels, now_utc=now_utc)
    db.commit()
    return channels


def _eased(db: Session, g, company_id: str, day: str, o: dict, hours: list, now_utc: datetime = None) -> dict:
    """A day that was advised has eased below Major: one quiet bell, and the
    weather day note says so."""
    deciders, told = deciders_for(db, g, company_id)
    action = {"view": "shifts", "sub": f"schedule:{day}:{g.id}"}
    for em in told:
        _bell(db, em, f"weather-eased:{g.id}:{day}", f"Weather eased for {g.name} on {_day_label(day)}",
              f"The forecast no longer reaches the major band. {summary_line(o)}", action=action, company=company_id, priority=0)
    _set_day_note(db, g.id, day, f"Weather: forecast eased. {summary_line(o)}")
    channels = {"bell": len(told)}
    _record(db, g, day, o, hours, told, channels, band="eased", now_utc=now_utc)
    db.commit()
    return channels


def watched_groups(db: Session, cfg: dict) -> list:
    """[(group, site, company_id, member_emails)] for every group the watch covers."""
    people = _people(db)
    members: dict = {}
    for m in db.query(models.ShiftGroupMember).all():
        members.setdefault(m.group_id, []).append((m.employee_email or "").lower())
    sites = {s.id: s for s in db.query(models.HrWorkSite).all()}
    out = []
    for g in db.query(models.ShiftGroup).all():
        if getattr(g, "archived", 0) or not int(getattr(g, "weather_alerts", 1) if getattr(g, "weather_alerts", 1) is not None else 1):
            continue
        site = sites.get(getattr(g, "work_site_id", "") or "")
        if not site or not (site.latitude or "").strip() or not (site.longitude or "").strip():
            continue
        cid = group_company(db, g, members.get(g.id, []), people)
        if not company_enabled(cfg, cid):
            continue
        out.append((g, site, cid, members.get(g.id, [])))
    return out


def scan_once(db: Session, now_utc: datetime = None) -> dict:
    """One pass over every watched group. Returns a summary for the log and
    the Check Now button."""
    now_utc = now_utc or datetime.now(timezone.utc)
    cfg = get_config(db)
    summary = {"groups": 0, "days": 0, "advisories": 0, "headsUp": 0, "eased": 0, "held": 0, "providerDown": 0,
               "bands": {}}
    if not any(cfg["companies"].values()):
        return summary
    groups = watched_groups(db, cfg)
    summary["groups"] = len(groups)
    # The outlook is a rolling window (the grid's icons); the record of what
    # was sent is weather_advisories. Old bands go.
    gone = (now_utc.date() - timedelta(days=OUTLOOK_KEEP_DAYS)).isoformat()
    db.query(models.WeatherOutlook).filter(models.WeatherOutlook.work_date < gone).delete(synchronize_session=False)
    db.commit()
    if not groups:
        return summary
    for g, site, cid, member_emails in groups:
        try:
            forecast = fetch_forecast(site.latitude, site.longitude)
        except Exception:   # noqa: BLE001
            forecast = None
        if not forecast:
            summary["providerDown"] += 1
            continue
        tz = forecast.get("timezone") or _DEFAULT_TZ
        local = _local_now(tz, now_utc)
        days = [(local.date() + timedelta(days=i)).isoformat() for i in range(LOOKAHEAD_DAYS + 1)]
        q = (db.query(models.ScheduledShift)
             .filter(models.ScheduledShift.published == 1, models.ScheduledShift.pending_delete == 0,
                     models.ScheduledShift.work_date.in_(days)))
        rows = [r for r in q.all()
                if (r.group_id or "") == g.id or (not (r.group_id or "") and (r.employee_email or "").lower() in member_emails)]
        by_day: dict = {}
        for r in rows:
            by_day.setdefault(r.work_date, []).append(r)
        alerts = fetch_alerts(site.latitude, site.longitude) if by_day else []
        for day, shifts in sorted(by_day.items()):
            summary["days"] += 1
            start_min, end_min = scheduled_window(shifts)
            hours = hours_in_window(forecast, day, start_min, end_min)
            o = band_for(hours, cfg, alerts, day)
            o.update({"windowStart": start_min, "windowEnd": end_min, "shifts": len(shifts),
                      "people": len({(s.employee_email or "").lower() for s in shifts if s.employee_email})})
            summary["bands"][o["band"]] = summary["bands"].get(o["band"], 0) + 1
            _upsert_outlook(db, g, day, o, hours, tz)
            db.commit()
            last = _last_advisory(db, g.id, day)
            last_band = last.band if last else ""
            age_min = _age_minutes(last, now_utc) if last else None
            if o["band"] in ("major", "warning"):
                # Already told - or told something stronger: a warning that
                # lapses while the rain stays is not news.
                if last_band == o["band"] or (last_band == "warning" and o["band"] == "major"):
                    continue
                if last_band == "eased" and o["band"] == "major" and age_min is not None and age_min < READVISE_AFTER_MIN:
                    summary["held"] += 1
                    continue
                if o["band"] == "major" and in_quiet_hours(cfg, local):
                    summary["held"] += 1
                    continue
                _advise(db, g, site, cid, day, o, hours, now_utc=now_utc)
                summary["advisories"] += 1
            elif last_band in ("major", "warning"):
                if age_min is not None and age_min < EASE_AFTER_MIN:
                    summary["held"] += 1   # let the easing stick before saying so
                    continue
                _eased(db, g, cid, day, o, hours, now_utc=now_utc)
                summary["eased"] += 1
            elif o["band"] == "heads_up" and cfg.get("headsUpTeams") and not last_band:
                _heads_up(db, g, cid, day, o, hours, now_utc=now_utc)
                summary["headsUp"] += 1
    return summary


def outlook_rows(db: Session, start: str, end: str, group_ids: list = None) -> list:
    """What the schedule grid shows: the band per group and day in a range
    (no hourly detail here)."""
    q = (db.query(models.WeatherOutlook)
         .filter(models.WeatherOutlook.work_date >= start, models.WeatherOutlook.work_date <= end))
    if group_ids is not None:
        if not group_ids:
            return []
        q = q.filter(models.WeatherOutlook.group_id.in_(list(group_ids)))
    out = []
    for r in q.all():
        if r.band == "quiet":
            continue
        try:
            alerts = json.loads(r.alerts_json or "[]")
        except (TypeError, ValueError):
            alerts = []
        out.append({"groupId": r.group_id, "date": r.work_date, "band": r.band, "chance": int(r.chance or 0),
                    "inches": float(r.inches or 0), "storm": bool(r.storm), "alerts": alerts,
                    "windowStart": r.window_start or "", "windowEnd": r.window_end or "",
                    "shifts": int(r.shifts or 0), "people": int(r.people or 0), "updatedAt": r.updated_at or ""})
    return out


def _tick() -> dict:
    db = SessionLocal()
    try:
        return scan_once(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[weather-watch] scan failed: {e}")
        return {}
    finally:
        db.close()


async def weather_watch_loop():
    """Started from main.py's lifespan on the elected leader. The scan is
    synchronous DB and HTTP work, so it runs in a thread."""
    await asyncio.sleep(90)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and (s.get("advisories") or s.get("headsUp") or s.get("eased")):
            print(f"[weather-watch] {s}")
        await asyncio.sleep(WEATHER_SCAN_SEC)
