"""HR life events through Nexus Sign (Neil/Pranshu call, Oct 8): the hiring
packet first, promotion and separation on the same engine.

    HR starts it from the person -> the company's packet template (merged PDFs,
    set per company in hr_packet_settings) is filled from what HR entered ->
    HR signs at send, the person signs LAST -> when it is fully signed the
    change is applied (a hire becomes an employee) -> the sealed packet is
    filed in the person's own Egnyte folder, the same folder My HR > My
    Documents already shows them.

Nexus Sign drives the record through HrSignRequest.link_kind 'life_event'
(routers/esign.py _link_hook), exactly as timesheet_review.py does for
timesheets. Rules this module keeps:

  - A hook NEVER breaks a signature: every callback runs in a SAVEPOINT and
    is swallowed on error (safe()), so a bug here rolls back only its own
    writes, never the signer's.
  - Applying is idempotent: a completion seen twice is one hire.
  - Egnyte is never called inside the signing request. The hire's folder
    cannot exist before the packet is signed, and Egnyte can be slow or down,
    so completion only queues the filing (filing_status 'pending'); the
    filing pass (process_due, run off the event loop by life_events_loop)
    creates the folder and uploads, retrying with backoff, and tells HR if it
    finally cannot.
  - Pay is salary data: stored on the event and the employee's compensation
    only, returned to hr_comp holders only, never written to a log line.
"""
import asyncio
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from models import (HrCandidate, HrEntity, HrLifeEvent, HrPacketSetting, HrSignParty,
                    HrSignRequest, HrSignTemplate, HrStageEvent, NexusEmployee)

EVENTS = ("hire", "promotion", "separation")
WORKER_TYPES = ("any", "employee", "contractor")
ACTIVE = ("awaiting_sender", "sent")
EVENT_TITLES = {"hire": "Hiring Packet", "promotion": "Promotion Letter",
                "separation": "Separation Package"}
DEFAULT_SUBFOLDERS = {"hire": "Hiring Documents", "promotion": "Promotion Documents",
                      "separation": "Separation Documents"}
PAY_BASES = ("hourly", "salary")
PAY_FREQUENCIES = ("weekly", "biweekly", "semimonthly", "monthly", "annual")
CURRENCIES = ("USD", "INR")
# Minutes to wait before each filing retry; past the end the event is marked
# failed and HR is told (a missing entity folder needs a person, not a retry).
FILING_BACKOFF_MIN = (1, 5, 15, 60, 180, 360)
LOOP_EVERY_SEC = 60
# "Last day" and "today" are calendar days where the company works, not UTC:
# at 6 PM in California it is already tomorrow in UTC, and an offboarding
# dated tomorrow must not become "immediate" at dinner time.
BUSINESS_TZ = "America/Los_Angeles"
APPLY_FAILED = "apply_failed"      # flags[].code when a signed packet could not be applied


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe(fn, *a, **kw) -> None:
    """Run a Nexus Sign callback in a SAVEPOINT. An error rolls back only what
    the callback wrote and is logged - the signature it rides on stands.

    It is NOT silent about it: a failure is written onto the event (flag
    `apply_failed`, the reason in apply_note) and the sender gets a priority
    notification with a Retry. A packet that was signed but never applied
    - the hire that never became an employee - is exactly the broken piece
    nobody would notice otherwise."""
    db, req = a[0], a[1]
    sp = db.begin_nested()
    try:
        fn(*a, **kw)
        sp.commit()
        return
    except Exception as e:   # logged, never raised
        sp.rollback()
        msg = f"{type(e).__name__}: {str(e)[:300]}"
        print(f"[life-events] {getattr(fn, '__name__', fn)} failed: {msg}")
    try:
        sp = db.begin_nested()
        ev = _for(db, req)
        if ev is not None:
            what = {"on_completed": "apply the signed packet", "on_progress": "record the signature",
                    "on_declined": "record the decline", "on_voided": "record the void",
                    "on_expired": "record the expiry"}.get(getattr(fn, "__name__", ""), "update the record")
            ev.flags = [f for f in (ev.flags or []) if f.get("code") != APPLY_FAILED] + [
                {"code": APPLY_FAILED, "event": getattr(fn, "__name__", "")[3:], "message": msg, "at": _now()}]
            ev.apply_note = f"Nexus could not {what}: {msg}"
            ev.updated_at = _now()
            _notify(db, ev.created_by, f"Needs attention - {EVENT_TITLES.get(ev.kind, 'packet')} for {ev.subject_name}",
                    f"The signatures are safe in Nexus Sign, but Nexus could not {what} ({msg}). "
                    f"Open the person and use Retry; if it keeps failing, send this message to support.",
                    ev, priority=1)
        sp.commit()
    except Exception as e2:   # pragma: no cover - the record of the failure failed too
        sp.rollback()
        print(f"[life-events] could not record the failure: {type(e2).__name__}: {e2}")


# ── small helpers ────────────────────────────────────────────────────────────

