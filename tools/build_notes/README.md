# Build Notes tools

The local half of **Build Mode**: a watcher that waits for pins sent from Nexus
and hands them to Claude Code in your terminal, and the command line Claude Code
uses to claim pins, post progress, reply, attach after screenshots and record
the PR. Standard library only - plain `python3` runs them, no virtualenv.

What Build Mode is, who can use it and the whole loop: `docs/Build-Mode.md`.
The procedure Claude Code follows: `.claude/skills/build-notes/SKILL.md`.

## Setup (once per machine)

1. In Nexus open the profile menu (top right) > **Build Mode** > **Settings** >
   **Build Tokens**, mint a token with a label ("Neil's MacBook") and copy it -
   it is shown once. Tokens expire after 30 days and can be revoked there.
2. Save it where the tools look for it:

   ```
   mkdir -p ~/.config/nexus
   printf '%s\n' 'nxbn_...' > ~/.config/nexus/build-notes.token
   chmod 600 ~/.config/nexus/build-notes.token
   ```

   `NEXUS_BUILD_TOKEN` in the environment wins over the file. Never commit a
   token; `.gitignore` already keeps `.env*` out, and the token file lives
   outside the repository.
3. Check it:

   ```
   python3 tools/build_notes/cli.py whoami
   ```

   prints your email and the token label.

The tools talk to the dev API by default (the same `VITE_API_BASE` the dev
site is built with, see `.github/workflows/ci.yml`). `NEXUS_API_BASE` or
`--api URL` points them elsewhere, for example `--api http://localhost:8000`
for a local backend.

## The watcher

```
tools/build_notes/watch.sh
```

prints `Build Mode - waiting for pins (Ctrl+C to stop)` and a dot every
long-poll (about every 25 seconds). When someone clicks **Send To Claude Code**
in Nexus the watcher prints the pins and runs

```
claude "/build-notes <id> <id> ..."
```

in the same terminal with the repository root as the working directory - the
terminal becomes the Claude Code session, which claims the pins, fixes them,
opens the PR and writes it back. When Claude exits the watcher goes back to
waiting. Network trouble is retried with backoff (2 s up to 60 s) and the
watcher keeps going; a revoked token stops it with the reason. If Claude
exits without claiming (a non-zero exit, or the same pin ids come straight
back on the next poll) the watcher waits 30 s, then 60 s, 120 s, up to 300 s
before starting Claude again, and says so; the wait resets when a different
set of pins arrives. A missing `claude` command (exit 127) stops the watcher
with the install hint instead of looping.

`watch.sh` uses `backend/.venv/bin/python` when it exists, else `python3`.
`python3 tools/build_notes/watch.py` works just as well.

Flags (all pass through `watch.sh`):

| flag | meaning |
|---|---|
| `--once` | handle one batch of pins, then exit |
| `--api URL` | API base (default `NEXUS_API_BASE`, else the dev API) |
| `--no-claude` | print the pin ids and the command instead of running Claude Code |
| `--claude-args "..."` | extra arguments for `claude`, e.g. `--claude-args "--model opus"` |
| `--timeout N` | long-poll seconds per request (default 25, max 50) |
| `--token TOKEN` | a token for this run only |
| `--repo PATH` | run Claude Code in another checkout (default: this repository) |

### VS Code task

