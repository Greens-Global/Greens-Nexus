// Customize on the Dashboard (11/17/2026):
//   - Delete View is a hold in the shared dialog, and "View deleted" shows
//     only after a real delete (Cancel used to show it too);
//   - discarding unsaved layout changes asks through the shared dialog, never
//     window.confirm;
//   - an unsaved layout is registered with the app's leave guard, so a tab, a
//     sidebar module or a reload asks before dropping it;
//   - saved views that did not load are said, with Try Again.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myEmail: 'neil@greensglobal.com', myGrantedModules: new Set(), canAccessModule: () => false, timeTrackingExempt: false }) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ notifications: [], markRead: vi.fn(), markAllRead: vi.fn(), dismiss: vi.fn(), clearRead: vi.fn() }) }));
const d = vi.hoisted(() => ({}));
vi.mock('./useDashboards', () => ({ useDashboards: () => d, resolveCollisions: (x) => x }));
vi.mock('./widgets.jsx', () => ({ WIDGETS: {}, widgetAllowed: () => true, widgetHidden: () => false, limitsOf: () => ({}) }));
vi.mock('./DashboardGrid', () => ({ default: () => <div>grid</div> }));
vi.mock('./WidgetGallery', () => ({ WidgetGallery: () => null, ConfigModal: () => null }));
vi.mock('./DeskHome', () => ({
  default: ({ headerRight, headerMenu }) => <div>{headerRight}{headerMenu}</div>,
  DeskGreeting: ({ right, menu }) => <div>{right}{menu}</div>,
}));

import CustomDashboard from './CustomDashboard';
import { hasUnsavedWork } from '../lib/dialogGuard';

const VIEW = { id: 'v1', name: 'Ops', scope: 'personal', isDefault: false, createdBy: 'neil@greensglobal.com' };

beforeEach(() => {
  confirm.mockReset();
  Object.assign(d, {
    views: [VIEW], activeId: 'v1', activeView: VIEW, layout: [], kpis: {}, department: '', canPublish: false,
    dirty: false, loading: false, editing: false, viewsError: false, kpisError: null,
    setEditing: vi.fn(), setLayout: vi.fn(), switchView: vi.fn(), cancelEdit: vi.fn(), reload: vi.fn(), reloadKpis: vi.fn(),
    removeView: vi.fn(async () => {}), save: vi.fn(async () => {}),
  });
});
afterEach(() => cleanup());

const openDelete = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete View' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
};

describe('Delete View', () => {
  it('asks with a hold in the shared dialog; Cancel deletes nothing and shows no toast', async () => {
    confirm.mockResolvedValue(false);
    render(<CustomDashboard />);
    await openDelete();
    const [msg, opts] = confirm.mock.calls[0];
    expect(msg).toBe('Delete "Ops"? This can\'t be undone.');
    expect(opts).toMatchObject({ hold: true, confirmText: 'Delete View' });
    expect(typeof opts.onConfirm).toBe('function');
    await new Promise((r) => setTimeout(r, 20));
    expect(d.removeView).not.toHaveBeenCalled();
    expect(screen.queryByText('View deleted')).toBeNull();
  });

  it('"View deleted" follows a real delete', async () => {
    confirm.mockImplementation(async (_msg, opts) => { await opts.onConfirm(); return true; });
    render(<CustomDashboard />);
    await openDelete();
    await waitFor(() => expect(d.removeView).toHaveBeenCalledWith('v1'));
    expect(await screen.findByText('View deleted')).toBeTruthy();
  });

  it('a delete the server refused shows no "View deleted" (the dialog keeps the reason)', async () => {
    d.removeView = vi.fn(async () => { throw new Error('Not yours to delete'); });
    confirm.mockImplementation(async (_msg, opts) => { await opts.onConfirm().catch(() => {}); return false; });
    render(<CustomDashboard />);
    await openDelete();
    await waitFor(() => expect(d.removeView).toHaveBeenCalled());
    expect(screen.queryByText('View deleted')).toBeNull();
  });
});

describe('Unsaved layout changes', () => {
  it('Done asks through the shared dialog; Keep Editing stays, Discard leaves', async () => {
    Object.assign(d, { editing: true, dirty: true });
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CustomDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][1]).not.toHaveProperty('hold');
    expect(d.cancelEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(d.cancelEdit).toHaveBeenCalledTimes(1));
  });

  it('nothing changed: Done leaves without asking', async () => {
    Object.assign(d, { editing: true, dirty: false });
    render(<CustomDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(d.cancelEdit).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('is registered with the leave guard while dirty, and taken off when the board goes', () => {
    expect(hasUnsavedWork()).toBe(false);
    Object.assign(d, { editing: true, dirty: true });
    const { unmount } = render(<CustomDashboard />);
    expect(hasUnsavedWork()).toBe(true);
    unmount();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('a layout with nothing unsaved is not guarded', () => {
    Object.assign(d, { editing: true, dirty: false });
    render(<CustomDashboard />);
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe('Saved views that did not load', () => {
  it('says so and offers Try Again', () => {
    Object.assign(d, { views: [], activeId: null, activeView: null, viewsError: true });
    render(<CustomDashboard />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your saved views.");
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});
