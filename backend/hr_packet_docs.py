"""HR packets built from the Documents module (Neil, Oct 14).

    "We add the documents on the document module, and then ... create packages,
    so it pulls from the document module and it pulls in the appropriate
    documents, but it uses variables like employee's name, employee's number
    ... The flow should be based on role and not based on person."

A documents packet (HrPacketSetting.engine == 'documents') is:

  - an ordered list of Documents templates (doc_template_ids), read at their
    PUBLISHED version - an edit someone is still typing never reaches a packet;
  - a signing order by ROLE (flow = [{key, role, action}]): `key` is the signer
    key the templates' signature blocks name, `role` is one of the checklist
    roles (hr_checklists.ROLES - the same vocabulary and the same resolver as
    the onboarding / offboarding checklists) or the packet-only `signatory`
    (the company's authorized signatory) and `sender`, and `action` is sign,
    approve or copy;
  - a verifier role: the person that role resolves to checks every generated
    document before anything goes out for signature.

Pay is salary data. A template can print pay under any variable name, so what
counts as pay is decided fail-closed (is_pay_token), hire and promotion
packets are treated as printing pay by default (pay_mode), pay values are
never written onto a document row (they are merged in at render time), and
everyone who would see a pay-printing document must hold Pay & Benefits.
"""
import hashlib
import json
import re
from types import SimpleNamespace
from typing import Optional

from sqlalchemy.orm import Session

import hr_checklists as hc
from models import DocLetterhead, DocTemplate, Document, HrEntity, HrPacketSetting, NexusEmployee

# ── vocabulary ───────────────────────────────────────────────────────────────

SUBJECT_ROLE = "employee"
FLOW_ROLES = hc.ROLES + ("signatory", "sender")
ROLE_LABELS = {**hc.ROLE_LABELS, "employee": "The Person", "signatory": "Authorized Signatory",
               "sender": "Whoever Starts It"}
ACTIONS = {"sign": "signer", "approve": "approver", "copy": "cc"}
ACTION_LABELS = {"sign": "Signs", "approve": "Approves", "copy": "Gets A Copy"}
VERIFY_ROLES = tuple(r for r in FLOW_ROLES if r not in (SUBJECT_ROLE, "sender"))
PAY_MODES = ("", "always", "auto")
EVENT_NOUN = {"hire": "hiring packet", "promotion": "promotion letter", "separation": "separation package"}


class PacketProblem(ValueError):
    """Something about a packet that stops it, with the message HR reads."""


def role_label(role: str) -> str:
    return ROLE_LABELS.get(role, role.replace("_", " ").title())


def default_role(key: str, prints_signatory: bool = False) -> str:
    """A sensible role for a signer key when HR adds a document - HR can change it."""
    k = (key or "").lower()
    if k in ("employee", "candidate", "new_hire", "person", "recipient"):
        return SUBJECT_ROLE
    if k in ("signatory", "authorized_signatory"):
        return "signatory"
    if k in ("company", "company_representative", "employer"):
        return "signatory" if prints_signatory else "hr"
    if k in ("manager", "supervisor"):
        return "manager"
    if k in hc.ROLES:
        return k
    return "hr"


def clean_flow(flow) -> list:
    """[{key, role, action}] with keys normalized and de-duplicated, in order."""
    out, seen = [], set()
    for step in flow or []:
        if not isinstance(step, dict):
            continue
        key = re.sub(r"[^a-z0-9_]", "", str(step.get("key") or "").strip().lower())[:40]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "role": str(step.get("role") or "").strip().lower(),
                    "action": str(step.get("action") or "sign").strip().lower()})
    return out


# ── the templates a packet prints ────────────────────────────────────────────

_TOKEN_RE = re.compile(r"\{\{\s*([a-z0-9_]+(?:\.[a-z0-9_]+)*)\s*\}\}")


