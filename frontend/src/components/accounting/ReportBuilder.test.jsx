import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Reports -> Report Builder (Oct 23, Neil,
// items 05 / 11): pick GL accounts and dimensions, group accounts under named
// lines, Run, then Save (private) or Publish (the accounting team).

const BUCKETS = {
  org: 'Greens Global', generated_at: '2026-10-23', labels: {},
  rows: [
    { account_no: '40100', title: 'Rent Income', section: 'revenue', bucket: 'total', debit: 0, credit: 9000 },
    { account_no: '61000', title: 'Advertising', section: 'expense', bucket: 'total', debit: 1200, credit: 0 },
    { account_no: '61010', title: 'Online Ads', section: 'expense', bucket: 'total', debit: 300, credit: 0 },
  ],
};
vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '12000', name: 'Greens Global Inc', parent_code: null }] })),
    getAccountingBuckets: vi.fn(async () => BUCKETS),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
    saveAccountingReport: vi.fn(async (body) => ({ id: 'new1', name: body.name, shared: !!body.shared, config: body.config, mine: true })),
    updateAccountingSavedReport: vi.fn(async (id, body) => ({ id, name: body.name, shared: !!body.shared, config: body.config, mine: true })),
    deleteAccountingSavedReport: vi.fn(async () => null),
  },
}));

import ReportBuilder from './ReportBuilder';
import { parkSavedReport } from './drill';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); });

/** Tick accounts in an AccountsPicker by its label. */
async function pick(label, codes) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const list = await screen.findByRole('listbox', { name: label });
  for (const code of codes) fireEvent.click(await within(list).findByText(code));
  fireEvent.click(within(list).getByRole('button', { name: 'Done' }));
}

describe('ReportBuilder', () => {
  it('groups accounts under a named line, runs, and totals each line with a grand total', async () => {
    render(<ReportBuilder />);
    await waitFor(() => expect(api.getAccountingBuckets).toHaveBeenCalled());   // the chart of accounts
    fireEvent.click(screen.getByRole('button', { name: /Add Row Group/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Row group 1 name' }), { target: { value: 'Line A' } });
    await pick('Row group 1 accounts', ['61000', '61010']);
    await pick('GL Accounts', ['40100']);
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    const table = await screen.findByRole('table');
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    expect(rows[0]).toMatch(/^Line A2.*1,500\.00/);
    expect(rows[1]).toMatch(/61000Advertising.*1,200\.00/);
    expect(rows[3]).toBe('Accounts Not in a Group');
    expect(rows[4]).toMatch(/40100Rent Income.*9,000\.00/);
    expect(rows.at(-1)).toMatch(/Grand Total.*10,500\.00/);
    // The last read is the report's: the period and filters travel.
    const call = api.getAccountingBuckets.mock.calls.at(-1)[0];
    expect(call.by).toBe('total');
    expect(call.from).toMatch(/^\d{4}-01-01$/);
    // Folding a line keeps its total and hides its accounts.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Line A' }));
    expect(screen.queryByText('Advertising')).toBeNull();
  });

  it('saves a draft, publishes it unshared, then shares it with everyone (CR-05)', async () => {
    render(<ReportBuilder />);
    await waitFor(() => expect(api.getAccountingBuckets).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Report name' }), { target: { value: 'My Lines' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAccountingReport).toHaveBeenCalledTimes(1));
    const body = api.saveAccountingReport.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'My Lines', shared: false, config: { kind: 'builder', version: 1 } });
    expect(await screen.findByText(/Only you see it in the Report Center/)).toBeTruthy();
    // Publish marks the same report published - NOT shared (Neil: "not shared by default").
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    await waitFor(() => expect(api.updateAccountingSavedReport).toHaveBeenCalledWith('new1', expect.objectContaining({
      shared: false, name: 'My Lines', config: expect.objectContaining({ kind: 'builder', published: true }),
    })));
    expect(await screen.findByText(/Only you see it until you share it with everyone/)).toBeTruthy();
    // Sharing is its own step.
    fireEvent.click(await screen.findByRole('button', { name: /Share With Everyone/ }));
    await waitFor(() => expect(api.updateAccountingSavedReport).toHaveBeenLastCalledWith('new1', expect.objectContaining({ shared: true, config: expect.objectContaining({ published: true }) })));
    expect(await screen.findByRole('button', { name: 'Stop Sharing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(api.updateAccountingSavedReport).toHaveBeenLastCalledWith('new1', expect.objectContaining({ shared: false })));
    expect(api.updateAccountingSavedReport.mock.calls.at(-1)[1].config.published).toBeUndefined();
  });

  it('lets anyone with Accounting publish, and hides it only when told to', async () => {
    const { unmount } = render(<ReportBuilder />);
    await waitFor(() => expect(api.getAccountingBuckets).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Publish/ })).toBeTruthy();
    unmount();
    render(<ReportBuilder canPublish={false} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('adds vs Prior Year columns with Variance $ and % (CR-05)', async () => {
    render(<ReportBuilder />);
    await waitFor(() => expect(api.getAccountingBuckets).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('checkbox', { name: /vs Prior Year/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    const table = await screen.findByRole('table');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads.slice(-2)).toEqual(['Variance $', 'Variance %']);
    // The mock answers the same figures for the prior year: no variance.
    const advertising = [...table.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes('Advertising'));
    expect(advertising.textContent).toMatch(/1,200\.00.*1,200\.00/);
    expect(advertising.textContent).toContain('0.0%');
    // Two reads for the period: the report and its prior year (plus the chart of accounts).
    const years = api.getAccountingBuckets.mock.calls.slice(1).map((c) => c[0].from.slice(0, 4));
    expect(new Set(years).size).toBe(2);
  });

  it('reopens a saved report from the Report Center with its definition and runs it', async () => {
    parkSavedReport({ id: 'b1', name: 'Custom Lines', mine: true, shared: true,
      config: { kind: 'builder', version: 1, groups: [{ name: 'Line A', accounts: ['61000'] }] } }, true);
    render(<ReportBuilder />);
    // Shared before Publish existed: it reads as published and shared.
    expect(screen.getByText('Published and shared with everyone.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Report name' }).value).toBe('Custom Lines');
    expect(screen.getByRole('textbox', { name: 'Row group 1 name' }).value).toBe('Line A');
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('Line A');
    expect(screen.getByRole('heading', { name: 'Custom Lines' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy();
    // The author deletes it, after a Delete / Keep check.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Custom Lines' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteAccountingSavedReport).toHaveBeenCalledWith('b1'));
    expect(await screen.findByText('Deleted.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Report name' }).value).toBe('');
  });
});
