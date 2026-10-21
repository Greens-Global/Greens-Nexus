"""The Decision step after the interview (Neil, Oct 19 2026).

    "It should be interview over and then you take a decision ... anybody who
    is in the interview should be able to give a thumbs up or a thumbs down
    ... it should mandate people to say, hey, do you want this person or not
    ... and then add notes as to why. And then there is a final call that's
    made by the department head."

When the interview is over the candidate moves to Decision and ONE task -
"Decide on <name>" - goes to everyone who interviewed them plus the head of
the role's department. Interviewers and the head never need Hiring access
(Pranshu, Oct 20: feedback through the task): each answers with a comment
that starts with Yes or No and says why. Every comment lands on the
candidate's notes; a Yes / No is counted as that person's vote (their latest
one wins). The department head's Yes / No is the final call: it is recorded
on the candidate, closes the task and tells HR, who then makes the offer or
rejects.
"""
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

import models
from hiring_screening import _person, department_head

# "yes", "Yes - strong", "no.", "hire", "reject", a thumbs emoji...
_YES = re.compile(r"^\s*(?:yes|yep|hire|approve|approved|thumbs up|\U0001F44D)(?![a-z])", re.I)
_NO = re.compile(r"^\s*(?:no|nope|reject|rejected|pass|thumbs down|\U0001F44E)(?![a-z])", re.I)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_vote(text: str) -> str:
    """'yes' | 'no' | '' from the start of a comment."""
    if _YES.match(text or ""):
        return "yes"
    if _NO.match(text or ""):
        return "no"
    return ""


def interviewers(db: Session, cand: models.HrCandidate) -> list:
    """Everyone a round (not canceled) was with, in order, active people only."""
    out = []
    for iv in (db.query(models.HrInterview).filter(models.HrInterview.candidate_id == cand.id,
                                                   models.HrInterview.status != "canceled")
               .order_by(models.HrInterview.at).all()):
        for e in iv.interviewer_emails or []:
            e = (e or "").strip().lower()
            if e and e not in out and _person(db, e):
                out.append(e)
    return out


def decider(db: Session, cand: models.HrCandidate) -> str:
    """The department head; the company's HR contact when no head is set up."""
    head = department_head(db, cand)
    if head:
        return head
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == cand.company).first() if cand.company else None
    return ent.hr_contact_email.strip().lower() if ent is not None and _person(db, ent.hr_contact_email) else ""


def _next_workday(db: Session, company: str) -> str:
    import hr_checklists as hc
    hol = hc._holidays(db, company or "")
    d = date.today() + timedelta(days=1)
    guard = 0
    while not hc._workday(d, hol) and guard < 14:
        d += timedelta(days=1)
        guard += 1
    return d.isoformat()


def _task(db: Session, cand: models.HrCandidate) -> Optional[models.Task]:
    tid = (cand.decision_task_id or "").strip()
    return db.query(models.Task).filter(models.Task.id == tid).first() if tid else None


def enter(db: Session, cand: models.HrCandidate, by: str, note: str = "") -> Optional[models.Task]:
    """Move the candidate to Decision and open the "Decide on" task. Returns
    the new task (the caller commits, then queues notify_task_event)."""
    now = _now()
    if cand.stage != "decision":
        db.add(models.HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                                   to_stage="decision", note=note or "Interview over - waiting on the decision",
                                   by_email=(by or "").lower(), created_at=now))
        cand.stage = "decision"
    # A fresh decision every time they come back to this step.
    cand.decision, cand.decision_by, cand.decision_at, cand.decision_note = "", "", "", ""
    cand.updated_at = now
    close(db, cand)
    head = decider(db, cand)
    who = interviewers(db, cand)
    if head and head not in who:
        who.append(head)
    if not who:
        return None
    from routers.task_util import set_task_assignees
    from routers.tasks import _next_code
    name = f"{cand.first_name} {cand.last_name}".strip()
    role = cand.role_title or cand.department or "the role"
    head_name = _name(db, head) if head else "the department head"
    task = models.Task(
        id=str(uuid.uuid4()), code=_next_code(db), company_id=cand.company or "",
        title=f"Decide on {name} - {role}",
        description=(f"The interview with {name} for {role} is over. Do you want to hire them? Answer with a comment "
                     f"that starts with Yes or No, then say why - for example \"Yes - strong on Intacct\". "
                     f"Everyone who interviewed them answers. {head_name} makes the final call: their Yes or No "
                     f"decides, and HR takes it from there. Your comments go onto the candidate's notes in Hiring."),
        type="task", status="not_started", priority="high", position=datetime.now().timestamp(),
        assignee_email="", assignee_emails=[], owner_email=(by or "").lower(), follower_emails=[],
        liked_by_emails=[], access_level="restricted", project_id="", project_ids=[], section_id="", team_id="",
        parent_task_id="", subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={}, tags=[],
        custom_field_values={}, start_on="", due_on=_next_workday(db, cand.company),
        approval_status="none", completed=False, completed_at="", comment_ids=[], attachment_ids=[],
        activity_ids=[], created_at=now, modified_at=now, created_by=(by or "").lower())
    set_task_assignees(task, who)
    db.add(task)
    cand.decision_task_id = task.id
    from routers.hr import _hr_notify
    for email in who:
        final = email == head
        _hr_notify(db, email, f"Decide on {name} - {role}",
                   (f"You make the final call on {name}. Answer Yes or No and why on the task." if final
                    else f"Do you want to hire {name}? Answer Yes or No and why on the task."),
                   ref_id=cand.id, requested_by=by, action={"view": "tasks", "sub": "mine", "taskId": task.id})
    return task


