"""Weather by department (Neil, 10/29/2026): "Weather changes should only
affect certain departments. For example construction... It's universal by
default and that's messy."

ONE rule, read by every place weather touches people:

  - A PERSON is in scope when their company + department string match a
    department (hr_departments, Settings > Companies > Departments) with
    Weather Calls on. No department, or one the company does not have, is
    off.
  - A GROUP is watched when its company is switched on in Settings > Shifts
    & Scheduling > Weather Alerts, the group's own alerts switch is on, it
    has a work site with coordinates, and at least one active member is a
    person in scope.

The advisory scan, the outlook the schedule grid reads, the Weather Call
roster and its notices all go through here (weather_watch.py,
weather_call.py, routers/weather_call.py, routers/weather_watch.py,
routers/timeclock.read_schedule). A group or person outside it simply gets
no weather data, so the screens show nothing.

Departments start OFF except the ones named like "Construction": existing
rows are seeded once at startup (seed_weather_departments, marked in
nexus_settings so an administrator who turns Construction off is never
overridden), new rows by models.HrDepartment's before_insert hook.

Reads are batched - a handful of queries per scope, never one per person or
group - and cached on the session (`scope(db)`) until it commits or rolls
back, so one request or one scan tick reads them once.
"""
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.orm import Session

import models

SEED_KEY = "weather_departments_seeded"
_INFO_KEY = "weather_scope"

# Why a group is not watched -> what the Weather Call says (403).
OFF_DEPARTMENTS = ("Weather calls are off for this team's departments. "
                   "Turn them on in Settings > Companies > Departments.")
REASONS = {
    "departments": OFF_DEPARTMENTS,
    "company": "Weather alerts are off for this team's company. Turn them on in Settings > Shifts & Scheduling > Weather Alerts.",
    "alerts": "Weather alerts are off for this team. Turn them on in Settings > Shifts & Scheduling > Groups.",
    "site": "This team has no work site with a location, so the weather is not watched for it. Set one in Settings > Shifts & Scheduling > Groups.",
    "archived": "This team is archived.",
}


def _key(s) -> str:
    return (s or "").strip().lower()


def default_for(name: str) -> int:
    """What a department starts at: on only when its name says construction."""
    return 1 if "construction" in _key(name) else 0


