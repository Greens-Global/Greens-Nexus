"""Per-person onboarding / promotion / offboarding / leave checklists (HR roadmap Section C:
"Onboarding checklist per hire: docs -> sign -> provision -> assign equipment
-> day-1 tasks, each with owner + due date").

The pieces:
  - templates   per kind: the Checklist Library ('' company, seeded from
                hr_checklist_seed.py), a company's own copy, and each job ROLE's
                extra steps (Neil, Oct 19: "it has to be company and then role"
                - kept by the role's department head, added after the company's)
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
  - sync_tasks() ONE task per checklist per owner with a subtask per step,
                closing both ways with the steps (task_completed is the Tasks
                side) - Pranshu, Oct 19-20

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
    NexusGroup,
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

KINDS = ("onboarding", "promotion", "offboarding", "inactive")
# Neil, Oct 19: "payroll isn't anything, that should be accounting ...
# equipment, that should also be IT ... finance isn't a thing in our company".
ROLES = ("hr", "manager", "employee", "it", "accounting")
ROLE_LABELS = {"hr": "HR", "manager": "Manager", "employee": "Employee", "it": "IT", "accounting": "Accounting"}
# Owners saved before Oct 19 (templates, started steps, packet signing flows).
LEGACY_ROLES = {"payroll": "accounting", "finance": "accounting", "equipment": "it"}
KIND_LABELS = {"onboarding": "Onboarding", "promotion": "Promotion", "offboarding": "Offboarding",
               "inactive": "Leave or Suspension"}
OWNERS_KEY = "hr_checklist_owners:"   # + entity id ('' = default) -> {"it": email, ...}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm_role(role: str) -> str:
    r = (role or "").strip().lower()
    return LEGACY_ROLES.get(r, r)


def norm_items(items: list) -> list:
    """Template rows with pre-Oct 19 owners read as today's."""
    return [{**r, "owner": norm_role(r.get("owner", "hr"))} for r in (items or []) if isinstance(r, dict)]


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

def _base(db):
    """Company / library templates - never a role's steps."""
    return db.query(HrChecklistTemplate).filter(
        or_(HrChecklistTemplate.role_id == "", HrChecklistTemplate.role_id.is_(None)))


def own_template(db, kind: str, entity_id: str):
    """The company's (or, for '', the library's) own row - None if it has none."""
    return _base(db).filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.entity_id == entity_id).first()


def get_template(db, kind: str, entity_id: str = "") -> HrChecklistTemplate:
    """The company's own template for `kind`, else the library's, seeding the
    library the first time it is asked for."""
    if entity_id:
        own = own_template(db, kind, entity_id)
        if own:
            return own
    row = own_template(db, kind, "")
    if row:
        return row
    name, items = hr_checklist_seed.DEFAULTS[kind]
    row = HrChecklistTemplate(id=str(uuid.uuid4()), kind=kind, entity_id="", name=name,
                              items=[dict(i) for i in items], updated_by="system",
                              created_at=_now(), updated_at=_now())
    db.add(row)
    db.flush()
    return row


def role_template(db, kind: str, role_id: str):
    """A job role's extra steps for `kind` - None when it has none."""
    if not role_id:
        return None
    return (db.query(HrChecklistTemplate)
            .filter(HrChecklistTemplate.kind == kind, HrChecklistTemplate.role_id == role_id).first())


def role_for(db, emp: NexusEmployee) -> str:
    """The job role a person's checklist follows: their current role, else the
    one they were hired into (no work email - so no role membership - yet)."""
    if emp.work_email:
        from models import NexusGroupMember
        g = (db.query(NexusGroup.id).join(NexusGroupMember, NexusGroupMember.group_id == NexusGroup.id)
             .filter(func.lower(NexusGroupMember.email) == emp.work_email.lower(), NexusGroup.is_job_role == 1)
             .first())
        if g:
            return g.id
    c = (db.query(HrCandidate.role_id).filter(HrCandidate.employee_id == emp.id, HrCandidate.role_id != "")
         .order_by(HrCandidate.updated_at.desc()).first())
    return c.role_id if c else ""


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
        owner = norm_role(str(raw.get("owner") or "hr"))
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

