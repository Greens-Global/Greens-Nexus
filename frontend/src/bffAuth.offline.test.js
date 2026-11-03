import { describe, it, expect, vi, beforeEach } from 'vitest';

// BFF and field offline (Neil, 11/03/2026):
//   * the remembered sign-in carries when the session must have expired, and
//     the phone stops opening offline on it after that;
//   * offline boot only when the phone truly cannot reach the site - not on a
//     failed API call behind a working connection;
//   * sign out clears the phone's offline read cache FIRST, and waits for it,
//     before the navigation that would cut it off.
const clear = vi.hoisted(() => ({ fn: null }));
vi.mock('./lib/offline/read', () => ({ clearOfflineReadCache: (...a) => clear.fn(...a) }));
vi.mock('./msalInstance', () => ({ msalInstance: { getActiveAccount: () => null, getAllAccounts: () => [] }, msalReady: Promise.resolve() }));

const bff = await import('./bffAuth');
const DAY = 24 * 3600 * 1000;
let online = true;

beforeEach(() => {
  localStorage.clear();
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  clear.fn = vi.fn(async () => {});
});

describe('the remembered sign-in', () => {
  it('lasts the server\'s idle days from this boot, then is refused (and forgotten)', () => {
    const t = Date.UTC(2026, 10, 3);
    bff._rememberForOffline({ email: 'crew@greensglobal.com', name: 'Crew', sessionIdleDays: 7 }, t);
    expect(bff._offlineMe(t + 6 * DAY)).toEqual({ email: 'crew@greensglobal.com', name: 'Crew', offline: true });
    expect(bff._offlineMe(t + 7 * DAY + 1)).toBeNull();
    expect(localStorage.getItem('nexus:offline-me')).toBeNull();
  });

  it('an older API without the idle days: 30 days', () => {
    const t = Date.UTC(2026, 10, 3);
    bff._rememberForOffline({ email: 'crew@greensglobal.com' }, t);
    expect(bff._offlineMe(t + 29 * DAY)).not.toBeNull();
    expect(bff._offlineMe(t + 31 * DAY)).toBeNull();
  });

  it('a record with no expiry is never trusted', () => {
    localStorage.setItem('nexus:offline-me', JSON.stringify({ email: 'crew@greensglobal.com' }));
    expect(bff._offlineMe()).toBeNull();
  });
});

describe('cannot reach the site', () => {
  it('the browser says offline: no request needed', async () => {
    online = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await bff._cannotReachSite()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('online and the site answers: only the API is down - not an offline boot', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
    expect(await bff._cannotReachSite()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledWith('/version.json', expect.objectContaining({ cache: 'no-store' }));
    fetchSpy.mockRestore();
  });

  it('online but nothing gets out at all: offline', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await bff._cannotReachSite()).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe('sign out', () => {
  it('waits for the offline read cache to clear before leaving', async () => {
    let release;
    clear.fn = vi.fn(() => new Promise((r) => { release = r; }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});   // jsdom: navigation not implemented
    const done = bff.bffLogout();
    await Promise.resolve();
    expect(clear.fn).toHaveBeenCalled();
    expect(localStorage.getItem('nexus:signedout')).toBeNull();          // nothing else has happened yet
    release();
    await done;
    expect(localStorage.getItem('nexus:signedout')).not.toBeNull();
    err.mockRestore();
  });
});
