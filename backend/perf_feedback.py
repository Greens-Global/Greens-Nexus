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

def kudos_values(db: Session, company_id: str) -> list:
    return perf.settings_for_company(db, company_id).get("kudosValues") or []


def give_kudos(db: Session, user: dict, to: str, message: str, value: str = "") -> models.PerfKudos:
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
    value = (value or "").strip()[:40]
    if value:
        # shortcut: the picker shows the SENDER's company list; a value from either company's list is accepted
        mine = perf.employee(db, me)
        allowed = kudos_values(db, emp.company or "") + kudos_values(db, (mine.company if mine else "") or "")
        if value.lower() not in [v.lower() for v in allowed]:
            raise HTTPException(400, "Pick one of the company's values.")
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    K = models.PerfKudos
    if db.query(K).filter(K.from_email == me, K.created_at >= since).count() >= KUDOS_PER_DAY:
        raise HTTPException(429, f"{KUDOS_PER_DAY} kudos a day at most - try again tomorrow.")
    k = K(id=perf.new_id(), company_id=emp.company or "", from_email=me, to_email=to, message=msg,
          created_at=perf.now_iso(), hidden_at="", hidden_by="", value=value, seen_at="")
    db.add(k)
    sender = perf.name_of(db, me)
    # One bell per kudos (Neil, 11/08/2026), grown in place as people add their thanks.
    _tell(db, to, _bell_key(k), "Kudos For You", f"{sender}: \"{msg[:200]}\"", f"performance:kudos:{k.id}", emp.company or "")
    mgr = _low(emp.manager_email)
    if mgr and mgr != me and mgr != to:
        _tell(db, mgr, "perf-kudos-team", "Kudos For Your Team",
              f"{sender} gave {perf.name_of(db, to)} kudos: \"{msg[:160]}\"", f"performance:kudos:{k.id}", emp.company or "")
    return k


def _bell_key(k: models.PerfKudos) -> str:
    return f"perf-kudos:{k.id}"


# ── Thanks (Neil, 11/08/2026) ────────────────────────────────────────────────

THANKS_NOTE_MAX = 200


def _thanks_rows(db: Session, kudos_ids: list) -> dict:
    T = models.PerfKudosThanks
    out = {kid: [] for kid in kudos_ids}
    if kudos_ids:
        for t in db.query(T).filter(T.kudos_id.in_(kudos_ids)).order_by(T.created_at.asc()).all():
            out.setdefault(t.kudos_id, []).append(t)
    return out


def _recount_bell(db: Session, k: models.PerfKudos) -> None:
    """The recipient's one "Kudos For You" bell for this kudos, rewritten
    with how many people added their thanks - never a bell per thanks."""
    import notify_rollup
    T = models.PerfKudosThanks
    n = db.query(T).filter(T.kudos_id == k.id, T.from_email != _low(k.to_email)).count()
    sender = perf.name_of(db, k.from_email)
    head = f"{sender} sent you kudos" + (f" · {n} {'person' if n == 1 else 'people'} added their thanks" if n else "")
    notify_rollup.upsert_rollup(db, recipient=k.to_email, key=_bell_key(k), title="Kudos For You",
                                line=f"{head}\n\"{(k.message or '')[:200]}\"", replace=True,
                                action={"view": "myhr", "sub": f"performance:kudos:{k.id}"}, company=k.company_id or "")


def add_thanks(db: Session, user: dict, k: models.PerfKudos, note: str = "") -> models.PerfKudosThanks:
    """A "+1" on someone else's kudos, or - from the recipient - the reply
    (Say Thanks), which bells the sender once and marks the kudos seen."""
    me = _low(user.get("email"))
    if k is None or k.hidden_at or not can_read_kudos(db, user, k):
        raise HTTPException(404, "Kudos not found")
    if me == _low(k.from_email):
        raise HTTPException(400, "Those are your own kudos.")
    T = models.PerfKudosThanks
    if db.query(T).filter(T.kudos_id == k.id, T.from_email == me).first() is not None:
        raise HTTPException(409, "You already added your thanks.")
    t = T(id=perf.new_id(), kudos_id=k.id, from_email=me, note=(note or "").strip()[:THANKS_NOTE_MAX],
          created_at=perf.now_iso())
    db.add(t)
    db.flush()   # the unique key answers a race with an error, never two rows
    if me == _low(k.to_email):
        k.seen_at = k.seen_at or perf.now_iso()
        _tell(db, k.from_email, f"perf-kudos-thanks:{k.id}", "They Said Thanks",
              f"{perf.name_of(db, me)} said thanks for your kudos" + (f": \"{t.note}\"" if t.note else ""),
              f"performance:kudos:{k.id}", k.company_id or "")
    else:
        _recount_bell(db, k)
    return t


def remove_thanks(db: Session, user: dict, k: models.PerfKudos) -> None:
    me = _low(user.get("email"))
    if k is None or not can_read_kudos(db, user, k):
        raise HTTPException(404, "Kudos not found")
    T = models.PerfKudosThanks
    t = db.query(T).filter(T.kudos_id == k.id, T.from_email == me).first()
    if t is None:
        raise HTTPException(404, "You had not added your thanks.")
    db.delete(t)
    db.flush()
    if me != _low(k.to_email):
        _recount_bell(db, k)


