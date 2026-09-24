"""HTML email templates for the Task Notification workflow (Jul 2026) - same
shell and visual language as ticket_mail_templates.py (dark-green Greens Global
header, inline styles only since email clients ignore <style> sheets), so
task emails look like they come from the same system. Per-event functions
below just supply the heading/rows/CTA; nobody building a new notification
should hand-roll HTML.
"""
from html import escape

from mail_text import Rich, rich_to_email_html

STATUS_META = {
    "not_started": {"label": "Not started", "color": "#6b7280"},
    "in_progress": {"label": "In progress", "color": "#d97706"},
    "completed":   {"label": "Completed",   "color": "#16a34a"},
    "recurring":   {"label": "Recurring",   "color": "#7c3aed"},
}
PRIORITY_LABEL = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}


def _status_badge(status: str) -> str:
    m = STATUS_META.get(status, {"label": (status or "-").replace("_", " ").title(), "color": "#6b7280"})
    return (
        f"<span style='display:inline-block;padding:4px 12px;border-radius:999px;"
        f"background:{m['color']}1a;color:{m['color']};font-size:12px;font-weight:700;"
        f"letter-spacing:.02em'>{escape(m['label'])}</span>"
    )


def _cell(value) -> str:
    """A Rich value is already safe email HTML (mail_text.rich_to_email_html);
    anything else is escaped, so a row that forgets to convert stays safe."""
    if isinstance(value, Rich):
        return str(value) or "-"
    return escape(str(value)) if value not in (None, "") else "-"


def _rows_table(rows: list[tuple[str, str]]) -> str:
    trs = "".join(
        f"<tr>"
        f"<td style='padding:8px 0;border-bottom:1px solid #f0f1f3;font-size:12.5px;"
        f"color:#6b7280;width:150px;vertical-align:top'>{escape(label)}</td>"
        f"<td style='padding:8px 0;border-bottom:1px solid #f0f1f3;font-size:13.5px;"
        f"color:#1f2937;vertical-align:top'>"
        f"{_cell(value)}</td>"
        f"</tr>"
        for label, value in rows
    )
    return f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;margin:14px 0'>{trs}</table>"


