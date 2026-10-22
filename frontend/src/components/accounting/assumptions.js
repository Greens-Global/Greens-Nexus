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
