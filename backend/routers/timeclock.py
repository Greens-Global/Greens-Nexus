"""Time tracking - punch in/out with geofencing (SwipeClock replacement).

Design decisions are research-backed (Jul 2026 deep-research pass):
- SOFT gate: out-of-fence punches are recorded and flagged for review, never
  blocked. Hard gates fight browser geolocation (desktops return coarse
  Wi-Fi/IP fixes) - BuddyPunch only sustains blocking by requiring a native app.
- Accuracy credit (verbatim SwipeClock behavior): a punch counts as in-fence
  when distance − reported_accuracy ≤ site radius, so GPS drift doesn't create
  false flags.
- Intelligent clock: the API tells the client which punch kinds are currently
  valid; the server enforces the same state machine.
- Missed punches are detect-surface-correct: employees may backfill their own
  gap (flagged source=self_manual), managers may add/adjust/void with a full
  audit trail (original_at frozen, voided rows retained).
- NO rounding (exact minutes are always wage-and-hour-safe) and NO automatic
  break deduction - breaks exist only as explicit punches. Compliance items
  (WA/OR break policy, retention windows) are open questions for counsel.
"""
import csv
import hashlib
import io
import json
import math
import secrets
import uuid
from datetime import datetime, timedelta, timezone, date
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_level_or_module, require_administrator
from models import (TimePunch, TimeScreenshot, TimeOffRequest, TimeApproval, TimeBod,
                    AgentDevice, Shift, ShiftGroup, ShiftGroupMember,
                    ShiftAssignment, ScheduledShift, PayrollRate, HrWorkSite, NexusEmployee,
                    TrackConsent, TrackSession, TrackPing, MonitoringPolicy, MonitoringConsent,
                    PunchRequest, AgentActivity, AppRating, NexusGroup, NexusGroupMember,
                    NexusSetting, NexusNotification)
from routers.hr import _hr_notify, _storage_headers, _SUPABASE_URL, _DOC_BUCKET, sync_comp_from_rate
from routers.esign import _client_meta
from routers.stepup import require_stepup

router = APIRouter(prefix="/timeclock", tags=["timeclock"])

# Managers (level 3+) OR anyone granted the HR module can review the team.
require_team_read = require_level_or_module(3, "hr", "viewer")
require_team_write = require_level_or_module(3, "hr", "editor")


def _visible_emails(db: Session, user: dict):
    """Team-data scope. None = whole company (administrators, or anyone holding
    an HR-module grant). A plain level-3/4 manager sees only their DIRECT
    reports (manager_email == them) plus themself - the Manager Dashboard view."""
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
        # No geofenced sites configured at all - location recorded, nothing to judge
        return {"geo_status": "no_location", "work_site_id": "", "work_site_name": "", "distance_m": 0}
    d, site = best
    radius = max(25, int(site.radius_m or 150))
    acc = max(0, int(accuracy_m or 0))
    base = {"work_site_id": site.id, "work_site_name": site.name or "", "distance_m": int(round(d))}
    # Desktops have no GPS: browsers triangulate from Wi-Fi/IP and can be
    # kilometres off with a huge reported accuracy. Crediting that in full
    # would let a coarse fix "pass" any fence, so the credit is capped at
    # 150 m, and past ±500 m the fix can't be judged at all → low_accuracy
    # (recorded, neutral - phones give GPS fixes and judge normally).
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
    return ["break_end", "out"]  # on break - punching out implicitly ends it


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
        # Employee self-edit awaiting approval. pendingAt is the PROPOSED time; `at`
        # (above) is still the pay-effective time until the edit is approved.
        "pendingAt": p.pending_at or "", "editStatus": p.edit_status or "",
        "editReason": p.edit_reason or "", "editedBy": p.edited_by or "",
        "editedAt": p.edited_at or "", "editReviewedBy": p.edit_reviewed_by or "",
    }


def _live_punches(db: Session, email: str, start: str = "", end: str = ""):
    q = db.query(TimePunch).filter(TimePunch.employee_email == email, TimePunch.voided == 0)
    if start:
        q = q.filter(TimePunch.local_date >= start)
    if end:
        q = q.filter(TimePunch.local_date <= end)
    return q.order_by(TimePunch.at).all()


