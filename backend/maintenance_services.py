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

PREVENTIVE SCHEDULES (Construction plan phase 5, Neil 11/03/2026) are the
same rows, set straight on the property in Asset Management > Maintenance
(no parent ticket - parent_ticket_id NULL) and driven by the same daily scan:

  * kind 'calendar' - fixed dates: next_due, rolled on by recurrence_* (every
    month on the 1st = a next_due on the 1st, weekly on Monday = a Monday,
    quarterly = every 3 months);
  * kind 'floating' - recurrence_* after the last completion: once a ticket
    is filed next_due goes blank, and closing that ticket (any path - the
    before_flush hook at the end) sets it from the day it closed;
  * kind 'meter' - by the asset's reading (a vehicle's odometer, an
    equipment's hour meter, from its Asset Management record): a ticket
    once the reading passes meter_next, which then moves on by meter_every.

Each due occurrence files ONE ticket through tickets.file_ticket (every
intake rule, property link rule, default assignee, SLA and bell applies) as
the person who last saved the schedule, lead_days before it is due, with the
property set and locked, the schedule's team, topic, assignee, equipment and
checklist (type_fields.checklist, the tickets' own checklist), and the due
day on the ticket (pm_due_on). PropertyMaintenanceOccurrence's unique
(service_id, due_key) means an occurrence is filed once, whoever races.
Closing a preventive ticket after real work writes its maintenance record
(ticket_maintenance_records, the row Add to Maintenance Record writes).
Workflows hear preventive.generated and preventive.overdue.
"""
import calendar
from datetime import date, timedelta

import models
import property_links
from routers.task_util import gen_id, log_activity, now_iso, task_notify
import job_switch

REMINDER_DAYS = 15
UNITS = ("", "day", "week", "month", "year")
_UNIT_LABEL = {"day": "Day", "week": "Week", "month": "Month", "year": "Year"}


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
    if unit == "day":
        return d + timedelta(days=every)
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
    import code_sequence
    from routers import tickets as T
    from ticket_code import ticket_no

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
    import ticket_sla
    sla = ticket_sla.targets(db, priority)   # Honest SLA: ticket_sla.start below

    code = code_sequence.next_ticket_code(db)   # the never-repeating counter
    t = models.TaskTicket(
        id=gen_id(), code=code, subject=tpl.get("subject") or "Scheduled service",
        description=note + (tpl.get("description") or ""), type=tpl.get("type") or "incident",
        status="open", priority=priority, requester_email=requester, created_by_email=(actor or requester).lower(),
        assignee_email="", department_id="", company_id=tpl.get("company_id") or "",
        hr_department_id=tpl.get("hr_department_id") or "", linked_task_id="", tags=[], images=[],
        watcher_emails=[requester] if requester else [], resolution="", custom_field_values={},
        type_fields={"svc_unit": tpl["location"]} if tpl.get("location") else {}, links=[], task_ids=[],
        component="", csat_rating=0, csat_comment="", application=tpl.get("application") or "",
        service_area=service_area, sla_due_on="", resolved_at="", created_at=now, modified_at=now,
        property_asset_id=svc.property_asset_id, property_name=prop_name, property_locked=1,
        parent_ticket_id=svc.parent_ticket_id, service_id=svc.id, approver_email="", approval_status="none")
    ticket_sla.start(t, sla)
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
                    title=(f"Scheduled Service Opened at {prop_name}" if automatic
                           else f"Service Ticket Opened at {prop_name}"),
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
           .filter(models.PropertyMaintenanceService.active == 1).all() if not is_preventive(s)]
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
                            title=f"Service Due {us_date(due)} at {name}",
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
    if job_switch.off("maintenance_services"):   # Workflows > Automations switch
        return {"reminded": 0, "opened": 0}
    from database import SessionLocal
    db = SessionLocal()
    try:
        out = run_due(db)
        db.commit()
        pm = run_preventive(db)
        db.commit()
        out.update(pm)
        print(f"[maintenance-services] daily scan - {out['reminded']} reminder(s), {out['opened']} ticket(s) opened, "
              f"{pm['filed']} preventive ticket(s) filed, {pm['overdue']} newly overdue, {pm['collided']} moved past "
              f"an occurrence already filed, {pm['attention']} needing a person, {pm['failed']} failed")
        return out
    except Exception as e:           # noqa: BLE001 - a bad row never kills the loop
        db.rollback()
        print(f"[maintenance-services] scan failed: {type(e).__name__}: {e}")
        return {"reminded": 0, "opened": 0}
    finally:
        db.close()


# ── Preventive schedules (Construction plan phase 5, 11/03/2026) ────────────

KINDS = ("calendar", "floating", "meter")
KIND_LABEL = {"": "From a Ticket", "calendar": "Fixed Dates", "floating": "After Each Completion",
              "meter": "By Meter"}
METERS = {"odometer": ("vehicle", "mi", "Odometer"), "hours": ("equipment", "h", "Hour Meter")}
PM_SOURCE = "preventive"            # TaskTicket.source of a ticket a schedule filed
CHECKLIST_MAX, CHECKLIST_LEN = 30, 160


def is_preventive(svc) -> bool:
    return svc is not None and (svc.kind or "") in KINDS


def is_preventive_ticket(t) -> bool:
    """A ticket a preventive schedule filed: its schedule AND its due day
    (file_preventive sets both). A child of a service set from a ticket has
    only service_id and keeps the old behavior - no Preventive queue, no
    overdue, no photo rule."""
    return t is not None and bool(getattr(t, "service_id", "") or "") and bool(getattr(t, "pm_due_on", "") or "")


# ── One "today" (review, 11/03/2026) ─────────────────────────────────────────
# Every preventive date question - is the first due date in the past, is an
# occurrence due, is a ticket overdue, what day did it close - is asked on the
# calendar of the schedule's company: its team time zone (Shifts settings,
# shift_expect.team_tz - that company's override, else the tenant's), else
# America/Los_Angeles.

def company_zone(db, company_id: str = ""):
    import shift_expect
    return shift_expect.zone(shift_expect.team_tz(db, company_id or ""))


def local_today(db, company_id: str = "") -> date:
    from datetime import datetime
    return datetime.now(company_zone(db, company_id)).date()


class TodayCache:
    """local_today per company, read once per request / scan."""

    def __init__(self, db, fixed: date | None = None):
        self.db, self.fixed, self._seen = db, fixed, {}

    def __call__(self, company_id: str = "") -> date:
        if self.fixed is not None:
            return self.fixed
        key = company_id or ""
        if key not in self._seen:
            self._seen[key] = local_today(self.db, key)
        return self._seen[key]


def svc_company(svc) -> str:
    return str((svc.template or {}).get("company_id") or "")


def business_date(iso: str, zone=None):
    """The calendar day a UTC timestamp falls on in `zone` (the schedule's
    company zone; Pacific when none is given)."""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(zone or ZoneInfo("America/Los_Angeles")).date()


def pm_overdue(t, today_of) -> bool:
    """A live preventive ticket whose due day has passed on its company's
    calendar - the ONE overdue answer the desk, the roll-up, the place sheet
    and My Work read (`today_of` = a TodayCache)."""
    return (is_preventive_ticket(t) and (t.status or "") not in property_links.CLOSED_STATES
            and t.pm_due_on < today_of(t.company_id or "").isoformat())


def _num(v):
    try:
        f = float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return f if f >= 0 else None


def reading_records(db, asset_ids) -> dict:
    """{asset id: [record payload]} - the odometer and service logs of these
    assets in ONE query (schedule_options reads every vehicle at once)."""
    ids = [i for i in set(asset_ids or []) if i]
    out: dict = {}
    if not ids:
        return out
    for r in (db.query(models.PropertyRecord)
              .filter(models.PropertyRecord.property_id.in_(ids),
                      models.PropertyRecord.collection.in_(("odometer", "vservice"))).all()):
        out.setdefault(r.property_id, []).append(r.payload or {})
    return out


def asset_reading(db, asset, field: str, records=None):
    """The asset's NEWEST reading (review, 11/03/2026 - not the largest, so a
    replaced or reset meter reads as what it says now), or None. The
    record's own field is dated by the asset's last save; each odometer /
    service log row by its own date. Ties go to the later-listed log row.
    Read only - Asset Management keeps the numbers."""
    if asset is None or field not in METERS:
        return None
    seen = []   # (date, order, value)
    own = _num((asset.payload or {}).get(field))
    if own is not None:
        seen.append((str(asset.updated_at or "")[:10], 0, own))
    if field == "odometer":
        rows = records if records is not None else reading_records(db, [asset.id]).get(asset.id, [])
        for i, p in enumerate(rows):
            v = _num(p.get("mileage"))
            if v is not None:
                seen.append((str(p.get("date") or "")[:10], i + 1, v))
    if not seen:
        return None
    return max(seen, key=lambda x: (x[0], x[1]))[2]


def _equipment_or_400(db, user, asset_id: str):
    from fastapi import HTTPException
    aid = (asset_id or "").strip()
    a = db.get(models.PropertyAsset, aid) if aid else None
    if (a is None or not property_links.viewable(a, user) or (a.payload or {}).get("deleted")
            or property_links.asset_kind(a) not in ("vehicle", "equipment")
            or not property_links.in_scope(a, property_links.asset_scope(db, user))):
        raise HTTPException(400, "That equipment is not available in Asset Management - pick another one.")
    return a


def check_equipment(db, user: dict, asset_id, prop) -> str:
    """file_ticket's equipment check: '' or a live vehicle / equipment asset
    the caller can see, and only beside a property (a ticket sits on its
    property; the equipment says what at it)."""
    from fastapi import HTTPException
    if not (asset_id or "").strip():
        return ""
    if prop is None:
        raise HTTPException(400, "Pick the property the equipment is at.")
    return _equipment_or_400(db, user, asset_id).id


def meter_label(field: str, value) -> str:
    unit = METERS.get(field, ("", "", ""))[1]
    v = _num(value)
    if v is None:
        return ""
    return f"{v:,.0f} {unit}".strip()


def schedule_label(svc) -> str:
    kind = svc.kind or ""
    if kind == "meter":
        return f"Every {meter_label(svc.meter_field, svc.meter_every)}"
    label = recurrence_label(svc.recurrence_unit or "", svc.recurrence_every or 1)
    return f"{label} After Completion" if kind == "floating" and svc.recurrence_unit else label


def attention_label(svc) -> str:
    a = svc.attention or ""
    if a == "owner":
        return "Needs an Owner"
    if a.startswith("reading:"):
        return f"Reading Needs Confirmation ({meter_label(svc.meter_field, a.split(':', 1)[1])})"
    if a.startswith("reset:"):
        return f"Meter Reset - Rebased at {meter_label(svc.meter_field, a.split(':', 1)[1])}"
    return ""


def _checklist(raw) -> list:
    from fastapi import HTTPException
    out = []
    for x in raw or []:
        line = " ".join(str(x or "").split())
        if not line:
            continue
        if len(line) > CHECKLIST_LEN:
            raise HTTPException(400, f"Keep each checklist step under {CHECKLIST_LEN} characters.")
        if line not in out:
            out.append(line)
    if len(out) > CHECKLIST_MAX:
        raise HTTPException(400, f"A checklist holds at most {CHECKLIST_MAX} steps.")
    return out


def occurrence_exists(db, svc_id: str, due_key: str) -> bool:
    O = models.PropertyMaintenanceOccurrence
    return bool(svc_id) and db.query(O.id).filter(O.service_id == svc_id, O.due_key == due_key).first() is not None


def meter_key(value) -> str:
    return f"m:{float(value or 0):g}"


def clean_schedule(db, user: dict, prop, data: dict, svc=None) -> dict:
    """The schedule fields as they will be stored, from a create (svc None)
    or a patch (only the keys sent). Raises HTTPException. The same intake
    rules a ticket follows, checked now, so a schedule is never saved that
    would be refused the day it comes due."""
    from fastapi import HTTPException
    from routers import tickets as T
    import auth
    import ticket_property_link
    import ticket_roles
    import ticket_taxonomy
    cur = svc
    tpl = dict((cur.template if cur is not None else None) or {})

    def get(k, d=None):
        return data[k] if k in data else d

    kind = (get("kind", cur.kind if cur is not None else "calendar") or "").strip().lower()
    if kind not in KINDS:
        raise HTTPException(400, "Pick how the schedule repeats: fixed dates, after each completion, or by meter.")
    out: dict = {"kind": kind}
    subject = " ".join(str(get("subject", tpl.get("subject") or "") or "").split())[:200]
    if not subject:
        raise HTTPException(400, "Give the schedule a name - it becomes each ticket's subject.")
    pr = (get("priority", tpl.get("priority") or "medium") or "medium").strip().lower()
    if pr not in ticket_taxonomy.PRIORITIES:
        raise HTTPException(400, "Unknown priority - use Urgent, High, Medium or Low.")
    dept_id = (get("hr_department_id", tpl.get("hr_department_id") or "") or "").strip()
    dept = db.get(models.HrDepartment, dept_id) if dept_id else None
    if dept is None:
        raise HTTPException(400, "Pick the team that does the work.")
    auth.assert_company(dept.company_id or "", user, db)
    # The team must be the property's own company's (review H1): a ticket is
    # stamped with the team's company, so another company's team would put
    # this property's work behind that company's wall.
    owner = property_links.property_company(db, prop)
    if owner and (dept.company_id or "") and dept.company_id != owner:
        raise HTTPException(400, "Pick a team from the company this property belongs to.")
    application = (get("application", tpl.get("application") or "") or "").strip()
    area = T.service_area_for(db, application)
    ticket_property_link.require_takes_property(db, dept.id, area)
    location = get("location", tpl.get("location") or "") or ""
    tpl.update({"subject": subject,
                "description": str(get("description", tpl.get("description") or "") or "")[:5000],
                "type": tpl.get("type") or "other", "priority": pr, "application": application,
                "hr_department_id": dept.id, "company_id": dept.company_id or "",
                "location": ticket_property_link.clean_unit(db, prop, location) if prop is not None else ""})
    out["template"] = tpl
    before = (cur.assignee_email if cur is not None else "") or ""
    assignee = (get("assignee_email", before) or "").strip().lower()
    if assignee and assignee != before:
        if not ticket_roles.can_assign(user, db):
            raise HTTPException(403, "Only the service desk can name who each ticket goes to - leave it to the team.")
        if not T.active_person(db, assignee):
            raise HTTPException(400, "The assignee must be someone on the Nexus People list.")
    out["assignee_email"] = assignee
    asset_id = (get("asset_id", cur.asset_id if cur is not None else "") or "").strip()
    if asset_id:
        _equipment_or_400(db, user, asset_id)
    out["asset_id"] = asset_id
    item_id = (get("item_id", cur.item_id if cur is not None else "") or "").strip()
    if item_id:
        item = db.get(models.Item, item_id)
        if (item is None or getattr(item, "deleted_at", "")
                or not auth.company_ok(item.company_id or "", auth.company_scope(user, db))):
            raise HTTPException(400, "That item is not available - pick another one.")
    out["item_id"] = item_id
    out["checklist"] = _checklist(get("checklist", cur.checklist if cur is not None else []))
    try:
        lead = int(get("lead_days", cur.lead_days if cur is not None else 0) or 0)
    except (TypeError, ValueError):
        lead = -1
    if not 0 <= lead <= 60:
        raise HTTPException(400, "Open the ticket 0 to 60 days before it is due.")
    out["lead_days"] = lead
    today = local_today(db, dept.company_id or "")
    sid = cur.id if cur is not None else ""
    if kind in ("calendar", "floating"):
        unit = (get("recurrence_unit", (cur.recurrence_unit if cur is not None else "") or "month") or "")
        unit = unit.strip().lower()
        if unit not in UNITS or not unit:
            raise HTTPException(400, "Repeat every so many days, weeks, months or years.")
        try:
            every = int(get("recurrence_every", cur.recurrence_every if cur is not None else 1) or 1)
        except (TypeError, ValueError):
            every = 0
        if not 1 <= every <= 365:
            raise HTTPException(400, "Repeat every 1 to 365.")
        out.update(recurrence_unit=unit, recurrence_every=every, meter_field="", meter_every=0, meter_next=0)
        if "next_due" in data or cur is None or (cur.kind or "") != kind:
            nd = parse_ymd(get("next_due", ""))
            if nd is None:
                raise HTTPException(400, "Pick the first due date.")
            if nd < today:
                raise HTTPException(400, "The first due date cannot be in the past.")
            if occurrence_exists(db, sid, nd.isoformat()):
                raise HTTPException(400, f"A ticket was already filed for {us_date(nd)} - pick a later date.")
            out["next_due"] = nd.isoformat()
    else:
        if not asset_id:
            raise HTTPException(400, "A meter schedule needs the vehicle or equipment whose reading it follows.")
        asset = db.get(models.PropertyAsset, asset_id)
        field = "odometer" if property_links.asset_kind(asset) == "vehicle" else "hours"
        every = _num(get("meter_every", cur.meter_every if cur is not None else 0))
        if not every or every > 1_000_000:
            raise HTTPException(400, "Say how often by the meter - every so many miles or hours.")
        reading = asset_reading(db, asset, field)
        nxt = _num(get("meter_next", None)) if data.get("meter_next") not in (None, "") else None
        if nxt is None:
            same = cur is not None and (cur.kind or "") == "meter" and cur.meter_field == field
            nxt = (cur.meter_next if same else 0) or ((reading or 0) + every)
        if occurrence_exists(db, sid, meter_key(nxt)):
            raise HTTPException(400, f"A ticket was already filed at {meter_label(field, nxt)} - set the next mark higher.")
        out.update(meter_field=field, meter_every=every, meter_next=nxt, meter_last=reading or 0,
                   recurrence_unit="", recurrence_every=1, next_due="")
    return out


def run_as(db, svc):
    """The identity a schedule files as: whoever last saved it, else whoever
    made it - a current directory person with their real role, so every
    permission check and the company wall apply to them (as Workflows and
    Cubby Tasks do). None = nobody to act as; the scan marks the schedule
    Needs an Owner and tells the asset manager."""
    import task_automation
    for email in (svc.updated_by_email, svc.created_by_email):
        u = task_automation._person_user(db, email) if email else None
        if u and not u.get("external"):
            return u
    return None


def open_ticket_of(db, svc):
    return (db.query(models.TaskTicket)
            .filter(models.TaskTicket.service_id == svc.id,
                    ~models.TaskTicket.status.in_(property_links.CLOSED_STATES)).first())


def attention_bell(db, svc, title: str, body: str) -> None:
    """ONE bell per schedule and person, updated in place (CLAUDE.md: one
    notification per workflow): the property's asset manager, else the
    schedule's keeper. Opens the property's Preventive Maintenance."""
    import json
    prop = db.get(models.PropertyAsset, svc.property_asset_id)
    who = (property_links.manager_email(db, prop) if prop is not None else "") or (svc.updated_by_email or "")
    who = (who or "").strip().lower()
    if not who:
        return
    action = json.dumps({"view": "property-asset", "sub": f"services:{svc.property_asset_id}",
                         "label": "View Schedule"})
    N = models.NexusNotification
    row = (db.query(N).filter(N.type == "task_pm_attention", N.ref_id == svc.id, N.recipient == who)
           .with_for_update().first())
    now = now_iso()
    if row is None:
        db.add(N(id=gen_id(), type="task_pm_attention", recipient=who, title=title[:200], body=body[:500],
                 ref_id=svc.id, item_name="", requested_by="", action=action, actioned=False, read_by="",
                 created_at=now))
    else:
        row.title, row.body, row.action, row.read_by, row.created_at = title[:200], body[:500], action, "", now


def file_preventive(db, svc, due_on: str, due_key: str, user: dict, background_tasks, *,
                    automatic: bool = True):
    """File the ticket for one occurrence and move the schedule on, in ONE
    transaction (file_ticket commits it). None when this occurrence already
    has its ticket (the unique key) - never a second one; the caller rolls
    the schedule on (roll_forward). Raises HTTPException when the ticket
    itself is refused; the caller rolls back."""
    from sqlalchemy.exc import IntegrityError
    from routers import tickets as T
    from routers import ticket_items
    import ticket_roles
    import ticket_taxonomy
    import workflows

    now = now_iso()
    occ = models.PropertyMaintenanceOccurrence(id=gen_id(), service_id=svc.id, due_key=due_key,
                                               due_on=due_on, created_at=now)
    db.add(occ)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return None
    tpl = dict(svc.template or {})
    typ = tpl.get("type") or "other"
    assignee = (svc.assignee_email or "").lower()
    if assignee and (not ticket_roles.can_assign(user, db) or ticket_taxonomy.requires_approval(db, typ)
                     or not T.active_person(db, assignee)):
        assignee = ""          # the team's default assignee takes it (ticket_auto_assign)
    items = []
    if svc.item_id:
        try:
            ticket_items.check_items(db, user, [svc.item_id], ticket_company=tpl.get("company_id") or "",
                                     requester_email=user["email"])
            items = [svc.item_id]
        except Exception:      # noqa: BLE001 - the run-as person may not link it: file without it
            items = []
    prop = db.get(models.PropertyAsset, svc.property_asset_id)
    asset = db.get(models.PropertyAsset, svc.asset_id) if svc.asset_id else None
    what = f" on {property_links.display_name(asset)}" if asset is not None else ""
    note = f"<p><em>Preventive maintenance{what} ({schedule_label(svc)}), due {us_date(due_on)}.</em></p>"
    body = T.TicketBody(
        subject=tpl.get("subject") or "Preventive maintenance", description=note + (tpl.get("description") or ""),
        type=typ, priority=tpl.get("priority") or "medium", requester_email="", assignee_email=assignee,
        company_id=tpl.get("company_id") or "", hr_department_id=tpl.get("hr_department_id") or "",
        application=tpl.get("application") or "", property_asset_id=svc.property_asset_id, property_locked=True,
        property_unit=tpl.get("location") or "Common Area",
        type_fields={"checklist": [{"label": c, "done": False} for c in (svc.checklist or [])]},
        item_ids=items or None, equipment_asset_id=svc.asset_id if asset is not None else "")
    # The schedule moves on in the same transaction as the ticket.
    svc.last_opened_for = due_key
    roll_forward(svc, local_today(db, svc_company(svc)), from_due=due_on)
    svc.updated_at = now

    def stamp(t):
        t.service_id, t.pm_due_on = svc.id, due_on
        occ.ticket_id = t.id
        svc.last_ticket_id = t.id
        workflows.emit(db, "preventive.generated", subject=t, actor=user["email"],
                       extra={"scheduleId": svc.id, "schedule": tpl.get("subject") or "", "dueOn": due_on,
                              "property": property_links.display_name(prop) if prop is not None else "",
                              "propertyId": svc.property_asset_id, "kind": svc.kind, "automatic": automatic})

    # The ticket's company is the TEAM's (server-trusted, review H1) - never
    # the run-as person's own company, whatever their desk grant.
    return T.file_ticket(body, background_tasks, user, db, arrived_by=PM_SOURCE, server_fields=stamp,
                         trusted_company=tpl.get("company_id") or "")


def roll_forward(svc, today: date, from_due: str = "") -> None:
    """Move the schedule past one occurrence: a calendar schedule to its next
    date after today, a floating one to waiting (set again on close), a
    meter one to its next mark past the last reading."""
    if svc.kind == "calendar":
        nxt = advance(parse_ymd(from_due or svc.next_due) or today, svc.recurrence_unit, svc.recurrence_every)
        while nxt <= today:
            nxt = advance(nxt, svc.recurrence_unit, svc.recurrence_every)
        svc.next_due = nxt.isoformat()
    elif svc.kind == "floating":
        svc.next_due = ""
    elif svc.kind == "meter":
        nxt = float(svc.meter_next or 0) + float(svc.meter_every or 0)
        while svc.meter_every and nxt <= float(svc.meter_last or 0):
            nxt += float(svc.meter_every)
        svc.meter_next = nxt


JUMP_FACTOR = 3   # a reading more than 3 intervals past the last one is confirmed by a person first


def due_occurrence(db, svc, today: date):
    """(due_on, due_key) when this preventive schedule has an occurrence to
    file today, else None. A meter schedule records the reading it saw: a
    reading that went DOWN (a replaced or reset meter) rebases the schedule on
    it and tells the keeper; one that jumped more than JUMP_FACTOR intervals
    is held for a person to confirm (attention "reading:<value>")."""
    kind = svc.kind or ""
    if kind in ("calendar", "floating"):
        d = parse_ymd(svc.next_due)
        if d is None or today < d - timedelta(days=int(svc.lead_days or 0)):
            return None
        return d.isoformat(), d.isoformat()
    if kind != "meter":
        return None
    asset = db.get(models.PropertyAsset, svc.asset_id) if svc.asset_id else None
    reading = asset_reading(db, asset, svc.meter_field)
    if reading is None:
        return None
    last = float(svc.meter_last or 0)
    every = float(svc.meter_every or 0)
    name = property_links.display_name(asset) if asset is not None else "the equipment"
    subject = (svc.template or {}).get("subject") or "Preventive maintenance"
    if last and reading < last:
        svc.meter_last, svc.meter_next = reading, reading + every
        svc.attention = f"reset:{reading:g}"
        attention_bell(db, svc, f"Meter Reset on {name}",
                       f"{subject}: the reading went from {meter_label(svc.meter_field, last)} to "
                       f"{meter_label(svc.meter_field, reading)}. The schedule now counts from there - next at "
                       f"{meter_label(svc.meter_field, svc.meter_next)}.")
        return None
    if last and every and reading - last > JUMP_FACTOR * every:
        if svc.attention != f"reading:{reading:g}":     # a new jump (or a different value): ask once
            svc.attention = f"reading:{reading:g}"
            attention_bell(db, svc, f"Check the Reading on {name}",
                           f"{subject}: {meter_label(svc.meter_field, reading)} is far past the last reading "
                           f"({meter_label(svc.meter_field, last)}). Confirm it on the schedule before a ticket is filed.")
        return None          # held until a person confirms it (confirm_reading)
    if (svc.attention or "").startswith("reading:"):
        svc.attention = ""   # the reading came back in line (a typo fixed on the record)
    svc.meter_last = reading
    if not svc.meter_next or reading < float(svc.meter_next) or open_ticket_of(db, svc) is not None:
        return None
    return today.isoformat(), meter_key(svc.meter_next)


def confirm_reading(svc) -> bool:
    """The keeper says the held reading is right: the scan files on it."""
    a = svc.attention or ""
    if not a.startswith("reading:"):
        return False
    svc.meter_last = _num(a.split(":", 1)[1]) or svc.meter_last
    svc.attention = ""
    return True


def run_after(bt) -> None:
    """A route's after-the-response work (emails, Teams), run in order - the
    scan already is a worker thread."""
    for task in list(bt.tasks):
        try:
            task.func(*task.args, **task.kwargs)
        except Exception as e:      # noqa: BLE001
            print(f"[maintenance-services] follow-up failed: {e}")


def _scan_overdue(db, svc, today: date) -> int:
    """preventive.overdue once per ticket: every open ticket of this schedule
    whose due day has passed, later than the last one announced."""
    import workflows
    after = svc.overdue_alerted_for or ""
    T_ = models.TaskTicket
    rows = (db.query(T_)
            .filter(T_.service_id == svc.id, T_.pm_due_on != "", T_.pm_due_on < today.isoformat(),
                    T_.pm_due_on > after, ~T_.status.in_(property_links.CLOSED_STATES))
            .order_by(T_.pm_due_on).all())
    for t in rows:
        workflows.emit(db, "preventive.overdue", subject=t,
                       extra={"scheduleId": svc.id, "schedule": (svc.template or {}).get("subject") or "",
                              "dueOn": t.pm_due_on, "daysOverdue": (today - parse_ymd(t.pm_due_on)).days,
                              "propertyId": svc.property_asset_id, "property": t.property_name or ""})
        svc.overdue_alerted_for = t.pm_due_on
    return len(rows)


def run_preventive(db, today: date | None = None) -> dict:
    """The preventive half of the daily scan: each schedule's due occurrence
    filed (one ticket each, committed one by one), and overdue tickets told
    to Workflows - committed BEFORE the filing, so a refused ticket never
    swallows the overdue event. One schedule's failure is logged and the
    scan goes on. `today` fixes the day (tests); otherwise each schedule's
    own company calendar."""
    from fastapi import BackgroundTasks, HTTPException
    days = TodayCache(db, today)
    out = {"filed": 0, "skipped": 0, "overdue": 0, "collided": 0, "attention": 0, "failed": 0}
    M = models.PropertyMaintenanceService
    ids = [s.id for s in db.query(M).filter(M.active == 1, M.kind.in_(KINDS)).all()]
    for sid in ids:
        try:
            svc = db.query(M).filter(M.id == sid).with_for_update().first()
            if svc is None or not svc.active or not is_preventive(svc):
                db.rollback()
                continue
            day = days(svc_company(svc))
            out["overdue"] += _scan_overdue(db, svc, day)
            before = svc.attention or ""
            occ = due_occurrence(db, svc, day)
            if (svc.attention or "") != before and svc.attention:
                out["attention"] += 1
            if occ is None:
                db.commit()
                continue
            user = run_as(db, svc)
            if user is None:
                if svc.attention != "owner":
                    svc.attention = "owner"
                    attention_bell(db, svc, "Preventive Schedule Needs an Owner",
                                   f"{(svc.template or {}).get('subject') or 'A schedule'}: nobody who saved it is still "
                                   "in Nexus, so its tickets cannot be filed. Open it and save it to take it over.")
                    out["attention"] += 1
                out["skipped"] += 1
                db.commit()
                continue
            db.commit()                 # the overdue events and the reading stand on their own
            svc = db.query(M).filter(M.id == sid).with_for_update().first()
            bt = BackgroundTasks()
            if file_preventive(db, svc, occ[0], occ[1], user, bt) is None:
                # The occurrence already has its ticket (a racer, an Open Now, a
                # date put back): never a second ticket - move past it instead.
                svc = db.query(M).filter(M.id == sid).with_for_update().first()
                svc.last_opened_for = occ[1]
                roll_forward(svc, day, from_due=occ[0])
                svc.updated_at = now_iso()
                db.commit()
                out["collided"] += 1
                print(f"[maintenance-services] schedule {sid}: {occ[1]} was already filed - moved on to the next one")
                continue
            out["filed"] += 1
            run_after(bt)
        except HTTPException as e:
            db.rollback()
            out["skipped"] += 1
            print(f"[maintenance-services] schedule {sid}: the ticket was refused - {e.detail}")
        except Exception as e:      # noqa: BLE001 - one bad schedule never stops the scan
            db.rollback()
            out["failed"] += 1
            print(f"[maintenance-services] schedule {sid} failed: {type(e).__name__}: {e}")
    return out


# ── The photo rule, on every resolve path (review L7) ───────────────────────

def require_finish_photo(db, t, data: dict) -> None:
    """update_ticket: a preventive ticket moving into Resolved / Closed after
    real work needs a photo of the finished work on it (an image attachment
    or image on the ticket) - whichever screen resolves it. Closing it as a
    duplicate / won't fix needs none."""
    from fastapi import HTTPException
    if not is_preventive_ticket(t) or data.get("status") not in property_links.CLOSED_STATES:
        return
    if (t.status or "") in property_links.CLOSED_STATES:
        return
    if (data.get("resolution") or t.resolution or "") in property_links.NO_WORK_RESOLUTIONS:
        return
    A = models.TaskAttachment
    pending = any(isinstance(o, A) and o.task_id == t.id and (o.kind or "") == "image" for o in db.new)
    if pending or t.images or db.query(A.id).filter(A.task_id == t.id, A.kind == "image").first() is not None:
        return
    raise HTTPException(400, "Add a photo of the finished work - a preventive ticket needs one before it is resolved.")


