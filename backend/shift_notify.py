"""Shift notifications (Sep 28 2026 - Shifts QA gap list, item 2).

Nexus Shifts never told anyone anything: a manager could publish, change or
remove someone's shift and the person only found out by opening the schedule.
Teams Shifts tells the people affected.

  Schedule published (notify_published, called from
  routers/timeclock.publish_schedule): everyone whose shifts were added,
  changed or removed by that publish gets ONE bell notification and ONE email
  listing exactly their changes - never one per shift, never the whole team,
  and never the person who pressed Publish. The emails go out after the
  response (BackgroundTasks), so publishing a big team stays fast.

  The "Your shift starts at ..." bell reminder that used to live here was
  removed on Oct 12 2026 (Neil): bell-only, it was seen only by someone who
  had already opened Nexus - at work - and the Daily Briefing already goes
  out before the shift and lists it. Do not bring it back.

  Shifts Phase 3a (Oct 14 2026): when the person's company asks people to
  confirm a shared schedule (confirmRequests, shift_confirm.py), the bell
  and the email also say "Confirm you have seen it" and open My Shifts on
  that publish; the ask is recorded (shift_confirm.ask) so a manager can
  see who has not.
"""
import json
import uuid
from datetime import datetime, timezone
from html import escape

from sqlalchemy.orm import Session

import models
from app_url import app_url
from notify_company import notification_company

_DEFAULT_TZ = "America/Los_Angeles"
# My Shifts lives in the Shifts module now (Sep 29), not a Workday tab.
MY_SHIFTS_ACTION = {"view": "shifts", "sub": "mine"}


def _t12(hhmm: str) -> str:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
    except ValueError:
        return hhmm or ""
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _day(iso: str) -> str:
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%a')}, {d.strftime('%m/%d/%Y')}"


def _us(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


# ── Schedule published ────────────────────────────────────────────────────

def change(kind: str, row, *, start: str, end: str, label: str, was: tuple = None) -> dict:
    """One line of what a publish did to a person's schedule. `kind` is
    added | changed | removed; `was` = (start, end, label) before a change."""
    return {"kind": kind, "email": (row.employee_email or "").lower(), "date": row.work_date,
            "start": start, "end": end, "label": label or "", "was": was,
            "shift_id": getattr(row, "id", "") or ""}   # for the Outlook sync queue (Phase 3a)


def _summary(items: list) -> str:
    counts = {k: sum(1 for i in items if i["kind"] == k) for k in ("added", "changed", "removed")}
    bits = []
    if counts["added"]:
        bits.append(f"{counts['added']} new")
    if counts["changed"]:
        bits.append(f"{counts['changed']} changed")
    if counts["removed"]:
        bits.append(f"{counts['removed']} removed")
    return ", ".join(bits)


def _row_html(i: dict) -> str:
    shift = f"{_t12(i['start'])} - {_t12(i['end'])}" + (f" &middot; {escape(i['label'])}" if i["label"] else "")
    if i["kind"] == "added":
        what = "<span style='color:#15803d;font-weight:600'>New</span>"
    elif i["kind"] == "removed":
        what = "<span style='color:#b91c1c;font-weight:600'>Removed</span>"
        shift = f"<span style='text-decoration:line-through;color:#6b7280'>{shift}</span>"
    else:
        ws, we, wl = i["was"] or ("", "", "")
        before = f"{_t12(ws)} - {_t12(we)}" + (f" &middot; {escape(wl)}" if wl else "")
        what = f"<span style='color:#b45309;font-weight:600'>Changed</span><br><span style='color:#6b7280;font-size:12px'>was {before}</span>"
    td = "padding:10px 12px;border-top:1px solid #e5e7eb;font-size:13.5px;vertical-align:top"
    return (f"<tr><td style='{td};white-space:nowrap;font-weight:600'>{escape(_day(i['date']))}</td>"
            f"<td style='{td}'>{shift}</td><td style='{td}'>{what}</td></tr>")


def email_html(first_name: str, items: list, actor_name: str, confirm_id: str = "") -> tuple:
    """(subject, html) for one person's published changes. Uses the saved
    email theme (header color/logo/footer) like every other Nexus email.
    `confirm_id` (a publish id) adds the "Confirm you have seen it" ask
    with a button that opens My Shifts on that publish (Phase 3a)."""
    import email_theme
    theme = email_theme.current()
    items = sorted(items, key=lambda i: (i["date"], i["start"]))
    n = len(items)
    subject = f"Your schedule was updated - {_plural(n, 'change')}"
    band = theme.color("#0f3d2e")
    url = f"{app_url()}/shifts/mine"
    hello = f"Hi {escape(first_name)}," if first_name else "Hi,"
    who = escape(actor_name) if actor_name else "Your manager"
    rows = "".join(_row_html(i) for i in items)
    th = "padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#374151;text-align:left;background:#f9fafb"
    confirm = ""
    if confirm_id:
        import shift_confirm
        curl = escape(shift_confirm.confirm_url(confirm_id))
        confirm = (f"<div style='font-size:14px;line-height:1.55;color:#374151;margin-bottom:12px'>"
                   f"Please confirm you have seen it.</div>"
                   f"<a href=\"{curl}\" style=\"display:inline-block;padding:10px 22px;border-radius:4px;background:{band};"
                   f"color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;margin-right:10px\">Confirm You Have Seen It</a>")
    # A client that strips buttons to text still gets somewhere to click.
    plain = (f"<div style='font-size:11.5px;line-height:1.5;color:#6b7280;margin-top:12px'>"
             f"If the button does not work, open this link: {curl}</div>") if confirm_id else ""
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">Your Schedule Was Updated</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{hello} {who} published {_plural(n, 'change')} to your shifts.</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse">
        <tr><th style="{th}">Date</th><th style="{th}">Shift</th><th style="{th}">Change</th></tr>{rows}
      </table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      {confirm}<a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{'#374151' if confirm else band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open My Shifts</a>
      {plain}
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this email when a manager publishes a change to your shifts in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return subject, html


def _send_emails(batch: list) -> None:
    """Runs after the publish response (BackgroundTasks). One failure never
    stops the rest; the bell notification is already there either way."""
    import graph_mail
    for to, subject, html in batch:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None,
                                 subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - never fail the batch for one address
            print(f"[shift-notify] schedule email to {to} failed: {e}")


def _upsert_bell(db: Session, recipient: str, ref_id: str, title: str, body: str, actor: str, now: str,
                 action: dict = None) -> None:
    """ONE notification per (person, ref_id), updated in place (Oct 2, B4-33:
    five publishes of a week were five bells and five emails). An unread,
    un-actioned row for the same key is refreshed - new text, back to the
    top, unread again; a row the person already dealt with stays as history
    and a new one is added. `action` defaults to My Shifts."""
    act = json.dumps(action or MY_SHIFTS_ACTION)
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is not None:
        row.title, row.body, row.requested_by, row.created_at, row.read_by = title, body, actor, now, ""
        row.action = act
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient, title=title, body=body,
        ref_id=ref_id, item_name="", requested_by=actor,
        action=act, actioned=False, read_by="",
        company=notification_company(db, actor, recipient), created_at=now))


