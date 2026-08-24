from sqlalchemy import BigInteger, Boolean, Column, Float, Integer, JSON, String, Text, UniqueConstraint
from database import Base


# ─────────────────────────────────────────────────────────────────────────────
# Task Module (ported from the standalone task-module export - Jul 2026)
# The old flat demo `tasks` table (title/assignee/project/hours/dept/synced) was
# replaced by the rich runtime schema below. All identity is email-keyed (joins
# to nexus_employees), timestamps are ISO strings, arrays/maps are jsonb. Real
# tables get RLS ON with no policies (backend uses the service role); only the
# task_events ping table is anon-readable for Supabase realtime.
# ─────────────────────────────────────────────────────────────────────────────
class Task(Base):
    __tablename__ = "tasks"
    id                = Column(String, primary_key=True)   # client/server id (e.g. uuid)
    code              = Column(String, default="")         # human key, e.g. "TASK-001"
    title             = Column(String, nullable=False)
    description       = Column(String, default="")
    type              = Column(String, default="task")     # task|subtask|milestone|approval|section
    status            = Column(String, default="not_started")  # + custom board-column ids
    # Manual drag-order within whatever grouping a view has on screen. Fractional
    # on purpose - a drag between two neighbors sets a value between their two
    # positions, so ONE row moves without renumbering every sibling. Defaults to
    # the task's creation time (see create_task) so untouched tasks fall back to
    # creation order, the same order they've always shown in.
    position          = Column(Float, default=0.0, index=True)
    priority          = Column(String, default="medium")   # low|medium|high|urgent
    assignee_email    = Column(String, default="", index=True)
    owner_email       = Column(String, default="", index=True)
    follower_emails   = Column(JSON, default=list)
    liked_by_emails   = Column(JSON, default=list)
    access_level      = Column(String, default="org")      # org|restricted
    project_id        = Column(String, default="", index=True)  # primary - drives section/access/Asana sync
    project_ids       = Column(JSON, default=list)         # EXTRA projects, Nexus-only (never synced to Asana,
                                                             # which stays keyed on project_id alone) - lets a task
                                                             # show up under several projects without duplicating it
    section_id        = Column(String, default="")
    team_id           = Column(String, default="", index=True)  # TaskTeam within this task's project
    parent_task_id    = Column(String, default="", index=True)
    subtask_ids       = Column(JSON, default=list)
    blocked_by_ids    = Column(JSON, default=list)
    blocking_ids      = Column(JSON, default=list)
    dependency_types  = Column(JSON, default=dict)         # {blockerTaskId: "FS"|"FF"|"SS"|"SF"}
    tags              = Column(JSON, default=list)
    custom_field_values = Column(JSON, default=dict)       # {customFieldId: value}
    start_on          = Column(String, default="")         # ISO yyyy-mm-dd
    due_on            = Column(String, default="")         # ISO yyyy-mm-dd
    estimate_hours    = Column(Float, nullable=True)
    actual_hours      = Column(Float, nullable=True)
    recurrence        = Column(JSON, nullable=True)        # {freq,interval,dayOfWeek?,dayOfMonth?}
    is_milestone      = Column(Boolean, default=False)
    approval_status   = Column(String, default="none")     # none|pending|approved|rejected|changes_requested
    completed         = Column(Boolean, default=False)
    completed_at      = Column(String, default="")
    comment_ids       = Column(JSON, default=list)         # denormalised for the runtime shape
    attachment_ids    = Column(JSON, default=list)
    activity_ids      = Column(JSON, default=list)
    created_at        = Column(String, default="")
    modified_at       = Column(String, default="")
    created_by        = Column(String, default="")         # email
    synced_with_asana = Column(Boolean, default=False)


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"
    id = Column(Integer, primary_key=True, autoincrement=True)
    item = Column(String, nullable=False)
    vendor = Column(String, default="")
    cost = Column(Float, default=0)
    qty = Column(Integer, default=1)
    dept = Column(String, nullable=False)
    status = Column(String, default="pending")


class Review(Base):
    __tablename__ = "reviews"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    property = Column(String, nullable=False)
    platform = Column(String, default="Google")
    date = Column(String, nullable=False)
    rating = Column(Integer, nullable=False)
    comment = Column(String, nullable=False)
    replied = Column(Boolean, default=False)
    reply_text = Column(String, default="")
    ai_reply = Column(String, default="")
    badge = Column(String, default="")
    badge_color = Column(String, default="")
    is_new = Column(Boolean, default=False)


class MarketingCampaign(Base):
    __tablename__ = "marketing_campaigns"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    property = Column(String, nullable=False)
    platform = Column(String, nullable=False)
    impressions = Column(Integer, default=0)
    clicks = Column(Integer, default=0)
    conversions = Column(Integer, default=0)
    abandoned_carts = Column(Integer, default=0)
    spend = Column(Float, default=0)
    cost_per_conv = Column(Float, default=0)
    status = Column(String, default="Active")


class SopUpdate(Base):
    __tablename__ = "sop_updates"
    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    category = Column(String, nullable=False)
    status = Column(String, default="Published")
    date = Column(String, nullable=False)


class Asset(Base):
    __tablename__ = "assets"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    assigned_to = Column(String, default="Unassigned")
    status = Column(String, default="Available")
    last_seen = Column(String, nullable=False)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    dept = Column(String, nullable=False)
    role = Column(String, nullable=False)
    access_level = Column(String, nullable=False)
    status = Column(String, default="Active")
    last_login = Column(String, default="")


class Website(Base):
    __tablename__ = "websites"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    domain = Column(String, nullable=False)
    ssl_days = Column(Integer, default=90)
    uptime = Column(Float, default=99.9)
    status = Column(String, default="Online")


class ExternalLink(Base):
    __tablename__ = "external_links"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    url = Column(String, nullable=False)
    # Legacy single-value columns (kept, unused going forward) - superseded
    # by categories/departments below (Aug 14, "add multiple checkbox option
    # in departments and category"). Changing an EXISTING column's type on a
    # live table is exactly the kind of migration this codebase avoids
    # (CLAUDE.md), so these were left in place and new plural JSON-array
    # columns added alongside instead, backfilled once from these on deploy.
    category = Column(String, nullable=False)
    department = Column(String, default="")
    description = Column(String, default="")
    clicks = Column(Integer, default=0)
    # A link can now belong to several categories/departments at once - "" /
    # [] still means company-wide (shown regardless of department filter).
    # `icon` is a lucide-react icon key resolved client-side, not a URL.
    # sort_order is admin drag-order within a category; is_pinned floats a
    # tile into "Pinned" regardless of department/category filters.
    categories = Column(JSON, default=list)
    departments = Column(JSON, default=list)
    icon = Column(String, default="Link2")
    sort_order = Column(Integer, default=0)
    is_pinned = Column(Boolean, default=False)
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    updated_at = Column(String, default="")
    # Company filter (Aug 12) - HrEntity.id, same "" = every company / a named
    # id scopes it convention as department above. Free-standing from
    # department on purpose: a link can be company-wide but department-
    # specific (e.g. Accounting at Greens India) or vice versa.
    company = Column(String, default="")


class ExternalLinkTaxonomy(Base):
    """Admin-managed Department/Category picker options for External Links
    (Aug 14 - "give the option to add, rename and remove any department and
    categories"). Before this, the two lists were a hardcoded frontend
    constant with no backend existence at all - an admin could only ever
    grow the Category list implicitly (typing a new value directly on a
    link; that field is free text with an autocomplete), and could never
    grow Department at all (a strict dropdown with no way to add an
    option). This gives both explicit CRUD.

    ExternalLink.department/category stay plain free-text string columns,
    NOT a foreign key to this table - a link keeps whatever string it has
    even after that name is deleted from here (deleting only removes it
    from the curated picker, same free-text philosophy Category already
    had). Renaming, though, bulk-updates every ExternalLink row currently
    using the old string in the same request, so a rename doesn't silently
    orphan existing links onto a name that no longer appears in the picker."""
    __tablename__ = "external_link_taxonomy"
    id = Column(String, primary_key=True)  # uuid
    kind = Column(String, nullable=False)  # "department" | "category"
    name = Column(String, nullable=False)
    sort_order = Column(Integer, default=0)
    created_at = Column(String, default="")


class PersonalLink(Base):
    """Personal Links (Aug 2026) - an employee's own day-to-day shortcuts,
    separate from the curated ExternalLink directory above. Private by
    construction: every query filters on owner_email, so one person's rows
    are never visible to another regardless of role - there is no "shared"
    or admin-visible mode for this table."""
    __tablename__ = "personal_links"
    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_email = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    url = Column(String, nullable=False)
    description = Column(String, default="")
    icon = Column(String, default="Link2")
    sort_order = Column(Integer, default=0)
    clicks = Column(Integer, default=0)
    created_at = Column(String, default="")
    updated_at = Column(String, default="")
    # Optional pointer to the owner's own Credential Vault personal credential
    # (vault_personal_credentials.id) - Aug 13, so opening the link can copy
    # the password to the clipboard first instead of the user having to look
    # it up separately. No FK constraint: personal credentials are a separate
    # module (gated by the "credvault" grant) and can be deleted independently
    # - a dangling id here just means the copy-password step is skipped.
    vault_cred_id = Column(String, default="")
    # department/category (Aug 14) - same free-text fields ExternalLink has,
    # own filter bar on the Personal Links tab. Values come from the same
    # admin-managed external_link_taxonomy picker Company Links uses (one
    # shared vocabulary makes sense even though these rows are private), but
    # nothing stops a personal free-text value either - not validated
    # against the taxonomy table server-side, same posture as Category on
    # ExternalLink.
    department = Column(String, default="")
    category = Column(String, default="")


class AccountingTrx(Base):
    __tablename__ = "accounting_trx"
    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    date = Column(String, nullable=False)
    cost = Column(Float, nullable=False)


class RampTransaction(Base):
    __tablename__ = "ramp_transactions"
    id = Column(String, primary_key=True)
    vendor = Column(String, nullable=False)
    cost = Column(Float, nullable=False)
    date = Column(String, nullable=False)
    category = Column(String, nullable=False)
    memo = Column(String, default="")
    missing = Column(Boolean, default=False)


class AmaEntity(Base):
    __tablename__ = "ama_entities"
    id = Column(Integer, primary_key=True, autoincrement=True)
    entity = Column(String, nullable=False)
    status = Column(String, default="Active")
    fee_rate = Column(Float, default=0)
    billed_ytd = Column(Float, default=0)
    next_billing = Column(String, default="TBD")


class OpsProject(Base):
    __tablename__ = "ops_projects"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    status = Column(String, default="on-track")
    location = Column(String, nullable=False)
    members = Column(Integer, default=0)
    due_date = Column(String, nullable=False)
    progress = Column(Integer, default=0)


class DevProject(Base):
    __tablename__ = "dev_projects"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    type = Column(String, nullable=False)
    status = Column(String, default="planning")
    location = Column(String, nullable=False)
    cost = Column(Float, default=0)
    due_date = Column(String, nullable=False)
    roi = Column(Float, default=0)


class LmsCourse(Base):
    __tablename__ = "lms_courses"
    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    category = Column(String, nullable=False)
    duration = Column(String, nullable=False)
    progress = Column(Integer, default=0)
    status = Column(String, default="Enrolled")


class Requisition(Base):
    __tablename__ = "requisitions"
    id = Column(String, primary_key=True)
    employee_name = Column(String, nullable=False)
    employee_email = Column(String, default="")   # added for auth-based scoping
    employee_dept = Column(String, nullable=False)
    item = Column(String, nullable=False)
    quantity = Column(Integer, default=1)
    reason = Column(String, default="")
    status = Column(String, default="pending_manager")
    supervisor_name = Column(String, default="")
    manager_name = Column(String, default="")
    manager_approval_date = Column(String, default="")
    rejection_reason = Column(String, default="")
    asset_id = Column(String, default="")
    asset_name = Column(String, default="")
    asset_category = Column(String, default="")
    asset_serial = Column(String, default="")
    asset_allocated_date = Column(String, default="")
    expected_return_date = Column(String, default="")
    actual_return_date = Column(String, default="")
    return_confirmed_by = Column(String, default="")
    return_asset_condition = Column(String, default="")
    return_photo_name = Column(String, default="")
    return_photo_url  = Column(String, default="")
    allocated_by = Column(String, default="")
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    # Purchase fulfillment flow (Jun 2026): manager picks who procures the item
    allocator_email   = Column(String, default="")
    allocator_name    = Column(String, default="")
    ordered_at        = Column(String, default="")
    fulfilled_at      = Column(String, default="")
    fulfillment_note  = Column(String, default="")
    fulfilled_item_id = Column(String, default="")  # items.id once it entered inventory
    # Who actually raised the request (from the auth token), distinct from
    # employee_email which is the beneficiary on an on-behalf request. Lets the
    # log/notifications name the real submitter instead of guessing (Jul 2026).
    submitted_by_email = Column(String, default="")
    submitted_by_name  = Column(String, default="")


class HardwareAsset(Base):
    __tablename__ = "hardware_assets"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    serial_number = Column(String, default="")
    assigned_to = Column(String, default="Unassigned")
    dept = Column(String, default="")
    location = Column(String, default="")
    status = Column(String, default="Available")
    assigned_req_id = Column(String, default="")
    purchased = Column(String, default="")
    warranty_end = Column(String, default="")
    last_updated = Column(String, default="")


class NexusNotification(Base):
    __tablename__ = "nexus_notifications"
    id          = Column(String, primary_key=True)
    type        = Column(String, nullable=False)          # inv_request | req_pending | approved | rejected | overdue
    recipient   = Column(String, default=None)            # NULL = all managers, email = specific user
    title       = Column(String, nullable=False)
    body        = Column(String, nullable=False)
    ref_id      = Column(String, default="")              # inv request id / req id
    item_name   = Column(String, default="")
    requested_by = Column(String, default="")
    action      = Column(String, default="")              # serialised JSON for action button
    actioned    = Column(Boolean, default=False)
    read_by     = Column(String, default="")              # comma-separated emails
    created_at  = Column(String, nullable=False)


class InventoryRequest(Base):
    # LEGACY (P2-1, Jul 2026): the old inventory stack is retired - its router
    # (routers/inventory_requests.py) and mock seed were removed. No live code
    # path writes this table anymore; the class is kept only so create_all keeps
    # the table and historical rows / audit history (resource_type ==
    # "inventory-requests") stay readable. Retire after data migration.
    __tablename__ = "inventory_requests"
    id                 = Column(String, primary_key=True)
    item_id            = Column(String, nullable=False)
    item_name          = Column(String, nullable=False)
    requested_by       = Column(String, nullable=False)          # display name
    requested_by_email = Column(String, default="")              # email for targeting notifications
    raised_by          = Column(String, nullable=False)          # who submitted (supervisor or self)
    department         = Column(String, nullable=False)
    quantity           = Column(Integer, default=1)
    days               = Column(Integer, default=1)
    reason             = Column(String, default="")
    status             = Column(String, default="pending")       # pending|approved|allocated|rejected|returned|cancelled
    created_at         = Column(String, nullable=False)
    resolved_at        = Column(String, default="")
    resolved_by        = Column(String, default="")
    reject_reason      = Column(String, default="")
    assigned_allocator_email = Column(String, default="")        # who the manager picked to hand the item over
    assigned_allocator_name  = Column(String, default="")
    allocated_at       = Column(String, default="")
    allocated_by       = Column(String, default="")
    returned_at        = Column(String, default="")
    return_photo_name  = Column(String, default="")
    return_photo_url   = Column(String, default="")   # permanent Supabase Storage URL
    condition_note     = Column(String, default="")


class InventoryItem(Base):
    """LEGACY (P2-1, Jul 2026): master stock record for the retired inventory
    stack. Its router + mock seed were removed; kept only so create_all keeps
    the table and any historical rows survive. Retire after data migration.

    Master stock record for a requestable inventory item.
    available_qty is the live source of truth - decremented atomically when a
    request is allocated, incremented when it's returned in good condition
    (or total_qty is reduced instead, when the returned unit is damaged/retired)."""
    __tablename__ = "inventory_items"
    id            = Column(String, primary_key=True)
    name          = Column(String, nullable=False)
    category      = Column(String, default="")
    department    = Column(String, default="")
    location      = Column(String, default="")   # physical site/storage location, e.g. "GSVC", "GSE"
    total_qty     = Column(Integer, default=0)
    available_qty = Column(Integer, default=0)
    last_updated  = Column(String, default="")


class Item(Base):
    """Individual physical item. Each unit gets its own row; status flips replace qty counters."""
    __tablename__ = "items"
    id             = Column(String, primary_key=True)
    serial_number  = Column(String, default="")               # static per-unit identity (GG-#####); the CSV import upsert key
    name           = Column(String, nullable=False)
    item_type      = Column(String, default="Other")          # Devices|Tools|Vehicles|Equipment|Keys|Other
    make           = Column(String, default="")
    model          = Column(String, default="")
    year           = Column(String, default="")
    department     = Column(String, default="")
    default_owner  = Column(String, default="")
    ownership_type = Column(String, default="transient")      # permanent|transient
    status         = Column(String, default="available")      # available|checked_out|permanently_assigned|retired
    location       = Column(String, default="")
    photo_url      = Column(String, default="")
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    assigned_to_email = Column(String, default="")   # current permanent assignee
    assigned_to_name  = Column(String, default="")
    assigned_at       = Column(String, default="")
    picture_required  = Column(Boolean, default=True)  # False = photos optional in every flow (e.g. keys) - Neil, Jun 2026
    asset_value       = Column(Float, default=0.0)     # USD value: accountability + per-person holdings total
    op_status         = Column(String, default="")     # operational status (Neil): deployed|in_storage|in_repair|needs_replacement|retired|lost; '' = unset. SEPARATE from lifecycle `status`
    op_status_person_email = Column(String, default="") # person an op_status is declared against (lost/retired) - they get the notification + show on "Who has it"
    op_status_person_name  = Column(String, default="")
    # DEPRECATED (P2-6, Jul 2026): only ever written as "" now; ItemDetailsPanel
    # reads item.location instead. Retire (drop column) next release - needs
    # prod coordination, so the column stays for this release.
    assigned_to_location = Column(String, default="")  # legacy: permanent-to-a-PLACE marker; no longer populated
    custom_fields     = Column(JSON, default=dict)     # {field_key: value} for admin-defined custom fields - see ItemCustomField
    deleted_at        = Column(String, default="")     # ISO ts; non-empty = soft-deleted (excluded from normal lists, restorable - Ankush)
    deleted_by        = Column(String, default="")     # email of whoever deleted it
    deleted_location  = Column(String, default="")     # item's location captured at deletion - Ankush's "Deleted In"


