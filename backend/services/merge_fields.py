"""Merge-field ({{token}}) resolution - Documents module (Phase 4).

Deliberately a DUPLICATE of routers/esign.py's _merge_data(), not an import
from it and not a refactor of esign.py to call this module. esign.py's
send/finalize path is a production ESIGN/UETA compliance flow; this function
is small (~35 lines) and self-contained, so duplicating it costs little and
touching esign.py for a reuse tidiness gain isn't worth the regression risk.

Known inherited quirks, kept intentionally to stay behaviorally identical to
e-sign's merge resolution: `salary` has no model column and only resolves via
`overrides`; `manager` resolves to `manager_email` (a raw string), not a
display name looked up on another employee row.
"""
import re
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from models import NexusEmployee, HrCandidate, HrEntity


# ── Variable taxonomy ────────────────────────────────────────────────────────
# A variable name is dotted: a group, then the field within it -
# `principal.amount`, `agreement.date`, `place.execution`. The convention is
# what makes a library of 15-60 templates legible; a flat soup of
# `amount2`/`amt_final` is what it exists to prevent.
#
# Single-segment names stay valid: every built-in resolved above is one
# (`full_name`, `company`, `today`), and templates already in the library use
# them. Both forms are accepted; only the shape is enforced, never the
# vocabulary, so a department can name a group this code has never heard of.
TOKEN_RE = re.compile(r"[a-z0-9_]+(?:\.[a-z0-9_]+)*")
_MAX_TOKEN_LEN = 80


def is_valid_token(token: str) -> bool:
    t = (token or "").strip()
    return bool(t) and len(t) <= _MAX_TOKEN_LEN and TOKEN_RE.fullmatch(t) is not None


def token_group(token: str) -> str:
    """The part before the first dot - what a variable library groups by.
    An undotted built-in belongs to the implicit "general" group."""
    return token.split(".", 1)[0] if "." in (token or "") else "general"


def group_label(group: str) -> str:
    """The group as a person reads it: `party_a` -> "Party A"."""
    return " ".join(w[:1].upper() + w[1:] for w in str(group or "").split("_") if w) or "Other"


# Variables about the TEMPLATE ITSELF. The system knows every one of these, so
# nobody should be typing them into a wizard: asking someone for the template's
# own version number is precisely the manual work this module exists to remove,
# and a hand-typed version is one that can be wrong. Resolved from the template
# row at generation time, and skipped by the required-field guard.
TEMPLATE_PREFIX = "template."


def is_auto_token(token: str) -> bool:
    return str(token or "").startswith(TEMPLATE_PREFIX)


def template_merge_data(template) -> dict:
    """The `template.*` variables, read off the template row."""
    if template is None:
        return {}
    return {
        "template.name": template.name or "",
        "template.version": str(template.version or 1),
        "template.last_updated": (template.updated_at or template.created_at or "")[:10],
        "template.owner_department": template.department or "",
    }


# The variables this module resolves on its own, with the labels a person
# browsing the library reads. Their tokens are deliberately NOT renamed into
# the dotted taxonomy: templates in the library already use them, and renaming
# would break every one of those documents for a cosmetic gain. They are
# GROUPED for display instead, which is what the taxonomy is actually for.
BUILTIN_VARIABLES = [
    ("full_name", "Full name", "Person"),
    ("first_name", "First name", "Person"),
    ("last_name", "Last name", "Person"),
    ("email", "Email", "Person"),
    ("work_email", "Work email", "Person"),
    ("personal_email", "Personal email", "Person"),
    ("phone", "Phone", "Person"),
    ("job_title", "Job title", "Person"),
    ("department", "Department", "Person"),
    ("start_date", "Start date", "Person"),
    ("location", "Location", "Person"),
    ("employee_code", "Employee code", "Person"),
    ("manager", "Manager", "Person"),
    ("salary", "Salary", "Person"),
    ("company", "Company", "Company"),
    ("company_legal", "Company legal name", "Company"),
    ("company_address", "Company address", "Company"),
    ("signatory", "Company signatory", "Company"),
    ("today", "Today's date", "Document"),
    # About the template itself - filled by the system, never asked for.
    ("template.name", "Template name", "Template"),
    ("template.version", "Template version", "Template"),
    ("template.last_updated", "Template last updated", "Template"),
    ("template.owner_department", "Template owner department", "Template"),
]


def resolve_merge_data(db: Session, employee_id: str = "", candidate_id: str = "",
                        entity_id: str = "", overrides: dict = None, template=None) -> dict:
    """Merge dict for {{token}} resolution. Subject person + company + the
    template's own metadata + overrides (overrides win - e.g. salary is typed
    in by the caller, never read from a compensation column)."""
    data = {"today": datetime.now(timezone.utc).strftime("%B %d, %Y")}
    data.update(template_merge_data(template))
    if employee_id:
        e = db.query(NexusEmployee).filter(NexusEmployee.id == employee_id).first()
        if e:
            data.update({
                "first_name": e.first_name, "last_name": e.last_name,
                "full_name": f"{e.first_name} {e.last_name}".strip(),
                "email": e.work_email or e.personal_email, "work_email": e.work_email,
                "personal_email": e.personal_email, "phone": e.phone,
                "job_title": e.job_title, "department": e.department,
                "start_date": e.start_date, "location": e.location,
                "employee_code": e.employee_code, "manager": e.manager_email,
            })
    if candidate_id:
        c = db.query(HrCandidate).filter(HrCandidate.id == candidate_id).first()
        if c:
            data.update({
                "first_name": c.first_name, "last_name": c.last_name,
                "full_name": f"{c.first_name} {c.last_name}".strip(),
                "email": c.email, "phone": c.phone, "job_title": c.role_title,
                "department": c.department, "start_date": c.expected_start,
            })
    if entity_id:
        en = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
        if en:
            data.update({"company": en.name, "company_legal": en.legal_name or en.name,
                         "company_address": en.registered_address, "signatory": en.signatory})
    for k, v in (overrides or {}).items():
        if isinstance(v, (str, int, float)) and is_valid_token(str(k)):
            data[str(k)] = str(v)
    return {k: str(v) for k, v in data.items() if v}
