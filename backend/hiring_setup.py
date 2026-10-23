"""Hiring Setup (Pranshu, Oct 23 2026): what each hire gets, company by company.

Reuse by default, customize where needed. Every cell of the setup grid asks
the SAME resolve_setting a real offer uses, so the screen can never say
something the send would not do:

- Offer Letter and Hiring Packet: All Companies -> one company -> country ->
  state -> employee / contractor (today's order, unchanged). "Use The Same"
  archives this level's own row (archived_at) so the level above applies;
  "Make A Different One" creates a row at exactly this level.
- Job Description: it belongs to the role. One Standard text
  (NexusGroup.job_description) plus optional versions (duty_versions) by
  Hired As, Works In and Company; the most specific fit wins
  (resolve_duties). Full-time vs part-time changes only the duties.
- A hiring packet prints the duties inside a document ({{role_description}})
  or on their own page where the "@jd" marker sits in doc_template_ids
  (hr_packet_docs.template_ids_for).

Round 2 (Oct 23 2026): the same grid, Use The Same and Make A Different
One for every event - one screen per company with three sections (SECTIONS):
Hiring (offer letter, hiring packet, job description), Promotion (promotion
letter, the new role's job description - the SAME duties) and Offboarding
(separation package). A missing promotion letter or separation package never
blocks: Change Role Now and offboarding without documents still run.

Nothing here deletes a row: archived letters and duty versions stay.
routers/hiring_setup.py is the API; this file is the engine.
"""
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

import hr_checklists as hc
import hr_life_events as hle
import hr_packet_docs as hpd
from models import (DocTemplate, DocTemplateVersion, HrDepartment, HrEntity, HrLifeEvent, HrPacketSetting,
                    NexusGroup, NexusSetting)

HIRED_AS = ("", "employee", "full_time", "part_time", "contractor")
HIRED_WORDS = {"": "Everyone", "employee": "Employees", "full_time": "Full-Time Employees",
               "part_time": "Part-Time Employees", "contractor": "Contractors"}
_SHORT = {"employee": "Employees", "full_time": "Full-Time", "part_time": "Part-Time", "contractor": "Contractors"}
_RANK = {"": 0, "employee": 1, "contractor": 1, "full_time": 2, "part_time": 2}
EVENT_NAMES = {"offer": "Offer Letter", "hire": "Hiring Packet",
               "promotion": "Promotion Letter", "separation": "Separation Package"}
# section -> [(column key, event)]; "jd" (event '') is the role's duties.
SECTIONS = {"hiring":      [("offer", "offer"), ("packet", "hire"), ("jd", "")],
            "promotion":   [("letter", "promotion"), ("jd", "")],
            "offboarding": [("package", "separation")]}
SECTION_LABELS = {"hiring": "Hiring", "promotion": "Promotion", "offboarding": "Offboarding"}
MAIN = {"hiring": "packet", "promotion": "letter", "offboarding": "package"}   # its placement, its Advanced
READY = {"hiring": "Ready To Hire", "promotion": "Ready To Promote", "offboarding": "Ready To Offboard"}
JD_LABELS = {"hiring": "Job Description", "promotion": "New Role's Job Description"}
SUBJECT_WORD = {"offer": "The New Hire", "hire": "The New Hire", "promotion": "The Employee",
                "separation": "The Employee"}
_IN_USE = {"offer": ("hire", "hires"), "hire": ("hire", "hires"), "promotion": ("promotion", "promotions"),
           "separation": ("offboarding", "offboardings")}
PLACES_KEY = "hr_setup_places:"            # + entity id ('' = the shared screen) -> [{country, region}]
COPIED_KEY = "hr_setup_duties_copied"
SHARED_WRITE = "Only HR with access to every company can change the default packet."
SHARED_ROLE_DOCS = ("Only HR with access to every company can change a shared role's documents - "
                    "ask HR with access to every company.")
SHARED_DUTIES = ("Only HR with access to every company can change a shared role's standard duties - "
                 "make a version for this company instead.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _code(v, n: int) -> str:
    return re.sub(r"[^A-Za-z]", "", str(v or "")).upper()[:n]


def _plural(n: int, one: str, many: str = "") -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


# ── startup ──────────────────────────────────────────────────────────────────

def ensure_builtin_jd(db: Session) -> None:
    """The built-in Job Description page the "@jd" marker prints when a role
    has duties and no formatted JD of its own. Created once, never overwritten."""
    if db.query(DocTemplate.id).filter(DocTemplate.id == hpd.BUILTIN_JD_ID).first():
        return

    def par(*parts):
        return {"type": "paragraph", "content": [
            {"type": "mergeField", "attrs": {"token": p[2:-2]}} if p.startswith("{{") else {"type": "text", "text": p}
            for p in parts]}
    content = {"pages": [{"id": "p1", "json": {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Job Description"}]},
        par("Job Title: ", "{{job_title}}"), par("Department: ", "{{department}}"), par("{{role_description}}")]}}],
        "header": None, "footer": None}
    now = _now()
    db.add(DocTemplate(id=hpd.BUILTIN_JD_ID, name="Job Description", category="job_description", status="active",
                       content=content, version=1, created_by="system", created_at=now, updated_at=now,
                       published_version=1, published_by="system", published_at=now,
                       published_meta={"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "",
                                       "requiresLetterhead": False}))
    db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=hpd.BUILTIN_JD_ID, version_no=1, content=content,
                              edited_by="system", edited_at=now, note="Built in"))
    db.commit()


def copy_duties_once(db: Session) -> int:
    """role_paperwork no longer prints a role's plain description as its
    duties (Oct 23 2026). So no role loses what it printed, once: a role with
    no duties keeps its real description as them ("Added while hiring..." is
    Nexus's own note, never duties)."""
    if db.query(NexusSetting).filter(NexusSetting.key == COPIED_KEY).first():
        return 0
    n = 0
    for r in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).all():
        desc = (r.description or "").strip()
        if not (r.job_description or "").strip() and desc and not desc.startswith("Added while hiring"):
            r.job_description, n = r.description, n + 1
    db.add(NexusSetting(key=COPIED_KEY, value="1", updated_by="system", updated_at=_now()))
    db.commit()
    return n


# ── duties ───────────────────────────────────────────────────────────────────

def live_versions(role) -> list:
    return [v for v in (getattr(role, "duty_versions", None) or []) if isinstance(v, dict) and not v.get("archivedAt")]


def _fits(v: dict, ctx: dict) -> bool:
    ha, wt, et = v.get("hiredAs") or "", ctx.get("worker_type") or "", ctx.get("employment_type") or ""
    return ((v.get("entityId") or "") in ("", ctx.get("entity_id") or "")
            and (v.get("country") or "") in ("", _code(ctx.get("country"), 2))
            and (not v.get("region") or v.get("region") == _code(ctx.get("region"), 3))
            and (ha == "" or (ha == "employee" and wt == "employee") or (ha == "contractor" and wt == "contractor")
                 or (ha in ("full_time", "part_time") and ha == et)))


def resolve_duties(role, ctx: dict) -> tuple:
    """(text, version | None) - the duties this hire's paperwork prints. The
    most specific fitting version wins, in resolve_setting's order: country,
    state, kind of hire (full/part-time over employee), company, newest. None
    fits = the Standard. A version's text is returned even when empty."""
    best, best_key = None, None
    for v in live_versions(role):
        if not _fits(v, ctx):
            continue
        key = (bool(v.get("country")), bool(v.get("region")), _RANK.get(v.get("hiredAs") or "", 0),
               bool(v.get("entityId")), v.get("updatedAt") or "")
        if best_key is None or key > best_key:
            best, best_key = v, key
    if best is None:
        return (getattr(role, "job_description", "") or "", None)
    return (best.get("text") or "", best)


def _company_name(db: Optional[Session], eid: str) -> str:
    e = db.query(HrEntity).filter(HrEntity.id == eid).first() if (db is not None and eid) else None
    return e.name if e else ("A Company" if eid else "")


def version_label(db: Optional[Session], v: dict) -> str:
    """"Contractors - Anywhere", "Part-Time Employees In California",
    "Greens Construction Only"."""
    ha = v.get("hiredAs") or ""
    place = hle.place_words(v.get("country") or "", v.get("region") or "")
    co = _company_name(db, v.get("entityId") or "")
    if not ha and not place and co:
        return f"{co} Only"
    out = f"{HIRED_WORDS.get(ha, 'Everyone')} In {place}" if place else f"{HIRED_WORDS.get(ha, 'Everyone')} - Anywhere"
    return out + (f" - {co} Only" if co else "")


def _version_who(db, v: dict) -> str:
    ha = v.get("hiredAs") or ""
    place = hle.place_words(v.get("country") or "", v.get("region") or "")
    co = _company_name(db, v.get("entityId") or "")
    out = f"Only {HIRED_WORDS[ha].lower()}" if ha else "Everyone"
    return out + (f" in {place}" if place else "") + (f" at {co}" if co else "")


def _version_for(db, v: dict) -> str:
    """'Contractors', 'Contractors In California', 'Greens Global' - read after "Only For"."""
    ha = v.get("hiredAs") or ""
    place = hle.place_words(v.get("country") or "", v.get("region") or "")
    co = _company_name(db, v.get("entityId") or "")
    if ha:
        return HIRED_WORDS[ha] + (f" In {place}" if place else "") + (f" At {co}" if co else "")
    return (f"{place} At {co}" if place and co else place or co) or "Everyone"