class ItemCheckout(Base):
    """Checkout record for one transient item. One active checkout per physical item enforced on creation."""
    __tablename__ = "item_checkouts"
    id                       = Column(String, primary_key=True)
    item_id                  = Column(String, nullable=False)
    item_name                = Column(String, nullable=False)
    item_type                = Column(String, default="")
    requested_by             = Column(String, nullable=False)
    requested_by_email       = Column(String, default="")
    raised_by                = Column(String, nullable=False)
    department               = Column(String, default="")
    days                     = Column(Integer, default=1)
    reason                   = Column(String, default="")
    status                   = Column(String, default="pending")
    created_at               = Column(String, nullable=False)
    resolved_at              = Column(String, default="")
    resolved_by              = Column(String, default="")
    reject_reason            = Column(String, default="")
    assigned_allocator_email = Column(String, default="")
    assigned_allocator_name  = Column(String, default="")
    allocated_at             = Column(String, default="")
    allocated_by             = Column(String, default="")
    checkout_photo_url       = Column(String, default="")
    checkout_photo_name      = Column(String, default="")
    returned_at              = Column(String, default="")
    return_photo_url         = Column(String, default="")
    return_photo_name        = Column(String, default="")
    condition_note           = Column(String, default="")
    order_id                 = Column(String, default="")
    handover_photo_by        = Column(String, default="")   # 'allocator' | 'employee'
    handover_batch           = Column(Boolean, default=False)
    receipt_photo_url        = Column(String, default="")
    receipt_photo_name       = Column(String, default="")
    handed_over_at           = Column(String, default="")
    extension_days           = Column(Integer, default=0)   # extra days requested by employee
    extension_reason         = Column(String, default="")
    extension_status         = Column(String, default="")   # '' | 'pending' (cleared on resolve)
    approver_email           = Column(String, default="")   # manager picked at checkout - only they get the approval notification
    approver_name            = Column(String, default="")


class ItemCartEntry(Base):
    """Persisted cart entry - one row per (user, item). Survives logout and device switches."""
    __tablename__ = "item_cart"
    id         = Column(String, primary_key=True)   # uuid
    user_email = Column(String, nullable=False)
    item_id    = Column(String, nullable=False)
    item_name  = Column(String, nullable=False)
    item_type  = Column(String, default="Other")
    added_at   = Column(String, default="")


class ItemAssignment(Base):
    """Permanent assignment lifecycle for one item. One active/pending row per item.
    pending_acceptance -> active -> return_initiated -> closed | declined | cancelled"""
    __tablename__ = "item_assignments"
    id                  = Column(String, primary_key=True)
    item_id             = Column(String, nullable=False)
    item_name           = Column(String, default="")
    assignee_email      = Column(String, nullable=False)
    assignee_name       = Column(String, default="")
    assigned_by         = Column(String, default="")
    assigned_by_email   = Column(String, default="")
    status              = Column(String, default="pending_acceptance")
    return_reason       = Column(String, default="")   # '' | normal | dead | lost | reassign
    accept_photo_url    = Column(String, default="")
    accept_photo_name   = Column(String, default="")
    accept_note         = Column(String, default="")
    accepted_at         = Column(String, default="")
    return_photo_url    = Column(String, default="")
    return_photo_name   = Column(String, default="")
    return_note         = Column(String, default="")
    return_initiated_at = Column(String, default="")
    return_accepted_by  = Column(String, default="")
    return_accepted_at  = Column(String, default="")
    disposition         = Column(String, default="")   # stock | retired (set when return accepted)
    next_assignee_email = Column(String, default="")   # reassignment chain target
    next_assignee_name  = Column(String, default="")
    created_at          = Column(String, default="")


class NexusRole(Base):
    __tablename__ = "nexus_roles"
    email        = Column(String, primary_key=True)   # Azure AD UPN / email
    role         = Column(String, nullable=False, default="employee")
    display_name = Column(String, default="")         # captured from Microsoft Graph when assigned via Access Manager
    assigned_by  = Column(String, default="system")
    # A per-person tier override: set when an admin picks this person's tier
    # directly (Access Manager -> Roles), it PINS the tier so editing their job
    # role's seniority tier no longer re-stamps them. Lets two people in one job
    # role hold different tiers (e.g. one promoted to Global Admin). Cleared when
    # they are (re)assigned to a job role, which means "follow this role's tier".
    tier_pinned  = Column(Boolean, default=False)


class NexusGroup(Base):
    __tablename__ = "nexus_groups"
    id              = Column(String, primary_key=True)
    name            = Column(String, nullable=False)
    department      = Column(String, default="")
    allowed_modules = Column(String, default="")   # comma-separated "moduleId:level" pairs, e.g. "it:viewer,inventory:full" - level ∈ viewer/editor/full/owner (see auth.MODULE_LEVELS)
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    # Roles & Access redesign (Jul 2026): a "Job Role" is an Access Group flagged
    # is_job_role=1 that ALSO carries a seniority tier + plain-language description.
    # A person's primary job role is the single job-role group they belong to;
    # module access still flows through normal group membership (auth._module_level),
    # so resolution is unchanged. Plain groups (is_job_role=0) are the additive layer.
    is_job_role     = Column(Integer, default=0)
    tier            = Column(String, default="")   # employee/supervisor/manager/administrator/owner - job roles only
    description     = Column(String, default="")
    # Members of a group flagged monitoring_exempt=1 are excused from screen-share
    # monitoring: no capture is offered and clock-in is not gated on sharing a
    # screen (used for leadership). A person is exempt if ANY of their groups sets it.
    monitoring_exempt = Column(Integer, default=0)
    # Job roles only: the role's default manager/timesheet approver. Assigning the
    # role to someone with NO manager set copies this onto their People card -
    # per-person Manager stays the source of truth and can always be overridden.
    default_manager_email = Column(String, default="")


class NexusGroupMember(Base):
    __tablename__ = "nexus_group_members"
    group_id = Column(String, primary_key=True)
    email    = Column(String, primary_key=True)
    added_by = Column(String, default="")
    added_at = Column(String, default="")


class NexusAccessScope(Base):
    """Row-level access scope - narrows WHICH records a person can see within a
    module they already have (module:level) access to. Used mainly to sandbox
    external users: a client scoped to one property sees only that property.
    Semantics (see auth.scoped_ids): a person with ANY scope row for a module is
    restricted to those scope_ids; a person with none is unrestricted UNLESS they
    are identity_type='external', who then see nothing (fail-closed least
    privilege). New table - create_all builds it, no migration line needed."""
    __tablename__ = "nexus_access_scopes"
    id         = Column(String, primary_key=True)   # uuid
    email      = Column(String, nullable=False, index=True)   # the person the scope applies to
    module_id  = Column(String, nullable=False)     # e.g. 'property-asset'
    scope_type = Column(String, default="")         # 'property' | 'project' | 'entity'
    scope_id   = Column(String, nullable=False)     # id of the property/project/entity allowed
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class ExternalLoginCode(Base):
    """Single-use passwordless credentials for EXTERNAL users (Aug 18): the
    long invite-activation tokens AND the 6-digit codes, both HASHED at rest
    (never stored or logged in plaintext).

    purpose: 'invite' (activation link token, 7-day expiry, sha256 of the
    48-byte token - enough entropy that a salt adds nothing and a direct
    hash lookup works) | 'activate' | 'login' (6-digit codes, 10-min expiry,
    salted sha256 - low entropy, so the salt matters; looked up by email).
    channel: how the code went out ('sms' via sent.dm, 'email' via Graph) -
    verifying an sms-channel code is what stamps phone_verified_at.
    attempts: failed verifies; 5 kills the row and starts a 15-min lockout.
    consumed_at: set on success, on invalidation-by-newer-code, on lockout,
    and on deactivate/remove - a row with it set can never verify again.
    Rate limiting reads THIS table (counts per email/IP per hour), because
    in-memory counters don't cross gunicorn's worker processes.

    NEW TABLE: create_all builds it with RLS DISABLED - run
    ALTER TABLE external_login_codes ENABLE ROW LEVEL SECURITY;
    on BOTH dev and prod at release (see docs/External-Users-Rollout-Aug17.md)."""
    __tablename__ = "external_login_codes"
    id          = Column(String, primary_key=True)                 # uuid
    email       = Column(String, nullable=False, index=True)
    code_hash   = Column(String, nullable=False, index=True)
    purpose     = Column(String, default="login")                  # invite | activate | login
    channel     = Column(String, default="")                       # sms | email
    expires_at  = Column(String, default="")                       # ISO datetime UTC
    attempts    = Column(Integer, default=0)
    created_ip  = Column(String, default="", index=True)
    consumed_at = Column(String, default="")
    created_at  = Column(String, default="")


class ApprovalHistory(Base):
    __tablename__ = "approval_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    requisition_id = Column(String, nullable=False)
    action = Column(String, nullable=False)
    action_by = Column(String, nullable=False)
    action_role = Column(String, nullable=False)
    comment = Column(String, default="")
    created_at = Column(String, nullable=False)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id            = Column(Integer, primary_key=True, autoincrement=True)
    timestamp     = Column(String, nullable=False)
    user_email    = Column(String, nullable=False)
    user_role     = Column(String, default="")
    action        = Column(String, nullable=False)
    resource_type = Column(String, default="")
    resource_id   = Column(String, default="")
    details       = Column(String, default="")   # JSON string
    ip_address    = Column(String, default="")
    undone_at     = Column(String, default="")    # set when this change was reverted via the audit-log Undo
    undone_by     = Column(String, default="")    # email of whoever undid it


class NexusEmployee(Base):
    """HR employee master record (Phase 1 of the HR module). The single source
    of truth a person's working life hangs off - candidates, provisioning,
    leave and the org chart all reference this row in later phases."""
    __tablename__ = "nexus_employees"
    id              = Column(String, primary_key=True)         # uuid
    employee_code   = Column(String, default="")               # GG-001 style, auto-assigned
    first_name      = Column(String, nullable=False)
    last_name       = Column(String, default="")
    work_email      = Column(String, default="")               # empty until provisioned (Phase 4)
    personal_email  = Column(String, default="")
    phone           = Column(String, default="")
    job_title       = Column(String, default="")
    designation     = Column(String, default="")               # formal designation/rank, kept distinct from job_title (Charmi, Aug 4)
    department      = Column(String, default="")
    employment_type = Column(String, default="full_time")      # full_time | part_time | contractor | intern
    start_date      = Column(String, default="")               # ISO date
    manager_email   = Column(String, default="")               # reporting line -> org chart (Phase 5)
    photo_url       = Column(String, default="")
    status          = Column(String, default="active")         # onboarding | active | inactive | offboarded
    location        = Column(String, default="")
    company         = Column(String, default="")               # HrEntity.id - which legal entity employs this worker
    contractor      = Column(JSON, default=dict)               # contractor-only fields (scope/SOW/dates/rate/client) - HR Section A
    personal        = Column(JSON, default=dict)               # emergency contact, addresses, DOB, masked IDs - HR Section B
    compensation    = Column(JSON, default=dict)               # base/basis/frequency/currency + history - RESTRICTED (hr_comp grant)
    bank            = Column(JSON, default=list)               # list of bank accounts - RESTRICTED (hr_comp grant)
    compliance      = Column(JSON, default=dict)               # right-to-work / visa / verification - HR Section B
    status_log      = Column(JSON, default=list)               # [{from,to,reason,effectiveDate,by,at}] - HR Section B6
    notes           = Column(String, default="")
    m365_id         = Column(String, default="")               # account pointers for provisioning (Phase 4)
    asana_id        = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")
    division        = Column(String, default="")               # functional division head-tag; org chart inherits down the tree (Phase 5)
    identity_type   = Column(String, default="internal")        # internal (MS365 staff) | guest (Entra B2B partner) | external (non-MS365, HR-record only)
    display_name    = Column(String, default="")               # Entra/Teams displayName verbatim - first+last drops middle names ("Sagar Kumar Shoundik" -> "Sagar Shoundik"), so people read as a different person than Teams shows. Refreshed by sync-m365; falls back to first+last when empty.
    # Soft delete (Aug 11). "Remove from Nexus" used to DROP the row, taking pay,
    # compliance, personal details and the whole status history with it and
    # leaving nothing to restore. The row now stays and is hidden instead: empty
    # = live, an ISO timestamp = removed. Every query in the app excludes these
    # automatically (see the do_orm_execute hook in database.py) - do NOT rely on
    # each call site remembering to filter.
    deleted_at      = Column(String, default="")
    deleted_by      = Column(String, default="")
    # External users (Aug 17): metadata for the B2B-guest login allowlist. Only
    # meaningful on identity_type='guest'/'external' rows. external_company is
    # the partner org's display name (free text - NOT an HrEntity id, external
    # orgs are not legal entities of ours); invited_by is the admin who enrolled
    # them; expires_at (ISO date) optionally auto-expires their sign-in
    # (checked in auth.apply_external_policy).
    external_company = Column(String, default="")
    invited_by       = Column(String, default="")
    expires_at       = Column(String, default="")
    # Invitation delivery state for guest rows (Aug 18):
    # '' (never attempted) | 'sent' (invitation email went out) |
    # 'failed' (delivery failed - fix mail config or invite manually) |
    # 'manual' (invited outside Nexus - nothing to send).
    invite_status    = Column(String, default="")
    # Passwordless external login (Aug 18): when the guest verified a 6-digit
    # code delivered to `phone` (sent.dm SMS), this is stamped and future login
    # codes go to the phone first. Empty = phone unverified, codes go to email.
    phone_verified_at = Column(String, default="")


class HrRemovedIdentity(Base):
    """Tombstone for a person removed from Nexus (the Nexus-only delete). The M365
    sync checks this and SKIPS re-creating them from Entra, so a removed person
    stays removed even though their Microsoft account still exists. Removal takes
    no Graph action - the M365 account is left untouched. Keyed by work_email
    and/or m365_id; cleared if the same person is deliberately re-added."""
    __tablename__ = "hr_removed_identities"
    id          = Column(String, primary_key=True)
    work_email  = Column(String, default="", index=True)
    m365_id     = Column(String, default="", index=True)
    removed_by  = Column(String, default="")
    removed_at  = Column(String, default="")


class HrCandidate(Base):
    """Hiring pipeline (HR Phase 2). Stage moves are recorded in HrStageEvent;
    reaching `hired` auto-creates the NexusEmployee master record."""
    __tablename__ = "hr_candidates"
    id             = Column(String, primary_key=True)
    first_name     = Column(String, nullable=False)
    last_name      = Column(String, default="")
    email          = Column(String, default="")               # personal email
    phone          = Column(String, default="")
    role_title     = Column(String, default="")               # role they applied for
    department     = Column(String, default="")
    stage          = Column(String, default="applied")        # applied|screening|interview|offer|hired|rejected
    expected_start = Column(String, default="")               # ISO date
    interview_at   = Column(String, default="")               # ISO datetime of the next interview
    source         = Column(String, default="")               # referral, LinkedIn, ...
    resume_url     = Column(String, default="")               # hr-docs storage path (private; signed URL to view)
    notes          = Column(String, default="")
    employee_id    = Column(String, default="")               # set when hired
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    updated_at     = Column(String, default="")


class HrStageEvent(Base):
    __tablename__ = "hr_stage_events"
    id           = Column(String, primary_key=True)
    candidate_id = Column(String, nullable=False)
    from_stage   = Column(String, default="")
    to_stage     = Column(String, nullable=False)
    note         = Column(String, default="")
    by_email     = Column(String, default="")
    created_at   = Column(String, default="")


class HrLeaveRequest(Base):
    """Leave tracker (HR Phase 6). Days decrement the year balance on approval."""
    __tablename__ = "hr_leave_requests"
    id             = Column(String, primary_key=True)
    employee_id    = Column(String, nullable=False)
    leave_type     = Column(String, default="annual")         # annual|sick|unpaid
    start_date     = Column(String, default="")
    end_date       = Column(String, default="")
    days           = Column(Float, default=1)
    reason         = Column(String, default="")
    status         = Column(String, default="pending")        # pending|approved|rejected
    decided_by     = Column(String, default="")
    decided_at     = Column(String, default="")
    decision_note  = Column(String, default="")
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")


class HrLeaveBalance(Base):
    """Allocated days per employee/year/type; used days are computed from
    approved HrLeaveRequest rows so the numbers can never drift apart."""
    __tablename__ = "hr_leave_balances"
    id          = Column(String, primary_key=True)
    employee_id = Column(String, nullable=False)
    year        = Column(Integer, nullable=False)
    leave_type  = Column(String, nullable=False)
    allocated   = Column(Float, default=0)


class HrDocument(Base):
    """Per-employee documents (HR Phase 3) - stored in the PRIVATE hr-docs
    bucket; clients only ever see short-lived signed URLs minted server-side."""
    __tablename__ = "hr_documents"
    id           = Column(String, primary_key=True)
    employee_id  = Column(String, nullable=False)
    kind         = Column(String, default="other")            # resume|id|contract|certificate|other
    file_name    = Column(String, nullable=False)
    storage_path = Column(String, nullable=False)
    size_bytes   = Column(Integer, default=0)
    expires_on   = Column(String, default="")                 # visa/cert expiry reminders
    uploaded_by  = Column(String, default="")
    created_at   = Column(String, default="")


class HrProvisionRun(Base):
    """One click of the provisioning button (HR Phase 4)."""
    __tablename__ = "hr_provision_runs"
    id          = Column(String, primary_key=True)
    employee_id = Column(String, nullable=False)
    status      = Column(String, default="running")           # running|done|failed|partial
    started_by  = Column(String, default="")
    started_at  = Column(String, default="")
    finished_at = Column(String, default="")


class HrProvisionStep(Base):
    __tablename__ = "hr_provision_steps"
    id      = Column(String, primary_key=True)
    run_id  = Column(String, nullable=False)
    step    = Column(String, nullable=False)                  # m365_user|m365_license|m365_manager|asana|ignite|welcome_email
    status  = Column(String, default="pending")               # pending|ok|failed|skipped|manual
    detail  = Column(String, default="")
    ordinal = Column(Integer, default=0)


class ItemCustomField(Base):
    """Admin-defined custom field for items (Ankush's Details panel). The value
    for each item lives in Item.custom_fields keyed by `field_key`; this table is
    just the definition/schema so the Details panel stays flexible as fields are
    added. created via create_all on startup (new table, no migration needed)."""
    __tablename__ = "item_custom_fields"
    id              = Column(String, primary_key=True)         # uuid
    field_key       = Column(String, nullable=False)           # stable key in Item.custom_fields (e.g. "warranty_end")
    label           = Column(String, nullable=False)           # human label shown in the panel
    field_type      = Column(String, default="text")           # text|number|date|select|boolean|url
    options         = Column(JSON, default=list)               # choices for select fields
    applies_to_type = Column(String, default="")               # '' = all item types, else a specific item_type
    sort_order      = Column(Integer, default=0)
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")


