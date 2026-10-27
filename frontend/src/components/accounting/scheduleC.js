import { formatDate } from '../../lib/datetime';
import { fetchStatement } from './reportModel';

// Accounting -> Reports -> Schedule C (Draft) (Neil, Viral, 10/27 triage item
// 18; the 10/23 meeting: "map each and every account number ... with
// whatever the mapping code we have", "change the entity ... automatically
// gives you what to put in line one, line two"). A first draft for review:
// the income statement of the entity picked, each account added into the
// IRS Schedule C (Form 1040) line it maps to - Part I income (lines 1-7),
// Part II expenses (lines 8-27b, 28 and 29), line 30 and line 31.
//
// The mapping is kept in Nexus (accounting_tax_lines, routers/
// accounting_tax_lines.py): an entity's own line for an account, else the
// line set for every entity, else a line suggested from the account's name
// and number. An account none of those place is listed under Not Mapped for
// review and adds into no line. Nothing is written to Intacct.
//
// Later, not in this draft: Schedule E, Form 4562 (asset depreciation) and
// the 1040, 1120, 1120-S and 1065 returns. Loaded on first use (runReport).

export const FORM = 'schedule_c';
// part: 1 income, 2 expenses, 3 after line 29. sign: +1 adds income, -1 adds expense (shown positive).
export const SCHEDULE_C_LINES = [
  { line: '1', label: 'Gross receipts or sales', part: 1, sign: 1 },
  { line: '2', label: 'Returns and allowances', part: 1, sign: -1 },
  { line: '4', label: 'Cost of goods sold', part: 1, sign: -1 },
  { line: '6', label: 'Other income', part: 1, sign: 1 },
  { line: '8', label: 'Advertising', part: 2, sign: -1 },
  { line: '9', label: 'Car and truck expenses', part: 2, sign: -1 },
  { line: '10', label: 'Commissions and fees', part: 2, sign: -1 },
  { line: '11', label: 'Contract labor', part: 2, sign: -1 },
  { line: '12', label: 'Depletion', part: 2, sign: -1 },
  { line: '13', label: 'Depreciation and section 179 expense deduction', part: 2, sign: -1 },
  { line: '14', label: 'Employee benefit programs', part: 2, sign: -1 },
  { line: '15', label: 'Insurance (other than health)', part: 2, sign: -1 },
  { line: '16a', label: 'Interest - mortgage (paid to banks, etc.)', part: 2, sign: -1 },
  { line: '16b', label: 'Interest - other', part: 2, sign: -1 },
  { line: '17', label: 'Legal and professional services', part: 2, sign: -1 },
  { line: '18', label: 'Office expense', part: 2, sign: -1 },
  { line: '19', label: 'Pension and profit-sharing plans', part: 2, sign: -1 },
  { line: '20a', label: 'Rent or lease - vehicles, machinery, and equipment', part: 2, sign: -1 },
  { line: '20b', label: 'Rent or lease - other business property', part: 2, sign: -1 },
  { line: '21', label: 'Repairs and maintenance', part: 2, sign: -1 },
  { line: '22', label: 'Supplies', part: 2, sign: -1 },
  { line: '23', label: 'Taxes and licenses', part: 2, sign: -1 },
  { line: '24a', label: 'Travel', part: 2, sign: -1 },
  { line: '24b', label: 'Deductible meals', part: 2, sign: -1 },
  { line: '25', label: 'Utilities', part: 2, sign: -1 },
  { line: '26', label: 'Wages (less employment credits)', part: 2, sign: -1 },
  { line: '27a', label: 'Energy efficient commercial bldgs deduction', part: 2, sign: -1 },
  { line: '27b', label: 'Other expenses', part: 2, sign: -1 },
  { line: '30', label: 'Expenses for business use of your home', part: 3, sign: -1 },
];
export const SKIP = 'skip';
const BY_LINE = new Map(SCHEDULE_C_LINES.map((l) => [l.line, l]));
/** "Line 8 - Advertising"; "Not on Schedule C" for skip. */
export const lineText = (line) => (line === SKIP ? 'Not on Schedule C' : BY_LINE.has(line) ? `Line ${line} - ${BY_LINE.get(line).label}` : '');

