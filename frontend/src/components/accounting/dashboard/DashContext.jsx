import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api';
import { buildLedger, incomeStatementWindow } from '../../../accounting/dashboard/model/ledger';
import { lastClosedKey, mEnd, monthLong, mShort, mStart, monthsBetween, shiftKey } from '../../../accounting/dashboard/model/months';
import { FX_INR_DEFAULT, money } from '../../../accounting/dashboard/model/money';
import { indexEntities, scopeCurrency } from '../../../accounting/dashboard/model/scope';
import { SCENARIOS } from '../../../accounting/dashboard/model/cash-plan';

// One provider for the Accounting dashboard tabs (Overview / Cash /
// Performance / Close). It holds the global filters - scope (consolidated,
// controllable, partner entities, or one entity), month, book, scenario - and
// loads the ledger aggregate once for 13 months; every widget derives from it.
// Data comes from the accounting app through the backend proxy
// (backend/routers/accounting_dashboard.py); Nexus never opens the accounting
// database. The calculation modules under accounting/dashboard/model are the
// same ones the accounting app runs, compiled to plain JavaScript.

const Ctx = createContext(null);

export function useDash() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDash must be used inside DashProvider');
  return c;
}

/** Months loaded behind the selected one: trailing 12 plus the same month last year. */
export const WINDOW_MONTHS = 13;
const KEY = 'acct-dash';
const LS = 'nexus-accounting-dashboard';

const readLS = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } };
const writeLS = (patch) => { try { localStorage.setItem(LS, JSON.stringify({ ...readLS(), ...patch })); } catch { /* private mode */ } };
const validMonth = (s) => (typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) ? s : null);

const rowsOf = (d) => (d && Array.isArray(d.rows) ? d.rows : []);
const n = (v) => Number(v ?? 0);

