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
  },
}));

const { ProbationBadge, ProbationCard, ProbationSettings } = await import('./HrProbation');
const jane = { id: 'e1', firstName: 'Jane', lastName: 'Doe', startDate: '2029-12-31' };

beforeEach(() => { current = base; decide.mockReset(); });

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
    expect(screen.getByText(/not tracked unless HR starts it/)).toBeTruthy();
    unmount();
    current = { ...base, status: '', applies: false };
    const { container } = render(<ProbationCard employee={jane} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(container.textContent).toBe(''));
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