def _day_summaries(punches: list, round_min: int = 0) -> dict:
    """local_date -> {workedMin, breakMin, firstIn, lastOut, flags, punches}.
    When round_min>0 each punch is rounded to the nearest round_min minutes before
    the worked-minute math, so approve / finalize / timesheet totals match the
    rounded PAY engine (_compute_timecard) - the number attested and approved is
    the number paid. Pass 0 for exact minutes. Pairs across the FULL sequence (not
    per calendar day) so an overnight shift - in one night, out the next morning -
    counts as one segment on the day it STARTED. Unclosed pairs are flagged."""
    by_day = {}
    for p in punches:
        by_day.setdefault(p.local_date, []).append(p)

    worked = {}   # in-day -> raw minutes
    brk    = {}   # in-day -> break minutes
    flags  = {}   # local_date -> set (per-punch flags on their own day)
    first_in = {} # local_date -> first in `at`
    last_out = {} # local_date -> last out `at`

    def flag(d, f):
        flags.setdefault(d, set()).add(f)

    open_in = open_in_date = open_break = None
    open_brk = 0.0
    for p in punches:  # already ordered by `at`
        t = _parse_iso(p.at)
        if t is None:
            continue
        if round_min:
            t = _round_punch(t, round_min)
        d = p.local_date
        if p.geo_status == "out_of_fence":
            flag(d, "out_of_fence")
        if p.source in ("manual", "self_manual"):
            flag(d, "manual")
        if p.adjusted_by:
            flag(d, "adjusted")
        if p.edit_status == "pending":
            flag(d, "edit_pending")
        if p.kind == "in":
            if open_in is not None:
                flag(open_in_date, "missing_out")   # prior shift never closed
            open_in, open_in_date, open_break, open_brk = t, d, None, 0.0
            if d not in first_in:
                first_in[d] = p.at
        elif p.kind == "out":
            if open_break is not None:              # punching out while on break ends it
                open_brk += (t - open_break).total_seconds() / 60
                open_break = None
            if open_in is None:
                flag(d, "out_without_in")
            else:
                # A closed pair spanning 12+ hours is almost always a forgotten
                # punch-out (Jul 27: a Sat 02:31 in / Mon 20:59 out landed 66h on
                # Saturday). Flag it so the timesheet and approver see it loudly.
                if (t - open_in).total_seconds() >= 12 * 3600:
                    flag(open_in_date, "unusually_long")
                worked[open_in_date] = worked.get(open_in_date, 0.0) + (t - open_in).total_seconds() / 60
                brk[open_in_date] = brk.get(open_in_date, 0.0) + open_brk
                open_in = None
            last_out[d] = p.at
        elif p.kind == "break_start":
            if open_break is None and open_in is not None:
                open_break = t
        elif p.kind == "break_end":
            if open_break is not None:
                open_brk += (t - open_break).total_seconds() / 60
                open_break = None
    if open_in is not None:
        flag(open_in_date, "missing_out")
        brk[open_in_date] = brk.get(open_in_date, 0.0) + open_brk

    out = {}
    for d, plist in by_day.items():
        w = worked.get(d, 0.0)
        b = brk.get(d, 0.0)
        out[d] = {
            "workedMin": int(round(max(0.0, w - b))),
            "breakMin": int(round(b)),
            "firstIn": first_in.get(d, ""), "lastOut": last_out.get(d, ""),
            "flags": sorted(flags.get(d, set())),
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
def my_status(tz_offset_min: int = 0, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"]
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_start = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    summaries = _day_summaries(_live_punches(db, email, start=week_start))
    sites = [{"id": s.id, "name": s.name} for s in db.query(HrWorkSite).all()
             if (s.latitude or "").strip() and (s.longitude or "").strip()]
    # Beginning-of-day message is required before the first punch-in of the day:
    # true only until either the BOD is posted or an in-punch already exists today.
    local_today = _local_date(_now_iso(), tz_offset_min)
    has_bod = (db.query(TimeBod)
               .filter(TimeBod.employee_email == email, TimeBod.kind == "bod",
                       TimeBod.local_date == local_today).first())
    has_in = (db.query(TimePunch)
              .filter(TimePunch.employee_email == email, TimePunch.kind == "in",
                      TimePunch.local_date == local_today, TimePunch.voided == 0).first())
    pol = _get_policy(db)
    return {
        "lastPunch": _serialize(last) if last else None,
        "allowed": _allowed_kinds(last.kind if last else None),
        "days": summaries,
        "todayUtc": today,
        "geofencedSites": sites,
        "bodRequired": has_bod is None and has_in is None,
        # Monitoring disclosure: the widget/agent read this to know whether to
        # capture. Exempt members (leadership) are never captured.
        "monitoring": (lambda exempt: {
            **_policy_dict(pol),
            "exempt": exempt,
            # Exempt people are not captured - force the capture flags off for them
            # so the widget offers no screen-share and clock-in isn't gated on one.
            **({"trackScreens": False, "trackWindows": False, "trackInput": False} if exempt else {}),
            # Daily acknowledge gate removed Jul 24 (see punch endpoint note);
            # field kept False for client compatibility.
            "consentRequired": False,
            "textVersion": _MONITORING_TEXT_VERSION,
            "text": _MONITORING_NOTICE,
        })(_is_monitoring_exempt(db, email)),
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
        raise HTTPException(409, f"Can't punch '{body.kind}' right now - allowed: {', '.join(allowed)}")
    now = _now_iso()
    # Jul 24: the daily acknowledge-at-clock-in gate was removed by management
    # decision - screen capture is initiated by the employee's own share action
    # (browser picker + persistent OS sharing indicator), and standing disclosure
    # lives in the signed monitoring policy, not a daily pop-up. The
    # /monitoring/consent endpoint and MonitoringConsent rows remain for the
    # historical record and in case the gate is ever reinstated.
    # Double-tap guard: an identical punch within 60s is a duplicate, not intent
    if last and last.kind == body.kind:
        prev = _parse_iso(last.at)
        if prev and (datetime.now(timezone.utc) - prev).total_seconds() < 60:
            raise HTTPException(409, "Duplicate punch - you just did that.")
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
                       f"{geo['work_site_name'] or 'the nearest site'} - flagged for review.",
                       ref_id=row.id, action={"view": "hr", "sub": "hr-time"})
    # First punch-in → offer the Beginning-of-day message; punch-out → offer the
    # End-of-day message (each skipped automatically once recorded that day).
    first_in_today = False
    prompt_eod = False
    if body.kind == "in":
        prior_in = (db.query(TimePunch)
                    .filter(TimePunch.employee_email == email, TimePunch.kind == "in",
                            TimePunch.local_date == row.local_date,
                            TimePunch.id != row.id, TimePunch.voided == 0).first())
        bod_done = (db.query(TimeBod)
                    .filter(TimeBod.employee_email == email, TimeBod.kind == "bod",
                            TimeBod.local_date == row.local_date).first())
        first_in_today = prior_in is None and bod_done is None
    elif body.kind == "out":
        eod_done = (db.query(TimeBod)
                    .filter(TimeBod.employee_email == email, TimeBod.kind == "eod",
                            TimeBod.local_date == row.local_date).first())
        prompt_eod = eod_done is None
        close_track_session(db, email, "clock_out")  # tracking never outlives the shift
    db.commit()
    return {"punch": _serialize(row), "allowed": _allowed_kinds(body.kind),
            "firstInToday": first_in_today, "promptEod": prompt_eod}


class SelfPunchIn(BaseModel):
    kind: str
    at: str                      # UTC ISO - the missed moment
    tz_offset_min: Optional[int] = 0
    note: str                    # required: why the punch was missed


@router.post("/punch/manual")
def self_manual_punch(body: SelfPunchIn, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Detect-surface-correct: an employee backfills a punch they missed. Always
    flagged (source=self_manual) so managers review it - never silent."""
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {KINDS}")
    t = _parse_iso(body.at)
    if t is None:
        raise HTTPException(400, "at must be an ISO timestamp")
    if t > datetime.now(timezone.utc):
        raise HTTPException(400, "A missed punch can't be in the future.")
    if t < datetime.now(timezone.utc) - timedelta(days=7):
        raise HTTPException(400, "Older than 7 days - ask a manager to add it.")
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
    return {"days": _day_summaries(_live_punches(db, user["email"], start, end), _round_min(db))}


# ── Manager / HR endpoints ────────────────────────────────────────────────────

def _team_rows(db: Session, start: str, end: str, only_emails=None) -> list:
    rmin = _round_min(db)   # round like the pay engine so review == paid
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
        days = _day_summaries(plist, rmin)
        rows.append({
            "email": email,
            "name": names.get(email) or email.split("@")[0].replace(".", " ").title(),
            "workedMin": sum(d["workedMin"] for d in days.values()),
            "breakMin": sum(d["breakMin"] for d in days.values()),
            "flagCount": sum(len(d["flags"]) for d in days.values()),
            # Pending employee time-edits waiting on this approver - so the team list
            # flags who needs review without the approver opening every timecard.
            "pendingEdits": sum(1 for p in plist if p.edit_status == "pending" and p.pending_at),
            "days": days,
        })
    return rows


@router.get("/team")
def team_timesheet(start: str = "", end: str = "",
                   user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    rows = _team_rows(db, start, end, only_emails=_visible_emails(db, user))
    # Legacy whole-range approvals (kept for old rows) …
    approvals = {a.employee_email: a for a in db.query(TimeApproval)
                 .filter(TimeApproval.period_start == start, TimeApproval.period_end == end,
                         TimeApproval.revoked == 0).all()}
    # … plus per-DAY approvals (period_start == period_end). An approval goes
    # STALE the moment any punch on that day is added or adjusted after it -
    # a signed-off day must never silently change underneath the signature.
    day_apps = (db.query(TimeApproval)
                .filter(TimeApproval.revoked == 0,
                        TimeApproval.period_start == TimeApproval.period_end,
                        TimeApproval.period_start >= (start or "0"),
                        TimeApproval.period_end <= (end or "9")).all())
    last_change: dict = {}
    pq = db.query(TimePunch).filter(TimePunch.voided == 0)
    if start:
        pq = pq.filter(TimePunch.local_date >= start)
    if end:
        pq = pq.filter(TimePunch.local_date <= end)
    for p in pq.all():
        k = (p.employee_email, p.local_date)
        ch = max(p.created_at or "", p.adjusted_at or "")
        if ch > last_change.get(k, ""):
            last_change[k] = ch
    for r in rows:
        m = {}
        for a in day_apps:
            if a.employee_email != r["email"]:
                continue
            m[a.period_start] = {
                "id": a.id, "by": a.approved_by, "at": a.approved_at,
                "workedMin": a.worked_min,
                "stale": last_change.get((a.employee_email, a.period_start), "") > (a.approved_at or ""),
            }
        r["dayApprovals"] = m
        a = approvals.get(r["email"])
        r["approval"] = ({"id": a.id, "by": a.approved_by, "at": a.approved_at,
                          "workedMin": a.worked_min,
                          "stale": any(v > (a.approved_at or "")
                                       for (em, _d), v in last_change.items() if em == r["email"])}
                         if a else None)
    return {"rows": rows}


def _finalized_row(db: Session, email: str, d_start: str, d_end: str = ""):
    """The non-revoked HR FINALIZATION covering [d_start, d_end or d_start] -
    a finalized period is LOCKED: no punch edits, adds, voids, or re-approvals
    until HR unlocks it. Mirrors SwipeClock's '(finalized)' periods."""
    return (db.query(TimeApproval)
            .filter(TimeApproval.employee_email == email,
                    TimeApproval.revoked == 0,
                    TimeApproval.kind == "final",
                    TimeApproval.period_start <= d_start,
                    TimeApproval.period_end >= (d_end or d_start))
            .first())


def _guard_not_finalized(db: Session, email: str, d_start: str, d_end: str = ""):
    if _finalized_row(db, email, d_start, d_end):
        raise HTTPException(403, "This pay period is finalized and locked. Ask HR to unlock it before changing time records.")


class ApprovalIn(BaseModel):
    email: str
    start: str = ""
    end: str = ""
    days: Optional[List[str]] = None     # per-day mode: approve these dates
    note: Optional[str] = ""


@router.post("/approvals")
def approve_timecard(body: ApprovalIn, user: dict = Depends(require_team_write),
                     db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and email not in scope:
        raise HTTPException(403, "You can only approve your own team's timecards.")
    if body.days:
        for _d in body.days:
            _guard_not_finalized(db, email, _d)
    elif body.start and body.end:
        _guard_not_finalized(db, email, body.start, body.end)
    now = _now_iso()

    # ── Per-day mode: one approval row per date; re-approving a changed day
    # replaces the stale row (the old one stays, revoked, for audit). ──
    if body.days:
        days = sorted({d for d in body.days if d})
        out = {}
        for day in days:
            # Fetch through the NEXT day too, so an overnight shift's out-punch is
            # available to pair with this day's in-punch - otherwise the locked-in
            # approved minutes would be short by the whole after-midnight portion.
            _nx = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
            worked = _day_summaries(_live_punches(db, email, day, _nx), _round_min(db)).get(day, {}).get("workedMin", 0)
            old = (db.query(TimeApproval)
                   .filter(TimeApproval.employee_email == email,
                           TimeApproval.period_start == day, TimeApproval.period_end == day,
                           TimeApproval.revoked == 0).first())
            if old:
                old.revoked = 1
                old.revoked_by = user["email"]
            row = TimeApproval(id=str(uuid.uuid4()), employee_email=email,
                               period_start=day, period_end=day, worked_min=worked,
                               approved_by=user["email"], approved_at=now,
                               note=(body.note or "").strip()[:300])
            db.add(row)
            out[day] = {"id": row.id, "by": row.approved_by, "at": now,
                        "workedMin": worked, "stale": False}
        total = sum(v["workedMin"] for v in out.values())
        label = days[0] if len(days) == 1 else f"{days[0]} → {days[-1]} ({len(days)} days)"
        _hr_notify(db, email, "Timecard approved",
                   f"Your hours for {label} ({total // 60}h {total % 60:02d}m) were approved for payroll.",
                   action={"view": "timeclock", "sub": ""})
        db.commit()
        return {"days": out}

    # ── Legacy whole-range mode ──
    existing = (db.query(TimeApproval)
                .filter(TimeApproval.employee_email == email,
                        TimeApproval.period_start == body.start,
                        TimeApproval.period_end == body.end,
                        TimeApproval.revoked == 0,
                        # ONLY a prior MANAGER approval blocks re-approval - the employee's
                        # own signature and the HR finalization share this table + period
                        # bounds (kind 'employee_sign' / 'final') and must not count.
                        TimeApproval.kind == "manager").first())
    if existing:
        raise HTTPException(409, "Already approved for this period")
    # Fetch one day past `end` so a shift that starts on the last day and ends
    # after midnight still pairs; only count days within [start, end] so the
    # extra day's own shifts don't inflate the total.
    _end_nx = (date.fromisoformat(body.end) + timedelta(days=1)).isoformat() if body.end else body.end
    worked = sum(v["workedMin"] for k, v in _day_summaries(
        _live_punches(db, email, body.start, _end_nx), _round_min(db)).items()
        if not body.end or k <= body.end)
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
    work_site_id: Optional[str] = None   # reassign the punch's location (curated work site); "" clears it
    category: Optional[str] = None       # job-costing / cost-code tag on the punch


def _signoff_state(db: Session, email: str, start: str, end: str) -> dict:
    """Both sign-off levels for one employee-period, for the timecard header:
    the manager approval (kind 'manager' / legacy NULL) and the HR finalization."""
    rows = (db.query(TimeApproval)
            .filter(TimeApproval.employee_email == email, TimeApproval.revoked == 0,
                    TimeApproval.period_start == start, TimeApproval.period_end == end).all())
    # Latest punch change in the period. A sign-off older than this is STALE - the
    # hours changed after it was signed/approved/finalized, so it must not read as
    # a clean sign-off on the current numbers.
    last_change = ""
    for p in (db.query(TimePunch)
              .filter(TimePunch.employee_email == email, TimePunch.voided == 0,
                      TimePunch.local_date >= start, TimePunch.local_date <= end).all()):
        ch = max(p.created_at or "", p.adjusted_at or "")
        if ch > last_change:
            last_change = ch
    approval = finalized = signed = None
    for r in rows:
        d = {"by": r.approved_by, "at": r.approved_at, "workedMin": r.worked_min,
             "stale": bool(last_change and last_change > (r.approved_at or ""))}
        k = r.kind or "manager"
        if k == "final":
            finalized = d          # note holds the rate/rule snapshot, not a name
        elif k == "employee_sign":
            d["name"] = r.note or ""   # employee-sign stores the signer's name in note
            signed = d
        else:
            approval = d
    return {"approval": approval, "finalized": finalized, "signed": signed}


class SignTimecardIn(BaseModel):
    start: str = ""     # pay-period start (Sunday); omit for the current period


@router.post("/my-timecard/sign")
def sign_my_timecard(body: SignTimecardIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Employee attests their OWN timecard for the period - records their name and a
    timestamp (electronic sign-off). Reuses TimeApproval with kind='employee_sign'.
    Re-signing replaces the prior signature (e.g. after a correction). A later punch
    change makes the signature go stale (see _team_rows / the timecard header)."""
    email = user["email"]
    anchor = (body.start or "").strip() or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Fixed-salary employees sign their MONTH; hourly sign the bi-weekly period. The
    # sign row must be keyed to the same bounds the card's sign-off state checks.
    if _pay_type(db, email) == "fixed":
        anchor = (body.start or "").strip() or _employee_today(db, email)
        p_start, p_end = _month_bounds(anchor)
        worked = _fixed_card(db, email, anchor).get("totals", {}).get("workedMin", 0)
    else:
        p_start, p_end = _pay_period(anchor)
        worked = _compute_timecard(db, email, p_start, p_end).get("totals", {}).get("workedMin", 0)
    for r in (db.query(TimeApproval)
              .filter(TimeApproval.employee_email == email, TimeApproval.period_start == p_start,
                      TimeApproval.period_end == p_end, TimeApproval.kind == "employee_sign",
                      TimeApproval.revoked == 0).all()):
        r.revoked = 1
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    name = f"{emp.first_name} {emp.last_name}".strip() if emp else email.split("@")[0].replace(".", " ").title()
    row = TimeApproval(id=str(uuid.uuid4()), employee_email=email, period_start=p_start, period_end=p_end,
                       worked_min=worked, approved_by=email, approved_at=_now_iso(),
                       kind="employee_sign", note=name)
    db.add(row)
    db.commit()
    return {"signed": {"by": email, "name": name, "at": row.approved_at, "workedMin": worked}}


class FinalizeIn(BaseModel):
    email: str
    start: str
    end: str


@router.post("/finalize")
def finalize_timecard(body: FinalizeIn, user: dict = Depends(require_administrator),
                      db: Session = Depends(get_db)):
    """HR's second-level sign-off (SwipeClock 'finalize'): locks the period -
    punch edits/adds/approvals 403 until /unfinalize. Admin-only by design:
    managers approve, HR finalizes."""
    email = body.email.strip().lower()
    if not body.start or not body.end:
        raise HTTPException(400, "start and end are required")
    if _finalized_row(db, email, body.start, body.end):
        raise HTTPException(409, "Already finalized for this period")
    _end_nx = (date.fromisoformat(body.end) + timedelta(days=1)).isoformat()
    # Freeze the pay rate + OT rule as of finalize, so a later change can't
    # re-price this locked, paid period (see _compute_timecard).
    _rr = db.query(PayrollRate).filter(PayrollRate.employee_email == email).first()
    _is_fixed = ((getattr(_rr, "pay_type", None) or "hourly") == "fixed") if _rr else False
    _fixed_snap = {}
    if _is_fixed:
        # PIN the whole fixed result as-of-finalize: statuses key off "today", so a
        # month finalized mid-month would otherwise re-price as its days elapse.
        _ft = _fixed_card(db, email, body.start).get("totals", {})
        worked = _ft.get("workedMin", 0)   # unrounded - matches the fixed card + the sign
        _fixed_snap = {k: _ft.get(k) for k in ("totalPay", "deduction", "weekendBonus",
                       "missedFullDays", "missedHalfDays", "weekendDaysWorked")}
    else:
        worked = sum(v["workedMin"] for k, v in _day_summaries(
            _live_punches(db, email, body.start, _end_nx), _round_min(db)).items() if k <= body.end)
    # Snapshot BOTH pay models so neither an hourly rate nor a fixed salary can
    # retro-price this locked, paid period after a later change (see
    # _compute_timecard and _fixed_card, which read this back for finalized periods).
    _snap = json.dumps({"rate": float(_rr.hourly_rate) if _rr else 0.0,
                        "rule": (getattr(_rr, "overtime_rule", None) or "ca") if _rr else "ca",
                        "payType": (getattr(_rr, "pay_type", None) or "hourly") if _rr else "hourly",
                        "currency": (getattr(_rr, "currency", None) or "USD") if _rr else "USD",
                        "monthlySalary": float(getattr(_rr, "monthly_salary", 0) or 0) if _rr else 0.0,
                        "weekendOtAmount": float(getattr(_rr, "weekend_ot_amount", 0) or 0) if _rr else 0.0,
                        "fullDayHours": float(getattr(_rr, "full_day_hours", 8) or 8) if _rr else 8.0,
                        **_fixed_snap})
    row = TimeApproval(id=str(uuid.uuid4()), employee_email=email,
                       period_start=body.start, period_end=body.end, worked_min=worked,
                       approved_by=user["email"], approved_at=_now_iso(), kind="final",
                       note=_snap)
    db.add(row)
    # Signed snapshot for the employee's record - the finalized hours plus all three
    # signatures (their own, the manager's approval, this HR finalization). The
    # just-added finalize row isn't flushed yet, so it's passed in explicitly.
    _so = _signoff_state(db, email, body.start, body.end)

    def _sig(s, label, by="", at=""):
        by = (s.get("by") if s else "") or by
        at = (s.get("at") if s else "") or at
        if not at:
            return f"{label} (not signed)"
        who = (s.get("name") if s else "") or by.split("@")[0].replace(".", " ").title()
        return f"{label} {who} ({at[:10]})"

    _sigs = "; ".join([
        _sig(_so.get("signed"), "signed by"),
        _sig(_so.get("approval"), "approved by"),
        _sig(None, "finalized by", user["email"], row.approved_at),
    ])
    _hr_notify(db, email, "Timecard finalized",
               f"Your timecard {body.start} – {body.end} is finalized for payroll "
               f"({worked // 60}h {worked % 60:02d}m) and locked. Signatures: {_sigs}.",
               action={"view": "timeclock", "sub": "timecard"})
    db.commit()
    return {"finalized": {"by": row.approved_by, "at": row.approved_at, "workedMin": worked}}


@router.post("/unfinalize")
def unfinalize_timecard(body: FinalizeIn, user: dict = Depends(require_administrator),
                        db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    row = (db.query(TimeApproval)
           .filter(TimeApproval.employee_email == email, TimeApproval.revoked == 0,
                   TimeApproval.kind == "final",
                   TimeApproval.period_start == body.start,
                   TimeApproval.period_end == body.end).first())
    if not row:
        raise HTTPException(404, "No finalization found for this period")
    row.revoked = 1
    row.revoked_by = user["email"]
    db.commit()
    return {"unfinalized": True}


@router.patch("/punches/{punch_id}")
def adjust_punch(punch_id: str, body: PunchAdjust,
                 user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    row = db.query(TimePunch).filter(TimePunch.id == punch_id).first()
    if not row:
        raise HTTPException(404, "Punch not found")
    scope = _visible_emails(db, user)
    if scope is not None and row.employee_email not in scope:
        raise HTTPException(403, "You can only adjust your own team's punches.")
    _guard_not_finalized(db, row.employee_email, row.local_date)
    if body.at is not None:
        t = _parse_iso(body.at)
        if t is None:
            raise HTTPException(400, "at must be an ISO timestamp")
        if not row.original_at:            # freeze the original exactly once
            row.original_at = row.at
        row.at = body.at[:19]
        row.local_date = _local_date(row.at, row.tz_offset_min or 0)
    if body.work_site_id is not None:
        # Reassign the punch's location to a curated work site (manager correction).
        wsid = body.work_site_id.strip()
        if not wsid:
            row.work_site_id, row.work_site_name, row.geo_status = "", "", "no_location"
        else:
            site = db.query(HrWorkSite).filter(HrWorkSite.id == wsid).first()
            if not site:
                raise HTTPException(404, "Work site not found")
            # A manager asserting the site counts as on-site (in_fence), distance 0.
            row.work_site_id, row.work_site_name = site.id, site.name or ""
            row.geo_status, row.distance_m = "in_fence", 0
    if body.category is not None:
        row.category = body.category.strip()[:80]
    if body.note is not None:
        row.note = body.note.strip()[:300]
    if body.void is not None:
        row.voided = 1 if body.void else 0
    row.adjusted_by = user["email"]
    row.adjusted_at = _now_iso()
    if body.adjust_note:
        row.adjust_note = body.adjust_note.strip()[:300]
    # Tell the employee their timecard was changed on their behalf - transparency,
    # and symmetric with the employee-edit -> approver flow. Skip a manager editing
    # their own punch (no self-notification).
    if row.employee_email != user["email"]:
        _hr_notify(db, row.employee_email, "Timecard corrected",
                   f"Your {row.kind.replace('_', ' ')} punch on {row.local_date} was corrected by a manager"
                   + (f": {body.adjust_note.strip()[:200]}" if body.adjust_note else ".")
                   + " - open your timecard to review.",
                   ref_id=row.id, action={"view": "timeclock", "sub": "timecard"})
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
    _guard_not_finalized(db, body.employee_email.strip().lower(),
                         _local_date(body.at, body.tz_offset_min or 0))
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
               user: dict = Depends(require_team_read),
               _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    """Payroll export file (incl. $ pay columns) - requires a fresh step-up MFA
    (require_stepup). Summary Totals (one row per employee-day) or All Punch
    Details. Exact times, no rounding."""
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
        # Per-day approvals: date column shows yes/no; the TOTAL row is "yes"
        # only when the whole range is signed off (legacy range row OR every
        # worked day individually approved).
        day_ok = {(a.employee_email, a.period_start) for a in db.query(TimeApproval)
                  .filter(TimeApproval.revoked == 0,
                          TimeApproval.period_start == TimeApproval.period_end,
                          TimeApproval.period_start >= (start or "0"),
                          TimeApproval.period_end <= (end or "9")).all()}
        w.writerow(["Employee", "Email", "Date", "First In", "Last Out",
                    "Worked Hours", "Regular Hours", "OT Hours (1.5x)", "DT Hours (2x)",
                    "Break Minutes", "Flags", "OT Rule", "Rate $/hr",
                    "Regular Pay", "OT Pay", "DT Pay", "Total Pay", "Approved"])
        for r in rows:
            # Use the overtime engine (respects each person's ca/federal/none rule)
            # for the reg/OT/DT split + pay; first-in/last-out/flags come from the
            # day summary already loaded.
            card = _compute_timecard(db, r["email"], start, end)
            cday = {d["date"]: d for d in card["days"]}
            T = card["totals"]
            rate = card["rate"]
            for date in sorted(r["days"]):
                d = r["days"][date]
                cd = cday.get(date, {})
                w.writerow([r["name"], r["email"], date,
                            d["firstIn"][11:16] if d["firstIn"] else "",
                            d["lastOut"][11:16] if d["lastOut"] else "",
                            f"{cd.get('workedMin', d['workedMin']) / 60:.2f}",
                            f"{cd.get('regMin', 0) / 60:.2f}", f"{cd.get('otMin', 0) / 60:.2f}",
                            f"{cd.get('dtMin', 0) / 60:.2f}", d["breakMin"],
                            " ".join(d["flags"]), "", "", "", "", "",
                            "yes" if (r["email"], date) in day_ok else ""])
            all_days_ok = bool(r["days"]) and all((r["email"], dt) in day_ok for dt in r["days"])
            w.writerow([r["name"], r["email"], "TOTAL", "", "",
                        f"{T['workedMin'] / 60:.2f}", f"{T['regMin'] / 60:.2f}",
                        f"{T['otMin'] / 60:.2f}", f"{T['dtMin'] / 60:.2f}", T["breakMin"], "",
                        card["overtimeRule"], f"{rate:.2f}",
                        f"{T['regPay']:.2f}", f"{T['otPay']:.2f}", f"{T['dtPay']:.2f}", f"{T['totalPay']:.2f}",
                        "yes" if (r["email"] in approved or all_days_ok) else "no"])
    buf.seek(0)
    fname = f"timeclock-{mode}-{start or 'all'}-to-{end or 'now'}.csv"
    return StreamingResponse(iter([buf.getvalue()]),
                             media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={fname}"})


# ── Work-session screenshots (consent-based screen capture) ──────────────────
# The browser can only capture after the user explicitly picks their screen in
# the OS dialog, and it shows a persistent "sharing" indicator - transparency
# is enforced by the platform, which is also what monitoring law expects.

def _clocked_in(db: Session, email: str) -> bool:
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    return bool(last and last.kind != "out")


# ── Monitoring policy + per-shift consent (DISCLOSED design) ──────────────────
# The desktop agent captures screenshots/activity while clocked in. Two rules make
# that disclosed rather than covert: (1) the employee acknowledges a plain-language
# notice at clock-in (MonitoringConsent), enforced server-side; (2) HOW/how-often
# is a central admin policy (MonitoringPolicy) the agent fetches, not hidden constants.

# Versioned so re-acknowledgment is forced if the wording materially changes.
_MONITORING_TEXT_VERSION = "2026-07-20"
_MONITORING_NOTICE = (
    "While you are clocked in on this company device, Nexus records periodic "
    "screenshots, the title of your active window, and an overall activity level "
    "(how much you're at the keyboard/mouse - never what you type). Capture runs "
    "only during your shift and stops the moment you clock out. Clock in to start "
    "your shift and begin monitoring."
)


def _get_policy(db: Session) -> MonitoringPolicy:
    """The single monitoring policy row, created with safe defaults on first read."""
    p = db.query(MonitoringPolicy).filter(MonitoringPolicy.id == "default").first()
    if not p:
        p = MonitoringPolicy(id="default", updated_at=_now_iso())
        db.add(p); db.commit()
    return p


def _policy_dict(p: MonitoringPolicy) -> dict:
    return {
        "enabled":         bool(p.enabled),
        "intervalMinutes": max(1, int(p.interval_minutes or 5)),
        "randomize":       bool(p.randomize),
        "trackScreens":    bool(p.track_screens),
        "trackWindows":    bool(p.track_windows),
        "trackInput":      bool(p.track_input),
    }


def _is_monitoring_exempt(db: Session, email: str) -> bool:
    """True when the person belongs to any group flagged monitoring_exempt - used
    for leadership, who clock in without sharing a screen and are not captured."""
    gids = [m.group_id for m in db.query(NexusGroupMember.group_id)
            .filter(NexusGroupMember.email == email).all()]
    if not gids:
        return False
    return db.query(NexusGroup.id).filter(
        NexusGroup.id.in_(gids), NexusGroup.monitoring_exempt == 1).first() is not None


def _has_monitoring_consent(db: Session, email: str, local_date: str) -> bool:
    return db.query(MonitoringConsent).filter(
        MonitoringConsent.employee_email == email,
        MonitoringConsent.local_date == local_date,
        MonitoringConsent.text_version == _MONITORING_TEXT_VERSION,
    ).first() is not None


def _store_shot(db: Session, email: str, blob: bytes, idle_sec: int, active_view: str, tz_offset_min: int):
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
    return row


@router.post("/screenshot")
def upload_screenshot(request: Request, file: UploadFile = File(...),
                      idle_sec: int = Form(0), active_view: str = Form(""),
                      tz_offset_min: int = Form(0),
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"]
    if not _clocked_in(db, email):
        raise HTTPException(409, "Not clocked in - capture stops with the shift.")
    pol = _get_policy(db)
    if not (pol.enabled and pol.track_screens):
        raise HTTPException(409, "Screen capture is disabled by policy.")
    if _is_monitoring_exempt(db, email):
        raise HTTPException(409, "You are exempt from screen monitoring.")
    row = _store_shot(db, email, file.file.read(), idle_sec, active_view, tz_offset_min)
    return {"ok": True, "id": row.id}


# ── Monitoring: consent + policy endpoints ────────────────────────────────────

class MonitoringConsentIn(BaseModel):
    text_version: str = ""
    tz_offset_min: Optional[int] = 0


@router.post("/monitoring/consent")
def record_monitoring_consent(body: MonitoringConsentIn, request: Request,
                              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Employee acknowledges today's monitoring notice. Records ip/ua/version so
    the disclosure is provable. Idempotent per day+version."""
    email = user["email"]
    now = _now_iso()
    local_date = _local_date(now, body.tz_offset_min or 0)
    version = (body.text_version or _MONITORING_TEXT_VERSION).strip()
    if _has_monitoring_consent(db, email, local_date):
        return {"ok": True, "alreadyRecorded": True}
    ip, ua = _client_meta(request)
    db.add(MonitoringConsent(id=str(uuid.uuid4()), employee_email=email, local_date=local_date,
                             text_version=version, granted_at=now, ip=ip, user_agent=ua, created_at=now))
    db.commit()
    return {"ok": True}


@router.get("/monitoring/policy")
def get_monitoring_policy(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Effective policy - any authenticated user (incl. the interactive agent using
    the employee's own token) may read it; it's cadence/toggles, not sensitive data."""
    return _policy_dict(_get_policy(db))


class MonitoringPolicyIn(BaseModel):
    enabled:          Optional[bool] = None
    interval_minutes: Optional[int]  = None
    randomize:        Optional[bool] = None
    track_screens:    Optional[bool] = None
    track_windows:    Optional[bool] = None
    track_input:      Optional[bool] = None


@router.put("/monitoring/policy")
def set_monitoring_policy(body: MonitoringPolicyIn, user: dict = Depends(require_administrator),
                          db: Session = Depends(get_db)):
    """Admin sets the monitoring cadence and what's collected. Central + auditable."""
    p = _get_policy(db)
    if body.enabled          is not None: p.enabled = int(body.enabled)
    if body.interval_minutes is not None: p.interval_minutes = max(1, min(60, int(body.interval_minutes)))
    if body.randomize        is not None: p.randomize = int(body.randomize)
    if body.track_screens    is not None: p.track_screens = int(body.track_screens)
    if body.track_windows    is not None: p.track_windows = int(body.track_windows)
    if body.track_input      is not None: p.track_input = int(body.track_input)
    p.updated_by, p.updated_at = user["email"], _now_iso()
    db.commit()
    return _policy_dict(p)


@router.get("/monitoring/alerts")
def monitoring_alerts(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Tamper/coverage alerts: employees who are CLOCKED IN while monitoring is on,
    but whose agent has gone quiet - the honest, visible way to catch someone
    killing/uninstalling the agent to dodge capture. Nothing is hidden; the gap is
    surfaced to their manager (team-scoped) as an attributable event. Computed from
    existing heartbeat/punch/screenshot data - no new storage."""
    pol = _get_policy(db)
    if not pol.enabled:
        return {"enabled": False, "alerts": []}
    visible = _visible_emails(db, user)   # None = whole company (admin/HR grant)
    now = datetime.now(timezone.utc)
    interval_min = max(1, int(pol.interval_minutes or 5))
    # Heartbeat is ~1/min; treat an enrolled agent as "quiet" after 5 min or two
    # capture intervals, whichever is longer. Screenshot gap uses ~2.5 intervals.
    stale_sec = max(300, interval_min * 60 * 2 + 120)
    shot_gap_sec = int(interval_min * 60 * 2.5) + 120

    # Latest punch per employee over the last 2 days → who is currently clocked in.
    since = (now - timedelta(days=2)).isoformat()
    pq = db.query(TimePunch).filter(TimePunch.voided == 0, TimePunch.at >= since)
    if visible is not None:
        if not visible:
            return {"enabled": True, "alerts": []}
        pq = pq.filter(TimePunch.employee_email.in_(visible))
    latest = {}
    for p in pq.order_by(TimePunch.at.desc()).all():
        latest.setdefault(p.employee_email, p)
    clocked = {e: p for e, p in latest.items() if p.kind != "out"}
    if not clocked:
        return {"enabled": True, "alerts": []}

    names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}

    def _age(iso):
        try:
            dt = _parse_iso(iso)
            return (now - dt).total_seconds() if dt else None
        except Exception:
            return None

    alerts = []
    for email, punch in clocked.items():
        dev = (db.query(AgentDevice)
               .filter(AgentDevice.employee_email == email, AgentDevice.revoked == 0)
               .order_by(AgentDevice.last_seen_at.desc()).first())
        last_shot = (db.query(TimeScreenshot)
                     .filter(TimeScreenshot.employee_email == email)
                     .order_by(TimeScreenshot.at.desc()).first())
        shot_age = _age(last_shot.at) if last_shot else None
        seen_age = _age(dev.last_seen_at) if (dev and dev.last_seen_at) else None

        reason = detail = None
        severity = "warning"
        if not dev:
            # Clocked in, monitoring on, but no agent is enrolled for them, and the
            # web widget hasn't sent a frame recently either → not being captured.
            if pol.track_screens and (shot_age is None or shot_age > shot_gap_sec):
                reason, severity = "No agent reporting", "high"
                detail = "Clocked in with no enrolled agent and no recent capture."
        elif seen_age is None or seen_age > stale_sec:
            reason, severity = "Agent stopped reporting", "high"
            detail = (f"Last checked in {int(seen_age // 60)} min ago."
                      if seen_age is not None else "Agent has never checked in.")
        elif pol.track_screens and (shot_age is None or shot_age > shot_gap_sec):
            reason, severity = "No recent screenshots", "warning"
            detail = (f"Agent is reporting but last frame was {int(shot_age // 60)} min ago."
                      if shot_age is not None else "Agent is reporting but no frames yet.")

        if reason:
            alerts.append({
                "email": email,
                "name": names.get(email) or email.split("@")[0].replace(".", " ").title(),
                "reason": reason, "detail": detail, "severity": severity,
                "clockedInSince": punch.at,
                "deviceName": (dev.device_name or dev.label) if dev else "",
                "lastSeenAt": dev.last_seen_at if dev else "",
                "lastShotAt": last_shot.at if last_shot else "",
            })
    # High severity first, then most-recently clocked in
    alerts.sort(key=lambda a: (a["severity"] != "high", a["clockedInSince"]), reverse=False)
    return {"enabled": True, "alerts": alerts, "checkedAt": _now_iso()}


# ── Punch-fix requests (employee asks, approver approves/rejects) ─────────────
# An employee can request to ADD a missed punch or REMOVE a wrong one. Nothing
# changes on the timesheet until an approver (HR/manager) approves - then the
# punch is created/voided with a full audit trail. Both parties are notified.

_PR_KINDS = ("in", "out", "break_start", "break_end")


def _pr_dict(r: PunchRequest) -> dict:
    return {
        "id": r.id, "employeeEmail": r.employee_email, "employeeName": r.employee_name,
        "action": r.action, "punchKind": r.punch_kind, "at": r.at, "localDate": r.local_date,
        "targetPunchId": r.target_punch_id, "reason": r.reason, "status": r.status,
        "decidedBy": r.decided_by, "decidedAt": r.decided_at, "decisionNote": r.decision_note,
        "appliedPunchId": r.applied_punch_id, "createdAt": r.created_at,
    }


class PunchRequestIn(BaseModel):
    action:         str = "add"          # add | remove
    punch_kind:     Optional[str] = "in" # for add
    at:             Optional[str] = ""   # for add: UTC ISO of the requested punch
    target_punch_id: Optional[str] = ""  # for remove
    reason:         str = ""
    tz_offset_min:  Optional[int] = 0


@router.post("/punch-requests")
def create_punch_request(body: PunchRequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"]
    reason = (body.reason or "").strip()
    if not reason:
        raise HTTPException(400, "Please give a reason so your approver can review it.")
    action = body.action if body.action in ("add", "remove") else "add"
    now = _now_iso()
    at_utc, target_id, local_date = "", "", _local_date(now, body.tz_offset_min or 0)
    if action == "add":
        if body.punch_kind not in _PR_KINDS:
            raise HTTPException(400, f"punch_kind must be one of {_PR_KINDS}")
        at_utc = (body.at or "").strip()
        _pt = _parse_iso(at_utc) if at_utc else None
        if not _pt:
            raise HTTPException(400, "Pick the date and time for the punch.")
        # Bound the requested time: a FUTURE punch becomes the "last punch"
        # (state = max(at)) and jams clock-in/out until that moment passes; a
        # very old one is almost certainly an error. (self_manual has the same
        # guards.)
        _ptz = _pt if _pt.tzinfo else _pt.replace(tzinfo=timezone.utc)
        _now_dt = datetime.now(timezone.utc)
        if _ptz > _now_dt + timedelta(minutes=5):
            raise HTTPException(400, "You can't request a punch in the future.")
        if _ptz < _now_dt - timedelta(days=45):
            raise HTTPException(400, "That date is too far back - ask HR to add it for you.")
        local_date = _local_date(at_utc, body.tz_offset_min or 0)
    else:  # remove
        target_id = (body.target_punch_id or "").strip()
        tp = db.query(TimePunch).filter(TimePunch.id == target_id,
                                        TimePunch.employee_email == email, TimePunch.voided == 0).first()
        if not tp:
            raise HTTPException(404, "That punch isn't yours or no longer exists.")
        local_date = tp.local_date
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    name = f"{emp.first_name} {emp.last_name}".strip() if emp else email.split("@")[0].replace(".", " ").title()
    req = PunchRequest(id=str(uuid.uuid4()), employee_email=email, employee_name=name,
                       action=action, punch_kind=body.punch_kind or "in", at=at_utc,
                       local_date=local_date, tz_offset_min=body.tz_offset_min or 0,
                       target_punch_id=target_id, reason=reason, status="pending", created_at=now)
    db.add(req)
    # Notify the approver - the employee's manager, or ALL managers if none is set,
    # so a no-manager employee's request still reaches someone.
    what = (f"add a {body.punch_kind} punch" if action == "add" else "remove a punch")
    _notify_approvers(db, employee_email=req.employee_email, title="Timesheet fix requested",
                      body=f"{name} asked to {what}. Reason: {reason}",
                      ref_id=req.id, action={"view": "hr", "sub": "hr-time"})
    db.commit()
    return _pr_dict(req)


@router.get("/punch-requests/mine")
def my_punch_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(PunchRequest).filter(PunchRequest.employee_email == user["email"])
            .order_by(PunchRequest.created_at.desc()).limit(50).all())
    return [_pr_dict(r) for r in rows]


@router.get("/punch-requests")
def list_punch_requests(status: str = "pending", user: dict = Depends(require_team_read),
                        db: Session = Depends(get_db)):
    """Approver review queue - team-scoped, so a manager sees only their reports'."""
    visible = _visible_emails(db, user)
    q = db.query(PunchRequest)
    if status:
        q = q.filter(PunchRequest.status == status)
    if visible is not None:
        if not visible:
            return []
        q = q.filter(PunchRequest.employee_email.in_(visible))
    return [_pr_dict(r) for r in q.order_by(PunchRequest.created_at.desc()).limit(200).all()]


class PunchRequestDecision(BaseModel):
    status: str            # approved | rejected
    note:   Optional[str] = ""


@router.patch("/punch-requests/{req_id}")
def decide_punch_request(req_id: str, body: PunchRequestDecision,
                         user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    r = db.query(PunchRequest).filter(PunchRequest.id == req_id).with_for_update().first()
    if not r:
        raise HTTPException(404, "Request not found")
    if r.status != "pending":
        raise HTTPException(409, f"This request was already {r.status}.")
    visible = _visible_emails(db, user)
    if visible is not None and r.employee_email not in visible:
        raise HTTPException(403, "That employee isn't on your team.")
    decision = body.status if body.status in ("approved", "rejected") else ""
    if not decision:
        raise HTTPException(400, "status must be approved or rejected")
    now = _now_iso()
    note = (body.note or "").strip()
    if decision == "approved":
        if r.action == "add":
            # Re-validate the sequence at approval time: inserting this punch must
            # not create an illegal transition (e.g. two 'in's with no 'out'
            # between), which would corrupt the FIFO worked-minute pairing. Check
            # the punch immediately BEFORE and AFTER the requested time.
            prev = (db.query(TimePunch)
                    .filter(TimePunch.employee_email == r.employee_email, TimePunch.voided == 0,
                            TimePunch.at <= r.at).order_by(TimePunch.at.desc()).first())
            nxt = (db.query(TimePunch)
                   .filter(TimePunch.employee_email == r.employee_email, TimePunch.voided == 0,
                           TimePunch.at > r.at).order_by(TimePunch.at.asc()).first())
            if r.punch_kind not in _allowed_kinds(prev.kind if prev else None):
                raise HTTPException(409,
                    f"Approving this would place a '{r.punch_kind}' after a "
                    f"'{prev.kind if prev else 'clock-out'}', which isn't a valid punch sequence. "
                    f"Ask the employee to correct the request, or edit the punches directly.")
            if nxt and nxt.kind not in _allowed_kinds(r.punch_kind):
                raise HTTPException(409,
                    f"Approving this '{r.punch_kind}' would make the following '{nxt.kind}' "
                    f"punch invalid. Edit the punches directly instead.")
            tp = TimePunch(id=str(uuid.uuid4()), employee_email=r.employee_email, kind=r.punch_kind,
                           at=r.at, local_date=r.local_date, tz_offset_min=r.tz_offset_min or 0,
                           geo_status="no_location", source="manual", note=r.reason[:300],
                           created_by=user["email"], created_at=now,
                           adjust_note=f"Approved punch-fix request by {user['email']}")
            db.add(tp); db.flush()
            r.applied_punch_id = tp.id
        else:  # remove → void the target punch (kept for audit, excluded from totals)
            tp = db.query(TimePunch).filter(TimePunch.id == r.target_punch_id).first()
            if tp:
                tp.voided = 1
                tp.adjusted_by = user["email"]
                tp.adjusted_at = now
                tp.adjust_note = f"Voided via approved punch-fix request. {note}".strip()
                r.applied_punch_id = tp.id
        _hr_notify(db, r.employee_email, "Timesheet fix approved",
                   f"Your request to {'add' if r.action=='add' else 'remove'} a punch was approved."
                   + (f" Note: {note}" if note else ""),
                   ref_id=r.id, action={"view": "timeclock", "sub": "timesheet"})
    else:  # rejected
        _hr_notify(db, r.employee_email, "Timesheet fix rejected",
                   f"Your request to {'add' if r.action=='add' else 'remove'} a punch was not approved."
                   + (f" Reason: {note}" if note else ""),
                   ref_id=r.id, action={"view": "timeclock", "sub": "timesheet"})
    r.status = decision
    r.decided_by, r.decided_at, r.decision_note = user["email"], now, note
    db.commit()
    return _pr_dict(r)


# ── Employee self-edit of a punch TIME (applies to display now, to pay only on
#    approval). Separate from the manager's final `adjust_punch` (PATCH /punches)
#    and from add/remove punch-requests. ────────────────────────────────────────

def _notify_approvers(db: Session, *, employee_email: str, title: str, body: str,
                      ref_id: str = "", action: Optional[dict] = None) -> None:
    """Route a timecard request to whoever approves this person: their manager if
    one is set, otherwise BROADCAST to all managers (recipient='') so it is never
    silently dropped for an employee with no manager on file."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == employee_email).first()
    mgr = (emp.manager_email or "").strip().lower() if emp else ""
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=mgr,   # '' = all managers
        title=title, body=body, ref_id=ref_id, item_name="", requested_by=employee_email,
        action=json.dumps(action) if action else "", actioned=False, read_by="",
        created_at=_now_iso()))


class PunchEditIn(BaseModel):
    punch_id: str
    at: str                       # proposed new time (UTC ISO)
    reason: Optional[str] = ""    # optional justification


@router.post("/punch-edits")
def request_punch_edit(body: PunchEditIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Employee proposes a new time for one of their OWN punches. The proposal
    shows on the timesheet immediately (both the employee and HR see the same row),
    flagged pending, but has NO effect on pay - worked-minutes keep using the
    current `at` until an approver accepts. Reason is optional."""
    email = user["email"]
    row = db.query(TimePunch).filter(TimePunch.id == body.punch_id).first()
    if not row or row.voided:
        raise HTTPException(404, "That punch isn't available.")
    if row.employee_email != email:
        raise HTTPException(403, "You can only edit your own punches.")
    _guard_not_finalized(db, row.employee_email, row.local_date)
    at = (body.at or "").strip()
    t = _parse_iso(at)
    if not t:
        raise HTTPException(400, "Pick a valid date and time.")
    _tz = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    if _tz > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise HTTPException(400, "You can't set a punch time in the future.")
    row.pending_at = at[:19]
    row.edit_reason = (body.reason or "").strip()[:300]
    row.edited_by, row.edited_at, row.edit_status = email, _now_iso(), "pending"
    row.edit_reviewed_by, row.edit_reviewed_at = "", ""
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    name = f"{emp.first_name} {emp.last_name}".strip() if emp else email.split("@")[0].replace(".", " ").title()
    _notify_approvers(db, employee_email=email, title="Timesheet edit requested",
                      body=f"{name} proposed a new time for a {row.kind} punch on {row.local_date}."
                      + (f" Reason: {row.edit_reason}" if row.edit_reason else ""),
                      ref_id=row.id, action={"view": "hr", "sub": "hr-time"})
    db.commit()
    return _serialize(row)


class PunchEditDecision(BaseModel):
    status: str                   # approved | rejected
    note: Optional[str] = ""


@router.patch("/punch-edits/{punch_id}")
def decide_punch_edit(punch_id: str, body: PunchEditDecision,
                      user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    """Approver accepts or rejects an employee's pending punch-time edit. On
    approve, the proposed time becomes the pay-effective `at` (it now counts toward
    hours). On reject, the proposal is discarded and `at` is unchanged."""
    row = db.query(TimePunch).filter(TimePunch.id == punch_id).with_for_update().first()
    if not row:
        raise HTTPException(404, "Punch not found")
    if row.edit_status != "pending" or not row.pending_at:
        raise HTTPException(409, "There is no pending edit on this punch.")
    visible = _visible_emails(db, user)
    if visible is not None and row.employee_email not in visible:
        raise HTTPException(403, "That employee isn't on your team.")
    _guard_not_finalized(db, row.employee_email, row.local_date)
    decision = body.status if body.status in ("approved", "rejected") else ""
    if not decision:
        raise HTTPException(400, "status must be approved or rejected")
    now = _now_iso()
    note = (body.note or "").strip()
    if decision == "approved":
        if not row.original_at:            # freeze the pre-edit value once
            row.original_at = row.at
        row.at = row.pending_at[:19]
        row.local_date = _local_date(row.at, row.tz_offset_min or 0)
        # Stamp the change time so any day/period approval or employee signature on
        # this day goes STALE - team_timesheet keys staleness on
        # max(created_at, adjusted_at); without this, an approved edit silently
        # changes pay under an existing sign-off.
        row.adjusted_at = now
        _hr_notify(db, row.employee_email, "Punch edit approved",
                   f"Your edited {row.kind} punch time was approved and now counts toward your hours."
                   + (f" Note: {note}" if note else ""),
                   ref_id=row.id, action={"view": "timeclock", "sub": "timesheet"})
    else:
        _hr_notify(db, row.employee_email, "Punch edit rejected",
                   f"Your edited {row.kind} punch time was not approved; your timesheet is unchanged."
                   + (f" Reason: {note}" if note else ""),
                   ref_id=row.id, action={"view": "timeclock", "sub": "timesheet"})
    row.pending_at = ""
    row.edit_status = decision
    row.edit_reviewed_by, row.edit_reviewed_at = user["email"], now
    db.commit()
    return _serialize(row)


@router.get("/punch-edits")
def list_pending_punch_edits(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Pending employee punch-time edits awaiting review, scoped to the approver's team."""
    visible = _visible_emails(db, user)
    q = db.query(TimePunch).filter(TimePunch.edit_status == "pending", TimePunch.voided == 0)
    if visible is not None:
        q = q.filter(TimePunch.employee_email.in_(visible))
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    out = []
    for p in q.order_by(TimePunch.edited_at.desc()).all():
        d = _serialize(p)
        d["employeeName"] = names.get(p.employee_email) or p.employee_email.split("@")[0].replace(".", " ").title()
        out.append(d)
    return out


# ── Silent agent enrollment (no-login, token-authenticated devices) ───────────
# The "Silent App User" model: an admin mints a device token bound to an
# employee; the install command drops it on the machine; the agent authenticates
# with X-Agent-Token instead of a Microsoft login. The token is scoped to ONLY
# the agent endpoints below - it grants no access to the rest of the API.

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def get_agent_device(request: Request, db: Session = Depends(get_db)) -> AgentDevice:
    raw = request.headers.get("X-Agent-Token", "")
    if not raw:
        raise HTTPException(401, "Missing agent token")
    dev = (db.query(AgentDevice)
           .filter(AgentDevice.token_hash == _hash_token(raw), AgentDevice.revoked == 0)
           .first())
    if not dev:
        raise HTTPException(401, "Invalid or revoked agent token")
    return dev


class EnrollIn(BaseModel):
    email: str
    label: Optional[str] = ""


@router.post("/agent/enroll")
def agent_enroll(body: EnrollIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Mint a fresh device token for an employee. The raw token is returned ONCE
    (only its hash is stored) - the portal bakes it into the install command."""
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "A valid employee email is required")
    raw = secrets.token_urlsafe(32)
    now = _now_iso()
    dev = AgentDevice(id=str(uuid.uuid4()), employee_email=email, token_hash=_hash_token(raw),
                      label=(body.label or "").strip()[:120], created_by=user["email"], created_at=now)
    db.add(dev)
    db.commit()
    return {"deviceId": dev.id, "token": raw, "email": email}


@router.get("/agent/devices")
def agent_devices(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Silent App Tracking: every enrolled computer, self-described on check-in."""
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    # Revoked devices vanish from the list (row kept for audit; token already dead).
    rows = (db.query(AgentDevice).filter(AgentDevice.revoked == 0)
            .order_by(AgentDevice.created_at.desc()).all())
    return {"devices": [{
        "id": d.id, "email": d.employee_email,
        "name": names.get(d.employee_email) or d.employee_email.split("@")[0].replace(".", " ").title(),
        "label": d.label or "", "deviceName": d.device_name or "", "deviceUser": d.device_user or "",
        "mac": d.mac or "", "platform": d.platform or "", "revoked": bool(d.revoked),
        "lastSeen": d.last_seen_at or "", "createdAt": d.created_at or "",
    } for d in rows]}


@router.patch("/agent/devices/{device_id}")
def agent_revoke(device_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    dev = db.query(AgentDevice).filter(AgentDevice.id == device_id).first()
    if not dev:
        raise HTTPException(404, "Device not found")
    dev.revoked = 1
    db.commit()
    return {"ok": True}


# ── Desktop agent: heartbeat, screenshot, app/URL activity ───────────────────
# The Nexus desktop agent authenticates with its device token (get_agent_device)
# - no employee login. It FOLLOWS the punch clock: captures + tracks only while
# the person is clocked in and NOT on break (start on in, pause on break, resume
# on break-end, stop on out). Every gate is enforced here, server-side.

def _punch_state(db: Session, email: str):
    last = (db.query(TimePunch).filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    return bool(last and last.kind != "out"), bool(last and last.kind == "break_start")


class AgentCheckinIn(BaseModel):
    device_name: Optional[str] = ""
    device_user: Optional[str] = ""
    mac: Optional[str] = ""
    platform: Optional[str] = ""
    tz_offset_min: Optional[int] = 0


@router.post("/agent/checkin")
def agent_checkin(body: AgentCheckinIn, dev: AgentDevice = Depends(get_agent_device),
                  db: Session = Depends(get_db)):
    """Heartbeat. Records the machine and tells the agent whether to capture/track
    right now - true only while clocked in, not on break, and policy-enabled."""
    dev.last_seen_at = _now_iso()
    if body.device_name: dev.device_name = body.device_name[:120]
    if body.device_user: dev.device_user = body.device_user[:120]
    if body.mac:         dev.mac = body.mac[:40]
    if body.platform:    dev.platform = body.platform[:20]
    db.commit()
    clocked, on_break = _punch_state(db, dev.employee_email)
    pol = _get_policy(db)
    live = bool(clocked and not on_break and pol.enabled)
    return {"email": dev.employee_email, "clockedIn": clocked, "onBreak": on_break,
            "capture": live,
            # Full policy object so the agent respects the real toggles + cadence
            # (applyPolicy reads this). Server still re-gates every upload anyway.
            "policy": _policy_dict(pol),
            # Flat mirrors kept for older agent builds.
            "trackScreens": live and bool(pol.track_screens),
            "trackApps": live and bool(pol.track_windows),
            "intervalMin": max(1, int(pol.interval_minutes or 5)), "randomize": bool(pol.randomize)}


@router.post("/agent/screenshot")
def agent_screenshot(request: Request, file: UploadFile = File(...),
                     idle_sec: int = Form(0), active_view: str = Form(""),
                     tz_offset_min: int = Form(0),
                     dev: AgentDevice = Depends(get_agent_device), db: Session = Depends(get_db)):
    """Screenshot from the desktop agent - identity from the token, re-gated here."""
    email = dev.employee_email
    clocked, on_break = _punch_state(db, email)
    if not clocked or on_break:
        raise HTTPException(409, "Not on a live shift - capture paused.")
    pol = _get_policy(db)
    if not (pol.enabled and pol.track_screens):
        raise HTTPException(409, "Screen capture is disabled by policy.")
    row = _store_shot(db, email, file.file.read(), idle_sec, active_view, tz_offset_min)
    return {"ok": True, "id": row.id}


class ActivitySeg(BaseModel):
    app: Optional[str] = ""
    title: Optional[str] = ""
    domain: Optional[str] = ""
    seconds: int = 0


class ActivityIn(BaseModel):
    segments: List[ActivitySeg] = []
    active_pct: int = 0
    tz_offset_min: Optional[int] = 0


@router.post("/agent/activity")
def agent_activity(body: ActivityIn, dev: AgentDevice = Depends(get_agent_device),
                   db: Session = Depends(get_db)):
    """App / website usage samples (seconds per foreground app + active domain),
    tagged with the admin productivity rating. Kept only during a live shift."""
    email = dev.employee_email
    clocked, on_break = _punch_state(db, email)
    if not clocked or on_break:
        return {"ok": True, "skipped": "not on a live shift"}
    pol = _get_policy(db)
    if not (pol.enabled and pol.track_windows):
        return {"ok": True, "skipped": "app tracking off"}
    now = _now_iso()
    ld = _local_date(now, body.tz_offset_min or 0)
    pct = max(0, min(100, int(body.active_pct or 0)))
    ratings = {r.key: r.rating for r in db.query(AppRating).all()}
    for s in body.segments[:300]:
        if not s.seconds or s.seconds <= 0:
            continue
        dom = (s.domain or "").strip().lower()[:120]
        appn = (s.app or "Unknown")[:120]
        cat = ratings.get(dom) or ratings.get(appn.lower()) or ""
        db.add(AgentActivity(id=str(uuid.uuid4()), employee_email=email, local_date=ld, at=now,
                             app=appn, title=(s.title or "")[:200], domain=dom, category=cat,
                             seconds=int(s.seconds), active_pct=pct))
    db.commit()
    return {"ok": True}


# ── Insights dashboard: Top Apps / Top Websites / activity (manager + HR) ────

@router.get("/insights")
def insights(email: str = "", start: str = "", end: str = "", tz: int = 0,
             user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Top apps, top websites, active-vs-idle, productivity split, an hourly
    activity strip and (team view) a per-member leaderboard over [start,end]. `tz`
    is the client's getTimezoneOffset() minutes - used to bucket the hourly strip
    in the viewer's local time."""
    em = (email or "").strip().lower()
    scope = _visible_emails(db, user)
    empty = {"totalSec": 0, "activeSec": 0, "idleSec": 0, "activePct": 0, "prodPct": 0,
             "topApps": [], "topSites": [], "byCategory": {"productive": 0, "neutral": 0, "unproductive": 0},
             "hourly": [{"hour": h, "activeSec": 0, "totalSec": 0} for h in range(24)],
             "byMember": [], "log": []}
    q = db.query(AgentActivity)
    if em:
        if scope is not None and em not in scope and em != user["email"].lower():
            raise HTTPException(403, "Outside your team")
        q = q.filter(AgentActivity.employee_email == em)
    elif scope is not None:
        if not scope:
            return empty
        q = q.filter(AgentActivity.employee_email.in_(scope))
    if start: q = q.filter(AgentActivity.local_date >= start)
    if end:   q = q.filter(AgentActivity.local_date <= end)
    rows = q.all()
    ratings = {r.key: r.rating for r in db.query(AppRating).all()}
    apps, sites = {}, {}
    cats = {"productive": 0, "neutral": 0, "unproductive": 0}
    hourly = [[0, 0] for _ in range(24)]   # [activeSec, totalSec] per LOCAL hour
    per_member = {}                         # email -> [total, active, productive]
    total = active = 0
    for r in rows:
        sec = r.seconds or 0
        a = int(sec * (r.active_pct or 0) / 100)
        total += sec; active += a
        apps[r.app or "Unknown"] = apps.get(r.app or "Unknown", 0) + sec
        if r.domain:
            sites[r.domain] = sites.get(r.domain, 0) + sec
        cat = r.category if r.category in cats else "neutral"
        cats[cat] += sec
        t = _parse_iso(r.at)
        if t is not None:
            lh = (t - timedelta(minutes=tz)).hour
            hourly[lh][0] += a; hourly[lh][1] += sec
        m = per_member.setdefault(r.employee_email, [0, 0, 0])
        m[0] += sec; m[1] += a
        if cat == "productive": m[2] += sec
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip() for e in db.query(NexusEmployee).all() if e.work_email}
    def pct(part): return round(part * 100 / total) if total else 0
    by_member = sorted(
        ({"email": k, "name": names.get(k, k) or k, "totalSec": v[0], "activeSec": v[1],
          "activePct": round(v[1] * 100 / v[0]) if v[0] else 0,
          "prodPct": round(v[2] * 100 / v[0]) if v[0] else 0} for k, v in per_member.items()),
        key=lambda x: -x["totalSec"])
    return {
        "totalSec": total, "activeSec": active, "idleSec": max(0, total - active),
        "activePct": pct(active), "prodPct": pct(cats["productive"]),
        "topApps": [{"name": a, "seconds": s, "pct": pct(s), "rating": ratings.get(a.lower(), "")}
                    for a, s in sorted(apps.items(), key=lambda x: -x[1])[:8]],
        "topSites": [{"name": d, "seconds": s, "pct": pct(s), "rating": ratings.get(d, "")}
                     for d, s in sorted(sites.items(), key=lambda x: -x[1])[:8]],
        "byCategory": cats,
        "hourly": [{"hour": h, "activeSec": hourly[h][0], "totalSec": hourly[h][1]} for h in range(24)],
        "byMember": by_member if not em else [],
        "log": [{"at": r.at, "name": names.get(r.employee_email, r.employee_email), "app": r.app,
                 "title": r.title, "domain": r.domain, "seconds": r.seconds, "activePct": r.active_pct,
                 "category": r.category} for r in sorted(rows, key=lambda r: r.at, reverse=True)[:80]],
    }


@router.get("/ratings")
def list_ratings(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return [{"key": r.key, "kind": r.kind, "label": r.label or r.key, "rating": r.rating}
            for r in db.query(AppRating).order_by(AppRating.key).all()]


class RatingIn(BaseModel):
    key: str
    kind: Optional[str] = "app"
    label: Optional[str] = ""
    rating: str = "neutral"


@router.put("/ratings")
def set_rating(body: RatingIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    key = (body.key or "").strip().lower()
    if not key:
        raise HTTPException(400, "key is required")
    row = db.query(AppRating).filter(AppRating.key == key).first()
    if not row:
        row = AppRating(key=key)
        db.add(row)
    row.kind = body.kind if body.kind in ("app", "domain") else "app"
    row.label = (body.label or key)[:120]
    row.rating = body.rating if body.rating in ("productive", "neutral", "unproductive") else "neutral"
    row.updated_by = user["email"]
    row.updated_at = _now_iso()
    db.commit()
    return {"ok": True, "rating": row.rating}


# ── Field-worker location tracking (native app, clocked-in only) ─────────────
# Periodic location pings across a shift for on-site crews. The phone is a
# native Capacitor app enrolled with the SAME X-Agent-Token model as the desktop
# agent (get_agent_device) - no Microsoft login on the phone. Tracking runs ONLY
# while clocked in AND only after a live consent row exists; both are enforced
# here (server-side), not merely by the device choosing to stop.

_TRACK_INTERVAL_SEC   = 300     # target ping cadence (~5 min)
_TRACK_DISTANCE_M     = 100     # …or when moved this far, whichever comes first
_TRACK_RETENTION_DAYS = 90      # raw pings purged after this window (daily job)
_TRACK_IDLE_STOP_SEC  = 1800    # a session with no ping for this long is auto-closed (idle)
_CONSENT_VERSION      = "2026-07-08"


def _live_consent(db: Session, email: str) -> Optional[TrackConsent]:
    return (db.query(TrackConsent)
            .filter(TrackConsent.employee_email == email, TrackConsent.granted == 1)
            .order_by(TrackConsent.granted_at.desc()).first())


def _open_session(db: Session, email: str) -> Optional[TrackSession]:
    return (db.query(TrackSession)
            .filter(TrackSession.employee_email == email, TrackSession.ended_at == "")
            .order_by(TrackSession.started_at.desc()).first())


def _new_session(db: Session, dev: AgentDevice) -> TrackSession:
    consent = _live_consent(db, dev.employee_email)
    now = _now_iso()
    sess = TrackSession(id=str(uuid.uuid4()), employee_email=dev.employee_email, device_id=dev.id,
                        consent_id=consent.id if consent else "", started_at=now, created_at=now)
    db.add(sess)
    db.flush()
    return sess


def close_track_session(db: Session, email: str, reason: str):
    """Close any open tracking session for an employee - called on clock-out so
    the session (which IS the shift) never outlives the shift."""
    sess = _open_session(db, email)
    if sess:
        sess.ended_at = _now_iso()
        sess.ended_reason = reason


class ConsentIn(BaseModel):
    granted: bool = True


@router.post("/track/consent")
def track_consent(body: ConsentIn, request: Request,
                  dev: AgentDevice = Depends(get_agent_device), db: Session = Depends(get_db)):
    """Record or revoke standing tracking consent for the enrolled device's
    employee. Revoking also stops any running session immediately."""
    email = dev.employee_email
    ip, ua = _client_meta(request)
    now = _now_iso()
    if body.granted:
        row = TrackConsent(id=str(uuid.uuid4()), employee_email=email, granted=1,
                           granted_at=now, text_version=_CONSENT_VERSION,
                           ip=ip, user_agent=ua, created_at=now)
        db.add(row)
        db.commit()
        return {"consentId": row.id, "granted": True, "version": _CONSENT_VERSION}
    live = _live_consent(db, email)
    if live:
        live.granted = 0
        live.revoked_at = now
    close_track_session(db, email, "manual")
    db.commit()
    return {"granted": False}


@router.get("/track/config")
def track_config(dev: AgentDevice = Depends(get_agent_device), db: Session = Depends(get_db)):
    """What the device needs on launch: cadence, whether consent is on file, and
    whether the employee is clocked in right now (so the app knows to run)."""
    email = dev.employee_email
    return {
        "intervalSec": _TRACK_INTERVAL_SEC, "distanceM": _TRACK_DISTANCE_M,
        "consentVersion": _CONSENT_VERSION,
        "hasConsent": _live_consent(db, email) is not None,
        "clockedIn": _clocked_in(db, email), "email": email,
    }


@router.post("/track/start")
def track_start(dev: AgentDevice = Depends(get_agent_device), db: Session = Depends(get_db)):
    email = dev.employee_email
    if _live_consent(db, email) is None:
        raise HTTPException(403, "Location tracking needs your consent first.")
    if not _clocked_in(db, email):
        raise HTTPException(409, "Not clocked in - tracking only runs during a shift.")
    sess = _open_session(db, email) or _new_session(db, dev)
    db.commit()
    return {"sessionId": sess.id, "intervalSec": _TRACK_INTERVAL_SEC, "distanceM": _TRACK_DISTANCE_M}


class PingItem(BaseModel):
    lat: str
    lng: str
    accuracy_m: Optional[int] = 0
    at: Optional[str] = ""          # device capture time (UTC ISO); server time if blank
    battery_pct: Optional[int] = -1
    tz_offset_min: Optional[int] = 0


class PingBatch(BaseModel):
    pings: List[PingItem] = []


@router.post("/track/ping")
def track_ping(body: PingBatch, dev: AgentDevice = Depends(get_agent_device),
               db: Session = Depends(get_db)):
    """Batched location samples - the device's offline buffer flushes here, so a
    dead-zone stretch uploads on reconnect. Each ping keeps its DEVICE capture
    time, not receive time. Rejected unless clocked in AND consented."""
    email = dev.employee_email
    if _live_consent(db, email) is None:
        raise HTTPException(403, "No tracking consent on file.")
    if not _clocked_in(db, email):
        # Clocked out while the device still held buffered pings - close the
        # session and drop them. Off-shift location is never stored.
        close_track_session(db, email, "clock_out")
        db.commit()
        raise HTTPException(409, "Not clocked in - tracking stopped.")
    sess = _open_session(db, email) or _new_session(db, dev)
    stored = 0
    for p in body.pings[:500]:
        if not (p.lat or "").strip() or not (p.lng or "").strip():
            continue
        at = (p.at or "").strip()[:19] or _now_iso()
        geo = _geofence(db, p.lat, p.lng, p.accuracy_m or 0)
        db.add(TrackPing(
            id=str(uuid.uuid4()), session_id=sess.id, employee_email=email,
            at=at, received_at=_now_iso(), local_date=_local_date(at, p.tz_offset_min or 0),
            lat=(p.lat or "").strip()[:24], lng=(p.lng or "").strip()[:24],
            accuracy_m=max(0, int(p.accuracy_m or 0)),
            battery_pct=int(p.battery_pct if p.battery_pct is not None else -1),
            source="mobile", **geo))
        stored += 1
    db.commit()
    return {"stored": stored, "sessionId": sess.id, "intervalSec": _TRACK_INTERVAL_SEC}


@router.post("/track/stop")
def track_stop(dev: AgentDevice = Depends(get_agent_device), db: Session = Depends(get_db)):
    close_track_session(db, dev.employee_email, "manual")
    db.commit()
    return {"ok": True}


class TrackClockIn(BaseModel):
    kind: str                        # in | out
    lat: Optional[str] = ""
    lng: Optional[str] = ""
    accuracy_m: Optional[int] = 0
    tz_offset_min: Optional[int] = 0


@router.post("/track/clock")
def track_clock(body: TrackClockIn, dev: AgentDevice = Depends(get_agent_device),
                db: Session = Depends(get_db)):
    """Clock in/out from the enrolled phone (token-authed, no Microsoft login -
    same self-punch model as the desktop agent's auto-clock). Punching in also
    opens a tracking session; punching out closes it. Feeds the SAME timesheets
    and approvals as web punches (source='mobile', adjustable)."""
    if body.kind not in ("in", "out"):
        raise HTTPException(400, "kind must be 'in' or 'out'")
    email = dev.employee_email
    last = (db.query(TimePunch)
            .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
            .order_by(TimePunch.at.desc()).first())
    if body.kind not in _allowed_kinds(last.kind if last else None):
        raise HTTPException(409, f"Can't clock '{body.kind}' right now.")
    now = _now_iso()
    geo = (_geofence(db, body.lat, body.lng, body.accuracy_m or 0)
           if (body.lat or "").strip() else
           {"geo_status": "no_location", "work_site_id": "", "work_site_name": "", "distance_m": 0})
    db.add(TimePunch(id=str(uuid.uuid4()), employee_email=email, kind=body.kind, at=now,
                     local_date=_local_date(now, body.tz_offset_min or 0),
                     tz_offset_min=body.tz_offset_min or 0,
                     lat=(body.lat or "").strip()[:24], lng=(body.lng or "").strip()[:24],
                     accuracy_m=max(0, int(body.accuracy_m or 0)),
                     source="mobile", created_by=email, created_at=now, **geo))
    if body.kind == "in":
        if _live_consent(db, email) is not None:
            _open_session(db, email) or _new_session(db, dev)  # start tracking on clock-in
    else:
        close_track_session(db, email, "clock_out")
    db.commit()
    return {"kind": body.kind, "clockedIn": body.kind == "in", "at": now,
            "geoStatus": geo["geo_status"], "trackable": _live_consent(db, email) is not None}


@router.get("/track/live")
def track_live(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Latest ping per currently-tracked team member - the live crew map. Scoped
    to the viewer's team (whole company for HR/admins). Self-heals: a session
    whose last ping is older than the idle window is closed and dropped, so a
    phone that died (no clock-out) stops showing as live."""
    scope = _visible_emails(db, user)
    q = db.query(TrackSession).filter(TrackSession.ended_at == "")
    if scope is not None:
        q = q.filter(TrackSession.employee_email.in_(list(scope)))
    names = {(e.work_email or "").lower(): f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    now = datetime.now(timezone.utc)
    crew = []
    for s in q.all():
        # Latest POSITION is the newest device-capture time; LIVENESS is the last
        # time we heard from the device (received_at). They differ when a device
        # flushes an offline buffer - old `at` values, fresh contact - so a worker
        # back from a dead zone must not be judged idle on a stale capture time.
        last = (db.query(TrackPing).filter(TrackPing.session_id == s.id)
                .order_by(TrackPing.at.desc()).first())
        contact = (db.query(TrackPing.received_at).filter(TrackPing.session_id == s.id)
                   .order_by(TrackPing.received_at.desc()).first())
        contact_t = _parse_iso(contact[0]) if contact and contact[0] else None
        if last is None or contact_t is None or (now - contact_t).total_seconds() > _TRACK_IDLE_STOP_SEC:
            s.ended_at = _now_iso()
            s.ended_reason = "idle"
            continue
        crew.append({
            "email": s.employee_email,
            "name": names.get(s.employee_email) or s.employee_email.split("@")[0].replace(".", " ").title(),
            "lat": last.lat, "lng": last.lng, "accuracyM": last.accuracy_m, "at": last.at,
            "geoStatus": last.geo_status, "workSiteName": last.work_site_name or "",
            "distanceM": last.distance_m or 0, "batteryPct": last.battery_pct,
            "sessionStart": s.started_at,
        })
    db.commit()
    return {"crew": crew}


@router.get("/locations")
def team_locations(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Each employee's LATEST punch location, for the Locations map. Scoped to the
    viewer's team (whole company for HR/admins). A punch carries lat/lng even when
    the geofence can't judge it (no site, or a coarse desktop fix), so this shows
    where each person last punched from. Joined with company/department/country +
    photo so the map can filter and pin with the person's avatar."""
    from models import HrEntity
    scope = _visible_emails(db, user)
    ents = {e.id: e for e in db.query(HrEntity).all()}
    people = []
    emps = db.query(NexusEmployee).filter(NexusEmployee.status == "active").all()
    for em in emps:
        email = (em.work_email or "").lower()
        if not email or (scope is not None and email not in scope):
            continue
        # Latest punch WITH coordinates (for the pin), and latest punch OVERALL
        # (for the clocked-in dot). Usually the same row, but a manual +add punch
        # has no coords, so keep them separate.
        loc = (db.query(TimePunch)
               .filter(TimePunch.employee_email == email, TimePunch.voided == 0,
                       TimePunch.lat.isnot(None), TimePunch.lat != "")
               .order_by(TimePunch.at.desc()).first())
        if not loc:
            continue
        last = (db.query(TimePunch).filter(TimePunch.employee_email == email, TimePunch.voided == 0)
                .order_by(TimePunch.at.desc()).first())
        last_kind = last.kind if last else ""
        # working (clocked in) / on_break / off (clocked out or never in today)
        status = ("on_break" if last_kind == "break_start"
                  else "working" if last_kind in ("in", "break_end")
                  else "off")
        # Device the LOCATION punch came from - a phone gives real GPS, a desktop
        # only a coarse Wi-Fi/IP fix, so this explains the accuracy at a glance.
        ua = (loc.user_agent or "").lower()
        device = "mobile" if any(k in ua for k in ("mobi", "android", "iphone", "ipad", "ipod")) else "desktop"
        ent = ents.get(em.company or "")
        people.append({
            "email": email,
            "name": f"{em.first_name} {em.last_name}".strip() or email,
            "photoUrl": em.photo_url or "",
            "jobTitle": em.job_title or "",
            "department": em.department or "",
            "companyId": em.company or "",
            "companyName": (ent.name if ent else ""),
            "country": (ent.country if ent else ""),
            "lat": loc.lat, "lng": loc.lng, "accuracyM": loc.accuracy_m or 0,
            "geoStatus": loc.geo_status or "no_location",
            "workSiteName": loc.work_site_name or "",
            "at": loc.at,
            "clockedIn": status != "off",
            "status": status,
            "device": device,
        })
    return {"people": people}


@router.get("/track/path")
def track_path(email: str, date: str, user: dict = Depends(require_team_read),
               db: Session = Depends(get_db)):
    """Ordered breadcrumb for one employee on one local date - the map replay."""
    em = email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    pings = (db.query(TrackPing)
             .filter(TrackPing.employee_email == em, TrackPing.local_date == date)
             .order_by(TrackPing.at).all())
    return {"email": em, "date": date, "points": [{
        "at": p.at, "lat": p.lat, "lng": p.lng, "accuracyM": p.accuracy_m,
        "geoStatus": p.geo_status, "workSiteName": p.work_site_name or "",
        "distanceM": p.distance_m or 0, "batteryPct": p.battery_pct,
    } for p in pings]}


def purge_old_track_pings(db: Session, days: int = _TRACK_RETENTION_DAYS) -> int:
    """Retention guardrail: delete raw pings older than the window, plus sessions
    that ended before it. Called from the daily reminders job. Returns rows cut."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    n = (db.query(TrackPing).filter(TrackPing.local_date < cutoff)
         .delete(synchronize_session=False))
    db.query(TrackSession).filter(TrackSession.ended_at != "",
                                  TrackSession.ended_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return n


# ── Shifts, groups, and bulk assignment ──────────────────────────────────────

class ShiftIn(BaseModel):
    name: str
    code: Optional[str] = ""
    start_hhmm: str = "09:00"
    end_hhmm: str = "17:00"
    days: str = "1,2,3,4,5"
    grace_min: int = 10
    color: Optional[str] = "#2563eb"


def _shift_dict(s: Shift) -> dict:
    return {"id": s.id, "name": s.name, "code": s.code or "", "start": s.start_hhmm,
            "end": s.end_hhmm, "days": s.days, "graceMin": s.grace_min, "color": s.color}


@router.get("/shifts")
def list_shifts(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return {"shifts": [_shift_dict(s) for s in db.query(Shift).order_by(Shift.name).all()]}


@router.post("/shifts")
def create_shift(body: ShiftIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    s = Shift(id=str(uuid.uuid4()), name=body.name.strip()[:80], code=(body.code or "").strip()[:12],
              start_hhmm=body.start_hhmm[:5], end_hhmm=body.end_hhmm[:5],
              days=body.days[:40], grace_min=max(0, int(body.grace_min or 0)),
              color=(body.color or "#2563eb")[:9], created_by=user["email"], created_at=_now_iso())
    db.add(s)
    db.commit()
    return _shift_dict(s)


@router.patch("/shifts/{shift_id}")
def update_shift(shift_id: str, body: ShiftIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    s = db.query(Shift).filter(Shift.id == shift_id).first()
    if not s:
        raise HTTPException(404, "Shift not found")
    s.name = body.name.strip()[:80]
    s.code = (body.code or "").strip()[:12]
    s.start_hhmm = body.start_hhmm[:5]
    s.end_hhmm = body.end_hhmm[:5]
    s.days = body.days[:40]
    s.grace_min = max(0, int(body.grace_min or 0))
    s.color = (body.color or "#2563eb")[:9]
    db.commit()
    return _shift_dict(s)


@router.delete("/shifts/{shift_id}")
def delete_shift(shift_id: str, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    db.query(Shift).filter(Shift.id == shift_id).delete()
    db.query(ShiftAssignment).filter(ShiftAssignment.shift_id == shift_id).delete()
    db.commit()
    return {"ok": True}


@router.get("/shift-groups")
def list_shift_groups(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    members = {}
    for m in db.query(ShiftGroupMember).all():
        members.setdefault(m.group_id, []).append(m.employee_email)
    return {"groups": [{"id": g.id, "name": g.name, "members": members.get(g.id, []),
                        "chatId": g.teams_chat_id or "", "chatName": g.teams_chat_name or ""}
                       for g in db.query(ShiftGroup).order_by(ShiftGroup.name).all()]}


class GroupIn(BaseModel):
    name: str
    members: List[str] = []
    teams_chat_id: Optional[str] = None
    teams_chat_name: Optional[str] = None


@router.post("/shift-groups")
def create_shift_group(body: GroupIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    g = ShiftGroup(id=str(uuid.uuid4()), name=body.name.strip()[:80],
                   teams_chat_id=(body.teams_chat_id or "")[:200],
                   teams_chat_name=(body.teams_chat_name or "")[:200],
                   created_by=user["email"], created_at=_now_iso())
    db.add(g)
    for em in dict.fromkeys(e.strip().lower() for e in body.members if e.strip()):
        db.add(ShiftGroupMember(id=str(uuid.uuid4()), group_id=g.id, employee_email=em))
    db.commit()
    return {"id": g.id, "name": g.name, "members": list(dict.fromkeys(e.strip().lower() for e in body.members if e.strip()))}


@router.patch("/shift-groups/{group_id}")
def set_group_members(group_id: str, body: GroupIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    g = db.query(ShiftGroup).filter(ShiftGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Group not found")
    if body.name.strip():
        g.name = body.name.strip()[:80]
    if body.teams_chat_id is not None:
        g.teams_chat_id = body.teams_chat_id[:200]
        g.teams_chat_name = (body.teams_chat_name or "")[:200]
    db.query(ShiftGroupMember).filter(ShiftGroupMember.group_id == group_id).delete()
    for em in dict.fromkeys(e.strip().lower() for e in body.members if e.strip()):
        db.add(ShiftGroupMember(id=str(uuid.uuid4()), group_id=group_id, employee_email=em))
    db.commit()
    return {"ok": True}


@router.get("/my-chat")
def my_group_chat(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Teams group chat this employee's group is bound to - where their
    BOD/EOD/Break messages should route. First group (with a binding) they belong
    to wins. Empty chatId means no binding → the client falls back to a picker."""
    email = user["email"].lower()
    group_ids = [m.group_id for m in db.query(ShiftGroupMember)
                 .filter(ShiftGroupMember.employee_email == email).all()]
    if not group_ids:
        return {"chatId": "", "chatName": "", "groupName": ""}
    g = (db.query(ShiftGroup)
         .filter(ShiftGroup.id.in_(group_ids), ShiftGroup.teams_chat_id != "")
         .order_by(ShiftGroup.name).first())
    if not g:
        return {"chatId": "", "chatName": "", "groupName": ""}
    return {"chatId": g.teams_chat_id, "chatName": g.teams_chat_name, "groupName": g.name}


@router.delete("/shift-groups/{group_id}")
def delete_shift_group(group_id: str, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    db.query(ShiftGroup).filter(ShiftGroup.id == group_id).delete()
    db.query(ShiftGroupMember).filter(ShiftGroupMember.group_id == group_id).delete()
    db.commit()
    return {"ok": True}


class AssignIn(BaseModel):
    shift_id: str
    emails: List[str] = []


@router.post("/shift-assign")
def assign_shift(body: AssignIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    """Bulk-assign a shift to a set of employees (typically a group's members).
    An empty shift_id clears the assignment."""
    now = _now_iso()
    n = 0
    for em in dict.fromkeys(e.strip().lower() for e in body.emails if e.strip()):
        row = db.query(ShiftAssignment).filter(ShiftAssignment.employee_email == em).first()
        if not row:
            row = ShiftAssignment(id=str(uuid.uuid4()), employee_email=em)
            db.add(row)
        row.shift_id = body.shift_id or ""
        row.assigned_by = user["email"]
        row.assigned_at = now
        n += 1
    db.commit()
    return {"ok": True, "assigned": n}


@router.get("/shift-assignments")
def shift_assignments(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return {"assignments": {a.employee_email: a.shift_id
                            for a in db.query(ShiftAssignment).all() if a.shift_id}}


# ── Weekly schedule grid (Teams-Shifts style) ────────────────────────────────

def _sched_dict(row: ScheduledShift, presets: dict) -> dict:
    p = presets.get(row.shift_id)
    return {"id": row.id, "email": row.employee_email, "date": row.work_date,
            "shiftId": row.shift_id, "start": row.start_hhmm, "end": row.end_hhmm,
            "label": row.label, "note": row.note, "published": bool(row.published),
            "code": (p.code or p.name) if p else "", "color": p.color if p else "#64748b"}


@router.get("/schedule")
def read_schedule(start: str, end: str, user: dict = Depends(require_team_read),
                  db: Session = Depends(get_db)):
    """Everything the grid needs for a date range: visible employees (scoped),
    shift presets, groups, the placed shifts, and time off to overlay."""
    scope = _visible_emails(db, user)
    names = {(e.work_email or "").lower(): f"{e.first_name} {e.last_name}".strip()
             for e in db.query(NexusEmployee).all() if e.work_email}
    if scope is None:
        emails = list(names.keys())
    else:
        emails = sorted(scope)
    employees = [{"email": em, "name": names.get(em, em)} for em in emails]

    presets = {s.id: s for s in db.query(Shift).all()}
    members = {}
    for m in db.query(ShiftGroupMember).all():
        members.setdefault(m.group_id, []).append(m.employee_email)
    groups = [{"id": g.id, "name": g.name, "members": members.get(g.id, [])}
              for g in db.query(ShiftGroup).order_by(ShiftGroup.name).all()]

    q = (db.query(ScheduledShift)
         .filter(ScheduledShift.work_date >= start, ScheduledShift.work_date <= end))
    if scope is not None:
        q = q.filter(ScheduledShift.employee_email.in_(list(scope)))
    scheduled = [_sched_dict(r, presets) for r in q.all()]

    tq = (db.query(TimeOffRequest)
          .filter(TimeOffRequest.status.in_(["approved", "pending"]),
                  TimeOffRequest.start_date <= end, TimeOffRequest.end_date >= start))
    if scope is not None:
        tq = tq.filter(TimeOffRequest.employee_email.in_(list(scope)))
    timeoff = [{"email": t.employee_email, "startDate": t.start_date, "endDate": t.end_date,
                "type": t.type, "status": t.status} for t in tq.all()]

    return {"employees": employees, "shifts": [_shift_dict(s) for s in presets.values()],
            "groups": groups, "scheduled": scheduled, "timeoff": timeoff}


class ScheduledShiftIn(BaseModel):
    employee_email: str
    work_date: str
    shift_id: Optional[str] = ""
    start_hhmm: Optional[str] = ""
    end_hhmm: Optional[str] = ""
    label: Optional[str] = ""
    note: Optional[str] = ""


@router.post("/schedule")
def create_scheduled(body: ScheduledShiftIn, user: dict = Depends(require_team_write),
                     db: Session = Depends(get_db)):
    em = body.employee_email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    preset = db.query(Shift).filter(Shift.id == body.shift_id).first() if body.shift_id else None
    row = ScheduledShift(
        id=str(uuid.uuid4()), employee_email=em, work_date=body.work_date[:10],
        shift_id=body.shift_id or "",
        start_hhmm=(body.start_hhmm or (preset.start_hhmm if preset else "09:00"))[:5],
        end_hhmm=(body.end_hhmm or (preset.end_hhmm if preset else "17:00"))[:5],
        label=(body.label or "")[:80], note=(body.note or "")[:200],
        created_by=user["email"], created_at=_now_iso())
    db.add(row)
    db.commit()
    return _sched_dict(row, {preset.id: preset} if preset else {})


@router.patch("/schedule/{sched_id}")
def update_scheduled(sched_id: str, body: ScheduledShiftIn,
                     user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    row = db.query(ScheduledShift).filter(ScheduledShift.id == sched_id).first()
    if not row:
        raise HTTPException(404, "Shift not found")
    scope = _visible_emails(db, user)
    if scope is not None and row.employee_email not in scope:
        raise HTTPException(403, "Outside your team")
    preset = db.query(Shift).filter(Shift.id == body.shift_id).first() if body.shift_id else None
    row.shift_id = body.shift_id or ""
    row.start_hhmm = (body.start_hhmm or (preset.start_hhmm if preset else row.start_hhmm))[:5]
    row.end_hhmm = (body.end_hhmm or (preset.end_hhmm if preset else row.end_hhmm))[:5]
    row.label = (body.label or "")[:80]
    row.note = (body.note or "")[:200]
    db.commit()
    return _sched_dict(row, {preset.id: preset} if preset else {})


@router.delete("/schedule/{sched_id}")
def delete_scheduled(sched_id: str, user: dict = Depends(require_team_write),
                     db: Session = Depends(get_db)):
    row = db.query(ScheduledShift).filter(ScheduledShift.id == sched_id).first()
    if row:
        scope = _visible_emails(db, user)
        if scope is not None and row.employee_email not in scope:
            raise HTTPException(403, "Outside your team")
        db.delete(row)
        db.commit()
    return {"ok": True}


# ── Payroll timecard (manager-editable, per pay period) ───────────────────────

_WEEK_OT_MIN = 40 * 60   # weekly overtime threshold (federal FLSA + CA weekly)
_DAY_OT_MIN  = 8 * 60    # CA: over 8h/day is overtime
_DAY_DT_MIN  = 12 * 60   # CA: over 12h/day is double-time
_OT_MULT = 1.5
_DT_MULT = 2.0


def _ot_split(day_minutes: list, rule: str) -> list:
    """Split each day's worked minutes into (regular, ot@1.5x, dt@2x) following
    the employee's overtime law. `day_minutes` is ONE workweek in order (index 0 =
    week start, 7 entries Sun→Sat), 0 for days not worked. Anti-pyramiding: every
    minute is overtime under at most one basis - a minute counted as daily OT is
    never also counted toward the weekly-40 threshold.

    - 'none'    : no US overtime premium (non-US employees; local law handled off-Nexus)
    - 'federal' : FLSA weekly only - hours over 40 in the week at 1.5x (out-of-state US)
    - 'ca'      : California - daily >8h@1.5x / >12h@2x, the 7th CONSECUTIVE worked day
                  (first 8h@1.5x, beyond 8h@2x), plus weekly >40h of straight time @1.5x
    """
    if rule == "none":
        return [(m, 0, 0) for m in day_minutes]

    if rule != "ca":   # federal / default weekly-only
        out, straight = [], 0
        for m in day_minutes:
            r, o = m, 0
            if straight + r > _WEEK_OT_MIN:
                o = min(r, straight + r - _WEEK_OT_MIN); r -= o
            straight += r
            out.append((r, o, 0))
        return out

    # California
    out, consec, straight = [], 0, 0
    for m in day_minutes:
        if m <= 0:
            consec = 0
            out.append((0, 0, 0))
            continue
        consec += 1
        if consec == 7:                                  # 7th consecutive worked day
            out.append((0, min(m, _DAY_OT_MIN), max(0, m - _DAY_OT_MIN)))
            continue
        r = min(m, _DAY_OT_MIN)                           # first 8h - straight time
        o = max(0, min(m, _DAY_DT_MIN) - _DAY_OT_MIN)     # 8–12h @1.5x
        d = max(0, m - _DAY_DT_MIN)                       # >12h @2x
        if straight + r > _WEEK_OT_MIN:                   # weekly 40h: overflow straight → 1.5x
            over = min(r, straight + r - _WEEK_OT_MIN); r -= over; o += over
        straight += r
        out.append((r, o, d))
    return out


def _week_start_str(date_str: str) -> str:
    # SUNDAY of the week - the overtime workweek must be anchored on the same
    # weekday as the (Sunday→Saturday) pay period, or a Sunday that opens a pay
    # period gets a fresh 40h bucket and its overtime is underpaid as regular.
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return (d - timedelta(days=(d.weekday() + 1) % 7)).strftime("%Y-%m-%d")


def _employee_today(db: Session, email: str) -> str:
    """The employee's LOCAL calendar date. Attendance days (`local_date`) are stored
    in the puncher's own timezone, so judging 'has this day elapsed / is it in the
    future' against UTC would mis-deduct a full day at the day/month boundary for any
    non-UTC employee. Derive their offset from their most recent punch (JS
    getTimezoneOffset: local = UTC − offset); default UTC when they've never punched."""
    p = (db.query(TimePunch).filter(TimePunch.employee_email == email)
         .order_by(TimePunch.at.desc()).first())
    off = (p.tz_offset_min or 0) if p else 0
    return (datetime.now(timezone.utc) - timedelta(minutes=off)).strftime("%Y-%m-%d")


def _employee_now(db: Session, email: str) -> datetime:
    """The employee's LOCAL wall-clock time (naive), for comparing against a shift
    start time. Same offset source as _employee_today."""
    p = (db.query(TimePunch).filter(TimePunch.employee_email == email)
         .order_by(TimePunch.at.desc()).first())
    off = (p.tz_offset_min or 0) if p else 0
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=off)


def _shift_start_for(db: Session, email: str, dd: date):
    """The scheduled shift start (HH:MM) + grace minutes for this employee on this
    date, or None if they have no shift that day. Prefers a ScheduledShift placed on
    the exact date; else the employee's assigned Shift preset when the weekday is one
    of its working days. Used ONLY to drive the live 'Late' status for salaried staff
    (it never affects pay)."""
    sched = (db.query(ScheduledShift)
             .filter(ScheduledShift.employee_email == email,
                     ScheduledShift.work_date == dd.isoformat()).first())
    if sched:
        grace = 10
        if sched.shift_id:
            preset = db.query(Shift).filter(Shift.id == sched.shift_id).first()
            if preset:
                grace = preset.grace_min or 0
        return (sched.start_hhmm or "09:00", grace)
    assign = db.query(ShiftAssignment).filter(ShiftAssignment.employee_email == email).first()
    if assign and assign.shift_id:
        preset = db.query(Shift).filter(Shift.id == assign.shift_id).first()
        if preset:
            days = {int(x) for x in (preset.days or "").split(",") if x.strip().isdigit()}
            if dd.isoweekday() in days:   # Mon=1 .. Sun=7
                return (preset.start_hhmm or "09:00", preset.grace_min or 0)
    return None


# ── Bi-weekly pay period (California: Sunday→Saturday × 2 = 14 days) ───────────
# Periods step 14 days from a fixed Sunday anchor, aligned to the company's REAL
# payroll calendar in SwipeClock (site 47239: period 7/26/26–8/8/26, verified
# Jul 27 2026 for the parallel run). The prior anchor (2024-01-07) put every
# Nexus period off by exactly one week from SwipeClock.
_PAYPERIOD_ANCHOR = date(2024, 1, 14)  # a Sunday on SwipeClock's period series
_PAYPERIOD_DAYS = 14


def _pay_period(date_str: str):
    """Return (start_iso, end_iso) of the bi-weekly period containing date_str."""
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    idx = (d - _PAYPERIOD_ANCHOR).days // _PAYPERIOD_DAYS
    start = _PAYPERIOD_ANCHOR + timedelta(days=idx * _PAYPERIOD_DAYS)
    return start.isoformat(), (start + timedelta(days=_PAYPERIOD_DAYS - 1)).isoformat()


def _month_bounds(date_str: str):
    """Return (first_iso, last_iso) of the CALENDAR month containing date_str.
    Fixed-salary employees are paid by the month, not the bi-weekly period."""
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    first = d.replace(day=1)
    nxt = date(first.year + (first.month == 12), (first.month % 12) + 1, 1)
    return first.isoformat(), (nxt - timedelta(days=1)).isoformat()


def _fixed_card(db: Session, em: str, anchor: str) -> dict:
    """Monthly timecard for a FIXED-salary employee. Reuses _compute_timecard for
    the day/segment grid (so inline edit/add, signatures and worked-minutes are
    identical), then overlays the fixed-pay math on top:

        pay = monthly_salary
              - (missed weekday-days x daily_rate, half a day for a half day)
              + (weekend days worked x weekend_ot_amount)

    daily_rate = monthly_salary / calendar-days-in-month. A weekday counts as a
    HALF day if worked > 0 but under half a full day (full_day_hours / 2), and a
    full absence if worked == 0. Weekends are never deducted; each weekend DAY
    worked adds the flat weekend overtime. Future weekdays in the current month
    don't deduct until they've elapsed. No work-week / no hourly OT here."""
    m_start, m_end = _month_bounds(anchor)
    card = _compute_timecard(db, em, m_start, m_end, round_min=0)   # grid + worked minutes + segments; no rounding for salary
    rr = db.query(PayrollRate).filter(PayrollRate.employee_email == em).first()
    salary = float(getattr(rr, "monthly_salary", 0) or 0) if rr else 0.0
    weekend_ot = float(getattr(rr, "weekend_ot_amount", 0) or 0) if rr else 0.0
    full_hours = float(getattr(rr, "full_day_hours", 8) or 8) if rr else 8.0
    currency = (getattr(rr, "currency", None) or "USD") if rr else "USD"
    # A FINALIZED month is frozen at the salary it was finalized with, so a later
    # raise can't retro-price an already-paid month (mirrors the hourly freeze).
    _fin_snap = _finalized_row(db, em, m_start, m_end)
    _frozen = {}   # finalize-time totals - pin the whole result so it can't re-price
    if _fin_snap and _fin_snap.note:
        try:
            _sn = json.loads(_fin_snap.note)
            if isinstance(_sn, dict) and "monthlySalary" in _sn:
                salary = float(_sn.get("monthlySalary") or 0)
                weekend_ot = float(_sn.get("weekendOtAmount") or 0)
                full_hours = float(_sn.get("fullDayHours") or 8) or 8
                currency = _sn.get("currency") or currency
                if _sn.get("totalPay") is not None:
                    _frozen = {k: _sn.get(k) for k in ("totalPay", "deduction", "weekendBonus",
                               "missedFullDays", "missedHalfDays", "weekendDaysWorked")}
        except Exception:   # noqa: BLE001 - a bad snapshot must not break the card
            pass

    first = datetime.strptime(m_start, "%Y-%m-%d").date()
    last = datetime.strptime(m_end, "%Y-%m-%d").date()
    days_in_month = (last - first).days + 1
    daily = salary / days_in_month if days_in_month else 0.0
    # Attendance bands (policy, same for everyone): a weekday is PRESENT (full credit)
    # at 5h+, a HALF day from 4h up to 5h, and ABSENT under 4h. While still clocked in
    # today it's WORKING (no judgment yet). full_hours stays on the record but the
    # bands are fixed here.
    HALF_MIN, FULL_MIN = 4 * 60, 5 * 60
    _ = full_hours
    today = _employee_today(db, em)   # employee-LOCAL date, not UTC (boundary correctness)

    worked_by_day = {d["date"]: d.get("workedMin", 0) for d in card.get("days", [])}
    # An open in-punch (no clock-out yet) means the person is mid-shift.
    open_by_day = {d["date"]: any(not s.get("out") for s in d.get("segments", []))
                   for d in card.get("days", [])}
    # Live "Late" for the CURRENT day only (salaried): the employee's shift start +
    # grace has passed in their LOCAL time and they've not clocked in yet. Flags a
    # no-show-so-far - NO deduction, since the day isn't over. Only when a shift start
    # is known; otherwise today stays "Upcoming" until they punch in.
    late_today = False
    _sh = _shift_start_for(db, em, datetime.strptime(today, "%Y-%m-%d").date())
    if _sh:
        try:
            _hh, _mm = (int(x) for x in _sh[0].split(":")[:2])
            _now = _employee_now(db, em)
            late_today = (_now.hour * 60 + _now.minute) >= (_hh * 60 + _mm + int(_sh[1] or 0))
        except (ValueError, TypeError):
            late_today = False

    missed_full = missed_half = weekend_worked = 0
    deduction = 0.0
    fixed_days = []
    for i in range(days_in_month):
        dd = first + timedelta(days=i)
        ds = dd.isoformat()
        wm = worked_by_day.get(ds, 0)
        has_open = open_by_day.get(ds, False)
        is_weekend = dd.weekday() >= 5      # Sat=5, Sun=6
        deduct = bonus = 0.0
        if is_weekend:
            if wm > 0 or has_open:
                status = "weekend_worked"; bonus = weekend_ot; weekend_worked += 1
            else:
                status = "weekend"
        elif has_open and ds >= today:
            status = "working"              # clocked in, still on shift today - no deduction yet
        elif wm >= FULL_MIN:
            status = "present"              # 5h+ = full day, never deducted
        elif ds > today:
            status = "upcoming"             # future weekday, nothing logged yet
        elif ds == today:
            # Today, in progress: never deduct - the day isn't over. With activity ->
            # Working. Otherwise, if their shift start + grace has passed with no punch
            # yet, a live "Late"; before the shift starts, "Upcoming". Half/absent only
            # bite once the day has fully elapsed.
            status = "working" if wm > 0 else ("late" if late_today else "upcoming")
        elif wm >= HALF_MIN:
            status = "half"; deduct = daily / 2.0; missed_half += 1   # past day, 4h-5h
        else:
            status = "absent"; deduct = daily; missed_full += 1       # past day, under 4h
        deduction += deduct
        fixed_days.append({"date": ds, "workedMin": wm, "isWeekend": is_weekend,
                           "future": ds > today,   # can't add a punch for a day that hasn't happened
                           "status": status, "deduct": round(deduct, 2), "bonus": round(bonus, 2)})

    weekend_bonus = round(weekend_worked * weekend_ot, 2)
    deduction = round(deduction, 2)
    total_pay = round(salary - deduction + weekend_bonus, 2)
    # A finalized month is PINNED to its finalize-time result (day statuses key off
    # "today", so without this a mid-month finalize would drift as days elapse).
    if _frozen:
        deduction = _frozen.get("deduction", deduction)
        weekend_bonus = _frozen.get("weekendBonus", weekend_bonus)
        total_pay = _frozen.get("totalPay", total_pay)
        missed_full = _frozen.get("missedFullDays", missed_full)
        missed_half = _frozen.get("missedHalfDays", missed_half)
        weekend_worked = _frozen.get("weekendDaysWorked", weekend_worked)

    card["payType"] = "fixed"
    card["currency"] = currency
    card["monthlySalary"] = salary
    card["dailyRate"] = round(daily, 2)
    card["weekendOtAmount"] = weekend_ot
    card["fullDayHours"] = full_hours
    card["fixedDays"] = fixed_days
    card["totals"] = {**card.get("totals", {}),
                      "payType": "fixed", "monthlySalary": salary,
                      "daysInMonth": days_in_month, "dailyRate": round(daily, 2),
                      "missedFullDays": missed_full, "missedHalfDays": missed_half,
                      "weekendDaysWorked": weekend_worked,
                      "deduction": deduction, "weekendBonus": weekend_bonus,
                      "totalPay": total_pay}
    card["periodStart"], card["periodEnd"] = m_start, m_end
    card["periodDays"] = days_in_month
    return card


def _pay_type(db: Session, em: str) -> str:
    rr = db.query(PayrollRate).filter(PayrollRate.employee_email == em).first()
    return (getattr(rr, "pay_type", None) or "hourly") if rr else "hourly"


_AUTOLUNCH_KEY = "timeclock_autolunch"
_AUTOLUNCH_DEFAULT = {"enabled": False, "afterMin": 360, "deductMin": 30}


def _autolunch_cfg(db: Session) -> dict:
    """Auto-lunch deduction rule: deduct `deductMin` from a worked segment that ran
    at least `afterMin` with NO recorded break (the person forgot to clock lunch).
    Off by default so it never silently changes pay until an admin enables it."""
    row = db.query(NexusSetting).filter(NexusSetting.key == _AUTOLUNCH_KEY).first()
    cfg = dict(_AUTOLUNCH_DEFAULT)
    if row and row.value:
        try:
            cfg.update({k: v for k, v in json.loads(row.value).items() if k in cfg})
        except (ValueError, TypeError):
            pass
    cfg["enabled"] = bool(cfg.get("enabled"))
    cfg["afterMin"] = max(0, int(cfg.get("afterMin") or 0))
    cfg["deductMin"] = max(0, int(cfg.get("deductMin") or 0))
    return cfg


@router.get("/payroll/autolunch")
def get_autolunch(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return _autolunch_cfg(db)


class AutoLunchIn(BaseModel):
    enabled: bool = False
    afterMin: int = 360
    deductMin: int = 30


@router.put("/payroll/autolunch")
def set_autolunch(body: AutoLunchIn, user: dict = Depends(require_administrator),
                  db: Session = Depends(get_db)):
    cfg = {"enabled": bool(body.enabled), "afterMin": max(0, int(body.afterMin)),
           "deductMin": max(0, int(body.deductMin))}
    row = db.query(NexusSetting).filter(NexusSetting.key == _AUTOLUNCH_KEY).first()
    if not row:
        row = NexusSetting(key=_AUTOLUNCH_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    db.commit()
    return cfg


# ── Punch rounding (SwipeClock parity) ─────────────────────────────────────────
# SwipeClock drops seconds from every punch and rounds to the nearest N minutes
# (site 47239: N=5, verified via the time card's "Show Unrounded Times" overlay,
# Jul 27 2026). Raw punch times stay on record; ROUNDED times drive the timecard
# math - exactly SwipeClock's model, and required for the parallel-run numbers
# to match 1:1.
_ROUNDING_KEY = "timeclock_rounding"
_ROUNDING_DEFAULT = {"enabled": True, "nearestMin": 5}


def _rounding_cfg(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == _ROUNDING_KEY).first()
    cfg = dict(_ROUNDING_DEFAULT)
    if row and row.value:
        try:
            cfg.update({k: v for k, v in json.loads(row.value).items() if k in cfg})
        except (ValueError, TypeError):
            pass
    cfg["enabled"] = bool(cfg.get("enabled"))
    cfg["nearestMin"] = min(30, max(0, int(cfg.get("nearestMin") or 0)))
    return cfg


def _round_min(db: Session) -> int:
    """The active punch-rounding step (0 when rounding is off) - the value to pass
    to _day_summaries so its totals match the rounded PAY engine."""
    c = _rounding_cfg(db)
    return c["nearestMin"] if c["enabled"] else 0


def _round_punch(t: datetime, nearest: int) -> datetime:
    """Drop seconds, then round the minute-of-day to the nearest `nearest`
    (half rounds up): 1:22:00→1:20, 1:23:00→1:25, 9:04:00→9:05 at nearest=5."""
    t = t.replace(second=0, microsecond=0)
    if nearest <= 0:
        return t
    total = t.hour * 60 + t.minute
    rounded = int((total + nearest / 2) // nearest) * nearest
    return t.replace(hour=0, minute=0) + timedelta(minutes=rounded)


@router.get("/payroll/rounding")
def get_rounding(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    return _rounding_cfg(db)


class RoundingIn(BaseModel):
    enabled: bool = True
    nearestMin: int = 5


@router.put("/payroll/rounding")
def set_rounding(body: RoundingIn, user: dict = Depends(require_administrator),
                 db: Session = Depends(get_db)):
    cfg = {"enabled": bool(body.enabled), "nearestMin": min(30, max(0, int(body.nearestMin)))}
    row = db.query(NexusSetting).filter(NexusSetting.key == _ROUNDING_KEY).first()
    if not row:
        row = NexusSetting(key=_ROUNDING_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    db.commit()
    return cfg


@router.get("/team-exceptions")
def team_exceptions(start: str = "", end: str = "",
                    user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Per-employee missing-punch + exception counts over [start,end] for the
    manager's visible team - powers the timecard's employee sidebar (M/E flags)."""
    rows = _team_rows(db, start, end, only_emails=_visible_emails(db, user))
    out = []
    for r in rows:
        missing = exc = 0
        for d in (r.get("days") or {}).values():
            for f in d.get("flags", []):
                if f == "missing_out":
                    missing += 1
                elif f in ("out_of_fence", "adjusted"):
                    exc += 1
        out.append({"email": r["email"], "name": r["name"], "workedMin": r["workedMin"],
                    "missing": missing, "exceptions": exc})
    return sorted(out, key=lambda x: (-(x["missing"] + x["exceptions"]), x["name"]))


def _compute_timecard(db: Session, em: str, start: str, end: str, round_min: Optional[int] = None) -> dict:
    """Per-day in/out segments, CA/federal overtime split, and wage totals off
    the HR-set hourly rate over [start, end]. Punch times are rounded per the
    SwipeClock-parity rule (_rounding_cfg - nearest 5 min by default) before any
    math; raw times ride along per segment for the unrounded view. Also
    aggregates break minutes and (when web capture ran) idle minutes so the
    timesheet can show a worked/break/idle composition bar."""
    # Fetch one day PAST `end` so a shift that starts on the last day and clocks
    # out after midnight still has its out-punch to pair with - otherwise that
    # whole overnight shift (in on `end`, out on `end`+1) would be dropped from
    # this period AND orphaned in the next, and the worker paid $0 for it. Days
    # after `end` are excluded from the emitted totals below.
    # (use strptime, not date.fromisoformat: the `for date in …` loop below shadows
    # the module-level `date` name across this whole function scope)
    _end_fetch = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d") if end else end
    punches = _live_punches(db, em, start, _end_fetch)
    # SwipeClock-parity rounding: rounded times drive ALL math below; the raw
    # punch strings are still emitted per segment so the UI can offer a
    # "show unrounded times" view, mirroring SwipeClock exactly.
    _rnd = _rounding_cfg(db)
    # round_min override: fixed-salary employees pass 0 (no rounding) since their pay
    # is day-based, not per-minute - nearest-5 rounding just makes real punch times
    # look wrong (e.g. 9:46 -> 9:45). Hourly keeps SwipeClock rounding (round_min=None).
    _rmin = round_min if round_min is not None else (_rnd["nearestMin"] if _rnd["enabled"] else 0)
    rate_row = db.query(PayrollRate).filter(PayrollRate.employee_email == em).first()
    rate = float(rate_row.hourly_rate) if rate_row else 0.0
    rule = (getattr(rate_row, "overtime_rule", None) or "ca") if rate_row else "ca"
    # A FINALIZED period is frozen at the rate + OT rule it was finalized with, so a
    # later raise or rule switch never retro-reprices an already-paid timecard
    # (finalize snapshots these into the approval row's note).
    _fin_snap = _finalized_row(db, em, start, end)
    if _fin_snap and _fin_snap.note:
        try:
            _sn = json.loads(_fin_snap.note)
            if isinstance(_sn, dict) and "rate" in _sn:
                rate = float(_sn.get("rate") or 0.0)
                rule = _sn.get("rule") or rule
        except Exception:   # noqa: BLE001 - a bad snapshot must not break the timecard
            pass
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == em).first()
    dept = (emp.department if emp else "") or ""

    days_out = []
    total_reg = total_ot = total_dt = total_break = missing_punches = 0
    edited_punches = sum(1 for p in punches if p.adjusted_by or p.edit_status == "approved")
    pending_edits = sum(1 for p in punches if p.edit_status == "pending")

    # Pair across the FULL ordered punch sequence - NOT bucketed per day - so a
    # shift that spans midnight (in one night, out the next morning) stays a single
    # segment. Each finished segment is attributed to the day the shift STARTED
    # (the in-punch's local_date), which is where a night worker expects their
    # hours to land.
    segs_by_day = {}   # local_date -> [segment, ...]
    open_in = open_in_at = open_in_at_r = open_in_id = open_in_date = None
    open_in_site = open_in_geo = open_in_site_id = open_in_cat = None
    open_in_note = ""
    open_in_pend = open_in_estat = open_in_ereason = open_in_adjnote = ""
    open_break = None
    brk = 0.0
    sflags = set()

    def _flush_missing():
        # An in that never got an out → record it as a missing_out on its own day.
        nonlocal missing_punches
        segs_by_day.setdefault(open_in_date, []).append(
            {"in": open_in_at, "out": "", "inR": open_in_at_r, "outR": "", "inId": open_in_id, "outId": "",
             "workedMin": 0, "flags": sorted(sflags | {"missing_out"}), "_break": int(round(brk)),
             "note": open_in_note,
             "workSite": open_in_site or "", "workSiteId": open_in_site_id or "", "geo": open_in_geo or "", "category": open_in_cat or "",
             "inPendingAt": open_in_pend, "inEditStatus": open_in_estat, "inEditReason": open_in_ereason,
             "outPendingAt": "", "outEditStatus": "", "outEditReason": "",
             "inAdjustNote": open_in_adjnote, "outAdjustNote": ""})
        missing_punches += 1

    for p in punches:
        t = _parse_iso(p.at)
        if t is None:
            continue
        if _rmin:
            t = _round_punch(t, _rmin)
        if p.kind == "in":
            if open_in is not None:      # a new in without an out closes the prior as missing
                _flush_missing()
            open_in, open_in_at, open_in_id, open_in_date = t, p.at, p.id, p.local_date
            open_in_at_r = t.strftime("%Y-%m-%dT%H:%M:%S")
            open_in_note = (p.note or "").strip()
            open_in_site, open_in_geo, open_in_site_id = (p.work_site_name or ""), (p.geo_status or ""), (p.work_site_id or "")
            open_in_cat = getattr(p, "category", "") or ""
            open_in_pend, open_in_estat, open_in_ereason = (p.pending_at or ""), (p.edit_status or ""), (p.edit_reason or "")
            open_in_adjnote = (p.adjust_note or "")
            open_break, brk, sflags = None, 0.0, set()
            if p.geo_status == "out_of_fence":
                sflags.add("out_of_fence")
            if p.source in ("manual", "self_manual"):
                sflags.add("manual")
            if p.adjusted_by:
                sflags.add("adjusted")
        elif p.kind == "out":
            if open_break is not None:
                brk += (t - open_break).total_seconds() / 60
                open_break = None
            if open_in is not None:
                if p.adjusted_by:
                    sflags.add("adjusted")
                mins = int(round((t - open_in).total_seconds() / 60 - brk))
                # Punch notes travel with the segment (SwipeClock shows them as a
                # note line under the day) - auto-generated edit notes excluded.
                _notes = " · ".join(n for n in (open_in_note, (p.note or "").strip())
                                    if n and n not in ("payroll edit",))
                segs_by_day.setdefault(open_in_date, []).append(
                    {"in": open_in_at, "out": p.at, "inR": open_in_at_r, "outR": t.strftime("%Y-%m-%dT%H:%M:%S"),
                     "inId": open_in_id, "outId": p.id,
                     "workedMin": max(0, mins), "flags": sorted(sflags), "_break": int(round(brk)),
                     "note": _notes,
                     "workSite": open_in_site or "", "workSiteId": open_in_site_id or "", "geo": open_in_geo or "", "category": open_in_cat or "",
                     "inPendingAt": open_in_pend, "inEditStatus": open_in_estat, "inEditReason": open_in_ereason,
                     "outPendingAt": (p.pending_at or ""), "outEditStatus": (p.edit_status or ""), "outEditReason": (p.edit_reason or ""),
                     "inAdjustNote": open_in_adjnote, "outAdjustNote": (p.adjust_note or "")})
                open_in = None
            # else: orphan out with no open in - ignored (its in was outside the range)
        elif p.kind == "break_start":
            if open_break is None and open_in is not None:
                open_break = t
        elif p.kind == "break_end":
            if open_break is not None:
                brk += (t - open_break).total_seconds() / 60
                open_break = None
    if open_in is not None:
        _flush_missing()

    # Auto-lunch: deduct a lunch from a long segment that recorded no break, before
    # any totals/overtime are computed (so the deduction flows through to pay).
    al = _autolunch_cfg(db)
    total_deducted = 0
    for segs in segs_by_day.values():
        for s in segs:
            ded = 0
            if al["enabled"] and al["deductMin"] and s.get("out") and \
               s["workedMin"] >= al["afterMin"] and int(s.get("_break", 0)) == 0:
                ded = min(al["deductMin"], s["workedMin"])
                s["workedMin"] -= ded
                total_deducted += ded
            s["deductedMin"] = ded

    # Per-day worked totals (from the paired segments), then apply the employee's
    # overtime law per workweek.
    day_total, day_break_m, day_segs = {}, {}, {}
    for d, segs in segs_by_day.items():
        if end and d > end:      # the extra fetched day only lends its out-punch
            continue
        day_total[d] = sum(s["workedMin"] for s in segs)
        day_break_m[d] = sum(s.pop("_break", 0) for s in segs)
        day_segs[d] = segs

    # Split each workweek (Sunday-anchored) into reg / ot@1.5x / dt@2x per day.
    by_week = {}
    for d in day_total:
        by_week.setdefault(_week_start_str(d), True)
    day_split = {}   # date -> (reg, ot, dt)
    for wk in by_week:
        wk0 = datetime.strptime(wk, "%Y-%m-%d")
        seq = [(wk0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
        for sd, split in zip(seq, _ot_split([day_total.get(s, 0) for s in seq], rule)):
            if sd in day_total:
                day_split[sd] = split

    for d in sorted(day_total):
        reg, ot, dt = day_split.get(d, (day_total[d], 0, 0))
        segs = day_segs[d]
        # Attribute the day's reg/ot/dt across its segments in worked order so the
        # per-segment amount stays sensible (overtime accrues on the later hours).
        rr, oo, dd = reg, ot, dt
        for seg in segs:
            wm = seg["workedMin"]
            s_reg = min(wm, rr); rr -= s_reg
            s_ot = min(wm - s_reg, oo); oo -= s_ot
            s_dt = min(wm - s_reg - s_ot, dd); dd -= s_dt
            seg["regMin"], seg["otMin"], seg["dtMin"] = s_reg, s_ot, s_dt
            seg["amount"] = round(s_reg / 60 * rate + s_ot / 60 * rate * _OT_MULT
                                  + s_dt / 60 * rate * _DT_MULT, 2)
        total_reg += reg; total_ot += ot; total_dt += dt
        total_break += day_break_m[d]
        days_out.append({"date": d, "weekStart": _week_start_str(d), "segments": segs,
                         "workedMin": reg + ot + dt, "regMin": reg, "otMin": ot, "dtMin": dt,
                         "breakMin": day_break_m[d]})

    reg_pay = round(total_reg / 60 * rate, 2)
    ot_pay = round(total_ot / 60 * rate * _OT_MULT, 2)
    dt_pay = round(total_dt / 60 * rate * _DT_MULT, 2)
    worked_min = total_reg + total_ot + total_dt

    # Idle estimate for the composition bar (best-effort, from web capture): a
    # frame whose idle-at-capture ≥ 4 min stands in for one capture interval of
    # idle time. Only meaningful while the browser capture was actively sharing;
    # 0 otherwise. Capped at worked so active never goes negative.
    interval_min = max(1, int(_get_policy(db).interval_minutes or 5))
    idle_frames = (db.query(TimeScreenshot)
                   .filter(TimeScreenshot.employee_email == em,
                           TimeScreenshot.local_date >= start, TimeScreenshot.local_date <= end,
                           TimeScreenshot.idle_sec >= 240).count())
    idle_min = min(worked_min, idle_frames * interval_min)
    active_min = max(0, worked_min - idle_min)

    # Job-costing subtotals - worked minutes + wage per category (SwipeClock cost
    # accounting). Uncategorised segments group under "Uncategorised".
    cat_agg = {}
    for d in days_out:
        for s in d["segments"]:
            c = (s.get("category") or "").strip() or "Uncategorised"
            a = cat_agg.setdefault(c, {"category": c, "workedMin": 0, "pay": 0.0})
            a["workedMin"] += s.get("workedMin", 0)
            a["pay"] = round(a["pay"] + (s.get("amount") or 0), 2)
    by_category = sorted(cat_agg.values(), key=lambda x: -x["workedMin"])

    # Pending add/remove punch requests in this window - surfaced ON the timecard
    # (grouped by their local date) so HR can approve/reject in-context, not only
    # from the separate Punch requests tab. Inline time EDITS already ride on their
    # segment; these are the add/remove asks that have no existing punch to attach to.
    preqs = (db.query(PunchRequest)
             .filter(PunchRequest.employee_email == em, PunchRequest.status == "pending",
                     PunchRequest.local_date >= start, PunchRequest.local_date <= end)
             .order_by(PunchRequest.at.asc()).all())
    pending_requests = [{"id": r.id, "action": r.action, "punchKind": r.punch_kind,
                         "at": r.at, "localDate": r.local_date, "reason": r.reason,
                         "targetPunchId": r.target_punch_id, "employeeName": r.employee_name,
                         "createdAt": r.created_at} for r in preqs]

    return {"email": em, "start": start, "end": end, "rate": rate, "rateSet": rate_row is not None,
            "dept": dept, "overtimeRule": rule, "days": days_out,
            "rounding": {"enabled": _rnd["enabled"], "nearestMin": _rnd["nearestMin"]},
            "autoLunch": {"enabled": al["enabled"], "afterMin": al["afterMin"], "deductMin": al["deductMin"]},
            "byCategory": by_category, "pendingRequests": pending_requests,
            "totals": {"regMin": total_reg, "otMin": total_ot, "dtMin": total_dt,
                       "regPay": reg_pay, "otPay": ot_pay, "dtPay": dt_pay,
                       "totalPay": round(reg_pay + ot_pay + dt_pay, 2),
                       "breakMin": total_break, "workedMin": worked_min, "deductedMin": total_deducted,
                       "activeMin": active_min, "idleMin": idle_min,
                       "missingPunches": missing_punches, "editedPunches": edited_punches,
                       "pendingEdits": pending_edits}}


@router.get("/payroll")
def payroll_timecard(email: str, start: str, end: str,
                     user: dict = Depends(require_team_read),
                     _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    """Manager timecard (incl. $ pay) for one employee - requires a fresh step-up
    MFA (require_stepup). See _compute_timecard."""
    em = email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    if _pay_type(db, em) == "fixed":
        # Fixed-salary employees are paid by the calendar month; `start` anchors it.
        card = _fixed_card(db, em, start or _employee_today(db, em))
        card.update(_signoff_state(db, em, card["periodStart"], card["periodEnd"]))
        return card
    card = _compute_timecard(db, em, start, end)
    card.update(_signoff_state(db, em, start, end))
    return card


@router.get("/my-payroll")
def my_payroll(start: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The signed-in employee's own bi-weekly timecard. `start` = a pay-period
    start date (Sunday); omit for the current period. Returns the period bounds,
    per-day rows, weekly-OT split, pay, and the worked/break/idle composition."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    anchor = start.strip() or today
    if _pay_type(db, user["email"]) == "fixed":
        # Default to the employee's LOCAL month, not the UTC one (boundary correctness).
        anchor = start.strip() or _employee_today(db, user["email"])
        card = _fixed_card(db, user["email"], anchor)
        card.update(_signoff_state(db, user["email"], card["periodStart"], card["periodEnd"]))
        return card
    p_start, p_end = _pay_period(anchor)
    card = _compute_timecard(db, user["email"], p_start, p_end)
    card.update(_signoff_state(db, user["email"], p_start, p_end))
    card["periodStart"], card["periodEnd"] = p_start, p_end
    card["periodDays"] = _PAYPERIOD_DAYS
    return card


class RateIn(BaseModel):
    email: str
    hourly_rate: Optional[float] = None
    overtime_rule: Optional[str] = None      # ca | federal | none (unchanged if omitted)
    pay_type: Optional[str] = None           # hourly | fixed
    currency: Optional[str] = None           # USD | INR
    monthly_salary: Optional[float] = None   # fixed pay: gross per month
    weekend_ot_amount: Optional[float] = None
    full_day_hours: Optional[float] = None


def _rate_dict(row) -> dict:
    """The compensation config, in the shape the wage editor loads and saves."""
    return {
        "hourlyRate": float(getattr(row, "hourly_rate", 0) or 0) if row else 0.0,
        "overtimeRule": (getattr(row, "overtime_rule", None) or "ca") if row else "ca",
        "payType": (getattr(row, "pay_type", None) or "hourly") if row else "hourly",
        "currency": (getattr(row, "currency", None) or "USD") if row else "USD",
        "monthlySalary": float(getattr(row, "monthly_salary", 0) or 0) if row else 0.0,
        "weekendOtAmount": float(getattr(row, "weekend_ot_amount", 0) or 0) if row else 0.0,
        "fullDayHours": float(getattr(row, "full_day_hours", 8) or 8) if row else 8.0,
        "isSet": row is not None,
    }


@router.get("/payroll/rate")
def get_payroll_rate(email: str, user: dict = Depends(require_team_read),
                     db: Session = Depends(get_db)):
    """The current compensation config for one employee, so the wage editor can
    pre-fill. Same visibility as the timecard (which already exposes the rate)."""
    em = email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    return _rate_dict(db.query(PayrollRate).filter(PayrollRate.employee_email == em).first())


@router.put("/payroll/rate")
def set_payroll_rate(body: RateIn, user: dict = Depends(require_team_write),
                     _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    em = body.email.strip().lower()
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    row = db.query(PayrollRate).filter(PayrollRate.employee_email == em).first()
    if not row:
        row = PayrollRate(employee_email=em)
        db.add(row)
    if body.hourly_rate is not None:
        row.hourly_rate = max(0.0, float(body.hourly_rate or 0))
    if body.overtime_rule in ("ca", "federal", "none"):
        row.overtime_rule = body.overtime_rule
    if body.pay_type in ("hourly", "fixed"):
        row.pay_type = body.pay_type
    if body.currency in ("USD", "INR"):
        row.currency = body.currency
    if body.monthly_salary is not None:
        row.monthly_salary = max(0.0, float(body.monthly_salary or 0))
    if body.weekend_ot_amount is not None:
        row.weekend_ot_amount = max(0.0, float(body.weekend_ot_amount or 0))
    if body.full_day_hours is not None:
        row.full_day_hours = max(1.0, float(body.full_day_hours or 8))
    row.updated_by = user["email"]
    row.updated_at = _now_iso()
    db.flush()                       # so the sync reads the just-updated rate
    sync_comp_from_rate(db, em)      # mirror pay amount/basis/currency into Pay & Benefits
    db.commit()
    return {"ok": True, **_rate_dict(row)}


# App/window-activity read endpoints (/my-activity, /activity-day, /activity)
# removed with the desktop agent - the browser capture records screenshots and an
# idle signal, not per-app foreground logs. Idle now surfaces in the timesheet
# composition bar via TimeScreenshot.idle_sec.


def _signed_url(path: str) -> str:
    try:
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{path}",
                       headers=_storage_headers(), json={"expiresIn": 3600}, timeout=20)
        if r.is_success:
            return f"{_SUPABASE_URL}/storage/v1{r.json().get('signedURL', '')}"
    except Exception:
        pass
    return ""


def _signed_urls(paths: list) -> dict:
    """Bulk-sign in ONE Supabase call (path -> full URL). The per-frame loop was
    one HTTP round-trip per screenshot, so opening a person's day of frames took
    10s+; this collapses it to a single request."""
    out = {}
    if not paths:
        return out
    try:
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}",
                       headers=_storage_headers(),
                       json={"expiresIn": 3600, "paths": paths}, timeout=30)
        if r.is_success:
            for row in r.json():
                if row.get("signedURL"):
                    out[row.get("path", "")] = f"{_SUPABASE_URL}/storage/v1{row['signedURL']}"
    except Exception:
        pass
    return out


# Desktop-agent installer hosting (/agent/download-url, /agent/upload-url,
# /agent/upload) removed - there is no desktop installer to host anymore.


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
    urls = _signed_urls([s.storage_path for s in rows])   # one call, not one per frame
    return {"date": day, "email": email, "shots": [
        {"id": s.id, "at": s.at, "idleSec": s.idle_sec or 0, "activeView": s.active_view or "",
         "url": urls.get(s.storage_path, "")} for s in rows]}


@router.get("/team-screenshots")
def team_screenshots(date: str = "", email: str = "",
                     user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    """Manager-scoped screenshot gallery - same shape as the admin /screenshots but
    limited to the caller's visible team (their reports), so a level-3 manager can
    review their own team without company-wide access."""
    visible = _visible_emails(db, user)   # None = whole company (admin/HR grant)
    day = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    q = db.query(TimeScreenshot).filter(TimeScreenshot.local_date == day)
    if visible is not None:
        if not visible:
            return {"date": day, "people": []}
        q = q.filter(TimeScreenshot.employee_email.in_(visible))
    if not email:
        counts = {}
        for s in q.all():
            counts[s.employee_email] = counts.get(s.employee_email, 0) + 1
        names = {e.work_email: f"{e.first_name} {e.last_name}".strip()
                 for e in db.query(NexusEmployee).all() if e.work_email}
        return {"date": day, "people": [
            {"email": em, "name": names.get(em) or em.split("@")[0].replace(".", " ").title(), "count": n}
            for em, n in sorted(counts.items())]}
    tgt = email.strip().lower()
    if visible is not None and tgt not in visible:
        raise HTTPException(403, "That employee isn't on your team.")
    rows = q.filter(TimeScreenshot.employee_email == tgt).order_by(TimeScreenshot.at).all()
    urls = _signed_urls([s.storage_path for s in rows])   # one call, not one per frame
    return {"date": day, "email": tgt, "shots": [
        {"id": s.id, "at": s.at, "idleSec": s.idle_sec or 0, "activeView": s.active_view or "",
         "url": urls.get(s.storage_path, "")} for s in rows]}


# ── Beginning-of-day message (recorded copy; Teams post happens client-side) ─

class BodIn(BaseModel):
    kind: Optional[str] = "bod"      # bod | eod
    message: str
    tasks: Optional[str] = ""
    team_id: Optional[str] = ""
    team_name: Optional[str] = ""
    channel_id: Optional[str] = ""
    channel_name: Optional[str] = ""
    sent: Optional[bool] = False
    send_error: Optional[str] = ""
    tz_offset_min: Optional[int] = 0


@router.post("/bod")
def record_bod(body: BodIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = _now_iso()
    row = TimeBod(id=str(uuid.uuid4()), employee_email=user["email"],
                  kind=body.kind if body.kind in ("bod", "eod", "break") else "bod",
                  local_date=_local_date(now, body.tz_offset_min or 0),
                  message=(body.message or "").strip()[:1000],
                  tasks=(body.tasks or "").strip()[:2000],
                  team_id=(body.team_id or "")[:80], team_name=(body.team_name or "")[:120],
                  channel_id=(body.channel_id or "")[:120], channel_name=(body.channel_name or "")[:120],
                  sent=1 if body.sent else 0, send_error=(body.send_error or "")[:300],
                  created_at=now)
    db.add(row)
    db.commit()
    return {"ok": True, "id": row.id}


@router.get("/bod/last")
def last_bod(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The employee's previous BOD post - prefills the channel picker."""
    row = (db.query(TimeBod).filter(TimeBod.employee_email == user["email"])
           .order_by(TimeBod.created_at.desc()).first())
    if not row:
        return None
    return {"teamId": row.team_id, "teamName": row.team_name,
            "channelId": row.channel_id, "channelName": row.channel_name}


# Sensible starters used until a person has posted their first BOD/EOD, after
# which their own last message becomes the template (industry-standard: the app
# remembers your standup format so you only tweak it each day).
_BOD_DEFAULTS = {
    "bod": {"message": "Good morning! Starting my day.",
            "tasks": ""},
    "eod": {"message": "Wrapping up for the day - here's what I worked on.",
            "tasks": ""},
}


@router.get("/bod/template")
def bod_template(kind: str = "bod", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Pre-fill text for the BOD/EOD composer: the employee's most recent post
    of this kind (their evolving personal template), or a starter default."""
    k = kind if kind in ("bod", "eod") else "bod"
    # Exclude the "already sent elsewhere" skip marker - it's a bookkeeping row,
    # not something to pre-fill back into the composer.
    row = (db.query(TimeBod)
           .filter(TimeBod.employee_email == user["email"], TimeBod.kind == k,
                   TimeBod.message != "(sent outside Nexus)")
           .order_by(TimeBod.created_at.desc()).first())
    if row and (row.message or row.tasks):
        return {"message": row.message or "", "tasks": row.tasks or "",
                "fromHistory": True}
    d = _BOD_DEFAULTS.get(k, _BOD_DEFAULTS["bod"])
    return {"message": d["message"], "tasks": d["tasks"], "fromHistory": False}


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
