"""HTML email templates for the Ticket Notification workflow (Jul 2026).

One shared "ticket card" shell (branding block, status badge, details grid,
one CTA button, disclaimer footer) - matches the visual language of the
existing alert email in routers/notifications.py (_alert_html: dark-green
NEXUS header, inline styles only since email clients ignore <style> sheets)
so ticket emails look like they come from the same system. Per-event
functions below just supply the heading/rows/CTA; nobody building a new
notification should hand-roll HTML.
"""
from html import escape

TICKET_STATUS_META = {
    "new":         {"label": "New",         "color": "#2563eb"},
    "open":        {"label": "Open",        "color": "#7c3aed"},
    "in_progress": {"label": "In progress", "color": "#d97706"},
    "on_hold":     {"label": "On hold",     "color": "#6b7280"},
    "resolved":    {"label": "Resolved",    "color": "#16a34a"},
    "closed":      {"label": "Closed",      "color": "#9ca3af"},
    "reopened":    {"label": "Reopened",    "color": "#dc2626"},
}
PRIORITY_LABEL = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}


def _status_badge(status: str) -> str:
    m = TICKET_STATUS_META.get(status, {"label": status.title() if status else "-", "color": "#6b7280"})
    return (
        f"<span style='display:inline-block;padding:4px 12px;border-radius:999px;"
        f"background:{m['color']}1a;color:{m['color']};font-size:12px;font-weight:700;"
        f"letter-spacing:.02em'>{escape(m['label'])}</span>"
    )


def _rows_table(rows: list[tuple[str, str]]) -> str:
    trs = "".join(
        f"<tr>"
        f"<td style='padding:8px 0;border-bottom:1px solid #f0f1f3;font-size:12.5px;"
        f"color:#6b7280;width:150px;vertical-align:top'>{escape(label)}</td>"
        f"<td style='padding:8px 0;border-bottom:1px solid #f0f1f3;font-size:13.5px;"
        f"color:#1f2937;vertical-align:top'>{escape(str(value)) if value not in (None, '') else '-'}</td>"
        f"</tr>"
        for label, value in rows
    )
    return f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;margin:14px 0'>{trs}</table>"


def ticket_email_html(*, ticket_code: str, ticket_subject: str, status: str, heading: str,
                       intro: str, rows: list[tuple[str, str]], cta_label: str, cta_url: str,
                       secondary_ctas: list[tuple[str, str]] | None = None,
                       note: str = "", logo_url: str = "",
                       comment_label: str = "", comment_text: str = "",
                       thread: list[dict] | None = None) -> str:
    logo_block = (
        f"<img src='{escape(logo_url)}' alt='Company logo' height='28' style='display:block' />"
        if logo_url else
        "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:4px'>NEXUS</span>"
    )
    secondary_html = ""
    if secondary_ctas:
        links = "&nbsp;&nbsp;·&nbsp;&nbsp;".join(
            f"<a href='{escape(url)}' style='color:#2563eb;text-decoration:none;font-size:13px;font-weight:600'>{escape(label)}</a>"
            for label, url in secondary_ctas
        )
        secondary_html = f"<p style='margin:14px 0 0;text-align:center'>{links}</p>"
    note_html = f"<p style='margin:14px 0 0;font-size:12.5px;color:#6b7280;font-style:italic'>{escape(note)}</p>" if note else ""
    # Full-width comment block - deliberately NOT a table row: comments can be
    # long, so they get their own quote box with the full text (pre-wrap keeps
    # the author's line breaks) at a readable size.
    comment_html = ""
    if comment_text:
        comment_html = f"""
    <tr>
      <td style="padding:0 28px 18px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;margin:0 0 6px">{escape(comment_label or 'Latest comment')}</div>
        <div style="background:#f3f4f6;border-left:3px solid #0f3d2e;border-radius:6px;padding:13px 16px;font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;word-break:break-word">{escape(comment_text)}</div>
      </td>
    </tr>"""

    return f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#0f3d2e;padding:18px 28px">{logo_block}</td>
    </tr>
    <tr>
      <td style="padding:26px 28px 8px">
        <div style="font-size:11.5px;color:#9ca3af;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">
          Ticket {escape(ticket_code or '')}
        </div>
        <h2 style="margin:0 0 10px;font-size:19px;color:#111827;line-height:1.35">{escape(ticket_subject or '')}</h2>
        {_status_badge(status)}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 28px 6px">
        <h3 style="margin:0 0 8px;font-size:15px;color:#111827">{escape(heading)}</h3>
        <p style="margin:0;font-size:13.5px;line-height:1.6;color:#374151">{escape(intro)}</p>
        {_rows_table(rows) if rows else ''}
      </td>
    </tr>{_conversation_html(thread) if thread else comment_html}
    <tr>
      <td style="padding:4px 28px 28px;text-align:center">
        <a href="{escape(cta_url)}" style="display:inline-block;background:#0f3d2e;color:#ffffff;text-decoration:none;
          font-size:13.5px;font-weight:700;padding:11px 28px;border-radius:8px">{escape(cta_label)}</a>
        {secondary_html}
        {note_html}
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
        This is an automated notification from the Ticket Management System. Please open the ticket using the link above to provide updates or responses.
      </td>
    </tr>
  </table>