def us_long_date(iso: str) -> str:
    """'2026-10-09' -> 'October 9, 2026' - the form a letter prints (matches
    Nexus Sign's {{today}})."""
    try:
        d = datetime.strptime((iso or "")[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def us_date(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def worker_type_of(employment_type: str) -> str:
    return "contractor" if (employment_type or "") == "contractor" else "employee"


def pay_text(pay: dict) -> str:
    """'$85,000.00 per year' / '$32.50 per hour' - the {{salary}} a letter shows."""
    if not pay or pay.get("base") in (None, ""):
        return ""
    sym = {"USD": "$", "INR": "₹"}.get(pay.get("currency") or "USD", "")
    try:
        amount = f"{sym}{float(pay['base']):,.2f}"
    except (TypeError, ValueError):
        return ""
    if pay.get("payBasis") == "hourly":
        return f"{amount} per hour"
    per = {"weekly": "per week", "biweekly": "every two weeks", "semimonthly": "twice a month",
           "monthly": "per month", "annual": "per year"}.get(pay.get("frequency") or "annual", "")
    return f"{amount} {per}".strip()


def pay_in_letter(tpl) -> bool:
    """Whether the template's letter prints the pay HR types ({{salary}} in
    its body). Pay typed for a template that never shows it is stored and
    applied but the person never reads it - the preview says so (Pranshu,
    Oct 8)."""
    return any("{{salary}}" in str(p) for p in (tpl.body or []))


def _safe_name(s: str, limit: int = 80) -> str:
    return re.sub(r'[\\/:*?"<>|]+', " ", s or "").strip()[:limit] or "Document"


def person_name(db: Session, email: str) -> str:
    email = (email or "").lower()
    e = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first() if email else None
    if e:
        return (e.display_name or f"{e.first_name} {e.last_name}").strip()
    return email.split("@")[0].replace(".", " ").title()


def clean_pay(pay: Optional[dict]) -> dict:
    """Validated pay block, or {} for none. Raises ValueError with a message
    a person can act on."""
    if not pay or pay.get("base") in (None, ""):
        return {}
    try:
        base = round(float(pay.get("base")), 2)
    except (TypeError, ValueError):
        raise ValueError("Pay must be a number.")
    if base <= 0:
        raise ValueError("Pay must be more than zero.")
    basis = pay.get("payBasis") or "salary"
    if basis not in PAY_BASES:
        raise ValueError("Pay basis must be hourly or salary.")
    freq = pay.get("frequency") or ("annual" if basis == "salary" else "")
    if basis == "salary" and freq not in PAY_FREQUENCIES:
        raise ValueError(f"Pay frequency must be one of {', '.join(PAY_FREQUENCIES)}.")
    cur = pay.get("currency") or "USD"
    if cur not in CURRENCIES:
        raise ValueError(f"Currency must be one of {', '.join(CURRENCIES)}.")
    return {"base": base, "payBasis": basis, "frequency": freq if basis == "salary" else "",
            "currency": cur}


def compensation_from_pay(pay: dict, effective: str) -> dict:
    """The employee's compensation record (Pay & Benefits shape) from an
    offer's pay. Annual is stored as monthly, the coarsest frequency the
    timecard's sync_rate_from_comp understands."""
    base, freq = pay["base"], pay.get("frequency") or ""
    if pay["payBasis"] == "salary" and freq == "annual":
        base, freq = round(base / 12, 2), "monthly"
    return {"base": base, "payBasis": pay["payBasis"], "frequency": freq,
            "currency": pay.get("currency") or "USD", "effectiveDate": effective, "history": []}


# ── packet settings ──────────────────────────────────────────────────────────

def resolve_setting(db: Session, entity_id: str, event: str, worker_type: str) -> Optional[HrPacketSetting]:
    """The packet a company sends for an event, most specific first: this
    company + this worker type, this company + any, default + worker type,
    default + any. A row without a template does not count."""
    for ent, wt in ((entity_id, worker_type), (entity_id, "any"), ("", worker_type), ("", "any")):
        if ent is None:
            continue
        row = (db.query(HrPacketSetting)
               .filter(HrPacketSetting.entity_id == (ent or ""), HrPacketSetting.event == event,
                       HrPacketSetting.worker_type == wt, HrPacketSetting.template_id != "")
               .first())
        if row:
            return row
    return None


def template_roles(tpl: HrSignTemplate) -> list:
    return sorted([r for r in (tpl.roles or []) if r.get("key")], key=lambda r: r.get("order") or 1)


def setting_problems(db: Session, s: HrPacketSetting) -> list:
    """Why a packet setting would fail at send - shown on the settings screen
    and enforced at save, so HR finds out while configuring, not while a new
    hire is waiting."""
    if s.event not in EVENTS:
        return [f"Event must be one of {', '.join(EVENTS)}."]
    if s.worker_type not in WORKER_TYPES:
        return [f"Worker type must be one of {', '.join(WORKER_TYPES)}."]
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == s.template_id).first() if s.template_id else None
    if not tpl:
        return ["Pick the Nexus Sign template this packet sends."]
    out = []
    if (tpl.status or "active") != "active":
        out.append(f"The template \"{tpl.name}\" is archived.")
    if tpl.entity_id and s.entity_id and tpl.entity_id != s.entity_id:
        out.append(f"The template \"{tpl.name}\" belongs to a different company.")
    roles = template_roles(tpl)
    keys = [r["key"] for r in roles]
    if s.subject_role not in keys:
        out.append(f"The template has no \"{s.subject_role}\" role for the person to sign as "
                   f"(its roles: {', '.join(keys) or 'none'}).")
    elif s.event in ("hire", "separation") and roles[-1]["key"] != s.subject_role:
        # Pranshu, Oct 8: the company signs at send; the person signs last.
        out.append(f"The person must sign last - move the \"{s.subject_role}\" role to the end "
                   f"of the template's signing order.")
    return out


def ser_setting(db: Session, s: HrPacketSetting) -> dict:
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == s.template_id).first() if s.template_id else None
    return {"id": s.id, "entityId": s.entity_id or "", "event": s.event, "workerType": s.worker_type,
            "templateId": s.template_id or "", "templateName": tpl.name if tpl else "",
            "subjectRole": s.subject_role or "employee", "emailMessage": s.email_message or "",
            "egnyteSubfolder": s.egnyte_subfolder or "",
            "effectiveSubfolder": (s.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS.get(s.event, ""),
            "problems": setting_problems(db, s), "updatedBy": s.updated_by or "",
            "updatedAt": s.updated_at or ""}


# ── serialization ────────────────────────────────────────────────────────────

def ser_event(db: Session, ev: HrLifeEvent, *, show_pay: bool) -> dict:
    req = (db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
           if ev.sign_request_id else None)
    parties = []
    if req:
        for p in (db.query(HrSignParty).filter(HrSignParty.request_id == req.id)
                  .order_by(HrSignParty.ordinal).all()):
            parties.append({"id": p.id, "name": p.name, "email": p.email, "status": p.status, "role": p.role_key,
                            "order": p.ordinal, "signedAt": p.signed_at or "",
                            "isSubject": p.email == (ev.subject_email or "").lower()})
    # A promotion carries the pay BEFORE the change in inputs (old_pay) so its
    # email can say what it went up by - salary data, hr_comp holders only.
    inputs = {k: v for k, v in (ev.inputs or {}).items() if show_pay or k != "old_pay"}
    out = {
        "id": ev.id, "kind": ev.kind, "title": EVENT_TITLES.get(ev.kind, ev.kind),
        "status": ev.status, "entityId": ev.entity_id, "candidateId": ev.candidate_id,
        "employeeId": ev.employee_id, "subjectName": ev.subject_name, "subjectEmail": ev.subject_email,
        "templateId": ev.template_id, "signRequestId": ev.sign_request_id,
        "inputs": inputs, "effectiveDate": ev.effective_date or "",
        "appliedAt": ev.applied_at or "", "applyNote": ev.apply_note or "", "flags": ev.flags or [],
        "filingStatus": ev.filing_status or "", "filingPath": ev.filing_path or "",
        "filingError": ev.filing_error or "", "filingAttempts": ev.filing_attempts or 0,
        "declineReason": ev.decline_reason or "", "createdBy": ev.created_by,
        "createdAt": ev.created_at, "completedAt": ev.completed_at or "", "parties": parties,
        "hasPay": bool(ev.pay), "applyStatus": ev.apply_status or "",
    }
    if show_pay:
        out["pay"] = ev.pay or {}
    return out


# ── the hiring packet ────────────────────────────────────────────────────────

class PacketError(ValueError):
    """A send that cannot go out, with the message HR should read."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _company_role(db: Session, company: str, role_id: str):
    from models import NexusGroup
    r = db.query(NexusGroup).filter(NexusGroup.id == role_id, NexusGroup.is_job_role == 1).first()
    if not r or ((r.company_id or "") and (r.company_id or "") != (company or "")):
        return None
    return r


def _role_named(db: Session, company: str, name: str):
    """An existing role of this company (or a shared one) with that name -
    "Other" never creates a duplicate of a role that already exists."""
    from models import NexusGroup
    want = (name or "").strip().lower()
    for r in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).all():
        if (r.name or "").strip().lower() == want and (r.company_id or "") in ("", company or ""):
            return r
    return None


def _hire_details(db: Session, cand: HrCandidate, inputs: dict) -> dict:
    """The offer HR entered, validated, falling back to the candidate card.
    The job title is one of the hiring company's roles (Pranshu, Oct 8) - the
    role decides the title and department and, once they have a work email,
    their access. "Other" names a role the company doesn't have yet: it is
    added to the company's roles at send, with no access until an
    administrator sets it."""
    role_id = (inputs.get("role_id") or "").strip()
    new_role = (inputs.get("new_role_name") or "").strip()[:120]
    role = None
    if role_id:
        role = _company_role(db, cand.company, role_id)
        if not role:
            raise PacketError("That role is not one of this company's roles - pick another or choose Other.")
    elif new_role:
        role = _role_named(db, cand.company, new_role)      # typed a role that already exists
    elif cand.role_id:
        role = _company_role(db, cand.company, cand.role_id)
    d = {
        "role_id": role.id if role else "",
        "new_role_name": "" if role else new_role,
        "job_title": (role.name if role else (new_role or inputs.get("job_title") or cand.role_title or "")).strip(),
        "department": ((role.department if role and role.department else "")
                       or inputs.get("department") or cand.department or "").strip(),
        "start_date": (inputs.get("start_date") or cand.expected_start or "").strip()[:10],
        # The offer stands until this day (inclusive); after it the signing
        # link is dead and the packet reads Expired (Pranshu, Oct 8).
        "offer_expires": (inputs.get("offer_expires") or "").strip()[:10],
        "manager_email": (inputs.get("manager_email") or "").strip().lower(),
        "employment_type": (inputs.get("employment_type") or "full_time").strip(),
        "salary_text": (inputs.get("salary_text") or "").strip(),
        "merge": {k: str(v).strip() for k, v in (inputs.get("merge") or {}).items()
                  if re.fullmatch(r"[a-z0-9_]+", str(k)) and str(v).strip()},
    }
    from routers.hr import _EMPLOYMENT_TYPES
    if not d["job_title"]:
        raise PacketError("Pick the job title - one of the company's roles, or Other.")
    if d["new_role_name"] and not d["department"]:
        raise PacketError("Pick the department for the new role.")
    if not d["start_date"]:
        raise PacketError("Enter the start date for the offer.")
    try:
        datetime.strptime(d["start_date"], "%Y-%m-%d")
    except ValueError:
        raise PacketError("The start date is not a valid date.")
    if d["employment_type"] not in _EMPLOYMENT_TYPES:
        raise PacketError(f"Employment type must be one of {', '.join(_EMPLOYMENT_TYPES)}.")
    if not d["offer_expires"]:
        raise PacketError("Enter the date the offer expires - the signing link stops working after it.")
    try:
        datetime.strptime(d["offer_expires"], "%Y-%m-%d")
    except ValueError:
        raise PacketError("The offer expiry is not a valid date.")
    if d["offer_expires"] < _today():
        raise PacketError("The offer expiry must be today or later.")
    if d["offer_expires"] > d["start_date"]:
        raise PacketError("The offer must expire on or before the start date.")
    if d["manager_email"]:
        # People pickers are the curated Nexus People list - never a free email.
        if not db.query(NexusEmployee).filter(NexusEmployee.work_email == d["manager_email"]).first():
            raise PacketError("The supervisor must be someone in Nexus People.")
    return d


def create_company_role(db: Session, company: str, name: str, department: str, by: str, for_name: str):
    """Add a role the company didn't have yet (an offer's "Other"). It is created
    with NO access - a role's access is an administrator's decision - and
    everyone who can set it is told, so nobody is left wondering why the new
    hire can't open anything."""
    from models import NexusGroup, NexusRole
    existing = _role_named(db, company, name)
    if existing:
        return existing
    entity = db.query(HrEntity).filter(HrEntity.id == company).first() if company else None
    role = NexusGroup(id=str(uuid.uuid4()), name=name, department=department or "", is_job_role=1,
                      tier="employee", allowed_modules="", company_id=company or "",
                      description=f"Added from the hiring packet for {for_name} - set its access.",
                      created_by=by, created_at=_now())
    db.add(role)
    admins = {r.email.lower() for r in db.query(NexusRole).filter(NexusRole.role.in_(("owner", "administrator"))).all()}
    from routers.hr import _hr_notify
    for to in admins | {by.lower()}:
        _hr_notify(db, to, f"New role needs access - {name}",
                   f"{by} added \"{name}\" to {entity.name if entity else 'the company'}'s roles while hiring "
                   f"{for_name}. It has no access yet - set what it can open in Settings > Access.",
                   ref_id=role.id, requested_by=by, action={"view": "admin-console", "sub": "global-access"},
                   priority=1)
    return role


def _hire_merge(db: Session, details: dict, pay: dict) -> dict:
    merge = {"job_title": details["job_title"], "department": details["department"],
             "start_date": us_long_date(details["start_date"]),
             "employment_type": details["employment_type"].replace("_", "-").title()
             .replace("Full-Time", "Full-time").replace("Part-Time", "Part-time")}
    if details["manager_email"]:
        merge["manager"] = person_name(db, details["manager_email"])
        merge["supervisor"] = merge["manager"]
    salary = details["salary_text"] or pay_text(pay)
    if salary:
        merge["salary"] = salary
    merge.update(details["merge"])
    return merge


def _parties_for(tpl: HrSignTemplate, subject_role: str, subject_name: str, subject_email: str,
                 subject_kind: str, sender: dict, manager: Optional[dict] = None) -> list:
    """One party per template role, in the template's order: the subject role
    is the person, 'manager' is their manager when one is given, every other
    role is the HR sender (the company signs at send)."""
    from routers.esign import PartyIn
    out = []
    for r in template_roles(tpl):
        key = r["key"]
        if key == subject_role:
            who = {"name": subject_name, "email": subject_email, "kind": subject_kind}
        elif key == "manager" and manager:
            who = {**manager, "kind": "internal"}
        else:
            who = {**sender, "kind": "internal"}
        out.append(PartyIn(role_key=key, name=who["name"], email=who["email"], kind=who["kind"],
                           ordinal=int(r.get("order") or 1), party_role="signer"))
    return out


def _load_candidate(db: Session, cid: str, scope, lock: bool = False) -> HrCandidate:
    q = db.query(HrCandidate).filter(HrCandidate.id == cid)
    cand = (q.with_for_update().first() if lock else q.first())
    if not cand or (scope is not None and (cand.company or "") not in scope):
        raise PacketError("Candidate not found", 404)
    return cand


def active_hire_event(db: Session, cid: str) -> Optional[HrLifeEvent]:
    """The hiring packet still out for this candidate, if any. The pipeline
    checks it before moving the candidate away from Offer: a packet that is
    signable while the candidate is Rejected (or back in Interview) would
    hire someone HR had decided against."""
    if not cid:
        return None
    return (db.query(HrLifeEvent)
            .filter(HrLifeEvent.candidate_id == cid, HrLifeEvent.kind == "hire",
                    HrLifeEvent.status.in_(ACTIVE)).first())


def reroute_hire_packet(db: Session, cand: HrCandidate, new_email: str, by: str) -> bool:
    """HR corrected the candidate's email while their packet is out: the
    packet follows the correction (fresh link, old one dead, re-invited if it
    is their turn). Without this the offer keeps going to the typo."""
    ev = active_hire_event(db, cand.id)
    if not ev or not ev.sign_request_id:
        return False
    from routers import esign
    req = db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
    party = (db.query(HrSignParty)
             .filter(HrSignParty.request_id == ev.sign_request_id,
                     HrSignParty.email == (ev.subject_email or "").lower()).first())
    if not req or not party or req.status != "pending":
        return False
    was = ev.subject_email
    ev.subject_email = new_email.strip().lower()     # before the re-invite: the email is built for the subject
    moved = esign.reroute_party(db, req, party, email=new_email, by=by, kind="external",
                                why="candidate email corrected in Hiring")
    if not moved:
        ev.subject_email = was
        return False
    ev.updated_at = _now()
    _stage_note(db, ev, f"Hiring packet now goes to {ev.subject_email}", by=by)
    return True


def plan_hire(db: Session, user: dict, cid: str, inputs: dict, pay: Optional[dict], scope,
              lock: bool = False) -> dict:
    """Everything a hiring-packet send would do, without doing it - the
    preview HR reads before sending, and the checks the send repeats."""
    cand = _load_candidate(db, cid, scope, lock=lock)
    if cand.stage != "offer":
        raise PacketError("Move the candidate to Offer before sending the hiring packet.", 409)
    if cand.employee_id:
        raise PacketError("This candidate is already an employee.", 409)
    if not (cand.email or "").strip():
        raise PacketError("Add the candidate's personal email first - the packet goes there.")
    if not (cand.company or "").strip():
        raise PacketError("Pick the hiring company on the candidate first.")
    details = _hire_details(db, cand, inputs or {})
    try:
        clean = clean_pay(pay)
    except ValueError as e:
        raise PacketError(str(e))
    former = rehire_record(db, cand)
    if former is not None:
        if former.status in ("active", "onboarding", "staged"):
            raise PacketError(f"{former.first_name} {former.last_name} ({former.employee_code}) is already in People "
                              f"as {former.status} with this email - this is not a new hire. Edit their record instead.", 409)
        details["rehire_employee_id"] = former.id
    wt = worker_type_of(details["employment_type"])
    setting = resolve_setting(db, cand.company, "hire", wt)
    entity = db.query(HrEntity).filter(HrEntity.id == cand.company).first()
    company = entity.name if entity else "this company"
    if not setting:
        raise PacketError(f"No hiring packet is set up for {company} yet - add one under "
                          f"People > Hiring > Packets.", 409)
    problems = setting_problems(db, setting)
    if problems:
        raise PacketError(f"The {company} hiring packet needs fixing: {problems[0]}", 409)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == setting.template_id).first()
    merge = _hire_merge(db, details, clean)
    from routers.esign import resolve_template
    _snapshot, unresolved = resolve_template(db, tpl, candidate_id=cand.id,
                                             entity_id=cand.company, overrides=merge)
    name = f"{cand.first_name} {cand.last_name}".strip()
    sender = {"name": person_name(db, user["email"]), "email": user["email"].lower()}
    parties = _parties_for(tpl, setting.subject_role or "employee", name, cand.email.strip().lower(),
                           "external", sender)
    return {"candidate": cand, "details": details, "pay": clean, "setting": setting,
            "template": tpl, "merge": merge, "unresolved": unresolved, "parties": parties,
            "title": f"{EVENT_TITLES['hire']} - {name}", "subjectName": name,
            "subfolder": (setting.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS["hire"],
            "company": company, "former": former}


def rehire_record(db: Session, cand: HrCandidate) -> Optional[NexusEmployee]:
    """The People record that already belongs to this email, if any - a
    former employee coming back must land on their old record, never a
    second one (Pranshu, Oct 8)."""
    email = (cand.email or "").strip().lower()
    if not email:
        return None
    from sqlalchemy import func, or_
    return (db.query(NexusEmployee)
            .filter(or_(func.lower(NexusEmployee.personal_email) == email,
                        func.lower(NexusEmployee.work_email) == email))
            .order_by(NexusEmployee.created_at.desc()).first())


def preview_out(plan: dict) -> dict:
    tpl, former = plan["template"], plan.get("former")
    return {
        "title": plan["title"], "company": plan["company"],
        "templateId": tpl.id, "templateName": tpl.name,
        "documents": [tpl.name] + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")],
        "recipients": [{"order": p.ordinal, "role": p.role_key, "name": p.name, "email": p.email,
                        "isSubject": p.kind == "external"} for p in plan["parties"]],
        "unresolved": plan["unresolved"], "emailMessage": plan["setting"].email_message or "",
        "egnyteSubfolder": plan["subfolder"], "startDate": plan["details"]["start_date"],
        "expiresOn": plan["details"]["offer_expires"],
        "salaryText": plan["merge"].get("salary", ""), "payInLetter": pay_in_letter(tpl),
        "jobTitle": plan["details"]["job_title"], "newRole": plan["details"]["new_role_name"],
        "rehire": ({"employeeId": former.id, "employeeCode": former.employee_code or "",
                    "name": f"{former.first_name} {former.last_name}".strip(), "status": former.status or ""}
                   if former is not None else None),
    }


def send_hire(db: Session, user: dict, cid: str, inputs: dict, pay: Optional[dict], scope, *,
              excluded_ack: bool, ip: str = "", user_agent: str = "") -> HrLifeEvent:
    """Send the company's hiring packet to a candidate at Offer. HR (the
    sender) signs first, in the signing view the screen opens next; the
    candidate is invited the moment HR has signed, and signs last."""
    plan = plan_hire(db, user, cid, inputs, pay, scope, lock=True)
    cand = plan["candidate"]
    if plan["unresolved"]:
        raise PacketError("Fill in: " + ", ".join(plan["unresolved"]) + ".")
    busy = (db.query(HrLifeEvent)
            .filter(HrLifeEvent.candidate_id == cand.id, HrLifeEvent.kind == "hire",
                    HrLifeEvent.status.in_(ACTIVE)).first())
    if busy:
        raise PacketError("A hiring packet is already out for this candidate - void it first "
                          "to send a new one.", 409)
    now = _now()
    if plan["details"]["new_role_name"]:
        role = create_company_role(db, cand.company, plan["details"]["new_role_name"],
                                   plan["details"]["department"], user["email"], plan["subjectName"])
        plan["details"]["role_id"] = role.id
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="hire", status="awaiting_sender",
                     entity_id=cand.company, candidate_id=cand.id, subject_name=plan["subjectName"],
                     subject_email=cand.email.strip().lower(), setting_id=plan["setting"].id,
                     template_id=plan["template"].id,
                     inputs=dict(plan["details"]),
                     pay=plan["pay"], effective_date=plan["details"]["start_date"],
                     created_by=user["email"].lower(), created_at=now, updated_at=now)
    db.add(ev)
    first = plan["parties"][0] if plan["parties"] else None
    sender_first = bool(first and first.kind == "internal" and first.email == user["email"].lower())
    from fastapi import HTTPException
    from routers.esign import envelope_from_template
    try:
        out = envelope_from_template(
            db, user, plan["template"], parties=plan["parties"], title=plan["title"],
            candidate_id=cand.id, entity_id=cand.company, merge=plan["merge"],
            message=plan["setting"].email_message or "", expires_on=plan["details"]["offer_expires"],
            ip=ip, user_agent=user_agent,
            excluded_ack=excluded_ack, link_kind="life_event", link_id=ev.id,
            sender_signs_first=sender_first)
    except HTTPException as e:
        raise PacketError(str(e.detail), e.status_code)
    ev.sign_request_id = out["id"]
    if not sender_first:
        ev.status = "sent"
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                        to_stage=cand.stage, by_email=user["email"], created_at=now,
                        note=f"Hiring packet sent to {ev.subject_email} - offer expires {us_date(plan['details']['offer_expires'])}"
                        + (f" - rehire of {plan['former'].employee_code}" if plan.get("former") is not None else "")))
    db.commit()
    return ev


