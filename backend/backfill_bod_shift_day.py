"""Re-date existing BOD/EOD messages to the shift they belong to (Oct 2).

Before shift_day.py, a message was filed under the calendar date it was SENT,
so a night shift's End-of-day (sent at 2:30 AM) sat on the next day. This
moves such rows to their shift's day - the same rule new messages now follow.

Only a message sent INSIDE a shift (or, for an EOD/break message, within
3 hours after the shift's clock-out) is touched, and only when that shift
began on a different day than the row says. Anything not inside a shift is
left exactly as it is. TimeBod.created_at - the real send time - is never
changed, so the move is visible and reversible from the data itself.

Dry run by default (prints what WOULD change); --apply writes it:

    python backfill_bod_shift_day.py              # dry run, uses DATABASE_URL
    python backfill_bod_shift_day.py --apply
"""
import argparse
from datetime import timedelta

import database
import models
import shift_day

GRACE_MIN = 180   # same as record_bod's EOD grace


def plan(db) -> list:
    """[(row, old_date, new_date)] for every row whose shift says otherwise."""
    changes = []
    rows = (db.query(models.TimeBod)
            .filter(models.TimeBod.kind.in_(("bod", "eod", "break", "break_end")))
            .order_by(models.TimeBod.employee_email, models.TimeBod.created_at).all())
    by_email = {}
    for r in rows:
        by_email.setdefault(r.employee_email, []).append(r)
    for email, mine in by_email.items():
        lo = (shift_day._ts(mine[0].created_at) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S")
        punches = (db.query(models.TimePunch)
                   .filter(models.TimePunch.employee_email == email, models.TimePunch.voided == 0,
                           models.TimePunch.kind.in_(("in", "out")), models.TimePunch.at >= lo)
                   .order_by(models.TimePunch.at.asc()).all())
        shifts = shift_day.shifts(punches)
        for r in mine:
            t = shift_day._ts(r.created_at)
            if not t:
                continue
            hit = shift_day.shift_for(punches, r.created_at)
            if hit is None and r.kind != "bod":
                for s in reversed(shifts):
                    tout = shift_day._ts(s["out_at"])
                    if s["in_at"] and tout and timedelta(0) <= t - tout <= timedelta(minutes=GRACE_MIN):
                        hit = s
                        break
            if hit and hit["day"] and hit["day"] != r.local_date:
                changes.append((r, r.local_date, hit["day"]))
    return changes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    args = ap.parse_args()
    db = database.SessionLocal()
    try:
        changes = plan(db)
        for r, old, new in changes[:50]:
            print(f"{r.employee_email:40} {r.kind:9} sent {r.created_at}Z  {old} -> {new}")
        if len(changes) > 50:
            print(f"... and {len(changes) - 50} more")
        print(f"{len(changes)} message(s) {'re-dated' if args.apply else 'would be re-dated'}.")
        if args.apply and changes:
            for r, _old, new in changes:
                r.local_date = new
            db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
