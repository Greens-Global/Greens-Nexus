// The browser's Back with unsaved work (App.jsx's popstate): the entry the
// person was on comes back while the prompt asks; Discard steps back to
// where they were going and that move goes through; Keep Editing stays.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setInlineDirty, rememberEntry, guardPopstate, subscribe, unsavedSummary } from './dialogGuard';

afterEach(() => { setInlineDirty('settings', false); vi.restoreAllMocks(); });

function nextPrompt() {
  return new Promise((resolve) => {
    const off = subscribe((p) => { if (p) { off(); resolve(p); } });
  });
}

describe('guardPopstate', () => {
  it('applies the move when nothing is unsaved', () => {
    rememberEntry();
    const apply = vi.fn();
    expect(guardPopstate({ state: null }, apply)).toBe(true);
    expect(apply).toHaveBeenCalled();
  });

  it('puts the entry back and asks; Keep Editing stays, Discard goes back again', async () => {
    window.history.replaceState({ depth: 1 }, '', '/admin-console/pay');
    rememberEntry();
    setInlineDirty('settings', true, { labels: ['Pay Rules'], save: null });
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const apply = vi.fn();

    let asked = nextPrompt();
    expect(guardPopstate({ state: { depth: 0 } }, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ depth: 1 }, '', expect.stringContaining('/admin-console/pay'));
    let p = await asked;
    expect(p.summary().labels).toEqual(['Pay Rules']);
    p.resolve(false);
    await Promise.resolve();
    expect(back).not.toHaveBeenCalled();

    asked = nextPrompt();
    guardPopstate({ state: { depth: 0 } }, apply);
    p = await asked;
    p.resolve(true);
    await new Promise(r => setTimeout(r, 0));
    expect(back).toHaveBeenCalledTimes(1);
    // The popstate that back() causes goes through, unsaved or not.
    expect(guardPopstate({ state: { depth: 0 } }, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
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
});
