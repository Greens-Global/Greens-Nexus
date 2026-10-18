"""Shifts Phase 3a - a personal calendar subscribe feed (Neil, Oct 14 2026).

Not everyone lives in Outlook. Google Calendar, the iPhone Calendar app and
the rest subscribe to a URL and refresh it on their own schedule; this gives
each person one such URL for their own shared shifts:

    GET  /timeclock/my-schedule/ical-link          signed in -> {url, webcal}
    POST /timeclock/my-schedule/ical-link/rotate   a new link; the old one dies
    GET  /timeclock/ical/{token}.ics               PUBLIC - what the calendar
                                                   app fetches, no login

The token is `<payload><hmac>` (urlsafe base64) over {email, salt} with the
server's signing secret (secret_box.signing_secret, the key behind the
signed task links). No expiry - a subscription is for years - but the salt
is the person's nexus_person_prefs.ical_salt, and Rotate replaces it, so a
link that leaked stops working the moment they ask for a new one. The .ics
route is in RequestRateLimit.SENSITIVE_PREFIXES (30 / minute per IP).

The feed: the person's SHARED shifts from 30 days back to 120 days ahead,
UTC DTSTART / DTEND (no VTIMEZONE to get wrong), UID = the shift id, SUMMARY
the same as the Outlook event subject, STATUS:CANCELLED for a shift a
weather call cancelled, X-WR-CALNAME "Nexus Shifts". It never carries pay,
a note, or anyone else's shifts.
"""
import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy.orm import Session

import models
import secret_box
import shift_calendar
from app_url import public_base
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/timeclock", tags=["Shift Calendar"])

_SECRET = secret_box.signing_secret("nexus-shift-ical-DEV-ONLY-key-set-NEXUS_VAULT_KEY")
_CONTEXT = b"shift-ical:v1:"
_SIG_LEN = 16
DAYS_BACK, DAYS_AHEAD = 30, 120
CALNAME = "Nexus Shifts"


# ── Tokens ────────────────────────────────────────────────────────────────

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_token(email: str, salt: str) -> str:
    payload = json.dumps({"e": (email or "").lower(), "s": salt}, separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
    return _b64(payload + sig)


def parse_token(token: str) -> dict | None:
    """{"email", "salt"} for a well-signed token - else None. Whether the
    salt is still the person's current one is the route's check."""
    try:
        raw = _unb64(token or "")
        payload, sig = raw[:-_SIG_LEN], raw[-_SIG_LEN:]
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
        if len(sig) != _SIG_LEN or not hmac.compare_digest(want, sig):
            return None
        data = json.loads(payload)
        if not data.get("e") or not data.get("s"):
            return None
        return {"email": str(data["e"]).lower(), "salt": str(data["s"])}
    except Exception:
        return None


def api_base() -> str:
    """The public base of THIS API - the host a calendar app fetches from."""
    return public_base() or "http://localhost:8000"


def feed_url(token: str) -> str:
    return f"{api_base()}/timeclock/ical/{token}.ics"


def _pref(db: Session, email: str, create: bool = False):
    em = (email or "").lower()
    row = db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email == em).first()
    if row is None and create:
        row = models.NexusPersonPref(email=em)
        db.add(row)
    return row


def _salt_for(db: Session, email: str, rotate: bool = False) -> str:
    """The person's current salt, made on first use. Commits."""
    row = _pref(db, email, create=True)
    if rotate or not (row.ical_salt or ""):
        row.ical_salt = secrets.token_urlsafe(12)
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
    return row.ical_salt


def _link(db: Session, email: str, rotate: bool = False) -> dict:
    url = feed_url(make_token(email, _salt_for(db, email, rotate)))
    webcal = url.replace("https://", "webcal://", 1).replace("http://", "webcal://", 1)
    return {"url": url, "webcal": webcal, "name": CALNAME}


