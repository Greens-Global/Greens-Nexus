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
| Asset Management / Property Portfolio | **Ankush** | `frontend/src/views/PropertyAsset.jsx`, `backend/routers/assets.py`, property models/tables |

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
  `ir-documents` have `public = false` on dev and prod (`document-images`
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
- **Rate limiting** (`RequestRateLimit` in `middleware_hardening.py`, Sep 22):
  per-minute budgets keyed on the session/bearer for signed-in callers, per IP
  for anonymous ones, tighter on credential-taking routes, plus a per-IP
  ceiling. In-process per worker, so it is a flood backstop. `/health` and
  `/version` are exempt; a new public probe endpoint goes in `EXEMPT_PREFIXES`
  and a new credential-taking route in `SENSITIVE_PREFIXES`.

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
- Timesheets are signed through review + Nexus Sign (Sep 2026,
  `timesheet_review.py`): employee submits -> manager sends back / agrees (back
  and forth, one side edits at a time - `guard_edit` is called from every
  timeclock route that changes hours; add it to any new one) -> an envelope of
  the agreed version is signed employee -> manager -> the company's HR contact
  (`hr_entities.hr_contact_email`) -> HR's signature finalizes the period.
  A Nexus Sign decline hands it back for another round. The old one-click
  `/my-timecard/sign` returns 410; never add a signing path around this.
- Accounting dashboard (Sep 22): the Accounting view's Overview / Cash /
  Performance / Close / Data tabs are the Nexus face of the finance dashboard
  in Nexus Accounting. Figures come ONLY through `backend/routers/
  accounting_dashboard.py` -> the accounting app's `/api/internal/dashboard`
  (internal key), never the accounting database. The calculation modules in
  `frontend/src/accounting/dashboard/model/` are compiled from the accounting
  repo's `src/lib/finance/dashboard/*.ts` - change them THERE, then re-emit
  with tsc (see the accounting repo's CLAUDE.md), never edit the .js by hand.
  Writes carry the caller's name; each tab shows one section at a time.

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

## Asset Management module — scope (Ankush)

Everything currently on the Property Portfolio screen (`PropertyAsset.jsx`) is
**hardcoded mock data**. The job is to make it real, in roughly this order:

1. **Properties** — `properties` table + CRUD endpoints in `assets.py` + the
   portfolio cards/Add Property modal backed by the API (name, type, address,
   units, acquisition cost, year completed, asset manager, occupancy).
2. **Equipment Warranties** — fields live on the existing `items` table
   (serial number, asset tag, purchase date/cost, warranty end, vendor), NOT a
   separate system. Expiry list + bell notifications when warranties near expiry.
3. **As-Built Plans** — document upload per property (Supabase storage, reuse
   the upload helpers) with list/view/download.
4. **Annual Inspections** — inspection schedule per property, due-date
   reminders into the bell (server-side `_notify`, targeted at the property's
   asset manager).
5. **Compliance** — requirements checklist per property with status + expiry.

Old `hardware_assets` table (IT module) is legacy — planned to fold into
`items`; coordinate with Visesh before touching it.

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
  app-wide.
- **UI text casing (Neil, Jul 28 — supersedes any earlier sentence-case note):
  Titles, headings, tab labels, and buttons use Title Case** ("Punch In",
  "Start Break", "Time Sheet", "Request Time Off"). Body copy, hints, empty
  states, and descriptions stay sentence case.
- Never use em dashes in user-facing copy — plain hyphens ("-"). Em dashes
  read as AI-generated (Visesh, Jul 28).
