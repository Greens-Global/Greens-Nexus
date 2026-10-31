// Workflows > Workflows, Delete on a row (Hold to confirm, Neil, Oct 30 2026):
// one workflow, so the row's Delete is held with no dialog first; a refusal
// rewinds the button with the reason; a click with no press behind it (a
// screen reader) asks with the ordinary dialog.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

const api = {
  wfList: vi.fn(),
  wfDelete: vi.fn(() => Promise.resolve({})),
  wfStatus: vi.fn(() => Promise.resolve({})),
  wfDuplicate: vi.fn(() => Promise.resolve({})),
  wfCreate: vi.fn(() => Promise.resolve({})),
};
vi.mock('../api', () => ({ api }));
vi.mock('./lib/useCatalog', () => ({ useCatalog: () => ({ catalog: null }) }));
vi.mock('./lib/text', () => ({ describeTrigger: () => 'When something happens' }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => true }) }));
const dialog = { confirm: vi.fn(() => Promise.resolve(true)), alert: vi.fn(() => Promise.resolve()), undo: vi.fn() };
vi.mock('../ui/dialog', () => ({ dialog }));

const { default: WorkflowList } = await import('./WorkflowList');

const rows = [
  { id: 'w1', name: 'Welcome Note', status: 'active', ownerName: 'Neil Kadakia', runs7d: 2 },
  { id: 'w2', name: 'Exit Checklist', status: 'paused', ownerName: 'Neil Kadakia', runs7d: 0 },
];
const deleteFor = () => screen.getAllByRole('button', { name: 'Delete, press and hold' })[0];

beforeEach(() => {
  vi.clearAllMocks();
  api.wfList.mockImplementation(() => Promise.resolve(rows.map((r) => ({ ...r }))));
});
afterEach(() => { vi.useRealTimers(); });

describe('WorkflowList Delete', () => {
  it('deletes on a full hold, with no dialog, and the row leaves', async () => {
    render(<WorkflowList go={vi.fn()} />);
    await screen.findByText('Welcome Note');
    vi.useFakeTimers();
    fireEvent.pointerDown(deleteFor(), { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(api.wfDelete).toHaveBeenCalledWith('w1');
    expect(dialog.confirm).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(screen.queryByText('Welcome Note')).toBeNull();
    expect(screen.getByText('Exit Checklist')).toBeTruthy();
  });

  it('letting go early deletes nothing', async () => {
    render(<WorkflowList go={vi.fn()} />);
    await screen.findByText('Welcome Note');
    vi.useFakeTimers();
    fireEvent.pointerDown(deleteFor(), { button: 0, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(deleteFor(), { pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(api.wfDelete).not.toHaveBeenCalled();
  });

  it('a refusal rewinds the button with the reason and keeps the row', async () => {
    api.wfDelete.mockRejectedValueOnce(new Error('Only the owner may delete this workflow'));
    render(<WorkflowList go={vi.fn()} />);
    await screen.findByText('Welcome Note');
    vi.useFakeTimers();
    fireEvent.pointerDown(deleteFor(), { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(screen.getByRole('alert')).toHaveTextContent('Only the owner may delete this workflow');
    expect(screen.getByText('Welcome Note')).toBeTruthy();
  });

  it('a click with no press (a screen reader) asks with the ordinary dialog', async () => {
    render(<WorkflowList go={vi.fn()} />);
    await screen.findByText('Welcome Note');
    await act(async () => { fireEvent.click(deleteFor()); });
    await act(async () => {});
    expect(dialog.confirm).toHaveBeenCalledWith(expect.stringContaining('Delete "Welcome Note" for good?'), expect.objectContaining({ danger: true }));
    expect(api.wfDelete).toHaveBeenCalledWith('w1');
  });
});
