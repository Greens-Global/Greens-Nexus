# Supabase Egress Audit - Nexus dev (2026-08-13)

Overnight audit of egress bleed across all modules, per Visesh. Three parallel
sweeps: backend storage serving, frontend polling/images, DB columns + retention.
Goal: find bleeds, apply the safe non-breaking ones on dev, migrate vetted fixes
to prod tomorrow. **Nothing here touches prod. No workflow/access-gate changed.**

## Where the data actually is (dev)
- **DB total ~90 MB** - modest. Biggest: `task_activity` 27 MB (39k rows),
  `asana_activity_links` 13 MB (29k rows), `tasks` 9.8 MB.
- **Storage:** `task-files` **4.2 GB**, `time-monitoring` 135 MB (screenshots),
  `item-photos` 128 MB, `agent-dist` 214 MB (agent bundles), `avatars` 11 MB.

## Good news (already egress-correct - no action)
- **No Supabase storage byte-proxying anywhere.** Every bucket path returns a
  cached public URL or a browser-direct signed URL - the 4.2 GB `task-files` is
  NOT re-proxied. (`/egnyte/file` and `/egnyte-documents/file` proxy bytes but
  from Egnyte, not Supabase.)
- Uploads set `cache-control: max-age=31536000` (immutable); avatars share one
  cached `/myhr/directory` fetch app-wide; Tasks uses incremental `?since=` delta.

---

## Findings (ranked) + status

### FIXED tonight on dev (safe, UX-neutral, build-verified)

**[HIGH] Inventory polled the full catalog + all checkouts every 10s, never
pausing on a hidden tab.** `frontend/src/contexts/InventoryContext.jsx:123`.
The realtime `inventory_events` subscription already refetches on real changes,
so the wheel is a fallback. Raised 10s -> 30s (error-backoff to 60s preserved)
and skip the network when `document.visibilityState !== 'visible'`. Biggest
*continuous* API-egress cut; no UX change (realtime keeps it fresh; visible tab
refreshes on next tick). **Applied.**

**[MEDIUM] Screenshot gallery re-signed every frame's URL on each list call,**
busting the browser cache and re-downloading the private `time-monitoring`
frames each time a manager opened/filtered a day. `timeclock.py:_signed_urls`.
Added a 50-min per-worker TTL cache of signed URLs (signed for 60 min, so a
cached one is always valid; bucket stays private/signed). Re-opens now hit the
browser cache. **Applied.**

### READY TO APPLY (low risk, your files - apply together tomorrow)

**[HIGH] `list_tickets` dumps the whole `task_tickets` table incl. inline base64
`images`.** `tickets.py:322` (`.all()`) + `:127` (`"images": t.images`). Every
IT-queue load ships every ticket's inline screenshots. Fix: drop `images` from
the LIST serializer (keep it in the single-ticket GET); ideally stop storing
`data:` URLs on write - push to storage like `task_attachments` does. **Verify
the ticket-queue UI doesn't render images from the list before removing.**

**[HIGH] `GET /tasks` / `/tasks/delta?since=""` ship all ~2,400 tasks with full
HTML `description` every session mount.** `tasks.py:637` + `:811`,
`task_to_dict:46`. Fix: omit `description` + large JSON from the list/delta
serializer, load lazily on task-open (`GET /tasks/{id}` exists). **Verify board
cards / client-side search don't read `description` from the cached list first
(they render title/status/assignee) - highest payoff but needs this check.**

**[LOW-MED] `search_everything` full-table scans per keystroke**, and queries
`TaskProject` twice. `tasks.py:678-686`. Fix: dedupe the double query; push the
term filter into SQL with `.limit()` and `.with_entities(...)` to avoid pulling
`description`.

**[MEDIUM] `live_view_sessions` SDP (`offer_sdp`/`answer_sdp`) re-shipped every
25s poll and kept forever.** `timeclock.py` live poll endpoints. Low absolute
volume (my code). Fix: stop returning SDP once state is `connected`; add to
retention below.

### RETENTION GAPS (structural - decide keep-days, then add one sweep module)

Only `time_screenshots` + `agent_activity` are swept (`screenshot_retention.py`,
`NEXUS_SHOT_RETENTION_DAYS`). Unbounded, growing:
- `task_activity` (39k/27MB), `task_events`, `task_email_log`, `ticket_email_log`
  - pure logs; safe to sweep. Add sweeps mirroring `screenshot_retention.py`
  (sync-worker-gated, per-table advisory lock, bulk delete on the `at`/`created_at`
  ISO string column, `to_thread`), each with its own `*_RETENTION_DAYS` env
  (`<=0` disables), **shipped disabled** until you set the days.
- `asana_activity_links` (29k/13MB) - **do NOT blindly sweep**: deleting inbound
  Asana activity links may interact with the sync engine's re-adopt logic. Review
  against the Asana sync contract first.
- `audit_logs`, `hr_sign_events` - likely legal/compliance retention. Get an
  explicit decision before any sweep.
- `nexus_notifications`, `task_notifications`, `live_view_sessions` - medium;
  sweep old rows once keep-days decided.

### NEEDS COORDINATION (other developer's file - do not edit directly)

**[HIGH] KB `list_documents` ships full `body` + `content_text` +
`revision_history` for every doc on each list load.** `knowledge_base.py:291` +
`_serialize:178/182/191`. Owner: **Neil**. Fix: light list serializer (titles/
status/metadata only) + `load_only(...)`; load heavy fields on single-doc GET.
Flag to Neil.

### IMAGE THUMBNAILS (bigger change - not a same-day one-liner)

- Screenshot grid + item photos render full-resolution originals into small tiles
  (no thumbnail variant exists anywhere). `ScreenshotsAdmin.jsx:93`,
  `InventoryManagement.jsx:3170/3208/3737`. Fix: Supabase image-transform (or a
  capture-time thumbnail) for grids/lists; keep full-res in the lightbox only.
  Mirrors the immutable-cache pattern. Meaningful first-load egress cut but touches
  UX - do deliberately.
- base64 task attachments (4.2 GB class): lower the inline threshold so small
  attachments also go to storage + URL. Owner decision.

---

## Suggested order for tomorrow's prod migration
1. The 2 already-applied fixes (validate on dev first).
2. `list_tickets` images-drop + `GET /tasks` description-drop (after the consumer
   checks) - biggest DB-egress wins.
3. Add the retention module (shipped disabled; enable per-table with env once
   keep-days agreed; skip asana/audit/e-sign pending review).
4. Coordinate KB list serializer with Neil.
5. Schedule the thumbnail work separately.

At prod release, remember the standing checklist: RLS on any new tables
(`live_view_sessions`, KB `kb_services`/`kb_tags`, External Links), and
`get_advisors`.
