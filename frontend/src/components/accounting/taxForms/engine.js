// Accounting -> Reports -> Tax: the ONE way a tax form is laid out from the
// books (Charmi, Teams 11/19/2026: "We need Sch C, Sch E, 1040, 1065, form
// 568, 1120"; Neil, 11/17: "Tax extraction into tax forms from data"). It
// grew out of the Schedule C draft of 10/27 (triage item 18) and keeps its
// rules: the figures are the ledger's, read through the accounting proxy like
// every statement; which line an account adds into is the mapping kept in
// Nexus (accounting_tax_lines, routers/accounting_tax_lines.py) - an entity's
// own line, else the line for every entity, else a line suggested from the
// account's name - and an account none of those place is listed for review,
// never dropped. Nothing is written to Intacct. A DRAFT working paper for the
// preparer, never a filed return.
//
// Each form is one data file beside this one (schedule_c.json, ...): its tax
// year, its reports, each report's rows in the form's order - a heading, a
// mapped line (`sign` +1 income / -1 deduction, `group` for sums), a worked
// out line (`calc`: line ids, "-" to subtract, "@group:<g>", "@net",
// "@skipnet", "@unmappednet", "@income", "@pos:<line>", "@neg:<line>"), a fee
// (`fee` + the report's `feeTiers`), a fixed amount, a line from another form
// (`from`, the 1040) or a line that is not from the books (`manual`) - and
// the suggestion rules. A line list changes in its file only; the API's
// copy of the mappable lines (backend/tax_forms.py) is held to it by
// test_tax_forms.py.
import scheduleC from './schedule_c.json';
import scheduleE from './schedule_e.json';
import form1065 from './form_1065.json';
import form1120 from './form_1120.json';
import ca568 from './ca_568.json';
import form1040 from './form_1040.json';

