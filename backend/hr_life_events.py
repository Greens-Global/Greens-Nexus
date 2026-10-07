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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe(fn, *a, **kw) -> None:
    """Run a Nexus Sign callback in a SAVEPOINT. An error rolls back only what
    the callback wrote and is logged - the signature it rides on stands."""
    db = a[0]
    sp = db.begin_nested()
    try:
        fn(*a, **kw)
        sp.commit()
    except Exception as e:   # pragma: no cover - logged, never raised
        sp.rollback()
        print(f"[life-events] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


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
            parties.append({"id": p.id, "name": p.name, "email": p.email, "status": p.status,
                            "order": p.ordinal, "signedAt": p.signed_at or "",
                            "isSubject": p.email == (ev.subject_email or "").lower()})
    out = {
        "id": ev.id, "kind": ev.kind, "title": EVENT_TITLES.get(ev.kind, ev.kind),
        "status": ev.status, "entityId": ev.entity_id, "candidateId": ev.candidate_id,
        "employeeId": ev.employee_id, "subjectName": ev.subject_name, "subjectEmail": ev.subject_email,
        "templateId": ev.template_id, "signRequestId": ev.sign_request_id,
        "inputs": ev.inputs or {}, "effectiveDate": ev.effective_date or "",
        "appliedAt": ev.applied_at or "", "applyNote": ev.apply_note or "", "flags": ev.flags or [],
        "filingStatus": ev.filing_status or "", "filingPath": ev.filing_path or "",
        "filingError": ev.filing_error or "", "filingAttempts": ev.filing_attempts or 0,
        "declineReason": ev.decline_reason or "", "createdBy": ev.created_by,
        "createdAt": ev.created_at, "completedAt": ev.completed_at or "", "parties": parties,
        "hasPay": bool(ev.pay),
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


def _hire_details(db: Session, cand: HrCandidate, inputs: dict) -> dict:
    """The offer HR entered, validated, falling back to the candidate card."""
    d = {
        "job_title": (inputs.get("job_title") or cand.role_title or "").strip(),
        "department": (inputs.get("department") or cand.department or "").strip(),
        "start_date": (inputs.get("start_date") or cand.expected_start or "").strip()[:10],
        "manager_email": (inputs.get("manager_email") or "").strip().lower(),
        "employment_type": (inputs.get("employment_type") or "full_time").strip(),
        "salary_text": (inputs.get("salary_text") or "").strip(),
        "merge": {k: str(v).strip() for k, v in (inputs.get("merge") or {}).items()
                  if re.fullmatch(r"[a-z0-9_]+", str(k)) and str(v).strip()},
    }
    from routers.hr import _EMPLOYMENT_TYPES
    if not d["job_title"]:
        raise PacketError("Enter the job title for the offer.")
    if not d["start_date"]:
        raise PacketError("Enter the start date for the offer.")
    try:
        datetime.strptime(d["start_date"], "%Y-%m-%d")
    except ValueError:
        raise PacketError("The start date is not a valid date.")
    if d["employment_type"] not in _EMPLOYMENT_TYPES:
        raise PacketError(f"Employment type must be one of {', '.join(_EMPLOYMENT_TYPES)}.")
    if d["manager_email"]:
        # People pickers are the curated Nexus People list - never a free email.
        if not db.query(NexusEmployee).filter(NexusEmployee.work_email == d["manager_email"]).first():
            raise PacketError("The supervisor must be someone in Nexus People.")
    return d


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
            "company": company}


def preview_out(plan: dict) -> dict:
    tpl = plan["template"]
    return {
        "title": plan["title"], "company": plan["company"],
        "templateId": tpl.id, "templateName": tpl.name,
        "documents": [tpl.name] + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")],
        "recipients": [{"order": p.ordinal, "role": p.role_key, "name": p.name, "email": p.email,
                        "isSubject": p.kind == "external"} for p in plan["parties"]],
        "unresolved": plan["unresolved"], "emailMessage": plan["setting"].email_message or "",
        "egnyteSubfolder": plan["subfolder"], "startDate": plan["details"]["start_date"],
        "salaryText": plan["merge"].get("salary", ""),
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
            message=plan["setting"].email_message or "", ip=ip, user_agent=user_agent,
            excluded_ack=excluded_ack, link_kind="life_event", link_id=ev.id,
            sender_signs_first=sender_first)
    except HTTPException as e:
        raise PacketError(str(e.detail), e.status_code)
    ev.sign_request_id = out["id"]
    if not sender_first:
        ev.status = "sent"
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                        to_stage=cand.stage, by_email=user["email"], created_at=now,
                        note=f"Hiring packet sent to {ev.subject_email}"))
    db.commit()
    return ev


def sender_party_id(db: Session, ev: HrLifeEvent, email: str) -> str:
    """The party the sender signs as right now, if it is their turn."""
    if ev.status != "awaiting_sender" or not ev.sign_request_id:
        return ""
    p = (db.query(HrSignParty)
         .filter(HrSignParty.request_id == ev.sign_request_id, HrSignParty.email == (email or "").lower(),
                 HrSignParty.status.in_(("waiting", "notified", "viewed")))
         .order_by(HrSignParty.ordinal).first())
    return p.id if p else ""


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


def _notify(db: Session, to: str, title: str, body: str, ev: HrLifeEvent) -> None:
    from routers.hr import _hr_notify
    sub = "hr-hiring" if ev.kind == "hire" and not ev.employee_id else "hr-people"
    _hr_notify(db, to, title, body, ref_id=ev.id, requested_by="nexus-sign",
               action={"view": "hr", "sub": sub})


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


def _apply_hire(db: Session, ev: HrLifeEvent, req: HrSignRequest) -> None:
    """The packet is signed: the candidate is hired. Same function Mark Hired
    uses, so a signed packet and a manual hire build the same employee."""
    from routers.hr import create_employee_from_candidate
    cand = (db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id)
            .with_for_update().first())
    if not cand:
        ev.apply_note = "The candidate was deleted before the packet was signed - nobody was hired."
        return
    emp = (db.query(NexusEmployee).filter(NexusEmployee.id == cand.employee_id).first()
           if cand.employee_id else None)
    details = ev.inputs or {}
    if emp is None:
        emp = create_employee_from_candidate(db, cand, ev.created_by, details=details)
        note = "Hiring packet signed - hired automatically"
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
    ev.applied_at = now
    ev.updated_at = now
    ev.filing_status = "pending"
    ev.filing_next_at = now
    ev.filing_attempts = 0


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
        await asyncio.sleep(LOOP_EVERY_SEC)
