"""Items pack (Task 11): a transient checkout (`item_checkout`) and a
permanent assignment (`item_assignment`), with their events coming ONLY
from the record observer (spec 5.3) - routers/items.py is Visesh's and is
not touched. Both entities are registered with `observe=True,
observe_fields=("status",)`, so the observer emits:

  * `item_checkout.created` / `item_assignment.created` for a new row;
  * `item_checkout.field_changed` / `item_assignment.field_changed` for a
    status change, with the from / to in `changes.status` - these ARE the
    "status changed" events (the only observed field is the status; the
    key is the observer's, kept as it is so the catalog says exactly what
    fires).

Lifecycles (CLAUDE.md): a checkout goes pending -> approved ->
pending_receipt -> allocated -> returned (or rejected / cancelled); an
assignment pending_acceptance -> active -> return_initiated -> closed (or
declined / cancelled). A checkout's due date counts from the handover
(`wf_due_date`: handed over, else allocated, else requested, plus `days`).

`visible_to`: the run-as user is the person, their manager, or holds the
Item Management grant / administrator. `may_use`: the Item Management
(`inventory`) grant or an administrator.
"""
from __future__ import annotations

from datetime import timedelta

import models
from workflows.catalog import F, entity, event, list_source
from workflows.packs._people import (attach_property, emails, has_grant, is_admin, parse_dt, person_company,
                                     person_manager)

MODULE = "items"
GRANT = "inventory"      # the module id in RoleContext.jsx MODULES ("Item Management")

CHECKOUT_STATUSES = [
    ("pending", "Pending"), ("approved", "Approved"), ("pending_receipt", "Pending Receipt"),
    ("allocated", "Allocated"), ("returned", "Returned"), ("rejected", "Rejected"), ("cancelled", "Cancelled"),
]
ASSIGNMENT_STATUSES = [
    ("pending_acceptance", "Pending Acceptance"), ("active", "Active"), ("return_initiated", "Return Initiated"),
    ("closed", "Closed"), ("declined", "Declined"), ("cancelled", "Cancelled"),
]


# ── derived attributes ───────────────────────────────────────────────────────
def _due_date(co) -> str:
    start = parse_dt(co.handed_over_at or co.allocated_at or co.created_at)
    if start is None:
        return ""
    try:
        days = int(co.days or 0)
    except (TypeError, ValueError):
        days = 0
    return (start + timedelta(days=days)).date().isoformat()


attach_property(models.ItemCheckout, "wf_due_date", _due_date)


# ── access ───────────────────────────────────────────────────────────────────
def may_use(db, user) -> bool:
    if not user:
        return False
    return is_admin(user) or has_grant(db, user, GRANT)


def _visible(db, user, email: str) -> bool:
    if not user:
        return False
    me = (user.get("email") or "").lower()
    em = (email or "").lower()
    if me and em and (me == em or me in person_manager(db, em)):
        return True
    return may_use(db, user)


# ── people ───────────────────────────────────────────────────────────────────
def _co_self(db, row) -> list[str]:
    return emails(row.requested_by_email)


def _co_manager(db, row) -> list[str]:
    return person_manager(db, row.requested_by_email)


def _co_approver(db, row) -> list[str]:
    return emails(row.approver_email)


def _co_allocator(db, row) -> list[str]:
    return emails(row.assigned_allocator_email)


def _as_self(db, row) -> list[str]:
    return emails(row.assignee_email)


def _as_manager(db, row) -> list[str]:
    return person_manager(db, row.assignee_email)


def _as_assigned_by(db, row) -> list[str]:
    return emails(row.assigned_by_email)


# ── entities ─────────────────────────────────────────────────────────────────
entity("item_checkout", label="Item Checkout", model=models.ItemCheckout, module=MODULE,
       company=lambda row: person_company(row, row.requested_by_email),
       link=lambda row: {"view": "inventory", "sub": "checkouts", "checkout": row.id},
       people={"self": _co_self, "manager": _co_manager, "approver": _co_approver, "allocator": _co_allocator},
       people_labels={"self": "Requester", "allocator": "Allocator"},
       fields=[
           F("item_name", "Item", "text"),
           F("item_type", "Item Type", "text"),
           F("status", "Status", "select", options=CHECKOUT_STATUSES),
           F("requested_by_email", "Requested By", "person"),
           F("requested_by", "Requested By (Name)", "text"),
           F("department", "Department", "select", options="departments"),
           F("days", "Days", "number"),
           F("reason", "Reason", "text"),
           F("due_date", "Due Date", "date", path="wf_due_date"),
           F("created_at", "Requested At", "datetime"),
           F("handed_over_at", "Handed Over At", "datetime"),
           F("returned_at", "Returned At", "datetime"),
           F("approver_email", "Approver", "person"),
           F("assigned_allocator_email", "Allocator", "person"),
           F("extension_days", "Extension Days", "number"),
           F("extension_status", "Extension", "select", options=[("", "None"), ("pending", "Pending")]),
       ],
       dates=["due_date"],
       observe=True, observe_fields=("status",),
       label_of=lambda row: f"{row.item_name} - {row.requested_by or row.requested_by_email}",
       visible_to=lambda db, user, row: _visible(db, user, row.requested_by_email))