def notify_published(db: Session, changes: list, actor_email: str, d0: str, d1: str, bt=None,
                     publish_id: str = "") -> int:
    """One bell + one email per affected person. Returns how many people were
    notified. Commits the bell rows; emails are queued on `bt` when given.
    The bell is one row per (person, date range), updated in place.

    With a `publish_id` (Phase 3a), a person whose company asks for
    confirmations is asked here: the bell and email say so and open My
    Shifts on that publish, and shift_confirm.ask records it."""
    actor = (actor_email or "").lower()
    by_person: dict = {}
    for c in changes:
        if c["email"] and c["email"] != actor:
            by_person.setdefault(c["email"], []).append(c)
    if not by_person:
        return 0
    people = {(e.work_email or "").lower(): e for e in
              db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").all()}
    actor_emp = people.get(actor)
    actor_name = f"{actor_emp.first_name or ''} {actor_emp.last_name or ''}".strip() if actor_emp else ""
    now = datetime.now(timezone.utc).isoformat()
    batch = []
    import shift_confirm
    asks_by_company: dict = {}   # company -> confirmRequests, looked up once per company
    for em, items in by_person.items():
        dates = sorted(i["date"] for i in items)
        span = _us(dates[0]) if dates[0] == dates[-1] else f"{_us(dates[0])} - {_us(dates[-1])}"
        emp = people.get(em)
        company = (emp.company or "") if emp is not None else ""
        ask = False
        if publish_id:
            if company not in asks_by_company:
                asks_by_company[company] = shift_confirm.wants_confirm(db, company)
            ask = asks_by_company[company]
        body = f"{_summary(items).capitalize()} ({span})."
        if ask:
            shift_confirm.ask(db, publish_id, em)
            body += " Confirm you have seen it."
        _upsert_bell(db, em, f"schedule-publish:{d0}:{d1}", "Your schedule was updated", body, actor, now,
                     action=shift_confirm.confirm_action(publish_id) if ask else None)
        if emp is not None and (emp.status or "active") == "active":
            batch.append((em, *email_html((emp.first_name or "").strip(), items, actor_name,
                                          confirm_id=publish_id if ask else "")))
    db.commit()
    if batch and bt is not None:
        import graph_mail
        if graph_mail.graph_configured():
            bt.add_task(_send_emails, batch)
    return len(by_person)


def notify_team(db: Session, emails: set, actor_email: str, d0: str, d1: str) -> int:
    """Publish with "notify the whole team" (Sep 29, Teams parity): everyone
    else with a shift in the published range gets one short bell - their own
    schedule did not change, so no email. Commits; returns how many."""
    actor = (actor_email or "").lower()
    span = _us(d0) if d0 == d1 else f"{_us(d0)} - {_us(d1)}"
    now = datetime.now(timezone.utc).isoformat()
    n = 0
    for em in sorted(e for e in emails if e and e != actor):
        _upsert_bell(db, em, f"schedule-publish-team:{d0}:{d1}", "Schedule published",
                     f"The schedule for {span} was published. Open My Shifts to see yours.", actor, now)
        n += 1
    db.commit()
    return n
