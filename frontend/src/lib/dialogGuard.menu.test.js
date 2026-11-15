// Escape with a menu open over a dialog that has typed work in it (11/15/2026,
// the phone New Task's Add menu): the menu takes the Escape and closes; the
// "unsaved changes" question is not asked. With no menu open it still is.
import { describe, it, expect, afterEach } from 'vitest';
import { installDialogGuard, subscribe } from './dialogGuard';

installDialogGuard();
afterEach(() => { document.body.innerHTML = ''; });

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const asked = () => { let p = null; const off = subscribe((x) => { p = x; }); off(); return !!p; };

describe('dialogGuard and an open menu', () => {
  it('leaves the Escape to an open menu', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1"><input></div><div class="nx-anchored" role="menu"></div>';
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(asked()).toBe(false);
  });

  it('a closing menu does not count, and with no menu the dirty dialog asks', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1"><input></div><div class="nx-anchored is-closing" role="menu"></div>';
    escape();
    expect(asked()).toBe(true);
  });
});
