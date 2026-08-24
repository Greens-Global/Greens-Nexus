# Call with Charmi Desai - Aug 21, 2026 (31 min) - Action Plan

> Implementation status (Aug 24, uncommitted on the working tree):
> DONE: #1 partial-day PTO, #2 break punch-pair display, #3 root-caused (silent
> unended-break deduction) + fixed via #4/#5, #4 missing_break_end/long_break
> flags (blocking exceptions), #5 break policy engine (CA paid rest breaks,
> admin toggle, per-rule), #6 verified already present (Hrs/day rollup +
> expanders), #7 "Location off" called out on the timecard (recording model was
> already built), #8 time-tracking-exempt flag end to end, #9 OUTBOUND
> QuickBooks IIF export, #10 employee code editable in the People form.
> ALSO: coverage screen "Chrome share" mislabel for agent-covered people fixed
> (heartbeat is now the authority - Aug 24 screenshot).
> NOT BUILT: #9 inbound QuickBooks accrual balances (needs QuickBooks Online
> API credentials + decision), #11 mobile app, labor compliance agent.
> RELEASE NOTES: run the two time_off_requests ALTERs + payroll_rates ALTER on
> dev/prod before deploy (both migration lists updated); CA paid breaks ships
> OFF - enable from the timecard toolbar when Charmi confirms the policy.

Source: "Call with Charmi Desai.docx" transcript (Teams recording, 08/21/2026).
Theme: Time Clock accuracy + payroll readiness. Context: SwipeClock parallel run
is still payroll truth; Neil wants SwipeClock off in ~1 month. Charmi runs
payroll next week and says Nexus hours are NOT usable yet. Goal she set: one
full pay period where Nexus data is 100% accurate and drives payroll.

## 1. Partial-day time off requests (hours, not just days)

Charmi tried to request 2 hours off in the morning (doctor's appointment) and
could not - Request Time Off only supports full days. The old Shifts app
supported hour-level requests.

- Add start/end time (or hour count) to the time-off request form + approval
  flow + calendar/timecard integration.

## 2. Breaks must appear on the timecard as punch pairs

My HR timecard does not show break detail. SwipeClock shows each break as an
out-punch and an in-punch (e.g. in 8:25, out 12:10 lunch, in 1:10, out 5:35 =
two 4-hour segments). Charmi wants the same in Nexus: every break start/end
renders as its own out/in punch row so the day reads as segments.

- Show break punches inline in the My HR timecard (and payroll views).
- Keep the "punch from button press" records (Aug 11 work) consistent with this.

## 3. Hours calculation bugs - investigate before next payroll

Two concrete examples from the call (employee Ashley/Aarav, week of 08/10-08/14):

- 08/14: clocked in 8:45, out 5:30, timecard shows 4h40m (should be ~7-8h).
- Another day: in 8:40, out ~5:40 (9h span), shows 7h55m.

Likely interacting with break logic and/or the 16h pairing guard. Reproduce
with real dev data, fix, and re-verify the whole week against SwipeClock.

## 4. Missing-punch detection for unended breaks

If someone starts a break and never ends it but does clock out for the day,
Nexus currently just closes the day silently. SwipeClock flags it as "missing".

- Flag a break with no end (or any un-paired punch) as MISSING on the timecard.
- Employee can edit the missing punch with a note; supervisor approves
  (self-service edit flow from Aug 3 exists - wire it to this flag).

## 5. Break/meal policy engine (California first, per-region)

Charmi sent the exact policy in chat (check Teams). Summary from the call:

- California hourly: paid 10-minute rest break per work period
  (<3.5h none; 3.5-5h one; ~8h day = two 10-min paid breaks) + one unpaid
  30-min meal break. Time beyond the allowed break length is UNPAID.
- Greens' own policy: 9-hour shift (8:30-5:30), 1 hour UNPAID lunch (they may
  take up to 1h; any length of lunch is unpaid), plus the paid 10-min breaks.
- Anything over 8h/day is CA overtime - the unpaid hour keeps the day at 8h.
- Policies must be per-region: a California policy, an India policy, and
  extensible per-state. India team works different hours/overtime - verify
  their calculations separately.
- Future idea (Neil/Charmi): a "labor compliance agent" that reviews policy
  changes monthly. Not now - note only.

## 6. Daily total rollup ("the arrow")

SwipeClock shows a collapse/expand arrow with the day's TOTAL across multiple
punches, so nobody hand-sums 15 punches. Add the same daily-total rollup row
per day in the timecard. Visesh committed to this on the call ("I'll do that").

## 7. Geofencing on punches (record, don't block)

Not just an alert. SwipeClock model Charmi showed:

- Always ALLOW the punch, but stamp each punch with location vs. the fence:
  green icon = inside fence, out-of-fence = flagged on the timecard so the
  reviewer can judge validity.
- Red slashed icon = employee had location sharing turned OFF; record that
  state explicitly. Policy (management side): location off = punch may not
  count.
- Show a map/address (Google) with date/time per punch - useful and accurate.
- Practical mandate: field/construction staff punch from their phone (laptop
  punches give junk locations / false positives).

## 8. Hourly vs. salaried (exempt) flag

Salaried/exempt people (Charmi, principals) should not see "you worked X hours
this week" on My HR / dashboard, and should be exempt from time tracking.

- Add an hourly/salaried (time-tracking exempt) flag on the employee record.
- Hide hours widgets + time clock surfaces for exempt users.

## 9. QuickBooks integration

Two directions:

- INBOUND balances: vacation/sick accrual (accrued this period, used, balance)
  from QuickBooks into My HR so employees self-serve instead of reading pay
  stubs or calling Charmi. (Accrual starts after 1 year of employment.)
- OUTBOUND hours: export the Nexus timecard in QuickBooks IIF format (not CSV)
  so Charmi can import instead of keying hours per employee manually.

## 10. Employee codes

Replace/align Nexus employee codes with the existing (QuickBooks/SwipeClock)
employee codes so systems match. Small, but Charmi called it out explicitly
and Visesh said he'd batch it with this pass.

## 11. Mobile app (phase-next, delegate)

Both agree the real fix for location games is a simple app (HR + time &
attendance only). Charmi: don't take this on personally - delegate/build out.
Planning note only for now (Capacitor plan from Jul 8 exists).

## Sequencing suggestion

Payroll accuracy is the gate (Charmi needs one clean pay period before
SwipeClock can be turned off):

1. #3 calculation bugs, #2 break punch pairs, #4 missing-punch flag,
   #6 daily rollup - the "timecard is trustworthy" batch.
2. #5 policy engine (CA policy Charmi sent) + #8 exempt flag.
3. #1 partial-day PTO, #10 employee codes.
4. #9 QuickBooks (IIF export first - it removes manual keying), then inbound
   accruals.
5. #7 geofencing recording, #11 app - larger, schedule separately.