def email_list(v) -> list:
    """An owner value - one email (saved before Oct 20) or a list - as a clean,
    de-duplicated list."""
    vals = v if isinstance(v, (list, tuple)) else str(v or "").split(",")
    return list(dict.fromkeys(e.strip().lower() for e in vals if e and str(e).strip()))


def owners_setting(raw: dict) -> dict:
    """A saved owners setting in today's roles, each role a LIST of people
    (several owners per role, Pranshu Oct 20): a pre-Oct 19 Payroll / Finance
    person owns Accounting, an Equipment person IT - unless that is set."""
    out = {k: email_list(v) for k, v in (raw or {}).items() if email_list(v) and k not in LEGACY_ROLES}
    for old, new in LEGACY_ROLES.items():
        if email_list((raw or {}).get(old)) and not out.get(new):
            out[new] = email_list(raw[old])
    return out


def role_owners(db, entity_id: str) -> dict:
    """{role: [emails]} set in Role Owners for this company, falling back to
    the default ('' entity) for roles the company left blank."""
    out = {}
    for key in (OWNERS_KEY, OWNERS_KEY + (entity_id or "")):
        row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
        if row and row.value:
            try:
                out.update(owners_setting(json.loads(row.value)))
            except (ValueError, AttributeError):
                pass
        if not entity_id:
            break
    return out


def resolve_owner(db, role: str, emp: NexusEmployee, owners: dict, entity: HrEntity) -> str:
    """ONE person for a role - the packet signing flows' signer. HR is the
    company's HR contact first."""
    role = norm_role(role)
    if role == "employee":
        return (emp.work_email or "").lower()
    if role == "manager":
        return (emp.manager_email or "").lower()
    if role == "hr" and entity is not None and entity.hr_contact_email:
        return entity.hr_contact_email.lower()
    return next(iter(email_list(owners.get(role))), "")


def resolve_owners(db, role: str, emp: NexusEmployee, owners: dict, entity: HrEntity) -> list:
    """Everyone who owns a checklist step of this role. Role Owners can name
    several people per role, all on the step's task (Pranshu, Oct 20); HR falls
    back to the company's HR contact only when no HR owner is set."""
    role = norm_role(role)
    if role in ("employee", "manager"):
        return email_list(resolve_owner(db, role, emp, owners, entity))
    found = email_list(owners.get(role))
    if not found and role == "hr" and entity is not None:
        found = email_list(entity.hr_contact_email)
    return found


def owners_of(it) -> list:
    """A step's owners (owner_emails, else the single owner_email of a step
    started before Oct 20)."""
    return email_list(it.owner_emails or it.owner_email)


def set_owners(it, emails: list) -> None:
    emails = email_list(emails)
    it.owner_emails = ",".join(emails)
    it.owner_email = emails[0] if emails else ""


def owned_by(me: str):
    """SQL filter: steps `me` owns, alone or with others."""
    from sqlalchemy import literal, or_
    me = (me or "").lower()
    return or_(HrChecklistItem.owner_email == me,
               (literal(",") + func.coalesce(HrChecklistItem.owner_emails, "") + literal(",")).like(f"%,{me},%"))


# --- Building a checklist --------------------------------------------------

def open_checklist(db, employee_id: str, kind: str):
    return (db.query(HrChecklist)
            .filter(HrChecklist.employee_id == employee_id, HrChecklist.kind == kind,
                    HrChecklist.status == "open")
            .first())


