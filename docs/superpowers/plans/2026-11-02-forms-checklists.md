# Forms & Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Field forms (inspections, incident reports, vehicle checks, opening / closing checklists) built in Documents, filled on a phone from Workday, reviewed by managers, exported, and wired into Workflows and Insights.

**Architecture:** The form is a `DocTemplate` with `doc_type='form'` and extended `field_defs`; entries are a new `doc_form_entries` table with their own read rules, PDF and CSV; the fill screen is a phone-first renderer built on `TypedFieldInput`; the Documents module gains a Forms tab; Workday, My Shifts, the + menu and the Quick Actions dock get the entry points; `workflows.emit` carries `form.submitted` / `form.reviewed`.

**Tech Stack:** FastAPI + SQLAlchemy, reportlab, React 19, `BarcodeDetector` + jsqr, Supabase private bucket, vitest, pytest (one file per process).

**Spec:** `docs/superpowers/specs/2026-11-02-forms-design.md`

## Global Constraints

- CLAUDE.md house rules (US formats, Title Case, no em dashes, shared files append only, both migration lists, RLS, `_validate_photo_url`, no blocking I/O on the loop, notifications server-side).
- One template engine: `DocTemplate` + `_clean_field_defs`; one file path: `task-files` bucket, `forms/<entryKey>/`; one automation path: `workflows.emit`.
- Nothing decides by itself: review states are set by a person; Workflows run only what an administrator built.
- Backend tests one file per process with a tempfile `DATABASE_URL` header.

## Review Focus

1. A `showIf` field hidden at submit time must not be required and must not be stored with a stale value - test in Task 1 (server drops hidden tokens) and Task 4 (client).
2. A repeat group with zero rows on a required group refuses; with three rows stores three answer maps in order - Task 1.
3. A person outside the audience (another department, a site not in their `work_site_ids`, another company) gets 404 on fill and never sees the template in "Fill a Form" - Task 1.
4. A retry with the same `entry_key` returns the first entry (200, same id), never a second row - Task 1 and Task 4.
5. A manager sees an entry by a report at another site AND an entry by a stranger at their team's site, and not an entry by a stranger at another site - Task 1.

---

### Task 1: Backend - form templates, entries, read rules, PDF, CSV

**Files:**
- Modify: `backend/models.py` (append `DocFormEntry`, table `doc_form_entries`, columns per the spec; `DocTemplate` gains `audience`, `department_audience`... NO: reuse the existing `department` column for the audience department and append `audience` (String, default "company"), `work_site_id` (String, default ""), `show_on_shifts` (Integer, default 0)); both `main.py` migration lists (three ADD COLUMN lines on `doc_templates`); Postgres RLS line for `doc_form_entries`
- Modify: `backend/routers/documents.py` - `_TEMPLATE_TYPES` gains `"form"`, `_TEMPLATE_CATEGORIES` gains inspection / incident / vehicle / checklist / safety; `_FIELD_TYPES` gains `photo`, `gps`, `scan`, `rating`, `yesno` (allowed only when `doc_type == 'form'`); `_clean_field_defs(defs, *, form=False)` keeps `section`, `showIf`, `formula`, `repeat` only when `form`; `_ser_template` adds `audience`, `workSiteId`, `showOnShifts`, `docType`
- Create: `backend/routers/forms.py` (prefix `/forms`): `GET /forms/mine` (templates this person may fill: `doc_type == 'form'`, `status == 'active'`, the Announcements audience rule via a shared helper `form_audience.may_fill(db, tpl, email)` - import `_people`-style facts from `routers/announcements` or lift the rule into `backend/audience.py` used by BOTH), `GET /forms/{tid}` (released field defs + title for the fill screen, 404 outside the audience), `POST /forms/{tid}/entries` body `{entryKey, answers, workSiteId?, shiftId?, source, gps?}` -> the entry (idempotent on `entry_key`; server re-checks required + `showIf` + formats, drops hidden tokens, validates photo / signature URLs with `_validate_photo_url`, runs formulas server-side with `task_formula`), `GET /forms/entries?template=&site=&status=&from=&to=&person=&page=` (the viewer's reach), `GET /forms/entries/{id}`, `POST /forms/entries/{id}/review {status: reviewed|follow_up|closed, note}` (manager of the submitter, a manager of the site's team, HR++, administrator; bells the submitter "Vehicle Check Reviewed" / "Vehicle Check Needs Follow-Up"), `POST /forms/entries/{id}/link {ticketId|taskId|assetId}`, `GET /forms/entries/{id}/pdf`, `GET /forms/templates/{tid}/export.csv`
- Create: `backend/form_audience.py` (`may_fill`, `fillable_for(db, email) -> [tpl]`, `viewer_reach(db, user) -> callable(entry) -> bool` implementing Review Focus 5), `backend/form_entry_pdf.py` (`render(db, entry, tpl) -> bytes`), `backend/form_rules.py` (`visible_tokens(defs, answers)`, `validate(defs, answers) -> [{token, message}]`, `compute(defs, answers) -> answers` for formulas)
- Modify: `backend/main.py` (append `include_router(forms.router)`)
- Test: `backend/test_forms.py`

