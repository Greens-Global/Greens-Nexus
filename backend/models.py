from sqlalchemy import BigInteger, Boolean, Column, Float, Integer, JSON, LargeBinary, String, Text, UniqueConstraint, Index
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
    # A task can be assigned to SEVERAL people (Sagar, Aug 2026). There is one
    # task row and one `completed` flag, so whoever finishes it finishes it for
    # everyone - that was always true, and is why this is a list on the task
    # rather than a copy of the task per person.
    #
    # `assignee_emails` is the source of truth. `assignee_email` is kept as a
    # PRIMARY MIRROR of assignee_emails[0] - the same shape TaskTeam.project_id
    # already mirrors project_ids[0], and for the same reason: dozens of call
    # sites (exports, dashboards, the daily briefing, the Asana sync) read the
    # single column, and every one keeps working against the primary instead of
    # all having to be found and rewritten at once.
    #
    # Anything asking "is this person on this task" must go through
    # task_util.task_assignees(); every write must go through
    # task_util.set_task_assignees() so the two can never drift.
    assignee_email    = Column(String, default="", index=True)   # mirror of assignee_emails[0]
    assignee_emails   = Column(JSON, default=list)
    owner_email       = Column(String, default="", index=True)
    follower_emails   = Column(JSON, default=list)
    liked_by_emails   = Column(JSON, default=list)
    # Emoji reactions (Sep 2026 - "add emojis for tasks so we can react",
    # driven off the Daily Briefing's one-click mail actions). {emoji: [email,
    # ...]} - a dict rather than one liked_by_emails-style list per emoji so a
    # task with no reactions yet costs nothing extra to scan.
    reactions         = Column(JSON, default=dict)
    access_level      = Column(String, default="org")      # org|restricted
    # Multi-company walls (Aug 2026): the HrEntity company this task belongs to,
    # stamped from its creator at creation. The company wall (auth.company_scope
    # via task_util.wall_tasks) keeps a task out of every other company's lists.
    # Blank on legacy/sync rows - task_util.task_company then derives it from the
    # owner/creator's company so nothing falls through the wall untagged.
    company_id        = Column(String, default="", index=True)
    project_id        = Column(String, default="", index=True)  # primary - drives section/access/Asana sync
    project_ids       = Column(JSON, default=list)         # EXTRA projects, Nexus-only (never synced to Asana,
                                                             # which stays keyed on project_id alone) - lets a task
                                                             # show up under several projects without duplicating it
    section_id        = Column(String, default="")
    team_id           = Column(String, default="", index=True)  # TaskTeam within this task's project
    parent_task_id    = Column(String, default="", index=True)
    subtask_ids       = Column(JSON, default=list)
    # How this task's subtasks are ordered (Oct 13 2026): "" = by due date,
    # then priority; "manual" = the order someone dragged them into, read from
    # each subtask's `position`. Set by the drawer's drag handle.
    subtask_order     = Column(String, default="")
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
    # Soft delete (Aug 27), same pattern as NexusEmployee: empty = live, an ISO
    # timestamp = trashed. Hidden everywhere automatically (see the
    # do_orm_execute hook in database.py) rather than each call site
    # remembering to filter. Restorable via POST /tasks/{id}/restore for 90
    # days, after which trash_purge_loop (main.py) removes it for good.
    deleted_at        = Column(String, default="", index=True)
    # Set when this task was binned BECAUSE its project was, holding that
    # project's id. Restoring the project restores exactly this set, and the
    # Recycle Bin hides them: they are not independently restorable, and a
    # project plus its 200 tasks as 201 rows is not a list anyone can use.
    deleted_with      = Column(String, default="", index=True)
    deleted_by        = Column(String, default="")         # email of whoever deleted it
    # Due-date accountability (Neil, Sep 24) - maintained ONLY by task_due.py.
    # due_history is every move of due_on, oldest first:
    #   {at, from, to, by, source: app|bulk|asana|proposal, extension: bool}
    # due_extension_count is how many of those pushed an AGREED date later.
    # due_agreement: "" (legacy / set by the assignee = agreed) | "pending"
    # (the requester set a target the assignee has not confirmed) | "proposed"
    # (the assignee asked for due_proposal = {dueOn, by, at, note} instead) |
    # "accepted".
    due_extension_count = Column(Integer, default=0)
    due_history       = Column(JSON, default=list)
    due_agreement     = Column(String, default="")
    due_proposal      = Column(JSON, nullable=True)
    # Checklist counters (Oct 2026) - denormalized from task_checklist_items
    # by routers/tasks._recount_checklist so every list row and board card can
    # print "3/5" without a query per task. Never written anywhere else.
    checklist_total   = Column(Integer, default=0)
    checklist_done    = Column(Integer, default=0)
    # Time entries (Oct 2026, task_time_entries). While a task has entries,
    # actual_hours is their rolled-up total (routers/tasks._recount_time) and
    # cannot be typed over; with none, actual_hours stays the old free number.
    time_entry_count  = Column(Integer, default=0)
    # The ticket this task was created from, or linked to, on that ticket's
    # Tasks list (Oct 14 2026) - the task's way back to it ("From Ticket").
    # Kept in step with TaskTicket.task_ids by routers/tickets.py, server-side
    # only; never taken from a task payload.
    source_ticket_id  = Column(String, default="", index=True)
    # An HR checklist's task - a step's subtask or the parent task over an
    # owner's steps (Oct 22 2026). Stamped by hr_checklists.sync_tasks, never
    # taken from a payload; the task list reads it to hide Move To, and Move
    # To refuses these (routers/tasks._is_hr_checklist_task).
    hr_checklist      = Column(Boolean, default=False)
    # What the task's board card shows under its title (Planner's "Show On
    # Card", Oct 22 2026): "" Automatic, "checklist", "description", "none"
    # or "image:<attachment id>" - one of this task's own image files. See
    # task_card_preview.py.
    card_preview      = Column(String, default="")
    # The task whose "make private" took this one private with it (Oct 22
    # 2026, routers/tasks._cascade_level): opening that task again opens this
    # one again - unless its level was set by hand since, which clears it.
    narrowed_by       = Column(String, default="")


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
    # Company filter (Aug 12). Legacy single-value column, same story as
    # category/department above - superseded by `companies` (Sep 22, Neil:
    # "that should be a checkbox for multiselect not a dropdown for single
    # select. Same links may apply to different companies"). [] = every
    # company, same convention as departments. Free-standing from department
    # on purpose: a link can be company-wide but department-specific (e.g.
    # Accounting at Greens India) or vice versa.
    company = Column(String, default="")
    companies = Column(JSON, default=list)
    # Which IT service area a ticket raised against this app belongs to
    # (Aug 2026 ticket intake). One place classifies an app - the same screen
    # where the app is added - and a ticket copies the value at intake.
    # A key from SERVICE_AREA_KEYS below; "" reads as "general".
    service_area = Column(String, default="")


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
    company_id = Column(String, default="", index=True)   # multi-company walls: requester's HrEntity
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
    # Multi-company walls: the company this notification belongs to (its
    # originator's HrEntity). A manager broadcast (recipient='') is shown only to
    # managers in this company once the walls are armed; '' = org-wide (legacy) =
    # Global-Admin-only when armed. Stamped by _notify / create_notification.
    company     = Column(String, default="", index=True)
    created_at  = Column(String, nullable=False)
    # Priority (Neil, call of 09/29): 1 = shown as a bar across the top of
    # every screen until acted on (a timecard due, a timesheet to review, a
    # punch fix waiting); 0 = the quiet bell. The system stamps it on those
    # flows; a manager can raise one by hand.
    priority    = Column(Integer, default=0)
    # Closed (Neil, 10/01): nothing is deleted when a person clears a
    # notification - it moves to the bell's Closed list (per person, like
    # read_by) and can be brought back. Every row is kept 30 days from
    # created_at, then the retention sweep removes it (notification_retention).
    closed_by   = Column(String, default="")


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
    # Multi-company walls: the HrEntity company that owns this item, stamped from
    # its creator. Walled per company once armed; '' (legacy/shared) is
    # Global-Admin-only when armed.
    company_id     = Column(String, default="", index=True)
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
    # Members of a group flagged bod_exempt=1 skip the Beginning/End-of-day and
    # break message prompts entirely - punches go straight through (Neil,
    # Aug 25: field workers "that cannot type" were blocked from clocking in by
    # the required BOD message). A person is exempt if ANY of their groups sets it.
    bod_exempt        = Column(Integer, default=0)
    # Members of a group flagged time_tracking_exempt=1 have no time clock and no
    # timesheet (salaried leadership; Visesh, Oct 2 - set in Settings > Access
    # beside the screen-share exemption). A person is exempt if ANY group sets it.
    time_tracking_exempt = Column(Integer, default=0)
    # Job roles only: the role's default manager/timesheet approver. Assigning the
    # role to someone with NO manager set copies this onto their People card -
    # per-person Manager stays the source of truth and can always be overridden.
    default_manager_email = Column(String, default="")
    # Multi-company walls (Aug 2026): a group tied to a company_id is a
    # COMPANY-SCOPED role - its capability applies within that company, and being
    # a member confines the person to it (auth.company_scope). '' = an org-wide
    # group (the pre-walls behavior). One person can hold several such groups to
    # carry a different role in each company.
    company_id      = Column(String, default="")   # HrEntity.id, or '' for org-wide
    # Members of a group flagged is_global_admin=1 are GLOBAL ADMINS: unrestricted
    # across every company - the only role that sees past the company walls.
    is_global_admin = Column(Integer, default=0)
    # Job roles: where its people's BOD / EOD / break messages post in Microsoft
    # Teams (Neil, 10/07: "it should be based on a role" - set once in Access,
    # not person by person, and not in a Shifts setting). A group chat
    # (bod_chat_id) or a channel (bod_chat_id = channel, bod_team_* its team).
    # Wins over a shift group's binding, which stays as the fallback.
    bod_target      = Column(String, default="chat")   # chat | channel
    bod_chat_id     = Column(String, default="")
    bod_chat_name   = Column(String, default="")
    # Job roles: '' = made in Settings > Access; 'hiring' = made from Add
    # Candidate's "Other" (Neil, Oct 12). A hiring-born role with no hiring
    # packet of its own is flagged on Hiring > Packets until one is added.
    created_from    = Column(String, default="")
    bod_team_id     = Column(String, default="")
    bod_team_name   = Column(String, default="")
    # The role fills itself into the hiring paperwork (Neil, Oct 22: "the role
    # gets filled into the hiring packet... the only thing that changes is a
    # different confidentiality agreement and a different job description
    # based on roles"). job_description is the duties text a white-label Job
    # Description document prints as {{role_description}}; hiring_docs are the
    # role's own documents, each added to - or replacing one of - whatever
    # packet the hire gets: [{templateId, replaces}] ('' = added).
    job_description = Column(Text, default="")
    hiring_docs     = Column(JSON, default=list)
    # Versions of the duties (Hiring Setup, Oct 23 2026): job_description is
    # the Standard; each version is for a kind of hire, a place and/or one
    # company - [{id, hiredAs, country, region, entityId, text, createdBy,
    # createdAt, updatedAt, archivedAt}]. hiring_setup.resolve_duties picks one.
    duty_versions   = Column(JSON, default=list)


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
    timestamp     = Column(String, nullable=False, index=True)
    user_email    = Column(String, nullable=False)
    user_role     = Column(String, default="")
    action        = Column(String, nullable=False)
    resource_type = Column(String, default="", index=True)
    resource_id   = Column(String, default="")
    details       = Column(String, default="")   # JSON string
    ip_address    = Column(String, default="")
    undone_at     = Column(String, default="")    # set when this change was reverted via the audit-log Undo
    undone_by     = Column(String, default="")    # email of whoever undid it
    # Unified audit log (Oct 20 2026, audit_capture.py / routers/audit_events.py).
    # request_id joins the field-level rows in audit_changes; module / kind /
    # acting_as are filled for new rows so the feed can filter on them with an
    # index instead of re-deriving them per row ('' on rows from before).
    request_id    = Column(String, default=lambda: _audit_request_id())
    module        = Column(String, default="")
    kind          = Column(String, default="")    # create|update|delete|comment|login|denied|view|other
    acting_as     = Column(String, default="")    # the Act As target, '' when not acting


class NexusEmployee(Base):
    """HR employee master record (Phase 1 of the HR module). The single source
    of truth a person's working life hangs off - candidates, provisioning,
    leave and the org chart all reference this row in later phases."""
    __tablename__ = "nexus_employees"
    id              = Column(String, primary_key=True)         # uuid
    employee_code   = Column(String, default="")               # GG-001 style, auto-assigned
    first_name      = Column(String, nullable=False)
    last_name       = Column(String, default="")
    work_email      = Column(String, default="", index=True)   # empty until provisioned (Phase 4)
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
    location        = Column(String, default="")               # free-text office/site description, e.g. "Escondido office"
    # ISO 3166-1 alpha-2, e.g. "IN"/"US" (Sep 19, Pranshu: "phone number in
    # sign should be pulled from HR directory not from company setup" - a
    # company's own registered country doesn't always match where a given
    # employee actually is). Structured (a <select>, not free text like
    # `location` above) so it can drive a real dial-code lookup.
    country         = Column(String, default="")
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
    # Per-person geofence (Aug 25): a work location + radius assigned to THIS
    # person, distinct from the shared HrWorkSite fences. When set (radius > 0),
    # their punches are judged against this instead of the nearest work site -
    # for home-based / field / single-location staff. Set from the People
    # profile: "use last punch location" (reads their most recent located
    # punch) or an address search (geocoded). '' lat/lng or radius 0 = unset.
    geofence_lat      = Column(String, default="")
    geofence_lng      = Column(String, default="")
    geofence_radius_m = Column(Integer, default=0)             # 0 = no personal geofence (fall back to work sites)
    geofence_label    = Column(String, default="")            # human label (address, or "From last punch MM/DD")
    # Leave policy (Oct 19 2026, leave_balances.py): '' = the default for the
    # person's country / California rule; else a policy id HR picked.
    leave_policy      = Column(String, default="")
    geofence_source   = Column(String, default="")            # last_punch | address | manual
    geofence_set_by   = Column(String, default="")
    geofence_set_at   = Column(String, default="")
    # Remote (Neil, Sep 19): a person is EITHER remote - may punch from anywhere,
    # it is a contractual arrangement, not a place - OR must be at ANY company
    # work site. Replaces the per-person geofence above, which judged someone
    # against one assigned location ("We're not tagging them to a specific
    # location. We're tagging them to our locations."). The geofence_* columns
    # stay for history; nothing judges a punch against them anymore.
    work_remote       = Column(Integer, default=0)
    # Optional assigned work site (Visesh, Sep 25): '' = may punch from ANY
    # company work site (the default for everyone); an HrWorkSite.id = punches
    # are judged against that one site's fence only.
    work_site_id      = Column(String, default="")
    # Allowed work sites (Charmi, Sep 29): JSON list of HrWorkSite ids the
    # person may punch at - ANY of them is on-site. '' = every company site.
    # Supersedes work_site_id, which is still read as a one-site list.
    work_site_ids     = Column(String, default="")
    # Email signature overrides (Sep 16, Neil): name/role/company email are NOT
    # editable here - they stay pulled live from the directory fields above so
    # the signature can't drift from who someone actually is ("keeps everybody
    # honest"). Only these are self-service; empty = fall back to
    # display_name/first+last and phone respectively.
    signature_display_name = Column(String, default="")        # preferred name shown on signature, e.g. "Sahil" -> "Sam"
    signature_phone         = Column(String, default="")       # override for signature only (e.g. desk line instead of cell)
    signature_template      = Column(String, default="classic") # which visual layout this employee picked (myhr.SIGNATURE_TEMPLATES)
    # Sign-off is personal now (Sep 19, Pranshu: "Admin should not have the
    # control of Sign off... it should be employee specific") - was company-
    # wide (HrEntity.signature_closing, below); this column already existed
    # but sat unused since Sep 16. Free text, not just a preset pick - an
    # employee can type their own closing line entirely.
    signature_closing       = Column(String, default="")        # this employee's own sign-off line, e.g. "Sincerely" - '' = template default
    # Personal LinkedIn for the signature's icon row (Sep 19) - was pulled from
    # the COMPANY's LinkedIn (HrEntity.linkedin_url, since removed from the
    # Company Setup form) but a person's LinkedIn profile is theirs, not their
    # employer's.
    linkedin_url             = Column(String, default="")
    # Personal signature logo override (Sep 19, Pranshu: "i want to have
    # employee the ability to upload the logo for their signature... rest
    # format of sign remain same") - '' falls back to the COMPANY's logo
    # (HrEntity.logo_url), same override-with-fallback pattern as
    # signature_phone/signature_display_name above. Only the logo IMAGE
    # changes; name/role/email/template/address/socials are untouched -
    # this isn't a second branding system, just one picture swapped out.
    signature_logo_url       = Column(String, default="")
    # Microsoft 365 contact info, kept in step both ways (Neil, 10/07: "we
    # should be able to select office, office phone, have all of these fields
    # inside Nexus and change it there and it updates [in M365]. Change it in
    # MS, it updates in Nexus"). phone = mobile, location = office, country =
    # ISO code (M365 holds the name). See m365_profile_sync.py.
    office_phone             = Column(String, default="")       # businessPhones[0]
    street_address           = Column(String, default="")       # the WORK street address M365 shows - not the home address in `personal`
    city                     = Column(String, default="")
    state                    = Column(String, default="")
    postal_code              = Column(String, default="")
    # {"base": {field: value as M365 last had it}, "at": ISO, "error": ""} - the
    # common ancestor of the three-way merge, so a change on either side is told
    # apart from the other side simply being different.
    m365_sync                = Column(JSON, default=dict)
    # Backup Manager (Neil, Oct 13): covers this person when their manager is
    # out, with the manager's rights over them. '' = the default - the
    # manager's manager, else the company's HR contact (backup_manager.py).
    backup_manager_email     = Column(String, default="")
    # Custom fields (Neil, Oct 27 2026): {field_key: value} for the fields HR
    # defines in Settings > People & Access (EmployeeCustomField). Never in
    # hr._serialize - hr_custom_fields.py filters HR Only values per caller.
    custom_fields            = Column(JSON, default=dict)
    # Probation (Neil, Oct 27 2026, hr_probation.py): status, start / end
    # dates, a per-person length, the manager's recommendation, the decision,
    # the letter and the history. {} = Not Tracked - existing people are never
    # backfilled; new hires get it automatically.
    probation                = Column(JSON, default=dict)


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
    stage          = Column(String, default="applied")        # applied|screening|interview|decision|offer|hired|rejected
    expected_start = Column(String, default="")               # ISO date
    interview_at   = Column(String, default="")               # ISO datetime of the next interview
    source         = Column(String, default="")               # referral, LinkedIn, ...
    company        = Column(String, default="")               # HrEntity.id hiring for ('' = untagged; company-scoped admins see only their companies' pipeline)
    role_id        = Column(String, default="")               # NexusGroup.id (job role) applied for; '' = "Other" (role_title is free text)
    resume_url     = Column(String, default="")               # hr-docs storage path (private; signed URL to view)
    notes          = Column(String, default="")
    employee_id    = Column(String, default="")               # set when hired
    # Neil, Oct 14: the interview is expected by this day - screening has to be
    # done one business day before it.
    expected_interview_on = Column(String, default="")        # ISO date
    # A rejected candidate leaves the board: Remove, or 90 days after the
    # rejection (Neil, Oct 14: "after 90 days it gets taken out and gets moved
    # to like inactive"). Reopen brings them back.
    rejected_at    = Column(String, default="")               # ISO datetime of the rejection
    inactive_at    = Column(String, default="")               # ISO datetime removed from the board
    # The "Screen <name>" task for the department head and up (Oct 14,
    # hiring_screening.py) - its due date follows the interview.
    screen_task_id = Column(String, default="")               # Task.id
    # The Decision step after the interview (Neil, Oct 19, hiring_decision.py):
    # the "Decide on <name>" task, and the department head's final call.
    decision_task_id = Column(String, default="")             # Task.id
    decision       = Column(String, default="")               # '' | hire | reject
    decision_by    = Column(String, default="")
    decision_at    = Column(String, default="")
    decision_note  = Column(String, default="")
    # Skip Interview (Neil, Oct 22): who moved them to Decision without one.
    interview_skipped_by = Column(String, default="")
    # Careers page (Oct 27 2026, hiring_openings.py): the job opening they
    # applied for (HrJobOpening.id, '' = none), what the public apply form
    # asks, when they consented, and their last careers-page application.
    opening_id     = Column(String, default="")
    location       = Column(String, default="")
    linkedin_url   = Column(String, default="")
    consent_at     = Column(String, default="")
    applied_at     = Column(String, default="")
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
    # Neil, Oct 14: one Notes section, "consolidated with time and date and
    # person who put it in" - a plain note is a row here too ('' = a stage move).
    kind         = Column(String, default="")               # '' (move) | note


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
    # Knowledge Base rebuild (Oct 2026, kb_*.py + routers/kb.py). Columns are
    # ADDED, never changed: `body` / `doc_type` / `version` / `revision_history`
    # stay exactly as the old module wrote them, so nothing is lost and the
    # migration report (kb_migrate.py) can always diff old against new.
    page_type        = Column(String, default="")              # how_to | sop | policy | reference ("" = not migrated yet)
    collection_id    = Column(String, default="", index=True)  # KbCollection.id
    summary          = Column(String, default="")              # one line under the title (search results, cards)
    blocks           = Column(Text, default="")                # the page as the one editor stores it: TipTap JSON (kb_blocks.py)
    major            = Column(Integer, default=0)              # version = f"{major}.{minor}"; 0.x = never published
    minor            = Column(Integer, default=0)
    published_at     = Column(String, default="")              # last time a version went live (ISO)
    audience         = Column(Text, default="")                # policies: who must sign (kb_audience.py JSON), "" = everyone
    signing          = Column(String, default="in_page")       # in_page | nexus_sign
    translations     = Column(Text, default="")                # JSON {lang: {title, blocks, version, at}} - version != current = outdated
    migrated_at      = Column(String, default="")              # set once by kb_migrate.apply; "" = still only the old body


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
    # Rebuild (Oct 2026): `lessons` / `quiz` are the LIVE version learners take;
    # edits go to `draft` until Publish copies them over and bumps `major`
    # (kb_course_versions keeps every published copy).
    major        = Column(Integer, default=0)          # 0 = never published
    draft        = Column(Text, default="")            # JSON {title, description, overview, est_minutes, lessons, quiz, recert_months, departments}
    published_at = Column(String, default="")
    published_by = Column(String, default="")


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
    course_major = Column(Integer, default=0)          # the course version this progress belongs to (a renewal starts over)
    unlock_rounds = Column(Integer, default=0)         # manager unlocks: tries allowed = max_tries * (1 + unlock_rounds)
    certificate_id = Column(String, default="")        # KbCertificate.id issued for this completion


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
    source      = Column(String, default="manual")    # manual | rule | plan | renewal (rebuild, Oct 2026)
    rule_id     = Column(String, default="")          # KbAssignmentRule.id that made it
    plan_id     = Column(String, default="")          # KbTrainingPlan.id it belongs to


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
    # Rebuild (Oct 2026): the quiz is drawn and graded on the server. An attempt
    # is opened with the questions it drew (and the order each one's options
    # were shown in), then graded once; `missed` on new rows holds
    # [{id, q, lesson_id, lesson_title}] - never the right answer.
    status       = Column(String, default="graded")   # open | graded
    course_major = Column(Integer, default=0)
    question_ids = Column(Text, default="")           # JSON [qid]
    option_order = Column(Text, default="")           # JSON {qid: [original option index per shown position]}
    answers      = Column(Text, default="")           # JSON {qid: [shown positions picked]}
    graded_at    = Column(String, default="")


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
# Asset Management (property portfolio) - Neil's module.
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
    region             = Column(String, default="")         # US state (CA, TX) - picks the hiring documents for the place
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
    # `manager_emails` is the source of truth (Neil, Sep 22: "there can only be
    # one? ... we need to update that setting where it can be multiple"; same
    # mirror shape as Task.assignee_email/assignee_emails). `manager_email`
    # stays a PRIMARY MIRROR of manager_emails[0] so anything still reading the
    # single column keeps working.
    manager_email      = Column(String, default="")
    manager_emails     = Column(JSON, default=list)
    # The company's HR contact (a Nexus person): signs every employee's
    # timesheet last and finalizes it for payroll (timesheet_review.py).
    hr_contact_email   = Column(String, default="")
    # Split from the old single `registered_address` (Neil, Sep 22: "add in
    # physical address, and then add in mailing address... two important
    # fields"). `registered_address` stays for old rows that predate the split -
    # _serialize_entity falls back to it when physical_address is blank -
    # rather than a migration silently dropping whatever was typed in there.
    physical_address   = Column(String, default="")
    mailing_address    = Column(String, default="")
    # Branding (Sep 16, Neil): company-wide fields the email signature builder
    # and other branded surfaces pull from - set once here, consistent everywhere.
    website            = Column(String, default="")
    main_phone         = Column(String, default="")
    # What main_phone actually is (Sep 18) - "phone" numbers store the dial
    # code baked into main_phone itself ("+1 7003313331"); fax/telephone
    # don't use a country-code picker, so main_phone is just the raw value.
    main_phone_type    = Column(String, default="phone")
    # Social links for the signature's icon row (Sep 16, Pranshu) - company-wide
    # like the rest of branding, not per-employee, so every signature carries the
    # same official company pages.
    facebook_url       = Column(String, default="")
    # linkedin_url here is VESTIGIAL (Sep 19) - LinkedIn moved to the employee
    # (NexusEmployee.linkedin_url, a person's profile is theirs, not their
    # employer's). Column kept rather than dropped so no existing data is
    # lost; nothing reads it anymore.
    linkedin_url       = Column(String, default="")
    twitter_url        = Column(String, default="")
    instagram_url      = Column(String, default="")
    # Signature template (Sep 16, Pranshu): an admin-picked, company-wide
    # default in Settings - not a per-employee choice (myhr.SIGNATURE_TEMPLATES).
    signature_template = Column(String, default="classic")
    # signature_closing here is ALSO VESTIGIAL (Sep 19) - sign-off moved to
    # the employee too (NexusEmployee.signature_closing): "Admin should not
    # have the control of Sign off... it should be employee specific."
    signature_closing  = Column(String, default="")
    # The authorized signatory as a Nexus person (Oct 14) - who signs when an
    # HR packet's flow says "Authorized Signatory". `signatory` above stays the
    # printed name/title a letter shows ({{signatory}}).
    signatory_email    = Column(String, default="")
    # Who receives a contractor's approved invoice by email (Pranshu, Oct 21
    # 2026): the payer's accounts contacts, no Nexus login needed. Lowercased,
    # deduped list of emails.
    invoice_recipients = Column(JSON, default=list)


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


class TicketDepartment(Base):
    """The Tickets module's SETTINGS for one of a company's global departments
    (HrDepartment) - not a department list of its own any more.

    History: split off HrDepartment as an independent copy on Sept 13 2026
    (Pranshu) so editing the ticket desk's list stopped changing People ->
    Companies. Neil rejected that on Oct 1 2026 ("the departments should come
    from global... It can't be that tasks have different departments and
    tickets have different"): the department list - names, adding, renaming,
    deleting - now lives ONLY in the company's global setup (HrDepartment),
    and this row, keyed by the SAME id, holds what is ticket-specific: whether
    the department is offered at intake (`enabled`), its escalation lead /
    backup, and the order the intake dropdown lists it in. `name` is a mirror
    of the global name, refreshed on every department read (routers/tickets.py
    _sync_ticket_departments) so older readers of this table still see the
    current name. Kept, never dropped: it is also the record of the ticket
    desk's settings from before the merge."""
    __tablename__ = "ticket_departments"
    id         = Column(String, primary_key=True)   # uuid
    company_id = Column(String, nullable=False)     # HrEntity.id this department belongs to
    name       = Column(String, nullable=False)     # display value, e.g. "Estimating"
    sort_order = Column(Integer, default=0)
    # Ticket triage: a ticket raised against this department is left unassigned and
    # the lead is notified to assign it to an employee. backup_email is notified
    # alongside the lead so leave/departures don't strand a department's intake.
    lead_email   = Column(String, default="")
    backup_email = Column(String, default="")
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    # Offered at ticket intake? (Neil, Oct 1 2026: "I don't want a construction
    # ticket.") Off hides it from the Submit a Ticket picker only - tickets
    # already filed against it keep showing its name.
    enabled    = Column(Boolean, default=True)
    # Default assignee (Oct 2026, ticket_auto_assign.py): a new ticket filed
    # against this department that nobody assigned goes straight to this
    # person, after the help topic's own default. "" = none.
    default_assignee_email = Column(String, default="")


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
    # Legacy single-company pointer (pre Sep 25). Which companies use a site
    # now lives in HrCompanyWorkSite; this is only read by the one-time link
    # backfill in main.py and cleared when that company unlinks the site.
    company       = Column(String, default="")
    notes         = Column(String, default="")
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")
    # Address-first sites (Pranshu, Sep 30): the coordinates came from an
    # address the person searched and picked - never a hand-placed pin. Blank =
    # an older site whose point came from the map; the UI asks for a re-check.
    address_verified_at = Column(String, default="")
    address_verified_by = Column(String, default="")
    # Where the point came from (Sep 30): "address" (a searched, picked
    # address), "google_link" (a pasted Google Maps link or coordinates), ""
    # (older sites). map_link keeps the pasted link as the record of it.
    location_source = Column(String, default="")
    map_link        = Column(String, default="")


class HrCompanyWorkSite(Base):
    """A company's pick from the global work-site library (Neil, Sep 25): sites
    are entered once in the library, and each company chooses which of them its
    employees punch at. A site can belong to many companies. id is
    "<company_id>:<site_id>" so the backfill and re-adds are idempotent."""
    __tablename__ = "hr_company_work_sites"
    id            = Column(String, primary_key=True)
    company_id    = Column(String, nullable=False, index=True)   # HrEntity.id
    site_id       = Column(String, nullable=False, index=True)   # HrWorkSite.id
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")


class HrCompanyHoliday(Base):
    """A holiday on a specific company's calendar (Sep 18, Pranshu: "if i add
    a holiday for Greens global the employee in greens global can see that
    holiday in their Calendar dashboard"). Two ways a row gets here: picked
    from a country's public holidays (source="public", country_code set) or
    typed in directly by the admin (source="manual"). Either way it's just a
    flat date + name once created - there's no ongoing link back to the
    public-holiday API, so a holiday that moves next year doesn't silently
    move here too."""
    __tablename__ = "hr_company_holidays"
    id            = Column(String, primary_key=True)   # uuid
    company_id    = Column(String, nullable=False, index=True)   # HrEntity.id
    date          = Column(String, nullable=False)     # YYYY-MM-DD
    name          = Column(String, nullable=False)
    source        = Column(String, default="manual")   # "manual" | "public"
    country_code  = Column(String, default="")         # set when source="public"
    # Mandatory (everyone off, the default/original behavior) | optional (an
    # employee may choose to take it, against a dedicated optional-holiday
    # allowance rather than casual/earned leave) | half_day (a normal shift
    # that ends early, e.g. Halloween/NYE/Christmas Eve in the US) - Neil,
    # Sep 22 call. Payroll/leave consumption of this field is a separate,
    # later piece; today it's just captured and shown.
    type          = Column(String, default="mandatory")
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")


class HrHolidayPolicy(Base):
    """A reusable, NAMED set of holidays. APPLYING one is global - any company
    can pull any policy into its own calendar ("you can pull that policy into
    any other company that's added on"). EDITING one is not: only the company
    that created it may rename/edit/delete it (Pranshu, Sep 22 - "should be
    only editable by the company by which it was created"), enforced the same
    way every other HR-admin surface is scoped (see auth.hr_scope) - a scoped
    admin limited to one company can't reach into another company's policy,
    while an unrestricted admin can (same as everywhere else in HR). Holidays
    live as JSON here rather than a child table: a policy is always edited as
    a whole unit through the same picker UI that creates it (never one holiday
    at a time), so there's nothing a relational child table would buy beyond
    what create_company_holiday's per-row model already does for a company's
    own live calendar. Applying a policy to a company COPIES its holidays into
    that company's HrCompanyHoliday rows (via the same per-country merge as
    create_company_holiday) - editing the policy later does not retroactively
    change a company that already applied it; the company just has a fresh
    "apply" action available if it wants the update."""
    __tablename__ = "hr_holiday_policies"
    id            = Column(String, primary_key=True)   # uuid
    name          = Column(String, nullable=False)
    company_id    = Column(String, default="", index=True)   # HrEntity.id that created it - owns edit/delete
    # [{date, name, source, country_code, type}, ...] - same shape as a row in
    # hr_company_holidays, minus company_id/id (those are assigned on apply).
    holidays      = Column(JSON, default=list)
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
    body_locked   = Column(Boolean, default=False)      # statutory form (CA lien waiver, TX release) - body text is not editable


class HrSignDraft(Base):
    """A Send for Signature that was started and not finished.

    Filling one of these in is twenty minutes of work - recipients, field
    placement, a message, an expiry - and until now closing the wizard threw
    all of it away (Sagar, Sep 22 2026). The draft is the wizard's own state,
    stored as it serializes it, plus the source PDF: a draft that could not
    hand back the exact file the fields were placed on would be worse than
    none, because the coordinates would no longer mean anything.

    Private to its owner. Nobody else's business what someone was drafting.
    """
    __tablename__ = "hr_sign_drafts"
    id          = Column(String, primary_key=True)     # uuid
    owner_email = Column(String, default="")           # the only person who can see it
    title       = Column(String, default="")           # for the list, so it need not parse payload
    payload     = Column(JSON, default=dict)           # the wizard's state, verbatim
    file_path   = Column(String, default="")           # hr-docs path of the source PDF, when there is one
    file_name   = Column(String, default="")
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class HrSignSeal(Base):
    """What was ACTUALLY applied to a completed packet, read back off the
    signed PDF rather than copied from configuration.

    Kept separate from the certificate on purpose: the certificate is inside
    the bytes being sealed, so it cannot state the outcome of its own sealing.
    It describes the policy; this row records the result, including failures -
    a seal that did not apply must leave evidence, not silence."""
    __tablename__ = "hr_sign_seals"
    id                  = Column(String, primary_key=True)   # uuid
    request_id          = Column(String, nullable=False, index=True)
    status              = Column(String, default="applied")  # applied | failed | skipped
    detail              = Column(String, default="")         # why, when not applied
    profile             = Column(String, default="")         # e.g. PAdES B-B
    signature_algorithm = Column(String, default="")         # e.g. sha256_rsa
    cert_subject        = Column(String, default="")
    cert_issuer         = Column(String, default="")
    cert_serial         = Column(String, default="")
    cert_not_after      = Column(String, default="")
    # False for the self-signed development certificate. A reader will report
    # the signer as unknown, and nothing may describe it as trusted until an
    # AATL-issued certificate is in place.
    publicly_trusted    = Column(Boolean, default=False)
    key_custody         = Column(String, default="")         # software | hsm - what actually held the key
    timestamp_authority = Column(String, default="")         # '' = no third-party timestamp
    timestamped_at      = Column(String, default="")
    sealed_sha256       = Column(String, default="")         # digest of the sealed bytes
    created_at          = Column(String, default="")


