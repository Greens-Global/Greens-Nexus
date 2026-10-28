import { describe, it, expect, vi, beforeEach } from 'vitest';

// UI test 10/28: on MRE at 1440 a month column dragged wider (68 -> 85 px)
// went back after a reload. The width reached this browser's copy at once but
// the server only after the save delay, and the reload's server read (the
// older copy) then overwrote it. A change the server never got now wins on
// the next load and goes up; a reload or close sends a waiting save at once.

vi.mock('../../api', () => ({
  api: { getAccountingPrefs: vi.fn(), saveAccountingPrefs: vi.fn(async () => ({})) },
}));

const SERVER = { tableViews: { mre: { draft: { widths: { m2: 74 } } } }, density: 'compact' };
const DRAGGED = { tableViews: { mre: { draft: { widths: { m2: 85 } } } } };

// A fresh copy of the module, as after a page reload (localStorage stays).
async function reload(serverPrefs = SERVER) {
  vi.resetModules();
  const { api } = await import('../../api');
  api.getAccountingPrefs.mockReset().mockResolvedValue({ prefs: serverPrefs });
  api.saveAccountingPrefs.mockReset().mockResolvedValue({});
  const prefs = await import('./prefs');
  return { api, prefs };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Accounting layout across a reload', () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

  it('a width dragged just before a reload is kept, not overwritten by the server, and goes up', async () => {
    let { prefs } = await reload();
    const { renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => prefs.useAccountingPrefs());
    await flush();
    // The drag lands; the reload comes before the 800 ms save.
    result.current[1](DRAGGED);
    ({ prefs } = await reload());
    const { api } = await import('../../api');
    const again = renderHook(() => prefs.useAccountingPrefs());
    await flush(); await flush();
    expect(again.result.current[0].tableViews.mre.draft.widths.m2).toBe(85);
    expect(again.result.current[0].density).toBe('compact');                     // the server's other keys still arrive
    await new Promise((r) => setTimeout(r, 900));
    expect(api.saveAccountingPrefs).toHaveBeenCalledWith(expect.objectContaining({ tableViews: DRAGGED.tableViews }));
  });

  it('once saved, the server copy wins again on the next load (another computer may have changed it)', async () => {
    let { prefs, api } = await reload();
    const { renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => prefs.useAccountingPrefs());
    await flush();
    result.current[1](DRAGGED);
    await new Promise((r) => setTimeout(r, 900));
    expect(api.saveAccountingPrefs).toHaveBeenCalled();
    await flush();
    ({ prefs } = await reload({ tableViews: { mre: { draft: { widths: { m2: 120 } } } } }));
    const again = renderHook(() => prefs.useAccountingPrefs());
    await flush(); await flush();
    expect(again.result.current[0].tableViews.mre.draft.widths.m2).toBe(120);
  });

  it('leaving the page sends a save still waiting on its delay', async () => {
    const { prefs, api } = await reload();
    const { renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => prefs.useAccountingPrefs());
    await flush();
    result.current[1](DRAGGED);
    expect(api.saveAccountingPrefs).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.saveAccountingPrefs).toHaveBeenCalledWith(expect.objectContaining({ tableViews: DRAGGED.tableViews }));
    window.dispatchEvent(new Event('pageshow'));
  });
});