def sender_party_id(db: Session, ev: HrLifeEvent, email: str) -> str:
    """The party THIS viewer signs as right now, if it is their turn - HR's
    own signature at send, or the manager's on a promotion letter - so Sign
    Now is on the person's card instead of buried in Documents."""
    if ev.status not in ACTIVE or not ev.sign_request_id:
        return ""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
    if not req or req.status != "pending":
        return ""
    p = (db.query(HrSignParty)
         .filter(HrSignParty.request_id == ev.sign_request_id, HrSignParty.email == (email or "").lower(),
                 HrSignParty.status.in_(("waiting", "notified", "viewed")))
         .order_by(HrSignParty.ordinal).first())
    if not p or p.kind != "internal":
        return ""
    if (req.routing or "sequential") == "sequential" and p.ordinal != (req.current_order or 1):
        return ""
    return p.id


# ── Nexus Sign callbacks (routers/esign.py _link_hook) ───────────────────────

def _for(db: Session, req: HrSignRequest) -> Optional[HrLifeEvent]:
    if not req.link_id:
        return None
    return db.query(HrLifeEvent).filter(HrLifeEvent.id == req.link_id).with_for_update().first()


def _stage_note(db: Session, ev: HrLifeEvent, note: str, by: str = "") -> None:
    if ev.kind != "hire" or not ev.candidate_id:
        return
    cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first()
    if cand:
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                            to_stage=cand.stage, note=note, by_email=by or ev.created_by,
                            created_at=_now()))


