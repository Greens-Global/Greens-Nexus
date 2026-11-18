import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Settings > Operations > Tenants And Facility Access (Neil, 11/17/2026):
// who sees which facilities and tenant details, by role and by person. Each
// change saves at once; a save that fails puts the control back and says why.

const api = { opsAccess: vi.fn(), saveOpsAccess: vi.fn(), deleteOpsAccess: vi.fn(), getPeopleDirectory: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: OpsAccessSettings } = await import('./OpsAccessSettings');

const PRIYA = { id: 'r1', subjectType: 'person', subjectId: 'priya@greensglobal.com', subjectName: 'Priya Shah', facilityIds: ['fac_a'], tenantDetails: false, updatedBy: 'neil@greensglobal.com', updatedAt: '2026-11-17T18:00:00Z' };
const MANAGERS = { id: 'r2', subjectType: 'group', subjectId: 'g1', subjectName: 'Site Managers', facilityIds: [], tenantDetails: true, updatedBy: 'neil@greensglobal.com', updatedAt: '2026-11-17T18:00:00Z' };
const DATA = { rules: [PRIYA, MANAGERS],
  facilities: [{ id: 'fac_a', name: 'Temecula' }, { id: 'fac_b', name: 'Murrieta' }],
  groups: [{ id: 'g1', name: 'Site Managers', isJobRole: false }, { id: 'g2', name: 'Facility Manager', isJobRole: true }] };
const PEOPLE = [{ email: 'priya@greensglobal.com', name: 'Priya Shah', title: 'Regional Manager' }, { email: 'sam@greensglobal.com', name: 'Sam Ortiz', title: 'Site Lead' }];
const rowOf = (name) => screen.getByText(name).closest('[data-testid="ops-access-rule"]');
const details = (name) => screen.getByRole('switch', { name: `Tenant Details for ${name}` });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.opsAccess.mockResolvedValue(DATA);
  api.getPeopleDirectory.mockResolvedValue(PEOPLE);
});

