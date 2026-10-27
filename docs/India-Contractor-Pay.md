# India Contractor Work Hours and Extra Time Policy

Approved by Neil on 10/27/2026. **Never change these numbers without Neil.**
Code: `backend/india_contractor_pay.py` (the arithmetic), `backend/routers/extra_time.py`
(the claims), `_fixed_card` / `_india_overlay` in `backend/routers/timeclock.py` (the card).
Tests: `backend/test_india_contractor_pay.py` (exact rupee amounts).

## The policy (Neil's text)

1. Contractors are scheduled 9 hours a day, Monday - Friday; all hours are recorded in
   Nexus; they are paid monthly based on the daily rate.
2. Daily credit: under 4 hours, none; 4 hours to under 8, a half day; 8 hours or more, a
   full day. More than 9 hours does not automatically earn more.
3. Month-end reconciliation: credits are totaled; excess hours are pooled with the hours
   of incomplete workdays and reapplied only to recover missing half / full day credits on
   scheduled workdays; the final remainder rounds up to the next half day if unpaid
   scheduled time remains; regular pay never exceeds the scheduled workdays; once all are
   credited, remaining hours earn nothing.
4. Extra Time at 1.35x: work needs no prior approval, but to be paid as Extra Time the
   contractor identifies the hours in Nexus with a note describing the work; it needs
   approval; it is paid separately at 1.35 x the hourly equivalent of the daily rate; hours
   paid as Extra Time cannot also count in the reconciliation.
5. HR reviews at month end; final pay = reconciled regular credits + approved Extra Time,
   from verified Nexus records.

## Who it covers

- `NexusEmployee.employment_type == 'contractor'`, on FIXED monthly pay, who works in India:
  their People country, else their company's (`ca_breaks.country_of`); when neither is
  known, an INR pay rate.