def _name(db: Session, email: str) -> str:
    p = _person(db, email)
    return (f"{p.first_name or ''} {p.last_name or ''}".strip() or email) if p else email


def vote_from_comment(db: Session, task_id: str, author: str, body: str) -> bool:
    """A comment on a "Decide on" task: a note on the candidate's timeline, a
    vote when it starts with Yes / No, and the final call when it is the
    department head's. The caller commits."""
    from task_mail_actions import _plain
    text = _plain(body, 4000)
    if not task_id or not text:
        return False
    cand = db.query(models.HrCandidate).filter(models.HrCandidate.decision_task_id == task_id).first()
    if cand is None:
        return False
    who = (author or "").lower()
    vote = parse_vote(text)
    now = _now()
    db.add(models.HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                               to_stage=cand.stage, note=text[:4000], by_email=who, created_at=now,
                               kind="vote" if vote else "note"))
    cand.updated_at = now
    if vote and cand.stage == "decision" and not cand.decision and who == decider(db, cand):
        cand.decision, cand.decision_by, cand.decision_at, cand.decision_note = \
            ("hire" if vote == "yes" else "reject"), who, now, text[:4000]
        t = _task(db, cand)
        if t is not None and not t.completed:
            t.completed, t.completed_at, t.status, t.modified_at = True, now, "completed", now
        _tell_hr(db, cand, who)
    return True


def _tell_hr(db: Session, cand: models.HrCandidate, by: str) -> None:
    from routers.hr import _hr_notify
    name = f"{cand.first_name} {cand.last_name}".strip()
    verdict = "Hire" if cand.decision == "hire" else "Reject"
    nxt = "make the offer" if cand.decision == "hire" else "reject them on their card"
    to = {(cand.created_by or "").lower()}
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == cand.company).first() if cand.company else None
    if ent is not None:
        to.add((ent.hr_contact_email or "").lower())
    for email in to - {"", by}:
        _hr_notify(db, email, f"Final Call On {name}: {verdict}",
                   f"{_name(db, by)} decided: {verdict}. Open {name} in Hiring and {nxt}.",
                   ref_id=cand.id, requested_by=by, action={"view": "hr", "sub": "hr-hiring"})


def summary(db: Session, cand: models.HrCandidate) -> dict:
    """Who said what for the candidate card: each interviewer's latest vote,
    who has not answered, and the final call."""
    head = decider(db, cand)
    people = interviewers(db, cand)
    if head and head not in people:
        people.append(head)
    since = ""
    entered = (db.query(models.HrStageEvent).filter(models.HrStageEvent.candidate_id == cand.id,
                                                    models.HrStageEvent.to_stage == "decision",
                                                    models.HrStageEvent.kind == "")
               .order_by(models.HrStageEvent.created_at.desc()).first())
    if entered is not None:
        since = entered.created_at or ""
    latest = {}
    for ev in (db.query(models.HrStageEvent).filter(models.HrStageEvent.candidate_id == cand.id,
                                                    models.HrStageEvent.kind == "vote",
                                                    models.HrStageEvent.created_at >= since)
               .order_by(models.HrStageEvent.created_at).all()):
        latest[(ev.by_email or "").lower()] = ev
    rows = []
    for e in people + [e for e in latest if e not in people]:
        ev = latest.get(e)
        rows.append({"email": e, "name": _name(db, e), "final": e == head,
                     "vote": parse_vote(ev.note) if ev else "", "note": ev.note if ev else "",
                     "at": ev.created_at if ev else ""})
    t = _task(db, cand)
    return {"decider": head, "deciderName": _name(db, head) if head else "", "votes": rows,
            "decision": cand.decision or "", "decisionBy": cand.decision_by or "",
            "decisionByName": _name(db, cand.decision_by) if cand.decision_by else "",
            "decisionAt": cand.decision_at or "", "decisionNote": cand.decision_note or "",
            "taskId": t.id if t is not None else "", "taskCode": t.code if t is not None else ""}


def close(db: Session, cand: models.HrCandidate) -> None:
    """Left Decision (offer, rejected, another round...): nothing left to
    decide on the old task. The caller commits."""
    t = _task(db, cand)
    if t is None or t.completed:
        return
    now = _now()
    t.completed, t.completed_at, t.status, t.modified_at = True, now, "completed", now
