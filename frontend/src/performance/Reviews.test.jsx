import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The one review form (Oct 29 2026): the person's numbers and goals beside
// the three questions; the manager scores each goal and picks one of four
// rating words; the employee's shared review has Your Comments and
// Acknowledge; HR's cycle table has Share All Ready and a safe Close.

const m = { perfReview: vi.fn(), perfScorecard: vi.fn(), perfReviewManager: vi.fn(), perfReviewAcknowledge: vi.fn(),
  perfMe: vi.fn(), perfGoalCreate: vi.fn(),
  perfCycles: vi.fn(), perfCycle: vi.fn(), perfCycleShareAll: vi.fn(), perfCycleClose: vi.fn(), getPeopleDirectory: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }) }));

const { ReviewModal } = await import('./Reviews');
const ReviewCycles = (await import('./ReviewCycles')).default;

const CYCLE = { id: 'c1', name: '2026 Year-End Review', periodStart: '2026-05-01', periodEnd: '2026-10-29', selfDue: '2026-11-23',
  due: '2026-11-30', status: 'active' };
const BASE = {
  id: 'r1', cycle: CYCLE, employeeEmail: 'erin@x.com', employeeName: 'Erin Test', managerEmail: 'max@x.com', managerName: 'Max Test',
  stage: 'manager_review', selfSubmittedAt: '2026-11-20T10:00:00Z', selfAnswers: { well: { text: 'Shipped the new desk' } },
  goals: [{ id: 'g1', title: 'Close 40 tickets', status: 'on_track', statusLabel: 'On Track', progress: 80, currentValue: 32,
    targetValue: 40, measure: 'number', unit: '', measuredByNexus: false }],
  role: { employee: false, manager: true, hr: false, chain: false },
  can: { editSelf: false, editManager: true, waitForSelf: false, share: false, returnToManager: false, recall: false, remove: false,
    reassign: false, acknowledge: false, addGoal: true },
  managerAnswers: {}, goalScores: {}, rating: '', ratingLabel: '', promotionReady: false, privateNote: '',
};

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.getPeopleDirectory.mockResolvedValue([]);
  m.perfScorecard.mockResolvedValue({ period: { start: '2026-05-01', end: '2026-10-29' },
    metrics: [{ key: 'on_time', label: 'On-Time Arrival', display: '96%', available: true }] });
});

