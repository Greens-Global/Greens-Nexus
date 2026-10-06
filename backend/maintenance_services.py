"""Recurring property maintenance services (Pranshu, 10/06/2026).

A resolved property ticket is added to the property's maintenance record by
its asset manager. On the ORIGINAL ("parent") ticket they may set a Next
Service Due and how often it repeats (one time, or every N weeks / months /
years). That is a PropertyMaintenanceService:

  * 15 days before next_due, the asset manager gets one bell: service coming.
  * They can open the service ticket early (open_now). If nobody has by
    next_due, a ticket opens automatically - the parent's details, today's
    date - so a forgotten service still gets done.
  * Either way next_due then moves on by the recurrence; a one-time service
    ends. Each opened ticket is a CHILD of the parent (parent_ticket_id), so
    the property shows the parent with every child, date and cost under it.
  * Children never set a schedule of their own - the parent's drives them.

The daily scan runs inside reminders_loop through asyncio.to_thread - never on
the event loop. A service row is locked (with_for_update) while it opens a
ticket, and last_opened_for records which due date it opened for, so two
workers (or a manual open racing the scan) never open the same one twice.
"""
import calendar
from datetime import date, timedelta

import models
import property_links
from routers.task_util import gen_id, log_activity, now_iso, task_notify

REMINDER_DAYS = 15
UNITS = ("", "week", "month", "year")
_UNIT_LABEL = {"week": "Week", "month": "Month", "year": "Year"}


def parse_ymd(s: str):
    try:
        return date.fromisoformat(str(s or "")[:10])
    except ValueError:
        return None


def us_date(d) -> str:
    """MM/DD/YYYY for bell copy (CLAUDE.md: US dates in user-facing text)."""
    d = parse_ymd(d) if isinstance(d, str) else d
    return d.strftime("%m/%d/%Y") if d else ""


def advance(d: date, unit: str, every: int) -> date:
    every = max(1, int(every or 1))
    if unit == "week":
        return d + timedelta(weeks=every)
    if unit in ("month", "year"):
        months = every * (12 if unit == "year" else 1)
        y, m = divmod(d.month - 1 + months, 12)
        y, m = d.year + y, m + 1
        return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))
    return d


def recurrence_label(unit: str, every: int) -> str:
    if not unit:
        return "One Time"
    every = max(1, int(every or 1))
    return f"Every {_UNIT_LABEL[unit]}" if every == 1 else f"Every {every} {_UNIT_LABEL[unit]}s"


def template_from(t: models.TaskTicket) -> dict:
    """What every ticket the service opens copies from the parent."""
    return {"subject": t.subject, "description": t.description or "", "type": t.type or "incident",
            "priority": t.priority or "medium", "application": t.application or "",
            "hr_department_id": t.hr_department_id or "", "company_id": t.company_id or "",
            "requester_email": t.requester_email or "",
            "location": str((t.type_fields or {}).get("svc_unit") or "")}


def _manager(db, svc) -> str:
    return property_links.manager_email(db, db.get(models.PropertyAsset, svc.property_asset_id))


