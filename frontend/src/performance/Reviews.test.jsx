import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for performance reviews (Oct 27 2026): the review as the
// employee sees it once shared (Read and Sign, no private note), as the
// manager writes it (the private note box is there), and HR's cycle list and
// dashboard (stage counts, Nudge Overdue).

const m = { perfReview: vi.fn(), perfCycles: vi.fn(), perfCycle: vi.fn(), perfCycleNudge: vi.fn(), getPeopleDirectory: vi.fn(), perfReviewDepartments: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }) }));

const { ReviewModal } = await import('./Reviews');
const ReviewCycles = (await import('./ReviewCycles')).default;

const CYCLE = {
  id: 'c1', name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31', selfDue: '2026-11-15', managerDue: '2026-11-30',
  questions: [{ id: 'q1', kind: 'rating', text: 'Overall, how did this period go?' }, { id: 'q2', kind: 'text', text: 'What went well?' }],
  ratingScale: [1, 2, 3, 4, 5].map(v => ({ value: v, label: `Label ${v}` })), values: [{ id: 'own-it', name: 'Own It' }],
  includeGoals: true, status: 'active', filters: {},
};
const BASE = {
  id: 'r1', cycle: CYCLE, employeeEmail: 'erin@x.com', employeeName: 'Erin Test', managerEmail: 'max@x.com', managerName: 'Max Test',
  selfAnswers: { q1: { rating: 4, text: '' }, q2: { text: 'Shipped the desk' } }, selfValues: { 'own-it': 4 }, selfSubmittedAt: '2026-11-10T10:00:00Z',
  can: { editSelf: false, editManager: false, finalize: false, recall: false, reassign: false, startPromotion: false },
};

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.getPeopleDirectory.mockResolvedValue([]);
  m.perfReviewDepartments.mockResolvedValue([]);
});

describe('ReviewModal', () => {
  it('shows the shared review to the employee with Read and Sign and no private note', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, stage: 'shared', role: { employee: true }, signPartyId: 'p1',
      managerAnswers: { q1: { rating: 3, text: 'Solid year' } }, managerValues: {}, overallRating: 3, managerSummary: 'A solid year.', goals: [], hrNote: '' });
    render(<ReviewModal reviewId="r1" onClose={() => {}} />);
    expect(await screen.findByText('Read and Sign')).toBeTruthy();
    expect(screen.getByText('A solid year.')).toBeTruthy();
    expect(screen.getByText('Shipped the desk')).toBeTruthy();
    expect(screen.queryByText(/Private Note/)).toBeNull();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByText('Read and Sign'));
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'myhr', sub: 'sign:p1' });
    window.removeEventListener('nexus:navigate', nav);
  });

  it('gives the manager the form with the private note box', async () => {
    m.perfReview.mockResolvedValue({ ...BASE, stage: 'manager_review', role: { manager: true }, managerAnswers: {}, managerValues: {},
      overallRating: null, managerSummary: '', goals: [], hrNote: '', privateNote: '', history: [],
      can: { ...BASE.can, editManager: true } });
    render(<ReviewModal reviewId="r1" onClose={() => {}} />);
    expect(await screen.findByText('Submit to HR')).toBeTruthy();
    expect(screen.getByText(/Private Note for HR/)).toBeTruthy();
    expect(screen.getByText('Attach Their Goal Progress')).toBeTruthy();
  });
});

describe('ReviewCycles', () => {
  it('lists cycles and opens the dashboard with a nudge', async () => {
    m.perfCycles.mockResolvedValue([{ ...CYCLE, counts: { total: 4, complete: 1, overdue: 2 } }]);
    m.perfCycle.mockResolvedValue({ ...CYCLE, counts: { self_review: 2, manager_review: 1, hr_review: 0, shared: 0, complete: 1, total: 4, overdue: 2 },
      reviews: [{ id: 'r1', employeeName: 'Erin Test', managerName: 'Max Test', stage: 'self_review', overdue: true, nudgedAt: '' }] });
    m.perfCycleNudge.mockResolvedValue({ nudged: 2 });
    render(<ReviewCycles company="co" toastOk={() => {}} />);
    fireEvent.click(await screen.findByText('2026 Annual'));
    expect(await screen.findByText('Erin Test')).toBeTruthy();
    expect(screen.getByText('1 of 4 complete · 2 overdue')).toBeTruthy();
    fireEvent.click(screen.getByText('Nudge Overdue'));
    await waitFor(() => expect(m.perfCycleNudge).toHaveBeenCalledWith('c1', { overdue_only: true }));
  });

  it('says what to do with no cycles', async () => {
    m.perfCycles.mockResolvedValue([]);
    render(<ReviewCycles company="co" />);
    expect(await screen.findByText(/No review cycles yet/)).toBeTruthy();
  });
});
