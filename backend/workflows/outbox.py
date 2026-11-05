"""Workflow texts and emails that wait, and the record of texts sent
(Neil, 11/05/2026). One row per person per message in `workflow_messages`.

  * Quiet hours, California only: a text to a person who works in
    California (work_state - their work site, punches, location or company;
    or HR put them on the California rule) between 9:00 PM and 8:00 AM
    Pacific is held and goes out at 8:00 AM Pacific. Everyone else is texted
    at once. Emails are never held.
  * Daily text limit: a person gets at most `textDailyCap` workflow texts
    (Settings > Workflows, default 3) in any 24 hours, held ones included.
    Past it the message goes to their bell instead - a notification is free
    and never wakes anyone.
  * Send One Summary Per Person: a step with it on queues its message; the
    first one waits `summaryMinutes` (default 60) for more from the same
    workflow, then the person gets ONE email (or one text) with them all.

`flush` (every workflows tick, in the tick's thread; the deployed worker
only) sends what is due. A send that fails is tried again 5, 15 and 60
minutes later, then marked failed and the workflow's owner is belled - the
step itself finished when the message was queued."""
from __future__ import annotations

import mimetypes
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func

import models

PACIFIC = ZoneInfo("America/Los_Angeles")
QUIET_START, QUIET_END = 21, 8          # 9:00 PM to 8:00 AM Pacific
QUIET_LABEL = "8:00 AM Pacific"
MAX_ATTACH_BYTES = 3 * 1024 * 1024      # Graph takes inline attachments up to ~3 MB in all
RETRY_MINUTES = (5, 15, 60)
SMS_MAX = 480
KEEP_DAYS = 30


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse(s: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(s or ""))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── quiet hours (California) ─────────────────────────────────────────────────
def quiet_until(now: Optional[datetime] = None) -> Optional[datetime]:
    """8:00 AM Pacific next, when `now` is inside 9:00 PM - 8:00 AM Pacific;
    None outside quiet hours."""
    local = (now or now_utc()).astimezone(PACIFIC)
    if local.hour >= QUIET_START:
        day = local.date() + timedelta(days=1)
    elif local.hour < QUIET_END:
        day = local.date()
    else:
        return None
    return datetime(day.year, day.month, day.day, QUIET_END, tzinfo=PACIFIC).astimezone(timezone.utc)


def in_california(db, email: str) -> bool:
    """Whether the person works in California - the work_state rule the
    California Review reads (or HR put them on the California rule by hand).
    Unknown is not California: only California people are held."""
    import work_state
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == (email or "").lower()).first())
    if emp is None:
        return False
    if work_state.explicit_rule(emp) == "ca":
        return True
    try:
        return work_state.resolve(db, emp)["state"] == "CA"
    except Exception:   # noqa: BLE001 - a lookup that fails holds nothing
        return False


# ── the daily text limit ─────────────────────────────────────────────────────
def texts_today(db, email: str, now: Optional[datetime] = None) -> int:
    """Workflow texts sent to or waiting for this person in the last 24 hours."""
    M = models.WorkflowMessage
    since = _iso((now or now_utc()) - timedelta(hours=24))
    return (db.query(func.count(M.id))
            .filter(M.channel == "sms", M.recipient == (email or "").lower(), M.status.in_(("sent", "queued")),
                    M.created_at >= since).scalar() or 0)


def record(db, *, channel: str, recipient: str, status: str, now: Optional[datetime] = None,
           not_before: Optional[datetime] = None, **kw) -> models.WorkflowMessage:
    now = now or now_utc()
    row = models.WorkflowMessage(id=str(uuid.uuid4()), channel=channel, recipient=(recipient or "").lower(),
                                 status=status, created_at=_iso(now),
                                 sent_at=_iso(now) if status == "sent" else "",
                                 not_before=_iso(not_before) if not_before else "", attempts=0, error="", **kw)
    db.add(row)
    return row


# ── the record's files ───────────────────────────────────────────────────────
def record_files(db, row) -> list[tuple[str, str]]:
    """[(name, url)] for a task's or a ticket's files (task_attachments).
    Only files in Nexus's own storage are ever attached."""
    from routers.files import parse_public_url
    rid = str(getattr(row, "id", "") or "")
    if not rid:
        return []
    A = models.TaskAttachment
    rows = db.query(A).filter(A.task_id == rid).order_by(A.added_at).all()
    return [(a.name or "file", a.url) for a in rows if a.url and parse_public_url(a.url)]


