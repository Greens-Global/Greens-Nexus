"""HTML email templates for the Task Notification workflow (Jul 2026) — same
shell and visual language as ticket_mail_templates.py (dark-green NEXUS
header, inline styles only since email clients ignore <style> sheets), so
task emails look like they come from the same system. Per-event functions
below just supply the heading/rows/CTA; nobody building a new notification
should hand-roll HTML.
"""
from html import escape

STATUS_META = {
    "not_started": {"label": "Not started", "color": "#6b7280"},
    "in_progress": {"label": "In progress", "color": "#d97706"},
    "completed":   {"label": "Completed",   "color": "#16a34a"},
    "recurring":   {"label": "Recurring",   "color": "#7c3aed"},
}
PRIORITY_LABEL = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}


def _status_badge(status: str) -> str:
    m = STATUS_META.get(status, {"label": (status or "—").replace("_", " ").title(), "color": "#6b7280"})
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
        f"color:#1f2937;vertical-align:top'>{escape(str(value)) if value not in (None, '') else '—'}</td>"
        f"</tr>"
        for label, value in rows
    )
    return f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;margin:14px 0'>{trs}</table>"


def task_email_html(*, task_code: str, task_title: str, status: str, heading: str,
                    intro: str, rows: list[tuple[str, str]], cta_label: str, cta_url: str,
                    secondary_ctas: list[tuple[str, str]] | None = None,
                    note: str = "", logo_url: str = "") -> str:
    logo_block = (
        f"<img src='{escape(logo_url)}' alt='Company logo' height='28' style='display:block' />"
        if logo_url else
        "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:4px'>NEXUS</span>"
        "<span style='color:#9fd6b8;font-size:11px;letter-spacing:1.5px;float:right;line-height:28px'>GREENS GLOBAL</span>"
    )
    secondary_html = ""
    if secondary_ctas:
        links = "&nbsp;&nbsp;·&nbsp;&nbsp;".join(
            f"<a href='{escape(url)}' style='color:#2563eb;text-decoration:none;font-size:13px;font-weight:600'>{escape(label)}</a>"
            for label, url in secondary_ctas
        )
        secondary_html = f"<p style='margin:14px 0 0;text-align:center'>{links}</p>"
    note_html = f"<p style='margin:14px 0 0;font-size:12.5px;color:#6b7280;font-style:italic'>{escape(note)}</p>" if note else ""

    return f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#0f3d2e;padding:18px 28px">{logo_block}</td>
    </tr>
    <tr>
      <td style="padding:26px 28px 8px">
        <div style="font-size:11.5px;color:#9ca3af;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">
          Task {escape(task_code or '')}
        </div>
        <h2 style="margin:0 0 10px;font-size:19px;color:#111827;line-height:1.35">{escape(task_title or '')}</h2>
        {_status_badge(status)}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 28px 6px">
        <h3 style="margin:0 0 8px;font-size:15px;color:#111827">{escape(heading)}</h3>
        <p style="margin:0;font-size:13.5px;line-height:1.6;color:#374151">{escape(intro)}</p>
        {_rows_table(rows)}
      </td>
    </tr>
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
        This is an automated notification from the Task Management System. Please open the task using the link above to provide updates or responses.
      </td>
    </tr>
  </table>