describe('Operations access rules', () => {
  it('lists a rule a row: who, which facilities, tenant details', async () => {
    render(<OpsAccessSettings />);
    expect(await screen.findByText('Priya Shah')).toBeTruthy();
    expect(screen.getByText(/Everyone else sees tenant details only when a rule here says so/)).toBeTruthy();
    // A person carries their job title, a role the quiet word.
    expect(await within(rowOf('Priya Shah')).findByText('Regional Manager')).toBeTruthy();
    expect(within(rowOf('Site Managers')).getByText('Role')).toBeTruthy();
    expect(within(rowOf('Priya Shah')).getByRole('button', { name: 'Facilities for Priya Shah: Temecula' })).toBeTruthy();
    expect(within(rowOf('Site Managers')).getByRole('button', { name: 'Facilities for Site Managers: Every Facility' })).toBeTruthy();
    expect(details('Priya Shah').checked).toBe(false);
    expect(details('Site Managers').checked).toBe(true);
    expect(screen.getAllByTestId('ops-access-rule').length).toBe(2);
  });

  it('saves Tenant Details the moment it is switched, with a toast', async () => {
    api.saveOpsAccess.mockResolvedValue({ ...PRIYA, tenantDetails: true });
    const ok = vi.fn();
    render(<OpsAccessSettings toastOk={ok} />);
    await screen.findByText('Priya Shah');
    fireEvent.click(details('Priya Shah'));
    await waitFor(() => expect(api.saveOpsAccess).toHaveBeenCalledWith({ subjectType: 'person', subjectId: 'priya@greensglobal.com', facilityIds: ['fac_a'], tenantDetails: true }));
    await waitFor(() => expect(ok).toHaveBeenCalledWith('Priya Shah sees tenant details'));
    expect(details('Priya Shah').checked).toBe(true);
    expect(details('Priya Shah').disabled).toBe(false);
  });

  it('puts the switch back and says why when the save fails', async () => {
    api.saveOpsAccess.mockRejectedValue(new Error('Priya Shah is not in Nexus People.'));
    const err = vi.fn();
    render(<OpsAccessSettings toastErr={err} />);
    await screen.findByText('Priya Shah');
    fireEvent.click(details('Priya Shah'));
    await waitFor(() => expect(err).toHaveBeenCalledWith('Priya Shah is not in Nexus People.'));
    expect(details('Priya Shah').checked).toBe(false);
    expect(details('Priya Shah').disabled).toBe(false);
  });

  it('says why on the page when there is no toast to say it', async () => {
    api.saveOpsAccess.mockRejectedValue(new Error('Unknown facility.'));
    render(<OpsAccessSettings />);
    await screen.findByText('Priya Shah');
    fireEvent.click(details('Priya Shah'));
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved - Unknown facility.');
    expect(details('Priya Shah').checked).toBe(false);
  });

  it('saves a facility the moment it is ticked, and never unticks the last one', async () => {
    api.saveOpsAccess.mockResolvedValue({ ...PRIYA, facilityIds: ['fac_a', 'fac_b'] });
    render(<OpsAccessSettings />);
    await screen.findByText('Priya Shah');
    fireEvent.click(screen.getByRole('button', { name: 'Facilities for Priya Shah: Temecula' }));
    const list = await screen.findByRole('group', { name: 'Facilities for Priya Shah' });
    // An empty list means every facility, so the only one picked stays picked.
    expect(within(list).getByRole('checkbox', { name: 'Temecula' }).disabled).toBe(true);
    expect(within(list).getByRole('checkbox', { name: 'Every Facility' }).checked).toBe(false);
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Murrieta' }));
    await waitFor(() => expect(api.saveOpsAccess).toHaveBeenCalledWith({ subjectType: 'person', subjectId: 'priya@greensglobal.com', facilityIds: ['fac_a', 'fac_b'], tenantDetails: false }));
    expect(await screen.findByRole('button', { name: 'Facilities for Priya Shah: Temecula, Murrieta' })).toBeTruthy();
  });

  it('adds a rule for a role from New, with Tenant Details off', async () => {
    api.saveOpsAccess.mockResolvedValue({ id: 'r3', subjectType: 'group', subjectId: 'g2', subjectName: 'Facility Manager', facilityIds: [], tenantDetails: false });
    render(<OpsAccessSettings />);
    await screen.findByText('Priya Shah');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Role\.\.\./ }));
    const pick = await screen.findByRole('combobox', { name: 'Role for the new rule' });
    // A role that already has a rule is not offered twice.
    expect(within(pick).queryByRole('option', { name: 'Site Managers' })).toBeNull();
    fireEvent.change(pick, { target: { value: 'g2' } });
    await waitFor(() => expect(api.saveOpsAccess).toHaveBeenCalledWith({ subjectType: 'group', subjectId: 'g2', facilityIds: [], tenantDetails: false }));
    expect(await screen.findByText('Facility Manager')).toBeTruthy();
    expect(details('Facility Manager').checked).toBe(false);
    expect(screen.getAllByTestId('ops-access-rule').length).toBe(3);
  });

  it('says a failed load failed - never "No rules yet." - and tries again', async () => {
    api.opsAccess.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 500 }));
    render(<OpsAccessSettings />);
    expect(await screen.findByText("Couldn't load the access rules.")).toBeTruthy();
    expect(screen.queryByText(/No rules yet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Priya Shah')).toBeTruthy();
  });

  it('has its own words when there are no rules, and when the person may not open them', async () => {
    api.opsAccess.mockResolvedValueOnce({ ...DATA, rules: [] });
    const first = render(<OpsAccessSettings />);
    expect(await screen.findByText(/No rules yet\. Only Administrators and Super Administrators see tenant details\./)).toBeTruthy();
    first.unmount();
    api.opsAccess.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 403 }));
    render(<OpsAccessSettings />);
    expect(await screen.findByText(/Only an Administrator, a Super Administrator or someone with Full access to Operations/)).toBeTruthy();
  });
});
