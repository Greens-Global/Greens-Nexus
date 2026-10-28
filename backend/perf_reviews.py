"""Performance review cycles (Neil, Oct 27 2026) - the engine behind
routers/perf_reviews.py. Goals and 1:1s are performance.py; this file reuses
its people rules (chain, hr_reach) so "who sees what" is one rule.

THE FLOW, per person
  Self Review      the employee answers the cycle's questions and rates the
                   company values; Submit hands it to their manager.
  Manager Review   the manager (the employee's Reports To when the cycle was
                   launched; HR writes it when there is none) sees the self
                   review, answers the same questions, gives an overall
                   rating, a summary, a private note for HR, and may attach
                   the employee's goal progress (performance.py's goals).
  HR Finalize      HR for the company may edit, add a comment for the
                   employee, return it to the manager (or to the employee),
                   or Share it.
  Shared           Share renders the final review to a PDF and sends it in
                   Nexus Sign with the EMPLOYEE AS THE ONLY SIGNER (HR signing
                   order, Neil Oct 22: the company never signs before the
                   employee - here the company does not sign at all). Signing
                   is an acknowledgement, printed as such: it means they read
                   it, not that they agree. A decline or a void brings it back
                   to HR Finalize with the reason.
  Complete         the employee signed. HR may then Start Promotion - a link
                   to the existing promotion life event on their profile
                   (hr_life_events), nothing duplicated here.

WHO SEES WHAT
  the employee     their own self review at any time; the manager's and HR's
                   parts only once it is Shared; never the manager's private
                   note (not in the response, not in the PDF);
  the manager      (and everyone above them in the chain) the whole review -
                   the self review once it was submitted;
  HR for the company (performance.hr_reach) everything;
  anybody else - a peer, a manager of another team - 404.

No calibration curve and no 9-box (Neil). The rating scale and the company
values come from Settings > Performance (scoped_settings key
"performance_reviews", layered per company) and are copied onto a cycle when
it is created, so a later settings change never rewrites a running cycle.
"""
from __future__ import annotations

import io
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import performance as perf
import scoped_settings

SETTINGS_KEY = "performance_reviews"
DEFAULT_SCALE = [
    {"value": 1, "label": "Needs Improvement"},
    {"value": 2, "label": "Developing"},
    {"value": 3, "label": "Meets Expectations"},
    {"value": 4, "label": "Exceeds Expectations"},
    {"value": 5, "label": "Outstanding"},
]
DEFAULTS = {"ratingScale": DEFAULT_SCALE, "values": []}
DEFAULT_QUESTIONS = [
    {"id": "q1", "kind": "rating", "text": "Overall, how did this period go?"},
    {"id": "q2", "kind": "text", "text": "What went well?"},
    {"id": "q3", "kind": "text", "text": "What could have gone better?"},
    {"id": "q4", "kind": "text", "text": "What should the focus be for the next period?"},
]
DEFAULT_TYPES = ["full_time", "part_time"]
EMPLOYMENT_TYPES = ("full_time", "part_time", "contractor", "intern")

STAGES = ("self_review", "manager_review", "hr_review", "shared", "complete")
STAGE_LABELS = {"self_review": "Self Review", "manager_review": "Manager Review", "hr_review": "HR Finalize",
                "shared": "Shared With Employee", "complete": "Complete"}
LINK_KIND = "perf_review"
ACK_STATEMENT = ("My signature means I have received and read this performance review. It does not mean "
                 "I agree with everything in it.")
NUDGE_EVERY = timedelta(hours=20)


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
    return datetime.now(timezone.utc).astimezone(perf.zone(perf.DEFAULT_TZ)).strftime("%Y-%m-%d")


# ── Settings: the rating scale and the company values ────────────────────────

def clean_scale(scale) -> list:
    out, seen = [], set()
    for row in scale or []:
        try:
            v = int(row.get("value"))
        except (AttributeError, TypeError, ValueError):
            continue
        label = str(row.get("label") or "").strip()[:60]
        if v in seen or not label or not (0 <= v <= 10):
            continue
        seen.add(v)
        out.append({"value": v, "label": label})
    out.sort(key=lambda r: r["value"])
    if len(out) < 2:
        raise HTTPException(400, "A rating scale needs at least two points, each with a label.")
    return out[:10]


