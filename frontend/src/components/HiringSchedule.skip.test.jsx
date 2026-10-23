import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Neil, Oct 22: Skip Interview - far left of the Schedule Interview footer,
// straight to Decision, with an optional reason.
const updateCandidate = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: { ivTemplates: () => Promise.resolve([]), hiringOptions: () => Promise.resolve({}), updateCandidate: (...a) => updateCandidate(...a) },
}));
const promptMock = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => promptMock(...a), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'hr@x.com' }) }));
vi.mock('../tasks/components', () => ({ DateField: () => null }));
vi.mock('./PersonSearchSelect', () => ({ default: () => null }));

const { ScheduleInterviewModal } = await import('./HiringSchedule');
const cand = { id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com', stage: 'screening' };

describe('Skip Interview', () => {
  beforeEach(() => { updateCandidate.mockClear(); promptMock.mockReset(); });

  it('sits first in the footer and moves them to Decision with the note', async () => {
    promptMock.mockResolvedValue('It already happened');
    const onScheduled = vi.fn();
    render(<ScheduleInterviewModal candidate={cand} onClose={() => {}} onScheduled={onScheduled} />);
    const skip = screen.getByText('Skip Interview');
    expect(skip.parentElement.firstElementChild).toBe(skip);
    fireEvent.click(skip);
    expect(promptMock.mock.calls[0][0]).toMatch(/Skip the interview and move Jane Doe to Decision\?/);
    expect(promptMock.mock.calls[0][1].multiline).toBe(true);        // the note fills the popup (nx-fill), not one floating line
    await waitFor(() => expect(onScheduled).toHaveBeenCalled());
    expect(updateCandidate).toHaveBeenCalledWith('c1', { stage: 'decision', skip_interview: true, stage_note: 'It already happened' });
  });

  it('cancel does nothing', async () => {
    promptMock.mockResolvedValue(null);
    render(<ScheduleInterviewModal candidate={cand} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Skip Interview'));
    await waitFor(() => expect(promptMock).toHaveBeenCalled());
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it('not offered on a reschedule or another round', () => {
    const { unmount } = render(<ScheduleInterviewModal candidate={{ ...cand, stage: 'decision' }} onClose={() => {}} />);
    expect(screen.queryByText('Skip Interview')).toBeNull();
    unmount();
    render(<ScheduleInterviewModal candidate={cand} replace={{ id: 'r1', at: '2026-11-02T17:00:00Z' }} onClose={() => {}} />);
    expect(screen.queryByText('Skip Interview')).toBeNull();
  });
});
