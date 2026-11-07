"""Construction pack (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2): a Job
(construction_projects - a Work Order or a Project), its daily logs, RFIs
and submittals, and what happens to them. Every event is emitted at the
module's choke point in routers/construction.py, inside the request's
transaction (`_emit`):

  job.created            create_project (New Job, and Start Job on a ticket)
  job.status_changed     update_project (Edit Job) - and the ticket sync when
                         a reopened ticket puts a Complete job back to Active
  job.phase_changed      update_project
  daily_log.submitted    submit_log
  daily_log.reviewed     review_log (changes.status; extra decision / note)
  rfi.opened             create_register("rfis")
  rfi.answered           update_register("rfis") into Answered
  submittal.decided      update_register("submittals") into a decision
  change_order.signed    construction_changes.on_completed - the owner or
                         client signed a change order in Nexus Sign (phase 3,
                         11/03/2026). Its amount is NOT a field (the money
                         rule above); the days it moves the finish are.

Round Two (11/05/2026) - the rest of the job, so "a change order over
$25,000 waits for Neil" is a rule an administrator sets, never code:
  punch.verified         construction_jobs.punch_verify (subject: the job;
                         extra task_id / title)
  field_ticket.signed    construction_handover.sign_field_ticket
  change_order.sent      sent to the owner or client for signature
  change_order.approved  the internal approver approved it (then sent)
  change_order.sent_back the internal approver sent it back (extra note)
  change_order.declined  construction_changes.on_declined (Nexus Sign)
  job.closed_out         construction_handover.close_out, the first time
  report.published       publish_report (subject: the weekly report)
  drawing.revised        construction_drawings.add_drawing - a new revision
                         superseded a sheet (subject: the job; extra
                         sheet_number / revision / previous_revision / title)

`visible_to` is the module's own reach (routers.construction._may_read: the
job's people, or a manager inside the job's company); a job's company is its
`company_id`, a log's / RFI's / submittal's is its job's. Building on these
events takes a manager or an administrator - the people who run jobs.
Contract value is never a field here (the crew-and-executives rule).
"""
from __future__ import annotations

from sqlalchemy import select

import models
from workflows.catalog import F, entity, event
from workflows.packs._people import _conn, attach_property, emails, is_admin, is_manager

MODULE = "construction"

JOB_TYPES = [("work_order", "Work Order"), ("project", "Project")]
JOB_STATUSES = [("active", "Active"), ("on_hold", "On Hold"), ("complete", "Complete"), ("archived", "Archived")]
LOG_STATUSES = [("draft", "Draft"), ("submitted", "In Review"), ("processed", "In Review (Read)"),
                ("needs_info", "Sent Back"), ("approved", "Approved")]
RFI_STATUSES = [("open", "Open"), ("answered", "Answered"), ("closed", "Closed"), ("void", "Void")]
SUBMITTAL_STATUSES = [("pending", "Pending"), ("submitted", "Submitted"), ("approved", "Approved"),
                      ("approved_as_noted", "Approved As Noted"), ("revise_resubmit", "Revise and Resubmit"),
                      ("rejected", "Rejected")]


def may_use(db, user) -> bool:
    return bool(user) and (is_admin(user) or is_manager(user))


def _job_row(row):
    """The job a log / RFI / submittal belongs to (read on the row's own
    connection, so an emit inside a flush never autoflushes)."""
    conn = _conn(row)
    pid = getattr(row, "project_id", "") or ""
    if conn is None or not pid:
        return None
    t = models.ConstructionProject.__table__
    return conn.execute(select(t.c.company_id, t.c.name, t.c.manager_emails, t.c.worker_emails)
                        .where(t.c.id == pid)).first()


def _child_company(row) -> str:
    j = _job_row(row)
    return str(j[0] or "") if j is not None else ""


def _job_name(row) -> str:
    j = _job_row(row)
    return str(j[1] or "") if j is not None else ""


def _visible(db, user, row) -> bool:
    if not user or row is None:
        return False
    from routers.construction import _may_read
    job = row if isinstance(row, models.ConstructionProject) else db.get(models.ConstructionProject,
                                                                        getattr(row, "project_id", "") or "")
    return job is not None and not (job.deleted_at or "") and _may_read(db, user, job)


