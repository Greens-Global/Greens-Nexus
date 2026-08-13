import os
from dotenv import load_dotenv
# Must run before any router import: routers/tasks.py (imported below) pulls in
# auth.py, whose SKIP_AUTH is read once at module-import time via os.getenv().
# unifi_client.py also calls load_dotenv(), but only as a side effect of
# routers/unifi being imported later in the line below - by then auth.py has
# already locked in SKIP_AUTH=False, so NEXUS_SKIP_AUTH in backend/.env was
# silently ignored and every request 401'd even with the dev bypass configured.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import text
import models
from database import engine, DATABASE_URL
from routers import timeclock
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions, roles, notifications, audit, groups, items as items_router, hr, knowledge_base, help as help_router, property_assets, esign, dashboards as dashboards_router, myhr, hr_interviews
# NOTE: `inventory_requests` router retired Jul 2026 (P2-1) - legacy inventory stack removed.
from routers import task_projects, task_config  # Task Module (Jul 2026)
from routers import tickets as tickets_router    # Ticket Module - split out of task_config (Jul 2026)
from routers import asana_webhook  # Asana two-way sync - public webhook receiver
from routers import asana_oauth as asana_oauth_router  # Per-user Asana connection (Account Settings)
from routers import egnyte_oauth as egnyte_oauth_router  # Per-user Egnyte connection (browse as yourself)
from routers import construction  # Construction module - jobsite daily logs, media, weekly reports
from routers import jobroles  # Roles & Access redesign (Jul 2026)
from routers import access_scopes  # row-level scopes for external users (Jul 2026)
from routers import qa  # Testing module - dev-only via NEXUS_QA_MODULE env (Jul 2026)
from routers import credvault  # Credential Vault (Jul 2026)
from routers import policy  # Sign-in company-policy & monitoring acknowledgment (Jul 2026)
from routers import documents as documents_router  # Documents DMS Phase 1 (Jul 2026)
from routers import investor_relations  # Investor Relations platform (Jul 2026)
from routers import stepup  # Step-up MFA for sensitive data (vault/payroll/HR) (Jul 2026)
import act_as  # Act As: Manager/IT Admin/Global Admin can impersonate a lower-role employee (Jul 2026)
from routers import branding  # Branding settings: login-screen accent color (Jul 2026)
from routers import egnyte  # Egnyte module: browse/upload at the right folder level (Jul 2026)
from routers import external_links  # External Links directory rebuild (Aug 2026) - own file, see its docstring
from audit import AuditMiddleware