`.vscode/` is gitignored, so add this yourself to `.vscode/tasks.json` (create
the file if you do not have one) and run it with **Terminal > Run Task... >
Nexus: Build Notes Watcher**:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Nexus: Build Notes Watcher",
      "type": "shell",
      "command": "${workspaceFolder}/tools/build_notes/watch.sh",
      "isBackground": false,
      "presentation": { "reveal": "always", "panel": "dedicated", "focus": true, "clear": true },
      "problemMatcher": []
    }
  ]
}
```

Add `"runOptions": { "runOn": "folderOpen" }` to the task to start it whenever
the workspace opens (VS Code asks once to allow automatic tasks).

## The command line

```
python3 tools/build_notes/cli.py whoami
python3 tools/build_notes/cli.py list [--status dispatched] [--route tasks] [--mine] [--json]
python3 tools/build_notes/cli.py claim <id>... [--out DIR] [--no-download]
python3 tools/build_notes/cli.py progress <id> "Reading pins"
python3 tools/build_notes/cli.py reply <id> "text" [--needs-input | --answered] [--image PATH]
python3 tools/build_notes/cli.py verify <id> [--repro-script PATH --before failing|passing|skipped --after failing|passing|skipped] [--style-json PATH] [--before-image PATH --after-image PATH]
python3 tools/build_notes/cli.py after <id> --image PATH
python3 tools/build_notes/cli.py complete <id>... --pr URL --branch NAME [--summary "..."]
python3 tools/build_notes/cli.py owners [--check] [--me EMAIL] [paths...]
python3 tools/build_notes/cli.py preview <id>... --branch NAME [--pr N] [--url http://localhost:5180] [--host NAME] [--commit SHA]
python3 tools/build_notes/repro_template.py <pin.json> [--e2e | --python] [--base http://localhost:5173] [--out PATH | --stdout]
python3 tools/build_notes/run_e2e.py <spec.mjs> --ref origin/dev|<branch> [--pin ID] [--keep]
python3 tools/build_notes/preview.py start --branch NAME --pins <id>... [--pr N] [--db PATH] [--email EMAIL] [--no-post]
python3 tools/build_notes/preview.py stop | status
```

`--api` and `--token` go before the subcommand.

- `claim` moves the pins to Building, downloads every media file (screenshot,
  page shot, contact sheet, video, pasted attachments, after shots) into
  `~/.cache/nexus-build-notes/<id>/` (`--out DIR` to change it) and prints one
  markdown brief per pin: header, author and date, the **Where** line
  (`frontend/src/<file>:<line>:<col>` from the build-time source stamp when
  the pin has one), route / sub / URL / build, viewport, comment, thread,
  target (selector, tag, text, headings, breadcrumb, components, record ids,
  HTML), the markup in words ("red rectangle around the target"), the Edit In
  Place diff, the author's last actions as a numbered trace, the element's
  React props/state as JSON, transcript, console (last 50), network (last 30,
  with request and response bodies) and the local file paths. The brief is
  also saved as `brief.md` next to the files, with the raw `pin.json`.
- `list` prints a `Where:` line under each pin that has a source stamp.
- `claim` works one pin at a time (the server is all-or-nothing per call):
  each success prints its brief, each failure one line `Not claimed: Pin
  <id> - <server detail>` (404 unknown, 409 not claimable); exit 0 when at
  least one pin was claimed, 1 when none.
- `verify` records the evidence that a fix is right (Neil: proof must come
  from something other than Claude or Neil): a repro script with its result
  on dev code (`--before`) and on the branch (`--after`, the two always
  together), a computed-style check (`--style-json`, `{"checks": [{"prop",
  "expected", "actual", "ok"}]}` with at least one check; `passed` is always
  computed from the checks), and/or before/after screenshots (the before
  picture is uploaded with kind `before`, the after picture with kind
  `after`). It reads the pin first and refuses before uploading anything
  unless the pin is Building, Needs Input or PR Open. Use `--before skipped
  --after skipped` when a repro was not possible. `reply --needs-input` /
  `--answered` do the same dry check (Building or Needs Input).
- `repro_template.py` turns a pin's action trace (`pin.json` from `claim`,
  or a bare JSON list) into a Playwright repro skeleton, written next to
  `pin.json` in `~/.cache/nexus-build-notes/<id>/` (`--out PATH` or
  `--stdout` to change that - never into the repository). The default for a
  pin with actions (and for Bug pins) is the **e2e spec**
  (`repro_pin_<n>.spec.mjs`, see Regression tests below); `--python` gives
  the standalone Python script (`repro_pin_<n>.py`) that exits 0
  (`PASSING`) or 1 (`FAILING`) and needs `pip install playwright` and
  `playwright install chromium`. An `--out` name ending in `.py` picks the
  Python form. Either way it replays the clicks, inputs, keys and
  navigations (masked inputs become `TODO`s) and leaves one `TODO`
  assertion for the pin's complaint; the pin's comment goes in as a comment
  line, never into code. The generator itself is standard library.
- `verify --repro-script` sends `repro.kind`: `e2e` when the file is a
  Playwright Test spec, else `python`. Scripts over 20 KB are refused (the
  server's cap), and a spec whose title lacks `[<pin id>]` gets a warning.
- `claim` prints `Not claimed: ...` with the server's reason for every
  skipped pin, for example `Pin #2 waits for Visesh - it is in their area`.
  A pin reopened on the preview prints `Reopened on the preview: <note>`
  and the branch and PR to rework it on, right under its header.
- `progress` is one line the author sees on the pin.
- `reply` adds a thread entry as Claude; `--needs-input` parks the pin in Needs
  Input and rings the author's bell, `--answered` closes a Question pin;
  `--image` uploads a png/jpg/webp (8 MB max) with the reply.
- `after` attaches an after screenshot (kind `after`).
- `complete` records the PR on the pins and the Build Session (`prNumber` is
  read from the URL; `--pr-number` overrides it).

Exit codes: 0 ok, 1 API or network error (message on stderr), 2 bad arguments
or missing token, 3 `owners` found files in another developer's area.

## Ready To Check

When Claude Code has opened the PR and recorded it (`complete`), it runs the
branch on the computer running the watcher so the pin's author can try the
fix before the merge:

```
python3 tools/build_notes/preview.py start --branch build/tasks-home-polish-1024 --pins <id> <id> --pr 812
```

- The branch is checked out (detached, at `origin/<branch>`) in its own
  worktree at `~/.cache/nexus-build-notes/preview/<branch-slug>`; an existing
  one is reused and hard reset. `frontend/node_modules` is a symlink to the
  main checkout's, and the backend runs on the main checkout's
  `backend/.venv` python.
- **Data:** a COPY of your local `backend/greens_nexus.db` (SQLite backup
  API, so a running dev server cannot tear it) as `backend/preview.db` in the
  worktree; `--db PATH` copies another file instead. The backend ALWAYS
  starts with `DATABASE_URL=sqlite:///./preview.db` - an inherited
  `DATABASE_URL` (the shared dev Postgres) is never used, so the branch's
  migrations never touch a shared database. No local database: a fresh, empty
  SQLite, and it says so.
- **Who you are:** `NEXUS_SKIP_AUTH=true` and `NEXUS_DEV_EMAIL` from the main
  checkout's `backend/.env` for the backend; `VITE_DEV_SKIP_AUTH=true` and
  `VITE_DEV_USER_EMAIL` (the same email) for the frontend. `--email`
  overrides it.
- Backend `uvicorn main:app` on http://localhost:8090, frontend `vite` on
  http://localhost:5180 `--strictPort` with `VITE_API_BASE=http://localhost:8090`.
  Both run detached; their pid files (`backend.pid`, `frontend.pid`), logs
  (`backend.log`, `frontend.log`) and `current.json` live in
  `~/.cache/nexus-build-notes/preview/`. `start` waits up to 90 s for
  `/health` and the vite root; a process that exits early fails the start with
  its log tail and both are stopped.
- **One preview per computer:** `start` stops the running one first. A port
  still busy after that (something else on 8090 or 5180) is refused before
  anything starts.
- Then each pin gets `POST /dev-notes/cli/preview/{id}` with
  `{url: "http://localhost:5180" + <the pathname of the pin's URL>, branch,
  prNumber, host, commit}` (`commit` = `git rev-parse HEAD` in the preview
  worktree; the server drops an Accept given on an older commit) and shows
  **Ready To Check** in Nexus with an Open Preview link and "Runs on <host> -
  open it on that computer". `--no-post` skips this; `cli.py preview <id>...
  --branch B [--pr N] [--commit SHA]` records it by hand (the commit defaults
  to `origin/<branch>`, else the local branch).
- `preview.py status` shows the branch, data, pids and whether both answer;
  `preview.py stop` kills them by pid file (only processes that still look
  like the preview's uvicorn / vite) and keeps the worktree.
- The author **Accepts** (it counts as checked: when the PR merges the pin goes
  straight to Done) or **Reopens** with a note: the pin returns to Building
  with the note last, the watcher hands it back to Claude Code marked
  "(reopened on the preview)", and Claude reworks it on the same branch and
  PR, runs `complete` again and restarts the preview. If that PR merged in
  the meantime, the server clears the pin's PR fields and says so on the
  thread; the brief then tells Claude to rework it on a new `-r2` branch
  from fresh origin/dev, in a new PR.

The preview backend's CORS list must include http://localhost:5180 (it does on
the Build Mode v2 backend). The preview frontend shares the main checkout's
`node_modules/.vite` cache with your own dev server; both are built from the
same lockfile, so that is safe.

## Ownership

Some files belong to one developer (the File Ownership table in `CLAUDE.md`;
its machine-readable copy is `backend/code_owners.py`). Build Mode routes by
it: a pin whose source stamp is in another developer's area is **held** for
them (their bell rings) and never reaches Claude Code until they release it -
`claim` skips it with `Pin #n waits for <Owner> - it is in their area`.

```
python3 tools/build_notes/cli.py owners frontend/src/views/InventoryManagement.jsx src/asset/AssetHome.jsx
python3 tools/build_notes/cli.py owners --check [--me EMAIL]
```

- `owners` prints the owner of each path (`src/...` stamps are read as
  `frontend/src/...`).
- `--check` with no paths checks everything a commit could carry: `git diff
  --name-only origin/dev...HEAD`, staged, unstaged and untracked files.
- `--me` defaults to the Build Token's email (`whoami`). When any file is
  owned by someone else, it lists them on stderr and exits **3**; the skill
  then reverts those files and asks on the pin instead of committing them.
- The map is loaded from `backend/code_owners.py` by file path (it imports
  nothing from the app, so no virtualenv is needed and no token either when
  `--me` is given). A checkout without that file asks
  `GET /dev-notes/owners` with the Build Token.

## Regression tests

A Bug pin's evidence is a Playwright spec in the repo's `e2e/` format, so an
accepted fix keeps being tested every night.

```
python3 tools/build_notes/repro_template.py ~/.cache/nexus-build-notes/<id>/pin.json      # -> repro_pin_<n>.spec.mjs
python3 tools/build_notes/run_e2e.py ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs --ref origin/dev   # FAILING
python3 tools/build_notes/run_e2e.py ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs --ref <branch>     # PASSING
python3 tools/build_notes/cli.py verify <id> --repro-script <spec> --before failing --after passing
```

- The spec is exactly the shape `e2e/sync.mjs` and `e2e/post-results.mjs`
  expect: `import { test, expect } from '@playwright/test';`, the helpers
  from `'../helpers.mjs'` (that exact path - sync rewrites it), one test
  titled `[<pin id>] Pin #<n> - <summary>` (the id maps verdicts back and
  becomes the test case id), helpers first, and a FAILING `TODO` assertion to
  replace with the pin's complaint.
- **The nightly run starts from an empty database** (fresh SQLite). A spec
  must create the data it needs itself, through the UI or `page.request`
  against `process.env.NEXUS_E2E_API || 'http://localhost:8000'` (auth is
  skipped on that backend; CI runs it on :8000).
- `run_e2e.py` builds a CI-shaped stack for the ref in a scratch worktree
  under `~/.cache/nexus-build-notes/e2e/` (like `.github/workflows/qa-e2e.yml`):
  the backend on a free port with a fresh `e2e.db`, `NEXUS_SKIP_AUTH=true`,
  `NEXUS_DEV_EMAIL` / `NEXUS_OWNER_EMAIL=ci@greensglobal.com` and
  `NEXUS_QA_MODULE=true` (primed with `/roles/me` and restarted once, as CI
  does), the frontend built with `VITE_E2E=true` and served with
  `vite preview` on a localhost port the backend's CORS list allows (5173 is
  tried last - your dev server usually holds it), the spec copied to
  `e2e/tests/generated/<pin id>.spec.mjs` and run with `npx playwright test`
  and `NEXUS_E2E_URL`. It prints `PASSING` (exit 0) or `FAILING` (exit 1);
  exit 2 means the stack could not be built (no verdict). Everything is
  stopped and the worktree removed afterwards; `--keep` leaves it. A
  `--ref origin/...` is fetched first; a local branch is used as it is.
- It needs Node. The e2e dependencies are installed into the scratch
  worktree when the main checkout has no `e2e/node_modules`, and
  `npx playwright install chromium` runs before the test (as in CI; quick
  when the browser is already there), so a missing browser is a setup error
  (exit 2), never a FAILING verdict. The first run downloads the browser.
- When the author accepts a Bug pin whose spec went failing -> passing, the
  server adds it to the Testing module's suite (id = the pin id) and the
  nightly `qa-e2e` workflow runs it from then on.

## Troubleshooting

- **"No Build Token found"** - save the token to
  `~/.config/nexus/build-notes.token` or export `NEXUS_BUILD_TOKEN`.
- **"Your Build Token was revoked or expired - mint a new one in Nexus > Build
  Mode > Settings"** - a 401. Tokens live 30 days; mint a new one and replace
  the file.
- **"Build Mode is not enabled for you"** - a 403. Your account is not a Global
  Admin and no Access Group grants the `build-mode` module. The check runs on
  every call, so a token keeps working only while its owner has access.
- **"Cannot reach https://..."** - the API is down or you are offline. The
  watcher retries on its own; the CLI exits 1.
- **The watcher prints dots but nothing arrives** - the pins must be sent
  (Send To Claude Code in the Build Mode panel, or Send Instantly on). Pins
  already Building were claimed by another terminal; `list --status building`
  shows them.
- **A pin I already worked came back** - the author answered a question on it
  (a Needs Input or Building pin whose newest thread entry is a person's
  comment). The watcher hands it over again marked "(answered)"; `claim` is
  idempotent, prints the answer right under the brief's header, and the
  pick-up note it adds takes the pin out of the wait set.
- **"The `claude` command is not on PATH"** - install Claude Code, or run
  `--no-claude` and paste the printed command into a Claude Code session.
- **A pin came back after Claude exited** - the watcher only hands over pins
  in Dispatched (or Needs Input with a fresh answer). If Claude exited without
  claiming them they return on the next poll by design.
- **Local backend** - `--api http://localhost:8000`; the token must have been
  minted on that backend's database.

## Tests

From the repository root:

```
backend/.venv/bin/python -m unittest tools/build_notes/test_build_notes.py
```

The tests start a fake `/dev-notes/cli/*` server on 127.0.0.1 and run the
watcher and every subcommand against it; nothing touches the real API.
`preview.py` and `run_e2e.py` run against a fake `System` (stack.py) that
records the git commands, processes and environments instead of starting
anything.
