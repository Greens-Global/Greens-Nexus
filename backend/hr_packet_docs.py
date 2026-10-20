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

Two packet features from Oct 14 (Pranshu):

  - the Details Form (details_form): fields the packet asks for beyond name,
    phone, address and emergency contact - any country, any field. Each is a
    {{variable}} the templates print. A field marked Sensitive travels exactly
    like pay (Pay & Benefits only, never written on a document row); a field
    marked Last 4 Only is kept - and printed - as its last four characters.
  - Signs Once (a flow step with `once`): the company signs a packet ONCE and
    that adopted signature is applied to every packet sent after it. It
    belongs to whoever holds the step's role for the company: when the HR
    contact (or the signatory) changes, the old one stops counting and the
    new holder signs once before the next packet can go.
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
# Who can Sign Once: a role the COMPANY holds. The person, their manager and
# whoever starts it change from packet to packet, so a signature adopted once
# would be signed by the wrong person.
ONCE_ROLES = tuple(r for r in FLOW_ROLES if r not in (SUBJECT_ROLE, "manager", "sender"))
PAY_MODES = ("", "always", "auto")
EVENT_NOUN = {"offer": "offer letter", "hire": "hiring packet", "promotion": "promotion letter",
              "separation": "separation package"}
CANDIDATE_KINDS = ("offer", "hire")


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
    if hc.norm_role(k) in hc.ROLES:
        return hc.norm_role(k)
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
        # Payroll / Finance / Equipment became Accounting / IT (Neil, Oct 19).
        row = {"key": key, "role": hc.norm_role(str(step.get("role") or "")),
               "action": str(step.get("action") or "sign").strip().lower()}
        if step.get("once"):
            row["once"] = True
        out.append(row)
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
             "stock", "hourly", "overtime", "remuneration", "earnings",
             # A contractor's pay is a fee (Neil, Oct 14: "what is your monthly
             # contractual fee?") - fail closed on it too.
             "fee", "fees", "payment", "payments", "retainer", "honorarium"}


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
    return "always" if setting.event in ("offer", "hire", "promotion") else "auto"


def doc_prints_pay(setting: HrPacketSetting, snap: Snap) -> bool:
    """Pay & Benefits only: a document printing pay - or a Sensitive answer
    from the packet's Details Form or the template's own Ask The Person
    variables (a bank account, an ID number)."""
    if _mode(setting) == "always":
        return True
    return (any(is_pay_token(t, snap.defs) for t in snap.tokens)
            or bool((sensitive_keys(setting) | snap_sensitive(snap)) & snap.tokens))


def packet_prints_pay(setting: HrPacketSetting, snaps: list) -> bool:
    return (_mode(setting) == "always" or bool(pay_tokens(snaps))
            or any((sensitive_keys(setting) | snap_sensitive(s)) & s.tokens for s in snaps))


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
    # An empty value is kept: an optional Sensitive answer left blank prints
    # blank (full_merge), never as an unfilled detail.
    out = {k: str(v if v is not None else "").strip() for k, v in (pay_values or {}).items()}
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
                     "title": title, "kind": kind, "partyRole": ACTIONS.get(action, "signer"),
                     "once": bool(step.get("once"))})
    parties, remap = [], {}
    for r in rows:
        last = parties[-1] if parties else None
        if (last and r["action"] == "sign" and last["action"] == "sign" and last["email"] == r["email"]
                and not r["once"] and not last["once"]):
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
                f"Company Settings > Checklists > Who Owns Each Role.")
    if role == "manager":
        return "No manager - pick the supervisor (or set their manager in People) first."
    if role == "signatory":
        return f"{company} has no Authorized Signatory person - pick one in People > Companies."
    if role == "sender":
        return "Nobody started this packet."
    return (f"No {role_label(role)} owner for {company} - set one in Company Settings > Checklists > "
            f"Who Owns Each Role.")


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
            # Blank when People has no job title - prints an empty line rather
            # than holding the packet back.
            out[f"signer.{key}.title"] = p.get("title") or ""
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
    elif setting.event in ("offer", "hire", "separation"):
        signs = [s for s in flow if s["action"] == "sign"]
        if signs and signs[-1]["role"] != SUBJECT_ROLE:
            out.append("The Person signs last on an offer letter, a hiring packet or a separation package - "
                       "move their step to the end of the signing order.")
    for step in flow:
        if not step.get("once"):
            continue
        if step["action"] != "sign":
            out.append(f'"{step["key"]}" is set to Signs Once, but only a step that signs can be.')
        elif step["role"] not in ONCE_ROLES:
            out.append(f'{role_label(step["role"])} changes from packet to packet, so it cannot Sign Once - '
                       f'only a company role such as HR or Authorized Signatory can.')
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
    # A variable's Default Value set in the template (Define Variable) prints
    # when nothing else fills it - the client's name, an office address: set
    # once in the template, never typed per hire. Never for pay.
    for fd in snap.field_defs:
        token, default = fd.get("token") or "", str(fd.get("default") or "").strip()
        if (token and default and not str(merge.get(token) or "").strip()
                and not is_pay_token(token, snap.defs)):
            merge[token] = default
    # A value given as deliberately empty (an optional Details Form answer
    # left blank, a signer with no job title) prints blank - the resolver
    # drops empty values, which would leave it "unfilled".
    for k, v in values.items():
        if v == "" and k not in merge:
            merge[k] = ""
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
    return [{**s, "roleLabel": role_label(s["role"]),
             "actionLabel": "Signs Once (Saved)" if s.get("once") else ACTION_LABELS.get(s["action"], s["action"])}
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
    if kind in CANDIDATE_KINDS:
        out.update({"job_title": d.get("job_title", ""), "department": d.get("department", ""),
                    "start_date": d.get("start_date", ""), "offer_expires": d.get("offer_expires", ""),
                    "employment_type": (d.get("employment_type") or "full_time").replace("_", "-").title(),
                    # What HR answered on the offer (Oct 14).
                    "worker_type": {"employee": "Employee", "contractor": "Independent Contractor"}.get(
                        d.get("worker_type") or "", ""),
                    "work_location": d.get("work_location", ""), "work_country": _country_name(d.get("country", ""))})
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


_COUNTRY_NAMES = {"US": "United States", "IN": "India", "CA": "Canada", "GB": "United Kingdom", "AE": "United Arab Emirates",
                  "PH": "Philippines", "MX": "Mexico", "AU": "Australia"}


def _country_name(code: str) -> str:
    code = (code or "").strip().upper()
    return _COUNTRY_NAMES.get(code, code)


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
    sign_once = once_status(setting, parties, ctx)     # a missing one blocks SENDING (event_plan), not starting
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
            hidden = sensitive_keys(setting) | snap_sensitive(snap)
            for t in snap.tokens:
                if is_pay_token(t, snap.defs) and t not in merge:
                    merge[t] = "[Pay]"
                elif t in hidden and t not in merge:
                    merge[t] = "[Restricted]"
        docs.append({"templateId": snap.tpl.id, "name": snap.name, "version": snap.version,
                     "printsPay": doc_prints_pay(setting, snap), "signs": sorted(snap.signature_roles),
                     "unresolved": unresolved(snap, merge)})
    return {"snaps": snaps, "problems": list(dict.fromkeys(problems)), "parties": parties, "remap": remap,
            "values": values, "printsPay": prints, "documents": docs,
            "verifier": {"role": vrole, "roleLabel": role_label(vrole), "email": vemail,
                         "name": name_of(db, vemail) if vemail else ""},
            "signOnce": sign_once,
            "recipients": [{"order": p["ordinal"], "key": p["key"], "role": p["role"], "roleLabel": role_label(p["role"]),
                            "action": p["action"],
                            "actionLabel": "Signs Once (Saved)" if p.get("once") else ACTION_LABELS.get(p["action"], p["action"]),
                            "name": p["name"], "email": p["email"], "isSubject": p["role"] == SUBJECT_ROLE,
                            "once": bool(p.get("once")), "savedAt": (p.get("saved") or {}).get("adoptedAt", "")}
                           for p in parties]}


# ── an event: generate, review, verify, send ────────────────────────────────
# The documents are generated the moment the details are in ("then it
# generates that hiring paperwork instantly"), checked by the verifier, and
# sent as ONE Nexus Sign envelope only by the verifier. Before send nothing
# is frozen: a template published meanwhile regenerates the unsent documents.
# From send on the PDFs in Nexus Sign are the record and never change.

OPEN_STATUSES = ("intake", "review")
PERSON_KEYS = ("first_name", "last_name", "preferred_name", "phone", "address", "permanent_address",
               "emergency_name", "emergency_relationship", "emergency_phone")


def event_setting(db: Session, ev) -> Optional[HrPacketSetting]:
    return db.query(HrPacketSetting).filter(HrPacketSetting.id == ev.setting_id).first() if ev.setting_id else None


def person_values(ev) -> dict:
    """The person's details as typed on the details form (HR) or the intake
    (the candidate) - the legal name prints, whatever the card said."""
    i = ev.intake or {}
    out = {k: str(i[k]).strip() for k in PERSON_KEYS if str(i.get(k) or "").strip()}
    if out.get("first_name") or out.get("last_name"):
        out["full_name"] = f"{out.get('first_name', '')} {out.get('last_name', '')}".strip()
    return out


def event_ctx(db: Session, ev, setting: HrPacketSetting, sender: str) -> dict:
    """Who each role is for THIS event, right now - read live, so a change of
    HR contact or Checklist Owner moves an unsent packet with it."""
    from models import HrCandidate
    entity = db.query(HrEntity).filter(HrEntity.id == ev.entity_id).first() if ev.entity_id else None
    d = ev.inputs or {}
    if ev.kind in CANDIDATE_KINDS:
        import hr_life_events as hle
        cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first()
        ctx = hle.hire_ctx(db, cand, d, entity, sender) if cand else {"entity": entity, "owners": {}}
        full = person_values(ev).get("full_name")
        if full:
            ctx["subject_name"] = full
    else:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).first()
        ctx = {"entity": entity, "owners": hc.role_owners(db, ev.entity_id or ""), "sender": (sender or "").lower(),
               "subject_email": (ev.subject_email or "").lower(),
               "subject_emails": [emp.work_email, emp.personal_email] if emp else [],
               "subject_name": ev.subject_name,
               "subject_kind": d.get("send_kind") or ("internal" if ev.kind == "promotion" else "external"),
               "manager_email": ((emp.manager_email if emp else "") or "").lower()}
    ctx["verifier_role"] = d.get("verifier_role") or ""
    # Sensitive Details Form answers ride with pay: merged in at render, only
    # ever for Pay & Benefits, never written onto a document row.
    ctx["pay_values"] = {**dict(ev.pay_values or {}), **answer_values(event_form(db, ev, setting), event_answers(ev))[1]}
    return ctx