def _version_short(db, v: dict) -> str:
    ha = v.get("hiredAs") or ""
    return (_SHORT.get(ha) or hle.place_words(v.get("country") or "", v.get("region") or "")
            or _company_name(db, v.get("entityId") or ""))


def role_jd_doc(role) -> str:
    """The role's formatted Job Description - a role document that takes the
    job description page's place ('' = none)."""
    return next((str(r.get("templateId")) for r in (getattr(role, "hiring_docs", None) or [])
                 if isinstance(r, dict) and r.get("replaces") == hpd.JD_MARKER and r.get("templateId")), "")


def _any_duties(role) -> bool:
    """The role has duties written for some hire (its Standard or a version)."""
    return bool((getattr(role, "job_description", "") or "").strip()
                or any((v.get("text") or "").strip() for v in live_versions(role)))


def duty_ctx(entity_id: str, worker_type: str, country: str, region: str, employment_type: str = "") -> dict:
    et = employment_type or ("contractor" if worker_type == "contractor" else "full_time")
    return {"entity_id": entity_id or "", "worker_type": worker_type, "employment_type": et,
            "country": country, "region": region}


def duty_ctxs(entity_id: str, worker_type: str, country: str, region: str) -> list:
    """An employee row covers full-time and part-time hires, and each can
    have its own duties - both are checked, as the offer checks the one picked."""
    if worker_type == "employee":
        return [duty_ctx(entity_id, worker_type, country, region, et) for et in ("full_time", "part_time")]
    return [duty_ctx(entity_id, worker_type, country, region)]


def has_duties(role, ctxs: list, placement: str) -> bool:
    """Whether every hire these contexts cover gets duties printed. A role's
    formatted Job Description counts unless the packet prints the duties
    inside a document (template_ids_for then leaves it out)."""
    if role_jd_doc(role) and placement != "inside":
        return True
    return all(resolve_duties(role, x)[0].strip() for x in ctxs)


# ── labels ───────────────────────────────────────────────────────────────────

def columns(section: str) -> list:
    return [{"key": k, "event": e, "label": EVENT_NAMES[e] if e else JD_LABELS[section]} for k, e in SECTIONS[section]]


def kind(worker_type: str, country: str, region: str = "") -> str:
    return f"{'Employees' if worker_type == 'employee' else 'Contractors'} In {hle.place_words(country, region) or 'Anywhere'}"


def row_key(worker_type: str, country: str, region: str) -> str:
    return f"{worker_type}:{country}:{region}"


def source(db: Session, row: Optional[HrPacketSetting], viewing_entity: str, cell: tuple, event: str = "hire") -> tuple:
    """(label, tone) under a grid cell: where the letter or packet comes from."""
    wt, country, region = cell
    if row is None:
        if event == "promotion":
            return ("Promote is off here - Change Role Now still works", "missing")
        if event == "separation":
            return ("Offboarding runs without documents here", "missing")
        return (f"{'An employee' if wt == 'employee' else 'A contractor'} hire here would be blocked", "missing")
    if row.role_ids:
        names = [g.name for g in db.query(NexusGroup).filter(NexusGroup.id.in_(list(row.role_ids))).all()]
        return (f"Only For {', '.join(sorted(names)) or 'A Role'}", "own")
    if viewing_entity and (row.entity_id or "") == viewing_entity:
        return ("Only Here", "own")
    if not viewing_entity and ((row.country or "").upper(), (row.region or "").upper(),
                               row.worker_type or "any") == (country, region, wt):
        return ("Only Here", "own")
    if row.region:
        return (f"Same As All Companies - {hle.place_words(row.country, row.region)}", "same")
    if row.country:
        return (f"Same As All Companies - {hle.place_words(row.country)}", "same")
    return ("Same As All Companies", "same")


# ── places ───────────────────────────────────────────────────────────────────

def _setting_json(db: Session, key: str) -> list:
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    try:
        val = json.loads(row.value) if row and row.value else []
    except ValueError:
        val = []
    return val if isinstance(val, list) else []


def stored_places(db: Session, entity_id: str) -> list:
    out = []
    for p in _setting_json(db, PLACES_KEY + (entity_id or "")):
        if isinstance(p, dict) and _code(p.get("country"), 2):
            c = _code(p.get("country"), 2)
            out.append((c, _code(p.get("region"), 3) if c == "US" else ""))
    return list(dict.fromkeys(out))


def _own_rows(db: Session, entity_id: str) -> list:
    return [r for r in db.query(HrPacketSetting).filter(HrPacketSetting.entity_id == (entity_id or ""),
                                                        HrPacketSetting.event.in_(tuple(EVENT_NAMES))).all()
            if not r.archived_at]


def _fills_home(db: Session, entity_id: str, place: tuple) -> bool:
    """resolve_setting reads a US place with no state as the company's home
    state, so such a grid row would only repeat the home row."""
    return (bool(entity_id) and place[0] == "US" and not place[1] and hle.country_of(db, entity_id) == "US"
            and bool(hle.region_of(db, entity_id)))


def places_for(db: Session, entity_id: str, scope=None) -> list:
    """The places a company's grid shows: its home, then the places added with
    Add A Place, then any place its own letters and packets name. The shared
    screen: every company's places plus its own."""
    out = []
    if entity_id:
        c, r = hle.country_of(db, entity_id), hle.region_of(db, entity_id)
        if c:
            out.append((c, r if c == "US" else ""))
    else:
        for e in db.query(HrEntity).order_by(HrEntity.name).all():
            if scope is None or e.id in scope:
                out += places_for(db, e.id)
    out += stored_places(db, entity_id)
    # Hiring rows only (P5): a promotion letter or separation package for another
    # country never adds a row to the grid; Add A Place covers those.
    out += [((s.country or "").upper(), (s.region or "").upper()) for s in _own_rows(db, entity_id)
            if s.country and s.event in ("offer", "hire")]
    return [p for p in dict.fromkeys(out) if not _fills_home(db, entity_id, p)]


def set_place(db: Session, user: dict, scope, entity_id: str, country: str, region: str, remove: bool) -> list:
    entity_id = (entity_id or "").strip()
    _entity_or_404(db, entity_id, scope)
    if not entity_id and scope is not None:
        raise HTTPException(403, SHARED_WRITE)
    c = _code(country, 2)
    if not c:
        raise HTTPException(400, "Pick a country.")
    place = (c, _code(region, 3) if c == "US" else "")
    if not remove and _fills_home(db, entity_id, place):
        raise HTTPException(400, "Pick a state - each state has its own hiring paperwork.")
    cur = stored_places(db, entity_id)
    cur = [p for p in cur if p != place] if remove else list(dict.fromkeys(cur + [place]))
    key = PLACES_KEY + entity_id
    row = db.query(NexusSetting).filter(NexusSetting.key == key).first()
    if row is None:
        row = NexusSetting(key=key)
        db.add(row)
    row.value = json.dumps([{"country": a, "region": b} for a, b in cur])
    row.updated_by, row.updated_at = user["email"], _now()
    db.commit()
    return [{"country": a, "region": b} for a, b in cur]


def _entity_or_404(db: Session, entity_id: str, scope) -> Optional[HrEntity]:
    if not entity_id:
        return None
    e = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
    if e is None or (scope is not None and entity_id not in scope):
        raise HTTPException(404, "Company not found")
    return e


def _not_hired(db: Session, entity_id: str) -> list:
    from routers.hr_life_events import _not_hired as nh
    return nh(db, entity_id) if entity_id else []


# ── one company's screen ─────────────────────────────────────────────────────