def start(db, emp: NexusEmployee, kind: str, *, anchor_date: str = "", exit_type: str = "",
          by: str = "", role_id: str = None) -> HrChecklist:
    """Create `emp`'s checklist of `kind`: the company's steps, then the job
    role's (`role_id`, else the role they hold or were hired into). Caller
    commits. Raises ValueError if one of that kind is already open (one at a
    time per person)."""
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
    role_id = role_for(db, emp) if role_id is None else role_id
    role_tpl = role_template(db, kind, role_id)
    role = db.query(NexusGroup).filter(NexusGroup.id == role_id).first() if role_tpl else None
    rows = norm_items(tpl.items) + [
        {**r, "phase": r.get("phase") or f"{role.name if role else 'Role'} Steps"}
        for r in norm_items(role_tpl.items if role_tpl else [])]
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
    for row in rows:
        if not _applies(row, emp, country, exit_type):
            continue
        n += 1
        it = HrChecklistItem(
            id=str(uuid.uuid4()), checklist_id=cl.id, key=row.get("key", ""),
            phase=row.get("phase", ""), title=row.get("title", ""), hint=row.get("hint", ""),
            owner_role=row.get("owner", "hr"),
            anchor=row.get("anchor", "S"), offset=int(row.get("offset") or 0),
            business_days=bool(row.get("bd")),
            due_date=due_for(cl.anchor_date, created, row.get("anchor", "S"),
                             int(row.get("offset") or 0), bool(row.get("bd")), hol),
            signal=row.get("signal", ""), status="open", sort_order=n, comments=[],
        )
        set_owners(it, resolve_owners(db, row.get("owner", "hr"), emp, owners, entity))
        db.add(it)
    db.flush()
    # The owners' tasks, and their "task assigned" email once this commits -
    # a hire or a signed promotion starts here from inside a signing request,
    # with no response to send it after (Pranshu, Oct 20).
    cl.new_task_ids = sync_tasks(db, cl, emp, by=by or "nexus", first=True)
    email_tasks_after_commit(db, cl.new_task_ids, by or "nexus")
    return cl


def email_tasks_after_commit(db, task_ids: list, by: str) -> None:
    """Queue the task-assigned email (notify_task_event - batched like every
    task email) for each task once the transaction commits. From a thread, and
    only once the tasks are really saved: after_commit also fires for a
    SAVEPOINT, and a rolled-back start never shows up, so nothing is sent."""
    ids = [t for t in (task_ids or []) if t]
    if not ids:
        return
    import threading

    from sqlalchemy import event as sa_event

    def send():
        import time

        import models
        from database import SessionLocal
        from task_notify import notify_task_event
        for _ in range(150):                  # up to five minutes
            s2 = SessionLocal()
            try:
                found = s2.query(models.Task.id).filter(models.Task.id == ids[0]).first() is not None
            finally:
                s2.close()
            if found:
                for tid in ids:
                    try:
                        notify_task_event(tid, "assigned", by)
                    except Exception as e:   # noqa: BLE001 - one email never stops the rest
                        print(f"[checklists] task email for {tid} failed: {e}")
                return
            time.sleep(2)

    sa_event.listen(db, "after_commit", lambda _s: threading.Thread(target=send, daemon=True).start(), once=True)


