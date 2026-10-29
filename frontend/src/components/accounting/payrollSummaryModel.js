import { PAYROLL_SUMMARY_EMPLOYEE_FROM_DESCRIPTION, PAYROLL_SUMMARY_SECTIONS } from './assumptions';

// Reports -> Payroll & People -> Payroll Summary (CR-09), free of React.
// The QuickBooks payroll is imported into the ledger as PYRJ journal entries
// (one entry per employee per pay date, each line carrying the employee and
// a payroll item's account - payrollConvert.js). This lays those postings out
// the way QuickBooks' Payroll Summary does: Gross Pay, Taxes Withheld,
// Deductions From Net Pay, Net Pay, Employer Taxes and Contributions and Total
// Payroll Cost, a column per employee and a Total - summed over the pay dates
// picked. The rows and their accounts are PAYROLL_SUMMARY_SECTIONS.
//
// Input rows are the buckets read split by employee: { account_no, title,
// bucket (employee id, '' = none on the line), debit, credit }. An account
// in sections of both sides (61903: the employee's deduction is a credit, the
// company's contribution a debit) is read one side per section; any other
// account is read net in its section's direction.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const NO_EMPLOYEE = '';

/** Parse the employee out of an import description: "Payroll 09/30/2026 - E-0185" -> "E-0185". */
export function employeeFromDescription(text, pattern = PAYROLL_SUMMARY_EMPLOYEE_FROM_DESCRIPTION) {
  if (!pattern) return '';
  const m = new RegExp(pattern, 'i').exec(String(text || '').trim());
  return m ? m[1].trim() : '';
}

/**
 * The summary: { employees: [{ key, name }], rows: [{ kind, key, label, account?, values: {emp: n}, total }],
 * unmapped: [{ account, title, debit, credit }], check }.
 * `rows` from the buckets read, `names` = { employeeKey: name } (the read's labels).
 */
export function summarize(rows, names = {}, sections = PAYROLL_SUMMARY_SECTIONS) {
  const sidesOf = new Map();
  sections.forEach((s) => s.accounts.forEach((a) => sidesOf.set(a, new Set([...(sidesOf.get(a) || []), s.side]))));
  const shared = new Set([...sidesOf].filter(([, sides]) => sides.size > 1).map(([a]) => a));
  const emps = new Map();
  const add = (map, k, v) => map.set(k, round2((map.get(k) || 0) + v));
  const byAccount = new Map();    // account -> { title, debit: Map(emp), credit: Map(emp) }
  (rows || []).forEach((r) => {
    const acct = String(r.account_no || '');
    if (!acct) return;
    const emp = String(r.bucket ?? NO_EMPLOYEE);
    if (!emps.has(emp)) emps.set(emp, { key: emp, name: emp === NO_EMPLOYEE ? 'No Employee on the Line' : names[emp] || emp });
    const a = byAccount.get(acct) || { title: r.title || '', debit: new Map(), credit: new Map() };
    add(a.debit, emp, Number(r.debit) || 0);
    add(a.credit, emp, Number(r.credit) || 0);
    byAccount.set(acct, a);
  });
  const employees = [...emps.values()].sort((x, y) => (x.key === NO_EMPLOYEE) - (y.key === NO_EMPLOYEE) || x.name.localeCompare(y.name, 'en-US'));
  const keys = employees.map((e) => e.key);
  const valueOf = (acct, side, emp) => {
    const a = byAccount.get(acct);
    if (!a) return 0;
    const d = a.debit.get(emp) || 0;
    const c = a.credit.get(emp) || 0;
    if (shared.has(acct)) return side === 'debit' ? d : c;
    return round2(side === 'debit' ? d - c : c - d);
  };
  const line = (kind, key, label, fn, extra = {}) => {
    const values = Object.fromEntries(keys.map((k) => [k, round2(fn(k))]));
    return { kind, key, label, values, total: round2(keys.reduce((s, k) => s + values[k], 0)), ...extra };
  };
  const out = [];
  const totals = {};
  sections.forEach((s) => {
    out.push({ kind: 'section', key: s.key, label: s.label });
    s.accounts.filter((a) => byAccount.has(a)).forEach((a) => {
      const r = line('account', `${s.key}-${a}`, `${a} ${byAccount.get(a).title}`.trim(), (k) => valueOf(a, s.side, k), { account: a, section: s.key });
      if (Object.values(r.values).some((v) => Math.abs(v) >= 0.005)) out.push(r);
    });
    totals[s.key] = (k) => s.accounts.reduce((sum, a) => sum + valueOf(a, s.side, k), 0);
    out.push(line('total', `${s.key}-total`, `Total ${s.label}`, totals[s.key], { section: s.key }));
    // QuickBooks prints Net Pay right after what comes out of gross.
    if (s.key === 'deductions') {
      out.push(line('net', 'net-pay', 'Net Pay', (k) => (totals.gross?.(k) || 0) - (totals.withheld?.(k) || 0) - (totals.deductions?.(k) || 0)));
    }
  });
  out.push(line('grand', 'cost', 'Total Payroll Cost', (k) => (totals.gross?.(k) || 0) + (totals.employer?.(k) || 0)));

  // Reconciliation to PYRJ: every dollar posted is in a row. Accounts no
  // section names are listed so the mapping can take them in.
  const mapped = new Set(sidesOf.keys());
  const unmapped = [...byAccount].filter(([a]) => !mapped.has(a)).map(([a, v]) => ({
    account: a, title: v.title, debit: round2([...v.debit.values()].reduce((s, x) => s + x, 0)), credit: round2([...v.credit.values()].reduce((s, x) => s + x, 0)),
  })).filter((u) => Math.abs(u.debit) >= 0.005 || Math.abs(u.credit) >= 0.005);
  const sum = (side) => round2([...byAccount.values()].reduce((s, a) => s + [...a[side].values()].reduce((x, y) => x + y, 0), 0));
  const debits = sum('debit');
  const credits = sum('credit');
  const unmappedNet = round2(unmapped.reduce((s, u) => s + u.debit - u.credit, 0));
  return {
    employees, rows: out, unmapped,
    check: { debits, credits, balanced: Math.abs(debits - credits) < 0.005, unmappedNet, reconciled: Math.abs(debits - credits) < 0.005 && !unmapped.length },
  };
}

