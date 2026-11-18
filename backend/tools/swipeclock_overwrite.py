"""SwipeClock is the record through 10/16/2026 (Charmi, 11/11/2026): replace
the Nexus punches on every day SwipeClock holds, then close the periods out.

"We had discussed that as of 10/16 all the data will be taken from Swipeclock
and overwritten in Nexus" / "time cards were not used from nexus for this pay
period. Anything before 10/16 should be from Swipeclock." The 11/02 history
import (swipeclock_punch_import.py) loaded only the days BEFORE each person's
first Nexus punch; from that day to 10/16 Nexus still held its own punches,
which disagree with what payroll paid. This finishes it, per person:

  1. Unlock: every finalized period that holds a day being replaced is
     unfinalized the way HR's Unlock does it (the final row revoked, its leave
     rows, draft contractor invoice and salary-advance repayments taken back).
  2. Replace: on each day SwipeClock has time for, from the person's first
     Nexus day to --end, the Nexus punches are voided (kept, carrying
     replaced_by_batch) and SwipeClock's pairs are written - ONE Add Time From
     Record batch per person, so the time sheet's Undo restores that person.
     A day only Nexus has is never touched; it is listed for HR to confirm.
  3. Close out: each replaced period, and every period that ended before
     10/04/2026 still asking someone (closeout_swipeclock_periods.plan), is
     finalized as "Processed in SwipeClock before Nexus" (HR's finalize
     without the employee's signature). The 10/04 - 10/17 period counts as
     paid in SwipeClock only for the people SwipeClock has time for in it;
     everyone else keeps that period's normal review and signature.

No notifications for steps 1-2 (housekeeping, not news); step 3 leaves the
same record the existing close-out does.

Dry run by default: steps 1-2 run inside a transaction that is rolled back,
so the report shows the real before / after hours per period; step 3 is only
listed (finalizing commits on its own). --apply writes it, one person per
commit, then the close-outs one period per commit.

    cd backend
    python tools/swipeclock_overwrite.py --mapping <names.json> --actor <hr email>            # dry run
    python tools/swipeclock_overwrite.py --mapping <names.json> --actor <hr email> --apply

<names.json> = {"Last, First": "work email", ...} for the SwipeClock names
(personal emails - keep it out of the repo). Uses DATABASE_URL like the app.
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
for p in (str(BACKEND), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

ROOT = BACKEND.parent
FILES = [str(ROOT / "payroll (1).txt"), str(ROOT / "payroll (2).txt")]
HISTORY_REASON = "SwipeClock punch history%"
NOTE = "SwipeClock record (payroll export) - replaces the Nexus punches for this day"
REASON = ("SwipeClock is the record of hours worked through 10/16/2026 (HR, 11/11/2026): the Nexus punches "
          "for these days were replaced with the SwipeClock payroll record.")
LAST_SWIPECLOCK_PERIOD_END = "2026-10-17"   # the 10/04 - 10/17 period was paid from SwipeClock


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _swipeclock(mapping: dict) -> dict:
    """{email: {day: [(in_at, out_at, out_local_date, tz_min, category, hours)]}}"""
    import swipeclock_punch_import as imp
    out: dict = defaultdict(lambda: defaultdict(list))
    for r in imp._load_rows(FILES):
        em = (mapping.get(r["EmployeeName"]) or "").lower()
        pair = imp._pair(r) if em else None
        if pair is None:
            continue
        d, in_at, out_at, out_ld, tz_min, cat, hours = pair
        out[em][d].append((in_at, out_at, out_ld, tz_min, cat, hours))
    return out


def _worked(db, em: str, s: str, e: str, pay_type: str) -> int:
    import timesheet_review as tsr
    return int((tsr.card_for(db, em, s, e, pay_type).get("totals") or {}).get("workedMin") or 0)


def _hm(m: int) -> str:
    return f"{m // 60}h {m % 60:02d}m"


def _unfinalize(db, row, actor: str) -> None:
    """HR's Unlock (routers/timeclock.unfinalize_timecard) minus the
    correction round - the period is finalized again in step 3."""
    import leave_balances
    import salary_advance
    from routers import contractor_invoices
    row.revoked = 1
    row.revoked_by = actor
    leave_balances.remove_period(db, row.id)
    contractor_invoices.void_for_final(db, row.id)
    salary_advance.on_unfinalize(db, row.id, actor)


def replace_person(db, em: str, sw_days: dict, end: str, actor: str) -> dict | None:
    """Steps 1-2 for one person (the caller commits or rolls back)."""
    import models
    import timesheet_review as tsr
    TP = models.TimePunch
    hist = {b.id for b in db.query(models.TimeEntryBatch).filter(
        models.TimeEntryBatch.employee_email == em, models.TimeEntryBatch.reason.like(HISTORY_REASON),
        models.TimeEntryBatch.undone_at == "").all()}
    nexus = [p for p in db.query(TP).filter(TP.employee_email == em, TP.voided == 0).all()
             if (p.batch_id or "") not in hist]
    if not nexus:
        return None
    first = min(p.local_date for p in nexus if p.local_date)
    days = sorted(d for d in sw_days if first <= d <= end)
    nexus_days = {p.local_date for p in nexus if first <= (p.local_date or "") <= end}
    info = {"first": first, "days": days, "nexusOnly": sorted(nexus_days - set(days)),
            "periods": [], "unlocked": [], "batch": ""}
    if not days:
        return info
    periods = sorted({tsr.period_for(db, em, d) for d in days})
    before = {(s, e): _worked(db, em, s, e, pt) for s, e, pt in periods}
    for s, e, _pt in periods:
        for row in db.query(models.TimeApproval).filter(
                models.TimeApproval.employee_email == em, models.TimeApproval.revoked == 0,
                models.TimeApproval.kind == "final", models.TimeApproval.period_start <= e,
                models.TimeApproval.period_end >= s).all():
            _unfinalize(db, row, actor)
            info["unlocked"].append((row.period_start, row.period_end))
    now = _now()
    batch_id = "dup-" + str(uuid.uuid4())
    day_set = set(days)
    replaced = 0
    for p in nexus:
        if p.local_date in day_set:
            p.voided = 1
            p.adjusted_by = actor
            p.adjusted_at = now
            p.adjust_note = f"Replaced by Add Time From Record: {REASON[:250]}"
            p.replaced_by_batch = batch_id
            replaced += 1
    minutes = 0
    for d in days:
        for in_at, out_at, out_ld, tz_min, cat, hours in sw_days[d]:
            minutes += int(round(hours * 60))
            db.add(TP(id=str(uuid.uuid4()), employee_email=em, kind="in", at=in_at, local_date=d,
                      tz_offset_min=tz_min, geo_status="no_location", note=NOTE, source="manual",
                      category=cat[:80], created_by=actor, created_at=now, batch_id=batch_id,
                      entry_source="hr_record"))
            db.add(TP(id=str(uuid.uuid4()), employee_email=em, kind="out", at=out_at, local_date=out_ld,
                      tz_offset_min=tz_min, geo_status="no_location", note=NOTE, source="manual",
                      category="", created_by=actor, created_at=now, batch_id=batch_id,
                      entry_source="hr_record"))
    db.add(models.TimeEntryBatch(id=batch_id, employee_email=em, kind="hr_record", reason=REASON,
                                 range_start=days[0], range_end=days[-1], days=days, minutes=minutes,
                                 created_by=actor, created_at=now))
    db.add(models.AuditLog(timestamp=now, user_email=actor, user_role="", module="timeclock", kind="create",
                           action="Added time from a record", resource_type="time_entry_batches",
                           resource_id=batch_id,
                           details=json.dumps({"employee": em, "days": days, "minutes": minutes,
                                               "replaced": replaced, "reason": REASON[:300]})[:4000]))
    db.flush()
    info["batch"] = batch_id
    info["replacedPunches"] = replaced
    for s, e, pt in periods:
        info["periods"].append((s, e, before[(s, e)], _worked(db, em, s, e, pt)))
    return info


def close_out_list(db, touched: dict) -> list:
    """[(email, start, end, why)]: every period the replace touched (all end
    by 10/17), plus the existing close-out plan for periods before 10/04."""
    import closeout_swipeclock_periods as closeout
    todo = {(em, s): (e, why) for em, s, e, why in closeout.plan(db)}
    for em, info in touched.items():
        for s, e, *_ in info["periods"]:
            if e <= LAST_SWIPECLOCK_PERIOD_END:
                todo.setdefault((em, s), (e, "SwipeClock record replaced the Nexus punches"))
    return sorted(((em, s, e, why) for (em, s), (e, why) in todo.items()), key=lambda x: (x[0], x[1]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mapping", required=True, help='JSON {"Last, First": "email"} for the SwipeClock names')
    ap.add_argument("--actor", required=True, help="the HR / Super Administrator email it is recorded as")
    ap.add_argument("--end", default="2026-10-16", help="last day SwipeClock replaces (default 10/16/2026)")
    ap.add_argument("--apply", action="store_true", help="write it (default: dry run, nothing kept)")
    ap.add_argument("--closeout-only", action="store_true",
                    help="skip the replace; close out the periods of the batches an earlier --apply wrote")
    args = ap.parse_args()
    actor = args.actor.strip().lower()
    mapping = {k: v for k, v in json.loads(Path(args.mapping).read_text(encoding="utf-8")).items()
               if not k.startswith("_")}

    import database
    import timesheet_review as tsr
    from fastapi import HTTPException
    sw = _swipeclock(mapping)
    db = database.SessionLocal()
    try:
        print(f"{'APPLY' if args.apply else 'DRY RUN'} - SwipeClock replaces Nexus through {tsr.us_date(args.end)}\n")
        touched = {}
        if args.closeout_only:
            # The replace already ran (11/12/2026: the connection dropped before
            # the close-out); rebuild its periods from the batches it wrote.
            import models
            for b in db.query(models.TimeEntryBatch).filter(models.TimeEntryBatch.reason == REASON,
                                                            models.TimeEntryBatch.undone_at == "").all():
                ps = sorted({tsr.period_for(db, b.employee_email, d)[:2] for d in (b.days or [])})
                touched[b.employee_email] = {"periods": [(s, e) for s, e in ps]}
            sw = {}
        for em in sorted(sw):
            name = tsr.display_name(db, em)
            try:
                info = replace_person(db, em, sw[em], args.end, actor)
            except Exception:
                db.rollback()
                raise
            if info is None:
                print(f"{name} <{em}>: no Nexus punches - nothing to replace\n")
                db.rollback()
                continue
            if not info["days"]:
                print(f"{name} <{em}>: SwipeClock has no days from their first Nexus day "
                      f"({tsr.us_date(info['first'])}) - nothing replaced")
            else:
                touched[em] = info
                print(f"{name} <{em}>: {len(info['days'])} days replaced "
                      f"({tsr.us_date(info['days'][0])} - {tsr.us_date(info['days'][-1])}), "
                      f"{info['replacedPunches']} Nexus punches voided, batch {info['batch']}")
                for s, e in info["unlocked"]:
                    print(f"    unlocked finalized period {tsr.us_date(s)} - {tsr.us_date(e)}")
                for s, e, b, a in info["periods"]:
                    flag = "" if b == a else f"   ({'+' if a > b else '-'}{_hm(abs(a - b))})"
                    print(f"    {tsr.us_date(s)} - {tsr.us_date(e)}:  Nexus {_hm(b):>9}  ->  SwipeClock {_hm(a):>9}{flag}")
            if info["nexusOnly"]:
                print(f"    KEPT (Nexus only, SwipeClock has nothing): "
                      + ", ".join(tsr.us_date(d) for d in info["nexusOnly"]))
            print()
            if args.apply:
                db.commit()
            else:
                db.rollback()

        if not args.apply:
            # The close-out plan is read against the database as it is now -
            # the replace above was rolled back.
            pass
        todo = close_out_list(db, touched)
        print(f"Close out as \"{tsr.OUTSIDE_NEXUS_REASON}\": {len(todo)} period(s)")
        # The 10/04 - 10/17 period was paid from SwipeClock for these people
        # (Charmi, 11/11/2026); the cutoff moves for this run only.
        tsr.OUTSIDE_NEXUS_BEFORE = "2026-10-18"
        done = skipped = 0
        for em, s, e, why in todo:
            line = f"  {tsr.display_name(db, em)} <{em}>  {tsr.us_date(s)} - {tsr.us_date(e)}  ({why})"
            if not args.apply:
                print(line)
                continue
            try:
                r = tsr.close_out_outside_nexus(db, em, s, actor)
                db.commit()
                done += 1
                print(line + ("  closed out" if r is not None else "  already final"))
            except HTTPException as ex:
                db.rollback()
                skipped += 1
                print(line + f"  SKIPPED: {ex.detail}")
        if args.apply:
            print(f"\nClosed out {done}, skipped {skipped}.")
        else:
            print("\nDry run - nothing was kept. Add --apply to write it.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
