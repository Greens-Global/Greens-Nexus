"""Exits In Progress and the final settlement statement (Neil, Oct 27 2026).
The routes are routers/exit_statements.py.

Who is leaving: a separation life event that is scheduled (last day ahead)
or applied in the last EXIT_WINDOW_DAYS (hr_life_events.py), or a person
marked Left on People without one (status_log) - until HR closes the exit.

The statement gathers, live, what payroll needs for the final pay:
  - the last working day and the final Time Sheet (finalized or not, and a
    link to it);
  - leave balances per bucket (leave_balances.balances), in hours and days.
    Greens' policy is USE IT OR LOSE IT and leave is not encashed (Neil, Oct
    27): every balance shows "Not Paid Out (Company Policy)" - EXCEPT where
    the law requires payout. PAYOUT_REQUIRED_STATES lists those states
    (California to start): there the unused VACATION balance x the hourly
    rate is a payout line flagged with the law. California sick time is not
    paid out (and no state on the list makes sick time payable);
  - approved reimbursements not paid yet (routers/reimbursements.py);
  - the salary advance balance to recover (salary_advance.py);
  - company items still held (read through People's Assets read,
    routers/hr.employee_assets - Items stays the owner), and what was closed
    automatically when they were marked Left;
  - the offboarding checklist's progress (hr_checklists).
Money (rates, amounts) only for the hr_comp grant / owners (routers/hr
_has_comp); everyone else with People access sees the rest.

HR marks it Reviewed - the figures are frozen with their fingerprint - then
generates the PDF on the company letterhead: kept in the person's HR
documents (kind 'settlement', comp-gated like paystubs) and filed to their
Egnyte folder best-effort on a thread. Information for payroll: Nexus does
not run the final pay.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from models import (ExpenseReimbursement, ExitStatement, HrChecklist, HrChecklistItem, HrEntity, HrLifeEvent,
                    NexusEmployee)

# States whose law requires accrued, unused VACATION to be paid at separation.
# The key is the state; the value is the flag the payout line carries. Add a
# state here (and how a person is placed in it - _state_of) to extend it.
PAYOUT_REQUIRED_STATES = {"CA": "Required By California Law"}
NOT_PAID = "Not Paid Out (Company Policy)"
EXIT_WINDOW_DAYS = 180          # an applied exit stays on the list this long unless closed
STATUS_LABEL = {"open": "Open", "reviewed": "Reviewed", "filed": "Filed", "closed": "Closed"}
TS_LABEL = {"finalized": "Finalized", "with_manager": "With Manager", "with_employee": "With Employee",
            "approved": "Approved - Waiting for Signature", "signing": "Out for Signature",
            "correcting": "Being Corrected", "not_started": "Not Submitted", "exempt": "No Time Sheet (Exempt)",
            "no_email": "No Work Email"}
REIMB_OWED = ("approver_approved", "hr_approved")
REIMB_OPEN = ("submitted", "sent_back")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    import hr_life_events
    return hr_life_events._today()


def us_date(iso: str) -> str:
    import timesheet_review
    return timesheet_review.us_date(iso)


def money(amount, currency: str = "USD") -> str:
    from currency import money_prefix
    return f"{money_prefix((currency or 'USD').upper())}{float(amount or 0):,.2f}"


def r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def full_name(emp: NexusEmployee) -> str:
    return (emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip() or (emp.work_email or "")


def log(st: ExitStatement, by: str, action: str, note: str = "", **extra) -> None:
    st.history = list(st.history or []) + [{"at": _now(), "by": by, "action": action, "note": note, **extra}]
    st.updated_at = _now()


# ── The exit's activity (Neil, 11/14/2026) ───────────────────────────────────
# What happened on an exit - the reports moved, an item received, the last
# day moved, the mailbox handover done, an M365 issue - is kept on the
# statement row's history (the one record of the exit, made when first
# needed), and an open problem (M365, a failed export) also rides the
# separation event's flags so the tracker shows it.

def _exit_row(db: Session, emp: NexusEmployee) -> ExitStatement | None:
    ex = exit_of(db, emp)
    if not ex or not ex["lastDay"]:
        return None
    row = _statement_row(db, emp, ex["lastDay"])
    if row is None:
        now = _now()
        row = ExitStatement(id=str(uuid.uuid4()), employee_id=emp.id,
                            employee_email=(emp.work_email or "").strip().lower(), company=emp.company or "",
                            event_id=ex.get("eventId", ""), last_day=ex["lastDay"], status="open", history=[],
                            created_at=now, updated_at=now)
        db.add(row)
        db.flush()
    return row


def record(db: Session, emp: NexusEmployee, by: str, action: str, note: str = "") -> None:
    """One line on the exit's activity. Flushes; the caller commits."""
    row = _exit_row(db, emp)
    if row is not None:
        log(row, (by or "nexus").lower(), action, (note or "")[:500])
        db.flush()


def _emp_by_email(db: Session, email: str) -> NexusEmployee | None:
    from sqlalchemy import func
    em = (email or "").strip().lower()
    return db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == em).first() if em else None


def record_for_email(db: Session, email: str, by: str, action: str, note: str = "") -> None:
    emp = _emp_by_email(db, email)
    if emp is not None:
        record(db, emp, by, action, note)


def _exit_event(db: Session, emp: NexusEmployee) -> HrLifeEvent | None:
    return (db.query(HrLifeEvent)
            .filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "separation",
                    HrLifeEvent.apply_status.in_(("scheduled", "applied")))
            .order_by(HrLifeEvent.created_at.desc()).first())


ISSUE_CODES = ("m365_issue", "mailbox_export_failed")


