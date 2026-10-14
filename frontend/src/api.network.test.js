// When fetch() itself fails (offline, dropped connection, our own timeout),
// api.js throws readable words instead of the browser's "Failed to fetch" -
// and keeps what callers rely on: no .status, the original name, the raw
// error as cause, GET-only retry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./msalInstance', () => ({ msalInstance: {}, msalReady: Promise.resolve() }));
vi.mock('./authConfig', () => ({ apiTokenRequest: {}, loginRequest: {} }));
vi.mock('./bffAuth', () => ({ BFF_MODE: true, csrfToken: () => 'csrf', bffLogin: vi.fn() }));

import { api } from './api';

const FRIENDLY = "Can't reach Nexus right now. Check your connection and try again.";

describe('api network failures', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a GET that never reaches the server: retried, then the friendly message with the raw error kept', async () => {
    const raw = new TypeError('Failed to fetch');
    const fetchMock = vi.fn().mockRejectedValue(raw);
    vi.stubGlobal('fetch', fetchMock);
    const p = api.timeStatus().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await p;
    expect(fetchMock).toHaveBeenCalledTimes(3);          // the backoff retry is unchanged
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(FRIENDLY);
    expect(err.cause).toBe(raw);
    expect(err.name).toBe('TypeError');
    expect(err.isNetworkError).toBe(true);
    expect(err.status).toBeUndefined();                  // punchQueue: "outcome unknown"
  });

  it('a write is not re-sent, and a timeout stays recognizable as an AbortError', async () => {
    const raw = Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockRejectedValue(raw);
    vi.stubGlobal('fetch', fetchMock);
    const err = await api.reportClientError({ message: 'x' }).catch(e => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toBe(FRIENDLY);
    expect(err.name).toBe('AbortError');
    expect(err.cause).toBe(raw);
  });

  it('an answer from the server keeps its own message and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ detail: 'Already punched in.' }),
    }));
    const err = await api.reportClientError({ message: 'x' }).catch(e => e);
    expect(err.message).toBe('Already punched in.');
    expect(err.status).toBe(409);
    expect(err.isNetworkError).toBeUndefined();
  });
});
