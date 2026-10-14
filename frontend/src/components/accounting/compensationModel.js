// Accounting > Reporting > Employee Compensation (Neil, 10/15): the pure side
// of the report - hours, the views, the export table. The figures are added
// up by the backend (routers/accounting_compensation.py) from Time Clock's
// payroll card; nothing is computed a second way here.

/** Minutes -> hours, two decimals (a number, for the table and the export). */
export const hoursOf = (min) => Math.round((Number(min) || 0) / 60 * 100) / 100;

/** Months from "YYYY-MM" to "YYYY-MM", both counted (0 when either is not a month). */
export function monthsBetween(from, to) {
  if (!/^\d{4}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}$/.test(to || '')) return 0;
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

export const VIEWS = [
  { key: 'people', label: 'By Employee' },
  { key: 'company', label: 'By Company' },
  { key: 'department', label: 'By Department' },
];

// The hour columns, in order (each a minutes field from the backend).
export const HOUR_COLUMNS = [
  { key: 'regMin', label: 'Regular Hours' },
  { key: 'otMin', label: 'Overtime Hours' },
  { key: 'dtMin', label: 'Double Time Hours' },
  { key: 'sickMin', label: 'Sick Hours' },
  { key: 'vacationMin', label: 'Vacation Hours' },
  { key: 'personalMin', label: 'Personal Hours' },
];

export const payTypeLabel = (t) => (t === 'salary' ? 'Salary' : 'Hourly');
export const rateLabel = (p) => (p.payType === 'salary' ? 'per month' : 'per hour');

/** The rows of a view: people, or the totals by company / department. */
export function viewRows(data, view) {
  if (!data) return [];
  if (view === 'company') return data.byCompany || [];
  if (view === 'department') return data.byDepartment || [];
  return data.people || [];
}

/** Currencies on the report (wages in USD and INR are never added together). */
export const currenciesOf = (data) => [...new Set((data?.totals || []).map((t) => t.currency))];

/**
 * The view as a linesExport table for Excel / PDF / CSV. With one currency
 * the Totals line is live sums; with several, one plain Total line per
 * currency is written instead (a sum across currencies means nothing).
 */
export function compensationTable(data, view, { period = '' } = {}) {
  const totals = data?.totals || [];
  const multi = totals.length > 1;
  const hourCols = HOUR_COLUMNS.map((c) => ({ label: c.label, num: true, width: 80 }));
  let columns;
  let rows;
  let totalRows;
  if (view === 'people') {
    columns = [
      { label: 'Employee', num: false, width: 160 }, { label: 'Employee ID', num: false, width: 80 }, { label: 'Company', num: false, width: 140 },
      { label: 'Department', num: false, width: 110 }, { label: 'Title', num: false, width: 120 }, { label: 'Pay Type', num: false, width: 60 },
      { label: 'Currency', num: false, width: 55 }, { label: 'Rate', num: true, width: 80 }, ...hourCols, { label: 'Gross Wages', num: true, width: 100 },
    ];
    rows = (data?.people || []).map((p) => [p.name, p.employeeId, p.companyName, p.department, p.title, payTypeLabel(p.payType), p.currency, p.rate,
      ...HOUR_COLUMNS.map((c) => hoursOf(p[c.key])), p.wages]);
    totalRows = totals.map((t) => [multi ? `Total ${t.currency}` : 'Total', '', '', '', '', '', t.currency, '', ...HOUR_COLUMNS.map((c) => hoursOf(t[c.key])), t.wages]);
  } else {
    const head = view === 'company' ? 'Company' : 'Department';
    columns = [{ label: head, num: false, width: 180 }, { label: 'Currency', num: false, width: 60 }, { label: 'Employees', num: true, width: 70 }, ...hourCols, { label: 'Gross Wages', num: true, width: 100 }];
    rows = viewRows(data, view).map((g) => [g.label, g.currency, g.people, ...HOUR_COLUMNS.map((c) => hoursOf(g[c.key])), g.wages]);
    totalRows = totals.map((t) => [multi ? `Total ${t.currency}` : 'Total', t.currency, t.people, ...HOUR_COLUMNS.map((c) => hoursOf(t[c.key])), t.wages]);
  }
  const viewLabel = VIEWS.find((v) => v.key === view)?.label || '';
  return {
    title: `Employee Compensation - ${viewLabel}`,
    subtitle: `${period}  ·  Hours and wages from the Time Clock payroll card`,
    period: period.replace(/\//g, '-'),
    columns,
    rows: multi ? [...rows, ...totalRows] : rows,
    totals: multi ? null : (totalRows[0] || null),
  };
}

/** The ledger's payroll expense as a linesExport table. */
export function ledgerTable(ledger, { period = '' } = {}) {
  const head = ledger?.by === 'employee' ? 'Employee' : 'Department';
  return {
    title: `Payroll Expense on the Ledger - By ${head}`,
    subtitle: `${period}  ·  From the Nexus Accounting ledger`,
    period: period.replace(/\//g, '-'),
    columns: [{ label: head, num: false, width: 200 }, { label: 'Wages', num: true, width: 110 }, { label: 'Employer Taxes', num: true, width: 110 }, { label: 'Benefits', num: true, width: 110 }, { label: 'Total', num: true, width: 110 }],
    rows: (ledger?.rows || []).map((r) => [r.label, r.wages, r.taxes, r.benefits, r.total]),
    totals: ['Total', ledger?.totals?.wages ?? 0, ledger?.totals?.taxes ?? 0, ledger?.totals?.benefits ?? 0, ledger?.totals?.total ?? 0],
  };
}