def flag(db: Session, emp: NexusEmployee, code: str, message: str, event: HrLifeEvent | None = None) -> None:
    """An open problem on the exit HR must see (M365 issue, mailbox export
    failed - license kept): on the separation event's flags (the tracker's
    Access chip) and on the activity. Flushes; the caller commits."""
    ev = event if event is not None else _exit_event(db, emp)
    if ev is not None:
        ev.flags = [f for f in (ev.flags or []) if (f or {}).get("code") != code] + [
            {"code": code, "message": message[:300], "at": _now()}]
    db.flush()
    record(db, emp, "nexus", code, message)


def flag_for_email(db: Session, email: str, code: str, message: str) -> None:
    emp = _emp_by_email(db, email)
    if emp is not None:
        flag(db, emp, code, message)


def mailbox_handover(ev: HrLifeEvent | None) -> dict | None:
    """Kept as a shared mailbox (Neil, 11/14/2026): the Exchange steps are
    done by hand, so the exit carries "Mailbox Handover Pending" until HR
    ticks it done. None = their mailbox is not being shared."""
    d = (ev.inputs or {}) if ev is not None else {}
    off = d.get("offboarding") or {}
    if off.get("mailboxAction") != "share":
        return None
    done = bool(d.get("mailbox_handover_done"))
    return {"pending": not done, "done": done, "by": d.get("mailbox_handover_by", ""),
            "at": d.get("mailbox_handover_at", ""), "delegateTo": list(off.get("delegateTo") or [])}


def move_last_day(db: Session, emp: NexusEmployee, old: str, new: str, by: str) -> None:
    """Change Last Day: the exit's record moves with it (an open review of
    the old figures shows stale - the last day is one of them)."""
    row = _statement_row(db, emp, old) if old else None
    if row is not None and row.status != "closed":
        row.last_day = new
        db.flush()
    record(db, emp, by, "last_day_moved", f"Last day moved from {us_date(old)} to {us_date(new)}")


# ── Who is leaving ───────────────────────────────────────────────────────────

def _left_entry(emp: NexusEmployee) -> dict:
    """The latest status_log entry that marked them Left ({} = none)."""
    for e in reversed(list(emp.status_log or [])):
        if (e or {}).get("to") == "offboarded":
            return e
    return {}


def exit_of(db: Session, emp: NexusEmployee) -> dict | None:
    """{lastDay, exitType, source, eventId, applied} for this person's exit,
    or None when they are not leaving. The newest separation that is
    scheduled or applied wins; else a Left with no separation event."""
    ev = (db.query(HrLifeEvent)
          .filter(HrLifeEvent.employee_id == emp.id, HrLifeEvent.kind == "separation",
                  HrLifeEvent.apply_status.in_(("scheduled", "applied")))
          .order_by(HrLifeEvent.created_at.desc()).first())
    if ev is not None:
        d = ev.inputs or {}
        return {"lastDay": ev.effective_date or d.get("last_day", ""), "exitType": d.get("exit_type", ""),
                "source": "separation", "eventId": ev.id, "applied": ev.apply_status == "applied"}
    if (emp.status or "") == "offboarded":
        e = _left_entry(emp)
        day = ((e.get("effectiveDate") or e.get("at") or "") if e else "")[:10]
        return {"lastDay": day, "exitType": "", "source": "status", "eventId": "", "applied": True,
                "reason": (e.get("reason") or "") if e else ""}
    return None


def _statement_row(db: Session, emp: NexusEmployee, last_day: str) -> ExitStatement | None:
    return (db.query(ExitStatement)
            .filter(ExitStatement.employee_id == emp.id, ExitStatement.last_day == last_day)
            .order_by(ExitStatement.created_at.desc()).first())


