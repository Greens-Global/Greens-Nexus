"""Role change without a promotion, with approval (Pranshu, Oct 13 2026).

An admin or HR asks for the change from People (Change Role > Role Change
Without Promotion) or from Settings > Access, and gives a reason. Nothing
changes yet: the employee's manager and their company's HR contact
(hr_entities.hr_contact_email) each get a bell (priority - the yellow bar)
and an email with the reason, and EITHER of them approves or declines -
from the bell / email (both open the decision dialog in People) or from the
person's Access tab. Only on approval does the role change: the same
apply_job_role a signed promotion runs (access, tier, title), plus the
role's department and an audit row.

  - The person asking never approves their own request; if that leaves
    nobody (no manager, no HR contact), the request is refused up front.
  - One pending request per person - cancel it before asking for another.
  - The permission check (check_can_assign, HR path) runs against the person
    ASKING, when they ask: the approver confirms the change, they do not need
    the right to grant that role themselves.
  - A promotion is not this: it is a letter signed through Nexus Sign
    (hr_life_events.py).

Emails go out after the response (BackgroundTasks) - see send_emails.
"""
import json
import uuid
from datetime import datetime, timezone
from html import escape

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
from app_url import app_url

PENDING = "pending"
STATUS_LABELS = {"pending": "Awaiting Approval", "approved": "Approved", "declined": "Declined", "canceled": "Canceled"}


class RoleChangeError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _name(db: Session, email: str) -> str:
    from hr_life_events import person_name
    return person_name(db, email) if email else ""


def deep_link_sub(req_id: str) -> str:
    """The People sub-route that opens this request's decision dialog - the
    bell's button and the email's button both land there."""
    return f"hr-role-change-{req_id}"


def _hr_contact(db: Session, company: str) -> str:
    entity = db.query(models.HrEntity).filter(models.HrEntity.id == company).first() if company else None
    return (entity.hr_contact_email or "").strip().lower() if entity else ""


def approvers_for(db: Session, emp: models.NexusEmployee, requester: str) -> list:
    """The manager and the company HR contact - never the person asking, never
    the employee themselves. One entry when the manager IS the HR contact."""
    skip = {(requester or "").lower(), (emp.work_email or "").lower()}
    out = []
    for email, role in (((emp.manager_email or "").strip().lower(), "manager"), (_hr_contact(db, emp.company), "hr")):
        if email and email not in skip and email not in {a["email"] for a in out}:
            out.append({"email": email, "name": _name(db, email), "as": role})
    return out


def _allowed(db: Session, req: models.HrRoleChangeRequest, emp) -> set:
    """Who may decide: the approvers named when it was asked, plus whoever is
    the manager / HR contact NOW (a manager who changed since still counts)."""
    out = {a.get("email", "") for a in (req.approvers or [])}
    if emp is not None:
        out |= {a["email"] for a in approvers_for(db, emp, req.requested_by)}
    return out - {"", (req.requested_by or "").lower()}


def ser(db: Session, req: models.HrRoleChangeRequest, viewer: str = "", can_manage: bool = False) -> dict:
    viewer = (viewer or "").lower()
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == req.employee_id).first()
    pending = req.status == PENDING
    return {
        "id": req.id, "employeeId": req.employee_id, "employeeEmail": req.employee_email,
        "employeeName": req.employee_name, "fromTitle": req.from_title, "toRoleId": req.to_role_id,
        "toRoleName": req.to_role_name, "reason": req.reason, "status": req.status,
        "statusLabel": STATUS_LABELS.get(req.status, req.status), "approvers": req.approvers or [],
        "requestedBy": req.requested_by, "requestedByName": req.requested_by_name, "createdAt": req.created_at,
        "decidedBy": req.decided_by, "decidedByName": _name(db, req.decided_by), "decidedAt": req.decided_at,
        "decisionNote": req.decision_note,
        "canDecide": pending and viewer in _allowed(db, req, emp),
        "canCancel": pending and (viewer == (req.requested_by or "").lower() or can_manage),
    }


def can_see(db: Session, req: models.HrRoleChangeRequest, viewer: str, hr_reader: bool) -> bool:
    if hr_reader:
        return True
    viewer = (viewer or "").lower()
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == req.employee_id).first()
    return viewer == (req.requested_by or "").lower() or viewer in _allowed(db, req, emp)


# ── notifications ────────────────────────────────────────────────────────────

REVIEW = "review"   # the approvers' bell: its button opens the decision
PEOPLE = "people"   # outcome bells for HR / the person who asked


def _bell(db: Session, to: str, title: str, body: str, req, by: str, priority: int = 0, button: str = "") -> None:
    from routers.hr import _hr_notify
    action = ({"view": "hr", "sub": deep_link_sub(req.id), "label": "Review Request"} if button == REVIEW
              else {"view": "hr", "sub": "hr-people", "label": "Open People"} if button == PEOPLE else None)
    _hr_notify(db, to, title, body, ref_id=req.id, requested_by=by, action=action, priority=priority)