def task_email_html(*, task_title: str, status: str, heading: str,
                    intro: str, rows: list[tuple[str, str]], cta_label: str, cta_url: str,
                    secondary_ctas: list[tuple[str, str]] | None = None,
                    note: str = "", logo_url: str = "") -> str:
    """No task code anywhere in the output. These mails used to lead with a
    "TASK TASK-1983" eyebrow above the title; the number means nothing to the
    recipient, and it is now hidden across the whole task module, so an email
    quoting one would be the only place it still leaked."""
    logo_block = (
        f"<img src='{escape(logo_url)}' alt='Company logo' height='28' style='display:block' />"
        if logo_url else
        "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px'>GREENS GLOBAL</span>"
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
        <a href="{escape(cta_url)}" style="display:inline-block;background:#248f4b;color:#ffffff;text-decoration:none;
          font-size:13.5px;font-weight:700;padding:11px 28px;border-radius:8px">{escape(cta_label)}</a>
        {secondary_html}
        <!--NEXUS-MAIL-ACTIONS-->
        {note_html}
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
        This is an automated notification from the Task Management System. Use the buttons above, or open the task, to provide updates or responses.
        <!--NEXUS-MAIL-FOOTER-->
      </td>
    </tr>
  </table>
</div>"""


def _task_url(base_url: str, task_id: str) -> str:
    # Matches App.jsx's parsePath() - /<view-path>/<sub> - plus a ?task= query
    # param TasksWorkspace.jsx reads once on mount to auto-open that task.
    base = (base_url or "").rstrip("/")
    return f"{base}/tasks/mine?task={task_id}" if base else "#"


def _common_rows(t: dict) -> list[tuple[str, str]]:
    return [
        ("Project", t.get("projectName") or "-"),
        ("Assignee", t.get("assigneeName") or "Unassigned"),
        ("Priority", PRIORITY_LABEL.get(t.get("priority"), t.get("priority"))),
        ("Due date", t.get("dueDateDisplay") or "-"),
    ]


# ── Per-event builders - each returns (subject, html) ────────────────────────

# What the RECIPIENT should recognise, which is the company - not the internal
# product name. Most people who get one of these do not think of the tool as
# "Nexus" at all. Kept here rather than imported from the ticket templates: the
# two modules format their subjects differently on purpose, and sharing a symbol
# would invite someone to "align" them again.
COMPANY_NAME = "Greens Global"


def _task_subject(t: dict, state: str) -> str:
    """One shape for every task email: [Company] - Task Name - State.

    The task name leads because that is what the recipient recognizes in a full
    inbox; the old subject opened with the code twice ("[Task TASK-1983] Overdue
    - TASK-1983 - ...") and pushed the title past where most clients truncate.
    The code is no longer a fallback either - a titleless task says "Task", which
    is no less useful than "TASK-1983" to somebody who can't look the code up.
    Plain hyphens, never en/em dashes (CLAUDE.md)."""
    return f"[{COMPANY_NAME}] - {t.get('title') or 'Task'} - {state}"

def created_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = _task_subject(t, "New Task")
    intro = (
        "A new task was created and assigned to you."
        if audience == "assignee" else
        f"{t.get('actorName') or t.get('actorEmail')} created a new task you're following."
    )
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="New task" if audience != "assignee" else "You have a new task",
        intro=intro,
        rows=[
            ("Description", rich_to_email_html(t.get("description"))),
            *_common_rows(t),
            ("Created by", t.get("actorName") or t.get("actorEmail")),
            ("Created", t.get("eventAtDisplay") or "-"),
        ],
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if audience == "assignee" else "",
    )
    return subject, html


def assigned_email(*, t: dict, base_url: str, logo_url: str, audience: str) -> tuple[str, str]:
    subject = _task_subject(t, "Assigned")
    intro = (
        "You've been assigned this task - please review and take action."
        if audience == "assignee" else
        f"This task has been assigned to {t.get('assigneeName') or t.get('assigneeId')}."
    )
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="You've been assigned a task" if audience == "assignee" else "Task assigned",
        intro=intro,
        rows=[
            *_common_rows(t),
            ("Assigned by", t.get("actorName") or t.get("actorEmail")),
            ("Assigned", t.get("eventAtDisplay") or "-"),
        ],
        cta_label="Open Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if audience == "assignee" else "",
    )
    return subject, html


def due_reminder_email(*, t: dict, base_url: str, logo_url: str, days_left: int) -> tuple[str, str]:
    overdue = days_left < 0
    if overdue:
        subject = _task_subject(t, "Overdue")
        heading = "This task is overdue"
        intro = f"This task was due {t.get('dueDateDisplay') or 'earlier'} and is still not completed."
    elif days_left == 0:
        subject = _task_subject(t, "Due Today")
        heading = "This task is due today"
        intro = "This task is due today - make sure it's on track."
    else:
        subject = _task_subject(t, "Due Soon")
        heading = f"This task is due in {days_left} day{'s' if days_left != 1 else ''}"
        intro = f"Reminder: this task is due {t.get('dueDateDisplay') or 'soon'}."
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading=heading, intro=intro,
        rows=_common_rows(t),
        cta_label="Open Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required." if overdue else "",
    )
    return subject, html


def recurring_email(*, t: dict, base_url: str, logo_url: str, due_today: bool) -> tuple[str, str]:
    """A recurring task's next occurrence has arrived (created on its scheduled
    date by the daily scan, see routers/tasks.spawn_scheduled_occurrences)."""
    subject = _task_subject(t, "Recurring - Due Today" if due_today else "Recurring - Due")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="Your recurring task is due today" if due_today else "Your recurring task is due",
        intro=("This task repeats on a schedule and today's occurrence is ready."
               if due_today else
               f"This task repeats on a schedule and its next occurrence is due {t.get('dueDateDisplay') or 'soon'}."),
        rows=_common_rows(t),
        cta_label="Open Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
        note="Action required.",
    )
    return subject, html


def completed_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _task_subject(t, "Completed")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="This task has been completed",
        intro=f"{t.get('actorName') or t.get('actorEmail')} marked this task as complete.",
        rows=[
            *_common_rows(t),
            ("Completed by", t.get("actorName") or t.get("actorEmail")),
            ("Completed", t.get("eventAtDisplay") or "-"),
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
    subject = _task_subject(t, f"{who} Mentioned You")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="You were mentioned in a comment",
        intro=f"{who} mentioned you on this task.",
        rows=[
            ("Comment", rich_to_email_html(comment_body, 500)),
            *_common_rows(t),
        ],
        cta_label="View Comment", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def commented_email(*, t: dict, base_url: str, logo_url: str, comment_body: str) -> tuple[str, str]:
    subject = _task_subject(t, "New Comment")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="New comment on your task",
        intro=f"{t.get('actorName') or t.get('actorEmail')} commented on this task.",
        rows=[
            ("Comment", rich_to_email_html(comment_body, 500)),
            *_common_rows(t),
        ],
        cta_label="View Comment", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def follower_added_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _task_subject(t, "Added as Collaborator")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="You've been added to a task",
        intro=f"{t.get('actorName') or t.get('actorEmail')} added you as a collaborator on this task - you'll now get updates on it.",
        rows=_common_rows(t),
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def modified_email(*, t: dict, base_url: str, logo_url: str, update_kind: str) -> tuple[str, str]:
    subject = _task_subject(t, "Updated")
    html = task_email_html(
        task_title=t["title"], status=t["status"],
        heading="Your task has an update",
        intro=f"{t.get('actorName') or t.get('actorEmail')} made a change to this task: {update_kind}.",
        rows=[
            ("Update", update_kind),
            *_common_rows(t),
            ("Updated by", t.get("actorName") or t.get("actorEmail")),
            ("Updated", t.get("eventAtDisplay") or "-"),
        ],
        cta_label="View Task", cta_url=_task_url(base_url, t["id"]), logo_url=logo_url,
    )
    return subject, html


def deleted_email(*, t: dict, base_url: str, logo_url: str) -> tuple[str, str]:
    subject = _task_subject(t, "Deleted")
    html = task_email_html(
        task_title=t["title"], status=t.get("status") or "not_started",
        heading="A task you were on has been deleted",
        intro=f"{t.get('actorName') or t.get('actorEmail')} deleted this task - no further action is needed.",
        rows=[
            ("Project", t.get("projectName") or "-"),
            ("Deleted by", t.get("actorName") or t.get("actorEmail")),
            ("Deleted", t.get("eventAtDisplay") or "-"),
        ],
        cta_label="Go to Tasks", cta_url=(base_url or "#").rstrip("/") + "/tasks/mine", logo_url=logo_url,
    )
    return subject, html


def reminder_digest_email(*, items: list[dict], base_url: str, logo_url: str,
                          recipient_name: str = "") -> tuple[str, str]:
    """ONE daily email listing every task that is overdue or due soon for this
    person (Sept 2026, per-person "daily summary" preference) - instead of one
    email per task, which is what flooded inboxes with many overdue tasks.

    items: [{"t": task ctx, "days_left": int, "links": html}] - `links` is the
    per-task action row (task_mail_actions.task_links_html). Overdue first,
    most overdue at the top; then due soon, soonest first."""
    overdue = sorted([i for i in items if i["days_left"] < 0], key=lambda i: i["days_left"])
    soon = sorted([i for i in items if i["days_left"] >= 0], key=lambda i: i["days_left"])
    counts = []
    if overdue:
        counts.append(f"{len(overdue)} Overdue")
    if soon:
        counts.append(f"{len(soon)} Due Soon")
    subject = f"[{COMPANY_NAME}] - Task Reminders - {', '.join(counts) or 'Summary'}"

    def when(i: dict) -> str:
        d = i["days_left"]
        if d < 0:
            return f"Overdue by {-d} day{'s' if d != -1 else ''}"
        if d == 0:
            return "Due today"
        return f"Due in {d} day{'s' if d != 1 else ''}"

    def section(title: str, rows: list[dict], color: str) -> str:
        if not rows:
            return ""
        trs = "".join(
            "<tr><td style='padding:12px 0;border-bottom:1px solid #f0f1f3'>"
            f"<a href='{escape(_task_url(base_url, i['t']['id']))}' style='font-size:14px;font-weight:700;"
            f"color:#111827;text-decoration:none'>{escape(i['t'].get('title') or 'Task')}</a>"
            f"<div style='font-size:12.5px;color:#6b7280;margin:3px 0 6px'>"
            f"<span style='color:{color};font-weight:700'>{escape(when(i))}</span>"
            f" &nbsp;·&nbsp; Due {escape(i['t'].get('dueDateDisplay') or '-')}"
            f"{' &nbsp;·&nbsp; ' + escape(i['t']['projectName']) if i['t'].get('projectName') else ''}</div>"
            f"<div>{i['links']}</div></td></tr>"
            for i in rows)
        return (f"<h3 style='margin:18px 0 4px;font-size:15px;color:{color}'>{escape(title)} ({len(rows)})</h3>"
                f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse'>{trs}</table>")

    logo_block = (
        f"<img src='{escape(logo_url)}' alt='Company logo' height='28' style='display:block' />"
        if logo_url else
        "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px'>GREENS GLOBAL</span>"
    )
    hello = f"Hi {escape(recipient_name.split(' ')[0])}," if recipient_name else "Hi,"
    html = f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr><td style="background:#0f3d2e;padding:18px 28px">{logo_block}</td></tr>
    <tr><td style="padding:24px 28px 8px">
      <h2 style="margin:0 0 8px;font-size:19px;color:#111827">Your task reminders</h2>
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:#374151">{hello} here is everything that needs your attention today, in one email.</p>
      {section("Overdue", overdue, "#b91c1c")}
      {section("Due Soon", soon, "#b45309")}
    </td></tr>
    <tr><td style="padding:10px 28px 26px;text-align:center">
      <a href="{escape((base_url or '#').rstrip('/') + '/tasks/mine')}" style="display:inline-block;background:#248f4b;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 28px;border-radius:8px">Open My Tasks</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
      You get one summary a day because of your email settings. Use the links under each task to act on it without opening Nexus.
      <!--NEXUS-MAIL-FOOTER-->
    </td></tr>
  </table>
</div>"""
    return subject, html


def batch_email(*, items: list[dict], base_url: str, logo_url: str, recipient_name: str = "",
                headline: str = "", window_minutes: int = 60) -> tuple[str, str]:
    """ONE email for everything that happened to a person's tasks within the
    batch window (Neil, Sep 24) - five assignments in a row arrive as one
    "Neil assigned you 5 tasks", not five separate emails.

    items: [{"t": task ctx, "lines": [str, ...], "links": html}] in the order
    things happened. `headline` is set when the whole batch is one person
    assigning work; otherwise the subject counts the tasks."""
    n = len(items)
    subject = (f"[{COMPANY_NAME}] - {headline}" if headline
               else f"[{COMPANY_NAME}] - {n} Task Update{'s' if n != 1 else ''}")
    trs = "".join(
        "<tr><td style='padding:12px 0;border-bottom:1px solid #f0f1f3'>"
        f"<a href='{escape(_task_url(base_url, i['t']['id']))}' style='font-size:14px;font-weight:700;"
        f"color:#111827;text-decoration:none'>{escape(i['t'].get('title') or 'Task')}</a>"
        f"<div style='font-size:12.5px;color:#6b7280;margin:3px 0 4px'>"
        f"{escape(PRIORITY_LABEL.get(i['t'].get('priority'), i['t'].get('priority') or ''))} priority"
        f" &nbsp;·&nbsp; Due {escape(i['t'].get('dueDateDisplay') or '-')}"
        f"{' &nbsp;·&nbsp; ' + escape(i['t']['projectName']) if i['t'].get('projectName') else ''}</div>"
        + "".join(f"<div style='font-size:13px;color:#374151;margin:2px 0'>&bull; {escape(line)}</div>"
                  for line in i["lines"])
        + f"<div style='margin-top:6px'>{i['links']}</div></td></tr>"
        for i in items)
    logo_block = (
        f"<img src='{escape(logo_url)}' alt='Company logo' height='28' style='display:block' />"
        if logo_url else
        "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px'>GREENS GLOBAL</span>"
    )
    hello = f"Hi {escape(recipient_name.split(' ')[0])}," if recipient_name else "Hi,"
    window = (f"{window_minutes // 60} hour{'s' if window_minutes >= 120 else ''}"
              if window_minutes % 60 == 0 else f"{window_minutes} minutes")
    html = f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr><td style="background:#0f3d2e;padding:18px 28px">{logo_block}</td></tr>
    <tr><td style="padding:24px 28px 8px">
      <h2 style="margin:0 0 8px;font-size:19px;color:#111827">{escape(headline or f"Updates on {n} task{'s' if n != 1 else ''}")}</h2>
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:#374151">{hello} here is what changed on your tasks, in one email.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:10px">{trs}</table>
    </td></tr>
    <tr><td style="padding:10px 28px 26px;text-align:center">
      <a href="{escape((base_url or '#').rstrip('/') + '/tasks/mine')}" style="display:inline-block;background:#248f4b;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 28px;border-radius:8px">Open My Tasks</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Task updates are gathered for up to {escape(window)} and sent together, so a run of changes arrives as one email. Mentions and urgent tasks still arrive right away.
      <!--NEXUS-MAIL-FOOTER-->
    </td></tr>
  </table>
</div>"""
    return subject, html
