"""Screening a new candidate (Neil and Charmi, Oct 14 2026).

    "Is there a notification that comes up when the applicant comes in that,
    hey, you need to screen the resume? ... That should go to the manager of
    the department and then plus plus ... if the person is an accounting
    associate, the accounting manager ... and anybody higher than that
    accounting manager. ... It needs to create a task that gets assigned to
    those people saying, screen this guy. ... There should be multiple
    assignees on it. ... Task to be completed one business day before the
    interview happens. ... When the interview actually gets scheduled, the
    task date needs to update automatically."

When a candidate is added, ONE task - "Screen <name>" - goes to the head of
the role's department and everyone above them in the reporting line, each
gets a bell, and it is due the business day before the expected interview
(the company's holidays skipped). When the interview is booked or moved, the
due date follows it. Rejecting or hiring the candidate closes it.

The managers never need Hiring access (Pranshu, Oct 15): the resume is
attached to the task, and every comment on the task lands on the candidate's
notes timeline - so the task IS their view of the candidate.
"""
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

import models

MAX_CHAIN = 8          # never walk a reporting line further (and never loop)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _person(db: Session, email: str) -> Optional[models.NexusEmployee]:
    e = (email or "").strip().lower()
    if not e:
        return None
    p = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == e).first()
    return p if p is not None and (p.status or "") in ("active", "onboarding") else None


def department_head(db: Session, cand: models.HrCandidate) -> str:
    """Who runs the department the role belongs to: the department's lead for
    the hiring company (Settings > Companies > Departments), else its backup, else
    the role's default manager - the same head -> backup order as checklist
    steps (Neil, Oct 22 6:52)."""
    import hr_checklists as hc
    dept = (cand.department or "").strip().lower()
    role = (db.query(models.NexusGroup).filter(models.NexusGroup.id == cand.role_id).first()
            if cand.role_id else None)
    if role is not None and (role.department or "").strip():
        dept = role.department.strip().lower()
    if dept and cand.company:
        for d in db.query(models.HrDepartment).filter(models.HrDepartment.company_id == cand.company).all():
            people = hc.active_people(db, [d.lead_email, d.backup_email]) if (d.name or "").strip().lower() == dept else []
            if people:
                return people[0]
    if role is not None and _person(db, role.default_manager_email):
        return role.default_manager_email.strip().lower()
    return ""


def screeners(db: Session, cand: models.HrCandidate) -> list:
    """The department head and everyone above them ("manager plus plus"),
    nearest first, then the company's HR contact; the Global Admins when
    nobody is set up."""
    out = []
    email = department_head(db, cand)
    while email and email not in out and len(out) < MAX_CHAIN:
        p = _person(db, email)
        if p is None:
            break
        out.append(email)
        email = (p.manager_email or "").strip().lower()
    # HR screens too (Neil, Oct 19: "step 2 is HR and or department head").
    if cand.company:
        ent = db.query(models.HrEntity).filter(models.HrEntity.id == cand.company).first()
        hr = (ent.hr_contact_email or "").strip().lower() if ent is not None else ""
        if hr and hr not in out and _person(db, hr):
            out.append(hr)
    # Nobody set up at all: the Global Admins are the stop gap (Neil, Oct 22).
    if not out:
        import hr_checklists as hc
        out = hc.global_admins(db)
    return out