class View:
    """Everything Screen 2 shows for one company (or All Companies), built
    from resolve_setting / resolve_duties only. A pure read."""

    def __init__(self, db: Session, entity_id: str, role_id: str = "", scope=None, *, grid: bool = True,
                 light: bool = False, role=None, section: str = "hiring"):
        self.db, self.scope, self.light = db, scope, light
        self.section, self.main = section, MAIN[section]
        self.cols = [(k, e) for k, e in SECTIONS[section] if e]       # the letter / packet columns
        self.subject = SUBJECT_WORD[self.cols[0][1]]
        self.eid = (entity_id or "").strip()
        self.entity = _entity_or_404(db, self.eid, scope)
        self.shared = not self.eid
        self.role = role
        if role_id and role is None:
            self.role = db.query(NexusGroup).filter(NexusGroup.id == role_id, NexusGroup.is_job_role == 1).first()
            if self.role is None or (self.role.company_id or "") not in ("", self.eid):
                raise HTTPException(404, "Role not found")
        self.owners = hc.role_owners(db, self.eid) if self.eid else {}
        self._snaps, self._names, self._home = {}, {}, {}
        q = db.query(NexusGroup).filter(NexusGroup.is_job_role == 1)
        self.roles = sorted([g for g in q.all() if (g.company_id or "") in (("",) if self.shared else ("", self.eid))],
                            key=lambda g: (g.name or "").lower())
        self.not_hired = _not_hired(db, self.eid)
        self.rows = [self._row(c, r, wt) for c, r in (places_for(db, self.eid, scope) if grid else [])
                     for wt in ("employee", "contractor")]
        stored = set(stored_places(db, self.eid))
        home = (hle.country_of(db, self.eid), hle.region_of(db, self.eid)) if self.eid else None
        for row in self.rows:
            place = (row["country"], row["region"])
            row["home"] = bool(home) and place == (home[0], home[1] if home[0] == "US" else "")
            row["removable"] = place in stored and not row["home"]

    # ── helpers
    def snap(self, tid: str):
        if tid not in self._snaps:
            snaps, _ = hpd.load_snaps(self.db, [tid])
            self._snaps[tid] = snaps[0] if snaps else None
        return self._snaps[tid]

    def name(self, tid: str) -> str:
        if tid not in self._names:
            t = self.db.query(DocTemplate).filter(DocTemplate.id == tid).first()
            self._names[tid] = t.name if t else "A template that no longer exists"
        return self._names[tid]

    def ctx(self) -> dict:
        return {"entity": self.entity, "owners": self.owners}

    def signer_name(self, role: str) -> str:
        if role == hpd.SUBJECT_ROLE:
            return self.subject
        if role == "manager":
            return "Their Manager"
        email = hpd.resolve_role(self.db, role, self.ctx()) if self.entity is not None else ""
        return hpd.name_of(self.db, email) if email else hpd.role_label(role)

    def signed_by(self, setting: HrPacketSetting, tid: str) -> str:
        s = self.snap(tid)
        if s is None:
            return ""
        keys = s.signature_roles
        return ", then ".join(self.signer_name(step["role"]) for step in hpd.signing_flow(setting)
                              if step["action"] == "sign" and step["key"] in keys)

    def signers(self, s: HrPacketSetting) -> list:
        """The roles that sign, in order, the person first. An uploaded-PDF
        letter signs by its template's roles (_parties_for): the manager
        role is their manager, any other is whoever sends it."""
        if hle.is_documents(s) or not s.template_id:
            return [x["role"] for x in hpd.signing_flow(s) if x["action"] == "sign"]
        from models import HrSignTemplate
        tpl = self.db.query(HrSignTemplate).filter(HrSignTemplate.id == s.template_id).first()
        keys, subj = ([r["key"] for r in hle.template_roles(tpl)] if tpl else []), s.subject_role or "employee"
        return [hpd.SUBJECT_ROLE] * (subj in keys) + ["manager" if k == "manager" else "sender" for k in keys if k != subj]

    def countersign(self, s: Optional[HrPacketSetting]) -> str:
        """Who signs a promotion letter after the employee ('' = nobody)."""
        return ", then ".join(self.signer_name(x) for x in (self.signers(s) if s is not None else [])
                              if x != hpd.SUBJECT_ROLE)

    def resolve(self, event: str, wt: str, c: str, r: str, skip=()) -> Optional[HrPacketSetting]:
        return hle.resolve_setting(self.db, self.eid, event, wt, self.role.id if self.role else "", c,
                                   documents_only=(event == "hire"), region=r, skip_ids=skip)

    def used_by(self, event: str, sid: str) -> str:
        if event not in self._home:
            m = {}
            for e in self.db.query(HrEntity).all():
                if self.scope is not None and e.id not in self.scope:
                    continue
                c, r = hle.country_of(self.db, e.id), hle.region_of(self.db, e.id)
                if not c:
                    continue
                m[e.id] = {getattr(hle.resolve_setting(self.db, e.id, event, wt, "", c, documents_only=(event == "hire"),
                                                       region=r), "id", "") for wt in ("employee", "contractor")}
            self._home[event] = m
        n = sum(1 for ids in self._home[event].values() if sid in ids)
        return f"used by {_plural(n, 'company', 'companies')}"

    def placement(self, setting: Optional[HrPacketSetting], event: str = "hire") -> tuple:
        """Where a hiring packet or promotion letter prints the duties."""
        event = setting.event if setting is not None else event
        none = ("none", "Not In This Letter" if event == "promotion" else "Not In This Packet")
        if setting is None:
            return none
        if event == "promotion" and not hle.is_documents(setting):
            return ("none", "Uploaded Letter - Prints What You Type")
        ids = list(setting.doc_template_ids or [])
        if hpd.JD_MARKER in ids:
            i = ids.index(hpd.JD_MARKER)
            return ("page", f"Its Own Page, After {self.name(ids[i - 1])}" if i else "Its Own Page, First")
        own = ids + [t for t in hpd.all_block_ids(setting) if t not in ids]
        first = next((s for s in (self.snap(t) for t in own) if s is not None and hpd.prints_duties([s], event)), None)
        if first is not None:
            return ("inside", f"Printed Inside {first.name}")
        if event == "hire" and (self.role is None or role_jd_doc(self.role) or _any_duties(self.role)):
            return ("end", "Its Own Page, At The End")      # a promotion prints a role's JD only at the marker
        return none

    # ── cells
    def _docs(self, setting: HrPacketSetting, event: str, ctx: dict) -> list:
        if self.role is None:
            out = []
            for tid in setting.doc_template_ids or []:
                if tid == hpd.JD_MARKER:
                    if event in ("hire", "promotion"):
                        out.append({"id": hpd.JD_MARKER, "name": "Job Description - Goes Here", "marker": True,
                                    "signedBy": ""})
                    continue
                out.append({"id": tid, "name": self.name(tid), "marker": False, "signedBy": self.signed_by(setting, tid)})
            return out
        role = self.role
        pw = hle.role_paperwork(role, ctx)
        ids = hpd.template_ids_for(setting, {"role_id": role.id, "department": role.department or "",
                                             "role_docs": pw["role_docs"], "role_description": pw["role_description"]},
                                   event)
        jd, role_docs = role_jd_doc(role), {d["templateId"]: d["replaces"] for d in pw["role_docs"]}
        out = []
        for tid in ids:
            if event in ("hire", "promotion") and tid in (hpd.BUILTIN_JD_ID, jd):
                out.append({"id": tid, "name": f"Job Description - {role.name}", "jd": True, "marker": False,
                            "signedBy": ""})
            elif event in ("hire", "promotion") and tid in role_docs:
                rep = role_docs[tid]
                out.append({"id": tid, "name": self.name(tid), "marker": False, "roleDoc": True,
                            "replacesName": ("Job Description" if rep == hpd.JD_MARKER else self.name(rep)) if rep else "",
                            "signedBy": self.signed_by(setting, tid)})
            else:
                out.append({"id": tid, "name": self.name(tid), "marker": False, "signedBy": self.signed_by(setting, tid)})
        return out

    def _cell(self, event: str, wt: str, c: str, r: str) -> dict:
        s = self.resolve(event, wt, c, r)
        label, tone = source(self.db, s, self.eid, (wt, c, r), event)
        fallback, archived = None, []
        if not self.light:              # the company list needs only the tones
            if self.shared:
                skip = [x.id for x in _own_rows(self.db, "") if not (x.role_ids or []) and x.event == event
                        and (x.country or "").upper() == c and (x.region or "").upper() == r
                        and (x.worker_type or "any") == wt]
            else:
                skip = [x.id for x in _own_rows(self.db, self.eid)]
            fb = self.resolve(event, wt, c, r, skip=tuple(skip))
            if fb is not None:
                fallback = {"settingId": fb.id, "name": fb.name or "Unnamed",
                            "sourceLabel": source(self.db, fb, self.eid, (wt, c, r), event)[0],
                            "usedByText": self.used_by(event, fb.id)}
            archived = sorted([x for x in self.db.query(HrPacketSetting)
                               .filter(HrPacketSetting.entity_id == self.eid, HrPacketSetting.event == event).all()
                               if x.archived_at and not (x.role_ids or []) and (x.country or "").upper() == c
                               and (x.region or "").upper() == r and (x.worker_type or "any") == wt],
                              key=lambda x: x.archived_at, reverse=True)
        out = {"name": (s.name or "Unnamed") if s is not None else "Nothing Yet - Choose One", "sourceLabel": label,
               "tone": tone, "settingId": s.id if s is not None else "", "engine": (s.engine or "pdf") if s is not None else "",
               "archivedOwnId": archived[0].id if archived else "", "fallback": fallback,
               "documents": self._docs(s, event, duty_ctx(self.eid, wt, c, r)) if s is not None else []}
        if event in ("hire", "promotion"):
            out["placement"], out["placementLabel"] = self.placement(s, event)
        if event == "promotion":
            out["countersign"] = self.countersign(s)
        out["_setting"] = s
        return out

    def _jd_cell(self, wt: str, c: str, r: str, placement: str, placement_label: str) -> dict:
        ctxs = duty_ctxs(self.eid, wt, c, r)
        if self.role is None:
            ready = sum(1 for g in self.roles if has_duties(g, ctxs, placement))
            return {"name": "Each Role's Duties", "sourceLabel": f"{ready} Of {len(self.roles)} Roles Ready",
                    "tone": "same", "placementLabel": placement_label, "versionId": "", "roleId": ""}
        role = self.role
        v = next((x for x in (resolve_duties(role, ctx)[1] for ctx in ctxs) if x is not None), None)
        if not has_duties(role, ctxs, placement):
            name, src, tone = "Not Written Yet", f"{role.name} has no duties", "missing"
        elif v is not None:
            name, src, tone = (f"{role.name} - {_version_short(self.db, v)} Version",
                               f"Only For {_version_for(self.db, v)}", "own")
        else:
            name, src, tone = f"{role.name} - Standard", "Same For Everyone", "same"
        return {"name": name, "sourceLabel": src, "tone": tone, "placementLabel": placement_label,
                "versionId": v["id"] if v else "", "roleId": role.id}

    def _row(self, c: str, r: str, wt: str) -> dict:
        row = {"key": row_key(wt, c, r), "kind": kind(wt, c, r),
               "sub": "Full-time and part-time" if wt == "employee" else "Independent contractors",
               "workerType": wt, "country": c, "region": r, "home": False, "removable": False,
               "notHired": wt in self.not_hired}
        for key, event in self.cols:
            row[key] = self._cell(event, wt, c, r)
        if self.section in JD_LABELS:
            main = row[self.main]
            row["jd"] = self._jd_cell(wt, c, r, main["placement"], main["placementLabel"])
        return row

    # ── the rest of the screen
    def jd_table(self) -> Optional[dict]:
        if self.section not in JD_LABELS:
            return None
        cols = [row for row in self.rows if not row["notHired"]]
        out = []
        for g in self.roles:
            cells = {}
            for row in cols:
                ctxs = duty_ctxs(self.eid, row["workerType"], row["country"], row["region"])
                v = next((x for x in (resolve_duties(g, ctx)[1] for ctx in ctxs) if x is not None), None)
                if not has_duties(g, ctxs, row[self.main]["placement"]):
                    cells[row["key"]] = {"label": "Not Written Yet", "tone": "missing", "versionId": ""}
                elif v is not None:
                    cells[row["key"]] = {"label": "Own Version", "tone": "own", "versionId": v["id"]}
                else:
                    cells[row["key"]] = {"label": "Standard", "tone": "same", "versionId": ""}
            out.append({"roleId": g.id, "name": g.name, "shared": not (g.company_id or ""), "cells": cells})
        return {"columns": [{"key": row["key"], "label": row["kind"]} for row in cols], "rows": out}

    def settings(self) -> list:
        """Every distinct letter and packet the grid resolves to."""
        out = {}
        for row in self.rows:
            for col, _ in self.cols:
                s = row[col]["_setting"]
                if s is not None:
                    out.setdefault(s.id, s)
        return list(out.values())

    def about(self) -> list:
        if self.entity is None:
            return []
        db, e = self.db, self.entity
        out = []
        country, region = (e.country or "").strip().upper()[:2], hle.region_of(db, e.id)
        if country:
            where = hle.place_words(country, region)
            value = f"{where}, United States" if country == "US" and region and where != "United States" else where
            out.append({"key": "worksIn", "label": "Works In", "value": value, "hint": "From the company address.",
                        "empty": False, "country": country, "region": region})
        else:
            addr = (getattr(e, "physical_address", "") or e.registered_address or "")
            m = re.search(r"\b([A-Z]{2})\s+\d{5}\b", addr)
            sc, sr = ("US", m.group(1)) if m and m.group(1) in hle.US_STATES else (("IN", "") if re.search(r"\bindia\b", addr, re.I) else ("", ""))
            out.append({"key": "worksIn", "label": "Works In",
                        "value": (f"{hle.place_words(sc, sr)}, United States" if sr else hle.place_words(sc)) if sc else "",
                        "hint": "Suggested from the address - click Edit to keep it." if sc else "Pick where its people work.",
                        "empty": True, "country": sc, "region": sr})
        # Handles Hiring: whoever the HR verify step goes to - resolve_role, as
        # the send (the HR department's head, else its backup, else the HR contact).
        dept = hc.owner_departments(db, e.id).get("hr")
        lead = hc.active_people(db, [dept.lead_email]) if dept is not None else []
        backup = hc.active_people(db, [dept.backup_email]) if dept is not None else []
        who = hpd.resolve_role(db, "hr", self.ctx())
        if who:
            parts = [hpd.name_of(db, who) + (" (HR Head)" if lead and lead[0] == who else "")]
            if backup and backup[0] != who:
                parts.append(f"{hpd.name_of(db, backup[0])} (Backup)")
            out.append({"key": "handlesHiring", "label": "Handles Hiring", "value": ", ".join(parts),
                        "hint": "Checks documents before they go out.", "empty": False, "email": who})
        else:
            sug, src = (lead[0], "the HR department head") if lead else ((backup[0], "the HR department backup") if backup else ("", ""))
            out.append({"key": "handlesHiring", "label": "Handles Hiring", "value": hpd.name_of(db, sug) if sug else "",
                        "hint": f"Suggested from {src} - click Edit to keep it." if sug else "Checks documents before they go out.",
                        "empty": True, "email": sug})
        # Signs For The Company: the authorized signatory; suggested from the Executive / Admin head.
        sig = (e.signatory_email or "").strip().lower()
        signs_hint = ("Signs after the new hire on a hiring packet." if self.section == "hiring"
                      else "Signs after the employee when a letter asks for the company.")
        if sig:
            p = hpd.person(db, sig)
            text = (e.signatory or "").strip() or ", ".join(x for x in (hpd.name_of(db, sig), (p.job_title if p else "") or "") if x)
            out.append({"key": "signsForCompany", "label": "Signs For The Company", "value": text,
                        "hint": signs_hint, "empty": False, "email": sig})
        else:
            sug, dname = "", ""
            for d in db.query(HrDepartment).filter(HrDepartment.company_id == e.id).all():
                n = (d.name or "").strip().lower()
                if n.startswith("exec") or n in ("admin", "administration"):
                    got = hc.active_people(db, [d.lead_email])
                    if got:
                        sug, dname = got[0], d.name
                        break
            p = hpd.person(db, sug) if sug else None
            out.append({"key": "signsForCompany", "label": "Signs For The Company",
                        "value": ", ".join(x for x in (hpd.name_of(db, sug), (p.job_title if p else "") or "") if x) if sug else "",
                        "hint": f"Suggested from the {dname} department head - click Edit to keep it." if sug
                        else signs_hint, "empty": True, "email": sug})
        tokens = {t for s in self.settings() for tid in s.doc_template_ids or [] for snap in [self.snap(tid)] if snap
                  for t in snap.tokens}
        if tokens & {"company_legal", "company_address"}:
            addr = (getattr(e, "physical_address", "") or e.registered_address or "").strip()
            legal = (e.legal_name or "").strip()
            out.append({"key": "legalAndAddress", "label": "Legal Name And Address",
                        "value": ", ".join(x for x in (legal, addr) if x), "hint": "Printed in the documents.",
                        "empty": not (legal and addr), "legalName": legal, "address": addr})
        return out

    def advanced(self) -> list:
        home = next((row for row in self.rows if row["home"] and row["workerType"] == "employee"), None)
        s = (home or {}).get(self.main, {}).get("_setting") or next(
            (row[self.main]["_setting"] for row in self.rows if row[self.main]["_setting"] is not None), None)
        if s is None:
            return []
        steps = [x for x in hpd.signing_flow(s) if x["action"] == "sign"]
        signing = ", then ".join(self.signer_name(x) for x in self.signers(s))
        lh = ""
        if s.letterhead_id:
            from models import DocLetterhead
            got = self.db.query(DocLetterhead).filter(DocLetterhead.id == s.letterhead_id).first()
            lh = got.name if got else ""
        pay = {"": "By event (the standard setting)", "always": "Always", "auto": "Only where a document prints it"}
        return [{"label": "Signing Order", "value": signing or "None"},
                {"label": "Checked By", "value": hpd.role_label(s.verify_role or "hr")},
                {"label": "Signs Once", "value": "On" if any(x.get("once") for x in steps) else "Off"},
                {"label": f"Extra Questions For {self.subject}",
                 "value": _plural(len(s.details_form or []), "question") if s.details_form else "None"},
                {"label": "Letterhead", "value": lh or "None"},
                {"label": "Who Can Open Pay", "value": pay.get(s.pay_mode or "", s.pay_mode or "")},
                {"label": "Egnyte Folder",
                 "value": (s.egnyte_subfolder or "").strip() or hle.DEFAULT_SUBFOLDERS.get(s.event, "")}]

    def upload_context(self) -> dict:
        e = self.entity
        if e is None:
            return {"entityId": "", "companyName": "", "companyLegal": "", "companyAddress": "", "companyPhone": "",
                    "signatoryName": "", "signatoryTitle": "", "roleNames": [g.name for g in self.roles]}
        sig = (e.signatory_email or "").strip().lower()
        p = hpd.person(self.db, sig) if sig else None
        name, title = (hpd.name_of(self.db, sig), (p.job_title if p else "") or "") if sig else ("", "")
        if not name and (e.signatory or "").strip():
            name, _, title = (e.signatory or "").partition(",")
        return {"entityId": e.id, "companyName": e.name, "companyLegal": e.legal_name or e.name,
                "companyAddress": (getattr(e, "physical_address", "") or e.registered_address or ""),
                "companyPhone": e.main_phone or "", "signatoryName": name.strip(), "signatoryTitle": title.strip(),
                "roleNames": [g.name for g in self.roles]}


