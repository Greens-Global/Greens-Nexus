import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Render-smoke for Accounting -> Reports -> Report Center (Oct 23, Neil,
// item 05): every report in one list, memorized vs standard marked, a
// search, one click to open.

vi.mock('../../api', () => ({
  api: {
    getAccountingSavedReports: vi.fn(async () => ([
      { id: 's1', name: 'GG Inc Balance Sheet', config: { report: 'balance-sheet', entities: ['12000'] }, shared: true, owner: 'urmi@greensglobal.com', mine: false, updatedAt: '2026-10-20T12:00:00Z' },
      { id: 'b1', name: 'Custom Lines', config: { kind: 'builder', version: 1, groups: [{ name: 'Line A', accounts: ['61000'] }] }, shared: false, owner: 'me@greensglobal.com', mine: true },
    ])),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '12000', name: 'Greens Global Inc' }] })),
  },
}));
vi.mock('../../lib/useNameResolver', () => ({ useNameResolver: () => (email) => (email === 'urmi@greensglobal.com' ? 'Urmi Shah' : '') }));

import ReportCenter from './ReportCenter';
import { peekParkedReport, clearParkedReport } from './drill';

const GROUPS = [
  { key: 'grp-center', label: 'Report Center', items: [{ key: 'reports', label: 'Report Center' }, { key: 'report-builder', label: 'Report Builder' }, { key: 'packages', label: 'Packages' }] },
  { key: 'grp-financial', label: 'Financial', items: [{ key: 'rpt-balance-sheet', label: 'Balance Sheet' }] },
];

describe('ReportCenter', () => {
  it('lists standard and memorized reports, marked, and opens a memorized one on its statement', async () => {
    const onOpen = vi.fn();
    render(<ReportCenter groups={GROUPS} onOpen={onOpen} />);
    const memorized = await screen.findByRole('button', { name: 'GG Inc Balance Sheet' });
    const fin = screen.getByRole('region', { name: 'Financial' });
    const rowOf = (name) => within(fin).getByRole('button', { name }).closest('tr');
    expect(rowOf('Balance Sheet').textContent).toContain('Standard');
    expect(rowOf('GG Inc Balance Sheet').textContent).toMatch(/Memorized.*Urmi Shah.*Accounting team.*10\/20\/2026/);
    const center = screen.getByRole('region', { name: 'Report Center' });
    expect(within(center).getByRole('button', { name: 'Custom Lines' }).closest('tr').textContent).toMatch(/Saved.*You.*Only the owner/);
    expect(within(center).getByRole('button', { name: 'Report Builder' })).toBeTruthy();
    expect(within(center).getByRole('button', { name: 'Packages' })).toBeTruthy();
    fireEvent.click(memorized);
    expect(onOpen).toHaveBeenCalledWith('rpt-balance-sheet');
    const parked = peekParkedReport(false);
    expect(parked?.id).toBe('s1');
    clearParkedReport(parked);
  });

  it('opens a builder report in the Report Builder and filters by search and type', async () => {
    const onOpen = vi.fn();
    render(<ReportCenter groups={GROUPS} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Custom Lines' }));
    expect(onOpen).toHaveBeenCalledWith('report-builder');
    expect(peekParkedReport(true)?.id).toBe('b1');
    clearParkedReport(peekParkedReport(true));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search reports' }), { target: { value: 'urmi' } });
    expect(screen.getByRole('button', { name: 'GG Inc Balance Sheet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Custom Lines' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search reports' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Memorized and Saved/ }));
    expect(screen.queryByRole('button', { name: 'Balance Sheet' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Custom Lines' })).toBeTruthy();
  });
});
