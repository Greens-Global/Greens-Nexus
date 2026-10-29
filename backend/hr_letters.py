"""HR letters an employee requests from My HR (Neil, Oct 27 2026).

    Employees request standard HR letters themselves; HR issues them.

The catalog is fixed - Employment Verification, Salary Certificate,
Experience Letter, Address Proof and Visa NOC (No Objection Certificate) -
and each type prints from a Documents template, read at its PUBLISHED
version like every HR packet document. Nexus seeds one default template per
type (fixed ids, `hr-letter-<type>`, category HR) the first time the catalog
is read; HR edits them in Documents like any other template, or points a
type at a template of their own. Which types a company offers, which
template each uses and the letterhead are one layered setting
(scoped_settings, base key `hr_letters`): defaults <- the organization row
<- the company's own copy. Settings > Hiring & Onboarding > HR Letters.

A request moves Requested -> In Review -> Awaiting Signature -> Issued, or
Declined (with a reason) from either of the first two. HR for the person's
company (`hr_companies`: the company's HR contact, an administrator, or a
Full HR grant - within their People scope - never on their own request)
reviews the generated letter with its values filled, edits any of them,
then Issues it: one Nexus Sign envelope whose ONLY signer is the company's
Authorized Signatory (HrEntity.signatory_email; the HR contact when there
is none). The employee is not a signer, so the HR signing order ("the
company never signs before the employee") is not in play - nobody signs
before them because they never sign. The letter prints the signer's name
and title ({{signer.company}} / {{signer.company.title}}) above the
signature line.

Pay: a Salary Certificate prints pay. It is generated (previewed with the
figure, or issued) only by an HR issuer holding Pay & Benefits (hr_comp);
anyone else previews it with [Pay]. The figure comes from the person's
compensation at render time, or from what an hr_comp holder typed
(`pay_values`, never shown to anyone else, never written into `values`).
The signatory must hold hr_comp too - they read the figure - and the
envelope is pay-gated (prints_pay). Any template HR points a type at is
checked the same fail-closed way (hr_packet_docs.is_pay_token).

Sealed (esign's `hr_letter` link hook -> on_completed), the letter is
Issued: it shows in the employee's My HR > My Documents and on their People
profile (esign files every sealed envelope with an employee onto it), and
the filing pass (`process_filing`, every minute in life_events_loop's
worker thread) files it into their Egnyte person folder under "HR Letters",
best-effort with backoff.

Notifications are server-side and ONE per request and recipient, updated in
place (`_bell`): the employee hears at each step; HR hears of a new request.
"""
import copy
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import hr_packet_docs as hpd
import scoped_settings as sc
import workflows
from models import (DocLetterhead, DocTemplate, DocTemplateVersion, HrEntity, HrLetterRequest,
                    HrSignRequest, NexusEmployee, NexusNotification)
import job_switch

SETTINGS_BASE = "hr_letters"
LINK_KIND = "hr_letter"
BELL_SOURCE = "hr-letters"            # NexusNotification.requested_by - finds this flow's bells
# Where the bells open (Neil, Oct 28 2026): Ask HR on My HR, where letters
# live beside the other HR requests and the ones waiting on HR head the
# panel - every HR contact can open it, People access or not. A bell about
# one request still waiting on HR opens that request (`_hr_action_for`).
_HR_ACTION = {"view": "myhr", "sub": "ask-hr"}


def _hr_action_for(req) -> dict:
    return {"view": "myhr", "sub": f"ask-hr:letter:{req.id}"}
EGNYTE_SUBFOLDER = "HR Letters"
FILING_BACKOFF_MIN = (1, 5, 15, 60, 180, 360)

LETTER_TYPES = (
    {"key": "employment_verification", "label": "Employment Verification", "pay": False,
     "desc": "Confirms you work here: your title, department and start date."},
    {"key": "salary_certificate", "label": "Salary Certificate", "pay": True,
     "desc": "Confirms your employment and your current pay."},
    {"key": "experience_letter", "label": "Experience Letter", "pay": False,
     "desc": "Describes your role and how long you have been with us."},
    {"key": "address_proof", "label": "Address Proof", "pay": False,
     "desc": "Confirms the home address the company has on file for you."},
    {"key": "visa_noc", "label": "Visa NOC", "pay": False,
     "desc": "A No Objection Certificate for a visa application or travel."},
)
TYPES = {t["key"]: t for t in LETTER_TYPES}
TYPE_KEYS = tuple(t["key"] for t in LETTER_TYPES)

STATUSES = ("requested", "in_review", "awaiting_signature", "issued", "declined")
STATUS_LABELS = {"requested": "Requested", "in_review": "In Review", "awaiting_signature": "Awaiting Signature",
                 "issued": "Issued", "declined": "Declined"}
OPEN = ("requested", "in_review", "awaiting_signature")
REVIEWABLE = ("requested", "in_review")

_EMPLOYMENT_WORDS = {"full_time": "full-time", "part_time": "part-time", "contractor": "contract",
                     "intern": "internship"}
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Variables the letter fills by itself and HR never edits.
_SYSTEM_TOKENS = ("today",)
_SYSTEM_PREFIXES = ("template.", "signer.")


class LetterError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(s, limit: int) -> str:
    return _CTRL.sub("", str(s or "")).strip()[:limit]


