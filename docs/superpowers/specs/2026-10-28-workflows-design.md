# Workflows - design (Oct 28 2026)

Owner: Neil. Written by Claude with the calls marked **[my call]**. Neil's own decisions are marked **[Neil]**.

## 1. Intent

Nexus has grown into twenty-odd modules that each know how to do one thing. The
work BETWEEN them is still done by people remembering: HR remembers to tell the
manager the probation is ending, a manager remembers to chase an unsigned Time
Sheet, somebody remembers that a leaver's laptop needs to come back. Workflows
is the one place where "when X happens, do Y" is written down once and then
happens every time, across every module, with a record of what it did and why.

Neil's brief: "a really, really powerful tool", "automations throughout the
entire app", "enterprise grade", "should auto improve as the app improves",
"creative and intuitive, but robust".

Two things already exist and shape this:

- **Tasks has a working rules engine** (`backend/task_automation.py`, Manage >
  Automation Rules): triggers, conditions, actions, a run log, no-chaining
  guards, creation budgets and an hourly scheduled trigger. Its design rules
  are right and Workflows adopts them. It stays the engine for in-request task
  edits (it mutates the task inside the person's own transaction, which a
  background engine cannot do); Workflows shows those rules in its own list
  and reaches task events after commit.
- **HR has life events** (`hr_life_events.py`): fixed, signed processes
  (offer, hire, promotion, separation, probation). Workflows never replaces a
  signed process; it reacts to it ("when a hiring packet completes, ...").

## 2. Goals, non-goals, anti-goals

**Goals**

1. Any event in any module can start a workflow; any sensible follow-up in any
   module can be an action. The vocabulary grows with the app without
   frontend work (section 5).
2. A manager with no technical background builds one in minutes, reads it back
   as English, and can test it against real recent events before switching it
   on.
3. Every run is explainable: which event, which version of the workflow, what
   each step did, to whom, and why a step was skipped or failed.
4. Nothing a workflow does exceeds what its owner could do by hand. Nothing it
   does is invisible: a changed record says "Workflow: <name>" in its history.
5. A runaway workflow cannot hurt the company: caps, no chaining by default,
   automatic pause, and one-click rollback to the previous version.

**Non-goals (v1)**

- A node canvas. The builder is a vertical recipe ("When / Only if / Do") like
  Asana and the existing Tasks rule editor. Branches indent. (Bundle headroom
  is ~150 KB and a canvas library would spend it on something harder to read.)
  **REVERSED 10/30/2026 (Neil):** the Blueprint canvas, plan
  `docs/superpowers/plans/2026-10-30-workflows-blueprint-canvas.md` - a
  computed layout of the same definition (no stored coordinates, no canvas
  library); the recipe stays as the second view and the phone view.
- Free-form code or expressions. Templating is `{{ path }}` with a picker and
  a short list of filters; conditions are field / operator / value.
- Replacing module-specific engines that must run inside the request: Tasks
  automation rules, ticket auto-assignment, SLA, time-off approval stages.
- External connectors beyond Teams, email and a signed outbound webhook.
  No OAuth "connections" screen.
- Personal automations for every employee **[my call, section 7]**.

**Anti-goals (what makes it a failure even if it works)**

- A workflow that lets someone reach data or people outside their access.
- A workflow that fires other workflows in a loop, or runs hundreds of times
  unnoticed.
- A builder that needs a developer to add a new trigger to the UI.
- Runs that cannot be explained after the fact.

## 3. Constraints (from CLAUDE.md and the codebase)

- Requests are served by several gunicorn workers; background loops run only in
  the elected leader (`leader.elect_and_run`). An in-memory bus cannot reach
  the leader: events go through a database outbox.
- Sessions are `autoflush=False`. `after_commit` also fires on SAVEPOINT
  release (SQLAlchemy 2.0.35; 20 `begin_nested` sites). Outbox rows are written
  INSIDE the transaction, never from `after_commit`.
- Never block the event loop: the runner is `await asyncio.to_thread(_tick)`.
- Shared files are append-only (models.py, main.py migration lists, api.js,
  App.jsx, Sidebar.jsx). Visesh's files are never edited; Items events come
  from the generic record observer (section 5.3), not from `items.py`.