- Settings > Pay > India Contractor Policy, per company: on by default for an India company
  (and for a company with no country, where each contractor's own country decides), off for
  a company in any other country. HR can turn it on or off per company.
- Policy Starts (per company, default 11/01/2026): a month that starts before it keeps the
  old rules, so October 2026 is never re-priced.
- Everyone else keeps the old fixed-pay rules exactly (bands at full-day hours minus an hour
  and 4 hours, automatic weekend pay at 1.35 x daily pro-rated with the Rs 500 floor, leave
  deducted like an absence).

## The exact algorithm (all in minutes)

| Constant | Value |
|---|---|
| Scheduled day | 9 h (540) |
| Full credit | 8 h (480) |
| Half credit | 4 h (240) |
| One recovered half day costs | 4.5 h (270) of pool |
| Round-up threshold | 1.5 h (90) |
| Half-day holiday pool line | 4.5 h (270) |
| Extra Time | 1.35 x (daily rate / 9) per hour |

1. **Scheduled workday** = Monday - Friday not a full company holiday on the person's
   calendar. Only days that are over count; today and later days never deduct.
2. **Daily credit** from hours actually worked `h` (leave minutes excluded):
   `h >= 8` full, `4 <= h < 8` half, `h < 4` none.
3. **Holidays and leave.** A full company holiday is credited and needs no hours. A
   half-day holiday keeps the old rule (any work = the full day; no work = the holiday half
   only, half a day missing). Sick / Vacation leave on a scheduled day fills the day's missing
   halves from the paid balance (`leave_balances`), half a day (hoursPerDay / 2 hours) at a
   time, as far as the balance goes, and uses that much balance at finalize. Personal /
   unpaid leave, leave the balance cannot cover and any unapproved absence stay missing for
   the pool to recover. (For in-scope contractors this replaces Pranshu's Oct 12 "leave
   deducts like an absence" rule.)
4. **The pool (reading B).** Per scheduled day: full credit `max(0, h - 9)`; half credit
   `h - 4`; no credit `h`. A half-day holiday: `max(0, h - 4.5)`. Every hour on a
   non-scheduled day (weekend, full holiday). Approved Extra Time hours are taken out (never
   counted twice); pending, declined, withdrawn and unclaimed hours stay in.
5. **Recovery.** `M` = missing half days. `R = min(M, floor(pool / 4.5 h))`;
   `r = pool - 4.5 h x R`; if `R < M` and `r >= 1.5 h`, `R = R + 1`. Recovered halves go to
   the missing days in date order, earliest first, so each day still unpaid keeps its own
   day's rate (a mid-month raise stays correct). Pool hours left after every scheduled day is
   credited earn nothing.
6. **Pay.** The monthly base and the daily rate are unchanged (`base` = salary in effect /
   days in month, per day; `daily` = salary in effect x 12 / working weekdays in the year):
   `pay = base - sum(unpaid halves x that day's daily / 2) + Extra Time`, the deduction never
   more than the base. Extra Time = approved hours x (that day's daily / 9) x 1.35, no floor,
   no cap beyond the hours worked. The automatic weekend pay and its Rs 500 floor do not apply.

## Worked example (the month Neil reviewed)

Monthly fee Rs 58,725 -> daily Rs 2,700 (x 12 / 261), hourly equivalent Rs 300.
22 scheduled days: 19 days at 9 h, one day at 10.5 h, one absent day, one day at 3 h.
Saturday 5 h claimed and approved; Sunday 3 h not claimed.

- Pool = 1.5 (10.5 h day) + 0 (absent) + 3 (3 h day, no credit) + 3 (Sunday) = 7.5 h.
- M = 2 days (4 halves). R = floor(7.5 / 4.5) = 1; r = 3.0 h >= 1.5 h, so R = 2: one day
  recovered (the earlier missing day), one day unpaid.
- Extra Time = 5 x 300 x 1.35 = Rs 2,025.
- Pay = 58,725 - 2,700 + 2,025 = **Rs 58,050**.

## Extra Time claims

- The contractor clicks **Claim Extra Time** on a day of their Time Sheet. The hours are
  prefilled: every hour worked on a weekend or a full holiday; on a scheduled weekday only
  the hours past 9 (past 4.5 on a half-day holiday) - and that is the most one day takes. A
  note describing the work is required. One claim per day; it can be edited or withdrawn
  while Pending.
- Statuses: Pending, Approved (the approver may approve fewer hours than claimed), Declined
  (a reason is required).
- **Approver**: the company's HR contact; when there is none, or the HR contact is the
  claimant, the Global Admins (the time sheet review's fallback). HR may also decide - the one
  HR rule (the HR contact, an administrator or owner, a Full HR grant) within the contractor's
  company: an administrator or a Full grant only where their People scope and the company
  walls reach (`extra_time.hr_for`). Nobody decides their own claim - enforced on the server.
- **Deadline**: claims are filed until the month's time sheet goes to Review & Approve.
  Review & Approve is blocked while any claim of the month is Pending. A decision changed
  after approval goes through `guard_edit` (HR's override: the envelope is voided and the
  employee signs the updated card).
- **Notices** (server-side): one grouped notice per approver per month, rewritten in place
  and resolved when nothing is left; one notice per contractor per month listing the
  decisions; on the month's last day one reminder to each in-scope contractor with weekend or
  holiday hours not claimed (`period_close_loop`, in a thread).
- `routers/extra_time.waiting_on(db, user)` lists the pending claims waiting on a named
  approver - the Approvals inbox source.

## Where it shows

- The card: each day's Credit (Full / Half / None, Paid Leave), Pool hours and Extra Time;
  the Month-End Reconciliation panel (scheduled days, credits earned, missing, pool hours,
  half days recovered and whether the 1.5 h round-up applied, unpaid days, Extra Time,
  total).
- The PDF time sheet: the same reconciliation and the Extra Time claims with their notes,
  above the employee's signature.
- The contractor invoice: the monthly fee, less the unpaid days, plus Extra Time as its own
  line (from the finalize snapshot).
- People > Time > Extra Time: the claims waiting on a decision and the last 60 days of
  decisions.

## Finalized months

Finalize stores the policy version and the whole reconciliation, day by day
(`snapshot["indiaPolicy"]`). A finalized month never re-prices - not when the switch, Policy
Starts, the fee, a leave balance or a claim changes. A month finalized without that key keeps
the old rules.