def _run_migrations():
    """Add columns that were introduced after the initial table creation."""
    if DATABASE_URL.startswith("sqlite"):
        # create_all builds NEW tables but never alters existing ones - columns
        # added to models after a local DB was created must be patched in here
        # (a model column missing from the DB breaks every SELECT with a 500).
        # SQLite has no IF NOT EXISTS for columns; duplicates just error and
        # are swallowed.
        sqlite_migrations = [
            "ALTER TABLE payroll_rates ADD COLUMN overtime_rule VARCHAR DEFAULT 'ca'",
            "ALTER TABLE payroll_rates ADD COLUMN pay_type VARCHAR DEFAULT 'hourly'",
            "ALTER TABLE payroll_rates ADD COLUMN currency VARCHAR DEFAULT 'USD'",
            "ALTER TABLE payroll_rates ADD COLUMN monthly_salary FLOAT DEFAULT 0",
            "ALTER TABLE payroll_rates ADD COLUMN weekend_ot_amount FLOAT DEFAULT 0",
            "ALTER TABLE payroll_rates ADD COLUMN full_day_hours FLOAT DEFAULT 8",
            "ALTER TABLE agent_activity ADD COLUMN domain VARCHAR DEFAULT ''",
            "ALTER TABLE agent_activity ADD COLUMN category VARCHAR DEFAULT ''",
            "ALTER TABLE time_screenshots ADD COLUMN bucket VARCHAR DEFAULT ''",
            "ALTER TABLE time_screenshots ADD COLUMN session_id VARCHAR DEFAULT ''",
            "ALTER TABLE agent_devices ADD COLUMN active_email VARCHAR DEFAULT ''",
            "ALTER TABLE agent_devices ADD COLUMN active_session_id VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN picture_required BOOLEAN DEFAULT 1",
            "ALTER TABLE items ADD COLUMN asset_value FLOAT DEFAULT 0",
            "UPDATE items SET status = 'available' WHERE ownership_type = 'permanent' AND COALESCE(assigned_to_email, '') = '' AND status = 'permanently_assigned'",
            "ALTER TABLE requisitions ADD COLUMN allocator_email VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN allocator_name VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN ordered_at VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN fulfilled_at VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN fulfillment_note VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN fulfilled_item_id VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN submitted_by_email VARCHAR DEFAULT ''",
            "ALTER TABLE requisitions ADD COLUMN submitted_by_name VARCHAR DEFAULT ''",
            # items: operational status, location-assignment, custom fields, soft-delete (Jun 2026 item-module batch)
            "ALTER TABLE items ADD COLUMN op_status VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN assigned_to_location VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN custom_fields TEXT DEFAULT '{}'",
            "ALTER TABLE items ADD COLUMN deleted_at VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN deleted_by VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN deleted_location VARCHAR DEFAULT ''",
            # items: person an op_status (lost/retired) is declared against
            "ALTER TABLE items ADD COLUMN op_status_person_email VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN op_status_person_name VARCHAR DEFAULT ''",
            # knowledge_base: require sign-off flag + analytics/freshness/retention
            "ALTER TABLE kb_documents ADD COLUMN require_ack BOOLEAN DEFAULT 0",
            "ALTER TABLE kb_documents ADD COLUMN views INTEGER DEFAULT 0",
            "ALTER TABLE kb_documents ADD COLUMN review_every_months INTEGER DEFAULT 12",
            "ALTER TABLE kb_documents ADD COLUMN verified_at VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN verified_by VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN retention_months INTEGER DEFAULT 84",
            "ALTER TABLE kb_courses ADD COLUMN overview VARCHAR DEFAULT ''",
            "ALTER TABLE kb_courses ADD COLUMN recert_months INTEGER DEFAULT 0",
            "ALTER TABLE kb_documents ADD COLUMN stale_notified_at VARCHAR DEFAULT ''",
            # audit_logs: track when an entry was reverted via the Undo action
            "ALTER TABLE audit_logs ADD COLUMN undone_at VARCHAR DEFAULT ''",
            "ALTER TABLE audit_logs ADD COLUMN undone_by VARCHAR DEFAULT ''",
            # E-Sign multi-document packets (template attachments)
            "ALTER TABLE hr_sign_templates ADD COLUMN attachments JSON",
            "ALTER TABLE hr_sign_requests ADD COLUMN documents JSON",
            # E-Sign routing (sequential/parallel), CC recipients, external access codes
            "ALTER TABLE hr_sign_requests ADD COLUMN routing VARCHAR DEFAULT 'sequential'",
            "ALTER TABLE hr_sign_parties ADD COLUMN party_role VARCHAR DEFAULT 'signer'",
            "ALTER TABLE hr_sign_parties ADD COLUMN access_code VARCHAR DEFAULT ''",
            # E-Sign: Egnyte folder for a copy of the sealed PDF
            "ALTER TABLE hr_sign_templates ADD COLUMN egnyte_folder VARCHAR DEFAULT ''",
            "ALTER TABLE hr_sign_requests ADD COLUMN egnyte_folder VARCHAR DEFAULT ''",
            # E-Sign: tamper-evident audit hash chain + public verification QR
            "ALTER TABLE hr_sign_events ADD COLUMN seq INTEGER DEFAULT 0",
            "ALTER TABLE hr_sign_events ADD COLUMN event_hash VARCHAR DEFAULT ''",
            "ALTER TABLE hr_sign_requests ADD COLUMN verify_token VARCHAR DEFAULT ''",
            "ALTER TABLE time_bod ADD COLUMN kind VARCHAR DEFAULT 'bod'",
            "ALTER TABLE time_bod ADD COLUMN html VARCHAR DEFAULT ''",
            "ALTER TABLE time_bod ADD COLUMN attempts INTEGER DEFAULT 0",
            "ALTER TABLE time_bod ADD COLUMN last_try_at VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN category VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN pending_at VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edit_reason VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edited_by VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edited_at VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edit_status VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edit_reviewed_by VARCHAR DEFAULT ''",
            "ALTER TABLE time_punches ADD COLUMN edit_reviewed_at VARCHAR DEFAULT ''",
            "ALTER TABLE shifts ADD COLUMN code VARCHAR DEFAULT ''",
            "ALTER TABLE shift_groups ADD COLUMN teams_chat_id VARCHAR DEFAULT ''",
            "ALTER TABLE shift_groups ADD COLUMN teams_chat_name VARCHAR DEFAULT ''",
            # Task Module: patch a pre-existing local `tasks` table to the rich schema
            # (fresh SQLite DBs get the new shape straight from create_all).
            "ALTER TABLE tasks DROP COLUMN assignee",
            "ALTER TABLE tasks DROP COLUMN project",
            "ALTER TABLE tasks DROP COLUMN due_date",
            "ALTER TABLE tasks DROP COLUMN hours",
            "ALTER TABLE tasks DROP COLUMN comment",
            "ALTER TABLE tasks DROP COLUMN dept",
            "ALTER TABLE tasks DROP COLUMN synced",
            "ALTER TABLE tasks ADD COLUMN code VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN description VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN type VARCHAR DEFAULT 'task'",
            "ALTER TABLE tasks ADD COLUMN assignee_email VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN owner_email VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN follower_emails JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN liked_by_emails JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN access_level VARCHAR DEFAULT 'org'",
            "ALTER TABLE tasks ADD COLUMN project_id VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN section_id VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN department_id VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN parent_task_id VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN subtask_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN blocked_by_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN blocking_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN dependency_types JSON DEFAULT '{}'",
            "ALTER TABLE tasks ADD COLUMN tags JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN custom_field_values JSON DEFAULT '{}'",
            "ALTER TABLE tasks ADD COLUMN start_on VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN due_on VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN estimate_hours FLOAT",
            "ALTER TABLE tasks ADD COLUMN actual_hours FLOAT",
            "ALTER TABLE tasks ADD COLUMN recurrence JSON",
            "ALTER TABLE tasks ADD COLUMN is_milestone BOOLEAN DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN approval_status VARCHAR DEFAULT 'none'",
            "ALTER TABLE tasks ADD COLUMN completed BOOLEAN DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN completed_at VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN comment_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN attachment_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN activity_ids JSON DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN created_at VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN modified_at VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN created_by VARCHAR DEFAULT ''",
            "ALTER TABLE tasks ADD COLUMN synced_with_asana BOOLEAN DEFAULT 0",
            # Task Module: bug-report screenshots on tickets
            "ALTER TABLE task_tickets ADD COLUMN images JSON DEFAULT '[]'",
            "ALTER TABLE task_tickets ADD COLUMN type VARCHAR DEFAULT 'request'",
            "ALTER TABLE task_tickets ADD COLUMN resolution VARCHAR DEFAULT ''",
            "ALTER TABLE task_tickets ADD COLUMN watcher_emails JSON DEFAULT '[]'",
            "ALTER TABLE task_tickets ADD COLUMN custom_field_values JSON DEFAULT '{}'",
            "ALTER TABLE task_tickets ADD COLUMN type_fields JSON DEFAULT '{}'",
            "ALTER TABLE task_tickets ADD COLUMN links JSON DEFAULT '[]'",
            "ALTER TABLE task_tickets ADD COLUMN task_ids JSON DEFAULT '[]'",
            "ALTER TABLE task_tickets ADD COLUMN component VARCHAR DEFAULT ''",
            "ALTER TABLE task_tickets ADD COLUMN csat_rating INTEGER DEFAULT 0",
            "ALTER TABLE task_tickets ADD COLUMN csat_comment VARCHAR DEFAULT ''",
            "ALTER TABLE task_comments ADD COLUMN internal BOOLEAN DEFAULT 0",
            "ALTER TABLE task_saved_views ADD COLUMN scope VARCHAR DEFAULT 'task'",
            "ALTER TABLE task_tickets ADD COLUMN company_id VARCHAR DEFAULT ''",
            "ALTER TABLE task_tickets ADD COLUMN hr_department_id VARCHAR DEFAULT ''",
            # task_projects.department_ids: the ADD used to live here, with its DROP
            # further down (the task_teams rename). Postgres never reuses a dropped
            # column's slot, so replaying ADD+DROP on every startup x8 workers burned
            # one 1600-limit attribute slot per cycle until dev's task_projects hit
            # the cap (1580 dropped slots, Jul 31). Never re-add an ADD for a column
            # a later line drops - the DROP alone is safe (no-op when absent).
            # Roles & Access redesign: job-role templates live on nexus_groups
            "ALTER TABLE nexus_groups ADD COLUMN is_job_role INTEGER DEFAULT 0",
            "ALTER TABLE nexus_groups ADD COLUMN tier VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_groups ADD COLUMN description VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_groups ADD COLUMN monitoring_exempt INTEGER DEFAULT 0",
            "ALTER TABLE nexus_groups ADD COLUMN default_manager_email VARCHAR DEFAULT ''",
            # Timecard two-step sign-off: manager approve vs HR finalize (locks)
            "ALTER TABLE time_approvals ADD COLUMN kind VARCHAR DEFAULT 'manager'",
            # Company email domains - drive M365 import + auto company tagging
            "ALTER TABLE hr_entities ADD COLUMN domains VARCHAR DEFAULT ''",
            # Company manager (operational head; escalation target)
            "ALTER TABLE hr_entities ADD COLUMN manager_email VARCHAR DEFAULT ''",
            # ── Item Module QA (P2-5, Jul 2026): SQLite was missing columns the
            # Postgres list already carried - a pre-existing local DB 500s on
            # every items/checkouts SELECT without them. (SQLite ALTER has no
            # IF NOT EXISTS; a duplicate just errors and is swallowed below.)
            "ALTER TABLE items ADD COLUMN serial_number VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN assigned_to_email VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN assigned_to_name VARCHAR DEFAULT ''",
            "ALTER TABLE items ADD COLUMN assigned_at VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN order_id VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN handover_photo_by VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN handover_batch BOOLEAN DEFAULT 0",
            "ALTER TABLE item_checkouts ADD COLUMN receipt_photo_url VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN receipt_photo_name VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN handed_over_at VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN extension_days INTEGER DEFAULT 0",
            "ALTER TABLE item_checkouts ADD COLUMN extension_reason VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN extension_status VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN approver_email VARCHAR DEFAULT ''",
            "ALTER TABLE item_checkouts ADD COLUMN approver_name VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_notifications ADD COLUMN read_by VARCHAR DEFAULT ''",
            # serial is the identity + import upsert key - enforce uniqueness
            # (blanks excluded so legacy/not-yet-serialised rows are fine; also
            # stops a local import silently creating duplicate serials).
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_items_serial_unique ON items (serial_number) WHERE serial_number <> ''",
            # ── Item Module hot-path indexes (P2-4) + live-row concurrency guards
            # (P1-1). SQLite supports partial (WHERE) indexes; a partial-unique
            # that can't build over pre-existing duplicate live rows errors here
            # and is swallowed by the per-statement try/except below - never aborts
            # startup. Statuses match the transient/permanent lifecycles.
            "CREATE INDEX IF NOT EXISTS ix_checkout_item_status ON item_checkouts (item_id, status)",
            "CREATE INDEX IF NOT EXISTS ix_checkout_order ON item_checkouts (order_id)",
            "CREATE INDEX IF NOT EXISTS ix_checkout_requested_by ON item_checkouts (requested_by_email)",
            "CREATE INDEX IF NOT EXISTS ix_assignment_item_status ON item_assignments (item_id, status)",
            "CREATE INDEX IF NOT EXISTS ix_assignment_assignee ON item_assignments (assignee_email)",
            "CREATE INDEX IF NOT EXISTS ix_notif_recipient_actioned ON nexus_notifications (recipient, actioned)",
            "CREATE INDEX IF NOT EXISTS ix_notif_ref ON nexus_notifications (ref_id)",
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_checkout_live ON item_checkouts (item_id) WHERE status IN ('pending','approved','pending_receipt','allocated')",
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_assignment_live ON item_assignments (item_id) WHERE status IN ('pending_acceptance','active','return_initiated')",
            # Task Module: "Team" becomes project-scoped (IT Team/QA Team/... WITHIN
            # a project) instead of a flat cross-project list; a project's org
            # classifier is now the real People-module department (Jul 2026).
            # task_teams is a NEW table name, so create_all (which runs before this
            # function) already creates it empty before we get here - a plain
            # RENAME would then fail every time (target already exists) and
            # silently strand the real rows in task_departments forever. Copy
            # instead: INSERT OR IGNORE no-ops on rerun (id is the PK), and the
            # DROP only succeeds once the copy has landed everything.
            "INSERT OR IGNORE INTO task_teams (id, project_id, name, color, icon, member_emails, created_at) "
            "SELECT id, '', name, color, icon, member_emails, created_at FROM task_departments",
            "DROP TABLE IF EXISTS task_departments",
            "ALTER TABLE tasks DROP COLUMN department_id",
            "ALTER TABLE tasks ADD COLUMN team_id VARCHAR DEFAULT ''",
            "ALTER TABLE task_projects DROP COLUMN department_ids",
            "ALTER TABLE task_projects ADD COLUMN hr_department_id VARCHAR DEFAULT ''",
            "ALTER TABLE task_projects ADD COLUMN hr_department_name VARCHAR DEFAULT ''",
            # Project visibility (Jul 2026): mirrors Task.access_level. Existing
            # projects backfill to 'org' (everyone already saw everything) -
            # only newly-created projects default to 'restricted' (create_project).
            "ALTER TABLE task_projects ADD COLUMN access_level VARCHAR DEFAULT 'org'",
            # Ticket triage routing: who assigns a department's incoming tickets
            "ALTER TABLE hr_departments ADD COLUMN lead_email VARCHAR DEFAULT ''",
            "ALTER TABLE hr_departments ADD COLUMN backup_email VARCHAR DEFAULT ''",
            # Ticket approval gate (service/change/access requests)
            "ALTER TABLE task_tickets ADD COLUMN approval_status VARCHAR DEFAULT 'none'",
            "ALTER TABLE task_tickets ADD COLUMN approver_email VARCHAR DEFAULT ''",
            "ALTER TABLE task_tickets ADD COLUMN approval_note VARCHAR DEFAULT ''",
            "ALTER TABLE task_tickets ADD COLUMN approval_decided_at VARCHAR DEFAULT ''",
            # Who handed a ticket to its assignee - TaskTicket.assigned_by_email.
            "ALTER TABLE task_tickets ADD COLUMN assigned_by_email VARCHAR DEFAULT ''",
            # Ticket numbers dropped the "TKT-" prefix and widened to 6 digits
            # (ticket_code.py). Rewrites legacy codes so one format exists;
            # idempotent - after it runs nothing matches TKT-% any more.
            "UPDATE task_tickets SET code = substr('000000' || CAST(CAST(substr(code, 5) AS INTEGER) AS TEXT), -6, 6) WHERE code LIKE 'TKT-%'",
            # Why a per-user Asana grant last failed - AsanaUserToken.last_error.
            "ALTER TABLE asana_user_tokens ADD COLUMN last_error VARCHAR DEFAULT ''",
            "ALTER TABLE asana_user_tokens ADD COLUMN last_error_at VARCHAR DEFAULT ''",
            # Documents (DMS) Phase 4: merge-field subject/company for export
            "ALTER TABLE documents ADD COLUMN employee_id VARCHAR DEFAULT ''",
            "ALTER TABLE documents ADD COLUMN entity_id VARCHAR DEFAULT ''",
            # Documents (DMS) Phase 11: manual merge-field overrides + custom variables
            "ALTER TABLE documents ADD COLUMN merge_overrides JSON DEFAULT '{}'",
            # Documents (DMS) Phase 12: same override/custom-variable support on templates
            "ALTER TABLE doc_templates ADD COLUMN merge_overrides JSON DEFAULT '{}'",
            # Documents (DMS) Phase 13 (Template Builder): merge-field type/required/default/validation metadata
            "ALTER TABLE doc_templates ADD COLUMN field_defs JSON DEFAULT '[]'",
            # ── HR Section A/B (nexus_employees): SQLite was missing columns the
            # Postgres list already carried - a pre-existing local DB 500s on
            # every nexus_employees SELECT without them (same class of bug as
            # the Item Module fix above).
            "ALTER TABLE nexus_employees ADD COLUMN company VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_employees ADD COLUMN contractor JSON DEFAULT '{}'",
            "ALTER TABLE nexus_employees ADD COLUMN personal JSON DEFAULT '{}'",
            "ALTER TABLE nexus_employees ADD COLUMN compensation JSON DEFAULT '{}'",
            "ALTER TABLE nexus_employees ADD COLUMN bank JSON DEFAULT '[]'",
            "ALTER TABLE nexus_employees ADD COLUMN compliance JSON DEFAULT '{}'",
            "ALTER TABLE nexus_employees ADD COLUMN status_log JSON DEFAULT '[]'",
            "ALTER TABLE nexus_employees ADD COLUMN division VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_employees ADD COLUMN identity_type VARCHAR DEFAULT 'internal'",
            "ALTER TABLE nexus_employees ADD COLUMN display_name VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_employees ADD COLUMN designation VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_employees ADD COLUMN deleted_at VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_employees ADD COLUMN deleted_by VARCHAR DEFAULT ''",
            "ALTER TABLE asana_import_jobs ADD COLUMN cancel_requested BOOLEAN DEFAULT 0",
            "ALTER TABLE asana_project_map ADD COLUMN last_pull_at VARCHAR DEFAULT ''",
            "ALTER TABLE asana_project_map ADD COLUMN last_full_pull_at VARCHAR DEFAULT ''",
            "ALTER TABLE asana_import_jobs ADD COLUMN done_gids JSON DEFAULT '[]'",
            "ALTER TABLE asana_import_jobs ADD COLUMN attempts INTEGER DEFAULT 1",
            "ALTER TABLE ir_funds ADD COLUMN property_asset_id VARCHAR DEFAULT ''",
            # Share panel (Jul 2026): per-person/per-team project access role.
            "ALTER TABLE task_projects ADD COLUMN member_roles JSON DEFAULT '{}'",
            "ALTER TABLE task_teams ADD COLUMN access_role VARCHAR DEFAULT 'editor'",
            # A team may now belong to MANY projects (one IT team shared across
            # projects, as Asana does it) - project_ids replaces project_id,
            # which is kept only as a write-only legacy mirror. Backfill folds
            # every existing single assignment into the new list.
            "ALTER TABLE task_teams ADD COLUMN project_ids JSON DEFAULT '[]'",
            # Custom fields: per-project scoping + a required flag. An empty
            # project_ids keeps a field global, which is the pre-scoping
            # behavior, so existing fields keep showing everywhere.
            "ALTER TABLE task_custom_fields ADD COLUMN project_ids JSON DEFAULT '[]'",
            "ALTER TABLE task_custom_fields ADD COLUMN required BOOLEAN DEFAULT 0",
            # Asana formula fields import but can never push back (the API
            # rejects writes) - this marks them so the editors disable them.
            "ALTER TABLE task_custom_fields ADD COLUMN read_only BOOLEAN DEFAULT 0",
            # Asana-derived fields are identified by gid, not by name.
            "ALTER TABLE task_custom_fields ADD COLUMN asana_gid VARCHAR DEFAULT ''",
            "ALTER TABLE task_custom_statuses ADD COLUMN asana_option_gid VARCHAR DEFAULT ''",
            # Custom statuses get the same per-project scoping custom fields
            # already had. Empty = every project, so existing statuses are
            # unchanged until someone narrows one.
            "ALTER TABLE task_custom_statuses ADD COLUMN project_ids JSON DEFAULT '[]'",
            "ALTER TABLE task_custom_statuses ADD COLUMN asana_option_gids JSON DEFAULT '[]'",
            # Setup-only Asana PAT; blank falls back to the service token.
            "ALTER TABLE asana_sync_config ADD COLUMN setup_token VARCHAR DEFAULT ''",
            "UPDATE task_teams SET project_ids = json_array(project_id) "
            "WHERE COALESCE(project_id, '') != '' AND COALESCE(project_ids, '[]') IN ('[]', 'null', '')",
            # Manual override for ad-hoc-shared Asana teams the API can't reveal.
            "ALTER TABLE asana_project_map ADD COLUMN extra_team_names JSON DEFAULT '[]'",
            # One Nexus task per Asana task. On a database that already carries
            # duplicate links this can't build and is swallowed below - run
            # Manage → Asana Sync → "Merge duplicates" (asana_sync.dedupe_tasks),
            # which creates the same index once the duplicates are gone.
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_asana_task_link_gid ON asana_task_links (asana_gid) WHERE asana_gid <> ''",
            # Two-way delete propagation (opt-out; see AsanaSyncConfig.delete_sync).
            "ALTER TABLE asana_sync_config ADD COLUMN delete_sync BOOLEAN DEFAULT 1",
            # Two-Way Sync card's own sync/delete toggles, independent of the
            # Setup card's enabled/delete_sync above - see AsanaSyncConfig and
            # asana_sync.sync_is_on()/delete_sync_is_on().
            "ALTER TABLE asana_sync_config ADD COLUMN manual_sync_enabled BOOLEAN DEFAULT 0",
            "ALTER TABLE asana_sync_config ADD COLUMN manual_delete_sync BOOLEAN DEFAULT 0",
            # The exact rendered body from the original send, reused verbatim on
            # retry instead of re-rendering (which had no comment text to work
            # from for commented/mentioned and could drift from task edits made
            # between the failed attempt and the retry). See TaskEmailLog.html.
            "ALTER TABLE task_email_log ADD COLUMN html VARCHAR DEFAULT ''",
            # Set only for a file attached while composing a comment (blank =
            # today's plain task-level attachment). See TaskAttachment.comment_id.
            "ALTER TABLE task_attachments ADD COLUMN comment_id VARCHAR DEFAULT ''",
            # Push-only digest (tags/followers/dependencies/section/attachments)
            # so the reconcile sweep can skip an unchanged task outright.
            "ALTER TABLE asana_task_links ADD COLUMN last_push_hash VARCHAR DEFAULT ''",
            # Asana-side digest, so a pull only re-applies genuinely changed tasks.
            "ALTER TABLE asana_task_links ADD COLUMN last_inbound_hash VARCHAR DEFAULT ''",
            # Asana's due date-and-time, so pushing our date-only due_on back
            # stops deleting the time (the two fields are mutually exclusive).
            "ALTER TABLE asana_task_links ADD COLUMN last_due_at VARCHAR DEFAULT ''",
            # Repair for tasks whose status says "completed" while the flag says
            # otherwise. create_task and bulk_update used to write the two
            # independently (see routers/tasks._resolve_completed), and such a
            # row renders with no strikethrough AND keeps drawing "overdue"
            # emails, because task_notify's due scan filters on the flag.
            # Idempotent - a no-op once there is nothing left to fix.
            "UPDATE tasks SET completed = 1, "
            "completed_at = CASE WHEN COALESCE(completed_at, '') = '' "
            "THEN COALESCE(NULLIF(modified_at, ''), created_at) ELSE completed_at END "
            "WHERE status = 'completed' AND COALESCE(completed, 0) = 0",
            # Activity lines pulled from Asana carried the actor's name up to
            # three times: the avatar+name every activity surface already
            # renders, an unconditional "[Asana - Name]" stamp, and Asana's own
            # sentence ("Urmi Gor assigned to Neil"). Strips the stamp and the
            # duplicated leading name, leaving the verb-first phrasing Nexus's
            # native entries use. Only where the actor RESOLVED - for an
            # unresolvable one the stamp is their only attribution. Idempotent:
            # the LIKE stops matching once a row is clean.
            "UPDATE task_activity SET detail = CASE "
            "WHEN substr(detail, instr(detail, '] ') + 2) LIKE "
            "     substr(detail, 10, instr(detail, '] ') - 10) || ' %' "
            "THEN substr(detail, instr(detail, '] ') + 2 + "
            "     length(substr(detail, 10, instr(detail, '] ') - 10)) + 1) "
            "ELSE substr(detail, instr(detail, '] ') + 2) END "
            "WHERE detail LIKE '[Asana ·%] %' "
            "AND COALESCE(actor_email, '') NOT IN ('', 'asana-sync')",
            # An emailed reply is matched back to its task by threading header
            # when the signed reply address didn't survive the round trip - the
            # lookup is per inbound message, so it needs the index.
            "CREATE INDEX IF NOT EXISTS ix_task_email_log_imid ON task_email_log (internet_message_id)",
            "CREATE INDEX IF NOT EXISTS ix_task_email_log_conv ON task_email_log (conversation_id)",
            # time_off_requests: manager+ files on behalf (Neil, Aug 11)
            "ALTER TABLE time_off_requests ADD COLUMN requested_by VARCHAR DEFAULT ''",
            # KB taxonomy/search/related-articles batch - present in the Postgres
            # list below but missing here, so a pre-existing local SQLite db never
            # got these columns and every write 500'd with "no column named tags".
            "ALTER TABLE kb_documents ADD COLUMN tags VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN related_ids VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN content_text TEXT DEFAULT ''",
            # KB Department->Service->SOP hierarchy + title/content audit trail
            "ALTER TABLE kb_documents ADD COLUMN service VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN original_title VARCHAR DEFAULT ''",
            "ALTER TABLE kb_documents ADD COLUMN original_content TEXT DEFAULT ''",
            # External Links directory rebuild (Aug 2026) - department scoping,
            # icon key, admin ordering/pin, and who/when for the audit trail.
            "ALTER TABLE external_links ADD COLUMN department VARCHAR DEFAULT ''",
            "ALTER TABLE external_links ADD COLUMN icon VARCHAR DEFAULT 'Link2'",
            "ALTER TABLE external_links ADD COLUMN sort_order INTEGER DEFAULT 0",
            "ALTER TABLE external_links ADD COLUMN is_pinned BOOLEAN DEFAULT 0",
            "ALTER TABLE external_links ADD COLUMN created_by VARCHAR DEFAULT ''",
            "ALTER TABLE external_links ADD COLUMN created_at VARCHAR DEFAULT ''",
            "ALTER TABLE external_links ADD COLUMN updated_at VARCHAR DEFAULT ''",
            "ALTER TABLE external_links ADD COLUMN company VARCHAR DEFAULT ''",
            "ALTER TABLE personal_links ADD COLUMN vault_cred_id VARCHAR DEFAULT ''",
            # External Links directory rebuild (Aug 2026) - real Accounting-view
            # data sourced from start.greensglobal.com (screenshot, Aug 12); name-keyed
            # idempotent inserts so this only fires once per row, everywhere. A few
            # entries carry a "TBD.greensglobal.com" placeholder URL (no real link was
            # supplied) or reuse an admin-pasted URL that duplicates another row (Jive/
            # Intacct, Greens Storage/Reports) - flagged in each description for the
            # admin UI to fix via Edit rather than silently trusted.
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Outlook','https://outlook.office.com/mail/','Productivity','','Mail','Company email',0,10,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Outlook')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Calendar','https://outlook.office.com/calendar/','Productivity','','Calendar','Company calendar',0,20,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Calendar')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Asana','https://app.asana.com/','Productivity','','CheckSquare','Task and project tracking',0,30,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Asana')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Egnyte','https://cloud.greensglobal.com/subDomainLogin.do#login','Productivity','','Cloud','Company file storage',0,40,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Egnyte')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Ramp','https://app.ramp.com/sign-in','Finance & Accounting','Accounting','CreditCard','Corporate card and expense management',0,50,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Ramp')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Teams','https://teams.microsoft.com/','Productivity','','MessagesSquare','Chat and video meetings',0,60,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Teams')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Hummingbird','https://TBD.greensglobal.com/hummingbird','Finance & Accounting','Accounting','Bird','Placeholder - add the real link when available',0,70,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Hummingbird')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Knowledge Base','https://TBD.greensglobal.com/knowledge-base','Reference & Support','','BookOpen','See the in-app Knowledge Base module',0,80,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Knowledge Base')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Training & Courses','https://TBD.greensglobal.com/training-and-courses','Reference & Support','','GraduationCap','Placeholder - add the real link when available',0,90,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Training & Courses')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Employee Manual','https://cloud.greensglobal.com/navigate/file/09e87b28-f0da-444f-88c2-cb1ae8dc2155','Reference & Support','','ClipboardList','Company employee handbook',0,100,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Employee Manual')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Support','https://TBD.greensglobal.com/support','Reference & Support','','Headphones','See the in-app Support module',0,110,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Support')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Time & Attendance','https://TBD.greensglobal.com/time-and-attendance','HR & Payroll','','Clock','See the in-app Time Clock module',0,120,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Time & Attendance')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Payroll Management','https://TBD.greensglobal.com/payroll-management','HR & Payroll','Accounting','Wallet','Placeholder - add the real link when available',0,130,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Payroll Management')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Jive','https://my.jive.com/pbx','Finance & Accounting','Accounting','Headphones','Phone system',0,140,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Jive')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Speed Test','https://www.speedtest.net/','Productivity','','Gauge','Internet connection speed test',0,150,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Speed Test')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Intacct','https://my.jive.com/pbx','Finance & Accounting','Accounting','Landmark','Sage Intacct accounting - link pasted as the Jive phone portal, double-check with whoever supplied it',0,160,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Intacct')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Resources - Accounting','https://cloud.greensglobal.com/navigate/folder/2eda47d7-7f2f-4b07-8e58-9216dcdfd843','Finance & Accounting','Accounting','FolderKanban','Accounting team resources folder',0,170,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Resources - Accounting')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'SOP''s - Accounting','https://TBD.greensglobal.com/sops---accounting','Finance & Accounting','Accounting','FileSpreadsheet','See the in-app Knowledge Base module, filtered to Accounting',0,180,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'SOP''s - Accounting')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Greens Global','https://www.greensglobal.com/','Finance & Accounting','','Globe','Company website',0,190,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Greens Global')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Greens Storage - Escondido','https://www.greensstorage.com/storage-units/california/escondido/greens-storage-escondido-3501393/','Finance & Accounting','Accounting','Building2','Greens Storage Escondido property listing',0,200,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Greens Storage - Escondido')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Reports - Accounting','https://www.greensstorage.com/storage-units/california/escondido/greens-storage-escondido-3501393/','Finance & Accounting','Accounting','LineChart','Accounting reports - link pasted as the Greens Storage Escondido listing, double-check with whoever supplied it',0,210,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Reports - Accounting')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Indeed','https://TBD.greensglobal.com/indeed','HR & Payroll','Accounting','Briefcase','Placeholder - add the real link when available',0,220,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Indeed')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Farmers & Merchants Bank','https://www.fmb.com/','Banking','Accounting','Landmark','Business banking',0,230,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Farmers & Merchants Bank')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Bank Of America','https://www.bankofamerica.com/','Banking','Accounting','Landmark','Business banking',0,240,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Bank Of America')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Bank of Montreal','https://www.bmo.com/en-us/main/personal/','Banking','Accounting','Landmark','Business banking',0,250,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Bank of Montreal')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Five Star Bank','https://secure.fivestarbank.com/fivestarbank/uux.aspx#/login','Banking','Accounting','Landmark','Business banking',0,260,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Five Star Bank')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Fidelity','https://www.fidelity.com/','Banking','Accounting','PiggyBank','Investment accounts',0,270,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Fidelity')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'US Bank','https://www.usbank.com/index.html','Banking','Accounting','Landmark','Business banking',0,280,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'US Bank')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Capital One','https://www.capitalone.com/','Banking','Accounting','CreditCard','Business banking',0,290,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Capital One')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Dashboard','https://TBD.greensglobal.com/dashboard','Reference & Support','','LineChart','See the in-app Dashboard module',0,300,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Dashboard')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'American Express','https://www.americanexpress.com/en-us/account/login?inav=iNavLnkLog','Banking','Accounting','CreditCard','Corporate card',0,310,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'American Express')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'My Equity','https://www.myequity.com/myequity/login','Banking','Accounting','Receipt','Equity/cap table portal',0,320,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'My Equity')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Visio','https://m365.cloud.microsoft/launch/Visio/?auth=2&home=1','Productivity','','Presentation','Diagramming',0,330,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Visio')",
            "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'OneDrive','https://greensg-my.sharepoint.com/','Productivity','','Cloud','Personal cloud file storage',0,340,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'OneDrive')",
        ]
        with engine.connect() as conn:
            for sql in sqlite_migrations:
                try:
                    conn.execute(text(sql))
                except Exception:
                    pass  # column already exists
            conn.commit()
        return
    migrations = [
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS overtime_rule VARCHAR DEFAULT 'ca'",
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS pay_type VARCHAR DEFAULT 'hourly'",
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS currency VARCHAR DEFAULT 'USD'",
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS monthly_salary FLOAT DEFAULT 0",
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS weekend_ot_amount FLOAT DEFAULT 0",
        "ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS full_day_hours FLOAT DEFAULT 8",
        "ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS domain VARCHAR DEFAULT ''",
        "ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS category VARCHAR DEFAULT ''",
        "ALTER TABLE time_screenshots ADD COLUMN IF NOT EXISTS bucket VARCHAR DEFAULT ''",
        "ALTER TABLE time_screenshots ADD COLUMN IF NOT EXISTS session_id VARCHAR DEFAULT ''",
        "ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS active_email VARCHAR DEFAULT ''",
        "ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS active_session_id VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS employee_email VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_notifications ADD COLUMN IF NOT EXISTS read_by VARCHAR DEFAULT ''",
        # inventory_requests: return-flow columns added after initial table creation
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS returned_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS return_photo_name VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS return_photo_url VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS condition_note VARCHAR DEFAULT ''",
        # inventory_requests: allocation columns
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS allocated_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS allocated_by VARCHAR DEFAULT ''",
        # inventory_requests: rejection columns
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS reject_reason VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS resolved_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS resolved_by VARCHAR DEFAULT ''",
        # inventory_requests: requester targeting
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS requested_by_email VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS raised_by VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS days INTEGER DEFAULT 1",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS reason VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS return_photo_name VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS return_photo_url VARCHAR DEFAULT ''",
        # inventory_requests: assigned-allocator handoff (manager picks who allocates)
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS assigned_allocator_email VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS assigned_allocator_name VARCHAR DEFAULT ''",
        # nexus_roles: display name captured from Microsoft Graph at assignment time
        "ALTER TABLE nexus_roles ADD COLUMN IF NOT EXISTS display_name VARCHAR DEFAULT ''",
        # inventory_items: physical site/storage location (e.g. "GSVC", "GSE")
        "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS location VARCHAR DEFAULT ''",
        # item_checkouts: handover/receipt photo flow (added to model but migration was missed - broke prod SELECTs)
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS order_id VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS handover_photo_by VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS handover_batch BOOLEAN DEFAULT FALSE",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS receipt_photo_url VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS receipt_photo_name VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS handed_over_at VARCHAR DEFAULT ''",
        # item_checkouts: extension request flow (employee asks for more days, manager approves)
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_days INTEGER DEFAULT 0",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_reason VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_status VARCHAR DEFAULT ''",
        # item_checkouts: employee picks which manager is notified for approval
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS approver_email VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS approver_name VARCHAR DEFAULT ''",
        # items: current permanent assignee pointer (full history in item_assignments)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_email VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_name VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_at VARCHAR DEFAULT ''",
        # Fleet department retired - vehicles belong to Construction (Neil, Jun 2026)
        "UPDATE items SET department = 'Construction' WHERE department = 'Fleet'",
        # items: per-item photo policy + dollar value (Neil, Jun 2026 review)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS picture_required BOOLEAN DEFAULT TRUE",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_value DOUBLE PRECISION DEFAULT 0",
        # items: static per-unit serial - the import upsert key (replaces name matching, Jun 2026)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS serial_number VARCHAR DEFAULT ''",
        # serial is the identity now - enforce uniqueness (blanks excluded so legacy
        # rows + not-yet-serialised items are fine; catches concurrent double-assign)
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_items_serial_unique ON items (serial_number) WHERE serial_number <> ''",
        # Permanent items were auto-stamped permanently_assigned at creation even
        # with nobody attached - unstamp the ones that never got a real assignee
        "UPDATE items SET status = 'available' WHERE ownership_type = 'permanent' AND COALESCE(assigned_to_email, '') = '' AND status = 'permanently_assigned'",
        # requisitions: purchase fulfillment flow (allocator + ordered/fulfilled)
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS allocator_email VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS allocator_name VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS ordered_at VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS fulfilled_at VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS fulfillment_note VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS fulfilled_item_id VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS submitted_by_email VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS submitted_by_name VARCHAR DEFAULT ''",
        # items: operational status column (Neil - deployed/in repair/needs replacement; SEPARATE from lifecycle status)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS op_status VARCHAR DEFAULT ''",
        # items: permanent assignment to a PLACE not a person - excluded from "Who has it" (Ankush)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_location VARCHAR DEFAULT ''",
        # items: admin-defined custom fields, values keyed by field_key (Ankush's Details panel)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb",
        # items: soft-delete so deletions are restorable and carry a "Deleted In" (Ankush)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_by VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_location VARCHAR DEFAULT ''",
        # items: person an op_status (lost/retired) is declared against - they get the notification + show on "Who has it"
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS op_status_person_email VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS op_status_person_name VARCHAR DEFAULT ''",
        # knowledge_base: require sign-off flag + analytics/freshness/retention
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS require_ack BOOLEAN DEFAULT FALSE",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS review_every_months INTEGER DEFAULT 12",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS verified_at VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS verified_by VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS retention_months INTEGER DEFAULT 84",
        "ALTER TABLE kb_courses ADD COLUMN IF NOT EXISTS overview VARCHAR DEFAULT ''",
        "ALTER TABLE kb_courses ADD COLUMN IF NOT EXISTS recert_months INTEGER DEFAULT 0",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS stale_notified_at VARCHAR DEFAULT ''",
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS undone_at VARCHAR DEFAULT ''",
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS undone_by VARCHAR DEFAULT ''",
        # HR Section A: which legal entity employs each worker
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS company VARCHAR DEFAULT ''",
        # HR Section A: contractor worker type - scope/SOW/dates/rate/billing client
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS contractor JSONB DEFAULT '{}'::jsonb",
        # HR Section B: profile depth - personal/compliance open; compensation+bank RESTRICTED (hr_comp grant)
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS personal JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS compensation JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS bank JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS compliance JSONB DEFAULT '{}'::jsonb",
        # HR Section B6: employee status-change audit trail (reason + effective date)
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS status_log JSONB DEFAULT '[]'::jsonb",
        # Org chart Phase 5: functional-division head tag (inherits down the tree)
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS division VARCHAR DEFAULT ''",
        # External users: identity type (internal MS365 / Entra B2B guest / non-MS365 external)
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS identity_type VARCHAR DEFAULT 'internal'",
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS display_name VARCHAR DEFAULT ''",
        # Charmi Aug 4: formal designation, kept distinct from job_title
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS designation VARCHAR DEFAULT ''",
        # Soft delete for "Remove from Nexus" - see the NexusEmployee model.
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS deleted_at VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS deleted_by VARCHAR DEFAULT ''",
        "ALTER TABLE asana_import_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN DEFAULT FALSE",
        "ALTER TABLE asana_project_map ADD COLUMN IF NOT EXISTS last_pull_at VARCHAR DEFAULT ''",
        "ALTER TABLE asana_project_map ADD COLUMN IF NOT EXISTS last_full_pull_at VARCHAR DEFAULT ''",
        "ALTER TABLE asana_import_jobs ADD COLUMN IF NOT EXISTS done_gids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE asana_import_jobs ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 1",
        # Investor Relations: optional soft link to an Asset Management PropertyAsset.id
        "ALTER TABLE ir_funds ADD COLUMN IF NOT EXISTS property_asset_id VARCHAR DEFAULT ''",
        # HR mailbox export: progress total (table itself is created by create_all)
        "ALTER TABLE hr_mailbox_exports ADD COLUMN IF NOT EXISTS total INTEGER DEFAULT 0",
        # Ticket triage routing: who assigns a department's incoming tickets
        "ALTER TABLE hr_departments ADD COLUMN IF NOT EXISTS lead_email VARCHAR DEFAULT ''",
        "ALTER TABLE hr_departments ADD COLUMN IF NOT EXISTS backup_email VARCHAR DEFAULT ''",
        # Ticket approval gate (service/change/access requests)
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS approval_status VARCHAR DEFAULT 'none'",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS approver_email VARCHAR DEFAULT ''",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS approval_note VARCHAR DEFAULT ''",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS approval_decided_at VARCHAR DEFAULT ''",
        # Who handed a ticket to its assignee - TaskTicket.assigned_by_email.
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS assigned_by_email TEXT DEFAULT ''",
        # Ticket numbers dropped the "TKT-" prefix and widened to 6 digits
        # (ticket_code.py). Idempotent - nothing matches TKT-% afterwards.
        "UPDATE task_tickets SET code = lpad((substring(code from 5))::int::text, 6, '0') WHERE code LIKE 'TKT-%'",
        # Why a per-user Asana grant last failed - AsanaUserToken.last_error.
        "ALTER TABLE asana_user_tokens ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT ''",
        "ALTER TABLE asana_user_tokens ADD COLUMN IF NOT EXISTS last_error_at TEXT DEFAULT ''",
        # E-Sign multi-document packets: PDFs attached to a template, carried on the envelope
        "ALTER TABLE hr_sign_templates ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE hr_sign_requests ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]'::jsonb",
        # E-Sign routing (sequential/parallel), CC recipients, external access codes
        "ALTER TABLE hr_sign_requests ADD COLUMN IF NOT EXISTS routing TEXT DEFAULT 'sequential'",
        "ALTER TABLE hr_sign_parties ADD COLUMN IF NOT EXISTS party_role TEXT DEFAULT 'signer'",
        "ALTER TABLE hr_sign_parties ADD COLUMN IF NOT EXISTS access_code TEXT DEFAULT ''",
        # E-Sign: Egnyte folder for a copy of the sealed PDF
        "ALTER TABLE hr_sign_templates ADD COLUMN IF NOT EXISTS egnyte_folder TEXT DEFAULT ''",
        "ALTER TABLE hr_sign_requests ADD COLUMN IF NOT EXISTS egnyte_folder TEXT DEFAULT ''",
        # E-Sign: tamper-evident audit hash chain + public verification QR
        "ALTER TABLE hr_sign_events ADD COLUMN IF NOT EXISTS seq INTEGER DEFAULT 0",
        "ALTER TABLE hr_sign_events ADD COLUMN IF NOT EXISTS event_hash TEXT DEFAULT ''",
        "ALTER TABLE hr_sign_requests ADD COLUMN IF NOT EXISTS verify_token TEXT DEFAULT ''",
        "ALTER TABLE time_bod ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'bod'",
        "ALTER TABLE time_bod ADD COLUMN IF NOT EXISTS html TEXT DEFAULT ''",
        "ALTER TABLE time_bod ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0",
        "ALTER TABLE time_bod ADD COLUMN IF NOT EXISTS last_try_at TEXT DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS category VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS pending_at VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_reason VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edited_by VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edited_at VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_status VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_reviewed_by VARCHAR DEFAULT ''",
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_reviewed_at VARCHAR DEFAULT ''",
        "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS code TEXT DEFAULT ''",
        "ALTER TABLE shift_groups ADD COLUMN IF NOT EXISTS teams_chat_id TEXT DEFAULT ''",
        "ALTER TABLE shift_groups ADD COLUMN IF NOT EXISTS teams_chat_name TEXT DEFAULT ''",
        "ALTER TABLE hr_self_requests ADD COLUMN IF NOT EXISTS attachment_path TEXT DEFAULT ''",
        "ALTER TABLE hr_self_requests ADD COLUMN IF NOT EXISTS attachment_name TEXT DEFAULT ''",
        "ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS interview_at TEXT DEFAULT ''",
        # ── Task Module (Jul 2026): replace the flat demo `tasks` table with the
        # rich runtime schema. create_all can't alter an existing table, so drop
        # the obsolete NOT-NULL demo columns and add the new ones idempotently.
        "ALTER TABLE tasks DROP COLUMN IF EXISTS assignee",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS project",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS due_date",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS hours",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS comment",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS dept",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS synced",
        "ALTER TABLE tasks ALTER COLUMN status DROP NOT NULL",
        "ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'not_started'",
        "ALTER TABLE tasks ALTER COLUMN priority DROP NOT NULL",
        "ALTER TABLE tasks ALTER COLUMN priority SET DEFAULT 'medium'",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS code TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'task'",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_email TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_email TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS follower_emails JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS liked_by_emails JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS access_level TEXT DEFAULT 'org'",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS section_id TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department_id TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subtask_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocking_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependency_types JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS custom_field_values JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_on TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_on TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate_hours DOUBLE PRECISION",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS actual_hours DOUBLE PRECISION",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence JSONB",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN DEFAULT FALSE",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none'",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comment_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachment_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS activity_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS modified_at TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS synced_with_asana BOOLEAN DEFAULT FALSE",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'request'",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT ''",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS watcher_emails JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS custom_field_values JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS type_fields JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS task_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS component TEXT DEFAULT ''",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS csat_rating INTEGER DEFAULT 0",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS csat_comment TEXT DEFAULT ''",
        "ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS internal BOOLEAN DEFAULT FALSE",
        "ALTER TABLE task_saved_views ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'task'",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS company_id TEXT DEFAULT ''",
        "ALTER TABLE task_tickets ADD COLUMN IF NOT EXISTS hr_department_id TEXT DEFAULT ''",
        # task_projects.department_ids ADD removed (see the SQLite list note): the
        # ADD+DROP replay each startup ate task_projects' 1600 attribute slots.
        # Roles & Access redesign: job-role templates live on nexus_groups
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS is_job_role INTEGER DEFAULT 0",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS tier VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS description VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS monitoring_exempt INTEGER DEFAULT 0",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS default_manager_email VARCHAR DEFAULT ''",
        "ALTER TABLE time_approvals ADD COLUMN IF NOT EXISTS kind VARCHAR DEFAULT 'manager'",
        # Company email domains - drive M365 import + auto company tagging
        "ALTER TABLE hr_entities ADD COLUMN IF NOT EXISTS domains VARCHAR DEFAULT ''",
        # Company manager (operational head; escalation target)
        "ALTER TABLE hr_entities ADD COLUMN IF NOT EXISTS manager_email VARCHAR DEFAULT ''",
        # ── Item Module hot-path indexes (P2-4) + live-row concurrency guards
        # (P1-1). Postgres supports partial (WHERE) indexes; a partial-unique
        # that can't build over pre-existing duplicate live rows raises here and
        # is caught + logged by the per-statement try/except below - it never
        # aborts the migration run. Statuses match the transient/permanent
        # lifecycles (item_checkouts / item_assignments).
        "CREATE INDEX IF NOT EXISTS ix_checkout_item_status ON item_checkouts (item_id, status)",
        "CREATE INDEX IF NOT EXISTS ix_checkout_order ON item_checkouts (order_id)",
        "CREATE INDEX IF NOT EXISTS ix_checkout_requested_by ON item_checkouts (requested_by_email)",
        "CREATE INDEX IF NOT EXISTS ix_assignment_item_status ON item_assignments (item_id, status)",
        "CREATE INDEX IF NOT EXISTS ix_assignment_assignee ON item_assignments (assignee_email)",
        "CREATE INDEX IF NOT EXISTS ix_notif_recipient_actioned ON nexus_notifications (recipient, actioned)",
        "CREATE INDEX IF NOT EXISTS ix_notif_ref ON nexus_notifications (ref_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_checkout_live ON item_checkouts (item_id) WHERE status IN ('pending','approved','pending_receipt','allocated')",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_assignment_live ON item_assignments (item_id) WHERE status IN ('pending_acceptance','active','return_initiated')",
        # Task Module: "Team" becomes project-scoped (IT Team/QA Team/... WITHIN
        # a project) instead of a flat cross-project list; a project's org
        # classifier is now the real People-module department (Jul 2026).
        # task_teams is a NEW table name, so create_all (which runs before this
        # function) already creates it empty before we get here - a plain
        # RENAME would then fail every time (target already exists) and
        # silently strand the real rows in task_departments forever. Copy
        # instead: ON CONFLICT DO NOTHING no-ops on rerun (id is the PK), and
        # the DROP only succeeds once the copy has landed everything.
        "INSERT INTO task_teams (id, project_id, name, color, icon, member_emails, created_at) "
        "SELECT id, '', name, color, icon, member_emails, created_at FROM task_departments "
        "ON CONFLICT (id) DO NOTHING",
        "DROP TABLE IF EXISTS task_departments",
        "ALTER TABLE tasks DROP COLUMN IF EXISTS department_id",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id VARCHAR DEFAULT ''",
        "ALTER TABLE task_projects DROP COLUMN IF EXISTS department_ids",
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS hr_department_id VARCHAR DEFAULT ''",
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS hr_department_name VARCHAR DEFAULT ''",
        # Project visibility (Jul 2026): mirrors Task.access_level. Existing
        # projects backfill to 'org' (everyone already saw everything) - only
        # newly-created projects default to 'restricted' (create_project).
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS access_level VARCHAR DEFAULT 'org'",
        # Documents (DMS) Phase 4: merge-field subject/company for export
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS employee_id VARCHAR DEFAULT ''",
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS entity_id VARCHAR DEFAULT ''",
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS merge_overrides JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS merge_overrides JSONB DEFAULT '{}'::jsonb",
        # Documents (DMS) Phase 13 (Template Builder): merge-field type/required/default/validation metadata
        "ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS field_defs JSONB DEFAULT '[]'::jsonb",
        # Share panel (Jul 2026): per-person/per-team project access role.
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS member_roles JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE task_teams ADD COLUMN IF NOT EXISTS access_role VARCHAR DEFAULT 'editor'",
        # A team may now belong to MANY projects (one IT team shared across
        # projects, as Asana does it) - project_ids replaces project_id, which is
        # kept only as a write-only legacy mirror. Backfill folds every existing
        # single assignment into the new list.
        "ALTER TABLE task_teams ADD COLUMN IF NOT EXISTS project_ids JSONB DEFAULT '[]'::jsonb",
        # Custom fields: per-project scoping + a required flag. An empty
        # project_ids keeps a field global (the pre-scoping behavior).
        "ALTER TABLE task_custom_fields ADD COLUMN IF NOT EXISTS project_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_custom_fields ADD COLUMN IF NOT EXISTS required BOOLEAN DEFAULT FALSE",
        # Asana formula fields import but can never push back (the API rejects
        # writes) - this marks them so the editors disable them.
        "ALTER TABLE task_custom_fields ADD COLUMN IF NOT EXISTS read_only BOOLEAN DEFAULT FALSE",
        # Asana-derived fields/statuses are identified by gid, not by name.
        "ALTER TABLE task_custom_fields ADD COLUMN IF NOT EXISTS asana_gid VARCHAR DEFAULT ''",
        "ALTER TABLE task_custom_statuses ADD COLUMN IF NOT EXISTS asana_option_gid VARCHAR DEFAULT ''",
        # Custom statuses get the same per-project scoping custom fields already
        # had. Empty = every project, so existing statuses are unchanged.
        "ALTER TABLE task_custom_statuses ADD COLUMN IF NOT EXISTS project_ids JSONB DEFAULT '[]'::jsonb",
        "ALTER TABLE task_custom_statuses ADD COLUMN IF NOT EXISTS asana_option_gids JSONB DEFAULT '[]'::jsonb",
        # Setup-only Asana PAT; blank falls back to the service token.
        "ALTER TABLE asana_sync_config ADD COLUMN IF NOT EXISTS setup_token VARCHAR DEFAULT ''",
        "UPDATE task_teams SET project_ids = jsonb_build_array(project_id) "
        "WHERE COALESCE(project_id, '') != '' AND COALESCE(project_ids, '[]'::jsonb) = '[]'::jsonb",
        # Manual override for ad-hoc-shared Asana teams the API can't reveal.
        "ALTER TABLE asana_project_map ADD COLUMN IF NOT EXISTS extra_team_names JSONB DEFAULT '[]'::jsonb",
        # One Nexus task per Asana task. On a database that already carries
        # duplicate links this can't build and is caught below - run
        # Manage → Asana Sync → "Merge duplicates" (asana_sync.dedupe_tasks),
        # which creates the same index once the duplicates are gone.
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_asana_task_link_gid ON asana_task_links (asana_gid) WHERE asana_gid <> ''",
        # Two-way delete propagation (opt-out; see AsanaSyncConfig.delete_sync).
        "ALTER TABLE asana_sync_config ADD COLUMN IF NOT EXISTS delete_sync BOOLEAN DEFAULT TRUE",
        # Two-Way Sync card's own sync/delete toggles, independent of the Setup
        # card's enabled/delete_sync above - see AsanaSyncConfig and
        # asana_sync.sync_is_on()/delete_sync_is_on().
        "ALTER TABLE asana_sync_config ADD COLUMN IF NOT EXISTS manual_sync_enabled BOOLEAN DEFAULT FALSE",
        "ALTER TABLE asana_sync_config ADD COLUMN IF NOT EXISTS manual_delete_sync BOOLEAN DEFAULT FALSE",
        # The exact rendered body from the original send, reused verbatim on
        # retry instead of re-rendering. See TaskEmailLog.html.
        "ALTER TABLE task_email_log ADD COLUMN IF NOT EXISTS html VARCHAR DEFAULT ''",
        # Set only for a file attached while composing a comment. See
        # TaskAttachment.comment_id.
        "ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS comment_id VARCHAR DEFAULT ''",
        # Push-only digest (tags/followers/dependencies/section/attachments)
        # so the reconcile sweep can skip an unchanged task outright.
        "ALTER TABLE asana_task_links ADD COLUMN IF NOT EXISTS last_push_hash VARCHAR DEFAULT ''",
        # Asana-side digest, so a pull only re-applies genuinely changed tasks.
        "ALTER TABLE asana_task_links ADD COLUMN IF NOT EXISTS last_inbound_hash VARCHAR DEFAULT ''",
        # Asana's due date-and-time, so pushing our date-only due_on back
        # stops deleting the time (the two fields are mutually exclusive).
        "ALTER TABLE asana_task_links ADD COLUMN IF NOT EXISTS last_due_at VARCHAR DEFAULT ''",
        # Repair for tasks whose status says "completed" while the flag says
        # otherwise - see the SQLite list above for why they exist and why this
        # is safe to re-run on every boot.
        "UPDATE tasks SET completed = true, "
        "completed_at = CASE WHEN COALESCE(completed_at, '') = '' "
        "THEN COALESCE(NULLIF(modified_at, ''), created_at) ELSE completed_at END "
        "WHERE status = 'completed' AND completed IS NOT TRUE",
        # Strips the "[Asana - Name]" stamp and the duplicated leading name from
        # inbound activity lines - see the SQLite list above for the reasoning.
        "UPDATE task_activity SET detail = CASE "
        "WHEN substring(detail from position('] ' in detail) + 2) LIKE "
        "     substring(detail from 10 for position('] ' in detail) - 10) || ' %' "
        "THEN substring(detail from position('] ' in detail) + 2 + "
        "     length(substring(detail from 10 for position('] ' in detail) - 10)) + 1) "
        "ELSE substring(detail from position('] ' in detail) + 2) END "
        "WHERE detail LIKE '[Asana ·%] %' "
        "AND COALESCE(actor_email, '') NOT IN ('', 'asana-sync')",
        # KB taxonomy/search/related-articles (industry-standard KB feature batch).
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tags VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS related_ids VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content_text TEXT DEFAULT ''",
        # Construction module: RLS on every table create_all made.
        #
        # This is here rather than in a release checklist because a checklist is
        # exactly what the recurring gap in CLAUDE.md is - `create_all` builds a
        # new table with RLS OFF, and the backend never notices because it
        # connects via the privileged DATABASE_URL and bypasses RLS entirely.
        # The only thing RLS locks out is the public anon key, so a table that
        # misses this step is silently world-readable to anyone holding it.
        # ENABLE ROW LEVEL SECURITY is idempotent, so running it every boot on
        # both dev and prod costs nothing and cannot be forgotten.
        #
        # No policies are added on purpose: RLS with zero policies denies all
        # anon access, which is what every one of these tables wants. Nothing
        # reads them except this API. Daily logs carry GPS traces and jobsite
        # photos, and reports carry contract values.
        "ALTER TABLE construction_projects ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_daily_logs ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_media ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_ai_jobs ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_weekly_reports ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_milestones ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_rfis ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_submittals ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE construction_activity ENABLE ROW LEVEL SECURITY",
        # An emailed reply is matched back to its task by threading header when
        # the signed reply address didn't survive the round trip - the lookup is
        # per inbound message, so it needs the index.
        "CREATE INDEX IF NOT EXISTS ix_task_email_log_imid ON task_email_log (internet_message_id)",
        "CREATE INDEX IF NOT EXISTS ix_task_email_log_conv ON task_email_log (conversation_id)",
        # Task module: create_all makes this table with RLS OFF, and it holds
        # the sender and subject of every reply mailed to the task mailbox.
        # Same recurring gap CLAUDE.md records; idempotent, so it runs each boot
        # on dev and prod rather than living in a release checklist.
        "ALTER TABLE task_inbound_email ENABLE ROW LEVEL SECURITY",
        # CredVault SMS/Email OTP + Personal Vault password (Aug 2026): same
        # create_all-makes-it-with-RLS-OFF gap as above. vault_otp_challenges
        # holds one-time codes and vault_personal_auth holds password hashes -
        # both must never be reachable via the public anon key.
        "ALTER TABLE vault_otp_challenges ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE vault_otp_sessions ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE vault_personal_auth ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE vault_personal_unlock_sessions ENABLE ROW LEVEL SECURITY",
        # time_off_requests: manager+ can file on behalf of an employee (Neil, Aug 11);
        # who filed it is recorded so the request never looks self-submitted.
        "ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS requested_by VARCHAR DEFAULT ''",
        # KB Department->Service->SOP hierarchy + title/content audit trail
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS service VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS original_title VARCHAR DEFAULT ''",
        "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS original_content TEXT DEFAULT ''",
        # kb_services/kb_tags: create_all makes these with RLS OFF - same recurring
        # gap CLAUDE.md records; idempotent, runs every boot on dev and prod.
        "ALTER TABLE kb_services ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE kb_tags ENABLE ROW LEVEL SECURITY",
        # External Links directory rebuild (Aug 2026) - department scoping,
        # icon key, admin ordering/pin, and who/when for the audit trail.
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS department VARCHAR DEFAULT ''",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS icon VARCHAR DEFAULT 'Link2'",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS created_by VARCHAR DEFAULT ''",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS created_at VARCHAR DEFAULT ''",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS updated_at VARCHAR DEFAULT ''",
        "ALTER TABLE external_links ADD COLUMN IF NOT EXISTS company VARCHAR DEFAULT ''",
        # Personal Link -> Credential Vault personal credential pointer (Aug 13)
        "ALTER TABLE personal_links ADD COLUMN IF NOT EXISTS vault_cred_id VARCHAR DEFAULT ''",
        # external_links predates this table's proper build-out and was created
        # via create_all with RLS OFF like every other gap CLAUDE.md records -
        # closing it now that this is a real, admin-editable module.
        "ALTER TABLE external_links ENABLE ROW LEVEL SECURITY",
        # personal_links (Aug 12) - one employee's private shortcuts, gated in
        # the API by owner_email, not by RLS policy (backend uses the
        # privileged DATABASE_URL and bypasses RLS entirely) - but RLS with
        # zero policies still closes the table to the public anon key, which
        # is the whole point: nothing outside this API can read it.
        "ALTER TABLE personal_links ENABLE ROW LEVEL SECURITY",
        # External Links directory rebuild (Aug 2026) - see the matching sqlite
        # migration list above for the full rationale; name-keyed idempotent
        # inserts, same statements (portable syntax) on both engines.
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Outlook','https://outlook.office.com/mail/','Productivity','','Mail','Company email',0,10,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Outlook')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Calendar','https://outlook.office.com/calendar/','Productivity','','Calendar','Company calendar',0,20,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Calendar')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Asana','https://app.asana.com/','Productivity','','CheckSquare','Task and project tracking',0,30,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Asana')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Egnyte','https://cloud.greensglobal.com/subDomainLogin.do#login','Productivity','','Cloud','Company file storage',0,40,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Egnyte')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Ramp','https://app.ramp.com/sign-in','Finance & Accounting','Accounting','CreditCard','Corporate card and expense management',0,50,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Ramp')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Teams','https://teams.microsoft.com/','Productivity','','MessagesSquare','Chat and video meetings',0,60,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Teams')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Hummingbird','https://TBD.greensglobal.com/hummingbird','Finance & Accounting','Accounting','Bird','Placeholder - add the real link when available',0,70,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Hummingbird')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Knowledge Base','https://TBD.greensglobal.com/knowledge-base','Reference & Support','','BookOpen','See the in-app Knowledge Base module',0,80,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Knowledge Base')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Training & Courses','https://TBD.greensglobal.com/training-and-courses','Reference & Support','','GraduationCap','Placeholder - add the real link when available',0,90,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Training & Courses')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Employee Manual','https://cloud.greensglobal.com/navigate/file/09e87b28-f0da-444f-88c2-cb1ae8dc2155','Reference & Support','','ClipboardList','Company employee handbook',0,100,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Employee Manual')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Support','https://TBD.greensglobal.com/support','Reference & Support','','Headphones','See the in-app Support module',0,110,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Support')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Time & Attendance','https://TBD.greensglobal.com/time-and-attendance','HR & Payroll','','Clock','See the in-app Time Clock module',0,120,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Time & Attendance')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Payroll Management','https://TBD.greensglobal.com/payroll-management','HR & Payroll','Accounting','Wallet','Placeholder - add the real link when available',0,130,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Payroll Management')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Jive','https://my.jive.com/pbx','Finance & Accounting','Accounting','Headphones','Phone system',0,140,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Jive')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Speed Test','https://www.speedtest.net/','Productivity','','Gauge','Internet connection speed test',0,150,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Speed Test')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Intacct','https://my.jive.com/pbx','Finance & Accounting','Accounting','Landmark','Sage Intacct accounting - link pasted as the Jive phone portal, double-check with whoever supplied it',0,160,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Intacct')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Resources - Accounting','https://cloud.greensglobal.com/navigate/folder/2eda47d7-7f2f-4b07-8e58-9216dcdfd843','Finance & Accounting','Accounting','FolderKanban','Accounting team resources folder',0,170,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Resources - Accounting')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'SOP''s - Accounting','https://TBD.greensglobal.com/sops---accounting','Finance & Accounting','Accounting','FileSpreadsheet','See the in-app Knowledge Base module, filtered to Accounting',0,180,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'SOP''s - Accounting')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Greens Global','https://www.greensglobal.com/','Finance & Accounting','','Globe','Company website',0,190,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Greens Global')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Greens Storage - Escondido','https://www.greensstorage.com/storage-units/california/escondido/greens-storage-escondido-3501393/','Finance & Accounting','Accounting','Building2','Greens Storage Escondido property listing',0,200,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Greens Storage - Escondido')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Reports - Accounting','https://www.greensstorage.com/storage-units/california/escondido/greens-storage-escondido-3501393/','Finance & Accounting','Accounting','LineChart','Accounting reports - link pasted as the Greens Storage Escondido listing, double-check with whoever supplied it',0,210,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Reports - Accounting')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Indeed','https://TBD.greensglobal.com/indeed','HR & Payroll','Accounting','Briefcase','Placeholder - add the real link when available',0,220,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Indeed')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Farmers & Merchants Bank','https://www.fmb.com/','Banking','Accounting','Landmark','Business banking',0,230,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Farmers & Merchants Bank')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Bank Of America','https://www.bankofamerica.com/','Banking','Accounting','Landmark','Business banking',0,240,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Bank Of America')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Bank of Montreal','https://www.bmo.com/en-us/main/personal/','Banking','Accounting','Landmark','Business banking',0,250,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Bank of Montreal')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Five Star Bank','https://secure.fivestarbank.com/fivestarbank/uux.aspx#/login','Banking','Accounting','Landmark','Business banking',0,260,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Five Star Bank')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Fidelity','https://www.fidelity.com/','Banking','Accounting','PiggyBank','Investment accounts',0,270,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Fidelity')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'US Bank','https://www.usbank.com/index.html','Banking','Accounting','Landmark','Business banking',0,280,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'US Bank')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Capital One','https://www.capitalone.com/','Banking','Accounting','CreditCard','Business banking',0,290,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Capital One')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Dashboard','https://TBD.greensglobal.com/dashboard','Reference & Support','','LineChart','See the in-app Dashboard module',0,300,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Dashboard')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'American Express','https://www.americanexpress.com/en-us/account/login?inav=iNavLnkLog','Banking','Accounting','CreditCard','Corporate card',0,310,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'American Express')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'My Equity','https://www.myequity.com/myequity/login','Banking','Accounting','Receipt','Equity/cap table portal',0,320,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'My Equity')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'Visio','https://m365.cloud.microsoft/launch/Visio/?auth=2&home=1','Productivity','','Presentation','Diagramming',0,330,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'Visio')",
        "INSERT INTO external_links (name,url,category,department,icon,description,clicks,sort_order,is_pinned,created_by,created_at,updated_at) SELECT 'OneDrive','https://greensg-my.sharepoint.com/','Productivity','','Cloud','Personal cloud file storage',0,340,0,'seed-aug2026','','' WHERE NOT EXISTS (SELECT 1 FROM external_links WHERE name = 'OneDrive')",
    ]
    # Commit per statement, roll back per failure. With a single end-of-loop
    # commit, one failing statement (e.g. an ALTER on a table this DB doesn't
    # have) puts the WHOLE Postgres transaction in the aborted state - every
    # later statement then "skips" and the final commit persists nothing, which
    # is how prod silently missed new columns (Jul 24: time_punches.category
    # broke every timeclock SELECT with a 500).
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[migration] skipped: {e}")