def fetch_files(files) -> tuple[list[tuple], list[str]]:
    """(attachments [(name, type, bytes)], names left out) - at most
    MAX_ATTACH_BYTES in all; a file that does not fit or cannot be read is
    left out by name, and the email links to the record instead."""
    import httpx

    from routers.files import fetchable_url, parse_public_url
    out, left, total = [], [], 0
    for name, url in files or []:
        if not parse_public_url(url):
            left.append(name)
            continue
        try:
            r = httpx.get(fetchable_url(url), timeout=20)
            r.raise_for_status()
            data = r.content
        except Exception:   # noqa: BLE001 - one unreadable file is left out, the email still goes
            left.append(name)
            continue
        if total + len(data) > MAX_ATTACH_BYTES:
            left.append(name)
            continue
        total += len(data)
        out.append((name, mimetypes.guess_type(name)[0] or "application/octet-stream", data))
    return out, left


# ── sending ──────────────────────────────────────────────────────────────────
def send_email(*, to: list[str], cc: Optional[list[str]], subject: str, html: str, sender: str = "",
               reply_to: str = "", attachments=None) -> str:
    """Send through graph_mail; returns the mailbox it went from. A person's
    own mailbox that Nexus may not send from (403 / 404) falls back to the
    Nexus mailbox with replies going to that person (accounting_saved's
    rule). Raises GraphMailError otherwise."""
    import graph_mail
    nexus = graph_mail.DEFAULT_FROM_EMAIL
    if sender and sender.lower() != (nexus or "").lower():
        try:
            graph_mail.send_mail(from_email=sender, to=to, cc=cc, subject=subject, html=html, reply_to=reply_to,
                                 attachments=attachments)
            return sender
        except graph_mail.GraphMailError as e:
            msg = str(e)
            if not nexus or not ("403" in msg or "404" in msg or "ErrorAccessDenied" in msg):
                raise
            reply_to = reply_to or sender
    graph_mail.send_mail(from_email=nexus, to=to, cc=cc, subject=subject, html=html, reply_to=reply_to,
                         attachments=attachments)
    return nexus


def summary_html(db, to: str, heading: str, items: list[tuple[str, str, str]], workflow_name: str,
                 note: str = "") -> str:
    """One email holding several messages: [(heading, body, link)]."""
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    blocks = []
    for h, body, link in items:
        button = (f'<div style="margin-top:8px"><a href="{escape(link)}" style="color:{band};font-weight:600;'
                  f'font-size:13px;text-decoration:none">Open In Nexus</a></div>') if link else ""
        blocks.append(f'<tr><td style="padding:14px 28px;border-top:1px solid #e5e7eb">'
                      f'<div style="font-size:15px;font-weight:600;color:#111827">{escape(h)}</div>'
                      f'<div style="font-size:14px;line-height:1.55;color:#374151;margin-top:6px;'
                      f'white-space:pre-line">{escape(body)}</div>{button}</td></tr>')
    extra = (f'<tr><td style="padding:0 28px 18px;font-size:12.5px;color:#6b7280">{escape(note)}</td></tr>'
             if note else "")
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block(email_theme.logo_for(db, "", to))}</td></tr>
    <tr><td style="padding:24px 28px 14px"><div style="font-size:20px;font-weight:600;color:#111827">{escape(heading)}</div></td></tr>
    {''.join(blocks)}
    {extra}
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      Sent by the workflow "{escape(workflow_name)}" in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


def summary_text(rows: list[models.WorkflowMessage], workflow_name: str) -> str:
    """One text for several: "<Company>: 3 updates from <workflow>: a / b / c
    Open: <link>" (the link only when every message points at the same
    record), cut to SMS_MAX."""
    first = rows[0].meta or {}
    if len(rows) == 1:
        return rows[0].body
    head = str(first.get("prefix") or "Nexus: ")
    links = {str((r.meta or {}).get("link") or "") for r in rows}
    link = links.pop() if len(links) == 1 else ""
    tail = f" Open: {link}" if link else ""
    msg = f"{len(rows)} updates from {workflow_name}: " + " / ".join(str((r.meta or {}).get("message") or "")
                                                                     for r in rows)
    room = SMS_MAX - len(head) - len(tail)
    if len(msg) > room:
        msg = msg[:max(0, room - 3)].rstrip() + "..."
    return f"{head}{msg}{tail}"


def _transient_sms(err: str) -> bool:
    return "unreachable" in err or " returned 5" in err or " returned 429" in err


