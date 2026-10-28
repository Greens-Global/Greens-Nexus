"""One map from "where a change happened" to the module the Audit Log files it
under (Oct 20 2026, unified audit log).

Three things name a place in Nexus and they never agreed:
  - audit_logs.resource_type - the first URL segment ("hr", "task-tickets",
    "external-auth", and older hand-written rows like "employee" or
    "external_auth"),
  - a table name the change capture saw ("nexus_employees", "task_comments"),
  - a history table the feed folds in ("shift_change_log").

Everything goes through module_for_resource / module_for_table, so a filter
on "People" finds the URL rows, the table changes and the history rows alike.
Unit-tested in test_audit_unified.py - add a new router's prefix or a new
table family HERE, not at a call site.
"""
from __future__ import annotations

import re

# (key, label) in the order the filter dropdown shows them.
MODULES: list[tuple[str, str]] = [
    ("people", "People & HR"),
    ("time", "Time & Shifts"),
    ("tasks", "Tasks & Projects"),
    ("tickets", "Tickets"),
    ("inventory", "Inventory"),
    ("assets", "Assets & Property"),
    ("accounting", "Accounting"),
    ("pfs", "Personal Financial Statements"),
    ("leasing", "Leasing"),
    ("operations", "Operations"),
    ("documents", "Documents & E-Sign"),
    ("knowledge", "Knowledge Base"),
    ("marketing", "Marketing"),
    ("vault", "Credential Vault"),
    ("investors", "Investor Relations"),
    ("purchasing", "Purchasing"),
    ("settings", "Settings & Admin"),
    ("security", "Security & Sign-In"),
    ("system", "System"),
    ("other", "Other"),
    ("workflows", "Workflows"),   # Oct 28 2026 - appended, never reordered
]
MODULE_LABELS = dict(MODULES)
MODULE_KEYS = [k for k, _ in MODULES]

# First URL segment (and legacy resource_type spellings) -> module. Exact
# matches first; _RESOURCE_PREFIXES catches families ("task-*", "ops-*").
_RESOURCES: dict[str, str] = {
    # People & HR
    "hr": "people", "myhr": "people", "employee": "people", "employees": "people",
    "jobroles": "people", "groups": "people", "access-scopes": "people",
    "leave-balances": "people", "hr-reminder-settings": "people", "directory": "people",
    "payroll-readiness": "people", "reimbursements": "people", "policy": "people",
    "me": "people", "life-events": "people",
    # Time & Shifts
    "timeclock": "time", "timesheet-review": "time", "ca-breaks": "time", "ca-review": "time",
    "workforce-scorecard": "time", "shifts": "time", "shift-requests": "time",
    "approval-delegations": "time", "timecard-notes": "time",
    # Tasks
    "tasks": "tasks", "task-prefs": "tasks", "assistant": "tasks", "briefing-actions": "tasks",
    "daily-briefing": "tasks", "weekly-digest": "tasks", "mail-actions": "tasks",
    "outlook-addin": "tasks", "qa": "tasks",
    # Tickets
    "task-tickets": "tickets", "tickets": "tickets", "ticket-departments": "tickets",
    "ticket-saved-replies": "tickets", "ticket-ai": "tickets", "task-ticket-components": "tickets",
    "task-ticket-views": "tickets", "ticket-walkthroughs": "tickets", "ticket-property": "tickets",
    "support": "tickets",
    # Inventory
    "items": "inventory", "inventory-requests": "inventory", "requisitions": "inventory",
    "hardware-assets": "inventory", "equipment-reminder-settings": "inventory",
    # Assets & Property
    "assets": "assets", "property-assets": "assets", "properties": "assets",
    "third-party": "assets", "site-models": "assets",
    # Accounting
    "accounting": "accounting",
    # PFS
    "pfs": "pfs", "pfs-access": "pfs",
    # Leasing
    "leasing": "leasing",
    # Operations
    "ops-projects": "operations", "ops-facilities": "operations", "operations": "operations",
    "unit-map": "operations", "weather": "operations", "weather-call": "operations",
    "weather-watch": "operations", "construction": "operations", "market": "operations",
    "implementation": "operations", "unifi": "operations", "dev-projects": "operations",
    # Documents
    "documents": "documents", "esign": "documents", "files": "documents", "egnyte": "documents",
    "egnyte-oauth": "documents",
    # Knowledge
    "knowledge-base": "knowledge", "sop-updates": "knowledge", "help": "knowledge",
    # Marketing
    "marketing": "marketing", "marketing-campaigns": "marketing", "reviews": "marketing",
    "websites": "marketing",
    # Vault
    "credentials": "vault", "vault": "vault", "credvault": "vault",
    # Investors
    "investor-relations": "investors",
    # Purchasing
    "purchase-requests": "purchasing", "purchases": "purchasing",
    # Settings & Admin
    "roles": "settings", "branding": "settings", "security-settings": "settings",
    "external-links": "settings", "personal-links": "settings", "link-layout": "settings",
    "dashboards": "settings", "dashboard": "settings", "notifications": "settings",
    "settings": "settings", "global-settings": "settings", "audit-logs": "settings",
    "audit": "settings", "tours": "settings", "announcements": "settings",
    "external-users": "settings",
    # Security & Sign-In
    "auth": "security", "act-as": "security", "stepup": "security", "external-auth": "security",
    "external_auth": "security", "security_settings": "settings", "bff": "security",
    "login": "security",
    # System
    "client-errors": "system", "health": "system", "version": "system", "system": "system",
    "dev-notes": "settings",   # Build Mode pins, sessions, Build Tokens (Oct 24 2026)
    "workflows": "workflows",  # Workflows: publish, pause, re-own, restore, settings (Oct 28 2026)
}
_RESOURCE_PREFIXES: list[tuple[str, str]] = [
    ("task-ticket", "tickets"), ("ticket", "tickets"),
    ("task-", "tasks"), ("ops-", "operations"), ("facility", "operations"),
    ("hr-", "people"), ("hr_", "people"), ("accounting", "accounting"), ("pfs", "pfs"),
    ("marketing", "marketing"), ("lease", "leasing"), ("esign", "documents"),
    ("egnyte", "documents"), ("weather", "operations"), ("shift", "time"),
]