def start_on_hire(db, emp: NexusEmployee, by: str, role_id: str = None) -> None:
    """Hook for the hiring pipeline (Hired -> employee in Onboarding), with the
    steps of the role they were hired into. Never lets a checklist problem
    block the hire itself."""
    try:
        if not open_checklist(db, emp.id, "onboarding"):
            start(db, emp, "onboarding", by=by, role_id=role_id or None)
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
    if (db.query(HrSignRequest.id)
            .join(HrSignTemplate, HrSignTemplate.id == HrSignRequest.template_id)
            .filter(HrSignRequest.status == "completed", HrSignTemplate.kind.in_(kinds), who)
            .first()) is not None:
        return True
    # Offers and hiring packets built from Documents (Oct 14) have no Nexus
    # Sign template to carry a kind - their life event says what they were:
    # a signed offer letter ticks "Offer Letter Signed", a signed hiring
    # packet (the NDA, the onboarding forms) ticks the pre-boarding packet.
    events = [ev for k, ev in (("offer", "offer"), ("contractor_agreement", "offer"),
                               ("nda", "hire"), ("handbook_ack", "hire"), ("promotion", "promotion")) if k in kinds]
    if not events:
        return False
    from models import HrLifeEvent
    owner = HrLifeEvent.employee_id == emp.id
    if cand_ids:
        owner = or_(owner, HrLifeEvent.candidate_id.in_(cand_ids))
    return (db.query(HrLifeEvent.id)
            .filter(HrLifeEvent.kind.in_(events), HrLifeEvent.status == "completed", owner)
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
    "envelope": "A Nexus Sign envelope of that kind completed (or the signed offer letter / hiring packet)",
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

    # 2. Open steps follow Role Owners as they stand now: an owner not known at
    #    the start, or one added / swapped since. A hand-set owner stays.
    auto = [it for it in items if it.status == "open" and not it.owner_manual]
    if auto:
        owners = role_owners(db, cl.company)
        entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
        for it in auto:
            found = resolve_owners(db, it.owner_role, emp, owners, entity)
            if found and found != owners_of(it):
                set_owners(it, found)
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


# --- Tasks -----------------------------------------------------------------
# Each owner gets ONE task per checklist with one SUBTASK per step they own
# (Pranshu, Oct 20: "whatever has been assigned to them should auto create a
# task for them, and when they close the task it should close the checklist
# step, or if they close the checklist step it closes the task"):
#   step done / N/A        -> its subtask completes (sync_tasks)
#   subtask completed      -> its step is done (task_completed)
#   subtask reopened       -> its step reopens
#   parent completed       -> every step still open under it is done
#   no step left open      -> the parent completes; one coming back reopens it
# HrChecklistItem.task_id is the step's subtask; the parent is its parent_task_id.

def _new_task(db, cl: HrChecklist, owners: list, title: str, desc: str, due: str, by: str, parent_id: str = ""):
    import models
    from routers.task_util import set_task_assignees
    from routers.tasks import _next_code
    now = _now()
    t = models.Task(
        id=str(uuid.uuid4()), code=_next_code(db), company_id=cl.company or "", title=title,
        description=desc, type="task", status="not_started", priority="medium",
        position=datetime.now().timestamp(), assignee_email="", assignee_emails=[],
        owner_email=(by or "nexus").lower(), follower_emails=[], liked_by_emails=[],
        access_level="restricted", project_id="", project_ids=[], section_id="", team_id="",
        parent_task_id=parent_id, subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={},
        tags=[], custom_field_values={}, start_on="", due_on=due, approval_status="none",
        completed=False, completed_at="", comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=(by or "nexus").lower())
    set_task_assignees(t, list(owners))
    db.add(t)
    return t


def _set_done(t, done: bool) -> bool:
    if t is None or bool(t.completed) == done:
        return False
    now = _now()
    t.completed, t.completed_at, t.modified_at = done, (now if done else ""), now
    t.status = "completed" if done else "not_started"
    return True


def _parent_text(cl: HrChecklist, emp: NexusEmployee, open_rows: list) -> tuple:
    label = KIND_LABELS.get(cl.kind, cl.kind)
    n = len(open_rows)
    title = f"{label}: {full_name(emp)} - {n} Step{'s' if n != 1 else ''}" if n else f"{label}: {full_name(emp)}"
    desc = (f"Your steps on {full_name(emp)}'s {label.lower()} checklist are the subtasks below. Completing one "
            f"marks that step done on the checklist (and ticking the step on the checklist completes it here). "
            f"Completing this task marks every step still open done.")
    return title, desc


def sync_tasks(db, cl: HrChecklist, emp: NexusEmployee = None, by: str = "nexus", first: bool = False) -> list:
    """Bring the owners' tasks in line with the checklist: a parent per owner
    (per set of owners when a role has several - one shared task, so any of
    them closing it closes the step), a subtask per step (moved when a step is
    reassigned), each completed exactly when its step / all their steps are
    closed. Returns the ids of new parent
    tasks (the caller commits, then may send the task email). Only checklists
    started with tasks (`first`, from start()) get them - the ones open before
    Oct 19 are left as they were, never a burst of tasks."""
    import models
    from routers.task_util import set_task_assignees, task_assignees
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    if emp is None or not items or not (first or any(i.task_id for i in items)):
        return []
    ids = {i.task_id for i in items if i.task_id}
    subs = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(list(ids)))} if ids else {}
    pids = {t.parent_task_id for t in subs.values() if t.parent_task_id}
    parents = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(list(pids)))} if pids else {}
    # Field history (Oct 22 2026): what this sync changes on tasks that
    # already existed is recorded under `by`, due dates included (they are
    # written here directly, not through task_due).
    import task_history
    hist_before = {t.id: (t, task_history.snapshot(t)) for t in [*subs.values(), *parents.values()]}
    def key(emails):                  # one task per owner, or per set of owners
        return ",".join(sorted(email_list(emails)))

    by_owner = {}
    for p in parents.values():
        if not getattr(p, "deleted_at", ""):
            by_owner.setdefault(key(task_assignees(p)), p)
    live = cl.status == "open"
    created, now = [], _now()
    rows = sorted(items, key=lambda x: (x.sort_order or 0))
    for owner in dict.fromkeys(key(owners_of(i)) for i in rows if owners_of(i)):
        mine = [i for i in rows if key(owners_of(i)) == owner]
        people = owners_of(mine[0])
        open_rows = sorted([i for i in mine if i.status == "open"], key=lambda x: (x.due_date or "9999-12-31", x.sort_order or 0))
        parent = by_owner.get(owner)
        if parent is None:
            if not (live and open_rows):
                continue                      # nothing for them to do - no task
            title, desc = _parent_text(cl, emp, open_rows)
            parent = _new_task(db, cl, people, title, desc, open_rows[0].due_date or "", by)
            by_owner[owner] = parent
            created.append(parent.id)
        kids = list(parent.subtask_ids or [])
        for it in mine:
            sub = subs.get(it.task_id)
            if sub is None or getattr(sub, "deleted_at", ""):
                if it.status != "open" and sub is None and not it.task_id:
                    continue                  # closed before it ever had a subtask
                sub = _new_task(db, cl, people, it.title, it.hint or "", it.due_date or "", by, parent_id=parent.id)
                subs[sub.id] = sub
                it.task_id = sub.id
            elif key(task_assignees(sub)) != owner or sub.parent_task_id != parent.id:
                old = parents.get(sub.parent_task_id)
                if old is not None:           # reassigned: the subtask moves to the new owner's task
                    old.subtask_ids = [x for x in (old.subtask_ids or []) if x != sub.id]
                set_task_assignees(sub, people)
                sub.parent_task_id, sub.modified_at = parent.id, now
            if (sub.due_on or "") != (it.due_date or ""):
                sub.due_on, sub.modified_at = it.due_date or "", now
            _set_done(sub, it.status != "open" or not live)
            if sub.id not in kids:
                kids.append(sub.id)
        parent.subtask_ids = kids
        title, desc = _parent_text(cl, emp, open_rows)
        due = next((r.due_date for r in open_rows if r.due_date), "")
        if (parent.title, parent.description, parent.due_on or "") != (title, desc, due):
            parent.title, parent.description, parent.due_on, parent.modified_at = title, desc, due, now
        _set_done(parent, not (live and open_rows))
    # An owner who no longer has any step here (all reassigned away).
    owners = {key(owners_of(i)) for i in rows}
    for owner, p in by_owner.items():
        if owner not in owners:
            _set_done(p, True)
    for t, before in hist_before.values():
        task_history.record(db, t, before, by, with_due=True)
    return created