def us_date(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return ""


def type_label(key: str) -> str:
    return (TYPES.get(key) or {}).get("label") or "HR Letter"


def letter_noun(key: str) -> str:
    """'Salary Certificate' / 'Employment Verification Letter' - what a
    notice calls it."""
    label = type_label(key)
    return label if label.endswith(("Letter", "Certificate", "Proof", "NOC")) else f"{label} Letter"


# ── the default templates ────────────────────────────────────────────────────

def default_template_id(key: str) -> str:
    return f"hr-letter-{key.replace('_', '-')}"


def _content(key: str) -> dict:
    """The seeded letter for a type: American English, the date as a letter
    prints it ({{today}}), the person's details from People, and the
    company's signature block with the signer's printed name and title."""
    from routers.documents import _h, _mf, _p, _t, as_pages

    def closing():
        return [_p(_t("Sincerely,")),
                {"type": "signatureBlock", "attrs": {"role": "company"}},
                _p(_mf("signer.company")), _p(_mf("signer.company.title")), _p(_mf("company_legal"))]

    head = [_p(_mf("today")), _p(_mf("addressed_to"))]
    purpose = _p(_t("This letter is issued at the employee's request for the following purpose: "),
                 _mf("purpose"), _t("."))
    contact = _p(_t("If you need anything further, please contact our Human Resources team at "),
                 _mf("company_legal"), _t("."))
    bodies = {
        "employment_verification": [
            _h("Employment Verification"), *head,
            _p(_t("This letter confirms that "), _mf("full_name"), _t(" is employed by "), _mf("company_legal"),
               _t(" as "), _mf("job_title"), _t(" in the "), _mf("department"), _t(" department. "),
               _mf("first_name"), _t(" has worked with us since "), _mf("start_date"), _t(" and is employed on a "),
               _mf("employment_type"), _t(" basis.")),
            purpose, contact],
        "salary_certificate": [
            _h("Salary Certificate"), *head,
            _p(_t("This is to certify that "), _mf("full_name"), _t(", "), _mf("job_title"), _t(", has been employed by "),
               _mf("company_legal"), _t(" since "), _mf("start_date"), _t(" on a "), _mf("employment_type"),
               _t(" basis.")),
            _p(_t("Current pay: "), _mf("salary"), _t(", before taxes and deductions.")),
            purpose, contact],
        "experience_letter": [
            _h("Experience Letter"), *head,
            _p(_t("This is to certify that "), _mf("full_name"), _t(" has been employed by "), _mf("company_legal"),
               _t(" since "), _mf("start_date"), _t(" and currently holds the position of "), _mf("job_title"),
               _t(" in the "), _mf("department"), _t(" department.")),
            _p(_t("During this time, "), _mf("first_name"), _t(" has carried out their responsibilities with "
               "professionalism and dedication.")),
            purpose, contact],
        "address_proof": [
            _h("Address Verification"), *head,
            _p(_t("This is to confirm that "), _mf("full_name"), _t(", employed by "), _mf("company_legal"),
               _t(" as "), _mf("job_title"), _t(" since "), _mf("start_date"),
               _t(", has the following home address on file with the company:")),
            _p(_mf("address")),
            purpose, contact],
        "visa_noc": [
            _h("No Objection Certificate"), *head,
            _p(_t("This is to certify that "), _mf("full_name"), _t(" is employed by "), _mf("company_legal"),
               _t(" as "), _mf("job_title"), _t(" in the "), _mf("department"), _t(" department, and has been with "
               "us since "), _mf("start_date"), _t(".")),
            _p(_mf("company_legal"), _t(" has no objection to "), _mf("first_name"),
               _t(" applying for a visa and traveling for the following purpose: "), _mf("purpose"), _t(". "),
               _mf("first_name"), _t(" will continue in their position with the company during and after this "
               "travel.")),
            contact],
    }
    return as_pages({"type": "doc", "content": bodies[key] + closing()})


_FIELD_DEFS = [
    {"token": "addressed_to", "label": "Addressed To", "type": "text"},
    {"token": "purpose", "label": "Purpose", "type": "text"},
    {"token": "employment_type", "label": "Employment Type", "type": "text"},
]


def ensure_templates(db: Session) -> bool:
    """Seed the default template of every type that has none yet - active
    and published, so a request can be issued the day this ships. Never
    touches a template that exists (HR may have edited it). True when it
    added any; the caller commits."""
    have = {t for (t,) in db.query(DocTemplate.id).filter(
        DocTemplate.id.in_([default_template_id(k) for k in TYPE_KEYS])).all()}
    added = False
    now = _now()
    for t in LETTER_TYPES:
        tid = default_template_id(t["key"])
        if tid in have:
            continue
        content = _content(t["key"])
        defs = copy.deepcopy(_FIELD_DEFS)
        if t["pay"]:
            defs.append({"token": "salary", "label": "Current Pay", "type": "text", "pay": True})
        meta = {"fieldDefs": defs, "signerRoles": [{"key": "company", "label": "Company Signatory", "order": 1}],
                "mergeOverrides": {}, "letterheadId": "", "requiresLetterhead": True}
        try:
            with db.begin_nested():       # rolled back alone if it fails
                db.add(DocTemplate(id=tid, name=f"HR Letter - {t['label']}", category="hr", tags=["hr-letter"],
                                   content=content, requires_letterhead=True, letterhead_id="", merge_overrides={},
                                   field_defs=copy.deepcopy(defs), department="", doc_type="document",
                                   signer_roles=meta["signerRoles"], status="active", version=1,
                                   created_by="nexus", created_at=now, updated_by="nexus", updated_at=now,
                                   published_version=1, published_meta=meta, published_by="nexus", published_at=now))
                db.add(DocTemplateVersion(id=f"{tid}-v1", template_id=tid, version_no=1,
                                          content=copy.deepcopy(content), edited_by="nexus", edited_at=now,
                                          note="Seeded by Nexus (published)"))
            added = True
        except IntegrityError:            # a second request seeding the same id at the same moment
            pass
    return added


# ── settings: which types, which template, the letterhead ────────────────────

def _defaults() -> dict:
    out = {k: {"on": True, "templateId": ""} for k in TYPE_KEYS}
    out["letterheadId"] = ""
    return out


def _normalize(cfg: dict) -> dict:
    out = _defaults()
    for k in TYPE_KEYS:
        v = (cfg or {}).get(k)
        if isinstance(v, dict):
            out[k] = {"on": bool(v.get("on", True)), "templateId": _clean(v.get("templateId"), 80)}
    out["letterheadId"] = _clean((cfg or {}).get("letterheadId"), 80)
    return out


def settings_for(db: Session, company_id: str = "") -> dict:
    return _normalize(sc.get(db, SETTINGS_BASE, _defaults(), company_id or ""))


def has_override(db: Session, company_id: str) -> bool:
    return sc.has_override(db, SETTINGS_BASE, company_id or "")


def save_settings(db: Session, company_id: str, cfg: dict, actor: str) -> dict:
    clean = _normalize(cfg)
    for k in TYPE_KEYS:
        tid = clean[k]["templateId"]
        if tid and not db.query(DocTemplate).filter(DocTemplate.id == tid, DocTemplate.status == "active").first():
            raise LetterError(f"The template picked for {type_label(k)} is not an active template in Documents.")
    lid = clean["letterheadId"]
    if lid and not db.query(DocLetterhead).filter(DocLetterhead.id == lid).first():
        raise LetterError("That letterhead no longer exists.")
    sc.save(db, SETTINGS_BASE, company_id or "", clean, actor)
    return clean


def enabled_types(db: Session, company_id: str) -> list:
    cfg = settings_for(db, company_id)
    return [t for t in LETTER_TYPES if cfg[t["key"]]["on"]]


# ── who is HR for a request ──────────────────────────────────────────────────

def hr_companies(db: Session, user: dict) -> Optional[set]:
    """The companies `user` handles letters for - None = every company. HR
    for a company is its HR contact, an administrator, or a Full HR grant,
    the last two within their People scope (a manager-tier caller's People
    scope is their own team, which holds no company)."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_scope, is_team_scope
    email = (user.get("email") or "").strip().lower()
    if not email or user.get("external"):
        return set()
    contact = {e.id for e in db.query(HrEntity).filter(func.lower(HrEntity.hr_contact_email) == email).all()}
    wide = (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(email, "hr", db) >= _MODULE_LEVEL_RANK["full"])
    if not wide:
        return contact
    scope = hr_scope(user, db)
    if is_team_scope(scope):
        return contact
    if scope is None:
        return None
    return set(scope) | contact


def current_company(db: Session, req: HrLetterRequest) -> str:
    """The company a request is HR's business for: while it is still before
    issue (Requested / In Review), the person's CURRENT company in People - a
    person who moved companies is their new company's HR's, and the letter
    prints that company - else the company it was issued for."""
    if req.status in REVIEWABLE:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == req.employee_id).first()
        if emp is not None and (emp.company or "") != (req.company_id or ""):
            return emp.company or ""
    return req.company_id or ""


def refresh_company(db: Session, req: HrLetterRequest) -> None:
    """Point a not-yet-issued request at the person's current company (saved
    with whatever the caller commits - the issue does)."""
    cid = current_company(db, req)
    if cid != (req.company_id or ""):
        req.company_id = cid


def is_hr_for(db: Session, user: dict, req: HrLetterRequest) -> bool:
    """HR for this request - by the person's current company at review / issue
    time (current_company); never on their own (there they are the employee)."""
    if (user.get("email") or "").strip().lower() == (req.employee_email or "").lower():
        return False
    comps = hr_companies(db, user)
    return comps is None or current_company(db, req) in comps


def can_see_pay(db: Session, user: dict) -> bool:
    from routers.hr import _has_comp
    return _has_comp(user, db)


# ── the people on a letter ───────────────────────────────────────────────────

def _employee(db: Session, req: HrLetterRequest) -> Optional[NexusEmployee]:
    return db.query(NexusEmployee).filter(NexusEmployee.id == req.employee_id).first()


def _entity(db: Session, company_id: str) -> Optional[HrEntity]:
    return db.query(HrEntity).filter(HrEntity.id == company_id).first() if company_id else None


def signer_for(db: Session, req: HrLetterRequest) -> dict:
    """The one signer: the company's Authorized Signatory, else its HR
    contact - an active person in People who is not the employee.
    {email, name, title, role, problem}."""
    ent = _entity(db, req.company_id)
    if ent is None:
        return {"email": "", "name": "", "title": "", "role": "", "problem":
                "This person has no company in People - set their company before issuing a letter."}
    me = (req.employee_email or "").lower()
    tried = []
    for role, raw in (("Authorized Signatory", ent.signatory_email), ("HR Contact", ent.hr_contact_email)):
        email = (raw or "").strip().lower()
        if not email or email in tried:
            continue
        tried.append(email)
        if email == me:
            continue
        p = hpd.person(db, email)
        if p is None or (p.status or "") not in ("active", "onboarding"):
            continue
        return {"email": email, "name": hpd.name_of(db, email), "title": p.job_title or "", "role": role,
                "problem": ""}
    return {"email": "", "name": "", "title": "", "role": "", "problem":
            f"{ent.name} has no Authorized Signatory or HR contact who can sign this letter - "
            f"set one in Settings > Companies (an active person other than {req.employee_name or 'the employee'})."}


# ── the template and its values ──────────────────────────────────────────────

def template_for(db: Session, req: HrLetterRequest) -> tuple:
    """(snap, problem) for the request's type in its company."""
    from routers.documents import TemplateNotPublished, published_snapshot
    cfg = settings_for(db, req.company_id)
    tid = (cfg.get(req.letter_type) or {}).get("templateId") or default_template_id(req.letter_type)
    tpl = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if tpl is None:
        return None, (f"The template for {type_label(req.letter_type)} no longer exists in Documents - pick "
                      f"another in Settings > Hiring & Onboarding > HR Letters.")
    if tpl.status != "active":
        return None, f'"{tpl.name}" is {tpl.status} in Documents - activate it, or pick another template.'
    try:
        content, meta, version = published_snapshot(db, tpl)
    except TemplateNotPublished as e:
        return None, str(e)
    return hpd.Snap(tpl, content, meta, version), ""