class HrSignRetentionHold(Base):
    """A legal hold on one envelope: while any unreleased hold exists, nothing
    may purge it. Holds always win over retention schedules - a record under
    hold is evidence, and destroying it is spoliation."""
    __tablename__ = "hr_sign_retention_holds"
    id          = Column(String, primary_key=True)   # uuid
    request_id  = Column(String, nullable=False, index=True)
    reason      = Column(String, default="")
    placed_by   = Column(String, default="")
    placed_at   = Column(String, default="")
    released_by = Column(String, default="")
    released_at = Column(String, default="")         # '' = still holding


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
    excluded_ack_at  = Column(String, default="")         # sender confirmed this is not an ESIGN 7003 / Civ. Code 1633.3 excluded record
    excluded_ack_by  = Column(String, default="")         # who confirmed it
    certificate_html = Column(Text, default="")           # the certificate of record - deterministic, regenerable from the snapshot
    certificate_sha256 = Column(String, default="")       # digest of certificate_html as issued
    certificate_snapshot = Column(JSON, default=dict)     # the frozen inputs; re-render must reproduce certificate_html byte for byte
    content_pages    = Column(Integer, default=0)         # pages of final_pdf that are the DOCUMENT; the rest is the certificate
    document_class   = Column(String, default="")         # hr_document_classes.code - gates electronic signing
    governing_law    = Column(String, default="")         # 'CA', 'TX', ... - routes the consent flow (Cal. Civ. Code 1633.5(b))
    # What this envelope belongs to outside Nexus Sign, so its events can move
    # that record along: link_kind "timesheet" + link_id = TimesheetReview.id.
    link_kind        = Column(String, default="", index=True)
    link_id          = Column(String, default="", index=True)
    # 1 = the documents print pay (offer / promotion letters): the sealed PDF,
    # the party links and party re-pointing need Pay & Benefits (hr_comp).
    prints_pay       = Column(Integer, default=0)


class HrSignParty(Base):
    __tablename__ = "hr_sign_parties"
    id                   = Column(String, primary_key=True)   # uuid
    request_id           = Column(String, nullable=False)
    role_key             = Column(String, default="")
    name                 = Column(String, default="")
    email                = Column(String, default="")
    kind                 = Column(String, default="internal") # internal|external
    ordinal              = Column(Integer, default=1)         # signing order (matches request.current_order)
    status               = Column(String, default="waiting")  # waiting|notified|viewed|signed|approved|acknowledged|declined
    token                = Column(String, default="", index=True)  # secrets.token_urlsafe(32) - the public-link credential
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
    # signer | countersigner | witness | approver | certified_delivery | cc.
    # Each behaves differently in the engine - see _ACTING_ROLES in esign.py.
    party_role           = Column(String, default="signer")
    acknowledged_at      = Column(String, default="")         # certified delivery: when receipt was acknowledged
    # Pages the signing session reported as actually displayed, out of the
    # packet's total. The certificate says "all pages viewed before signing"
    # only when these agree - it is never inferred from the fact that someone
    # signed, because scrolling past is not the same as being shown.
    pages_viewed         = Column(Integer, default=0)
    pages_total          = Column(Integer, default=0)
    access_code          = Column(String, default="")         # optional code an external signer must enter to open the link
    # Text the access code to `phone` when this party is invited (Sagar, Sep 21).
    # Stored rather than decided at send: a sequential signer is invited days
    # later, and the code has to travel with THEIR link, not everyone else's.
    # Never emailed - the code is the second factor on top of the emailed link,
    # and the certificate says "out-of-band" (services/certificate.py).
    code_sms             = Column(Boolean, default=False)
    authenticated_at     = Column(String, default="")         # when this party cleared auth - set BEFORE any document is rendered
    org                  = Column(String, default="")         # the company this person signed for
    title                = Column(String, default="")         # their role in it - evidence of capacity to bind
    # What the system ACTUALLY did to authenticate this party, recorded at the
    # time. Deriving it later from kind/access_code would let the certificate's
    # account of a past signing change if the party row is edited afterwards.
    auth_method          = Column(String, default="")         # entra_sso | emailed_token | emailed_token+access_code
    auth_factors         = Column(JSON, default=list)         # ["session"] | ["token"] | ["token","access_code"]
    failed_auth_count    = Column(Integer, default=0)         # wrong access-code attempts - disclosed on the certificate
    signature_digest     = Column(String, default="")         # sha256 of the submitted signature, frozen at signing
    # Deliberately UNPOPULATED until the vendors in build note section 9 are
    # integrated. The columns exist so the schema matches the spec, but nothing
    # writes them: Nexus runs no identity proofing, so a NIST SP 800-63 level
    # would be a claim nobody assessed, and no geo-IP lookup happens, so a city
    # would be invented. The certificate prints neither. See test_esign_party_evidence.
    ial                  = Column(String, default="")         # IAL1 | IAL2 - requires an identity-proofing vendor
    aal                  = Column(String, default="")         # AAL1 | AAL2 | AAL3 - requires an assessed authenticator
    signed_geo           = Column(String, default="")         # requires a geo-IP resolver
    # Optional SMS destination for the signing one-time code. Collected on the
    # recipient step, never derived from a directory: an external signer's
    # number is whatever the sender actually has for them, and guessing one
    # would send a signing credential to a stranger. Empty = email OTP only.
    phone                = Column(String, default="")


class HrSignEvent(Base):
    """Immutable audit trail - one row per action on an envelope.

    Append-only is enforced at the DATABASE (main.py: rules on Postgres,
    triggers on SQLite), not here - application-level immutability is worth
    nothing as evidence. The unique constraint on (request_id, seq) is what
    stops two concurrent appends from forking the hash chain."""
    __tablename__ = "hr_sign_events"
    __table_args__ = (UniqueConstraint("request_id", "seq", name="uq_hr_sign_events_seq"),)
    id          = Column(String, primary_key=True)   # uuid
    request_id  = Column(String, nullable=False)
    party_id    = Column(String, default="")
    type        = Column(String, default="")         # created|sent|viewed|consented|signed|declined|reminded|voided|completed|downloaded
    detail      = Column(String, default="")
    ip          = Column(String, default="")
    user_agent  = Column(String, default="")
    at          = Column(String, default="")
    seq         = Column(Integer, default=0)          # tamper-evident hash chain (added later): 1,2,3... per request_id
    event_hash  = Column(String, default="")          # see hash_version for how it was computed
    # 1 = the original pipe-joined digest; 2 = RFC 8785 JCS canonicalization.
    # The algorithm is VERSIONED rather than swapped because changing how a
    # hash is computed retroactively invalidates every chain ever written -
    # every historical envelope would fail replay and the nightly sweep would
    # alert on all of them. Old rows keep verifying under v1 forever; new rows
    # are written under v2, and a chain that spans the change verifies each
    # entry by its own version.
    hash_version = Column(Integer, default=1)


class HrSignDocument(Base):
    """One file in an envelope's packet, with its digest AT SEND and AT
    COMPLETION.

    The digests used to be computed at finalize from whatever was in storage,
    which quietly assumed the source file could not change between send and
    completion. It can - storage is writable - and the certificate would then
    print the swapped file's digest as its "digest at send" and call it
    unaltered. Capturing at send closes that: the value is frozen when the
    envelope goes out, and the completion digest is compared against it."""
    __tablename__ = "hr_sign_documents"
    id                    = Column(String, primary_key=True)   # uuid
    request_id            = Column(String, nullable=False, index=True)
    ordinal               = Column(Integer, default=1)         # order in the packet
    name                  = Column(String, default="")
    storage_path          = Column(String, default="")
    page_count            = Column(Integer, default=0)
    digest_at_send        = Column(String, default="")         # sha256 of the bytes that went out
    digest_at_completion  = Column(String, default="")         # sha256 of the same file, stamped
    created_at            = Column(String, default="")


class HrDocumentClass(Base):
    """What KIND of record an envelope carries, and whether the law lets it be
    signed electronically at all (ESIGN 15 U.S.C. 7003 / Cal. Civ. Code 1633.3).

    A class table rather than a code constant because the answer is a legal
    fact that changes without a deploy (statutes move, and counsel may want a
    category blocked pending review). Seeded at boot; `electronic_permitted`
    False is a HARD BLOCK at send, not a warning."""
    __tablename__ = "hr_document_classes"
    code                  = Column(String, primary_key=True)   # 'subcontract', 'will', ...
    label                 = Column(String, nullable=False)
    electronic_permitted  = Column(Boolean, default=True)
    citation              = Column(String, default="")         # why, when not permitted
    note                  = Column(String, default="")         # what to do instead
    # How long a completed envelope of this class is kept, in months. 0 = keep
    # indefinitely, which is the default for every seeded class: destroying
    # executed agreements on a timer is a decision each class has to be given
    # deliberately, not one that arrives with a schema migration.
    retention_months      = Column(Integer, default=0)
    sort_order            = Column(Integer, default=100)


class HrSignConsent(Base):
    """One signer's consent to transact electronically - its own row, not three
    columns on the party.

    ESIGN 7001(c) is about what was SHOWN and what the signer demonstrated they
    could open, so the evidence is the disclosure digest (the exact bytes of the
    text presented) plus `format_demonstrated`. A version string alone proves
    nothing if the text behind that version ever changed."""
    __tablename__ = "hr_sign_consents"
    id                  = Column(String, primary_key=True)   # uuid
    party_id            = Column(String, nullable=False, index=True)
    request_id          = Column(String, nullable=False, index=True)
    disclosure_version  = Column(String, default="")
    disclosure_digest   = Column(String, default="")         # sha256 of the exact text shown
    scope               = Column(String, default="transaction")   # transaction | category
    format_demonstrated = Column(String, default="")         # 'pdf_rendered_in_session' | ''
    accepted_at         = Column(String, default="")
    accepted_ip         = Column(String, default="")
    session_id          = Column(String, default="")
    standing_basis      = Column(String, default="")         # internal signers: the clause relied on
    withdrawn_at        = Column(String, default="")
    withdrawal_method   = Column(String, default="")


class HrSignOtpChallenge(Base):
    """A pending one-time code for ONE party of ONE envelope.

    Separate from CredVault's vault_otp_challenges on purpose: that table is
    keyed by a Nexus user's email and gates a vault action, while this one is
    keyed by party_id and gates a signature. An external signer has no Nexus
    account to key on, and a code minted for one envelope must never open
    another - so the party row IS the scope.

    The code itself is never stored. `code_hash` is sha256 over
    "challenge_id:code", salted with an id the requester never sees, so a
    leaked table alone is not brute-forceable against a six-digit space.
    """
    __tablename__ = "hr_sign_otp_challenges"
    id          = Column(String, primary_key=True)   # uuid - also the hash salt
    request_id  = Column(String, nullable=False, index=True)
    party_id    = Column(String, nullable=False, index=True)
    channel     = Column(String, default="email")    # email | sms
    target      = Column(String, default="")         # the address/number it actually went to (audit)
    code_hash   = Column(String, default="")
    attempts    = Column(Integer, default=0)
    # Set the moment a correct code is accepted. A consumed challenge is spent:
    # the same code can never authorize a second signature, so a forwarded
    # email cannot be replayed after the signer has used it.
    consumed_at = Column(String, default="")
    expires_at  = Column(String, default="", index=True)
    created_at  = Column(String, default="")



class HrSignUpload(Base):
    """A file a SIGNER attached at an upload field - a certificate of insurance,
    a voided check, a scanned ID.

    Its own table rather than a blob inside `HrSignParty.field_values`, because
    an uploaded file is evidence with the same standing as the signature: it
    needs a digest frozen at the moment it arrived, its own retention, and a
    row the certificate can cite. `field_values` is a JSON column rewritten
    wholesale on every save, which is exactly the wrong home for that.

    One CURRENT row per (party, field): re-uploading supersedes rather than
    appends, so `superseded_at` keeps the replaced file's evidence instead of
    deleting it. Queries for "what did they actually submit" filter on
    superseded_at == "".
    """
    __tablename__ = "hr_sign_uploads"
    id            = Column(String, primary_key=True)   # uuid
    request_id    = Column(String, nullable=False, index=True)
    party_id      = Column(String, nullable=False, index=True)
    field_id      = Column(String, default="", index=True)
    field_label   = Column(String, default="")
    name          = Column(String, default="")         # the signer's own filename
    storage_path  = Column(String, default="")
    content_type  = Column(String, default="")
    size_bytes    = Column(Integer, default=0)
    sha256        = Column(String, default="")         # frozen over the bytes received
    uploaded_at   = Column(String, default="")
    uploaded_ip   = Column(String, default="")
    superseded_at = Column(String, default="")         # non-empty = replaced by a later upload


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
    # Which department's approved language this is. Department heads maintain
    # their own department's templates; administrators maintain all of them.
    # Empty means company-wide, which only an administrator may create or edit.
    department          = Column(String, default="")
    # Requirement 3 metadata: what KIND of thing this template produces. Email
    # templates are Phase 3 work, but the type belongs on the record now so the
    # library can say what a template is rather than it being retrofitted later.
    doc_type            = Column(String, default="document")  # document|email
    # Who normally signs a document made from this template, and in what order:
    # [{key, label, order}]. This is the one thing the separate Nexus Sign
    # template system held that the Documents library did not, and it is why
    # two template systems existed. It lives here as a DEFAULT for the send
    # step, not as signing configuration - the envelope still decides who
    # actually signs, because that varies per deal.
    #
    # Field POSITIONS are deliberately NOT stored: a generated document is
    # re-rendered per document with different variable values, so text reflows
    # and a remembered x/y would point at the wrong line. Fields are placed on
    # the real PDF at send time, which is what the wizard already does.
    signer_roles        = Column(JSON, default=list)
    # Draft -> Active -> Archived (requirement 3). Draft is what makes
    # "company-approved" mean anything: a template still being written is not
    # language anyone should be generating from yet.
    status              = Column(String, default="active")    # draft|active|archived
    version             = Column(Integer, default=1)
    created_by          = Column(String, default="")
    created_at          = Column(String, default="")
    updated_by          = Column(String, default="")
    updated_at          = Column(String, default="")
    # Publish (Oct 14). The editor autosaves every 1.5 s and each save bumps
    # `version`, so "the latest version" is routinely half a sentence. HR
    # packets read the PUBLISHED version instead: a finished edit is released
    # on purpose with Publish, and packets pick it up from that moment.
    # 0 = never published. The content lives in the DocTemplateVersion row with
    # version_no == published_version; published_meta freezes what that table
    # does not hold: {fieldDefs, signerRoles, mergeOverrides, letterheadId,
    # requiresLetterhead}.
    published_version   = Column(Integer, default=0)
    published_meta      = Column(JSON, default=dict)
    published_by        = Column(String, default="")
    published_at        = Column(String, default="")


class Document(Base):
    __tablename__ = "documents"
    id               = Column(String, primary_key=True)   # uuid
    title            = Column(String, nullable=False)
    folder_id        = Column(String, default="")
    template_id      = Column(String, default="")
    # Requirement 17: a generated document stays associated with the template
    # VERSION it came from, so editing a template never retroactively changes
    # what an already-generated document was produced from.
    template_version = Column(Integer, default=0)
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
    # "esign-send" = plumbing, not a document: the Send for Signature wizard
    # generates one of these purely to render the PDF it attaches to an
    # envelope, so it is kept (the envelope cites it) but never listed in My
    # Documents (Sagar, Sep 22 2026).
    source           = Column(String, default="")
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")
    archived_at      = Column(String, default="")
    # An HR packet document (source "hr-packet", Oct 14): the life event it
    # belongs to, and the candidate it is about (a hire has no employee yet).
    life_event_id    = Column(String, default="", index=True)
    candidate_id     = Column(String, default="")


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
    local_date     = Column(String, default="", index=True)  # YYYY-MM-DD in the puncher's timezone (grouping key)
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
    # A manager put this punch at a site by hand (Sep 29): the timecard keeps
    # the stamped site instead of re-judging the punch's GPS.
    site_set_by    = Column(String, default="")
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
    # Add Time (Oct 14 2026): every punch a manager's batch wrote together
    # shares an id, so the batch can be undone as one.
    batch_id         = Column(String, default="", index=True)
    # Duplicate Day (Oct 27 2026): a punch HR's "Replace existing" voided -
    # the batch that replaced it, so undoing that batch brings it back.
    replaced_by_batch = Column(String, default="", index=True)


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
    # What channel_id is: a Teams group chat ("chat", every row before Oct 6)
    # or a channel in team_id ("channel") - teams_post.deliver_row posts to
    # whichever it names.
    target_type    = Column(String, default="chat")
    sent           = Column(Integer, default=0)         # 1 = landed in Teams
    send_error     = Column(String, default="")
    created_at     = Column(String, default="")
    # Server-side delivery queue fields (Aug 5): html = the composed Teams
    # message; attempts/last_try_at drive the retry loop; '' html = legacy row.
    html           = Column(String, default="")
    attempts       = Column(Integer, default=0)
    last_try_at    = Column(String, default="")


class TicketTeamsMessage(Base):
    """Ticket-update Teams DM: queued when an agent saves a change worth
    telling the requester about (routers/tickets.py - the same events that
    already trigger the requester's update email), delivered the same
    guaranteed-delivery way TimeBod posts are (teams_post.py) - posted AS THE
    AGENT via a delegated Graph token, into a 1:1 chat with the requester that
    Graph creates on first contact (returns the existing chat unchanged if the
    two already have one). chat_id is cached once resolved so a retry doesn't
    re-create it every attempt."""
    __tablename__ = "ticket_teams_message"
    id              = Column(String, primary_key=True)   # uuid
    ticket_id       = Column(String, nullable=False, index=True)
    agent_email     = Column(String, nullable=False)      # whose delegated token posts
    requester_email = Column(String, nullable=False)      # the 1:1 chat's other member
    html            = Column(String, default="")
    chat_id         = Column(String, default="")
    sent            = Column(Integer, default=0)
    send_error      = Column(String, default="")
    attempts        = Column(Integer, default=0)
    last_try_at     = Column(String, default="")
    created_at      = Column(String, default="")
    # 'dm' = the requester DM above; 'feedback_chat' = a new Feature Request
    # posted to the Nexus - Feedback and Bugs group chat (feature_requests.py).
    kind            = Column(String, default="dm")


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
    # '' (default) = ongoing disclosed monitoring, view starts immediately -
    # the Workforce Analytics roster's model. 'assist' (Sep 9, ticket-launched
    # "Screen Share") = consent-first: no view at all until the employee
    # accepts a control prompt shown the instant their agent picks this
    # session up, and the whole session ends the moment control does - never
    # falls back to a passive view. See live_request/agent_live_pending in
    # routers/timeclock.py and desktop-agent/src/live.js.
    purpose                = Column(String, default="")


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
    # IANA zone this shift's start/end times are wall-clock-local to (e.g.
    # "Asia/Kolkata" for a team that starts 18:00 IST). Lets each team's
    # briefing/late-detection trigger fire against its own local clock instead
    # of guessing from the employee's last punch timezone.
    timezone   = Column(String, default="America/Los_Angeles")
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    # Unpaid break inside the shift, in minutes (Sep 28, Teams parity). Copied
    # onto each placement (ScheduledShift.break_min), so scheduled hours on the
    # grid are PAID hours. Pay itself still comes from real punches.
    break_min  = Column(Integer, default=0)
    # Shifts Phase 0 (Neil, Oct 14 2026): the HrEntity company this shift
    # type belongs to; '' = shared with every company. A company-scoped
    # People admin manages only their own company's types; shared ones
    # take company-wide access (timeclock._require_company_manage).
    company_id = Column(String, default="")


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
    # OPEN SHIFTS (Teams-style, Aug 26): an unassigned slot has employee_email=''
    # and open_slots >= 1 (how many people are still needed). It shows in the
    # "Open shifts" row; a manager assigns it to a person, which spawns their
    # own assigned row and decrements this one (removed at 0). A normal assigned
    # shift has a real email and open_slots 0.
    open_slots     = Column(Integer, default=0)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    # UNSHARED CHANGES to a PUBLISHED shift (Sep 28, Teams parity). Editing or
    # deleting a shift staff can already see used to flip it back to a draft,
    # which hid it from them until the next publish. Now the published values
    # above stay live and the change waits here until Publish applies it:
    # pending_json = the edited fields (JSON: shiftId/start/end/label/note/
    # openSlots), pending_delete = 1 for a removal. Both are '' / 0 on drafts,
    # which are edited and deleted in place since nobody has seen them.
    pending_json   = Column(String, default="")
    pending_delete = Column(Integer, default=0)
    # Unpaid break minutes for THIS placement - defaults to its preset's
    # break_min when placed, editable per shift (Sep 28).
    break_min      = Column(Integer, default=0)
    # Named blocks inside the shift (Sep 29, Teams "activities"), e.g.
    # 12:00-13:00 Training. JSON list of {start, end, label}; '' = none.
    activities_json = Column(String, default="")
    # This shift's own color (#rrggbb, Sep 29); '' = its preset's color.
    color           = Column(String, default="")
    # The scheduling group (team) this placement belongs to (Oct 2, Shifts
    # rebuild): open shifts, day notes, hours and "publish this team" key on
    # it; '' = none. An OPEN shift always carries one.
    group_id        = Column(String, default="", index=True)
    # The IANA zone the wall-clock times above are in, stamped from the
    # preset / team setting when placed (Oct 2); '' on older rows, which
    # resolve preset -> team at read time (_sched_dict).
    timezone        = Column(String, default="")
    # Weather Call (Oct 2026): what a weather call did to THIS placement -
    # '' | cancelled (off, unpaid) | delayed | shortened | moved | kept - with
    # the decision it came from and the times it had before, so Reinstate
    # and a pay question can both see the original. The row is never
    # deleted by a weather call.
    weather_status      = Column(String, default="")
    weather_decision_id = Column(String, default="")
    original_start_hhmm = Column(String, default="")
    original_end_hhmm   = Column(String, default="")
    original_label      = Column(String, default="")
    # A delay that moves an overnight shift's start past midnight puts the
    # row on the next calendar day; this is the day it was on (Oct 12).
    original_work_date  = Column(String, default="")
    # The grid and the reminder scan read one person's days (Oct 2).
    __table_args__ = (Index("ix_scheduled_shifts_email_date", "employee_email", "work_date"),)


class ShiftGroup(Base):
    """A reusable set of employees - used to bulk-assign shifts AND to bind the
    Teams group chat that this group's BOD/EOD/Break messages route to."""
    __tablename__ = "shift_groups"
    id              = Column(String, primary_key=True)   # uuid
    name            = Column(String, default="")
    teams_chat_id   = Column(String, default="")         # bound Teams group chat - or channel id (teams_target)
    teams_chat_name = Column(String, default="")
    # Where this group's BOD / EOD / Break messages post (Pranshu, 10/06): a
    # Teams group chat (the original binding) or a channel in a team, for an
    # organization that runs a channel per department. For "channel",
    # teams_chat_id/_name hold the CHANNEL and teams_team_* its team.
    teams_target    = Column(String, default="chat")     # chat | channel
    teams_team_id   = Column(String, default="")
    teams_team_name = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    # People who may build THIS group's schedule without team-wide access
    # (Sep 29, Teams "scheduling owner" per team). JSON list of emails.
    scheduler_emails = Column(String, default="")
    # Teams switcher (Neil, Sep 30): archived teams drop out of the active list;
    # sort_order is the manager's own order (Reorder Teams), then name.
    archived        = Column(Integer, default=0)
    sort_order      = Column(Integer, default=0)
    # Weather Call (Neil, Oct 10 2026): where this group works - an HrWorkSite
    # whose coordinates the weather watch reads. '' = no site, which means no
    # weather advisory for the group (the schedule says so to its managers).
    work_site_id    = Column(String, default="")
    # Who makes this group's weather call (JSON list of emails). Each must
    # hold Manage access to Shifts (manager and above). Empty = the group's
    # schedulers, then the company's managers.
    weather_decider_emails = Column(String, default="")
    # 1 = the weather watch includes this group (when its company is switched on).
    weather_alerts  = Column(Integer, default=1)
    # Shifts Phase 0 (Oct 14 2026): the HrEntity company this group belongs
    # to; '' = shared across companies (managed company-wide only).
    company_id      = Column(String, default="")


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
    time_tracking_exempt = Column(Integer, default=0)      # LEGACY (Oct 2): no longer read - the exemption is nexus_groups.time_tracking_exempt
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
    # Confidential (Neil, Sep 29): the type, note and decision note show only
    # to the requester and the people who decide it (timeclock._TimeoffPrivacy);
    # everyone else sees plain "Time off" with the dates.
    confidential   = Column(Integer, default=0)
    # Second Approval By HR (Neil, Oct 27 2026; per company, Settings > Time &
    # Pay > Time-Off Approval). The status stays 'pending' until the request
    # is fully approved, so every "pending" reader keeps treating it as not
    # approved; approval_stage says whose turn it is: '' = the manager, 'hr' =
    # the manager approved and it waits for HR (timesheet_review.is_hr).
    approval_stage   = Column(String, default="")
    first_approver   = Column(String, default="")     # the manager who approved the first level
    first_decided_at = Column(String, default="")
    first_note       = Column(String, default="")


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
    role_ids   = Column(JSON, default=list)         # job roles (NexusGroup.id) this questionnaire is FOR - picked automatically at scheduling
    is_general = Column(Boolean, default=False)     # the fallback for a role with no questionnaire of its own
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
    interviewer_emails = Column(JSON, default=list)   # who the interview is with (Nexus People) - invited with the candidate
    followup_status = Column(String, default="")      # '' | waiting | done | failed - End Interview's merge (transcript -> fill -> score)
    followup_attempts = Column(Integer, default=0)
    followup_next_at = Column(String, default="", index=True)
    followup_note   = Column(String, default="")      # what it is waiting for / why it stopped
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
    # Recording (Pranshu, Oct 8): the Teams meeting records and transcribes
    # itself from the first second; afterwards the recording and transcript
    # are pulled into the private hr-docs bucket and, once hired, onto the
    # employee's profile Documents.
    online_meeting_id  = Column(String, default="")      # Graph onlineMeeting id (recordings/transcripts hang off it)
    auto_record        = Column(String, default="")      # '' | on | failed: <why>
    recording_status   = Column(String, default="")      # '' | waiting | done | failed
    recording_attempts = Column(Integer, default=0)
    recording_next_at  = Column(String, default="", index=True)
    recording_note     = Column(String, default="")
    recording_path     = Column(String, default="")      # hr-docs object (mp4)
    recording_size     = Column(Integer, default=0)
    transcript_path    = Column(String, default="")      # hr-docs object (vtt) - the transcript as a file


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
    # Ask HR runs through Tickets (Oct 27 2026, hr_tickets.py): the ticket an
    # open request was moved into. Set once; a row that has one is never moved
    # again. Resolved rows stay here, read-only, as Earlier Requests.
    ticket_id      = Column(String, default="", index=True)


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
    collected are controlled centrally and auditable. One row per company
    (Sep 19, Pranshu: "all companies have their different workforce analytics
    policy") plus a company_id="" fallback row (formerly the single id='default'
    row) used for anyone with no company set, or a company that hasn't gotten
    its own row yet. DISCLOSED monitoring: capture only runs while clocked in
    and after the employee acknowledges it (see MonitoringConsent); this row
    just governs HOW."""
    __tablename__ = "monitoring_policy"
    id               = Column(String, primary_key=True, default="default")
    company_id       = Column(String, default="", index=True)   # HrEntity.id; "" = fallback
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
    # The Type the employee picked for an added clock-in (Pranshu, Oct 13):
    # '' = Regular, or "Sick" / "Vacation" / "Personal" - set on the clock-in
    # when the request is approved, so the block lands as that leave.
    category       = Column(String, default="")
    # When the employee cleared this decided request from their list - kept
    # on the server so it stays cleared on every device (Miranda, Oct 18).
    employee_dismissed_at = Column(String, default="")


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
    # Whether this project's tasks are time-tracked (Oct 13 2026): the list's
    # Time / Actual columns, the task's Time Tracking section and the create
    # form's Estimated Time. "" = automatic (shown only when a task in the
    # project already has a time or actual on it), "on", "off".
    time_tracking = Column(String, default="")
    # Soft delete -> Recycle Bin (Sept 2026). A non-empty deleted_at means
    # binned: hidden from every read by database.py's _hide_soft_deleted hook
    # (one hook rather than a filter at 72 query sites), restorable for the
    # retention window, then purged by task_trash.trash_purge_loop.
    deleted_at    = Column(String, default="", index=True)
    deleted_by    = Column(String, default="")
    # How the project opens for everyone who has not chosen otherwise in it
    # (Oct 2026): {view: list|board|..., group: status|...}. Set by the owner.
    default_view  = Column(JSON, nullable=True)
    # Dashboard charts the project shares with everyone who can see it
    # ([chart configs], same shape as a person's own charts in their
    # task_table_prefs "charts" document). Editors curate.
    shared_charts = Column(JSON, default=list)
    # The project's icon (Neil, Oct 15 2026): a key from the Tasks module's
    # icon set (frontend/src/tasks/projectLook.js), e.g. "hard-hat". "" = the
    # default folder, which is what every project showed before. Set with
    # `color` from the Edit Project form; routers/task_projects.clean_project_icon.
    icon          = Column(String, default="")
    # Company wall (Oct 21 2026): the creator's company, stamped on create so
    # the row stays on its side of the wall. '' = not stamped (rows from before
    # this): the company is then derived from the owner / creator
    # (routers/task_util.row_company), like an unstamped Task.
    company_id    = Column(String, default="")
    # People following the whole project (Neil, Oct 22 2026): lowercase
    # emails. They hear about new tasks, completions and comments in it
    # (task_project_follow.py), checked against who can still see the project
    # and the task at send time. Written only under a row lock.
    follower_emails = Column(JSON, default=list)
    # Conditional row colors (Neil, Oct 22 2026): an ordered list of rules
    # [{id, name, color, bold, enabled, match, conditions: [{field, op, value}]}]
    # that color this project's task rows for everyone who views it. First
    # enabled match wins; evaluated in the browser (tasks/colorRules.js),
    # validated by task_color_rules.clean_rules, written only through
    # PUT /task-projects/{id}/color-rules under the row lock.
    color_rules   = Column(JSON, default=list)


class TaskPortfolio(Base):
    """A curated, ordered collection of projects (Asana "portfolio"), which may
    itself sit inside another portfolio.

    `parent_id` is the whole of the nesting: a portfolio with one is a
    sub-portfolio of that one, and the tree is walked from these pointers rather
    than a stored child list, so a move is one write and can never leave a child
    listed under two parents. Depth is not capped - Asana's is not either - but
    a portfolio can never become its own ancestor (see _portfolio_ancestors in
    routers/task_projects.py; a cycle would hang every rollup that walks the
    tree).

    Projects still belong to exactly ONE portfolio, the leaf they were put in.
    A parent's rollup is computed by walking its descendants, never by copying
    their project ids upward - two lists of the same membership is the drift
    portfolio_project_ids already exists to reconcile.
    """
    __tablename__ = "task_portfolios"
    id          = Column(String, primary_key=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    color       = Column(String, default="")
    owner_email = Column(String, default="", index=True)
    parent_id   = Column(String, default="", index=True)  # "" = a top-level portfolio
    project_ids = Column(JSON, default=list)              # ordered
    archived    = Column(Boolean, default=False)
    created_at  = Column(String, default="")
    modified_at = Column(String, default="")
    created_by  = Column(String, default="")
    # Soft delete -> Recycle Bin (Sept 2026). A non-empty deleted_at means
    # binned: hidden from every read by database.py's _hide_soft_deleted hook
    # (one hook rather than a filter at 72 query sites), restorable for the
    # retention window, then purged by task_trash.trash_purge_loop.
    deleted_at    = Column(String, default="", index=True)
    deleted_by    = Column(String, default="")
    # Company wall (Oct 21 2026): the creator's company, stamped on create so
    # the row stays on its side of the wall. '' = not stamped (rows from before
    # this): the company is then derived from the owner / creator
    # (routers/task_util.row_company), like an unstamped Task.
    company_id    = Column(String, default="")


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
    created_by    = Column(String, default="", index=True)
    # Personal teams (Sept 2026). A team made from the Teams screen belongs to
    # the person who made it until somebody senior blesses it:
    #   personal  visible only to its creator, and it grants NO team access -
    #             see _sync_personal_team_grants, which instead pushes an
    #             INDIVIDUAL project grant to each member. That is the whole
    #             safety property: an unapproved team cannot widen anyone's
    #             access by existing, because the access it hands out is the
    #             same access its creator could already have granted by hand.
    #   pending   personal, and waiting on a manager.
    #   approved  a real team: visible to every member, and it grants access AS
    #             A TEAM (project_role_for / visible_project_ids count it), at
    #             which point the individual grants it pushed are withdrawn.
    # Teams created from Manage are born "approved" - that screen is already
    # manager-gated, so asking a manager to approve their own team is theatre.
    approval_status = Column(String, default="approved")   # approved|personal|pending
    requested_at  = Column(String, default="")
    decided_by    = Column(String, default="")
    decided_at    = Column(String, default="")
    # {project_id: [email, ...]} - the individual grants this team pushed out
    # while unapproved, recorded so approval can withdraw EXACTLY those and
    # leave alone anyone who was a project member in their own right.
    granted_emails = Column(JSON, default=dict)
    # Soft delete -> Recycle Bin (Sept 2026). A non-empty deleted_at means
    # binned: hidden from every read by database.py's _hide_soft_deleted hook
    # (one hook rather than a filter at 72 query sites), restorable for the
    # retention window, then purged by task_trash.trash_purge_loop.
    deleted_at    = Column(String, default="", index=True)
    deleted_by    = Column(String, default="")
    # Company wall (Oct 21 2026): the creator's company, stamped on create so
    # the row stays on its side of the wall. '' = not stamped (rows from before
    # this): the company is then derived from the creator, else the team's
    # projects (routers/task_util.team_company).
    company_id    = Column(String, default="")


class TaskSection(Base):
    """An ordered section/group within a project's list & board views."""
    __tablename__ = "task_sections"
    id         = Column(String, primary_key=True)
    project_id = Column(String, default="", index=True)
    name       = Column(String, nullable=False)
    position   = Column(Integer, default=0)
    created_at = Column(String, default="")
    # Made in Nexus for the Custom grouping (Oct 13 2026). Older rows came from
    # Asana, whose board columns were sections ("Not Started", "Completed"...)
    # and held every imported task - Custom shows only these, so it starts
    # clean. The older rows and their tasks' section_id are kept as they are.
    custom     = Column(Boolean, default=False)


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
    # Company wall (Oct 21 2026): '' = shared by every company - what every
    # row was before, and what a row made while the walls are off or by a
    # Global Admin still is. A company here confines the row to that company
    # (routers/task_util.config_admits).
    company_id    = Column(String, default="")


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
    # Threads, reactions and action items (Oct 2026). A reply carries the ROOT
    # comment's id in parent_id (one level: a reply to a reply joins the same
    # thread). reactions is {emoji: [emails]}. An assigned comment names the
    # person who has to act on it; resolving it closes the item.
    parent_id      = Column(String, default="", index=True)
    reactions      = Column(JSON, default=dict)
    assignee_email = Column(String, default="")
    resolved_at    = Column(String, default="")
    resolved_by    = Column(String, default="")


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
    # File versions (Neil, Oct 22 2026). "Upload New Version" adds a row that
    # shares the first version's group: version_group = the FIRST version's id
    # ("" on that first row itself and on every row older than this feature -
    # a row is its own group until a second version arrives, no backfill) and
    # version = 1, 2, 3... The highest version is the current file; the lists
    # show only it. Old versions stay rows - nothing is overwritten.
    version_group = Column(String, default="")
    version       = Column(Integer, default=1)
    # Egnyte links (Oct 22 2026): kind "egnyte" is a LINK to a file or folder
    # in the company Egnyte, not an uploaded copy - `url` is its https Egnyte
    # web address (company domain only, see tasks._check_egnyte_url), nothing
    # is stored in Supabase, and Egnyte applies each viewer's own permissions.
    egnyte_path   = Column(String, default="")   # /Shared/... when known
    egnyte_kind   = Column(String, default="")   # file|folder
    # Web links (Oct 22 2026): kind "link" is a LINK to any web page - `url`
    # is its normalized http(s) address (tasks._check_web_link), `name` its
    # display name (the address itself when none was given). Never stored in
    # or served from Supabase, never fetched by the server, never versioned.
    # No column of its own: `kind` says it, as "egnyte" does.


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
    # Field history (Neil, Oct 22 2026): the structured change this row
    # records - {field, fieldId, label, from, to, labels} with raw values (ids,
    # emails, ISO dates). Set only on rows written by task_history.py and on
    # the status / assignee / due rows it extends; NULL everywhere else.
    field_change = Column(JSON, nullable=True)


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
    # A Board view's columns (Oct 22 2026): status|section|priority|due, ""
    # = Status. `group` is then the board's swimlanes.
    board_columns = Column(String, default="")


