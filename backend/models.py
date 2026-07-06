from sqlalchemy import Boolean, Column, Float, Integer, JSON, String
from database import Base


class Task(Base):
    __tablename__ = "tasks"
    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    assignee = Column(String, nullable=False)
    project = Column(String, nullable=False)
    due_date = Column(String, nullable=False)
    hours = Column(String, nullable=False)
    comment = Column(String, default="")
    priority = Column(String, nullable=False)
    status = Column(String, nullable=False)
    dept = Column(String, nullable=False)
    synced = Column(Boolean, default=True)


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
    category = Column(String, nullable=False)
    description = Column(String, default="")
    clicks = Column(Integer, default=0)


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
    """Master stock record for a requestable inventory item.
    available_qty is the live source of truth — decremented atomically when a
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
    picture_required  = Column(Boolean, default=True)  # False = photos optional in every flow (e.g. keys) — Neil, Jun 2026
    asset_value       = Column(Float, default=0.0)     # USD value: accountability + per-person holdings total
    op_status         = Column(String, default="")     # operational status (Neil): deployed|in_storage|in_repair|needs_replacement|retired|lost; '' = unset. SEPARATE from lifecycle `status`
    op_status_person_email = Column(String, default="") # person an op_status is declared against (lost/retired) — they get the notification + show on "Who has it"
    op_status_person_name  = Column(String, default="")
    assigned_to_location = Column(String, default="")  # set when a permanent item is assigned to a PLACE not a person — kept OUT of "Who has it" (Ankush)
    custom_fields     = Column(JSON, default=dict)     # {field_key: value} for admin-defined custom fields — see ItemCustomField
    deleted_at        = Column(String, default="")     # ISO ts; non-empty = soft-deleted (excluded from normal lists, restorable — Ankush)
    deleted_by        = Column(String, default="")     # email of whoever deleted it
    deleted_location  = Column(String, default="")     # item's location captured at deletion — Ankush's "Deleted In"


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
    approver_email           = Column(String, default="")   # manager picked at checkout — only they get the approval notification
    approver_name            = Column(String, default="")


class ItemCartEntry(Base):
    """Persisted cart entry — one row per (user, item). Survives logout and device switches."""
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


class NexusGroup(Base):
    __tablename__ = "nexus_groups"
    id              = Column(String, primary_key=True)
    name            = Column(String, nullable=False)
    department      = Column(String, default="")
    allowed_modules = Column(String, default="")   # comma-separated "moduleId:level" pairs, e.g. "it:viewer,inventory:full" — level ∈ viewer/editor/full/owner (see auth.MODULE_LEVELS)
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")


class NexusGroupMember(Base):
    __tablename__ = "nexus_group_members"
    group_id = Column(String, primary_key=True)
    email    = Column(String, primary_key=True)
    added_by = Column(String, default="")
    added_at = Column(String, default="")


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
    of truth a person's working life hangs off — candidates, provisioning,
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
    department      = Column(String, default="")
    employment_type = Column(String, default="full_time")      # full_time | part_time | contractor | intern
    start_date      = Column(String, default="")               # ISO date
    manager_email   = Column(String, default="")               # reporting line -> org chart (Phase 5)
    photo_url       = Column(String, default="")
    status          = Column(String, default="active")         # onboarding | active | inactive | offboarded
    location        = Column(String, default="")
    company         = Column(String, default="")               # HrEntity.id — which legal entity employs this worker
    contractor      = Column(JSON, default=dict)               # contractor-only fields (scope/SOW/dates/rate/client) — HR Section A
    personal        = Column(JSON, default=dict)               # emergency contact, addresses, DOB, masked IDs — HR Section B
    compensation    = Column(JSON, default=dict)               # base/basis/frequency/currency + history — RESTRICTED (hr_comp grant)
    bank            = Column(JSON, default=list)               # list of bank accounts — RESTRICTED (hr_comp grant)
    compliance      = Column(JSON, default=dict)               # right-to-work / visa / verification — HR Section B
    status_log      = Column(JSON, default=list)               # [{from,to,reason,effectiveDate,by,at}] — HR Section B6
    notes           = Column(String, default="")
    m365_id         = Column(String, default="")               # account pointers for provisioning (Phase 4)
    asana_id        = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")


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
    source         = Column(String, default="")               # referral, LinkedIn, ...
    resume_url     = Column(String, default="")
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
    """Per-employee documents (HR Phase 3) — stored in the PRIVATE hr-docs
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
    strings untouched — they just stop being pickable, like a removed custom field."""
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
    approved docs can later be archived. New table — create_all builds it, no
    migration line needed."""
    __tablename__ = "kb_documents"
    id               = Column(String, primary_key=True)        # uuid
    doc_code         = Column(String, default="")              # e.g. OPS-014, auto-assigned per department
    title            = Column(String, nullable=False)
    doc_type         = Column(String, default="SOP")           # SOP | Manual | Guide
    departments      = Column(String, default="")              # comma-separated department names ("" = unassigned)
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
    retention_months = Column(Integer, default=84)            # records-retention window
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")


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
    overview    = Column(String, default="")           # "what you'll learn" — JSON list of objective strings
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
    """A course assigned to a specific person, optionally with a due date —
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
    """A learner's quiz attempt on a course — the back-end record of how they
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
# Asset Management (property portfolio) — Ankush's module.
# The UI data is semi-structured: each property has a wide set of header fields
# PLUS free-form snapshot / timeline / permit "sheets", and a handful of flat
# child collections (warranties, inspections, documents, utilities, AHJ,
# vendors) keyed by property. Rather than 50+ columns and 6 near-identical
# tables, the full objects live in JSON `payload` columns with a few fields
# promoted for listing/queries. The module loads/saves the whole workspace as
# one blob — see routers/property_assets.py. create_all builds these on startup.
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
    """A child row under a property — generic across the flat collections so the
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


class HrWorkSite(Base):
    """A physical work site (HR Section A) — used later for geofenced time-clock
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