def _job_link(row, tab: str = "") -> dict:
    jid = row.id if isinstance(row, models.ConstructionProject) else (getattr(row, "project_id", "") or "")
    return {"view": "ops", "sub": f"project:{jid}" + (f":{tab}" if tab else "")}


# ── people ───────────────────────────────────────────────────────────────────
def _managers(db, row) -> list[str]:
    if isinstance(row, models.ConstructionProject):
        return emails(row.manager_emails or [])
    j = _job_row(row)
    return emails(list(j[2] or [])) if j is not None else []


def _crew(db, row) -> list[str]:
    if isinstance(row, models.ConstructionProject):
        return emails(row.worker_emails or [])
    j = _job_row(row)
    return emails(list(j[3] or [])) if j is not None else []


def _author(db, row) -> list[str]:
    return emails(row.author_email)


def _reviewer(db, row) -> list[str]:
    return emails(row.reviewed_by)


def _responder(db, row) -> list[str]:
    return emails(getattr(row, "responder_email", ""))


def _approver(db, row) -> list[str]:
    return emails(getattr(row, "approver_email", ""))


def _creator(db, row) -> list[str]:
    return emails(row.created_by)


# ── derived attributes ───────────────────────────────────────────────────────
attach_property(models.ConstructionDailyLog, "wf_job_name", _job_name)
attach_property(models.ConstructionRfi, "wf_job_name", _job_name)
attach_property(models.ConstructionSubmittal, "wf_job_name", _job_name)
attach_property(models.ConstructionChangeOrder, "wf_job_name", _job_name)
attach_property(models.ConstructionFieldTicket, "wf_job_name", _job_name)
attach_property(models.ConstructionWeeklyReport, "wf_job_name", _job_name)


# ── entities ─────────────────────────────────────────────────────────────────
entity("job", label="Job", model=models.ConstructionProject, module=MODULE,
       company=lambda row: row.company_id or "",
       link=lambda row: _job_link(row),
       people={"manager": _managers, "crew": _crew, "creator": _creator},
       people_labels={"manager": "Job Managers", "crew": "Crew", "creator": "Created By"},
       fields=[
           F("name", "Job", "text"),
           F("code", "Code", "text"),
           F("job_type", "Job Type", "select", options=JOB_TYPES),
           F("status", "Status", "select", options=JOB_STATUSES),
           F("phase", "Phase", "text"),
           F("percent_complete", "Percent Complete", "number"),
           F("address", "Address", "text"),
           F("property_id", "Property", "text"),
           F("company_id", "Company", "select", options="companies"),
           F("start_on", "Start", "date"),
           F("target_finish_on", "Target Finish", "date"),
           F("manager_emails", "Job Managers", "people"),
           F("worker_emails", "Crew", "people"),
           F("created_at", "Created At", "datetime"),
       ],
       dates=["start_on", "target_finish_on"],
       label_of=lambda row: row.name or "Job",
       visible_to=_visible)

entity("daily_log", label="Daily Log", model=models.ConstructionDailyLog, module=MODULE,
       company=_child_company,
       link=lambda row: {"view": "ops", "sub": f"activity:{row.project_id}"},
       people={"author": _author, "reviewer": _reviewer, "manager": _managers, "crew": _crew},
       people_labels={"author": "Filed By", "reviewer": "Reviewed By", "manager": "Job Managers", "crew": "Crew"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("log_date", "Day", "date"),
           F("status", "Status", "select", options=LOG_STATUSES),
           F("author_email", "Filed By", "person"),
           F("crew_size", "Crew Size", "number"),
           F("hours_worked", "Hours Worked", "number"),
           F("weather", "Weather", "text"),
           F("notes_raw", "Notes", "text"),
           F("reviewed_by", "Reviewed By", "person"),
           F("review_note", "Review Note", "text"),
           F("submitted_at", "Submitted At", "datetime"),
       ],
       dates=["log_date"],
       label_of=lambda row: f"Daily Log {row.log_date or ''}".strip(),
       visible_to=_visible)

