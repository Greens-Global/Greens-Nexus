# Greens Nexus — Claude Code Guide

Internal company portal for Greens Global. React 19 + Vite frontend (`frontend/`),
FastAPI + SQLAlchemy backend (`backend/`), Supabase Postgres/storage/realtime,
Microsoft Entra ID (MSAL) auth.

## Run locally

```
# backend (terminal 1) — uses its own SQLite unless DATABASE_URL is set in backend/.env
cd backend && uvicorn main:app --reload --port 8000

# frontend (terminal 2) — talks to localhost:8000 by default
cd frontend && npm run dev
```

Local backend identity comes from `backend/.env`: `NEXUS_SKIP_AUTH=true` +
`NEXUS_DEV_EMAIL=<your work email>`. Change the email to impersonate a different
role for testing. `NEXUS_SKIP_AUTH` is refused on Azure — it can never deploy.

Verify frontend changes compile with `npm run build` before committing.

Before pushing, run what CI runs: `ruff check backend/` and, in `frontend/`,
`npm run lint` and `npx vitest run`. Backend tests run ONE FILE PER PROCESS
(`python -m pytest test_x.py` or `python -m unittest test_x`): most files bind
`database` to their own throwaway SQLite when they are imported, so in a run
of several files the later ones work on the first one's database - a file
that empties tables would empty the wrong ones (Sep 29: a multi-file run
cleared people and roles in a local `greens_nexus.db`). `backend/conftest.py`
turns the request rate limiter off for pytest runs; its own tests switch it on.

## Git workflow (non-negotiable)

- `main` = production. `dev` = integration; every merge auto-deploys
  (Cloudflare Pages frontend ~1 min; Azure backend ~4 min, **restarts the dev API**).
- One branch = one task, not one module. Born from fresh `dev`, merged via PR
  within a day or two, then deleted. If it can't merge by tomorrow evening, the
  task was too big — split it.
- Announce in team chat before merging to `dev` (someone may be mid-testing).
- Never commit directly to `dev`/`main`. Never commit `.env*` files.

## File ownership

| Area | Owner | Files |
|---|---|---|
| Items / checkouts / assignments / notifications UI | **Visesh** | `frontend/src/views/InventoryManagement.jsx`, `frontend/src/components/Assignments.jsx`, `frontend/src/components/NotificationBell.jsx`, `frontend/src/components/NotificationToasts.jsx`, `backend/routers/items.py` |
| Asset Management / Property Portfolio | **Neil** | `frontend/src/views/PropertyAsset.jsx`, `frontend/src/views/AssetModule.jsx`, `frontend/src/asset/`, `backend/routers/assets.py`, `backend/routers/property_assets.py`, property models/tables |

Machine-readable copy: `backend/code_owners.py` (Build Mode routes pins and
the build-notes skill refuses commits by it) - change both together.

**Do not modify the other developer's files** — ask them instead.
Shared files (`backend/models.py`, `backend/main.py` migrations list,
`frontend/src/api.js`, `App.jsx`/`Sidebar`): **append only, never reorder**,
keep the diff minimal.

## Backend conventions

- Copy patterns from `backend/routers/items.py` — it is the reference
  implementation for endpoints, permissions, and notifications.
- **Notifications are created server-side only** (see `_notify` in `items.py`).
  Employees get 403 on the notifications POST API, so client-side
  `addNotification` for workflow events silently fails — never rely on it.
  Target notifications at a specific `recipient` email; empty recipient =
  broadcast to all managers (avoid unless intentional).
- One notification per workflow/order, updated in place — never one per item.
  Multi-row updates that batch notifications need `with_for_update()` row locks
  (concurrent requests otherwise race the dedupe; this bit us hard).
- Sessions run with `autoflush=False`: uncommitted changes are NOT visible to
  queries in the same request — sibling-count queries must exclude/add the
  current row manually.
