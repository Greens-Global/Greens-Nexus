import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Probation (Neil, Oct 27 2026): the badge, the profile card for HR and for
// a manager (who only recommends), the decision dialog, End Employment
// handing over to Offboard, and the Settings panel.

// Date boxes are the shared DateField (never a native date input); a plain
// input stands in so the test can type a date.
vi.mock('../tasks/components', async (orig) => ({
  ...(await orig()),
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={e => onChange(e.target.value)} />,
}));

const base = {
  employeeId: 'e1', applies: true, status: 'in_probation', label: 'In Probation', startDate: '2029-12-31', endDate: '2030-03-31',
  months: 3, monthsOverride: null, companyMonths: 3, endManual: false, reminderDays: 14, daysLeft: 9, ending: true,
  awaitingStart: false, pending: null, decision: null, letter: {}, history: [
    { at: '2029-12-31T10:00:00Z', by: 'hana@x.com', byName: 'Hana Hr', action: 'started', endDate: '2030-03-31', reason: 'Hired', note: '' },
  ], role: 'hr', canDecide: true, canFinalize: true, canManage: true, employeeActive: true, hasWorkEmail: true,
};
let current = base;
const decide = vi.fn();
const removeFn = vi.fn();
const startFn = vi.fn();
const sendLetter = vi.fn();
const settingsSave = vi.fn(() => Promise.resolve({ settings: { months: 6, reminderDays: 14 }, override: true }));
vi.mock('../api', () => ({
  api: {
    probationGet: () => Promise.resolve(current),
    probationDecide: (...a) => decide(...a),
    probationApprove: vi.fn(() => Promise.resolve({ applied: true, probation: base })),
    probationLetterPreview: vi.fn(() => Promise.resolve({ blob: new Blob(['%PDF']) })),
    probationSettings: () => Promise.resolve({
      company: 'c1', settings: { months: 3, reminderDays: 14, confirmTemplateId: 't1', extendTemplateId: 't2', letterheadId: '' },
      limits: { months: [1, 24], reminderDays: [0, 90] }, override: false, canEdit: true, canEditDefault: true, companies: [],
      templates: [{ id: 't1', name: 'Probation Confirmation Letter', published: true }, { id: 't2', name: 'Probation Extension Letter', published: true }],
      letterheads: [],
    }),
    probationSaveSettings: (...a) => settingsSave(...a),
    probationRemove: (...a) => removeFn(...a),
    probationStart: (...a) => startFn(...a),
    probationSendLetter: (...a) => sendLetter(...a),
  },
}));

const { ProbationBadge, ProbationCard, ProbationSettings } = await import('./HrProbation');
const jane = { id: 'e1', firstName: 'Jane', lastName: 'Doe', startDate: '2029-12-31' };

beforeEach(() => { current = base; decide.mockReset(); removeFn.mockReset(); startFn.mockReset(); sendLetter.mockReset(); });

describe('ProbationBadge', () => {
  it('shows only while a decision is due', () => {
    const { rerender, container } = render(<ProbationBadge p={{ status: 'in_probation', ending: true, daysLeft: 5, endDate: '2030-03-31' }} />);
    expect(screen.getByText('Probation Ending')).toBeTruthy();
    rerender(<ProbationBadge p={{ status: 'extended', ending: true, daysLeft: -2, endDate: '2030-03-31' }} />);
    expect(screen.getByText('Probation Overdue')).toBeTruthy();
    rerender(<ProbationBadge p={{ status: 'confirmed', ending: false }} />);
    expect(container.textContent).toBe('');
  });
});