@router.get("/my-schedule/ical-link")
def my_ical_link(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The signed-in person's subscribe URL (the same one until rotated)."""
    return _link(db, user["email"])


@router.post("/my-schedule/ical-link/rotate")
def rotate_ical_link(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A new URL; every link issued before stops working."""
    return _link(db, user["email"], rotate=True)


# ── The feed ──────────────────────────────────────────────────────────────

def _esc(s: str) -> str:
    """RFC 5545 TEXT escaping."""
    return (str(s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """Lines longer than 75 octets continue on the next line after one space."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out, chunk = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(chunk) + len(b) > (75 if not out else 74):
            out.append(chunk.decode("utf-8"))
            chunk = b""
        chunk += b
    if chunk:
        out.append(chunk.decode("utf-8"))
    return "\r\n ".join(out)


def _utc(local: datetime, tz: str) -> str:
    try:
        zone = ZoneInfo(tz or shift_calendar._DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(shift_calendar._DEFAULT_TZ)
    return local.replace(tzinfo=zone).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_feed(db: Session, email: str, now: datetime = None) -> str:
    """The person's shared shifts as an iCalendar document."""
    em = (email or "").lower()
    now = now or datetime.now(timezone.utc)
    lo = (now - timedelta(days=DAYS_BACK)).date().isoformat()
    hi = (now + timedelta(days=DAYS_AHEAD)).date().isoformat()
    from routers.shift_requests import settings_for
    cfg = settings_for(db, em)
    team_tz = cfg.get("timeZone") or shift_calendar._DEFAULT_TZ
    transp = "OPAQUE" if (cfg.get("outlookShowAs") or "free") == "busy" else "TRANSPARENT"
    rows = (db.query(models.ScheduledShift)
            .filter(models.ScheduledShift.employee_email == em, models.ScheduledShift.published == 1,
                    models.ScheduledShift.work_date >= lo, models.ScheduledShift.work_date <= hi)
            .order_by(models.ScheduledShift.work_date, models.ScheduledShift.start_hhmm).all())
    presets = {s.id: s for s in db.query(models.Shift).all()} if rows else {}
    groups = {g.id: g for g in db.query(models.ShiftGroup).all()} if rows else {}
    sites = {s.id: s for s in db.query(models.HrWorkSite).all()} if rows else {}
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Greens Nexus//Shifts//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", f"X-WR-CALNAME:{_esc(CALNAME)}", "X-PUBLISHED-TTL:PT1H"]
    for r in rows:
        preset = presets.get(r.shift_id or "")
        tz = shift_calendar.shift_zone(r, preset, team_tz)
        try:
            s, e = shift_calendar.bounds(r.work_date, r.start_hhmm or "09:00", r.end_hhmm or "17:00")
        except (ValueError, TypeError):
            continue
        g = groups.get(getattr(r, "group_id", "") or "")
        site = sites.get((getattr(g, "work_site_id", "") or "") if g is not None else "")
        cancelled = (getattr(r, "weather_status", "") or "") == "cancelled"
        desc = [x for x in ((f"Team: {g.name}" if g is not None and g.name else ""),
                            (f"Site: {site.name}" if site is not None and site.name else ""),
                            ("Canceled by a weather call." if cancelled else "")) if x]
        lines += ["BEGIN:VEVENT", f"UID:{_esc(r.id)}", f"DTSTAMP:{stamp}",
                  f"DTSTART:{_utc(s, tz)}", f"DTEND:{_utc(e, tz)}",
                  f"SUMMARY:{_esc(shift_calendar.subject_for(r.start_hhmm, r.end_hhmm, shift_calendar.title_of(r, preset)))}",
                  f"STATUS:{'CANCELLED' if cancelled else 'CONFIRMED'}",
                  f"TRANSP:{transp}", f"CATEGORIES:{_esc(shift_calendar.CATEGORY)}"]
        if desc:
            lines.append(f"DESCRIPTION:{_esc(chr(10).join(desc))}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"


@router.get("/ical/{token}.ics")
def ical_feed(token: str, db: Session = Depends(get_db)):
    """PUBLIC: the calendar app's fetch. A bad or rotated link is a plain
    404 - never a hint about whose it was."""
    data = parse_token(token)
    if not data:
        return PlainTextResponse("Not found", status_code=404)
    row = _pref(db, data["email"])
    if row is None or not (row.ical_salt or "") or not hmac.compare_digest(row.ical_salt, data["salt"]):
        return PlainTextResponse("Not found", status_code=404)
    body = build_feed(db, data["email"])
    # The URL is the credential: no shared cache may keep the body, no
    # crawler may index it, and nothing leaves as a referrer.
    return Response(content=body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": 'inline; filename="nexus-shifts.ics"',
                             "Cache-Control": "private, no-store",
                             "X-Robots-Tag": "noindex, nofollow",
                             "Referrer-Policy": "no-referrer"})
