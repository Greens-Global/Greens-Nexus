"""Headcount requests and job openings (Neil, Oct 27 2026).

A HEADCOUNT request is asking to hire - before there is any candidate. It is
not a purchase requisition (routers/requisitions.py is those).

  Draft -> Awaiting Approval -> Approved | Declined

Who raises one: a manager (level 3 and up) or HR (a People editor). Who
approves, in order:
  1. the department: the head of the role's department for that company and
     everyone above them in the reporting line - the same chain the
     screening task goes to (hiring_screening.department_head). One of them
     approving is enough. Raised by someone already in that line, this step
     is done by the raising. Nobody set up: the Global Admins.
  2. HR++: the company's HR contact, an administrator or owner, or someone
     with a Full People grant for that company - never the person who raised
     it.
Declined needs a reason; the requester can change it and send it again.
Approved makes a Draft job opening (hiring_openings.opening_from_request).

The salary range is restricted data: it goes out only to Pay & Benefits
(hr_comp) holders and owners - everyone else sees whether one is set. A
manager can give one when raising the request; changing it afterwards takes
Pay & Benefits too.

Every bell is server-side, one per person per request, rewritten in place
(hiring_openings.notify_once), and opens Team > Headcount.

OPENINGS are HR's: People readers see them, People editors change them. Pay
on an opening is shown to hr_comp holders, or to everyone once the public
pay toggle (off by default) is on - and only hr_comp holders turn it on.
"""
import re
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import hiring_openings as ho
import models
from auth import (_module_level, company_of, company_ok, company_scope, get_current_user, hr_scope,
                  hr_team_limited, is_team_scope)
from database import get_db

router = APIRouter(prefix="/hiring", tags=["hiring"])

STATUSES = ("draft", "awaiting_approval", "approved", "declined")
STATUS_LABELS = {"draft": "Draft", "awaiting_approval": "Awaiting Approval", "approved": "Approved", "declined": "Declined"}
_FULL = 3                 # auth.MODULE_LEVELS rank of "full"
_EDITOR = 2
MAX_OPENINGS = 100
_ACTION = {"view": "shifts", "sub": "headcount"}


def _now() -> str:
    return ho.now_iso()


def _clean(v, limit: int = 200) -> str:
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(v or "")).strip()[:limit]


def _check_day(v: str, label: str) -> str:
    v = (v or "").strip()[:10]
    if v:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, f"{label} is not a valid date.")
    return v


# ── who is who ───────────────────────────────────────────────────────────────

def _hr_reader(db: Session, user: dict, company: Optional[str] = None) -> bool:
    """People (HR) access for this company: the grant (or administrator and
    up) - never the manager tier, whose People grant covers only their team."""
    if user.get("external") or hr_team_limited(user):
        return False
    if user.get("level", 0) < 4 and _module_level(user["email"], "hr", db) < 1:
        return False
    if company is None:
        return True
    scope = hr_scope(user, db)
    return scope is None or (not is_team_scope(scope) and (company or "") in scope)


def _hr_editor(db: Session, user: dict, company: Optional[str] = None) -> bool:
    if not _hr_reader(db, user, company):
        return False
    return user.get("level", 0) >= 4 or _module_level(user["email"], "hr", db) >= _EDITOR


def _comp(db: Session, user: dict) -> bool:
    from routers.hr import _has_comp
    return _has_comp(user, db)


def can_raise(db: Session, user: dict) -> bool:
    if user.get("external"):
        return False
    return user.get("level", 0) >= 3 or _hr_editor(db, user)


def is_hr_approver(db: Session, user: dict, company: str) -> bool:
    """HR++ for a company: its HR contact, an administrator or owner who can
    see the company, or a Full People grant for it."""
    email = (user.get("email") or "").strip().lower()
    if not email or user.get("external"):
        return False
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == company).first() if company else None
    if ent is not None and (ent.hr_contact_email or "").strip().lower() == email:
        return True
    if user.get("level", 0) >= 4:
        return company_ok(company, company_scope(user, db))
    if not hr_team_limited(user) and _module_level(email, "hr", db) >= _FULL:
        scope = hr_scope(user, db)
        return scope is None or (not is_team_scope(scope) and company in scope)
    return False