class TaskAutomationRule(Base):
    __tablename__ = "task_automation_rules"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    trigger    = Column(JSON, default=dict)              # {type, value?} - see task_automation.TRIGGER_TYPES
    actions    = Column(JSON, default=list)              # [{type, value}] - task_automation.ACTION_TYPES
    enabled    = Column(Boolean, default=True)
    created_at = Column(String, default="")
    # Engine (Oct 2026, task_automation.py). Until then rules were stored and
    # never run. `conditions` narrows a trigger ([{field, op, value}] - project,
    # status, priority, tag, assignee, team; is / is_not); the counters feed
    # the Runs panel.
    conditions  = Column(JSON, default=list)
    run_count   = Column(Integer, default=0)
    last_run_at = Column(String, default="")
    # Company wall (Oct 21 2026): '' = shared by every company - what every
    # row was before, and what a row made while the walls are off or by a
    # Global Admin still is. A company here confines the row to that company
    # (routers/task_util.config_admits).
    company_id    = Column(String, default="")


class TaskTemplate(Base):
    __tablename__ = "task_templates"
    id             = Column(String, primary_key=True)
    name           = Column(String, nullable=False)
    description    = Column(String, default="")
    patch          = Column(JSON, default=dict)          # Partial<Task> applied on use
    subtask_titles = Column(JSON, default=list)
    created_at     = Column(String, default="")
    # Soft delete -> Recycle Bin (Sept 2026). See the hook in database.py.
    deleted_at   = Column(String, default="", index=True)
    deleted_by   = Column(String, default="")
    # Save as Template (Neil, Oct 14 2026: "convert to task template", like
    # project templates). A template saved FROM a task keeps whole subtasks,
    # not just titles: [{title, description, priority, assigneeIds,
    # followerIds, customFieldValues, recurrence, dueOffsetDays, checklist}]
    # - dueOffsetDays counted from the main task's due date. `checklist` is
    # the main task's own [{title, assigneeId}]. Older templates have only
    # subtask_titles; both are used (routers/task_config.use_template).
    subtasks       = Column(JSON, default=list)
    checklist      = Column(JSON, default=list)
    source_task_id = Column(String, default="")
    created_by     = Column(String, default="")
    # Company wall (Oct 21 2026): '' = shared by every company - what every
    # row was before, and what a row made while the walls are off or by a
    # Global Admin still is. A company here confines the row to that company
    # (routers/task_util.config_admits).
    company_id    = Column(String, default="")


class TaskIntakeForm(Base):
    __tablename__ = "task_intake_forms"
    id                = Column(String, primary_key=True)
    title             = Column(String, nullable=False)
    fields            = Column(JSON, default=list)       # [{label,type,required}]
    target_project_id = Column(String, default="")
    created_at        = Column(String, default="")
    # Company wall (Oct 21 2026): '' = shared by every company - what every
    # row was before, and what a row made while the walls are off or by a
    # Global Admin still is. A company here confines the row to that company
    # (routers/task_util.config_admits).
    company_id    = Column(String, default="")


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
    # The projects a task must carry this field in before it can be created
    # (Neil, Oct 13 2026: Property is required in some projects, not all).
    # `required` above still means "in every project the field applies to";
    # this list is the per-project version. Enforced on create by
    # routers/tasks.py create_task and in every create form.
    required_project_ids = Column(JSON, default=list)
    # Company wall (Oct 21 2026): '' = shared by every company - what every
    # row was before, and what a row made while the walls are off or by a
    # Global Admin still is. A company here confines the row to that company
    # (routers/task_util.config_admits).
    company_id    = Column(String, default="")
    # Formula columns (Neil, Oct 22 2026). For type "formula" only: the
    # expression ({Budget} - {Spent}, IF(...), ...) checked by task_formula.py
    # on save and evaluated in the browser (tasks/formula.js). The value is
    # never stored on a task. formula_format = {format, decimals}, format one
    # of number|currency|percent|date|text.
    formula        = Column(Text, default="")
    formula_format = Column(JSON, default=dict)


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
    # What the ticket is ABOUT, picked at intake from the External Links
    # directory (the rebuilt start.greensglobal.com). Stored as the link's
    # name, not its id: a link that is later renamed or removed must not turn
    # an existing ticket's application into a dangling reference, and the desk
    # filters/groups on the name it was filed under.
    application    = Column(String, default="", index=True)
    # Derived from the chosen application's ExternalLink.service_area, then
    # frozen on the row. Denormalised on purpose - re-classifying an app later
    # must not rewrite how tickets already triaged were categorised.
    # "" on tickets raised before this existed; "general" when the app carries
    # no mapping. Values mirror SERVICE_AREAS in ticketMeta.js.
    service_area   = Column(String, default="", index=True)
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
    # Timestamp of the most recent comment (public or internal - any human
    # touch resets the clock). Drives the "needs a comment" staleness highlight
    # (COMMENT_STALE_HOURS in ticketMeta.js) - a signal separate from SLA due
    # date breach. Blank on a ticket nobody has commented on yet; the frontend
    # falls back to created_at in that case.
    last_comment_at = Column(String, default="")
    # Requester-facing "something new" signal (Neil, Sep 30): stamped when
    # anyone OTHER than the requester changes the ticket or replies publicly,
    # and requester_seen_at when the requester opens it. Newer update than
    # seen = the unread dot on Support's My Tickets list.
    requester_update_at = Column(String, default="")
    requester_seen_at   = Column(String, default="")
    # What was actually done - required to resolve/close a ticket (Neil, Sep 30).
    resolution_note     = Column(String, default="")
    created_at     = Column(String, default="")
    modified_at    = Column(String, default="")
    # Who actually filed it (Neil, Oct 1 2026: the intake form's Requester field
    # raises a ticket on someone else's behalf). requester_email is who it is
    # FOR - notified, sees it as theirs, rates and reopens it; this is who typed
    # it in. Stamped server-side from the caller, never taken from the payload.
    # Blank on tickets raised before this existed (creator == requester then).
    created_by_email    = Column(String, default="", index=True)
    # Property Tickets (Neil, 10/05/2026). The Asset Management property this
    # ticket is about: a SOFT link to PropertyAsset.id (no FK - the workspace
    # PUT deletes and re-inserts every property row; same as
    # IrFund.property_asset_id). property_name is the name when linked, shown
    # after the property is gone. See property_links.py.
    property_asset_id   = Column(String, default="", index=True)
    property_name       = Column(String, default="")
    # The Property Walkthrough this ticket was filed in (TicketBatch.id).
    batch_id            = Column(String, default="", index=True)
    # The maintenance record's vendor and cost (optional, set at Resolve).
    # Cost is a normalized decimal string ("1250.00") like the maintenance
    # log's own cost field, so Total Spend adds both the same way.
    maintenance_vendor  = Column(String, default="")
    maintenance_cost    = Column(String, default="")
    # Raised from the property itself in Asset Management (its Create New
    # Ticket / Start Walkthrough, or opened by a recurring service): the
    # property is fixed for the ticket's life (Pranshu, 10/06).
    property_locked     = Column(Integer, default=0)
    # A ticket opened by a recurring service: the original ("parent") ticket
    # whose maintenance record set the schedule, and the schedule itself.
    parent_ticket_id    = Column(String, default="", index=True)
    service_id          = Column(String, default="", index=True)
    # Soft delete (Oct 2026): deleting a ticket marks it instead of dropping it
    # with its conversation, files and activity, so it can be restored and the
    # trail survives. Non-empty deleted_at = hidden everywhere by the hook in
    # database.py; .execution_options(include_deleted=True) sees it.
    deleted_at          = Column(String, default="", index=True)
    deleted_by          = Column(String, default="")
    # Overdue reminders (Oct 15 2026, ticket_overdue.py): {"due": the due date
    # the counts belong to, "sent": reminders sent, "overdue": how many of
    # those went out after the due date, "on": the assignee's local date of
    # the last one}. A changed due date starts the counts over.
    overdue_reminder    = Column(JSON, default=dict)
    # Honest SLA (Oct 2026, ticket_sla.py). ISO UTC datetimes. sla_due_at is
    # the resolution deadline with every completed pause already added;
    # sla_due_on above stays its UTC date for back-compat. The clock pauses
    # (sla_paused_at set) while waiting on the requester and while resolved /
    # closed. first_response_at is "" until someone other than the requester
    # (or whoever filed it for them) replies where the requester can see it.
    # sla_fr_alerted_at / sla_res_alerted_at: the deadline a breach alert went
    # out for ("" = not alerted). Cleared only when the deadline moves back
    # into the future (a pause or a priority change), so a ticket alerts again
    # only after it passes the new deadline - never twice for one breach.
    sla_due_at            = Column(String, default="")
    first_response_due_at = Column(String, default="")
    first_response_at     = Column(String, default="")
    sla_paused_at         = Column(String, default="")
    sla_paused_min        = Column(Integer, default=0)
    sla_fr_alerted_at     = Column(String, default="")
    sla_res_alerted_at    = Column(String, default="")
    # The unit (or "Common Area") a property ticket is about (Neil, Ops review
    # Oct 20). Checked against the facility's Cubby units when the property is
    # a Cubby store, else free text - see ticket_property_link.clean_unit.
    property_unit         = Column(String, default="")


    # How the ticket arrived (Oct 2026): "" = filed in the app, "email" = a
    # new email to the support mailbox (ticket_inbound.py). Set server-side
    # only; the drawer and list show "Via Email".
    source                = Column(String, default="")
    # Confidential desk (Oct 27 2026, ticket_confidential.py): "" = an
    # ordinary ticket, "hr" = an Ask HR request - readable only by its own
    # people and HR for its company, hidden from the desk, reports and every
    # other reader by the hook in database.py. Set server-side only.
    confidential_desk     = Column(String, default="", index=True)


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
    status               = Column(String, default="pending")   # pending|sending|sent|failed (retrying: rows from before the claim)
    graph_message_id     = Column(String, default="")
    conversation_id      = Column(String, default="")
    internet_message_id  = Column(String, default="")
    attempts             = Column(Integer, default=0)
    error                = Column(String, default="")
    created_at           = Column(String, default="")
    updated_at           = Column(String, default="")
    # Ticket review (Oct 18 2026): who caused the event, and the email exactly
    # as first rendered, so a retry resends what failed (and names the real
    # actor) instead of rebuilding it with the recipient as the actor. The
    # body is cleared once the row is sent - only unsent rows carry it.
    actor_email          = Column(String, default="")
    html                 = Column(Text, default="")


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
    # Replies and @mentions (Pranshu, Oct 16 2026): the comment this one
    # answers ('' = top level), and the work emails it mentions.
    parent_id    = Column(String, default="")
    mentions     = Column(JSON, default=list)


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
    # Oct 14 2026 rebuild: free-text notes (recovery hints, who to call) - shown
    # only to people who can reveal; and the password before the last rotation,
    # kept for ONE rotation so a botched change is not lost (owner/backup/admin).
    note               = Column(String, default="")
    prev_secret_enc    = Column(String, default="")
    prev_rotated_at    = Column(String, default="")


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
    # Optional soft link to Asset Management's PropertyAsset.id (the asset
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
    # What Exchange said about the sender (mail_inbound.auth_verdict, Oct
    # 2026): "auth: dmarc=pass compauth=pass authas=Internal", or that no
    # authentication headers were seen.
    auth_summary        = Column(String, default="")



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


class TaskProjectTemplate(Base):
    """A reusable blueprint of a whole PROJECT - its settings plus a snapshot of
    its sections and tasks - so a repeating body of work (an onboarding, a
    property turnover, a quarterly audit) is set up once and stamped out again.

    Not to be confused with TaskTemplate, which is a single-TASK template
    (a Partial<Task> patch plus subtask titles) applied to one new task. The two
    are deliberately separate tables: nothing about a project blueprint fits in
    `patch`/`subtask_titles`, and folding them together would have made every
    existing task-template row ambiguous.

    `payload` holds the entire snapshot, versioned by `payload["version"]`:
        {"version": 1,
         "project":  {name, description, color, accessLevel, portfolioId, ...},
         "sections": [{key, name, position}],
         "tasks":    [{key, parentKey, sectionKey, title, description, type,
                       status, priority, tags, assigneeEmail, followerEmails,
                       estimateHours, isMilestone, customFieldValues,
                       startOffset, dueOffset, blockedByKeys, dependencyTypes}]}
    It is a SNAPSHOT, not a live link: editing the source project afterwards
    never changes the template, and deleting the source project leaves the
    template perfectly usable. That is the whole point - a template outlives
    the project it was captured from.

    Dates are stored as INTEGER DAY OFFSETS (`startOffset`/`dueOffset`) from the
    template's anchor day, never as absolute dates. An absolute due date is
    meaningless a quarter later; an offset re-anchors to whatever start date the
    person picks when they use the template.

    Cross-task references (parent/subtask nesting, sections, dependencies) are
    carried by the per-task `key` - a stable index within the payload - rather
    than by real row ids, because the rows those ids point at may be long gone
    by the time the template is used.

    New table - create_all builds it; the Postgres migration list carries only
    its ENABLE ROW LEVEL SECURITY line (see main.py).
    """
    __tablename__ = "task_project_templates"
    id          = Column(String, primary_key=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    color       = Column(String, default="")
    category    = Column(String, default="")            # free-text grouping shown on the Templates screen
    # The project this was captured from, kept for provenance only ("Saved from
    # Q3 Turnover"). Never dereferenced when the template is used, and a dangling
    # id after that project is deleted is expected rather than an error.
    source_project_id   = Column(String, default="", index=True)
    source_project_name = Column(String, default="")
    payload     = Column(JSON, default=dict)            # see the docstring
    # Visibility, mirroring TaskProject.access_level's vocabulary:
    #   org        - anyone in the Task module can use it (the default: a
    #                blueprint nobody can find helps nobody)
    #   restricted - only its owner and managers see it
    access_level = Column(String, default="org")
    owner_email = Column(String, default="", index=True)
    archived    = Column(Boolean, default=False)
    use_count   = Column(Integer, default=0)            # how many projects have been built from it
    last_used_at = Column(String, default="")
    created_at  = Column(String, default="")
    modified_at = Column(String, default="")
    created_by  = Column(String, default="")
    # Soft delete -> Recycle Bin (Sept 2026). See the hook in database.py.
    deleted_at   = Column(String, default="", index=True)
    deleted_by   = Column(String, default="")


class TaskProjectBookmark(Base):
    """A project one person is actively watching, pinned to their dashboard.

    Its own table rather than a key in TaskTablePref: those are COLUMN
    arrangements, and "Reset Columns" clears that whole document - which would
    silently take someone's bookmarks with it. Different lifetime, different
    table.

    One row per (person, project) so a bookmark is one INSERT and one DELETE,
    with `position` carrying the hand-ordering the dashboard renders in. Scoped
    to owner_email on every read and write: a bookmark records what somebody
    is watching, not what they may see, so it widens no access.

    New table - create_all builds it, no migration line needed - but it MUST get
    ALTER TABLE task_project_bookmarks ENABLE ROW LEVEL SECURITY on dev AND prod
    as part of the release (CLAUDE.md: the backend bypasses RLS via the
    privileged URL, so a new table without it is readable by anyone holding the
    public anon key).
    """
    __tablename__ = "task_project_bookmarks"
    id          = Column(String, primary_key=True)
    owner_email = Column(String, default="", index=True)
    project_id  = Column(String, default="", index=True)
    position    = Column(Float, default=0)
    created_at  = Column(String, default="")


class TaskTablePref(Base):
    """A user's per-table column arrangement for the Task module's list views -
    which columns they have, in what order, and how wide. One row per person,
    holding a JSON document keyed by table, mirroring UserLinkLayout's
    JSON-blob-per-user shape rather than normalizing into a row per column:
    a reorder rewrites the whole arrangement in one UPSERT, and nothing here
    needs querying by column SQL-side.

    prefs shape: {
      "<table>": {
        "order":     ["task", "status", ...],   # column order
        "widths":    {"task": 280},             # column widths, px
        "hidden":    ["estimate"],              # columns they have hidden
        "collapsed": ["completed"],             # group sections they keep closed
      }
    }
    An absent key means "never set, use the default"; an empty list means the
    person explicitly cleared it. That distinction is load-bearing - it is what
    lets someone re-open a section that ships collapsed by default.
    `table` is the client's own id for a list ("richlist", "mytasks",
    "projects", "portfolios"). Unknown tables and unknown column keys are kept
    verbatim and ignored at read time by the client, so a column that is
    renamed or retired degrades to "not in my saved order" (it falls back to
    its default position) instead of breaking the arrangement.

    Nothing here widens access: this only says how a person arranges columns of
    data they can already see. Purely personal - every read/write is scoped to
    owner_email, no admin gate.

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE task_table_prefs ENABLE ROW LEVEL SECURITY` on dev and
    prod as part of the release (CLAUDE.md): the backend bypasses RLS via the
    privileged URL, but without it the table is readable by anyone holding the
    public anon key."""
    __tablename__ = "task_table_prefs"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, index=True, unique=True, nullable=False)
    prefs       = Column(JSON, default=dict)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")
    # My Day (Oct 22 2026, routers/task_my_day.py): the person's own list for
    # today - {"day": "YYYY-MM-DD" (their local date), "added": [task ids, in
    # their order], "dismissed": [due-today task ids they took off]}. Its own
    # column, not a key in `prefs`: "Restore all" resets prefs, every list
    # fetches prefs on load, and a prefs save rewrites that whole document -
    # none of which may touch today's list. A stored day that is not today
    # reads as empty; nothing ever clears it on a schedule.
    my_day      = Column(JSON, nullable=True)


class UserTourState(Base):
    """Which guided walkthroughs (GuidedTour.jsx) a person has already seen -
    one row per person, JSON blob keyed by tour id, same shape as
    TaskTablePref above. Server-side and per-person on purpose: this used to
    be a localStorage flag keyed by email, which meant "seen" lived in ONE
    browser - the same person signing in on a different browser or machine
    got the auto-tour again every time. A row here follows the person instead
    of the device.

    seen shape: {"<tour id>": "<ISO timestamp first dismissed>"}

    Purely personal, no admin gate: every read/write is scoped to owner_email.

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE user_tour_state ENABLE ROW LEVEL SECURITY` on dev and
    prod as part of the release (CLAUDE.md)."""
    __tablename__ = "user_tour_state"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, index=True, unique=True, nullable=False)
    seen        = Column(JSON, default=dict)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class LinkIcon(Base):
    """Cached site logo for an External Links tile, keyed by hostname.

    The tiles used to fetch every logo LIVE from icon.horse on each render.
    With 50+ links that is 50+ simultaneous requests to a free service, from
    one office egress IP, for every employee, on every page view - and
    icon.horse rate-limits per IP. Most tiles came back HTTP 429 and fell
    through to the generic lucide glyph, which is why the grid looked like it
    was missing its images and why it looked DIFFERENT every time (Charmi/Neil,
    Aug 31). Fetched once per domain into this table, then served from our own
    origin, the storm is 50 requests total rather than 50 per person per view.

    A domain with no logo anywhere is cached too (data NULL, source 'none'), or
    a dead lookup would be retried on every single render forever. `fetched_at`
    lets a stale row be refreshed without a schema change.

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE link_icons ENABLE ROW LEVEL SECURITY` on dev and prod as
    part of the release (CLAUDE.md)."""
    __tablename__ = "link_icons"
    domain       = Column(String, primary_key=True)   # hostname, lowercased
    content_type = Column(String, default="")         # image/png, image/x-icon, …
    data         = Column(LargeBinary)                # bytes, or NULL when none was found
    source       = Column(String, default="")         # icon.horse | google | none
    size_bytes   = Column(Integer, default=0)
    fetched_at   = Column(String, default="")         # UTC ISO
    error        = Column(String, default="")         # last failure, for diagnosis


class ChangelogSeen(Base):
    """Per-user "have they looked at What's New since it last got a fresh
    Released entry" marker, for the eye-icon badge next to the profile pill
    (TopHeader.jsx). Compared against the latest published TaskChangelogEntry's
    timestamp in GET /task-changelog/unseen; stamped to now() by POST
    /task-changelog/seen (fired when the icon is clicked) and automatically
    for whoever just published an entry (they don't need a badge for their
    own publish).

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE changelog_seen ENABLE ROW LEVEL SECURITY` on dev and
    prod as part of the release (CLAUDE.md)."""
    __tablename__ = "changelog_seen"
    email        = Column(String, primary_key=True)   # lowercased
    last_seen_at = Column(String, default="")          # UTC ISO
    # When this person last dismissed (or followed) the weekly New Feature bar
    # - it stays away for 7 days after (Neil, Oct 12 2026). UTC ISO.
    banner_seen_at = Column(String, default="")
    # The visit before this one (Oct 16 2026): "new since your last visit" is
    # what was released after it. Moves up when a visit starts 30+ minutes
    # after the last one (task_config._mark_changelog_seen).
    prev_seen_at   = Column(String, default="")


class AiConversation(Base):
    """One Nexus Assistant chat thread. Private to `user_email` - no manager or
    admin override reads another person's conversation (see routers/assistant.py).

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY` on dev and
    prod as part of the release (CLAUDE.md)."""
    __tablename__ = "ai_conversations"
    id         = Column(String, primary_key=True)
    user_email = Column(String, nullable=False, index=True)
    title      = Column(String, default="")
    created_at = Column(String)
    updated_at = Column(String)


class AiMessage(Base):
    """One turn in an AiConversation. `tool_calls` records which ai_assistant.py
    tools fired for an assistant reply, for audit (which reads a message
    triggered, not what data came back).

    New table - create_all builds it, so no migration line is needed. It DOES
    need `ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY` on dev and prod as
    part of the release (CLAUDE.md)."""
    __tablename__ = "ai_messages"
    id              = Column(String, primary_key=True)
    conversation_id = Column(String, nullable=False, index=True)
    role            = Column(String, nullable=False)   # user | assistant
    content         = Column(Text, nullable=False)
    tool_calls      = Column(JSON, default=list)
    created_at      = Column(String, nullable=False)


class TaskNotifyPref(Base):
    """One person's own task-email preferences (Sept 2026): when reminders
    arrive, how often overdue mails repeat, one email per task vs a daily
    summary, which instant emails they want, muted tasks/projects. Absent row
    or absent key = the company default in task_notify's settings, so people
    who never open the page keep exactly the company behavior. Shape and
    validation live in task_notify_prefs.py."""
    __tablename__ = "task_notify_prefs"
    email      = Column(String, primary_key=True)   # lowercased work email
    prefs      = Column(JSON, default=dict)
    updated_at = Column(String, default="")


class TaskEmailQueue(Base):
    """Task emails held back to be sent as one batch per person (Neil, Sep 24:
    "wait to send the email until after one hour - if 5 tasks get assigned it
    can batch it"). One row per (recipient, event); task_notify.flush_batches
    sends everything a person has pending once their oldest row is older than
    the company batch window, drops what is no longer relevant, and records
    why. status: pending | claimed (being sent) | sent | dropped."""
    __tablename__ = "task_email_queue"
    id          = Column(String, primary_key=True)
    recipient   = Column(String, default="", index=True)
    role        = Column(String, default="")          # assignee | follower | creator
    task_id     = Column(String, default="", index=True)
    event_type  = Column(String, default="")
    actor_email = Column(String, default="")
    payload     = Column(JSON, default=dict)          # update_kind, comment_body, new_follower
    urgent      = Column(Boolean, default=False)      # flush this person's batch now
    status      = Column(String, default="pending", index=True)
    batch_id    = Column(String, default="")
    drop_reason = Column(String, default="")
    created_at  = Column(String, default="", index=True)
    updated_at  = Column(String, default="")
    sent_at     = Column(String, default="")


class TimesheetReview(Base):
    """One employee's timesheet for one pay period on its way to payroll
    (Sep 2026). Two phases - see timesheet_review.py:

      review  - employee and manager hand it back and forth ("with_manager" /
                "with_employee"), each hand-off a round with a note and a diff,
                until the manager agrees to an exact version (agreed_fingerprint);
      signing - a Nexus Sign envelope (sign_request_id) of that frozen version,
                signed employee -> manager -> HR; HR's signature finalizes the
                period for payroll ("completed").

    A decline in Nexus Sign cancels the envelope and hands the timesheet back
    ("with_employee" / "with_manager") for another round."""
    __tablename__ = "timesheet_reviews"
    id                 = Column(String, primary_key=True)
    employee_email     = Column(String, default="", index=True)
    period_start       = Column(String, default="", index=True)
    period_end         = Column(String, default="")
    pay_type           = Column(String, default="hourly")   # hourly | fixed
    status             = Column(String, default="with_manager")  # with_manager | with_employee | signing | completed
    manager_email      = Column(String, default="")
    hr_email           = Column(String, default="")
    agreed_fingerprint = Column(String, default="")
    agreed_at          = Column(String, default="")
    agreed_by          = Column(String, default="")
    sign_request_id    = Column(String, default="")
    rounds             = Column(JSON, default=list)          # [{at, by, action, note, workedMin, changes}]
    last_snapshot      = Column(JSON, default=dict)          # {date: workedMin} at the last hand-off
    created_at         = Column(String, default="")
    updated_at         = Column(String, default="")



class NexusWeeklyDigestLog(Base):
    """One row per employee per (employee-local) week a Weekly Digest was
    generated (weekly_digest.py, Sep 28 2026) - the once-a-week dedupe check,
    and what the admin Delivery Log reads. Its own table rather than rows in
    nexus_daily_briefing_log: the daily briefing reads its latest row per
    person as ITS "since" cursor, so a weekly row there would shift that window.
    New table - create_all builds it; RLS must be enabled on dev and prod."""
    __tablename__ = "nexus_weekly_digest_log"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, index=True, nullable=False)
    week_start     = Column(String, index=True, nullable=False)  # Monday of the digest's week, YYYY-MM-DD
    sent_at        = Column(String, default="")          # UTC iso; '' when nothing was mailed
    mode           = Column(String, default="off")       # off|test|live - which config this run used
    overdue_count  = Column(Integer, default=0)          # their own overdue tasks
    team_count     = Column(Integer, default=0)          # manager: direct reports with overdue work
    created_at     = Column(String, default="")


class ShiftRequest(Base):
    """A self-service shift request (Sep 29 2026, Teams Shifts parity):
      open  - an employee asks for a published OPEN shift
      swap  - trade one of their shifts for a teammate's (target_shift_id)
      offer - give one of their shifts to a teammate (target_email)
    Status: pending_peer (swap/offer: waiting on the teammate) ->
    pending_manager -> approved | declined, or cancelled by the requester or
    because the shift changed underneath it. Nothing on the schedule moves
    until a manager approves (routers/shift_requests.py). The shift's day and
    times are copied on so the request still reads right after the shift
    changes. New table - create_all builds it; RLS is enabled in main.py."""
    __tablename__ = "shift_requests"
    id              = Column(String, primary_key=True)   # uuid
    kind            = Column(String, nullable=False)     # open | swap | offer
    status          = Column(String, default="pending_manager", index=True)
    requester_email = Column(String, index=True, nullable=False)
    shift_id        = Column(String, index=True, default="")   # requester's shift, or the open shift
    target_email    = Column(String, index=True, default="")   # swap/offer: the teammate
    target_shift_id = Column(String, default="")               # swap: the teammate's shift
    shift_date      = Column(String, default="")
    shift_start     = Column(String, default="")
    shift_end       = Column(String, default="")
    target_date     = Column(String, default="")
    target_start    = Column(String, default="")
    target_end      = Column(String, default="")
    note            = Column(String, default="")
    peer_note       = Column(String, default="")
    decision_note   = Column(String, default="")
    decided_by      = Column(String, default="")
    peer_decided_at = Column(String, default="")
    decided_at      = Column(String, default="")
    created_at      = Column(String, default="")


class ScheduleDayNote(Base):
    """A note on one day of the schedule for the whole team (Sep 29, Teams
    "day notes"), e.g. "Inventory day - all hands". group_id '' = everyone;
    a group id limits it to that shift group. Shown in the schedule grid's
    day header and in staff's My Workday > Shifts. New table - create_all
    builds it; RLS is enabled in main.py."""
    __tablename__ = "schedule_day_notes"
    id         = Column(String, primary_key=True)   # uuid
    work_date  = Column(String, index=True, nullable=False)   # YYYY-MM-DD
    group_id   = Column(String, default="", index=True)
    note       = Column(String, default="")
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")


class ShiftAvailability(Base):
    """When a person can work, per day of the week (Sep 29, Teams
    "availability"). No row for a weekday = available any time; `unavailable`
    = not that day; `available` = only between start and end. Staff set their
    own in My Workday > Shifts; the schedule grid warns when a shift breaks
    it. New table - create_all builds it; RLS is enabled in main.py."""
    __tablename__ = "shift_availability"
    id             = Column(String, primary_key=True)   # uuid
    employee_email = Column(String, index=True, nullable=False)
    weekday        = Column(Integer, nullable=False)     # 0 = Monday
    kind           = Column(String, default="unavailable")   # unavailable | available
    start_hhmm     = Column(String, default="")
    end_hhmm       = Column(String, default="")
    note           = Column(String, default="")
    updated_at     = Column(String, default="")


class AccountingSavedReport(Base):
    """A memorized report (Neil, Sep 25): the report, period, book, entities,
    dimension filters and comparison of an Accounting > Reports view, under a
    name, so the same statement is one click the next 50 times. Private to its
    owner unless `shared`, when everyone with the Accounting grant sees it.
    `config` holds the filters, never figures - a saved report always reads
    the ledger as it is now. New table - create_all builds it; RLS is enabled
    by the startup sweep and the line in main.py."""
    __tablename__ = "accounting_saved_reports"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, default="", index=True)
    name        = Column(String, nullable=False)
    config      = Column(JSON, default=dict)          # {report, preset, from, to, asof, book, compare, entities, dims}
    shared      = Column(Boolean, default=False)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class AccountingReportPackage(Base):
    """A reporting package (Neil, Sep 25): an ordered set of memorized reports
    sent to a lender as one PDF. `items` is a list of {reportId, title}; the
    statements are produced fresh from the ledger each time the package is
    built. New table - create_all builds it; RLS as above."""
    __tablename__ = "accounting_report_packages"
    id          = Column(String, primary_key=True)   # uuid
    owner_email = Column(String, default="", index=True)
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    items       = Column(JSON, default=list)          # [{reportId, title}]
    shared      = Column(Boolean, default=False)
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class AccountingUserPref(Base):
    """One person's own layout for the Accounting screens (Neil, Sep 25: "do
    you want to see doc number? The answer is no - but don't take it out"):
    which columns of the ledger lines show, how wide each is, row density.
    Follows the person to any computer. New table - create_all builds it; RLS
    is enabled by the startup sweep and the line in main.py."""
    __tablename__ = "accounting_user_prefs"
    email      = Column(String, primary_key=True)
    prefs      = Column(JSON, default=dict)
    updated_at = Column(String, default="")
    # When this person last opened Accounting, and how many times (Charmi,
    # call of 09/29: "a log of when each person last accessed"). Written by
    # POST /accounting/opened on every visit; shown on the Access tab.
    last_opened_at = Column(String, default="")
    opens          = Column(Integer, default=0)


