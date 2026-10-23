"""HR life events through Nexus Sign (Neil/Pranshu call, Oct 8): the hiring
packet first, promotion and separation on the same engine.

    HR starts it from the person -> the company's packet template (merged PDFs,
    set per company in hr_packet_settings) is filled from what HR entered ->
    the person signs FIRST, HR countersigns after (Neil, Oct 22 2026: the
    company never signs before the employee) -> when it is fully signed the
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

import hr_checklist_seed
from currency import is_currency, money_prefix
from models import (HrCandidate, HrEntity, HrLifeEvent, HrPacketSetting, HrSignParty,
                    HrSignRequest, HrSignTemplate, HrStageEvent, NexusEmployee)

# The offer comes first (Neil, Oct 14): "there is a document to sign, but it's
# a single document called an offer letter" - both sides sign it and the
# candidate is hired. Only then the hiring packet ("right to work
# compliance"): "if they don't accept the offer letter, you don't send them a
# hiring packet".
EVENTS = ("offer", "hire", "promotion", "separation")
CANDIDATE_KINDS = ("offer", "hire")         # events about a candidate, run from Hiring
WORKER_TYPES = ("any", "employee", "contractor")
ACTIVE = ("awaiting_sender", "sent")
# A packet built from Documents (Oct 14) exists before it is sent: waiting on
# the person's details (intake) or on HR's check (review). Busy all the same -
# nobody starts a second packet, nobody rejects the candidate under it.
OPEN = ("intake", "review") + ACTIVE
EVENT_TITLES = {"offer": "Offer Letter", "hire": "Hiring Packet", "promotion": "Promotion Letter",
                "separation": "Separation Package"}
DEFAULT_SUBFOLDERS = {"offer": "Hiring Documents", "hire": "Hiring Documents", "promotion": "Promotion Documents",
                      "separation": "Separation Documents"}
PAY_BASES = ("hourly", "salary")
PAY_FREQUENCIES = ("weekly", "biweekly", "semimonthly", "monthly", "annual")
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
            _notify(db, ev.created_by, f"Needs Attention - {EVENT_TITLES.get(ev.kind, 'Packet')} for {ev.subject_name}",
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
    sym = money_prefix(pay.get("currency") or "USD")
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
    """Whether the template prints the pay HR types - {{salary}} in its typed
    letter, or a Salary offer field placed on one of its PDFs. Pay typed for a
    template that never shows it is stored and applied but the person never
    reads it - the preview says so (Pranshu, Oct 8)."""
    from routers.esign import attachment_merge_keys
    return (any("{{salary}}" in str(p) for p in (tpl.body or []))
            or "salary" in attachment_merge_keys(tpl.attachments or []))


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
    cur = str(pay.get("currency") or "USD").strip().upper()
    if not is_currency(cur):
        raise ValueError("Pick a currency from the list.")
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

def _sendable():
    """A packet row that can go out: an uploaded-PDF packet with its template,
    or a packet built from Documents (Oct 14)."""
    from sqlalchemy import or_
    return or_(HrPacketSetting.template_id != "", HrPacketSetting.engine == "documents")


def is_documents(s: Optional[HrPacketSetting]) -> bool:
    return bool(s is not None and (s.engine or "pdf") == "documents")


def resolve_setting(db: Session, entity_id: str, event: str, worker_type: str,
                    role_id: str = "", country: str = "", documents_only: bool = False,
                    region: str = "") -> Optional[HrPacketSetting]:
    """The letter or packet that goes out for an event - PLACE FIRST (Neil,
    Oct 22): "there is a hiring packet that applies to California... an
    independent contractor packet that applies to India... When we open Texas
    we'll add one for Texas", and "if you've connected the India packet to the
    admin associate role, then it's an issue". A packet fits when its company
    (or every company), its country and state (or any), its kind of hire (or
    any) and, if it names roles, the role all fit. Of those the most specific
    wins: country, then state, then employee / contractor, then the company's
    own over every company's - and only last a role's own (a role adds its job
    description and confidentiality agreement to the packet; it does not pick
    a different place's paperwork). A packet for another country or state
    never matches. No country given = the company's own; no state = the
    company's, when the person works in the company's country. A row without
    a template does not count. documents_only: the packet that follows a
    signed offer starts by itself, which an uploaded-PDF packet cannot - those
    are skipped."""
    role_id = (role_id or "").strip()
    home = country_of(db, entity_id)
    country = re.sub(r"[^A-Za-z]", "", country or "").upper()[:2] or home
    region = re.sub(r"[^A-Za-z]", "", region or "").upper()[:3]
    if not region and country and country == home:
        region = region_of(db, entity_id)
    rows = (db.query(HrPacketSetting)
            .filter(HrPacketSetting.entity_id.in_([entity_id or "", ""]), HrPacketSetting.event == event,
                    _sendable()).all())
    best, best_key = None, None
    for r in rows:
        if documents_only and not is_documents(r):
            continue
        rc, rr = (r.country or "").upper(), (r.region or "").upper()
        wt, roles = (r.worker_type or "any"), (r.role_ids or [])
        if rc not in ("", country) or (rr and rr != region) or wt not in ("any", worker_type):
            continue
        if roles and role_id not in roles:
            continue
        key = (bool(rc), bool(rr), wt != "any", bool(r.entity_id), bool(roles), r.updated_at or "", r.id)
        if best_key is None or key > best_key:
            best, best_key = r, key
    return best


def country_of(db: Session, entity_id: str) -> str:
    """Where a company's people work by default - its own country (US, IN...)."""
    e = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return ((e.country if e else "") or "").strip().upper()[:2]


def place_label(worker_type: str, country: str, region: str = "") -> str:
    """'Employees in California', 'Contractors anywhere' - what a packet covers."""
    who = {"employee": "Employees", "contractor": "Contractors"}.get(worker_type or "", "Employees and contractors")
    where = place_words(country, region)
    return f"{who} in {where}" if where else f"{who} anywhere"


def region_of(db: Session, entity_id: str) -> str:
    """The state a company's people work in by default (CA, TX) - '' if unset."""
    e = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return re.sub(r"[^A-Za-z]", "", (getattr(e, "region", "") if e else "") or "").upper()[:3]


WORKER_LABELS = {"employee": "Employee", "contractor": "Contractor"}


US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
    "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
}


def place_words(country: str, region: str = "") -> str:
    """'California', 'Texas', 'India' - a place the way people say it."""
    from hr_packet_docs import _country_name
    country, region = (country or "").upper(), (region or "").upper()
    if country == "US" and region:
        return US_STATES.get(region, f"{region}, United States")
    return _country_name(country)


def kind_of_hire(worker_type: str, country: str, region: str = "") -> str:
    """'a Contractor in India', 'an Employee in California' - how HR reads
    which letter a hire needs."""
    who = WORKER_LABELS.get(worker_type, "hire")
    where = place_words(country, region)
    return f"{'an' if who[0] in 'AEIOU' else 'a'} {who}" + (f" in {where}" if where else "")


def packet_choices(db: Session, entity_id: str, event: str) -> list:
    """Every packet a company could send for an event: its own and the ones
    for every company, with a template. HR may pick any of them in place
    of the one Nexus resolves (Pranshu, Oct 8)."""
    rows = (db.query(HrPacketSetting)
            .filter(HrPacketSetting.event == event, _sendable(),
                    HrPacketSetting.entity_id.in_([entity_id or "", ""])).all())
    return sorted(rows, key=lambda r: (r.entity_id == "", not (r.role_ids or []),
                                       (r.worker_type or "any") == "any"))


def packet_choice(db: Session, entity_id: str, event: str, setting_id: str) -> Optional[HrPacketSetting]:
    return next((r for r in packet_choices(db, entity_id, event) if r.id == setting_id), None)


def role_id_for_employee(db: Session, emp: NexusEmployee) -> str:
    """The job role an employee holds, by title - People records carry the
    title, not the role id."""
    role = _role_named(db, emp.company or "", emp.job_title or "")
    return role.id if role else ""


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
    if is_documents(s):
        import hr_packet_docs as hpd
        return hpd.config_problems(db, s)
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
    # The person signs first whatever the template's order (_parties_for,
    # Neil, Oct 22 2026) - an old company-first template is never refused.
    return out


def _tname(db: Session, tid: str) -> str:
    from models import DocTemplate
    t = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    return t.name if t else "A template that no longer exists"


def ser_setting(db: Session, s: HrPacketSetting) -> dict:
    from models import NexusGroup
    role_ids = [r for r in (s.role_ids or []) if r]
    names = ({g.id: g.name for g in db.query(NexusGroup).filter(NexusGroup.id.in_(role_ids)).all()}
             if role_ids else {})
    if is_documents(s):
        # A packet built from Documents (Oct 14): templates + a signing order
        # by role. templateName/signers keep the packet list's columns working.
        import hr_packet_docs as hpd
        docs = hpd.ser_documents(db, s)
        flow = hpd.ser_flow(db, s)
        snaps = hpd.load_snaps(db, list(s.doc_template_ids or []) + [t for t in hpd.all_block_ids(s)
                                                                       if t not in (s.doc_template_ids or [])])[0]
        return {"id": s.id, "engine": "documents", "entityId": s.entity_id or "", "event": s.event,
                "workerType": s.worker_type, "country": s.country or "", "region": s.region or "",
                "place": place_label(s.worker_type, s.country, s.region),
                "name": s.name or "", "templateId": "",
                "extraDocs": [{**r, "templateNames": [_tname(db, t) for t in r.get("templateIds") or []]}
                              for r in (s.extra_docs or []) if isinstance(r, dict)],
                "templateName": s.name or "Unnamed packet",
                "roleIds": role_ids, "roleNames": [names.get(r, "a role that no longer exists") for r in role_ids],
                "docTemplateIds": list(s.doc_template_ids or []), "docTemplates": docs,
                "documents": [d["name"] for d in docs], "hasLetter": False,
                "flow": flow, "signers": [f"{f['roleLabel']} ({f['actionLabel']})" for f in flow],
                "verifyRole": s.verify_role or "hr", "verifyDistinct": bool(s.verify_distinct),
                "letterheadId": s.letterhead_id or "", "payMode": s.pay_mode or "",
                "emailMessage": s.email_message or "", "egnyteSubfolder": s.egnyte_subfolder or "",
                "effectiveSubfolder": (s.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS.get(s.event, ""),
                # The Details Form and, for a company's packet, who signs once
                # and whether they have (Oct 14).
                "detailsForm": list(s.details_form or []),
                # What the documents themselves ask (Oct 14): the person's
                # questions go on their form by themselves; HR's are asked
                # when the offer is made or the packet starts.
                "templateForm": hpd.template_form(snaps), "hrQuestions": hpd.hr_questions(snaps),
                "signOnce": hpd.company_once_status(db, s, db.query(HrEntity).filter(HrEntity.id == s.entity_id).first())
                if s.entity_id else [],
                # Ready To Send (Oct 14): every check a hire needs, with its fix.
                "readiness": hpd.readiness(db, s),
                "problems": setting_problems(db, s), "updatedBy": s.updated_by or "", "updatedAt": s.updated_at or ""}
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == s.template_id).first() if s.template_id else None
    return {"id": s.id, "engine": "pdf", "entityId": s.entity_id or "", "event": s.event, "workerType": s.worker_type,
            "templateId": s.template_id or "", "templateName": tpl.name if tpl else "",
            "roleIds": role_ids, "roleNames": [names.get(r, "a role that no longer exists") for r in role_ids],
            "signers": [r.get("label") or r.get("key") for r in template_roles(tpl)] if tpl else [],
            "documents": [a.get("name", "document.pdf") for a in ((tpl.attachments or []) if tpl else []) if a.get("path")],
            "hasLetter": bool(tpl and tpl.body),
            "attachments": (tpl.attachments or []) if tpl else [], "roles": (tpl.roles or []) if tpl else [],
            "body": (tpl.body or []) if tpl else [],
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
                            "isSubject": p.email == (ev.subject_email or "").lower(),
                            "partyRole": p.party_role or "signer"})
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
        "hasPay": bool(ev.pay or ev.pay_values), "applyStatus": ev.apply_status or "",
        # Packets built from Documents (Oct 14).
        "engine": "documents" if (ev.documents or ev.status in ("intake", "review")) else "pdf",
        "documents": [{"documentId": d.get("documentId"), "title": d.get("title", "")} for d in (ev.documents or [])],
        "verifiedBy": ev.verified_by or "", "verifiedAt": ev.verified_at or "",
    }
    if show_pay:
        out["pay"] = ev.pay or {}
        out["payValues"] = dict(ev.pay_values or {})
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