def event_answers(ev) -> dict:
    return dict((ev.intake or {}).get("answers") or {})


def event_overrides(db: Session, ev) -> dict:
    """The non-pay values a packet's documents print for this event."""
    extra = {k: str(v) for k, v in ((ev.inputs or {}).get("extra") or {}).items() if str(v or "").strip()}
    setting = event_setting(db, ev)
    plain = answer_values(event_form(db, ev, setting), event_answers(ev))[0] if setting is not None else {}
    return {**event_values(db, ev.kind, ev.inputs or {}), **person_values(ev), **plain, **extra}


def event_pay(db: Session, ev, setting: Optional[HrPacketSetting] = None) -> dict:
    """What a render merges in at print time for Pay & Benefits holders: the
    pay, and the Sensitive answers of the packet's Details Form."""
    setting = setting if setting is not None else event_setting(db, ev)
    restricted = answer_values(event_form(db, ev, setting), event_answers(ev))[1] if setting is not None else {}
    return pay_merge(ev.pay or {}, {**dict(ev.pay_values or {}), **restricted})


def event_plan(db: Session, ev, setting: HrPacketSetting, *, sender: str, can_see_pay: bool) -> dict:
    form = event_form(db, ev, setting)
    p = plan(db, setting, ctx=event_ctx(db, ev, setting, sender), overrides=event_overrides(db, ev),
             pay=ev.pay or {}, can_see_pay=can_see_pay, employee_id=ev.employee_id or "",
             candidate_id=ev.candidate_id or "", entity_id=ev.entity_id or "",
             extra_template_ids=event_template_ids(ev, setting))
    # A changed Sensitive answer must still regenerate (and re-version) the
    # documents the verifier is looking at - its hash, never its value.
    p["restrictedHash"] = values_hash(answer_values(form, event_answers(ev))[1])
    p["form"] = form
    extra = []
    missing = missing_answers(form, event_answers(ev)) if ev.kind in ("hire", "offer") else []
    if missing:
        extra.append("Still needed on the Details Form: " + ", ".join(missing) + ".")
    for s in p["signOnce"]:
        if not s["signed"]:
            extra.append(f"{s['name']} ({s['roleLabel']}) signs this packet once before it can be sent - they open "
                         f"it and click Sign Once. After that their signature goes on every packet automatically.")
    p["problems"] = list(dict.fromkeys(p["problems"] + extra))
    return p


def _non_pay(values: dict, snaps: list) -> dict:
    """Never store pay on a document row - drop anything any template treats
    as pay, under whatever name."""
    defs = {}
    for s in snaps:
        defs.update(s.defs)
    return {k: v for k, v in (values or {}).items() if not is_pay_token(k, defs)}


def outdated(db: Session, ev, p: dict) -> dict:
    """{documentId: True} for each generated document that no longer matches
    what the packet would generate now (a template PUBLISHED since, a changed
    value, a changed signer). A pure read - nothing is written."""
    want = {s.tpl.id: s for s in p["snaps"]}
    h = values_hash({**_non_pay(p["values"], p["snaps"]), "__restricted": p.get("restrictedHash", "")})
    out = {}
    for e in ev.documents or []:
        snap = want.get(e.get("templateId"))
        out[e["documentId"]] = (snap is None or e.get("templateVersion") != snap.version
                                or e.get("valuesHash") != h)
    if set(want) - {e.get("templateId") for e in ev.documents or []}:
        out["__new__"] = True
    return out


