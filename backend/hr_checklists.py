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
    HrDepartment,
    HrDocument,
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
OWNERS_KEY = "hr_checklist_owners:"   # pre-Oct 22 Role Owners lists: retired Oct 23, the rows stay, nothing reads them
# Neil, Oct 22: "integrate role owners with department heads in departments in
# settings... when you set up your company for the very first time, you are
# saying who is the head of each... there needs to be a backup also", and "if
# the company setup did not happen properly... it should default back to global
# admin". HR / IT / Accounting steps belong to the head AND backup of the
# department of that name - no separate checklist owner setting (Pranshu, Oct 23).
DEPT_ROLES = ("hr", "it", "accounting")
# Pranshu, Oct 23: HR, IT and Accounting always own steps; any other department
# of the company can be ticked on its Checklists tab to own steps too - a step
# owner "dept:<department id>", done by that department's head and backup.
DEPT_PREFIX = "dept:"
STEP_DEPTS_KEY = "hr_checklist_step_depts:"   # + entity id -> [department id, ...]
DEPT_NAMES = {"hr": ("hr", "human resources", "people", "people operations"),
              "it": ("it", "information technology", "it support"),
              "accounting": ("accounting", "finance", "accounts")}


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


# Templates seeded before Oct 22 (Neil, Oct 22 - the Colin case: a full
# packet, no picture ID on file): I-9 Section 2 and right-to-work were plain
# ticks, and only US employees had an ID step at all.
EVIDENCE_MARK = "hr_checklists.id_evidence_backfill"
EVIDENCE_SIGNALS = {"ON-23": "id_on_file", "ON-24": "work_auth_verified"}


def backfill_id_evidence(db) -> int:
    """Once, from main._startup_seeds: the Checklist Library and every
    company's own onboarding template (never a role's) - ON-23 / ON-24 take
    their evidence condition where they have none, and Picture ID On File
    (ON-34, everyone) goes in after the last Offer Accepted step where that
    key is missing. The nexus_settings mark makes later boots a no-op, so a
    step or condition HR removes afterwards stays removed. Open checklists
    take it in the daily reconcile. Commits; returns templates changed."""
    if db.get(NexusSetting, EVIDENCE_MARK):
        return 0
    step = next(r for r in hr_checklist_seed.ONBOARDING if r["key"] == "ON-34")
    n = 0
    for tpl in _base(db).filter(HrChecklistTemplate.kind == "onboarding").all():
        items = [dict(r) for r in (tpl.items or []) if isinstance(r, dict)]
        changed = False
        for r in items:
            sig = EVIDENCE_SIGNALS.get(r.get("key"))
            if sig and not r.get("signal"):
                r["signal"], changed = sig, True
        if not any(r.get("key") == step["key"] for r in items):
            at = max((i + 1 for i, r in enumerate(items) if r.get("phase") == step["phase"]), default=0)
            items.insert(at, dict(step))
            changed = True
        if changed:
            tpl.items, tpl.updated_by, tpl.updated_at = items, "system", _now()
            n += 1
    db.add(NexusSetting(key=EVIDENCE_MARK, value=_now(), updated_by="startup", updated_at=_now()))
    db.commit()
    return n


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
        if owner not in ROLES and not (owner.startswith(DEPT_PREFIX) and len(owner) > len(DEPT_PREFIX)):
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
        # Several automatic conditions (Neil, Oct 22: "a multi-select... it
        # gets done if you tick it, but it could also be done automatically").
        sigs = raw.get("signals") if isinstance(raw.get("signals"), list) else signal_list(raw.get("signal"))
        sigs = list(dict.fromkeys(str(x).strip() for x in sigs if str(x or "").strip()))
        for sig in sigs:
            if signal_name(sig) not in SIGNALS or SIG_SEP in sig:
                raise ValueError(f"{title}: unknown completion signal {sig}")
        signal = SIG_SEP.join(sigs)
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


def _setting_json(db, key: str) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    try:
        val = json.loads(row.value) if row and row.value else {}
    except ValueError:
        val = {}
    return val if isinstance(val, dict) else {}


def active_people(db, emails) -> list:
    """The emails that belong to someone active (or onboarding) in Nexus People."""
    want = email_list(emails)
    if not want:
        return []
    live = {(e.work_email or "").lower() for e in db.query(NexusEmployee.work_email)
            .filter(func.lower(NexusEmployee.work_email).in_(want),
                    NexusEmployee.status.in_(("active", "onboarding")))}
    return [e for e in want if e in live]


def owner_departments(db, entity_id: str) -> dict:
    """{role: HrDepartment} - the company's department for HR, IT and
    Accounting, by its name ("HR", "Human Resources", "Finance"...)."""
    if not entity_id:
        return {}
    rows = (db.query(HrDepartment).filter(HrDepartment.company_id == entity_id)
            .order_by(HrDepartment.sort_order, HrDepartment.name).all())
    out = {}
    for role in DEPT_ROLES:
        d = next((r for r in rows if (r.name or "").strip().lower() in DEPT_NAMES[role]), None)
        if d is not None:
            out[role] = d
    return out


def step_departments(db, entity_id: str) -> list:
    """The company's other departments ticked to own checklist steps, in
    Departments order (a deleted one drops out)."""
    if not entity_id:
        return []
    try:
        picked = json.loads(_setting_raw(db, STEP_DEPTS_KEY + entity_id) or "[]")
    except ValueError:
        picked = []
    picked = {str(x) for x in picked} if isinstance(picked, list) else set()
    taken = {d.id for d in owner_departments(db, entity_id).values()}
    return [d for d in db.query(HrDepartment).filter(HrDepartment.company_id == entity_id)
            .order_by(HrDepartment.sort_order, HrDepartment.name).all() if d.id in picked and d.id not in taken]


