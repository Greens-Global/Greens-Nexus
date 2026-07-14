# Testing module (dev-only) — plan

Branch: `feat/testing-module` · planned 14 Jul 2026 · **v2 additions (user + research):**

- **Per-step screenshots** — every step row accepts evidence (upload OR Ctrl+V paste after a
  snip), plus ONE overall screenshot per case/issue. Research: per-step evidence at the exact
  failing step is what the best tools (Qase/Testmo runners) get right — failing marks *which*
  step broke, not just the case.
- **Assignments** — assign selected cases (or a whole module) in a run to a person with a
  **due date**. Firing an assignment sends: ① an **email** (existing Graph `sendMail` app
  permission, same as E-Sign/alerts), ② a **Teams DM** posted by the assigner via their own
  delegated Graph token (existing `teamsGraph.js` pattern — find existing 1:1 chat via
  `Chat.ReadBasic`, else create with `Chat.Create`, else skip gracefully), ③ a **bell**
  notification (`NexusNotification`, targeted). Short summary: "You've been assigned N test
  cases in run X — due D."
- **Activity log** — a Log tab: who ran what case, verdict, when; who assigned what to whom.
  Derived from `qa_results` + `qa_assignments` (no extra table).
- Research takeaways applied: pass/fail/blocked *per case* with fail-at-step capture; failed
  case auto-drafts a bug report pre-linked to the case + step + evidence; progress per module
  and per assignee; read-only visibility for everyone with the grant.

## What it is

An in-app QA module, visible **only on dev**, that turns `docs/Nexus-Module-Audit-2026-07-14.xlsx`
into a living, interactive thing:

1. **Interactive test runs** — every test case from the workbook (109 cases, 7 modules) as an
   in-app checklist: tick each step as you do it, mark Pass / Fail / Blocked, add notes and a
   screenshot. Progress bars per module and per run.
2. **Report-a-bug** — anyone types what they found in plain words. A cheap AI call converts it
   into a proper test case (title, precondition, numbered steps, expected result, priority) that
   a reviewer approves into the library.
3. **Step recording** — while reproducing a bug, the user hits “Record steps”; the app logs what
   they actually click (screen names, button labels — never typed values) and optionally records
   the screen. The recording feeds the AI conversion so the generated steps match reality.

**Feasibility: yes on all three.** Nothing here needs new infrastructure — details below.

## Why it’s cheap

- The backend already calls Claude with `ANTHROPIC_API_KEY` (item-type matching, KB, interviews).
  Bug→test-case conversion is one call per report using **`claude-haiku-4-5`** (~$0.001–0.005 per
  conversion at 1–3k tokens). Even 1,000 bug reports ≈ a few dollars.
- Screen recording uses the browser’s built-in `MediaRecorder` + `getDisplayMedia` — free; the
  webm uploads to a Supabase bucket with the existing upload helpers (cap ~60–90 s / ~25 MB).
- Click-step recording is a tiny in-page event listener — zero cost, works on mobile too
  (screen recording is desktop-only; the click log is the mobile fallback).

## Dev-only gating (recommended: env flag, not hostname)

`dev` merges into `main`, so the same code reaches prod — gating must be config, not code paths
that differ per branch.

- **Backend:** register `routers/qa.py` always, but every endpoint checks
  `NEXUS_QA_MODULE=true` (env var set **only on the Azure dev app**; absent on prod → 404).
- **Frontend:** the module asks `GET /qa/enabled` once (cheap, cached); sidebar entry renders
  only when it returns true. Prod users never see it even though the code ships.
- Belt-and-braces: also hide when `location.hostname` is the prod domain.

## Data model (new tables — `create_all`, no migration lines)

| Table | Purpose | Key columns |
|---|---|---|
| `qa_test_cases` | the library (seeded from the workbook) | id, module, feature, title, precondition, steps **JSON list**, expected, priority, type, source `seed/ai/manual`, status `active/archived`, created_by/at |
| `qa_runs` | a named testing session (“Jul 15 regression”) | id, name, created_by/at, status `open/closed` |
| `qa_results` | one row per case per run | id, run_id, case_id, result `pass/fail/blocked/skipped`, step_ticks JSON, notes, evidence JSON (screenshot/recording URLs), tested_by/at |
| `qa_bug_reports` | raw user reports | id, description, steps_log JSON (recorded clicks), recording_url, screenshots JSON, status `new/converted/dismissed`, converted_case_id, created_by/at |

