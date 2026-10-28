# Holiday policies - design (Oct 29 2026)

Neil, 10/29/2026:
- "In Settings under Companies it's not showing Presidents' Day and it's automatically
  assuming that July 5th is a holiday because the 4th falls on a Sunday. Let's not assume
  that and have an option to adjust if required where the policies can be established
  properly. Figure this change out and get it right. Also Indian companies may have Indian
  holidays so let's make sure that gets corrected."
- "Selecting a company for Holidays should be able to multiselect and apply to one or more
  companies and if the individual company is selected then it should override and be
  company specific. Get the policy thing better."

## What is wrong today (verified 10/29/2026)

1. **Presidents' Day is listed as "Washington's Birthday".** The source (date.nager.at)
   gives localName "Washington's Birthday", and `routers/hr._fetch_nager_holidays`
   prefers localName.
2. **Weekend holidays are silently moved.** Nager returns the federal OBSERVED date for
   fixed-date holidays: Independence Day 2026 = 07/03 (Fri), 2027 = 07/05 (Mon);
   Christmas 2027 = 12/24; Juneteenth 2027 = 06/18; New Year's Day 2028 etc. The real
   date never appears and nobody chose the rule.
3. **The US list mixes in state-only days** (Lincoln's Birthday, Truman Day, Good Friday,
   Indigenous Peoples' Day) with no label saying "only in some states"; Columbus Day
   appears as a federal Public day only for banks.
4. **India's list is not curated.** Nager has no India; the Google "en.indian" feed returns
   ~61 entries a year: ~18 marked "Public holiday" (the gazetted list, incl. the three
   national days) and ~43 "Observance" (regional/restricted), shown identically. Islamic
   dates are "(tentative)". Coverage: 2021-2027 full, 2028-2031 partial (~37/year).
5. **Policies are copies.** Applying a policy stamps its rows into one company; editing the
   policy later changes nothing; there is no "this policy applies to these companies", and
   a company cannot vary one holiday without losing the link.

## Readers (unchanged by this design)

Every reader reads `hr_company_holidays` for a company and date range, matching the
employee's country against `country_code`: `routers/timeclock._company_holidays_for_employee`
/ `_company_holidays_for_many` (Time Sheets, India contractor pay), `workforce_scorecard._holidays`,
`shift_attendance._holiday_dates`, `hr_checklists._holidays`, `routers/dashboards.company_holidays`,
`routers/directory`, `routers/hr` list. **The design keeps `hr_company_holidays` as the one
effective table** - policies materialize into it - so none of them change.

## The model

**Holiday Policy** (the org-level thing, `hr_holiday_policies`, extended):
- name, description, owner company (who may edit, unchanged rule), and NEW:
- `companies`: the companies it applies to (many-to-many through a new
  `hr_holiday_policy_assignments` table: policy_id, company_id, skipped [keys], assigned_by/at).
  A company may have several policies (e.g. Greens Global: "US Holidays" for its US staff
  and "India Holidays" for its India contractors - rows carry country codes, so each
  person gets only their country's days, exactly as today).
- `weekend_rule`: what to do when a holiday falls on a Saturday or Sunday -
  `keep` (default - Neil: do not assume), `nearest_weekday` (Saturday -> Friday before,
  Sunday -> Monday after: the US federal rule), `next_monday` (both -> Monday after),
  `prior_friday` (both -> Friday before), `not_observed` (no day off when it falls on a
  weekend). The rule is applied when a holiday is ADDED to the policy from a source; each
  holiday then carries its own date and can be changed one by one.
- holidays: `[{key, date, actualDate, name, type, countries:[], source, scope, tentative}]`
  - `key` stable inside the policy (`<country>:<slug(name)>:<year>`), `date` = the day off,
  `actualDate` = the real calendar date when `date` differs (observed), `scope` the source's
  label (federal / state:CA,CT / company_common / national / gazetted / restricted),
  `tentative` true for lunar dates that may move.

**Company calendar** (`hr_company_holidays`, extended with three columns):
- `policy_id` ('' = the company's own holiday), `policy_key` (the holiday's key in that policy),
  `actual_date` ('' unless observed on another day), `overridden` (0/1: the company changed
  this policy holiday's date or type for itself).
- Sync (`holiday_policies.sync(db, policy, company_ids=None)`): for each assigned company,
  upsert one row per policy holiday not skipped by that company; never touch an `overridden`
  row's date/type; delete rows of holidays the policy no longer has (an overridden row whose
  holiday left the policy becomes the company's own: policy_id cleared). Runs on every
  policy save, assign, unassign (unassign deletes that policy's non-overridden rows), skip,
  unskip. Same transaction as the change.

**Company overrides** (Settings with one company picked):
- Skip a policy holiday for this company (stored in the assignment's `skipped`; the row goes).
- Change a policy holiday's date or type for this company (row `overridden=1`, "Changed For
  This Company" chip, Reset To Policy).
- Add the company's own holidays (from a source list or typed) - exactly today's behavior.
- Assign / unassign policies to this company.

## Sources (`backend/holiday_sources.py`, moved out of routers/hr.py)

- **United States, computed in-house** (no network, every year): the 11 federal holidays with
  their real dates (New Year's Day 1/1, Martin Luther King Jr. Day 3rd Mon Jan, Presidents'
  Day 3rd Mon Feb, Memorial Day last Mon May, Juneteenth 6/19, Independence Day 7/4, Labor
  Day 1st Mon Sep, Columbus Day 2nd Mon Oct, Veterans Day 11/11, Thanksgiving 4th Thu Nov,
  Christmas Day 12/25), scope `federal`; common company holidays scope `company_common`:
  Day After Thanksgiving, Christmas Eve, New Year's Eve (and Good Friday). State-only days
  come from Nager (global=false) with scope `state:<codes>` and are listed separately.
  Each row returns `date` (real), `weekday`, and `observed` = the date the federal rule
  would give (shown as a hint, never applied unless the policy's rule says so).
- **India**: the three national holidays computed in-house (Republic Day 1/26, Independence
  Day 8/15, Gandhi Jayanti 10/2, scope `national`, type mandatory); the Google feed for the
  rest, classified by its DESCRIPTION: "Public holiday" -> scope `gazetted` (suggested type
  mandatory), "Observance" -> `restricted` (suggested type optional - India's restricted
  holidays, which Nexus's Optional type already models), "(tentative)" -> tentative=true
  with the "(tentative)" suffix stripped from the name. A year the feed only partly covers
  says so ("Partial list for 2029 - confirm dates nearer the time"). India rows never move
  for weekends unless the policy says so.
- **Every other country**: Nager as today (English `name` when the local name is not in
  Latin script is NOT attempted - keep localName, except the US which is in-house), Google
  fallback as today. A country with no data: 404 with the existing clear message.
- Names: American English and the common US names ("Presidents' Day", "Labor Day").

## Screens (Settings > Companies, `views/HR.jsx` + AdminConsole GROUPS)

- **Every Company face: "Holiday Policies"** (new group under Companies, org face):
  the list of policies (name, years covered, holidays count, companies as chips, weekend
  rule in words). Policy editor (60vw Modal, nx-fill): Name, Description, **Applies To**
  (company multiselect - "apply to one or more companies"), **When A Holiday Falls On A
  Weekend** (the five rules, default Keep The Date), a year picker, **Add From** country
  source with the list grouped by scope (Federal / Common Company Holidays / Some States;
  National / Gazetted / Restricted) each row: checkbox, name, real date with weekday,
  "Falls on a Sunday - observe on [select]" when weekend (default from the rule), suggested
  type, Tentative chip; then the policy's own holiday table: date (DateField, editable),
  real date hint, name, type, countries, remove; **Copy To <next year>** (rebuild the same
  holidays for the next year from the sources, rule applied, unknown ones listed).
  Saving shows "Updates N companies" before it applies.
- **One company face: "Holiday Calendar"** (existing tab, reworked): "Policies For This
  Company" (assigned policies as chips with Unassign, and Assign A Policy); the effective
  calendar for the picked year grouped by source: each policy holiday shows its policy chip,
  and actions Skip For This Company / Change Date / Change Type (overrides get a "Changed
  For This Company" chip and Reset To Policy; skipped ones are listed muted with Restore);
  "Company's Own Holidays" with the existing add-from-list and add-manually. Existing rows
  stay as the company's own (policy_id '').
- Existing saved rows that sit on an observed date of a US fixed-date holiday get a hint
  "Independence Day is 07/04/2027, a Sunday - this company takes 07/05/2027" so HR can
  see what was assumed and change it.
- Copy rules: Title Case titles/buttons/chips, MM/DD/YYYY, weekday names, no em dashes.

## Migration

- New table `hr_holiday_policy_assignments` (RLS line), new columns on
  `hr_company_holidays` (`policy_id`, `policy_key`, `actual_date`, `overridden`) and on
  `hr_holiday_policies` (`description`, `weekend_rule`) in BOTH migration lists.
- Existing policies keep working: they have no assignments yet; their holiday JSON gains
  keys lazily (`key` computed on read when missing). The old "Apply" (copy) action becomes
  "Assign" (live). Existing company rows are untouched and read as the company's own.
- Nothing is deleted or moved by the migration.
