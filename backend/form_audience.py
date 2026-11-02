"""Who may fill a form, and who may see its entries (Forms & Checklists,
Neil 11/02/2026 - spec docs/superpowers/specs/2026-11-02-forms-design.md).

ONE audience rule, shared with Announcements (`in_audience`):
  - 'company'    -> everyone in the company (a form's company is its
                    creator's; blank on either side = shared)
  - 'department' -> people whose nexus_employees.department matches
  - 'site'       -> people whose allowed work sites (routers.hr.allowed_site_ids)
                    include the site; no allowed sites = not a site member
Externals, guests and people who left are never in an audience; an
administrator may fill anything (they manage it).

Who sees entries (`viewer_reach`, Review Focus 5):
  - the submitter, their own
  - a manager: entries by anyone in their reporting line (auth.team_emails,
    backups included) AND entries at their teams' sites - the work sites of
    the shift groups they schedule or that one of their people belongs to
  - HR++ for the entry's company (hr_access.is_hr_for_company)
  - administrators, everything
  - the company walls (auth.company_scope) apply on top of all of the above
Reviewing is seeing minus your own entry: nobody reviews their own form.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
from models import DocTemplate, NexusEmployee, ShiftGroup, ShiftGroupMember

AUDIENCES = ("company", "department", "site")
_ADMIN_LEVEL = 4
_GONE = ("inactive", "offboarded")


def _norm(s) -> str:
    return (s or "").strip().lower()


# ── The audience rule ─────────────────────────────────────────────────────

def person_facts(emp: NexusEmployee) -> dict:
    """What the audience rule reads about one person."""
    from routers.hr import allowed_site_ids
    return {
        "email": _norm(emp.work_email),
        "department": (emp.department or "").strip(),
        "company": (emp.company or "").strip(),
        "status": emp.status or "active",
        "external": (emp.identity_type or "") in ("guest", "external"),
        "sites": allowed_site_ids(emp),
    }


def people_facts(db: Session) -> dict:
    """{email -> facts} for everyone with a work email (one query)."""
    out = {}
    for e in db.query(NexusEmployee).filter(NexusEmployee.work_email != "").all():
        f = person_facts(e)
        if f["email"]:
            out[f["email"]] = f
    return out


def eligible(person: dict) -> bool:
    """Someone an audience can contain at all: an internal person still here."""
    return bool(person) and not person.get("external") and person.get("status", "active") not in _GONE


def in_audience(person: dict, *, audience: str, department: str = "", work_site_id: str = "",
                company: str = "") -> bool:
    """Does `person` (person_facts, or any dict with department / company /
    sites) fall inside this audience? Pure: eligibility is `eligible`."""
    aud = _norm(audience) or "company"
    if aud == "department":
        return bool(_norm(department)) and _norm(person.get("department")) == _norm(department)
    if aud == "site":
        return bool(work_site_id) and work_site_id in (person.get("sites") or [])
    mine = (person.get("company") or "").strip()
    return not company or not mine or mine == company


# ── Forms ─────────────────────────────────────────────────────────────────

def template_company(db: Session, tpl: DocTemplate, companies: dict | None = None) -> str:
    """A template's company is its creator's (the same rule Announcements use
    for a post's author); '' = shared with every company."""
    by = _norm(tpl.created_by)
    if not by:
        return ""
    if companies is not None:
        return companies.get(by, "")
    return auth.company_of(by, db)


def _is_form(tpl: DocTemplate) -> bool:
    return (tpl.doc_type or "") == "form" and (tpl.status or "") == "active"


def may_fill(db: Session, tpl: DocTemplate, email: str, *, level: int = 0, person: dict | None = None) -> bool:
    """May this person open and submit the form? False for anything that is
    not a live form, for someone outside the audience, and for anyone not in
    nexus_employees. Administrators may fill every live form."""
    if not _is_form(tpl):
        return False
    if person is None:
        emp = (db.query(NexusEmployee)
               .filter(func.lower(NexusEmployee.work_email) == _norm(email)).first())
        person = person_facts(emp) if emp else None
    if not eligible(person):
        return False
    if int(level or 0) >= _ADMIN_LEVEL:
        return True
    return in_audience(person, audience=tpl.audience or "company", department=tpl.department or "",
                       work_site_id=tpl.work_site_id or "", company=template_company(db, tpl))


def fillable_for(db: Session, email: str, *, level: int = 0) -> list:
    """Every live form this person may fill, by name."""
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == _norm(email)).first())
    person = person_facts(emp) if emp else None
    if not eligible(person):
        return []
    rows = (db.query(DocTemplate)
            .filter(DocTemplate.doc_type == "form", DocTemplate.status == "active")
            .order_by(DocTemplate.name).all())
    companies = auth.company_of_email_map(db)
    out = []
    for t in rows:
        if int(level or 0) >= _ADMIN_LEVEL or in_audience(
                person, audience=t.audience or "company", department=t.department or "",
                work_site_id=t.work_site_id or "", company=template_company(db, t, companies)):
            out.append(t)
    return out


# ── Entry reach ───────────────────────────────────────────────────────────

class Reach:
    """`reach(entry)` = may see; `reach.can_review(entry)` = may review.
    Built once per request; every lookup is memoized."""

    def __init__(self, db: Session, user: dict):
        self.db = db
        self.me = _norm(user.get("email"))
        self.level = int(user.get("level") or 0)
        self.admin = self.level >= _ADMIN_LEVEL
        self.scope = auth.company_scope(user, db) if self.me else set()
        self._team = None
        self._sites = None
        self._hr = {}

    @property
    def team(self) -> set:
        if self._team is None:
            self._team = auth.team_emails(self.db, self.me) if self.me else set()
        return self._team

    @property
    def team_sites(self) -> set:
        """Work sites of the shift groups I schedule or my people belong to."""
        if self._sites is None:
            sites = set()
            groups = self.db.query(ShiftGroup).filter(ShiftGroup.work_site_id != "").all()
            if groups:
                from routers.timeclock import _schedulers
                members = {}
                for m in (self.db.query(ShiftGroupMember)
                          .filter(ShiftGroupMember.group_id.in_([g.id for g in groups])).all()):
                    members.setdefault(m.group_id, set()).add(_norm(m.employee_email))
                for g in groups:
                    if self.me in _schedulers(g) or (members.get(g.id, set()) & self.team):
                        sites.add(g.work_site_id)
            self._sites = sites
        return self._sites

    def hr_for(self, company: str) -> bool:
        key = company or ""
        if key not in self._hr:
            import hr_access
            self._hr[key] = hr_access.is_hr_for_company(self.db, {"email": self.me, "level": self.level}, key)
        return self._hr[key]

    def __call__(self, entry) -> bool:
        if not self.me or getattr(entry, "deleted_at", ""):
            return False
        if _norm(entry.submitted_by) == self.me:
            return True
        if not auth.company_ok(entry.company or "", self.scope, shared_when_blank=True):
            return False
        if self.admin:
            return True
        if _norm(entry.submitted_by) in self.team:
            return True
        if entry.work_site_id and entry.work_site_id in self.team_sites:
            return True
        return self.hr_for(entry.company or "")

    def can_review(self, entry) -> bool:
        return self(entry) and _norm(entry.submitted_by) != self.me


def viewer_reach(db: Session, user: dict) -> Reach:
    return Reach(db, user)