def task_due_changed(db, task, by: str) -> bool:
    """Tasks told us a checklist subtask's due date changed (update_task /
    bulk_update): the step takes the date, pinned like a date HR sets on the
    step (Pranshu, Oct 20). The step -> subtask direction is sync_tasks.
    Returns True when it was a checklist subtask. The caller commits."""
    if task is None or not task.parent_task_id:
        return False
    it = db.query(HrChecklistItem).filter(HrChecklistItem.task_id == task.id).first()
    if it is None:
        return False
    due = (task.due_on or "")[:10]
    if (it.due_date or "") != due:
        it.due_date, it.due_manual = due, True
        db.flush()
        cl = db.query(HrChecklist).filter(HrChecklist.id == it.checklist_id).first()
        if cl is not None:
            sync_tasks(db, cl, by=(by or "").lower())     # the parent's date is its earliest open step
    return True


def comments_for(db, items: list) -> dict:
    """{step id: [comment]} - ONE thread per step, shared with Tasks (Pranshu,
    Oct 20): a comment on the step's subtask shows on the step, and a comment
    made on the step is posted on the subtask. Steps with no subtask keep
    theirs on the row (HrChecklistItem.comments). Oldest first."""
    import models
    by_task = {i.task_id: i.id for i in items if i.task_id}
    out = {i.id: [dict(c) for c in (i.comments or []) if isinstance(c, dict)] for i in items}
    if by_task:
        for c in (db.query(models.TaskComment)
                  .filter(models.TaskComment.task_id.in_(list(by_task))).all()):
            out[by_task[c.task_id]].append({"id": c.id, "author": (c.author_email or "").lower(), "body": c.body or "",
                                            "at": c.created_at or "", "editedAt": c.edited_at or ""})
    names = name_map(db, [c.get("author", "") for rows in out.values() for c in rows])
    for rows in out.values():
        for c in rows:
            c["authorName"] = names.get(c.get("author", ""), "") or c.get("author", "")
        rows.sort(key=lambda c: c.get("at") or "")
    return out


