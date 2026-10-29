"""Performance reviews, made simple (Neil, Oct 29 2026: "this really needs
to be easy and it needs to provide some real metrics from Nexus. Just make
sure this is as simplistic as possible." Spec:
docs/superpowers/specs/2026-10-29-performance-simple-design.md). The engine
behind routers/perf_reviews.py; goals and 1:1s are performance.py, the
numbers perf_metrics.py - this file reuses their people rules (chain,
hr_reach) so "who sees what" is one rule.

A CYCLE is three fields - name, company, due date - and starts at once.
Everyone active at that company who is past probation and not a
contractor / external / guest is in it; someone who joins the company before
it closes is added by the loop; HR may take someone out ("removed" - the row
is kept). The period defaults to the six months ending today.

ONE FORM, the same three questions for both sides - What went well? What
could be better? What should the focus be next? - with the person's Nexus
numbers for the period and their goals for it shown beside it. The manager
adds a score per goal (Met / Partly Met / Not Met), one Overall Rating in
four words (Exceeds / Meets / Partly Meets / Below), an optional Ready for
Promotion, and an optional private note that only HR reads.

THE FLOW, per person
  Self Review      the employee writes theirs (due a week before the due
                   date). Optional for the manager: once the self review is
                   submitted, or its due day has passed, the manager writes.
  Manager Review   the manager (Reports To when the person joined the cycle;
                   HR writes it when there is none) writes theirs.
  Ready to Share   submitted; HR reads it, may return it to the manager, and
                   shares it - one at a time or Share All Ready.
  Shared           the employee reads it, adds Your Comments if they wish,
                   and clicks Acknowledge: the review (with their comments)
                   becomes a PDF in Nexus Sign with the EMPLOYEE AS THE ONLY
                   SIGNER (Neil, Oct 22: the company never signs before the
                   employee - here it does not sign at all). Signing means
                   they read it, not that they agree.
  Acknowledged     signed ("complete").

REMINDERS are automatic (loop_pass, from performance_loop, bells through
notify_rollup - one notice per person per cycle, rewritten): at launch to the
employee and the writer; three days before each due date and on it, to
whoever still owes; when shared, to the employee. Each goes out once.

WHO SEES WHAT
  the employee     their own self review any time; the manager's part once
                   shared; never the private note or Ready for Promotion;
  the writer       the self review once submitted, everything they write;
  above the writer (the reporting chain) the review once the manager
                   submitted it, the self review once shared;
  HR for the company everything;
  anybody else - 404.
"""
from __future__ import annotations

import io
import uuid
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import performance as perf

STAGES = ("self_review", "manager_review", "ready", "shared", "complete")
STAGE_LABELS = {"self_review": "Self Review", "manager_review": "Manager Review", "ready": "Ready to Share",
                "shared": "Shared", "complete": "Acknowledged", "removed": "Removed",
                "hr_review": "Ready to Share"}
OPEN_STAGES = ("self_review", "manager_review", "ready")
UNFINISHED = OPEN_STAGES + ("shared",)   # what a Close asks about
QUESTIONS = [
    {"id": "well", "kind": "text", "text": "What went well?"},
    {"id": "better", "kind": "text", "text": "What could be better?"},
    {"id": "next", "kind": "text", "text": "What should the focus be next?"},
]
RATINGS = [("exceeds", "Exceeds"), ("meets", "Meets"), ("partly", "Partly Meets"), ("below", "Below")]
RATING_LABELS = dict(RATINGS)
GOAL_SCORES = [("met", "Met"), ("partly", "Partly Met"), ("not", "Not Met")]
GOAL_SCORE_LABELS = dict(GOAL_SCORES)
SELF_LEAD_DAYS = 7          # the self review is due this many days before the due date
SOON_DAYS = 3               # "due in 3 days" reminder
PERIOD_MONTHS = 6
LINK_KIND = "perf_review"
ACK_STATEMENT = ("My signature means I have received and read this performance review. It does not mean "
                 "I agree with everything in it.")


def _now() -> str:
    return perf.now_iso()


def _low(s) -> str:
    return (s or "").strip().lower()


