"""Construction - a job's company and its jobsite clock (Neil, 11/03/2026,
plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 1).

COMPANY. Every construction project carries `company_id`, the HrEntity it
belongs to, and every construction read and write checks it through the
one wall the rest of Nexus uses (auth.company_scope / company_ok): a
manager in one company never sees, reviews or publishes another company's
job. A new job is stamped with its creator's company; older jobs are filled
once at startup by `backfill` - from the creator's company, else from the
linked Asset Management property's entity (matched to a company by name).
A job nothing can place keeps '' and is visible only to callers the walls
do not confine (company_ok's default for an untagged record).

CLOCK. A jobsite keeps its own time zone (`time_zone`), read from its
forecast - Open-Meteo answers the zone of the point (routers/weather.py
asks for timezone=auto). Until a forecast has been read, the company's team
zone stands in (shift_expect.team_tz). A daily log's date, "today" on the
screens and the weekly report's week are all cut on this one clock.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func
from sqlalchemy.orm import Session

import models


def _key(s) -> str:
    return (s or "").strip().lower()


# ── Company ──────────────────────────────────────────────────────────────────

def _entity_ids_by_name(db: Session) -> dict:
    """{name or legal name (lower): HrEntity id}."""
    out = {}
    for e in db.query(models.HrEntity.id, models.HrEntity.name, models.HrEntity.legal_name).all():
        for n in (e.name, e.legal_name):
            if _key(n):
                out.setdefault(_key(n), e.id)
    return out


def company_from_property(db: Session, property_id: str, names: dict | None = None) -> str:
    """The company of an Asset Management property: its `entity` (a company
    name) matched to an HrEntity. '' when the property names none we know."""
    pid = (property_id or "").strip()
    if not pid:
        return ""
    prop = db.get(models.PropertyAsset, pid)
    if prop is None:
        return ""
    entity = _key((prop.payload or {}).get("entity"))
    if not entity:
        return ""
    names = names if names is not None else _entity_ids_by_name(db)
    return names.get(entity, "")


def derive(db: Session, project, names: dict | None = None) -> str:
    """The company a project belongs to: its creator's, else its property's."""
    from auth import company_of
    by_creator = company_of(project.created_by or "", db) if project.created_by and project.created_by != "system" else ""
    return by_creator or company_from_property(db, project.property_id, names)


def backfill(db: Session) -> int:
    """Stamp every project still without a company that can be placed.
    Idempotent: a placed project is never touched again, an unplaceable one
    stays '' and is tried again next startup. Commits. Returns how many."""
    rows = (db.query(models.ConstructionProject)
            .filter((models.ConstructionProject.company_id == "") | (models.ConstructionProject.company_id.is_(None)))
            .all())
    if not rows:
        return 0
    names = _entity_ids_by_name(db)
    n = 0
    for p in rows:
        cid = derive(db, p, names)
        if cid:
            p.company_id = cid
            n += 1
    if n:
        db.commit()
    return n


# ── Clock ────────────────────────────────────────────────────────────────────

def _valid(tz: str) -> bool:
    try:
        ZoneInfo(tz)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


def zone_of(db: Session, project) -> str:
    """The jobsite's IANA zone: its own (from its forecast), else its
    company's team zone, else the tenant's (shift_expect.team_tz)."""
    tz = (getattr(project, "time_zone", "") or "").strip()
    if tz and _valid(tz):
        return tz
    try:
        from shift_expect import team_tz
        return team_tz(db, getattr(project, "company_id", "") or "")
    except Exception:   # noqa: BLE001 - a clock that cannot be read is the default clock
        return "America/Los_Angeles"


def local_today(db: Session, project, now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(ZoneInfo(zone_of(db, project))).date()


def model_weekday(d: date) -> int:
    """0=Sunday..6=Saturday (ConstructionProject's count)."""
    return (d.weekday() + 1) % 7


def week_start_for(d: date, week_starts_on: int) -> date:
    """The first day of the week `d` falls in, for a project whose week
    begins on `week_starts_on` (0=Sunday..6=Saturday)."""
    back = (model_weekday(d) - (week_starts_on or 0)) % 7
    return d - timedelta(days=back)


def current_week_start(db: Session, project, now: datetime | None = None) -> date:
    """THE week rule (11/03/2026): the project's week_starts_on, on the
    jobsite's own clock - the scheduler and the Generate button both use it."""
    return week_start_for(local_today(db, project, now), project.week_starts_on if project.week_starts_on is not None else 1)


def remember_zone(project, tz: str) -> bool:
    """Keep the zone a forecast answered for this jobsite. True when changed."""
    tz = (tz or "").strip()
    if not tz or not _valid(tz):
        return False
    if (project.time_zone or "") == tz:
        return False
    project.time_zone = tz
    return True


def people_names(db: Session, emails) -> dict:
    """{email(lower): "First Last"} for the Nexus People among `emails` - so a
    screen shows names, never raw addresses (one query)."""
    ems = {_key(e) for e in (emails or []) if _key(e)}
    if not ems:
        return {}
    E = models.NexusEmployee
    out = {}
    for row in db.query(E.work_email, E.first_name, E.last_name).filter(func.lower(E.work_email).in_(ems)).all():
        name = f"{row.first_name or ''} {row.last_name or ''}".strip()
        if name:
            out[_key(row.work_email)] = name
    return out
