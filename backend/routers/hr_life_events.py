"""HR life events API - packet settings per company, the hiring packet send,
and the event list each person/candidate shows. The engine is
hr_life_events.py; this file is permissions and shapes only."""
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import hr_life_events as hle
import hr_packet_docs as hpd
import role_change as rc
from auth import get_current_user, hr_scope, hr_team_limited
from database import get_db
from models import HrCandidate, HrEntity, HrLifeEvent, HrPacketSetting, HrSignTemplate, NexusEmployee
from routers.hr import _has_comp, require_hr_read, require_hr_write

router = APIRouter(prefix="/hr", tags=["hr-life-events"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_meta(request: Request) -> tuple:
    from routers.esign import _client_meta as cm
    return cm(request)


def _raise(e: hle.PacketError):
    raise HTTPException(e.status, str(e))


# ── packet settings ──────────────────────────────────────────────────────────

class PacketSettingIn(BaseModel):
    entity_id:        Optional[str] = ""
    event:            str
    worker_type:      Optional[str] = "any"
    template_id:      str
    subject_role:     Optional[str] = "employee"
    email_message:    Optional[str] = ""
    egnyte_subfolder: Optional[str] = ""
    role_ids:         Optional[list] = None       # job roles this packet is for; [] / None = every role
    id:               Optional[str] = ""          # an existing row to update


class PacketIn(BaseModel):
    """One packet, saved whole: the documents and signers (its Nexus Sign
    template) together with who it is for and how it goes out. HR never
    meets the template as a separate thing (Pranshu, Oct 8)."""
    id:               Optional[str] = ""          # HrPacketSetting.id when editing
    entity_id:        Optional[str] = ""
    event:            str
    name:             str
    role_ids:         Optional[list] = None
    worker_type:      Optional[str] = "any"
    signers:          list                        # [{key, label, order}]
    attachments:      Optional[list] = None
    body:             Optional[list] = None
    email_message:    Optional[str] = ""
    egnyte_subfolder: Optional[str] = ""


def _clean_role_ids(db: Session, entity_id: str, role_ids) -> list:
    """Only the job roles this company can hire for (its own or shared)."""
    from models import NexusGroup
    want = [str(r).strip() for r in (role_ids or []) if str(r).strip()]
    if not want:
        return []
    ok = {g.id for g in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1, NexusGroup.id.in_(want)).all()
          if not (g.company_id or "") or not entity_id or g.company_id == entity_id}
    bad = [r for r in want if r not in ok]
    if bad:
        raise HTTPException(400, "Pick roles from this company's own list.")
    return list(dict.fromkeys(want))


def _place_taken(db: Session, row: HrPacketSetting) -> None:
    """One packet per place and kind of hire per company (Neil, Oct 22): two
    "California - Employee" packets would make the send a coin toss. A role's
    own packet is the exception _roles_taken guards."""
    if row.role_ids:
        return
    for other in (db.query(HrPacketSetting)
                  .filter(HrPacketSetting.entity_id == (row.entity_id or ""), HrPacketSetting.event == row.event,
                          HrPacketSetting.id != row.id).all()):
        if (not (other.role_ids or []) and (other.country or "") == (row.country or "")
                and (other.region or "") == (row.region or "")
                and (other.worker_type or "any") == (row.worker_type or "any")):
            raise HTTPException(400, f'"{other.name or "Another packet"}" already covers '
                                     f'{hle.place_label(row.worker_type, row.country, row.region).lower()} - '
                                     f'change that one, or pick another place or kind of hire.')


def _roles_taken(db: Session, row: HrPacketSetting) -> None:
    """A job role has one packet per event per company - two would make the
    send a coin toss."""
    from models import NexusGroup
    mine = set(row.role_ids or [])
    if not mine:
        return
    for other in (db.query(HrPacketSetting)
                  .filter(HrPacketSetting.entity_id == (row.entity_id or ""), HrPacketSetting.event == row.event,
                          HrPacketSetting.id != row.id).all()):
        clash = mine & set(other.role_ids or [])
        if clash:
            g = db.query(NexusGroup).filter(NexusGroup.id == sorted(clash)[0]).first()
            tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == other.template_id).first()
            label = other.name or (tpl.name if tpl else "") or "unnamed"
            raise HTTPException(400, f"{g.name if g else 'That role'} already has a packet "
                                     f"({label}) - remove it there first.")


def _setting_in_scope(entity_id: str, scope, write: bool) -> None:
    # The default row ('' = every company) is shared - only someone who sees
    # every company may change it; a company-scoped HR admin reads it.
    if scope is None:
        return
    if not entity_id:
        if write:
            raise HTTPException(403, "Only HR with access to every company can change the default packet.")
        return
    if entity_id not in scope:
        raise HTTPException(404, "Company not found")