class WeatherScope:
    """The rule over one snapshot of the data. Everything loads lazily, each
    in one query."""

    def __init__(self, db: Session, cfg: dict = None):
        self.db = db
        self._cfg = cfg
        self._depts = None      # {(company_id, department key)} with Weather Calls on
        self._dept_of = None    # {email: (company_id, department key)} for everyone
        self._active = None     # weather_watch._people: active, not deleted
        self._members = None    # {group_id: [emails]}
        self._sites = None      # {site id: HrWorkSite}
        self._groups = None     # [ShiftGroup]
        self._company = {}      # {group_id: company id}

    # ── loads ─────────────────────────────────────────────────────────────
    @property
    def cfg(self) -> dict:
        if self._cfg is None:
            import weather_watch
            self._cfg = weather_watch.get_config(self.db)
        return self._cfg

    @property
    def depts(self) -> set:
        if self._depts is None:
            rows = (self.db.query(models.HrDepartment.company_id, models.HrDepartment.name)
                    .filter(models.HrDepartment.weather == 1).all())
            self._depts = {(c or "", _key(n)) for c, n in rows if _key(n)}
        return self._depts

    @property
    def dept_of(self) -> dict:
        if self._dept_of is None:
            E = models.NexusEmployee
            self._dept_of = {_key(em): (c or "", _key(d))
                             for em, c, d in self.db.query(E.work_email, E.company, E.department).all() if em}
        return self._dept_of

    @property
    def active(self) -> dict:
        if self._active is None:
            import weather_watch
            self._active = weather_watch._people(self.db)
        return self._active

    def members(self, group_id: str) -> list:
        if self._members is None:
            self._members = {}
            for gid, em in self.db.query(models.ShiftGroupMember.group_id, models.ShiftGroupMember.employee_email).all():
                self._members.setdefault(gid, []).append(_key(em))
        return self._members.get(group_id, [])

    def site(self, g):
        if self._sites is None:
            self._sites = {s.id: s for s in self.db.query(models.HrWorkSite).all()}
        return self._sites.get(getattr(g, "work_site_id", "") or "")

    @property
    def groups(self) -> list:
        if self._groups is None:
            self._groups = self.db.query(models.ShiftGroup).all()
        return self._groups

    # ── people ────────────────────────────────────────────────────────────
    def person_on(self, email: str) -> bool:
        hit = self.dept_of.get(_key(email))
        return bool(hit and hit[1] and hit in self.depts)

    def people_on(self, emails) -> set:
        return {_key(e) for e in (emails or ()) if self.person_on(e)}

    # ── groups ────────────────────────────────────────────────────────────
    def has_weather_people(self, group_id: str) -> bool:
        """At least one ACTIVE member is in a weather department."""
        return any(em in self.active and self.person_on(em) for em in self.members(group_id))

    def company_of(self, g) -> str:
        if g.id not in self._company:
            import weather_watch
            self._company[g.id] = weather_watch.group_company(self.db, g, self.members(g.id), self.active)
        return self._company[g.id]

    def why_not(self, g) -> str:
        """'' when the group is watched, else the first reason it is not
        (a key of REASONS)."""
        if getattr(g, "archived", 0):
            return "archived"
        if not self.has_weather_people(g.id):
            return "departments"   # first: an office team is simply not a weather team
        alerts = getattr(g, "weather_alerts", 1)
        if not int(alerts if alerts is not None else 1):
            return "alerts"
        site = self.site(g)
        if not site or not (site.latitude or "").strip() or not (site.longitude or "").strip():
            return "site"
        import weather_watch
        if not weather_watch.company_enabled(self.cfg, self.company_of(g)):
            return "company"
        return ""

    def watched(self, g) -> bool:
        return not self.why_not(g)

    def watched_ids(self) -> set:
        return {g.id for g in self.groups if self.watched(g)}

    def departments_on(self, company_id: str) -> list:
        """The names of a company's departments with Weather Calls on."""
        rows = (self.db.query(models.HrDepartment.name)
                .filter(models.HrDepartment.company_id == (company_id or ""), models.HrDepartment.weather == 1)
                .order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all())
        return [n for (n,) in rows if (n or "").strip()]


# ── The session cache: one scope per request / tick ───────────────────────

def scope(db: Session) -> WeatherScope:
    sc = db.info.get(_INFO_KEY)
    if sc is None:
        sc = db.info[_INFO_KEY] = WeatherScope(db)
    return sc


def _forget(session, *_):
    session.info.pop(_INFO_KEY, None)


# A write (a department switched, a person moved, a group edited) is seen by
# the next read: the cached scope goes whenever its session commits or rolls back.
event.listen(Session, "after_commit", _forget)
event.listen(Session, "after_rollback", _forget)


# ── The helpers the rest of Nexus calls ───────────────────────────────────

def person_in_weather_department(db: Session, email: str) -> bool:
    return scope(db).person_on(email)


def weather_people(db: Session, emails) -> set:
    return scope(db).people_on(emails)


def group_watched(db: Session, group) -> bool:
    return scope(db).watched(group)


def why_not_watched(db: Session, group) -> str:
    """'' when watched, else the sentence to show (REASONS)."""
    why = scope(db).why_not(group)
    return REASONS.get(why, "") if why else ""


# ── The one-time default ──────────────────────────────────────────────────

def seed_weather_departments(db: Session):
    """Weather Calls on for every department named like "Construction", off
    for the rest - ONCE. Returns how many were turned on, or None when it had
    already run (the marker), so a later admin choice is never overridden."""
    if db.query(models.NexusSetting).filter(models.NexusSetting.key == SEED_KEY).first():
        return None
    n = 0
    for d in db.query(models.HrDepartment).all():
        want = default_for(d.name)
        if int(d.weather or 0) != want:
            d.weather = want
        n += want
    db.add(models.NexusSetting(key=SEED_KEY, value="1", updated_by="system",
                               updated_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    return n
