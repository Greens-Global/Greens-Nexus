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

  deliver    the at-hire bundle, the yearly round (SB 294 by 02/01, held until
             this year's version is approved) and the separation notices.

Later parts add: the source watcher, the calendar and the December review,
and site poster tasks.
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
            f"<p><a href='{app_url()}/workday/{sub}' style='color:#1e7b4e;font-weight:600'>Open Workplace Notices in Nexus</a></p></div>")
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


# ── deliver: at hire, every year, at separation ──────────────────────────────
# A DELIVER notice reaches each person on its own: one email per person per
# pass with every file attached (links instead when the files are too big),
# a delivery row per notice (who, which version, when, to which address),
# and it shows under "Given To You" in Workday. A "form" (filled in per
# person - LC 2810.5) is never sent from here: it goes through Documents.

MAX_ATTACH = 3 * 1024 * 1024
HIRE_TRIGGERS = ("hire", "hire_annual")
ANNUAL_TRIGGERS = ("annual", "hire_annual")


def _files_for(versions: list) -> list:
    """[(filename, type, bytes)] for the versions, or [] when too big / missing."""
    from routers.notices import file_bytes
    out, total = [], 0
    for v in versions:
        try:
            data, f = file_bytes(v, "en")
        except Exception:  # noqa: BLE001 - a missing file means links, not a failed pass
            return []
        total += len(data)
        if total > MAX_ATTACH:
            return []
        out.append((f.get("name") or f"{v.notice_id}.pdf", f.get("type") or "application/pdf", data))
    return out


def send_bundle(db, emp, items: list, reason: str, cycle: str = "", to: str = "", actor: str = "system",
                intro: str = "") -> int:
    """Deliver [(notice, version)] to one person. Returns rows written."""
    if not items:
        return 0
    email = core.norm(emp.work_email)
    to = core.norm(to) or email or core.norm(emp.personal_email)
    stamp = core.now_iso()
    files = _files_for([v for _n, v in items])
    lines = [f"{n.title}{' (' + n.form_code + ')' if n.form_code else ''}" for n, _v in items]
    if not files:
        lines.append("Open them in Nexus: Workday > Workplace Notices > Given To You.")
    subject = {"hire": "Your new-hire notices", "annual": "Your yearly workplace notices",
               "separation": "Important information for you", "manual": "A workplace notice for you"}.get(reason, "Workplace notices")
    err = mail(to, f"{subject} - Greens", lines, attachments=files or None,
               intro=intro or "These notices are required by law. Please read them and keep them for your records:")
    for n, v in items:
        db.add(models.WorkplaceNoticeDelivery(
            id=str(uuid.uuid4()), notice_id=n.id, version_id=v.id, email=email or to, reason=reason, cycle=cycle,
            channel="email", sent_to=to, lang="en", sent_at=stamp if not err else "", error=err,
            content_hash=next((f.get("sha256", "") for f in (v.files or []) if f.get("lang") == "en"), ""),
            created_by=actor, created_at=stamp))
    core.log_event(db, actor, "delivered", detail_reason=reason, to=to, count=len(items),
                   notices=[n.id for n, _v in items], error=err)
    if email:
        _bell(db, email, NEW_TYPE, {"hire": "Your New-Hire Notices", "annual": "Your Yearly Notices",
                                    "manual": "A Notice For You"}.get(reason, "Workplace Notices"),
              "; ".join(lines[:4]) + ". They are in Workday > Workplace Notices > Given To You.")
    return len(items)


def _delivered(db, reason: str, cycle: str = "") -> set:
    q = db.query(models.WorkplaceNoticeDelivery.email, models.WorkplaceNoticeDelivery.notice_id).filter(
        models.WorkplaceNoticeDelivery.reason == reason)
    if cycle:
        q = q.filter(models.WorkplaceNoticeDelivery.cycle == cycle)
    return {(core.norm(e), n) for e, n in q.all()}


def deliver_hire(db, on: date | None = None) -> int:
    """Everyone who started on or after the module's first day gets the
    at-hire notices that apply to them, once."""
    emps, ctx, cfg, rows, by = _roster(db)
    since = cfg.get("hireSince") or core.today().isoformat()
    done = _delivered(db, "hire")
    sent = 0
    for e in emps:
        if not e.start_date or e.start_date[:10] < since:
            continue
        pc = core.person_context(db, e, ctx)
        items = []
        for n in rows:
            if n.trigger not in HIRE_TRIGGERS or n.mode not in ("deliver", "both") or n.kind == "form":
                continue
            if (pc["email"], n.id) in done or not core.applies(n, pc, cfg):
                continue
            v = core.live_version(db, n.id, rows=by.get(n.id, []), on=on)
            if v is not None:
                items.append((n, v))
        sent += send_bundle(db, e, items, "hire")
    db.commit()
    return sent


