// The shared /timeclock/status read: however many screens watch it, it is one
// request per poll, re-read once on a punch, and a failed refresh keeps the
// last good answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ timeStatus: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
const pollMock = vi.hoisted(() => ({ calls: [], stops: 0 }));
vi.mock('./pollWhileVisible', () => ({
  pollWhileVisible: (fn, ms) => { pollMock.calls.push({ fn, ms }); return () => { pollMock.stops += 1; }; },
}));

import { useTimeStatus, patchTimeStatus, withPunch, applyPunch } from './useTimeStatus';

function Watcher({ name, pollMs }) {
  const { status, failed } = useTimeStatus({ pollMs });
  return <div>{name}: {failed ? 'failed' : status ? status.lastPunch.kind : 'pending'}</div>;
}
const answer = (kind) => ({ lastPunch: { kind } });

beforeEach(() => {
  apiMock.timeStatus.mockReset();
  pollMock.calls.length = 0;
  pollMock.stops = 0;
});

describe('useTimeStatus', () => {
  it('three watchers mounting together make one request and all show its answer', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    render(<><Watcher name="a" /><Watcher name="b" /><Watcher name="c" /></>);
    expect(await screen.findByText('a: in')).toBeTruthy();
    expect(screen.getByText('b: in')).toBeTruthy();
    expect(screen.getByText('c: in')).toBeTruthy();
    expect(apiMock.timeStatus).toHaveBeenCalledTimes(1);
  });

  it('a punch (nexus:timeclock-changed) is one re-read that every watcher repaints from', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    render(<><Watcher name="a" /><Watcher name="b" /></>);
    await screen.findByText('a: in');
    apiMock.timeStatus.mockResolvedValue(answer('out'));
    act(() => { window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); });
    expect(await screen.findByText('a: out')).toBeTruthy();
    expect(screen.getByText('b: out')).toBeTruthy();
    expect(apiMock.timeStatus).toHaveBeenCalledTimes(2);
  });

  it('runs ONE poll at the fastest pace asked for, and stops it when the last poller leaves', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    const { rerender } = render(<><Watcher name="a" pollMs={25000} /><Watcher name="b" /></>);
    await screen.findByText('a: in');
    expect(pollMock.calls.map(c => c.ms)).toEqual([25000]);
    rerender(<><Watcher name="a" pollMs={25000} /><Watcher name="b" pollMs={20000} /></>);
    expect(pollMock.calls.map(c => c.ms)).toEqual([25000, 20000]);
    expect(pollMock.stops).toBe(1);                       // the 25s timer was replaced, not added to
    // A tick of the shared poll is one request for both.
    const before = apiMock.timeStatus.mock.calls.length;
    await act(async () => { await pollMock.calls[1].fn(); });
    expect(apiMock.timeStatus.mock.calls.length).toBe(before + 1);
    rerender(<><Watcher name="a" /><Watcher name="b" /></>);
    expect(pollMock.stops).toBe(2);
    expect(pollMock.calls.length).toBe(2);
  });

  it('a failed refresh keeps the last answer; a first load that fails reads as failed', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    const first = render(<Watcher name="a" />);
    await screen.findByText('a: in');
    apiMock.timeStatus.mockRejectedValue(new Error('down'));
    act(() => { window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); });
    await waitFor(() => expect(apiMock.timeStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText('a: in')).toBeTruthy();
    first.unmount();
  });

  it('reads as failed when it has never answered', async () => {
    apiMock.timeStatus.mockRejectedValue(new Error('down'));
    render(<Watcher name="a" />);
    expect(await screen.findByText('a: failed')).toBeTruthy();
  });

  it('withPunch folds an accepted punch in: last punch, next allowed, the punch on its day', () => {
    const before = { lastPunch: { kind: 'in', at: '2026-10-14T15:00:00', localDate: '2026-10-14' }, allowed: ['out', 'break_start'], bodRequired: false,
      days: { '2026-10-14': { workedMin: 0, punches: [{ kind: 'in', at: '2026-10-14T15:00:00', localDate: '2026-10-14' }] } } };
    const punch = { kind: 'break_start', at: '2026-10-14T16:00:00', localDate: '2026-10-14' };
    const after = withPunch(before, punch);
    expect(after.lastPunch).toBe(punch);
    expect(after.allowed).toEqual(['break_end', 'out']);
    expect(after.days['2026-10-14'].punches.map(p => p.kind)).toEqual(['in', 'break_start']);
    expect(before.days['2026-10-14'].punches.length).toBe(1);             // the old answer is untouched
    // A first punch of the day makes the day; a clock-in settles the day message.
    const fresh = withPunch({ lastPunch: { kind: 'out', at: '2026-10-13T23:00:00' }, bodRequired: true, days: {} }, { kind: 'in', at: '2026-10-14T15:00:00', localDate: '2026-10-14' });
    expect(fresh.days['2026-10-14'].punches.length).toBe(1);
    expect(fresh.bodRequired).toBe(false);
    expect(withPunch(null, punch)).toBeNull();
    expect(withPunch(before, {})).toBe(before);
  });

  it('applyPunch flips every watcher before any re-read', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    render(<><Watcher name="a" /><Watcher name="b" /></>);
    await screen.findByText('a: in');
    act(() => { applyPunch({ kind: 'out', at: '2026-10-14T20:00:00', localDate: '2026-10-14' }); });
    expect(await screen.findByText('b: out')).toBeTruthy();
    expect(apiMock.timeStatus).toHaveBeenCalledTimes(1);
  });

  it('patchTimeStatus touches up the shared answer for every watcher', async () => {
    apiMock.timeStatus.mockResolvedValue(answer('in'));
    render(<><Watcher name="a" /><Watcher name="b" /></>);
    await screen.findByText('a: in');
    act(() => { patchTimeStatus(() => answer('break_start')); });
    expect(await screen.findByText('b: break_start')).toBeTruthy();
  });
});
