"""Daily HR reminder job (roadmap Section H).

One background task, started from main.py, that scans every morning for:
  - right-to-work / visa documents expiring within 60 days
  - contractor contract ends within 30 days
  - HR documents (uploads with expires_on) within 30 days
  - new starters in the next 7 days
  - candidate interviews happening today
  - pending e-sign requests expiring within 3 days

Notifications go to the HR team (every member of an Access Group granting the
hr module) via the standard server-side bell — plus the reporting manager for
new starters. Each check dedupes per (type, ref, day) so an app restart never
double-pings.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta

from database import SessionLocal
from models import (NexusEmployee, NexusNotification, NexusGroup, NexusGroupMember,
                    HrCandidate, HrDocument, HrSignRequest)

_SCAN_HOUR_UTC = 13   # ~6am PT / 6:30pm IST — start of the US workday


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hr_team_emails(db) -> list:
    out = set()
    for g in db.query(NexusGroup).all():
        if "hr:" in (g.allowed_modules or ""):
            for m in db.query(NexusGroupMember).filter(NexusGroupMember.group_id == g.id).all():
                out.add(m.email.lower())
    return sorted(out)


def _already_sent(db, ntype: str, ref_id: str, recipient: str) -> bool:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return (db.query(NexusNotification)
            .filter(NexusNotification.type == ntype,
                    NexusNotification.ref_id == ref_id,
                    NexusNotification.recipient == recipient,
                    NexusNotification.created_at.like(f"{today}%"))
            .first() is not None)


def _notify(db, ntype: str, recipient: str, title: str, body: str, ref_id: str = "",
            action: dict = None, requested_by: str = "") -> bool:
    recipient = (recipient or "").strip().lower()
    if not recipient or _already_sent(db, ntype, ref_id, recipient):
        return False
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type=ntype, recipient=recipient, title=title, body=body,
        ref_id=ref_id, item_name="", requested_by=requested_by,
        action=json.dumps(action) if action else "", actioned=False, read_by="",
        created_at=_now_iso()))
    return True


def _days_until(date_str: str):
    try:
        d = datetime.strptime(date_str.strip()[:10], "%Y-%m-%d").date()
        return (d - datetime.now(timezone.utc).date()).days
    except Exception:
        return None


def run_daily_scan() -> int:
    """Run all checks once. Returns how many notifications were created."""
    db = SessionLocal()
    sent = 0
    try:
        hr_team = _hr_team_emails(db)
        employees = db.query(NexusEmployee).filter(NexusEmployee.status.in_(["active", "onboarding"])).all()
        act = {"view": "hr", "sub": "hr-people"}

        for e in employees:
            name = f"{e.first_name} {e.last_name}".strip()

            # 1. Right-to-work / visa doc expiry (compliance.expiryDate)
            exp = (e.compliance or {}).get("expiryDate", "")
            d = _days_until(exp) if exp else None
            if d is not None and (d in (60, 30, 14, 7, 3, 1, 0) or -7 <= d < 0):
                msg = (f"{name}'s right-to-work document expired {abs(d)}d ago." if d < 0
                       else f"{name}'s right-to-work document expires in {d} day{'s' if d != 1 else ''} ({exp}).")
                for r in hr_team:
                    sent += _notify(db, "hr_expiry", r, "Right-to-work expiry", msg, ref_id=e.id, action=act)

            # 2. Contractor contract end (contractor.contract_end)
            cend = (e.contractor or {}).get("contract_end", "")
            d = _days_until(cend) if cend else None
            if d is not None and d in (30, 14, 7, 1, 0):
                msg = f"{name}'s contract ends in {d} day{'s' if d != 1 else ''} ({cend})."
                for r in hr_team:
                    sent += _notify(db, "hr_contract_end", r, "Contract ending", msg, ref_id=e.id, action=act)

            # 3. Upcoming start dates (next 7 days, onboarding people)
            d = _days_until(e.start_date) if e.start_date and e.status == "onboarding" else None
            if d is not None and d in (7, 3, 1, 0):
                when = "today" if d == 0 else f"in {d} day{'s' if d != 1 else ''}"
                msg = f"{name} ({e.job_title or e.department or 'new hire'}) starts {when}."
                for r in set(hr_team + ([e.manager_email.lower()] if e.manager_email else [])):
                    sent += _notify(db, "hr_new_starter", r, "New starter", msg, ref_id=e.id, action=act)

        # 4. HR document expiries (uploads with expires_on)
        for doc in db.query(HrDocument).filter(HrDocument.expires_on != "").all():
            d = _days_until(doc.expires_on)
            if d is not None and d in (30, 14, 7, 1, 0):
                emp = db.query(NexusEmployee).filter(NexusEmployee.id == doc.employee_id).first()
                who = f"{emp.first_name} {emp.last_name}".strip() if emp else "an employee"
                msg = f"{who}'s document \"{doc.file_name}\" expires in {d} day{'s' if d != 1 else ''} ({doc.expires_on})."
                for r in hr_team:
                    sent += _notify(db, "hr_doc_expiry", r, "Document expiring", msg, ref_id=doc.id, action=act)

        # 5. Interviews today (candidate owner)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        for c in db.query(HrCandidate).filter(HrCandidate.interview_at != "").all():
            if (c.interview_at or "")[:10] == today and c.stage not in ("hired", "rejected"):
                cand = f"{c.first_name} {c.last_name}".strip()
                try:
                    t = datetime.fromisoformat(c.interview_at).strftime("%H:%M")
                except ValueError:
                    t = c.interview_at
                sent += _notify(db, "hr_interview", c.created_by, "Interview today",
                                f"{cand} ({c.role_title or 'candidate'}) — interview at {t}.",
                                ref_id=c.id, action={"view": "hr", "sub": "hr-hiring"},
                                requested_by=cand)

        # 6. Pending e-sign requests expiring within 3 days (sender)
        for req in db.query(HrSignRequest).filter(HrSignRequest.status == "pending",
                                                  HrSignRequest.expires_on != "").all():
            d = _days_until(req.expires_on)
            if d is not None and 0 <= d <= 3:
                sent += _notify(db, "esign_expiring", req.created_by, "Signature request expiring",
                                f"\"{req.title}\" is still unsigned and expires in {d} day{'s' if d != 1 else ''}. Send a reminder or extend it.",
                                ref_id=req.id, action={"view": "hr", "sub": "hr-esign"})

        # 7. Field-tracking retention: purge raw location pings past the window
        # (data-minimization guardrail — keep only recent breadcrumbs).
        from routers.timeclock import purge_old_track_pings
        cut = purge_old_track_pings(db)
        if cut:
            print(f"[reminders] purged {cut} expired location ping(s)")

        db.commit()
        print(f"[reminders] daily scan complete — {sent} notification(s)")
        return sent
    except Exception as e:
        db.rollback()
        print(f"[reminders] scan failed: {e}")
        return 0
    finally:
        db.close()


async def reminders_loop():
    """Run once shortly after boot (covers restarts/deploys), then daily at
    _SCAN_HOUR_UTC. Dedupe makes the boot run safe."""
    await asyncio.sleep(60)   # let migrations/startup settle
    while True:
        try:
            await asyncio.to_thread(run_daily_scan)
        except Exception as e:
            print(f"[reminders] loop error: {e}")
        now = datetime.now(timezone.utc)
        nxt = now.replace(hour=_SCAN_HOUR_UTC, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        await asyncio.sleep((nxt - now).total_seconds())
