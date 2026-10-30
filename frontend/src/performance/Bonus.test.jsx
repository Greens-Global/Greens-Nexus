// Bonus plans (Settings) and bonus runs (HR + the manager's review card),
// Oct 30 2026: the payout preview follows the curve, Save sends numbers per
// role; a run lists lines with money for HR and locks after approval; the
// manager's card has no money and bounds the adjustment.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { perfBonusPlans: vi.fn(), perfBonusPlanSave: vi.fn(), perfBonusRuns: vi.fn(), perfBonusRun: vi.fn(), perfBonusLineAdjust: vi.fn(),
  perfBonusRunApprove: vi.fn(), perfBonusReview: vi.fn(), perfBonusRunStart: vi.fn(), perfBonusReadiness: vi.fn(), perfBonusRunUpdate: vi.fn(), perfBonusRunReviewed: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../lib/groupDirty', () => ({ useGroupDirty: () => {} }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));

import { BonusPlanSettings, payoutAt } from './BonusPlans';
import { BonusRunsAdmin, BonusReviewCard, endedPeriods } from './BonusRuns';

const PLAN = { id: 'p1', roleId: 'r1', targetPct: 10, period: 'monthly', thresholdScore: 60, payoutAtThreshold: 50, maxPayout: 100, adjustMax: 20, active: true };
const LINE = { id: 'l1', email: 'erin@x.com', name: 'Erin T', roleName: 'Analyst', managerName: 'Max T', score: 80, payoutPct: 75, adjustPct: 0, adjustMax: 20,
  adjustReason: '', excluded: false, note: '', measuredWeight: 100, basePay: 5000, currency: 'USD', computedAmount: 375, finalAmount: 375 };
const RUN = { id: 'run1', period: '2026-10', label: 'October 2026', status: 'review', lineCount: 1, createdAt: '2026-11-02T00:00:00Z', approvedAt: '', paidAt: '',
  lines: [LINE], total: 375, budget: null, overBudget: false, reviewed: 0, managersPending: [{ email: 'max@x.com', name: 'Max T' }], fairness: { byManager: [{ key: 'max@x.com', name: 'Max T', people: 1, avgScore: 80, avgPayout: 75, avgAdjust: 0, spread: null, flags: [] }], byDepartment: [] } };

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.perfBonusPlans.mockResolvedValue({ company: 'co', adjustMaxDefault: 20, roles: [
    { id: 'r1', name: 'Analyst', department: 'Accounting', members: 3, hasScorecard: true, plan: PLAN },
    { id: 'r2', name: 'Crew Member', department: 'Construction', members: 5, hasScorecard: false, plan: null },
  ] });
  calls.perfBonusPlanSave.mockResolvedValue(PLAN);
  calls.perfBonusRuns.mockResolvedValue([RUN]);
  calls.perfBonusRun.mockResolvedValue(RUN);
  calls.perfBonusRunApprove.mockResolvedValue({ ...RUN, status: 'approved' });
  calls.perfBonusLineAdjust.mockResolvedValue({ ...LINE, adjustPct: 10 });
  calls.perfBonusReadiness.mockResolvedValue({ period: '2026-09', people: 3, missing: [{ email: 'erin@x.com', name: 'Erin T', kpiName: 'Judgment', managerName: 'Max T', month: '2026-09' }] });
  calls.perfBonusRunUpdate.mockResolvedValue({ ...RUN, budget: 300, overBudget: true });
  calls.perfBonusRunReviewed.mockResolvedValue({ reviewed: 1 });
});

describe('payout curve', () => {
  it('matches perf_bonus.payout_pct', () => {
    expect(payoutAt(PLAN, 59)).toBe(0);
    expect(payoutAt(PLAN, 60)).toBe(50);
    expect(payoutAt(PLAN, 80)).toBe(75);
    expect(payoutAt(PLAN, 100, 100)).toBe(100);
    expect(payoutAt({ ...PLAN, maxPayout: 150 }, 100, 50)).toBe(125);
  });
  it('offers only ended periods', () => {
    const p = endedPeriods(new Date(2026, 10, 5));            // November 5 2026
    expect(p[0]).toEqual({ key: '2026-10', label: 'October 2026' });
    expect(p.find((x) => x.key === '2026-11')).toBeUndefined();
    expect(p.find((x) => x.key === '2026-Q3')).toBeTruthy();
    expect(p.find((x) => x.key === '2026-Q4')).toBeUndefined();
  });
});

