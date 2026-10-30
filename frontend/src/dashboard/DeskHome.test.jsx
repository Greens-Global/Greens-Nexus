// Home's "Needs Your Attention" (Oct 14 widget pass): the list shows a slice
// (three signatures, six notifications, seven rows), but the count, the
// greeting's summary and the View All row say the REAL total - it used to
// read "You have 7 items" over twelve.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ mySignatures: vi.fn(), dashKpis: vi.fn(), approvalsInbox: vi.fn(async () => ({ rows: [], aging: {}, who: {} })), getLinkLayout: vi.fn(async () => ({ favorites: [] })), getExternalLinks: vi.fn(async () => []), getPersonalLinks: vi.fn(async () => []) }));
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

  it('decisions waiting lead the queue, count in the total and get their own number (Oct 30 2026)', async () => {
    apiMock.mySignatures.mockResolvedValue([]);
    apiMock.approvalsInbox.mockResolvedValueOnce({ who: { canApprove: true }, aging: { over3: 1 }, rows: [
      { key: 'time_off:1', scope: 'decide', title: 'Time Off - 11/03/2026 (3 days)', person: { name: 'Erin Walsh' }, department: 'Accounting', priority: 'high', count: 1, createdAt: new Date(Date.now() - 4 * 86400e3).toISOString() },
      { key: 'assignment_accept:2', scope: 'act', title: 'Accept Item - Laptop', person: { name: 'Max' }, count: 1, createdAt: new Date().toISOString() },
    ] });
    render(<DeskHome kpis={{}} notifications={[]} markRead={vi.fn()} />);
    expect(await screen.findByText('Time Off - 11/03/2026 (3 days)')).toBeTruthy();
    expect(screen.getByText('Erin Walsh · Accounting')).toBeTruthy();
    expect(screen.queryByText('Accept Item - Laptop')).toBeNull();                     // their own to-do is not a decision
    expect(screen.getByText('1 waiting over 3 days')).toBeTruthy();                   // the Approvals number's footnote
    expect(screen.getByText(/You have/).textContent).toContain('1 item');
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

describe('DeskHome Favorites (Oct 28 2026)', () => {
  it('shows every favorite from Links, Company and Personal, in bookmark order', async () => {
    apiMock.mySignatures.mockResolvedValue([]);
    apiMock.dashKpis.mockResolvedValue({ kpis: {} });
    const company = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `App ${i + 1}`, url: `https://app${i + 1}.example.com`, category: 'Productivity' }));
    apiMock.getExternalLinks.mockResolvedValueOnce(company);
    apiMock.getPersonalLinks.mockResolvedValueOnce([{ id: 1, name: 'My Bank', url: 'https://bank.example.com' }]);
    apiMock.getLinkLayout.mockResolvedValueOnce({ favorites: [
      { item_type: 'personal', item_id: 1 },
      ...company.map((l) => ({ item_type: 'external', item_id: l.id })),
      { item_type: 'external', item_id: 404 },                     // a link since deleted is skipped
    ] });
    render(<DeskHome notifications={[]} />);
    const grid = await screen.findByRole('list', { name: 'Favorite links' });
    const names = [...grid.querySelectorAll('.nx-fav-name')].map((n) => n.textContent);
    expect(names).toEqual(['My Bank', ...company.map((l) => l.name)]);   // all ten - no preview, no "All" tile
    expect(screen.getByRole('button', { name: '10 in Links' })).toBeTruthy();
  });

  it('says how to add one when there are none', async () => {
    apiMock.mySignatures.mockResolvedValue([]);
    apiMock.dashKpis.mockResolvedValue({ kpis: {} });
    render(<DeskHome notifications={[]} />);
    expect(await screen.findByText('Bookmark an app in Links and it shows up here.')).toBeTruthy();
  });
});
