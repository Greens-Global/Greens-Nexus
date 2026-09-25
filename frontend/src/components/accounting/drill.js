// Cross-tab drill-down into Accounting -> Reports (Neil, Sep 25: "add
// drilldown everywhere"). A widget on another tab (the Close tab's Current
// Balance, for one) asks for the lines behind an amount; the Reports tab is
// not mounted yet, so the request is parked here, the app is pointed at the
// tab, and ReportsTab picks it up when it mounts (or right away, through the
// event, when it is already on screen).
//
//   requestReportDrill({ account: '11452', accountName: 'GC Chase Chkg', from: '', to: '2026-08-31', entity: '32000' })

let pending = null;

export function requestReportDrill(detail) {
  pending = { ...detail };
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'accounting', sub: 'reports' } }));
  window.dispatchEvent(new CustomEvent('nexus:accounting-drill', { detail: pending }));
}

export function takePendingDrill() {
  const p = pending;
  pending = null;
  return p;
}