def _label_for(token: str, snap) -> str:
    from services.merge_fields import BUILTIN_VARIABLES
    fd = snap.defs.get(token) or {}
    if fd.get("label"):
        return str(fd["label"])
    builtin = {t: lbl for t, lbl, _g in BUILTIN_VARIABLES}
    if token in builtin:
        return " ".join(w[:1].upper() + w[1:] for w in builtin[token].split())
    return token.replace(".", " ").replace("_", " ").title()


def _is_system(token: str) -> bool:
    return token in _SYSTEM_TOKENS or token.startswith(_SYSTEM_PREFIXES)


def pay_tokens(snap) -> list:
    return sorted(t for t in snap.tokens if hpd.is_pay_token(t, snap.defs))


def value_tokens(snap) -> list:
    """The variables HR may edit: every one the letter prints except pay and
    what Nexus fills by itself. In the order the letter prints them."""
    seen, out = set(), []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "mergeField":
                t = ((node.get("attrs") or {}).get("token") or "").strip()
                if t and t not in seen:
                    seen.add(t)
                    out.append(t)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(snap.content)
    for t in sorted(snap.tokens):           # a {{token}} typed as text, not a chip
        if t not in seen:
            seen.add(t)
            out.append(t)
    return [t for t in out if not _is_system(t) and not hpd.is_pay_token(t, snap.defs)]


