import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Workday > Workplace Notices (Neil, Oct 21 2026): what I owe shows first,
// I acknowledge with my typed name, and my notices are grouped by area.

const my = vi.fn();
const ack = vi.fn();
vi.mock('../api', () => ({
  api: {
    myNotices: (...a) => my(...a),
    acknowledgeNotice: (...a) => ack(...a),
    recordNoticeView: vi.fn().mockResolvedValue({}),
    myClosures: vi.fn().mockResolvedValue({ days: [] }),
    noticeFile: vi.fn().mockReturnValue(new Promise(() => {})),
  },
}));

const { default: WorkplaceNotices } = await import('./WorkplaceNotices');

const live = { id: 'v1', label: 'v1', effectiveDate: '2026-10-01', summary: 'First version', langs: ['en'], major: true };
const data = (over) => ({
  placed: true, name: 'Amy Test',
  context: { country: 'US', state: 'CA', stateLabel: 'Work site', cities: ['ESCONDIDO'], workerType: 'employee', sites: [] },
  documents: [
    { id: 'manual-core', title: 'Greens Employee Manual', kind: 'manual', area: 'US', requiresAck: true, live,
      ack: { required: true, done: false, due: '2026-10-15', overdue: true, reason: 'first' } },
    { id: 'manual-ca', title: 'California Addendum', kind: 'addendum', area: 'US-CA', requiresAck: true, live: null,
      ack: { required: false, done: false } },
  ],
  posted: [
    { id: 'fed-flsa', title: 'Employee Rights Under the FLSA', formCode: 'WH1088', area: 'US', live },
    { id: 'ca-mw', title: 'California Minimum Wage', formCode: 'MW-2026', area: 'US-CA', live: null },
  ],
  received: [], ...over,
});

beforeEach(() => {
  my.mockReset().mockResolvedValue(data());
  ack.mockReset().mockResolvedValue({ ok: true });
});

describe('WorkplaceNotices', () => {
  it('shows what I owe, my place and my notices by area', async () => {
    render(<WorkplaceNotices toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Needs Your Attention')).toBeInTheDocument();
    expect(screen.getByText(/Overdue since/)).toBeInTheDocument();
    expect(screen.getByText(/You work in Escondido, California/)).toBeInTheDocument();
    expect(screen.getByText('Federal')).toBeInTheDocument();
    expect(screen.getByText(/Coming soon/)).toBeInTheDocument();
    expect(screen.getByText('Posted at your site')).toBeInTheDocument();
  });

  it('acknowledges with my typed name', async () => {
    const ok = vi.fn();
    render(<WorkplaceNotices toastOk={ok} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    const box = await screen.findByPlaceholderText('Amy Test');
    fireEvent.change(box, { target: { value: 'Amy Test' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Acknowledge/ }).pop());
    await waitFor(() => expect(ack).toHaveBeenCalledWith('manual-core', { version_id: 'v1', typed_name: 'Amy Test' }));
    expect(ok).toHaveBeenCalledWith('Acknowledged. Thank you.');
  });

  it('an India contractor sees no US posters', async () => {
    my.mockResolvedValue(data({ context: { country: 'IN', state: '', stateLabel: '', cities: [], workerType: 'contractor', sites: [] },
      documents: [{ id: 'in-code', title: 'Contractor Code of Conduct', kind: 'contractor_code', area: 'IN', requiresAck: true, live: null, ack: { required: false } }],
      posted: [] }));
    render(<WorkplaceNotices toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Code of Conduct And Policies')).toBeInTheDocument();
    expect(screen.queryByText('Your Workplace Notices')).not.toBeInTheDocument();
  });
});
