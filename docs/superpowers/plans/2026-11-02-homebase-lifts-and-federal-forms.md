# Homebase Lifts + Federal Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five lifts Neil kept from the Homebase audit (early punch alert, HR++ labor budget, time-off recommendation, announcements by work site + not-yet-acknowledged, live team strip) and the three federal onboarding forms (W-4, I-9 with HR's Section 2, direct deposit authorization) filled and signed in Nexus Sign, always on the current official edition.

**Architecture:** Each lift is a small change at an existing choke point (the punch route, the labor endpoint, the approvals inbox source, the announcements audience resolver, the live-schedule endpoint). The forms are a new `backend/federal_forms/` package that bundles the official public-domain PDFs, derives the field layout from each PDF's own AcroForm widgets, strips the widgets, and hands Nexus Sign a flat PDF plus typed fields; Nexus Sign gains field formats (SSN, routing, account), encrypted-at-rest sensitive values, and a restricted sealed PDF. Hiring packets and the person record send them; checklist items tick from the envelope.

**Tech Stack:** FastAPI + SQLAlchemy, pypdf 6 (AcroForm read, `remove_annotations`), reportlab overlay (`_stamp_pdf`), `secret_box` Fernet, React 19, vitest, pytest (one file per process).

**Spec:** Neil's decisions in chat 11/02/2026 (recorded in memory `homebase-desktime-audit-nov-2026`) and the audit page https://claude.ai/artifact/GfqeunYXbSFjjctwCAwzEY. Research: current I-9 edition 01/20/25 (also 08/01/23, both expire 05/31/2027; uscis.gov/i-9), 2026 Form W-4 (irs.gov/pub/irs-pdf/fw4.pdf, released 12/11/2025).

## Global Constraints

- American English, MM/DD/YYYY, 12-hour times, Title Case titles, no em dashes in copy, "Time Sheet".
- Backend tests one file per process with a tempfile `DATABASE_URL` header; `ruff check backend/`; frontend `npm run lint`, `npx vitest run`, `npm run build`.
- New columns go in the model AND both `main.py` migration lists; new tables need RLS lines in the Postgres list.
- Shared files (`models.py`, `main.py` lists, `api.js`) append only.
- Notifications server-side only; one bell per workflow updated in place; `notify_rollup.upsert_rollup` for grouped bells.
- Settings: switches save on click, typed fields through the group's one `SaveRow` (`ShiftSettingsSections.jsx` already does this).
- Never block a punch (Neil): an early punch is recorded and alerts.
- Never auto-approve time off (Neil): recommend only.
- Labor budget visible to HR++ only (company HR contact, administrator, Full `hr` grant that is not team-limited) - `hr_access.py` is the rule; managers never see it.
- SSN and bank numbers: never in a plaintext column, never in a bell, email body, log or `filledByOthers`; printed only into the sealed PDF, which is restricted (`prints_pay`-style) and never emailed as an attachment. This deliberately reverses the ON-05 / ON-18 "outside Nexus" notes (Neil, 11/02/2026: "I want the W-4, I-9, direct deposit done").
- Form editions are pinned in code; a lapsed edition refuses to send; HR is warned 60 days ahead.
- No AI anywhere.

## Review Focus

1. An early punch by a person with NO expected start (no shift, no preset) must produce no alert - test in Task 1.
2. A request that spans a company holiday or weekend must count only working days against the balance in the recommendation - test in Task 3 (`request_hours` already does this; assert it).
3. A site-audience post must never reach a person whose `work_site_ids` is empty ("any company site") unless they are in the author's company scope AND the post's site belongs to their company - test in Task 4; empty list = not a member.
4. SSN validation must reject 000-xx-xxxx, 666-xx-xxxx, 9xx-xx-xxxx, xxx-00-xxxx, xxx-xx-0000; routing numbers must pass the ABA checksum - tests in Task 6.
5. A W-4 sent on 01/15/2027 with the 2026 edition still registered must be refused with the edition message, and on 12/01/2026 HR must get the "update due in January" bell - tests in Task 6.

---

## Part 1 - Lifts (branch `feat/homebase-lifts`, one PR)

### Task 1: Early punch alert

**Files:**
- Modify: `backend/routers/shift_requests.py` (`_DEFAULTS` ~:90-166, `_INT_SETTINGS` ~:170, `SettingsIn` ~:344)
- Create: `backend/early_punch.py`
- Modify: `backend/routers/timeclock.py` punch route (`punch` :1141, after the row is added ~:1238 and before `db.commit()` :1287); `self_manual_punch` :1403 and `track_clock` :6014 call the same helper
- Modify: `frontend/src/components/shifts/ShiftSettingsSections.jsx` (`SHIFT_SETTING_PARTS.attendance` :168, `NUM_MAX` :484, `NUM_DEFAULT` :489, a `MinutesField` in `block('attendance')` :352-373)
- Test: `backend/test_early_punch.py`, `frontend/src/components/shifts/ShiftSettingsSections.test.jsx`

