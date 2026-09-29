import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Punch positions (Amy, Sep 29): a clock-out whose fresh fix is slower than
// its short wait uses a fix from the last 15 minutes instead of recording
// "location off"; a clock-in never falls back; an old fix is never used.

const fix = (lat) => ({ coords: { latitude: lat, longitude: -117, accuracy: 20 } });
let answer;   // (success, error) => void - what the browser does this time

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  answer = (ok) => ok(fix(33.5));
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok, err) => answer(ok, err) },
  });
});
afterEach(() => { vi.useRealTimers(); });

const load = () => import('./geoPosition');

describe('punch positions', () => {
  it('uses a fresh fix when it arrives in time', async () => {
    const { punchPosition } = await load();
    await expect(punchPosition('out')).resolves.toMatchObject({ lat: '33.5', accuracy_m: 20 });
  });

  it('falls back to a recent fix when the out-punch fix is slow', async () => {
    const { punchPosition, getPosition } = await load();
    await getPosition(9000);                       // clock-in: remembered
    answer = () => {};                              // the browser never answers now
    vi.advanceTimersByTime(10 * 60 * 1000);         // 10 minutes later
    const p = punchPosition('out');
    vi.advanceTimersByTime(2500);
    await expect(p).resolves.toMatchObject({ lat: '33.5' });
  });

  it('never uses a fix older than 15 minutes', async () => {
    const { punchPosition, getPosition } = await load();
    await getPosition(9000);
    answer = (ok, err) => err(new Error('denied'));
    vi.advanceTimersByTime(16 * 60 * 1000);
    await expect(punchPosition('out')).resolves.toBeNull();
  });

  it('a clock-in never falls back', async () => {
    const { punchPosition, getPosition } = await load();
    await getPosition(9000);
    answer = (ok, err) => err(new Error('timeout'));
    await expect(punchPosition('in')).resolves.toBeNull();
  });
});
