"""Time tracking — punch in/out with geofencing (SwipeClock replacement).

Design decisions are research-backed (Jul 2026 deep-research pass):
- SOFT gate: out-of-fence punches are recorded and flagged for review, never
  blocked. Hard gates fight browser geolocation (desktops return coarse
  Wi-Fi/IP fixes) — BuddyPunch only sustains blocking by requiring a native app.
- Accuracy credit (verbatim SwipeClock behavior): a punch counts as in-fence
  when distance − reported_accuracy ≤ site radius, so GPS drift doesn't create
  false flags.
- Intelligent clock: the API tells the client which punch kinds are currently
  valid; the server enforces the same state machine.
- Missed punches are detect-surface-correct: employees may backfill their own
  gap (flagged source=self_manual), managers may add/adjust/void with a full
  audit trail (original_at frozen, voided rows retained).
- NO rounding (exact minutes are always wage-and-hour-safe) and NO automatic
  break deduction — breaks exist only as explicit punches. Compliance items
  (WA/OR break policy, retention windows) are open questions for counsel.
"""
import csv
import io
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_level_or_module
from models import TimePunch, HrWorkSite, NexusEmployee
from routers.hr import _hr_notify
from routers.esign import _client_meta

router = APIRouter(prefix="/timeclock", tags=["timeclock"])

# Managers (level 3+) OR anyone granted the HR module can review the team.
require_team_read = require_level_or_module(3, "hr", "viewer")
require_team_write = require_level_or_module(3, "hr", "editor")

