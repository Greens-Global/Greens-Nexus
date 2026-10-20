"""Onboarding / promotion / offboarding / leave checklists - the API (HR roadmap Section C).

Logic lives in hr_checklists.py; this file is permissions and shapes.

Who can do what:
  - HR (hr grant, inside their company scope) reads every checklist, starts and
    cancels them, and edits any row: status, note, owner, due date.
  - The person a row is assigned to - a manager, IT, payroll, the new hire -
    sees it under My Checklist Tasks and can tick it or add a note, without an
    hr grant. They cannot reassign it or move its date.
  - Templates and role owners are HR settings, edited in Company Settings >
    Checklists (Neil, Oct 19: "once it's set up, we should be just operating
    it"); the Checklist Library (every company) needs an unrestricted HR admin.
    A company can take the library as is, make its own copy, copy another
    company's, or push its own to several companies at once.
  - A job role's extra steps are kept by the head of the role's department
    (Team > Role Checklists) or HR.
"""

import json
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
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
    HrDepartment,
    HrEntity,
    NexusEmployee,
    NexusGroup,
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


def _send_task_emails(background: Optional[BackgroundTasks], task_ids: list, by: str) -> None:
    """The task-assigned email for each owner task a change created (after commit)."""
    if background is None or not task_ids:
        return
    from task_notify import notify_task_event
    for tid in task_ids:
        background.add_task(notify_task_event, tid, "assigned", by)


def _full(db: Session, cl: HrChecklist) -> dict:
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    names = hc.name_map(db, [e for i in items for e in hc.owners_of(i)])
    return hc.ser_checklist(cl, items, names, hc.comments_for(db, items), hc.role_people(db, cl))


