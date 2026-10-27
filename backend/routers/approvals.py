"""Approvals (Neil, Oct 27 2026) - everything waiting on the signed-in
person's decision, across modules. The sources and their rules live in
approvals_inbox.py; the decisions themselves go to each module's own
endpoint, never through here.

    GET /approvals/inbox -> {rows, counts, groups, groupLabels, errors, total}

A plain `def` route: FastAPI runs it in its thread pool, so the database
work never sits on the event loop.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import approvals_inbox
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/approvals", tags=["Approvals"])


@router.get("/inbox")
def inbox(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    out = approvals_inbox.collect(db, user)
    out["groupLabels"] = [{"key": k, "label": label} for k, label in approvals_inbox.GROUPS]
    return out