# NOTE (P2-1, Jul 2026): the legacy inventory_items mock seed (~34 rows) was
# removed with the rest of the retired inventory stack. The InventoryItem model
# is kept (models.py) so create_all preserves the table + any historical rows,
# but nothing seeds fake data on fresh DBs anymore.


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to start if NEXUS_SKIP_AUTH is set while running on Azure App
    # Service - the env var is for local development only and must never reach
    # a deployed instance (dev or prod).
    import sys as _sys
    if os.getenv("NEXUS_SKIP_AUTH", "").lower() in ("1", "true", "yes"):
        if os.getenv("WEBSITE_SITE_NAME"):
            print(
                "FATAL: NEXUS_SKIP_AUTH must not be set on Azure App Service. "
                "Remove it from the application settings and restart.",
                file=_sys.stderr,
            )
            _sys.exit(1)

    try:
        models.Base.metadata.create_all(bind=engine)
        print("[startup] DB tables ready")
    except Exception as e:
        print(f"[startup] DB not ready: {e}")
    try:
        _run_migrations()
        print("[startup] migrations applied")
    except Exception as e:
        print(f"[startup] migrations skipped: {e}")
    try:
        from auth import _fetch_jwks, SKIP_AUTH
        if not SKIP_AUTH:
            _fetch_jwks()
            print("[startup] JWKS keys cached")
    except Exception as e:
        print(f"[startup] JWKS prefetch skipped: {e}")
    # Pre-warm the DB connection pool so the first user request doesn't pay
    # the cold-start cost of establishing the initial Postgres connection.
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print("[startup] DB connection pool warmed")
    except Exception as e:
        print(f"[startup] DB pool warm-up skipped: {e}")
    # One shared Documents-module letterhead (Greens Global logo + brand name)
    # so a Knowledge Base "Full Editor" SOP has something real to auto-attach
    # instead of a blank/manual setup. Idempotent by name - safe to run every
    # boot. Letterhead creation is normally admin-only (see
    # routers/documents.py create_letterhead); this is the one place that
    # bypasses that, the same way it bypasses auth entirely at startup.
    try:
        import uuid as _uuid
        from datetime import datetime as _dt, timezone as _tz
        from database import SessionLocal
        db = SessionLocal()
        try:
            if not db.query(models.DocLetterhead).filter(models.DocLetterhead.name == "Nexus Knowledge Base").first():
                db.add(models.DocLetterhead(
                    id=str(_uuid.uuid4()), name="Nexus Knowledge Base",
                    logo_path="/assets/branding/greens-global-logo.png",
                    header_json={}, footer_json={}, address="",
                    is_default=False, created_by="system", created_at=_dt.now(_tz.utc).isoformat(),
                ))
                db.commit()
                print("[startup] Nexus Knowledge Base letterhead seeded")
        finally:
            db.close()
    except Exception as e:
        print(f"[startup] letterhead seed skipped: {e}")
    # Asana sync fallback poll (webhooks handle real-time; this is the safety net).
    try:
        from asana_sync import start_auto_pull, is_sync_worker
        start_auto_pull()
        print(f"[startup] asana auto-pull {'scheduled' if is_sync_worker() else 'skipped (not the sync worker)'}")
    except Exception as e:
        print(f"[startup] asana auto-pull skipped: {e}")
    # An import interrupted by the last restart resumes from where it stopped.
    # Gated on the sync worker for the same reason the poll is: otherwise every
    # developer's laptop would pick up the shared job on startup.
    try:
        from asana_sync import is_sync_worker
        if is_sync_worker():
            from routers.task_config import resume_stalled_import
            outcome = resume_stalled_import()
            if outcome:
                print(f"[startup] asana import {outcome}")
    except Exception as e:
        print(f"[startup] asana import resume skipped: {e}")
    # Background jobs - HR reminders, ticket/task notification retries + due-date
    # reminders, the long-session nudge - run on a SINGLE elected leader instance so
    # scaling out to multiple web instances can't double-send. Asana sync above keeps
    # its own advisory-lock gating. See leader.py.
    def _start_background_jobs():
        import asyncio as _a
        _tasks = []
        try:
            from reminders import reminders_loop
            _tasks.append(_a.create_task(reminders_loop()))
        except Exception as e:
            print(f"[startup] reminders skipped: {e}")
        try:
            from ticket_notify import ticket_notify_loop
            _tasks.append(_a.create_task(ticket_notify_loop()))
        except Exception as e:
            print(f"[startup] ticket notification loop skipped: {e}")
        try:
            from task_notify import task_notify_loop
            _tasks.append(_a.create_task(task_notify_loop()))
        except Exception as e:
            print(f"[startup] task notification loop skipped: {e}")
        try:
            from timeclock_watch import long_session_loop
            _tasks.append(_a.create_task(long_session_loop()))
        except Exception as e:
            print(f"[startup] long-session watch skipped: {e}")
        try:
            from teams_post import teams_post_loop
            _tasks.append(_a.create_task(teams_post_loop()))
        except Exception as e:
            print(f"[startup] teams post queue skipped: {e}")
        # These two keep their own is_sync_worker() gate INSIDE the leader's job
        # set, and the two gates answer different questions. Leader election stops
        # several web instances doing the same work twice; is_sync_worker stops a
        # developer's laptop doing it at all - and a laptop is exactly where the
        # leader check does not help, since on SQLite there is no lease and the
        # jobs simply run (see leader.py). A mailbox message read on a laptop is a
        # message the deployed API never sees.
        try:
            from asana_sync import is_sync_worker as _is_sync_worker
            if _is_sync_worker():
                from task_inbound import task_inbound_loop
                _tasks.append(_a.create_task(task_inbound_loop()))
            else:
                print("[startup] task inbound email drain skipped (not the sync worker)")
        except Exception as e:
            print(f"[startup] task inbound email drain skipped: {e}")
        # One-time: relocate work-monitoring screenshots hr-docs -> time-monitoring
        # bucket. Sync-worker gated (touches live storage with the service key; a
        # laptop must never run it) + its own pg advisory lock inside. Self-idles
        # once every frame is moved, so it's safe to leave wired across deploys.
        try:
            from asana_sync import is_sync_worker as _is_sync_worker3
            if _is_sync_worker3():
                from screenshot_migrate import screenshot_migration_loop
                _tasks.append(_a.create_task(screenshot_migration_loop()))
            else:
                print("[startup] screenshot bucket migration skipped (not the sync worker)")
        except Exception as e:
            print(f"[startup] screenshot bucket migration skipped: {e}")
        # Retention sweep: delete monitoring frames older than
        # NEXUS_SHOT_RETENTION_DAYS (default 90). Same gating story as the
        # migration above - live storage deletes belong to the sync worker only.
        try:
            from asana_sync import is_sync_worker as _is_sync_worker4
            if _is_sync_worker4():
                from screenshot_retention import screenshot_retention_loop
                _tasks.append(_a.create_task(screenshot_retention_loop()))
            else:
                print("[startup] screenshot retention sweep skipped (not the sync worker)")
        except Exception as e:
            print(f"[startup] screenshot retention sweep skipped: {e}")
        try:
            from asana_sync import is_sync_worker as _is_sync_worker
            if _is_sync_worker():
                from construction_worker import construction_sweep_loop
                _tasks.append(_a.create_task(construction_sweep_loop()))
            else:
                print("[startup] construction Egnyte sweep skipped (not the sync worker)")
        except Exception as e:
            print(f"[startup] construction sweep skipped: {e}")
        # Nightly Nexus -> M365 writeback (Neil, Aug 11). Sync-worker gated for
        # the same reason as the inbound mail drain: a Graph PATCH from a
        # laptop is a REAL write to the live directory with local dev data.
        try:
            from asana_sync import is_sync_worker as _is_sync_worker2
            if _is_sync_worker2():
                from reminders import m365_pushback_loop
                _tasks.append(_a.create_task(m365_pushback_loop()))
            else:
                print("[startup] nightly M365 writeback skipped (not the sync worker)")
        except Exception as e:
            print(f"[startup] nightly M365 writeback skipped: {e}")
        try:
            # One-shot: drains task attachments inlined as data: URLs into
            # Supabase Storage (5.7 GB of the prod DB), then exits. Idempotent.
            from task_files import attachment_migration_loop
            _tasks.append(_a.create_task(attachment_migration_loop()))
        except Exception as e:
            print(f"[startup] attachment backlog migration skipped: {e}")
        print(f"[startup] background jobs started ({len(_tasks)} loops)")
        return _tasks
    try:
        import asyncio as _asyncio
        import leader
        _asyncio.create_task(leader.elect_and_run(_start_background_jobs))
        print("[startup] background-jobs leader election started")
    except Exception as e:
        print(f"[startup] leader election unavailable, running jobs directly: {e}")
        _start_background_jobs()
    yield


