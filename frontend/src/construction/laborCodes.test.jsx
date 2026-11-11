// Labor by cost code (Construction Round Three item 3, Neil, 11/11/2026): the
// Time Clock's cost code picker, the job's labor codes on Edit Job and the
// job's hours by cost code. The rules live on the server
// (backend/test_construction_labor_codes.py); these pin what the screens do.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../api', () => ({ api: {
  getMyCostCodes: vi.fn(), getJobLabor: vi.fn(), getJobPhotos: vi.fn(async () => ({ photos: [] })),
  getJobForms: vi.fn(async () => ({ entries: [] })), getJobEquipment: vi.fn(async () => ({ links: [], available: [] })),
  getJobCostCodes: vi.fn(), setJobLaborCodes: vi.fn(), updateConstructionProject: vi.fn(),
  getPeopleDirectory: vi.fn(async () => []), getTicketProperties: vi.fn(async () => ({ properties: [] })),
  getBookProjects: vi.fn(async () => ({ limited: false, entities: [], codes: [] })), mapJobBooks: vi.fn(),
  searchJobCustomers: vi.fn(), setJobClient: vi.fn(),
} }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'pat.crew@example.com' }) }));

const { api } = await import('../api');
const { default: PunchCostCode } = await import('./PunchCostCode');
const { default: FieldTab } = await import('./job/FieldTab');
const { default: EditJobSheet } = await import('./EditJobSheet');
const { punchCostCodeFields, rememberCode, setPunchCostCode } = await import('../lib/punchCostCode');

const CODES = [{ code: 'CC-100', name: 'Sitework' }, { code: 'CC-200', name: 'Concrete' }];
const job = {
  id: 'j1', name: 'Sample Build', jobType: 'project', status: 'active', canEdit: true, contractValue: 1000,
  today: '2026-11-11', workerEmails: [], managerEmails: [], executiveEmails: [], names: {}, laborCodes: [CODES[0]],
};

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); vi.clearAllMocks(); setPunchCostCode(null); });

describe('The Time Clock cost code', () => {
  it('shows nothing when the day\'s shift is on no job with labor codes', async () => {
    api.getMyCostCodes.mockResolvedValue({ codes: [] });
    const { container } = render(<PunchCostCode />);
    await waitFor(() => expect(api.getMyCostCodes).toHaveBeenCalled());
    expect(container.querySelector('[data-punch-cost-code]')).toBeNull();
    expect(punchCostCodeFields('in')).toEqual({});
  });

  it('offers the job\'s codes, starts on the person\'s last one, and the pick goes with the punch-in', async () => {
    rememberCode('pat.crew@example.com', 'j1', 'CC-200');
    api.getMyCostCodes.mockResolvedValue({ jobId: 'j1', jobName: 'Sample Build', codes: CODES });
    const { unmount } = render(<PunchCostCode />);
    const box = await screen.findByRole('combobox', { name: 'Cost Code' });
    expect(box).toHaveValue('CC-200');
    expect(punchCostCodeFields('in')).toEqual({ cost_code: 'CC-200', cost_code_job: 'j1' });
    fireEvent.change(box, { target: { value: '' } });
    expect(punchCostCodeFields('in')).toEqual({});
    fireEvent.change(box, { target: { value: 'CC-100' } });
    expect(punchCostCodeFields('out')).toEqual({});
    unmount();
    expect(punchCostCodeFields('in')).toEqual({});   // leaving the page clears the pick
  });
});

describe('The job\'s hours by cost code', () => {
  it('lists hours per code in hours and minutes, Not Coded last', async () => {
    api.getJobLabor.mockResolvedValue({ rows: [{ date: '2026-11-10', email: 'a@example.com', hours: 5.5 }], byPerson: { 'a@example.com': 5.5 },
      byDay: { '2026-11-10': 5.5 }, total: 5.5,
      byCode: [{ code: 'CC-100', name: 'Sitework', hours: 4 }, { code: '', name: 'Not Coded', hours: 1.5 }] });
    const { container } = render(<FieldTab project={job} />);
    await waitFor(() => expect(container.querySelector('[data-hours-by-code]')).toBeTruthy());
    const box = container.querySelector('[data-hours-by-code]');
    expect(box.textContent).toContain('CC-100 - Sitework');
    expect(box.textContent).toContain('Not Coded');
    expect(box.textContent).not.toMatch(/\d\.\d/);   // never decimal hours
  });
});

describe('Edit Job - Labor Cost Codes', () => {
  const money = { data: { allowed: true, canMap: true, link: { project: '', entity: '' } }, error: '', reload: vi.fn() };

  it('a manager with Money adds a code from the job\'s list and the one Save sets them', async () => {
    api.getJobCostCodes.mockResolvedValue({ codes: [...CODES.map((c) => ({ ...c, onJob: true }))] });
    api.setJobLaborCodes.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    render(<EditJobSheet project={job} money={money} onClose={() => {}} onSaved={onSaved} />);
    const pick = await screen.findByRole('combobox', { name: 'Add a Labor Cost Code' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'CC-200 - Concrete' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'CC-100 - Sitework' })).toBeNull();   // already listed
    fireEvent.change(pick, { target: { value: 'CC-200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1));
    await waitFor(() => expect(api.setJobLaborCodes).toHaveBeenCalledWith('j1', CODES));
    expect(onSaved).toHaveBeenCalled();
  });

  it('no Labor Cost Codes without Money access', () => {
    render(<EditJobSheet project={job} money={{ data: { allowed: false }, error: '', reload: vi.fn() }} onClose={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Add a Labor Cost Code' })).toBeNull();
    expect(api.getJobCostCodes).not.toHaveBeenCalled();
  });
});