def clean_values(values) -> list:
    out, seen = [], set()
    for row in values or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()[:80]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        vid = re.sub(r"[^a-z0-9]+", "-", str(row.get("id") or name).lower()).strip("-")[:40] or perf.new_id()[:8]
        out.append({"id": vid, "name": name, "description": str(row.get("description") or "").strip()[:300]})
    return out[:20]


def settings_for_company(db: Session, company_id: str = "") -> dict:
    cfg = scoped_settings.get(db, SETTINGS_KEY, DEFAULTS, company_id)
    try:
        scale = clean_scale(cfg.get("ratingScale"))
    except HTTPException:
        scale = list(DEFAULT_SCALE)
    return {"ratingScale": scale, "values": clean_values(cfg.get("values"))}


# ── Cycles ───────────────────────────────────────────────────────────────────

def clean_questions(questions) -> list:
    out = []
    for i, q in enumerate(questions or []):
        if not isinstance(q, dict):
            continue
        text = str(q.get("text") or "").strip()[:400]
        if not text:
            continue
        kind = "rating" if q.get("kind") == "rating" else "text"
        qid = re.sub(r"[^a-zA-Z0-9_-]", "", str(q.get("id") or ""))[:40] or f"q{i + 1}-{perf.new_id()[:6]}"
        out.append({"id": qid, "kind": kind, "text": text})
    ids = [q["id"] for q in out]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Two questions share an id - remove one and add it again.")
    if not out:
        raise HTTPException(400, "Add at least one question.")
    return out[:30]


def clean_filters(f) -> dict:
    f = f if isinstance(f, dict) else {}
    depts = [str(d).strip() for d in (f.get("departments") or []) if str(d).strip()]
    types = [t for t in (f.get("types") or []) if t in EMPLOYMENT_TYPES]
    started = str(f.get("startedBy") or "").strip()[:10]
    if started:
        try:
            datetime.strptime(started, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "Pick a valid start-date cutoff.")
    return {"departments": depts, "types": types or list(DEFAULT_TYPES), "startedBy": started}


def require_hr(db: Session, user: dict, company_id: str) -> None:
    if not perf.hr_for(db, user, company_id or ""):
        raise HTTPException(403, "Review cycles are run by HR for the company.")


def participants(db: Session, cycle: models.PerfReviewCycle) -> list:
    """Who the cycle's filters take in: active internal people of its
    company, by department, kind of worker and start-date cutoff."""
    f = clean_filters(cycle.filters)
    depts = {_low(d) for d in f["departments"]}
    rows = (db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.company == cycle.company_id).all())
    out = []
    for e in rows:
        if (e.status or "active") != "active" or (e.identity_type or "internal") != "internal" or not _low(e.work_email):
            continue
        if depts and _low(e.department) not in depts:
            continue
        if (e.employment_type or "full_time") not in f["types"]:
            continue
        if f["startedBy"] and (e.start_date or "")[:10] > f["startedBy"]:
            continue
        out.append(e)
    out.sort(key=lambda e: perf.name_of(db, e.work_email).lower())
    return out


def _round(r: models.PerfReview, by: str, action: str, note: str = "") -> None:
    r.history = list(r.history or []) + [{"at": _now(), "by": _low(by), "action": action, "note": (note or "")[:500]}]
    r.updated_at = _now()


def hr_recipients(db: Session, cycle: models.PerfReviewCycle) -> list:
    """Who hears that a review waits on HR: the company's HR contact, else
    whoever launched the cycle."""
    ent = db.get(models.HrEntity, cycle.company_id) if cycle.company_id else None
    hr = _low(ent.hr_contact_email if ent else "")
    return [hr] if hr else [x for x in {_low(cycle.launched_by), _low(cycle.created_by)} if x][:1]


def _tell(db: Session, to: str, key: str, title: str, line: str, sub: str, company: str, replace: bool = False) -> None:
    import notify_rollup
    notify_rollup.upsert_rollup(db, recipient=to, key=key, title=title, line=line,
                                action={"view": "myhr", "sub": sub}, company=company, replace=replace)