app = FastAPI(title="Nexus API", lifespan=lifespan)


@app.middleware("http")
async def _bff_csrf_guard(request, call_next):
    """CSRF enforcement for BFF cookie-authenticated writes. The browser sends the
    session cookie automatically, so a mutating request that carries it must ALSO
    carry a matching X-CSRF-Token (double-submit). Bearer/token requests have no
    session cookie and are immune to CSRF, so they pass untouched. SameSite=Lax
    already blocks the common vector; this is defense in depth. Runs the DB check
    in a thread so it never blocks the event loop."""
    import bff_session
    if (bff_session.configured()
            and request.method in ("POST", "PUT", "PATCH", "DELETE")
            and not request.url.path.startswith("/auth/")):
        sid = request.cookies.get(bff_session.SESSION_COOKIE, "")
        if sid:   # a cookie-authenticated write -> require a matching CSRF token
            hdr = request.headers.get("X-CSRF-Token", "")

            def _ok():
                from database import SessionLocal
                from models import ServerSession
                db = SessionLocal()
                try:
                    row = db.query(ServerSession).filter(ServerSession.id == sid).first()
                    return bool(row and hdr and hdr == row.csrf_token)
                finally:
                    db.close()

            import asyncio
            if not await asyncio.to_thread(_ok):
                from starlette.responses import JSONResponse
                return JSONResponse(status_code=403, content={"detail": "CSRF token missing or invalid"})
    return await call_next(request)