def prints_pay(req: HrLetterRequest, snap) -> bool:
    """Fail closed: the Salary Certificate always, and any letter whose
    template prints a pay variable."""
    return bool((TYPES.get(req.letter_type) or {}).get("pay")) or (snap is not None and bool(pay_tokens(snap)))


def _auto_overrides(db: Session, req: HrLetterRequest, signer: dict) -> dict:
    emp = _employee(db, req)
    out = {"addressed_to": req.addressed_to or "To Whom It May Concern",
           "purpose": req.purpose or "",
           "employment_type": _EMPLOYMENT_WORDS.get((emp.employment_type if emp else "") or "", "")}
    if signer.get("email"):
        out["signer.company"] = signer["name"]
        out["signer.company.title"] = signer.get("title") or ""
    return {k: v for k, v in out.items() if v != "" or k == "signer.company.title"}


def auto_values(db: Session, req: HrLetterRequest, snap, signer: dict) -> dict:
    """What each editable variable prints with no edit from HR."""
    merge = hpd.full_merge(db, snap, employee_id=req.employee_id, entity_id=req.company_id,
                           overrides=_auto_overrides(db, req, signer))
    return {t: merge.get(t, "") for t in value_tokens(snap)}


def auto_pay(db: Session, req: HrLetterRequest) -> str:
    import hr_life_events as hle
    emp = _employee(db, req)
    return hle.pay_text((emp.compensation if emp else None) or {})


def clean_values(snap, values: Optional[dict], auto: dict) -> dict:
    """HR's edits: only variables the letter prints and HR may edit, and only
    where they differ from what Nexus fills by itself."""
    allowed = set(value_tokens(snap))
    out = {}
    for k, v in (values or {}).items():
        k = str(k)
        if k not in allowed:
            continue
        v = _clean(v, 2000)
        if v != (auto.get(k) or ""):
            out[k] = v
    return out


def clean_pay_values(snap, values: Optional[dict], auto: str) -> dict:
    out = {}
    for k, v in (values or {}).items():
        k = str(k)
        if k in pay_tokens(snap):
            v = _clean(v, 200)
            if v and v != auto:
                out[k] = v
    return out


def merge_for(db: Session, req: HrLetterRequest, snap, signer: dict, *, values: dict, pay_values: dict,
              show_pay: bool) -> dict:
    overrides = {**_auto_overrides(db, req, signer), **(values or {})}
    pay = {}
    toks = pay_tokens(snap)
    if toks:
        if show_pay:
            auto = auto_pay(db, req)
            pay = {t: (pay_values or {}).get(t) or auto for t in toks}
            pay = {t: v for t, v in pay.items() if v}
        else:
            pay = {t: "[Pay]" for t in toks}
    return hpd.full_merge(db, snap, employee_id=req.employee_id, entity_id=req.company_id,
                          overrides=overrides, pay=pay)


def letterhead_for(db: Session, req: HrLetterRequest, snap) -> str:
    """None unless the template wants one; then the company's pick in
    Settings, else the template's own, else the default letterhead."""
    if not snap.meta.get("requiresLetterhead"):
        return ""
    picked = settings_for(db, req.company_id).get("letterheadId") or ""
    if picked and db.query(DocLetterhead).filter(DocLetterhead.id == picked).first():
        return picked
    if snap.meta.get("letterheadId"):
        return snap.meta["letterheadId"]
    lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    return lh.id if lh else ""


def render(db: Session, req: HrLetterRequest, snap, signer: dict, *, values: dict, pay_values: dict,
           show_pay: bool, placeholders: bool, anchors: Optional[list] = None) -> tuple:
    """(pdf, missing). With `placeholders`, a variable nothing fills prints
    as [Its Label] (a preview); without, it stays missing (Issue refuses)."""
    merge = merge_for(db, req, snap, signer, values=values, pay_values=pay_values, show_pay=show_pay)
    missing = hpd.unresolved(snap, merge)
    # A value HR cleared prints blank otherwise ("in the  department") - it
    # is as missing as one nothing fills.
    missing += [t for t in value_tokens(snap) + pay_tokens(snap)
                if t in merge and not str(merge[t]).strip() and t not in missing]
    if placeholders:
        for t in missing:
            merge[t] = f"[{_label_for(t, snap)}]"
    pdf = hpd.render(db, snap, title=f"{type_label(req.letter_type)} - {req.employee_name}",
                     letterhead_id=letterhead_for(db, req, snap), merge=merge,
                     employee_id=req.employee_id, entity_id=req.company_id, anchors=anchors)
    return pdf, missing


