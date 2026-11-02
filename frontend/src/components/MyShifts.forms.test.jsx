import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// My Shifts (Forms & Checklists, Neil 11/02/2026): a shift card offers
// "Fill <title>" for every fillable form with Show On Shift Cards that is
// company-wide or for the shift team's site - never one for another site,
// never one without the switch - and opens the fill sheet with the shift.

const formsMine = vi.fn();
const resolved = (v) => vi.fn().mockResolvedValue(v);
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('../api', () => ({
  api: {
    timeMySchedule: vi.fn(),
    timeSchedActuals: resolved({ actuals: [] }),
    timeMyScheduleLive: resolved({ live: [] }),
    timeMyConfirmations: resolved({ confirmations: [] }),
    timeSchedConfirm: resolved({}),
    timeMyPrefsGet: resolved({}),
    timeMyPrefsSet: resolved({}),
    timeMyIcalLink: resolved({ url: '' }),
    timeMyIcalRotate: resolved({ url: '' }),
    weatherCallMine: resolved({ calls: [] }),
    weatherCallMyPrefs: resolved({}),
    weatherCallAck: resolved({}),
    weatherCallMyPrefsSave: resolved({}),
    shiftRequestsMine: resolved({ mine: [], incoming: [], openShifts: [], teammates: [], swapShifts: {}, settings: {} }),
    shiftRequestCreate: resolved({}), shiftRequestRespond: vi.fn(), shiftRequestCancel: vi.fn(),
    availabilityMine: resolved({ days: [] }),
    availabilitySave: resolved({}),
    getPeopleDirectory: resolved([]),
    getRolesDirectory: resolved([]),
    formsMine: (...a) => formsMine(...a),
  },
}));
vi.mock('../forms/FillForm', () => ({ default: ({ templateId, shiftId }) => <div>Filling {templateId} for {shiftId}</div> }));

const { api } = await import('../api');
const MyShifts = (await import('./MyShifts')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY = iso(new Date());
const sched = {
  shift: null, timeoff: [], holidays: [], timeZone: 'America/Los_Angeles',
  scheduled: [{ id: 'mine1', email: 'me@x.com', date: DAY, start: '09:00', end: '17:00', label: 'Front Desk', published: true, groupId: 'g' }],
  teams: [{ id: 'g', name: 'Store', workSiteId: 'siteA', members: [{ email: 'me@x.com', name: 'Me Here', isMe: true, scheduled: [], timeoff: [] }] }],
};
const FORMS = [
  { id: 'f1', title: 'Vehicle Check', category: 'vehicle', showOnShifts: true, workSiteId: '' },
  { id: 'f2', title: 'Opening Checklist', category: 'checklist', showOnShifts: true, workSiteId: 'siteA' },
  { id: 'f3', title: 'Closing Checklist', category: 'checklist', showOnShifts: true, workSiteId: 'siteB' },
  { id: 'f4', title: 'Incident Report', category: 'incident', showOnShifts: false, workSiteId: '' },
];

beforeEach(() => {
  api.timeMySchedule.mockReset().mockResolvedValue(sched);
  formsMine.mockReset().mockResolvedValue(FORMS);   // GET /forms/mine is a bare array
});

describe('My Shifts form buttons', () => {
  it('offers the shift-card forms for this shift and opens one with the shift id', async () => {
    render(<MyShifts part="mine" embedded />);
    expect(await screen.findByRole('button', { name: 'Fill Vehicle Check' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fill Opening Checklist' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fill Closing Checklist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fill Incident Report' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fill Opening Checklist' }));
    expect(await screen.findByText('Filling f2 for mine1')).toBeTruthy();
  });

  it('a failed forms load leaves the card as it was', async () => {
    formsMine.mockRejectedValue(new Error('down'));
    render(<MyShifts part="mine" embedded />);
    expect(await screen.findByText('Front Desk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Fill / })).toBeNull();
  });
});
