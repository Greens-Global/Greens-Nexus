import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TrashPanel } from './PortfolioPanels.jsx';
import { HOLD_MAJOR_MS } from '../../../ui/HoldButton';

// Delete Forever in the asset Trash (Neil, Oct 30 2026 - hold to confirm):
// the inline ask names how many records go with the asset, and its confirm
// is a HOLD_MAJOR_MS hold. The user's own purge from the Trash only.
afterEach(() => { vi.useRealTimers(); });

describe('Asset Trash Delete Forever', () => {
  it('names the records and purges once on a full hold, never on a short one', async () => {
    const onPurge = vi.fn();
    const deleted = [{ id: 'a1', name: 'Oak Street Lot', city: 'Austin', state: 'TX' }];
    render(<TrashPanel deleted={deleted} onRecover={vi.fn()} onPurge={onPurge} onClose={vi.fn()} recordsOf={() => 7} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Oak Street Lot permanently' }));
    expect(screen.getByText('Permanently delete "Oak Street Lot"?')).toBeTruthy();
    expect(screen.getByText(/its 7 records \(warranties, inspections, documents, maintenance and the rest\) are gone for good/)).toBeTruthy();

    vi.useFakeTimers();
    const hold = screen.getByRole('button', { name: 'Delete Oak Street Lot forever, press and hold' });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS / 2); });
    fireEvent.pointerUp(hold, { pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(onPurge).not.toHaveBeenCalled();

    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(onPurge).toHaveBeenCalledTimes(1);
    expect(onPurge).toHaveBeenCalledWith('a1');
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(screen.queryByText('Permanently delete "Oak Street Lot"?')).toBeNull();
  });
});