def role_paperwork(role) -> dict:
    """{role_description, role_docs} - the duties a white-label Job Description
    prints and the role's own documents, frozen into an offer's details."""
    if role is None:
        return {"role_description": "", "role_docs": []}
    docs = [{"templateId": str(r.get("templateId") or ""), "replaces": str(r.get("replaces") or "")}
            for r in (getattr(role, "hiring_docs", None) or []) if isinstance(r, dict) and r.get("templateId")]
    return {"role_description": (getattr(role, "job_description", "") or role.description or "").strip(),
            "role_docs": docs}


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
        # The packet HR chose, when they changed it from the one Nexus picked
        # for the company and role ('' = Nexus's pick).
        "packet_id": (inputs.get("packet_id") or "").strip(),
        "merge": {k: str(v).strip() for k, v in (inputs.get("merge") or {}).items()
                  if re.fullmatch(r"[a-z0-9_]+", str(k)) and str(v).strip()},
        # What the role brings to the paperwork, as it stands when the offer is
        # made (Neil, Oct 22): its duties text and its own documents.
        **role_paperwork(role),
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
                      description=f"Added while hiring {for_name} - set its access.",
                      created_from="hiring", created_by=by, created_at=_now())
    db.add(role)
    admins = {r.email.lower() for r in db.query(NexusRole).filter(NexusRole.role.in_(("owner", "administrator"))).all()}
    from routers.hr import _hr_notify
    for to in admins | {by.lower()}:
        _hr_notify(db, to, f"New Role Needs Access - {name}",
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
    """One party per template role: the subject role is the person, 'manager'
    is their manager when one is given, every other role is the HR sender.
    The person signs FIRST and everyone else after, in the template's order -
    the company never signs before the person (Neil, Oct 22 2026)."""
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
                           ordinal=1 if key == subject_role else int(r.get("order") or 1) + 1,
                           party_role="signer"))
    return sorted(out, key=lambda p: p.ordinal)


def _load_candidate(db: Session, cid: str, scope, lock: bool = False) -> HrCandidate:
    q = db.query(HrCandidate).filter(HrCandidate.id == cid)
    cand = (q.with_for_update().first() if lock else q.first())
    if not cand or (scope is not None and (cand.company or "") not in scope):
        raise PacketError("Candidate not found", 404)
    return cand


def active_hire_event(db: Session, cid: str) -> Optional[HrLifeEvent]:
    """The offer letter or hiring packet still out for this candidate, if
    any. The pipeline checks it before moving the candidate away from Offer: a
    letter that is signable while the candidate is Rejected (or back in
    Interview) would hire someone HR had decided against."""
    if not cid:
        return None
    return (db.query(HrLifeEvent)
            .filter(HrLifeEvent.candidate_id == cid, HrLifeEvent.kind.in_(CANDIDATE_KINDS),
                    HrLifeEvent.status.in_(OPEN)).first())


def signed_offer(db: Session, cid: str) -> Optional[HrLifeEvent]:
    """The candidate's signed offer letter, if they have one."""
    if not cid:
        return None
    return (db.query(HrLifeEvent)
            .filter(HrLifeEvent.candidate_id == cid, HrLifeEvent.kind == "offer",
                    HrLifeEvent.status == "completed")
            .order_by(HrLifeEvent.completed_at.desc()).first())


def reroute_hire_packet(db: Session, cand: HrCandidate, new_email: str, by: str) -> bool:
    """HR corrected the candidate's email while their packet is out: the
    packet follows the correction (fresh link, old one dead, re-invited if it
    is their turn). Without this the offer keeps going to the typo."""
    ev = active_hire_event(db, cand.id)
    if ev is not None and ev.status in ("intake", "review"):
        # Not sent yet (Oct 14): the packet simply goes to the corrected address.
        ev.subject_email, ev.updated_at = new_email.strip().lower(), _now()
        _stage_note(db, ev, f"{EVENT_TITLES.get(ev.kind, 'Packet')} will go to {ev.subject_email}", by=by)
        if ev.status == "intake" and ev.intake_token_hash:
            # The details link went to the typo - a fresh one, the old one dead.
            refresh_due(ev)
            mail_intake_after_commit(db, ev, new_intake_token(ev))
        return True
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


def hire_ctx(db: Session, cand: HrCandidate, details: dict, entity: Optional[HrEntity], sender: str) -> dict:
    """Who each role of a documents hiring packet is, for this candidate: the
    candidate signs from their personal email (external), Manager is the
    supervisor on the offer (else the role's default manager)."""
    import hr_checklists as hc
    manager = (details.get("manager_email") or "").strip().lower()
    if not manager and details.get("role_id"):
        from models import NexusGroup
        role = db.query(NexusGroup).filter(NexusGroup.id == details["role_id"]).first()
        manager = (role.default_manager_email or "").strip().lower() if role else ""
    return {"subject_email": (cand.email or "").strip().lower(), "subject_emails": [cand.email or ""],
            "subject_name": f"{cand.first_name} {cand.last_name}".strip(), "subject_kind": "external",
            "manager_email": manager, "entity": entity, "owners": hc.role_owners(db, cand.company or ""),
            "sender": (sender or "").lower(), "verifier_role": details.get("verifier_role") or ""}


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
    entity = db.query(HrEntity).filter(HrEntity.id == cand.company).first()
    company = entity.name if entity else "this company"
    if details["packet_id"]:
        setting = packet_choice(db, cand.company, "hire", details["packet_id"])
        if setting is None:
            raise PacketError("That packet is not one this company can send - pick another.", 409)
    else:
        setting = resolve_setting(db, cand.company, "hire", wt, details["role_id"])
    if not setting:
        raise PacketError(f"No hiring packet is set up for {company} yet - add one under "
                          f"Settings > Hiring > Hiring Documents.", 409)
    # The offer comes first (Neil, Oct 14): where an offer letter is set up
    # for this hire, the packet goes out by itself once the offer is signed.
    if resolve_setting(db, cand.company, "offer", wt, details["role_id"], country_of(db, cand.company)) is not None:
        raise PacketError("Send the offer letter first - the hiring packet goes out by itself once they sign it.", 409)
    name = f"{cand.first_name} {cand.last_name}".strip()
    if is_documents(setting):
        # Built from Documents (Oct 14): previewed here; it goes out through
        # Start Hiring Packet, review and Verify And Send.
        import hr_packet_docs as hpd
        dp = hpd.plan(db, setting, ctx=hire_ctx(db, cand, details, entity, user["email"]),
                      overrides=hpd.event_values(db, "hire", details), pay=clean, can_see_pay=bool(clean),
                      candidate_id=cand.id, entity_id=cand.company or "")
        return {"candidate": cand, "details": details, "pay": clean, "setting": setting, "template": None,
                "docplan": dp, "merge": {}, "unresolved": [], "parties": [], "subjectName": name,
                "title": f"{EVENT_TITLES['hire']} - {name}", "company": company, "former": former,
                "subfolder": (setting.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS["hire"]}
    problems = setting_problems(db, setting)
    if problems:
        raise PacketError(f"The {company} hiring packet needs fixing: {problems[0]}", 409)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == setting.template_id).first()
    merge = _hire_merge(db, details, clean)
    from routers.esign import resolve_template
    _snapshot, unresolved = resolve_template(db, tpl, candidate_id=cand.id,
                                             entity_id=cand.company, overrides=merge)
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
    rehire = ({"employeeId": former.id, "employeeCode": former.employee_code or "",
               "name": f"{former.first_name} {former.last_name}".strip(), "status": former.status or ""}
              if former is not None else None)
    if plan.get("docplan") is not None:
        dp = plan["docplan"]
        return {"engine": "documents", "title": plan["title"], "company": plan["company"],
                "packetName": plan["setting"].name or "", "documents": [d["name"] for d in dp["documents"]],
                "documentDetails": dp["documents"], "recipients": dp["recipients"], "verifier": dp["verifier"],
                "problems": dp["problems"], "printsPay": dp["printsPay"],
                "unresolved": sorted({t for d in dp["documents"] for t in d["unresolved"]}),
                "emailMessage": plan["setting"].email_message or "", "egnyteSubfolder": plan["subfolder"],
                "startDate": plan["details"]["start_date"], "expiresOn": plan["details"]["offer_expires"],
                "jobTitle": plan["details"]["job_title"], "newRole": plan["details"]["new_role_name"],
                "rehire": rehire}
    return {
        "title": plan["title"], "company": plan["company"],
        "templateId": tpl.id, "templateName": tpl.name,
        "documents": ([tpl.name] if tpl.body else []) + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")],
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
    """Send the company's hiring packet to a candidate at Offer. The
    candidate is invited at once and signs first; HR (the sender)
    countersigns after them (Neil, Oct 22 2026)."""
    plan = plan_hire(db, user, cid, inputs, pay, scope, lock=True)
    cand = plan["candidate"]
    if plan.get("docplan") is not None:
        # Never sent unverified: a packet built from Documents goes out only
        # through Start Hiring Packet -> review -> Verify And Send.
        raise PacketError("This packet is built from Documents - use Start Hiring Packet; it is sent once "
                          "HR has verified it.", 409)
    if plan["unresolved"]:
        raise PacketError("Fill in: " + ", ".join(plan["unresolved"]) + ".")
    busy = (db.query(HrLifeEvent)
            .filter(HrLifeEvent.candidate_id == cand.id, HrLifeEvent.kind == "hire",
                    HrLifeEvent.status.in_(OPEN)).first())
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
            sender_signs_first=sender_first,
            prints_pay=pay_in_letter(plan["template"]) or bool(plan["pay"])
            or bool(plan["details"].get("salary_text")))
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


# ── packets built from Documents: start, edit, void (Oct 14) ─────────────────
# Start -> the documents are generated at once -> the verifier reviews them ->
# Verify And Send (hr_packet_docs.verify_and_send). Nothing reaches Nexus Sign
# before the verifier has checked it.

INTAKE_FIELDS = ("first_name", "last_name", "preferred_name", "phone", "address", "permanent_address",
                 "emergency_name", "emergency_relationship", "emergency_phone")
INTAKE_REQUIRED = ("first_name", "last_name", "phone", "address")
_INTAKE_MAX = {"address": 300, "permanent_address": 300}


def clean_intake(values: Optional[dict]) -> dict:
    """The person's details: known fields only, trimmed and capped, no control
    characters. Never a national ID number."""
    out = {}
    for k in INTAKE_FIELDS:
        v = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str((values or {}).get(k) or "")).strip()
        if v:
            out[k] = v[:_INTAKE_MAX.get(k, 120)]
    return out