/**
 * Lines with no employee on them (`lines` = every such PYRJ line, from the
 * ledger search) put under the employee their entry's description names.
 * Returns { rows, names, moved } - the buckets rows with the no-employee ones
 * replaced; a line whose description names nobody stays under no employee.
 */
export function resolveNoEmployee(rows, lines, names = {}) {
  const kept = (rows || []).filter((r) => String(r.bucket ?? '') !== NO_EMPLOYEE);
  const out = new Map();
  const more = { ...names };
  let moved = 0;
  (lines || []).forEach((l) => {
    if (String(l.employee_id || '').trim()) return;
    const who = employeeFromDescription(l.description);
    const key = who ? `desc:${who}` : NO_EMPLOYEE;
    if (who) { more[key] = `${who} (from the description)`; moved += 1; }
    const id = `${key}|${l.gl_code}`;
    const cur = out.get(id) || { account_no: String(l.gl_code || ''), title: l.account_name || '', bucket: key, debit: 0, credit: 0 };
    cur.debit = round2(cur.debit + (Number(l.debit) || 0));
    cur.credit = round2(cur.credit + (Number(l.credit) || 0));
    out.set(id, cur);
  });
  return { rows: [...kept, ...out.values()], names: more, moved };
}

/** The summary narrowed to some employees (the multi-select); totals follow. */
export function pickEmployees(summary, picked) {
  if (!picked || !picked.length) return summary;
  const keep = new Set(picked);
  const employees = summary.employees.filter((e) => keep.has(e.key));
  const rows = summary.rows.map((r) => {
    if (!r.values) return r;
    const values = Object.fromEntries(Object.entries(r.values).filter(([k]) => keep.has(k)));
    return { ...r, values, total: round2(Object.values(values).reduce((s, v) => s + v, 0)) };
  });
  return { ...summary, employees, rows, partial: true };
}

/** The accounts a summary row adds up: its own account, its section's, or Net Pay's / Total Payroll Cost's sections'. */
export function rowAccounts(row, sections = PAYROLL_SUMMARY_SECTIONS) {
  const of = (...keys) => keys.flatMap((k) => sections.find((s) => s.key === k)?.accounts || []);
  const list = row.account ? [row.account] : row.kind === 'total' ? of(row.section) : row.key === 'net-pay' ? of('gross', 'withheld', 'deductions') : row.key === 'cost' ? of('gross', 'employer') : [];
  return [...new Set(list)];
}

/** Whose lines a cell can open: an employee on the ledger (not "No Employee on the Line", not one read from a description). */
export const drillableEmployee = (key) => !!key && !String(key).startsWith('desc:');

/**
 * What a figure opens (call of 10/27 with Charmi, item 17: every amount drills):
 * { accounts, employees } - the row's accounts for those employees; `null`
 * employee keys (a Total over every employee) = no employee filter
 * (employees []). null when the lines cannot be told apart on the ledger.
 */
export function cellDrill(row, employeeKeys) {
  const accounts = rowAccounts(row);
  if (!accounts.length) return null;
  if (employeeKeys === null) return { accounts, employees: [] };
  const keys = employeeKeys.filter(drillableEmployee);
  return keys.length === employeeKeys.length && keys.length ? { accounts, employees: keys } : null;
}

/** Lay the summary out for the table and the exports: employees as columns (QuickBooks) or rows. Each cell's `drills` entry is cellDrill's. */
export function tableOf(summary, as = 'columns') {
  const shown = summary.employees.map((e) => e.key);
  const total = (r) => (summary.partial ? cellDrill(r, shown) : cellDrill(r, null));
  if (as === 'rows') {
    const lines = summary.rows.filter((r) => r.kind !== 'section' && r.kind !== 'account');
    return {
      columns: [{ key: 'employee', label: 'Employee' }, ...lines.map((r) => ({ key: r.key, label: r.label, num: true }))],
      rows: [
        ...summary.employees.map((e) => ({ kind: 'account', label: e.name, cells: lines.map((r) => r.values[e.key] || 0), drills: lines.map((r) => cellDrill(r, [e.key])) })),
        { kind: 'grand', label: 'Total', cells: lines.map((r) => r.total), drills: lines.map(total) },
      ],
    };
  }
  return {
    columns: [{ key: 'item', label: 'Payroll Item' }, ...summary.employees.map((e) => ({ key: e.key || '~none', label: e.name, num: true })), { key: 'total', label: 'Total', num: true }],
    rows: summary.rows.map((r) => (r.kind === 'section'
      ? { kind: 'section', label: r.label, cells: [] }
      : { kind: r.kind, label: r.label, cells: [...summary.employees.map((e) => r.values[e.key] || 0), r.total], drills: [...summary.employees.map((e) => cellDrill(r, [e.key])), total(r)] })),
  };
}