KINDS = ("in", "out", "break_start", "break_end")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse_iso(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _local_date(utc_iso: str, tz_offset_min: int) -> str:
    """JS getTimezoneOffset(): UTC − local, so local = UTC − offset."""
    dt = _parse_iso(utc_iso) or datetime.now(timezone.utc)
    return (dt - timedelta(minutes=tz_offset_min)).strftime("%Y-%m-%d")


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _geofence(db: Session, lat, lng, accuracy_m: int) -> dict:
    """Nearest geofenced work site + soft-gate verdict with accuracy credit."""
    try:
        plat, plng = float(lat), float(lng)
    except (TypeError, ValueError):
        return {"geo_status": "no_location", "work_site_id": "", "work_site_name": "", "distance_m": 0}
    best = None
    for s in db.query(HrWorkSite).all():
        try:
            slat, slng = float(s.latitude), float(s.longitude)
        except (TypeError, ValueError):
            continue  # site has no geofence coordinates
        d = _haversine_m(plat, plng, slat, slng)
        if best is None or d < best[0]:
            best = (d, s)
    if best is None:
        # No geofenced sites configured at all — location recorded, nothing to judge
        return {"geo_status": "no_location", "work_site_id": "", "work_site_name": "", "distance_m": 0}
    d, site = best
    radius = max(25, int(site.radius_m or 150))
    effective = max(0.0, d - max(0, int(accuracy_m or 0)))  # accuracy credit
    return {
        "geo_status": "in_fence" if effective <= radius else "out_of_fence",
        "work_site_id": site.id,
        "work_site_name": site.name or "",
        "distance_m": int(round(d)),
    }


def _allowed_kinds(last_kind: Optional[str]) -> list:
    """The intelligent-clock state machine (shared with the client)."""
    if last_kind in (None, "out"):
        return ["in"]
    if last_kind in ("in", "break_end"):
        return ["out", "break_start"]
    return ["break_end", "out"]  # on break — punching out implicitly ends it


def _serialize(p: TimePunch) -> dict:
    return {
        "id": p.id, "email": p.employee_email, "kind": p.kind, "at": p.at,
        "originalAt": p.original_at or "", "localDate": p.local_date,
        "tzOffsetMin": p.tz_offset_min or 0,
        "lat": p.lat or "", "lng": p.lng or "", "accuracyM": p.accuracy_m or 0,
        "geoStatus": p.geo_status, "workSiteId": p.work_site_id or "",
        "workSiteName": p.work_site_name or "", "distanceM": p.distance_m or 0,
        "source": p.source, "note": p.note or "",
        "adjustedBy": p.adjusted_by or "", "adjustedAt": p.adjusted_at or "",
        "adjustNote": p.adjust_note or "", "voided": bool(p.voided),
        "createdBy": p.created_by or "", "createdAt": p.created_at,
    }


def _live_punches(db: Session, email: str, start: str = "", end: str = ""):
    q = db.query(TimePunch).filter(TimePunch.employee_email == email, TimePunch.voided == 0)
    if start:
        q = q.filter(TimePunch.local_date >= start)
    if end:
        q = q.filter(TimePunch.local_date <= end)
    return q.order_by(TimePunch.at).all()


def _day_summaries(punches: list) -> dict:
    """local_date -> {workedMin, breakMin, firstIn, lastOut, flags, punches}.
    Exact minutes, no rounding. Unclosed pairs are flagged, never guessed."""
    days = {}
    for p in punches:
        days.setdefault(p.local_date, []).append(p)
    out = {}
    for date, plist in days.items():
        worked = 0.0
        brk = 0.0
        flags = []
        open_in = None
        open_break = None
        first_in = last_out = ""
        for p in plist:  # already ordered by `at`
            t = _parse_iso(p.at)
            if t is None:
                continue
            if p.geo_status == "out_of_fence":
                flags.append("out_of_fence")
            if p.source in ("manual", "self_manual"):
                flags.append("manual")
            if p.adjusted_by:
                flags.append("adjusted")
            if p.kind == "in":
                if open_in is not None:
                    flags.append("double_in")
                open_in = t
                first_in = first_in or p.at
            elif p.kind == "out":
                if open_break is not None:  # punching out while on break ends it
                    brk += (t - open_break).total_seconds() / 60
                    open_break = None
                if open_in is None:
                    flags.append("out_without_in")
                else:
                    worked += (t - open_in).total_seconds() / 60
                    open_in = None
                last_out = p.at
            elif p.kind == "break_start":
                if open_break is None and open_in is not None:
                    open_break = t
            elif p.kind == "break_end":
                if open_break is not None:
                    brk += (t - open_break).total_seconds() / 60
                    open_break = None
        if open_in is not None:
            flags.append("missing_out")
        out[date] = {
            "workedMin": int(round(max(0.0, worked - brk))),
            "breakMin": int(round(brk)),
            "firstIn": first_in, "lastOut": last_out,
            "flags": sorted(set(flags)),
            "punches": [_serialize(p) for p in plist],
        }
    return out


# ── Employee endpoints ────────────────────────────────────────────────────────

class PunchIn(BaseModel):
    kind: str
    lat: Optional[str] = ""
    lng: Optional[str] = ""
    accuracy_m: Optional[int] = 0
    tz_offset_min: Optional[int] = 0
    note: Optional[str] = ""


@router.get("/status")
def my_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"]
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_start = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    summaries = _day_summaries(_live_punches(db, email, start=week_start))
    sites = [{"id": s.id, "name": s.name} for s in db.query(HrWorkSite).all()
             if (s.latitude or "").strip() and (s.longitude or "").strip()]
    return {
        "lastPunch": _serialize(last) if last else None,
        "allowed": _allowed_kinds(last.kind if last else None),
        "days": summaries,
        "todayUtc": today,
        "geofencedSites": sites,
    }


@router.post("/punch")
def punch(body: PunchIn, request: Request,
          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {KINDS}")
    email = user["email"]
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    allowed = _allowed_kinds(last.kind if last else None)
    if body.kind not in allowed:
        raise HTTPException(409, f"Can't punch '{body.kind}' right now — allowed: {', '.join(allowed)}")
    now = _now_iso()
    # Double-tap guard: an identical punch within 60s is a duplicate, not intent
    if last and last.kind == body.kind:
        prev = _parse_iso(last.at)
        if prev and (datetime.now(timezone.utc) - prev).total_seconds() < 60:
            raise HTTPException(409, "Duplicate punch — you just did that.")
    geo = _geofence(db, body.lat, body.lng, body.accuracy_m or 0)
    if not (body.lat or "").strip():
        geo = {"geo_status": "no_location", "work_site_id": "", "work_site_name": "", "distance_m": 0}
    ip, ua = _client_meta(request)
    row = TimePunch(id=str(uuid.uuid4()), employee_email=email, kind=body.kind, at=now,
                    local_date=_local_date(now, body.tz_offset_min or 0),
                    tz_offset_min=body.tz_offset_min or 0,
                    lat=(body.lat or "").strip()[:24], lng=(body.lng or "").strip()[:24],
                    accuracy_m=max(0, int(body.accuracy_m or 0)),
                    note=(body.note or "").strip()[:300],
                    ip=ip, user_agent=ua, source="web",
                    created_by=email, created_at=now, **geo)
    db.add(row)
    # Soft-gate escalation: flag lands with the employee's manager (bell only)
    if geo["geo_status"] == "out_of_fence" and body.kind == "in":
        emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
        if emp and emp.manager_email:
            _hr_notify(db, emp.manager_email, "Out-of-fence punch",
                       f"{emp.first_name} {emp.last_name} punched in {geo['distance_m']}m from "
                       f"{geo['work_site_name'] or 'the nearest site'} — flagged for review.",
                       ref_id=row.id, action={"view": "hr", "sub": "hr-time"})
    db.commit()
    return {"punch": _serialize(row), "allowed": _allowed_kinds(body.kind)}


class SelfPunchIn(BaseModel):
    kind: str
    at: str                      # UTC ISO — the missed moment
    tz_offset_min: Optional[int] = 0
    note: str                    # required: why the punch was missed


@router.post("/punch/manual")
def self_manual_punch(body: SelfPunchIn, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Detect-surface-correct: an employee backfills a punch they missed. Always
    flagged (source=self_manual) so managers review it — never silent."""
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {KINDS}")
    t = _parse_iso(body.at)
    if t is None:
        raise HTTPException(400, "at must be an ISO timestamp")
    if t > datetime.now(timezone.utc):
        raise HTTPException(400, "A missed punch can't be in the future.")
    if t < datetime.now(timezone.utc) - timedelta(days=7):
        raise HTTPException(400, "Older than 7 days — ask a manager to add it.")
    if not (body.note or "").strip():
        raise HTTPException(400, "Add a short note explaining the missed punch.")
    now = _now_iso()
    row = TimePunch(id=str(uuid.uuid4()), employee_email=user["email"], kind=body.kind,
                    at=body.at[:19], local_date=_local_date(body.at, body.tz_offset_min or 0),
                    tz_offset_min=body.tz_offset_min or 0, geo_status="no_location",
                    note=body.note.strip()[:300], source="self_manual",
                    created_by=user["email"], created_at=now)
    db.add(row)
    db.commit()
    return _serialize(row)


@router.get("/me")
def my_timesheet(start: str = "", end: str = "",
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"days": _day_summaries(_live_punches(db, user["email"], start, end))}


# ── Manager / HR endpoints ────────────────────────────────────────────────────

def _team_rows(db: Session, start: str, end: str) -> list:
    q = db.query(TimePunch).filter(TimePunch.voided == 0)
    if start:
        q = q.filter(TimePunch.local_date >= start)
    if end:
        q = q.filter(TimePunch.local_date <= end)
    by_emp = {}
    for p in q.order_by(TimePunch.at).all():
        by_emp.setdefault(p.employee_email, []).append(p)
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    rows = []
    for email, plist in sorted(by_emp.items()):
        days = _day_summaries(plist)
        rows.append({
            "email": email,
            "name": names.get(email) or email.split("@")[0].replace(".", " ").title(),
            "workedMin": sum(d["workedMin"] for d in days.values()),
            "breakMin": sum(d["breakMin"] for d in days.values()),
            "flagCount": sum(len(d["flags"]) for d in days.values()),
            "days": days,
        })
    return rows


@router.get("/team")
def team_timesheet(start: str = "", end: str = "",
                   user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return {"rows": _team_rows(db, start, end)}


class PunchAdjust(BaseModel):
    at: Optional[str] = None
    note: Optional[str] = None
    void: Optional[bool] = None
    adjust_note: Optional[str] = ""


@router.patch("/punches/{punch_id}")
def adjust_punch(punch_id: str, body: PunchAdjust,
                 user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    row = db.query(TimePunch).filter(TimePunch.id == punch_id).first()
    if not row:
        raise HTTPException(404, "Punch not found")
    if body.at is not None:
        t = _parse_iso(body.at)
        if t is None:
            raise HTTPException(400, "at must be an ISO timestamp")
        if not row.original_at:            # freeze the original exactly once
            row.original_at = row.at
        row.at = body.at[:19]
        row.local_date = _local_date(row.at, row.tz_offset_min or 0)
    if body.note is not None:
        row.note = body.note.strip()[:300]
    if body.void is not None:
        row.voided = 1 if body.void else 0
    row.adjusted_by = user["email"]
    row.adjusted_at = _now_iso()
    if body.adjust_note:
        row.adjust_note = body.adjust_note.strip()[:300]
    db.commit()
    return _serialize(row)


class ManagerPunchIn(BaseModel):
    employee_email: str
    kind: str
    at: str
    tz_offset_min: Optional[int] = 0
    note: Optional[str] = ""


@router.post("/punches")
def manager_add_punch(body: ManagerPunchIn, user: dict = Depends(require_team_write),
                      db: Session = Depends(get_db)):
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {KINDS}")
    if _parse_iso(body.at) is None:
        raise HTTPException(400, "at must be an ISO timestamp")
    now = _now_iso()
    row = TimePunch(id=str(uuid.uuid4()), employee_email=body.employee_email.strip().lower(),
                    kind=body.kind, at=body.at[:19],
                    local_date=_local_date(body.at, body.tz_offset_min or 0),
                    tz_offset_min=body.tz_offset_min or 0, geo_status="no_location",
                    note=(body.note or "").strip()[:300], source="manual",
                    created_by=user["email"], created_at=now)
    db.add(row)
    db.commit()
    return _serialize(row)


@router.get("/export.csv")
def export_csv(start: str = "", end: str = "", mode: str = "summary",
               user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Payroll export file, SwipeClock-style: Summary Totals (one row per
    employee-day) or All Punch Details. Exact times, no rounding."""
    buf = io.StringIO()
    w = csv.writer(buf)
    rows = _team_rows(db, start, end)
    if mode == "punches":
        w.writerow(["Employee", "Email", "Local Date", "Kind", "Time (UTC)", "Original Time",
                    "Geofence", "Site", "Distance (m)", "Accuracy (m)", "Source", "Note",
                    "Adjusted By", "Voided"])
        q = db.query(TimePunch)
        if start:
            q = q.filter(TimePunch.local_date >= start)
        if end:
            q = q.filter(TimePunch.local_date <= end)
        names = {r["email"]: r["name"] for r in rows}
        for p in q.order_by(TimePunch.employee_email, TimePunch.at).all():
            w.writerow([names.get(p.employee_email, p.employee_email), p.employee_email,
                        p.local_date, p.kind, p.at, p.original_at or "",
                        p.geo_status, p.work_site_name or "", p.distance_m or 0,
                        p.accuracy_m or 0, p.source, p.note or "",
                        p.adjusted_by or "", "yes" if p.voided else ""])
    else:
        w.writerow(["Employee", "Email", "Date", "First In", "Last Out",
                    "Worked Hours", "Break Minutes", "Flags"])
        for r in rows:
            for date in sorted(r["days"]):
                d = r["days"][date]
                w.writerow([r["name"], r["email"], date,
                            d["firstIn"][11:16] if d["firstIn"] else "",
                            d["lastOut"][11:16] if d["lastOut"] else "",
                            f"{d['workedMin'] / 60:.2f}", d["breakMin"],
                            " ".join(d["flags"])])
            w.writerow([r["name"], r["email"], "TOTAL", "", "",
                        f"{r['workedMin'] / 60:.2f}", r["breakMin"], ""])
    buf.seek(0)
    fname = f"timeclock-{mode}-{start or 'all'}-to-{end or 'now'}.csv"
    return StreamingResponse(iter([buf.getvalue()]),
                             media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={fname}"})
