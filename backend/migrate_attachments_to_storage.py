"""Manual runner for the task-attachment backlog migration (task_files.py).

The deployed API drains the backlog automatically (attachment_migration_loop,
leader-elected, started from main.py's lifespan). This script is the laptop /
break-glass path - same batch function, run against whatever DB the env
points at:

    DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
        python migrate_attachments_to_storage.py [--dry-run] [--limit N] [--batch N]

Idempotent: migrated rows no longer match `data:%`, so re-running resumes.
Afterwards, reclaim the disk with (off-hours - exclusive lock):
    VACUUM FULL task_attachments;
"""
import argparse
import sys

from sqlalchemy import text

from database import SessionLocal
import task_files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report what would happen, change nothing")
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = all)")
    ap.add_argument("--batch", type=int, default=25, help="rows per transaction")
    args = ap.parse_args()

    if not args.dry_run and not task_files.storage_configured():
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY not set - refusing to run.")

    db = SessionLocal()
    total = db.execute(text(
        "SELECT count(*) FROM task_attachments WHERE url LIKE 'data:%'")).scalar() or 0
    print(f"{total} inlined attachment rows to migrate"
          + (f" (limiting to {args.limit})" if args.limit else ""))
    if args.dry_run:
        unlinked = db.execute(text(
            "SELECT count(*) FROM task_attachments a WHERE a.url LIKE 'data:%' AND NOT EXISTS "
            "(SELECT 1 FROM asana_attachment_links l WHERE l.nexus_attachment_id = a.id)")).scalar() or 0
        print(f"dry-run: {unlinked} of them would also get a push-suppression link marker")
        db.close()
        return

    done = 0
    failed_ids = set()
    while not args.limit or done < args.limit:
        migrated, new_failed, fetched = task_files.migrate_inlined_batch(
            db, args.batch, failed_ids)
        failed_ids.update(new_failed)
        done += migrated
        if fetched == 0:
            break
        print(f"  migrated {done}/{total} ({len(failed_ids)} undecodable)")

    remaining = db.execute(text(
        "SELECT count(*) FROM task_attachments WHERE url LIKE 'data:%'")).scalar() or 0
    print(f"done: {done} migrated, {len(failed_ids)} undecodable, {remaining} data: rows remaining")
    if remaining == 0 and done:
        print("all clear - run `VACUUM FULL task_attachments;` off-hours to reclaim the disk")
    db.close()


if __name__ == "__main__":
    main()