def four_options(inputs: dict) -> dict:
    """The Four Options (Neil, Oct 14: "the only thing that changes ... role,
    job description ... timings, pay") beyond the role and pay HR already
    picks: the work timings and the job description template."""
    days = [str(d).lower()[:3] for d in (inputs.get("work_days") or [])
            if str(d).lower()[:3] in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")]
    return {"work_start": str(inputs.get("work_start") or "").strip()[:5],
            "work_end": str(inputs.get("work_end") or "").strip()[:5],
            "work_days": list(dict.fromkeys(days)),
            "timings_text": str(inputs.get("timings_text") or "").strip()[:200],
            "jd_template_id": str(inputs.get("jd_template_id") or "").strip()}


def _check_jd(db: Session, jd_id: str) -> None:
    if not jd_id:
        return
    from models import DocTemplate
    t = db.query(DocTemplate).filter(DocTemplate.id == jd_id).first()
    if not t or t.status != "active" or (t.category or "") != "job_description":
        raise PacketError("Pick a Job Description from Documents > Templates (category Job Description).")


def clean_pay_values(db: Session, setting: HrPacketSetting, values: Optional[dict], jd_id: str = "",
                     inputs: Optional[dict] = None) -> dict:
    """Pay typed per pay variable of THIS packet - "$22.00 per hour plus
    commission". Only pay variables, at most 200 characters each."""
    import hr_packet_docs as hpd
    ids = hpd.template_ids_for(setting, {**(inputs or {}), "jd_template_id": jd_id}, "hire")
    snaps, _ = hpd.load_snaps(db, ids)
    allowed = hpd.pay_tokens(snaps) | {"salary"}
    out = {}
    for k, v in (values or {}).items():
        k = str(k).strip()
        v = re.sub(r"[\x00-\x1f\x7f]", "", str(v or "")).strip()[:200]
        if not v:
            continue
        if k not in allowed:
            raise PacketError(f'"{k}" is not a pay detail of this packet.')
        out[k] = v
    return out


def reserve_code(db: Session) -> str:
    """The employee number a hire's documents can print before the hire
    exists: the next free one, counting numbers already promised to hires
    still in progress, so two packets never print the same number."""
    from routers.hr import _next_code
    best = _next_code(db)
    taken = {(e.inputs or {}).get("employee_code") for e in db.query(HrLifeEvent)
             .filter(HrLifeEvent.kind.in_(CANDIDATE_KINDS), HrLifeEvent.status.in_(OPEN)).all()}
    m = re.fullmatch(r"GG-(\d+)", best)
    n = int(m.group(1)) if m else 1
    while f"GG-{n:03d}" in taken:
        n += 1
    return f"GG-{n:03d}"


def start_hire(db: Session, user: dict, cid: str, inputs: dict, pay: Optional[dict], pay_values: Optional[dict],
               details: Optional[dict], scope, intake_mode: str = "hr") -> tuple:
    """Start Hiring Packet. HR fills the details: the documents are generated
    at once and the verifier is asked to check them. The candidate fills them:
    they get a link, and the documents are generated when they submit.
    Returns (event, intake token or ''). Commits."""
    import hr_packet_docs as hpd
    plan = plan_hire(db, user, cid, inputs, pay, scope, lock=True)
    cand, setting, d = plan["candidate"], plan["setting"], plan["details"]
    if plan.get("docplan") is None:
        raise PacketError("This company's hiring packet is an uploaded PDF - use Send Hiring Packet.", 409)
    if active_hire_event(db, cand.id):
        raise PacketError("A hiring packet is already open for this candidate - void it first.", 409)
    opts = four_options(inputs or {})
    _check_jd(db, opts["jd_template_id"])
    person = clean_intake(details)
    by_candidate = intake_mode == "candidate"
    if not by_candidate and (not person.get("first_name") or not person.get("last_name")):
        raise PacketError("Enter their legal first and last name.")
    if not by_candidate:
        # The packet's own Details Form, filled by HR. What is still empty
        # shows on the review and blocks sending if the form requires it.
        try:
            answers = hpd.clean_answers(hpd.form_view(db, setting, hpd.template_ids_for(setting, {**d, **opts}, "hire")),
                                        (details or {}).get("answers"))
        except hpd.PacketProblem as e:
            raise PacketError(str(e))
        if answers:
            person["answers"] = answers
    now = _now()
    if d["new_role_name"]:
        role = create_company_role(db, cand.company, d["new_role_name"], d["department"], user["email"],
                                   plan["subjectName"])
        d["role_id"] = role.id
    extra = d.pop("merge", {}) or {}
    stored = {**d, **opts, "extra": extra, "verifier_role": setting.verify_role or "hr", "engine": "documents"}
    snaps, _ = hpd.load_snaps(db, hpd.template_ids_for(setting, {**d, **opts}, "hire"))
    if any("employee_code" in s.tokens for s in snaps):
        stored["employee_code"] = (plan["former"].employee_code if plan.get("former") is not None
                                   else reserve_code(db)) or ""
    name = (f"{person.get('first_name', '')} {person.get('last_name', '')}".strip()
            or f"{cand.first_name} {cand.last_name}".strip())
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="hire", status="intake" if by_candidate else "review",
                     entity_id=cand.company, candidate_id=cand.id, subject_name=name,
                     subject_email=cand.email.strip().lower(), setting_id=setting.id, template_id="",
                     inputs=stored, pay=plan["pay"],
                     pay_values=clean_pay_values(db, setting, pay_values, opts["jd_template_id"], d),
                     intake=person, effective_date=d["start_date"], documents=[],
                     created_by=user["email"].lower(), created_at=now, updated_at=now)
    db.add(ev)
    if by_candidate:
        token = new_intake_token(ev)
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage, to_stage=cand.stage,
                            by_email=user["email"], created_at=now,
                            note=f"Hiring packet started - {cand.first_name} was asked for their details"))
        db.commit()
        return ev, token
    card_from_intake(db, ev)
    db.flush()
    p = hpd.event_plan(db, ev, setting, sender=user["email"], can_see_pay=True)
    hpd.sync_documents(db, ev, setting, p, user["email"].lower())
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage, to_stage=cand.stage,
                        by_email=user["email"], created_at=now,
                        note=f"Hiring packet started - waiting for {p['verifier']['name'] or 'HR'} to verify"))
    _ask_verifier(db, ev, p)
    db.commit()
    return ev, ""


# ── the offer letter (Neil, Oct 14) ─────────────────────────────────────────
# Move To Offer -> HR answers the questions (who they are hired as and where,
# the role, start, pay, and whatever the letter itself asks of HR) -> Nexus
# picks the ONE offer letter for that kind of hire and fills it ("the
# document will make itself") -> the verifier checks it -> Nexus Sign: the
# company, then the candidate - from their email, no Nexus login -> signed
# by both = hired, and the hiring packet starts by itself.

OFFER_STAGES = ("applied", "screening", "interview", "decision", "offer")
# What an offer letter can print from the offer form beyond the role, start
# and pay - the form asks for one only when the letter prints it.
OFFER_PRINTS = ("address", "permanent_address", "preferred_name", "phone", "work_location", "work_schedule",
                "work_hours", "work_days", "manager", "supervisor", "offer_expires", "employee_code")


def offer_details(db: Session, cand: HrCandidate, inputs: dict) -> dict:
    """The offer HR entered, validated. Employee or contractor is HR's answer,
    never a guess (Neil: "we could have an accounting associate who is an
    employee. We could have an accounting associate who is a contractor")."""
    wt = str(inputs.get("worker_type") or "").strip().lower()
    if wt not in WORKER_LABELS:
        raise PacketError("Choose whether they are hired as an Employee or a Contractor - it decides which "
                          "offer letter goes.")
    et = str(inputs.get("employment_type") or "").strip()
    if wt == "contractor":
        et = "contractor"
    elif et in ("", "contractor"):
        et = "full_time"
    d = _hire_details(db, cand, {**inputs, "employment_type": et})
    country = re.sub(r"[^A-Za-z]", "", str(inputs.get("country") or "")).upper()[:2] or country_of(db, cand.company)
    # The state they work in (Neil, Oct 22: California and Texas get different
    # paperwork) - HR's answer, else the company's when it is the same country.
    region = re.sub(r"[^A-Za-z]", "", str(inputs.get("region") or "")).upper()[:3]
    if not region and country == country_of(db, cand.company):
        region = region_of(db, cand.company)
    d.update({"worker_type": wt, "country": country, "region": region,
              "work_location": re.sub(r"[\x00-\x1f\x7f]", "", str(inputs.get("work_location") or "")).strip()[:200]})
    frm = "department_head" if inputs.get("offer_from") == "department_head" else "hr"
    email = offer_from_people(db, cand.company, d["department"])[frm]
    if frm == "department_head" and not email:
        dept = f"The {d['department']} department" if d["department"] else "This role's department"
        raise PacketError(f"{dept} has no head set up - choose Head of HR, or set the head under "
                          f"Company Settings > Departments.")
    d.update({"offer_from": frm, "offer_from_email": email})
    return d


def offer_from_people(db: Session, company: str, department: str) -> dict:
    """Who an offer comes from (Neil, Oct 22): {"hr": the head of HR - the
    company's HR department head, else its HR contact; "department_head": the
    head of the role's department}. '' = nobody set up (or no longer here)."""
    from models import HrDepartment
    from hiring_screening import _person
    want = (department or "").strip().lower()
    hr = head = ""
    for row in db.query(HrDepartment).filter(HrDepartment.company_id == (company or "")).all():
        name, lead = (row.name or "").strip().lower(), (row.lead_email or "").strip().lower()
        if not _person(db, lead):
            continue
        if name in ("hr", "human resources") and not hr:
            hr = lead
        if want and name == want:
            head = lead
    if not hr:
        ent = db.query(HrEntity).filter(HrEntity.id == company).first() if company else None
        contact = ((ent.hr_contact_email if ent else "") or "").strip().lower()
        hr = contact if _person(db, contact) else ""
    return {"hr": hr, "department_head": head}


def _describe(db: Session, s: Optional[HrPacketSetting], department: str = "", role_id: str = "",
              kind: str = "offer", role_docs=None) -> Optional[dict]:
    """What a letter or packet needs from HR, for the offer form - with the
    documents it adds for this person's team and role (a hiring packet with
    the role's own documents filled in)."""
    if s is None:
        return None
    import hr_packet_docs as hpd
    ids = hpd.template_ids_for(s, {"department": department, "role_id": role_id, "role_docs": role_docs or []}, kind)
    snaps, problems = hpd.load_snaps(db, ids)
    tokens = {t for snap in snaps for t in snap.tokens}
    return {"id": s.id, "name": s.name or "", "workerType": s.worker_type or "any", "country": s.country or "",
            "documents": [snap.name for snap in snaps], "problems": problems,
            "hrQuestions": hpd.hr_questions(snaps), "prints": sorted(tokens & set(OFFER_PRINTS)),
            "personQuestions": [f["label"] for f in hpd.template_form(snaps)],
            "printsPay": hpd.packet_prints_pay(s, snaps)}