# Table name -> module: exact names first, then prefixes.
_TABLES: dict[str, str] = {
    "nexus_employees": "people", "nexus_roles": "settings", "nexus_groups": "people",
    "nexus_group_members": "people", "nexus_access_scopes": "people",
    "hr_removed_identities": "people", "payroll_rates": "time", "payroll_rate_history": "time",
    "policy_acknowledgments": "people", "expense_reimbursements": "people", "leave_ledger": "people",
    "approval_delegations": "time", "time_off_requests": "time", "punch_requests": "time",
    "timesheet_reviews": "time", "timecard_notes": "time", "time_break_premiums": "time",
    "ca_meal_waivers": "time", "ca_review_resolutions": "time", "scheduled_shifts": "time",
    "schedule_day_notes": "time", "monitoring_policy": "time", "monitoring_consent": "time",
    "track_consent": "time", "app_ratings": "time",
    "tasks": "tasks", "task_comments": "tasks", "task_activity": "tasks",
    "task_tickets": "tickets", "ticket_departments": "tickets", "ticket_batches": "tickets",
    "ticket_maintenance_records": "tickets", "ticket_saved_replies": "tickets",
    "ticket_item_links": "tickets", "task_ticket_components": "tickets",
    "items": "inventory", "item_checkouts": "inventory", "item_cart": "inventory",
    "item_assignments": "inventory", "item_custom_fields": "inventory", "item_types": "inventory",
    "inventory_requests": "inventory", "inventory_items": "inventory", "requisitions": "inventory",
    "approval_history": "inventory", "hardware_assets": "inventory",
    "assets": "assets", "property_assets": "assets", "property_records": "assets",
    "property_activity_logs": "assets", "property_workspace_meta": "assets",
    "property_maintenance_services": "assets", "site_model_markups": "assets",
    "recurring_expenses": "accounting", "ramp_transactions": "accounting",
    "accounting_trx": "accounting", "ama_entities": "accounting",
    "leases": "leasing", "lease_rates": "leasing", "lease_months": "leasing",
    "ops_projects": "operations", "dev_projects": "operations",
    "documents": "documents", "doc_folders": "documents", "doc_letterheads": "documents",
    "doc_templates": "documents", "doc_versions": "documents", "doc_template_versions": "documents",
    "lms_courses": "knowledge", "sop_updates": "knowledge", "page_help": "knowledge",
    "reviews": "marketing", "websites": "marketing",
    "purchase_requests": "purchasing",
    "external_links": "settings", "external_link_taxonomy": "settings", "personal_links": "settings",
    "nexus_settings": "settings", "dashboard_views": "settings", "user_link_layouts": "settings",
    "link_layout_views": "settings", "link_icons": "settings", "nexus_announcements": "settings",
    "nexus_counters": "system", "users": "settings",
    "act_as_sessions": "security", "external_login_codes": "security",
    "stepup_sessions": "security", "server_sessions": "security",
    "agent_devices": "time", "agent_pairings": "time", "agent_releases": "system",
    "live_view_sessions": "time",
}
_TABLE_PREFIXES: list[tuple[str, str]] = [
    ("hr_sign_", "documents"), ("hr_document", "people"), ("hr_", "people"),
    ("time_", "time"), ("shift_", "time"), ("shifts", "time"),
    ("task_ticket", "tickets"), ("ticket_", "tickets"), ("task_", "tasks"), ("qa_", "tasks"),
    ("kb_", "knowledge"), ("pfs_", "pfs"), ("vault_", "vault"), ("ir_", "investors"),
    ("accounting_", "accounting"), ("marketing_", "marketing"), ("ops_", "operations"),
    ("cubby_", "operations"), ("weather_", "operations"), ("construction_", "operations"),
    ("third_party_", "assets"), ("changelog_", "settings"), ("egnyte_", "documents"),
    ("nexus_", "settings"), ("asana_", "tasks"), ("item_", "inventory"),
]

