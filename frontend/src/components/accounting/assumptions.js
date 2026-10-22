// Defaults chosen for the 22 Oct 2026 Accounting change requests where the
// call left a question open (E:/Calls/2026-10-22-GreensGlobal/changes.md).
// Visesh approved building each with a recommended default; every one lives
// HERE, named, so changing it once Charmi / Neil answer is a one-line edit.
// Screens import these - never repeat the values inline. The backend's
// matching defaults are in backend/accounting_assumptions.py.

// ── CR-02 Compensation ──────────────────────────────────────────────────────

// CR-02 (Charmi to confirm): chosen to show the ledger's payroll expense split
// Direct / Indirect because Neil asked for compensation "including direct or
// indirect expenses" and "RDI" is read as that same split. Direct = cost of
// sales (labor charged to properties / jobs), Indirect = operating and other
// expense (overhead) - the sections are backend COMP_DIRECT_SECTIONS.
export const COMP_SHOW_DIRECT_INDIRECT = true;
export const COMP_DIRECT_LABEL = 'Direct';
export const COMP_INDIRECT_LABEL = 'Indirect';

// CR-02 (Charmi to confirm): chosen 180 seconds and ONE attempt because the
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
// CR-03 (Charmi to confirm): chosen $100,000 because it is the first figure
// Charmi gave ("$100,000 or $30,000 or $50,000") and 3% of it is exactly the
// $3,000 flat fee, so the two fees meet at the threshold.
export const MGMT_FEE_DEFAULT_THRESHOLD = 100000;
// CR-03 (Charmi to confirm): chosen 3% and $3,000 because those are the
// operating-agreement figures Charmi quoted on the call.
export const MGMT_FEE_DEFAULT_RATE = 3;
export const MGMT_FEE_DEFAULT_FLAT = 3000;
// CR-03 (Charmi to confirm): chosen "annual" because an operating agreement's
// income threshold is a yearly figure (calendar-year gross through the end of
// the period). "period" tests the chosen period's gross instead.
export const MGMT_FEE_DEFAULT_THRESHOLD_BASIS = 'annual';
// CR-03 (Charmi to confirm): chosen "per year" because a $3,000 floor next to
// 3% of a $100,000 threshold only adds up yearly. Must match backend
// MGMT_FEE_TIER_FLAT_IS_ANNUAL - it only changes the dialog's wording.
export const MGMT_FEE_TIER_FLAT_IS_ANNUAL = true;
// CR-03 (Charmi to confirm): chosen Year to Date as the period the page opens
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