class ItemType(Base):
    """Manager-curated list of item types (Neil: managers can extend the types, but
    a CSV import can't invent one). create_all builds the table; it's seeded from the
    legacy hardcoded list on first use. Deleting a type leaves existing items' type
    strings untouched - they just stop being pickable, like a removed custom field."""
    __tablename__ = "item_types"
    name       = Column(String, primary_key=True)   # the display value, e.g. "IP Camera"
    sort_order = Column(Integer, default=0)
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class KbDocument(Base):
    """Knowledge Base document (SOP / Manual / Guide). The rich, nested body
    (purpose, scope, procedure steps, etc.) is stored as a JSON string in `body`
    so the template can evolve without a migration per field. Lifecycle:
    draft -> in_review -> approved (or changes_requested back to the owner);
    approved docs can later be archived. New table - create_all builds it, no
    migration line needed."""
    __tablename__ = "kb_documents"
    id               = Column(String, primary_key=True)        # uuid
    doc_code         = Column(String, default="")              # e.g. OPS-014, auto-assigned per department
    title            = Column(String, nullable=False)
    doc_type         = Column(String, default="SOP")           # SOP | Manual | Guide
    departments      = Column(String, default="")              # comma-separated department names ("" = unassigned)
    service          = Column(String, default="")              # KbService.name within the department ("" = General/Uncategorized)
    status           = Column(String, default="draft")         # draft|in_review|changes_requested|approved|archived
    owner_email      = Column(String, default="")
    owner_name       = Column(String, default="")
    reviewer_email   = Column(String, default="")
    reviewer_name    = Column(String, default="")
    version          = Column(String, default="0.1")
    effective_date   = Column(String, default="")             # ISO date, set on approval
    body             = Column(String, default="{}")           # JSON: purpose, scopeText, materials, responsibilities, definitions, procedure, safety, references
    review_note      = Column(String, default="")             # latest reviewer note
    revision_history = Column(String, default="[]")           # JSON list of {version,date,author,notes}
    require_ack      = Column(Boolean, default=False)          # require e-signature sign-off once approved
    views            = Column(Integer, default=0)              # detail-view counter (usage analytics)
    review_every_months = Column(Integer, default=12)          # freshness cadence
    verified_at      = Column(String, default="")             # last verified (ISO date)
    verified_by      = Column(String, default="")
    stale_notified_at = Column(String, default="")            # last stale-reminder date (dedupes bell nudges per review cycle)
    retention_months = Column(Integer, default=84)            # records-retention window
    tags             = Column(String, default="")              # comma-separated, free-form taxonomy alongside departments
    related_ids      = Column(String, default="")              # comma-separated kb_documents.id - manual "See also" picks
    content_text     = Column(Text, default="")                # denormalized plaintext (guided body fields, or the linked
                                                                 # freeform document's text) so search covers both authoring
                                                                 # modes without re-parsing body/TipTap JSON on every query
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")
    original_title   = Column(String, default="")              # pre-cleanup title, set once by cleanup-titles so the
                                                                 # original is always recoverable/auditable
    original_content = Column(Text, default="")                # raw extracted source text as first imported, before
                                                                 # any AI formatting - set once, never overwritten, so a
                                                                 # bad AI import can always be diffed against the true source


class KbService(Base):
    """Manager-curated Service tier within a Department (e.g. IT -> "Microsoft 365").
    Mirrors ItemType: deactivating/deleting a service leaves existing KbDocument.service
    strings untouched - they just stop being pickable. New table - create_all builds it,
    no migration line needed."""
    __tablename__ = "kb_services"
    id         = Column(String, primary_key=True)   # uuid
    department = Column(String, nullable=False)      # one of the fixed department names
    name       = Column(String, nullable=False)
    active     = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class KbTag(Base):
    """Manager-curated tag vocabulary for KB documents. KbDocument.tags stays a
    comma-separated free-form string (no FK) - this table is the managed picklist
    the tag UI autocompletes against, mirroring ItemType. New table - create_all
    builds it, no migration line needed."""
    __tablename__ = "kb_tags"
    id         = Column(String, primary_key=True)   # uuid
    name       = Column(String, nullable=False, unique=True)
    active     = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class KbFeedback(Base):
    """One user's "was this helpful?" vote on a KB document. Unique per
    (doc_id, user_email) - like KbAcknowledgement, re-voting UPDATES the same
    row rather than piling up duplicates, so counts stay meaningful across
    edits/re-reads instead of just growing forever."""
    __tablename__ = "kb_feedback"
    id         = Column(String, primary_key=True)   # uuid
    doc_id     = Column(String, nullable=False)
    user_email = Column(String, nullable=False)
    helpful    = Column(Boolean, default=True)
    created_at = Column(String, default="")


class KbRun(Base):
    """One execution of an SOP's procedure as a live checklist ("run"). The
    steps are snapshotted by count only - steps_done holds the indices ticked
    off, so a doc edit mid-run degrades gracefully rather than corrupting the
    run. New table - create_all builds it."""
    __tablename__ = "kb_runs"
    id           = Column(String, primary_key=True)   # run_ + hex
    doc_id       = Column(String, nullable=False)
    doc_code     = Column(String, default="")
    doc_title    = Column(String, default="")
    version      = Column(String, default="")          # doc version when the run started
    user_email   = Column(String, nullable=False)
    user_name    = Column(String, default="")
    steps_done   = Column(String, default="[]")        # JSON list of completed step indices
    step_count   = Column(Integer, default=0)          # total steps at start
    status       = Column(String, default="open")      # open | completed | abandoned
    started_at   = Column(String, default="")
    completed_at = Column(String, default="")


class KbAcknowledgement(Base):
    """One e-signature: a user acknowledged a specific version of a KB document.
    The current-version signers are those whose `version` matches the doc's."""
    __tablename__ = "kb_acknowledgements"
    id         = Column(String, primary_key=True)   # uuid
    doc_id     = Column(String, nullable=False)
    version    = Column(String, default="")          # doc version acknowledged
    user_email = Column(String, nullable=False)
    user_name  = Column(String, default="")
    signed_at  = Column(String, default="")


class KbComment(Base):
    """A discussion comment on a KB document."""
    __tablename__ = "kb_comments"
    id           = Column(String, primary_key=True)   # uuid
    doc_id       = Column(String, nullable=False)
    author_email = Column(String, default="")
    author_name  = Column(String, default="")
    text         = Column(String, nullable=False)
    created_at   = Column(String, default="")


class KbSnapshot(Base):
    """A point-in-time copy of a KB document's content, captured on create /
    edit / approve so versions can be compared. Body fields stored as JSON."""
    __tablename__ = "kb_snapshots"
    id          = Column(String, primary_key=True)   # uuid
    doc_id      = Column(String, nullable=False)
    version     = Column(String, default="")
    date        = Column(String, default="")
    author      = Column(String, default="")
    title       = Column(String, default="")
    departments = Column(String, default="")
    body        = Column(String, default="{}")


class KbCourse(Base):
    """A Learn (LMS) course: ordered lessons (reading or linked SOP) + optional
    quiz. lessons/quiz stored as JSON. Quiz answers are stripped before sending
    to learners (only managers/authors receive them)."""
    __tablename__ = "kb_courses"
    id          = Column(String, primary_key=True)   # uuid
    course_code = Column(String, default="")          # LRN-001 …
    title       = Column(String, nullable=False)
    description = Column(String, default="")
    overview    = Column(String, default="")           # "what you'll learn" - JSON list of objective strings
    recert_months = Column(Integer, default=0)         # 0 = no recertification; else retake every N months
    departments = Column(String, default="")
    status      = Column(String, default="draft")     # draft | published
    owner_email = Column(String, default="")
    owner_name  = Column(String, default="")
    est_minutes = Column(Integer, default=15)
    lessons     = Column(String, default="[]")         # JSON [{_id,type,title,body,docId}]
    quiz        = Column(String, default="{}")          # JSON {passPct,questions:[{_id,q,options,answer}]}
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class KbCourseProgress(Base):
    """One learner's progress in one course."""
    __tablename__ = "kb_course_progress"
    id           = Column(String, primary_key=True)   # uuid
    course_id    = Column(String, nullable=False)
    user_email   = Column(String, nullable=False)
    lessons_done = Column(String, default="[]")        # JSON list of lesson ids
    quiz_score   = Column(Integer, default=None)        # 0-100, null until taken
    passed       = Column(Boolean, default=False)
    started_at   = Column(String, default="")
    completed_at = Column(String, default="")


class KbPin(Base):
    """One user's pinned/favourited KB document, for quick access."""
    __tablename__ = "kb_pins"
    id         = Column(String, primary_key=True)   # uuid
    user_email = Column(String, nullable=False)
    doc_id     = Column(String, nullable=False)
    created_at = Column(String, default="")


class KbCourseAssignment(Base):
    """A course assigned to a specific person, optionally with a due date -
    the basis for "required training" and completion tracking."""
    __tablename__ = "kb_course_assignments"
    id          = Column(String, primary_key=True)   # uuid
    course_id   = Column(String, nullable=False)
    user_email  = Column(String, nullable=False)
    user_name   = Column(String, default="")
    due_date    = Column(String, default="")          # YYYY-MM-DD ("" = no due date)
    assigned_by = Column(String, default="")
    created_at  = Column(String, default="")


class KbQuizAttempt(Base):
    """A learner's quiz attempt on a course - the back-end record of how they
    did and which questions they missed (for manager reports + remediation)."""
    __tablename__ = "kb_quiz_attempts"
    id          = Column(String, primary_key=True)   # uuid
    course_id   = Column(String, nullable=False)
    course_code = Column(String, default="")
    course_title = Column(String, default="")
    user_email  = Column(String, nullable=False)
    user_name   = Column(String, default="")
    score       = Column(Integer, default=0)          # 0-100
    passed      = Column(Boolean, default=False)
    missed      = Column(String, default="[]")         # JSON: [{q, your, correct, explanation}]
    created_at  = Column(String, default="")


class PageHelp(Base):
    """AI-generated "how to use this page" article, one row per page key
    (view, or view:subview). Generated by Claude on first view and cached;
    regenerated on demand. Neil: every page gets a help icon, AI keeps it current,
    no human authoring."""
    __tablename__ = "page_help"
    page_key   = Column(String, primary_key=True)       # e.g. "inventory:manage", "sop"
    label      = Column(String, default="")             # human page name
    title      = Column(String, default="")             # AI article heading
    content    = Column(String, default="")             # markdown body
    source     = Column(String, default="ai")           # ai | fallback | manual
    updated_at = Column(String, default="")
    updated_by = Column(String, default="")


# ---------------------------------------------------------------------------
# Asset Management (property portfolio) - Ankush's module.
# The UI data is semi-structured: each property has a wide set of header fields
# PLUS free-form snapshot / timeline / permit "sheets", and a handful of flat
# child collections (warranties, inspections, documents, utilities, AHJ,
# vendors) keyed by property. Rather than 50+ columns and 6 near-identical
# tables, the full objects live in JSON `payload` columns with a few fields
# promoted for listing/queries. The module loads/saves the whole workspace as
# one blob - see routers/property_assets.py. create_all builds these on startup.
# ---------------------------------------------------------------------------
class PropertyAsset(Base):
    """One real-estate property / parcel in the Asset Management portfolio."""
    __tablename__ = "property_assets"
    id         = Column(String, primary_key=True)   # slug, e.g. "greens-georgetown"
    name       = Column(String, default="")
    manager    = Column(String, default="")          # PM / Asset Manager (name)
    asset_type = Column(String, default="")
    parent_id  = Column(String, default="")          # primary asset id when this is a secondary
    payload    = Column(JSON, default=dict)          # the entire property object
    updated_at = Column(String, default="")
    updated_by = Column(String, default="")


class PropertyRecord(Base):
    """A child row under a property - generic across the flat collections so the
    {collection: rows[]} workspace round-trips losslessly. `collection` is one of
    warranties | inspections | documents | utilities | ahj | vendors."""
    __tablename__ = "property_records"
    id          = Column(String, primary_key=True)   # uuid (unique across collections)
    property_id = Column(String, default="")
    collection  = Column(String, nullable=False)
    payload     = Column(JSON, default=dict)
    updated_at  = Column(String, default="")


class PropertyActivityLog(Base):
    """Asset Management activity-log entry (who changed what) for the global Log
    and field-level undo. Persisted as the module emits them."""
    __tablename__ = "property_activity_logs"
    id          = Column(String, primary_key=True)   # uuid
    property_id = Column(String, default="")
    payload     = Column(JSON, default=dict)
    created_at  = Column(String, default="")


class HrEntity(Base):
    """A legal entity/company that employs workers (HR Section A). Every worker's
    `company` points at one of these. E.g. Greens, Greens India, MCD, Oversite."""
    __tablename__ = "hr_entities"
    id                 = Column(String, primary_key=True)   # uuid
    name               = Column(String, nullable=False)     # short display name (e.g. "Greens India")
    legal_name         = Column(String, default="")         # full registered legal name
    country            = Column(String, default="")         # US | IN | ...
    tax_id             = Column(String, default="")         # EIN (US) / GSTIN (IN)
    registered_address = Column(String, default="")
    signatory          = Column(String, default="")         # authorized signatory name/title
    logo_url           = Column(String, default="")
    notes              = Column(String, default="")
    created_by         = Column(String, default="")
    created_at         = Column(String, default="")
    updated_at         = Column(String, default="")
    # Email domains owned by this company (comma-separated, no @) - the M365 sync
    # imports accounts on these domains and auto-tags them to this company.
    domains            = Column(String, default="")
    # Who runs this company operationally (a Nexus person's work email) - the
    # escalation target when a worker has no reports-to. Distinct from signatory.
    manager_email      = Column(String, default="")


class NexusSetting(Base):
    """Tiny app-wide key-value store. First use: the HR group manager (the person
    overseeing ALL companies - escalation above each company's manager). New
    table - create_all builds it, no migration line needed."""
    __tablename__ = "nexus_settings"
    key        = Column(String, primary_key=True)
    value      = Column(String, default="")
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")


class HrDepartment(Base):
    """A department, scoped to one company (HrEntity). Departments are NOT a
    Nexus-wide hardcoded list - each company owns its own editable set (an IT-dev
    company has QA, a construction company has Estimating). Greens Global is seeded
    from the legacy hardcoded list on first read; every other company starts empty.
    Employees pick a department from their company's list. Deleting one leaves
    existing employees' department strings untouched (like a removed item type).
    `parent_id` is unused today but present so departments can become a hierarchy
    later without a migration - the enterprise norm. New table - create_all builds
    it, no migration line needed."""
    __tablename__ = "hr_departments"
    id         = Column(String, primary_key=True)   # uuid
    company_id = Column(String, nullable=False)     # HrEntity.id this department belongs to
    name       = Column(String, nullable=False)     # display value, e.g. "Estimating"
    parent_id  = Column(String, default="")         # reserved: HrDepartment.id of the parent (hierarchy)
    sort_order = Column(Integer, default=0)
    # Ticket triage: a ticket raised against this department is left unassigned and
    # the lead is notified to assign it to an employee. backup_email is notified
    # alongside the lead so leave/departures don't strand a department's intake.
    lead_email   = Column(String, default="")
    backup_email = Column(String, default="")
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class HrWorkSite(Base):
    """A physical work site (HR Section A) - used later for geofenced time-clock
    validation. lat/long + radius define the geofence."""
    __tablename__ = "hr_work_sites"
    id            = Column(String, primary_key=True)   # uuid
    name          = Column(String, nullable=False)
    address       = Column(String, default="")
    latitude      = Column(String, default="")
    longitude     = Column(String, default="")
    radius_m      = Column(Integer, default=150)       # geofence radius in metres
    company       = Column(String, default="")         # HrEntity.id this site belongs to (optional)
    notes         = Column(String, default="")
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")


class HrMailboxExport(Base):
    __tablename__ = "hr_mailbox_exports"
    id            = Column(String, primary_key=True)
    employee_id   = Column(String, nullable=False)
    requested_by  = Column(String, default="")
    status        = Column(String, default="pending")   # pending|running|done|error
    message       = Column(String, default="")
    storage_path  = Column(String, default="")          # hr-docs bucket path to the zip
    count         = Column(Integer, default=0)           # messages processed so far
    total         = Column(Integer, default=0)           # messages in the mailbox (0 = unknown)
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")


# ── E-Sign (HR Section C) - native signatures with legal-grade audit trail ────
# Templates are authored with {{merge}} tokens and [[fieldtype:role]] slots;
# requests freeze a resolved snapshot at send time so later profile edits never
# change what someone signed. Final PDFs live in the private hr-docs bucket with
# a SHA-256 stored for tamper evidence. Tables created via create_all on startup.

class HrSignTemplate(Base):
    __tablename__ = "hr_sign_templates"
    id          = Column(String, primary_key=True)   # uuid
    name        = Column(String, nullable=False)
    kind        = Column(String, default="custom")   # offer|nda|direct_deposit|handbook_ack|w9|contractor_agreement|sow|custom
    entity_id   = Column(String, default="")         # HrEntity.id ('' = any company)
    body        = Column(JSON, default=list)         # list of paragraph strings with {{merge}} + [[sign:role]] tokens
    roles       = Column(JSON, default=list)         # [{key,label,order}] - signing order
    attachments = Column(JSON, default=list)         # [{name, path, pages, fields:[{id,role,type,page,x,y,w,h}]}] - PDFs signed as one packet
    status      = Column(String, default="active")   # active|archived
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")
    egnyte_folder = Column(String, default="")       # Egnyte path for a copy of the sealed PDF ('' = don't copy)


class HrSignRequest(Base):
    """An envelope: one document sent to N ordered parties for signature."""
    __tablename__ = "hr_sign_requests"
    id               = Column(String, primary_key=True)   # uuid
    title            = Column(String, nullable=False)
    source           = Column(String, default="template") # template|pdf
    template_id      = Column(String, default="")
    employee_id      = Column(String, default="")         # subject person (optional)
    candidate_id     = Column(String, default="")
    entity_id        = Column(String, default="")
    body_snapshot    = Column(JSON, default=list)         # resolved template body, frozen at send
    pdf_storage_path = Column(String, default="")         # hr-docs path of uploaded source PDF
    fields           = Column(JSON, default=list)         # pdf source: [{id,role,type,page,x,y,w,h,required}] normalized coords
    documents        = Column(JSON, default=list)         # extra PDFs in the packet: [{name, path, fields:[...]}] (from template attachments)
    status           = Column(String, default="pending")  # pending|completed|declined|voided|expired
    current_order    = Column(Integer, default=1)         # whose turn (matches HrSignParty.order)
    message          = Column(String, default="")
    expires_on       = Column(String, default="")         # ISO date ('' = never)
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    completed_at     = Column(String, default="")
    final_pdf_path   = Column(String, default="")         # hr-docs path of sealed final PDF
    final_sha256     = Column(String, default="")         # tamper-evidence hash of final bytes
    routing          = Column(String, default="sequential")  # sequential (ordered) | parallel (everyone at once)
    egnyte_folder    = Column(String, default="")         # frozen from the template at send; sealed PDF is copied here
    verify_token     = Column(String, default="")         # public, unauthenticated /verify/{token} credential - set at completion


class HrSignParty(Base):
    __tablename__ = "hr_sign_parties"
    id                   = Column(String, primary_key=True)   # uuid
    request_id           = Column(String, nullable=False)
    role_key             = Column(String, default="")
    name                 = Column(String, default="")
    email                = Column(String, default="")
    kind                 = Column(String, default="internal") # internal|external
    ordinal              = Column(Integer, default=1)         # signing order (matches request.current_order)
    status               = Column(String, default="waiting")  # waiting|notified|viewed|signed|declined
    token                = Column(String, default="")         # secrets.token_urlsafe(32) - the public-link credential
    token_expires_at     = Column(String, default="")
    signature_kind       = Column(String, default="")         # drawn|typed
    signature_data       = Column(String, default="")         # PNG data-URL (drawn) or the typed name
    consent_at           = Column(String, default="")         # ESIGN/UETA e-business consent timestamp
    consent_text_version = Column(String, default="")
    ip                   = Column(String, default="")
    user_agent           = Column(String, default="")
    viewed_at            = Column(String, default="")
    signed_at            = Column(String, default="")
    decline_reason       = Column(String, default="")
    field_values         = Column(JSON, default=dict)         # filled text/check/date/initials values
    party_role           = Column(String, default="signer")   # signer | cc (receives the sealed copy, never signs)
    access_code          = Column(String, default="")         # optional code an external signer must enter to open the link