# ── A preventive ticket closes or is deleted (any path) ──────────────────────

def on_ticket_closed(session, t) -> None:
    """Called by the before_flush hook when a ticket with a schedule moves
    into Resolved / Closed: its maintenance record (after real work - the
    rule property_links.is_maintenance_record keeps) and, for a floating
    schedule, the next due date from the day it closed on its company's
    calendar."""
    svc = session.get(models.PropertyMaintenanceService, t.service_id) if t.service_id else None
    if not is_preventive(svc):
        return
    closed_on = business_date(t.resolved_at, company_zone(session, svc_company(svc))) or date.today()
    if property_links.is_maintenance_record(t):
        R = models.TicketMaintenanceRecord
        pending = any(isinstance(o, R) and o.ticket_id == t.id for o in session.new)
        if not pending and session.query(R.id).filter(R.ticket_id == t.id).first() is None:
            now = now_iso()
            session.add(R(id=gen_id(), ticket_id=t.id, property_asset_id=t.property_asset_id or "",
                          parent_ticket_id="", service_date=closed_on.isoformat(),
                          system=property_links.system_for(t.application),
                          description=(t.resolution_note or "")[:2000], vendor=t.maintenance_vendor or "",
                          cost=t.maintenance_cost or "", currency="USD", notes="", created_by_email="",
                          created_at=now, updated_at=now))
    if (svc.kind == "floating" and svc.active and svc.last_ticket_id == t.id and not svc.next_due
            and svc.recurrence_unit):
        svc.next_due = advance(closed_on, svc.recurrence_unit, svc.recurrence_every).isoformat()
        svc.updated_at = now_iso()


def on_ticket_deleted(session, t) -> None:
    """A floating schedule's open ticket was deleted (review L2): the schedule
    would wait forever for a close that never comes, so it is due again
    today on its company's calendar (the scan files a new one; if today's
    occurrence was the deleted one, it moves on to the next)."""
    svc = session.get(models.PropertyMaintenanceService, t.service_id) if t.service_id else None
    if not is_preventive(svc) or svc.kind != "floating" or svc.last_ticket_id != t.id or svc.next_due:
        return
    svc.next_due = local_today(session, svc_company(svc)).isoformat()
    svc.updated_at = now_iso()