describe('ProbationCard', () => {
  it('HR: status, US dates, history, and an extension decided with a date and a reason', async () => {
    decide.mockResolvedValue({ applied: true, status: 'extended', letter: { sent: true, title: 'Probation Extension Letter - Jane Doe' }, probation: { ...base, status: 'extended', label: 'Extended' } });
    const toastOk = vi.fn();
    render(<ProbationCard employee={jane} toastOk={toastOk} toastErr={() => {}} />);
    expect(await screen.findByText('In Probation')).toBeTruthy();
    expect(screen.getByText('03/31/2030')).toBeTruthy();
    expect(screen.getByText('(in 9 days)')).toBeTruthy();
    expect(screen.getByText('Probation Ending')).toBeTruthy();
    expect(screen.getByText(/started tracking/)).toBeTruthy();
    fireEvent.click(screen.getByText('Decide'));
    fireEvent.click(screen.getByRole('radio', { name: /Extend/ }));
    expect(screen.getByText('Extend Probation').closest('button').disabled).toBe(true);   // date and reason first
    fireEvent.change(screen.getByLabelText('New end date'), { target: { value: '2030-05-31' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'More time on the close' } });
    fireEvent.click(screen.getByText('Extend Probation'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('e1', { decision: 'extend', new_end_date: '2030-05-31', reason: 'More time on the close' }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Saved - Probation Extension Letter - Jane Doe sent to Jane to sign.'));
    expect(await screen.findByText('Extended')).toBeTruthy();
  });

  it('a manager recommends - HR decides', async () => {
    current = { ...base, role: 'manager', canFinalize: false, canManage: false };
    decide.mockResolvedValue({ applied: false, pending: true, probation: { ...current, canDecide: false,
      pending: { decision: 'confirm', label: 'Confirm', byName: 'Max Mgr', at: '2030-03-10T00:00:00Z', reason: '' } } });
    const toastOk = vi.fn();
    render(<ProbationCard employee={jane} toastOk={toastOk} toastErr={() => {}} />);
    fireEvent.click(await screen.findByText('Recommend'));
    expect(screen.getByText(/goes to HR as a recommendation/)).toBeTruthy();
    expect(screen.queryByText('Preview Letter')).toBeNull();          // only HR sends letters
    fireEvent.click(screen.getByRole('radio', { name: /Confirm/ }));
    fireEvent.click(screen.getByText('Send Recommendation'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Recommendation sent to HR.'));
    expect(await screen.findByText(/Waiting for HR/)).toBeTruthy();
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('End Employment hands over to Offboard with Termination and the reason', async () => {
    decide.mockResolvedValue({ applied: true, status: 'ended', startSeparation: true, probation: { ...base, status: 'ended', label: 'Ended' } });
    const onOffboard = vi.fn();
    render(<ProbationCard employee={jane} onOffboard={onOffboard} toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByText('Decide'));
    fireEvent.click(screen.getByRole('radio', { name: /End Employment/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Did not meet the standards' } });
    fireEvent.click(screen.getAllByText('End Employment').find(el => el.closest('button')?.className === 'primary-btn'));
    await waitFor(() => expect(onOffboard).toHaveBeenCalledWith({ exit_type: 'termination', reason: 'Did not meet the standards' }));
  });

  it('Not Tracked: HR can start tracking; nothing shows for a contractor', async () => {
    current = { ...base, status: '', label: 'Not Tracked', canDecide: false, history: [] };
    const { unmount } = render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Not Tracked')).toBeTruthy();
    expect(screen.getByText('Start Tracking')).toBeTruthy();
    expect(screen.getByText(/HR can start it from their start date/)).toBeTruthy();
    unmount();
    current = { ...base, status: '', applies: false };
    const { container } = render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

// Past the window (Neil, Oct 29 2026): passed by itself, past (never
// tracked), and Remove From Probation.
describe('ProbationCard past the window', () => {
  const passed = {
    ...base, status: 'passed', label: 'Passed Probation', canDecide: false, canRemove: false, canSendLetter: true, ending: false, daysLeft: null,
    endDate: '2027-01-29', startDate: '2026-10-29',
    decision: { decision: 'passed', by: 'system', byName: 'Nexus', at: '2027-01-30T08:00:00Z', automatic: true, reason: 'Reached the end of probation with no decision - passed automatically.' },
    history: [{ at: '2027-01-30T08:00:00Z', by: 'system', byName: 'Nexus', action: 'passed', reason: 'Reached the end of probation with no decision - passed automatically.' }],
  };

  it('Passed Probation: automatically, no decision; HR can send the confirmation letter and start a new one', async () => {
    current = passed;
    sendLetter.mockResolvedValue({ letter: { sent: true, title: 'Probation Confirmation Letter - Jane Doe' }, probation: { ...passed, canSendLetter: false } });
    const toastOk = vi.fn();
    render(<ProbationCard employee={jane} toastOk={toastOk} toastErr={() => {}} />);
    expect(await screen.findByText('Passed Probation')).toBeTruthy();
    expect(screen.getByText('Passed Probation on 01/29/2027 - automatically, no decision was recorded')).toBeTruthy();
    expect(screen.getByText(/Nexus/)).toBeTruthy();
    expect(screen.queryByText('Decide')).toBeNull();
    expect(screen.queryByText('Remove From Probation')).toBeNull();
    expect(screen.getByText('Start A New Probation')).toBeTruthy();
    fireEvent.click(screen.getByText('Send Letter'));
    await waitFor(() => expect(sendLetter).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Saved - Probation Confirmation Letter - Jane Doe sent to Jane to sign.'));
  });

  it('Past Probation: never tracked and past the window - no Start Tracking prompt, only a new probation', async () => {
    current = { ...base, status: 'past', label: 'Past Probation', pastSince: '2026-04-15', startDate: '', endDate: '', canDecide: false, canRemove: false, history: [] };
    startFn.mockResolvedValue({ probation: { ...base } });
    render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Past Probation')).toBeTruthy();
    expect(screen.getByText(/Past Probation since 04\/15\/2026/)).toBeTruthy();
    expect(screen.queryByText('Start Tracking')).toBeNull();
    expect(screen.queryByText('Not Tracked')).toBeNull();
    fireEvent.click(screen.getByText('Start A New Probation'));
    expect(screen.getByRole('dialog', { name: /Start A New Probation - Jane Doe/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Counts from'), { target: { value: '2030-03-01' } });
    fireEvent.click(screen.getAllByText('Start A New Probation').find(el => el.className === 'primary-btn'));
    await waitFor(() => expect(startFn).toHaveBeenCalledWith('e1', { months: null, reason: '', start_date: '2030-03-01' }));
  });

  it('Removed From Probation: on what day, by whom and why', async () => {
    current = { ...base, status: 'removed', label: 'Removed From Probation', canDecide: false, canRemove: false, ending: false, daysLeft: null,
      decision: { decision: 'removed', by: 'hana@x.com', byName: 'Hana Hr', at: '2030-03-10T17:00:00Z', reason: 'Moved from a sister company' } };
    render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Removed From Probation on 03/10/2030 by Hana Hr: Moved from a sister company')).toBeTruthy();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.getByText('Start A New Probation')).toBeTruthy();
  });

  it('Remove From Probation asks for the reason, then removes', async () => {
    current = { ...base, canRemove: true };
    removeFn.mockResolvedValue({ probation: { ...base, status: 'removed', label: 'Removed From Probation', canDecide: false, canRemove: false,
      decision: { decision: 'removed', byName: 'Hana Hr', at: '2030-03-10T17:00:00Z', reason: 'Started by mistake' } } });
    const toastOk = vi.fn();
    render(<ProbationCard employee={jane} toastOk={toastOk} toastErr={() => {}} />);
    expect(screen.queryByText('Stop Tracking')).toBeNull();
    fireEvent.click(await screen.findByText('Remove From Probation'));
    const dialog = screen.getByRole('dialog', { name: /Remove From Probation - Jane Doe/ });
    expect(dialog.textContent).toMatch(/no reminder, no decision and no letter/);
    const confirm = screen.getAllByText('Remove From Probation').find(el => el.className === 'primary-btn');
    expect(confirm.disabled).toBe(true);                                 // the reason first
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Started by mistake' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('e1', 'Started by mistake'));
    expect(await screen.findByText('Removed From Probation on 03/10/2030 by Hana Hr: Started by mistake')).toBeTruthy();
    expect(toastOk).toHaveBeenCalledWith('Saved.');
  });

  it('a manager cannot remove - they recommend', async () => {
    current = { ...base, role: 'manager', canFinalize: false, canManage: false, canRemove: false };
    render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Recommend')).toBeTruthy();
    expect(screen.queryByText('Remove From Probation')).toBeNull();
  });
});

describe('ProbationSettings', () => {
  it('rows for the length, reminder and letters; Save once something changed', async () => {
    const onOverride = vi.fn();
    render(<ProbationSettings company="c1" onOverride={onOverride} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Probation Length')).toBeTruthy();
    expect(screen.getByText('Confirmation Letter')).toBeTruthy();
    expect(screen.getByText('Extension Letter')).toBeTruthy();
    expect(screen.queryByText('Save')).toBeNull();
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(false));
    fireEvent.change(screen.getByLabelText('Probation Length'), { target: { value: '6' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(settingsSave).toHaveBeenCalledWith(expect.objectContaining({ company: 'c1', reset: false })));
    expect(settingsSave.mock.calls[0][0].settings.months).toBe(6);
  });
});