def offer_options(db: Session, cand: HrCandidate, worker_type: str, country: str, role_id: str,
                  chosen: str = "", new_role: bool = False, department: str = "", region: str = "") -> dict:
    """The Move To Offer form: which offer letter this kind of hire gets, the
    hiring packet that follows it, and everything either asks of HR - so HR
    answers once, at the offer (Neil: "the time to do it is right at sending
    an offer")."""
    wt = (worker_type or "").strip().lower()
    company_country = country_of(db, cand.company)
    country = re.sub(r"[^A-Za-z]", "", country or "").upper()[:2] or company_country
    company_region = region_of(db, cand.company)
    region = re.sub(r"[^A-Za-z]", "", region or "").upper()[:3] or (company_region if country == company_country else "")
    # A new role ("Other") has no role of its own yet - never the card's.
    role_id = "" if new_role else (role_id or cand.role_id or "").strip()
    entity = db.query(HrEntity).filter(HrEntity.id == cand.company).first()
    company = entity.name if entity else "this company"
    choices = [{"id": r.id, "name": r.name or "Unnamed", "workerType": r.worker_type or "any", "country": r.country or ""}
               for r in packet_choices(db, cand.company, "offer")]
    out = {"country": country, "companyCountry": company_country, "region": region, "companyRegion": company_region,
           "choices": choices, "offerLetter": None, "hiringPacket": None, "missing": "", "missingPacket": ""}
    if wt not in WORKER_LABELS:
        return out
    letter = packet_choice(db, cand.company, "offer", chosen) if chosen else None
    letter = letter or resolve_setting(db, cand.company, "offer", wt, role_id, country, region=region)
    packet = resolve_setting(db, cand.company, "hire", wt, role_id, country, documents_only=True, region=region)
    from models import NexusGroup
    role = db.query(NexusGroup).filter(NexusGroup.id == role_id).first() if role_id else None
    department = (role.department if role is not None else "") or department or cand.department or ""
    out["offerLetter"] = _describe(db, letter, department, role_id)
    out["hiringPacket"] = _describe(db, packet, department, role_id, kind="hire",
                                    role_docs=role_paperwork(role)["role_docs"])
    from hr_packet_docs import name_of
    out["offerFrom"] = {k: {"email": e, "name": name_of(db, e) if e else ""}
                        for k, e in offer_from_people(db, cand.company, department).items()}
    out["offerFrom"]["department"] = department
    if letter is None:
        out["missing"] = (f"No offer letter is set up for {kind_of_hire(wt, country, region)} at {company} yet - add one "
                          f"under Settings > Hiring > Hiring Documents > Offer Letter.")
    if packet is None:
        out["missingPacket"] = _no_packet_text(wt, country, region, company)
    return out


def _no_packet_text(wt: str, country: str, region: str, company: str) -> str:
    return (f"No hiring packet is set up for {kind_of_hire(wt, country, region)} at {company} - set one up in "
            f"Settings > Hiring > Hiring Documents > Hiring Packet before sending the offer, so the new hire is "
            f"never left waiting after they sign it.")


def plan_offer(db: Session, user: dict, cid: str, inputs: dict, pay: Optional[dict], scope,
               lock: bool = False) -> dict:
    """Everything an offer would do, without doing it."""
    import hr_packet_docs as hpd
    cand = _load_candidate(db, cid, scope, lock=lock)
    if cand.stage not in OFFER_STAGES:
        raise PacketError(f"{cand.first_name} is {cand.stage.title()} - only a candidate still in the pipeline "
                          f"gets an offer.", 409)
    if cand.employee_id:
        raise PacketError("This candidate is already an employee.", 409)
    if not (cand.email or "").strip():
        raise PacketError("Add the candidate's personal email first - the offer goes there.")
    if not (cand.company or "").strip():
        raise PacketError("Pick the hiring company on the candidate first.")
    d = offer_details(db, cand, inputs or {})
    try:
        clean = clean_pay(pay)
    except ValueError as e:
        raise PacketError(str(e))
    former = rehire_record(db, cand)
    if former is not None:
        if former.status in ("active", "onboarding", "staged"):
            raise PacketError(f"{former.first_name} {former.last_name} ({former.employee_code}) is already in People "
                              f"as {former.status} with this email - this is not a new hire. Edit their record instead.", 409)
        d["rehire_employee_id"] = former.id
    entity = db.query(HrEntity).filter(HrEntity.id == cand.company).first()
    company = entity.name if entity else "this company"
    if d["packet_id"]:
        setting = packet_choice(db, cand.company, "offer", d["packet_id"])
        if setting is None:
            raise PacketError("That offer letter is not one this company can send - pick another.", 409)
    else:
        setting = resolve_setting(db, cand.company, "offer", d["worker_type"], d["role_id"], d["country"],
                                  region=d.get("region", ""))
    if setting is None:
        raise PacketError(f"No offer letter is set up for {kind_of_hire(d['worker_type'], d['country'], d.get('region', ''))} at {company} "
                          f"yet - add one under Settings > Hiring > Hiring Documents > Offer Letter.", 409)
    if not is_documents(setting):
        raise PacketError("Offer letters are built from Documents - set this one up again there.", 409)
    packet = resolve_setting(db, cand.company, "hire", d["worker_type"], d["role_id"], d["country"], documents_only=True,
                             region=d.get("region", ""))
    # Never an offer with nothing to follow it (Neil, Oct 22): a hire who signs
    # and then waits on paperwork nobody set up is the failure to prevent.
    if packet is None and not (inputs or {}).get("hire_packet_id"):
        raise PacketError(_no_packet_text(d["worker_type"], d["country"], d.get("region", ""), company), 409)
    dp = hpd.plan(db, setting, ctx=hire_ctx(db, cand, d, entity, user["email"]),
                  overrides=hpd.event_values(db, "offer", d), pay=clean, can_see_pay=bool(clean),
                  candidate_id=cand.id, entity_id=cand.company or "")
    return {"candidate": cand, "details": d, "pay": clean, "setting": setting, "packet": packet, "docplan": dp,
            "former": former, "company": company, "subjectName": f"{cand.first_name} {cand.last_name}".strip()}


def offer_pay_snaps(db: Session, setting: HrPacketSetting, inputs: dict) -> list:
    """The documents an offer's pay can be printed in: the letter, and the
    hiring packet that follows it (HR answers both at the offer)."""
    import hr_packet_docs as hpd
    ids = hpd.template_ids_for(setting, inputs, "offer")
    packet = (db.query(HrPacketSetting).filter(HrPacketSetting.id == inputs.get("hire_packet_id")).first()
              if inputs.get("hire_packet_id") else None)
    if packet is not None:
        ids += [t for t in hpd.template_ids_for(packet, inputs, "hire") if t not in ids]
    return hpd.load_snaps(db, ids)[0]


def _no_pay_in(snaps: list, extra: dict) -> None:
    """HR's plain answers never carry pay - a pay question is entered as pay
    (Pay & Benefits only, never on a document row)."""
    import hr_packet_docs as hpd
    defs = {}
    for snap in snaps:
        defs.update(snap.defs)
    for k in extra or {}:
        if hpd.is_pay_token(k, defs):
            raise PacketError(f'"{k.replace("_", " ")}" is pay - enter it with the pay (Pay & Benefits access needed).')


def _pay_for(snaps: list, values: Optional[dict]) -> dict:
    """Pay typed per pay variable - only the pay variables these documents
    print (and {{salary}}), at most 200 characters each."""
    import hr_packet_docs as hpd
    allowed = hpd.pay_tokens(snaps) | {"salary"}
    out = {}
    for k, v in (values or {}).items():
        k = str(k).strip()
        v = re.sub(r"[\x00-\x1f\x7f]", "", str(v or "")).strip()[:200]
        if not v:
            continue
        if k not in allowed:
            raise PacketError(f'"{k}" is not a pay detail of this offer or its hiring packet.')
        out[k] = v
    return out


def start_offer(db: Session, user: dict, cid: str, inputs: dict, pay: Optional[dict], pay_values: Optional[dict],
                details: Optional[dict], scope) -> HrLifeEvent:
    """Move To Offer: the letter is generated at once from HR's answers and
    the verifier is asked to check it. The candidate is at Offer from here.
    HR's answers for the hiring packet that follows are kept with it, so
    nobody is asked twice. Commits."""
    import hr_packet_docs as hpd
    plan = plan_offer(db, user, cid, inputs, pay, scope, lock=True)
    cand, setting, d, packet = plan["candidate"], plan["setting"], plan["details"], plan["packet"]
    if active_hire_event(db, cand.id):
        raise PacketError("An offer letter or hiring packet is already open for this candidate - void it first.", 409)
    opts = four_options(inputs or {})
    _check_jd(db, opts["jd_template_id"])
    person = clean_intake({"first_name": cand.first_name, "last_name": cand.last_name, "phone": cand.phone,
                           **{k: v for k, v in (details or {}).items() if str(v or "").strip()}})
    if not person.get("first_name") or not person.get("last_name"):
        raise PacketError("Enter their legal first and last name.")
    now = _now()
    if d["new_role_name"]:
        role = create_company_role(db, cand.company, d["new_role_name"], d["department"], user["email"],
                                   plan["subjectName"])
        d["role_id"] = role.id
    extra = d.pop("merge", {}) or {}
    stored = {**d, **opts, "extra": extra, "verifier_role": setting.verify_role or "hr", "engine": "documents",
              "hire_packet_id": packet.id if packet is not None else ""}
    _no_pay_in(offer_pay_snaps(db, setting, stored), extra)
    letter_snaps, _ = hpd.load_snaps(db, hpd.template_ids_for(setting, d, "offer"))
    packet_ids = hpd.template_ids_for(packet, {**d, **opts}, "hire") if packet is not None else []
    packet_snaps = hpd.load_snaps(db, packet_ids)[0] if packet_ids else []
    if any("employee_code" in snap.tokens for snap in letter_snaps):
        stored["employee_code"] = (plan["former"].employee_code if plan.get("former") is not None
                                   else reserve_code(db)) or ""
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="offer", status="review", entity_id=cand.company,
                     candidate_id=cand.id, subject_name=f"{person['first_name']} {person['last_name']}".strip(),
                     subject_email=cand.email.strip().lower(), setting_id=setting.id, template_id="",
                     inputs=stored, pay=plan["pay"], pay_values=_pay_for(letter_snaps + packet_snaps, pay_values),
                     intake=person, effective_date=d["start_date"], documents=[],
                     created_by=user["email"].lower(), created_at=now, updated_at=now)
    db.add(ev)
    if cand.stage != "offer":
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage, to_stage="offer",
                            note=f"Offer started - {setting.name or 'offer letter'}", by_email=user["email"],
                            created_at=now))
        cand.stage = "offer"
        import hiring_decision
        hiring_decision.close(db, cand)      # the decision is made - the offer is out
    card_from_intake(db, ev)
    db.flush()
    p = hpd.event_plan(db, ev, setting, sender=user["email"], can_see_pay=True)
    hpd.sync_documents(db, ev, setting, p, user["email"].lower())
    _stage_note(db, ev, f"Offer letter prepared - waiting for {p['verifier']['name'] or 'HR'} to verify",
                by=user["email"])
    _ask_verifier(db, ev, p)
    db.commit()
    return ev