class PfsProfile(Base):
    """One guarantor a lender asks about (Neil, Sep 25): a person, a couple
    filing jointly, or a trust. Holds what a personal financial statement says
    about WHO they are - contact details, the standard history questions
    answered once, the executive profile - never a full Social Security number
    (last four digits only). What they own and owe is in pfs_lines.
    The most sensitive records in Nexus: read only through routers/pfs.py,
    which admits owners and explicit "pfs" grant holders and nobody else.
    New table - create_all builds it; RLS by the startup sweep and main.py."""
    __tablename__ = "pfs_profiles"
    id                = Column(String, primary_key=True)   # uuid
    name              = Column(String, nullable=False)     # "Rajesh J. Kadakia", "RJK and DRK (Joint)", "Greens Global Family Trust"
    kind              = Column(String, default="individual")  # individual | joint | trust
    details           = Column(JSON, default=dict)          # address, phone, email, marital status, ssn_last4 ...
    history           = Column(JSON, default=list)          # [{question, answer, note}]
    executive_profile = Column(Text, default="")
    photo             = Column(Text, default="")            # small JPEG as a data URL, shown on the cover
    archived          = Column(Boolean, default=False)
    created_by        = Column(String, default="")
    created_at        = Column(String, default="")
    updated_by        = Column(String, default="")
    updated_at        = Column(String, default="")
    # The place in the guarantor dropdown (Neil, 10/14: "move Guarantors up and
    # down"); 0 = never placed, listed by name after the placed ones.
    sort_order        = Column(Integer, default=0)


class PfsLine(Base):
    """One thing a guarantor owns or owes. `source` says where the figure comes
    from: 'ledger' = the balance of the listed GL accounts of one Intacct
    entity as of the statement date (set up once, right every time after);
    'manual' = a figure somebody keeps (a retirement account, jewelry).
    ownership_pct turns the balance into the guarantor's share - a 7.5% owner
    of a company counts 7.5% of its bank account. Real estate rows carry the
    schedule columns in `details` and two figures: the value and the loan."""
    __tablename__ = "pfs_lines"
    id              = Column(String, primary_key=True)     # uuid
    profile_id      = Column(String, index=True, nullable=False)
    section         = Column(String, default="asset")       # asset | liability | real_estate
    category        = Column(String, default="bank")
    label           = Column(String, default="")
    institution     = Column(String, default="")
    account_ref     = Column(String, default="")            # last digits of the account, as printed
    ownership_pct   = Column(Float, default=100)
    source          = Column(String, default="manual")      # manual | ledger
    ledger_entity   = Column(String, default="")
    ledger_accounts = Column(JSON, default=list)             # GL codes
    manual_value    = Column(Float, default=0)
    manual_as_of    = Column(String, default="")
    details         = Column(JSON, default=dict)
    sort            = Column(Integer, default=0)
    notes           = Column(String, default="")
    updated_by      = Column(String, default="")
    updated_at      = Column(String, default="")


class PfsStatement(Base):
    """A statement as it was produced: the figures of one guarantor as of one
    date, kept so what was sent to a lender can be shown again exactly, even
    after the ledger has moved on."""
    __tablename__ = "pfs_statements"
    id           = Column(String, primary_key=True)        # uuid
    profile_id   = Column(String, index=True, nullable=False)
    as_of        = Column(String, default="")
    payload      = Column(JSON, default=dict)
    generated_by = Column(String, default="")
    generated_at = Column(String, default="")


class Lease(Base):
    """One tenant in one space (Neil and Charmi, Sep 25): the leasing and
    monthly recurring income that accounting kept in a workbook. The tenant IS
    an Intacct customer (customer_id); what Intacct cannot hold lives here -
    the lease dates, the late-fee rule, the deposit, and in lease_rates the
    rent as it changes over the years. A tenant who moves out is not
    overwritten: their lease is ended and the next tenant gets a new row that
    points back at it (replaces_id), so the history of the space stays.
    New table - create_all builds it; RLS by the startup sweep and main.py."""
    __tablename__ = "leases"
    id               = Column(String, primary_key=True)   # uuid
    property_name    = Column(String, nullable=False)     # "910 SECR - Ste 100, San Clemente"
    region           = Column(String, default="")
    tenancy          = Column(String, default="external")  # external | internal (a related company)
    landlord         = Column(String, default="")          # legal owner the tenant pays
    entity_code      = Column(String, default="", index=True)   # Intacct entity the income posts to
    income_accounts  = Column(JSON, default=list)           # GL codes rent posts to, e.g. ["41101"]
    customer_id      = Column(String, default="", index=True)   # Intacct customer
    tenant_name      = Column(String, default="")
    contact_name     = Column(String, default="")
    phone            = Column(String, default="")
    email            = Column(String, default="")
    mailing_address  = Column(String, default="")
    lease_start      = Column(String, default="")           # YYYY-MM-DD
    lease_end        = Column(String, default="")           # '' = month to month
    security_deposit = Column(Float, default=0)
    lease_terms      = Column(String, default="")
    late_fee         = Column(Float, default=0)
    due_day          = Column(Integer, default=1)           # rent is due on this day of the month
    grace_days       = Column(Integer, default=5)           # late after this many days past due
    status           = Column(String, default="active")     # active | ended | vacant
    notes            = Column(String, default="")
    replaces_id      = Column(String, default="")           # the lease of the tenant before this one
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")
    # Oct 6 (Charmi): the team's note on the rent roll's Notes column, with
    # who wrote it and when; and how the lease found its Intacct customer
    # ('' typed or picked, 'auto-name' matched by the tenant's name,
    # 'auto-ledger' added by the ledger sync).
    team_note        = Column(String, default="")
    team_note_by     = Column(String, default="")
    team_note_at     = Column(String, default="")
    link_source      = Column(String, default="")
    # Oct 7 (Charmi): MRI is one list of every recurring income source, so a
    # row says what it is - lease | interest | loan_payment | other.
    income_type      = Column(String, default="lease")
    # Oct 15 (Charmi + Neil): the lease term is a pick, never free text -
    # annual | month_to_month | custom ('' = not picked yet; lease_terms then
    # holds the old free text, read best-effort). term_months: 12 for annual,
    # None for month to month, N for custom.
    term_type        = Column(String, default="")
    term_months      = Column(Integer, nullable=True)
    # Oct 22 (Priyanka, Charmi): how often the income falls due - '' or
    # monthly (every row before Oct 22 is monthly and computes exactly as
    # before) | quarterly | semi_annual | annual | custom (every N months,
    # frequency_months), counted from the lease start month like MRE.
    frequency        = Column(String, default="")
    frequency_months = Column(Integer, default=0)
    # Oct 22 (Neil, staleness check): set by the daily recurring_stale scan
    # only - the day the source was flagged Possibly Ended ('' = not), the
    # last month anything posted ('' = nothing in twelve months), and the one
    # accounting task opened for it.
    stale_since      = Column(String, default="")
    stale_last_paid  = Column(String, default="")
    stale_task_id    = Column(String, default="")


class LeaseRate(Base):
    """The rent from a date on. A long-term tenant's rent changes at renewal
    without the tenant changing; each change is one row, in force until the
    next one starts."""
    __tablename__ = "lease_rates"
    id         = Column(String, primary_key=True)     # uuid
    lease_id   = Column(String, index=True, nullable=False)
    start_date = Column(String, default="")            # YYYY-MM-DD
    rent       = Column(Float, default=0)
    cam        = Column(Float, default=0)              # common area maintenance
    other      = Column(Float, default=0)
    note       = Column(String, default="")


class LeaseMonth(Base):
    """What is known about one month of one lease that the ledger cannot say:
    an agreed deduction (the tenant paid for a repair and took it off the rent)
    and the note that explains it."""
    __tablename__ = "lease_months"
    id         = Column(String, primary_key=True)      # "<lease_id>:<YYYY-MM>"
    lease_id   = Column(String, index=True, nullable=False)
    month      = Column(String, default="", index=True)   # YYYY-MM
    adjustment = Column(Float, default=0)               # taken off what is expected
    note       = Column(String, default="")
    updated_by = Column(String, default="")
    updated_at = Column(String, default="")


class TimecardNote(Base):
    """A manager/HR note on one day of one person's timecard (Charmi, Sep 29 -
    the Notes column). One per person per day, edited in place. Private to
    managers and HR: only the team timecard (/timeclock/payroll) carries it,
    never the employee's own /my-payroll."""
    __tablename__ = "timecard_notes"
    id             = Column(String, primary_key=True)             # "<email>|<YYYY-MM-DD>"
    employee_email = Column(String, index=True, nullable=False)
    date           = Column(String, index=True, nullable=False)   # YYYY-MM-DD
    note           = Column(String, default="")
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")
    # The employee's OWN note on the day (Neil, Oct 12) - the one field of this
    # row that /my-payroll carries; the manager/HR `note` above never does.
    employee_note    = Column(String, default="")
    employee_note_at = Column(String, default="")


class PayrollRateHistory(Base):
    """Pay priced per day (Charmi, Sep 30): one row per compensation change,
    appended by Pay & Benefits on every save. `effective_date` is YYYY-MM-DD;
    '' means "since always" - the row backfilled from the then-current
    PayrollRate the first time a person gets a dated change, so earlier days
    keep the rate they were really paid at. The timecard prices each day at
    the row in effect that day (_rate_on in routers/timeclock.py);
    PayrollRate stays the CURRENT rate. Only the back-compat PUT /payroll/rate
    corrects the latest row in place. New table - create_all builds it; RLS
    must be enabled on dev and prod at release."""
    __tablename__ = "payroll_rate_history"
    id             = Column(String, primary_key=True)             # uuid
    employee_email = Column(String, index=True, nullable=False)
    effective_date = Column(String, default="", index=True)       # YYYY-MM-DD | '' = since always
    pay_type       = Column(String, default="hourly")             # hourly | fixed
    hourly_rate    = Column(Float, default=0)
    monthly_salary = Column(Float, default=0)
    currency       = Column(String, default="USD")                # USD | INR
    overtime_rule  = Column(String, default="ca")                 # ca | federal | none
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")


class AccountingFluxNote(Base):
    """An explanation on one line of a Flux Analysis (Neil, 10/02: "MRE ...
    Flux Analysis"): why account X moved between this period and the last,
    kept in Nexus per entity set, account and period so the next close finds
    it. `entity` is the picked entity codes joined by ',' (or 'all');
    `period` is "<from>_<to>". The person and the time are `noted_by` /
    `noted_at` (the spec's by/at - BY is an SQL keyword). New table -
    create_all builds it; RLS must be enabled on dev and prod at release
    (the startup sweep and the line in main.py both do it)."""
    __tablename__ = "accounting_flux_notes"
    id         = Column(String, primary_key=True)                # uuid
    entity     = Column(String, default="", index=True)          # "15000" | "15000,56000" | "all"
    account_no = Column(String, default="", index=True)
    period     = Column(String, default="", index=True)          # "YYYY-MM-DD_YYYY-MM-DD"
    note       = Column(String, default="")
    noted_by   = Column(String, default="")
    noted_at   = Column(String, default="")
    # Review status (Charmi, Oct 15: "once a comment has been added ... the
    # review is answered"): Open = flagged, no explanation; Answered = an
    # explanation is written; Closed = a reviewer signed the line off. Only
    # `closed` is stored - Open / Answered follow from the note. A closed row
    # outlives its note being removed.
    closed     = Column(Boolean, default=False)
    closed_by  = Column(String, default="")
    closed_at  = Column(String, default="")


class AccountingPartnerChange(Base):
    """A requested change to a vendor or customer record (Charmi and Neil,
    10/01: "edit a vendor, change all the details and get pushed to manager
    for approval"). Intacct stays the source of truth, one way: the record
    itself lives there, Nexus keeps the ask. `changes` is {field: {from, to}}
    for the fields edited; `status` runs pending -> approved | declined. An
    approved row shows on the record as its current values with an "Awaiting
    Intacct" badge until someone keys it into Intacct from the export. New
    table - create_all builds it; RLS must be enabled on dev and prod at
    release.

    10/27/2026 (item 15): an approved row closes itself once a read of the
    Intacct record shows it - `in_intacct` (Intacct holds the approved
    values) or `intacct_changed` (Intacct holds a different value someone
    keyed there since); `intacct_seen_at` is when, `intacct_check` what was
    seen per field ({field: {"state", "intacct"}})."""
    __tablename__ = "accounting_partner_changes"
    id           = Column(String, primary_key=True)              # uuid
    kind         = Column(String, default="vendor", index=True)  # vendor | customer
    partner_id   = Column(String, default="", index=True)        # Intacct VENDORID / CUSTOMERID
    partner_name = Column(String, default="")
    changes      = Column(JSON, default=dict)                    # {field: {"from": .., "to": ..}}
    status       = Column(String, default="pending", index=True)  # pending | approved | in_intacct | intacct_changed | declined
    requested_by = Column(String, default="", index=True)
    requested_at = Column(String, default="")
    decided_by   = Column(String, default="")
    decided_at   = Column(String, default="")
    note         = Column(String, default="")
    intacct_seen_at = Column(String, default="")                 # when a read of Intacct closed it
    intacct_check   = Column(JSON, default=dict)                 # {field: {"state": .., "intacct": ..}}


class AccountingAllocationRun(Base):
    """One monthly payroll allocation entry as it was built (Neil, 10/01:
    "allocations journal entry from people and done monthly"). The basis is
    each person's worked hours by work site from Time Clock, the cost that
    month's wages from the payroll card; `lines` keeps the whole preview
    (people, their shares, the entry lines and the mapping used) so the
    export can be produced again unchanged. Nothing is posted anywhere - the
    CSV is keyed into Intacct by hand. `run_by` / `run_at` answer as `by` /
    `at` on the API. New table - create_all builds it; RLS must be enabled
    on dev and prod at release."""
    __tablename__ = "accounting_allocation_runs"
    id      = Column(String, primary_key=True)                   # uuid
    month   = Column(String, default="", index=True)             # YYYY-MM
    entity  = Column(String, default="", index=True)             # paying entity code, "" = every entity
    run_by  = Column(String, default="")
    run_at  = Column(String, default="")
    lines   = Column(JSON, default=dict)


class HrChecklistTemplate(Base):
    """The rows a new onboarding / offboarding / leave checklist is built from
    (HR roadmap Section C). One per kind and company; entity_id '' is the
    default every company falls back to. `items` is the ordered list of rows -
    see hr_checklist_seed.py for the shape. Seeded on first read. New table -
    create_all builds it; RLS must be enabled on dev and prod at release."""
    __tablename__ = "hr_checklist_templates"
    id         = Column(String, primary_key=True)                 # uuid
    kind       = Column(String, default="onboarding", index=True)  # onboarding | promotion | offboarding | inactive
    entity_id  = Column(String, default="", index=True)            # HrEntity.id ('' = every company)
    # A job role's extra steps (Neil, Oct 19: company, then role) - entity_id ''.
    role_id    = Column(String, default="", index=True)            # NexusGroup.id ('' = company / library)
    name       = Column(String, default="")
    items      = Column(JSON, default=list)
    updated_by = Column(String, default="")
    created_at = Column(String, default="")
    updated_at = Column(String, default="")


class HrChecklist(Base):
    """One person's onboarding, offboarding or leave checklist. Due dates hang
    off `anchor_date` (start date, exit date or leave start); when the person's
    start date changes, open rows move with it. New table - create_all builds
    it; RLS must be enabled on dev and prod at release."""
    __tablename__ = "hr_checklists"
    id          = Column(String, primary_key=True)                 # uuid
    employee_id = Column(String, nullable=False, index=True)
    kind        = Column(String, default="onboarding", index=True)  # onboarding | offboarding | inactive
    template_id = Column(String, default="")
    company     = Column(String, default="", index=True)           # HrEntity.id, frozen at start
    anchor_date = Column(String, default="")                       # YYYY-MM-DD ('' = not known yet)
    exit_type   = Column(String, default="")                       # offboarding only (hr_checklist_seed.EXIT_TYPES)
    status      = Column(String, default="open", index=True)        # open | done | cancelled
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    closed_at   = Column(String, default="")
    # The job role whose steps it carries (Oct 23 2026), so a role's template
    # change reaches it (hr_checklists.reconcile). '' = no role; NULL = started
    # before the column - filled from the role the person holds on first use.
    role_id     = Column(String, nullable=True)
    # Its ONE task (Neil, Oct 22: "Onboarding - <name>" in the HR project,
    # assigned to the head of HR); each step's subtask hangs under it.
    task_id     = Column(String, default="")
    # An Onboarding Audit of someone already working here (Neil, Oct 22: "if
    # the person is an existing employee, we can have an option to do an
    # audit"): dated from the audit, never moved by their old start date.
    audit       = Column(Boolean, default=False)


class HrChecklistItem(Base):
    """One row of a person's checklist. Owner and due date are resolved when
    the checklist starts (owner_role -> a person, offset -> a date) and can be
    changed by HR; owner_manual / due_manual keep a hand-set value from being
    overwritten when the anchor moves. New table - create_all builds it; RLS
    must be enabled on dev and prod at release."""
    __tablename__ = "hr_checklist_items"
    id           = Column(String, primary_key=True)                # uuid
    checklist_id = Column(String, nullable=False, index=True)
    key          = Column(String, default="")                      # template row key, e.g. ON-12
    phase        = Column(String, default="")
    title        = Column(String, default="")
    hint         = Column(String, default="")
    owner_role   = Column(String, default="")                      # hr | manager | employee | it | payroll | equipment | finance
    owner_email  = Column(String, default="", index=True)
    owner_manual = Column(Boolean, default=False)
    anchor       = Column(String, default="")                      # S | X | created | none
    offset       = Column(Integer, default=0)
    business_days = Column(Boolean, default=False)
    due_date     = Column(String, default="")                      # YYYY-MM-DD ('' = no date)
    due_manual   = Column(Boolean, default=False)
    signal       = Column(String, default="")                      # auto-tick rule (hr_checklists.SIGNALS)
    status       = Column(String, default="open", index=True)       # open | done | na
    done_by      = Column(String, default="")                      # email, or "Nexus" for an auto-tick
    done_at      = Column(String, default="")
    note         = Column(String, default="")
    sort_order   = Column(Integer, default=0)
    task_id      = Column(String, default="")   # the owner's task for this checklist (hr_checklists.sync_tasks)
    # Every owner, comma-separated (owner_email is the first): a role can have
    # several owners, each on the step's task (Pranshu, Oct 20).
    owner_emails = Column(String, default="")
    # Comments made while the step had no subtask; the rest live on the subtask
    # as task comments, so both sides show the same thread (hr_checklists.comments_for).
    comments     = Column(JSON, default=list)
    # Which condition ticked it when done_by is "Nexus" (Oct 23 2026), e.g.
    # "An ID document is on file" - the proof of what was on record and when.
    done_reason  = Column(String, default="")


class AccountingLoanSchedule(Base):
    """The amortization schedule of one loan (Charmi and Neil, 10/06: "Add in
    Amortization schedule for Commercial loans, allow us to build it or upload
    an existing file from the bank"). One per loan: `loan_id` is the fin_loans
    row id in the accounting app (the loan itself never lives here), and
    `entity_code` is the loan's entity when it was saved, so a person limited
    to certain entities only lists schedules of those. `source` is 'build'
    (`params` = the inputs it was built from) or 'upload' (`file_url` = the
    bank's file in the PRIVATE task-files bucket, `column_map` = which column
    was which). `rows` is [{n, date, payment, interest, principal, balloon,
    balance}]. New table - create_all builds it; RLS must be enabled on dev
    and prod at release."""
    __tablename__ = "accounting_loan_schedules"
    id          = Column(String, primary_key=True)                # uuid
    loan_id     = Column(String, nullable=False, unique=True, index=True)
    entity_code = Column(String, default="", index=True)
    source      = Column(String, default="build")                 # build | upload
    params      = Column(JSON, default=dict)
    rows        = Column(JSON, default=list)
    column_map  = Column(JSON, default=dict)
    file_url    = Column(String, default="")
    file_name   = Column(String, default="")
    saved_by    = Column(String, default="")
    saved_at    = Column(String, default="")


class AccountingLoanStressScenario(Base):
    """A saved rate-shock scenario on one loan (Charmi and Neil, 10/06: "if
    the interest rate were to go up, we should be able to calculate if the
    income will support the loan"). `params` is what was typed (shock in bps,
    NOI, covenant, floating or fixed, amortization); the figures are always
    recomputed on screen from them. New table - create_all builds it; RLS
    must be enabled on dev and prod at release."""
    __tablename__ = "accounting_loan_stress_scenarios"
    id          = Column(String, primary_key=True)                # uuid
    loan_id     = Column(String, nullable=False, index=True)
    entity_code = Column(String, default="", index=True)
    name        = Column(String, default="")
    params      = Column(JSON, default=dict)
    saved_by    = Column(String, default="")
    saved_at    = Column(String, default="")


class RecurringExpense(Base):
    """One monthly recurring expense (MRE, Oct 6 - the expense-side mirror of
    MRI; Neil listed it as pending, Charmi wants it under Reporting next to
    MRI): a vendor (an Intacct vendor) that the entity pays from the same
    expense account(s) on a schedule - utilities, insurance, payroll
    services, software, rent paid. Debt service is NOT kept here: Loans &
    Financing covers it. What was PAID is never keyed: it is what posted to
    the line's expense accounts for that vendor in that month, read from the
    ledger (routers/accounting_mre.py). A line that stops is ENDED, not
    deleted. New table - create_all builds it; RLS by main.py and the startup
    sweep; enable it on dev and prod at release."""
    __tablename__ = "recurring_expenses"
    id               = Column(String, primary_key=True)          # uuid
    entity_code      = Column(String, default="", index=True)    # Intacct entity the expense posts to
    entity_name      = Column(String, default="")
    vendor_id        = Column(String, default="", index=True)    # Intacct vendor
    vendor_name      = Column(String, default="")
    expense_accounts = Column(JSON, default=list)                # GL codes, e.g. ["62100", "62110"]
    category         = Column(String, default="other")           # utilities | insurance | payroll_services | software | rent_paid | other
    frequency        = Column(String, default="monthly")         # monthly | quarterly | annual
    expected_amount  = Column(Float, default=0)                  # per occurrence
    start_date       = Column(String, default="")                # YYYY-MM-DD; quarterly / annual fall due from this month
    end_date         = Column(String, default="")                # '' = open-ended
    status           = Column(String, default="active")          # active | ended
    notes            = Column(String, default="")
    source           = Column(String, default="manual")          # manual | ledger
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")
    # Oct 14 (Charmi, Urmi, Neil): Custom frequency's period in months, the
    # match tolerance (0-50 in steps of 5), and the vendor-side details.
    frequency_months = Column(Integer, default=0)                # frequency == 'custom': every N months
    variance_pct     = Column(Integer, default=0)                # paid within this % of expected counts as Paid
    account_number   = Column(String, default="")                # the account number with the vendor (e.g. utility account)
    account_details  = Column(String, default="")
    contact_info     = Column(String, default="")                # name / phone / email
    # Oct 22 (Neil): the vendor's contract / document folder in Egnyte
    # ('' = not wired), and the staleness flags the daily recurring_stale
    # scan sets (see Lease.stale_*).
    egnyte_folder    = Column(String, default="")
    stale_since      = Column(String, default="")
    stale_last_paid  = Column(String, default="")
    stale_task_id    = Column(String, default="")


class PfsAffiliate(Base):
    """One entity a PFS's borrowers own or hold an interest in (Charmi, 10/04:
    "the banker wants ownership and beneficial ownership interest in all
    entities"): the Affiliated Entities tab. Kept per statement file (a
    pfs_profiles row, both borrowers of a joint statement). `ownership` is
    {"primary": pct, "co": pct} - the borrower's and the co-borrower's share.
    Only the last four digits of an EIN, never more (routers/pfs_affiliates.py
    refuses a longer number). New table - create_all builds it; RLS by the
    startup sweep and main.py."""
    __tablename__ = "pfs_affiliates"
    id             = Column(String, primary_key=True)    # uuid
    profile_id     = Column(String, index=True, nullable=False)
    sort           = Column(Integer, default=0)
    name           = Column(String, default="")
    entity_type    = Column(String, default="other")     # single_member_llc | multi_member_llc | general_partnership | limited_partnership | c_corporation | s_corporation | trust | other
    ein_last4      = Column(String, default="")
    state          = Column(String, default="")
    ownership      = Column(JSON, default=dict)
    beneficial_pct = Column(Float, nullable=True)
    role           = Column(String, default="")          # Member, Manager, Partner, Shareholder, Trustee, Beneficiary...
    notes          = Column(String, default="")
    ledger_entity  = Column(String, default="")          # Intacct entity code when picked from the ledger list
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")
    # Oct 7 (Neil): a role per borrower, keyed like `ownership` ({"primary":
    # "Managing Member", "co": "Member"}). `role` above stays = roles.primary.
    roles          = Column(JSON, default=dict)


class PfsProfileExtra(Base):
    """What a PFS file holds beyond pfs_profiles, one row per file (Charmi,
    10/04: "Executive profile should be there for both borrowers") - the
    co-borrower's executive profile, saved on its own. The borrower's stays in
    pfs_profiles.executive_profile. New table - RLS by the startup sweep and
    main.py."""
    __tablename__ = "pfs_profile_extras"
    profile_id           = Column(String, primary_key=True)
    co_executive_profile = Column(Text, default="")
    updated_by           = Column(String, default="")
    updated_at           = Column(String, default="")


class PfsAccessChallenge(Base):
    """A one-time code that opens ONE PFS file for ONE person in ONE browser
    session (Charmi, 10/04: "it should ask for OTP to the file and not to the
    module"). The code is never stored: `code_hash` is sha256 over
    "id:code", salted with an id the caller never sees. A used code becomes
    the grant: `granted_until` is when the file closes again (90 minutes).
    `session_hash` is a hash of the tab's X-Pfs-Session id. Read only by
    routers/pfs_access.py. New table - RLS by the startup sweep and main.py."""
    __tablename__ = "pfs_access_challenges"
    id            = Column(String, primary_key=True)     # uuid - also the hash salt
    profile_id    = Column(String, index=True, nullable=False)
    email         = Column(String, index=True, nullable=False)   # the viewer the code went to
    session_hash  = Column(String, default="")
    target        = Column(String, default="")           # the address it was sent to
    code_hash     = Column(String, default="")           # '' = opened without a code (the file's creator)
    attempts      = Column(Integer, default=0)
    created_at    = Column(String, default="")
    expires_at    = Column(String, default="")
    consumed_at   = Column(String, default="")
    granted_until = Column(String, default="", index=True)


class PfsAccessLog(Base):
    """Who opened which PFS file, when, and what they did (Charmi, 10/04: "it
    should maintain a log"): otp_sent, unlocked, failed, viewed, exported,
    locked, notified (the borrowers were emailed). Never a figure, never a
    code. Kept for good - nothing deletes these rows. New table - RLS by the
    startup sweep and main.py."""
    __tablename__ = "pfs_access_log"
    id         = Column(String, primary_key=True)        # uuid
    profile_id = Column(String, index=True, nullable=False)
    email      = Column(String, index=True, default="")
    action     = Column(String, default="")
    at         = Column(String, index=True, default="")
    ip         = Column(String, default="")
    details    = Column(JSON, default=dict)


class AccountingLoanSetting(Base):
    """What Nexus keeps beside one loan of Accounting > Loans & Financing
    (Charmi and Neil, 10/03-10/04). The loan itself is a fin_loans row in the
    accounting app (lender, number, entity, principal GL account, rate,
    maturity, monthly payment) - that table takes no new columns from Nexus,
    so the wiring and the links Nexus adds live here, keyed on its id: the
    interest expense account the interest is read from ('' = matched
    automatically), the original principal typed over the ledger's first
    credit (None = the ledger's), Internal / External (None = by kind:
    intercompany is internal), and the Egnyte folders of the loan documents
    and the lender's statements. New table - create_all builds it; RLS must
    be enabled on dev and prod at release."""
    __tablename__ = "accounting_loan_settings"
    loan_id            = Column(String, primary_key=True)          # fin_loans.id (uuid)
    entity_code        = Column(String, default="", index=True)    # for reference; the loan row is the truth
    interest_account   = Column(String, default="")                # GL code; '' = automatic
    original_principal = Column(Float, nullable=True)              # typed over the ledger's; None = ledger
    internal           = Column(Boolean, nullable=True)            # None = by kind
    docs_path          = Column(String, default="")                # Egnyte folder, /Shared/...
    statements_path    = Column(String, default="")                # Egnyte folder, /Shared/...
    updated_by         = Column(String, default="")
    updated_at         = Column(String, default="")
    # Oct 7 (Charmi): the loan's product - '' = guessed from the GL title,
    # 'term' or 'line_of_credit' (Draws show only for a line of credit) - and
    # whether the Stress Test leaves it out (restorable; the loan stays).
    loan_type          = Column(String, default="")
    stress_excluded    = Column(Boolean, default=False)
    # Oct 22 (Charmi): the real loan number ("these are GL codes, Loan # will be
    # different" - '' = none typed; fin_loans.loan_no kept the GL account for
    # loans set up from the ledger), and the lender's Intacct vendor id: when
    # set, Interest Paid and Principal Paid count only that vendor's lines.
    loan_number        = Column(String, default="")
    vendor_id          = Column(String, default="")
    vendor_name        = Column(String, default="")
# ── Marketing: Google Business Profile (Oct 2026) ────────────────────────────
# Neil, call of 10/01: manage the Google listings and reviews from Nexus so he
# is not the single point of failure (docs/Marketing-Module-Plan.md, Phase 2).
# One dedicated Google account (an Owner / Manager on every location) is
# connected once; everyone works through it, and Nexus records which person
# did what - Google itself shows every reply as "Response from the owner".
# New tables: create_all builds them; RLS must be enabled on dev and prod at
# release (CLAUDE.md).

class MarketingIntegrationToken(Base):
    """One connected external account per provider (encrypted, server-only).
    id is the provider: "gbp" today; Google Ads / GA4 / Meta later."""
    __tablename__ = "marketing_integration_tokens"
    id                = Column(String, primary_key=True)
    account_email     = Column(String, default="")      # the account that granted access
    account_name      = Column(String, default="")      # the provider's id for it, e.g. GBP "accounts/123..."
    account_label     = Column(String, default="")      # its display name at the provider
    refresh_token_enc = Column(Text, default="")        # secret_box-encrypted; never leaves the server
    scope             = Column(String, default="")
    connected_by      = Column(String, default="")      # the Nexus admin who connected it
    connected_at      = Column(String, default="")
    last_sync_at      = Column(String, default="")
    last_error        = Column(String, default="")
    perf_synced_at    = Column(String, default="")      # performance + keywords + photo counts (every 6 hours)
    perf_error        = Column(String, default="")      # kept apart: reviews still sync when only Performance is refused


class MarketingGbpLocation(Base):
    """A Google Business Profile location, mirrored from Google on each sync."""
    __tablename__ = "marketing_gbp_locations"
    id            = Column(String, primary_key=True)    # Google's "locations/123..."
    account_name  = Column(String, default="")
    title         = Column(String, default="")
    address       = Column(String, default="")
    place_id      = Column(String, default="")          # for the "write a review" link
    phone         = Column(String, default="")
    website       = Column(String, default="")
    facility_name = Column(String, default="", index=True)   # the property it is (mapped in Nexus)
    review_count  = Column(Integer, default=0)
    avg_rating    = Column(Float, default=0)
    listing       = Column(JSON, default=dict)          # the last Business Information read, for the edit form
    synced_at     = Column(String, default="")
    photo_count   = Column(Integer, default=0)
    last_photo_at = Column(String, default="")          # newest photo's createTime - the "stale photos" alert


class MarketingReview(Base):
    """A review and its reply, mirrored from the platform on each sync -
    platform "google" today. replied_by is the Nexus person who last replied
    FROM Nexus; blank for a reply made on the platform directly."""
    __tablename__ = "marketing_reviews"
    id               = Column(String, primary_key=True)
    platform         = Column(String, default="google", index=True)
    external_id      = Column(String, unique=True, index=True)   # GBP "accounts/../locations/../reviews/.."
    location_id      = Column(String, default="", index=True)
    reviewer_name    = Column(String, default="")
    reviewer_photo   = Column(String, default="")
    rating           = Column(Integer, default=0)
    text             = Column(Text, default="")
    reviewed_at      = Column(String, default="", index=True)
    updated_at       = Column(String, default="")
    reply_text       = Column(Text, default="")
    reply_updated_at = Column(String, default="")
    replied_by       = Column(String, default="")
    replied_at       = Column(String, default="")
    synced_at        = Column(String, default="")


class MarketingReviewAction(Base):
    """Every reply, edit and delete made from Nexus - who, what, and whether
    the platform accepted it. The accountability Google does not give."""
    __tablename__ = "marketing_review_actions"
    id          = Column(String, primary_key=True)
    review_id   = Column(String, default="", index=True)
    action      = Column(String, default="")    # reply | edit | delete
    actor_email = Column(String, default="")
    text        = Column(Text, default="")
    ok          = Column(Boolean, default=True)
    error       = Column(String, default="")
    at          = Column(String, default="")


class MarketingListingAction(Base):
    """Every listing edit made from Nexus (description, phone, website,
    hours) - who, which fields, what was sent, and whether Google accepted
    it. Google keeps no record of which manager changed a listing."""
    __tablename__ = "marketing_listing_actions"
    id          = Column(String, primary_key=True)
    location_id = Column(String, default="", index=True)
    actor_email = Column(String, default="")
    fields      = Column(String, default="")    # comma-separated updateMask, e.g. "profile.description,regularHours"
    changes     = Column(JSON, default=dict)    # the patch that was sent
    ok          = Column(Boolean, default=True)
    error       = Column(String, default="")
    at          = Column(String, default="")


