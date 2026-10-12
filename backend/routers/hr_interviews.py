"""AI-assisted interviews (HR roadmap Section C/F crossover).

Flow: HR schedules an interview from the candidate → a real Teams meeting
invite goes to the candidate's email (Graph calendar event, organizer = the
scheduler). During the call the interviewer opens the questionnaire ("Interview
started"); afterwards the Teams transcript is pulled (or pasted) and Claude
auto-fills the candidate's answers, then "Calibrate" scores every answer against
the question and builds a per-role leaderboard. Winner gets a one-click
"final round / offer discussion" invite.

Recording (Pranshu, Oct 8): the meeting is set to record and transcribe
itself from the moment it starts (onlineMeeting.recordAutomatically), so
nobody has to remember to press Record. After End Interview, Nexus pulls the
transcript (scoring) AND the recording (mp4) from Teams into the private
hr-docs bucket; both show on the candidate and, once they are hired, on the
employee's profile (Interviews tab + Documents). Teams keeps auto-recordings
for a limited time, which is why the copy is taken.

Graph requirements (same app registration as provisioning):
  - Calendars.ReadWrite  (application) → create the meeting invites
  - OnlineMeetings.ReadWrite.All (application) + the Teams application access
    policy (New-CsApplicationAccessPolicy … -Identity <organizer>) → find the
    meeting and switch auto-recording on
  - OnlineMeetingTranscript.Read.All → pull transcripts
  - OnlineMeetingRecording.Read.All → pull recordings
Endpoints degrade with clear error messages when a permission is missing;
the questionnaire + paste-transcript + AI flow works regardless.
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import HrInterview, HrInterviewTemplate, HrCandidate, HrStageEvent
from routers.hr import (require_hr_read, require_hr_write, _graph_token, _GRAPH,
                        _hr_notify)
from auth import hr_scope


# Company scoping (Neil, Aug 25): candidates carry a company, and a company-
# scoped People admin must only see/touch their companies' pipeline - the same
# contract hr.py enforces on /hr/candidates. These helpers resolve an interview
# or candidate to its company and 404 when it's out of the caller's scope.

def _cand_scoped(cand: Optional[HrCandidate], user: dict, db: Session) -> HrCandidate:
    scope = hr_scope(user, db)
    if scope is not None and (cand is None or (cand.company or "") not in scope):
        raise HTTPException(404, "Candidate not found")
    return cand


def _iv_scoped(iv: Optional[HrInterview], user: dict, db: Session) -> HrInterview:
    if iv is None:
        raise HTTPException(404, "Interview not found")
    scope = hr_scope(user, db)
    if scope is not None:
        cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
        if cand is None or (cand.company or "") not in scope:
            raise HTTPException(404, "Interview not found")
    return iv


def _advance_to_interview(db: Session, cand: HrCandidate, by: str, note: str, pull_back: bool = False):
    """Pipeline follows the interview lifecycle. Early-stage candidates get
    pulled into Interview; and EVERY milestone (scheduled/started/completed/
    scored) lands in the stage history - so the timeline reads the full story,
    not just 'scheduled' forever. `pull_back` (scheduling another round from
    Offer - Neil, Oct 8: "they've moved from offer back to interview") moves
    an Offer candidate back to Interview too."""
    if not cand:
        return
    if cand.stage in ("applied", "screening") or (pull_back and cand.stage == "offer"):
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id,
                            from_stage=cand.stage, to_stage="interview",
                            note=note, by_email=by, created_at=_now()))
        cand.stage = "interview"
    else:
        # Same-stage milestone entry (timeline note, no stage change).
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id,
                            from_stage=cand.stage, to_stage=cand.stage,
                            note=note, by_email=by, created_at=_now()))
    cand.updated_at = _now()

router = APIRouter(prefix="/hr", tags=["Interviews"])

_AI_MODEL = "claude-opus-4-8"
_ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _claude(prompt: str, max_tokens: int = 3000) -> str:
    if not _ANTHROPIC_KEY:
        raise HTTPException(503, "AI is not configured (ANTHROPIC_API_KEY missing)")
    r = httpx.post("https://api.anthropic.com/v1/messages",
                   headers={"x-api-key": _ANTHROPIC_KEY, "anthropic-version": "2023-06-01",
                            "content-type": "application/json"},
                   json={"model": _AI_MODEL, "max_tokens": max_tokens,
                         "messages": [{"role": "user", "content": prompt}]},
                   timeout=120)
    if not r.is_success:
        raise HTTPException(502, f"AI call failed: {r.text[:200]}")
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()


def _json_block(text: str):
    """Parse the first JSON object/array out of a model reply (tolerates fences)."""
    m = re.search(r"```(?:json)?\s*([\[{].*?[\]}])\s*```", text, re.S) or re.search(r"([\[{].*[\]}])", text, re.S)
    if not m:
        raise HTTPException(502, "AI returned no JSON")
    return json.loads(m.group(1))


def _ser_tpl(t: HrInterviewTemplate) -> dict:
    return {"id": t.id, "name": t.name, "questions": t.questions or [],
            "roleIds": t.role_ids or [], "isGeneral": bool(t.is_general),
            "createdBy": t.created_by, "updatedAt": t.updated_at}


def questionnaire_for(db: Session, cand: Optional[HrCandidate]) -> Optional[HrInterviewTemplate]:
    """The questionnaire an interview uses (Neil, Oct 8: "it should not ask what
    questionnaire. It should be the questionnaire tied to that role"): the one
    linked to the candidate's job role, else the General one, else none."""
    tpls = db.query(HrInterviewTemplate).order_by(HrInterviewTemplate.name).all()
    role_id = (cand.role_id or "") if cand else ""
    if role_id:
        for t in tpls:
            if role_id in (t.role_ids or []):
                return t
    return next((t for t in tpls if t.is_general), None)


def _names(db: Session, emails: list) -> dict:
    from models import NexusEmployee
    emails = [e for e in (emails or []) if e]
    if not emails:
        return {}
    rows = db.query(NexusEmployee).filter(NexusEmployee.work_email.in_(emails)).all()
    return {r.work_email: (r.display_name or f"{r.first_name} {r.last_name}").strip() for r in rows}


def _ser_iv(i: HrInterview, cand: HrCandidate = None) -> dict:
    return {"id": i.id, "candidateId": i.candidate_id,
            "candidateName": f"{cand.first_name} {cand.last_name}".strip() if cand else "",
            "templateId": i.template_id, "templateName": i.template_name,
            "status": i.status, "at": i.at, "durationMin": i.duration_min,
            "organizerEmail": i.organizer_email or "", "interviewerEmails": i.interviewer_emails or [],
            "joinUrl": i.join_url, "hasTranscript": bool(i.transcript),
            "answers": i.answers or [], "totalScore": i.total_score or 0,
            "summary": i.summary or "", "createdAt": i.created_at,
            "followupStatus": i.followup_status or "", "followupNote": i.followup_note or "",
            "followupAttempts": i.followup_attempts or 0,
            "autoRecord": i.auto_record or "",
            "recordingStatus": i.recording_status or "", "recordingNote": i.recording_note or "",
            "hasRecording": bool(i.recording_path), "recordingSize": i.recording_size or 0,
            "hasTranscriptFile": bool(i.transcript_path)}


# ── Questionnaire templates ───────────────────────────────────────────────────

class TemplateIn(BaseModel):
    name: str
    questions: List[str] = []
    role_ids: Optional[List[str]] = None     # job roles this questionnaire is for
    is_general: Optional[bool] = None        # the fallback for roles without their own


def _apply_template_links(db: Session, t: HrInterviewTemplate, body: TemplateIn) -> None:
    """Role links + the General flag. A role belongs to ONE questionnaire (the
    newest link wins, so scheduling is never ambiguous) and there is one General."""
    if body.role_ids is not None:
        wanted = [r for r in dict.fromkeys(body.role_ids) if r]
        for other in db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id != t.id).all():
            if set(other.role_ids or []) & set(wanted):
                other.role_ids = [r for r in (other.role_ids or []) if r not in wanted]
        t.role_ids = wanted
    if body.is_general is not None:
        if body.is_general:
            db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id != t.id).update({"is_general": False})
        t.is_general = bool(body.is_general)


