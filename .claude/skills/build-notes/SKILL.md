---
name: build-notes
description: Work the Build Mode pins sent from Nexus - claim them, read the screenshots, open the stamped source file, fix each pin on one branch per Build Session (never committing another developer's files), run the checks, prove the fix with an e2e regression spec / style check / before-after evidence, open ONE PR to dev, record it on the pins, start the Ready To Check preview and attach an after screenshot; a pin reopened on the preview is reworked on the same branch. Use when the watcher starts a session with `/build-notes <ids>`, when the user says "build notes", "work the pins", "Build Mode pins" or "fix the pins", or pastes pin ids.
user-invocable: true
argument-hint: "[pin ids...]"
allowed-tools:
  - Bash(python3 tools/build_notes/*)
  - Bash(backend/.venv/bin/python tools/build_notes/*)
  - Bash(tools/build_notes/*)
  - Bash(python3 repro_pin_*)
  - Bash(git *)
  - Bash(gh pr create*)
  - Bash(gh pr view*)
  - Bash(ruff check *)
  - Bash(npm run *)
  - Bash(npx vitest*)
  - Bash(playwright-cli:*)
  - Bash(npx playwright:*)
---

# Build Notes

You are Claude Code working a batch of Build Mode pins. A **Pin** is one captured item (a bug, a change, a question or an in-place edit) a Nexus admin dropped on a live screen; a **Build Session** is the group they sent together. Every pin carries a screenshot of the element with the author's markup, the full page shot, the DOM target (selector, text, headings, React component chain, and on dev builds the **source stamp** - the file and line that rendered it), the author's last actions, the element's React props/state, the comment, and often a recording transcript, console and network logs with request/response bodies. Your job: fix the pins, prove each fix with evidence that is not your own word, open one PR to `dev`, write the PR back onto the pins, and never merge.

The arguments are pin ids: `/build-notes <id> <id> ...`. With no ids, work every pin in `dispatched`.

Everything here runs from the repository root. Use `python3 tools/build_notes/cli.py` (standard library only, no virtualenv needed). The token comes from `~/.config/nexus/build-notes.token` or `NEXUS_BUILD_TOKEN`; `--api http://localhost:8000` points the CLI at a local backend. If any CLI call says "Your Build Token was revoked or expired" or "Build Mode is not enabled for you", stop and tell the user what it said.

## The procedure

### 1. Claim and read

```
python3 tools/build_notes/cli.py claim <ids...>
```

With no ids first run `python3 tools/build_notes/cli.py list --status dispatched` and claim every id it prints.

`claim` moves the pins to Building, downloads every media file into `~/.cache/nexus-build-notes/<id>/` and prints one markdown brief per pin (also saved as `brief.md` in that folder, with the raw `pin.json`). Always claim first, even for a pin you have seen before: a pin comes back through the watcher (marked "(answered)") when the author replied to your `--needs-input` question, `claim` is idempotent, and the brief then shows **Author's latest answer** right under the header - read it before touching the pin again.

A pin can also come back marked "(reopened on the preview)": the author tried your fix on the Ready To Check preview (step 10) and reopened it with a note. Its brief shows **Reopened on the preview: <their note>** (while the thread ends with the "Reopened On The Preview" entry and their note) and **Rework it on the SAME branch <branch> (PR #n)** right under the header. If you asked a question after the reopen, their newer comment shows as **Author's latest answer** instead, and the branch line still says where the rework goes. That pin is reworked on its existing branch and PR - do NOT create a new branch or a new PR (step 4 says how) - then pushed, recorded with `complete` again (the server clears the old preview and verdict) and the preview restarted (step 10).

The exception: **the PR merged while the pin was being reworked.** The server then clears the pin's PR and branch and adds "PR #n merged while this pin was being reworked - the rework comes in a new PR", and the brief says **Its PR merged while it was being reworked - rework it on a NEW branch ...**. The same holds when the brief still names a PR but `gh pr view <n> --json state` says `MERGED`. Then the rework goes on a NEW branch from fresh `origin/dev` with the usual name plus `-r2` (step 4), in a NEW PR (step 8), recorded with `complete` against that new PR (step 9).

`claim` never hands you a pin that is **held** for its owner (a pin on another developer's area that they have not released to Claude Code): the server skips it and `claim` prints `Not claimed: ... Pin #n waits for <Owner> - it is in their area`. Leave it alone and mention it in the hand back. A brief line "Waits for <Owner>" means the same. Read the brief top to bottom. The line right under the header is **Where**: `frontend/src/<file>:<line>:<col>` when the pin has a source stamp - that is the authoritative location. The brief's "Files" section lists the local paths. **Open every screenshot, page shot and contact sheet with the Read tool** - you can see images, and the author's markup (rectangles, arrows, labels) is burned into them. The screenshot shows what they pointed at; the page shot shows where on the screen it sits. Read the video's contact sheet when there is one; the transcript is the author's voice note. The **Actions** trace is what the author did right before pinning (newest last); **State** is the element's React props/state at capture; each **Network** entry shows its request and response body - a 500 with its body is often the whole diagnosis. Then post progress on each pin:

```
python3 tools/build_notes/cli.py progress <id> "Reading pins"
```

### 2. Keep the author posted

Post a one-line progress note at each stage, per pin: `Reading pins`, `Found frontend/src/<file>:<line>` (or `Found <file>`), `Fixing`, `Checks passing`, `Evidence recorded`, `PR open`. The author sees it on the pin in Nexus. Keep it to one plain line: no secrets, no file contents.

### 3. Locate the code

- **Source stamp first.** When the brief's Where line names `frontend/src/<file>:<line>`, open that file at that line BEFORE anything else and post `progress <id> "Found frontend/src/<file>:<line>"` right away. The stamp is where the element was rendered; the change may belong a level up (the data, a helper, the backend), but you start there.
- **Without a stamp**, locate by the capture and post `Found <file>` once you have it:
  - **Route -> view file.** The pin's `Route` is `activeView` and `Sub` is `activeSub`. `frontend/src/App.jsx` maps a view id to its component in the `switch (activeView)` inside `ProtectedView` (around line 370) - for example `tasks` -> `views/Tasks.jsx` (wrapped in `TasksProvider`), `tickets` -> `views/Tickets.jsx`, `sop` -> `kb/KnowledgeBase.jsx`, `hr` -> `views/HR.jsx`, `myhr` and `timeclock` -> `views/TimeClock.jsx`, `property-asset` -> `views/PropertyAsset.jsx`, `shifts` -> `views/Shifts.jsx`, `support` -> `views/Support.jsx`, `dashboard` -> `views/Dashboard.jsx`, `admin-console` -> `views/AdminConsole.jsx`, `inventory` -> `views/InventoryManagement.jsx`. The address bar uses aliases from `frontend/src/lib/routes.js` (`PATH_TO_VIEW` / `VIEW_TO_PATH`: `workday` = `myhr`, `team` = `shifts`, `insights` = `bi`, `itemmanagement` = `inventory`, `construction` = `ops`, `help-center` = `support`), so a URL of `/workday/timesheet` is route `myhr`, sub `timesheet`. The view file then hands `activeSub` to its tabs; follow it down.
  - **Grep the capture.** The target's `Text` is the visible string - grep for it in `frontend/src/` (mind Title Case vs the rendered text). `Components` is the React component chain nearest-last (`TasksHome > UpdatesCard > UpdateRow`): grep each name as `function Name` / `const Name`. `Attributes` such as `data-tour`, `aria-label` and the `Record` keys (`data-task-id`) are usually literal in the JSX. `Headings` gives the section titles up the tree. Server-built text (notification titles, emails) lives in `backend/`.
- The console and network sections show what the page was doing at capture - a 500 in the network log (read its response body) or a React warning in the console often names the real cause. The State block tells you what props the component had when it misbehaved.

### 4. One branch per Build Session

```
git fetch origin dev
git checkout -B build/<session-slug>-MMDD origin/dev
```

`<session-slug>` is the Build Session title lower-cased with hyphens (`tasks-home-polish`), `MMDD` is today (`1024`). Pins from the same session share the branch; if a batch spans two sessions, two branches and two PRs. Never work on `dev` or `main` directly, and never start NEW work on a branch that already has a PR.

The one exception is a pin **reopened on the preview**: it goes back onto the branch and PR it already has (the brief names them). Check that branch out as it is on GitHub and keep committing to it:

```
git fetch origin <branch>
git checkout -B <branch> origin/<branch>
```

The PR updates itself when you push; there is no second PR. Before reworking, make sure that PR is still open (`gh pr view <n> --json state`). When it says `MERGED` - or the brief says the PR merged while the pin was being reworked - do not touch the old branch: start a new one from fresh `origin/dev` named as usual with `-r2` (`git checkout -B build/<session-slug>-MMDD-r2 origin/dev`; `-r3` if `-r2` is taken), open a new PR for it and `complete` the pin with that PR.

### 5. Fix the pins in priority order

Blocking first, then Normal, then Nice To Have. For each pin:

- Make the change the author asked for and nothing more. An **Edit** pin carries the exact diff (text before/after, style before/after) - apply that. A **Change** pin describes the result they want. A **Bug** pin describes what is wrong; find the cause, do not paper over it.
- A **Question** pin gets an answer, not code: `python3 tools/build_notes/cli.py reply <id> "<answer>" --answered`. That closes it.
- When a pin is ambiguous (two readings, a change that would break something they did not mention, data you cannot see), ask and move on: `python3 tools/build_notes/cli.py reply <id> "<one clear question>" --needs-input`. Do not guess, do not touch that pin again in this run - the author's answer brings it back through the watcher later. Continue with the next pin.
- One commit per pin, message starting with the pin: `Pin #3 - Title Case on Mark All Read (Tasks Home)`. Several pins fixed by one change may share a commit that names them all.
- **Before every commit, check ownership:**

  ```
  python3 tools/build_notes/cli.py owners --check
  ```

  It looks at everything the commit could carry (the branch's diff against `origin/dev`, staged, unstaged and untracked files) against the File Ownership map (`backend/code_owners.py`, the machine-readable copy of the table in `CLAUDE.md`; without that file it asks the server, `GET /dev-notes/owner-of`, once per path). Exit 0: commit. **Exit 3** means a change touches another developer's file - it lists them. Then, for each listed file: undo your change to it (`git checkout origin/dev -- <file>`; for a file you created, delete it), reply on the pin that needed it - `python3 tools/build_notes/cli.py reply <id> "This needs a change in <file>, which is <Owner>'s area - <what and why>" --needs-input` - leave that pin out of the commit and the PR, and continue with the other pins. Run `owners --check` again until it exits 0. Held pins never reach you, but a fix can still wander into an owned file; never commit one.
- House rules apply to every line you write (from `CLAUDE.md`): American English, dates MM/DD/YYYY through `formatDate` / `us_date`, 12-hour times, Title Case for titles, buttons, tabs and status labels, sentence case for body copy, plain hyphens never em dashes, `DateField` not a native date input, all server calls through `frontend/src/api.js`, popups 60vw.
- Post `Fixing` when you start; the screenshot is the spec.

### 6. Checks

Run what CI runs and fix what fails:

```
ruff check backend/
cd frontend && npm run build && npm run lint && npx vitest run
```

Backend tests run ONE FILE PER PROCESS: `cd backend && python -m pytest test_<area>.py` for each area you touched. Then run the `/code-review` skill on the branch and fix its findings. Post `Checks passing` on each pin.

### 7. Evidence (mandatory)

Neil's rule: the proof that a fix is right must come from something other than Claude or Neil. Every fixed pin gets evidence recorded with `verify` before the PR opens. This stage uses the `playwright-cli` skill and the local dev server (`cd frontend && npm run dev` on http://localhost:5173, with `cd backend && uvicorn main:app --reload --port 8000`; the local backend signs you in through `NEXUS_SKIP_AUTH` in `backend/.env`). "Before" means the `origin/dev` code, "after" means your branch: `git stash`-free switching is `git worktree add /tmp/nexus-dev origin/dev` with its own `npm run dev -- --port 4173`, or simply `git checkout origin/dev -- frontend/src` into a scratch copy; never leave your branch dirty. When playwright-cli or the dev server is not available, record `--before skipped --after skipped` and say why in the PR body - do not silently skip.

Evidence files live next to the pin's `pin.json` in `~/.cache/nexus-build-notes/<id>/` - the repro script, the style JSON, the before/after screenshots. Never write them into the repository (a second guard: never `git add` them). `verify` first checks the pin's status (it must be Building, Needs Input or PR Open) and refuses before uploading anything otherwise - claim the pin first.

- **Bug pins (and any pin with an action trace): a regression spec.** The repro is a Playwright Test spec in the repo's `e2e/` format, because once the author accepts the fix the server adds it to the Testing module's suite and the nightly `qa-e2e` workflow runs it from then on. Build the skeleton from the pin (written to `~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs` by default; `--e2e` is the default here, `--python` gives the old standalone script):

  ```
  python3 tools/build_notes/repro_template.py ~/.cache/nexus-build-notes/<id>/pin.json
  ```

  The spec has exactly the repo's shape: the two imports (`@playwright/test`, and the helpers from `'../helpers.mjs'` - keep that path exactly, the nightly sync rewrites it), ONE test titled `[<pin id>] Pin #<n> - <summary>` (keep the `[<pin id>]` prefix - it is how verdicts map back and it becomes the test case id), the author's actions replayed with the helpers (`openApp`, `go`, `clickByText`, `fillByLabel`, `selectByLabel`, `expectVisible`; a raw `page.locator(...)` only when no helper fits; masked inputs are `TODO`s - fill them with safe test values), and one failing `TODO` assertion. Finish it:
  - Replace `expect(false, 'TODO: ...')` with the pin's complaint as an expectation - the element's text (`toHaveText`), its visibility (`expectVisible`), a computed style (`toHaveCSS`).
  - **The nightly run starts from an EMPTY database** (a fresh SQLite, no rows). The spec must create every record it needs itself - through the UI, or `page.request` against the API (`process.env.NEXUS_E2E_API || 'http://localhost:8000'`, auth is skipped there). Never rely on data that exists on your machine.

  Run it the way CI does - a scratch worktree with a fresh SQLite backend (`NEXUS_SKIP_AUTH`, `NEXUS_QA_MODULE`) and the `VITE_E2E=true` frontend build, the spec copied into `e2e/tests/generated/` and run with `npx playwright test`; the helper builds, runs and cleans all of it (a few minutes each, mostly the frontend build):

  ```
  python3 tools/build_notes/run_e2e.py ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs --ref origin/dev    # must print FAILING
  python3 tools/build_notes/run_e2e.py ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs --ref <branch>      # must print PASSING
  ```

  `--ref <branch>` uses your local branch with its commits, pushed or not. The verdict is read from Playwright's JSON report: FAILING only when the one test ran and an expectation failed. Exit 2 is no verdict - the stack could not be built, the template's `TODO` assertion is still in the spec (it refuses to run it), or **the spec is broken, not the bug** (a syntax, import or reference error, no tests, more than one test, a timeout before any expectation). Read the message, fix the spec or the setup and run again; never record a verdict you did not get. Then:

  ```
  python3 tools/build_notes/cli.py verify <id> --repro-script ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs --before failing --after passing
  ```

  `verify` sends it as `kind: "e2e"` (a plain script goes as `"python"`) and warns when the title lacks `[<id>]`; the script must stay under 20 KB. `--before` and `--after` always travel together. A spec that PASSES before the fix means the bug was not reproduced: record it as it is (`--before passing`), say so in the PR line and on the pin (`reply <id> "The repro passes on dev before the fix - I could not reproduce it this way; here is what I changed and why"`). Do not fake a failing run - only a failing -> passing spec becomes a regression test. The spec stays in the cache folder and out of the commit (it travels on the pin, not in the repo).

- **Edit pins.** After the fix, load the route, locate the element by the source stamp / selector, and compare `getComputedStyle` for each `edit.styles[].prop` against `edit.styles[].after` and the text against `edit.text.after`:

  ```
  playwright-cli open http://localhost:5173/<route path>
  playwright-cli eval "el => ({text: el.textContent.trim(), padding: getComputedStyle(el).padding})" "<selector>"
  ```

  Write `~/.cache/nexus-build-notes/<id>/style_<n>.json` as `{"checks": [{"prop": "padding", "expected": "12px 16px", "actual": "12px 16px", "ok": true}, ...]}` - one check per style prop plus one `{"prop": "text", ...}` when the text changed; at least one check, and `passed` is computed from the checks (a bare `"passed": true` counts for nothing) - and:

  ```
  python3 tools/build_notes/cli.py verify <id> --style-json ~/.cache/nexus-build-notes/<id>/style_<n>.json
  ```

- **Change and visual pins.** Screenshot the pin's route before (dev code) and after (branch) at the pin's viewport (`playwright-cli resize <w> <h>` from the brief's Viewport line, or `open --mobile` for a phone pin):

  ```
  playwright-cli open http://localhost:4173/<route path>   # before (dev code)
  playwright-cli screenshot --filename=~/.cache/nexus-build-notes/<id>/before.png
  playwright-cli close
  playwright-cli open http://localhost:5173/<route path>   # after (branch)
  playwright-cli screenshot --filename=~/.cache/nexus-build-notes/<id>/after.png
  playwright-cli close
  python3 tools/build_notes/cli.py verify <id> --before-image ~/.cache/nexus-build-notes/<id>/before.png --after-image ~/.cache/nexus-build-notes/<id>/after.png
  ```

  The before picture is stored as a `before` shot and the after picture as an `after` shot (the one the author sees as "After:" on the pin) - pass them in that order.

A pin may take more than one kind of evidence (a Bug with a style change gets a repro and a style check). Post `Evidence recorded` on the pin. Remember the evidence words for the PR line: `repro failing -> passing`, `style check 3/3`, `before/after attached` - `verify` prints them.

### 8. Open ONE pull request to dev

Commit, push the branch (`git push -u origin <branch>`), then:

```
gh pr create --base dev --title "Build Session: <title>" --body "$(cat <<'EOF'
Build Mode pins from <author> (<session title>):

- [x] Pin #3 - Bug - Mark All Read is Title Case and 12px padding - repro failing -> passing (https://dev.nexus.greensglobal.com/dev-notes?pin=<id>)
- [x] Pin #4 - Edit - Updates card padding 12px 16px - style check 2/2 (https://dev.nexus.greensglobal.com/dev-notes?pin=<id>)
- [x] Pin #6 - Change - Updates card lists the newest first - before/after attached (https://dev.nexus.greensglobal.com/dev-notes?pin=<id>)
- [x] Pin #7 - Bug - Empty state copy - repro skipped (playwright-cli not installed on this machine) (https://dev.nexus.greensglobal.com/dev-notes?pin=<id>)
- [ ] Pin #5 - Question - answered on the pin, no code (https://dev.nexus.greensglobal.com/dev-notes?pin=<id>)

Checks: ruff, npm run build, npm run lint, vitest, /code-review.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<the session link from the conversation's attribution reminder, when one is given>
EOF
)"
```

One checklist line per pin: `- [x] Pin #n - Kind - one-line summary - <evidence> (<nexus url>/dev-notes?pin=<id>)` where `<evidence>` is `repro failing -> passing`, `style check k/n`, `before/after attached`, or `repro skipped (<why>)` / `repro passing -> passing (not reproduced)` when that is the truth; a pin left in Needs Input or answered without code is `- [ ]`. The Nexus URL is `https://dev.nexus.greensglobal.com` (the dev site; `NEXUS_URL` overrides it and the brief prints the exact link per pin). Every commit message and the PR body end with the attribution lines the conversation gave you. **Never put people's data from the screenshots, state snapshots or network bodies into the PR body** - no names, amounts, emails, record contents; describe the fix, not the data. Post `PR open` on each pin.

### 9. Record the PR on the pins

```
python3 tools/build_notes/cli.py complete <ids...> --pr <pr url> --branch <branch> --summary "<one line>"
```

Only the pins you fixed in this PR - not the ones waiting in Needs Input, not the Questions you answered. For a pin reworked after a reopen, run `complete` again with the same PR and branch once the new commits are pushed (it is allowed from Building and clears the old preview and verdict).

### 10. Ready To Check (the local preview)

Start the branch on this computer so the author can try the fix before the PR merges:

```
python3 tools/build_notes/preview.py start --branch <branch> --pins <ids...> --pr <pr number>
```

It checks the branch out in its own worktree (`~/.cache/nexus-build-notes/preview/<branch-slug>`), runs its backend on http://localhost:8090 on a COPY of the local database (never the original, never the shared dev database) and its frontend on http://localhost:5174 (the port every branch's CORS list allows), waits until both answer, and marks each pin **Ready To Check** with its own link on the preview and the commit it runs (an Accept given on an older commit no longer counts once the branch moves). Push before you start it - the preview runs `origin/<branch>`. One preview per computer: once its checks pass, starting one stops the previous one and clears Ready To Check on that preview's pins; a start that fails a check leaves the old preview running. When port 5174 is taken by something else (often the Knowledge Base standalone workspace), `start` refuses - say so in the hand back rather than freeing it yourself. Pass the pins you just recorded with `complete` - the same list, reworked ones included. Then tell the user, in these words: **"Ready To Check on http://localhost:5174 - open it on this computer"**. The author Accepts (that counts as checked - no second check after the merge) or Reopens with a note, which brings the pin back to you (step 1). If `start` fails (exit 2: a busy port, no virtualenv, a backend that crashed - the message carries its log tail), say so in the hand back; the PR is recorded either way. `preview.py status` shows what runs, `preview.py stop` ends it and clears Ready To Check on its pins (the worktree stays).

### 11. After screenshot

If `playwright-cli` is available and a pin did not already get a before/after pair in step 7, show the author the result on the branch's dev server:

```
playwright-cli open http://localhost:5173/<route path from the pin's URL>
playwright-cli screenshot --filename=~/.cache/nexus-build-notes/<id>/after.png
playwright-cli close
python3 tools/build_notes/cli.py after <id> --image ~/.cache/nexus-build-notes/<id>/after.png
```

Match the pin's viewport. Skip this step quietly when playwright-cli or the dev server is not available; the PR is already recorded.

### 12. Hand back

Tell the user: the branch, the PR link, which pins were fixed and what evidence each carries, which are **Ready To Check** on http://localhost:5174 (or why the preview did not start), which are waiting on an answer (Needs Input) and why - including any pin parked because its fix needs another developer's file - which were **held for an owner** (the `Not claimed: ... waits for <Owner>` lines), which were not reproduced, and which Questions you answered. For a reopened pin, say it was reworked on the same branch and PR - or on a new `-r2` branch and PR because the first one had merged. **Never merge the PR** - Neil merges. Do not edit `dev` or `main`, do not touch `.env` files, do not commit tokens, cache folders, repro scripts or style JSON files.

## Quick reference

```
python3 tools/build_notes/cli.py whoami
python3 tools/build_notes/cli.py list [--status dispatched|building|needs_input|pr_open] [--json]
python3 tools/build_notes/cli.py claim <id>... [--out DIR] [--no-download]
python3 tools/build_notes/cli.py progress <id> "one line"
python3 tools/build_notes/cli.py reply <id> "text" [--needs-input | --answered] [--image PATH]
python3 tools/build_notes/cli.py verify <id> [--repro-script PATH --before failing|passing|skipped --after failing|passing|skipped] [--style-json PATH] [--before-image PATH --after-image PATH]
python3 tools/build_notes/cli.py after <id> --image PATH
python3 tools/build_notes/cli.py complete <id>... --pr URL --branch NAME [--summary "..."]
python3 tools/build_notes/cli.py owners [--check] [--me EMAIL] [paths...]                         # exit 3 = another developer's file
python3 tools/build_notes/cli.py preview <id>... --branch NAME [--pr N] [--url http://localhost:5174] [--commit SHA]
python3 tools/build_notes/repro_template.py <pin.json> [--e2e | --python] [--out PATH | --stdout]   # default: ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs
python3 tools/build_notes/run_e2e.py <spec.mjs> --ref origin/dev|<branch> [--keep]                # prints FAILING or PASSING
python3 tools/build_notes/preview.py start --branch NAME --pins <id>... [--pr N] [--db PATH] [--no-post]
python3 tools/build_notes/preview.py stop | status
```

Pin statuses: Open -> Dispatched -> Building -> (Needs Input ->) PR Open (Ready To Check while the preview runs) -> Fixed - Verify -> Done. `claim` makes Building, `reply --needs-input` makes Needs Input, `complete` makes PR Open, `preview.py start` makes it Ready To Check; an Accept on the preview takes it straight to Done when the PR merges, a Reopen brings it back to Building on the same branch; otherwise the merge to dev makes Fixed - Verify (the author accepts or reopens in Nexus). A pin on another developer's area waits (held) until its owner releases it. Setup and troubleshooting for the watcher and token: `tools/build_notes/README.md`.