def _close_if_done(cl: HrChecklist, items: list) -> None:
    closed = bool(items) and all(i.status in ("done", "na") for i in items)
    if closed and cl.status == "open":
        cl.status, cl.closed_at = "done", _now()
    elif not closed and cl.status == "done":
        cl.status, cl.closed_at = "open", ""


def task_completed(db, task, done: bool, by: str) -> bool:
    """Tasks told us a checklist task was completed or reopened (update_task /
    bulk_update, after the change landed). Mirrors it onto the steps. Returns
    True when it was a checklist task. The caller commits."""
    import models
    if task is None:
        return False
    if task.parent_task_id:
        step = db.query(HrChecklistItem).filter(HrChecklistItem.task_id == task.id).first()
        steps = [step] if step is not None else []
    else:
        kid_ids = [k for k in (task.subtask_ids or []) if k]
        steps = (db.query(HrChecklistItem).filter(HrChecklistItem.task_id.in_(kid_ids)).all() if kid_ids else [])
        if not done:
            return bool(steps)                # reopening the parent changes no step
    if not steps:
        return False
    cl = db.query(HrChecklist).filter(HrChecklist.id == steps[0].checklist_id).first()
    if cl is None or cl.status == "cancelled":
        return True
    who, now = (by or "").lower(), _now()
    for it in steps:
        if done and it.status == "open":
            it.status, it.done_by, it.done_at = "done", who, now
        elif not done and it.status == "done":
            it.status, it.done_by, it.done_at = "open", "", ""
    if not task.parent_task_id and done:
        for sub in db.query(models.Task).filter(models.Task.id.in_([s.task_id for s in steps])).all():
            _set_done(sub, True)
    db.flush()
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    _close_if_done(cl, items)
    sync_tasks(db, cl, by=who)
    return True


