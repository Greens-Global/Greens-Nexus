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
- New columns: add to the model in `models.py` AND an
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` line in `main.py`'s migrations
  list. Model columns missing from the live DB break every SELECT with a 500.
- New tables: define the model; `create_all` creates it on startup.
- Photo URLs from clients must pass `_validate_photo_url` (Supabase storage only).

## Frontend conventions

- All server calls go through `frontend/src/api.js` — add new endpoints there.
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
- Photos are evidence: handover, receipt, return, and assignment acceptance all
  require them (lost-item reports are the exception).

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
  judging load behaviour.
- The root README describes an old static site — ignore it; this file and
  `git log --oneline` are the real documentation.
