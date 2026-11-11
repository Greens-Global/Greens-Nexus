"""The email an employee gets when their manager cancels their approved time
off from the Shift Planner (Pranshu, 11/11/2026).

It says who canceled it, the dates, the reason when one was given, and has
two buttons: "Message <manager> on Teams" (a Teams chat with the manager,
the message prefilled, nothing sent) and "View My Time Off" in Nexus. People
talk on Teams, never in an in-app chat (CLAUDE.md, Frontline reach) - the
link is the documented teams.microsoft.com/l/chat form, the same one
frontend/src/lib/teamsLinks.js builds.

Built inside the request (`build`), sent after the response (`send`, through
BackgroundTasks) so Graph never holds the request open; a failure is logged
without the address and the bell is the record either way.
"""
from html import escape
from urllib.parse import quote

TEAMS_PURPLE = "#5B5FC7"


def teams_chat_url(email: str, message: str = "") -> str:
    base = f"https://teams.microsoft.com/l/chat/0/0?users={quote((email or '').strip())}"
    return f"{base}&message={quote(message)}" if message else base


def build(db, *, employee_email: str, employee_first: str, manager_email: str, manager_name: str,
          kind: str, when: str, reason: str, kept_note: str = "") -> tuple:
    """(to, subject, html). `kind` is the request's type as a bell names it,
    `when` the US-formatted dates (and hours), `kept_note` the line about
    days already taken when the leave had started."""
    import email_theme
    from app_url import app_url
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    logo = email_theme.logo_for(db, "", employee_email)
    subject = f"Your Time Off on {when} Was Canceled"
    intro = (f"Hi {employee_first or 'there'}, your manager {manager_name} canceled your approved "
             f"{kind} time off for {when}.")
    rows = [("Canceled By", manager_name), ("Dates", when), ("Reason", reason), ("Note", kept_note)]
    cells = "".join(
        f'<tr><td style="padding:8px 12px;font-size:12px;color:#6b7280;width:130px;vertical-align:top;border-top:1px solid #e5e7eb">{escape(k)}</td>'
        f'<td style="padding:8px 12px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb;white-space:pre-line">{escape(v)}</td></tr>'
        for k, v in rows if v)
    teams = teams_chat_url(manager_email, f"Hi {manager_name.split(' ')[0]}, about my time off on {when} that was canceled - ")
    nexus = f"{app_url()}/timeclock"
    btn = ("display:inline-block;padding:10px 20px;border-radius:4px;color:#ffffff;text-decoration:none;"
           "font-weight:600;font-size:13px;margin:0 8px 8px 0")
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block(logo)}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">Your Time Off Was Canceled</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{escape(intro)}</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-top:none;border-collapse:collapse">{cells}</table>
    </td></tr>
    <tr><td style="padding:18px 28px 0;font-size:14px;line-height:1.55;color:#374151">
      If this doesn't work for you, or you'd like to talk it through, message {escape(manager_name)} on Microsoft Teams.
    </td></tr>
    <tr><td style="padding:18px 28px 24px">
      <a href="{escape(teams)}" style="{btn};background:{TEAMS_PURPLE}">&#128172;&nbsp; Message {escape(manager_name)} on Teams</a>
      <a href="{escape(nexus)}" style="{btn};background:{band}">View My Time Off</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      Your time off balance has been updated. You can request new dates any time in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return employee_email, subject, html


def send(batch: list) -> None:
    """Runs after the response (BackgroundTasks). Never raises; the failure
    line names no address."""
    import graph_mail
    if not graph_mail.graph_configured():
        return
    for i, (to, subject, html) in enumerate(batch):
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - one failure never stops the rest
            print(f"[timeoff-cancel] email {i + 1} of {len(batch)} failed: {type(e).__name__}")