- New tables: model + create_all + RLS line in the Postgres migration list +
  `get_advisors` after release. High-churn tables go in
  `audit_capture.NOISE_TABLES`.
- Copy rules: Title Case titles, American English, MM/DD/YYYY, 12-hour times,
  "Time Sheet", no em dashes. Popups are 60vw with `nx-fill`.
- Notifications are server-side only, one per workflow updated in place where a
  list would spam (`notify_rollup.upsert_rollup`).

## 4. Vocabulary (what a user sees)

| Word | Meaning |
|---|---|
| Workflow | One automation: a trigger, optional conditions, ordered steps, settings. Has an owner, a scope (one company or every company), a status and a version. |
| Trigger | What starts it: an **event** ("Time off is approved"), a **schedule** ("Every Monday at 8:00 AM"), a **date** ("14 days before probation ends"), or **manual** ("Run on a person"). |
| Condition | "Only if" checks on the event's record: field, operator, value. Groups are AND; several groups are OR. |
| Step | One thing to do, in order. Kinds: **Action**, **If / Else**, **Ask For Approval**, **Wait**, **For Each**, **Stop**. |
| Run | One execution of one workflow for one event. Has steps with status, inputs and outcome. |
| Version | Every Publish is a new version; runs name the version they ran. |
| Template | A ready-made workflow with blanks to fill. |

Status of a workflow: `draft` (never published), `active`, `paused` (by a
person), `needs_attention` (paused by the system: runaway, owner gone, action
no longer exists), `archived`.

## 5. The catalog: how Workflows grows with the app

The catalog is the contract between backend and builder. The frontend renders
only what `GET /workflows/catalog` returns; nothing about a trigger, field,
condition or action is hard-coded in the UI. This is the "auto improve"
mechanism, and it is enforced by tests, not goodwill.

### 5.1 Entities

`backend/workflows/entities.py` registers each kind of record a workflow can be
about:

```python
@entity("employee", label="Person", model=NexusEmployee,
        company=lambda row: row.company,
        link=lambda row: {"view": "hr", "sub": f"people:{row.id}"},
        people={"self": ..., "manager": ..., "hr_contact": ...},
        fields=[F("name", "Name", "text"), F("department", "Department", "select", options="departments"),
                F("start_date", "Start Date", "date"), F("manager_email", "Manager", "person"), ...],
        dates=["start_date", "probation.end", "contract_end", "birthday"])
```

Entities in v1: employee, candidate, time_off_request, task, ticket, timesheet
(review period), shift, punch, item_checkout, item_assignment, letter_request,
salary_advance, extra_time_claim, headcount_request, approval (generic).

Fields carry a type (text, number, date, datetime, select with an options
source, person, people, bool, money) and a `visibility` (`all`, `hr`,
`comp`) so a workflow whose owner cannot see pay never offers a pay field.

### 5.2 Events

```python
@event("hr.time_off.decided", entity="time_off_request", label="Time Off Is Decided",
       module="hr", group="Time Off",
       changes=["status"],            # from/to available to conditions and templates
       sample=SAMPLE_TIME_OFF)        # a realistic payload; tests and the dry-run use it
```