def _setting_raw(db, key: str) -> str:
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    return row.value if row and row.value else ""


def role_owners(db, entity_id: str) -> dict:
    """{role: [emails]} for HR / IT / Accounting at this company, and
    "dept:<id>" for each other department ticked to own steps: the
    department's head and backup (whoever of them is active). ONE setup, no
    people list kept inside checklists (Neil, Oct 22 4:41-5:42, 35:07): an
    empty role falls back in resolve_owners to HR, the HR contact, then the
    Global Admins."""
    out = {}
    pairs = [*owner_departments(db, entity_id).items(), *((DEPT_PREFIX + d.id, d) for d in step_departments(db, entity_id))]
    for role, d in pairs:
        people = active_people(db, [d.lead_email, d.backup_email])
        if people:
            out[role] = people
    return out


def role_label(db, role: str) -> str:
    """"HR", "Manager"... or a ticked department's name."""
    if role in ROLE_LABELS:
        return ROLE_LABELS[role]
    if (role or "").startswith(DEPT_PREFIX):
        d = db.query(HrDepartment).filter(HrDepartment.id == role[len(DEPT_PREFIX):]).first()
        return d.name if d else "Department"
    return role or ""


def global_admins(db) -> list:
    """The last stop for a step nobody else owns (Neil, Oct 22)."""
    from timesheet_alerts import _global_admins
    return _global_admins(db)


def resolve_owner(db, role: str, emp: NexusEmployee, owners: dict, entity: HrEntity) -> str:
    """ONE person for a role - the packet signing flows' signer. HR is the
    HR department's head (else its backup), then the company's HR contact."""
    role = norm_role(role)
    if role == "employee":
        return (emp.work_email or "").lower()
    if role == "manager":
        return (emp.manager_email or "").lower()
    found = email_list(owners.get(role))
    if not found and role == "hr" and entity is not None:
        found = email_list(entity.hr_contact_email)
    return next(iter(found), "")


def resolve_owners(db, role: str, emp: NexusEmployee, owners: dict, entity: HrEntity) -> list:
    """Everyone who owns a checklist step of this role - all of them on the
    step's task, so whichever closes it closes it for the rest. Nobody is ever
    left without an owner (Neil, Oct 22): a manager step with no manager goes
    to the head of the person's department, then HR; HR is the department,
    then the company's HR contact; anything still unowned goes to the Global
    Admins. An employee step waits for the person's work email."""
    role = norm_role(role)
    if role == "employee":
        return email_list(resolve_owner(db, role, emp, owners, entity))
    if role == "manager":
        found = email_list(emp.manager_email)
        if not found and emp.department and emp.company:
            dept = next((d for d in db.query(HrDepartment).filter(HrDepartment.company_id == emp.company)
                         if (d.name or "").strip().lower() == emp.department.strip().lower()), None)
            found = active_people(db, [dept.lead_email, dept.backup_email]) if dept else []
            found = [e for e in found if e != (emp.work_email or "").lower()]   # never their own manager step
        if not found:
            role = "hr"
        else:
            return found
    found = email_list(owners.get(role))
    if not found and role.startswith(DEPT_PREFIX):
        found, role = email_list(owners.get("hr")), "hr"   # nobody active there, or no longer ticked: HR
    if not found and role == "hr" and entity is not None:
        found = email_list(entity.hr_contact_email)
    return found or global_admins(db)


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


def _dedupe_keys(keys: list, role_id: str) -> list:
    """Step keys made unique across the baseline and the role: a role step
    whose key the baseline (or an earlier step) already uses reads as
    "<key>~<role>". The same rule maps a checklist's own steps, so one started
    before Oct 23 with a repeated key still matches its template rows."""
    seen, out = set(), []
    for k in keys:
        if k and k in seen:
            k = f"{k}~{(role_id or 'role')[:8]}"
        seen.add(k)
        out.append(k)
    return out


def template_rows(db, kind: str, company: str, role_id: str) -> tuple:
    """(company / library template, rows) - the steps a checklist of `kind`
    follows today: the company's own (else the Checklist Library's), then the
    job role's, with keys unique across both."""
    tpl = get_template(db, kind, company or "")
    role_tpl = role_template(db, kind, role_id)
    role = db.query(NexusGroup).filter(NexusGroup.id == role_id).first() if role_tpl else None
    rows = norm_items(tpl.items) + [
        {**r, "phase": r.get("phase") or f"{role.name if role else 'Role'} Steps"}
        for r in norm_items(role_tpl.items if role_tpl else [])]
    for r, k in zip(rows, _dedupe_keys([r.get("key", "") for r in rows], role_id)):
        r["key"] = k
    return tpl, rows


