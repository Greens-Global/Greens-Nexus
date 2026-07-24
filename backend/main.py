import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import text
import models
from database import engine, DATABASE_URL
from routers import timeclock
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions, roles, notifications, audit, groups, items as items_router, hr, knowledge_base, help as help_router, property_assets, esign, dashboards as dashboards_router, myhr, hr_interviews
# NOTE: `inventory_requests` router retired Jul 2026 (P2-1) — legacy inventory stack removed.
from routers import task_projects, task_config  # Task Module (Jul 2026)
from routers import tickets as tickets_router    # Ticket Module — split out of task_config (Jul 2026)
from routers import asana_webhook  # Asana two-way sync — public webhook receiver
from routers import jobroles  # Roles & Access redesign (Jul 2026)
from routers import access_scopes  # row-level scopes for external users (Jul 2026)
from routers import qa  # Testing module — dev-only via NEXUS_QA_MODULE env (Jul 2026)
from routers import credvault  # Credential Vault (Jul 2026)
from routers import policy  # Sign-in company-policy & monitoring acknowledgment (Jul 2026)
from routers import documents as documents_router  # Documents DMS Phase 1 (Jul 2026)
from routers import investor_relations  # Investor Relations platform (Jul 2026)
from routers import stepup  # Step-up MFA for sensitive data (vault/payroll/HR) (Jul 2026)
from audit import AuditMiddleware