def content_tokens(content) -> set:
    """Every {{variable}} the content prints - merge-field chips, typed
    {{tokens}}, and signature-block captions - body, header and footer."""
    found = set()

    def walk(node):
        if isinstance(node, dict):
            t = node.get("type")
            if t == "mergeField":
                token = (node.get("attrs") or {}).get("token") or ""
                if token:
                    found.add(token)
            elif t == "signatureBlock":
                found.update(_TOKEN_RE.findall(str((node.get("attrs") or {}).get("label") or "")))
            text = node.get("text")
            if isinstance(text, str):
                found.update(_TOKEN_RE.findall(text))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(content if isinstance(content, dict) else {})
    return found


class Snap:
    """One template of a packet, as its published version reads."""

    def __init__(self, tpl: DocTemplate, content: dict, meta: dict, version: int):
        from routers.documents import signature_roles
        self.tpl, self.content, self.meta, self.version = tpl, content, meta or {}, version
        self.field_defs = [fd for fd in (self.meta.get("fieldDefs") or []) if isinstance(fd, dict)]
        self.defs = {fd.get("token"): fd for fd in self.field_defs}
        self.tokens = content_tokens(content)
        self.signature_roles = signature_roles(content)

    @property
    def name(self) -> str:
        return self.tpl.name

    def as_template(self):
        """What `template.*` variables read: the PUBLISHED version, not the
        version someone is editing now."""
        t = self.tpl
        return SimpleNamespace(name=t.name, version=self.version, department=t.department or "",
                               updated_at=t.published_at or t.updated_at, created_at=t.created_at)


def load_snaps(db: Session, template_ids: list) -> tuple:
    """(snaps, problems) for the templates, in order. A template that is
    missing, not active or never published is a problem, never empty output."""
    from routers.documents import TemplateNotPublished, published_snapshot
    snaps, problems = [], []
    for tid in template_ids or []:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
        if not tpl:
            problems.append("A document in this packet no longer exists in Documents - remove it from the packet.")
            continue
        if tpl.status != "active":
            problems.append(f'"{tpl.name}" is {tpl.status} in Documents - activate it, or take it out of the packet.')
            continue
        try:
            content, meta, version = published_snapshot(db, tpl)
        except TemplateNotPublished as e:
            problems.append(str(e))
            continue
        snaps.append(Snap(tpl, content, meta, version))
    return snaps, problems


# ── pay ──────────────────────────────────────────────────────────────────────

PAY_NAMES = {"salary", "old_salary", "new_salary", "old_pay", "new_pay", "pay"}
PAY_WORDS = {"salary", "salaries", "wage", "wages", "pay", "rate", "rates", "bonus", "compensation",
             "comp", "ctc", "stipend", "commission", "allowance", "incentive", "equity", "esop",
             "stock", "hourly", "overtime", "remuneration", "earnings"}


def is_pay_token(token: str, defs: Optional[dict] = None) -> bool:
    """Fail closed: a built-in pay name, a field marked Pay (Restricted) or of
    type currency, or ANY part of the name that is a pay word - whatever its
    type, with or without a field definition. Over-matching only means a
    value is kept restricted; under-matching would leak a salary."""
    t = (token or "").strip().lower()
    if not t:
        return False
    if t in PAY_NAMES:
        return True
    fd = (defs or {}).get(t) or {}
    if fd.get("pay") or fd.get("type") == "currency":
        return True
    return any(part in PAY_WORDS for part in re.split(r"[._]", t))


def pay_tokens(snaps: list) -> set:
    return {t for s in snaps for t in s.tokens if is_pay_token(t, s.defs)}


def _mode(setting: HrPacketSetting) -> str:
    m = (setting.pay_mode or "").strip()
    if m:
        return m
    return "always" if setting.event in ("hire", "promotion") else "auto"


def doc_prints_pay(setting: HrPacketSetting, snap: Snap) -> bool:
    if _mode(setting) == "always":
        return True
    return any(is_pay_token(t, snap.defs) for t in snap.tokens)


def packet_prints_pay(setting: HrPacketSetting, snaps: list) -> bool:
    return _mode(setting) == "always" or bool(pay_tokens(snaps))