def department_line(db: Session, company: str, department: str, role_id: str) -> list:
    """The department head for the role and everyone above them - the
    screening chain without HR (hiring_screening.screeners)."""
    from types import SimpleNamespace

    import hiring_screening as hs
    head = hs.department_head(db, SimpleNamespace(company=company, department=department, role_id=role_id))
    out, email = [], head
    while email and email not in out and len(out) < hs.MAX_CHAIN:
        p = hs._person(db, email)
        if p is None:
            break
        out.append(email)
        email = (p.manager_email or "").strip().lower()
    return out


def hr_targets(db: Session, company: str, exclude: str) -> list:
    """Who is told the HR step is theirs: the company's HR contact, else the
    Global Admins - never the requester."""
    import hiring_screening as hs
    import hr_checklists as hc
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == company).first() if company else None
    hr = (ent.hr_contact_email or "").strip().lower() if ent else ""
    people = [hr] if hr and hr != exclude and hs._person(db, hr) else []
    return people or [e for e in hc.global_admins(db) if e != exclude]


def _names(db: Session, emails) -> dict:
    want = {(e or "").strip().lower() for e in emails if e}
    if not want:
        return {}
    return {(r.work_email or "").lower(): ((r.display_name or f"{r.first_name} {r.last_name}").strip() or r.work_email)
            for r in db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.in_(want)).all()}


def _name(names: dict, email: str) -> str:
    e = (email or "").lower()
    return names.get(e) or e.split("@")[0].replace(".", " ").title()


# ── headcount requests ───────────────────────────────────────────────────────

class HeadcountIn(BaseModel):
    company:         Optional[str] = None
    department:      Optional[str] = None
    role_id:         Optional[str] = None
    role_title:      Optional[str] = None
    work_site_id:    Optional[str] = None
    location:        Optional[str] = None
    employment_type: Optional[str] = None
    openings:        Optional[int] = None
    target_start:    Optional[str] = None
    salary_min:      Optional[float] = None
    salary_max:      Optional[float] = None
    salary_currency: Optional[str] = None
    salary_period:   Optional[str] = None
    justification:   Optional[str] = None
    submit:          Optional[bool] = False


class DecideIn(BaseModel):
    decision: str            # approve | decline
    note:     Optional[str] = ""


def _visible(db: Session, user: dict, row: models.HrHeadcountRequest, cache: dict) -> bool:
    me = user["email"].lower()
    if (row.requested_by or "").lower() == me or me in [e.lower() for e in (row.dept_approvers or [])]:
        return True
    key = row.company or ""
    if key not in cache:
        cache[key] = _hr_reader(db, user, key) or is_hr_approver(db, user, key)
    return cache[key]


def _can_decide(db: Session, user: dict, row: models.HrHeadcountRequest) -> bool:
    me = user["email"].lower()
    if row.status != "awaiting_approval":
        return False
    if row.step == "department":
        return (me != (row.requested_by or "").lower()
                and me in [e.lower() for e in (row.dept_approvers or [])])
    if row.step == "hr":
        return me != (row.requested_by or "").lower() and is_hr_approver(db, user, row.company)
    return False


def _can_edit(db: Session, user: dict, row: models.HrHeadcountRequest) -> bool:
    if row.status not in ("draft", "declined"):
        return False
    return (row.requested_by or "").lower() == user["email"].lower() or _hr_editor(db, user, row.company)


def _ser_request(db: Session, row: models.HrHeadcountRequest, user: dict, comp: bool, names: dict,
                 companies: dict, openings: dict) -> dict:
    op = openings.get(row.opening_id or "")
    out = {
        "id": row.id, "code": row.code or "", "company": row.company or "",
        "companyName": companies.get(row.company or "", ""), "department": row.department or "",
        "roleId": row.role_id or "", "roleTitle": row.role_title or "", "workSiteId": row.work_site_id or "",
        "location": row.location or "", "employmentType": row.employment_type or "",
        "employmentLabel": ho.EMPLOYMENT_LABELS.get(row.employment_type or "", ""),
        "openings": row.openings or 1, "targetStart": row.target_start or "",
        "justification": row.justification or "", "status": row.status,
        "statusLabel": STATUS_LABELS.get(row.status, row.status), "step": row.step or "",
        "requestedBy": row.requested_by or "", "requestedByName": _name(names, row.requested_by),
        "submittedAt": row.submitted_at or "",
        "deptApprovers": [{"email": e, "name": _name(names, e)} for e in (row.dept_approvers or [])],
        "deptDecidedBy": row.dept_decided_by or "", "deptDecidedByName": _name(names, row.dept_decided_by) if row.dept_decided_by else "",
        "hrDecidedBy": row.hr_decided_by or "", "hrDecidedByName": _name(names, row.hr_decided_by) if row.hr_decided_by else "",
        "declineNote": row.decline_note or "", "openingId": row.opening_id or "",
        "openingStatus": op.status if op is not None else "",
        "history": [{**h, "byName": _name(names, h.get("by", "")) if h.get("by") else ""} for h in (row.history or [])],
        "createdAt": row.created_at or "", "updatedAt": row.updated_at or "",
        "hasSalary": row.salary_min is not None or row.salary_max is not None,
        "canEdit": _can_edit(db, user, row), "canDecide": _can_decide(db, user, row),
        "canSeePay": comp,
    }
    if comp:
        out.update({"salaryMin": row.salary_min, "salaryMax": row.salary_max,
                    "salaryCurrency": row.salary_currency or "USD", "salaryPeriod": row.salary_period or "year"})
    return out


