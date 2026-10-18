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

// Before an export (PayrollTimecard's exportFile): WARN when people in the
// exported dates are not ready - never block. Any problem reading the check
// lets the export go ahead.
export async function confirmExportReadiness(start, end) {
  let report;
  try { report = await api.payrollReadiness(start); }
  catch { return true; }
  const n = (report?.rows || []).filter(r => !r.ready && (!end || r.periodStart <= end) && (!start || r.periodEnd >= start)).length;
  if (!n) return true;
  return dialog.confirm(`${n} ${n === 1 ? 'person is' : 'people are'} not ready - export anyway? Payroll Readiness on this screen lists who and why.`,
    { title: 'Payroll Readiness', confirmText: 'Export Anyway', cancelText: 'Cancel' });
}

export const SETTING_FIELDS = [
  ['variancePct', 'Variance (%)', 'Flag hours, overtime, leave or pay that moved more than this percent on the previous period or the schedule.'],
  ['varianceHours', 'Variance (Hours)', 'Or by more than this many hours.'],
  ['anomalyPct', 'Unusual Week (%)', 'A week this far from the person’s own 8-week average.'],
  ['anomalyHours', 'Unusual Week (Hours)', 'Or this many hours from it.'],
  ['otJumpHours', 'Overtime Jump (Hours)', 'Overtime up by more than this on the previous period.'],
  ['missingOutCount', 'Missing Clock-Outs', 'This many missing clock-outs in a period is flagged.'],
];
