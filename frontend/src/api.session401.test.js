// A 401 is a dead sign-in only when the sign-in check said so (lib/session401.js).
// A route's own 401 is an ordinary refusal: sent once, shown as its words, and
// never a trip to Microsoft sign-in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./msalInstance', () => ({ msalInstance: {}, msalReady: Promise.resolve() }));
vi.mock('./authConfig', () => ({ apiTokenRequest: {}, loginRequest: {} }));
vi.mock('./bffAuth', () => ({ BFF_MODE: true, csrfToken: () => 'csrf', bffLogin: vi.fn() }));

import { api } from './api';
import { bffLogin } from './bffAuth';
import { isSessionDead } from './lib/session401';

const answer = (detail) => async () => new Response(JSON.stringify({ detail }), { status: 401, headers: { 'Content-Type': 'application/json' } });

describe('which 401 is a dead sign-in', () => {
  beforeEach(() => { vi.useFakeTimers(); bffLogin.mockClear(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('knows the sign-in check by its words, and stays cautious about a 401 with none', () => {
    for (const d of ['Missing or invalid Authorization header', 'Invalid token: expired', 'Token signing key not found',
      'Token has no identifiable email claim - add ...', 'This preview sign-in has expired - open it again']) expect(isSessionDead(d)).toBe(true);
    for (const d of ['Insufficient permissions', 'Incorrect password', 'Invalid UniFi API key',
      'Your Egnyte connection has expired. Open the Egnyte module, press Connect']) expect(isSessionDead(d)).toBe(false);
    expect(isSessionDead(undefined)).toBe(true);
    expect(isSessionDead({ code: 'stale' })).toBe(true);
  });

  it('a route that refuses with 401 is sent once, says its own words and never signs in again', async () => {
    const fetchMock = vi.fn().mockImplementation(answer('Insufficient permissions'));
    vi.stubGlobal('fetch', fetchMock);
    const p = api.cvPersonalLockVerify('wrong').catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const err = await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);          // a write is never sent a second time
    expect(err.status).toBe(401);
    expect(err.message).toBe('Insufficient permissions');
    expect(bffLogin).not.toHaveBeenCalled();
  });

  it("the sign-in check's own 401 is still tried once more, then signs in again", async () => {
    const fetchMock = vi.fn().mockImplementation(answer('Missing or invalid Authorization header'));
    vi.stubGlobal('fetch', fetchMock);
    const p = api.timeStatus().catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bffLogin).toHaveBeenCalledTimes(1);
  });
});