def start_packet_after_offer(db: Session, offer: HrLifeEvent, by: str) -> tuple:
    """The offer is signed: the hiring packet (right to work compliance)
    starts by itself - the person is emailed a link to their details form,
    no login, and the documents are generated when they send it. Everything
    HR answered at the offer is carried over. Returns (event, intake token);
    an already started packet is returned as it is, with no token. The
    caller commits."""
    import hr_packet_docs as hpd
    cand = db.query(HrCandidate).filter(HrCandidate.id == offer.candidate_id).first()
    if cand is None or not offer.employee_id:
        raise PacketError("They are not hired yet - the hiring packet starts once the offer letter is signed.", 409)
    # One at a time; a voided, declined or expired one can be started again.
    existing = (db.query(HrLifeEvent)
                .filter(HrLifeEvent.candidate_id == cand.id, HrLifeEvent.kind == "hire",
                        HrLifeEvent.status.in_(OPEN + ("completed",))).first())
    if existing is not None:
        return existing, ""
    d = dict(offer.inputs or {})
    wt = d.get("worker_type") or worker_type_of(d.get("employment_type", ""))
    setting = (packet_choice(db, offer.entity_id or "", "hire", d["hire_packet_id"])
               if d.get("hire_packet_id") else None)
    setting = setting or resolve_setting(db, offer.entity_id or "", "hire", wt, d.get("role_id", ""), d.get("country", ""),
                                         documents_only=True, region=d.get("region", ""))
    entity = db.query(HrEntity).filter(HrEntity.id == offer.entity_id).first() if offer.entity_id else None
    company = entity.name if entity else "this company"
    if setting is None:
        raise PacketError(f"No hiring packet is set up for {kind_of_hire(wt, d.get('country', ''), d.get('region', ''))} at {company} - "
                          f"add one in Settings > Hiring > Hiring Documents.", 409)
    if not is_documents(setting):
        raise PacketError(f'"{setting.name or "The hiring packet"}" is an uploaded-PDF packet, which cannot start by '
                          f'itself - rebuild it from Documents.', 409)
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == offer.employee_id).first()
    today = datetime.strptime(_today(), "%Y-%m-%d")
    due = d.get("start_date") or ""
    if not due or due < (today + timedelta(days=3)).strftime("%Y-%m-%d"):
        due = (today + timedelta(days=14)).strftime("%Y-%m-%d")
    stored = {k: v for k, v in d.items() if k not in ("hire_packet_id", "verifier_role", "engine")}
    stored.update({"after_offer": True, "offer_event_id": offer.id, "packet_id": setting.id, "due_on": due,
                   "verifier_role": setting.verify_role or "hr", "engine": "documents",
                   "employee_code": (emp.employee_code if emp is not None else "") or d.get("employee_code", "")})
    snaps, _ = hpd.load_snaps(db, hpd.template_ids_for(setting, d, "hire"))
    allowed = hpd.pay_tokens(snaps) | {"salary"}
    now = _now()
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="hire", status="intake", entity_id=offer.entity_id,
                     candidate_id=cand.id, employee_id=offer.employee_id, subject_name=offer.subject_name,
                     subject_email=(cand.email or offer.subject_email or "").strip().lower(), setting_id=setting.id,
                     template_id="", inputs=stored, pay=dict(offer.pay or {}),
                     pay_values={k: v for k, v in (offer.pay_values or {}).items() if k in allowed},
                     intake={k: v for k, v in (offer.intake or {}).items() if k != "answers"},
                     effective_date=d.get("start_date", ""), documents=[], created_by=offer.created_by or by,
                     created_at=now, updated_at=now)
    db.add(ev)
    token = new_intake_token(ev)
    _stage_note(db, ev, f"Hiring packet started - {cand.first_name} was emailed a link for their details", by=by)
    return ev, token


def intake_link(token: str) -> str:
    from app_url import app_url
    return f"{app_url()}/intake/{token}"


def mail_intake_after_commit(db: Session, ev: HrLifeEvent, token: str) -> str:
    """Email the person their details link once this transaction commits -
    from inside a signing request there is no response to send it after. The
    mail goes from a thread, and only if the link is still on the record (a
    rolled-back start never mails a dead link). Returns the link."""
    import threading

    from sqlalchemy import event as sa_event

    import hr_life_email
    import role_change as rc
    link = intake_link(token)
    subject, html = hr_life_email.intake_email(db, ev, link)
    to, want = ev.subject_email, _token_hash(token)

    def send():
        # after_commit also fires when a SAVEPOINT inside the signing request
        # commits - before the request itself has. Wait (briefly) until the
        # link is really on the record; a start that was rolled back never
        # shows up, and nothing is sent.
        import time
        from database import SessionLocal
        # Up to ten minutes: the sealed copies are emailed inside the same
        # signing request, before it commits.
        for _ in range(300):
            s2 = SessionLocal()
            try:
                found = s2.query(HrLifeEvent.id).filter(HrLifeEvent.intake_token_hash == want).first() is not None
            finally:
                s2.close()
            if found:
                rc.send_emails([(to, subject, html)])
                return
            time.sleep(2)

    sa_event.listen(db, "after_commit", lambda _s: threading.Thread(target=send, daemon=True).start(), once=True)
    return link

# ── the candidate's details link (Oct 14) ────────────────────────────────────
# "Hey, tell me your name, your address, your blah, blah ... You fill it all
# in. Then it generates that hiring paperwork instantly." The link is a
# credential like a signing link: only its sha256 is stored, it dies after
# the offer expires, it is used once, and wrong tokens are throttled per IP.

def _token_hash(token: str) -> str:
    import hashlib
    return hashlib.sha256((token or "").encode()).hexdigest()


def new_intake_token(ev: HrLifeEvent) -> str:
    import secrets
    token = secrets.token_urlsafe(32)
    ev.intake_token_hash = _token_hash(token)
    # The offer's expiry - or, for a packet that follows a signed offer, its own due date.
    ev.intake_expires_on = (ev.inputs or {}).get("due_on") or (ev.inputs or {}).get("offer_expires", "") or ""
    ev.intake_sent_at, ev.intake_submitted_at = _now(), ""
    return token


def intake_by_token(db: Session, token: str, lock: bool = False) -> Optional[HrLifeEvent]:
    if not token or len(token) > 100:
        return None
    q = db.query(HrLifeEvent).filter(HrLifeEvent.intake_token_hash == _token_hash(token))
    return q.with_for_update().first() if lock else q.first()


def intake_standard_fields() -> list:
    """The details every intake form asks, whatever the packet."""
    return [{"key": k, "required": k in INTAKE_REQUIRED} for k in INTAKE_FIELDS]


def intake_public(db: Session, ev: HrLifeEvent) -> dict:
    """What the candidate's page shows: no pay, nothing beyond the role."""
    entity = db.query(HrEntity).filter(HrEntity.id == ev.entity_id).first() if ev.entity_id else None
    cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first() if ev.candidate_id else None
    expired = bool(ev.intake_expires_on) and ev.intake_expires_on < _today()
    state = ("submitted" if ev.intake_submitted_at else "closed" if ev.status != "intake"
             else "expired" if expired else "open")
    import hr_packet_docs as hpd
    setting = hpd.event_setting(db, ev)
    # The packet's Details Form plus every Ask The Person variable of its
    # documents (Oct 14) - one form, each question once.
    form = [{k: f.get(k) for k in ("key", "label", "type", "required", "options", "last4", "help", "sensitive",
                                   "fromTemplate")}
            for f in hpd.event_form(db, ev, setting).details_form if isinstance(f, dict)]
    # What is already known - from the offer, or an earlier round of this
    # form - so the person confirms instead of typing it again. Never an
    # answer to the packet's own questions (some are private).
    known = {k: str((ev.intake or {}).get(k) or "") for k in INTAKE_FIELDS if str((ev.intake or {}).get(k) or "").strip()}
    return {"state": state, "company": (entity.legal_name or entity.name) if entity else "",
            "firstName": (cand.first_name if cand else "") or "", "lastName": (cand.last_name if cand else "") or "",
            "phone": (cand.phone if cand else "") or "", "role": (ev.inputs or {}).get("job_title", ""),
            "expiresOn": ev.intake_expires_on or "", "prefill": known,
            "afterOffer": bool((ev.inputs or {}).get("after_offer")),
            "fields": intake_standard_fields(),
            # The packet's own Details Form (Oct 14) - any country, any field.
            "form": form}


def submit_intake(db: Session, ev: HrLifeEvent, values: dict) -> None:
    """The candidate sends their details: saved, the documents generated, and
    the verifier asked to check them. The caller holds the row lock; commits."""
    import hr_packet_docs as hpd
    info = intake_public(db, ev)
    if info["state"] == "submitted":
        raise PacketError("Your details were already sent to HR - thank you.", 409)
    if info["state"] != "open":
        raise PacketError("This link is no longer active - please contact HR.", 410)
    person = clean_intake(values)
    missing = [k.replace("_", " ") for k in INTAKE_REQUIRED if not person.get(k)]
    if missing:
        raise PacketError("Please fill in: " + ", ".join(missing) + ".")
    try:
        answers = hpd.clean_answers(hpd.event_form(db, ev, hpd.event_setting(db, ev)),
                                    (values or {}).get("answers"), require=True)
    except hpd.PacketProblem as e:
        raise PacketError(str(e))
    if answers:
        person["answers"] = answers
    ev.intake = person
    ev.subject_name = f"{person['first_name']} {person['last_name']}".strip()
    ev.intake_submitted_at = ev.updated_at = _now()
    ev.status = "review"
    card_from_intake(db, ev)
    _stage_note(db, ev, f"{ev.subject_name} sent their details - documents generated", by="candidate")
    setting = hpd.event_setting(db, ev)
    db.flush()
    if setting is not None:
        try:
            p = hpd.event_plan(db, ev, setting, sender=ev.created_by, can_see_pay=True)
            hpd.sync_documents(db, ev, setting, p, ev.created_by)
            _ask_verifier(db, ev, p)
        except Exception as e:   # noqa: BLE001 - the details are kept; HR sees the problem on review
            print(f"[life-events] intake {ev.id}: documents not generated: {type(e).__name__}: {e}")
            _notify(db, ev.created_by, f"Details Received - {ev.subject_name}",
                    "Their details are saved, but the documents could not be generated - open the packet to see why.", ev, priority=1)
    db.commit()


def refresh_due(ev: HrLifeEvent) -> None:
    """The packet that follows a signed offer is paperwork, not an offer: its
    date never strands it. Asking again or sending it with less than three
    days left gives it two more weeks."""
    d = dict(ev.inputs or {})
    if not d.get("after_offer"):
        return
    today = datetime.strptime(_today(), "%Y-%m-%d")
    if (d.get("due_on") or "") < (today + timedelta(days=3)).strftime("%Y-%m-%d"):
        d["due_on"] = (today + timedelta(days=14)).strftime("%Y-%m-%d")
        ev.inputs = d                       # reassigned, never mutated in place (JSON column)


def reopen_intake(db: Session, ev: HrLifeEvent, by: str) -> str:
    """Ask the candidate again (a typo, an expired link): a fresh link, the
    old one dead. The packet goes back to waiting on details. Commits."""
    if ev.kind != "hire" or ev.status not in ("intake", "review"):
        raise PacketError("Only a hiring packet that has not been sent can ask for details again.", 409)
    refresh_due(ev)
    exp = (ev.inputs or {}).get("due_on") or (ev.inputs or {}).get("offer_expires") or ""
    if exp and exp < _today():
        raise PacketError("The link's date has passed - change Offer Expires first.", 409)
    token = new_intake_token(ev)
    ev.status, ev.updated_at = "intake", _now()
    _stage_note(db, ev, f"Details link sent again to {ev.subject_email}", by=by)
    db.commit()
    return token


def card_from_intake(db: Session, ev: HrLifeEvent) -> None:
    """The legal name and phone given for the packet become the candidate
    card's, so the hire is created with what the person signs as."""
    if ev.kind not in CANDIDATE_KINDS or not ev.candidate_id:
        return
    cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first()
    i = ev.intake or {}
    if cand is not None:
        cand.first_name = i.get("first_name") or cand.first_name
        cand.last_name = i.get("last_name") or cand.last_name
        cand.phone = i.get("phone") or cand.phone
        cand.updated_at = _now()