def _notify(db: Session, to: str, title: str, body: str, ev: HrLifeEvent, priority: int = 0) -> None:
    from routers.hr import _hr_notify
    sub = "hr-hiring" if ev.kind == "hire" and not ev.employee_id else "hr-people"
    _hr_notify(db, to, title, body, ref_id=ev.id, requested_by="nexus-sign",
               action={"view": "hr", "sub": sub}, priority=priority)


def on_progress(db: Session, req: HrSignRequest) -> None:
    """HR has signed -> the person is invited: the packet is now 'sent'.
    Nexus Sign calls this right after a party is marked done and BEFORE it
    moves the turn on, so the test is "everyone ahead of the person is done",
    not the turn number."""
    ev = _for(db, req)
    if not ev or ev.status != "awaiting_sender":
        return
    parties = db.query(HrSignParty).filter(HrSignParty.request_id == req.id).all()
    subject = next((p for p in parties if p.email == (ev.subject_email or "").lower()), None)
    if subject is None:
        return
    ahead = [p for p in parties if p.ordinal < subject.ordinal and (p.party_role or "signer") == "signer"]
    if all(p.status == "signed" for p in ahead):
        ev.status = "sent"
        ev.updated_at = _now()
        _stage_note(db, ev, f"Company signed - {ev.subject_name} invited to sign")


def on_declined(db: Session, req: HrSignRequest, party, reason: str = "") -> None:
    ev = _for(db, req)
    if not ev or ev.status not in ACTIVE:
        return
    ev.status = "declined"
    ev.decline_reason = (reason or "")[:500]
    ev.updated_at = _now()
    who = getattr(party, "name", "") or "A signer"
    _stage_note(db, ev, f"Hiring packet declined by {who}" + (f": {reason}" if reason else ""))
    _notify(db, ev.created_by, f"{EVENT_TITLES[ev.kind]} declined - {ev.subject_name}",
            f"{who} declined \"{req.title}\"." + (f" Reason: {reason}" if reason else "")
            + " Fix what is needed and send it again.", ev)


def on_voided(db: Session, req: HrSignRequest, actor: str = "") -> None:
    ev = _for(db, req)
    if not ev or ev.status not in ACTIVE:
        return
    ev.status = "voided"
    ev.updated_at = _now()
    _stage_note(db, ev, f"Hiring packet voided by {actor or 'HR'}", by=actor)
    if ev.kind == "separation" and ev.apply_status == "scheduled":
        # Voiding the paperwork in Nexus Sign is not canceling the offboarding
        # - the person is still leaving on the day. Say so, in case it was.
        _notify(db, ev.created_by, f"Separation package voided - {ev.subject_name}",
                f"The package was voided by {actor or 'HR'}, but the offboarding is still scheduled: "
                f"{ev.subject_name} is marked Left after {us_date(ev.effective_date)}. If they are staying, "
                f"use Cancel Offboarding on their profile; to send new paperwork, run Offboard again.", ev)


def on_expired(db: Session, req: HrSignRequest) -> None:
    """The envelope passed its date unsigned. The event follows it, and the
    sender is told - an offer that quietly expired is a candidate nobody
    calls back."""
    ev = _for(db, req)
    if not ev or ev.status not in ACTIVE:
        return
    ev.status = "expired"
    ev.updated_at = _now()
    _stage_note(db, ev, "Hiring packet expired unsigned")
    _notify(db, ev.created_by, f"{EVENT_TITLES[ev.kind]} expired - {ev.subject_name}",
            f"\"{req.title}\" passed its signing date without every signature. Send it again if it still stands.", ev)


def _apply_hire(db: Session, ev: HrLifeEvent, req: HrSignRequest) -> None:
    """The packet is signed: the candidate is hired. Same function Mark Hired
    uses, so a signed packet and a manual hire build the same employee."""
    from routers.hr import create_employee_from_candidate
    cand = (db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id)
            .with_for_update().first())
    if not cand:
        ev.apply_note = "The candidate was deleted before the packet was signed - nobody was hired."
        return
    if cand.stage == "rejected":
        # The pipeline refuses to reject a candidate while their packet is
        # out (routers/hr.py), so this is a belt for a changed record: a
        # signature must never hire someone HR closed. HR decides.
        ev.apply_note = "Signed after the candidate was rejected - NOT hired. Reopen them and Mark Hired By Hand if the offer stands."
        _notify(db, ev.created_by, f"{ev.subject_name} signed a packet after being rejected",
                "The signed packet is in Nexus Sign, but they were not hired because the candidate is Rejected. "
                "Reopen them and Mark Hired By Hand if the offer still stands.", ev, priority=1)
        return
    emp = (db.query(NexusEmployee).filter(NexusEmployee.id == cand.employee_id).first()
           if cand.employee_id else None)
    details = ev.inputs or {}
    if emp is None:
        emp = create_employee_from_candidate(db, cand, ev.created_by, details=details)
        note = ("Hiring packet signed - rehired on their existing record" if details.get("rehire_employee_id")
                else "Hiring packet signed - hired automatically")
    else:
        note = "Hiring packet signed (already hired)"
    if cand.stage != "hired":
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                            to_stage="hired", note=note, by_email=ev.created_by, created_at=_now()))
        cand.stage = "hired"
    cand.updated_at = _now()
    if ev.pay and not (emp.compensation or {}).get("base"):
        emp.compensation = compensation_from_pay(ev.pay, ev.effective_date or "")
        from routers.hr import adopt_pending_pay
        adopt_pending_pay(db, emp, ev.created_by)
    ev.employee_id = emp.id
    if emp.work_email:
        from routers.hr import adopt_pending_role
        adopt_pending_role(db, emp, ev.created_by, ev)
    # _finalize attaches the sealed PDF to the profile's Documents tab for the
    # envelope's employee - set here, before it does.
    req.employee_id = emp.id
    ev.apply_note = note
    start = us_date(ev.effective_date)
    for to in {ev.created_by, (cand.created_by or "").lower(), (emp.manager_email or "").lower()} - {""}:
        _notify(db, to, f"{ev.subject_name} signed the hiring packet",
                f"{ev.subject_name} signed every document and is now in People as onboarding"
                + (f", starting {start}" if start else "") + ".", ev)