def sync_documents(db: Session, ev, setting: HrPacketSetting, p: dict, by: str) -> bool:
    """Create or regenerate the event's Document rows to match `p`, and archive
    the ones whose template left the packet. Idempotent: run twice in a row,
    the second run changes nothing. Returns whether anything changed. The
    caller holds the event row lock and commits."""
    import uuid
    from datetime import datetime, timezone
    from models import DocumentVersion
    now = datetime.now(timezone.utc).isoformat()
    values = _non_pay(p["values"], p["snaps"])
    h = values_hash({**values, "__restricted": p.get("restrictedHash", "")})
    existing = {e.get("templateId"): e for e in ev.documents or []}
    changed, out = False, []
    for snap in p["snaps"]:
        lh = document_letterhead(db, setting, snap)
        e = existing.get(snap.tpl.id)
        row = db.query(Document).filter(Document.id == e["documentId"]).first() if e else None
        title = f"{snap.name} - {ev.subject_name}".strip(" -")
        if row is None:
            row = Document(id=str(uuid.uuid4()), title=title, folder_id="", template_id=snap.tpl.id,
                           template_version=snap.version, content=snap.content, letterhead_id=lh,
                           status="final", employee_id=ev.employee_id or "", candidate_id=ev.candidate_id or "",
                           entity_id=ev.entity_id or "", merge_overrides=values, owner_email=(by or "").lower(),
                           tags=[], current_version=1, source="hr-packet", life_event_id=ev.id,
                           created_by=by, created_at=now, updated_by=by, updated_at=now)
            db.add(row)
            db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=1, content=snap.content,
                                   edited_by=by, edited_at=now, note=f"Generated (template v{snap.version})"))
            changed = True
        elif (row.template_version != snap.version or (e or {}).get("valuesHash") != h
              or (row.letterhead_id or "") != lh or row.status == "archived"):
            row.content, row.template_version, row.merge_overrides = snap.content, snap.version, values
            row.letterhead_id, row.title, row.status = lh, title, "final"
            row.current_version = (row.current_version or 1) + 1
            row.updated_by, row.updated_at = by, now
            db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=row.current_version,
                                   content=snap.content, edited_by=by, edited_at=now,
                                   note=f"Regenerated (template v{snap.version})"))
            changed = True
        out.append({"documentId": row.id, "templateId": snap.tpl.id, "templateVersion": snap.version,
                    "valuesHash": h, "title": title, "version": row.current_version or 1})
    keep = {o["templateId"] for o in out}
    for tid, e in existing.items():
        if tid not in keep:
            row = db.query(Document).filter(Document.id == e["documentId"]).first()
            if row is not None and row.status != "archived":
                row.status, row.archived_at = "archived", now
                changed = True
    if changed or [o["documentId"] for o in out] != [e.get("documentId") for e in ev.documents or []]:
        ev.documents = out            # reassigned, never mutated in place (JSON column)
        changed = True
    return changed


def row_snap(db: Session, row: Document) -> Snap:
    """A generated document as a Snap: its own frozen content, with the field
    definitions its template published (date formats, reserved placeholders)."""
    tpl = db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
    meta = (tpl.published_meta or {}) if tpl is not None and tpl.published_version == row.template_version else {}
    stub = tpl or DocTemplate(id=row.template_id, name=row.title, department="", version=row.template_version)
    return Snap(stub, row.content or {}, meta, row.template_version or 0)


def render_row(db: Session, row: Document, pay: dict, anchors: Optional[list] = None) -> tuple:
    """(pdf, unresolved) for a generated document, pay merged in at render."""
    from routers.documents import render_document
    snap = row_snap(db, row)
    merge = full_merge(db, snap, employee_id=row.employee_id or "", candidate_id=row.candidate_id or "",
                       entity_id=row.entity_id or "", overrides=row.merge_overrides or {}, pay=pay)
    return render_document(db, row, merge, anchors=anchors), unresolved(snap, merge)


def status_at_send(parties: list, subject_email: str) -> str:
    """awaiting_sender while anyone acts before the person; sent only when the
    person is invited at once. Never derived from who clicked Send."""
    want = (subject_email or "").strip().lower()
    subj = next((p for p in parties if (p["email"] or "").lower() == want), None)
    if subj is None:
        return "awaiting_sender"       # fail safe - on_progress moves it on when the person's turn comes
    ahead = [p for p in parties if p["ordinal"] < subj["ordinal"] and p["partyRole"] != "cc" and not p.get("saved")]
    return "awaiting_sender" if ahead else "sent"


def review_out(db: Session, ev, user: dict, *, can_see_pay: bool) -> dict:
    """The review screen: what was entered, every generated document (and
    whether it is out of date), the signing order with names, who verifies,
    and every problem. A pure read."""
    import hr_life_events as hle
    setting = event_setting(db, ev)
    if setting is None:
        return {"event": hle.ser_event(db, ev, show_pay=can_see_pay),
                "problems": ["This packet's settings were deleted - void it and start again."],
                "documents": [], "recipients": [], "canVerify": False, "verifier": {}}
    p = event_plan(db, ev, setting, sender=ev.created_by or user["email"], can_see_pay=True)
    stale = outdated(db, ev, p)
    unresolved_by_tpl = {d["templateId"]: d["unresolved"] for d in p["documents"]}
    prints_by_tpl = {d["templateId"]: d["printsPay"] for d in p["documents"]}
    docs = []
    for e in ev.documents or []:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == e.get("templateId")).first()
        prints = prints_by_tpl.get(e.get("templateId"), True)
        docs.append({"documentId": e["documentId"], "title": e.get("title", ""), "templateId": e.get("templateId"),
                     "templateName": tpl.name if tpl else "", "templateVersion": e.get("templateVersion"),
                     "version": e.get("version", 1), "publishedAt": (tpl.published_at if tpl else "") or "",
                     "publishedBy": (tpl.published_by if tpl else "") or "",
                     "outdated": bool(stale.get(e["documentId"])),
                     "printsPay": prints, "canOpen": can_see_pay or not prints,
                     "unresolved": unresolved_by_tpl.get(e.get("templateId"), [])})
    problems = list(p["problems"])
    if ev.kind in CANDIDATE_KINDS:
        problems += _hire_problems(db, ev)
    if setting.verify_distinct and (user["email"] or "").lower() == (ev.created_by or "").lower():
        problems.append("This packet must be verified by someone other than who started it.")
    if not can_see_pay and p["printsPay"]:
        problems.append("These documents show pay - only someone with Pay & Benefits access can verify and send them.")
    for d in docs:
        if d["unresolved"]:
            problems.append(f'"{d["title"]}" still has unfilled details: '
                            + ", ".join(t.replace("_", " ") for t in d["unresolved"]) + ".")
    me = (user["email"] or "").lower()
    can_verify = (ev.status == "review" and bool(p["verifier"]["email"]) and p["verifier"]["email"] == me
                  and not problems and not any(stale.values()))
    d = ev.inputs or {}
    jd = db.query(DocTemplate).filter(DocTemplate.id == d.get("jd_template_id")).first() if d.get("jd_template_id") else None
    offer = {"roleId": d.get("role_id", ""), "jobTitle": d.get("job_title", ""), "department": d.get("department", ""),
             "startDate": d.get("start_date", ""), "offerExpires": d.get("offer_expires", ""),
             "employmentType": d.get("employment_type", ""), "managerEmail": d.get("manager_email", ""),
             "managerName": name_of(db, d["manager_email"]) if d.get("manager_email") else "",
             "workStart": d.get("work_start", ""), "workEnd": d.get("work_end", ""),
             "workDays": list(d.get("work_days") or []), "timingsText": d.get("timings_text", ""),
             "schedule": timings(d).get("work_schedule", ""), "jdTemplateId": d.get("jd_template_id", ""),
             "jdName": jd.name if jd else "", "effectiveDate": d.get("effective_date", ""),
             "lastDay": d.get("last_day", ""), "employeeCode": d.get("employee_code", "")}
    entity = db.query(HrEntity).filter(HrEntity.id == ev.entity_id).first() if ev.entity_id else None
    out = {"event": hle.ser_event(db, ev, show_pay=can_see_pay), "packetName": setting.name or "",
           "packetId": setting.id, "entityId": ev.entity_id or "", "companyName": entity.name if entity else "",
           "offer": offer, "documents": docs, "recipients": p["recipients"], "verifier": p["verifier"],
           "printsPay": p["printsPay"], "problems": list(dict.fromkeys(problems)),
           "outdated": any(stale.values()), "canVerify": can_verify,
           "isVerifier": p["verifier"]["email"] == me,
           "details": {k: v for k, v in (ev.intake or {}).items() if k != "answers"},
           # The packet's Details Form with what was entered (Sensitive ones
           # only for Pay & Benefits), and the Signs Once steps (Oct 14).
           "answers": ser_answers(p["form"], event_answers(ev), can_see_pay),
           "signOnce": [{**s, "isMe": s["email"] == me} for s in p.get("signOnce") or []],
           "extra": dict((ev.inputs or {}).get("extra") or {}),
           "seen": {e["documentId"]: e.get("version", 1) for e in ev.documents or []}}
    if can_see_pay:
        out["pay"] = ev.pay or {}
        out["payValues"] = dict(ev.pay_values or {})
        out["payText"] = pay_merge(ev.pay or {}, ev.pay_values).get("salary", "")
    return out