def review_out(db: Session, req: HrLetterRequest, user: dict) -> dict:
    """What the HR review shows: the editable values (pay only for hr_comp),
    who signs, and every problem that would stop Issue. A pure read."""
    comp = can_see_pay(db, user)
    snap, problem = template_for(db, req)
    signer = signer_for(db, req)
    problems = [p for p in (problem, signer["problem"]) if p]
    fields, pay_fields, missing = [], [], []
    pays = False
    if snap is not None:
        pays = prints_pay(req, snap)
        auto = auto_values(db, req, snap, signer)
        saved = req.values or {}
        for t in value_tokens(snap):
            value = saved.get(t, auto.get(t, ""))
            fields.append({"token": t, "label": _label_for(t, snap), "value": value, "auto": auto.get(t, ""),
                           "edited": t in saved})
            if not str(value).strip():
                missing.append(_label_for(t, snap))
        if comp:
            ap = auto_pay(db, req)
            for t in pay_tokens(snap):
                value = (req.pay_values or {}).get(t) or ap
                pay_fields.append({"token": t, "label": _label_for(t, snap), "value": value, "auto": ap})
                if not value:
                    missing.append(_label_for(t, snap))
        if pays and not comp:
            problems.append("This letter shows pay - issuing it needs Pay & Benefits access.")
        if pays and signer["email"] and not hpd.has_comp_for(db, signer["email"]):
            problems.append(f"{signer['name']} signs this letter but has no Pay & Benefits access to see the pay "
                            f"it shows - give them access, or set another Authorized Signatory.")
        if missing:
            problems.append(f"Fill in: {', '.join(missing)}.")
    return {"request": ser(db, req, for_hr=True), "fields": fields, "payFields": pay_fields,
            "printsPay": pays, "canSeePay": comp,
            "template": {"id": snap.tpl.id, "name": snap.tpl.name, "version": snap.version} if snap else None,
            "signer": {k: signer[k] for k in ("email", "name", "title", "role")},
            "problems": problems, "canIssue": req.status in REVIEWABLE and not problems,
            "canDecline": req.status in REVIEWABLE}


# ── serialization ────────────────────────────────────────────────────────────

def ser(db: Session, req: HrLetterRequest, *, for_hr: bool = False) -> dict:
    out = {"id": req.id, "type": req.letter_type, "typeLabel": type_label(req.letter_type),
           "status": req.status, "statusLabel": STATUS_LABELS.get(req.status, req.status.replace("_", " ").title()),
           "purpose": req.purpose or "", "addressedTo": req.addressed_to or "", "neededBy": req.needed_by or "",
           "notes": req.notes or "", "employeeName": req.employee_name or "",
           "createdAt": req.created_at or "", "updatedAt": req.updated_at or "",
           "issuedAt": req.issued_at or "", "completedAt": req.completed_at or "",
           "declineReason": req.decline_reason or "", "note": req.note or "",
           "signerName": req.signer_name or "",
           "printsPay": bool((TYPES.get(req.letter_type) or {}).get("pay")),
           "documentId": req.sign_request_id if req.status == "issued" else ""}
    if for_hr:
        ent = _entity(db, req.company_id)
        out.update({"employeeId": req.employee_id, "employeeEmail": req.employee_email or "",
                    "companyId": req.company_id or "", "companyName": ent.name if ent else "",
                    "signRequestId": req.sign_request_id or "", "filingStatus": req.filing_status or "",
                    "filingError": (req.filing_error or "") if req.filing_status == "failed" else ""})
    return out


# ── notifications: one per request and recipient, updated in place ──────────

def _bell(db: Session, to: str, title: str, body: str, req: HrLetterRequest, action: dict,
          priority: int = 0) -> None:
    import json
    from notify_company import notification_company
    to = (to or "").strip().lower()
    if not to:
        return
    row = (db.query(NexusNotification)
           .filter(NexusNotification.recipient == to, NexusNotification.ref_id == req.id,
                   NexusNotification.requested_by == BELL_SOURCE).first())
    if row is None:
        row = NexusNotification(id=str(uuid.uuid4()), type="custom_alert", recipient=to, ref_id=req.id,
                                requested_by=BELL_SOURCE, item_name="",
                                company=notification_company(db, req.employee_email, to))
        db.add(row)
    row.title, row.body = title, body
    row.action = json.dumps(action)
    row.actioned, row.read_by, row.closed_by = False, "", ""
    row.priority = 1 if priority else 0
    row.created_at = _now()


def _tell_employee(db: Session, req: HrLetterRequest, title: str, body: str) -> None:
    _bell(db, req.employee_email, title, body, req, dict(_HR_ACTION))


def _hr_audience(db: Session, req: HrLetterRequest) -> list:
    """Who hears of a new request: the company's HR contact; with none, the
    Global Admins (the request is never left with nobody)."""
    ent = _entity(db, req.company_id)
    hr = ((ent.hr_contact_email if ent else "") or "").strip().lower()
    if hr and hr != (req.employee_email or "").lower():
        return [hr]
    import hr_checklists
    return [e for e in hr_checklists.global_admins(db) if e != (req.employee_email or "").lower()]