class MarketingGbpDaily(Base):
    """One location's Business Profile Performance figures for one day
    (fetchMultiDailyMetricsTimeSeries). Maps / Search views add the mobile
    and desktop impressions together. Google reports a few days late, so
    the last two weeks are re-read on every performance sync."""
    __tablename__ = "marketing_gbp_daily"
    id                 = Column(String, primary_key=True)    # "<location id>|<YYYY-MM-DD>"
    location_id        = Column(String, default="", index=True)
    date               = Column(String, default="", index=True)
    maps_views         = Column(Integer, default=0)
    search_views       = Column(Integer, default=0)
    website_clicks     = Column(Integer, default=0)
    call_clicks        = Column(Integer, default=0)
    direction_requests = Column(Integer, default=0)


class MarketingGbpKeyword(Base):
    """A search term that showed a location's profile, per month
    (searchkeywords.impressions.monthly). Google gives a floor instead of a
    count for rare terms - below_threshold marks those (impressions holds the
    floor)."""
    __tablename__ = "marketing_gbp_keywords"
    id              = Column(String, primary_key=True)
    location_id     = Column(String, default="", index=True)
    month           = Column(String, default="", index=True)   # YYYY-MM
    keyword         = Column(String, default="")
    impressions     = Column(Integer, default=0)
    below_threshold = Column(Boolean, default=False)


class TicketBatch(Base):
    """One Property Walkthrough submit (Neil, 10/05/2026): many tickets at one
    property, filed together by routers/ticket_walkthroughs.py.

    `id` is generated by the form when the walkthrough opens and is the
    idempotency key: a retried submit (the phone lost signal after the server
    committed) returns the tickets already filed instead of filing them twice.
    asset_manager_email is frozen at submit so the batch email goes to whoever
    was told at the time. New table - RLS on dev AND prod (main.py list)."""
    __tablename__ = "ticket_batches"
    id                  = Column(String, primary_key=True)
    # SHA-256 of the normalized property + team + requester + lines. A retry
    # with the same id replays ONLY if this matches - a retry carrying
    # different lines is a 409, never a silent "already filed" that drops them.
    lines_hash          = Column(String, default="")
    property_asset_id   = Column(String, default="", index=True)
    property_name       = Column(String, default="")
    created_by_email    = Column(String, default="", index=True)
    requester_email     = Column(String, default="")
    company_id          = Column(String, default="")
    hr_department_id    = Column(String, default="")
    asset_manager_email = Column(String, default="")
    ticket_ids          = Column(JSON, default=list)
    ticket_count        = Column(Integer, default=0)
    note                = Column(String, default="")
    created_at          = Column(String, default="")


class TicketMaintenanceRecord(Base):
    """A resolved property ticket, added to the property's maintenance record by
    its asset manager (Pranshu, 10/06: resolved -> "Needs Action" -> "Add to
    Maintenance Record"). One per ticket. Kept here, not in the Asset
    Management workspace blob: the workspace PUT deletes and re-inserts every
    row, so a server-written row there would be erased by the next stale save.
    The Maintenance Log merges these rows in. New table - RLS (main.py list)."""
    __tablename__ = "ticket_maintenance_records"
    id                = Column(String, primary_key=True)
    ticket_id         = Column(String, default="", index=True, unique=True)
    property_asset_id = Column(String, default="", index=True)
    # The recurring-service family this belongs to: the parent ticket's id
    # (the parent itself, or a child the service opened). Blank otherwise.
    parent_ticket_id  = Column(String, default="", index=True)
    service_date      = Column(String, default="")   # YYYY-MM-DD
    system            = Column(String, default="")   # the Maintenance Log's System / Area
    description       = Column(String, default="")   # work performed
    vendor            = Column(String, default="")
    cost              = Column(String, default="")   # normalized decimal, "1250.00"
    currency          = Column(String, default="USD")   # ISO 4217 code of `cost` (any world currency)
    doc_url           = Column(String, default="")   # invoice / report (private ticket-evidence bucket)
    doc_name          = Column(String, default="")
    notes             = Column(String, default="")
    created_by_email  = Column(String, default="")
    created_at        = Column(String, default="")
    updated_at        = Column(String, default="")


class PropertyMaintenanceService(Base):
    """A recurring (or one-time) service set from a parent ticket's maintenance
    record - "Next Service Due" + how often (Pranshu, 10/06). 15 days before
    next_due the asset manager is reminded; on next_due, if nobody opened the
    service ticket, one opens automatically with the parent's details, and
    next_due moves on by the recurrence (a one-time service then ends). See
    maintenance_services.py. New table - RLS (main.py list)."""
    __tablename__ = "property_maintenance_services"
    id                 = Column(String, primary_key=True)
    property_asset_id  = Column(String, default="", index=True)
    parent_ticket_id   = Column(String, default="", index=True, unique=True)
    template           = Column(JSON, default=dict)   # what each opened ticket copies from the parent
    next_due           = Column(String, default="")   # YYYY-MM-DD
    recurrence_unit    = Column(String, default="")   # "" one time | week | month | year
    recurrence_every   = Column(Integer, default=1)
    reminder_sent_for  = Column(String, default="")   # the next_due the 15-day reminder went out for
    last_opened_for    = Column(String, default="")   # the next_due a ticket was last opened for
    last_ticket_id     = Column(String, default="")
    active             = Column(Integer, default=1)
    created_by_email   = Column(String, default="")
    created_at         = Column(String, default="")
    updated_by_email   = Column(String, default="")
    updated_at         = Column(String, default="")


# ── Marketing: Google Ads (Oct 2026, read-only) ──────────────────────────────
# Plan Phase 3. The connection is a MarketingIntegrationToken row with id
# "google_ads"; google_ads.py syncs these every 2 hours. Google Ads stays the
# source of truth - Nexus never creates or changes a campaign.

class MarketingAdsAccount(Base):
    """A Google Ads account (customer) the connection reads."""
    __tablename__ = "marketing_ads_accounts"
    id         = Column(String, primary_key=True)      # customer id, digits only
    name       = Column(String, default="")
    currency   = Column(String, default="")
    manager_id = Column(String, default="")            # the manager account it is read through ('' = directly)
    active     = Column(Boolean, default=True)         # False once it no longer appears under the connection
    synced_at  = Column(String, default="")


class MarketingAdsCampaign(Base):
    """A campaign, and the facility Nexus counts it toward (Google has no
    notion of our facilities - someone with the full grant maps it)."""
    __tablename__ = "marketing_ads_campaigns"
    id            = Column(String, primary_key=True)   # "<customer>|<campaign>"
    customer_id   = Column(String, default="", index=True)
    campaign_id   = Column(String, default="")
    name          = Column(String, default="")
    status        = Column(String, default="")         # ENABLED | PAUSED | REMOVED (Google's)
    serving       = Column(String, default="")         # campaign.serving_status: SERVING | ENDED | ...
    channel       = Column(String, default="")         # SEARCH | DISPLAY | PERFORMANCE_MAX | ...
    daily_budget  = Column(Float, default=0)
    facility_name = Column(String, default="", index=True)
    mapped_by     = Column(String, default="")
    mapped_at     = Column(String, default="")
    synced_at     = Column(String, default="")


class MarketingAdsDaily(Base):
    """One campaign's figures for one day. Cost is in the account currency."""
    __tablename__ = "marketing_ads_daily"
    id          = Column(String, primary_key=True)     # "<customer>|<campaign>|<date>"
    customer_id = Column(String, default="", index=True)
    campaign_id = Column(String, default="", index=True)
    date        = Column(String, default="", index=True)   # YYYY-MM-DD
    impressions = Column(Integer, default=0)
    clicks      = Column(Integer, default=0)
    conversions = Column(Float, default=0)
    cost        = Column(Float, default=0)


class MarketingAdsKeyword(Base):
    """One bought keyword's figures for one day (keyword_view)."""
    __tablename__ = "marketing_ads_keywords"
    id           = Column(String, primary_key=True)    # "<customer>|<campaign>|<criterion>|<date>"
    customer_id  = Column(String, default="", index=True)
    campaign_id  = Column(String, default="", index=True)
    criterion_id = Column(String, default="")
    keyword      = Column(String, default="")
    match_type   = Column(String, default="")          # EXACT | PHRASE | BROAD
    date         = Column(String, default="", index=True)
    impressions  = Column(Integer, default=0)
    clicks       = Column(Integer, default=0)
    conversions  = Column(Float, default=0)
    cost         = Column(Float, default=0)


class MarketingAdBudget(Base):
    """The monthly Google Ads budget Nexus paces spend against, per facility
    (was browser state, reset on every reload)."""
    __tablename__ = "marketing_ad_budgets"
    facility_name  = Column(String, primary_key=True)
    monthly_budget = Column(Float, default=0)
    updated_by     = Column(String, default="")
    updated_at     = Column(String, default="")


class NexusCounter(Base):
    """One row per number sequence that must never repeat - "ticket_code" and
    "task_code" today (Oct 2026). Bumped with an atomic UPDATE ... RETURNING
    inside the caller's transaction; see code_sequence.py. Never decremented,
    never reset: a number handed out stays handed out. New table - create_all
    builds it; RLS by main.py's migration list and the startup sweep, and
    enabled by hand on dev and prod at release."""
    __tablename__ = "nexus_counters"
    name       = Column(String, primary_key=True)
    value      = Column(BigInteger, nullable=False, default=0)
    updated_at = Column(String, default="")


class AccountingLoanDismissed(Base):
    """A loan-like ledger account someone removed from Accounting > Loans &
    Financing (Charmi, Oct 7: "there should be a delete option"). The
    fin_loans row is deleted in the accounting app; this remembers the entity
    + GL account so + Add > From the Ledger stops offering it (listed again
    under "Show Removed", and creating it again clears this row). New table -
    create_all builds it; RLS must be enabled on dev and prod at release."""
    __tablename__ = "accounting_loan_dismissed"
    id           = Column(String, primary_key=True)                # uuid
    entity_code  = Column(String, nullable=False, index=True)
    gl_account   = Column(String, nullable=False)
    loan_id      = Column(String, default="")                      # the fin_loans id it had
    lender       = Column(String, default="")
    title        = Column(String, default="")
    dismissed_by = Column(String, default="")
    dismissed_at = Column(String, default="")
    __table_args__ = (UniqueConstraint("entity_code", "gl_account", name="uq_accounting_loan_dismissed"),)


class AccountingLoanStressEntity(Base):
    """Per entity on Loans & Financing > Stress Test (Charmi, Oct 7): which
    NOI the DSCR starts from (`noi_basis`: t12 | ytd | manual, '' = the page
    default), the typed NOI for Manual, and the Addback (typed, with a note -
    depreciation, one-off costs, owner comp) that makes Adjusted NOI = NOI +
    Addback. New table - create_all builds it; RLS must be enabled on dev
    and prod at release."""
    __tablename__ = "accounting_loan_stress_entities"
    entity_code  = Column(String, primary_key=True)
    noi_basis    = Column(String, default="")
    noi_manual   = Column(Float, nullable=True)
    addback      = Column(Float, nullable=True)
    addback_note = Column(String, default="")
    updated_by   = Column(String, default="")
    updated_at   = Column(String, default="")


class AccountingAmaAgreement(Base):
    """One Asset Management Agreement (AMA, Priyanka, Oct 7: "We still need to
    build AMA"): the fee one entity (the manager, optional) earns for managing
    another (the managed ledger entity) - a percent of the managed entity's
    revenue or a flat amount per billing period, billed monthly, quarterly or
    annually. What was BILLED is never keyed: it is the net credits on
    `fee_gl_account` read from the ledger (routers/accounting_ama.py). New
    table - create_all builds it; RLS by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_agreements"
    id                  = Column(String, primary_key=True)            # uuid
    entity_code         = Column(String, nullable=False, index=True)  # the managed ledger entity
    manager_entity_code = Column(String, default="")                  # the entity that earns / bills the fee
    status              = Column(String, default="Active")            # Active | Pending Review | Ended
    fee_basis           = Column(String, default="percent_revenue")   # percent_revenue | flat | percent_or_flat
    fee_rate            = Column(Float, nullable=True)                # percent, for percent_revenue / percent_or_flat
    flat_amount         = Column(Float, nullable=True)                # per billing period (flat); the "else" fee (percent_or_flat)
    billing_frequency   = Column(String, default="Monthly")           # Monthly | Quarterly | Annually
    start_date          = Column(String, default="")                  # YYYY-MM-DD
    end_date            = Column(String, default="")                  # '' = open-ended
    fee_gl_account      = Column(String, default="")                  # GL code the fee posts to (Billed YTD)
    agreement_url       = Column(String, default="")                  # Egnyte / SharePoint link
    notes               = Column(String, default="")
    created_by          = Column(String, default="")
    created_at          = Column(String, default="")
    updated_by          = Column(String, default="")
    updated_at          = Column(String, default="")
    # Oct 23 (Charmi, CR-03): percent_or_flat charges fee_rate % of gross when
    # the gross is above threshold_amount, else flat_amount. threshold_basis
    # annual | period ('' = accounting_assumptions default). Additive, NULL on
    # every older agreement.
    threshold_amount    = Column(Float, nullable=True)
    threshold_basis     = Column(String, default="")


class Announcement(Base):
    """One company or department announcement (Essentials, Oct 7) for the
    Announcements dashboard tile. `audience` company = everyone, department =
    only `department`; `pinned_until` keeps it at the top until that date;
    `requires_ack` asks each reader to acknowledge it (AnnouncementRead).
    Soft-deleted through `deleted_at` so read marks keep their history. New
    table - create_all builds it; RLS by main.py and the startup sweep."""
    __tablename__ = "nexus_announcements"
    id           = Column(String, primary_key=True)             # uuid
    title        = Column(String, default="")
    body         = Column(Text, default="")
    author_email = Column(String, default="", index=True)
    audience     = Column(String, default="company")            # company | department
    department   = Column(String, default="")                   # for audience = department
    pinned_until = Column(String, default="")                   # ISO date, '' = not pinned
    requires_ack = Column(Boolean, default=False)
    created_at   = Column(String, default="")                   # ISO timestamp
    updated_at   = Column(String, default="")
    deleted_at   = Column(String, default="", index=True)       # '' = live


class AnnouncementRead(Base):
    """One person's read / acknowledge mark on one announcement (Essentials,
    Oct 7). One row per (announcement, email); `acknowledged_at` stays '' until
    they acknowledge an announcement that requires it. New table - create_all
    builds it; RLS by main.py and the startup sweep."""
    __tablename__ = "nexus_announcement_reads"
    id              = Column(String, primary_key=True)          # uuid
    announcement_id = Column(String, default="", index=True)
    email           = Column(String, default="", index=True)
    read_at         = Column(String, default="")
    acknowledged_at = Column(String, default="")


class HrPacketSetting(Base):
    """Which Nexus Sign template a company sends for an HR life event
    (Neil/Pranshu call, Oct 8): the hiring packet, a promotion letter, a
    separation package. One row per (company, event, worker type); entity_id ''
    is the default every company falls back to, worker_type 'any' covers both
    employees and contractors. The template carries the merged PDFs and the
    signer roles; `subject_role` is the role the person signs as - every other
    role is signed by the HR sender, who countersigns after the person (the
    person signs first - Neil, Oct 22 2026).
    New table - RLS per CLAUDE.md (main.py list + the startup sweep)."""
    __tablename__ = "hr_packet_settings"
    id               = Column(String, primary_key=True)           # uuid
    entity_id        = Column(String, default="", index=True)     # HrEntity.id ('' = every company)
    event            = Column(String, nullable=False)             # offer | hire | promotion | separation
    worker_type      = Column(String, default="any")              # any | employee | contractor
    template_id      = Column(String, default="")                 # HrSignTemplate.id
    subject_role     = Column(String, default="employee")         # template role the person signs as
    email_message    = Column(Text, default="")                   # welcome / cover note shown in the signing email
    egnyte_subfolder = Column(String, default="")                 # under the person folder ('' = event default)
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")
    created_at       = Column(String, default="")
    # The company's job roles this packet is for (NexusGroup ids); [] = every
    # role the company has no role-specific packet for. A company hiring for
    # IT and Accounting sends each its own packet (Pranshu, Oct 8).
    role_ids         = Column(JSON, default=list)
    # Packets built from the Documents module (Neil, Oct 14). engine 'pdf' is
    # the uploaded-PDF packet above (template_id); 'documents' is an ordered
    # list of Documents templates (doc_template_ids, read at their PUBLISHED
    # version) signed in an order defined by ROLE, never by person:
    # flow = [{key, role, action}] - key is the signer key the templates'
    # signature blocks name, role is a checklist role (hr_checklists.ROLES)
    # or signatory / sender, action is sign | approve | copy. The verifier
    # (verify_role) checks the generated documents before anything is sent.
    name             = Column(String, default="")
    engine           = Column(String, default="pdf")              # pdf | documents
    doc_template_ids = Column(JSON, default=list)                 # DocTemplate ids, in order
    flow             = Column(JSON, default=list)                 # [{key, role, action}]
    verify_role      = Column(String, default="hr")               # who checks before it is sent
    verify_distinct  = Column(Integer, default=0)                 # 1 = the verifier cannot be who started it
    letterhead_id    = Column(String, default="")                 # DocLetterhead for templates that require one
    pay_mode         = Column(String, default="")                 # '' by event | always | auto
    # The packet's own Details Form (Oct 14): fields the person (or HR) fills
    # in beyond name / phone / address / emergency contact - any country, any
    # field. [{key, label, type, required, options, sensitive, last4, help}];
    # each key is a {{variable}} the packet's templates can print.
    details_form     = Column(JSON, default=list)
    # Signs Once (Oct 14): the company signature a step marked `once` applies
    # to every packet, adopted ONCE by whoever holds that role for the
    # company. [{step, entityId, email, name, kind, data, digest, adoptedAt,
    # consentVersion, otpChallengeId, ip, userAgent, replacedAt}] - never
    # deleted; a new holder's adoption marks the old one replaced.
    saved_signatures = Column(JSON, default=list)
    # Offer letters (event 'offer', Oct 14) and hiring packets are also picked
    # by where the person works - "if it's an Indian contractor, it needs a
    # different document" (Neil): ISO country code, '' = any country.
    country          = Column(String, default="")
    # Building blocks (Oct 14): documents added for a team or a role on top
    # of doc_template_ids - "there's a different confidentiality agreement for
    # each team" (Neil). [{match: department | role, value, templateIds: []}]
    extra_docs       = Column(JSON, default=list)
    # Where the person works, inside the country (Neil, Oct 22): "there is a
    # hiring packet that applies to California... when we open Texas we'll add
    # one for Texas". A US state code (CA, TX), '' = anywhere in the country.
    region           = Column(String, default="")
    # Use The Same (Hiring Setup, Oct 23 2026): an archived row is this level's
    # own letter or packet put aside so the level above applies again - never
    # sent, never deleted, restorable. '' = live.
    archived_at      = Column(String, default="")
    archived_by      = Column(String, default="")


class HrLifeEvent(Base):
    """One HR life event run through Nexus Sign (hire, promotion, separation):
    what HR entered, the envelope, what was applied when it was signed, and
    where the signed packet was filed in Egnyte. hr_life_events.py drives it;
    Nexus Sign moves it along through HrSignRequest.link_kind 'life_event'.
    `pay` is salary data - only ever returned to hr_comp holders.
    New table - RLS per CLAUDE.md (main.py list + the startup sweep)."""
    __tablename__ = "hr_life_events"
    id              = Column(String, primary_key=True)            # uuid
    kind            = Column(String, nullable=False, index=True)  # offer | hire | promotion | separation
    status          = Column(String, default="awaiting_sender")   # awaiting_sender | sent | completed | declined | voided | expired
    entity_id       = Column(String, default="", index=True)      # HrEntity.id
    candidate_id    = Column(String, default="", index=True)      # hire: HrCandidate.id
    employee_id     = Column(String, default="", index=True)      # NexusEmployee.id (set at hire completion for a hire)
    subject_name    = Column(String, default="")
    subject_email   = Column(String, default="")                  # where the packet went
    setting_id      = Column(String, default="")                  # HrPacketSetting.id used
    template_id     = Column(String, default="")
    sign_request_id = Column(String, default="", index=True)      # HrSignRequest.id
    inputs          = Column(JSON, default=dict)                  # non-pay details (title, start date, supervisor, ...)
    pay             = Column(JSON, default=dict)                  # RESTRICTED: {base, payBasis, frequency, currency}
    effective_date  = Column(String, default="")                  # YYYY-MM-DD (start date / promotion date / last day)
    applied_at      = Column(String, default="")
    apply_status    = Column(String, default="", index=True)  # separation: scheduled | applied | canceled
    apply_note      = Column(String, default="")
    flags           = Column(JSON, default=list)                  # [{code, message}] for HR to review (e.g. signed timesheet periods)
    filing_status   = Column(String, default="")                  # '' | pending | filed | failed
    filing_path     = Column(String, default="")
    filing_error    = Column(String, default="")
    filing_attempts = Column(Integer, default=0)
    filing_next_at  = Column(String, default="", index=True)      # ISO UTC; the filing loop picks rows due
    decline_reason  = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")
    completed_at    = Column(String, default="")
    # Packets built from Documents (Oct 14). The generated Document rows
    # ([{documentId, templateId, templateVersion, valuesHash, title}]); the
    # pay HR typed per pay variable ("$22.00 per hour plus commission") -
    # RESTRICTED like `pay`, never written onto a document; the person's
    # details (legal name, address, phone, emergency contact) whoever typed
    # them; and who verified the documents before they went out.
    documents       = Column(JSON, default=list)
    pay_values      = Column(JSON, default=dict)
    intake          = Column(JSON, default=dict)
    verified_by     = Column(String, default="")
    verified_at     = Column(String, default="")
    # The candidate fills in their own details through a link (Oct 14). Only
    # the token's sha256 is stored; the link dies after the offer expires.
    intake_token_hash   = Column(String, default="", index=True)
    intake_expires_on   = Column(String, default="")
    intake_sent_at      = Column(String, default="")
    intake_submitted_at = Column(String, default="")


class NexusWorkforceScorecardLog(Base):
    """One row per manager per scored week a Workforce Scorecard email was
    generated (workforce_scorecard.py, Oct 10 2026) - the once-a-week dedupe
    check and what the admin Delivery Log reads. New table - create_all
    builds it; main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "nexus_workforce_scorecard_log"
    id            = Column(String, primary_key=True)   # uuid
    manager_email = Column(String, index=True, nullable=False)
    week_start    = Column(String, index=True, nullable=False)  # first day of the scored week, YYYY-MM-DD
    scope         = Column(String, default="team")      # team|all - what the email covered
    sent_at       = Column(String, default="")          # UTC iso; '' when nothing was mailed
    mode          = Column(String, default="off")       # off|test|live - which config this run used
    people_count  = Column(Integer, default=0)          # people on the scorecard
    absent_count  = Column(Integer, default=0)          # absent all week
    below_count   = Column(Integer, default=0)          # below expected + well below
    created_at    = Column(String, default="")


class CubbyDailySnapshot(Base):
    """One row per storage facility per day, written by cubby.py each time the
    Operations figures are pulled (Oct 2026). Cubby reports today only; this is
    the history behind the trend charts. Counts and cents - no tenant details.
    New table - create_all builds it; main._enable_rls_everywhere turns RLS on
    at startup."""
    __tablename__ = "cubby_daily_snapshots"
    id                     = Column(String, primary_key=True)   # "<facility_id>:<YYYY-MM-DD>"
    facility_id            = Column(String, index=True, nullable=False)
    snapshot_date          = Column(String, index=True, nullable=False)  # facility-local day, YYYY-MM-DD
    units_total            = Column(Integer, default=0)
    units_rented           = Column(Integer, default=0)
    units_vacant           = Column(Integer, default=0)
    units_unavailable      = Column(Integer, default=0)
    area_total             = Column(Integer, default=0)          # square feet
    area_rented            = Column(Integer, default=0)
    rent_roll_cents        = Column(BigInteger, default=0)
    vacant_potential_cents = Column(BigInteger, default=0)
    past_due_cents         = Column(BigInteger, default=0)
    past_due_tenants       = Column(Integer, default=0)
    autopay_count          = Column(Integer, default=0)
    captured_at            = Column(String, default="")          # UTC iso of the last pull that day


class OpsCompetitor(Base):
    """A nearby storage facility whose rates one of ours is compared against
    (Operations -> Market Rates, Oct 2026). `facility_id` is OUR Cubby facility
    it competes with. Removing one sets `active` false - its recorded rates are
    history and stay. New table - create_all builds it;
    main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "ops_competitors"
    id             = Column(String, primary_key=True)   # uuid
    facility_id    = Column(String, index=True, nullable=False)
    name           = Column(String, default="")
    address        = Column(String, default="")
    distance_miles = Column(Float, default=0)
    website        = Column(String, default="")
    notes          = Column(Text, default="")
    active         = Column(Boolean, default=True)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    # Market engine (ops_market_engine.py, Oct 2026). Where it is, which
    # OpenStreetMap entry it was added from ("node/123"), the public page its
    # prices are read from, and how the last read went.
    lat             = Column(Float)
    lng             = Column(Float)
    osm_id          = Column(String, default="")
    rates_url       = Column(String, default="")    # defaults to the website; editable
    last_checked_at = Column(String, default="")    # UTC ISO
    last_status     = Column(String, default="")    # ok | no_rates_found | blocked_by_robots | blocked | unreachable | not_connected | error
    last_detail     = Column(String, default="")
    watch           = Column(Boolean, default=True) # read by the daily run
    # StorTrack (Cubby's competitor rate feed, ops_stortrack.py, Oct 2026):
    # "name|street|zip" normalized, set on a competitor the feed added or
    # matched, so the next import finds it again.
    stortrack_key   = Column(String, default="", index=True)
    # CMA (Miranda, Oct 21 2026, ops_cma.py). A CLOSED competitor is kept for
    # history but counts nowhere: closing sets `active` false too, so every
    # market figure already leaves it out; `closed` tells it apart from one
    # that was just removed. `price_source` "manual" = only staff-entered
    # rates count for it (website / StorTrack reads are ignored).
    closed          = Column(Boolean, default=False)
    closed_note     = Column(String, default="")
    price_source    = Column(String, default="")    # "" = website and manual | "manual" = manual only
    phone           = Column(String, default="")
    property_type   = Column(String, default="")    # "Self-Storage & RV Storage"


class OpsCompetitorRate(Base):
    """One observation of a competitor's rate for one unit size, with the day
    it was seen. Rows are only ever added - the newest per competitor and size
    is "the market", the rest is how it moved."""
    __tablename__ = "ops_competitor_rates"
    id            = Column(String, primary_key=True)   # uuid
    competitor_id = Column(String, index=True, nullable=False)
    facility_id   = Column(String, index=True, nullable=False)   # ours, copied from the competitor for one-table reads
    width         = Column(Float, default=0)                      # feet
    depth         = Column(Float, default=0)
    parking       = Column(Boolean, default=False)                # parking and storage are separate markets
    rate_cents    = Column(Integer, default=0)                    # per month
    promo         = Column(String, default="")                    # "First month free", as advertised
    observed_on   = Column(String, default="", index=True)        # YYYY-MM-DD
    source        = Column(String, default="manual")              # manual | import | web (read from the competitor's page)
    entered_by    = Column(String, default="")
    created_at    = Column(String, default="")
    # StorTrack (ops_stortrack.py, Oct 2026; source "stortrack"). rate_cents
    # stays the standard (regular) rate like every other source; the feed
    # also carries the web price and the promotional price, and tells unit
    # variants of one size apart. None = the source did not say.
    online_cents  = Column(Integer)
    promo_cents   = Column(Integer)
    climate       = Column(Boolean)
    drive_up      = Column(Boolean)
    elevator      = Column(Boolean)
    space_type    = Column(String, default="")
    # CMA (Oct 21 2026, ops_cma.py): a manual survey row or a locked override.
    # source "override" = staff replaced a website price; it beats newer
    # website / StorTrack reads for that size until `locked_until` passes.
    survey_id         = Column(String, default="", index=True)
    their_size        = Column(String, default="")    # as quoted: "8 x 10"
    matched_unit_type = Column(String, default="")    # our unit type (Cubby pricing group) staff matched it to
    size_note         = Column(String, default="")    # "Nearest size ..."
    locked_until      = Column(String, default="")    # YYYY-MM-DD
    override_reason   = Column(String, default="")


# ---------------------------------------------------------------------------
# Site Models (Neil, Oct 11 2026): a pin an owner dropped on a property's 3D
# site model - "this spot needs attention". Position is in the model's local
# meter frame (u along the site axis, v toward the northeast, y up); `unit` is
# the Cubby unit number when the pin sits on one. The model itself is a JSON
# file (backend/site_models/), not a table. Enable RLS on dev and prod.
# ---------------------------------------------------------------------------
class SiteModelMarkup(Base):
    __tablename__ = "site_model_markups"
    id          = Column(String, primary_key=True)   # uuid
    property_id = Column(String, index=True, default="")
    unit        = Column(String, default="")
    building    = Column(String, default="")
    u           = Column(Float, default=0.0)
    v           = Column(Float, default=0.0)
    y           = Column(Float, default=0.0)
    title       = Column(String, default="")
    category    = Column(String, default="maintenance")   # maintenance | inspection | note
    status      = Column(String, default="open")          # open | done
    ticket_id   = Column(String, default="")
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    # Mark an Issue on the Map (Charmi, Oct 20 2026 - ticket_map_spot.py): a
    # ticket's spot is one of these rows (ticket_id set) - the circle's radius
    # in meters (0 = a point), the free-hand outline as JSON [[u, v], ...], the
    # spot on the globe from the model's geo frame, and "Near C214, Building C".
    radius      = Column(Float, default=0.0)
    outline     = Column(Text, default="")
    lat         = Column(Float, nullable=True)
    lng         = Column(Float, nullable=True)
    place       = Column(String, default="")
    updated_at  = Column(String, default="")   # site_models.py has always written it


class WeatherOutlook(Base):
    """The latest forecast band for one shift group on one day (Weather Call,
    Oct 2026) - written by weather_watch.scan_once every half hour, read by
    the schedule grid, which never calls a weather service itself. id is
    "<group_id>:<YYYY-MM-DD>" so the scan upserts. New table - create_all
    builds it; main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "weather_outlook"
    id           = Column(String, primary_key=True)
    group_id     = Column(String, default="", index=True)
    work_date    = Column(String, default="", index=True)   # YYYY-MM-DD, site-local
    band         = Column(String, default="quiet")          # quiet | heads_up | major | warning
    chance       = Column(Integer, default=0)               # highest rain chance in the scheduled hours, %
    inches       = Column(Float, default=0)                 # rain expected over the scheduled hours
    storm        = Column(Integer, default=0)               # 1 = a thunderstorm hour reached the storm chance
    alerts_json  = Column(String, default="")               # NWS warnings in force that day (JSON list of events)
    window_start = Column(String, default="")               # "7:00 AM" - the scheduled hours the band covers
    window_end   = Column(String, default="")
    hourly_json  = Column(String, default="")               # [{time, chance, inches, code}] for those hours
    shifts       = Column(Integer, default=0)
    people       = Column(Integer, default=0)
    timezone     = Column(String, default="")               # the site's zone, from the forecast
    updated_at   = Column(String, default="")


class WeatherAdvisory(Base):
    """Every weather notice the watch sent for a group-day (Weather Call,
    Oct 2026): the record for later ("we told them on Thursday at 4 PM, here
    is the forecast as it stood") and the dedupe - one notice per group, day
    and band. band is major | warning (the advisory), heads_up (the quiet
    Teams line) or eased (the all-clear bell). channels_json says what went
    where and why anything did not. New table - create_all builds it;
    main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "weather_advisories"
    id              = Column(String, primary_key=True)
    group_id        = Column(String, default="", index=True)
    work_date       = Column(String, default="", index=True)
    band            = Column(String, default="")
    chance          = Column(Integer, default=0)
    inches          = Column(Float, default=0)
    storm           = Column(Integer, default=0)
    alerts_json     = Column(String, default="")
    window_start    = Column(String, default="")
    window_end      = Column(String, default="")
    recipients_json = Column(String, default="")   # who was told (emails)
    channels_json   = Column(String, default="")   # {"bell": n, "teams": "ok" | reason, "email": n, "dayNote": bool}
    snapshot_json   = Column(String, default="")   # the hours the band was computed from
    created_at      = Column(String, default="", index=True)


class WeatherDecision(Base):
    """A weather call (Weather Call, Phase 2 - Oct 2026): what a decider did
    about one shift group's day because of the weather, and who was told.
    kind: cancel (the day is off and UNPAID for the people picked), delay
    (start later), end_early, move (another site or indoor work), proceed
    (the plan stands despite the forecast). people_json is the roster as it
    stood - every person on the day with selected / outcome / their shift
    ids / original times / each channel's result / acknowledgment time -
    so the record answers "who was told what, when, and did they see it"
    without the shifts. status: active | superseded (a later call on the
    same day) | reinstated (undone by Reinstate). New table - create_all
    builds it; main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "weather_decisions"
    id             = Column(String, primary_key=True)
    group_id       = Column(String, default="", index=True)
    work_date      = Column(String, default="", index=True)
    company        = Column(String, default="")
    kind           = Column(String, default="")
    new_start      = Column(String, default="")   # delay: the new start (HH:MM)
    new_end        = Column(String, default="")   # end_early: the new end
    move_to        = Column(String, default="")   # move: where
    reason         = Column(String, default="")
    sms            = Column(Integer, default=1)   # the crew was texted (unless opted out / no phone)
    people_json    = Column(Text, default="")
    outlook_json   = Column(String, default="")   # the forecast band as it stood when the call was made
    status         = Column(String, default="active", index=True)
    decided_by     = Column(String, default="")
    decided_at     = Column(String, default="", index=True)
    escalated_at   = Column(String, default="")   # the decider was told who had not acknowledged
    reinstated_by  = Column(String, default="")
    reinstated_at  = Column(String, default="")


