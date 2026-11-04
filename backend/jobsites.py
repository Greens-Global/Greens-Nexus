"""Jobsites - where a shift is worked (Neil, call of 10/30/2026: the weather
follows the jobsite; Pranshu's decisions of 11/02/2026).

A shift's `jobsite` (models.ScheduledShift.jobsite) is:

    ''              the team's own work site - how every shift worked before
    'project-<id>'  a construction project (Construction)
    'site-<id>'     a company site (Settings > Locations, hr_work_sites)

It is picked per shift, so everyone on a team can be somewhere different
every day. The shift popup lists the active projects and the company sites,
plus "+ New Jobsite": a name and an address make a construction project in
one step (`create_project`), looked up like any other project's address.

Weather Watch and Weather Call key each band, notice and call on the team,
the day and the shift's PLACE (`Catalog.place_of`): the jobsite key when it
has a map point, '' (the team's site) otherwise - a project whose address
is missing or was not found borrows the team's weather, and the shift says
so (decision 1). A company site that IS the team's site is the team's site.

COMPANY WALLS (Neil, 11/03/2026): a construction project belongs to a
company (ConstructionProject.company_id). The picker (`options(user)`), a
shift's jobsite (`normalize(..., user)`) and "+ New Jobsite"'s same-address
match (`create_project(..., user)`) only ever see the caller's companies'
projects (auth.company_scope / company_ok) - never another company's site.
The weather lookups (`get`, `name`, `place_of`) read every place, because
a shift that already names a jobsite keeps its sky.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy.orm import Session

import models

PROJECT, SITE = "project-", "site-"
NO_POINT = "No address on file yet"


def _num(v):
    """A coordinate, or None for a blank / zero / unreadable one."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f or None


_NO_SCOPE = object()


def project_visible(db: Session, user, p, scope=_NO_SCOPE) -> bool:
    """May this caller pick (or match) this construction project? Its own
    people always may; anyone else only inside their company wall. Pass
    `scope` (auth.company_scope) when asking about many projects."""
    if user is None:
        return True
    import auth
    em = (user.get("email") or "").strip().lower()
    listed = {(e or "").strip().lower() for e in (p.manager_emails or []) + (p.worker_emails or [])}
    if em in listed:
        return True
    if scope is _NO_SCOPE:
        scope = auth.company_scope(user, db)
    return auth.company_ok(getattr(p, "company_id", "") or "", scope)


class Catalog:
    """Every jobsite a shift may name, read in two queries."""

    def __init__(self, db: Session):
        self.db = db
        self.places = {}
        self._active = []
        self._rows = {}
        self._scopes = {}
        P = models.ConstructionProject
        for p in db.query(P).filter(P.deleted_at == "").all():
            lat, lon = _num(p.latitude), _num(p.longitude)
            key = PROJECT + p.id
            self._rows[key] = p
            self.places[key] = SimpleNamespace(
                key=key, kind="project", name=p.name or "Project", where=(p.address or "").strip(),
                latitude=lat, longitude=lon, located=lat is not None and lon is not None)
            if (p.status or "active") == "active" and not p.archived:
                self._active.append(key)
        for s in db.query(models.HrWorkSite).all():
            lat, lon = _num(s.latitude), _num(s.longitude)
            key = SITE + s.id
            self.places[key] = SimpleNamespace(
                key=key, kind="site", name=s.name or "Site", where=(s.address or "").strip(),
                latitude=lat, longitude=lon, located=lat is not None and lon is not None)
            self._active.append(key)

    def get(self, key: str):
        return self.places.get(key or "")

    def name(self, key: str) -> str:
        p = self.get(key)
        return p.name if p is not None else ""

    def place_of(self, jobsite: str, team_site_id: str = "") -> str:
        """The weather place of a shift: its jobsite when that has a map
        point, else '' - the team's site."""
        j = (jobsite or "").strip()
        if not j or j == SITE + (team_site_id or ""):
            return ""
        p = self.places.get(j)
        return j if p is not None and p.located else ""

    def allowed(self, key: str, user=None) -> bool:
        """Is this place one `user` may name? A company site always; a
        project only inside the caller's company wall (or its own people)."""
        p = self._rows.get(key or "")
        if p is None or user is None:
            return True
        em = (user.get("email") or "").strip().lower()
        if em not in self._scopes:
            import auth
            self._scopes[em] = auth.company_scope(user, self.db)
        return project_visible(self.db, user, p, self._scopes[em])

    def options(self, user=None) -> list:
        """The shift popup's list: active projects first, then company sites -
        with `user`, only the projects of the caller's companies."""
        out = [{"id": k, "kind": p.kind, "name": p.name, "where": p.where, "located": p.located,
                "hint": "" if p.located else NO_POINT}
               for k in self._active for p in (self.places[k],) if self.allowed(k, user)]
        out.sort(key=lambda o: (o["kind"] != "project", o["name"].lower()))
        return out


def normalize(db: Session, value, user=None) -> str:
    """'' or a jobsite that exists (and, with `user`, one inside the caller's
    company wall); anything else is refused."""
    v = (value or "").strip()
    if not v:
        return ""
    cat = Catalog(db)
    if not (v.startswith(PROJECT) or v.startswith(SITE)) or cat.get(v) is None or not cat.allowed(v, user):
        raise ValueError("Pick a jobsite from the list.")
    return v


def create_project(db: Session, actor: str, name: str, address: str, latitude=None, longitude=None, user=None):
    """'+ New Jobsite': a construction project from a name and an address,
    with the creator as its manager - at the point its Google Maps link gave
    (`latitude` / `longitude`), else its address looked up for a map point.
    An active project at the same address (or with the same name) that the
    caller may see is returned instead of a second one - never another
    company's (11/03/2026). The new project lands in the creator's company.
    The caller commits."""
    import construction_weather
    name, address = (name or "").strip()[:120], (address or "").strip()[:300]
    if not name:
        raise ValueError("Give the jobsite a name.")
    lat, lon = _num(latitude), _num(longitude)
    if not address and (lat is None or lon is None):
        raise ValueError("Paste the jobsite's Google Maps link, so its weather is read at the right spot.")
    P = models.ConstructionProject
    scope = _NO_SCOPE
    if user is not None:
        import auth
        scope = auth.company_scope(user, db)
    for p in db.query(P).filter(P.deleted_at == "", P.archived == False).all():   # noqa: E712 - SQLAlchemy expression
        if not project_visible(db, user, p, scope):
            continue
        if (address and (p.address or "").strip().lower() == address.lower()) or (p.name or "").strip().lower() == name.lower():
            return p
    import auth
    now = datetime.now(timezone.utc).isoformat()
    p = P(id=str(uuid.uuid4()), name=name, address=address, status="active", manager_emails=[actor],
          worker_emails=[], executive_emails=[], latitude=lat or 0.0, longitude=lon or 0.0, created_by=actor,
          created_at=now, modified_at=now, company_id=auth.company_of(actor, db))
    if lat is None or lon is None:
        construction_weather.geocode(p)
    db.add(p)
    db.add(models.ConstructionActivity(id=str(uuid.uuid4()), project_id=p.id, entity_kind="project", entity_id=p.id,
                                       type="created", actor_email=actor, at=now,
                                       detail="created this project as a jobsite from Shifts"))
    return p
