// A tier gate answers 401 "Insufficient permissions" to a person who is signed
// in. api.js must hand that back as a refusal - not retry it, and not send the
// person through a full-page sign-in the way a dead session is handled.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./msalInstance', () => ({ msalInstance: {}, msalReady: Promise.resolve() }));
vi.mock('./authConfig', () => ({ apiTokenRequest: {}, loginRequest: {} }));
vi.mock('./bffAuth', () => ({ BFF_MODE: true, csrfToken: () => 'csrf', bffLogin: vi.fn() }));

import { api } from './api';
import { bffLogin } from './bffAuth';

const answer = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('a 401 from a tier gate', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('is a refusal: one request, no sign-in redirect, the server words kept', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => answer(401, { detail: 'Insufficient permissions' }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await api.timeStatus().catch(e => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bffLogin).not.toHaveBeenCalled();
    expect(err.status).toBe(401);
    expect(err.message).toContain('Insufficient permissions');
  });

  it('any other 401 is still a dead session: one retry, then sign-in', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => answer(401, { detail: 'Not authenticated' }));
    vi.stubGlobal('fetch', fetchMock);
    const p = api.timeStatus().catch(e => e);
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bffLogin).toHaveBeenCalledTimes(1);
  });
});
