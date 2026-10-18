import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Nexus Sign's own signing screen (Documents, the email link) asks a CA-rule
// employee the meal and rest break question BEFORE consent, the code and the
// signature (Oct 18 review): Yes records it and reloads the signing steps; No
// sends the time sheet back and closes signing.

const apiMock = vi.hoisted(() => ({ mySignRender: vi.fn(), timesheetBreakAttest: vi.fn(), timesheetBreakClaim: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

import { SignModal } from './ESign';

const ATT = { required: true, answered: false, reviewId: 'rv1',
  question: 'In this pay period I was provided every meal and rest break California law requires.',
  flaggedDays: [{ date: '2026-09-16', chip: 'Meal Late', label: 'Meal break started after the 5th hour of work' }],
  workedDays: ['2026-09-16'] };
const PAYLOAD = { partyId: 'p1', requestId: 'q1', title: 'Time Sheet - Erin', gate: 'consent', parties: [], breakAttestation: ATT };

beforeEach(() => { Object.values(apiMock).forEach(f => f.mockReset()); });

describe('SignModal - CA meal and rest break question', () => {
  it('asks first; Yes records it and reloads the signing steps', async () => {
    apiMock.mySignRender.mockResolvedValue(PAYLOAD);
    apiMock.timesheetBreakAttest.mockResolvedValue({});
    render(<SignModal partyId="p1" onClose={() => {}} onDone={() => {}} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(ATT.question)).toBeTruthy();
    // The flag's own reason, not a blanket "no full meal break".
    expect(screen.getByText(/Meal break started after the 5th hour of work/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Continue to Sign' }));
    await waitFor(() => expect(apiMock.timesheetBreakAttest).toHaveBeenCalledWith('rv1'));
    await waitFor(() => expect(apiMock.mySignRender).toHaveBeenCalledTimes(2));
  });

  it('No sends it back and closes signing', async () => {
    apiMock.mySignRender.mockResolvedValue(PAYLOAD);
    apiMock.timesheetBreakClaim.mockResolvedValue({});
    const onDone = vi.fn();
    render(<SignModal partyId="p1" onClose={() => {}} onDone={onDone} toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Back to Manager' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiMock.timesheetBreakClaim).toHaveBeenCalledWith('rv1', { claims: [{ date: '2026-09-16', kind: 'meal' }], note: '' });
  });
});
