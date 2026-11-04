// Field and Closeout (Neil, 11/03/2026, plan phase 3): the Job page's Photos,
// Changes and Closeout tabs render and do what they say. The rules live on
// the server (backend/test_construction_field_*.py, test_construction_handover.py).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../api', () => ({ api: {
  getJobTimeline: vi.fn(), makePhotoPair: vi.fn(), removePhotoPair: vi.fn(), updateMediaMeta: vi.fn(), photoReportPdf: vi.fn(),
  addJobMedia: vi.fn(), getJobChanges: vi.fn(), sendChangeOrder: vi.fn(), approveChangeOrder: vi.fn(), createChangeOrder: vi.fn(),
  getJobCloseout: vi.fn(), addCloseoutRecord: vi.fn(), closeOutJob: vi.fn(), sendOwnerSignoff: vi.fn(),
} }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'mgr2@greensglobal.com' }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), prompt: vi.fn(), undo: vi.fn() } }));

const { api } = await import('../../api');
const { default: PhotosTab } = await import('./PhotosTab');
const { default: ChangesTab } = await import('./ChangesTab');
const { default: CloseoutTab } = await import('./CloseoutTab');

const project = { id: 'j1', name: 'Gate Motor Repair', jobType: 'project', canEdit: true, today: '2026-11-03', managerEmails: ['mgr@greensglobal.com'], workerEmails: [], names: {}, taskProjectId: 'tp1' };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Photos', () => {
  const photos = [
    { id: 'a', url: 'https://x/a.jpg', takenAt: '2026-11-03T18:00:00Z', day: '2026-11-03', tags: ['after'], locationText: 'North wall', uploadedByName: 'Ana Lopez', kind: 'photo' },
    { id: 'b', url: 'https://x/b.jpg', takenAt: '2026-11-01T18:00:00Z', day: '2026-11-01', tags: ['before'], locationText: 'North wall', uploadedByName: 'Ana Lopez', kind: 'photo' },
  ];
  it('groups by day, filters by tag, and two picked photos make a pair (the earlier is Before)', async () => {
    api.getJobTimeline.mockResolvedValue({ photos, pairs: [], tags: ['after', 'before'], logs: [], canAdd: true, canReview: true, timeZone: 'America/Los_Angeles' });
    api.makePhotoPair.mockResolvedValue({ id: 'pr1' });
    const { container } = render(<PhotosTab project={project} />);
    await waitFor(() => expect(container.querySelector('[data-photo="a"]')).toBeTruthy());
    expect(screen.getByRole('region', { name: '11/03/2026' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'before' } });
    expect(container.querySelector('[data-photo="a"]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: '' } });
    const picks = screen.getAllByLabelText('Pick this photo');
    fireEvent.click(picks[0]);
    fireEvent.click(picks[1]);
    fireEvent.click(screen.getByRole('button', { name: /Make Before and After/ }));
    await waitFor(() => expect(api.makePhotoPair).toHaveBeenCalledWith('j1', { before_media_id: 'b', after_media_id: 'a' }));
  });

  it('shows a pair side by side', async () => {
    api.getJobTimeline.mockResolvedValue({ photos, pairs: [{ id: 'pr1', beforeId: 'b', afterId: 'a', caption: 'North wall patch' }], tags: [], logs: [], canAdd: false });
    const { container } = render(<PhotosTab project={project} />);
    await waitFor(() => expect(container.querySelector('[data-pair="pr1"]')).toBeTruthy());
    expect(container.querySelector('[data-pair="pr1"]').textContent).toContain('Before');
    expect(container.querySelector('[data-pair="pr1"]').textContent).toContain('North wall patch');
  });
});

describe('Changes', () => {
  it('lists field tickets and change orders with soft statuses; the named approver approves', async () => {
    api.getJobChanges.mockResolvedValue({
      fieldTickets: [{ id: 'ft1', number: 'FT-001', workDate: '2026-11-02', description: 'Moved the gas line', laborHours: 6, materials: [], photoUrls: [], status: 'signed', signedName: 'Dana Owens' }],
      changeOrders: [{ id: 'co1', number: 'CO-001', title: 'Move the gas line', amount: 4200, scheduleImpactDays: 2, status: 'awaiting_approval',
        approverEmail: 'mgr2@greensglobal.com', approverName: 'Mo Green', signerName: 'Dana Owens', reasonLabel: 'Owner Request', fieldTicketId: 'ft1' }],
      totals: { signed: 0, pending: 4200, signedDays: 0, pendingDays: 2 }, contractValue: 100000, canWrite: true, canPrice: true,
      reasons: [{ key: 'owner_request', label: 'Owner Request' }], today: '2026-11-03',
    });
    api.approveChangeOrder.mockResolvedValue({});
    const { container } = render(<ChangesTab project={project} />);
    await waitFor(() => expect(container.querySelector('[data-change-order="co1"]')).toBeTruthy());
    expect(container.querySelector('[data-field-ticket="ft1"]').textContent).toContain('Signed');
    expect(container.querySelector('[data-change-order="co1"]').textContent).toContain('Awaiting Approval');
    expect(container.querySelector('[data-change-order="co1"]').textContent).toContain('$4,200.00');
    expect(screen.getByText('$104,200.00')).toBeInTheDocument();     // the forecast
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.approveChangeOrder).toHaveBeenCalledWith('co1'));
  });

  it('the crew sees field tickets and no money', async () => {
    api.getJobChanges.mockResolvedValue({ fieldTickets: [], changeOrders: [], totals: null, contractValue: null, canWrite: true, canPrice: false, reasons: [] });
    render(<ChangesTab project={project} />);
    expect(await screen.findByRole('button', { name: /New Field Ticket/ })).toBeInTheDocument();
    expect(screen.queryByText('Contract Value')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Change Orders' })).toBeNull();
  });
});

describe('Closeout', () => {
  it('lists the checklist and the records, says what did not hand over, and offers Close Out held', async () => {
    api.getJobCloseout.mockResolvedValue({
      checklist: [{ id: 't9', title: 'Closeout checklist', checklistTotal: 6, checklistDone: 2, completed: false }],
      records: [{ id: 'r1', kind: 'warranty', title: 'Gate motor', vendor: 'LiftMaster', startOn: '2026-11-01', endOn: '2028-11-01', written: { error: 'You do not have edit access to Asset Management - an editor there can send it.' } }],
      closeout: {}, property: { id: 'prop1', name: 'Escondido Yard', canWrite: false }, canAdd: true, canClose: true,
    });
    const { container } = render(<CloseoutTab project={project} />);
    await waitFor(() => expect(container.querySelector('[data-closeout-record="r1"]')).toBeTruthy());
    expect(container.querySelector('[data-closeout="t9"]').textContent).toContain('2 of 6 checked');
    expect(container.querySelector('[data-closeout-record="r1"]').textContent).toContain('Not Handed Over');
    expect(screen.getByText(/do not have edit access to Asset Management/)).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Close Out"] .nx-hold')).toBeTruthy();
  });
});