def _send_group(db, rows: list[models.WorkflowMessage], wf: Optional[models.Workflow]) -> None:
    """Send one person's due message(s); raises on failure."""
    import sentdm
    name = (getattr(wf, "name", "") or "") or "a workflow"
    first = rows[0]
    if first.channel == "sms":
        if not sentdm.configured():
            raise RuntimeError("Texting is not set up on this server (NEXUS_SENTDM_KEY)")
        ok, err = sentdm.send_text(first.address, summary_text(rows, name))
        if not ok:
            raise (TimeoutError(err) if _transient_sms(err) else ValueError(err))
        return
    meta = first.meta or {}
    files = [tuple(f) for r in rows for f in ((r.meta or {}).get("files") or []) if isinstance(f, (list, tuple))]
    attachments, left = fetch_files(files) if files else ([], [])
    note = f"Too large to attach (open the record in Nexus): {', '.join(left)}" if left else ""
    if len(rows) == 1:
        from workflows.packs.core import email_html
        body = first.body + (f"\n\n{note}" if note else "")
        html = email_html(db, first.recipient, first.subject, body, first.link, name)
        subject = first.subject
    else:
        subject = f"{name}: {len(rows)} Updates"
        html = summary_html(db, first.recipient, subject, [(r.subject, r.body, r.link) for r in rows], name, note)
    send_email(to=[first.recipient], cc=None, subject=subject, html=html, sender=str(meta.get("sender") or ""),
               reply_to=str(meta.get("replyTo") or ""), attachments=attachments or None)


def flush(db, now: Optional[datetime] = None) -> int:
    """Send every due held or summary message; returns how many people got
    one. The deployed worker only (Send An Email's rule)."""
    import leader
    if not leader.is_deployed_worker():
        return 0
    now = now or now_utc()
    M = models.WorkflowMessage
    due = (db.query(M).filter(M.status == "queued", M.not_before <= _iso(now))
           .order_by(M.created_at).limit(500).all())
    done: set = set()
    sent = 0
    for row in due:
        gk = (row.channel, row.recipient, row.group_key or row.id)
        if gk in done:
            continue
        done.add(gk)
        if row.group_key:
            # everything queued for this person from this workflow goes in
            # the one summary, the later ones too
            rows = (db.query(M).filter(M.status == "queued", M.channel == row.channel, M.recipient == row.recipient,
                                       M.group_key == row.group_key).order_by(M.created_at).all())
        else:
            rows = [row]
        if row.channel == "sms" and any((r.meta or {}).get("california") for r in rows):
            hold = quiet_until(now)
            if hold is not None:
                for r in rows:
                    r.not_before = _iso(hold)
                db.commit()
                continue
        wf = db.get(models.Workflow, row.workflow_id) if row.workflow_id else None
        try:
            _send_group(db, rows, wf)
        except Exception as e:   # noqa: BLE001 - one person's message never stops the others
            _failed(db, rows, wf, e, now)
            continue
        for r in rows:
            r.status, r.sent_at, r.error = "sent", _iso(now), ""
        db.commit()
        sent += 1
    return sent


def _failed(db, rows, wf, e: Exception, now: datetime) -> None:
    import graph_mail
    retry = isinstance(e, (TimeoutError, graph_mail.GraphMailError, OSError))
    attempts = max(int(r.attempts or 0) for r in rows) + 1
    err = f"{type(e).__name__}: {str(e)[:250]}"
    if retry and attempts <= len(RETRY_MINUTES):
        later = _iso(now + timedelta(minutes=RETRY_MINUTES[attempts - 1]))
        for r in rows:
            r.attempts, r.error, r.not_before = attempts, err, later
        db.commit()
        return
    for r in rows:
        r.attempts, r.error, r.status = attempts, err, "failed"
    db.commit()
    owner = (getattr(wf, "owner_email", "") or "").lower() if wf is not None else ""
    if owner:
        from workflows import engine
        from workflows.context import person_name
        what = "text" if rows[0].channel == "sms" else "email"
        engine._bell(db, [owner], f"wf-message-failed:{wf.id}", "Workflow Message Not Sent",
                     f"The {what} from \"{wf.name or 'a workflow'}\" to {person_name(db, rows[0].recipient)} "
                     f"was not sent: {str(e)[:160]}", company=wf.company_id or "")
        db.commit()


def purge(db, now: Optional[datetime] = None) -> int:
    """Sent and failed rows go after KEEP_DAYS (the daily limit needs one)."""
    M = models.WorkflowMessage
    old = _iso((now or now_utc()) - timedelta(days=KEEP_DAYS))
    return (db.query(M).filter(M.status.in_(("sent", "failed")), M.created_at < old)
            .delete(synchronize_session=False))
