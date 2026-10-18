import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Nexus Sign's own signing screen for a CA-rule employee's time sheet (Neil,
// Oct 18 2026): NO question before consent, the code or the signature. The
// document screen shows the meal and rest break statement the signature
// confirms, with Report a Missed Break, which sends the time sheet back and
// closes signing.

const apiMock = vi.hoisted(() => ({ mySignRender: vi.fn(), timesheetBreakClaim: vi.fn(), mySignHistory: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

import { SignModal } from './ESign';

const STATEMENT = 'By signing, I confirm that in this pay period I was provided every meal and rest break California law requires.';
const ATT = { required: true, answered: false, reviewId: 'rv1', statement: STATEMENT,
  flaggedDays: [{ date: '2026-09-16', chip: 'Meal Late', label: 'Meal break started after the 5th hour of work' }],
  workedDays: ['2026-09-16'] };
const BASE = { partyId: 'p1', requestId: 'q1', title: 'Time Sheet - Erin', parties: [], breakAttestation: ATT };

beforeEach(() => { Object.values(apiMock).forEach(f => f.mockReset()); });

describe('SignModal - CA meal and rest break statement', () => {
  it('goes straight to the signing steps - no question first', async () => {
    apiMock.mySignRender.mockResolvedValue({ ...BASE, gate: 'consent' });
    render(<SignModal partyId="p1" onClose={() => {}} onDone={() => {}} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(apiMock.mySignRender).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Yes, Continue to Sign' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Meal and Rest Breaks' })).toBeNull();
  });

  it('the document screen shows the statement; Report a Missed Break sends it back', async () => {
    apiMock.mySignRender.mockResolvedValue({ ...BASE, gate: null, consentAt: '2026-10-18T10:00:00Z', myTurn: true,
      status: 'pending', source: 'template', body: [], fields: [] });
    apiMock.timesheetBreakClaim.mockResolvedValue({});
    const onDone = vi.fn();
    render(<SignModal partyId="p1" onClose={() => {}} onDone={onDone} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(STATEMENT)).toBeTruthy();
    expect(screen.getByText(/Meal break started after the 5th hour of work/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Report a Missed Break' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Back to Manager' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiMock.timesheetBreakClaim).toHaveBeenCalledWith('rv1', { claims: [{ date: '2026-09-16', kind: 'meal' }], note: '' });
  });
});