# Error tracking: inert without a DSN. Set NEXUS_SENTRY_DSN (and pip install
# sentry-sdk) to stream unhandled exceptions to Sentry; until then the
# exception handler below + client-errors endpoint are the error trail.
if os.getenv("NEXUS_SENTRY_DSN"):
    try:
        import sentry_sdk
        sentry_sdk.init(dsn=os.getenv("NEXUS_SENTRY_DSN"), traces_sample_rate=0.05)
        print("[startup] sentry error tracking enabled")
    except ImportError:
        print("[startup] NEXUS_SENTRY_DSN set but sentry-sdk not installed - skipped")

# Gzip every response over ~1 KB. The item list is ~300 KB of JSON that compresses
# to ~10% - the single biggest win for the slow Item Management load over the wire.
app.add_middleware(GZipMiddleware, minimum_size=1024)
# ETag/304 revalidation + auth-failure throttling (see middleware_hardening.py).
# Added after GZip so ETags hash the compressed bytes; CORS stays outermost.
from middleware_hardening import ETagMiddleware, AuthFailureThrottle  # noqa: E402
app.add_middleware(ETagMiddleware)
app.add_middleware(AuthFailureThrottle)
# AuditMiddleware must be added before CORSMiddleware so it wraps the full request
app.add_middleware(AuditMiddleware)
_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",   # Knowledge Base standalone dev workspace
    "http://127.0.0.1:5174",
    "https://nexus.greensglobal.com",
    "https://dev.nexus.greensglobal.com",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request, exc):
    """Catch-all for unhandled exceptions. Starlette runs this in the OUTERMOST
    middleware layer - outside CORSMiddleware - so without the manual CORS
    headers below, browsers can't read the 500 at all and report every crashed
    endpoint as a CORS failure ("No 'Access-Control-Allow-Origin' header"),
    which is exactly how the Jul 24 missing-column incident presented. With
    them, the client sees a real 500, the retry/backoff logic engages, and the
    reconnecting banner tells users the truth."""
    import traceback
    print(f"[unhandled] {request.method} {request.url.path}: {exc}")
    traceback.print_exception(exc)
    headers = {}
    origin = request.headers.get("origin", "")
    if origin in _CORS_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=500, content={"detail": "Internal server error"}, headers=headers)