def exits_in_progress(db: Session, scope, include_closed: bool = False, *, money: bool = True,
                      only_emails: set | None = None) -> list[dict]:
    """Everyone leaving inside `scope` (routers/hr.hr_scope), soonest last
    day first: scheduled exits, and applied ones from the last
    EXIT_WINDOW_DAYS that HR has not closed - each with ONE "Where It Stands"
    line (the tracker, Neil 11/14/2026): the package, the checklist, the
    items, access, direct reports still to move, the mailbox handover and -
    `money` (Pay & Benefits) only - the settlement. One query per kind for
    every leaver at once, never a query per person.

    `only_emails`: a manager's own view - just these people (their direct
    reports and the people they back up), whatever `scope` is."""
    from routers.hr import _in_scope
    import hr_life_events
    today = _today()
    floor = (date.fromisoformat(today) - timedelta(days=EXIT_WINDOW_DAYS)).isoformat()
    # 1. Every separation that is scheduled or applied - the newest per person wins.
    seps = (db.query(HrLifeEvent)
            .filter(HrLifeEvent.kind == "separation", HrLifeEvent.apply_status.in_(("scheduled", "applied")))
            .order_by(HrLifeEvent.created_at.desc()).all())
    exit_ev = {}
    for ev in seps:
        exit_ev.setdefault(ev.employee_id, ev)
    # 2. The people: those with a separation, and everyone Left.
    q = db.query(NexusEmployee)
    q = (q.filter((NexusEmployee.id.in_(list(exit_ev))) | (NexusEmployee.status == "offboarded")) if exit_ev
         else q.filter(NexusEmployee.status == "offboarded"))
    rows = []
    for emp in q.all():
        em = (emp.work_email or "").strip().lower()
        if only_emails is not None:
            if em not in only_emails:
                continue
        elif not _in_scope(emp, scope):
            continue
        ev = exit_ev.get(emp.id)
        if ev is not None:
            d = ev.inputs or {}
            ex = {"lastDay": ev.effective_date or d.get("last_day", ""), "exitType": d.get("exit_type", ""),
                  "source": "separation", "applied": ev.apply_status == "applied", "event": ev}
        elif (emp.status or "") == "offboarded":
            e = _left_entry(emp)
            ex = {"lastDay": ((e.get("effectiveDate") or e.get("at") or "") if e else "")[:10], "exitType": "",
                  "source": "status", "applied": True, "event": None}
        else:
            continue
        if not ex["lastDay"] or (ex["applied"] and ex["lastDay"] < floor):
            continue
        rows.append((emp, ex))
    if not rows:
        return []
    ids = [emp.id for emp, _ in rows]
    emails = [(emp.work_email or "").strip().lower() for emp, _ in rows if emp.work_email]
    # 3. The exit records (statement rows), one query.
    st_rows = {}
    for r in (db.query(ExitStatement).filter(ExitStatement.employee_id.in_(ids))
              .order_by(ExitStatement.created_at.desc()).all()):
        st_rows.setdefault((r.employee_id, r.last_day), r)
    # 4. The separation packages: every live separation of these people, and
    #    their signers - two queries.
    pk_ev = {}
    for ev in (db.query(HrLifeEvent).filter(HrLifeEvent.kind == "separation", HrLifeEvent.employee_id.in_(ids),
                                            HrLifeEvent.apply_status != "canceled")
               .order_by(HrLifeEvent.created_at.desc()).all()):
        has = bool(ev.sign_request_id or ev.documents or (ev.inputs or {}).get("paper_path")
                   or ev.status in ("intake", "review", "awaiting_sender", "sent", "declined", "voided", "expired"))
        if has:
            pk_ev.setdefault(ev.employee_id, ev)
    req_ids = [ev.sign_request_id for ev in pk_ev.values() if ev.sign_request_id]
    parties = {}
    if req_ids:
        from models import HrSignParty
        for p in db.query(HrSignParty).filter(HrSignParty.request_id.in_(req_ids)).all():
            parties.setdefault(p.request_id, []).append(p)
    # 5. The offboarding checklists and their step counts - two queries.
    cls = {}
    for cl in (db.query(HrChecklist).filter(HrChecklist.employee_id.in_(ids), HrChecklist.kind == "offboarding",
                                            HrChecklist.status != "cancelled")
               .order_by(HrChecklist.created_at.desc()).all()):
        cls.setdefault(cl.employee_id, cl)
    counts = {}
    if cls:
        from sqlalchemy import and_, case, func
        late = case((and_(HrChecklistItem.due_date != "", HrChecklistItem.due_date < today), 1), else_=0)
        for cid, status, n, overdue in (
                db.query(HrChecklistItem.checklist_id, HrChecklistItem.status, func.count(HrChecklistItem.id),
                         func.sum(late))
                .filter(HrChecklistItem.checklist_id.in_([c.id for c in cls.values()]))
                .group_by(HrChecklistItem.checklist_id, HrChecklistItem.status).all()):
            c = counts.setdefault(cid, {"done": 0, "total": 0, "overdue": 0})
            if status == "na":
                continue
            c["total"] += n
            if status == "done":
                c["done"] += n
            else:
                c["overdue"] += int(overdue or 0)
    # 6. What each still holds (routers/items.return_pending_rows - three queries).
    from routers.items import return_pending_rows
    held = return_pending_rows(db, emails)
    # 7. Direct reports still reporting to them, one query.
    reports = {}
    if emails:
        from sqlalchemy import func
        for mgr, in (db.query(func.lower(NexusEmployee.manager_email))
                     .filter(func.lower(NexusEmployee.manager_email).in_(emails),
                             NexusEmployee.status != "offboarded").all()):
            reports[mgr] = reports.get(mgr, 0) + 1
    ents = {e.id: e for e in db.query(HrEntity).all()}
    out = []
    for emp, ex in rows:
        em = (emp.work_email or "").strip().lower()
        st = st_rows.get((emp.id, ex["lastDay"]))
        status = st.status if st else "open"
        if status == "closed" and not include_closed:
            continue
        ent = ents.get(emp.company or "")
        ev = ex["event"]
        track = _track(emp, ex, ev, pk_ev.get(emp.id), parties, cls.get(emp.id), counts, held.get(em, []),
                       reports.get(em, 0), st, money, today)
        row = {"employeeId": emp.id, "email": em, "name": full_name(emp), "firstName": emp.first_name or "",
               "lastName": emp.last_name or "", "jobTitle": emp.job_title or "", "company": emp.company or "",
               "companyName": (ent.name if ent else "") or "", "lastDay": ex["lastDay"],
               "exitType": ex["exitType"],
               "exitTypeLabel": hr_life_events.SEPARATION_TYPES.get(ex["exitType"], "Left"),
               "stage": "Left" if ex["applied"] else "Leaving", "source": ex["source"],
               "eventId": ev.id if ev is not None else "", "scheduled": bool(ev is not None and not ex["applied"]),
               "closed": status == "closed", **track}
        if money:
            row.update({"statementStatus": status, "statementStatusLabel": STATUS_LABEL.get(status, status.title())})
        out.append(row)
    out.sort(key=lambda x: (x["lastDay"], x["name"].lower()))
    return out


def _chip(key: str, label: str, tone: str) -> dict:
    """One status chip on the tracker: tone warn (waiting on someone -
    yellow), done (green) or neutral (gray)."""
    return {"key": key, "label": label, "tone": tone}


