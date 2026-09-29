"""Workforce Analytics team views (Neil, Sep 29: "we also want there to be a
view that can be saved and customized here with custom views based on
different teams ... not every manager cares to see every employee").

A view is a person's own saved, named team filter over the Workforce
Analytics screens (Coverage, Locations, Activity, Screenshots). It picks WHO
shows up; it never changes what the viewer is allowed to see:

- Every endpoint resolves members through `_visible_emails` - the same scope
  the monitoring/locations endpoints already apply - so a view can only
  narrow the caller's existing audience, never widen it. The option lists
  (companies, departments, managers...) are drawn from that scope too, so
  building a view reveals nothing about people outside it.
- Members resolve at read time: a new hire in a saved department appears in
  the view without anyone editing it.

Storage: `dashboard_views` rows with target='workforce' (personal scope; the
criteria live in the JSON `layout` column). The dashboard routes only ever
read target='dashboard', so these rows never mix into a dashboard picker -
and the table already has RLS on dev and prod, so no new table to secure.

Matching rule (shown in the editor): a person is in the view when they match
EVERY team filter that is set (companies AND departments AND locations AND
reporting line AND shift groups; any value within one filter), plus anyone
picked by name. A view with only names is exactly those people.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from routers.timeclock import _visible_emails, require_tracking_read

router = APIRouter(prefix="/timeclock/workforce-views", tags=["Workforce Views"])

TARGET = "workforce"
MAX_VIEWS = 50          # per person - a picker, not a database
MAX_LIST = 500          # values in one criteria list
DIMENSIONS = ("companies", "departments", "locations", "managers", "shiftGroups", "people")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_criteria(raw) -> dict:
    """Only known keys, only non-empty strings, de-duplicated, capped. Emails
    are lower-cased so matching never depends on how a name was typed."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key in DIMENSIONS:
        vals = raw.get(key) or []
        if not isinstance(vals, list):
            vals = []
        seen, clean = set(), []
        for v in vals:
            if not isinstance(v, str):
                continue
            v = v.strip()[:200]
            if key in ("managers", "people"):
                v = v.lower()
            if v and v not in seen:
                seen.add(v)
                clean.append(v)
        out[key] = clean[:MAX_LIST]
    return out


def _roster(db: Session, user: dict):
    """The caller's visible, active people: {email: NexusEmployee}. The same
    audience the monitoring and locations endpoints serve."""
    scope = _visible_emails(db, user)
    people = {}
    for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.status == "active").all():
        em = (e.work_email or "").lower()
        if em and (scope is None or em in scope):
            people[em] = e
    return people


def _org(db: Session) -> dict:
    """manager email -> their direct reports' emails, over ALL active people."""
    by_mgr = {}
    for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.status == "active").all():
        em, mgr = (e.work_email or "").lower(), (e.manager_email or "").lower()
        if em and mgr:
            by_mgr.setdefault(mgr, []).append(em)
    return by_mgr


def _line(by_mgr: dict, managers: List[str]) -> set:
    """Everyone in each manager's reporting line - direct AND indirect - so
    "reports to Sam" means Sam's whole team, the way a manager thinks of it.
    Walks the whole org chart (a report two levels down is still Sam's even
    when the level between is someone the caller can't see); the caller's
    scope is applied afterwards."""
    out, stack = set(), [m.lower() for m in managers]
    while stack:
        for em in by_mgr.get(stack.pop(), []):
            if em not in out:
                out.add(em)
                stack.append(em)
    return out


def _resolve(db: Session, roster: dict, criteria: dict) -> List[str]:
    """Emails a view covers, inside the caller's roster only."""
    c = _clean_criteria(criteria)
    team_set = any(c[k] for k in ("companies", "departments", "locations", "managers", "shiftGroups"))
    members = set()
    if team_set:
        in_line = _line(_org(db), c["managers"]) if c["managers"] else None
        in_groups = None
        if c["shiftGroups"]:
            in_groups = {(m.employee_email or "").lower() for m in db.query(models.ShiftGroupMember)
                         .filter(models.ShiftGroupMember.group_id.in_(c["shiftGroups"])).all()}
        companies, depts, locs = set(c["companies"]), set(c["departments"]), set(c["locations"])
        for em, e in roster.items():
            if companies and (e.company or "") not in companies:
                continue
            if depts and (e.department or "") not in depts:
                continue
            if locs and (e.location or "") not in locs:
                continue
            if in_line is not None and em not in in_line:
                continue
            if in_groups is not None and em not in in_groups:
                continue
            members.add(em)
    members |= {em for em in c["people"] if em in roster}
    return sorted(members)


def _view_dict(v: models.DashboardView, emails: List[str]) -> dict:
    return {
        "id": v.id, "name": v.name, "isDefault": bool(v.is_default),
        "criteria": _clean_criteria(v.layout), "emails": emails, "count": len(emails),
        "updatedAt": v.updated_at or "",
    }


def _mine(db: Session, email: str):
    return (db.query(models.DashboardView)
            .filter(models.DashboardView.owner_email == email,
                    models.DashboardView.target == TARGET,
                    models.DashboardView.scope == "personal")
            .order_by(models.DashboardView.created_at))


def _own(db: Session, view_id: str, email: str) -> models.DashboardView:
    v = _mine(db, email).filter(models.DashboardView.id == view_id).first()
    if not v:
        raise HTTPException(404, "View not found")
    return v


