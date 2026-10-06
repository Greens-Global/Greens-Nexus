"""Per-person onboarding / offboarding / leave checklists (HR roadmap Section C:
"Onboarding checklist per hire: docs -> sign -> provision -> assign equipment
-> day-1 tasks, each with owner + due date").

The pieces:
  - templates   per kind and company, seeded from hr_checklist_seed.py
  - start()     builds one person's checklist from a template: filters the rows
                that apply to them, resolves each owner ROLE to a person and each
                offset to a date
  - sync()      keeps an open checklist current: moves open dates when the start
                date changes, fills owners that were not known yet (the work email
                after provisioning, a manager added later), and ticks rows whose
                completion Nexus can see by itself (SIGNALS)
  - run_daily() the reminder pass, called from reminders_loop: one bell
                notification per checklist per owner, updated in place - never
                one per row

Routers live in routers/hr_checklists.py. Nothing here talks to Microsoft
Graph; every query is local, so the daily pass runs inside asyncio.to_thread.
"""

import json
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, or_

import hr_checklist_seed
from models import (
    HrCandidate,
    HrChecklist,
    HrChecklistItem,
    HrChecklistTemplate,
    HrCompanyHoliday,
    HrEntity,
    HrProvisionRun,
    HrSignRequest,
    HrSignTemplate,
    ItemAssignment,
    NexusEmployee,
    NexusNotification,
    NexusSetting,
)

KINDS = ("onboarding", "offboarding", "inactive")
ROLES = ("hr", "manager", "employee", "it", "payroll", "equipment", "finance")
ROLE_LABELS = {
    "hr": "HR", "manager": "Manager", "employee": "Employee", "it": "IT",
    "payroll": "Payroll", "equipment": "Equipment", "finance": "Finance",
}
KIND_LABELS = {"onboarding": "Onboarding", "offboarding": "Offboarding", "inactive": "Leave Or Suspension"}
OWNERS_KEY = "hr_checklist_owners:"   # + entity id ('' = default) -> {"it": email, ...}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _parse(d: str):
    try:
        return datetime.strptime((d or "").strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def us_date(d: str) -> str:
    """YYYY-MM-DD -> MM/DD/YYYY for notification text (house format)."""
    p = _parse(d)
    return p.strftime("%m/%d/%Y") if p else ""


def full_name(emp: NexusEmployee) -> str:
    return (emp.display_name or f"{emp.first_name} {emp.last_name}").strip() if emp else ""


# --- Templates -------------------------------------------------------------

def get_template(db, kind: str, entity_id: str = "") -> HrChecklistTemplate:
    """The company's own template for `kind`, else the default one, seeding the
    default the first time it is asked for."""
    if entity_id:
        own = (db.query(HrChecklistTemplate)
               .filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.entity_id == entity_id)
               .first())
        if own:
            return own
    row = (db.query(HrChecklistTemplate)
           .filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.entity_id == "")
           .first())
    if row:
        return row
    name, items = hr_checklist_seed.DEFAULTS[kind]
    row = HrChecklistTemplate(id=str(uuid.uuid4()), kind=kind, entity_id="", name=name,
                              items=[dict(i) for i in items], updated_by="system",
                              created_at=_now(), updated_at=_now())
    db.add(row)
    db.flush()
    return row