@router.get("/interview-templates")
def list_templates(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    return [_ser_tpl(t) for t in db.query(HrInterviewTemplate).order_by(HrInterviewTemplate.name).all()]


@router.post("/interview-templates")
def create_template(body: TemplateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Give the questionnaire a role name")
    t = HrInterviewTemplate(id=str(uuid.uuid4()), name=body.name.strip()[:120],
                            questions=[{"id": str(uuid.uuid4())[:8], "q": q.strip()[:500]}
                                       for q in body.questions if q.strip()],
                            created_by=user["email"], created_at=_now(), updated_at=_now())
    db.add(t)
    _apply_template_links(db, t, body)
    db.commit()
    return _ser_tpl(t)


@router.put("/interview-templates/{tid}")
def update_template(tid: str, body: TemplateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    t = db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id == tid).first()
    if not t:
        raise HTTPException(404, "Template not found")
    t.name = body.name.strip()[:120] or t.name
    t.questions = [{"id": str(uuid.uuid4())[:8], "q": q.strip()[:500]} for q in body.questions if q.strip()]
    _apply_template_links(db, t, body)
    t.updated_at = _now()
    db.commit()
    return _ser_tpl(t)


@router.delete("/interview-templates/{tid}")
def delete_template(tid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id == tid).delete()
    db.commit()
    return {"ok": True}


# ── Scheduling: Teams meeting invite on the candidate's email ────────────────

def _graph_create_meeting(organizer: str, subject: str, body_text: str,
                          attendee_email: str, attendee_name: str,
                          start_iso: str, minutes: int, extra_attendees: Optional[list] = None) -> dict:
    """Create a calendar event with a Teams link - Outlook emails the invite to
    the attendee automatically. Returns {eventId, joinUrl} or raises with a
    human explanation."""
    token = _graph_token()
    end = (datetime.fromisoformat(start_iso) + timedelta(minutes=minutes)).isoformat()
    r = httpx.post(f"{_GRAPH}/users/{organizer}/events",
                   headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                   json={
                       "subject": subject,
                       "body": {"contentType": "text", "content": body_text},
                       "start": {"dateTime": start_iso, "timeZone": "UTC"},
                       "end": {"dateTime": end, "timeZone": "UTC"},
                       "attendees": [{"emailAddress": {"address": attendee_email, "name": attendee_name},
                                      "type": "required"}]
                                    + [{"emailAddress": {"address": a["email"], "name": a.get("name") or a["email"]},
                                        "type": "required"} for a in (extra_attendees or [])],
                       "isOnlineMeeting": True,
                       "onlineMeetingProvider": "teamsForBusiness",
                   }, timeout=30)
    if r.status_code == 403:
        raise HTTPException(502, "Microsoft Graph denied creating the meeting - grant the app "
                                 "'Calendars.ReadWrite' (application) in Entra and consent, then retry.")
    if not r.is_success:
        raise HTTPException(502, f"Could not create the Teams meeting: {r.text[:200]}")
    ev = r.json()
    return {"eventId": ev.get("id", ""),
            "joinUrl": ((ev.get("onlineMeeting") or {}).get("joinUrl", ""))}


def _graph_meeting_ids(h: dict, iv: HrInterview, db: Optional[Session] = None) -> tuple:
    """(organizer object id, onlineMeeting id) for this interview's Teams
    meeting, remembered on the row once found. Raises HTTPException: 404 =
    not found (yet), 502 = a permission or setup problem."""
    org = iv.organizer_email
    # /onlineMeetings rejects UPNs ("userId is not a GUID") - resolve the
    # organizer's directory object id first.
    u = httpx.get(f"{_GRAPH}/users/{org}", params={"$select": "id"}, headers=h, timeout=20)
    if not u.is_success:
        raise HTTPException(502, f"Could not resolve the organizer account: {u.text[:150]}")
    oid = u.json().get("id", "")
    if iv.online_meeting_id:
        return oid, iv.online_meeting_id
    if not iv.join_url:
        raise HTTPException(400, "No Teams meeting on this interview")

    def _find(join_url: str):
        rr = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings",
                       params={"$filter": f"JoinWebUrl eq '{join_url}'"}, headers=h, timeout=30)
        if rr.status_code == 403:
            raise HTTPException(502, "Graph denied reading the meeting - this needs "
                                     "'OnlineMeetings.ReadWrite.All' (+ 'OnlineMeetingTranscript.Read.All' and "
                                     "'OnlineMeetingRecording.Read.All') AND a Teams application access policy for "
                                     "the organizer (New-CsApplicationAccessPolicy / Grant-CsApplicationAccessPolicy "
                                     "- takes ~30 min to apply).")
        if not rr.is_success:
            raise HTTPException(502, f"Meeting lookup failed ({rr.status_code}): {rr.text[:200]}")
        return rr.json().get("value", [])

    meetings = _find(iv.join_url)
    if not meetings and iv.event_id:
        # The joinUrl stored at scheduling time can drift from Graph's canonical
        # one (encoding/context) - re-read it from the calendar event and retry.
        ev = httpx.get(f"{_GRAPH}/users/{org}/events/{iv.event_id}",
                       params={"$select": "onlineMeeting"}, headers=h, timeout=30)
        if ev.is_success:
            fresh = ((ev.json().get("onlineMeeting") or {}).get("joinUrl") or "").strip()
            if fresh and fresh != iv.join_url:
                iv.join_url = fresh
                if db is not None:
                    db.commit()
                meetings = _find(fresh)
    if not meetings:
        raise HTTPException(404, "Could not find the Teams meeting under the organizer's account. "
                                 "If you granted the permissions/access policy recently, wait up to 30 minutes "
                                 "and retry.")
    iv.online_meeting_id = meetings[0]["id"]
    return oid, iv.online_meeting_id


def _graph_enable_recording(iv: HrInterview) -> str:
    """Make the Teams meeting record and transcribe itself from the first
    second (recordAutomatically). '' = on, else why it could not be - the
    interview goes ahead either way; the interviewer can still press Record."""
    try:
        h = {"Authorization": f"Bearer {_graph_token()}", "Content-Type": "application/json"}
        oid, mid = _graph_meeting_ids(h, iv)
        body = {"recordAutomatically": True, "allowRecording": True, "allowTranscription": True}
        r = httpx.patch(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}", headers=h, json=body, timeout=30)
        if r.status_code == 400:        # a tenant whose Graph does not know the two allow* options yet
            r = httpx.patch(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}", headers=h,
                            json={"recordAutomatically": True}, timeout=30)
        if r.status_code == 403:
            return ("Graph denied changing the meeting - grant 'OnlineMeetings.ReadWrite.All' and the Teams "
                    "application access policy for the organizer")
        if not r.is_success:
            return f"Teams did not accept auto-recording ({r.status_code}): {r.text[:160]}"
        return ""
    except HTTPException as e:
        return str(e.detail)
    except Exception as e:              # network - not worth failing the schedule over
        return f"Teams did not answer ({type(e).__name__})"