</div>"""


def _initials(name: str) -> str:
    parts = [p for p in (name or "").replace("@", " ").split() if p]
    return ((parts[0][0] + (parts[1][0] if len(parts) > 1 else "")) if parts else "?").upper()


def _avatar_html(name: str, photo_url: str) -> str:
    """36px round avatar: the person's Nexus People photo when they have one
    (public bucket URLs embed directly), otherwise an initials circle. Outlook's
    Word engine ignores border-radius (square avatar) - acceptable fallback."""
    if photo_url:
        return (f"<img src='{escape(photo_url)}' width='36' height='36' alt='{escape(_initials(name))}' "
                "style='display:block;width:36px;height:36px;border-radius:50%;object-fit:cover;background:#e5e7eb' />")
    return ("<div style='width:36px;height:36px;border-radius:50%;background:#0f3d2e;color:#ffffff;"
            "font-size:13px;font-weight:700;text-align:center;line-height:36px'>"
            f"{escape(_initials(name))}</div>")


def _conversation_html(thread: list[dict]) -> str:
    """Zendesk-style thread: newest first, avatar + name + timestamp + full body."""
    items = []
    for i, c in enumerate(thread):
        divider = "border-top:1px solid #e5e7eb;" if i else ""
        items.append(f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="{divider}">
          <tr>
            <td width="48" valign="top" style="padding:14px 12px 0 0">{_avatar_html(c.get('name', ''), c.get('photoUrl', ''))}</td>
            <td valign="top" style="padding:12px 0 14px">
              <div style="font-size:13.5px;color:#111827"><strong>{escape(c.get('name', ''))}</strong>
                <span style="color:#9ca3af;font-size:11.5px;font-weight:400">&nbsp;&nbsp;{escape(c.get('at', ''))}</span></div>
              <div style="margin-top:5px;font-size:14px;line-height:1.6;color:#1f2937;white-space:pre-wrap;word-break:break-word">{escape(c.get('body', ''))}</div>
            </td>
          </tr>
        </table>""")
    return f"""
    <tr>
      <td style="padding:8px 28px 6px">{''.join(items)}</td>
    </tr>"""


def _ticket_url(base_url: str, ticket_id: str) -> str:
    # Matches App.jsx's parsePath() - /<view-path>/<sub>, e.g. /tasks/tickets -
    # plus a ?ticket= query param that TicketsView.jsx reads once on mount to
    # auto-open that ticket (then strips it from the URL).
    base = (base_url or "").rstrip("/")
    return f"{base}/tasks/tickets?ticket={ticket_id}" if base else "#"


# ── Per-event builders - each returns (subject, html) ────────────────────────

COMPANY_NAME = "Nexus"


def _ticket_subject(t: dict) -> str:
    """Uniform subject across every ticket email: Ticket No - Company ("Title") -
    State. State is always the ticket's current status, not the event that
    triggered the email - the event/heading lives in the email body instead."""
    company = t.get("companyName") or COMPANY_NAME
    status_label = TICKET_STATUS_META.get(t["status"], {}).get("label", t["status"])
    return f'{t["code"]} - {company} ("{t["subject"]}") - {status_label}'


def created_email_requester(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _ticket_subject(t)
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="Your ticket has been submitted",
        intro="Thanks - we've received your request and it's now in the queue for triage.",
        rows=[
            ("Description", t.get("description") or "-"),
            ("Department", t.get("departmentName") or "-"),
            ("Category", t.get("typeLabel") or "-"),
            ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
            ("Created by", t.get("requesterName") or t.get("requesterId")),
            ("Created", t.get("createdAtDisplay") or "-"),
            ("Status", TICKET_STATUS_META.get(t["status"], {}).get("label", t["status"])),
        ],
        cta_label="View Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def created_email_dept_head(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _ticket_subject(t)
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="A new ticket needs to be assigned",
        intro="This ticket was raised against your department and is waiting for someone to be assigned to it.",
        rows=[
            ("Description", t.get("description") or "-"),
            ("Department", t.get("departmentName") or "-"),
            ("Category", t.get("typeLabel") or "-"),
            ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
            ("Created by", t.get("requesterName") or t.get("requesterId")),
            ("Created", t.get("createdAtDisplay") or "-"),
        ],
        cta_label="Assign Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def approval_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _ticket_subject(t)
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="This ticket is waiting for your approval",
        intro="You are listed as the approver for this request. Please review it and approve or reject so work can proceed.",
        rows=[
            ("Description", t.get("description") or "-"),
            ("Department", t.get("departmentName") or "-"),
            ("Category", t.get("typeLabel") or "-"),
            ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
            ("Requested by", t.get("requesterName") or t.get("requesterId")),
            ("Created", t.get("createdAtDisplay") or "-"),
        ],
        cta_label="Review & Approve", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def assigned_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = _ticket_subject(t)
    intro = (
        "You've been assigned this ticket - please review and take action."
        if audience == "assignee" else
        f"This ticket has been assigned to {t.get('assigneeName') or t.get('assigneeId')}."
    )
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="Ticket assigned" if audience != "assignee" else "You've been assigned a ticket",
        intro=intro,
        rows=[
            ("Department", t.get("departmentName") or "-"),
            ("Assigned to", f"{t.get('assigneeName') or t.get('assigneeId')} ({t.get('assigneeId')})"),
            ("Assigned by", t.get("actorName") or t.get("actorEmail")),
            ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
            ("Assigned", t.get("eventAtDisplay") or "-"),
            ("Status", TICKET_STATUS_META.get(t["status"], {}).get("label", t["status"])),
            ("Due date", t.get("dueDateDisplay") or "-"),
        ],
        cta_label="Open Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if audience == "assignee" else "",
    )
    return subject, html


