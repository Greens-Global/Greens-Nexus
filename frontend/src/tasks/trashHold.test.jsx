import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Hold to confirm in Tasks (Neil, Oct 30 2026). Recycle Bin: Delete Forever
// on one item is a row hold; a project that took tasks with it, and the bulk
// Delete Forever, ask in a dialog whose confirm is a HOLD_MAJOR_MS hold.
// Delete Project: the modal's Delete Project is the hold, with an Undo.
const api = vi.hoisted(() => ({ getRecycleBin: vi.fn(), purgeRecycleItem: vi.fn(), restoreRecycleItem: vi.fn() }));
vi.mock('../api', () => ({ api }));

const { DeletedTasksTab } = await import('./ManageView');
const { DeleteProjectModal } = await import('./ProjectsView');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_MAJOR_MS, HOLD_RECORD_MS } = await import('../ui/HoldButton');

const ROWS = [
  { kind: 'task', id: 't1', name: 'Order Panels', detail: 'Solar Farm', deletedAt: '2026-10-28T10:00:00Z', deletedBy: 'a@x.com', purgeAt: '' },
  { kind: 'project', id: 'p1', name: 'Solar Farm', detail: '12 tasks binned with it', deletedAt: '2026-10-27T10:00:00Z', deletedBy: 'a@x.com', purgeAt: '' },
];
const store = { nameOf: (e) => e, refresh: vi.fn() };
const press = (el) => fireEvent.pointerDown(el, { button: 0, pointerId: 1 });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getRecycleBin.mockResolvedValue(ROWS);
  api.purgeRecycleItem.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('Recycle Bin Delete Forever', () => {
  it('one task holds on its row and leaves the list once deleted', async () => {
    render(<><DialogHost /><DeletedTasksTab store={store} /></>);
    const btn = await screen.findByRole('button', { name: 'Delete Order Panels forever, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(api.purgeRecycleItem).toHaveBeenCalledTimes(1);
    expect(api.purgeRecycleItem).toHaveBeenCalledWith('task', 't1');
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(screen.queryByText('Order Panels')).toBeNull();
  });

  it('a project with tasks asks in a dialog that names them, then holds there', async () => {
    render(<><DialogHost /><DeletedTasksTab store={store} /></>);
    await screen.findByText('Order Panels');
    const projectRow = screen.getAllByTitle('Delete Forever').find((b) => b.tagName === 'BUTTON');
    await act(async () => { fireEvent.click(projectRow); });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Delete Project Forever?')).toBeTruthy();
    expect(within(dlg).getByText(/"Solar Farm" is deleted for good, and its 12 tasks binned with it go too/)).toBeTruthy();
    vi.useFakeTimers();
    press(within(dlg).getByRole('button', { name: 'Delete Forever, press and hold' }));
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(api.purgeRecycleItem).toHaveBeenCalledTimes(1);
    expect(api.purgeRecycleItem).toHaveBeenCalledWith('project', 'p1');
  });

  it('the bulk Delete Forever asks first, holds, and runs each item once', async () => {
    render(<><DialogHost /><DeletedTasksTab store={store} /></>);
    await screen.findByText('Order Panels');
    fireEvent.click(screen.getByTitle('Select all'));
    const bulk = screen.getAllByRole('button', { name: 'Delete Forever' }).find((b) => b.textContent.includes('Delete Forever'));
    await act(async () => { fireEvent.click(bulk); });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Delete 2 Items Forever?')).toBeTruthy();
    expect(within(dlg).getByText(/The project "Solar Farm" is one of them - its 12 tasks binned with it go too/)).toBeTruthy();
    expect(api.purgeRecycleItem).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Delete Forever, press and hold' })); });
    expect(api.purgeRecycleItem).toHaveBeenCalledTimes(2);
  });
});

describe('Delete Project', () => {
  it('holds for HOLD_MAJOR_MS, then closes and offers Undo through the Recycle Bin restore', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const undo = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue({ undo, undoMessage: 'Solar Farm moved to the Recycle Bin.' });
    render(<><DialogHost /><DeleteProjectModal state={{ project: { id: 'p1', name: 'Solar Farm' } }} onConfirm={onConfirm} onClose={onClose} /></>);
    expect(screen.getByText(/move to the Recycle Bin and disappear for everyone working in it/)).toBeTruthy();
    press(screen.getByRole('button', { name: 'Delete Project, press and hold' }));
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS - 300); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
