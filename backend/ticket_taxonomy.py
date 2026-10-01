"""Ticket taxonomy admin config (Sep 2026) - SLA target hours per priority and
per-type intake question overrides. Both used to be hardcoded constants
(SLA_TARGET_HOURS / TYPE_FIELDS in frontend/src/tickets/ticketMeta.js,
_SLA_TARGET_HOURS here) that an engineer had to edit and redeploy to change.

Kept out of routers/tickets.py so that file doesn't balloon further - same
reason ticket_notify.py is its own module. Settings live in NexusSetting
(key="ticket_taxonomy_config", JSON value), the same "small admin config"
pattern ticket_notify.py and timeclock.py's auto-lunch rules use.

Overrides only, not a full type catalogue: a type's KEY, icon and color stay
defined in the frontend (ticketMeta.js) - this only overrides label, hint,
whether/where it appears in the intake picker, its intake field list, and
whether it requires approval. Adding a brand-new type (with a new icon) is
still a code change; renaming, reordering, retiring from intake, and fully
managing an existing type's questions is not.

Approval per type (Sep 2026): `types[<key>].requiresApproval` is the admin's
on/off switch for whether a NEW ticket of that type parks for approval before
the desk can work it. It replaces the hardcoded APPROVAL_REQUIRED_TYPES set
that used to live in routers/tickets.py. The switch is read only at the
moment the gate is decided (a ticket is created, or re-typed) and the outcome
is stored on the ticket as approval_status, so flipping it never changes a
ticket that already exists - see requires_approval() below.
"""
import json
import re
from typing import Any

from sqlalchemy.orm import Session

import models

_SETTINGS_KEY = "ticket_taxonomy_config"

# Mirrors the frontend defaults (ticketMeta.js SLA_TARGET_HOURS) - this is
# the fallback when no admin override has ever been saved, and the seed a
# fresh override starts from in the Admin editor.
_DEFAULT_SLA_HOURS = {"urgent": 24, "high": 48, "medium": 72, "low": 168}

# The three types that were hardcoded as gated before the switch existed.
# They stay gated until an admin turns them off, so nothing changes on
# deploy. Every other type - including any type key an admin configures that
# is not in this set - defaults to NOT requiring approval.
#
# Why these three: they commit somebody else's money, access or production
# config, so a second person signs off. A bug report or a question commits
# nothing, and gating those would only add a step between a user and help.
DEFAULT_APPROVAL_TYPES = frozenset({"service_request", "change_request", "access_request"})

# A type key as the rest of the ticket module writes them ("access_request").
_TYPE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


# "What do you need help with?" - the intake form's second question, driven by
# the department picked above it (Neil, Sep 30: "if the department is IT, the
# options should come up as they relate to IT. If the department is
# construction, the options should come up as they relate to construction and
# maintenance"). It replaced a single list of every External Links app, which
# put a plumbing leak behind a scroll through finance and HR software.
#
# `departments` are matched against the ticket department's NAME, lowercased
# (ticket departments are per-company rows an admin can rename, so a key
# would not survive). A department with no group asks the question as a short
# free-text answer instead. `area` is the service area the topic files under -
# it decides the follow-up questions (Which facility? Which device?) and the
# desk's triage buckets; see service_area_for in routers/tickets.py.
# "Other" is not listed: the form always offers it, with a required short
# answer (max TOPIC_MAX_LEN characters).
TOPIC_MAX_LEN = 50

# Sub-options (Neil, Oct 1 2026): a topic may carry an optional second level,
# asked as "Which one?" once the topic is picked - IT -> Microsoft -> Outlook.
# "We don't want hundreds of options. It should be IT, then what the issue is -
# it should help filter to the exact issue quickly." So a short list, named the
# way END USERS see the thing ("Microsoft 365 means something to us, nothing to
# the end user - they see it as Outlook, Teams, OneDrive"). Optional for the
# requester, and stored on the ticket as typeFields.svc_helpSubtopic.
OPTIONS_MAX = 30

# The Nexus modules, as the left navigation names them (Sidebar.jsx NAV) - the
# Support page's Report a Bug flow is gone, so "Nexus -> which module" is how
# a bug report says where it happened.
NEXUS_MODULES = [
    "Dashboard", "Workday (Time Clock, Time Sheet, Time Off)", "Shifts", "Tasks",
    "Tickets or Support", "Files", "Knowledge Base", "Documents or Nexus Sign",
    "Item Management", "Asset Management", "Accounting", "Investor Relations",
    "People", "Construction", "Operations", "Marketing", "Business Intelligence",
    "Credential Vault", "Workforce Analytics", "Notifications or Emails", "Settings",
]

