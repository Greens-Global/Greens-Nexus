"""Location Trail While Clocked In (Neil's Time Clock checklist, Oct 20 2026).

The web stopgap for the field-tracking design in docs/Field-Tracking-Spec.md.
The Nexus Fields Android app (device-token, /timeclock/track/*) is the real
breadcrumb client, but nobody has it installed yet, so the signed-in web app
sends the same pings into the SAME tables (track_sessions / track_pings,
source = "web") while the person is clocked in.

Rules, all enforced here (the browser hook in lib/useLocationTrail.js only
follows them):
  - the person's company has `locationTrailOn` (Global Settings > Shifts >
    Attendance, per company, OFF by default) - otherwise a ping is ignored;
  - clocked in right now: the last punch is a clock-in or a break end inside
    the 16-hour pairing guard. On a break the ping is ignored (paused); with
    no open shift any open trail session is closed and the ping dropped -
    off-shift location is never stored;
  - someone who revoked tracking consent in the phone app (their newest
    track_consent row is a revocation) is not trailed from the web either;
  - one ping per person per ~2 minutes at most (two open tabs, a retry), the
    rest are ignored.
The browser asks for nothing: it pings only when location permission is
already granted.

Reading is managers only, on Workforce Analytics > Location Trail (Neil,
Oct 21 2026: no employee sees a trail, their own included):
`require_tracking_read`, then the viewer's team scope is
`timeclock._visible_emails` (administrators and unrestricted HR = everyone;
scoped HR = their companies) joined with `my_team.team_members` (the
reporting line).

Retention: raw pings older than 90 days are purged by the daily reminders job
(timeclock.purge_old_track_pings) - web pings included.
"""
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import NexusEmployee, TimePunch, TrackConsent, TrackPing, TrackSession
from routers import timeclock as tc

router = APIRouter(prefix="/timeclock/location-trail", tags=["timeclock"])

PING_EVERY_SEC = 300        # the browser's cadence (~5 min)
MIN_GAP_SEC = 120           # server-side floor between two stored web pings
LIVE_WINDOW_MIN = 15        # "live" = a ping heard within this many minutes


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _last_punch(db: Session, email: str):
    return (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc(), TimePunch.created_at.desc()).first())


def shift_state(last) -> str:
    """working | on_break | off - from the person's latest punch."""
    if not last or last.kind == "out" or tc._stale_open_shift(last):
        return "off"
    return "on_break" if last.kind == "break_start" else "working"


def _consent_revoked(db: Session, email: str) -> bool:
    newest = (db.query(TrackConsent).filter(TrackConsent.employee_email == email)
              .order_by(TrackConsent.created_at.desc()).first())
    return bool(newest and not newest.granted)


def _coord(v, lim: float) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and -lim <= f <= lim else None


def viewer_scope(db: Session, user: dict):
    """None = everyone; otherwise the set of emails this viewer may read."""
    from routers.my_team import team_members
    vis = tc._visible_emails(db, user)
    if vis is None:
        return None
    me = (user.get("email") or "").lower()
    return {e.lower() for e in vis} | set(team_members(db, user)) | {me}


def _names(db: Session, emails) -> dict:
    emails = sorted({(e or "").lower() for e in emails if e})
    if not emails:
        return {}
    out = {}
    for e in (db.query(NexusEmployee)
              .filter(func.lower(NexusEmployee.work_email).in_(emails)).all()):
        nm = ((getattr(e, "display_name", "") or "").strip()
              or f"{e.first_name or ''} {e.last_name or ''}".strip())
        out[(e.work_email or "").lower()] = nm
    return {em: out.get(em) or em.split("@")[0].replace(".", " ").title() for em in emails}


# ── Write: one ping from the signed-in browser ───────────────────────────────

class WebPingIn(BaseModel):
    lat: str
    lng: str
    accuracy_m: Optional[int] = 0
    tz_offset_min: Optional[int] = 0


