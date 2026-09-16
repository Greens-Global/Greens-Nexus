// The failure this module exists for: a BOD/EOD message is one POST from the
// browser, and api.js never retries a mutation - so one dropped request on a
// phone lost the message outright (no row, nothing for the server to retry)
// while the punch seconds later went through (Amy and Vicki, 09/16/2026).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const timeBodRecord = vi.fn();
vi.mock('../api', () => ({ api: { timeBodRecord: (...a) => timeBodRecord(...a) } }));

const { bodDurable, replayPendingBods, readPendingBods, clearPendingBods } = await import('./bodQueue');

const netErr = () => new Error('Failed to fetch');                 // no .status - unknown outcome
const httpErr = (status, message = 'nope') => Object.assign(new Error(message), { status });

beforeEach(() => {
  clearPendingBods();
  timeBodRecord.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
const run = async (fn) => { const p = fn(); await vi.runAllTimersAsync(); return p; };

describe('bodDurable', () => {
  it('retries a POST the network dropped, with the same id each time', async () => {
    timeBodRecord.mockRejectedValueOnce(netErr()).mockResolvedValueOnce({ ok: true, queued: true });
    const r = await run(() => bodDurable({ kind: 'bod', message: 'hi', html: '<b>hi</b>' }));
    expect(r.ok).toBe(true);
    expect(timeBodRecord).toHaveBeenCalledTimes(2);
    expect(timeBodRecord.mock.calls[0][0].id).toBe(timeBodRecord.mock.calls[1][0].id);
    expect(readPendingBods()).toEqual([]);
  });

  it('parks the message when every attempt ends unknown', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    const r = await run(() => bodDurable({ kind: 'bod', message: 'hi', html: '<b>hi</b>' }));
    expect(r.ok).toBe(false);
    expect(r.unreachable).toBe(true);
    expect(r.queued).toBe(true);
    expect(timeBodRecord).toHaveBeenCalledTimes(3);
    const parked = readPendingBods();
    expect(parked).toHaveLength(1);
    expect(parked[0].body.message).toBe('hi');
    expect(parked[0].id).toBe(r.id);
  });

  it('treats a 5xx like no answer (it may have committed - the id makes the retry safe)', async () => {
    timeBodRecord.mockRejectedValueOnce(httpErr(502)).mockResolvedValueOnce({ ok: true, duplicate: true });
    const r = await run(() => bodDurable({ kind: 'eod', message: 'bye', html: 'x' }));
    expect(r.ok).toBe(true);
    expect(timeBodRecord).toHaveBeenCalledTimes(2);
  });

  it('never parks a message the server refused', async () => {
    timeBodRecord.mockRejectedValue(httpErr(403, 'Forbidden'));
    const r = await run(() => bodDurable({ kind: 'bod', message: 'hi', html: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.unreachable).toBeUndefined();
    expect(timeBodRecord).toHaveBeenCalledTimes(1);
    expect(readPendingBods()).toEqual([]);
  });
});

describe('replayPendingBods', () => {
  it('sends parked messages with their original id and clears them', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    await run(() => bodDurable({ kind: 'bod', message: 'first', html: 'x' }));
    await run(() => bodDurable({ kind: 'eod', message: 'second', html: 'y' }));
    expect(readPendingBods()).toHaveLength(2);
    const ids = readPendingBods().map(p => p.id);
    timeBodRecord.mockReset();
    timeBodRecord.mockResolvedValue({ ok: true, queued: true });
    const r = await replayPendingBods();
    expect(r).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(timeBodRecord.mock.calls.map(c => c[0].id)).toEqual(ids);
    expect(readPendingBods()).toEqual([]);
  });

  it('keeps a message parked while the server is still unreachable', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    await run(() => bodDurable({ kind: 'bod', message: 'hi', html: 'x' }));
    const r = await replayPendingBods();
    expect(r).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(readPendingBods()).toHaveLength(1);
  });

  it('drops a message the server refuses on replay', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    await run(() => bodDurable({ kind: 'bod', message: 'hi', html: 'x' }));
    timeBodRecord.mockReset();
    timeBodRecord.mockRejectedValue(httpErr(400, 'bad'));
    const r = await replayPendingBods();
    expect(r).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    expect(readPendingBods()).toEqual([]);
  });

  it('drops a message older than the server would still deliver', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    await run(() => bodDurable({ kind: 'bod', message: 'old', html: 'x' }));
    const stale = readPendingBods().map(p => ({ ...p, queued_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString() }));
    localStorage.setItem('nexus:pendingBods', JSON.stringify(stale));
    timeBodRecord.mockReset();
    const r = await replayPendingBods();
    expect(r).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    expect(timeBodRecord).not.toHaveBeenCalled();
  });

  it('shares one in-flight replay between callers', async () => {
    timeBodRecord.mockRejectedValue(netErr());
    await run(() => bodDurable({ kind: 'bod', message: 'hi', html: 'x' }));
    timeBodRecord.mockReset();
    timeBodRecord.mockResolvedValue({ ok: true });
    const [a, b] = await Promise.all([replayPendingBods(), replayPendingBods()]);
    expect(a).toBe(b);
    expect(timeBodRecord).toHaveBeenCalledTimes(1);
  });
});
