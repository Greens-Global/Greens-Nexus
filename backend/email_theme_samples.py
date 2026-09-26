"""Sample renders of every Nexus email that uses the shared email theme
(email_theme.py) - one fixed, made-up input per email family.

Two callers:
  * Settings > Branding & Policies > Email Appearance "Preview"
    (routers/branding.py) - shows an admin what a draft theme looks like
    before it is saved;
  * test_email_theme.py - renders the same inputs with the default theme and
    compares them to the checked-in snapshots in testdata/email_theme/, so a
    refactor can never quietly change what people receive.

Nothing here reads the database or sends mail. The inputs are fixed on
purpose: a changing value (today's date, a random id) would make the
snapshots useless.
"""
from types import SimpleNamespace

# Families an admin can preview, in the order the picker lists them.
SAMPLE_LABELS = {
    "task":           "Task Notification",
    "task_digest":    "Task Reminders",
    "task_batch":     "Task Updates",
    "ticket":         "Ticket Notification",
    "ticket_comment": "Ticket Reply",
    "invite":         "External Invitation",
    "signin_code":    "Sign-In Code",
    "esign_request":  "Signature Request",
    "esign_complete": "Signature Completed",
    "welcome":        "Welcome Email",
}

_BASE = "https://nexus.example"

_TASK = {
    "id": "task-1", "title": "Quarterly fire extinguisher check", "status": "in_progress",
    "projectName": "Facilities", "assigneeName": "Jane Roe", "assigneeId": "jane@example.com",
    "priority": "high", "dueDateDisplay": "10/15/2026", "actorName": "Alex Smith",
    "actorEmail": "alex@example.com", "eventAtDisplay": "09/26/2026 10:00 AM",
    "description": "Check every extinguisher on floors 1 to 3 and log the tag dates.",
}

_TICKET = {
    "id": "tkt-1", "code": "TKT-1042", "subject": "Laptop will not start", "status": "new",
    "description": "It shows a black screen after the logo.", "departmentName": "IT",
    "typeLabel": "Hardware", "priority": "medium", "requesterName": "Jane Roe",
    "requesterId": "jane@example.com", "createdAtDisplay": "09/26/2026 9:12 AM",
    "companyName": "Greens Global", "actorName": "Alex Smith", "actorEmail": "alex@example.com",
    "eventAtDisplay": "09/26/2026 10:00 AM", "assigneeName": "Alex Smith", "assigneeId": "alex@example.com",
}

_SENDER = {"name": "Alex Smith", "email": "alex@example.com", "title": "Operations Manager",
           "phone": "(949) 555-0100", "entity": "Greens Global", "entityAddress": ""}


def _task() -> str:
    import task_mail_templates as t
    return t.assigned_email(t=dict(_TASK), base_url=_BASE, logo_url="", audience="assignee")[1]


def _task_digest() -> str:
    import task_mail_templates as t
    items = [{"t": dict(_TASK), "days_left": -2, "links": ""},
             {"t": dict(_TASK, id="task-2", title="Renew vendor insurance"), "days_left": 1, "links": ""}]
    return t.reminder_digest_email(items=items, base_url=_BASE, logo_url="", recipient_name="Jane Roe")[1]


def _task_batch() -> str:
    import task_mail_templates as t
    items = [{"t": dict(_TASK), "lines": ["Alex Smith assigned this to you"], "links": ""}]
    return t.batch_email(items=items, base_url=_BASE, logo_url="", recipient_name="Jane Roe")[1]


def _ticket() -> str:
    import ticket_mail_templates as t
    return t.created_email_requester(t=dict(_TICKET), base_url=_BASE, logo_url="")[1]


def _ticket_comment() -> str:
    import ticket_mail_templates as t
    tk = dict(_TICKET, status="in_progress")
    html = t.update_email(t=tk, base_url=_BASE, logo_url="", update_kind="added a comment",
                          prev_status="new", latest_comment="We are sending a replacement today.")[1]
    thread = [{"name": "Alex Smith", "photoUrl": "", "at": "09/26/2026 10:00 AM",
               "body": "We are sending a replacement today."}]
    return html + t.update_email(t=tk, base_url=_BASE, logo_url="", update_kind="replied",
                                 thread=thread)[1]


def _invite() -> str:
    from routers import external_auth
    return external_auth._invite_email_html("Jane Roe", "Alex Smith", "Acme Partners", "sample-token")


def _signin_code() -> str:
    from routers import external_auth
    return external_auth._code_email_html("123456")


def _esign_party():
    return SimpleNamespace(name="Jane Roe", email="jane@example.com", token="tok-1", kind="external")


def _esign_req():
    return SimpleNamespace(id="env-1", title="Mutual NDA", message="Please sign by Friday.",
                           expires_on="2026-10-15", created_at="2026-09-22T10:00:00+00:00",
                           status="pending", final_sha256="ab" * 32)


def _esign_request() -> str:
    from routers import esign
    return esign._sign_email_html(_esign_party(), _esign_req(), dict(_SENDER), f"{_BASE}/sign/tok-1")


def _esign_complete() -> str:
    from routers import esign
    with_footer = esign._sealed_email_html("Jane Roe", _esign_req(), True, f"{_BASE}/documents",
                                           f"{_BASE}/view/1", "", dict(_SENDER), _esign_party())
    internal = esign._sealed_email_html("Alex Smith", _esign_req(), False, f"{_BASE}/documents")
    return with_footer + internal


def _welcome() -> str:
    from routers import hr
    emp = SimpleNamespace(first_name="Jane", last_name="Roe", job_title="Site Coordinator",
                          department="Operations", start_date="10/01/2026", location="Escondido office")
    return hr._welcome_html(emp, "jane.roe@example.com")


_RENDERERS = {
    "task": _task, "task_digest": _task_digest, "task_batch": _task_batch,
    "ticket": _ticket, "ticket_comment": _ticket_comment,
    "invite": _invite, "signin_code": _signin_code,
    "esign_request": _esign_request, "esign_complete": _esign_complete,
    "welcome": _welcome,
}


def render(kind: str, theme=None) -> str:
    """One sample, rendered with `theme` (an email_theme.Theme) when given,
    otherwise with whatever theme is saved."""
    import email_theme
    fn = _RENDERERS[kind]
    if theme is None:
        return fn()
    with email_theme.override(theme):
        return fn()


def render_all(theme=None) -> dict:
    return {k: render(k, theme) for k in _RENDERERS}