def _hire_problems(db: Session, ev) -> list:
    """An offer's or a hire's own checks at review and send: the candidate
    still at Offer (or, for the packet that follows a signed offer, still
    hired), the offer still open, and the letter or packet still the one
    their role gets."""
    import hr_life_events as hle
    from models import HrCandidate
    out = []
    d = ev.inputs or {}
    cand = db.query(HrCandidate).filter(HrCandidate.id == ev.candidate_id).first()
    if cand is None:
        return ["The candidate was deleted - void this packet."]
    if d.get("after_offer"):
        if cand.stage == "rejected":
            out.append(f"{ev.subject_name} is Rejected - void this packet.")
        return out
    if cand.stage != "offer":
        out.append(f"{ev.subject_name} is no longer at Offer - move them back to Offer or void this "
                   f"{EVENT_NOUN.get(ev.kind, 'packet')}.")
    exp = d.get("offer_expires") or ""
    if exp and exp < hle._today():
        out.append("The offer expiry date has passed - change Offer Expires before sending.")
    if not d.get("packet_id"):
        wt = d.get("worker_type") or hle.worker_type_of(d.get("employment_type", ""))
        want = hle.resolve_setting(db, ev.entity_id or "", ev.kind, wt, d.get("role_id", ""), d.get("country", ""))
        if want is not None and want.id != ev.setting_id:
            out.append(f'This hire now gets the "{want.name or "other"}" {EVENT_NOUN.get(ev.kind, "packet")} - void this '
                       f'one and start again.')
    return out


def verify_and_send(db: Session, ev, user: dict, *, seen: dict, excluded_ack: bool,
                    can_see_pay: bool, ip: str = "", user_agent: str = "") -> None:
    """Only the verifier - the person the packet's verify role resolves to
    today - releases it, after checking every document. The caller holds the
    event row lock; this commits (Nexus Sign commits the envelope)."""
    import hr_life_events as hle
    from datetime import datetime, timezone
    if ev.status != "review":
        raise hle.PacketError(f"This packet is {ev.status.replace('_', ' ')} - it cannot be sent now.", 409)
    setting = event_setting(db, ev)
    if setting is None:
        raise hle.PacketError("This packet's settings were deleted - void it and start again.", 409)
    me = (user["email"] or "").lower()
    p = event_plan(db, ev, setting, sender=me, can_see_pay=True)
    vemail = p["verifier"]["email"]
    if not vemail:
        raise hle.PacketError(f"Nobody holds {p['verifier']['roleLabel']} to verify this packet.", 409)
    if me != vemail:
        raise hle.PacketError(f"Only {p['verifier']['name']} ({p['verifier']['roleLabel']}) can verify and send "
                              f"this packet.", 403)
    if setting.verify_distinct and me == (ev.created_by or "").lower():
        raise hle.PacketError("This packet must be verified by someone other than who started it.", 403)
    if p["printsPay"] and not can_see_pay:
        raise hle.PacketError("These documents show pay - verifying them needs Pay & Benefits access.", 403)
    if sync_documents(db, ev, setting, p, me) or any(
            str(seen.get(e["documentId"])) != str(e.get("version", 1)) for e in ev.documents or []):
        db.commit()
        raise hle.PacketError("The documents changed while you were reviewing - look again.", 409)
    problems = list(p["problems"]) + (_hire_problems(db, ev) if ev.kind in CANDIDATE_KINDS else [])
    if problems:
        raise hle.PacketError(problems[0], 409)
    if not excluded_ack:
        raise hle.PacketError("Confirm the packet is not a record excluded from electronic signature.", 422)
    parties = p["parties"]
    hle.refresh_due(ev)                    # paperwork after a signed offer never goes out already expired
    status = status_at_send(parties, ev.subject_email)
    out = build_envelope(db, ev, setting, user, p, excluded_ack=excluded_ack, ip=ip, user_agent=user_agent)
    now = datetime.now(timezone.utc).isoformat()
    ev.sign_request_id = out["id"]
    ev.status = status
    ev.verified_by, ev.verified_at, ev.updated_at = me, now, now
    hle._stage_note(db, ev, f"Verified and sent by {name_of(db, me)}", by=me)
    db.commit()


