import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// A role's default Time Sheet approver (Oct 25 2026): the Tasks people picker
// (type to search, Recent) in place of a plain list of every name. It saves
// the picked email, and No Default Approver still clears it with ''.

const updateJobRole = vi.fn(() => Promise.resolve({}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
vi.mock('../api', () => ({ api: { updateJobRole: (...a) => updateJobRole(...a), getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myRole: 'owner', myEmail: 'me@example.com' }) };
});

const { ApproverPicker } = await import('./RolesAccess');

const people = [
  { email: 'charmi.desai@x.com', name: 'Charmi Desai' },
  { email: 'sai.patel@x.com', name: 'Sai Patel' },
];
const role = { id: 'r1', name: 'Cashier', default_manager_email: '', member_count: 3 };

afterEach(() => { cleanup(); updateJobRole.mockClear(); });

describe('Role default approver', () => {
  it('searches, ranks the first-name match first, saves the email, and clears with an empty value', async () => {
    const onSaved = vi.fn();
    render(<ApproverPicker role={role} people={people} nameOf={(e) => e} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    const box = screen.getByRole('button', { name: /^Default approver:/ });
    expect(box.textContent).toContain('No Default Approver');
    fireEvent.click(box);
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'sai' } });
    const rows = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(rows[0]).toContain('Sai Patel');                // "Charmi De-sai" is a mid-word hit, ranked after
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Sai Patel'));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalledWith('r1', { default_manager_email: 'sai.patel@x.com' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Default approver:/ }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Default approver:/ }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('No Default Approver'));
    await waitFor(() => expect(updateJobRole).toHaveBeenLastCalledWith('r1', { default_manager_email: '' }));
  });
});
