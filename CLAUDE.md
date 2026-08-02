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
  (Microsoft Graph, Asana) into a thread via `await asyncio.to_thread(...)` —
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

## Asana sync — the contract (`backend/asana_sync.py`)

**One engine, three entry points.** The one-shot Import, the scheduled Pull and
the webhook all go through `_pull_task_tree`. Import used to have its own
parallel implementation and silently carried less than Pull did (no
dependencies/status/start date/milestone/followers, and no `AsanaTaskLink`
rows, so the next Pull re-adopted everything by title and duplicated what it
couldn't match). **Never add a second inbound path** — add the field to the
engine and all three get it. `_TASK_OPT_FIELDS` is the single field list.

**Everything on a task syncs, both ways**: title, description, start/due,
status, priority, done, assignee, followers, tags, section, milestone,
subtasks, dependencies, comments, attachments. Asana's system stories become
Nexus activity entries (inbound only — Nexus's own log would be noise in
Asana). Attachments push out as Asana *external* attachments (link, not bytes);
`data:` URLs are skipped because they only exist from an inbound inline of a
file Asana already has.

**Three hashes on `AsanaTaskLink`, and they are not interchangeable:**
- `last_hash` — NEXUS-side digest; outbound compares against it.
- `last_inbound_hash` — ASANA-side digest; inbound compares against it. Using
  `last_hash` for this made every pull re-apply every task forever whenever the
  Asana project lacked the Task Progress/Priority custom fields, because the
  two digests can never converge in that case.
- `last_push_hash` — the additive-only fields (tags/followers/dependencies/
  section/attachments) that Asana takes through separate actions rather than a
  task PUT. Lets the push sweep skip an untouched task at zero HTTP cost.

**Deletions are queued, not fired.** Every other outbound change can be
re-derived from the Nexus rows on the next push sweep; a deletion cannot — the
task and its link are gone, so nothing is left to notice the Asana counterpart
is orphaned. `delete_task` writes an `AsanaPendingDelete` tombstone in the SAME
transaction as the delete; `drain_pending_deletes` sends it (from the sweep on
dev/prod, from **Push all** on a laptop, where the fire-and-forget push never
runs at all). A 404 counts as done; a row that fails 5 times is dropped so the
queue can't grow forever. Never go back to firing deletes directly — that lost
them silently off the sync worker.

**Automatic on the deployed API, manual on a laptop** — `is_sync_worker()`
(`WEBSITE_SITE_NAME`, or `NEXUS_ASANA_SYNC_WORKER=true` to opt in deliberately)
gates the 2-min pull, the 10-min push sweep, and every fire-and-forget push.
Manual Pull / Push all / Import work everywhere. Without this gate every
developer's local backend would push local edits into the real workspace.

**Duplicates.** Dev duplicated where localhost never did, because gunicorn runs
8 worker *processes* there and `threading.Lock` doesn't cross processes. What
holds now: the Postgres advisory lock (`_acquire_pull_lock`) around pull and
around push's *create* path; `db.flush()` after every link insert (sessions are
`autoflush=False`, so an unflushed link is invisible to the rest of the same
transaction); a per-run `seen` set (Asana hands back the same task twice when
it is both a project member and a subtask); and the partial-unique index
`ux_asana_task_link_gid`. **That index cannot build while duplicates exist** —
on such a database the migration fails and is swallowed. Run Manage → Two-way
Sync → *Check for duplicates* → *Merge*; `dedupe_tasks` collapses them onto the
oldest row (moving comments/attachments/subtasks across) and then creates the
index itself.

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
- **UI text casing (Neil, Jul 28 — supersedes any earlier sentence-case note):
  Titles, headings, tab labels, and buttons use Title Case** ("Punch In",
  "Start Break", "Time Sheet", "Request Time Off"). Body copy, hints, empty
  states, and descriptions stay sentence case.
- Never use em dashes in user-facing copy — plain hyphens ("-"). Em dashes
  read as AI-generated (Visesh, Jul 28).
