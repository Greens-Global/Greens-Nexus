"""Approvals (Neil, Oct 27 2026) - everything waiting on the signed-in
person's decision, across modules. The sources and their rules live in
approvals_inbox.py; the decisions themselves go to each module's own
endpoint, never through here.

    GET /approvals/inbox -> {rows, counts, groups, groupLabels, scopes, departments, companies, who, aging, errors, total}
    POST /approvals/decided   the browser records a decision the module accepted (models.ApprovalDecision)
    GET /approvals/history    the caller's own decisions, newest first, with decided-today / this-week figures

A plain `def` route: FastAPI runs it in its thread pool, so the database
work never sits on the event loop.
"""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import approvals_inbox
import models
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/approvals", tags=["Approvals"])


@router.get("/inbox")
def inbox(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    out = approvals_inbox.collect(db, user)
    out["groupLabels"] = [{"key": k, "label": label} for k, label in approvals_inbox.GROUPS]
    return out


class DecidedIn(BaseModel):
    kind: str = ""
    id: str = ""
    group: str = ""
    action: str = ""
    note: str = ""
    title: str = ""
    personEmail: str = ""
    personName: str = ""
    department: str = ""
    company: str = ""
    createdAt: str = ""
    forEmail: str = ""


@router.post("/decided", status_code=201)
def decided(body: DecidedIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Record a decision the inbox just sent and the module accepted. The
    module's record is the truth; this is the decider's own history."""
    me = (user.get("email") or "").strip().lower()
    if not me or not body.kind or not body.id or not body.action:
        raise HTTPException(400, "kind, id and action are required")
    waited = 0
    try:
        waited = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(body.createdAt)).days) if body.createdAt else 0
    except ValueError:
        waited = 0
    row = models.ApprovalDecision(id=str(uuid.uuid4()), decider_email=me, kind=body.kind[:60], item_id=body.id[:120],
                                  group_key=body.group[:40], action=body.action[:40].lower(), note=(body.note or "")[:2000],
                                  title=(body.title or "")[:300], person_email=(body.personEmail or "").lower()[:200],
                                  person_name=(body.personName or "")[:200], department=(body.department or "")[:120],
                                  company_id=(body.company or "")[:80], waited_days=waited, for_email=(body.forEmail or "").lower()[:200],
                                  decided_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.get("/history")
def history(days: int = 30, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own decisions from the inbox, newest first (at most 90 days)."""
    me = (user.get("email") or "").strip().lower()
    days = max(1, min(int(days or 30), 90))
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = (db.query(models.ApprovalDecision).filter(models.ApprovalDecision.decider_email == me,
                                                     models.ApprovalDecision.decided_at >= since)
            .order_by(models.ApprovalDecision.decided_at.desc()).limit(500).all())
    today = now.strftime("%Y-%m-%d")
    week = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    names = {k: label for k, label in approvals_inbox.GROUPS}
    return {"days": days,
            "decidedToday": sum(1 for r in rows if r.decided_at[:10] == today),
            "decidedWeek": sum(1 for r in rows if r.decided_at >= week),
            "avgWaitDays": round(sum(r.waited_days for r in rows) / len(rows), 1) if rows else 0,
            "rows": [{"id": r.id, "kind": r.kind, "itemId": r.item_id, "group": r.group_key, "groupLabel": names.get(r.group_key, ""),
                      "action": r.action, "note": r.note or "", "title": r.title, "person": {"email": r.person_email, "name": r.person_name},
                      "department": r.department, "company": r.company_id, "waitedDays": r.waited_days, "forEmail": r.for_email,
                      "decidedAt": r.decided_at} for r in rows]}
