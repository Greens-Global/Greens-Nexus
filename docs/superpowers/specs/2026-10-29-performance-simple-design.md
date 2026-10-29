# Performance, Made Simple - Design (Oct 29 2026)

Neil, 10/29/2026: "I like most of what you're presenting but I think this really needs to be easy and it needs to provide some real metrics from Nexus. Just make sure this is as simplistic as possible." Earlier: "We need to have a solid PR system that really sets goals." "What should the employee get and what should their manager get."

Nothing in the current Performance tables has been used (dev: 0 rows in all 8 `hr_perf_*` tables, no settings saved), so the schema may change freely. Never drop a table or column: add, and stop reading what is no longer used.

## The idea

One page per person, made of three things, the same for the employee and their manager:

1. **My Numbers** - an automatic scorecard from what Nexus already records, for a period (this month, this quarter, the review period). Nobody types it.
2. **My Goals** - 3 to 5 goals. A goal can be measured BY one of those numbers (it updates itself) or tracked by hand.
3. **My Review** - twice a year, one short form that shows 1 and 2 beside it.

1:1s stay as they are (bugs fixed). No AI anywhere (AI is off in Nexus - `ai_switch.py`).

## 1. My Numbers (the Nexus scorecard)

Backend: new `backend/perf_metrics.py`, ONE function every screen and the review read:

`scorecard(db, email, start: str, end: str) -> dict` (ISO dates, inclusive) returning
`{"period": {"start", "end"}, "metrics": [ {key, label, value, display, unit, good: "high"|"low", detail, source, available} ]}`

Metrics (a metric that does not apply to the person - no shifts, no tickets - comes back `available: false` and is hidden; never guess):

| key | label | from (reuse the existing calculation - never a second one) |
|---|---|---|
| `on_time` | On-Time Arrival | `shift_attendance.actuals` (On Time / Late / No-Show / Excused per person-day): on time / (on time + late + no-show) |
| `no_shows` | No-Shows | same `actuals` |
| `hours` | Hours vs Expected | the Workforce Scorecard's per-person numbers (`workforce_scorecard`, punched vs expected) - hourly staff only |
| `timesheets` | Time Sheets Signed On Time | timesheet review / Nexus Sign rows for periods ending in the range |
| `tasks_done` | Tasks Completed | tasks assigned to the person completed in the range |
| `tasks_on_time` | Tasks On Time | of those with a due date, completed on or before it |
| `tasks_overdue` | Overdue Tasks Now | open, past due (point in time, "today") |
| `tickets_resolved` | Tickets Resolved | tickets assigned to them resolved in the range (desk people only) |
| `ticket_sla` | Replies Within Target | first-response SLA met % from the ticket SLA fields (desk people only) |
| `training` | Required Training Done | assigned required courses / policies complete vs assigned (KB training + policy sign-offs) |

Privacy: time off, sick days, leave, pay and HR tickets are NEVER metrics. Only the person, their reporting chain and HR (`performance.hr_reach`) can read a person's scorecard.

Route: `GET /performance/scorecard?email=&start=&end=` (default: the current calendar quarter). Cached per (email, start, end) for 10 minutes.

## 2. Goals