def us_date(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def today() -> str:
    return perf.local_today()


def _add_days(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def default_period(on: Optional[str] = None) -> tuple:
    """The six months ending today."""
    end = date.fromisoformat(on or today())
    m = end.month - 1 - PERIOD_MONTHS
    y, m = end.year + m // 12, m % 12 + 1
    import calendar
    start = end.replace(year=y, month=m, day=min(end.day, calendar.monthrange(y, m)[1])) + timedelta(days=1)
    return start.isoformat(), end.isoformat()


def self_due_for(due: str, on: Optional[str] = None) -> str:
    """A week before the due date - never before today."""
    on = on or today()
    return max(on, _add_days(due, -SELF_LEAD_DAYS)) if due else ""


def require_hr(db: Session, user: dict, company_id: str) -> None:
    if not perf.hr_for(db, user, company_id or ""):
        raise HTTPException(403, "Review cycles are run by HR for the company.")


# ── Who is in it ─────────────────────────────────────────────────────────────

def eligible(emp, on: Optional[str] = None) -> bool:
    """Active, internal, has a work email, already started, not a
    contractor, and past probation (someone still on probation is being
    looked at already - hr_probation)."""
    import hr_probation
    on = on or today()
    if (emp.status or "active") != "active" or (emp.identity_type or "internal") != "internal":
        return False
    if not _low(emp.work_email) or (emp.employment_type or "full_time") == "contractor":
        return False
    if (emp.start_date or "")[:10] > on:
        return False
    return (hr_probation.record(emp).get("status") or "") not in hr_probation.OPEN


def participants(db: Session, cycle: models.PerfReviewCycle) -> list:
    rows = db.query(models.NexusEmployee).filter(models.NexusEmployee.company == cycle.company_id).all()
    on = today()
    out = [e for e in rows if eligible(e, on)]
    out.sort(key=lambda e: perf.name_of(db, e.work_email).lower())
    return out


def _tell(db: Session, to: str, key: str, title: str, line: str, sub: str, company: str, replace: bool = False) -> None:
    import notify_rollup
    if not to:
        return
    notify_rollup.upsert_rollup(db, recipient=to, key=key, title=title, line=line,
                                action={"view": "myhr", "sub": sub}, company=company, replace=replace)


def _round(r: models.PerfReview, by: str, action: str, note: str = "") -> None:
    r.history = list(r.history or []) + [{"at": _now(), "by": _low(by), "action": action, "note": (note or "")[:500]}]
    r.updated_at = _now()


def hr_recipients(db: Session, cycle: models.PerfReviewCycle) -> list:
    """Who hears that a review waits on HR: the company's HR contact, else
    whoever started the cycle."""
    ent = db.get(models.HrEntity, cycle.company_id) if cycle.company_id else None
    hr = _low(ent.hr_contact_email if ent else "")
    return [hr] if hr else [x for x in {_low(cycle.launched_by), _low(cycle.created_by)} if x][:1]


def writer_of(db: Session, r: models.PerfReview, cycle: models.PerfReviewCycle) -> list:
    """Who writes the manager review: the reviewer, else HR."""
    return [r.manager_email] if r.manager_email else hr_recipients(db, cycle)


def _mark(r: models.PerfReview, key: str) -> bool:
    """Record that a reminder went out; False when it already had."""
    sent = dict(r.reminded or {})
    if sent.get(key):
        return False
    sent[key] = _now()
    r.reminded = sent
    return True


def _new_review(db: Session, cycle: models.PerfReviewCycle, e, by: str) -> models.PerfReview:
    email = _low(e.work_email)
    now = _now()
    r = models.PerfReview(id=perf.new_id(), cycle_id=cycle.id, company_id=cycle.company_id, employee_email=email,
                          manager_email=_low(e.manager_email) if _low(e.manager_email) != email else "",
                          stage="self_review", self_answers={}, self_values={}, manager_answers={},
                          manager_values={}, goals_snapshot=[], history=[], goal_scores={}, reminded={},
                          rating="", promotion_ready=False, employee_comment="", removed_at="",
                          created_at=now, updated_at=now, self_submitted_at="", manager_submitted_at="",
                          manager_submitted_by="", finalized_at="", finalized_by="", sign_request_id="",
                          shared_at="", completed_at="", nudged_at="", hr_note="", manager_summary="",
                          manager_private_note="")
    _round(r, by, "launched")
    db.add(r)
    # Launch: the employee and the writer each hear once.
    _mark(r, "launch")
    _tell(db, email, f"perf-review:{cycle.id}", "Your Review Has Started",
          f"{cycle.name}: write your self review by {us_date(cycle.self_due)} - three short questions.",
          f"performance:review:{r.id}", cycle.company_id, replace=True)
    for w in writer_of(db, r, cycle):
        _tell(db, w, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"{cycle.name}: write the review of {perf.name_of(db, email)} by {us_date(cycle.manager_due)}.",
              f"performance:review:{r.id}", cycle.company_id)
    return r


def sync_members(db: Session, cycle: models.PerfReviewCycle, by: str = "") -> int:
    """Add everyone who belongs in an active cycle and is not in it yet - a
    late joiner included. Someone HR removed stays removed (their row is
    kept, stage "removed")."""
    if cycle.status != "active":
        return 0
    have = {r.employee_email for r in db.query(models.PerfReview.employee_email)
            .filter(models.PerfReview.cycle_id == cycle.id).all()}
    n = 0
    for e in participants(db, cycle):
        if _low(e.work_email) in have:
            continue
        _new_review(db, cycle, e, by or cycle.launched_by or "")
        n += 1
    return n


def start_cycle(db: Session, user: dict, *, company_id: str, name: str, due: str,
                period_start: str = "", period_end: str = "") -> models.PerfReviewCycle:
    """HR's New Review Cycle: name, company, due date - it starts at once."""
    require_hr(db, user, company_id)
    if not (name or "").strip():
        raise HTTPException(400, "Name the review.")
    on = today()
    if not due:
        raise HTTPException(400, "Pick the due date.")
    if due < on:
        raise HTTPException(400, "The due date has passed - pick one ahead.")
    ps, pe = period_start, period_end
    if not (ps and pe):
        ps, pe = default_period(on)
    if pe < ps:
        raise HTTPException(400, "The period ends before it starts.")
    me = _low(user.get("email"))
    now = _now()
    c = models.PerfReviewCycle(id=perf.new_id(), company_id=company_id, name=name.strip()[:200], period_start=ps,
                               period_end=pe, self_due=self_due_for(due, on), manager_due=due, filters={},
                               questions=list(QUESTIONS), rating_scale=[{"key": k, "label": v} for k, v in RATINGS],
                               values=[], include_goals=True, status="active", created_by=me, created_at=now,
                               updated_at=now, launched_at=now, launched_by=me, closed_at="", closed_by="")
    db.add(c)
    db.flush()
    if not sync_members(db, c, me):
        raise HTTPException(400, "Nobody at this company is in it - everyone is a contractor or still on probation.")
    return c


# ── Access ───────────────────────────────────────────────────────────────────

class Access:
    """What one viewer is to one review."""
    def __init__(self, db: Session, user: dict, r: models.PerfReview):
        me = _low(user.get("email"))
        self.me = me
        self.employee = me == _low(r.employee_email)
        self.manager = not self.employee and bool(r.manager_email) and me == _low(r.manager_email)
        self.hr = not self.employee and perf.hr_for(db, user, r.company_id or "")
        self.chain = not self.employee and not self.manager and perf.is_above(db, me, r.employee_email)
        self.any = not user.get("external") and (self.employee or self.manager or self.hr or self.chain) \
            and (r.stage != "removed" or self.hr)

    @property
    def writer(self) -> bool:
        return self.manager or self.hr


def access_or_404(db: Session, user: dict, r: Optional[models.PerfReview]) -> Access:
    if r is None:
        raise HTTPException(404, "Review not found")
    a = Access(db, user, r)
    if not a.any:
        raise HTTPException(404, "Review not found")
    return a


def can_view_envelope(db: Session, req, user: dict) -> bool:
    """Nexus Sign's own screens open a review's envelope only for whoever may
    see the review (esign._require_view)."""
    r = db.get(models.PerfReview, getattr(req, "link_id", "") or "")
    if r is None:
        return False
    a = Access(db, user, r)
    return a.any and (not a.employee or r.stage in ("shared", "complete"))


def _open_cycle(cycle: models.PerfReviewCycle) -> None:
    if cycle.status == "closed":
        raise HTTPException(409, "This review cycle is closed.")


def self_due_passed(cycle: models.PerfReviewCycle, on: Optional[str] = None) -> bool:
    return bool(cycle.self_due) and (on or today()) > cycle.self_due


def manager_may_write(r: models.PerfReview, cycle: models.PerfReviewCycle) -> bool:
    """The self review is optional for the manager: in, or past its due day."""
    return r.stage == "manager_review" or (r.stage == "self_review" and self_due_passed(cycle))


# ── Answers ──────────────────────────────────────────────────────────────────

def clean_answers(answers) -> dict:
    known = {q["id"] for q in QUESTIONS}
    out = {}
    for qid, a in (answers or {}).items():
        if qid not in known:
            continue
        text = a.get("text") if isinstance(a, dict) else a
        out[qid] = {"text": str(text or "")[:8000]}
    return out


def _answered(answers: dict) -> bool:
    return any((a or {}).get("text", "").strip() for a in (answers or {}).values())


def save_self(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, answers,
              submit: bool) -> None:
    a = access_or_404(db, user, r)
    if not a.employee:
        raise HTTPException(403, "The self review is the employee's.")
    _open_cycle(cycle)
    if r.stage != "self_review":
        raise HTTPException(409, "Your self review is closed - it was submitted, or your manager has finished theirs.")
    r.self_answers = clean_answers(answers)
    r.updated_at = _now()
    if not submit:
        return
    if not _answered(r.self_answers):
        raise HTTPException(400, "Answer at least one question first.")
    r.stage, r.self_submitted_at = "manager_review", _now()
    _round(r, a.me, "self_submitted")
    who = perf.name_of(db, r.employee_email)
    for to in writer_of(db, r, cycle):
        _tell(db, to, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"{who} submitted their self review for {cycle.name}. Yours is due {us_date(cycle.manager_due)}.",
              f"performance:review:{r.id}", cycle.company_id)


def goals_for(db: Session, email: str, cycle: models.PerfReviewCycle) -> list:
    """The person's goals for the cycle's period (any goal whose own period
    overlaps it), with where they stand - live, for the form."""
    start, end = cycle.period_start or "", cycle.period_end or ""
    rows = (db.query(models.PerfGoal).filter(models.PerfGoal.owner_email == _low(email),
                                             models.PerfGoal.level == "personal",
                                             models.PerfGoal.archived_at == "").all())
    on = today()
    out = []
    for g in rows:
        gs, ge = perf.goal_period(g)
        if end and gs > end:
            continue
        if start and ge and ge < start:
            continue
        applies = perf.refresh_metric(db, g, on)
        status = perf.computed_status(g, on, applies)
        md = perf._metric_def(g)
        out.append({"id": g.id, "title": g.title, "status": status, "statusLabel": perf.STATUS_LABELS.get(status, status),
                    "progress": perf.progress(g), "metricLabel": md[0] if md else "", "unit": (md[1] if md else g.unit) or "",
                    "currentValue": g.current_value or 0, "targetValue": g.target_value or 0, "measure": g.measure,
                    "dueOn": ge, "measuredByNexus": md is not None})
    out.sort(key=lambda x: (x["dueOn"] or "9999", x["title"].lower()))
    return out[:30]


UNSET = object()   # a field the caller did not send - left as it is


def save_manager(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, *,
                 answers=UNSET, goal_scores=UNSET, rating=UNSET, promotion=UNSET, private_note=UNSET,
                 submit: bool = False) -> None:
    """The manager's part. A field not sent is left as it is."""
    a = access_or_404(db, user, r)
    if not a.writer:
        raise HTTPException(403, "The manager review is written by the employee's manager.")
    _open_cycle(cycle)
    if r.stage == "ready" and not a.hr:
        raise HTTPException(409, "It is with HR now.")
    if r.stage in ("shared", "complete", "removed"):
        raise HTTPException(409, "This review was already shared.")
    if r.stage != "ready":
        _open_cycle(cycle)
        if not manager_may_write(r, cycle):
            raise HTTPException(409, f"Wait for the self review - or until {us_date(cycle.self_due)}, when you can write it without one.")
    if answers is not UNSET:
        r.manager_answers = clean_answers(answers)
    if goal_scores is not UNSET:
        known = {g["id"] for g in goals_for(db, r.employee_email, cycle)}
        r.goal_scores = {gid: v for gid, v in (goal_scores or {}).items() if gid in known and v in GOAL_SCORE_LABELS}
    if rating is not UNSET:
        if rating and rating not in RATING_LABELS:
            raise HTTPException(400, "Pick Exceeds, Meets, Partly Meets or Below.")
        r.rating = rating or ""
    if promotion is not UNSET:
        r.promotion_ready = bool(promotion)
    if private_note is not UNSET:
        r.manager_private_note = (private_note or "")[:4000]
    r.updated_at = _now()
    if r.stage == "ready":
        _round(r, a.me, "hr_edited")
        return
    if not submit:
        return
    if not r.rating:
        raise HTTPException(400, "Pick the Overall Rating first.")
    if not _answered(r.manager_answers):
        raise HTTPException(400, "Answer at least one question first.")
    r.goals_snapshot = [{**g, "score": (r.goal_scores or {}).get(g["id"], "")} for g in goals_for(db, r.employee_email, cycle)]
    r.stage, r.manager_submitted_at, r.manager_submitted_by = "ready", _now(), a.me
    _round(r, a.me, "manager_submitted")
    for to in hr_recipients(db, cycle):
        _tell(db, to, f"perf-review-hr:{cycle.id}", "Reviews Ready to Share",
              f"{perf.name_of(db, a.me)} finished the review of {perf.name_of(db, r.employee_email)} ({cycle.name}).",
              f"performance:review:{r.id}", cycle.company_id)


def return_review(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, note: str) -> None:
    """HR sends a finished review back to the manager."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can send a review back.")
    _open_cycle(cycle)
    if r.stage != "ready":
        raise HTTPException(409, "Only a review that is ready to share can be sent back.")
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(400, "Say what needs changing.")
    r.stage = "manager_review"
    _round(r, a.me, "returned_to_manager", note)
    for m in writer_of(db, r, cycle):
        _tell(db, m, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"HR sent the review of {perf.name_of(db, r.employee_email)} back ({cycle.name}): \"{note[:200]}\".",
              f"performance:review:{r.id}", cycle.company_id)


def remove(db: Session, user: dict, r: models.PerfReview, cycle: Optional[models.PerfReviewCycle] = None) -> None:
    """HR takes someone out of a cycle. The row is kept (stage removed)."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can take someone out of a review.")
    if cycle is not None:
        _open_cycle(cycle)
    if r.stage in ("shared", "complete"):
        raise HTTPException(409, "This review was already shared - it stays.")
    r.stage, r.removed_at = "removed", _now()
    _round(r, a.me, "removed")


def set_reviewer(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, email: str) -> None:
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can change who writes the manager review.")
    _open_cycle(cycle)
    if r.stage in ("shared", "complete", "removed"):
        raise HTTPException(409, "This review was already shared.")
    em = _low(email)
    if em and (em == _low(r.employee_email) or perf.employee(db, em) is None):
        raise HTTPException(400, "Pick someone in Nexus People other than the employee.")
    r.manager_email = em
    _round(r, a.me, "reviewer_changed", perf.name_of(db, em) if em else "HR")
    # The new reviewer hears about it (the old build said nothing).
    for to in writer_of(db, r, cycle):
        _tell(db, to, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"{cycle.name}: you write the review of {perf.name_of(db, r.employee_email)}, due {us_date(cycle.manager_due)}.",
              f"performance:review:{r.id}", cycle.company_id)


# ── Sharing and acknowledging ────────────────────────────────────────────────

def share(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle) -> None:
    """HR shares a finished review: the employee can read it and acknowledge it."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "HR shares reviews.")
    _open_cycle(cycle)
    if r.stage != "ready":
        raise HTTPException(409, "Only a review that is ready to share can be shared.")
    r.finalized_by, r.finalized_at = a.me, _now()
    r.stage, r.shared_at, r.sign_request_id = "shared", _now(), ""
    _round(r, a.me, "shared")
    _mark(r, "shared")
    _tell(db, r.employee_email, f"perf-review:{cycle.id}", "Your Review Is Ready",
          f"{cycle.name}: your review is ready to read. Add your comments if you wish, then acknowledge it.",
          f"performance:review:{r.id}", cycle.company_id, replace=True)


def share_all(db: Session, user: dict, cycle: models.PerfReviewCycle) -> int:
    require_hr(db, user, cycle.company_id)
    _open_cycle(cycle)
    rows = (db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                               models.PerfReview.stage == "ready").with_for_update().all())
    for r in rows:
        share(db, user, r, cycle)
    return len(rows)


def recall(db: Session, user: dict, r: models.PerfReview, note: str,
           cycle: Optional[models.PerfReviewCycle] = None) -> None:
    """HR pulls a shared review back (to change it): an open envelope is voided."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can recall a review.")
    if cycle is not None:
        _open_cycle(cycle)
    if r.stage != "shared":
        raise HTTPException(409, "Only a shared review can be recalled.")
    from routers.esign import _log
    req = (db.query(models.HrSignRequest).filter(models.HrSignRequest.id == r.sign_request_id)
           .with_for_update().populate_existing().first()) if r.sign_request_id else None
    if req is not None and req.status == "completed":
        raise HTTPException(409, "The employee already signed it.")
    if req is not None and req.status == "pending":
        req.status = "voided"
        _log(db, req.id, "voided", f"by {a.me}: review recalled")
    r.stage, r.sign_request_id = "ready", ""
    _round(r, a.me, "recalled", note)


