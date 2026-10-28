"""HR pack (Task 9): the HR records a workflow can be about, what happens to
them, what a workflow may do to a person's record, and the lists a schedule
can loop over.

The core pack registers the `company` and `employee` entities and the
observer events on a person; this pack EXTENDS `employee` (probation,
contract end, pay with visibility "comp", the HR custom fields) and adds
the HR entities: candidate, time_off_request, letter_request,
salary_advance, headcount_request, extra_time_claim, life_event.

Nothing here touches the database at import: packs load lazily inside the
record observer's after_flush, where a second session would fight the one
flushing. What only the database knows - the HR custom fields and the
company checklist templates - is added by `sync_catalog(db)`, which the
catalog route and the engine call before they read the registry (it is
idempotent and cheap); the event `employee.custom_field_changed` syncs on
its own `may_use` as a backstop.

Every action runs the module's OWN function as `ctx.run_as` (its checks
run), and writes the module's own note / activity line "Workflow: <name>"
so the record's history explains itself. `allowed`: the run-as user must
be HR for the person (`hr_access.is_hr_for`) or an administrator.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import object_session

import models
from workflows import catalog
from workflows.catalog import D, F, P, action, entity, event, list_source
from workflows.packs.core import SAMPLE_EMPLOYEE, _company_hr_contacts, _emails, employee_name

MODULE = "hr"
ADMIN_LEVEL = 4            # auth._LEVELS["administrator"]
NOTE_MAX = 1000


# ── helpers ──────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us_date(iso) -> str:
    s = str(iso or "")[:10]
    try:
        d = date.fromisoformat(s)
    except ValueError:
        return s
    return f"{d.month:02d}/{d.day:02d}/{d.year}"


def _db_of(row):
    try:
        return object_session(row)
    except Exception:   # noqa: BLE001 - a detached row has no session; readers answer blank
        return None


def _emp_by_email(db, email: str) -> Optional[models.NexusEmployee]:
    who = (email or "").strip().lower()
    if not who or db is None:
        return None
    return (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email) == who).first())


def _emp_by_id(db, eid: str) -> Optional[models.NexusEmployee]:
    if not eid or db is None:
        return None
    return db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid).first()


def _name_of(db, email: str) -> str:
    emp = _emp_by_email(db, email)
    return employee_name(emp) if emp else (email or "").strip().lower()


def _company_of_email(row, attr: str = "employee_email") -> str:
    emp = _emp_by_email(_db_of(row), getattr(row, attr, "") or "")
    return (emp.company if emp else "") or ""


def _self_of(attr: str):
    return lambda db, row: _emails(getattr(row, attr, ""))


def _manager_of(attr: str):
    def fn(db, row):
        emp = _emp_by_email(db, getattr(row, attr, "") or "")
        return _emails(emp.manager_email) if emp else []
    return fn


def _hr_contact_of(attr: str):
    def fn(db, row):
        emp = _emp_by_email(db, getattr(row, attr, "") or "")
        return _company_hr_contacts(db, (emp.company if emp else "") or "")
    return fn


def _hr_contact_of_company(attr: str):
    return lambda db, row: _company_hr_contacts(db, getattr(row, attr, "") or "")


def _is_admin(user) -> bool:
    return int((user or {}).get("level", 0) or 0) >= ADMIN_LEVEL


def _hr_grant(db, user) -> bool:
    """The HR module grant (viewer and up) or an administrator - the rule
    the catalog applies to HR events."""
    if not user:
        return False
    import auth
    if _is_admin(user):
        return True
    return auth._module_level((user.get("email") or "").lower(), "hr", db) >= 1


def _person_visible(db, user, email: str) -> bool:
    """A person's own record, their manager, HR for them, an administrator -
    the People screen's rule, applied to a record ABOUT the person."""
    if not user:
        return False
    if _is_admin(user):
        return True
    me = (user.get("email") or "").strip().lower()
    who = (email or "").strip().lower()
    if me and me == who:
        return True
    emp = _emp_by_email(db, who)
    if emp is not None and me and me == (emp.manager_email or "").strip().lower():
        return True
    import hr_access
    return hr_access.is_hr_for(db, user, who)


def _visible_by(attr: str):
    return lambda db, user, row: _person_visible(db, user, getattr(row, attr, "") or "")


def _hr_visible(db, user, row) -> bool:
    return _hr_grant(db, user)


def _calendar_days(row) -> Optional[int]:
    try:
        s = date.fromisoformat((row.start_date or "")[:10])
        e = date.fromisoformat((row.end_date or "")[:10])
    except (ValueError, TypeError):
        return None
    return max((e - s).days + 1, 0)


# `days` is read off the row like any field; the model has no column for it,
# so the request grows a read-only property here (plain Python, not mapped).
if not hasattr(models.TimeOffRequest, "days"):
    models.TimeOffRequest.days = property(_calendar_days)


# ── the person: probation, contract end, pay, custom fields ──────────────────
PROBATION_STATUSES = [("", "Not Tracked"), ("in_probation", "In Probation"), ("extended", "Extended"),
                      ("confirmed", "Confirmed"), ("ended", "Ended"), ("stopped", "Stopped"),
                      # Oct 29 2026: passed by itself at the end with no decision, or
                      # Removed From Probation by HR (hr_probation.py).
                      ("passed", "Passed Probation"), ("removed", "Removed From Probation")]
PAY_BASES = [("salary", "Salary"), ("hourly", "Hourly")]

_employee = catalog.ENTITIES["employee"]
_employee.fields.extend([
    F("probation.status", "Probation Status", "select", options=PROBATION_STATUSES, path="probation.status"),
    F("probation.start", "Probation Start", "date", path="probation.startDate"),
    F("probation.end", "Probation End", "date", path="probation.endDate"),
    F("contract_end", "Contract End", "date", path="contractor.contract_end"),
    F("pay.base", "Base Pay", "money", visibility="comp", path="compensation.base"),
    F("pay.basis", "Pay Basis", "select", visibility="comp", options=PAY_BASES, path="compensation.payBasis"),
    F("pay.frequency", "Pay Frequency", "text", visibility="comp", path="compensation.frequency"),
    F("pay.currency", "Pay Currency", "text", visibility="comp", path="compensation.currency"),
])
_employee.dates.extend([D("probation.end", "Probation End"), D("contract_end", "Contract End")])