def _check_fix(sid: str, chk: dict) -> tuple:
    fix = chk.get("fix") or {}
    k = fix.get("kind")
    if chk.get("key") == "payAccess":
        return ("Give Pay & Benefits Access", "navigate", {"view": "admin-console", "sub": "access"})
    if k == "entityField":
        f = {"hr_contact_email": ("Pick Who Handles Hiring", "handlesHiring"),
             "signatory_email": ("Pick Who Signs", "signsForCompany"),
             "physical_address": ("Add The Address", "legalAndAddress")}.get(fix.get("field"))
        if f:
            return (f[0], "editAbout", {"field": f[1]})
    if k == "checklistOwners":
        return ("Open Company Settings", "navigate", {"view": "admin-console", "sub": "company"})
    if k == "template":
        return ("Open Documents", "navigate", {"view": "documents", "sub": "documents-templates"})
    return ("Open The Packet", "advanced", {"settingId": sid})


def _promotion_or_offboarding_items(view: View, row: dict) -> list:
    key, event = view.cols[0]
    if row[key]["_setting"] is not None:
        return []
    text = (f"No promotion letter for {row['kind']} yet - Promote is off there, Change Role Now still works."
            if event == "promotion" else
            f"No separation package for {row['kind']} yet - offboarding still runs, without documents.")
    return [{"key": f"missing:{row['key']}", "text": text, "button": "Set It Up", "action": "setUp",
             "target": {"section": view.section, "rowKey": row["key"], "column": key}}]