An event has: a stable key, its entity, the module and group it shows under,
which fields carry a from/to, a sample payload and a `may_use(db, user)` rule
(default: the owner must be able to read that entity's module). Modules emit
with one call at their choke point:

```python
workflows.emit(db, "hr.time_off.decided", subject=row, actor=user["email"],
               changes={"status": (old, new)}, extra={"note": body.note})
```

`emit` writes a `workflow_events` outbox row on `session.connection()` inside
the caller's transaction (the `audit_capture` pattern). A rollback drops it
with everything else. It never raises into the caller.

**Volume [my call].** An event declares `volume="normal"` (default) or
`volume="high"` (punches, observed field changes on `time_punches`,
`task.commented`). Normal events are always written, so Test With A Recent
Event has real rows from day one; high-volume events are written only while
an active workflow subscribes to that key (the loop refreshes the subscribed
set every minute and stores it in a NexusSetting the request workers read
through `scoped_settings`' cache). Rows nobody subscribed to are purged
quietly at 7 days; the 7-day drop notice is only for rows a workflow wanted
and the loop never processed. The module is ON for every company at release:
events flow, nothing runs until someone publishes a workflow.

**Events in v1** (choke points found in recon; each is one `emit` line):

- HR: `employee.hired`, `employee.status_changed` (`apply_status_change`),
  `employee.field_changed` (observer: department, manager, title, company,
  employment_type, location), `employee.custom_field_changed`,
  `probation.started` / `probation.decided`, `time_off.requested` /
  `time_off.decided` / `time_off.cancelled`, `letter.requested` /
  `letter.decided`, `salary_advance.requested` / `salary_advance.decided`,
  `headcount.requested` / `headcount.decided`, `candidate.stage_changed`,
  `candidate.hired`, `life_event.completed` (offer / hire / promotion /
  separation / probation), `extra_time.claimed` / `extra_time.decided`.
- Tasks: `task.created`, `task.status_changed`, `task.assigned`,
  `task.completed`, `task.commented`, `task.due_date_changed`
  (from `routers/task_util.log_activity`, one choke point).
- Tickets: `ticket.filed`, `ticket.assigned`, `ticket.status_changed`,
  `ticket.resolved`, `ticket.reopened`, `ticket.escalated`,
  `ticket.commented`, `ticket.approval_requested` / `ticket.approval_decided`.
  Confidential-desk tickets emit only to workflows whose owner may read them.
- Time: `timesheet.review_changed` (`timesheet_review._round`, every
  transition), `punch.in` / `punch.out` (observer on `time_punches`, rate
  capped), `period.closed`, `time.add_time_batch`.
- Shifts: `shift.shared`, `shift.changed`, `shift.removed`, `shift.claimed`,
  `shift.no_show`, `weather_call.decided` (`shift_log.record` plus the no-show
  scan).
- Items (observer, Visesh's files untouched): `item_checkout.status_changed`,
  `item_assignment.status_changed`.
- Approvals: `approval.waiting` is not an event; it is a scheduled condition
  ("an approval older than N days", read through `approvals_inbox.collect`).

### 5.3 The record observer (events for free)

`backend/workflows/observer.py` is an `after_flush` listener like
`audit_capture`. For every model registered as an entity with
`observe=True`, it emits `<entity>.created` and `<entity>.field_changed` with
the per-field from/to it reads from `inspect(obj).attrs[x].history`. This is
how a module gets basic triggers without writing a line, how Items gets
events without touching Visesh's file, and what keeps Workflows current when a
column is added: a new field on an observed model shows up in the builder the
next deploy. Bulk `query.update()` writes are not seen (documented, same as
the audit stream).

### 5.4 Actions

```python
@action("notify", label="Send A Notification", module="core",
        params=[P("to", "To", "recipients"), P("title", "Title", "template", max=120),
                P("body", "Message", "template", max=1000)],
        plan=_notify_plan,     # dry-run: "Would notify Priya Shah and 2 others: ..."
        run=_notify_run)       # idempotent on (run_id, step_id)
```

Every action declares typed params (the builder renders the right control:
recipients picker, template box with the field picker, task project picker,
...), a `plan` for the dry-run, a `run`, and `allowed(db, run_as_user, ctx)`:
the action calls the module's OWN function as the run-as user, so the module's
permission checks run. An action the owner may not perform is not offered in
the builder and is refused at run time with a readable reason.

**Actions in v1**

- Core: Send A Notification (bell, through `notify_rollup`), Send An Email
  (themed, `graph_mail`, Nexus directory recipients only), Post To Teams
  (through the existing Teams queue as a new `kind="workflow"`; **[my
  call]** it posts AS THE OWNER through the delegated-token path the ticket
  DMs use, to a 1:1 chat with each recipient or to one of the owner's own
  group chats (picker), no channels in v1; an owner with no live Nexus
  session retries for 48 hours like a ticket DM, then the step fails;
  not offered under the Nexus run-as, which has no token), Wait (for a
  duration / until a date field plus offset / until the next business morning
  in the subject's company zone), Ask For Approval (section 6.4), Stop.
- Tasks: Create Task (through `routers.tasks._create_task` as the run-as
  user, exactly as `task_automation` does), Add Comment, Assign, Set Status /
  Priority / Custom Field.
- Tickets: Create Ticket (`tickets.file_ticket`), Add Comment, Assign, Set
  Status, Request Approval.
- HR: Start Checklist (an HR checklist template for the person), Create
  Letter Request, Set Custom Field (HR Only fields need an HR owner), Add
  Note To Record. Never: change pay, change status, start a life event.
- Time: Send Back Time Sheet is NOT an action (a human decision). Remind
  (notification) is.
- Global Admin only: Call A Webhook (POST, JSON, HMAC-signed with a per-URL
  secret kept in `secret_box` (its key is the existing env secret),
  allow-listed hosts in Settings > Workflows, 10 s timeout, 3 retries).

### 5.5 Recipients

A `recipients` param resolves to Nexus directory people from: the subject's
people (`self`, `manager`, `hr_contact`, `assignees`, `creator`,
`followers`, `approver`), a named person, a role in the company (HR contact,
Global Admins), a department or team (through `kb_audience.members`), or
"everyone in the company" (capped, see 6.5). Every resolved recipient is
checked with the entity's own visibility rule (`recipient_can_see`) before a
message about a record goes out.

### 5.6 Templates in text

`{{ subject.name }}`, `{{ change.status.from }}` / `{{ change.status.to }}`,
`{{ actor.name }}`, `{{ today }}`, `{{ subject.start_date | us_date }}`,
`{{ subject.link }}`. Filters: `us_date`, `us_datetime`, `upper`, `lower`,
`default:"-"`. Unknown paths render blank and the dry-run flags them. The
builder has a field picker; nobody types a path.

### 5.7 Guards that keep the catalog honest (CI)

- `test_workflow_catalog.py`: every `workflows.emit("<key>"` call site in the
  backend (AST scan) names a registered event; every event's sample validates
  against its entity's fields; every action's `plan` and `run` exist and run
  against the sample; every entity's `link` resolves.
- `workflow_catalog.lock.json` is a committed snapshot of the catalog. A PR
  that changes the catalog must update it (one command), so the diff is in
  the PR for review and What's New can say "3 new triggers".
- The builder shows "New" on catalog entries added since the person last
  opened Workflows (`last_catalog_seen` on the person).
- `test_event_loop_blocking.py` lists the runner loop.

## 6. The engine

### 6.1 Tables (all new, RLS on, ids are uuid strings, times ISO UTC)

- `workflows`: id, name, description, owner_email, company_id ('' = every
  company), status, version (int, current published), trigger JSON, steps
  JSON, settings JSON, draft JSON (unpublished edits), created_by/at,
  updated_by/at, last_run_at, run_count, fail_count, paused_reason,
  archived_at.
- `workflow_versions`: id, workflow_id, version, definition JSON (trigger +
  steps + settings), published_by, published_at, note.
- `workflow_events` (outbox, NOISE): id, key, entity, subject_id, company_id,
  actor, payload JSON, caused_by_run ('' or run id), at, processed_at,
  attempts, error.
- `workflow_runs`: id, workflow_id, version, event_id, trigger_kind,
  entity, subject_id, subject_label, company_id, status (`running`,
  `waiting`, `succeeded`, `failed`, `skipped`, `cancelled`, `test`), started_at,
  finished_at, summary (one English line), error, dedupe_key, replay_of.
- `workflow_run_steps` (NOISE): id, run_id, step_id, kind, label, status,
  started_at, finished_at, input JSON (resolved params), output JSON, detail.
- `workflow_waits`: id, run_id, step_id, due_at, kind (`delay`, `approval`),
  state JSON, claimed_at. The resume queue.
- `workflow_approvals`: id, run_id, step_id, workflow_name, subject_label,
  approvers JSON, mode (`any`, `all`, `sequence`), responses JSON, outcome,
  asked_at, decided_at, link JSON. Surfaced by an `approvals_inbox` `@source`.
- `workflow_subject_marks`: workflow_id, entity, subject_id, last_run_at (for
  "once per record" and cooldowns), PK on the three.

### 6.2 Flow of one event

1. A module calls `emit` inside its transaction. The outbox row commits with
   the change or not at all.
2. `workflows_loop` (leader only, every 5 s, `to_thread`) claims up to 200
   unprocessed rows with a conditional UPDATE (`ops_report_schedules._claim`
   pattern) and, per row, loads the active workflows whose trigger matches
   the key and whose scope admits the subject's company.
3. For each match: enrollment checks (section 6.5), trigger filters, then
   conditions, against the subject re-read from the database plus the
   event's from/to. A miss is a `skipped` run only when the workflow's
   settings ask to log skips (default off; the count is kept).
4. A run starts; steps execute in order as the run-as user (section 7).
   An action's effect is committed step by step so a crash leaves a readable
   trail; each step is idempotent on (run_id, step_id) so a retried tick
   never does it twice.
5. A Wait or Ask For Approval writes a `workflow_waits` row and the run goes
   `waiting`. The loop resumes due waits every tick. Approval decisions
   resume immediately through the decide endpoint.
6. The run finishes `succeeded` or `failed`; the workflow's counters update;
   a failure runs the workflow's fault steps (section 6.6) if any.

**Workflows and the Tasks engine [my call].** A workflow's Set Status /
Assign / Set Field on a task goes through `update_task` as the owner, so
Tasks automation rules run on it exactly as on the owner's own edit; a task
a workflow creates runs no Tasks rule (`_SUPPRESS`, as `task_automation`'s
own create does). Task events written by a Tasks rule inside a
workflow-caused request carry `caused_by_run` like every other effect of
that run; a Tasks rule reacting to a PERSON's edit emits ordinary events.
So: person edits -> Tasks rule -> ordinary event -> workflow runs -> its
task change -> Tasks rule -> event tagged with the run -> ignored. No
ping-pong is possible without `allowDownstream`, and even then depth 2
ends it. Tasks rules appear in the Workflows list under Automations with an
enable / disable switch (through their own endpoint) and a link to Tasks >
Manage for editing; their runs are not counted in the Workflows overview.

Events a run causes carry `caused_by_run`. A workflow with
`allowDownstream=false` (default) ignores them; one with it on runs at depth
1 only. A chain never exceeds depth 2. **[my call, adopted from Tasks]**

### 6.3 Schedules and date triggers

- Schedule: `{kind: "schedule", every: "day"|"week"|"month", days: [...],
  time: "08:00", zone: "company"}` runs once per period per workflow per
  company (dedupe key `wf:company:period`). "Company time" is the company's
  Shifts `timeZone` (there is no company timezone column; this is the one
  the app already treats as the team's clock) **[my call]**. The run's
  subject is the company; the workflow then usually uses For Each ("for
  each person whose probation ends within 14 days", a catalog **list
  source** such as `employees.probation_ending`, `approvals.older_than`,
  `timesheets.unsigned`, `tasks.overdue`, `tickets.breaching_sla`).
- Date: `{kind: "date", entity: "employee", field: "probation.end",
  offset_days: -14, time: "08:00"}` fires once per subject per date
  (`wf:subject:date`), evaluated daily in the loop against the entity's
  registered date fields. Anniversaries and birthdays are date fields with
  `yearly=True`.
- Manual: `{kind: "manual", entity: "employee"}`: a Run dialog INSIDE
  Workflows (the workflow's row and page) with the entity's subject picker,
  scoped by the runner's access; the run records who pressed it. No module
  screen gets a button in v1 **[my call]** (Items screens are Visesh's and
  the big shared views stay untouched); a later pass can add "Run A
  Workflow" to record menus.

### 6.4 Ask For Approval

Params: approvers (recipients), mode (`any` first to respond, `all`
everyone, `sequence` one after another), question, options (default Approve
/ Decline; custom labels allowed), remind after N days, expire after N days
(then the `expired` branch). Each outcome is a branch of following steps.
The ask is a row in Approvals (an `@source("workflow")` row with the
question, the subject link and the option buttons) and a bell to each
approver; the decision goes through `POST /workflows/approvals/{id}/decide`,
which checks the decider is an approver, records the response and resumes the
run. Nobody approves a workflow ask about themselves unless the workflow says
so (`allowSelf`, off). The approval row names the workflow and the version.

### 6.5 Enrollment and safety

Per-workflow settings (defaults in brackets): `oncePerSubject` [off],
`cooldownHours` [0], `suppress` (people and companies never acted on) [none],
`logSkips` [off], `allowDownstream` [off], `maxRunsPerHour` [100, hard cap
500], `maxRecipients` [50, hard cap 200], `onError` [`stop`] with optional
fault steps.

The loop is one thread with a per-tick budget (about 20 s of work, then
the rest waits for the next tick); because every step commits and is
idempotent, a long run simply resumes. Confidential-desk tickets are read
with `include_confidential=True` and then checked against the run-as user
before anything about them leaves the engine.

System guards (not settings): 25 steps per workflow, 10 nested levels, For
Each over at most 500 items, one action at most 20 s, a run at most 10 min
of active work, outbox rows older than 7 days are dropped unprocessed with a
notice. When a workflow exceeds `maxRunsPerHour` it goes `needs_attention`
("Paused: ran 100 times in an hour") with a bell to its owner and the Global
Admins; same when its owner leaves, loses the grant, or an action in it no
longer exists after a deploy.

### 6.6 Errors, retries, replay

A step that raises is retried 3 times with backoff (1, 5, 15 min) when the
error is transient (Graph, network, lock timeout), else fails at once. On
failure the run's fault steps run (typically "notify the owner"), the run is
`failed` with the step's error, and the owner can **Replay** from the failed
step after fixing the cause (a new run with `replay_of`). Nothing is ever
silently swallowed: every skip, retry and failure is a step row.

### 6.7 Versions and rollback

Edits land in `draft`; the active version keeps running until Publish.
Publish validates (section 8.1), writes a `workflow_versions` row, bumps
`version`, clears `draft`. Versions tab: list, English diff between two
versions ("Step 3: recipients changed from Manager to Manager, HR Contact"),
Restore (publishes that definition as a new version). Runs show their
version; a replay uses the current version and says so.

### 6.8 Testing before go-live

- **Test With A Recent Event**: pick one of the last 50 real outbox rows of
  the trigger's kind (within the person's scope) or the catalog sample;
  the engine runs in plan mode: conditions evaluated and shown pass/fail
  with the values, every action's `plan` line (recipients named, text
  rendered, task title shown), waits shown as "would wait until
  11/12/2026 8:00 AM". No side effects, nothing written but a
  `workflow_runs` row with status `test`.
- **Preview A Schedule**: "If this ran now: 4 people" with the list.
- A workflow cannot be published until it has been tested once since its last
  edit **[my call]**; the Publish dialog shows the last test's summary.

## 6.9 Managing every automation, and reviewing what it did **[Neil, Oct 28 2026]**

Neil: "automations should be managed, and workflows should be managed, all
of this requires a good ability to turn these off as well as review the
action that results."

**Off switches, top to bottom.** Each one stops everything below it and
says so on every affected screen:

1. **Everything off** (Settings > Workflows, Global Admin): the runner
   stops starting runs; events still queue for 7 days so switching back on
   loses nothing recent. The module header shows "All workflows are
   paused by <name> since <time>".
2. **A company off** (Settings > Workflows with a company picked): no run
   starts for that company's records; its workflows show "Paused: company
   switch".
3. **One workflow off** (Pause on its row or page; full-level users may
   pause anyone's in their scope).
4. **One step off**: a step can be disabled in the builder without
   deleting it (a "Skip" toggle on the card); the run log shows it as
   skipped.
5. **Tasks automation rules** appear in the Workflows list under
   "Automations" with their own enable / disable switch, saved through the
   Tasks rule endpoint (`PATCH /task-automation-rules/{id}`), so one screen
   turns off every rule in the company. Their runs open from the same row
   (the Tasks Runs panel data, `GET /task-automation-runs`).
6. **Built-in automations** (the background jobs: reminders, no-show scan,
   overtime watch, weekly scorecard, ...) are listed read-only in the same
   place with what they do, how often, and a link to the setting that
   controls them where one exists. A per-job kill switch is a follow-up
   **[my call: not in this release; it touches 30 loop files]**.

**Reviewing what happened.** The Runs screen gets an **Actions** view:
every step that changed something or sent something, newest first, across
workflows, with filters (workflow, action kind, person affected, date) and
each row saying what, to whom, and which record (a link). A run drawer
shows the step timeline with inputs and outputs. Every record a workflow
touched shows "Workflow: <name>" in its own history with a link to the run.
A failed run always bells the owner, fault steps or not. Publish, pause,
resume, re-own and restore write an AuditLog row (module `workflows`), so
Settings > Logs shows who changed what. The weekly owner digest (Monday,
opt-in in Settings) lists each owned workflow's runs, failures and what it
did most.

## 7. Who can do what

Grant `workflows` (Settings > People & Access), with the levels every module
uses:

| Level | May |
|---|---|
| viewer | See workflows and runs within their company scope. |
| editor | Create and publish workflows they own, within their own access; test; pause their own. |
| full | Everything in their company scope: edit, pause, re-own, archive others'; manage templates for the company. |
| owner / Global Admin | Every company; "Every company" scope; webhooks; Settings > Workflows. |

**Run-as is the owner [my call].** Every action runs with the owner's
identity and the module's own permission checks. A workflow cannot notify,
read or change anything its owner could not. Re-owning a workflow re-runs
the validation against the new owner. A Global Admin may set run-as to
"Nexus" (a system actor, `workflows@nexus`, for org-wide housekeeping such
as "every Monday, remind everyone with an unsigned Time Sheet"); the run log
says so. **Nexus can only message [my call]:** Send A Notification, Send An
Email, Wait, Stop, If / Else, For Each over a read-only list source. Every
module action (create a task, file a ticket, set a field, start a
checklist, post to Teams) needs a directory person's identity for the
module's own checks, so the builder does not offer them under Nexus and
Publish refuses a definition that has them. No synthetic privileged
identity is built. Changed records are attributed to `workflow:<id>` and the history
line reads "Workflow: <name>".

Not in v1 **[my call]**: personal automations for every employee ("notify
me when..."). The catalog and engine support it (an owner with no grant,
actions limited to self); it is a UI decision for later.

## 8. The builder (frontend)

Module **Workflows** (sidebar Modules group, code WFL, icon Workflow from
lucide, grant `workflows`, minRole supervisor like other granted modules).
Sub routes: `overview`, `list`, `wf:<id>` (builder), `runs`, `run:<id>`,
`templates`, `catalog`.

### 8.1 Screens

- **Overview**: Needs Attention (paused by the system, failing, owner gone),
  Last 24 Hours (runs, success rate), Recent Runs, and a "Start From A
  Template" row.
- **Workflows list**: chips Mine / My Company / Every Company (by grant);
  columns Name, Trigger (English), Scope, Owner, Status, Runs (7d), Last
  Run; row actions Pause / Resume / Duplicate / Archive; search with
  `data-slash-search`.
- **Builder** (`wf:<id>`): a page, not a popup. Left: the recipe. Right rail:
  Settings (owner, scope, enrollment, error handling, run-as for GA), Test,
  Versions. Top: name, status chip, Save Draft, Test, Publish. Since
  10/30/2026 the desktop default is the Blueprint canvas
  (`wf:<id>:run:<runId>` replays a run on it); the recipe is the second view
  and the phone view - see the Non-goals note.
  - **When** card: trigger kind tabs (Event / Schedule / Date / Manual); the
    event picker groups by module, searchable, "New" badges; after choosing,
    trigger filters appear (e.g. "status changed to: Approved").
  - **Only If** card: condition groups; each row field / operator / value
    with the control the field type dictates (DateField, person picker,
    select from the options source). Operators per type: is, is not, is
    any of, contains, is empty, is not empty, greater / less than, before /
    after, within the next N days, changed, changed from, changed to.
  - **Do** steps: each step a card with the action's icon, an English
    summary when collapsed, the params when open. Add Step menu grouped by
    module with search. If / Else and Ask For Approval show their branches
    as indented lanes. Drag handle reorders within a lane (`DragList`
    pattern); Move Up / Down for keyboards.
  - Every card renders a sentence ("Email the manager and the HR contact:
    'Probation ends in 14 days'") so the whole workflow reads top to bottom
    as prose. The sentence builder is a pure module with tests
    (`workflowText.js`), like `automationRules.js`.
  - **Describe It** (new workflow only): a text box "Describe what should
    happen" and a Draft It button. `ai_assistant` (ANTHROPIC_API_KEY, already
    used by tickets and KB) is given the catalog and returns a draft
    definition that is validated the same as a hand-built one and shown in
    the builder for editing. Off when no key is set; never publishes by
    itself.
  - Validation (`ruleProblem` style, shared with the backend): every trigger
    has an entity, every param required is set, every recipient resolves,
    every template path exists for this entity, branch outcomes are complete,
    the owner may run every action, scope and owner agree.
- **Runs**: filter by workflow, status, date, subject; keyset paging; a
  run drawer with the step timeline (status, time, input, output, detail),
  the event payload, Replay and Cancel (a waiting run). Links open the
  subject in its module (`nexus:navigate`).
- **Templates**: gallery cards grouped by module ("New Hire Welcome And
  Equipment", "Probation Ending Reminder", "Unsigned Time Sheet Chase",
  "Ticket Unanswered For 2 Business Days", "Leaver Offboarding Kit", "Time
  Off Approved: Tell The Team", "Overdue Task Escalation", "Contract Ending
  In 30 Days", "Work Anniversary"). Use Template copies it as a draft with
  the blanks highlighted. Full-level users save a workflow as a company
  template.
- **Catalog**: browse triggers, fields and actions per module with "New"
  markers; the place to see what the app can do today.

### 8.2 Elsewhere in the app

- Approvals inbox: workflow asks appear with their options as buttons.
- Nav count: Workflows shows the number of items needing attention plus
  workflow approvals waiting on the person (through `approvals_inbox`).
- Settings > Workflows (subject "Workflows", org and company): module on/off
  per company, the run and recipient ceilings, the weekly owner digest
  on/off, the webhook allow-list and secrets (GA), the "Nexus" run-as
  switch.
- Tasks > Manage > Automation Rules keeps working; its header gets "For
  automations across modules, see Workflows".
- A record's history (task activity, ticket updates, employee notes) shows
  "Workflow: <name>" lines with a link to the run.

## 9. Build plan (shape, not the step list)

Same method as the HR build: parallel agents in worktrees, stacked into
`release/workflows-oct-2026`, four-angle code review, one PR to dev after
Neil's OK.

1. **Foundation** (serial, first): catalog + entities + emit + outbox +
   observer + engine + waits + versions + run log + API + grant + tests +
   catalog lock + `workflows_loop`. Core actions: notify, email, wait, stop,
   if/else, for each.
2. **In parallel once 1 lands**: (a) HR events and actions, (b) Tasks and
   Tickets events and actions plus Approval ask, (c) Time, Shifts and Items
   events plus date triggers and list sources, (d) the frontend module
   (overview, list, builder, runs), (e) templates gallery, Describe It,
   Settings group, approvals source, nav count, docs.
3. **Integration**: combine, Teams and webhook actions, the four reviews,
   fixes, CI, the release checklist (RLS on 8 tables, advisors).

## 10. Left to the builder

- Exact JSON shapes of trigger, steps and settings (keep them flat, versioned
  with a `v: 1`).
- The list sources offered to For Each in v1 beyond those named.
- Operator sets per field type, and the English for each.
- Keyset paging details on runs; retention (runs 180 days, steps 90, outbox
  7 **[my call]**).
- Whether the record observer emits `punch.in/out` by default or only when a
  workflow subscribes (do the latter if the outbox volume is a concern).

## 11. Prior art consulted

ServiceNow Flow Designer (subflows, Wait For Condition, error handler, Ask
For Approval), Power Automate (approval modes, scopes and run-after, child
flows, run history), Salesforce Flow (scheduled paths with a time source and
offset, fault paths, Debug with a record, Default Workflow User),
Workato (a version per save, recipe diff, lifecycle manifests), Rippling
Workflow Studio (triggers from employee data and dates, templates), Jira
Automation (smart values with from/to, related-issue and advanced branches,
service limits with THROTTLED in the audit log), monday.com (plain-English
automation builder), Workday Business Process Framework (approval chains,
send back, delegation, condition rules), n8n 2.x (draft vs published, error
workflow, pinned test data), HubSpot (enrollment, re-enrollment, suppression,
goals), Zapier (paths, filters, delay, Zap history, replay), Asana (When /
Check If / Do This cards, rule bundles). Notes with sources:
`docs/superpowers/specs/2026-10-28-workflows-prior-art.md`.