DENIED_ACTIONS = ("Authorization denied", "Authentication failed")

# Tables whose INSERT is somebody saying something - the event is a comment.
COMMENT_TABLES = frozenset({"task_comments", "kb_comments", "task_changelog_comments",
                            "accounting_ama_messages", "changelog_feedback"})
# First URL segments that are signing in / proving identity.
LOGIN_RESOURCES = frozenset({"auth", "bff", "external-auth", "external_auth", "login", "stepup",
                             "pfs-access"})
# History tables the capture also sees - never the "main" record of an event.
HISTORY_TABLES = frozenset({"task_activity", "shift_change_log", "approval_history",
                            "payroll_rate_history", "ops_revenue_audit", "property_activity_logs",
                            "pfs_access_log", "vault_access_logs", "changelog_entry_history",
                            "hr_stage_events", "hr_sign_events"})

KINDS = ("create", "update", "delete", "comment", "login", "denied", "view", "other")


def kind_for(method: str, resource: str, action: str, ops: list) -> str:
    """create|update|delete|comment|login|denied|view|other for one request.
    `ops` is [(table, op), ...] the change capture saw, in order."""
    if action in DENIED_ACTIONS:
        return "denied"
    if _norm(resource) in LOGIN_RESOURCES:
        return "login"
    if any(t in COMMENT_TABLES and op == "insert" for t, op in ops):
        return "comment"
    main = [(t, op) for t, op in ops if t not in HISTORY_TABLES]
    if main:
        op = main[0][1]
        return {"insert": "create", "update": "update", "delete": "delete",
                "bulk_update": "update", "bulk_delete": "delete"}.get(op, "other")
    m = (method or "").upper()
    if m == "GET":
        return "view"
    return {"POST": "create", "PUT": "update", "PATCH": "update", "DELETE": "delete"}.get(m, "other")

