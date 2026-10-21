import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Ops Budget > Hummingbird History (Oct 21 2026): the admin status panel on a
// payload shaped like GET /ops-budget/hummingbird (fake sites and people).

const getOpsHummingbird = vi.fn();
vi.mock('../api', () => ({ api: { getOpsHummingbird: (...a) => getOpsHummingbird(...a) } }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

const HbHistoryPanel = (await import('./HbHistoryPanel')).default;

const STATUS = {
  command: 'python -m hb_load "<folder with the HB JSON files>"',
  notProvided: ['avg_standard_rate', 'gpr', 'tows'],
  loads: [{ id: 'l1', startedAt: '2026-10-21T18:00:00Z', by: 'admin@example.com', status: 'ok', files: [{}, {}, {}, {}],
    counts: { hb_leases: 6281, ops_metric_month: 4544 }, warnings: ['Greens Storage, Testville: not matched'] }],
  sites: [{ id: 'P1', name: 'Greens Storage, Temecula', shortName: 'Temecula', facilityId: 'temecula', goLive: '2023-11-16',
    first: '2023-12', last: '2026-08', units: 516, leases: 1384, leaseMonths: 15000, unitTypes: 38 }],
};

describe('Hummingbird History panel', () => {
  it('shows each site, the months rebuilt, the last load and what HB lacks', async () => {
    getOpsHummingbird.mockResolvedValue(STATUS);
    render(<HbHistoryPanel onClose={() => {}} />);
    const panel = await screen.findByTestId('hb-panel');
    expect(await within(panel).findByText('Temecula')).toBeTruthy();
    expect(within(panel).getByText('11/16/2023')).toBeTruthy();
    expect(within(panel).getByText('1,384')).toBeTruthy();
    expect(screen.getByTestId('hb-last-load').textContent).toContain('admin@example.com');
    expect(panel.textContent).toContain('Standard rate, Gross potential rent, Tows');
    expect(panel.textContent).toContain('not matched');
    expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull();          // loading is the command-line loader
  });

  it('explains how to load when nothing is loaded yet', async () => {
    getOpsHummingbird.mockResolvedValue({ ...STATUS, loads: [], sites: [] });
    render(<HbHistoryPanel onClose={() => {}} />);
    expect(await screen.findByText(/Nothing loaded yet/)).toBeTruthy();
    expect(screen.getByText(STATUS.command)).toBeTruthy();
  });

  it('offers a retry when the status fails', async () => {
    getOpsHummingbird.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<HbHistoryPanel onClose={() => {}} />);
    expect(await screen.findByText("Couldn't load the Hummingbird history status.")).toBeTruthy();
  });
});
