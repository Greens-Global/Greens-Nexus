# Nexus Speed To-Do

Parked backlog from the 09/17/2026 performance audit. Nothing here is built yet.
Pick up in the order below; each block is roughly one branch. Re-measure with the
same method (section at the bottom) before and after so the gain is on record.

## Baseline (prod, 09/17/2026, warm cache, from Visesh's machine)

| Screen | Data complete | API calls | Payload (gzip) |
|---|---|---|---|
| Boot until shell appears | ~2.2s | 4 serial rounds | |
| Boot until dashboard filled | ~6.5s | 42 | 90 KB |
| Tasks | 4.6s | 23 | 2.7 MB (11.5 MB raw) |
| Tickets | 5.2s | 26 | 2.7 MB |
| Item Management | 1.5s | 8 | 6 KB |
| People | 1.0s | 6 | 13 KB |
| Time Clock | 1.6s | 6 | 3 KB |
| Property Asset | 1.3s | 2 | |

Network floor: Cloudflare edge 55ms, Azure westus2 through the proxy ~280ms.
Trivial endpoints land at 400-550ms, so ~200ms per call is our own overhead.

Targets: shell under 1.5s, any screen under 1s data-complete, no response over 500 KB.

---

## 1. Tasks payload (biggest user-visible win)

- [ ] `GET /tasks/delta` with `since=""` ships all 8,341 tasks with descriptions (11.5 MB raw).
      Return a slim list shape (no `description`, no activity/attachment id arrays);
      load full detail on open. `backend/routers/tasks.py:1217`, `task_to_dict` in `task_util.py`.
- [ ] Persist the TasksContext snapshot in IndexedDB keyed by `serverTime` so a revisit
      (and a reload) is a real incremental delta, not a full pull. `frontend/src/tasks/TasksContext.jsx`.
- [ ] Tickets re-fetches the same 2.7 MB on entry; make it share the persisted snapshot.
- [ ] `visible_project_ids` loads the whole Task table a second time just to derive project ids;
      project with `with_entities` or reuse the caller's rows. `backend/routers/task_util.py:202-238`.
- [ ] `GET /task-tickets` loads every ticket then filters in Python; filter in SQL. `routers/tickets.py:496-512`.

## 2. Boot waterfall

- [ ] Fold `policy/status` and `roles/me` + `groups` into the `/api/auth/me` response (or fire
      them in parallel). Today: auth/me -> policy -> role -> providers, ~500ms each.
      `frontend/src/main.jsx:119`, `components/PolicyGate.jsx:41`, `contexts/RoleContext.jsx:150`, `App.jsx:240`.
- [ ] Move `InventoryProvider` out of the app root (`App.jsx:658`); it pulls the full 1,060-item
      catalog + all checkouts for every user on every load (430k full loads on prod since May).
      Only NotificationBell / dashboard panels need `requests`; give them a lighter hook.
- [ ] Same for `RequisitionProvider` (requisitions + hardware assets on every boot).
- [ ] `keepIfSame` JSON.stringifies both full arrays every poll; compare with the server digest instead.
- [ ] `dashboards/kpis` (1.75s) and `dashboards/agenda` (2.0s) are on the boot path; index-dependent (see 4).

## 3. Bundle / chunking (no code changes, `frontend/vite.config.js:119-142`)

- [ ] Vite's `__vitePreload` helper got bucketed into `vendor-exif`, so the entry statically
      imports exifr and recharts (~520 KB) on every boot. Route the helper + React shims to a
      `vendor-runtime` chunk before the library rules.
- [ ] `vendor-react` (824 KB) holds TipTap/ProseMirror, all `@supabase/*` sub-packages, redux/immer.
      Add rules: `@tiptap|prosemirror` -> vendor-editor; `@supabase/` (not just supabase-js) -> vendor-supabase;
      `@reduxjs|react-redux|immer|es-toolkit` -> vendor-charts; rename catch-all to vendor-misc.
- [ ] Add a post-build assertion that the entry's static imports contain no vendor-charts/exif/pdf/heic.
- [ ] `index.html`: `defer` on `guard.js`; self-host or trim the 3-family/12-weight Google Fonts request.
- [ ] Drop `react-router-dom` and move `@tanstack/react-query-devtools` to devDependencies (both unused in prod).

## 4. Backend floor (small branch, no UI risk)

- [ ] **Indexes missing on prod** (model declares them; `create_all` never adds indexes to existing tables).
      Add `CREATE INDEX IF NOT EXISTS` lines to the Postgres migration list in `backend/main.py` (pattern at ~338-344):
      - `tasks`: position, assignee_email, owner_email, company_id, project_id, team_id, parent_task_id, deleted_at, deleted_with
      - `nexus_employees (lower(work_email))`, plus status, company
      - `audit_logs (timestamp DESC)`, `(user_email)`, `(resource_type, timestamp DESC)`
      - `nexus_group_members (email)`, `approval_history (requisition_id)`
      - `time_punches (employee_email, at DESC)`, `time_bod (employee_email, kind, local_date)`
      - `property_activity_logs (property_id)`
      Pre-apply on dev, then prod, at release (see memory: two migration lists).
- [ ] **Migrations re-run on every worker respawn**: ~345 ALTERs per worker boot, 8 workers,
      `--max-requests 1000`. 387k DDL calls / 187 DB-minutes since May, each taking a brief exclusive lock.
      Gate `_run_migrations` behind a schema-version row or advisory lock so it runs once per deploy.
      `backend/main.py:1826-1835`. Consider `--preload` (Startup Command lives in the App Service portal, not `startup.sh`).