class ScheduleIn(BaseModel):
    template_id: str = ""        # '' = the role's questionnaire (or General); 'none' = no questionnaire
    at: str                      # ISO datetime (UTC or with offset)
    duration_min: int = 45
    subject: Optional[str] = ""
    interviewer_emails: List[str] = []   # who the interview is with - Nexus People; default = the scheduler
    replace_interview_id: str = ""       # reschedule: cancel this scheduled round first


def _graph_cancel_meeting(organizer: str, event_id: str) -> str:
    """Delete the calendar event (Outlook sends the cancellation). '' = ok."""
    if not (organizer and event_id):
        return ""
    try:
        r = httpx.delete(f"{_GRAPH}/users/{organizer}/events/{event_id}",
                         headers={"Authorization": f"Bearer {_graph_token()}"}, timeout=20)
        return "" if r.status_code in (204, 404) else f"Teams invite not withdrawn ({r.status_code})"
    except Exception as e:      # the round is canceled in Nexus either way
        return f"Teams invite not withdrawn ({type(e).__name__})"


def _cancel_round(db: Session, iv: HrInterview, cand: HrCandidate, by: str, note: str) -> str:
    err = _graph_cancel_meeting(iv.organizer_email, iv.event_id)
    iv.status = "canceled"
    iv.updated_at = _now()
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage,
                        to_stage=cand.stage, note=note + (f" - {err}" if err else ""),
                        by_email=by, created_at=_now()))
    return err


def _next_interview_at(db: Session, cand_id: str, skip_id: str = "") -> str:
    rows = (db.query(HrInterview).filter(HrInterview.candidate_id == cand_id,
                                         HrInterview.status.in_(("scheduled", "live")),
                                         HrInterview.id != skip_id)
            .order_by(HrInterview.at).all())
    return rows[0].at if rows else ""