class HrSignEvent(Base):
    """Immutable audit trail - one row per action on an envelope."""
    __tablename__ = "hr_sign_events"
    id          = Column(String, primary_key=True)   # uuid
    request_id  = Column(String, nullable=False)
    party_id    = Column(String, default="")
    type        = Column(String, default="")         # created|sent|viewed|consented|signed|declined|reminded|voided|completed|downloaded
    detail      = Column(String, default="")
    ip          = Column(String, default="")
    user_agent  = Column(String, default="")
    at          = Column(String, default="")
    seq         = Column(Integer, default=0)          # tamper-evident hash chain (added later): 1,2,3... per request_id
    event_hash  = Column(String, default="")          # sha256(prev_hash|request_id|type|detail|ip|user_agent|at|seq) - 0/'' on pre-upgrade rows


# ── Documents (DMS) - Phase 1 ──────────────────────────────────────────────────
# Sits next to (not inside) the e-sign envelope tables above: a Document only
# becomes an HrSignRequest at the moment the user sends it for signature (export
# to PDF, hand to the existing esign.py PDF-send path). New tables - create_all
# builds them, no migration line needed. New tables - create_all builds them.
class DocFolder(Base):
    __tablename__ = "doc_folders"
    id          = Column(String, primary_key=True)   # uuid
    name        = Column(String, nullable=False)
    key         = Column(String, default="")         # hr|finance|legal|sales|operations|personal|archived|'' (custom)
    is_system   = Column(Boolean, default=False)      # seeded folder - not user-deletable
    owner_email = Column(String, default="")         # set for the per-user Personal folder
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")


class DocLetterhead(Base):
    __tablename__ = "doc_letterheads"
    id          = Column(String, primary_key=True)   # uuid
    name        = Column(String, nullable=False)
    logo_path   = Column(String, default="")         # storage path in the private docs bucket
    header_json = Column(JSON, default=dict)
    footer_json = Column(JSON, default=dict)
    address     = Column(String, default="")
    is_default  = Column(Boolean, default=False)
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")


class DocTemplate(Base):
    __tablename__ = "doc_templates"
    id                  = Column(String, primary_key=True)   # uuid
    name                = Column(String, nullable=False)
    category            = Column(String, default="general")  # letterhead|hr|legal|finance|operations|sales|engineering|general
    tags                = Column(JSON, default=list)
    content             = Column(JSON, default=dict)          # rich-doc content (Document Builder, Phase 2+)
    requires_letterhead = Column(Boolean, default=False)
    letterhead_id       = Column(String, default="")
    merge_overrides     = Column(JSON, default=dict)          # default {{token}} values + custom variables (Phase 12) - seeded onto any Document created from this template
    # Template Builder (Phase 13): list[FieldDef] - the single source of truth
    # for a merge field's type/required/default/validation, keyed by `token`
    # (which matches the mergeField TipTap node's own `token` attr). The node
    # itself never carries type/validation - that would mean rewriting every
    # chip instance in the doc body whenever a field's type changes.
    # FieldDef shape: {token, label, type, required, default, options,
    # validation: {maxLength, regex, min, max, minDate, maxDate}}.
    field_defs          = Column(JSON, default=list)
    status              = Column(String, default="active")    # active|archived
    version             = Column(Integer, default=1)
    created_by          = Column(String, default="")
    created_at          = Column(String, default="")
    updated_by          = Column(String, default="")
    updated_at          = Column(String, default="")


class Document(Base):
    __tablename__ = "documents"
    id               = Column(String, primary_key=True)   # uuid
    title            = Column(String, nullable=False)
    folder_id        = Column(String, default="")
    template_id      = Column(String, default="")
    content          = Column(JSON, default=dict)          # rich-doc content (Document Builder, Phase 2+)
    letterhead_id    = Column(String, default="")
    status           = Column(String, default="draft")     # draft|final|archived
    employee_id      = Column(String, default="")          # merge-field subject (Phase 4), NexusEmployee.id
    entity_id        = Column(String, default="")          # merge-field company (Phase 4), HrEntity.id
    merge_overrides  = Column(JSON, default=dict)           # manual {{token}} values + custom variables (Phase 11) - wins over employee/entity resolution
    owner_email      = Column(String, default="")
    tags             = Column(JSON, default=list)
    current_version  = Column(Integer, default=1)
    sign_request_id  = Column(String, default="")          # set once sent for signature (HrSignRequest.id)
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")
    archived_at      = Column(String, default="")


class DocumentVersion(Base):
    """One row per saved edit - recorded from Phase 1 on so version history is
    real data before the browsing UI (later phase) exists."""
    __tablename__ = "doc_versions"
    id          = Column(String, primary_key=True)   # uuid
    document_id = Column(String, nullable=False)
    version_no  = Column(Integer, default=1)
    content     = Column(JSON, default=dict)
    edited_by   = Column(String, default="")
    edited_at   = Column(String, default="")
    note        = Column(String, default="")


class DocTemplateVersion(Base):
    """Same shape as DocumentVersion (Phase 7 gap closure) - templates only got
    a bare version counter in Phase 3; this gives them real browsable history."""
    __tablename__ = "doc_template_versions"
    id          = Column(String, primary_key=True)   # uuid
    template_id = Column(String, nullable=False)
    version_no  = Column(Integer, default=1)
    content     = Column(JSON, default=dict)
    edited_by   = Column(String, default="")
    edited_at   = Column(String, default="")
    note        = Column(String, default="")


# ── Time tracking (SwipeClock replacement) ────────────────────────────────────
# Punch-event model: every clock action is one immutable row; shifts/totals are
# derived. Geofencing is a SOFT gate (research-verified SwipeClock behavior):
# out-of-fence punches are recorded and flagged, never blocked. Corrections
# never overwrite silently - original_at freezes the first value, voided rows
# stay in the table (wage-and-hour record retention).

class TimePunch(Base):
    __tablename__ = "time_punches"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    kind           = Column(String, nullable=False)     # in|out|break_start|break_end
    at             = Column(String, nullable=False)     # UTC ISO - effective time (adjustments edit this)
    original_at    = Column(String, default="")         # frozen first value once adjusted
    local_date     = Column(String, default="")         # YYYY-MM-DD in the puncher's timezone (grouping key)
    tz_offset_min  = Column(Integer, default=0)         # JS getTimezoneOffset() at punch
    lat            = Column(String, default="")
    lng            = Column(String, default="")
    accuracy_m     = Column(Integer, default=0)         # reported GPS accuracy radius (metres)
    geo_status     = Column(String, default="no_location")  # in_fence|out_of_fence|no_location
    work_site_id   = Column(String, default="")         # nearest HrWorkSite with a geofence
    work_site_name = Column(String, default="")         # frozen at punch time
    distance_m     = Column(Integer, default=0)         # raw distance to that site
    source         = Column(String, default="web")      # web|self_manual (missed-punch fix)|manual (manager)
    note           = Column(String, default="")
    ip             = Column(String, default="")
    user_agent     = Column(String, default="")
    adjusted_by    = Column(String, default="")
    adjusted_at    = Column(String, default="")
    adjust_note    = Column(String, default="")
    voided         = Column(Integer, default=0)         # 1 = excluded from totals, kept for audit
    category       = Column(String, default="")         # job-costing / cost-code tag on the in-punch (SwipeClock "Category")
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    # Employee self-edit of a punch time, pending approver review. Shows on the
    # timesheet immediately (transparency) but has NO effect on pay: worked-minutes
    # and payroll keep using `at` until approved. On approve, `at` becomes
    # pending_at; on reject, pending_at is discarded. Distinct from the manager
    # `adjusted_*` fields, which apply immediately and are final.
    pending_at       = Column(String, default="")   # proposed new time (UTC ISO), '' when none
    edit_reason      = Column(String, default="")   # optional employee justification
    edited_by        = Column(String, default="")   # employee who requested the edit
    edited_at        = Column(String, default="")
    edit_status      = Column(String, default="")   # '' | pending | approved | rejected
    edit_reviewed_by = Column(String, default="")   # approver email
    edit_reviewed_at = Column(String, default="")


class TimeScreenshot(Base):
    """Work-session screen captures (consent-based getDisplayMedia - the browser
    shows a persistent sharing indicator the whole time; nothing is covert).
    One row per captured frame, image in the private hr-docs bucket."""
    __tablename__ = "time_screenshots"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    at             = Column(String, nullable=False)     # UTC ISO
    local_date     = Column(String, default="")
    storage_path   = Column(String, default="")         # object key within `bucket`
    # Which storage bucket the object lives in. '' = legacy hr-docs (pre-split);
    # new frames land in the dedicated private 'time-monitoring' bucket. Reads
    # sign per-row against this so a migration in flight still resolves both.
    bucket         = Column(String, default="")
    session_id     = Column(String, default="")         # clock session (in-punch id) at capture
    idle_sec       = Column(Integer, default=0)         # seconds since last input at capture
    active_view    = Column(String, default="")         # Nexus view/path when captured
    created_at     = Column(String, default="")


class TimeApproval(Base):
    """Approve-then-export: a manager's sign-off on one employee's timecard for
    an exact period. Revocations keep the row (audit) and clear the status."""
    __tablename__ = "time_approvals"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    period_start   = Column(String, default="")         # YYYY-MM-DD
    period_end     = Column(String, default="")
    worked_min     = Column(Integer, default=0)         # snapshot at approval
    approved_by    = Column(String, default="")
    approved_at    = Column(String, default="")
    note           = Column(String, default="")
    revoked        = Column(Integer, default=0)
    revoked_by     = Column(String, default="")
    # Two-step sign-off (SwipeClock parity): 'manager' = the direct manager's
    # approval; 'final' = HR's payroll finalization, which LOCKS the period's
    # punches against edits until revoked (unlock).
    kind           = Column(String, default="manager")


class TimeBod(Base):
    """Beginning/End-of-day message: on the first punch-in (bod) or a punch-out
    (eod) the employee posts to a Teams chat. The row doubles as the DELIVERY
    QUEUE: the backend posts AS THE USER via a delegated Graph token minted from
    their server-side BFF session (teams_post.py), retrying until it lands - the
    browser only composes. (Pre-Aug-5 clients posted client-side and reported
    sent/send_error themselves; those fields are honored unchanged.)"""
    __tablename__ = "time_bod"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    kind           = Column(String, default="bod")      # bod | eod | break | break_end
    local_date     = Column(String, default="")
    message        = Column(String, default="")
    tasks          = Column(String, default="")
    team_id        = Column(String, default="")
    team_name      = Column(String, default="")
    channel_id     = Column(String, default="")
    channel_name   = Column(String, default="")
    sent           = Column(Integer, default=0)         # 1 = landed in Teams
    send_error     = Column(String, default="")
    created_at     = Column(String, default="")
    # Server-side delivery queue fields (Aug 5): html = the composed Teams
    # message; attempts/last_try_at drive the retry loop; '' html = legacy row.
    html           = Column(String, default="")
    attempts       = Column(Integer, default=0)
    last_try_at    = Column(String, default="")


class AgentDevice(Base):
    """A desktop-agent enrollment. Silent (no-login) model: an admin mints a
    token tied to an employee, the install command drops it on the machine, and
    the agent authenticates with it (X-Agent-Token) - no Microsoft sign-in. Each
    row is one enrolled computer, self-describing on first check-in."""
    __tablename__ = "agent_devices"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    token_hash     = Column(String, index=True, default="")   # sha256 of the secret
    label          = Column(String, default="")         # optional admin note
    device_name    = Column(String, default="")         # hostname
    device_user    = Column(String, default="")         # OS username
    mac            = Column(String, default="")
    platform       = Column(String, default="")
    revoked        = Column(Integer, default=0)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    last_seen_at   = Column(String, default="")
    agent_version  = Column(String, default="")         # agent build reported on checkin (auto-update)
    # Shared-PC support: the device is a permanent PC identity; the CURRENT
    # employee is whoever clocked in via the website (bound at clock-in, cleared at
    # clock-out). Screenshots + heartbeat attribute to `active_email`, NOT the
    # enroll-time `employee_email`, so two people can share one enrolled machine.
    active_email      = Column(String, default="")   # employee clocked in on this PC now
    active_session_id = Column(String, default="")   # their in-punch id = the clock session


class AgentRelease(Base):
    """A published desktop-agent build. This is the source of truth the auto-update
    manifest reads - moving it OUT of Azure env vars means a release is just a row
    here (written by the CI publish step), with no Azure change and no API restart.
    The current release is the one row with is_current=1; older rows are kept so a
    rollback is just flipping the flag back to a prior version."""
    __tablename__ = "agent_releases"
    id           = Column(String, primary_key=True)     # uuid
    version      = Column(String, nullable=False, index=True)   # "0.8.7"
    bundle_url   = Column(String, default="")
    sha256       = Column(String, default="")
    min_version  = Column(String, default="")           # force-update floor (reserved)
    notes        = Column(String, default="")
    is_current   = Column(Integer, default=0)           # exactly one row is the live target
    published_by = Column(String, default="")           # "ci" or an admin email
    published_at = Column(String, default="")


class AgentPairing(Base):
    """Short-lived nonce binding a browser clock-in to the physical device. The
    website mints it for the logged-in employee; the LOCAL AGENT claims it by
    authenticating with its own device token - so the device_id is proven by the
    agent, never trusted from the browser. Consumed once, at clock-in."""
    __tablename__ = "agent_pairings"
    nonce          = Column(String, primary_key=True)   # random, unguessable
    employee_email = Column(String, nullable=False, index=True)
    device_id      = Column(String, default="")         # set when the agent claims it
    created_at     = Column(String, default="")
    used           = Column(Integer, default=0)


class LiveSession(Base):
    """One on-demand live-screen-share session (Discord-style). An admin viewer
    requests to watch a clocked-in employee; the desktop agent on that PC answers
    with a WebRTC screen stream. This row is BOTH the signaling mailbox (offer/
    answer SDP passed through it, since the browser can't reach the agent over
    localhost) AND the audit record of who watched whom, when. Media itself flows
    peer-to-peer over WebRTC (relayed by Cloudflare TURN) - never through here.
    States: requested -> offering -> connected -> ended (or 'error')."""
    __tablename__ = "live_view_sessions"
    id             = Column(String, primary_key=True)   # uuid
    device_id      = Column(String, index=True, default="")
    employee_email = Column(String, index=True, nullable=False)   # who is watched
    viewer_email   = Column(String, index=True, nullable=False)   # the admin watching
    state          = Column(String, default="requested")
    offer_sdp      = Column(Text, default="")   # agent -> viewer (WebRTC offer)
    answer_sdp     = Column(Text, default="")   # viewer -> agent (WebRTC answer)
    fps            = Column(Integer, default=60)   # 1080p60 default; 30 is the only lower step
    created_at     = Column(String, default="")
    updated_at     = Column(String, default="")   # last change to state/sdp
    # Each side stamps its own poll so a one-sided disconnect (viewer closes the
    # tab, or the agent dies) is detected: alive only while BOTH are fresh.
    viewer_seen    = Column(String, default="")
    agent_seen     = Column(String, default="")
    ended_at       = Column(String, default="")
    ended_reason   = Column(String, default="")
    # Attended remote control (IT support), layered on the same session. The
    # employee must explicitly accept a prompt on their PC before any input is
    # injected, sees a persistent banner while control is active, and can end it
    # instantly; these fields are the consent + audit record of all of that.
    # control_state: '' | requested | active | declined | ended
    control_state          = Column(String, default="")
    control_requester_name = Column(String, default="")   # shown in the consent prompt
    control_requested_at   = Column(String, default="")
    control_responded_at   = Column(String, default="")   # accept/decline moment
    control_ended_at       = Column(String, default="")
    control_ended_reason   = Column(String, default="")   # employee_ended | viewer_ended | declined | request_expired | session_ended


class Shift(Base):
    """A reusable shift preset: a short code (e.g. GSV), start/end time, colour
    and grace window. Placed onto an employee+date in the schedule grid, or
    bulk-applied to a group's default weekdays."""
    __tablename__ = "shifts"
    id         = Column(String, primary_key=True)   # uuid
    name       = Column(String, default="")
    code       = Column(String, default="")         # short label shown in the grid
    start_hhmm = Column(String, default="09:00")
    end_hhmm   = Column(String, default="17:00")
    days       = Column(String, default="1,2,3,4,5")  # ISO weekday nums (Mon=1)
    grace_min  = Column(Integer, default=10)
    color      = Column(String, default="#2563eb")
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class ScheduledShift(Base):
    """One shift placed on a specific employee for a specific calendar date -
    the cells of the weekly schedule grid. Links a preset for code/colour but
    keeps its own times/label so a placement can be tweaked without editing the
    preset."""
    __tablename__ = "scheduled_shifts"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, index=True, nullable=False)
    work_date      = Column(String, index=True, nullable=False)  # YYYY-MM-DD
    shift_id       = Column(String, default="")          # preset ref (optional)
    start_hhmm     = Column(String, default="09:00")
    end_hhmm       = Column(String, default="17:00")
    label          = Column(String, default="")          # e.g. "All Properties"
    note           = Column(String, default="")
    published      = Column(Integer, default=1)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")


class ShiftGroup(Base):
    """A reusable set of employees - used to bulk-assign shifts AND to bind the
    Teams group chat that this group's BOD/EOD/Break messages route to."""
    __tablename__ = "shift_groups"
    id              = Column(String, primary_key=True)   # uuid
    name            = Column(String, default="")
    teams_chat_id   = Column(String, default="")         # bound Teams group chat
    teams_chat_name = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")


class ShiftGroupMember(Base):
    __tablename__ = "shift_group_members"
    id             = Column(String, primary_key=True)   # uuid
    group_id       = Column(String, index=True, nullable=False)
    employee_email = Column(String, index=True, nullable=False)


class ShiftAssignment(Base):
    """The shift an employee is currently on (one active shift per person)."""
    __tablename__ = "shift_assignments"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, index=True, nullable=False)
    shift_id       = Column(String, default="")
    assigned_by    = Column(String, default="")
    assigned_at    = Column(String, default="")


class PayrollRate(Base):
    """Manager-set hourly pay rate used by the payroll timecard. One current rate
    per employee (history is not kept here - corrections just overwrite)."""
    __tablename__ = "payroll_rates"
    employee_email = Column(String, primary_key=True)
    hourly_rate    = Column(Float, default=0)
    # Which overtime law applies to THIS employee. 'ca' = California daily
    # (>8h→1.5×, >12h→2×) + 7th-consecutive-day + weekly >40h; 'federal' = FLSA
    # weekly >40h only (out-of-state US); 'none' = no US overtime premium
    # (non-US - their local law is handled outside Nexus). Defaults to 'ca' since
    # the workforce is California; set explicitly for out-of-state / overseas.
    overtime_rule  = Column(String, default="ca")
    # Pay model. 'hourly' = the SwipeClock hourly + OT engine above (default, keeps
    # every existing employee unchanged). 'fixed' = monthly salary: the month is the
    # period (no work-week), pay = salary - (missed weekday-days x salary/days-in-month,
    # half for a half day) + (weekend days worked x weekend_ot_amount). See _fixed_card.
    pay_type          = Column(String, default="hourly")   # hourly | fixed
    currency          = Column(String, default="USD")      # USD | INR
    monthly_salary    = Column(Float,  default=0)          # fixed pay: gross per month
    weekend_ot_amount = Column(Float,  default=0)          # fixed pay: flat per weekend day worked
    full_day_hours    = Column(Float,  default=8)          # fixed pay: half-day threshold = this / 2
    # Salaried/exempt people (leadership, principals) are not time-tracked at all:
    # no punch card, no "hours this week" widgets (Charmi, Aug 21). Distinct from
    # pay_type='fixed' - fixed-salary staff still punch (attendance drives pay).
    time_tracking_exempt = Column(Integer, default=0)      # 1 = hide/skip time tracking
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")