entity("rfi", label="RFI", model=models.ConstructionRfi, module=MODULE,
       company=_child_company,
       link=lambda row: _job_link(row, "rfis"),
       people={"responder": _responder, "manager": _managers},
       people_labels={"responder": "Responder", "manager": "Job Managers"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("number", "Number", "text"),
           F("subject", "Subject", "text"),
           F("status", "Status", "select", options=RFI_STATUSES),
           F("ball_in_court", "Ball In Court", "text"),
           F("responder_email", "Responder", "person"),
           F("due_on", "Response Due", "date"),
           F("answered_on", "Answered On", "date"),
           F("schedule_impact_days", "Schedule Impact (Days)", "number"),
       ],
       dates=["due_on"],
       label_of=lambda row: f"RFI {row.number or ''} {row.subject or ''}".strip(),
       visible_to=_visible)

entity("submittal", label="Submittal", model=models.ConstructionSubmittal, module=MODULE,
       company=_child_company,
       link=lambda row: _job_link(row, "rfis"),
       people={"approver": _approver, "manager": _managers},
       people_labels={"approver": "Approver", "manager": "Job Managers"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("number", "Number", "text"),
           F("title", "Title", "text"),
           F("spec_section", "Spec Section", "text"),
           F("status", "Status", "select", options=SUBMITTAL_STATUSES),
           F("revision", "Revision", "number"),
           F("approver_email", "Approver", "person"),
           F("due_on", "Due", "date"),
           F("returned_on", "Returned On", "date"),
       ],
       dates=["due_on"],
       label_of=lambda row: f"Submittal {row.number or ''} {row.title or ''}".strip(),
       visible_to=_visible)


CO_STATUSES = [("draft", "Draft"), ("awaiting_approval", "Awaiting Approval"), ("sent", "Sent"),
               ("signed", "Signed"), ("declined", "Declined"), ("void", "Void")]
CO_REASONS = [("owner_request", "Owner Request"), ("unforeseen", "Unforeseen Condition"),
              ("design", "Design Change"), ("code", "Code Requirement"), ("other", "Other")]

entity("change_order", label="Change Order", model=models.ConstructionChangeOrder, module=MODULE,
       company=_child_company,
       link=lambda row: _job_link(row, "changes"),
       people={"creator": _creator, "approver": _approver, "manager": _managers},
       people_labels={"creator": "Written By", "approver": "Approver", "manager": "Job Managers"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("number", "Number", "text"),
           F("title", "Title", "text"),
           F("reason", "Reason", "select", options=CO_REASONS),
           F("status", "Status", "select", options=CO_STATUSES),
           F("schedule_impact_days", "Schedule Impact (Days)", "number"),
           F("signer_name", "Signed By", "text"),
           F("signed_at", "Signed At", "datetime"),
       ],
       dates=[],
       label_of=lambda row: f"Change Order {row.number or ''} {row.title or ''}".strip(),
       visible_to=_visible)

FT_STATUSES = [("open", "Open"), ("signed", "Signed"), ("priced", "Priced"), ("void", "Void")]
REPORT_STATUSES = [("draft", "Draft"), ("in_review", "In Review"), ("approved", "Approved"),
                   ("published", "Published"), ("superseded", "Superseded")]

entity("field_ticket", label="Field Ticket", model=models.ConstructionFieldTicket, module=MODULE,
       company=_child_company,
       link=lambda row: _job_link(row, "changes"),
       people={"creator": _creator, "manager": _managers},
       people_labels={"creator": "Written By", "manager": "Job Managers"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("number", "Number", "text"),
           F("work_date", "Work Date", "date"),
           F("description", "Description", "text"),
           F("labor_hours", "Labor Hours", "number"),
           F("status", "Status", "select", options=FT_STATUSES),
           F("signed_name", "Signed By", "text"),
           F("signed_at", "Signed At", "datetime"),
       ],
       dates=["work_date"],
       label_of=lambda row: f"Field Ticket {row.number or ''}".strip(),
       visible_to=_visible)

entity("weekly_report", label="Weekly Report", model=models.ConstructionWeeklyReport, module=MODULE,
       company=_child_company,
       link=lambda row: {"view": "ops", "sub": f"activity:{row.project_id}"},
       people={"manager": _managers, "publisher": lambda db, row: emails(row.approved_by)},
       people_labels={"manager": "Job Managers", "publisher": "Published By"},
       fields=[
           F("job", "Job", "text", path="wf_job_name"),
           F("week_start", "Week Of", "date"),
           F("version", "Version", "number"),
           F("status", "Status", "select", options=REPORT_STATUSES),
           F("title", "Title", "text"),
           F("published_at", "Published At", "datetime"),
       ],
       dates=["week_start"],
       label_of=lambda row: f"Weekly Report {row.week_start or ''}".strip(),
       visible_to=_visible)