@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/health")
def health():
    """No-auth liveness probe - used by frontend to detect outages without burning a token."""
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready():
    """Deep READINESS probe for blue-green (Azure slot warm-up + swap): reports
    'ready' only once the DB is actually reachable, so a slot swap / load-balancer
    completes only when this instance can serve real traffic. Distinct from
    /health (shallow liveness): a DB blip trips readiness -> drain traffic, without
    tripping liveness -> which would needlessly restart the worker. No auth."""
    from fastapi.responses import JSONResponse
    from sqlalchemy import text
    from database import SessionLocal
    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception as e:  # noqa: BLE001 - readiness must report, not raise
        return JSONResponse(status_code=503, content={"status": "not_ready", "detail": str(e)[:160]})
    finally:
        db.close()


@app.get("/health/leader")
def health_leader():
    """No-auth readout of the background-job leader lease (see leader.py). After you
    scale out to 2 instances, hit this on the site to eyeball who's running the loops:
    `this_instance` is whoever answered THIS request (the LB may route you to either),
    `leader` is the current lease holder, `is_this_instance_leader` says whether they're
    the same, and `heartbeat_age_seconds` should stay under ~15s on a healthy leader
    (over 45s means the leader went silent and another instance is about to take over)."""
    import leader as _leader
    from fastapi.responses import JSONResponse
    from sqlalchemy import text
    from database import SessionLocal
    this_instance = _leader._INSTANCE
    if _leader._IS_SQLITE:
        return {"this_instance": this_instance, "leader": this_instance,
                "is_this_instance_leader": True, "heartbeat_age_seconds": 0,
                "note": "single-process (SQLite) - always leader, no lease"}
    db = SessionLocal()
    try:
        row = db.execute(text(
            "SELECT holder, round(extract(epoch FROM (now() - heartbeat_at))) AS age "
            "FROM nexus_leader WHERE id = 1"
        )).first()
        holder = row[0] if row else None
        age = int(row[1]) if row and row[1] is not None else None
        return {"this_instance": this_instance, "leader": holder,
                "is_this_instance_leader": holder == this_instance,
                "heartbeat_age_seconds": age}
    except Exception as e:  # noqa: BLE001 - readout must report, not raise
        return JSONResponse(status_code=503, content={"detail": str(e)[:160]})
    finally:
        db.close()


