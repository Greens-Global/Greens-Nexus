# Build Mode (Oct 24 2026)

Build Mode is a developer tool inside Nexus. A Global Admin (or anyone whose
Access Group grants the `build-mode` module) turns it on from the profile menu
(top right), pins comments and markup onto any element of the live app, edits
text and styles in place, records screen and voice, and sends the collected
pins to Claude Code running in their own VS Code terminal. Claude Code fixes
them, opens a PR, writes progress and the PR back onto the pins; when the PR
merges to dev the pin turns into "Fixed - Verify" and the author accepts or
reopens it where the bug was.

GitHub Issues as a dispatch target is a LATER setting: the field is reserved
(`dispatchTarget`), the server refuses `github` with 400 for now.

Naming in copy: the feature is "Build Mode"; one captured item is a "Pin"; a
group collected together is a "Build Session". Identifiers: `dev_notes`,
`/dev-notes`, module id `build-mode`.

Everything user-facing follows CLAUDE.md: Title Case titles / buttons / status
labels, sentence-case body copy, American English, MM/DD/YYYY and 12-hour
times (`frontend/src/lib/datetime.js` on the frontend, `task_due.us_date` on
the backend), plain hyphens never em dashes.

Pieces:

- backend `routers/dev_notes.py` (this document's sections 1, 2, 4), models
  `DevNote`, `DevNoteSession`, `DevNoteToken` at the end of `models.py`;
- frontend `frontend/src/devnotes/` (section 6);
- the watcher, the CLI and the `/build-notes` skill under `tools/build_notes/`
  and `.claude/skills/build-notes/` (section 5).

---------------------------------------------------------------------------
## 1. Access

`backend/routers/dev_notes.py` gate, used by every endpoint:

    allowed = auth.is_global_admin(user, db) or _module_level(email, "build-mode", db) >= viewer

Implemented as the dependency `require_build_mode`, which returns the user or
raises 403 "Build Mode is not enabled for you". Administrators do NOT get it
by role alone (the bypass is Global Admin group membership or the grant - the
same idea as `act_as.py`'s `act-as` grant). The frontend adds
`{ id: 'build-mode', label: 'Build Mode' }` to the MODULES catalog in
`frontend/src/contexts/RoleContext.jsx` so Access Groups can grant it. The UI
shows the menu item only when `GET /dev-notes/enabled` returns
`enabled: true` - the server is the one source of truth; the frontend never
decides access itself.

CLI access: a Build Token (section 5). The dependency
`require_build_mode_or_token` accepts a normal signed-in user OR
`Authorization: Bearer nxbn_...`; a token resolves to its owner's email and
the SAME access check runs on every call (a person removed from the group
loses the token's power immediately). An unknown, expired or revoked token is
401; a valid token whose owner lost access is 403.

---------------------------------------------------------------------------
## 2. Data model (`backend/models.py`, at the end)

### `dev_notes` (model `DevNote`) - one Pin

| column | type | notes |
|---|---|---|
| id | String pk | uuid4 str |
| session_id | String default '' | FK-ish to dev_note_sessions.id ('' = no session yet) |
| number | Integer default 0 | pin number shown on screen, per session (1, 2, 3...) |
| kind | String default 'bug' | bug \| change \| question \| edit |
| priority | String default 'normal' | blocking \| normal \| nice |
| status | String default 'open' | see state machine |
| comment | Text default '' | the author's comment (markdown-ish plain text) |
| thread | JSON default list | [{id, by, at, kind: 'comment'\|'claude'\|'progress'\|'system', text, image_url}] |
| route | String default '' | activeView (e.g. 'tasks') |
| sub | String default '' | activeSub (e.g. 'home') |
| url | String default '' | window.location.href at capture |
| build_id | String default '' | import.meta.env.VITE_BUILD_ID of the capturing tab |
| viewport | JSON default dict | {w, h, dpr, ua, phone: bool, theme: 'light'\|'dark'} |
| target | JSON default dict | section 3 |
| markup | JSON default dict | section 3 |
| edit | JSON default dict | section 3 (Edit In Place diff) |
| screenshot_url | String default '' | cropped element shot WITH markup burned in (PNG) |
| page_shot_url | String default '' | full viewport shot WITH markup (PNG) |
| video_url | String default '' | webm |
| contact_sheet_url | String default '' | PNG grid of keyframes from the recording |
| transcript | Text default '' | speech-to-text of the recording / voice note |
| attachments | JSON default list | [url] pasted images and "after" shots |
| console_log | JSON default list | [{level, text, at}] ring buffer since mode on (max 50) |
| network_log | JSON default list | [{method, path, status, ms, at}] (max 30) |
| dispatch_target | String default 'local' | local \| github (github refused with 400 for now) |
| dispatched_at | String default '' | iso |
| progress | String default '' | latest one-line progress from Claude Code |
| progress_at | String default '' | |
| branch | String default '' | |
| pr_url | String default '' | |
| pr_number | Integer default 0 | |
| github_issue | Integer default 0 | reserved |
| fixed_build_id | String default '' | merge commit sha of the PR that fixed it |
| fixed_at | String default '' | |
| verified_by | String default '' | |
| verified_at | String default '' | |
| reopen_count | Integer default 0 | |
| created_by | String default '' | email, lower |
| created_at | String default '' | iso UTC |
| updated_at | String default '' | iso UTC |
| actions | JSON default list | the last 30 user actions before the pin: [{t, type: click\|input\|nav\|key\|scroll, label, selector, value (masked by the client), view, sub}] |
| state | JSON default dict | the target's React props/state snapshot (size-capped by the client) |
| verification | JSON default dict | written by the CLI (`POST /cli/verify/{id}`): {repro: {script, before, after}, styleCheck: {passed, checks: [{prop, expected, actual, ok}]}, visual: {beforeUrl, afterUrl}, at} |
| purge_at | String default '' | set when the pin reaches done or dismissed (now + 30 days); media is purged after it |

`target` may also carry `source: {file, line, col}` (passed through). A
`network_log` entry may carry `requestBody` and `responseBody` strings
(masked by the client); the server caps every string inside an entry at
2 KB. `console_log` keeps the last 50 entries, `network_log` the last 30,
`actions` the last 30.

Screens Build Mode never captures: `BLOCKED_ROUTES = ("pfs", "credvault")`
in the router. `GET /enabled` returns them as `blockedRoutes` so the client
refuses to capture there, and `POST /` answers 400 "Build Mode is off on
this screen" for a pin whose `route` is one of them.

### `dev_note_sessions` (model `DevNoteSession`) - one Build Session

| column | type | notes |
|---|---|---|
| id | String pk | |
| title | String default '' | e.g. "Tasks Home polish 10/24" (auto "Build Session MM/DD/YYYY h:mm AM" when blank; the time is UTC - rename it from the Sessions tab) |
| status | String default 'collecting' | collecting \| sent \| building \| pr_open \| fixed \| done |
| created_by | String default '' | |
| created_at, updated_at, dispatched_at | String default '' | |
| branch, pr_url | String default '' | |
| pr_number | Integer default 0 | |
| note_count | Integer default 0 | maintained on write |

A user has at most ONE `collecting` session at a time; new pins join it
(created on first pin; on Postgres the creation takes a per-author advisory
lock, and a duplicate that slips through is folded into the oldest). Dispatch
moves it to `sent`. Pins created after that start a new collecting session.
A session that was never dispatched (`dispatchedAt` '') stays `collecting`
whatever its pins do - dismissing its only pin does not close it.

Size caps on input (413 naming the field): each JSON object field (`state`,
`target`, `markup`, `edit`, `viewport`, `verification`) 64 KB serialized;
`comment` and `transcript` 20 KB.

### `dev_note_tokens` (model `DevNoteToken`)

| column | type | notes |
|---|---|---|
| id | String pk | |
| email | String | owner |
| label | String default '' | e.g. "Neil's MacBook" |
| token_hash | String | sha256 hex of the full token; the token itself is never stored |
| created_at, expires_at, last_used_at, revoked_at | String default '' | |

Token format: `nxbn_` + 43 urlsafe chars (`secrets.token_urlsafe(32)`),
expires 30 days after minting, shown ONCE in the mint response.
`last_used_at` is rewritten at most once a minute (the watcher polls every
~25 s).

### Per-user settings
Stored as a `NexusSetting` row, key `dev_notes:<email>`, value JSON:
`{"sendInstantly": false, "dispatchTarget": "local", "pinsOnLoad": true}`.

New tables: `create_all` creates them; `_enable_rls_everywhere` in `main.py`
turns RLS on at startup. Still: the release runs `get_advisors` on dev and
prod. No ALTER lines are needed for brand-new tables; a column added after
the first release goes in BOTH migration lists in `main.py`.

### Status state machine (Pin)

    open ──(dispatch)──> dispatched ──(cli claim)──> building
    building ──(cli reply --needs-input)──> needs_input ──(author replies)──> building
    building ──(cli complete)──> pr_open ──(GitHub PR merged to dev; webhook)──> fixed
    fixed ──(author accepts)──> done
    fixed ──(author reopens)──> open   (reopen_count+1; dispatched at once if sendInstantly)
    any (not done) ──(author)──> dismissed ──(author)──> open
    question: building ──(cli reply with --answered)──> done (no PR)

An illegal transition is a 409 whose detail names the pin and its status.

Session status follows its pins: sent when dispatched; building when any pin
is building or waiting on an answer; pr_open when complete is called; fixed on
merge; done when every pin is done or dismissed.

---------------------------------------------------------------------------
## 3. JSON shapes the frontend writes (and the CLI brief prints)

### target
```json
{
  "selector": "main > div.tasks-home > section:nth-of-type(2) > button.secondary-btn",
  "tag": "button", "id": "", "classes": ["secondary-btn"],
  "attrs": {"data-tour": "...", "aria-label": "...", "role": "...", "name": "...", "type": "..."},
  "text": "Mark All Read",              // visible text, trimmed, max 300 chars
  "rect": {"x": 812, "y": 240, "w": 120, "h": 32, "pageX": 812, "pageY": 1040},
  "mode": "element" | "region",          // region = dragged rectangle, selector = deepest common ancestor
  "headings": ["Tasks", "Home", "Updates"],   // nearest h1..h4 / section titles up the tree, top-down
  "breadcrumb": "Tasks > Home",
  "html": "<button class=...>...</button>",   // outerHTML of the target, max 4000 chars, scripts stripped
  "components": ["TasksHome", "UpdatesCard", "UpdateRow"],  // React fiber chain, nearest last; [] when minified away
  "record": {"ids": ["t_8f21"], "keys": ["data-task-id"], "queryKeys": [["tasks","home"]]}  // what data the element shows, best effort
}
```

### markup
```json
{
  "base": "page",                       // coordinates are viewport CSS px at capture; also saved relative to target.rect in "rel"
  "items": [
    {"type": "rect",      "x": 800, "y": 230, "w": 140, "h": 50, "color": "#ef4444", "width": 3},
    {"type": "arrow",     "x1": 700, "y1": 300, "x2": 810, "y2": 250, "color": "#ef4444", "width": 3},
    {"type": "path",      "points": [[x, y], ...], "color": "#3b82f6", "width": 3},
    {"type": "highlight", "x": 0, "y": 0, "w": 0, "h": 0, "color": "#facc15"},
    {"type": "text",      "x": 0, "y": 0, "text": "move this up", "color": "#111827", "size": 16},
    {"type": "redact",    "x": 0, "y": 0, "w": 0, "h": 0}   // blurred in BOTH screenshots before upload, never stored as pixels
  ],
  "rel": {"ox": 812, "oy": 240}         // target.rect origin at capture - lets pins re-render after layout shifts
}
```

### edit (Edit In Place)
```json
{
  "text":   {"before": "Mark all read", "after": "Mark All Read"},
  "styles": [{"prop": "padding", "before": "8px 12px", "after": "12px 16px"},
             {"prop": "color", "before": "rgb(107,114,128)", "after": "rgb(17,24,39)"}],
  "note":   "auto-generated sentence: Change the text from 'Mark all read' to 'Mark All Read'; padding 8px 12px -> 12px 16px."
}
```

### thread entry
```json
{"id": "uuid", "by": "neil@greensglobal.com" | "claude", "at": "iso", "kind": "comment"|"claude"|"progress"|"system", "text": "...", "imageUrl": ""}
```
(stored as `image_url`, serialized camelCase like everything else; the API
accepts `imageUrl` or `image_url` on input.)

### Files
Browser uploads go straight to Supabase Storage, bucket `qa-evidence` (already
PRIVATE and in both PROTECTED_BUCKETS lists), path
`dev-notes/<noteId>/<kind>-<timestamp>.<ext>` with `kind` in
screenshot | page | video | sheet | paste | before | after. The note stores the
canonical `.../object/public/qa-evidence/...` URL (api.js rewrites to the
viewer automatically). The server accepts ONLY URLs inside that bucket and
prefix (`_valid_media_url`), everything else -> 400. The CLI gets short-lived
signed URLs from the server (section 4) - never a public URL.

---------------------------------------------------------------------------
## 4. HTTP API (`prefix="/dev-notes"`, tags=["Build Mode"])

All responses are camelCase (`_serialize(note)`); requests may send camelCase
or snake_case for the note fields (both accepted, stored snake). The
collection lives at `/dev-notes` (no trailing slash, like every other router
and `api.js`); `/dev-notes/` answers with a 307 to it.

### Signed-in user (require_build_mode)
| method | path | body / query | returns |
|---|---|---|---|
| GET | /enabled | | `{enabled: bool, settings: {...}, blockedRoutes: [...]}` - returns `{enabled: false}` for anyone else, NEVER 403 (the menu asks this for everyone) |
| GET | /settings | | settings JSON |
| PUT | /settings | `{sendInstantly?, dispatchTarget?, pinsOnLoad?}` | settings; `dispatchTarget: "github"` -> 400 "GitHub dispatch is not available yet" |
| POST | / | note fields (kind, priority, comment, route, sub, url, buildId, viewport, target, markup, edit, screenshotUrl, pageShotUrl, videoUrl, contactSheetUrl, transcript, attachments, consoleLog, networkLog, actions, state) | 201 note. Joins/creates the author's collecting session, assigns `number`. If settings.sendInstantly -> status `dispatched`, session `sent`, dispatchedAt set. 400 on a blocked route. |
| GET | / | `?status=&sessionId=&route=&mine=1&limit=` (default newest 500, excludes dismissed unless `status=dismissed`) | `[note]` - also accepts a Build Token (the CLI's `list`) |
| GET | /pins | `?route=&sub=` | pins to draw on that screen: every note for the route whose status is not done/dismissed (fixed included), from EVERY author (the team sees each other's pins) |
| GET | /{id} | | note - also accepts a Build Token |
| GET | /stats | | `{pins: {total, open, building, prOpen, fixed, done, dismissed}, medianPinToPrHours, reopenRate, firstClaimHitRate, days: 90}` over the last 90 days. `open` includes dispatched, `building` includes needs_input; medianPinToPrHours = pin created -> its "PR #n Open" entry; reopenRate = share of pins that reached fixed and were reopened; firstClaimHitRate is a cheap proxy: share of completed pins whose first progress line after the claim started with "Found " (the skill posts "Found <file>" when it locates the code) and that were never reopened. `null` where there is nothing to divide by. |
| POST | /purge | | Global Admin only: runs `purge_media(db)` (below), returns `{purged: n}` |
| PATCH | /{id} | `{comment?, kind?, priority?, markup?, edit?, status?}` where status may be only `dismissed` or `open` (reopen from dismissed) | note. Author or Global Admin only. |
| POST | /{id}/thread | `{text, imageUrl?}` | note. Adds a `comment` entry by the user; if status was `needs_input` -> `building` (Claude is waiting on this). |
| POST | /{id}/verify | `{accepted: bool, comment?}` | note. Only from `fixed` (else 409): accepted -> `done` (verifiedBy/At); else -> `open`, reopenCount+1, thread system entry "Reopened", dispatched at once if sendInstantly. |
| POST | /dispatch | `{noteIds?: [], sessionId?: string, title?: string}` (neither = the caller's collecting session) | `{session, notes}`. Marks pins `dispatched`, session `sent`. Pins must be `open` (else 409); nothing to send -> 400. |
| GET | /sessions | `?status=&mine=1&limit=` | `[session]` newest first |
| PATCH | /sessions/{id} | `{title}` | session |
| POST | /tokens | `{label}` | 201 `{id, token, label, expiresAt}` - token shown once |
| GET | /tokens | | `[{id, email, label, createdAt, expiresAt, lastUsedAt, revokedAt}]` (own tokens; Global Admin sees all) |
| DELETE | /tokens/{id} | | 204 (sets revokedAt) |

### CLI (require_build_mode_or_token) - under `/dev-notes/cli`
| method | path | body / query | returns |
|---|---|---|---|
| GET | /cli/wait | `?timeout=25` (0..50) | `{notes: [note], sessions: [session]}` for every pin in `dispatched`, plus pins in `needs_input` or `building` whose thread's last entry is a human comment (Claude was waiting and the author answered). Returns at once when non-empty, else polls the DB every 2 s in a thread up to `timeout`, then returns empty lists. `async def`; never a sync sleep on the loop. |
| POST | /cli/claim | `{noteIds: []}` | `{notes: [note + media], sessions: [session], skipped: [{id, number, status, reason}]}` where `media = {screenshot, pageShot, video, contactSheet, attachments: [], beforeShots: [], afterShots: []}` are absolute SIGNED URLs valid 1 h (`routers/files.py`'s `_sign`; fetched with no auth header; '' when storage cannot sign) and `sessions` are the claimed pins' Build Sessions (id, title, status, ...). Per pin: eligible pins (dispatched, needs_input, building) go to `building`, the rest are listed in `skipped` with a reason; 404 only when NO id exists, 409 only when NONE is eligible. Session -> building. The first pick-up (from dispatched) sets `progress` to "Picked up by Claude Code"; a re-claim keeps Claude's last progress line. Every claim makes sure a "Picked up by Claude Code" `progress` entry is the last thread entry, which is what takes an answered pin out of `/cli/wait`. |
| POST | /cli/verify/{id} | `{repro?: {script, before: failing\|passing\|skipped, after: failing\|passing\|skipped}, styleCheck?: {passed: bool, checks: [{prop, expected, actual, ok}]}, visual?: {beforeUrl, afterUrl}}` | note. Merges into `verification` (plus `at`), appends a `system` entry summarizing it ("Repro: failing -> passing. Style check passed 3/3. Before and after shots attached."). Visual URLs must be qa-evidence dev-notes URLs (use `/cli/attach` first). Empty body -> 400. |
| POST | /cli/progress/{id} | `{text}` | note. Sets `progress`, `progressAt`, appends a `progress` thread entry. One line. |
| POST | /cli/reply/{id} | `{text, needsInput?: bool, answered?: bool, imageUrl?}` | note. Appends a `claude` entry; `needsInput` -> status `needs_input` and a bell to the author; `answered` (questions) -> `done`. |
| POST | /cli/attach/{id} | multipart `file` (+ form `kind` = after \| before \| paste), <= 8 MB, png/jpg/webp | `{url}` - the server uploads to `qa-evidence/dev-notes/<id>/<kind>-<ts>.<ext>` with the service key and appends the url to `attachments`; kind after also adds a `claude` thread entry "After:" with the image; kind before adds no entry (it is the verify shot, listed under `beforeShots`). |
| POST | /cli/complete | `{noteIds: [], prUrl, prNumber, branch, summary?}` | `{notes, session, sessions, skipped: [{id, number, status, reason}]}`. Per pin like claim: eligible pins (building, needs_input) -> `pr_open` with the PR fields on pins and session, thread system entry "PR #n Open", a bell to the session author; the rest are listed in `skipped`; 404 only when NO id exists, 409 only when NONE is eligible. |
| GET | /cli/whoami | | `{email, tokenLabel}` - the watcher's health check (`tokenLabel` is '' for a signed-in user) |

### GitHub webhook hook (`routers/github_webhook.py`)
On a pull request `closed` with `merged == true` into `dev`: pins with
`pr_number == number` and status `pr_open` -> `fixed`, `fixedBuildId =
merge_commit_sha`, `fixedAt`, thread system entry "Merged To Dev", a bell to
each pin's author ("Pin #n Fixed - Verify"), session `fixed`. One function,
`dev_notes.mark_fixed_for_pr(db, pr_number, merge_sha)`, called from the
webhook in a thread; it never raises.

### Bells (server-side only, `NexusNotification`)
- `dev_note_reply`: "Claude Replied On Pin #n" (needs_input), recipient = author
- `dev_note_fixed`: "Pin #n Fixed - Verify", recipient = author
- `dev_note_pr`: "PR #n Open For Build Session '<title>'", recipient = session author
One bell per pin per event, updated in place (same `ref_id`: the pin id, or
the session id for `dev_note_pr`) - never spam.

### Rate limiting (`middleware_hardening.py`)
- `/dev-notes/tokens` is in `SENSITIVE_PREFIXES` (credential-minting).
- `/dev-notes/cli/wait` is called every ~25 s by the watcher - within the
  default per-bearer budget; nothing to add. It is NOT exempt.

### Retention
A pin that reaches `done` or `dismissed` gets `purge_at` = now + 30 days
(cleared again if it is reopened). `dev_notes.purge_media(db)` deletes the
storage objects of every pin past its purge date (service key, the same
client `/cli/attach` uploads with), blanks the media URL columns, empties
`attachments` and the verification shots, and appends ONE `system` entry
"Media Purged" (never a second one on a later run). A delete storage refuses
keeps its URL and the purge date for the next run; once nothing is left the
purge date is blanked so the row is never selected again.
`purge_media_loop` runs it once a day (first run 10 minutes after startup)
on the deployed API only - the leader's job set plus `is_deployed_worker()`,
since it deletes live storage; a laptop never runs it. The work happens in a
thread (`asyncio.to_thread`), never on the event loop. A run that deleted
something writes one `dev_note_purge` audit row by "build-mode-purge"
(role "system"); a quiet day writes nothing. `POST /dev-notes/purge`
(Global Admin) still runs it on demand.

### Audit
Every create, dispatch, claim, CLI verify, accept, reopen, token mint,
token revoke and purge writes an `audit_logs` row (`resource_type`
"dev-notes", action `dev_note_create` / `dev_note_dispatch` /
`dev_note_claim` / `dev_note_verify` / `dev_note_accept` /
`dev_note_reopen` / `dev_note_token_mint` / `dev_note_token_revoke` /
`dev_note_purge`), filed under Settings & Admin (`audit_modules.py` maps
"dev-notes" there). The `AuditMiddleware` still records the HTTP calls
themselves as it does for every router.

---------------------------------------------------------------------------
## 5. Build Token + watcher + skill

- Token file: `~/.config/nexus/build-notes.token` (0600), or env
  `NEXUS_BUILD_TOKEN`. API base: env `NEXUS_API_BASE`, else the dev API
  (the frontend's production env config in the repo names it), `--api` flag
  to override (e.g. http://localhost:8000).
- `tools/build_notes/watch.py` (stdlib only): prints "Build Mode - waiting for
  pins (Ctrl+C to stop)", long-polls `GET /cli/wait`, and when pins arrive
  runs `claude "/build-notes <noteId> <noteId> ..."` in the SAME terminal with
  cwd = repo root (so this terminal becomes the Claude Code session), then
  goes back to waiting when Claude exits. Flags: `--once`, `--api URL`,
  `--no-claude` (print the ids and exit), `--claude-args "..."` passthrough.
  `tools/build_notes/watch.sh` uses `backend/.venv/bin/python` when present,
  else `python3`.
- `.vscode/` is gitignored; a developer adds this task locally
  (`.vscode/tasks.json`):

```json
{ "label": "Nexus: Build Notes Watcher", "type": "shell", "command": "tools/build_notes/watch.sh", "problemMatcher": [], "presentation": { "reveal": "always", "panel": "dedicated" } }
```

- `tools/build_notes/cli.py` (stdlib only) subcommands:
  `whoami`, `list [--status]`, `claim <ids...> [--out DIR]` (claims, downloads
  every media file to DIR default `~/.cache/nexus-build-notes/<id>/`, prints
  ONE markdown brief per pin: kind, priority, author, route/sub/url, build id,
  viewport, the comment, the thread, the target block (selector, text,
  headings, components, record ids), the markup described in words, the edit
  diff, the transcript, the console and network logs, and the local paths of
  screenshot / page shot / contact sheet / video),
  `progress <id> "text"`, `reply <id> "text" [--needs-input] [--answered] [--image PATH]`,
  `after <id> --image PATH`, `complete <ids...> --pr URL --branch NAME [--summary ...]`.
- `.claude/skills/build-notes/SKILL.md` (user-invocable, `/build-notes [ids]`):
  the procedure Claude Code follows - claim, read every screenshot with the
  Read tool, post progress at each stage, find the code (route -> view file
  via the view registry in `frontend/src/App.jsx`; grep the captured text and
  component names), one branch per Build Session named
  `build/<session-slug>-MMDD` from fresh `origin/dev`, fix pins in priority
  order (blocking, normal, nice), reply `--needs-input` and STOP on that pin
  when something is ambiguous, run `ruff check backend/`, `npm run build`,
  `npm run lint`, `npx vitest run`, a `/code-review` pass, open ONE PR whose
  body is a checklist of the pins ("Pin #n - <kind> - <summary>" with a link
  `https://<nexus>/dev-notes?pin=<id>`), call `complete`, then take an
  "after" screenshot of the same route on the local dev server with the
  playwright-cli skill when it is available and attach it with `after`.
  NEVER merge the PR (Neil merges). Never paste screenshot contents of
  people's data into the PR body.

### The loop, in words
1. Turn Build Mode on, pin what is wrong, Send To Claude Code (or Send
   Instantly). Pins are `dispatched`, the session is `sent`.
2. The watcher in your terminal sees them on `/cli/wait` and starts Claude
   Code with `/build-notes <ids>`. Claude claims them (`building`), posts
   progress, asks on the pin when it needs you (`needs_input` - you get a
   bell "Claude Replied On Pin #n"; answer in the thread and the watcher
   starts Claude again), opens one PR and completes (`pr_open` - bell "PR #n
   Open For Build Session '...'").
3. You merge the PR to dev. The GitHub webhook marks the pins `fixed`
   ("Pin #n Fixed - Verify"). Open the screen: Accept makes it `done`,
   Reopen makes it `open` again (reopen count +1, sent again at once when
   Send Instantly is on).

Status words on screen: Open, Dispatched, Building, Needs Input, PR Open,
Fixed - Verify, Done, Dismissed.

### Post To Teams, Browse and Save Report (Oct 26 2026)

- **Post To Teams** (`backend/build_mode_chat.py`, `POST /dev-notes/
  teams-post`): its own button in the Queue, independent of Send To Claude
  Code - nothing is dispatched and the pins stay open (each gets a "Posted
  To Teams - <chat>" entry). The person's OWN chats (groups and 1:1s,
  through `/timeclock/my-chats`, MSAL as the fallback); the first Post opens
  the list and picking a chat posts, the ▾ changes the chat; the pick is
  remembered in their Build Mode settings (`teamsChatId` / `teamsChatName`).
  ONE card for their open pins on every screen (or one session's, with
  `sessionId`) on the ticket Teams queue (`ticket_teams_message`, kind
  `build_mode`, `ticket_id` = session id): pins grouped by module with kind,
  comment, Where line, link, and each pin's marked-up element shot inline as
  Graph `hostedContents` (never the full-page shot; a shot that cannot be
  read is dropped, the card still goes). Posted AS THE PERSON with their
  delegated token - the scopes feature requests already use, nothing new to
  consent. No chat = 400 "Pick a Teams chat first". The pin stays the
  record; the chat only points at it. (Posting on Send To Claude Code, and
  Claude's "needs your answer" / "fixed" posts, are on hold with the
  own-Claude-Code work in PR #786 and `feat/build-mode-own-terminal`.)
- **Browse** tool (B, first on the strip): the overlay stops taking clicks
  so the person can move to another module, open a record or a tab with the
  mode still on; Pin brings the overlay back. The strip shows one plain
  sentence saying what a click does now, the hover label says `"Mark All
  Read" button` instead of a selector, and the composer's line reads "You
  picked ... in Tasks > Home" (the component and source stamp stay in its
  tooltip and on the pin).
- **Save Report** (Sessions tab, `GET /sessions/{id}/report`, author or
  admin): one self-contained HTML file - every pin grouped by module with
  kind, priority, status, comment, Where line and the marked-up shot embedded
  as base64 - that opens anywhere with no login.

### The simple strip (Oct 26 2026)

For people who are not technical (Pranshu: "make it as easy as that"):

- The strip is simple by default: **Browse** (B), **Comment** (the Pin
  tool, P), **Draw ›** (unfolds Edit, the markup tools, Undo and Color in
  place - the freehand tool is now "Pen", D), **Record** (V), **Talk** (M),
  **Done (n)** and Off. A markup tool picked by its key shows while it is
  the tool. Settings > **Show All Tools** (per browser,
  `nexus:build-mode:all-tools`, `store.setAllTools`) brings back the whole
  strip (Hide Pins, Queue) for the dev team; `SIMPLE_TOOLS` in `meta.js`.
- **Done (n)** counts YOUR open, unheld comments on every screen
  (`GET /dev-notes?status=open&mine=1`, refreshed on every save and when the
  panel closes); its tooltip says where they are ("Tasks 2 · Tickets 1");
  it opens the Queue.
- The Queue says the same by module (`bm-by-module`) and has **Save
  Report** for the session your comments collect in, next to Post To Teams
  and Send To Claude Code.
- The composer puts the words first: the comment box, Hold To Talk and
  Record; **More Options** (folded, its summary shows the current choice)
  holds Kind and Priority. Kind follows the words (`guessKind`: a question
  mark or question words = Question; "can we", "please add", "would be
  nice", "instead of"... = Change; else Bug) until the person picks one
  there (`kindSet` on the draft). An Edit pin keeps kind Edit.
- A box (Rect) finished with no comment open opens the composer on it
  (Pranshu, Oct 27): the box's area is the pick (`mode: 'region'`) and the
  box stays on the comment (`addMarkup` in `BuildModeApp.jsx`). With a
  comment already open, a box is markup on that comment, as before; the
  other drawing tools never open the composer.

---------------------------------------------------------------------------
## 6. Frontend - `frontend/src/devnotes/`

Mounted in `App.jsx` next to the other shell widgets:
`<WidgetBoundary name="build-mode" resetKey={widgetKey}><BuildMode view={activeView} sub={activeSub} /></WidgetBoundary>`
Renders nothing until `GET /dev-notes/enabled` is true (asked once per
session, cached) AND the mode is on. Profile menu (`TopHeader.jsx`): a
"Build Mode" item between Profile and What's New, only when enabled; toggles
the mode; a header chip "Build Mode" shows while on (click = off; Esc = off
when no composer is open). Hotkey: Ctrl+Shift+. (Cmd on Mac) toggles. The
mode state lives in `sessionStorage` (`nexus:build-mode`), drafts in
`localStorage` (`nexus:build-mode:drafts`) until sent.

Pieces (one file each, all under `frontend/src/devnotes/`):
- `BuildMode.jsx` root; `store.js` (tiny external store + hook);
- `Overlay.jsx` - full-viewport layer (z-index above modals), crosshair,
  hover outline, click = element, drag = region, long-press on phones;
  tools strip (floating, draggable, bottom center on desktop / top on
  phones): Pin (P), Edit (E), Rect (R), Arrow (A), Draw (D), Highlight (H),
  Text (T), Redact (X), Video (V), Voice (M), Undo (Cmd/Ctrl+Z), Color,
  Queue (Q), Done/Off (Esc);
- `Markup.jsx` - the canvas for rect/arrow/path/highlight/text/redact;
- `Pins.jsx` - renders existing pins for the current route (from `/pins`)
  anchored to their element by selector (fallback: saved rect), numbered,
  colored by status (open slate, dispatched/building blue + pulse,
  needs_input amber, pr_open violet, fixed green "Fixed - Verify", done
  faded), author initials, click opens the thread; Accept / Reopen on fixed;
  "Fix Deploying..." while `fixedBuildId` differs from the running build id
  (`useBuildVersion` / `/version.json`);
- `Composer.jsx` - the card anchored to the pick: kind pills (Bug / Change /
  Question / Edit), priority (Blocking / Normal / Nice To Have), comment
  box with Ctrl+V paste ("or press Ctrl+V to paste a screenshot" hint),
  hold-to-talk mic button (SpeechRecognition -> appends to the comment),
  Record (screen + mic through `lib/screenRecorder.js`, transcript live,
  contact sheet every 3 s), the "Looks like ..." line (components /
  headings / route), Save Pin / Save And Send (when not sendInstantly);
- `EditInPlace.jsx` - contentEditable text edit on the element + a small
  style panel (padding, margin, font size, color, background, radius,
  gap) with live preview; Save produces `edit` + the auto sentence; Cancel
  restores; the element is always restored on mode off;
- `Panel.jsx` - the side sheet (60vw, min-height 60vh, max-height 85vh,
  body scrolls, `nx-fill` on the list; phones full-screen): tabs Queue /
  Sessions / Settings. Queue: pins grouped by session with status labels
  (`components/StatusLabel.jsx` soft labels), thumbnail, video, thread,
  PR link, Dismiss / Reopen; "Send To Claude Code" (dispatches the
  collecting session; disabled with a hint when empty); Sessions: list with
  PR links and status; Settings: Send Instantly switch, Dispatch Target
  (Local Terminal; GitHub Issue shown disabled "Coming later"), Pins On Load
  switch, Build Tokens (mint with label, copy once, revoke) and the watcher
  one-liner to paste in VS Code;
- `lib/capture.js` (selector, text, headings, html, fiber components via the
  `__reactFiber$` key, record ids from `data-*` and the React Query cache
  through `window.__nexusQueryClient` if exposed - else skip);
- `lib/screenshot.js` - since Oct 26 2026 a pin's picture needs NO prompt:
  `grabAreaFrame` draws the area around the pinned element (the element
  plus `AREA_PAD` = 96px, clamped to the viewport) from a copy of the DOM
  with `modern-screenshot` (SVG foreignObject, so every CSS feature
  renders; `restoreScrollPosition` on, or a scrolled list is drawn from its
  top). Only the area is copied: the copy starts at the smallest ancestor
  holding it, leaves out everything below / right of it (`beyond`) and the
  leading rows of one-column lists that end above it (`pruneAbove`; the
  list's copy gets their height as top padding, `padCopy`), because copying
  is reading every element's computed style - the whole Tickets screen
  takes the browser 7 s, the area about 3 s. That picture gives the
  element shot (with 96px of context) and no full-page shot. The
  `getDisplayMedia` tab stream (one per mode-on, `preferCurrentTab`) is
  now opt-in - Settings > Higher Quality Screenshots, per browser
  (`nexus:build-mode:tab-capture`) - and gives both shots, as before;
  video still asks for it. Markup is burned in and redact rectangles and
  sensitive fields are blacked out BEFORE upload in both cases. No picture
  within 8 s = the pin saves without one;
- `lib/recorder.js` (screenRecorder + SpeechRecognition + contact sheet);
- `lib/buffers.js` (console ring buffer by wrapping console.error/warn and
  window 'error'/'unhandledrejection' while on; network buffer subscribed
  to the `api.js` export `onApiRequest(listener)`);
- `lib/upload.js` (qa-evidence `dev-notes/<id>/`, `cacheControl: '31536000'`);
- `lib/hotkeys.js`.
- `api.js`: `devNotesEnabled, devNotesSettings, devNotesSaveSettings,
  devNotesCreate, devNotesList, devNotesPins, devNotesGet, devNotesPatch,
  devNotesThread, devNotesVerify, devNotesDispatch, devNotesSessions,
  devNotesSessionPatch, devNotesTokens, devNotesTokenCreate,
  devNotesTokenRevoke`; v2 (section 7) adds `devNotesRelease`,
  `devNotesPreviewVerdict` and `devNotesOwnerOf`.
- Deep link: `/dev-notes?pin=<id>` (from bells and PR bodies) opens the
  app on the pin's route with Build Mode on and that pin's thread open.
  Bells of type `dev_note_*` navigate there.
- The whole module is lazy (`React.lazy`) so nothing ships on first paint
  for people without access. The Testing module's `stepRecorder.js` is NOT
  reused (it hard-navigates to /testing on stop); `screenRecorder.js` is.

---------------------------------------------------------------------------
## 7. v2 (Oct 24 2026) - ownership, Ready To Check, regression tests

Three additions on top of sections 1-6; everything above still holds.

### 7.1 New `dev_notes` columns

The table was already live, so each column is in the model AND has an
`ALTER TABLE dev_notes ADD COLUMN ...` line in BOTH of `main.py`'s migration
lists (SQLite and Postgres).

| column | type | notes |
|---|---|---|
| owner_email | String '' | set by the SERVER on create from `target.source.file` (`code_owners.owner_of`); a client value is ignored |
| owner_name | String '' | e.g. "Visesh" |
| owner_released_by | String '' | email of who released a held pin to Claude Code |
| owner_released_at | String '' | iso |
| preview | JSON dict | `{url, branch, prNumber, host, commit, startedAt}` written by the CLI, plus `verdictCommit` (the commit the verdict was given against) once there is a verdict; `{}` when none |
| preview_verdict | String '' | '' \| accepted \| reopened |
| preview_verdict_at | String '' | iso |
| regression_case_id | String '' | QaTestCase id once promoted (equals the pin id) |

Serialized camelCase (`ownerEmail, ownerName, ownerReleasedBy,
ownerReleasedAt, preview, previewVerdict, previewVerdictAt,
regressionCaseId`) plus computed fields on every note:

- `held: bool` - owner set, owner != `createdBy`, not released;
- `readyToCheck: bool` - status `pr_open`, `preview.url` set and
  `previewVerdict` != accepted;
- per caller: `canRelease: bool` - held, and the caller is the owner or a
  Global Admin; `canVerdict: bool` - `readyToCheck` or status `fixed`, and
  the caller is the author or a Global Admin. The Global Admin check runs
  once per request (`_viewer`), never once per pin; the `/cli/wait` poll
  carries no caller, so both are false there.

`GET /dev-notes/enabled` also answers `isGlobalAdmin: bool`.

### 7.2 Ownership routing

`backend/code_owners.py` is the machine-readable copy of the CLAUDE.md File
Ownership table (change both together). Stdlib only, no app imports -
`tools/build_notes/` loads it by file path. `OWNERS = [{name, email, paths}]`
(a path ending in `/` = the whole folder); `normalize(path)` turns a source
stamp (`src/...`, `./src/...`, an absolute checkout path - cut at whichever
of `/frontend/`, `/backend/`, `/src/` appears LAST - a `:line:col` suffix)
into a repo path (`frontend/src/...`), backend paths unchanged;
`owner_of(path)` -> `{name, email}` or None; `foreign_files(paths, me_email)`
-> `[{path, name, email}]` for files owned by someone else.

- Create: the owner of `target.source.file` is stored on the pin. When the
  owner is not the author the pin is **held**: a `dev_note_owner` bell to the
  owner, title "Pin #n On Your Area", body "<Author> pinned <route> (<file>).
  It waits for you - release it to Claude Code or handle it yourself." (plus
  "Ask a Global Admin for the Build Mode grant if the link does not open."
  when the owner has no Build Mode access), action `{view: dev-notes, sub:
  pin:<id>}`. A held pin is never dispatched by Send Instantly.
- `POST /dev-notes/dispatch` sends only unheld pins and answers `held: [{id,
  number, ownerName}]` for the ones it left. Held open pins left in a session
  that is now sent are MOVED to their author's collecting session (created
  when needed, titled "<title of the session they left> (Held)", at most 120
  characters and never "(Held) (Held)" - not the server's UTC auto title) as
  its next number, with the entry "Moved to Build Session '<title>' as Pin
  #m" - so the sent session can finish and they stay
  sendable; `held` carries their new numbers. 400 when nothing unheld is
  left; the detail names the held ones: "No open pins to send - Pin #2 waits
  for Visesh" (several joined with "; ").
- `PATCH /dev-notes/{id}` `{release: true}` - the owner or a Global Admin
  only (403 otherwise; the author cannot release it): sets
  `ownerReleasedBy/At`, thread system entry "Released To Claude Code by
  <name>", audit `dev_note_release`. From then on it is an ordinary pin of
  its AUTHOR's: still open in a session that is no longer collecting, it
  moves to the author's collecting session (same "Moved to Build Session"
  entry); when the AUTHOR's settings say Send Instantly it is dispatched at
  once, exactly as `create_note` sends an instant pin (the releaser's own
  setting does not matter). Releasing an already-released pin is a no-op
  (200); a pin that was never held is 409. Other fields in the same body
  still need the author.
- `/cli/claim` skips a held pin with reason "Pin #n waits for <Owner> - it
  is in their area" (409 with that detail when it is the only pin).
- `GET /dev-notes/enabled` adds `owners: [{name, email, paths}]`;
  `GET /dev-notes/owners` (Build Mode user or Build Token) returns
  `{owners: [...]}` for the CLI when it cannot load the file.
- `GET /dev-notes/owner-of?path=<stamp file>` (Build Mode user) ->
  `{owner: {name, email} | null, held: bool}` - `held` = there is an owner
  and it is not the caller. The composer asks this instead of keeping its own
  copy of `normalize()` (`api.js` `devNotesOwnerOf`).

### 7.3 Ready To Check (local preview before merge)

After `complete`, the skill runs `tools/build_notes/preview.py start` (the
PR branch's own frontend on :5174 and backend on :8090, a copy of the local
SQLite, never a shared database) and posts each pin's preview.

- `POST /dev-notes/cli/preview/{id}` (Build Token or user) `{url, branch,
  prNumber, host, commit?}` -> note. Only for `pr_open` pins (409
  otherwise). `url` must be `http://localhost:<port>/...` or
  `http://127.0.0.1:<port>/...` (parsed, so a userinfo trick like
  `http://localhost:@evil.example` is refused too) - 400 otherwise. `commit`
  (optional) is the branch head the preview runs, a git sha (7-64 hex, 400
  otherwise). Stores `preview = {url, branch, prNumber, host, commit,
  startedAt}`; the first post after a `complete` adds the system entry
  "Ready To Check - runs on <host>"; a restarted preview replaces the object
  with no second entry. When the posted commit differs from the one this pin
  stored, every Accept on that PR is reset (below); otherwise any Accept on
  the PR recorded against a different commit is reset. Audit
  `dev_note_preview`. Status stays `pr_open`; the status label on screen is
  "Ready To Check" while `readyToCheck`.
- `DELETE /dev-notes/cli/preview/{id}` (Build Token or user) -> 204, called
  by `preview.py` when it stops or replaces a running preview: `preview`
  becomes `{}` (so `readyToCheck` is false - the link would be dead); an
  accepted verdict is kept (that pin was already checked) together with its
  commit - `preview` becomes `{verdictCommit}` - so a later commit change on
  the PR still resets that Accept (still no url: never Ready To Check); a pin
  that was Ready To Check gets the system entry "Preview stopped - it comes
  back when Claude Code restarts it". Idempotent: a pin with no running
  preview (no url) gets 204 and nothing changes. 404 for an unknown pin. Audit `dev_note_preview`
  (`stopped: true`).
- `POST /dev-notes/{id}/preview-verdict` (author or Global Admin) `{accepted:
  bool, comment?}` -> note. 409 unless `readyToCheck`; 400 without
  `accepted`. The verdict records the commit it was given against
  (`preview.verdictCommit`). Audit `dev_note_preview_verdict`
  (`api.js` `devNotesPreviewVerdict`).
  - Accept: `previewVerdict` accepted, `previewVerdictAt`, `verifiedBy/At`,
    system entry "Checked On The Preview" (": <comment>" when given), then
    the regression promotion as a DRAFT (7.4). Status stays `pr_open`.
  - Reopen: comment required (400 "Say what is still wrong - a comment is
    required to reopen"); counts as a reopen like the post-merge one
    (`reopenCount` + 1, `progress` / `progressAt` cleared); `previewVerdict`
    reopened, system entry "Reopened On The Preview", then the comment as a
    human `comment` entry LAST, status -> `building` - so `/cli/wait` returns
    it and the watcher relaunches Claude Code, which re-claims, fixes on the
    SAME branch, pushes, calls `complete` again and restarts the preview.
- `POST /cli/complete` clears `preview`, `previewVerdict` and
  `previewVerdictAt` on every pin it completes (a new round), and - the
  branch changed - resets an accepted verdict on EVERY other `pr_open` pin
  of that PR number.
- Reset of an Accept (branch changed): `previewVerdict` / `previewVerdictAt`
  / `verifiedBy` / `verifiedAt` cleared and the entry "The branch changed
  after you checked it - check it again on the preview"; the pin is Ready To
  Check again.
- Merge (`mark_fixed_for_pr`): a pin whose `previewVerdict` is accepted goes
  straight to `done` (purge date set) with the entry "Merged To Dev - checked
  on the preview before merge", its draft regression case turns active
  ("Added To The Regression Suite") and NO `dev_note_fixed` bell; every other
  `pr_open` pin goes to `fixed` as before. A pin on that PR that was being
  reworked (`building` / `needs_input`) keeps its status, loses `prNumber`,
  `prUrl`, `branch`, `preview` and `previewVerdict`, gets the entry "PR #n
  merged while this pin was being reworked - the rework comes in a new PR"
  (placed before the author's comment when that comment is last, so the pin
  stays in `/cli/wait`) and a `dev_note_rework` bell to its author ("Pin #n
  Needs A New PR"). The skill then opens a new branch and PR for it.
- CORS: no new origin. The preview frontend runs on :5174, which every
  branch's `_CORS_ORIGINS` has listed since 06/18/2026 (the Knowledge Base
  workspace), so a preview of a branch cut before v2 still reaches its own
  backend on 8090. A :5180 origin added here would only exist on branches
  cut after this release (found in the live test, 10/24/2026).

State machine additions:

    pr_open ──(cli preview)──> pr_open + readyToCheck
    pr_open + readyToCheck ──(cli preview stopped: DELETE)──> pr_open (until the preview restarts)
    pr_open (readyToCheck) ──(author accepts)──> pr_open, previewVerdict accepted ──(merge)──> done
    pr_open, accepted ──(branch changed: complete on the PR / preview on a new commit)──> pr_open + readyToCheck
    pr_open (readyToCheck) ──(author reopens with a comment)──> building ──(complete)──> pr_open
    building / needs_input on PR n ──(PR n merges)──> same status, no PR (rework comes in a new PR)

### 7.4 Accepted bugs become regression tests

`POST /cli/verify/{id}` `repro` gains `kind`: `e2e` (a Playwright spec in the
repo's e2e format, titled `[<pin id>] Pin #n - ...`) or `python` (the old
form; the default when omitted; anything else is 400). The script cap is 20 KB.

On either Accept (preview Accept or the post-merge `/verify` Accept) of a
**bug** pin whose `verification.repro` has kind `e2e`, before `failing`,
after `passing` and a script containing `[<pin id>]`
(`dev_notes.promote_regression`, run AFTER the verdict is committed, so it
never raises into the request; idempotent - an active or archived case is
left alone, a draft is refreshed):

- Testing module on (`routers.qa._ENABLED`, env `NEXUS_QA_MODULE`): upsert
  `QaTestCase` with `id` = the pin id, `module` from the route
  (inventory / itemmanagement -> Item Management, property-asset -> Asset
  Management, hr -> People, myhr -> My HR, timeclock -> Time Clock,
  dashboard / bi -> Dashboards, documents / esign -> Documents (E-Sign),
  else Other), `feature` = route (+ " > " + sub), `title` = "Pin #n -
  <comment, first 80 chars>", `steps` = the pin's action labels ("Click Mark
  All Read", "Fill Search", "Open ...", "Press ...", "Scroll ..."),
  `expected` = "Fixed by PR #<pr>: <the summary given to complete>",
  `priority` blocking -> High, normal -> Medium, nice -> Low, `case_type`
  Regression, `source` build-mode, `e2e_spec` = the script, `created_by` =
  the author; sets `regressionCaseId`, audit `dev_note_regression`.
  `status`: a preview Accept comes BEFORE the merge, so the case is `draft`
  (entry "Regression test ready - it joins the suite when the PR merges")
  and `mark_fixed_for_pr` turns it `active` when the PR merges (entry "Added
  To The Regression Suite"); a closed, unmerged PR leaves it a draft. The
  post-merge `/verify` Accept writes it `active` straight away ("Added To The
  Regression Suite"). The nightly `qa-e2e` workflow runs only active cases
  (`/qa/e2e-specs`).
- Testing module off: no row; system entry "Regression test not added - the
  Testing module is off on this deployment" (once).

### 7.5 Summary of v2 API additions

| method | path | who | body -> result |
|---|---|---|---|
| GET | /enabled | signed in | adds `owners`, `isGlobalAdmin` |
| GET | /owners | Build Mode user or token | `{owners: [{name, email, paths}]}` |
| GET | /owner-of?path= | Build Mode user | `{owner: {name, email} \| null, held}` (`devNotesOwnerOf`) |
| PATCH | /{id} | owner or Global Admin | `{release: true}` -> note (`devNotesRelease`) |
| POST | /dispatch | Build Mode | response adds `held: [{id, number, ownerName}]` (numbers after any move) |
| POST | /{id}/preview-verdict | author or Global Admin | `{accepted, comment?}` -> note (`devNotesPreviewVerdict`) |
| POST | /cli/preview/{id} | token or user | `{url, branch, prNumber, host, commit?}` -> note |
| DELETE | /cli/preview/{id} | token or user | 204; preview cleared, an accepted verdict kept |
| POST | /cli/complete | token or user | as before; also clears preview + previewVerdict, resets the PR's other Accepts |
| POST | /cli/verify/{id} | token or user | `repro.kind` e2e \| python |

Every note also carries `held`, `readyToCheck`, `canRelease`, `canVerdict`.

New bells: `dev_note_owner` ("Pin #n On Your Area", recipient = the owner)
and `dev_note_rework` ("Pin #n Needs A New PR", recipient = the author),
`ref_id` = the pin. New audit actions: `dev_note_release`,
`dev_note_preview`, `dev_note_preview_verdict`, `dev_note_regression`.
