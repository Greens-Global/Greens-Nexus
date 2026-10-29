import { describe, it, expect, vi, beforeEach } from 'vitest';

// UI test 10/28: on MRE at 1440 a month column dragged wider (68 -> 85 px)
// went back after a reload. The width reached this browser's copy at once but
// the server only after the save delay, and the reload's server read (the
// older copy) then overwrote it. A change the server never got now wins on
// the next load and goes up; a reload or close sends a waiting save at once.
//
// Review 10/29: that unsent change must not wipe out a NEWER layout saved on
// another computer (saved views included). It carries when it was made and
// which keys it touched; it is replayed only if newer, and only its own keys.

vi.mock('../../api', () => ({
  api: { getAccountingPrefs: vi.fn(), saveAccountingPrefs: vi.fn(async () => ({})) },
}));

const SERVER = { tableViews: { mre: { draft: { widths: { m2: 74 } } } }, density: 'compact' };
const DRAGGED = { tableViews: { mre: { draft: { widths: { m2: 85 } } } } };
const UNSENT = 'nexus-accounting-prefs-unsent';
const iso = (ms) => new Date(ms).toISOString();

// A fresh copy of the module, as after a page reload (localStorage stays).
async function reload(serverPrefs = SERVER, updatedAt) {
  vi.resetModules();
  const { api } = await import('../../api');
  api.getAccountingPrefs.mockReset().mockResolvedValue({ prefs: serverPrefs, ...(updatedAt !== undefined ? { updatedAt } : {}) });
  api.saveAccountingPrefs.mockReset().mockResolvedValue({});
  const prefs = await import('./prefs');
  return { api, prefs };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Open the screen and let the first read land.
async function open(prefs) {
  const { renderHook } = await import('@testing-library/react');
  const hook = renderHook(() => prefs.useAccountingPrefs());
  await flush(); await flush();
  return hook;
}

describe('Accounting layout across a reload', () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

  it('a width dragged just before a reload is kept, not overwritten by the server, and goes up', async () => {
    let { prefs } = await reload();
    const { result } = await open(prefs);
    // The drag lands; the reload comes before the 800 ms save.
    result.current[1](DRAGGED);
    ({ prefs } = await reload());
    const { api } = await import('../../api');
    const again = await open(prefs);
    expect(again.result.current[0].tableViews.mre.draft.widths.m2).toBe(85);
    expect(again.result.current[0].density).toBe('compact');                     // the server's other keys still arrive
    await wait(900);
    expect(api.saveAccountingPrefs).toHaveBeenCalledWith(expect.objectContaining({ tableViews: DRAGGED.tableViews }));
  });

  it('once saved, the server copy wins again on the next load (another computer may have changed it)', async () => {
    let { prefs, api } = await reload();
    const { result } = await open(prefs);
    result.current[1](DRAGGED);
    await wait(900);
    expect(api.saveAccountingPrefs).toHaveBeenCalled();
    await flush();
    ({ prefs } = await reload({ tableViews: { mre: { draft: { widths: { m2: 120 } } } } }));
    const again = await open(prefs);
    expect(again.result.current[0].tableViews.mre.draft.widths.m2).toBe(120);
  });

  it('a stale unsent change never overwrites a newer layout saved on another computer, saved views included', async () => {
    let { prefs, api: first } = await reload(SERVER, iso(Date.now() - 3600e3));
    first.saveAccountingPrefs.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const { result } = await open(prefs);
    result.current[1](DRAGGED);                                   // never reaches the server (offline)
    await wait(900); await flush();
    expect(localStorage.getItem(UNSENT)).toBeTruthy();
    // Later, on another computer: MRE at 120 and a new saved view on the ledger lines.
    const newer = {
      tableViews: { mre: { draft: { widths: { m2: 120 } } }, 'ledger-lines': { active: 'v1', list: [{ id: 'v1', name: 'Amex', state: {} }] } },
      density: 'condensed',
    };
    ({ prefs } = await reload(newer, iso(Date.now() + 60e3)));
    const { api } = await import('../../api');
    const again = await open(prefs);
    const p = again.result.current[0];
    expect(p.tableViews.mre.draft.widths.m2).toBe(120);
    expect(p.tableViews['ledger-lines'].list[0].name).toBe('Amex');
    expect(p.density).toBe('condensed');
    expect(localStorage.getItem(UNSENT)).toBeNull();               // the stale change is dropped
    await wait(900);
    expect(api.saveAccountingPrefs).not.toHaveBeenCalled();        // and never sent up
  });

  it('a newer unsent change is still applied and sent, replaying only its own table over the server copy', async () => {
    const before = Date.now() - 3600e3;
    let { prefs } = await reload(SERVER, iso(before));
    const { result } = await open(prefs);
    result.current[1](DRAGGED);
    // Another computer saved a view on a different table BEFORE this change was made.
    const elsewhere = { ...SERVER, tableViews: { ...SERVER.tableViews, budget: { active: 'b1', list: [{ id: 'b1', name: 'FY26', state: {} }] } } };
    ({ prefs } = await reload(elsewhere, iso(before + 60e3)));
    const { api } = await import('../../api');
    const again = await open(prefs);
    const p = again.result.current[0];
    expect(p.tableViews.mre.draft.widths.m2).toBe(85);             // this computer's change wins
    expect(p.tableViews.budget.list[0].name).toBe('FY26');         // the other table's view survives
    await wait(900);
    expect(api.saveAccountingPrefs).toHaveBeenCalledWith(expect.objectContaining({
      tableViews: { mre: DRAGGED.tableViews.mre, budget: elsewhere.tableViews.budget },
    }));
  });

  it('a change made since this computer last saw the server wins even if its clock is behind', async () => {
    const serverAt = iso(Date.now() + 10 * 60e3);                   // server clock 10 minutes ahead
    let { prefs } = await reload(SERVER, serverAt);
    const { result } = await open(prefs);
    result.current[1](DRAGGED);
    ({ prefs } = await reload(SERVER, serverAt));                  // nobody saved since
    const again = await open(prefs);
    expect(again.result.current[0].tableViews.mre.draft.widths.m2).toBe(85);
  });

  it('a save the server refuses clears the unsent mark, so the server copy is used on the next load', async () => {
    let { prefs, api } = await reload(SERVER, iso(Date.now()));
    api.saveAccountingPrefs.mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 }));
    const { result } = await open(prefs);
    result.current[1]({ density: 'comfortable' });
    await wait(900); await flush();
    expect(api.saveAccountingPrefs).toHaveBeenCalled();
    expect(localStorage.getItem(UNSENT)).toBeNull();
    ({ prefs } = await reload(SERVER, iso(Date.now() - 60e3)));
    const again = await open(prefs);
    expect(again.result.current[0].density).toBe('compact');
  });

  it('a layout too large to save is not sent and clears the unsent mark', async () => {
    const { prefs, api } = await reload(SERVER, iso(Date.now()));
    const { result } = await open(prefs);
    result.current[1]({ tableViews: { ...SERVER.tableViews, big: { list: [{ id: 'x', name: 'x'.repeat(prefs.PREFS_MAX + 10) }] } } });
    await wait(900); await flush();
    expect(api.saveAccountingPrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem(UNSENT)).toBeNull();
  });

  it('a save that cannot reach the server keeps the unsent mark for the next try', async () => {
    const { prefs, api } = await reload(SERVER, iso(Date.now()));
    api.saveAccountingPrefs.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const { result } = await open(prefs);
    result.current[1](DRAGGED);
    await wait(900); await flush();
    expect(JSON.parse(localStorage.getItem(UNSENT)).keys).toEqual(['tableViews.mre']);
  });

  it('leaving the page sends a save still waiting on its delay, as keepalive when it fits', async () => {
    const { prefs, api } = await reload();
    const { result } = await open(prefs);
    result.current[1](DRAGGED);
    expect(api.saveAccountingPrefs).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.saveAccountingPrefs).toHaveBeenCalledWith(expect.objectContaining({ tableViews: DRAGGED.tableViews }), { keepalive: true });
    window.dispatchEvent(new Event('pageshow'));
  });

  it('a layout over 64 KB leaving the page goes as a normal request, not keepalive', async () => {
    const { prefs, api } = await reload();
    const { result } = await open(prefs);
    result.current[1]({ notes: 'n'.repeat(70000) });
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.saveAccountingPrefs).toHaveBeenCalledTimes(1);
    expect(api.saveAccountingPrefs.mock.calls[0]).toHaveLength(1);
    window.dispatchEvent(new Event('pageshow'));
  });
});