# ── E-Sign (HR Section C) — native signatures with legal-grade audit trail ────
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
    roles       = Column(JSON, default=list)         # [{key,label,order}] — signing order
    attachments = Column(JSON, default=list)         # [{name, path, pages, fields:[{id,role,type,page,x,y,w,h}]}] — PDFs signed as one packet
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
    token                = Column(String, default="")         # secrets.token_urlsafe(32) — the public-link credential
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
    """Immutable audit trail — one row per action on an envelope."""
    __tablename__ = "hr_sign_events"
    id          = Column(String, primary_key=True)   # uuid
    request_id  = Column(String, nullable=False)
    party_id    = Column(String, default="")
    type        = Column(String, default="")         # created|sent|viewed|consented|signed|declined|reminded|voided|completed|downloaded
    detail      = Column(String, default="")
    ip          = Column(String, default="")
    user_agent  = Column(String, default="")
    at          = Column(String, default="")


# ── Time tracking (SwipeClock replacement) ────────────────────────────────────
# Punch-event model: every clock action is one immutable row; shifts/totals are
# derived. Geofencing is a SOFT gate (research-verified SwipeClock behavior):
# out-of-fence punches are recorded and flagged, never blocked. Corrections
# never overwrite silently — original_at freezes the first value, voided rows
# stay in the table (wage-and-hour record retention).

class TimePunch(Base):
    __tablename__ = "time_punches"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    kind           = Column(String, nullable=False)     # in|out|break_start|break_end
    at             = Column(String, nullable=False)     # UTC ISO — effective time (adjustments edit this)
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
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")


class TimeScreenshot(Base):
    """Work-session screen captures (consent-based getDisplayMedia — the browser
    shows a persistent sharing indicator the whole time; nothing is covert).
    One row per captured frame, image in the private hr-docs bucket."""
    __tablename__ = "time_screenshots"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    at             = Column(String, nullable=False)     # UTC ISO
    local_date     = Column(String, default="")
    storage_path   = Column(String, default="")         # hr-docs path
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


class TimeBod(Base):
    """Beginning/End-of-day message: on the first punch-in (bod) or a punch-out
    (eod) the employee posts to a Teams channel (sent client-side AS THE USER
    via delegated Graph); this row is the recorded copy."""
    __tablename__ = "time_bod"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    kind           = Column(String, default="bod")      # bod | eod
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


class AgentDevice(Base):
    """A desktop-agent enrollment. Silent (no-login) model: an admin mints a
    token tied to an employee, the install command drops it on the machine, and
    the agent authenticates with it (X-Agent-Token) — no Microsoft sign-in. Each
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
    """One shift placed on a specific employee for a specific calendar date —
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
    """A reusable set of employees — used to bulk-assign shifts AND to bind the
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
    per employee (history is not kept here — corrections just overwrite)."""
    __tablename__ = "payroll_rates"
    employee_email = Column(String, primary_key=True)
    hourly_rate    = Column(Float, default=0)
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")


class AgentActivity(Base):
    """App/window activity reported by a silent device: per reporting window,
    seconds spent in each foreground app + an activity % (share of samples where
    the machine wasn't idle). Powers the app-usage breakdown + activity score."""
    __tablename__ = "agent_activity"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, nullable=False, index=True)
    local_date     = Column(String, default="", index=True)
    at             = Column(String, default="")
    app            = Column(String, default="")
    title          = Column(String, default="")
    seconds        = Column(Integer, default=0)
    active_pct     = Column(Integer, default=0)


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
