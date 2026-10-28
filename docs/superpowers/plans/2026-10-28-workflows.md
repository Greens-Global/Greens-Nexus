# Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Workflows module: a backend catalog of entities, events and actions that every module registers into, a transactional event outbox drained by a leader-only runner that evaluates published workflows and executes their steps as the owner, and a React module where a manager builds, tests, publishes, pauses and reviews workflows.

**Architecture:** `backend/workflows/` is a package: `catalog` (registries + serialization), `emit` (outbox write inside the caller's transaction), `observer` (after_flush record events), `engine` (match, conditions, steps, waits, caps), `runner` (the loop), `store` (CRUD, versions, diff), `approvals` (Ask For Approval + inbox source), `packs/*` (one file per module: its entities, events, actions, list sources). `routers/workflows.py` is the HTTP face. The frontend `src/workflows/` renders only what `GET /workflows/catalog` returns.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (JSON columns, after_flush listeners), the existing `leader` / `to_thread` loop pattern, React 19 + Vite, vitest, lucide icons, the existing `Modal` / `DateField` / `SettingsUI` primitives.

**Spec:** `docs/superpowers/specs/2026-10-28-workflows-design.md` (read it first; this plan argues from it).

## Global Constraints

- Shared files are append-only, never reordered: `backend/models.py`, `backend/main.py` (both migration lists and the loop block), `backend/database.py`, `backend/auth.py`, `backend/audit_capture.py`, `backend/audit_modules.py`, `backend/approvals_inbox.py`, `backend/routers/action_counts.py`, `frontend/src/api.js`, `frontend/src/App.jsx`, `frontend/src/components/Sidebar.jsx`, `frontend/src/contexts/RoleContext.jsx`, `frontend/src/views/AdminConsole.jsx`.
- Never edit `backend/routers/items.py`, `frontend/src/views/InventoryManagement.jsx`, `frontend/src/components/Assignments.jsx`, `frontend/src/components/NotificationBell.jsx`, `frontend/src/components/NotificationToasts.jsx` (Visesh) or `frontend/src/asset/` (Neil's module).
- Outbox rows are written inside the caller's transaction on `session.connection()` (SAVEPOINT on Postgres), never from `after_commit`. `emit` never raises into the caller.
- The runner is `await asyncio.to_thread(tick)`; every tick opens its own `SessionLocal()`. Sends are gated by `leader.is_deployed_worker()`.
- New tables: model appended to `models.py`; `"ALTER TABLE <t> ENABLE ROW LEVEL SECURITY"` appended to the Postgres `migrations` list in `main.py`; `workflow_events` and `workflow_run_steps` added to `audit_capture.NOISE_TABLES`.
- Backend tests run ONE FILE PER PROCESS; each new test file binds its own temp SQLite at the top (copy `test_approvals_inbox.py` lines 20-40).
- Copy: Title Case for titles, buttons, tabs, chips and status labels; sentence case for body text; American English; MM/DD/YYYY and 12-hour times (`us_date` on the backend, `formatDate` / `formatDateTime` on the frontend); "Time Sheet"; plain hyphens, never em dashes.
- Frontend: never a native date input or `toLocale*` / `Intl.DateTimeFormat` (`check-dates.mjs` fails the lint); popups are the shared `Modal` (60vw / 60vh) with `nx-fill` on the growing part; every screen renders a skeleton or an empty state, never blank; a `*.test.jsx` render-smoke test per view.
- Ids are `str(uuid.uuid4())`; timestamps are ISO UTC strings; dates are `YYYY-MM-DD` strings.
- Definition JSON carries `"v": 1`. Shapes are pinned in Task 1's Interfaces block and never change without a migration note.
- Commits end with the two attribution lines given in the session (Co-Authored-By Claude Fable 5.1, Claude-Session URL).

## Review Focus

1. A workflow whose owner has a one-company scope must never match an event about another company's record, even when the event is emitted with no `company_id` (the engine resolves the entity's company and refuses blank). Test in Task 7.
2. A run's step that raises half-way (after sending one email of three) must not resend on the retry: step idempotency key `(run_id, step_id)` plus the step's recorded `output.sent` list. Test in Task 7.
3. A template with `{{ subject.pay }}` written by someone without the `hr_comp` grant must be refused at validation and render blank at run time, never the figure. Test in Task 4 and Task 6.
4. "Everything off" and "company off" must stop runs from STARTING but let a run already `waiting` on an approval finish when the decision arrives (the person already clicked). Test in Task 7 and Task 11.
5. An event emitted inside a SAVEPOINT that is later rolled back (hr_life_events.safe) must not reach the outbox. Test in Task 2.

---

## File Structure

**Backend (new):**
- `backend/workflows/__init__.py` - re-exports `emit`, `load_packs`.
- `backend/workflows/catalog.py` - registries, decorators, serialization, lock snapshot.
- `backend/workflows/emit.py` - outbox write, subscribed-key cache, `CURRENT_RUN` ContextVar.
- `backend/workflows/observer.py` - after_flush listener for observed entities.
- `backend/workflows/context.py` - `RunContext`, path resolution, templating.
- `backend/workflows/conditions.py` - operators and evaluation with a trace.
- `backend/workflows/recipients.py` - recipient specs to emails.
- `backend/workflows/validate.py` - definition validation (`Problem` list).
- `backend/workflows/engine.py` - matching, runs, steps, waits, caps, plan mode.
- `backend/workflows/scheduler.py` - schedule and date triggers, claims.
- `backend/workflows/runner.py` - `tick()` and `workflows_loop()`.
- `backend/workflows/store.py` - CRUD, versions, diff, serialization, audit rows.
- `backend/workflows/approvals.py` - Ask For Approval rows, decide, inbox source.
- `backend/workflows/settings.py` - scoped settings `workflows.config`.
- `backend/workflows/describe.py` - Describe It (Claude) draft.
- `backend/workflows/templates.py` - built-in templates.
- `backend/workflows/automations.py` - the Automations register (Tasks rules + built-in jobs).
- `backend/workflows/packs/{core,hr,tasks,tickets,time,shifts,items}.py` - per-module registrations.
- `backend/workflows/catalog.lock.json` - the committed catalog snapshot.
- `backend/routers/workflows.py` - the API.
- Tests: `backend/test_workflows_catalog.py`, `test_workflows_emit.py`, `test_workflows_context.py`, `test_workflows_conditions.py`, `test_workflows_validate.py`, `test_workflows_engine.py`, `test_workflows_scheduler.py`, `test_workflows_api.py`, `test_workflows_approvals.py`, `test_workflows_packs_hr.py`, `test_workflows_packs_tasks_tickets.py`, `test_workflows_packs_time_shifts_items.py`, `test_workflows_describe.py`.

**Backend (append):** `models.py` (8 tables), `main.py` (RLS lines, loop block), `database.py` (observer wire), `audit_capture.py` (NOISE_TABLES), `auth.py` (`MODULE_API_PREFIXES["workflows"]`), `audit_modules.py` (`_RESOURCES["workflows"]`), `approvals_inbox.py` (GROUPS entry), `routers/action_counts.py` (`workflows` counts), `main.py` router include; emit lines at the module choke points named in the pack tasks.

**Frontend (new):** `src/views/Workflows.jsx` (lazy root), `src/workflows/WorkflowsApp.jsx`, `src/workflows/lib/sub.js`, `src/workflows/lib/text.js`, `src/workflows/lib/definition.js`, `src/workflows/lib/useCatalog.js`, `src/workflows/Overview.jsx`, `src/workflows/WorkflowList.jsx`, `src/workflows/Automations.jsx`, `src/workflows/Builder.jsx`, `src/workflows/builder/{TriggerCard,ConditionsCard,StepCard,StepList,AddStepMenu,ParamControl,RailSettings,RailTest,RailVersions,DescribeIt,RunDialog}.jsx`, `src/workflows/Runs.jsx`, `src/workflows/RunDrawer.jsx`, `src/workflows/Templates.jsx`, `src/workflows/Catalog.jsx`, `src/workflows/WorkflowsSettings.jsx`, tests beside them.

**Frontend (append):** `api.js`, `App.jsx`, `Sidebar.jsx`, `RoleContext.jsx`, `lib/moduleCapabilities.js`, `lib/useActionCounts.js` (TAB_NAMES), `lib/approvalActions.js` (kind `workflow`), `views/AdminConsole.jsx` (subject, group, panel, case), `components/MobileMenu.jsx` (SUBMENUS), `support/docsContent.js` (DOCS entry), `scripts/check-bundle-size.mjs` (cap raise with a dated note; Neil OK'd raises before, note it in the PR).

---

## Phase 1: Foundation (serial)

### Task 1: Models, migrations, catalog registries

**Files:**
- Modify: `backend/models.py` (append after `TimeEntryBatch`)
- Modify: `backend/main.py` Postgres `migrations` list (append before its closing `]` at ~line 3168)
- Modify: `backend/audit_capture.py` `NOISE_TABLES`
- Create: `backend/workflows/__init__.py`, `backend/workflows/catalog.py`
- Test: `backend/test_workflows_catalog.py`

**Interfaces:**
- Produces models: `Workflow(id, name, description, owner_email, run_as ('owner'|'nexus'), company_id, status, version, trigger JSON, steps JSON, settings JSON, draft JSON|None, created_by, created_at, updated_by, updated_at, last_run_at, run_count, fail_count, paused_reason, paused_by, paused_at, archived_at, last_tested_at, tested_hash)`, `WorkflowVersion(id, workflow_id, version, definition JSON, published_by, published_at, note)`, `WorkflowEvent(id, key, entity, subject_id, company_id, actor, payload JSON, caused_by_run, depth, at, processed_at, attempts, error, wanted)`, `WorkflowRun(id, workflow_id, workflow_name, version, event_id, trigger_kind, entity, subject_id, subject_label, company_id, status, started_at, finished_at, summary, error, dedupe_key, replay_of, started_by, depth)`, `WorkflowRunStep(id, run_id, workflow_id, step_id, kind, action, label, status, started_at, finished_at, input JSON, output JSON, detail, affected JSON, attempt)`, `WorkflowWait(id, run_id, workflow_id, step_id, due_at, kind, state JSON, claimed_at)`, `WorkflowApproval(id, run_id, workflow_id, step_id, workflow_name, subject_label, subject_link JSON, company_id, approvers JSON, mode, question, options JSON, responses JSON, outcome, asked_at, decided_at, remind_days, expire_days, reminded_at)`, `WorkflowSubjectMark(workflow_id, entity, subject_id, last_run_at)` (composite PK).
- Produces `catalog.py`:
  - `F(key, label, type, *, options=None, visibility="all", yearly=False, path=None)` -> `Field` (types: `text number date datetime select person people bool money`).
  - `P(key, label, type, *, required=True, max=None, options=None, default=None, hint="")` -> `Param` (types: `text template number bool select recipients person entity_ref duration date_offset list_source options approvers`).
  - `@entity(key, *, label, model, company, link, people, fields, dates=(), observe=False, observe_fields=(), load=None, label_of=None, visible_to=None)`; `people` is `{role: callable(db,row)->list[str]}`; `visible_to(db, user, row) -> bool` defaults True; `load(db, id)` defaults `db.get(model, id)`; `label_of(row)` defaults `getattr(row, "name", row.id)`.
  - `@event(key, *, entity, label, module, group, changes=(), sample, volume="normal", may_use=None)`.
  - `@action(key, *, label, module, params, plan, run, allowed=None, needs_person=True, admin_only=False)`; `plan(ctx, params) -> str`; `run(ctx, params) -> dict` (returns `{"line": str, "affected": [{"entity","id","label"}], "sent": [emails]}`); `allowed(ctx, params) -> str` ('' = allowed, else the reason).
  - `@list_source(key, *, label, entity, module, params=(), fn)`; `fn(db, ctx, params) -> list[row]`.
  - `ENTITIES, EVENTS, ACTIONS, LIST_SOURCES: dict[str, ...]`; `load_packs()` imports `workflows.packs.*` once; `serialize(db, user) -> dict` = `{"entities": [...], "events": [...], "actions": [...], "listSources": [...], "operators": {type: [{key,label}]}, "filters": [...], "generatedAt"}` filtered by `may_use` and field visibility (`hr` needs `_module_level(email,"hr") >= viewer` or admin; `comp` needs `hr_comp`); `snapshot() -> dict` (deterministic, no db); `write_lock(path)` / `lock_matches(path) -> bool`.
- Produces definition shapes (pinned):
  ```
  trigger: {"kind":"event","event":"hr.time_off.decided","filters":[{field,op,value}]}
         | {"kind":"schedule","every":"day|week|month","days":[1..7 | 1..31],"time":"08:00","zone":"company"}
         | {"kind":"date","entity":"employee","field":"probation.end","offsetDays":-14,"time":"08:00"}
         | {"kind":"manual","entity":"employee"}
  conditions: [ [ {field, op, value}, ... ], ... ]        # groups OR, rows AND
  steps: [ {id, kind:"action", action:"notify", params:{...}, enabled:true, label?}
         | {id, kind:"if", conditions:[...], then:[steps], else:[steps], enabled}
         | {id, kind:"approval", params:{approvers, mode, question, options:["Approve","Decline"], remindDays, expireDays, allowSelf}, branches:{"<option>":[steps], "expired":[steps]}, enabled}
         | {id, kind:"wait", params:{mode:"duration|until|business_morning", minutes?, field?, offsetDays?}, enabled}
         | {id, kind:"for_each", source:{key, params}, as:"item", steps:[steps], enabled}
         | {id, kind:"stop", enabled} ]
  settings: {oncePerSubject:false, cooldownHours:0, suppress:{people:[],companies:[]}, logSkips:false,
             allowDownstream:false, maxRunsPerHour:100, maxRecipients:50, onError:"stop", faultSteps:[steps]}
  definition = {"v":1, "trigger":..., "conditions":..., "steps":..., "settings":...}
  ```

- [ ] **Step 1: Write the failing tests**

```python
# test_workflows_catalog.py
def test_tables_exist_after_create_all():
    for t in ("workflows","workflow_versions","workflow_events","workflow_runs","workflow_run_steps",
              "workflow_waits","workflow_approvals","workflow_subject_marks"):
        assert t in models.Base.metadata.tables
def test_rls_lines_present_in_postgres_migrations():
    src = open("main.py").read()
    for t in (...same 8...): assert f'"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY"' in src
def test_noise_tables_include_outbox_and_steps():
    assert {"workflow_events","workflow_run_steps"} <= audit_capture.NOISE_TABLES
def test_registering_an_event_with_unknown_entity_raises():
    with pytest.raises(ValueError): catalog.event("x.y", entity="nope", label="X", module="m", group="g", sample={})(lambda: None)
def test_serialize_hides_hr_fields_from_a_non_hr_user(db, employee_user):
    cat = catalog.serialize(db, employee_user)
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    assert all(f["visibility"] == "all" for f in emp["fields"])
def test_snapshot_is_deterministic():
    assert catalog.snapshot() == catalog.snapshot()
def test_lock_matches_committed_snapshot():
    assert catalog.lock_matches("workflows/catalog.lock.json"), "run: python -c 'import workflows.catalog as c; c.load_packs(); c.write_lock(\"workflows/catalog.lock.json\")'"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest test_workflows_catalog.py -q`
Expected: FAIL (ImportError on `workflows`).

- [ ] **Step 3: Append the 8 models to `models.py`** with the columns in Interfaces; every String default `""`, every JSON default `dict`/`list`, `index=True` on `WorkflowEvent.processed_at`, `.key`, `.company_id`; `WorkflowRun.workflow_id`, `.status`, `.started_at`, `.dedupe_key`; `WorkflowRunStep.run_id`; `WorkflowWait.due_at`; `WorkflowApproval.outcome`. Docstring each with the RELEASE RLS note as `TimeEntryBatch` does.

- [ ] **Step 4: Append the 8 RLS lines** to the Postgres `migrations` list in `main.py`; add the two NOISE tables in `audit_capture.py`.

- [ ] **Step 5: Implement `catalog.py`** with the dataclasses, decorators, dicts, `load_packs()` (importlib over `workflows/packs/*.py`, idempotent), `serialize`, `snapshot` (sorted keys, no callables), `write_lock`, `lock_matches`. `operators` per type: text `is is_not contains is_empty is_not_empty changed changed_to changed_from`; number/money `is is_not gt lt is_empty changed`; date/datetime `is before after within_next_days within_last_days is_empty changed`; select `is is_not is_any_of changed changed_to changed_from`; person/people `is is_not includes is_empty changed`; bool `is changed`. `filters`: `us_date us_datetime upper lower default`.

- [ ] **Step 6: Create `workflows/__init__.py`** exporting `emit` (from Task 2; stub for now) and `load_packs`.

- [ ] **Step 7: Run tests, then write the lock** (`write_lock`) once packs exist in Task 8; for now the lock test is marked `xfail(strict=False)` with the reason "packs land in Task 8".

Run: `python -m pytest test_workflows_catalog.py -q` -> PASS (lock xfail).

- [ ] **Step 8: Commit** `feat(workflows): models, RLS lines and the catalog registries`.

### Task 2: emit() and the outbox

**Files:**
- Create: `backend/workflows/emit.py`
- Test: `backend/test_workflows_emit.py`

**Interfaces:**
- `emit(db, key: str, *, subject, actor: str = "", changes: dict | None = None, extra: dict | None = None, company_id: str | None = None) -> None`. `subject` is the ORM row or its id; `changes` is `{field: (old, new)}`; payload stored as `{"subject": {entity's fields}, "changes": {f: {"from","to"}}, "extra": {...}, "actor": actor}`; `company_id` defaults to the entity's `company(row)`; writes with `session.connection()` + SAVEPOINT on Postgres; sets `caused_by_run` / `depth` from `CURRENT_RUN` ContextVar (`contextvars.ContextVar("workflow_run", default=None)` holding `(run_id, depth)`); for `volume="high"` events writes only when `subscribed(key)`; `wanted` = 1 when any active workflow subscribes (looked up from the cache) else 0; never raises (logs `[workflows] emit skipped ...`).
- `subscribed(key) -> bool` reads a process cache refreshed at most every 60 s from `NexusSetting("workflows.subscribed")` (written by the runner, Task 7).
- `CURRENT_RUN` exported for the engine.
- `payload_for(entity_def, row) -> dict` (field values by `F.path` or attribute, dates as strings, people lowercased).

- [ ] **Step 1: Failing tests**

```python
def test_emit_writes_one_outbox_row_in_the_same_transaction(db, employee_row):
    workflows.emit(db, "employee.status_changed", subject=employee_row, actor="hr@x", changes={"status": ("active","offboarded")})
    db.commit()
    ev = db.query(models.WorkflowEvent).one()
    assert ev.key == "employee.status_changed" and ev.payload["changes"]["status"] == {"from":"active","to":"offboarded"}
    assert ev.company_id == employee_row.company and ev.wanted in (0, 1)
def test_emit_inside_rolled_back_savepoint_leaves_nothing(db, employee_row):
    with db.begin_nested():
        workflows.emit(db, "employee.status_changed", subject=employee_row)
        raise_and_catch_rollback()   # the savepoint is rolled back
    db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
def test_emit_with_unknown_key_logs_and_does_not_raise(db, employee_row, capsys):
    workflows.emit(db, "nope.nope", subject=employee_row); db.commit()
    assert db.query(models.WorkflowEvent).count() == 0 and "emit skipped" in capsys.readouterr().out
def test_high_volume_event_is_written_only_when_subscribed(db, punch_row, monkeypatch):
    monkeypatch.setattr(emit, "subscribed", lambda k: False); workflows.emit(db, "punch.in", subject=punch_row); db.commit()
    assert db.query(models.WorkflowEvent).count() == 0
    monkeypatch.setattr(emit, "subscribed", lambda k: True); workflows.emit(db, "punch.in", subject=punch_row); db.commit()
    assert db.query(models.WorkflowEvent).count() == 1
def test_emit_tags_caused_by_run_from_contextvar(db, employee_row):
    tok = emit.CURRENT_RUN.set(("run-1", 1)); workflows.emit(db, "employee.status_changed", subject=employee_row); emit.CURRENT_RUN.reset(tok); db.commit()
    assert db.query(models.WorkflowEvent).one().caused_by_run == "run-1"
```
(the test registers a throwaway `employee` entity and the two events in a fixture if packs are not loaded yet)

- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement `emit.py`** per Interfaces (insert via `models.WorkflowEvent.__table__.insert()` on `session.connection()`, `begin_nested()` on postgresql, as `audit_capture._write`). **Step 4: Run** -> PASS. **Step 5: Commit** `feat(workflows): emit() writes the outbox inside the caller's transaction`.

### Task 3: The record observer

**Files:**
- Create: `backend/workflows/observer.py`
- Modify: `backend/database.py` (append `import workflows.observer as _wf_observer; _wf_observer.wire(SessionLocal)` after the feature_request_sync wire)
- Test: `backend/test_workflows_observer.py`

**Interfaces:**
- `wire(session_factory)`: an `after_flush` listener; for each obj in `session.new` whose model is an observed entity -> `emit(session, f"{entity}.created", subject=obj)`; for each in `session.dirty` -> per changed field in `observe_fields` (via `inspect(obj).attrs[f].history`, `has_changes()`), one `emit(..., f"{entity}.field_changed", changes={f: (old, new)}, extra={"field": f})`. Skips when `CURRENT_RUN` depth would exceed 2. Never raises.
- Registered observed entities in v1 (declared in packs): `employee` (department, manager_email, job_title, company, employment_type, location, status), `item_checkout` (status), `item_assignment` (status), `punch` (high volume).

- [ ] **Step 1: Failing tests**: `test_observed_update_emits_field_changed_with_from_to` (change `department` on an employee, flush, one outbox row with `changes.department == {"from":"Ops","to":"Sales"}`), `test_unobserved_field_emits_nothing` (change `phone`), `test_create_emits_created`, `test_observer_never_breaks_the_flush` (monkeypatch `emit` to raise; the flush still succeeds). 
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** and wire in `database.py`. **Step 4: Run** -> PASS (also run `python -m pytest test_feature_request_sync.py -q` to prove the hook order still works). **Step 5: Commit** `feat(workflows): record observer emits created / field_changed for observed entities`.

### Task 4: Context, templating, conditions, recipients

**Files:**
- Create: `backend/workflows/context.py`, `conditions.py`, `recipients.py`
- Test: `backend/test_workflows_context.py`, `test_workflows_conditions.py`

**Interfaces:**
- `RunContext` dataclass: `db, workflow, definition, run (row|None), entity (EntityDef), subject (row), payload (dict), event (WorkflowEvent|None), actor (str), run_as (dict user|None), today (date), zone (str), item (dict|None), vars (dict)`. `ctx.resolve(path: str)` resolves `subject.<field>`, `change.<field>.from|to`, `actor.name|email`, `today`, `subject.link`, `item.<field>`, `event.<key>`, `vars.<k>`; unknown -> `MISSING` sentinel. Respects field visibility against `run_as` (an `hr`/`comp` field resolves to `MISSING` when the run-as user may not see it).
- `render(template: str, ctx) -> tuple[str, list[str]]` renders `{{ path | filter:arg }}`, returns the text and the list of missing paths; filters `us_date us_datetime upper lower default`.
- `conditions.evaluate(groups: list, ctx) -> tuple[bool, list[dict]]`; trace rows `{group, field, op, value, actual, ok}`; operators as pinned in Task 1; `changed*` ops read `ctx.payload["changes"]`; dates compare as `date`; `within_next_days` uses `ctx.today`.
- `recipients.resolve(ctx, spec: list | dict, *, cap: int) -> tuple[list[str], int]`; spec items `{"kind":"self"|"manager"|"hr_contact"|"assignees"|"creator"|"followers"|"approver"|"owner"|"person"|"role"|"department"|"team"|"company"|"global_admins", "value"?: str}`; returns deduped lowercased directory emails that pass `entity.visible_to`, and how many were dropped (cap and visibility). `role` values: `hr_contact`, `global_admins`; `department`/`team` go through `kb_audience.members`.

- [ ] **Step 1: Failing tests** (names and the pinned values):
  - context: `test_render_fills_paths_and_us_date` (`"{{ subject.name }} starts {{ subject.start_date | us_date }}"` -> `"Priya Shah starts 11/12/2026"`), `test_render_reports_missing_paths` (`"{{ subject.nope }}"` -> `("", ["subject.nope"])`), `test_render_default_filter`, `test_comp_field_is_missing_for_non_comp_user`.
  - conditions: one test per operator family with the trace checked: `test_select_is_any_of`, `test_changed_to_reads_payload`, `test_date_within_next_days_uses_today`, `test_groups_or_rows_and`, `test_unknown_field_is_false_not_error`.
  - recipients: `test_manager_and_hr_contact_resolve_and_dedupe`, `test_cap_drops_and_counts`, `test_invisible_recipient_is_dropped`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement the three modules.** **Step 4: Run** -> PASS. **Step 5: Commit** `feat(workflows): run context, templating, conditions and recipients`.

### Task 5: Validation

**Files:**
- Create: `backend/workflows/validate.py`
- Test: `backend/test_workflows_validate.py`

**Interfaces:**
- `Problem(path: str, message: str)`; `validate(db, definition: dict, *, owner: dict, run_as: str, company_id: str) -> list[Problem]` checks: `v == 1`; trigger kind and its event/entity exist and `may_use(owner)`; filters and conditions name fields of the entity with a valid operator and a value of the right shape; every step has a unique `id`, a known kind; action params required/typed/within `max`; templates render against the event sample with no missing path; recipients specs valid; `approval` has >= 1 approver and >= 2 options and a branch per option; `for_each` names a list source for the entity; depth <= 10; steps <= 25; action `allowed` is '' for the run-as user against the sample context; `run_as == "nexus"` allows only `notify email wait stop if for_each`; `admin_only` actions need `owner["level"] >= 5`; settings within caps (`maxRunsPerHour <= 500`, `maxRecipients <= 200`); `company_id == ""` needs owner level >= 5; owner must hold the `workflows` grant at editor+ or be an administrator.
- `definition_hash(definition) -> str` (sha256 of canonical JSON) used by "tested since last edit".

- [ ] **Step 1: Failing tests**: `test_valid_definition_has_no_problems`, `test_unknown_event_is_a_problem_at_trigger_event`, `test_missing_template_path_names_the_step_and_param`, `test_nexus_run_as_refuses_create_task`, `test_every_company_needs_global_admin`, `test_too_many_steps`, `test_approval_needs_branch_per_option`, `test_hash_is_stable_across_key_order`.
- [ ] **Step 2-5:** run, implement, run, commit `feat(workflows): definition validation`.

### Task 6: Core pack (entities and actions the engine needs)

**Files:**
- Create: `backend/workflows/packs/__init__.py`, `backend/workflows/packs/core.py`
- Test: `backend/test_workflows_packs_core.py`

**Interfaces (registered keys):**
- Entity `company` (model `HrEntity`, fields `name`, people `hr_contact`, `global_admins`).
- Actions: `notify` (params `to: recipients`, `title: template max 120`, `body: template max 1000`, `priority: bool default False`; run via `notify_rollup.upsert_rollup(db, recipient=..., key=f"wf:{workflow_id}:{subject_id}", title, line, action={"view":..,"sub":..} from the entity link, company, requested_by=run_as email, replace=True)`); `email` (params `to`, `subject: template max 200`, `body: template max 5000`; run via `graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[...], cc=None, subject, html)` with `email_theme` wrapping, only when `leader.is_deployed_worker()` else records `{"line": "Email not sent (not the deployed worker)"}`); `wait` (params `mode`, `minutes`, `field`, `offsetDays`; the engine handles it, `run` returns the due time); `stop`; `webhook` (`admin_only=True`, params `url`, `payload: template`, run: hosts must be in `settings.webhookHosts`, HMAC-SHA256 header `X-Nexus-Signature` with the secret from `secret_box.decrypt(settings.webhookSecrets[host])`, `httpx.post(timeout=10)`, raise on >= 400 (transient on 5xx)); `teams` (params `to: recipients`, `chat: select(options from the owner's chats | "direct")`, `message: template`; run: inserts `TicketTeamsMessage(kind="workflow", agent_email=run_as email, requester_email=recipient, html=..., chat_id=...)` per recipient; delivery stays with `teams_post.deliver_ticket_row`, which already handles the default branch for a 1:1; `allowed` returns "Post To Teams needs a person's identity" when run_as is nexus).
- Sample payloads for the two generic events `company.schedule` (the schedule tick's subject) are provided here.

- [ ] **Step 1: Failing tests**: `test_notify_plan_names_recipients` (plan line `"Would notify Priya Shah and 1 other: Probation ends 11/12/2026"`), `test_notify_run_upserts_one_notice_per_recipient`, `test_email_run_not_deployed_records_line_and_sends_nothing`, `test_webhook_refuses_host_not_allowlisted`, `test_webhook_signs_body` (monkeypatch httpx), `test_teams_queues_a_row_per_recipient`, `test_teams_not_allowed_for_nexus`.
- [ ] **Step 2-5:** run, implement, run, commit `feat(workflows): core pack - notify, email, teams, webhook, wait, stop`.

### Task 7: Engine, store, runner

**Files:**
- Create: `backend/workflows/engine.py`, `store.py`, `scheduler.py`, `runner.py`, `settings.py`
- Modify: `backend/main.py` loop block (append a try-block starting `workflows_loop`)
- Test: `backend/test_workflows_engine.py`, `backend/test_workflows_scheduler.py`

**Interfaces:**
- `settings.DEFAULTS = {"enabled": True, "maxRunsPerHourCap": 500, "maxRecipientsCap": 200, "ownerDigest": False, "nexusRunAs": False, "webhookHosts": [], "webhookSecrets": {}, "pausedAll": False, "pausedBy": "", "pausedAt": ""}`; `settings.get(db, company_id="") -> dict` (via `scoped_settings.get(db, "workflows.config", DEFAULTS, company_id)`); `settings.save(db, company_id, cfg, actor)`.
- `store.create(db, *, name, owner, company_id, definition=None, by) -> Workflow` (status draft, `draft` = definition or an empty one); `store.save_draft(db, wf, definition, by)`; `store.publish(db, wf, by, note="") -> WorkflowVersion` (validates via `validate.validate`, raises `ValueError(problems)`; refuses when `wf.tested_hash != definition_hash(draft)`; copies draft into trigger/steps/settings, bumps version, clears draft, status active, writes an `AuditLog` row `action="workflow.publish"` module `workflows`); `store.set_status(db, wf, status, by, reason="")`; `store.reown(db, wf, new_owner, by)` (re-validates); `store.duplicate(db, wf, by, *, company_id=None, name=None)`; `store.restore(db, wf, version, by)`; `store.diff(a: dict, b: dict) -> list[str]` (English lines: "Trigger changed from X to Y", "Step 3 (Send An Email): recipients changed from Manager to Manager, HR Contact", "Step added: ...", "Step removed: ..."); `store.serialize(db, wf, *, full=False) -> dict`; `store.serialize_run(db, run, *, steps=False) -> dict`; `store.visible_workflows(db, user) -> Query` (grant + company scope).
- `engine.match(db, ev: WorkflowEvent) -> list[Workflow]` (active, trigger event == key, scope admits `ev.company_id` (blank company refused unless the workflow is every-company AND the entity has no company), `caused_by_run` honored per `allowDownstream`/depth); `engine.enroll_ok(db, wf, ev) -> tuple[bool, str]` (once-per-subject, cooldown, suppress, company switch, global switch, maxRunsPerHour); `engine.start(db, wf, *, ctx, trigger_kind, event=None, started_by="", plan_only=False, replay_of="") -> WorkflowRun`; `engine.execute(db, run, *, budget_seconds=20) -> WorkflowRun` runs steps from where it left off (step rows with status `done|skipped|failed|waiting|planned`), commits per step, sets `CURRENT_RUN`, idempotent per `(run_id, step_id)`, retries transient errors (`GraphMailError`, `httpx.TransportError`, `OperationalError`) 3x with backoff by writing a `WorkflowWait(kind="retry")`; on failure runs `settings.faultSteps` then bells the owner via `notify_rollup`; `engine.resume(db, wait: WorkflowWait)`; `engine.cancel(db, run, by)`; `engine.replay(db, run, by) -> WorkflowRun`.
- `scheduler.due_schedules(db, now_utc) -> list[tuple[Workflow, str company_id, str period]]`; `scheduler.due_dates(db, today_by_zone) -> list[tuple[Workflow, entity_row, str date]]` (reads entity `dates`, `yearly` matches month-day); `scheduler.claim(db, wf, dedupe_key) -> bool` (insert-or-skip on `WorkflowRun.dedupe_key`).
- `runner.tick(now=None) -> dict` = `{"events": n, "runs": n, "resumed": n, "scheduled": n, "purged": n}`: refresh the subscribed-key setting; return early when `settings.get(db)["pausedAll"]` (still resumes approvals, see Review Focus 4); claim up to 200 outbox rows (conditional UPDATE on `processed_at IS NULL`); per row `match` -> `enroll_ok` -> `start` + `execute`; resume due waits; schedules and dates; purge (events 7 d, steps 90 d, runs 180 d); mark `needs_attention` for owner gone / grant lost / missing action; `async def workflows_loop()` (sleep 90 s, then every 5 s, `to_thread(tick)`, swallow and print exceptions).
- `main.py`: append the loop block in the `_start_background_jobs` style, after the performance loop block.

- [ ] **Step 1: Failing tests** (engine): `test_event_matches_active_workflow_in_scope_and_not_other_company` (Review Focus 1), `test_conditions_fail_logs_skip_only_when_logSkips`, `test_steps_run_in_order_and_commit_each`, `test_failed_step_mid_run_does_not_resend_on_retry` (Review Focus 2: an email action that raises after recording `output.sent=[a]`, retried, sends only b and c), `test_wait_parks_run_and_resume_continues`, `test_once_per_subject_and_cooldown`, `test_runs_per_hour_cap_pauses_workflow_and_bells_owner`, `test_no_chaining_by_default_and_depth_cap_2`, `test_paused_all_blocks_new_runs_but_approval_resume_finishes` (Review Focus 4), `test_company_switch_blocks_that_company_only`, `test_plan_only_writes_test_run_and_no_effects`, `test_replay_starts_from_failed_step`, `test_owner_gone_marks_needs_attention`.
  (scheduler): `test_daily_schedule_fires_once_per_company_period`, `test_date_trigger_offset_minus_14_fires_on_the_right_day`, `test_yearly_date_matches_month_day`, `test_claim_is_atomic_on_dedupe_key`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** the five modules and the `main.py` loop block. **Step 4: Run** -> PASS; also `python -m pytest test_event_loop_blocking.py -q` after adding `workflows.runner.workflows_loop` to its list. **Step 5: Commit** `feat(workflows): engine, store, scheduler and the runner loop`.

### Task 8: API, grant, approvals source, automations register, templates, Describe It

**Files:**
- Create: `backend/routers/workflows.py`, `backend/workflows/approvals.py`, `automations.py`, `templates.py`, `describe.py`
- Modify (append): `backend/main.py` (include router), `backend/auth.py` (`MODULE_API_PREFIXES["workflows"] = ["/workflows"]`), `backend/audit_modules.py` (`_RESOURCES["workflows"] = "workflows"`), `backend/approvals_inbox.py` (`GROUPS.append(("workflows", "Workflows"))` and the source lives in `workflows/approvals.py`, imported from `approvals_inbox` at the bottom the way HR's sources are), `backend/routers/action_counts.py` (`"workflows": {"overview": needs_attention_count + a("workflow", 0)}`)
- Test: `backend/test_workflows_api.py`, `test_workflows_approvals.py`, `test_workflows_describe.py`

**Interfaces (routes; all under `/workflows`, dependency `require_module_grant("workflows", level)`; `R` = viewer, `E` = editor, `F` = full, `GA` = owner):**
- `GET /catalog` (R) -> `catalog.serialize(db, user)` plus `{"newSince": [keys], "lastSeen": iso}`; `POST /catalog/seen` (R).
- `GET /` (R; query `scope=mine|company|all`, `status`, `q`) -> `[store.serialize]`; `POST /` (E; body `{name, companyId, definition?, templateKey?}`) -> 201 serialize full; `GET /{id}` (R, full); `PUT /{id}/draft` (E owner or F) ; `POST /{id}/publish` (E owner or F; body `{note}`; 422 with `{"problems":[{path,message}]}` or `{"detail":"Test this workflow before publishing"}`); `POST /{id}/status` (body `{status: paused|active|archived, reason}`); `POST /{id}/reown` (F; `{owner}`); `POST /{id}/duplicate` (E; `{name, companyId}`).
- `GET /{id}/versions`; `GET /{id}/versions/{v}`; `POST /{id}/versions/{v}/restore` (E owner or F); `GET /{id}/diff?a=&b=` -> `{"lines":[...]}`.
- `GET /{id}/recent-events` (R) -> last 50 outbox rows for the trigger key in the caller's scope, `{id, at, subjectLabel, actor}`; `POST /{id}/test` (E; `{eventId?}`; sample when absent) -> `serialize_run(steps=True)` with status `test`, and sets `tested_hash`; `POST /{id}/preview-schedule` -> `{"count": n, "items": [{label, link}]}`; `POST /{id}/run` (E; `{subjectId}`) for manual triggers.
- `GET /runs` (R; `workflow`, `status`, `kind=runs|actions`, `before` keyset, `limit<=100`) ; `GET /runs/{id}` (steps + event payload); `POST /runs/{id}/replay`; `POST /runs/{id}/cancel`.
- `GET /overview` (R) -> `{"needsAttention":[...], "last24h": {"runs", "succeeded", "failed"}, "recent": [...runs], "pausedAll": {...}}`.
- `GET /templates` (R); `POST /templates/{key}/use` (E; `{name, companyId}`) -> the new draft; `POST /{id}/save-as-template` (F).
- `GET /automations` (R) -> `{"taskRules": [...rule_to_dict + {"runsLink"}], "jobs": [{key, label, what, every, settingLink?}]}`; `POST /automations/task-rules/{id}/enabled` (`{enabled}`) proxies to the Tasks rule update as the caller (requires `require_manager`, the Tasks rule rule).
- `GET /settings?company=` (F) ; `PUT /settings?company=` (GA for org, F for a company) ; `POST /settings/pause-all` (GA; `{paused: bool}`).
- `POST /describe` (E; `{text, entityHint?}`) -> `{"definition": {...}, "problems": [...], "notes": str}`; 503 when `ANTHROPIC_API_KEY` unset.
- `POST /approvals/{id}/decide` (any signed-in; `{option, note}`) -> resumes the run; 403 when the caller is not an approver (or is the subject with `allowSelf` off); honors `approval_delegation` like other sources.
- `approvals.ask(ctx, step, params) -> WorkflowApproval`; `approvals.decide(db, approval, user, option, note)`; `@source("workflow", "Workflow approvals", "workflows")` rows with `kind="workflow"`, actions built from `options` (first option tone primary), `link` to `{"view":"workflows","sub":f"run:{run_id}"}`; reminders and expiry handled in `runner.tick`.
- `automations.jobs()` is a static list (key, label, what, every, settingLink) covering the loops in `main.py`'s `_start_background_jobs` (read them from the file and write the list by hand; 30 entries).
- `templates.TEMPLATES: list[dict]` with the nine named in the spec, each `{key, name, module, description, definition, blanks: [paths]}`; every template passes `validate` against a Global Admin owner.
- `describe.draft(db, user, text) -> dict`: one Claude call (`httpx` to `ai_assistant._API`, model `claude-sonnet-5-5`, system prompt = the serialized catalog for the user + the definition shape + "answer with JSON only"), parses the JSON, runs `validate`, returns definition + problems + notes.

- [ ] **Step 1: Failing tests** (api): `test_viewer_lists_only_scope`, `test_editor_creates_draft_and_cannot_publish_untested`, `test_publish_after_test_bumps_version_and_writes_audit`, `test_pause_all_is_global_admin_only`, `test_run_endpoint_requires_manual_trigger`, `test_runs_actions_view_lists_affected_rows`, `test_automations_lists_task_rules_and_jobs_and_toggles`, `test_templates_all_validate`. (approvals): `test_ask_creates_inbox_row_for_each_approver`, `test_decide_by_non_approver_403`, `test_self_cannot_decide_unless_allowed`, `test_decide_resumes_run_into_the_option_branch`, `test_mode_all_waits_for_everyone_and_sequence_asks_one_at_a_time`. (describe): `test_describe_503_without_key`, `test_describe_parses_and_validates` (monkeypatch httpx).
- [ ] **Step 2-5:** run, implement, run, commit `feat(workflows): API, approvals, automations register, templates and Describe It`. Then regenerate the lock: `python -c "import workflows.catalog as c; c.load_packs(); c.write_lock('workflows/catalog.lock.json')"`, drop the xfail in Task 1's test, commit `chore(workflows): catalog lock`.

---

## Phase 2: Packs and frontend (parallel, each from fresh `release/workflows-oct-2026` after Phase 1 lands)

Each pack task: register entities/events/actions/list sources in its file, add ONE `emit` line at each choke point, keep every existing test green, add its own test file with: every event has a sample that validates; every emit site fires (drive the module's own function and assert one outbox row); every action's `plan` and `run` against the sample; the pack's `allowed` rules.

### Task 9: HR pack

**Files:** Create `backend/workflows/packs/hr.py`; modify `routers/hr.py` (`create_employee` ~342, `create_employee_from_candidate` ~1011, `apply_status_change` 4808, candidate stage move), `hr_probation.py` (`start_for_new_hire` 455, `decide` 587), `routers/timeclock.py` (`request_timeoff` 12090, `decide_timeoff` 12320, `cancel_timeoff` 12398, `_decide_hr_level` 12553), `hr_letters.py` (request and decide), `salary_advance.py` (request and decide), `hiring_openings.py` (headcount request and decide), `hr_life_events.py` (`on_completed` 2050), `routers/extra_time.py` (claim and decide), `hr_custom_fields.apply_changes` 223; test `test_workflows_packs_hr.py`.

**Registers:** entities `employee` (observe fields per Task 3; dates `start_date`, `probation.end`, `contract_end`, `birthday` yearly, `start_date` yearly as "anniversary"; people `self manager hr_contact`; fields incl. `name department job_title manager_email company employment_type location status start_date probation.status probation.end custom.<key>` (custom fields from `hr_custom_fields.all_fields`, visibility from the field), `pay.*` with `visibility="comp"`), `candidate`, `time_off_request` (people `self manager hr_contact approver`), `letter_request`, `salary_advance`, `headcount_request`, `extra_time_claim`, `life_event`; events listed in spec 5.2 HR; actions `hr.start_checklist` (`hr_checklists.start_on_hire(db, emp, by, role_id)` style for a template), `hr.create_letter_request`, `hr.set_custom_field` (through `hr_custom_fields.apply_changes` with the run-as audience), `hr.add_note` (an `AuditLog` row plus the employee notes field the People screen shows); list sources `employees.probation_ending(days)`, `employees.contract_ending(days)`, `employees.started_within(days)`, `timeoff.pending_older_than(days)`.

- Steps: failing tests -> run -> implement -> run every HR test file touched (one per process) -> commit `feat(workflows): HR pack`.

### Task 10: Tasks and Tickets pack

**Files:** Create `backend/workflows/packs/tasks.py`, `packs/tickets.py`; modify `routers/task_util.py` `log_activity` (one emit mapping activity `type` + `entity_kind` to the event keys; tickets' `confidential_desk` carried in `extra`), `routers/tickets.py` (`request_approval` 3080, `decide_approval` 3094, `escalate_ticket` 3249 if not covered by activity rows); test `test_workflows_packs_tasks_tickets.py`.

**Registers:** entities `task` (fields `title code status priority project assignees owner due_date tags custom.<id>`; people `assignees creator followers project_owner`; `visible_to` = `task_util.task_visible_to`; link `{"taskId": id}`), `ticket` (fields `title code status priority type department assignee requester created_at sla_due`; people `assignee requester participants`; `visible_to` = the module's own rule with `include_confidential` handled in `load`), events per spec 5.2; actions `task.create` (via `routers.tasks._create_task(TaskCreate(...), _Later(), run_as, db, check_people=True)` under `task_automation._SUPPRESS`), `task.comment` (`task_util.create_comment`), `task.assign`, `task.set_field` (status/priority/custom via `update_task` as run_as), `ticket.create` (`tickets.file_ticket(TicketBody(...), _Later(), run_as, db, arrived_by="workflow")`), `ticket.comment` (`post_ticket_comment`), `ticket.assign`, `ticket.set_status` (`update_ticket`), `ticket.request_approval`; list sources `tasks.overdue(days)`, `tickets.unanswered(business_days)`, `tickets.breaching_sla`.
- The `caused_by_run` behavior pinned in spec 6.2 is tested here: `test_workflow_task_change_runs_tasks_rules_and_tags_their_events`.
- Commit `feat(workflows): Tasks and Tickets pack`.

### Task 11: Time, Shifts and Items pack

**Files:** Create `packs/time.py`, `packs/shifts.py`, `packs/items.py`; modify `timesheet_review.py` `_round` (one emit), `routers/timeclock.py` period close + `add_time` batch, `shift_log.py` `record` (one emit), `shift_attendance.py` no-show rollup, `weather_call.py` decision; test `test_workflows_packs_time_shifts_items.py`.

**Registers:** entities `timesheet` (review period; fields `employee status period_start period_end worked_min`; people `self manager hr_contact`; link `{"timecard": email, "start": period_start}`), `punch` (observe, high volume), `shift`, `item_checkout` and `item_assignment` (observe `status`; fields from the models; people `self` = the borrower/assignee, `manager`; link `{"view":"inventory"}`; `visible_to` = the caller may see Items); events per spec 5.2; list sources `timesheets.unsigned(days)`, `timesheets.not_reviewed`, `shifts.open_tomorrow`, `checkouts.overdue`.
- Items are NOT edited: the observer provides both Items events; the test drives a status change on an `ItemCheckout` row and asserts the event.
- Commit `feat(workflows): Time, Shifts and Items pack`.

### Task 12: Frontend module shell, list, overview, automations, runs

**Files:** Create `src/views/Workflows.jsx`, `src/workflows/WorkflowsApp.jsx`, `lib/sub.js`, `lib/useCatalog.js`, `lib/text.js`, `Overview.jsx`, `WorkflowList.jsx`, `Automations.jsx`, `Runs.jsx`, `RunDrawer.jsx`, tests `Workflows.test.jsx`, `lib/text.test.js`, `lib/sub.test.js`. Append: `api.js` (every route of Task 8 as `wf*` functions: `wfCatalog, wfCatalogSeen, wfList, wfCreate, wfGet, wfSaveDraft, wfPublish, wfStatus, wfReown, wfDuplicate, wfVersions, wfVersion, wfRestore, wfDiff, wfRecentEvents, wfTest, wfPreviewSchedule, wfRun, wfRuns, wfRunGet, wfRunReplay, wfRunCancel, wfOverview, wfTemplates, wfUseTemplate, wfSaveAsTemplate, wfAutomations, wfTaskRuleEnabled, wfSettings, wfSettingsSave, wfPauseAll, wfDescribe, wfApprovalDecide`), `App.jsx` (lazy import, `VIEW_MIN_ROLES.workflows = 'supervisor'`, case, `DEFAULT_SUBS.workflows = "overview"`), `Sidebar.jsx` (NAV entry `{ view: "workflows", code: "WFL", label: "Workflows", icon: Workflow, minRole: 'supervisor' }` inside the Modules group; `Workflow` icon import), `RoleContext.jsx` (`{ id: 'workflows', label: 'Workflows' }`), `lib/moduleCapabilities.js`, `lib/useActionCounts.js` (`workflows: { overview: 'Needs Attention' }`), `lib/approvalActions.js` (kind `workflow`: each option key -> `api.wfApprovalDecide(row.id, {option: key, note})`), `components/MobileMenu.jsx` SUBMENUS, `support/docsContent.js`.

**Interfaces:**
- `sub.js`: `parseSub(sub) -> {screen: 'overview'|'list'|'automations'|'builder'|'runs'|'run'|'templates'|'catalog'|'settings', id?: string}`; `buildSub(screen, id?)`; subs `overview | list | automations | wf:<id> | runs | run:<id> | templates | catalog`.
- `text.js` (pure): `describeTrigger(trigger, catalog)`, `describeCondition(row, entityDef)`, `describeStep(step, catalog)`, `describeWorkflow(definition, catalog) -> string[]`; uses `formatDate` for dates; Title Case for action names, sentence case for the rest.
- `useCatalog()` -> `{catalog, loading, error, entity(key), event(key), action(key), isNew(key)}` cached per session.
- Screens take `{sub, go(sub)}`; `WorkflowsApp` renders `ModuleTabs` (Overview, Workflows, Automations, Runs, Templates, Catalog) and the paused-all banner from `/overview`.
- `Runs.jsx` has a segmented control Runs / Actions (`kind` query), filters, keyset paging, and opens `RunDrawer` (`Modal`, step timeline with `StatusLabel`, input/output as definition lists, Replay / Cancel buttons, link to the subject via `nexus:navigate` + `openNotificationTarget`).
- `Automations.jsx`: Tasks rules with a `Switch` per row (SettingsUI), link "Edit in Tasks > Manage" (`nexus:navigate` to `tasks` sub `manage`), and the built-in jobs list.

- [ ] Steps: write the smoke tests first (loading, empty, rows, paused banner, automations toggle calls `wfTaskRuleEnabled`), run (fail), implement, `npm run lint`, `npx vitest run src/workflows src/views/Workflows.test.jsx`, `npm run build` (note the bundle number), commit `feat(workflows): module shell, overview, list, automations and runs`.

### Task 13: Frontend builder

**Files:** Create `src/workflows/Builder.jsx`, `builder/*.jsx`, `lib/definition.js`, tests `Builder.test.jsx`, `lib/definition.test.js`.

**Interfaces:**
- `definition.js` (pure): `emptyDefinition(trigger?)`, `newStep(kind, action?) -> step` (uuid ids via `crypto.randomUUID`), `problems(definition, catalog) -> [{path, message}]` (client mirror of the main checks: required params, missing branches, unknown keys, templates with unknown paths), `insertStep / removeStep / moveStep / toggleStep(definition, path, ...)` returning new objects, `pathOf(stepId)`, `definitionHash` not needed client side.
- `ParamControl` renders by `param.type`: `template` = textarea with a "Insert Field" picker (menu of the entity's fields and `change.*`, `actor.*`, `today`); `recipients` = chips from `people` roles + `PersonMultiSelect` + role/department/team pickers; `select` from options; `number` = `NumberBox`; `duration` = number + unit; `date_offset` = field select + offset + time (`TimeField`); `entity_ref` = the module's picker (project via `api.getTaskProjects`, ticket department, HR checklist template, letter template); `approvers` = recipients + mode select; `options` = chip editor; `bool` = `Switch`; `list_source` = source select + its params.
- Cards: `TriggerCard` (kind tabs; event picker grouped by module with search and New badges; filters rows), `ConditionsCard` (groups; row = field select / operator select per type / value control), `StepList` (DragList-style reorder within a lane, Move Up / Down buttons, Skip toggle, Delete), `StepCard` (collapsed sentence from `text.js`, expanded editor; `if` and `approval` show lanes), `AddStepMenu` (grouped by module, search), `RailSettings` (owner `PersonSelect`, scope select, run-as for GA, enrollment, caps, onError + fault steps), `RailTest` (recent events list -> `wfTest` -> trace: conditions with values, planned lines, waits; schedule preview), `RailVersions` (list, diff lines between two, Restore), `DescribeIt` (textarea + Draft It; shows problems; only on a new workflow), `RunDialog` (manual trigger subject picker -> `wfRun`).
- Top bar: name (inline edit), status chip, Save Draft, Test, Publish (disabled with the reason when problems exist or untested), Pause / Resume, Duplicate, Archive (confirm via `dialog.confirm`).

- [ ] Steps: tests first (renders a definition as sentences, adding a step through the menu, problems block Publish, Test shows the trace), run (fail), implement, lint, vitest, build, commit `feat(workflows): builder`.

### Task 14: Templates, Catalog, Settings panel, docs

**Files:** Create `src/workflows/Templates.jsx`, `Catalog.jsx`, `WorkflowsSettings.jsx`, tests; append `views/AdminConsole.jsx` (SUBJECT `workflows` section `ops`, faces both; GROUP `workflows-config` scope `layered`, `needs: { role: 'administrator', grant: ['workflows', 'full'] }`; lazy panel; case; `COMPANY_STATE['workflows-config']`), `scripts/check-bundle-size.mjs` cap (dated note), `docs/Workflows.md` (user guide + developer guide: how to register an entity/event/action, the lock, the no-chaining rule, the off switches), CLAUDE.md section "Workflows" (10 lines: the one emit rule, the lock, never a second engine, RLS tables).

- `WorkflowsSettings` panel contract `{company, onOverride, toastOk, toastErr}` with SettingsUI rows: Workflows On (per company), Pause All (org only, GA, with who/when), Owner Digest, Runs Per Hour Cap, Recipients Cap, Webhook Hosts (GA, text list) + secrets (write-only boxes), Nexus Run-As (GA).
- Commit `feat(workflows): templates, catalog browser, settings and docs`.

---

## Phase 3: Integration

### Task 15: Combine, review, fix, CI

- Merge every branch into `release/workflows-oct-2026`; resolve append-only conflicts by hand.
- Run every new backend test file one per process, `ruff check backend/`, `npm run lint`, `npx vitest run`, `npm run build`.
- Four review agents (pay/data safety and permissions; engine correctness and loops; frontend UX against the house rules; merge integrity and append-only files), fix every finding with a test, re-run.
- Release checklist in the PR body: the 8 RLS tables (dev now, prod at release), `get_advisors`, the bundle cap raise, Teams `kind="workflow"` needs no new Graph scope, Describe It needs `ANTHROPIC_API_KEY` (already set), the owner digest default off.
- Open ONE PR to dev. Do not merge: Neil merges after his OK.