**Seeding:** the audit workbook’s data already lives as structured Python in the generator
script — I’ll emit it as `backend/qa_seed.json` and seed `qa_test_cases` if empty on first read
(same pattern as `item_types`). Re-running never duplicates; the workbook stays the offline copy.

## Backend (`backend/routers/qa.py`, prefix `/qa`)

- `GET /qa/enabled` — `{enabled: bool}` from the env flag (any authed user).
- Cases: `GET /qa/cases` (+module/priority filters) · `POST /qa/cases` · `PATCH /qa/cases/{id}` ·
  archive. Seed-if-empty inside the list handler.
- Runs: `GET/POST /qa/runs` · `GET /qa/runs/{id}` (cases + results joined) ·
  `POST /qa/runs/{id}/results` (upsert one case’s result — step ticks, verdict, notes, evidence).
- Bugs: `GET/POST /qa/bug-reports` · `POST /qa/bug-reports/{id}/convert` → **one Haiku call**:
  input = description + recorded step log; output = strict-JSON test case → saved as
  `source='ai'`, `status` draft until a human approves (PATCH) · dismiss.
- Permissions: viewer = run tests + report bugs; editor+ (or admin) = approve AI cases, manage
  the library. Reuse `require_module_grant("testing", …)` — the module id joins `MODULES` so
  Roles & Access governs it like any other screen.

## Frontend (`frontend/src/views/Testing.jsx` + `frontend/src/lib/stepRecorder.js`)

Three underline tabs (house style):

1. **Run tests** — pick/create a run → module accordion with progress rings → case card:
   *Before you start*, then each step as a tappable checklist row; when all ticked, big
   Pass / Fail / Blocked buttons + notes + “attach screenshot”. **Fail** auto-opens a pre-linked
   bug report. Resume mid-run anytime (results upsert per case).
2. **Report a bug** — description box + **“Record steps”** toggle + optional **“Record screen”**
   + screenshot attach → submit. List below shows each report’s status; “Convert with AI” shows
   the drafted case side-by-side for edit-then-approve.
3. **Library** — all cases filterable by module/priority/source; edit/archive; “export CSV”.

**Step recorder (`stepRecorder.js`):** on start, a capture-phase click listener records
`{time, view (from nexus:navigate + tab labels), elementLabel (innerText/aria-label/placeholder,
truncated), elementRole}` — **input values are never captured** (only “typed into ‘Search
people…’”). Stop returns the event array. A small floating pill shows “● Recording steps — Stop”.
Screen recording: `getDisplayMedia` → `MediaRecorder` (webm, 60 s cap) → Supabase `qa-evidence`
bucket → URL on the report. Desktop-only; the pill hides the option on mobile.

## Wiring (append-only, minimal diff, house rules)

- `RoleContext.jsx` `MODULES` += `{ id: 'testing', label: 'Testing' }` (append).
- `App.jsx` / Sidebar: append route + nav item, rendered only when `/qa/enabled` is true.
- `api.js`: append ~10 `qa*` bindings.
- `models.py`: append 4 models. `main.py`: append `include_router` (env-gated inside the router).
- New tables need **RLS on dev** after first deploy (same follow-up pattern as always). Prod gets
  the tables too (create_all) but the module stays invisible there — harmless, empty.

## Build order (each step verifiable on its own)

1. Backend: 4 models + `qa.py` (enabled/cases/runs/results) + seed JSON emitted from the
   workbook data → smoke-test seed + result upsert locally.
2. Frontend: module shell + **Run tests** tab against the live endpoints → `npm run build`.
3. **Report a bug** tab + `stepRecorder.js` (click log first, screen recording second).
4. AI convert endpoint (Haiku, strict JSON + one retry) + review/approve UI.
5. Polish: progress rings, run summary header, CSV export, sentence-case pass, mobile check.
6. Verify end-to-end on local backend; then merge to dev (announce), RLS the 4 tables,
   set `NEXUS_QA_MODULE=true` on Azure dev only, create the `qa-evidence` bucket.

Estimated effort: steps 1–2 ≈ half a day, 3–4 ≈ half a day, 5–6 ≈ a couple of hours.

## Open decisions (defaults chosen, say if you want different)

1. **Access**: default = anyone with a `testing` module grant can run tests + report bugs;
   only editors/admins approve AI cases. (Alternative: open to every dev user, no grant.)
2. **Screen recording cap**: 60 s / ~25 MB webm. Longer = bigger storage bills.
3. **AI model**: `claude-haiku-4-5` for cost; can switch to Sonnet later if draft quality
   disappoints — it’s one constant.
