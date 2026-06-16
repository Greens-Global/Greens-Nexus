from sqlalchemy import Boolean, Column, Float, Integer, String
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
