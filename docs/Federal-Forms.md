# Federal Forms in Nexus Sign (W-4, I-9, Direct Deposit)

Neil, 11/02/2026: "I want the W-4, I-9, direct deposit done, not just
written ... it needs to be compliant and correct, constantly."

## What it is

Three forms a new US employee fills and signs in Nexus Sign, from the hiring
packet or sent one at a time from the person's record:

| Form | Edition in Nexus | Who fills | Expires |
|---|---|---|---|
| Form W-4 (Employee's Withholding Certificate) | 2026 (IRS, released 12/11/2025) | The employee | 01/31/2027 - the IRS issues a new one most years; January is the grace month (Neil, 11/02/2026) |
| Form I-9 (Employment Eligibility Verification) | 01/20/25 (USCIS) | Section 1 the employee, Section 2 HR | 05/31/2027 (printed on the form) |
| Direct Deposit Authorization | v1 (ours) | The employee | never |

The official PDFs are bundled in `backend/federal_forms/pdf/` with their
source URL and SHA-256 in `registry.py`. The fields are read from each
PDF's own fillable layout (`maps/*.json` names every widget we use), the
widgets are stripped, and Nexus Sign draws the typed answers onto the flat
page. Nothing is re-typeset, so the signed PDF is the government form.

## Compliance rules built in

- **Editions are pinned.** `federal_forms/editions.py` knows each edition's
  last valid day. Sending a lapsed edition is refused with "The Form I-9
  edition in Nexus (01/20/25) expired on 05/31/2027. Ask an administrator to
  update it before sending." HR contacts and administrators get one bell 60
  days ahead ("Form I-9 Edition Expires 05/31/2027"), the W-4 bell on
  12/01 ("2027 Form W-4 Due In January"), and one when sending pauses.
  Settings > Hiring & Onboarding > Federal Forms shows each edition's state.
- **Answers are checked** (`federal_forms/formats.py`, `rules.py`): SSN
  (9 digits, no 000 / 666 / 9xx area, no 00 group, no 0000 serial), ABA
  routing checksum, account 4 to 17 digits, exactly one filing status,
  exactly one citizenship status with its matching number, Section 2 = one
  List A document or one List B plus one List C with title, authority,
  number and expiry (N/A allowed), the first day of employment.
- **I-9 timing.** Section 1 on or before the first day (the packet goes out
  before the start date). When the employee signs Section 1, HR gets "I-9
  Section 2 Due MM/DD/YYYY" = start + 3 business days (company holidays
  skipped); the checklist item ON-23 carries the same due date and its
  reminders. Section 2 is a live HR signature, never a saved one.
- **Sensitive values** (SSN, routing and account numbers) are encrypted at
  rest (`secret_box`), shown masked to every other party (`***-**-1234`,
  `••••4321`), never in a bell, email, log or on the person record, and
  printed only into the sealed PDF. That PDF is restricted: Pay & Benefits
  holders only, never emailed as an attachment, every open written to the
  envelope's audit trail (`viewed_final`). The direct deposit answers (bank,
  routing, account, type) do land on the person's Bank card after signing,
  as every hire's bank details do (hr_comp gated); the SSN never does.
- **Retention.** The sealed PDF files to the person's Egnyte folder under
  "Tax and Payroll Forms" (W-4, direct deposit) or "Form I-9". Keep I-9s 3
  years after hire or 1 year after separation, whichever is later; W-4s 4
  years. Nexus keeps the envelope; HR exports from Egnyte.
- **Not built:** E-Verify and the remote document examination alternative
  (only for E-Verify employers), state withholding forms, Supplement A/B
  (reverification). Ask Neil before adding any of them.

## Where it shows up

- **Hiring packet** (Settings > Hiring & Onboarding > Packets, Documents
  step): "Federal Forms" checkboxes for a US employee packet. The forms are
  appended after the packet's documents in the same envelope; the person
  signs first, HR second (an HR sign step is added when the flow has none).
- **Person record > Documents > Send Federal Form** (HR++): one form at a
  time, to the person's work email.
- **Checklist:** ON-05 ticks when both the W-4 and the direct deposit are
  signed, ON-18 when Section 1 is signed, ON-23 when Section 2 is signed
  (or an ID is on file, as before).
- **Bells:** accounting owner gets "W-4 Signed - <name>" / "Direct Deposit
  Signed - <name>" linking to the person's Documents tab.

## Updating an edition (once a year for the W-4, when USCIS revises the I-9)

1. Download the new official PDF into `backend/federal_forms/pdf/` and
   record its source URL and SHA-256 in `registry.py` (bump `edition`,
   `editionLabel`, `expires`).
2. Run `federal_forms.check_map(kind)`; every map key must find its widget.
   If the IRS or USCIS renamed or moved a field, fix `maps/<kind>.json`.
3. Run `backend/.venv/bin/python -m pytest test_federal_forms.py` and
   `test_federal_forms_packets.py` (one file per process).
4. Release. Envelopes already sent keep the edition they were built with.
