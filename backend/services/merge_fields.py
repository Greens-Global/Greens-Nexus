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


def resolve_merge_data(db: Session, employee_id: str = "", candidate_id: str = "",
                        entity_id: str = "", overrides: dict = None) -> dict:
    """Merge dict for {{token}} resolution. Subject person + company + overrides
    (overrides win - e.g. salary is typed in by the caller, never read from a
    compensation column)."""
    data = {"today": datetime.now(timezone.utc).strftime("%B %d, %Y")}
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
        if isinstance(v, (str, int, float)) and re.fullmatch(r"[a-z0-9_]+", str(k)):
            data[str(k)] = str(v)
    return {k: str(v) for k, v in data.items() if v}
