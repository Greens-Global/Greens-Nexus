"""Equipment reminders (Sep 2026): overdue checkouts + asset date alerts.

Product ask: "items checked out and not returned are never chased, and
warranty alerts go to all managers. Add overdue reminders, and send warranty
alerts only to the asset manager."

Runs once a day from reminders.reminders_loop (in its own thread and its own
DB session, so a failure here never rolls back the HR scan and vice versa).
POST /property-assets/reminders/scan calls run_asset_alerts too, so the old
manual trigger uses exactly the same targeted logic.

Timing and on/off come from equipment_reminder_config (Settings > Global
Settings > Notifications & Communications > Equipment Reminders).

Nothing here ever broadcasts: every notification names a recipient. One
notification per (thing, person), updated in place when it fires again
(re-surfaced as unread and moved to the top), never a new row per reminder -
the same shape items.py uses for its order notifications. Bell only: item
workflow notifications do not email today, so neither do these.

WHO GETS WHAT
  Overdue checkout (allocated transient item past its due date, due date =
  handover + checkout days + approved extensions, as items.py computes it):
    - the borrower (requested_by_email), on the due date (optional) and then
      every N days while overdue, up to a maximum;
    - from day `notifyOwnerAfterDays` on, the same reminders also go to the
      checkout's owner: the allocator who handed it over, else the approver
      who approved it, else the lead of the item's department
      (hr_departments.lead_email). Nobody found = borrower only.
  Asset alerts (warranty / inspection / registration + insurance / service):
    - Asset Management rows: the property's (or vehicle's / equipment's)
      "PM / Asset Manager" / "Assigned to / Operator" - the saved contact
      email for that field, else the field itself when it holds an email,
      else the one active Nexus person whose name matches it. A secondary
      parcel with nobody set inherits its primary asset's manager.
    - Item warranty (a date custom field whose key contains "warranty"): the
      person the item is permanently assigned to, else the lead of the
      item's department.
    - Nobody set: the IT Admins (role "administrator"). Logged, never a
      broadcast.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone, date

import equipment_reminder_config as erc

# The windows the old property_assets scan used ("within N days, once ever").
# A reminder row written by that scan carries no `lead` in its action; it is
# treated as having covered exactly this window, so deploying this change
# does not re-send everything the old scan already sent.
_LEGACY_LEAD = {
    "asset_warranty_expiry": 90,
    "asset_inspection_due": 30,
    "asset_reg_expiry": 60,
    "asset_ins_expiry": 60,
    "asset_service_due": 30,
}

_BORROWER_ACTION = {"label": "Open My Items", "view": "inventory", "sub": "active-checkouts"}
_OWNER_ACTION = {"label": "Open Checkouts", "view": "inventory", "sub": "checkouts"}
_ASSET_ACTION = {"label": "Open Asset Portfolio", "view": "property-asset", "sub": "asset-portfolio"}
_ITEM_ACTION = {"label": "Open Items", "view": "inventory", "sub": "catalog"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _us(d: date) -> str:
    return d.strftime("%m/%d/%Y")


def _parse_ymd(s):
    try:
        return date.fromisoformat(str(s or "").strip()[:10])
    except ValueError:
        return None


def _plural(n: int, word: str = "day") -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _action_of(n) -> dict:
    try:
        a = json.loads(n.action) if n.action else {}
        return a if isinstance(a, dict) else {}
    except (TypeError, ValueError):
        return {}


def _upsert(db, *, ntype, ref_id, recipient, title, body, item_name, action, requested_by="",
            existing=None) -> bool:
    """The one notification for (type, ref, recipient): update it in place
    (unread again, moved to the top) or create it. Returns True when written."""
    from auth import company_of
    from models import NexusNotification
    recipient = (recipient or "").strip().lower()
    if not recipient:
        return False                     # never a broadcast
    row = existing
    if row is None:
        row = (db.query(NexusNotification)
               .filter(NexusNotification.type == ntype, NexusNotification.ref_id == ref_id,
                       NexusNotification.recipient == recipient)
               .with_for_update().first())
    now = _now_iso()
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=ntype, recipient=recipient, title=title, body=body,
            ref_id=ref_id, item_name=item_name, requested_by=requested_by,
            action=json.dumps(action), actioned=False, read_by="",
            company=company_of(recipient, db), created_at=now))
    else:
        row.title, row.body, row.item_name = title, body, item_name
        row.action = json.dumps(action)
        row.actioned, row.read_by, row.created_at = False, "", now
    return True


# ── People lookups ──────────────────────────────────────────────────────────
def _it_admins(db) -> list:
    from models import NexusRole
    return sorted({(r.email or "").lower() for r in
                   db.query(NexusRole).filter(NexusRole.role == "administrator").all() if r.email})


def _dept_lead(db, department: str, company_id: str = "") -> str:
    """Lead of the department with this name. Departments are per company, so a
    name shared by two companies prefers the item's company."""
    from sqlalchemy import func
    from models import HrDepartment
    name = (department or "").strip().lower()
    if not name:
        return ""
    rows = [d for d in db.query(HrDepartment).filter(func.lower(HrDepartment.name) == name).all()
            if (d.lead_email or "").strip()]
    rows.sort(key=lambda d: d.company_id != (company_id or ""))
    return rows[0].lead_email.strip().lower() if rows else ""