DEFAULT_HELP_TOPICS = [
    {"label": "IT Support", "departments": ["it", "it support", "information technology", "technology"],
     "topics": [
         {"name": "Nexus", "area": "tasks", "options": list(NEXUS_MODULES)},
         {"name": "Microsoft (Outlook, Teams, OneDrive)", "area": "email",
          "options": ["Outlook", "Teams", "OneDrive", "SharePoint", "Word", "Excel", "PowerPoint"]},
         {"name": "Sage Intacct", "area": "finance",
          "options": ["General Ledger", "Accounts Payable", "Accounts Receivable", "Cash Management",
                      "Purchasing", "Order Entry", "Projects", "Fixed Assets", "Reporting"]},
         {"name": "Egnyte", "area": "files"},
         {"name": "Cubby", "area": "storageops"},
         {"name": "Login or Password", "area": "email",
          "options": ["Computer", "Microsoft (Outlook, Teams)", "Nexus", "Sage Intacct", "Egnyte", "Cubby"]},
         {"name": "Access to a Nexus Module", "area": "tasks", "options": list(NEXUS_MODULES)},
         {"name": "Computer or Laptop", "area": "hardware"},
         {"name": "Printer or Scanner", "area": "hardware"},
         {"name": "Phone", "area": "collab"},
         {"name": "Internet or Wi-Fi", "area": "network"},
         # Two different things (Neil, Oct 1) - used to be one topic.
         {"name": "Cameras", "area": "security"},
         {"name": "Gate Access", "area": "security"},
     ]},
    {"label": "Construction & Maintenance",
     "departments": ["construction", "maintenance", "construction & maintenance",
                     "construction and maintenance", "facilities", "facility maintenance"],
     "topics": [{"name": n, "area": "facilities"} for n in (
         "Lights or Electrical", "Plumbing or Water Leak", "Heating or Cooling (HVAC)",
         "Doors, Gates or Locks", "Roof or Ceiling Leak", "Building Damage or Repair",
         "Parking Lot or Paving", "Landscaping or Snow Removal", "Pest Control",
         "Cleaning", "Signs",
     )]},
    {"label": "Admin", "departments": ["admin", "administration", "office admin"],
     "topics": [{"name": n, "area": "general"} for n in (
         "Office Supplies", "Mail or Deliveries", "Office Space or Furniture",
         "Company Documents or Forms", "Travel", "Vendors or Contracts",
     )]},
    {"label": "Operations", "departments": ["operations", "ops", "storage operations"],
     "topics": [
         {"name": "Tenant or Unit Issue", "area": "storageops"},
         {"name": "Move-In or Move-Out", "area": "storageops"},
         {"name": "Rates or Pricing", "area": "storageops"},
         {"name": "Gate Codes", "area": "security"},
         {"name": "Site Supplies", "area": "general"},
     ]},
]

# helpTopics saved before sub-options existed (version 1) are upgraded on read,
# once, without clobbering what an admin chose: only the two default topics
# Neil renamed/split change name, topics that never had a sub-option list get
# the default one (matched by name), and a group that is a default group's
# (shares a department name) gains the topics added in version 2 if missing.
# Everything else - order, removals, custom topics, areas - is kept as saved.
HELP_TOPICS_VERSION = 2
_LEGACY_TOPIC_NAMES = {
    "microsoft 365 (outlook, teams, onedrive)": ["Microsoft (Outlook, Teams, OneDrive)"],
    "cameras or gate access": ["Cameras", "Gate Access"],
}
_ADDED_IN_V2 = {"access to a nexus module"}


def _default_topic(name: str) -> dict | None:
    key = (name or "").strip().lower()
    for g in DEFAULT_HELP_TOPICS:
        for tp in g["topics"]:
            if tp["name"].lower() == key:
                return tp
    return None


def _upgrade_help_topics(groups: list) -> list:
    out = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        topics = []
        for tp in g.get("topics") or []:
            if not isinstance(tp, dict):
                continue
            renamed = _LEGACY_TOPIC_NAMES.get(str(tp.get("name") or "").strip().lower())
            for name in renamed or [tp.get("name")]:
                nt = {**tp, "name": name}
                if "options" not in nt:
                    d = _default_topic(name)
                    if d and d.get("options"):
                        nt["options"] = list(d["options"])
                topics.append(nt)
        depts = {str(d).strip().lower() for d in (g.get("departments") or [])}
        have = {str(tp.get("name") or "").strip().lower() for tp in topics}
        for dg in DEFAULT_HELP_TOPICS:
            if depts & set(dg["departments"]):
                for d in dg["topics"]:
                    if d["name"].lower() in _ADDED_IN_V2 and d["name"].lower() not in have:
                        topics.append(json.loads(json.dumps(d)))
        out.append({**g, "topics": topics})
    return out


