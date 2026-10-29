// "Service is reconnecting" (Charmi, 10/27 call item 21): on 10/27 the live API
// restarted twice while a dev release deployed, and each restart kept it away
// for 1.5-2 minutes. The page must come back on its own, without a refresh:
//   * the red bar asks /health every 5 seconds while it shows, and clears on
//     the first answer;
//   * the full-page "Reconnecting..." keeps trying past the old ~23 seconds,
//     each try with its own time limit, until Nexus answers.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./msalInstance', () => ({ msalInstance: { getAllAccounts: () => [], setActiveAccount: () => {} }, msalReady: Promise.resolve() }));
vi.mock('./authConfig', () => ({ apiTokenRequest: {}, loginRequest: {} }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('the red reconnecting bar', () => {
  it('asks /health while it shows and clears itself on the first answer', async () => {
    vi.doMock('./bffAuth', () => ({ BFF_MODE: true, csrfToken: () => 'csrf', bffLogin: vi.fn() }));
    vi.useFakeTimers();
    const { api, onBackendHealth } = await import('./api');
    let up = false;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/health') && up) return { ok: true, status: 200 };
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const seen = [];
    onBackendHealth((down) => seen.push(down));
    api.timeStatus().catch(() => {});
    await vi.advanceTimersByTimeAsync(7000);                 // three tries, then the 3.5s grace
    expect(seen.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    const probes = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/health')).length;
    expect(probes()).toBe(1);                                // still down: the bar stays
    expect(seen.at(-1)).toBe(true);
    up = true;                                               // the restart finished
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen.at(-1)).toBe(false);                         // cleared with no request from the screen
    const after = probes();
    await vi.advanceTimersByTimeAsync(20000);
    expect(probes()).toBe(after);                            // and the probe stopped
  });
});

describe('the full-page Reconnecting screen', () => {
  it('keeps trying through a two-minute restart, a hung try included, and says how long it waited', async () => {
    vi.doUnmock('./bffAuth');
    vi.useFakeTimers();
    const { bffBootstrap } = await import('./bffAuth');
    let calls = 0;
    const fetchMock = vi.fn((url, opts) => {
      calls += 1;
      if (calls === 2) {
        // A connection that hangs: only its own time limit ends it.
        return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      if (calls < 14) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({ ok: false, status: 401 });     // Nexus answers (signed out, to keep the test light)
    });
    vi.stubGlobal('fetch', fetchMock);
    const waited = [];
    let result = 'pending';
    bffBootstrap({ onWaiting: (ms) => waited.push(ms) }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).toBe('pending');                          // the old loop gave up after ~23s
    await vi.advanceTimersByTimeAsync(120_000);
    expect(result).toBe(false);
    expect(calls).toBe(14);
    expect(waited.at(-1)).toBeGreaterThan(90_000);              // the screen knows it has waited 1.5 minutes
  });
});