def _package_state(emp: NexusEmployee, ev: HrLifeEvent | None, parties: dict) -> tuple:
    """(state, chip label): none | review | waiting_person | waiting_company | signed | declined."""
    first = (emp.first_name or "").strip() or "Them"
    if ev is None:
        return "none", "Package Not Sent"
    if ev.status == "declined":
        return "declined", "Package Declined"
    if ev.status in ("intake", "review"):
        return "review", "Package In Review"          # generated, waiting for HR to check it
    if ev.status in ("voided", "expired") \
            or (ev.status == "completed" and not (ev.sign_request_id or (ev.inputs or {}).get("paper_path"))):
        return "none", "Package Not Sent"
    if ev.status == "completed":
        return "signed", "Package Signed"
    subject = (ev.subject_email or "").strip().lower()
    mine = [p for p in parties.get(ev.sign_request_id, []) if (p.email or "").strip().lower() == subject]
    if mine and all(p.status in ("signed", "approved", "acknowledged") for p in mine):
        return "waiting_company", "Waiting On Countersign"
    if ev.status == "awaiting_sender" and not mine:
        return "waiting_company", "Waiting On Countersign"
    return "waiting_person", f"Waiting On {first}"


def _track(emp, ex, ev, pk, parties, cl, counts, held, n_reports, st, money, today) -> dict:
    chips = []
    pstate, plabel = _package_state(emp, pk, parties)
    chips.append(_chip("package", plabel, {"signed": "done", "none": "neutral"}.get(pstate, "warn")))
    if cl is not None:
        c = counts.get(cl.id, {"done": 0, "total": 0, "overdue": 0})
        tone = "done" if c["total"] and c["done"] >= c["total"] else "warn" if c["overdue"] else "neutral"
        chips.append(_chip("checklist", f"Checklist {c['done']}/{c['total']}", tone))
        checklist = {"id": cl.id, **c}
    else:
        chips.append(_chip("checklist", "No Checklist", "neutral"))
        checklist = {"id": "", "done": 0, "total": 0, "overdue": 0}
    to_return = len(held)
    settled = any(h.get("action") in ("item_received", "item_lost") for h in ((st.history if st else None) or []))
    back = not to_return and (settled or int((_left_entry(emp) or {}).get("itemsReturnPending") or 0) > 0)
    chips.append(_chip("items", f"{to_return} To Return" if to_return else "Items Back" if back else "No Items",
                       "warn" if to_return else "done" if back else "neutral"))
    flags = [(f or {}) for f in ((ev.flags if ev is not None else None) or [])]
    issues = [f for f in flags if f.get("code") in ISSUE_CODES]
    if issues:
        chips.append(_chip("access", "M365 Issue", "warn"))
    elif ex["applied"]:
        chips.append(_chip("access", "Access Ended", "done"))
    else:
        morning = (date.fromisoformat(ex["lastDay"]) + timedelta(days=1)).isoformat()
        chips.append(_chip("access", f"Access Ends {morning[5:7]}/{morning[8:10]}", "neutral"))
    if n_reports:
        chips.append(_chip("reports", f"{n_reports} Need{'s' if n_reports == 1 else ''} A Manager", "warn"))
    mbx = mailbox_handover(ev)
    if mbx and mbx["pending"]:
        chips.append(_chip("mailbox", "Mailbox Handover Pending", "warn"))
    if money:
        status = st.status if st else "open"
        since = [h for h in ((st.history if st else None) or []) if h.get("action") in ("reviewed", "egnyte_filed", "egnyte_failed")]
        eg_failed = bool(st) and status == "reviewed" and bool(st.generated_at) and bool(since) \
            and since[-1].get("action") == "egnyte_failed"
        if status == "filed":
            chips.append(_chip("settlement", "Settlement Filed", "done"))
        elif eg_failed:
            chips.append(_chip("settlement", "Egnyte Copy Failed", "warn"))
        elif status == "reviewed":
            chips.append(_chip("settlement", "Settlement Reviewed", "neutral"))
        elif status == "closed":
            chips.append(_chip("settlement", "Exit Closed", "neutral"))
        else:
            chips.append(_chip("settlement", "Settlement Open", "neutral"))
    return {"chips": chips, "package": {"state": pstate, "label": plabel, "eventId": pk.id if pk is not None else "",
                                        "status": pk.status if pk is not None else ""},
            "checklist": checklist, "itemsToReturn": to_return, "reportsToMove": n_reports,
            "mailboxPending": bool(mbx and mbx["pending"]), "issues": [i.get("message", "") for i in issues]}


# ── The statement ────────────────────────────────────────────────────────────

def _state_of(db: Session, emp: NexusEmployee, policy_id: str) -> str:
    """The state whose separation rules apply: California for people on the
    CA rule (leave_balances' us-ca policy - the 'ca' overtime rule on their
    pay rate); otherwise the company's state (HrEntity.region)."""
    if policy_id == "us-ca":
        return "CA"
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company or "")).first() if emp.company else None
    return ((ent.region if ent else "") or "").strip().upper()


def _hourly_rate(db: Session, email: str, day: str) -> tuple[float, str, str]:
    """(rate per hour, currency, how) in effect on `day`. A fixed salary is
    turned into an hourly rate over a 2,080-hour year."""
    from routers import timeclock as tc
    r = tc._rate_on(db, email, day)
    cur = (r.get("currency") or "USD").upper()
    if (r.get("payType") or "hourly") == "fixed":
        monthly = float(r.get("monthlySalary") or 0)
        return r2(monthly * 12 / 2080), cur, "Monthly salary x 12 / 2,080 hours"
    return r2(r.get("hourlyRate")), cur, "Hourly rate"


