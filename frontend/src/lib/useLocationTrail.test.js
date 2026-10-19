import { describe, it, expect, vi, beforeEach } from 'vitest';

// Location Trail While Clocked In (Oct 20 2026): the web ping hook sends
// nothing when the switch is off, on a break, when not clocked in, or without
// location permission, and two tabs never both ping in one round.
const getPosition = vi.fn();
vi.mock('./geoPosition', () => ({ getPosition: (...a) => getPosition(...a) }));
const locationPermission = vi.fn();
vi.mock('./punchLocation', () => ({ locationPermission: (...a) => locationPermission(...a) }));
vi.mock('../api', () => ({ api: { locationTrailPing: vi.fn() } }));

const mod = await import('./useLocationTrail');

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const ON = { locationTrail: true, lastPunch: { kind: 'in' } };
const POS = { lat: '33.5', lng: '-117.1', accuracy_m: 12 };

describe('useLocationTrail', () => {
  beforeEach(() => {
    getPosition.mockReset().mockResolvedValue(POS);
    locationPermission.mockReset().mockResolvedValue('granted');
  });

  it('reads the state from the time status', () => {
    expect(mod.trailState(null)).toBe('off');
    expect(mod.trailState({ ...ON, locationTrail: false })).toBe('off');
    expect(mod.trailState({ ...ON, timeTrackingExempt: true })).toBe('off');
    expect(mod.trailState(ON)).toBe('active');
    expect(mod.trailState({ locationTrail: true, lastPunch: { kind: 'break_end' } })).toBe('active');
    expect(mod.trailState({ locationTrail: true, lastPunch: { kind: 'break_start' } })).toBe('on_break');
    expect(mod.trailState({ locationTrail: true, lastPunch: { kind: 'out' } })).toBe('not_clocked_in');
    expect(mod.trailState({ locationTrail: true, lastPunch: null })).toBe('not_clocked_in');
    expect(mod.trailState({ ...ON, staleOpenShift: true })).toBe('not_clocked_in');
  });

  it('sends nothing when the switch is off, on a break or not clocked in', async () => {
    const send = vi.fn();
    for (const status of [{ ...ON, locationTrail: false }, { locationTrail: true, lastPunch: { kind: 'break_start' } },
      { locationTrail: true, lastPunch: { kind: 'out' } }]) {
      await mod.pingOnce({ status, tabId: 'a', now: 1e12, storage: memStorage(), send });
    }
    expect(send).not.toHaveBeenCalled();
    expect(getPosition).not.toHaveBeenCalled();
  });

  it('never asks for location: no permission, no fix, no ping', async () => {
    const send = vi.fn();
    for (const p of ['prompt', 'denied', '']) {
      locationPermission.mockResolvedValueOnce(p);
      expect(await mod.pingOnce({ status: ON, tabId: 'a', now: 1e12, storage: memStorage(), send })).toBe('no_permission');
    }
    expect(getPosition).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('pings when clocked in with permission, then waits five minutes', async () => {
    const send = vi.fn().mockResolvedValue({ stored: 1 });
    const storage = memStorage();
    const t0 = 1e12;
    expect(await mod.pingOnce({ status: ON, tabId: 'a', now: t0, storage, send })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ lat: '33.5', lng: '-117.1', accuracy_m: 12 });
    expect(await mod.pingOnce({ status: ON, tabId: 'a', now: t0 + 60_000, storage, send })).toBe('not_my_turn');
    expect(await mod.pingOnce({ status: ON, tabId: 'a', now: t0 + mod.PING_EVERY_MS, storage, send })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('two tabs sharing storage ping once per round', async () => {
    const send = vi.fn().mockResolvedValue({ stored: 1 });
    const storage = memStorage();
    const t0 = 1e12;
    await mod.pingOnce({ status: ON, tabId: 'a', now: t0, storage, send });
    await mod.pingOnce({ status: ON, tabId: 'b', now: t0 + 1000, storage, send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a tab holding the lock keeps others out', () => {
    const storage = memStorage();
    const t0 = 1e12;
    expect(mod.claimTurn(t0, 'a', storage)).toBe(true);
    expect(mod.claimTurn(t0 + 1000, 'b', storage)).toBe(false);
  });

  it('broken storage never throws', async () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const send = vi.fn().mockResolvedValue({});
    expect(await mod.pingOnce({ status: ON, tabId: 'a', now: 2e12, storage: bad, send })).toBe('sent');
  });

  it('a failed send is swallowed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await mod.pingOnce({ status: ON, tabId: 'a', now: 3e12, storage: memStorage(), send })).toBe('failed');
  });
});