class TaxonomyError(ValueError):
    """A save patch the server refuses - the router turns it into a 400."""


_DEFAULTS = {
    "slaTargetHours": _DEFAULT_SLA_HOURS,
    # Every type key is absent by default - frontend falls back to its own
    # compiled-in TICKET_TYPE_META/TYPE_FIELDS/TICKET_TYPE_ORDER until an
    # admin actually edits a type, at which point that type's key gets an
    # entry here: { label?, hint?, fields?, requiresApproval? }. typeOrder, if
    # present, fully replaces the intake picker's order/membership.
    # (get_config always fills requiresApproval in for DEFAULT_APPROVAL_TYPES,
    # so those three keys are present in what it returns.)
    "types": {},
    "typeOrder": None,
    # Company field on intake (Sep 19, Pranshu: "End user don't have the
    # ability to choose company but here it is showing the ticket is raised
    # for GGcon company - this is an issue... admin have the control to turn
    # on/off the company field for end user"). Off by default - a requester's
    # ticket is silently filed under their own People-record company, same as
    # before this setting existed (see company_for in routers/tickets.py).
    # When enabled, `companyIds` is the admin-picked subset an end user may
    # choose from at intake - an empty list with enabled=True offers nothing
    # (same "nothing to choose from" fallback the department/application
    # pickers already use), not "every company".
    "companyField": {"enabled": False, "companyIds": []},
    # See DEFAULT_HELP_TOPICS. Replaced wholesale by a saved list.
    "helpTopics": DEFAULT_HELP_TOPICS,
    "helpTopicsVersion": HELP_TOPICS_VERSION,
}


def _fill_approval_defaults(types: dict) -> None:
    """Makes `requiresApproval` explicit for the default-gated types that have
    no saved choice yet, so the Admin editor (and every ticket screen) reads
    the effective value straight off the config instead of re-deriving the
    default. Any other type without the flag is simply not gated."""
    for key in DEFAULT_APPROVAL_TYPES:
        entry = types.setdefault(key, {})
        if not isinstance(entry.get("requiresApproval"), bool):
            entry["requiresApproval"] = True


def _validate_types_patch(types: Any) -> None:
    if not isinstance(types, dict):
        raise TaxonomyError("types must be an object keyed by ticket type.")
    for key, entry in types.items():
        if not isinstance(key, str) or not _TYPE_KEY_RE.match(key):
            raise TaxonomyError(f"Invalid ticket type key: {key!r}.")
        if not isinstance(entry, dict):
            raise TaxonomyError(f"Settings for ticket type {key!r} must be an object.")
        if "requiresApproval" in entry and not isinstance(entry["requiresApproval"], bool):
            raise TaxonomyError(f"requiresApproval for ticket type {key!r} must be true or false.")


def _clean_options(topic: str, options: Any) -> list:
    """A topic's "Which one?" list: trimmed, blanks and repeats dropped."""
    if options is None:
        return []
    if not isinstance(options, list):
        raise TaxonomyError(f"The sub-options of {topic!r} must be a list.")
    out, seen = [], set()
    for o in options:
        name = str(o or "").strip()
        if not name or name.lower() in seen:
            continue
        if len(name) > TOPIC_MAX_LEN:
            raise TaxonomyError(f"Sub-option {name!r} is too long ({TOPIC_MAX_LEN} characters max).")
        seen.add(name.lower())
        out.append(name)
    if len(out) > OPTIONS_MAX:
        raise TaxonomyError(f"{topic!r} has too many sub-options ({OPTIONS_MAX} max) - keep the list short.")
    return out


# A topic's extra questions (Pranshu, Oct 1 2026): "Which facility?", "Which
# camera or gate?" - added, edited and removed per topic in Help Topics. A
# topic without `questions` asks its service area's compiled-in questions (the
# frontend's SERVICE_FIELDS); with it, exactly these (an empty list = none).
# Answers are stored on the ticket's typeFields under each `svc_` key.
QUESTIONS_MAX = 6
QUESTION_LABEL_MAX = 120
QUESTION_KINDS = {"text", "textarea", "select", "site", "number", "date"}
_KEY_RE = re.compile(r"^svc_[A-Za-z0-9_]{1,40}$")
_RESERVED_KEYS = {"svc_helpSubtopic"}


