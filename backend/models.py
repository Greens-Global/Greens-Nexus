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
    total_qty     = Column(Integer, default=0)
    available_qty = Column(Integer, default=0)
    last_updated  = Column(String, default="")


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
    allowed_modules = Column(String, default="")   # comma-separated module IDs, e.g. "it,inventory,admin"
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