def _clear_defaults(db: Session, email: str):
    for row in _mine(db, email).filter(models.DashboardView.is_default.is_(True)).all():
        row.is_default = False


@router.get("")
def list_views(user: dict = Depends(require_tracking_read), db: Session = Depends(get_db)):
    """The caller's views, each with its members resolved inside their scope."""
    roster = _roster(db, user)
    return {"views": [_view_dict(v, _resolve(db, roster, v.layout)) for v in _mine(db, user["email"]).all()]}


@router.get("/options")
def view_options(user: dict = Depends(require_tracking_read), db: Session = Depends(get_db)):
    """What a view can be built from - all drawn from the caller's own scope."""
    roster = _roster(db, user)
    ents = {e.id: e.name for e in db.query(models.HrEntity).all()}
    companies, departments, locations = {}, {}, {}
    for e in roster.values():
        if e.company:
            companies[e.company] = companies.get(e.company, 0) + 1
        if e.department:
            departments[e.department] = departments.get(e.department, 0) + 1
        if e.location:
            locations[e.location] = locations.get(e.location, 0) + 1
    # Managers: anyone with at least one visible person in their line.
    mgr_counts = {}
    for em, e in roster.items():
        mgr = (e.manager_email or "").lower()
        if mgr:
            mgr_counts[mgr] = mgr_counts.get(mgr, 0) + 1
    # A manager with a role but no People record still shows by name.
    names = {(r.email or "").lower(): r.display_name for r in db.query(models.NexusRole).all() if r.display_name}
    names.update({(e.work_email or "").lower(): (e.display_name or f"{e.first_name} {e.last_name}".strip())
                  for e in db.query(models.NexusEmployee).all() if e.work_email})
    managers, org, visible = [], _org(db), set(roster)
    for mgr in mgr_counts:
        line = _line(org, [mgr]) & visible
        managers.append({"email": mgr, "name": names.get(mgr) or mgr, "count": len(line)})
    by_group = {}
    for m in db.query(models.ShiftGroupMember).all():
        by_group.setdefault(m.group_id, set()).add((m.employee_email or "").lower())
    groups = []
    for g in db.query(models.ShiftGroup).all():
        members = by_group.get(g.id, set()) & visible
        if members:
            groups.append({"id": g.id, "name": g.name, "count": len(members)})
    by_name = lambda d: sorted(d, key=lambda x: (x["name"] or "").lower())
    return {
        "companies": by_name([{"id": k, "name": ents.get(k) or k, "count": n} for k, n in companies.items()]),
        "departments": by_name([{"id": k, "name": k, "count": n} for k, n in departments.items()]),
        "locations": by_name([{"id": k, "name": k, "count": n} for k, n in locations.items()]),
        "managers": by_name(managers),
        "shiftGroups": by_name(groups),
        "people": by_name([{"email": em, "name": names.get(em) or em, "department": e.department or "",
                            "jobTitle": e.job_title or ""} for em, e in roster.items()]),
    }


class PreviewIn(BaseModel):
    criteria: dict = {}


@router.post("/preview")
def preview(body: PreviewIn, user: dict = Depends(require_tracking_read), db: Session = Depends(get_db)):
    """Who a draft view would show - the editor's live match count."""
    emails = _resolve(db, _roster(db, user), body.criteria)
    return {"emails": emails, "count": len(emails)}


class ViewIn(BaseModel):
    name: str
    criteria: dict = {}
    isDefault: Optional[bool] = False


class ViewUpdate(BaseModel):
    name: Optional[str] = None
    criteria: Optional[dict] = None
    isDefault: Optional[bool] = None


def _name(raw: Optional[str]) -> str:
    n = (raw or "").strip()[:80]
    if not n:
        raise HTTPException(400, "Give the view a name.")
    return n


@router.post("")
def create_view(body: ViewIn, user: dict = Depends(require_tracking_read), db: Session = Depends(get_db)):
    email = user["email"]
    if _mine(db, email).count() >= MAX_VIEWS:
        raise HTTPException(400, f"You can keep up to {MAX_VIEWS} views - delete one first.")
    if body.isDefault:
        _clear_defaults(db, email)
    v = models.DashboardView(
        id=str(uuid.uuid4()), owner_email=email, target=TARGET, name=_name(body.name),
        scope="personal", department="", layout=_clean_criteria(body.criteria),
        is_default=bool(body.isDefault), created_by=email, created_at=_now(), updated_at=_now())
    db.add(v)
    db.commit()
    return _view_dict(v, _resolve(db, _roster(db, user), v.layout))


@router.put("/{view_id}")
def update_view(view_id: str, body: ViewUpdate, user: dict = Depends(require_tracking_read),
                db: Session = Depends(get_db)):
    v = _own(db, view_id, user["email"])
    if body.name is not None:
        v.name = _name(body.name)
    if body.criteria is not None:
        v.layout = _clean_criteria(body.criteria)
    if body.isDefault is not None:
        if body.isDefault:
            _clear_defaults(db, user["email"])
        v.is_default = bool(body.isDefault)
    v.updated_at = _now()
    db.commit()
    return _view_dict(v, _resolve(db, _roster(db, user), v.layout))


@router.delete("/{view_id}")
def delete_view(view_id: str, user: dict = Depends(require_tracking_read), db: Session = Depends(get_db)):
    v = _own(db, view_id, user["email"])
    db.delete(v)
    db.commit()
    return {"ok": True}