def _out(db: Session, user: dict, rows: list) -> list:
    comp = _comp(db, user)
    emails = set()
    for r in rows:
        emails |= {r.requested_by, r.dept_decided_by, r.hr_decided_by, *(r.dept_approvers or [])}
        emails |= {h.get("by", "") for h in (r.history or [])}
    names = _names(db, emails)
    companies = {e.id: e.name for e in db.query(models.HrEntity).all()}
    ids = [r.opening_id for r in rows if r.opening_id]
    openings = ({o.id: o for o in db.query(models.HrJobOpening).filter(models.HrJobOpening.id.in_(ids)).all()}
                if ids else {})
    return [_ser_request(db, r, user, comp, names, companies, openings) for r in rows]


def _get_request(db: Session, user: dict, rid: str, lock: bool = False) -> models.HrHeadcountRequest:
    q = db.query(models.HrHeadcountRequest).filter(models.HrHeadcountRequest.id == rid)
    row = q.with_for_update().first() if lock else q.first()
    if row is None or not _visible(db, user, row, {}):
        raise HTTPException(404, "Headcount request not found")
    return row


def _company_choices(db: Session, user: dict) -> list:
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    if _hr_reader(db, user):
        scope = hr_scope(user, db)
        return [e for e in rows if scope is None or e.id in scope]
    scope = company_scope(user, db)
    if scope is not None:
        return [e for e in rows if e.id in scope]
    return rows


def _next_code(db: Session) -> str:
    n = db.query(models.HrHeadcountRequest).count() + 1
    while db.query(models.HrHeadcountRequest.id).filter(models.HrHeadcountRequest.code == f"HC-{n:04d}").first():
        n += 1
    return f"HC-{n:04d}"


def _apply(db: Session, user: dict, row: models.HrHeadcountRequest, body: HeadcountIn, creating: bool) -> None:
    """Copy the form onto the row, checking each field."""
    fields = body.model_dump(exclude_unset=True)
    if "company" in fields:
        cid = _clean(body.company, 64)
        if cid not in {e.id for e in _company_choices(db, user)}:
            raise HTTPException(400, "Pick one of your companies.")
        row.company = cid
    if "company" in fields and "role_id" not in fields and row.role_id:
        fields["role_id"], body.role_id = row.role_id, row.role_id     # the role must belong to the new company
    if "role_id" in fields:
        rid = _clean(body.role_id, 64)
        if rid:
            from routers.hr import _job_role_for
            role = _job_role_for(db, rid, row.company or "")
            row.role_id, row.role_title = role.id, role.name
            if (role.department or "").strip():
                row.department = role.department.strip()
        else:
            row.role_id = ""
    if "role_title" in fields and not row.role_id:
        row.role_title = _clean(body.role_title, 140)
    if "department" in fields and not (row.role_id and row.department):
        row.department = _clean(body.department, 120)
    if "work_site_id" in fields:
        sid = _clean(body.work_site_id, 64)
        if sid:
            from routers.hr import company_sites
            site = next((s for s in company_sites(db, row.company) if s.id == sid), None)
            if site is None:
                raise HTTPException(400, "That work site is not one of the company's.")
            row.work_site_id, row.location = site.id, site.name
        else:
            row.work_site_id = ""
    if "location" in fields and not row.work_site_id:
        row.location = _clean(body.location, 200)
    if "employment_type" in fields:
        et = _clean(body.employment_type, 32)
        if et not in ho.EMPLOYMENT_TYPES:
            raise HTTPException(400, "Pick the employment type.")
        row.employment_type = et
    if "openings" in fields:
        n = body.openings or 0
        if not 1 <= n <= MAX_OPENINGS:
            raise HTTPException(400, f"Number of openings must be 1 to {MAX_OPENINGS}.")
        row.openings = n
    if "target_start" in fields:
        row.target_start = _check_day(body.target_start, "Target start date")
    if "justification" in fields:
        row.justification = _clean(body.justification, 4000)
    pay_keys = {"salary_min", "salary_max", "salary_currency", "salary_period"} & set(fields)
    if pay_keys:
        # Restricted (hr_comp): anyone raising a request may give a range; changing
        # one afterwards takes Pay & Benefits - they cannot see what they would overwrite.
        if not creating and not _comp(db, user):
            raise HTTPException(403, "Only Pay & Benefits access can change the salary range.")
        _apply_pay(row, fields, "salary")


