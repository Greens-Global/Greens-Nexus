import { useMemo } from 'react';
import { closeState } from '../../../accounting/dashboard/model/close';
import { holdingsInScope, intercompanyRows, loansInScope, partnerSummary, upcomingDeadlines, valuation } from '../../../accounting/dashboard/model/capital';
import { balancesAt, cashTrend, monthTotals } from '../../../accounting/dashboard/model/ledger';
import { cashPlan, fixedMonthly, forecast13, runwayMonths, SCENARIOS } from '../../../accounting/dashboard/model/cash-plan';
import { reconList } from '../../../accounting/dashboard/model/recon';
import { fluxRows } from '../../../accounting/dashboard/model/flux';
import { perfTiles, variances, ytdVariance } from '../../../accounting/dashboard/model/perf';
import { attentionItems } from '../../../accounting/dashboard/model/attention';
import { inScope } from '../../../accounting/dashboard/model/scope';
import { useDash } from './DashContext';

// Derived data hooks shared by widgets and tabs. Each combines the provider's
// ledger with one of the shared tables and memoizes the pure-model result.

const EMPTY = [];
const n = (v) => Number(v ?? 0);
const nn = (v) => (v == null || v === '' ? null : Number(v));

const useTable = (key) => {
  const { tables } = useDash();
  return tables?.[key] ?? EMPTY;
};

export function useLoans() {
  const { ix, scope, tablesLoading } = useDash();
  const raw = useTable('loans');
  const all = useMemo(() => raw.map((r) => ({ ...r, balance: n(r.balance), rate_pct: n(r.rate_pct), monthly_pi: n(r.monthly_pi), dscr: nn(r.dscr), covenant_min: nn(r.covenant_min), is_active: r.is_active !== false, notes: r.notes || '' })), [raw]);
  return { loans: useMemo(() => loansInScope(all, ix, scope), [all, ix, scope]), all, isLoading: tablesLoading };
}

export function useHoldings() {
  const { ix, scope, tablesLoading } = useDash();
  const raw = useTable('holdings');
  const holdings = useMemo(() => holdingsInScope(raw.map((h) => ({ ...h, market_value: n(h.market_value), cost: n(h.cost), prior_value: n(h.prior_value), quantity: n(h.quantity) })), ix, scope), [raw, ix, scope]);
  return { holdings, mv: holdings.reduce((t, h) => t + h.market_value, 0), cost: holdings.reduce((t, h) => t + h.cost, 0), prior: holdings.reduce((t, h) => t + h.prior_value, 0), isLoading: tablesLoading };
}

export function useIntercompany() {
  const { ix, scope, tablesLoading } = useDash();
  const raw = useTable('intercompany');
  return { rows: useMemo(() => intercompanyRows(raw.map((r) => ({ ...r, due_from: n(r.due_from), due_to: n(r.due_to) })), ix, scope), [raw, ix, scope]), isLoading: tablesLoading };
}

export function useDeadlines(limit = 6) {
  const { tablesLoading } = useDash();
  const raw = useTable('deadlines');
  return { items: useMemo(() => upcomingDeadlines(raw.map((d) => ({ ...d, sort: n(d.sort), is_active: d.is_active !== false, schedule: Array.isArray(d.schedule) ? d.schedule : [] })), new Date(), limit), [raw, limit]), isLoading: tablesLoading };
}

export function usePartners() {
  const { ix, scope, period, tablesLoading } = useDash();
  const raw = useTable('partnerCapital');
  const rows = useMemo(() => raw.map((c) => ({ ...c, capital: n(c.capital), ownership: n(c.ownership), distribution: n(c.distribution), sort: n(c.sort) })).filter((c) => inScope(ix, c.entity_code, scope)), [raw, ix, scope]);
  return { summary: useMemo(() => partnerSummary(rows, period), [rows, period]), isLoading: tablesLoading };
}

export function useValuation() {
  const { noiT12ByType, tablesLoading } = useDash();
  const { loans } = useLoans();
  const raw = useTable('capRates');
  const debt = loans.reduce((t, l) => t + l.balance, 0);
  return { v: useMemo(() => valuation(noiT12ByType, raw.map((c) => ({ asset_type: c.asset_type, cap_rate: n(c.cap_rate) })), debt), [noiT12ByType, raw, debt]), isLoading: tablesLoading };
}

export function useCloseState() {
  const { period, tables, tablesLoading } = useDash();
  const tasks = useTable('closeTasks');
  const done = useTable('closeCompletions');
  const history = useTable('closeHistory');
  const state = useMemo(() => (tables ? closeState(tasks.map((t) => ({ ...t, day_offset: n(t.day_offset), sort: n(t.sort), is_active: t.is_active !== false })), done, period) : null), [tables, tasks, done, period]);
  return { state, history: useMemo(() => history.map((h) => ({ period: h.period, closed_day: n(h.closed_day) })), [history]), isLoading: tablesLoading };
}