const INCOME = new Set(['revenue', 'other_income']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The line an expense account's name points to, first match wins - so
// "health insurance" is a benefit before it is insurance, "payroll tax" a
// tax before it is wages, "equipment rent" 20a before rent is 20b.
const EXPENSE_WORDS = [
  [/home office|business use of (the )?home/, '30'],
  [/energy efficient|\b7205\b/, '27a'],
  [/depreciation|amortization|section 179/, '13'],
  [/depletion/, '12'],
  [/advertis|marketing|promotion/, '8'],
  [/health|medical|dental|vision|employee benefit|benefits/, '14'],
  [/401\s?k|pension|profit.?sharing|retirement/, '19'],
  [/insurance/, '15'],
  [/mortgage interest|interest.*mortgage/, '16a'],
  [/interest/, '16b'],
  [/legal|attorney|professional|accounting|audit|bookkeep|tax prep|consult/, '17'],
  [/commission/, '10'],
  [/contract labor|contractor|subcontract|1099/, '11'],
  [/payroll tax|property tax|taxes|license|permit|\btax\b/, '23'],
  [/wage|salar|payroll|bonus/, '26'],
  [/(equipment|vehicle|machinery|car|truck).*(rent|lease)|(rent|lease).*(equipment|vehicle|machinery)/, '20a'],
  [/\brent\b|\blease\b|rental expense/, '20b'],
  [/auto|vehicle|\bcar\b|truck|mileage|fuel|gasoline|parking|toll/, '9'],
  [/repair|maintenance|\br ?& ?m\b/, '21'],
  [/meal|entertainment/, '24b'],
  [/travel|airfare|hotel|lodging/, '24a'],
  [/utilit|electric|water|sewer|trash|garbage|telephone|phone|internet|cable/, '25'],
  [/office|postage|software|subscription|computer|printing|stationery/, '18'],
  [/suppl/, '22'],
];

/**
 * A suggested line for one income statement account ({ code, title,
 * section }), or '' when its name says nothing a line can be told from.
 * Revenue is line 1 (returns, allowances, refunds and discounts line 2),
 * other income line 6, cost of sales line 4; an expense is read from its name.
 */
export function suggestLine({ title = '', section = '' } = {}) {
  const t = String(title || '').toLowerCase();
  if (section === 'revenue') return /return|allowance|refund|discount/.test(t) ? '2' : '1';
  if (section === 'other_income') return '6';
  if (section === 'cogs') return '4';
  if (section !== 'expense' && section !== 'other_expense') return '';
  if (/income tax|federal tax|state tax|owner|draw|distribution/.test(t)) return '';
  const hit = EXPENSE_WORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : '';
}

/**
 * The line an account adds into and where that came from: the entity's own
 * mapping, the mapping for every entity, the suggestion, or nothing.
 * `maps` = { entity: { code: line }, all: { code: line } }.
 * Returns { line, source: 'entity' | 'all' | 'suggested' | '' }.
 */
export function lineFor(account, maps = {}) {
  const code = account.code;
  if (code && maps.entity?.[code]) return { line: maps.entity[code], source: 'entity' };
  if (code && maps.all?.[code]) return { line: maps.all[code], source: 'all' };
  const s = suggestLine(account);
  return s ? { line: s, source: 'suggested' } : { line: '', source: '' };
}

/** The saved rows (GET /accounting/tax-lines) as { entity, all } maps of code -> line. */
export function mapsOf(saved, entity = '') {
  const maps = { entity: {}, all: {} };
  (saved || []).forEach((r) => {
    if (!r?.accountNo || !r.line) return;
    if (!r.entity) maps.all[r.accountNo] = r.line;
    else if (r.entity === entity) maps.entity[r.accountNo] = r.line;
  });
  return maps;
}

/**
 * Lay Schedule C out from the income statement's sections ([{ key, accounts:
 * [{ account_no, title, amount }] }], amounts signed as the statement shows
 * them) and the mapping. `drill` = the amount column's window.
 * Returns { columns, rows, summary, notes, mapRows, labelHead, startFolded }.
 * mapRows: every account with activity, for the Line Mapping editor:
 *   { code, title, section, amount, line, source, suggested }.
 */
export function scheduleCLayout(sections, maps, { drill = null, label = 'Amount' } = {}) {
  const accounts = [];
  (sections || []).forEach((s) => (s.accounts || []).forEach((a) => {
    const amount = round2(a.amount);
    if (!amount) return;
    accounts.push({ code: a.account_no || '', title: a.title || '', section: s.key, amount, income: INCOME.has(s.key) ? amount : -amount });
  }));
  accounts.sort((x, y) => x.code.localeCompare(y.code, 'en-US', { numeric: true }));
  const mapRows = accounts.map((a) => ({ code: a.code, title: a.title, section: a.section, amount: a.amount, ...lineFor(a, maps), suggested: suggestLine(a) }));
  const byLine = new Map();
  mapRows.forEach((m, i) => {
    const key = m.line || '';
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push({ ...accounts[i], source: m.source });
  });
  const total = (line) => {
    const def = BY_LINE.get(line);
    return round2((byLine.get(line) || []).reduce((s, a) => s + def.sign * a.income, 0));
  };
  const L = Object.fromEntries(SCHEDULE_C_LINES.map((l) => [l.line, total(l.line)]));
  const l3 = round2(L['1'] - L['2']);
  const l5 = round2(l3 - L['4']);
  const l7 = round2(l5 + L['6']);
  const l28 = round2(SCHEDULE_C_LINES.filter((l) => l.part === 2).reduce((s, l) => s + L[l.line], 0));
  const l29 = round2(l7 - l28);
  const l31 = round2(l29 - L['30']);

  const rows = [];
  const SOURCE = { entity: 'Mapped for this entity', all: 'Mapped for every entity', suggested: 'Suggested from the account name - confirm in Line Mapping' };
  const lineRows = (line, label, list, value) => {
    const group = `L${line}`;
    rows.push({ kind: 'group', group, label, count: list.length, values: [''], totals: [value], noDrill: true });
    list.forEach((a) => rows.push({ kind: 'account', group, code: a.code, title: a.source === 'suggested' ? `${a.title} (suggested)` : a.title, match: label, values: [line === SKIP || !line ? a.amount : round2(BY_LINE.get(line).sign * a.income)], hint: SOURCE[a.source] || '' }));
    if (list.length) rows.push({ kind: 'subtotal', group, label: `Total ${label}`, values: [value], noDrill: true });
  };
  const formLine = (l) => lineRows(l.line, lineText(l.line), byLine.get(l.line) || [], L[l.line]);
  const computed = (label, value, kind = 'subtotal') => rows.push({ kind, label, values: [value], noDrill: true, ...(kind === 'grand' ? { tone: true } : {}) });
  const heading = (label) => rows.push({ kind: 'section', section: label, label, count: 0, values: [''] });

  heading('Part I - Income');
  ['1', '2'].forEach((x) => formLine(BY_LINE.get(x)));
  computed('Line 3 - Subtract line 2 from line 1', l3);
  formLine(BY_LINE.get('4'));
  computed('Line 5 - Gross profit', l5);
  formLine(BY_LINE.get('6'));
  computed('Line 7 - Gross income', l7);
  heading('Part II - Expenses');
  SCHEDULE_C_LINES.filter((l) => l.part === 2).forEach(formLine);
  computed('Line 28 - Total expenses', l28);
  computed('Line 29 - Tentative profit or (loss)', l29);
  formLine(BY_LINE.get('30'));
  computed('Line 31 - Net profit or (loss)', l31, 'grand');
  const unmapped = byLine.get('') || [];
  const skipped = byLine.get(SKIP) || [];
  if (unmapped.length || skipped.length) {
    heading('For Review - Not in the Lines Above');
    if (unmapped.length) lineRows('', 'Not Mapped - Pick a Line in Line Mapping', unmapped, round2(unmapped.reduce((s, a) => s + a.amount, 0)));
    if (skipped.length) lineRows(SKIP, 'Not on Schedule C', skipped, round2(skipped.reduce((s, a) => s + a.amount, 0)));
  }
  const suggested = mapRows.filter((m) => m.source === 'suggested').length;
  const notes = [
    'Draft for review, not a filed return. Each account adds into the line mapped for this entity, else the line mapped for every entity, else a line suggested from its name and number. Line 30 holds only accounts mapped to it (Form 8829 is not worked out here).',
    ...(unmapped.length ? [`${unmapped.length} ${unmapped.length === 1 ? 'account is' : 'accounts are'} not mapped and add into no line - see For Review, or Line Mapping.`] : []),
    ...(suggested ? [`${suggested} ${suggested === 1 ? 'account uses a suggested line' : 'accounts use a suggested line'} - confirm or change them in Line Mapping.`] : []),
    'Schedule E, Form 4562 (asset depreciation) and the 1040, 1120, 1120-S and 1065 returns come later.',
  ];
  return {
    columns: [{ key: 'amount', label, type: 'amount', drill }], rows, notes, mapRows, labelHead: 'Line / Account', startFolded: true,
    summary: [
      { label: 'Gross Income (Line 7)', amount: l7 },
      { label: 'Total Expenses (Line 28)', amount: l28 },
      { label: 'Net Profit (Line 31)', amount: l31, tone: l31 >= 0 ? 'good' : 'bad' },
      { label: 'Not Mapped', value: String(unmapped.length) },
    ],
    lineTotals: { ...L, 3: l3, 5: l5, 7: l7, 28: l28, 29: l29, 31: l31 },
  };
}

/** The mapping scope of a config: one entity picked = that entity, else every entity (''). */
export const mapEntityOf = (config) => (config?.entities?.length === 1 ? config.entities[0] : '');

/** Read and lay out Schedule C for one config (see runReport). */
export async function scheduleC(api, config, book) {
  const range = { from: config.from, to: config.to };
  const entity = mapEntityOf(config);
  const [statement, saved] = await Promise.all([
    fetchStatement(api, { ...config, report: 'pnl' }, range, book),
    api.getAccountingTaxLines(FORM, entity).then((d) => d?.lines || []),
  ]);
  const yearly = config.from.slice(5) === '01-01' && config.to.slice(5) === '12-31' && config.from.slice(0, 4) === config.to.slice(0, 4);
  const label = yearly ? `Tax Year ${config.from.slice(0, 4)}` : `${formatDate(config.from)} - ${formatDate(config.to)}`;
  const out = scheduleCLayout(statement?.sections || [], mapsOf(saved, entity), { drill: { from: config.from, to: config.to, book }, label });
  return { org: statement?.org || '', generatedAt: statement?.generated_at || '', mode: 'single', pickable: [], mapEntity: entity, ...out };
}