def has_comp_for(db: Session, email: str) -> bool:
    """Pay & Benefits as `email` would have it signed in: the same level (the
    same role cache get_current_user reads) and the same _has_comp, so the
    team-tier rule ("a manager never sees pay") and the owner bypass apply
    exactly as they do to a request. External people never have it."""
    from auth import _role_for
    from routers.hr import _has_comp
    e = (email or "").strip().lower()
    if not e:
        return False
    role, level = _role_for(e, db)
    return _has_comp({"email": e, "level": level, "role": role}, db)


def pay_text(pay: dict) -> str:
    import hr_life_events as hle
    return hle.pay_text(pay or {})


def pay_merge(pay: Optional[dict], pay_values: Optional[dict]) -> dict:
    """The pay variables: what HR typed per pay variable, and {{salary}}
    falling back to the structured pay ("$85,000.00 per year"). Never indexes
    into the pay dict, so structured-only, text-only and none all work."""
    out = {k: str(v).strip() for k, v in (pay_values or {}).items() if str(v or "").strip()}
    if not out.get("salary"):
        text = pay_text(pay or {})
        if text:
            out["salary"] = text
    return out


# ── people ───────────────────────────────────────────────────────────────────

def person(db: Session, email: str) -> Optional[NexusEmployee]:
    e = (email or "").strip().lower()
    return db.query(NexusEmployee).filter(NexusEmployee.work_email == e).first() if e else None


def name_of(db: Session, email: str) -> str:
    p = person(db, email)
    if p:
        return (p.display_name or f"{p.first_name} {p.last_name}").strip()
    return (email or "").split("@")[0].replace(".", " ").title()


def resolve_role(db: Session, role: str, ctx: dict) -> str:
    """The email a flow role resolves to for this packet - '' when nobody holds
    it. Every role the checklists also use goes through the checklists' own
    resolver (hr_checklists.resolve_owner), so "HR", "Payroll", "IT" mean the
    same person for a signature and for a checklist step."""
    if role == SUBJECT_ROLE:
        return (ctx.get("subject_email") or "").strip().lower()
    if role == "sender":
        return (ctx.get("sender") or "").strip().lower()
    if role == "signatory":
        ent = ctx.get("entity")
        return ((getattr(ent, "signatory_email", "") if ent else "") or "").strip().lower()
    if role == "manager":
        return (ctx.get("manager_email") or "").strip().lower()
    return (hc.resolve_owner(db, role, None, ctx.get("owners") or {}, ctx.get("entity")) or "").strip().lower()


def role_holders(db: Session, entity: Optional[HrEntity]) -> dict:
    """{role: {email, name}} for the company today - the editor shows it next
    to each step ("HR - today: Charmi Shah")."""
    owners = hc.role_owners(db, entity.id if entity else "")
    ctx = {"entity": entity, "owners": owners}
    out = {}
    for role in FLOW_ROLES:
        if role in (SUBJECT_ROLE, "sender", "manager"):
            continue
        email = resolve_role(db, role, ctx)
        out[role] = {"email": email, "name": name_of(db, email) if email else ""}
    return out


