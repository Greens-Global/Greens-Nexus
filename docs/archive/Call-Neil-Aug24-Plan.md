# Call with Neil Kadakia - Aug 24, 2026 (10 min) + Teams follow-up - Plan

Source: "Call with Neil Kadakia (1).docx" (Teams recording 08/24, 4:17 PM) and
the 10:33 PM Teams thread (Edgar/Kenny never clocked out). Theme: Time Clock
accuracy for the US/construction team + People-module add flow. Neil's closing
line: "spend some time on this and I need you to get this actually accurate."

## 1. Forgotten clock-outs: reminders + auto clock-out (the Teams thread)

Sahil reported Edgar and Kenny showing clocked in who never clocked out. Agreed
design in the thread (Neil + Visesh), refined with the industry standard:

**What the industry does** (Neil asked): every major system layers the same
four controls -
- Reminder notifications to the employee as the shift runs long
  (QuickBooks Time/TSheets model).
- An automatic close at a boundary - either a max shift length or a fixed
  time of day (ADP / UKG-Kronos "maximum shift" auto-punch, Homebase's
  close-of-business auto clock-out).
- The system-generated punch is FLAGGED as an exception and is NOT silently
  paid - a supervisor must set the real time before payroll (Kronos exception
  report, SwipeClock missing-punch model).
- An exception report / manager alert. No system silently pays through an
  auto-generated out-punch.

**Plan for Nexus** (fits what we already have):
- "Still clocked in?" alerts: 3 escalating notifications to the employee
  while a shift runs unusually long - e.g. at 1h past scheduled shift end
  (or 10h worked when no schedule), then 2h past, then ~11:30 PM local.
  Server-side, from the existing `long_session_loop` in main.py (bell +
  the toast channel; the UI banner at 12h already exists and stays).
- Auto clock-out at 11:59 PM local (per Neil): the sweep inserts an
  `out` punch at 23:59 employee-local time with `source='auto_eod'` and a
  note ("Auto clock-out - no punch-out recorded").
- PAY-SAFE RULE (the important part): a segment closed by an `auto_eod`
  punch is treated exactly like a missing punch - it shows "Missing" /
  auto-closed on the timecard, pays 0 until corrected, and BLOCKS
  approve/finalize like `missing_out` does today. The auto-out fixes the
  STATE (person shows clocked out, next morning's punch-in pairs cleanly,
  no 16-hour bridge risk) without paying phantom hours. This is exactly
  what Visesh proposed in the thread ("on the time sheet it'd show missing
  punch out").
- Major manager alert (Neil): when the auto-out fires, `_notify` the
  employee's manager: "X never clocked out - auto-closed at 11:59 PM,
  timecard needs a correction." (The existing missing-clock-out detection
  notification stays; this one fires at close time, loudly.)
- Employee correction path: the existing punch-edit/self-request flow fixes
  the real out time with a reason; supervisor approves.
- Config: store the alert offsets + auto-out toggle in a NexusSetting
  (default ON per Neil) so it can be tuned without a deploy.

## 2. Breaks rework: no 60-minute countdown for US hourly (call, 2:00-4:50)

Neil: the one-hour break allowance UI was built on the India assumption.
US policy is different - up to 1 hour UNPAID lunch (most take the hour), two
paid 10-minute breaks; and management actively avoids overtime ("we would
rather cut the shift").

- REMOVE for US hourly employees: the "Break Today X of 60m" countdown ring,
  the "Xm of 60m left" meter, and the 60-min allowance framing in the punch
  card (TimeClock.jsx SessionRing/break meter) and the fixed-card "60 min
  allowance" copy where it applies to US staff.
- KEEP the countdown for India (fixed-salary/contractor staff) - Neil
  explicitly said it can stay for them.
- Driver: the employee's overtime rule / currency on PayrollRate ('ca' or
  'federal' = US hourly → no countdown; 'none'/INR → keep). Falls back to
  no-countdown when unset? No - default keep current behavior for fixed.
- The CA paid-break engine from the Charmi batch (paid 10-min breaks, meal
  unpaid) matches Neil's description - enable it once Charmi confirms.
- Optional add (supports "cut the shift" management): the day's projected
  OT is already visible on the timecard; no new work needed beyond removing
  the misleading countdown.

## 3. People module: one "Add" flow (call, 0:06)

Replace the separate Add Employee button + External concept with a single
Add control on People offering:
- Add Employee
- Add Independent Contractor
- Add External

Everything lands in the master People list (contractors already exist via
employment_type; External moves in from its separate tab - this is the
"externals in People" design that was pending from Aug 11). Take the
separate External-users-only surface out of the add path (the External tab
remains for allowlist admin, but people are ADDED through the one flow).

## 4. Construction BOD-skip hole (call, 8:00-10:00)

Construction crew clocked in WITHOUT filling in what they're working on.
Pranshu supposedly removed Skip already (commit 1a57f9b removed Skip on
break prompts) - but someone still got through on mobile.

- Reproduce on a phone: punch in and see whether the BOD gate can be
  bypassed (dismiss/reload/second device?). Server-side today the BOD is
  NOT enforced - `/punch` accepts an in-punch regardless; the gate is
  client-only. Close it server-side: reject a first in-punch of the day
  when no TimeBod row exists and the policy requires one, EXCEPT for
  leadership/exempt and manually added guests (Visesh's proposal on the
  call).
- Check with Pranshu what he actually removed before changing his code.

## 5. Sagar's work: dev -> prod release (call, 1:06)

Sagar pushed to dev only, thinking it went to prod (PR #121 merged to dev
08/24). Action: release dev -> main so Neil sees the project/task fixes on
prod. Follow the release checklist (RLS advisors after deploy). NOTE: the
Charmi Time Clock batch is now also on dev - a dev->main release ships BOTH;
sequence it deliberately (pre-apply the 3 new columns on prod Supabase first,
same as dev).

## 6. Noted, no immediate build

- Accounting module: Visesh starts the UI now (environment created);
  Neil offered help. Separate track.
- Construction non-compliance (people not clocking in at all): Neil is
  messaging the team; the auto-out + alerts above are the system side.
- Live view: clarity fix confirmed working; Neil happy with side-by-side.
- Phone GPS path tracking (Apple-workout-style path) - exists via track
  pings; app question stays parked (phase-next, per the Charmi call too).
- "Hager" push - already started per Visesh (clarify what this refers to).

## Suggested order

1. Auto clock-out + reminders + manager alert (#1) - it is the burning
   issue and Neil's explicit ask.
2. US-hourly break-countdown removal (#2) - small frontend change, pairs
   with the already-shipped break-policy engine.
3. BOD server-side enforcement (#4) - after confirming with Pranshu.
4. People unified Add flow (#3) - UI restructure, coordinate with the
   pending externals-in-People design.
5. Prod release (#5) - once 1-2 land on dev and are verified.
