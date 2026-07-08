"""AI-assisted interviews (HR roadmap Section C/F crossover).

Flow: HR schedules an interview from the candidate → a real Teams meeting
invite goes to the candidate's email (Graph calendar event, organizer = the
scheduler). During the call the interviewer opens the questionnaire ("Interview
started"); afterwards the Teams transcript is pulled (or pasted) and Claude
auto-fills the candidate's answers, then "Calibrate" scores every answer against
the question and builds a per-role leaderboard. Winner gets a one-click
"final round / offer discussion" invite.

Graph requirements (same app registration as provisioning):
  - Calendars.ReadWrite  (application) → create the meeting invites
  - OnlineMeetingTranscript.Read.All + a Teams application access policy
    (New-CsApplicationAccessPolicy … -Identity <organizer>) → pull transcripts
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


def _advance_to_interview(db: Session, cand: HrCandidate, by: str, note: str):
    """Pipeline follows the interview lifecycle: scheduling/starting/scoring a
    round pulls the candidate into the Interview stage automatically (with a
    stage-history entry), instead of them sitting in Screening forever."""
    if not cand or cand.stage not in ("applied", "screening"):
        return
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id,
                        from_stage=cand.stage, to_stage="interview",
                        note=note, by_email=by, created_at=_now()))
    cand.stage = "interview"
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
            "createdBy": t.created_by, "updatedAt": t.updated_at}


def _ser_iv(i: HrInterview, cand: HrCandidate = None) -> dict:
    return {"id": i.id, "candidateId": i.candidate_id,
            "candidateName": f"{cand.first_name} {cand.last_name}".strip() if cand else "",
            "templateId": i.template_id, "templateName": i.template_name,
            "status": i.status, "at": i.at, "durationMin": i.duration_min,
            "joinUrl": i.join_url, "hasTranscript": bool(i.transcript),
            "answers": i.answers or [], "totalScore": i.total_score or 0,
            "summary": i.summary or "", "createdAt": i.created_at}


# ── Questionnaire templates ───────────────────────────────────────────────────

class TemplateIn(BaseModel):
    name: str
    questions: List[str] = []


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
    db.commit()
    return _ser_tpl(t)


@router.put("/interview-templates/{tid}")
def update_template(tid: str, body: TemplateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    t = db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id == tid).first()
    if not t:
        raise HTTPException(404, "Template not found")
    t.name = body.name.strip()[:120] or t.name
    t.questions = [{"id": str(uuid.uuid4())[:8], "q": q.strip()[:500]} for q in body.questions if q.strip()]
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
                          start_iso: str, minutes: int) -> dict:
    """Create a calendar event with a Teams link — Outlook emails the invite to
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
                                      "type": "required"}],
                       "isOnlineMeeting": True,
                       "onlineMeetingProvider": "teamsForBusiness",
                   }, timeout=30)
    if r.status_code == 403:
        raise HTTPException(502, "Microsoft Graph denied creating the meeting — grant the app "
                                 "'Calendars.ReadWrite' (application) in Entra and consent, then retry.")
    if not r.is_success:
        raise HTTPException(502, f"Could not create the Teams meeting: {r.text[:200]}")
    ev = r.json()
    return {"eventId": ev.get("id", ""),
            "joinUrl": ((ev.get("onlineMeeting") or {}).get("joinUrl", ""))}


class ScheduleIn(BaseModel):
    template_id: str = ""
    at: str                      # ISO datetime (UTC or with offset)
    duration_min: int = 45
    subject: Optional[str] = ""


@router.post("/candidates/{cid}/interviews")
def schedule_interview(cid: str, body: ScheduleIn, user: dict = Depends(require_hr_write),
                       db: Session = Depends(get_db)):
    cand = db.query(HrCandidate).filter(HrCandidate.id == cid).first()
    if not cand:
        raise HTTPException(404, "Candidate not found")
    if cand.stage in ("hired", "rejected"):
        raise HTTPException(400, f"{cand.first_name} is already {cand.stage} — no interviews to schedule")
    if not cand.email:
        raise HTTPException(400, "Candidate has no email — add one first")
    tpl = db.query(HrInterviewTemplate).filter(HrInterviewTemplate.id == body.template_id).first()
    cand_name = f"{cand.first_name} {cand.last_name}".strip()
    subject = (body.subject or "").strip() or f"Interview — {cand_name} ({cand.role_title or 'Greens Global'})"

    iv = HrInterview(id=str(uuid.uuid4()), candidate_id=cid,
                     template_id=tpl.id if tpl else "", template_name=tpl.name if tpl else "",
                     status="scheduled", at=body.at, duration_min=max(15, min(240, body.duration_min)),
                     organizer_email=user["email"],
                     answers=[{"qid": q["id"], "q": q["q"], "answer": "", "score": None, "rationale": ""}
                              for q in (tpl.questions if tpl else [])],
                     created_by=user["email"], created_at=_now(), updated_at=_now())

    graph_error = ""
    try:
        meeting = _graph_create_meeting(
            user["email"], subject,
            f"Hi {cand.first_name},\n\nLooking forward to speaking with you. Join with the Teams "
            f"link in this invite.\n\n— {user['email']}",
            cand.email, cand_name, body.at.replace("Z", "+00:00"), iv.duration_min)
        iv.event_id = meeting["eventId"]
        iv.join_url = meeting["joinUrl"]
    except HTTPException as e:
        graph_error = str(e.detail)

    cand.interview_at = body.at
    cand.updated_at = _now()
    _advance_to_interview(db, cand, user["email"], "Interview scheduled (auto-moved)")
    db.add(iv)
    db.commit()
    out = _ser_iv(iv, cand)
    out["inviteSent"] = bool(iv.event_id)
    out["graphError"] = graph_error
    return out