def update_email(*, t: dict, base_url: str, logo_url: str, update_kind: str,
                  prev_status: str = "", latest_comment: str = "",
                  thread: list[dict] | None = None) -> tuple[str, str]:
    actor = t.get("actorName") or t.get("actorEmail")
    # Comment updates render Zendesk-style: the conversation thread (avatars from
    # Nexus People, full bodies, newest first) replaces the details table.
    if thread:
        subject = _ticket_subject(t)
        html = ticket_email_html(
            ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
            heading=f"{actor} replied to this ticket",
            intro="Open the ticket to respond - the latest conversation is below.",
            rows=[], cta_label="View Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
            thread=thread,
        )
        return subject, html
    subject = _ticket_subject(t)
    # No "Update" row - the intro line already says what changed. Comments get
    # their own full-width block below the table instead of a cramped row.
    rows = [
        ("Previous status", TICKET_STATUS_META.get(prev_status, {}).get("label", prev_status) if prev_status else "-"),
        ("Updated status", TICKET_STATUS_META.get(t["status"], {}).get("label", t["status"])),
        ("Updated by", actor),
        ("Updated", t.get("eventAtDisplay") or "-"),
        ("Current assignee", t.get("assigneeName") or t.get("assigneeId") or "Unassigned"),
    ]
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="Your ticket has an update",
        intro=f"{actor} made a change to this ticket: {update_kind}.",
        rows=rows, cta_label="View Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
        comment_label=f"Latest comment - {actor}" if latest_comment else "",
        comment_text=latest_comment,
    )
    return subject, html


def resolved_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = _ticket_subject(t)
    secondary = None
    note = ""
    if audience == "requester":
        secondary = [
            ("Reopen Ticket", _ticket_url(base_url, t["id"])),
            ("Provide Feedback", _ticket_url(base_url, t["id"])),
        ]
        note = (f"This ticket will stay Resolved and auto-close in {t['autoCloseDays']} day(s) "
                f"if you don't reopen it - or you can confirm/close it now from the ticket."
                if t.get("autoCloseDays") else
                "Reopen the ticket from the link above if this didn't fully resolve your issue.")
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="This ticket has been resolved",
        intro="Here's a summary of the resolution.",
        rows=[
            ("Resolution", t.get("resolutionLabel") or "-"),
            ("Resolution notes", t.get("description") or "-"),
            ("Resolved by", t.get("actorName") or t.get("actorEmail")),
            ("Resolved", t.get("eventAtDisplay") or "-"),
            ("Total resolution time", t.get("resolutionDuration") or "-"),
        ],
        cta_label="Confirm Resolution" if audience == "requester" else "Review Ticket",
        cta_url=_ticket_url(base_url, t["id"]), secondary_ctas=secondary, note=note, logo_url=logo_url,
    )
    return subject, html


def reopened_email(*, t: dict, base_url: str, logo_url: str, reason: str = "") -> tuple[str, str]:
    subject = _ticket_subject(t)
    html = ticket_email_html(
        ticket_code=t["code"], ticket_subject=t["subject"], status=t["status"],
        heading="This ticket has been reopened",
        intro=f"{t.get('actorName') or t.get('actorEmail')} reopened this ticket - it needs another look.",
        rows=[
            ("Reason", reason or "No reason given"),
            ("Reopened by", t.get("actorName") or t.get("actorEmail")),
            ("Reopened", t.get("eventAtDisplay") or "-"),
            ("Current assignee", t.get("assigneeName") or t.get("assigneeId") or "Unassigned"),
            ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
        ],
        cta_label="Open Ticket", cta_url=_ticket_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required.",
    )
    return subject, html