export function useRecon() {
  const { period, scope, ix, ledger, tablesLoading } = useDash();
  const banks = useTable('banks');
  const recons = useTable('recons');
  const marks = useTable('reconMarks');
  const { all: loans } = useLoans();
  const holdingsRaw = useTable('holdings');
  const rows = useMemo(() => {
    const bal = ledger ? balancesAt(ledger, period) : new Map();
    return reconList({
      period, scope, ix, banks, marks, loans,
      recons: recons.map((r) => ({ ...r, difference: n(r.difference), ending_balance: n(r.ending_balance) })),
      holdings: holdingsRaw.map((h) => ({ ...h, market_value: n(h.market_value) })),
      glBalance: (id) => bal.get(id) ?? 0,
      glCode: (id) => ledger?.accounts.get(id)?.gl ?? '',
    });
  }, [period, scope, ix, ledger, banks, recons, loans, holdingsRaw, marks]);
  return { rows, reconciled: rows.filter((r) => r.status === 'Reconciled').length, behind: rows.filter((r) => r.status === 'Behind' || r.status === 'Difference').length, isLoading: tablesLoading };
}

export function useNotes() {
  const notes = useTable('notes');
  return {
    commentary: notes.find((x) => x.kind === 'commentary') ?? null,
    flux: useMemo(() => new Map(notes.filter((x) => x.kind === 'flux').map((x) => [x.note_key, x])), [notes]),
  };
}

export function useActivity(limit = 10) {
  const { tablesLoading } = useDash();
  return { rows: useTable('activity').slice(0, limit), isLoading: tablesLoading };
}

export function useFeed() {
  const { tables, tablesLoading } = useDash();
  return { feed: tables?.feed ?? null, isLoading: tablesLoading };
}

export function useViews() {
  const { tablesLoading } = useDash();
  const raw = useTable('views');
  return { views: useMemo(() => raw.map((v) => ({ ...v, sort: n(v.sort), widgets: Array.isArray(v.widgets) ? v.widgets : [] })), [raw]), isLoading: tablesLoading };
}

/** Month-by-month totals for the loaded window with the partner-entity cash split. */
export function useTrend() {
  const { ledger, ledgerNc, scope, ix } = useDash();
  return useMemo(() => {
    if (!ledger) return [];
    const totals = monthTotals(ledger);
    const nc = ledgerNc ? cashTrend(ledgerNc) : null;
    const allNc = scope === 'NC' || (!['ALL', 'CTL', 'NC'].includes(scope) && ix.isPartner(scope));
    return totals.map((t, i) => { const ncCash = nc ? nc[i] : allNc ? t.cash : 0; return { ...t, ncCash, ctlCash: t.cash - ncCash }; });
  }, [ledger, ledgerNc, scope, ix]);
}

export function useCashPlan() {
  const { ledger, period, scenarioId } = useDash();
  const { loans } = useLoans();
  return useMemo(() => (ledger ? cashPlan(ledger, loans, period, SCENARIOS[scenarioId]) : null), [ledger, loans, period, scenarioId]);
}

export function useRunway() {
  const { lines, cashSplit } = useDash();
  const { loans } = useLoans();
  const { mv } = useHoldings();
  const fixed = useMemo(() => fixedMonthly(lines, loans), [lines, loans]);
  const liquid = cashSplit.ctl + mv;
  return { fixed, liquid, months: runwayMonths(liquid, fixed) };
}

export function useForecast13() {
  const { lines, period, cashSplit } = useDash();
  const { loans } = useLoans();
  const { summary } = usePartners();
  const monthlyDist = summary.rows.filter((r) => r.frequency === 'M').reduce((t, r) => t + r.distribution, 0) + summary.nextQuarterly / 3;
  return useMemo(() => forecast13(lines, loans, period, cashSplit.ctl, monthlyDist), [lines, loans, period, cashSplit.ctl, monthlyDist]);
}

export function useFlux() {
  const { ledger, period } = useDash();
  return useMemo(() => (ledger ? fluxRows(ledger, period) : { rows: [], hasPrior: false }), [ledger, period]);
}

export function usePerf() {
  const { ledger, period, fromKey } = useDash();
  return useMemo(() => (ledger ? { tiles: perfTiles(ledger, period, fromKey), variances: variances(ledger, period, fromKey), ytd: ytdVariance(ledger, period) } : null), [ledger, period, fromKey]);
}

export function useAttention() {
  const { period, lines } = useDash();
  const { rows: recon } = useRecon();
  const { state: close } = useCloseState();
  const { rows: ic } = useIntercompany();
  const { loans } = useLoans();
  const { feed } = useFeed();
  const { months, fixed } = useRunway();
  return useMemo(() => attentionItems({ period, recon, close, ic, loans, lines, feed, runway: fixed > 0 ? months : null }), [period, recon, close, ic, loans, lines, feed, months, fixed]);
}