class _StepContext:
    """What turning a template row into a person's step needs: holidays,
    owners, the company and the country - looked up once per checklist."""

    def __init__(self, db, cl: HrChecklist, emp: NexusEmployee):
        self.db, self.cl, self.emp = db, cl, emp
        self.hol = _holidays(db, cl.company or "")
        self.owners = role_owners(db, cl.company or "")
        self.entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
        self.country = person_country(db, emp)
        self.created = (cl.created_at or "")[:10] or _today().isoformat()

    def due(self, row: dict) -> str:
        return due_for(self.cl.anchor_date, self.created, row.get("anchor", "S"),
                       int(row.get("offset") or 0), bool(row.get("bd")), self.hol)

    def owners_for(self, role: str) -> list:
        return resolve_owners(self.db, role, self.emp, self.owners, self.entity)

    def new_item(self, row: dict, sort_order: int) -> HrChecklistItem:
        it = HrChecklistItem(
            id=str(uuid.uuid4()), checklist_id=self.cl.id, key=row.get("key", ""),
            phase=row.get("phase", ""), title=row.get("title", ""), hint=row.get("hint", ""),
            owner_role=row.get("owner", "hr"),
            anchor=row.get("anchor", "S"), offset=int(row.get("offset") or 0),
            business_days=bool(row.get("bd")), due_date=self.due(row),
            signal=row.get("signal", ""), status="open", sort_order=sort_order, comments=[],
        )
        set_owners(it, self.owners_for(row.get("owner", "hr")))
        return it


def reconcile(db, cl: HrChecklist, emp: NexusEmployee = None, by: str = "nexus") -> bool:
    """Bring an OPEN checklist in line with its templates as they are now
    (Neil, Oct 22: "Is it dynamic or is it fixed? ... it needs to fix on task
    also"). Steps match their template rows by key:
      - a row the person gets that the checklist lacks -> a new open step
        (date, owners; sync_tasks then gives it a subtask)
      - a row that changed -> its OPEN step takes the new title, hint, phase,
        owner role, timing and conditions; a hand-set owner or date stays
      - a step whose row is gone (or no longer applies to them) and is still
        open -> N/A with a note, never deleted; its subtask completes
    Done and N/A steps are history and never change. Flushes; caller commits.
    Returns True when anything changed."""
    if cl.status != "open":
        return False
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    if emp is None:
        return False
    changed = False
    if cl.role_id is None:               # started before Oct 23: the role they hold now
        cl.role_id, changed = role_for(db, emp) or "", True
    _, rows = template_rows(db, cl.kind, cl.company or "", cl.role_id)
    ctx = _StepContext(db, cl, emp)
    every = {r["key"] for r in rows}
    rows = [r for r in rows if _applies(r, emp, ctx.country, cl.exit_type)]
    want = {r["key"]: r for r in rows}
    items = sorted(db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all(),
                   key=lambda x: x.sort_order or 0)
    have = {k: it for k, it in zip(_dedupe_keys([i.key or "" for i in items], cl.role_id), items) if k}
    n = max([i.sort_order or 0 for i in items] or [0])
    retitled = []
    for r in rows:
        it = have.get(r["key"])
        if it is None:
            n += 1
            db.add(ctx.new_item(r, n))
            changed = True
            continue
        if it.status != "open":
            continue
        for field, val in (("title", r.get("title", "")), ("hint", r.get("hint", "")),
                           ("phase", r.get("phase", "")), ("signal", r.get("signal", ""))):
            if (getattr(it, field) or "") != val:
                setattr(it, field, val)
                changed = True
                if field in ("title", "hint") and it not in retitled:
                    retitled.append(it)
        role = r.get("owner", "hr")
        if norm_role(it.owner_role) != role:
            it.owner_role, changed = role, True
            if not it.owner_manual:
                set_owners(it, ctx.owners_for(role))
        timing = (r.get("anchor", "S"), int(r.get("offset") or 0), bool(r.get("bd")))
        if (it.anchor, it.offset or 0, bool(it.business_days)) != timing:
            it.anchor, it.offset, it.business_days = timing
            if not it.due_manual:
                it.due_date = ctx.due(r)
            changed = True
    stamp = us_date(_today().isoformat())
    for k, it in have.items():
        if k not in want and it.status == "open":
            it.status, it.done_by, it.done_at, it.done_reason = "na", "Nexus", _now(), ""
            it.note = (f"Removed from the template on {stamp}" if k not in every
                       else f"No longer applies to this person - the template changed on {stamp}")
            changed = True
    if retitled:                         # the subtasks read like their steps
        import models
        import task_history
        steps = {i.task_id: i for i in retitled if i.task_id}
        for t in db.query(models.Task).filter(models.Task.id.in_(list(steps))).all() if steps else []:
            before = task_history.snapshot(t)
            t.title, t.description, t.modified_at = sub_title(steps[t.id], emp), steps[t.id].hint or "", _now()
            task_history.record(db, t, before, by)
    if changed:
        db.flush()
    return changed


def reconcile_open(db, kind: str, *, entity_id: str = None, role_id: str = None, by: str = "nexus") -> int:
    """After a template save: every open checklist that template feeds takes
    it now (reconcile), with its tasks. `role_id` = a role's steps changed;
    `entity_id` = a company's ('' = the Checklist Library - the companies with
    no copy of their own). Returns how many open checklists changed; the new
    tasks' email goes out after commit. Caller commits."""
    q = db.query(HrChecklist).filter(HrChecklist.status == "open", HrChecklist.kind == kind)
    if role_id is None and entity_id:
        q = q.filter(HrChecklist.company == entity_id)
    n, created = 0, []
    for cl in q.all():
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
        if emp is None:
            continue
        if role_id is not None:
            if cl.role_id is None:
                cl.role_id = role_for(db, emp) or ""
            if cl.role_id != role_id:
                continue
        elif entity_id == "" and cl.company and own_template(db, kind, cl.company) is not None:
            continue                     # that company keeps its own steps
        if reconcile(db, cl, emp, by=by):
            n += 1
            sync(db, cl, emp)
            db.flush()
            created += sync_tasks(db, cl, emp, by=by)
    email_tasks_after_commit(db, created, by)
    return n