describe('the review form', () => {
  it('shows their numbers and goals beside it; the manager scores goals and picks a word', async () => {
    m.perfReview.mockResolvedValue(BASE);
    m.perfReviewManager.mockImplementation(async (id, body) => ({ ...BASE, ...body }));
    render(<ReviewModal reviewId="r1" />);
    expect(await screen.findByText('96%')).toBeTruthy();
    await waitFor(() => expect(m.perfScorecard).toHaveBeenCalledWith(expect.objectContaining({ email: 'erin@x.com', start: '2026-05-01', end: '2026-10-29' })));
    expect(screen.getByText('Close 40 tickets')).toBeTruthy();
    expect(screen.getByText('Shipped the new desk')).toBeTruthy();
    for (const word of ['Exceeds', 'Meets', 'Partly Meets', 'Below']) expect(screen.getByRole('tab', { name: word })).toBeTruthy();
    expect(screen.queryByText(/1 - Needs Improvement/)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit.disabled).toBe(true);                                   // the rating first
    fireEvent.click(screen.getByRole('tab', { name: 'Partly Met' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Meets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(m.perfReviewManager).toHaveBeenCalledWith('r1', expect.objectContaining({
      rating: 'meets', goal_scores: { g1: 'partly' }, submit: true })));
    expect(screen.getByText(/Private Note for HR/)).toBeTruthy();
  });

  it('the employee reads the shared review, adds comments and acknowledges', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, stage: 'shared', role: { employee: true, manager: false, hr: false, chain: false },
      can: { ...BASE.can, editManager: false, acknowledge: true }, managerAnswers: { well: { text: 'A solid year' } },
      managerSubmittedAt: '2026-11-25T10:00:00Z', rating: 'meets', ratingLabel: 'Meets', privateNote: undefined, promotionReady: undefined });
    m.perfReviewAcknowledge.mockResolvedValue({ signPartyId: 'p1' });
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    render(<ReviewModal reviewId="r1" />);
    expect(await screen.findByText('A solid year')).toBeTruthy();
    expect(screen.getByText('Meets')).toBeTruthy();
    expect(screen.queryByText(/Private Note/)).toBeNull();
    expect(screen.queryByText(/Ready for Promotion/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Your Comments/), { target: { value: 'Thanks' } });
    fireEvent.click(screen.getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(m.perfReviewAcknowledge).toHaveBeenCalledWith('r1', 'Thanks'));
    await waitFor(() => expect(nav).toHaveBeenCalled());
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'myhr', sub: 'sign:p1' });
    window.removeEventListener('nexus:navigate', nav);
  });

  it('Make This a Goal opens Add Goal for them with the answer, saving nothing', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, managerAnswers: { next: { text: 'Lead the Q1 launch' } } });
    m.perfMe.mockResolvedValue({ email: 'max@x.com', name: 'Max Test', reports: [{ email: 'erin@x.com', name: 'Erin Test' }],
      hasTeam: true, isHr: false, metrics: [], maxGoals: 5 });
    render(<ReviewModal reviewId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Make This a Goal/ }));
    const title = await screen.findByDisplayValue('Lead the Q1 launch');
    expect(title).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Goal' })).toBeTruthy();
    expect(m.perfGoalCreate).not.toHaveBeenCalled();
    expect(m.perfReviewManager).not.toHaveBeenCalled();
  });

  it('Make This a Goal is hidden from a reviewer who may not set them a goal', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, managerAnswers: { next: { text: 'Lead the Q1 launch' } }, can: { ...BASE.can, addGoal: false } });
    render(<ReviewModal reviewId="r1" />);
    expect(await screen.findByDisplayValue('Lead the Q1 launch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Make This a Goal/ })).toBeNull();
  });

  it('the manager waits for the self review until its due day', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, stage: 'self_review', selfSubmittedAt: '', selfAnswers: {},
      can: { ...BASE.can, editManager: false, waitForSelf: true }, managerAnswers: {}, rating: '' });
    render(<ReviewModal reviewId="r1" />);
    expect(await screen.findByText(/Not in yet/)).toBeTruthy();
    expect(screen.getByText(/11\/23\/2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});

describe('HR cycle table', () => {
  it('shares every ready review at once and asks before closing with reviews unfinished', async () => {
    m.perfCycles.mockResolvedValue([{ ...CYCLE, counts: { total: 3, complete: 1, ready: 2, overdue: 0 } }]);
    const dash = { ...CYCLE, counts: { total: 3, complete: 1, ready: 2, overdue: 0, ratings: { exceeds: 1, meets: 2, partly: 0, below: 0 } },
      reviews: [{ id: 'r1', employeeName: 'Erin Test', managerName: 'Max Test', stage: 'ready', ratingLabel: 'Meets', overdue: false }] };
    m.perfCycle.mockResolvedValue(dash);
    m.perfCycleShareAll.mockResolvedValue({ ...dash, shared: 2 });
    const closeErr = Object.assign(new Error('2 reviews are not finished. Close anyway?'), { status: 409 });
    m.perfCycleClose.mockImplementation((id, force) => (force ? Promise.resolve({ ...dash, status: 'closed' }) : Promise.reject(closeErr)));
    const ok = vi.fn();
    render(<ReviewCycles company="co" companies={[{ id: 'co', name: 'Co' }]} toastOk={ok} />);
    fireEvent.click(await screen.findByText('2026 Year-End Review'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Exceeds 1 - Meets 2 - Partly Meets 0 - Below 0')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Share All Ready \(2\)/ }));
    await waitFor(() => expect(m.perfCycleShareAll).toHaveBeenCalledWith('c1'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Cycle' }));
    expect(await within(dialog).findByText(/Close anyway\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Anyway' }));
    await waitFor(() => expect(m.perfCycleClose).toHaveBeenLastCalledWith('c1', true));
  });
});
