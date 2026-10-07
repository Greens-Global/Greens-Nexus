import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Dashboard Refresh (Oct 7, Priyanka: "does nothing") and the scope picker
// (Neil comment 7). Refresh asks the backend for fresh figures, spins while
// anything loads, then says when it finished; "Partner Entities Only" is not
// offered when no entity is a partner one.

const state = vi.hoisted(() => ({ entities: [], tables: {}, hold: null }));
vi.mock('../../../api', () => ({
  api: {
    getAccountingDashEntities: vi.fn(async () => ({ rows: state.entities })),
    getAccountingDashLedger: vi.fn(async (_s, from, to) => ({ from, to, accounts: [], rows: [], open: [] })),
    getAccountingDashBudget: vi.fn(async () => ({ rows: [] })),
    getAccountingDashCashEntities: vi.fn(async () => ({ rows: [] })),
    getAccountingDashReconAccounts: vi.fn(async () => ({ rows: [] })),
    getAccountingDashNoi: vi.fn(async () => ({ rows: [] })),
    getAccountingDashTables: vi.fn(async () => (state.hold ? state.hold : { closeTasks: [{ id: 1 }], views: [{ id: 'principal' }], ...state.tables })),
    accountingDashAction: vi.fn(async () => ({ ok: true })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));

import { api } from '../../../api';
import { DashProvider } from './DashContext';
import { RefreshButton, ScopeSelect } from './Filters';

const wrap = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DashProvider>{ui}</DashProvider></QueryClientProvider>);
};

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  state.entities = [{ code: '12000', name: 'Greens Global, Inc.', is_partner: false }];
  state.tables = {};
  state.hold = null;
  vi.clearAllMocks();
});

describe('Dashboard Refresh', () => {
  it('sends fresh=1, spins and disables while loading, then shows Updated <time>', async () => {
    wrap(<RefreshButton />);
    const btn = screen.getByRole('button', { name: 'Refresh figures' });
    await waitFor(() => expect(btn.disabled).toBe(false));
    // Normal loads never ask for fresh figures.
    expect(api.getAccountingDashTables.mock.calls.every((c) => !c[1])).toBe(true);
    expect(api.getAccountingDashLedger.mock.calls.every((c) => !c[4])).toBe(true);
    expect(screen.queryByText(/Updated/)).toBeNull();

    let release;
    state.hold = new Promise((r) => { release = () => r({ closeTasks: [{ id: 1 }], views: [{ id: 'principal' }] }); });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.querySelector('svg')?.getAttribute('data-spinning')).toBe('true');
    const tablesCall = api.getAccountingDashTables.mock.calls.at(-1);
    expect(tablesCall[1]).toBe(true);
    expect(api.getAccountingDashLedger.mock.calls.at(-1)[4]).toBe(true);
    expect(api.getAccountingDashEntities.mock.calls.at(-1)[0]).toBe(true);

    state.hold = null;
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByText(/^Updated \d{1,2}:\d{2} (AM|PM)$/)).toBeTruthy());
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector('svg')?.getAttribute('data-spinning')).toBeNull();
  });

  it('says when the ledger was last synced from Intacct, if the accounting app reports it', async () => {
    const at = new Date();
    at.setHours(14, 5, 0, 0);
    state.tables = { sync: { last_success_at: at.toISOString(), last_sync_at: at.toISOString(), last_sync_ok: true } };
    wrap(<RefreshButton />);
    await waitFor(() => expect(screen.getByText('Ledger synced from Intacct 2:05 PM')).toBeTruthy());
  });

  it('shows nothing about the ledger when the accounting app does not say', async () => {
    wrap(<RefreshButton />);
    await waitFor(() => expect(api.getAccountingDashTables).toHaveBeenCalled());
    expect(screen.queryByText(/Ledger synced/)).toBeNull();
  });
});

describe('Scope picker', () => {
  it('hides Partner Entities Only when no entity is a partner', async () => {
    wrap(<ScopeSelect />);
    await waitFor(() => expect(api.getAccountingDashEntities).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Scope' }));
    await screen.findByText('Controllable Entities Only');
    expect(screen.queryByText('Partner Entities Only (Non-Controllable)')).toBeNull();
  });

  it('offers it when a partner entity exists', async () => {
    state.entities = [...state.entities, { code: '70000', name: 'Partner LP', is_partner: true }];
    wrap(<ScopeSelect />);
    fireEvent.click(screen.getByRole('button', { name: 'Scope' }));
    expect(await screen.findByText('Partner Entities Only (Non-Controllable)')).toBeTruthy();
  });
});