def _step_out(db: Session, it: HrChecklistItem) -> dict:
    return hc.ser_item(it, hc.name_map(db, hc.owners_of(it)), hc.comments_for(db, [it])[it.id])


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
def employee_checklists(eid: str, background: BackgroundTasks = None,
                        user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    emp = _employee_in_scope(db, eid, user)
    rows = (db.query(HrChecklist).filter(HrChecklist.employee_id == eid)
            .order_by(HrChecklist.created_at.desc()).all())
    changed, created = False, []
    for cl in rows:
        changed = hc.sync(db, cl, emp) or changed
        db.flush()
        # A step whose owner is known but has no subtask yet (owner filled in
        # after the start) gets it now, not at the overnight pass.
        waiting = cl.status == "open" and db.query(HrChecklistItem.id).filter(
            HrChecklistItem.checklist_id == cl.id, HrChecklistItem.status == "open",
            func.coalesce(HrChecklistItem.owner_email, "") != "",
            func.coalesce(HrChecklistItem.task_id, "") == "").first() is not None
        if waiting:
            new = hc.sync_tasks(db, cl, emp, by=user["email"])
            created += new
            changed = changed or bool(new)
    if changed:
        db.commit()
        _send_task_emails(background, created, user["email"])
    return {"checklists": [_full(db, cl) for cl in rows]}


class StartIn(BaseModel):
    kind: str
    anchor_date: Optional[str] = ""
    exit_type: Optional[str] = ""
    role_id: Optional[str] = None      # whose role steps to add; None = the role they hold


@router.post("/employee/{eid}", status_code=201)
def start_checklist(eid: str, body: StartIn, background: BackgroundTasks = None,
                    user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = _employee_in_scope(db, eid, user)
    try:
        cl = hc.start(db, emp, body.kind, anchor_date=(body.anchor_date or "").strip(),
                      exit_type=(body.exit_type or "").strip(), by=user["email"],
                      role_id=None if body.role_id is None else body.role_id.strip())
    except ValueError as e:
        raise HTTPException(400, str(e))
    hc.sync(db, cl, emp)                 # start() already queued its own tasks' emails
    db.flush()
    created = hc.sync_tasks(db, cl, emp, by=user["email"])
    db.commit()
    _send_task_emails(background, created, user["email"])
    return _full(db, cl)


@router.post("/{cid}/cancel")
def cancel_checklist(cid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    cl = _checklist_in_scope(db, cid, user)
    if cl.status != "open":
        raise HTTPException(400, "Only an open checklist can be canceled")
    cl.status, cl.closed_at = "cancelled", hc._now()
    hc.sync_tasks(db, cl)                 # the owners' tasks close with it
    db.commit()
    return _full(db, cl)


@router.post("/{cid}/reopen")
def reopen_checklist(cid: str, background: BackgroundTasks = None,
                     user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    cl = _checklist_in_scope(db, cid, user)
    if cl.status == "open":
        return _full(db, cl)
    if hc.open_checklist(db, cl.employee_id, cl.kind):
        raise HTTPException(400, "This person already has another open checklist of this kind")
    cl.status, cl.closed_at = "open", ""
    created = hc.sync_tasks(db, cl, by=user["email"])
    db.commit()
    _send_task_emails(background, created, user["email"])
    return _full(db, cl)


class ItemPatch(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    owner_email: Optional[str] = None
    due_date: Optional[str] = None


def _step_for(db: Session, iid: str, user: dict) -> tuple:
    """(step, checklist, is HR) for HR in scope or one of the step's owners."""
    it = db.query(HrChecklistItem).filter(HrChecklistItem.id == iid).first()
    if it is None:
        raise HTTPException(404, "Step not found")
    cl = db.query(HrChecklist).filter(HrChecklist.id == it.checklist_id).first()
    if cl is None:
        raise HTTPException(404, "Step not found")
    hr = False
    if _is_hr_editor(user, db):
        try:
            _employee_in_scope(db, cl.employee_id, user)
            hr = True
        except HTTPException:
            hr = False
    if not hr and user["email"].lower() not in hc.owners_of(it):
        raise HTTPException(404, "Step not found")
    return it, cl, hr


@router.patch("/items/{iid}")
def update_item(iid: str, body: ItemPatch, background: BackgroundTasks = None,
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    it, cl, hr = _step_for(db, iid, user)
    me = user["email"].lower()
    if not hr and (body.owner_email is not None or body.due_date is not None):
        raise HTTPException(403, "Only HR can reassign a step or move its date")
    if cl.status == "cancelled":
        raise HTTPException(400, "This checklist was canceled")

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
        hc.set_owners(it, [_directory_email(db, body.owner_email)])
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
    db.flush()
    created = hc.sync_tasks(db, cl, by=me)     # reassigned, or someone's last step closed
    db.commit()
    _send_task_emails(background, created, me)
    return {"item": _step_out(db, it), "checklistStatus": cl.status}


class CommentIn(BaseModel):
    body: str


@router.post("/items/{iid}/comments", status_code=201)
def add_step_comment(iid: str, body: CommentIn, background: BackgroundTasks = None,
                     user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A comment on a step (Pranshu, Oct 20 - was a single editable note). It
    goes on the step's subtask through the one task-comment path, so the
    owners see it in Tasks (and get the usual comment email); a step with no
    subtask keeps it on the row until it has one."""
    it, cl, _ = _step_for(db, iid, user)
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(400, "Write a comment first")
    me = user["email"].lower()
    import models
    sub = db.query(models.Task).filter(models.Task.id == it.task_id).first() if it.task_id else None
    if sub is not None and not (sub.deleted_at or ""):
        from routers.task_util import create_comment
        create_comment(db, sub, actor_email=me, body=text[:5000], defer=background.add_task if background else None)
    else:
        it.comments = list(it.comments or []) + [{"id": str(uuid.uuid4()), "author": me, "body": text[:5000], "at": hc._now()}]
        db.commit()
    return {"item": _step_out(db, it), "checklistStatus": cl.status}


# --- My steps (any signed-in owner) ----------------------------------------

@router.get("/mine")
def my_steps(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    rows = (db.query(HrChecklistItem, HrChecklist)
            .join(HrChecklist, HrChecklist.id == HrChecklistItem.checklist_id)
            .filter(hc.owned_by(me), HrChecklistItem.status == "open",
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
    stands and the step that is next. People > Checklists."""
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
    names = hc.name_map(db, [i.owner_email for i in items])   # the board shows the first owner
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
            "mine": sum(1 for r in open_rows if me in hc.owners_of(r)),
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
            "items": hc.norm_items(t.items), "updatedBy": t.updated_by, "updatedAt": t.updated_at}


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
    row = _put_template(db, kind, entity_id, items, user["email"])
    if body.name is not None and body.name.strip():
        row.name = body.name.strip()[:120]
    db.commit()
    return _ser_template(row, entity_id)


def _put_template(db: Session, kind: str, entity_id: str, items: list, by: str) -> HrChecklistTemplate:
    """The company's (or library's) own row for `kind`, made if missing. Not committed."""
    row = hc.own_template(db, kind, entity_id)
    if row is None:
        base = hc.get_template(db, kind, "")
        row = HrChecklistTemplate(id=str(uuid.uuid4()), kind=kind, entity_id=entity_id, role_id="",
                                  name=base.name, created_at=hc._now())
        db.add(row)
    row.items = [dict(i) for i in items]
    row.updated_by, row.updated_at = by, hc._now()
    return row


class CopyIn(BaseModel):
    kinds: list                  # which checklists ([] = all four)
    from_entity_id: str = ""     # '' = the Checklist Library
    to_entity_ids: list


@router.post("/templates/copy")
def copy_templates(body: CopyIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Copy a company's steps (or the library's) to one or more companies, so
    they stay the same (Neil, Oct 19: "an option to copy to multiple companies
    and standardize it ... we added 19 steps on company A, but company B only
    18 - no one will ever remember"). Each target gets its own copy; checklists
    already started keep their steps."""
    kinds = [k for k in (body.kinds or hc.KINDS) if k in hc.KINDS]
    if not kinds:
        raise HTTPException(400, "Pick which checklists to copy")
    src = (body.from_entity_id or "").strip()
    scope = hr_scope(user, db)
    if src and (db.query(HrEntity.id).filter(HrEntity.id == src).first() is None
                or (scope is not None and src not in scope)):
        raise HTTPException(404, "Company not found")
    targets = list(dict.fromkeys(t.strip() for t in (body.to_entity_ids or []) if (t or "").strip() and t.strip() != src))
    if not targets:
        raise HTTPException(400, "Pick at least one company to copy to")
    targets = [_entity_for_settings(db, t, user) for t in targets]
    for kind in kinds:
        items = hc.norm_items(hc.get_template(db, kind, src).items)
        for t in targets:
            _put_template(db, kind, t, items, user["email"])
    db.commit()
    return {"copied": len(kinds) * len(targets), "kinds": kinds, "companies": targets}


@router.delete("/templates/{kind}")
def reset_template(kind: str, entity_id: str = "", user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """A company's own template -> back to the default. The default itself goes
    back to the shipped rows. Checklists already started keep their rows."""
    if kind not in hc.KINDS:
        raise HTTPException(404, "Unknown checklist kind")
    entity_id = _entity_for_settings(db, entity_id, user)
    row = hc.own_template(db, kind, entity_id)
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
            own = hc.owners_setting(json.loads(row.value))
        except (ValueError, AttributeError):
            own = {}
    ent = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return {"owners": own, "effective": hc.role_owners(db, entity_id),
            "hrContact": (ent.hr_contact_email if ent else "") or ""}


class OwnersIn(BaseModel):
    owners: dict


@router.put("/owners")
def save_owners(body: OwnersIn, entity_id: str = "", background: BackgroundTasks = None,
                user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    entity_id = _entity_for_settings(db, entity_id, user)
    clean = {}
    for role, emails in (body.owners or {}).items():
        if role not in ("hr", "it", "accounting"):
            raise HTTPException(400, f"{role} is set per person, not per company")
        found = [_directory_email(db, em) for em in hc.email_list(emails)]   # several per role (Oct 20)
        if found:
            clean[role] = list(dict.fromkeys(found))
    key = hc.OWNERS_KEY + entity_id
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    if row is None:
        row = NexusSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = json.dumps(clean), user["email"], hc._now()
    db.flush()
    # Open checklists waiting on an owner get them now, and their tasks, rather
    # than at the overnight pass (Pranshu, Oct 20). '' = the default, every company.
    q = db.query(HrChecklist).filter(HrChecklist.status == "open")
    if entity_id:
        q = q.filter(HrChecklist.company == entity_id)
    created = []
    for cl in q.all():
        if hc.sync(db, cl):
            db.flush()
            created += hc.sync_tasks(db, cl, by=user["email"])
    db.commit()
    _send_task_emails(background, created, user["email"])
    return {"owners": clean, "effective": hc.role_owners(db, entity_id)}


# --- A job role's own steps (Neil, Oct 19) -----------------------------------
# "Not every step after the MS step applies to everyone. If I'm a construction
# associate, I'm not going to be training them on Intacct ... it really has to
# be a role-based thing and then we'll give it to a department head to build
# out." The role's extra steps are added after the company's when a checklist
# starts. Kept by the head (or backup) of the role's department - for the
# role's own company, or any company for a shared role - or by HR.

def _heads(db: Session, email: str) -> list:
    em = (email or "").lower()
    return (db.query(HrDepartment)
            .filter((func.lower(HrDepartment.lead_email) == em) | (func.lower(HrDepartment.backup_email) == em))
            .all()) if em else []


def _role_editable(db: Session, user: dict, role: NexusGroup, heads: list = None) -> bool:
    if _is_hr_editor(user, db):
        scope = hr_scope(user, db)
        if scope is None or (role.company_id or "") in scope:
            return True
    dept = (role.department or "").strip().lower()
    if not dept:
        return False
    for d in (_heads(db, user["email"]) if heads is None else heads):
        if (d.name or "").strip().lower() == dept and (not role.company_id or role.company_id == d.company_id):
            return True
    return False


def _editable_role(db: Session, user: dict, role_id: str) -> NexusGroup:
    role = db.query(NexusGroup).filter(NexusGroup.id == role_id, NexusGroup.is_job_role == 1).first()
    if role is None or not _role_editable(db, user, role):
        raise HTTPException(404, "Role not found")
    return role


@router.get("/role-templates")
def role_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The roles the caller keeps steps for, with how many each checklist has."""
    heads = _heads(db, user["email"])
    hr = _is_hr_editor(user, db)
    if not hr and not heads:
        return {"roles": [], "isHr": False}
    names = {e.id: e.name for e in db.query(HrEntity).all()}
    counts = {}
    for t in db.query(HrChecklistTemplate).filter(HrChecklistTemplate.role_id != "").all():
        counts.setdefault(t.role_id, {})[t.kind] = len(t.items or [])
    out = []
    for r in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).order_by(NexusGroup.name).all():
        if _role_editable(db, user, r, heads):
            out.append({"roleId": r.id, "roleName": r.name, "department": r.department or "",
                        "companyId": r.company_id or "", "companyName": names.get(r.company_id or "", ""),
                        "counts": {k: counts.get(r.id, {}).get(k, 0) for k in hc.KINDS}})
    out.sort(key=lambda x: (x["companyName"] or "~", x["department"].lower(), x["roleName"].lower()))
    return {"roles": out, "isHr": hr}


@router.get("/role-templates/{role_id}")
def role_template(role_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    role = _editable_role(db, user, role_id)
    out = []
    for k in hc.KINDS:
        t = hc.role_template(db, k, role.id)
        out.append({"kind": k, "kindLabel": hc.KIND_LABELS[k], "items": hc.norm_items(t.items) if t else [],
                    "updatedBy": t.updated_by if t else "", "updatedAt": t.updated_at if t else "",
                    "entityId": "", "inherited": False})
    return {"roleId": role.id, "roleName": role.name, "department": role.department or "", "templates": out}


@router.put("/role-templates/{role_id}/{kind}")
def save_role_template(role_id: str, kind: str, body: TemplateIn, user: dict = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """The role's extra steps for one checklist. No steps = none for the role."""
    if kind not in hc.KINDS:
        raise HTTPException(404, "Unknown checklist kind")
    role = _editable_role(db, user, role_id)
    try:
        items = hc.clean_template_items(body.items)
    except ValueError as e:
        raise HTTPException(400, str(e))
    t = hc.role_template(db, kind, role.id)
    if not items:
        if t is not None:
            db.delete(t)
        db.commit()
        return {"kind": kind, "kindLabel": hc.KIND_LABELS[kind], "items": [], "updatedBy": "", "updatedAt": "",
                "entityId": "", "inherited": False}
    if t is None:
        t = HrChecklistTemplate(id=str(uuid.uuid4()), kind=kind, entity_id="", role_id=role.id,
                                name=f"{role.name} - {hc.KIND_LABELS[kind]}", created_at=hc._now())
        db.add(t)
    t.items, t.updated_by, t.updated_at = items, user["email"], hc._now()
    db.commit()
    return {"kind": kind, "kindLabel": hc.KIND_LABELS[kind], "items": items, "updatedBy": t.updated_by,
            "updatedAt": t.updated_at, "entityId": "", "inherited": False}