def build_pdf(db: Session, r: models.PerfReview, cycle: models.PerfReviewCycle) -> tuple:
    """The review as a PDF: the three questions with both answers, the goals
    with their scores, the Overall Rating, the employee's comments, and the
    acknowledgement with the signature line. The private note and Ready for
    Promotion are NEVER printed. Returns (bytes, sign spot)."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    W, H = letter
    c = canvas.Canvas(buf, pagesize=letter)
    m = 56
    state = {"y": H - m, "page": 0}

    def new_page():
        c.showPage()
        state["page"] += 1
        state["y"] = H - m

    def need(h):
        if state["y"] - h < m:
            new_page()

    def line(text, font="Helvetica", size=10, gap=13, indent=0):
        for ln in simpleSplit(text or "", font, size, W - 2 * m - indent) or [""]:
            need(gap)
            c.setFont(font, size)
            c.drawString(m + indent, state["y"], ln)
            state["y"] -= gap

    def space(h=8):
        state["y"] -= h

    ent = db.get(models.HrEntity, cycle.company_id) if cycle.company_id else None
    line("Performance Review", "Helvetica-Bold", 16, 20)
    line(f"{perf.name_of(db, r.employee_email)}  -  {cycle.name}", "Helvetica-Bold", 11, 15)
    writer = r.manager_submitted_by or r.manager_email
    meta = [f"Review period: {us_date(cycle.period_start)} to {us_date(cycle.period_end)}" if cycle.period_start else "",
            f"Company: {ent.name}" if ent and ent.name else "",
            f"Manager: {perf.name_of(db, writer)}" if writer else "",
            f"Overall rating: {RATING_LABELS.get(r.rating, 'Not rated')}"]
    for t in [x for x in meta if x]:
        line(t, size=9.5, gap=12)
    space(10)
    for q in QUESTIONS:
        line(q["text"], "Helvetica-Bold", 10.5, 14)
        for who, ans in (("Self review", (r.self_answers or {}).get(q["id"]) or {}),
                         ("Manager review", (r.manager_answers or {}).get(q["id"]) or {})):
            if who == "Self review" and not r.self_submitted_at:
                continue
            line(f"{who}:", "Helvetica-Oblique", 9.5, 12, indent=8)
            line((ans.get("text") or "").strip() or "-", size=9.5, gap=12, indent=16)
        space(6)
    if r.goals_snapshot:
        line("Goals", "Helvetica-Bold", 11, 15)
        for g in r.goals_snapshot:
            score = GOAL_SCORE_LABELS.get(g.get("score") or "", "")
            line(f"{g.get('title')}: {g.get('statusLabel')}, {g.get('progress')}%"
                 + (f" - {score}" if score else ""), size=9.5, gap=12, indent=8)
        space(6)
    if (r.employee_comment or "").strip():
        line("Employee Comments", "Helvetica-Bold", 11, 15)
        line(r.employee_comment.strip(), size=9.5, gap=12, indent=8)
        space(6)
    space(16)
    need(110)
    line("Acknowledgement", "Helvetica-Bold", 11, 15)
    line(ACK_STATEMENT, size=9.5, gap=12)
    space(30)
    base = state["y"]
    c.setFont("Helvetica-Bold", 9)
    c.drawString(m, base + 12, "Employee")
    c.line(0.20 * W, base, 0.62 * W, base)
    c.line(0.70 * W, base, 0.88 * W, base)
    c.setFont("Helvetica", 7)
    c.drawString(0.20 * W, base - 9, "Signature")
    c.drawString(0.70 * W, base - 9, "Date")
    c.save()
    top = (H - (base + 0.05 * H)) / H
    spot = {"page": state["page"], "sign": (0.20, top, 0.42, 0.05),
            "date": (0.70, (H - (base + 0.03 * H)) / H, 0.18, 0.03), "pages": state["page"] + 1}
    return buf.getvalue(), spot


def _party_id(db: Session, r: models.PerfReview) -> str:
    p = (db.query(models.HrSignParty).filter(models.HrSignParty.request_id == r.sign_request_id,
                                             func.lower(models.HrSignParty.email) == r.employee_email).first()) \
        if r.sign_request_id else None
    return p.id if p else ""


def acknowledge(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, comment: str, *,
                ip: str = "", user_agent: str = "") -> str:
    """The employee acknowledges their shared review: their comments are
    saved, the review becomes a PDF, and it goes to them in Nexus Sign as its
    ONLY signer. Returns their signing party id. A second click finds the
    envelope already out and returns the same party."""
    a = access_or_404(db, user, r)
    if not a.employee:
        raise HTTPException(403, "The employee acknowledges their own review.")
    if r.stage != "shared":
        raise HTTPException(409, "This review is not waiting on you.")
    if r.sign_request_id:
        return _party_id(db, r)
    # esign._create_request commits partway through, which lets a second
    # click past the row lock before sign_request_id is written - so look for
    # an envelope already out for this review first, and reuse it.
    out_already = (db.query(models.HrSignRequest)
                   .filter(models.HrSignRequest.link_kind == LINK_KIND, models.HrSignRequest.link_id == r.id,
                           models.HrSignRequest.status == "pending")
                   .order_by(models.HrSignRequest.created_at.desc()).first())
    if out_already is not None:
        r.sign_request_id = out_already.id
        return _party_id(db, r)
    r.employee_comment = (comment or "").strip()[:4000]
    from routers import esign
    pdf, spot = build_pdf(db, r, cycle)
    name = perf.name_of(db, r.employee_email)
    safe_name = esign._safe_filename(f"Performance Review {name} {cycle.name}")
    path = f"esign/{uuid.uuid4()}/{safe_name}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, "The review could not be stored for signing. Try again.")
    fields = [{"id": f"employee_{kind}", "role": "employee", "type": kind, "page": spot["page"],
               **dict(zip(("x", "y", "w", "h"), spot[kind])), "required": True} for kind in ("sign", "date")]
    parties = [esign.PartyIn(role_key="employee", name=name, email=r.employee_email, kind="internal",
                             ordinal=1, party_role="signer")]
    db.flush()
    # employee_id stays empty on purpose: a signed envelope with an employee is
    # filed to their People > Documents tab, which every HR reader opens. The
    # person keeps their copy in My Documents as its signer.
    out = esign._create_request(
        db, {"email": a.me}, title=f"Performance Review - {name} - {cycle.name}", source="pdf",
        template_id="", employee_id="", candidate_id="",
        entity_id=cycle.company_id or "", body_snapshot=[], pdf_storage_path=path,
        fields=esign._clean_fields(fields),
        message=f"Your performance review for {cycle.name}. Sign to acknowledge you received it.",
        expires_on="", parties=parties, ip=ip, user_agent=user_agent, routing="sequential",
        excluded_ack=True, document_class="employment", link_kind=LINK_KIND, link_id=r.id)
    r = db.get(models.PerfReview, r.id)
    r.sign_request_id = out["id"]
    _round(r, a.me, "acknowledging")
    return _party_id(db, r)


def close(db: Session, user: dict, cycle: models.PerfReviewCycle, force: bool = False) -> int:
    """Close a cycle. With reviews still mid-way (a shared one not yet
    acknowledged included) it refuses (409, with how many) unless `force` -
    then they stay as they are, read-only for everyone: no one edits, shares,
    returns or removes in a closed cycle. The one thing left is the employee
    acknowledging a review already shared with them."""
    require_hr(db, user, cycle.company_id)
    if cycle.status == "closed":
        return 0
    left = (db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                               models.PerfReview.stage.in_(UNFINISHED)).count())
    if left and not force:
        raise HTTPException(409, f"{left} {'review is' if left == 1 else 'reviews are'} not finished. Close anyway?")
    cycle.status, cycle.closed_at, cycle.closed_by, cycle.updated_at = "closed", _now(), _low(user.get("email")), _now()
    return left


# ── Nexus Sign callbacks (esign._link_hook, link_kind "perf_review") ─────────

def _for(db: Session, req) -> Optional[models.PerfReview]:
    if (getattr(req, "link_kind", "") or "") != LINK_KIND:
        return None
    r = db.get(models.PerfReview, req.link_id)
    if r is None or r.stage != "shared" or (r.sign_request_id or req.id) != req.id:
        return None
    return r


def on_completed(db: Session, req) -> None:
    r = _for(db, req)
    if r is None:
        return
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    r.stage, r.completed_at = "complete", _now()
    _round(r, r.employee_email, "acknowledged")
    who = perf.name_of(db, r.employee_email)
    if cycle:
        for to in set(hr_recipients(db, cycle) + ([r.manager_email] if r.manager_email else [])):
            _tell(db, to, f"perf-review-done:{cycle.id}", "Reviews Acknowledged",
                  f"{who} acknowledged their review ({cycle.name}).", f"performance:review:{r.id}",
                  cycle.company_id)


def on_declined(db: Session, req, party=None, reason: str = "") -> None:
    """Not signed: it stays shared - they can acknowledge it again - and HR hears why."""
    r = _for(db, req)
    if r is None:
        return
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    r.sign_request_id = ""
    _round(r, getattr(party, "email", "") or r.employee_email, "declined", reason or "")
    if cycle:
        for to in hr_recipients(db, cycle):
            _tell(db, to, f"perf-review-hr:{cycle.id}", "Review Not Signed",
                  f"{perf.name_of(db, r.employee_email)} did not sign their review ({cycle.name})"
                  + (f": \"{reason.strip()[:200]}\"" if (reason or "").strip() else "") + ".",
                  f"performance:review:{r.id}", cycle.company_id)


def on_voided(db: Session, req, actor: str = "") -> None:
    r = _for(db, req)
    if r is None:
        return
    r.sign_request_id = ""
    _round(r, actor or "", "signing_canceled", "Signing was canceled in Nexus Sign.")


def safe(fn, *a, **kw) -> None:
    """A problem here must never cost anyone their signature."""
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[perf-reviews] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


# ── Reminders (automatic) ────────────────────────────────────────────────────

def _remind_review(db: Session, r: models.PerfReview, cycle: models.PerfReviewCycle, on: str) -> int:
    sent = 0
    who = perf.name_of(db, r.employee_email)
    if r.stage == "self_review" and cycle.self_due:
        for key, when, title in (("soonSelf", _add_days(cycle.self_due, -SOON_DAYS), "Self Review Due Soon"),
                                 ("dueSelf", cycle.self_due, "Self Review Due Today")):
            if on >= when and on <= cycle.self_due and _mark(r, key):
                _tell(db, r.employee_email, f"perf-review:{cycle.id}", title,
                      f"{cycle.name}: your self review is due {us_date(cycle.self_due)}.",
                      f"performance:review:{r.id}", cycle.company_id, replace=True)
                sent += 1
    if r.stage in ("self_review", "manager_review") and cycle.manager_due:
        for key, when, title in (("soonMgr", _add_days(cycle.manager_due, -SOON_DAYS), "Reviews Due Soon"),
                                 ("dueMgr", cycle.manager_due, "Reviews Due Today")):
            if on >= when and _mark(r, key):
                for to in writer_of(db, r, cycle):
                    _tell(db, to, f"perf-review-mgr:{cycle.id}", title,
                          f"{cycle.name}: the review of {who} is due {us_date(cycle.manager_due)}.",
                          f"performance:review:{r.id}", cycle.company_id)
                sent += 1
    return sent


def has_left(emp) -> bool:
    """Gone from the company: Offboarded, or the person record deleted. A
    person on Leave or Suspension ("inactive", hr_checklists) has NOT left
    and keeps their review."""
    return emp is None or (emp.status or "active") == "offboarded" or bool(getattr(emp, "deleted_at", "") or "")


def loop_pass(db: Session) -> dict:
    """performance_loop's review part: late joiners in, leavers out (their
    unfinished review is removed - the row is kept), reminders out."""
    on = today()
    added = sent = left = 0
    for cycle in db.query(models.PerfReviewCycle).filter(models.PerfReviewCycle.status == "active").all():
        added += sync_members(db, cycle)
        db.flush()
        for r in (db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                                     models.PerfReview.stage.in_(OPEN_STAGES)).all()):
            emp = perf.employee(db, r.employee_email)
            if has_left(emp):
                r.stage, r.removed_at = "removed", _now()
                _round(r, "", "removed", "Left the company")
                left += 1
                continue
            if r.stage in ("self_review", "manager_review") and (emp.status or "active") == "active":
                sent += _remind_review(db, r, cycle, on)   # someone on leave keeps it, unreminded
    return {"added": added, "reminders": sent, "left": left}


# ── What a viewer gets ───────────────────────────────────────────────────────

def overdue(r: models.PerfReview, cycle: models.PerfReviewCycle, on: Optional[str] = None) -> bool:
    on = on or today()
    if cycle.status != "active":
        return False
    if r.stage == "self_review":
        return bool(cycle.manager_due) and on > cycle.manager_due
    if r.stage == "manager_review":
        return bool(cycle.manager_due) and on > cycle.manager_due
    return False


def cycle_out(db: Session, cycle: models.PerfReviewCycle, counts: Optional[dict] = None) -> dict:
    out = {"id": cycle.id, "companyId": cycle.company_id, "name": cycle.name, "periodStart": cycle.period_start or "",
           "periodEnd": cycle.period_end or "", "selfDue": cycle.self_due or "", "managerDue": cycle.manager_due or "",
           "due": cycle.manager_due or "", "questions": list(QUESTIONS),
           "ratings": [{"key": k, "label": v} for k, v in RATINGS],
           "goalScores": [{"key": k, "label": v} for k, v in GOAL_SCORES],
           "status": cycle.status, "launchedAt": cycle.launched_at or "",
           "closedAt": cycle.closed_at or "", "createdAt": cycle.created_at or ""}
    if counts is not None:
        out["counts"] = counts
    return out


def review_out(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, a: Access) -> dict:
    """The review as THIS viewer may see it."""
    shared = r.stage in ("shared", "complete")
    show_self = a.employee or ((a.hr or a.manager) and bool(r.self_submitted_at)) or (a.chain and shared)
    show_mgr = (not a.employee) or shared
    if a.chain and r.stage in ("self_review", "manager_review"):
        show_mgr = False
    live = cycle.status != "closed"
    writing = a.writer and live and (
        (r.stage in ("self_review", "manager_review") and manager_may_write(r, cycle)) or (a.hr and r.stage == "ready"))
    out = {
        "id": r.id, "cycle": cycle_out(db, cycle), "employeeEmail": r.employee_email,
        "employeeName": perf.name_of(db, r.employee_email), "managerEmail": r.manager_email or "",
        "managerName": perf.name_of(db, r.manager_email) if r.manager_email else "HR",
        "stage": r.stage, "stageLabel": STAGE_LABELS.get(r.stage, r.stage), "overdue": overdue(r, cycle),
        "selfSubmittedAt": r.self_submitted_at or "", "sharedAt": r.shared_at or "", "completedAt": r.completed_at or "",
        "selfAnswers": (r.self_answers or {}) if show_self else {},
        "goals": [g if show_mgr else {k: v for k, v in g.items() if k != "score"}
                  for g in (r.goals_snapshot if r.goals_snapshot else goals_for(db, r.employee_email, cycle))],
        "employeeComment": r.employee_comment or "",
        "role": {"employee": a.employee, "manager": a.manager, "hr": a.hr, "chain": a.chain},
        "can": {
            "editSelf": a.employee and r.stage == "self_review" and cycle.status != "closed",
            "editManager": writing,
            "waitForSelf": a.writer and r.stage == "self_review" and not manager_may_write(r, cycle),
            # A closed cycle is read-only: only the employee's Acknowledge stays.
            "share": live and a.hr and r.stage == "ready",
            "returnToManager": live and a.hr and r.stage == "ready",
            "recall": live and a.hr and r.stage == "shared",
            "remove": live and a.hr and r.stage in OPEN_STAGES,
            "reassign": live and a.hr and r.stage in OPEN_STAGES,
            "acknowledge": a.employee and r.stage == "shared",
            # Make This a Goal: the goal-create rule (performance.check_create) -
            # their direct manager or HR, never a reviewer HR picked otherwise.
            "addGoal": live and a.writer and (perf.is_direct_manager(db, a.me, r.employee_email)
                                              or perf.hr_for_person(db, user, r.employee_email)),
        },
    }
    if show_mgr:
        out.update({"managerAnswers": r.manager_answers or {}, "goalScores": r.goal_scores or {},
                    "rating": r.rating or "", "ratingLabel": RATING_LABELS.get(r.rating or "", ""),
                    "managerSubmittedAt": r.manager_submitted_at or ""})
        if not a.employee:
            out["promotionReady"] = bool(r.promotion_ready)
            # Calibration (Oct 29 2026): what the manager rated before HR
            # moved it - never the employee's to see.
            out["calibratedFrom"] = r.calibrated_from or ""
            out["calibratedFromLabel"] = RATING_LABELS.get(r.calibrated_from or "", "")
    # The private note: HR, and the writer while it is theirs. Never the
    # employee, never the chain above the writer.
    if a.hr or a.manager:
        out["privateNote"] = r.manager_private_note or ""
    if not a.employee:
        out["history"] = [{**h, "byName": perf.name_of(db, h.get("by")) if h.get("by") else "Nexus"} for h in (r.history or [])]
    if a.employee and r.stage == "shared" and r.sign_request_id:
        out["signPartyId"] = _party_id(db, r)
    # Peer feedback beside the form (Oct 29 2026): what colleagues said about
    # the person, for the writer, HR and the chain - never the employee.
    if not a.employee:
        import perf_feedback
        out["peerFeedback"] = perf_feedback.for_review(db, user, r, cycle)
        out["can"]["askFeedback"] = live and r.stage in OPEN_STAGES and perf_feedback.may_ask_about(db, user, r.employee_email)
    return out


def stage_counts(rows: list) -> dict:
    out = {s: 0 for s in STAGES}
    for r in rows:
        if r.stage in out:
            out[r.stage] += 1
    return out


def rating_counts(rows: list) -> dict:
    out = {k: 0 for k, _ in RATINGS}
    for r in rows:
        if r.rating in out and r.stage in ("ready", "shared", "complete"):
            out[r.rating] += 1
    return out


def review_period_for(db: Session, email: str) -> Optional[tuple]:
    """The period of the person's latest review (This Review)."""
    rows = (db.query(models.PerfReview).filter(models.PerfReview.employee_email == _low(email),
                                               models.PerfReview.stage != "removed").all())
    cycles = [db.get(models.PerfReviewCycle, r.cycle_id) for r in rows]
    cycles = [c for c in cycles if c is not None and c.period_start and c.period_end]
    if not cycles:
        return None
    c = max(cycles, key=lambda c: c.created_at or "")
    return c.period_start, c.period_end


