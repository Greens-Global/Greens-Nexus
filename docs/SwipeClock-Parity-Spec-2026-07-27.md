# SwipeClock (TimeWorksPlus) — feature inventory & parity spec

Scraped live from the Oversite Management account (site 47239) on Jul 27, 2026,
ahead of the one-week SwipeClock-vs-Nexus parallel run starting Jul 28.
Goal: Nexus Time Clock must produce **identical numbers** before we transition —
California wage rules make "close" unacceptable.

## 1. Account shape

- 22 active employees (terminated employees retained, marked ☓ in pickers)
- Pay periods: **bi-weekly, Sunday-anchored** — current 7/26/26–8/8/26, prior
  7/12–7/25. History back to at least Oct 2025; older periods marked
  **(finalized)** = locked.
- Workweek for OT: **Sun–Sat** (weekly subtotal rows "week of 7/12 to 7/18").
- Org fields per employee: Home Department / Home Location / Home Supervisor;
  per-segment Department on the timecard (job costing), e.g. "MCD Service Inc."
- Punch sources: physical clock, mobile punch (15 enabled), web clock (7 enabled),
  with a "Show Mobile Punches" toggle and a Mobile/Web Clock Access report.

## 2. Active processing rules (the calculation contract)

| Rule | What it does |
|---|---|
| **CA** | California overtime: daily OT **after 8h**, double-time **after 12h**; **7th consecutive day** of the workweek → all hours OT, double-time after 8h; weekly OT after **40h**. |
| **ClockPrompts** | Extra data items collected at clock in/out. |
| **ESSRule** | Employee self-service restrictions. |
| **MinuteRounding** | Times shown in h:mm (not decimal); **seconds dropped from punches**. |
| **Nx** | Punch rounding — **CONFIRMED for this site: round to the NEAREST 5 minutes**, applied symmetrically to in- and out-punches. Verified via the time card's "Show Unrounded Times" overlay (raw 1:22:00p → 1:20p, 9:04:00a → 9:05a, 12:27:00p → 12:25p, 8:18:00a → 8:20a, 12:49:00p → 12:50p). Raw times are stored and viewable; rounded times drive all hour math. |
| **PayPeriods** | Bi-weekly Sunday-start boundaries as above. |
| **PayRates** | Pay-rate tracking; wage columns on time cards ($/hr per segment, extended Wage per row). |
| **TimeCardApprovals** | Employee / Supervisor / Client three-level approval. |
| **TimeCardSignature** | Signature line + attestation text on the card (below). |

Attestation text (verbatim): *"By execution and signature of this time sheet, I
agree I have reviewed this time card, and agree the hours stated are accurate
and correct."* followed by `X____________`.

## 3. Time card anatomy (the thing we must reproduce)

Columns: **Date | In | Out | Deducted Time | Category | Hours | Hrs/day |
Non-OT | OT | Amount | Loc | Department | Pay Rate | Wage**

Behaviors observed on a real card (7/12–7/25):

- Multiple segments per day; each row shows segment Hours; **Hrs/day** shows
  `↓` on non-final rows and the day total on the last row (e.g. 3:15 ↓, then 7:15).
- **OT is split out per segment as it crosses the daily 8h line**: a 9:00 day
  showed the crossing segment as 3:45 Non-OT + **1:00 OT**.
- Weekly subtotal line per workweek: "Total hours clocked for week of X to Y: 34:25".
- **Missing punches render inline** ("Missing" in the In or Out cell), pay $0.00
  for the broken pair, count into a TOTAL MISSING PUNCHES figure, and can carry
  a punch note (e.g. "clock out at 5pm").
- Times shown like `9:00a` / `12:15p`; all durations **h:mm**, with decimal
  equivalents in parentheses in the totals ("58:30 (58.50)").
- Totals block: per-column totals row, then a wage summary by rate —
  Regular at base rate, **Overtime at 1.5× rate** (observed $18 → $27), grand
  total, missing-punch count, then the signature block.