def _timesheet(db: Session, email: str, last_day: str) -> dict:
    import timesheet_review as tsr
    from routers import timeclock as tc
    if not email:
        return {"status": "no_email", "statusLabel": TS_LABEL["no_email"]}
    if tc.is_time_tracking_exempt(db, email):
        return {"status": "exempt", "statusLabel": TS_LABEL["exempt"]}
    s, e, pt = tsr.period_for(db, email, last_day)
    fin = tc._finalized_row(db, email, s, e)
    r = tsr.active_review(db, email, s)
    status = "finalized" if fin else ((r.status if r and r.status in TS_LABEL else "") or "not_started")
    out = {"status": status, "statusLabel": TS_LABEL.get(status, status.replace("_", " ").title()),
           "periodStart": s, "periodEnd": e, "payType": pt, "finalized": bool(fin),
           "link": {"view": "hr", "sub": "hr-time", "timecard": email, "start": s, "payType": pt}}
    # Earlier periods still open (worked, not finalized) - payroll needs them too.
    earlier, d = [], s
    for _ in range(3):
        d = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        ps, pe, _p = tsr.period_for(db, email, d)
        if not tc._finalized_row(db, email, ps, pe) and tsr.day_minutes(tsr.card_for(db, email, ps, pe, _p), _p):
            earlier.append({"periodStart": ps, "periodEnd": pe})
        d = ps
    out["earlierOpen"] = earlier
    return out


def _final_card(db: Session, email: str, ts: dict) -> dict:
    import timesheet_review as tsr
    return tsr.card_for(db, email, ts["periodStart"], ts["periodEnd"], ts["payType"])


def _open_card_repayments(card: dict | None, ts: dict) -> dict:
    """{advance id: what the final period's OPEN card takes} - a finalized
    period already recorded its installments as repaid (deducted), so only
    an open card's lines are still to be taken off the balance."""
    if not card or ts.get("finalized"):
        return {}
    out = {}
    for ln in card.get("advanceRepayments") or []:
        if ln.get("status") == "scheduled" and float(ln.get("applied") or 0) > 0:
            out[ln["advanceId"]] = r2(out.get(ln["advanceId"], 0) + float(ln["applied"]))
    return out


def _pay_of_final(db: Session, email: str, ts: dict, card: dict | None = None) -> dict:
    card = card if card is not None else _final_card(db, email, ts)
    t = card.get("totals") or {}
    out = {"grossPay": r2(t.get("totalPay")), "currency": card.get("currency") or ""}
    if "advanceRepayment" in t:
        out.update({"advanceRepayment": r2(t["advanceRepayment"]), "netPay": r2(t["netPay"])})
    return out


def _leave(db: Session, emp: NexusEmployee, email: str, last_day: str, show_money: bool) -> dict:
    import leave_balances
    lb = leave_balances.balances(db, email, emp=emp)
    pol = lb.get("policy") or {}
    hpd = float(pol.get("hoursPerDay") or 8) or 8.0
    state = _state_of(db, emp, pol.get("id") or "")
    law = PAYOUT_REQUIRED_STATES.get(state, "")
    out = {"live": bool(lb.get("live")), "policyName": pol.get("name") or "", "state": state,
           "hoursPerDay": hpd, "buckets": [], "payouts": []}
    if not lb.get("live"):
        return out
    for key, label in (("vacation", "Vacation"), ("sick", "Sick")):
        b = lb.get(key) or {}
        hours = r2(b.get("available"))
        row = {"bucket": key, "label": label, "hours": hours, "days": r2(hours / hpd),
               "upcomingHours": r2(b.get("upcoming")), "payout": NOT_PAID}
        if key == "vacation" and law:
            row["payout"] = law
            line = {"bucket": key, "label": "Vacation Payout", "flag": law, "hours": max(0.0, hours)}
            if show_money:
                rate, cur, how = _hourly_rate(db, email, last_day)
                line.update({"rate": rate, "currency": cur, "rateBasis": how,
                             "amount": r2(max(0.0, hours) * rate)})
            out["payouts"].append(line)
        out["buckets"].append(row)
    return out


def _reimbursements(db: Session, email: str, show_money: bool) -> dict:
    from routers.reimbursements import STATUS_LABEL as RL
    rows = (db.query(ExpenseReimbursement)
            .filter(ExpenseReimbursement.employee_email == email,
                    ExpenseReimbursement.status.in_(REIMB_OWED + REIMB_OPEN))
            .order_by(ExpenseReimbursement.created_at).all()) if email else []
    owed = []
    for r in rows:
        if r.status not in REIMB_OWED:
            continue
        item = {"id": r.id, "item": r.item or "", "status": r.status, "statusLabel": RL.get(r.status, r.status),
                "purchaseDate": r.purchase_date or ""}
        if show_money:
            item.update({"amount": r2(r.amount), "currency": r.currency or "USD"})
        owed.append(item)
    return {"owed": owed, "openCount": sum(1 for r in rows if r.status in REIMB_OPEN)}


def _advances(db: Session, email: str, show_money: bool, in_final_pay: dict | None = None) -> dict:
    """What is still to recover. `in_final_pay` ({advance id: amount}) is what
    the final period's open card already takes - the final pay's netPay
    counts it, so the balance here must not count it again."""
    import salary_advance as sa
    from models import SalaryAdvance
    out = [dict(x) for x in sa.outstanding(db, email)] if email else []
    for x in out:
        took = r2(min(float(x["balance"]), float((in_final_pay or {}).get(x["id"], 0))))
        if took > 0:
            x["inFinalPay"] = took
            x["repaid"] = r2(x["repaid"] + took)
            x["balance"] = r2(max(0.0, x["balance"] - took))
    if not show_money:
        out = [{"id": x["id"], "paidOn": x["paidOn"]} for x in out]
    unpaid = (db.query(SalaryAdvance.id).filter(SalaryAdvance.employee_email == email,
                                                SalaryAdvance.status.in_(("requested", "approved"))).count()) if email else 0
    return {"toRecover": out, "notPaidOutCount": unpaid}


