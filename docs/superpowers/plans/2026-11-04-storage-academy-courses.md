# Greens Storage Academy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author five long-lasting foundation courses plus an in-person Hands-On Check, their Knowledge Base pages and a Training Plan, and load them into Nexus as drafts on every environment.

**Architecture:** Content lives in the repo as Markdown lessons and pages plus one JSON file per course for settings and questions (`backend/kb_seed/academy/`). A small converter (`kb_md.py`) turns the Markdown into the editor's block JSON. A loader (`kb_academy.py`) reads and validates the package; a one-time importer (`kb_academy_seed.py`, marked in `nexus_settings`) writes it through the training module's own normalizers as DRAFT pages, DRAFT courses and an INACTIVE plan. Owners review and Publish in the UI.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy (backend only), unittest or pytest, Cubby MCP (read-only aggregates) for Greens' fee and day numbers.

**Spec:** `docs/superpowers/specs/2026-11-04-storage-training-courses-design.md` (sections 4.1, 4.3 and 9 carry Neil's 11/04/2026 answers and win over anything older in the file). Research briefs: `docs/superpowers/specs/academy-research/research-*.md`.

## Global Constraints

- Course order (Neil): 1 Nexus Fundamentals, 2 Self-Storage Fundamentals, 3 RV & Boat Storage Fundamentals, 4 Cubby Fundamentals, 5 Customer Service & Sales Fundamentals, 6 Hands-On Check (`delivery: in_person`).
- No retakes: `recert_months = 0` on all six; no rule renews them. Certificate on pass.
- Texas is IN: every state-specific lesson teaches California and Texas side by side.
- Owners: the Operations Manager (resolved by job title in `nexus_employees`, else `neil@greensglobal.com`). Area Managers are reviewers; nothing in code names them.
- Department on the collection, every page and every course: `Operations`. Nexus Fundamentals' description says every new hire takes it; who takes what is decided by the plan and its rule, not by the department field.
- Everything imported is a DRAFT (pages `status="draft"`, courses `status="draft"` with content in `draft`), the plan `active=False`, no assignment rules. Drafts are visible only to author, reviewer, collection owner and Manage (`kb_access`).
- Quizzes: pass 80%, 3 tries, shuffle on; `drawCount` 25-40 from a bank of 45-80; checkpoints at most 10 questions. No `photo` questions anywhere. Numeric answers are `single` choice, never `short`.
- Course reading length (from `kb_blocks.reading_minutes`, 200 wpm, page lessons included): Nexus >= 70 min, Self-Storage >= 120, RV & Boat >= 100, Cubby >= 95, Customer Service & Sales >= 120. `est_minutes`: 120 / 210 / 180 / 180 / 210.
- Copy: American English, Title Case for titles, headings, lesson titles, buttons and chip words; sentence case for body; dates MM/DD/YYYY, never ISO; 12-hour times; never an em dash or en dash; say "Time Sheet"; tier words only as in `docs/Roles.md`.
- Every Greens number names its source ("From Greens' Cubby, 11/2026"); legal content carries the callout "Training only, not legal advice. When in doubt, stop and ask your manager."
- AI is off: nothing calls Anthropic. Content is authored now, by hand.
- No schema change. No new table. Only `backend/main.py` (append-only, one call in `_tier_seeds`) among shared files.
- Do not modify Visesh's files.

## Review Focus

1. A second boot (or a second worker) must not create a second collection, page, course or plan: importer is idempotent on the mark AND on titles.
2. A course whose page lesson points at a missing page slug must fail the content test, never import a course with the lesson silently dropped (`_norm_lessons` drops lessons whose page is not found).
3. A question whose `answer` index is out of range, or a `multi` with one answer, or an `order` with fewer than 2 items, is silently changed by `_norm_quiz` - the content test must compare authored vs normalized and fail on any difference.
4. A staff member who is not owner/reviewer/Manage must not see an imported draft page or course (asserted through `kb_access`).
5. Copy drift: an em dash, an ISO date, "timecard", "Global Admin" or a `[Greens to fill]` left in a page that Cubby data can fill must fail the content test.

---

### Task 1: Markdown to blocks converter

**Files:**
- Create: `backend/kb_md.py`
- Test: `backend/test_kb_md.py`

**Interfaces:**
- Consumes: `kb_blocks.doc, heading, paragraph, bullet_list, ordered_list, callout, table, checklist, text, sanitize`.
- Produces: `kb_md.to_blocks(md: str) -> dict` (a sanitized `doc` node) and `kb_md.word_count(md: str) -> int`.

Supported subset (nothing else; unknown syntax stays a paragraph):
`#` is reserved (lesson title comes from the file's front matter, a `#` line is an error), `##` / `###` headings (levels 2 / 3); blank-line paragraphs; `**bold**`, `*italic*` marks; `- ` bullets; `1. ` numbered; `- [ ] ` checklist; GitHub tables (`| a | b |` + separator row, first row = headers); callouts `> [!TIP]`, `> [!NOTE]`, `> [!WARNING]`, `> [!SAFETY]` followed by `> ` lines; `---` horizontal rule. Front matter between `---` lines at the top: `title`, `summary`, plus optional page keys (`page_type`, `tags`, `slug`).

- [ ] **Step 1: Write the failing tests** in `test_kb_md.py`:
  `test_headings_and_paragraphs` (`"## A\n\nHello **world**."` -> content[0] heading level 2 "A", content[1] paragraph whose text node "world" carries mark bold);
  `test_lists_and_checklist` (bullets -> `bulletList` with 2 items; `1.` -> `orderedList`; `- [ ] x` -> `checklist` with one `checkItem`);
  `test_table` (`| Size | Fits |\n|---|---|\n| 5x5 | Boxes |` -> `table`, header cells "Size","Fits", one body row);
  `test_callouts` (each of TIP/NOTE/WARNING/SAFETY -> `callout` with attrs kind tip/note/warning/safety);
  `test_front_matter` (`parse(md)` returns `({"title": "X", "summary": "Y"}, body)`);
  `test_h1_rejected` (`to_blocks("# Title")` raises `ValueError`);
  `test_output_survives_sanitize` (`kb_blocks.sanitize(to_blocks(sample)) == to_blocks(sample)`).
- [ ] **Step 2: Run** `cd backend && python -m pytest test_kb_md.py -q` - expect failures (module missing).
- [ ] **Step 3: Implement** `parse(md) -> (meta: dict, body: str)`, `to_blocks(body: str) -> dict`, `word_count(body: str) -> int` in `kb_md.py`, line-based, using the `kb_blocks` builders; marks by one regex pass (`\*\*(.+?)\*\*`, `\*(.+?)\*`). Check `kb_blocks.callout` / `table` signatures before use.
- [ ] **Step 4: Run** the tests - all pass. `ruff check backend/kb_md.py backend/test_kb_md.py` clean.
- [ ] **Step 5: Commit** spec + research + plan + converter: `git add docs/superpowers backend/kb_md.py backend/test_kb_md.py && git commit -m "Storage Academy: design, research, plan, and the Markdown to blocks converter"`.

### Task 2: Content package loader and the content test

**Files:**
- Create: `backend/kb_academy.py`
- Create: `backend/kb_seed/academy/README.md` (how to add or edit a lesson, a question, a page; 30 lines)
- Create: `backend/kb_seed/academy/plan.json`
- Test: `backend/test_kb_academy_content.py`

Layout (fixed):
```
backend/kb_seed/academy/
  plan.json                       {"name": "New Hire: Facility Team", "description": "...", "due_days": 30, "courses": ["nexus-fundamentals", ...6 slugs in Neil's order]}
  pages/<slug>.md                 front matter: title, summary, page_type (policy|how_to|reference), tags
  courses/<NN>-<slug>/course.json {"slug","title","description","overview":[...],"est_minutes","delivery","min_reading_minutes",
                                   "lessons":[{"file":"01-welcome.md"} | {"page":"<page slug>","title":"...","summary":"..."} |
                                              {"checkpoint":"Checkpoint: The Product","questions":[...]}],
                                   "quiz":{"passPct":80,"drawCount":30,"maxTries":3,"questions":[...]}}
  courses/<NN>-<slug>/lessons/<file>.md
```
Questions use the training module's own shape: `{"type": "single|multi|tf|order|short", "q", "options", "answer": [indexes], "explanation", "keywords" (short only)}`.

**Interfaces:**
- Consumes: `kb_md.parse`, `kb_md.to_blocks`, `kb_md.word_count`; `routers.kb_training._norm_quiz`.
- Produces: `kb_academy.ROOT: Path`; `kb_academy.load(root: Path = ROOT) -> Academy` where `Academy` is a dataclass with `pages: dict[slug, PageSpec]`, `courses: list[CourseSpec]` (in plan order), `plan: dict`; `PageSpec(slug, title, summary, page_type, tags, blocks)`; `CourseSpec(slug, title, description, overview, est_minutes, delivery, min_reading_minutes, lessons: list[dict], quiz: dict)` where each lesson dict is either `{"type":"text","title","summary","blocks"}`, `{"type":"page","page":slug,"title","summary"}` or `{"type":"checkpoint","title","questions"}`; `kb_academy.problems(a: Academy) -> list[str]` (empty = valid).

`problems` reports (one string each): page slug referenced but missing; `_norm_quiz({"questions": qs})["questions"]` differs from the authored list in count, `answer`, `options` or `type` (checkpoint and final quiz both); checkpoint over 10 questions; quiz bank below 45 or `drawCount` outside 25-40 or above the bank (Hands-On Check exempt: no quiz); any `photo` question; any `short` question whose keywords contain a digit; course reading minutes (sum of `reading_minutes` over text lessons + referenced pages) below `min_reading_minutes`; lesson count over 60; in any title, body, option or explanation: an em dash or en dash, an ISO date (`\b\d{4}-\d{2}-\d{2}\b`), the words "timecard", "time card", "timesheet", "Global Admin", "IT Admin"; a `[Greens to fill]` marker in a page tagged `cubby-filled`; a lesson or page title not in Title Case (every word capitalized except a, an, the, and, or, but, for, nor, of, on, in, to, at, by, as, vs, when not the first word); plan slugs not matching course slugs or not in Neil's order.

- [ ] **Step 1: Write failing tests**: `test_valid_minimal_package_has_no_problems` (a temp dir package with one page, one course with a text lesson, a page lesson, a checkpoint of 2 and a quiz bank of 45 single questions, drawCount 25) -> `problems == []`; one test per reported problem above, each mutating the minimal package and asserting the matching message appears; `test_real_package_is_valid` -> `problems(load()) == []` (skipped with a reason while `courses/` is empty, never skipped once a course exists).
- [ ] **Step 2: Run** `python -m pytest test_kb_academy_content.py -q` - fails.
- [ ] **Step 3: Implement** `kb_academy.py` (read with `Path.read_text(encoding="utf-8")`, `json.loads`), `plan.json` with the six slugs `nexus-fundamentals, self-storage-fundamentals, rv-boat-storage-fundamentals, cubby-fundamentals, customer-service-sales-fundamentals, hands-on-check`, and the README.
- [ ] **Step 4: Run** tests - pass; `ruff check` clean.
- [ ] **Step 5: Commit** `"Storage Academy: the content package and its validator"`.

### Task 3: The importer (drafts only, once)

**Files:**
- Create: `backend/kb_academy_seed.py`
- Modify: `backend/main.py` `_tier_seeds` - append one guarded call after `clear_tier_words_once` (same try/except/rollback/print shape), nothing reordered.
- Test: `backend/test_kb_academy_seed.py`

**Interfaces:**
- Consumes: `kb_academy.load`, `kb_academy.problems`; `kb_core.new_id, now, set_content, set_departments, assign_code, assign_course_code, event`; `routers.kb_training._norm_lessons(db, lessons, user=None)`, `_norm_quiz`; models `KbCollection, KbDocument, KbCourse, KbTrainingPlan, NexusEmployee, NexusSetting` (check the settings model's real name in `super_admins_seed.py`).
- Produces: `kb_academy_seed.MARK = "kb.storage_academy_seeded_2026_11"`; `apply_once(db) -> dict | None` returning `{"collection": id, "pages": n, "courses": n, "plan": id, "owner": email}` the first time, `None` once marked; `owner_email(db) -> str`.

Rules: refuse (return None and print) when `problems(load())` is non-empty. Owner = first active `NexusEmployee` whose job title equals "Operations Manager" (case-insensitive, trimmed), else `neil@greensglobal.com`. Collection "Greens Storage Academy" under the top-level collection whose `department == "Operations"` (create that top-level one only if missing). Find-or-create by title for the collection, every page and every course (a row found is left untouched). Pages: `status="draft"`, `page_type` from front matter, `require_ack = page_type == "policy"`, `collection_id`, departments `["Operations"]`, `major=0, minor=1`, `assign_code`. Courses: mirror `routers.kb_training.create_course` - draft JSON holds lessons (page lessons resolved to the created page ids, then `_norm_lessons`) and `_norm_quiz(quiz)`; `recert_months=0`, `delivery` from the spec, `departments="Operations"`, `assign_course_code`. Plan: `KbTrainingPlan(active=False, due_days=30, items=[{"kind":"course","id":...,} in plan order])`, no rules. Write the mark last, in the same commit.

- [ ] **Step 1: Write failing tests** (SQLite throwaway DB the way other backend tests bind one; read one existing KB test first and copy its setup): `test_first_run_creates_drafts` (counts match the package; every page `status=="draft"`; every course `status=="draft"` and `json.loads(c.draft)["lessons"]` length equals the spec's; `recert_months==0`; plan `active is False`); `test_second_run_is_a_no_op` (returns None, row counts unchanged); `test_existing_title_is_not_overwritten` (pre-create a course with the same title and a marker description; after `apply_once` the description is unchanged and no duplicate exists); `test_owner_falls_back_to_neil` and `test_owner_is_operations_manager`; `test_staff_cannot_see_drafts` (`kb_access.get_page` / `get_course` for a plain employee raises 404/403); `test_refuses_invalid_package` (monkeypatch `kb_academy.problems` to return ["x"] -> None, nothing written, no mark).
- [ ] **Step 2: Run** `python -m pytest test_kb_academy_seed.py -q` - fails.
- [ ] **Step 3: Implement** `kb_academy_seed.py` and the `main.py` hook.
- [ ] **Step 4: Run** the test file (one file per process, per CLAUDE.md) - passes; `ruff check backend/` clean.
- [ ] **Step 5: Commit** `"Storage Academy: one-time importer, drafts only"`.

### Task 4: Greens numbers from Cubby, and the Greens Policies pages

**Files:**
- Create: `backend/kb_seed/academy/pages/greens-fees-and-charges.md`, `greens-delinquency-timeline.md`, `greens-tenant-protection.md`, `greens-waivers-credits-refunds.md`, `greens-vehicle-storage-rules.md`, `greens-privacy-and-records.md`, `greens-site-hours-and-access.md`
- Create: `docs/superpowers/specs/academy-research/cubby-numbers.md` (the queries run and their aggregate results, dated)

Use the Cubby MCP (`get_sql_schema`, `get_sql_recipes`, `execute_sql`), READ-ONLY AGGREGATES ONLY, never a tenant name, email, phone, address or payment detail. Pull per facility and per unit type (storage vs parking vs mailbox): admin fee; the late fee rule (amounts against rent bands, and the day of month it posts, from `LATE_FEE_CHARGED` timing); every named fee and its amount (lien notice fees, vehicle lien fee, advertising, auction, lien processing, cut lock / lock removal, failed payment); the collections task ladder by day (2nd, 6th, 30th, 35th, 61st, 62nd); overlock timing (days past due when `OVERLOCK_NEEDED` fires); gate lockout timing; coverage plan names and premiums; deposit and reservation fee presence; billing (first of month, jump day 26). Each number on a page names its source ("From Greens' Cubby, 11/2026"). Every page has a California column and a Texas column (tables); Texas cells say "Set when the Texas sites join Cubby. Until then, ask your Area Manager." Tag fully Cubby-filled pages `cubby-filled`. Waiver limits and protection exclusions stay `[Greens to fill]` (owners fill them).

- [ ] **Step 1:** Run the queries; write `cubby-numbers.md`.
- [ ] **Step 2:** Write the seven pages from it and the research briefs.
- [ ] **Step 3: Run** `python -m pytest test_kb_academy_content.py -q` - passes.
- [ ] **Step 4: Commit** `"Storage Academy: Greens Policies pages from Cubby data"`.

### Tasks 5-10: The courses

One task per course; each writes `courses/<NN>-<slug>/course.json` and its lessons, plus the pages it owns, following the spec's section 5 outline for that course (lesson list, checkpoints, quiz size) with Neil's changes applied (Texas in; the order; Hands-On Check name; Customer Service cross-references point at the Hands-On Check). Each lesson opens with what the learner will be able to do, teaches with examples and tables, ends with "Key Points"; scenarios are concrete Greens situations (Escondido, Fairfield, Murrieta, Temecula, Valley Center; Texas as "a Texas site"). Every quiz question has an explanation that teaches. The writer reads the course's research brief(s) in full first and uses only facts from them or from Cubby numbers; anything marked [VERIFY]/[DATED] in a brief is either left out or carried as "as of <year>". Each task ends with the content test green and a commit.

- [ ] **Task 5: Nexus Fundamentals** (`01-nexus-fundamentals`, spec 5.1, brief `research-nexus.md`; quiz bank 50, draw 25). Verify every button label it names against the current source before writing (grep the label).
- [ ] **Task 6: Self-Storage Fundamentals** (`02-self-storage-fundamentals`, spec 5.2, brief `research-self-storage.md`; bank 70, draw 35). Lesson 10 teaches the California Act AND Texas Property Code ch. 59 side by side; the AB 1108 (2018) date, not 2016.
- [ ] **Task 7: RV & Boat Storage Fundamentals** (`03-rv-boat-storage-fundamentals`, spec 5.4, brief `research-rv-boat.md`; bank 60, draw 30). Writes the five Site Profile pages (`site-escondido`, `site-fairfield`, `site-murrieta`, `site-temecula`, `site-valley-center`) from Cubby unit mix aggregates (counts by unit type and size only), other fields `[Greens to fill]`.
- [ ] **Task 8: Cubby Fundamentals** (`04-cubby-fundamentals`, spec 5.5, brief `research-cubby.md`; bank 55, draw 30). Writes the Cubby How-To pages (one per task in spec 4.4) as `how_to` pages with steps and "Screenshot: [Greens to add]" slots; the eight ledger examples use Greens' real admin fee and first-of-month / jump day 26 billing, with the proration formula labeled "check against a real Preview Charges".
- [ ] **Task 9: Customer Service & Sales Fundamentals** (`05-customer-service-sales-fundamentals`, spec 5.3, brief `research-customer-service.md`; bank 70, draw 35). Collections lesson trains FDCPA-style conduct everywhere and names California's Rosenthal Act and Texas Finance Code ch. 392.
- [ ] **Task 10: Hands-On Check** (`06-hands-on-check`, `delivery: in_person`, one text lesson: the trainer's checklist for the mock call (the 22-item score sheet), the site walk and the supervised Cubby move-in; no quiz; `est_minutes` 90, `min_reading_minutes` 5).

### Task 11: Claude review pass, then fixes

- [ ] **Step 1:** Dispatch one fresh reviewer per course (read-only) with the course files, its brief(s) and the Global Constraints: check every fact and number against the brief or `cubby-numbers.md`, every legal statement against current statute text where reachable, every Nexus label against source, and that each question's answer is right. Each returns a list of defects with file and line.
- [ ] **Step 2:** Fix every confirmed defect; rerun `test_kb_academy_content.py`; commit `"Storage Academy: review fixes"`.

### Task 12: Ship

- [ ] **Step 1:** `ruff check backend/`; run `test_kb_md.py`, `test_kb_academy_content.py`, `test_kb_academy_seed.py`, `test_ai_switch.py` one per process; boot the backend locally against SQLite once and confirm the startup line `[startup] storage academy imported ...` and that a second boot prints nothing.
- [ ] **Step 2:** Review the branch (Neil's rule: a review pass before any PR).
- [ ] **Step 3:** Push and open ONE PR to `dev` that lists the 6 courses, page count, what owners must do before Publish (fill waiver limits and protection exclusions, add Cubby screenshots, review legal lessons, set the plan's fixed date and switch it on), and that no RLS or schema change is needed. Do not merge without Neil's OK.