def start(db, emp: NexusEmployee, kind: str, *, anchor_date: str = "", exit_type: str = "",
          by: str = "", role_id: str = None, audit: bool = False, notify: bool = True) -> HrChecklist:
    """Create `emp`'s checklist of `kind`: the company's steps, then the job
    role's (`role_id`, else the role they hold or were hired into). Caller
    commits. Raises ValueError if one of that kind is already open (one at a
    time per person). `audit`: an Onboarding Audit of someone already here -
    dated from today, and what is already on file ticks itself before any
    task is made. `notify=False`: the caller sends the task emails (a bulk
    audit sends one per person for the lot)."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if audit:
        if kind != "onboarding":
            raise ValueError("Only onboarding is audited")
        anchor_date = _today().isoformat()      # due dates count from the audit, not the old start date
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

    role_id = role_for(db, emp) if role_id is None else role_id
    tpl, rows = template_rows(db, kind, emp.company or "", role_id)
    cl = HrChecklist(id=str(uuid.uuid4()), employee_id=emp.id, kind=kind, template_id=tpl.id,
                     company=emp.company or "", anchor_date=anchor_date[:10], exit_type=exit_type,
                     status="open", created_by=by, created_at=_now(), role_id=role_id or "", audit=bool(audit))
    db.add(cl)
    ctx = _StepContext(db, cl, emp)
    n = 0
    for row in rows:
        if not _applies(row, emp, ctx.country, exit_type):
            continue
        n += 1
        db.add(ctx.new_item(row, n))
    db.flush()
    # The owners' tasks, and their "task assigned" email once this commits -
    # a hire or a signed promotion starts here from inside a signing request,
    # with no response to send it after (Pranshu, Oct 20).
    if audit:                                   # the proof already on file closes its steps first
        sync(db, cl, emp)
        db.flush()
    cl.new_task_ids = sync_tasks(db, cl, emp, by=by or "nexus", first=True)
    if notify:
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


def resync_company(db, entity_id: str, by: str) -> list:
    """Open checklists at a company ('' = every company) take who owns their
    steps NOW - a department head or backup changed - and their tasks follow. The new tasks' email goes
    out after commit. Returns the new task ids."""
    q = db.query(HrChecklist).filter(HrChecklist.status == "open")
    if entity_id:
        q = q.filter(HrChecklist.company == entity_id)
    created = []
    for cl in q.all():
        if sync(db, cl):
            db.flush()
            created += sync_tasks(db, cl, by=by)
    email_tasks_after_commit(db, created, by)
    return created


def refresh_person(db, employee_id: str, by: str = "nexus") -> list:
    """The evidence behind a person's automatic steps just changed (a signed
    offer, a provisioning run, an ID or work authorization on file): each of
    their OPEN checklists ticks what it now can and its tasks follow at once -
    not when someone next opens the profile or at the nightly pass (Neil, Oct
    22 1:03:43: "close it off and let's see if it closed off there"). In a
    savepoint, so a checklist problem never undoes the change that called it;
    the new tasks' email goes out after commit. Returns the new task ids."""
    if not employee_id:
        return []
    created = []
    db.flush()                       # autoflush is off: the signals must see the change
    sp = db.begin_nested()
    try:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == employee_id).first()
        for cl in (db.query(HrChecklist)
                   .filter(HrChecklist.employee_id == employee_id, HrChecklist.status == "open").all()):
            if sync(db, cl, emp):
                db.flush()
                created += sync_tasks(db, cl, emp, by=by)
        sp.commit()
    except Exception as e:   # noqa: BLE001 - best effort by design
        sp.rollback()
        print(f"[checklists] refresh for {employee_id} skipped: {e}")
        return []
    email_tasks_after_commit(db, created, by)
    return created


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

# A step's `signal` holds one or more conditions joined by SIG_SEP - any one
# met ticks it (Neil, Oct 22). One condition is the pre-Oct 23 shape, so old
# rows read as they always did; "|" never appears inside a condition (an
# envelope's kinds are joined by ",").
SIG_SEP = "|"


def signal_list(signal) -> list:
    return [x.strip() for x in str(signal or "").split(SIG_SEP) if x.strip()]


def signal_name(signal: str) -> str:
    return (signal or "").split(":", 1)[0]


def signal_label(signal: str) -> str:
    return SIGNAL_PRESETS.get(signal) or SIGNAL_LABELS.get(signal_name(signal), "")


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


# Evidence on the person's record (Neil, Oct 22 - the Colin case: a full
# onboarding packet but no picture ID on file, found only when an attorney
# asked). These check the record itself, not that someone said so.

def _sig_id_on_file(db, emp, arg):
    today = _today().isoformat()
    return (db.query(HrDocument.id)
            .filter(HrDocument.employee_id == emp.id, HrDocument.kind == "id",
                    or_(func.coalesce(HrDocument.expires_on, "") == "", HrDocument.expires_on >= today))
            .first()) is not None


def _sig_work_auth(db, emp, arg):
    c = emp.compliance or {}
    exp = str(c.get("expiryDate") or "")[:10]
    return c.get("status") == "verified" and (not exp or exp >= _today().isoformat())


