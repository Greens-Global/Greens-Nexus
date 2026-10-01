# Call with Charmi - 09/30/2026 (12 min, 17:36 UTC) + Shifts QA vs Teams

Source: Teams recording "Call with Charmi Desai-20260930_230627" (transcript with
speakers + 14 on-screen frames), read 10/02/2026. Neil's follow-up in chat:
"you need to complete QA on shifts. it's still a huge mess compared to shifts
in Microsoft." Everything below is tied to the code on `main` (f4df5384) and
to PROD data read through SQL (read-only).

Status key: ☐ not started · ◐ partly done · ✅ done

---

## Part A - What Charmi asked on the call

### A1 ☐ Punch rounding is a company setting, off by default
- Said (0:03): a global settings option per company, off by default, an
  admin turns it on if the company has a rounding policy.
- Today: one key `timeclock_rounding` in `nexus_settings` for the whole
  tenant; toggle lives inside the Payroll timecard's Options popover
  (`PayrollTimecard.jsx:662-668`, `PUT /payroll/rounding` `timeclock.py:6390`).
  PROD value: enabled=true, nearest 5 (set by Charmi).
- Change: move the switch to Settings > Company Settings (per `hr_entities`
  company), default OFF for a new company, keep the current PROD value for
  Greens so SwipeClock parity does not break. Remove it from the timecard.

### A2 ☐ No pay or OT controls on the timecard
- Said (0:23): "this OT rule California / Federal ... is very scary. This
  should never be anything to change on the time part. This should all be
  linked into their individual people module."
- Today: the Payroll toolbar has an OT rule dropdown + "Rate $/hr" input +
  Save (`PayrollTimecard.jsx:687-702`) writing `PUT /payroll/rate`
  (`timeclock.py:7143-7175`), which then mirrors into Pay & Benefits
  (`sync_comp_from_rate`). Two write paths for one fact.
