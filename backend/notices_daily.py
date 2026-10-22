"""Workplace Notices - the once-a-day pass (inside reminders_loop, in a
thread). Each step has its own commit, so one failing never undoes another.

  announce   a version that went live since the last pass: a bell (and an
             email for anything to acknowledge) to everyone it applies to.
             Posters are one bell per person per day, however many changed.
  remind     what each person still has to acknowledge: the first reminder
             when it is owed, then every 7 days while it is due within 3 days
             or overdue (one bell + one email per person, all documents in it).
  escalate   on Mondays, each manager hears which direct reports are more than
             7 days overdue (one bell + one email).

Later parts add: deliveries at hire / every year / at separation, the source
watcher, the calendar and the December review, and site poster tasks.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func

import graph_mail
import models
import notices as core
from app_url import app_url
from database import SessionLocal

ACK_TYPE = "workplace_notice_ack"
NEW_TYPE = "workplace_notice"
MGR_TYPE = "workplace_notice_team"
MY_ACTION = {"view": "myhr", "sub": "notices"}


def _us(iso: str) -> str:
    try:
        d = date.fromisoformat(str(iso)[:10])
        return f"{d.month:02d}/{d.day:02d}/{d.year}"
    except (TypeError, ValueError):
        return iso or ""


def _bell(db, recipient: str, ntype: str, title: str, body: str, ref_id: str = "", priority: int = 0,
          action: dict | None = None) -> None:
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=ntype, recipient=core.norm(recipient), title=title, body=body, ref_id=ref_id,
        item_name=title[:120], requested_by="Workplace Notices", action=json.dumps(action or MY_ACTION),
        actioned=False, read_by="", company="", created_at=core.now_iso(), priority=priority))


def mail(to: str, subject: str, lines: list[str], sub: str = "notices", attachments=None, intro: str = "") -> str:
    """One email; '' when sent, else why not (callers log it, never raise)."""
    frm = (graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    if not frm or not to:
        return "Email is not set up" if not frm else "No address"
    items = "".join(f"<li style='margin:4px 0'>{ln}</li>" for ln in lines)
    html = (f"<div style='font-family:Inter,Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a'>"
            f"<p>{intro or subject}</p><ul>{items}</ul>"
            f"<p><a href='{app_url()}/myhr/{sub}' style='color:#1e7b4e;font-weight:600'>Open Workplace Notices in Nexus</a></p></div>")
    try:
        graph_mail.send_mail(from_email=frm, to=[to], cc=[], subject=subject, html=html, attachments=attachments)
        return ""
    except graph_mail.GraphMailError as e:
        return str(e)[:300]
    except Exception as e:  # noqa: BLE001 - an email is never worth a failed pass
        return str(e)[:300]


def _bell_since(db, recipient: str, ntype: str, since_iso: str) -> bool:
    return db.query(models.NexusNotification.id).filter(
        models.NexusNotification.recipient == core.norm(recipient), models.NexusNotification.type == ntype,
        models.NexusNotification.created_at >= since_iso).first() is not None


def _roster(db):
    emps = core.active_people(db)
    ctx = core.preload(db, emps)
    cfg = core.settings(db)
    rows = (db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active")
            .order_by(models.WorkplaceNotice.sort).all())
    by: dict = {}
    for v in db.query(models.WorkplaceNoticeVersion).all():
        by.setdefault(v.notice_id, []).append(v)
    return emps, ctx, cfg, rows, by


# ── announce ─────────────────────────────────────────────────────────────────

def announce(db, on: date | None = None) -> int:
    d = (on or core.today()).isoformat()
    fresh = (db.query(models.WorkplaceNoticeVersion)
             .filter(models.WorkplaceNoticeVersion.status == "approved",
                     models.WorkplaceNoticeVersion.announced_at == "",
                     models.WorkplaceNoticeVersion.effective_date <= d).all())
    if not fresh:
        return 0
    emps, ctx, cfg, rows, by = _roster(db)
    notices = {n.id: n for n in rows}
    live_ids = {}
    for v in fresh:
        live = core.live_version(db, v.notice_id, rows=by.get(v.notice_id, []), on=on)
        if live is not None and live.id == v.id and v.notice_id in notices:
            live_ids[v.notice_id] = v
    sent = 0
    day_start = f"{d}T00:00:00"
    for e in emps:
        pc = core.person_context(db, e, ctx)
        mine = [notices[nid] for nid in live_ids if core.applies(notices[nid], pc, cfg)]
        docs = [n for n in mine if n.kind in core.ACK_KINDS and n.requires_ack and live_ids[n.id].major]
        posters = [n for n in mine if n not in docs and n.mode in ("post", "both", "read")]
        for n in docs:
            v = live_ids[n.id]
            _bell(db, pc["email"], ACK_TYPE, f"Please Read: {n.title}",
                  f"{v.label or 'A new version'} is out. {v.summary or ''} Read and acknowledge it in Workday > Workplace Notices.".strip(),
                  ref_id=n.id, priority=1)
            mail(pc["email"], f"Please read and acknowledge: {n.title}",
                 [f"{n.title} - {v.label or 'new version'}, in effect {_us(v.effective_date)}. {v.summary or ''}"])
            sent += 1
        if posters and not _bell_since(db, pc["email"], NEW_TYPE, day_start):
            names = ", ".join(n.title for n in posters[:3]) + (f" and {len(posters) - 3} more" if len(posters) > 3 else "")
            _bell(db, pc["email"], NEW_TYPE, "Workplace Notices Updated", f"Updated: {names}.")
            sent += 1
    stamp = core.now_iso()
    for v in fresh:
        v.announced_at = stamp
        core.log_event(db, "system", "version_announced", v.notice_id, v.id)
    db.commit()
    return sent


# ── remind / escalate ────────────────────────────────────────────────────────

def remind(db, on: date | None = None) -> int:
    d = on or core.today()
    emps, ctx, cfg, rows, by = _roster(db)
    numbers = core.version_numbers(db)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    sent = 0
    for e in emps:
        owed = core.owed(db, e, ctx, cfg, by, rows, numbers)
        if not owed:
            continue
        email = core.norm(e.work_email)
        last = (db.query(func.max(models.NexusNotification.created_at))
                .filter(models.NexusNotification.recipient == email, models.NexusNotification.type == ACK_TYPE).scalar())
        urgent = any(st["overdue"] or (date.fromisoformat(st["due"]) - d).days <= 3 for _n, st in owed if st["due"])
        if last and (last >= week_ago or not urgent):
            continue
        lines = [f"{n.title} - {'overdue since' if st['overdue'] else 'due'} {_us(st['due'])}" for n, st in owed]
        yearly = all(st["reason"] == "yearly" for _n, st in owed)
        title = "Yearly Acknowledgment Due" if yearly else "Documents To Acknowledge"
        _bell(db, email, ACK_TYPE, title, "; ".join(lines) + ".", priority=1 if urgent else 0)
        mail(email, f"{title} - Workplace Notices", lines,
             intro="Please read and acknowledge these in Nexus (Workday > Workplace Notices):")
        sent += 1
    db.commit()
    return sent


def escalate(db, on: date | None = None) -> int:
    d = on or core.today()
    if d.weekday() != 0:      # Mondays
        return 0
    emps, ctx, cfg, rows, by = _roster(db)
    numbers = core.version_numbers(db)
    late: dict = {}
    for e in emps:
        mgr = core.norm(e.manager_email)
        if not mgr:
            continue
        for n, st in core.owed(db, e, ctx, cfg, by, rows, numbers):
            if st["due"] and (d - date.fromisoformat(st["due"])).days > 7:
                late.setdefault(mgr, []).append(f"{core.person_name(e)}: {n.title} (due {_us(st['due'])})")
    since = (datetime.now(timezone.utc) - timedelta(days=6)).isoformat()
    for mgr, lines in late.items():
        if _bell_since(db, mgr, MGR_TYPE, since):
            continue
        _bell(db, mgr, MGR_TYPE, "Your Team: Overdue Acknowledgments", "; ".join(lines[:10]) + ".",
              action={"view": "myhr", "sub": "notices"})
        mail(mgr, "Your team has overdue Workplace Notices", lines,
             intro="These people on your team have not acknowledged their documents. Please remind them:")
    db.commit()
    return len(late)


def run_daily() -> None:
    """Called once a day from reminders_loop (in a thread)."""
    for step in (announce, remind, escalate):
        db = SessionLocal()
        try:
            core.ensure_catalog(db)
            db.commit()
            step(db)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            print(f"[notices] {step.__name__} failed: {e}")
        finally:
            db.close()