def unseen(db: Session, user: dict) -> list:
    """The caller's received kudos they have not looked at yet, newest first, three at most."""
    me = _low(user.get("email"))
    K = models.PerfKudos
    rows = (db.query(K).filter(K.to_email == me, K.hidden_at == "", K.seen_at == "")
            .order_by(K.created_at.desc()).limit(3).all())
    return [kudos_out(db, user, k) for k in rows]


def mark_seen(db: Session, user: dict, k: models.PerfKudos) -> None:
    if k is None or _low(k.to_email) != _low(user.get("email")):
        raise HTTPException(404, "Kudos not found")
    k.seen_at = k.seen_at or perf.now_iso()


def summary(db: Session, user: dict) -> dict:
    """The Workday profile row: kudos received this year and who sent the latest."""
    me = _low(user.get("email"))
    K = models.PerfKudos
    year = datetime.now(timezone.utc).strftime("%Y-01-01")
    q = db.query(K).filter(K.to_email == me, K.hidden_at == "", K.created_at >= year)
    latest = q.order_by(K.created_at.desc()).first()
    return {"thisYear": q.count(), "latestFrom": perf.name_of(db, latest.from_email) if latest else ""}


# ── The Teams post (Neil, 11/08/2026) ────────────────────────────────────────
# One post per kudos through the ticket Teams queue (kind "kudos", the same
# retry sweep as every other Teams post) into the chat Settings names
# (`kudos_teams_chat_id`, a Super Administrator's). Never a Graph call here.

TEAMS_KIND = "kudos"
CHAT_ID_KEY = "kudos_teams_chat_id"


def teams_chat_id(db: Session) -> str:
    row = db.get(models.NexusSetting, CHAT_ID_KEY)
    return (row.value or "").strip() if row else ""


def queue_teams_post(db: Session, k: models.PerfKudos):
    """Queue (not send) the kudos post; None when no chat is set. The caller
    commits and hands the row to routers.tickets._deliver_teams_dm."""
    import html as html_lib
    from routers.task_util import gen_id
    chat_id = teams_chat_id(db)
    if not chat_id:
        return None
    text = f"Kudos: {perf.name_of(db, k.from_email)} to {perf.name_of(db, k.to_email)} - " \
           + (f"{k.value} - " if k.value else "") + (k.message or "")
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=k.id, agent_email=k.from_email, requester_email=k.from_email,
                                    html=f"<p>{html_lib.escape(text)}</p>", chat_id=chat_id, created_at=perf.now_iso(),
                                    kind=TEAMS_KIND)
    db.add(row)
    return row


def deliver_teams(db: Session, row) -> bool:
    """One delivery attempt for a claimed kudos row (teams_post.deliver_ticket_row):
    as the sender when they are in the chat, else the feedback chat's fallback
    posters. Commits the outcome."""
    import bff_session
    from feature_requests import _env_posters
    from teams_post import send_chat_message
    errors = []
    for who in dict.fromkeys([_low(row.requester_email), *_env_posters()]):
        if not who:
            continue
        tok = bff_session.graph_token_for_email(db, who)
        if not tok:
            errors.append(f"{who}: no Teams session")
            continue
        try:
            send_chat_message(tok, row.chat_id, row.html)
        except Exception as ex:  # noqa: BLE001 - the next person may be in the chat
            errors.append(f"{who}: {str(ex)[:120]}")
            continue
        row.agent_email, row.sent, row.send_error = who, 1, ""
        db.commit()
        return True
    row.send_error = ("; ".join(errors) or "nobody to post as")[:300]
    db.commit()
    return False


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


def kudos_out(db: Session, user: dict, k: models.PerfKudos, thanks: Optional[list] = None) -> dict:
    me = _low(user.get("email"))
    if thanks is None:
        thanks = _thanks_rows(db, [k.id])[k.id]
    mine = next((t for t in thanks if _low(t.from_email) == me), None)
    return {"id": k.id, "fromEmail": k.from_email, "fromName": perf.name_of(db, k.from_email),
            "toEmail": k.to_email, "toName": perf.name_of(db, k.to_email), "message": k.message or "",
            "value": k.value or "", "seenAt": k.seen_at or "",
            "createdAt": k.created_at or "", "hidden": bool(k.hidden_at),
            "thanks": [{"email": t.from_email, "name": perf.name_of(db, t.from_email), "note": t.note or ""} for t in thanks],
            "thanksCount": len(thanks), "myThanks": {"note": mine.note or ""} if mine else None,
            "can": {"hide": not k.hidden_at and (me == _low(k.from_email) or perf.hr_for(db, user, k.company_id or "")),
                    "thank": not k.hidden_at and me != _low(k.from_email) and mine is None}}


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
    thanks = _thanks_rows(db, [k.id for k in rows])
    mine = perf.employee(db, me)
    return {"items": [kudos_out(db, user, k, thanks[k.id]) for k in rows if can_read_kudos(db, user, k)], "receivedLast90": received,
            # The send form: the viewer's company values and whether a Teams chat is set.
            "values": kudos_values(db, (mine.company if mine else "") or ""), "teamsChat": bool(teams_chat_id(db))}


def waiting_feedback(db: Session, user: dict) -> list:
    """Asks waiting on the caller (approvals_inbox)."""
    me = _low(user.get("email"))
    F = models.PerfFeedback
    return db.query(F).filter(F.giver_email == me, F.status == "requested").order_by(F.requested_at).limit(100).all()
