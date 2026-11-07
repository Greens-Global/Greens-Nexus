"""Construction Module - data model (Aug 2026).

Replaces the WhatsApp-photo-dump -> manager-retypes-it-all workflow. The
constraint that drives every decision here: a worker on a jobsite, on a phone,
in gloves, gets about two minutes. Everything expensive (AI, transcoding,
captioning, report drafting) happens AFTER Submit returns, never in the request.

Defined in its own module rather than appended to models.py: these tables share
nothing with the other modules, and `models.py` is already 2753 lines. They
register on the same declarative Base, so `create_all` picks them up exactly as
if they were inline - models.py just imports this at the bottom (one-line diff,
which is what the append-only rule is protecting).

Conventions match the rest of the codebase: identity is email-keyed and joins to
nexus_employees, timestamps are ISO strings, arrays/maps are jsonb, no DB-level
foreign keys (cross-module rows must survive each other).

ROW LEVEL SECURITY: every table below is enabled, with no policies, from the
Postgres migration list in main.py - NOT from a release checklist. `create_all`
builds a table with RLS off, and the backend never notices because it connects
via the privileged DATABASE_URL and bypasses RLS; the only thing the setting
locks out is the public anon key. CLAUDE.md records this gap as recurring, so
it is automated instead of documented. **A NEW TABLE ADDED HERE NEEDS ITS OWN
LINE IN THAT LIST** - nothing enforces this for you.
"""
from sqlalchemy import BigInteger, Boolean, Column, Float, Index, Integer, JSON, String, Text
from database import Base


class ConstructionProject(Base):
    """A jobsite.

    A jobsite has a contract value, a general contractor, a phase, and a weekly
    reporting cadence that mean nothing to a leased building or a software
    project.

    JOBS MAY CONNECT TO TASKS FULLY (Neil, 11/03/2026, plan
    https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr: "utilize any connection
    to better the product"). This replaces Sagar's 08/04/2026 rule that kept a
    construction project independent of the Task module: a job may have its own
    task project (schedule, milestones, punch list), job items may become tasks
    and tasks may point back at the job. A construction project is still its
    own record - the jobsite, its daily logs, media and weekly reports live
    here - and the link is made where it is needed, not by folding one into
    the other.

    `company_id` (11/03/2026) is the HrEntity the job belongs to - the company
    wall (auth.company_scope / company_ok) every construction read and write
    checks. '' = unknown: visible only to callers the walls do not confine."""
    __tablename__ = "construction_projects"
    id                 = Column(String, primary_key=True)
    name               = Column(String, nullable=False)
    code               = Column(String, default="", index=True)   # e.g. "GSVC-2026-04"
    description        = Column(String, default="")
    # The one cross-module pointer, and no DB FK on purpose: the Asset module
    # owns the building, and the Egnyte folder tree hangs off it (see
    # services/construction_storage.py). A construction project without a
    # property is still valid.
    property_id        = Column(String, default="", index=True)    # Property (Asset module)
    address            = Column(String, default="")
    latitude           = Column(Float, default=0.0)                # jobsite center, for the
    longitude          = Column(Float, default=0.0)                # GPS sanity check
    geofence_radius_m  = Column(Integer, default=500)              # 0 disables the check
    status             = Column(String, default="active")          # active|on_hold|complete|archived
    phase              = Column(String, default="")                # Foundation | Framing | ...
    # Progress is STORED, not derived: on a jobsite "42% complete" is a judgment
    # the superintendent makes against the schedule, not a count of closed tasks.
    # AI proposes a delta; a human accepts it.
    percent_complete   = Column(Float, default=0.0)
    contract_value     = Column(Float, default=0.0)
    currency           = Column(String, default="USD")
    general_contractor = Column(String, default="")
    start_on           = Column(String, default="")
    target_finish_on   = Column(String, default="")
    # Per-project access. Role checks still run server-side against
    # nexus_employees; these are the project-scoped grants on top.
    manager_emails     = Column(JSON, default=list)   # may review and approve
    executive_emails   = Column(JSON, default=list)   # receive published reports
    worker_emails      = Column(JSON, default=list)   # may file daily logs
    # Reporting cadence is per project because crews on different sites run
    # Sun-Sat vs Mon-Sun, and the report has to line up with the payroll week the
    # superintendent already thinks in.
    week_starts_on     = Column(Integer, default=1)   # 0=Sunday .. 6=Saturday
    report_day         = Column(Integer, default=5)   # weekday the draft is cut
    created_by         = Column(String, default="")
    created_at         = Column(String, default="")
    modified_at        = Column(String, default="")
    archived           = Column(Boolean, default=False)
    deleted_at         = Column(String, default="")   # soft delete
    # The company wall (11/03/2026) - see the docstring. Stamped from the
    # creator's company; the startup backfill (construction_company.py)
    # fills older rows from the creator or the linked property.
    company_id         = Column(String, default="", index=True)
    # The jobsite's own IANA zone, kept from its forecast (Open-Meteo answers
    # the zone of the point). '' = not known yet; readers fall back to the
    # company's team zone (construction_company.zone_of). Weekly report weeks
    # and a log's date are cut in this zone.
    time_zone          = Column(String, default="")
    # Job types on the one record (Neil, 11/03/2026, plan phase 2 "The Job,
    # Connected"): a `work_order` (a maintenance fix that needs a crew,
    # materials or more than a day - often started from a ticket) or a
    # `project` (a build). Size decides which sections the Job page shows;
    # every older row is a project.
    job_type           = Column(String, default="project")
    # The job's task project (Tasks module) - its schedule, milestones,
    # dependencies, punch list and look-ahead. A COLUMN, not a link table:
    # a job has exactly one, every Job read needs it, and a join for one
    # value buys nothing. '' = none yet (stamped from the job type's
    # template the first time the job's schedule is opened or at create).
    task_project_id    = Column(String, default="", index=True)
    # Money (Neil, 11/03/2026, plan phase 4): the job's EXISTING Intacct
    # Project-Job code - the dimension the accounting reports already filter
    # by (routers/accounting.py `project=`) - and the entity (Intacct
    # location) it books to. Budget, actual and drill-downs are read from the
    # books through the accounting proxy, never keyed here
    # (construction_money.py). '' = not mapped yet.
    intacct_project_id = Column(String, default="")
    intacct_entity     = Column(String, default="")
    # Field and Closeout (Neil, 11/03/2026, plan phase 3): the person who
    # runs the site day to day - the morning "yesterday's log is missing"
    # bell goes to them ('' = the job's managers).
    superintendent_email = Column(String, default="")
    # The job's closeout state, one JSON (construction_closeout.py):
    # {closedOutAt, closedOutBy, signoff: {requestId, status, signerName,
    # signerEmail, sentAt, signedAt}}. {} = not closed out.
    closeout           = Column(JSON, default=dict)
    # Size (Round Two, 11/05/2026): the owner-builder's benchmark - cost per
    # unit and per square foot across the same facility built many times.
    # 0 = not known.
    units              = Column(Integer, default=0)
    square_feet        = Column(Integer, default=0)


