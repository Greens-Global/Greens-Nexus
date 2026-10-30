// Settings > Performance > KPI Scorecards (Oct 30 2026): a card per role, Save
// blocked until the weights total 100 and manual KPIs stay within the cap,
// Copy From fills a role from a shared set, a suggestion fills an empty role,
// shared sets are kept below, read-only for non-HR.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { perfScorecards: vi.fn(), perfScorecardSave: vi.fn(), perfScorecardCopySource: vi.fn(), perfSharedScorecardSave: vi.fn(), perfKpiCreate: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../lib/groupDirty', () => ({ useGroupDirty: () => {} }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));

import { ScorecardSettings } from './Scorecards';

const KPIS = [
  { key: 'tasks_on_time', name: 'Tasks On Time', unit: '%', direction: 'high', source: 'nexus', active: true },
  { key: 'training', name: 'Required Training Done', unit: '%', direction: 'high', source: 'nexus', active: true },
  { key: 'manual:judgment', name: 'Judgment', unit: 'rating', direction: 'high', source: 'manual', active: true },
];
const ROWS = [
  { kpi: 'tasks_on_time', weight: 70, target: 95, threshold: 70, cap: 100 },
  { kpi: 'training', weight: 30, target: 100, threshold: 80, cap: 100 },
];
const DATA = {
  company: 'co', canEdit: true, canEditEveryCompany: false, manualMax: 30, nextMonth: '2026-11-01', kpis: KPIS,
  roles: [
    { id: 'r1', name: 'Analyst', department: 'Accounting', members: 3, companyId: 'co', versions: 1, suggestion: ROWS,
      current: { id: 'v1', version: 1, effectiveFrom: '2026-10-01', effectiveTo: '', notes: '', copiedFrom: '', items: ROWS }, upcoming: null },
    { id: 'r2', name: 'Crew Member', department: 'Construction', members: 0, companyId: 'co', versions: 0, suggestion: ROWS, current: null, upcoming: null },
  ],
  shared: [{ id: 's1', kind: 'shared', name: 'Office Staff', companyId: 'co', notes: '', items: ROWS }],
};
const card = async (name) => within((await screen.findByText(name, { selector: 'div' })).closest('[data-scorecard]').parentElement);

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.perfScorecards.mockResolvedValue(DATA);
  calls.perfScorecardSave.mockResolvedValue({ version: 2, effectiveFrom: '2026-11-01' });
  calls.perfScorecardCopySource.mockResolvedValue({ items: ROWS, copiedFrom: 'Shared set: Office Staff' });
  calls.perfSharedScorecardSave.mockResolvedValue({ id: 's2' });
});

describe('KPI Scorecards per role', () => {
  it('a role card: weights must total 100, manual KPIs are capped, Save sends numbers and the role', async () => {
    const toastOk = vi.fn();
    render(<ScorecardSettings company="co" toastOk={toastOk} toastErr={vi.fn()} />);
    const acct = await card('Analyst');
    expect(acct.getByText(/in force since 10\/01\/2026/)).toBeTruthy();
    expect(acct.getByText(/3 people/)).toBeTruthy();
    expect(acct.getByText('Weights: 100%')).toBeTruthy();
    fireEvent.change(acct.getByLabelText('Tasks On Time weight (Analyst)'), { target: { value: '80' } });
    expect(acct.getByText('Weights: 110%')).toBeTruthy();
    expect(acct.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.change(acct.getByLabelText('Add a KPI to Analyst'), { target: { value: 'manual:judgment' } });
    fireEvent.change(acct.getByLabelText('Judgment weight (Analyst)'), { target: { value: '40' } });
    fireEvent.change(acct.getByLabelText('Tasks On Time weight (Analyst)'), { target: { value: '40' } });
    fireEvent.change(acct.getByLabelText('Required Training Done weight (Analyst)'), { target: { value: '20' } });
    expect(acct.getByText(/Manual KPIs carry 40%/)).toBeTruthy();
    expect(acct.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.change(acct.getByLabelText('Judgment weight (Analyst)'), { target: { value: '30' } });
    fireEvent.change(acct.getByLabelText('Tasks On Time weight (Analyst)'), { target: { value: '50' } });
    expect(acct.getByRole('button', { name: 'Save' }).disabled).toBe(false);
    fireEvent.click(acct.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.perfScorecardSave).toHaveBeenCalled());
    const body = calls.perfScorecardSave.mock.calls[0][0];
    expect(body.roleId).toBe('r1');
    expect(body.items.map((r) => [r.kpi, r.weight])).toEqual([['tasks_on_time', 50], ['training', 20], ['manual:judgment', 30]]);
    expect(typeof body.items[0].target).toBe('number');
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/Analyst: version 2 applies from 11\/01\/2026/)));
  });

  it('an empty role copies from a shared set, or starts from the suggestion', async () => {
    render(<ScorecardSettings company="co" toastOk={vi.fn()} toastErr={vi.fn()} />);
    const crew = await card('Crew Member');
    expect(crew.getByText(/not scored/)).toBeTruthy();
    fireEvent.change(crew.getByLabelText('Copy a scorecard into Crew Member'), { target: { value: 's1' } });
    await waitFor(() => expect(calls.perfScorecardCopySource).toHaveBeenCalledWith('co', 's1'));
    await waitFor(() => expect(crew.getByText('Weights: 100%')).toBeTruthy());
    fireEvent.click(crew.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.perfScorecardSave).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'r2', copiedFrom: 'Shared set: Office Staff' })));
    // The Analyst role is also offered as a source, the Crew itself is not.
    const options = [...crew.getByLabelText('Copy a scorecard into Crew Member').options].map((o) => o.textContent);
    expect(options).toEqual(['Copy From…', 'Shared set: Office Staff', 'Role: Analyst']);
  });

  it('shared sets are listed, a new one saves with its name, and non-HR is read-only', async () => {
    render(<ScorecardSettings company="co" toastOk={vi.fn()} toastErr={vi.fn()} />);
    await screen.findByText('Shared Sets');
    expect(screen.getByDisplayValue('Office Staff')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Shared Set/ }));
    const fresh = within(document.querySelector('[data-shared="new"]').parentElement);
    fireEvent.change(fresh.getByLabelText('Shared set name'), { target: { value: 'Field Crew' } });
    fireEvent.change(fresh.getByLabelText('Add a KPI to Field Crew'), { target: { value: 'tasks_on_time' } });
    fireEvent.change(fresh.getByLabelText('Tasks On Time weight (Field Crew)'), { target: { value: '100' } });
    fireEvent.click(fresh.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.perfSharedScorecardSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Field Crew', id: '', company: 'co' })));
  });

  it('read-only for someone who is not HR', async () => {
    calls.perfScorecards.mockResolvedValue({ ...DATA, canEdit: false });
    render(<ScorecardSettings company="co" toastOk={vi.fn()} toastErr={vi.fn()} />);
    await screen.findByText('Analyst', { selector: 'div' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Add a KPI to Analyst')).toBeNull();
    expect(screen.getByLabelText('Tasks On Time weight (Analyst)').disabled).toBe(true);
  });
});
