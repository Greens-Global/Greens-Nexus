import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the candidate card (Neil, Oct 8): each stage offers its
// own next step and nothing from a later stage.

const rounds = [{ id: 'r1', status: 'scheduled', at: '2026-11-02T17:00:00Z', durationMin: 45,
  interviewerNames: ['Neil K'], templateName: 'Analyst' }];
const ctl = { choices: [], optionsFail: false, events: [], decision: { votes: [], decision: '', deciderName: 'Hedy Lead' } };
vi.mock('../api', () => ({
  api: {
    getCandidateHistory: () => Promise.resolve([]),
    ivList: (id) => Promise.resolve(id === 'with-round' ? rounds : []),
    getLifeEvents: () => Promise.resolve(ctl.events),
    hiringPacketOptions: () => Promise.resolve({ picked: null, options: [] }),
    offerOptions: () => (ctl.optionsFail ? Promise.reject(new Error('API error 500')) : Promise.resolve({ choices: ctl.choices })),
    candidateDecision: () => Promise.resolve(ctl.decision),
  },
}));
const confirmMock = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmMock(...a), prompt: vi.fn(), alert: vi.fn() } }));
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
    expect(screen.getByText('Move To Decision')).toBeTruthy();     // Neil, Oct 19: interview over, then a decision
    expect(screen.queryByText('Make Offer')).toBeNull();
  });

  it('Decision: shows each Yes / No with why and the final call; Make Offer is green, Reject red', async () => {
    ctl.decision = { deciderName: 'Hedy Lead', decision: 'hire', decisionByName: 'Hedy Lead', decisionAt: '2026-10-20T15:00:00Z',
      votes: [{ email: 'neil@x.com', name: 'Neil K', vote: 'no', note: 'No - not enough Intacct', at: '2026-10-20T14:00:00Z' },
              { email: 'head@x.com', name: 'Hedy Lead', vote: 'yes', note: 'Yes - I will train them', final: true, at: '2026-10-20T15:00:00Z' },
              { email: 'sam@x.com', name: 'Sam P', vote: '', note: '' }] };
    render(<CandidateDetailModal {...props} candidate={{ ...base, stage: 'decision', decision: 'hire' }} />);
    expect(await screen.findByText('No - not enough Intacct')).toBeTruthy();
    expect(screen.getByText('Yes - I will train them')).toBeTruthy();
    expect(screen.getByText('Waiting for their answer')).toBeTruthy();
    expect(screen.getByText('Final Call: Hire')).toBeTruthy();
    expect(screen.getByText('Make Offer').closest('button').style.background).toContain('--color-green');
    expect(screen.getByText('Reject').closest('button').style.background).toContain('--color-red');
    ctl.decision = { votes: [], decision: '', deciderName: 'Hedy Lead' };
  });

  it('Offer: the hiring packet is the next step; another interview still possible', async () => {
    render(<CandidateDetailModal {...props} candidate={{ ...base, stage: 'offer' }} />);
    await waitFor(() => expect(screen.getByText('Send Hiring Packet').closest('button')).not.toBeDisabled());
    expect(screen.getByText('Another Interview')).toBeTruthy();
    expect(screen.getByText('Mark Hired By Hand')).toBeTruthy();
  });

  it('a skipped interview reads Skipped on the stage bar (Oct 22)', () => {
    render(<CandidateDetailModal {...props} candidate={{ ...base, stage: 'decision', interviewSkippedBy: 'hr@greensglobal.com' }} />);
    expect(screen.getByText('Interview (Skipped)')).toBeTruthy();
  });

  it('Rejected: reopen', () => {
    const onStage = vi.fn();
    render(<CandidateDetailModal {...props} onStage={onStage} candidate={{ ...base, stage: 'rejected' }} />);
    fireEvent.click(screen.getByText('Reopen'));
    expect(onStage).toHaveBeenCalledWith(expect.anything(), 'applied', 'Reopened');
  });
});