CUSTOM_PREFIX = "custom."
_CUSTOM_TYPES = {"text": "text", "number": "number", "date": "date", "dropdown": "select", "checkbox": "bool"}

# Checklist kinds and letter types as the modules define them (hr_checklists.KINDS,
# hr_letters.LETTER_TYPES) - repeated here so the catalog needs no module
# import at load; sync_catalog re-reads them from the modules.
CHECKLIST_KINDS = [("onboarding", "Onboarding"), ("promotion", "Promotion"), ("offboarding", "Offboarding"),
                   ("inactive", "Leave or Suspension")]   # = hr_checklists.KIND_LABELS (a test keeps them equal)
EXIT_TYPES = ["resignation", "resignation_no_notice", "termination", "end_of_contract", "retirement", "death"]
LETTER_TYPES = [("employment_verification", "Employment Verification"), ("salary_certificate", "Salary Certificate"),
                ("experience_letter", "Experience Letter"), ("address_proof", "Address Proof"),
                ("visa_noc", "Visa NOC")]

# Mutable option lists the builder reads; sync_catalog fills them from the database.
CHECKLIST_OPTIONS: list = [{"value": k, "label": f"{lbl} (the company's template)"} for k, lbl in CHECKLIST_KINDS]
CUSTOM_FIELD_OPTIONS: list = []
LETTER_OPTIONS: list = [{"value": k, "label": lbl} for k, lbl in LETTER_TYPES]


def sync_catalog(db) -> int:
    """Register what only the database knows: one `custom.<key>` field per
    HR custom field (the field's own visibility: HR Only -> hr, the rest ->
    all), the checklist choices (the four kinds, then each company / role
    template by name) and the letter types offered. Idempotent; returns how
    many custom fields are registered. Never raises."""
    try:
        import hr_custom_fields
        have = {f.key for f in _employee.fields}
        CUSTOM_FIELD_OPTIONS[:] = []
        for cf in hr_custom_fields.all_fields(db):
            key = f"{CUSTOM_PREFIX}{cf.field_key}"
            vis = "hr" if (cf.visibility or "hr_only") == "hr_only" else "all"
            if key not in have:
                ftype = _CUSTOM_TYPES.get(cf.field_type or "text", "text")
                opts = list(cf.options or []) if ftype == "select" else None
                _employee.fields.append(F(key, cf.label or cf.field_key, ftype, options=opts, visibility=vis,
                                          path=f"custom_fields.{cf.field_key}"))
                if ftype == "date":
                    _employee.dates.append(D(key, cf.label or cf.field_key))
                have.add(key)
            CUSTOM_FIELD_OPTIONS.append({"value": cf.field_key, "label": cf.label or cf.field_key})
    except Exception as e:   # noqa: BLE001 - a missing table (first boot) leaves the static catalog
        print(f"[workflows] hr pack: custom fields not synced: {type(e).__name__}: {str(e)[:120]}")
    try:
        import hr_checklists
        labels = dict(hr_checklists.KIND_LABELS)
        opts = [{"value": k, "label": f"{labels.get(k, k.title())} (the company's template)"}
                for k in hr_checklists.KINDS]
        names = {e.id: e.name for e in db.query(models.HrEntity).all()}
        roles = {g.id: g.name for g in db.query(models.NexusGroup).all()}
        for tpl in (db.query(models.HrChecklistTemplate)
                    .order_by(models.HrChecklistTemplate.kind, models.HrChecklistTemplate.name).all()):
            where = roles.get(tpl.role_id) if tpl.role_id else names.get(tpl.entity_id, "Every company")
            opts.append({"value": tpl.id, "label": f"{tpl.name or labels.get(tpl.kind, tpl.kind)} - "
                                                   f"{labels.get(tpl.kind, tpl.kind)}, {where or 'Every company'}"})
        CHECKLIST_OPTIONS[:] = opts
    except Exception as e:   # noqa: BLE001
        print(f"[workflows] hr pack: checklist templates not synced: {type(e).__name__}: {str(e)[:120]}")
    try:
        import hr_letters
        LETTER_OPTIONS[:] = [{"value": t["key"], "label": t["label"]} for t in hr_letters.LETTER_TYPES]
    except Exception as e:   # noqa: BLE001
        print(f"[workflows] hr pack: letter types not synced: {type(e).__name__}: {str(e)[:120]}")
    return sum(1 for f in _employee.fields if f.key.startswith(CUSTOM_PREFIX))


# ── entities ─────────────────────────────────────────────────────────────────
CANDIDATE_STAGES = [("applied", "Applied"), ("screening", "Screening"), ("interview", "Interview"),
                    ("decision", "Decision"), ("offer", "Offer"), ("hired", "Hired"), ("rejected", "Rejected")]

entity("candidate", label="Candidate", model=models.HrCandidate, module=MODULE,
       company=lambda row: row.company or "",
       link=lambda row: {"view": "hr", "sub": "hr-hiring"},
       people={"creator": _self_of("created_by"), "hr_contact": _hr_contact_of_company("company")},
       fields=[F("name", "Name", "text", path="__label__"), F("first_name", "First Name", "text"),
               F("last_name", "Last Name", "text"), F("email", "Personal Email", "text"),
               F("role_title", "Role", "text"), F("department", "Department", "select", options="departments"),
               F("stage", "Stage", "select", options=CANDIDATE_STAGES),
               F("expected_start", "Expected Start", "date"), F("source", "Source", "text"),
               F("company", "Company", "select", options="companies"), F("location", "Location", "text"),
               F("decision", "Decision", "select", options=[("", "None"), ("hire", "Hire"), ("reject", "Reject")]),
               F("created_by", "Added By", "person"), F("applied_at", "Applied On", "datetime")],
       dates=["expected_start"],
       label_of=lambda row: f"{row.first_name or ''} {row.last_name or ''}".strip() or row.id,
       visible_to=_hr_visible)