def _clear_bells(db: Session, req) -> None:
    """The approvers' "needs action" bells are done once anyone decides - off
    the yellow bar for everyone."""
    db.query(models.NexusNotification).filter(
        models.NexusNotification.ref_id == req.id,
        models.NexusNotification.actioned == False,   # noqa: E712 - SQLAlchemy expression
    ).update({"actioned": True}, synchronize_session=False)


def _email(heading: str, intro: str, rows: list, button: str, url: str, footer: str) -> str:
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    cells = "".join(
        f'<tr><td style="padding:8px 12px;font-size:12px;color:#6b7280;width:130px;vertical-align:top;border-top:1px solid #e5e7eb">{escape(k)}</td>'
        f'<td style="padding:8px 12px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb;white-space:pre-line">{escape(v)}</td></tr>'
        for k, v in rows if v)
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(heading)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{escape(intro)}</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-top:none;border-collapse:collapse">{cells}</table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">{escape(button)}</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      {escape(footer)}{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


def send_emails(batch: list) -> None:
    """Runs after the response (BackgroundTasks). One failure never stops the
    rest; the bell is already there either way."""
    import graph_mail
    for to, subject, html in batch:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - never fail the batch for one address
            print(f"[role-change] email to {to} failed: {e}")


# ── ask / decide / cancel ────────────────────────────────────────────────────

def request_change(db: Session, user: dict, emp: models.NexusEmployee, role_id: str, reason: str) -> tuple:
    """Record the request and tell the approvers. Not committed.
    Returns (request, warning, emails)."""
    from hr_life_events import current_job_role
    from routers.jobroles import check_can_assign
    # Locked: two requests at once must not both pass the one-pending check.
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == emp.id).with_for_update().first()
    if emp.status not in ("active", "onboarding"):
        raise RoleChangeError(f"{emp.first_name} is {emp.status} - only current employees can change roles.", 409)
    email = (emp.work_email or "").strip().lower()
    if not email:
        raise RoleChangeError("They need a work email first - the role is their access in Nexus.", 409)
    reason = (reason or "").strip()
    if not reason:
        raise RoleChangeError("Add the reason - their manager and HR read it before they approve.")
    jr = (db.query(models.NexusGroup).filter(models.NexusGroup.id == (role_id or "").strip(),
                                             models.NexusGroup.is_job_role == 1).first()
          if (role_id or "").strip() else None)
    if not jr:
        raise RoleChangeError("Pick the new role.")
    cur = current_job_role(db, email)
    if cur and cur.id == jr.id:
        raise RoleChangeError(f"{emp.first_name} already has the {jr.name} role.")
    try:
        warning = check_can_assign(db, user, jr, email, hr_path=True)
    except HTTPException as e:
        raise RoleChangeError(str(e.detail), e.status_code)
    open_req = (db.query(models.HrRoleChangeRequest)
                .filter(models.HrRoleChangeRequest.employee_id == emp.id, models.HrRoleChangeRequest.status == PENDING)
                .first())
    if open_req:
        raise RoleChangeError(f"A role change to {open_req.to_role_name} is already waiting for approval - "
                              f"cancel it on their Access tab first.", 409)
    approvers = approvers_for(db, emp, user["email"])
    if not approvers:
        raise RoleChangeError(f"Nobody can approve this: {emp.first_name} needs a manager, or their company an HR "
                              f"contact (Company Settings), other than you.", 409)
    me = user["email"].lower()
    name = (emp.display_name or f"{emp.first_name} {emp.last_name}").strip()
    req = models.HrRoleChangeRequest(
        id=str(uuid.uuid4()), employee_id=emp.id, employee_email=email, employee_name=name, company=emp.company or "",
        from_role_id=cur.id if cur else "", from_title=emp.job_title or (cur.name if cur else ""),
        to_role_id=jr.id, to_role_name=jr.name, reason=reason[:1000], status=PENDING, approvers=approvers,
        requested_by=me, requested_by_name=_name(db, me), created_at=_now())
    db.add(req)
    db.flush()
    change = f"{req.from_title or 'No role'} -> {jr.name}"
    url = f"{app_url()}/hr/{deep_link_sub(req.id)}"
    emails = []
    for a in approvers:
        _bell(db, a["email"], f"Approve role change - {name}",
              f"{req.requested_by_name} asks to change {name}'s role: {change}.\nReason: {req.reason}",
              req, me, priority=1, button=REVIEW)
        emails.append((a["email"], f"Approve role change - {name}", _email(
            "Role Change Waiting For You",
            f"{req.requested_by_name} asks to change {name}'s role. It changes only when you or "
            f"{'HR' if a['as'] == 'manager' else 'their manager'} approves.",
            [("Employee", name), ("Current role", req.from_title or "No role"), ("New role", jr.name),
             ("Reason", req.reason), ("Asked by", req.requested_by_name)],
            "Review And Approve", url,
            "You get this email because you are their manager or their company's HR contact in Nexus.")))
    return req, warning, emails