class _People:
    """Active Nexus people by full name, built once per scan."""

    def __init__(self, db):
        from models import NexusEmployee
        self.by_name = {}
        for e in db.query(NexusEmployee).filter(NexusEmployee.status != "offboarded").all():
            email = (e.work_email or "").strip().lower()
            if not email:
                continue
            name = f"{e.first_name or ''} {e.last_name or ''}".strip().lower()
            self.by_name.setdefault(" ".join(name.split()), set()).add(email)

    def email_for(self, text: str) -> str:
        text = " ".join((text or "").strip().lower().split())
        if not text:
            return ""
        if "@" in text and " " not in text:
            return text
        hits = self.by_name.get(text) or set()
        return next(iter(hits)) if len(hits) == 1 else ""


# Contact-map keys (asset/lib/format.js normLabel) of the manager fields.
_MANAGER_CONTACT_KEYS = ("pm / asset manager", "assigned to / operator")


def asset_manager_email(prop, props: dict, people: _People, _depth: int = 0) -> str:
    """The person responsible for a property / vehicle / equipment asset."""
    if prop is None:
        return ""
    pl = prop.payload or {}
    contacts = pl.get("contacts") if isinstance(pl.get("contacts"), dict) else {}
    for key in _MANAGER_CONTACT_KEYS:
        c = contacts.get(key)
        email = (c.get("email") or "").strip().lower() if isinstance(c, dict) else ""
        if "@" in email:
            return email
    found = people.email_for(prop.manager or pl.get("manager") or "")
    if found:
        return found
    if prop.parent_id and _depth < 3:
        return asset_manager_email(props.get(prop.parent_id), props, people, _depth + 1)
    return ""


# ── Overdue checkouts ───────────────────────────────────────────────────────
def checkout_due_date(co):
    """Due date of an allocated checkout - same clock as items.list_items:
    handover (not request) + days (approved extensions are already added)."""
    start_iso = co.allocated_at or co.handed_over_at or co.created_at
    try:
        start = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return (start + timedelta(days=int(co.days or 0))).date()


def overdue_fires(cfg: dict, days_over: int):
    """Which reminder (1-based count, 0 = the due-date one) fires `days_over`
    days after the due date, or None. Day 1 is the first overdue reminder,
    then every `everyDays` days, at most `maxReminders` of them."""
    if not cfg.get("enabled") or days_over is None or days_over < 0:
        return None
    if days_over == 0:
        return 0 if cfg.get("onDueDate") else None
    every = max(1, int(cfg.get("everyDays") or 1))
    if (days_over - 1) % every:
        return None
    n = (days_over - 1) // every + 1
    return n if n <= int(cfg.get("maxReminders") or 0) else None


def checkout_owner_email(db, co, item) -> str:
    """Who owns an overdue checkout on the Nexus side: the allocator who handed
    it over, else the approver, else the lead of the item's department."""
    for e in (co.assigned_allocator_email, co.approver_email):
        if (e or "").strip():
            return e.strip().lower()
    dept = (item.department if item is not None else "") or co.department
    return _dept_lead(db, dept, getattr(item, "company_id", "") if item is not None else "")


