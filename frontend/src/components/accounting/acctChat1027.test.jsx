import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// Accounting chat, 10/27 triage:
//   02 (Urmi)  a new Possibly Ended months setting re-checks right away and
//              the screen reloads by itself when the check is done; the
//              settings say when it last ran; Possibly Ended is counted and
//              exported.
//   11 (Charmi) an Annual / Semi-Annual / Quarterly month says what its
//              period expects (the rule itself is the API's, see
//              backend/test_acct_chat_1027.py).
//   07 (Neil)  the completeness check: a count in the bar, the gaps in the
//              right-side panel, a click jumps to the line.

vi.mock('../../tasks/components', () => ({
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

// One fixed day for the whole file (was today's year and the machine's zone):
// 10/27/2026 at noon UTC is 10/27 from California to India, so every date
// the screens print reads the same on any machine, any day.
const NOW = new Date('2026-10-27T12:00:00Z');
const Y = NOW.getUTCFullYear();
const mk = (m) => `${Y}-${String(m).padStart(2, '0')}`;
const line = (over = {}) => ({
  id: 'M1', entityCode: '15000', entityName: 'Greens Escondido, LLC.', vendorId: 'V-SDGE', vendorName: 'San Diego Gas & Electric', expenseAccounts: ['62100'],
  category: 'utilities', frequency: 'monthly', frequencyMonths: 0, expectedAmount: 410, startDate: `${Y}-01-01`, endDate: '', status: 'active', notes: '', source: 'manual',
  egnyteFolder: '', egnyteUrl: null, possiblyEnded: null, ...over,
});
const months = (statuses, paid = []) => statuses.map((s, i) => ({ month: mk(i + 1), due: true, expected: 410, paid: paid[i] || 0, status: s }));
const row = (l, st, paid, over = {}) => ({ line: l, months: months(st, paid), paidTotal: (paid || []).reduce((s, x) => s + x, 0), expectedYear: 4920, expectedToDate: 0, paidToDate: 0, balance: 0,
  monthsMissed: st.filter((s) => s === 'missed').length, unread: false, vendorInactive: false, ...over });
const P9 = Array(9).fill(410);
const grid = {
  year: Y, asOf: `${Y}-10-27`, totals: [], summary: { lines: 3, expectedToDate: 0, paidToDate: 0, balance: 0, missed: 1 },
  rows: [
    row(line(), [...Array(8).fill('paid'), 'missed', 'upcoming', 'upcoming', 'upcoming'], [...P9.slice(0, 8)]),
    row(line({ id: 'M2', vendorId: 'V-ATT', vendorName: 'AT&T', notes: 'Disputed - credit coming', possiblyEnded: { since: `${Y}-10-27`, lastPaid: `${Y}-05`, taskId: '' } }),
      [...Array(5).fill('paid'), ...Array(4).fill('missed'), 'upcoming', 'upcoming', 'upcoming'], [410, 410, 410, 410, 410]),
    row(line({ id: 'M3', vendorId: 'V-NONE', vendorName: 'No Amount Co', expectedAmount: 0 }), Array(12).fill('none'), [0], { expectedYear: 0 }),
  ],
};

vi.mock('../../api', () => ({
  withFreshReads: (fn) => fn(),
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido, LLC.' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getMreGrid: vi.fn(async () => grid),
    getMreGridRows: vi.fn(async () => ({ rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    getMreVendor: vi.fn(async () => ({ available: false })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [] })),
    getRecurringSettings: vi.fn(async () => ({ staleMonths: 3, egnyteRoot: '', lastCheck: { startedAt: '2026-10-27T12:00:00+00:00', at: '2026-10-27T12:00:30+00:00', months: 3, result: { mri: { possiblyEnded: 2 }, mre: { possiblyEnded: 29 } } } })),
    saveRecurringSettings: vi.fn(async (body) => ({ ...body, lastCheck: null, recheck: { started: true, running: true, since: '2026-10-27T15:00:00+00:00' } })),
    runRecurringStaleCheck: vi.fn(async () => ({ started: true, running: true, since: '2026-10-27T15:00:00+00:00' })),
    getRecurringStaleCheck: vi.fn(async () => ({ running: false, lastCheck: { startedAt: '2026-10-27T12:00:00+00:00', at: '2026-10-27T12:00:30+00:00', months: 3, result: {} } })),
  },
}));

import MreTab, { lineStanding, monthTitle } from './MreTab';
import { RecurringSettingsButton, checkFinishedSince, lastCheckText } from './recurringShared';
import { gapCount, mreGaps, mriGaps, pfsGaps } from './completeness';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { vi.setSystemTime(NOW); vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } resetAccountingPrefs(); });
afterEach(() => { vi.useRealTimers(); });
beforeAll(async () => { await import('./tableView/panels'); }, 30000);

describe('completeness rules (07)', () => {
  it('MRE: a missed month with no note on the line, no amount, no frequency; notes and ended lines are left out', () => {
    const g = mreGaps(grid.rows);
    expect(g.map((x) => x.id)).toEqual(['M1', 'M3']);
    expect(g[0].items.map((i) => i.text)).toEqual(['Sep ' + Y + ' Missed, no note']);
    expect(g[1].items.map((i) => i.text)).toEqual(['No expected amount']);
    expect(gapCount(g)).toBe(2);
    const custom = mreGaps([row(line({ frequency: 'custom', frequencyMonths: 0 }), Array(12).fill('none'))]);
    // Worded the way the table reads the line: a Custom with no months runs every month.
    expect(custom[0].items[0].text).toBe('Custom months not set - shown as Every Month');
    expect(custom[0].subtitle).toMatch(/Every Month$/);
    expect(mreGaps([row(line({ frequency: 'custom', frequencyMonths: 3 }), Array(12).fill('none'))])).toEqual([]);
    expect(mreGaps([row(line({ frequency: 'custom', frequencyMonths: 1 }), Array(12).fill('none'))])).toEqual([]);
    expect(mreGaps([row(line({ frequency: '' }), Array(12).fill('none'))])[0].items[0].text).toBe('No frequency set - shown as Monthly');
    expect(mreGaps([row(line({ status: 'ended' }), Array(12).fill('missed'))])).toEqual([]);
  });

  it('MRI: a Custom source with no months is named the way its table shows it', () => {
    const src = (over) => ({ lease: { id: 'L9', propertyName: 'P', tenantName: 'T', entityCode: '12014', status: 'active', rates: [{ startDate: `${Y}-01-01`, rent: 100, cam: 0, other: 0 }], ...over }, months: [] });
    const g = mriGaps([src({ frequency: 'custom', frequencyMonths: null })]);
    expect(g[0].items.map((i) => i.text)).toEqual(['Custom months not set - shown as Every Month']);
    expect(g[0].subtitle).toBe('T · 12014 · Every Month');
    expect(mriGaps([src({ frequency: 'custom', frequencyMonths: 2 })])).toEqual([]);
  });

  it('MRE follows the period shown', () => {
    expect(mreGaps(grid.rows, [0, 5]).map((x) => x.id)).toEqual(['M3']);
    expect(mreGaps(grid.rows, [8, 8]).map((x) => x.id)).toEqual(['M1', 'M3']);
  });

  it('MRI: an unpaid month with no note, a source with no amount; a noted month, ledger rows and inactive sources are left out', () => {
    const c = (m, status, note = '') => ({ month: mk(m), inForce: true, expected: 100, received: 0, status, note });
    const lease = (over) => ({ id: 'L1', propertyName: '910 SECR', tenantName: 'T', entityCode: '12014', status: 'active', frequency: 'monthly', rates: [{ startDate: `${Y}-01-01`, rent: 100, cam: 0, other: 0 }], ...over });
    const rows = [
      { lease: lease(), months: [c(1, 'paid'), c(2, 'unpaid'), c(3, 'unpaid', 'Tenant on a plan')] },
      { lease: lease({ id: 'L2', rates: [] }), months: [] },
      { lease: lease({ id: 'L3', status: 'vacant', rates: [] }), months: [c(2, 'unpaid')] },
      { kind: 'account', key: 'a1', months: [] },
    ];
    const g = mriGaps(rows);
    expect(g.map((x) => x.id)).toEqual(['L1', 'L2']);
    expect(g[0].items.map((i) => i.text)).toEqual([`Feb ${Y} Unpaid, no note`]);
    expect(g[1].items.map((i) => i.text)).toEqual(['No amount']);
  });

  it('PFS: a figure kept by hand more than 90 days before the statement date, or with no date; ledger figures never', () => {
    const lines = [
      { id: 'a', section: 'asset', label: 'Savings', source: 'manual', manualAsOf: '2026-06-01', updatedAt: '2026-06-01T00:00:00Z' },
      { id: 'b', section: 'asset', label: 'Brokerage', source: 'manual', manualAsOf: '2026-08-15', updatedAt: '' },
      { id: 'c', section: 'liability', label: 'Card', source: 'manual', manualAsOf: '', updatedAt: '' },
      { id: 'd', section: 'asset', label: 'Operating', source: 'ledger', manualAsOf: '', updatedAt: '2020-01-01' },
      { id: 'e', section: 'real_estate', label: 'House', source: 'manual', manualAsOf: '', updatedAt: '2026-01-02T10:00:00Z' },
    ];
    const g = pfsGaps(lines, '2026-09-30', { asset: 'Assets', liability: 'Liabilities', real_estate: 'Real Estate' });
    expect(g.map((x) => x.id)).toEqual(['a', 'c', 'e']);
    expect(g[0].items[0].text).toBe('Not updated in 121 days (figure from 06/01/2026)');
    expect(g[1].items[0].text).toBe('No date for the figure');
    expect(g[2].subtitle).toBe('Real Estate');
  });
});

describe('MRE screen', () => {
  it('shows the completeness count; the panel lists the gaps and a click outlines the line (07)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<MreTab canEdit canDelete />);
    await screen.findAllByText('AT&T');
    const btn = screen.getByRole('button', { name: /^Completeness: 2 gaps/ });
    fireEvent.click(btn);
    const panel = await screen.findByRole('dialog', { name: 'Completeness' });
    expect(within(panel).getByText(/2 gaps on 2 lines/)).toBeTruthy();
    expect(within(panel).queryByText('AT&T')).toBeNull();     // its missed months have a note
    fireEvent.click(within(panel).getByRole('button', { name: /Go to San Diego Gas & Electric/ }));
    await waitFor(() => expect(document.querySelector('[data-row-id="M1"]').classList.contains('acct-row-flash')).toBe(true));
    expect(scroll).toHaveBeenCalled();
  });

  it('a gap on a line the search hides clears the search to show it (07)', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<MreTab canEdit />);
    await screen.findAllByText('AT&T');
    fireEvent.click(screen.getByRole('button', { name: /Completeness/ }));
    const panel = await screen.findByRole('dialog', { name: 'Completeness' });
    // No Amount Co has nothing paid or expected this year: hidden until Customize > Show Zero.
    expect(document.querySelector('[data-row-id="M3"]')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: /Go to No Amount Co/ }));
    await waitFor(() => expect(document.querySelector('[data-row-id="M3"]')).toBeTruthy());
  });

  it('counts Possibly Ended and exports it in a Status column (02)', async () => {
    render(<MreTab canEdit />);
    await screen.findAllByText('AT&T');
    expect(screen.getByTestId('possibly-ended-count').textContent).toBe('1 Possibly Ended');
    expect(lineStanding(grid.rows[1])).toBe('Possibly Ended');
    expect(lineStanding({ ...grid.rows[0], vendorInactive: true, line: { ...grid.rows[0].line, status: 'ended' } })).toBe('Ended, Inactive');
  });
});