def waiting_on(db: Session, user: dict) -> list:
    """What waits on the caller across reviews (approvals_inbox): their own
    self review or acknowledgement, the reviews they write, and - as HR -
    the ones ready to share. [(kind, review, cycle)]."""
    me = _low(user.get("email"))
    out = []
    cycles: dict = {}

    def cyc(cid):
        if cid not in cycles:
            cycles[cid] = db.get(models.PerfReviewCycle, cid)
        return cycles[cid]

    for r in db.query(models.PerfReview).filter(models.PerfReview.employee_email == me,
                                                models.PerfReview.stage.in_(("self_review", "shared"))).all():
        c = cyc(r.cycle_id)
        if c is None:
            continue
        if r.stage == "self_review" and c.status == "active":
            out.append(("self", r, c))
        elif r.stage == "shared" and not r.sign_request_id:
            out.append(("acknowledge", r, c))   # also once the cycle is closed
    for r in db.query(models.PerfReview).filter(models.PerfReview.manager_email == me,
                                                models.PerfReview.stage.in_(("self_review", "manager_review"))).all():
        c = cyc(r.cycle_id)
        if c is not None and c.status == "active" and manager_may_write(r, c):
            out.append(("write", r, c))
    reach = perf.hr_reach(db, user)
    if reach is not False:
        q = db.query(models.PerfReview).filter(models.PerfReview.stage == "ready")
        for r in q.all():
            if r.employee_email == me or not perf.hr_for(db, user, r.company_id or ""):
                continue
            c = cyc(r.cycle_id)
            if c is not None and c.status == "active":
                out.append(("share", r, c))
        for r in db.query(models.PerfReview).filter(models.PerfReview.manager_email == "",
                                                    models.PerfReview.stage.in_(("self_review", "manager_review"))).all():
            c = cyc(r.cycle_id)
            if c is not None and c.status == "active" and perf.hr_for(db, user, r.company_id or "") \
                    and r.employee_email != me and manager_may_write(r, c):
                out.append(("write", r, c))
    return out