class AgentActivity(Base):
    """One foreground-usage sample from the desktop agent: seconds spent in an app
    (and, for browsers, the active domain) with the window title and an activity %
    (share of that window where the user wasn't idle). Powers the Insights
    dashboard - Top Apps, Top Websites, active-vs-idle, and the activity log."""
    __tablename__ = "agent_activity"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    local_date     = Column(String, default="", index=True)
    at             = Column(String, default="")         # sample end time (UTC ISO)
    app            = Column(String, default="")         # e.g. "Google Chrome", "Excel"
    title          = Column(String, default="")         # active window title
    domain         = Column(String, default="")         # host for browser activity, else ""
    category       = Column(String, default="")         # productive | neutral | unproductive | "" (from ratings)
    seconds        = Column(Integer, default=0)
    active_pct     = Column(Integer, default=0)         # 0-100, non-idle share of this sample


class AppRating(Base):
    """Company-wide productivity rating for an app or website domain, set by an
    admin ("Rate Apps & URLs"). Drives the productive/neutral/unproductive split
    on the Insights dashboard. Keyed by lowercased app-or-domain."""
    __tablename__ = "app_ratings"
    key            = Column(String, primary_key=True)   # lowercased app name or domain
    kind           = Column(String, default="app")      # app | domain
    label          = Column(String, default="")         # display name
    rating         = Column(String, default="neutral")  # productive | neutral | unproductive
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")


class TimeOffRequest(Base):
    """Leave inside the Time module: employee-submitted, manager/HR-decided."""
    __tablename__ = "time_off_requests"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    type           = Column(String, default="vacation") # vacation|sick|personal|unpaid|other
    start_date     = Column(String, default="")         # YYYY-MM-DD
    end_date       = Column(String, default="")
    note           = Column(String, default="")
    status         = Column(String, default="pending")  # pending|approved|rejected|cancelled
    approver       = Column(String, default="")
    decided_at     = Column(String, default="")
    decide_note    = Column(String, default="")
    created_at     = Column(String, default="")
    requested_by   = Column(String, default="")         # who FILED it, when not the employee (manager+ on-behalf, Neil Aug 11)
    # Partial-day time off (Charmi, Aug 21: "two hours off for a doctor's
    # appointment"). HH:MM (24h) local times; both empty = full day(s). Times are
    # only valid on a single-day request (start_date == end_date).
    start_time     = Column(String, default="")
    end_time       = Column(String, default="")


class DashboardView(Base):
    """A saved, customizable dashboard layout (drag-and-drop widget grid).
    scope='personal' → belongs to one user (owner_email); scope='department' →
    a manager-published template every member of that department inherits and
    can fork into their own. `target` picks the screen it applies to
    ('dashboard' or 'manager-dashboard'). `layout` is a JSON array of widget
    placements: [{ i, type, x, y, w, h, config }]."""
    __tablename__ = "dashboard_views"
    id           = Column(String, primary_key=True)   # uuid
    owner_email  = Column(String, index=True, default="")   # "" for department scope
    target       = Column(String, default="dashboard", index=True)  # dashboard | manager-dashboard
    name         = Column(String, default="My view")
    scope        = Column(String, default="personal")       # personal | department
    department   = Column(String, default="")               # set when scope=department
    layout       = Column(JSON, default=list)               # [{i,type,x,y,w,h,config}]
    is_default   = Column(Boolean, default=False)           # this user's default for the target
    created_by   = Column(String, default="")
    created_at   = Column(String, default="")
    updated_at   = Column(String, default="")


class UserLinkLayout(Base):
    """A user's personalized External Links arrangement (app ordering, custom
    folders, favorites) - mirrors DashboardView's JSON-blob-per-user shape
    above rather than normalizing into per-item rows: auto-save writes the
    whole document in one UPSERT, and nothing here needs SQL-side querying by
    folder/item (existence/permission re-checks happen at read time against
    ExternalLink/PersonalLink directly in the router, not via a FK - a dead
    reference is dropped there, not rejected here). One row per user, unlike
    DashboardView's multi-row-per-owner shape, since there's exactly one
    layout per person for this module (no named/multiple-views concept).

    layout shape: {
      folders:   [{id, name, position, item_type: 'external'|'personal'}],
      items:     [{item_type: 'external'|'personal', item_id, folder_id|null,
                   position, dashboard?: bool}],
      favorites: [{item_type, item_id}],
    }
    item_type disambiguates ExternalLink vs PersonalLink ids, which are both
    plain autoincrement ints on separate tables and would otherwise collide.
    A folder's own item_type (Aug 14) keeps it strictly one or the other -
    a Company folder only ever holds 'external' items, a Personal folder
    only ever holds 'personal' ones; link_layouts.py enforces this on every
    write so Company and Personal arrangements can never cross despite
    sharing this one JSON document. Folders are intentionally flat (no
    parent_folder_id) - single-level only."""
    __tablename__ = "user_link_layouts"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, index=True, unique=True, nullable=False)
    layout      = Column(JSON, default=dict)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class LinkLayoutView(Base):
    """One of a user's saved, named External Links personalization
    arrangements (Aug 14 - "same option as we have in dashboard section...
    default view and add customize views... save it per our convenient
    name"). Mirrors DashboardView's personal-view shape (id, owner_email,
    name, layout, is_default) exactly, minus the department/scope/target
    machinery that concept needed and this doesn't - every Link View is
    personal-only, and there's only one screen (External Links) it applies
    to. Multiple rows per user is the whole point (unlike UserLinkLayout
    above), so owner_email is indexed but NOT unique.

    Supersedes UserLinkLayout's one-row-per-user shape, which had no room
    for more than one saved arrangement. UserLinkLayout is left in place
    read-only as a migration source (link_layouts.py lazily copies a user's
    existing row into a new LinkLayoutView, named "My view" and marked
    default, the first time they hit any view-aware endpoint after this
    shipped) rather than being altered or dropped - changing an existing
    unique(owner_email) constraint on a live table is exactly the kind of
    migration this codebase avoids (CLAUDE.md's migration guidance), and a
    lazy copy-on-read needs no downtime or backfill script.

    "Home" (the synthesized, unarranged company/personal default order) is
    NOT a row here, same as Dashboard's Home isn't a DashboardView row -
    it's a client-side fallback when no view is active/default, exactly
    mirroring useDashboards.js's `activeId === null` case.

    layout shape is identical to UserLinkLayout.layout - see that
    docstring for the full {folders, items, favorites} shape and the
    item_type-scoping rules that keep Company and Personal Links from ever
    mixing within one view."""
    __tablename__ = "link_layout_views"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, index=True, nullable=False)
    name        = Column(String, default="My view")
    layout      = Column(JSON, default=dict)
    is_default  = Column(Boolean, default=False)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class HrInterviewTemplate(Base):
    """Role questionnaire for AI-assisted interviews: the questions HR asks in
    the Teams call; answers get auto-filled from the transcript and scored."""
    __tablename__ = "hr_interview_templates"
    id         = Column(String, primary_key=True)   # uuid
    name       = Column(String, nullable=False)     # role, e.g. "Site Manager"
    questions  = Column(JSON, default=list)         # [{id, q}]
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    updated_at = Column(String, default="")


class HrInterview(Base):
    """One interview round for a candidate: Teams meeting + questionnaire +
    AI-filled answers + calibrated score (feeds the role leaderboard)."""
    __tablename__ = "hr_interviews"
    id              = Column(String, primary_key=True)   # uuid
    candidate_id    = Column(String, nullable=False, index=True)
    template_id     = Column(String, default="")
    template_name   = Column(String, default="")         # frozen at schedule time
    status          = Column(String, default="scheduled") # scheduled|live|completed|scored
    at              = Column(String, default="")          # ISO start
    duration_min    = Column(Integer, default=45)
    organizer_email = Column(String, default="")
    event_id        = Column(String, default="")          # Graph calendar event
    join_url        = Column(String, default="")          # Teams join link
    answers         = Column(JSON, default=list)          # [{qid, q, answer, score, rationale}]
    transcript      = Column(String, default="")          # pulled from Teams or pasted
    total_score     = Column(Float, default=0.0)          # 0–100 after calibration
    summary         = Column(String, default="")          # AI verdict paragraph
    started_at      = Column(String, default="")
    completed_at    = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")


class HrSelfRequest(Base):
    """Employee → HR ask raised from My HR (update a document, profile change,
    question). HR members are notified on create and resolve it in the HR
    module; the employee tracks status + response on My HR."""
    __tablename__ = "hr_self_requests"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    employee_name  = Column(String, default="")
    type           = Column(String, default="document")  # document | profile | question | other
    message        = Column(String, default="")
    attachment_path = Column(String, default="")         # hr-docs object the employee attached
    attachment_name = Column(String, default="")
    status         = Column(String, default="open")      # open | resolved
    response       = Column(String, default="")
    resolved_by    = Column(String, default="")
    resolved_at    = Column(String, default="")
    created_at     = Column(String, default="")


# ── Field-worker location tracking (native app, clocked-in only) ──────────────
# Periodic location pings across a shift for on-site crews. A browser can't do
# this (geolocation dies when the phone locks), so the client is a native
# Capacitor app that reuses the silent-agent token model (agent_devices +
# X-Agent-Token) for enrollment - no Microsoft login on the phone.

class TrackConsent(Base):
    """Standing, revocable consent to be location-tracked while clocked in.
    /track/start refuses without a live (granted, not-revoked) row. BYOD +
    location = the highest-scrutiny path, so consent is explicit and recorded."""
    __tablename__ = "track_consent"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    granted        = Column(Integer, default=1)         # 1 = consented, 0 = revoked
    granted_at     = Column(String, default="")
    revoked_at     = Column(String, default="")
    text_version   = Column(String, default="")         # which consent wording was shown
    ip             = Column(String, default="")
    user_agent     = Column(String, default="")
    created_at     = Column(String, default="")


class TrackSession(Base):
    """One tracking run == one shift. Opened at clock-in (or first ping while
    clocked in), closed at clock-out / idle / expiry. The session IS the shift:
    no session => no tracking, enforced server-side."""
    __tablename__ = "track_sessions"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    device_id      = Column(String, default="")         # agent_devices.id that enrolled the phone
    consent_id     = Column(String, default="")         # track_consent row in force at start
    started_at     = Column(String, default="")
    ended_at       = Column(String, default="")
    ended_reason   = Column(String, default="")         # clock_out | idle | manual | expired
    created_at     = Column(String, default="")


class TrackPing(Base):
    """One periodic location sample (~every 5 min or 100 m, clocked-in only).
    Tagged in/out of the nearest work-site geofence by the shared _geofence().
    Raw rows auto-purge after the retention window; keep a daily summary."""
    __tablename__ = "track_pings"
    id             = Column(String, primary_key=True)   # uuid
    session_id     = Column(String, index=True, default="")
    employee_email = Column(String, nullable=False, index=True)
    at             = Column(String, nullable=False)     # UTC ISO - device capture time (not receive time)
    received_at    = Column(String, default="")         # UTC ISO - when the server stored it
    local_date     = Column(String, default="", index=True)
    lat            = Column(String, default="")
    lng            = Column(String, default="")
    accuracy_m     = Column(Integer, default=0)
    geo_status     = Column(String, default="no_location")  # in_fence|out_of_fence|low_accuracy|no_location
    work_site_id   = Column(String, default="")
    work_site_name = Column(String, default="")
    distance_m     = Column(Integer, default=0)
    battery_pct    = Column(Integer, default=-1)        # -1 = unknown
    source         = Column(String, default="mobile")


class MonitoringPolicy(Base):
    """Admin-set, server-side policy the desktop agent fetches each heartbeat -
    replaces the agent's hardcoded interval/toggles so capture cadence and what's
    collected are controlled centrally and auditable. Single row (id='default').
    DISCLOSED monitoring: capture only runs while clocked in and after the
    employee acknowledges it (see MonitoringConsent); this row just governs HOW."""
    __tablename__ = "monitoring_policy"
    id               = Column(String, primary_key=True, default="default")
    enabled          = Column(Integer, default=1)   # master switch; 0 = no capture at all
    interval_minutes = Column(Integer, default=5)   # base cadence between captures
    randomize        = Column(Integer, default=1)   # jitter the interval so a shot can't be timed/gamed
    track_screens    = Column(Integer, default=1)   # screenshots
    track_windows    = Column(Integer, default=1)   # active foreground window title
    track_input      = Column(Integer, default=1)   # aggregate active/idle % - NEVER keystroke content
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")


class PunchRequest(Base):
    """An employee's request to FIX their timesheet - add a missed punch or remove
    a wrong one - that an approver (HR/manager) must approve or reject before it
    takes effect. Unlike a self-service backfill (which lands immediately, flagged),
    this is gated: nothing changes on the timesheet until approved."""
    __tablename__ = "punch_requests"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    employee_name  = Column(String, default="")
    action         = Column(String, default="add")      # add | remove
    punch_kind     = Column(String, default="in")       # add: in|out|break_start|break_end
    at             = Column(String, default="")          # add: requested punch time (UTC ISO)
    local_date     = Column(String, default="", index=True)
    tz_offset_min  = Column(Integer, default=0)
    target_punch_id= Column(String, default="")          # remove: which punch to void
    reason         = Column(String, default="")          # employee's justification (required)
    status         = Column(String, default="pending", index=True)  # pending | approved | rejected
    decided_by     = Column(String, default="")          # approver email
    decided_at     = Column(String, default="")
    decision_note  = Column(String, default="")          # approver's note (esp. on reject)
    applied_punch_id = Column(String, default="")        # the TimePunch created/voided on approval
    created_at     = Column(String, default="")


class MonitoringConsent(Base):
    """Per-day record that the employee was shown, and acknowledged, the monitoring
    notice at clock-in. Enforced server-side: with monitoring enabled, the first
    in-punch of the day is refused until this exists (mirrors TrackConsent, but
    per-day rather than standing). This is what makes the monitoring DISCLOSED."""
    __tablename__ = "monitoring_consent"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    local_date     = Column(String, default="", index=True)
    text_version   = Column(String, default="")         # which notice wording was acknowledged
    granted_at     = Column(String, default="")
    ip             = Column(String, default="")
    user_agent     = Column(String, default="")
    created_at     = Column(String, default="")


class PolicyAcknowledgment(Base):
    """One-time (per policy version) acknowledgment of company policies + the
    employee-monitoring disclosure, shown at sign-in. Records who/when/version/
    ip/ua so the acceptance is provable. Bumping POLICY_VERSION re-prompts
    everyone. This is the standing, portal-wide disclosure; MonitoringConsent is
    the separate per-day clock-in acknowledgment."""
    __tablename__ = "policy_acknowledgments"
    id             = Column(String, primary_key=True)   # uuid
    email          = Column(String, nullable=False, index=True)
    version        = Column(String, default="", index=True)
    accepted_at    = Column(String, default="")
    ip             = Column(String, default="")
    user_agent     = Column(String, default="")


# ═════════════════════════════════════════════════════════════════════════════
# Task Module - supporting tables (ported from task-module export, Jul 2026)
# All email-keyed; ISO-string timestamps; jsonb for arrays/maps. See Task above.
# ═════════════════════════════════════════════════════════════════════════════
class TaskProject(Base):
    """A body of work containing tasks (Asana "project")."""
    __tablename__ = "task_projects"
    id            = Column(String, primary_key=True)
    name          = Column(String, nullable=False)
    description   = Column(String, default="")
    color         = Column(String, default="")
    owner_email   = Column(String, default="", index=True)
    portfolio_id  = Column(String, default="", index=True)
    # Real People-module department (HrDepartment.id - no DB FK; same
    # hr_department_id naming TaskTicket already uses for this exact concept,
    # kept distinct from a task-scoped "department_id" on purpose). Auto-
    # resolved from the creating user's own employee record at creation time
    # (see create_project) rather than manually picked - hr_department_name is
    # a display snapshot taken at that same moment.
    hr_department_id   = Column(String, default="", index=True)
    hr_department_name = Column(String, default="")
    # Visibility (mirrors Task.access_level, org|restricted). DB default is
    # "org" so a bare ADD COLUMN backfills existing projects as visible to
    # everyone (today's de-facto behavior) rather than silently locking
    # collaborators out; create_project applies a stricter "restricted"
    # default for newly-created rows instead (see that endpoint).
    access_level  = Column(String, default="org")
    status        = Column(String, default="not_started")
    start_on      = Column(String, default="")
    due_on        = Column(String, default="")
    archived      = Column(Boolean, default=False)
    member_emails = Column(JSON, default=list)
    # Per-person role for the Share panel (owner|editor|commenter|viewer),
    # keyed by lowercase email - {email: role}. Additive to member_emails,
    # which stays the flat "has access at all" list every other visibility
    # check (task_util.visible_project_ids) already relies on; a role here
    # implies that email also belongs in member_emails (see update_project).
    member_roles  = Column(JSON, default=dict)
    activity_ids  = Column(JSON, default=list)
    created_at    = Column(String, default="")
    modified_at   = Column(String, default="")
    created_by    = Column(String, default="")
    # {customFieldId: value} - project-scoped custom fields (see TaskCustomField.
    # applies_to). Same shape and same coerce_custom_field_values() as
    # Task.custom_field_values; the field defs table is shared.
    custom_field_values = Column(JSON, default=dict)


class TaskPortfolio(Base):
    """A curated, ordered collection of projects (Asana "portfolio")."""
    __tablename__ = "task_portfolios"
    id          = Column(String, primary_key=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    color       = Column(String, default="")
    owner_email = Column(String, default="", index=True)
    project_ids = Column(JSON, default=list)              # ordered
    archived    = Column(Boolean, default=False)
    created_at  = Column(String, default="")
    modified_at = Column(String, default="")
    created_by  = Column(String, default="")


class TaskTeam(Base):
    """A named group (e.g. "IT Team", "QA Team") - not a cross-project
    department. A team can exist standalone (no projects) or be assigned to any
    number of projects, from its own modal or a project's Teams picker.

    `project_ids` is the source of truth. It replaced the single `project_id`,
    which forced one Nexus team row per project and so minted a duplicate card
    every time one real team (IT, Development) worked on a second project -
    Asana teams are shared across projects routinely, and the sync had to create
    a fresh team each time rather than steal one another project depended on.
    `project_id` is kept as a WRITE-ONLY legacy mirror (first element) so an old
    row or an unmigrated reader still resolves to something sane; nothing should
    read it."""
    __tablename__ = "task_teams"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, default="", index=True)   # legacy mirror of project_ids[0]
    project_ids   = Column(JSON, default=list)
    name          = Column(String, nullable=False)
    color         = Column(String, default="")
    icon          = Column(String, default="")           # key from the department icon registry
    member_emails = Column(JSON, default=list)
    # Project-access role this team's roster is granted on its project (Share
    # panel) - owner|editor|commenter|viewer. Distinct from the team's own
    # purpose (assignment grouping); default "editor" preserves the pre-Share-
    # panel behavior where any team member could act on the project's tasks.
    access_role   = Column(String, default="editor")
    created_at    = Column(String, default="")