def launch(db: Session, user: dict, cycle: models.PerfReviewCycle) -> int:
    require_hr(db, user, cycle.company_id)
    if cycle.status != "draft":
        raise HTTPException(409, "This cycle has already been launched.")
    if not cycle.self_due or not cycle.manager_due:
        raise HTTPException(400, "Set the self review and manager review deadlines first.")
    people = participants(db, cycle)
    if not people:
        raise HTTPException(400, "Nobody matches this cycle's filters.")
    have = {r.employee_email for r in db.query(models.PerfReview.employee_email)
            .filter(models.PerfReview.cycle_id == cycle.id).all()}
    now = _now()
    n = 0
    for e in people:
        email = _low(e.work_email)
        if email in have:
            continue
        r = models.PerfReview(id=perf.new_id(), cycle_id=cycle.id, company_id=cycle.company_id, employee_email=email,
                              manager_email=_low(e.manager_email) if _low(e.manager_email) != email else "",
                              stage="self_review", self_answers={}, self_values={}, manager_answers={},
                              manager_values={}, goals_snapshot=[], history=[], created_at=now, updated_at=now,
                              self_submitted_at="", manager_submitted_at="", manager_submitted_by="",
                              finalized_at="", finalized_by="", sign_request_id="", shared_at="", completed_at="",
                              nudged_at="", hr_note="", manager_summary="", manager_private_note="")
        _round(r, user["email"], "launched")
        db.add(r)
        _tell(db, email, f"perf-review:{cycle.id}", "Self Review Due",
              f"{cycle.name}: your self review is due {us_date(cycle.self_due)}.",
              f"performance:review:{r.id}", cycle.company_id, replace=True)
        n += 1
    cycle.status, cycle.launched_at, cycle.launched_by, cycle.updated_at = "active", now, _low(user["email"]), now
    return n


# ── Access ───────────────────────────────────────────────────────────────────

class Access:
    """What one viewer is to one review."""
    def __init__(self, db: Session, user: dict, r: models.PerfReview):
        me = _low(user.get("email"))
        self.me = me
        self.employee = me == _low(r.employee_email)
        self.manager = not self.employee and bool(r.manager_email) and me == _low(r.manager_email)
        self.hr = not self.employee and perf.hr_for(db, user, r.company_id or "")
        self.chain = not self.employee and (self.manager or perf.is_above(db, me, r.employee_email))
        self.any = not user.get("external") and (self.employee or self.manager or self.hr or self.chain)

    @property
    def writes_manager_part(self) -> bool:
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


# ── Answers ──────────────────────────────────────────────────────────────────

def _scale_values(cycle: models.PerfReviewCycle) -> set:
    return {int(s["value"]) for s in (cycle.rating_scale or DEFAULT_SCALE)}


def _rating(v, allowed: set):
    if v is None or v == "":
        return None
    try:
        v = int(v)
    except (TypeError, ValueError):
        raise HTTPException(400, "A rating must be on the cycle's scale.")
    if v not in allowed:
        raise HTTPException(400, "A rating must be on the cycle's scale.")
    return v


def clean_answers(cycle: models.PerfReviewCycle, answers) -> dict:
    allowed = _scale_values(cycle)
    qs = {q["id"]: q for q in (cycle.questions or [])}
    out = {}
    for qid, a in (answers or {}).items():
        q = qs.get(qid)
        if q is None or not isinstance(a, dict):
            continue
        out[qid] = {"rating": _rating(a.get("rating"), allowed) if q["kind"] == "rating" else None,
                    "text": str(a.get("text") or "")[:8000]}
    return out


def clean_value_ratings(cycle: models.PerfReviewCycle, values) -> dict:
    allowed = _scale_values(cycle)
    known = {v["id"] for v in (cycle.values or [])}
    return {vid: _rating(v, allowed) for vid, v in (values or {}).items() if vid in known}


def _missing(cycle: models.PerfReviewCycle, answers: dict, values: dict) -> list:
    out = [q["text"] for q in (cycle.questions or [])
           if q["kind"] == "rating" and (answers.get(q["id"]) or {}).get("rating") is None]
    out += [v["name"] for v in (cycle.values or []) if values.get(v["id"]) is None]
    return out


