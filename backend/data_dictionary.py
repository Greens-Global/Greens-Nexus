"""Live data dictionary for Support > System & Design (Sep 19, Pranshu: a
Support card listing every backend table, grouped by module, "should get
updated automatically if something new is created, deleted, altered... all in
real time"). Reads straight off models.py/construction_models.py's actual
SQLAlchemy metadata and source text on every request - there is no
hand-maintained snapshot to drift out of sync. A table that's renamed,
dropped, or added shows up here the moment the backend restarts with the new
code, with zero authoring required.

Domain grouping is a prefix/keyword heuristic over table names (see
_DOMAINS), not a hand-tagged list of 200 individual tables - a new table
whose name starts with a recognized prefix ("hr_", "task_", "vault_", ...)
lands in the right bucket automatically; an unrecognized prefix lands in
"Other" until a rule is added below. Field descriptions come from the Python
source itself: a class's docstring becomes the table description, and a
column's own trailing "# ..." comment (or the comment block immediately
above it) becomes the field description - the same comments engineers
already read when working on these models, not a second copy to keep in
step.
"""
import os
import re

from database import Base
import models as _models_module

try:
    import construction_models as _construction_models_module
except ImportError:
    _construction_models_module = None

_SOURCE_MODULES = [m for m in (_models_module, _construction_models_module) if m]

# (key, label, icon, blurb, matcher) - evaluated in order, first match wins.
# matcher(table_name) -> bool. Keep specific/prefixed rules before broad ones.
_DOMAINS = [
    ("core", "Core Business", "Building2",
     "The foundational records almost everything else points at - people, companies, departments, and sites.",
     lambda t: t in {
         "nexus_employees", "hr_entities", "hr_departments", "hr_work_sites",
         "hr_company_holidays", "hr_manual_signatures", "ticket_departments",
         "users", "hr_removed_identities",
     }),
    ("esign", "E-Signature", "FileSignature",
     "Native e-signature requests, sealed PDFs, and the audit trail behind them.",
     lambda t: t.startswith("hr_sign_") or t == "hr_document_classes"),
    ("hr", "HR & Payroll", "Users",
     "Hiring, leave, payroll, shifts, and everything else about an employee's own record.",
     lambda t: t.startswith("hr_") or "shift" in t or t in {
         "payroll_rates", "time_off_requests", "hr_interview_templates", "hr_interviews",
     }),
    ("time", "Time & Workforce Analytics", "Clock",
     "Punches, screenshots, GPS pings, and the disclosed-monitoring policy that gates them.",
     lambda t: t.startswith("time_") or t.startswith("track_") or t.startswith("monitoring_")
     or t in {"agent_devices", "agent_releases", "agent_pairings", "agent_activity",
              "live_view_sessions", "punch_requests", "policy_acknowledgments", "app_ratings"}),
    ("documents", "Document Library", "FolderOpen",
     "File storage, letterhead templates, and versioned documents.",
     lambda t: t.startswith("doc_") or t in {"documents", "document_versions"}),
    ("kb", "Knowledge Base", "BookOpen",
     "SOPs, courses, and the help content shown inline across the app.",
     lambda t: t.startswith("kb_") or t == "page_help"),
    ("vault", "Credential Vault", "KeyRound",
     "Shared and personal credentials, one-time access grants, and step-up auth sessions.",
     lambda t: t.startswith("vault_") or t == "stepup_sessions"),
    ("tickets", "Tickets / Service Desk", "Ticket",
     "The help-desk queue - tickets, components, and their email/notification trail.",
     lambda t: t == "task_tickets" or t.startswith("ticket_") or t == "task_ticket_components"),
    ("tasks", "Tasks & Projects", "CheckSquare",
     "The task/project engine - boards, automations, templates, and the archived Asana link records.",
     lambda t: t == "tasks" or t.startswith("task_") or t.startswith("asana_")),
    ("construction", "Construction", "HardHat",
     "The Construction module - projects, daily logs, RFIs, submittals, and site media.",
     lambda t: t.startswith("construction_")),
    ("items", "Item & Inventory Management", "Package",
     "Checkouts, permanent assignments, and the custom fields/types admins define for them.",
     lambda t: t == "items" or t.startswith("item_") or t.startswith("inventory_")
     or t in {"hardware_assets", "requisitions"}),
    ("assets", "Asset / Property Management", "Home",
     "Property portfolio records and their activity log.",
     lambda t: t.startswith("property_") or t == "assets"),
    ("investor", "Investor Relations", "Landmark",
     "Funds, investors, capital calls, and distributions.",
     lambda t: t.startswith("ir_")),
    ("qa", "QA & Testing", "FlaskConical",
     "Test cases, runs, results, and bug reports for the in-app QA module.",
     lambda t: t.startswith("qa_")),
    ("security", "Security & Access", "Shield",
     "Roles, access grants, audit trail, and session-level controls.",
     lambda t: t in {
         "nexus_roles", "nexus_groups", "nexus_group_members", "nexus_access_scopes",
         "audit_logs", "external_login_codes", "act_as_sessions", "server_sessions",
         "approval_history",
     }),
    ("integrations", "Links, Dashboards & Integrations", "Link2",
     "The External Links/Personal Links launcher, saved dashboards, and third-party syncs (Egnyte, M365).",
     lambda t: t.startswith("external_link") or t.startswith("egnyte_") or t in {
         "personal_links", "link_icons", "user_link_layouts", "link_layout_views",
         "dashboard_views", "m365_sync_runs",
     }),
    ("marketing", "Marketing", "Megaphone",
     "Campaign tracking for the Marketing module.",
     lambda t: t.startswith("marketing_")),
    ("system", "System & Notifications", "Settings2",
     "App-wide settings, in-app notifications, and per-person UI state.",
     lambda t: t in {
         "nexus_notifications", "nexus_settings", "changelog_seen", "nexus_daily_briefing_log",
         "user_tour_state", "task_table_prefs",
     }),
    ("legacy", "Legacy / Other", "Archive",
     "Early tables that predate the current module set - kept for existing data, not necessarily wired up.",
     lambda t: t in {
         "reviews", "websites", "ama_entities", "ops_projects", "dev_projects",
         "lms_courses", "sop_updates", "purchase_requests", "accounting_trx",
         "ramp_transactions",
     }),
]
_FALLBACK_DOMAIN = ("other", "Other", "Boxes", "Tables that don't yet match a rule above - not necessarily unused, just uncategorized.", lambda t: True)


