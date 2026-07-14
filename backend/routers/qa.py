"""Testing module (QA) — interactive test runs, bug reports, AI conversion,
assignments. DEV-ONLY: every endpoint 404s unless NEXUS_QA_MODULE=true is set
in the environment (set on the Azure dev app only — dev merges to main, so the
gate must be config, not code).

Seeded from qa_seed.json (the Jul-2026 module-audit workbook) on first read.
AI bug→test-case conversion uses claude-haiku-4-5 — one small call per report
(~$0.001–0.005), mirrors items._ai_match_types. Assignment notifications reuse
the Graph sendMail app permission (notifications.py) + a targeted bell row; the
Teams DM is posted client-side by the assigner via their delegated token.
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_module_grant
from models import (QaTestCase, QaRun, QaResult, QaBugReport, QaAssignment,
                    NexusNotification, NexusRole)

router = APIRouter(prefix="/qa", tags=["Testing"])

_ENABLED = os.getenv("NEXUS_QA_MODULE", "").lower() in ("1", "true", "yes")
_SEED_PATH = Path(__file__).resolve().parent.parent / "qa_seed.json"
_AI_MODEL = "claude-haiku-4-5-20251001"   # cheap: one small call per conversion

# Testers need a 'testing' module grant (or admin) — same grant-driven pattern
# as every other restricted screen. Editors approve AI drafts / manage cases.
require_qa_read  = require_module_grant("testing", "viewer")
require_qa_write = require_module_grant("testing", "editor")


def _gate():
    if not _ENABLED:
        raise HTTPException(404, "Not found")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── enabled probe (any authed user — the sidebar asks this once) ──────────────

@router.get("/enabled")
def qa_enabled(user: dict = Depends(get_current_user)):
    return {"enabled": _ENABLED}


# ── test-case library ─────────────────────────────────────────────────────────

def _seed_if_empty(db: Session) -> None:
    if db.query(QaTestCase).first() or not _SEED_PATH.exists():
        return
    try:
        cases = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    except Exception:
        return
    now = _now()
    for c in cases:
        db.add(QaTestCase(
            id=str(uuid.uuid4()), module=c["module"], feature=c.get("feature", ""),
            title=c["title"], precondition=c.get("precondition", ""),
            steps=c.get("steps", []), expected=c.get("expected", ""),
            priority=c.get("priority", "Medium"), case_type=c.get("type", "Functional"),
            source="seed", status="active", created_by="system", created_at=now, updated_at=now))
    db.commit()


def _case_dict(c: QaTestCase) -> dict:
    return {"id": c.id, "module": c.module, "feature": c.feature, "title": c.title,
            "precondition": c.precondition, "steps": c.steps or [], "expected": c.expected,
            "priority": c.priority, "type": c.case_type, "source": c.source,
            "status": c.status, "createdBy": c.created_by, "createdAt": c.created_at}


@router.get("/cases")
def list_cases(user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    _seed_if_empty(db)
    rows = (db.query(QaTestCase).filter(QaTestCase.status != "archived")
            .order_by(QaTestCase.module, QaTestCase.feature, QaTestCase.title).all())
    return [_case_dict(c) for c in rows]


class CaseIn(BaseModel):
    module: str
    feature: Optional[str] = ""
    title: str
    precondition: Optional[str] = ""
    steps: list
    expected: Optional[str] = ""
    priority: Optional[str] = "Medium"
    type: Optional[str] = "Functional"
    status: Optional[str] = "active"


@router.post("/cases", status_code=201)
def create_case(body: CaseIn, user: dict = Depends(require_qa_write), db: Session = Depends(get_db)):
    _gate()
    if not body.title.strip() or not body.module.strip():
        raise HTTPException(400, "module and title are required")
    now = _now()
    row = QaTestCase(id=str(uuid.uuid4()), module=body.module.strip(), feature=(body.feature or "").strip(),
                     title=body.title.strip(), precondition=body.precondition or "",
                     steps=[s for s in body.steps if str(s).strip()], expected=body.expected or "",
                     priority=body.priority or "Medium", case_type=body.type or "Functional",
                     source="manual", status=body.status or "active",
                     created_by=user["email"], created_at=now, updated_at=now)
    db.add(row); db.commit(); db.refresh(row)
    return _case_dict(row)


class CaseUpdate(BaseModel):
    module: Optional[str] = None
    feature: Optional[str] = None
    title: Optional[str] = None
    precondition: Optional[str] = None
    steps: Optional[list] = None
    expected: Optional[str] = None
    priority: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None   # approve a draft (→ active) or archive


@router.patch("/cases/{case_id}")
def update_case(case_id: str, body: CaseUpdate, user: dict = Depends(require_qa_write), db: Session = Depends(get_db)):
    _gate()
    row = db.query(QaTestCase).filter(QaTestCase.id == case_id).first()
    if not row:
        raise HTTPException(404, "Case not found")
    data = body.model_dump(exclude_unset=True)
    if "type" in data:
        data["case_type"] = data.pop("type")
    for k, v in data.items():
        if v is not None:
            setattr(row, k, v)
    row.updated_at = _now()
    db.commit(); db.refresh(row)
    return _case_dict(row)


# ── runs & results ────────────────────────────────────────────────────────────

@router.get("/runs")
def list_runs(user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    runs = db.query(QaRun).order_by(QaRun.created_at.desc()).all()
    counts = {}
    for r in db.query(QaResult).all():
        c = counts.setdefault(r.run_id, {"pass": 0, "fail": 0, "blocked": 0, "skipped": 0})
        if r.result in c:
            c[r.result] += 1
    return [{"id": r.id, "name": r.name, "status": r.status, "createdBy": r.created_by,
             "createdAt": r.created_at, "counts": counts.get(r.id, {})} for r in runs]


class RunIn(BaseModel):
    name: str


@router.post("/runs", status_code=201)
def create_run(body: RunIn, user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    row = QaRun(id=str(uuid.uuid4()), name=body.name.strip(), status="open",
                created_by=user["email"], created_at=_now())
    db.add(row); db.commit()
    return {"id": row.id, "name": row.name, "status": row.status,
            "createdBy": row.created_by, "createdAt": row.created_at, "counts": {}}


@router.get("/runs/{run_id}/results")
def run_results(run_id: str, user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    rows = db.query(QaResult).filter(QaResult.run_id == run_id).all()
    return [{"caseId": r.case_id, "result": r.result, "failedStep": r.failed_step,
             "stepState": r.step_state or [], "notes": r.notes, "evidence": r.evidence or {},
             "testedBy": r.tested_by, "testedAt": r.tested_at} for r in rows]


class ResultIn(BaseModel):
    case_id: str
    result: Optional[str] = ""        # '' while in progress
    failed_step: Optional[int] = -1
    step_state: Optional[list] = None
    notes: Optional[str] = ""
    evidence: Optional[dict] = None


@router.post("/runs/{run_id}/results")
def upsert_result(run_id: str, body: ResultIn, user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    if body.result not in ("", "pass", "fail", "blocked", "skipped"):
        raise HTTPException(400, "bad result")
    row = (db.query(QaResult)
           .filter(QaResult.run_id == run_id, QaResult.case_id == body.case_id).first())
    if not row:
        row = QaResult(id=str(uuid.uuid4()), run_id=run_id, case_id=body.case_id)
        db.add(row)
    row.result = body.result or ""
    row.failed_step = body.failed_step if body.failed_step is not None else -1
    if body.step_state is not None:
        row.step_state = body.step_state
    row.notes = body.notes or ""
    if body.evidence is not None:
        row.evidence = body.evidence
    row.tested_by = user["email"]
    row.tested_at = _now()
    db.commit()
    return {"ok": True}


# ── activity log — who ran what, who assigned what ───────────────────────────

@router.get("/activity")
def activity(user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    results = (db.query(QaResult).filter(QaResult.result != "")
               .order_by(QaResult.tested_at.desc()).limit(200).all())
    case_ids = {r.case_id for r in results}
    titles = {c.id: c.title for c in db.query(QaTestCase).filter(QaTestCase.id.in_(case_ids)).all()} if case_ids else {}
    runs = {r.id: r.name for r in db.query(QaRun).all()}
    out = [{"kind": "result", "at": r.tested_at, "by": r.tested_by, "result": r.result,
            "case": titles.get(r.case_id, r.case_id), "run": runs.get(r.run_id, "")} for r in results]
    for a in db.query(QaAssignment).order_by(QaAssignment.created_at.desc()).limit(100).all():
        out.append({"kind": "assignment", "at": a.created_at, "by": a.assigned_by,
                    "assignee": a.assignee_email, "count": len(a.case_ids or []),
                    "due": a.due_date, "run": runs.get(a.run_id, "")})
    out.sort(key=lambda x: x["at"] or "", reverse=True)
    return out[:250]


# ── bug reports + AI conversion ───────────────────────────────────────────────

def _bug_dict(b: QaBugReport) -> dict:
    return {"id": b.id, "description": b.description, "moduleHint": b.module_hint,
            "caseId": b.case_id, "runId": b.run_id, "failedStep": b.failed_step,
            "stepsLog": b.steps_log or [], "recordingUrl": b.recording_url,
            "screenshots": b.screenshots or [], "status": b.status,
            "convertedCaseId": b.converted_case_id, "createdBy": b.created_by,
            "createdAt": b.created_at}


@router.get("/bug-reports")
def list_bugs(user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    rows = db.query(QaBugReport).order_by(QaBugReport.created_at.desc()).limit(300).all()
    return [_bug_dict(b) for b in rows]


class BugIn(BaseModel):
    description: str
    module_hint: Optional[str] = ""
    case_id: Optional[str] = ""
    run_id: Optional[str] = ""
    failed_step: Optional[int] = -1
    steps_log: Optional[list] = None
    recording_url: Optional[str] = ""
    screenshots: Optional[list] = None


@router.post("/bug-reports", status_code=201)
def create_bug(body: BugIn, user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    if not body.description.strip():
        raise HTTPException(400, "description is required")
    row = QaBugReport(id=str(uuid.uuid4()), description=body.description.strip(),
                      module_hint=body.module_hint or "", case_id=body.case_id or "",
                      run_id=body.run_id or "", failed_step=body.failed_step if body.failed_step is not None else -1,
                      steps_log=body.steps_log or [], recording_url=body.recording_url or "",
                      screenshots=body.screenshots or [], status="new",
                      created_by=user["email"], created_at=_now())
    db.add(row); db.commit(); db.refresh(row)
    return _bug_dict(row)


@router.patch("/bug-reports/{bug_id}")
def update_bug(bug_id: str, body: dict, user: dict = Depends(require_qa_write), db: Session = Depends(get_db)):
    _gate()
    row = db.query(QaBugReport).filter(QaBugReport.id == bug_id).first()
    if not row:
        raise HTTPException(404, "Bug report not found")
    if body.get("status") in ("new", "converted", "dismissed"):
        row.status = body["status"]
    db.commit()
    return _bug_dict(row)


_MODULES = ["People", "My HR", "Item Management", "Asset Management",
            "Documents (E-Sign)", "Time Clock", "Dashboards", "Other"]


@router.post("/bug-reports/{bug_id}/convert")
def convert_bug(bug_id: str, user: dict = Depends(require_qa_write), db: Session = Depends(get_db)):
    """One cheap Haiku call: bug description + recorded click log → a drafted
    test case (status='draft') the reviewer edits/approves in the Library."""
    _gate()
    bug = db.query(QaBugReport).filter(QaBugReport.id == bug_id).first()
    if not bug:
        raise HTTPException(404, "Bug report not found")
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise HTTPException(503, "AI conversion not configured (ANTHROPIC_API_KEY)")

    log_lines = []
    for ev in (bug.steps_log or [])[:60]:
        view = ev.get("view", "")
        label = ev.get("label", "")
        log_lines.append(f"- [{view}] {ev.get('role','click')} → \"{label}\"")
    prompt = (
        "You turn a QA bug report into ONE reproducible manual test case for an internal web app "
        "(Greens Nexus). Write for a layman: short, concrete, click-by-click steps.\n\n"
        f"MODULES (pick the best fit): {json.dumps(_MODULES)}\n\n"
        f"BUG DESCRIPTION (from the tester):\n{bug.description}\n\n"
        + (f"RECORDED CLICK LOG (what they actually did, in order):\n" + "\n".join(log_lines) + "\n\n" if log_lines else "")
        + "Return ONLY a JSON object with keys: module (from the list), feature (2-4 words), "
          "title (one sentence, imperative), precondition (what must exist before starting, or ''), "
          "steps (array of 3-10 short imperative strings, one action each), "
          "expected (what SHOULD happen if the bug were fixed), "
          "priority ('High'|'Medium'|'Low' by user impact). No prose, no markdown fences."
    )
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": _AI_MODEL, "max_tokens": 900,
                      "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        txt = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        m = re.search(r"\{.*\}", txt, re.S)
        draft = json.loads(m.group(0)) if m else None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AI conversion failed: {str(e)[:200]}")
    if not draft or not draft.get("title") or not isinstance(draft.get("steps"), list):
        raise HTTPException(502, "AI returned an unusable draft — try again")

    now = _now()
    case = QaTestCase(
        id=str(uuid.uuid4()),
        module=draft.get("module") if draft.get("module") in _MODULES else (bug.module_hint or "Other"),
        feature=str(draft.get("feature", ""))[:80], title=str(draft["title"])[:200],
        precondition=str(draft.get("precondition", ""))[:500],
        steps=[str(s)[:300] for s in draft["steps"]][:12],
        expected=str(draft.get("expected", ""))[:600],
        priority=draft.get("priority") if draft.get("priority") in ("High", "Medium", "Low") else "Medium",
        case_type="Bug check", source="ai", status="draft",
        created_by=user["email"], created_at=now, updated_at=now)
    db.add(case)
    bug.status = "converted"
    bug.converted_case_id = case.id
    db.commit(); db.refresh(case)
    return _case_dict(case)


# ── assignments (+ email + bell; Teams DM is client-side) ─────────────────────

class AssignIn(BaseModel):
    run_id: str
    assignee_email: str
    case_ids: list
    due_date: Optional[str] = ""
    note: Optional[str] = ""


@router.get("/assignments")
def list_assignments(run_id: str = "", user: dict = Depends(require_qa_read), db: Session = Depends(get_db)):
    _gate()
    q = db.query(QaAssignment)
    if run_id:
        q = q.filter(QaAssignment.run_id == run_id)
    rows = q.order_by(QaAssignment.created_at.desc()).limit(200).all()
    return [{"id": a.id, "runId": a.run_id, "assignee": a.assignee_email,
             "caseIds": a.case_ids or [], "dueDate": a.due_date, "note": a.note,
             "assignedBy": a.assigned_by, "createdAt": a.created_at} for a in rows]


@router.post("/assignments", status_code=201)
def create_assignment(body: AssignIn, user: dict = Depends(require_qa_write), db: Session = Depends(get_db)):
    _gate()
    email = body.assignee_email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "assignee_email is required")
    if not body.case_ids:
        raise HTTPException(400, "case_ids is required")
    run = db.query(QaRun).filter(QaRun.id == body.run_id).first()
    if not run:
        raise HTTPException(404, "Run not found")

    row = QaAssignment(id=str(uuid.uuid4()), run_id=body.run_id, assignee_email=email,
                       case_ids=body.case_ids, due_date=(body.due_date or "").strip(),
                       note=(body.note or "").strip(), assigned_by=user["email"], created_at=_now())
    db.add(row)

    n = len(body.case_ids)
    due_txt = f" — due {row.due_date}" if row.due_date else ""
    title = f"{n} test case{'s' if n != 1 else ''} assigned to you"
    body_txt = (f"You've been assigned {n} test case{'s' if n != 1 else ''} in run "
                f"“{run.name}”{due_txt}. Open Testing → Run tests to complete them."
                + (f" Note: {row.note}" if row.note else ""))
    # Targeted bell (server-side only — employees can't POST notifications).
    db.add(NexusNotification(id=str(uuid.uuid4()), type="qa_assignment", recipient=email,
                             title=title, body=body_txt, ref_id=row.id,
                             created_at=_now()))
    db.commit()

    # Email — best-effort, never fails the assignment (same stance as HR's Entra sync).
    email_sent, email_error = False, ""
    from_email = os.getenv("NEXUS_FROM_EMAIL", "")
    try:
        if from_email:
            from routers.notifications import _graph_token
            token = _graph_token()
            assigner_name = (db.query(NexusRole).filter(NexusRole.email == user["email"]).first() or
                             type("x", (), {"display_name": ""})).display_name or user["email"].split("@")[0].title()
            html = (f"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2a44'>"
                    f"<h2 style='margin:0 0 8px'>{title}</h2>"
                    f"<p>{assigner_name} assigned you {n} test case{'s' if n != 1 else ''} in "
                    f"<b>{run.name}</b>{due_txt}.</p>"
                    + (f"<p><i>{row.note}</i></p>" if row.note else "")
                    + "<p>Open <b>Nexus → Testing → Run tests</b> to complete them.</p></div>")
            resp = httpx.post(
                f"https://graph.microsoft.com/v1.0/users/{from_email}/sendMail",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"message": {"subject": f"Nexus QA: {title}",
                                  "body": {"contentType": "HTML", "content": html},
                                  "toRecipients": [{"emailAddress": {"address": email}}]},
                      "saveToSentItems": False},
                timeout=15)
            email_sent = resp.is_success
            if not resp.is_success:
                email_error = resp.text[:200]
        else:
            email_error = "NEXUS_FROM_EMAIL not configured"
    except Exception as e:  # noqa: BLE001
        email_error = str(e)[:200]

    return {"id": row.id, "runId": row.run_id, "assignee": row.assignee_email,
            "caseIds": row.case_ids, "dueDate": row.due_date, "note": row.note,
            "assignedBy": row.assigned_by, "createdAt": row.created_at,
            "emailSent": email_sent, "emailError": email_error,
            "teamsSummary": f"\U0001F9EA {title} — run “{run.name}”{due_txt}. "
                            f"Open Nexus → Testing → Run tests."}
