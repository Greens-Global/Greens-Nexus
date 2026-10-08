"""Find (and, only when asked, renumber) tasks and tickets that share a code.

Release step for the never-repeating counter (code_sequence.py, Oct 2026).
The old generators could hand one code to two rows - tickets on a concurrent
create, tasks after any delete or trash - so before the unique indexes go on,
every existing duplicate has to be given a fresh number.

READ-ONLY BY DEFAULT. Run against the database in DATABASE_URL:

    cd backend
    DATABASE_URL=... python check_code_duplicates.py          # report only
    DATABASE_URL=... python check_code_duplicates.py --fix    # renumber

A report lists every code held by more than one row (trashed tasks included -
they can be restored, so they still own their code). Ticket codes are compared
by NUMBER, so legacy "TKT-012" and "000012" count as the same ticket number,
because both are shown as "Ticket #12".

--fix keeps the OLDEST row of each group on its code (created_at, then id)
and gives every other row the next number from the counter, then prints
old -> new for each change so the people who know those numbers can be told.
Nothing else is touched: logs, emails and comments that quoted the old code
keep quoting it.

When the report comes back clean, the unique indexes printed at the end can
be created (see the PR's release steps).
"""
import argparse
import sys
from collections import defaultdict

import database
import models
import code_sequence
from ticket_code import digits_of

INDEX_SQL = (
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_code ON tasks (code) WHERE code <> '';",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_task_tickets_code ON task_tickets (code) WHERE code <> '';",
)


def _order(row):
    return (row.created_at or "", row.id)


def task_duplicates(db):
    groups = defaultdict(list)
    rows = (db.query(models.Task).execution_options(include_deleted=True).all())
    for t in rows:
        code = (t.code or "").strip()
        if code:
            groups[code.upper()].append(t)
    return {k: sorted(v, key=_order) for k, v in groups.items() if len(v) > 1}


def ticket_duplicates(db):
    groups = defaultdict(list)
    for t in db.query(models.TaskTicket).all():
        code = (t.code or "").strip()
        if not code:
            continue
        n = digits_of(code)
        groups[n if n else code].append(t)
    return {k: sorted(v, key=_order) for k, v in groups.items() if len(v) > 1}


def _report(label, dups, show):
    extra = sum(len(v) - 1 for v in dups.values())
    print(f"{label}: {len(dups)} code(s) shared, {extra} row(s) would be renumbered")
    for key, rows in sorted(dups.items(), key=lambda kv: str(kv[0])):
        print(f"  {show(key)}")
        for i, r in enumerate(rows):
            keep = "keep" if i == 0 else "renumber"
            print(f"    [{keep}] id={r.id} code={r.code!r} created_at={r.created_at!r}")
    return extra


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--fix", action="store_true",
                    help="renumber the duplicates (default: report only, nothing written)")
    args = ap.parse_args(argv)

    db = database.SessionLocal()
    try:
        tdups = task_duplicates(db)
        kdups = ticket_duplicates(db)
        n_tasks = _report("Tasks", tdups, lambda k: k)
        n_tickets = _report("Tickets", kdups,
                            lambda k: f"Ticket #{k}" if isinstance(k, int) else repr(k))

        if not args.fix:
            print("\nDry run - nothing was changed.")
            if n_tasks or n_tickets:
                print("Re-run with --fix to renumber, then create the unique indexes.")
            else:
                print("No duplicates. The unique indexes can be created:")
                for sql in INDEX_SQL:
                    print("  " + sql)
            return 0 if not (n_tasks or n_tickets) else 1

        changes = []
        for rows in tdups.values():
            for r in rows[1:]:
                new = code_sequence.next_task_code(db)
                changes.append(("task", r.id, r.code, new))
                r.code = new
                db.flush()   # the next allocation's in-use check must see it
        for rows in kdups.values():
            for r in rows[1:]:
                new = code_sequence.next_ticket_code(db)
                changes.append(("ticket", r.id, r.code, new))
                r.code = new
                db.flush()
        db.commit()
        for kind, rid, old, new in changes:
            print(f"renumbered {kind} {rid}: {old} -> {new}")
        print(f"\n{len(changes)} row(s) renumbered. Run again without --fix to confirm "
              f"it is clean, then create the unique indexes.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