# ── events ───────────────────────────────────────────────────────────────────
SAMPLE_JOB = {"name": "Gate Motor Repair - Escondido", "code": "", "job_type": "work_order", "status": "active",
              "phase": "", "percent_complete": 0, "address": "25260 N Centre City Pkwy, Escondido, CA 92026",
              "property_id": "greens-escondido", "company_id": "", "start_on": "2026-11-03",
              "target_finish_on": "2026-11-05", "manager_emails": ["marcus.ruiz@greensglobal.com"],
              "worker_emails": ["ana.lopez@greensglobal.com"], "created_at": "2026-11-03T15:10:00+00:00"}
SAMPLE_LOG = {"job": "Temecula Phase 2 - Building C", "log_date": "2026-11-03", "status": "submitted",
              "author_email": "ana.lopez@greensglobal.com", "crew_size": 6, "hours_worked": 47, "weather": "Clear",
              "notes_raw": "Framed the east wall", "reviewed_by": "", "review_note": "",
              "submitted_at": "2026-11-03T23:12:00+00:00"}
SAMPLE_RFI = {"job": "Temecula Phase 2 - Building C", "number": "RFI-014", "subject": "Beam depth at grid C-4",
              "status": "open", "ball_in_court": "Architect", "responder_email": "marcus.ruiz@greensglobal.com",
              "due_on": "2026-11-10", "answered_on": "", "schedule_impact_days": 0}
SAMPLE_CO = {"job": "Temecula Phase 2 - Building C", "number": "CO-003", "title": "Extra footing at grid D-2",
             "reason": "unforeseen", "status": "signed", "schedule_impact_days": 2, "signer_name": "Dana Owens",
             "signed_at": "2026-11-05T18:20:00+00:00"}
SAMPLE_SUBMITTAL = {"job": "Temecula Phase 2 - Building C", "number": "SUB-031", "title": "Roof membrane",
                    "spec_section": "07 54 00", "status": "approved_as_noted", "revision": 1,
                    "approver_email": "marcus.ruiz@greensglobal.com", "due_on": "2026-11-08",
                    "returned_on": "2026-11-06"}


def _full(subject: dict, changes: dict = None, extra: dict = None, actor: str = "") -> dict:
    return {"subject": subject, "changes": changes or {}, "extra": extra or {}, "actor": actor}


event("job.created", entity="job", label="Job Is Created", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_JOB, actor="marcus.ruiz@greensglobal.com"))
event("job.status_changed", entity="job", label="Job Status Changes", module=MODULE, group="Construction",
      changes=("status",), may_use=may_use,
      sample=_full(dict(SAMPLE_JOB, status="complete"), changes={"status": {"from": "active", "to": "complete"}},
                   actor="marcus.ruiz@greensglobal.com"))
event("job.phase_changed", entity="job", label="Job Phase Changes", module=MODULE, group="Construction",
      changes=("phase",), may_use=may_use,
      sample=_full(dict(SAMPLE_JOB, job_type="project", phase="Framing"),
                   changes={"phase": {"from": "Foundation", "to": "Framing"}}, actor="marcus.ruiz@greensglobal.com"))
event("daily_log.submitted", entity="daily_log", label="Daily Log Is Submitted", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_LOG, actor="ana.lopez@greensglobal.com"))
event("daily_log.reviewed", entity="daily_log", label="Daily Log Is Reviewed", module=MODULE, group="Construction",
      changes=("status",), may_use=may_use,
      sample=_full(dict(SAMPLE_LOG, status="approved", reviewed_by="marcus.ruiz@greensglobal.com"),
                   changes={"status": {"from": "submitted", "to": "approved"}},
                   extra={"decision": "approve", "note": ""}, actor="marcus.ruiz@greensglobal.com"))