# ── Calibration (Neil, Oct 29 2026: "add all the bigger features") ──────────
# HR lines the ratings up before they are shared: every finished review of a
# cycle by its Overall Rating, side by side, and moves one with a reason. The
# manager's own rating is kept (calibrated_from), the move is in the history
# and the manager hears about it; the employee only ever sees the rating
# that was shared. Only a review Ready to Share moves - once shared it is
# the employee's, and Recall is the way back.

CALIBRATE_STAGES = ("ready", "shared", "complete")


def calibration_board(db: Session, user: dict, cycle: models.PerfReviewCycle) -> dict:
    require_hr(db, user, cycle.company_id)
    rows = (db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                               models.PerfReview.stage.in_(CALIBRATE_STAGES)).all())
    waiting = (db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                                  models.PerfReview.stage.in_(("self_review", "manager_review"))).count())
    people = []
    for r in rows:
        emp = perf.employee(db, r.employee_email)
        scores = list((r.goal_scores or {}).values())
        people.append({
            "id": r.id, "employeeEmail": r.employee_email, "employeeName": perf.name_of(db, r.employee_email),
            "title": (emp.job_title if emp else "") or "", "department": (emp.department if emp else "") or "",
            "managerEmail": r.manager_email or "", "managerName": perf.name_of(db, r.manager_email) if r.manager_email else "HR",
            "stage": r.stage, "stageLabel": STAGE_LABELS.get(r.stage, r.stage),
            "rating": r.rating or "", "ratingLabel": RATING_LABELS.get(r.rating or "", ""),
            "calibratedFrom": r.calibrated_from or "", "calibratedFromLabel": RATING_LABELS.get(r.calibrated_from or "", ""),
            "promotionReady": bool(r.promotion_ready),
            "goals": {k: scores.count(k) for k, _ in GOAL_SCORES},
            "canMove": cycle.status == "active" and r.stage == "ready",
        })
    people.sort(key=lambda p: p["employeeName"].lower())
    return {"cycle": cycle_out(db, cycle), "people": people, "stillWriting": waiting,
            "ratings": [{"key": k, "label": v} for k, v in RATINGS],
            "departments": sorted({p["department"] for p in people if p["department"]}),
            "managers": sorted({(p["managerEmail"], p["managerName"]) for p in people}, key=lambda m: m[1].lower())}


