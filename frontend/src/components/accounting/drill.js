// Cross-tab drill-down into Accounting -> Reports (Neil, Sep 25: "add
// drilldown everywhere"). A widget on another tab (the Close tab's Current
// Balance, for one) asks for the lines behind an amount; the Reports tab is
// not mounted yet, so the request is parked here, the app is pointed at the
// tab, and ReportsTab picks it up when it mounts (or right away, through the
// event, when it is already on screen).
//
//   requestReportDrill({ account: '11452', accountName: 'GC Chase Chkg', from: '', to: '2026-08-31', entity: '32000' })
//
// Oct 7: `party` ({ kind: 'vendor', code, name }) and `dims` (the report
// filter lists - departments, vendor, customer, employee, project, item,
// journals) narrow the lines too, and show as chips over them.
//
// Call of 10/27 with Charmi, item 17: the same call, two optional fields more -
// `entities` (several, where `entity` is one) and `department` - and a drill
// with no account (a total: its window `to` only) opens every line of it.
//
// Oct 23 (Neil, item 05): `reports` is the Report Center (the catalogue), so
// a drill or a search lands on the statements screen itself, opened on the
// Income Statement as `reports` used to open it.
export const STATEMENTS_SUB = 'rpt-pnl';

let pending = null;

export function requestReportDrill(detail) {
  pending = { ...detail };
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'accounting', sub: STATEMENTS_SUB } }));
  window.dispatchEvent(new CustomEvent('nexus:accounting-drill', { detail: pending }));
}

// The dashboard's Find a Transaction tile (Oct 1) hands the ledger the words
// typed and, when a row was tapped, the entry to open on top of the results.
// Same parking spot and events as a drill-down, so ReportsTab's one listener
// takes both.
//
//   requestLedgerSearch({ q: 'sunbelt 2840', entryId: 'e1', entryNo: 'IA-1293173' })

export function requestLedgerSearch({ q, entryId = null, entryNo = '' }) {
  requestReportDrill({ q: (q || '').trim(), entryId, entryNo });
}

// Accounting call 10/23, item 07 (Viral: "if we go back later, then again we
// are in the profit and loss account. So instead of that, where we were"): a
// screen that opens ledger lines can say where Back goes - `back: { label,
// sub }` on the drill - and park how it looked (the open record, its filters,
// the page and scroll) under its own name. Back on the lines returns to that
// screen, which takes the parked look when it mounts. Kept in sessionStorage
// so a reload of the lines still finds its way back.
const RETURN_KEY = 'nexus-acct-drill-return';

export function parkDrillReturn(screen, state) {
  try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ screen, state })); } catch { /* private mode: Back still goes to the screen */ }
}

/** The look parked by `screen`, taken once (the next visit opens as usual). */
export function takeDrillReturn(screen) {
  try {
    const v = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null');
    if (!v || v.screen !== screen) return null;
    sessionStorage.removeItem(RETURN_KEY);
    return v.state || null;
  } catch { return null; }
}

export function takePendingDrill() {
  const p = pending;
  pending = null;
  return p;
}

// Oct 23 (item 05): a memorized report opened from the Report Center. The
// screen that shows it (Reports for a statement, the Report Builder for a
// builder report) is not mounted yet, so the report waits here and that
// screen takes it when it mounts. `builder` says which screen may take it.
let parked = null;

export function parkSavedReport(report, builder = false) {
  parked = report ? { report, builder: !!builder } : null;
}

/** The report waiting for this screen, left in place (a state initializer may run twice). */
export function peekParkedReport(builder = false) {
  return parked && parked.builder === !!builder ? parked.report : null;
}

/** Done with it: the next visit to the screen opens as usual. */
export function clearParkedReport(report) {
  if (parked && parked.report === report) parked = null;
}