def items(db: Session, view: View) -> list:
    """Things To Finish: each a sentence with its fix. Outside Hiring a target
    names its section (a hiring one infers it from the column, as in round 1)."""
    out = []
    hiring = view.section == "hiring"

    def tgt(**kw):
        return kw if hiring else {"section": view.section, **kw}
    for row in view.rows:
        if row["notHired"]:
            continue
        if not hiring:
            out += _promotion_or_offboarding_items(view, row)
            placement = row[view.main].get("placement")
            if not view.shared and placement in ("inside", "page"):
                ctxs = duty_ctxs(view.eid, row["workerType"], row["country"], row["region"])
                for g in ([view.role] if view.role is not None else view.roles):
                    if not has_duties(g, ctxs, placement):
                        out.append({"key": f"duties:{g.id}", "text": f"{g.name} has no duties written, and the "
                                                                     f"promotion letter prints them.",
                                    "button": "Add Duties", "action": "addDuties", "target": tgt(roleId=g.id)})
            continue
        o, p = row["offer"]["_setting"] is None, row["packet"]["_setting"] is None
        old = row["offer"]["_setting"]
        if old is not None and not hle.is_documents(old):        # start_offer refuses an uploaded-PDF letter
            out.append({"key": f"pdf:{old.id}", "text": f"The {old.name or 'offer letter'} is an old uploaded PDF and can't be sent.",
                        "button": "Rebuild From A Word File", "action": "setUp",
                        "target": {"rowKey": row["key"], "column": "offer"}})
        pdf = None
        if p:
            pdf = hle.resolve_setting(db, view.eid, "hire", row["workerType"], view.role.id if view.role else "",
                                      row["country"], region=row["region"])
            pdf = pdf if pdf is not None and not hle.is_documents(pdf) else None
        if o or (p and pdf is None):
            text = (f"No offer letter or hiring packet for {row['kind']} yet." if o and p and pdf is None
                    else f"No offer letter for {row['kind']} yet." if o else f"No hiring packet for {row['kind']} yet.")
            out.append({"key": f"missing:{row['key']}", "text": text, "button": "Set It Up", "action": "setUp",
                        "target": {"rowKey": row["key"], "column": "offer" if o else "packet"}})
        if pdf is not None:
            out.append({"key": f"pdf:{pdf.id}", "text": f"The {pdf.name or 'hiring packet'} is an old uploaded PDF and can't start by itself.",
                        "button": "Rebuild From A Word File", "action": "setUp",
                        "target": {"rowKey": row["key"], "column": "packet"}})
        placement = row["packet"].get("placement")
        if not view.shared and placement in ("inside", "page"):
            ctxs = duty_ctxs(view.eid, row["workerType"], row["country"], row["region"])
            for g in ([view.role] if view.role is not None else view.roles):
                if not has_duties(g, ctxs, placement):
                    out.append({"key": f"duties:{g.id}", "text": f"{g.name} has no duties written, and the hiring packet prints them.",
                                "button": "Add Duties", "action": "addDuties", "target": {"roleId": g.id}})
    for s in view.settings():
        if not hiring and not hle.is_documents(s):
            continue                      # an uploaded-PDF promotion letter or package still sends
        for chk in hpd.readiness(db, s, entity=view.entity):
            if chk.get("severity") != "block":
                continue
            button, action, target = _check_fix(s.id, chk)
            target = target if action == "navigate" else tgt(**target)
            out.append({"key": f"check:{s.id}:{chk['key']}", "text": chk.get("detail") or chk.get("label") or "",
                        "button": button, "action": action, "target": target})
    seen, uniq = set(), []
    for it in out:
        if it["text"] not in seen:
            seen.add(it["text"])
            uniq.append(it)
    return uniq


def status_of(view: View, its: list) -> tuple:
    if view.entity is not None and not (view.entity.country or "").strip():
        return ("notStarted", "Not Started")
    if not its:
        return ("ready", READY[view.section])
    return ("left", f"{_plural(len(its), 'Thing')} Left")


def summary(view: View) -> str:
    rows = [r for r in view.rows if not r["notHired"]]
    parts = []

    def state(col):
        tones = {r[col]["tone"] for r in rows} - {"missing"}
        return "shared" if tones == {"same"} else "own" if tones == {"own"} else "mixed" if tones else ""
    so, sp = state("offer"), state("packet")
    if so == sp and so == "shared":
        parts.append("Uses the shared offer letter and hiring packet")
    elif so == sp and so == "own":
        parts.append("Own offer letter and hiring packet")
    else:
        for col, st, noun in (("offer", so, "offer letter"), ("packet", sp, "hiring packet")):
            if st == "shared":
                parts.append(f"uses the shared {noun}")
            elif st == "own":
                parts.append(f"own {noun}")
            elif st == "mixed":
                kinds = [r["kind"] for r in rows if r[col]["tone"] == "own"]
                parts.append(f"own {noun} for {' and '.join(kinds)}")
    for wt, text in (("contractor", "no contractor documents yet"), ("employee", "nothing yet for employees")):
        mine = [r for r in rows if r["workerType"] == wt]
        if mine and all(r["offer"]["tone"] == "missing" and r["packet"]["tone"] == "missing" for r in mine):
            parts.append(text)
    duty = ""
    for g in view.roles:
        for r in rows:
            _, v = resolve_duties(g, duty_ctx(view.eid, r["workerType"], r["country"], r["region"]))
            if v is not None:
                ha = v.get("hiredAs") or ""
                duty = f"own duties for {g.name}" + (f" {HIRED_WORDS[ha].lower()}" if ha else "")
                break
        if duty:
            break
    parts.append(duty or "shared duties for every role")
    text = " - ".join(p for p in parts if p)
    return text[:1].upper() + text[1:]


def _ser_row(row: dict) -> dict:
    return {k: ({a: b for a, b in v.items() if a != "_setting"} if isinstance(v, dict) else v) for k, v in row.items()}


def sections_of(db: Session, entity_id: str, scope, role_id: str = "", known: Optional[dict] = None) -> list:
    """Each section's chip, from a light View of it - so the list, the
    segmented control and the section itself never disagree."""
    out = []
    for key in SECTIONS:
        if known and key in known:
            status, chip = known[key]
        else:
            v = View(db, entity_id, role_id, scope, light=True, section=key)
            status, chip = status_of(v, items(db, v))
        out.append({"key": key, "label": SECTION_LABELS[key], "status": status, "chip": chip})
    return out


def company_view(db: Session, entity_id: str, role_id: str, scope, section: str = "hiring") -> dict:
    section = section or "hiring"
    if section not in SECTIONS:
        raise HTTPException(400, "Unknown section")
    v = View(db, entity_id, role_id, scope, section=section)
    its = items(db, v)
    status, chip = status_of(v, its)
    e = v.entity
    return {"entity": {"id": v.eid, "name": e.name if e else "All Companies", "shared": v.shared,
                       "canEdit": scope is None if v.shared else True,
                       "country": (e.country or "").upper() if e else "", "region": hle.region_of(db, v.eid) if e else ""},
            "status": status, "chip": chip, "items": its, "about": v.about(),
            "roles": [{"id": g.id, "name": g.name, "department": g.department or "", "shared": not (g.company_id or "")}
                      for g in v.roles],
            "rows": [_ser_row(r) for r in v.rows], "jobDescriptions": v.jd_table(), "advanced": v.advanced(),
            "uploadContext": v.upload_context(), "section": section,
            "sections": sections_of(db, v.eid, scope, role_id, {section: (status, chip)}), "columns": columns(section)}


def company_list(db: Session, scope) -> dict:
    companies = []
    for e in db.query(HrEntity).order_by(HrEntity.name).all():
        if scope is not None and e.id not in scope:
            continue
        v = View(db, e.id, "", scope, light=True)
        its = items(db, v)
        status, chip = status_of(v, its)
        companies.append({"id": e.id, "name": e.name,
                          "place": hle.place_words(hle.country_of(db, e.id), hle.region_of(db, e.id)) or "No place set",
                          "status": status, "chip": chip,
                          "summary": ("Pick where its people work and it starts with the shared documents"
                                      if status == "notStarted" else summary(v)),
                          "sections": sections_of(db, e.id, scope, known={"hiring": (status, chip)})})
    shared = [s for s in _own_rows(db, "")]
    offers = sum(1 for s in shared if s.event == "offer")
    hires = sum(1 for s in shared if s.event == "hire")
    duties = sum(1 for g in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).all()
                 if not (g.company_id or "") and (g.job_description or "").strip())
    return {"shared": {"summary": f"What every company uses unless it has its own: {_plural(offers, 'offer letter')}, "
                                  f"{_plural(hires, 'hiring packet')}, duties for {_plural(duties, 'role')}.",
                       "canEdit": scope is None},
            "companies": companies}


# ── Use The Same / Make A Different One ──────────────────────────────────────

def _locked_setting(db: Session, sid: str, scope) -> HrPacketSetting:
    from routers.hr_life_events import _setting_in_scope
    row = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).with_for_update().first()
    if row is None:
        raise HTTPException(404, "Packet setting not found")
    _setting_in_scope(row.entity_id or "", scope, write=True)
    return row