def _apply_pay(row, fields: dict, prefix: str) -> None:
    from currency import is_currency
    lo = fields.get(f"{prefix}_min", getattr(row, f"{prefix}_min"))
    hi = fields.get(f"{prefix}_max", getattr(row, f"{prefix}_max"))
    for v in (lo, hi):
        if v is not None and not (0 <= v <= 100_000_000):
            raise HTTPException(400, "The pay range doesn't look right.")
    if lo is not None and hi is not None and lo > hi:
        raise HTTPException(400, "The pay range's minimum is above its maximum.")
    setattr(row, f"{prefix}_min", lo)
    setattr(row, f"{prefix}_max", hi)
    if f"{prefix}_currency" in fields:
        cur = (fields[f"{prefix}_currency"] or "USD").strip().upper()
        if not is_currency(cur):
            raise HTTPException(400, "Unknown currency.")
        setattr(row, f"{prefix}_currency", cur)
    if f"{prefix}_period" in fields:
        per = (fields[f"{prefix}_period"] or "year").strip().lower()
        if per not in ho.PAY_PERIODS:
            raise HTTPException(400, "Pay period must be per year, month or hour.")
        setattr(row, f"{prefix}_period", per)


def _missing(row: models.HrHeadcountRequest) -> list:
    return [label for ok, label in ((row.company, "Company"), (row.role_title, "Role or title"),
                                    (row.department, "Department"), (row.employment_type, "Employment type"),
                                    (row.openings, "Number of openings"), (row.justification, "Justification"))
            if not ok]


def _ask(db: Session, row: models.HrHeadcountRequest, emails: list, by: str, after_department: bool) -> None:
    names = _names(db, [row.requested_by])
    who = _name(names, row.requested_by)
    n = row.openings or 1
    text = (f"{who} asks to hire {n} {row.role_title}" + (f" ({row.department})" if row.department else "")
            + (" - the department approved it" if after_department else "") + ". Approve or decline it in Team > Headcount.")
    for email in emails:
        ho.notify_once(db, email, f"headcount:{row.id}", f"Headcount Request To Approve - {row.role_title}", text,
                       by=by, action=_ACTION)


def _tell_requester(db: Session, row: models.HrHeadcountRequest, title: str, body: str, by: str) -> None:
    if (row.requested_by or "").lower() != (by or "").lower():
        ho.notify_once(db, row.requested_by, f"headcount:{row.id}", title, body, by=by, action=_ACTION)


def _settle(db: Session, row: models.HrHeadcountRequest, keep: str = "") -> None:
    """The step is decided: the other approvers' bells for it are done."""
    for n in (db.query(models.NexusNotification)
              .filter(models.NexusNotification.ref_id == f"headcount:{row.id}",
                      models.NexusNotification.recipient != (keep or "").lower(),
                      models.NexusNotification.recipient != (row.requested_by or "").lower()).all()):
        n.actioned = True