def _load(db: Session, req_id: str, lock: bool = False) -> models.HrRoleChangeRequest:
    q = db.query(models.HrRoleChangeRequest).filter(models.HrRoleChangeRequest.id == req_id)
    req = q.with_for_update().first() if lock else q.first()
    if not req:
        raise RoleChangeError("Role change request not found", 404)
    return req


def _closed(req) -> RoleChangeError:
    return RoleChangeError(f"This request was already {STATUS_LABELS.get(req.status, req.status).lower()}"
                           + (f" by {req.decided_by}" if req.decided_by else "") + ".", 409)


def decide(db: Session, user: dict, req_id: str, approve: bool, note: str = "") -> tuple:
    """Approve (the role changes now) or decline. Not committed.
    Returns (request, emails)."""
    from hr_life_events import current_job_role
    from routers.jobroles import apply_job_role
    req = _load(db, req_id, lock=True)
    if req.status != PENDING:
        raise _closed(req)
    me = user["email"].lower()
    emp = (db.query(models.NexusEmployee).filter(models.NexusEmployee.id == req.employee_id)
           .with_for_update().first())
    if me not in _allowed(db, req, emp):
        raise RoleChangeError(f"Only {req.employee_name}'s manager or HR can decide this request.", 403)
    note = (note or "").strip()[:1000]
    if approve:
        if not emp or emp.status not in ("active", "onboarding") or not emp.work_email:
            raise RoleChangeError(f"{req.employee_name} is no longer a current employee - cancel this request.", 409)
        jr = db.query(models.NexusGroup).filter(models.NexusGroup.id == req.to_role_id,
                                                models.NexusGroup.is_job_role == 1).first()
        if not jr:
            raise RoleChangeError(f"The {req.to_role_name} role was deleted - decline this request.", 409)
        email = emp.work_email.lower()
        cur = current_job_role(db, email)
        if not cur or cur.id != jr.id:
            apply_job_role(db, jr, email, req.requested_by)
        if jr.department:
            emp.department = jr.department
        emp.updated_at = _now()
        db.add(models.AuditLog(timestamp=_now(), user_email=me, user_role=str(user.get("role") or ""),
                               action="Approved role change", resource_type="employee", resource_id=emp.id,
                               details=json.dumps({"employee": email, "from": req.from_title, "to": jr.name,
                                                   "reason": req.reason, "requested_by": req.requested_by})[:4000]))
    req.status = "approved" if approve else "declined"
    req.decided_by, req.decided_at, req.decision_note = me, _now(), ("" if approve else note)
    _clear_bells(db, req)
    who = _name(db, me)
    name = req.employee_name
    verdict = "approved" if approve else "declined"
    body = (f"{who} {verdict} the change of {name}'s role to {req.to_role_name}."
            + (f"\nNote: {note}" if note and not approve else ""))
    title = f"Role change {verdict} - {name}"
    emails = []
    for to in ({req.requested_by} | {a.get("email", "") for a in (req.approvers or [])}) - {me, ""}:
        _bell(db, to, title, body, req, me, button=PEOPLE)
    if req.requested_by and req.requested_by != me:
        emails.append((req.requested_by, title, _email(
            f"Role Change {verdict.title()}", body.replace("\n", " "),
            [("Employee", name), ("New role", req.to_role_name), ("Your reason", req.reason),
             ("Note", note if not approve else "")],
            "Open People", f"{app_url()}/hr/hr-people",
            "You get this email because you asked for this role change in Nexus.")))
    if approve and emp is not None:
        _bell(db, req.employee_email, "Your role changed",
              f"Your role is now {req.to_role_name}. Your access in Nexus follows the new role.", req, me)
    return req, emails


def cancel(db: Session, user: dict, req_id: str, can_manage: bool) -> models.HrRoleChangeRequest:
    req = _load(db, req_id, lock=True)
    if req.status != PENDING:
        raise _closed(req)
    me = user["email"].lower()
    if me != (req.requested_by or "").lower() and not can_manage:
        raise RoleChangeError("Only the person who asked, or HR, can cancel this request.", 403)
    req.status, req.decided_by, req.decided_at = "canceled", me, _now()
    _clear_bells(db, req)
    for a in req.approvers or []:
        if a.get("email") and a["email"] != me:
            _bell(db, a["email"], f"Role change canceled - {req.employee_name}",
                  f"{_name(db, me)} canceled the change of {req.employee_name}'s role to {req.to_role_name}. "
                  f"Nothing to approve.", req, me, button=PEOPLE)
    return req