def _consent(key):
    return lambda db, emp, arg: bool(((emp.compliance or {}).get("consents") or {}).get(key))


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
    "id_on_file": _sig_id_on_file,
    "work_auth_verified": _sig_work_auth,
    "consent_background": _consent("bgCheck"),
    "consent_handbook": _consent("handbook"),
    # HR confirmed the probation on the profile (hr_probation.py, Oct 27 2026).
    "probation_confirmed": lambda db, emp, arg: (emp.probation or {}).get("status") == "confirmed",
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
    "id_on_file": "An ID document is on file (Documents tab, not expired)",
    "work_auth_verified": "Work authorization is Verified on the Compliance tab (not expired)",
    "consent_background": "Background check consent is ticked on the Compliance tab",
    "consent_handbook": "Handbook acknowledgment is ticked on the Compliance tab",
    "probation_confirmed": "Probation is Confirmed on the profile",
}

# The envelope conditions the editor offers by name.
SIGNAL_PRESETS = {
    "envelope:offer,contractor_agreement": "The signed offer letter (or contractor agreement) is on file",
    "envelope:nda,handbook_ack": "The signed hiring packet is on file",
    "envelope:promotion": "The signed promotion letter is on file",
}


def _signal_met(db, emp, sig: str, item_id: str = "") -> bool:
    fn = SIGNALS.get(signal_name(sig))
    if fn is None:
        return False
    try:
        return bool(fn(db, emp, sig.split(":", 1)[1] if ":" in sig else ""))
    except Exception as e:   # noqa: BLE001 - one bad signal never stops the rest
        print(f"[checklists] signal {sig} failed on {item_id}: {e}")
        return False


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
    if cl.kind == "onboarding" and not cl.audit:     # an audit counts from the audit
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
    #    Any one of a step's conditions is enough; the step keeps which one.
    for it in items:
        if it.status != "open":
            continue
        hit = next((sig for sig in signal_list(it.signal) if _signal_met(db, emp, sig, it.id)), None)
        if hit:
            it.status, it.done_by, it.done_at = "done", "Nexus", _now()
            it.done_reason = signal_label(hit)
            changed = True

    if items and all(it.status in ("done", "na") for it in items):
        cl.status, cl.closed_at = "done", _now()
        changed = True
    return changed


# --- Tasks -----------------------------------------------------------------
# ONE task per checklist (Neil, Oct 22: "I don't want it to be 100 tasks...
# It should create a task inside [#General - Human Resources] called
# Onboarding - <name>... the assignee should be the main HR manager. And then
# the individual subtasks will get assigned to the correct people"):
#   the parent  "Onboarding - Jane Doe", assigned to the company's head of HR,
#               in the company's checklist place (task_place): project + section
#   a subtask   per step, assigned to that step's owners - on their My Tasks
#   step done / N/A        -> its subtask completes (sync_tasks)
#   subtask completed      -> its step is done (task_completed)
#   subtask reopened       -> its step reopens
#   parent completed       -> every step still open is done (HR closes any step)
#   no step left open      -> the parent completes; one coming back reopens it
# HrChecklist.task_id is the parent; HrChecklistItem.task_id the step's subtask
# (a subtask's project is its parent's - task_util.project_for_task).
# Checklists started Oct 20-22 had a parent PER OWNER: their next sync moves
# every subtask under the one parent and bins the emptied old parents.

PLACE_KEY = "hr_checklist_task_place:"   # + entity id -> {"default": {projectId, sectionId}, "<kind>": {...}}
PLACE_KINDS = ("default",) + KINDS


def _key(emails) -> str:
    """One owner set as a comparable string."""
    return ",".join(sorted(email_list(emails)))


def auto_project(db, entity_id: str):
    """The company's general HR project, found by itself when no place is set:
    a project of its HR department named "#General...", else one whose name
    says Human Resources, else the group's Human Resources project (another
    company's). None when there is no such project."""
    import models
    from routers.task_util import row_company
    if not entity_id:
        return None
    dept = owner_departments(db, entity_id).get("hr")

    def score(p):
        name = (p.name or "").strip().lower()
        mine = dept is not None and (p.hr_department_id or "") == dept.id
        if not mine and not ("human resources" in name and row_company(db, p) == entity_id):
            return 0
        return 4 * mine + 2 * name.startswith("#general") + ("human resources" in name)

    # One HR team runs every company from one project (Neil's "#General - Human
    # Resources"): a company with no HR project of its own uses the group's.
    def group(p):
        name = (p.name or "").strip().lower()
        return ("human resources" in name) * (1 + name.startswith("#general"))

    projects = db.query(models.TaskProject).filter(models.TaskProject.archived.isnot(True)).order_by(models.TaskProject.created_at).all()
    for rank in (score, group):
        best, top = None, 0
        for p in projects:
            s = rank(p)
            if s > top:
                best, top = p, s
        if best is not None:
            return best
    return None


def task_place(db, entity_id: str, kind: str) -> dict:
    """Where a checklist's task goes: {projectId, sectionId, source} - the
    company's setting for the kind, else its one-for-all default, else the
    auto-detected HR project, else nowhere ('none')."""
    import models
    raw = _setting_json(db, PLACE_KEY + entity_id) if entity_id else {}
    want = raw.get(kind) or raw.get("default") or {}
    pid = str(want.get("projectId") or "") if isinstance(want, dict) else ""
    proj = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first() if pid else None
    if proj is not None and not proj.archived:
        sec = str(want.get("sectionId") or "")
        if sec and db.query(models.TaskSection.id).filter(models.TaskSection.id == sec,
                                                          models.TaskSection.project_id == pid).first() is None:
            sec = ""
        return {"projectId": pid, "sectionId": sec, "source": "set"}
    auto = auto_project(db, entity_id)
    if auto is not None:
        return {"projectId": auto.id, "sectionId": "", "source": "auto"}
    return {"projectId": "", "sectionId": "", "source": "none"}


