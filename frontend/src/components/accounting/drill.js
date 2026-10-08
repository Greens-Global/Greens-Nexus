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

let pending = null;

export function requestReportDrill(detail) {
  pending = { ...detail };
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'accounting', sub: 'reports' } }));
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

export function takePendingDrill() {
  const p = pending;
  pending = null;
  return p;
}