TIME_OFF_TYPES = [("vacation", "Vacation"), ("sick", "Sick"), ("personal", "Personal"), ("unpaid", "Unpaid"),
                  ("other", "Other")]
TIME_OFF_STATUSES = [("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"),
                     ("cancelled", "Cancelled")]


def _time_off_label(row) -> str:
    who = _name_of(_db_of(row), row.employee_email)
    return f"{who} - {str(row.type or 'time off').title()} {_us_date(row.start_date)} to {_us_date(row.end_date)}"


def _time_off_approver(db, row) -> list:
    return _emails(row.approver or row.first_approver)


entity("time_off_request", label="Time Off Request", model=models.TimeOffRequest, module=MODULE,
       company=_company_of_email,
       link=lambda row: {"view": "hr", "sub": "hr-time-off"},
       people={"self": _self_of("employee_email"), "manager": _manager_of("employee_email"),
               "hr_contact": _hr_contact_of("employee_email"), "approver": _time_off_approver},
       fields=[F("name", "Request", "text", path="__label__"), F("employee", "Person", "person", path="employee_email"),
               F("type", "Type", "select", options=TIME_OFF_TYPES), F("start", "Start", "date", path="start_date"),
               F("end", "End", "date", path="end_date"), F("days", "Days", "number"),
               F("status", "Status", "select", options=TIME_OFF_STATUSES),
               F("approval_stage", "Approval Stage", "select", options=[("", "Manager"), ("hr", "HR")]),
               F("note", "Note", "text"), F("approver", "Approver", "person"),
               F("requested_by", "Filed By", "person"), F("confidential", "Confidential", "bool"),
               F("decide_note", "Decision Note", "text")],
       dates=["start", "end"],
       label_of=_time_off_label,
       visible_to=_visible_by("employee_email"))

LETTER_STATUSES = [("requested", "Requested"), ("in_review", "In Review"), ("awaiting_signature", "Awaiting Signature"),
                   ("issued", "Issued"), ("declined", "Declined")]

entity("letter_request", label="Letter Request", model=models.HrLetterRequest, module=MODULE,
       company=lambda row: row.company_id or "",
       link=lambda row: {"view": "myhr", "sub": "overview"},
       people={"self": _self_of("employee_email"), "manager": _manager_of("employee_email"),
               "hr_contact": _hr_contact_of_company("company_id"), "approver": _self_of("reviewed_by")},
       fields=[F("name", "Request", "text", path="__label__"), F("employee", "Person", "person", path="employee_email"),
               F("employee_name", "Person Name", "text"),
               F("company", "Company", "select", options="companies", path="company_id"),
               F("letter_type", "Letter", "select", options=LETTER_TYPES), F("purpose", "Purpose", "text"),
               F("addressed_to", "Addressed To", "text"), F("needed_by", "Needed By", "date"),
               F("status", "Status", "select", options=LETTER_STATUSES), F("decline_reason", "Decline Reason", "text"),
               F("reviewed_by", "Reviewed By", "person"), F("issued_by", "Issued By", "person")],
       dates=["needed_by"],
       label_of=lambda row: f"{row.employee_name or row.employee_email} - "
                            f"{dict(LETTER_TYPES).get(row.letter_type, row.letter_type or 'Letter')}",
       visible_to=_visible_by("employee_email"))

ADVANCE_STATUSES = [("requested", "Requested"), ("approved", "Approved"), ("declined", "Declined"),
                    ("paid_out", "Paid Out"), ("repaying", "Repaying"), ("repaid", "Repaid"), ("canceled", "Canceled")]

entity("salary_advance", label="Salary Advance", model=models.SalaryAdvance, module=MODULE,
       company=lambda row: row.company or "",
       # The person's Time Sheet in People > Time (Oct 29 2026) - salary_advance.timesheet_link.
       link=lambda row: {"view": "hr", "sub": "hr-time", "timecard": (row.employee_email or "").lower()},
       people={"self": _self_of("employee_email"), "manager": _manager_of("employee_email"),
               "hr_contact": _hr_contact_of_company("company"), "approver": _self_of("decided_by")},
       fields=[F("name", "Advance", "text", path="__label__"), F("employee", "Person", "person", path="employee_email"),
               F("employee_name", "Person Name", "text"), F("company", "Company", "select", options="companies"),
               F("amount", "Amount", "money", visibility="comp"), F("currency", "Currency", "text"),
               F("reason", "Reason", "text"), F("installments", "Installments", "number"),
               F("status", "Status", "select", options=ADVANCE_STATUSES),
               F("source", "Source", "select", options=[("request", "Requested"), ("grant", "Granted By HR")]),
               F("requested_by", "Requested By", "person"), F("decided_by", "Decided By", "person"),
               F("decision_note", "Decision Note", "text"), F("paid_on", "Paid On", "date")],
       dates=["paid_on"],
       label_of=lambda row: f"{row.employee_name or row.employee_email} - Salary Advance",
       visible_to=_visible_by("employee_email"))

HEADCOUNT_STATUSES = [("draft", "Draft"), ("awaiting_approval", "Awaiting Approval"), ("approved", "Approved"),
                      ("declined", "Declined")]


def _headcount_visible(db, user, row) -> bool:
    if not user:
        return False
    me = (user.get("email") or "").strip().lower()
    if _is_admin(user) or me == (row.requested_by or "").lower() or me in _emails(*(row.dept_approvers or [])):
        return True
    return _hr_grant(db, user)