// The offer comes first (Pranshu, Oct 15 2026).
describe('Make Offer and the offer progress', () => {
  const reset = (over = {}) => { Object.assign(ctl, { choices: [], optionsFail: false, events: [] }, over); confirmMock.mockReset(); };

  it('with no offer letter set up, says so instead of moving the stage', async () => {
    reset({ choices: [] });
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);   // "no interview yet - continue", then the set-up prompt
    const onStage = vi.fn(), onMakeOffer = vi.fn();
    render(<CandidateDetailModal {...props} onStage={onStage} onMakeOffer={onMakeOffer} candidate={{ ...base, stage: 'decision', decision: 'hire' }} />);
    await waitFor(() => expect(screen.getByText('Make Offer')).toBeTruthy());
    fireEvent.click(screen.getByText('Make Offer'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2));
    expect(confirmMock.mock.calls[1][1]).toMatchObject({ title: 'Set Up an Offer Letter First', confirmText: 'Open Hiring Documents' });
    expect(onStage).not.toHaveBeenCalled();
    expect(onMakeOffer).not.toHaveBeenCalled();
  });

  it('with an offer letter, opens Make An Offer', async () => {
    reset({ choices: [{ id: 'o1', name: 'Offer Letter' }] });
    confirmMock.mockResolvedValue(true);
    const onStage = vi.fn(), onMakeOffer = vi.fn();
    render(<CandidateDetailModal {...props} onStage={onStage} onMakeOffer={onMakeOffer} candidate={{ ...base, stage: 'decision', decision: 'hire' }} />);
    fireEvent.click(await screen.findByText('Make Offer'));
    await waitFor(() => expect(onMakeOffer).toHaveBeenCalled());
    expect(onStage).not.toHaveBeenCalled();
  });

  it('a failed check is an error, never a silent move', async () => {
    reset({ optionsFail: true });
    confirmMock.mockResolvedValue(true);
    const onStage = vi.fn(), onMakeOffer = vi.fn(), toastErr = vi.fn();
    render(<CandidateDetailModal {...props} onStage={onStage} onMakeOffer={onMakeOffer} toastErr={toastErr} candidate={{ ...base, stage: 'decision', decision: 'hire' }} />);
    fireEvent.click(await screen.findByText('Make Offer'));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith('Could not check the offer letters for this company - try again.'));
    expect(onStage).not.toHaveBeenCalled();
    expect(onMakeOffer).not.toHaveBeenCalled();
  });

  it('Offer stage: shows who has signed, and Send Hiring Packet waits for both signatures', async () => {
    reset({ choices: [{ id: 'o1', name: 'Offer Letter' }], events: [{
      id: 'e1', kind: 'offer', status: 'sent', createdAt: '2026-10-15T10:00:00Z', verifiedAt: '2026-10-15T10:05:00Z', flags: [],
      parties: [{ id: 'p1', name: 'Charmi Desai', isSubject: false, signedAt: '2026-10-15T10:10:00Z' },
        { id: 'p2', name: 'Jane Doe', isSubject: true, signedAt: '' }] }] });
    render(<CandidateDetailModal {...props} onMakeOffer={vi.fn()} candidate={{ ...base, stage: 'offer' }} />);
    const list = await screen.findByRole('list', { name: 'Offer progress' });
    expect(list.querySelector('[data-step="verified"]').hasAttribute('data-done')).toBe(true);
    expect(list.querySelector('[data-step="company"]').textContent).toContain('Signed by Charmi Desai');
    expect(list.querySelector('[data-step="candidate"]').textContent).toContain('Waiting for Jane to sign');
    expect(list.querySelector('[data-step="packet"]').hasAttribute('data-done')).toBe(false);
    const send = screen.getByText('Send Hiring Packet').closest('button');
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('title')).toMatch(/once Jane and HR have both signed/);
  });

  it('Offer stage with no offer letter: says so, links to set one up, and the packet stays closed', async () => {
    reset({ choices: [] });
    render(<CandidateDetailModal {...props} onMakeOffer={vi.fn()} candidate={{ ...base, stage: 'offer' }} />);
    expect(await screen.findByText(/No offer letter is set up for/)).toBeTruthy();
    expect(screen.getByText('Set Up Offer Letter')).toBeTruthy();
    expect(screen.queryByText('Make Offer')).toBeNull();
    expect(screen.getByText('Send Hiring Packet').closest('button').disabled).toBe(true);
  });
});

describe('offerSteps', () => {
  it('everything done once both signed and the packet went out', async () => {
    const { offerSteps } = await import('./HiringCandidateDetail');
    const st = offerSteps([
      { kind: 'offer', status: 'completed', createdAt: 'x', verifiedAt: 'y', flags: [],
        parties: [{ isSubject: false, signedAt: 'a', name: 'HR' }, { isSubject: true, signedAt: 'b', name: 'Jane' }] },
      { kind: 'hire', status: 'intake', createdAt: 'z' },
    ], 'Jane');
    expect(st.steps.every(s => s.done)).toBe(true);
  });

  it('a packet that could not start is shown as a problem, with why', async () => {
    const { offerSteps } = await import('./HiringCandidateDetail');
    const st = offerSteps([{ kind: 'offer', status: 'completed', verifiedAt: 'y', parties: [],
      flags: [{ code: 'packet_not_started', message: 'No hiring packet is set up.' }] }], 'Jane');
    const packet = st.steps.find(s => s.key === 'packet');
    expect(packet.error).toBe(true);
    expect(packet.label).toContain('No hiring packet is set up.');
  });
});