def _ask_verifier(db: Session, ev: HrLifeEvent, p: dict) -> None:
    v = p["verifier"]
    if v.get("email"):
        _notify(db, v["email"], f"Ready to Verify - {EVENT_TITLES.get(ev.kind, 'Packet')} for {ev.subject_name}",
                f"The documents are generated. Check them and click Verify And Send - nothing goes to "
                f"{ev.subject_name} until you do.", ev, priority=1)
    # Signs Once (Oct 14): a new HR contact / signatory has not signed this
    # packet yet - ask them, once.
    for s in p.get("signOnce") or []:
        if not s["signed"] and s.get("email"):
            _notify(db, s["email"], f"Sign Once - {EVENT_TITLES.get(ev.kind, 'Packet')} for {ev.subject_name}",
                    f"You now sign this packet for the company ({s['roleLabel']}). Open it and click Sign Once - "
                    f"your signature then goes on every packet automatically.", ev, priority=1)


def patch_values(db: Session, ev: HrLifeEvent, user: dict, body: dict, *, can_see_pay: bool) -> None:
    """HR corrects what the documents print before they go out: the offer
    (never the role - the role decides which packet goes; void and start
    again for another role), the person's details, the timings, the job
    description, custom values, and pay (Pay & Benefits only). The documents
    regenerate. The caller holds the row lock; this commits."""
    import hr_packet_docs as hpd
    if ev.status not in ("review",):
        raise PacketError(f"This packet is {ev.status.replace('_', ' ')} - it can no longer be changed.", 409)
    setting = hpd.event_setting(db, ev)
    if setting is None:
        raise PacketError("This packet's settings were deleted - void it and start again.", 409)
    inputs = dict(ev.inputs or {})
    new = body.get("inputs") or {}
    if "role_id" in new and (new.get("role_id") or "") != (inputs.get("role_id") or ""):
        raise PacketError("The role decides which packet goes - void this packet and start again for another role.")
    for k in ("start_date", "offer_expires", "manager_email", "employment_type", "effective_date", "last_day",
              "responsibilities", "job_title", "work_location"):
        if k in new:
            inputs[k] = str(new.get(k) or "").strip()[:4000 if k == "responsibilities" else 200]
    if any(k in new for k in ("work_start", "work_end", "work_days", "timings_text", "jd_template_id")):
        merged = {**{k: inputs.get(k) for k in ("work_start", "work_end", "work_days", "timings_text", "jd_template_id")},
                  **{k: new[k] for k in ("work_start", "work_end", "work_days", "timings_text", "jd_template_id") if k in new}}
        opts = four_options(merged)
        _check_jd(db, opts["jd_template_id"])
        inputs.update(opts)
    if "extra" in (body or {}):
        inputs["extra"] = {str(k): str(v).strip()[:2000] for k, v in (body.get("extra") or {}).items()
                           if re.fullmatch(r"[a-z0-9_]+(\.[a-z0-9_]+)*", str(k)) and str(v or "").strip()}
    if ev.kind in CANDIDATE_KINDS:
        if inputs.get("manager_email") and not db.query(NexusEmployee).filter(
                NexusEmployee.work_email == inputs["manager_email"].lower()).first():
            raise PacketError("The supervisor must be someone in Nexus People.")
        for k, label in (("start_date", "start date"), ("offer_expires", "offer expiry")):
            try:
                datetime.strptime(inputs.get(k, ""), "%Y-%m-%d")
            except ValueError:
                raise PacketError(f"The {label} is not a valid date.")
        if inputs["offer_expires"] > inputs["start_date"]:
            raise PacketError("The offer must expire on or before the start date.")
        ev.effective_date = inputs["start_date"]
    if "details" in (body or {}):
        person = clean_intake(body.get("details"))
        if ev.kind in CANDIDATE_KINDS and (not person.get("first_name") or not person.get("last_name")):
            raise PacketError("Enter their legal first and last name.")
        # The Details Form answers: someone without Pay & Benefits never saw
        # the Sensitive ones, so theirs are kept exactly as they were.
        old = hpd.event_answers(ev)
        form = hpd.form_view(db, setting, hpd.template_ids_for(setting, inputs, ev.kind))
        try:
            answers = hpd.clean_answers(form, (body.get("details") or {}).get("answers"), old,
                                        keep=() if can_see_pay else tuple(hpd.sensitive_keys(form)))
        except hpd.PacketProblem as e:
            raise PacketError(str(e))
        if answers:
            person["answers"] = answers
        ev.intake = person
        if ev.kind in CANDIDATE_KINDS:
            ev.subject_name = f"{person['first_name']} {person['last_name']}".strip()
            card_from_intake(db, ev)
    if "pay" in (body or {}) or "pay_values" in (body or {}):
        if not can_see_pay:
            raise PacketError("Entering pay needs Pay & Benefits access.", 403)
        if "pay" in body:
            try:
                ev.pay = clean_pay(body.get("pay"))
            except ValueError as e:
                raise PacketError(str(e))
        if "pay_values" in body:
            ev.pay_values = (_pay_for(offer_pay_snaps(db, setting, inputs), body.get("pay_values")) if ev.kind == "offer"
                             else clean_pay_values(db, setting, body.get("pay_values"), inputs.get("jd_template_id", ""), inputs))
    ev.inputs = inputs
    ev.updated_at = _now()
    db.flush()
    p = hpd.event_plan(db, ev, setting, sender=user["email"], can_see_pay=True)
    hpd.sync_documents(db, ev, setting, p, user["email"].lower())
    db.commit()


def void_open(db: Session, ev: HrLifeEvent, actor: str) -> None:
    """Void a packet that was never sent (waiting on details or on review):
    its documents are archived, nothing reaches Nexus Sign. Commits."""
    from models import Document
    if ev.status not in ("intake", "review"):
        raise PacketError(f"This packet is already {ev.status}.", 409)
    ids = [d.get("documentId") for d in (ev.documents or []) if d.get("documentId")]
    if ids:
        db.query(Document).filter(Document.id.in_(ids)).update(
            {"status": "archived", "archived_at": _now()}, synchronize_session=False)
    ev.status, ev.updated_at = "voided", _now()
    _stage_note(db, ev, f"{EVENT_TITLES.get(ev.kind, 'Packet')} voided by {actor} before it was sent", by=actor)
    db.commit()


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
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == req.link_id).with_for_update().first()
    # Only the event's CURRENT envelope moves it: a late hook from an envelope
    # that was replaced must never complete (or decline) the new one.
    if ev is not None and ev.sign_request_id and ev.sign_request_id != req.id:
        return None
    return ev


def _stage_note(db: Session, ev: HrLifeEvent, note: str, by: str = "") -> None:
    if ev.kind not in CANDIDATE_KINDS or not ev.candidate_id:
        return
    cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first()
    if cand:
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                            to_stage=cand.stage, note=note, by_email=by or ev.created_by,
                            created_at=_now()))


def _notify(db: Session, to: str, title: str, body: str, ev: HrLifeEvent, priority: int = 0) -> None:
    from routers.hr import _hr_notify
    sub = "hr-hiring" if ev.kind in CANDIDATE_KINDS and not ev.employee_id else "hr-people"
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
    # Everyone who acts before the person - signers and, on a packet built
    # from Documents, approvers too - must be done (Oct 14).
    done = {"signer": "signed", "countersigner": "signed", "witness": "signed", "approver": "approved"}
    ahead = [p for p in parties if p.ordinal < subject.ordinal and (p.party_role or "signer") in done]
    if all(p.status == done[p.party_role or "signer"] for p in ahead):
        ev.status = "sent"
        ev.updated_at = _now()
        _stage_note(db, ev, f"Company signed off - {ev.subject_name} invited to sign")


def on_declined(db: Session, req: HrSignRequest, party, reason: str = "") -> None:
    ev = _for(db, req)
    if not ev or ev.status not in ACTIVE:
        return
    ev.status = "declined"
    ev.decline_reason = (reason or "")[:500]
    ev.updated_at = _now()
    who = getattr(party, "name", "") or "A signer"
    _stage_note(db, ev, f"{EVENT_TITLES[ev.kind]} declined by {who}" + (f": {reason}" if reason else ""))
    _notify(db, ev.created_by, f"{EVENT_TITLES[ev.kind]} Declined - {ev.subject_name}",
            f"{who} declined \"{req.title}\"." + (f" Reason: {reason}" if reason else "")
            + " Fix what is needed and send it again.", ev)