class NexusPersonPref(Base):
    """A person's own notification switches that are not about tasks
    (task_notify_prefs covers those). First use: weather_sms - whether a
    weather call texts them (on by default; Neil, Oct 10). New table -
    create_all builds it; RLS from the startup sweep."""
    __tablename__ = "nexus_person_prefs"
    email       = Column(String, primary_key=True)
    weather_sms = Column(Integer, default=1)
    updated_at  = Column(String, default="")
    # Shifts Phase 3a (Neil, Oct 14 2026, shift_calendar.py): 1 = their shared
    # shifts go onto their Outlook calendar (the company switch must be on
    # too); 0 = they opted out. Added column -> ALTER lines in main.py.
    shift_calendar = Column(Integer, default=1)
    # The per-person salt in their calendar subscribe link (routers/
    # shift_ical.py): rotating it invalidates every link issued before.
    ical_salt   = Column(String, default="")
    # Profile > Date Format (Pranshu, Oct 20 2026): how this person reads dates
    # across Nexus - one of routers/roles.DATE_FORMATS; '' = the US default.
    date_format = Column(String, default="")
    # Ticket Reports (Oct 2026, ticket_reports.py): their own choice for the
    # Monday Weekly Ticket Report email - NULL = unset (the desk-access
    # mode's default: on for roster supervisors, off under legacy), 1 = on,
    # 0 = off. No column default on purpose. ALTER lines in main.py.
    ticket_weekly_report = Column(Integer, nullable=True, default=None)
    # Tasks Home > Updates (Neil, Oct 21 2026): when this person last looked
    # at the card, so it can mark what arrived since - on the server so a
    # phone and a desktop agree. ALTER lines in main.py.
    updates_seen_at = Column(String, default="")


class TaskAutomationRun(Base):
    """One firing of a task automation rule (task_automation.py, Oct 2026):
    what rule, on which task, what it did - the Runs panel under Manage >
    Automation Rules, and the once-per-rule-per-task-per-date dedupe for the
    scheduled "due date arrives" trigger (`dedupe_key` = rule:task:date, blank
    for edit-driven runs). New table - create_all builds it;
    main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "task_automation_runs"
    id           = Column(String, primary_key=True)
    rule_id      = Column(String, default="", index=True)
    rule_name    = Column(String, default="")           # captured so the log reads after the rule is deleted
    task_id      = Column(String, default="", index=True)
    task_code    = Column(String, default="")
    task_title   = Column(String, default="")
    trigger_type = Column(String, default="")
    event        = Column(String, default="")           # created|updated|bulk|scheduled
    actions      = Column(JSON, default=list)           # human lines, one per action applied
    status       = Column(String, default="applied")    # applied|error
    detail       = Column(String, default="")           # the error, when status is error
    dedupe_key   = Column(String, default="", index=True)
    at           = Column(String, default="", index=True)


class TaskChecklistItem(Base):
    """One line of a task's checklist (Oct 2026): the small steps inside a
    task that do not deserve to be subtasks - "call the vendor", "attach the
    photo". Flat, ordered, each line can be ticked and can name a person.
    Task.checklist_total / checklist_done are kept in step by
    routers/tasks._recount_checklist. New table - create_all builds it;
    main._enable_rls_everywhere turns RLS on at startup."""
    __tablename__ = "task_checklist_items"
    id             = Column(String, primary_key=True)
    task_id        = Column(String, default="", index=True)
    title          = Column(String, nullable=False)
    done           = Column(Boolean, default=False)
    done_at        = Column(String, default="")
    done_by        = Column(String, default="")
    assignee_email = Column(String, default="")
    position       = Column(Float, default=0)
    created_at     = Column(String, default="")
    created_by     = Column(String, default="")


class TaskTimeEntry(Base):
    """One stretch of time a person spent on a task (Oct 2026): a timer they
    started and stopped, or minutes they typed in afterwards. Deliberately
    NOT a Time Clock punch: punches are attendance and payroll
    (timeclock.py); this is effort against a task, and nothing here touches a
    timesheet. One running entry (ended_at blank) per person at a time.
    New table - create_all builds it; main._enable_rls_everywhere turns RLS on
    at startup."""
    __tablename__ = "task_time_entries"
    id           = Column(String, primary_key=True)
    task_id      = Column(String, default="", index=True)
    person_email = Column(String, default="", index=True)
    started_at   = Column(String, default="")          # UTC iso; for a manual entry, the day it was for (noon UTC)
    ended_at     = Column(String, default="", index=True)   # blank while the timer runs
    minutes      = Column(Integer, default=0)          # whole minutes, set when stopped or typed
    note         = Column(String, default="")
    billable     = Column(Boolean, default=False)
    source       = Column(String, default="timer")     # timer|manual
    created_at   = Column(String, default="")
    # One running entry per person, enforced by the database: two Starts at
    # the same moment (double-click, second tab) cannot both land. Partial
    # unique index - SQLite and Postgres both support the WHERE. Existing
    # databases get it from main.py's migration lists.
    __table_args__ = (
        Index("ux_task_time_running", "person_email", unique=True,
              sqlite_where=(ended_at == ""), postgresql_where=(ended_at == "")),
    )


class HrRoleChangeRequest(Base):
    """A role change that is not a promotion (Pranshu, Oct 13): an admin or HR
    asks, with a reason; the employee's manager OR their company's HR contact
    approves, and only then does the role change. Declined / canceled requests
    stay as the record. role_change.py drives it.
    New table - RLS per CLAUDE.md (main.py list + the startup sweep)."""
    __tablename__ = "hr_role_change_requests"
    id                = Column(String, primary_key=True)            # uuid
    employee_id       = Column(String, default="", index=True)      # NexusEmployee.id
    employee_email    = Column(String, default="", index=True)
    employee_name     = Column(String, default="")
    company           = Column(String, default="")                  # HrEntity.id
    from_role_id      = Column(String, default="")
    from_title        = Column(String, default="")
    to_role_id        = Column(String, default="")
    to_role_name      = Column(String, default="")
    reason            = Column(String, default="")                  # shown to the approvers
    status            = Column(String, default="pending", index=True)   # pending | approved | declined | canceled
    approvers         = Column(JSON, default=list)                  # [{email, name, as: manager|hr}]
    requested_by      = Column(String, default="")
    requested_by_name = Column(String, default="")
    created_at        = Column(String, default="")
    decided_by        = Column(String, default="")                  # approver / decliner / whoever canceled
    decided_at        = Column(String, default="")
    decision_note     = Column(String, default="")                  # why it was declined


# ── Cubby -> Supabase (Operations, Oct 15 2026) ──────────────────────────────
# cubby_sync.py copies what the Operations screen uses from Cubby into these
# tables every 15 minutes; the screen, the unit lookup and the report exports
# read only from here (cubby.py). Keyed "<facility_id>:<cubby id>". `data` is
# the Cubby row as summarize_facility reads it, with phone, email, address,
# date of birth and ID numbers stripped before it is written - never stored.
# New tables - create_all builds them; RLS per CLAUDE.md (main.py list + the
# startup sweep).

class CubbyFacility(Base):
    """One Cubby facility. `enabled` false = no longer in Cubby's list (its rows stay)."""
    __tablename__ = "cubby_facilities"
    facility_id             = Column(String, primary_key=True)
    organization            = Column(String, default="")
    name                    = Column(String, default="")
    time_zone               = Column(String, default="")
    enabled                 = Column(Boolean, default=True)
    data                    = Column(JSON, default=dict)     # facilityId, name, internalName, timeZone, latitude, longitude
    synced_at               = Column(String, default="")     # UTC iso of this facility's last good sync
    payments_synced_through = Column(String, default="")     # YYYY-MM-DD; '' = payments not backfilled yet


class CubbyUnit(Base):
    """A unit: its rent-roll line (status, rates, tenant name) and its units/search row (rentability)."""
    __tablename__ = "cubby_units"
    id          = Column(String, primary_key=True)          # "<facility_id>:<unitId>"
    facility_id = Column(String, index=True, nullable=False)
    unit_id     = Column(String, default="")
    unit_name   = Column(String, default="")
    status      = Column(String, default="")                # RENTED | VACANT | ...
    customer_id = Column(String, default="", index=True)
    data        = Column(JSON, default=dict)                # {"rentRoll": {...} | null, "unit": {...} | null}


class CubbyRental(Base):
    """A tenancy (Cubby lease), past or current."""
    __tablename__ = "cubby_rentals"
    id            = Column(String, primary_key=True)        # "<facility_id>:<leaseId>"
    facility_id   = Column(String, index=True, nullable=False)
    lease_id      = Column(String, default="")
    unit_id       = Column(String, default="")
    customer_id   = Column(String, default="", index=True)
    move_in_date  = Column(String, default="", index=True)  # YYYY-MM-DD
    move_out_date = Column(String, default="")
    data          = Column(JSON, default=dict)


class CubbyCustomer(Base):
    """A customer's NAME only (leads/search returns an id, the screen shows the name)."""
    __tablename__ = "cubby_customers"
    id          = Column(String, primary_key=True)          # "<facility_id>:<customerId>"
    facility_id = Column(String, index=True, nullable=False)
    customer_id = Column(String, default="")
    name        = Column(String, default="")


class CubbyPayment(Base):
    """A payment. Kept incrementally: each sync re-reads the last 45 days."""
    __tablename__ = "cubby_payments"
    id           = Column(String, primary_key=True)         # "<facility_id>:<paymentId>"
    facility_id  = Column(String, index=True, nullable=False)
    payment_id   = Column(String, default="")
    customer_id  = Column(String, default="", index=True)
    payment_date = Column(String, default="", index=True)   # the date Cubby's payments/search filters on, YYYY-MM-DD
    status       = Column(String, default="")
    amount_cents = Column(BigInteger, default=0)
    data         = Column(JSON, default=dict)
    __table_args__ = (Index("ix_cubby_payments_facility_date", "facility_id", "payment_date"),)


class CubbyLead(Base):
    __tablename__ = "cubby_leads"
    id          = Column(String, primary_key=True)          # "<facility_id>:<leadId>"
    facility_id = Column(String, index=True, nullable=False)
    lead_id     = Column(String, default="")
    customer_id = Column(String, default="")
    status      = Column(String, default="")
    created_at  = Column(String, default="")                # Cubby's createdAt
    data        = Column(JSON, default=dict)


class CubbyReceivable(Base):
    """One aged-receivables line: what a tenant owes on a unit, by age."""
    __tablename__ = "cubby_receivables"
    id          = Column(String, primary_key=True)          # "<facility_id>:<unitId>:<customerId>"
    facility_id = Column(String, index=True, nullable=False)
    unit_id     = Column(String, default="")
    customer_id = Column(String, default="")
    total_cents = Column(BigInteger, default=0)
    data        = Column(JSON, default=dict)


class CubbyTask(Base):
    """An OPEN Cubby task (the worklist)."""
    __tablename__ = "cubby_tasks"
    id          = Column(String, primary_key=True)          # "<facility_id>:<taskId>"
    facility_id = Column(String, index=True, nullable=False)
    task_id     = Column(String, default="")
    unit_id     = Column(String, default="")
    due_date    = Column(String, default="")
    data        = Column(JSON, default=dict)


class CubbySyncRun(Base):
    """One Cubby -> database sync. At most one is `running` at a time (the
    partial unique index is the lock, so it holds across workers and instances).
    `facilities` = {facility_id: {name, status, counts, error}}. Error text
    never carries the key or tenant data."""
    __tablename__ = "cubby_sync_runs"
    id           = Column(String, primary_key=True)         # uuid
    trigger      = Column(String, default="")               # schedule | manual | first-read
    requested_by = Column(String, default="")               # staff email for a manual run
    started_at   = Column(String, default="", index=True)   # UTC iso
    finished_at  = Column(String, default="")
    status       = Column(String, default="running")        # running | ok | partial | failed
    facilities   = Column(JSON, default=dict)
    error        = Column(Text, default="")
    __table_args__ = (
        Index("ux_cubby_sync_running", "status", unique=True,
              sqlite_where=(status == "running"), postgresql_where=(status == "running")),
    )


class AccountingAmaThread(Base):
    """One "Ask My Accountant" question on one ledger line (Neil, 10/15: AMA
    means Ask My Accountant). Keyed by the line, with a snapshot of it (entity,
    entry, line, account, date, amount, memo) so the thread still reads after
    Intacct changes or reclasses the line. `status` runs Open -> Answered (the
    assigned accountant replied) -> Resolved (asker, accountant or an editor;
    `moved_to_account` says where it went). `reclassed_at` is stamped when a
    line on an Ask My Accountant account no longer sits on it in the ledger.
    routers/accounting_ask.py. New table - create_all builds it; RLS by
    main.py and the startup sweep."""
    __tablename__ = "accounting_ama_threads"
    id               = Column(String, primary_key=True)            # uuid
    entity_code      = Column(String, default="", index=True)      # Intacct location of the line
    entry_id         = Column(String, default="")                  # ledger entry uuid (EntryDetail)
    entry_no         = Column(String, default="")
    line_id          = Column(String, default="", index=True)      # ledger line id ('' = unknown)
    line_no          = Column(String, default="")
    account_no       = Column(String, default="", index=True)
    account_title    = Column(String, default="")
    entry_date       = Column(String, default="")                  # YYYY-MM-DD
    debit            = Column(Float, default=0.0)
    credit           = Column(Float, default=0.0)
    description      = Column(String, default="")
    memo             = Column(String, default="")
    party            = Column(String, default="")                  # vendor / customer / employee, as shown
    journal          = Column(String, default="")
    source           = Column(String, default="question")          # question | ama (asked on an AMA-account line)
    question         = Column(Text, default="")
    asked_by         = Column(String, default="", index=True)
    asked_at         = Column(String, default="")
    accountant_email = Column(String, default="", index=True)
    status           = Column(String, default="Open", index=True)  # Open | Answered | Resolved
    moved_to_account = Column(String, default="")
    resolved_by      = Column(String, default="")
    resolved_at      = Column(String, default="")
    reclassed_at     = Column(String, default="")
    last_reply_at    = Column(String, default="")
    last_reply_by    = Column(String, default="")
    updated_at       = Column(String, default="")
    # Oct 22 (Priyanka): the line's Department, Vendor and Custom dimension,
    # as Intacct's AMA report lists them ("code name").
    department       = Column(String, default="")
    vendor           = Column(String, default="")
    custom           = Column(String, default="")


class AccountingAmaMessage(Base):
    """One message on an Ask My Accountant thread: the question, a reply, or
    an event line (resolved, reopened, reassigned). New table - create_all
    builds it; RLS by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_messages"
    id           = Column(String, primary_key=True)                # uuid
    thread_id    = Column(String, default="", index=True)
    author_email = Column(String, default="")
    kind         = Column(String, default="reply")                 # question | reply | event
    body         = Column(Text, default="")
    created_at   = Column(String, default="")


class AccountingAmaSetting(Base):
    """Ask My Accountant settings, one row per entity. The '' row holds the
    GL accounts that ARE the Ask My Accountant (suspense) accounts - the chart
    of accounts is shared by every entity, so they are set once; an empty list
    means "find them by title" - and the default accountants; an entity row
    holds that entity's own accountants. New table - create_all builds it;
    RLS by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_settings"
    entity_code = Column(String, primary_key=True)                 # '' = every entity
    accounts    = Column(JSON, default=list)                       # ['99999', ...] (the '' row only)
    accountants = Column(JSON, default=list)                       # ['person@greensglobal.com', ...]
    updated_by  = Column(String, default="")
    updated_at  = Column(String, default="")
    # CR-13 (Oct 23): who may approve and push an AMA reclass (the '' row
    # only). Empty = accounting_assumptions.AMA_BOOKKEEPERS_FALLBACK.
    bookkeepers = Column(JSON, default=list)
    # CR-13 rework (Oct 23): no AMA push edits an entry dated on or before
    # this day ('' = accounting_assumptions.AMA_BOOKS_CLOSED_THROUGH).
    closed_through = Column(String, default="")


class AccountingAmaLineReview(Base):
    """CR-13 (Charmi, Oct 22): what Nexus keeps against one Ask My Accountant
    ledger line - the Notes typed in the grid and the GL reclass proposed for
    it. A reclass runs Awaiting Bookkeeper -> (Sent Back -> Awaiting
    Bookkeeper) -> Pushing -> Pushed; only a bookkeeper approves and pushes.
    A push creates a NEW reclass entry (never edits the original); with the
    Intacct switch off it is recorded for the GL import file instead
    (push_mode 'import'). `line_ref` = the ledger line id, else "k:" + the
    entry / account / amount / date key. routers/accounting_ask_review.py.
    New table - create_all builds it; RLS by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_line_reviews"
    id               = Column(String, primary_key=True)            # uuid
    line_ref         = Column(String, unique=True, index=True)
    entity_code      = Column(String, default="", index=True)
    entry_id         = Column(String, default="")
    entry_no         = Column(String, default="")
    line_id          = Column(String, default="")
    account_no       = Column(String, default="")                  # the AMA account
    account_title    = Column(String, default="")
    entry_date       = Column(String, default="")                  # YYYY-MM-DD
    amount           = Column(Float, default=0.0)                  # debit - credit
    description      = Column(String, default="")
    department_id    = Column(String, default="")
    note             = Column(Text, default="")
    note_by          = Column(String, default="")
    note_at          = Column(String, default="")
    reclass_status   = Column(String, default="", index=True)      # '' | Awaiting Bookkeeper | Sent Back | Pushing | Pushed
    reclass_ref      = Column(String, default="")                  # R-xxxxxxxx, on the reclass entry
    to_account       = Column(String, default="")
    to_account_title = Column(String, default="")
    party_kind       = Column(String, default="")                  # '' | vendor | customer
    party_id         = Column(String, default="")
    party_name       = Column(String, default="")
    reclass_memo     = Column(String, default="")
    proposed_by      = Column(String, default="")
    proposed_at      = Column(String, default="")
    review_note      = Column(String, default="")                  # the bookkeeper's Send Back note
    approved_by      = Column(String, default="")
    approved_at      = Column(String, default="")
    push_mode        = Column(String, default="")                  # edit (the original, CR-13 rework) | intacct | import (new_entry mode)
    push_started_at  = Column(String, default="")
    intacct_ref      = Column(String, default="")                  # RECORDNO of the reclass entry
    push_error       = Column(String, default="")
    history          = Column(JSON, default=list)                  # [{at, by, event}]
    updated_at       = Column(String, default="")


class ShiftNoShowAlert(Base):
    """Shifts Phase 1 (Oct 14 2026, shift_attendance.py): the no-show scan's
    own memory and the record of what it told whom. One row per recipient,
    group ('-' when the shift has no group) and work date: people_json lists
    the people that recipient was told were not in (email, name, scheduled
    start, minutes late), first_at / last_at bracket the alert, emailed_at is
    stamped once (one email per recipient per group-day), resolved_at when
    the set emptied and the bell was closed. New table - create_all builds
    it; RLS comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "shift_noshow_alerts"
    id          = Column(String, primary_key=True)                 # uuid
    group_id    = Column(String, default="", index=True)           # ShiftGroup.id, or '-' for no group
    work_date   = Column(String, default="", index=True)           # YYYY-MM-DD (the shift's own zone)
    recipient   = Column(String, default="", index=True)           # who holds the bell
    people_json = Column(String, default="")                       # [{email, name, start, lateMin}]
    first_at    = Column(String, default="")                       # UTC ISO
    last_at     = Column(String, default="")
    emailed_at  = Column(String, default="")
    resolved_at = Column(String, default="")


