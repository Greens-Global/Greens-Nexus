import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Headcount Requests are off per company until Settings turns them on (Neil,
// Oct 30 2026): the switch saves on click, and where they are off HR starts
// an opening by hand in People > Hiring > Openings.
const save = vi.fn();
const createOpening = vi.fn();
vi.mock('../../api', () => ({
  api: {
    headcountSettings: () => Promise.resolve({ company: 'ent', on: false, canEdit: true }),
    headcountSaveSettings: (...a) => save(...a),
    listOpenings: () => Promise.resolve([]),
    careersLinks: () => Promise.resolve([]),
    createOpening: (...a) => createOpening(...a),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), myEmail: 'holly@x.com' }) }));
vi.mock('../../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
const { default: HeadcountSwitch } = await import('./HeadcountSwitch');
const { default: JobOpenings } = await import('./JobOpenings');

beforeEach(() => {
  save.mockReset().mockImplementation((company, on) => Promise.resolve({ company, on, canEdit: true }));
  createOpening.mockReset();
});

describe('Headcount Requests switch', () => {
  it('starts off and saves on click with a toast', async () => {
    const toastOk = vi.fn();
    render(<HeadcountSwitch company="ent" toastOk={toastOk} />);
    const sw = await screen.findByRole('switch', { name: 'Headcount Requests' }).catch(() => screen.findByLabelText('Headcount Requests'));
    expect(sw.checked).toBe(false);
    expect(screen.getByText(/HR starts job openings directly/)).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(save).toHaveBeenCalledWith('ent', true));
    expect(toastOk).toHaveBeenCalledWith('Headcount Requests turned on for this company.');
  });
});

describe('JobOpenings without Headcount Requests', () => {
  it('offers New Opening for a company that has them off', async () => {
    createOpening.mockResolvedValue({ id: 'o1', title: 'Site Supervisor', status: 'draft', seats: 1, counts: { total: 0, hired: 0 },
      companyName: 'Hire Co', history: [], employmentType: 'full_time' });
    render(<JobOpenings directCompanies={[{ id: 'ent', name: 'Hire Co' }]} toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New Opening/ }));
    fireEvent.change(screen.getByLabelText('Job Title *'), { target: { value: 'Site Supervisor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Opening' }));
    await waitFor(() => expect(createOpening).toHaveBeenCalledWith(expect.objectContaining({ company: 'ent', title: 'Site Supervisor', seats: 1 })));
  });

  it('keeps the approved-request line where every company uses Headcount Requests', async () => {
    render(<JobOpenings toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('New openings come from approved headcount requests.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New Opening/ })).toBeNull();
  });
});