def _run_migrations():
    """Add columns that were introduced after the initial table creation."""
    if DATABASE_URL.startswith("sqlite"):
        # create_all builds NEW tables but never alters existing ones — columns
        # added to models after a local DB was created must be patched in here
        # (a model column missing from the DB breaks every SELECT with a 500).
        # SQLite has no IF NOT EXISTS for columns; duplicates just error and
        # are swallowed.
        sqlite_migrations = [
            "ALTER TABLE payroll_rates ADD COLUMN overtime_rule VARCHAR DEFAULT 'ca'",
            "ALTER TABLE agent_activity ADD COLUMN domain VARCHAR DEFAULT ''",
            "ALTER TABLE agent_activity ADD COLUMN category VARCHAR DEFAULT ''",
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
            "ALTER TABLE time_punches ADD COLUMN category VARCHAR DEFAULT ''",
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
            "ALTER TABLE task_projects ADD COLUMN department_ids JSON DEFAULT '[]'",
            # Roles & Access redesign: job-role templates live on nexus_groups
            "ALTER TABLE nexus_groups ADD COLUMN is_job_role INTEGER DEFAULT 0",
            "ALTER TABLE nexus_groups ADD COLUMN tier VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_groups ADD COLUMN description VARCHAR DEFAULT ''",
            "ALTER TABLE nexus_groups ADD COLUMN monitoring_exempt INTEGER DEFAULT 0",
            # Company email domains — drive M365 import + auto company tagging
            "ALTER TABLE hr_entities ADD COLUMN domains VARCHAR DEFAULT ''",
            # Company manager (operational head; escalation target)
            "ALTER TABLE hr_entities ADD COLUMN manager_email VARCHAR DEFAULT ''",
            # ── Item Module QA (P2-5, Jul 2026): SQLite was missing columns the
            # Postgres list already carried — a pre-existing local DB 500s on
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
            # serial is the identity + import upsert key — enforce uniqueness
            # (blanks excluded so legacy/not-yet-serialised rows are fine; also
            # stops a local import silently creating duplicate serials).
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_items_serial_unique ON items (serial_number) WHERE serial_number <> ''",
            # ── Item Module hot-path indexes (P2-4) + live-row concurrency guards
            # (P1-1). SQLite supports partial (WHERE) indexes; a partial-unique
            # that can't build over pre-existing duplicate live rows errors here
            # and is swallowed by the per-statement try/except below — never aborts
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
            # function) already creates it empty before we get here — a plain
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
            # projects backfill to 'org' (everyone already saw everything) —
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
            # Documents (DMS) Phase 4: merge-field subject/company for export
            "ALTER TABLE documents ADD COLUMN employee_id VARCHAR DEFAULT ''",
            "ALTER TABLE documents ADD COLUMN entity_id VARCHAR DEFAULT ''",
            # Documents (DMS) Phase 11: manual merge-field overrides + custom variables
            "ALTER TABLE documents ADD COLUMN merge_overrides JSON DEFAULT '{}'",
            # Documents (DMS) Phase 12: same override/custom-variable support on templates
            "ALTER TABLE doc_templates ADD COLUMN merge_overrides JSON DEFAULT '{}'",
            # ── HR Section A/B (nexus_employees): SQLite was missing columns the
            # Postgres list already carried — a pre-existing local DB 500s on
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
            "ALTER TABLE ir_funds ADD COLUMN property_asset_id VARCHAR DEFAULT ''",
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
        "ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS domain VARCHAR DEFAULT ''",
        "ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS category VARCHAR DEFAULT ''",
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
        # item_checkouts: handover/receipt photo flow (added to model but migration was missed — broke prod SELECTs)
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
        # Fleet department retired — vehicles belong to Construction (Neil, Jun 2026)
        "UPDATE items SET department = 'Construction' WHERE department = 'Fleet'",
        # items: per-item photo policy + dollar value (Neil, Jun 2026 review)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS picture_required BOOLEAN DEFAULT TRUE",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_value DOUBLE PRECISION DEFAULT 0",
        # items: static per-unit serial — the import upsert key (replaces name matching, Jun 2026)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS serial_number VARCHAR DEFAULT ''",
        # serial is the identity now — enforce uniqueness (blanks excluded so legacy
        # rows + not-yet-serialised items are fine; catches concurrent double-assign)
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_items_serial_unique ON items (serial_number) WHERE serial_number <> ''",
        # Permanent items were auto-stamped permanently_assigned at creation even
        # with nobody attached — unstamp the ones that never got a real assignee
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
        # items: operational status column (Neil — deployed/in repair/needs replacement; SEPARATE from lifecycle status)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS op_status VARCHAR DEFAULT ''",
        # items: permanent assignment to a PLACE not a person — excluded from "Who has it" (Ankush)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_location VARCHAR DEFAULT ''",
        # items: admin-defined custom fields, values keyed by field_key (Ankush's Details panel)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb",
        # items: soft-delete so deletions are restorable and carry a "Deleted In" (Ankush)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_by VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_location VARCHAR DEFAULT ''",
        # items: person an op_status (lost/retired) is declared against — they get the notification + show on "Who has it"
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
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS undone_at VARCHAR DEFAULT ''",
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS undone_by VARCHAR DEFAULT ''",
        # HR Section A: which legal entity employs each worker
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS company VARCHAR DEFAULT ''",
        # HR Section A: contractor worker type — scope/SOW/dates/rate/billing client
        "ALTER TABLE nexus_employees ADD COLUMN IF NOT EXISTS contractor JSONB DEFAULT '{}'::jsonb",
        # HR Section B: profile depth — personal/compliance open; compensation+bank RESTRICTED (hr_comp grant)
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
        "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS category VARCHAR DEFAULT ''",
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
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS department_ids JSONB DEFAULT '[]'::jsonb",
        # Roles & Access redesign: job-role templates live on nexus_groups
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS is_job_role INTEGER DEFAULT 0",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS tier VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS description VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_groups ADD COLUMN IF NOT EXISTS monitoring_exempt INTEGER DEFAULT 0",
        # Company email domains — drive M365 import + auto company tagging
        "ALTER TABLE hr_entities ADD COLUMN IF NOT EXISTS domains VARCHAR DEFAULT ''",
        # Company manager (operational head; escalation target)
        "ALTER TABLE hr_entities ADD COLUMN IF NOT EXISTS manager_email VARCHAR DEFAULT ''",
        # ── Item Module hot-path indexes (P2-4) + live-row concurrency guards
        # (P1-1). Postgres supports partial (WHERE) indexes; a partial-unique
        # that can't build over pre-existing duplicate live rows raises here and
        # is caught + logged by the per-statement try/except below — it never
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
        # function) already creates it empty before we get here — a plain
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
        # projects backfill to 'org' (everyone already saw everything) — only
        # newly-created projects default to 'restricted' (create_project).
        "ALTER TABLE task_projects ADD COLUMN IF NOT EXISTS access_level VARCHAR DEFAULT 'org'",
        # Documents (DMS) Phase 4: merge-field subject/company for export
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS employee_id VARCHAR DEFAULT ''",
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS entity_id VARCHAR DEFAULT ''",
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS merge_overrides JSONB DEFAULT '{}'::jsonb",
        "ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS merge_overrides JSONB DEFAULT '{}'::jsonb",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
            except Exception as e:
                print(f"[migration] skipped: {e}")
        conn.commit()


# NOTE (P2-1, Jul 2026): the legacy inventory_items mock seed (~34 rows) was
# removed with the rest of the retired inventory stack. The InventoryItem model
# is kept (models.py) so create_all preserves the table + any historical rows,
# but nothing seeds fake data on fresh DBs anymore.


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to start if NEXUS_SKIP_AUTH is set while running on Azure App
    # Service — the env var is for local development only and must never reach
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
    # Daily HR reminders (doc/visa expiry, contract ends, new starters,
    # interviews, expiring e-sign) — dedupes per day, safe across restarts.
    try:
        import asyncio as _asyncio
        from reminders import reminders_loop
        _asyncio.create_task(reminders_loop())
        print("[startup] daily reminders scheduled")
    except Exception as e:
        print(f"[startup] reminders skipped: {e}")
    # Asana sync fallback poll (webhooks handle real-time; this is the safety net).
    try:
        from asana_sync import start_auto_pull, is_sync_worker
        start_auto_pull()
        print(f"[startup] asana auto-pull {'scheduled' if is_sync_worker() else 'skipped (not the sync worker)'}")
    except Exception as e:
        print(f"[startup] asana auto-pull skipped: {e}")
    # Ticket Notification workflow — retries failed/stuck Outlook emails and
    # auto-closes long-resolved tickets. Same bare-asyncio-loop pattern as the
    # HR reminders job above.
    try:
        import asyncio as _asyncio
        from ticket_notify import ticket_notify_loop
        _asyncio.create_task(ticket_notify_loop())
        print("[startup] ticket notification retry/auto-close loop scheduled")
    except Exception as e:
        print(f"[startup] ticket notification loop skipped: {e}")
    yield


app = FastAPI(title="Greens Nexus API", lifespan=lifespan)

# Gzip every response over ~1 KB. The item list is ~300 KB of JSON that compresses
# to ~10% — the single biggest win for the slow Item Management load over the wire.
app.add_middleware(GZipMiddleware, minimum_size=1024)
# AuditMiddleware must be added before CORSMiddleware so it wraps the full request
app.add_middleware(AuditMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",   # Knowledge Base standalone dev workspace
        "http://127.0.0.1:5174",
        "https://nexus.greensglobal.com",
        "https://dev.nexus.greensglobal.com",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/health")
def health():
    """No-auth liveness probe — used by frontend to detect outages without burning a token."""
    return {"status": "ok"}


@app.get("/version")
def version():
    return {"version": "2.0.0", "auth": "token-based"}


app.include_router(tasks.router)
app.include_router(purchases.router)
app.include_router(reviews.router)
app.include_router(marketing.router)
app.include_router(sop.router)
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
app.include_router(policy.router)         # Sign-in company-policy & monitoring acknowledgment
app.include_router(investor_relations.router)  # Investor Relations: funds/investors/commitments/calls/distributions
app.include_router(stepup.router)         # Step-up MFA for sensitive data (vault reveals / payroll / confidential HR)

