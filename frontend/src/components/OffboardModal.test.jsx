import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Offboard (Neil, Oct 8): the last day decides where the
// paperwork goes and when they become Left.

// The modal starts on TODAY'S LOCAL date - a UTC date is already tomorrow
// in the evening in the US (after 5 PM Pacific).
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The last day is the shared DateField (a calendar button, never a native date
// box - CLAUDE.md); a plain input stands in for it so the test can type a date.
vi.mock('../tasks/components', async (orig) => ({
  ...(await orig()),
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={e => onChange(e.target.value)} />,
}));

const offboard = vi.fn(() => Promise.resolve({ id: 'ev1', applyStatus: 'scheduled', effectiveDate: '2099-01-31' }));
vi.mock('../api', () => ({
  api: {
    previewOffboard: (eid, body) => Promise.resolve({
      immediate: body.inputs.last_day <= localToday(), lastDay: body.inputs.last_day,
      package: true, documents: ['Separation Package'], sendTo: 'erin@x.com', why: 'they still have their work email until their last day',
      recipients: [{ order: 1, role: 'company', name: 'Hana', email: 'hana@x.com' }, { order: 2, role: 'employee', name: 'Erin Lee', email: 'erin@x.com', isSubject: true }],
      unresolved: [], egnyteSubfolder: 'Separation Documents',
    }),
    offboard: (...a) => offboard(...a),
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'max@x.com', name: 'Max' }] }) }));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary']] }));

const { OffboardModal } = await import('./HrPersonActions');
const erin = { id: 'e1', firstName: 'Erin', lastName: 'Lee', jobTitle: 'Analyst', workEmail: 'erin@x.com', personalEmail: 'erin@gmail.com', managerEmail: 'max@x.com' };

describe('OffboardModal', () => {
  it('today: says their access ends now and the paperwork goes to the personal email', () => {
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByText(/their access ends as soon as you confirm/)).toBeTruthy();
    expect(screen.getByText(/erin@gmail.com/)).toBeTruthy();
  });

  it('a future last day is scheduled', async () => {
    const onSent = vi.fn();
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    fireEvent.change(screen.getByDisplayValue(localToday()), { target: { value: '2099-01-31' } });
    expect(screen.getByText(/through 01\/31\/2099; the morning after, Nexus marks them Left by itself/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    await waitFor(() => expect(screen.getByText('Schedule Offboarding')).toBeTruthy());
    expect(screen.getByText(/Goes to erin@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByText(/I confirm this is not a record/));
    fireEvent.click(screen.getByText('Schedule Offboarding'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(offboard.mock.calls[0][1].inputs.offboarding.mailboxAction).toBe('remove');
  });
  // Hold to confirm (Neil, Oct 30 2026): Offboard Now ends their access at
  // once, so it is a 1.8 s hold; a refusal rewinds it with the reason.
  it('today: Offboard Now is held, and a refusal says why', async () => {
    const onSent = vi.fn();
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    const hold = await screen.findByRole('button', { name: 'Offboard Now, press and hold' });
    expect(hold).toBeDisabled();
    fireEvent.click(screen.getByText(/I confirm this is not a record/));
    expect(hold).not.toBeDisabled();
    offboard.mockClear();
    offboard.mockImplementationOnce(() => Promise.reject(new Error('Only HR may offboard Erin.')));
    vi.useFakeTimers();
    try {
      // a short press does nothing
      fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1200); });
      fireEvent.pointerUp(hold, { pointerId: 1 });
      expect(offboard).not.toHaveBeenCalled();
      fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(1800); });
      expect(offboard).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert').textContent).toBe('Only HR may offboard Erin.');
      expect(onSent).not.toHaveBeenCalled();
      // held again: it goes through and hands the result on
      fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(1800); });
      await act(async () => { vi.advanceTimersByTime(700); });
    } finally { vi.useRealTimers(); }
    expect(offboard).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev1' }));
  });
});