def clean_template_items(items: list) -> list:
    """Validate rows coming from the template editor. Raises ValueError."""
    out, seen = [], set()
    for i, raw in enumerate(items or []):
        if not isinstance(raw, dict):
            raise ValueError(f"Row {i + 1} is not an object")
        title = str(raw.get("title") or "").strip()
        if not title:
            raise ValueError(f"Row {i + 1} needs a title")
        key = str(raw.get("key") or "").strip() or f"ROW-{uuid.uuid4().hex[:6].upper()}"
        if key in seen:
            raise ValueError(f"Two rows share the key {key}")
        seen.add(key)
        owner = str(raw.get("owner") or "hr").strip()
        if owner not in ROLES:
            raise ValueError(f"{title}: owner must be one of {', '.join(ROLES)}")
        anchor = str(raw.get("anchor") or "S").strip()
        if anchor not in ("S", "X", "created", "none"):
            raise ValueError(f"{title}: anchor must be S, X, created or none")
        try:
            offset = int(raw.get("offset") or 0)
        except (TypeError, ValueError):
            raise ValueError(f"{title}: offset must be a whole number of days")
        if abs(offset) > 730:
            raise ValueError(f"{title}: offset is more than two years")
        applies = raw.get("applies") or {}
        if not isinstance(applies, dict):
            raise ValueError(f"{title}: applies must be an object")
        applies = {k: [str(v) for v in (applies.get(k) or [])]
                   for k in ("types", "countries", "exit_types") if applies.get(k)}
        signal = str(raw.get("signal") or "").strip()
        if signal and signal_name(signal) not in SIGNALS:
            raise ValueError(f"{title}: unknown completion signal {signal}")
        out.append({"key": key, "phase": str(raw.get("phase") or "").strip()[:80],
                    "title": title[:200], "hint": str(raw.get("hint") or "").strip()[:500],
                    "owner": owner, "anchor": anchor, "offset": offset,
                    "bd": bool(raw.get("bd")), "applies": applies, "signal": signal})
    return out


def _applies(row: dict, emp: NexusEmployee, country: str, exit_type: str) -> bool:
    a = row.get("applies") or {}
    types = a.get("types") or []
    if types:
        et = emp.employment_type or "full_time"
        ok = et in types or ("employee" in types and et != "contractor")
        if not ok:
            return False
    countries = a.get("countries") or []
    if countries and (country or "").upper() not in [c.upper() for c in countries]:
        return False
    exits = a.get("exit_types") or []
    if exits and exit_type and exit_type not in exits:
        return False
    return True


def person_country(db, emp: NexusEmployee) -> str:
    """The country the checklist's legal rows follow: the employing company's
    country, else the person's own."""
    if emp.company:
        ent = db.query(HrEntity).filter(HrEntity.id == emp.company).first()
        if ent and ent.country:
            return ent.country.upper()
    return (emp.country or "").upper()


# --- Dates -----------------------------------------------------------------

def _holidays(db, company: str) -> set:
    if not company:
        return set()
    rows = (db.query(HrCompanyHoliday.date)
            .filter(HrCompanyHoliday.company_id == company,
                    HrCompanyHoliday.type != "optional").all())
    return {r.date for r in rows}


def _workday(d: date, hol: set) -> bool:
    return d.weekday() < 5 and d.isoformat() not in hol


def due_for(anchor_date: str, created: str, anchor: str, offset: int, bd: bool, hol: set) -> str:
    """The due date of one row. Business-day rows count forward (or back)
    skipping weekends and the company's holidays; calendar rows that land on a
    non-working day move to the previous working day. A row whose date is
    already past when the checklist starts is due the day it started - it is
    never skipped."""
    base = _parse(created) if anchor == "created" else _parse(anchor_date) if anchor in ("S", "X") else None
    if base is None:
        return ""
    if bd and offset:
        step = 1 if offset > 0 else -1
        d, left = base, abs(offset)
        while left:
            d += timedelta(days=step)
            if _workday(d, hol):
                left -= 1
    else:
        d = base + timedelta(days=offset)
        guard = 0
        while not _workday(d, hol) and guard < 14:
            d -= timedelta(days=1)
            guard += 1
    start = _parse(created)
    if start and d < start:
        d = start
    return d.isoformat()


# --- Owners ----------------------------------------------------------------

def role_owners(db, entity_id: str) -> dict:
    """{role: email} set in Checklist Owners for this company, falling back to
    the default ('' entity) for roles the company left blank."""
    out = {}
    for key in (OWNERS_KEY, OWNERS_KEY + (entity_id or "")):
        row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
        if row and row.value:
            try:
                out.update({k: v for k, v in json.loads(row.value).items() if v})
            except (ValueError, AttributeError):
                pass
        if not entity_id:
            break
    return out


