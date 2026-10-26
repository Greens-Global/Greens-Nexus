import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Item Management > Send Alert: the recipient list ranks first names first
// and Enter ticks the highlighted person once something is typed (Oct 25
// 2026, the people-picker order).

const { role } = vi.hoisted(() => ({ role: { manager: false } }));
vi.mock('../contexts/InventoryContext', () => ({
  useInventory: () => ({
    items: [], itemsLoading: false, itemsError: null,
    checkouts: [], checkoutsLoading: false, checkoutsError: null,
    submitCartCheckouts: vi.fn(), approveRequest: vi.fn(), rejectRequest: vi.fn(),
    allocateItem: vi.fn(), initiateHandover: vi.fn(), confirmReceipt: vi.fn(), returnItem: vi.fn(), cancelRequest: vi.fn(),
    refreshItems: vi.fn(), refreshCheckouts: vi.fn(),
    patchItemLocal: vi.fn(), removeItemsLocal: vi.fn(), addItemLocal: vi.fn(),
  }),
}));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ addNotification: vi.fn(), notifications: [] }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: () => role.manager, canAccessModule: () => role.manager, loading: false,
    myGrantedModules: new Map(), myEmail: 'erin@greensglobal.com',
  }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Erin Test', username: 'erin@greensglobal.com' }] }),
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }), useItemApprovers: () => ({ data: [] }) }));
const USERS = [
  { email: 'charmi@x.com', name: 'Charmi Desai' },
  { email: 'sai@x.com', name: 'Sai Malladi' },
  { email: 'amy@x.com', name: 'Amy Wilson' },
];
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => (k === 'getPeopleDirectory' ? vi.fn(async () => USERS) : vi.fn(async () => [])) });
  return { api, default: api };
});

const { SendAlertModal } = await import('./InventoryManagement');

describe('Send Alert recipients', () => {
  it('ranks first names first and Enter ticks the top match', async () => {
    render(<SendAlertModal onClose={() => {}} toast={() => {}} />);
    await screen.findByText('Amy Wilson');
    const box = screen.getByPlaceholderText('Search by name or email…');
    fireEvent.change(box, { target: { value: 'sai' } });
    const rows = screen.getAllByRole('option');
    expect(rows[0].textContent).toContain('Sai Malladi');
    expect(rows[1].textContent).toContain('Charmi Desai');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeInTheDocument());
  });

  it('Enter in an empty search ticks nobody', async () => {
    render(<SendAlertModal onClose={() => {}} toast={() => {}} />);
    await screen.findByText('Amy Wilson');
    fireEvent.keyDown(screen.getByPlaceholderText('Search by name or email…'), { key: 'Enter' });
    expect(screen.queryByText(/\(\d+ selected\)/)).toBeNull();
  });
});