export function DashProvider({ children }) {
  const qc = useQueryClient();
  const saved = useMemo(() => readLS(), []);
  const lastClosed = lastClosedKey();
  const [scope, setScopeState] = useState(saved.scope || 'ALL');
  // The selected run of months: `to` is the anchor month every monthly figure
  // (close, cash plan) uses; `from` equals `to` for a single month.
  const [range, setRangeState] = useState(() => {
    const to = validMonth(saved.period) && saved.period <= lastClosed ? saved.period : lastClosed;
    const from = validMonth(saved.from) && saved.from <= to ? saved.from : to;
    return { from, to };
  });
  const period = range.to;
  const fromKey = range.from;
  // Moving the end month keeps the range's length (a quarter stays a quarter).
  const setPeriod = useCallback((k) => setRangeState((r) => ({ from: shiftKey(k, monthsBetween(r.from, r.to).length - 1), to: k })), []);
  const setRange = useCallback((f, t) => setRangeState({ from: f <= t ? f : t, to: t }), []);
  const isRange = fromKey !== period;
  const periodLabel = isRange ? `${mShort(fromKey)} - ${mShort(period)}` : monthLong(period);
  const [book, setBookState] = useState(['accrual', 'cash', 'all'].includes(saved.book) ? saved.book : 'accrual');
  const [scenarioId, setScenarioState] = useState(SCENARIOS[saved.scenario] ? saved.scenario : 'base');
  const [view, setViewState] = useState(saved.view || 'principal');
  const setScope = useCallback((s) => { setScopeState(s); writeLS({ scope: s }); }, []);
  const setBook = useCallback((b) => { setBookState(b); writeLS({ book: b }); }, []);
  const setScenario = useCallback((s) => { setScenarioState(s); writeLS({ scenario: s }); }, []);
  const setView = useCallback((v) => { setViewState(v); writeLS({ view: v }); }, []);
  useEffect(() => { writeLS({ period, from: fromKey }); }, [period, fromKey]);

  // Load from a year before the range starts: trailing 12 for the end month,
  // plus the same months last year for the whole range.
  const from = mStart(shiftKey(fromKey, WINDOW_MONTHS - 1));
  const to = mEnd(period);
  const periodOptions = useMemo(() => monthsBetween(shiftKey(lastClosed, 23), lastClosed).reverse(), [lastClosed]);

  const entitiesQ = useQuery({ queryKey: [KEY, 'entities'], queryFn: () => api.getAccountingDashEntities().then(rowsOf), staleTime: 5 * 60_000 });
  const entities = entitiesQ.data ?? [];
  const ix = useMemo(() => indexEntities(entities), [entities]);
  const hasPartners = entities.some((e) => e.is_partner);
  const wantNc = hasPartners && scope === 'ALL';

  const normalizeMonthly = (d) => ({
    ...d,
    accounts: d.accounts ?? [],
    rows: (d.rows ?? []).map((r) => ({ a: r.a, m: r.m, d: n(r.d), c: n(r.c) })),
    open: (d.open ?? []).map((r) => ({ a: r.a, b: n(r.b) })),
  });
  const monthlyQ = useQuery({ queryKey: [KEY, 'monthly', scope, from, to, book], queryFn: () => api.getAccountingDashLedger(scope, from, to, book).then(normalizeMonthly), staleTime: 60_000 });
  const monthlyNcQ = useQuery({ queryKey: [KEY, 'monthly', 'NC', from, to, book], queryFn: () => api.getAccountingDashLedger('NC', from, to, book).then(normalizeMonthly), staleTime: 60_000, enabled: wantNc });
  const budgetQ = useQuery({ queryKey: [KEY, 'budget', from, to, book], queryFn: () => api.getAccountingDashBudget(from, to, book).then((d) => rowsOf(d).map((r) => ({ account_id: r.account_id, month: r.month, amount: n(r.amount) }))), staleTime: 5 * 60_000 });
  const cashEntitiesQ = useQuery({ queryKey: [KEY, 'cash-entities', scope, to, book], queryFn: () => api.getAccountingDashCashEntities(scope, to, book).then((d) => rowsOf(d).map((r) => ({ ...r, balance: n(r.balance), is_partner: !!r.is_partner }))), staleTime: 60_000 });
  const noiMonthQ = useQuery({ queryKey: [KEY, 'noi', mStart(period), to, book], queryFn: () => api.getAccountingDashNoi(mStart(period), to, book).then(rowsOf), staleTime: 60_000 });
  const noiT12Q = useQuery({ queryKey: [KEY, 'noi', mStart(shiftKey(period, 11)), to, book], queryFn: () => api.getAccountingDashNoi(mStart(shiftKey(period, 11)), to, book).then(rowsOf), staleTime: 5 * 60_000 });
  const tablesQ = useQuery({ queryKey: [KEY, 'tables', period], queryFn: () => api.getAccountingDashTables(period), staleTime: 10_000, refetchInterval: 60_000 });

  // First run for the company: seed the close plan, calendar, cap rates and role views once.
  const seeded = useRef(false);
  useEffect(() => {
    const t = tablesQ.data;
    if (seeded.current || !t) return;
    if ((t.closeTasks ?? []).length && (t.views ?? []).length) return;
    seeded.current = true;
    api.accountingDashAction('seed').then(() => qc.invalidateQueries({ queryKey: [KEY, 'tables'] })).catch(() => {});
  }, [tablesQ.data, qc]);

  const ledger = useMemo(() => (monthlyQ.data ? buildLedger(monthlyQ.data, budgetQ.data ?? []) : null), [monthlyQ.data, budgetQ.data]);
  const ledgerNc = useMemo(() => (wantNc && monthlyNcQ.data ? buildLedger(monthlyNcQ.data, []) : null), [wantNc, monthlyNcQ.data]);
  const lines = useMemo(() => (ledger ? incomeStatementWindow(ledger, fromKey, period) : []), [ledger, fromKey, period]);

  const cashEntities = useMemo(() => cashEntitiesQ.data ?? [], [cashEntitiesQ.data]);
  const cashSplit = useMemo(() => {
    const ctlEntities = cashEntities.filter((e) => !e.is_partner);
    const ncEntities = cashEntities.filter((e) => e.is_partner);
    const ctl = ctlEntities.reduce((t, e) => t + e.balance, 0);
    const nc = ncEntities.reduce((t, e) => t + e.balance, 0);
    return { ctl, nc, total: ctl + nc, ctlEntities, ncEntities };
  }, [cashEntities]);

  const inScopeRow = useCallback((code) => {
    if (scope === 'ALL') return true;
    if (scope === 'CTL') return !ix.isPartner(code);
    if (scope === 'NC') return !!code && ix.isPartner(code);
    return ix.rootOf(code) === scope;
  }, [scope, ix]);
  const noiRows = useMemo(() => rowsOf({ rows: noiMonthQ.data }).filter((r) => inScopeRow(r.code)).map((r) => ({ code: r.code, name: r.name || r.code || 'No entity', assetType: r.asset_type || '', isPartner: !!r.is_partner, revenue: n(r.revenue), expense: n(r.expense), noi: n(r.revenue) - n(r.expense) })).sort((a, b) => b.noi - a.noi), [noiMonthQ.data, inScopeRow]);
  const noiT12ByType = useMemo(() => {
    const out = new Map();
    for (const r of rowsOf({ rows: noiT12Q.data })) {
      if (!r.asset_type || !inScopeRow(r.code)) continue;
      out.set(r.asset_type, (out.get(r.asset_type) ?? 0) + n(r.revenue) - n(r.expense));
    }
    return out;
  }, [noiT12Q.data, inScopeRow]);

  const currency = scopeCurrency(ix, scope);
  const m = useCallback((v, opts = {}) => money(v, { currency, fx: FX_INR_DEFAULT, ...opts }), [currency]);

  const tables = tablesQ.data ?? null;
  const invalidate = useCallback((subject) => qc.invalidateQueries({ queryKey: subject ? [KEY, subject] : [KEY] }), [qc]);
  const refetchAll = useCallback(() => qc.invalidateQueries({ queryKey: [KEY] }), [qc]);
  /** One write to the accounting app; the shared tables refetch after it. */
  const act = useCallback(async (op, payload = {}) => {
    const r = await api.accountingDashAction(op, payload);
    await qc.invalidateQueries({ queryKey: [KEY, 'tables'] });
    if (op === 'row-save' || op === 'row-delete') await qc.invalidateQueries({ queryKey: [KEY, 'entities'] });
    return r;
  }, [qc]);

  const value = {
    scope, period, fromKey, isRange, periodLabel, book, scenarioId, view, setScope, setPeriod, setRange, setBook, setScenario, setView, lastClosed, periodOptions,
    ix, entities, currency, m,
    monthly: monthlyQ.data, ledger, ledgerNc, lines, cashEntities, cashSplit, noiRows, noiT12ByType,
    tables, tablesLoading: tablesQ.isLoading,
    loading: monthlyQ.isLoading || entitiesQ.isLoading,
    error: monthlyQ.error || entitiesQ.error || tablesQ.error || null,
    refetch: () => { monthlyQ.refetch(); tablesQ.refetch(); },
    refetchAll, invalidate, act,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