**Interfaces:**
- Produces: `early_punch.check(db, row, emp) -> dict | None` - `row` is the just-added `TimePunch` with `kind == 'in'`, `emp` the `NexusEmployee`; returns `{"minutesEarly": int, "expectedStart": "HH:MM"}` and upserts the manager rollup when the punch is more than `earlyPunchAlertMin` before `shift_expect.start_utc(row.local_date, exp)`; returns `None` otherwise (setting 0 = off, no expected start, not an "in" punch).
- Setting key: `earlyPunchAlertMin`, default `0`, range `(0, 240)`.
- Rollup: `notify_rollup.upsert_rollup` with `ref_id = f"earlyin:{group_id or '-'}:{work_date}"`, recipients from `shift_attendance._recipients_for`, title "Early Punches Today" (one name: "Early Punch Today"), body "Ana Diaz punched in 25 min before her 8:00 AM shift." / "3 people punched in early: Ana Diaz (25 min), ..."; action `{"view":"shifts","sub":"schedule:{date}:{gid}","kind":"early_punch"}`; `quiet=not fresh`.

- [ ] **Step 1: Failing tests** in `backend/test_early_punch.py` (tempfile DB header): `test_off_by_default_no_bell`, `test_early_in_bells_manager_once_and_groups_second_person`, `test_within_window_no_bell`, `test_no_expected_start_no_bell`, `test_out_punch_ignored`. Use `shift_expect` by seeding a `ShiftPreset`/placement the way `test_shift_attendance.py` does.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest test_early_punch.py -q` - fails (module missing).
- [ ] **Step 3: Implement** `early_punch.check` and the setting; call it in the three punch writers right after the row is added (`db.flush()` first so `row.id` exists); never raise out of the route (wrap in try/except, print).
- [ ] **Step 4: Settings UI**: `MinutesField label="Early Punch Alert" hint="Tell the manager when someone punches in more than this many minutes before their shift. 0 turns it off. The punch is always recorded."` under Attendance; test asserts the row renders and saves through the one Save row.
- [ ] **Step 5: Run** the backend file and `npx vitest run src/components/shifts/ShiftSettingsSections`; pass.
- [ ] **Step 6: Commit** `feat(time clock): early punch alerts the manager, never blocks (Neil, 11/02/2026)`.

### Task 2: Weekly labor budget, HR++ only

**Files:**
- Modify: `backend/routers/shift_requests.py` (`_DEFAULTS`: `laborBudgetHours` 0, `laborBudgetAmount` 0, `_INT_SETTINGS` ranges `(0, 100000)` and `(0, 10000000)`, `SettingsIn`)
- Modify: `backend/routers/timeclock.py` `schedule_labor` :7645 - add `budgetVisible: bool`, and when visible `budget: {"hours": int|None, "amount": int|None, "currency": str}` for the caller's company (the company of the people in scope; several companies = the caller's own company via `auth.company_of`)
- Modify: `frontend/src/components/shifts/ShiftSettingsSections.jsx` (two fields in a new `block('labor', 'Labor Budget')`, HR++ only shown - the panel already receives the caller's grants; if not, show them and let the server 403)
- Modify: `frontend/src/components/ShiftSchedule.jsx` `laborText` :91 / the `data-labor-line` span :1228 - when `labor.budgetVisible && labor.budget` print " of 1,250 h budget" / " of $9,000 budget" after the scheduled figure, amber (`NX.amber` or the existing warn color) when over
- Test: `backend/test_shifts_labor.py` (add), `frontend/src/components/ShiftSchedule.test.jsx` (add to the laborText test)

**Interfaces:**
- `budgetVisible = hr_access.is_hr_for_company(db, user, company_id)` - managers (`auth.hr_team_limited`) are never visible. Both the budget values AND the flag are absent for everyone else (not `null`, absent).
- Budget is weekly; the endpoint scales it to the requested range: `budget * (days / 7)`, rounded; the planner shows weeks so this is exact for a week.

- [ ] **Step 1: Failing tests**: `test_budget_hidden_for_manager_tier`, `test_budget_visible_for_hr_contact_with_values`, `test_budget_scaled_to_range`; frontend: `laborText` with a budget under and over.
- [ ] **Step 2: Run** both - fail.
- [ ] **Step 3: Implement** setting, endpoint fields, planner text, Settings block (copy: "Labor Budget" / "Hours per week" / "Amount per week" / hint "Shown on the shift planner to HR and administrators only - never to managers.").
- [ ] **Step 4: Run** - pass. **Step 5: Commit** `feat(shifts): weekly labor budget on the planner, HR++ only (Neil, 11/02/2026)`.

### Task 3: Time-off recommendation (never a decision)

**Files:**
- Create: `backend/timeoff_recommend.py`
- Modify: `backend/approvals_inbox.py` `_time_off_row` :407 (add `hint`), `backend/routers/timeclock.py` `_ser_timeoff` :12273 (add `recommendation` for deciders only)
- Modify: `frontend/src/approvals/ApprovalsCenter.jsx` `Row` :551 (a `StatusLabel`-style soft chip from `row.hint`), `frontend/src/components/ShiftRequestsInbox.jsx` time-off card :283-320 (same chip)
- Test: `backend/test_timeoff_recommend.py`, `frontend/src/approvals/ApprovalsCenter.test.jsx` (add), `frontend/src/components/ShiftRequestsInbox.test.jsx` (add)

**Interfaces:**
- `timeoff_recommend.recommend(db, req: TimeOffRequest) -> {"tone": "good"|"check", "label": "Recommended: Approve"|"Check First", "reasons": [str]}`.
  - good when ALL hold: balance covers it (`leave_balances.balances` + `request_hours`, skip the check when `bucket_of` is '' or `live` is false), no one else with the same `manager_email` has approved or pending time off overlapping, start is at least `noticeDays` (setting `timeOffNoticeDays`, default 7, range 0-90) away, and the span is at most `shortRequestDays` (setting `timeOffShortDays`, default 3, range 1-30) working days.
  - reasons are plain sentences: "Balance covers it (32 h left after).", "Nobody else on the team is off those days.", "Requested 12 days ahead.", or for check: "Balance is 8 h short.", "Ana Diaz is also off 11/14.", "Starts in 2 days.", "5 working days."
- `hint` on the inbox row: `{tone, text: label, reasons}`; `_ser_timeoff` adds `recommendation` only when `canDecide`.

- [ ] **Step 1: Failing tests**: four backend cases (all good; short balance; teammate overlap; short notice) + holiday-span test (Review Focus 2); frontend: the chip renders the label and the reasons as a title.
- [ ] **Step 2: Run** - fail. **Step 3: Implement.** The approve/reject buttons are unchanged; nothing is decided by code.
- [ ] **Step 4: Run** - pass. **Step 5: Commit** `feat(time off): approval recommendation with reasons - the manager still decides (Neil, 11/02/2026)`.

### Task 4: Announcements by work site + not yet acknowledged

**Files:**
- Modify: `backend/models.py` `Announcement` :6219 (append `work_site_id = Column(String, default="")`), both `main.py` migration lists (`ALTER TABLE nexus_announcements ADD COLUMN ... work_site_id TEXT DEFAULT ''`)
- Modify: `backend/routers/announcements.py` `AUDIENCES` :55 add `"site"`, `_people` :83 add `sites` via `routers.hr.allowed_site_ids`, `_validate` :223 (site required and must be a company site the author may post to), `_audience_emails` :346 (site members = people whose `sites` contains the id; empty list is NOT a member), `_serialize` :154 add `workSiteId`/`workSiteName`, reads route :552 add `notAcknowledged: [{email,name}]` for `requires_ack` posts
- Modify: `frontend/src/dashboard/essentials/Announcements.jsx` (`EMPTY_FORM` :42, `formOf` :64, audience select :460 adds "Work Site" with a site picker from `api.getWorkSites()`, row chip :254, `ReadsList` :304 shows "Not Yet Acknowledged" names)
- Test: `backend/test_announcements_reach.py` (add), `frontend/src/dashboard/essentials/Announcements.test.jsx` (add)

- [ ] **Step 1: Failing tests**: site post reaches members only (Review Focus 3), empty `work_site_ids` excluded, reads route lists not-acknowledged, validation refuses a foreign company's site; frontend: site option, chip, Not Yet Acknowledged list.
- [ ] **Step 2: Run** - fail. **Step 3: Implement.** `announcements_publish.publish` needs no change (it calls `_audience_emails`).
- [ ] **Step 4: Run** - pass. **Step 5: Commit** `feat(announcements): work-site audience and not-yet-acknowledged names (Neil, 11/02/2026)`.

### Task 5: Live team strip

**Files:**
- Modify: `backend/routers/timeclock.py` `GET /timeclock/my-schedule/live` :7815 - add `late: [email]` using `shift_expect.expected_starts` + `late_now` for people in the caller's groups with no "in" punch today, and `counts: {in, break, late, off}`
- Modify: `frontend/src/components/TeamShiftGrid.jsx` header :100-127 - replace the `data-live-summary` text with a strip of four soft chips "In 6 · On Break 1 · Late 2 · Off 4" (`StatusLabel` tones: In green, On Break slate, Late amber, Off muted); click a chip filters the grid rows to those people (toggle)
- Test: `backend/test_schedule_live.py` (new, tempfile DB), `frontend/src/components/TeamShiftGrid.test.jsx` (add)

- [ ] **Step 1: Failing tests**: late computed from expected start; a Sick/PTO punch is not "in"; strip renders counts and filters.
- [ ] **Step 2-5:** implement, pass, commit `feat(team): live In / On Break / Late / Off strip on the planner (Neil, 11/02/2026)`.

---

## Part 2 - Federal forms in Nexus Sign (same branch, same PR)

### Task 6: `backend/federal_forms/` package

**Files:**
- Create: `backend/federal_forms/__init__.py`, `registry.py`, `prepare.py`, `formats.py`, `rules.py`, `editions.py`, `maps/w4_2026.json`, `maps/i9_2025-01-20.json`, `maps/direct_deposit_v1.json`, `pdf/fw4-2026.pdf`, `pdf/i-9-2025-01-20.pdf`, `pdf/direct-deposit-v1.pdf` (our own one-page ACH authorization drawn with reportlab at build of the package - a script `make_direct_deposit.py` generates and commits it)
- Test: `backend/test_federal_forms.py`

**Interfaces:**
- `registry.FORMS = {"w4": {...}, "i9": {...}, "direct_deposit": {...}}`, each `{title, edition, editionLabel ("2026" / "01/20/25" / "v1"), expires: "YYYY-MM-DD" | "", pdf, map, roles: ["employee"] | ["employee","hr"], us_only: True, worker_types: ["employee"] (w9 stays the contractor path)}`.
- `editions.status(kind, today) -> {"state": "ok"|"expiring"|"expired", "message": str}`: I-9 expired when `today > expires`; expiring within 60 days; W-4 expired when `today >= date(edition_year + 1, 2, 1)` (January is the grace month), expiring from 12/01 of the edition year.
- `prepare.prepare(kind) -> {"pdf": bytes, "fields": [field], "pages": int}`: reads the bundled PDF, extracts every `/Widget` rect per page, looks each widget's `/T` up in the map, emits Nexus Sign fields `{id, role, type ("text"|"check"|"radio"|"date"|"sign"), page, x, y, w, h, required, label, options?, format?, sensitive?, source ("person"|"hr"|"merge"), mergeKey?}` in normalized top-left coordinates (the same frame `_clean_fields` expects), then returns the PDF with widgets removed (`PdfWriter.remove_annotations(subtypes=["Widget"])`). Widgets not in the map are dropped with a logged warning; map entries whose widget is missing fail the startup test (so an edition swap cannot silently misplace a field).
- `formats.check(fmt, value) -> str` returns '' or a sentence: `ssn` (9 digits, area not 000/666/900-999, group not 00, serial not 0000; accepts dashes), `routing` (9 digits, ABA checksum `3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6+d9) % 10 == 0`), `account` (4-17 digits), `ein`, `zip`, `date_mmddyyyy`, `alien_number`, `i94`, `passport`.
- `rules.validate(kind, role, values: dict) -> list[{field, message}]` - per-form conditional requirements: W-4 Step 1(c) exactly one filing status; I-9 Section 1 exactly one citizenship status and the matching number field; I-9 Section 2 either one List A document or one List B plus one List C, each with title / issuing authority / number / expiry (expiry may be "N/A"), and the first day of employment; direct deposit: one or two accounts, amounts or percent summing to 100 when two.
- `maps/*.json`: `{"<widget name>": {"id": "...", "role": "employee"|"hr", "type": ..., "label": ..., "required": bool, "format": ..., "sensitive": bool, "source": "person"|"hr"|"merge", "mergeKey": "employer.legal_name"|"employer.ein"|"employer.address"|"person.first_day"}}`. Merge keys print employer facts from `HrEntity` (`legal_name`, `tax_id`, `registered_address`) and the start date.

- [ ] **Step 1: Failing tests**: `test_every_form_prepares_with_all_mapped_widgets_found`, `test_prepared_pdf_has_no_widgets`, `test_ssn_rules` (Review Focus 4 cases), `test_routing_checksum`, `test_w4_edition_status_dates` (Review Focus 5 dates), `test_i9_edition_expires_05_31_2027`, `test_i9_section2_list_rules`, `test_w4_single_filing_status`.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest test_federal_forms.py -q` - fails.
- [ ] **Step 3: Implement** the package. Download the official PDFs from `https://www.irs.gov/pub/irs-pdf/fw4.pdf` and `https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf` into the package (public domain US government works; record the source URL and SHA-256 in `registry.py`). Build the maps by listing the widgets (`PdfReader.get_fields()` names like `topmostSubform[0].Page1[0].Step1a[0].f1_01[0]` for the W-4; descriptive names like `Last Name Family Name from Section 1` for the I-9) and reading each one's position on the page to label it; the W-4 pages 2-5 (worksheets) carry no mapped fields except the Step 4(b) worksheet total if present.
- [ ] **Step 4: Run** - pass. **Step 5: Commit** `feat(federal forms): bundled W-4 2026, I-9 01/20/25 and direct deposit with field maps, formats, rules and edition watch`.

### Task 7: Nexus Sign engine - formats, sensitive values, restricted PDF

**Files:**
- Modify: `backend/routers/esign.py` `_FIELD_TYPES` :1332 / `_clean_fields` :1353 (allow `format`, `sensitive`, `formKind` on a document entry), `SignIn` :2875 handling (`_missing_required` :2894 plus `federal_forms.formats.check` per field and `rules.validate(formKind, role, values)` - 422 with the field id and the sentence), party `field_values` write (encrypt `sensitive` values with `secret_box.encrypt`, stored as `"enc:<token>"`), `_render_payload` :2765 (`filledByOthers` shows sensitive values as `***-**-1234` / `••••4321`, never the token), `_stamp_pdf` :4364 (decrypt for drawing only), `_finalize` :5212 (`prints_pay=1` for any envelope with a sensitive field; completion email carries the link, never the PDF attachment for restricted envelopes), a `viewed_final` `HrSignEvent` whenever the restricted final PDF is served
- Modify: `backend/audit_capture.py` `_HR_TABLES` :202 add `hr_sign_parties`
- Test: `backend/test_esign_sensitive.py`

**Interfaces:**
- Field def gains `format: str` (one of `formats` keys) and `sensitive: bool`; document entry gains `formKind: "w4"|"i9"|"direct_deposit"|""`.
- `esign.sensitive_mask(fmt, value) -> str`.

- [ ] **Step 1: Failing tests**: a sensitive text value is stored `enc:` and decrypts to the input; `filledByOthers` masks; wrong SSN returns 422 with the field; restricted envelope's completion email has no attachment and `prints_pay` is 1; a viewer without Pay & Benefits gets 403 on the final PDF; `viewed_final` event is written.
- [ ] **Step 2-5:** implement, pass, commit `feat(nexus sign): field formats, encrypted sensitive values, restricted sealed PDF`.

### Task 8: Packets and the person record send the forms; checklist ticks; edition watch

**Files:**
- Modify: `backend/models.py` `HrPacketSetting` :6264 append `federal_forms = Column(JSON, default=list)`; both migration lists
- Modify: `backend/hr_packet_docs.py` `build_envelope` :1223 - after the Documents, for each kind in `setting.federal_forms` that applies (US company via `country_of`, worker type employee): `federal_forms.prepare(kind)`, upload the PDF to `esign/{uuid}/{kind}.pdf`, append `{pdf_storage_path, fields, formKind: kind, title}` to `documents`; fields with `source == "merge"` are filled from the entity and the event; an I-9 adds an `hr` sign step AFTER the person when the flow has none (`clean_flow` result + one `{key:"hr", role:"hr", action:"sign"}`), resolved by `resolve_role("hr")`
- Modify: `backend/routers/hr_life_events.py` `/packets` CRUD (accept `federalForms: [kind]`)
- Create route: `POST /hr/employees/{eid}/federal-forms/send {kind}` in `backend/routers/hr.py` (HR++ for the person's company; builds a one-document envelope through `esign.envelope_from_documents`, person first, HR second for the I-9, `link_kind="federal_form"`, `link_id=f"{eid}:{kind}"`, `egnyte_folder` the person's folder with subfolder "Tax and Payroll Forms" for W-4 / direct deposit and "Form I-9" for the I-9)
- Modify: `backend/hr_checklists.py` `SIGNALS` :940 + `_sig_envelope` :848 - new signals `envelope:w4`, `envelope:i9_s1` (person signed), `envelope:i9_s2` (HR signed), `envelope:direct_deposit`; `hr_checklist_seed.py` ON-05 -> signal `envelope:w4` + `envelope:direct_deposit`, owner stays accounting, hint rewritten ("Sent and signed in Nexus Sign; the signed forms file to the person's folder. Neil, 11/02/2026."), ON-18 -> `envelope:i9_s1`, ON-23 keeps `id_on_file` OR `envelope:i9_s2` (either ticks); `backfill_id_evidence` pattern used to retrofit seeded templates
- Modify: `backend/hr_life_events.py` `on_completed` :2052 - for a `direct_deposit` form write `emp.bank` from the decrypted values (existing hr_comp-gated plaintext column, matching `_apply_hire_details`), never the SSN anywhere; bells: accounting owner "W-4 Signed - Ana Diaz" / "Direct Deposit Signed - Ana Diaz" (link to the person's Documents tab), HR contact "I-9 Section 2 Due 11/06/2026 - Ana Diaz" when Section 1 completes
- Create: `backend/federal_forms/watch.py` `run_daily(db)` called from `reminders.reminders_loop` (:683 pattern, `asyncio.to_thread`, gated by `job_switch.off("federal_forms")`, registered in `workflows/automations.jobs()`): one bell per kind per state change to every HR contact and administrator - "Form I-9 Edition Expires 05/31/2027" (expiring) / "Form I-9 Edition Expired - Sending Is Paused" (expired) / "2027 Form W-4 Due In January" (W-4 expiring from 12/01) - `ref_id = f"fedform:{kind}:{state}"`; `build_envelope` and the send route refuse an expired edition with 400 "The {title} edition in Nexus ({editionLabel}) expired on {MM/DD/YYYY}. Ask an administrator to update it before sending."
- Test: `backend/test_federal_forms_packets.py`

- [ ] **Step 1: Failing tests**: a packet with `federal_forms=["w4","i9","direct_deposit"]` for a US employee yields an envelope with three more documents, person first, an added HR step; a non-US company gets none; the standalone send route works for HR and 403s for a manager; checklist ON-05 / ON-18 / ON-23 tick on the right signals; the daily watch bells once per state; an expired edition is refused.
- [ ] **Step 2-5:** implement, pass, commit `feat(hr): federal forms in hiring packets and on the person record, checklist signals, edition watch`.

### Task 9: Frontend - packet editor, person record, signing formats, Settings status

**Files:**
- Modify: `frontend/src/components/DocumentsPacketEditor.jsx` (a "Federal Forms" block with three checkboxes "Form W-4 (2026)", "Form I-9 (01/20/25)", "Direct Deposit Authorization", shown for US companies and the employee worker type, saving `federalForms`)
- Modify: the person record's Documents tab (find the HR person Documents component; add a "Send Federal Form" menu: W-4 / I-9 / Direct Deposit -> `api.sendFederalForm(eid, kind)`, HR++ only, with the edition label and a disabled state + message when the edition is expired)
- Modify: `frontend/src/components/ESign.jsx` `SigningDoc` :1071 - text fields with `format` get an input mask (SSN `###-##-####`, routing/account digits only with the live count), server 422 messages shown under the field, sensitive fields render masked when the signer is not their owner; the HR Section 2 step shows Section 1 values read-only with the SSN masked
- Modify: `frontend/src/views/AdminConsole.jsx` + a new `components/settings/FederalFormsStatus.jsx` under Settings > Hiring & Onboarding: read-only rows per form - edition, expires, state chip (Current / Expiring / Expired), source URL; `GET /hr/federal-forms/status`
- Modify: `frontend/src/api.js` (append `sendFederalForm`, `federalFormsStatus`, packet `federalForms` passthrough)
- Test: `DocumentsPacketEditor.test.jsx`, `ESign.test.jsx` (mask + 422), `FederalFormsStatus.test.jsx`

- [ ] **Step 1-5:** failing tests, implement, pass, commit `feat(hr): federal forms in the packet editor, on the person record, signing masks, Settings status`.

### Task 10: Docs, CLAUDE.md, release notes

- [ ] CLAUDE.md bullet "Federal forms (Neil, 11/02/2026)": one package, editions pinned, expired = refused, SSN/bank rules, restricted PDF, signals; and the lifts' one-line rules (early punch never blocks; budget HR++; recommend never decide; site audience membership rule).
- [ ] `docs/Federal-Forms.md`: how to update an edition (replace the PDF, regenerate the map check, bump `registry`, run `test_federal_forms.py`), the I-9 retention note (3 years after hire or 1 year after separation, whichever is later - Nexus keeps the sealed PDF; HR exports from Egnyte), and that remote document examination is only for E-Verify employers (not built).
- [ ] Commit `docs: federal forms and the five lifts`.

## Self-review notes
- Spec coverage: five lifts (Tasks 1-5), forms (6-9), docs (10). Shift feedback, kiosk, DeskTime items are deliberately absent.
- Types: `prepare()` returns the same field shape `_clean_fields` consumes; `formKind` travels on the document entry from Task 7 to Task 8.
- Review Focus tests are placed in Tasks 1, 3, 4, 6.

---

## Part 3 - Boards: own the seams, keep the engine replaceable (Neil, 11/02/2026)

Neil's concern: "requiring Excalidraw may not scale with time". Decision for this PR: do not rebuild the drawing engine (a from-scratch editor with Excalidraw's parity - freehand, text, bound arrows, groups, frames, multi-touch, undo, export, reconciliation - is months, and the lock-in is the element JSON, not the package). Instead make the engine a replaceable part behind one adapter, and make the board survive the engine failing.

### Task 11: Board engine adapter + robustness

**Files:**
- Create: `frontend/src/notes/board/engine/index.js` (the adapter contract), `frontend/src/notes/board/engine/excalidraw.jsx` (the only file in the repo that imports `@excalidraw/excalidraw` or its CSS besides the vitest mock), `frontend/src/notes/board/engine/fallback.jsx` (read-only PNG view with Retry)
- Modify: `frontend/src/notes/board/Board.jsx`, `BoardEmbed.jsx`, `exportBoard.js`, `useBoardCollab.js`, `boardSync.js`, `scene.js` - every engine call goes through the adapter
- Create: `frontend/src/notes/board/draft.js` (IndexedDB local draft per note id)
- Modify: `frontend/vitest.setup.js` mock stays; add `frontend/scripts/check-engine-imports.mjs` to the lint script (fails when any file outside `notes/board/engine/` imports `@excalidraw/`)
- Modify: `CLAUDE.md` Boards bullet (one line: the engine is behind `notes/board/engine`; nothing else imports it)
- Test: `frontend/src/notes/board/engine/*.test.jsx`, `draft.test.js`, Board tests

**Interfaces:**
- `engine/index.js` exports `loadEngine() -> Promise<Engine>` (lazy, the vendor chunk) and the contract: `Engine = { Canvas: React component taking {scene, onChange(scene), look, readOnly, viewportRef}, toScene(raw) -> NexusScene, fromScene(scene) -> raw, exportPng(scene, opts) -> Blob, exportSvg(scene) -> string, reconcile(local, remote) -> scene, version: string }`. `NexusScene` is the existing `nexus-board` JSON (`scene.js`), unchanged on disk.
- `draft.js`: `saveDraft(noteId, scene)`, `loadDraft(noteId) -> scene|null`, `clearDraft(noteId)`; a draft newer than the saved `rev` is offered on open ("You have unsaved drawing from 11/02/2026 2:14 PM - Restore / Discard"), cleared on a successful save.
- Fallback: when `loadEngine()` rejects (chunk missing after a deploy, CSP, offline), the board renders the last `thumb_url` full-width, read-only, with "The drawing tools did not load. Retry" and a Retry button; never blank, never a thrown error to the boundary.
- Scene guard: before save, `scene.js compact(scene)` drops `isDeleted` elements older than the last save and unreferenced files; a scene still over 2 MB shows "This board is too large to save - move some of it to a new board" instead of a 413.

- [ ] **Step 1: Failing tests**: import guard script fails on a planted import; `loadEngine` rejection renders the fallback with the thumbnail and Retry; draft saved on change and offered on reopen; compact drops old deleted elements; existing Board tests still pass through the adapter.
- [ ] **Step 2-5:** implement, pass (`npx vitest run src/notes/board`, `npm run lint`, `npm run build` with the bundle budget), commit `feat(boards): engine behind one adapter, local draft recovery, read-only fallback when the engine fails (Neil, 11/02/2026)`.

---

## Part 4 - New sign-in notices and Security in My Profile (Neil, 11/02/2026)

Neil: "people [should] know when their account is logged in to a new location. It should also help to log them out of any other device they are logged into - should be a user option in profile." Scope: the hosted app always signs in through the BFF cookie (`frontend/src/bffAuth.js`), so this covers `server_sessions` rows (employees) and guest sessions; the localhost MSAL bearer path has no session row and is out of scope.

### Task 12: Sign-in log, new-device notice, My Profile > Security

**Files:**
- Modify: `backend/models.py` - append `ip`, `user_agent`, `ua_summary`, `location` (String, default "") to `ServerSession` (:4674); new model `NexusSignIn` (table `nexus_sign_ins`: id, email (indexed), session_id, at, ip, user_agent, ua_summary, location, device_key, is_new, notified) - both migration lists get the four ADD COLUMN lines; the Postgres list gets the RLS line for `nexus_sign_ins`
- Create: `backend/ua_summary.py` - ONE `summarize(ua) -> "Windows 10/11 - Chrome"` extracted from `routers/esign.py` (~:4665-4725) and `services/certificate.py:348-360`; both now import it (behavior unchanged, their tests stay green)
- Create: `backend/ip_location.py` - `lookup(ip) -> str` ("Laguna Niguel, CA, US" or ""): skips private, loopback and Cloudflare ranges; reads a MaxMind GeoLite2-City database at `NEXUS_GEOIP_DB` when the `geoip2` package and the file exist, else returns "" (no outbound HTTP, no paid service, no key in the repo); cached per IP in process for a day
- Create: `backend/sign_in_watch.py` - `record(db, *, email, session_id, ip, user_agent) -> NexusSignIn` (device_key = sha256 of ua_summary + the /24 or /48 of the IP; `is_new` when no prior sign-in for this email has the same device_key in the last 180 days AND the person has at least one earlier sign-in - the very first sign-in ever is never "new"), `notify_new(db, row)` (one bell to the person, title "New Sign-In To Nexus", body "Mon 11/02/2026 8:33 AM PT - Laguna Niguel, CA, US - iPhone - Safari. Not you? Open My Profile > Security and sign out other devices." with `action={"view":"profile","sub":"security"}`, plus one email through `graph_mail.send_mail` built like `hr_probation._email_html` with the same facts in rows; sent off the request after commit; the Web Push follows the bell), `sweep(db)` (deletes `server_sessions` rows idle past `session_idle_days()` and `nexus_sign_ins` older than 180 days; `job_switch.off("sign_in_watch")`; registered in `workflows/automations.jobs()`; run from the `notification_retention_loop` cadence or its own leader loop copied from it)
- Modify: `backend/routers/auth_bff.py` `/auth/callback` (:63-97) and `routers/external_auth.py` `_session_response` (:402-409) - capture `client_ip.client_ip(request)` and the UA, store them on the session row, call `sign_in_watch.record` then `notify_new` when `is_new`
- Create: `backend/routers/me_sessions.py` - `GET /me/sessions` -> `{sessions: [{id (sha256 of the sid, never the sid), device, location, ip, lastSeen, createdAt, current: bool}]}` filtered to rows with `last_seen` inside the idle window; `DELETE /me/sessions/{id}` (own rows only, by the hash); `POST /me/sessions/others` -> `{signedOut: n}` = every own row except the current cookie's; `GET /me/sign-ins` -> the last 20 sign-ins with the same facts. Wire in `main.py` (append `include_router`)
- Modify: `frontend/src/api.js` (append `mySessions`, `mySignIns`, `signOutSession`, `signOutOtherSessions`), `frontend/src/components/MyProfileModal.jsx` (`SECTIONS` :34 gains `['security', 'Security', ShieldCheck]`; a self-fetching `SecuritySection`: "Where You Are Signed In" rows - device, location, "Last seen 11/02/2026 8:33 AM", "This device" chip, Sign Out per row (hold-free, reversible), one "Sign Out Other Devices" button (confirm dialog, `dialog.confirm`), and "Recent Sign-Ins" list with a "New" chip), `TopHeader.jsx` deep link `?profile=security` like `?emailSettings` (:19-29) so the bell and the email land on the section
- Modify: `frontend/src/views/PrivacyPolicy.jsx` :18 - add "approximate location derived from the IP address" to the disclosed sign-in facts
- Test: `backend/test_sign_in_watch.py` (first sign-in not new; same device not new; new device -> is_new, one bell, one email with the facts, MM/DD/YYYY and 12-hour time; private IP -> no location; sessions list hides the sid and marks current; others-sign-out leaves the current row; delete of another person's row 404; sweep removes idle rows), `backend/test_ua_summary.py`, `frontend/src/components/MyProfileModal.test.jsx` (Security section renders rows, This Device chip, Sign Out Other Devices calls the API after confirm)

**Rules:** never block or delay the sign-in on the notice (record + notify in a thread after the response or in a try/except that cannot fail the callback); the email never contains the session id; copy Title Case titles, sentence-case body, no em dashes; one bell per new sign-in (not rolled up - each one matters); location text is "" when unknown and the sentence drops that part rather than printing "Unknown".

- [ ] **Steps:** failing tests, run, implement, run, commit `feat(security): new sign-in notices, My Profile > Security with sign out other devices (Neil, 11/02/2026)`.
