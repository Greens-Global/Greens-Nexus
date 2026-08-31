// The failure this module exists for: the Teams message goes out BEFORE the
// punch and is delivered server-side with its own retry, so a phone that blipped
// for one second left the employee looking at a message saying they were back
// from lunch while Nexus had no punch at all. Everything here is about the punch
// surviving that, and - just as important - never landing twice or landing at
// the wrong time when it does survive.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const timePunch = vi.fn();
const timeStatus = vi.fn();
const timeSelfPunch = vi.fn();
vi.mock('../api', () => ({ api: {
  timePunch: (...a) => timePunch(...a),
  timeStatus: (...a) => timeStatus(...a),
  timeSelfPunch: (...a) => timeSelfPunch(...a),
} }));

const { punchDurable, replayPending, readPending, clearPending } = await import('./punchQueue');

const netErr = () => new Error('Failed to fetch');                 // no .status - unknown outcome
const httpErr = (status, message = 'nope') => Object.assign(new Error(message), { status });
const iso = (d) => new Date(d).toISOString().slice(0, 19);

// The retry backoff is real time. Drive it with fake timers so the suite proves
// the retry happened without spending seconds waiting for it.
beforeEach(() => {
  clearPending();
  timePunch.mockReset(); timeStatus.mockReset(); timeSelfPunch.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
const run = async (fn) => { const p = fn(); await vi.runAllTimersAsync(); return p; };

describe('punchDurable', () => {
  it('retries a punch the network dropped instead of losing it', async () => {
    timePunch.mockRejectedValueOnce(netErr()).mockResolvedValueOnce({ punch: { id: 'p1', kind: 'break_end' } });
    const r = await run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420 }));
    expect(r.ok).toBe(true);
    expect(timePunch).toHaveBeenCalledTimes(2);
    expect(readPending()).toBeNull();
  });

  it('parks the punch, with the time it was MEANT for, once retries run out', async () => {
    timePunch.mockRejectedValue(netErr());
    timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_start' }, allowed: ['break_end', 'out'] });
    const r = await run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420, clickedAt: '2026-08-29T20:31:45' }));
    expect(r.ok).toBe(false);
    expect(r.queued).toBe(true);
    expect(readPending()).toMatchObject({ kind: 'break_end', at: '2026-08-29T20:31:45' });
  });

  it('does not park a punch that actually committed behind a 5xx', async () => {
    timePunch.mockRejectedValue(httpErr(502));
    timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_end', at: '2026-08-29T20:31:45' }, allowed: ['out'] });
    const r = await run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420 }));
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(true);
    expect(readPending()).toBeNull();
  });

  it('never parks a punch the server REFUSED - that one is wrong, not missing', async () => {
    timePunch.mockRejectedValue(httpErr(400, 'kind must be one of ...'));
    const r = await run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420 }));
    expect(r.ok).toBe(false);
    expect(r.queued).toBeUndefined();
    expect(timePunch).toHaveBeenCalledTimes(1);      // a 400 is an answer, not a blip
    expect(readPending()).toBeNull();
  });

  it('reads a 409 as "our own earlier attempt landed" only when the state agrees', async () => {
    timePunch.mockRejectedValue(httpErr(409, "Duplicate punch - you just did that."));
    timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_end' }, allowed: ['out'] });
    await expect(run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420 }))).resolves.toMatchObject({ ok: true });

    timeStatus.mockResolvedValue({ lastPunch: { kind: 'out' }, allowed: ['in'] });
    await expect(run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420 }))).resolves.toMatchObject({ ok: false });
  });
});

describe('replayPending', () => {
  const park = async (at) => {
    timePunch.mockRejectedValue(netErr());
    timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_start' }, allowed: ['break_end', 'out'] });
    await run(() => punchDurable({ kind: 'break_end', tzOffsetMin: 420, clickedAt: at }));
    timePunch.mockReset(); timeStatus.mockReset();
  };

  it('replays inside the 15-minute window as a normal punch at the ORIGINAL time', async () => {
    const at = iso(Date.now() - 3 * 60000);
    await park(at);
    timeStatus.mockResolvedValue({ allowed: ['break_end', 'out'] });
    timePunch.mockResolvedValue({ punch: { id: 'p9', at } });
    const r = await run(() => replayPending());
    expect(r.restored).toBe(true);
    expect(timePunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'break_end', clicked_at: at }));
    expect(readPending()).toBeNull();
  });

  it('backfills past the window, so the recorded time is still the real one', async () => {
    const at = iso(Date.now() - 40 * 60000);
    await park(at);
    timeStatus.mockResolvedValue({ allowed: ['break_end', 'out'] });
    timeSelfPunch.mockResolvedValue({ id: 'p9', at });
    const r = await run(() => replayPending());
    expect(r.restored).toBe(true);
    expect(r.backfilled).toBe(true);
    expect(timePunch).not.toHaveBeenCalled();
    expect(timeSelfPunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'break_end', at }));
  });

  it('drops a parked punch the employee already redid on another device', async () => {
    // Exactly Beth's Aug 29: the phone punch was parked, then she ended the break
    // again from her desktop. Replaying it would double-punch the break end.
    await park(iso(Date.now() - 3 * 60000));
    timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_end' }, allowed: ['out', 'break_start'] });
    const r = await run(() => replayPending());
    expect(r).toMatchObject({ dropped: true, stale: true });
    expect(timePunch).not.toHaveBeenCalled();
    expect(timeSelfPunch).not.toHaveBeenCalled();
    expect(readPending()).toBeNull();
  });

  it('keeps the punch parked while the server is still unreachable', async () => {
    await park(iso(Date.now() - 3 * 60000));
    timeStatus.mockRejectedValue(netErr());
    expect(await run(() => replayPending())).toBeNull();
    expect(readPending()).not.toBeNull();

    // and it survives a send that fails the same way, rather than vanishing
    timeStatus.mockResolvedValue({ allowed: ['break_end', 'out'] });
    timePunch.mockRejectedValue(netErr());
    expect(await run(() => replayPending())).toBeNull();
    expect(readPending()).not.toBeNull();
  });

  it('stops carrying a punch the server can no longer place', async () => {
    await park(iso(Date.now() - 40 * 60000));
    timeStatus.mockResolvedValue({ allowed: ['break_end', 'out'] });
    timeSelfPunch.mockRejectedValue(httpErr(400, 'Older than 7 days - ask a manager to add it.'));
    const r = await run(() => replayPending());
    expect(r.dropped).toBe(true);
    expect(r.error.message).toMatch(/Older than 7 days/);
    expect(readPending()).toBeNull();
  });

  it('sends once when the page and the mini-timer both replay on load', async () => {
    await park(iso(Date.now() - 3 * 60000));
    timeStatus.mockResolvedValue({ allowed: ['break_end', 'out'] });
    timePunch.mockResolvedValue({ punch: { id: 'p9' } });
    const [a, b] = await run(() => Promise.all([replayPending(), replayPending()]));
    expect(timePunch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});
