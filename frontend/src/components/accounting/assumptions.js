// Defaults chosen for the 22 Oct 2026 Accounting change requests where the
// call left a question open (E:/Calls/2026-10-22-GreensGlobal/changes.md).
// Visesh approved building each with a recommended default; every one lives
// HERE, named, so changing it once Charmi / Neil answer is a one-line edit.
// Screens import these - never repeat the values inline. The backend's
// matching defaults are in backend/accounting_assumptions.py.

// ── CR-02 Compensation ──────────────────────────────────────────────────────

// CR-02 (assumption, Charmi to confirm): chosen to show the ledger's payroll expense split
// Direct / Indirect because Neil asked for compensation "including direct or
// indirect expenses" and "RDI" is read as that same split. Direct = cost of
// sales (labor charged to properties / jobs), Indirect = operating and other
// expense (overhead) - the sections are backend COMP_DIRECT_SECTIONS.
export const COMP_SHOW_DIRECT_INDIRECT = true;
export const COMP_DIRECT_LABEL = 'Direct';
export const COMP_INDIRECT_LABEL = 'Indirect';

// CR-02 (assumption, Charmi to confirm): chosen 180 seconds and ONE attempt because the
// server stops a run itself at 100 seconds (backend COMP_TIME_BUDGET_SEC) and
// answers why; a silent retry only tripled the wait (three 180-second tries
// = nine minutes of empty rows).
export const COMP_REQUEST_TIMEOUT_MS = 180_000;

// ── CR-03 Management Fees ───────────────────────────────────────────────────
// Pre-fills for a new "Percent or Flat" agreement; each agreement keeps its
// own values. The server's matching defaults are backend MGMT_FEE_DEFAULT_*.

// Team answer, 23 Oct (Neil): "Usually it's 3% of gross revenue or
// $3,000/month, whichever is higher. but these thresholds get built in
// property by property." -> the Greater Of basis, per agreement.

// CR-03 (confirmed by team, 23 Oct): new agreements start on Greater Of.
export const MGMT_FEE_DEFAULT_BASIS = 'greater_of';
// CR-03 (confirmed by team, 23 Oct): "$3,000/month" - a new Greater Of
// agreement's monthly minimum (each agreement keeps its own). Backend
// MGMT_FEE_DEFAULT_MONTHLY_MINIMUM.
export const MGMT_FEE_DEFAULT_MONTHLY_MINIMUM = 3000;

// The defaults below serve the older "Percent or Flat (Threshold)" basis,
// kept for agreements saved with it.
// CR-03 (assumption, Charmi to confirm): chosen $100,000 because it is the first figure
// Charmi gave ("$100,000 or $30,000 or $50,000") and 3% of it is exactly the
// $3,000 flat fee, so the two fees meet at the threshold.
export const MGMT_FEE_DEFAULT_THRESHOLD = 100000;
// CR-03 (assumption, Charmi to confirm): chosen 3% and $3,000 because those are the
// operating-agreement figures Charmi quoted on the call.
export const MGMT_FEE_DEFAULT_RATE = 3;
export const MGMT_FEE_DEFAULT_FLAT = 3000;
// CR-03 (assumption, Charmi to confirm): chosen "annual" because an operating agreement's
// income threshold is a yearly figure (calendar-year gross through the end of
// the period). "period" tests the chosen period's gross instead.
export const MGMT_FEE_DEFAULT_THRESHOLD_BASIS = 'annual';
// CR-03 (assumption, Charmi to confirm): chosen "per year" because a $3,000 floor next to
// 3% of a $100,000 threshold only adds up yearly. Must match backend
// MGMT_FEE_TIER_FLAT_IS_ANNUAL - it only changes the dialog's wording.
export const MGMT_FEE_TIER_FLAT_IS_ANNUAL = true;
// CR-03 (assumption, Charmi to confirm): chosen Year to Date as the period the page opens
// on because Billed YTD and Expected YTD were already yearly figures.
export const MGMT_FEE_DEFAULT_PERIOD = 'ytd';