def use_same(db: Session, user: dict, scope, sid: str) -> dict:
    """Put this level's own letter or packet aside so the level above applies.
    Refused while a hire it started is still open - that hire would otherwise
    get different paperwork half way through."""
    row = _locked_setting(db, sid, scope)
    if row.archived_at:
        return {"ok": True, "archivedId": row.id}
    n = sum(1 for ev in db.query(HrLifeEvent).filter(HrLifeEvent.status.in_(hle.OPEN)).all()
            if ev.setting_id == sid or (ev.inputs or {}).get("hire_packet_id") == sid)
    if n:
        one, many = _IN_USE.get(row.event, _IN_USE["hire"])
        raise HTTPException(409, f"{f'1 {one} is' if n == 1 else f'{n} {many} are'} using this one right now. "
                                 f"Try again once they finish.")
    row.archived_at, row.archived_by = _now(), user["email"].lower()
    db.commit()
    return {"ok": True, "archivedId": row.id}


def restore(db: Session, user: dict, scope, sid: str) -> dict:
    from routers.hr_life_events import _place_taken, _roles_taken
    row = _locked_setting(db, sid, scope)
    row.archived_at, row.archived_by = "", ""
    try:
        _roles_taken(db, row)
        _place_taken(db, row)
    except HTTPException:
        db.rollback()
        raise
    row.updated_by, row.updated_at = user["email"], _now()
    db.commit()
    return hle.ser_setting(db, row)


def _signature_keys(snaps: list) -> list:
    """Every signature block's key in document order: body pages, then the
    header and footer."""
    out = []

    def walk(node):
        if isinstance(node, list):
            for x in node:
                walk(x)
        elif isinstance(node, dict):
            if node.get("type") == "signatureBlock":
                k = str((node.get("attrs") or {}).get("role") or "").strip().lower()
                if k and k not in out:
                    out.append(k)
            for key in ("pages", "json", "content", "header", "footer"):
                walk(node.get(key))
    for s in snaps:
        walk(s.content if isinstance(s.content, dict) else {})
    return out


def _flow_for(event: str, snaps: list, old: Optional[list] = None) -> list:
    """The signing order Nexus works out from the documents' signature lines:
    the person first; on anything but an offer letter each company signer
    whose line was found, in document order. An existing flow keeps its approve and copy
    steps and its people; a sign step whose line is gone is dropped."""
    keys = _signature_keys(snaps)
    prints_sig = any("signatory" in s.tokens for s in snaps)
    flow = hpd.clean_flow(old or [])
    if not any(x["role"] == hpd.SUBJECT_ROLE for x in flow):
        subject = next((k for k in keys if hpd.default_role(k) == hpd.SUBJECT_ROLE), "employee")
        flow.insert(0, {"key": subject, "role": hpd.SUBJECT_ROLE, "action": "sign"})
    flow = [x for x in flow if x["role"] == hpd.SUBJECT_ROLE or x["action"] != "sign" or x["key"] in keys]
    if event != "offer":
        have = {x["key"] for x in flow}
        flow += [{"key": k, "role": hpd.default_role(k, prints_sig), "action": "sign"} for k in keys
                 if k not in have and hpd.default_role(k) != hpd.SUBJECT_ROLE]
    return flow


def _clean_ids(db: Session, ids, event: str = "hire") -> list:
    out = list(dict.fromkeys(str(t).strip() for t in (ids or []) if str(t).strip()))
    if hpd.JD_MARKER in out:
        snaps, _ = hpd.load_snaps(db, out)
        if hpd.prints_duties(snaps, event):
            out.remove(hpd.JD_MARKER)        # the duties are printed inside - never twice
    return out


def _problems(db: Session, row: HrPacketSetting) -> list:
    ids = list(row.doc_template_ids or []) + [t for t in hpd.all_block_ids(row) if t not in (row.doc_template_ids or [])]
    snaps, snap_problems = hpd.load_snaps(db, ids)
    return hpd.config_problems(db, row, snaps, snap_problems)


def make_own(db: Session, user: dict, scope, body: dict) -> dict:
    from routers.hr_life_events import _place_taken, _setting_in_scope
    event = str(body.get("event") or "")
    if event not in EVENT_NAMES:
        raise HTTPException(400, "Unknown event")
    eid = str(body.get("entity_id") or "").strip()
    entity = _entity_or_404(db, eid, scope)
    _setting_in_scope(eid, scope, write=True)
    start = "templates" if body.get("start") == "templates" else "copy"
    src = None
    keys = [{"worker_type": body.get("worker_type"), "country": body.get("country"), "region": body.get("region")}]
    keys += [k for k in (body.get("also") or []) if isinstance(k, dict)]
    out, seen = [], set()
    try:
        for i, k in enumerate(keys):
            wt = str(k.get("worker_type") or "")
            if wt not in ("employee", "contractor"):
                raise HTTPException(400, "Pick Employees or Contractors.")
            c = _code(k.get("country"), 2)
            r = _code(k.get("region"), 3) if c == "US" else ""
            if event == "hire" and not c:
                raise HTTPException(400, "Pick where this packet's hires work (Works In) - hiring paperwork is "
                                         "different in each country and state.")
            if (wt, c, r) in seen:
                continue
            seen.add((wt, c, r))
            what = kind(wt, c, r)
            if start == "copy" and i == 0:
                # The primary cell's letter or packet is the source for every
                # key - Also Use It For gets the same documents.
                src = hle.resolve_setting(db, eid, event, wt, "", c, documents_only=(event == "hire"), region=r)
                if src is not None and not hle.is_documents(src):
                    raise HTTPException(400, f"The {src.name or EVENT_NAMES[event].lower()} for {what} is an old "
                                             f"uploaded PDF - upload a Word file or pick one you already have.")
                if src is None:
                    raise HTTPException(400, f"There is nothing to copy for {what} yet - upload a Word file or pick "
                                             f"one you already have.")
            row = _make_one(db, user, entity, eid, event, wt, c, r, start, body.get("doc_template_ids"), src)
            problems = _problems(db, row)
            if problems:
                raise HTTPException(400, (f"{what}: " if i else "") + problems[0])
            _place_taken(db, row)
            db.flush()
            out.append(row)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return {"settings": [hle.ser_setting(db, s) for s in out], "settingIds": [s.id for s in out]}


def _make_one(db, user, entity, eid, event, wt, c, r, start, doc_ids, src) -> HrPacketSetting:
    existing = next((x for x in _own_rows(db, eid) if x.event == event and not (x.role_ids or [])
                     and (x.worker_type or "any") == wt and (x.country or "").upper() == c
                     and (x.region or "").upper() == r), None)
    now = _now()
    if start == "copy":
        if existing is not None:
            return existing
        row = HrPacketSetting(id=str(uuid.uuid4()), created_at=now, template_id="", engine="documents")
        for f in ("doc_template_ids", "flow", "details_form", "extra_docs"):
            setattr(row, f, list(getattr(src, f) or []))
        for f in ("verify_role", "verify_distinct", "pay_mode", "email_message", "egnyte_subfolder", "subject_role"):
            setattr(row, f, getattr(src, f))
        row.letterhead_id = (src.letterhead_id or "") if eid else ""
    else:
        ids = _clean_ids(db, doc_ids, event)
        snaps, _ = hpd.load_snaps(db, ids)
        if existing is not None:
            existing.doc_template_ids = ids
            existing.flow = _flow_for(event, snaps, existing.flow)
            existing.subject_role = next((x["key"] for x in existing.flow if x["role"] == hpd.SUBJECT_ROLE), "employee")
            existing.updated_by, existing.updated_at = user["email"], now
            return existing
        row = HrPacketSetting(id=str(uuid.uuid4()), created_at=now, template_id="", engine="documents",
                              doc_template_ids=ids, flow=_flow_for(event, snaps), verify_role="hr", verify_distinct=0,
                              pay_mode="", email_message="", egnyte_subfolder="", details_form=[], extra_docs=[],
                              letterhead_id="")
        row.subject_role = next((x["key"] for x in row.flow if x["role"] == hpd.SUBJECT_ROLE), "employee")
    row.entity_id, row.event, row.worker_type, row.country, row.region = eid, event, wt, c, r
    row.role_ids, row.archived_at, row.archived_by = [], "", ""
    row.name = (f"{entity.name} - " if entity is not None else "") + f"{kind(wt, c, r)} {EVENT_NAMES[event]}"
    row.updated_by, row.updated_at = user["email"], now
    db.add(row)
    return row


def set_documents(db: Session, user: dict, scope, sid: str, doc_ids) -> dict:
    row = _locked_setting(db, sid, scope)
    if row.archived_at:
        raise HTTPException(400, "This one is not in use - use it again first.")
    ids = _clean_ids(db, doc_ids, row.event)
    if row.event == "offer" and hpd.JD_MARKER in ids:
        raise HTTPException(400, "An offer letter never carries the job description - it goes in the hiring packet.")
    if row.event == "separation" and hpd.JD_MARKER in ids:
        raise HTTPException(400, "A separation package never carries the job description - take it out of this one.")
    snaps, _ = hpd.load_snaps(db, ids + [t for t in hpd.all_block_ids(row) if t not in ids])
    row.doc_template_ids = ids
    row.flow = _flow_for(row.event, snaps, row.flow)
    row.subject_role = next((x["key"] for x in row.flow if x["role"] == hpd.SUBJECT_ROLE), "employee")
    row.updated_by, row.updated_at = user["email"], _now()
    problems = _problems(db, row)
    if problems:
        db.rollback()
        raise HTTPException(400, problems[0])
    db.commit()
    return hle.ser_setting(db, row)


