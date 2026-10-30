"""Performance: improvement plans (Neil, Oct 29 2026: "add all the bigger
features"). routers/perf_feedback.py is the API.

A plan is plain: why (the reason), what has to change (a short list of
expectations, each with how it is measured), what support the company
gives, a start and an end date. The flow is the probation rule
(hr_probation): a manager RECOMMENDS, HR++ (performance.hr_for - the
company's HR contact, an administrator / owner, a Full HR grant, in
People scope) FINALIZES.

  Draft      the employee's direct manager (or HR) writes it. Only they and
             HR see it.
  With HR    the manager sends it to HR (HR's own drafts skip this).
  Active     HR starts it: the employee gets a bell, reads it and clicks
             Acknowledge (with optional comments). Acknowledging means they
             read it, not that they agree. The manager and HR add check-ins;
             HR may extend the end date (a reason is required).
  Closed     HR closes it with an outcome - Met, Not Met or Canceled - and a
             result per expectation. Not Met does nothing by itself: ending
             employment is the Offboard flow in People, never a second path.

WHO SEES WHAT - the employee (once started; never a draft), their manager
when it was drafted, their manager now, whoever drafted it, and HR for the
company. Not the rest of the reporting chain: a plan is between the three.
Nothing is ever deleted; a draft that is dropped is closed as Canceled.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
import performance as perf

STATUS_LABELS = {"draft": "Draft", "proposed": "With HR", "active": "Active", "closed": "Closed"}
OUTCOME_LABELS = {"met": "Met", "not_met": "Not Met", "canceled": "Canceled"}
RESULT_LABELS = {"met": "Met", "not": "Not Met"}
MAX_EXPECTATIONS = 10
DEFAULT_TITLE = "Performance Improvement Plan"


def _low(s) -> str:
    return (s or "").strip().lower()


def _day(s) -> str:
    v = (s or "").strip()[:10]
    if v:
        try:
            date.fromisoformat(v)
        except ValueError:
            raise HTTPException(400, "Pick a valid date.")
    return v


def _tell(db: Session, to: str, key: str, title: str, line: str, sub: str, company: str = "") -> None:
    import notify_rollup
    if to:
        notify_rollup.upsert_rollup(db, recipient=to, key=key, title=title, line=line,
                                    action={"view": "myhr", "sub": sub}, company=company)


def _log(p: models.PerfPlan, by: str, action: str, note: str = "") -> None:
    p.history = list(p.history or []) + [{"at": perf.now_iso(), "by": _low(by), "action": action, "note": (note or "")[:1000]}]
    p.updated_at = perf.now_iso()


class Seat:
    def __init__(self, db: Session, user: dict, p: models.PerfPlan):
        me = _low(user.get("email"))
        self.me = me
        self.employee = me == _low(p.employee_email)
        emp = perf.employee(db, p.employee_email)
        now_mgr = _low(emp.manager_email) if emp else ""
        self.manager = not self.employee and me in {_low(p.manager_email), now_mgr, _low(p.created_by)} - {""}
        self.hr = not self.employee and perf.hr_for(db, user, p.company_id or "")
        started = p.status in ("active", "closed") and bool(p.started_at)
        self.any = not user.get("external") and (self.manager or self.hr or (self.employee and started))


def seat_or_404(db: Session, user: dict, p: Optional[models.PerfPlan]) -> Seat:
    if p is None:
        raise HTTPException(404, "Plan not found")
    s = Seat(db, user, p)
    if not s.any:
        raise HTTPException(404, "Plan not found")
    return s


def hr_recipients(db: Session, company_id: str) -> list:
    ent = db.get(models.HrEntity, company_id) if company_id else None
    hr = _low(ent.hr_contact_email if ent else "")
    return [hr] if hr else []


def _expectations(items) -> list:
    out = []
    for it in (items or [])[:MAX_EXPECTATIONS]:
        if not isinstance(it, dict):
            continue
        text = (it.get("text") or "").strip()
        if not text:
            continue
        res = it.get("result") or ""
        out.append({"id": (it.get("id") or perf.new_id())[:64], "text": text[:500],
                    "measure": (it.get("measure") or "").strip()[:500],
                    "result": res if res in RESULT_LABELS else ""})
    return out


def create(db: Session, user: dict, *, employee: str, title: str = "", reason: str = "", expectations=None,
           support: str = "", start_on: str = "", end_on: str = "") -> models.PerfPlan:
    me = _low(user.get("email"))
    who = _low(employee)
    emp = perf.employee(db, who)
    if emp is None or not perf._active(emp) or who == me:
        raise HTTPException(400, "Pick someone on your team.")
    if not (perf.is_direct_manager(db, me, who) or perf.hr_for_person(db, user, who)):
        raise HTTPException(403, "An improvement plan is drafted by the person's manager or HR.")
    P = models.PerfPlan
    if db.query(P).filter(P.employee_email == who, P.status.in_(("draft", "proposed", "active"))).first() is not None:
        raise HTTPException(409, "They already have an open improvement plan - open that one.")
    now = perf.now_iso()
    p = P(id=perf.new_id(), company_id=emp.company or "", employee_email=who, manager_email=_low(emp.manager_email),
          created_by=me, title=(title or "").strip()[:200] or DEFAULT_TITLE, reason=(reason or "").strip()[:8000],
          expectations=_expectations(expectations), support=(support or "").strip()[:8000],
          start_on=_day(start_on), end_on=_day(end_on), status="draft", checkins=[], history=[],
          created_at=now, updated_at=now)
    _log(p, me, "drafted")
    db.add(p)
    return p


def update(db: Session, user: dict, p: models.PerfPlan, data: dict) -> None:
    s = seat_or_404(db, user, p)
    if not (s.manager or s.hr):
        raise HTTPException(403, "Only the manager and HR change a plan.")
    if p.status not in ("draft", "proposed"):
        raise HTTPException(409, "A started plan keeps its wording - add a check-in, or HR extends it.")
    if p.status == "proposed" and not s.hr:
        raise HTTPException(409, "It is with HR now.")
    if "title" in data:
        p.title = (data["title"] or "").strip()[:200] or DEFAULT_TITLE
    for k in ("reason", "support"):
        if k in data:
            setattr(p, k, (data[k] or "").strip()[:8000])
    if "expectations" in data:
        p.expectations = _expectations(data["expectations"])
    for k in ("start_on", "end_on"):
        if k in data:
            setattr(p, k, _day(data[k]))
    p.updated_at = perf.now_iso()


def _ready(p: models.PerfPlan) -> None:
    if len((p.reason or "").strip()) < 3:
        raise HTTPException(400, "Say why the plan is needed.")
    if not p.expectations:
        raise HTTPException(400, "Add at least one expectation.")
    if not p.start_on or not p.end_on:
        raise HTTPException(400, "Set the start and end dates.")
    if p.end_on <= p.start_on:
        raise HTTPException(400, "The end date comes after the start date.")


def send_to_hr(db: Session, user: dict, p: models.PerfPlan) -> None:
    s = seat_or_404(db, user, p)
    if not s.manager:
        raise HTTPException(403, "The manager sends the plan to HR.")
    if p.status != "draft":
        raise HTTPException(409, "Only a draft goes to HR.")
    _ready(p)
    p.status = "proposed"
    _log(p, s.me, "sent_to_hr")
    for to in hr_recipients(db, p.company_id or ""):
        _tell(db, to, "perf-plan-hr", "Improvement Plans to Start",
              f"{perf.name_of(db, s.me)} sent an improvement plan for {perf.name_of(db, p.employee_email)}.",
              f"performance:plan:{p.id}", p.company_id or "")


def start(db: Session, user: dict, p: models.PerfPlan) -> None:
    s = seat_or_404(db, user, p)
    if not s.hr:
        raise HTTPException(403, "HR starts an improvement plan.")
    if p.status not in ("draft", "proposed"):
        raise HTTPException(409, "This plan already started.")
    _ready(p)
    p.status, p.started_at, p.started_by = "active", perf.now_iso(), s.me
    _log(p, s.me, "started")
    _tell(db, p.employee_email, f"perf-plan:{p.id}", "Your Improvement Plan",
          "Your manager and HR set up an improvement plan with you. Read it and acknowledge it.",
          f"performance:plan:{p.id}", p.company_id or "")
    if p.manager_email and p.manager_email != s.me:
        _tell(db, p.manager_email, f"perf-plan:{p.id}", "Improvement Plan Started",
              f"HR started the improvement plan for {perf.name_of(db, p.employee_email)}.",
              f"performance:plan:{p.id}", p.company_id or "")


def acknowledge(db: Session, user: dict, p: models.PerfPlan, comment: str) -> None:
    s = seat_or_404(db, user, p)
    if not s.employee:
        raise HTTPException(403, "The employee acknowledges their plan.")
    if p.status != "active" or p.acknowledged_at:
        raise HTTPException(409, "Nothing to acknowledge.")
    p.acknowledged_at, p.employee_comment = perf.now_iso(), (comment or "").strip()[:4000]
    _log(p, s.me, "acknowledged")


def checkin(db: Session, user: dict, p: models.PerfPlan, note: str) -> None:
    s = seat_or_404(db, user, p)
    if not (s.manager or s.hr):
        raise HTTPException(403, "The manager and HR add check-ins.")
    if p.status != "active":
        raise HTTPException(409, "Check-ins go on an active plan.")
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(400, "Write the check-in first.")
    p.checkins = list(p.checkins or []) + [{"id": perf.new_id(), "at": perf.now_iso(), "by": s.me, "note": note[:4000]}]
    p.updated_at = perf.now_iso()
    _tell(db, p.employee_email, f"perf-plan:{p.id}", "Your Improvement Plan",
          f"{perf.name_of(db, s.me)} added a check-in to your improvement plan.", f"performance:plan:{p.id}", p.company_id or "")


def extend(db: Session, user: dict, p: models.PerfPlan, end_on: str, note: str) -> None:
    s = seat_or_404(db, user, p)
    if not s.hr:
        raise HTTPException(403, "HR extends a plan.")
    if p.status != "active":
        raise HTTPException(409, "Only an active plan is extended.")
    end = _day(end_on)
    if not end or end <= (p.end_on or ""):
        raise HTTPException(400, "Pick a later end date.")
    if len((note or "").strip()) < 3:
        raise HTTPException(400, "Say why it is extended.")
    from perf_reviews import us_date
    _log(p, s.me, "extended", f"{us_date(p.end_on)} to {us_date(end)}: {note.strip()}")
    p.end_on = end
    _tell(db, p.employee_email, f"perf-plan:{p.id}", "Your Improvement Plan",
          f"Your improvement plan now ends {us_date(end)}.", f"performance:plan:{p.id}", p.company_id or "")


def close(db: Session, user: dict, p: models.PerfPlan, outcome: str, note: str, results: Optional[dict] = None) -> None:
    s = seat_or_404(db, user, p)
    if outcome == "canceled" and p.status in ("draft", "proposed"):
        if not (s.manager or s.hr):
            raise HTTPException(403, "Only the manager and HR drop a draft.")
    elif not s.hr:
        raise HTTPException(403, "HR closes an improvement plan.")
    if p.status == "closed":
        raise HTTPException(409, "This plan is closed.")
    if outcome not in OUTCOME_LABELS:
        raise HTTPException(400, "Pick Met, Not Met or Canceled.")
    if p.status == "active" and outcome != "canceled" and len((note or "").strip()) < 3:
        raise HTTPException(400, "Write the outcome first.")
    if results:
        p.expectations = [{**e, "result": results.get(e["id"]) if results.get(e["id"]) in RESULT_LABELS else e.get("result", "")}
                          for e in (p.expectations or [])]
    was_active = p.status == "active"
    p.status, p.outcome, p.outcome_note = "closed", outcome, (note or "").strip()[:4000]
    p.closed_at, p.closed_by = perf.now_iso(), s.me
    _log(p, s.me, f"closed_{outcome}", note)
    if was_active:
        _tell(db, p.employee_email, f"perf-plan:{p.id}", "Your Improvement Plan",
              f"Your improvement plan is closed: {OUTCOME_LABELS[outcome]}.", f"performance:plan:{p.id}", p.company_id or "")
        if p.manager_email and p.manager_email != s.me:
            _tell(db, p.manager_email, f"perf-plan:{p.id}", "Improvement Plan Closed",
                  f"The improvement plan for {perf.name_of(db, p.employee_email)} is closed: {OUTCOME_LABELS[outcome]}.",
                  f"performance:plan:{p.id}", p.company_id or "")


ACTION_WORDS = {"drafted": "Drafted", "sent_to_hr": "Sent to HR", "started": "Started", "acknowledged": "Acknowledged",
                "extended": "Extended", "closed_met": "Closed - Met", "closed_not_met": "Closed - Not Met",
                "closed_canceled": "Canceled"}


def plan_out(db: Session, user: dict, p: models.PerfPlan, s: Optional[Seat] = None) -> dict:
    s = s or Seat(db, user, p)
    today = date.today().isoformat()
    out = {
        "id": p.id, "companyId": p.company_id or "", "employeeEmail": p.employee_email,
        "employeeName": perf.name_of(db, p.employee_email), "managerEmail": p.manager_email or "",
        "managerName": perf.name_of(db, p.manager_email) if p.manager_email else "",
        "createdBy": p.created_by or "", "createdByName": perf.name_of(db, p.created_by) if p.created_by else "",
        "title": p.title or DEFAULT_TITLE, "reason": p.reason or "", "support": p.support or "",
        "expectations": list(p.expectations or []), "startOn": p.start_on or "", "endOn": p.end_on or "",
        "status": p.status, "statusLabel": STATUS_LABELS.get(p.status, p.status),
        "outcome": p.outcome or "", "outcomeLabel": OUTCOME_LABELS.get(p.outcome or "", ""), "outcomeNote": p.outcome_note or "",
        "checkins": [{**c, "byName": perf.name_of(db, c.get("by"))} for c in (p.checkins or [])],
        "startedAt": p.started_at or "", "acknowledgedAt": p.acknowledged_at or "", "employeeComment": p.employee_comment or "",
        "closedAt": p.closed_at or "", "pastEnd": p.status == "active" and bool(p.end_on) and p.end_on < today,
        "role": {"employee": s.employee, "manager": s.manager, "hr": s.hr},
        "can": {
            "edit": (p.status == "draft" and (s.manager or s.hr)) or (p.status == "proposed" and s.hr),
            "sendToHr": p.status == "draft" and s.manager and not s.hr,
            "start": p.status in ("draft", "proposed") and s.hr,
            "drop": p.status in ("draft", "proposed") and (s.manager or s.hr),
            "acknowledge": s.employee and p.status == "active" and not p.acknowledged_at,
            "checkin": p.status == "active" and (s.manager or s.hr),
            "extend": p.status == "active" and s.hr,
            "close": p.status == "active" and s.hr,
        },
    }
    if not s.employee:
        out["history"] = [{**h, "byName": perf.name_of(db, h.get("by")) if h.get("by") else "Nexus",
                           "label": ACTION_WORDS.get(h.get("action"), h.get("action"))} for h in (p.history or [])]
    return out


def plans_for(db: Session, user: dict, *, person: str = "", company: str = "") -> list:
    """`person`: their plans as far as the viewer may read them; '' and no
    company: the caller's own (started) plans and the ones they manage;
    `company`: HR's list for one company."""
    me = _low(user.get("email"))
    P = models.PerfPlan
    if company:
        if not perf.hr_for(db, user, company):
            raise HTTPException(404, "Company not found")
        rows = db.query(P).filter(P.company_id == company).order_by(P.updated_at.desc()).limit(300).all()
    elif person:
        rows = db.query(P).filter(P.employee_email == _low(person)).order_by(P.created_at.desc()).all()
    else:
        rows = db.query(P).filter((P.employee_email == me) | (P.manager_email == me) | (P.created_by == me)) \
            .order_by(P.updated_at.desc()).limit(100).all()
    out = []
    for p in rows:
        s = Seat(db, user, p)
        if s.any:
            out.append(plan_out(db, user, p, s))
    return out


def waiting_on(db: Session, user: dict) -> list:
    """(kind, plan) waiting on the caller (approvals_inbox): their own plan to
    acknowledge; as HR, plans sent to start and active plans past their end."""
    me = _low(user.get("email"))
    P = models.PerfPlan
    out = [("acknowledge", p) for p in db.query(P).filter(P.employee_email == me, P.status == "active",
                                                          P.acknowledged_at == "").all()]
    if perf.hr_reach(db, user) is False:
        return out
    today = date.today().isoformat()
    for p in db.query(P).filter(P.status.in_(("proposed", "active"))).limit(300).all():
        if p.employee_email == me or not perf.hr_for(db, user, p.company_id or ""):
            continue
        if p.status == "proposed":
            out.append(("start", p))
        elif p.end_on and p.end_on < today:
            out.append(("close", p))
    return out