def hr_lead(db, cl: HrChecklist, emp: NexusEmployee) -> list:
    """Who the checklist's task is assigned to: the head of the company's HR
    department, else the first HR owner (backup, Role Owners, HR contact),
    else the Global Admins - never nobody."""
    d = owner_departments(db, cl.company).get("hr")
    lead = active_people(db, [d.lead_email]) if d is not None else []
    if lead:
        return lead
    entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
    return resolve_owners(db, "hr", emp, role_owners(db, cl.company), entity)[:1]


def sub_title(it: HrChecklistItem, emp: NexusEmployee) -> str:
    """A step's subtask names whose checklist it is ("Laptop Shipped - Jane
    Doe"): an IT owner who cannot open HR's parent task still reads it on
    their My Tasks."""
    return f"{it.title} - {full_name(emp)}" if full_name(emp) else it.title


def _new_task(db, cl: HrChecklist, owners: list, title: str, desc: str, due: str, by: str, parent_id: str = "",
              project_id: str = "", section_id: str = "", owner: str = ""):
    import models
    from routers.task_util import set_task_assignees
    from routers.tasks import _next_code
    now = _now()
    t = models.Task(
        id=str(uuid.uuid4()), code=_next_code(db), company_id=cl.company or "", title=title,
        description=desc, type="task", status="not_started", priority="medium",
        position=datetime.now().timestamp(), assignee_email="", assignee_emails=[],
        owner_email=(owner or by or "nexus").lower(), follower_emails=[], liked_by_emails=[],
        access_level="restricted", project_id=project_id or "", project_ids=[], section_id=section_id or "", team_id="",
        parent_task_id=parent_id, subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={},
        tags=[], custom_field_values={}, start_on="", due_on=due, approval_status="none",
        completed=False, completed_at="", comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=(by or "nexus").lower(), hr_checklist=True)
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
    desc = (f"{full_name(emp)}'s {label.lower()} checklist. Each step is a subtask assigned to whoever does it, "
            f"so it is on their My Tasks; completing a subtask marks that step done on the checklist (and ticking "
            f"the step on the checklist completes it here). Completing this task marks every step still open done. "
            f"{n} step{'s' if n != 1 else ''} open.")
    return f"{label} - {full_name(emp)}", desc


def sync_tasks(db, cl: HrChecklist, emp: NexusEmployee = None, by: str = "nexus", first: bool = False,
               exclude_ids=()) -> list:
    """Bring the checklist's task in line with it: ONE parent (made in the
    company's checklist place, assigned to the head of HR), a subtask per step
    assigned to the step's owners (moved when a step is reassigned), each
    completed exactly when its step / every step is closed. Returns the ids of
    new tasks worth an "assigned" email - the parent and, per owner, their
    first new subtask - for the caller to send after commit. Only checklists
    started with tasks (`first`, from start()) get them - the ones open
    before Oct 19 are left as they were, never a burst of tasks. `exclude_ids`:
    tasks whose field history the caller records itself (the task or batch a
    Tasks edit is saving - task_history.record_edit), so a change is not told
    twice."""
    import models
    import task_history
    from routers.task_util import set_task_assignees, task_assignees
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    if emp is None or not items or not (first or cl.task_id or any(i.task_id for i in items)):
        return []
    ids = {i.task_id for i in items if i.task_id}
    subs = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(list(ids)))} if ids else {}
    parent = db.query(models.Task).filter(models.Task.id == cl.task_id).first() if cl.task_id else None
    # The per-owner parents of a checklist started Oct 20-22.
    old_ids = {t.parent_task_id for t in subs.values() if t.parent_task_id} - {cl.task_id or ""}
    legacy = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(list(old_ids)))} if old_ids else {}
    # Field history (Oct 22 2026): what this sync changes on tasks that
    # already existed is recorded under `by`, due dates included.
    skip = set(exclude_ids or ())
    known = [*subs.values(), *legacy.values(), *([parent] if parent is not None else [])]
    hist_before = {t.id: (t, task_history.snapshot(t)) for t in known if t.id not in skip}
    for t in known:
        if not getattr(t, "hr_checklist", False):
            t.hr_checklist = True             # marks the checklist's tasks (Move To leaves them alone)
    live = cl.status == "open"
    created, now = [], _now()
    rows = sorted(items, key=lambda x: (x.sort_order or 0))
    open_rows = sorted([i for i in rows if i.status == "open"], key=lambda x: (x.due_date or "9999-12-31", x.sort_order or 0))
    if parent is None and not (live and any(owners_of(i) for i in open_rows)):
        # Nothing to do (or a closed checklist that kept its old per-owner
        # tasks - their history stays where it is): whatever is open closes.
        for t in [*subs.values(), *legacy.values()]:
            _set_done(t, True)
    else:
        lead = hr_lead(db, cl, emp)
        # The head of HR owns every task of the checklist: they see each
        # subtask even with no project to share it through (an owner is not
        # emailed, so this costs them no mail).
        head = lead[0] if lead else ""
        if parent is None:
            title, desc = _parent_text(cl, emp, open_rows)
            place = task_place(db, cl.company or "", cl.kind)
            parent = _new_task(db, cl, lead, title, desc, open_rows[0].due_date or "", by,
                               project_id=place["projectId"], section_id=place["sectionId"], owner=head)
            cl.task_id = parent.id
            created.append(parent.id)
        elif not parent.project_id:
            # Made before its company had a place (Oct 23: Maria Lopez): placed
            # now; one that has a project is only ever moved by move_open_tasks.
            place = task_place(db, cl.company or "", cl.kind)
            if place["projectId"]:
                parent.project_id, parent.section_id, parent.modified_at = place["projectId"], place["sectionId"], now
        kids = [k for k in (parent.subtask_ids or []) if k]
        first_new = {}
        for it in rows:
            people = owners_of(it)
            sub = subs.get(it.task_id)
            if sub is None:
                if not people or (it.status != "open" and not it.task_id):
                    continue                  # nobody to do it yet, or closed before it had a subtask
                sub = _new_task(db, cl, people, sub_title(it, emp), it.hint or "", it.due_date or "", by, parent_id=parent.id,
                                owner=head)
                subs[sub.id] = sub
                it.task_id = sub.id
                if live and it.status == "open" and _key(people) != _key(lead):
                    first_new.setdefault(_key(people), sub.id)
            else:
                if people and _key(task_assignees(sub)) != _key(people):
                    set_task_assignees(sub, people)      # reassigned: the subtask follows the step
                    sub.modified_at = now
                if sub.parent_task_id != parent.id:      # an old per-owner parent's: moved under the one
                    old = legacy.get(sub.parent_task_id)
                    if old is not None:
                        old.subtask_ids = [x for x in (old.subtask_ids or []) if x != sub.id]
                    # A new parent: no longer private because of the old one.
                    sub.parent_task_id, sub.narrowed_by, sub.modified_at = parent.id, "", now
            if (sub.due_on or "") != (it.due_date or ""):
                sub.due_on, sub.modified_at = it.due_date or "", now
            if head and (sub.owner_email or "").lower() != head:
                sub.owner_email = head
            _set_done(sub, it.status != "open" or not live)
            if sub.id not in kids:
                kids.append(sub.id)
        parent.subtask_ids = kids
        title, desc = _parent_text(cl, emp, open_rows)
        due = next((r.due_date for r in open_rows if r.due_date), "")
        if (parent.title, parent.description, parent.due_on or "") != (title, desc, due):
            parent.title, parent.description, parent.due_on, parent.modified_at = title, desc, due, now
        if lead and _key(task_assignees(parent)) != _key(lead):
            set_task_assignees(parent, lead)             # a new head of HR
            parent.owner_email, parent.modified_at = head, now
        _set_done(parent, not (live and open_rows))
        created += list(first_new.values())
        # The emptied per-owner parents were Nexus's own containers: binned,
        # never touched while a closed checklist's history needs them.
        for old in legacy.values():
            if live and not [k for k in (old.subtask_ids or []) if k] and not old.deleted_at:
                old.deleted_at, old.deleted_by, old.modified_at = now, "nexus", now
    for t, before in hist_before.values():
        task_history.record(db, t, before, by, with_due=True)
    return created