entity("item_assignment", label="Item Assignment", model=models.ItemAssignment, module=MODULE,
       company=lambda row: person_company(row, row.assignee_email),
       link=lambda row: {"view": "inventory", "sub": "permanent", "assignment": row.id},
       people={"self": _as_self, "manager": _as_manager, "assigned_by": _as_assigned_by},
       people_labels={"self": "Assignee", "assigned_by": "Assigned By"},
       fields=[
           F("item_name", "Item", "text"),
           F("status", "Status", "select", options=ASSIGNMENT_STATUSES),
           F("assignee_email", "Assignee", "person"),
           F("assignee_name", "Assignee (Name)", "text"),
           F("assigned_by_email", "Assigned By", "person"),
           F("return_reason", "Return Reason", "select",
             options=[("", "None"), ("normal", "Normal"), ("dead", "Dead"), ("lost", "Lost"),
                      ("reassign", "Reassign")]),
           F("disposition", "Disposition", "select",
             options=[("", "None"), ("stock", "Back to Stock"), ("retired", "Retired")]),
           F("next_assignee_email", "Next Assignee", "person"),
           F("created_at", "Assigned At", "datetime"),
           F("accepted_at", "Accepted At", "datetime"),
           F("return_initiated_at", "Return Started At", "datetime"),
           F("return_accepted_at", "Return Accepted At", "datetime"),
       ],
       observe=True, observe_fields=("status",),
       label_of=lambda row: f"{row.item_name} - {row.assignee_name or row.assignee_email}",
       visible_to=lambda db, user, row: _visible(db, user, row.assignee_email))

SAMPLE_CHECKOUT = {
    "item_name": "Dewalt Hammer Drill", "item_type": "Tool", "status": "allocated",
    "requested_by_email": "priya.shah@greensglobal.com", "requested_by": "Priya Shah", "department": "Operations",
    "days": 3, "reason": "Escondido site work", "due_date": "2026-11-05", "created_at": "2026-11-01T16:00:00+00:00",
    "handed_over_at": "2026-11-02T15:30:00+00:00", "returned_at": "",
    "approver_email": "max.miller@greensglobal.com", "assigned_allocator_email": "sam.store@greensglobal.com",
    "extension_days": 0, "extension_status": "",
}
SAMPLE_ASSIGNMENT = {
    "item_name": "MacBook Pro 14", "status": "active", "assignee_email": "priya.shah@greensglobal.com",
    "assignee_name": "Priya Shah", "assigned_by_email": "sam.store@greensglobal.com", "return_reason": "",
    "disposition": "", "next_assignee_email": "", "created_at": "2026-11-01T16:00:00+00:00",
    "accepted_at": "2026-11-01T17:10:00+00:00", "return_initiated_at": "", "return_accepted_at": "",
}

# ── events (the observer's keys) ─────────────────────────────────────────────
event("item_checkout.created", entity="item_checkout", label="Checkout Is Requested", module=MODULE,
      group="Checkouts", may_use=may_use,
      sample=dict(SAMPLE_CHECKOUT, status="pending", handed_over_at="", due_date=""))
event("item_checkout.field_changed", entity="item_checkout", label="Checkout Status Changes", module=MODULE,
      group="Checkouts", changes=("status",), may_use=may_use,
      sample={"subject": dict(SAMPLE_CHECKOUT),
              "changes": {"status": {"from": "pending_receipt", "to": "allocated"}},
              "extra": {"field": "status"}, "actor": ""})
event("item_assignment.created", entity="item_assignment", label="Item Is Assigned", module=MODULE,
      group="Assignments", may_use=may_use,
      sample=dict(SAMPLE_ASSIGNMENT, status="pending_acceptance", accepted_at=""))
event("item_assignment.field_changed", entity="item_assignment", label="Assignment Status Changes", module=MODULE,
      group="Assignments", changes=("status",), may_use=may_use,
      sample={"subject": dict(SAMPLE_ASSIGNMENT),
              "changes": {"status": {"from": "pending_acceptance", "to": "active"}},
              "extra": {"field": "status"}, "actor": ""})


# ── list sources ─────────────────────────────────────────────────────────────
def overdue_checkouts(db, ctx, params) -> list:
    """Allocated checkouts whose due date (handover plus days) is before
    today; in the run's company when it has one."""
    from datetime import date as _date
    today = (getattr(ctx, "today", None) or _date.today()).isoformat()
    rows = (db.query(models.ItemCheckout).filter(models.ItemCheckout.status == "allocated")
            .order_by(models.ItemCheckout.handed_over_at, models.ItemCheckout.id).all())
    cid = (getattr(ctx, "company_id", "") or "")
    memo: dict = {}
    out = []
    for r in rows:
        due = r.wf_due_date
        if not due or due >= today:
            continue
        if cid:
            em = (r.requested_by_email or "").lower()
            if em not in memo:
                memo[em] = person_company(db, em)
            if memo[em] != cid:
                continue
        out.append(r)
    return out


list_source("checkouts.overdue", label="Overdue Checkouts", entity="item_checkout", module=MODULE,
            fn=overdue_checkouts)