def _settle_hr_bells(db: Session, req: HrLetterRequest) -> None:
    """HR's "new request" bells are done once someone acts on it."""
    for n in (db.query(NexusNotification)
              .filter(NexusNotification.ref_id == req.id, NexusNotification.requested_by == BELL_SOURCE,
                      NexusNotification.recipient != (req.employee_email or "").lower()).all()):
        n.actioned = True


# ── the workflow ─────────────────────────────────────────────────────────────

def create(db: Session, emp: NexusEmployee, body: dict) -> HrLetterRequest:
    key = str(body.get("letter_type") or body.get("type") or "").strip()
    if key not in TYPES:
        raise LetterError("Pick the letter you need.")
    company = (emp.company or "").strip()
    if not company:
        raise LetterError("Your HR record has no company yet - ask HR to set it, then request the letter.")
    if key not in {t["key"] for t in enabled_types(db, company)}:
        raise LetterError(f"{type_label(key)} letters are not offered for your company - ask HR.")
    purpose = _clean(body.get("purpose"), 500)
    if not purpose:
        raise LetterError("Say what the letter is for - a bank, a landlord, a visa application...")
    needed = _clean(body.get("needed_by"), 10)
    if needed:
        try:
            day = date.fromisoformat(needed) if _ISO.match(needed) else None
        except ValueError:
            day = None
        if day is None:
            raise LetterError("Pick the date you need the letter by.")
        # A day of slack: "today" where the employee is may be yesterday in UTC.
        if day < datetime.now(timezone.utc).date() - timedelta(days=1):
            raise LetterError("The date you need it by has already passed.")
    email = (emp.work_email or "").strip().lower()
    dup = (db.query(HrLetterRequest)
           .filter(HrLetterRequest.employee_id == emp.id, HrLetterRequest.letter_type == key,
                   HrLetterRequest.status.in_(OPEN)).first())
    if dup is not None:
        raise LetterError(f"You already have a {type_label(key)} request open - HR is on it.", 409)
    now = _now()
    name = (emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip() or email
    req = HrLetterRequest(id=str(uuid.uuid4()), employee_id=emp.id, employee_email=email, employee_name=name,
                          company_id=company, letter_type=key, purpose=purpose,
                          addressed_to=_clean(body.get("addressed_to"), 200), needed_by=needed,
                          notes=_clean(body.get("notes"), 2000), status="requested", values={}, pay_values={},
                          created_at=now, updated_at=now)
    db.add(req)
    db.flush()
    workflows.emit(db, "letter.requested", subject=req, actor=email)
    when = f" by {us_date(needed)}" if needed else ""
    for to in _hr_audience(db, req):
        _bell(db, to, f"New Letter Request - {name}",
              f"{name} asked for a {letter_noun(key)}{when}: {purpose[:200]}", req,
              _hr_action_for(req))
    return req


def start_review(db: Session, req: HrLetterRequest, user: dict) -> None:
    if req.status not in REVIEWABLE:
        raise LetterError(f"This request is {STATUS_LABELS.get(req.status, req.status)} - there is nothing to review.", 409)
    if req.status == "requested":
        now = _now()
        req.status, req.reviewed_by, req.reviewed_at, req.updated_at = "in_review", user["email"].lower(), now, now
        _settle_hr_bells(db, req)
        _tell_employee(db, req, f"{letter_noun(req.letter_type)} - In Review",
                       f"HR is preparing your {letter_noun(req.letter_type)}. You will hear here when it is ready.")


def save_values(db: Session, req: HrLetterRequest, user: dict, values: Optional[dict],
                pay_values: Optional[dict]) -> None:
    if req.status not in REVIEWABLE:
        raise LetterError("This letter can no longer be changed.", 409)
    snap, problem = template_for(db, req)
    if snap is None:
        raise LetterError(problem, 409)
    signer = signer_for(db, req)
    if values is not None:
        req.values = clean_values(snap, values, auto_values(db, req, snap, signer))
    if pay_values is not None and any(str(v or "").strip() for v in pay_values.values()):
        if not can_see_pay(db, user):
            raise LetterError("Changing the pay a letter shows needs Pay & Benefits access.", 403)
        req.pay_values = clean_pay_values(snap, pay_values, auto_pay(db, req))
    elif pay_values is not None and can_see_pay(db, user):
        req.pay_values = {}
    start_review(db, req, user)
    req.updated_at = _now()


def preview(db: Session, req: HrLetterRequest, user: dict, values: Optional[dict],
            pay_values: Optional[dict]) -> bytes:
    """The letter as it would be issued with these (unsaved) values. Pay
    prints only for Pay & Benefits holders. Nothing is saved."""
    snap, problem = template_for(db, req)
    if snap is None:
        raise LetterError(problem, 409)
    signer = signer_for(db, req)
    comp = can_see_pay(db, user)
    vals = clean_values(snap, values, auto_values(db, req, snap, signer)) if values is not None else (req.values or {})
    pays = (clean_pay_values(snap, pay_values, auto_pay(db, req)) if (pay_values is not None and comp)
            else (req.pay_values or {}))
    pdf, _missing = render(db, req, snap, signer, values=vals, pay_values=pays, show_pay=comp, placeholders=True)
    return pdf


def issue(db: Session, req: HrLetterRequest, user: dict, *, values: Optional[dict], pay_values: Optional[dict],
          excluded_ack: bool, ip: str = "", user_agent: str = "") -> dict:
    """Issue: freeze the letter, send it to the company signatory - its only
    signer - through Nexus Sign. The caller holds the row lock; commits."""
    import io
    from fastapi import HTTPException
    from pypdf import PdfReader
    from routers import esign
    from routers.documents import signing_fields
    if req.status not in REVIEWABLE:
        raise LetterError(f"This request is {STATUS_LABELS.get(req.status, req.status)} - it cannot be issued now.", 409)
    if not excluded_ack:
        raise LetterError("Confirm the letter is not a record excluded from electronic signature.", 422)
    save_values(db, req, user, values, pay_values)
    snap, problem = template_for(db, req)
    signer = signer_for(db, req)
    if problem or signer["problem"]:
        raise LetterError(problem or signer["problem"], 409)
    pays = prints_pay(req, snap)
    comp = can_see_pay(db, user)
    if pays and not comp:
        raise LetterError("This letter shows pay - issuing it needs Pay & Benefits access.", 403)
    if pays and not hpd.has_comp_for(db, signer["email"]):
        raise LetterError(f"{signer['name']} signs this letter but has no Pay & Benefits access to see the pay it "
                          f"shows - give them access, or set another Authorized Signatory.", 409)
    anchors = []
    pdf, missing = render(db, req, snap, signer, values=req.values or {}, pay_values=req.pay_values or {},
                          show_pay=comp, placeholders=False, anchors=anchors)
    if missing:
        raise LetterError(f"Fill in: {', '.join(_label_for(t, snap) for t in missing)}.", 409)
    if "{{" in "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf)).pages):
        raise LetterError("The letter still shows an unfilled variable - fix the template or the values.", 409)
    fields = signing_fields(anchors)
    roles = {f["role"] for f in fields}
    if len(roles) != 1:
        raise LetterError(f'"{snap.tpl.name}" must have exactly one signature block, for the company - '
                          f"a letter is signed by the company only. Fix it in Documents and publish it.", 409)
    role = next(iter(roles))
    title = f"{type_label(req.letter_type)} - {req.employee_name}"
    path = f"esign/{uuid.uuid4()}/{re.sub(r'[^A-Za-z0-9 ._-]+', ' ', title).strip()[:90] or 'Letter'}.pdf"
    if not esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf").is_success:
        raise LetterError("Could not store the letter - try again in a minute.", 502)
    me = (user["email"] or "").lower()
    now = _now()
    prev_status = req.status
    # Set before the envelope's own commit: a crash after it never leaves a
    # sent envelope on a request that still says In Review.
    req.status, req.issued_by, req.issued_at, req.updated_at = "awaiting_signature", me, now, now
    workflows.emit(db, "letter.decided", subject=req, actor=me,
                   changes={"status": (prev_status, "awaiting_signature")}, extra={"decision": "issued", "reason": ""})
    req.template_id, req.template_version = snap.tpl.id, snap.version
    req.signer_email, req.signer_name = signer["email"], signer["name"]
    req.decline_reason, req.note, req.sign_request_id = "", "", ""
    party = esign.PartyIn(role_key=role, name=signer["name"], email=signer["email"], kind="internal",
                          ordinal=1, party_role="signer", title=signer.get("title") or "")
    try:
        out = esign.envelope_from_documents(
            db, user, documents=[{"name": f"{title}.pdf", "path": path, "fields": fields}], parties=[party],
            title=title, employee_id=req.employee_id, entity_id=req.company_id, message="",
            ip=ip, user_agent=user_agent, excluded_ack=True, document_class="employment",
            link_kind=LINK_KIND, link_id=req.id, sender_signs_first=(signer["email"] == me),
            prints_pay=pays)
    except HTTPException as ex:
        raise LetterError(str(ex.detail), ex.status_code)
    req = db.query(HrLetterRequest).filter(HrLetterRequest.id == req.id).with_for_update().first()
    req.sign_request_id = out["id"]
    _settle_hr_bells(db, req)
    _tell_employee(db, req, f"{letter_noun(req.letter_type)} - Awaiting Signature",
                   f"HR prepared your {letter_noun(req.letter_type)}. It is with {signer['name']} to sign; "
                   f"you will hear here when it is issued.")
    db.commit()
    from models import HrSignParty
    mine = (db.query(HrSignParty).filter(HrSignParty.request_id == out["id"], HrSignParty.email == me).first()
            if signer["email"] == me else None)
    return {"signRequestId": out["id"], "signPartyId": mine.id if mine else ""}


def decline(db: Session, req: HrLetterRequest, user: dict, reason: str) -> None:
    if req.status not in REVIEWABLE:
        raise LetterError(f"This request is {STATUS_LABELS.get(req.status, req.status)} - it cannot be declined now.", 409)
    reason = _clean(reason, 1000)
    if not reason:
        raise LetterError("Say why - the employee reads it.")
    now = _now()
    prev_status = req.status
    req.status, req.decline_reason = "declined", reason
    req.declined_by, req.declined_at, req.updated_at = user["email"].lower(), now, now
    workflows.emit(db, "letter.decided", subject=req, actor=user["email"],
                   changes={"status": (prev_status, "declined")}, extra={"decision": "declined", "reason": reason})
    _settle_hr_bells(db, req)
    _tell_employee(db, req, f"{letter_noun(req.letter_type)} - Declined", f"HR declined your request: {reason}")


# ── Nexus Sign callbacks (esign._link_hook, link_kind 'hr_letter') ───────────

def safe(fn, db: Session, env: HrSignRequest, *args) -> None:
    """A callback in a SAVEPOINT: an error here rolls back only what it wrote
    and is logged - the signature it rides on stands."""
    sp = db.begin_nested()
    try:
        fn(db, env, *args)
        sp.commit()
    except Exception as e:      # logged, never raised
        sp.rollback()
        print(f"[hr-letters] {getattr(fn, '__name__', fn)} failed for {getattr(env, 'id', '')}: "
              f"{type(e).__name__}: {str(e)[:300]}")


def _for(db: Session, env: HrSignRequest) -> Optional[HrLetterRequest]:
    if not env.link_id:
        return None
    req = db.query(HrLetterRequest).filter(HrLetterRequest.id == env.link_id).with_for_update().first()
    # Only the request's current envelope moves it.
    if req is not None and req.sign_request_id and req.sign_request_id != env.id:
        return None
    return req


def on_completed(db: Session, env: HrSignRequest) -> None:
    req = _for(db, env)
    if req is None or req.status == "issued":
        return
    now = _now()
    req.status, req.completed_at, req.updated_at = "issued", now, now
    req.sign_request_id = env.id
    req.filing_status, req.filing_next_at, req.filing_attempts, req.filing_error = "pending", now, 0, ""
    _tell_employee(db, req, f"{letter_noun(req.letter_type)} - Issued",
                   f"Your {letter_noun(req.letter_type)} is signed and ready. Download it from My HR > My Documents.")


def _back_to_review(db: Session, env: HrSignRequest, note: str) -> None:
    req = _for(db, env)
    if req is None or req.status != "awaiting_signature":
        return
    req.status, req.note, req.sign_request_id, req.updated_at = "in_review", note[:1000], "", _now()
    _bell(db, req.issued_by, f"Letter Not Signed - {req.employee_name}",
          f"{note} The {letter_noun(req.letter_type)} is back In Review - fix it and issue it again, or decline it.",
          req, _hr_action_for(req))
    _tell_employee(db, req, f"{letter_noun(req.letter_type)} - In Review",
                   f"Your {letter_noun(req.letter_type)} needs another look from HR before it is issued.")


def on_declined(db: Session, env: HrSignRequest, party=None, reason: str = "") -> None:
    who = getattr(party, "name", "") or "The signatory"
    _back_to_review(db, env, f"{who} declined to sign" + (f": {reason}." if reason else "."))


def on_voided(db: Session, env: HrSignRequest, actor: str = "") -> None:
    _back_to_review(db, env, f"The signature request was voided{' by ' + actor if actor else ''}.")


def on_expired(db: Session, env: HrSignRequest) -> None:
    _back_to_review(db, env, "The signature request expired unsigned.")


# ── filing the signed letter into the person's Egnyte folder ────────────────

def file_one(db: Session, req: HrLetterRequest) -> tuple:
    """(ok, message); ok None = nothing to file into (Egnyte not connected)."""
    from routers import esign
    import egnyte_wiring
    import services.egnyte as svc
    env = db.query(HrSignRequest).filter(HrSignRequest.id == req.sign_request_id).first()
    if env is None or env.status != "completed" or not env.final_pdf_path:
        return False, "The signed letter is not sealed yet."
    if not svc.configured():
        return None, "Egnyte is not connected."
    emp = _employee(db, req)
    if emp is None:
        return False, "There is no employee record to file this under."
    try:
        folder = egnyte_wiring.provision_person_folder(emp, db)
    except ValueError as e:
        return False, str(e)
    target = svc.norm(f"{folder}/{EGNYTE_SUBFOLDER}")
    svc.create_folder(target)
    blob = esign._storage_fetch(esign._DOC_BUCKET, env.final_pdf_path)
    if not blob.is_success:
        return False, "Could not read the signed letter from storage."
    day = (env.completed_at or _now())[:10]
    who = re.sub(r'[\\/:*?"<>|]+', " ", req.employee_name or "Employee").strip()[:60]
    name = f"{day} - {type_label(req.letter_type)} - {who} (signed).pdf"
    svc.upload_file(f"{target}/{name}", blob.content)
    esign._log(db, env.id, "archived", f"filed in Egnyte {target}/{name}")
    return True, f"{target}/{name}"


def run_filing(db: Session, req: HrLetterRequest) -> None:
    """One filing attempt with retry bookkeeping. Commits."""
    try:
        ok, msg = file_one(db, req)
    except Exception as e:      # Egnyte/network trouble - retry later
        ok, msg = False, f"{type(e).__name__}: {str(e)[:200]}"
    req.updated_at = _now()
    if ok:
        req.filing_status, req.filing_path, req.filing_error, req.filing_next_at = "filed", msg, "", ""
    elif ok is None:
        req.filing_status, req.filing_error, req.filing_next_at = "skipped", msg, ""
    else:
        req.filing_attempts = (req.filing_attempts or 0) + 1
        req.filing_error = msg[:500]
        if req.filing_attempts >= len(FILING_BACKOFF_MIN):
            req.filing_status, req.filing_next_at = "failed", ""
            _bell(db, req.issued_by, f"Not Filed in Egnyte - {req.employee_name}",
                  f"The signed {letter_noun(req.letter_type)} is safe in Nexus (My HR and the People profile), "
                  f"but it could not be filed in Egnyte: {msg}", req, _HR_ACTION)
        else:
            wait = FILING_BACKOFF_MIN[req.filing_attempts - 1]
            req.filing_status = "pending"
            req.filing_next_at = (datetime.now(timezone.utc) + timedelta(minutes=wait)).isoformat()
    db.commit()


def process_filing(limit: int = 10) -> int:
    """The filing pass. Runs in a worker thread (life_events_loop), never on
    the event loop."""
    if job_switch.off("hr_letter_filing"):   # Workflows > Automations switch
        return 0
    from database import SessionLocal
    db = SessionLocal()
    done = 0
    try:
        now = _now()
        ids = [r.id for r in (db.query(HrLetterRequest.id)
                              .filter(HrLetterRequest.filing_status == "pending",
                                      HrLetterRequest.filing_next_at != "",
                                      HrLetterRequest.filing_next_at <= now)
                              .order_by(HrLetterRequest.filing_next_at).limit(limit).all())]
        for rid in ids:
            req = (db.query(HrLetterRequest).filter(HrLetterRequest.id == rid,
                                                    HrLetterRequest.filing_status == "pending")
                   .with_for_update().first())
            if req is not None:
                run_filing(db, req)
                done += 1
    finally:
        db.close()
    return done