_APPLY = {"hire": _apply_hire}


def on_completed(db: Session, req: HrSignRequest) -> None:
    """Everyone signed: apply the change, then queue the Egnyte filing."""
    ev = _for(db, req)
    if not ev or ev.status == "completed":
        return
    now = _now()
    apply = _APPLY.get(ev.kind)
    if apply:
        apply(db, ev, req)
    ev.status = "completed"
    ev.completed_at = now
    if ev.kind != "separation":           # a separation is applied by its last day, not the signature
        ev.applied_at = now
    ev.updated_at = now
    ev.flags = [f for f in (ev.flags or []) if f.get("code") != APPLY_FAILED]
    ev.filing_status = "pending"
    ev.filing_next_at = now
    ev.filing_attempts = 0


def retry_apply(db: Session, ev: HrLifeEvent) -> None:
    """HR's Retry after safe() recorded a failure: the envelope is sealed,
    the event is not - run the completion again, and this time let the
    error reach the screen. Commits."""
    req = (db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
           if ev.sign_request_id else None)
    if not req or req.status != "completed":
        raise PacketError("Nothing to apply - the packet is not fully signed.", 409)
    if ev.status == "completed":
        raise PacketError("Already applied.", 409)
    on_completed(db, req)
    if ev.kind == "hire" and ev.employee_id and req.final_pdf_path:
        # What _finalize does for an envelope that already knows its employee:
        # the sealed packet on the profile's Documents tab. The first run
        # never got there, because the employee did not exist yet.
        from models import HrDocument
        req.employee_id = req.employee_id or ev.employee_id
        if not db.query(HrDocument).filter(HrDocument.employee_id == ev.employee_id,
                                           HrDocument.storage_path == req.final_pdf_path).first():
            db.add(HrDocument(id=str(uuid.uuid4()), employee_id=ev.employee_id, kind="contract",
                              file_name=f"{req.title}.pdf", storage_path=req.final_pdf_path,
                              size_bytes=0, uploaded_by="e-sign", created_at=req.completed_at or _now()))
    db.commit()


# ── Promotion / role change (Neil, Oct 8: 27:13 - 35:20) ─────────────────────
# "What are HR's actions? After an employee is in, they're either moving up,
# they're changing a role, or they're leaving." A promotion sends a letter -
# role X -> Y, the new responsibilities, the new pay - the EMPLOYEE signs, then
# the MANAGER, and it is filed where the employee can see it. HR enters the new
# pay and the effective date, which can be in the past ("I actually started it
# at the start of last month"); a past date that reaches into timesheets
# already signed is FLAGGED for HR, not silently repriced (Pranshu, Oct 8).
# The role (and so the access) changes when the letter is fully signed; the
# pay is dated from the effective date in the pay history.

CHANGE_TYPES = {"promotion": "Promotion", "role_change": "Role Change"}


def _load_employee(db: Session, eid: str, scope, lock: bool = False) -> NexusEmployee:
    q = db.query(NexusEmployee).filter(NexusEmployee.id == eid)
    emp = q.with_for_update().first() if lock else q.first()
    if not emp or (scope is not None and (emp.company or "") not in scope):
        raise PacketError("Employee not found", 404)
    return emp


def current_job_role(db: Session, email: str):
    from models import NexusGroup, NexusGroupMember
    if not email:
        return None
    return (db.query(NexusGroup)
            .join(NexusGroupMember, NexusGroupMember.group_id == NexusGroup.id)
            .filter(NexusGroupMember.email == email.lower(), NexusGroup.is_job_role == 1)
            .first())


def signed_periods_from(db: Session, email: str, effective: str) -> list:
    """Timesheet periods ending on/after `effective` that someone has already
    signed or HR has finalized - repricing them silently would change pay
    people agreed to, so they are flagged for HR instead."""
    from models import TimeApproval
    if not email or not effective:
        return []
    rows = (db.query(TimeApproval)
            .filter(TimeApproval.employee_email == email.lower(), TimeApproval.revoked == 0,
                    TimeApproval.kind.in_(("final", "employee_sign", "manager")),
                    TimeApproval.period_end >= effective)
            .all())
    periods = sorted({(r.period_start, r.period_end) for r in rows})
    return [{"start": a, "end": b, "label": f"{us_date(a)} - {us_date(b)}"} for a, b in periods]


def _promotion_details(db: Session, user: dict, emp: NexusEmployee, inputs: dict) -> dict:
    from models import NexusGroup
    from fastapi import HTTPException
    from routers.jobroles import check_can_assign
    change = (inputs.get("change_type") or "promotion").strip()
    if change not in CHANGE_TYPES:
        raise PacketError("Pick Promotion or Role Change.")
    role_id = (inputs.get("role_id") or "").strip()
    jr = (db.query(NexusGroup).filter(NexusGroup.id == role_id, NexusGroup.is_job_role == 1).first()
          if role_id else None)
    if not jr:
        raise PacketError("Pick the new role.")
    try:
        check_can_assign(db, user, jr, emp.work_email, hr_path=True)
    except HTTPException as e:
        raise PacketError(str(e.detail), e.status_code)
    eff = (inputs.get("effective_date") or "").strip()[:10]
    try:
        datetime.strptime(eff, "%Y-%m-%d")
    except ValueError:
        raise PacketError("Enter the date the change takes effect.")
    cur = current_job_role(db, emp.work_email)
    return {
        "change_type": change, "role_id": jr.id, "role_name": jr.name,
        "department": jr.department or emp.department or "",
        "job_title": (inputs.get("job_title") or jr.name).strip(),
        "old_role_id": cur.id if cur else "", "old_role_name": cur.name if cur else "",
        "old_title": emp.job_title or (cur.name if cur else ""),
        "effective_date": eff,
        "responsibilities": (inputs.get("responsibilities") or "").strip()[:4000],
        "reason": (inputs.get("reason") or "").strip()[:1000],
        "salary_text": (inputs.get("salary_text") or "").strip(),
        "merge": {k: str(v).strip() for k, v in (inputs.get("merge") or {}).items()
                  if re.fullmatch(r"[a-z0-9_]+", str(k)) and str(v).strip()},
    }


