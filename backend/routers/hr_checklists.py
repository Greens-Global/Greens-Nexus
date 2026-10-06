"""Onboarding / offboarding / leave checklists - the API (HR roadmap Section C).

Logic lives in hr_checklists.py; this file is permissions and shapes.

Who can do what:
  - HR (hr grant, inside their company scope) reads every checklist, starts and
    cancels them, and edits any row: status, note, owner, due date.
  - The person a row is assigned to - a manager, IT, payroll, the new hire -
    sees it under My Checklist Tasks and can tick it or add a note, without an
    hr grant. They cannot reassign it or move its date.
  - Templates and role owners are HR settings; the default template (every
    company) needs an unrestricted HR admin.
"""

import json
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import hr_checklist_seed
import hr_checklists as hc
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user, hr_scope, require_module_grant
from database import get_db
from models import (
    HrChecklist,
    HrChecklistItem,
    HrChecklistTemplate,
    HrEntity,
    NexusEmployee,
    NexusSetting,
)

require_hr_read = require_module_grant("hr", "viewer")
require_hr_write = require_module_grant("hr", "editor")

router = APIRouter(prefix="/hr/checklists", tags=["hr-checklists"])


def _is_hr_editor(user: dict, db: Session) -> bool:
    # The manager tier works only its own steps here, People grant or not (Oct 6).
    from auth import hr_team_limited
    return (user.get("level", 0) >= _LEVELS["administrator"]
            or (not hr_team_limited(user)
                and _module_level(user["email"], "hr", db) >= _MODULE_LEVEL_RANK["editor"]))


def _employee_in_scope(db: Session, eid: str, user: dict) -> NexusEmployee:
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    scope = hr_scope(user, db)
    if emp is None or (scope is not None and (emp.company or "") not in scope):
        raise HTTPException(404, "Employee not found")
    return emp


def _checklist_in_scope(db: Session, cid: str, user: dict) -> HrChecklist:
    cl = db.query(HrChecklist).filter(HrChecklist.id == cid).first()
    if cl is None:
        raise HTTPException(404, "Checklist not found")
    _employee_in_scope(db, cl.employee_id, user)
    return cl


def _directory_email(db: Session, email: str) -> str:
    """Owners must be people in the Nexus People list, never a free-typed or
    M365-only address (CLAUDE.md: curated people pickers)."""
    em = (email or "").strip().lower()
    if not em:
        return ""
    hit = (db.query(NexusEmployee.id)
           .filter(func.lower(NexusEmployee.work_email) == em,
                   NexusEmployee.status.in_(["active", "onboarding", "inactive"]))
           .first())
    if hit is None:
        raise HTTPException(400, f"{em} is not in the Nexus People list")
    return em


def _full(db: Session, cl: HrChecklist) -> dict:
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    names = hc.name_map(db, [i.owner_email for i in items])
    return hc.ser_checklist(cl, items, names)


# --- Meta ------------------------------------------------------------------

@router.get("/meta")
def meta(user: dict = Depends(get_current_user)):
    return {
        "kinds": [{"value": k, "label": hc.KIND_LABELS[k]} for k in hc.KINDS],
        "roles": [{"value": r, "label": hc.ROLE_LABELS[r]} for r in hc.ROLES],
        "exitTypes": [{"value": t, "label": t.replace("_", " ").title().replace("No Notice", "Without Notice")}
                      for t in hr_checklist_seed.EXIT_TYPES],
        "signals": [{"value": k, "label": v} for k, v in hc.SIGNAL_LABELS.items()],
    }


# --- One person's checklists -----------------------------------------------