def open_child(db, svc: models.PropertyMaintenanceService, actor: str, *, automatic: bool) -> models.TaskTicket:
    """Open the service ticket for svc.next_due and move the schedule on.
    The caller holds the service row lock (with_for_update) and commits."""
    from routers import tickets as T
    from ticket_code import TICKET_CODE_DIGITS, ticket_no

    tpl = dict(svc.template or {})
    prop = db.get(models.PropertyAsset, svc.property_asset_id)
    prop_name = property_links.display_name(prop) if prop is not None else ""
    parent = db.get(models.TaskTicket, svc.parent_ticket_id)
    manager = property_links.manager_email(db, prop) if prop is not None else ""
    requester = (manager or tpl.get("requester_email") or actor or "").lower()
    due = svc.next_due
    now = now_iso()
    priority = tpl.get("priority") or "medium"
    note = (f"<p><em>Scheduled service ({recurrence_label(svc.recurrence_unit, svc.recurrence_every)}) "
            f"due {us_date(due)}, from {ticket_no(parent.code) if parent else 'the original ticket'}.</em></p>")
    service_area = T.service_area_for(db, tpl.get("application") or "")
    sla = T._sla_due_from_priority(db, now, priority)

    T._lock_ticket_codes(db)
    code = f"{T._highest_ticket_no(db) + 1:0{TICKET_CODE_DIGITS}d}"
    t = models.TaskTicket(
        id=gen_id(), code=code, subject=tpl.get("subject") or "Scheduled service",
        description=note + (tpl.get("description") or ""), type=tpl.get("type") or "incident",
        status="open", priority=priority, requester_email=requester, created_by_email=(actor or requester).lower(),
        assignee_email="", department_id="", company_id=tpl.get("company_id") or "",
        hr_department_id=tpl.get("hr_department_id") or "", linked_task_id="", tags=[], images=[],
        watcher_emails=[requester] if requester else [], resolution="", custom_field_values={},
        type_fields={"svc_unit": tpl["location"]} if tpl.get("location") else {}, links=[], task_ids=[],
        component="", csat_rating=0, csat_comment="", application=tpl.get("application") or "",
        service_area=service_area, sla_due_on=sla, resolved_at="", created_at=now, modified_at=now,
        property_asset_id=svc.property_asset_id, property_name=prop_name, property_locked=1,
        parent_ticket_id=svc.parent_ticket_id, service_id=svc.id, approver_email="", approval_status="none")
    db.add(t)
    log_activity(db, type="created", actor_email=(actor or "system"), entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject,
                 detail=("opened automatically for the scheduled service due " if automatic
                         else "opened for the scheduled service due ") + us_date(due))

    svc.last_opened_for, svc.last_ticket_id = due, t.id
    if svc.recurrence_unit:
        nxt = advance(parse_ymd(due) or date.today(), svc.recurrence_unit, svc.recurrence_every)
        while nxt <= date.today():                  # a long-missed service catches up to the future
            nxt = advance(nxt, svc.recurrence_unit, svc.recurrence_every)
        svc.next_due, svc.reminder_sent_for = nxt.isoformat(), ""
    else:
        svc.active = 0                              # one-time: done once its ticket exists
    svc.updated_at = now

    T._notify_triage(db, t, (actor or "").lower())
    if manager and manager != (actor or "").lower():
        task_notify(db, kind="ticket_property", for_email=manager,
                    title=(f"Scheduled service opened at {prop_name}" if automatic
                           else f"Service ticket opened at {prop_name}"),
                    body=f"{ticket_no(t.code)} {t.subject} - due {us_date(due)}"[:500],
                    nexus_action={"view": "property-asset", "sub": f"tickets:{svc.property_asset_id}:{t.id}",
                                  "label": "View Property"})
    return t


def run_due(db, today: date | None = None) -> dict:
    """Reminders 15 days out, and tickets for services that came due with
    none opened. Caller commits."""
    today = today or date.today()
    reminded = opened = 0
    ids = [s.id for s in db.query(models.PropertyMaintenanceService)
           .filter(models.PropertyMaintenanceService.active == 1).all()]
    for sid in ids:
        svc = (db.query(models.PropertyMaintenanceService)
               .filter(models.PropertyMaintenanceService.id == sid).with_for_update().first())
        if svc is None or not svc.active:
            continue
        due = parse_ymd(svc.next_due)
        if due is None:
            continue
        if today >= due:
            if svc.last_opened_for != svc.next_due:
                open_child(db, svc, "", automatic=True)
                opened += 1
        elif today >= due - timedelta(days=REMINDER_DAYS) and svc.reminder_sent_for != svc.next_due:
            prop = db.get(models.PropertyAsset, svc.property_asset_id)
            mgr = property_links.manager_email(db, prop) if prop is not None else ""
            name = property_links.display_name(prop) if prop is not None else "the property"
            if mgr:
                task_notify(db, kind="ticket_property", for_email=mgr,
                            title=f"Service due {us_date(due)} at {name}",
                            body=(f"{(svc.template or {}).get('subject') or 'Scheduled service'} - a ticket opens "
                                  "automatically on the due date, or open it now from Maintenance > Recurring Services.")[:500],
                            nexus_action={"view": "property-asset", "sub": f"services:{svc.property_asset_id}",
                                          "label": "View Property"})
            svc.reminder_sent_for = svc.next_due
            reminded += 1
        db.flush()
    return {"reminded": reminded, "opened": opened}


def run_daily() -> dict:
    """Own session and commit. Sync - reminders_loop runs it in a thread."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        out = run_due(db)
        db.commit()
        print(f"[maintenance-services] daily scan - {out['reminded']} reminder(s), {out['opened']} ticket(s) opened")
        return out
    except Exception as e:           # noqa: BLE001 - a bad row never kills the loop
        db.rollback()
        print(f"[maintenance-services] scan failed: {type(e).__name__}: {e}")
        return {"reminded": 0, "opened": 0}
    finally:
        db.close()
