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

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_level_or_module, require_administrator
from models import TimePunch, TimeScreenshot, TimeOffRequest, TimeApproval, HrWorkSite, NexusEmployee
from routers.hr import _hr_notify, _storage_headers, _SUPABASE_URL, _DOC_BUCKET
from routers.esign import _client_meta

router = APIRouter(prefix="/timeclock", tags=["timeclock"])

# Managers (level 3+) OR anyone granted the HR module can review the team.
require_team_read = require_level_or_module(3, "hr", "viewer")
require_team_write = require_level_or_module(3, "hr", "editor")


def _visible_emails(db: Session, user: dict):
    """Team-data scope. None = whole company (administrators, or anyone holding
    an HR-module grant). A plain level-3/4 manager sees only their DIRECT
    reports (manager_email == them) plus themself — the Manager Dashboard view."""
    from auth import _module_level
    if user.get("level", 0) >= 4 or _module_level(user["email"], "hr", db) >= 1:
        return None
    directs = {(e.work_email or "").lower() for e in db.query(NexusEmployee)
               .filter(NexusEmployee.manager_email == user["email"]).all() if e.work_email}
    directs.add(user["email"])
    return directs

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
    acc = max(0, int(accuracy_m or 0))
    base = {"work_site_id": site.id, "work_site_name": site.name or "", "distance_m": int(round(d))}
    # Desktops have no GPS: browsers triangulate from Wi-Fi/IP and can be
    # kilometres off with a huge reported accuracy. Crediting that in full
    # would let a coarse fix "pass" any fence, so the credit is capped at
    # 150 m, and past ±500 m the fix can't be judged at all → low_accuracy
    # (recorded, neutral — phones give GPS fixes and judge normally).
    if acc > 500:
        return {**base, "geo_status": "low_accuracy"}
    effective = max(0.0, d - min(acc, 150))
    return {**base, "geo_status": "in_fence" if effective <= radius else "out_of_fence"}


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

def _team_rows(db: Session, start: str, end: str, only_emails=None) -> list:
    q = db.query(TimePunch).filter(TimePunch.voided == 0)
    if only_emails is not None:
        q = q.filter(TimePunch.employee_email.in_(only_emails))
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
    rows = _team_rows(db, start, end, only_emails=_visible_emails(db, user))
    # Approve-then-export status for this exact period, per employee
    approvals = {a.employee_email: a for a in db.query(TimeApproval)
                 .filter(TimeApproval.period_start == start, TimeApproval.period_end == end,
                         TimeApproval.revoked == 0).all()}
    for r in rows:
        a = approvals.get(r["email"])
        r["approval"] = ({"id": a.id, "by": a.approved_by, "at": a.approved_at,
                          "workedMin": a.worked_min} if a else None)
    return {"rows": rows}


class ApprovalIn(BaseModel):
    email: str
    start: str
    end: str
    note: Optional[str] = ""