def build_parties(db: Session, setting: HrPacketSetting, ctx: dict) -> tuple:
    """(parties, remap, problems) for the packet's flow. Each party:
    {key, role, action, email, name, title, kind, ordinal, partyRole}.

    Two CONSECUTIVE sign steps that land on the same person collapse into one
    party (their second key's fields are re-pointed with `remap`), so one
    signature covers both blocks. Order is otherwise kept exactly."""
    problems, rows = [], []
    subject = (ctx.get("subject_email") or "").strip().lower()
    subject_alts = {subject} | {(e or "").strip().lower() for e in ctx.get("subject_emails") or []}
    for step in clean_flow(setting.flow):
        role, action, key = step["role"], step["action"], step["key"]
        label = role_label(role)
        email = resolve_role(db, role, ctx)
        if not email:
            problems.append(_nobody(role, ctx))
            continue
        if role == SUBJECT_ROLE:
            name = ctx.get("subject_name") or email
            kind, title = ctx.get("subject_kind") or "external", ""
        else:
            p = person(db, email)
            if not p or (p.status or "") not in ("active", "onboarding"):
                problems.append(f"{label} is {email}, who is not an active person in Nexus People - "
                                f"set who holds {label} for this company.")
                continue
            if email in subject_alts:
                problems.append(f"{label} is {ctx.get('subject_name') or email} - the person this packet is about "
                                f"cannot also act for the company. Set someone else as {label}.")
                continue
            name = (p.display_name or f"{p.first_name} {p.last_name}").strip()
            kind, title = "internal", p.job_title or ""
        rows.append({"key": key, "role": role, "action": action, "email": email, "name": name,
                     "title": title, "kind": kind, "partyRole": ACTIONS.get(action, "signer")})
    parties, remap = [], {}
    for r in rows:
        last = parties[-1] if parties else None
        if (last and r["action"] == "sign" and last["action"] == "sign" and last["email"] == r["email"]):
            remap[r["key"]] = last["key"]
            continue
        parties.append(r)
    for i, p in enumerate(parties):
        p["ordinal"] = i + 1
    return parties, remap, problems


def _nobody(role: str, ctx: dict) -> str:
    company = getattr(ctx.get("entity"), "name", "") or "this company"
    if role == SUBJECT_ROLE:
        return f"{ctx.get('subject_name') or 'The person'} has no email to send it to."
    if role == "hr":
        return (f"{company} has no HR contact - set one in People > Companies, or HR in "
                f"People > Checklists > Checklist Owners.")
    if role == "manager":
        return "No manager - pick the supervisor (or set their manager in People) first."
    if role == "signatory":
        return f"{company} has no Authorized Signatory person - pick one in People > Companies."
    if role == "sender":
        return "Nobody started this packet."
    return (f"No {role_label(role)} owner for {company} - set one in People > Checklists > "
            f"Checklist Owners.")


def signer_values(parties: list, remap: dict) -> dict:
    """{{signer.<key>}} / {{signer.<key>.title}} - the name (and title) of
    whoever the flow puts in that signer slot, so "Sincerely, {{signer.company}}"
    always prints the person who actually signs."""
    by_key = {p["key"]: p for p in parties}
    out = {}
    for key, target in list(remap.items()) + [(k, k) for k in by_key]:
        p = by_key.get(target)
        if p:
            out[f"signer.{key}"] = p["name"]
            if p.get("title"):
                out[f"signer.{key}.title"] = p["title"]
    return out


def pay_exposure(db: Session, parties: list, prints_pay: bool) -> list:
    """Blocking problems: on a packet that prints pay, everyone but the person
    themself sees it - approvers and signers open it, and the sealed PDF is
    mailed to every party at completion - so each must hold Pay & Benefits."""
    if not prints_pay:
        return []
    out = []
    for p in parties:
        if p["role"] == SUBJECT_ROLE:
            continue
        if not has_comp_for(db, p["email"]):
            what = {"copy": "would receive a copy of", "approve": "approves", "sign": "signs"}.get(p["action"], "sees")
            out.append(f"{p['name']} ({role_label(p['role'])}) {what} documents that show pay but has no "
                       f"Pay & Benefits access - give them access or change that step.")
    return out


# ── configuration problems ───────────────────────────────────────────────────

