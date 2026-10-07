import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Access: the PFS column (Charmi, Oct 7, item 41: "Access need
// to include access for PFS"). Owners set None / Viewer / Editor per person;
// an owner reads "Owner"; a grant from another group is a note; people with
// no Accounting access can be given PFS access under the table.

const role = vi.hoisted(() => ({ myRole: 'owner' }));
const pfsPeople = [
  { email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor', isOwner: false, level: 'none', managedLevel: 'none', otherGroups: [], canChange: true },
  { email: 'priyanka.sahu@greensglobal.com', name: 'Priyanka Sahu', isOwner: false, level: 'editor', managedLevel: 'viewer', otherGroups: [{ id: 'grp-fin', name: 'Finance Leads', level: 'editor' }], canChange: true },
  { email: 'neil@greensglobal.com', name: 'Neil Kadakia', isOwner: true, level: 'owner', managedLevel: 'none', otherGroups: [], canChange: false },
  { email: 'archana@kadakia.com', name: 'Archana Kadakia', isOwner: false, level: 'none', managedLevel: 'none', otherGroups: [], canChange: true },
  { email: 'vinod@greensglobal.com', name: 'Vinod Shah', isOwner: false, level: 'viewer', managedLevel: 'viewer', otherGroups: [], canChange: true },
];

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingAccess: vi.fn(async () => ({ people: [
      { email: 'urmi.gor@greensglobal.com', level: 'viewer', hasGrant: true, entities: ['15000'] },
      { email: 'priyanka.sahu@greensglobal.com', level: 'editor', hasGrant: true, entities: [] },
    ] })),
    getPfsAccessPeople: vi.fn(async () => ({ people: pfsPeople, levels: ['none', 'viewer', 'editor'] })),
    setPfsAccessLevel: vi.fn(async (email, level) => ({ ...pfsPeople.find((p) => p.email === email), level, managedLevel: level })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }, { email: 'priyanka.sahu@greensglobal.com', name: 'Priyanka Sahu' }]),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', myRole: role.myRole }) }));

import AccessTab from './AccessTab';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); role.myRole = 'owner'; });

describe('Accounting > Access - PFS', () => {
  it('gives owners a PFS column: None / Viewer / Editor, with other groups as a note', async () => {
    render(<AccessTab />);
    expect((await screen.findAllByRole('columnheader', { name: 'PFS' })).length).toBe(2);   // the main table and the PFS-only one
    const urmi = screen.getByRole('combobox', { name: 'PFS access for Urmi Gor' });
    expect(urmi.value).toBe('none');
    expect([...urmi.options].map((o) => o.textContent)).toEqual(['None', 'Viewer', 'Editor']);
    const priyanka = screen.getByRole('combobox', { name: 'PFS access for Priyanka Sahu' });
    expect(priyanka.value).toBe('viewer');
    expect(within(priyanka.closest('td')).getByText('Also Editor through Finance Leads')).toBeTruthy();
    fireEvent.change(urmi, { target: { value: 'editor' } });
    await waitFor(() => expect(api.setPfsAccessLevel).toHaveBeenCalledWith('urmi.gor@greensglobal.com', 'editor'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'PFS access for Urmi Gor' }).value).toBe('editor'));
  });

  it('lists PFS access outside Accounting, an owner as "Owner", and adds a person there', async () => {
    render(<AccessTab />);
    const section = await screen.findByRole('region', { name: 'PFS Access Without Accounting' });
    const rows = within(section).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent);
    expect(rows).toEqual(['Neil Kadakia', 'Vinod Shah']);
    expect(within(within(section).getByText('Neil Kadakia').closest('tr')).getByText('Owner')).toBeTruthy();
    expect(within(section).queryByRole('combobox', { name: 'PFS access for Neil Kadakia' })).toBeNull();
    // Archana has no Accounting access: she is added here, then given Viewer. Nobody is granted until picked.
    expect(api.setPfsAccessLevel).not.toHaveBeenCalled();
    fireEvent.change(within(section).getByRole('combobox', { name: 'Give PFS Access to a Person' }), { target: { value: 'archana@kadakia.com' } });
    const archana = within(section).getByRole('combobox', { name: 'PFS access for Archana Kadakia' });
    expect(archana.value).toBe('none');
    fireEvent.change(archana, { target: { value: 'viewer' } });
    await waitFor(() => expect(api.setPfsAccessLevel).toHaveBeenCalledWith('archana@kadakia.com', 'viewer'));
  });

  it('shows nothing about PFS to someone who is not an owner', async () => {
    role.myRole = 'admin';
    render(<AccessTab />);
    await screen.findByText('Urmi Gor');
    expect(screen.queryAllByRole('columnheader', { name: 'PFS' })).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'PFS Access Without Accounting' })).toBeNull();
    expect(api.getPfsAccessPeople).not.toHaveBeenCalled();
  });
});