def plan_promotion(db: Session, user: dict, eid: str, inputs: dict, pay: Optional[dict], scope,
                   lock: bool = False) -> dict:
    emp = _load_employee(db, eid, scope, lock=lock)
    if emp.status not in ("active", "onboarding"):
        raise PacketError(f"{emp.first_name} is {emp.status} - only current employees can be promoted.", 409)
    if not (emp.work_email or "").strip():
        raise PacketError("They need a work email first - the letter is signed in Nexus.", 409)
    details = _promotion_details(db, user, emp, inputs or {})
    try:
        clean = clean_pay(pay)
    except ValueError as e:
        raise PacketError(str(e))
    if details["role_id"] == details["old_role_id"] and not clean and details["job_title"] == details["old_title"]:
        raise PacketError("Nothing changes - pick a new role, title or pay.")
    entity = db.query(HrEntity).filter(HrEntity.id == emp.company).first()
    company = entity.name if entity else "this company"
    setting = resolve_setting(db, emp.company or "", "promotion", worker_type_of(emp.employment_type))
    if not setting:
        raise PacketError(f"No promotion letter is set up for {company} yet - add one under "
                          f"People > Hiring > Packets.", 409)
    problems = setting_problems(db, setting)
    if problems:
        raise PacketError(f"The {company} promotion letter needs fixing: {problems[0]}", 409)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == setting.template_id).first()
    roles = [r["key"] for r in template_roles(tpl)]
    manager = None
    if "manager" in roles:
        mgr_email = (emp.manager_email or "").strip().lower()
        if not mgr_email or mgr_email == emp.work_email.lower():
            raise PacketError(f"Set {emp.first_name}'s manager first - the manager signs the letter after them.", 409)
        manager = {"name": person_name(db, mgr_email), "email": mgr_email}
    name = (emp.display_name or f"{emp.first_name} {emp.last_name}").strip()
    merge = {
        "change_type": CHANGE_TYPES[details["change_type"]].lower(),
        "old_title": details["old_title"], "new_title": details["job_title"], "job_title": details["job_title"],
        "old_role": details["old_role_name"] or details["old_title"], "new_role": details["role_name"],
        "department": details["department"], "effective_date": us_long_date(details["effective_date"]),
        "responsibilities": details["responsibilities"],
    }
    if manager:
        merge["manager"] = manager["name"]
    salary = details["salary_text"] or pay_text(clean)
    if salary:
        merge["salary"] = salary
    merge.update(details["merge"])
    from routers.esign import resolve_template
    _snap, unresolved = resolve_template(db, tpl, employee_id=emp.id, entity_id=emp.company or "", overrides=merge)
    sender = {"name": person_name(db, user["email"]), "email": user["email"].lower()}
    parties = _parties_for(tpl, setting.subject_role or "employee", name, emp.work_email.lower(),
                           "internal", sender, manager=manager)
    return {"employee": emp, "details": details, "pay": clean, "setting": setting, "template": tpl,
            "merge": merge, "unresolved": unresolved, "parties": parties, "subjectName": name,
            "title": f"{CHANGE_TYPES[details['change_type']]} Letter - {name}", "company": company,
            "subfolder": (setting.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS["promotion"],
            "flags": signed_periods_from(db, emp.work_email, details["effective_date"]) if clean else []}


def promotion_preview_out(plan: dict) -> dict:
    tpl, d = plan["template"], plan["details"]
    return {
        "title": plan["title"], "company": plan["company"], "templateName": tpl.name, "templateId": tpl.id,
        "entityId": plan["employee"].company or "",
        "documents": [tpl.name] + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")],
        "recipients": [{"order": p.ordinal, "role": p.role_key, "name": p.name, "email": p.email,
                        "who": "employee" if p.email == plan["employee"].work_email.lower()
                        else ("you" if p.role_key not in ("manager",) else "manager")} for p in plan["parties"]],
        "unresolved": plan["unresolved"], "emailMessage": plan["setting"].email_message or "",
        "egnyteSubfolder": plan["subfolder"], "effectiveDate": d["effective_date"],
        "fromTitle": d["old_title"], "toTitle": d["job_title"], "fromRole": d["old_role_name"], "toRole": d["role_name"],
        "salaryText": plan["merge"].get("salary", ""), "payInLetter": pay_in_letter(tpl),
        "signedPeriods": plan["flags"],
    }


def send_promotion(db: Session, user: dict, eid: str, inputs: dict, pay: Optional[dict], scope, *,
                   excluded_ack: bool, ip: str = "", user_agent: str = "") -> HrLifeEvent:
    plan = plan_promotion(db, user, eid, inputs, pay, scope, lock=True)
    emp = plan["employee"]
    if plan["unresolved"]:
        raise PacketError("Fill in: " + ", ".join(plan["unresolved"]) + ".")
    busy = (db.query(HrLifeEvent).filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "promotion",
                                         HrLifeEvent.status.in_(ACTIVE)).first())
    if busy:
        raise PacketError("A promotion letter is already out for them - void it first to send a new one.", 409)
    now = _now()
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="promotion", status="awaiting_sender",
                     entity_id=emp.company or "", employee_id=emp.id, subject_name=plan["subjectName"],
                     subject_email=emp.work_email.lower(), setting_id=plan["setting"].id,
                     template_id=plan["template"].id,
                     # The pay before the change rides with the new pay (both
                     # hr_comp-only) so the letter's email can say what it went
                     # up by - "pay increased by" (Pranshu, Oct 8).
                     inputs=dict(plan["details"]) | ({"old_pay": {k: (emp.compensation or {}).get(k)
                                                                   for k in ("base", "payBasis", "frequency", "currency")}}
                                                     if plan["pay"] and (emp.compensation or {}).get("base") else {}),
                     pay=plan["pay"],
                     effective_date=plan["details"]["effective_date"],
                     flags=[{"code": "signed_timesheets", "periods": plan["flags"]}] if plan["flags"] else [],
                     created_by=user["email"].lower(), created_at=now, updated_at=now)
    db.add(ev)
    first = plan["parties"][0] if plan["parties"] else None
    sender_first = bool(first and first.email == user["email"].lower() and first.email != ev.subject_email)
    from fastapi import HTTPException
    from routers.esign import envelope_from_template
    try:
        out = envelope_from_template(
            db, user, plan["template"], parties=plan["parties"], title=plan["title"],
            employee_id=emp.id, entity_id=emp.company or "", merge=plan["merge"],
            message=plan["setting"].email_message or "", ip=ip, user_agent=user_agent,
            excluded_ack=excluded_ack, link_kind="life_event", link_id=ev.id,
            sender_signs_first=sender_first)
    except HTTPException as e:
        raise PacketError(str(e.detail), e.status_code)
    ev.sign_request_id = out["id"]
    if not sender_first:
        ev.status = "sent"
    db.commit()
    return ev


def _apply_promotion(db: Session, ev: HrLifeEvent, req: HrSignRequest) -> None:
    """Fully signed: the new role (and with it the access and tier), the title,
    and the new pay dated from the effective date. Signed timesheets on/after
    that date are flagged for HR. Everyone who needs to know is told."""
    from models import NexusGroup
    from routers.jobroles import apply_job_role
    from routers import hr as hr_router
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).with_for_update().first()
    d = ev.inputs or {}
    if not emp or not emp.work_email:
        ev.apply_note = "The employee record is gone - nothing was changed."
        return
    jr = db.query(NexusGroup).filter(NexusGroup.id == d.get("role_id"), NexusGroup.is_job_role == 1).first()
    if not jr:
        ev.apply_note = "The new role was deleted before the letter was signed - role not changed."
    else:
        apply_job_role(db, jr, emp.work_email.lower(), ev.created_by)
    if d.get("job_title"):
        emp.job_title = d["job_title"]
    if d.get("department"):
        emp.department = d["department"]
    eff = ev.effective_date or ""
    if ev.pay:
        current = dict(emp.compensation or {})
        history = list(current.get("history") or [])
        if str(current.get("base") or ""):
            history.insert(0, {"base": current.get("base", ""), "currency": current.get("currency", ""),
                               "payBasis": current.get("payBasis", ""), "effectiveDate": current.get("effectiveDate", ""),
                               "changedAt": _now(), "changedBy": ev.created_by})
        comp = compensation_from_pay(ev.pay, eff)
        comp["history"] = history
        emp.compensation = comp
        hr_router.ensure_rate_history(db, emp.work_email, by=ev.created_by)
        hr_router.sync_rate_from_comp(db, emp)
        db.flush()
        hr_router.append_rate_history(db, emp, eff, by=ev.created_by)
    emp.updated_at = _now()
    periods = signed_periods_from(db, emp.work_email, eff) if ev.pay else []
    ev.flags = [{"code": "signed_timesheets", "periods": periods}] if periods else []
    title = CHANGE_TYPES.get(d.get("change_type"), "Role Change")
    ev.apply_note = (f"{title}: {d.get('old_title') or '-'} -> {d.get('job_title')} from {us_date(eff)}"
                     + ("; new pay recorded" if ev.pay else ""))
    entity = db.query(HrEntity).filter(HrEntity.id == emp.company).first() if emp.company else None
    hr_contact = (entity.hr_contact_email or "").lower() if entity else ""
    body = (f"{ev.subject_name}: {d.get('old_title') or '-'} -> {d.get('job_title')}, effective {us_date(eff)}."
            + (" The new pay is on Pay & Benefits from that date." if ev.pay else ""))
    for to in {ev.created_by, (emp.manager_email or "").lower(), hr_contact} - {"", emp.work_email.lower()}:
        _notify(db, to, f"{title} signed - {ev.subject_name}", body, ev)
    _notify(db, emp.work_email.lower(), f"Your {title.lower()} is official",
            f"Your new role, {d.get('job_title')}, takes effect {us_date(eff)}. The signed letter is in "
            f"My HR > My Documents.", ev)
    if periods:
        labels = ", ".join(p["label"] for p in periods)
        for to in {ev.created_by, hr_contact} - {""}:
            from routers.hr import _hr_notify
            _hr_notify(db, to, f"Review signed timesheets - {ev.subject_name}",
                       f"The new pay starts {us_date(eff)}, inside timesheets already signed or finalized "
                       f"({labels}). They were NOT repriced - review and adjust them if needed.",
                       ref_id=ev.id, requested_by="nexus-sign", action={"view": "hr", "sub": "hr-time"}, priority=1)


_APPLY["promotion"] = _apply_promotion


# ── Offboarding (Neil, Oct 8: 28:19 - 30:04) ─────────────────────────────────
# "There needs to be an option for each employee to do an off-boarding ... it
# should very clearly say what company are they with, what is the off-boarding
# package ... process through Nexus Sign". The LAST DAY decides two things:
#   - where the paperwork goes: "If the last day is immediate ... the
#     termination paperwork needs to be sent to their personal e-mail. If they
#     still have an active e-mail, it needs to go to their company e-mail."
#   - when they become Left: today or earlier = now; a future last day = Nexus
#     switches them on that day by itself (Pranshu, Oct 8).
# The status change is the SAME one People's status pill runs
# (hr.apply_status_change): items returned, tasks handed over, M365 blocked,
# sessions ended. The paperwork is optional (a company may not have a
# separation package yet); the offboarding itself never waits on a signature.

SEPARATION_TYPES = {
    "resignation": "Resignation", "resignation_no_notice": "Resignation Without Notice",
    "termination": "Termination", "end_of_contract": "End Of Contract", "retirement": "Retirement",
    "death": "Death",
}


def _today() -> str:
    """Today where the company works (BUSINESS_TZ), as YYYY-MM-DD."""
    return datetime.now(ZoneInfo(BUSINESS_TZ)).strftime("%Y-%m-%d")