def _open_cycle(cycle: models.PerfReviewCycle) -> None:
    if cycle.status == "closed":
        raise HTTPException(409, "This review cycle is closed.")


def save_self(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle,
              answers, values, submit: bool) -> None:
    a = access_or_404(db, user, r)
    if not a.employee:
        raise HTTPException(403, "The self review is the employee's.")
    _open_cycle(cycle)
    if r.stage != "self_review":
        raise HTTPException(409, "Your self review was already submitted.")
    r.self_answers = clean_answers(cycle, answers)
    r.self_values = clean_value_ratings(cycle, values)
    r.updated_at = _now()
    if not submit:
        return
    missing = _missing(cycle, r.self_answers, r.self_values)
    if missing:
        raise HTTPException(400, "Rate every rating question and value first: " + ", ".join(missing[:5]))
    r.stage, r.self_submitted_at = "manager_review", _now()
    _round(r, a.me, "self_submitted")
    who = perf.name_of(db, r.employee_email)
    for to in ([r.manager_email] if r.manager_email else hr_recipients(db, cycle)):
        _tell(db, to, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"{who} submitted their self review for {cycle.name}. Yours is due {us_date(cycle.manager_due)}.",
              f"performance:review:{r.id}", cycle.company_id)


def _goal_snapshot(db: Session, email: str) -> list:
    rows = (db.query(models.PerfGoal).filter(models.PerfGoal.owner_email == _low(email),
                                             models.PerfGoal.level == "personal",
                                             models.PerfGoal.archived_at == "").all())
    from performance import progress, STATUS_LABELS
    return [{"title": g.title, "status": g.status, "statusLabel": STATUS_LABELS.get(g.status, g.status),
             "progress": progress(g), "dueOn": g.due_on or ""} for g in rows][:30]


UNSET = object()   # a field the caller did not send - left as it is


def save_manager(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, *,
                 answers=UNSET, values=UNSET, overall=UNSET, summary=UNSET, private_note=UNSET,
                 attach_goals: bool = True, submit: bool = False) -> None:
    """The manager's part. A field not sent (UNSET) is left as it is - HR's
    edit of one answer never blanks the rest (release review, Oct 27); while
    the review is with HR, answers and value ratings sent are merged in per
    question."""
    a = access_or_404(db, user, r)
    if not a.writes_manager_part:
        raise HTTPException(403, "The manager review is written by the employee's manager.")
    if r.stage == "self_review":
        raise HTTPException(409, "The self review is not in yet.")
    if r.stage == "hr_review" and not a.hr:
        raise HTTPException(409, "It is with HR now.")
    if r.stage in ("shared", "complete"):
        raise HTTPException(409, "This review was already shared.")
    if r.stage == "manager_review":
        _open_cycle(cycle)
    merge = r.stage == "hr_review"
    if answers is not UNSET:
        new = clean_answers(cycle, answers)
        r.manager_answers = {**(r.manager_answers or {}), **new} if merge else new
    if values is not UNSET:
        new = clean_value_ratings(cycle, values)
        r.manager_values = {**(r.manager_values or {}), **new} if merge else new
    if overall is not UNSET:
        r.overall_rating = _rating(overall, _scale_values(cycle))
    if summary is not UNSET:
        r.manager_summary = (summary or "")[:8000]
    if private_note is not UNSET:
        r.manager_private_note = (private_note or "")[:4000]
    if cycle.include_goals and r.stage == "manager_review":
        # Taken while the manager writes it - HR's later edit keeps what they attached.
        r.goals_snapshot = _goal_snapshot(db, r.employee_email) if attach_goals else []
    r.updated_at = _now()
    if r.stage == "hr_review":
        _round(r, a.me, "hr_edited")
        return
    if not submit:
        return
    missing = _missing(cycle, r.manager_answers, r.manager_values)
    if r.overall_rating is None:
        missing.append("Overall Rating")
    if missing:
        raise HTTPException(400, "Rate every rating question and value, and give an overall rating: "
                                 + ", ".join(missing[:5]))
    r.stage, r.manager_submitted_at, r.manager_submitted_by = "hr_review", _now(), a.me
    _round(r, a.me, "manager_submitted")
    for to in hr_recipients(db, cycle):
        _tell(db, to, f"perf-review-hr:{cycle.id}", "Reviews to Finalize",
              f"{perf.name_of(db, a.me)} submitted the review of {perf.name_of(db, r.employee_email)} ({cycle.name}).",
              f"performance:review:{r.id}", cycle.company_id)