def _question_key(label: str, taken: set) -> str:
    words = re.findall(r"[A-Za-z0-9]+", label) or ["question"]
    base = "svc_" + words[0].lower() + "".join(w.capitalize() for w in words[1:])
    base = base[:44]
    key, i = base, 2
    while key in taken or key in _RESERVED_KEYS:
        key, i = f"{base}{i}", i + 1
    return key


def _clean_questions(topic: str, questions: Any) -> list:
    """A topic's extra questions, each {key, label, type, req, options?, types?}."""
    if not isinstance(questions, list):
        raise TaxonomyError(f"The questions of {topic!r} must be a list.")
    out, taken = [], set()
    for q in questions:
        if not isinstance(q, dict):
            raise TaxonomyError(f"Each question of {topic!r} must be an object.")
        label = str(q.get("label") or "").strip()
        if not label:
            continue
        if len(label) > QUESTION_LABEL_MAX:
            raise TaxonomyError(f"The question {label[:40]!r}... is too long ({QUESTION_LABEL_MAX} characters max).")
        kind = str(q.get("type") or "text").strip().lower()
        if kind not in QUESTION_KINDS:
            raise TaxonomyError(f"{label!r} has an unknown answer type {kind!r}.")
        key = str(q.get("key") or "").strip()
        if not _KEY_RE.match(key) or key in taken or key in _RESERVED_KEYS:
            key = _question_key(label, taken)
        taken.add(key)
        clean = {"key": key, "label": label, "type": kind, "req": bool(q.get("req"))}
        if kind == "select":
            options = _clean_options(label, q.get("options") or [])
            if not options:
                raise TaxonomyError(f"The dropdown {label!r} needs at least one choice.")
            clean["options"] = options
        types = q.get("types")
        if isinstance(types, list):
            kept = [str(t).strip() for t in types if str(t).strip()][:20]
            if kept:
                clean["types"] = kept
        placeholder = str(q.get("placeholder") or "").strip()
        if placeholder:
            clean["placeholder"] = placeholder[:QUESTION_LABEL_MAX]
        out.append(clean)
    if len(out) > QUESTIONS_MAX:
        raise TaxonomyError(f"{topic!r} has too many questions ({QUESTIONS_MAX} max) - keep it quick to fill in.")
    return out


def question_label(db: Session, key: str) -> str:
    """The label an admin gave a topic question, for the activity feed; "" if none."""
    for g in get_config(db).get("helpTopics") or []:
        for tp in g.get("topics") or []:
            for q in tp.get("questions") or []:
                if q.get("key") == key:
                    return q.get("label") or ""
    return ""


def _clean_help_topics(groups: Any) -> list:
    if not isinstance(groups, list):
        raise TaxonomyError("helpTopics must be a list.")
    out = []
    for g in groups:
        if not isinstance(g, dict):
            raise TaxonomyError("Each help-topic group must be an object.")
        depts = [str(d).strip().lower() for d in (g.get("departments") or []) if str(d).strip()]
        topics = []
        for tp in g.get("topics") or []:
            name = str((tp or {}).get("name") or "").strip() if isinstance(tp, dict) else ""
            if not name:
                continue
            if len(name) > TOPIC_MAX_LEN:
                raise TaxonomyError(f"Help topic {name!r} is too long ({TOPIC_MAX_LEN} characters max).")
            topic = {"name": name, "area": str(tp.get("area") or "general").strip().lower()}
            options = _clean_options(name, tp.get("options"))
            if options:
                topic["options"] = options
            if "questions" in tp and tp["questions"] is not None:
                topic["questions"] = _clean_questions(name, tp["questions"])
            topics.append(topic)
        out.append({"label": str(g.get("label") or "").strip(), "departments": depts, "topics": topics})
    return out


def topic_area(db: Session, name: str) -> str:
    """The service area of a curated help topic, or "" when `name` is not one
    (an External Links app, or an "Other" answer typed by the requester)."""
    key = (name or "").strip().lower()
    if not key:
        return ""
    for g in get_config(db).get("helpTopics") or []:
        for tp in g.get("topics") or []:
            if (tp.get("name") or "").strip().lower() == key:
                return tp.get("area") or "general"
    # A ticket filed under a topic name from before the Oct 1 rename/split
    # still files under the area that topic had.
    for legacy in _LEGACY_TOPIC_NAMES.get(key, []):
        area = topic_area(db, legacy)
        if area:
            return area
    return ""