def run_overdue_checkouts(db, cfg: dict = None) -> int:
    """Remind borrowers (and later owners) about overdue checkouts. Returns how
    many notifications were written. Caller commits."""
    from models import Item, ItemCheckout, NexusNotification
    cfg = (cfg or erc.get_config(db))["overdue"]
    if not cfg.get("enabled"):
        return 0
    today = _today()
    today_s = today.isoformat()
    sent = 0
    for co in db.query(ItemCheckout).filter(ItemCheckout.status == "allocated").all():
        due = checkout_due_date(co)
        if due is None:
            continue
        days_over = (today - due).days
        n = overdue_fires(cfg, days_over)
        if n is None:
            continue
        borrower = (co.requested_by_email or "").strip().lower()
        item = db.query(Item).filter(Item.id == co.item_id).first()
        targets = []
        if borrower:
            targets.append((borrower, _BORROWER_ACTION))
        if days_over >= int(cfg.get("notifyOwnerAfterDays") or 0):
            owner = checkout_owner_email(db, co, item)
            if owner and owner != borrower:
                targets.append((owner, _OWNER_ACTION))
        name = co.item_name or (item.name if item is not None else "Item")
        for recipient, action in targets:
            existing = (db.query(NexusNotification)
                        .filter(NexusNotification.type == "checkout_overdue",
                                NexusNotification.ref_id == co.id,
                                NexusNotification.recipient == recipient)
                        .with_for_update().first())
            if existing is not None and (existing.created_at or "")[:10] == today_s:
                continue                 # already reminded today
            is_borrower = recipient == borrower
            if days_over == 0:
                title = f"Due Today: {name}"
                body = (f"{name} is due back today ({_us(due)}). Please return it, or request an extension from My Items."
                        if is_borrower else f"{name}, checked out by {co.requested_by}, is due back today ({_us(due)}).")
            else:
                late = f"{_plural(days_over)} overdue (due {_us(due)})"
                body = (f"{name} is {late}. Please return it as soon as you can, or request an extension from My Items."
                        if is_borrower else
                        f"{name}, checked out by {co.requested_by}, is {late} and has not been returned. "
                        f"Please follow up with them.")
                title = f"Overdue: {name}"
            if n and n == int(cfg.get("maxReminders") or 0):
                body += " This is the last automatic reminder."
            sent += _upsert(db, ntype="checkout_overdue", ref_id=co.id, recipient=recipient,
                            title=title, body=body, item_name=name,
                            action={**action, "daysOver": days_over},
                            requested_by=co.requested_by or "", existing=existing)
    return sent


# ── Asset date alerts ───────────────────────────────────────────────────────
def lead_tier(days_before: list, d: int):
    """The most urgent configured warning `d` days before the date has reached
    (d < 0 = already past), or None when it is still earlier than every one."""
    reached = [L for L in days_before if d <= L]
    return min(reached) if reached else None


def _alert(db, *, kind, cfg, ntype, ref_id, due, title, body, item_name, recipients, action) -> int:
    """Send one date alert when a new warning tier is reached for this date."""
    from models import NexusNotification
    entry = cfg[kind]
    if not entry.get("enabled"):
        return 0
    tier = lead_tier(entry.get("daysBefore") or [], (due - _today()).days)
    if tier is None or not recipients:
        return 0
    due_s = due.isoformat()
    rows = (db.query(NexusNotification)
            .filter(NexusNotification.type == ntype, NexusNotification.ref_id == ref_id)
            .with_for_update().all())
    for r in rows:
        a = _action_of(r)
        lead = a.get("lead", _LEGACY_LEAD.get(ntype))
        # A tier already sent for THIS date (a changed date starts over).
        if a.get("due", due_s) == due_s and isinstance(lead, int) and lead <= tier:
            return 0
    mine = {(r.recipient or "").lower(): r for r in rows if r.recipient}
    out = 0
    for email in recipients:
        out += _upsert(db, ntype=ntype, ref_id=ref_id, recipient=email, title=title, body=body,
                       item_name=item_name, action={**action, "lead": tier, "due": due_s},
                       existing=mine.get(email))
    return out