entity("headcount_request", label="Headcount Request", model=models.HrHeadcountRequest, module=MODULE,
       company=lambda row: row.company or "",
       link=lambda row: {"view": "shifts", "sub": "headcount"},
       people={"requester": _self_of("requested_by"), "hr_contact": _hr_contact_of_company("company"),
               "approvers": lambda db, row: _emails(*(row.dept_approvers or []))},
       fields=[F("name", "Request", "text", path="__label__"), F("code", "Code", "text"),
               F("company", "Company", "select", options="companies"),
               F("department", "Department", "select", options="departments"), F("role_title", "Role", "text"),
               F("location", "Location", "text"),
               F("employment_type", "Employment Type", "select",
                 options=[("full_time", "Full Time"), ("part_time", "Part Time"), ("contractor", "Contractor"),
                          ("intern", "Intern"), ("temporary", "Temporary")]),
               F("openings", "Openings", "number"), F("target_start", "Target Start", "date"),
               F("status", "Status", "select", options=HEADCOUNT_STATUSES),
               F("step", "Waiting On", "select", options=[("", "Nobody"), ("department", "Department"), ("hr", "HR")]),
               F("justification", "Justification", "text"), F("requested_by", "Requested By", "person"),
               F("decline_note", "Decline Note", "text"),
               F("salary_min", "Salary Min", "money", visibility="comp"),
               F("salary_max", "Salary Max", "money", visibility="comp")],
       dates=["target_start"],
       label_of=lambda row: f"{row.code or 'Headcount'} - {row.role_title or row.department or ''}".strip(" -"),
       visible_to=_headcount_visible,
       people_labels={"approvers": "Department Approvers"})

CLAIM_STATUSES = [("pending", "Pending"), ("approved", "Approved"), ("declined", "Declined"), ("withdrawn", "Withdrawn")]

entity("extra_time_claim", label="Extra Time Claim", model=models.ExtraTimeClaim, module=MODULE,
       company=lambda row: row.company_id or "",
       link=lambda row: {"view": "hr", "sub": "hr-time-extra"},
       people={"self": _self_of("employee_email"), "manager": _manager_of("employee_email"),
               "hr_contact": _hr_contact_of_company("company_id"), "approver": _self_of("decided_by")},
       fields=[F("name", "Claim", "text", path="__label__"), F("employee", "Person", "person", path="employee_email"),
               F("company", "Company", "select", options="companies", path="company_id"),
               F("date", "Day Worked", "date", path="local_date"), F("period_start", "Month", "date"),
               F("claimed_min", "Minutes Claimed", "number"), F("approved_min", "Minutes Approved", "number"),
               F("note", "What Was Done", "text"), F("status", "Status", "select", options=CLAIM_STATUSES),
               F("decision_note", "Decision Note", "text"), F("decided_by", "Decided By", "person")],
       dates=["date"],
       label_of=lambda row: f"{_name_of(_db_of(row), row.employee_email)} - Extra Time {_us_date(row.local_date)}",
       visible_to=_visible_by("employee_email"))

LIFE_EVENT_KINDS = [("offer", "Offer"), ("hire", "Hire"), ("promotion", "Promotion"), ("role_change", "Role Change"),
                    ("separation", "Separation"), ("probation", "Probation")]
LIFE_EVENT_STATUSES = [("awaiting_sender", "Awaiting Sender"), ("sent", "Sent"), ("completed", "Completed"),
                       ("declined", "Declined"), ("voided", "Voided"), ("expired", "Expired")]


def _life_event_self(db, row) -> list:
    emp = _emp_by_id(db, row.employee_id)
    return _emails(emp.work_email) if emp and emp.work_email else _emails(row.subject_email)


def _life_event_manager(db, row) -> list:
    emp = _emp_by_id(db, row.employee_id)
    return _emails(emp.manager_email) if emp else []


def _life_event_visible(db, user, row) -> bool:
    emp = _emp_by_id(db, row.employee_id)
    if emp is not None and emp.work_email:
        return _person_visible(db, user, emp.work_email)
    return _hr_grant(db, user)


def _life_event_link(row) -> dict:
    hiring = row.kind in ("offer", "hire") and not row.employee_id
    return {"view": "hr", "sub": "hr-hiring" if hiring else "hr-people"}


entity("life_event", label="Life Event", model=models.HrLifeEvent, module=MODULE,
       company=lambda row: row.entity_id or "",
       link=_life_event_link,
       people={"self": _life_event_self, "manager": _life_event_manager,
               "hr_contact": _hr_contact_of_company("entity_id"), "creator": _self_of("created_by")},
       fields=[F("name", "Event", "text", path="__label__"), F("kind", "Kind", "select", options=LIFE_EVENT_KINDS),
               F("status", "Status", "select", options=LIFE_EVENT_STATUSES),
               F("subject_name", "Person Name", "text"), F("subject_email", "Sent To", "text"),
               F("company", "Company", "select", options="companies", path="entity_id"),
               F("effective_date", "Effective Date", "date"),
               F("apply_status", "Applied", "select",
                 options=[("", "Not Scheduled"), ("scheduled", "Scheduled"), ("applied", "Applied"),
                          ("canceled", "Canceled")]),
               F("created_by", "Started By", "person"), F("completed_at", "Completed At", "datetime")],
       dates=["effective_date"],
       label_of=lambda row: f"{row.subject_name or row.subject_email or 'Person'} - "
                            f"{dict(LIFE_EVENT_KINDS).get(row.kind, (row.kind or 'Event').title())}",
       visible_to=_life_event_visible)