def _submit(db: Session, user: dict, row: models.HrHeadcountRequest) -> None:
    missing = _missing(row)
    if missing:
        raise HTTPException(400, f"Still needed: {', '.join(missing)}.")
    me = user["email"].lower()
    import hr_checklists as hc
    line = department_line(db, row.company, row.department, row.role_id)
    now = _now()
    row.submitted_at, row.decline_note = now, ""
    row.dept_decided_by = row.dept_decided_at = row.hr_decided_by = row.hr_decided_at = ""
    row.status = "awaiting_approval"
    ho.history_add(row, me, "submitted")
    if (row.requested_by or "").lower() in line:
        # Raised by the department's own line - their raising is the approval.
        row.dept_approvers = line
        row.dept_decided_by, row.dept_decided_at = row.requested_by, now
        ho.history_add(row, row.requested_by, "department_approved", "Raised by the department's own line")
        row.step = "hr"
        _ask(db, row, hr_targets(db, row.company, me), me, after_department=True)
    else:
        # No department line: the Global Admins - never the requester (nor
        # whoever submits it). The requester as the only Global Admin goes
        # straight to the HR step with a note, never approving their own.
        asker = (row.requested_by or "").lower()
        approvers = line or [e for e in hc.global_admins(db) if e not in (me, asker)]
        if approvers:
            row.dept_approvers = approvers
            row.step = "department"
            _ask(db, row, row.dept_approvers, me, after_department=False)
        else:
            row.dept_approvers = []
            ho.history_add(row, me, "department_skipped",
                           "No department approver other than the requester - sent to HR")
            row.step = "hr"
            _ask(db, row, hr_targets(db, row.company, asker), me, after_department=False)