def _separation_details(inputs: dict) -> dict:
    last = (inputs.get("last_day") or "").strip()[:10]
    try:
        datetime.strptime(last, "%Y-%m-%d")
    except ValueError:
        raise PacketError("Enter their last day.")
    kind = (inputs.get("exit_type") or "").strip()
    if kind not in SEPARATION_TYPES:
        raise PacketError("Pick why they are leaving.")
    off = inputs.get("offboarding") or {}
    action = (off.get("mailboxAction") or "remove").strip()
    if action not in ("remove", "share"):
        raise PacketError("Pick what happens to their mailbox.")
    return {
        "last_day": last, "exit_type": kind, "reason": (inputs.get("reason") or "").strip()[:1000],
        "immediate": last <= _today(),
        "send_package": bool(inputs.get("send_package", True)),
        "start_checklist": bool(inputs.get("start_checklist", True)),
        "offboarding": {
            "mailboxAction": action,
            "delegateTo": [e.strip().lower() for e in (off.get("delegateTo") or []) if e and e.strip()],
            "exportRequested": bool(off.get("exportRequested")),
            "freeUpLicense": action == "remove",
            "handoverTo": (off.get("handoverTo") or "").strip().lower(),
            "handoverIncludeCompleted": bool(off.get("handoverIncludeCompleted")),
        },
        "merge": {k: str(v).strip() for k, v in (inputs.get("merge") or {}).items()
                  if re.fullmatch(r"[a-z0-9_]+", str(k)) and str(v).strip()},
    }


def plan_separation(db: Session, user: dict, eid: str, inputs: dict, scope, lock: bool = False) -> dict:
    emp = _load_employee(db, eid, scope, lock=lock)
    if emp.status == "offboarded":
        raise PacketError(f"{emp.first_name} has already left.", 409)
    d = _separation_details(inputs or {})
    if d["offboarding"]["mailboxAction"] == "share" and not d["offboarding"]["delegateTo"]:
        raise PacketError("Pick who gets access to their mailbox.")
    name = (emp.display_name or f"{emp.first_name} {emp.last_name}").strip()
    entity = db.query(HrEntity).filter(HrEntity.id == emp.company).first() if emp.company else None
    company = entity.name if entity else "their company"
    # Where the paperwork goes (Neil): cut off now -> personal; still here -> work.
    personal, work = (emp.personal_email or "").strip().lower(), (emp.work_email or "").strip().lower()
    if d["immediate"]:
        to, kind_of, why = personal, "external", "their access ends today, so it goes to their personal email"
    elif work:
        to, kind_of, why = work, "internal", "they still have their work email until their last day"
    else:
        to, kind_of, why = personal, "external", "they have no work email, so it goes to their personal email"
    setting = resolve_setting(db, emp.company or "", "separation", worker_type_of(emp.employment_type))
    tpl = (db.query(HrSignTemplate).filter(HrSignTemplate.id == setting.template_id).first()
           if setting else None)
    problems = setting_problems(db, setting) if setting else []
    package = d["send_package"] and bool(setting) and not problems
    merge, unresolved, parties = {}, [], []
    if d["send_package"]:
        if not setting:
            raise PacketError(f"No separation package is set up for {company} - add one under People > "
                              f"Hiring > Packets, or offboard without documents.", 409)
        if problems:
            raise PacketError(f"The {company} separation package needs fixing: {problems[0]}", 409)
        if not to:
            raise PacketError(f"Add {emp.first_name}'s personal email first - {why}.", 409)
        merge = {"last_day": us_long_date(d["last_day"]), "separation_type": SEPARATION_TYPES[d["exit_type"]],
                 "job_title": emp.job_title or "", "department": emp.department or ""}
        merge.update(d["merge"])
        from routers.esign import resolve_template
        _snap, unresolved = resolve_template(db, tpl, employee_id=emp.id, entity_id=emp.company or "",
                                             overrides=merge)
        sender = {"name": person_name(db, user["email"]), "email": user["email"].lower()}
        mgr = (emp.manager_email or "").strip().lower()
        manager = {"name": person_name(db, mgr), "email": mgr} if mgr and mgr != work else None
        parties = _parties_for(tpl, setting.subject_role or "employee", name, to, kind_of, sender, manager=manager)
    return {"employee": emp, "details": d, "setting": setting, "template": tpl, "package": package,
            "merge": merge, "unresolved": unresolved, "parties": parties, "subjectName": name,
            "to": to, "why": why, "company": company,
            "title": f"{EVENT_TITLES['separation']} - {name}",
            "subfolder": ((setting.egnyte_subfolder if setting else "") or "").strip() or DEFAULT_SUBFOLDERS["separation"]}


def separation_preview_out(plan: dict) -> dict:
    d, tpl = plan["details"], plan["template"]
    return {
        "title": plan["title"], "company": plan["company"], "lastDay": d["last_day"],
        "immediate": d["immediate"], "sendTo": plan["to"], "why": plan["why"],
        "package": plan["package"], "templateName": tpl.name if tpl else "", "templateId": tpl.id if tpl else "",
        "entityId": plan["employee"].company or "", "emailMessage": (plan["setting"].email_message or "") if plan["setting"] else "",
        "documents": ([tpl.name] + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")])
        if tpl and plan["package"] else [],
        "recipients": [{"order": p.ordinal, "role": p.role_key, "name": p.name, "email": p.email,
                        "isSubject": p.email == plan["to"]} for p in plan["parties"]],
        "unresolved": plan["unresolved"], "egnyteSubfolder": plan["subfolder"],
    }


def _separation_status_body(ev: HrLifeEvent):
    from routers.hr import StatusChangeIn
    d = ev.inputs or {}
    reason = f"{SEPARATION_TYPES.get(d.get('exit_type'), 'Left')}" + (f" - {d['reason']}" if d.get("reason") else "")
    return StatusChangeIn(status="offboarded", reason=reason, effectiveDate=d.get("last_day", ""),
                          offboarding=d.get("offboarding") or None)


def apply_separation_now(db: Session, ev: HrLifeEvent) -> dict:
    """Run the status change (Left) for an offboarding. Commits."""
    from routers.hr import apply_status_change
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).first()
    if not emp:
        ev.apply_status, ev.apply_note = "canceled", "The employee record is gone."
        db.commit()
        return {}
    if emp.status == "offboarded":
        ev.apply_status, ev.applied_at, ev.apply_note = "applied", _now(), "Already marked Left."
        db.commit()
        return {}
    out = apply_status_change(db, emp, _separation_status_body(ev), ev.created_by)
    d = ev.inputs or {}
    if d.get("start_checklist"):
        import hr_checklists
        try:
            if not hr_checklists.open_checklist(db, emp.id, "offboarding"):
                hr_checklists.start(db, emp, "offboarding", anchor_date=d.get("last_day", ""),
                                    exit_type=d.get("exit_type", ""), by=ev.created_by)
        except ValueError as e:
            print(f"[life-events] offboarding checklist not started for {emp.id}: {e}")
    ev.apply_status, ev.applied_at = "applied", _now()
    ho = (out or {}).get("handover") or {}
    it = (out or {}).get("items") or {}
    bits = ["Marked Left"]
    if it.get("checkouts") or it.get("assignments"):
        bits.append(f"{(it.get('checkouts') or 0) + (it.get('assignments') or 0)} item(s) returned")
    if ho.get("reassigned"):
        bits.append(f"{ho['reassigned']} task(s) handed over")
    m = (out or {}).get("m365") or {}
    if m.get("error"):
        bits.append(f"M365: {m['error']}")
    rerouted = _package_follows_the_leaver(db, ev, emp)
    if rerouted:
        bits.append(rerouted)
    ev.apply_note = "; ".join(bits)
    ev.updated_at = _now()
    db.commit()
    return out


def _package_follows_the_leaver(db: Session, ev: HrLifeEvent, emp: NexusEmployee) -> str:
    """The person is Left now - their Nexus login and work mailbox are gone.
    A separation package that went to the WORK email (a future last day,
    Neil's rule) and is still unsigned can no longer be signed there, so it
    moves to their personal email as an external signer, the way an
    immediate offboarding sends it in the first place. Returns the note for
    the record ('' when there was nothing to move)."""
    if not ev.sign_request_id or ev.status not in ACTIVE:
        return ""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
    party = (db.query(HrSignParty)
             .filter(HrSignParty.request_id == ev.sign_request_id,
                     HrSignParty.email == (ev.subject_email or "").lower()).first())
    if not req or not party or req.status != "pending" or party.kind != "internal" \
            or party.status in ("signed", "declined"):
        return ""
    personal = (emp.personal_email or "").strip().lower()
    if not personal:
        _notify(db, ev.created_by, f"Separation package stuck - {ev.subject_name}",
                f"{ev.subject_name} is Left and can no longer sign in, and the separation package is still "
                f"unsigned. Add their personal email on People, then correct the recipient in Nexus Sign "
                f"(or void the package).", ev, priority=1)
        return "package still unsigned - no personal email to send it to"
    from routers import esign
    ev.subject_email = personal                      # before the re-invite: the email is built for the subject
    esign.reroute_party(db, req, party, email=personal, by=ev.created_by, kind="external",
                        why="work account closed on the last day")
    return f"unsigned package re-sent to {personal}"