def due_before(db: Session, company: str, day: str) -> str:
    """The business day before `day` (YYYY-MM-DD) - never before today."""
    import hr_checklists as hc
    try:
        d = datetime.strptime((day or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return ""
    hol = hc._holidays(db, company or "")
    d -= timedelta(days=1)
    guard = 0
    while not hc._workday(d, hol) and guard < 14:
        d -= timedelta(days=1)
        guard += 1
    return max(d, date.today()).isoformat()


def interview_day(db: Session, cand: models.HrCandidate) -> str:
    """The interview the screening has to beat: the next one booked, else the
    one expected on Add Candidate."""
    iv = (db.query(models.HrInterview)
          .filter(models.HrInterview.candidate_id == cand.id, models.HrInterview.status.in_(("scheduled", "live")))
          .order_by(models.HrInterview.at).first())
    if iv is not None and iv.at:
        return iv.at[:10]
    return (cand.expected_interview_on or "")[:10]


def _task(db: Session, cand: models.HrCandidate) -> Optional[models.Task]:
    tid = (cand.screen_task_id or "").strip()
    return db.query(models.Task).filter(models.Task.id == tid).first() if tid else None


def start(db: Session, cand: models.HrCandidate, by: str, bells: bool = True) -> Optional[models.Task]:
    """The screening task for a new candidate, and a bell for each screener.
    The caller commits, then queues notify_task_event for the task email.
    `bells=False` (careers-page applicants, Oct 27 2026): the task only - the
    opening's owner gets one grouped bell instead (hiring_openings.py)."""
    if _task(db, cand) is not None:
        return None
    who = screeners(db, cand)
    if not who:
        return None
    from routers.task_util import set_task_assignees
    from routers.tasks import _next_code
    name = f"{cand.first_name} {cand.last_name}".strip()
    role = cand.role_title or cand.department or "a role"
    expected = interview_day(db, cand)
    now = _now()
    task = models.Task(
        id=str(uuid.uuid4()), code=_next_code(db), company_id=cand.company or "",
        title=f"Screen {name} - {role}",
        description=(f"{name} applied for {role}. Their resume is attached. Read it and write your screening notes as "
                     f"comments on this task - they go straight onto the candidate's notes in Hiring" +
                     (f" - before the interview (expected {expected})" if expected else "") + ". "
                     f"Mark this task complete when you have screened them."),
        type="task", status="not_started", priority="medium", position=datetime.now().timestamp(),
        assignee_email="", assignee_emails=[], owner_email=(by or "").lower(), follower_emails=[],
        liked_by_emails=[], access_level="restricted", project_id="", project_ids=[], section_id="", team_id="",
        parent_task_id="", subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={}, tags=[],
        custom_field_values={}, start_on="", due_on=due_before(db, cand.company, expected) if expected else "",
        approval_status="none", completed=False, completed_at="", comment_ids=[], attachment_ids=[],
        activity_ids=[], created_at=now, modified_at=now, created_by=(by or "").lower())
    set_task_assignees(task, who)
    db.add(task)
    cand.screen_task_id = task.id
    if (cand.resume_url or "").strip() and not cand.resume_url.startswith("http"):
        # A resume already on file (an API caller, or an edit) rides along.
        from routers import esign
        from routers.hr import _DOC_BUCKET
        got = esign._storage_fetch(_DOC_BUCKET, cand.resume_url)
        if got.is_success and got.content:
            attach_resume(db, cand, cand.resume_url.rsplit("/", 1)[-1].split("-", 1)[-1], got.content,
                          "application/octet-stream", by)
    from routers.hr import _hr_notify
    from task_due import us_date
    for email in (who if bells else []):
        _hr_notify(db, email, f"Screen {name} - {role}",
                   f"A new candidate for {role}. Read the resume and add your notes before the interview"
                   + (f" - screening is due {us_date(task.due_on)}" if task.due_on else "") + ".",
                   ref_id=cand.id, requested_by=by, action={"view": "hr", "sub": "hr-hiring"})
    return task


def attach_resume(db: Session, cand: models.HrCandidate, name: str, raw: bytes, content_type: str, by: str,
                  replace: bool = True) -> bool:
    """The resume on the screening task, so the screeners read it from the task
    itself. A copy in the task-files bucket (private; task viewers open it
    through /files/view). replace=False (a careers re-apply, Oct 27 2026)
    adds it as an "Additional Resume" and leaves the one on file alone. The
    caller commits."""
    t = _task(db, cand)
    if t is None or not raw:
        return False
    import task_files
    url = task_files.store_bytes(name or "resume.pdf", raw, content_type or "application/octet-stream")
    if not url:
        return False                      # no storage here (a local backend) - the task still says to read it
    now = _now()
    if not replace:
        a = models.TaskAttachment(id=str(uuid.uuid4()), task_id=t.id,
                                  name=f"Additional Resume ({_us_today(now)}) - {name or 'resume.pdf'}",
                                  size=str(len(raw)), kind="doc", url=url, added_at=now, added_by=(by or "").lower())
        db.add(a)
        t.attachment_ids = list(t.attachment_ids or []) + [a.id]
        t.modified_at = now
        return True
    for old in db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == t.id,
                                                       models.TaskAttachment.name.like("Resume - %")).all():
        db.delete(old)                    # a replaced resume replaces the attachment
    a = models.TaskAttachment(id=str(uuid.uuid4()), task_id=t.id, name=f"Resume - {name or 'resume.pdf'}",
                              size=str(len(raw)), kind="doc", url=url, added_at=now, added_by=(by or "").lower())
    db.add(a)
    db.flush()
    t.attachment_ids = [i for i in (t.attachment_ids or []) if i not in
                        {o.id for o in db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == t.id)
                         .filter(models.TaskAttachment.id != a.id, models.TaskAttachment.name.like("Resume - %"))}] + [a.id]
    t.modified_at = now
    return True


def _us_today(iso: str) -> str:
    from task_due import us_date
    return us_date((iso or "")[:10])


def note_from_comment(db: Session, task_id: str, author: str, body: str) -> bool:
    """A comment on a screening task is a screening note: it goes on the
    candidate's timeline with who wrote it. The caller commits."""
    from task_mail_actions import _plain
    text = _plain(body, 4000)                         # comments are HTML; the timeline shows text
    if not task_id or not text:
        return False
    cand = db.query(models.HrCandidate).filter(models.HrCandidate.screen_task_id == task_id).first()
    if cand is None:
        return False
    now = _now()
    db.add(models.HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage, to_stage=cand.stage,
                               note=text[:4000], by_email=(author or "").lower(), created_at=now, kind="note"))
    cand.updated_at = now
    return True


def follow_interview(db: Session, cand: models.HrCandidate) -> None:
    """The interview was booked, moved or the expected date changed: the
    screening is due the business day before it. The caller commits."""
    t = _task(db, cand)
    day = interview_day(db, cand)
    if t is None or t.completed or not day:
        return
    due = due_before(db, cand.company, day)
    if due and due != (t.due_on or ""):
        t.due_on, t.modified_at = due, _now()


def close(db: Session, cand: models.HrCandidate) -> None:
    """Rejected or hired: nothing left to screen. The caller commits."""
    t = _task(db, cand)
    if t is None or t.completed:
        return
    t.completed, t.completed_at, t.status, t.modified_at = True, _now(), "completed", _now()
