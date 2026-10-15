// Home's "Needs Your Attention" (Oct 14 widget pass): the list shows a slice
// (three signatures, six notifications, seven rows), but the count, the
// greeting's summary and the View All row say the REAL total - it used to
// read "You have 7 items" over twelve.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ mySignatures: vi.fn(), dashKpis: vi.fn() }));
const openPanel = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, actingAs: null }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel }) }));
vi.mock('../lib/useTimeStatus', () => ({ useTimeStatus: () => ({ status: null, reload: vi.fn() }) }));
vi.mock('./QuickActionModals.jsx', () => ({ default: () => null }));

import DeskHome from './DeskHome';

const notif = (i) => ({ id: `n${i}`, title: `Review report ${i}`, body: '', read: false, closed: false, action: { view: 'tasks' }, timestamp: new Date().toISOString() });

beforeEach(() => {
  apiMock.mySignatures.mockResolvedValue([1, 2, 3, 4].map((i) => ({ id: i, title: `Offer letter ${i}` })));
  apiMock.dashKpis.mockResolvedValue({ kpis: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DeskHome attention queue', () => {
  it('counts every item, shows seven, and View All opens the rest', async () => {
    const notifications = Array.from({ length: 8 }, (_, i) => notif(i));
    render(<DeskHome notifications={notifications} />);
    // 4 signatures + 8 actionable notifications = 12, not the 7 rows shown.
    expect(await screen.findByText('12 items')).toBeTruthy();
    expect(document.querySelectorAll('.dk-queue-row')).toHaveLength(7);
    expect(document.querySelector('.dk-count').textContent).toBe('12');
    fireEvent.click(screen.getByRole('button', { name: /View All \(12\)/ }));
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it('no View All row when everything fits; Title Case headings', async () => {
    apiMock.mySignatures.mockResolvedValue([{ id: 1, title: 'Offer letter' }]);
    render(<DeskHome notifications={[notif(1)]} />);
    await waitFor(() => expect(document.querySelectorAll('.dk-queue-row')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /View All/ })).toBeNull();
    expect(screen.getByText('2 items')).toBeTruthy();
    for (const t of ['Needs Your Attention', 'Quick Actions', 'Open Tasks', 'Signatures Needed']) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Request an Item/ })).toBeTruthy();
  });
});