def _items(db: Session, user: dict, emp: NexusEmployee) -> dict:
    """What they still hold, through People's own Assets read (Items owns
    the data), and what was closed automatically when they were marked
    Left (the status change logs the counts)."""
    from routers.hr import employee_assets
    from routers.items import return_pending_rows
    got = employee_assets(emp.id, user=user, db=db)
    email = (emp.work_email or "").strip().lower()
    rows = return_pending_rows(db, [email]).get(email, []) if email else []
    by_item = {r["itemId"]: r for r in rows if r["kind"] == "assignment"}
    held = []
    for a in got.get("assignments") or []:
        r = by_item.get(a.get("id"), {})
        held.append({"name": a.get("name") or "", "serial": a.get("serial") or "", "kind": "Assigned",
                     "itemId": a.get("id") or "", "rowKind": "assignment" if r else "", "rowId": r.get("id", ""),
                     "returnPending": bool(r.get("returnPending")), "pictureRequired": True})
    for r in rows:
        if r["kind"] == "checkout":
            held.append({"name": r["itemName"], "serial": r["serial"], "kind": "Checked Out", "itemId": r["itemId"],
                         "rowKind": "checkout", "rowId": r["id"], "returnPending": r["returnPending"],
                         "pictureRequired": r["pictureRequired"]})
    entry = _left_entry(emp) or {}
    auto = entry.get("itemsReturned") or {}
    return {"held": held, "closedAtLeft": int(auto.get("checkouts") or 0) + int(auto.get("assignments") or 0),
            "returnPendingAtLeft": int(entry.get("itemsReturnPending") or 0)}


def _checklist(db: Session, emp: NexusEmployee) -> dict:
    cl = (db.query(HrChecklist).filter(HrChecklist.employee_id == emp.id, HrChecklist.kind == "offboarding",
                                       HrChecklist.status != "cancelled")
          .order_by(HrChecklist.created_at.desc()).first())
    if cl is None:
        return {"exists": False}
    items = db.query(HrChecklistItem).filter(HrChecklistItem.checklist_id == cl.id).all()
    live = [i for i in items if i.status != "na"]
    done = [i for i in live if i.status == "done"]
    today = _today()
    open_ = sorted((i for i in live if i.status != "done"), key=lambda i: (i.due_date or "9", i.title or ""))
    return {"exists": True, "id": cl.id, "status": cl.status, "done": len(done), "total": len(live),
            "overdue": sum(1 for i in open_ if i.due_date and i.due_date < today),
            "open": [{"title": i.title or "", "ownerRole": i.owner_role or "", "dueDate": i.due_date or ""}
                     for i in open_[:12]]}


def _summary(st: dict) -> dict:
    """Per currency: what is owed to the person, what is recovered from them."""
    owed, recover = {}, {}
    for p in st["leave"]["payouts"]:
        if "amount" in p:
            owed[p["currency"]] = r2(owed.get(p["currency"], 0) + p["amount"])
    for r in st["reimbursements"]["owed"]:
        if "amount" in r:
            owed[r["currency"]] = r2(owed.get(r["currency"], 0) + r["amount"])
    for a in st["advances"]["toRecover"]:
        if "balance" in a and a["balance"] > 0:
            recover[a["currency"]] = r2(recover.get(a["currency"], 0) + a["balance"])
    return {"owedToEmployee": owed, "toRecover": recover}


# The parts of the statement payroll acts on - a change in any of them makes
# a review stale. The checklist's progress is not one of them, and neither
# are the items (11/14/2026): becoming Left moves them to Return Pending, and
# a review done before the last day must not go stale for that.
_FINGERPRINT_KEYS = ("lastDay", "timesheet", "finalPay", "leave", "reimbursements", "advances")


def fingerprint(st: dict) -> str:
    body = {k: st.get(k) for k in _FINGERPRINT_KEYS}
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


def build(db: Session, user: dict, emp: NexusEmployee, show_money: bool) -> dict:
    """The live statement for one leaver (raises ValueError when they are
    not leaving)."""
    import hr_life_events
    ex = exit_of(db, emp)
    if not ex or not ex["lastDay"]:
        raise ValueError("No exit in progress for this person.")
    email = (emp.work_email or "").strip().lower()
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company or "")).first() if emp.company else None
    ts = _timesheet(db, email, ex["lastDay"])
    card = _final_card(db, email, ts) if (show_money and ts.get("periodStart")) else None
    st = {"employeeId": emp.id, "email": email, "name": full_name(emp), "jobTitle": emp.job_title or "",
          "employeeCode": emp.employee_code or "", "employmentType": emp.employment_type or "",
          "startDate": emp.start_date or "", "company": emp.company or "",
          "companyName": ((ent.legal_name or ent.name) if ent else "") or "",
          "lastDay": ex["lastDay"], "exitType": ex["exitType"],
          "exitTypeLabel": hr_life_events.SEPARATION_TYPES.get(ex["exitType"], "Left"),
          "stage": "Left" if ex["applied"] else "Leaving", "eventId": ex.get("eventId", ""),
          "moneyShown": bool(show_money),
          "timesheet": ts,
          "leave": _leave(db, emp, email, ex["lastDay"], show_money),
          "reimbursements": _reimbursements(db, email, show_money),
          "advances": _advances(db, email, show_money, _open_card_repayments(card, ts)),
          "items": _items(db, user, emp),
          "checklist": _checklist(db, emp)}
    st["finalPay"] = _pay_of_final(db, email, ts, card) if card is not None else None
    st["summary"] = _summary(st)
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == ex["eventId"]).first() if ex.get("eventId") else None
    st["mailboxHandover"] = mailbox_handover(ev)
    st["issues"] = [{"code": f.get("code"), "message": f.get("message", "")} for f in ((ev.flags if ev else None) or [])
                    if (f or {}).get("code") in ISSUE_CODES]
    return st


