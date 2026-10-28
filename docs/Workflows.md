# Workflows (Oct 28 2026)

Workflows is the one place in Nexus where "when X happens, do Y" is written
down once and then happens every time, across every module, with a record of
what it did and why. It is the ONE cross-module automation engine: modules
tell it what happened, it decides what to do. The design is
`docs/superpowers/specs/2026-10-28-workflows-design.md`; the build plan is
`docs/superpowers/plans/2026-10-28-workflows.md`.

Everything user-facing follows CLAUDE.md: Title Case titles / buttons / chips,
sentence-case body copy, American English, MM/DD/YYYY and 12-hour times,
"Time Sheet", plain hyphens never em dashes.

---

## Part 1 - User guide

### What a workflow is

One automation. It has:

- a **trigger** - what starts it: an **event** ("Time Off Is Decided"), a
  **schedule** ("Every Monday at 8:00 AM"), a **date** ("14 days before
  probation ends") or **manual** ("Run on a person" from inside Workflows);
- optional **conditions** - "Only if" checks on the record (field, operator,
  value; rows in a group are AND, several groups are OR);
- ordered **steps** - Action, If / Else, Ask For Approval, Wait, For Each,
  Stop;
- **settings** - owner, scope (one company or every company), enrollment
  (once per record, cooldown, people and companies never acted on), the
  caps, what to do on an error.

Every workflow has an **owner** and runs AS that owner: it can only read,
notify or change what its owner could by hand. A workflow's status is Draft,
Active, Paused (by a person), Needs Attention (paused by the system) or
Archived. Every Publish makes a new **version**; every run names the version
it ran.

Access is the `workflows` grant (Settings > People & Access): viewer sees
workflows and runs in their company scope; editor builds, tests and publishes
their own; full manages everyone's in scope and the company's templates;
Global Admins reach every company, "Every company" scope, webhooks and
Settings > Workflows.

### The builder

Open Workflows > Workflows > New Workflow (or Use Template). The builder is a
page, not a popup, and reads top to bottom as prose:

1. **When** - pick the trigger kind, then the event (grouped by module,
   searchable, New chips on what was added since you last looked). Filters
   appear after the event ("status changed to: Approved").
2. **Only If** - condition rows with the control the field type dictates
   (a date box, a person picker, a choice list).
3. **Do** - steps, each a card with an English summary when collapsed and
   its fields when open. Add Step is grouped by module. If / Else and Ask For
   Approval show their branches as indented lanes. Drag to reorder, or Move
   Up / Down. A step can be set to **Skip** without deleting it.

Text fields take fields from the record through Insert Field - nobody types
`{{ subject.name }}` by hand. The right rail holds Settings, Test and
Versions. On a new workflow, **Describe It** takes a sentence ("when a
hiring packet completes, create a laptop task for IT") and drafts the
recipe for you to edit; it never publishes by itself.

### Test before you publish

A workflow cannot be published until it has been tested since its last edit.

- **Test With A Recent Event** picks one of the last 50 real events of the
  trigger's kind (within your access) or the built-in sample, and runs the
  workflow in plan mode: each condition shows pass or fail with the values,
  each action shows what it WOULD do ("Would notify Priya Shah and 2
  others: ..."), each wait shows "would wait until 11/12/2026 8:00 AM".
  Nothing is sent, nothing is changed; the only trace is a run marked Test.
- **Preview A Schedule** shows "If this ran now: 4 people" with the list.

Publish validates the whole recipe (every required field set, every
recipient resolvable, every inserted field real, every branch complete, the
owner allowed to run every action) and shows the last test's summary.

### The off switches, top to bottom

Each one stops everything below it and says so on every affected screen.

1. **Pause All Workflows** - Settings > Workflows at "Every company", Global
   Admins only. No run starts anywhere; events keep queuing for 7 days so
   turning it back on loses nothing recent. The module header shows "All
   workflows are paused by <name> since <time>".
2. **Workflows On, per company** - Settings > Workflows with a company
   picked. Off: no run starts for that company's records; its workflows show
   "Paused: company switch".
3. **One workflow** - Pause on its row or page. Full-level users may pause
   anyone's in their scope.
4. **One step** - the Skip toggle on the step's card; the run log shows the
   step as skipped.
5. **Tasks automation rules** - listed under Workflows > Automations with
   their own switch (saved through the Tasks rule itself) and a link to
   Tasks > Manage to edit them.
6. **Built-in automations** - the background jobs (reminders, the no-show
   scan, the overtime watch, the weekly scorecard...) are listed read-only
   under Automations with what they do, how often, and a link to the
   setting that controls them where one exists.

A run already waiting on an approval still finishes when the decision
arrives - the person already clicked.

### Reviewing runs and actions

Workflows > Runs lists every run (filter by workflow, status, date, record).
The **Actions** view lists every step that changed or sent something, newest
first, across workflows, each row saying what, to whom and which record.
Opening a run shows its step timeline with inputs, outputs and the reason a
step was skipped or failed, the event it started from, and Replay (a new run
from the failed step, after you fix the cause) or Cancel (a waiting run).

Every record a workflow touched shows "Workflow: <name>" in its own history
with a link to the run. A failed run always bells its owner. A workflow that
runs more than its hourly cap, loses its owner, or names an action that no
longer exists is paused as Needs Attention with a bell to the owner and the
Global Admins. Publish, pause, resume, re-own and restore are written to the
Audit Log (Settings > Logs). The Monday **Owner Digest** (Settings >
Workflows) lists each owned workflow's runs, failures and what it did most.

### Templates

Workflows > Templates is a gallery of ready-made workflows grouped by module
(New Hire Welcome And Equipment, Probation Ending Reminder, Unsigned Time
Sheet Chase, Ticket Unanswered For 2 Business Days, Leaver Offboarding Kit,
Time Off Approved: Tell The Team, Overdue Task Escalation, Contract Ending
In 30 Days, Work Anniversary). Each card shows the trigger as a sentence and
the blanks you will fill in. **Use Template** asks for a name and a company
and opens a draft of your own; it runs only once you test and publish it.
Full-level users save a workflow of their own as a company template from the
builder (Save As Template).

Workflows > Catalog shows what the app can do today: every trigger, field,
action and list source per module, with New chips on what was added since
you last looked.

---

## Part 2 - Developer guide

### The shape

```
backend/workflows/
  catalog.py      registries, decorators, serialize(db, user), write_lock
  emit.py         emit(): the outbox write, the subscribed-key cache, CURRENT_RUN
  observer.py     after_flush listener: <entity>.created / .field_changed for free
  context.py      RunContext, {{ path }} resolution, filters
  conditions.py   operators per field type, evaluation with a trace
  recipients.py   recipient specs -> directory emails (visibility-checked)
  validate.py     definition -> [Problem(path, message)]
  engine.py       matching, runs, steps, waits, caps, plan mode
  scheduler.py    schedule and date triggers
  runner.py       tick() and workflows_loop()
  store.py        CRUD, versions, diff, audit rows
  approvals.py    Ask For Approval rows, decide, the approvals_inbox source
  settings.py     scoped settings "workflows.config"
  templates.py    the built-in templates
  automations.py  the Automations register (Tasks rules + built-in jobs)
  packs/          core, hr, tasks, tickets, time, shifts, items
  catalog.lock.json
backend/routers/workflows.py   the API (/workflows/*)
frontend/src/workflows/        the module (shell, builder, runs, templates, catalog, settings)
```

The **catalog** (`GET /workflows/catalog`) is the contract between backend
and builder. The frontend renders only what the catalog returns; nothing
about a trigger, field, condition or action is hard-coded in the UI. Adding
to the catalog is how Workflows grows with the app.

### Registering in a pack

Each module has one pack file, `backend/workflows/packs/<module>.py`, loaded
by `workflows.load_packs()` at startup. Everything a module offers is one
decorator each.

**An entity** - a kind of record a workflow can be about:

```python
@entity("employee", label="Person", model=NexusEmployee,
        company=lambda row: row.company,
        link=lambda row: {"view": "hr", "sub": f"people:{row.id}"},
        people={"self": ..., "manager": ..., "hr_contact": ...},
        fields=[F("name", "Name", "text"),
                F("department", "Department", "select", options="departments"),
                F("start_date", "Start Date", "date"),
                F("manager_email", "Manager", "person"),
                F("pay_rate", "Pay Rate", "money", visibility="comp")],
        dates=["start_date", "probation.end", "contract_end", "birthday"],
        observe=True)
```

Field types: text, number, date, datetime, select (with an options source),
person, people, bool, money. `visibility` is `all`, `hr` or `comp`: a
workflow whose owner cannot see pay is never offered a pay field, and a
template that names one renders blank. `dates` are the fields a date
trigger may count from (`yearly=True` for anniversaries). `observe=True`
turns on the record observer (below).

**An event** - something that happens to an entity:

```python
@event("time_off.decided", entity="time_off_request", label="Time Off Is Decided",
       module="hr", group="Time Off",
       changes=["status"],          # from / to for conditions and templates
       sample=SAMPLE_TIME_OFF,      # a realistic payload; tests and the dry-run use it
       volume="normal")             # or "high": written only while a workflow listens
```

The key is stable forever: `<entity>.<verb>` (`time_off.decided`,
`employee.status_changed`, `ticket.resolved`, `item_checkout.field_changed`) -
the entity key first, never a module prefix. `may_use(db, user)`
defaults to "the owner may read that entity's module". Normal-volume events
are always written so Test With A Recent Event has real rows from day one;
high-volume ones (punches, task comments) are written only while an active
workflow subscribes to the key.

**An action** - something a step can do:

```python
@action("notify", label="Send A Notification", module="core",
        params=[P("to", "To", "recipients"),
                P("title", "Title", "template", max=120),
                P("body", "Message", "template", max=1000)],
        plan=_notify_plan,          # dry-run: "Would notify Priya Shah and 2 others: ..."
        run=_notify_run,            # idempotent on (run_id, step_id)
        needs_person=False,         # True: not offered under the Nexus run-as
        admin_only=False)
```

Param types drive the builder's control: template (textarea with Insert
Field), recipients, select, number, duration, date_offset, entity_ref (a
module's own picker), approvers, options, bool, list_source. `run` calls the
module's OWN function as the run-as user so the module's permission checks
run; `allowed(db, run_as_user, ctx)` keeps an action the owner may not
perform out of the builder and refuses it at run time with a readable
reason. `run` MUST be idempotent on `(run_id, step_id)`: a retried tick never
sends twice (record what was sent in the step's output and skip it on the
retry).

**A list source** - what For Each and a schedule iterate:

```python
@list_source("employees.probation_ending", label="People Whose Probation Ends Soon",
             entity="employee", module="hr",
             params=[P("days", "Within Days", "number", default=14)],
             rows=_probation_ending)   # (db, run_as_user, params) -> [rows]
```

A list source is read-only and scoped by the run-as user; it is what the
Nexus run-as may iterate.

### Emitting: one line at the choke point

A module tells Workflows what happened with ONE call, at the one place the
change is made (the service function every route goes through, not each
route):

```python
from workflows import emit

emit(db, "time_off.decided", subject=row, actor=user["email"],
     changes={"status": (old, new)}, extra={"note": body.note})
```

`emit` writes a `workflow_events` outbox row on `session.connection()`
INSIDE the caller's transaction (the `audit_capture` pattern; a SAVEPOINT on
Postgres). A rollback drops it with everything else; it is never written from
`after_commit` (which also fires on SAVEPOINT release). It never raises into
the caller. Do not emit from a route handler when a service function exists,
do not emit twice for one change, and never build a second queue, bus or
engine next to it - a module that wants "when X, do Y" registers an event
and lets a workflow do Y.

Entities registered with `observe=True` get `<entity>.created` and
`<entity>.field_changed` for free from `observer.py` (an `after_flush`
listener reading `inspect(obj).attrs[x].history`). This is how Items has
events without touching `routers/items.py` (Visesh's file) and how a column
added to an observed model appears in the builder on the next deploy. Bulk
`query.update()` writes are not seen, same as the audit stream.

### The catalog lock

`backend/workflows/catalog.lock.json` is a committed snapshot of the
serialized catalog. `test_workflows_catalog.py` fails when the registrations
and the lock differ, so a PR that changes the catalog carries the diff for
review and What's New can say "3 new triggers". Regenerate it after any
registration change:

```
cd backend && python -c "import workflows.catalog as c; c.load_packs(); c.write_lock('workflows/catalog.lock.json')"
```

The same test checks that every `workflows.emit("<key>"` call site in the
backend (an AST scan) names a registered event, that every event's sample
validates against its entity's fields, that every action's `plan` and `run`
exist and run against the sample, and that every entity's `link` resolves.
The builder shows New on catalog entries added since the person last opened
Workflows (`last_catalog_seen`, `POST /workflows/catalog/seen`).

### No chaining (by default)

Events a run causes carry `caused_by_run` (the `CURRENT_RUN` ContextVar set
while a step runs). A workflow with `allowDownstream` off (the default)
ignores them, so a workflow cannot trigger another by accident; with it on
it runs at depth 1 only, and a chain never exceeds depth 2. A task change a
workflow makes goes through `update_task` as the owner, so Tasks automation
rules run on it as on the owner's own edit, and their events carry the run
id too - no ping-pong is possible. A task a workflow CREATES runs no Tasks
rule (`_SUPPRESS`, as `task_automation`'s own create does). Tasks rules stay
the in-request engine for task edits (they mutate the task inside the
person's transaction); Workflows lists them under Automations and reaches
task events after commit.

### Run-as

Every action runs with the owner's identity and the module's own permission
checks; re-owning a workflow re-validates it against the new owner. A Global
Admin may set run-as to Nexus (`workflows@nexus`) for organization-wide
housekeeping when Settings > Workflows > Nexus Run-As is on. Nexus can only
message: Send A Notification, Send An Email, Wait, Stop, If / Else, For Each
over a list source. Every module action needs a directory person
(`needs_person=True`), so the builder does not offer them under Nexus and
Publish refuses a definition that has them. No synthetic privileged identity
exists. Changed records are attributed to `workflow:<id>` and read
"Workflow: <name>" in their history.

### Settings

`workflows/settings.py` layers defaults <- tenant row <- `<key>:<company_id>`
through `backend/scoped_settings.py` (key `workflows.config`). `GET
/workflows/settings?company=` returns `{enabled, pausedAll, pausedBy,
pausedAt, ownerDigest, maxRunsPerHourCap (500), maxRecipientsCap (200),
nexusRunAs, webhookHosts, webhookSecretsSet, override, companies}`; `PUT`
takes the same keys plus `webhookSecrets: {host: secret}` for secrets typed
this time (write-only; stored in `secret_box`) and `override: false` to drop
a company's override. `POST /workflows/settings/pause-all` is Global Admins
only. The frontend panel is `frontend/src/workflows/WorkflowsSettings.jsx`,
mounted by Settings as the `workflows-config` group (scope layered, faces
both).

### The tables (RLS on every one)

`workflows`, `workflow_versions`, `workflow_events` (the outbox),
`workflow_runs`, `workflow_run_steps`, `workflow_waits`,
`workflow_approvals`, `workflow_subject_marks`. Each has a model in
`models.py`, `create_all` makes it, and an `ALTER TABLE ... ENABLE ROW LEVEL
SECURITY` line in `main.py`'s Postgres migration list turns RLS on - run
`get_advisors` on dev and prod after every release, the gap recurs.
`workflow_events` and `workflow_run_steps` are in
`audit_capture.NOISE_TABLES`. Retention: runs 180 days, steps 90, outbox 7
(rows nobody processed are dropped with a notice).

### The loop

`workflows_loop` runs in the elected leader only (`leader.elect_and_run`),
every 5 seconds, as `await asyncio.to_thread(tick)` - never a sync call on
the event loop. A tick does its work only on the deployed API
(`leader.is_deployed_worker()`) or on a process whose engine is SQLite
(`runner.may_run_here`): a laptop pointed at the shared dev Postgres wins
the lease like any process and must claim nothing - no outbox rows, no
schedules or dates, no waits, no reminders, no digests, no purges. Each
tick opens its own `SessionLocal()`, claims up to 200
unprocessed outbox rows with a conditional UPDATE (the
`ops_report_schedules._claim` pattern), matches them to active workflows,
runs steps committing one at a time (a crash leaves a readable trail; a
retried step is idempotent), resumes due `workflow_waits`, evaluates
schedule and date triggers once per period or date (dedupe keys
`wf:company:period` and `wf:subject:date`), sends approval reminders, purges
by retention, and stops after about 20 seconds of work until the next tick.
The email action checks `leader.is_deployed_worker()` again on its own. System guards: 25 steps per
workflow, 10 nested levels, For Each over at most 500 items, one action at
most 20 seconds, a run at most 10 minutes of active work. A step that raises
retries 3 times with backoff (1, 5, 15 minutes) when the error is transient,
else fails at once; on failure the run's fault steps run and the owner is
belled.
