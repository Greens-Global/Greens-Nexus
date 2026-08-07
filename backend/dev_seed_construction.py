"""Local-only dev seed: realistic Site Activity data for the Construction module.

The module is hard to look at with an empty database - Site Activity, the review
queue and the weekly rollups all render as empty states, so nothing about the
layout, the status colours or the AI sections can actually be judged. This fills
in a jobsite's worth of daily logs across the statuses the workflow moves
through, with the derived AI fields populated the way the real pipeline writes
them.

Deliberately a seed script and not a code shim: nothing here changes app
behaviour, so there is nothing to remember to revert before a PR.

Safe by construction: refuses to run unless DATABASE_URL is unset, i.e. only
against the local SQLite file. Never run this against the shared dev Postgres.

Idempotent - re-running replaces what it seeded (matched on the seed marker)
rather than stacking a second copy.

    cd backend && .venv/Scripts/python dev_seed_construction.py
"""
import os
import uuid
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

load_dotenv()

if os.getenv("DATABASE_URL"):
    raise SystemExit("refusing to run: DATABASE_URL is set (this is local-SQLite only)")

from database import SessionLocal, engine  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=engine)

WORKER = os.getenv("NEXUS_DEV_EMAIL", "dev@localhost").lower()
CREW = ["ankush.narkhede@greensglobal.com", "sagar.shoundik@greensglobal.com", WORKER]
MANAGER = WORKER

# Stamped on every row this script writes so a re-run can clear its own work
# without touching anything you created by hand in the UI.
SEED_TAG = "dev-seed-construction"

now_iso = lambda: datetime.now(timezone.utc).isoformat()          # noqa: E731
gid = lambda: str(uuid.uuid4())                                    # noqa: E731

db = SessionLocal()

# ── The jobsite ──────────────────────────────────────────────────────────────
# Reuses the existing "Valley Center" row if it is there - overwriting somebody's
# project id would orphan the logs already attached to it.
project = (db.query(models.ConstructionProject)
             .filter(models.ConstructionProject.name.like("Valley Center%")).first())
if not project:
    project = models.ConstructionProject(id=gid(), name="Valley Center", created_at=now_iso())
    db.add(project)

project.code = "GSVC-2026-04"
project.description = "42-unit residential build, three storeys over podium parking."
project.address = "1420 Valley Center Dr, Escondido, CA"
project.latitude, project.longitude, project.geofence_radius_m = 33.1467, -117.0831, 500
project.status = "active"
project.phase = "Framing"
project.percent_complete = 38.0
project.contract_value = 8_450_000.0
project.currency = "USD"
project.general_contractor = "Greens Global Construction"
project.start_on = "2026-03-02"
project.target_finish_on = "2026-12-18"
project.worker_emails = CREW
project.manager_emails = [MANAGER]
project.executive_emails = [MANAGER]
project.week_starts_on = 1      # Monday
project.report_day = 5          # Friday
project.created_by = SEED_TAG
project.modified_at = now_iso()
db.flush()

# A second site so the Site Activity picker is a real choice rather than a
# select with one option - the single-site path already renders differently.
second = (db.query(models.ConstructionProject)
            .filter(models.ConstructionProject.name == "Harbor Point Phase 2").first())
if not second:
    second = models.ConstructionProject(id=gid(), name="Harbor Point Phase 2", created_at=now_iso())
    db.add(second)
second.code = "GSHP-2026-02"
second.description = "Tenant improvement, 18,000 sq ft office shell."
second.address = "88 Harbor Point Blvd, San Diego, CA"
second.status = "active"
second.phase = "Rough-In"
second.percent_complete = 61.0
second.contract_value = 2_100_000.0
second.general_contractor = "Greens Global Construction"
second.start_on = "2026-01-12"
second.target_finish_on = "2026-09-30"
second.worker_emails = CREW
second.manager_emails = [MANAGER]
second.executive_emails = [MANAGER]
second.week_starts_on = 1
second.report_day = 5
second.created_by = SEED_TAG
second.modified_at = now_iso()
db.flush()

# ── Clear what a previous run seeded (never hand-made rows) ───────────────────
seeded_logs = (db.query(models.ConstructionDailyLog)
                 .filter(models.ConstructionDailyLog.ai_model == SEED_TAG).all())
for row in seeded_logs:
    db.delete(row)
db.flush()

# ── Daily logs ───────────────────────────────────────────────────────────────
# Working backwards from today so the newest sit at the top of Site Activity and
# the current week is partly filled - the state the screen is actually in most
# of the time, rather than a tidy completed week.
TODAY = date.today()