def resolve_owner(db, role: str, emp: NexusEmployee, owners: dict, entity: HrEntity) -> str:
    if role == "employee":
        return (emp.work_email or "").lower()
    if role == "manager":
        return (emp.manager_email or "").lower()
    if role == "hr" and entity is not None and entity.hr_contact_email:
        return entity.hr_contact_email.lower()
    return (owners.get(role) or "").lower()


# --- Building a checklist --------------------------------------------------

def open_checklist(db, employee_id: str, kind: str):
    return (db.query(HrChecklist)
            .filter(HrChecklist.employee_id == employee_id, HrChecklist.kind == kind,
                    HrChecklist.status == "open")
            .first())


def start(db, emp: NexusEmployee, kind: str, *, anchor_date: str = "", exit_type: str = "",
          by: str = "") -> HrChecklist:
    """Create `emp`'s checklist of `kind`. Caller commits. Raises ValueError if
    one of that kind is already open (one at a time per person)."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if open_checklist(db, emp.id, kind):
        raise ValueError(f"{full_name(emp)} already has an open {KIND_LABELS[kind].lower()} checklist")
    if kind == "offboarding":
        if exit_type not in hr_checklist_seed.EXIT_TYPES:
            raise ValueError("Pick the exit type")
    else:
        exit_type = ""
    if kind == "onboarding" and not anchor_date:
        anchor_date = (emp.start_date or "")[:10]
    if anchor_date and not _parse(anchor_date):
        raise ValueError("Dates must be YYYY-MM-DD")
    if kind != "onboarding" and not anchor_date:
        raise ValueError("Pick the date the checklist counts from")

    tpl = get_template(db, kind, emp.company or "")
    created = _today().isoformat()
    cl = HrChecklist(id=str(uuid.uuid4()), employee_id=emp.id, kind=kind, template_id=tpl.id,
                     company=emp.company or "", anchor_date=anchor_date[:10], exit_type=exit_type,
                     status="open", created_by=by, created_at=_now())
    db.add(cl)
    hol = _holidays(db, emp.company or "")
    owners = role_owners(db, emp.company or "")
    entity = db.query(HrEntity).filter(HrEntity.id == emp.company).first() if emp.company else None
    country = person_country(db, emp)
    n = 0
    for row in tpl.items or []:
        if not _applies(row, emp, country, exit_type):
            continue
        n += 1
        db.add(HrChecklistItem(
            id=str(uuid.uuid4()), checklist_id=cl.id, key=row.get("key", ""),
            phase=row.get("phase", ""), title=row.get("title", ""), hint=row.get("hint", ""),
            owner_role=row.get("owner", "hr"),
            owner_email=resolve_owner(db, row.get("owner", "hr"), emp, owners, entity),
            anchor=row.get("anchor", "S"), offset=int(row.get("offset") or 0),
            business_days=bool(row.get("bd")),
            due_date=due_for(cl.anchor_date, created, row.get("anchor", "S"),
                             int(row.get("offset") or 0), bool(row.get("bd")), hol),
            signal=row.get("signal", ""), status="open", sort_order=n,
        ))
    return cl


def start_on_hire(db, emp: NexusEmployee, by: str) -> None:
    """Hook for the hiring pipeline (Hired -> employee in Onboarding). Never
    lets a checklist problem block the hire itself."""
    try:
        if not open_checklist(db, emp.id, "onboarding"):
            start(db, emp, "onboarding", by=by)
    except Exception as e:   # noqa: BLE001 - best effort by design
        print(f"[checklists] onboarding checklist not started for {emp.id}: {e}")


# --- Completion signals ----------------------------------------------------

def signal_name(signal: str) -> str:
    return (signal or "").split(":", 1)[0]


def _sig_profile_complete(db, emp, arg):
    return all([emp.start_date, emp.company, emp.employment_type, emp.manager_email, emp.personal_email])


def _sig_personal_details(db, emp, arg):
    em = (emp.personal or {}).get("emergency") or {}
    return bool(em.get("name") and em.get("phone"))


def _sig_contract_end(db, emp, arg):
    return bool((emp.contractor or {}).get("contract_end"))


def _sig_provisioned(db, emp, arg):
    return (db.query(HrProvisionRun)
            .filter(HrProvisionRun.employee_id == emp.id, HrProvisionRun.status == "done")
            .first()) is not None


def _sig_envelope(db, emp, arg):
    kinds = [k.strip() for k in (arg or "").split(",") if k.strip()]
    # An offer is usually sent at the candidate stage, before the employee
    # record exists - so match the candidate this person was hired from too.
    cand_ids = [c.id for c in db.query(HrCandidate.id).filter(HrCandidate.employee_id == emp.id).all()]
    who = HrSignRequest.employee_id == emp.id
    if cand_ids:
        who = or_(who, HrSignRequest.candidate_id.in_(cand_ids))
    return (db.query(HrSignRequest.id)
            .join(HrSignTemplate, HrSignTemplate.id == HrSignRequest.template_id)
            .filter(HrSignRequest.status == "completed", HrSignTemplate.kind.in_(kinds), who)
            .first()) is not None


def _assignments(db, emp, statuses):
    if not emp.work_email:
        return None
    return (db.query(ItemAssignment.id)
            .filter(func.lower(ItemAssignment.assignee_email) == emp.work_email.lower(),
                    ItemAssignment.status.in_(statuses)))


def _sig_item_assigned(db, emp, arg):
    q = _assignments(db, emp, ["pending_acceptance", "active"])
    return q is not None and q.first() is not None


def _sig_item_active(db, emp, arg):
    q = _assignments(db, emp, ["active"])
    return q is not None and q.first() is not None


def _sig_no_items(db, emp, arg):
    q = _assignments(db, emp, ["pending_acceptance", "active", "return_initiated"])
    return q is not None and q.first() is None


def _sig_roles_clear(db, emp, arg):
    em = (emp.work_email or "").lower()
    if not em:
        return False
    reports = (db.query(NexusEmployee.id)
               .filter(func.lower(NexusEmployee.manager_email) == em,
                       NexusEmployee.status.in_(["active", "onboarding", "inactive"]),
                       NexusEmployee.id != emp.id).first())
    hr_contact = (db.query(HrEntity.id)
                  .filter(func.lower(HrEntity.hr_contact_email) == em).first())
    return reports is None and hr_contact is None


def _status_is(value):
    return lambda db, emp, arg: emp.status == value


SIGNALS = {
    "profile_complete": _sig_profile_complete,
    "personal_details": _sig_personal_details,
    "contract_end": _sig_contract_end,
    "provisioned": _sig_provisioned,
    "envelope": _sig_envelope,
    "item_assigned": _sig_item_assigned,
    "item_active": _sig_item_active,
    "no_items": _sig_no_items,
    "roles_clear": _sig_roles_clear,
    "status_active": _status_is("active"),
    "status_left": _status_is("offboarded"),
    "status_inactive": _status_is("inactive"),
}

SIGNAL_LABELS = {
    "profile_complete": "Start date, company, worker type, manager and personal email filled",
    "personal_details": "Emergency contact on the profile",
    "contract_end": "Contract end date on the profile",
    "provisioned": "A provisioning run finished",
    "envelope": "A Nexus Sign envelope of that kind completed",
    "item_assigned": "An Item Management assignment exists for the work email",
    "item_active": "The person accepted their equipment",
    "no_items": "No equipment is still assigned to them",
    "roles_clear": "Nobody reports to them and no company names them HR contact",
    "status_active": "Status is Active",
    "status_left": "Status is Left",
    "status_inactive": "Status is Inactive",
}


def sync(db, cl: HrChecklist, emp: NexusEmployee = None) -> bool:
    """Bring an open checklist up to date. Returns True if anything changed.
    Caller commits. autoflush is off, so the item list is read once and every
    change is made on those objects."""
    if cl.status != "open":
        return False
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    if emp is None:
        return False
    changed = False
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()

    # 1. The start date moved (onboarding only): move every open, un-pinned date.
    if cl.kind == "onboarding":
        sd = (emp.start_date or "")[:10]
        if sd and sd != cl.anchor_date and _parse(sd):
            cl.anchor_date = sd
            hol = _holidays(db, cl.company)
            created = (cl.created_at or "")[:10]
            for it in items:
                if it.status == "open" and not it.due_manual and it.anchor == "S":
                    it.due_date = due_for(sd, created, "S", it.offset, it.business_days, hol)
            changed = True

    # 2. Owners that were not known when the checklist started.
    blanks = [it for it in items if it.status == "open" and not it.owner_email and not it.owner_manual]
    if blanks:
        owners = role_owners(db, cl.company)
        entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
        for it in blanks:
            em = resolve_owner(db, it.owner_role, emp, owners, entity)
            if em:
                it.owner_email = em
                changed = True

    # 3. Rows Nexus can tick by itself. A signal only ever ticks; it never
    #    re-opens a row a person closed.
    for it in items:
        if it.status != "open" or not it.signal:
            continue
        fn = SIGNALS.get(signal_name(it.signal))
        if fn is None:
            continue
        try:
            hit = fn(db, emp, it.signal.split(":", 1)[1] if ":" in it.signal else "")
        except Exception as e:   # noqa: BLE001 - one bad signal never stops the rest
            print(f"[checklists] signal {it.signal} failed on {it.id}: {e}")
            hit = False
        if hit:
            it.status, it.done_by, it.done_at = "done", "Nexus", _now()
            changed = True

    if items and all(it.status in ("done", "na") for it in items):
        cl.status, cl.closed_at = "done", _now()
        changed = True
    return changed


# --- Serializers -----------------------------------------------------------

def ser_item(it: HrChecklistItem, names: dict = None) -> dict:
    today = _today().isoformat()
    return {
        "id": it.id, "checklistId": it.checklist_id, "key": it.key, "phase": it.phase,
        "title": it.title, "hint": it.hint,
        "ownerRole": it.owner_role, "ownerRoleLabel": ROLE_LABELS.get(it.owner_role, it.owner_role),
        "ownerEmail": it.owner_email, "ownerName": (names or {}).get(it.owner_email, ""),
        "ownerManual": bool(it.owner_manual),
        "anchor": it.anchor, "offset": it.offset, "businessDays": bool(it.business_days),
        "dueDate": it.due_date, "dueManual": bool(it.due_manual),
        "overdue": bool(it.status == "open" and it.due_date and it.due_date < today),
        "signal": it.signal,
        "signalLabel": SIGNAL_LABELS.get(signal_name(it.signal), "") if it.signal else "",
        "status": it.status, "doneBy": it.done_by, "doneAt": it.done_at, "note": it.note,
        "sortOrder": it.sort_order,
    }


def ser_checklist(cl: HrChecklist, items: list, names: dict = None) -> dict:
    done = sum(1 for i in items if i.status in ("done", "na"))
    today = _today().isoformat()
    return {
        "id": cl.id, "employeeId": cl.employee_id, "kind": cl.kind,
        "kindLabel": KIND_LABELS.get(cl.kind, cl.kind), "company": cl.company,
        "anchorDate": cl.anchor_date, "exitType": cl.exit_type, "status": cl.status,
        "createdBy": cl.created_by, "createdAt": cl.created_at, "closedAt": cl.closed_at,
        "total": len(items), "done": done,
        "overdue": sum(1 for i in items if i.status == "open" and i.due_date and i.due_date < today),
        "items": [ser_item(i, names) for i in sorted(items, key=lambda x: x.sort_order or 0)],
    }


def name_map(db, emails) -> dict:
    emails = {e for e in emails if e}
    if not emails:
        return {}
    rows = (db.query(NexusEmployee)
            .filter(func.lower(NexusEmployee.work_email).in_(list(emails))).all())
    return {(r.work_email or "").lower(): full_name(r) for r in rows}


# --- Daily reminders -------------------------------------------------------

def _upsert_notification(db, *, recipient: str, ref_id: str, title: str, body: str,
                         company: str, action: dict) -> None:
    """One bell entry per checklist per person, rewritten each day it is
    relevant (CLAUDE.md: one notification per workflow, updated in place)."""
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == "hr_checklist",
                   NexusNotification.ref_id == ref_id,
                   NexusNotification.recipient == recipient)
           .with_for_update()
           .first())
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type="hr_checklist", recipient=recipient, title=title,
            body=body, ref_id=ref_id, item_name="", requested_by="",
            action=json.dumps(action), actioned=False, read_by="", company=company,
            created_at=_now()))
        return
    if row.title == title and row.body == body and (row.created_at or "")[:10] == _today().isoformat():
        return
    row.title, row.body, row.read_by, row.actioned = title, body, "", False
    row.created_at = _now()


def remind(db, cl: HrChecklist, emp: NexusEmployee, hr_team: list) -> int:
    """Tell each owner what they have due tomorrow or earlier on this checklist.
    Rows nobody owns go to the company's HR contact, else the HR team."""
    today = _today()
    soon = (today + timedelta(days=1)).isoformat()
    items = (db.query(HrChecklistItem)
             .filter(HrChecklistItem.checklist_id == cl.id, HrChecklistItem.status == "open",
                     HrChecklistItem.due_date != "", HrChecklistItem.due_date <= soon)
             .all())
    if not items:
        return 0
    entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
    fallback = [entity.hr_contact_email.lower()] if entity and entity.hr_contact_email else hr_team
    by_owner = {}
    for it in items:
        for r in ([it.owner_email] if it.owner_email else fallback):
            by_owner.setdefault(r, []).append(it)
    who = full_name(emp)
    label = KIND_LABELS.get(cl.kind, cl.kind)
    # My HR lists every step a person owns - the one place an owner without
    # People access (a manager, IT, the new hire) can open.
    action = {"view": "myhr", "sub": "overview"}
    sent = 0
    for recipient, rows in by_owner.items():
        rows.sort(key=lambda x: x.due_date)
        late = sum(1 for r in rows if r.due_date < today.isoformat())
        lines = []
        for r in rows[:5]:
            tag = "Overdue" if r.due_date < today.isoformat() else (
                "Due Today" if r.due_date == today.isoformat() else "Due Tomorrow")
            lines.append(f"- {r.title} ({tag}, {us_date(r.due_date)})")
        if len(rows) > 5:
            lines.append(f"- and {len(rows) - 5} more")
        title = f"{label}: {who} - {len(rows)} Step{'s' if len(rows) != 1 else ''} " + (
            "Overdue" if late == len(rows) else "Due")
        _upsert_notification(db, recipient=recipient, ref_id=cl.id, title=title,
                             body="\n".join(lines), company=cl.company, action=action)
        sent += 1
    return sent


def run_daily() -> int:
    """Sync every open checklist, then send the day's reminders. Own session and
    commit, so a failure here never rolls back the main HR reminder scan."""
    from database import SessionLocal
    from reminders import _hr_team_emails
    db = SessionLocal()
    sent = 0
    try:
        hr_team = _hr_team_emails(db)
        for cl in db.query(HrChecklist).filter(HrChecklist.status == "open").all():
            emp = db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
            if emp is None:
                continue
            try:
                sync(db, cl, emp)
                db.flush()
                if cl.status == "open":
                    sent += remind(db, cl, emp, hr_team)
            except Exception as e:   # noqa: BLE001 - one checklist never stops the pass
                print(f"[checklists] {cl.id} skipped: {e}")
        db.commit()
        print(f"[checklists] daily pass complete - {sent} reminder(s)")
        return sent
    except Exception as e:   # noqa: BLE001
        db.rollback()
        print(f"[checklists] daily pass failed: {e}")
        return 0
    finally:
        db.close()