// ── CR-04 Reports menu placement ────────────────────────────────────────────

// CR-04 (confirmed by team, 23 Oct - Neil: "PFS should go under Financial
// Reports. Management Fees Report should go under Audit and Insights"): the
// group each report sits in. `after` is the item it follows inside the group
// (CR-04, assumption, Charmi to confirm): PFS last in Financial, after Cash
// Position, because the spec's Financial list is the statements and PFS is
// not one; Management Fees after Profitability, the end of Neil's six Audit
// & Insights items, so his order (Flux, MRE, MRI, AMA, Manual Journal
// Entries, Profitability) stays as written. An `after` not found = the end.
export const REPORT_MENU_PLACEMENT = {
  pfs: { group: 'grp-financial', after: 'rpt-cash-position' },
  'mgmt-fees': { group: 'grp-audit', after: 'profitability' },
};

// ── CR-05 Report Builder ────────────────────────────────────────────────────
// Team answer, 23 Oct (Neil): "Yes it needs comparison columns. Anyone can
// publish if they have access to accounting, and published reports can be
// shared with everyone, but are not shared by default. You already have a
// workflow on it."

// CR-05 (confirmed by team, 23 Oct): the comparisons a builder report can
// add. Chosen (assumption, Charmi to confirm): prior period (the same length
// just before) and prior year (the same dates a year back) - the two the
// statements already offer. As of a date: the prior month-end and the same
// date last year.
export const BUILDER_COMPARE_OPTIONS = [
  { key: 'prior_period', label: 'vs Prior Period', short: 'Prior Period' },
  { key: 'prior_year', label: 'vs Prior Year', short: 'Prior Year' },
];
// CR-05 (assumption, Charmi to confirm): a new report starts with no
// comparison, so a plain report stays one column; a report saved before has
// none either.
export const BUILDER_DEFAULT_COMPARE = [];
// CR-05 (assumption, Charmi to confirm): each comparison adds the prior
// figure, then Variance $ and Variance % (current less prior, and that over
// the prior) - what the Flux Analysis and the statements show. Drop
// 'percent' or 'amount' to show one only.
export const BUILDER_VARIANCE_COLUMNS = ['amount', 'percent'];
// CR-05 (confirmed by team, 23 Oct): "Anyone can publish if they have access
// to accounting" - the Accounting grant's lowest level saves and publishes.
export const BUILDER_PUBLISH_MIN_LEVEL = 'viewer';
// CR-05 (confirmed by team, 23 Oct): "not shared by default" - Publish leaves
// a report seen by its author only; Share With Everyone is its own step (the
// memorized report's `shared` flag, the existing sharing workflow).
export const BUILDER_PUBLISH_SHARES = false;

// ── CR-06 Trial Balance and T12 ─────────────────────────────────────────────
// Team answers, 23 Oct - Charmi: "Trial balance should go under both cash and
// accrual". Neil: "Trial should be for both. T12 should mean the last 12 full
// months, meaning it should show 13."

// CR-06 (confirmed by team, 23 Oct): the Trial Balance's Book box offers
// Accrual, Cash and Accrual and Cash side by side (reportModel bookOptions /
// canBothBooks). Chosen (assumption, Charmi to confirm): it OPENS on
// Accrual, the book every other statement opens on.
export const TRIAL_BALANCE_DEFAULT_BOOK = 'accrual';

// CR-06 (confirmed by team, 23 Oct): T12 = the last 12 FULL months (the
// month in progress left out), one column each. Read (assumption, Charmi to
// confirm) "it should show 13" as the 12 month columns plus the Total column
// - 13 columns. The Income Statement's T12 quick view, the "Trailing 12
// Months" period of every report and the Report Builder all use this one
// definition (reportModel presetRange 't12m'). A month with no postings
// still gets its column.
export const T12_MONTHS = 12;
// CR-06 (assumption, Charmi to confirm): the other reading of "13" - the 12
// full months AND the current month to date as a 13th column. Off.
export const T12_INCLUDE_CURRENT_MONTH = false;