# ── samples ──────────────────────────────────────────────────────────────────
HR_ACTOR = "hana.hr@greensglobal.com"
SAMPLE_PERSON = dict(SAMPLE_EMPLOYEE, **{
    "probation.status": "in_probation", "probation.start": "2026-11-12", "probation.end": "2027-02-12",
    "contract_end": None, "pay.base": 78000, "pay.basis": "salary", "pay.frequency": "monthly", "pay.currency": "USD",
})
SAMPLE_CANDIDATE = {
    "name": "Arjun Mehta", "first_name": "Arjun", "last_name": "Mehta", "email": "arjun.mehta@example.com",
    "role_title": "Site Supervisor", "department": "Operations", "stage": "interview", "expected_start": "2026-12-01",
    "source": "Referral", "company": "", "location": "Austin", "decision": "", "created_by": HR_ACTOR,
    "applied_at": "2026-10-20T15:04:00+00:00",
}
SAMPLE_TIME_OFF = {
    "name": "Priya Shah - Vacation 12/21/2026 to 12/24/2026", "employee": "priya.shah@greensglobal.com",
    "type": "vacation", "start": "2026-12-21", "end": "2026-12-24", "days": 4, "status": "pending",
    "approval_stage": "", "note": "Family trip", "approver": "", "requested_by": "", "confidential": False,
    "decide_note": "",
}
SAMPLE_LETTER = {
    "name": "Priya Shah - Employment Verification", "employee": "priya.shah@greensglobal.com",
    "employee_name": "Priya Shah", "company": "", "letter_type": "employment_verification",
    "purpose": "Apartment lease", "addressed_to": "Oak Street Apartments", "needed_by": "2026-11-20",
    "status": "requested", "decline_reason": "", "reviewed_by": "", "issued_by": "",
}
SAMPLE_ADVANCE = {
    "name": "Priya Shah - Salary Advance", "employee": "priya.shah@greensglobal.com", "employee_name": "Priya Shah",
    "company": "", "amount": 1500, "currency": "USD", "reason": "Moving costs", "installments": 3,
    "status": "requested", "source": "request", "requested_by": "priya.shah@greensglobal.com", "decided_by": "",
    "decision_note": "", "paid_on": "",
}
SAMPLE_HEADCOUNT = {
    "name": "HC-0012 - Site Supervisor", "code": "HC-0012", "company": "", "department": "Operations",
    "role_title": "Site Supervisor", "location": "Austin", "employment_type": "full_time", "openings": 1,
    "target_start": "2027-01-04", "status": "awaiting_approval", "step": "department",
    "justification": "A second shift opens in January.", "requested_by": "max.miller@greensglobal.com",
    "decline_note": "", "salary_min": 62000, "salary_max": 70000,
}
SAMPLE_CLAIM = {
    "name": "Priya Shah - Extra Time 11/14/2026", "employee": "priya.shah@greensglobal.com", "company": "",
    "date": "2026-11-14", "period_start": "2026-11-01", "claimed_min": 300, "approved_min": 0,
    "note": "Weekend deploy of the billing system", "status": "pending", "decision_note": "", "decided_by": "",
}
SAMPLE_LIFE_EVENT = {
    "name": "Priya Shah - Promotion", "kind": "promotion", "status": "completed", "subject_name": "Priya Shah",
    "subject_email": "priya.shah@greensglobal.com", "company": "", "effective_date": "2026-12-01",
    "apply_status": "applied", "created_by": HR_ACTOR, "completed_at": "2026-11-20T18:30:00+00:00",
}


def _full(subject: dict, changes: dict = None, extra: dict = None, actor: str = HR_ACTOR) -> dict:
    return {"subject": subject, "changes": changes or {}, "extra": extra or {}, "actor": actor}


def _custom_may_use(db, user) -> bool:
    sync_catalog(db)
    return _hr_grant(db, user)


# ── events ───────────────────────────────────────────────────────────────────
event("employee.hired", entity="employee", label="Person Is Hired", module=MODULE, group="People",
      sample=_full(dict(SAMPLE_PERSON, status="onboarding"), extra={"how": "candidate", "candidateId": "cand-1"}))
event("employee.custom_field_changed", entity="employee", label="Person Custom Field Changes", module=MODULE,
      group="People", may_use=_custom_may_use,
      sample=_full(SAMPLE_PERSON, changes={"custom.shirt_size": {"from": "M", "to": "L"}},
                   extra={"field": "shirt_size", "label": "Shirt Size"}))
event("probation.started", entity="employee", label="Probation Starts", module=MODULE, group="Probation",
      changes=("probation.status",),
      sample=_full(SAMPLE_PERSON, changes={"probation.status": {"from": "", "to": "in_probation"}},
                   extra={"endDate": "2027-02-12", "reason": "Hired", "how": "started"}))
event("probation.decided", entity="employee", label="Probation Is Decided", module=MODULE, group="Probation",
      changes=("probation.status", "probation.end"),
      sample=_full(dict(SAMPLE_PERSON, **{"probation.status": "confirmed"}),
                   changes={"probation.status": {"from": "in_probation", "to": "confirmed"},
                            "probation.end": {"from": "2027-02-12", "to": "2027-02-12"}},
                   extra={"decision": "confirm", "reason": "Strong first quarter.", "recommendedBy": ""}))
event("time_off.requested", entity="time_off_request", label="Time Off Is Requested", module=MODULE,
      group="Time Off", sample=_full(SAMPLE_TIME_OFF, actor="priya.shah@greensglobal.com"))
event("time_off.decided", entity="time_off_request", label="Time Off Is Decided", module=MODULE, group="Time Off",
      changes=("status",),
      sample=_full(dict(SAMPLE_TIME_OFF, status="approved", approver="max.miller@greensglobal.com"),
                   changes={"status": {"from": "pending", "to": "approved"}},
                   extra={"decision": "approved", "note": "", "level": "manager"}, actor="max.miller@greensglobal.com"))
event("time_off.cancelled", entity="time_off_request", label="Time Off Is Cancelled", module=MODULE,
      group="Time Off", changes=("status",),
      sample=_full(dict(SAMPLE_TIME_OFF, status="cancelled"),
                   changes={"status": {"from": "approved", "to": "cancelled"}},
                   extra={"wasApproved": True}, actor="priya.shah@greensglobal.com"))
event("letter.requested", entity="letter_request", label="Letter Is Requested", module=MODULE, group="HR Letters",
      sample=_full(SAMPLE_LETTER, actor="priya.shah@greensglobal.com"))
event("letter.decided", entity="letter_request", label="Letter Is Decided", module=MODULE, group="HR Letters",
      changes=("status",),
      sample=_full(dict(SAMPLE_LETTER, status="awaiting_signature", issued_by=HR_ACTOR),
                   changes={"status": {"from": "in_review", "to": "awaiting_signature"}},
                   extra={"decision": "issued", "reason": ""}))
event("salary_advance.requested", entity="salary_advance", label="Salary Advance Is Requested", module=MODULE,
      group="Salary Advances", sample=_full(SAMPLE_ADVANCE, actor="priya.shah@greensglobal.com"))
