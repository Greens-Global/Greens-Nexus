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


def log(st: ExitStatement, by: str, action: str, note: str = "") -> None:
    st.history = list(st.history or []) + [{"at": _now(), "by": by, "action": action, "note": note}]
    st.updated_at = _now()


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


def exits_in_progress(db: Session, scope, include_closed: bool = False) -> list[dict]:
    """Everyone leaving inside `scope` (routers/hr.hr_scope), soonest last
    day first: scheduled exits, and applied ones from the last
    EXIT_WINDOW_DAYS that HR has not closed."""
    from routers.hr import _in_scope
    floor = (date.fromisoformat(_today()) - timedelta(days=EXIT_WINDOW_DAYS)).isoformat()
    ids = {r.employee_id for r in db.query(HrLifeEvent.employee_id)
           .filter(HrLifeEvent.kind == "separation", HrLifeEvent.apply_status.in_(("scheduled", "applied"))).all()}
    emps = (db.query(NexusEmployee)
            .filter((NexusEmployee.id.in_(list(ids))) | (NexusEmployee.status == "offboarded")).all()) if ids else \
        db.query(NexusEmployee).filter(NexusEmployee.status == "offboarded").all()
    ents = {e.id: e for e in db.query(HrEntity).all()}
    out = []
    for emp in emps:
        if not _in_scope(emp, scope):
            continue
        ex = exit_of(db, emp)
        if not ex or not ex["lastDay"]:
            continue
        if ex["applied"] and ex["lastDay"] < floor:
            continue
        st = _statement_row(db, emp, ex["lastDay"])
        status = st.status if st else "open"
        if status == "closed" and not include_closed:
            continue
        ent = ents.get(emp.company or "")
        import hr_life_events
        out.append({"employeeId": emp.id, "email": (emp.work_email or "").lower(), "name": full_name(emp),
                    "jobTitle": emp.job_title or "", "company": emp.company or "",
                    "companyName": (ent.name if ent else "") or "", "lastDay": ex["lastDay"],
                    "exitType": ex["exitType"],
                    "exitTypeLabel": hr_life_events.SEPARATION_TYPES.get(ex["exitType"], "Left"),
                    "stage": "Left" if ex["applied"] else "Leaving", "source": ex["source"],
                    "statementStatus": status, "statementStatusLabel": STATUS_LABEL.get(status, status.title())})
    out.sort(key=lambda x: (x["lastDay"], x["name"].lower()))
    return out


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


def _pay_of_final(db: Session, email: str, ts: dict) -> dict:
    import timesheet_review as tsr
    card = tsr.card_for(db, email, ts["periodStart"], ts["periodEnd"], ts["payType"])
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


def _advances(db: Session, email: str, show_money: bool) -> dict:
    import salary_advance as sa
    from models import SalaryAdvance
    out = [dict(x) for x in sa.outstanding(db, email)] if email else []
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
    got = employee_assets(emp.id, user=user, db=db)
    held = ([{"name": a.get("name") or "", "serial": a.get("serial") or "", "kind": "Assigned"}
             for a in got.get("assignments") or []]
            + [{"name": c.get("itemName") or "", "serial": "", "kind": "Checked Out"}
               for c in got.get("checkouts") or []])
    auto = ((_left_entry(emp) or {}).get("itemsReturned") or {})
    return {"held": held, "closedAtLeft": int(auto.get("checkouts") or 0) + int(auto.get("assignments") or 0)}


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
        if "balance" in a:
            recover[a["currency"]] = r2(recover.get(a["currency"], 0) + a["balance"])
    return {"owedToEmployee": owed, "toRecover": recover}


# The parts of the statement payroll acts on - a change in any of them makes
# a review stale. The checklist's progress is not one of them.
_FINGERPRINT_KEYS = ("lastDay", "timesheet", "finalPay", "leave", "reimbursements", "advances", "items")


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
          "advances": _advances(db, email, show_money),
          "items": _items(db, user, emp),
          "checklist": _checklist(db, emp)}
    st["finalPay"] = _pay_of_final(db, email, ts) if (show_money and ts.get("periodStart")) else None
    st["summary"] = _summary(st)
    return st


def ser_row(db: Session, row: ExitStatement | None, live_fp: str, show_money: bool) -> dict:
    if row is None:
        return {"status": "open", "statusLabel": STATUS_LABEL["open"], "reviewStale": False, "history": []}
    from routers.reimbursements import _name as name_of
    stale = row.status in ("reviewed", "filed") and bool(row.fingerprint) and row.fingerprint != live_fp
    return {"id": row.id, "status": row.status, "statusLabel": STATUS_LABEL.get(row.status, row.status.title()),
            "reviewedByName": name_of(db, row.reviewed_by) if row.reviewed_by else "", "reviewedAt": row.reviewed_at or "",
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
    if it["closedAtLeft"]:
        nodes.append(_p(f"{it['closedAtLeft']} item(s) were closed automatically when they were marked Left - "
                        f"confirm they came back."))
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
    return f"{_today()} - {who} - Final Settlement Statement.pdf"


def file_to_egnyte(statement_id: str, blob: bytes, name: str) -> None:
    """Best-effort, on its own thread and session: the person's Egnyte
    folder, in its Confidential subfolder (it carries pay)."""
    from database import SessionLocal
    try:
        import egnyte_wiring
        from services import egnyte as svc
        db = SessionLocal()
        try:
            row = db.query(ExitStatement).filter(ExitStatement.id == statement_id).first()
            emp = db.query(NexusEmployee).filter(NexusEmployee.id == row.employee_id).first() if row else None
            folder = egnyte_wiring.provision_person_folder(emp, db) if emp else ""
            if not folder:
                return
            path = f"/{folder.strip('/')}/Confidential/{name}"
            svc.upload_file(path, blob)
            row.egnyte_path = path
            db.commit()
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 - filing never fails the statement
        print(f"[exit-statement] Egnyte filing failed for {statement_id}: {type(e).__name__}: {e}")


def new_row(emp: NexusEmployee, st: dict) -> ExitStatement:
    now = _now()
    return ExitStatement(id=str(uuid.uuid4()), employee_id=emp.id, employee_email=st["email"],
                         company=emp.company or "", event_id=st.get("eventId", ""), last_day=st["lastDay"],
                         status="open", history=[], created_at=now, updated_at=now)