// ── CR-10 Manual Journal Entries ────────────────────────────────────────────
// Which entries count as manual is the server's (backend MANUAL_JE_* in
// accounting_assumptions.py; a system entry a person changed counts - team
// answer, 23 Oct). These are only how the screen opens.

// CR-10 (assumption, Charmi to confirm): opens on Last Month - the month a
// controller reviews at close; the stepper changes it.
export const MANUAL_JE_DEFAULT_PRESET = 'last-month';
// CR-10 (assumption, Charmi to confirm): the list opens grouped by the person
// who keyed each entry, since spotting one person's pattern is the point
// (Neil: "most companies review their manual entries").
export const MANUAL_JE_GROUP_BY_USER = true;

// ── CR-12 Records menu ──────────────────────────────────────────────────────
// Team answer, 23 Oct - Charmi's edited Teams post: "Under Records - Change
// Chart of Accounts to General Ledger Accounts and also add Journals and under
// Journals add APJ, GJCA, GJC, PYRJ, PEJ, PIJ, SJI, GJ, HJCA". Neil: "Each
// journal page should allow us to view the transactions of that journal and
// have all standard filters and search functionality and resizable columns".

// CR-12 (confirmed by team, 23 Oct): the journals under Records > Journals,
// in Charmi's order (GJC, not GC). Add or remove a symbol here; each opens
// that journal's lines (sub key `journal-<symbol>`).
export const RECORDS_JOURNALS = ['APJ', 'GJCA', 'GJC', 'PYRJ', 'PEJ', 'PIJ', 'SJI', 'GJ', 'HJCA'];
// CR-12 (assumption, Charmi to confirm): a journal page opens on Year to
// Date, the period every statement opens on; the stepper changes it.
export const JOURNAL_PAGE_DEFAULT_PRESET = 'ytd';
// CR-12 (assumption, Charmi to confirm): General Ledger Accounts hides
// inactive accounts until "Show inactive" is ticked, like the report pickers.
export const GL_ACCOUNTS_SHOW_INACTIVE = false;

// ── CR-13: AMA (Ask My Accountant) ─────────────────────────────────────────

// CR-13 (confirmed by team, 23 Oct - Neil: "Show all offsetting accounts"):
// an entry with more than two lines (a bank-feed batch, a split) lists EVERY
// account on the other side in the cell. 'largest' would show only the
// biggest one with "+N more".
export const AMA_OFFSET_DISPLAY = 'all';

// CR-13 (assumption, Charmi to confirm): keep the Account column next to Other Side?
// Chosen false - on the AMA list it always reads "63501 ? Ask My Accountant"
// (Charmi, 36:07: "I don't care if the Ask My Accountant doesn't show up");
// the account still shows in the side panel and above the grid. true puts it
// back beside Other Side.
export const AMA_SHOW_ACCOUNT_COLUMN = false;

// CR-13: how many entries one "other side" read asks for (the server caps it
// at AMA_OFFSET_BATCH_MAX = 100 in backend/accounting_assumptions.py).
export const AMA_OFFSET_BATCH = 100;

// CR-13: how many GL accounts the picker lists at once while typing.
export const AMA_GL_PICKER_LIMIT = 60;

// CR-13 (confirmed by team, 23 Oct): the push edits the ORIGINAL Intacct
// entry, a preview first, at most backend AMA_PUSH_BATCH_LIMIT lines at a
// time (1, then 4, then 10 as the team validates). The screen reads the live
// limit and mode from the server; these are only what it assumes before the
// list has loaded.
export const AMA_PUSH_BATCH_LIMIT_DEFAULT = 1;
export const AMA_RECLASS_MODE_DEFAULT = 'edit_original';