def hr_note(db: Session, user: dict, r: models.PerfReview, note: str) -> None:
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "HR finalizes reviews.")
    if r.stage != "hr_review":
        raise HTTPException(409, "HR comments are added while the review is with HR.")
    r.hr_note = (note or "")[:4000]
    r.updated_at = _now()


def return_review(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, to: str, note: str) -> None:
    """HR sends it back - to the manager (the usual) or to the employee."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can send a review back.")
    if r.stage != "hr_review":
        raise HTTPException(409, "Only a review with HR can be sent back.")
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(400, "Say what needs changing.")
    who = perf.name_of(db, r.employee_email)
    if to == "employee":
        r.stage, r.self_submitted_at = "self_review", ""
        _round(r, a.me, "returned_to_employee", note)
        _tell(db, r.employee_email, f"perf-review:{cycle.id}", "Self Review Returned",
              f"{cycle.name}: HR sent your self review back - \"{note[:200]}\".", f"performance:review:{r.id}",
              cycle.company_id, replace=True)
        return
    r.stage = "manager_review"
    _round(r, a.me, "returned_to_manager", note)
    for m in ([r.manager_email] if r.manager_email else hr_recipients(db, cycle)):
        _tell(db, m, f"perf-review-mgr:{cycle.id}", "Reviews to Write",
              f"HR sent the review of {who} back ({cycle.name}): \"{note[:200]}\".", f"performance:review:{r.id}",
              cycle.company_id)


def set_reviewer(db: Session, user: dict, r: models.PerfReview, email: str) -> None:
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can change who writes the manager review.")
    if r.stage in ("shared", "complete"):
        raise HTTPException(409, "This review was already shared.")
    em = _low(email)
    if em and (em == _low(r.employee_email) or perf.employee(db, em) is None):
        raise HTTPException(400, "Pick someone in Nexus People other than the employee.")
    r.manager_email = em
    _round(r, a.me, "reviewer_changed", perf.name_of(db, em) if em else "HR")


# ── Sharing: the PDF and the Nexus Sign envelope ─────────────────────────────

def _scale_label(cycle: models.PerfReviewCycle, v) -> str:
    for s in cycle.rating_scale or DEFAULT_SCALE:
        if v is not None and int(s["value"]) == int(v):
            return f"{s['value']} - {s['label']}"
    return "Not rated"


def build_pdf(db: Session, r: models.PerfReview, cycle: models.PerfReviewCycle) -> tuple:
    """The final review as a PDF: the questions with both answers, the
    values, the goals the manager attached, the overall rating, the summary,
    HR's comment and the acknowledgement with the signature line. The
    manager's private note is NEVER printed. Returns (bytes, sign spot)."""
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
    meta = [f"Review period: {us_date(cycle.period_start)} to {us_date(cycle.period_end)}" if cycle.period_start else "",
            f"Company: {ent.name}" if ent and ent.name else "",
            f"Manager: {perf.name_of(db, r.manager_submitted_by or r.manager_email)}" if (r.manager_submitted_by or r.manager_email) else "",
            f"Overall rating: {_scale_label(cycle, r.overall_rating)}"]
    for t in [x for x in meta if x]:
        line(t, size=9.5, gap=12)
    space(10)
    for q in cycle.questions or []:
        line(q["text"], "Helvetica-Bold", 10.5, 14)
        for who, ans in (("Self review", (r.self_answers or {}).get(q["id"]) or {}),
                         ("Manager review", (r.manager_answers or {}).get(q["id"]) or {})):
            rating = f" ({_scale_label(cycle, ans.get('rating'))})" if q["kind"] == "rating" else ""
            line(f"{who}{rating}:", "Helvetica-Oblique", 9.5, 12, indent=8)
            line((ans.get("text") or "").strip() or "-", size=9.5, gap=12, indent=16)
        space(6)
    if cycle.values:
        line("Company Values", "Helvetica-Bold", 11, 15)
        for v in cycle.values:
            line(f"{v['name']}: self {_scale_label(cycle, (r.self_values or {}).get(v['id']))}; "
                 f"manager {_scale_label(cycle, (r.manager_values or {}).get(v['id']))}", size=9.5, gap=12, indent=8)
        space(6)
    if r.goals_snapshot:
        line("Goals", "Helvetica-Bold", 11, 15)
        for g in r.goals_snapshot:
            line(f"{g.get('title')}: {g.get('statusLabel')}, {g.get('progress')}% complete"
                 + (f", due {us_date(g.get('dueOn'))}" if g.get("dueOn") else ""), size=9.5, gap=12, indent=8)
        space(6)
    line("Manager Summary", "Helvetica-Bold", 11, 15)
    line((r.manager_summary or "").strip() or "-", size=9.5, gap=12, indent=8)
    if (r.hr_note or "").strip():
        space(6)
        line("Comments From HR", "Helvetica-Bold", 11, 15)
        line(r.hr_note.strip(), size=9.5, gap=12, indent=8)
    space(16)
    # The acknowledgement and the signature row, kept together on one page.
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
    # Field boxes sit on the lines, measured from the page top (Nexus Sign's
    # normalized coordinates).
    top = (H - (base + 0.05 * H)) / H
    spot = {"page": state["page"], "sign": (0.20, top, 0.42, 0.05),
            "date": (0.70, (H - (base + 0.03 * H)) / H, 0.18, 0.03), "pages": state["page"] + 1}
    return buf.getvalue(), spot