def _due_this_cycle(n, d: date) -> tuple[str, bool]:
    """(cycle, in its sending window): the window runs from Jan 2 to the
    notice's MM-DD due date."""
    if not n.annual_due:
        return "", False
    try:
        due = date(d.year, int(n.annual_due[:2]), int(n.annual_due[3:5]))
    except ValueError:
        return "", False
    return str(d.year), date(d.year, 1, 2) <= d <= due


def deliver_annual(db, on: date | None = None) -> int:
    """The yearly round (SB 294 by 02/01). A notice marked freshEachYear goes
    only once THIS year's version is approved; until then HR hears about it
    once a week."""
    d = on or core.today()
    emps, ctx, cfg, rows, by = _roster(db)
    sent = 0
    ready = {}
    for n in rows:
        if n.trigger not in ANNUAL_TRIGGERS or n.mode not in ("deliver", "both") or n.kind == "form":
            continue
        cycle, open_ = _due_this_cycle(n, d)
        if not open_:
            continue
        v = core.live_version(db, n.id, rows=by.get(n.id, []), on=d)
        fresh = (n.applies or {}).get("freshEachYear")
        if v is None or (fresh and (v.effective_date or "") < f"{cycle}-01-01"):
            _warn_hr(db, n, cycle)
            continue
        ready[n.id] = (n, v, cycle)
    if not ready:
        db.commit()
        return 0
    done = {c: _delivered(db, "annual", c) for c in {x[2] for x in ready.values()}}
    hired = {(core.norm(e), nid): at for e, nid, at in db.query(
        models.WorkplaceNoticeDelivery.email, models.WorkplaceNoticeDelivery.notice_id,
        models.WorkplaceNoticeDelivery.sent_at).filter(models.WorkplaceNoticeDelivery.reason == "hire").all()}
    for e in emps:
        pc = core.person_context(db, e, ctx)
        items, cycle = [], ""
        for nid, (n, v, cyc) in ready.items():
            if (pc["email"], nid) in done[cyc] or not core.applies(n, pc, cfg):
                continue
            if (hired.get((pc["email"], nid)) or "") >= f"{cyc}-01-01":
                continue          # got this year's copy at hire
            items.append((n, v))
            cycle = cyc
        sent += send_bundle(db, e, items, "annual", cycle=cycle)
    db.commit()
    return sent


def _warn_hr(db, n, cycle: str) -> None:
    from routers.notices import approvers
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    for a in approvers(db):
        if db.query(models.NexusNotification.id).filter(
                models.NexusNotification.recipient == a, models.NexusNotification.type == "workplace_notice_hr",
                models.NexusNotification.ref_id == n.id, models.NexusNotification.created_at >= since).first():
            continue
        _bell(db, a, "workplace_notice_hr", f"{n.title}: {cycle} Version Needed",
              f"The {cycle} {n.title} must reach every employee by {_us(f'{cycle}-{n.annual_due}')}. "
              "Prepare and approve this year's version in People > Notices - nothing is sent until then.",
              ref_id=n.id, priority=1, action={"view": "hr", "sub": "hr-notices"})


def deliver_separation(db, on: date | None = None) -> int:
    """Someone who left (inactive / offboarded) after the module's first day
    gets the separation notices, at their personal email when they have one."""
    cfg = core.settings(db)
    since = cfg.get("hireSince") or core.today().isoformat()
    rows = (db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active",
                                                     models.WorkplaceNotice.trigger == "separation").all())
    if not rows:
        return 0
    done = _delivered(db, "separation")
    gone = (db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.status.in_(("inactive", "offboarded")),
                    (models.NexusEmployee.deleted_at == "") | (models.NexusEmployee.deleted_at.is_(None))).all())
    ctx = core.preload(db, gone)
    sent = 0
    for e in gone:
        left = max([str(x.get("at") or x.get("effectiveDate") or "") for x in (e.status_log or [])
                    if isinstance(x, dict) and x.get("to") in ("inactive", "offboarded")] or [""])
        if not left or left[:10] < since:
            continue
        pc = core.person_context(db, e, ctx)
        email = pc["email"] or core.norm(e.personal_email)
        items = []
        for n in rows:
            if (email, n.id) in done or n.kind == "form" or not core.applies(n, pc, cfg):
                continue
            v = core.live_version(db, n.id, on=on)
            if v is not None:
                items.append((n, v))
        sent += send_bundle(db, e, items, "separation", to=e.personal_email or e.work_email)
    db.commit()
    return sent


def run_daily() -> None:
    """Called once a day from reminders_loop (in a thread)."""
    for step in (announce, deliver_hire, deliver_annual, deliver_separation, remind, escalate):
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