def move_open_tasks(db, entity_id: str, by: str) -> int:
    """The place for a company's checklist tasks changed (Pranshu, Oct 22:
    "what if I want to change the task location for the checklist in
    future?"): every OPEN checklist's task there moves to the place for its
    kind; the subtasks come along, as they live under it. Returns how many
    moved. Caller commits."""
    import models
    import task_history
    n = 0
    for cl in db.query(HrChecklist).filter(HrChecklist.status == "open", HrChecklist.company == entity_id,
                                           func.coalesce(HrChecklist.task_id, "") != "").all():
        p = db.query(models.Task).filter(models.Task.id == cl.task_id).first()
        if p is None:
            continue
        place = task_place(db, entity_id, cl.kind)
        if ((p.project_id or ""), (p.section_id or "")) != (place["projectId"], place["sectionId"]):
            before = task_history.snapshot(p)
            p.project_id, p.section_id, p.modified_at = place["projectId"], place["sectionId"], _now()
            task_history.record(db, p, before, by)
            n += 1
    return n


def task_info(db, cl: HrChecklist) -> dict:
    """Where the checklist's task lives, for its card: None until it has one."""
    import models
    if not cl.task_id:
        return None
    t = db.query(models.Task).filter(models.Task.id == cl.task_id).first()
    if t is None:
        return None
    proj = db.query(models.TaskProject).filter(models.TaskProject.id == t.project_id).first() if t.project_id else None
    sec = db.query(models.TaskSection).filter(models.TaskSection.id == t.section_id).first() if t.section_id else None
    return {"id": t.id, "title": t.title, "projectId": t.project_id or "", "projectName": proj.name if proj else "",
            "sectionName": sec.name if sec else "", "completed": bool(t.completed)}


def task_due_changed(db, task, by: str, exclude_ids=None) -> bool:
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
            sync_tasks(db, cl, by=(by or "").lower(),     # the parent's date is its earliest open step
                       exclude_ids={task.id} if exclude_ids is None else exclude_ids)
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


