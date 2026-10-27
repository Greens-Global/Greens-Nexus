import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Leave year end (Oct 27 2026): the Settings panel opens on Use It Or Lose
// It with the California note, a cap shows its number and unit, Save only
// once something changed; Second Approval By HR saves on click; HR's
// preview lists what expires and offers Apply Year End for a year owed.

const save = vi.fn();
const approvalSet = vi.fn();
const preview = vi.fn();
const CFG = {
  vacationMode: 'reset', vacationCap: 0, vacationCapUnit: 'hours', vacationYear: 'calendar',
  sickMode: 'reset', sickCap: 0, sickCapUnit: 'hours', company: '', hasOverride: false,
  legal: [{ state: 'CA', note: 'California vacation does not expire - required by law (Labor Code 227.3).' }],
};
vi.mock('../api', () => ({
  api: {
    leaveYearEndSettings: () => Promise.resolve(CFG),
    leaveYearEndSettingsSave: (...a) => save(...a),
    timeOffApprovalGet: () => Promise.resolve({ secondHr: false, hasOverride: false }),
    timeOffApprovalSet: (...a) => approvalSet(...a),
    leaveYearEndPreview: (...a) => preview(...a),
    leaveYearEndApply: () => Promise.resolve({ rows: 2, people: 1, failed: [], preview: null }),
  },
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: () => Promise.resolve(true) } }));

const { LeaveYearEndSettings, TimeOffApprovalSettings, LeaveYearEndPreview } = await import('./LeaveYearEnd');

const person = (owed) => ({
  email: 'omar@x.com', name: 'Omar Test', policy: { id: 'us-other', name: 'US - Other States', unit: 'hours', hoursPerDay: 8 }, state: '',
  buckets: {
    vacation: { closesOn: '2026-12-31', projected: false, closing: 30, carried: 0, expired: 30, exempt: false, note: '', toWrite: { expire: owed ? -30 : 0, carryover: 0 } },
    sick: { closesOn: '2026-12-31', projected: false, closing: 0, carried: 0, expired: 0, exempt: false, note: '', toWrite: { expire: 0, carryover: 0 } },
  },
});

beforeEach(() => {
  save.mockReset().mockImplementation((body) => Promise.resolve({ ...CFG, ...body }));
  approvalSet.mockReset().mockImplementation((body) => Promise.resolve({ secondHr: body.secondHr, hasOverride: false }));
  preview.mockReset().mockImplementation((company, period) => Promise.resolve({
    company: '', period, canAll: true, companies: [{ id: 'co', name: 'Greens Co' }],
    settings: CFG, people: [person(period === 'last')],
    totals: { vacation: { expired: 30 }, sick: { expired: 0 } },
  }));
});

describe('Leave Year-End settings', () => {
  it('opens on Use It Or Lose It with the California note; a cap shows its fields; Save sends the rule', async () => {
    render(<LeaveYearEndSettings toastOk={() => {}} toastErr={() => {}} />);
    const vac = await screen.findByLabelText('Vacation at year end');
    expect(vac.value).toBe('reset');
    expect(screen.getAllByText(/California vacation does not expire/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(vac, { target: { value: 'carry_cap' } });
    fireEvent.change(screen.getByLabelText('Vacation carry-over cap'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Vacation cap unit'), { target: { value: 'days' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ vacationMode: 'carry_cap', vacationCap: 5, vacationCapUnit: 'days', sickMode: 'reset' });
  });

  it('Second Approval By HR saves on click', async () => {
    render(<TimeOffApprovalSettings toastOk={() => {}} toastErr={() => {}} company="co" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Second Approval By HR' }));
    await vi.waitFor(() => expect(approvalSet).toHaveBeenCalledWith({ secondHr: true }, 'co'));
  });
});

describe('Year End preview', () => {
  it('projects the next year end, and offers Apply for the last one still owed', async () => {
    render(<LeaveYearEndPreview toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Omar Test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply Year End' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Last Year End' }));
    expect(await screen.findByRole('button', { name: 'Apply Year End' })).toBeTruthy();
    expect(screen.getByText('Not Applied Yet')).toBeTruthy();
  });
});