- **Never do blocking I/O on the async event loop.** Background loops (the
  `*_loop` tasks started in `main.py`'s lifespan) and any `async def`
  endpoint/middleware must push synchronous DB queries and outbound HTTP
  (Microsoft Graph) into a thread via `await asyncio.to_thread(...)` —
  copy `reminders_loop` / `long_session_loop`. A sync call left on the loop
  freezes the WHOLE worker (every request it is serving, CORS preflights
  included) for the call's full duration. This caused instance-wide ~16s
  freezes that looked like "random slow modules" and CORS/502 storms (Aug 2);
  the fix was moving the `task_notify` / `ticket_notify` scans into `to_thread`.
- New columns: add to the model in `models.py` AND an
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` line in BOTH of `main.py`'s
  migration lists (SQLite AND Postgres). Model columns missing from the live DB
  break every SELECT with a 500.
- New tables: define the model; `create_all` creates it on startup — but with
  **RLS disabled**. You MUST `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on BOTH
  dev and prod as part of the release. The backend bypasses RLS via the
  privileged `DATABASE_URL`; RLS only locks out the public anon key, so a new
  table without it is fully exposed to anyone holding that key. Run
  `get_advisors` after every release — this gap recurs.
- Photo URLs from clients must pass `_validate_photo_url` (Supabase storage only).
- **Evidence buckets are PRIVATE** (Sep 22): `checkout-photos`, `item-photos`,
  `return-photos`, `ticket-evidence`, `qa-evidence`, `task-files`,
  `ir-documents`, `construction-media`, `asset-files` have `public = false` on dev and prod (`document-images`
  stays public: e-sign signers load it with no login). The database still stores the canonical
  `.../object/public/<bucket>/<path>` URL; browsers open it only through
  `GET /files/view?u=<url>` (`routers/files.py`, signed-URL redirect, login
  required). `api.js` rewrites those URLs to the viewer on every response and
  back to canonical on every JSON request, so screens never see the
  difference - do not build a second path, and never make a new evidence
  bucket public. A new protected bucket goes in BOTH `PROTECTED_BUCKETS` lists
  (`routers/files.py`, `frontend/src/lib/storageView.js`) and gets
  `update storage.buckets set public = false` on dev and prod.
- **Outlook Actionable Messages** (task emails, `task_mail_actions.py` +
  `routers/mail_actions.py`): clicks are authenticated with a Microsoft Entra
  ID token (the legacy substrate.office.com token died Jun 8, 2026 - never
  bring it back). The card is emitted only when BOTH `NEXUS_AM_ORIGINATOR` and
  `NEXUS_AM_AUDIENCE` (AppIdUri, then the Entra app's client id, comma-
  separated) are set; setup is `docs/Actionable-Messages-Setup.md`.
  The signed task token in the URL is what proves an email was ours.
- **Contact Directory** (`routers/directory.py`, Oct 2026): contact fields
  only, never `hr._serialize`; availability (off / leave / holiday / punch /
  shift) is computed per call in `_availability`, the roster is cached per
  company-wall key. Teams presence dots need the `Presence.Read.All`
  APPLICATION permission with admin consent on the Entra app
  (`docs/Teams-Presence-Setup.md`); until then `/directory/presence` answers
  `enabled: false` and the UI shows no dots - never treat that as an error.
- **Rate limiting** (`RequestRateLimit` in `middleware_hardening.py`, Sep 22):
  per-minute budgets keyed on the session/bearer for signed-in callers, per IP
  for anonymous ones, tighter on credential-taking routes, plus a per-IP
  ceiling. In-process per worker, so it is a flood backstop. `/health` and
  `/version` are exempt; a new public probe endpoint goes in `EXEMPT_PREFIXES`
  and a new credential-taking route in `SENSITIVE_PREFIXES` (30/min, always
  per IP whatever headers it carries) - or in `SHARED_SOURCE_PREFIXES` when
  its real callers share an address (Outlook's action servers, GitHub).

## Frontend conventions

- All server calls go through `frontend/src/api.js` — add new endpoints there.
  It already retries idempotent GETs on 5xx/network with backoff and debounces
  the "reconnecting" banner; do not add a second retry layer on top.
- **Never let a screen render blank.** The whole app is wrapped in
  `RootErrorBoundary` (`main.jsx`) and each view in `ViewErrorBoundary`; the gap
  where MSAL is mid-interaction is filled by `AuthBusyFallback` (`App.jsx`). Any
  new top-level surface or provider that can throw must keep a boundary above it
  — a crash without one unmounts React to a white screen. For pending data show
  a skeleton/loader via `AsyncState.jsx` (`AsyncSection` / `SkeletonBlocks`),
  never nothing. New high-risk views get a render-smoke test (`*.test.jsx`, run
  in CI) so a crash-on-render is caught before merge.
- File uploads: use the existing Supabase upload helpers (they set
  `cacheControl: '31536000'`; image paths are unique and cached immutably).
- Cross-view navigation uses the `nexus:navigate` window event
  (`window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }))`).
- Tab strips use the `.scroll-tabs` class (hidden scrollbars, mobile swipe).
- **Popups cover 60% of the screen** (Pranshu, Oct 15 2026): every modal /
  dialog / popup panel is `width: 60vw` and `min-height: 60vh` (at least
  ~420px wide, never wider than the viewport, `max-height: 85vh` with its
  body scrolling). Never a small fixed-width box that floats mid-page with
  empty space around it. Phones keep the full-screen sheet. The shared
  `Modal` in `tasks/components.jsx` is already 60vw wide; match it in any
  hand-rolled overlay. **The 60% is for content, not blank space** (Pranshu,
  Oct 21 2026): the popup body is a flex column and the one part that should
  take the remaining height - the notes textarea's wrapper, the list, the
  table, the preview - carries `className="nx-fill"` (style.css) so it grows
  into the space; never leave a short form floating over an empty bottom
  half.
- Match the existing inline-style idiom and Inter font; reuse `TYPE_META` /
  status-badge patterns rather than inventing new chip styles.

## Domain rules

- **Transient items** = checkout/return lifecycle (`item_checkouts`):
  pending → approved → pending_receipt → allocated → returned. Due dates count
  from handover, not request.
- **Permanent items** = assignment lifecycle (`item_assignments`):
  pending_acceptance → active → return_initiated (normal/dead/lost/reassign) → closed.
  Items carry `assigned_to_email` as the current pointer; history lives in the
  assignment rows. Per Neil: Items and Assets are ONE concept — equipment
  warranties/serials belong on the `items` table, do not build a parallel system.
- Photos are evidence: checkout handover, receipt, and return require them
  (lost-item reports are the exception). Permanent-assignment ACCEPTANCE photo
  is optional (Neil, Jul 17 — one-click accept); assignment returns still
  require one.
- People pickers: always the curated Nexus People list (`getPeopleDirectory()`
  → `/myhr/directory`), never M365/GAL-derived lists. Backend approver/allocator
  endpoints filter role-holders against `nexus_employees`.
- Every image-upload widget must accept Ctrl+V clipboard paste (see
  `imageFromPaste` in `InventoryManagement.jsx` / `filesFromPaste` in
  `tasks/lib.js` for the pattern) with an "or press Ctrl+V…" hint.
- Time Clock paid leave: a punch pair whose job category says Sick / Vacation
  (matched by `_leave_class` in `timeclock.py`: "Sick Day", "PTO", "Annual
  Leave"...) is its own pay class - separate "Total Sick hours" / "Total
  Vacation hours" line at the base rate, excluded from the overtime split,
  still counted in `workedMin` (the attested total) - SwipeClock parity
  (Charmi, Sep 21). No separate leave-hours table; approved time-off
  requests are NOT auto-punched.

- Task emails are BATCHED (Neil, Sep 24): an event that can wait goes into
  `task_email_queue`, and `task_notify.flush_batches` (every minute, inside
  `task_notify_loop`) sends one email per person once their OLDEST pending row
  is older than the company `batchWindowMinutes` (default 60; 0 = instant).
  Relevance is re-checked at send time (deleted / reassigned away / completed /
  muted rows are dropped; nothing left = nothing sent). Mentions, deletions,
  urgent tasks and tasks due today/tomorrow never wait. New task email events
  go through `notify_task_event` - never mail directly - so they batch too.
- Timesheets are approved through review + Nexus Sign (`timesheet_review.py`;
  ONLY THE EMPLOYEE SIGNS - Neil, Oct 16 2026). After the period's last day
  the manager (else the company's HR contact; nobody at all = the Global
  Admins) clicks Review & Approve - no signature, no submission needed - or
  Send Back with a note (back and forth, one side edits at a time -
  `guard_edit` is called from every timeclock route that changes hours; add
  it to any new one). Approval sends an envelope to the employee, its only
  signer; their signature finalizes the period, and the PDF carries the
  timestamped `approval_log`. Any change after approval (punch-fix request,
  manager edit, Nexus Sign decline) voids the envelope and reopens it to the
  manager; HR (`is_hr`) edits at any point without approval and the employee
  signs the updated card ("approved" state, `employee_approve`). HR's Unlock
  starts a new round ("unlocked"). An employee who left, or has not signed an
  approved card in `UNSIGNED_WAIT_DAYS`, is finalized by HR with a reason
  (`finalize_unsigned`) - never by hiding the signature step. The signed copy
  files to the employee's Egnyte folder (`egnyte_folder`). The old one-click
  `/my-timecard/sign` returns 410; never add a signing path around this.
  `test_timesheet_review_matrix` drives every state x actor x action - keep it
  passing so nobody gets stuck.
- HR signing order (Neil, Oct 22 2026): the company NEVER signs before the
  employee - no pre-signed or countersigned document is ever sent out. An
  offer letter is signed by the candidate only (no company signer, no Signs
  Once; HR's Verify And Send is a review, not a signature); hiring packets,
  separation packages and every other HR packet are signed by the person
  FIRST and countersigned by the company after (a Signs Once signature goes
  on only when its turn comes after the person, never at send).
  `hr_packet_docs.signing_flow` applies this to every packet, old saved
  configs included - never add an order around it.
- Accounting dashboard (Sep 22): the Accounting view's Overview / Cash /
  Performance / Close / Data tabs are the Nexus face of the finance dashboard
  in Nexus Accounting. Figures come ONLY through `backend/routers/
  accounting_dashboard.py` -> the accounting app's `/api/internal/dashboard`
  (internal key), never the accounting database. The calculation modules in
  `frontend/src/accounting/dashboard/model/` are compiled from the accounting
  repo's `src/lib/finance/dashboard/*.ts` - change them THERE, then re-emit
  with tsc (see the accounting repo's CLAUDE.md), never edit the .js by hand.
  Writes carry the caller's name; each tab shows one section at a time.

- **Feature requests are tickets** (Oct 23 2026, `feature_requests.py`): a
  request from What's New is filed as a `feature_request` ticket through
  `tickets.file_ticket`, and every such ticket (whatever door) gets a What's
  New status card (`changelog_feedback.ticket_id`). The card's comments ARE
  the ticket thread (`/task-changelog/requests/{id}/comments` ->
  `post_ticket_comment`) - never store request comments anywhere else. Each
  new request is posted to the "Nexus - Feedback and Bugs" Teams chat via the
  ticket Teams queue (`kind='feedback_chat'`), as the requester if they are in
  the chat, else the assignee, else `NEXUS_FEEDBACK_CHAT_POSTERS`.
  ONE status story: the request status (What's New Manage) leads and
  `push_status_to_ticket` moves the ticket (Shipped = Resolved, Declined =
  Closed, the rest Open / In Progress; no ticket email for it - the What's
  New bell is the notice); a ticket resolved / closed / reopened by ANY path
  moves the request via the before_flush hook in `feature_request_sync.py`
  (wired in `database.py`) - do not add per-route sync calls.
- Accounting entity access (Neil, Sep 25): the Accounting grant opens the
  screen; WHICH entities a person reads is `nexus_access_scopes` rows with
  module `accounting` (Accounting > Access tab, Full level). No rows = every
  entity; an entity brings its sub-entities. Every new accounting read MUST
  take `Depends(entity_scope)` and pass its entities through `_limit` (or
  check them against `_with_children`) - `routers/accounting.py` is the
  reference. One entity always travels as `location`: the accounting app reads
  `locations` only when there are several. Anything that only exists
  consolidated (the dashboard tabs, the accounting app) takes
  `require_unlimited`.
- Personal financial statements (`routers/pfs.py`, Sep 2026) are the most
  sensitive records in Nexus: owners and the explicit `pfs` grant only
  (`bypass_level="owner"` - an administrator's role does NOT open them). Never
  store a full Social Security number, never log a figure, keep the audit rows.
- Leasing (`routers/leasing.py`, Sep 2026): a tenant is an Intacct customer;
  rent received is what posted to the lease's income accounts for that
  customer in that month - never key a payment into Nexus. A tenant who leaves
  is ENDED (`/replace`), never overwritten. Nothing is emailed to a tenant
  automatically.

- Workforce Scorecard (Neil, Oct 10 2026, `workforce_scorecard.py`): hourly
  staff are scored weekly on punched hours vs. expected hours. Expected =
  published shift > shift preset > country standard day (US 8h, IN 9h, Mon-Fri,
  full-time only; part-time with no shift = "No Schedule", never guessed).
  Holidays and approved time off excuse the day; Sick / PTO punches are leave
  that covers it; only days before the person's own local today are scored.
  Access is the `workforce-scorecard` grant (viewer = DIRECT reports - Neil:
  the default; editor = whole reporting line; full = company); the Monday
  email goes to every grant holder with people in scope.
  The screen and the email are built by the same `build_report` - never add a
  second calculation path.

- **Shifts (Oct 14-15 2026, PRs #589-#594, plan https://claude.ai/artifact/1cU9Zec3fXwyWUrEEAadbN).**
  ONE expected-start / Late rule: `backend/shift_expect.py` (earliest live
  placement for the day - a weather-cancelled day is none, never the preset;
  else the usual-hours preset on its working days; grace from the shift type,
  else the company's `defaultGraceMin`; zone placement -> shift type -> the
  company's team zone). `timeclock._shift_start_for`, My Team, the Workforce
  Scorecard and the no-show scan all read it - never add a second rule.
  Shift settings are PER COMPANY (`routers/shift_requests.get_settings(db,
  company_id)` = defaults <- tenant row <- sparse company override;
  `settings_for(db, email)` for a person) and shift types / groups carry
  `company_id` ('' = shared); writes go through `_require_company_manage`.
  Trading (swaps, offers, open-shift requests), releasing a shift to the open
  pool and cross-team open shifts are OFF by default (Neil) - switches in
  Settings > Shifts & Scheduling, per company. `shift_attendance.py`: the no-show
  scan (every minute, in a thread; one rollup bell per team and day to the
  manager, backup manager and group schedulers, one email, resolved in
  place; `noShowAlertMin`, 0 = off) and `actuals()` (On Time / Late / Left
  Early / No-Show / Excused per person-day, from `_day_summaries`; a Sick/PTO
  punch is not a clock-in; non-managers get status words only).
  `shift_rules.py`: rest, days in a row, daily OT (people on the CA rule),
  weekly OT on the PAYROLL week (Sunday), week caps on the display week;
  rules WARN, never block; Share runs `_publish_review` first and a reason
  is required (per the warned person's company) only for rule warnings and
  approved-off / holiday conflicts - the reason is stored only on the warned
  shifts' `shift_change_log` rows and never shown to staff. Every schedule
  write records to `shift_change_log` through `shift_log.record`.
  `shift_calendar.py` writes shared shifts to Outlook (Graph app-only
  Calendars.ReadWrite, `docs/Outlook-Calendar-Setup.md`; waits quietly until
  consent is granted) - OFF by default (Neil, Oct 15: an event filled the
  whole working day): a company turns `outlookCalendarOn` on, and every tick
  `queue_switched_off` takes events off calendars whose company or person
  has it off. Never rename the key back to `outlookCalendar` (every settings
  save stored that one as true), `routers/shift_ical.py` is the signed personal feed,
  `shift_confirm.py` the confirm-my-schedule ask and nudge,
  `shift_offboard.py` clears a leaver's future shifts. New shift tables rely
  on `_enable_rls_everywhere`; run `get_advisors` after each release.

- **Settings is one tab (Neil, Oct 23 2026, plan
  https://claude.ai/artifact/UGtPmeFBrfU6wXhd474erx; `views/AdminConsole.jsx`).**
  Every setting has ONE scope - the organization, one company, or an
  organization default a company may override - and the screen shows it: a
  rail of SUBJECTS (`SUBJECTS`), a Scope picker ("Every company" or one
  company) and under each subject its setting GROUPS (`GROUPS`), all open -
  no accordions, nothing behind a click. With a company picked, each subject
  shows its company face (the old Company Settings tabs, spread over the
  subjects they belong to: Profile / Departments / Holiday Calendar under
  Companies, sites under Locations, Roles under People & Access, Checklists
  under Hiring & Onboarding, the policy under Workforce Analytics); subjects
  with nothing per company sit under "For every company" in the rail. The
  sub is `<subject>[:<group>][@<companyId>]`; every pre-merge key
  (`global`, `global-<category>`, `company`, `access`, `actas`) still lands
  (`resolveSub`). A new setting = one `GROUPS` entry (subject, face, scope,
  keywords, and `needs` - who may open it, exactly what its save route
  demands: the role tier, an Access Group grant, `people` for an /hr route;
  `mayOpen` is the ONE visibility rule, so never hide a group from inside
  its panel instead) + one `renderGroup` case; the panel stays the
  component its module owns - never a second copy. Panels draw controls with
  `components/settings/SettingsUI.jsx` (Neil, Oct 25 2026: "world class") -
  `SwitchRow` / `SettingRow` / `NumberBox`: title and description left,
  control right, hairline rows; a switch saves on click, a form's Save shows
  only once something changed; a group made of rows sets `flush: true`.
  Styles are the `.nx-set-*` rules in style.css; never hand-roll another
  switch. Settings holds what defines the shape
  of a module or a company and is changed rarely by an administrator; a
  module keeps what its managers maintain daily (Tasks > Manage, KB
  collections, Accounting's own tools stay put). Copy says "Settings >
  <subject>", never "Global Settings" / "Company Settings". A setting a company
  may override layers defaults <- tenant row <- `<key>:<company_id>` through
  `backend/scoped_settings.py` (the pay rules and time-off reasons use it;
  Shift Settings and Payroll Readiness have the same shape of their own) -
  readers resolve by the EMPLOYEE's company (`_round_min(db, email)`,
  `_break_cfg_for`, `_compute_timecard`), so a company with no override
  reads the tenant row exactly as before. The leave start date layers the
  same way (`leave_balances.cutover(db, company_id)` / `cutover_for`). ONE
  email logo chain (`email_theme.logo_for`): the recipient's company logo,
  else the module's own logo setting, else Email Appearance, else the
  wordmark - a mail with no recipient at hand keeps the theme's.

## Asana — removed (Sep 2026)

The Asana workspace is gone and the two-way sync, import, OAuth, webhook and
rescue code has been deleted. **Do not rebuild any path to Asana.** The data
was deliberately kept: every `asana_*` table and row (task/comment/attachment/
activity links with their Asana gids, the project map, import jobs, user
tokens) and every Asana-derived column (`synced_with_asana`,
`original_asana_url`, `asana_option_gids`, `employees.asana_id`) stays as a
permanent record of where each task came from - never drop them, and keep
their models and migration lines. Imported content still renders as before
(`[Asana · Name]` comment authors, read-only "Calculated in Asana" fields,
`asana` entries in a task's due-date history).

Rows that still point at Asana-hosted files or pages have dead links (1,834
on dev at removal, ~600 of them files only Asana ever stored). The read-only
`GET /asana-legacy/audit` (`backend/asana_legacy.py`, manager-only, no UI)
lists every one and counts the archived rows. The custom-status merge that
used to live in the sync is `backend/task_status_dedupe.py`; the API's
public-URL helper is `app_url.public_base`.

## Asset Management module (Neil's)

`frontend/src/asset/` (the module, mounted by `views/AssetModule.jsx`) and
`backend/routers/property_assets.py`. The data is real: 24+ properties,
vehicles and equipment with their records (warranties, inspections, plans,
utilities, AHJ, vendors, maintenance, permits, timeline) and an activity log.

- **Saves are per row** (Oct 21 2026): `useNexusStore` diffs the store before
  and after every change (`lib/diff.js`) and `lib/sync.js` POSTs only the rows
  that changed to `/property-assets/changes`; each row carries the `_rev` it
  was read with and a row the server changed since comes back in `conflicts`
  (the tab re-pulls and says so). Never bring back a whole-portfolio save from
  the client - `PUT /workspace` is an officer's seeding tool only.
- **Privacy and scope are the server's**: `GET /workspace` returns only the
  assets the caller may see (`private` assets are officers' alone -
  `property_links.can_see_private`; `nexus_access_scopes` rows for
  `property-asset` narrow the rest) and every row write is checked the same
  way. Only an officer sets or clears Private.
- **Files are URLs**: photos and documents go browser -> the PRIVATE
  `asset-files` bucket (`lib/upload.js`) and the record keeps the canonical
  URL; the save refuses a new data: URL. `asset_files_migrate.py` moves the
  old inline ones.
- **Map points come from the server**: `asset_geocode.py` looks each address
  up once (Nominatim, paced, never a private asset) and keeps `geo` on the
  asset; the browser never geocodes.
- The strip is Overview / Maintenance / Records / Timeline; the seven record
  collections live under Records as a segmented control; `view` still holds
  the collection key, so deep links from bells, Critical Items and the
  Activity Log land on the right table.
- **Every open asset is a URL** (Oct 21 2026): `/property-asset/a:<id>:<view>`
  (`assetSub` / `parseAssetSub` in `lib/navigation.js`; the portfolio stays
  `/property-asset/asset-portfolio`, the shell's default sub). The module's
  state writes the segment and a segment arriving from outside (a pasted
  link, Back) sets the state - keep both effects; never navigate by setting
  `activeId` from a URL anywhere else.
- **The street line is the street**: `splitAddress` (`lib/dataNormalization.js`)
  peels "City, ST ZIP" off `address` into city / state / zip / county on every
  load and on create, keeping the original line as `addressRaw`. Add Asset is
  one screen (class, name, one address line, type, stage); everything else is
  filled on the asset.
- **Nothing is deleted by code, ever** (Neil, Oct 21 2026 - the release must
  lose no data): the activity log is append-only (the GET bounds what a tab
  sees, the database keeps everything); Delete Forever works only from the
  Trash, a live asset is moved there instead, and the log stays; a stamped
  row is written only with the `_rev` it was read with - a save without one
  (a cached copy, an old tab) is a conflict, never an overwrite, and deletes
  carry `deleteRevs`; a change the server did not keep leaves no log entry;
  only a NEW `data:` file URL is refused (a legacy path or outside link is a
  link); what the migration or geocoder did to a row travels with a tab's
  next save (`_carry_over`); `PUT /workspace` is refused on a deployed API
  unless `NEXUS_ASSET_SEED_PUT` is set; the save queue keeps a batch through
  404 / 405 / 429 / 401 (a deploy window) and drops only 400 / 403 / 413 /
  422, with a notice. The release runbook with the backups, the bucket and
  the verify lists: https://claude.ai/artifact/MZR3srrjuzCQQYHTMERgNU .
- Equipment and vehicles pair with Item Management (`AddItemModal`) - do not
  build a second warranty/serial system there.

## Gotchas

- The shared dev database (Supabase `greens-nexus-dev`) backs the live
  dev.nexus site — if your local backend points at it via `DATABASE_URL`,
  SELECT freely but only mutate rows/tables you created.
- DevTools "Disable cache" makes image caching look broken — uncheck it before
  judging load behavior.
- The root README describes an old static site — ignore it; this file and
  `git log --oneline` are the real documentation.
- Use American English spelling everywhere — code, comments, UI copy, email/
  notification templates, docs (e.g. "color" not "colour", "behavior" not
  "behaviour", "organize" not "organise", "license" not "licence").
- Use US date and time format everywhere in user-facing UI, copy, and exports:
  dates as MM/DD/YYYY (never ISO YYYY-MM-DD or DD/MM/YYYY) and times as 12-hour
  with AM/PM (never 24-hour) - Charmi/Visesh, Aug 4. Use the shared helpers in
  `frontend/src/lib/datetime.js` (formatDate / formatTime / formatDateTime)
  instead of ad-hoc toLocale*/Intl.DateTimeFormat calls so it stays consistent
  app-wide. Date BOXES are `DateField` (`tasks/components.jsx`), never a native
  `<input type="date">` - that one follows the computer's region and shows
  20-10-2026 on an Indian laptop (Neil, Oct 19). `npm run lint` (CI) fails on
  any NEW native date box or toLocaleDateString / toLocaleTimeString /
  Intl.DateTimeFormat call (`frontend/scripts/check-dates.mjs`; older code is
  in its baseline and may only go down).
- **UI text casing (Neil, Jul 28 — supersedes any earlier sentence-case note):
  Titles, headings, tab labels, and buttons use Title Case** ("Punch In",
  "Start Break", "Time Sheet", "Request Time Off"). So do status labels,
  chips and column headers ("In Progress", "On Hold", "Awaiting Approval" -
  never "In progress"; Neil, Sep 30). Body copy, hints, empty states, and
  descriptions stay sentence case.
- **American English, US formats, no exceptions (Neil, Oct 17 2026 - raised
  more than once):** every user-facing string, server-built ones included
  (notification titles and bodies, priority notices, emails, PDFs), shows
  dates as MM/DD/YYYY - never interpolate a raw ISO `2026-10-04` (route it
  through `us_date` / `_us_day` on the backend, `formatDate` on the
  frontend) - times as 12-hour AM/PM, and American spelling. Notice titles
  are Title Case like any other title. The time record is a **"Time Sheet"**
  in copy (two words, capitalized in titles) - not "timecard", "time card"
  or "timesheet"; identifiers and route keys (`timecard`, `timesheet`) stay.
- Never use em dashes in user-facing copy — plain hyphens ("-"). Em dashes
  read as AI-generated (Visesh, Jul 28).
