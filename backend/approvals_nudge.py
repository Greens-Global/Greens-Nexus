"""The stale-approval nudge (Dashboard > Approvals, Oct 30 2026).

Once a day (reminders_loop), every approver whose Approvals inbox holds a
decision that has waited STALE_DAYS or more gets ONE bell - "N approvals
have waited over 3 days" - rewritten in place each day while it is true and
closed the day it is not. Nothing is auto-rejected or escalated: the
approval queues in the modules are untouched; this is the reminder every
approval-inbox worth its salt sends (ServiceNow, Workday, Sage) so a leave
request does not sit forgotten until the day it starts.

Who is checked: the people who can approve something - managers (someone
reports to them), the HR contacts, Global Admins, role holders of manager
tier or above, and anyone who decided from the inbox in the last 90 days (a
named approver). Each one's inbox is read with approvals_inbox.collect, the
same registry the screen reads, in a thread (CLAUDE.md: never on the loop).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

import approvals_inbox
import models
import notify_rollup

log = logging.getLogger(__name__)

STALE_DAYS = 3
KEY = "approvals-stale"


def approvers(db: Session) -> set:
    """Everyone who may have a decision waiting (see the module docstring)."""
    out: set = set()
    active = [e for e in db.query(models.NexusEmployee).all() if (e.status or "active") not in ("inactive", "offboarded")]
    emails = {(e.work_email or "").lower() for e in active if e.work_email}
    out |= {(e.manager_email or "").lower() for e in active if (e.manager_email or "").strip()} & emails
    out |= {(c.hr_contact_email or "").lower() for c in db.query(models.HrEntity).all() if (c.hr_contact_email or "").strip()}
    ga = [g.id for g in db.query(models.NexusGroup.id).filter(models.NexusGroup.is_global_admin == 1).all()]
    if ga:
        out |= {(m.email or "").lower() for m in db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(ga)).all()}
    out |= {(r.email or "").lower() for r in db.query(models.NexusRole).filter(models.NexusRole.role.in_(["manager", "administrator", "owner"])).all()}
    since = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out |= {(d.decider_email or "").lower() for d in db.query(models.ApprovalDecision.decider_email).filter(models.ApprovalDecision.decided_at >= since).distinct().all()}
    return {e for e in out if e and e in emails}


def _user(db: Session, email: str) -> dict:
    """The user dict the registry's gates expect (what get_current_user builds)."""
    import auth
    role, level = auth._role_for(email, db)
    return {"email": email, "role": role, "level": level}


def nudge_one(db: Session, email: str, today=None) -> int:
    """Read one approver's inbox; write or close their stale bell. Returns the
    number of stale decisions."""
    box = approvals_inbox.collect(db, _user(db, email))
    stale = [r for r in box["rows"] if r.get("scope") == "decide" and _days(r.get("createdAt"), today) >= STALE_DAYS]
    n = sum(r.get("count") or 1 for r in stale)
    if not n:
        notify_rollup.resolve_rollup(db, recipient=email, key=KEY, title="Approvals Caught Up",
                                     line="Nothing in your Approvals has waited over three days.")
        return 0
    oldest = max(_days(r.get("createdAt"), today) for r in stale)
    names = sorted({(r.get("person") or {}).get("name") or "" for r in stale} - {""})
    who = ", ".join(names[:4]) + (f" and {len(names) - 4} more" if len(names) > 4 else "")
    line = (f"{n} {'approval has' if n == 1 else 'approvals have'} waited over {STALE_DAYS} days for your decision"
            f"{f' (the oldest {oldest} days)' if oldest > STALE_DAYS else ''}{f': {who}' if who else ''}. "
            f"Open Dashboard > Approvals to clear them - the longest waiting is first.")
    notify_rollup.upsert_rollup(db, recipient=email, key=KEY, title="Approvals Waiting On You", line=line,
                                action={"view": "dashboard", "sub": "approvals"}, replace=True,
                                priority=1 if oldest >= 7 else None)
    return n


def _days(iso: str, today=None) -> int:
    if not iso:
        return 0
    try:
        t = today or datetime.now(timezone.utc).date()
        return max(0, (t - datetime.fromisoformat(iso).date()).days)
    except ValueError:
        return 0


def run_daily() -> dict:
    """One pass over every approver. Its own session; sync - run in a thread."""
    from database import SessionLocal
    db = SessionLocal()
    nudged = checked = 0
    try:
        for email in sorted(approvers(db)):
            checked += 1
            try:
                if nudge_one(db, email):
                    nudged += 1
                db.commit()
            except Exception:   # noqa: BLE001 - one person's inbox failing never stops the pass
                log.exception("stale approvals nudge failed for %s", email)
                db.rollback()
        return {"checked": checked, "nudged": nudged}
    finally:
        db.close()
