// Subs and their papers (Round Two item 7, 11/05/2026): the Subs tab lists
// the job's subs with the state of their papers, adds one from Intacct's
// vendor list (never typed in) and saves the papers through the one form.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../../api', () => ({ api: {
  getJobSubs: vi.fn(),
  searchConstructionVendors: vi.fn(),
  addJobSub: vi.fn(),
  endJobSub: vi.fn(),
  getVendorCompliance: vi.fn(),
  saveVendorCompliance: vi.fn(),
} }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn(), undo: vi.fn() } }));

const { api } = await import('../../api');
const { default: SubsTab } = await import('./SubsTab');
const { default: VendorCompliance } = await import('../VendorCompliance');

const acme = { linkId: 'l1', vendorId: 'V-100', name: 'Acme Plumbing', trade: 'Plumbing', since: '2026-11-01T10:00:00Z',
  compliance: { vendorId: 'V-100', vendorName: 'Acme Plumbing', coiExpiresOn: '2026-11-20', wcExpiresOn: '', licenseNumber: '', licenseExpiresOn: '',
    w9OnFile: false, notes: '', state: 'expiring', issues: ['Insurance Certificate expires 11/20/2026 (in 15 days).'] } };
const project = { id: 'pa', name: 'Job A', jobType: 'project', today: '2026-11-05' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Subs tab', () => {
  it('lists the subs with their papers and adds one from the Intacct list', async () => {
    api.getJobSubs.mockResolvedValue({ subs: [acme], canEdit: true, today: '2026-11-05' });
    api.searchConstructionVendors.mockResolvedValue({ vendors: [{ id: 'V-200', name: 'Bolt Electric', inactive: false }] });
    api.addJobSub.mockResolvedValue({ subs: [], canEdit: true });
    render(<SubsTab project={project} />);
    const row = (await screen.findByText('Acme Plumbing')).closest('[data-sub]');
    expect(row.textContent).toContain('Plumbing');
    expect(within(row).getByText('Expiring Soon')).toBeInTheDocument();
    expect(row.textContent).toContain('Insurance Certificate expires 11/20/2026');
    fireEvent.change(screen.getByLabelText('Find a vendor'), { target: { value: 'bolt' } });
    fireEvent.click(await screen.findByRole('option', { name: /Bolt Electric/ }));
    expect(api.searchConstructionVendors).toHaveBeenCalledWith('bolt', 'pa');
    fireEvent.change(screen.getByLabelText('Trade'), { target: { value: 'Electrical' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Sub' }));
    await waitFor(() => expect(api.addJobSub).toHaveBeenCalledWith('pa', { vendor_id: 'V-200', trade: 'Electrical' }));
  });

  it('the crew reads the list but gets no Add, no Papers and no Remove', async () => {
    api.getJobSubs.mockResolvedValue({ subs: [acme], canEdit: false, today: '2026-11-05' });
    render(<SubsTab project={project} />);
    await screen.findByText('Acme Plumbing');
    expect(screen.queryByLabelText('Find a vendor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Papers' })).toBeNull();
    expect(screen.queryByRole('button', { name: /off the job/ })).toBeNull();
  });
});

describe('The papers form', () => {
  it('reads the row, saves only when something changed, and says the new state', async () => {
    api.getVendorCompliance.mockResolvedValue({ compliance: { ...acme.compliance, state: 'missing', coiExpiresOn: '', issues: ['No insurance certificate on file.'] } });
    api.saveVendorCompliance.mockResolvedValue({ compliance: { ...acme.compliance, state: 'ok', issues: [], w9OnFile: true, licenseNumber: 'C36-1', updatedAt: '2026-11-05T12:00:00Z', updatedBy: 'mgr.a@greensglobal.com' } });
    render(<VendorCompliance vendorId="V-100" />);
    expect(await screen.findByText('No Insurance On File')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save Papers' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('License Number'), { target: { value: 'C36-1' } });
    fireEvent.click(screen.getByLabelText('W-9 On File'));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveVendorCompliance).toHaveBeenCalledWith('V-100', expect.objectContaining({ license_number: 'C36-1', w9_on_file: true })));
    expect(await screen.findByText('Papers Current')).toBeInTheDocument();
    expect(screen.getByText(/Updated 11\/05\/2026 by mgr.a@greensglobal.com/)).toBeInTheDocument();
  });
});
