import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Revenue Management: a tenant's rents (Oct 28 2026 call with Neil, B16) -
// the history, eligibility, Cubby's notes and the comments log.
const api = { opsTenantHistory: vi.fn(), addOpsTenantComment: vi.fn(), withdrawOpsTenantComment: vi.fn(),
  getTaskTablePrefs: vi.fn(), saveTaskTablePrefs: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'ops.manager@greensglobal.com' }) }));

const TenantHistory = (await import('./TenantHistory')).default;

const HISTORY = {
  facilityId: 'fac_t', facility: 'Temecula', asOf: '2026-10-20', fromHummingbird: true,
  tenant: { key: 'lease_a1', tenant: 'Ada Sample', unit: 'A1', unitType: '10x10', rent: 10000, street: 15000, moveIn: '2024-01-10',
    monthsStayed: 33, balance: 0, url: 'https://app.cubbystorage.com/tenants/cust_a1' },
  history: [
    { date: '2024-01-10', rent: 9000, source: 'Hummingbird', kind: 'Move-In', note: '', change: null, changePct: null },
    { date: '2025-03-01', rent: 9500, source: 'Hummingbird', kind: 'Rent Change', note: '', change: 500, changePct: 5.6 },
    { date: '2026-09-15', rent: 10000, source: 'Cubby', kind: 'Rent Change', note: 'Changed in Cubby; Cubby does not say on which day.', change: 500, changePct: 5.3 },
  ],
  upcoming: [{ date: '2026-11-01', rent: 10800, source: 'Cubby', kind: 'Scheduled in Cubby', change: 800 }],
  eligibility: [{ strategyId: 's1', strategy: 'Annual 8%', summary: '8% a year', effective: '2026-12-01', eligible: false,
    reasons: ['A rent change is already scheduled in Cubby'], newRent: 10000, increase: 0 }],
  comments: [], cubbyNotes: [{ text: 'Asked to hold the rent until spring', createdAt: '2026-10-02T10:00:00Z', createdBy: 'Front Desk' }],
  cubbyNotesError: '',
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getTaskTablePrefs.mockResolvedValue({ prefs: {} });
  api.saveTaskTablePrefs.mockResolvedValue({});
  api.opsTenantHistory.mockResolvedValue(HISTORY);
});

describe('Revenue Management > a tenant\'s rents', () => {
  it('shows every rate with its day, what is coming, eligibility and Cubby\'s notes', async () => {
    render(<TenantHistory facilityId="fac_t" tenantKey="lease_a1" name="Ada Sample" onClose={() => {}} />);
    expect(await screen.findByText('Rate History')).toBeTruthy();
    expect(api.opsTenantHistory).toHaveBeenCalledWith('fac_t', 'lease_a1');
    expect(screen.getByText('01/10/2024')).toBeTruthy();
    expect(screen.getByText('$95.00')).toBeTruthy();
    expect(screen.getByText('+$5.00 (+5.6%)')).toBeTruthy();
    expect(screen.getByText(/Scheduled in Cubby: \$108.00/)).toBeTruthy();
    expect(screen.getByText(/Not Eligible/)).toBeTruthy();
    expect(screen.getByText(/already scheduled in Cubby/)).toBeTruthy();
    expect(screen.getByText('Asked to hold the rent until spring')).toBeTruthy();
    expect(screen.getByText(/-33.3%/)).toBeTruthy();
  });

  it('keeps a comment, with the hold mark, in the log', async () => {
    api.addOpsTenantComment.mockResolvedValue({ comments: [
      { id: 'c1', text: "Can't handle an increase", hold: true, author: 'Ops Manager', authorEmail: 'ops.manager@greensglobal.com',
        createdAt: '2026-10-20T17:00:00Z', withdrawn: false, withdrawnAt: '' }] });
    render(<TenantHistory facilityId="fac_t" tenantKey="lease_a1" onClose={() => {}} />);
    const box = await screen.findByLabelText('New comment');
    expect(screen.getByRole('button', { name: 'Add Comment' })).toBeDisabled();
    fireEvent.change(box, { target: { value: "Can't handle an increase" } });
    fireEvent.click(screen.getByLabelText(/Hold rent increases/));
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    await waitFor(() => expect(api.addOpsTenantComment).toHaveBeenCalledWith({ facility_id: 'fac_t', key: 'lease_a1', text: "Can't handle an increase", hold: true }));
    expect(await screen.findByText("Can't handle an increase")).toBeTruthy();
    expect(screen.getByText(/holds rent increases/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take back this comment, press and hold' })).toBeTruthy();
  });

  it('says so when Cubby does not answer, and keeps the rest', async () => {
    api.opsTenantHistory.mockResolvedValue({ ...HISTORY, cubbyNotes: [], cubbyNotesError: 'Cubby did not answer: timeout' });
    render(<TenantHistory facilityId="fac_t" tenantKey="lease_a1" onClose={() => {}} />);
    expect(await screen.findByText('Cubby did not answer: timeout')).toBeTruthy();
    expect(screen.getByText('Rate History')).toBeTruthy();
  });
});