class ConstructionDailyLog(Base):
    """One worker, one jobsite, one day - the atomic unit the module exists to
    make cheap.

    `status` is the contract between worker and manager:
      draft      worker is still adding media; nothing processed yet
      submitted  worker pressed Submit; AI has been queued
      processed  AI finished; ready to roll into a weekly report
      needs_info a manager bounced it back with a question
      approved   counted toward the weekly report
    A worker can never move a log past `submitted`. Publishing is a manager act.

    `notes_raw` is kept verbatim forever. The AI summary is a derived artifact;
    the original is what you show when somebody disputes what was reported. Same
    reason the ai_* columns are written once and never edited in place - a
    manager's wording changes go to the weekly report, so the log stays a
    faithful record of both what was reported and what the model made of it."""
    __tablename__ = "construction_daily_logs"
    id             = Column(String, primary_key=True)
    project_id     = Column(String, nullable=False, index=True)
    log_date       = Column(String, nullable=False, index=True)   # YYYY-MM-DD, jobsite-local
    author_email   = Column(String, default="", index=True)
    status         = Column(String, default="draft", index=True)
    notes_raw      = Column(Text, default="")        # optional typed note, verbatim
    # Conditions: cheap to capture, disproportionately useful in a delay claim.
    weather        = Column(String, default="")
    temperature_f  = Column(Float, default=0.0)
    crew_size      = Column(Integer, default=0)
    hours_worked   = Column(Float, default=0.0)
    # Where the phone was at Submit. Evidence, and the input to the off-site
    # warning - never a hard block: jobsite coverage is bad, and a rejected log
    # means the update is lost, which is worse than an unverified one.
    gps_latitude   = Column(Float, default=0.0)
    gps_longitude  = Column(Float, default=0.0)
    gps_accuracy_m = Column(Float, default=0.0)
    geofence_ok    = Column(Boolean, default=True)
    # What the crew flagged themselves (11/03/2026): any of delay | safety |
    # issue | weather. Replaces the AI's safety flags on every screen while AI
    # is off - a person said it, so it counts whether or not a model ran.
    tags           = Column(JSON, default=list)
    # The self-drafting log (Neil, 11/03/2026, plan phase 3 - construction_field.py):
    #   delays       [{cause, hours, note}] - one line per delay, so a weather
    #                delay summary (the weekly report) adds hours, never guesses
    #   prefill      what the screen drafted the log from when it opened -
    #                {weather, crew, punchDone, punchVerified, forms, photos},
    #                kept as the record of where each number came from
    #   weather_source  forecast | typed ('' = older logs)
    #   signed_name / signed_at  the typed-name signature on Submit
    delays         = Column(JSON, default=list)
    prefill        = Column(JSON, default=dict)
    weather_source = Column(String, default="")
    # Subs on site (Round Two, 11/05/2026): [{name, headcount, hours}] - one
    # line per subcontractor on site that day. Sub manpower is the number a
    # delay claim is argued with; the weekly report sums it beside crew hours.
    subs           = Column(JSON, default=list)
    signed_name    = Column(String, default="")
    signed_at      = Column(String, default="")
    # ── AI-derived (write-once) ──
    ai_summary        = Column(Text, default="")     # professional prose
    ai_work_completed = Column(JSON, default=list)   # [{activity, trade, location, confidence}]
    ai_categories     = Column(JSON, default=list)   # ["concrete", "electrical", ...]
    ai_safety_flags   = Column(JSON, default=list)   # [{severity, issue, evidence_media_id}]
    ai_delay_flags    = Column(JSON, default=list)   # [{cause, impact_days, evidence}]
    ai_milestones     = Column(JSON, default=list)   # [{milestone_id?, name, detected_from}]
    ai_action_items   = Column(JSON, default=list)   # [{text, owner_email, due_on}]
    ai_next_work      = Column(JSON, default=list)   # what the worker says is next
    ai_model          = Column(String, default="")
    ai_confidence     = Column(Float, default=0.0)   # 0-1; low routes to a manager first
    ai_processed_at   = Column(String, default="")
    ai_error          = Column(String, default="")   # last failure, for the retry sweep
    # Review trail
    reviewed_by    = Column(String, default="")
    reviewed_at    = Column(String, default="")
    review_note    = Column(String, default="")
    submitted_at   = Column(String, default="")
    created_at     = Column(String, default="")
    modified_at    = Column(String, default="")
    deleted_at     = Column(String, default="")


