// My Score (Oct 30 2026): the total and a row per KPI with its attainment,
// the unmeasured note, Rate for a manual KPI only when the viewer may rate
// (reason required), and the plain messages when there is no role / scorecard.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { perfScore: vi.fn(), perfRateKpi: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));

import ScoreCard from './Score';

const SCORE = {
  email: 'erin@x.com', name: 'Erin T', period: '2026-10', role: { id: 'r1', name: 'Analyst' }, scorecard: { id: 'v1', version: 1 },
  status: 'scored', score: 64.3, measuredWeight: 70,
  items: [
    { kpi: 'tasks_on_time', name: 'Tasks On Time', source: 'nexus', unit: '%', weight: 50, target: 90, threshold: 60, cap: 100, value: 75, display: '75%', measured: true, attainment: 50, status: 'partly', rating: null },
    { kpi: 'no_shows', name: 'No-Shows', source: 'nexus', unit: 'count', weight: 20, target: 0, threshold: 3, cap: 0, value: 0, display: '0', measured: true, attainment: 100, status: 'met', rating: null },
    { kpi: 'manual:judgment', name: 'Judgment', source: 'manual', unit: 'rating', weight: 30, target: 4, threshold: 2, cap: 5, value: null, display: '', measured: false, attainment: null, status: 'unmeasured', rating: null },
  ],
};

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.perfScore.mockResolvedValue(SCORE);
});

describe('ScoreCard', () => {
  it('shows the total, a row per KPI and how much weight was measured', async () => {
    render(<ScoreCard />);
    expect(await screen.findByText('64.3')).toBeTruthy();
    expect(screen.getByText(/70% of the weight measured so far/)).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('50% of target')).toBeTruthy();
    expect(within(document.querySelector('[data-kpi="manual:judgment"]')).getByText('Awaiting a rating')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rate/ })).toBeNull();          // own page: nobody rates themselves
    expect(calls.perfScore).toHaveBeenCalledWith('', expect.stringMatching(/^\d{4}-\d{2}$/));
  });

  it('lets a manager rate a manual KPI with a reason', async () => {
    calls.perfRateKpi.mockResolvedValue({ ...SCORE, score: 75, measuredWeight: 100 });
    render(<ScoreCard email="erin@x.com" title="Erin's Score" canRate />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rate' }));
    const save = screen.getByRole('button', { name: 'Save Rating' });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '5' }));
    expect(save.disabled).toBe(true);                                             // still needs the reason
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Caught the duplicate invoice.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.perfRateKpi).toHaveBeenCalledWith({ person: 'erin@x.com', kpi: 'manual:judgment', month: expect.any(String), value: 5, reason: 'Caught the duplicate invoice.' }));
    expect(await screen.findByText('75')).toBeTruthy();
  });

  it('says so when there is no role or no scorecard, and steps months', async () => {
    calls.perfScore.mockResolvedValueOnce({ status: 'no_role', items: [] });
    const { unmount } = render(<ScoreCard />);
    expect(await screen.findByText(/No job role in People yet/)).toBeTruthy();
    unmount();
    calls.perfScore.mockResolvedValue({ status: 'no_scorecard', role: { name: 'Clerk' }, items: [] });
    render(<ScoreCard />);
    expect(await screen.findByText(/No KPI scorecard for the Clerk role/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next month' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(calls.perfScore).toHaveBeenCalledTimes(3));                 // no_role mount, no_scorecard mount, previous month
    expect(calls.perfScore.mock.calls[2][1] < calls.perfScore.mock.calls[1][1]).toBe(true);
  });
});