# --- Serializers -----------------------------------------------------------

def ser_item(it: HrChecklistItem, names: dict = None, comments: list = None) -> dict:
    today = _today().isoformat()
    owners = owners_of(it)
    return {
        "id": it.id, "checklistId": it.checklist_id, "key": it.key, "phase": it.phase,
        "title": it.title, "hint": it.hint,
        "ownerRole": it.owner_role, "ownerRoleLabel": ROLE_LABELS.get(it.owner_role, it.owner_role),
        "ownerEmail": it.owner_email,
        "ownerName": ", ".join((names or {}).get(e, "") or e for e in owners) if len(owners) > 1 else (names or {}).get(it.owner_email, ""),
        "ownerEmails": owners,
        "ownerManual": bool(it.owner_manual),
        "anchor": it.anchor, "offset": it.offset, "businessDays": bool(it.business_days),
        "dueDate": it.due_date, "dueManual": bool(it.due_manual),
        "overdue": bool(it.status == "open" and it.due_date and it.due_date < today),
        "signal": it.signal,
        "signalLabel": SIGNAL_LABELS.get(signal_name(it.signal), "") if it.signal else "",
        "status": it.status, "doneBy": it.done_by, "doneAt": it.done_at, "note": it.note,
        "comments": comments or [], "sortOrder": it.sort_order,
    }


def ser_checklist(cl: HrChecklist, items: list, names: dict = None, comments: dict = None,
                  role_people: dict = None) -> dict:
    done = sum(1 for i in items if i.status in ("done", "na"))
    today = _today().isoformat()
    return {
        "id": cl.id, "employeeId": cl.employee_id, "kind": cl.kind,
        "kindLabel": KIND_LABELS.get(cl.kind, cl.kind), "company": cl.company,
        "anchorDate": cl.anchor_date, "exitType": cl.exit_type, "status": cl.status,
        "createdBy": cl.created_by, "createdAt": cl.created_at, "closedAt": cl.closed_at,
        "total": len(items), "done": done,
        "overdue": sum(1 for i in items if i.status == "open" and i.due_date and i.due_date < today),
        "items": [ser_item(i, names, (comments or {}).get(i.id)) for i in sorted(items, key=lambda x: x.sort_order or 0)],
        # {role: [emails]} - who holds each role for this person today; Change
        # Owner lists them first (Pranshu, Oct 20).
        "roleOwners": role_people or {},
    }


def role_people(db, cl: HrChecklist, emp: NexusEmployee = None) -> dict:
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    if emp is None:
        return {}
    owners = role_owners(db, cl.company)
    entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
    return {r: resolve_owners(db, r, emp, owners, entity) for r in ROLES}


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
        for r in (owners_of(it) or fallback):
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
    sent, new_tasks = 0, []
    try:
        hr_team = _hr_team_emails(db)
        for cl in db.query(HrChecklist).filter(HrChecklist.status == "open").all():
            emp = db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
            if emp is None:
                continue
            try:
                sync(db, cl, emp)
                db.flush()
                new_tasks += sync_tasks(db, cl, emp)
                if cl.status == "open":
                    sent += remind(db, cl, emp, hr_team)
            except Exception as e:   # noqa: BLE001 - one checklist never stops the pass
                print(f"[checklists] {cl.id} skipped: {e}")
        db.commit()
        from task_notify import notify_task_event
        for tid in new_tasks:          # already off the event loop (run in a thread)
            notify_task_event(tid, "assigned", "nexus")
        print(f"[checklists] daily pass complete - {sent} reminder(s)")
        return sent
    except Exception as e:   # noqa: BLE001
        db.rollback()
        print(f"[checklists] daily pass failed: {e}")
        return 0
    finally:
        db.close()