event("salary_advance.decided", entity="salary_advance", label="Salary Advance Is Decided", module=MODULE,
      group="Salary Advances", changes=("status",),
      sample=_full(dict(SAMPLE_ADVANCE, status="approved", decided_by=HR_ACTOR),
                   changes={"status": {"from": "requested", "to": "approved"}},
                   extra={"decision": "approve", "note": "", "installments": 3}))
event("headcount.requested", entity="headcount_request", label="Headcount Is Requested", module=MODULE,
      group="Hiring", changes=("status",),
      sample=_full(SAMPLE_HEADCOUNT, changes={"status": {"from": "draft", "to": "awaiting_approval"}},
                   extra={"step": "department"}, actor="max.miller@greensglobal.com"))
event("headcount.decided", entity="headcount_request", label="Headcount Is Decided", module=MODULE, group="Hiring",
      changes=("status",),
      sample=_full(dict(SAMPLE_HEADCOUNT, status="approved", step=""),
                   changes={"status": {"from": "awaiting_approval", "to": "approved"}},
                   extra={"decision": "approve", "step": "hr", "note": ""}))
event("candidate.stage_changed", entity="candidate", label="Candidate Moves Stage", module=MODULE, group="Hiring",
      changes=("stage",),
      sample=_full(SAMPLE_CANDIDATE, changes={"stage": {"from": "screening", "to": "interview"}},
                   extra={"note": ""}))
event("candidate.hired", entity="candidate", label="Candidate Is Hired", module=MODULE, group="Hiring",
      changes=("stage",),
      sample=_full(dict(SAMPLE_CANDIDATE, stage="hired"), changes={"stage": {"from": "offer", "to": "hired"}},
                   extra={"employeeId": "emp-1"}))
event("life_event.completed", entity="life_event", label="Life Event Is Completed", module=MODULE, group="People",
      changes=("status",),
      sample=_full(SAMPLE_LIFE_EVENT, changes={"status": {"from": "sent", "to": "completed"}},
                   actor="priya.shah@greensglobal.com"))
event("extra_time.claimed", entity="extra_time_claim", label="Extra Time Is Claimed", module=MODULE,
      group="Extra Time", sample=_full(SAMPLE_CLAIM, actor="priya.shah@greensglobal.com"))
event("extra_time.decided", entity="extra_time_claim", label="Extra Time Is Decided", module=MODULE,
      group="Extra Time", changes=("status",),
      sample=_full(dict(SAMPLE_CLAIM, status="approved", approved_min=300, decided_by=HR_ACTOR),
                   changes={"status": {"from": "pending", "to": "approved"}},
                   extra={"decision": "approve", "minutes": 300, "reason": ""}))


# ── actions ──────────────────────────────────────────────────────────────────
def _person_of(ctx) -> Optional[models.NexusEmployee]:
    """The person an action is about: the subject when it is a person, else
    the subject's `self`; in a dry run, the sample's person by email."""
    row = ctx.subject
    if row is not None:
        if isinstance(row, models.NexusEmployee):
            return row
        fn = (ctx.entity.people if ctx.entity else {}).get("self")
        emails = fn(ctx.db, row) if fn else []
        return _emp_by_email(ctx.db, emails[0]) if emails else None
    sub = (ctx.payload or {}).get("subject") or {}
    if not isinstance(sub, dict):
        return None
    return _emp_by_email(ctx.db, sub.get("work_email") or sub.get("employee") or sub.get("subject_email") or "")


def _subject_name(ctx) -> str:
    emp = _person_of(ctx)
    if emp is not None:
        return employee_name(emp)
    sub = (ctx.payload or {}).get("subject") or {}
    return str(sub.get("name") or sub.get("employee_name") or sub.get("subject_name") or "the person")


def _need_person(ctx) -> models.NexusEmployee:
    emp = _person_of(ctx)
    if emp is None:
        raise ValueError("This record has no person in Nexus People to act on")
    return emp


def _hr_allowed(ctx, params, verb: str) -> str:
    user = ctx.run_as
    if not user:
        return f"{verb} needs a person's identity - Nexus can only send messages"
    if _is_admin(user):
        return ""
    import hr_access
    me = _name_of(ctx.db, user.get("email") or "")
    emp = _person_of(ctx)
    if emp is None:
        return ("" if hr_access.hr_anywhere(ctx.db, user)
                else f"{me} is not HR - only the company's HR contact, an administrator or a Full People grant "
                     f"can {verb}")
    if hr_access.is_hr_for(ctx.db, user, emp.work_email or ""):
        return ""
    return (f"{me} is not HR for {employee_name(emp)} - only the company's HR contact, an administrator or a "
            f"Full People grant can {verb}")


def _workflow_name(ctx) -> str:
    return str(getattr(ctx.workflow, "name", "") or "") or "Workflow"


def _workflow_line(ctx) -> str:
    return f"Workflow: {_workflow_name(ctx)}"


def _render(ctx, text) -> str:
    from workflows.context import render
    out, _missing = render(str(text or ""), ctx)
    return out.strip()


def _audit(ctx, emp: models.NexusEmployee, what: str, details: dict, kind: str = "update") -> None:
    """The record's own history line: an AuditLog row, module hr, that the
    People screen's Activity and Settings > Logs show."""
    user = ctx.run_as or {}
    ctx.db.add(models.AuditLog(
        timestamp=_now(), user_email=user.get("email") or "", user_role=str(user.get("role") or ""),
        action=what, resource_type="employee", resource_id=emp.id, module=MODULE, kind=kind,
        details=json.dumps({"employee": emp.work_email, "workflow": _workflow_name(ctx),
                            "workflowId": str(getattr(ctx.workflow, "id", "") or ""),
                            "runId": str(getattr(ctx.run, "id", "") or ""), **details})[:4000]))


def _affected(emp: models.NexusEmployee, *more) -> list:
    return [{"entity": "employee", "id": emp.id, "label": employee_name(emp)}, *more]


def _ref(value) -> str:
    """An entity_ref param's value: a plain key / id, or {"id": ...}."""
    if isinstance(value, dict):
        return str(value.get("id") or value.get("value") or "").strip()
    return str(value or "").strip()


