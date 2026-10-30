"""Performance: peer feedback and kudos (Neil, Oct 29 2026: "add all the
bigger features"). Kept as plain as the rest of the module
(performance.py): two questions, one button, no scores. routers/
perf_feedback.py is the API; the people rules are performance.py's
(`chain`, `hr_reach`), so "who sees what" stays one rule.

PEER FEEDBACK
  Anyone asks colleagues about THEMSELVES - the answers are theirs: they
  and the giver read them, nobody else (feedback for growth, not a file).
  A manager (anyone above the person by Reports To) or HR asks colleagues
  about SOMEONE - for a review or any time. Those answers are private: the
  person's reporting chain and HR for their company read them; the person
  never does. The giver always reads what they wrote.
  The giver answers two questions - What do they do well? What could they
  do better? - and Submits, or Declines with an optional note. The asker
  may cancel an ask nobody has answered. Each ask is a bell to the giver
  and a row in their Approvals; a submitted answer is a bell to the asker.

KUDOS
  A short thank-you from one colleague to another (3 to 500 characters,
  never to yourself, at most KUDOS_PER_DAY a day). Everyone in the
  recipient's company sees it; the recipient and their manager get a bell.
  Never deleted: the sender or HR for the company hides it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
import performance as perf

QUESTIONS = [
    {"id": "well", "text": "What do they do well?"},
    {"id": "better", "text": "What could they do better?"},
]
STATUS_LABELS = {"requested": "Waiting", "submitted": "Answered", "declined": "Declined", "canceled": "Canceled"}
MAX_GIVERS = 10
KUDOS_PER_DAY = 20
KUDOS_MAX = 500


def _low(s) -> str:
    return (s or "").strip().lower()


def _tell(db: Session, to: str, key: str, title: str, line: str, sub: str, company: str = "") -> None:
    import notify_rollup
    if to:
        notify_rollup.upsert_rollup(db, recipient=to, key=key, title=title, line=line,
                                    action={"view": "myhr", "sub": sub}, company=company)


def colleague(db: Session, email: str):
    """An active internal person in Nexus People (the curated list), or None."""
    emp = perf.employee(db, email)
    if emp is None or not perf._active(emp) or (emp.identity_type or "internal") != "internal":
        return None
    return emp


# ── Peer feedback ────────────────────────────────────────────────────────────

class Seat:
    """What one viewer is to one feedback row."""
    def __init__(self, db: Session, user: dict, f: models.PerfFeedback):
        me = _low(user.get("email"))
        self.me = me
        self.giver = me == _low(f.giver_email)
        self.asker = me == _low(f.requested_by)
        self.subject = me == _low(f.subject_email)
        above = not self.subject and perf.is_above(db, me, f.subject_email)
        hr = not self.subject and perf.hr_for(db, user, f.company_id or "")
        # Self-asked feedback is the person's own; a manager's ask is the
        # chain's and HR's, never the person's.
        self.reader = self.giver or self.asker or (self.subject if not f.private else (above or hr))
        self.hr = hr
        self.any = not user.get("external") and self.reader


def seat_or_404(db: Session, user: dict, f: Optional[models.PerfFeedback]) -> Seat:
    if f is None:
        raise HTTPException(404, "Feedback not found")
    s = Seat(db, user, f)
    if not s.any:
        raise HTTPException(404, "Feedback not found")
    return s


def may_ask_about(db: Session, user: dict, subject: str) -> bool:
    """Yourself, or someone below you by Reports To, or anyone HR looks after."""
    me = _low(user.get("email"))
    return subject == me or perf.is_above(db, me, subject) or perf.hr_for_person(db, user, subject)


def request(db: Session, user: dict, *, subject: str, givers: list, note: str = "", review_id: str = "") -> list:
    me = _low(user.get("email"))
    subject = _low(subject) or me
    emp = colleague(db, subject)
    if emp is None:
        raise HTTPException(400, "Pick someone in Nexus People.")
    if not may_ask_about(db, user, subject):
        raise HTTPException(403, "You can ask for feedback about yourself, or about someone on your team.")
    want = []
    for g in givers or []:
        g = _low(g)
        if g and g not in want and g not in (subject, me):
            want.append(g)
    if not want:
        raise HTTPException(400, "Pick who to ask - not the person themselves.")
    if len(want) > MAX_GIVERS:
        raise HTTPException(400, f"Ask {MAX_GIVERS} people at most at a time.")
    rid = (review_id or "").strip()
    if rid:
        r = db.get(models.PerfReview, rid)
        if r is None or _low(r.employee_email) != subject:
            raise HTTPException(400, "That review is not theirs.")
    private = subject != me
    open_now = {_low(f.giver_email) for f in db.query(models.PerfFeedback).filter(
        models.PerfFeedback.subject_email == subject, models.PerfFeedback.requested_by == me,
        models.PerfFeedback.status == "requested").all()}
    now = perf.now_iso()
    who = perf.name_of(db, subject)
    out = []
    for g in want:
        if colleague(db, g) is None:
            raise HTTPException(400, f"{g} is not in Nexus People.")
        if g in open_now:
            continue
        f = models.PerfFeedback(id=perf.new_id(), company_id=emp.company or "", subject_email=subject, giver_email=g,
                                requested_by=me, review_id=rid, private=private, note=(note or "").strip()[:1000],
                                answers={}, status="requested", requested_at=now, created_at=now, updated_at=now)
        db.add(f)
        out.append(f)
        about = "about themselves" if not private else f"about {who}"
        _tell(db, g, f"perf-feedback-ask:{me}", "Feedback Requested",
              f"{perf.name_of(db, me)} asked for your feedback {about}.", f"performance:feedback:{f.id}", emp.company or "")
    return out


def _clean(answers) -> dict:
    out = {}
    for q in QUESTIONS:
        v = (answers or {}).get(q["id"]) if isinstance(answers, dict) else None
        if isinstance(v, str) and v.strip():
            out[q["id"]] = v.strip()[:4000]
    return out


def answer(db: Session, user: dict, f: models.PerfFeedback, answers, submit: bool) -> None:
    s = seat_or_404(db, user, f)
    if not s.giver:
        raise HTTPException(403, "Only the person asked can answer.")
    if f.status != "requested":
        raise HTTPException(409, "This ask is closed.")
    f.answers = _clean(answers)
    f.updated_at = perf.now_iso()
    if not submit:
        return
    if not any(len(v) >= 3 for v in f.answers.values()):
        raise HTTPException(400, "Answer at least one question first.")
    f.status, f.submitted_at = "submitted", perf.now_iso()
    _tell(db, f.requested_by, f"perf-feedback-in:{f.subject_email}", "Feedback Received",
          f"{perf.name_of(db, f.giver_email)} answered your ask for feedback"
          + ("" if not f.private else f" about {perf.name_of(db, f.subject_email)}") + ".",
          f"performance:feedback:{f.id}", f.company_id or "")


def decline(db: Session, user: dict, f: models.PerfFeedback, note: str) -> None:
    s = seat_or_404(db, user, f)
    if not s.giver:
        raise HTTPException(403, "Only the person asked can decline.")
    if f.status != "requested":
        raise HTTPException(409, "This ask is closed.")
    f.status, f.decline_note, f.closed_at = "declined", (note or "").strip()[:1000], perf.now_iso()
    f.updated_at = f.closed_at


def cancel(db: Session, user: dict, f: models.PerfFeedback) -> None:
    s = seat_or_404(db, user, f)
    if not (s.asker or s.hr):
        raise HTTPException(403, "Only whoever asked can cancel it.")
    if f.status != "requested":
        raise HTTPException(409, "This ask is closed.")
    f.status, f.closed_at = "canceled", perf.now_iso()
    f.updated_at = f.closed_at


def feedback_out(db: Session, user: dict, f: models.PerfFeedback, s: Optional[Seat] = None) -> dict:
    s = s or Seat(db, user, f)
    show = f.status == "submitted" or s.giver
    return {
        "id": f.id, "subjectEmail": f.subject_email, "subjectName": perf.name_of(db, f.subject_email),
        "giverEmail": f.giver_email, "giverName": perf.name_of(db, f.giver_email),
        "requestedBy": f.requested_by or "", "requestedByName": perf.name_of(db, f.requested_by) if f.requested_by else "",
        "private": bool(f.private), "note": f.note or "", "reviewId": f.review_id or "",
        "status": f.status, "statusLabel": STATUS_LABELS.get(f.status, f.status),
        "answers": (f.answers or {}) if show else {},
        "declineNote": (f.decline_note or "") if (s.giver or s.asker) else "",
        "requestedAt": f.requested_at or "", "submittedAt": f.submitted_at or "",
        "questions": list(QUESTIONS),
        "can": {"answer": s.giver and f.status == "requested",
                "decline": s.giver and f.status == "requested",
                "cancel": (s.asker or s.hr) and f.status == "requested"},
    }


def lists(db: Session, user: dict, person: str = "") -> dict:
    """`person` '' = mine: asks waiting on me (and what I gave), and what I
    asked about myself. With `person`: the feedback about them I may read."""
    me = _low(user.get("email"))
    F = models.PerfFeedback
    if person and _low(person) != me:
        who = _low(person)
        if not perf.can_see_person(db, user, who):
            raise HTTPException(404, "Person not found")
        rows = db.query(F).filter(F.subject_email == who, F.status != "canceled").order_by(F.requested_at.desc()).limit(200).all()
        return {"about": [feedback_out(db, user, f, s) for f in rows for s in [Seat(db, user, f)] if s.any]}
    asked = db.query(F).filter(F.giver_email == me, F.status.in_(("requested", "submitted"))) \
        .order_by(F.requested_at.desc()).limit(100).all()
    mine = db.query(F).filter(F.subject_email == me, F.requested_by == me, F.status != "canceled") \
        .order_by(F.requested_at.desc()).limit(200).all()
    return {"toAnswer": [feedback_out(db, user, f) for f in asked if f.status == "requested"],
            "given": [feedback_out(db, user, f) for f in asked if f.status == "submitted"][:30],
            "aboutMe": [feedback_out(db, user, f) for f in mine]}


def for_review(db: Session, user: dict, r: models.PerfReview, cycle: models.PerfReviewCycle) -> list:
    """Private feedback about the person, asked for this review or answered
    inside its period, as far as the viewer may read it (the review form)."""
    F = models.PerfFeedback
    rows = db.query(F).filter(F.subject_email == r.employee_email, F.private.is_(True), F.status == "submitted").all()
    start, end = cycle.period_start or "", cycle.period_end or "9999"
    out = []
    for f in rows:
        day = (f.submitted_at or "")[:10]
        if f.review_id != r.id and not (start <= day <= end):
            continue
        s = Seat(db, user, f)
        if s.any:
            out.append(feedback_out(db, user, f, s))
    out.sort(key=lambda x: x["submittedAt"], reverse=True)
    return out


# ── Kudos ────────────────────────────────────────────────────────────────────

def give_kudos(db: Session, user: dict, to: str, message: str) -> models.PerfKudos:
    me = _low(user.get("email"))
    to = _low(to)
    if to == me:
        raise HTTPException(400, "Kudos go to someone else.")
    emp = colleague(db, to)
    if emp is None:
        raise HTTPException(400, "Pick someone in Nexus People.")
    msg = (message or "").strip()
    if len(msg) < 3:
        raise HTTPException(400, "Say what they did.")
    if len(msg) > KUDOS_MAX:
        raise HTTPException(400, f"Keep it to {KUDOS_MAX} characters.")
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    K = models.PerfKudos
    if db.query(K).filter(K.from_email == me, K.created_at >= since).count() >= KUDOS_PER_DAY:
        raise HTTPException(429, f"{KUDOS_PER_DAY} kudos a day at most - try again tomorrow.")
    k = K(id=perf.new_id(), company_id=emp.company or "", from_email=me, to_email=to, message=msg,
          created_at=perf.now_iso(), hidden_at="", hidden_by="")
    db.add(k)
    sender = perf.name_of(db, me)
    _tell(db, to, "perf-kudos", "Kudos For You", f"{sender}: \"{msg[:200]}\"", f"performance:kudos:{k.id}", emp.company or "")
    mgr = _low(emp.manager_email)
    if mgr and mgr != me and mgr != to:
        _tell(db, mgr, "perf-kudos-team", "Kudos For Your Team",
              f"{sender} gave {perf.name_of(db, to)} kudos: \"{msg[:160]}\"", f"performance:kudos:{k.id}", emp.company or "")
    return k


def can_read_kudos(db: Session, user: dict, k: models.PerfKudos) -> bool:
    if user.get("external"):
        return False
    me = _low(user.get("email"))
    if me in (_low(k.from_email), _low(k.to_email)) or perf.hr_for(db, user, k.company_id or ""):
        return True
    emp = perf.employee(db, me)
    return emp is not None and (emp.company or "") == (k.company_id or "") and not k.hidden_at


def hide_kudos(db: Session, user: dict, k: models.PerfKudos) -> None:
    me = _low(user.get("email"))
    if not (me == _low(k.from_email) or perf.hr_for(db, user, k.company_id or "")):
        raise HTTPException(403, "Only the sender or HR can take kudos down.")
    k.hidden_at, k.hidden_by = perf.now_iso(), me


def kudos_out(db: Session, user: dict, k: models.PerfKudos) -> dict:
    me = _low(user.get("email"))
    return {"id": k.id, "fromEmail": k.from_email, "fromName": perf.name_of(db, k.from_email),
            "toEmail": k.to_email, "toName": perf.name_of(db, k.to_email), "message": k.message or "",
            "createdAt": k.created_at or "", "hidden": bool(k.hidden_at),
            "can": {"hide": not k.hidden_at and (me == _low(k.from_email) or perf.hr_for(db, user, k.company_id or ""))}}


def kudos_list(db: Session, user: dict, scope: str = "company", person: str = "", company: str = "") -> dict:
    """`company`: the viewer's company feed (HR may pick one they look
    after); `mine`: to me and from me; `person`: to that person."""
    me = _low(user.get("email"))
    K = models.PerfKudos
    q = db.query(K).filter(K.hidden_at == "")
    if scope == "mine":
        q = q.filter((K.to_email == me) | (K.from_email == me))
    elif scope == "person":
        who = _low(person)
        emp = perf.employee(db, who)
        mine = perf.employee(db, me)
        if emp is None or not (perf.can_see_person(db, user, who)
                               or (mine is not None and (mine.company or "") == (emp.company or ""))):
            raise HTTPException(404, "Person not found")
        q = q.filter(K.to_email == who)
    else:
        cid = (company or "").strip()
        if cid and not perf.hr_for(db, user, cid):
            mine = perf.employee(db, me)
            if mine is None or (mine.company or "") != cid:
                raise HTTPException(404, "Company not found")
        if not cid:
            mine = perf.employee(db, me)
            cid = (mine.company if mine else "") or ""
        q = q.filter(K.company_id == cid)
    rows = q.order_by(K.created_at.desc()).limit(60).all()
    since = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    received = db.query(K).filter(K.to_email == me, K.hidden_at == "", K.created_at >= since).count()
    return {"items": [kudos_out(db, user, k) for k in rows if can_read_kudos(db, user, k)], "receivedLast90": received}


def waiting_feedback(db: Session, user: dict) -> list:
    """Asks waiting on the caller (approvals_inbox)."""
    me = _low(user.get("email"))
    F = models.PerfFeedback
    return db.query(F).filter(F.giver_email == me, F.status == "requested").order_by(F.requested_at).limit(100).all()