def on_voided(db: Session, req: HrSignRequest, actor: str = "") -> None:
    ev = _for(db, req)
    if not ev or ev.status not in ACTIVE:
        return
    ev.status = "voided"
    ev.updated_at = _now()
    _stage_note(db, ev, f"{EVENT_TITLES[ev.kind]} voided by {actor or 'HR'}", by=actor)
    if ev.kind == "separation" and ev.apply_status == "scheduled":
        # Voiding the paperwork in Nexus Sign is not canceling the offboarding
        # - the person is still leaving on the day. Say so, in case it was.
        _notify(db, ev.created_by, f"Separation Package Voided - {ev.subject_name}",
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
    _stage_note(db, ev, f"{EVENT_TITLES[ev.kind]} expired unsigned")
    _notify(db, ev.created_by, f"{EVENT_TITLES[ev.kind]} Expired - {ev.subject_name}",
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
        _notify(db, ev.created_by, f"{ev.subject_name} Signed a Packet After Being Rejected",
                "The signed packet is in Nexus Sign, but they were not hired because the candidate is Rejected. "
                "Reopen them and Mark Hired By Hand if the offer still stands.", ev, priority=1)
        return
    emp = (db.query(NexusEmployee).filter(NexusEmployee.id == cand.employee_id).first()
           if cand.employee_id else None)
    details = ev.inputs or {}
    what = EVENT_TITLES.get(ev.kind, "Packet")
    if emp is None:
        emp = create_employee_from_candidate(db, cand, ev.created_by, details=details)
        note = (f"{what} signed - rehired on their existing record" if details.get("rehire_employee_id")
                else f"{what} signed - hired automatically")
    elif details.get("after_offer"):
        note = f"{what} signed - their paperwork is complete"
    else:
        note = f"{what} signed (already hired)"
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
    _apply_hire_details(db, ev, emp)
    if emp.work_email:
        from routers.hr import adopt_pending_role
        adopt_pending_role(db, emp, ev.created_by, ev)
    # _finalize attaches the sealed PDF to the profile's Documents tab for the
    # envelope's employee - set here, before it does.
    req.employee_id = emp.id
    ev.apply_note = note
    start = us_date(ev.effective_date)
    if ev.kind == "offer":
        title, body = (f"{ev.subject_name} Accepted the Offer",
                       f"{ev.subject_name} signed the offer letter and is now in People as onboarding"
                       + (f", starting {start}" if start else "") + ". Their hiring packet is on its way to them.")
    elif details.get("after_offer"):
        title, body = (f"{ev.subject_name} Signed the Hiring Packet",
                       f"{ev.subject_name} signed every onboarding document - their paperwork is complete.")
    else:
        title, body = (f"{ev.subject_name} Signed the Hiring Packet",
                       f"{ev.subject_name} signed every document and is now in People as onboarding"
                       + (f", starting {start}" if start else "") + ".")
    for to in {ev.created_by, (cand.created_by or "").lower(), (emp.manager_email or "").lower()} - {""}:
        _notify(db, to, title, body, ev)


# Details Form answers that have a home on Personal Details. Only these reach
# People (Pranshu, Oct 16 2026: nationality and the rest stay on the packet
# and in the signed documents, never on the profile; the bank account goes to
# Pay & Benefits and, since Oct 21, PAN to Compliance - it prints on a
# contractor's invoices). Matched on the variable name or its label, first
# match wins.
_PROFILE_KEYS = {"dob": ("date_of_birth", "dob", "birth_date"), "gender": ("gender", "sex"),
                 "nationalId": ("national_id", "aadhaar_number", "aadhar_number", "aadhaar", "aadhaar_card_number",
                                "ssn", "social_security_number")}
# ...and the bank account, which goes to Pay & Benefits > Bank Accounts.
_BANK_KEYS = {"number": ("bank_account_number", "account_number"),
              "routingOrIfsc": ("ifsc_code", "ifsc", "routing_number", "bank_routing_number"),
              "bankName": ("bank_name",),
              "holder": ("account_holder_name", "bank_account_holder", "account_holder_name_as_per_bank_records"),
              "type": ("account_type", "type_of_account", "bank_account_type")}
# ...and PAN (India), which goes to Compliance (HR-guarded) - uppercased, only
# when it is in its printed form.
_PAN_KEYS = ("pan", "pan_number", "pan_card_number", "permanent_account_number", "pan_card")
_PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_GENDERS = ("Male", "Female", "Other", "Prefer not to say")


def _slug(s) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")


def _named(fields: list, answers: dict, skip: set) -> dict:
    """Answers by variable name and by label slug ("Date of Birth" matches
    whatever the variable is called), leaving out the keys in skip."""
    out = {k: str(v or "").strip() for k, v in answers.items() if k not in skip}
    for f in fields:
        if f["key"] not in skip:
            out.setdefault(_slug(f.get("label")), str(answers.get(f["key"]) or "").strip())
    return out


def _profile_from_answers(fields: list, answers: dict, personal: dict, bank: list, holder: str,
                          compliance: dict | None = None) -> None:
    """Fill Personal Details, Bank Accounts and Compliance (PAN) from the
    person's own answers. A Sensitive answer only goes where HR guards it (the
    bank account, Compliance), never onto Personal Details."""
    named = _named(fields, answers, {f["key"] for f in fields if f.get("sensitive")})
    for field, keys in _PROFILE_KEYS.items():
        v = next((named[k] for k in keys if named.get(k)), "")
        if not v:
            continue
        if field == "dob" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            continue                                       # the profile keeps a real date or nothing
        if field == "gender":
            v = next((g for g in _GENDERS if g.lower() == v.lower()), v)
        personal[field] = v[:120]
    named = _named(fields, answers, set())
    pan = next((named[k] for k in _PAN_KEYS if named.get(k)), "").upper().replace(" ", "")
    if compliance is not None and _PAN_RE.match(pan):
        compliance["pan"] = pan
    acc = {field: v[:120] for field, keys in _BANK_KEYS.items() if (v := next((named[k] for k in keys if named.get(k)), ""))}
    if not acc.get("number"):
        return                                             # no account number - nothing to file
    t = (acc.get("type") or "").lower()
    acc["type"] = next((x for x in ("savings", "current", "checking") if x in t), "checking")
    acc = {"holder": holder, "bankName": "", "routingOrIfsc": "", **acc}
    if not any(str(b.get("number") or "") == acc["number"] for b in bank if isinstance(b, dict)):
        bank.append(acc)


def _apply_hire_details(db: Session, ev: HrLifeEvent, emp: NexusEmployee) -> None:
    """A packet built from Documents (Oct 14): the details collected for it land
    on People, its documents now belong to the employee, and anything that
    signed differently from what People holds is flagged - never silent."""
    if not (ev.documents or ev.intake or ev.pay_values):
        return
    from models import Document
    i = ev.intake or {}
    personal = dict(emp.personal or {})
    for key, field in (("address", "currentAddress"), ("permanent_address", "permanentAddress"),
                       ("preferred_name", "preferredName")):
        if str(i.get(key) or "").strip():
            personal[field] = str(i[key]).strip()
    if any(str(i.get(k) or "").strip() for k in ("emergency_name", "emergency_relationship", "emergency_phone")):
        personal["emergency"] = {**dict(personal.get("emergency") or {}),
                                 "name": str(i.get("emergency_name") or "").strip(),
                                 "relationship": str(i.get("emergency_relationship") or "").strip(),
                                 "phone": str(i.get("emergency_phone") or "").strip()}
    # The packet's Details Form: date of birth, gender and national ID reach
    # Personal Details, the bank account Pay & Benefits, PAN Compliance; every
    # other answer stays on the packet.
    import hr_packet_docs as hpd
    form = hpd.event_form(db, ev, hpd.event_setting(db, ev))
    bank = [dict(b) for b in (emp.bank or [])]
    compliance = dict(emp.compliance or {})
    _profile_from_answers(hpd.form_fields(form), hpd.event_answers(ev), personal, bank, ev.subject_name or "", compliance)
    emp.bank = bank
    emp.compliance = compliance
    personal.pop("packetDetails", None)                   # the old Hiring Details rows (Oct 14-16)
    emp.personal = personal
    if str(i.get("phone") or "").strip():
        emp.phone = str(i["phone"]).strip()
    ids = [d.get("documentId") for d in (ev.documents or []) if d.get("documentId")]
    if ids:
        db.query(Document).filter(Document.id.in_(ids)).update({"employee_id": emp.id}, synchronize_session=False)
    flags = [f for f in (ev.flags or []) if f.get("code") not in ("pay_not_recorded", "employee_code_mismatch")]
    if ev.pay_values and not ev.pay:
        flags.append({"code": "pay_not_recorded",
                      "message": "The offer stated pay as text only - enter it on Pay & Benefits."})
        _notify(db, ev.verified_by or ev.created_by, f"Enter Pay for {ev.subject_name}",
                f"{ev.subject_name}'s offer stated pay as text, so it was not recorded on Pay & Benefits - "
                f"enter it on their profile.", ev, priority=1)
    printed = (ev.inputs or {}).get("employee_code") or ""
    if printed and (emp.employee_code or "") != printed:
        flags.append({"code": "employee_code_mismatch",
                      "message": f"Signed documents show {printed}; People has {emp.employee_code or 'no number'}."})
        _notify(db, ev.verified_by or ev.created_by, f"Employee Number Differs - {ev.subject_name}",
                f"The signed documents show {printed}, but People has {emp.employee_code or 'no number'}. "
                f"Decide whether to re-issue.", ev, priority=1)
    ev.flags = flags


def _apply_offer(db: Session, ev: HrLifeEvent, req: HrSignRequest) -> None:
    """The candidate signed the offer letter (its only signer): they are hired
    (the same path Mark Hired uses), and the hiring packet starts by itself. A packet
    that cannot start never undoes the hire - HR is told what to fix."""
    _apply_hire(db, ev, req)
    if not ev.employee_id:
        return                            # not hired (rejected meanwhile) - _apply_hire said why
    sp = db.begin_nested()
    try:
        packet, token = start_packet_after_offer(db, ev, ev.created_by)
        sp.commit()
    except Exception as e:   # noqa: BLE001 - the hire stands; HR starts the packet by hand
        sp.rollback()
        msg = str(e) if isinstance(e, PacketError) else f"{type(e).__name__}: {str(e)[:200]}"
        ev.flags = [f for f in (ev.flags or []) if f.get("code") != "packet_not_started"] + [
            {"code": "packet_not_started", "message": msg}]
        _stage_note(db, ev, f"Offer signed - the hiring packet did not start: {msg}")
        _notify(db, ev.created_by, f"Start the Hiring Packet - {ev.subject_name}",
                f"{ev.subject_name} signed the offer and is hired, but the hiring packet could not start: {msg} "
                f"Fix it, then click Start Hiring Packet on their card.", ev, priority=1)
        return
    if token:
        mail_intake_after_commit(db, packet, token)


_APPLY = {"hire": _apply_hire, "offer": _apply_offer}


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
    if ev.kind in CANDIDATE_KINDS and ev.employee_id and req.final_pdf_path:
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
    # No role moves up or down without the why (Neil, Oct 22) - role_history shows it.
    reason = (inputs.get("reason") or "").strip()[:1000]
    if not reason:
        raise PacketError("Add the reason - it is kept in their role history.")
    cur = current_job_role(db, emp.work_email)
    return {
        "change_type": change, "role_id": jr.id, "role_name": jr.name,
        "department": jr.department or emp.department or "",
        "job_title": (inputs.get("job_title") or jr.name).strip(),
        "old_role_id": cur.id if cur else "", "old_role_name": cur.name if cur else "",
        "old_title": emp.job_title or (cur.name if cur else ""),
        "effective_date": eff,
        "responsibilities": (inputs.get("responsibilities") or "").strip()[:4000],
        "reason": reason,
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
    from own_pay import OWN_PAY, own_pay_locked
    if clean and own_pay_locked(db, user, emp.work_email, min_level=5, module_id="hr_comp"):
        raise PacketError(OWN_PAY, 403)   # nobody raises their own pay (Oct 20)
    if details["role_id"] == details["old_role_id"] and not clean and details["job_title"] == details["old_title"]:
        raise PacketError("Nothing changes - pick a new role, title or pay.")
    entity = db.query(HrEntity).filter(HrEntity.id == emp.company).first()
    company = entity.name if entity else "this company"
    setting = resolve_setting(db, emp.company or "", "promotion", worker_type_of(emp.employment_type),
                              details["role_id"] or role_id_for_employee(db, emp))
    if not setting:
        raise PacketError(f"No promotion letter is set up for {company} yet - add one under "
                          f"Settings > Hiring > Hiring Documents.", 409)
    if is_documents(setting):
        # Built from Documents (Oct 14): previewed here, started, verified, sent.
        import hr_checklists as hc
        import hr_packet_docs as hpd
        name = (emp.display_name or f"{emp.first_name} {emp.last_name}").strip()
        details["manager_email"] = (emp.manager_email or "").strip().lower()
        ctx = {"entity": entity, "owners": hc.role_owners(db, emp.company or ""),
               "sender": user["email"].lower(), "subject_email": emp.work_email.lower(),
               "subject_emails": [emp.work_email, emp.personal_email], "subject_name": name,
               "subject_kind": "internal", "manager_email": details["manager_email"]}
        dp = hpd.plan(db, setting, ctx=ctx, overrides=hpd.event_values(db, "promotion", details), pay=clean,
                      can_see_pay=bool(clean), employee_id=emp.id, entity_id=emp.company or "")
        return {"employee": emp, "details": details, "pay": clean, "setting": setting, "template": None,
                "docplan": dp, "merge": {}, "unresolved": [], "parties": [], "subjectName": name,
                "title": f"{CHANGE_TYPES[details['change_type']]} Letter - {name}", "company": company,
                "subfolder": (setting.egnyte_subfolder or "").strip() or DEFAULT_SUBFOLDERS["promotion"],
                "flags": signed_periods_from(db, emp.work_email, details["effective_date"]) if clean else []}
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
    if plan.get("docplan") is not None:
        dp = plan["docplan"]
        return {"engine": "documents", "title": plan["title"], "company": plan["company"],
                "packetName": plan["setting"].name or "", "documents": [x["name"] for x in dp["documents"]],
                "documentDetails": dp["documents"], "recipients": dp["recipients"], "verifier": dp["verifier"],
                "problems": dp["problems"], "printsPay": dp["printsPay"],
                "unresolved": sorted({t for x in dp["documents"] for t in x["unresolved"]}),
                "entityId": plan["employee"].company or "", "egnyteSubfolder": plan["subfolder"],
                "effectiveDate": d["effective_date"], "fromTitle": d["old_title"], "toTitle": d["job_title"],
                "fromRole": d["old_role_name"], "toRole": d["role_name"], "signedPeriods": plan["flags"]}
    return {
        "title": plan["title"], "company": plan["company"], "templateName": tpl.name, "templateId": tpl.id,
        "entityId": plan["employee"].company or "",
        "documents": ([tpl.name] if tpl.body else []) + [a.get("name", "document.pdf") for a in (tpl.attachments or []) if a.get("path")],
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
    if plan.get("docplan") is not None:
        raise PacketError("This letter is built from Documents - it is sent once HR has verified it.", 409)
    if plan["unresolved"]:
        raise PacketError("Fill in: " + ", ".join(plan["unresolved"]) + ".")
    busy = (db.query(HrLifeEvent).filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "promotion",
                                         HrLifeEvent.status.in_(OPEN)).first())
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
            sender_signs_first=sender_first,
            prints_pay=pay_in_letter(plan["template"]) or bool(plan["pay"])
            or bool(plan["details"].get("salary_text")))
    except HTTPException as e:
        raise PacketError(str(e.detail), e.status_code)
    ev.sign_request_id = out["id"]
    if not sender_first:
        ev.status = "sent"
    db.commit()
    return ev


def start_promotion(db: Session, user: dict, eid: str, inputs: dict, pay: Optional[dict],
                    pay_values: Optional[dict], scope) -> HrLifeEvent:
    """Promote / change role with a letter built from Documents (Oct 14): the
    letter is generated at once and the verifier asked to check it. Commits."""
    import hr_packet_docs as hpd
    plan = plan_promotion(db, user, eid, inputs, pay, scope, lock=True)
    emp, setting = plan["employee"], plan["setting"]
    if plan.get("docplan") is None:
        raise PacketError("This company's promotion letter is an uploaded PDF - use Send For Signature.", 409)
    busy = (db.query(HrLifeEvent).filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "promotion",
                                         HrLifeEvent.status.in_(OPEN)).first())
    if busy:
        raise PacketError("A promotion letter is already open for them - void it first.", 409)
    d = dict(plan["details"])
    extra = d.pop("merge", {}) or {}
    now = _now()
    old = ({"old_pay": {k: (emp.compensation or {}).get(k) for k in ("base", "payBasis", "frequency", "currency")}}
           if plan["pay"] and (emp.compensation or {}).get("base") else {})
    ev = HrLifeEvent(id=str(uuid.uuid4()), kind="promotion", status="review", entity_id=emp.company or "",
                     employee_id=emp.id, subject_name=plan["subjectName"], subject_email=emp.work_email.lower(),
                     setting_id=setting.id, template_id="",
                     inputs={**d, **old, "extra": extra, "verifier_role": setting.verify_role or "hr", "engine": "documents"},
                     pay=plan["pay"], pay_values=clean_pay_values(db, setting, pay_values),
                     effective_date=d["effective_date"], documents=[],
                     flags=[{"code": "signed_timesheets", "periods": plan["flags"]}] if plan["flags"] else [],
                     created_by=user["email"].lower(), created_at=now, updated_at=now)
    db.add(ev)
    db.flush()
    p = hpd.event_plan(db, ev, setting, sender=user["email"], can_see_pay=True)
    hpd.sync_documents(db, ev, setting, p, user["email"].lower())
    _ask_verifier(db, ev, p)
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
        _notify(db, to, f"{title} Signed - {ev.subject_name}", body, ev)
    # The Promotion checklist (Neil, Oct 19), with the new role's own steps.
    import hr_checklists
    try:
        if not hr_checklists.open_checklist(db, emp.id, "promotion"):
            hr_checklists.start(db, emp, "promotion", anchor_date=eff, by=ev.created_by,
                                role_id=jr.id if jr else "")
    except ValueError as e:
        print(f"[life-events] promotion checklist not started for {emp.id}: {e}")
    _notify(db, emp.work_email.lower(), f"Your {title} Is Official",
            f"Your new role, {d.get('job_title')}, takes effect {us_date(eff)}. The signed letter is in "
            f"My HR > My Documents.", ev)
    if periods:
        labels = ", ".join(p["label"] for p in periods)
        for to in {ev.created_by, hr_contact} - {""}:
            from routers.hr import _hr_notify
            _hr_notify(db, to, f"Review Signed Time Sheets - {ev.subject_name}",
                       f"The new pay starts {us_date(eff)}, inside time sheets already signed or finalized "
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

# The reason list and its words live in hr_checklist_seed (Voluntary
# Resignation / Job Abandonment since Charmi, Oct 20 2026); stored keys never
# change, so a package sent before the rename still reads with the new label.
SEPARATION_TYPES = dict(hr_checklist_seed.EXIT_TYPE_LABELS)


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
    setting = resolve_setting(db, emp.company or "", "separation", worker_type_of(emp.employment_type),
                              role_id_for_employee(db, emp))
    tpl = (db.query(HrSignTemplate).filter(HrSignTemplate.id == setting.template_id).first()
           if setting else None)
    problems = setting_problems(db, setting) if setting else []
    package = d["send_package"] and bool(setting) and not problems
    merge, unresolved, parties = {}, [], []
    docplan = None
    if d["send_package"] and is_documents(setting):
        # Built from Documents (Oct 14): previewed here; the offboarding itself
        # goes ahead as always, the package waits for the verifier.
        import hr_checklists as hc
        import hr_packet_docs as hpd
        if not to:
            raise PacketError(f"Add {emp.first_name}'s personal email first - {why}.", 409)
        d["job_title"], d["department"] = emp.job_title or "", emp.department or ""
        d["send_kind"] = kind_of
        ctx = {"entity": entity, "owners": hc.role_owners(db, emp.company or ""), "sender": user["email"].lower(),
               "subject_email": to, "subject_emails": [emp.work_email, emp.personal_email], "subject_name": name,
               "subject_kind": kind_of, "manager_email": (emp.manager_email or "").strip().lower()}
        docplan = hpd.plan(db, setting, ctx=ctx, overrides=hpd.event_values(db, "separation", d), pay=None,
                           can_see_pay=False, employee_id=emp.id, entity_id=emp.company or "")
        package = True
    elif d["send_package"]:
        if not setting:
            raise PacketError(f"No separation package is set up for {company} - add one under People > "
                              f"Settings > Hiring > Hiring Documents, or offboard without documents.", 409)
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
            "docplan": docplan,
            "merge": merge, "unresolved": unresolved, "parties": parties, "subjectName": name,
            "to": to, "why": why, "company": company,
            "title": f"{EVENT_TITLES['separation']} - {name}",
            "subfolder": ((setting.egnyte_subfolder if setting else "") or "").strip() or DEFAULT_SUBFOLDERS["separation"]}


def separation_preview_out(plan: dict) -> dict:
    d, tpl = plan["details"], plan["template"]
    if plan.get("docplan") is not None:
        dp = plan["docplan"]
        return {"engine": "documents", "title": plan["title"], "company": plan["company"], "lastDay": d["last_day"],
                "immediate": d["immediate"], "sendTo": plan["to"], "why": plan["why"], "package": True,
                "packetName": plan["setting"].name or "", "documents": [x["name"] for x in dp["documents"]],
                "recipients": dp["recipients"], "verifier": dp["verifier"], "problems": dp["problems"],
                "unresolved": [], "entityId": plan["employee"].company or "",
                "egnyteSubfolder": plan["subfolder"]}
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
    if ev.status in ("intake", "review") and (ev.inputs or {}).get("send_kind") == "internal":
        # Not sent yet (Oct 14): when it is, it goes to their personal email.
        personal = (emp.personal_email or "").strip().lower()
        if not personal:
            _notify(db, ev.created_by, f"Separation Package Has Nowhere to Go - {ev.subject_name}",
                    f"{ev.subject_name} is Left and their work email is closed. Add their personal email on "
                    f"People before the package is sent.", ev, priority=1)
            return "package not sent yet - no personal email to send it to"
        ev.subject_email = personal
        ev.inputs = {**(ev.inputs or {}), "send_kind": "external"}
        return f"package will go to {personal}"
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
        _notify(db, ev.created_by, f"Separation Package Stuck - {ev.subject_name}",
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
    if busy and busy.status in OPEN:
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
    if plan.get("docplan") is not None:
        # The package is generated now and waits for the verifier (Oct 14);
        # the offboarding never waits on it.
        import hr_packet_docs as hpd
        ev.status, ev.completed_at, ev.documents = "review", "", []
        ev.inputs = {**dict(d), "verifier_role": plan["setting"].verify_role or "hr", "engine": "documents",
                     "extra": dict(d.get("merge") or {})}
        db.flush()
        p = hpd.event_plan(db, ev, plan["setting"], sender=user["email"], can_see_pay=False)
        hpd.sync_documents(db, ev, plan["setting"], p, user["email"].lower())
        _ask_verifier(db, ev, p)
    elif plan["package"]:
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
                sender_signs_first=sender_first, prints_pay=pay_in_letter(plan["template"]))
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
            _notify(db, to, f"Offboarding Scheduled - {ev.subject_name}",
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
    if ev.status in ("intake", "review"):
        void_open(db, ev, actor)       # never sent: its documents are archived
        return
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
                _notify(db, ev.created_by, f"{ev.subject_name} Is Now Left",
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

def file_one(db: Session, ev: HrLifeEvent, folder: str = "") -> tuple:
    """Create the person's Egnyte folder (if needed) and file the sealed packet
    and any signer attachments into its event subfolder. (ok, message).

    `folder` (File Manually, Oct 15 2026): an Egnyte folder HR picked when the
    wired one cannot be made - it must already exist; nothing above it is
    created, so a typo can never invent a company's folder tree."""
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
    if folder:
        found = egnyte_wiring._match_path(folder)
        if not found:
            return False, f"There is no folder {svc.norm(folder)} in Egnyte - check the path, or create it there first."
        folder = found
    else:
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


FILED_BY_HAND = "filed_by_hand"


def file_by_hand(db: Session, ev: HrLifeEvent, folder: str, by: str) -> list:
    """File Manually (Pranshu, Oct 15 2026): when automatic filing fails, HR
    picks the Egnyte folder and every signed, unfiled packet for the same
    person (the offer letter and the hiring packet together) is filed there.
    Each one filed is marked filed by hand - the card leaves the profile at
    once. Returns the events it tried; raises PacketError when none could be
    filed. Commits."""
    folder = (folder or "").strip()
    if not folder:
        raise PacketError("Paste the Egnyte folder to file into.")
    q = db.query(HrLifeEvent).filter(HrLifeEvent.status == "completed", HrLifeEvent.filing_status != "filed")
    if ev.employee_id:
        q = q.filter(HrLifeEvent.employee_id == ev.employee_id)
    else:
        q = q.filter(HrLifeEvent.id == ev.id)
    events = q.order_by(HrLifeEvent.completed_at).with_for_update().all()
    if not events:
        raise PacketError("Nothing left to file - it is already in Egnyte.", 409)
    errors = []
    for one in events:
        try:
            ok, msg = file_one(db, one, folder)
        except Exception as e:      # Egnyte/network trouble
            ok, msg = False, f"{type(e).__name__}: {str(e)[:200]}"
        one.updated_at = _now()
        if ok:
            one.filing_status, one.filing_path, one.filing_error, one.filing_next_at = "filed", msg, "", ""
            one.flags = [f for f in (one.flags or []) if f.get("code") != FILED_BY_HAND] + [
                {"code": FILED_BY_HAND, "message": f"Filed by hand by {by} into {folder}"}]
        else:
            one.filing_error = msg[:500]
            errors.append(msg)
    db.commit()
    if len(errors) == len(events):
        raise PacketError(errors[0])
    return events


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
            _notify(db, ev.created_by, f"Not Filed in Egnyte - {ev.subject_name}",
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
        try:
            # Signed Time Sheets whose Egnyte filing failed (Oct 20 2026) -
            # a bounded retry, see timesheet_filing.py.
            import timesheet_filing
            await asyncio.to_thread(timesheet_filing.process_due)
        except Exception as e:
            print(f"[life-events] time sheet filing retry failed: {e}")
        await asyncio.sleep(LOOP_EVERY_SEC)