@router.get("/packets")
def list_packets(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    rows = db.query(HrPacketSetting).all()
    rows = [r for r in rows if scope is None or not r.entity_id or r.entity_id in scope]
    tpls = (db.query(HrSignTemplate).filter(HrSignTemplate.status == "active")
            .order_by(HrSignTemplate.name).all())
    tpls = [t for t in tpls if scope is None or not t.entity_id or t.entity_id in scope]
    # Roles made from Add Candidate's "Other" that no hiring packet names yet
    # (Neil, Oct 12) - the Packets button lights up until each gets one.
    from models import NexusGroup
    covered = {rid for r in rows if r.event == "hire" for rid in (r.role_ids or [])}
    born = (db.query(NexusGroup).filter(NexusGroup.is_job_role == 1, NexusGroup.created_from == "hiring")
            .order_by(NexusGroup.name).all())
    names = {e.id: e.name for e in db.query(HrEntity).all()}
    needing = [{"id": g.id, "name": g.name, "department": g.department or "",
                "companyId": g.company_id or "", "companyName": names.get(g.company_id or "", "")}
               for g in born if g.id not in covered
               and (scope is None or not g.company_id or g.company_id in scope)]
    # Packets built from Documents (Oct 14): the templates a packet can use
    # (active ones; Not Published ones are listed so HR sees why they can't be
    # picked yet), and the roles a signing step can be.
    from models import DocTemplate
    from routers.documents import signature_roles
    reserved = hpd._reserved_tokens()

    def own_variables(t):
        """The variables a template prints that Nexus cannot fill and the
        template gives no Default Value - what the packet's Details Form (or
        HR, on review) must supply. Pay is never asked for on a form."""
        defs = {fd.get("token"): fd for fd in (t.field_defs or []) if isinstance(fd, dict)}
        out = []
        for tok in sorted(hpd.content_tokens(t.content)):
            fd = defs.get(tok) or {}
            if (tok in reserved or "." in tok or hpd.is_pay_token(tok, defs) or str(fd.get("default") or "").strip()
                    or hpd.def_source(fd)):          # asked of the person or of HR by itself (Oct 14)
                continue
            out.append({"token": tok, "label": fd.get("label") or tok.replace("_", " ").title(),
                        "type": fd.get("type") or "text"})
        return out
    def _asks(t, source):
        printed = hpd.content_tokens(t.content)
        return [str(fd.get("label") or fd.get("token")) for fd in (t.field_defs or [])
                if isinstance(fd, dict) and hpd.def_source(fd) == source and fd.get("token") in printed]
    doc_templates = []
    for t in (db.query(DocTemplate).filter(DocTemplate.status == "active", DocTemplate.doc_type != "email")
              .order_by(DocTemplate.name).all()):
        doc_templates.append({"id": t.id, "name": t.name, "category": t.category or "",
                              "variables": own_variables(t),
                              # Who the template asks (Oct 14) - shown on the packet.
                              "personQuestions": _asks(t, "person"), "hrQuestions": _asks(t, "hr"),
                              "department": t.department or "",
                              "publishedVersion": t.published_version or 0,
                              "hasUnpublishedChanges": bool(t.published_version) and (t.version or 0) > t.published_version,
                              "signs": sorted(signature_roles(t.content)),
                              "printsSignatory": "signatory" in hpd.content_tokens(t.content),
                              "requiresLetterhead": bool(t.requires_letterhead)})
    return {
        "rolesNeedingPacket": needing,
        "docTemplates": doc_templates,
        "flowRoles": [{"key": r, "label": hpd.role_label(r)} for r in hpd.FLOW_ROLES],
        "verifyRoles": [{"key": r, "label": hpd.role_label(r)} for r in hpd.VERIFY_ROLES],
        "actions": [{"key": k, "label": v} for k, v in hpd.ACTION_LABELS.items()],
        "settings": [hle.ser_setting(db, r) for r in rows],
        "templates": [{"id": t.id, "name": t.name, "kind": t.kind, "entityId": t.entity_id or "",
                       "roles": hle.template_roles(t),
                       "documents": (1 if t.body else 0) + len([a for a in (t.attachments or []) if a.get("path")])}
                      for t in tpls],
        "events": [{"key": k, "label": hle.EVENT_TITLES[k], "defaultSubfolder": hle.DEFAULT_SUBFOLDERS[k]}
                   for k in hle.EVENTS],
        # Where people work - the companies' own countries (Oct 14).
        "countries": sorted({(e.country or "").strip().upper()[:2] for e in db.query(HrEntity).all()
                             if (e.country or "").strip()} | {"US", "IN"}),
        "workerTypes": list(hle.WORKER_TYPES),
    }


@router.put("/packets")
def save_packet(body: PacketSettingIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if body.event == "offer":
        raise HTTPException(400, "An offer letter is built from Documents - pick its template under Offer Letter.")
    entity_id = (body.entity_id or "").strip()
    _setting_in_scope(entity_id, hr_scope(user, db), write=True)
    wt = (body.worker_type or "any").strip()
    role_ids = _clean_role_ids(db, entity_id, body.role_ids)
    row = db.query(HrPacketSetting).filter(HrPacketSetting.id == body.id).with_for_update().first() if body.id else None
    if row is not None and hle.is_documents(row):
        raise HTTPException(400, "This packet is built from Documents - edit it there.")
    if row is None and not role_ids:
        # The every-role packet: one per company, event and worker type.
        row = (db.query(HrPacketSetting)
               .filter(HrPacketSetting.entity_id == entity_id, HrPacketSetting.event == body.event,
                       HrPacketSetting.worker_type == wt).all())
        row = next((r for r in row if not (r.role_ids or [])), None)
    now = _now()
    if row is None:
        row = HrPacketSetting(id=str(uuid.uuid4()), entity_id=entity_id, event=body.event,
                              worker_type=wt, created_at=now)
        db.add(row)
    row.role_ids = role_ids
    row.template_id = (body.template_id or "").strip()
    row.subject_role = (body.subject_role or "employee").strip()
    row.email_message = (body.email_message or "").strip()[:4000]
    row.egnyte_subfolder = hle._safe_name(body.egnyte_subfolder, 60) if (body.egnyte_subfolder or "").strip() else ""
    row.updated_by, row.updated_at = user["email"], now
    problems = hle.setting_problems(db, row)
    if problems:
        db.rollback()
        raise HTTPException(400, problems[0])
    _roles_taken(db, row)
    _place_taken(db, row)
    db.commit()
    return hle.ser_setting(db, row)


@router.put("/packets/whole")
def save_whole_packet(body: PacketIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Save a packet in one go: its documents, signers and letter become (or
    update) a Nexus Sign template nobody has to manage by hand, and the row
    says which roles get it, the welcome note and the Egnyte subfolder."""
    from routers.esign import _clean_attachments
    entity_id = (body.entity_id or "").strip()
    _setting_in_scope(entity_id, hr_scope(user, db), write=True)
    if body.event not in hle.EVENTS or body.event == "offer":
        raise HTTPException(400, "Unknown event")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Give the packet a name.")
    signers = [{"key": str(r.get("key") or "").strip(), "label": str(r.get("label") or r.get("key") or "").strip(),
                "order": i + 1} for i, r in enumerate(body.signers or []) if isinstance(r, dict)]
    signers = [r for r in signers if r["key"]]
    if not signers:
        raise HTTPException(400, "Add at least one signer.")
    row = db.query(HrPacketSetting).filter(HrPacketSetting.id == body.id).with_for_update().first() if body.id else None
    if row is not None:
        _setting_in_scope(row.entity_id or "", hr_scope(user, db), write=True)
    now = _now()
    tpl = (db.query(HrSignTemplate).filter(HrSignTemplate.id == row.template_id).first()
           if row is not None and row.template_id else None)
    if tpl is None:
        from egnyte_wiring import effective as _wired
        tpl = HrSignTemplate(id=str(uuid.uuid4()), kind="offer" if body.event == "hire" else "custom",
                             created_by=user["email"], created_at=now, status="active",
                             egnyte_folder=_wired("esign.default-folder")[0])
        db.add(tpl)
    tpl.name, tpl.entity_id, tpl.roles = name, entity_id, signers
    tpl.body = [str(p) for p in (body.body or []) if str(p).strip()]
    tpl.attachments = _clean_attachments([dict(a) for a in (body.attachments or []) if isinstance(a, dict)])
    tpl.updated_at = now
    db.flush()
    # The person signs as the LAST signer for a hire or separation (the
    # company signs at send); a promotion letter's employee signs first.
    subject = ("employee" if any(r["key"] == "employee" for r in signers)
               else (signers[0]["key"] if body.event == "promotion" else signers[-1]["key"]))
    setting = PacketSettingIn(id=row.id if row is not None else "", entity_id=entity_id, event=body.event,
                              worker_type=body.worker_type or "any", template_id=tpl.id, subject_role=subject,
                              email_message=body.email_message or "", egnyte_subfolder=body.egnyte_subfolder or "",
                              role_ids=body.role_ids or [])
    return save_packet(setting, user, db)


@router.delete("/packets/{sid}")
def delete_packet(sid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).first()
    if not row:
        raise HTTPException(404, "Packet setting not found")
    _setting_in_scope(row.entity_id or "", hr_scope(user, db), write=True)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == row.template_id).first() if row.template_id else None
    db.delete(row)
    db.flush()
    # A template nothing else sends is archived with its packet - signed
    # envelopes keep their frozen copy either way.
    if tpl is not None and not db.query(HrPacketSetting).filter(HrPacketSetting.template_id == tpl.id).first():
        tpl.status, tpl.updated_at = "archived", _now()
    db.commit()
    return {"ok": True}


class DocumentsPacketIn(BaseModel):
    """A packet built from Documents (Oct 14): templates + a signing order by
    role + who verifies it."""
    id:               Optional[str] = ""
    entity_id:        Optional[str] = ""
    event:            str
    name:             str
    role_ids:         Optional[list] = None
    worker_type:      Optional[str] = "any"
    doc_template_ids: list
    flow:             list                         # [{key, role, action}]
    verify_role:      Optional[str] = "hr"
    verify_distinct:  Optional[bool] = False
    letterhead_id:    Optional[str] = ""
    pay_mode:         Optional[str] = ""
    email_message:    Optional[str] = ""
    egnyte_subfolder: Optional[str] = ""
    details_form:     Optional[list] = None        # the packet's own Details Form (hiring packets)
    country:          Optional[str] = ""           # where the person works: US, IN ... ('' = any)
    region:           Optional[str] = ""           # the state inside it: CA, TX ... ('' = anywhere in the country)
    extra_docs:       Optional[list] = None        # documents for a team or role: [{match, value, templateIds}]


@router.put("/packets/documents")
def save_documents_packet(body: DocumentsPacketIn, user: dict = Depends(require_hr_write),
                          db: Session = Depends(get_db)):
    """Save a packet that pulls its documents from the Documents module. Its
    problems are checked here, so HR finds out while configuring - not while
    a new hire is waiting."""
    entity_id = (body.entity_id or "").strip()
    _setting_in_scope(entity_id, hr_scope(user, db), write=True)
    if body.event not in hle.EVENTS:
        raise HTTPException(400, "Unknown event")
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(400, "Give the packet a name.")
    if (body.pay_mode or "") not in hpd.PAY_MODES:
        raise HTTPException(400, "Unknown pay setting")
    row = (db.query(HrPacketSetting).filter(HrPacketSetting.id == body.id).with_for_update().first()
           if body.id else None)
    if row is not None:
        _setting_in_scope(row.entity_id or "", hr_scope(user, db), write=True)
        if (row.pay_mode or "") != (body.pay_mode or "") and not _has_comp(user, db):
            raise HTTPException(403, "Changing how a packet treats pay needs Pay & Benefits access.")
    elif (body.pay_mode or "") and not _has_comp(user, db):
        raise HTTPException(403, "Changing how a packet treats pay needs Pay & Benefits access.")
    if body.letterhead_id:
        from models import DocLetterhead
        if not db.query(DocLetterhead).filter(DocLetterhead.id == body.letterhead_id).first():
            raise HTTPException(400, "That letterhead no longer exists.")
    now = _now()
    if row is None:
        row = HrPacketSetting(id=str(uuid.uuid4()), created_at=now, template_id="")
        db.add(row)
    row.entity_id, row.event, row.engine = entity_id, body.event, "documents"
    row.worker_type = (body.worker_type or "any").strip()
    row.country = re.sub(r"[^A-Za-z]", "", body.country or "").upper()[:2]
    row.region = re.sub(r"[^A-Za-z]", "", body.region or "").upper()[:3] if row.country else ""
    # A hiring packet is legal paperwork for a place (Neil, Oct 22) - it says
    # where it applies, so a California hire can never get India's packet.
    if body.event == "hire" and not row.country:
        db.rollback()
        raise HTTPException(400, "Pick where this packet's hires work (Works In) - hiring paperwork is "
                                 "different in each country and state.")
    row.name = name
    row.role_ids = _clean_role_ids(db, entity_id, body.role_ids)
    row.worker_type = row.worker_type or "any"
    _place_taken(db, row)      # the place is the first thing to get right - before its documents
    row.doc_template_ids = list(dict.fromkeys(str(t).strip() for t in (body.doc_template_ids or []) if str(t).strip()))
    row.flow = hpd.clean_flow(body.flow)
    row.subject_role = next((s["key"] for s in row.flow if s["role"] == hpd.SUBJECT_ROLE), "employee")
    row.verify_role = (body.verify_role or "hr").strip()
    row.verify_distinct = 1 if body.verify_distinct else 0
    row.letterhead_id = (body.letterhead_id or "").strip()
    row.pay_mode = (body.pay_mode or "").strip()
    row.email_message = (body.email_message or "").strip()[:4000]
    row.egnyte_subfolder = hle._safe_name(body.egnyte_subfolder, 60) if (body.egnyte_subfolder or "").strip() else ""
    # The Details Form: what the new hire fills in on their link (or HR does).
    # Only a hiring packet asks - a promotion or separation is about someone
    # already in People.
    try:
        row.details_form = hpd.clean_form(body.details_form) if body.event == "hire" else []
        row.extra_docs = hpd.clean_blocks(body.extra_docs)
    except hpd.PacketProblem as e:
        db.rollback()
        raise HTTPException(400, str(e))
    row.updated_by, row.updated_at = user["email"], now
    if row.worker_type not in hle.WORKER_TYPES:
        db.rollback()
        raise HTTPException(400, "Unknown worker type")
    # Checked with the team's and role's documents too - each must have its
    # signers in the signing order.
    ids = list(row.doc_template_ids or []) + [t for t in hpd.all_block_ids(row) if t not in (row.doc_template_ids or [])]
    snaps, snap_problems = hpd.load_snaps(db, ids)
    problems = hpd.config_problems(db, row, snaps, snap_problems)
    if problems:
        db.rollback()
        raise HTTPException(400, problems[0])
    _roles_taken(db, row)
    _place_taken(db, row)
    db.commit()
    return hle.ser_setting(db, row)


@router.get("/packets/role-holders")
def packet_role_holders(entity_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Who each signing role is today for a company - the editor shows it
    beside each step. The same people Company Settings > Checklists > Role Owners
    shows, plus the company's Authorized Signatory."""
    _setting_in_scope(entity_id, hr_scope(user, db), write=False)
    entity = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return hpd.role_holders(db, entity)


# ── Signs Once (Oct 14) ──────────────────────────────────────────────────────
# "HR just needs to sign one time ... if a HR is changed for that company from
# company settings it again asks for sign" (Pranshu). The person who holds the
# step's role for the company signs once - signed in, with a one-time code
# like every Nexus signature - and it goes on every packet after that.

class SignOnceCodeIn(BaseModel):
    step:      str
    entity_id: Optional[str] = ""


class SignOnceIn(BaseModel):
    step:           str
    entity_id:      Optional[str] = ""
    consent:        bool
    signature_kind: str                     # drawn | typed
    signature_data: str
    code:           str


def _once_target(db: Session, sid: str, entity_id: str) -> tuple:
    setting = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).first()
    if not setting or not hle.is_documents(setting):
        raise HTTPException(404, "Packet not found")
    eid = setting.entity_id or (entity_id or "").strip()
    entity = db.query(HrEntity).filter(HrEntity.id == eid).first() if eid else None
    if entity is None:
        raise HTTPException(400, "Pick the company this signature is for.")
    return setting, entity


def _once_otp_subject(setting: HrPacketSetting, step: str, email: str) -> tuple:
    """The one-time code's scope: this packet, this step, this person - a
    code minted here opens nothing else."""
    from types import SimpleNamespace
    req = SimpleNamespace(id=f"sign-once:{setting.id}", title=f"{setting.name or 'HR packet'} - Sign Once",
                          created_by=email)
    party = SimpleNamespace(id=f"sign-once:{setting.id}:{step}:{email}", email=email, phone="", kind="internal")
    return req, party


def _once_holder_or_403(db: Session, setting: HrPacketSetting, step_key: str, entity: HrEntity, email: str) -> None:
    status = {s["key"]: s for s in hpd.company_once_status(db, setting, entity)}
    s = status.get(step_key)
    if s is None:
        raise HTTPException(400, "That step does not Sign Once.")
    if not s["email"] or s["email"] != (email or "").lower():
        raise HTTPException(403, f"Only {s['name'] or 'the person who holds ' + s['roleLabel']} "
                                 f"({s['roleLabel']}) can sign this packet once.")


@router.get("/packets/{sid}/readiness")
def packet_readiness(sid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The packet's Ready To Send checklist, read again after a fix."""
    setting = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).first()
    if not setting or not hle.is_documents(setting):
        raise HTTPException(404, "Packet not found")
    _setting_in_scope(setting.entity_id or "", hr_scope(user, db), write=False)
    return {"readiness": hpd.readiness(db, setting)}


@router.get("/packets/{sid}/sign-once")
def sign_once_status(sid: str, entity_id: str = "", user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    setting, entity = _once_target(db, sid, entity_id)
    me = (user["email"] or "").lower()
    return [{**s, "isMe": s["email"] == me} for s in hpd.company_once_status(db, setting, entity)]


@router.post("/packets/{sid}/sign-once/code")
def sign_once_code(sid: str, body: SignOnceCodeIn, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Email the holder a one-time code for Sign Once."""
    from services import sign_otp
    setting, entity = _once_target(db, sid, body.entity_id or "")
    me = (user["email"] or "").lower()
    _once_holder_or_403(db, setting, body.step, entity, me)
    req, party = _once_otp_subject(setting, body.step, me)
    out = sign_otp.request_code(db, req, party, "email")
    db.commit()
    return out


@router.post("/packets/{sid}/sign-once")
def sign_once(sid: str, body: SignOnceIn, request: Request, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Sign the packet once for the company. From now on that signature goes
    on every packet automatically - until someone else holds the role."""
    from routers import esign
    from services import sign_otp
    setting, entity = _once_target(db, sid, body.entity_id or "")
    setting = db.query(HrPacketSetting).filter(HrPacketSetting.id == setting.id).with_for_update().first()
    me = (user["email"] or "").lower()
    _once_holder_or_403(db, setting, body.step, entity, me)
    esign._validate_signature(esign.SignIn(consent=bool(body.consent), signature_kind=body.signature_kind,
                                           signature_data=body.signature_data or ""))
    req, party = _once_otp_subject(setting, body.step, me)
    otp_row = sign_otp.verify_code(db, req, party, body.code or "")
    ip, ua = _client_meta(request)
    try:
        hpd.adopt_signature(db, setting, step_key=body.step, entity=entity, email=me,
                            kind=body.signature_kind, data=body.signature_data, otp_challenge_id=otp_row.id,
                            consent_version=esign._CONSENT_VERSION, ip=ip, user_agent=ua)
    except hpd.PacketProblem as e:
        db.rollback()
        raise HTTPException(400, str(e))
    db.commit()
    return [{**s, "isMe": s["email"] == me} for s in hpd.company_once_status(db, setting, entity)]


class PreviewDocIn(BaseModel):
    template_id:   str
    entity_id:     Optional[str] = ""
    setting_id:    Optional[str] = ""          # whose letterhead / signing order to use
    flow:          Optional[list] = None       # the editor's unsaved order
    letterhead_id: Optional[str] = ""


_SAMPLE = {"first_name": "Jane", "last_name": "Doe", "full_name": "Jane Doe", "preferred_name": "Jane",
           "email": "jane.doe@example.com", "phone": "(555) 010-0100",
           "address": "12 Pine Street, Springfield, CA 90000", "permanent_address": "12 Pine Street, Springfield, CA 90000",
           "job_title": "Sample Job Title", "department": "Sample Department", "start_date": "2026-11-02",
           "offer_expires": "2026-10-28", "employment_type": "Full-Time", "manager": "Sample Manager",
           "supervisor": "Sample Manager", "work_hours": "9:00 AM - 5:00 PM", "work_days": "Monday - Friday",
           "work_schedule": "9:00 AM - 5:00 PM, Monday - Friday", "employee_code": "GG-0000",
           "effective_date": "2026-11-02", "old_title": "Previous Title", "new_title": "New Title",
           "old_role": "Previous Role", "new_role": "New Role", "change_type": "promotion",
           "responsibilities": "The responsibilities of the new role.", "last_day": "2026-11-02",
           "separation_type": "Resignation", "emergency_name": "John Doe", "emergency_relationship": "Brother",
           "emergency_phone": "(555) 010-0101"}


@router.post("/packets/render-preview")
def packet_render_preview(body: PreviewDocIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """One template as a packet would print it, filled with a sample person
    (Preview With Sample Person). Pay prints as [Pay] for anyone without Pay &
    Benefits. Nothing is saved."""
    from models import DocTemplate
    from routers.documents import TemplateNotPublished, published_snapshot
    entity_id = (body.entity_id or "").strip()
    _setting_in_scope(entity_id, hr_scope(user, db), write=False)
    tpl = db.query(DocTemplate).filter(DocTemplate.id == body.template_id).first()
    if not tpl:
        raise HTTPException(404, "Template not found")
    try:
        content, meta, version = published_snapshot(db, tpl)
    except TemplateNotPublished as e:
        raise HTTPException(409, str(e))
    snap = hpd.Snap(tpl, content, meta, version)
    setting = (db.query(HrPacketSetting).filter(HrPacketSetting.id == body.setting_id).first()
               if body.setting_id else None)
    if setting is None:
        setting = HrPacketSetting(entity_id=entity_id, event="hire", letterhead_id=body.letterhead_id or "",
                                  flow=hpd.clean_flow(body.flow or []), pay_mode="")
    entity = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    import hr_checklists as hc
    ctx = {"entity": entity, "owners": hc.role_owners(db, entity_id), "sender": user["email"],
           "subject_email": "jane.doe@example.com", "subject_name": "Jane Doe", "subject_kind": "external",
           "manager_email": ""}
    parties, remap, _problems = hpd.build_parties(db, setting, ctx)
    values = {**_SAMPLE, **hpd.signer_values(parties, remap)}
    merge = hpd.full_merge(db, snap, entity_id=entity_id, overrides=values)
    for t in snap.tokens:
        if hpd.is_pay_token(t, snap.defs) and t not in merge:
            merge[t] = "$85,000.00 per year" if _has_comp(user, db) else "[Pay]"
        elif t not in merge and t != "today" and not t.startswith("template."):
            merge[t] = f"[{t.replace('_', ' ').replace('.', ' ').title()}]"
    pdf = hpd.render(db, snap, title=f"{tpl.name} - Sample", merge=merge, entity_id=entity_id,
                     letterhead_id=hpd.document_letterhead(db, setting, snap))
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{hle._safe_name(tpl.name)} - Sample.pdf"'})


@router.get("/packets/email-preview")
def packet_email_preview(event: str, entity_id: str = "", template_id: str = "", note: str = "",
                         role: str = "subject", stage: str = "invite",
                         user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The email a packet sends, rendered with a sample person - so HR sees
    exactly what a new hire / promoted employee / leaver receives."""
    import hr_life_email
    if event not in hle.EVENTS:
        raise HTTPException(400, "Unknown event")
    _setting_in_scope(entity_id, hr_scope(user, db), write=False)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == template_id).first() if template_id else None
    docs = [a.get("name", "document.pdf") for a in ((tpl.attachments or []) if tpl else []) if a.get("path")]
    subject, html = hr_life_email.preview(db, user, event, entity_id, tpl.name if tpl else hle.EVENT_TITLES[event],
                                          note, docs, role="manager" if role == "manager" else "subject",
                                          stage="completed" if stage == "completed" else "invite")
    return {"subject": subject, "html": html}


# ── hiring packet ────────────────────────────────────────────────────────────

class HirePacketIn(BaseModel):
    inputs:       Optional[dict] = None   # job_title, department, start_date, manager_email, employment_type, salary_text, merge{}
    pay:          Optional[dict] = None   # {base, payBasis, frequency, currency} - hr_comp holders only
    excluded_ack: Optional[bool] = False


def _pay_allowed(body: HirePacketIn, user: dict, db: Session) -> Optional[dict]:
    if body.pay and body.pay.get("base") not in (None, ""):
        if not _has_comp(user, db):
            raise HTTPException(403, "Entering pay needs the Pay & Benefits (hr_comp) access - "
                                     "type the pay as text in the offer instead.")
        return body.pay
    return None


@router.get("/candidates/{cid}/hiring-packet/options")
def hiring_packet_options(cid: str, employment_type: str = "full_time", role_id: str = "",
                          user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Which packet Nexus will send this candidate - matched on the company
    and the job role - and the others HR may pick instead. Shown on the
    candidate card before Send and as the Packet dropdown in the send form."""
    try:
        cand = hle._load_candidate(db, cid, hr_scope(user, db))
    except hle.PacketError as e:
        raise HTTPException(e.status, str(e))
    rid = (role_id or "").strip() or (cand.role_id or "")
    picked = hle.resolve_setting(db, cand.company or "", "hire", hle.worker_type_of(employment_type), rid)
    from models import NexusGroup
    role = db.query(NexusGroup).filter(NexusGroup.id == rid).first() if rid else None
    names = {e.id: e.name for e in db.query(HrEntity).all()}

    def why(s):
        if rid and rid in (s.role_ids or []):
            return f"for {role.name if role else 'this role'}"
        return "for every role" + ("" if s.entity_id else " of every company")

    def ser(s):
        out = hle.ser_setting(db, s)
        out["companyName"] = names.get(s.entity_id, "") if s.entity_id else ""
        out["why"] = why(s)
        return out
    return {"pickedId": picked.id if picked else "",
            "picked": ser(picked) if picked else None,
            "options": [ser(s) for s in hle.packet_choices(db, cand.company or "", "hire")]}


@router.post("/candidates/{cid}/hiring-packet/preview")
def preview_hiring_packet(cid: str, body: HirePacketIn, user: dict = Depends(require_hr_write),
                          db: Session = Depends(get_db)):
    try:
        plan = hle.plan_hire(db, user, cid, body.inputs or {}, _pay_allowed(body, user, db),
                             hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.preview_out(plan)


@router.post("/candidates/{cid}/hiring-packet")
def send_hiring_packet(cid: str, body: HirePacketIn, request: Request,
                       user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.excluded_ack:
        raise HTTPException(422, "Confirm the packet is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev = hle.send_hire(db, user, cid, body.inputs or {}, _pay_allowed(body, user, db),
                           hr_scope(user, db), excluded_ack=True, ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    return out


# ── packets built from Documents: start, review, verify and send (Oct 14) ───

class StartPacketIn(BaseModel):
    intake:     Optional[str] = "hr"    # who fills in the details: "hr" (now) or "candidate" (a link)
    inputs:     Optional[dict] = None   # the offer + the Four Options (timings, job description) + merge{}
    pay:        Optional[dict] = None   # structured pay - Pay & Benefits only
    pay_values: Optional[dict] = None   # typed pay per pay variable - Pay & Benefits only
    details:    Optional[dict] = None   # the person's details (legal name, address, phone, emergency contact)


def _pay_values_allowed(values: Optional[dict], user: dict, db: Session) -> Optional[dict]:
    if values and any(str(v or "").strip() for v in values.values()):
        if not _has_comp(user, db):
            raise HTTPException(403, "Entering pay needs Pay & Benefits access.")
        return values
    return None


def _mail_intake(db: Session, ev: HrLifeEvent, token: str, background: BackgroundTasks) -> str:
    """Email the candidate their details link (after the response, like the
    role-change emails). Returns the link, for HR to copy."""
    import hr_life_email
    link = hle.intake_link(token)
    subject, html = hr_life_email.intake_email(db, ev, link)
    background.add_task(rc.send_emails, [(ev.subject_email, subject, html)])
    return link


@router.post("/candidates/{cid}/hiring-packet/start")
def start_hiring_packet(cid: str, body: StartPacketIn, background: BackgroundTasks,
                        user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Start Hiring Packet: the Four Options and the details -> the documents
    are generated at once -> the verifier checks them. With intake
    "candidate", the candidate gets a link for their details instead, and the
    documents are generated when they send them. Nothing is sent to sign."""
    if (body.intake or "hr") not in ("hr", "candidate"):
        raise HTTPException(400, "Who fills in the details must be hr or candidate")
    pay = _pay_allowed(HirePacketIn(pay=body.pay), user, db)
    try:
        ev, token = hle.start_hire(db, user, cid, body.inputs or {}, pay,
                                   _pay_values_allowed(body.pay_values, user, db),
                                   body.details or {}, hr_scope(user, db), intake_mode=body.intake or "hr")
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    if token:
        out["intakeUrl"] = _mail_intake(db, ev, token, background)
    return out


# ── the offer letter (Neil, Oct 14) ─────────────────────────────────────────

@router.get("/candidates/{cid}/offer/options")
def offer_options(cid: str, worker_type: str = "", country: str = "", role_id: str = "", packet_id: str = "",
                  new_role: str = "", department: str = "", region: str = "",
                  user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The Move To Offer form: which offer letter this hire gets (by employee
    or contractor, and where they work - country and state), the hiring packet
    that follows it, and every question either asks of HR."""
    try:
        cand = hle._load_candidate(db, cid, hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.offer_options(db, cand, worker_type, country, role_id, packet_id,
                             new_role=new_role in ("1", "true"), department=department, region=region)


class OfferIn(BaseModel):
    inputs:     Optional[dict] = None   # worker_type, country, role, start, expiry, supervisor, timings, JD, merge{}
    pay:        Optional[dict] = None   # structured pay - Pay & Benefits only
    pay_values: Optional[dict] = None   # typed pay per pay variable - Pay & Benefits only
    details:    Optional[dict] = None   # their legal name / address, when the letter prints them


@router.post("/candidates/{cid}/offer/start")
def start_offer(cid: str, body: OfferIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Move To Offer: the offer letter is generated from HR's answers and the
    verifier checks it. Nothing goes to the candidate until Verify And Send."""
    pay = _pay_allowed(HirePacketIn(pay=body.pay), user, db)
    try:
        ev = hle.start_offer(db, user, cid, body.inputs or {}, pay, _pay_values_allowed(body.pay_values, user, db),
                             body.details or {}, hr_scope(user, db))
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


@router.post("/candidates/{cid}/hiring-packet/after-offer")
def start_packet_after_offer(cid: str, background: BackgroundTasks, user: dict = Depends(require_hr_write),
                             db: Session = Depends(get_db)):
    """Start the hiring packet for a candidate whose offer is signed - for
    when it could not start by itself (no packet was set up yet)."""
    try:
        cand = hle._load_candidate(db, cid, hr_scope(user, db), lock=True)
    except hle.PacketError as e:
        _raise(e)
    offer = hle.signed_offer(db, cand.id)
    if offer is None:
        raise HTTPException(409, "They have no signed offer letter - the hiring packet follows the offer.")
    try:
        ev, token = hle.start_packet_after_offer(db, offer, user["email"])
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    offer.flags = [f for f in (offer.flags or []) if f.get("code") != "packet_not_started"]
    db.commit()
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    if token:
        out["intakeUrl"] = _mail_intake(db, ev, token, background)
    return out


@router.post("/life-events/{eid}/reopen-intake")
def reopen_packet_intake(eid: str, background: BackgroundTasks, user: dict = Depends(require_hr_write),
                         db: Session = Depends(get_db)):
    """Ask the candidate for their details again: a fresh link, the old one dead."""
    ev = _locked_event(db, eid, user)
    try:
        token = hle.reopen_intake(db, ev, user["email"])
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["intakeUrl"] = _mail_intake(db, ev, token, background)
    return out


# ── the candidate's details page (public: the link's token is the credential) ─

class IntakeIn(BaseModel):
    values: dict


@router.get("/intake/public/{token}")
def intake_page(token: str, request: Request, db: Session = Depends(get_db)):
    from routers.esign import _note_token_miss
    ev = hle.intake_by_token(db, token)
    if ev is None:
        _note_token_miss(request)
        raise HTTPException(404, "This link is not valid - please contact HR.")
    return hle.intake_public(db, ev)


@router.post("/intake/public/{token}")
def intake_submit(token: str, body: IntakeIn, request: Request, db: Session = Depends(get_db)):
    from routers.esign import _note_token_miss
    ev = hle.intake_by_token(db, token, lock=True)
    if ev is None:
        _note_token_miss(request)
        raise HTTPException(404, "This link is not valid - please contact HR.")
    try:
        hle.submit_intake(db, ev, body.values or {})
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    return {"ok": True}


def _locked_event(db: Session, eid: str, user: dict) -> HrLifeEvent:
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    return ev


@router.get("/life-events/{eid}/review")
def review_packet(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The review screen - a pure read (api.js may retry it)."""
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    return hpd.review_out(db, ev, user, can_see_pay=_has_comp(user, db))


@router.get("/life-events/{eid}/documents/{did}/pdf")
def packet_document_pdf(eid: str, did: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """One generated document as it will be signed. A document that shows pay
    opens for Pay & Benefits holders only."""
    from models import Document
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    row = db.query(Document).filter(Document.id == did, Document.life_event_id == ev.id).first()
    if not row:
        raise HTTPException(404, "Document not found")
    setting = hpd.event_setting(db, ev)
    comp = _has_comp(user, db)
    prints = setting is None or hpd.doc_prints_pay(setting, hpd.row_snap(db, row))
    if prints and not comp:
        raise HTTPException(403, "This document shows pay - Pay & Benefits access is needed.")
    pdf, _missing = hpd.render_row(db, row, hpd.event_pay(db, ev, setting) if comp else {})
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{hle._safe_name(row.title)}.pdf"'})


class PacketValuesIn(BaseModel):
    inputs:     Optional[dict] = None
    details:    Optional[dict] = None
    extra:      Optional[dict] = None
    pay:        Optional[dict] = None
    pay_values: Optional[dict] = None


@router.patch("/life-events/{eid}/values")
def patch_packet_values(eid: str, body: PacketValuesIn, user: dict = Depends(require_hr_write),
                        db: Session = Depends(get_db)):
    ev = _locked_event(db, eid, user)
    try:
        hle.patch_values(db, ev, user, body.model_dump(exclude_unset=True), can_see_pay=_has_comp(user, db))
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    return hpd.review_out(db, ev, user, can_see_pay=_has_comp(user, db))


@router.post("/life-events/{eid}/regenerate")
def regenerate_packet(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Bring the documents up to date (a template was published, a value or a
    signer changed). Idempotent: a second call changes nothing."""
    ev = _locked_event(db, eid, user)
    if ev.status != "review":
        raise HTTPException(409, f"This packet is {ev.status.replace('_', ' ')}.")
    setting = hpd.event_setting(db, ev)
    if setting is None:
        raise HTTPException(409, "This packet's settings were deleted - void it and start again.")
    p = hpd.event_plan(db, ev, setting, sender=ev.created_by or user["email"], can_see_pay=True)
    if hpd.sync_documents(db, ev, setting, p, user["email"].lower()):
        ev.updated_at = _now()
    db.commit()
    return hpd.review_out(db, ev, user, can_see_pay=_has_comp(user, db))


class VerifyIn(BaseModel):
    excluded_ack: Optional[bool] = False
    seen:         Optional[dict] = None    # {documentId: version} the reviewer saw


@router.post("/life-events/{eid}/verify-and-send")
def verify_and_send_packet(eid: str, body: VerifyIn, request: Request, user: dict = Depends(require_hr_write),
                           db: Session = Depends(get_db)):
    """Only the verifier sends - the person the packet's Verified By role
    resolves to today (403 for anyone else)."""
    ev = _locked_event(db, eid, user)
    ip, ua = _client_meta(request)
    try:
        hpd.verify_and_send(db, ev, user, seen=body.seen or {}, excluded_ack=bool(body.excluded_ack),
                            can_see_pay=_has_comp(user, db), ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    db.refresh(ev)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    return out


# ── Documents > HR Records (Oct 14) ──────────────────────────────────────────
# "Any document that's in this company going forward is going to be in the
# document module" (Neil). Every document an HR packet generated, listed in
# Documents for HR in scope - read-only (edits happen to the template), pay
# documents locked for anyone without Pay & Benefits. Never returns a value.

_RECORD_STATUS = {"intake": "Waiting On Details", "review": "In Review", "awaiting_sender": "Out For Signature",
                  "sent": "Out For Signature", "completed": "Signed", "declined": "Declined",
                  "voided": "Voided", "expired": "Expired"}


@router.get("/packet-documents")
def packet_documents(q: str = "", status: str = "", limit: int = 200, user: dict = Depends(require_hr_read),
                     db: Session = Depends(get_db)):
    from models import DocTemplate, Document
    scope = hr_scope(user, db)
    comp = _has_comp(user, db)
    query = db.query(Document).filter(Document.source == "hr-packet", Document.life_event_id != "")
    if q.strip():
        query = query.filter(Document.title.ilike(f"%{q.strip()[:80]}%"))
    rows = query.order_by(Document.updated_at.desc()).limit(max(1, min(limit, 500))).all()
    events = {e.id: e for e in db.query(HrLifeEvent).filter(
        HrLifeEvent.id.in_({r.life_event_id for r in rows})).all()} if rows else {}
    settings, out = {}, []
    for r in rows:
        ev = events.get(r.life_event_id)
        if ev is None or (scope is not None and (ev.entity_id or "") not in scope):
            continue
        label = "Archived" if r.status == "archived" else _RECORD_STATUS.get(ev.status, ev.status)
        if status and label != status:
            continue
        if ev.setting_id not in settings:
            settings[ev.setting_id] = hpd.event_setting(db, ev)
        s = settings[ev.setting_id]
        prints = s is None or hpd.doc_prints_pay(s, hpd.row_snap(db, r))
        tpl = db.query(DocTemplate.name).filter(DocTemplate.id == r.template_id).first()
        out.append({"documentId": r.id, "title": r.title, "person": ev.subject_name, "kind": ev.kind,
                    "packet": hle.EVENT_TITLES.get(ev.kind, ""), "templateId": r.template_id,
                    "templateName": tpl[0] if tpl else "", "templateVersion": r.template_version,
                    "status": label, "printsPay": prints, "locked": prints and not comp,
                    "eventId": ev.id, "signRequestId": ev.sign_request_id or "",
                    "signed": ev.status == "completed", "updatedAt": r.updated_at or ""})
    return out


# ── promotion / role change ──────────────────────────────────────────────────

@router.post("/employees/{eid}/promotion/preview")
def preview_promotion(eid: str, body: HirePacketIn, user: dict = Depends(require_hr_write),
                      db: Session = Depends(get_db)):
    try:
        plan = hle.plan_promotion(db, user, eid, body.inputs or {}, _pay_allowed(body, user, db),
                                  hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.promotion_preview_out(plan)


@router.post("/employees/{eid}/promotion")
def send_promotion(eid: str, body: HirePacketIn, request: Request,
                   user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.excluded_ack:
        raise HTTPException(422, "Confirm the letter is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev = hle.send_promotion(db, user, eid, body.inputs or {}, _pay_allowed(body, user, db),
                                hr_scope(user, db), excluded_ack=True, ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    return out


class StartLetterIn(BaseModel):
    inputs:     Optional[dict] = None
    pay:        Optional[dict] = None
    pay_values: Optional[dict] = None


@router.post("/employees/{eid}/promotion/start")
def start_promotion_letter(eid: str, body: StartLetterIn, user: dict = Depends(require_hr_write),
                           db: Session = Depends(get_db)):
    """Promote / change role with a letter built from Documents (Oct 14): the
    letter is generated at once and the verifier checks it before it goes."""
    pay = _pay_allowed(HirePacketIn(pay=body.pay), user, db)
    try:
        ev = hle.start_promotion(db, user, eid, body.inputs or {}, pay,
                                 _pay_values_allowed(body.pay_values, user, db), hr_scope(user, db))
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


class RoleChangeIn(BaseModel):
    role_id:     str
    reason:      Optional[str] = ""
    employee_id: Optional[str] = ""
    email:       Optional[str] = ""     # Settings > Access knows the person by email


class RoleDecisionIn(BaseModel):
    note: Optional[str] = ""


def _rc_raise(db: Session, e: rc.RoleChangeError):
    db.rollback()
    raise HTTPException(e.status, str(e))


def _hr_editor(user: dict, db: Session) -> bool:
    try:
        require_hr_write(user=user, db=db)
        return True
    except HTTPException:
        return False


def _hr_reader(user: dict, db: Session, company: str = None) -> bool:
    """HR who may read People - and, given a company, read THAT company's
    people (a company-scoped HR admin sees only their own)."""
    try:
        require_hr_read(user=user, db=db)
    except HTTPException:
        return False
    if company is None:
        return True
    scope = hr_scope(user, db)
    return scope is None or (company or "") in scope


def _rc_employee(db: Session, user: dict, employee_id: str = "", email: str = "") -> NexusEmployee:
    q = db.query(NexusEmployee)
    emp = (q.filter(NexusEmployee.id == employee_id).first() if employee_id
           else q.filter(NexusEmployee.work_email == (email or "").strip().lower()).first() if email else None)
    scope = hr_scope(user, db)
    if not emp or (scope is not None and (emp.company or "") not in scope):
        raise HTTPException(404, "Employee not found")
    return emp


@router.post("/employees/{eid}/role")
def change_role_now(eid: str, body: RoleChangeIn, user: dict = Depends(require_hr_write),
                    db: Session = Depends(get_db)):
    """People > Change Role > Role Change Without Promotion (Pranshu, Oct 14):
    HR changes the role directly - no approval. The reason is optional and
    kept in the audit row. A promotion goes through /promotion."""
    emp = _rc_employee(db, user, eid)
    try:
        jr, warning = rc.change_now(db, user, emp, body.role_id, body.reason or "")
    except rc.RoleChangeError as e:
        _rc_raise(db, e)
    db.commit()
    return {"employeeId": emp.id, "roleId": jr.id, "roleName": jr.name, "warning": warning}


@router.post("/role-change-requests")
def request_role_change(body: RoleChangeIn, background: BackgroundTasks,
                        user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Settings > Access > Change Role (Pranshu, Oct 13): asks the employee's
    manager and HR - the role changes only when one of them approves
    (role_change.py). From People, HR changes it directly (/employees/{eid}/role)."""
    emp = _rc_employee(db, user, body.employee_id or "", body.email or "")
    try:
        req, warning, emails = rc.request_change(db, user, emp, body.role_id, body.reason or "")
    except rc.RoleChangeError as e:
        _rc_raise(db, e)
    db.commit()
    background.add_task(rc.send_emails, emails)
    return {**rc.ser(db, req, user["email"], True), "warning": warning}


@router.get("/role-change-requests")
def list_role_change_requests(employee_id: str = "", email: str = "", user: dict = Depends(get_current_user),
                              db: Session = Depends(get_db)):
    """PENDING requests - on one person (their Access tab), or with no person
    named every one the caller can see (the People list marks those people).
    Shown to HR and to whoever can decide or cancel them."""
    from models import HrRoleChangeRequest
    q = db.query(HrRoleChangeRequest).filter(HrRoleChangeRequest.status == rc.PENDING)
    if employee_id:
        q = q.filter(HrRoleChangeRequest.employee_id == employee_id)
    elif email:
        q = q.filter(HrRoleChangeRequest.employee_email == email.strip().lower())
    editor = _hr_editor(user, db)
    # A team-limited manager (Oct 6 rule) is not an HR-wide reader here: they
    # get the requests they may decide or asked for, which is their own team.
    team_only = hr_team_limited(user)
    return [rc.ser(db, r, user["email"], editor) for r in q.order_by(HrRoleChangeRequest.created_at.desc()).all()
            if rc.can_see(db, r, user["email"], (not team_only) and _hr_reader(user, db, r.company))]


@router.get("/role-history")
def role_history(employee_id: str = "", email: str = "", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """The person's role change log for their Access tab (Pranshu, Oct 14) -
    HR (their company) and the person's own manager."""
    q = db.query(NexusEmployee)
    emp = (q.filter(NexusEmployee.id == employee_id).first() if employee_id
           else q.filter(NexusEmployee.work_email == email.strip().lower()).first() if email else None)
    me = user["email"].lower()
    if not emp or not (_hr_reader(user, db, emp.company or "") or (emp.manager_email or "").lower() == me):
        raise HTTPException(404, "Employee not found")
    return rc.role_history(db, emp)


@router.get("/role-change-requests/{rid}")
def get_role_change_request(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from models import HrRoleChangeRequest
    req = db.query(HrRoleChangeRequest).filter(HrRoleChangeRequest.id == rid).first()
    if not req or not rc.can_see(db, req, user["email"], _hr_reader(user, db, req.company)):
        raise HTTPException(404, "Role change request not found")
    return rc.ser(db, req, user["email"], _hr_editor(user, db))


def _decide(rid: str, approve: bool, note: str, background: BackgroundTasks, user: dict, db: Session):
    try:
        req, emails = rc.decide(db, user, rid, approve, note)
    except rc.RoleChangeError as e:
        _rc_raise(db, e)
    db.commit()
    background.add_task(rc.send_emails, emails)
    return rc.ser(db, req, user["email"], _hr_editor(user, db))


@router.post("/role-change-requests/{rid}/approve")
def approve_role_change(rid: str, background: BackgroundTasks, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    """The employee's manager or HR contact - the role changes now."""
    return _decide(rid, True, "", background, user, db)


@router.post("/role-change-requests/{rid}/decline")
def decline_role_change(rid: str, body: RoleDecisionIn, background: BackgroundTasks,
                        user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _decide(rid, False, body.note or "", background, user, db)


@router.post("/role-change-requests/{rid}/cancel")
def cancel_role_change(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        req = rc.cancel(db, user, rid, _hr_editor(user, db))
    except rc.RoleChangeError as e:
        _rc_raise(db, e)
    db.commit()
    return rc.ser(db, req, user["email"], True)


# ── offboarding ──────────────────────────────────────────────────────────────

class SeparationIn(BaseModel):
    inputs:       Optional[dict] = None   # last_day, exit_type, reason, send_package, start_checklist, offboarding{}, merge{}
    excluded_ack: Optional[bool] = False


@router.post("/employees/{eid}/offboard/preview")
def preview_offboard(eid: str, body: SeparationIn, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    try:
        plan = hle.plan_separation(db, user, eid, body.inputs or {}, hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.separation_preview_out(plan)


@router.post("/employees/{eid}/offboard")
def offboard(eid: str, body: SeparationIn, request: Request,
             user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if (body.inputs or {}).get("send_package", True) and not body.excluded_ack:
        raise HTTPException(422, "Confirm the package is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev, result = hle.send_separation(db, user, eid, body.inputs or {}, hr_scope(user, db),
                                         excluded_ack=bool(body.excluded_ack), ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=False)
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    out["result"] = {k: v for k, v in (result or {}).items() if k in ("m365", "items", "handover")}
    return out


@router.post("/life-events/{eid}/cancel-offboarding")
def cancel_offboarding(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    try:
        hle.cancel_separation(db, ev, user["email"])
    except hle.PacketError as e:
        _raise(e)
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=False)


# ── events ───────────────────────────────────────────────────────────────────

def _event_in_scope(db: Session, ev: HrLifeEvent, scope) -> None:
    if scope is not None and (ev.entity_id or "") not in scope:
        raise HTTPException(404, "Not found")


@router.get("/life-events")
def list_events(candidate_id: Optional[str] = "", employee_id: Optional[str] = "",
                user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    if not (candidate_id or employee_id):
        raise HTTPException(400, "Pass candidate_id or employee_id")
    scope = hr_scope(user, db)
    q = db.query(HrLifeEvent)
    if candidate_id:
        cand = db.query(HrCandidate).filter(HrCandidate.id == candidate_id).first()
        if not cand or (scope is not None and (cand.company or "") not in scope):
            raise HTTPException(404, "Candidate not found")
        q = q.filter(HrLifeEvent.candidate_id == candidate_id)
    else:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == employee_id).first()
        if not emp or (scope is not None and (emp.company or "") not in scope):
            raise HTTPException(404, "Employee not found")
        q = q.filter(HrLifeEvent.employee_id == employee_id)
    show_pay = _has_comp(user, db)
    rows = q.order_by(HrLifeEvent.created_at.desc()).all()
    return [hle.ser_event(db, ev, show_pay=show_pay)
            | {"senderPartyId": hle.sender_party_id(db, ev, user["email"])} for ev in rows]


@router.post("/life-events/{eid}/retry-filing")
def retry_filing(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    if ev.status != "completed":
        raise HTTPException(409, "Only a fully signed packet can be filed.")
    if ev.filing_status == "filed":
        raise HTTPException(409, "Already filed in Egnyte.")
    ev.filing_attempts = 0
    hle.run_filing(db, ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


class FileByHandIn(BaseModel):
    folder: str = ""


@router.post("/life-events/{eid}/file-manually")
def file_manually(eid: str, body: FileByHandIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """File Manually (Oct 15 2026): automatic filing failed, so HR names the
    Egnyte folder; every signed, unfiled packet of the same person goes there
    and their cards leave the profile."""
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    if ev.status != "completed":
        raise HTTPException(409, "Only a fully signed packet can be filed.")
    try:
        events = hle.file_by_hand(db, ev, body.folder, user["email"])
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    show = _has_comp(user, db)
    return {"events": [hle.ser_event(db, e, show_pay=show) for e in events]}


@router.post("/life-events/{eid}/retry-apply")
def retry_apply(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The packet is fully signed but Nexus could not apply it (safe() flagged
    `apply_failed`): run the completion again, and show the error if it
    still fails."""
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    try:
        hle.retry_apply(db, ev)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"Still failing: {type(e).__name__}: {str(e)[:300]}")
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


@router.post("/life-events/{eid}/void")
def void_event(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    if ev.status in ("intake", "review"):
        # Never sent (Oct 14): nothing in Nexus Sign to void.
        try:
            hle.void_open(db, ev, user["email"])
        except hle.PacketError as e:
            _raise(e)
        return hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    if ev.status not in hle.ACTIVE:
        raise HTTPException(409, f"This packet is already {ev.status}.")
    from routers.esign import void_request
    void_request(ev.sign_request_id, user=user, db=db)   # moves the event via the hook
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))