- Change: delete the toolbar controls and the client call. Pay & Benefits
  (`HR.jsx` CompensationModal, `hr.py:3323 save_compensation`) becomes the
  only writer; `PayrollRate` is derived. The fields that only exist on
  `PayrollRate` need a home there: `overtime_rule` (should follow the
  company's state / country, not be typed per person), `pay_type`,
  `weekend_ot_amount` (goes away, see A5), `full_day_hours`,
  `time_tracking_exempt`. Timecard keeps a read-only "Pay rate / OT rule"
  line (`PayrollTimecard.jsx:710-720`).

### A3 ☐ Pay history with effective dates, priced per day
- Said (0:53-1:38): "if I change his pay here it needs to keep this history
  ... this change happened as of this date ... a raise mid-month should
  automatically apply on the day that it's effective."
- Today: `nexus_employees.compensation.history` gets an auto snapshot of the
  PRIOR base on every change (`hr.py:3333-3342`) and the modal lists it
  (`HR.jsx:5051-5061`), but the Pay & Benefits tab itself (`HR.jsx:1178`)
  shows only the current base + one Effective date (Arnav: 12/26/2025).
  `PayrollRate` is one row per person, "corrections just overwrite"
  (`models.py:2387`), and both cards read it once for the whole period
  (`_fixed_card` `timeclock.py:6141-6142`; hourly card same) - so a raise
  effective 10/15 re-prices all of October, and a finalized month is only
  safe because of the finalize-time snapshot.
- Change: compensation = ordered list of {base, basis, currency, frequency,
  effectiveDate, changedBy, changedAt}; a "New rate effective MM/DD/YYYY"
  action instead of overwriting; the timecard prices EACH DAY at the rate in
  effect that day (period split line on the card: "through 10/14 at X, from
  10/15 at Y"); History table on the Pay & Benefits tab.

### A4 ☐ India daily rate = annual pay / working days
- Said (3:52-4:33): "it's not divided by 22 ... you do it over a 365 day
  period and you take all the weekends out ... 261 working days, 104 weekend
  days ... monthly pay times 12 divided across this." "Let AI give you the
  right formula so it's honest."
- Today: `daily = monthly_salary / calendar-days-in-month`
  (`timeclock.py:6166-6167`), shown as "Daily: ₹1,000.00 (30d)".
- Change: `daily = monthly_salary * 12 / working_days_in_year`, where
  working days = days in the year minus Saturdays and Sundays (261 in 2026;
  262 or 260 in other years - compute, do not hard-code). Open question for
  Charmi: are company holidays also removed from the denominator (they are
  paid days, so arguably not)? Show the formula on the card.

### A5 ☐ Weekend overtime is calculated, not typed per person
- Said (2:43-5:56): "that deal doesn't make sense ... 1.35 times a daily
  [rate] with a minimum of 500 rupees, whichever is higher ... weekend
  overtime should not be daily, it should be hourly ... it should not even
  be [configured], it should just be calculated. That's the India policy."
- Today: flat `PayrollRate.weekend_ot_amount` per person, added once per
  weekend day with any punch (`timeclock.py:6228-6231, 6255`); shown as
  "Weekend OT: ₹1,000.00/day".
- Change: remove the per-person amount. Weekend pay for a weekend day =
  max(₹500, 1.35 × daily × hours_worked / full_day_hours). Confirm with
  Charmi that "hourly" means pro-rata by hours (her two sentences point
  both ways); if she means a full 1.35 × daily for any weekend day worked,
  drop the hours factor. Policy flag per company (India policy vs US
  policy, which stays exactly as is: 1.5×/2× CA rules).

### A6 ☐ India attendance bands and month-end approval
- Said (1:42-2:40): salaried, not hourly; "did you come to your shift? ...
  if you did five hours you get half a day, if you did [full] hours you get
  [a full day] ... half an hour less we're not pinging, an hour extra we're
  not bonusing"; the month timecard is approved by their manager at month
  end "to keep it honest".
- Today: bands are 5h+ = full, 4-5h = half, under 4h = absent
  (`timeclock.py:6172`). That is NOT what she described (5h = half).
- Change: confirm the bands with Charmi (proposal: full = full_day_hours
  minus 1h tolerance, half = 5h up to that, absent below), make them a
  company policy setting next to A1, and make sure the monthly fixed card
  goes through the same timesheet review + Nexus Sign chain as the
  bi-weekly card (`timesheet_review.py`).

### A7 ☐ Accounting numbers: Inter + aligned parentheses (accounting only)
- Said (6:08-8:02): "put the correct font in accounting, Inter ... 100.00
  over 79.98 aligns perfectly ... I need you to fix that for accounting
  only ... the serif heading - if you hate it I'm not going to argue, but at
  least keep Inter for the numbers ... the parentheses pulled to the outside
  so numbers always line up ... 8 to 10 other small things in there."
  On screen: Income Statement, "(27,680.64)" vs "4,050.00" - the 4 and the 0
  do not sit on the same column.
- Today: the whole typography brief was applied 09/30 (main 30fbb674 ->
  7ac0b143) and REVERTED the same day at Visesh's request (main f947dc71).
  The `Amount` component, `.num` ghost `)` slot and tabular-nums CSS exist
  in git history.
- Change: re-apply ONLY the numbers part, scoped to `.acct-module`: Inter
  with `font-variant-numeric: tabular-nums`, every figure through
  `<Amount>`, the ghost parenthesis slot so negatives align with positives,
  right-aligned numeric columns. Leave the Caslon serif headings out unless
  Visesh wants them. Re-read her artifact for the "8-10 small things" (the
  list is in memory `project_call_charmi_sep29` under the typography note).

### A8 ☐ People > Time timecard: same number treatment, hover row, banding
- Said (8:14-8:40): apply the same concept to the People module time sheet;
  on hover the row highlights; Visesh: "green, and I'll put banding here".
- Change: tabular numerals + right alignment on Hours / Hrs/day / OT / Wage
  columns of `PayrollTimecard.jsx`; zebra banding on day rows; hover
  highlight (brand tint); keep the week-total band distinct.

### A9 ☐ People > Time header: drop the duplicate tiles, make the strip collapsible
- Said (9:18-10:50): the tiles "Punch flags" and "Time off pending" were
  static placeholders. Visesh offered "I'll make it clickable"; Charmi:
  "you should be removing it ... you already have Punch requests, Missing
  punches, Time off tabs ... then there's no point. That way we get a
  bigger screen. Screen real estate really matters. If you want analytics,
  put it on a different tab. This should be a collapsible item."
- Today: commit 97c18c44 (09/30, same day) went the "make it clickable"
  way: tiles renamed Team Hours / Timesheets to Review / Punch Exceptions /
  Time Off Pending, each opens its list (`TimeAdmin.jsx:457-490`). That is
  the path she rejected.
- Change: remove Punch Exceptions and Time Off Pending tiles (the tabs
  carry the counts as badges already, `TimeAdmin.jsx:506-510`); keep Team
  Hours + Timesheets to Review in a one-line strip that collapses (state
  remembered per user); move anything analytical to Workforce Analytics.

### A10 ☐ Shifts information architecture
- Said (10:54-11:50): "you put requests here, but you also have the
  workday and time off. I don't understand this ... leave shifts here and
  move requests and everything for the user to the other end. The request
  management should be here, I don't think the new request should be here
  ... and these settings should not be here, this should be in our global
  settings module."
- Today: Shifts tabs = My Shifts / Schedule / Requests / Presets & Groups
  (`views/Shifts.jsx:26-31`). Requests = employee's New Request chooser
  (`ShiftRequestsPage.jsx`, `ShiftSelfService.jsx`) + manager inbox
  (`ShiftRequestsInbox.jsx`) + the settings block at the bottom of that
  inbox (`ShiftRequestsInbox.jsx:183-219`: switches, team time zone,
  reminders, time-off reasons). Workday > Time Off is a second place to ask
  for time off.
- Change:
  - Shifts = Schedule + Requests (manager inbox only, with Time Off / Swap /
    Offer / Open Shift tabs and pending badges) + My Shifts.
  - Employee "New Request" (swap, offer, open shift, time off) lives in
    Workday, one place, with the time-off form it already has.
  - Shift settings -> Settings > Company Settings: a "Shifts" section with
    the switches, team time zone, reminders, time-off reasons, presets and
    groups (`AdminConsole.jsx` GLOBAL_SECTIONS / company tab). Presets &
    Groups tab goes away from Shifts.
  - PROD fact: `shift_requests_config` has openShifts, swaps and offers
    all FALSE (saved by Visesh 09/30 17:15 UTC, 20 minutes before the
    call). That is why "swap is gone" on prod - a switch, not a bug. Decide
    the intended state.

### A11 "Shifts is still really messy ... you need to work that UI" -> Part B.

---

## Part B - Shifts QA against Microsoft Teams Shifts

Backend = `backend/routers/timeclock.py` (TC), `backend/routers/shift_requests.py`
(SR), `backend/shift_notify.py` (SN), `backend/models.py` (M). Frontend under
`frontend/src/components/`. Most severe first inside each group.

### B1 Data model gaps that cause most of the "mess"
1. ☐ Shifts do not belong to a scheduling group. `ScheduledShift` has no
   `group_id` (M:2313-2352); groups are only member lists. So: one global
   Open Shifts row (`ShiftSchedule.jsx:787-831`), open shifts vanish under a
   group filter (218-220), day notes are company-wide only (223), "publish
   this group" is really "these people's shifts" (TC:5858-5864), no hours
   per group, groups sort alphabetically (TC:4449, 4813), and ANY employee
   can request ANY open shift company-wide (SR:261-283, 331-334). Fix: add
   `group_id` to `scheduled_shifts` (+ both migration lists), `sort_order`
   to `shift_groups`, key open shifts and notes by group.
2. ☐ Activities have no paid/unpaid flag and do not drive the break.
   `activities_json` = [{start,end,label}] (M:2347); `break_min` is a
   separate integer kept by hand (M:2345; CellModal `ShiftSchedule.jsx:
   1705-1722`, BreakField 1590). Teams: hours = length minus unpaid
   activities, block shows "Lunch 30m". PROD: GSV/GSE/GST presets carry
   break 60 + a Lunch activity, GSM has break 0 - hours differ by preset for
   no reason. Fix: `paid` per activity, derive unpaid minutes in
   `_clean_activities`, render "Lunch 30m" on the block.
3. ☐ Time zone is never stored on the placement; it is inherited from the
   preset at read time (SR:93-96), 479 PROD rows have no preset and fall to
   the team zone, and editing a preset's zone moves every placed shift's
   reminders and "today". PROD: preset "India Admin Team" is 18:30-02:30 in
   America/Los_Angeles beside Asia/Calcutta presets, so reminders fire at
   7 AM IST. Fix: copy `timezone` onto `scheduled_shifts`, show it in the
   grid header and as a chip when a shift's zone differs
   (`MyShifts.jsx:181-185` labels the zone only when all shifts share one).

### B2 Correctness bugs (backend)
4. ☐ No row lock on approve/assign/publish. SR:490-525 `decide` -> `_apply`
   (SR:455) decrements `open_slots` and inserts an assigned row without
   `with_for_update()`; same in TC:5091-5138 `assign_open_shift`, SR:393
   `respond`, TC:5832 `publish_schedule` (double bells). Two approvals of
   the last slot both pass. Fix like `PunchRequest` at TC:2508.
5. ☐ Publishing an edit or removal never cancels pending swap/offer/open
   requests on that shift (TC:5832-5924 does not touch `ShiftRequest`),
   although M:4525 promises it; the request stays in the inbox until a
   manager declines and `_apply` 409s. Fix: cancel + bell the requester.
6. ☐ No HH:MM validation on writes. `_check_span` (TC:4329) only rejects
   start == end; create/update/bulk/move/copy store `start_hhmm[:5]`
   verbatim; import accepts "9:00" unpadded (TC:5681). Unpadded values
   break overnight detection (`end < start`), ordering and `_interval`.
   Fix: apply `_HHMM_RE` (TC:4591) everywhere, zero-pad on import.
7. ☐ Duplicate placements are allowed. PROD already has exact duplicates
   (Pranshu and Sagar, 10/03, 18:30-02:30, twice each). Only import dedupes
   (TC:5651); create/move/bulk do not. Fix: 409 "already on the schedule"
   on same (email, date, start, end).
8. ☐ Time-off approval ignores the schedule (`decide_timeoff`
   TC:7925-7954): leave is approved over a published shift with no warning,
   and the shift stays. Fix: return conflicts in the decision (or 409
   unless forced) and offer to remove the shift.
9. ☐ Swap/offer approval re-owns a shift without conflict checks for the
   new owner and without clearing `pending_json` (SR:479-486), so a
   pre-swap pending edit is later published onto the wrong person. Fix:
   run `_shift_conflicts` for the new owner; transfer or clear the edit.
10. ☐ The schedule grid lists terminated/deleted employees as rows
    (TC:4794-4808 `NexusEmployee.all()` with no status filter; 13 of 69 on
    PROD are inactive or deleted) and bulk/copy place shifts on them. Fix:
    active + not deleted in read/bulk/import/create.
11. ☐ `move_scheduled` skips the open-shift ownership check (TC:5488 only
    scope-checks real emails) that update/delete/discard enforce
    (`_open_row_mine`). Fix: `_row_in_scope` at the top of move.
12. ☐ Manager Time Off list is capped at 300 rows with no paging (TC:7912).
    PROD has 797 rows, so 497 never return and the screen silently shows
    nothing before 07/04/2025. Fix: paginate + `total`.
13. ☐ "1/2 Day" is a time-off type on 34 PROD rows but in neither
    `TIMEOFF_TYPES` (TC:7549) nor `_TIMEOFF_DEFAULT_REASONS` (TC:7558);
    `_check_timeoff_type` is case-sensitive (TC:7577). Fix: seed it, compare
    case-insensitively.
14. ☐ Duplicate time-off requests: `request_timeoff` (TC:7807) and
    `on-behalf` (7846) never check for an overlapping pending/approved row
    (copy does, TC:5325), and each one bells manager + HR contact + every
    owner. Fix: 409 on overlap.
15. ☐ Deleting a group orphans its day notes (TC:5534-5538) and
    `read_schedule` returns every note regardless of group (TC:4876-4879).
16. ☐ Reminders fire for shifts marked for removal and use the OLD times
    for pending edits (SN:229-232, 248), keyed `shift-reminder:{id}` so
    they cannot resend after publish. Fix: skip `pending_delete`, key on
    published start.
17. ☐ `update_scheduled` is a full replace: omitted `label`/`note` are
    wiped (TC:5750-5751). Treat `None` as "leave as is" like activities.
18. ☐ Conflict detection only looks inside the requested range
    (TC:4863-4874), so an overnight shift the day before the week is never
    seen to overlap Monday; `check_scheduled` (TC:4890) does look a day
    either side, so the dialog and the grid disagree.

### B3 Correctness bugs (frontend)
19. ☐ Partial-day time off wipes a teammate's whole day. `TeamShiftGrid.
    jsx:188-196` renders `d.off` INSTEAD of the shifts and drops them from
    the headcount and hours (70-72); root cause: my-schedule sends team time
    off with dates only (TC:5005-5011, no startTime/endTime). Amy with a
    9-5 and a 2-4 PM appointment shows off all day, the day loses 8 h.
20. ☐ Three grids, three time-off rules: manager week grid hides the
    time-off card when a shift exists (`ShiftSchedule.jsx:888, 901`), Day
    view shades under the bar (1213-1216), TeamShiftGrid hides the shift
    (19), MyShifts shows both (244-273) but its glance tile drops the day's
    shifts for ANY approved time off (`MyShifts.jsx:142, 149`). Teams: time
    off is always its own block beside the shift. One rule everywhere.
21. ☐ Requests page hangs on a skeleton forever when the API fails
    (`useShiftRequests.js:14` nulls data; `ShiftRequestsPage.jsx:76-77`);
    schedule load failure looks like an empty schedule with Publish/Fill/
    Copy still offered (`ShiftSchedule.jsx:148, 835`); same in
    `ShiftsPanel.jsx:70-71` and `ShiftRequestsInbox.jsx:36`. Fix: error
    state + Retry through `AsyncState`.
22. ☐ A failed availability load can overwrite real availability:
    `MyAvailability.jsx:31` falls back to a blank week, Edit -> Save PUTs
    seven "Any time" rows over what was stored.
23. ☐ Managers on touch devices can only tap-to-edit: drag is mouse-only
    (`ShiftSchedule.jsx:496-530`), tools are opacity 0 until :hover (536,
    CSS 1042), the menu is right-click only (378-382). No Copy/Paste/
    Delete/Move to Open/Color/Add Time Off on a phone. Teams: long-press.
24. ☐ Week grid is not keyboard reachable: cells and chips are divs with
    onClick (879, 801, 910, 806); `ShiftMenu` has no focus trap or arrows
    (`ShiftScheduleExtras.jsx:268-291`). Day view already uses buttons.
25. ☐ "Copied - click any empty cell to place it" is false in Day view: the
    track click opens Add Shift and ignores the clipboard
    (`ShiftSchedule.jsx:717-725, 1178 -> 740`).
26. ☐ Open-shift Request buttons render on past days
    (`TeamShiftGrid.jsx:149-160`, `ShiftSelfService.jsx:126-134`); the
    server refuses them (SR:17-20, 275) so the user gets an error flash.
27. ☐ Dark mode: hardcoded chip colors (`ShiftSchedule.jsx:913-916, 811,
    891-896`, `ShiftScheduleExtras.jsx:313`, `TeamShiftGrid.jsx:191-195`,
    MonthView 1139) while the theme toggle is live.
28. ☐ Swap requests waiting on the teammate are invisible to managers:
    `inbox` lists `pending_manager` only (SR:433-436). Teams shows every
    request with its stage. Return `pending_peer` rows too.
29. ☐ Requests auto-cancelled because another request filled the slot are
    marked `cancelled` (SR:505-511) so the employee's history reads as a
    withdrawal; should be `declined` with the system reason.
30. ☐ Pending requests keep copied dates/times (M:4537-4542) never
    refreshed after the shift is edited and published (ties to 5).

### B4 Publishing and notifications
31. ☐ Publish has no date range: it publishes the visible view (in Day view,
    one day; `ShiftSchedule.jsx:267`) and counts only loaded shifts (261),
    so drafts outside the view are invisible. Teams "Share with team" picks
    a range and notify options and records "last shared". Fix: range inputs
    in PublishModal, server-side count of ALL unshared, persist last publish
    per group.
32. ☐ PROD has 239 drafts, 203 of them dated 2024 for 9 people (old Greens
    Global team, loaded 09/29). `publish_schedule` takes any range (TC:
    5841-5855, no cap) and `notify_published` would email "Your schedule
    was updated - 203 changes" for 2024. Fix: delete or silently publish
    the `teams-` drafts; cap the publish range (62 days like clear).
33. ☐ Publish notifications are never deduped (SN:171-177: a new
    `NexusNotification` per publish, same `ref_id`), against the
    one-notification-per-workflow rule. Five publishes = five bells and
    five emails per person. Update the unread row in place.
34. ☐ New-request bells go to the manager AND the HR contact AND every
    owner (TC:1582-1612, SR:244-257). Owners only when there is no manager
    and no HR contact.
35. ☐ Reminder scan runs three queries per candidate every 5 minutes
    (SN:251-260); preload clocked-in, time off and holidays once.
36. ☐ `copy_schedule` with `include_timeoff` copies Teams-style "Off" /
    "Holiday" / "Requested Off" rows forward as PENDING requests
    (TC:5295-5334) that managers must approve one by one; 554 of the 776
    loaded rows are those types. Default off in the UI, exclude day-off
    types.

### B5 UI gaps against Teams
37. ☐ No side-panel editor: every shift opens a centered modal that covers
    the grid (CellModal `ShiftSchedule.jsx:1673`, OpenShiftModal 1503,
    TimeOffModal); time off is reachable only from the menu or a footer
    link (1738). Teams: right-hand panel with a Shift / Time Off switch,
    grid stays visible.
38. ☐ Requests page is one flat list: no Time Off / Swap / Offer / Open
    Shifts tabs, no pending badge on the Shifts > Requests tab
    (`views/Shifts.jsx:26-31`; the count lives on the Schedule toolbar
    button 642-646), no detail view - a swap is one sentence
    (`ShiftSelfService.jsx:148-154`), the inbox shows `r.summary`
    (`ShiftRequestsInbox.jsx:104`), never both shift blocks or the
    teammate's acceptance as a visible stage. "My requests" is capped at 10
    (`ShiftSelfService.jsx:161`) inside an 8-week window
    (`ShiftRequestsPage.jsx:43-47`); the employee's own time-off requests
    never appear there although the empty state promises them (84).
39. ☐ Month view drops time off, holidays and open shifts, shows 3 names +
    "+N more", no add/drag (`ShiftSchedule.jsx:1109-1151`); Day view has no
    per-person hours or headcount (1156-1230); "usual hours" render only in
    Week (943-948).
40. ☐ Week starts Monday with no setting (`MyShifts.jsx:41`,
    `ShiftSchedule.jsx:89-94`, MonthView 1112, bulk TC:5171, availability
    M:4578), while Time Clock timesheets anchor on Sunday - "this week"
    means two ranges inside Nexus. Teams: configurable, default Sunday.
41. ☐ Group member picker is every employee as chips with no search
    (`ShiftsPanel.jsx:323-331`); schedulers and the open-shift assignee are
    native selects (345-350; `ShiftSchedule.jsx:1536-1539`). Use the
    curated people picker.
42. ☐ Export/import do not round-trip: export omits day notes, time off,
    holidays (`ShiftSchedule.jsx:461-484`); import headers have no
    activities or color (`shiftScheduleLib.js:81-86`).
43. ☐ No "last shared" marker, no unshared-change count across the whole
    schedule, no "undo changes" per edit (PROD: 1 unshared change today).
44. ☐ Badges never refresh without the manager's own action (inboxTick);
    every tab switch remounts and refetches (`views/Shifts.jsx:95-98`);
    the Requests page fires 5 calls for a manager; the schedule fetches the
    inbox twice (`ShiftSchedule.jsx:257` and `ShiftRequestsInbox.jsx:34`).
45. ☐ Hours: "Hrs" vs "hrs" (`ShiftSchedule.jsx:32`, `MyShifts.jsx:67`);
    7 h 45 prints "7.8" (Teams: "7.75 hrs"); group subtotals exclude open
    shifts while "Week:" includes them, no legend on "3 · 24 Hrs" (766).
46. ☐ Day headers show only "29 30 1 2 3" with no month cue across a month
    boundary (`ShiftSchedule.jsx:763`, `TeamShiftGrid.jsx:109`); Teams:
    "Mon 29 Sep".

### B6 Polish sweep (one branch)
47. ☐ Raw emails as fallbacks, no `useNameResolver`/`emailToName` anywhere
    in the module: `TeamShiftGrid.jsx:94, 175, 180`; `ShiftSchedule.jsx:224,
    232, 852, 1140, 1220, 1538`; `ShiftRequestsInbox.jsx:71, 140`;
    `ShiftSelfService.jsx:54, 151, 242`; `ShiftsPanel.jsx:78`;
    `ShiftScheduleExtras.jsx:65, 185`.
48. ☐ Nine private 12-hour formatters and ad-hoc `toLocaleDateString`
    calls instead of `lib/datetime.js` (`shiftScheduleLib.js:8, 49`,
    `TeamShiftGrid.jsx:28`, `MyShifts.jsx:42, 210`, `ShiftSelfService.jsx:
    13`, `ShiftRequestsInbox.jsx:17`, `ShiftScheduleExtras.jsx:12, 39, 296,
    336`, `ShiftsPanel.jsx:26`, `MyAvailability.jsx:11`, `ShiftSchedule.
    jsx:52, 64, 468, 596, 764, 1091, 1511, 1682`). Add formatHHMM /
    formatWeekday / formatMonthYear once.
49. ☐ Title Case on chips/status: "Requested off" (`ShiftSchedule.jsx:892,
    1215`; `shiftScheduleLib.js:59`), "Half-day holiday" (904), "All day"
    vs "All Day" (`TeamShiftGrid.jsx:195` / `ShiftSchedule.jsx:896`),
    "Limited availability" (869), "Request pending" (`ShiftSelfService.jsx:
    29`), "Waiting on your teammate" (143), "Open shift"
    (`ShiftRequestsInbox.jsx:16`), lowercase "Time off · vacation" (132),
    "Usual hours" (`MyShifts.jsx:255`), "Everyone else" / "No location set"
    (`ShiftSchedule.jsx:195, 203`).
50. ☐ One object, five names: presets are "Shifts" / "New Shift" / "Edit
    Shift" in `ShiftsPanel.jsx:161-164, 253` (collides with the placed-shift
    "Edit Shift" / "Add Shift" at `ShiftSchedule.jsx:1678`), "Shift preset"
    (1689), "Shift Type" (697-700), "usual hours" (859), tab "Presets &
    Groups". Use Teams' "Shift Type" everywhere; stale "Shifts > Manage"
    copy at `ShiftsPanel.jsx:339`.
51. ☐ MyShifts prints "Off" on a day with no shift (259) - reads as time
    off; Teams leaves it blank. "That Week" / "This week" under "None"
    (213, 218).
52. ☐ Dead/duplicate code: `DAY_LONG` and `GRID` rebuilt every render
    (`ShiftSchedule.jsx:602-603`); `RequestDialog` and `NewRequestDialog`
    are ~90 % the same form (`ShiftSelfService.jsx:40-105, 211-326`);
    `ShiftActions` guards on a `fromPreset` the API no longer sends (25);
    buttons without `type="button"` in every modal; index keys for groups/
    days/time off (`ShiftSchedule.jsx:755, 797, 838`; `MyShifts.jsx:245`);
    `_group_scheduler` branches in write routes are unreachable
    (TC:131-132 vs 5718-5721).
53. ☐ Indexes: only single-column indexes on `scheduled_shifts`
    (M:2320-2321); add `(employee_email, work_date)`. `read_schedule` loads
    the employee table twice plus every member and assignment row
    (TC:4794-4860); `my_schedule` calls `_scheduled_groups` twice
    (TC:4967, 5047).

### B7 PROD data to clean (needs Visesh's go-ahead, SQL is reversible by id)
54. ☐ 2 exact duplicate shifts on 10/03 (Pranshu, Sagar; one draft + one
    published each).
55. ☐ 239 drafts, 203 from 2024 (`teams-` ids, old Greens Global team) -
    delete or publish silently (B4-32).
56. ☐ Preset "Accounting Team" = 4:00 PM - 12:00 PM Asia/Calcutta (20 h,
    25 placed shifts, 3 assigned); preset "India Admin Team" 6:30 PM -
    2:30 AM in America/Los_Angeles (should be Asia/Calcutta?).
57. ☐ Teams-loaded time off: `created_at` = the start date, not the real
    request time (shows a wrong "requested on"); 554 of 776 rows are
    "Off" / "Holiday" / "Requested Off" / "Closed" and inflate every
    person's Time Off tally and history. Decide: keep as history but mark
    `source = teams` and exclude from leave counts, or map "Holiday" to the
    company holiday calendar and "Off" to nothing.
58. ☐ `shift_requests_config`: openShifts / swaps / offers all off (A10).

### B8 Tests to add with the fixes
59. ☐ Backend: concurrency on approve/assign (4), cancel-on-publish (5),
    HH:MM validation (6), duplicate placement (7), time-off vs shift
    conflict at approval (8), open-shift visibility by group (1), move
    ownership (11), list paging (12), inactive employees off the grid (10).
60. ☐ Frontend: any API failure path (zero `mockRejected` across the five
    suites today), partial-day time off in all three grids, mixed-zone
    grid, Day-view paste, TeamShiftGrid hours when someone is off, the
    10-item "mine" cap, Cancel request, inbox Decline for shift requests,
    touch and Tab-key navigation.

---

## Decisions needed from Charmi / Visesh before building
- A4: do company holidays come out of the working-day denominator?
- A5: weekend pay = 1.35 × daily pro-rated by hours, or 1.35 × daily flat?
  ₹500 floor per weekend day confirmed?
- A6: exact attendance bands (what counts as full, half, absent).
- A7: Caslon serif headings in Accounting - yes or no (numbers part is a yes).
- A10: should swaps / offers / open shifts be ON for Greens Storage?
- B7: how to treat the 554 Teams "Off / Holiday" rows in leave tallies.
