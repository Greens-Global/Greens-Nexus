import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the candidate card (Neil, Oct 8): each stage offers its
// own next step and nothing from a later stage.

const rounds = [{ id: 'r1', status: 'scheduled', at: '2026-11-02T17:00:00Z', durationMin: 45,
  interviewerNames: ['Neil K'], templateName: 'Analyst' }];
vi.mock('../api', () => ({
  api: {
    getCandidateHistory: () => Promise.resolve([]),
    ivList: (id) => Promise.resolve(id === 'with-round' ? rounds : []),
    getLifeEvents: () => Promise.resolve([]),
    hiringPacketOptions: () => Promise.resolve({ picked: null, options: [] }),
  },
}));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary']] }));
vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));

const { default: CandidateDetailModal } = await import('./HiringCandidateDetail');
const base = { id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com', roleTitle: 'Analyst' };
const noop = () => {};
const props = { onClose: noop, onStage: vi.fn(), onSchedule: vi.fn(), onOpenRoom: noop, onSendPacket: noop, onEdit: noop };

describe('CandidateDetailModal', () => {
  it('Applied: move to Screening or reject - no Interview Room', async () => {
    render(<CandidateDetailModal {...props} candidate={{ ...base, stage: 'applied' }} />);
    expect(screen.getByText('Move To Screening')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    expect(screen.queryByText('Interview Room')).toBeNull();
    expect(screen.queryByText('Schedule Interview')).toBeNull();
  });

  it('Screening: schedule the interview - not "move to interview"', () => {
    const onSchedule = vi.fn();
    render(<CandidateDetailModal {...props} onSchedule={onSchedule} candidate={{ ...base, stage: 'screening' }} />);
    expect(screen.queryByText(/Move To Interview/)).toBeNull();
    fireEvent.click(screen.getByText('Schedule Interview'));
    expect(onSchedule).toHaveBeenCalled();
  });

  it('Screening without an email cannot schedule and says why', () => {
    const onSchedule = vi.fn();
    const toastErr = vi.fn();
    render(<CandidateDetailModal {...props} onSchedule={onSchedule} toastErr={toastErr} candidate={{ ...base, email: '', stage: 'screening' }} />);
    fireEvent.click(screen.getByText('Schedule Interview'));
    expect(onSchedule).not.toHaveBeenCalled();
    expect(toastErr).toHaveBeenCalled();
    expect(screen.getByText(/No email yet/)).toBeTruthy();
  });

  it('Interview: shows the round with who it is with, and the room', async () => {
    render(<CandidateDetailModal {...props} candidate={{ ...base, id: 'with-round', stage: 'interview' }} />);
    await waitFor(() => expect(screen.getByText(/With Neil K/)).toBeTruthy());
    expect(screen.getByText(/Questionnaire: Analyst/)).toBeTruthy();
    expect(screen.getByText('Interview Room')).toBeTruthy();
    expect(screen.getByText('Move To Offer')).toBeTruthy();
  });

  it('Offer: the hiring packet is the next step; another interview still possible', async () => {
    render(<CandidateDetailModal {...props} candidate={{ ...base, stage: 'offer' }} />);
    await waitFor(() => expect(screen.getByText('Send Hiring Packet').closest('button')).not.toBeDisabled());
    expect(screen.getByText('Another Interview')).toBeTruthy();
    expect(screen.getByText('Mark Hired By Hand')).toBeTruthy();
  });

  it('Rejected: reopen', () => {
    const onStage = vi.fn();
    render(<CandidateDetailModal {...props} onStage={onStage} candidate={{ ...base, stage: 'rejected' }} />);
    fireEvent.click(screen.getByText('Reopen'));
    expect(onStage).toHaveBeenCalledWith(expect.anything(), 'applied', 'Reopened');
  });
});