@router.post("/candidates/{cid}/interviews")
def schedule_interview(cid: str, body: ScheduleIn, user: dict = Depends(require_hr_write),
                       db: Session = Depends(get_db)):
    """Schedule an interview: date, time, who it is with, and the role's
    questionnaire. A Teams invite goes to the candidate AND the interviewers
    (Neil, Oct 8), and the candidate moves to Interview - from Applied/Screening,
    or back from Offer for another round."""
    from models import NexusEmployee
    cand = db.query(HrCandidate).filter(HrCandidate.id == cid).with_for_update().first()
    if not cand:
        raise HTTPException(404, "Candidate not found")
    _cand_scoped(cand, user, db)
    if cand.stage in ("hired", "rejected"):
        raise HTTPException(400, f"{cand.first_name} is already {cand.stage} - no interviews to schedule")
    if cand.stage == "offer":
        # Another round pulls them back to Interview - not while their offer
        # is out for signature, which would hire them from Interview.
        import hr_life_events as hle
        if hle.active_hire_event(db, cand.id):
            raise HTTPException(409, "Their hiring packet is out for signature - void it first (on the "
                                     "packet card) before scheduling another round.")
    if not cand.email:
        raise HTTPException(400, "Add the candidate's email first - the invite goes there")
    try:
        when = datetime.fromisoformat(body.at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Pick a valid date and time")
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    at_iso = when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    me = user["email"].lower()
    who = [e.strip().lower() for e in (body.interviewer_emails or []) if e and e.strip()] or [me]
    who = list(dict.fromkeys(who))
    known = {r.work_email for r in db.query(NexusEmployee).filter(NexusEmployee.work_email.in_(who)).all()}
    unknown = [e for e in who if e not in known and e != me]
    if unknown:
        raise HTTPException(400, f"Interviewers must be in Nexus People: {', '.join(unknown)}")

    replaced = None
    if body.replace_interview_id:
        replaced = (db.query(HrInterview).filter(HrInterview.id == body.replace_interview_id,
                                                  HrInterview.candidate_id == cid).first())
        if not replaced or replaced.status != "scheduled":
            raise HTTPException(409, "Only a round that hasn't started can be rescheduled")

    if body.template_id == "none":
        tpl = None
    elif body.template_id:
        tpl = db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id == body.template_id).first()
    else:
        tpl = questionnaire_for(db, cand)
    cand_name = f"{cand.first_name} {cand.last_name}".strip()
    subject = (body.subject or "").strip() or f"Interview - {cand_name} ({cand.role_title or 'Nexus'})"
    names = _names(db, who)
    with_whom = ", ".join(names.get(e, e) for e in who)

    iv = HrInterview(id=str(uuid.uuid4()), candidate_id=cid,
                     template_id=tpl.id if tpl else "", template_name=tpl.name if tpl else "",
                     status="scheduled", at=at_iso, duration_min=max(15, min(240, body.duration_min)),
                     organizer_email=user["email"], interviewer_emails=who,
                     answers=[{"qid": q["id"], "q": q["q"], "answer": "", "score": None, "rationale": ""}
                              for q in (tpl.questions if tpl else [])],
                     created_by=user["email"], created_at=_now(), updated_at=_now())

    graph_error = ""
    try:
        meeting = _graph_create_meeting(
            user["email"], subject,
            f"Hi {cand.first_name},\n\nLooking forward to speaking with you. Join with the Teams "
            f"link in this invite.\n\nInterviewing: {with_whom}",
            cand.email, cand_name, at_iso.replace("Z", "+00:00"), iv.duration_min,
            extra_attendees=[{"email": e, "name": names.get(e, e)} for e in who if e != me])
        iv.event_id = meeting["eventId"]
        iv.join_url = meeting["joinUrl"]
    except HTTPException as e:
        graph_error = str(e.detail)
    record_note = ""
    if iv.join_url:
        # Record + transcribe from the first second, so nobody has to press
        # Record on the call. Best-effort: the invite is already out.
        why = _graph_enable_recording(iv)
        iv.auto_record = "on" if not why else f"failed: {why}"[:400]
        record_note = " - auto-recording on" if not why else " - auto-recording could not be turned on"

    if replaced:
        _cancel_round(db, replaced, cand, user["email"], "Interview rescheduled")
    cand.interview_at = at_iso
    cand.updated_at = _now()
    _advance_to_interview(db, cand, user["email"],
                          f"Interview {'rescheduled' if replaced else 'scheduled'} with {with_whom}"
                          + (" - Teams invite sent" if iv.event_id else "") + record_note, pull_back=True)
    for e in who:
        if e != me:
            _hr_notify(db, e, f"Interview - {cand_name}",
                       f"You're interviewing {cand_name} ({cand.role_title or 'candidate'}) - see the Teams invite.",
                       ref_id=cand.id, requested_by=user["email"], action={"view": "hr", "sub": "hr-hiring"})
    db.add(iv)
    db.commit()
    out = _ser_iv(iv, cand)
    out["inviteSent"] = bool(iv.event_id)
    out["graphError"] = graph_error
    return out


@router.post("/interviews/{iid}/cancel")
def cancel_interview(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).with_for_update().first(), user, db)
    if iv.status != "scheduled":
        raise HTTPException(409, "Only a round that hasn't started can be canceled")
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    err = _cancel_round(db, iv, cand, user["email"], "Interview canceled")
    cand.interview_at = _next_interview_at(db, cand.id, skip_id=iv.id)
    cand.updated_at = _now()
    db.commit()
    out = _ser_iv(iv, cand)
    out["graphError"] = err
    return out


