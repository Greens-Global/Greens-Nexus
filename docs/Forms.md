# Forms & Checklists

Neil, 11/02/2026: field forms live in the Documents module; crews reach them
from Workday, the shift card, the + menu and the Quick Actions dock.

## Build a form (Documents > Forms > Templates)

1. New Form: name, category (Inspection, Incident Report, Vehicle Check,
   Checklist, Safety, Other), who fills it (the company, one department, or
   one work site), and Show On Shift Cards if people scheduled at that site
   should see it under their shift.
2. Add Field: every Documents field type plus Photo (camera first on a
   phone, several), Location Stamp, QR Scan, Rating (1 to 5), Yes / No and
   Signature. A field can sit under a Section heading, show only when an
   earlier answer says so (Show Only When), be a Formula (the Tasks formula
   language over the other answers) or belong to a Repeat Group ("Add
   Another", up to a cap).
3. Preview opens the real fill screen without sending. Publish makes it
   fillable; an entry pins the version it was filled on. Edits after
   Publish show as "Changes" until you Publish again.

Who may build: administrators for every department, managers for their own
department (the same rule as document templates).

## Fill a form

- Workday > Fill a Form (the tile beside Ask HR, Reimbursements and Purchase
  Requests): the forms you may fill, grouped by category.
- My Shifts: "Fill <form>" under a shift when a form is on shift cards for
  that shift's site.
- The + menu and the Quick Actions dock: Fill a Form.
- Photos upload as you take them; a draft is kept on the phone and offered
  back if you leave ("You have an unsent Vehicle Check from 11/02/2026 2:14
  PM"); Send goes once even on a retry; after Send you can open the entry or
  fill another.

## Review entries (Documents > Forms > Entries)

- You see your own entries; a manager sees their reports' entries and the
  entries at their teams' sites; HR sees their companies'; administrators
  see all.
- Filters: form, site, status, dates, person. Columns resize and are
  remembered. Export CSV per form (one column per field; repeat groups
  joined with " | ").
- Open an entry: answers by section, photos, the map link, the signature,
  the review controls (Mark Reviewed, Needs Follow-Up with a note, Close),
  Make a Ticket / Make a Task (prefilled from the answers and linked back),
  Download PDF. Nobody reviews their own entry. The submitter gets a bell
  on Reviewed / Needs Follow-Up / Closed.

## Automate (Workflows)

Events `form.submitted` and `form.reviewed` on the Form Entry entity. The
answers ride on the event flat, so a condition can read `event.injury` and
a message can print `{{ event.odometer }}`. Example: when an Incident
Report says Injury = Yes, notify HR and open a ticket.

## Insights

The Forms card: entries in the last 7 days and Needs Follow-Up open (lights
Needs Attention), by form; drill to the list. Counts only, never answers.

## Rules the code keeps

- One template engine (`DocTemplate`, `doc_type = 'form'`), one field list,
  one audience rule (`backend/form_audience.py`, shared with announcements),
  one file path (`task-files/forms/<entryKey>/`), one automation path
  (`workflows.emit`). Nothing changes an entry's state by itself.
- Entries are their own table (`doc_form_entries`, RLS on dev and prod).
- Not built: offline sending (the draft survives, sending needs a signal),
  approval chains beyond Workflows, forms for people outside Nexus.