class TaskSection(Base):
    """An ordered section/group within a project's list & board views."""
    __tablename__ = "task_sections"
    id         = Column(String, primary_key=True)
    project_id = Column(String, default="", index=True)
    name       = Column(String, nullable=False)
    position   = Column(Integer, default=0)
    created_at = Column(String, default="")


class TaskCustomStatus(Base):
    """A user-defined board column / status beyond the four built-ins."""
    __tablename__ = "task_custom_statuses"
    id       = Column(String, primary_key=True)
    label    = Column(String, nullable=False)
    color    = Column(String, default="")
    position = Column(Integer, default=0)
    # Which projects show this status, same convention as TaskCustomField:
    # EMPTY = every project, which is what every status was before scoping
    # existed, so upgrading changes nothing until someone narrows one. Without
    # it a status added for one board became a column on every board.
    project_ids = Column(JSON, default=list)
    # The Asana "Task Progress" enum option this mirrors, blank for a Nexus-only
    # status. Asana options that have no built-in Nexus equivalent ("Waiting",
    # "Deferred", anything a project invents) become custom statuses on exactly
    # the projects that use them, rather than being dropped on the way in.
    asana_option_gid = Column(String, default="", index=True)
    # Every Asana enum option this one status fronts. Asana's "Task Progress" is
    # usually a PER-PROJECT custom field, so "Waiting" on two projects is two
    # different option gids - keying identity on a single gid therefore minted a
    # second "Waiting" row per project (Sagar, Aug 4: "single Waiting status
    # should be used for both projects"). Matching on the LABEL and collecting
    # the gids here gives one row scoped to many projects, while still letting a
    # rename in Asana be recognised rather than orphaned.
    asana_option_gids = Column(JSON, default=list)


class TaskComment(Base):
    __tablename__ = "task_comments"
    id           = Column(String, primary_key=True)
    task_id      = Column(String, default="", index=True)
    author_email = Column(String, default="")
    body         = Column(String, default="")
    created_at   = Column(String, default="")
    edited_at    = Column(String, default="")
    pinned       = Column(Boolean, default=False)
    internal     = Column(Boolean, default=False)   # ticket notes only: agent-visible, not shared with the requester


class TaskAttachment(Base):
    """File attached to a task. Bytes live in Supabase storage; `url` points there."""
    __tablename__ = "task_attachments"
    id         = Column(String, primary_key=True)
    task_id    = Column(String, default="", index=True)
    name       = Column(String, nullable=False)
    size       = Column(String, default="")
    kind       = Column(String, default="other")         # image|doc|other
    url        = Column(String, default="")              # Supabase storage url (see _validate_photo_url)
    added_at   = Column(String, default="")
    added_by   = Column(String, default="")
    # Set only for a file attached while composing a comment (blank = today's
    # plain task-level attachment, unaffected). Asana's own API has no
    # comment/story parent for an attachment - only a Nexus-native comment gets
    # this link, so nothing here is guessed at for Asana-origin data.
    comment_id = Column(String, default="", index=True)
    # Set by the Asana attachment rescue (Aug 2026) when it rewrites `url` away
    # from a dying asanausercontent.com/app.asana.com address: the pre-rescue
    # URL, kept for audit/rollback. Blank on every row the rescue never touched.
    original_asana_url = Column(String, default="")


class TaskActivity(Base):
    """One activity-feed event. Denormalised entity labels are captured at log
    time so the global Activity Log renders even after the task/project is gone."""
    __tablename__ = "task_activity"
    id           = Column(String, primary_key=True)
    entity_kind  = Column(String, default="task")        # task|project
    entity_id    = Column(String, default="", index=True)
    entity_code  = Column(String, default="")            # e.g. "TASK-003" or project name
    entity_title = Column(String, default="")
    type         = Column(String, default="")
    actor_email  = Column(String, default="")
    at           = Column(String, default="", index=True)
    detail       = Column(String, default="")


class TaskDeleteLog(Base):
    """One row per deleted task/subtask - lets a delta fetch (GET /tasks/delta)
    tell a client a task is GONE, not just absent from an incremental result
    (silence is ambiguous: absent could mean "unchanged" or "deleted"). Mirrors
    the Asana-sync tombstone pattern (AsanaPendingDelete / queue_task_delete in
    asana_sync.py) for the identical reason."""
    __tablename__ = "task_delete_log"
    id         = Column(String, primary_key=True)
    task_id    = Column(String, default="", index=True)
    deleted_at = Column(String, default="", index=True)


class TaskSavedView(Base):
    __tablename__ = "task_saved_views"
    id          = Column(String, primary_key=True)
    owner_email = Column(String, default="", index=True)
    name        = Column(String, nullable=False)
    view        = Column(String, default="list")         # list|board|calendar|timeline
    filters     = Column(JSON, default=dict)
    sort        = Column(JSON, default=dict)
    group       = Column(String, default="none")
    scope       = Column(String, default="task")         # task|ticket - which module the view belongs to
    created_at  = Column(String, default="")


class TaskAutomationRule(Base):
    __tablename__ = "task_automation_rules"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    trigger    = Column(JSON, default=dict)              # {type, value?}
    actions    = Column(JSON, default=list)              # [{type, value}]
    enabled    = Column(Boolean, default=True)
    created_at = Column(String, default="")


class TaskTemplate(Base):
    __tablename__ = "task_templates"
    id             = Column(String, primary_key=True)
    name           = Column(String, nullable=False)
    description    = Column(String, default="")
    patch          = Column(JSON, default=dict)          # Partial<Task> applied on use
    subtask_titles = Column(JSON, default=list)
    created_at     = Column(String, default="")


class TaskIntakeForm(Base):
    __tablename__ = "task_intake_forms"
    id                = Column(String, primary_key=True)
    title             = Column(String, nullable=False)
    fields            = Column(JSON, default=list)       # [{label,type,required}]
    target_project_id = Column(String, default="")
    created_at        = Column(String, default="")