def build_envelope(db: Session, ev, setting: HrPacketSetting, user: dict, p: dict, *,
                   excluded_ack: bool, ip: str = "", user_agent: str = "") -> dict:
    """Render every document with pay, refuse anything still showing a
    {{variable}}, upload the PDFs, place every signer's fields on the lines
    the templates drew, and hand Nexus Sign one envelope."""
    import io
    import uuid
    import hr_life_events as hle
    from fastapi import HTTPException
    from pypdf import PdfReader
    from routers import esign
    from routers.documents import signing_fields
    pay = event_pay(db, ev, setting)
    remap = p["remap"]
    docs = []
    for i, e in enumerate(ev.documents or []):
        row = db.query(Document).filter(Document.id == e["documentId"]).first()
        anchors = []
        pdf, missing = render_row(db, row, pay, anchors=anchors)
        if missing:
            raise hle.PacketError(f'"{row.title}" still has unfilled details: {", ".join(missing)}.', 409)
        text = "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf)).pages)
        if "{{" in text:
            raise hle.PacketError(f'"{row.title}" still shows an unfilled variable - fix the template or the values.', 409)
        path = f"esign/{uuid.uuid4()}/{hle._safe_name(row.title, 90)}.pdf"
        if not esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf").is_success:
            raise hle.PacketError("Could not store the documents - try again in a minute.", 502)
        fields = [{**f, "id": f"d{i + 1}-{f['id']}", "role": remap.get(f["role"], f["role"])}
                  for f in signing_fields(anchors)]
        docs.append({"name": f"{row.title}.pdf", "path": path, "fields": fields})
    parties = [esign.PartyIn(role_key=x["key"], name=x["name"], email=x["email"], kind=x["kind"],
                             ordinal=x["ordinal"], party_role=x["partyRole"], title=x.get("title", ""))
               for x in p["parties"]]
    me = (user["email"] or "").lower()
    # Signs Once: the adopted signature goes on when that step's turn comes.
    saved = {x["key"]: x["saved"] for x in p["parties"] if x.get("saved")}
    first = next((x for x in p["parties"] if not x.get("saved")), None)
    sender_first = bool(first and first["kind"] == "internal" and first["email"] == me
                        and first["partyRole"] != "cc")
    title = f"{hle.EVENT_TITLES.get(ev.kind, 'Packet')} - {ev.subject_name}"
    try:
        return esign.envelope_from_documents(
            db, user, documents=docs, parties=parties, title=title, employee_id=ev.employee_id or "",
            candidate_id=ev.candidate_id or "", entity_id=ev.entity_id or "",
            message=setting.email_message or "",
            expires_on=((ev.inputs or {}).get("due_on") or (ev.inputs or {}).get("offer_expires", "")
                        if ev.kind in CANDIDATE_KINDS else ""),
            ip=ip, user_agent=user_agent, excluded_ack=excluded_ack, document_class="employment",
            link_kind="life_event", link_id=ev.id, sender_signs_first=sender_first,
            prints_pay=p["printsPay"], saved=saved)
    except HTTPException as ex:
        raise hle.PacketError(str(ex.detail), ex.status_code)


# ── the packet's Details Form (Oct 14) ───────────────────────────────────────
# "India contractor is just an example ... it could be for any country and any
# fields" (Pranshu). HR builds the form per packet; the person fills it from
# their details link (or HR does); each answer is a {{variable}}.

FORM_TYPES = ("text", "longtext", "number", "date", "email", "phone", "yesno", "choice", "heading")
STANDARD_DETAILS = ("first_name", "last_name", "preferred_name", "phone", "address", "permanent_address",
                    "emergency_name", "emergency_relationship", "emergency_phone")
_MAX_FORM_FIELDS = 80
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _reserved_tokens() -> set:
    """Variables Nexus fills itself - a form field may not shadow them."""
    from services.merge_fields import BUILTIN_VARIABLES
    return {t for t, _label, _group in BUILTIN_VARIABLES} | set(STANDARD_DETAILS) | PAY_NAMES | {"full_name", "today"}


def form_key(text: str) -> str:
    """"PAN Number" -> pan_number: the {{variable}} a field fills."""
    k = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")[:60].strip("_")
    return k if not k or k[0].isalpha() else f"f_{k}"


def clean_form(fields) -> list:
    """The Details Form as HR built it, checked. Raises PacketProblem with the
    message HR reads."""
    out, seen, reserved = [], set(), _reserved_tokens()
    for f in (fields or [])[:_MAX_FORM_FIELDS]:
        if not isinstance(f, dict):
            continue
        ftype = str(f.get("type") or "text").strip().lower()
        if ftype not in FORM_TYPES:
            raise PacketProblem(f'Unknown field type "{ftype}".')
        label = _CTRL.sub("", str(f.get("label") or "")).strip()[:120]
        if not label:
            raise PacketProblem("Every field on the Details Form needs a label.")
        if ftype == "heading":
            out.append({"key": "", "label": label, "type": "heading"})
            continue
        key = form_key(f.get("key") or label)
        if not key:
            raise PacketProblem(f'"{label}" needs letters or numbers in its name.')
        if key in seen:
            raise PacketProblem(f"Two fields on the Details Form would both be {{{{{key}}}}} - rename one.")
        if key in reserved:
            raise PacketProblem(f'"{label}" would be {{{{{key}}}}}, which Nexus already fills - use that built-in '
                                f'variable in the template, or rename the field.')
        if is_pay_token(key):
            raise PacketProblem(f'"{label}" reads as pay ({{{{{key}}}}}). Pay is entered when the packet starts, '
                                f'never on the Details Form - rename it if it is not pay.')
        seen.add(key)
        options = []
        if ftype == "choice":
            options = list(dict.fromkeys(o for o in (_CTRL.sub("", str(x or "")).strip()[:80]
                                                     for x in (f.get("options") or [])) if o))[:30]
            if len(options) < 2:
                raise PacketProblem(f'"{label}" is a dropdown - give it at least two choices.')
        last4 = bool(f.get("last4")) and ftype in ("text", "number")
        out.append({"key": key, "label": label, "type": ftype, "required": bool(f.get("required")),
                    "options": options, "sensitive": bool(f.get("sensitive")), "last4": last4,
                    "help": _CTRL.sub("", str(f.get("help") or "")).strip()[:200]})
    return out


def form_fields(setting: Optional[HrPacketSetting]) -> list:
    """The form's answerable fields (headings left out)."""
    if setting is None:
        return []
    return [f for f in (setting.details_form or []) if isinstance(f, dict) and f.get("key") and f.get("type") != "heading"]


def sensitive_keys(setting: Optional[HrPacketSetting]) -> set:
    return {f["key"] for f in form_fields(setting) if f.get("sensitive")}


# ── who fills each variable: the template says (Oct 14) ─────────────────────
# Neil: "Pranshu is going to let you fill in everything and the document will
# make itself." A template variable carries its source (Documents > Templates,
# From Word File or Define Variable): 'person' = asked of the person on their
# intake form, 'hr' = answered by HR when they make the offer. The person's
# form is therefore BUILT FROM the documents - each Ask The Person variable
# once, however many documents print it - plus the packet's own Details Form
# for anything extra. HR never keeps a second list that drifts.

_FORM_TYPE = {"text": "text", "multiline": "longtext", "address": "longtext", "number": "number",
              "currency": "number", "date": "date", "email": "email", "dropdown": "choice", "radio": "choice",
              "checkbox": "yesno", "person": "text", "time": "text"}


def def_source(fd: Optional[dict]) -> str:
    return str((fd or {}).get("source") or "")


def snap_sensitive(snap: Snap) -> set:
    """The template's own Ask The Person variables marked Private."""
    return {fd.get("token") for fd in snap.field_defs
            if def_source(fd) == "person" and fd.get("sensitive") and fd.get("token")}


def template_form(snaps: list) -> list:
    """Every Ask The Person variable of these documents as a form field, once
    each, in document order. Built-in details (address, phone...) are already
    on every intake form, so they are never asked twice."""
    reserved, out, seen = _reserved_tokens(), [], set()
    for snap in snaps:
        for fd in snap.field_defs:
            token = fd.get("token") or ""
            if def_source(fd) != "person" or not token or token in seen or token in reserved or "." in token:
                continue
            if token not in snap.tokens:
                continue                                  # defined but no longer printed
            seen.add(token)
            ftype = _FORM_TYPE.get(fd.get("type") or "text", "text")
            options = [str(o) for o in (fd.get("options") or []) if str(o).strip()] if ftype == "choice" else []
            if ftype == "choice" and len(options) < 2:
                ftype, options = "text", []
            out.append({"key": token, "label": str(fd.get("label") or token.replace("_", " ").title())[:120],
                        "type": ftype, "required": bool(fd.get("required")), "options": options,
                        "sensitive": bool(fd.get("sensitive")) or is_pay_token(token, snap.defs),
                        "last4": bool(fd.get("last4")) and ftype in ("text", "number"),
                        "help": str(fd.get("description") or "")[:200], "fromTemplate": snap.name})
    return out