DAYS = [
    # (days_ago, status, weather, temp, crew, hours, summary, work, safety, delay)
    (0, "draft", "Clear", 78, 9, 72.0,
     "", [], [], []),
    (1, "submitted", "Clear", 81, 12, 96.0,
     "Framing crew topped out the third-floor exterior walls on grid lines A through F. "
     "Sheathing followed one bay behind. Plumbing rough-in continued on level two.",
     [{"activity": "Third-floor exterior wall framing", "trade": "Carpentry", "location": "Grid A-F", "confidence": 0.94},
      {"activity": "Exterior sheathing", "trade": "Carpentry", "location": "Level 3 north", "confidence": 0.88},
      {"activity": "Plumbing rough-in", "trade": "Plumbing", "location": "Level 2", "confidence": 0.91}],
     [], []),
    (2, "processed", "Overcast", 72, 11, 88.0,
     "Level two framing inspection passed with no corrections. Crew moved to third-floor "
     "layout in the afternoon. Material delivery for shear panel arrived and was staged on the podium.",
     [{"activity": "Framing inspection - level 2", "trade": "Inspection", "location": "Level 2", "confidence": 0.97},
      {"activity": "Third-floor wall layout", "trade": "Carpentry", "location": "Level 3", "confidence": 0.9}],
     [], []),
    (3, "needs_info", "Rain", 64, 6, 36.0,
     "Rain from mid-morning. Exterior work stopped at 10:30; crew moved to interior blocking "
     "on level one. Podium deck standing water noted at the northeast corner.",
     [{"activity": "Interior blocking", "trade": "Carpentry", "location": "Level 1", "confidence": 0.85}],
     [{"severity": "medium", "issue": "Standing water on podium deck - slip hazard at NE corner", "evidence_media_id": ""}],
     [{"cause": "Weather - rain", "impact_days": 0.5, "evidence": "Exterior framing stopped 10:30"}]),
    (4, "approved", "Partly cloudy", 75, 12, 96.0,
     "Shear panel installation completed on level two. Electrical rough-in started in units 201-206. "
     "Crane moved to the south setup for the week ahead.",
     [{"activity": "Shear panel installation", "trade": "Carpentry", "location": "Level 2", "confidence": 0.93},
      {"activity": "Electrical rough-in", "trade": "Electrical", "location": "Units 201-206", "confidence": 0.89},
      {"activity": "Crane relocation", "trade": "Equipment", "location": "South yard", "confidence": 0.96}],
     [], []),
    (5, "approved", "Clear", 79, 10, 80.0,
     "Second-floor deck poured and finished. Pump truck released at 14:00. Cylinders taken "
     "for the 7- and 28-day breaks.",
     [{"activity": "Level 2 deck pour", "trade": "Concrete", "location": "Level 2", "confidence": 0.98},
      {"activity": "Test cylinders cast", "trade": "Concrete", "location": "On site", "confidence": 0.92}],
     [], []),
    (7, "approved", "Clear", 82, 13, 104.0,
     "Deck formwork and rebar completed ahead of tomorrow's pour. Pre-pour inspection passed "
     "at 15:30. Site cleaned and access route cleared for the pump truck.",
     [{"activity": "Deck formwork", "trade": "Concrete", "location": "Level 2", "confidence": 0.95},
      {"activity": "Rebar placement", "trade": "Rebar", "location": "Level 2", "confidence": 0.94},
      {"activity": "Pre-pour inspection", "trade": "Inspection", "location": "Level 2", "confidence": 0.97}],
     [], []),
    (8, "approved", "Hot", 94, 13, 104.0,
     "Heat plan in effect - shade and water stations set, work shifted earlier. Column "
     "formwork stripped on level one. Rebar delivery received and inventoried.",
     [{"activity": "Column form stripping", "trade": "Concrete", "location": "Level 1", "confidence": 0.91},
      {"activity": "Rebar delivery", "trade": "Rebar", "location": "Laydown", "confidence": 0.88}],
     [{"severity": "low", "issue": "Heat illness prevention plan activated - 94F", "evidence_media_id": ""}],
     []),
    (9, "approved", "Clear", 80, 11, 88.0,
     "Underground plumbing inspected and backfilled. Slab prep started at the west half. "
     "Surveyor confirmed column layout.",
     [{"activity": "Underground plumbing inspection", "trade": "Plumbing", "location": "Level 1", "confidence": 0.96},
      {"activity": "Slab preparation", "trade": "Concrete", "location": "West half", "confidence": 0.9}],
     [], []),
]

ACTIONS = {
    3: [{"text": "Squeegee NE podium corner and re-check drainage before next rain",
         "owner_email": CREW[0], "due_on": str(TODAY + timedelta(days=1))}],
    1: [{"text": "Confirm shear panel delivery for level 3", "owner_email": CREW[1],
         "due_on": str(TODAY + timedelta(days=2))}],
}
NEXT_WORK = {
    1: ["Continue level 3 framing grid F-K", "Set third-floor stair tower"],
    2: ["Third-floor wall framing", "Shear panel level 3"],
    4: ["Electrical rough-in units 207-212"],
}

