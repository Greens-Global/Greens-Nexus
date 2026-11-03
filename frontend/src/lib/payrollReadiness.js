// Payroll Readiness (Oct 17 2026) - the list rules and the export warning,
// shared by components/PayrollReadiness.jsx and PayrollTimecard's exports.
import { api } from '../api';
import { dialog } from '../ui/dialog';

export const FILTERS = [
  ['all', 'All'],
  ['exceptions', 'Exceptions'],
  ['variance', 'Variance'],
  ['anomalies', 'Anomalies'],
];

// Which rows a filter shows. "All" = everyone with something to look at.
export function filterRows(rows, filter) {
  const list = rows || [];
  if (filter === 'exceptions') return list.filter(r => (r.exceptions || []).length);
  if (filter === 'variance') return list.filter(r => r.varianceFlags > 0);
  if (filter === 'anomalies') return list.filter(r => (r.anomalies || []).length);
  return list.filter(r => !r.ready || (r.exceptions || []).length || r.varianceFlags > 0 || (r.anomalies || []).length);
}

// The lines under a person: blocking exceptions first, then notes, flagged
// variance, anomalies.
export function issueLines(r) {
  const ex = r.exceptions || [];
  return [
    ...ex.filter(e => e.blocking).map(e => ({ kind: 'exception', text: e.label })),
    ...ex.filter(e => !e.blocking).map(e => ({ kind: 'note', text: e.label })),
    ...(r.variance || []).filter(v => v.flag).map(v => ({ kind: 'variance', text: v.reason })),
    ...(r.anomalies || []).map(a => ({ kind: 'anomaly', text: a.reason })),
  ];
}

// Before an export (PayrollTimecard's exportFile): WARN when people in what
// the export carries are not ready - never block. The server judges hourly
// people on every pay period overlapping the dates and salaried people on
// the month containing the first one (/payroll-readiness/export-check), so a
// salaried card's month export is checked on that month. `scope` narrows the
// check to the people the export actually holds - {company} for a company
// batch, {email} for one person (Charmi, 11/03/2026: a one-company IIF
// warned about all 28 people of every company). Any problem reading the
// check lets the export go ahead.
export async function confirmExportReadiness(start, end, scope = {}) {
  let report;
  try { report = await api.payrollReadinessExportCheck(start, end || start, scope.company || '', scope.email || ''); }
  catch { return true; }
  const n = new Set((report?.rows || []).filter(r => !r.ready).map(r => r.email)).size;
  if (!n) return true;
  const msg = scope.email
    ? 'This person is not ready - export anyway? Payroll Readiness on this screen says why.'
    : `${n} ${n === 1 ? 'person in this export is' : 'people in this export are'} not ready - export anyway? Payroll Readiness on this screen lists who and why.`;
  return dialog.confirm(msg, { title: 'Payroll Readiness', confirmText: 'Export Anyway', cancelText: 'Cancel' });
}

export const SETTING_FIELDS = [
  ['variancePct', 'Variance (%)', 'Flag hours, overtime, leave or pay that moved more than this percent on the previous period or the schedule.'],
  ['varianceHours', 'Variance (Hours)', 'Or by more than this many hours.'],
  ['anomalyPct', 'Unusual Week (%)', 'A week this far from the person’s own 8-week average.'],
  ['anomalyHours', 'Unusual Week (Hours)', 'Or this many hours from it.'],
  ['otJumpHours', 'Overtime Jump (Hours)', 'Overtime up by more than this on the previous period.'],
  ['missingOutCount', 'Missing Clock-Outs', 'This many missing clock-outs in a period is flagged.'],
];