event("rfi.opened", entity="rfi", label="RFI Is Opened", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_RFI, actor="ana.lopez@greensglobal.com"))
event("rfi.answered", entity="rfi", label="RFI Is Answered", module=MODULE, group="Construction",
      changes=("status",), may_use=may_use,
      sample=_full(dict(SAMPLE_RFI, status="answered", answered_on="2026-11-06"),
                   changes={"status": {"from": "open", "to": "answered"}}, actor="marcus.ruiz@greensglobal.com"))
event("submittal.decided", entity="submittal", label="Submittal Is Decided", module=MODULE, group="Construction",
      changes=("status",), may_use=may_use,
      sample=_full(SAMPLE_SUBMITTAL, changes={"status": {"from": "submitted", "to": "approved_as_noted"}},
                   actor="marcus.ruiz@greensglobal.com"))
event("change_order.signed", entity="change_order", label="Change Order Is Signed", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_CO, extra={"job_id": "temecula-c", "schedule_impact_days": 2}))

# Round Two (11/05/2026): the rest of the job.
SAMPLE_FT = {"job": "Temecula Phase 2 - Building C", "number": "FT-004", "work_date": "2026-11-04",
             "description": "Extra footing at grid D-2", "labor_hours": 14, "status": "signed",
             "signed_name": "Dana Owens", "signed_at": "2026-11-04T23:40:00+00:00"}
SAMPLE_REPORT = {"job": "Temecula Phase 2 - Building C", "week_start": "2026-11-02", "version": 1,
                 "status": "published", "title": "Construction Update - week of 11/02/2026",
                 "published_at": "2026-11-06T22:00:00+00:00"}
event("punch.verified", entity="job", label="Punch Item Is Verified", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(dict(SAMPLE_JOB, job_type="project"), extra={"task_id": "t-punch-14", "title": "Touch up paint, unit 212"},
                                    actor="marcus.ruiz@greensglobal.com"))
event("field_ticket.signed", entity="field_ticket", label="Field Ticket Is Signed", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_FT, extra={"job_id": "temecula-c"}, actor="ana.lopez@greensglobal.com"))
event("change_order.sent", entity="change_order", label="Change Order Is Sent for Signature", module=MODULE,
      group="Construction", may_use=may_use,
      sample=_full(dict(SAMPLE_CO, status="sent", signer_name="", signed_at=""), extra={"job_id": "temecula-c"},
                   actor="marcus.ruiz@greensglobal.com"))
event("change_order.approved", entity="change_order", label="Change Order Is Approved Internally", module=MODULE,
      group="Construction", may_use=may_use,
      sample=_full(dict(SAMPLE_CO, status="sent", signer_name="", signed_at=""), extra={"job_id": "temecula-c"},
                   actor="neil@greensglobal.com"))
event("change_order.sent_back", entity="change_order", label="Change Order Is Sent Back", module=MODULE,
      group="Construction", may_use=may_use,
      sample=_full(dict(SAMPLE_CO, status="draft", signer_name="", signed_at=""),
                   extra={"job_id": "temecula-c", "note": "Price the rebar separately"}, actor="neil@greensglobal.com"))
event("change_order.declined", entity="change_order", label="Change Order Is Declined", module=MODULE,
      group="Construction", may_use=may_use,
      sample=_full(dict(SAMPLE_CO, status="declined", signed_at=""), extra={"job_id": "temecula-c", "reason": "Scope not agreed"}))
event("job.closed_out", entity="job", label="Job Is Closed Out", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(dict(SAMPLE_JOB, status="complete", percent_complete=100), extra={"records": 6},
                                    actor="marcus.ruiz@greensglobal.com"))
event("report.published", entity="weekly_report", label="Weekly Report Is Published", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(SAMPLE_REPORT, extra={"job_id": "temecula-c", "week_start": "2026-11-02", "version": 1},
                                    actor="marcus.ruiz@greensglobal.com"))
event("drawing.revised", entity="job", label="Drawing Is Revised", module=MODULE, group="Construction",
      may_use=may_use, sample=_full(dict(SAMPLE_JOB, job_type="project"), extra={"drawing_id": "d-a201-3", "sheet_number": "A-201", "revision": "3", "previous_revision": "2", "title": "First Floor Plan"},
                                    actor="marcus.ruiz@greensglobal.com"))
