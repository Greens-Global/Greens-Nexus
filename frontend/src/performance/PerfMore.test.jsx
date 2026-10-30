import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Peer feedback, kudos, improvement plans and calibration (Oct 29 2026):
// each screen paints from what the server says the viewer may do, and
// sends the module's own calls.

const m = {
  perfFeedbackList: vi.fn(), perfFeedback: vi.fn(), perfFeedbackAnswer: vi.fn(), perfKudos: vi.fn(), perfKudosGive: vi.fn(),
  perfPlans: vi.fn(), perfPlan: vi.fn(), perfPlanAct: vi.fn(), perfCalibration: vi.fn(), perfCalibrate: vi.fn(),
  getPeopleDirectory: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));

const { FeedbackCard, FeedbackModal } = await import('./Feedback');
const { KudosCard } = await import('./Kudos');
const { PlanModal, PlanCard } = await import('./Plans');
const CalibrationModal = (await import('./Calibration')).default;

const CTX = { email: 'erin@greensglobal.com', name: 'Erin Test' };
const ASK = {
  id: 'f1', subjectEmail: 'erin@greensglobal.com', subjectName: 'Erin Test', giverEmail: 'pat@greensglobal.com', giverName: 'Pat Test',
  requestedBy: 'max@greensglobal.com', requestedByName: 'Max Test', private: true, note: 'The Q3 launch', status: 'requested',
  statusLabel: 'Waiting', answers: {}, requestedAt: '2026-10-20T10:00:00+00:00', can: { answer: true, decline: true, cancel: false },
};
const PLAN = {
  id: 'p1', employeeEmail: 'erin@greensglobal.com', employeeName: 'Erin Test', managerName: 'Max Test', title: 'Performance Improvement Plan',
  reason: 'Missed three closes', support: 'Weekly 1:1s', startOn: '2026-11-01', endOn: '2026-12-31', status: 'active', statusLabel: 'Active',
  expectations: [{ id: 'e1', text: 'Close on time', measure: 'By day 5', result: '' }], checkins: [], acknowledgedAt: '',
  role: { employee: true, manager: false, hr: false },
  can: { edit: false, sendToHr: false, start: false, drop: false, acknowledge: true, checkin: false, extend: false, close: false },
};

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.getPeopleDirectory.mockResolvedValue([]);
});

describe('Peer feedback', () => {
  it('lists what waits on me and opens it', async () => {
    m.perfFeedbackList.mockResolvedValue({ toAnswer: [{ ...ASK, giverEmail: CTX.email }], given: [], aboutMe: [] });
    render(<FeedbackCard ctx={CTX} />);
    expect(await screen.findByText('Max Test')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Waiting on You \(1\)/ })).toBeTruthy();
  });

  it('the giver answers and submits', async () => {
    m.perfFeedback.mockResolvedValue(ASK);
    m.perfFeedbackAnswer.mockResolvedValue({ ...ASK, status: 'submitted', statusLabel: 'Answered', can: { answer: false } });
    const done = vi.fn();
    render(<FeedbackModal id="f1" onClose={done} />);
    const box = await screen.findByRole('textbox', { name: /What do they do well/ });
    fireEvent.change(box, { target: { value: 'Owns the desk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(m.perfFeedbackAnswer).toHaveBeenCalledWith('f1', { answers: { well: 'Owns the desk' }, submit: true }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});

describe('Kudos', () => {
  it('shows the company feed', async () => {
    m.perfKudos.mockResolvedValue({ items: [{ id: 'k1', fromEmail: 'pat@x.com', fromName: 'Pat Test', toEmail: 'erin@x.com', toName: 'Erin Test',
      message: 'Saved the Friday close', createdAt: '2026-10-29T10:00:00+00:00', can: { hide: false } }], receivedLast90: 2 });
    render(<KudosCard ctx={CTX} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.getByText('2 for you in 90 days')).toBeTruthy();
    expect(m.perfKudos).toHaveBeenCalledWith({ scope: 'company' });
  });
});

describe('Improvement plans', () => {
  it('the employee never sees a card without a plan', async () => {
    m.perfPlans.mockResolvedValue([]);
    const { container } = render(<PlanCard self />);
    await waitFor(() => expect(m.perfPlans).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('the employee reads and acknowledges', async () => {
    m.perfPlan.mockResolvedValue(PLAN);
    m.perfPlanAct.mockResolvedValue({ ...PLAN, acknowledgedAt: '2026-11-02T10:00:00+00:00', can: { ...PLAN.can, acknowledge: false } });
    render(<PlanModal planId="p1" onClose={() => {}} />);
    expect(await screen.findByText('Close on time')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I Have Read It' }));
    await waitFor(() => expect(m.perfPlanAct).toHaveBeenCalledWith('p1', 'acknowledge', { comment: '' }));
  });
});

describe('Calibration', () => {
  it('lines up ratings and moves one with a reason', async () => {
    const person = { id: 'r1', employeeEmail: 'erin@x.com', employeeName: 'Erin Test', department: 'Ops', managerEmail: 'max@x.com',
      managerName: 'Max Test', rating: 'meets', ratingLabel: 'Meets', calibratedFrom: '', goals: { met: 2 }, canMove: true, stage: 'ready' };
    const board = { cycle: { name: 'Year-End' }, people: [person], stillWriting: 1, departments: ['Ops'], managers: [['max@x.com', 'Max Test']],
      ratings: [{ key: 'exceeds', label: 'Exceeds' }, { key: 'meets', label: 'Meets' }, { key: 'partly', label: 'Partly Meets' }, { key: 'below', label: 'Below' }] };
    m.perfCalibration.mockResolvedValue(board);
    m.perfCalibrate.mockResolvedValue({ ...board, people: [{ ...person, rating: 'exceeds', calibratedFrom: 'meets', calibratedFromLabel: 'Meets' }] });
    render(<CalibrationModal cycleId="c1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Erin Test' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Exceeds' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Led the launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(m.perfCalibrate).toHaveBeenCalledWith('r1', 'exceeds', 'Led the launch'));
    expect(await screen.findByText(/Manager said Meets/)).toBeTruthy();
  });
});