class ConstructionMedia(Base):
    """Photo, video, or voice note - ONE table, discriminated by `kind`.

    Three tables would duplicate about 80% of these columns (uploader, GPS,
    captions, tags, thumbnail, AI state, soft delete) and triple the API surface,
    the permission checks, and the AI queue. Kind-specific columns are nullable
    instead.

    TWO stores, ONE source of truth. routers/egnyte.py records the standing rule
    (Neil): "Egnyte remains the source of truth - Nexus never keeps a second
    copy." That rule is kept here by making the two stores play different roles
    rather than mirroring each other:

      Egnyte   - the RECORD. Full-resolution original, in the project's existing
                 folder tree, where permissions, versioning, sharing and
                 retention already live and where the GC and architect look.
      Supabase - DERIVATIVES. Web-sized renditions and thumbnails, which is what
                 the app grid and the PDF's clickable links actually need.
                 Disposable: wipe the bucket and a sweep rebuilds it from Egnyte.

    So Supabase never holds a second copy of RECORD - it holds artifacts derived
    from it. When the two disagree, Egnyte wins. `egnyte_path` is authoritative
    and `egnyte_status` tracks the upload, because a dual write WILL half-fail
    and a row that can't say which half landed is unrecoverable."""
    __tablename__ = "construction_media"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, nullable=False, index=True)
    daily_log_id  = Column(String, default="", index=True)      # "" = attached to a report directly
    kind          = Column(String, nullable=False, index=True)  # photo | video | audio
    # ── Egnyte: the record ──
    egnyte_path    = Column(String, default="", index=True)   # authoritative location
    egnyte_web_url = Column(String, default="")               # deep link into Egnyte's own UI
    egnyte_status  = Column(String, default="pending", index=True)
    # pending | uploaded | failed | skipped(too_large) - drives the retry sweep;
    # held = waiting on the property's missing PINNED Egnyte folder (11/03/2026)
    egnyte_error   = Column(String, default="")
    egnyte_synced_at = Column(String, default="")
    # ── Supabase: derivatives, rebuildable ──
    storage_path  = Column(String, default="")
    url           = Column(String, default="")     # web-sized rendition
    thumbnail_url = Column(String, default="")
    mime_type     = Column(String, default="")
    size_bytes    = Column(BigInteger, default=0)
    # taken_at comes from EXIF/media metadata when present and is NOT
    # uploaded_at: a worker photographs at 9am and uploads at 5pm when signal
    # comes back, and a report that dates that work to 5pm is wrong.
    taken_at      = Column(String, default="")
    uploaded_at   = Column(String, default="")
    uploaded_by   = Column(String, default="", index=True)
    gps_latitude  = Column(Float, default=0.0)
    gps_longitude = Column(Float, default=0.0)
    # `description` is the worker's own words; `caption` is what the report
    # prints - manager-editable, seeded from ai_caption.
    description   = Column(String, default="")
    caption       = Column(String, default="")
    # kind=video
    duration_s    = Column(Float, default=0.0)
    width         = Column(Integer, default=0)
    height        = Column(Integer, default=0)
    # kind=video | audio
    transcript        = Column(Text, default="")
    transcript_source = Column(String, default="")   # which STT engine produced it
    # ── AI-derived ──
    ai_caption      = Column(String, default="")     # vision model, one line
    ai_summary      = Column(Text, default="")       # video/audio: what happens
    ai_tags         = Column(JSON, default=list)     # ["rebar", "formwork", "ppe-violation"]
    ai_ocr_text     = Column(Text, default="")       # pytesseract: signage, drawing stamps
    ai_safety       = Column(JSON, default=list)     # [{severity, issue}] from the image alone
    ai_model        = Column(String, default="")
    ai_processed_at = Column(String, default="")
    ai_error        = Column(String, default="")
    # Perceptual hash for duplicate detection: workers shoot the same wall from
    # the same angle daily, and the report should show progression rather than
    # twelve identical photos.
    phash         = Column(String, default="", index=True)
    duplicate_of  = Column(String, default="")       # media id this collapses into
    # `search_text` is the flattened haystack (description + caption + ai_caption
    # + tags + OCR + transcript) so keyword search is one LIKE; `embedding` backs
    # semantic search and RAG retrieval.
    search_text   = Column(Text, default="")
    embedding     = Column(JSON, default=list)
    featured      = Column(Boolean, default=False)   # manager pinned it to the report
    sort_order    = Column(Integer, default=0)
    deleted_at    = Column(String, default="")
    # The photo timeline (Neil, 11/03/2026, plan phase 3): the crew's own tags
    # (before, after, punch, markup, or any word), where on the site it was
    # taken in words, the photo a Mark Up was drawn on, and the punch item a
    # Done photo proves. A row with no daily_log_id is a job photo (the
    # timeline's Add Photos, a punch Done photo, an attached markup).
    tags            = Column(JSON, default=list)
    location_text   = Column(String, default="")
    source_media_id = Column(String, default="", index=True)
    task_id         = Column(String, default="", index=True)


