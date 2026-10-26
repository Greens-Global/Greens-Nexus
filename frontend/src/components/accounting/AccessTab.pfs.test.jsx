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
  { email: 'vinod@greensglobal.com', name: 'Vinod Shah', isOwner: false, level: 'viewer', managedLevel: 'viewer', otherGroups: [], files: ['f1'], canChange: true },
];

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingAccess: vi.fn(async () => ({ people: [
      { email: 'urmi.gor@greensglobal.com', level: 'viewer', hasGrant: true, entities: ['15000'] },
      { email: 'priyanka.sahu@greensglobal.com', level: 'editor', hasGrant: true, entities: [] },
    ] })),
    getPfsAccessPeople: vi.fn(async () => ({ people: pfsPeople, levels: ['none', 'viewer', 'editor'], files: [{ id: 'f1', name: 'Rajesh Kadakia', archived: false }, { id: 'f2', name: 'Second File', archived: false }, { id: 'f3', name: 'Old Trust', archived: true }] })),
    setPfsAccessLevel: vi.fn(async (email, level, files) => ({ ...pfsPeople.find((p) => p.email === email), level, managedLevel: level, ...(files ? { files } : {}) })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }, { email: 'priyanka.sahu@greensglobal.com', name: 'Priyanka Sahu' }]),
  },
}));
vi.mock('../PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', myRole: role.myRole }) }));

import AccessTab from './AccessTab';
import { api } from '../../api';
import { refreshPhotoMap } from '../../lib/peoplePhotos';

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
    const rows = within(section).getAllByRole('row').slice(1).map((r) => r.cells[0].querySelector('.acct-person-name').textContent);
    expect(rows).toEqual(['Neil Kadakia', 'Vinod Shah']);
    expect(within(within(section).getByText('Neil Kadakia').closest('tr')).getByText('Owner')).toBeTruthy();
    expect(within(section).queryByRole('combobox', { name: 'PFS access for Neil Kadakia' })).toBeNull();
    // Archana has no Accounting access: she is added here, then given Viewer. Nobody is granted until picked.
    expect(api.setPfsAccessLevel).not.toHaveBeenCalled();
    // The Tasks people picker (add mode): open, type, pick.
    fireEvent.click(within(section).getByRole('button', { name: /^Give PFS Access to a Person:/ }));
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'arch' } });
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Archana Kadakia'));
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

  it('picks WHICH PFS a person sees, not all or none (Neil, 10/14)', async () => {
    render(<AccessTab />);
    const section = await screen.findByRole('region', { name: 'PFS Access Without Accounting' });
    // Vinod sees one of the three; Priyanka (a grant through another group) sees all of them.
    expect(within(section).getByRole('button', { name: 'Which PFS Vinod Shah can see' }).textContent).toContain('1 of 3 PFS');
    const priyanka = screen.getByRole('button', { name: 'Which PFS Priyanka Sahu can see' });
    expect(priyanka.textContent).toContain('All PFS');
    // Nobody without PFS access gets the picker.
    expect(screen.queryByRole('button', { name: 'Which PFS Urmi Gor can see' })).toBeNull();
    fireEvent.click(priyanka);
    const dialog = screen.getByRole('dialog', { name: 'Which PFS Priyanka Sahu can see' });
    fireEvent.click(within(dialog).getByLabelText(/Only the PFS Picked Below/));
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('option', { name: /Second File/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setPfsAccessLevel).toHaveBeenCalledWith('priyanka.sahu@greensglobal.com', 'viewer', ['f2']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Which PFS Priyanka Sahu can see' }).textContent).toContain('1 of 3 PFS');
    // And back to every PFS.
    fireEvent.click(within(section).getByRole('button', { name: 'Which PFS Vinod Shah can see' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText(/All PFS/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setPfsAccessLevel).toHaveBeenCalledWith('vinod@greensglobal.com', 'viewer', []));
  });

  it('lists administrators and owners, shows five entities then +N, and a face by every name (Neil, 10/14)', async () => {
    const many = ['10000', '11000', '12000', '13000', '14000', '16000', '17000', '18000'];
    api.getAccountingAccess.mockResolvedValueOnce({ people: [
      { email: 'urmi.gor@greensglobal.com', level: 'viewer', hasGrant: true, admin: '', entities: many },
      { email: 'charmi@greensglobal.com', level: 'administrator', hasGrant: true, admin: 'administrator', entities: [] },
    ] });
    const directory = api.getPeopleDirectory.getMockImplementation();
    api.getPeopleDirectory.mockResolvedValue([
      { email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor', photoUrl: 'https://example.supabase.co/storage/v1/object/public/people/urmi.png' },
      { email: 'charmi@greensglobal.com', name: 'Charmi Shah' },
    ]);
    refreshPhotoMap();   // the photo map is cached per session
    render(<AccessTab />);
    const charmi = (await screen.findByText('Charmi Shah')).closest('tr');
    expect(within(charmi).getByText('Administrator')).toBeTruthy();
    expect(within(charmi).getByText('All Entities')).toBeTruthy();
    expect(within(charmi).queryByRole('button', { name: 'Change' })).toBeNull();
    const urmi = screen.getByText('Urmi Gor').closest('tr');
    expect(within(urmi).getAllByText(/^1[0-8]000$/)).toHaveLength(5);
    const more = within(urmi).getByRole('button', { name: '+3' });
    fireEvent.click(more);
    expect(within(urmi).getAllByText(/^1[0-8]000$/)).toHaveLength(8);
    fireEvent.click(within(urmi).getByRole('button', { name: 'Show Less' }));
    expect(within(urmi).getAllByText(/^1[0-8]000$/)).toHaveLength(5);
    await waitFor(() => expect(urmi.querySelector('img')?.getAttribute('src') || '').toContain('urmi.png'));
    api.getPeopleDirectory.mockImplementation(directory);
  });
});