def config_problems(db: Session, setting: HrPacketSetting, snaps: Optional[list] = None,
                    snap_problems: Optional[list] = None) -> list:
    """Why this packet could not be sent, as HR reads it - shown in the editor
    and enforced at save and at send."""
    if snaps is None:
        snaps, snap_problems = load_snaps(db, setting.doc_template_ids or [])
    out = []
    if not (setting.name or "").strip():
        out.append("Give the packet a name.")
    if not (setting.doc_template_ids or []):
        out.append("Add at least one document from Documents > Templates.")
    out += list(snap_problems or [])
    flow = clean_flow(setting.flow)
    by_key = {s["key"]: s for s in flow}
    for step in flow:
        if step["role"] not in FLOW_ROLES:
            out.append(f'"{step["key"]}" has no valid role - pick who signs as it.')
        if step["action"] not in ACTIONS:
            out.append(f'"{step["key"]}" must sign, approve or get a copy.')
    subjects = [s for s in flow if s["role"] == SUBJECT_ROLE]
    if len(subjects) != 1:
        out.append("Exactly one step must be The Person (the one the packet is about).")
    elif subjects[0]["action"] != "sign":
        out.append("The Person must sign the packet.")
    elif setting.event in ("hire", "separation"):
        signs = [s for s in flow if s["action"] == "sign"]
        if signs and signs[-1]["role"] != SUBJECT_ROLE:
            out.append("The Person signs last on a hiring packet or a separation package - "
                       "move their step to the end of the signing order.")
    if (setting.verify_role or "hr") not in VERIFY_ROLES:
        out.append("Verified By must be a role such as HR - not The Person or whoever starts it.")
    if (setting.pay_mode or "") not in PAY_MODES:
        out.append("Pay must be By Event, Always or Only Where A Document Prints It.")
    for snap in snaps:
        for key in sorted(snap.signature_roles):
            step = by_key.get(key)
            if step is None:
                out.append(f'"{snap.name}" has a signature block for "{key}", but nobody in the signing '
                           f'order signs as "{key}" - add a step for it.')
            elif step["action"] != "sign":
                out.append(f'"{snap.name}" has a signature block for "{key}", but that step '
                           f'{ACTION_LABELS.get(step["action"], "does not sign").lower()} - make it Signs.')
        # The name printed over a signature is the person who signs it: a
        # letter closing "Sincerely, {{signatory}}" must be signed by the
        # authorized signatory, not by HR (s4.3 of the plan).
        if "signatory" in snap.tokens:
            if not any((by_key.get(k) or {}).get("role") == "signatory" for k in snap.signature_roles):
                out.append(f'"{snap.name}" prints the authorized signatory ({{{{signatory}}}}) but nobody signs it as '
                           f'Authorized Signatory - set the company step to Authorized Signatory, or write '
                           f'{{{{signer.company}}}} in the template instead.')
        if (snap.meta.get("requiresLetterhead") and not (setting.entity_id or "")):
            out.append(f'"{snap.name}" prints a fixed letterhead, but this packet is for every company - make a '
                       f'packet per company and pick its letterhead, or use {{{{company}}}} in the template header.')
    blocks = {k for snap in snaps for k in snap.signature_roles}
    if snaps:
        for step in flow:
            if step["action"] != "sign" or step["key"] in blocks:
                continue
            if step["role"] == SUBJECT_ROLE:
                out.append(f'No document has a signature block for The Person ("{step["key"]}") - add one in Documents.')
            else:
                out.append(f'{role_label(step["role"])} signs as "{step["key"]}", but no document has a signature '
                           f'block for "{step["key"]}" - add one in Documents, or make the step Approves or Gets A Copy.')
    return list(dict.fromkeys(out))


# ── what a document prints ───────────────────────────────────────────────────

_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _clock(hhmm: str) -> str:
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", (hhmm or "").strip())
    if not m:
        return ""
    h = int(m.group(1))
    return f"{h % 12 or 12}:{m.group(2)} {'PM' if h >= 12 else 'AM'}"


def timings(inputs: dict) -> dict:
    """Timings (one of the Four Options) as letters print them: 12-hour
    hours, a day range, and the two together - or what HR typed."""
    text = (inputs.get("timings_text") or "").strip()[:200]
    start, end = _clock(inputs.get("work_start") or ""), _clock(inputs.get("work_end") or "")
    hours = f"{start} - {end}" if start and end else ""
    picked = [d for d in _DAY_KEYS if d in [str(x).lower()[:3] for x in (inputs.get("work_days") or [])]]
    if picked:
        idx = [_DAY_KEYS.index(d) for d in picked]
        if len(idx) > 2 and idx == list(range(idx[0], idx[-1] + 1)):
            days = f"{_DAY_NAMES[idx[0]]} - {_DAY_NAMES[idx[-1]]}"
        else:
            days = ", ".join(_DAY_NAMES[i] for i in idx)
    else:
        days = ""
    schedule = text or ", ".join(x for x in (hours, days) if x)
    out = {}
    if hours:
        out["work_hours"] = hours
    if days:
        out["work_days"] = days
    if schedule:
        out["work_schedule"] = schedule
    return out


