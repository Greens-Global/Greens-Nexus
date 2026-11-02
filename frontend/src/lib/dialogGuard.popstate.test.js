// The browser's Back with unsaved work (App.jsx's popstate): the entry the
// person was on comes back while the prompt asks; Discard steps on to where
// they were going and that move goes through; Keep Editing stays.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setInlineDirty, rememberEntry, guardPopstate, subscribe, unsavedSummary, setPopStay } from './dialogGuard';

afterEach(() => { setInlineDirty('settings', false); setPopStay(null); vi.restoreAllMocks(); document.body.innerHTML = ''; });

function nextPrompt() {
  return new Promise((resolve) => {
    const off = subscribe((p) => { if (p) { off(); resolve(p); } });
  });
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe('guardPopstate', () => {
  it('applies the move when nothing is unsaved', () => {
    rememberEntry();
    const apply = vi.fn();
    expect(guardPopstate({ state: null }, apply)).toBe(true);
    expect(apply).toHaveBeenCalled();
  });

  it('steps back to the entry by depth (Forward history kept), asks; Keep Editing stays, Discard goes on', async () => {
    window.history.replaceState({ depth: 3 }, '', '/admin-console/pay');
    rememberEntry();
    setInlineDirty('settings', true, { labels: ['Pay Rules'], save: null });
    const push = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    const apply = vi.fn();

    let asked = nextPrompt();
    expect(guardPopstate({ state: { depth: 2 } }, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();          // no pushState: Forward history survives
    expect(go).toHaveBeenLastCalledWith(1);       // back to the entry on screen
    expect(guardPopstate({ state: { depth: 3 } }, apply)).toBe(false);   // that step is swallowed
    let p = await asked;
    expect(p.summary().labels).toEqual(['Pay Rules']);
    p.resolve(false);
    await tick();
    expect(go).toHaveBeenCalledTimes(1);

    asked = nextPrompt();
    guardPopstate({ state: { depth: 2 } }, apply);
    guardPopstate({ state: { depth: 3 } }, apply);   // the step back
    p = await asked;
    p.resolve(true);
    await tick();
    expect(go).toHaveBeenLastCalledWith(-1);      // on to where the person was going
    expect(guardPopstate({ state: { depth: 2 } }, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a second Back while the question is open only puts the entry back - one Discard, one step', async () => {
    window.history.replaceState({ depth: 3 }, '', '/admin-console/pay');
    rememberEntry();
    setInlineDirty('settings', true, { labels: ['Pay Rules'] });
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    const apply = vi.fn();
    const asked = nextPrompt();
    guardPopstate({ state: { depth: 2 } }, apply);
    guardPopstate({ state: { depth: 3 } }, apply);   // returned
    const p = await asked;
    document.body.innerHTML = '<div data-nx-prompt="1"></div>';   // the prompt is on screen
    guardPopstate({ state: { depth: 2 } }, apply);   // Back again
    guardPopstate({ state: { depth: 3 } }, apply);   // returned again
    expect(go).toHaveBeenCalledTimes(2);             // two returns, no second question
    p.resolve(true);
    await tick();
    expect(go).toHaveBeenCalledTimes(3);
    expect(go).toHaveBeenLastCalledWith(-1);
    expect(apply).not.toHaveBeenCalled();
    expect(guardPopstate({ state: { depth: 2 } }, apply)).toBe(true);   // the step it asked for goes through
  });

  it('an entry without a depth is pushed back instead', async () => {
    window.history.replaceState(null, '', '/admin-console/pay');
    rememberEntry();
    setInlineDirty('settings', true, { labels: ['Pay Rules'] });
    const push = vi.spyOn(window.history, 'pushState');
    vi.spyOn(window.history, 'go').mockImplementation(() => {});
    const asked = nextPrompt();
    guardPopstate({ state: null }, vi.fn());
    expect(push).toHaveBeenCalledWith(null, '', expect.stringContaining('/admin-console/pay'));
    (await asked).resolve(false);
  });

  it('a move the screen says keeps every form mounted goes straight through', () => {
    rememberEntry();
    setInlineDirty('settings', true, { labels: ['Pay Rules'] });
    setPopStay(() => true);
    const apply = vi.fn();
    expect(guardPopstate({ state: null }, apply)).toBe(true);
    expect(apply).toHaveBeenCalled();
  });

  it('offers one save only when every inline form can save itself', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    setInlineDirty('settings', true, { labels: ['Probation'], save });
    const s = unsavedSummary();
    expect(s.labels).toEqual(['Probation']);
    await expect(s.save()).resolves.toBe(true);
    setInlineDirty('settings', true, { labels: ['Probation'], save: null });
    expect(unsavedSummary().save).toBe(null);
  });

  it('names nothing and discards nothing when the prompt is about a dirty popup', () => {
    const discard = vi.fn();
    setInlineDirty('settings', true, { labels: ['Pay Rules'], save: () => true, discard });
    expect(unsavedSummary().discard).toBeTypeOf('function');
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1"></div>';
    expect(unsavedSummary()).toEqual({ labels: [], save: null, discard: null });
  });
});