</div>"""


def _task_url(base_url: str, task_id: str) -> str:
    # Matches App.jsx's parsePath() — /<view-path>/<sub> — plus a ?task= query
    # param TasksWorkspace.jsx reads once on mount to auto-open that task.
    base = (base_url or "").rstrip("/")
    return f"{base}/tasks/mine?task={task_id}" if base else "#"


def _common_rows(t: dict) -> list[tuple[str, str]]:
    return [
        ("Project", t.get("projectName") or "—"),
        ("Assignee", t.get("assigneeName") or "Unassigned"),
        ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
        ("Due date", t.get("dueDateDisplay") or "—"),
    ]


# ── Per-event builders — each returns (subject, html) ────────────────────────

def created_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] New Task – {t['code']} – {t['title']}"
    intro = (
        "A new task was created and assigned to you."
        if audience == "assignee" else
        f"{t.get('actorName') or t.get('actorEmail')} created a new task you're following."
    )
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="New task" if audience != "assignee" else "You have a new task",
        intro=intro,
        rows=[
            ("Description", (t.get("description") or "—")[:400]),
            *_common_rows(t),
            ("Created by", t.get("actorName") or t.get("actorEmail")),
            ("Created", t.get("eventAtDisplay") or "—"),
        ],
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if audience == "assignee" else "",
    )
    return subject, html


def assigned_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] Task Assigned – {t['code']} – Assigned to {t.get('assigneeName') or t.get('assigneeId')}"
    intro = (
        "You've been assigned this task — please review and take action."
        if audience == "assignee" else
        f"This task has been assigned to {t.get('assigneeName') or t.get('assigneeId')}."
    )
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="You've been assigned a task" if audience == "assignee" else "Task assigned",
        intro=intro,
        rows=[
            *_common_rows(t),
            ("Assigned by", t.get("actorName") or t.get("actorEmail")),
            ("Assigned", t.get("eventAtDisplay") or "—"),
        ],
        cta_label="Open Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if audience == "assignee" else "",
    )
    return subject, html


def due_reminder_email(*, t: dict, base_url: str, logo_url: str, days_left: int) -> tuple[str, str]:
    overdue = days_left < 0
    if overdue:
        subject = f"[Task {t['code']}] Overdue – {t['code']} – {t['title']}"
        heading = "This task is overdue"
        intro = f"This task was due {t.get('dueDateDisplay') or 'earlier'} and is still not completed."
    elif days_left == 0:
        subject = f"[Task {t['code']}] Due Today – {t['code']} – {t['title']}"
        heading = "This task is due today"
        intro = "This task is due today — make sure it's on track."
    else:
        subject = f"[Task {t['code']}] Due Soon – {t['code']} – {t['title']}"
        heading = f"This task is due in {days_left} day{'s' if days_left != 1 else ''}"
        intro = f"Reminder: this task is due {t.get('dueDateDisplay') or 'soon'}."
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading=heading, intro=intro,
        rows=_common_rows(t),
        cta_label="Open Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if overdue else "",
    )
    return subject, html


def completed_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] Task Completed – {t['code']} – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="This task has been completed",
        intro=f"{t.get('actorName') or t.get('actorEmail')} marked this task as complete.",
        rows=[
            *_common_rows(t),
            ("Completed by", t.get("actorName") or t.get("actorEmail")),
            ("Completed", t.get("eventAtDisplay") or "—"),
        ],
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def mentioned_email(*, t: dict, base_url: str, logo_url: str, comment_body: str,
                    actor_name: str = "") -> tuple[str, str]:
    """Someone @mentioned this person in a task comment. Deliberately distinct
    from commented_email: a mention is addressed AT you, so it names who did it
    in the subject, where the comment mail is an FYI to assignees and followers."""
    who = actor_name or t.get("actorName") or t.get("actorEmail") or "Someone"
    subject = f"[Task {t['code']}] {who} mentioned you – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="You were mentioned in a comment",
        intro=f"{who} mentioned you on this task.",
        rows=[
            ("Comment", (comment_body or "—")[:500]),
            *_common_rows(t),
        ],
        cta_label="View Comment", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def commented_email(*, t: dict, base_url: str, logo_url: str, comment_body: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] New Comment – {t['code']} – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="New comment on your task",
        intro=f"{t.get('actorName') or t.get('actorEmail')} commented on this task.",
        rows=[
            ("Comment", (comment_body or "—")[:500]),
            *_common_rows(t),
        ],
        cta_label="View Comment", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def follower_added_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] Added as Collaborator – {t['code']} – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="You've been added to a task",
        intro=f"{t.get('actorName') or t.get('actorEmail')} added you as a collaborator on this task — you'll now get updates on it.",
        rows=_common_rows(t),
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def modified_email(*, t: dict, base_url: str, logo_url: str, update_kind: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] Task Updated – {t['code']} – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t["status"],
        heading="Your task has an update",
        intro=f"{t.get('actorName') or t.get('actorEmail')} made a change to this task: {update_kind}.",
        rows=[
            ("Update", update_kind),
            *_common_rows(t),
            ("Updated by", t.get("actorName") or t.get("actorEmail")),
            ("Updated", t.get("eventAtDisplay") or "—"),
        ],
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def deleted_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = f"[Task {t['code']}] Task Deleted – {t['code']} – {t['title']}"
    html = task_email_html(
        task_code=t["code"], task_title=t["title"], status=t.get("status") or "not_started",
        heading="A task you were on has been deleted",
        intro=f"{t.get('actorName') or t.get('actorEmail')} deleted this task — no further action is needed.",
        rows=[
            ("Project", t.get("projectName") or "—"),
            ("Deleted by", t.get("actorName") or t.get("actorEmail")),
            ("Deleted", t.get("eventAtDisplay") or "—"),
        ],
        cta_label="Go to Tasks", cta_url=(base_url or "#").rstrip("/") + "/tasks/mine", logo_url=logo_url,
    )
    return subject, html