def _checklist_choice(db, value) -> tuple:
    """(kind, role_id, label) for a checklist choice: a kind, or a template id."""
    import hr_checklists
    key = _ref(value)
    labels = dict(hr_checklists.KIND_LABELS)
    if key in hr_checklists.KINDS:
        return key, None, labels.get(key, key.title())
    tpl = db.query(models.HrChecklistTemplate).filter(models.HrChecklistTemplate.id == key).first() if key else None
    if tpl is None:
        raise ValueError("Pick the checklist to start")
    return tpl.kind, (tpl.role_id or None), f"{tpl.name or labels.get(tpl.kind, tpl.kind)}"


def _checklist_plan(ctx, params) -> str:
    try:
        _kind, _role, label = _checklist_choice(ctx.db, params.get("template"))
    except ValueError as e:
        return str(e)
    return f"Would start the {label} checklist for {_subject_name(ctx)}"


def _checklist_run(ctx, params) -> dict:
    import hr_checklists
    emp = _need_person(ctx)
    kind, role_id, label = _checklist_choice(ctx.db, params.get("template"))
    name = employee_name(emp)
    if hr_checklists.open_checklist(ctx.db, emp.id, kind):
        return {"line": f"{name} already has an open {label} checklist - nothing started", "affected": [], "sent": []}
    exit_type = str(params.get("exit_type") or "")
    anchor = "" if kind == "onboarding" else ctx.today.isoformat()
    try:
        cl = hr_checklists.start(ctx.db, emp, kind, anchor_date=anchor, exit_type=exit_type,
                                 by=(ctx.run_as or {}).get("email") or "", role_id=role_id)
    except ValueError as e:
        raise ValueError(str(e)) from None
    _audit(ctx, emp, f"Started the {label} checklist ({_workflow_line(ctx)})",
           {"checklistId": cl.id, "kind": kind}, kind="create")
    return {"line": f"Started the {label} checklist for {name}",
            "affected": _affected(emp, {"entity": "hr_checklist", "id": cl.id, "label": f"{label} - {name}"}),
            "sent": []}


action("hr.start_checklist", label="Start An HR Checklist", module=MODULE,
       params=[P("template", "Checklist", "entity_ref", options=CHECKLIST_OPTIONS,
                 hint="A kind starts the person's company template; a named template starts that one."),
               P("exit_type", "Exit Type", "select", required=False, options=EXIT_TYPES,
                 hint="Offboarding only.")],
       plan=_checklist_plan, run=_checklist_run,
       allowed=lambda ctx, params: _hr_allowed(ctx, params, "start a checklist"))


def _letter_type_label(key: str) -> str:
    return next((o["label"] for o in LETTER_OPTIONS if o["value"] == key), None) or dict(LETTER_TYPES).get(key, key)


def _letter_plan(ctx, params) -> str:
    return f"Would request a {_letter_type_label(_ref(params.get('template')))} letter for {_subject_name(ctx)}"


def _letter_run(ctx, params) -> dict:
    import hr_letters
    emp = _need_person(ctx)
    key = _ref(params.get("template"))
    name = employee_name(emp)
    label = _letter_type_label(key)
    dup = (ctx.db.query(models.HrLetterRequest)
           .filter(models.HrLetterRequest.employee_id == emp.id, models.HrLetterRequest.letter_type == key,
                   models.HrLetterRequest.status.in_(hr_letters.OPEN)).first())
    if dup is not None:
        return {"line": f"{name} already has a {label} request open - nothing requested", "affected": [], "sent": []}
    note = _render(ctx, params.get("note"))
    purpose = note[:500] or f"Requested by the workflow {_workflow_name(ctx)}"
    try:
        req = hr_letters.create(ctx.db, emp, {"letter_type": key, "purpose": purpose, "notes": _workflow_line(ctx)})
    except hr_letters.LetterError as e:
        raise ValueError(str(e)) from None
    _audit(ctx, emp, f"Requested a {label} letter ({_workflow_line(ctx)})", {"requestId": req.id, "letterType": key},
           kind="create")
    return {"line": f"Requested a {label} letter for {name}",
            "affected": _affected(emp, {"entity": "letter_request", "id": req.id, "label": f"{name} - {label}"}),
            "sent": []}


action("hr.create_letter_request", label="Request An HR Letter", module=MODULE,
       params=[P("template", "Letter", "entity_ref", options=LETTER_OPTIONS),
               P("note", "Purpose", "template", required=False, max=500,
                 hint="What the letter is for - HR reads it.")],
       plan=_letter_plan, run=_letter_run,
       allowed=lambda ctx, params: _hr_allowed(ctx, params, "request a letter"))


def _custom_label(db, key: str) -> str:
    sync_catalog(db)
    return next((o["label"] for o in CUSTOM_FIELD_OPTIONS if o["value"] == key), None) or key


def _custom_plan(ctx, params) -> str:
    key = str(params.get("field") or "")
    value = _render(ctx, params.get("value"))
    return f"Would set {_custom_label(ctx.db, key)} to {value or '(blank)'} on {_subject_name(ctx)}"


def _custom_run(ctx, params) -> dict:
    import hr_custom_fields as hcf
    emp = _need_person(ctx)
    key = str(params.get("field") or "").strip()
    label = _custom_label(ctx.db, key)
    value = _render(ctx, params.get("value"))
    name = employee_name(emp)
    audience = hcf.audience_for(ctx.run_as or {}, emp, ctx.db)
    try:
        diff = hcf.apply_changes(ctx.db, emp, {key: value}, audience, ctx.run_as or {})
    except (hcf.FieldError, PermissionError) as e:
        raise ValueError(str(e)) from None
    if not diff:
        return {"line": f"{label} is already {value or 'blank'} on {name} - nothing changed", "affected": [], "sent": []}
    before, after = diff[key]
    _audit(ctx, emp, f"Set {label} ({_workflow_line(ctx)})",
           {"field": key, "from": None if before is None else str(before)[:120],
            "to": None if after is None else str(after)[:120]})
    return {"line": f"Set {label} to {after if after is not None else 'blank'} on {name}",
            "affected": _affected(emp), "sent": []}