def calibrate(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, rating: str, note: str) -> None:
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "HR calibrates ratings.")
    _open_cycle(cycle)
    if r.stage != "ready":
        raise HTTPException(409, "Only a review Ready to Share can be moved - recall a shared one first.")
    if rating not in RATING_LABELS:
        raise HTTPException(400, "Pick Exceeds, Meets, Partly Meets or Below.")
    if rating == (r.rating or ""):
        return
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(400, "Say why the rating moves - the manager sees it.")
    before = r.rating or ""
    if not r.calibrated_from:
        r.calibrated_from = before
    r.rating = rating
    if rating == r.calibrated_from:
        r.calibrated_from, r.calibrated_by, r.calibrated_at = "", "", ""
    else:
        r.calibrated_by, r.calibrated_at = a.me, _now()
    _round(r, a.me, "calibrated", f"{RATING_LABELS.get(before, 'None')} to {RATING_LABELS[rating]}: {note}")
    for m in writer_of(db, r, cycle):
        if m != a.me:
            _tell(db, m, f"perf-review-cal:{cycle.id}", "Ratings Calibrated",
                  f"HR moved the rating of {perf.name_of(db, r.employee_email)} from {RATING_LABELS.get(before, 'None')} "
                  f"to {RATING_LABELS[rating]} ({cycle.name}): \"{note[:200]}\".",
                  f"performance:review:{r.id}", cycle.company_id)
