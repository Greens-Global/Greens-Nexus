# Field Offline

Neil, 11/03/2026: **full offline for field work, now** (this replaces the
11/02/2026 "offline is deferred" note). A crew member with no signal can open
Nexus, see what the phone kept for them, do their work, and have every change
sent - once, in order - when the signal comes back. Nothing is ever silently
overwritten.

The pieces, all generic so every field screen adopts the same way:

| Piece | File | Job |
|---|---|---|
| App shell | `frontend/public/sw.js` + `frontend/scripts/offline-manifest.mjs` | Opens the app with no signal |
| Read cache + blobs | `frontend/src/lib/offline/store.js` (`idb.js`, `identity.js`) | What the phone keeps, per person |
| Outbox | `frontend/src/lib/offline/outbox.js` (+ `kinds.js`) | Every field change, sent later |
| Status + hook | `frontend/src/lib/offline/status.js`, `useOffline.js` | Signal, waiting count, signed out |
| UI | `frontend/src/components/offline/` | The bar, Saved on This Phone, Keep Mine / Use Theirs |
| Server | `backend/idempotency.py` | A resend of a write that landed gets the first answer |

The proof adoption is **Fill a Form** (`frontend/src/forms/formsOffline.js`).

## 1. The app shell (service worker)

`public/sw.js` does Web Push (unchanged) and keeps the app shell. The build
writes its file list into the worker (`offline-manifest.mjs`: the entry and
everything it imports statically, plus every chunk holding a file listed in
`OFFLINE_SCREENS`, with their CSS; and `OFFLINE_STATIC` - `guard.js`, the
manifest, the icons). Install saves them in `nexus-shell-<build id>`.

Routing:

- **Pages (navigations): network first.** Online it is always the server's
  copy (index.html is `no-cache`), never a stale one. The saved copy answers
  only when the network does not. With nothing saved: a plain "You Are
  Offline" page, never blank.
- **`/assets/*`: cache first.** Hashed and immutable. A hashed file fetched
  online is saved too, so any screen used online opens offline later.
- **The API: never.** It is another origin (Azure) or `/api/*` (the BFF proxy);
  both pass straight through, as do `/version.json`, `/auth-popup`, the
  Outlook add-in, the PDF engine and `/careers`. What the field reads offline
  is kept by the app (section 2), per person, never by the worker.

Updates: a deploy changes `sw.js` (the file list), which is how phones notice
(`/sw.js` is `no-cache` in `_headers`, registered with `updateViaCache:
'none'`). The new worker saves its files, then takes over (`skipWaiting` +
`clients.claim`). That is safe for an open tab: pages stay network first and
the previous build's cache is kept one generation, so a tab still on the old
build can open its old chunks. Nothing reloads a page; the existing "new
version" bar (`lib/useBuildVersion.js`) asks the person. `guard.js` and
`ViewErrorBoundary` never reload while offline (a reload cannot fetch a
missing chunk); they say "You Are Offline" and retry when the signal is back.

