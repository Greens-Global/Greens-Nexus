"""Core pack: the company (the subject of a schedule tick) and the person
(the record most workflows are about), with the record-observer events on
the person. The HR pack (Task 9) adds the HR life events and actions on
top of these registrations; the core actions (notify, email, wait, stop,
teams, webhook) land in Task 6."""
from __future__ import annotations

import models
from workflows.catalog import D, F, entity, event


# ── helpers ──────────────────────────────────────────────────────────────────
def _emails(*vals) -> list[str]:
    out = []
    for v in vals:
        for e in str(v or "").split(","):
            e = e.strip().lower()
            if e and e not in out:
                out.append(e)
    return out


def _employee_self(db, row) -> list[str]:
    return _emails(getattr(row, "work_email", ""))


def _employee_manager(db, row) -> list[str]:
    return _emails(getattr(row, "manager_email", ""))


def _company_hr_contacts(db, company_id: str) -> list[str]:
    import hr_access
    return hr_access.hr_contacts(db, company_id or "")


def _employee_hr_contact(db, row) -> list[str]:
    return _company_hr_contacts(db, getattr(row, "company", "") or "")


def _company_hr_contact(db, row) -> list[str]:
    return _company_hr_contacts(db, getattr(row, "id", "") or "")


def _global_admins(db, row=None) -> list[str]:
    rows = db.query(models.NexusRole).filter(models.NexusRole.role == "owner").all()
    return _emails(*[r.email for r in rows])


def employee_name(row) -> str:
    name = (getattr(row, "display_name", "") or "").strip()
    if not name:
        name = f"{getattr(row, 'first_name', '') or ''} {getattr(row, 'last_name', '') or ''}".strip()
    return name or (getattr(row, "work_email", "") or "")


def _employee_visible(db, user, row) -> bool:
    """A person's record is visible to themselves, their manager, HR and
    administrators - the People screen's own rule, in short."""
    if not user:
        return False
    import auth
    me = (user.get("email") or "").lower()
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return True
    if me and me in (_employee_self(db, row) + _employee_manager(db, row)):
        return True
    return auth._module_level(me, "hr", db) >= 1


# ── entities ─────────────────────────────────────────────────────────────────
entity("company", label="Company", model=models.HrEntity, module="core",
       company=lambda row: row.id,
       link=lambda row: {"view": "admin", "sub": f"companies@{row.id}"},
       people={"hr_contact": _company_hr_contact, "global_admins": _global_admins},
       fields=[F("name", "Name", "text"), F("country", "Country", "text"), F("region", "Region", "text")],
       label_of=lambda row: row.name or row.id)

EMPLOYEE_FIELDS = [
    F("name", "Name", "text", path="__label__"),
    F("work_email", "Work Email", "person"),
    F("department", "Department", "select", options="departments"),
    F("job_title", "Job Title", "text"),
    F("manager_email", "Manager", "person"),
    F("company", "Company", "select", options="companies"),
    F("employment_type", "Employment Type", "select",
      options=[("full_time", "Full Time"), ("part_time", "Part Time"), ("contractor", "Contractor"),
               ("intern", "Intern")]),
    F("location", "Location", "select", options="locations"),
    F("status", "Status", "select",
      options=[("onboarding", "Onboarding"), ("active", "Active"), ("inactive", "Inactive"),
               ("offboarded", "Offboarded")]),
    F("start_date", "Start Date", "date"),
    F("birthday", "Birthday", "date", visibility="hr", path="personal.dob", yearly=True),
]

entity("employee", label="Person", model=models.NexusEmployee, module="hr",
       company=lambda row: row.company or "",
       link=lambda row: {"view": "hr", "sub": f"people:{row.id}"},
       people={"self": _employee_self, "manager": _employee_manager, "hr_contact": _employee_hr_contact},
       fields=EMPLOYEE_FIELDS,
       dates=["start_date", D("start_date", "Work Anniversary", yearly=True), "birthday"],
       observe=True,
       observe_fields=("department", "manager_email", "job_title", "company", "employment_type", "location",
                       "status"),
       label_of=employee_name,
       visible_to=_employee_visible)

SAMPLE_EMPLOYEE = {
    "name": "Priya Shah", "work_email": "priya.shah@greensglobal.com", "department": "Operations",
    "job_title": "Site Manager", "manager_email": "max.miller@greensglobal.com", "company": "",
    "employment_type": "full_time", "location": "Escondido", "status": "active",
    "start_date": "2026-11-12", "birthday": "1994-03-08",
}

# ── events ───────────────────────────────────────────────────────────────────
event("employee.created", entity="employee", label="Person Is Added", module="hr", group="People",
      sample=SAMPLE_EMPLOYEE)
event("employee.field_changed", entity="employee", label="Person Detail Changes", module="hr", group="People",
      changes=("department", "manager_email", "job_title", "company", "employment_type", "location", "status"),
      sample={"subject": dict(SAMPLE_EMPLOYEE, department="Sales"),
              "changes": {"department": {"from": "Operations", "to": "Sales"}},
              "extra": {"field": "department"}, "actor": "hana.hr@greensglobal.com"})
event("employee.status_changed", entity="employee", label="Person Status Changes", module="hr", group="People",
      changes=("status",),
      sample={"subject": dict(SAMPLE_EMPLOYEE, status="offboarded"),
              "changes": {"status": {"from": "active", "to": "offboarded"}},
              "extra": {"reason": "Resigned", "effectiveDate": "2026-11-30"},
              "actor": "hana.hr@greensglobal.com"})