class ConstructionAIJob(Base):
    """Async AI work, tracked in the DB rather than in process memory.

    Same reason AsanaImportJob exists: dev runs 8 gunicorn workers, so the
    request that queues a job and the request that polls it are usually served by
    DIFFERENT processes - anything in-process is invisible to the poll.
    `heartbeat_at` is what lets a job whose worker was recycled be recognized as
    dead instead of wedging the queue forever.

    This table is also what keeps Submit under two seconds: the worker's request
    writes rows, enqueues, and returns."""
    __tablename__ = "construction_ai_jobs"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, default="", index=True)
    kind          = Column(String, nullable=False, index=True)
    # media_caption | log_summarize | egnyte_sync | derive_rendition
    #
    # That list is exhaustive - every kind here is implemented in
    # construction_worker.py. Three more were once declared and are deliberately
    # NOT queued, because a queue that accumulates rows nothing drains is worse
    # than a missing feature: the job sits at 'queued' forever and every status
    # readout lies.
    #   media_transcribe  the Messages API takes text, images and PDFs - not
    #                     audio. Transcription needs a speech-to-text vendor
    #                     (Azure AI Speech is the fit, being the same tenant as
    #                     Entra/Graph) and that is a procurement decision, not a
    #                     code one. Voice notes still upload and still file to
    #                     Egnyte; they just carry no transcript, so the log
    #                     summary does not include what the worker said.
    #   embed             Anthropic ships no embeddings endpoint. Nothing reads
    #                     `embedding` yet either - keyword search runs off
    #                     `search_text` - so this waits for semantic search to
    #                     have a caller.
    #   report_draft /    reports are drafted synchronously inside
    #   report_executive  POST /reports/generate: a manager is watching that
    #                     button, and a job row would mean polling for something
    #                     that takes one call.
    #
    # egnyte_sync is here rather than inline in the upload request for the same
    # reason everything else is: a phone on jobsite LTE that half-uploads must
    # not lose the update. The row lands with egnyte_status='pending' and the
    # sweep retries until the record copy is filed.
    subject_id    = Column(String, default="", index=True)   # media / log / report id
    status        = Column(String, default="queued", index=True)  # queued|running|done|error|dead|skipped
    # skipped (11/03/2026): an AI job that can never run because AI is off
    # (ai_switch). Kept, never deleted - the row is the history of what was asked.
    attempts      = Column(Integer, default=0)
    max_attempts  = Column(Integer, default=4)
    # A voice note gates its log's summary (the transcript is an input), so
    # transcription runs ahead of summarization from the same submit.
    priority      = Column(Integer, default=100)   # lower runs first
    depends_on    = Column(JSON, default=list)     # job ids that must finish first
    queued_at     = Column(String, default="")
    started_at    = Column(String, default="")
    heartbeat_at  = Column(String, default="")
    finished_at   = Column(String, default="")
    model         = Column(String, default="")
    input_tokens  = Column(Integer, default=0)     # per-project cost attribution
    output_tokens = Column(Integer, default=0)
    error         = Column(String, default="")
    result        = Column(JSON, default=dict)