@router.get("/headcount/meta")
def headcount_meta(company_id: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the Headcount tab needs: may this person raise one, see pay, and
    the form's lists for a company (its departments, roles and work sites)."""
    raise_ok = can_raise(db, user)
    companies = _company_choices(db, user) if raise_ok else []
    cid = (company_id or "").strip() or (company_of(user, db) if raise_ok else "")
    if cid and cid not in {e.id for e in companies}:
        cid = ""
    depts, roles, sites = [], [], []
    if cid:
        from routers.hr import _ensure_departments, company_sites
        ent = next(e for e in companies if e.id == cid)
        _ensure_departments(db, ent)
        depts = [d.name for d in db.query(models.HrDepartment).filter(models.HrDepartment.company_id == cid)
                 .order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all()]
        roles = [{"id": r.id, "name": r.name, "department": r.department or "", "companyId": r.company_id or ""}
                 for r in db.query(models.NexusGroup).filter(models.NexusGroup.is_job_role == 1)
                 .order_by(models.NexusGroup.name).all() if not (r.company_id or "") or r.company_id == cid]
        sites = [{"id": s.id, "name": s.name, "address": s.address or ""} for s in company_sites(db, cid)]
    cache: dict = {}
    me = user["email"].lower()
    rows = [r for r in db.query(models.HrHeadcountRequest).filter(models.HrHeadcountRequest.status != "draft").all()
            if _visible(db, user, r, cache)]
    mine = db.query(models.HrHeadcountRequest.id).filter(models.HrHeadcountRequest.requested_by == me).first()
    return {"canRaise": raise_ok, "canSeePay": _comp(db, user), "isHr": _hr_reader(db, user),
            "companyId": cid, "companies": [{"id": e.id, "name": e.name} for e in companies],
            "departments": depts, "roles": roles, "workSites": sites,
            "employmentTypes": [{"value": k, "label": ho.EMPLOYMENT_LABELS[k]} for k in ho.EMPLOYMENT_TYPES],
            "waiting": sum(1 for r in rows if _can_decide(db, user, r)),
            "showTab": raise_ok or bool(rows) or mine is not None}


@router.get("/headcount")
def list_headcount(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    cache: dict = {}
    rows = [r for r in db.query(models.HrHeadcountRequest).order_by(models.HrHeadcountRequest.created_at.desc()).all()
            if (r.status != "draft" or (r.requested_by or "").lower() == me or _hr_editor(db, user, r.company))
            and _visible(db, user, r, cache)]
    return _out(db, user, rows)


@router.post("/headcount")
def create_headcount(body: HeadcountIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not can_raise(db, user):
        raise HTTPException(403, "Headcount requests are raised by managers and HR.")
    now = _now()
    row = models.HrHeadcountRequest(id=str(uuid.uuid4()), code=_next_code(db), status="draft", step="",
                                    requested_by=user["email"].lower(), employment_type="full_time", openings=1,
                                    salary_currency="USD", salary_period="year", dept_approvers=[], history=[],
                                    created_at=now, updated_at=now)
    if body.company is None:
        body.company = company_of(user, db)
    _apply(db, user, row, body, creating=True)
    ho.history_add(row, user["email"], "created")
    db.add(row)
    if body.submit:
        _submit(db, user, row)
    db.commit()
    db.refresh(row)
    return _out(db, user, [row])[0]


@router.patch("/headcount/{rid}")
def update_headcount(rid: str, body: HeadcountIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_request(db, user, rid, lock=True)
    if not _can_edit(db, user, row):
        raise HTTPException(409, "Only a draft or a declined request can be changed - by whoever raised it, or HR.")
    _apply(db, user, row, body, creating=False)
    row.updated_at = _now()
    ho.history_add(row, user["email"], "edited")
    if body.submit:
        _submit(db, user, row)
    db.commit()
    db.refresh(row)
    return _out(db, user, [row])[0]


@router.post("/headcount/{rid}/submit")
def submit_headcount(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_request(db, user, rid, lock=True)
    if not _can_edit(db, user, row):
        raise HTTPException(409, "This request is already with the approvers.")
    _submit(db, user, row)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return _out(db, user, [row])[0]


@router.post("/headcount/{rid}/decide")
def decide_headcount(rid: str, body: DecideIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_request(db, user, rid, lock=True)
    if not _can_decide(db, user, row):
        if row.status != "awaiting_approval":
            raise HTTPException(409, "This request has already been decided.")
        if row.step == "hr" and (row.requested_by or "").lower() == user["email"].lower():
            raise HTTPException(403, "You raised this request - someone else in HR approves it.")
        raise HTTPException(403, "This step is not yours to decide.")
    decision = (body.decision or "").strip().lower()
    note = _clean(body.note, 2000)
    me, now = user["email"].lower(), _now()
    who = _name(_names(db, [me]), me)
    if decision == "decline":
        if not note:
            raise HTTPException(400, "Say why it is declined.")
        row.status, row.decline_note = "declined", note
        if row.step == "department":
            row.dept_decided_by, row.dept_decided_at = me, now
        else:
            row.hr_decided_by, row.hr_decided_at = me, now
        ho.history_add(row, me, f"{row.step}_declined", note)
        row.step = ""
        _settle(db, row, keep=me)
        _tell_requester(db, row, f"Headcount Request Declined - {row.role_title}",
                        f"{who} declined your request to hire {row.role_title}: {note}", me)
    elif decision == "approve":
        if row.step == "department":
            row.dept_decided_by, row.dept_decided_at, row.step = me, now, "hr"
            ho.history_add(row, me, "department_approved", note)
            _settle(db, row, keep=me)
            _ask(db, row, hr_targets(db, row.company, (row.requested_by or "").lower()), me, after_department=True)
            _tell_requester(db, row, f"Headcount Request Approved By The Department - {row.role_title}",
                            f"{who} approved your request to hire {row.role_title}. It is with HR now.", me)
        else:
            row.hr_decided_by, row.hr_decided_at, row.step, row.status = me, now, "", "approved"
            ho.history_add(row, me, "hr_approved", note)
            op = ho.opening_from_request(db, row, me)
            row.opening_id = op.id
            _settle(db, row, keep=me)
            _tell_requester(db, row, f"Headcount Request Approved - {row.role_title}",
                            f"{who} approved your request to hire {row.openings or 1} {row.role_title}. "
                            f"HR is preparing the job opening.", me)
    else:
        raise HTTPException(400, "decision must be approve or decline")
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return _out(db, user, [row])[0]


# ── job openings (HR) ────────────────────────────────────────────────────────

class OpeningIn(BaseModel):
    title:              Optional[str] = None
    description:        Optional[str] = None
    department:         Optional[str] = None
    employment_type:    Optional[str] = None
    seats:              Optional[int] = None
    work_site_id:       Optional[str] = None
    location:           Optional[str] = None
    street:             Optional[str] = None
    city:               Optional[str] = None
    region:             Optional[str] = None
    postal_code:        Optional[str] = None
    country:            Optional[str] = None
    remote:             Optional[bool] = None
    status:             Optional[str] = None
    show_pay:           Optional[bool] = None
    pay_min:            Optional[float] = None
    pay_max:            Optional[float] = None
    pay_currency:       Optional[str] = None
    pay_period:         Optional[str] = None
    hiring_owner_email: Optional[str] = None
    valid_through:      Optional[str] = None
    note:               Optional[str] = None


# Status moves HR makes by hand. Filled is set by the last hire (and can be
# reopened if a hire falls through).
_MOVES = {"draft": {"open", "closed"}, "open": {"paused", "closed", "filled"}, "paused": {"open", "closed"},
          "filled": {"open", "closed"}, "closed": {"open"}}


def _require_hr_read(db: Session, user: dict) -> None:
    if not _hr_reader(db, user):
        raise HTTPException(403, "You don't have access to this screen")


def _ser_opening(db: Session, op: models.HrJobOpening, comp: bool, names: dict, companies: dict,
                 counts: dict, codes: dict, slugs: dict) -> dict:
    from app_url import app_url
    slug = slugs.get(op.company or "", "")
    out = {
        "id": op.id, "headcountId": op.headcount_id or "", "headcountCode": codes.get(op.headcount_id or "", ""),
        "company": op.company or "", "companyName": companies.get(op.company or "", ""),
        "department": op.department or "", "roleId": op.role_id or "", "title": op.title or "",
        "description": op.description or "", "employmentType": op.employment_type or "",
        "employmentLabel": ho.EMPLOYMENT_LABELS.get(op.employment_type or "", ""), "seats": op.seats or 1,
        "workSiteId": op.work_site_id or "", "location": op.location or "", "street": op.street or "",
        "city": op.city or "", "region": op.region or "", "postalCode": op.postal_code or "",
        "country": op.country or "", "remote": bool(op.remote), "locationLine": ho.location_line(op),
        "status": op.status, "statusLabel": ho.STATUS_LABELS.get(op.status, op.status),
        "showPay": bool(op.show_pay), "hasPay": op.pay_min is not None or op.pay_max is not None,
        "hiringOwnerEmail": op.hiring_owner_email or "",
        "hiringOwnerName": _name(names, op.hiring_owner_email) if op.hiring_owner_email else "",
        "validThrough": op.valid_through or "", "openedAt": op.opened_at or "", "filledAt": op.filled_at or "",
        "closedAt": op.closed_at or "", "listed": ho.is_listed(op),
        "counts": counts.get(op.id, {"total": 0, "hired": 0}),
        "careersUrl": f"{app_url()}/careers/{slug}/{op.id}" if slug else "",
        "history": [{**h, "byName": _name(names, h.get("by", "")) if h.get("by") else ""} for h in (op.history or [])],
        "createdAt": op.created_at or "", "updatedAt": op.updated_at or "",
    }
    if comp or op.show_pay:
        out.update({"payMin": op.pay_min, "payMax": op.pay_max, "payCurrency": op.pay_currency or "USD",
                    "payPeriod": op.pay_period or "year", "payText": ho.pay_text(op)})
    return out


def _openings_out(db: Session, user: dict, rows: list) -> list:
    comp = _comp(db, user)
    emails = {r.hiring_owner_email for r in rows} | {h.get("by", "") for r in rows for h in (r.history or [])}
    names = _names(db, emails)
    companies = {e.id: e.name for e in db.query(models.HrEntity).all()}
    counts = ho.candidate_counts(db, [r.id for r in rows])
    hids = [r.headcount_id for r in rows if r.headcount_id]
    codes = ({h.id: h.code for h in db.query(models.HrHeadcountRequest).filter(models.HrHeadcountRequest.id.in_(hids)).all()}
             if hids else {})
    slugs = {e.id: s for s, e in ho.slug_map(db).items()}
    return [_ser_opening(db, r, comp, names, companies, counts, codes, slugs) for r in rows]


def _opening_in_scope(db: Session, user: dict, oid: str, lock: bool = False) -> models.HrJobOpening:
    q = db.query(models.HrJobOpening).filter(models.HrJobOpening.id == oid)
    op = q.with_for_update().first() if lock else q.first()
    if op is None or not _hr_reader(db, user, op.company):
        raise HTTPException(404, "Opening not found")
    return op


@router.get("/openings")
def list_openings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_hr_read(db, user)
    scope = hr_scope(user, db)
    q = db.query(models.HrJobOpening)
    if scope is not None:
        q = q.filter(models.HrJobOpening.company.in_(list(scope)))
    return _openings_out(db, user, q.order_by(models.HrJobOpening.created_at.desc()).all())


@router.get("/openings/{oid}")
def get_opening(oid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _openings_out(db, user, [_opening_in_scope(db, user, oid)])[0]


@router.patch("/openings/{oid}")
def update_opening(oid: str, body: OpeningIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    op = _opening_in_scope(db, user, oid, lock=True)
    if not _hr_editor(db, user, op.company):
        raise HTTPException(403, "Changing an opening takes People edit access.")
    fields = body.model_dump(exclude_unset=True)
    me = user["email"].lower()
    for key, limit in (("title", 140), ("department", 120), ("location", 200), ("street", 200), ("city", 120),
                       ("region", 120), ("postal_code", 20)):
        if key in fields:
            setattr(op, key, _clean(fields[key], limit))
    if "title" in fields and not op.title:
        raise HTTPException(400, "The opening needs a title.")
    if "description" in fields:
        op.description = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", body.description or "").strip()[:20000]
    if "country" in fields:
        c = _clean(body.country, 2).upper()
        if c and not re.fullmatch(r"[A-Z]{2}", c):
            raise HTTPException(400, "Country is a two-letter code (US, IN...).")
        op.country = c
    if "remote" in fields:
        op.remote = bool(body.remote)
    if "employment_type" in fields:
        if body.employment_type not in ho.EMPLOYMENT_TYPES:
            raise HTTPException(400, "Pick the employment type.")
        op.employment_type = body.employment_type
    if "seats" in fields:
        if not 1 <= (body.seats or 0) <= MAX_OPENINGS:
            raise HTTPException(400, f"Seats must be 1 to {MAX_OPENINGS}.")
        op.seats = body.seats
    if "work_site_id" in fields:
        sid = _clean(body.work_site_id, 64)
        if sid:
            from routers.hr import company_sites
            site = next((s for s in company_sites(db, op.company) if s.id == sid), None)
            if site is None:
                raise HTTPException(400, "That work site is not one of the company's.")
            op.work_site_id = site.id
            if "location" not in fields:
                op.location = site.name
            if "street" not in fields:
                op.street = site.address or ""
        else:
            op.work_site_id = ""
    if "valid_through" in fields:
        op.valid_through = _check_day(body.valid_through, "Open until")
    if "hiring_owner_email" in fields:
        email = _clean(body.hiring_owner_email, 200).lower()
        if email:
            import hiring_screening as hs
            if hs._person(db, email) is None:
                raise HTTPException(400, "Pick the hiring owner from Nexus People.")
        op.hiring_owner_email = email
    pay_keys = {"pay_min", "pay_max", "pay_currency", "pay_period", "show_pay"} & set(fields)
    if pay_keys:
        if not _comp(db, user):
            raise HTTPException(403, "Pay on an opening takes Pay & Benefits access.")
        _apply_pay(op, fields, "pay")
        if "show_pay" in fields:
            op.show_pay = bool(body.show_pay)
            ho.history_add(op, me, "pay_shown" if op.show_pay else "pay_hidden")
        if op.show_pay and op.pay_min is None and op.pay_max is None:
            raise HTTPException(400, "Set the pay range before showing it on the careers page.")
    if "status" in fields and body.status != op.status:
        to = body.status or ""
        if to not in ho.OPENING_STATUSES or to not in _MOVES.get(op.status, set()):
            raise HTTPException(409, f"An opening that is {ho.STATUS_LABELS.get(op.status, op.status)} can't become "
                                     f"{ho.STATUS_LABELS.get(to, to)}.")
        if to == "open":
            if not (op.description or "").strip():
                raise HTTPException(400, "Write the job description before opening it - it is what the careers page shows.")
            if not ho.location_line(op) and not op.remote:
                raise HTTPException(400, "Set where the job is (or mark it remote) before opening it.")
            op.opened_at = op.opened_at or _now()
            if not op.valid_through or op.valid_through[:10] < datetime.now().date().isoformat():
                op.valid_through = ho.default_valid_through(_now())
        if to == "closed":
            op.closed_at = _now()
        if to == "filled":
            op.filled_at = _now()
        ho.history_add(op, me, to, _clean(body.note, 500))
        op.status = to
    op.updated_at = _now()
    if "status" not in fields:
        ho.history_add(op, me, "edited")
    db.commit()
    db.refresh(op)
    return _openings_out(db, user, [op])[0]


@router.get("/openings/{oid}/posting")
def opening_posting(oid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The posting formatted for a job board, the careers link, and the
    boards (hiring_openings.BOARDS - copy or link, no direct API today)."""
    op = _opening_in_scope(db, user, oid)
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == op.company).first()
    return {"text": ho.posting_text(db, op, ent), "careersUrl": ho.careers_url(db, op.company, op.id),
            "listed": ho.is_listed(op), "boards": [dict(b) for b in ho.BOARDS]}


@router.get("/careers-links")
def careers_links(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Each company's public careers page address, for HR to share."""
    _require_hr_read(db, user)
    from app_url import app_url
    scope = hr_scope(user, db)
    return [{"companyId": e.id, "name": e.name, "url": f"{app_url()}/careers/{slug}"}
            for slug, e in sorted(ho.slug_map(db).items(), key=lambda kv: (kv[1].name or "").lower())
            if scope is None or e.id in scope]
