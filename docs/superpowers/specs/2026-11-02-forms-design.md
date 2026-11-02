# Forms & Checklists - Design (Neil, 11/02/2026)

## Intent

The one structural gap the Connecteam and Pebb audits found: a crew member
cannot fill a form on a phone. Inspections, incident reports, vehicle checks,
opening and closing checklists, safety walks. Today those are paper, a chat
message, or a ticket asking someone else to do it.

Neil's calls: build it; it lives in the **Documents module** ("Operations for
us is self-storage related"); nothing automated decides anything.

## Goals

- A manager or administrator builds a form in minutes: sections, typed
  fields, photo, signature, location stamp, QR scan, a formula, a field that
  shows only when an earlier answer says so, a repeating group.
- A crew member finds the form where they already are (Workday, their shift
  card, the + menu, the Quick Actions dock) and fills it on a phone in under a
  minute, with photos taken as they go and a draft that survives a dropped
  signal or a closed browser.
- A manager reviews entries, marks them Reviewed or Needs Follow-Up with a
  note, turns one into a ticket or a task, and exports a template's entries.
- Every submission can start a Workflow ("when the incident report says
  Injury = Yes, notify HR and open a ticket") through the existing engine.
- Entries count on Insights and read like the rest of Documents.

## Non-goals (this PR)

- Offline submission (the draft survives; sending needs a signal; the punch
  queue pattern is the later path).
- Multi-step approval chains (Workflows cover "when submitted"; a second
  approver is a Workflow approval step).
- Public or external forms (signed-in Nexus people only).
- AI anything.

## Anti-goals

- A second template engine or a second field-type list. The form IS a
  `DocTemplate` (`doc_type = 'form'`) with the same `field_defs`.
- A second storage path for files: photos and signatures go to the private
  `task-files` bucket under `forms/<entryKey>/`, viewed through `/files/view`.
- A second automation path: `workflows.emit` only.

## The shape

**Template.** `DocTemplate` with `doc_type = 'form'`, `category` one of
inspection / incident / vehicle / checklist / safety / other, the existing
`field_defs` plus form-only keys (kept by `_clean_field_defs` only when
`doc_type == 'form'`): `section` (heading text the field sits under),
`showIf` `{token, op: eq|ne|any|empty|notEmpty, value}`, `formula` (the Tasks
formula language, `runFormula` with `field()` over the answers), `repeat`
(`{group: '<name>', max: 10}` - "Add Another"). New field types for forms
only: `photo` (one or several, camera first on a phone), `gps` (a location
stamp taken when the field is tapped: lat, lng, accuracy, the nearest work
site's name), `scan` (a QR code read with `BarcodeDetector`, jsqr fallback on
a photo), `rating` (1 to 5), `yesno`. `signature` on a form is a live
SignaturePad whose PNG is uploaded and stored as a URL. Audience: `audience`
(company | department | site), `department`, `work_site_id` - the
Announcements resolver rule, so "who can fill this" is one known rule; plus
`show_on_shifts` (the form appears on the shift card of anyone scheduled at
the site). Publish is the existing Publish; an entry pins the template
version it was filled on.

**Entry.** New table `doc_form_entries`: id, template_id, template_version,
title (the template's title at the time), entry_key (client-made UUID so a
retry never files twice), answers JSON (token to value; a photo is a list of
URLs; gps is an object; a repeat group is a list of answer maps), company,
work_site_id, shift_id, submitted_by, submitted_at, source (web | phone),
status (submitted | reviewed | follow_up | closed), reviewer_email,
reviewed_at, review_note, linked_ticket_id, linked_task_id, linked_asset_id,
deleted_at (soft). RLS on dev and prod.

**Who sees what.** The submitter sees their own. A manager sees entries by
their reports and entries at their teams' sites. HR++ sees their companies'.
Administrators see all. Confidential never applies here (an incident that
needs HR goes to Ask HR or a confidential ticket; the form can say so).

**Review.** Reviewed and Needs Follow-Up are states with a note; both notify
the submitter by bell. "Make a Ticket" and "Make a Task" prefill title,
body (the answers as text) and attachments through the existing create
calls and store the link on the entry. Nothing changes state by itself.

**Where it lives.**
- Documents > Forms tab: templates (Build, Publish, Preview, Duplicate,
  Archive) and Entries (filters: form, site, status, date, person; side
  panel with the answers, photos, map link, review controls, Make a Ticket /
  Task, PDF, "Open in Reports" style CSV export per template).
- Workday: a Forms tile ("Fill a Form", the forms this person may fill,
  grouped by category) beside Ask HR, Reimbursements and Purchase Requests;
  deep link `form:<templateId>`.
- My Shifts: a button on the shift card when a form has `show_on_shifts` for
  that site.
- The + menu (`quickCreate` item, module `myhr`) and the Quick Actions dock
  (`fill-form`).
- Insights: a Forms block (entries in the last 7 days, Needs Follow-Up open,
  by template) drilling to the list.

**Workflows.** Pack `workflows/packs/documents.py`: entity `form_entry`,
events `form.submitted` and `form.reviewed`; `extra` carries the answers
flat (`{"form": title, "<token>": value, ...}`) so a condition can read
`event.injury`. The lock file is regenerated.

**PDF and export.** `form_entry_pdf.py` (reportlab, the Documents letterhead
chain): title, submitter, time MM/DD/YYYY 12-hour, site, then sections with
label and value rows, photos as thumbnails, the signature image, the map
link. CSV per template: one row per entry, one column per token (repeat
groups joined), with the photo URLs.

**Phone fill.** `forms/FillForm.jsx`: one screen, sections as headings,
`TypedFieldInput` for the known types plus the new inputs, required and
format checks inline, `showIf` evaluated live, formulas read-only, photos
uploaded as taken with progress, a localStorage draft per template keyed on
`entry_key` (offered back on return: "You have an unsent Vehicle Check from
11/02/2026 2:14 PM"), Submit sends once (`entry_key`), then "Sent" with a
link to the entry. 16px inputs on phones, keyboard strip clearance through
`useVisualViewport`, Ctrl+V paste on the web.

## Constraints

- American English, MM/DD/YYYY, 12-hour, Title Case titles, no em dashes.
- Shared files append only; both migration lists; RLS; `get_advisors`.
- Never block on the event loop; file checks through `_validate_photo_url`.
- The template manager rule stays `_require_template_manager`
  (administrators all; managers their own department).

## Left to the builder

Exact field editor layout inside the existing template panel, the CSV
column order, the Insights card wording, the map link provider (reuse
`maps_link.py`).