Size: about 78 files / 4.7 MB per deploy (most of it is first paint, already
in the browser's HTTP cache). Every file in `OFFLINE_SCREENS` is downloaded by
every phone after every deploy - add field screens only.

Opening offline also needs a person: MSAL keeps its account in localStorage;
in BFF mode (the hosted app) `bffBootstrap` remembers the last signed-in
email and name (`nexus:offline-me`, nothing that signs anyone in) and opens
the shell with it when there is no signal. The session cookie stays the only
proof of identity for every request. `RoleContext` reads `/roles/me` and the
groups through `offlineRead`, so the app opens at the person's own access.

## 2. The read cache and blobs (`store.js`)

```js
import { readThrough } from '../lib/offline/store';

const jobs = await readThrough('construction:my-jobs', () => api.getMyJobs(), {
  onCache: (savedAt) => setSavedNote(savedAt),   // the answer came from the phone
});
```

- Online: asks the server through `api.js` (its GET retries are the ONLY
  retry layer - do not add another) and saves the answer in the background.
- No signal, or a request that got no answer: the saved copy.
- A refusal (403, 404) is never covered up by the cache.
- Offline with nothing saved: an `OfflineError` (`code: 'not-cached'`,
  `isNetworkError: true`), which reads like any network error to a screen.
- Names are `'<module>:<thing>'` (`forms:mine`, `forms:template:<id>`,
  `construction:my-jobs`, `tasks:today`). Pre-save what a person will need
  (`prefetchForms` saves every form's fill screen when the list loads).

**Privacy.** Every saved dataset is stamped with the person (`identity.js`:
the signed-in account plus the Act As session). A read for anyone else finds
nothing. The whole read cache is cleared on sign out (MSAL `LOGOUT_START`),
when a different person signs in (checked at boot), and on every Act As start
or stop (`api.js` fires `nexus:identity-change`). Copies older than 30 days
are not shown.

**Blobs.** Photos and files taken offline: `putBlob(file, { ref })` keeps the
bytes (as ArrayBuffers - old iOS Safari lost Blob values in IndexedDB); the
answer carries `nexus-offline:<id>` until it uploads; `HeldImage` shows it
from the phone (`blob:` URLs, allowed by the CSP). Caps: 100 MB for one file,
200 MB together (`MAX_ONE_BLOB_BYTES`, `MAX_BLOB_BYTES`); past them the person
is told to send what is waiting first. Drafts' blobs nobody came back to go
after 14 days.

## 3. The outbox (`outbox.js`)

ONE outbox for every field change. It is `lib/punchQueue.js` /
`lib/bodQueue.js` made general, and keeps their rules:

1. **An id made on the phone** when the change is saved - sent with every try
   as the idempotency key (the `Idempotency-Key` header, or the route's own
   key such as a form's `entryKey`).
2. **Saved before it is sent**: `enqueue` writes the entry and its blobs to
   IndexedDB first, so a sign-in redirect or a closed tab cannot lose it.
3. **Retry with backoff while the outcome is unknown** (no answer, 5xx, 408,
   429): 2 s, 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, then **parked**.
4. **Replay** on load, on `online`, when the tab is visible again, after
   sign-in, and on Sync Now. With no signal nothing is tried; entries show
   Waiting to Send.
5. **401 is not an answer**: the entry parks, the bar says "Signed out - sign
   in when you have signal to send", and it replays after sign-in. `api.js`
   never redirects to Microsoft while offline.
6. **409 is a conflict**: the entry keeps the server's value (`server`, from
   the error body) and the person chooses **Keep Mine** (the kind's `rebase`
   builds the resend) or **Use Theirs** (the change is dropped; the kind's
   `useTheirs` may refresh the screen). Never a silent overwrite.
7. **Any other 4xx is an answer**: Not Sent, with the server's message;
   Retry or Discard (held - `HoldButton`).
8. **Order**: entries of one `group` (default: the kind) go in the order
   they were made; `after: [id]` waits for other entries and `ctx.result(id)`
   hands their answer on (a log first, then the photos on it).
9. One flush at a time, one tab at a time (Web Locks where the browser has
   them; otherwise the idempotency key makes a double send harmless).
10. Caps: 300 entries, the blob caps above.
11. Only the signed-in person's entries are listed or sent. An unsent change
    is NOT cleared on sign out - it is the person's work; it stays on the
    phone under their name and sends when they sign in again.

Entry shape: `{ id, kind, group, payload, blobs, after, label, owner,
createdAt, seq, attempts, nextAt, state, error, server, result, progress,
sentAt }`; `state` is `pending | sending | parked | conflict | failed | sent`
(Sent stays on the list a day).

`bodQueue` and `punchQueue` were NOT moved onto the outbox: they carry
time-critical rules of their own (the 15-minute `clicked_at` window, the
offline backfill, the BOD-before-punch order) and are fully tested where they
are. The outbox follows the same rules; moving them is a separate, tested
change.

## 4. How a new field screen adopts it

Example: the construction daily log (`kind: 'construction:log'`).

**a. Read through the phone.**

```js
const logs = await readThrough(`construction:logs:${projectId}`, () => api.getConstructionLogs(projectId));
```

**b. Register a kind** in the module that owns the screen, and add ONE line
to `src/lib/offline/kinds.js` so a change saved yesterday can send before the
screen is opened today:

```js
// src/construction/constructionOffline.js
import { registerKind, enqueue } from '../lib/offline/outbox';
import { api } from '../api';

registerKind('construction:log', {
  send: (entry, ctx) => api.updateConstructionLog(entry.payload.logId, entry.payload.patch, { headers: ctx.headers }),
  rebase: (payload, server) => ({ ...payload, rev: server?.rev }),     // Keep Mine
  describe: (entry) => ({ title: 'Daily Log', detail: entry.payload.logDate }),
});

registerKind('construction:media', {
  async send(entry, ctx) {
    const url = await ctx.uploadOnce(entry.blobs[0], (file) => uploadToConstructionMedia(file));
    const logId = entry.payload.logId || ctx.result(entry.after[0])?.id;
    return api.createConstructionMedia(logId, { ...entry.payload.meta, url }, { headers: ctx.headers });
  },
});

export const saveLogEdit = (logId, patch) =>
  enqueue({ kind: 'construction:log', group: `construction:log:${logId}`, payload: { logId, patch } });
```

```js
// src/lib/offline/kinds.js
'construction:log': () => import('../../construction/constructionOffline'),
'construction:media': () => import('../../construction/constructionOffline'),
```

`api.js` methods the outbox calls take an options argument whose `headers`
go on the request (add one to the method when it has none); the
idempotency key travels as `Idempotency-Key`.

**c. Show the state** beside the thing: `<SyncState id={entry.id} />`
(Waiting to Send / Sending / Sent / Needs Your Choice / Not Sent). The
shell's offline bar and its Review sheet already list everything waiting.

**d. Add the screen's source file** to `OFFLINE_SCREENS` in
`scripts/offline-manifest.mjs` so its chunk is on the phone after a deploy.

**e. On the server**, the route takes the key (section 5).

## 5. Idempotency on the server (`backend/idempotency.py`)

Choice: **one generic table** (`nexus_idempotency_keys`, unique on person +
key) rather than a client id column per route. Most field writes (a photo on
a log, an edit to a log) have no natural key, and a per-route column would
mean a migration and a unique index on every table the outbox touches. A
route that already has its own key keeps it: Forms entries dedupe on
`entryKey` (`routers/forms.py`), so the outbox sends the entryKey there and
Forms does not read the header.

```python
from idempotency import Idem, idempotency

@router.post("/logs/{log_id}/media", status_code=201)
def register_media(..., db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    ...                                     # make the row
    db.flush()
    idem.remember(db, user, media_to_dict(m), 201)   # in the route's own transaction
    lost = idem.commit(db, user)            # a racing try that won: its answer
    if lost is not None:
        return lost
```

- No header: the route exactly as before.
- Only 2xx answers are stored; a refusal is judged again on a retry.
- A key reused for a different request (another route or body) is a 422; a
  malformed key is a 400.
- Two tries racing: the unique index makes the loser roll back and return
  the winner's answer.
- The replay carries `Idempotent-Replay: true`.
- Kept 7 days; `purge_expired` runs in `reminders_loop`, in a thread.
- Applied now to: construction daily log create (`POST
  /construction/projects/{id}/logs`), edit (`PATCH /construction/logs/{id}` -
  an old edit resent after a newer one answers as it did then and never
  overwrites the newer one) and photo register (`POST
  /construction/logs/{id}/media`).
- Rate limiting is unchanged: a resend counts like any request.

**Release (RLS):** `create_all` makes `nexus_idempotency_keys` at startup and
the Postgres migration list runs `ALTER TABLE nexus_idempotency_keys ENABLE
ROW LEVEL SECURITY` (the boot-time `_enable_rls_everywhere` sweep catches it
too). Confirm on BOTH dev and prod after the release:

```sql
select relname, relrowsecurity from pg_class where relname = 'nexus_idempotency_keys';
```

and run `get_advisors` (security) on both.

## 6. Forms (the proof)

- The Workday tile and the shift card read the list through the phone
  (`loadMyForms`); once a list loads online, every form's fill screen is
  saved (`prefetchForms`, at most 30, refreshed after 6 hours).
- The fill screen opens from the phone with no signal and says "Opened from
  this phone (saved 11/03/2026, 2:14 PM)".
- A photo or signature taken with no signal (or whose upload got no answer)
  is held on the phone.
- Send with no signal, with a held photo in the answers, or after a send that
  got no answer: the entry goes to the outbox (its id IS the entryKey) and the
  screen says **Saved on This Phone**, then follows it to Sent. The outbox
  uploads the photos to `task-files/forms/<entryKey>/` once each and sends the
  same `POST /forms/{id}/entries`; the server answers a resend with the first
  entry. A refusal online is shown as before and nothing is queued.
- Still one engine, one entry store.

## 7. Testing offline

Unit (`npx vitest run`): `src/lib/offline/*.test.js` (store, outbox,
manifest - on `fake-indexeddb`), `src/components/offline/offline.test.jsx`,
`src/forms/FillForm.offline.test.jsx`, `src/lib/sw.test.js` (routing, shell,
install, activate). Backend: `python -m pytest test_idempotency.py` (alone).

By hand, on a production build (the worker does nothing in `npm run dev`):

```
cd frontend
# frontend/.env.local (gitignored): VITE_API_BASE=http://localhost:8022,
# VITE_PWA_DEV=1 (registers the worker on localhost) and VITE_E2E=true (skips
# the Microsoft sign-in gate; the backend's NEXUS_SKIP_AUTH says who you are)
npx vite build
npx vite preview --port 5174
cd ../backend && .venv/bin/uvicorn main:app --port 8022
```

In Chrome: open the app online once (DevTools > Application > Service
Workers shows `/sw.js` activated, Cache Storage shows `nexus-shell-<build>`),
then DevTools > Network > Offline (or Playwright `context.setOffline(true)`):
reload - the app opens; Workday > Fill a Form opens; take a photo, Send -
Saved on This Phone; go back online - it sends once (one entry in
Documents > Forms; the photo under `forms/<entryKey>/`). IndexedDB >
`nexus-offline` shows `cache`, `blobs`, `outbox`. The dev login bypass
(`VITE_DEV_SKIP_AUTH`) is stripped from a production build, hence
`VITE_E2E`. Delete the `.env.local` afterwards - it must never reach a real build.
