"""Timesheet review endpoints (Sep 2026) - the hand-offs between an employee
and their manager before a timesheet is signed in Nexus Sign. The rules live
in timesheet_review.py; this file only decides who may call what.

Signing itself happens in Nexus Sign (/esign/mine/{party_id}/...), which calls
back into timesheet_review when a party signs, declines, or completes it.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import timesheet_review as tsr
from auth import get_current_user
from database import get_db
from models import TimesheetReview
from routers.esign import _client_meta
from routers.timeclock import _visible_emails, require_approval_write

router = APIRouter(prefix="/timesheet-review", tags=["Timesheet review"],
                   dependencies=[Depends(get_current_user)])


class SubmitIn(BaseModel):
    start: str = ""      # any date in the period; omit for the current one
    note: str = ""


class NoteIn(BaseModel):
    note: str = ""


class ApprovePeriodIn(BaseModel):
    email: str
    start: str = ""      # any date in the period
    note: str = ""


class BulkItemIn(BaseModel):
    id: str = ""         # a submitted review, or...
    email: str = ""      # ...a closed period nobody submitted
    start: str = ""      # any date in that period


class ApproveBulkIn(BaseModel):
    items: list[BulkItemIn] = Field(default_factory=list)
    note: str = ""


# One CALL approves at most this many (Oct 17). Each approval builds the PDF
# and sends the envelope inside the request, so a bigger batch could outlive
# Azure's ~230s request limit; the screen sends 10 per call.
BULK_MAX = 25


class FinalizeUnsignedIn(BaseModel):
    email: str
    start: str = ""      # any date in the period
    reason: str = ""


def _review(db: Session, rid: str) -> TimesheetReview:
    # Row-locked: the manager and the Backup Manager clicking Approve at the
    # same moment must not send two envelopes (CLAUDE.md - with_for_update).
    r = db.query(TimesheetReview).filter(TimesheetReview.id == rid).with_for_update().first()
    if not r:
        raise HTTPException(404, "Time sheet review not found")
    return r


def _reviewer_of(db: Session, user: dict, employee_email: str, manager_email: str = "") -> str:
    """The manager side: the employee's reviewer, or anyone whose team scope
    covers them (HR). Never the employee on their own timesheet."""
    me = (user.get("email") or "").lower()
    employee_email = (employee_email or "").lower()
    if me == employee_email:
        raise HTTPException(403, "You can't review your own time sheet.")
    scope = _visible_emails(db, user)
    if me != (manager_email or "").lower() and scope is not None and employee_email not in scope:
        raise HTTPException(404, "Time sheet review not found")
    return me


def _as_reviewer(db: Session, user: dict, r: TimesheetReview) -> str:
    return _reviewer_of(db, user, r.employee_email, r.manager_email)


@router.get("/waiting")
def waiting(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Timesheets submitted to the caller for review - the list at the top of
    People > Time (Sep 29). Empty for anyone nobody reports to."""
    me = (user.get("email") or "").lower()
    # Oct 16: plus the closed periods of the caller's people that nobody has
    # submitted - the manager reviews first.
    rows = [tsr.queue_row(db, r) for r in tsr.waiting_on(db, me)] + tsr.not_reviewed(db, me)
    # A row the caller has only as a stand-in carries who it is for - the
    # "For <delegator>" chip (approver delegation, Oct 17).
    import approval_delegation
    deleg = approval_delegation.delegated_people(db, me)
    for row in rows:
        f = deleg.get((row.get("employeeEmail") or "").lower())
        if f:
            row["forEmail"], row["forName"] = f, tsr.display_name(db, f)
    return {"reviews": rows,
            # ...and the agreed timesheets waiting on the caller's SIGNATURE
            # (manager or HR turn), signed in place from the same card (Oct 16).
            "toSign": tsr.to_sign(db, me)}


