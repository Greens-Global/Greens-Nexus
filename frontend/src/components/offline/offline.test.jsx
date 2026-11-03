import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// The offline bar, the per-change state label and the Keep Mine / Use Theirs
// card (field offline, Neil 11/03/2026). The bar says one quiet thing at a
// time: no signal (with the count waiting), signed out (with Sign In),
// something needing a choice, or what is sending (with Sync Now).
const syncNow = vi.fn();
vi.mock('../../lib/offline/status', async (orig) => ({ ...(await orig()), bootOffline: vi.fn(), syncNow: (...a) => syncNow(...a) }));
const handlers = {};
const outbox = { resolveConflict: vi.fn(async () => null), retryEntry: vi.fn(), discardEntry: vi.fn(async () => true), fixEntry: vi.fn(async () => true), kindHandler: (k) => handlers[k] || null };
vi.mock('../../lib/offline/outbox', () => outbox);
vi.mock('../../lib/offline/kinds', () => ({ loadKind: async () => false }));

const status = await import('../../lib/offline/status');
const { default: OfflineBar } = await import('./OfflineBar');
const { default: SyncState } = await import('./SyncState');
const { default: ConflictCard, compareRows } = await import('./ConflictCard');
const { syncWords } = await import('../../lib/offline/useOffline');

const entry = (over = {}) => ({ id: 'e1', kind: 'forms:entry', label: 'Vehicle Check', state: 'parked', createdAt: '2026-11-03T21:14:00.000Z', payload: {}, ...over });

beforeEach(() => {
  status._resetStatus();
  syncNow.mockReset();
  Object.values(outbox).forEach((f) => f.mockClear?.());
});

describe('OfflineBar', () => {
  it('says nothing when online with nothing waiting', () => {
    const { container } = render(<OfflineBar />);
    expect(container.textContent).toBe('');
  });

  it('no signal: the plain-words notice and how many changes wait', () => {
    render(<OfflineBar />);
    act(() => { status._setOnline(false); status.publish({ entries: [entry()], waiting: 1 }); });
    expect(screen.getByRole('status').textContent).toMatch(/Offline - your changes are saved on this phone and will send when you are back online\./);
    expect(screen.getByRole('button', { name: '1 Waiting' })).toBeTruthy();
  });

  it('signed out: says so and offers Sign In', () => {
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [entry()], waiting: 1, signedOut: true }); });
    expect(screen.getByRole('status').textContent).toMatch(/Signed out - sign in when you have signal to send \(1 change waiting\)\./);
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeTruthy();
  });

  it('back online with changes waiting: Sync Now sends them', () => {
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [entry(), entry({ id: 'e2' })], waiting: 2 }); });
    expect(screen.getByRole('status').textContent).toMatch(/Waiting to send 2 changes saved on this phone/);
    fireEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
    expect(syncNow).toHaveBeenCalled();
  });

  it('a conflict or a refusal is named, and Review opens the list', async () => {
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [entry({ state: 'conflict' }), entry({ id: 'e2', state: 'failed', error: 'Odometer: must be a number' })], conflicts: 1, failed: 1 }); });
    expect(screen.getByRole('status').textContent).toMatch(/1 change needs your choice, 1 change not sent/);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    expect(screen.getByText('Odometer: must be a number')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy();
  });

  it('Choose opens the centered Keep Mine / Use Theirs question', async () => {
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [entry({ state: 'conflict', payload: { notes: 'mine' }, server: { notes: 'theirs' } })], conflicts: 1 }); });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose' }));
    expect(await screen.findByText('Keep Mine or Use Theirs?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Mine' }));
    await waitFor(() => expect(outbox.resolveConflict).toHaveBeenCalledWith('e1', 'mine'));
  });
});

describe('OutboxPanel', () => {
  it('a refused change with a kind that can fix it offers Open and Fix', async () => {
    handlers['forms:entry'] = { send: vi.fn(), fix: vi.fn() };
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [entry({ state: 'failed', error: 'Gate Number: required' })], failed: 1 }); });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open and Fix/ }));
    await waitFor(() => expect(outbox.fixEntry).toHaveBeenCalledWith('e1'));
    delete handlers['forms:entry'];
  });

  it('lists changes from another session apart, with Discard only', async () => {
    render(<OfflineBar />);
    act(() => { status.publish({ entries: [], others: [entry({ id: 'o1', state: 'parked', owner: 'crew@greensglobal.com|old-session' })] }); });
    expect(screen.getByRole('status').textContent).toMatch(/1 change from another session is saved on this phone/);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('1 change from another session')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Discard Vehicle Check from another session/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry|Choose|Open and Fix/ })).toBeNull();
  });
});

describe('SyncState', () => {
  it('names each state in Title Case', () => {
    expect(['pending', 'parked', 'sending', 'sent', 'conflict', 'failed'].map((s) => syncWords({ state: s })))
      .toEqual(['Waiting to Send', 'Waiting to Send', 'Sending', 'Sent', 'Needs Your Choice', 'Not Sent']);
    render(<SyncState entry={entry({ state: 'sent' })} />);
    expect(screen.getByText('Sent')).toBeTruthy();
  });

  it('follows a queued change live', () => {
    render(<SyncState id="e1" />);
    act(() => { status.publish({ entries: [entry({ state: 'parked' })], waiting: 1 }); });
    expect(screen.getByText('Waiting to Send')).toBeTruthy();
    act(() => { status.publish({ entries: [entry({ state: 'sent' })], waiting: 0 }); });
    expect(screen.getByText('Sent')).toBeTruthy();
  });
});

describe('ConflictCard', () => {
  const conflict = () => entry({ state: 'conflict', payload: { notes: 'Gate fixed', crewSize: 4, same: 1 }, server: { notes: 'Gate still stuck', crewSize: 4, same: 1 } });

  it('shows what differs side by side; without the kind\'s useTheirs there is no Use Theirs', () => {
    const e = conflict();
    expect(compareRows(e)).toEqual([{ label: 'Notes', mine: 'Gate fixed', theirs: 'Gate still stuck' }]);
    render(<ConflictCard entry={e} title="Daily Log" onChoose={vi.fn()} onClose={() => {}} />);
    expect(screen.getByText('Gate still stuck')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Use Theirs/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep Mine' })).toBeTruthy();
  });

  it('Use Theirs drops the change, so it is held (HOLD_RECORD_MS), never a plain click', async () => {
    vi.useFakeTimers();
    try {
      const onChoose = vi.fn(async () => {});
      render(<ConflictCard entry={conflict()} handler={{ useTheirs: vi.fn() }} title="Daily Log" onChoose={onChoose} onClose={() => {}} />);
      const hold = screen.getByRole('button', { name: /Use Theirs/ });
      fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(onChoose).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
      expect(onChoose).toHaveBeenCalledWith('theirs');
    } finally { vi.useRealTimers(); }
  });
});
