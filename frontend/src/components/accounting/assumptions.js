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