def task_completed(db, task, done: bool, by: str, exclude_ids=None) -> bool:
    """Tasks told us a checklist task was completed or reopened (update_task /
    bulk_update, after the change landed). Mirrors it onto the steps. Returns
    True when it was a checklist task. The caller commits. `exclude_ids` are
    the tasks the caller records the field history of (default: `task`)."""
    import models
    if task is None:
        return False
    if task.parent_task_id:
        step = db.query(HrChecklistItem).filter(HrChecklistItem.task_id == task.id).first()
        steps = [step] if step is not None else []
    else:
        own = db.query(HrChecklist).filter(HrChecklist.task_id == task.id).first()
        if own is not None:                   # the checklist's ONE task: HR closing it closes every step
            steps = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == own.id).all()
        else:                                 # an old per-owner parent: that owner's steps
            kid_ids = [k for k in (task.subtask_ids or []) if k]
            steps = (db.query(HrChecklistItem).filter(HrChecklistItem.task_id.in_(kid_ids)).all() if kid_ids else [])
        if not done:
            return bool(steps)                # reopening the parent changes no step
    if not steps:
        return False
    cl = db.query(HrChecklist).filter(HrChecklist.id == steps[0].checklist_id).first()
    if cl is None or cl.status == "cancelled":
        return True
    import task_history
    who, now = (by or "").lower(), _now()
    skip = {task.id} if exclude_ids is None else set(exclude_ids)
    for it in steps:
        if done and it.status == "open":
            it.status, it.done_by, it.done_at, it.done_reason = "done", who, now, ""
        elif not done and it.status == "done":
            it.status, it.done_by, it.done_at, it.done_reason = "open", "", "", ""
    if not task.parent_task_id and done:
        for sub in db.query(models.Task).filter(models.Task.id.in_([s.task_id for s in steps if s.task_id])).all():
            # Field history (Oct 22 2026): the step's subtask closes with its
            # parent - recorded here, from before the close (sync_tasks below
            # only sees what it changes itself).
            sub_before = task_history.snapshot(sub)
            _set_done(sub, True)
            if sub.id not in skip:
                task_history.record(db, sub, sub_before, who)
    db.flush()
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    _close_if_done(cl, items)
    sync_tasks(db, cl, by=who, exclude_ids=skip)
    return True


# --- Serializers -----------------------------------------------------------

def ser_item(it: HrChecklistItem, names: dict = None, comments: list = None) -> dict:
    today = _today().isoformat()
    owners = owners_of(it)
    return {
        "id": it.id, "checklistId": it.checklist_id, "key": it.key, "phase": it.phase,
        "title": it.title, "hint": it.hint,
        "ownerRole": it.owner_role, "ownerRoleLabel": ROLE_LABELS.get(it.owner_role) or (names or {}).get(it.owner_role) or it.owner_role,
        "ownerEmail": it.owner_email,
        "ownerName": ", ".join((names or {}).get(e, "") or e for e in owners) if len(owners) > 1 else (names or {}).get(it.owner_email, ""),
        "ownerEmails": owners,
        "ownerManual": bool(it.owner_manual),
        "anchor": it.anchor, "offset": it.offset, "businessDays": bool(it.business_days),
        "dueDate": it.due_date, "dueManual": bool(it.due_manual),
        "overdue": bool(it.status == "open" and it.due_date and it.due_date < today),
        "signal": it.signal,
        "signals": [{"value": x, "label": signal_label(x)} for x in signal_list(it.signal)],
        "signalLabel": " or ".join(signal_label(x) for x in signal_list(it.signal)),
        "status": it.status, "doneBy": it.done_by, "doneAt": it.done_at, "note": it.note,
        "doneReason": it.done_reason or "",
        "comments": comments or [], "sortOrder": it.sort_order,
    }


def ser_checklist(cl: HrChecklist, items: list, names: dict = None, comments: dict = None,
                  role_people: dict = None, task: dict = None) -> dict:
    done = sum(1 for i in items if i.status in ("done", "na"))
    today = _today().isoformat()
    return {
        "id": cl.id, "employeeId": cl.employee_id, "kind": cl.kind,
        "kindLabel": KIND_LABELS.get(cl.kind, cl.kind), "company": cl.company,
        "anchorDate": cl.anchor_date, "exitType": cl.exit_type, "status": cl.status, "audit": bool(cl.audit),
        "createdBy": cl.created_by, "createdAt": cl.created_at, "closedAt": cl.closed_at,
        "total": len(items), "done": done,
        "overdue": sum(1 for i in items if i.status == "open" and i.due_date and i.due_date < today),
        "items": [ser_item(i, names, (comments or {}).get(i.id)) for i in sorted(items, key=lambda x: x.sort_order or 0)],
        # {role: [emails]} - who holds each role for this person today; Change
        # Owner lists them first (Pranshu, Oct 20).
        "roleOwners": role_people or {},
        # Its one task and where it lives (task_info) - None until it has one.
        "task": task,
    }


def role_people(db, cl: HrChecklist, emp: NexusEmployee = None) -> dict:
    emp = emp or db.query(NexusEmployee).filter(NexusEmployee.id == cl.employee_id).first()
    if emp is None:
        return {}
    owners = role_owners(db, cl.company)
    entity = db.query(HrEntity).filter(HrEntity.id == cl.company).first() if cl.company else None
    roles = [*ROLES, *{i.owner_role for i in db.query(HrChecklistItem.owner_role)
                       .filter(HrChecklistItem.checklist_id == cl.id) if (i.owner_role or "").startswith(DEPT_PREFIX)}]
    return {r: resolve_owners(db, r, emp, owners, entity) for r in roles}


def name_map(db, emails) -> dict:
    """{email: name}; a "dept:<id>" owner role in the list maps to the
    department's name (ser_item's ownerRoleLabel)."""
    emails = {e for e in emails if e}
    if not emails:
        return {}
    depts = {e for e in emails if e.startswith(DEPT_PREFIX)}
    rows = (db.query(NexusEmployee)
            .filter(func.lower(NexusEmployee.work_email).in_(list(emails - depts))).all())
    return {**{(r.work_email or "").lower(): full_name(r) for r in rows}, **{r: role_label(db, r) for r in depts}}


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
                reconcile(db, cl, emp)       # a template change missed by a save (safety net)
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