**Interfaces (produced):**
- Entry JSON: `{id, templateId, templateVersion, title, entryKey, answers, company, workSiteId, workSiteName, shiftId, submittedBy, submittedByName, submittedAt (ISO), source, status, reviewerEmail, reviewedAt, reviewNote, linkedTicketId, linkedTaskId, linkedAssetId, canReview: bool}`.
- Fill payload: `GET /forms/{tid}` -> `{id, title, category, description, version, fieldDefs: [def], sections: [str], workSites: [{id, name}]}`.
- `field_defs` form keys: `section: str`, `showIf: {token, op, value}`, `formula: str`, `repeat: {group: str, max: int}`; types `photo` (value `[url]`), `gps` (`{lat, lng, accuracyM, siteName}`), `scan` (`str`), `rating` (`1..5`), `yesno` (`true|false`), `signature` (`url`).

- [ ] **Step 1: Failing tests** covering the five Review Focus items plus: template with `doc_type='form'` accepts the new keys and types and a `document` template refuses them; `/forms/mine` by audience; idempotent `entry_key`; review bells the submitter once; PDF bytes start with `%PDF`; CSV has one column per token.
- [ ] **Step 2-5:** run, implement, run, commit `feat(forms): form templates, entries, reach, review, PDF and CSV (Neil, 11/02/2026)`.

### Task 2: Workflows pack + Insights block

**Files:**
- Create: `backend/workflows/packs/documents.py` (entity `form_entry` on `DocFormEntry`, fields title / status / submittedBy / site / category, events `form.submitted` and `form.reviewed`, `extra` = flat answers + `form`), emit calls at the two choke points in `routers/forms.py` (inside the transaction)
- Modify: `backend/workflows/catalog.lock.json` (regenerated), `frontend/src/workflows/lib/modules.js` (`documents` label / order), `frontend/src/workflows/canvas/palette.js` (`MODULE_COLOR.documents`)
- Modify: `backend/routers/dashboards.py` (`forms_block`: `entries_7d`, `follow_up_open` (warning tone), `by_template` breakdown; `DRILLABLE` + drilldown branch), `backend/cache.py` `_WATCHED` gains `DocFormEntry`, `frontend/src/dashboard/biModel.js` (`forms` meta + ACTIONS -> documents forms tab)
- Test: `backend/test_workflows_pack_documents.py`, `backend/test_forms_insights.py`

- [ ] **Steps:** failing tests (an entry submit writes a `form.submitted` outbox row with `event.<token>` resolvable; catalog lock matches; Insights block counts and drills), implement, pass, commit `feat(forms): Workflows events and Insights block`.

### Task 3: Documents > Forms tab (build, publish, entries, review)