def ser_row(db: Session, row: ExitStatement | None, live_fp: str, show_money: bool) -> dict:
    if row is None:
        return {"status": "open", "statusLabel": STATUS_LABEL["open"], "reviewStale": False, "history": []}
    from routers.reimbursements import _name as name_of
    stale = row.status in ("reviewed", "filed") and bool(row.fingerprint) and row.fingerprint != live_fp
    # Filed only once the Egnyte copy is in (11/14/2026): a PDF kept in Nexus
    # whose Egnyte copy failed says so, with Retry on the screen.
    since = [h for h in (row.history or []) if h.get("action") in ("reviewed", "egnyte_filed", "egnyte_failed")]
    eg = since[-1] if since else {}
    eg_failed = row.status == "reviewed" and bool(row.generated_at) and eg.get("action") == "egnyte_failed"
    label = "Filed in Nexus - Egnyte Copy Failed" if eg_failed else STATUS_LABEL.get(row.status, row.status.title())
    return {"id": row.id, "status": row.status, "statusLabel": label,
            "egnyteFailed": eg_failed, "egnyteError": (eg.get("note") or "") if eg_failed else "",
            "reviewedByName": name_of(db, row.reviewed_by) if row.reviewed_by else "", "reviewedAt": row.reviewed_at or "",
            "reviewedBy": row.reviewed_by or "",
            "reviewStale": stale, "documentId": (row.document_id or "") if show_money else "",
            "generatedAt": row.generated_at or "", "egnytePath": row.egnyte_path or "",
            "closedAt": row.closed_at or "",
            "history": [{**h, "byName": name_of(db, h.get("by", "")) if h.get("by") else ""} for h in (row.history or [])]}


# ── The PDF ──────────────────────────────────────────────────────────────────

def _t(text: str, bold: bool = False) -> dict:
    node = {"type": "text", "text": str(text or "-") or "-"}
    if bold:
        node["marks"] = [{"type": "bold"}]
    return node


def _p(*runs) -> dict:
    return {"type": "paragraph", "content": [r if isinstance(r, dict) else _t(r) for r in runs]}


def _h(text: str, level: int = 2) -> dict:
    return {"type": "heading", "attrs": {"level": level}, "content": [_t(text)]}


def _table(head: list, rows: list) -> dict:
    def row(cells, bold=False):
        return {"type": "tableRow", "content": [{"type": "tableCell", "content": [_p(_t(c, bold))]} for c in cells]}
    return {"type": "table", "content": [row(head, True)] + [row(r) for r in rows]}


def letterhead_for(db: Session, company: str) -> str:
    """The company's separation package letterhead, else any of its packets',
    else the default letterhead ('' = none)."""
    from models import DocLetterhead, HrPacketSetting
    for q in (db.query(HrPacketSetting).filter(HrPacketSetting.entity_id == company, HrPacketSetting.event == "separation",
                                               HrPacketSetting.letterhead_id != ""),
              db.query(HrPacketSetting).filter(HrPacketSetting.entity_id == company, HrPacketSetting.letterhead_id != "")):
        s = q.first() if company else None
        if s is not None and db.query(DocLetterhead.id).filter(DocLetterhead.id == s.letterhead_id).first():
            return s.letterhead_id
    lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    return lh.id if lh else ""