class ShiftChangeLog(Base):
    """Shifts Phase 2 (Oct 14 2026, shift_log.py): who did what to a placed
    shift, in order. One row per shift per action - created, edited (an
    unshared edit saved), removed, assigned, copied, moved, cleared,
    discarded, shared (a publish: every row it shared carries the reason
    given and the publish_id), claimed / swapped / offered (a request
    approved), weather (a weather call applied or reversed). before_json /
    after_json hold the small {start, end, label, shiftId, date, email,
    openSlots} snapshot either side. Rows outlive their shift: a removed
    shift's history stays. New table - create_all builds it; RLS comes from
    main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "shift_change_log"
    id             = Column(String, primary_key=True)              # uuid
    shift_id       = Column(String, default="", index=True)        # ScheduledShift.id
    employee_email = Column(String, default="", index=True)        # '' for an open slot
    work_date      = Column(String, default="", index=True)        # YYYY-MM-DD at the time
    action         = Column(String, default="", index=True)
    actor          = Column(String, default="", index=True)        # who made the change
    at             = Column(String, default="", index=True)        # UTC ISO
    before_json    = Column(String, default="")
    after_json     = Column(String, default="")
    reason         = Column(String, default="")                    # a publish over warnings, a weather call
    publish_id     = Column(String, default="", index=True)        # one per publish; '' otherwise


class ShiftCalendarEvent(Base):
    """Shifts Phase 3a (Oct 14 2026, shift_calendar.py): the Outlook event
    that mirrors one shared shift on one person's calendar. One row per
    (shift, person); the sync loop works the queue - state pending (create
    or update), delete (the shift is gone, cancelled or someone else's), ok,
    error (last_error says why; retried), skipped (the company switch is
    off, the person opted out, no Microsoft 365 account). synced_hash is
    the event body last sent, so an unchanged shift is never re-sent. New
    table - create_all builds it; RLS comes from main._enable_rls_everywhere's
    startup sweep."""
    __tablename__ = "shift_calendar_events"
    id             = Column(String, primary_key=True)              # uuid
    shift_id       = Column(String, default="", index=True)        # ScheduledShift.id
    employee_email = Column(String, default="", index=True)
    event_id       = Column(String, default="")                    # Graph event id; '' = none yet
    synced_hash    = Column(String, default="")
    synced_at      = Column(String, default="")                    # UTC ISO
    state          = Column(String, default="pending", index=True)
    last_error     = Column(String, default="")
    updated_at     = Column(String, default="", index=True)
    # Failed tries since the row was last queued (review, Oct 15): an errored
    # row is retried until shift_calendar.MAX_ATTEMPTS, then left as error
    # until the shift changes again - never retried forever. A 4xx Graph
    # refuses for good jumps straight there. Added column -> ALTER lines in main.py.
    attempts       = Column(Integer, default=0)


class ShiftPublish(Base):
    """Shifts Phase 3a (Oct 14 2026): one row per Share (publish) of the
    schedule - who, when, the range, the team it was narrowed to, the reason
    given over warnings, and how many shifts it changed. shift_change_log
    rows carry the same publish_id; shift_publish_confirms say who has seen
    it. New table - create_all builds it; RLS comes from
    main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "shift_publishes"
    id         = Column(String, primary_key=True)                  # the publish_id
    by         = Column(String, default="", index=True)
    at         = Column(String, default="", index=True)            # UTC ISO
    start_date = Column(String, default="")                        # YYYY-MM-DD
    end_date   = Column(String, default="")
    group_id   = Column(String, default="")
    reason     = Column(String, default="")
    changes    = Column(Integer, default=0)


class ShiftPublishConfirm(Base):
    """Shifts Phase 3a (Oct 14 2026, shift_confirm.py): a person asked to
    confirm they have seen a publish that changed their shifts. One row per
    (publish, person), made when the publish is announced and the company's
    confirmRequests switch is on; confirmed_at when they pressed Confirm,
    nudged_at when a manager sent the one reminder allowed. New table -
    create_all builds it; RLS comes from main._enable_rls_everywhere's
    startup sweep."""
    __tablename__ = "shift_publish_confirms"
    id             = Column(String, primary_key=True)              # uuid
    publish_id     = Column(String, default="", index=True)        # ShiftPublish.id
    employee_email = Column(String, default="", index=True)
    confirmed_at   = Column(String, default="")                    # UTC ISO; '' = not yet
    nudged_at      = Column(String, default="")                    # UTC ISO; '' = never


class ShiftAvailabilityDate(Base):
    """Shifts Phase 3b (Oct 14 2026): when a person can work on ONE date, on
    top of their weekly pattern (ShiftAvailability). A dated row wins over
    the weekday rule for that date in the schedule's conflict check
    (routers/timeclock._shift_conflicts): `unavailable` = not that day,
    `available` = only between start and end. Staff set their own in My
    Workday > Shifts (PUT /timeclock/availability/mine replaces the rows
    from today on; past dates are kept as a record). New table - create_all
    builds it; RLS comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "shift_availability_dates"
    id             = Column(String, primary_key=True)              # uuid
    employee_email = Column(String, index=True, nullable=False)
    date           = Column(String, index=True, nullable=False)    # YYYY-MM-DD
    kind           = Column(String, default="unavailable")         # unavailable | available
    start_hhmm     = Column(String, default="")
    end_hhmm       = Column(String, default="")
    note           = Column(String, default="")
    created_at     = Column(String, default="")


class ShiftAvailabilityPref(Base):
    """Shifts Phase 3b (Oct 14 2026): a person's own hours preferences. 0 =
    not set. `max_hours_week` is a week cap like the company's
    ruleMaxWeekHours (shift_rules.py warns past the tighter of the two);
    `preferred_hours_week` is informational - the grid shows "prefers 24h"
    on the person cell and nothing warns on it. New table - create_all
    builds it; RLS comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "shift_availability_prefs"
    employee_email       = Column(String, primary_key=True)
    preferred_hours_week = Column(Integer, default=0)
    max_hours_week       = Column(Integer, default=0)
    updated_at           = Column(String, default="")


class ApprovalDelegation(Base):
    """Approver delegation (Neil, Oct 17 2026): someone who approves things
    names a stand-in for a date range (a vacation). While it is live, the
    approvals that route to the delegator - Time Sheet review, punch fixes and
    punch edits, time off - ALSO route to the delegate, for the delegator's own
    people only (approval_delegation.py). The delegator keeps their access.
    Dates are inclusive, YYYY-MM-DD on the delegator's local calendar. A
    revoked row is kept as the record. New table - create_all builds it; RLS
    comes from main._enable_rls_everywhere's startup sweep (and the explicit
    ALTER in the Postgres migrations list)."""
    __tablename__ = "approval_delegations"
    id              = Column(String, primary_key=True)              # uuid
    delegator_email = Column(String, index=True, nullable=False)
    delegate_email  = Column(String, index=True, nullable=False)
    start_date      = Column(String, default="")                    # YYYY-MM-DD, inclusive
    end_date        = Column(String, default="")                    # YYYY-MM-DD, inclusive
    note            = Column(String, default="")
    created_by      = Column(String, default="")                    # the delegator, or HR setting it for them
    created_at      = Column(String, default="")
    revoked_at      = Column(String, default="")                    # '' = not revoked
    revoked_by      = Column(String, default="")


class TimeBreakPremium(Base):
    """CA meal / rest premium (Neil, Oct 17 2026, ca_breaks.py): one hour of
    pay at the day's regular rate owed for a missed meal or rest break. Only
    for CA-rule hourly staff. Created from the employee's "No" at signing
    (source 'claim') or by the manager/HR ('manager'); at most ONE active
    meal and ONE active rest premium per person per day. Removing one keeps
    the row (status 'removed' + who/when/why) - the audit trail. Not hours
    worked, never in the overtime split. New table - create_all builds it;
    RLS comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "time_break_premiums"
    id             = Column(String, primary_key=True)              # uuid
    employee_email = Column(String, index=True, nullable=False)
    local_date     = Column(String, index=True, nullable=False)    # YYYY-MM-DD
    kind           = Column(String, default="meal")                # meal | rest
    status         = Column(String, default="active")              # active | removed
    source         = Column(String, default="manager")             # claim | manager
    review_id      = Column(String, default="")                    # TimesheetReview.id it came in on
    note           = Column(String, default="")
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    removed_by     = Column(String, default="")
    removed_at     = Column(String, default="")
    removed_reason = Column(String, default="")


class CaMealWaiver(Base):
    """CA meal period waiver (Neil, Oct 17 2026, ca_breaks.py): the one-time
    waiver a CA-rule employee signs in Nexus Sign (link_kind 'meal_waiver').
    One row per waiver sent; the person's waiver is the newest signed row not
    revoked. Detection applies it to days on/after `signed_at` and before
    `revoked_at`. New table - RLS from _enable_rls_everywhere."""
    __tablename__ = "ca_meal_waivers"
    id              = Column(String, primary_key=True)             # uuid
    employee_email  = Column(String, index=True, nullable=False)
    status          = Column(String, default="sent")               # sent | signed | revoked | canceled
    sign_request_id = Column(String, default="", index=True)
    sent_by         = Column(String, default="")
    sent_at         = Column(String, default="")
    signed_at       = Column(String, default="")                   # UTC ISO
    revoked_at      = Column(String, default="")
    revoked_by      = Column(String, default="")
    revoke_note     = Column(String, default="")


class CaReviewResolution(Base):
    """California Review (Neil, Oct 18 2026, ca_review.py): HR's resolution of
    one automated flag on one person's pay period. `fingerprint` is the hash
    of the facts the flag was raised on - a resolution only holds while the
    facts are unchanged (a changed day raises the flag again). Reopen keeps
    the row (status 'reopened'). New table - RLS from _enable_rls_everywhere."""
    __tablename__ = "ca_review_resolutions"
    id             = Column(String, primary_key=True)              # uuid
    employee_email = Column(String, index=True, nullable=False)
    period_start   = Column(String, index=True, nullable=False)
    flag_key       = Column(String, default="", index=True)        # rule:date[:detail]
    fingerprint    = Column(String, default="")
    status         = Column(String, default="resolved")            # resolved | reopened
    note           = Column(String, default="")
    resolved_by    = Column(String, default="")
    resolved_at    = Column(String, default="")
    reopened_by    = Column(String, default="")
    reopened_at    = Column(String, default="")


class ChangelogReaction(Base):
    """One person's reaction to a What's New update (Pranshu, Oct 16 2026):
    `reaction` is one of task_config.CHANGELOG_REACTIONS (like, celebrate,
    love, helpful, confused). ONE reaction per person per update: picking
    another kind replaces theirs, pressing theirs again takes it back. New table - create_all
    builds it; RLS comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "changelog_reactions"
    __table_args__ = (UniqueConstraint("entry_id", "email", name="uq_changelog_reaction"),)
    id         = Column(String, primary_key=True)
    entry_id   = Column(String, index=True, nullable=False)
    email      = Column(String, nullable=False)                # lowercased
    reaction   = Column(String, nullable=False)
    created_at = Column(String, default="")


class ChangelogEntryView(Base):
    """Who has seen a What's New update, for its analytics (Pranshu, Oct 16
    2026). One row per person and update: `views` counts the times it was
    shown to them (on the What's New tab or opened in full), first/last_at
    bracket them. New table - create_all builds it; RLS comes from
    main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "changelog_entry_views"
    __table_args__ = (UniqueConstraint("entry_id", "email", name="uq_changelog_entry_view"),)
    id       = Column(String, primary_key=True)
    entry_id = Column(String, index=True, nullable=False)
    email    = Column(String, nullable=False)                  # lowercased
    views    = Column(Integer, default=1)
    first_at = Column(String, default="")
    last_at  = Column(String, default="")
    # Finished the update's guided tour (Oct 18 2026, changelog_lifecycle).
    tour_done_at = Column(String, default="")


class ChangelogEntryHistory(Base):
    """Every change to a What's New update (Oct 16 2026): who, when, and the
    fields that changed as {field: [old, new]} (text cut to 500 characters;
    screenshots are never copied). `action` is edit | published | republished
    | hidden | shown | pinned | unpinned. New table - create_all builds it; RLS
    comes from main._enable_rls_everywhere's startup sweep."""
    __tablename__ = "changelog_entry_history"
    id       = Column(String, primary_key=True)
    entry_id = Column(String, index=True, nullable=False)
    at       = Column(String, default="")
    by_email = Column(String, default="")
    action   = Column(String, default="edit")
    changes  = Column(JSON, default=dict)


class ChangelogFeedback(Base):
    """Feedback on a What's New update (Oct 16 2026). kind "helpful": one per
    person, helpful 1 (yes) or 0 (no), with an optional note. kind "request":
    a feature request raised from the update, any number. New table -
    create_all builds it; RLS comes from main._enable_rls_everywhere's sweep."""
    __tablename__ = "changelog_feedback"
    id         = Column(String, primary_key=True)
    entry_id   = Column(String, index=True, nullable=False)
    email      = Column(String, nullable=False)                # lowercased
    kind       = Column(String, default="helpful")             # helpful | request
    helpful    = Column(Integer, default=1)
    note       = Column(Text, default="")
    created_at = Column(String, default="")
    # A feature request's road to shipping (Oct 18 2026, changelog_lifecycle):
    # status '' = New, then Under Review / Planned / In Progress / Shipped /
    # Declined. `shipped_entry_id` is the update that delivered it; the
    # requester's bell rings once per status (`notified_status`) - for
    # Shipped only once that update is released. `module` is set on a
    # request raised on its own (entry_id '').
    status           = Column(String, default="")
    status_note      = Column(Text, default="")
    status_by        = Column(String, default="")
    status_at        = Column(String, default="")
    shipped_entry_id = Column(String, default="")
    notified_status  = Column(String, default="")
    module           = Column(String, default="")
    # The Feature Request ticket this request IS (Oct 23 2026,
    # feature_requests.py): its comments are the request's one conversation.
    ticket_id        = Column(String, default="", index=True)


class ChangelogSubscription(Base):
    """What a person follows in What's New (Oct 16 2026): modules and
    categories (lowercased names) bring a bell notice when a matching update
    is released; `digest` adds the Monday email of last week's updates;
    `feed_salt` signs their private RSS link (rotating it kills old links).
    New table - create_all builds it; RLS comes from the startup sweep."""
    __tablename__ = "changelog_subscriptions"
    email      = Column(String, primary_key=True)              # lowercased
    modules    = Column(JSON, default=list)
    categories = Column(JSON, default=list)
    digest     = Column(Boolean, default=False)
    feed_salt  = Column(String, default="")
    updated_at = Column(String, default="")


class ExpenseReimbursement(Base):
    """An out-of-pocket purchase an employee wants paid back (Neil, Oct 18
    2026: "the employee sends an email to accounting, it gets forwarded 8 or
    9 times, sometimes they are paid late, sometimes not at all").

    Workday > Reimbursements (a tile beside Ask HR). The employee picks who
    approves it (their manager by default); then HR - the same people as on
    time sheets (timesheet_review.is_hr) - approves and pays it.
    status: submitted -> approver_approved -> hr_approved -> paid;
            sent_back (edit + resubmit), rejected, canceled.
    Receipts: the private hr-docs bucket (reimbursements/<email>/...), opened
    through a 5-minute signed link by the employee, the approver or HR."""
    __tablename__ = "expense_reimbursements"
    id              = Column(String, primary_key=True)
    employee_email  = Column(String, index=True)
    employee_name   = Column(String, default="")
    company         = Column(String, default="")      # HrEntity id
    item            = Column(String, default="")      # what was bought
    category        = Column(String, default="other")
    category_other  = Column(String, default="")      # when category is "other"
    details         = Column(Text, default="")        # what it was for
    vendor          = Column(String, default="")
    amount          = Column(Float, default=0.0)
    currency        = Column(String, default="USD")
    purchase_date   = Column(String, default="")      # YYYY-MM-DD
    approver_email  = Column(String, index=True)
    receipts        = Column(JSON, default=list)      # [{path, name}]
    status          = Column(String, default="submitted", index=True)
    approved_by     = Column(String, default="")      # the picked approver's decision
    approved_at     = Column(String, default="")
    hr_by           = Column(String, default="")      # HR's approval
    hr_at           = Column(String, default="")
    paid_by         = Column(String, default="")
    paid_on         = Column(String, default="")      # YYYY-MM-DD
    payment_method  = Column(String, default="")      # payroll | ach | check | other
    payment_ref     = Column(String, default="")
    history         = Column(JSON, default=list)      # [{at, by, action, note}]
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")


class TicketSavedReply(Base):
    """A saved reply (canned response) for the service desk (Oct 2026,
    routers/ticket_saved_replies.py). Inserted into the ticket drawer's reply
    composer with its placeholders filled ({requester_first_name},
    {ticket_number}...) and edited there - never sent on its own.

    owner_email "" = shared with the company's desk (created, edited and
    deleted by ticket supervisors only); otherwise personal to that agent.
    body is rich text, sanitized on save. New table - create_all builds it;
    RLS: the explicit ALTER in main.py plus the startup sweep."""
    __tablename__ = "ticket_saved_replies"
    id          = Column(String, primary_key=True)
    company_id  = Column(String, default="", index=True)   # HrEntity id
    owner_email = Column(String, default="", index=True)   # "" = shared
    title       = Column(String, default="")
    body        = Column(Text, default="")
    help_topic  = Column(String, default="")               # optional, for suggesting
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    modified_at = Column(String, default="")
    use_count   = Column(Integer, default=0)


class LeaveLedgerEntry(Base):
    """One change to a person's paid leave balance, in HOURS (Neil / Charmi
    call, Oct 19 2026 - leave_balances.py). A balance is the sum of its rows
    plus the policy's grants, so every number can be traced. Kinds: opening
    (the one-time import as of the cutover), accrual (vacation earned from a
    finalized period's worked hours), used (sick / vacation paid in a
    finalized period, negative), adjust (an HR correction with a note).
    New table - create_all builds it; RLS line in main.py."""
    __tablename__ = "leave_ledger"
    id             = Column(String, primary_key=True)
    employee_email = Column(String, nullable=False, index=True)
    bucket         = Column(String, default="vacation")   # vacation | sick
    hours          = Column(Float, default=0)             # signed
    kind           = Column(String, default="adjust")     # opening | accrual | used | adjust | expire | carryover (leave_year_end.py)
    effective_date = Column(String, default="")           # YYYY-MM-DD
    ref_id         = Column(String, default="", index=True)  # the finalize row (TimeApproval.id) for accrual / used
    note           = Column(String, default="")
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")


class OpsRateDraft(Base):
    """Operations -> Rate Management (Neil / Miranda, Oct 20 2026): a street
    rate someone proposed for one of our unit types (a Cubby pricing group)
    and nobody has entered in Cubby yet. One row per facility and unit type,
    replaced in place; Mark Entered in Cubby deletes it and writes OpsRatePush.
    New table - create_all builds it; RLS line in main.py."""
    __tablename__ = "ops_rate_drafts"
    id                 = Column(String, primary_key=True)
    facility_id        = Column(String, index=True, nullable=False)   # our Cubby facility
    unit_type          = Column(String, default="")                   # Cubby pricing group name
    pricing_group_id   = Column(String, default="")                   # Cubby pricingGroupId, when known
    proposed_cents     = Column(Integer, default=0)                   # new SELL (web) rate
    proposed_set_cents = Column(Integer)                              # new SET (standard) rate; None = moves with the sell rate
    note               = Column(String, default="")
    updated_by         = Column(String, default="")
    updated_at         = Column(String, default="")
    created_at         = Column(String, default="")


class OpsRatePush(Base):
    """Audit log of our street rate changes - Rate Management's history of OUR
    rates. Since Oct 20 2026 Nexus never writes to Cubby: each row is a rate
    staff entered in Cubby by hand and marked entered (status "entered").
    Older rows (ok | failed | skipped) were API pushes; they stay as history.
    Rows are only ever added. Table name kept. RLS line in main.py."""
    __tablename__ = "ops_rate_pushes"
    id                  = Column(String, primary_key=True)
    batch_id            = Column(String, index=True, default="")    # one Mark Entered click
    facility_id         = Column(String, index=True, nullable=False)
    unit_type           = Column(String, default="")
    pricing_group_id    = Column(String, default="")
    old_set_cents       = Column(Integer)
    old_sell_cents      = Column(Integer)
    new_set_cents       = Column(Integer)
    new_sell_cents      = Column(Integer)
    vacant              = Column(Integer, default=0)
    monthly_delta_cents = Column(Integer, default=0)                # (new sell - old sell) x vacant units
    status              = Column(String, default="")                # entered | skipped (legacy: ok | failed)
    detail              = Column(String, default="")
    pushed_by           = Column(String, default="")
    pushed_at           = Column(String, default="", index=True)


# ── Operations > Revenue Management (Neil, Oct 20 2026, ops_revenue.py) ──────
# Rent changes for EXISTING tenants (ECRI). New tables - create_all builds
# them; explicit RLS lines in main.py on top of _enable_rls_everywhere.

class OpsRevenueStrategy(Base):
    """A saved, reusable rent-change rule: +X% or +$Y, capped at the street
    rate (or street + Z%), with who qualifies and the notice it needs."""
    __tablename__ = "ops_revenue_strategies"
    id               = Column(String, primary_key=True)   # uuid
    name             = Column(String, default="")
    method           = Column(String, default="percent")  # percent | amount
    increase_pct     = Column(Float, default=0)           # method percent: +X%
    increase_cents   = Column(Integer, default=0)         # method amount: +$Y
    cap_mode         = Column(String, default="street")   # street | street_plus | none
    cap_pct          = Column(Float, default=0)           # cap_mode street_plus: street + Z%
    round_dollar     = Column(Boolean, default=True)      # new rent rounded to a whole dollar
    min_months_in    = Column(Integer, default=12)        # months since move-in
    min_months_since = Column(Integer, default=12)        # months since the last increase
    skip_balance     = Column(Boolean, default=True)      # skip tenants who owe money
    notice_days      = Column(Integer, default=30)        # written notice before the effective date
    active           = Column(Boolean, default=True)
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_by       = Column(String, default="")
    updated_at       = Column(String, default="")


class OpsRevenueBatch(Base):
    """One application of a strategy at one facility: who, when, the effective
    date and the status (draft | approved | notified | applied | canceled)."""
    __tablename__ = "ops_revenue_batches"
    id             = Column(String, primary_key=True)
    facility_id    = Column(String, index=True, nullable=False)
    facility_name  = Column(String, default="")
    strategy_id    = Column(String, default="")
    strategy_name  = Column(String, default="")
    strategy       = Column(JSON, default=dict)            # the rule as it was when the batch was built
    scope_type     = Column(String, default="")            # unit_type | tenants | tenant
    scope_label    = Column(String, default="")
    effective_date = Column(String, default="")            # YYYY-MM-DD
    notice_date    = Column(String, default="")            # YYYY-MM-DD, effective - notice days
    status         = Column(String, default="draft", index=True)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    approved_by    = Column(String, default="")
    approved_at    = Column(String, default="")
    notified_by    = Column(String, default="")
    notified_at    = Column(String, default="")
    applied_by     = Column(String, default="")
    applied_at     = Column(String, default="")
    canceled_by    = Column(String, default="")
    canceled_at    = Column(String, default="")
    note           = Column(Text, default="")


class OpsRevenueChange(Base):
    """One tenant's proposed rent change inside a batch, and whether staff
    have entered it in Cubby by hand ("entered"; "pushed" = legacy API rows)."""
    __tablename__ = "ops_revenue_changes"
    id                 = Column(String, primary_key=True)
    batch_id           = Column(String, index=True, nullable=False)
    facility_id        = Column(String, index=True, nullable=False)
    lease_id           = Column(String, default="", index=True)
    unit_id            = Column(String, default="")
    customer_id        = Column(String, default="")
    tenant_name        = Column(String, default="")
    unit_name          = Column(String, default="")
    unit_type          = Column(String, default="")
    move_in_date       = Column(String, default="")
    last_increase_date = Column(String, default="")
    current_cents      = Column(Integer, default=0)
    street_cents       = Column(Integer, default=0)
    new_cents          = Column(Integer, default=0)
    status             = Column(String, default="pending")    # pending | pushed | entered | failed | removed
    cubby_change_date  = Column(String, default="")           # the dates Cubby scheduled it for
    cubby_notice_date  = Column(String, default="")
    pushed_by          = Column(String, default="")
    pushed_at          = Column(String, default="")
    push_detail        = Column(String, default="")


class OpsRevenueAudit(Base):
    """Every step of a batch (legacy rows also log old Cubby push attempts)."""
    __tablename__ = "ops_revenue_audit"
    id         = Column(String, primary_key=True)
    batch_id   = Column(String, index=True, nullable=False)
    change_id  = Column(String, default="")
    actor      = Column(String, default="")
    action     = Column(String, default="")   # created | approved | notified | applied | canceled | removed | pushed | push_failed | entered | letters | export
    detail     = Column(JSON, default=dict)
    created_at = Column(String, default="")


# ── Operations > Reports (Neil, Ops review, Oct 20 2026) ─────────────────────
# ops_reports.py / ops_report_builder.py. New tables - create_all builds them;
# explicit RLS lines in main.py on top of the startup sweep.

class OpsReportCache(Base):
    """One Cubby report answer per (report, facility, month): the general
    ledgers, merchant disbursements, lease compliance. Cleaned of contact
    fields and card / check digits before it is written."""
    __tablename__ = "ops_report_cache"
    id          = Column(String, primary_key=True)          # "<kind>:<facility_id>:<YYYY-MM | current>"
    kind        = Column(String, default="")
    facility_id = Column(String, default="", index=True)
    period      = Column(String, default="")
    payload     = Column(JSON, default=dict)
    fetched_at  = Column(String, default="")                # UTC iso


class OpsSavedReport(Base):
    """A Report Builder spec saved under a name. Private to its owner unless
    shared with the Operations team; optionally emailed on a schedule."""
    __tablename__ = "ops_saved_reports"
    id               = Column(String, primary_key=True)
    owner_email      = Column(String, default="", index=True)
    name             = Column(String, default="")
    spec             = Column(JSON, default=dict)           # ops_report_builder.validate() output - never SQL
    shared           = Column(Boolean, default=False)
    schedule         = Column(String, default="")           # '' | weekly | monthly
    schedule_day     = Column(Integer, default=0)           # weekly: 0 = Monday .. 6; monthly: 1-28
    recipients       = Column(JSON, default=list)           # Nexus People work emails
    last_sent_period = Column(String, default="")           # the claim: a period is sent once
    last_sent_at     = Column(String, default="")
    last_attempt_at  = Column(String, default="")
    last_error       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")


class TicketInboundEmail(Base):
    """One message the support mailbox handed us, and what became of it
    (Ticket Inbound Email, Oct 2026 - ticket_inbound.py). TaskInboundEmail's
    columns, with ticket_id for task_id and an `outcome`:

      comment   a reply that became a comment on ticket_id;
      created   a new email that became ticket_id;
      refused   nothing was created - `reason` says why (unknown or external
                sender, offboarded, automated mail, our own mailbox, no
                permission on that ticket, no default department, the hourly
                limit...);
      failed    it could not be processed and is retried next pass.

    `status` keeps the Tasks log's words (posted / rejected / ignored /
    failed) so the two logs read alike. Written for EVERY message, and
    `internet_message_id` is unique: the drain marks a message read only after
    its outcome is committed, so a crash in between shows it again and this
    constraint turns that into a no-op instead of a second ticket.

    New table - create_all builds it; RLS: the explicit ALTER in main.py plus
    the startup sweep."""
    __tablename__ = "ticket_inbound_email"
    id                  = Column(String, primary_key=True)
    internet_message_id = Column(String, default="", index=True, unique=True)
    graph_message_id    = Column(String, default="")
    conversation_id     = Column(String, default="")
    from_email          = Column(String, default="", index=True)
    subject             = Column(String, default="")
    ticket_id           = Column(String, default="", index=True)
    comment_id          = Column(String, default="")
    matched_by          = Column(String, default="")   # address | headers | conversation | subject
    status              = Column(String, default="")   # posted | rejected | ignored | failed
    outcome             = Column(String, default="", index=True)   # comment | created | refused | failed
    reason              = Column(String, default="")
    attachment_count    = Column(Integer, default=0)
    received_at         = Column(String, default="")
    processed_at        = Column(String, default="", index=True)
    auth_summary        = Column(String, default="")   # mail_inbound.auth_verdict


class TicketReportEmailLog(Base):
    """One row per person per reported week a Weekly Ticket Report email was
    claimed (ticket_reports.py, Oct 2026) - written BEFORE the send and unique
    on (recipient, week_start), so a restart or a second worker can never send
    the same week twice. New table - create_all builds it; RLS line in main.py
    plus the _enable_rls_everywhere sweep."""
    __tablename__ = "ticket_report_email_log"
    __table_args__ = (UniqueConstraint("recipient", "week_start", name="uq_ticket_report_email_week"),)
    id            = Column(String, primary_key=True)   # uuid
    recipient     = Column(String, nullable=False, index=True)
    week_start    = Column(String, nullable=False, index=True)   # the reported Monday, YYYY-MM-DD
    status        = Column(String, default="sending")  # sending | sent | failed | empty
    sent_at       = Column(String, default="")         # UTC iso; '' when nothing was mailed
    error         = Column(String, default="")
    attempts      = Column(Integer, default=0)         # send tries; a failed / stuck one is retried up to 3
    updated_at    = Column(String, default="")         # last claim or result - the retry's compare-and-set
    created_count = Column(Integer, default=0)
    resolved_count = Column(Integer, default=0)
    open_count    = Column(Integer, default=0)
    created_at    = Column(String, default="")


class TicketItemLink(Base):
    """A ticket is about this piece of equipment (Oct 2026, routers/
    ticket_items.py). Items and Assets are ONE concept (Neil), so this points
    at `items`, never the legacy hardware_assets table. A SOFT link (no FK):
    items soft-delete and can later be purged, tickets soft-delete - neither
    may 500 on a link left behind. item_name is the item's name when linked,
    shown if the item row is gone. One row per (ticket, item). New table -
    create_all builds it; RLS: the explicit ALTER in main.py plus the sweep."""
    __tablename__ = "ticket_item_links"
    __table_args__ = (UniqueConstraint("ticket_id", "item_id", name="uq_ticket_item_link"),)
    id         = Column(String, primary_key=True)
    ticket_id  = Column(String, nullable=False, index=True)
    item_id    = Column(String, nullable=False, index=True)
    item_name  = Column(String, default="")
    linked_by  = Column(String, default="")   # email of whoever linked it
    linked_at  = Column(String, default="")   # UTC iso


class TicketAiSummary(Base):
    """A ticket's cached AI Summary (Oct 2026, ticket_ai.py /
    routers/ticket_ai.py). One row per ticket per AUDIENCE: "internal" was
    built with the ticket's internal notes and is only ever served to a viewer
    who may read them (routers/tickets._sees_internal); "public" from the
    description and public replies only. `fingerprint` is what it was built
    from (ticket_ai.fingerprint) - a new, edited or deleted visible comment, or
    a subject / description / status change, makes it stale. `content` is the
    JSON {issue, tried, state, next_step} of plain-text strings. New table -
    create_all builds it; RLS: the explicit ALTER in main.py plus the startup
    sweep."""
    __tablename__ = "ticket_ai_summaries"
    id           = Column(String, primary_key=True)   # "<ticket id>:<audience>"
    ticket_id    = Column(String, default="", index=True)
    audience     = Column(String, default="")         # internal | public
    company_id   = Column(String, default="")
    fingerprint  = Column(String, default="")
    content      = Column(Text, default="")
    model        = Column(String, default="")
    generated_by = Column(String, default="")
    generated_at = Column(String, default="")
    # The comment ids it was built from: one of them gone = not shown (a
    # backstop to delete_ticket_comment dropping the ticket's rows).
    source_comment_ids = Column(JSON, default=list)


class OpsReportSchedule(Base):
    """A catalog report (ops_reports.CATALOG) emailed on a schedule as an
    XLSX / PDF / CSV attachment - Operations > Reports > Scheduled (Oct 20
    2026, ops_report_schedules.py). New table - explicit RLS line in main.py."""
    __tablename__ = "ops_report_schedules"
    id               = Column(String, primary_key=True)
    owner_email      = Column(String, default="", index=True)
    name             = Column(String, default="")
    kind             = Column(String, default="")           # an ops_reports.CATALOG key
    facility_ids     = Column(JSON, default=list)           # [] = every facility
    period           = Column(JSON, default=dict)           # {"mode": current|previous, "unit": day|week|month|quarter|year}
    options          = Column(JSON, default=dict)           # the report's own switches
    format           = Column(String, default="xlsx")       # xlsx | pdf | csv
    frequency        = Column(String, default="weekly")     # daily | weekly | monthly
    day              = Column(Integer, default=0)           # weekly: 0 = Monday .. 6; monthly: 1-28
    hour             = Column(Integer, default=7)           # 0-23, Pacific
    include_weekends = Column(Boolean, default=False)       # daily only
    active           = Column(Boolean, default=True)
    recipients       = Column(JSON, default=list)           # Nexus People work emails - staff, never tenants
    last_sent_period = Column(String, default="")           # the claim: a period is sent once
    last_sent_at     = Column(String, default="")
    last_attempt_at  = Column(String, default="")
    last_error       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")



# ── Operations > Pricing Insights (Visesh, Oct 20 2026, cubby_pricing.py / ops_insights.py) ──
# Cubby's pricing side, copied READ-ONLY on the 15-minute sync. Cubby has no
# webhooks, so "every time it changes" = each sync compares and keeps a row
# only when a value moved. New tables - create_all builds them; explicit RLS
# lines in main.py on top of _enable_rls_everywhere.

class CubbyPricingGroup(Base):
    """One Cubby pricing group (a unit type) as of the last sync. `active`
    false = Cubby no longer lists it (its history stays)."""
    __tablename__ = "cubby_pricing_groups"
    id                    = Column(String, primary_key=True)          # "<facility_id>:<pricingGroupId>"
    facility_id           = Column(String, index=True, nullable=False)
    pricing_group_id      = Column(String, default="")
    name                  = Column(String, default="")
    width                 = Column(Float, default=0)
    depth                 = Column(Float, default=0)
    area                  = Column(Float, default=0)                  # square feet
    parking               = Column(Boolean, default=False)
    vehicle_storage       = Column(Boolean, default=False)
    climate               = Column(Boolean)                           # from Cubby's features; None = not said
    standard_cents        = Column(Integer)                           # standardRate (Set / street)
    web_cents             = Column(Integer)                           # webRate (Sell)
    walk_in_cents         = Column(Integer)                           # walkInRate
    strike_cents          = Column(Integer)                           # strikethroughRate
    value_pricing_id      = Column(String, default="")
    value_pricing_status  = Column(String, default="")
    available_units       = Column(Integer, default=0)
    rentable_units        = Column(Integer, default=0)
    discount_ids          = Column(JSON, default=list)                # discounts assigned to the group
    features              = Column(JSON, default=list)
    active                = Column(Boolean, default=True)
    first_seen_at         = Column(String, default="")                # UTC iso
    last_changed_at       = Column(String, default="")                # UTC iso of the last rate change Nexus saw; '' = none since tracking began
    synced_at             = Column(String, default="")


class CubbyDiscount(Base):
    """A Cubby discount (Pricing > Discount strategies): its terms and the
    pricing groups it is offered on. Organization-wide in Cubby."""
    __tablename__ = "cubby_discounts"
    discount_id          = Column(String, primary_key=True)
    name                 = Column(String, default="")
    type                 = Column(String, default="")                 # ONE_TIME | PERIODIC | PERPETUAL
    status               = Column(String, default="")                 # PUBLISHED | ...
    active               = Column(Boolean, default=True)
    application_method   = Column(String, default="")                 # AMOUNT_DEDUCTED | PERCENT_DEDUCTED | ...
    amount_cents         = Column(Integer)
    percentage           = Column(Float)
    start_after_months   = Column(Integer)
    discounted_months    = Column(Integer)
    pricing_groups       = Column(JSON, default=list)                 # [{pricingGroupId, name, visibility}]
    facility_ids         = Column(JSON, default=list)
    synced_at            = Column(String, default="")


class CubbyValuePricingStrategy(Base):
    """A Cubby value pricing strategy (tiered unit pricing) and its tiers."""
    __tablename__ = "cubby_value_pricing_strategies"
    strategy_id = Column(String, primary_key=True)
    name        = Column(String, default="")
    tiers       = Column(JSON, default=list)
    synced_at   = Column(String, default="")


class CubbyRateHistory(Base):
    """One change to one of OUR pricing group rates, seen by the sync. Rows
    are only ever added - written only when a value moved, so the newest row
    per group and field is "Last Changed" and the rest is the trend."""
    __tablename__ = "cubby_rate_history"
    id               = Column(String, primary_key=True)               # uuid
    facility_id      = Column(String, index=True, nullable=False)
    pricing_group_id = Column(String, index=True, default="")
    group_name       = Column(String, default="")
    field            = Column(String, default="")                     # standardRate | webRate | walkInRate | strikethroughRate | active
    old_value        = Column(Integer)                                # cents (active: 1 / 0); None = not set
    new_value        = Column(Integer)
    changed_at       = Column(String, default="", index=True)         # UTC iso of the sync that saw it
    changed_on       = Column(String, default="")                     # facility-local YYYY-MM-DD


class CubbyRentChange(Base):
    """An existing-customer rate increase (ECRI) Cubby has scheduled on a
    lease, tracked from the first sync that saw it: scheduled -> applied (the
    date passed) or canceled (it disappeared before the date). Lease, unit and
    money only - the tenant's name is read from the rent roll when shown."""
    __tablename__ = "cubby_rent_changes"
    id               = Column(String, primary_key=True)               # "<facility_id>:<leaseId>:<YYYY-MM-DD>"
    facility_id      = Column(String, index=True, nullable=False)
    lease_id         = Column(String, index=True, default="")
    unit_id          = Column(String, default="")
    pricing_group_id = Column(String, default="")
    old_cents        = Column(Integer, default=0)                     # rent when the change was first seen
    new_cents        = Column(Integer, default=0)
    effective_date   = Column(String, default="", index=True)         # YYYY-MM-DD
    status           = Column(String, default="scheduled")            # scheduled | applied | canceled
    first_seen_at    = Column(String, default="")
    updated_at       = Column(String, default="")
# ── Unified audit log (Oct 20 2026) ───────────────────────────────────────────
def _audit_request_id() -> str:
    import audit_capture
    return audit_capture.current_request_id()


class AuditChange(Base):
    """One row per database row a change touched: the table, its primary key
    and {field: {b: before, a: after}} (inserts carry after only, deletes
    before only; "bu" marks a before value the ORM never loaded, "r" a value
    redacted at write time). Written by audit_capture.py's flush listener in
    the same transaction as the change. request_id joins audit_logs. New
    table - create_all builds it; RLS line in main.py + the startup sweep, run
    get_advisors at release."""
    __tablename__ = "audit_changes"
    __table_args__ = (Index("ix_audit_changes_record", "table_name", "record_id"),)
    id         = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(String, default="", index=True)
    at         = Column(String, default="", index=True)      # UTC ISO, ...Z
    actor      = Column(String, default="", index=True)      # real person, or "system"
    acting_as  = Column(String, default="")
    module     = Column(String, default="", index=True)
    table_name = Column(String, default="")
    record_id  = Column(String, default="")
    op         = Column(String, default="")                  # insert|update|delete|bulk_update|bulk_delete|bulk
    changes    = Column(Text, default="")                    # JSON
    summary    = Column(String, default="")                  # the record's label at the time
    source     = Column(String, default="")                  # "PATCH /tasks/1" or the background job


# ── Operations > Rate Management / CMA (Miranda, Oct 21 2026, ops_cma.py) ───
# New tables - create_all builds them; explicit RLS lines in main.py (and
# enable RLS on dev and prod at release).

class OpsCmaSurvey(Base):
    """One manual competitor survey (a phone call, drive-by, walk-in / mystery
    shop, flyer / signage): who, when, how, the special, the admin fee and the
    insurance. Its rates are OpsCompetitorRate rows with this survey_id."""
    __tablename__ = "ops_cma_surveys"
    id              = Column(String, primary_key=True)
    facility_id     = Column(String, index=True, nullable=False)
    competitor_id   = Column(String, index=True, nullable=False)
    survey_date     = Column(String, default="")          # YYYY-MM-DD
    method          = Column(String, default="")          # phone | drive_by | walk_in | flyer
    surveyed_by     = Column(String, default="")
    special         = Column(String, default="")
    admin_fee_cents = Column(Integer)
    insurance       = Column(String, default="")          # "$12 / month, required"
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")


class OpsCmaChange(Base):
    """A change decided in Review & Push (the briefing's rate_change_request):
    a rate change for one pricing group, or a promotion (Cubby: discount) to
    add or end. Who proposed and approved it, the guardrail checks, how it
    reached Cubby (pushed with read-back, or entered by hand) and its revert."""
    __tablename__ = "ops_cma_changes"
    id                 = Column(String, primary_key=True)
    request_id         = Column(String, index=True, default="")   # one Approve click - idempotent
    facility_id        = Column(String, index=True, nullable=False)
    kind               = Column(String, default="rate")            # rate | promo_add | promo_end
    unit_type          = Column(String, default="")                # rate: the pricing group name
    pricing_group_id   = Column(String, default="")
    old_web_cents      = Column(Integer)
    new_web_cents      = Column(Integer)
    old_standard_cents = Column(Integer)
    new_standard_cents = Column(Integer)
    promo              = Column(JSON, default=dict)                # name, calculation, amount, periods, start, end, unitTypes
    reason             = Column(String, default="")
    effective_date     = Column(String, default="")                # YYYY-MM-DD
    affects            = Column(String, default="")
    status             = Column(String, default="proposed", index=True)  # proposed | approved | pushed | entered | failed | rejected | reverted
    needs_owner        = Column(Boolean, default=False)
    guard_notes        = Column(JSON, default=list)
    proposed_by        = Column(String, default="")
    proposed_at        = Column(String, default="")
    approver_role      = Column(String, default="")                # ops_manager | owner
    approved_by        = Column(String, default="")
    approved_at        = Column(String, default="")
    send_mode          = Column(String, default="")                # effective | immediate
    note               = Column(String, default="")
    cubby_detail       = Column(String, default="")                # Cubby's answer / the read-back result
    readback_web_cents      = Column(Integer)
    readback_standard_cents = Column(Integer)
    done_by            = Column(String, default="")                # pushed or marked entered by
    done_at            = Column(String, default="", index=True)
    revert_of          = Column(String, default="")                # the change this one reverts
    reverted_by        = Column(String, default="")
    reverted_at        = Column(String, default="")


class OpsCmaSnapshot(Base):
    """One unit type's CMA figures on one day (the first view of the day
    writes it): our rates, in-place rent, occupancy and the market - Rate
    History's trend lines."""
    __tablename__ = "ops_cma_snapshots"
    id                = Column(String, primary_key=True)          # "<facility>:<day>:<unit type>"
    facility_id       = Column(String, index=True, nullable=False)
    day               = Column(String, default="", index=True)    # facility-local YYYY-MM-DD
    unit_type         = Column(String, default="")
    sell_cents        = Column(Integer)
    standard_cents    = Column(Integer)
    avg_rent_cents    = Column(Integer)
    total             = Column(Integer, default=0)
    occupied          = Column(Integer, default=0)
    market_low_cents  = Column(Integer)
    market_high_cents = Column(Integer)
    market_avg_cents  = Column(Integer)
    comps             = Column(Integer, default=0)
    source            = Column(String, default="nexus")           # nexus | workbook


class OpsCmaEvent(Base):
    """Rate History's change log entries Nexus itself makes: a survey saved, a
    competitor closed or reopened, a price override, an import, a change
    approved / pushed / entered / reverted. (Cubby rate changes come from
    cubby_rate_history; website reads from ops_competitor_rates.)"""
    __tablename__ = "ops_cma_events"
    id          = Column(String, primary_key=True)
    facility_id = Column(String, index=True, nullable=False)
    at          = Column(String, default="", index=True)            # UTC iso
    kind        = Column(String, default="")                        # manual | comp_set | cubby | website | import
    unit_type   = Column(String, default="")                        # "" = the whole facility
    text        = Column(String, default="")
    by          = Column(String, default="")


class OpsCustomerPoint(Base):
    """Operations > Customer Map (Neil, Oct 21 2026, ops_customer_geo.py): where
    one current customer of one facility sits on the map, rounded to about
    100 m (3 decimals). NO address, name, phone or email - only the point,
    how it was placed, and a fingerprint that says whether Cubby's address
    changed since. New table - explicit RLS line in main.py."""
    __tablename__ = "ops_customer_points"
    id          = Column(String, primary_key=True)                 # "<facility_id>:<customer_id>"
    facility_id = Column(String, index=True, nullable=False)
    customer_id = Column(String, default="")
    lat         = Column(Float)                                    # rounded to 3 decimals; None = missing
    lng         = Column(Float)
    precision   = Column(String, default="missing")                # street | zip | missing
    fingerprint = Column(String, default="")                       # sha256 of the normalized address
    geocoded_at = Column(String, default="")                       # UTC iso
class ContractorInvoice(Base):
    """A contractor's invoice to their own company (Pranshu + Neil, Oct 21
    2026): drafted when their Time Sheet is finalized (one per final
    TimeApproval row - `final_approval_id` is the dedupe key), sent by HR.
    `snapshot` holds the party blocks and lines exactly as rendered, so a
    later profile change never alters a sent invoice.
    RELEASE: `ALTER TABLE contractor_invoices ENABLE ROW LEVEL SECURITY` on
    dev AND prod (create_all makes it with RLS off)."""
    __tablename__ = "contractor_invoices"
    id                = Column(String, primary_key=True)             # uuid
    employee_email    = Column(String, default="", index=True)
    company_id        = Column(String, default="", index=True)       # HrEntity.id
    period_start      = Column(String, default="")                   # YYYY-MM-DD
    period_end        = Column(String, default="")
    number            = Column(Integer, default=0)
    invoice_date      = Column(String, default="")                   # YYYY-MM-DD
    currency          = Column(String, default="INR")
    amount            = Column(Float, default=0.0)                   # the final snapshot's totalPay
    hours             = Column(Float, nullable=True)                 # hourly only
    rate              = Column(Float, nullable=True)                 # hourly only
    description       = Column(String, default="")
    status            = Column(String, default="draft", index=True)  # draft | sent | void
    snapshot          = Column(JSON, default=dict)
    pdf_path          = Column(String, default="")                   # hr-docs storage path once sent
    final_approval_id = Column(String, default="", index=True)       # TimeApproval(kind="final").id
    created_at        = Column(String, default="")
    approved_by       = Column(String, default="")
    sent_at           = Column(String, default="")
    sent_to           = Column(JSON, default=list)
    egnyte_path       = Column(String, default="")


# ---------------------------------------------------------------------------
# Knowledge Base rebuild (Oct 2026). New tables beside the old kb_* ones; the
# old rows are never changed or dropped (kb_migrate.py converts and reports).
# create_all makes these with RLS OFF - main.py's Postgres migration list
# carries the ENABLE ROW LEVEL SECURITY line for each one.
# ---------------------------------------------------------------------------

class KbCollection(Base):
    """A shelf in the Library: top level = a People department, one level of
    sub-collections under it (the old kb_services). Each has an owner who keeps
    it current and a review cycle its pages inherit. `reading_order` is an
    ordered list of page ids for a collection read like a manual."""
    __tablename__ = "kb_collections"
    id                  = Column(String, primary_key=True)   # col_ + hex
    name                = Column(String, nullable=False)
    parent_id           = Column(String, default="", index=True)
    department          = Column(String, default="")        # the People department name for a top-level collection
    description         = Column(String, default="")
    owner_email         = Column(String, default="")
    owner_name          = Column(String, default="")
    review_every_months = Column(Integer, default=12)
    reading_order       = Column(Text, default="")          # JSON [doc_id]
    sort_order          = Column(Integer, default=0)
    active              = Column(Boolean, default=True)
    created_by          = Column(String, default="")
    created_at          = Column(String, default="")
    updated_at          = Column(String, default="")
    legacy_service_id   = Column(String, default="")        # KbService.id it was made from (migration)


class KbRevision(Base):
    """A revision draft of a PUBLISHED page. Readers keep seeing the live copy
    until the revision is approved; then its blocks become the page and the
    version bumps (minor for a small fix, major for a real change). One open
    revision per page."""
    __tablename__ = "kb_revisions"
    id           = Column(String, primary_key=True)   # rev_ + hex
    doc_id       = Column(String, nullable=False, index=True)
    base_version = Column(String, default="")         # the live version it started from, e.g. "2.0"
    title        = Column(String, default="")
    summary      = Column(String, default="")
    blocks       = Column(Text, default="")           # TipTap JSON
    change_kind  = Column(String, default="minor")    # minor | major
    change_note  = Column(String, default="")         # what changed, shown in the version list and in a policy's re-sign banner
    status       = Column(String, default="draft")    # draft | in_review | changes_requested | merged | discarded
    author_email = Column(String, default="")
    author_name  = Column(String, default="")
    reviewer_email = Column(String, default="")
    review_note  = Column(String, default="")
    created_at   = Column(String, default="")
    updated_at   = Column(String, default="")
    submitted_at = Column(String, default="")
    decided_at   = Column(String, default="")
    decided_by   = Column(String, default="")


class KbPageVersion(Base):
    """Every published version of a page, exactly as it read: the version
    list, the compare view, what a signature or a course lesson is pinned to.
    Migration turns the old kb_snapshots into these (order fixed)."""
    __tablename__ = "kb_page_versions"
    id            = Column(String, primary_key=True)   # ver_ + hex
    doc_id        = Column(String, nullable=False, index=True)
    major         = Column(Integer, default=0)
    minor         = Column(Integer, default=0)
    version       = Column(String, default="")         # "2.1"
    title         = Column(String, default="")
    summary       = Column(String, default="")
    blocks        = Column(Text, default="")
    content_text  = Column(Text, default="")
    change_kind   = Column(String, default="")         # minor | major | import | migrated
    change_note   = Column(String, default="")
    author_email  = Column(String, default="")
    approved_by   = Column(String, default="")
    published_at  = Column(String, default="")
    legacy_snapshot_id = Column(String, default="")   # KbSnapshot.id it came from


class KbEvent(Base):
    """The page's activity log, append-only: created, submitted, approved,
    published, archived, restored, verified, flagged, signed, translated..."""
    __tablename__ = "kb_events"
    id         = Column(String, primary_key=True)   # evt_ + hex
    doc_id     = Column(String, default="", index=True)
    course_id  = Column(String, default="", index=True)
    kind       = Column(String, nullable=False)
    version    = Column(String, default="")
    actor_email = Column(String, default="")
    actor_name = Column(String, default="")
    note       = Column(String, default="")
    created_at = Column(String, default="", index=True)


class KbSignature(Base):
    """A policy signature: the typed name, the time, the version and the text
    as it read at that moment. A signature counts while the page's MAJOR
    version is the one signed; a new major version asks everyone again."""
    __tablename__ = "kb_signatures"
    id           = Column(String, primary_key=True)   # sig_ + hex
    doc_id       = Column(String, nullable=False, index=True)
    version      = Column(String, default="")
    major        = Column(Integer, default=0)
    user_email   = Column(String, nullable=False, index=True)
    user_name    = Column(String, default="")
    typed_name   = Column(String, default="")
    signed_at    = Column(String, default="")
    content_text = Column(Text, default="")           # the page as read, flattened
    content_hash = Column(String, default="")         # sha256 of content_text
    method       = Column(String, default="in_page")  # in_page | nexus_sign | legacy
    legacy_ack_id = Column(String, default="")        # KbAcknowledgement.id it was converted from


class KbFlag(Base):
    """Report a Problem on a page - goes to the owner as a flagged item in
    Manage > Health until it is resolved."""
    __tablename__ = "kb_flags"
    id          = Column(String, primary_key=True)   # flg_ + hex
    doc_id      = Column(String, nullable=False, index=True)
    version     = Column(String, default="")
    user_email  = Column(String, default="")
    user_name   = Column(String, default="")
    text        = Column(String, default="")
    status      = Column(String, default="open")     # open | resolved
    created_at  = Column(String, default="")
    resolved_at = Column(String, default="")
    resolved_by = Column(String, default="")
    resolution  = Column(String, default="")


class KbView(Base):
    """One row per person per page per day - the only thing a page open writes."""
    __tablename__ = "kb_views"
    id         = Column(String, primary_key=True)
    doc_id     = Column(String, nullable=False, index=True)
    user_email = Column(String, default="")
    day        = Column(String, default="", index=True)   # YYYY-MM-DD
    count      = Column(Integer, default=1)


class KbSearchLog(Base):
    """Searches that found nothing good - the Health screen's "we need a page
    for this" list. One row per query per day."""
    __tablename__ = "kb_search_log"
    id         = Column(String, primary_key=True)
    query      = Column(String, nullable=False)
    day        = Column(String, default="", index=True)
    count      = Column(Integer, default=1)
    results    = Column(Integer, default=0)          # best result count seen that day
    last_user  = Column(String, default="")


class KbPageRequest(Base):
    """A reader asked for a page that does not exist - notifies the collection
    owner (or the Knowledge Base managers) and sits in Manage > Health."""
    __tablename__ = "kb_page_requests"
    id            = Column(String, primary_key=True)   # req_ + hex
    query         = Column(String, default="")
    note          = Column(String, default="")
    collection_id = Column(String, default="")
    user_email    = Column(String, default="")
    user_name     = Column(String, default="")
    status        = Column(String, default="open")     # open | done | declined
    doc_id        = Column(String, default="")         # the page written in answer
    created_at    = Column(String, default="")
    closed_at     = Column(String, default="")
    closed_by     = Column(String, default="")


class KbJob(Base):
    """A background AI job (import, course generation, translation) the screen
    polls for progress. Result is JSON."""
    __tablename__ = "kb_jobs"
    id         = Column(String, primary_key=True)   # job_ + hex
    kind       = Column(String, nullable=False)      # import | course | translate
    status     = Column(String, default="queued")    # queued | running | done | failed
    progress   = Column(Integer, default=0)
    total      = Column(Integer, default=0)
    doc_id     = Column(String, default="")
    course_id  = Column(String, default="")
    input      = Column(Text, default="")            # JSON (kept for retry)
    result     = Column(Text, default="")            # JSON
    error      = Column(String, default="")
    created_by = Column(String, default="")
    created_at = Column(String, default="")
    updated_at = Column(String, default="")


class KbTaskLink(Base):
    """An SOP started as a task: which task, from which version."""
    __tablename__ = "kb_task_links"
    id         = Column(String, primary_key=True)
    doc_id     = Column(String, nullable=False, index=True)
    version    = Column(String, default="")
    task_id    = Column(String, nullable=False, index=True)
    recurring  = Column(Boolean, default=False)
    created_by = Column(String, default="")
    created_at = Column(String, default="")


class KbCourseVersion(Base):
    """Every published version of a course, so people mid-course finish the
    version they started and a certificate names the version it was for."""
    __tablename__ = "kb_course_versions"
    id           = Column(String, primary_key=True)   # cv_ + hex
    course_id    = Column(String, nullable=False, index=True)
    major        = Column(Integer, default=1)
    title        = Column(String, default="")
    description  = Column(String, default="")
    overview     = Column(Text, default="")           # JSON [str]
    est_minutes  = Column(Integer, default=15)
    lessons      = Column(Text, default="")           # JSON
    quiz         = Column(Text, default="")           # JSON (answers included - never sent to learners)
    published_at = Column(String, default="")
    published_by = Column(String, default="")
    change_note  = Column(String, default="")


class KbCertificate(Base):
    """A stored training certificate with a serial number, downloadable at any
    time and checkable by anyone signed in."""
    __tablename__ = "kb_certificates"
    id            = Column(String, primary_key=True)   # cert_ + hex
    serial        = Column(String, nullable=False, unique=True, index=True)   # CERT-2026-00417
    course_id     = Column(String, nullable=False, index=True)
    course_code   = Column(String, default="")
    course_title  = Column(String, default="")
    course_major  = Column(Integer, default=0)
    user_email    = Column(String, nullable=False, index=True)
    user_name     = Column(String, default="")
    score         = Column(Integer, default=0)
    issued_at     = Column(String, default="")
    expires_at    = Column(String, default="")         # "" = never
    assignment_id = Column(String, default="")
    revoked_at    = Column(String, default="")
    legacy        = Column(Boolean, default=False)     # issued by the migration for an old completion


class KbAssignmentRule(Base):
    """Who takes a course (or a plan) automatically: an audience, a due window
    counted from the person's start date (or the rule's creation), and an
    optional renewal. The daily scan creates the assignments."""
    __tablename__ = "kb_assignment_rules"
    id           = Column(String, primary_key=True)   # rule_ + hex
    kind         = Column(String, default="course")   # course | plan
    target_id    = Column(String, nullable=False, index=True)
    audience     = Column(Text, default="")           # kb_audience.py JSON
    due_days     = Column(Integer, default=14)
    renew_months = Column(Integer, default=0)
    active       = Column(Boolean, default=True)
    created_by   = Column(String, default="")
    created_at   = Column(String, default="")
    updated_at   = Column(String, default="")
    last_run_at  = Column(String, default="")


class KbTrainingPlan(Base):
    """A bundle of courses and policies for a role ("New Hire: Site Manager"),
    tracked as one checklist in My Training."""
    __tablename__ = "kb_training_plans"
    id          = Column(String, primary_key=True)   # plan_ + hex
    name        = Column(String, nullable=False)
    description = Column(String, default="")
    items       = Column(Text, default="")           # JSON [{kind: course|policy, id, order}]
    due_days    = Column(Integer, default=30)
    audience    = Column(Text, default="")           # JSON, "" = assigned by name only
    active      = Column(Boolean, default=True)
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    updated_at  = Column(String, default="")


class KbPlanAssignment(Base):
    """A plan given to one person (by rule or by hand)."""
    __tablename__ = "kb_plan_assignments"
    id          = Column(String, primary_key=True)
    plan_id     = Column(String, nullable=False, index=True)
    user_email  = Column(String, nullable=False, index=True)
    user_name   = Column(String, default="")
    due_date    = Column(String, default="")
    source      = Column(String, default="manual")   # manual | rule
    assigned_by = Column(String, default="")
    created_at  = Column(String, default="")
    completed_at = Column(String, default="")


class KbReminderLog(Base):
    """One row per reminder actually sent (bell or email), so the daily scan
    never repeats one: (kind, ref, recipient, day) is the key."""
    __tablename__ = "kb_reminder_log"
    id         = Column(String, primary_key=True)
    kind       = Column(String, nullable=False)
    ref_id     = Column(String, default="", index=True)
    recipient  = Column(String, default="", index=True)
    day        = Column(String, default="")
    created_at = Column(String, default="")


class TimecardBonus(Base):
    """A bonus on one person's pay period (Neil, Oct 22 2026): a manager or HR
    writes why and how much; it adds to the period's pay, prints on the Time
    Sheet the employee signs and on a contractor's invoice. `date` is a day
    inside the period it pays in (the period start when added), so it lands on
    a bi-weekly or a monthly card alike. Removing one stamps removed_* - the
    row stays as the record."""
    __tablename__ = "timecard_bonuses"
    id             = Column(String, primary_key=True)
    employee_email = Column(String, index=True, nullable=False)
    date           = Column(String, index=True, nullable=False)   # YYYY-MM-DD
    description    = Column(String, default="")
    amount         = Column(Float, default=0.0)
    created_by     = Column(String, default="")
    created_at     = Column(String, default="")
    removed_by     = Column(String, default="")
    removed_at     = Column(String, default="")


class AccountingAmaPushPreview(Base):
    """CR-13 rework (Neil, 23 Oct 2026: "The push should edit the original
    ... CAREFUL TO GET THIS RIGHT"): what a bookkeeper was SHOWN before a
    push - for each Intacct entry the reclasses touch, the entry as read
    (`entries[].before`), the exact update that would be sent
    (`entries[].update`) and a fingerprint of the entry. A push names its
    preview: it must be this person's, unused and fresh, for the same lines,
    and the entry must read the same again or nothing is sent.
    routers/accounting_ask_review.py. New table - create_all builds it; RLS
    by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_push_previews"
    id          = Column(String, primary_key=True)                 # uuid
    created_by  = Column(String, default="", index=True)
    created_at  = Column(String, default="")
    expires_at  = Column(String, default="")
    review_ids  = Column(JSON, default=list)                       # the AccountingAmaLineReview ids, sorted
    source      = Column(String, default="")                       # intacct | ledger
    live        = Column(Boolean, default=False)                   # AMA_PUSH_TO_INTACCT when previewed
    entries     = Column(JSON, default=list)                       # [{key, fingerprint, before, update, changes}]
    used_at     = Column(String, default="")


class AccountingAmaPushLog(Base):
    """CR-13 rework: one row per Intacct entry a push touched (or, with the
    push switched off, would have touched) - who, when, the entry before,
    exactly what was sent, what Intacct answered, the entry read again after,
    and the outcome (edited | dry_run | failed | unconfirmed | already_done |
    stale). APPEND-ONLY: never updated or deleted by code.
    routers/accounting_ask_review.py. New table - create_all builds it; RLS
    by main.py and the startup sweep."""
    __tablename__ = "accounting_ama_push_log"
    id          = Column(String, primary_key=True)                 # uuid
    at          = Column(String, default="", index=True)
    by          = Column(String, default="")
    preview_id  = Column(String, default="", index=True)
    review_ids  = Column(JSON, default=list)
    entry_key   = Column(String, default="", index=True)           # Intacct GLBATCH RECORDNO (else the ledger entry id)
    entry_no    = Column(String, default="")
    mode        = Column(String, default="")                       # live | dry_run
    source      = Column(String, default="")                       # intacct | ledger
    before      = Column(JSON, default=dict)
    sent        = Column(JSON, default=dict)                       # the update, as sent (or as it would be)
    sent_xml    = Column(Text, default="")
    response    = Column(Text, default="")
    after       = Column(JSON, default=dict)
    outcome     = Column(String, default="")
    error       = Column(Text, default="")
# ── Build Mode (Neil, Oct 24 2026) ─────────────────────────────────────────────
# Pins, Build Sessions and Build Tokens for routers/dev_notes.py. Brand-new
# tables: create_all builds them and main.py's _enable_rls_everywhere turns RLS
# on at startup, so they need no ALTER lines in the migration lists. A column
# added to one of them AFTER its first release does - in BOTH lists.
class DevNote(Base):
    """One Pin: a comment plus markup on one element of the live app, with the
    captured context (route, viewport, selector, console and network tails,
    screenshots, recording), its thread with Claude Code, and the PR that
    fixed it. Status machine in docs/Build-Mode.md."""
    __tablename__ = "dev_notes"
    id                = Column(String, primary_key=True)
    session_id        = Column(String, default="", index=True)   # dev_note_sessions.id ('' = none yet)
    number            = Column(Integer, default=0)               # pin number on screen, per session
    kind              = Column(String, default="bug")            # bug | change | question | edit
    priority          = Column(String, default="normal")         # blocking | normal | nice
    status            = Column(String, default="open", index=True)
    comment           = Column(Text, default="")
    thread            = Column(JSON, default=list)               # [{id, by, at, kind, text, image_url}]
    route             = Column(String, default="")               # activeView
    sub               = Column(String, default="")               # activeSub
    url               = Column(String, default="")
    build_id          = Column(String, default="")
    viewport          = Column(JSON, default=dict)               # {w, h, dpr, ua, phone, theme}
    target            = Column(JSON, default=dict)
    markup            = Column(JSON, default=dict)
    edit              = Column(JSON, default=dict)
    screenshot_url    = Column(String, default="")
    page_shot_url     = Column(String, default="")
    video_url         = Column(String, default="")
    contact_sheet_url = Column(String, default="")
    transcript        = Column(Text, default="")
    attachments       = Column(JSON, default=list)               # [url]
    console_log       = Column(JSON, default=list)               # [{level, text, at}] max 50
    network_log       = Column(JSON, default=list)               # [{method, path, status, ms, at}] max 30
    dispatch_target   = Column(String, default="local")          # local | github (github reserved)
    dispatched_at     = Column(String, default="")
    progress          = Column(String, default="")
    progress_at       = Column(String, default="")
    branch            = Column(String, default="")
    pr_url            = Column(String, default="")
    pr_number         = Column(Integer, default=0, index=True)
    github_issue      = Column(Integer, default=0)               # reserved
    fixed_build_id    = Column(String, default="")               # merge commit sha
    fixed_at          = Column(String, default="")
    verified_by       = Column(String, default="")
    verified_at       = Column(String, default="")
    reopen_count      = Column(Integer, default=0)
    created_by        = Column(String, default="", index=True)
    created_at        = Column(String, default="")
    updated_at        = Column(String, default="")
    actions           = Column(JSON, default=list)               # last 30 user actions before the pin [{t, type, label, selector, value, view, sub}]
    state             = Column(JSON, default=dict)               # the target's React props/state snapshot (client-capped)
    verification      = Column(JSON, default=dict)               # written by the CLI: {repro, styleCheck, visual}
    purge_at          = Column(String, default="")               # done/dismissed + 30 days: media objects are purged after this
    # Build Mode v2 (Oct 24 2026) - ALTER lines in BOTH of main.py's migration lists.
    owner_email        = Column(String, default="")              # code_owners.owner_of(target.source.file), set by the server on create
    owner_name         = Column(String, default="")
    owner_released_by  = Column(String, default="")              # who released a held pin to Claude Code
    owner_released_at  = Column(String, default="")
    preview            = Column(JSON, default=dict)              # Ready To Check: {url, branch, prNumber, host, startedAt}; {} = none
    preview_verdict    = Column(String, default="")              # '' | accepted | reopened
    preview_verdict_at = Column(String, default="")
    regression_case_id = Column(String, default="")              # qa_test_cases.id once promoted (= the pin id)
    # Who sent it (Oct 26 2026): only THEIR Claude Code picks it up - a Build
    # Token's watcher sees and claims only the pins its owner sent ('' on rows
    # sent before this = the author). ALTER lines in both migration lists.
    dispatched_by      = Column(String, default="")


class DevNoteSession(Base):
    """One Build Session: the pins a person collected together and sent to
    Claude Code in one go. A person has at most one `collecting` session."""
    __tablename__ = "dev_note_sessions"
    id            = Column(String, primary_key=True)
    title         = Column(String, default="")
    status        = Column(String, default="collecting")   # collecting | sent | building | pr_open | fixed | done
    created_by    = Column(String, default="", index=True)
    created_at    = Column(String, default="")
    updated_at    = Column(String, default="")
    dispatched_at = Column(String, default="")
    branch        = Column(String, default="")
    pr_url        = Column(String, default="")
    pr_number     = Column(Integer, default=0)
    note_count    = Column(Integer, default=0)


class DevNoteToken(Base):
    """A Build Token for the local watcher / CLI: `nxbn_` + 43 urlsafe chars,
    stored only as its sha256, 30 days, shown once, revocable."""
    __tablename__ = "dev_note_tokens"
    id           = Column(String, primary_key=True)
    email        = Column(String, nullable=False, index=True)
    label        = Column(String, default="")
    token_hash   = Column(String, nullable=False, index=True)
    created_at   = Column(String, default="")
    expires_at   = Column(String, default="")
    last_used_at = Column(String, default="")
    revoked_at   = Column(String, default="")


class AccountingTaxLine(Base):
    """Which line of a tax form one GL account adds into (Neil, Viral, 10/27
    triage item 18: Schedule C first; Schedule E, Form 4562 and the 1040 /
    1120 / 1120-S / 1065 forms later). Kept in Nexus only - the figures stay
    on the ledger, nothing is written to Intacct. `entity` '' is the mapping
    for every entity; an entity's own row overrides it. `line` is the form's
    line number ("8", "16a", "27b") or "skip" (not on this form). New table -
    create_all builds it; RLS by the line in main.py and the startup sweep."""
    __tablename__ = "accounting_tax_lines"
    id         = Column(String, primary_key=True)                # uuid
    form       = Column(String, default="schedule_c", index=True)
    entity     = Column(String, default="", index=True)          # "" = every entity
    account_no = Column(String, default="", index=True)
    line       = Column(String, default="")
    set_by     = Column(String, default="")
    set_at     = Column(String, default="")


class AccountingLiabilityRecon(Base):
    """One month's reconciliation of a mortgage, loan or line of credit
    (Charmi, 10/25-10/26, item 09; Neil: "Intacct doesn't have it. Should do
    in Nexus."). The loan is a fin_loans row in the accounting app (lender,
    entity, principal GL account); the person types the lender statement's
    ending balance, Nexus reads the ledger balance of that GL in that entity
    on the statement date and keeps the difference. The month can be marked
    Reconciled only when the difference is 0.00; only an Accounting admin
    reopens it, and every save, reconcile and reopen is written to
    accounting_liability_recon_log. Saved in Nexus only - never sent to
    Intacct. Amounts are what is OWED (a liability's credit balance as a
    positive figure). One row per loan and month. New table - RLS on dev and
    prod at release."""
    __tablename__ = "accounting_liability_recons"
    __table_args__ = (UniqueConstraint("loan_id", "period", name="uq_accounting_liability_recon"),)
    id                = Column(String, primary_key=True)              # uuid
    loan_id           = Column(String, nullable=False, index=True)    # fin_loans.id
    entity_code       = Column(String, default="", index=True)
    gl_account        = Column(String, default="")
    account_name      = Column(String, default="")                    # the lender, as the list shows it
    period            = Column(String, nullable=False, index=True)    # YYYY-MM
    statement_date    = Column(String, default="")                    # YYYY-MM-DD, inside the period
    statement_balance = Column(Float, nullable=True)
    ledger_balance    = Column(Float, nullable=True)                  # read when saved
    difference        = Column(Float, nullable=True)                  # statement - ledger
    status            = Column(String, default="open")                # open | reconciled
    statement_url     = Column(String, default="")                    # private task-files storage
    statement_name    = Column(String, default="")
    note              = Column(Text, default="")
    saved_by          = Column(String, default="")
    saved_at          = Column(String, default="")
    reconciled_by     = Column(String, default="")
    reconciled_at     = Column(String, default="")
    reopened_by       = Column(String, default="")
    reopened_at       = Column(String, default="")
    reopen_reason     = Column(Text, default="")


class AccountingLiabilityReconLog(Base):
    """Append-only history of accounting_liability_recons: saved, reconciled,
    reopened - who, when and the figures at that moment. Never edited or
    deleted. New table - RLS on dev and prod at release."""
    __tablename__ = "accounting_liability_recon_log"
    id        = Column(String, primary_key=True)                      # uuid
    recon_id  = Column(String, nullable=False, index=True)
    loan_id   = Column(String, nullable=False, index=True)
    period    = Column(String, default="")
    action    = Column(String, default="")                            # saved | reconciled | reopened
    by_email  = Column(String, default="")
    by_name   = Column(String, default="")
    at        = Column(String, default="")
    detail    = Column(JSON, default=dict)


class EmployeeCustomField(Base):
    """An HR-defined extra field on employee records (Neil, Oct 27 2026,
    hr_custom_fields.py). The value for each person lives in
    NexusEmployee.custom_fields keyed by `field_key`, which never changes once
    the field exists (it is also the {{custom.<field_key>}} merge variable).
    company_id '' = every company. Archiving hides the field; values are never
    deleted. New table - create_all builds it; RLS on dev and prod at release."""
    __tablename__ = "employee_custom_fields"
    id          = Column(String, primary_key=True)                 # uuid
    field_key   = Column(String, nullable=False, index=True)       # stable key in NexusEmployee.custom_fields
    label       = Column(String, nullable=False)
    field_type  = Column(String, default="text")                   # text | number | date | dropdown | checkbox
    options     = Column(JSON, default=list)                       # dropdown choices
    company_id  = Column(String, default="", index=True)           # '' = every company, else an HrEntity id
    required    = Column(Integer, default=0)
    sort_order  = Column(Integer, default=0)
    visibility  = Column(String, default="hr_only")                # hr_only | employee_view | employee_edit
    archived    = Column(Integer, default=0)
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    updated_by  = Column(String, default="")
    updated_at  = Column(String, default="")


class HrLetterRequest(Base):
    """A standard HR letter an employee asked for from My HR (Neil, Oct 27
    2026, hr_letters.py): Employment Verification, Salary Certificate,
    Experience Letter, Address Proof, Visa NOC. HR for the person's company
    reviews the letter generated from the type's Documents template, edits
    its values, then Issues it (a Nexus Sign envelope to the company
    signatory, the only signer) or Declines it with a reason. Sealed, the
    letter is in the employee's My HR documents and filed to their Egnyte
    folder. Pay is never stored in `values`: a Salary Certificate's pay is
    read from Pay & Benefits at render time, or from `pay_values` (what an
    hr_comp holder typed), which only hr_comp holders ever see.
    New table - create_all builds it; RLS on dev and prod at release."""
    __tablename__ = "hr_letter_requests"
    id               = Column(String, primary_key=True)                # uuid
    employee_id      = Column(String, nullable=False, index=True)      # NexusEmployee.id
    employee_email   = Column(String, default="", index=True)
    employee_name    = Column(String, default="")
    company_id       = Column(String, default="", index=True)          # HrEntity.id at request time
    letter_type      = Column(String, nullable=False)                  # hr_letters.LETTER_TYPES key
    purpose          = Column(Text, default="")
    addressed_to     = Column(String, default="")
    needed_by        = Column(String, default="")                      # ISO date
    notes            = Column(Text, default="")
    # requested | in_review | awaiting_signature | issued | declined
    status           = Column(String, default="requested", index=True)
    values           = Column(JSON, default=dict)                      # HR's edits to the letter's non-pay values
    pay_values       = Column(JSON, default=dict)                      # RESTRICTED (hr_comp): HR's typed pay values
    template_id      = Column(String, default="")                      # the Documents template it was issued from
    template_version = Column(Integer, default=0)
    signer_email     = Column(String, default="")
    signer_name      = Column(String, default="")
    sign_request_id  = Column(String, default="")                      # HrSignRequest.id once issued
    decline_reason   = Column(Text, default="")
    reviewed_by      = Column(String, default="")
    reviewed_at      = Column(String, default="")
    issued_by        = Column(String, default="")
    issued_at        = Column(String, default="")                      # sent for the signature
    completed_at     = Column(String, default="")                      # sealed
    declined_by      = Column(String, default="")
    declined_at      = Column(String, default="")
    note             = Column(Text, default="")                        # the last thing that happened, for both sides
    filing_status    = Column(String, default="")                      # '' | pending | filed | failed
    filing_path      = Column(String, default="")
    filing_error     = Column(Text, default="")
    filing_attempts  = Column(Integer, default=0)
    filing_next_at   = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")


class HrHeadcountRequest(Base):
    """A headcount requisition (Neil, Oct 27 2026, routers/hiring.py) - a
    manager or HR asks to hire before there is any candidate. NOT a purchase
    requisition (routers/requisitions.py). Approved by the department head's
    line, then HR (the company's HR contact, an administrator or owner, or a
    Full People grant). Approval makes a job opening (HrJobOpening).
    The salary range is restricted: only Pay & Benefits (hr_comp) holders and
    owners see it. `history` is append-only. New table - RLS at release."""
    __tablename__ = "hr_headcount_requests"
    id              = Column(String, primary_key=True)                # uuid
    code            = Column(String, default="")                      # HC-0001
    company         = Column(String, default="", index=True)          # HrEntity.id
    department      = Column(String, default="")
    role_id         = Column(String, default="")                      # NexusGroup.id (job role), '' = typed title
    role_title      = Column(String, default="")
    work_site_id    = Column(String, default="")                      # HrWorkSite.id, '' = typed location
    location        = Column(String, default="")
    employment_type = Column(String, default="full_time")             # full_time | part_time | contractor | intern | temporary
    openings        = Column(Integer, default=1)
    target_start    = Column(String, default="")                      # ISO date
    salary_min      = Column(Float, nullable=True)                    # restricted (hr_comp / owner)
    salary_max      = Column(Float, nullable=True)
    salary_currency = Column(String, default="USD")
    salary_period   = Column(String, default="year")                  # year | month | hour
    justification   = Column(Text, default="")
    status          = Column(String, default="draft", index=True)     # draft | awaiting_approval | approved | declined
    step            = Column(String, default="")                      # '' | department | hr - who it waits on
    dept_approvers  = Column(JSON, default=list)                      # the department line at submit (snapshot)
    dept_decided_by = Column(String, default="")
    dept_decided_at = Column(String, default="")
    hr_decided_by   = Column(String, default="")
    hr_decided_at   = Column(String, default="")
    decline_note    = Column(Text, default="")
    opening_id      = Column(String, default="")                      # HrJobOpening.id once approved
    requested_by    = Column(String, default="", index=True)
    submitted_at    = Column(String, default="")
    history         = Column(JSON, default=list)                      # [{at, by, action, note}] - append-only
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")


class HrJobOpening(Base):
    """A job opening (Oct 27 2026): what an approved headcount request becomes,
    and what the public careers page lists (routers/careers.py) while Open.
    The pay range shows publicly only when show_pay is on (pay transparency,
    off by default); otherwise only hr_comp holders and owners see it.
    Filling the last seat marks it Filled. New table - RLS at release."""
    __tablename__ = "hr_job_openings"
    id               = Column(String, primary_key=True)               # uuid - also the public URL id
    headcount_id     = Column(String, default="", index=True)         # HrHeadcountRequest.id
    company          = Column(String, default="", index=True)         # HrEntity.id
    department       = Column(String, default="")
    role_id          = Column(String, default="")
    title            = Column(String, default="")
    description      = Column(Text, default="")                       # plain text: blank lines = paragraphs, "- " = bullets
    employment_type  = Column(String, default="full_time")
    seats            = Column(Integer, default=1)
    work_site_id     = Column(String, default="")
    location         = Column(String, default="")                     # display line, e.g. "Austin, TX"
    street           = Column(String, default="")
    city             = Column(String, default="")
    region           = Column(String, default="")                     # state / province
    postal_code      = Column(String, default="")
    country          = Column(String, default="")                     # ISO alpha-2
    remote           = Column(Boolean, default=False)
    status           = Column(String, default="draft", index=True)    # draft | open | paused | filled | closed
    show_pay         = Column(Boolean, default=False)                 # public pay range (pay transparency)
    pay_min          = Column(Float, nullable=True)
    pay_max          = Column(Float, nullable=True)
    pay_currency     = Column(String, default="USD")
    pay_period       = Column(String, default="year")                 # year | month | hour
    hiring_owner_email = Column(String, default="")                   # gets the grouped new-applicant bell
    valid_through    = Column(String, default="")                     # ISO date - off the careers page after it
    opened_at        = Column(String, default="")
    filled_at        = Column(String, default="")
    closed_at        = Column(String, default="")
    history          = Column(JSON, default=list)                     # [{at, by, action, note}] - append-only
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    updated_at       = Column(String, default="")


class SalaryAdvance(Base):
    """A salary advance (Neil, Oct 27 2026): pay given ahead of payday and
    taken back out of later pay periods (salary_advance.py).

    Who asks: a person whose role tier is manager or above, for themself.
    Who decides: ONLY HR as on time sheets (timesheet_review.is_hr - the
    company's HR contact, an administrator, a Full HR grant; never on their
    own), who can also grant one to anyone directly.
    status: requested -> approved -> paid_out; declined, canceled. Repaying /
    Repaid are read off the installments, never stored. Every step is on
    `history`; nothing is deleted. New table - RLS on dev and prod at release."""
    __tablename__ = "salary_advances"
    id              = Column(String, primary_key=True)                # uuid
    employee_email  = Column(String, index=True, nullable=False)
    employee_name   = Column(String, default="")
    company         = Column(String, default="", index=True)          # HrEntity id
    amount          = Column(Float, default=0.0)
    currency        = Column(String, default="USD")
    reason          = Column(Text, default="")
    installments    = Column(Integer, default=1)                      # how many pay periods repay it
    status          = Column(String, default="requested", index=True)
    source          = Column(String, default="request")               # request | grant
    requested_by    = Column(String, default="")
    requested_at    = Column(String, default="")
    decided_by      = Column(String, default="")
    decided_at      = Column(String, default="")
    decision_note   = Column(Text, default="")
    paid_on         = Column(String, default="")                      # YYYY-MM-DD
    paid_by         = Column(String, default="")
    payment_method  = Column(String, default="")
    payment_ref     = Column(String, default="")
    history         = Column(JSON, default=list)                      # [{at, by, action, note, detail}]
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")


class SalaryAdvanceInstallment(Base):
    """One pay period's repayment of a salary advance. `date` is the first
    day of the pay period it comes out of, so it lands on a bi-weekly or a
    monthly card alike. scheduled -> deducted when that period is finalized
    (deducted_amount = what the card took, final_approval_id = the
    finalization); a period that paid less than the installment carries the
    rest forward as a new row (`carried_from`). canceled rows stay as the
    record. New table - RLS on dev and prod at release."""
    __tablename__ = "salary_advance_installments"
    id                = Column(String, primary_key=True)              # uuid
    advance_id        = Column(String, index=True, nullable=False)
    employee_email    = Column(String, index=True, nullable=False)
    seq               = Column(Integer, default=1)
    amount            = Column(Float, default=0.0)
    currency          = Column(String, default="USD")
    date              = Column(String, index=True, nullable=False)    # YYYY-MM-DD, the period's first day
    status            = Column(String, default="scheduled", index=True)   # scheduled | deducted | canceled
    deducted_amount   = Column(Float, default=0.0)
    final_approval_id = Column(String, default="", index=True)        # TimeApproval(kind="final").id
    carried_from      = Column(String, default="")
    created_at        = Column(String, default="")
    updated_at        = Column(String, default="")


class ExitStatement(Base):
    """A leaver's final settlement statement (Neil, Oct 27 2026,
    exit_statement.py): the figures payroll needs for the final pay, read
    live from the time sheet, leave, reimbursements, salary advances, items
    and the offboarding checklist. Information for payroll - Nexus does not
    run the final pay. HR marks it Reviewed (the figures are frozen in
    `snapshot` with their `fingerprint`), then generates the PDF (kept in
    their HR documents as kind 'settlement', filed to Egnyte best-effort),
    then closes the exit. `snapshot` holds pay - hr_comp / owner only.
    New table - RLS on dev and prod at release."""
    __tablename__ = "exit_statements"
    id              = Column(String, primary_key=True)                # uuid
    employee_id     = Column(String, index=True, nullable=False)      # NexusEmployee.id
    employee_email  = Column(String, default="", index=True)
    company         = Column(String, default="", index=True)
    event_id        = Column(String, default="")                      # HrLifeEvent.id of the separation ('' = none)
    last_day        = Column(String, default="")                      # YYYY-MM-DD
    status          = Column(String, default="open", index=True)      # open | reviewed | filed | closed
    fingerprint     = Column(String, default="")                      # of the figures when reviewed
    snapshot        = Column(JSON, default=dict)                      # RESTRICTED: the reviewed statement
    reviewed_by     = Column(String, default="")
    reviewed_at     = Column(String, default="")
    document_id     = Column(String, default="")                      # HrDocument.id of the PDF
    pdf_path        = Column(String, default="")
    egnyte_path     = Column(String, default="")
    generated_by    = Column(String, default="")
    generated_at    = Column(String, default="")
    closed_by       = Column(String, default="")
    closed_at       = Column(String, default="")
    history         = Column(JSON, default=list)                      # [{at, by, action, note}]
    created_at      = Column(String, default="")
    updated_at      = Column(String, default="")
