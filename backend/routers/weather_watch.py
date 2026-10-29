"""Weather Alerts settings and the manual check (Weather Call, Oct 2026) -
the API face of weather_watch.py. Settings > Shifts > Weather Alerts.

Company-wide switches, like shift groups and shift settings: a manager
with company-wide team access changes them (_require_unscoped_team)."""
import json
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import weather_scope
import weather_watch
from database import get_db
from routers.timeclock import require_shift_manage, _require_unscoped_team

router = APIRouter(prefix="/weather-watch", tags=["weather-watch"])


def _settings_payload(db: Session, cfg: dict) -> dict:
    # Which groups the watch covers per company, with the switch ignored, so
    # the screen can say "3 groups ready" before a company is turned on. Only
    # groups with someone in a department with Weather Calls on count at all
    # (weather_scope, 10/29/2026) - an office team is not "not ready", it is
    # simply not a weather team.
    sc = weather_scope.WeatherScope(db, cfg)
    ready: dict = {}
    unready: dict = {}
    for g in sc.groups:
        why = sc.why_not(g)
        if why in ("archived", "departments"):
            continue
        cid = sc.company_of(g)
        (ready if why in ("", "company") else unready).setdefault(cid, []).append(g.name)
    companies = [{"id": e.id, "name": e.name, "enabled": weather_watch.company_enabled(cfg, e.id),
                  "groupsReady": sorted(ready.get(e.id, [])), "groupsNotReady": sorted(unready.get(e.id, [])),
                  # Who the weather applies to (Settings > Companies > Departments).
                  "weatherDepartments": sc.departments_on(e.id)}
                 for e in db.query(models.HrEntity).order_by(models.HrEntity.name).all()]
    last = (db.query(models.WeatherAdvisory).order_by(models.WeatherAdvisory.created_at.desc()).first())
    return {"config": cfg, "companies": companies,
            "lastAdvisoryAt": last.created_at if last else "",
            "untaggedGroups": sorted(ready.get("", []) + unready.get("", []))}


@router.get("/settings")
def get_settings(user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    _require_unscoped_team(user, db, "Weather alert settings")
    return _settings_payload(db, weather_watch.get_config(db))


class SettingsIn(BaseModel):
    companies: Optional[Dict[str, bool]] = None   # merged: {entity id: on}
    majorChance: Optional[float] = None
    majorInches: Optional[float] = None
    anyChanceInches: Optional[float] = None
    headsUpChance: Optional[float] = None
    headsUpInches: Optional[float] = None
    stormChance: Optional[float] = None
    quietStart: Optional[str] = None
    quietEnd: Optional[str] = None
    headsUpTeams: Optional[bool] = None
    smsDefault: Optional[bool] = None


@router.put("/settings")
def save_settings(body: SettingsIn, user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    _require_unscoped_team(user, db, "Weather alert settings")
    try:
        cfg = weather_watch.save_config(db, body.model_dump(exclude_none=True), user["email"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _settings_payload(db, cfg)


@router.post("/scan")
def scan_now(user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    """Check Now: one pass of the watch, right away (plain def - the
    outbound HTTP runs in FastAPI's threadpool)."""
    _require_unscoped_team(user, db, "Running a weather check")
    return weather_watch.scan_once(db)


@router.get("/advisories")
def list_advisories(group_id: str = "", limit: int = 50, user: dict = Depends(require_shift_manage),
                    db: Session = Depends(get_db)):
    """The record: what was sent, when, to whom, and where it went."""
    _require_unscoped_team(user, db, "The weather record")
    q = db.query(models.WeatherAdvisory).order_by(models.WeatherAdvisory.created_at.desc())
    if group_id.strip():
        q = q.filter(models.WeatherAdvisory.group_id == group_id.strip())
    names = {g.id: g.name for g in db.query(models.ShiftGroup).all()}
    out = []
    for r in q.limit(max(1, min(200, limit))).all():
        def _j(s, d):
            try:
                return json.loads(s or "") if s else d
            except (TypeError, ValueError):
                return d
        out.append({"id": r.id, "groupId": r.group_id, "groupName": names.get(r.group_id, ""), "date": r.work_date,
                    "band": r.band, "chance": int(r.chance or 0), "inches": float(r.inches or 0), "storm": bool(r.storm),
                    "alerts": _j(r.alerts_json, []), "windowStart": r.window_start or "", "windowEnd": r.window_end or "",
                    "recipients": _j(r.recipients_json, []), "channels": _j(r.channels_json, {}), "createdAt": r.created_at})
    return {"advisories": out}
