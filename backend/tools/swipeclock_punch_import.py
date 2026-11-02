"""Load SwipeClock punch history (the payroll .txt exports) into Nexus.

The exports are per-punch-pair CSV rows ("PUNCH" records: one In/Out with a
Regular / Vacation / Sick category, rounded times and a per-row UTC offset).
Each pair becomes two `time_punches` rows written exactly the way Add Time
From Record writes them (routers/timeclock.duplicate_day): source 'manual',
entry_source 'hr_record', one 'dup-…' batch per employee recorded in
`time_entry_batches` (so a whole person's import can be undone as one) and
one audit_logs row per batch. No notifications are sent - two years of
history is not news.

Overlap rule: a person's history is imported ONLY for days strictly before
their first punch already in Nexus (the boundary). Days Nexus already ran -
including the periods under review right now - are never touched. People in
the export but not in Nexus (or marked skip in the mapping) are reported and
left out.

Pay periods the history lands in ended before timesheet_review's
OUTSIDE_NEXUS_BEFORE (10/04/2026), so they belong to the existing
"paid outside Nexus" close-out path, not the review queue.

Usage (from the repo root):
    python backend/tools/swipeclock_punch_import.py \
        --files "payroll (1).txt" "payroll (2).txt"            # dry run
    ... --commit                                               # write via the DB session
    ... --sql-out punches.sql [--boundaries boundaries.json]   # emit SQL instead
        (boundaries: {"email": "YYYY-MM-DD first Nexus day", ...} - required
         for --sql-out, where there is no DB to ask; with --commit it is
         computed from the database and the file is ignored.)

Dry-run by default; prints a per-person report either way.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

MAPPING = HERE / "swipeclock_name_mapping.json"
NOTE = "SwipeClock history (payroll export, loaded 11/02/2026)"
REASON = ("SwipeClock punch history from the payroll export - the record of "
          "hours worked before this person used the Nexus Time Clock.")


def _load_rows(files: list[str]) -> list[dict]:
    out = []
    for fn in files:
        with open(fn, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r.get("RecordType") != "PUNCH":
                    continue
                out.append(r)
    return out


def _pair(r: dict):
    """One file row -> (local_date, in_at, out_at, out_local_date,
    tz_offset_min, category, hours), or None for a zero-hours row. Times in
    the file are local and rounded; `at` is naive UTC ISO, the format the
    Time Clock stores.

    Hours is the authority on duration. Most rows' Out - In equals it (an
    overnight row's out is the next day), but SwipeClock also holds
    HOURS-ONLY entries - keyed hours with 12:00 AM stand-in times - where
    Out - In says 24 h or simply disagrees. Those become In .. In + Hours,
    so the day totals exactly what payroll paid."""
    d = r["PunchDate"]
    hours = float(r.get("Hours") or 0)
    if hours <= 0:
        return None
    off = int(r["UTCOffset"])                      # -8 (PST) / -7 (PDT)
    tz_min = -off * 60                             # JS getTimezoneOffset style
    t_in = datetime.strptime(f"{d} {r['InTime']}", "%Y-%m-%d %H:%M:%S")
    t_out = datetime.strptime(f"{d} {r['OutTime']}", "%Y-%m-%d %H:%M:%S")
    if t_out <= t_in:                              # overnight, or an hours-only entry
        t_out += timedelta(days=1)
    if abs((t_out - t_in).total_seconds() / 3600 - hours) > 0.26:
        t_out = t_in + timedelta(hours=hours)      # hours-only: trust the keyed hours
    in_at = (t_in - timedelta(hours=off)).strftime("%Y-%m-%dT%H:%M:%S")
    out_at = (t_out - timedelta(hours=off)).strftime("%Y-%m-%dT%H:%M:%S")
    cat = (r.get("Category") or "").strip()
    if cat.lower() == "regular":
        cat = ""
    return d, in_at, out_at, t_out.strftime("%Y-%m-%d"), tz_min, cat, hours


def _plan(files: list[str], mapping: dict, boundaries: dict) -> tuple[dict, list]:
    """-> ({email: {"rows": [...], "skipped_overlap": n, "name": ...}}, report)"""
    people: dict = {}
    report = []
    unmapped = defaultdict(int)
    for r in _load_rows(files):
        name = r["EmployeeName"]
        m = mapping.get(name)
        if not m or m.get("skip") or not m.get("email"):
            unmapped[name] += 1
            continue
        em = m["email"].lower()
        p = people.setdefault(em, {"name": name, "rows": [], "skipped_overlap": 0, "hours": 0.0})
        pair = _pair(r)
        if pair is None:
            continue
        d, in_at, out_at, out_ld, tz_min, cat, hours = pair
        boundary = boundaries.get(em, "")
        if boundary and d >= boundary:
            p["skipped_overlap"] += 1
            continue
        p["rows"].append((d, in_at, out_at, out_ld, tz_min, cat))
        p["hours"] += hours
    for name, n in sorted(unmapped.items()):
        report.append(f"SKIP   {name!r}: {n} rows - not mapped to a Nexus person (or marked skip)")
    for em, p in sorted(people.items()):
        days = sorted({d for d, *_ in p["rows"]})
        line = (f"WRITE  {em} ({p['name']}): {len(p['rows'])} pairs over {len(days)} days "
                f"({days[0]} .. {days[-1]}, {p['hours']:.2f} h)" if days else
                f"SKIP   {em} ({p['name']}): everything already in Nexus")
        if p["skipped_overlap"]:
            line += f"; {p['skipped_overlap']} pairs on/after their first Nexus day left out"
        report.append(line)
    return people, report


def _db_boundaries(db) -> dict:
    from sqlalchemy import func
    import models
    rows = (db.query(models.TimePunch.employee_email, func.min(models.TimePunch.local_date))
            .filter(models.TimePunch.voided == 0)
            .group_by(models.TimePunch.employee_email).all())
    return {em.lower(): d for em, d in rows if d}


def _commit(db, people: dict, actor: str) -> None:
    import models
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    for em, p in sorted(people.items()):
        if not p["rows"]:
            continue
        batch_id = "dup-" + str(uuid.uuid4())
        days = sorted({d for d, *_ in p["rows"]})
        minutes = int(round(p["hours"] * 60))
        for d, in_at, out_at, out_ld, tz_min, cat in p["rows"]:
            db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=em, kind="in", at=in_at,
                                    local_date=d, tz_offset_min=tz_min, geo_status="no_location",
                                    note=NOTE, source="manual", category=cat[:80],
                                    created_by=actor, created_at=now, batch_id=batch_id,
                                    entry_source="hr_record"))
            db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=em, kind="out", at=out_at,
                                    local_date=out_ld, tz_offset_min=tz_min, geo_status="no_location",
                                    note=NOTE, source="manual", category="",
                                    created_by=actor, created_at=now, batch_id=batch_id,
                                    entry_source="hr_record"))
        db.add(models.TimeEntryBatch(id=batch_id, employee_email=em, kind="hr_record", reason=REASON,
                                     range_start=days[0], range_end=days[-1], days=days,
                                     minutes=minutes, created_by=actor, created_at=now))
        db.add(models.AuditLog(timestamp=now, user_email=actor, user_role="", module="timeclock",
                               kind="create", action="Added time from a record",
                               resource_type="time_entry_batches", resource_id=batch_id,
                               details=json.dumps({"employee": em, "days": len(days),
                                                   "minutes": minutes, "reason": REASON[:300]})))
    db.commit()


def _q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _sql(people: dict, actor: str, out_path: str) -> None:
    """INSERT statements for prod: one per person, each pair expanded into its
    in and out punch server-side. Every non-varying time_punches column is set
    explicitly in the SELECT - SQLAlchemy's defaults are client-side, so a
    column left out of raw SQL would be NULL, not ''."""
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    batch_vals, audit_vals, n_punch = [], [], 0
    with open(out_path, "w", encoding="utf-8") as f:
        for em, p in sorted(people.items()):
            if not p["rows"]:
                continue
            batch_id = "dup-" + str(uuid.uuid4())
            days = sorted({d for d, *_ in p["rows"]})
            minutes = int(round(p["hours"] * 60))
            vals = ",\n".join(f"({_q(in_at)},{_q(out_at)},{_q(d)},{_q(out_ld)},{tz_min},{_q(cat[:80])})"
                              for d, in_at, out_at, out_ld, tz_min, cat in p["rows"])
            n_punch += 2 * len(p["rows"])
            f.write(
                "insert into time_punches (id, employee_email, kind, at, local_date, tz_offset_min, category,"
                " batch_id, original_at, lat, lng, accuracy_m, geo_status, work_site_id, work_site_name,"
                " distance_m, source, note, ip, user_agent, adjusted_by, adjusted_at, adjust_note, voided,"
                " created_by, created_at, site_set_by, pending_at, edit_reason, edited_by, edited_at,"
                " edit_status, edit_reviewed_by, edit_reviewed_at, edit_requested_at, edit_note,"
                " replaced_by_batch, entry_source)\n"
                f"select gen_random_uuid()::text, {_q(em)}, k.kind, k.at, k.ld, v.tz,"
                f" case when k.kind = 'in' then v.cat else '' end, {_q(batch_id)},"
                f" '', '', '', 0, 'no_location', '', '', 0, 'manual', {_q(NOTE)},"
                f" '', '', '', '', '', 0, {_q(actor)}, {_q(now)}, '',"
                " '', '', '', '', '', '', '', '', '', '', 'hr_record'\n"
                f"from (values\n{vals}\n) as v(in_at, out_at, ld_in, ld_out, tz, cat)\n"
                "cross join lateral (values ('in', v.in_at, v.ld_in), ('out', v.out_at, v.ld_out))"
                " as k(kind, at, ld);\n\n")
            batch_vals.append(f"({_q(batch_id)},{_q(em)},'hr_record',{_q(REASON)},{_q(days[0])},{_q(days[-1])},"
                              f"{_q(json.dumps(days))}::json,{minutes},'','',{_q(actor)},{_q(now)},'','')")
            audit_vals.append(f"({_q(now)},{_q(actor)},'','Added time from a record','time_entry_batches',"
                              f"{_q(batch_id)},{_q(json.dumps({'employee': em, 'days': len(days), 'minutes': minutes}))},"
                              f"'','','','','timeclock','create','')")
        f.write("insert into time_entry_batches (id, employee_email, kind, reason, range_start, range_end, days,"
                " minutes, doc_path, doc_name, created_by, created_at, undone_by, undone_at) values\n"
                + ",\n".join(batch_vals) + ";\n\n")
        f.write("insert into audit_logs (timestamp, user_email, user_role, action, resource_type, resource_id,"
                " details, ip_address, undone_at, undone_by, request_id, module, kind, acting_as) values\n"
                + ",\n".join(audit_vals) + ";\n")
    print(f"SQL written to {out_path}: {n_punch} punches, {len(batch_vals)} batches.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--mapping", default=str(MAPPING))
    ap.add_argument("--boundaries", default="", help="JSON {email: first Nexus YYYY-MM-DD} for --sql-out")
    ap.add_argument("--actor", default="", help="created_by on every row (an HR email)")
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--sql-out", default="")
    args = ap.parse_args()

    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    mapping = {k: v for k, v in mapping.items() if not k.startswith("_")}

    if args.commit:
        from database import SessionLocal
        db = SessionLocal()
        try:
            boundaries = _db_boundaries(db)
            people, report = _plan(args.files, mapping, boundaries)
            print("\n".join(report))
            if not args.actor:
                sys.exit("--commit needs --actor (the HR email the rows are created by)")
            _commit(db, people, args.actor.lower())
            print("Committed.")
        finally:
            db.close()
        return

    if not args.boundaries:
        sys.exit("Without --commit, pass --boundaries (a JSON of each person's first Nexus day) - "
                 "the plan is only safe relative to what Nexus already holds.")
    boundaries = {k.lower(): v for k, v in json.loads(Path(args.boundaries).read_text(encoding="utf-8")).items()}
    people, report = _plan(args.files, mapping, boundaries)
    print("\n".join(report))
    total = sum(len(p["rows"]) for p in people.values())
    print(f"\n{total} punch pairs across {sum(1 for p in people.values() if p['rows'])} people.")
    if args.sql_out:
        if not args.actor:
            sys.exit("--sql-out needs --actor (the HR email the rows are created by)")
        _sql(people, args.actor.lower(), args.sql_out)
    else:
        print("Dry run - pass --sql-out or --commit to produce the writes.")


if __name__ == "__main__":
    main()