# Machine telemetry: requests the desktop agent, the phone tracker and the
# browser send on a timer. They were ~99% of audit_logs (Oct 2026: 27k agent
# activity + 27k check-ins + 4k screenshots in 2 days against 70 real punches)
# and buried every real change, so AuditMiddleware no longer writes them.
# Old rows stay; the feed hides them unless "Show System Activity" is on.
# Regexes on the full path.
TELEMETRY_PATTERNS: list[str] = [
    r"^/timeclock/agent/(activity|checkin|screenshot)$",   # desktop agent heartbeat + captures
    r"^/timeclock/agent/live/",                            # agent side of live-view signaling
    r"^/timeclock/screenshot$",                            # legacy agent screenshot upload
    r"^/timeclock/track/ping$",                            # phone GPS tracking pings
    r"^/timeclock/location-trail/ping$",                   # location trail pings
    r"^/client-errors",                                    # browser error reports (diagnostics, not changes)
    r"^/tours/[^/]+/seen$",                                # product tour dismissed
    r"^/task-tickets/[^/]+/seen$",                         # ticket opened (read marker)
    r"^/announcements/[^/]+/read$",                        # announcement read marker
    r"^/task-notifications/([^/]+/read|read-all)$",        # bell read markers
    r"^/notifications/[^/]+/read$",
    r"^/notifications/read-all$",
]
_TELEMETRY_RE = re.compile("|".join(f"(?:{p})" for p in TELEMETRY_PATTERNS))

# The same telemetry as it sits in OLD audit_logs rows: the path is inside the
# details JSON (json.dumps writes `"path": "/x..."`). Used as LIKE patterns.
LEGACY_TELEMETRY_PATH_PREFIXES: list[str] = [
    "/timeclock/agent/", "/timeclock/screenshot", "/timeclock/track/ping",
    "/timeclock/location-trail/ping", "/client-errors", "/tours/",
]
LEGACY_TELEMETRY_ACTIONS: list[str] = [
    "Desktop agent saved a screenshot", "Marked notification read",
]


def is_telemetry(path: str) -> bool:
    return bool(_TELEMETRY_RE.search(path or ""))


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def module_for_resource(resource_type: str, action: str = "") -> str:
    """Module of an audit_logs row. 401/403 rows are always Security."""
    if action in DENIED_ACTIONS:
        return "security"
    r = _norm(resource_type)
    if not r:
        return "other"
    if r in _RESOURCES:
        return _RESOURCES[r]
    for prefix, mod in _RESOURCE_PREFIXES:
        if r.startswith(prefix):
            return mod
    return "other"


def module_for_path(path: str) -> str:
    parts = [p for p in (path or "").split("/") if p]
    return module_for_resource(parts[0] if parts else "")


def module_for_table(table: str) -> str:
    t = _norm(table)
    if t in _TABLES:
        return _TABLES[t]
    for prefix, mod in _TABLE_PREFIXES:
        if t.startswith(prefix):
            return mod
    return "other"


def resource_types_for(module: str) -> list[str]:
    """Every exact resource_type spelling that maps to `module` (for an IN
    filter on legacy rows). Prefix families are matched with LIKE by the
    caller via resource_prefixes_for."""
    return sorted(r for r, m in _RESOURCES.items() if m == module)


def resource_prefixes_for(module: str) -> list[str]:
    return [p for p, m in _RESOURCE_PREFIXES if m == module]


# ── record types ──────────────────────────────────────────────────────────────
# Friendly record type <-> table. The API takes either spelling.
RECORD_TYPES: dict[str, str] = {
    "task": "tasks", "ticket": "task_tickets", "comment": "task_comments",
    "person": "nexus_employees", "employee": "nexus_employees", "item": "items",
    "checkout": "item_checkouts", "assignment": "item_assignments", "shift": "scheduled_shifts",
    "project": "task_projects", "candidate": "hr_candidates", "role": "nexus_roles",
    "group": "nexus_groups", "document": "documents", "lease": "leases",
    "requisition": "requisitions", "credential": "vault_credentials", "punch": "time_punches",
    "time-off": "time_off_requests", "setting": "nexus_settings", "pfs-profile": "pfs_profiles",
}
_TABLE_TO_TYPE = {t: k for k, t in RECORD_TYPES.items() if k not in ("employee",)}

# Noun used in titles ("Updated task ...").
TABLE_NOUNS: dict[str, str] = {
    "tasks": "task", "task_tickets": "ticket", "task_comments": "comment",
    "nexus_employees": "person", "items": "item", "item_checkouts": "checkout",
    "item_assignments": "assignment", "scheduled_shifts": "shift", "task_projects": "project",
    "hr_candidates": "candidate", "nexus_roles": "role", "nexus_groups": "access group",
    "nexus_group_members": "group member", "documents": "document", "leases": "lease",
    "requisitions": "requisition", "vault_credentials": "credential", "time_punches": "punch",
    "time_off_requests": "time-off request", "nexus_settings": "setting",
    "pfs_profiles": "financial statement", "pfs_lines": "statement line",
    "task_attachments": "attachment", "task_sections": "section", "payroll_rates": "pay rate",
    "hr_documents": "HR document", "punch_requests": "punch request",
    "task_activity": "activity entry", "inventory_requests": "inventory request",
}


