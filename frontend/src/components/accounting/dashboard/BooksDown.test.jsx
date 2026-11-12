import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Picture 13 of the 11/11/2026 Accounting pass (Neil approved): when the books
// cannot be read, the dashboard says so with a Retry - never "$0" or
// "Nothing needs attention", and never a skeleton that waits forever.

const state = vi.hoisted(() => ({ down: true }));
const fail = () => Promise.reject(Object.assign(new Error('Accounting service is not configured'), { status: 503 }));
vi.mock('../../../api', () => ({
  api: {
    getAccountingDashEntities: vi.fn(() => (state.down ? fail() : Promise.resolve({ rows: [{ code: '12000', name: 'Greens Global, Inc.', is_partner: false }] }))),
    getAccountingDashLedger: vi.fn((_s, from, to) => (state.down ? fail() : Promise.resolve({ from, to, accounts: [], rows: [], open: [] }))),
    getAccountingDashBudget: vi.fn(async () => ({ rows: [] })),
    getAccountingDashCashEntities: vi.fn(async () => ({ rows: [] })),
    getAccountingDashReconAccounts: vi.fn(async () => ({ rows: [] })),
    getAccountingDashNoi: vi.fn(async () => ({ rows: [] })),
    getAccountingDashTables: vi.fn(async () => ({ closeTasks: [{ id: 1 }], views: [{ id: 'principal' }] })),
    getLiabilityRecons: vi.fn(async () => ({ loans: {} })),
    accountingDashAction: vi.fn(async () => ({ ok: true })),
  },
}));

import { DashProvider, useDash } from './DashContext';
import { LoadingBox } from './Bits';

function Figure() {
  const { loading, m } = useDash();
  return loading ? <LoadingBox height={80} /> : <div>{m(0)}</div>;
}

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DashProvider><Figure /></DashProvider></QueryClientProvider>);
};

beforeEach(() => { state.down = true; vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

describe('Dashboard when the books cannot be reached', () => {
  it('says so with a Retry, and every figure reads Could not load instead of $0', async () => {
    wrap();
    expect(await screen.findByText(/The books could not be reached, so no figures are shown/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing here is a real zero/);
    expect(screen.getByText('Could not load')).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it('Retry reads the books again and the notice goes once they answer', async () => {
    wrap();
    const retry = await screen.findByRole('button', { name: /Retry/ });
    state.down = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText('Could not load')).toBeNull();
  });
});