OWN_FIRST = ("Every company uses this one - click Make A Different One first, then change the wording in "
             "this company's own copy.")


def own_copy(db: Session, user: dict, scope, sid: str, tid: str, entity_id: str = "") -> dict:
    """Edit Wording from a company's screen: a document other rows or roles
    also use is copied for this company first ("<Title> - <Company>"), so a
    shared template is never changed by accident. entity_id is the screen's
    company: a shared row seen from there is refused - it is every company's."""
    from routers.documents import TemplateNotPublished, published_snapshot
    if (entity_id or "").strip():
        found = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).first()
        if found is not None and not (found.entity_id or ""):
            raise HTTPException(400, OWN_FIRST)
    row = _locked_setting(db, sid, scope)
    if tid == hpd.JD_MARKER or tid not in (row.doc_template_ids or []):
        raise HTTPException(404, "That document is not in this packet.")
    tpl = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if tpl is None:
        raise HTTPException(404, "That document is not in this packet.")
    shared = any(tid in (s.doc_template_ids or []) or tid in hpd.all_block_ids(s)
                 for s in db.query(HrPacketSetting).filter(HrPacketSetting.id != sid).all() if not s.archived_at)
    shared = shared or any(isinstance(d, dict) and d.get("templateId") == tid
                           for g in db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).all() for d in g.hiring_docs or [])
    if not (row.entity_id or "") or not shared:
        return {"templateId": tid, "name": tpl.name, "copied": False}
    try:
        content, meta, _v = published_snapshot(db, tpl)
    except TemplateNotPublished as e:
        raise HTTPException(400, str(e))
    entity = db.query(HrEntity).filter(HrEntity.id == row.entity_id).first()
    now, nid = _now(), str(uuid.uuid4())
    name = f"{tpl.name} - {entity.name if entity else 'This Company'}"[:200]
    db.add(DocTemplate(id=nid, name=name, category=tpl.category, tags=list(tpl.tags or []), content=content,
                       requires_letterhead=bool(meta.get("requiresLetterhead")), letterhead_id=meta.get("letterheadId") or "",
                       merge_overrides=dict(meta.get("mergeOverrides") or {}), field_defs=list(meta.get("fieldDefs") or []),
                       department=tpl.department or "", doc_type=tpl.doc_type or "document",
                       signer_roles=list(meta.get("signerRoles") or []), status="active", version=1,
                       created_by=user["email"], created_at=now, updated_by=user["email"], updated_at=now,
                       published_version=1, published_meta=dict(meta), published_by=user["email"], published_at=now))
    db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=nid, version_no=1, content=content,
                              edited_by=user["email"], edited_at=now, note=f"Copied from {tpl.name}"))
    row.doc_template_ids = [nid if t == tid else t for t in row.doc_template_ids]
    row.updated_by, row.updated_at = user["email"], now
    db.commit()
    return {"templateId": nid, "name": name, "copied": True}


# ── role duties (Popup B) ────────────────────────────────────────────────────

def _role(db: Session, rid: str, scope, lock: bool = False) -> NexusGroup:
    q = db.query(NexusGroup).filter(NexusGroup.id == rid, NexusGroup.is_job_role == 1)
    g = q.with_for_update().first() if lock else q.first()
    if g is None or ((g.company_id or "") and scope is not None and g.company_id not in scope):
        raise HTTPException(404, "Role not found")
    return g


def duties_out(db: Session, g: NexusGroup, entity_id: str, scope) -> dict:
    eid = (entity_id or "").strip()
    _entity_or_404(db, eid, scope)
    used = {}
    for c, r in places_for(db, eid, scope):
        for wt in ("employee", "contractor"):
            if wt == "employee":
                got = [(et, resolve_duties(g, duty_ctx(eid, wt, c, r, et))[1]) for et in ("full_time", "part_time")]
                ids = [v["id"] if v else "standard" for _, v in got]
                if ids[0] == ids[1]:
                    used.setdefault(ids[0], []).append(kind(wt, c, r))
                else:
                    for (et, _), vid in zip(got, ids):
                        used.setdefault(vid, []).append(
                            f"{'Full-Time' if et == 'full_time' else 'Part-Time'} {kind(wt, c, r)}")
            else:
                v = resolve_duties(g, duty_ctx(eid, wt, c, r))[1]
                used.setdefault(v["id"] if v else "standard", []).append(kind(wt, c, r))
    versions = [{"id": "standard", "label": "Standard - Everyone", "who": "Employees and contractors, every place",
                 "hiredAs": "", "country": "", "region": "", "entityId": "", "text": g.job_description or "",
                 "usedBy": used.get("standard", [])}]
    for v in sorted(live_versions(g), key=lambda v: v.get("createdAt") or ""):
        versions.append({"id": v["id"], "label": version_label(db, v), "who": _version_who(db, v),
                         "hiredAs": v.get("hiredAs") or "", "country": v.get("country") or "",
                         "region": v.get("region") or "", "entityId": v.get("entityId") or "",
                         "text": v.get("text") or "", "usedBy": used.get(v["id"], [])})
    from routers.jobroles import _ser_hiring_docs
    docs = _ser_hiring_docs(db, list(g.hiring_docs or []))
    jd = next((d for d in docs if d["replaces"] == hpd.JD_MARKER), None)
    return {"role": {"id": g.id, "name": g.name, "department": g.department or "", "shared": not (g.company_id or ""),
                     "companyId": g.company_id or ""},
            "versions": versions,
            "formattedJd": {"templateId": jd["templateId"], "name": jd["templateName"]} if jd else None,
            "hiringDocs": [{"templateId": d["templateId"], "name": d["templateName"], "replaces": d["replaces"],
                            "replacesName": d["replacesName"]} for d in docs]}


def _version_scope(g: NexusGroup, entity_id: str, scope) -> None:
    if scope is None:
        return
    if not (g.company_id or "") and not entity_id:
        raise HTTPException(403, SHARED_DUTIES)
    if entity_id and entity_id not in scope:
        raise HTTPException(404, "Company not found")


def add_duty(db: Session, user: dict, scope, rid: str, body: dict) -> dict:
    g = _role(db, rid, scope, lock=True)
    ha = str(body.get("hired_as") or "")
    c = _code(body.get("country"), 2)
    r = _code(body.get("region"), 3) if c == "US" else ""
    eid = "" if (g.company_id or "") else str(body.get("entity_id") or "").strip()
    if ha not in HIRED_AS or not (ha or c or eid):
        raise HTTPException(400, "Pick who this version is for.")
    if eid:
        _entity_or_404(db, eid, scope)
    _version_scope(g, eid, scope)
    new = {"hiredAs": ha, "country": c, "region": r, "entityId": eid}
    if any(all((v.get(k) or "") == new[k] for k in new) for v in live_versions(g)):
        raise HTTPException(409, f"This role already has a version for {version_label(db, new)} - change that one.")
    wt = "contractor" if ha == "contractor" else "employee"
    text, _ = resolve_duties(g, duty_ctx(eid, wt, c, r, ha if ha in ("full_time", "part_time") else ""))
    now = _now()
    v = {"id": f"dv-{uuid.uuid4().hex[:8]}", **new, "text": text, "createdBy": user["email"].lower(),
         "createdAt": now, "updatedAt": now, "archivedAt": ""}
    g.duty_versions = list(g.duty_versions or []) + [v]
    db.commit()
    return {**duties_out(db, g, str(body.get("entity_id") or "") if not eid else eid, scope), "versionId": v["id"]}


def _find_version(g: NexusGroup, vid: str) -> dict:
    v = next((v for v in live_versions(g) if v.get("id") == vid), None)
    if v is None:
        raise HTTPException(404, "That version no longer exists.")
    return v


def update_duty(db: Session, user: dict, scope, rid: str, vid: str, text: str) -> dict:
    g = _role(db, rid, scope, lock=True)
    text = (text or "").strip()[:20000]
    if vid == "standard":
        if not (g.company_id or "") and scope is not None:
            raise HTTPException(403, SHARED_DUTIES)
        g.job_description = text
    else:
        v = _find_version(g, vid)
        _version_scope(g, v.get("entityId") or "", scope)
        g.duty_versions = [{**x, "text": text, "updatedAt": _now()} if x.get("id") == vid else x
                           for x in (g.duty_versions or [])]
    db.commit()
    return {"id": vid, "text": text}


def remove_duty(db: Session, user: dict, scope, rid: str, vid: str, entity_id: str = "") -> dict:
    """Use The Standard Instead: the version is archived, never removed."""
    if vid == "standard":
        raise HTTPException(400, "The standard version stays - change its text instead.")
    g = _role(db, rid, scope, lock=True)
    v = _find_version(g, vid)
    _version_scope(g, v.get("entityId") or "", scope)
    g.duty_versions = [{**x, "archivedAt": _now(), "archivedBy": user["email"].lower()} if x.get("id") == vid else x
                       for x in (g.duty_versions or [])]
    db.commit()
    return duties_out(db, g, entity_id, scope)


def set_role_documents(db: Session, user: dict, scope, rid: str, rows) -> dict:
    from routers.jobroles import _clean_hiring_docs, _ser_hiring_docs
    g = _role(db, rid, scope, lock=True)
    if not (g.company_id or "") and scope is not None:
        raise HTTPException(403, SHARED_ROLE_DOCS)
    docs = _clean_hiring_docs(db, rows)
    if sum(1 for d in docs if d["replaces"] == hpd.JD_MARKER) > 1:
        raise HTTPException(400, "Only one document can take the job description's place.")
    g.hiring_docs = docs
    db.commit()
    return {"hiringDocs": [{"templateId": d["templateId"], "name": d["templateName"], "replaces": d["replaces"],
                            "replacesName": d["replacesName"]} for d in _ser_hiring_docs(db, docs)]}