def document_letterhead(db: Session, setting: HrPacketSetting, snap: Snap) -> str:
    """The letterhead a packet document prints: none unless the template
    requires one; then the packet's (picked for its company), else the
    template's, else the default."""
    if not snap.meta.get("requiresLetterhead"):
        return ""
    if setting.letterhead_id:
        return setting.letterhead_id
    if snap.meta.get("letterheadId"):
        return snap.meta["letterheadId"]
    lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    return lh.id if lh else ""


def full_merge(db: Session, snap: Snap, *, employee_id: str = "", candidate_id: str = "",
               entity_id: str = "", overrides: dict, pay: Optional[dict] = None) -> dict:
    """What a packet document prints, through the same resolver and print
    pass as Documents' own export: person / company / template -> the
    non-pay values -> pay (merged at render time only)."""
    from routers.documents import display_merge
    from services.merge_fields import resolve_merge_data
    values = dict(overrides or {})
    if pay:
        values.update(pay)
    merge = resolve_merge_data(db, employee_id=employee_id, candidate_id=candidate_id,
                               entity_id=entity_id, overrides=values, template=snap.as_template())
    return display_merge(merge, snap.field_defs)


def unresolved(snap: Snap, merge: dict) -> list:
    return sorted(t for t in snap.tokens if t != "today" and not t.startswith("template.") and t not in merge)


def render(db: Session, snap: Snap, *, title: str, letterhead_id: str, merge: dict,
           employee_id: str = "", entity_id: str = "", anchors: Optional[list] = None) -> bytes:
    """The PDF of a packet document. A transient Document is used for the
    render and never added to the session - previews write nothing."""
    from routers.documents import render_document
    row = Document(id="preview", title=title, content=snap.content, letterhead_id=letterhead_id or "",
                   employee_id=employee_id or "", entity_id=entity_id or "", merge_overrides={})
    return render_document(db, row, merge, anchors=anchors)


def values_hash(values: dict) -> str:
    return hashlib.sha256(json.dumps(values or {}, sort_keys=True, default=str).encode()).hexdigest()


# ── serialization for the packet screens ────────────────────────────────────

def ser_flow(db: Session, setting: HrPacketSetting) -> list:
    return [{**s, "roleLabel": role_label(s["role"]), "actionLabel": ACTION_LABELS.get(s["action"], s["action"])}
            for s in clean_flow(setting.flow)]


def ser_documents(db: Session, setting: HrPacketSetting) -> list:
    out = []
    for tid in setting.doc_template_ids or []:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
        if not tpl:
            out.append({"id": tid, "name": "A template that no longer exists", "missing": True})
            continue
        from routers.documents import signature_roles
        out.append({"id": tpl.id, "name": tpl.name, "status": tpl.status,
                    "publishedVersion": tpl.published_version or 0,
                    "hasUnpublishedChanges": bool(tpl.published_version) and (
                        (tpl.version or 0) > tpl.published_version),
                    "signs": sorted(signature_roles(tpl.content))})
    return out


# ── planning: everything a packet would do, without doing it ────────────────