@router.get("/employee/{eid}")
def employee_checklists(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    emp = _employee_in_scope(db, eid, user)
    rows = (db.query(HrChecklist).filter(HrChecklist.employee_id == eid)
            .order_by(HrChecklist.created_at.desc()).all())
    changed = False
    for cl in rows:
        changed = hc.sync(db, cl, emp) or changed
    if changed:
        db.commit()
    return {"checklists": [_full(db, cl) for cl in rows]}


class StartIn(BaseModel):
    kind: str
    anchor_date: Optional[str] = ""
    exit_type: Optional[str] = ""


@router.post("/employee/{eid}", status_code=201)
def start_checklist(eid: str, body: StartIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = _employee_in_scope(db, eid, user)
    try:
        cl = hc.start(db, emp, body.kind, anchor_date=(body.anchor_date or "").strip(),
                      exit_type=(body.exit_type or "").strip(), by=user["email"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.flush()
    hc.sync(db, cl, emp)
    db.commit()
    return _full(db, cl)


@router.post("/{cid}/cancel")
def cancel_checklist(cid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    cl = _checklist_in_scope(db, cid, user)
    if cl.status != "open":
        raise HTTPException(400, "Only an open checklist can be cancelled")
    cl.status, cl.closed_at = "cancelled", hc._now()
    db.commit()
    return _full(db, cl)


@router.post("/{cid}/reopen")
def reopen_checklist(cid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    cl = _checklist_in_scope(db, cid, user)
    if cl.status == "open":
        return _full(db, cl)
    if hc.open_checklist(db, cl.employee_id, cl.kind):
        raise HTTPException(400, "This person already has another open checklist of this kind")
    cl.status, cl.closed_at = "open", ""
    db.commit()
    return _full(db, cl)


class ItemPatch(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    owner_email: Optional[str] = None
    due_date: Optional[str] = None


@router.patch("/items/{iid}")
def update_item(iid: str, body: ItemPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    it = db.query(HrChecklistItem).filter(HrChecklistItem.id == iid).first()
    if it is None:
        raise HTTPException(404, "Step not found")
    cl = db.query(HrChecklist).filter(HrChecklist.id == it.checklist_id).first()
    if cl is None:
        raise HTTPException(404, "Step not found")
    me = user["email"].lower()
    hr = False
    if _is_hr_editor(user, db):
        try:
            _employee_in_scope(db, cl.employee_id, user)
            hr = True
        except HTTPException:
            hr = False
    if not hr and it.owner_email != me:
        raise HTTPException(404, "Step not found")
    if not hr and (body.owner_email is not None or body.due_date is not None):
        raise HTTPException(403, "Only HR can reassign a step or move its date")
    if cl.status == "cancelled":
        raise HTTPException(400, "This checklist was cancelled")

    if body.status is not None:
        if body.status not in ("open", "done", "na"):
            raise HTTPException(400, "status must be open, done or na")
        if body.status == "na" and not (body.note or it.note or "").strip():
            raise HTTPException(400, "Say why this step does not apply")
        it.status = body.status
        if body.status == "open":
            it.done_by, it.done_at = "", ""
        else:
            it.done_by, it.done_at = me, hc._now()
    if body.note is not None:
        it.note = body.note.strip()[:1000]
    if body.owner_email is not None:
        it.owner_email = _directory_email(db, body.owner_email)
        it.owner_manual = True
    if body.due_date is not None:
        d = body.due_date.strip()
        if d and not hc._parse(d):
            raise HTTPException(400, "Dates must be YYYY-MM-DD")
        it.due_date = d[:10]
        it.due_manual = True

    # Close (or re-open) the checklist with its last row. autoflush is off:
    # read the siblings, then count this row's NEW status by hand.
    others = (db.query(HrChecklistItem)
              .filter(HrChecklistItem.checklist_id == cl.id, HrChecklistItem.id != it.id).all())
    all_closed = it.status in ("done", "na") and all(o.status in ("done", "na") for o in others)
    if all_closed and cl.status == "open":
        cl.status, cl.closed_at = "done", hc._now()
    elif not all_closed and cl.status == "done":
        cl.status, cl.closed_at = "open", ""
    db.commit()
    names = hc.name_map(db, [it.owner_email])
    return {"item": hc.ser_item(it, names), "checklistStatus": cl.status}


# --- My steps (any signed-in owner) ----------------------------------------

@router.get("/mine")
def my_steps(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    rows = (db.query(HrChecklistItem, HrChecklist)
            .join(HrChecklist, HrChecklist.id == HrChecklistItem.checklist_id)
            .filter(HrChecklistItem.owner_email == me, HrChecklistItem.status == "open",
                    HrChecklist.status == "open")
            .all())
    emp_ids = {cl.employee_id for _, cl in rows}
    people = {e.id: e for e in db.query(NexusEmployee).filter(NexusEmployee.id.in_(list(emp_ids))).all()} if emp_ids else {}
    out = []
    for it, cl in rows:
        e = people.get(cl.employee_id)
        if e is None:
            continue
        d = hc.ser_item(it)
        d.update({"kind": cl.kind, "kindLabel": hc.KIND_LABELS.get(cl.kind, cl.kind),
                  "employeeId": e.id, "employeeName": hc.full_name(e),
                  "employeeTitle": e.job_title or "", "anchorDate": cl.anchor_date})
        out.append(d)
    out.sort(key=lambda x: (x["dueDate"] or "9999-12-31", x["employeeName"], x["sortOrder"]))
    return {"steps": out}


# --- Progress for the directory --------------------------------------------

@router.get("/progress")
def progress(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    q = db.query(HrChecklist).filter(HrChecklist.status == "open")
    if scope is not None:
        q = q.filter(HrChecklist.company.in_(scope))
    lists = q.all()
    if not lists:
        return {"progress": {}}
    today = hc._today().isoformat()
    items = (db.query(HrChecklistItem)
             .filter(HrChecklistItem.checklist_id.in_([c.id for c in lists])).all())
    by_cl = {}
    for i in items:
        by_cl.setdefault(i.checklist_id, []).append(i)
    out = {}
    for cl in lists:
        rows = by_cl.get(cl.id, [])
        out.setdefault(cl.employee_id, []).append({
            "checklistId": cl.id, "kind": cl.kind, "kindLabel": hc.KIND_LABELS.get(cl.kind, cl.kind),
            "total": len(rows), "done": sum(1 for r in rows if r.status in ("done", "na")),
            "overdue": sum(1 for r in rows if r.status == "open" and r.due_date and r.due_date < today),
        })
    return {"progress": out}


@router.get("/board")
def board(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Every open checklist HR can see, one row each: who, what, where it
    stands and the step that is next. People > Checklists > Overview."""
    scope = hr_scope(user, db)
    q = db.query(HrChecklist).filter(HrChecklist.status == "open")
    if scope is not None:
        q = q.filter(HrChecklist.company.in_(scope))
    lists = q.all()
    if not lists:
        return {"rows": []}
    emps = {e.id: e for e in db.query(NexusEmployee)
            .filter(NexusEmployee.id.in_([c.employee_id for c in lists])).all()}
    items = (db.query(HrChecklistItem)
             .filter(HrChecklistItem.checklist_id.in_([c.id for c in lists])).all())
    by_cl = {}
    for i in items:
        by_cl.setdefault(i.checklist_id, []).append(i)
    names = hc.name_map(db, [i.owner_email for i in items])
    today = hc._today()
    t_iso, week_iso = today.isoformat(), (today + timedelta(days=7)).isoformat()
    me = user["email"].lower()
    entity_names = {e.id: e.name for e in db.query(HrEntity).all()}
    out = []
    for cl in lists:
        emp = emps.get(cl.employee_id)
        if emp is None:
            continue   # removed from Nexus - nothing to act on
        rows = by_cl.get(cl.id, [])
        open_rows = sorted([r for r in rows if r.status == "open"],
                           key=lambda r: (r.due_date or "9999-12-31", r.sort_order or 0))
        nxt = open_rows[0] if open_rows else None
        out.append({
            "checklistId": cl.id, "kind": cl.kind, "kindLabel": hc.KIND_LABELS.get(cl.kind, cl.kind),
            "employeeId": emp.id, "name": hc.full_name(emp), "jobTitle": emp.job_title or "",
            "employeeStatus": emp.status, "company": cl.company, "companyName": entity_names.get(cl.company, ""),
            "anchorDate": cl.anchor_date, "exitType": cl.exit_type, "createdAt": cl.created_at,
            "total": len(rows), "done": sum(1 for r in rows if r.status in ("done", "na")),
            "overdue": sum(1 for r in open_rows if r.due_date and r.due_date < t_iso),
            "dueThisWeek": sum(1 for r in open_rows if r.due_date and t_iso <= r.due_date <= week_iso),
            "unassigned": sum(1 for r in open_rows if not r.owner_email),
            "mine": sum(1 for r in open_rows if r.owner_email == me),
            "next": None if nxt is None else {
                "title": nxt.title, "dueDate": nxt.due_date,
                "overdue": bool(nxt.due_date and nxt.due_date < t_iso),
                "ownerEmail": nxt.owner_email, "ownerName": names.get(nxt.owner_email, ""),
                "ownerRoleLabel": hc.ROLE_LABELS.get(nxt.owner_role, nxt.owner_role),
            },
        })
    # Most urgent first: anything late, then the nearest date.
    out.sort(key=lambda r: (-r["overdue"], r["anchorDate"] or "9999-12-31", r["name"]))
    return {"rows": out}


# --- Templates -------------------------------------------------------------

def _entity_for_settings(db: Session, entity_id: str, user: dict) -> str:
    """'' = the default for every company (unrestricted HR only); otherwise a
    company inside the caller's scope."""
    entity_id = (entity_id or "").strip()
    scope = hr_scope(user, db)
    if not entity_id:
        if scope is not None:
            raise HTTPException(403, "Only an HR admin for every company can change the default")
        return ""
    if db.query(HrEntity.id).filter(HrEntity.id == entity_id).first() is None:
        raise HTTPException(404, "Company not found")
    if scope is not None and entity_id not in scope:
        raise HTTPException(404, "Company not found")
    return entity_id


def _ser_template(t: HrChecklistTemplate, entity_id: str) -> dict:
    return {"id": t.id, "kind": t.kind, "kindLabel": hc.KIND_LABELS.get(t.kind, t.kind),
            "name": t.name, "entityId": t.entity_id, "inherited": bool(entity_id and t.entity_id != entity_id),
            "items": t.items or [], "updatedBy": t.updated_by, "updatedAt": t.updated_at}


@router.get("/templates")
def list_templates(entity_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    if entity_id and scope is not None and entity_id not in scope:
        raise HTTPException(404, "Company not found")
    out = [_ser_template(hc.get_template(db, k, entity_id), entity_id) for k in hc.KINDS]
    db.commit()   # seeding the defaults on first read
    return {"templates": out}


class TemplateIn(BaseModel):
    name: Optional[str] = None
    items: list


@router.put("/templates/{kind}")
def save_template(kind: str, body: TemplateIn, entity_id: str = "",
                  user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if kind not in hc.KINDS:
        raise HTTPException(404, "Unknown checklist kind")
    entity_id = _entity_for_settings(db, entity_id, user)
    try:
        items = hc.clean_template_items(body.items)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not items:
        raise HTTPException(400, "A template needs at least one step")
    row = (db.query(HrChecklistTemplate)
           .filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.entity_id == entity_id).first())
    if row is None:
        base = hc.get_template(db, kind, "")
        row = HrChecklistTemplate(id=str(uuid.uuid4()), kind=kind, entity_id=entity_id,
                                  name=base.name, created_at=hc._now())
        db.add(row)
    row.items = items
    if body.name is not None and body.name.strip():
        row.name = body.name.strip()[:120]
    row.updated_by, row.updated_at = user["email"], hc._now()
    db.commit()
    return _ser_template(row, entity_id)


@router.delete("/templates/{kind}")
def reset_template(kind: str, entity_id: str = "", user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """A company's own template -> back to the default. The default itself goes
    back to the shipped rows. Checklists already started keep their rows."""
    if kind not in hc.KINDS:
        raise HTTPException(404, "Unknown checklist kind")
    entity_id = _entity_for_settings(db, entity_id, user)
    row = (db.query(HrChecklistTemplate)
           .filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.entity_id == entity_id).first())
    if row is not None:
        if entity_id:
            db.delete(row)
        else:
            row.items = [dict(i) for i in hr_checklist_seed.DEFAULTS[kind][1]]
            row.updated_by, row.updated_at = user["email"], hc._now()
    db.commit()
    return _ser_template(hc.get_template(db, kind, entity_id), entity_id)


# --- Role owners -----------------------------------------------------------

@router.get("/owners")
def get_owners(entity_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    if entity_id and scope is not None and entity_id not in scope:
        raise HTTPException(404, "Company not found")
    own = {}
    row = db.query(NexusSetting).filter(NexusSetting.key == hc.OWNERS_KEY + (entity_id or "")).first()
    if row and row.value:
        try:
            own = json.loads(row.value)
        except ValueError:
            own = {}
    ent = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return {"owners": own, "effective": hc.role_owners(db, entity_id),
            "hrContact": (ent.hr_contact_email if ent else "") or ""}


class OwnersIn(BaseModel):
    owners: dict


@router.put("/owners")
def save_owners(body: OwnersIn, entity_id: str = "", user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    entity_id = _entity_for_settings(db, entity_id, user)
    clean = {}
    for role, email in (body.owners or {}).items():
        if role not in ("hr", "it", "payroll", "equipment", "finance"):
            raise HTTPException(400, f"{role} is set per person, not per company")
        em = _directory_email(db, str(email or ""))
        if em:
            clean[role] = em
    key = hc.OWNERS_KEY + entity_id
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    if row is None:
        row = NexusSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = json.dumps(clean), user["email"], hc._now()
    db.commit()
    return {"owners": clean, "effective": hc.role_owners(db, entity_id)}