def content(st: dict, reviewed_by: str, reviewed_at: str, letterhead: bool) -> dict:
    nodes = []
    if not letterhead:
        nodes.append(_h(st["companyName"] or "Final Settlement Statement", 2))
    nodes += [_h("Final Settlement Statement", 1),
              _p(_t("Employee: ", True), f"{st['name']}" + (f" ({st['employeeCode']})" if st["employeeCode"] else "")),
              _p(_t("Company: ", True), st["companyName"] or "-"),
              _p(_t("Job Title: ", True), st["jobTitle"] or "-"),
              _p(_t("Start Date: ", True), us_date(st["startDate"]) if st["startDate"] else "-"),
              _p(_t("Last Working Day: ", True), us_date(st["lastDay"])),
              _p(_t("Reason: ", True), st["exitTypeLabel"]),
              _p("This statement is information for payroll. Nexus does not run the final pay.")]
    ts = st["timesheet"]
    nodes.append(_h("Final Time Sheet"))
    if ts.get("periodStart"):
        rows = [[f"{us_date(ts['periodStart'])} - {us_date(ts['periodEnd'])}", ts["statusLabel"]]]
        rows += [[f"{us_date(x['periodStart'])} - {us_date(x['periodEnd'])}", "Not Finalized"] for x in ts.get("earlierOpen") or []]
        nodes.append(_table(["Pay Period", "Status"], rows))
    else:
        nodes.append(_p(ts.get("statusLabel") or "-"))
    fp = st.get("finalPay")
    if fp:
        cur = fp.get("currency") or ""
        lines = [["Gross pay on the final time sheet", money(fp["grossPay"], cur)]]
        if "advanceRepayment" in fp:
            lines += [["Salary Advance Repayment", f"-{money(fp['advanceRepayment'], cur)}"],
                      ["Net pay on the final time sheet", money(fp["netPay"], cur)]]
        nodes.append(_table(["Final Period", "Amount"], lines))
    lv = st["leave"]
    nodes.append(_h("Leave Balances"))
    if lv["live"]:
        nodes.append(_table(["Leave", "Hours", "Days", "Payout"],
                            [[b["label"], f"{b['hours']:,.2f}", f"{b['days']:,.2f}", b["payout"]] for b in lv["buckets"]]))
        for p in lv["payouts"]:
            if "amount" in p:
                nodes.append(_p(_t(f"{p['label']} ({p['flag']}): ", True),
                                f"{p['hours']:,.2f} h x {money(p['rate'], p['currency'])} per hour = "
                                f"{money(p['amount'], p['currency'])} ({p['rateBasis']})"))
        nodes.append(_p("Greens' leave policy is use it or lose it: unused leave is not paid out unless the law "
                        "requires it."))
    else:
        nodes.append(_p("Leave balances are not set up for this person."))
    rb = st["reimbursements"]
    nodes.append(_h("Approved Reimbursements Not Yet Paid"))
    if rb["owed"]:
        nodes.append(_table(["Expense", "Status", "Amount"],
                            [[r["item"], r["statusLabel"], money(r["amount"], r["currency"]) if "amount" in r else "-"]
                             for r in rb["owed"]]))
    else:
        nodes.append(_p("None."))
    if rb["openCount"]:
        nodes.append(_p(f"{rb['openCount']} more waiting for approval."))
    ad = st["advances"]
    nodes.append(_h("Salary Advance To Recover"))
    if ad["toRecover"]:
        nodes.append(_table(["Paid Out", "Advance", "Repaid", "Balance To Recover"],
                            [[us_date(a["paidOn"]), money(a.get("amount"), a.get("currency")),
                              money(a.get("repaid"), a.get("currency")), money(a.get("balance"), a.get("currency"))]
                             if "balance" in a else [us_date(a["paidOn"]), "-", "-", "-"] for a in ad["toRecover"]]))
    else:
        nodes.append(_p("None."))
    it = st["items"]
    nodes.append(_h("Company Items"))
    if it["held"]:
        nodes.append(_table(["Item", "Serial", "Held As"], [[x["name"], x["serial"] or "-", x["kind"]] for x in it["held"]]))
    else:
        nodes.append(_p("No company items held."))
    if any(x.get("returnPending") for x in it["held"]):
        nodes.append(_p("Items still out when they left are Return Pending until they are received or "
                        "reported lost."))
    cl = st["checklist"]
    nodes.append(_h("Offboarding Checklist"))
    nodes.append(_p(f"{cl['done']} of {cl['total']} steps done" + (f", {cl['overdue']} overdue" if cl.get("overdue") else "")
                    if cl.get("exists") else "No offboarding checklist."))
    sm = st["summary"]
    if sm["owedToEmployee"] or sm["toRecover"]:
        nodes.append(_h("Summary"))
        rows = [["Owed to the employee", money(v, k)] for k, v in sorted(sm["owedToEmployee"].items())]
        rows += [["To recover from the employee", money(v, k)] for k, v in sorted(sm["toRecover"].items())]
        nodes.append(_table(["Line", "Amount"], rows))
    nodes.append(_p(f"Reviewed by {reviewed_by} on {us_date(reviewed_at)}."))
    return {"body": {"type": "doc", "content": nodes}}


def render_pdf(db: Session, st: dict, reviewed_by: str, reviewed_at: str) -> bytes:
    from models import Document
    from routers.documents import render_document
    lh = letterhead_for(db, st["company"])
    row = Document(id="preview", title=f"Final Settlement Statement - {st['name']}",
                   content=content(st, reviewed_by, reviewed_at, bool(lh)), letterhead_id=lh,
                   employee_id=st["employeeId"], entity_id=st["company"], merge_overrides={})
    return render_document(db, row, {})


def file_name(st: dict) -> str:
    import re
    who = re.sub(r'[\\/:*?"<>|]+', " ", st["name"]).strip()
    t = _today()                        # US dates in a file name too: MM-DD-YYYY
    return f"{t[5:7]}-{t[8:10]}-{t[:4]} - {who} - Final Settlement Statement.pdf"


def file_to_egnyte(db: Session, row: ExitStatement, emp: NexusEmployee, blob: bytes, name: str) -> tuple:
    """The person's Egnyte folder, in its Confidential subfolder (it carries
    pay). ONE copy per statement (11/14/2026): a statement filed before is
    written over at the path it went to (Egnyte keeps the old version),
    never a second file. (ok, path or the reason); sets row.egnyte_path, the
    caller commits. Called from a sync route (the threadpool), never the
    event loop."""
    try:
        import egnyte_wiring
        from services import egnyte as svc
        path = row.egnyte_path or ""
        if not path:
            folder = egnyte_wiring.provision_person_folder(emp, db)
            if not folder:
                return False, "their Egnyte folder could not be found or made"
            path = f"/{folder.strip('/')}/Confidential/{name}"
        svc.upload_file(path, blob)
        row.egnyte_path = path
        return True, path
    except Exception as e:  # noqa: BLE001 - said on the statement, never lost
        print(f"[exit-statement] Egnyte filing failed for {row.id}: {type(e).__name__}: {e}")
        return False, f"{type(e).__name__}: {str(e)[:160]}"


def new_row(emp: NexusEmployee, st: dict) -> ExitStatement:
    now = _now()
    return ExitStatement(id=str(uuid.uuid4()), employee_id=emp.id, employee_email=st["email"],
                         company=emp.company or "", event_id=st.get("eventId", ""), last_day=st["lastDay"],
                         status="open", history=[], created_at=now, updated_at=now)
