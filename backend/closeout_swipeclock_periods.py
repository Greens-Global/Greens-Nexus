"""Close out the time sheet periods paid in SwipeClock before Nexus (Charmi,
10/27 call item 10). FOR HR (Sagar) TO REVIEW AND RUN - nothing runs it on
its own.

"These notifications ... signature required, timesheet ... This has already
been passed and at that time we were still not using this system." Every pay
period that ENDED before 10/04/2026 was paid from SwipeClock, yet its Nexus
review kept asking: the old company-signed "Sign: Timesheet - <name> -
09/20/2026 - 10/03/2026" envelopes, "Review <name>'s Time Sheet" in the Daily
Briefing and the priority bar. This finalizes each of those periods through
HR's own Finalize Without Employee Signature steps
(timesheet_review.close_out_outside_nexus), with the reason "Processed in
SwipeClock before Nexus": the envelope is voided and logged, the approval row
and the review history carry the reason, the period is locked, and the
priority notices that pointed at it are marked done. The signature step is
not hidden or skipped for any period from 10/04/2026 on - those still go
through review and the employee's signature, and still notify as before.

What it picks, by default - only what still asks someone:
  * a review of a period that ended before 10/04/2026 that is not completed
    (with the manager, out for signature, approved, being corrected);
  * a closed period the reviewers' "not reviewed" list still shows (ended on
    or after the review launch, 10/01/2026, hours, no review, not finalized).
--all also takes every older unfinalized period with hours, back to the
first punch (the parallel-run weeks) - nobody is asked about those today.

Dry run by default (prints the plan, writes nothing); --apply writes it,
one period per commit, and a period that is refused (for instance the HR
person's OWN time sheet - another HR person closes that one) is reported
and skipped:

    python closeout_swipeclock_periods.py --actor hr.person@greensglobal.com          # dry run
    python closeout_swipeclock_periods.py --actor hr.person@greensglobal.com --apply

Uses DATABASE_URL like the app. Take a backup first; the result is undone
per person with HR's Unlock on the period, like any finalize.
"""
import argparse

from fastapi import HTTPException

import database
import models
import timesheet_review as tsr


def plan(db, *, every_period: bool = False) -> list:
    """[(email, start, end, why)] - each period to close out, oldest first."""
    cutoff = tsr.OUTSIDE_NEXUS_BEFORE
    tc = tsr._tc()
    out = {}
    for r in (db.query(models.TimesheetReview)
              .filter(models.TimesheetReview.period_end < cutoff,
                      models.TimesheetReview.status.notin_(("completed", "retired"))).all()):
        out[(r.employee_email, r.period_start)] = (r.period_end, f"review {r.status}" + (" with an envelope out" if r.sign_request_id else ""))
    emails = {e for (e,) in db.query(models.TimePunch.employee_email)
              .filter(models.TimePunch.voided == 0, models.TimePunch.local_date < cutoff).distinct()}
    for em in sorted(emails):
        days = {d for (d,) in db.query(models.TimePunch.local_date)
                .filter(models.TimePunch.employee_email == em, models.TimePunch.voided == 0,
                        models.TimePunch.local_date < cutoff).distinct() if d}
        periods = {tsr.period_for(db, em, d)[:2] for d in days}
        for s, e in periods:
            if e >= cutoff or (em, s) in out:
                continue
            if not every_period and e < tsr.REVIEW_LAUNCH:
                continue
            if tc._finalized_row(db, em, s, e):
                continue
            if db.query(models.TimesheetReview).filter(models.TimesheetReview.employee_email == em,
                                                       models.TimesheetReview.period_start == s,
                                                       models.TimesheetReview.status.in_(("completed",))).first():
                continue
            out[(em, s)] = (e, "not reviewed, not finalized")
    return sorted(((em, s, e, why) for (em, s), (e, why) in out.items()), key=lambda x: (x[1], x[0]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--actor", required=True, help="the HR person's work email - the close-out is recorded as theirs")
    ap.add_argument("--apply", action="store_true", help="write it (default: dry run)")
    ap.add_argument("--all", dest="every_period", action="store_true", help="also every older unfinalized period with hours")
    args = ap.parse_args()
    db = database.SessionLocal()
    try:
        todo = plan(db, every_period=args.every_period)
        print(f"{len(todo)} period(s) ended before {tsr.us_date(tsr.OUTSIDE_NEXUS_BEFORE)} to close out "
              f"as \"{tsr.OUTSIDE_NEXUS_REASON}\" ({'APPLY' if args.apply else 'dry run'}):")
        done = skipped = 0
        for em, s, e, why in todo:
            line = f"  {tsr.display_name(db, em)} <{em}>  {tsr.us_date(s)} - {tsr.us_date(e)}  ({why})"
            if not args.apply:
                print(line)
                continue
            try:
                tsr.close_out_outside_nexus(db, em, s, args.actor)
                db.commit()
                done += 1
                print(line + "  closed out")
            except HTTPException as ex:
                db.rollback()
                skipped += 1
                print(line + f"  SKIPPED: {ex.detail}")
        if args.apply:
            print(f"Closed out {done}, skipped {skipped}.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