describe('BonusPlanSettings', () => {
  it('shows each role with its plan and a preview, and saves a new plan with numbers', async () => {
    render(<BonusPlanSettings company="co" />);
    const crew = (await screen.findByText('Crew Member')).closest('[data-bonus-plan]').parentElement;
    expect(within(crew).getByText(/No bonus plan/)).toBeTruthy();
    expect(within(crew).getByText(/Score 60 pays 50% of target, 80 pays 75%, 100 pays 100%/)).toBeTruthy();
    fireEvent.change(within(crew).getByLabelText('Target Bonus'), { target: { value: '8' } });
    fireEvent.change(within(crew).getByLabelText('Crew Member bonus period'), { target: { value: 'quarterly' } });
    fireEvent.click(within(crew).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.perfBonusPlanSave).toHaveBeenCalledWith(expect.objectContaining({ company: 'co', roleId: 'r2', targetPct: 8, period: 'quarterly', thresholdScore: 60, active: true })));
    const analyst = screen.getByText('Analyst').closest('[data-bonus-plan]').parentElement;
    expect(within(analyst).getByText(/10% of base pay, paid monthly/)).toBeTruthy();
    fireEvent.change(within(analyst).getByLabelText('From the Review'), { target: { value: '30' } });
    expect(within(analyst).getByText(/70% KPIs and 30% the latest review rating/)).toBeTruthy();
    fireEvent.click(within(analyst).getByRole('switch'));
    await waitFor(() => expect(calls.perfBonusPlanSave).toHaveBeenLastCalledWith(expect.objectContaining({ roleId: 'r1', active: false })));
  });
});

describe('BonusRunsAdmin', () => {
  it('opens a run with money, adjusts a line with a reason, approves', async () => {
    render(<BonusRunsAdmin company="co" />);
    fireEvent.change(await screen.findByLabelText('Period to run'), { target: { value: '2026-09' } });
    await waitFor(() => expect(calls.perfBonusReadiness).toHaveBeenCalledWith('co', '2026-09'));
    expect((await screen.findByText(/1 manual KPI rating is still missing/)).closest('[data-readiness]').textContent).toContain('Erin T (Judgment, Max T)');
    fireEvent.click(screen.getByRole('row', { name: /October 2026/ }));
    expect(await screen.findByText('$5,000.00')).toBeTruthy();
    expect(document.querySelector('[data-total]').textContent).toBe('$375.00');     // the header total; the line shows it again
    expect(screen.getByRole('table', { name: 'By Manager' })).toBeTruthy();
    expect(document.querySelector('[data-reviewed]').textContent).toContain('0 of 1');
    expect(document.querySelector('[data-reviewed]').textContent).toContain('waiting on Max T');
    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(calls.perfBonusRunUpdate).toHaveBeenCalledWith('run1', { budget: 300 }));
    expect(await screen.findByText('125% of budget')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
    const save = screen.getByRole('button', { name: 'Save Adjustment' });
    fireEvent.change(screen.getByLabelText('Adjustment'), { target: { value: '10' } });
    expect(save.disabled).toBe(true);                        // reason required
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Covered two desks in October.' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.perfBonusLineAdjust).toHaveBeenCalledWith('l1', { adjustPct: 10, reason: 'Covered two desks in October.', excluded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.perfBonusRunApprove).toHaveBeenCalledWith('run1'));
  });
});

describe('BonusReviewCard', () => {
  it('shows nothing without a run in review, and no money with one', async () => {
    calls.perfBonusReview.mockResolvedValue([]);
    const { unmount, container } = render(<BonusReviewCard />);
    await waitFor(() => expect(calls.perfBonusReview).toHaveBeenCalled());
    expect(container.querySelector('[data-bonus-review]')).toBeNull();
    unmount();
    const { basePay, computedAmount, finalAmount, ...noMoney } = LINE;
    void basePay; void computedAmount; void finalAmount;
    calls.perfBonusReview.mockResolvedValue([{ ...RUN, lines: [noMoney], total: undefined, fairness: undefined }]);
    render(<BonusReviewCard />);
    expect(await screen.findByText('Erin T')).toBeTruthy();
    expect(screen.queryByText('$375.00')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
    fireEvent.change(screen.getByLabelText('Adjustment'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Great month.' } });
    expect(screen.getByRole('button', { name: 'Save Adjustment' }).disabled).toBe(true);   // over the ±20 bound
    fireEvent.change(screen.getByLabelText('Adjustment'), { target: { value: '15' } });
    expect(screen.getByRole('button', { name: 'Save Adjustment' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Looks Right' }));
    await waitFor(() => expect(calls.perfBonusRunReviewed).toHaveBeenCalledWith('run1'));
  });
});