- [ ] Cache the `server_sessions` cookie -> email lookup (short TTL). Today 3-4 uncached round trips per
      request: `main.py:2106`, `audit.py:266`, `auth.py:219`, `audit.py:444`.
- [ ] `AuditMiddleware` does sync DB writes on the event loop (`audit.py:371-459`); move to `asyncio.to_thread`.
      Same for the 7 `httpx.post` uploads in `routers/hr.py` (571, 802, 878, 1405, 2058) and `routers/myhr.py` (118, 661),
      and `pytesseract` in `routers/task_config.py:1502`. Same class as the Aug 2 freeze.
- [ ] `pool_recycle=300` -> ~1800 (`backend/database.py:74`); `statement_timeout` 25s is above gunicorn's per-request budget expectations.

## 5. Polled endpoints with N+1

- [ ] `/timeclock/status`: ~13 queries every 25s on every screen. Cache policy / exempt / PayrollRate parts
      in `cache.py`; index `nexus_group_members(email)`. `routers/timeclock.py:440-506`.
- [ ] `/timeclock/locations`: 2 ordered TimePunch queries per employee, polled every 30s. `timeclock.py:3782-3800`.
- [ ] `/timeclock/track/live` (20s) and `/timeclock/monitoring/alerts` (60s): per-row queries. `timeclock.py:3744, 1799`.
- [ ] `/requisitions`: one ApprovalHistory query per requisition, polled every 30s. `routers/requisitions.py:147-160`.
- [ ] `/groups`: one member query per group on every page load. `routers/groups.py:139`.
- [ ] `dashboards/insights` cache TTL (20s) is shorter than the BI poll (30s); set TTL >= 60s. `cache.py:110`, `BiInsights.jsx:761`.
- [ ] Raw `setInterval` polls that ignore hidden tabs: `TimeTrackingAdmin.jsx:119,393,404` (5s!), `BiInsights.jsx:761`,
      `HR.jsx:495`, `ManageView.jsx:533`. Wrap in `pollWhileVisible`.
- [ ] `TimeclockWidget.jsx:104`: 1s re-render tick runs on every screen even when not clocked in; gate on `clockedIn && expanded`.

## 6. Caching layers

- [ ] `api.js:283-286`: every non-GET clears `_getCache` and invalidates ALL queries. Scope invalidation to affected keys.
- [ ] Only 13 of ~570 endpoints use `cachedGet`; only 10 hooks in `lib/queries.js`. Move reference data
      (directory, entities, work-sites, branding, item types) to TanStack hooks with real staleTime.
- [ ] Server: add `ETag` handling that does not buffer 4 MB bodies (`middleware_hardening.py:66-98`), or drop it
      in favor of `Cache-Control: private, max-age` on reference endpoints.
- [ ] Cloudflare `functions/api/[[path]].js` is a bare pass-through; consider edge caching keyed on identity
      for the reference endpoints above.
- [ ] Three Supabase realtime channels on boot, two subscribed to the same `notification_events` INSERT.
      Merge into one channel with fan-out. Postgres-changes WAL polling was 67% of all prod DB time;
      moving these pings to Broadcast removes it.

## 7. Images

- [ ] No Supabase image transforms anywhere; avatars render full-res originals into 28-44px boxes.
      One helper around `getPublicUrl` that appends width/quality; add `loading="lazy"` to avatars and photo grids.
      Sites: `Assignments.jsx:83`, `construction/lib/upload.js:209`, `InventoryContext.jsx:327`, `RequisitionContext.jsx:320`,
      `investor/lib/upload.js:34`, `lib/docBuilderUpload.js:14`, `tasks/lib.js:603`, `TicketsView.jsx:1368`, `InventoryManagement.jsx:309`.
- [ ] Downscale phone photos client-side before upload (`construction/lib/upload.js`, `lib/docBuilderUpload.js`).

## 8. Render work (lower priority)

- [ ] `InventoryManagement.jsx` renders the whole catalog with no pagination/virtualization.
- [ ] `SOP.jsx` (0 useMemo, 185 maps), `HR.jsx` (`Object.fromEntries(employees.map)` every render at 3019/3106).
- [ ] Every top-level navigation remounts the view and cold-refetches; only Tasks has a warm path.

## 9. Housekeeping

- [ ] Drop `*_bak_aug15` tables on prod (no PK, flagged by advisors) once Asana exit is closed out.
- [ ] Review the 90 "unused index" advisor findings after the new indexes have been live a month.

---

## How to re-measure

1. Open prod in Chrome, log in, load the dashboard, then in the console:
   `performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/')).map(r=>[r.name.split('/api/')[1].split('?')[0], Math.round(r.startTime), Math.round(r.duration), Math.round(r.encodedBodySize/1024)])`
2. For a screen: `performance.clearResourceTimings()`, then
   `window.dispatchEvent(new CustomEvent('nexus:navigate',{detail:{view:'tasks'}}))`, wait ~7s, read the same list.
   Data-complete = max(startTime + duration).
3. Network floor: time five `fetch('/api/health',{cache:'no-store'})` calls.
4. Prod DB: `select calls, mean_exec_time, rows, left(query,120) from pg_stat_statements order by total_exec_time desc limit 25`
   and `select relname, seq_scan, idx_scan from pg_stat_user_tables order by seq_scan desc limit 15`.
5. Bundle: `cd frontend && npm run build` and read the chunk table; check the entry's static imports in `dist/index.html`.