export const FORMS = Object.fromEntries([scheduleC, scheduleE, form1065, form1120, ca568, form1040].map((f) => [f.form, f]));
export const SKIP = 'skip';
const INCOME = new Set(['revenue', 'other_income']);
const PL = new Set(['revenue', 'other_income', 'cogs', 'expense', 'other_expense']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Report key -> { form, report } for every tax report. */
export const TAX_REPORTS = Object.fromEntries(Object.values(FORMS).flatMap((f) => f.reports.map((r) => [r.key, { form: f, report: r }])));
export const isTaxReport = (key) => !!TAX_REPORTS[key];

// ── Line names ───────────────────────────────────────────────────────────────
// Each row knows the heading above it, whose `prefix` names the schedule
// ("Schedule K Line 5 - Interest income").
function indexRows(report) {
  if (report._index) return report._index;
  const byLine = new Map();
  let prefix = '';
  let heading = '';
  report.rows.forEach((r) => {
    if (r.heading) { prefix = r.prefix || ''; heading = r.heading; return; }
    byLine.set(r.line, { ...r, prefix, heading });
  });
  Object.defineProperty(report, '_index', { value: byLine, enumerable: false });
  return byLine;
}
const textOf = (def) => {
  const num = def.num ?? def.line;
  return num === '-' ? def.label.charAt(0).toUpperCase() + def.label.slice(1) : `${def.prefix || ''}Line ${num} - ${def.label}`;
};
/** "Line 8 - Advertising", "Schedule K Line 5 - Interest income"; "Not on Schedule C" for skip. */
export function lineText(form, line) {
  if (line === SKIP) return `Not on ${form.title}`;
  for (const r of form.reports) {
    const def = indexRows(r).get(line);
    if (def) return textOf(def);
  }
  const ret = (form.returns || []).find((x) => x.line === line);
  return ret ? ret.label : '';
}
/** The lines an account may be mapped to on one report, under their headings: [{ heading, lines: [{ line, text }] }]. */
export function lineChoices(form, report) {
  if (report.basis === 'returns') return [{ heading: 'Files On', lines: (form.returns || []).map((r) => ({ line: r.line, text: r.label })) }];
  const out = [];
  let cur = null;
  report.rows.forEach((r) => {
    if (r.heading) { cur = { heading: r.heading, prefix: r.prefix || '', lines: [] }; out.push(cur); return; }
    if (r.sign == null) return;
    if (!cur) { cur = { heading: form.title, prefix: '', lines: [] }; out.push(cur); }
    cur.lines.push({ line: r.line, text: textOf({ ...r, prefix: cur.prefix }) });
  });
  return out.filter((g) => g.lines.length);
}
/** Every mappable line of a form, all its reports (what the API accepts). */
export const mappableLines = (form) => [...new Set([
  ...form.reports.flatMap((r) => r.rows.filter((x) => x.sign != null).map((x) => x.line)),
  ...(form.returns || []).map((x) => x.line),
  SKIP,
])];

// ── Suggestions ──────────────────────────────────────────────────────────────
const RX = new Map();
const rx = (s) => { if (!RX.has(s)) RX.set(s, new RegExp(s)); return RX.get(s); };
/** Whether an entity's books read as rental real estate: most of its revenue is on accounts named for rent. */
export function rentalMode(form, sections) {
  if (!form.rental) return false;
  let rent = 0;
  let all = 0;
  (sections || []).filter((s) => s.key === 'revenue').forEach((s) => (s.accounts || []).forEach((a) => {
    const v = Number(a.amount) || 0;
    if (v <= 0) return;
    all += v;
    if (rx(form.rental).test(String(a.title || '').toLowerCase())) rent += v;
  }));
  return all > 0 && rent / all >= 0.5;
}
/**
 * A suggested line for one account ({ title, section }) on a form, or '' when
 * its name says nothing a line can be told from. `rental` picks the form's
 * rental real estate rules where it has them.
 */
export function suggestLine(form, { title = '', section = '' } = {}, rental = false) {
  const s = form.suggest || {};
  const t = String(title || '').toLowerCase();
  if (PL.has(section) && s.never && rx(s.never).test(t)) return '';
  const pick = (set) => set?.[section] || (section === 'other_expense' ? set?.expense : null);
  const rules = (rental && pick(s.rental)) || pick(s);
  if (!rules) return '';
  const hit = rules.find(([re]) => !re || rx(re).test(t));
  return hit ? hit[1] : '';
}
/** The saved rows (GET /accounting/tax-lines) as { entity, all } maps of account -> line. */
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
 * The line an account adds into and where that came from: the entity's own
 * mapping, the mapping for every entity, the suggestion, or nothing.
 * Returns { line, source: 'entity' | 'all' | 'suggested' | '' }.
 */
export function lineFor(form, account, maps = {}, rental = false) {
  const code = account.code;
  if (code && maps.entity?.[code]) return { line: maps.entity[code], source: 'entity' };
  if (code && maps.all?.[code]) return { line: maps.all[code], source: 'all' };
  const s = suggestLine(form, account, rental);
  return s ? { line: s, source: 'suggested' } : { line: '', source: '' };
}

// ── One column of figures ────────────────────────────────────────────────────
// sections: the statement's [{ key, accounts: [{ account_no, title, amount }] }],
// amounts as the statement shows them (an expense positive, a liability positive).
function accountsOf(sections, basis) {
  const out = [];
  (sections || []).forEach((s) => (s.accounts || []).forEach((a) => {
    const amount = round2(a.amount);
    if (!amount) return;
    // The income statement's effect on income; a balance keeps its own sign.
    const effect = basis === 'bs' ? amount : (INCOME.has(s.key) ? amount : -amount);
    out.push({ code: a.account_no || '', title: a.title || '', section: s.key, amount, effect });
  }));
  return out.sort((x, y) => (x.code || '~').localeCompare(y.code || '~', 'en-US', { numeric: true }) || x.title.localeCompare(y.title));
}
const keyOf = (a) => a.code || `~${a.title}`;

function placeColumn(form, report, col) {
  const accounts = accountsOf(col.sections, report.basis);
  const rental = report.basis === 'pl' && rentalMode(form, col.sections);
  const defs = indexRows(report);
  const placed = accounts.map((a) => ({ ...a, ...lineFor(form, a, col.maps, rental), suggested: suggestLine(form, a, rental) }));
  // An account mapped to a line this report does not show (a Schedule L
  // line on page 1's report, or the other way) belongs to the other report
  // of the same form: it neither counts here nor waits for review.
  const elsewhere = (line) => line && line !== SKIP && !defs.has(line) && mappableLines(form).includes(line);
  return { accounts: placed.filter((a) => !elsewhere(a.line)), rental };
}

// Works out every line of one column. `cols` = the other columns' results
// (for @pos / @neg on a Total column).
function evaluate(report, placed, { total = false, perCol = [] } = {}) {
  const defs = indexRows(report);
  const mapped = new Map();
  placed.accounts.forEach((a) => {
    const def = defs.get(a.line);
    if (!def || def.sign == null) return;
    mapped.set(a.line, round2((mapped.get(a.line) || 0) + (report.basis === 'bs' ? a.amount : def.sign * a.effect)));
  });
  const sumOf = (pred) => round2(placed.accounts.filter(pred).reduce((s, a) => s + a.effect, 0));
  const special = {
    '@net': () => sumOf(() => true),
    '@skipnet': () => sumOf((a) => a.line === SKIP),
    '@unmappednet': () => sumOf((a) => !a.line),
    '@income': () => round2(placed.accounts.filter((a) => INCOME.has(a.section) && a.line !== SKIP).reduce((s, a) => s + a.amount, 0)),
  };
  const memo = new Map();
  const value = (line, seen = new Set()) => {
    if (memo.has(line)) return memo.get(line);
    const def = defs.get(line);
    let v;
    if (!def) v = 0;
    else if (def.sign != null) v = mapped.get(line) || 0;
    else if (def.fixed != null) v = def.fixed;
    else if (def.fee) {
      const base = value(def.fee, seen);
      const tier = (report.feeTiers || []).find(([limit]) => limit == null || base < limit);
      v = tier ? tier[1] : 0;
    } else if (def.calc) {
      if (seen.has(line)) return 0;
      seen.add(line);
      v = round2(def.calc.reduce((s, tok) => {
        const neg = tok.startsWith('-');
        const t = neg ? tok.slice(1) : tok;
        let x;
        if (t.startsWith('@group:')) {
          const g = t.slice(7);
          x = round2([...defs.values()].filter((d) => d.group === g && d.sign != null).reduce((acc, d) => acc + (mapped.get(d.line) || 0), 0));
        } else if (t.startsWith('@pos:') || t.startsWith('@neg:')) {
          const ref = t.slice(5);
          const vals = total ? perCol.map((c) => c.get(ref) || 0) : [value(ref, seen)];
          x = round2(vals.filter((n) => (t.startsWith('@pos:') ? n > 0 : n < 0)).reduce((acc, n) => acc + n, 0));
        } else if (special[t]) x = special[t]();
        else x = value(t, seen);
        return s + (neg ? -x : x);
      }, 0));
    } else return null;        // manual / from another form: not a figure of this column
    memo.set(line, v);
    return v;
  };
  const out = new Map();
  defs.forEach((def, line) => { const v = value(line); if (v != null) out.set(line, v); });
  return out;
}

// ── The report ───────────────────────────────────────────────────────────────
const SOURCE = { entity: 'Mapped for this entity', all: 'Mapped for every entity', suggested: 'Suggested from the account name - confirm in Line Mapping' };

/**
 * Lay a form's report out from its columns:
 *   cols = [{ key, label, drill, sections, maps }]
 *   opts = { total: true } adds a Total column (Schedule E); mapMaps = the
 *   Line Mapping scope's maps (default the first column's).
 * Returns { columns, rows, notes, mapRows, labelHead, startFolded, summary, lineTotals, taxForm }.
 */
export function layoutForm(form, report, cols, { total = false, mapMaps = null, totalDrill = null } = {}) {
  const defs = indexRows(report);
  const placedCols = cols.map((c) => placeColumn(form, report, c));
  const perCol = placedCols.map((p) => evaluate(report, p));
  const withTotal = total && cols.length > 1;
  // The Total column: every account of every column, the lines worked out on the sums.
  const totalPlaced = withTotal ? { accounts: placedCols.flatMap((p) => p.accounts) } : null;
  const totalVals = withTotal ? evaluate(report, totalPlaced, { total: true, perCol }) : null;
  const n = cols.length + (withTotal ? 1 : 0);
  const blanks = () => Array(n).fill('');
  const colVals = (line) => {
    const def = defs.get(line);
    const out = perCol.map((m) => (def?.totalOnly && withTotal ? '' : (m.has(line) ? m.get(line) : '')));
    if (withTotal) out.push(totalVals.has(line) ? totalVals.get(line) : '');
    return out;
  };
  const last = withTotal ? totalVals : perCol[0] || new Map();

  // account rows by line: key -> { info, values[] }
  const byLine = new Map();
  placedCols.forEach((p, ci) => p.accounts.forEach((a) => {
    const line = a.line || '';
    if (!byLine.has(line)) byLine.set(line, new Map());
    const list = byLine.get(line);
    const k = keyOf(a);
    if (!list.has(k)) list.set(k, { ...a, values: blanks() });
    const def = defs.get(line);
    const shown = !line || line === SKIP || report.basis === 'bs' || !def ? a.amount : round2(def.sign * a.effect);
    const row = list.get(k);
    row.values[ci] = shown;
    if (withTotal) row.values[n - 1] = round2((Number(row.values[n - 1]) || 0) + shown);
  }));

  const rows = [];
  const heading = (label) => rows.push({ kind: 'section', section: label, label, count: 0, values: blanks() });
  const lineRows = (line, label, list, totals) => {
    const group = `L${line}`;
    rows.push({ kind: 'group', group, label, count: list.length, values: blanks(), totals, noDrill: true });
    list.forEach((a) => rows.push({ kind: 'account', group, code: a.code, title: a.source === 'suggested' ? `${a.title} (suggested)` : a.title, match: label, values: a.values, hint: SOURCE[a.source] || '', ...(a.code ? {} : { noDrill: true }) }));
    if (list.length) rows.push({ kind: 'subtotal', group, label: `Total ${label}`, values: totals, noDrill: true });
  };
  report.rows.forEach((r) => {
    if (r.heading) { heading(r.heading); return; }
    const def = defs.get(r.line);
    const text = textOf(def);
    if (r.sign != null) { lineRows(r.line, text, [...(byLine.get(r.line) || new Map()).values()], colVals(r.line)); return; }
    if (r.manual) { rows.push({ kind: 'account', code: '', title: `${text} - ${r.manual}`, values: blanks(), noDrill: true, hint: 'Not from the books' }); return; }
    if (r.from) return;       // the 1040's lines from Schedule C / E are laid out by tax1040
    rows.push({ kind: r.grand ? 'grand' : 'subtotal', label: text, values: colVals(r.line), noDrill: true, ...(r.grand ? { tone: true } : {}) });
  });
  const sumRows = (list) => {
    const t = blanks().map(() => 0);
    list.forEach((a) => a.values.forEach((v, i) => { t[i] = round2(t[i] + (Number(v) || 0)); }));
    return t;
  };
  const unmapped = [...(byLine.get('') || new Map()).values()];
  const skipped = [...(byLine.get(SKIP) || new Map()).values()];
  if (unmapped.length || skipped.length) {
    heading('For Review - Not in the Lines Above');
    if (unmapped.length) lineRows('', 'Not Mapped - Pick a Line in Line Mapping', unmapped, sumRows(unmapped));
    if (skipped.length) lineRows(SKIP, lineText(form, SKIP), skipped, sumRows(skipped));
  }

  // The Line Mapping editor's rows: every account with activity, in the
  // editor's scope (one entity, or every entity).
  const scopeMaps = mapMaps || cols[0]?.maps || {};
  const union = new Map();
  cols.forEach((c) => accountsOf(c.sections, report.basis).forEach((a) => {
    const k = keyOf(a);
    const cur = union.get(k);
    union.set(k, cur ? { ...cur, amount: round2(cur.amount + a.amount) } : a);
  }));
  const allSections = cols.flatMap((c) => c.sections || []);
  const rentalAll = report.basis === 'pl' && rentalMode(form, allSections);
  const mapRows = [...union.values()].filter((a) => a.code).map((a) => ({ code: a.code, title: a.title, section: a.section, amount: a.amount, ...lineFor(form, a, scopeMaps, rentalAll), suggested: suggestLine(form, a, rentalAll) }));

  const suggested = mapRows.filter((m) => m.source === 'suggested').length;
  const notes = [
    `Draft working paper for the preparer, not a filed return. ${form.about} Each account adds into the line mapped for its entity, else the line mapped for every entity, else a line suggested from its name.`,
    ...(report.notes || []),
    ...(unmapped.length ? [`${unmapped.length} ${unmapped.length === 1 ? 'account is' : 'accounts are'} not mapped and add into no line - see For Review, or Line Mapping.`] : []),
    ...(suggested ? [`${suggested} ${suggested === 1 ? 'account uses a suggested line' : 'accounts use a suggested line'} - confirm or change them in Line Mapping.`] : []),
  ];
  const lineTotals = Object.fromEntries([...last.entries()]);
  return {
    columns: [...cols.map((c) => ({ key: c.key, label: c.label, type: 'amount', drill: c.drill })), ...(withTotal ? [{ key: 'total', label: 'Total', type: 'amount', drill: totalDrill, emphasis: true }] : [])],
    rows, notes, mapRows, labelHead: 'Line / Account', startFolded: true,
    summary: [
      ...(report.summary || []).map(([label, line, tone]) => {
        const amount = lineTotals[line] ?? 0;
        return { label, amount, ...(tone ? { tone: amount >= 0 ? 'good' : 'bad' } : {}) };
      }),
      { label: 'Not Mapped', value: String(unmapped.length) },
    ],
    lineTotals,
    taxForm: { form: form.form, report: report.key },
  };
}