**Files:**
- Modify: `frontend/src/views/Documents.jsx` (`TABS` + `{key:'documents-forms', label:'Forms', Icon: ClipboardList}`, render case), `frontend/src/components/MobileNav.jsx` `DOCUMENT_ACTIONS` (same tab)
- Create: `frontend/src/forms/FormsTab.jsx` (two segments: Templates and Entries), `forms/FormBuilder.jsx` (a form's field list: sections, add / edit field through `DefineMergeFieldModal` extended with the form-only keys and types, drag order, Preview opens `FillForm` in preview mode, Publish through the existing template publish call, audience picker (company / department / site + Show On Shift Cards switch)), `forms/EntriesList.jsx` (table key `form-entries`, `ColumnResizer` + `useColumnWidths`, filters, soft `StatusLabel` states Submitted / Reviewed / Needs Follow-Up / Closed), `forms/EntryPanel.jsx` (the side sheet: answers by section, photo strip opening the viewer, map link, signature, review controls with note, Make a Ticket / Make a Task through the existing create modals with prefilled title + body + attachments, PDF, link chips)
- Modify: `frontend/src/lib/documentLibrary.js` (`VIEWS` gains `forms` with `kind === 'form_entry'`, `rowStatus` branch), `frontend/src/components/DocumentSidePanel.jsx` (a `form_entry` branch that renders `EntryPanel`), `frontend/src/api.js` (append the `/forms/*` calls)
- Test: `forms/FormBuilder.test.jsx`, `forms/EntriesList.test.jsx`, `forms/EntryPanel.test.jsx`

- [ ] **Steps:** failing tests, implement, pass, commit `feat(forms): Documents > Forms tab - builder, entries, review`.

### Task 4: Fill a Form on the phone and its entry points

**Files:**
- Create: `frontend/src/forms/FillForm.jsx` (the renderer: sections, `TypedFieldInput` + new inputs `PhotoField` (camera-first `<input capture>`, several, upload as taken with `storeTaskFile(file, onProgress, 'forms/<entryKey>')`, Ctrl+V on the web), `GpsField` (`getPosition` from `lib/geoPosition.js`, shows the nearest site name from the payload's `workSites`), `ScanField` (`BarcodeDetector` when present, else a photo decoded with jsqr - move `jsqr` to dependencies), `RatingField`, `YesNoField`, `SignatureField` (SignaturePad -> PNG upload); `showIf` live; formulas read-only via `runFormula`; required / format errors inline; localStorage draft keyed `nexus.formDraft.<templateId>` with `entryKey`, offered back ("You have an unsent <title> from 11/02/2026 2:14 PM - Continue / Discard"); Submit once; 16px inputs on phones; `useVisualViewport` for the keyboard strip), `forms/FormsTile.jsx` (Workday: "Fill a Form", the fillable list grouped by category, opens `FillForm` in the 60% sheet / phone full sheet), `forms/formDraft.js`
- Modify: `frontend/src/views/MyHR.jsx` `wd-actions` (:550-574) gains `FormsTile`; `frontend/src/views/TimeClock.jsx` deep link `form:<templateId>` next to `signOf` (:109) opening the fill sheet; `frontend/src/components/MyShifts.jsx` shift card action "Fill <title>" when a fillable form has `showOnShifts` for the shift's site (from `/forms/mine` carrying `workSiteId` + `showOnShifts`); `frontend/src/lib/quickCreate.js` `CREATE_ITEMS` gains `{key:'form', group:'Workday', label:'Fill a Form', module:'myhr', go:['timeclock','form:pick']}`; `frontend/src/dashboard/widgets.jsx` `QUICK_ACTIONS` gains `fill-form`
- Test: `forms/FillForm.test.jsx` (showIf hides and unrequires; repeat add / remove; draft saved and offered; submit once with the same entryKey on retry; photo upload called with the forms folder), `forms/FormsTile.test.jsx`, MyShifts test for the card button

- [ ] **Steps:** failing tests, implement, pass (`npx vitest run src/forms src/components/MyShifts src/views/MyHR`, lint, build with the bundle budget - jsqr is small), commit `feat(forms): Fill a Form on the phone - Workday tile, shift card, + menu, Quick Actions (Neil, 11/02/2026)`.

### Task 5: Docs

- [ ] CLAUDE.md bullet "Forms are templates (Neil, 11/02/2026)": `doc_type='form'`, one field list, entries table and reach rule, `task-files/forms/<entryKey>/`, `workflows.emit` only, where the entry points are, nothing decides by itself. `docs/Forms.md` user guide (build, publish, fill, review, export, automate). Commit `docs: forms and checklists`.

## Self-review
- Spec coverage: template (1), entries + reach + review + PDF/CSV (1), Workflows + Insights (2), Documents tab (3), fill + entry points (4), docs (5). Offline submission, approval chains, external forms are non-goals.
- Interfaces: entry JSON and fill payload defined in Task 1 and consumed by 3 and 4; `/forms/mine` carries `workSiteId` + `showOnShifts` for Task 4's shift card.
- Review Focus tests are placed in Tasks 1 and 4.