@app.get("/version")
def version():
    return {"version": "2.0.0", "auth": "token-based"}


app.include_router(tasks.router)
app.include_router(purchases.router)
app.include_router(reviews.router)
app.include_router(marketing.router)
app.include_router(sop.router)
app.include_router(external_links.router) # External Links: registered BEFORE assets.router so its real
                                           # GET/POST/click routes win the match over assets.py's leftover
                                           # /external-links stub (Starlette matches in registration order,
                                           # first route added wins on a path collision) - see
                                           # routers/external_links.py's module docstring.
app.include_router(external_links.personal_router) # Personal Links: private, owner-scoped shortcuts (Aug 12)
app.include_router(assets.router)
app.include_router(property_assets.router)
app.include_router(accounting.router)
app.include_router(operations.router)
app.include_router(unifi.router)
app.include_router(dashboard.router)
app.include_router(dashboards_router.router)
app.include_router(requisitions.router)
app.include_router(roles.router)
app.include_router(notifications.router)
app.include_router(audit.router)
app.include_router(groups.router)
app.include_router(jobroles.router)
app.include_router(access_scopes.router)
app.include_router(qa.router)
app.include_router(items_router.router)
app.include_router(hr.router)
app.include_router(knowledge_base.router)
app.include_router(help_router.router)
app.include_router(esign.router)
app.include_router(documents_router.router)
app.include_router(timeclock.router)
app.include_router(myhr.router)
app.include_router(hr_interviews.router)
app.include_router(task_projects.router)  # Task Module: projects/portfolios/departments
app.include_router(task_config.router)    # Task Module: views/rules/templates/notifications/changelog
app.include_router(tickets_router.router) # Ticket Module: tickets, conversation, components, links, escalation
app.include_router(credvault.router)      # Credential Vault: encrypted company/personal secrets ("credvault" grant)
app.include_router(asana_webhook.router)  # Asana two-way sync: public webhook receiver (verified by HMAC)
app.include_router(asana_oauth_router.router)         # Per-user Asana connection (signed-in user, own grant only)
app.include_router(construction.router)  # Construction: projects, daily logs, jobsite media
app.include_router(asana_oauth_router.public_router)  # OAuth callback - Asana redirects a browser here, no bearer token
app.include_router(egnyte_oauth_router.router)        # Per-user Egnyte connection (browse with YOUR OWN Egnyte permissions)
app.include_router(egnyte_oauth_router.public_router) # OAuth callback - Egnyte redirects a browser here, no bearer token
app.include_router(policy.router)         # Sign-in company-policy & monitoring acknowledgment
app.include_router(investor_relations.router)  # Investor Relations: funds/investors/commitments/calls/distributions
app.include_router(stepup.router)         # Step-up MFA for sensitive data (vault reveals / payroll / confidential HR)
app.include_router(act_as.router)         # Act As: impersonate a lower-role employee's account
app.include_router(branding.router)       # Branding settings: login-screen accent color
app.include_router(egnyte.router)         # Egnyte: list/read/upload/search, one shared client
from routers import client_errors          # noqa: E402
app.include_router(client_errors.router)  # Client-side error intake -> audit trail + logs

from routers import auth_bff               # noqa: E402  BFF login (dual-mode)
app.include_router(auth_bff.router)        # /auth/login|callback|logout|me - inert without NEXUS_BFF_CLIENT_SECRET