# ── the offer: What They Get ─────────────────────────────────────────────────

def what_they_get(db: Session, cand, wt: str, et: str, country: str, region: str, role, letter, packet,
                  new_role_name: str = "") -> tuple:
    """([line], blocked) - the offer screen's What They Get card, from the
    same resolver the send uses. The duties line blocks only on the screen;
    the server never refuses a send for empty duties."""
    eid = cand.company or ""
    view = View(db, eid, grid=False, role=role)       # its helpers only, no grid
    rk, what, first = row_key(wt, country, region), kind(wt, country, region), (cand.first_name or "they").strip()
    blocked_text = f"{'An employee' if wt == 'employee' else 'A contractor'} can't be hired here yet"
    lines = []
    for key, label, s in (("offer", "Offer Letter", letter), ("packet", "Then The Hiring Packet", packet)):
        if s is None:
            lines.append({"key": key, "label": label, "name": f"Nothing Yet For {what}", "sourceLabel": blocked_text,
                          "tone": "missing", "blocks": True,
                          "fix": {"action": "setUp", "target": {"entityId": eid, "rowKey": rk,
                                                                "column": "offer" if key == "offer" else "packet"}}})
            continue
        src, tone = source(db, s, eid, (wt, country, region))
        if key == "packet":
            src = f"Starts by itself once {first} signs the offer"
        lines.append({"key": key, "label": label, "name": s.name or "Unnamed", "sourceLabel": src, "tone": tone,
                      "blocks": False, "fix": None})
    placement = view.placement(packet)[0]
    if role is not None:
        text, v = resolve_duties(role, duty_ctx(eid, wt, country, region, et))
        jd = role_jd_doc(role) if placement != "inside" else ""     # inside: template_ids_for leaves it out
        end = " - Its Own Page, At The End" if placement == "end" else ""   # the built-in page (template_ids_for)
        if not jd and (placement == "none" or (end and not text.strip())):
            line = ("Not In This Packet", "This Hiring Packet Does Not Print Them", "same", False, None)
        elif jd:
            line = (f"{role.name} - {view.name(jd)}", "Its Own Page", "own", False, None)
        elif v is not None and text.strip():
            line = (f"{role.name} - {_version_short(db, v)} Version", f"Only For {_version_for(db, v)}{end}", "own", False, None)
        elif text.strip():
            line = (f"{role.name} - Standard", f"Same For Everyone{end}", "same", False, None)
        else:
            line = (f"{role.name} - no duties written", "Add them before sending", "missing", True,
                    {"action": "addDuties", "target": {"entityId": eid, "roleId": role.id}})
        lines.append({"key": "jd", "label": "Job Description", "name": line[0], "sourceLabel": line[1], "tone": line[2],
                      "blocks": line[3], "fix": line[4]})
    elif new_role_name is not None:
        lines.append({"key": "jd", "label": "Job Description", "name": f"{new_role_name or 'New Role'} - no duties yet",
                      "sourceLabel": "The hiring packet prints them blank", "tone": "missing", "blocks": False, "fix": None})

    def signs(s):
        return ", then ".join(view.signer_name(x["role"]) for x in hpd.signing_flow(s) if x["action"] == "sign")
    parts = [f"{n}: {signs(s).replace('The New Hire', 'New Hire')}" for n, s in (("Offer", letter), ("Packet", packet))
             if s is not None]
    lines.append({"key": "signs", "label": "Signs", "name": " - ".join(parts), "sourceLabel": "", "tone": "same",
                  "blocks": False, "fix": None})
    return lines, ("Fix the amber item before sending." if any(x["blocks"] for x in lines) else "")


# ── promotion and offboarding: What They Get (round 2) ──────────────────────

def _line(key: str, label: str, name: str, source_label: str, tone: str, blocks: bool = False, fix=None) -> dict:
    return {"key": key, "label": label, "name": name, "sourceLabel": source_label, "tone": tone, "blocks": blocks,
            "fix": fix}


def _setting_line(db: Session, key: str, s: HrPacketSetting, eid: str, cell: tuple) -> dict:
    src, tone = source(db, s, eid, cell, s.event)
    return _line(key, EVENT_NAMES[s.event], s.name or "Unnamed", src, tone)


def _signs_line(view: View, s: HrPacketSetting) -> dict:
    return _line("signs", "Signs", ", then ".join(view.signer_name(x) for x in view.signers(s)), "", "same")


def promotion_options(db: Session, emp, role) -> dict:
    """The Promote form's What They Get card and the new role's duties to
    prefill - from the same resolvers plan_promotion uses. Nothing here
    blocks Change Role Now; the duties line never blocks (HR can type them
    for this one letter)."""
    eid = emp.company or ""
    c, r = hle.employee_place(db, emp)
    wt, et = hle.worker_type_of(emp.employment_type), emp.employment_type or ""
    rk, what = row_key(wt, c, r), kind(wt, c, r)
    letter = hle.resolve_for_employee(db, emp, "promotion", role.id if role is not None else "")
    view = View(db, eid, grid=False, role=role, section="promotion")
    lines = []
    if letter is None:
        lines.append(_line("letter", "Promotion Letter", f"Nothing Yet For {what}",
                           "Set it up to promote with a letter - Change Role Now still works", "missing", True,
                           {"action": "setUp", "target": {"entityId": eid, "section": "promotion", "rowKey": rk,
                                                          "column": "letter"}}))
    else:
        lines.append(_setting_line(db, "letter", letter, eid, (wt, c, r)))
    duties, questions = None, []
    if role is not None:
        text, v = resolve_duties(role, duty_ctx(eid, wt, c, r, et))
        placement = view.placement(letter, "promotion")[0]
        jd = role_jd_doc(role) if placement == "page" else ""
        fix = None
        if letter is not None and not hle.is_documents(letter):
            line = (f"{role.name} - What You Type Below", "Printed Where The Letter Asks For It", "same")
        elif letter is not None and placement == "none":
            line = ("Not In This Letter", "This Promotion Letter Does Not Print Them", "same")
        elif jd:
            line = (f"{role.name} - {view.name(jd)}", "Its Own Page", "own")
        elif v is not None and text.strip():
            line = (f"{role.name} - {_version_short(db, v)} Version", f"Only For {_version_for(db, v)}", "own")
        elif text.strip():
            line = (f"{role.name} - Standard", "Same For Everyone", "same")
        else:
            line = (f"{role.name} - no duties written", "Add them to the role, or type them below for this letter",
                    "missing")
            fix = {"action": "addDuties", "target": {"entityId": eid, "section": "promotion", "roleId": role.id}}
        lines.append(_line("jd", "New Role's Job Description", *line, False, fix))
        duties = {"roleId": role.id, "text": text, "versionId": v["id"] if v else "",
                  "versionLabel": version_label(db, v) if v else "", "placement": placement}
    if letter is not None:
        lines.append(_signs_line(view, letter))
        if hle.is_documents(letter):
            pw = hle.role_paperwork(role)
            ids = hpd.template_ids_for(letter, {"role_id": role.id if role is not None else "",
                                                "department": (role.department if role is not None else "") or emp.department or "",
                                                "role_docs": pw["role_docs"], "role_description": (duties or {}).get("text", "")},
                                       "promotion")
            questions = hpd.hr_questions(hpd.load_snaps(db, ids)[0])
    return {"rowKey": rk, "kind": what,
            "letter": {"settingId": letter.id, "name": letter.name or "", "engine": letter.engine or "pdf"} if letter else None,
            "whatTheyGet": lines,
            "blocked": "" if letter is not None else "Set up a promotion letter first, or use Change Role Now.",
            "duties": duties, "hrQuestions": questions}


def offboard_options(db: Session, emp) -> dict:
    """The Offboard form's What They Get card. Nothing blocks: without a
    separation package the offboarding runs, without documents."""
    eid = emp.company or ""
    c, r = hle.employee_place(db, emp)
    wt = hle.worker_type_of(emp.employment_type)
    rk, what = row_key(wt, c, r), kind(wt, c, r)
    package = hle.resolve_for_employee(db, emp, "separation", hle.role_id_for_employee(db, emp))
    if package is None:
        return {"rowKey": rk, "kind": what, "package": None, "canSendPackage": False,
                "noPackageText": f"No separation package is set up for {what} yet - the offboarding still runs, "
                                 f"without documents.",
                "whatTheyGet": [_line("package", "Separation Package", f"Nothing Yet For {what}",
                                      "The offboarding still runs, without documents", "missing", False,
                                      {"action": "setUp", "target": {"entityId": eid, "section": "offboarding",
                                                                     "rowKey": rk, "column": "package"}})],
                "hrQuestions": []}
    view = View(db, eid, grid=False, section="offboarding")
    questions = []
    if hle.is_documents(package):
        ids = hpd.template_ids_for(package, {"department": emp.department or ""}, "separation")
        questions = [q for q in hpd.hr_questions(hpd.load_snaps(db, ids)[0]) if not q["pay"]]
    return {"rowKey": rk, "kind": what,
            "package": {"settingId": package.id, "name": package.name or "", "engine": package.engine or "pdf"},
            "canSendPackage": True, "noPackageText": "",
            "whatTheyGet": [_setting_line(db, "package", package, eid, (wt, c, r)), _signs_line(view, package)],
            "hrQuestions": questions}