class ConstructionWeeklyReport(Base):
    """The deliverable.

    Sections are jsonb rather than columns because a manager reorders and
    re-titles them, and because every section carries the same triple: what the
    AI wrote, what the manager made it, and what it was sourced from. Losing any
    one breaks a different thing - the first breaks "regenerate", the second
    breaks the report, the third breaks the audit.

    `version` increments on publish. A published report is immutable; an edit
    produces v2, and the executive's link keeps resolving to the newest."""
    __tablename__ = "construction_weekly_reports"
    # One row per project, week and version (11/03/2026): two workers cutting
    # the same week, or two Generate clicks, cannot both write version 1 -
    # the loser reads the winner's row. Also in main.py's migration lists.
    __table_args__ = (Index("uq_construction_reports_week_version", "project_id", "week_start", "version",
                            unique=True),)
    id              = Column(String, primary_key=True)
    project_id      = Column(String, nullable=False, index=True)
    week_start      = Column(String, nullable=False, index=True)   # YYYY-MM-DD
    week_end        = Column(String, default="")
    title           = Column(String, default="")   # AI-suggested, manager-editable
    status          = Column(String, default="draft", index=True)
    # draft -> in_review -> approved -> published | superseded
    version         = Column(Integer, default=1)
    supersedes_id   = Column(String, default="")
    # {key: {ai_text, text, sources: [{type, id}], edited_by, edited_at}} - keyed
    # so a renamed heading doesn't invalidate stored content.
    sections        = Column(JSON, default=dict)
    section_order   = Column(JSON, default=list)
    # Denormalized rollups the dashboard reads without touching the log tables.
    stats           = Column(JSON, default=dict)   # {logs, photos, videos, crew_days, hours}
    daily_log_ids   = Column(JSON, default=list)   # provenance: what fed this report
    media_ids       = Column(JSON, default=list)   # curated and ordered by the manager
    milestone_ids   = Column(JSON, default=list)
    rfi_ids         = Column(JSON, default=list)
    submittal_ids   = Column(JSON, default=list)
    cost_exposure   = Column(JSON, default=list)   # [{item, amount, status, note}]
    risks           = Column(JSON, default=list)   # [{risk, severity, mitigation, source}]
    recommendations = Column(JSON, default=list)
    manager_notes     = Column(Text, default="")
    executive_summary = Column(Text, default="")
    pdf_url          = Column(String, default="")
    pdf_generated_at = Column(String, default="")
    # Before and after pairs the manager kept on the report (11/03/2026,
    # ConstructionPhotoPair ids) - printed side by side in the photo log.
    pair_ids         = Column(JSON, default=list)
    generated_by     = Column(String, default="")  # who triggered the AI draft
    generated_at     = Column(String, default="")
    approved_by      = Column(String, default="")
    approved_at      = Column(String, default="")
    published_at     = Column(String, default="")
    ai_model         = Column(String, default="")
    created_at       = Column(String, default="")
    modified_at      = Column(String, default="")
    deleted_at       = Column(String, default="")


class ConstructionMilestone(Base):
    """Schedule milestones. AI can DETECT that one looks hit (from photos and
    notes) but never marks it complete: `ai_detected_at` is a suggestion a
    manager confirms, because a milestone slipping is a contractual event."""
    __tablename__ = "construction_milestones"
    id             = Column(String, primary_key=True)
    project_id     = Column(String, nullable=False, index=True)
    name           = Column(String, nullable=False)
    description    = Column(String, default="")
    target_date    = Column(String, default="", index=True)
    actual_date    = Column(String, default="")
    status         = Column(String, default="upcoming")   # upcoming|at_risk|hit|missed
    critical       = Column(Boolean, default=False)       # on the critical path
    ai_detected_at = Column(String, default="")           # suggestion, not a state change
    ai_evidence    = Column(JSON, default=list)           # media/log ids that suggested it
    confirmed_by   = Column(String, default="")
    created_at     = Column(String, default="")
    modified_at    = Column(String, default="")
    deleted_at     = Column(String, default="")
    # Milestones moved into the job's task project (11/03/2026): the task
    # milestone (Task.is_milestone) this row became. The row and the table
    # are kept as the record; '' = not moved yet. construction_tasks.
    # migrate_milestones is idempotent on this column.
    migrated_task_id = Column(String, default="", index=True)


class ConstructionRfi(Base):
    """Request for Information. Its own table rather than a task type: an RFI has
    a ball-in-court party and a response deadline that drive cost exposure, and
    the weekly report prints open ones by age."""
    __tablename__ = "construction_rfis"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, nullable=False, index=True)
    number        = Column(String, default="")
    subject       = Column(String, default="")
    question      = Column(Text, default="")
    answer        = Column(Text, default="")
    status        = Column(String, default="open", index=True)   # open|answered|closed|void
    ball_in_court = Column(String, default="")   # party owing the response
    submitted_by  = Column(String, default="")
    submitted_on  = Column(String, default="")
    due_on        = Column(String, default="")
    answered_on   = Column(String, default="")
    cost_impact          = Column(Float, default=0.0)
    schedule_impact_days = Column(Integer, default=0)
    # The Nexus person who owes the answer (11/03/2026) - what puts an RFI in
    # their Approvals inbox ("RFI responses due to me"). Ball In Court stays
    # the party in words (the architect, the GC); '' = no one named.
    responder_email = Column(String, default="", index=True)
    created_at    = Column(String, default="")
    modified_at   = Column(String, default="")
    deleted_at    = Column(String, default="")