def _domain_for(table_name: str):
    for entry in _DOMAINS:
        if entry[4](table_name):
            return entry
    return _FALLBACK_DOMAIN


def _humanize(attr: str) -> str:
    """snake_case column attribute -> "Title Case" field label, same
    transform the reference screenshots show ("full_name" -> "Full name")."""
    words = attr.replace("_", " ").split()
    if not words:
        return attr
    return " ".join([words[0].capitalize()] + words[1:])


_TYPE_FALLBACKS = {
    "BOOLEAN": "Yes/no flag.",
    "INTEGER": "Whole number.",
    "FLOAT": "Decimal number.",
    "JSON": "Structured (JSON) data.",
    "TEXT": "Long free text.",
    "BIGINTEGER": "Whole number.",
    "LARGEBINARY": "Binary data.",
}


def _source_cache():
    """(mtime-tuple, concatenated source) - re-read only when a models file's
    mtime actually changes, so this stays "real time" without re-parsing a
    multi-thousand-line file on every single request."""
    stamp = tuple(os.path.getmtime(m.__file__) for m in _SOURCE_MODULES)
    cached = _source_cache._cache
    if cached and cached[0] == stamp:
        return cached[1]
    text = "\n".join(open(m.__file__, encoding="utf-8").read() for m in _SOURCE_MODULES)
    _source_cache._cache = (stamp, text)
    return text


_source_cache._cache = None


def _class_block(source: str, class_name: str) -> str:
    """The source text from `class <class_name>(Base):` up to (not including)
    the next top-level `class` line, or EOF."""
    m = re.search(rf"\nclass {re.escape(class_name)}\(Base\):\n", source)
    if not m:
        return ""
    start = m.end()
    nxt = re.search(r"\nclass \w+\(Base\):\n", source[start:])
    return source[start: start + nxt.start()] if nxt else source[start:]


def _column_description(block: str, attr: str) -> str:
    """Trailing `# ...` on the column's own line, else the contiguous block
    of comment lines immediately above it, else ""."""
    lines = block.split("\n")
    for i, line in enumerate(lines):
        if re.match(rf"\s*{re.escape(attr)}\s*=\s*Column\(", line):
            same_line = re.search(r"#\s*(.+)$", line)
            if same_line:
                return same_line.group(1).strip()
            above = []
            j = i - 1
            while j >= 0 and re.match(r"\s*#", lines[j]):
                above.insert(0, re.sub(r"^\s*#\s?", "", lines[j]))
                j -= 1
            return " ".join(above).strip()
    return ""


def build() -> dict:
    """Everything the Data Dictionary UI needs, freshly derived. Cheap enough
    (a few hundred mapped classes, a handful of MB of source text) to build
    on every call - no request-scoped state to keep consistent."""
    source = _source_cache()
    buckets = {}   # domain key -> {label, icon, description, tables: []}
    for mapper in Base.registry.mappers:
        cls = mapper.class_
        table = mapper.local_table
        key, label, icon, blurb, _ = _domain_for(table.name)
        bucket = buckets.setdefault(key, {"key": key, "label": label, "icon": icon, "description": blurb, "tables": []})
        block = _class_block(source, cls.__name__)
        doc = (cls.__doc__ or "").strip()
        # Docstrings here are prose paragraphs (often several sentences with
        # embedded newlines/indentation) - collapse to one clean line for the
        # summary text a Support reader sees, same as the reference's plain-
        # English one-liners per table.
        doc = re.sub(r"\s+", " ", doc)
        fields = []
        for col in table.columns:
            fields.append({
                "name": col.name,
                "label": _humanize(col.name),
                "description": _column_description(block, col.name)
                    or _TYPE_FALLBACKS.get(str(col.type).split("(")[0].upper(), "") ,
                "type": str(col.type).split("(")[0],
                "primaryKey": bool(col.primary_key),
            })
        bucket["tables"].append({
            "name": table.name,
            "className": cls.__name__,
            "description": doc,
            "fieldCount": len(fields),
            "fields": fields,
        })
    for b in buckets.values():
        b["tables"].sort(key=lambda t: t["name"])
    # Domain order follows _DOMAINS' declared order (a deliberate narrative -
    # core first, legacy/other last), not alphabetical.
    ordered_keys = [d[0] for d in _DOMAINS] + [_FALLBACK_DOMAIN[0]]
    domains = [buckets[k] for k in ordered_keys if k in buckets]
    return {
        "domains": domains,
        "tableCount": sum(len(d["tables"]) for d in domains),
        "generatedAt": None,   # set by the caller if it wants a timestamp; this module is stateless
    }
