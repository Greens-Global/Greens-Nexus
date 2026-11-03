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
# One-time placement (review of 11/03/2026): run ONCE (BACKFILL_MARK in
# nexus_settings, like the other one-time passes), the linked PROPERTY's
# entity first - the property is the job's place, the creator only says who
# typed it in - then the creator's company. A name two companies share
# (name or legal name) places nothing: guessing would put a job behind the
# wrong wall. Every placement is written to the job's activity log, and
# `dry_run` lists what it would do, for Neil to read on prod before release:
#     cd backend && python construction_company.py      (reads only)

BACKFILL_MARK = "construction_company_backfill_2026_11_03"
AMBIGUOUS = object()


def _entity_ids_by_name(db: Session) -> dict:
    """{name or legal name (lower): HrEntity id, or AMBIGUOUS when two
    companies answer to it}."""
    out = {}
    for e in db.query(models.HrEntity.id, models.HrEntity.name, models.HrEntity.legal_name).all():
        for n in {_key(e.name), _key(e.legal_name)} - {""}:
            if n in out and out[n] != e.id:
                out[n] = AMBIGUOUS
            else:
                out[n] = e.id
    return out


def company_from_property(db: Session, property_id: str, names: dict | None = None) -> str:
    """The company of an Asset Management property: its `entity` (a company
    name) matched to exactly one HrEntity. '' when the property names none we
    know, or a name more than one company carries."""
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
    hit = names.get(entity, "")
    return "" if hit is AMBIGUOUS else hit


def derive(db: Session, project, names: dict | None = None) -> tuple:
    """(company id, source) for a project: its property's entity, else its
    creator's company; ('', '') when neither places it."""
    from auth import company_of
    by_property = company_from_property(db, project.property_id, names)
    if by_property:
        return by_property, "property"
    by_creator = company_of(project.created_by or "", db) if project.created_by and project.created_by != "system" else ""
    return (by_creator, "creator") if by_creator else ("", "")


def _unplaced(db: Session) -> list:
    return (db.query(models.ConstructionProject)
            .filter((models.ConstructionProject.company_id == "") | (models.ConstructionProject.company_id.is_(None)))
            .order_by(models.ConstructionProject.name).all())


def dry_run(db: Session) -> dict:
    """What `backfill` would do, without writing: {"place": [{projectId,
    name, companyId, companyName, source}], "unplaced": [{projectId, name}]}."""
    names = _entity_ids_by_name(db)
    labels = {e.id: e.name for e in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    place, unplaced = [], []
    for p in _unplaced(db):
        cid, source = derive(db, p, names)
        if cid:
            place.append({"projectId": p.id, "name": p.name, "companyId": cid,
                          "companyName": labels.get(cid, cid), "source": source})
        else:
            unplaced.append({"projectId": p.id, "name": p.name})
    return {"place": place, "unplaced": unplaced}


def backfill(db: Session):
    """Place every job without a company, ONCE (the BACKFILL_MARK). Each
    placement gets an activity row. A job nothing places stays '' (visible
    only to unwalled callers). Commits. Returns how many were placed, or
    None when it had already run."""
    import uuid
    from datetime import datetime, timezone
    if db.query(models.NexusSetting).filter(models.NexusSetting.key == BACKFILL_MARK).first():
        return None
    plan = dry_run(db)
    now = datetime.now(timezone.utc).isoformat()
    rows = {p.id: p for p in _unplaced(db)}
    for item in plan["place"]:
        p = rows.get(item["projectId"])
        if p is None:
            continue
        p.company_id = item["companyId"]
        db.add(models.ConstructionActivity(
            id=str(uuid.uuid4()), project_id=p.id, entity_kind="project", entity_id=p.id,
            type="company_placed", actor_email="", at=now,
            detail=f"placed in {item['companyName']} (from the {item['source']})"))
    db.add(models.NexusSetting(key=BACKFILL_MARK, value=str(len(plan["place"])),
                               updated_by="system", updated_at=now))
    db.commit()
    return len(plan["place"])

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
    return week_start_for(local_today(db, project, now), week_starts(project))


def week_starts(project) -> int:
    """The project's first weekday (0=Sunday). A NULL keeps the scheduler's
    old reading of it - Sunday - so no week is cut twice under two starts."""
    v = getattr(project, "week_starts_on", None)
    return 0 if v is None else int(v)


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


if __name__ == "__main__":
    # Read-only: what the one-time placement would do on this database.
    #   cd backend && python construction_company.py
    from database import SessionLocal
    _db = SessionLocal()
    try:
        _plan = dry_run(_db)
        for _i in _plan["place"]:
            print(f"PLACE  {_i['name']}  ->  {_i['companyName']}  (from the {_i['source']})")
        for _i in _plan["unplaced"]:
            print(f"LEAVE  {_i['name']}  (nothing places it - stays visible only to unwalled callers)")
        print(f"{len(_plan['place'])} to place, {len(_plan['unplaced'])} left unplaced")
    finally:
        _db.close()
