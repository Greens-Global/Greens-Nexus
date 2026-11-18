import { formatDate } from '../../lib/datetime';
import { REPORTS, entityText, periodOf, presetLabel, reportDef, resolveConfig } from './reportModel';
import { builderSummary, isBuilderConfig, isPublished } from './builderModel';

// What the Report Center lists (Oct 23, Neil, item 05), free of React for the
// tests: every standard report and screen the person's Reports menu holds,
// the statements the menu does not name, and the memorized and Report Builder
// reports they can see. See ReportCenter.jsx.

// Statements of REPORTS the menu does not list on their own, and where they
// belong; null = left out (the plain Budget vs. Actual is the menu's Year to
// Date and Month to Date already - one name, one row).
const EXTRA_HOME = { pnl: 'grp-financial', budget: null };
// What a standard entry is, under its name (10/27 items 16-18).
const DIM_ABOUT = (what, filter) => `One column per ${what} plus a Total, with the period, entity and export controls of the Income Statement. Filters > ${filter} limits which ones show.`;
export const STANDARD_ABOUT = {
  'rpt-pnl-customer': DIM_ABOUT('customer', 'Customer'),
  'rpt-pnl-job': `${DIM_ABOUT('job (the Intacct Project dimension)', 'Project-Job')}`,
  'rpt-pnl-department': DIM_ABOUT('department', 'Department'),
  'rpt-vendor-spend': 'What each vendor was paid for: cost of sales and expense lines by vendor, by period, every amount a click from its lines. Search vendors by name or number.',
  'report-builder': 'Build a report of your own: pick the GL accounts, entities and period, group accounts into named lines, then save, publish or share it.',
  packages: 'A named set of memorized reports built into one PDF with a cover and contents - the same set every quarter for a lender.',
  'rpt-pnl': 'Revenue less expenses for the period picked, by account, with the columns, book, entity and filter controls every statement has.',
  'rpt-balance-sheet': 'Assets, liabilities and equity as of a date, every balance a click from the ledger lines behind it.',
  'rpt-trial-balance': 'Every account\'s debit or credit balance as of a date (or for a range), checked to balance.',
  'rpt-pnl-t12': 'The Income Statement for the last twelve months, one column per month.',
  'rpt-pnl-ytd-py': 'The Income Statement for this year to date beside the same months of last year.',
  'rpt-pnl-mom': 'The Income Statement for this month beside last month.',
  'rpt-cash-flow': 'Where cash came from and went - operating, investing and financing - by the indirect method, ending at Cash Position.',
  'rpt-cash-position': 'The balance of every bank and cash account as of a date.',
  'rpt-general-ledger': 'Every posted line by account for the period, with opening and closing balances; each entry opens in full.',
  'rpt-bank-activity': 'One bank account\'s transactions for the period, without filtering the General Ledger.',
  'rpt-card-activity': 'One credit card\'s transactions for the period, without filtering the General Ledger.',
  'manual-je': 'The journal entries keyed by hand in Intacct - who entered each one and when.',
  'rpt-budget-ytd': 'The income statement\'s Actual beside its Budget for the year to date, with Variance $ and Variance %.',
  'rpt-budget-mtd': 'The income statement\'s Actual beside its Budget for the month to date, with Variance $ and Variance %.',
  'rpt-flux': 'Each account this period against the period before, flagged past the thresholds you set, with explanations kept per account.',
  profitability: 'One row per entity: revenue, NOI, interest, depreciation, net income, debt service and cash flow after debt service, against the prior year.',
  compensation: 'Wages, employer costs and hours per employee for the period, each amount a click from its ledger lines.',
  'payroll-summary': 'The payroll journal summed by pay item and employee, laid out like QuickBooks\' Payroll Summary.',
  pfs: 'Personal financial statements - assets, liabilities and net worth - for the people you may see.',
  mri: 'The income that comes in every month, by tenant and entity, against what posted.',
  mre: 'The bills paid every month, by vendor and entity, against what posted.',
  'mgmt-fees': 'Management fees under each agreement, billed as read from the ledger.',
  ama: 'Questions on ledger lines sent to the accountant, with their answers and reclasses.',
  budget: 'The budgets kept in Nexus, by account and month, that Budget vs. Actual reads.',
  'rpt-schedule-c': 'Draft for review. Each entity\'s income statement accounts mapped to IRS Schedule C lines (Part I income, Part II expenses 8-27, lines 28-31), with an editable mapping kept in Nexus and unmapped accounts listed. Schedule E, Form 4562 (asset depreciation) and the 1040, 1120, 1120-S and 1065 returns come later.',
};

