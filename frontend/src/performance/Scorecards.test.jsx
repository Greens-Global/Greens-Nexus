// Settings > Performance > KPI Scorecards (Oct 30 2026): the weights must total
// 100 before Save, manual KPIs are capped, a suggestion fills an empty card,
// and Save sends the rows with numbers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { perfScorecards: vi.fn(), perfScorecardSave: vi.fn(), perfKpiCreate: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../lib/groupDirty', () => ({ useGroupDirty: () => {} }));

import { ScorecardSettings } from './Scorecards';

const KPIS = [
  { key: 'tasks_on_time', name: 'Tasks On Time', unit: '%', direction: 'high', source: 'nexus', active: true },
  { key: 'training', name: 'Required Training Done', unit: '%', direction: 'high', source: 'nexus', active: true },
  { key: 'manual:judgment', name: 'Judgment', unit: 'rating', direction: 'high', source: 'manual', active: true },
];
const DATA = {
  company: 'co', canEdit: true, manualMax: 30, nextMonth: '2026-11-01', kpis: KPIS,
  departments: [
    { name: 'Accounting', head: '', backup: '', current: { id: 'v1', version: 1, effectiveFrom: '2026-10-01', effectiveTo: '', notes: '', items: [
      { kpi: 'tasks_on_time', weight: 70, target: 95, threshold: 70, cap: 100, name: 'Tasks On Time', unit: '%', direction: 'high', source: 'nexus' },
      { kpi: 'training', weight: 30, target: 100, threshold: 80, cap: 100, name: 'Required Training Done', unit: '%', direction: 'high', source: 'nexus' }] }, upcoming: null, versions: 1,
      suggestion: [{ kpi: 'tasks_on_time', weight: 60, target: 95, threshold: 70, cap: 100 }, { kpi: 'training', weight: 40, target: 100, threshold: 80, cap: 100 }] },
    { name: 'Ops', head: '', backup: '', current: null, upcoming: null, versions: 0, unlisted: true,
      suggestion: [{ kpi: 'tasks_on_time', weight: 60, target: 95, threshold: 70, cap: 100 }, { kpi: 'training', weight: 40, target: 100, threshold: 80, cap: 100 }] },
  ],
};

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.perfScorecards.mockResolvedValue(DATA);
  calls.perfScorecardSave.mockResolvedValue({ version: 2, effectiveFrom: '2026-11-01' });
});

describe('KPI Scorecards', () => {
  it('shows each department, blocks Save until the weights total 100, caps manual KPIs, and sends numbers', async () => {
    const toastOk = vi.fn();
    render(<ScorecardSettings company="co" toastOk={toastOk} toastErr={vi.fn()} />);
    const acct = within((await screen.findByText('Accounting')).closest('[data-scorecard]').parentElement);
    expect(acct.getByText(/in force since 10\/01\/2026/)).toBeTruthy();
    expect(acct.getByText('Weights: 100%')).toBeTruthy();
    expect(acct.getByText(/starts a new version from 11\/01\/2026/)).toBeTruthy();     // the Save row's note, before any edit
    // Change a weight: the total is wrong, Save is disabled.
    fireEvent.change(acct.getByLabelText('Tasks On Time weight'), { target: { value: '80' } });
    expect(acct.getByText('Weights: 110%')).toBeTruthy();
    expect(acct.getByText(/not 100%/)).toBeTruthy();
    const save = acct.getByRole('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    // Add the manual KPI with too much weight.
    fireEvent.change(acct.getByLabelText('Add a KPI to Accounting'), { target: { value: 'manual:judgment' } });
    fireEvent.change(acct.getByLabelText('Judgment weight'), { target: { value: '40' } });
    fireEvent.change(acct.getByLabelText('Tasks On Time weight'), { target: { value: '40' } });
    fireEvent.change(acct.getByLabelText('Required Training Done weight'), { target: { value: '20' } });
    expect(acct.getByText('Weights: 100%')).toBeTruthy();
    expect(acct.getByText(/Manual KPIs carry 40%/)).toBeTruthy();
    expect(acct.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.change(acct.getByLabelText('Judgment weight'), { target: { value: '30' } });
    fireEvent.change(acct.getByLabelText('Tasks On Time weight'), { target: { value: '50' } });
    expect(acct.getByRole('button', { name: 'Save' }).disabled).toBe(false);
    expect(acct.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(acct.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.perfScorecardSave).toHaveBeenCalled());
    const body = calls.perfScorecardSave.mock.calls[0][0];
    expect(body.department).toBe('Accounting');
    expect(body.items.map((r) => [r.kpi, r.weight])).toEqual([['tasks_on_time', 50], ['training', 20], ['manual:judgment', 30]]);
    expect(typeof body.items[0].target).toBe('number');
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/version 2 applies from 11\/01\/2026/)));
  });

  it('an empty department starts from the suggestion', async () => {
    render(<ScorecardSettings company="co" toastOk={vi.fn()} toastErr={vi.fn()} />);
    const ops = within((await screen.findByText('Ops')).closest('[data-scorecard]').parentElement);
    expect(ops.getByText(/not scored/)).toBeTruthy();
    fireEvent.click(ops.getByRole('button', { name: /Start From a Suggestion/ }));
    expect(ops.getByText('Weights: 100%')).toBeTruthy();
    expect(ops.getByText('Unsaved changes')).toBeTruthy();
    expect(ops.getByRole('button', { name: 'Save' }).disabled).toBe(false);
  });

  it('read-only for someone who is not HR', async () => {
    calls.perfScorecards.mockResolvedValue({ ...DATA, canEdit: false });
    render(<ScorecardSettings company="co" toastOk={vi.fn()} toastErr={vi.fn()} />);
    await screen.findByText('Accounting');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Add a KPI to Accounting')).toBeNull();
    expect(screen.getByLabelText('Tasks On Time weight').disabled).toBe(true);
  });
});