class ConstructionSubmittal(Base):
    """Submittal register. Same shape as an RFI but a different lifecycle -
    approval with revisions rather than a question and an answer."""
    __tablename__ = "construction_submittals"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, nullable=False, index=True)
    number        = Column(String, default="")
    title         = Column(String, default="")
    spec_section  = Column(String, default="")
    status        = Column(String, default="pending", index=True)
    # pending|submitted|approved|approved_as_noted|revise_resubmit|rejected
    revision      = Column(Integer, default=0)
    submitted_by  = Column(String, default="")
    submitted_on  = Column(String, default="")
    due_on        = Column(String, default="")
    returned_on   = Column(String, default="")
    document_urls = Column(JSON, default=list)
    # The Nexus person who decides it (11/03/2026) - a submittal awaiting
    # their decision is in their Approvals inbox. '' = no one named.
    approver_email = Column(String, default="", index=True)
    created_at    = Column(String, default="")
    modified_at   = Column(String, default="")
    deleted_at    = Column(String, default="")


class ConstructionActivity(Base):
    """Append-only audit trail. Every state change a human or the AI made, with
    enough context to answer "who changed this executive summary, and what did it
    say before" - the question that gets asked exactly once, in a meeting, about
    a report that already went to an investor."""
    __tablename__ = "construction_activity"
    id          = Column(String, primary_key=True)
    project_id  = Column(String, default="", index=True)
    entity_kind = Column(String, default="", index=True)   # log|media|report|milestone|rfi|submittal
    entity_id   = Column(String, default="", index=True)
    type        = Column(String, default="")   # created|submitted|ai_processed|edited|approved|published
    actor_email = Column(String, default="", index=True)   # "" = the AI pipeline
    at          = Column(String, default="", index=True)
    detail      = Column(String, default="")
    before      = Column(JSON, default=dict)   # only for edits to published content
    after       = Column(JSON, default=dict)


class ConstructionJobLink(Base):
    """What a Job is connected to in the modules that own the work (Neil,
    11/03/2026, plan phase 2): ONE link table owned by Construction, so no
    other module's table grows a construction column.

      kind       ref_id                 owner of the thing
      ticket     task_tickets.id        Tickets - the job's source ticket(s)
      checkout   item_checkouts.id      Items - equipment out to the job
      sub        Intacct VENDORID       Accounting - a subcontractor on the job (Round Two
                                        item 7, 11/05/2026; `note` is the trade; papers in
                                        vendor_compliance)

    A link is never deleted: `ended_at` closes it (a checkout returned to a
    different job, an unlinked ticket) so the history of what the job used
    stays. `id` may be made by the phone (idempotent create - the offline
    outbox resends it). Unique by (project_id, kind, ref_id) in practice:
    the routes look the pair up first.

    Form entries do NOT live here: DocFormEntry already carries its own link
    (forms.py's /entries/{id}/link), which a job reuses."""
    __tablename__ = "construction_job_links"
    id          = Column(String, primary_key=True)
    project_id  = Column(String, nullable=False, index=True)
    kind        = Column(String, nullable=False, index=True)   # ticket | checkout | sub
    ref_id      = Column(String, nullable=False, index=True)
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    ended_at    = Column(String, default="")
    note        = Column(String, default="")


# ── Field and Closeout (Neil, 11/03/2026, plan phase 3) ──────────────────────
# Five construction-owned tables. Each has its RLS line in main.py's
# Postgres list (see this module's docstring). Nothing here is ever
# hard-deleted: `deleted_at` (a pair taken apart, a ticket voided) or a
# status keeps the history.