class FormView:
    """The person's whole form for one packet - what every Details Form helper
    reads (they only look at .details_form): the packet's own fields, then
    each Ask The Person variable of its documents not already on it."""

    def __init__(self, setting: Optional[HrPacketSetting], snaps: list):
        own = [f for f in ((setting.details_form or []) if setting is not None else []) if isinstance(f, dict)]
        keys = {f.get("key") for f in own if f.get("key")}
        derived = [f for f in template_form(snaps) if f["key"] not in keys]
        self.details_form = own + derived
        self.derived_keys = {f["key"] for f in derived}


def form_view(db: Session, setting: Optional[HrPacketSetting], template_ids: Optional[list] = None) -> FormView:
    if setting is None:
        return FormView(None, [])
    ids = list(setting.doc_template_ids or [])
    ids += [t for t in (template_ids or []) if t and t not in ids]
    snaps, _ = load_snaps(db, ids)
    return FormView(setting, snaps)


# ── building blocks (Oct 14) ────────────────────────────────────────────────
# Neil: "there's a different confidentiality and non-disclosure agreement for
# each team ... Pranshu can now connect it to a role." A packet is its common
# documents plus the ones added for the person's team (department) or role -
# one packet per kind of hire, never one per role.

BLOCK_MATCHES = ("department", "role")


def clean_blocks(rows) -> list:
    """[{match, value, templateIds}] - known matches, a value, at least one
    template; the same match + value only once."""
    out, seen = [], set()
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        match = str(r.get("match") or "").strip().lower()
        value = re.sub(r"[\x00-\x1f\x7f]", "", str(r.get("value") or "")).strip()[:120]
        ids = list(dict.fromkeys(str(t).strip() for t in (r.get("templateIds") or []) if str(t).strip()))[:10]
        if match not in BLOCK_MATCHES:
            raise PacketProblem("A team or role document needs Team or Role picked.")
        if not value:
            raise PacketProblem("Pick the team or role each added document is for.")
        if not ids:
            raise PacketProblem(f'Add at least one document for "{value}", or remove that row.')
        key = (match, value.lower())
        if key in seen:
            raise PacketProblem(f'"{value}" is listed twice - put its documents in one row.')
        seen.add(key)
        out.append({"match": match, "value": value, "templateIds": ids})
    return out


def block_ids(setting: Optional[HrPacketSetting], department: str = "", role_id: str = "") -> list:
    """The documents a packet adds for this person's team and role."""
    dep = (department or "").strip().lower()
    out = []
    for r in (getattr(setting, "extra_docs", None) or []) if setting is not None else []:
        if not isinstance(r, dict):
            continue
        hit = ((r.get("match") == "department" and dep and str(r.get("value") or "").strip().lower() == dep)
               or (r.get("match") == "role" and role_id and r.get("value") == role_id))
        if hit:
            out += [t for t in (r.get("templateIds") or []) if t not in out]
    return out


def all_block_ids(setting: Optional[HrPacketSetting]) -> list:
    out = []
    for r in (getattr(setting, "extra_docs", None) or []) if setting is not None else []:
        if isinstance(r, dict):
            out += [t for t in (r.get("templateIds") or []) if t not in out]
    return out


def template_ids_for(setting: Optional[HrPacketSetting], inputs: dict, kind: str) -> list:
    """Every template a packet prints for one person: its own documents, the
    ones for their team and role, then (not on an offer) their job
    description."""
    d = inputs or {}
    ids = list((setting.doc_template_ids or []) if setting is not None else [])
    ids += [t for t in block_ids(setting, d.get("department", ""), d.get("role_id", "")) if t not in ids]
    jd = d.get("jd_template_id") or "" if kind != "offer" else ""
    if jd and jd not in ids:
        ids.append(jd)
    return ids


def event_template_ids(ev, setting: Optional[HrPacketSetting]) -> list:
    """Every template an event's packet prints: the packet's own documents,
    the team's and role's, then the job description picked for this hire."""
    return template_ids_for(setting, ev.inputs or {}, ev.kind)


def event_form(db: Session, ev, setting: Optional[HrPacketSetting]) -> FormView:
    return form_view(db, setting, event_template_ids(ev, setting))


def hr_questions(snaps: list) -> list:
    """Every HR Answers variable of these documents, once each - what HR is
    asked when they make the offer or start the packet. Pay ones are marked:
    they are entered only by Pay & Benefits holders and never stored on a
    document row."""
    reserved, out, seen = _reserved_tokens(), [], set()
    for snap in snaps:
        for fd in snap.field_defs:
            token = fd.get("token") or ""
            if def_source(fd) != "hr" or not token or token in seen or token in reserved or "." in token:
                continue
            if token not in snap.tokens:
                continue
            seen.add(token)
            ftype = _FORM_TYPE.get(fd.get("type") or "text", "text")
            out.append({"token": token, "label": str(fd.get("label") or token.replace("_", " ").title())[:120],
                        "type": ftype, "options": [str(o) for o in (fd.get("options") or []) if str(o).strip()],
                        "required": bool(fd.get("required")), "default": str(fd.get("default") or ""),
                        "pay": is_pay_token(token, snap.defs), "help": str(fd.get("description") or "")[:200],
                        "templateName": snap.name})
    return out


def mask_last4(value: str) -> str:
    chars = re.sub(r"[^0-9A-Za-z]", "", value or "")
    return f"XXXX {chars[-4:]}" if len(chars) >= 4 else ""


def clean_answers(setting: Optional[HrPacketSetting], values: Optional[dict], existing: Optional[dict] = None,
                  *, require: bool = False, keep: tuple = ()) -> dict:
    """The Details Form answers, each checked against its field: known keys
    only, the right shape for the type, Last 4 Only cut down before it is
    ever stored. `keep` = keys left as they were (a Sensitive answer someone
    without Pay & Benefits could not see)."""
    existing, values = dict(existing or {}), dict(values or {})
    out = {}
    for f in form_fields(setting):
        k, t, label = f["key"], f["type"], f["label"]
        if k in keep:
            if existing.get(k):
                out[k] = existing[k]
            continue
        v = _CTRL.sub("", str(values.get(k) if values.get(k) is not None else "")).strip()
        if f.get("last4") and v and v == existing.get(k):
            out[k] = v                 # the masked value shown back, unchanged
            continue
        if not v:
            if require and f.get("required"):
                raise PacketProblem(f"Please fill in {label}.")
            continue
        v = v[:2000] if t == "longtext" else v[:200]
        if t == "number" and not re.fullmatch(r"[0-9][0-9 ,.\-]*", v):
            raise PacketProblem(f"{label} must be a number.")
        if t == "date":
            from datetime import datetime
            try:
                datetime.strptime(v, "%Y-%m-%d")
            except ValueError:
                raise PacketProblem(f"{label} must be a date.")
        if t == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
            raise PacketProblem(f"{label} must be an email address.")
        if t == "phone" and not re.fullmatch(r"[0-9+()\-. ]{5,30}", v):
            raise PacketProblem(f"{label} must be a phone number.")
        if t == "yesno":
            v = {"yes": "Yes", "y": "Yes", "true": "Yes", "no": "No", "n": "No", "false": "No"}.get(v.lower(), "")
            if not v:
                raise PacketProblem(f"{label} must be Yes or No.")
        if t == "choice" and v not in (f.get("options") or []):
            raise PacketProblem(f"{label} must be one of: " + ", ".join(f.get("options") or []) + ".")
        if f.get("last4"):
            v = mask_last4(v)
            if not v:
                raise PacketProblem(f"{label} needs at least 4 letters or numbers.")
        out[k] = v
    return out