def send_separation(db: Session, user: dict, eid: str, inputs: dict, scope, *, excluded_ack: bool,
                    ip: str = "", user_agent: str = "") -> tuple:
    plan = plan_separation(db, user, eid, inputs, scope, lock=True)
    emp, d = plan["employee"], plan["details"]
    if plan["unresolved"]:
        raise PacketError("Fill in: " + ", ".join(plan["unresolved"]) + ".")
    busy = (db.query(HrLifeEvent).filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "separation",
                                         HrLifeEvent.apply_status == "scheduled").first())
    if busy and busy.status in ACTIVE:
        raise PacketError("An offboarding is already scheduled for them - cancel it first.", 409)
    now = _now()
    if busy:
        # Scheduled, but its paperwork was declined, voided or expired: this
        # send replaces it (same person, fresh package, new details) instead
        # of forcing HR to cancel and re-enter everything.
        busy.apply_status = "canceled"
        busy.apply_note = f"Replaced by a new offboarding on {us_date(now)}"
        busy.updated_at = now
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="separation", status="completed",
                     entity_id=emp.company or "", employee_id=emp.id, subject_name=plan["subjectName"],
                     subject_email=plan["to"] or "", setting_id=plan["setting"].id if plan["setting"] else "",
                     template_id=plan["template"].id if plan["template"] else "", inputs=dict(d),
                     effective_date=d["last_day"], apply_status="scheduled",
                     created_by=user["email"].lower(), created_at=now, updated_at=now, completed_at=now)
    db.add(ev)
    if plan["package"]:
        ev.status, ev.completed_at = "awaiting_sender", ""
        first = plan["parties"][0] if plan["parties"] else None
        sender_first = bool(first and first.email == user["email"].lower() and first.email != ev.subject_email)
        from fastapi import HTTPException
        from routers.esign import envelope_from_template
        try:
            out = envelope_from_template(
                db, user, plan["template"], parties=plan["parties"], title=plan["title"],
                employee_id=emp.id, entity_id=emp.company or "", merge=plan["merge"],
                message=plan["setting"].email_message or "", ip=ip, user_agent=user_agent,
                excluded_ack=excluded_ack, link_kind="life_event", link_id=ev.id,
                sender_signs_first=sender_first)
        except HTTPException as e:
            raise PacketError(str(e.detail), e.status_code)
        ev.sign_request_id = out["id"]
        if not sender_first:
            ev.status = "sent"
    db.commit()
    result = {}
    if d["immediate"]:
        result = apply_separation_now(db, ev)
    else:
        for to in {ev.created_by, (emp.manager_email or "").lower()} - {""}:
            _notify(db, to, f"Offboarding scheduled - {ev.subject_name}",
                    f"{ev.subject_name}'s last day is {us_date(d['last_day'])}. Nexus marks them Left the morning "
                    f"after (items, tasks, Microsoft 365) by itself.", ev)
        db.commit()
    return ev, result


def cancel_separation(db: Session, ev: HrLifeEvent, actor: str) -> None:
    if ev.kind != "separation" or ev.apply_status != "scheduled":
        raise PacketError("Only an offboarding that hasn't happened yet can be canceled.", 409)
    ev.apply_status = "canceled"
    ev.apply_note = f"Canceled by {actor}"
    ev.updated_at = _now()
    if ev.sign_request_id and ev.status in ACTIVE:
        from routers.esign import void_request
        db.commit()
        void_request(ev.sign_request_id, user={"email": actor}, db=db)
        return
    db.commit()


def apply_due_separations(limit: int = 20) -> int:
    """The last day is over: mark them Left (point 5, Pranshu Oct 8). Runs
    the morning AFTER the last day in BUSINESS_TZ - the person works their
    last day with their email and Nexus intact; cutting them off at midnight
    UTC would be mid-afternoon the day before in California."""
    from database import SessionLocal
    db = SessionLocal()
    n = 0
    try:
        today = _today()
        ids = [r.id for r in db.query(HrLifeEvent).filter(HrLifeEvent.kind == "separation",
                                                           HrLifeEvent.apply_status == "scheduled",
                                                           HrLifeEvent.effective_date < today)
               .limit(limit).all()]
        for eid in ids:
            ev = (db.query(HrLifeEvent).filter(HrLifeEvent.id == eid, HrLifeEvent.apply_status == "scheduled")
                  .with_for_update().first())
            if not ev:
                continue
            try:
                apply_separation_now(db, ev)
                _notify(db, ev.created_by, f"{ev.subject_name} is now Left",
                        f"Their last day was {us_date(ev.effective_date)}. {ev.apply_note}.", ev)
                db.commit()
                n += 1
            except Exception as e:      # retried on the next pass
                db.rollback()
                print(f"[life-events] offboarding {eid} not applied: {type(e).__name__}: {e}")
    finally:
        db.close()
    return n


def _apply_separation_signed(db: Session, ev: HrLifeEvent, req: HrSignRequest) -> None:
    ev.apply_note = (ev.apply_note + "; " if ev.apply_note else "") + "Separation package signed"


_APPLY["separation"] = _apply_separation_signed


# ── Egnyte filing ────────────────────────────────────────────────────────────

def file_one(db: Session, ev: HrLifeEvent) -> tuple:
    """Create the person's Egnyte folder (if needed) and file the sealed packet
    and any signer attachments into its event subfolder. (ok, message)."""
    from routers import esign
    import egnyte_wiring
    import services.egnyte as svc
    req = db.query(HrSignRequest).filter(HrSignRequest.id == ev.sign_request_id).first()
    if not req or req.status != "completed" or not req.final_pdf_path:
        return False, "The signed packet is not sealed yet."
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).first() if ev.employee_id else None
    if not emp:
        return False, "There is no employee record to file this under."
    if not svc.configured():
        return False, "Egnyte is not connected."
    try:
        folder = egnyte_wiring.provision_person_folder(emp, db)
    except ValueError as e:
        return False, str(e)
    setting = db.query(HrPacketSetting).filter(HrPacketSetting.id == ev.setting_id).first() if ev.setting_id else None
    sub = _safe_name((setting.egnyte_subfolder if setting else "") or DEFAULT_SUBFOLDERS.get(ev.kind, ""), 60)
    target = svc.norm(f"{folder}/{sub}")
    svc.create_folder(target)
    blob = esign._storage_fetch(esign._DOC_BUCKET, req.final_pdf_path)
    if not blob.is_success:
        return False, "Could not read the sealed packet from storage."
    day = (req.completed_at or _now())[:10]
    name = f"{day} - {EVENT_TITLES.get(ev.kind, 'Document')} - {_safe_name(ev.subject_name, 60)} (signed).pdf"
    svc.upload_file(f"{target}/{name}", blob.content)
    req.egnyte_folder = target          # where it went; attachments follow it
    n_att = esign._egnyte_push_attachments(db, req)
    esign._log(db, req.id, "archived", f"filed in Egnyte {target}/{name}"
               + (f", with {n_att} attachment{'s' if n_att != 1 else ''}" if n_att else ""))
    return True, f"{target}/{name}"


def run_filing(db: Session, ev: HrLifeEvent) -> None:
    """One filing attempt with retry bookkeeping. Commits."""
    try:
        ok, msg = file_one(db, ev)
    except Exception as e:      # Egnyte/network trouble - retry later
        ok, msg = False, f"{type(e).__name__}: {str(e)[:200]}"
    ev.updated_at = _now()
    if ok:
        ev.filing_status, ev.filing_path, ev.filing_error, ev.filing_next_at = "filed", msg, "", ""
    else:
        ev.filing_attempts = (ev.filing_attempts or 0) + 1
        ev.filing_error = msg[:500]
        if ev.filing_attempts >= len(FILING_BACKOFF_MIN):
            ev.filing_status, ev.filing_next_at = "failed", ""
            _notify(db, ev.created_by, f"Not filed in Egnyte - {ev.subject_name}",
                    f"The signed {EVENT_TITLES.get(ev.kind, 'packet').lower()} is safe in Nexus, "
                    f"but it could not be filed in Egnyte: {msg} Fix it, then use Retry on the person.", ev)
        else:
            wait = FILING_BACKOFF_MIN[ev.filing_attempts - 1]
            ev.filing_status = "pending"
            ev.filing_next_at = (datetime.now(timezone.utc) + timedelta(minutes=wait)).isoformat()
    db.commit()


def process_due(limit: int = 10) -> int:
    """The filing pass: every completed event whose filing is due. Runs in a
    worker thread (life_events_loop), never on the event loop."""
    from database import SessionLocal
    db = SessionLocal()
    done = 0
    try:
        now = _now()
        ids = [r.id for r in (db.query(HrLifeEvent)
                              .filter(HrLifeEvent.filing_status == "pending",
                                      HrLifeEvent.filing_next_at != "",
                                      HrLifeEvent.filing_next_at <= now)
                              .order_by(HrLifeEvent.filing_next_at).limit(limit).all())]
        for eid in ids:
            ev = (db.query(HrLifeEvent).filter(HrLifeEvent.id == eid,
                                               HrLifeEvent.filing_status == "pending")
                  .with_for_update().first())
            if ev:
                run_filing(db, ev)
                done += 1
    finally:
        db.close()
    return done


async def life_events_loop():
    """Files signed packets into Egnyte (and, later, applies dated changes).
    Blocking work goes to a thread - see CLAUDE.md, never on the loop."""
    await asyncio.sleep(75)   # let startup settle
    while True:
        try:
            await asyncio.to_thread(process_due)
        except Exception as e:
            print(f"[life-events] filing pass failed: {e}")
        try:
            await asyncio.to_thread(apply_due_separations)
        except Exception as e:
            print(f"[life-events] offboarding pass failed: {e}")
        await asyncio.sleep(LOOP_EVERY_SEC)