class TaskCustomField(Base):
    """A user-defined field on tasks (Asana "custom field"). Definitions live
    here; the per-task values live on Task.custom_field_values keyed by id."""
    __tablename__ = "task_custom_fields"
    id          = Column(String, primary_key=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    # text|number|date|checkbox|select|multiselect|people - the seven kinds a
    # value is actually STORED as. The "+ Column" menu's visual types all map
    # onto these (see views/richlist.jsx TYPE_GROUPS). The last two hold LISTS:
    # multiselect a list of option ids, people a list of Nexus work emails -
    # they exist so Asana's multi_enum and people fields round-trip instead of
    # being flattened to text (which pushed back as garbage).
    type        = Column(String, default="text")
    # [{id,label,color}]. Older rows hold plain strings; task_config normalizes
    # both shapes on read, so nothing needs backfilling.
    options     = Column(JSON, default=list)
    # Asana formula fields are computed on their side and the API rejects any
    # write, so they import but must never push. Nothing else sets this; a
    # read-only field renders disabled in the editors and _outbound_custom_fields
    # skips it entirely.
    read_only   = Column(Boolean, default=False)
    # Which projects use this field. EMPTY = every project, the pre-scoping behavior,
    # so upgrading changes nothing until an admin narrows a field. Without it one
    # field became a column on every board in the workspace.
    #
    # For an Asana-derived field this is maintained by the sync, not by hand: it
    # holds exactly the Nexus projects whose Asana counterpart carries the field,
    # which is why a column added to one Asana board never appears on the others.
    project_ids = Column(JSON, default=list)
    # The Asana custom field this mirrors, blank for a Nexus-only field. Identity
    # comes from the gid rather than the name so a field RENAMED in Asana stays
    # the same Nexus column (the name follows), and so two same-named fields in
    # different projects stay two separate columns instead of silently merging -
    # matching by name did both of those wrong.
    asana_gid   = Column(String, default="", index=True)
    # Must have a value before a task can be created (checked on the create form,
    # not on the API - inbound Asana tasks legitimately arrive without it).
    required    = Column(Boolean, default=False)
    # task|project - which entity this field lives on (Aug 2026, added for the
    # project-level Location field). Values are still stored keyed by field id
    # in the entity's own custom_field_values column (Task.custom_field_values
    # for task-scoped fields, TaskProject.custom_field_values for project-scoped
    # ones) - this column only decides where the field editor offers it and
    # where its value renders. Default "task" keeps every pre-existing field
    # (and TaskTicket, which reuses these same defs) behaving exactly as before.
    applies_to  = Column(String, default="task")


class TaskMemberRequest(Base):
    """Request raised from the Teams page to add/remove a department member;
    admins approve/reject from Manage → Departments."""
    __tablename__ = "task_member_requests"
    id            = Column(String, primary_key=True)
    department_id = Column(String, default="", index=True)
    user_email    = Column(String, default="")           # person to add/remove
    kind          = Column(String, default="add")        # add|remove
    requested_by  = Column(String, default="")           # email
    status        = Column(String, default="pending")    # pending|approved|rejected
    created_at    = Column(String, default="")
    decided_at    = Column(String, default="")
    decided_by    = Column(String, default="")


class TaskNotification(Base):
    """The task module's own in-app notification (its NotificationBell). `for_email`
    is a specific address or the literal "admins" to fan out to every admin."""
    __tablename__ = "task_notifications"
    id            = Column(String, primary_key=True)
    kind          = Column(String, default="")           # member_request|task_assigned|task_overdue|...
    title         = Column(String, default="")
    body          = Column(String, default="")
    for_email     = Column(String, default="", index=True)
    request_id    = Column(String, default="")
    department_id = Column(String, default="")
    task_id       = Column(String, default="")
    read          = Column(Boolean, default=False)
    created_at    = Column(String, default="", index=True)


class TaskTicket(Base):
    """A support/IT request; may be escalated into a Task (linked_task_id)."""
    __tablename__ = "task_tickets"
    id             = Column(String, primary_key=True)
    code           = Column(String, default="")
    subject        = Column(String, nullable=False)
    description    = Column(String, default="")
    type           = Column(String, default="request")   # bug|incident|service_request|task|question|request
    # new|open|in_progress|waiting_user|waiting_vendor|on_hold|resolved|closed|reopened
    # The two waiting_* states say who the ball is with; on_hold is the team
    # parking it themselves. See TICKET_STATUS_META (ticketMeta.js).
    status         = Column(String, default="new")
    priority       = Column(String, default="medium")
    requester_email= Column(String, default="", index=True)
    assignee_email = Column(String, default="", index=True)
    department_id  = Column(String, default="", index=True)   # task department ("Team")
    company_id     = Column(String, default="", index=True)   # HrEntity.id - company from the People module
    hr_department_id = Column(String, default="", index=True) # HrDepartment.id - department from the People module
    linked_task_id = Column(String, default="")
    tags           = Column(JSON, default=list)
    images         = Column(JSON, default=list)   # screenshot data URLs / storage links
    watcher_emails = Column(JSON, default=list)   # people notified on ticket changes
    resolution     = Column(String, default="")   # fixed|wont_fix|duplicate|cannot_reproduce|done
    custom_field_values = Column(JSON, default=dict)  # {customFieldId: value} - reuses the task custom-field defs
    type_fields    = Column(JSON, default=dict)   # {fieldKey: value} - per-type intake fields (bug/incident/… specific)
    links          = Column(JSON, default=list)   # [{ticketId, type}] - relates|duplicate|blocks|blocked_by
    task_ids       = Column(JSON, default=list)   # tasks spawned from / linked to this ticket (one ticket → many tasks)
    component      = Column(String, default="")   # category/component name (see TaskTicketComponent)
    csat_rating    = Column(Integer, default=0)   # 1-5 satisfaction rating; 0 = not rated
    csat_comment   = Column(String, default="")
    # Approval gate. Types that name an approver at intake (service_request,
    # change_request, access_request) park here first: the approver is notified,
    # and only on approval does the ticket reach the department lead for triage.
    # "none" = this ticket never needed approval.
    approval_status   = Column(String, default="none")   # none|pending|approved|rejected
    approver_email    = Column(String, default="", index=True)
    approval_note     = Column(String, default="")       # the approver's reason, esp. on reject
    approval_decided_at = Column(String, default="")
    # Who handed this ticket to its assignee. Stamped by the server from the
    # actor on the assigning request, never sent by the client - the point of
    # the field is that it records who actually did it, and a value the caller
    # can set is not a record of anything. Blank on tickets nobody has
    # assigned yet, and on those assigned before this existed.
    assigned_by_email = Column(String, default="", index=True)
    sla_due_on     = Column(String, default="")
    resolved_at    = Column(String, default="")
    created_at     = Column(String, default="")
    modified_at    = Column(String, default="")


class TicketEmailLog(Base):
    """One attempted Outlook notification for a ticket event (Ticket
    Notification Workflow, Jul 2026). One row per (ticket, event, recipient) -
    the durable record a background retry loop scans, and what an admin's
    delivery-log view reads. `idempotency_key` is
    f"{ticket_id}:{event_type}:{event_version}:{recipient}" - checked before
    sending so the same event never emails the same person twice, including
    across a mid-send server restart (see ticket_notify.py)."""
    __tablename__ = "ticket_email_log"
    id                   = Column(String, primary_key=True)
    ticket_id            = Column(String, default="", index=True)
    ticket_code          = Column(String, default="")     # denormalised so the log reads after a ticket is deleted
    event_type           = Column(String, default="")     # created|assigned|updated|resolved|reopened
    event_version        = Column(Integer, default=0)     # bumps when the same event_type fires again on this ticket
    idempotency_key       = Column(String, default="", index=True, unique=True)
    recipient            = Column(String, default="")
    recipient_role       = Column(String, default="")     # requester|it_admin|assignee|ticket_admin
    subject              = Column(String, default="")
    status               = Column(String, default="pending")   # pending|sent|failed|retrying
    graph_message_id     = Column(String, default="")
    conversation_id      = Column(String, default="")
    internet_message_id  = Column(String, default="")
    attempts             = Column(Integer, default=0)
    error                = Column(String, default="")
    created_at           = Column(String, default="")
    updated_at           = Column(String, default="")


class TaskTicketComponent(Base):
    """A ticket component / category (e.g. "Billing", "Network"). Small config
    table managed from Manage; tickets reference one by name."""
    __tablename__ = "task_ticket_components"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    created_at = Column(String, default="")


class TaskEmailLog(Base):
    """One attempted Outlook notification for a Task-module event (Task
    Notification Workflow, Jul 2026 - same design as TicketEmailLog above,
    just task-scoped). One row per (task, event, recipient); idempotency_key
    prevents ever emailing the same event to the same person twice, including
    a due-date reminder re-firing on a later pull of the same calendar day."""
    __tablename__ = "task_email_log"
    id                   = Column(String, primary_key=True)
    task_id              = Column(String, default="", index=True)
    task_code            = Column(String, default="")     # denormalised so the log reads after a task is deleted
    event_type           = Column(String, default="")     # created|assigned|due_soon|overdue|completed|commented|follower_added|modified|deleted
    event_version        = Column(Integer, default=0)
    idempotency_key       = Column(String, default="", index=True, unique=True)
    recipient            = Column(String, default="")
    recipient_role       = Column(String, default="")     # assignee|follower|creator|owner
    subject              = Column(String, default="")
    # The exact rendered body from the original send attempt, reused verbatim on
    # retry (same reasoning as `subject` above). Without this, a retried
    # commented/mentioned email had no comment text to rebuild from and silently
    # sent a generic "Task updated" body instead - and any retry, of any event
    # type, could drift from what the event actually said if the task's fields
    # changed between the failed attempt and the retry. Blank on legacy rows
    # created before this column existed; _rebuild_email is the fallback there.
    html                 = Column(String, default="")
    status               = Column(String, default="pending")   # pending|sent|failed|retrying
    graph_message_id     = Column(String, default="")
    conversation_id      = Column(String, default="")
    internet_message_id  = Column(String, default="")
    attempts             = Column(Integer, default=0)
    error                = Column(String, default="")
    created_at           = Column(String, default="")
    updated_at           = Column(String, default="")


class TaskChangelogEntry(Base):
    """A changelog / "What's New" entry. Kept schema-loose (full object in
    `payload`) - mirrors the property_records pattern - until the changelog UI
    is ported and its shape stabilises."""
    __tablename__ = "task_changelog_entries"
    id         = Column(String, primary_key=True)
    payload    = Column(JSON, default=dict)
    created_at = Column(String, default="", index=True)
    updated_at = Column(String, default="")


class TaskChangelogComment(Base):
    __tablename__ = "task_changelog_comments"
    id           = Column(String, primary_key=True)
    entry_id     = Column(String, default="", index=True)
    author_email = Column(String, default="")
    body         = Column(String, default="")
    created_at   = Column(String, default="")


class TaskEvent(Base):
    """Realtime ping table. The only task_* table that is anon-readable (SELECT):
    the frontend subscribes to it via the Supabase anon key to know when to
    refetch - the real tables are never anon-exposed. Rows carry no sensitive
    payload, just enough to scope a refetch (mirrors inventory_events)."""
    __tablename__ = "task_events"
    id             = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id        = Column(String, default="")
    kind           = Column(String, default="")          # created|updated|deleted|comment|...
    affected_email = Column(String, default="")
    created_at     = Column(String, default="")          # set server-side (timestamptz in DB)


# ── Asana two-way sync (new tables - create_all builds them, no migration) ────
class AsanaSyncConfig(Base):
    """Single-row config for the Nexus <-> Asana sync (id fixed to 'singleton')."""
    __tablename__ = "asana_sync_config"
    id                  = Column(String, primary_key=True, default="singleton")
    enabled             = Column(Boolean, default=False)
    token               = Column(String, default="")     # Asana service PAT (write scope)
    # PAT for the Setup actions (import all / register webhooks) only. Separate from
    # `token` so a one-off bulk import can run as an admin without that account
    # becoming the identity every ongoing push is attributed to. Blank = use `token`.
    setup_token         = Column(String, default="")
    workspace_gid       = Column(String, default="")
    default_project_gid = Column(String, default="")     # Asana project unmapped tasks push to
    last_pull_at        = Column(String, default="")      # ISO watermark for inbound polling
    updated_at          = Column(String, default="")
    # Propagate deletions both ways: a task deleted in Asana is deleted in Nexus
    # on the next pull/webhook, and deleting a Nexus task deletes its Asana
    # counterpart. Separate from `enabled` because it's the one irreversible
    # part of the sync - everything else this module does is additive.
    delete_sync         = Column(Boolean, default=True)
    # The Two-Way Sync card's OWN sync/delete toggles, independent of `enabled`/
    # `delete_sync` above (which belong to the Setup card's blanket toggle).
    # Every gate in this module ORs the two pairs together via sync_is_on()/
    # delete_sync_is_on() - either card's toggle being on is enough to sync
    # whatever is currently in AsanaProjectMap. Default False so nothing changes
    # for an existing install until someone opts into the manual-mapping card.
    manual_sync_enabled = Column(Boolean, default=False)
    manual_delete_sync  = Column(Boolean, default=False)
    # Set to an ISO timestamp while an additive "Pull new only" run is in flight,
    # cleared when it finishes. The pull-new endpoint refuses to start a second run
    # while this is set and recent, so rapid re-clicks can't stack overlapping pulls
    # that contend on the per-project lock and crawl (Aug 15). Self-heals: a value
    # older than the staleness window is treated as a dead run and a new pull starts.
    pull_running_at     = Column(String, default="")
    # Same one-at-a-time guard for the attachment-rescue worker (Aug 2026): set
    # to an ISO timestamp while a rescue run is in flight, cleared when it ends,
    # treated as dead after 30 minutes so a killed worker never wedges the button.
    rescue_running_at   = Column(String, default="")


class AsanaProjectMap(Base):
    """Maps a Nexus project to an Asana project so tasks route to the right board."""
    __tablename__ = "asana_project_map"
    id                = Column(String, primary_key=True)
    nexus_project_id  = Column(String, default="", index=True)
    asana_project_gid = Column(String, default="", index=True)
    # LEGACY. Manual override for what was thought to be an Asana API gap; in fact
    # GET /memberships?parent={project} returns ad-hoc team shares as member rows
    # (resource_type="team"). Detection is automatic now and the UI field is gone;
    # saved values are still resolved by name. See asana_sync._sync_project_access.
    extra_team_names  = Column(JSON, default=list)
    created_at        = Column(String, default="")
    # Incremental-pull watermarks. `last_pull_at` is the modified_since cursor:
    # the next pull asks Asana only for tasks touched after it, instead of
    # re-downloading the whole project every couple of minutes.
    #
    # `last_full_pull_at` exists because an incremental fetch CANNOT see a
    # deletion - a task removed in Asana simply stops being returned, which is
    # indistinguishable from "not modified". So a full listing still runs
    # periodically, and only a full run is allowed to reap.
    last_pull_at      = Column(String, default="")
    last_full_pull_at = Column(String, default="")


class AsanaTaskLink(Base):
    """Links a Nexus task to its Asana counterpart. `last_hash` is a digest of the
    synced fields at the last sync - comparing against it prevents echo loops
    (a change that originated from a sync won't be pushed back)."""
    __tablename__ = "asana_task_links"
    id             = Column(String, primary_key=True)
    nexus_task_id  = Column(String, default="", index=True)
    asana_gid      = Column(String, default="", index=True)
    last_hash      = Column(String, default="")
    last_synced_at = Column(String, default="")
    # Digest of the fields Asana can only take through a separate additive
    # action rather than a task PUT - tags, followers, dependencies, section,
    # attachments. They can't live in `last_hash` because that one is compared
    # against a digest computed from Asana's own payload for loop prevention,
    # and these have no comparable inbound form (dependencies are gids on one
    # side and Nexus ids on the other). Keeping a second, push-only hash lets
    # the reconcile sweep skip a task entirely instead of firing several HTTP
    # calls per task per sweep.
    last_push_hash = Column(String, default="")
    # Digest of the ASANA-side values at the last inbound apply. `last_hash`
    # can't do this job: it holds the NEXUS-side digest (what outbound compares
    # against), and the two are legitimately unequal whenever the Asana project
    # lacks the "Task Progress"/"Priority" custom fields - Nexus knows a status
    # and priority that Asana simply cannot express. Comparing an inbound digest
    # against it therefore never matched, so every pull re-applied every task,
    # bumped modified_at and logged another "Updated from Asana" - 288 phantom
    # activity entries per task per day at the inbound poll.
    last_inbound_hash = Column(String, default="")
    # Asana's `due_at` (date AND time) as of the last pull, or "" when the task
    # has only a plain date. Nexus tasks carry a date alone, so pushing our
    # `due_on` back to a task that had a due TIME silently deleted the time -
    # the two fields are mutually exclusive in Asana, and writing one clears the
    # other. Recording what Asana holds lets the push leave the date alone when
    # it hasn't actually changed on the Nexus side. See push_task.
    last_due_at = Column(String, default="")


class AsanaCommentLink(Base):
    """Links a synced comment to its Asana story, so re-syncs don't duplicate it
    (dedup works both directions)."""
    __tablename__ = "asana_comment_links"
    id               = Column(String, primary_key=True)
    nexus_comment_id = Column(String, default="", index=True)
    asana_story_gid  = Column(String, default="", index=True)
    created_at       = Column(String, default="")


class AsanaUserToken(Base):
    """One Nexus user's own Asana OAuth grant.

    Asana attributes a story to whoever owns the token that posted it - there is
    no impersonation parameter - so a comment can only appear under its real
    author if Nexus holds that person's own token. Connected per user from
    Account Settings; see asana_oauth.py.

    Tokens are Fernet-encrypted at rest (secret_box, NEXUS_VAULT_KEY). The
    access token is short-lived (~1h) and refreshed transparently before use;
    the refresh token is the long-lived secret and is what a disconnect
    destroys."""
    __tablename__ = "asana_user_tokens"
    id                = Column(String, primary_key=True)
    email             = Column(String, default="", index=True, unique=True)  # Nexus user
    access_token_enc  = Column(String, default="")
    refresh_token_enc = Column(String, default="")
    expires_at        = Column(String, default="")   # ISO; refreshed just before use
    asana_user_gid    = Column(String, default="")
    asana_name        = Column(String, default="")   # for the "Connected as ..." line
    asana_email       = Column(String, default="")
    # Why this grant last failed to produce a token, and when. Written by
    # token_reason, cleared on the next success.
    #
    # A grant can stop working while still looking connected - the vault key
    # changing out from under it makes every stored token unreadable, which is
    # exactly what happened on dev. Falling back to the shared account is silent
    # by design (never lose a comment), so without this the user is told
    # "comments appear as you" indefinitely while every one of them says
    # somebody else. Recording it lets Account Settings ask them to reconnect
    # instead of waiting for someone to read a server log.
    last_error        = Column(String, default="")
    last_error_at     = Column(String, default="")
    created_at        = Column(String, default="")
    updated_at        = Column(String, default="")


class AsanaOAuthState(Base):
    """One in-flight OAuth authorization, keyed by the opaque `state` value.

    Two jobs: CSRF (Asana echoes it back, so a callback carrying a state we
    never issued is rejected) and identity - the callback is a plain browser
    redirect with no bearer token, so this row is the only thing tying the code
    being exchanged to the Nexus user who started the flow. Consumed once and
    deleted; anything older than the TTL is treated as expired."""
    __tablename__ = "asana_oauth_states"
    id         = Column(String, primary_key=True)   # the state value itself
    email      = Column(String, default="")         # who started the flow
    created_at = Column(String, default="")


class AsanaAttachmentLink(Base):
    """Links a synced attachment to its Asana attachment gid, so re-pulls don't
    re-download/duplicate it (inbound-only - Nexus attachments aren't pushed
    back out to Asana)."""
    __tablename__ = "asana_attachment_links"
    id                  = Column(String, primary_key=True)
    nexus_attachment_id = Column(String, default="", index=True)
    asana_attachment_gid = Column(String, default="", index=True)
    created_at          = Column(String, default="")


class AsanaActivityLink(Base):
    """Links a Nexus activity entry to the Asana story it came from. Asana's
    /stories feed carries both comments (handled by AsanaCommentLink) and
    SYSTEM stories - "changed the due date", "added to project", "marked
    complete" - which are the Asana equivalent of Nexus's activity log. This
    keys them by story gid so re-pulls don't replay the same history."""
    __tablename__ = "asana_activity_links"
    id                = Column(String, primary_key=True)
    nexus_activity_id = Column(String, default="", index=True)
    nexus_task_id     = Column(String, default="", index=True)
    asana_story_gid   = Column(String, default="", index=True)
    created_at        = Column(String, default="")


class AsanaPendingDelete(Base):
    """A Nexus task deletion still owed to Asana.

    Every other outbound change can be re-derived from the Nexus rows on the
    next push sweep - a deletion cannot: the task and its AsanaTaskLink are
    gone, so nothing is left to notice the Asana counterpart is orphaned. The
    fire-and-forget push is also the one outbound call with no safety net (it
    is skipped entirely outside the sync worker, and a failed HTTP call or a
    process restart loses it silently). Recording the gid in the SAME
    transaction as the delete makes the intent durable, so it can be drained
    later - by the sweep on dev/prod, or by "Push all" on a laptop."""
    __tablename__ = "asana_pending_deletes"
    id           = Column(String, primary_key=True)
    asana_gid    = Column(String, default="", index=True)
    task_title   = Column(String, default="")          # for reporting; the task row is gone
    task_code    = Column(String, default="")
    requested_by = Column(String, default="")
    attempts     = Column(Integer, default=0)
    last_error   = Column(String, default="")
    created_at   = Column(String, default="")


class AsanaWebhook(Base):
    """A registered Asana webhook (one per mapped project). `x_hook_secret` is the
    handshake secret used to verify inbound event signatures. A row with an empty
    asana_webhook_gid is a pending handshake awaiting its register call to finish."""
    __tablename__ = "asana_webhooks"
    id               = Column(String, primary_key=True)
    resource_gid     = Column(String, default="", index=True)   # Asana project gid
    asana_webhook_gid = Column(String, default="", index=True)
    x_hook_secret    = Column(String, default="")
    target           = Column(String, default="")
    created_at       = Column(String, default="")


# ─────────────────────────────────────────────────────────────────────────────
# Testing module (QA) - dev-only in the UI (env-gated router), but the tables
# exist everywhere create_all runs. Seeded from qa_seed.json (the Jul-2026 module
# audit workbook) on first read - same seed-if-empty pattern as item_types.
# ─────────────────────────────────────────────────────────────────────────────
class QaTestCase(Base):
    """One test case in the library. `steps` is a JSON list of plain-English
    strings a layman can follow. source: seed (workbook) | ai (converted from a
    bug report) | manual. AI drafts start status='draft' until approved."""
    __tablename__ = "qa_test_cases"
    id           = Column(String, primary_key=True)   # uuid
    module       = Column(String, nullable=False)     # People / Item Management / ...
    feature      = Column(String, default="")
    title        = Column(String, nullable=False)
    precondition = Column(String, default="")
    steps        = Column(JSON, default=list)         # ["Click …", "Type …"]
    expected     = Column(String, default="")
    priority     = Column(String, default="Medium")   # High | Medium | Low
    case_type    = Column(String, default="Functional")
    source       = Column(String, default="manual")   # seed | ai | manual
    status       = Column(String, default="active")   # active | draft | archived
    flow         = Column(JSON, default=list)         # recorded replayable actions [{view, role, label, hints}]
    e2e_spec     = Column(String, default="")         # AI-generated Playwright spec (run by CI)
    created_by   = Column(String, default="")
    created_at   = Column(String, default="")
    updated_at   = Column(String, default="")


class QaRun(Base):
    """A named testing session ("Jul 15 regression")."""
    __tablename__ = "qa_runs"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    status     = Column(String, default="open")       # open | closed
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class QaResult(Base):
    """One tester's verdict on one case within one run - upserted as they work.
    step_state: [{done: bool, shot: url}] parallel to the case's steps (per-step
    evidence). evidence: {shot: overall screenshot, recording: webm url}."""
    __tablename__ = "qa_results"
    id         = Column(String, primary_key=True)
    run_id     = Column(String, nullable=False, index=True)
    case_id    = Column(String, nullable=False, index=True)
    result     = Column(String, default="")           # '' | pass | fail | blocked | skipped
    failed_step = Column(Integer, default=-1)         # index of the step where it failed (-1 = n/a)
    step_state = Column(JSON, default=list)
    notes      = Column(String, default="")
    evidence   = Column(JSON, default=dict)
    source     = Column(String, default="human")      # human | automated (Playwright CI)
    tested_by  = Column(String, default="")
    tested_at  = Column(String, default="")


class QaBugReport(Base):
    """A free-text bug from a tester + optional recorded step log / recording /
    screenshots. AI conversion drafts a QaTestCase (converted_case_id)."""
    __tablename__ = "qa_bug_reports"
    id                = Column(String, primary_key=True)
    description       = Column(String, nullable=False)
    module_hint       = Column(String, default="")
    case_id           = Column(String, default="")     # set when filed from a failing case
    run_id            = Column(String, default="")
    failed_step       = Column(Integer, default=-1)
    steps_log         = Column(JSON, default=list)     # recorded click log [{t, view, label, role}]
    recording_url     = Column(String, default="")
    screenshots       = Column(JSON, default=list)     # [url]
    status            = Column(String, default="new")  # new | converted | dismissed
    converted_case_id = Column(String, default="")
    created_by        = Column(String, default="")
    created_at        = Column(String, default="")


class QaAssignment(Base):
    """Cases assigned to one person in one run, with a due date. Creating one
    fires email + bell (server) and a Teams DM (client, assigner's token)."""
    __tablename__ = "qa_assignments"
    id             = Column(String, primary_key=True)
    run_id         = Column(String, nullable=False, index=True)
    assignee_email = Column(String, nullable=False, index=True)
    case_ids       = Column(JSON, default=list)
    due_date       = Column(String, default="")        # ISO date
    note           = Column(String, default="")
    assigned_by    = Column(String, default="")
    created_at     = Column(String, default="")
# Credential Vault (ported from the standalone credential-vault-dev app - Jul 2026)
# Company + personal password vault. Secrets are Fernet-encrypted at rest
# (NEXUS_VAULT_KEY env var; see routers/credvault.py) and are NEVER returned by
# list endpoints - only by explicit per-item reveal endpoints, every one of
# which writes a vault_access_logs row (who revealed what, when). Access is
# gated by the "credvault" module grant. Personal credentials are strictly
# owner-scoped: no admin bypass.
# ─────────────────────────────────────────────────────────────────────────────
class VaultCredential(Base):
    __tablename__ = "vault_credentials"
    id                 = Column(String, primary_key=True)
    name               = Column(String, nullable=False)
    dept               = Column(String, default="")
    type               = Column(String, default="Password")   # Password|API key|Access key|Certificate
    username           = Column(String, default="")
    url                = Column(String, default="")
    secret_enc         = Column(String, default="")           # Fernet ciphertext - never in list responses
    secret_hash        = Column(String, default="")           # sha256 - reuse detection without decrypting
    tier               = Column(String, default="Standard")   # Standard|High|Critical
    owner_email        = Column(String, default="", index=True)
    backup_owner_email = Column(String, default="")
    strength           = Column(String, default="strong")     # weak|fair|strong (evaluated server-side)
    breached           = Column(Boolean, default=False)
    rotation_max       = Column(Integer, default=90)          # days between required rotations
    custom_expiry      = Column(Boolean, default=False)
    rotated_at         = Column(String, default="")           # ISO - last password change
    expires_at         = Column(String, default="")           # ISO date - hard expiry (API keys), optional
    deleted_at         = Column(String, default="")           # soft delete → Trash tab
    deleted_by         = Column(String, default="")
    created_at         = Column(String, default="")
    created_by         = Column(String, default="")


class VaultPersonalCredential(Base):
    """Private per-user credential - bound to the signed-in MS account email.
    Owner-only at the API: not readable by admins or anyone else."""
    __tablename__ = "vault_personal_credentials"
    id          = Column(String, primary_key=True)
    owner_email = Column(String, default="", index=True)
    name        = Column(String, nullable=False)
    username    = Column(String, default="")
    type        = Column(String, default="Password")
    note        = Column(String, default="")
    secret_enc  = Column(String, default="")
    strength    = Column(String, default="strong")
    created_at  = Column(String, default="")


class VaultShareRequest(Base):
    """Pending approval: either a share request routed to the credential's
    owner (owner_email set) or a Critical-tier reveal request routed to Global
    Admins (owner_email empty)."""
    __tablename__ = "vault_share_requests"
    id                 = Column(String, primary_key=True)
    cred_id            = Column(String, default="", index=True)
    requested_by_email = Column(String, default="")
    shared_to_email    = Column(String, default="")           # recipient of the access
    owner_email        = Column(String, default="")           # ""=Global Admin approval queue
    duration_ms        = Column(BigInteger, default=3600000)
    duration_label     = Column(String, default="1 Hour")
    status             = Column(String, default="pending")    # pending|approved|denied
    created_at         = Column(String, default="")
    decided_at         = Column(String, default="")
    decided_by         = Column(String, default="")


class VaultAccessGrant(Base):
    """Time-boxed shared access to one credential. The secret itself is never
    copied here - reveal goes back through the credential + this grant check."""
    __tablename__ = "vault_access_grants"
    id         = Column(String, primary_key=True)
    cred_id    = Column(String, default="", index=True)
    granted_to = Column(String, default="", index=True)
    granted_by = Column(String, default="")
    granted_at = Column(String, default="")                   # ISO
    expires_at = Column(String, default="")                   # ISO


class VaultAccessLog(Base):
    """Vault audit trail - every reveal/copy/create/edit/remove/share/deny."""
    __tablename__ = "vault_access_logs"
    id          = Column(String, primary_key=True)
    actor_email = Column(String, default="", index=True)
    actor_name  = Column(String, default="")
    action      = Column(String, default="")                  # Revealed|Copied|Created|Edited|Removed|Recovered|Imported|Requested|Shared|Denied
    cred_id     = Column(String, default="")
    cred_name   = Column(String, default="")
    dept        = Column(String, default="")
    detail      = Column(JSON, nullable=True)                 # [{field,from,to}] for edits
    loc         = Column(String, default="")
    created_at  = Column(String, default="", index=True)


class VaultOtpChallenge(Base):
    """A pending SMS/Email one-time code (CredVault-specific, not the Entra
    step-up module). Used both to gate company-vault reveal/share actions and
    to verify a Personal Vault password reset. `target` is the phone/email the
    code was actually sent to, kept for audit - the API only ever returns a
    masked version of it."""
    __tablename__ = "vault_otp_challenges"
    id          = Column(String, primary_key=True)
    email       = Column(String, default="", index=True)
    purpose     = Column(String, default="")   # reveal_share | personal_reset
    channel     = Column(String, default="")   # sms | email
    target      = Column(String, default="")
    code_hash   = Column(String, default="")
    attempts    = Column(Integer, default=0)
    consumed_at = Column(String, default="")
    expires_at  = Column(String, default="", index=True)
    created_at  = Column(String, default="")


class VaultOtpSession(Base):
    """Short-lived proof of a verified SMS/Email OTP - CredVault's own
    replacement for step-up MFA on company credential reveal/share (personal
    vault unlock uses VaultPersonalUnlockSession instead, see below)."""
    __tablename__ = "vault_otp_sessions"
    id         = Column(String, primary_key=True)
    email      = Column(String, default="", index=True)
    purpose    = Column(String, default="")
    channel    = Column(String, default="")
    expires_at = Column(String, default="", index=True)
    created_at = Column(String, default="")


class VaultPersonalAuth(Base):
    """Per-user password that unlocks the Personal Vault. Salted PBKDF2 hash
    ("salt_hex$hash_hex") - the plaintext is never stored. Reset requires a
    verified VaultOtpChallenge(purpose='personal_reset')."""
    __tablename__ = "vault_personal_auth"
    email         = Column(String, primary_key=True)
    password_hash = Column(String, default="")
    updated_at    = Column(String, default="")


class VaultPersonalUnlockSession(Base):
    """Short-lived proof the Personal Vault password was entered correctly -
    gates the personal-vault reveal endpoint."""
    __tablename__ = "vault_personal_unlock_sessions"
    id         = Column(String, primary_key=True)
    email      = Column(String, default="", index=True)
    expires_at = Column(String, default="", index=True)
    created_at = Column(String, default="")


class StepUpSession(Base):
    """A short-lived proof that the user completed a FRESH Entra MFA (step-up)
    for the sensitive-data action they're about to take. Created by
    /stepup/verify after validating an Entra access token that carries the
    configured authentication-context claim (acrs); consumed by the
    require_stepup dependency guarding vault reveals + payroll + confidential HR.
    One session unlocks a short burst so users aren't re-prompted per item.
    The row IS the audit trail (who stepped up, when, how, from where)."""
    __tablename__ = "stepup_sessions"
    id          = Column(String, primary_key=True)            # uuid
    email       = Column(String, default="", index=True)
    method      = Column(String, default="")                  # authenticator|sms|mfa|dev - from the token's amr, best-effort
    acr         = Column(String, default="")                  # the authentication-context value satisfied (e.g. c1)
    granted_at  = Column(String, default="")
    expires_at  = Column(String, default="", index=True)
    ip          = Column(String, default="")
    user_agent  = Column(String, default="")


class ActAsSession(Base):
    """A live 'Act As' impersonation (Jul 2026) - a Manager/IT Admin/Global Admin
    working as another, always lower-role, employee so they see and can do
    exactly what that employee can. auth.get_current_user layers the TARGET's
    identity on top of the real, Entra-verified caller for every downstream
    permission check, notification, and ownership field - see act_as.py for the
    full contract. audit.py independently decodes the raw bearer token, so the
    real actor is never lost from the audit trail even while this overlay is
    active. New table - create_all builds it, no migration line needed."""
    __tablename__ = "act_as_sessions"
    id           = Column(String, primary_key=True)            # uuid
    real_email   = Column(String, nullable=False, index=True)  # who is actually signed in
    target_email = Column(String, nullable=False)              # who they're acting as
    started_at   = Column(String, default="")
    expires_at   = Column(String, default="", index=True)
    ended_at     = Column(String, default="")                  # set by /act-as/stop
    ip           = Column(String, default="")
    user_agent   = Column(String, default="")


# ── Investor Relations (Jul 2026) ────────────────────────────────────────────
# GP-side capital-management platform for single-purpose-LLC deals and small
# syndications (not blind-pool PE funds): one deal per property/project, a
# small member roster, commitments, capital calls, distributions, computed
# capital accounts, a document data room, and an investor-updates feed. Rows
# relate by string ids only (no ORM relationships), matching the rest of this
# file. "Fund" below is the internal/DB name for a deal - kept for schema
# stability; UI copy calls it "Deal".

class IrFund(Base):
    __tablename__ = "ir_funds"
    id                    = Column(String, primary_key=True)
    name                  = Column(String, nullable=False)
    entity_name           = Column(String, default="")   # the single-purpose LLC's legal name
    strategy              = Column(String, default="")
    property_name         = Column(String, default="")   # free text - deliberately NOT a FK into the separate Asset Management module
    # Optional soft link to Asset Management's PropertyAsset.id (Ankush's
    # module - property_assets.py/PropertyAsset.jsx) for a "view this
    # property's operational record" cross-reference. Deliberately just an id
    # string, not a FK: the two modules stay independent, and a stale/deleted
    # property id just makes the link disappear rather than erroring anything.
    property_asset_id     = Column(String, default="")
    status                = Column(String, default="raising")  # raising|active|exited
    target_raise          = Column(Float, default=0)
    minimum_investment    = Column(Float, default=0)
    preferred_return_pct  = Column(Float, default=8.0)
    gp_promote_pct        = Column(Float, default=20.0)
    target_irr_pct        = Column(Float, default=0)
    target_multiple       = Column(Float, default=0)
    hold_period_years     = Column(Float, default=0)
    inception_date        = Column(String, default="")   # ISO yyyy-mm-dd
    close_date            = Column(String, default="")
    exit_date             = Column(String, default="")
    fund_manager_email    = Column(String, default="")
    description           = Column(String, default="")
    thesis                = Column(String, default="")
    created_by            = Column(String, default="")
    created_at            = Column(String, default="")
    updated_at            = Column(String, default="")


class IrInvestor(Base):
    __tablename__ = "ir_investors"
    id                        = Column(String, primary_key=True)
    display_name              = Column(String, nullable=False)
    entity_type                = Column(String, default="individual")  # individual|llc|trust|ira|corporation|partnership
    email                      = Column(String, default="", index=True)
    phone                      = Column(String, default="")
    address                    = Column(String, default="")
    accredited_status          = Column(String, default="unverified")  # unverified|self_certified|verified
    kyc_status                 = Column(String, default="pending")     # pending|in_review|cleared|flagged
    tax_id_on_file             = Column(Boolean, default=False)
    relationship_owner_email   = Column(String, default="")
    notes                      = Column(String, default="")
    status                     = Column(String, default="active")      # active|inactive|prospect
    created_by                 = Column(String, default="")
    created_at                 = Column(String, default="")
    updated_at                 = Column(String, default="")


class IrCommitment(Base):
    __tablename__ = "ir_commitments"
    id                 = Column(String, primary_key=True)
    fund_id            = Column(String, nullable=False, index=True)
    investor_id        = Column(String, nullable=False, index=True)
    commitment_amount  = Column(Float, default=0)
    units              = Column(Float, default=0)
    subscription_date  = Column(String, default="")
    status             = Column(String, default="pending")   # pending|active|closed|withdrawn
    signed_doc_url     = Column(String, default="")
    signed_doc_name    = Column(String, default="")
    created_by         = Column(String, default="")
    created_at         = Column(String, default="")
    updated_at         = Column(String, default="")


class IrCapitalCall(Base):
    __tablename__ = "ir_capital_calls"
    id            = Column(String, primary_key=True)
    fund_id       = Column(String, nullable=False, index=True)
    call_number   = Column(Integer, default=1)
    title         = Column(String, default="")
    purpose       = Column(String, default="")
    total_amount  = Column(Float, default=0)
    notice_date   = Column(String, default="")
    due_date      = Column(String, default="")
    status        = Column(String, default="draft")  # draft|issued|closed
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")


class IrCapitalCallAllocation(Base):
    __tablename__ = "ir_capital_call_allocations"
    id            = Column(String, primary_key=True)
    call_id       = Column(String, nullable=False, index=True)
    fund_id       = Column(String, nullable=False, index=True)
    investor_id   = Column(String, nullable=False, index=True)
    commitment_id = Column(String, default="")
    amount        = Column(Float, default=0)
    status        = Column(String, default="pending")  # pending|paid|overdue|waived
    paid_date     = Column(String, default="")
    paid_amount   = Column(Float, default=0)


class IrDistribution(Base):
    __tablename__ = "ir_distributions"
    id                   = Column(String, primary_key=True)
    fund_id              = Column(String, nullable=False, index=True)
    distribution_number  = Column(Integer, default=1)
    title                = Column(String, default="")
    distribution_type    = Column(String, default="return_of_capital")  # return_of_capital|preferred_return|profit_split|mixed
    total_amount         = Column(Float, default=0)
    distribution_date    = Column(String, default="")
    status               = Column(String, default="draft")  # draft|issued|paid
    created_by           = Column(String, default="")
    created_at           = Column(String, default="")
    updated_at           = Column(String, default="")


class IrDistributionAllocation(Base):
    __tablename__ = "ir_distribution_allocations"
    id              = Column(String, primary_key=True)
    distribution_id = Column(String, nullable=False, index=True)
    fund_id         = Column(String, nullable=False, index=True)
    investor_id     = Column(String, nullable=False, index=True)
    commitment_id   = Column(String, default="")
    amount          = Column(Float, default=0)
    status          = Column(String, default="pending")  # pending|paid
    paid_date       = Column(String, default="")


class IrDocument(Base):
    __tablename__ = "ir_documents"
    id            = Column(String, primary_key=True)
    fund_id       = Column(String, default="", index=True)   # '' = platform-wide
    investor_id   = Column(String, default="", index=True)   # '' = fund-wide, visible to all of that fund's investors
    category      = Column(String, default="other")  # subscription_agreement|k1|ppm|quarterly_report|capital_call_notice|distribution_notice|other
    title         = Column(String, nullable=False)
    file_url      = Column(String, default="")
    file_name     = Column(String, default="")
    uploaded_by   = Column(String, default="")
    created_at    = Column(String, default="")


class IrUpdate(Base):
    __tablename__ = "ir_updates"
    id          = Column(String, primary_key=True)
    fund_id     = Column(String, default="", index=True)  # '' = platform-wide update
    title       = Column(String, nullable=False)
    body        = Column(String, default="")
    pinned      = Column(Boolean, default=False)
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")


class PropertyWorkspaceMeta(Base):
    """Single-row (id=1) metadata for the Asset Management workspace blob: a
    SERVER-stamped epoch-ms timestamp of the last accepted PUT. Clients compare
    this against the last _ts they know to decide when to pull - server-stamped
    so client clock skew can never make a newer workspace look older."""
    __tablename__ = "property_workspace_meta"
    id         = Column(Integer, primary_key=True)   # always 1
    ts         = Column(BigInteger, default=0)       # epoch ms of last accepted workspace PUT
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")


class AsanaImportJob(Base):
    """One run of "Import All Projects", tracked in the DB rather than in memory.

    The import walks every project the token can see and takes far longer than
    Azure's ~230s request ceiling, which killed the old synchronous endpoint
    mid-run: the gateway returned a bodyless 499 and, having no CORS headers,
    the browser reported it as a CORS failure instead of a timeout.

    State lives here, not in the worker's memory, because dev runs 8 gunicorn
    processes - the request that starts a job and the requests that poll it are
    usually served by DIFFERENT workers, so anything in-process would be
    invisible to the polling. `heartbeat_at` is what lets a job whose worker was
    recycled mid-run be recognized as dead instead of blocking the next one
    forever."""
    __tablename__ = "asana_import_jobs"
    id           = Column(String, primary_key=True)
    status       = Column(String, default="running")   # running | done | error
    started_by   = Column(String, default="")
    started_at   = Column(String, default="")
    heartbeat_at = Column(String, default="")          # bumped after every project
    finished_at  = Column(String, default="")
    total        = Column(Integer, default=0)          # projects to do
    done         = Column(Integer, default=0)          # projects finished
    current      = Column(String, default="")          # project being imported now
    result       = Column(JSON, default=dict)          # the counts dict the UI already renders
    error        = Column(String, default="")
    # Cancel is a REQUEST, not an act: the worker is mid-project on another
    # thread (another process, on dev) and killing it there would leave that
    # project half-imported. The loop checks this between projects and stops
    # cleanly. Import is additive, so a partial run is safe to resume.
    cancel_requested = Column(Boolean, default=False)
    # Resume state. `done_gids` are the Asana projects this run has finished, so
    # a restart skips straight to the remainder instead of re-walking all 109
    # from the top. `attempts` counts how many times the run has been picked up
    # again, and stops a project that reliably kills its worker from restarting
    # the same import forever.
    done_gids    = Column(JSON, default=list)
    attempts     = Column(Integer, default=1)

class TaskInboundEmail(Base):
    """One message the task mailbox handed us, and what became of it (Task
    Inbound Email, Aug 2026 - the reply half of TaskEmailLog above).

    Written for EVERY message the drain looks at, not just the ones that became
    comments. A reply that resolved to no task, came from an address nobody
    recognises, or was an out-of-office is the case someone will ask about
    ("I replied and nothing happened"), and without a row the answer is a
    shrug - the message itself is already marked read and filed away.

    `internet_message_id` is unique and is the idempotency guard: the drain
    marks a message read only after the comment is committed, so a crash in
    between means the next pass sees it again, and this constraint is what
    stops that from posting the comment twice."""
    __tablename__ = "task_inbound_email"
    id                  = Column(String, primary_key=True)
    internet_message_id = Column(String, default="", index=True, unique=True)
    graph_message_id    = Column(String, default="")
    conversation_id     = Column(String, default="")
    from_email          = Column(String, default="", index=True)
    subject             = Column(String, default="")
    task_id             = Column(String, default="", index=True)
    comment_id          = Column(String, default="")
    matched_by          = Column(String, default="")   # address | headers | conversation
    status              = Column(String, default="")   # posted | rejected | ignored | failed
    # Why it was refused, or which of its files could not be filed - a posted
    # reply with a skipped attachment carries both a comment and a reason.
    reason              = Column(String, default="")
    attachment_count    = Column(Integer, default=0)   # files actually filed (see task_inbound)
    received_at         = Column(String, default="")
    processed_at        = Column(String, default="")



class ServerSession(Base):
    """Backend-For-Frontend login session. The browser holds ONLY the opaque id
    (in an HttpOnly cookie); the Entra tokens live HERE, Fernet-encrypted at rest
    (secret_box / NEXUS_VAULT_KEY). get_current_user resolves identity from this
    when a session cookie is present, and falls back to the Bearer path otherwise
    (dual-mode migration - see docs/BFF-Migration-Plan.md and bff_session.py).
    RLS-enabled: the backend reaches it via the privileged DATABASE_URL; the anon
    key must never touch it."""
    __tablename__ = "server_sessions"
    id                = Column(String, primary_key=True)    # opaque session id = the cookie value
    user_email        = Column(String, nullable=False, index=True)
    csrf_token        = Column(String, default="")          # double-submit CSRF secret
    access_token_enc  = Column(String, default="")          # Fernet ciphertext
    refresh_token_enc = Column(String, default="")          # Fernet ciphertext
    id_token_enc      = Column(String, default="")          # Fernet ciphertext
    access_expires_at = Column(Float, default=0.0)          # epoch seconds; drives server-side refresh
    auth_time         = Column(Float, default=0.0)          # last interactive auth (step-up freshness)
    created_at        = Column(String, default="")
    last_seen         = Column(String, default="")


class M365SyncRun(Base):
    """One two-way M365 sync execution: pull the directory into Nexus, then push
    every linked profile back to Entra. The whole thing runs as a background
    task (a few minutes for ~180 Graph calls - far past any request timeout),
    so this row is how the UI follows progress and how a finished run reports
    its outcome. RLS must be enabled on dev+prod like every new table."""
    __tablename__ = "m365_sync_runs"
    id           = Column(String, primary_key=True)   # uuid
    started_by   = Column(String, default="")
    started_at   = Column(String, default="")
    finished_at  = Column(String, default="")
    phase        = Column(String, default="pull")     # pull | push | done | failed
    total        = Column(Integer, default=0)         # people in the push phase
    done         = Column(Integer, default=0)
    pushed_ok    = Column(Integer, default=0)
    push_failed  = Column(Integer, default=0)
    pull_summary = Column(String, default="")         # JSON dict from the pull phase
    errors       = Column(String, default="")         # JSON [{email, error}], capped


# Construction Module (Aug 2026) - jobsite daily logs, media, AI pipeline,
# weekly reports. Defined in its own module (it shares nothing with the tables
# above and models.py is long enough); imported here so its tables register on
# the same Base and create_all picks them up on startup.
from construction_models import (  # noqa: E402,F401  (import for side effect: table registration)
    ConstructionProject, ConstructionDailyLog, ConstructionMedia, ConstructionAIJob,
    ConstructionWeeklyReport, ConstructionMilestone, ConstructionRfi,
    ConstructionSubmittal, ConstructionActivity,
)


class EgnyteWiring(Base):
    """One row = one Egnyte "wiring": a named slot (a Nexus surface that reads
    or writes Egnyte) bound to a folder path or path template. Edited from the
    Egnyte module's Wiring tab (manager+), so re-pointing a surface is a UI act,
    not a deploy or an env-var change (Neil, Aug 6 call - "give you that wiring"
    must not mean "ask Visesh").

    scope_id = '' is the slot's default/template row; a non-empty scope_id (a
    person's work email, a property site name) overrides the template for that
    one record, and an exact override always wins. Templates may carry
    {entity} {bucket} {person} {email} {property} placeholders - resolution and
    the registry of known slots live in egnyte_wiring.py. No row at all means
    the slot falls back to its legacy env var / hardcoded default, so an empty
    table changes nothing."""
    __tablename__ = "egnyte_wirings"
    id         = Column(String, primary_key=True)
    slot       = Column(String, nullable=False, index=True)
    scope_id   = Column(String, default="")
    path       = Column(String, nullable=False)
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")
    __table_args__ = (UniqueConstraint("slot", "scope_id", name="ux_egnyte_wiring_slot_scope"),)


class EgnyteFolderGroup(Base):
    """A rule-based Egnyte wiring for a COHORT of people (Visesh, Aug 10:
    "create me a folder group for people who are working from the US and have
    biweekly salary" - no per-person clicking). `rule` is a list of
    {field, value} conditions, ANDed, over egnyte_wiring.RULE_FIELDS; `prompt`
    keeps the plain-English ask it was parsed from (by the Claude API) so the
    card can show intent, not JSON. `path` is the group's PARENT folder in
    Egnyte - each matching person resolves to <path>/<their name> inside it,
    current and future matches alike (membership is evaluated at resolution
    time, never materialized). Beats the template and loses to a per-person
    override; first enabled group (newest first) wins when several match."""
    __tablename__ = "egnyte_folder_groups"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    prompt     = Column(String, default="")
    rule       = Column(JSON, default=list)
    path       = Column(String, nullable=False)
    enabled    = Column(Integer, default=1)
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")


class EgnyteUserToken(Base):
    """One Nexus user's own Egnyte OAuth grant (Aug 10: "anybody in here would
    only be able to see what they actually have access to in Egnyte"). When a
    person has connected, every Egnyte browse/read/search/write they make runs
    on THEIR token, so Egnyte's own folder permissions decide what they see -
    Nexus holds no permission logic to drift. Tokens are Fernet-encrypted at
    rest (secret_box, NEXUS_VAULT_KEY). Egnyte access tokens are long-lived
    (no refresh token); a revoked one surfaces as a 401 and the user
    reconnects. See egnyte_oauth.py."""
    __tablename__ = "egnyte_user_tokens"
    id               = Column(String, primary_key=True)
    email            = Column(String, nullable=False, unique=True)
    access_token_enc = Column(String, default="")
    egnyte_username  = Column(String, default="")
    egnyte_name      = Column(String, default="")
    last_error       = Column(String, default="")
    last_error_at    = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")


class EgnyteOAuthState(Base):
    """Single-use state rows binding an Egnyte OAuth callback to the Nexus user
    who started it - same shape and reasoning as AsanaOAuthState."""
    __tablename__ = "egnyte_oauth_states"
    id         = Column(String, primary_key=True)
    email      = Column(String, nullable=False)
    created_at = Column(String, default="")


class NexusDailyBriefingLog(Base):
    """One row per employee per (employee-local) calendar day a daily briefing
    was generated - the dedupe check AND the 'since last briefing' cursor for
    daily_briefing.py. New table - create_all builds it, no migration line
    needed (see NexusSetting's docstring for the same convention)."""
    __tablename__ = "nexus_daily_briefing_log"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, index=True, nullable=False)
    briefing_date  = Column(String, index=True, nullable=False)  # employee-local YYYY-MM-DD
    sent_at        = Column(String, default="")          # UTC iso; '' if mode=off (scan ran, nothing mailed)
    mode           = Column(String, default="test")      # off|test|live - which config this run used
    red_count      = Column(Integer, default=0)
    amber_count    = Column(Integer, default=0)
    green_count    = Column(Integer, default=0)
    blue_count     = Column(Integer, default=0)
    created_at     = Column(String, default="")