@router.post("/submit")
def submit(body: SubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = tsr.submit(db, user["email"], (body.start or "").strip(), body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, user["email"], False)


@router.post("/{rid}/send-back")
def send_back(rid: str, body: NoteIn, user: dict = Depends(require_approval_write),
              db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    tsr.send_back(db, r, me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/agree")
def agree(rid: str, body: NoteIn, request: Request, user: dict = Depends(require_approval_write),
          db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    ip, ua = _client_meta(request)
    tsr.agree(db, r, me, body.note, ip=ip, user_agent=ua)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/approve")
def approve(rid: str, body: NoteIn, user: dict = Depends(require_approval_write), db: Session = Depends(get_db)):
    """The manager's Review & Approve (Oct 16) - no signature, a logged click."""
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    tsr.approve(db, r, me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/approve")
def approve_period(body: ApprovePeriodIn, user: dict = Depends(require_approval_write),
                   db: Session = Depends(get_db)):
    """Review & Approve a period the employee has not submitted (Oct 16)."""
    email = (body.email or "").strip().lower()
    me = _reviewer_of(db, user, email, tsr.manager_of(db, email))
    r = tsr.approve_period(db, email, (body.start or "").strip(), me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


# Why a time sheet that is no longer waiting on the manager is skipped - the
# usual case is the same click run twice, which must change nothing.
_NOT_WAITING = {
    "signing": "Already approved - it is with the employee to sign.",
    "completed": "Already signed and finalized.",
    "with_employee": "Sent back to the employee for changes.",
    "approved": "Approved and waiting for the employee to sign HR's changes.",
}


def _detail(e: HTTPException) -> str:
    d = e.detail
    if isinstance(d, dict):
        return str(d.get("message") or d.get("code") or "Could not approve this one.")
    return str(d or "Could not approve this one.")


def _approve_one(db: Session, user: dict, item: BulkItemIn, note: str) -> dict:
    """One line of Approve All Clean, through the SAME calls the single
    Approve buttons make (/{rid}/approve and /approve): the reviewer check,
    then tsr.approve / tsr.approve_period, which commit on their own. Only
    a clean time sheet goes (tsr.review_flag, the flag the list shows)."""
    rid = (item.id or "").strip()
    if rid:
        r = _review(db, rid)
        me = _as_reviewer(db, user, r)
        if r.status != "with_manager":
            db.rollback()                       # release the row lock
            return {"status": "skipped", "reason": _NOT_WAITING.get(r.status, "Not waiting on your review.")}
        flag = tsr.review_flag(db, r.employee_email, r.period_start, r.period_end)
        if flag:
            db.rollback()
            return {"status": "skipped", "reason": flag}
        tsr.approve(db, r, me, note)
        return {"status": "approved", "id": r.id}
    email = (item.email or "").strip().lower()
    if not email:
        return {"status": "failed", "error": "Pick a time sheet to approve."}
    me = _reviewer_of(db, user, email, tsr.manager_of(db, email))
    start, end, _pt = tsr.period_for(db, email, (item.start or "").strip())
    r = tsr.active_review(db, email, start)
    if r is not None and r.status != "with_manager":
        return {"status": "skipped", "reason": _NOT_WAITING.get(r.status, "Not waiting on your review.")}
    flag = tsr.review_flag(db, email, start, end)
    if flag:
        return {"status": "skipped", "reason": flag}
    r = tsr.approve_period(db, email, start, me, note)
    return {"status": "approved", "id": r.id}


@router.post("/approve-bulk")
def approve_bulk(body: ApproveBulkIn, user: dict = Depends(require_approval_write), db: Session = Depends(get_db)):
    """Approve All Clean (Neil, Oct 17): Review & Approve every listed time
    sheet that has nothing to look at - each one exactly as its own Approve
    button would (same checks, same envelope to the employee, same approval
    log). A flagged one is skipped with the reason and stays on the list; a
    failure is rolled back alone and the rest still go. Running it again
    skips what already went, so a retried click changes nothing."""
    items = body.items or []
    if not items:
        raise HTTPException(422, "Pick at least one time sheet to approve.")
    if len(items) > BULK_MAX:
        raise HTTPException(422, f"Approve up to {BULK_MAX} time sheets at a time.")
    results, seen = [], set()
    for item in items:
        line = {"id": (item.id or "").strip(), "email": (item.email or "").strip().lower(),
                "start": (item.start or "").strip()}
        key = line["id"] or f"{line['email']}|{line['start']}"
        if key in seen:
            results.append({**line, "status": "skipped", "reason": "Listed twice."})
            continue
        seen.add(key)
        try:
            out = _approve_one(db, user, item, body.note)
        except HTTPException as e:
            db.rollback()
            out = {"status": "failed", "error": _detail(e)}
        except Exception as e:  # noqa: BLE001 - one bad time sheet must not stop the rest
            db.rollback()
            print(f"[timesheet-review] bulk approve failed for {key}: {type(e).__name__}: {e}")
            out = {"status": "failed", "error": "Could not approve this one. Try it on its own."}
        results.append({**line, **out, "id": out.get("id") or line["id"]})
    count = {k: sum(1 for x in results if x["status"] == k) for k in ("approved", "skipped", "failed")}
    return {"results": results, **count}


@router.post("/finalize-unsigned")
def finalize_unsigned(body: FinalizeUnsignedIn, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """HR: Finalize Without Employee Signature (Oct 17) - for someone who left,
    or who has not signed an approved card in UNSIGNED_WAIT_DAYS. is_hr is
    the gate (checked in tsr.finalize_unsigned)."""
    email = (body.email or "").strip().lower()
    me = (user.get("email") or "").lower()
    if not tsr.is_hr(db, me, email):
        raise HTTPException(403, "Only HR can finalize a time sheet without the employee's signature.")
    r = tsr.finalize_unsigned(db, email, (body.start or "").strip(), me, body.reason)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/sign")
def employee_sign(rid: str, request: Request, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """The employee's Approve & Sign: sends the envelope with them as the
    only signer and answers with their party, so the signing screen opens."""
    r = _review(db, rid)
    me = (user.get("email") or "").lower()
    if me != r.employee_email:
        raise HTTPException(404, "Time sheet review not found")
    ip, ua = _client_meta(request)
    tsr.employee_approve(db, r, me, ip=ip, user_agent=ua)
    return tsr.state_for(db, r.employee_email, r.period_start, me, False)


# ── CA meal and rest breaks at signing (Neil, Oct 17-18 2026) ────────────────
# CA-rule staff who track time, hourly and salaried (Charmi, Oct 20 -
# timesheet_review.needs_break_attestation); anyone
# else gets a 409 and their signing is unchanged. Signing itself confirms the
# meal and rest break statement - there is no separate Yes endpoint.

class BreakClaimItem(BaseModel):
    date: str
    kind: str            # meal | rest


class BreakClaimIn(BaseModel):
    claims: list[BreakClaimItem] = Field(default_factory=list)
    note: str = ""


def _own_review(db: Session, rid: str, user: dict) -> TimesheetReview:
    r = _review(db, rid)
    if (user.get("email") or "").lower() != r.employee_email:
        raise HTTPException(404, "Time sheet review not found")
    return r


@router.post("/{rid}/break-claim")
def break_claim(rid: str, body: BreakClaimIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Report a Missed Break: the days and break kinds missed. Does NOT sign - the time sheet goes
    back to the manager with the claim (the punch-fix reopen path)."""
    r = _own_review(db, rid, user)
    tsr.claim_breaks(db, r, user["email"], [c.model_dump() for c in body.claims], body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, user["email"], False)
