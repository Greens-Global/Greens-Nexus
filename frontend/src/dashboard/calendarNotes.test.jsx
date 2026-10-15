// Calendar agenda + Notes (Oct 14 widget pass).
//  - The agenda used to crop a long day with no way to tell: the list sat in
//    a flex-wrap row whose line grew to the content, so its own scroller never
//    got a height. jsdom has no layout, so this pins the structure that makes
//    the bound work - the panes never wrap, and the agenda list is a bounded
//    flex:1/minHeight:0 scroller - plus the count that says how much is there.
//  - Notes used to go through the layout's unsaved-changes flag, which has no
//    Save button outside Customize, so typed text was lost on reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  dashAgenda: vi.fn(),
  dashBirthdays: vi.fn(async () => ({ birthdays: [] })),
  dashHolidays: vi.fn(async () => ({ holidays: [] })),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ openPanel: vi.fn(), sendOverdueAlert: vi.fn() }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', can: () => true }) }));
vi.mock('../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [], hwAssets: [] }) }));
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => ({ requests: [] }) }));
vi.mock('../components/TimeAdmin', () => ({ default: () => null }));

import { CalendarPanel } from './panels.jsx';
import { WIDGETS } from './widgets.jsx';

const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const events = Array.from({ length: 9 }, (_, i) => ({
  subject: `Meeting ${i + 1}`, start: `${day}T${String(8 + i).padStart(2, '0')}:00:00`, end: `${day}T${String(8 + i).padStart(2, '0')}:30:00`,
}));

describe('Calendar agenda', () => {
  beforeEach(() => { apiMock.dashAgenda.mockResolvedValue({ available: true, events }); });

  it('lists every event for the day in a bounded scroller and says how many there are', async () => {
    render(<CalendarPanel />);
    expect(await screen.findByText('Meeting 9')).toBeTruthy();
    expect(screen.getByText('9 items')).toBeTruthy();
    const list = screen.getByLabelText('My Agenda');
    expect(list.className).toContain('dash-scroll');
    expect(list.style.flex).toMatch(/^1/);
    expect(list.style.minHeight).toMatch(/^0(px)?$/);
    // The panes' row never wraps (the old flex-wrap row grew to the content).
    const box = list.parentElement.parentElement;
    expect(box.style.flexWrap).toBe('');
    expect(box.style.height).toBe('100%');
  });

  it('stacks the agenda under a full-width month grid on a phone', async () => {
    render(<CalendarPanel phone />);
    const list = await screen.findByLabelText('My Agenda');
    expect(list.parentElement.parentElement.style.flexDirection).toBe('column');
    expect(await screen.findByText('Meeting 1')).toBeTruthy();
  });

  it('gives the stacked phone tile room for the agenda, and the old My Agenda alias the same bounds', () => {
    expect(WIDGETS.calendar.phoneRowsWhen()).toBeGreaterThan(WIDGETS.calendar.size.h);
    expect(WIDGETS.agenda.limits).toEqual(WIDGETS.calendar.limits);
  });
});

describe('Notes', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const Notes = WIDGETS.notes.render;

  it('saves on its own shortly after typing stops, not through the layout', async () => {
    const saveConfig = vi.fn(async () => {});
    const updateConfig = vi.fn();
    render(<Notes config={{ text: '' }} saveConfig={saveConfig} canSaveConfig updateConfig={updateConfig} />);
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Call the plumber' } });
    expect(saveConfig).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(saveConfig).toHaveBeenCalledWith({ text: 'Call the plumber' });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('does not save (or mark anything changed) when the text did not change', async () => {
    const saveConfig = vi.fn(async () => {});
    render(<Notes config={{ text: 'Same' }} saveConfig={saveConfig} canSaveConfig />);
    fireEvent.blur(screen.getByLabelText('Notes'));
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('says so when the note is waiting on the layout Save (Customize), instead of "Saved"', async () => {
    const saveConfig = vi.fn(async () => ({ deferred: true }));
    render(<Notes config={{ text: '' }} saveConfig={saveConfig} canSaveConfig />);
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Draft' } });
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(screen.getByText(/when you press Save/)).toBeTruthy();
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('saves the last words when the tile goes away inside the debounce', async () => {
    const saveConfig = vi.fn(async () => {});
    const { unmount } = render(<Notes config={{ text: '' }} saveConfig={saveConfig} canSaveConfig />);
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Last words' } });
    unmount();
    expect(saveConfig).toHaveBeenCalledWith({ text: 'Last words' });
  });

  it('is read-only on a view this person cannot change, and says why', () => {
    render(<Notes config={{ text: 'Team note' }} saveConfig={vi.fn()} canSaveConfig={false} />);
    expect(screen.getByLabelText('Notes').readOnly).toBe(true);
    expect(screen.getByText(/save a copy as your own/)).toBeTruthy();
  });
});