def record_table(record_type: str) -> str:
    rt = _norm(record_type)
    return RECORD_TYPES.get(rt, rt)


def record_type_for_table(table: str) -> str:
    return _TABLE_TO_TYPE.get(table, table)


def noun_for_table(table: str) -> str:
    if table in TABLE_NOUNS:
        return TABLE_NOUNS[table]
    base = re.sub(r"^(nexus_|hr_|task_)", "", table or "record")
    base = base[:-1] if base.endswith("s") and not base.endswith("ss") else base
    return base.replace("_", " ")


def link_for(table: str, record_id: str) -> dict | None:
    """Where the UI should go to open a record (nexus:navigate detail)."""
    rid = record_id or ""
    if table in ("tasks", "task_comments", "task_attachments"):
        return {"view": "tasks", "sub": "mine", "params": {"taskId": rid} if table == "tasks" else {}}
    if table == "task_tickets":
        return {"view": "tickets", "sub": "", "params": {"ticketId": rid}}
    if table == "nexus_employees":
        return {"view": "hr", "sub": "", "params": {"employeeId": rid}}
    if table in ("items", "item_checkouts", "item_assignments"):
        return {"view": "inventory", "sub": "", "params": {"itemId": rid} if table == "items" else {}}
    if table in ("scheduled_shifts", "shift_requests"):
        return {"view": "shifts", "sub": "schedule", "params": {}}
    if table.startswith("time_") or table in ("punch_requests", "timesheet_reviews"):
        return {"view": "hr", "sub": "hr-time", "params": {}}
    if table.startswith("hr_sign_") or table.startswith("doc"):
        return {"view": "documents", "sub": "", "params": {}}
    if table in ("nexus_roles", "nexus_groups", "nexus_group_members", "nexus_access_scopes"):
        return {"view": "admin-console", "sub": "access", "params": {}}
    if table.startswith("pfs_"):
        return {"view": "accounting", "sub": "pfs", "params": {}}
    if table.startswith("accounting_"):
        return {"view": "accounting", "sub": "", "params": {}}
    if table.startswith("leases") or table.startswith("lease_"):
        return {"view": "accounting", "sub": "leasing", "params": {}}
    return None


# ── field labels ──────────────────────────────────────────────────────────────
FIELD_LABELS: dict[str, str] = {
    "body": "Comment", "title": "Title", "subject": "Subject", "status": "Status",
    "due_on": "Due Date", "due_date": "Due Date", "start_on": "Start Date",
    "assignee_email": "Assignee", "assigned_to_email": "Assigned To",
    "employee_email": "Employee", "work_email": "Work Email", "first_name": "First Name",
    "last_name": "Last Name", "manager_email": "Manager", "backup_manager_email": "Backup Manager",
    "job_title": "Job Title", "department": "Department", "priority": "Priority",
    "description": "Description", "notes": "Notes", "note": "Note", "role": "Role",
    "work_date": "Work Date", "start_time": "Start Time", "end_time": "End Time",
    "created_at": "Created At", "updated_at": "Updated At", "deleted_at": "Deleted At",
    "completed": "Completed", "completed_at": "Completed At", "pinned": "Pinned",
    "author_email": "Author", "resolved_at": "Resolved At", "resolved_by": "Resolved By",
    "url": "URL", "photo_url": "Photo", "ip": "IP Address",
}


def field_label(col: str) -> str:
    if col in FIELD_LABELS:
        return FIELD_LABELS[col]
    words = [w for w in re.split(r"[_\s]+", col or "") if w]
    out = []
    for w in words:
        lw = w.lower()
        out.append({"id": "ID", "url": "URL", "ip": "IP", "pto": "PTO", "ot": "OT",
                    "sso": "SSO", "pdf": "PDF", "kb": "KB"}.get(lw, w[:1].upper() + w[1:]))
    return " ".join(out) or col