@router.post("/ping")
def web_ping(body: WebPingIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Store one location sample for the caller while they are clocked in.
    Anything that does not qualify answers 200 with `stored: 0` and a
    `skipped` reason, so a stale tab never shows an error."""
    email = (user.get("email") or "").lower()
    if not tc._location_trail_on(db, email):
        return {"stored": 0, "skipped": "off"}
    state = shift_state(_last_punch(db, email))
    if state == "off":
        tc.close_track_session(db, email, "clock_out")
        db.commit()
        return {"stored": 0, "skipped": "not_clocked_in"}
    if state == "on_break":
        return {"stored": 0, "skipped": "on_break"}
    if _consent_revoked(db, email):
        return {"stored": 0, "skipped": "consent_revoked"}
    lat, lng = _coord(body.lat, 90), _coord(body.lng, 180)
    if lat is None or lng is None:
        raise HTTPException(400, "A location needs a latitude and a longitude.")
    now = _now()
    recent = (db.query(TrackPing.id)
              .filter(TrackPing.employee_email == email, TrackPing.source == "web",
                      TrackPing.received_at >= _iso(now - timedelta(seconds=MIN_GAP_SEC))).first())
    if recent:
        return {"stored": 0, "skipped": "too_soon"}
    sess = tc._open_session(db, email)
    if sess is None:
        consent = tc._live_consent(db, email)
        sess = TrackSession(id=str(uuid.uuid4()), employee_email=email, device_id="web",
                            consent_id=consent.id if consent else "",
                            started_at=_iso(now), created_at=_iso(now))
        db.add(sess)
        db.flush()
    acc = max(0, min(100000, int(body.accuracy_m or 0)))
    at = _iso(now)
    geo = tc._geofence(db, str(lat), str(lng), acc, email=email)
    db.add(TrackPing(id=str(uuid.uuid4()), session_id=sess.id, employee_email=email,
                     at=at, received_at=at, local_date=tc._local_date(at, body.tz_offset_min or 0),
                     lat=str(lat)[:24], lng=str(lng)[:24], accuracy_m=acc, battery_pct=-1,
                     source="web", **geo))
    db.commit()
    return {"stored": 1, "intervalSec": PING_EVERY_SEC}


# ── Read: live positions and one person's day ────────────────────────────────

@router.get("/live")
def trail_live(user: dict = Depends(tc.require_tracking_read), db: Session = Depends(get_db)):
    """The newest ping of everyone in the viewer's scope who is clocked in now
    and was heard from in the last LIVE_WINDOW_MIN minutes (web or phone)."""
    scope = viewer_scope(db, user)
    cutoff = _iso(_now() - timedelta(minutes=LIVE_WINDOW_MIN))
    q = db.query(TrackPing).filter(TrackPing.received_at >= cutoff, TrackPing.lat != "", TrackPing.lng != "")
    if scope is not None:
        q = q.filter(TrackPing.employee_email.in_(sorted(scope)))
    newest = {}
    for p in q.all():
        cur = newest.get(p.employee_email)
        if cur is None or p.at > cur.at:
            newest[p.employee_email] = p
    names = _names(db, newest)
    crew = []
    for em, p in newest.items():
        state = shift_state(_last_punch(db, em))
        if state == "off":
            continue
        crew.append({
            "email": em, "name": names.get(em, em),
            "lat": p.lat, "lng": p.lng, "accuracyM": p.accuracy_m or 0, "at": p.at,
            "geoStatus": p.geo_status or "no_location", "workSiteName": p.work_site_name or "",
            "distanceM": p.distance_m or 0, "batteryPct": p.battery_pct if p.battery_pct is not None else -1,
            "source": p.source or "", "onBreak": state == "on_break",
        })
    crew.sort(key=lambda c: (c["name"].lower(), c["email"]))
    return {"crew": crew, "windowMin": LIVE_WINDOW_MIN}


@router.get("/day")
def trail_day(email: str = "", date: str = "", user: dict = Depends(tc.require_tracking_read),
              db: Session = Depends(get_db)):
    """One person's breadcrumb for one local date, with that day's punches so
    the map can plot clock in / break / clock out on the same trail, inside the
    viewer's team scope."""
    me = (user.get("email") or "").lower()
    target = (email or "").strip().lower() or me
    try:
        datetime.strptime(date or "", "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a day.")
    if target != me:
        scope = viewer_scope(db, user)
        if scope is not None and target not in scope:
            raise HTTPException(403, "Not in your team")
    pings = (db.query(TrackPing)
             .filter(TrackPing.employee_email == target, TrackPing.local_date == date)
             .order_by(TrackPing.at).all())
    punches = (db.query(TimePunch)
               .filter(TimePunch.employee_email == target, TimePunch.local_date == date,
                       TimePunch.voided == 0)
               .order_by(TimePunch.at).all())
    return {
        "email": target, "name": _names(db, [target]).get(target, target), "date": date,
        "points": [{"at": p.at, "lat": p.lat, "lng": p.lng, "accuracyM": p.accuracy_m or 0,
                    "geoStatus": p.geo_status or "no_location", "workSiteName": p.work_site_name or "",
                    "source": p.source or ""} for p in pings if p.lat and p.lng],
        "punches": [{"at": p.at, "kind": p.kind, "lat": p.lat or "", "lng": p.lng or "",
                     "geoStatus": p.geo_status or "no_location", "workSiteName": p.work_site_name or ""}
                    for p in punches],
    }