@router.get("/candidates/{cid}/interviews")
def candidate_interviews(cid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    _cand_scoped(db.query(HrCandidate).filter(HrCandidate.id == cid).first(), user, db)
    rows = (db.query(HrInterview).filter(HrInterview.candidate_id == cid)
            .order_by(HrInterview.created_at.desc()).all())
    names = _names(db, list({e for i in rows for e in (i.interviewer_emails or [])}))
    return [_ser_iv(i) | {"interviewerNames": [names.get(e, e) for e in (i.interviewer_emails or [])]}
            for i in rows]


class InterviewPatch(BaseModel):
    status: Optional[str] = None          # live | completed
    answers: Optional[list] = None
    transcript: Optional[str] = None


@router.patch("/interviews/{iid}")
def update_interview(iid: str, body: InterviewPatch, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    if body.status in ("live", "completed") and body.status != iv.status:
        iv.status = body.status
        if body.status == "live" and not iv.started_at:
            iv.started_at = _now()
        if body.status == "completed":
            iv.completed_at = _now()
        cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
        _advance_to_interview(db, cand, user["email"],
                              "Interview started" if body.status == "live" else "Interview completed")
    if body.answers is not None:
        iv.answers = body.answers
    if body.transcript is not None:
        iv.transcript = body.transcript[:200000]
        _save_transcript_file(db, iv)
    iv.updated_at = _now()
    db.commit()
    return _ser_iv(iv)


# ── Teams transcript pull ─────────────────────────────────────────────────────

@router.post("/interviews/{iid}/pull-transcript")
def pull_transcript(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    _fetch_transcript(db, iv)
    db.commit()
    return {"ok": True, "chars": len(iv.transcript)}


def _fetch_transcript(db: Session, iv: HrInterview) -> None:
    """Download the Teams transcript onto the interview (not committed).
    Raises HTTPException: 404 = not there YET (retry later), 400/502 = a
    setup problem a retry will not fix."""
    if not iv.join_url:
        raise HTTPException(400, "No Teams meeting on this interview - paste the transcript instead")
    h = {"Authorization": f"Bearer {_graph_token()}"}
    oid, mid = _graph_meeting_ids(h, iv, db)
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/transcripts", headers=h, timeout=30)
    if not r.is_success or not r.json().get("value"):
        raise HTTPException(404, "No transcript yet - make sure transcription was started in the meeting "
                                 "and the call has ended (Teams takes a few minutes to publish it).")
    tid = r.json()["value"][-1]["id"]
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/transcripts/{tid}/content",
                  params={"$format": "text/vtt"}, headers=h, timeout=60)
    if not r.is_success:
        raise HTTPException(502, f"Could not download the transcript: {r.text[:200]}")
    iv.transcript = r.text[:200000]
    iv.updated_at = _now()
    _save_transcript_file(db, iv)


# ── Recording + transcript as files (hr-docs, private) ───────────────────────
# The transcript text lives on the row for scoring; the files are what HR
# opens and what lands on the employee's profile once they are hired.

RECORDING_BACKOFF_MIN = (2, 5, 10, 15, 30, 30, 60, 60)    # Teams publishes a recording a while after the call
_MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024


def _put_file(path: str, content: bytes, content_type: str) -> None:
    """Into the private hr-docs bucket (local files when storage is not
    configured, like Nexus Sign). Raises on failure. Long timeout: a
    recording is hundreds of MB."""
    from routers import esign
    from routers.hr import _DOC_BUCKET, _SUPABASE_URL, _storage_headers
    if esign._storage_configured():
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                       headers={**_storage_headers(), "Content-Type": content_type, "x-upsert": "true"},
                       content=content, timeout=900)
        if not r.is_success:
            raise HTTPException(502, f"Storage refused the file ({r.status_code}): {r.text[:160]}")
        return
    esign._storage_put(_DOC_BUCKET, path, content, content_type, upsert=True)


def _save_transcript_file(db: Session, iv: HrInterview) -> None:
    """The transcript as a .vtt next to the recording. Never raises - the text
    on the row is what scoring needs; the file is the record."""
    if not (iv.transcript or "").strip():
        return
    try:
        path = f"interviews/{iv.id}/transcript.vtt"
        _put_file(path, iv.transcript.encode("utf-8"), "text/vtt")
        iv.transcript_path = path
        _attach_to_employee(db, iv)
    except Exception as e:      # noqa: BLE001 - best effort by design
        print(f"[interviews] transcript file not saved for {iv.id}: {type(e).__name__}: {e}")


def _fetch_recording(db: Session, iv: HrInterview) -> None:
    """Copy the Teams recording onto the interview (not committed). Raises
    HTTPException: 404 = not published YET (retry later), 400/502 = a setup
    problem a retry will not fix."""
    if not iv.join_url:
        raise HTTPException(400, "No Teams meeting on this interview")
    h = {"Authorization": f"Bearer {_graph_token()}"}
    oid, mid = _graph_meeting_ids(h, iv, db)
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/recordings", headers=h, timeout=30)
    if r.status_code == 403:
        raise HTTPException(502, "Graph denied reading the recording - grant 'OnlineMeetingRecording.Read.All' "
                                 "(application) and consent.")
    if not r.is_success:
        raise HTTPException(502, f"Recording lookup failed ({r.status_code}): {r.text[:200]}")
    rows = r.json().get("value", [])
    if not rows:
        raise HTTPException(404, "No recording yet - Teams publishes it a few minutes after the call ends.")
    rid = rows[-1]["id"]
    with httpx.stream("GET", f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/recordings/{rid}/content",
                      headers=h, timeout=600, follow_redirects=True) as resp:
        if not resp.is_success:
            raise HTTPException(502, f"Could not download the recording ({resp.status_code})")
        chunks, size = [], 0
        for chunk in resp.iter_bytes():
            size += len(chunk)
            if size > _MAX_RECORDING_BYTES:
                raise HTTPException(502, "The recording is larger than 2 GB - keep it in Teams/OneDrive instead.")
            chunks.append(chunk)
    blob = b"".join(chunks)
    if not blob:
        raise HTTPException(404, "The recording is still being processed - trying again later.")
    path = f"interviews/{iv.id}/recording.mp4"
    _put_file(path, blob, "video/mp4")
    iv.recording_path, iv.recording_size = path, len(blob)
    iv.updated_at = _now()
    _attach_to_employee(db, iv)


def _attach_to_employee(db: Session, iv: HrInterview) -> int:
    """Once the candidate is an employee, the recording and transcript are on
    their profile's Documents too (same object, no copy). Called when a file
    lands and when the hire happens, so the order never matters."""
    from models import HrDocument
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    if not cand or not cand.employee_id:
        return 0
    day = (iv.at or iv.created_at or "")[:10]
    try:
        label = datetime.strptime(day, "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        label = day
    added = 0
    for path, name, size in ((iv.recording_path, f"Interview {label} - Recording.mp4", iv.recording_size or 0),
                             (iv.transcript_path, f"Interview {label} - Transcript.vtt",
                              len((iv.transcript or "").encode("utf-8")))):
        if not path:
            continue
        if db.query(HrDocument).filter(HrDocument.employee_id == cand.employee_id,
                                       HrDocument.storage_path == path).first():
            continue
        db.add(HrDocument(id=str(uuid.uuid4()), employee_id=cand.employee_id, kind="other", file_name=name,
                          storage_path=path, size_bytes=size, uploaded_by="interviews", created_at=_now()))
        added += 1
    return added


def attach_interview_files(db: Session, cand: HrCandidate) -> int:
    """Hook for the hire (routers/hr.create_employee_from_candidate): every
    round's recording and transcript onto the new employee's Documents."""
    n = 0
    for iv in db.query(HrInterview).filter(HrInterview.candidate_id == cand.id).all():
        n += _attach_to_employee(db, iv)
    return n


@router.get("/interviews/{iid}/file")
def interview_file(iid: str, kind: str = "recording", user: dict = Depends(require_hr_read),
                   db: Session = Depends(get_db)):
    """A short-lived link to the recording or the transcript file - the
    bucket is private."""
    from routers import esign
    from routers.hr import _DOC_BUCKET
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    path = iv.recording_path if kind == "recording" else iv.transcript_path
    if not path:
        raise HTTPException(404, "Not on this interview yet")
    got = esign._storage_signed_url(_DOC_BUCKET, path, expires_in=600)
    if not got.is_success:
        raise HTTPException(502, f"Could not sign the link: {got.text[:160]}")
    return {"url": got.json()["url"], "expiresIn": 600, "size": iv.recording_size if kind == "recording" else 0}


@router.post("/interviews/{iid}/pull-recording")
def pull_recording(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    _fetch_recording(db, iv)
    iv.recording_status, iv.recording_next_at, iv.recording_note = "done", "", "Recording saved"
    db.commit()
    return _ser_iv(iv)


@router.get("/employees/{eid}/interviews")
def employee_interviews(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The rounds the person went through before they were hired - the
    profile's Interviews tab."""
    from models import NexusEmployee
    from routers.hr import _assert_scope
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    _assert_scope(emp, hr_scope(user, db))
    cands = [c.id for c in db.query(HrCandidate).filter(HrCandidate.employee_id == eid).all()]
    if not cands:
        return []
    rows = (db.query(HrInterview).filter(HrInterview.candidate_id.in_(cands), HrInterview.status != "canceled")
            .order_by(HrInterview.at.desc()).all())
    names = _names(db, list({e for i in rows for e in (i.interviewer_emails or [])}))
    return [_ser_iv(i) | {"interviewerNames": [names.get(e, e) for e in (i.interviewer_emails or [])]}
            for i in rows]


# ── AI: auto-fill answers from the transcript, then calibrate scores ─────────

@router.post("/interviews/{iid}/autofill")
def autofill(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    if not iv.transcript:
        raise HTTPException(400, "No transcript yet - pull it from Teams or paste it first")
    if not iv.answers:
        raise HTTPException(400, "This interview has no questionnaire attached")
    _autofill(iv, only_blank=False)
    db.commit()
    return _ser_iv(iv)


def _autofill(iv: HrInterview, only_blank: bool) -> None:
    """Claude extracts each answer from the transcript. only_blank (End
    Interview's merge) keeps whatever the interviewer typed during the call
    and fills only what they left empty."""
    qs = [{"qid": a["qid"], "q": a["q"]} for a in iv.answers
          if not (only_blank and (a.get("answer") or "").strip())]
    if not qs:
        return
    text = _claude(
        "You are transcribing interview answers. Below is an interview transcript and the "
        "interviewer's questionnaire. For each question, extract the CANDIDATE's answer in their "
        "own words (condense to the substance, max ~120 words each). If a question was never "
        "asked or answered, use an empty string.\n\n"
        f"QUESTIONS (JSON): {json.dumps(qs)}\n\nTRANSCRIPT:\n{iv.transcript[:60000]}\n\n"
        "Reply with ONLY a JSON array: [{\"qid\": ..., \"answer\": ...}]", 4000)
    filled = {a["qid"]: a.get("answer", "") for a in _json_block(text) if isinstance(a, dict)}
    iv.answers = [{**a, "answer": (a.get("answer") if only_blank and (a.get("answer") or "").strip()
                                   else filled.get(a["qid"], a.get("answer", "")))} for a in iv.answers]
    iv.updated_at = _now()


@router.post("/interviews/{iid}/calibrate")
def calibrate(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    cand = _calibrate(db, iv, user["email"])
    db.commit()
    return _ser_iv(iv, cand)


def _calibrate(db: Session, iv: HrInterview, by: str) -> HrCandidate:
    answered = [a for a in (iv.answers or []) if (a.get("answer") or "").strip()]
    if not answered:
        raise HTTPException(400, "No answers to score - auto-fill from the transcript or type them in")
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    text = _claude(
        f"You are a hiring panel calibrator for the role \"{iv.template_name or (cand.role_title if cand else '')}\". "
        "Score each interview answer 0-10 (10 = outstanding, specific, credible; 0 = no/irrelevant answer) "
        "with a one-sentence rationale. Be a tough, fair grader - a typical decent answer is 5-6. Then give "
        "an overall 0-100 score (not just the average - weigh substance) and a 2-3 sentence verdict.\n\n"
        f"ANSWERS (JSON): {json.dumps([{'qid': a['qid'], 'q': a['q'], 'answer': a['answer']} for a in answered])}\n\n"
        "Reply with ONLY JSON: {\"scores\": [{\"qid\", \"score\", \"rationale\"}], \"total\": 0-100, \"summary\": \"...\"}", 3500)
    data = _json_block(text)
    by_qid = {s["qid"]: s for s in data.get("scores", []) if isinstance(s, dict)}
    iv.answers = [{**a, "score": by_qid.get(a["qid"], {}).get("score"),
                   "rationale": by_qid.get(a["qid"], {}).get("rationale", "")} for a in iv.answers]
    iv.total_score = float(max(0, min(100, data.get("total", 0))))
    iv.summary = str(data.get("summary", ""))[:2000]
    iv.status = "scored"
    iv.updated_at = _now()
    _advance_to_interview(db, cand, by, f"Interview scored - {round(iv.total_score)}/100")
    return cand


# ── End Interview: take everything in and merge it (Neil, Oct 8) ─────────────
# "when we clicked end, it should just take all of this stuff in and merge it
# all" - and the transcript "might take a few minutes to publish". So End
# saves what the interviewer typed and hands the rest to Nexus: the follow-up
# keeps pulling the Teams transcript until it is published, fills the answers
# nobody typed, scores the interview and tells the interviewers. HR does not
# babysit buttons. Runs off the event loop (interview_followup_loop).

# Minutes before each transcript attempt (~2 hours in all). Teams usually
# publishes within minutes of the call ending.
FOLLOWUP_BACKOFF_MIN = (1, 2, 3, 5, 10, 15, 20, 30, 30)


class FinishIn(BaseModel):
    answers: Optional[list] = None


def _when(minutes: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


@router.post("/interviews/{iid}/finish")
def finish_interview(iid: str, body: FinishIn, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).with_for_update().first(), user, db)
    if iv.status not in ("scheduled", "live", "completed"):
        raise HTTPException(409, f"This interview is already {iv.status}")
    if body.answers is not None:
        iv.answers = body.answers
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    if iv.status != "completed":
        iv.status = "completed"
        iv.started_at = iv.started_at or _now()
        iv.completed_at = _now()
        _advance_to_interview(db, cand, user["email"], "Interview completed")
    iv.followup_status = "waiting"
    iv.followup_attempts = 0
    iv.followup_next_at = _now()
    iv.followup_note = ("Waiting for Teams to publish the transcript" if iv.join_url and not iv.transcript
                        else "Scoring the answers")
    if iv.join_url and not iv.recording_path:
        # The recording comes a while after the transcript - its own wait,
        # so scoring never holds for it and it never holds for scoring.
        iv.recording_status, iv.recording_attempts, iv.recording_next_at = "waiting", 0, _now()
        iv.recording_note = "Waiting for Teams to publish the recording"
    iv.updated_at = _now()
    db.commit()
    return _ser_iv(iv, cand)


@router.post("/interviews/{iid}/followup")
def followup_now(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Retry Now - one follow-up step immediately instead of at the next tick."""
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).with_for_update().first(), user, db)
    if iv.followup_status not in ("waiting", "failed"):
        raise HTTPException(409, "Nothing is waiting on this interview")
    iv.followup_status = "waiting"
    followup_step(db, iv)
    db.commit()
    return _ser_iv(iv)


def _tell(db: Session, iv: HrInterview, title: str, body: str) -> None:
    for to in {(iv.organizer_email or "").lower(), *[(e or "").lower() for e in (iv.interviewer_emails or [])]} - {""}:
        _hr_notify(db, to, title, body, ref_id=iv.candidate_id, requested_by="nexus",
                   action={"view": "hr", "sub": "hr-hiring"})


def followup_step(db: Session, iv: HrInterview) -> None:
    """One step of the merge. Never raises; leaves the interview either done,
    failed (with why) or waiting with the next try scheduled. Not committed."""
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    name = f"{cand.first_name} {cand.last_name}".strip() if cand else "the candidate"
    attempts = (iv.followup_attempts or 0) + 1
    iv.followup_attempts = attempts
    out_of_time = attempts > len(FOLLOWUP_BACKOFF_MIN)
    setup_problem = ""
    if iv.join_url and not iv.transcript:
        try:
            _fetch_transcript(db, iv)
        except HTTPException as e:
            if e.status_code == 404 and not out_of_time:
                iv.followup_note = "Waiting for Teams to publish the transcript"
                iv.followup_next_at = _when(FOLLOWUP_BACKOFF_MIN[attempts - 1])
                return
            setup_problem = str(e.detail)
        except Exception as e:     # network - try again later
            if not out_of_time:
                iv.followup_note = f"Teams did not answer ({type(e).__name__}) - trying again"
                iv.followup_next_at = _when(FOLLOWUP_BACKOFF_MIN[attempts - 1])
                return
            setup_problem = f"Teams did not answer ({type(e).__name__})"
    try:
        if iv.transcript and iv.answers:
            _autofill(iv, only_blank=True)
        if any((a.get("answer") or "").strip() for a in (iv.answers or [])):
            _calibrate(db, iv, "nexus")
            iv.followup_status, iv.followup_next_at = "done", ""
            iv.followup_note = ("Scored from the transcript and your notes" if iv.transcript
                                else f"Scored from the typed answers - no transcript ({setup_problem or 'none'})")
            _tell(db, iv, f"Interview scored - {name}",
                  f"{name}: {round(iv.total_score)}/100. {iv.summary[:300]}")
            return
        if iv.transcript and not iv.answers:
            iv.followup_status, iv.followup_next_at = "done", ""
            iv.followup_note = "Transcript saved - this round had no questionnaire to score"
            _tell(db, iv, f"Interview transcript saved - {name}", "The Teams transcript is on the interview.")
            return
    except HTTPException as e:
        setup_problem = setup_problem or str(e.detail)
    except Exception as e:         # the AI call failed - retry
        if not out_of_time:
            iv.followup_note = f"Scoring did not finish ({type(e).__name__}) - trying again"
            iv.followup_next_at = _when(FOLLOWUP_BACKOFF_MIN[attempts - 1])
            return
        setup_problem = f"Scoring did not finish ({type(e).__name__})"
    iv.followup_status, iv.followup_next_at = "failed", ""
    nothing = not iv.transcript and not any((a.get("answer") or "").strip() for a in (iv.answers or []))
    iv.followup_note = (setup_problem or "No transcript and no typed answers to score") + \
        (" - paste the transcript or type the answers, then Retry." if nothing else " - fix that, then Retry.")
    _tell(db, iv, f"Interview not scored - {name}", iv.followup_note)


def recording_step(db: Session, iv: HrInterview) -> None:
    """One try at the recording. Never raises; leaves it done, failed (with
    why) or waiting with the next try scheduled. Not committed."""
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    name = f"{cand.first_name} {cand.last_name}".strip() if cand else "the candidate"
    attempts = (iv.recording_attempts or 0) + 1
    iv.recording_attempts = attempts
    out_of_time = attempts > len(RECORDING_BACKOFF_MIN)
    try:
        _fetch_recording(db, iv)
    except HTTPException as e:
        if e.status_code == 404 and not out_of_time:
            iv.recording_note = "Waiting for Teams to publish the recording"
            iv.recording_next_at = _when(RECORDING_BACKOFF_MIN[attempts - 1])
            return
        why = str(e.detail)
    except Exception as e:
        if not out_of_time:
            iv.recording_note = f"Teams did not answer ({type(e).__name__}) - trying again"
            iv.recording_next_at = _when(RECORDING_BACKOFF_MIN[attempts - 1])
            return
        why = f"Teams did not answer ({type(e).__name__})"
    else:
        iv.recording_status, iv.recording_next_at = "done", ""
        iv.recording_note = "Recording saved"
        _tell(db, iv, f"Interview recording saved - {name}",
              "The Teams recording and transcript are on the interview" + (" and on their profile." if cand and cand.employee_id else "."))
        return
    iv.recording_status, iv.recording_next_at = "failed", ""
    iv.recording_note = why + " - fix that, then Pull Recording."
    _tell(db, iv, f"Interview recording not saved - {name}", iv.recording_note)


def process_followups(limit: int = 10) -> int:
    from database import SessionLocal
    db = SessionLocal()
    n = 0
    try:
        now = _now()
        ids = [r.id for r in db.query(HrInterview).filter(HrInterview.followup_status == "waiting",
                                                           HrInterview.followup_next_at != "",
                                                           HrInterview.followup_next_at <= now)
               .order_by(HrInterview.followup_next_at).limit(limit).all()]
        for iid in ids:
            iv = (db.query(HrInterview).filter(HrInterview.id == iid, HrInterview.followup_status == "waiting")
                  .with_for_update().first())
            if iv:
                followup_step(db, iv)
                db.commit()
                n += 1
        ids = [r.id for r in db.query(HrInterview).filter(HrInterview.recording_status == "waiting",
                                                           HrInterview.recording_next_at != "",
                                                           HrInterview.recording_next_at <= now)
               .order_by(HrInterview.recording_next_at).limit(limit).all()]
        for iid in ids:
            iv = (db.query(HrInterview).filter(HrInterview.id == iid, HrInterview.recording_status == "waiting")
                  .with_for_update().first())
            if iv:
                recording_step(db, iv)
                db.commit()
                n += 1
    finally:
        db.close()
    return n


async def interview_followup_loop():
    """Off the event loop: Graph + Claude calls block (CLAUDE.md)."""
    import asyncio
    await asyncio.sleep(80)
    while True:
        try:
            await asyncio.to_thread(process_followups)
        except Exception as e:
            print(f"[interviews] follow-up pass failed: {e}")
        await asyncio.sleep(45)


# ── Leaderboard + final round ─────────────────────────────────────────────────

@router.get("/interviews/leaderboard")
def leaderboard(template_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    q = db.query(HrInterview).filter(HrInterview.status == "scored")
    if template_id:
        q = q.filter(HrInterview.template_id == template_id)
    rows = q.order_by(HrInterview.total_score.desc()).limit(50).all()
    scope = hr_scope(user, db)
    out = []
    for i in rows:
        cand = db.query(HrCandidate).filter(HrCandidate.id == i.candidate_id).first()
        # Rejected candidates are out of the running - no place on the board.
        if not cand or cand.stage == "rejected":
            continue
        # Company-scoped admins only see their companies' candidates.
        if scope is not None and (cand.company or "") not in scope:
            continue
        d = _ser_iv(i, cand)
        d["candidateStage"] = cand.stage
        out.append(d)
    return out


class RecommendIn(BaseModel):
    template_id: str = ""


@router.post("/interviews/recommend")
def recommend_hire(body: RecommendIn, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """AI head-to-head: compare the calibrated candidates for a role on the
    SUBSTANCE of their answers (not just totals) and recommend whom to hire."""
    q = db.query(HrInterview).filter(HrInterview.status == "scored")
    if body.template_id:
        q = q.filter(HrInterview.template_id == body.template_id)
    ivs = q.order_by(HrInterview.total_score.desc()).limit(12).all()
    scope = hr_scope(user, db)
    packs = []
    for iv in ivs:
        cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
        if not cand or cand.stage in ("rejected", "hired"):
            continue   # only live contenders get compared
        if scope is not None and (cand.company or "") not in scope:
            continue   # scoped admins compare only their companies' candidates
        packs.append({
            "name": f"{cand.first_name} {cand.last_name}".strip() if cand else iv.candidate_id,
            "total": round(iv.total_score or 0),
            "verdict": iv.summary or "",
            "answers": [{"q": a["q"], "answer": (a.get("answer") or "")[:400], "score": a.get("score")}
                        for a in (iv.answers or []) if (a.get("answer") or "").strip()],
        })
    if len(packs) < 2:
        raise HTTPException(400, "Need at least two calibrated candidates still in the running to compare")
    packs = packs[:8]
    role = ivs[0].template_name or "the role"
    text = _claude(
        f"You are the final hiring panel for \"{role}\". Below are the calibrated interviews. "
        "Compare candidates on SUBSTANCE - depth of understanding, credibility, specificity, risk - "
        "not just the numeric totals (a 9 with shallow answers can lose to an 8 with real depth). "
        "Recommend exactly one hire (or 'none' if nobody clears the bar), name a runner-up if close, "
        "and be direct about each person's strengths and concerns.\n\n"
        f"CANDIDATES (JSON): {json.dumps(packs)}\n\n"
        "Reply with ONLY JSON: {\"pick\": \"name or none\", \"reasoning\": \"3-5 sentences on why, "
        "referencing specific answers\", \"runnerUp\": \"name or ''\", "
        "\"comparison\": [{\"name\", \"strengths\", \"concerns\"}]}", 3000)
    return _json_block(text)


class FinalRoundIn(BaseModel):
    at: str
    duration_min: int = 30


@router.post("/interviews/{iid}/final-round")
def invite_final_round(iid: str, body: FinalRoundIn, user: dict = Depends(require_hr_write),
                       db: Session = Depends(get_db)):
    iv = _iv_scoped(db.query(HrInterview).filter(HrInterview.id == iid).first(), user, db)
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    if not (cand and cand.email):
        raise HTTPException(404, "Interview/candidate not found (or candidate has no email)")
    cand_name = f"{cand.first_name} {cand.last_name}".strip()
    meeting = _graph_create_meeting(
        user["email"], f"Final round - offer discussion with {cand_name}",
        f"Hi {cand.first_name},\n\nGreat news - we'd like to move you to the final round. "
        "Join with the Teams link in this invite.\n", cand.email, cand_name,
        body.at.replace("Z", "+00:00"), max(15, min(240, body.duration_min)))
    if cand.stage in ("applied", "screening", "interview"):
        cand.stage = "offer"
    cand.updated_at = _now()
    _hr_notify(db, iv.created_by, f"Final round booked - {cand_name}",
               f"{cand_name} (scored {round(iv.total_score)}) is invited to the offer discussion.",
               ref_id=cand.id, action={"view": "hr", "sub": "hr-hiring"})
    db.commit()
    return {"ok": True, "joinUrl": meeting["joinUrl"]}
