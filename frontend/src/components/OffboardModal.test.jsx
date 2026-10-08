import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Offboard (Neil, Oct 8): the last day decides where the
// paperwork goes and when they become Left.

const offboard = vi.fn(() => Promise.resolve({ id: 'ev1', applyStatus: 'scheduled', effectiveDate: '2099-01-31' }));
vi.mock('../api', () => ({
  api: {
    previewOffboard: (eid, body) => Promise.resolve({
      immediate: body.inputs.last_day <= new Date().toISOString().slice(0, 10), lastDay: body.inputs.last_day,
      package: true, documents: ['Separation Package'], sendTo: 'erin@x.com', why: 'they still have their work email until their last day',
      recipients: [{ order: 1, role: 'company', name: 'Hana', email: 'hana@x.com' }, { order: 2, role: 'employee', name: 'Erin Lee', email: 'erin@x.com', isSubject: true }],
      unresolved: [], egnyteSubfolder: 'Separation Documents',
    }),
    offboard: (...a) => offboard(...a),
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'max@x.com', name: 'Max' }] }) }));
vi.mock('./ESign', () => ({ SignModal: () => null }));

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
    fireEvent.change(screen.getByDisplayValue(new Date().toISOString().slice(0, 10)), { target: { value: '2099-01-31' } });
    expect(screen.getByText(/On 01\/31\/2099 Nexus marks them Left by itself/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    await waitFor(() => expect(screen.getByText('Schedule Offboarding')).toBeTruthy());
    expect(screen.getByText(/Goes to erin@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByText(/I confirm this is not a record/));
    fireEvent.click(screen.getByText('Schedule Offboarding'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(offboard.mock.calls[0][1].inputs.offboarding.mailboxAction).toBe('remove');
  });
});