class ConstructionPhotoPair(Base):
    """Before and after: two photos of the same spot, picked by a person and
    shown side by side in the timeline, the photo report and the weekly
    report. Two media ids, never copies of the files."""
    __tablename__ = "construction_photo_pairs"
    id              = Column(String, primary_key=True)
    project_id      = Column(String, nullable=False, index=True)
    before_media_id = Column(String, nullable=False, index=True)
    after_media_id  = Column(String, nullable=False, index=True)
    caption         = Column(String, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    deleted_at      = Column(String, default="")


class ConstructionPunchMeta(Base):
    """What Construction knows about a punch item that a task does not hold:
    its spot on the site (location text), the photo that proves Done, and
    who verified it when. The item itself stays a task in the job's task
    project (construction_tasks) - Tasks owns it; this side row is keyed on
    the task id, so no Tasks column grows for construction."""
    __tablename__ = "construction_punch_meta"
    task_id        = Column(String, primary_key=True)
    project_id     = Column(String, nullable=False, index=True)
    location_text  = Column(String, default="")
    done_media_id  = Column(String, default="")
    done_photo_url = Column(String, default="")
    done_by        = Column(String, default="")
    done_at        = Column(String, default="")
    verified_by    = Column(String, default="")
    verified_at    = Column(String, default="")
    modified_at    = Column(String, default="")


class ConstructionFieldTicket(Base):
    """Extra work signed on site - a time and material ticket (Neil,
    11/03/2026). Quantities only (labor hours, materials), never prices: the
    crew writes it and the customer signs it on the phone; a job manager
    prices it as a change order (ConstructionChangeOrder.field_ticket_id).
    `id` may be made by the phone (the offline outbox sends it).

    status: open (written, not signed) | signed | priced (a change order was
    made from it) | void."""
    __tablename__ = "construction_field_tickets"
    id             = Column(String, primary_key=True)
    project_id     = Column(String, nullable=False, index=True)
    number         = Column(String, default="")          # FT-001, per job
    work_date      = Column(String, default="")          # YYYY-MM-DD, jobsite-local
    description    = Column(Text, default="")
    labor          = Column(JSON, default=list)          # [{email, name, hours}]
    labor_hours    = Column(Float, default=0.0)
    labor_from_punches = Column(Boolean, default=False)  # prefilled from the day's Time Clock punches
    materials      = Column(JSON, default=list)          # [{description, quantity, unit}]
    photo_urls     = Column(JSON, default=list)          # construction-media, this job's folder
    customer_name  = Column(String, default="")
    customer_email = Column(String, default="")
    signature_url  = Column(String, default="")          # the drawn / typed signature PNG
    signed_name    = Column(String, default="")
    signed_at      = Column(String, default="")
    status         = Column(String, default="open", index=True)
    change_order_id = Column(String, default="", index=True)
    created_by     = Column(String, default="", index=True)
    created_at     = Column(String, default="")
    modified_at    = Column(String, default="")
    deleted_at     = Column(String, default="")


class ConstructionChangeOrder(Base):
    """A priced change to the job's contract (Neil, 11/03/2026). Made by a
    job manager, often from a signed field ticket; approved by the owner or
    client through Nexus Sign (HrSignRequest link_kind 'change_order',
    link_id = this id - construction_changes.on_* via esign._link_hook).
    Signing moves the job's contract value by `amount` and its target finish
    by `schedule_impact_days`, once (`applied_at`; before / after kept).

    status: draft | awaiting_approval (an internal approver named) | sent |
    signed | declined | void."""
    __tablename__ = "construction_change_orders"
    id               = Column(String, primary_key=True)
    project_id       = Column(String, nullable=False, index=True)
    number           = Column(String, default="")        # CO-001, per job
    title            = Column(String, default="")
    reason           = Column(String, default="")        # owner_request | unforeseen | design | code | other
    description      = Column(Text, default="")
    amount           = Column(Float, default=0.0)        # + adds to the contract, - credits it
    schedule_impact_days = Column(Integer, default=0)
    field_ticket_id  = Column(String, default="", index=True)
    status           = Column(String, default="draft", index=True)
    approver_email   = Column(String, default="", index=True)   # internal approval first ('' = none)
    approved_by      = Column(String, default="")
    approved_at      = Column(String, default="")
    signer_name      = Column(String, default="")
    signer_email     = Column(String, default="")
    esign_request_id = Column(String, default="", index=True)
    sent_at          = Column(String, default="")
    signed_at        = Column(String, default="")
    declined_at      = Column(String, default="")
    decline_reason   = Column(String, default="")
    applied_at       = Column(String, default="")
    contract_before  = Column(Float, default=0.0)
    contract_after   = Column(Float, default=0.0)
    finish_before    = Column(String, default="")
    finish_after     = Column(String, default="")
    created_by       = Column(String, default="")
    created_at       = Column(String, default="")
    modified_at      = Column(String, default="")
    deleted_at       = Column(String, default="")


class ConstructionCloseoutRecord(Base):
    """What the job hands over (Neil, 11/03/2026): a warranty (item or
    equipment, vendor, start, end, document), a permit or inspection (AHJ,
    number, result, date) or an as-built / O&M document. Close Out writes each
    one to the property in Asset Management through its own per-row API
    (construction_closeout.write_back) and, for an equipment warranty, the
    item's warranty in Items; `written` records where it landed, so a second
    Close Out never writes it twice.

    kind: warranty | permit | inspection | document."""
    __tablename__ = "construction_closeout_records"
    id          = Column(String, primary_key=True)
    project_id  = Column(String, nullable=False, index=True)
    kind        = Column(String, nullable=False, index=True)
    title       = Column(String, default="")       # scope / item covered / document title
    item_id     = Column(String, default="")       # Items: the equipment a warranty covers
    serial      = Column(String, default="")       # the maker's serial, for the item
    vendor      = Column(String, default="")       # warranty party
    start_on    = Column(String, default="")
    end_on      = Column(String, default="")       # warranty expiration
    ahj         = Column(String, default="")       # permit / inspection authority
    number      = Column(String, default="")       # permit number
    result      = Column(String, default="")       # passed | failed | partial | pending
    date_on     = Column(String, default="")       # issued / inspected / document date
    # Live from day one (Round Two, 11/05/2026): an inspection's scheduled
    # day. The day before, the superintendent is belled; a Failed one bells
    # the managers. '' = not scheduled.
    due_on      = Column(String, default="")
    category    = Column(String, default="")       # document: as_built | om_manual | certificate | other
    doc_url     = Column(String, default="")       # construction-media, this job's folder
    doc_name    = Column(String, default="")
    notes       = Column(Text, default="")
    written     = Column(JSON, default=dict)       # {asset: {collection, id, at, by}, item: {id, at, by}, error}
    created_by  = Column(String, default="")
    created_at  = Column(String, default="")
    modified_at = Column(String, default="")
    deleted_at  = Column(String, default="")


class VendorCompliance(Base):
    """A subcontractor's papers (Round Two item 7, Neil, 11/05/2026). The
    vendor is Intacct's - its VENDORID, through Accounting > Vendors &
    Customers - and Nexus keeps only what Intacct does not: when the
    certificate of insurance and the workers comp certificate expire, the
    license, whether a W-9 is on file. One row per vendor id, made when a sub
    is first put on a job or its papers first saved; `vendor_name` is a copy
    of Intacct's name so the Subs tab and the expiry bells never call the
    accounting app. Never a vendor directory: no address, no contact, no
    terms live here."""
    __tablename__ = "vendor_compliance"
    vendor_id          = Column(String, primary_key=True)
    vendor_name        = Column(String, default="")
    coi_expires_on     = Column(String, default="")   # general liability certificate of insurance
    wc_expires_on      = Column(String, default="")   # workers compensation certificate
    license_number     = Column(String, default="")
    license_expires_on = Column(String, default="")
    w9_on_file         = Column(Boolean, default=False)
    notes              = Column(Text, default="")
    updated_by         = Column(String, default="")
    updated_at         = Column(String, default="")


class ConstructionDrawing(Base):
    """One sheet of a Project's drawing set (Round Two item 9, Neil,
    11/06/2026): a register, no pins. A new revision of a sheet number makes
    the one before it `superseded` (kept, `superseded_by` the new row) and
    bells the crew and the managers. The file is a construction_media row of
    kind `drawing` (`media_id`) - the same upload and the same Egnyte sweep
    as every job file, filed to `<job folder>/Drawings`. Never hard-deleted:
    Remove stamps `deleted_at`."""
    __tablename__ = "construction_drawings"
    id            = Column(String, primary_key=True)
    project_id    = Column(String, nullable=False, index=True)
    sheet_number  = Column(String, nullable=False, index=True)   # A-201
    title         = Column(String, default="")
    discipline    = Column(String, default="")                   # architectural | structural | ...
    revision      = Column(String, default="")                   # 3, B, IFC
    revision_on   = Column(String, default="")                   # YYYY-MM-DD
    media_id      = Column(String, default="")
    file_url      = Column(String, default="")                   # construction-media, this job's folder
    file_name     = Column(String, default="")
    status        = Column(String, default="current", index=True)   # current | superseded
    superseded_by = Column(String, default="")
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    modified_at   = Column(String, default="")
    deleted_at    = Column(String, default="")


class ConstructionCommitment(Base):
    """A subcontract or purchase order on a job (Round Two item 8, Neil,
    11/06/2026) - what the job has promised to pay a vendor, so Committed is
    real. The vendor is Intacct's (its VENDORID, picked like a sub); what was
    billed against it is READ from the books (the job's Project-Job lines for
    that vendor), never typed here. `amount` is the current value; a change
    to it needs a reason, kept as a `commitment_changed` activity row with
    before / after. `original_amount` is what was first signed.

    Lien waivers received for it are `waivers` (JSON list, newest last):
    {id, kind conditional_progress | unconditional_progress |
    conditional_final | unconditional_final, throughOn, amount, receivedOn,
    fileUrl, fileName, by, at, removedAt}. A removed waiver keeps its row.

    kind: subcontract | purchase_order. status: active | closed | void -
    never deleted."""
    __tablename__ = "construction_commitments"
    id              = Column(String, primary_key=True)
    project_id      = Column(String, nullable=False, index=True)
    number          = Column(String, default="")          # SC-001 / PO-001, per job and kind
    kind            = Column(String, default="subcontract")
    vendor_id       = Column(String, default="", index=True)
    vendor_name     = Column(String, default="")          # Intacct's name, copied
    title           = Column(String, default="")          # the scope
    original_amount = Column(Float, default=0.0)
    amount          = Column(Float, default=0.0)
    retainage_pct   = Column(Float, default=0.0)          # 0-20, held from each payment
    status          = Column(String, default="active", index=True)
    contract_url    = Column(String, default="")          # construction-media, this job's folder
    contract_name   = Column(String, default="")
    waivers         = Column(JSON, default=list)
    notes           = Column(Text, default="")
    created_by      = Column(String, default="")
    created_at      = Column(String, default="")
    modified_at     = Column(String, default="")
