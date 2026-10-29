import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A Knowledge Base fetch that fails is tried again later, not remembered for
// the session (Oct 28 2026: every dev deploy restarts the API for minutes).

const calls = { docs: 0, courses: 0 };
const mode = { docs: 'ok', courses: 'ok' };
vi.mock('../api', () => ({
  api: {
    kbCorpusDocs: () => { calls.docs += 1; return mode.docs === 'ok' ? Promise.resolve([{ id: 'd1', title: 'Forklift Safety', status: 'approved', body: {} }]) : Promise.reject(new Error('down')); },
    kbCorpusCourses: () => { calls.courses += 1; return mode.courses === 'ok' ? Promise.resolve([]) : Promise.reject(new Error('down')); },
  },
}));

const { loadKbCorpus, __resetKbCorpus, KB_RETRY_MS } = await import('./kbCorpus');

let now = 1_000_000;
beforeEach(() => {
  __resetKbCorpus();
  calls.docs = 0; calls.courses = 0; mode.docs = 'ok'; mode.courses = 'ok';
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('kbCorpus', () => {
  it('retries a failure after a minute, not on every ask, and recovers', async () => {
    mode.docs = 'fail'; mode.courses = 'fail';
    expect((await loadKbCorpus()).status).toBe('error');
    expect((await loadKbCorpus()).status).toBe('error');
    expect(calls.docs).toBe(1);
    mode.docs = 'ok'; mode.courses = 'ok';
    now += KB_RETRY_MS + 1;
    expect((await loadKbCorpus()).status).toBe('ready');
    expect(calls.docs).toBe(2);
    await loadKbCorpus();
    expect(calls.docs).toBe(2);
  });

  it('searches the half that loaded as partial (no "unavailable" note), and retries the rest later', async () => {
    mode.courses = 'fail';
    const s = await loadKbCorpus();
    expect(s.status).toBe('partial');
    expect(s.corpus).toBeTruthy();
    mode.courses = 'ok';
    now += KB_RETRY_MS + 1;
    expect((await loadKbCorpus()).status).toBe('ready');
    expect(calls.courses).toBe(2);
  });
});