def get_config(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        merged = json.loads(json.dumps(_DEFAULTS))
        _fill_approval_defaults(merged["types"])
        return merged
    try:
        cfg = json.loads(row.value)
    except (TypeError, ValueError):
        cfg = {}
    merged = json.loads(json.dumps(_DEFAULTS))
    merged["slaTargetHours"] = {**_DEFAULT_SLA_HOURS, **(cfg.get("slaTargetHours") or {})}
    merged["types"] = {k: dict(v) for k, v in (cfg.get("types") or {}).items() if isinstance(v, dict)}
    _fill_approval_defaults(merged["types"])
    if isinstance(cfg.get("typeOrder"), list):
        merged["typeOrder"] = cfg["typeOrder"]
    if isinstance(cfg.get("helpTopics"), list):
        merged["helpTopics"] = cfg["helpTopics"]
        if not isinstance(cfg.get("helpTopicsVersion"), int) or cfg["helpTopicsVersion"] < HELP_TOPICS_VERSION:
            merged["helpTopics"] = _upgrade_help_topics(cfg["helpTopics"])
    cf = cfg.get("companyField") or {}
    merged["companyField"] = {
        "enabled": bool(cf.get("enabled")),
        "companyIds": [c for c in (cf.get("companyIds") or []) if isinstance(c, str) and c],
    }
    return merged


def save_config(db: Session, patch: dict, actor_email: str) -> dict:
    if not isinstance(patch, dict):
        raise TaxonomyError("Settings must be an object.")
    if "types" in patch:
        _validate_types_patch(patch["types"])
    merged = get_config(db)
    if "slaTargetHours" in patch and isinstance(patch["slaTargetHours"], dict):
        merged["slaTargetHours"] = {**merged["slaTargetHours"], **patch["slaTargetHours"]}
    if "types" in patch:
        # Per-type entries replace wholesale (the editor always sends a type's
        # full entry). A default-gated type whose entry arrives without the
        # flag keeps its default (True) rather than silently losing its gate.
        merged["types"] = {**merged["types"], **{k: dict(v) for k, v in patch["types"].items()}}
        _fill_approval_defaults(merged["types"])
    if "typeOrder" in patch:
        merged["typeOrder"] = patch["typeOrder"]
    if "helpTopics" in patch:
        merged["helpTopics"] = _clean_help_topics(patch["helpTopics"])
    if "companyField" in patch and isinstance(patch["companyField"], dict):
        incoming = patch["companyField"]
        merged["companyField"] = {
            "enabled": bool(incoming.get("enabled", merged["companyField"]["enabled"])),
            "companyIds": [c for c in (incoming.get("companyIds", merged["companyField"]["companyIds"]) or [])
                           if isinstance(c, str) and c],
        }
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    from datetime import datetime, timezone
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


def sla_hours(db: Session, priority: str) -> int:
    """The authoritative SLA target hours for a priority - used by
    _sla_due_from_priority in routers/tickets.py so a saved admin override
    takes effect immediately, server-side, without a redeploy."""
    cfg = get_config(db)
    hours = cfg["slaTargetHours"]
    return hours.get(priority, hours["medium"])


def company_field(db: Session) -> dict:
    """The authoritative company-field intake setting - used by create_ticket
    and update_ticket in routers/tickets.py to decide whether a plain
    requester's own company_id choice is honoured, same never-trust-the-UI-
    alone posture as every other permission check in that file."""
    return get_config(db)["companyField"]


def requires_approval(db: Session, type_: str) -> bool:
    """Whether a ticket of this type, created (or re-typed) NOW, parks for
    approval. The authoritative read for create_ticket / update_ticket in
    routers/tickets.py, through the same get_config path sla_hours and
    company_field use, so a saved switch takes effect on the next ticket with
    no redeploy.

    Only ever consulted at the moment the gate is decided. The outcome is
    stored on the ticket (approval_status), so turning the switch on or off
    later never re-gates, releases or otherwise changes an existing ticket."""
    key = (type_ or "").strip()
    entry = get_config(db)["types"].get(key)
    flag = entry.get("requiresApproval") if isinstance(entry, dict) else None
    if isinstance(flag, bool):
        return flag
    return key in DEFAULT_APPROVAL_TYPES