def missing_answers(setting: Optional[HrPacketSetting], answers: dict) -> list:
    return [f["label"] for f in form_fields(setting)
            if f.get("required") and not str((answers or {}).get(f["key"]) or "").strip()]


def answer_values(setting: Optional[HrPacketSetting], answers: dict) -> tuple:
    """(plain, restricted) {{variable}} values from the answers, as the
    documents print them (dates MM/DD/YYYY). Restricted = Sensitive fields."""
    from datetime import datetime
    plain, restricted = {}, {}
    for f in form_fields(setting):
        v = str((answers or {}).get(f["key"]) or "").strip()
        if not v:
            # An optional field left empty prints blank - it never blocks the
            # packet as an "unfilled detail". A required one is checked by
            # missing_answers.
            if not f.get("required"):
                (restricted if f.get("sensitive") else plain)[f["key"]] = ""
            continue
        if f["type"] == "date":
            try:
                v = datetime.strptime(v, "%Y-%m-%d").strftime("%m/%d/%Y")
            except ValueError:
                pass
        (restricted if f.get("sensitive") else plain)[f["key"]] = v
    return plain, restricted


def ser_answers(setting: Optional[HrPacketSetting], answers: dict, can_see_pay: bool) -> list:
    """The answers as the review screen shows them - a Sensitive one only to
    Pay & Benefits."""
    out = []
    for f in (setting.details_form or []) if setting is not None else []:
        if not isinstance(f, dict):
            continue
        if f.get("type") == "heading":
            out.append({"key": "", "label": f.get("label", ""), "type": "heading"})
            continue
        locked = bool(f.get("sensitive")) and not can_see_pay
        out.append({**f, "value": "" if locked else str((answers or {}).get(f["key"]) or ""), "locked": locked})
    return out


# ── Signs Once (Oct 14) ──────────────────────────────────────────────────────
# "HR just needs to sign one time ... if HR is changed for that company from
# company settings it again asks for sign" (Pranshu). The adoption is a real
# signature: the holder is signed in to Nexus AND verifies a one-time code,
# like every other Nexus signature, and the record is kept (never deleted).

def saved_signature(setting: HrPacketSetting, step_key: str, entity_id: str, email: str) -> Optional[dict]:
    """The signature in force for a step at a company - only while it was
    adopted by the person who holds the role TODAY."""
    for r in reversed(setting.saved_signatures or []):
        if (isinstance(r, dict) and r.get("step") == step_key and (r.get("entityId") or "") == (entity_id or "")
                and not r.get("replacedAt")):
            return r if (r.get("email") or "").lower() == (email or "").lower() else None
    return None


def once_status(setting: HrPacketSetting, parties: list, ctx: dict) -> list:
    """Each Signs Once step of this packet for this company: who holds it
    now and whether they have signed. Marks the parties with their record."""
    entity_id = getattr(ctx.get("entity"), "id", "") or ""
    out = []
    for party in parties:
        if not party.get("once"):
            continue
        rec = saved_signature(setting, party["key"], entity_id, party["email"])
        party["saved"] = rec
        out.append({"key": party["key"], "role": party["role"], "roleLabel": role_label(party["role"]),
                    "email": party["email"], "name": party["name"], "signed": bool(rec),
                    "adoptedAt": (rec or {}).get("adoptedAt", ""), "entityId": entity_id})
    return out


def company_once_status(db: Session, setting: HrPacketSetting, entity: Optional[HrEntity]) -> list:
    """For the packet editor: each Signs Once step, who holds it at this
    company today, and whether that person has signed it."""
    ctx = {"entity": entity, "owners": hc.role_owners(db, entity.id if entity else "")}
    out = []
    for step in clean_flow(setting.flow):
        if not step.get("once"):
            continue
        email = resolve_role(db, step["role"], ctx)
        rec = saved_signature(setting, step["key"], entity.id if entity else "", email) if email else None
        last = next((r for r in reversed(setting.saved_signatures or [])
                     if isinstance(r, dict) and r.get("step") == step["key"]
                     and (r.get("entityId") or "") == (entity.id if entity else "")), None)
        out.append({"key": step["key"], "role": step["role"], "roleLabel": role_label(step["role"]),
                    "email": email, "name": name_of(db, email) if email else "", "signed": bool(rec),
                    "adoptedAt": (rec or {}).get("adoptedAt", ""),
                    "previous": ({"name": last.get("name", ""), "adoptedAt": last.get("adoptedAt", "")}
                                 if last and not rec else None)})
    return out


def adopt_signature(db: Session, setting: HrPacketSetting, *, step_key: str, entity: Optional[HrEntity],
                    email: str, kind: str, data: str, otp_challenge_id: str, consent_version: str,
                    ip: str = "", user_agent: str = "") -> dict:
    """Record `email`'s signature for a Signs Once step at a company. Only
    the person who holds the step's role there today may. The caller has
    checked the signature and the one-time code; the caller commits."""
    from datetime import datetime, timezone
    step = next((s for s in clean_flow(setting.flow) if s["key"] == step_key and s.get("once")), None)
    if step is None:
        raise PacketProblem("That step does not Sign Once - save the packet with Signs Once ticked first.")
    entity_id = entity.id if entity else ""
    if setting.entity_id and setting.entity_id != entity_id:
        raise PacketProblem("This packet belongs to another company.")
    holder = resolve_role(db, step["role"], {"entity": entity, "owners": hc.role_owners(db, entity_id)})
    me = (email or "").strip().lower()
    if not holder or holder != me:
        raise PacketProblem(f"Only the person who holds {role_label(step['role'])} for this company "
                            f"({name_of(db, holder) if holder else 'nobody yet'}) can sign it once.")
    now = datetime.now(timezone.utc).isoformat()
    recs = [dict(r) for r in (setting.saved_signatures or []) if isinstance(r, dict)]
    for r in recs:
        if r.get("step") == step_key and (r.get("entityId") or "") == entity_id and not r.get("replacedAt"):
            r["replacedAt"] = now
    rec = {"step": step_key, "role": step["role"], "entityId": entity_id, "email": me, "name": name_of(db, me),
           "kind": kind, "data": data, "digest": hashlib.sha256((data or "").encode()).hexdigest(),
           "adoptedAt": now, "consentVersion": consent_version, "otpChallengeId": otp_challenge_id,
           "ip": (ip or "")[:64], "userAgent": (user_agent or "")[:300], "replacedAt": ""}
    recs.append(rec)
    setting.saved_signatures = recs        # reassigned, never mutated in place (JSON column)
    return rec


# ── Ready To Send (Oct 14) ───────────────────────────────────────────────────
# "Nothing is ever silently missing" (Pranshu, after running a hire end to end
# on dev: the salary never printed and the company had no HR contact - and
# nothing said so until deep in the flow). Every check a packet needs before a
# hire can go out, each with what fixes it. A pure read.