describe('Possibly Ended re-check on save (02)', () => {
  it('saving a new number of months waits for the check, then reloads the screen', async () => {
    vi.useRealTimers();   // the date mock from beforeEach; fake timers carry NOW instead
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    const onChecked = vi.fn();
    render(<RecurringSettingsButton onChecked={onChecked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dlg = await screen.findByRole('dialog', { name: 'MRI and MRE settings' });
    await within(dlg).findByText(/Last checked 10\/27\/2026.* with 3 months: 31 lines Possibly Ended\./);
    fireEvent.change(within(dlg).getByLabelText('Possibly Ended After (Months)'), { target: { value: '5' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await within(dlg).findByText(/being re-checked with 5 months now/);
    expect(api.saveRecurringSettings).toHaveBeenCalledWith({ staleMonths: 5, egnyteRoot: '' });
    expect(within(dlg).getByTestId('last-check').textContent).toBe('Checking now...');
    // The first poll still sees the old check: keep waiting.
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(api.getRecurringStaleCheck).toHaveBeenCalledTimes(1);
    expect(onChecked).not.toHaveBeenCalled();
    api.getRecurringStaleCheck.mockResolvedValue({ running: false, lastCheck: { startedAt: '2026-10-27T15:00:01+00:00', at: '2026-10-27T15:00:09+00:00', months: 5, result: { mre: { possiblyEnded: 20 }, mri: { possiblyEnded: 1 } } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await waitFor(() => expect(onChecked).toHaveBeenCalledTimes(1));
    expect(within(dlg).getByTestId('last-check').textContent).toMatch(/with 5 months: 21 lines Possibly Ended\./);
  });

  it('a save that does not change the months does not re-check', async () => {
    api.saveRecurringSettings.mockResolvedValueOnce({ staleMonths: 3, egnyteRoot: '/Shared', lastCheck: null });
    render(<RecurringSettingsButton onChecked={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dlg = await screen.findByRole('dialog', { name: 'MRI and MRE settings' });
    await within(dlg).findByText(/Last checked/);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await within(dlg).findByText('Saved.');
    expect(api.getRecurringStaleCheck).not.toHaveBeenCalled();
  });

  it('only a check that began after the save counts as done', () => {
    expect(checkFinishedSince({ startedAt: '2026-10-27T15:00:01+00:00' }, '2026-10-27T15:00:00+00:00')).toBe(true);
    expect(checkFinishedSince({ startedAt: '2026-10-27T14:59:00+00:00' }, '2026-10-27T15:00:00+00:00')).toBe(false);
    expect(checkFinishedSince(null, '2026-10-27T15:00:00+00:00')).toBe(false);
    expect(lastCheckText(null)).toBe('Not checked yet.');
  });
});

describe('periodic months (11)', () => {
  it('an annual month says one charge any month of the year settles it', () => {
    const t = monthTitle({ month: `${Y}-08`, expected: 1825, paid: 1905, status: 'over', period: { from: `${Y}-01`, to: `${Y}-12`, expected: 1825, paid: 1905 } }, 'Over');
    expect(t).toBe(`Aug ${Y} - Over. One charge any month Jan ${Y} - Dec ${Y} settles it: expected 1,825.00, paid 1,905.00 in the period (1,905.00 this month).`);
    expect(monthTitle({ month: `${Y}-01`, expected: 410, paid: 0, status: 'missed' }, 'Missed')).toBe(`Jan ${Y} - Missed. Expected 410.00, paid 0.00.`);
  });
});
