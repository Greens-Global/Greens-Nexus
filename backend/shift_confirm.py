"""Shifts Phase 3a - confirm my schedule (Neil, Oct 14 2026).

A manager shares a schedule and then wonders who has actually seen it. When
the company's confirmRequests switch is on (Settings > Shifts, on by
default), the publish bell and email ask each affected person to "Confirm
you have seen it", and the person presses Confirm on My Shifts:

    publish_schedule (routers/timeclock.py) writes one models.ShiftPublish
    per Share (record_publish) and shift_notify.notify_published asks each
    affected person (ask) - one models.ShiftPublishConfirm per (publish,
    person), confirmed_at empty.

    POST /timeclock/schedule/confirm/{publish_id}      confirm() - the person
    GET  /timeclock/my-schedule/confirmations           my_unconfirmed()
    GET  /timeclock/schedule/confirmations?start&end    manager_list() - who
                                                        has and has not, in scope
    POST /timeclock/schedule/nudge                      nudge() - one reminder
                                                        per publish per person,
                                                        never to someone who
                                                        confirmed

Nothing here commits except where it says so; the routes commit.
"""
import uuid
from datetime import datetime, timezone
from html import escape

from sqlalchemy.orm import Session

import models
from app_url import app_url

MY_SHIFTS = {"view": "shifts", "sub": "mine"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _us(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def confirm_action(publish_id: str) -> dict:
    """The bell action: open My Shifts with the publish to confirm."""
    return {**MY_SHIFTS, "confirm": publish_id}


def confirm_url(publish_id: str) -> str:
    return f"{app_url()}/shifts/mine?confirm={publish_id}"


def wants_confirm(db: Session, company: str) -> bool:
    """The company's confirmRequests switch ('' = the tenant row)."""
    from routers.shift_requests import get_settings
    return bool(get_settings(db, company or "").get("confirmRequests", True))


def record_publish(db: Session, publish_id: str, by: str, d0: str, d1: str, group_id: str = "",
                   reason: str = "", changes: int = 0) -> models.ShiftPublish:
    """One row per Share, written by publish_schedule. No commit."""
    row = models.ShiftPublish(id=publish_id, by=(by or "").lower(), at=_now(), start_date=d0, end_date=d1,
                              group_id=group_id or "", reason=reason or "", changes=int(changes or 0))
    db.add(row)
    return row


def ask(db: Session, publish_id: str, email: str) -> models.ShiftPublishConfirm:
    """Ask one person to confirm one publish - idempotent. No commit."""
    em = (email or "").lower()
    row = (db.query(models.ShiftPublishConfirm)
           .filter(models.ShiftPublishConfirm.publish_id == publish_id,
                   models.ShiftPublishConfirm.employee_email == em).first())
    if row is None:
        row = models.ShiftPublishConfirm(id=str(uuid.uuid4()), publish_id=publish_id, employee_email=em,
                                         confirmed_at="", nudged_at="")
        db.add(row)
    return row


def confirm(db: Session, publish_id: str, email: str):
    """The person has seen it. Returns the row, or None when they were
    never asked for this publish. Confirming twice keeps the first time.
    No commit."""
    em = (email or "").lower()
    row = (db.query(models.ShiftPublishConfirm)
           .filter(models.ShiftPublishConfirm.publish_id == publish_id,
                   models.ShiftPublishConfirm.employee_email == em).first())
    if row is None:
        return None
    if not row.confirmed_at:
        row.confirmed_at = _now()
    return row


def _names(db: Session) -> dict:
    out = {}
    for e in db.query(models.NexusEmployee.work_email, models.NexusEmployee.display_name,
                      models.NexusEmployee.first_name, models.NexusEmployee.last_name).all():
        if e.work_email:
            out[e.work_email.lower()] = ((e.display_name or "").strip()
                                         or f"{e.first_name or ''} {e.last_name or ''}".strip())
    return out


def _my_change_counts(db: Session, email: str, publish_ids: list) -> dict:
    """{publish_id: how many of THIS person's shifts that publish shared}."""
    from sqlalchemy import func
    L = models.ShiftChangeLog
    if not publish_ids:
        return {}
    rows = (db.query(L.publish_id, func.count(L.id))
            .filter(L.action == "shared", L.employee_email == email, L.publish_id.in_(publish_ids))
            .group_by(L.publish_id).all())
    return {pid: int(n) for pid, n in rows}


def my_unconfirmed(db: Session, email: str) -> list:
    """The signed-in person's publishes still waiting on them, newest first:
    [{publishId, at, by, byName, start, end, changes}]."""
    em = (email or "").lower()
    asks = (db.query(models.ShiftPublishConfirm)
            .filter(models.ShiftPublishConfirm.employee_email == em,
                    models.ShiftPublishConfirm.confirmed_at == "").all())
    if not asks:
        return []
    ids = [a.publish_id for a in asks]
    pubs = {p.id: p for p in db.query(models.ShiftPublish).filter(models.ShiftPublish.id.in_(ids)).all()}
    names = _names(db)
    counts = _my_change_counts(db, em, ids)
    out = []
    for a in asks:
        p = pubs.get(a.publish_id)
        if p is None:
            continue
        out.append({"publishId": p.id, "at": p.at, "by": p.by, "byName": names.get(p.by) or p.by,
                    "start": p.start_date, "end": p.end_date,
                    "changes": counts.get(p.id, 0) or int(p.changes or 0)})
    return sorted(out, key=lambda x: x["at"], reverse=True)


def manager_list(db: Session, scope, start: str, end: str) -> list:
    """Per person in scope (None = everyone), the publishes that touched
    their shifts in [start, end] and whether they confirmed:
    [{email, name, publishes: [{publishId, at, by, confirmedAt|null, nudgedAt|null}]}].
    Only people who were ASKED appear - a company with confirmRequests off
    has nobody to list."""
    L = models.ShiftChangeLog
    touched = (db.query(L.employee_email, L.publish_id)
               .filter(L.action == "shared", L.publish_id != "", L.employee_email != "",
                       L.work_date >= start[:10], L.work_date <= end[:10]).distinct().all())
    pairs = {((em or "").lower(), pid) for em, pid in touched
             if em and (scope is None or (em or "").lower() in scope)}
    if not pairs:
        return []
    pids = sorted({pid for _, pid in pairs})
    pubs = {p.id: p for p in db.query(models.ShiftPublish).filter(models.ShiftPublish.id.in_(pids)).all()}
    asks = {(a.employee_email, a.publish_id): a for a in
            db.query(models.ShiftPublishConfirm).filter(models.ShiftPublishConfirm.publish_id.in_(pids)).all()}
    names = _names(db)
    by_person = {}
    for em, pid in pairs:
        a = asks.get((em, pid))
        p = pubs.get(pid)
        if a is None or p is None:
            continue
        by_person.setdefault(em, []).append({"publishId": pid, "at": p.at, "by": p.by,
                                             "confirmedAt": a.confirmed_at or None,
                                             "nudgedAt": a.nudged_at or None})
    out = []
    for em, pubs_ in by_person.items():
        pubs_.sort(key=lambda x: x["at"], reverse=True)
        out.append({"email": em, "name": names.get(em) or em, "publishes": pubs_,
                    "unconfirmed": sum(1 for x in pubs_ if not x["confirmedAt"])})
    return sorted(out, key=lambda x: (x["name"].lower(), x["email"]))


# ── The nudge ─────────────────────────────────────────────────────────────

def nudge_email_html(first_name: str, pub: models.ShiftPublish, actor_name: str) -> tuple:
    """(subject, html): "Please confirm your schedule", themed like every
    other Nexus email."""
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    url = confirm_url(pub.id)
    hello = f"Hi {escape(first_name)}," if first_name else "Hi,"
    who = escape(actor_name) if actor_name else "Your manager"
    span = _us(pub.start_date) if pub.start_date == pub.end_date else f"{_us(pub.start_date)} - {_us(pub.end_date)}"
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">Please Confirm Your Schedule</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{hello} {who} is asking you to confirm you have seen your shifts for {escape(span)}. It takes one click.</div>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Confirm My Schedule</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this email once per shared schedule, when a manager asks for a confirmation in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return "Please confirm your schedule", html


def nudge(db: Session, publish_id: str, emails: list, actor: str, scope, bt=None) -> dict:
    """One bell + one email "Please confirm your schedule" per person asked
    for this publish who has neither confirmed nor been nudged - only
    people in the manager's scope (None = everyone), only the `emails`
    given when any are. Commits. Returns {nudged, skipped: {...}}."""
    import shift_notify
    pub = db.query(models.ShiftPublish).filter(models.ShiftPublish.id == publish_id).first()
    if pub is None:
        return {"nudged": 0, "emails": [], "skipped": {"confirmed": 0, "alreadyNudged": 0, "outOfScope": 0},
                "error": "Publish not found"}
    want = {str(e).strip().lower() for e in (emails or []) if str(e).strip()}
    q = db.query(models.ShiftPublishConfirm).filter(models.ShiftPublishConfirm.publish_id == publish_id)
    if want:
        q = q.filter(models.ShiftPublishConfirm.employee_email.in_(sorted(want)))
    people = {(e.work_email or "").lower(): e for e in
              db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").all()}
    actor = (actor or "").lower()
    actor_emp = people.get(actor)
    actor_name = f"{actor_emp.first_name or ''} {actor_emp.last_name or ''}".strip() if actor_emp else ""
    span = _us(pub.start_date) if pub.start_date == pub.end_date else f"{_us(pub.start_date)} - {_us(pub.end_date)}"
    now = datetime.now(timezone.utc).isoformat()
    skipped = {"confirmed": 0, "alreadyNudged": 0, "outOfScope": 0}
    sent, batch = [], []
    for a in q.all():
        em = a.employee_email
        if scope is not None and em not in scope:
            skipped["outOfScope"] += 1
            continue
        if a.confirmed_at:
            skipped["confirmed"] += 1
            continue
        if a.nudged_at:
            skipped["alreadyNudged"] += 1
            continue
        shift_notify._upsert_bell(db, em, f"schedule-confirm:{publish_id}", "Please confirm your schedule",
                                  f"Confirm you have seen your shifts for {span}.", actor, now,
                                  action=confirm_action(publish_id))
        a.nudged_at = _now()
        emp = people.get(em)
        if emp is not None and (emp.status or "active") == "active":
            batch.append((em, *nudge_email_html((emp.first_name or "").strip(), pub, actor_name)))
        sent.append(em)
    db.commit()
    if batch and bt is not None:
        import graph_mail
        if graph_mail.graph_configured():
            bt.add_task(shift_notify._send_emails, batch)
    return {"nudged": len(sent), "emails": sorted(sent), "skipped": skipped}
