"""Records Audit (Pranshu, Oct 23 2026, after Neil's Colin case on Oct 22: a
full onboarding packet but no picture ID on file, found only when an attorney
asked): "NEXUS should auto audit the details if something is missing for an
employee or any documents got expired then it should notify us".

Every morning (reminders_loop, in a thread) each active or onboarding
person's record is checked for what HR must have on file and for documents
past their expiry date - the same evidence the checklist signals read, so a
gap here is a step a checklist would not tick. HR hears once per company:
ONE bell per recipient, rewritten in place (CLAUDE.md), raised again when the
list changes or a week after it was last raised, and closed when the company
is complete. Recipients are the HR department's head and backup, else the
company's HR contact, else the Global Admins - the checklist owner chain.

People > Records Audit lists the same gaps (gaps() is the one calculation);
the bell and the screen never disagree. Off switch: Global Settings >
Notifications & Communications > HR & Compliance Reminders > Records Audit.
"""
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func

import hr_checklists as hc
from models import HrDocument, HrEntity, NexusEmployee, NexusNotification

NTYPE = "hr_record_audit"
STATUSES = ("active", "onboarding")
RAISE_AGAIN_DAYS = 7
ACTION = {"view": "hr", "sub": "hr-people"}
_KIND_NAMES = {"id": "Picture ID", "contract": "Contract", "certificate": "Certificate", "resume": "Resume"}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _expired(d: str, today: str) -> bool:
    return bool(d) and d[:10] < today


def gaps(db, emp: NexusEmployee, docs: list = None) -> list:
    """What is missing or expired on this person's record, as HR reads it."""
    today = _today().isoformat()
    docs = docs if docs is not None else db.query(HrDocument).filter(HrDocument.employee_id == emp.id).all()
    out = []
    # The top of the org (Neil Kadakia) manages others and has nobody above.
    if not emp.manager_email and not (emp.work_email and db.query(NexusEmployee.id).filter(
            NexusEmployee.status.in_(STATUSES),
            func.lower(NexusEmployee.manager_email) == emp.work_email.lower()).first()):
        out.append("No manager")
    if not emp.start_date:
        out.append("No start date")
    if not emp.employment_type:
        out.append("No worker type")
    if not emp.personal_email:
        out.append("No personal email")
    if not hc._sig_personal_details(db, emp, ""):
        out.append("No emergency contact")
    ids = [d for d in docs if d.kind == "id"]
    if not ids:
        out.append("No picture ID on file")
    elif all(_expired(d.expires_on or "", today) for d in ids):
        last = max(d.expires_on for d in ids)
        out.append(f"Picture ID expired {hc.us_date(last)}")
    c = emp.compliance or {}
    exp = str(c.get("expiryDate") or "")[:10]
    if _expired(exp, today):
        out.append(f"Work authorization expired {hc.us_date(exp)}")
    elif hc.person_country(db, emp) == "US" and c.get("status") != "verified":
        out.append("Work authorization not verified")
    # Any other dated document: expired unless a newer one of the same kind
    # (other than "other", which is per file) is still good.
    for d in docs:
        if d.kind == "id" or not _expired(d.expires_on or "", today):
            continue
        if d.kind != "other" and any(x is not d and x.kind == d.kind and (x.created_at or "") > (d.created_at or "")
                                     and not _expired(x.expires_on or "", today) for x in docs):
            continue
        out.append(f"{_KIND_NAMES.get(d.kind) or 'Document'} \"{d.file_name}\" expired {hc.us_date(d.expires_on)}")
    end = str((emp.contractor or {}).get("contract_end") or "")[:10]
    if _expired(end, today):
        out.append(f"Contract ended {hc.us_date(end)}")
    return out


