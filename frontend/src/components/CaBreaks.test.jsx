import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// CA meal and rest breaks (Neil, Oct 17 2026) and the California Review
// (Oct 18): the signing question (Yes signs, No sends it back with the days),
// the premium lines panel, the waiver card, and HR's review queue. Each
// renders nothing for anyone not on the California overtime rule.

const apiMock = vi.hoisted(() => ({
  timesheetBreakAttest: vi.fn(), timesheetBreakClaim: vi.fn(), breakPremiumAdd: vi.fn(), breakPremiumRemove: vi.fn(),
  mealWaiver: vi.fn(), mealWaiverSend: vi.fn(), mealWaiverRevoke: vi.fn(),
  caReview: vi.fn(), caReviewResolve: vi.fn(), caReviewReopen: vi.fn(), caReviewSaveSettings: vi.fn(),
}));
const promptMock = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => promptMock(...a), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ onVerified }) => <button type="button" onClick={onVerified}>Verify to view</button>,
}));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

import BreakAttestModal from './BreakAttestModal';
import { needsBreakAnswer } from '../lib/breakAttest';
import BreakPremiums from './BreakPremiums';
import MealWaiverCard from './MealWaiverCard';
import CaReview from './CaReview';

const ATT = { required: true, answered: false, question: 'In this pay period I was provided every meal and rest break California law requires.',
  flaggedDays: [{ date: '2026-09-16', chip: 'Meal Missed', label: 'No 30-minute meal break in a day over 5 hours' }],
  workedDays: ['2026-09-16', '2026-09-17'] };

beforeEach(() => {
  Object.values(apiMock).forEach(f => f.mockReset());
  promptMock.mockReset();
});

describe('BreakAttestModal', () => {
  it('asks only when the review needs it', () => {
    expect(needsBreakAnswer({ breakAttestation: ATT })).toBe(true);
    expect(needsBreakAnswer({ breakAttestation: { ...ATT, answered: true } })).toBe(false);
    expect(needsBreakAnswer({})).toBe(false);
    expect(needsBreakAnswer(null)).toBe(false);
  });

  it('Yes records the answer, then signing goes on', async () => {
    apiMock.timesheetBreakAttest.mockResolvedValue({});
    const onYes = vi.fn();
    render(<BreakAttestModal reviewId="r1" attestation={ATT} onYes={onYes} onClose={() => {}} />);
    expect(screen.getByText(ATT.question)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Continue to Sign' }));
    await waitFor(() => expect(onYes).toHaveBeenCalled());
    expect(apiMock.timesheetBreakAttest).toHaveBeenCalledWith('r1');
  });

  it('No pre-fills the flagged days and sends the claim back', async () => {
    apiMock.timesheetBreakClaim.mockResolvedValue({});
    const onSentBack = vi.fn();
    render(<BreakAttestModal reviewId="r1" attestation={ATT} onSentBack={onSentBack} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByLabelText('Meal 09/16/2026').checked).toBe(true);
    expect(screen.getByLabelText('Rest 09/16/2026').checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Rest 09/17/2026'));
    fireEvent.change(screen.getByPlaceholderText('Anything your manager should know'), { target: { value: 'Busy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Back to Manager' }));
    await waitFor(() => expect(onSentBack).toHaveBeenCalled());
    expect(apiMock.timesheetBreakClaim).toHaveBeenCalledWith('r1', {
      claims: [{ date: '2026-09-16', kind: 'meal' }, { date: '2026-09-17', kind: 'rest' }], note: 'Busy' });
  });
});

describe('BreakPremiums', () => {
  const card = { email: 'e@x.com', overtimeRule: 'ca', caBreaks: true, days: [{ date: '2026-09-16', workedMin: 480 }],
    breakPremiums: [{ id: 'p1', date: '2026-09-16', kind: 'meal', label: 'Meal Premium', status: 'active', source: 'claim', note: '' }] };

  it('renders nothing off the CA rule or on the employee\'s own card', () => {
    const { container, rerender } = render(<BreakPremiums card={{ ...card, caBreaks: undefined }} />);
    expect(container.innerHTML).toBe('');
    rerender(<BreakPremiums card={card} self />);
    expect(container.innerHTML).toBe('');
  });

  it('removes with a reason and adds a line', async () => {
    promptMock.mockResolvedValue('Took the break');
    apiMock.breakPremiumRemove.mockResolvedValue({});
    apiMock.breakPremiumAdd.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<BreakPremiums card={card} onChanged={onChanged} />);
    expect(screen.getByText('From the employee at signing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Meal Premium 09/16/2026' }));
    await waitFor(() => expect(apiMock.breakPremiumRemove).toHaveBeenCalledWith('p1', 'Took the break'));
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-09-16' } });
    fireEvent.change(screen.getByLabelText('Premium'), { target: { value: 'rest' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Premium/ }));
    await waitFor(() => expect(apiMock.breakPremiumAdd).toHaveBeenCalledWith({ email: 'e@x.com', date: '2026-09-16', kind: 'rest', note: '' }));
  });
});

describe('MealWaiverCard', () => {
  it('shows nothing for non-CA staff', async () => {
    apiMock.mealWaiver.mockResolvedValue({ ca: false });
    const { container } = render(<MealWaiverCard email="e@x.com" />);
    await waitFor(() => expect(apiMock.mealWaiver).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('HR sends it', async () => {
    apiMock.mealWaiver.mockResolvedValue({ ca: true, status: 'none', canManage: true, firstMeal: 'A', secondMeal: 'B' });
    apiMock.mealWaiverSend.mockResolvedValue({ ca: true, status: 'sent', sentAt: '2026-10-17T10:00:00', canManage: true, firstMeal: 'A', secondMeal: 'B' });
    render(<MealWaiverCard email="e@x.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send Waiver to Sign' }));
    expect(await screen.findByText('Out for Signature')).toBeTruthy();
  });
});

describe('CaReview', () => {
  const REPORT = { period: { start: '2026-09-13', end: '2026-09-26' }, people: 1, openCount: 1, settings: { minWage: 16.9 },
    generatedAt: '2026-10-18T10:00:00+00:00',
    rows: [{ email: 'e@x.com', name: 'Erin Test', periodStart: '2026-09-13', date: '2026-09-16', key: 'meal:2026-09-16',
      rule: 'meal', ruleLabel: 'Meal Break', reason: 'Meal Missed: No 30-minute meal break', status: 'open' }] };

  it('runs, opens the time sheet and resolves with a note', async () => {
    apiMock.caReview.mockResolvedValue(REPORT);
    apiMock.caReviewResolve.mockResolvedValue({});
    promptMock.mockResolvedValue('Paid the premium');
    const onOpen = vi.fn();
    render(<CaReview onOpenTimecard={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Review/ }));
    expect(await screen.findByText('Erin Test')).toBeTruthy();
    expect(screen.getByText('1 Open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Time Sheet/ }));
    expect(onOpen).toHaveBeenCalledWith('e@x.com', '2026-09-13', 'hourly');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(apiMock.caReviewResolve).toHaveBeenCalledWith(
      { email: 'e@x.com', periodStart: '2026-09-13', key: 'meal:2026-09-16', note: 'Paid the premium' }));
  });

  it('asks for step-up instead of rendering blank', async () => {
    apiMock.caReview.mockRejectedValue({ status: 403 });
    render(<CaReview />);
    fireEvent.click(screen.getByRole('button', { name: /Run Review/ }));
    expect(await screen.findByRole('button', { name: 'Verify to view' })).toBeTruthy();
  });
});
