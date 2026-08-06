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
from sqlalchemy import BigInteger, Boolean, Column, Float, Integer, JSON, String, Text
from database import Base


class ConstructionProject(Base):
    """A jobsite.

    A jobsite has a contract value, a general contractor, a phase, and a weekly
    reporting cadence that mean nothing to a leased building or a software
    project.

    INDEPENDENT OF THE TASK MODULE (Sagar, Aug 4). There is deliberately no
    task_project_id and no import from the tasks packages: a construction project
    is not a TaskProject and must not be modeled as one, joined to one, or made
    to depend on one. A jobsite outlives any punch list kept about it, and the
    two have different lifecycles, permissions and audiences. If the two ever
    need to reference each other, that belongs in a separate mapping table owned
    by whoever wants the link - not as a column here."""
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
    # pending | uploaded | failed | skipped(too_large) - drives the retry sweep
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
    status        = Column(String, default="queued", index=True)  # queued|running|done|error|dead
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