@router.post("/approvals")
def approve_timecard(body: ApprovalIn, user: dict = Depends(require_team_write),
                     db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and email not in scope:
        raise HTTPException(403, "You can only approve your own team's timecards.")
    existing = (db.query(TimeApproval)
                .filter(TimeApproval.employee_email == email,
                        TimeApproval.period_start == body.start,
                        TimeApproval.period_end == body.end,
                        TimeApproval.revoked == 0).first())
    if existing:
        raise HTTPException(409, "Already approved for this period")
    worked = sum(d["workedMin"] for d in _day_summaries(
        _live_punches(db, email, body.start, body.end)).values())
    now = _now_iso()
    row = TimeApproval(id=str(uuid.uuid4()), employee_email=email,
                       period_start=body.start, period_end=body.end,
                       worked_min=worked, approved_by=user["email"], approved_at=now,
                       note=(body.note or "").strip()[:300])
    db.add(row)
    _hr_notify(db, email, "Timecard approved",
               f"Your hours for {body.start} → {body.end} ({worked // 60}h {worked % 60:02d}m) "
               f"were approved for payroll.",
               ref_id=row.id, action={"view": "timeclock", "sub": ""})
    db.commit()
    return {"id": row.id, "by": row.approved_by, "at": row.approved_at, "workedMin": worked}


@router.patch("/approvals/{approval_id}")
def revoke_approval(approval_id: str, user: dict = Depends(require_team_write),
                    db: Session = Depends(get_db)):
    row = db.query(TimeApproval).filter(TimeApproval.id == approval_id).first()
    if not row:
        raise HTTPException(404, "Approval not found")
    row.revoked = 1
    row.revoked_by = user["email"]
    db.commit()
    return {"ok": True}


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
    scope = _visible_emails(db, user)
    if scope is not None and row.employee_email not in scope:
        raise HTTPException(403, "You can only adjust your own team's punches.")
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
    scope = _visible_emails(db, user)
    if scope is not None and body.employee_email.strip().lower() not in scope:
        raise HTTPException(403, "You can only add punches for your own team.")
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
    scope = _visible_emails(db, user)
    rows = _team_rows(db, start, end, only_emails=scope)
    if mode == "punches":
        w.writerow(["Employee", "Email", "Local Date", "Kind", "Time (UTC)", "Original Time",
                    "Geofence", "Site", "Distance (m)", "Accuracy (m)", "Source", "Note",
                    "Adjusted By", "Voided"])
        q = db.query(TimePunch)
        if scope is not None:
            q = q.filter(TimePunch.employee_email.in_(scope))
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
        approved = {a.employee_email for a in db.query(TimeApproval)
                    .filter(TimeApproval.period_start == start, TimeApproval.period_end == end,
                            TimeApproval.revoked == 0).all()}
        w.writerow(["Employee", "Email", "Date", "First In", "Last Out",
                    "Worked Hours", "Break Minutes", "Flags", "Approved"])
        for r in rows:
            for date in sorted(r["days"]):
                d = r["days"][date]
                w.writerow([r["name"], r["email"], date,
                            d["firstIn"][11:16] if d["firstIn"] else "",
                            d["lastOut"][11:16] if d["lastOut"] else "",
                            f"{d['workedMin'] / 60:.2f}", d["breakMin"],
                            " ".join(d["flags"]), ""])
            w.writerow([r["name"], r["email"], "TOTAL", "", "",
                        f"{r['workedMin'] / 60:.2f}", r["breakMin"], "",
                        "yes" if r["email"] in approved else "no"])
    buf.seek(0)
    fname = f"timeclock-{mode}-{start or 'all'}-to-{end or 'now'}.csv"
    return StreamingResponse(iter([buf.getvalue()]),
                             media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={fname}"})


# ── Work-session screenshots (consent-based screen capture) ──────────────────
# The browser can only capture after the user explicitly picks their screen in
# the OS dialog, and it shows a persistent "sharing" indicator — transparency
# is enforced by the platform, which is also what monitoring law expects.

def _clocked_in(db: Session, email: str) -> bool:
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    return bool(last and last.kind != "out")


@router.post("/screenshot")
def upload_screenshot(request: Request, file: UploadFile = File(...),
                      idle_sec: int = Form(0), active_view: str = Form(""),
                      tz_offset_min: int = Form(0),
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"]
    if not _clocked_in(db, email):
        raise HTTPException(409, "Not clocked in — capture stops with the shift.")
    blob = file.file.read()
    if not blob or len(blob) > 2_000_000:
        raise HTTPException(400, "Screenshot missing or larger than 2 MB")
    now = _now_iso()
    path = f"timeclock/{email}/{_local_date(now, tz_offset_min)}/{now.replace(':', '-')}-{uuid.uuid4().hex[:6]}.jpg"
    up = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                    headers={**_storage_headers(), "Content-Type": "image/jpeg"},
                    content=blob, timeout=30)
    if not up.is_success:
        raise HTTPException(502, f"Storage upload failed: {up.text[:200]}")
    row = TimeScreenshot(id=str(uuid.uuid4()), employee_email=email, at=now,
                         local_date=_local_date(now, tz_offset_min), storage_path=path,
                         idle_sec=max(0, int(idle_sec or 0)),
                         active_view=(active_view or "")[:120], created_at=now)
    db.add(row)
    db.commit()
    return {"ok": True, "id": row.id}


def _signed_url(path: str) -> str:
    try:
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{path}",
                       headers=_storage_headers(), json={"expiresIn": 3600}, timeout=20)
        if r.is_success:
            return f"{_SUPABASE_URL}/storage/v1{r.json().get('signedURL', '')}"
    except Exception:
        pass
    return ""


@router.get("/screenshots")
def list_screenshots(date: str = "", email: str = "",
                     user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Admin gallery. Without an email: per-person counts for the day. With one:
    the frames themselves, each with a fresh signed URL."""
    day = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    q = db.query(TimeScreenshot).filter(TimeScreenshot.local_date == day)
    if not email:
        counts = {}
        for s in q.all():
            counts[s.employee_email] = counts.get(s.employee_email, 0) + 1
        names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
                 for e in db.query(NexusEmployee).all() if e.work_email}
        return {"date": day, "people": [
            {"email": em, "name": names.get(em) or em.split("@")[0].replace(".", " ").title(), "count": n}
            for em, n in sorted(counts.items())]}
    rows = q.filter(TimeScreenshot.employee_email == email.strip().lower()) \
            .order_by(TimeScreenshot.at).all()
    return {"date": day, "email": email, "shots": [
        {"id": s.id, "at": s.at, "idleSec": s.idle_sec or 0, "activeView": s.active_view or "",
         "url": _signed_url(s.storage_path)} for s in rows]}


# ── Time off (leave requests inside the Time module) ─────────────────────────

TIMEOFF_TYPES = ("vacation", "sick", "personal", "unpaid", "other")


def _ser_timeoff(r: TimeOffRequest, names: dict = None) -> dict:
    return {"id": r.id, "email": r.employee_email,
            "name": (names or {}).get(r.employee_email, ""),
            "type": r.type, "startDate": r.start_date, "endDate": r.end_date,
            "note": r.note or "", "status": r.status, "approver": r.approver or "",
            "decidedAt": r.decided_at or "", "decideNote": r.decide_note or "",
            "createdAt": r.created_at}


class TimeOffIn(BaseModel):
    type: str
    start_date: str
    end_date: str
    note: Optional[str] = ""


@router.post("/timeoff")
def request_timeoff(body: TimeOffIn, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if body.type not in TIMEOFF_TYPES:
        raise HTTPException(400, f"type must be one of {TIMEOFF_TYPES}")
    try:
        s = datetime.strptime(body.start_date, "%Y-%m-%d")
        e = datetime.strptime(body.end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Dates must be YYYY-MM-DD")
    if e < s:
        raise HTTPException(400, "End date is before the start date")
    now = _now_iso()
    row = TimeOffRequest(id=str(uuid.uuid4()), employee_email=user["email"], type=body.type,
                         start_date=body.start_date, end_date=body.end_date,
                         note=(body.note or "").strip()[:400], created_at=now)
    db.add(row)
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == user["email"]).first()
    if emp and emp.manager_email:
        _hr_notify(db, emp.manager_email, "Time-off request",
                   f"{emp.first_name} {emp.last_name} requested {body.type} "
                   f"{body.start_date} → {body.end_date}.",
                   ref_id=row.id, action={"view": "hr", "sub": "hr-time"})
    db.commit()
    return _ser_timeoff(row)


@router.get("/timeoff/mine")
def my_timeoff(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(TimeOffRequest).filter(TimeOffRequest.employee_email == user["email"])
            .order_by(TimeOffRequest.created_at.desc()).limit(50).all())
    return [_ser_timeoff(r) for r in rows]


@router.get("/timeoff")
def list_timeoff(status: str = "", user: dict = Depends(require_team_read),
                 db: Session = Depends(get_db)):
    q = db.query(TimeOffRequest)
    scope = _visible_emails(db, user)
    if scope is not None:
        q = q.filter(TimeOffRequest.employee_email.in_(scope))
    if status:
        q = q.filter(TimeOffRequest.status == status)
    rows = q.order_by(TimeOffRequest.created_at.desc()).limit(300).all()
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    return [_ser_timeoff(r, names) for r in rows]


class TimeOffDecision(BaseModel):
    status: str                      # approved | rejected
    note: Optional[str] = ""


@router.patch("/timeoff/{req_id}")
def decide_timeoff(req_id: str, body: TimeOffDecision,
                   user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    if body.status not in ("approved", "rejected"):
        raise HTTPException(400, "status must be approved or rejected")
    row = db.query(TimeOffRequest).filter(TimeOffRequest.id == req_id).first()
    if not row:
        raise HTTPException(404, "Request not found")
    scope = _visible_emails(db, user)
    if scope is not None and row.employee_email not in scope:
        raise HTTPException(403, "You can only decide your own team's requests.")
    if row.status != "pending":
        raise HTTPException(409, f"Already {row.status}")
    row.status = body.status
    row.approver = user["email"]
    row.decided_at = _now_iso()
    row.decide_note = (body.note or "").strip()[:400]
    _hr_notify(db, row.employee_email, f"Time off {body.status}",
               f"Your {row.type} request {row.start_date} → {row.end_date} was {body.status}."
               + (f" Note: {row.decide_note}" if row.decide_note else ""),
               ref_id=row.id, action={"view": "timeclock", "sub": ""})
    db.commit()
    return _ser_timeoff(row)