def share(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, *, ip: str = "",
          user_agent: str = "") -> str:
    """HR shares the final review: a PDF in Nexus Sign with the employee as
    its ONLY signer - the company never signs it (HR signing order, Neil,
    Oct 22 2026). Returns the envelope id."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "HR shares reviews.")
    if r.stage != "hr_review":
        raise HTTPException(409, "Only a review with HR can be shared.")
    from routers import esign
    pdf, spot = build_pdf(db, r, cycle)
    name = perf.name_of(db, r.employee_email)
    safe = esign._safe_filename(f"Performance Review {name} {cycle.name}")
    path = f"esign/{uuid.uuid4()}/{safe}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, "The review could not be stored for signing. Try again.")
    fields = [{"id": f"employee_{kind}", "role": "employee", "type": kind, "page": spot["page"],
               **dict(zip(("x", "y", "w", "h"), spot[kind])), "required": True} for kind in ("sign", "date")]
    parties = [esign.PartyIn(role_key="employee", name=name, email=r.employee_email, kind="internal",
                             ordinal=1, party_role="signer")]
    # Shared BEFORE the envelope is made: _create_request commits partway, so
    # this lands in the same commit and a second Share (a double click, a
    # retry) finds the review no longer with HR. The envelope id follows.
    now = _now()
    r.finalized_by, r.finalized_at = a.me, now
    r.stage, r.shared_at, r.sign_request_id = "shared", now, ""
    db.flush()
    # employee_id stays empty on purpose: a signed envelope with an employee is
    # filed to their People > Documents tab, which every HR reader opens. The
    # person keeps their copy in My Documents as its signer.
    out = esign._create_request(
        db, {"email": a.me}, title=f"Performance Review - {name} - {cycle.name}", source="pdf",
        template_id="", employee_id="", candidate_id="",
        entity_id=cycle.company_id or "", body_snapshot=[], pdf_storage_path=path,
        fields=esign._clean_fields(fields),
        message=f"Your performance review for {cycle.name} is ready. Please read it and sign to acknowledge you received it.",
        expires_on="", parties=parties, ip=ip, user_agent=user_agent, routing="sequential",
        excluded_ack=True, document_class="employment", link_kind=LINK_KIND, link_id=r.id)
    rid = out["id"]
    r = db.get(models.PerfReview, r.id)
    r.sign_request_id = rid
    _round(r, a.me, "shared")
    _tell(db, r.employee_email, f"perf-review:{cycle.id}", "Your Review Is Ready",
          f"{cycle.name}: your review is ready to read and sign.", f"performance:review:{r.id}",
          cycle.company_id, replace=True)
    return rid


def recall(db: Session, user: dict, r: models.PerfReview, note: str) -> None:
    """HR pulls a shared review back (to change it): the envelope is voided."""
    a = access_or_404(db, user, r)
    if not a.hr:
        raise HTTPException(403, "Only HR can recall a review.")
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
    r.stage, r.sign_request_id = "hr_review", ""
    _round(r, a.me, "recalled", note)


# ── Nexus Sign callbacks (esign._link_hook, link_kind "perf_review") ─────────

def _for(db: Session, req) -> Optional[models.PerfReview]:
    if (getattr(req, "link_kind", "") or "") != LINK_KIND:
        return None
    r = db.get(models.PerfReview, req.link_id)
    # sign_request_id is '' only between Share's two commits.
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
                  f"{who} signed to acknowledge their review ({cycle.name}).", f"performance:review:{r.id}",
                  cycle.company_id)


def on_declined(db: Session, req, party=None, reason: str = "") -> None:
    r = _for(db, req)
    if r is None:
        return
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    r.stage, r.sign_request_id = "hr_review", ""
    _round(r, getattr(party, "email", "") or r.employee_email, "declined", reason or "")
    if cycle:
        for to in hr_recipients(db, cycle):
            _tell(db, to, f"perf-review-hr:{cycle.id}", "Reviews to Finalize",
                  f"{perf.name_of(db, r.employee_email)} did not sign their review ({cycle.name})"
                  + (f": \"{reason.strip()[:200]}\"" if (reason or "").strip() else "") + ". It is back with HR.",
                  f"performance:review:{r.id}", cycle.company_id)


def on_voided(db: Session, req, actor: str = "") -> None:
    r = _for(db, req)
    if r is None:
        return
    r.stage, r.sign_request_id = "hr_review", ""
    _round(r, actor or "", "signing_canceled", "Signing was canceled in Nexus Sign.")


def safe(fn, *a, **kw) -> None:
    """A problem here must never cost anyone their signature."""
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[perf-reviews] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


# ── What a viewer gets ───────────────────────────────────────────────────────

def overdue(r: models.PerfReview, cycle: models.PerfReviewCycle, on: Optional[str] = None) -> bool:
    on = on or today()
    if cycle.status != "active":
        return False
    if r.stage == "self_review":
        return bool(cycle.self_due) and on > cycle.self_due
    if r.stage == "manager_review":
        return bool(cycle.manager_due) and on > cycle.manager_due
    return False


def cycle_out(db: Session, cycle: models.PerfReviewCycle, counts: Optional[dict] = None) -> dict:
    out = {"id": cycle.id, "companyId": cycle.company_id, "name": cycle.name, "periodStart": cycle.period_start or "",
           "periodEnd": cycle.period_end or "", "selfDue": cycle.self_due or "", "managerDue": cycle.manager_due or "",
           "filters": clean_filters(cycle.filters), "questions": cycle.questions or [],
           "ratingScale": cycle.rating_scale or DEFAULT_SCALE, "values": cycle.values or [],
           "includeGoals": bool(cycle.include_goals), "status": cycle.status, "launchedAt": cycle.launched_at or "",
           "closedAt": cycle.closed_at or "", "createdAt": cycle.created_at or ""}
    if counts is not None:
        out["counts"] = counts
    return out


def review_out(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle, a: Access) -> dict:
    """The review as THIS viewer may see it. The employee gets the manager's
    and HR's parts only once shared, and never the private note."""
    full = not a.employee or r.stage in ("shared", "complete")
    show_self = a.employee or r.stage != "self_review"
    out = {
        "id": r.id, "cycle": cycle_out(db, cycle), "employeeEmail": r.employee_email,
        "employeeName": perf.name_of(db, r.employee_email), "managerEmail": r.manager_email or "",
        "managerName": perf.name_of(db, r.manager_email) if r.manager_email else "HR",
        "stage": r.stage, "stageLabel": STAGE_LABELS.get(r.stage, r.stage), "overdue": overdue(r, cycle),
        "selfSubmittedAt": r.self_submitted_at or "", "sharedAt": r.shared_at or "", "completedAt": r.completed_at or "",
        "selfAnswers": (r.self_answers or {}) if show_self else {}, "selfValues": (r.self_values or {}) if show_self else {},
        "role": {"employee": a.employee, "manager": a.manager, "hr": a.hr, "chain": a.chain},
        "can": {
            "editSelf": a.employee and r.stage == "self_review" and cycle.status != "closed",
            "editManager": (a.writes_manager_part and r.stage == "manager_review" and cycle.status != "closed")
                           or (a.hr and r.stage == "hr_review"),
            "finalize": a.hr and r.stage == "hr_review",
            "recall": a.hr and r.stage == "shared",
            "reassign": a.hr and r.stage not in ("shared", "complete"),
            "startPromotion": a.hr and r.stage == "complete",
        },
    }
    if full:
        out.update({"managerAnswers": r.manager_answers or {}, "managerValues": r.manager_values or {},
                    "overallRating": r.overall_rating, "managerSummary": r.manager_summary or "",
                    "goals": r.goals_snapshot or [], "hrNote": r.hr_note or "",
                    "managerSubmittedAt": r.manager_submitted_at or ""})
    if not a.employee:
        out["privateNote"] = r.manager_private_note or ""
        out["history"] = [{**h, "byName": perf.name_of(db, h.get("by")) if h.get("by") else "Nexus"} for h in (r.history or [])]
    if a.employee and r.stage == "shared" and r.sign_request_id:
        p = (db.query(models.HrSignParty).filter(models.HrSignParty.request_id == r.sign_request_id,
                                                 func.lower(models.HrSignParty.email) == r.employee_email).first())
        out["signPartyId"] = p.id if p else ""
    return out