_PAY_EVENTS = ("offer", "hire", "promotion")


def _check(key: str, ok: bool, label: str, detail: str = "", severity: str = "block", fix: Optional[dict] = None) -> dict:
    return {"key": key, "ok": bool(ok), "label": label, "detail": detail,
            "severity": "ok" if ok else severity, "fix": fix if not ok else None}


def unfilled_variables(setting: HrPacketSetting, snaps: list) -> list:
    """{token, label} of every variable the packet's templates print that
    nothing fills: not built in, not asked of the person (the template's Ask
    The Person or the Details Form), not answered by HR, no Default Value,
    not pay. HR would have to type each one on every packet."""
    reserved = _reserved_tokens()
    form = {f["key"] for f in form_fields(FormView(setting, snaps))}
    out, seen = [], set()
    for s in snaps:
        defaults = {fd.get("token") for fd in s.field_defs if str(fd.get("default") or "").strip()}
        # HR answers it when the offer is made (or the packet starts).
        by_hr = {fd.get("token") for fd in s.field_defs if def_source(fd) == "hr"}
        for t in sorted(s.tokens):
            if (t in seen or t in reserved or t in form or t in defaults or t in by_hr or "." in t
                    or is_pay_token(t, s.defs)):
                continue
            seen.add(t)
            fd = s.defs.get(t) or {}
            out.append({"token": t, "label": fd.get("label") or t.replace("_", " ").title(),
                        "type": fd.get("type") or "text", "templateId": s.tpl.id, "templateName": s.name})
    return out


def readiness(db: Session, setting: HrPacketSetting) -> list:
    """The packet's Ready To Send checklist: what is fine, what stops a hire
    from going out (block) and what would come out wrong (warn) - each with
    the fix the screen offers. A team's or role's documents are checked too."""
    ids = list(setting.doc_template_ids or [])
    ids += [t for t in all_block_ids(setting) if t not in ids]
    snaps, snap_problems = load_snaps(db, ids)
    out = []
    # 1. The documents: there, active, published.
    unpublished = next((t for t in (db.query(DocTemplate).filter(DocTemplate.id == i).first() for i in ids)
                        if t is not None and (t.status != "active" or not t.published_version)), None)
    out.append(_check("documents", bool(ids) and not snap_problems,
                      "Documents Published",
                      (snap_problems[0] if snap_problems else "Add at least one document from Documents > Templates.")
                      if (snap_problems or not ids) else f"{len(snaps)} document{'s' if len(snaps) != 1 else ''}, published",
                      fix={"kind": "template", "templateId": unpublished.id} if unpublished is not None else None))
    # 2. The signing order makes sense with the documents' signature blocks.
    order = config_problems(db, setting, snaps, [])
    out.append(_check("signing", not order, "Signing Order", order[0] if order else "Every signature block has a signer"))
    # 3. The company holds every role the packet needs (a company's packet;
    #    a packet for every company is checked per company when it starts).
    entity = db.query(HrEntity).filter(HrEntity.id == setting.entity_id).first() if setting.entity_id else None
    verify = setting.verify_role or "hr"
    if entity is not None:
        ctx = {"entity": entity, "owners": hc.role_owners(db, entity.id)}
        roles = list(dict.fromkeys([s["role"] for s in clean_flow(setting.flow)
                                    if s["role"] not in (SUBJECT_ROLE, "manager", "sender")] + [verify]))
        for role in roles:
            email = resolve_role(db, role, ctx)
            p = person(db, email) if email else None
            ok = bool(email) and p is not None and (p.status or "") in ("active", "onboarding")
            field = {"hr": "hr_contact_email", "signatory": "signatory_email"}.get(role)
            fix = ({"kind": "entityField", "field": field, "entityId": entity.id, "role": role} if field
                   else {"kind": "checklistOwners", "role": role})
            label = {"hr": "HR Contact", "signatory": "Authorized Signatory"}.get(role, role_label(role))
            out.append(_check(f"role:{role}", ok, f"{entity.name} Has {label}",
                              f"{name_of(db, email)}" if ok else
                              (f"{email} is not an active person in People." if email else
                               f"Nobody holds {label} for {entity.name} yet - " +
                               ("they verify and sign this packet." if role == verify else "they sign this packet.")),
                              fix=fix))
        # Company details the documents print.
        tokens = {t for s in snaps for t in s.tokens}
        merge = {"company_address": (getattr(entity, "physical_address", "") or entity.registered_address or "")}
        for tok, lbl in (("company_address", "Company Address"),):
            if tok in tokens:
                out.append(_check(f"company:{tok}", bool(merge[tok].strip()), f"{entity.name} Has A {lbl}",
                                  merge[tok] if merge[tok].strip() else f"The documents print {{{{{tok}}}}} - set it in Company Settings.",
                                  fix={"kind": "entityField", "field": "physical_address", "entityId": entity.id}))
        # 4. Whoever verifies can see pay, when the documents show it.
        vemail = resolve_role(db, verify, ctx)
        if vemail and packet_prints_pay(setting, snaps):
            out.append(_check("payAccess", has_comp_for(db, vemail), "Verifier Can See Pay",
                              f"{name_of(db, vemail)} has Pay & Benefits access" if has_comp_for(db, vemail) else
                              f"{name_of(db, vemail)} verifies this packet but has no Pay & Benefits access - "
                              f"give it in Settings > Access, or change Verified By."))
        # 5. Signs Once: the company has signed.
        for s in company_once_status(db, setting, entity):
            out.append(_check(f"once:{s['key']}", s["signed"], "Company Signed Once",
                              f"{s['name']} signed on {hc.us_date(s['adoptedAt'][:10])}" if s["signed"] else
                              (f"{s['name']} ({s['roleLabel']}) signs once - after that it goes on every packet."
                               if s["email"] else f"Nobody holds {s['roleLabel']} yet."),
                              fix={"kind": "signOnce", "step": s["key"], "email": s["email"]}))
    else:
        out.append(_check("company", True, "Company Roles", "Checked for each company the first time this packet is used"))
    # 6. The pay HR enters is printed somewhere (hire / promotion).
    if setting.event in _PAY_EVENTS and snaps:
        prints = bool(pay_tokens(snaps))
        out.append(_check("payPrints", prints, "Pay Shows In A Document",
                          "Printed where the templates say {{salary}}" if prints else
                          "The pay entered when the packet starts is not printed anywhere - put the Salary variable "
                          "where the pay goes in a template.",
                          severity="warn", fix={"kind": "template", "templateId": snaps[0].tpl.id}))
    # 7. Every variable has a source.
    missing = unfilled_variables(setting, snaps)
    out.append(_check("variables", not missing, "Every Variable Is Filled",
                      "Nexus fills each one, or it is asked of the person or of HR" if not missing else
                      "Nothing fills " + ", ".join(m["label"] for m in missing[:6]) + ("..." if len(missing) > 6 else "") +
                      (" - in the template mark each one Ask The Person or HR Answers, give it a Default Value, "
                       "or add it to the Details Form."
                       if setting.event == "hire" else
                       " - in the template mark each one HR Answers, or give it a Default Value."),
                      fix={"kind": "addToForm" if setting.event == "hire" else "template", "variables": missing,
                           "templateId": missing[0]["templateId"] if missing else ""}))
    return out
