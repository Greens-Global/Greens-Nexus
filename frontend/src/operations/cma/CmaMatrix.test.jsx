import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Rate Management > CMA (Oct 28 2026 call with Neil, B17 / B18): every unit
// type grouped Self-Storage / Vehicle Storage / Mailboxes, each competitor's
// rate, its distance from ours and its promotion, typed in place.
const api = { saveOpsCmaSurvey: vi.fn(), getTaskTablePrefs: vi.fn(), saveTaskTablePrefs: vi.fn() };
vi.mock('../../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'jane.walker@greensglobal.com' }) }));

const { default: CmaMatrix, vsOurs } = await import('./CmaMatrix');

const row = (name, category, extra = {}) => ({ name, category, width: 10, depth: 10, total: 10, rented: 8, occupancy: 0.8, set: 15000, sell: 14000,
  algorithmWebRate: null, marketAvg: 15000, variance: -1000, variancePct: -0.0667, comps: [], ...extra });
const VIEW = {
  facilityId: 'fac_t', facility: 'Temecula', name: 'Greens Storage Temecula', asOf: '2026-10-20', lastSurvey: '2026-10-01', canEdit: true,
  competitors: [{ id: 'c1', name: 'StorQuest', distanceMiles: 1.2 }, { id: 'c2', name: 'Public Storage', distanceMiles: 2.5 }],
  rows: [
    row("10' x 10' Storage - Drive-Up", 'Self-Storage', { comps: [
      { competitorId: 'c1', competitor: 'StorQuest', rate: 15120, promo: 'First Month $1', source: 'web', observedOn: '2026-10-19' },
      { competitorId: 'c2', competitor: 'Public Storage', rate: 13300, promo: '', source: 'manual', observedOn: '2026-10-02' }] }),
    row("10' x 20' Parking - Gravel, Drive-In", 'Vehicle Storage', { width: 10, depth: 20, parking: true }),
    row("0' x 3' mailbox", 'Mailboxes', { width: 0, depth: 3 }),
  ],
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getTaskTablePrefs.mockResolvedValue({ prefs: {} });
  api.saveTaskTablePrefs.mockResolvedValue({});
  api.saveOpsCmaSurvey.mockResolvedValue({});
});

describe('Rate Management > CMA', () => {
  it('reads a competitor against our Web Rate', () => {
    expect(vsOurs(15120, 14000)).toBeCloseTo(0.08);
    expect(vsOurs(null, 14000)).toBeNull();
  });

  it('lists every unit type in its group with each competitor, their distance from us and their promotion', () => {
    render(<CmaMatrix view={VIEW} onReload={() => {}} />);
    const groups = [...document.querySelectorAll('.cma-mx-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Self-Storage 1', 'Vehicle Storage 1', 'Mailboxes 1']);
    expect(screen.getByText('StorQuest')).toBeTruthy();
    expect(screen.getByText('+8.0%')).toBeTruthy();        // $151.20 against our $140
    expect(screen.getByText('-5.0%')).toBeTruthy();        // $133 against our $140
    expect(screen.getByText('First Month $1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Mailboxes' } });
    expect([...document.querySelectorAll('.cma-mx-group')].map((g) => g.textContent)).toEqual(['Mailboxes 1']);
  });

  it('records a rate typed in a cell as a manual survey for that unit type', async () => {
    const onReload = vi.fn();
    render(<CmaMatrix view={VIEW} onReload={onReload} />);
    expect(screen.getByLabelText('Surveyed By')).toHaveValue('Jane Walker');
    fireEvent.click(screen.getByRole('button', { name: "Public Storage rate for 10' x 20' Parking - Gravel, Drive-In" }));
    const box = screen.getByRole('textbox', { name: "Public Storage rate for 10' x 20' Parking - Gravel, Drive-In" });
    fireEvent.change(box, { target: { value: '89.50' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);                 // the blur Enter causes, and any second one, save once
    await waitFor(() => expect(api.saveOpsCmaSurvey).toHaveBeenCalledTimes(1));
    expect(api.saveOpsCmaSurvey.mock.calls[0][0]).toMatchObject({
      facility_id: 'fac_t', competitor_id: 'c2', survey_date: '2026-10-20', method: 'phone', surveyed_by: 'Jane Walker',
      rates: [{ their_size: '10 x 20', kind: 'parking', street: 89.5, matched_unit_type: "10' x 20' Parking - Gravel, Drive-In" }],
    });
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('keeps a promotion with a rate, never alone', () => {
    render(<CmaMatrix view={VIEW} onReload={() => {}} />);
    expect(screen.getByRole('button', { name: "StorQuest promotion for 0' x 3' mailbox" })).toBeDisabled();
    const table = document.querySelector('.cma-matrix');
    expect(within(table).getByRole('button', { name: "StorQuest promotion for 10' x 10' Storage - Drive-Up" })).not.toBeDisabled();
  });
});