Keep `hr_perf_goals`, add columns: `metric_key` (one of the keys above, '' = by hand), `period_start`, `period_end` (the goal's period, defaults to the current review period or the next 6 months), `approved_at`, `approved_by`.

- A goal = title, target, due date, and EITHER "Measured by Nexus: <metric>" (target like 95 for On-Time Arrival; progress = the scorecard value over the goal's period, refreshed when read and by the daily loop) OR "I'll update it" (percent / number / done, as today).
- Status is computed, never picked: Done when the target is met; otherwise On Track / At Risk / Behind from progress vs time elapsed in the goal's period (`expected = elapsed share`; >= expected -> On Track, >= 0.7x -> At Risk, else Behind). For "Overdue Tasks Now" / "No-Shows" style metrics (`good: low`), met = value <= target. The old hand-picked status is ignored (keep the column).
- Max 5 open goals per person per period (server-enforced, a clear message).
- An employee's own goal is "Proposed" until their manager (or HR) clicks Approve; a goal the manager or HR adds is approved at once. Proposed goals still track.
- Manager can add one goal to several direct reports at once (same title/metric/target) - one row each.
- Check-ins stay for by-hand goals (one tap: new value + optional note). Nexus-measured goals need none.
- Company / department goals stay optional "Supports" parents (as today). Archived goals reachable from a "Show Archived" toggle.

## 3. Reviews

Keep `hr_perf_review_cycles` / `hr_perf_reviews`, simplify:

- **HR creates a cycle with 3 fields:** Name ("2026 Year-End Review"), Company, Due Date. Period defaults to the last 6 months ending today (editable). Everyone active at that company who is past probation and not a contractor/external/guest is in it; people who join that company before it closes are added automatically; HR can remove someone.
- **One form, the same for both sides**, with the person's scorecard for the cycle period and their goals for it (with results) shown beside it:
  1. What went well?
  2. What could be better?
  3. What should the focus be next? (the manager can turn this into next period's goals with one click - "Make This a Goal")
  Manager only: each goal scored Met / Partly Met / Not Met, and one Overall Rating: Exceeds / Meets / Partly Meets / Below (4 words, no numbers; stored as keys `exceeds|meets|partly|below`). Optional "Ready for Promotion" checkbox. Optional private note to HR (visible to HR only - fixes the skip-level leak).
- **Stages (4):** Self Review -> Manager Review -> Ready to Share -> Shared (then Acknowledged when signed). The self review is optional for the manager to proceed: once the due date passes, or as soon as the employee submits, the manager can write theirs.
- **HR:** a progress table for the cycle (person, manager, stage, rating), "Share All Ready" in one click (and per person), Return to Manager, Remove From Cycle, Close (only when nothing is left mid-way, or after confirming). A read-only rating count line ("Exceeds 3 - Meets 21 - Partly 4 - Below 1") per company - that is all the calibration we build.
- **Employee** reads the shared review and clicks Acknowledge (Nexus Sign, they are the only signer, as today) with an optional comment box ("Your Comments") saved on the review and printed on the PDF.
- **Reminders (automatic, server-side, bells via `notify_rollup`, batched):** at launch to each employee and manager; 3 days before due; on the due date to whoever still owes; when shared, to the employee. Waiting reviews and proposed goals register an `@source` in `approvals_inbox.py` so the badge counts them.

## 4. Who sees what

| | Employee | Manager (direct reports) | Manager's manager | HR |
|---|---|---|---|---|
| Scorecard | own | yes | yes | yes |
| Goals | own: add (Proposed), update by-hand | add (approved), approve, edit, add to several | read | all |
| Self review | write own | read after it is submitted | read after shared | read |
| Manager review | read once Shared | write | read | read, return, share |
| Private note to HR | - | write | - | read |
| 1:1s | as today | as today | - | - |

## 5. Screens

- **Workday > Performance (everyone):** one page: My Numbers (a row of metric tiles for the chosen period: This Month / This Quarter / This Review), My Goals (cards with a progress bar, computed status, target, "Measured by Nexus" chip), My Review (only while a cycle is open or a review awaits acknowledgment; plus Past Reviews), My 1:1s. Phone-first.
- **Workday > Performance > My Team (managers):** a table of direct reports: name + photo, 2-3 key numbers, goals (on track / at risk / behind counts), review stage, "Approve" chip when they have Proposed goals. Click a row -> that person's page (the same page the employee sees) with Add Goal, Approve, Write Review.
- **People > Performance (HR):** Review Cycles (New Review Cycle = the 3 fields; open a cycle = the progress table), then Company and Department Goals (as today), then Everyone's Goals (Behind and At Risk first). Filters only above the list they filter.
- **People > a person's profile:** a Performance section: their scorecard (this quarter), current goals, past reviews (with the signed PDFs).
- **Settings > Performance:** ONE group with one setting: goal check-in reminder days (default 14). Reviews no longer use the 1-5 Rating Scale or Company Values (the stored settings stay, unread). Fix `needs` to match the route (Full HR grant).

## 6. Fix regardless

- The private note to HR reaches only HR.
- Reassigning a reviewer notifies them, and the review shows in their list even if they have no reports.
- "Cancel This One" on a 1:1 also cancels that Teams occurrence; an ended 1:1's agenda and actions are read-only.
- Remove the fake "People Sub-Application ... Micro-App Handshake Established" page an unknown People address shows; an unknown sub goes to the module's first tab.

## Out of scope

Weights, key-result trees, 360/peer reviews, 9-box, calibration moves, PIPs, pay changes, AI.

## Copy

Title Case labels, sentence-case help text, "Time Sheet", MM/DD/YYYY, 12-hour times, American English, no em dashes. The tour and the Help Center guide (`support/docsContent.js` Performance sections) are rewritten to match.