def event_values(db: Session, kind: str, d: dict) -> dict:
    """The non-pay variables an event fills, from what HR picked. Dates stay
    ISO here - the print pass formats them (MM/DD/YYYY)."""
    out = {}
    if kind == "hire":
        out.update({"job_title": d.get("job_title", ""), "department": d.get("department", ""),
                    "start_date": d.get("start_date", ""), "offer_expires": d.get("offer_expires", ""),
                    "employment_type": (d.get("employment_type") or "full_time").replace("_", "-").title()})
        if d.get("manager_email"):
            out["manager"] = out["supervisor"] = name_of(db, d["manager_email"])
        if d.get("employee_code"):
            out["employee_code"] = d["employee_code"]
    elif kind == "promotion":
        import hr_life_events as hle
        out.update({"change_type": hle.CHANGE_TYPES.get(d.get("change_type"), "Promotion").lower(),
                    "old_title": d.get("old_title", ""), "new_title": d.get("job_title", ""),
                    "job_title": d.get("job_title", ""), "old_role": d.get("old_role_name") or d.get("old_title", ""),
                    "new_role": d.get("role_name", ""), "department": d.get("department", ""),
                    "effective_date": d.get("effective_date", ""),
                    "responsibilities": d.get("responsibilities", "")})
        if d.get("manager_email"):
            out["manager"] = name_of(db, d["manager_email"])
    elif kind == "separation":
        import hr_life_events as hle
        out.update({"last_day": d.get("last_day", ""),
                    "separation_type": hle.SEPARATION_TYPES.get(d.get("exit_type"), ""),
                    "job_title": d.get("job_title", ""), "department": d.get("department", "")})
    out.update(timings(d))
    return {k: str(v) for k, v in out.items() if str(v or "").strip()}


def plan(db: Session, setting: HrPacketSetting, *, ctx: dict, overrides: dict, pay: Optional[dict],
         can_see_pay: bool, employee_id: str = "", candidate_id: str = "", entity_id: str = "",
         extra_template_ids: Optional[list] = None) -> dict:
    """The packet as it would go out: its documents (with what is still
    unfilled in each), the signing order with real names, the verifier, and
    every problem. Writes nothing."""
    ids = list(setting.doc_template_ids or [])
    ids += [t for t in (extra_template_ids or []) if t and t not in ids]
    snaps, snap_problems = load_snaps(db, ids)
    problems = config_problems(db, setting, snaps, snap_problems)
    parties, remap, party_problems = build_parties(db, setting, ctx)
    problems += party_problems
    prints = packet_prints_pay(setting, snaps)
    vrole = ctx.get("verifier_role") or setting.verify_role or "hr"
    vemail = resolve_role(db, vrole, ctx)
    if not vemail:
        problems.append(f"Nobody holds {role_label(vrole)} to verify this packet - {_nobody(vrole, ctx)}")
    elif prints and not has_comp_for(db, vemail):
        problems.append(f"{name_of(db, vemail)} verifies this packet ({role_label(vrole)}) but cannot see pay - "
                        f"give them Pay & Benefits access or change Verified By.")
    problems += pay_exposure(db, parties, prints)
    values = {**(overrides or {}), **signer_values(parties, remap)}
    pay_values = pay_merge(pay, ctx.get("pay_values")) if can_see_pay else {}
    docs = []
    for snap in snaps:
        merge = full_merge(db, snap, employee_id=employee_id, candidate_id=candidate_id, entity_id=entity_id,
                           overrides=values, pay=pay_values)
        if not can_see_pay:
            # A preview for someone without pay access prints [Pay] - the
            # real figure is only ever rendered for Pay & Benefits holders.
            for t in snap.tokens:
                if is_pay_token(t, snap.defs) and t not in merge:
                    merge[t] = "[Pay]"
        docs.append({"templateId": snap.tpl.id, "name": snap.name, "version": snap.version,
                     "printsPay": doc_prints_pay(setting, snap), "signs": sorted(snap.signature_roles),
                     "unresolved": unresolved(snap, merge)})
    return {"snaps": snaps, "problems": list(dict.fromkeys(problems)), "parties": parties, "remap": remap,
            "values": values, "printsPay": prints, "documents": docs,
            "verifier": {"role": vrole, "roleLabel": role_label(vrole), "email": vemail,
                         "name": name_of(db, vemail) if vemail else ""},
            "recipients": [{"order": p["ordinal"], "key": p["key"], "role": p["role"], "roleLabel": role_label(p["role"]),
                            "action": p["action"], "actionLabel": ACTION_LABELS.get(p["action"], p["action"]),
                            "name": p["name"], "email": p["email"], "isSubject": p["role"] == SUBJECT_ROLE}
                           for p in parties]}