@router.get("/candidates/{cid}/interviews")
def candidate_interviews(cid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = (db.query(HrInterview).filter(HrInterview.candidate_id == cid)
            .order_by(HrInterview.created_at.desc()).all())
    return [_ser_iv(i) for i in rows]


class InterviewPatch(BaseModel):
    status: Optional[str] = None          # live | completed
    answers: Optional[list] = None
    transcript: Optional[str] = None


@router.patch("/interviews/{iid}")
def update_interview(iid: str, body: InterviewPatch, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    iv = db.query(HrInterview).filter(HrInterview.id == iid).first()
    if not iv:
        raise HTTPException(404, "Interview not found")
    if body.status in ("live", "completed"):
        iv.status = body.status
        if body.status == "live" and not iv.started_at:
            iv.started_at = _now()
        if body.status == "completed":
            iv.completed_at = _now()
        cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
        _advance_to_interview(db, cand, user["email"],
                              "Interview started (auto-moved)" if body.status == "live" else "Interview completed (auto-moved)")
    if body.answers is not None:
        iv.answers = body.answers
    if body.transcript is not None:
        iv.transcript = body.transcript[:200000]
    iv.updated_at = _now()
    db.commit()
    return _ser_iv(iv)


# ── Teams transcript pull ─────────────────────────────────────────────────────

@router.post("/interviews/{iid}/pull-transcript")
def pull_transcript(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = db.query(HrInterview).filter(HrInterview.id == iid).first()
    if not iv:
        raise HTTPException(404, "Interview not found")
    if not iv.join_url:
        raise HTTPException(400, "No Teams meeting on this interview — paste the transcript instead")
    token = _graph_token()
    h = {"Authorization": f"Bearer {token}"}
    org = iv.organizer_email
    # /onlineMeetings rejects UPNs ("userId is not a GUID") — resolve the
    # organizer's directory object id first.
    u = httpx.get(f"{_GRAPH}/users/{org}", params={"$select": "id"}, headers=h, timeout=20)
    if not u.is_success:
        raise HTTPException(502, f"Could not resolve the organizer account: {u.text[:150]}")
    oid = u.json().get("id", "")

    def _find(join_url: str):
        rr = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings",
                       params={"$filter": f"JoinWebUrl eq '{join_url}'"}, headers=h, timeout=30)
        if rr.status_code == 403:
            raise HTTPException(502, "Graph denied reading the meeting — this needs "
                                     "'OnlineMeetings.Read.All' + 'OnlineMeetingTranscript.Read.All' AND a Teams "
                                     "application access policy for the organizer (New-CsApplicationAccessPolicy / "
                                     "Grant-CsApplicationAccessPolicy — takes ~30 min to apply). Until then, turn on "
                                     "transcription in Teams and use Paste transcript.")
        if not rr.is_success:
            raise HTTPException(502, f"Meeting lookup failed ({rr.status_code}): {rr.text[:200]}")
        return rr.json().get("value", [])

    meetings = _find(iv.join_url)
    if not meetings and iv.event_id:
        # The joinUrl stored at scheduling time can drift from Graph's canonical
        # one (encoding/context) — re-read it from the calendar event and retry.
        ev = httpx.get(f"{_GRAPH}/users/{org}/events/{iv.event_id}",
                       params={"$select": "onlineMeeting"}, headers=h, timeout=30)
        if ev.is_success:
            fresh = ((ev.json().get("onlineMeeting") or {}).get("joinUrl") or "").strip()
            if fresh and fresh != iv.join_url:
                iv.join_url = fresh
                db.commit()
                meetings = _find(fresh)
    if not meetings:
        raise HTTPException(404, "Could not find the Teams meeting under the organizer's account. "
                                 "If you granted the permissions/access policy recently, wait up to 30 minutes "
                                 "and retry — or use Paste transcript.")
    mid = meetings[0]["id"]
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/transcripts", headers=h, timeout=30)
    if not r.is_success or not r.json().get("value"):
        raise HTTPException(404, "No transcript yet — make sure transcription was started in the meeting "
                                 "and the call has ended (Teams takes a few minutes to publish it).")
    tid = r.json()["value"][-1]["id"]
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/transcripts/{tid}/content",
                  params={"$format": "text/vtt"}, headers=h, timeout=60)
    if not r.is_success:
        raise HTTPException(502, f"Could not download the transcript: {r.text[:200]}")
    iv.transcript = r.text[:200000]
    iv.updated_at = _now()
    db.commit()
    return {"ok": True, "chars": len(iv.transcript)}


# ── AI: auto-fill answers from the transcript, then calibrate scores ─────────

@router.post("/interviews/{iid}/autofill")
def autofill(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = db.query(HrInterview).filter(HrInterview.id == iid).first()
    if not iv:
        raise HTTPException(404, "Interview not found")
    if not iv.transcript:
        raise HTTPException(400, "No transcript yet — pull it from Teams or paste it first")
    if not iv.answers:
        raise HTTPException(400, "This interview has no questionnaire attached")
    qs = [{"qid": a["qid"], "q": a["q"]} for a in iv.answers]
    text = _claude(
        "You are transcribing interview answers. Below is an interview transcript and the "
        "interviewer's questionnaire. For each question, extract the CANDIDATE's answer in their "
        "own words (condense to the substance, max ~120 words each). If a question was never "
        "asked or answered, use an empty string.\n\n"
        f"QUESTIONS (JSON): {json.dumps(qs)}\n\nTRANSCRIPT:\n{iv.transcript[:60000]}\n\n"
        "Reply with ONLY a JSON array: [{\"qid\": ..., \"answer\": ...}]", 4000)
    filled = {a["qid"]: a.get("answer", "") for a in _json_block(text) if isinstance(a, dict)}
    iv.answers = [{**a, "answer": filled.get(a["qid"], a.get("answer", ""))} for a in iv.answers]
    iv.updated_at = _now()
    db.commit()
    return _ser_iv(iv)


@router.post("/interviews/{iid}/calibrate")
def calibrate(iid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    iv = db.query(HrInterview).filter(HrInterview.id == iid).first()
    if not iv:
        raise HTTPException(404, "Interview not found")
    answered = [a for a in (iv.answers or []) if (a.get("answer") or "").strip()]
    if not answered:
        raise HTTPException(400, "No answers to score — auto-fill from the transcript or type them in")
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
    text = _claude(
        f"You are a hiring panel calibrator for the role \"{iv.template_name or (cand.role_title if cand else '')}\". "
        "Score each interview answer 0-10 (10 = outstanding, specific, credible; 0 = no/irrelevant answer) "
        "with a one-sentence rationale. Be a tough, fair grader — a typical decent answer is 5-6. Then give "
        "an overall 0-100 score (not just the average — weigh substance) and a 2-3 sentence verdict.\n\n"
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
    _advance_to_interview(db, cand, user["email"], "Interview calibrated (auto-moved)")
    db.commit()
    return _ser_iv(iv, cand)


# ── Leaderboard + final round ─────────────────────────────────────────────────

@router.get("/interviews/leaderboard")
def leaderboard(template_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    q = db.query(HrInterview).filter(HrInterview.status == "scored")
    if template_id:
        q = q.filter(HrInterview.template_id == template_id)
    rows = q.order_by(HrInterview.total_score.desc()).limit(50).all()
    out = []
    for i in rows:
        cand = db.query(HrCandidate).filter(HrCandidate.id == i.candidate_id).first()
        # Rejected candidates are out of the running — no place on the board.
        if not cand or cand.stage == "rejected":
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
    packs = []
    for iv in ivs:
        cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first()
        if not cand or cand.stage in ("rejected", "hired"):
            continue   # only live contenders get compared
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
        "Compare candidates on SUBSTANCE — depth of understanding, credibility, specificity, risk — "
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
    iv = db.query(HrInterview).filter(HrInterview.id == iid).first()
    cand = db.query(HrCandidate).filter(HrCandidate.id == iv.candidate_id).first() if iv else None
    if not (iv and cand and cand.email):
        raise HTTPException(404, "Interview/candidate not found (or candidate has no email)")
    cand_name = f"{cand.first_name} {cand.last_name}".strip()
    meeting = _graph_create_meeting(
        user["email"], f"Final round — offer discussion with {cand_name}",
        f"Hi {cand.first_name},\n\nGreat news — we'd like to move you to the final round. "
        "Join with the Teams link in this invite.\n", cand.email, cand_name,
        body.at.replace("Z", "+00:00"), max(15, min(240, body.duration_min)))
    if cand.stage in ("applied", "screening", "interview"):
        cand.stage = "offer"
    cand.updated_at = _now()
    _hr_notify(db, iv.created_by, f"Final round booked — {cand_name}",
               f"{cand_name} (scored {round(iv.total_score)}) is invited to the offer discussion.",
               ref_id=cand.id, action={"view": "hr", "sub": "hr-hiring"})
    db.commit()
    return {"ok": True, "joinUrl": meeting["joinUrl"]}