def run_asset_alerts(db, cfg: dict = None) -> int:
    """Warranty / inspection / registration + insurance / service alerts to the
    asset manager. Returns how many notifications were written. Caller commits."""
    from models import Item, ItemCustomField, PropertyAsset, PropertyRecord
    cfg = cfg or erc.get_config(db)
    if not any(cfg[k].get("enabled") for k in erc.DATE_TYPES):
        return 0
    today = _today()
    people = _People(db)
    props = {p.id: p for p in db.query(PropertyAsset).all()}
    admins = None
    unrouted = []

    def route(email: str, what: str) -> list:
        nonlocal admins
        if email:
            return [email]
        if admins is None:
            admins = _it_admins(db)
        unrouted.append(what)
        return admins

    def when(due: date, past: str, future: str) -> str:
        d = (due - today).days
        if d < 0:
            return f"{past} {_us(due)}"
        return f"{future} today ({_us(due)})" if d == 0 else f"{future} {_us(due)} (in {_plural(d)})"

    sent = 0
    for r in db.query(PropertyRecord).filter(PropertyRecord.collection.in_(["warranties", "inspections"])).all():
        p = r.payload or {}
        prop = props.get(r.property_id)
        nm = (prop.name if prop else "") or r.property_id
        if r.collection == "warranties":
            due, kind, ntype = _parse_ymd(p.get("expiration")), "warranty", "asset_warranty_expiry"
        else:
            due, kind, ntype = _parse_ymd(p.get("nextDue")), "inspection", "asset_inspection_due"
        if due is None or not cfg[kind].get("enabled"):
            continue
        past = due < today
        who = route(asset_manager_email(prop, props, people), f"{nm} {kind}")
        if kind == "warranty":
            scope = p.get("scope") or "warranty"
            title = f"Warranty {'Expired' if past else 'Expiring'}: {scope}"
            body = f"{nm}: the warranty for \"{scope}\" {when(due, 'expired', 'expires')}."
        else:
            itype = p.get("type") or "inspection"
            title = f"Inspection {'Overdue' if past else 'Due'}: {itype}"
            body = f"{nm}: \"{itype}\" {when(due, 'was due', 'is due')}."
        sent += _alert(db, kind=kind, cfg=cfg, ntype=ntype, ref_id=r.id, due=due, title=title,
                       body=body, item_name=nm, recipients=who, action=_ASSET_ACTION)

    for pid, prop in props.items():
        pl = prop.payload or {}
        if (pl.get("kind") or "") not in ("vehicle", "equipment"):
            continue
        for key, label, ntype, kind in (
            ("regExpiration", "Registration", "asset_reg_expiry", "registration"),
            ("insExpiration", "Insurance", "asset_ins_expiry", "registration"),
            ("nextServiceDate", "Service", "asset_service_due", "service"),
        ):
            due = _parse_ymd(pl.get(key))
            if due is None or not cfg[kind].get("enabled"):
                continue
            past = due < today
            verb = ("was due", "is due") if kind == "service" else ("expired", "expires")
            sent += _alert(
                db, kind=kind, cfg=cfg, ntype=ntype, ref_id=f"{pid}:{key}", due=due,
                title=f"{label} {'Overdue' if past else 'Due Soon'}: {prop.name}",
                body=f"{prop.name}: {label.lower()} {when(due, *verb)}.", item_name=prop.name,
                recipients=route(asset_manager_email(prop, props, people), f"{prop.name} {label.lower()}"),
                action=_ASSET_ACTION)

    # Item warranties: a date custom field whose key mentions "warranty".
    if cfg["warranty"].get("enabled"):
        keys = [f.field_key for f in db.query(ItemCustomField).all()
                if (f.field_type or "") == "date" and "warranty" in (f.field_key or "").lower()]
        if keys:
            for it in db.query(Item).all():
                if it.deleted_at or it.status == "retired":
                    continue
                for key in keys:
                    due = _parse_ymd((it.custom_fields or {}).get(key))
                    if due is None:
                        continue
                    owner = (it.assigned_to_email or "").strip().lower() or _dept_lead(
                        db, it.department, it.company_id or "")
                    sent += _alert(
                        db, kind="warranty", cfg=cfg, ntype="item_warranty_expiry", ref_id=f"{it.id}:{key}",
                        due=due, title=f"Warranty {'Expired' if due < today else 'Expiring'}: {it.name}",
                        body=f"{it.name}: the warranty {when(due, 'expired', 'expires')}.", item_name=it.name,
                        recipients=route(owner, f"item {it.name} warranty"), action=_ITEM_ACTION)

    if unrouted:
        print(f"[equipment-reminders] no asset manager set for {len(unrouted)} alert(s), "
              f"sent to IT Admins: {', '.join(unrouted[:10])}")
    return sent


def run_daily() -> int:
    """Both scans in one session and one commit. Sync - the loop runs it in a
    thread (asyncio.to_thread), never on the event loop."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        cfg = erc.get_config(db)
        sent = run_overdue_checkouts(db, cfg) + run_asset_alerts(db, cfg)
        db.commit()
        print(f"[equipment-reminders] daily scan complete - {sent} notification(s)")
        return sent
    except Exception as e:           # noqa: BLE001 - a bad row never kills the loop
        db.rollback()
        print(f"[equipment-reminders] scan failed: {type(e).__name__}: {e}")
        return 0
    finally:
        db.close()