/** The menu's Reports group as catalogue rows: { key, label, group, groupKey }. */
export function standardEntries(groups) {
  const out = [];
  const walk = (items, group, prefix) => items.forEach((t) => {
    if (t.items) { walk(t.items, group, [...prefix, t.label]); return; }
    if (t.key === 'reports') return;
    // "Income Statement, Income Statement by Job" reads as the item's own name.
    const label = prefix.length && t.label.startsWith(prefix[prefix.length - 1]) ? [...prefix.slice(0, -1), t.label].join(', ') : [...prefix, t.label].join(', ');
    out.push({ key: t.key, label, group: group.label, groupKey: group.key, ...(STANDARD_ABOUT[t.key] ? { about: STANDARD_ABOUT[t.key] } : {}) });
  });
  groups.forEach((g) => (g.items ? walk(g.items, g, []) : null));
  const listed = new Set(out.map((e) => e.key));
  REPORTS.forEach((r) => {
    if (listed.has(`rpt-${r.key}`)) return;
    if (EXTRA_HOME[r.key] === null) return;
    const home = groups.find((g) => g.key === (EXTRA_HOME[r.key] || 'grp-financial')) || groups.find((g) => g.key === 'grp-financial');
    if (home) out.push({ key: `rpt-${r.key}`, label: r.label, group: home.label, groupKey: home.key, ...(STANDARD_ABOUT[`rpt-${r.key}`] ? { about: STANDARD_ABOUT[`rpt-${r.key}`] } : {}) });
  });
  return out;
}

const describe = (config) => {
  const c = resolveConfig(config);
  const period = periodOf(c) === 'asof' ? (c.asofToday === false ? `As of ${formatDate(c.asof)}` : 'As of today') : c.preset === 'custom' ? `${formatDate(c.from)} - ${formatDate(c.to)}` : presetLabel(c.preset);
  return [reportDef(c.report).label, period, entityText(c, [])].join(' · ');
};

/**
 * Every row of the catalogue, in menu order: standard entries, then the
 * memorized and builder reports. `saved` = GET /accounting/saved-reports.
 * Row: { id, key (the sub it opens), label, type: standard | memorized | saved | published, group, groupKey, about?, saved? }
 * A person limited to certain entities gets a memorized report only when every
 * entity it names is one of theirs - anything else would open empty.
 */
export function catalogue(groups, saved, { entities = [], limited = false } = {}) {
  const std = standardEntries(groups).map((e) => ({ ...e, id: e.key, type: 'standard' }));
  const groupOfReport = (report) => {
    const hit = std.find((e) => e.key === `rpt-${report}`);
    return hit ? { group: hit.group, groupKey: hit.groupKey } : null;
  };
  const center = groups.find((g) => g.key === 'grp-center') || groups[0];
  const mine = new Set(entities.map((e) => e.code));
  const opens = (r) => !limited || !(r.config?.entities || []).some((code) => !mine.has(code));
  const kept = (saved || []).filter((r) => r && r.config && opens(r)).map((r) => {
    if (isBuilderConfig(r.config)) {
      return { id: r.id, key: 'report-builder', label: r.name, type: isPublished(r) ? 'published' : 'saved', group: center?.label || 'Report Center', groupKey: center?.key || 'grp-center', about: builderSummary(r.config, entities), saved: r };
    }
    const report = resolveConfig(r.config).report;
    const home = groupOfReport(report);
    if (!home) return null;
    return { id: r.id, key: `rpt-${report}`, label: r.name, type: 'memorized', ...home, about: describe(r.config), saved: r };
  }).filter(Boolean);
  const order = groups.map((g) => g.key);
  return [...std, ...kept].sort((a, b) => order.indexOf(a.groupKey) - order.indexOf(b.groupKey));
}