def _custom_allowed(ctx, params) -> str:
    why = _hr_allowed(ctx, params, "set an HR field")
    if why:
        return why
    sync_catalog(ctx.db)
    key = str(params.get("field") or "").strip()
    if key and key not in {o["value"] for o in CUSTOM_FIELD_OPTIONS}:
        return f"{key!r} is not one of the HR custom fields any more"
    return ""


action("hr.set_custom_field", label="Set A Custom Field", module=MODULE,
       params=[P("field", "Field", "select", options=CUSTOM_FIELD_OPTIONS),
               P("value", "Value", "text", required=False, max=500,
                 hint="Blank clears it. {{ fields }} are filled in.")],
       plan=_custom_plan, run=_custom_run, allowed=_custom_allowed)


def _note_plan(ctx, params) -> str:
    text = _render(ctx, params.get("note"))
    return f"Would add a note to {_subject_name(ctx)}'s record: {text[:80] or '(empty)'}"


def _note_run(ctx, params) -> dict:
    emp = _need_person(ctx)
    text = _render(ctx, params.get("note"))[:NOTE_MAX]
    if not text:
        raise ValueError("The note is empty")
    name = employee_name(emp)
    stamp = f"{_us_date(ctx.today)} - {_workflow_line(ctx)}: {text}"
    emp.notes = f"{(emp.notes or '').rstrip()}\n{stamp}".strip()
    emp.updated_at = _now()
    _audit(ctx, emp, f"Added a note ({_workflow_line(ctx)})", {"note": text[:500]}, kind="comment")
    return {"line": f"Added a note to {name}'s record: {text[:80]}", "affected": _affected(emp), "sent": []}


action("hr.add_note", label="Add A Note To The Record", module=MODULE,
       params=[P("note", "Note", "template", max=NOTE_MAX)],
       plan=_note_plan, run=_note_run,
       allowed=lambda ctx, params: _hr_allowed(ctx, params, "add a note"))


# ── list sources ─────────────────────────────────────────────────────────────
def _days(params, default: int = 14) -> int:
    raw = params.get("days") if isinstance(params, dict) else None
    try:
        n = int(float(raw)) if raw not in (None, "") else default
    except (TypeError, ValueError):
        n = default
    return max(0, min(n, 3650))


def _people(db, ctx):
    """The people a list may hold: in the workflow's company (when it has
    one) and within the run-as user's own sight (the person entity's rule -
    HR for them, their manager, an administrator; Nexus sees everyone's
    public fields), as the task and ticket lists do."""
    q = db.query(models.NexusEmployee).filter(models.NexusEmployee.status.in_(("onboarding", "active")))
    company = ctx.company() if ctx is not None else ""
    if company:
        q = q.filter(models.NexusEmployee.company == company)
    run_as = ctx.run_as if ctx is not None else None
    return [e for e in q.all() if _employee.can_see(db, run_as, e)]


def _today(ctx) -> date:
    return ctx.today if ctx is not None and ctx.today else date.today()


def _in_next(value, today: date, days: int) -> bool:
    try:
        d = date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return False
    return today <= d <= today + timedelta(days=days)


def _probation_ending(db, ctx, params) -> list:
    today, n = _today(ctx), _days(params)
    out = [e for e in _people(db, ctx)
           if isinstance(e.probation, dict) and e.probation.get("status") in ("in_probation", "extended")
           and _in_next(e.probation.get("endDate"), today, n)]
    return sorted(out, key=lambda e: e.probation.get("endDate") or "")


def _contract_ending(db, ctx, params) -> list:
    today, n = _today(ctx), _days(params, 30)
    out = [e for e in _people(db, ctx)
           if isinstance(e.contractor, dict) and _in_next(e.contractor.get("contract_end"), today, n)]
    return sorted(out, key=lambda e: e.contractor.get("contract_end") or "")


def _started_within(db, ctx, params) -> list:
    today, n = _today(ctx), _days(params, 30)
    out = []
    for e in _people(db, ctx):
        try:
            d = date.fromisoformat((e.start_date or "")[:10])
        except ValueError:
            continue
        if today - timedelta(days=n) <= d <= today:
            out.append(e)
    return sorted(out, key=lambda e: e.start_date or "", reverse=True)


def _timeoff_pending_older_than(db, ctx, params) -> list:
    today, n = _today(ctx), _days(params, 3)
    cutoff = (datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc) - timedelta(days=n)).isoformat()
    rows = (db.query(models.TimeOffRequest).filter(models.TimeOffRequest.status == "pending",
                                                   models.TimeOffRequest.created_at != "",
                                                   models.TimeOffRequest.created_at <= cutoff)
            .order_by(models.TimeOffRequest.created_at.asc()).all())
    company = ctx.company() if ctx is not None else ""
    if company:
        emails = {(e.work_email or "").lower() for e in _people(db, ctx)}
        rows = [r for r in rows if (r.employee_email or "").lower() in emails]
    ent = catalog.ENTITIES["time_off_request"]
    run_as = ctx.run_as if ctx is not None else None
    return [r for r in rows if ent.can_see(db, run_as, r)]


list_source("employees.probation_ending", label="People Whose Probation Ends Within N Days", entity="employee",
            module=MODULE, params=[P("days", "Days", "number", default=14, max=3650)], fn=_probation_ending)
list_source("employees.contract_ending", label="People Whose Contract Ends Within N Days", entity="employee",
            module=MODULE, params=[P("days", "Days", "number", default=30, max=3650)], fn=_contract_ending)
list_source("employees.started_within", label="People Who Started In The Last N Days", entity="employee",
            module=MODULE, params=[P("days", "Days", "number", default=30, max=3650)], fn=_started_within)
list_source("timeoff.pending_older_than", label="Time Off Requests Waiting Longer Than N Days",
            entity="time_off_request", module=MODULE, params=[P("days", "Days", "number", default=3, max=3650)],
            fn=_timeoff_pending_older_than)