- Card navigation: Previous/Next pay period + a "Pay Period Finder".
- Time Card Options menu: Show Only Missing Punches · Show All Activity ·
  **Show Unrounded Times** (raw seconds-precision overlay) · Show Time Card
  Audit Log · Approve Time Card. Per-punch geo-pins (green in-fence / red
  out-of-fence) and per-day edit (pencil) and employee icons.
- Employee header carries a payroll **Code** (do not replicate the actual values
  anywhere — they look like SSNs).

## 4. Reports & workflows inventory

Time cards: Yesterday's Entries · Today's Entries · Current Period · Previous
Period · Select Other Periods; per-employee list with per-row **M**issing /
**E**dits / **A**pproval indicators, "Show Missing Only" filter, an
"Unmatched Punches" bucket, Print All Time Cards (alphabetical / by home
department / location / supervisor).

Reports menu: Mobile and Web Clock Access · Pay Period Summary ·
Pay Period Sub-Totals · Time Card Audit Log · Approvals Report · Detail Report ·
Labor Report · Punch Notes Report · Summary Report · Time Off Request Report ·
Work Month Report · Work Week Report.

Pay Period Summary options: any historical period or custom date range; toggles
for Show Wages / Dollar Amounts / Edit Counts / **Week Breakdown** / Employee
Code / **Export with Approval Signature line**; scope = all active / all incl.
terminated / specific employees / group / by criteria.

Time off: request states Pending / Approved / **Conditionally Approved** / Rejected.

Other: Employee Bulletins · MFA · Clock Status · employee-portal account linking ·
**Geofence Alert emails** (per-admin opt-in, covers all employees) ·
dashboard quick stats (clocked in now, missing punches, mobile/web enablement).

## 5. Gap analysis — Nexus Time Clock vs SwipeClock

Already at parity (from the Jul 21–22 SwipeClock-parity phase 1): bi-weekly
timesheet, location column + editing, Hrs/day, dept/rate header, signature line,
punch-fix (missed punch) request flow with approver, timecard approvals, punch
notes, audit trail, geofencing (soft-gate), mobile/web punching, time off
requests, exports.

**Blocking for a 1:1 comparison (build first):**

1. **CA overtime engine** — Nexus day summaries track raw minutes only; no
   Reg/OT/DT classification. Must implement: daily >8h → OT, >12h → DT,
   Sun–Sat weekly >40h → OT (no double count with daily), 7th-consecutive-day
   rule (all OT; DT after 8h).
2. **Punch rounding** — SwipeClock drops seconds and rounds each punch to the
   **nearest 5 minutes** (confirmed, see §2); Nexus keeps exact minutes. Nexus
   must apply the same nearest-5 rounding (keeping raw times stored, like
   SwipeClock does) or the two systems will NEVER match.
3. **Workweek/period anchor** — comparison must use SwipeClock's exact Sunday
   anchor (7/26 period start, Sun–Sat workweeks).
4. **Comparison report** — a Nexus export mirroring Pay Period Summary
   (per-employee Reg/OT/DT h:mm + decimal, weekly breakdown, missing-punch
   count) so the weekly diff is mechanical, not manual.

**Wanted but not blocking:** auto-lunch Deducted Time column (rule exists but
showed "-" on the sampled card — confirm if configured); period **finalize/lock**;
per-segment department (job costing) — phase 2 items from the Jul 22 plan.

## 6. Parallel-run protocol (starting Jul 28)

1. Everyone punches BOTH systems for the week (SwipeClock remains system of record).
2. Each morning: run SwipeClock "Yesterday's Entries" vs the Nexus comparison
   export for the same day; log every diff with cause (rounding / missed punch /
   OT classification / timezone).
3. End of week: full-period Pay Period Summary vs Nexus export; require zero
   unexplained differences in Reg/OT/DT per employee before scheduling cutover.
4. Known systematic differences to expect: SwipeClock rounds punches (Nx),
   Nexus records exact wall-clock; punches made in one system but not the other
   (human error) — the daily check catches these while memories are fresh.