def stage_counts(rows: list) -> dict:
    out = {s: 0 for s in STAGES}
    for r in rows:
        out[r.stage] = out.get(r.stage, 0) + 1
    return out


def nudge(db: Session, user: dict, cycle: models.PerfReviewCycle, ids: Optional[list], overdue_only: bool) -> int:
    """Remind whoever a review waits on - the employee for a self review, the
    manager for theirs. One notice per person per cycle, rewritten; a review
    nudged in the last 20 hours is skipped."""
    require_hr(db, user, cycle.company_id)
    if cycle.status != "active":
        raise HTTPException(409, "Only an active cycle sends reminders.")
    q = db.query(models.PerfReview).filter(models.PerfReview.cycle_id == cycle.id,
                                           models.PerfReview.stage.in_(("self_review", "manager_review")))
    if ids:
        q = q.filter(models.PerfReview.id.in_(list(ids)))
    now = datetime.now(timezone.utc)
    on = today()
    by_person: dict = {}
    for r in q.with_for_update().all():
        if overdue_only and not overdue(r, cycle, on):
            continue
        last = perf._parse_any(r.nudged_at)
        if last is not None and now - last < NUDGE_EVERY:
            continue
        r.nudged_at = _now()
        if r.stage == "self_review":
            by_person.setdefault(r.employee_email, []).append(("self", r))
        else:
            for m in ([r.manager_email] if r.manager_email else hr_recipients(db, cycle)):
                by_person.setdefault(m, []).append(("manager", r))
    for to, items in by_person.items():
        mine = [r for k, r in items if k == "self"]
        theirs = [r for k, r in items if k == "manager"]
        parts = []
        if mine:
            parts.append(f"your self review (due {us_date(cycle.self_due)})")
        if theirs:
            names = ", ".join(perf.name_of(db, r.employee_email) for r in theirs[:4]) + (
                f" and {len(theirs) - 4} more" if len(theirs) > 4 else "")
            parts.append(f"the review of {names} (due {us_date(cycle.manager_due)})")
        first = (mine or theirs)[0]
        _tell(db, to, f"perf-review-nudge:{cycle.id}", "Review Reminder",
              f"{cycle.name}: HR is waiting on " + " and ".join(parts) + ".",
              f"performance:review:{first.id}", cycle.company_id)
    return sum(len(v) for v in by_person.values())