made = 0
for days_ago, status, weather, temp, crew, hours, summary, work, safety, delay in DAYS:
    d = TODAY - timedelta(days=days_ago)
    log = models.ConstructionDailyLog(
        id=gid(), project_id=project.id, log_date=str(d),
        author_email=CREW[days_ago % len(CREW)],
        status=status,
        notes_raw=(summary.split(".")[0] + "." if summary else "Setting up, will fill in at end of day."),
        weather=weather, temperature_f=float(temp), crew_size=crew, hours_worked=hours,
        gps_latitude=33.1467, gps_longitude=-117.0831, gps_accuracy_m=12.0, geofence_ok=True,
        ai_summary=summary,
        ai_work_completed=work,
        ai_categories=sorted({w["trade"].lower() for w in work}),
        ai_safety_flags=safety,
        ai_delay_flags=delay,
        ai_milestones=[],
        ai_action_items=ACTIONS.get(days_ago, []),
        ai_next_work=NEXT_WORK.get(days_ago, []),
        # The marker that makes a re-run idempotent.
        ai_model=SEED_TAG,
        ai_confidence=0.0 if status == "draft" else 0.91,
        ai_processed_at="" if status in ("draft", "submitted") else now_iso(),
        reviewed_by=MANAGER if status in ("approved", "needs_info") else "",
        reviewed_at=now_iso() if status in ("approved", "needs_info") else "",
        review_note="Which corner is the standing water in?" if status == "needs_info" else "",
        submitted_at="" if status == "draft" else now_iso(),
        created_at=now_iso(), modified_at=now_iso(),
    )
    db.add(log)
    made += 1

# A couple on the second site, so switching sites shows different content rather
# than an empty panel.
for days_ago, status, summary in (
    (1, "submitted", "Ceiling grid installed in the east open office. Fire sprinkler drops followed."),
    (2, "approved", "VAV boxes set and ducted on the north run. Electrical panel schedule updated."),
):
    d = TODAY - timedelta(days=days_ago)
    db.add(models.ConstructionDailyLog(
        id=gid(), project_id=second.id, log_date=str(d), author_email=CREW[1],
        status=status, notes_raw=summary, weather="Clear", temperature_f=73.0,
        crew_size=7, hours_worked=56.0, geofence_ok=True,
        ai_summary=summary, ai_work_completed=[], ai_categories=["mechanical"],
        ai_safety_flags=[], ai_delay_flags=[], ai_milestones=[], ai_action_items=[], ai_next_work=[],
        ai_model=SEED_TAG, ai_confidence=0.9,
        ai_processed_at=now_iso() if status != "submitted" else "",
        reviewed_by=MANAGER if status == "approved" else "",
        reviewed_at=now_iso() if status == "approved" else "",
        submitted_at=now_iso(),
        created_at=now_iso(), modified_at=now_iso()))
    made += 1

# ── Milestones, so the schedule strip has something to show ──────────────────
# Marked in `description` rather than a created_by column - this model has none,
# and inventing one for a seed script would be a schema change for a dev tool.
for m in db.query(models.ConstructionMilestone).filter(
        models.ConstructionMilestone.project_id.in_([project.id, second.id])).all():
    if SEED_TAG in (m.description or ""):
        db.delete(m)
db.flush()

# status vocabulary is upcoming|at_risk|hit|missed (see the model) - not the
# not_started/in_progress/complete set other modules use.
MILESTONES = [
    ("Foundation complete", "2026-05-15", "hit", "2026-05-14", True),
    ("Level 2 deck poured", str(TODAY - timedelta(days=5)), "hit", str(TODAY - timedelta(days=5)), False),
    ("Framing top out", "2026-09-04", "upcoming", "", True),
    ("Dry-in", "2026-10-16", "at_risk", "", True),
    ("Final inspection", "2026-12-11", "upcoming", "", False),
]
for name, target, state, actual, critical in MILESTONES:
    db.add(models.ConstructionMilestone(
        id=gid(), project_id=project.id, name=name,
        description=f"({SEED_TAG})", target_date=target, actual_date=actual,
        status=state, critical=critical,
        created_at=now_iso(), modified_at=now_iso()))

db.commit()

print(f"seeded {made} daily logs across 2 jobsites")
print(f"  {project.name} ({project.code}) - {project.phase}, {project.percent_complete:.0f}%")
print(f"  {second.name} ({second.code}) - {second.phase}, {second.percent_complete:.0f}%")
print(f"  statuses: {', '.join(sorted({d[1] for d in DAYS}))}")
print("re-run any time - it replaces its own rows and leaves hand-made ones alone")
db.close()