def company_report(db, entity_id: str = None, scope=None) -> list:
    """[{id, name, company, gaps}] for everyone with a gap, by company then
    name. `scope` is hr_scope(): None = every company."""
    from routers.hr import _scoped
    q = db.query(NexusEmployee).filter(NexusEmployee.status.in_(STATUSES))
    if entity_id is not None:
        q = q.filter(NexusEmployee.company == entity_id)
    people = _scoped(q, scope).all()
    docs = {}
    if people:
        for d in db.query(HrDocument).filter(HrDocument.employee_id.in_([p.id for p in people])).all():
            docs.setdefault(d.employee_id, []).append(d)
    out = []
    for p in people:
        g = gaps(db, p, docs.get(p.id, []))
        if g:
            out.append({"id": p.id, "name": hc.full_name(p), "company": p.company or "",
                        "jobTitle": p.job_title or "", "gaps": g})
    out.sort(key=lambda x: (x["company"], x["name"].lower()))
    return out


def recipients(db, entity: HrEntity) -> list:
    """The HR department's head and backup, else the HR contact, else the Global Admins."""
    stand_in = NexusEmployee(company=entity.id, work_email="", manager_email="")
    return hc.resolve_owners(db, "hr", stand_in, hc.role_owners(db, entity.id), entity)


def _text(company: str, rows: list) -> tuple:
    n = len(rows)
    title = f"Records Audit: {company} - {n} {'Person Needs' if n == 1 else 'People Need'} Attention"
    lines = [f"- {r['name']}: {', '.join(r['gaps'])}" for r in rows[:8]]
    if n > 8:
        lines.append(f"- and {n - 8} more - open People > Records Audit")
    return title, "\n".join(lines)


def _upsert(db, recipient: str, entity: HrEntity, title: str, body: str, done: bool) -> bool:
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == NTYPE, NexusNotification.ref_id == entity.id,
                   NexusNotification.recipient == recipient)
           .with_for_update().first())
    now = datetime.now(timezone.utc)
    if row is None:
        if done:
            return False
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=NTYPE, recipient=recipient, title=title, body=body, ref_id=entity.id,
            item_name="", requested_by="", action=json.dumps(ACTION), actioned=False, read_by="",
            company=entity.id, created_at=now.isoformat()))
        return True
    if done:
        if row.actioned:
            return False
        row.title, row.body, row.actioned = title, body, True
        return True
    stale = (row.created_at or "")[:10] <= (now.date() - timedelta(days=RAISE_AGAIN_DAYS)).isoformat()
    if row.title == title and row.body == body and not row.actioned and not stale:
        return False
    row.title, row.body, row.read_by, row.actioned = title, body, "", False
    row.created_at = now.isoformat()
    return True


def run_daily() -> int:
    """The morning pass. Own session and commit, like hr_checklists.run_daily."""
    import hr_reminder_config
    from database import SessionLocal
    db = SessionLocal()
    sent = 0
    try:
        if not hr_reminder_config.get_config(db)["recordAudit"]["enabled"]:
            return 0
        report = company_report(db)
        by_co = {}
        for r in report:
            by_co.setdefault(r["company"], []).append(r)
        open_cos = {x.ref_id for x in db.query(NexusNotification.ref_id)
                    .filter(NexusNotification.type == NTYPE, NexusNotification.actioned.is_(False))}
        for entity in db.query(HrEntity).filter(HrEntity.id.in_(set(by_co) | open_cos)).all():
            rows = by_co.get(entity.id, [])
            name = entity.name or "Company"
            title, body = _text(name, rows) if rows else (
                f"Records Audit: {name} - All Records Complete", "Everyone's record is complete and nothing has expired.")
            for r in recipients(db, entity):
                sent += _upsert(db, r.lower(), entity, title, body, done=not rows)
        db.commit()
        print(f"[records-audit] {len(report)} people with gaps, {sent} bell(s) raised or closed")
        return sent
    except Exception as e:   # noqa: BLE001 - the audit never stops the morning loop
        db.rollback()
        print(f"[records-audit] pass failed: {e}")
        return 0
    finally:
        db.close()

