// Escape with a menu open over a dialog that has typed work in it (11/15/2026,
// the phone New Task's Add menu): the menu takes the Escape and closes; the
// "unsaved changes" question is not asked. With no menu open it still is.
import { describe, it, expect, afterEach } from 'vitest';
import { installDialogGuard, subscribe, hasDirtyDialog } from './dialogGuard';

installDialogGuard();
// A question left open is answered (Keep Editing), so the next test starts with none.
afterEach(() => { document.body.innerHTML = ''; const off = subscribe((p) => p?.resolve(false)); off(); });

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

// Every layer that sits above the popup and owns its Escape (11/17/2026): the
// shared confirm dialog, a picker menu, the calendar, the attachment viewer.
// The guard used to take the key first and ask about the popup underneath.
describe('dialogGuard and a layer above the dirty popup', () => {
  it('leaves the Escape to the layer', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1"><input></div><div data-nx-esc-layer=""></div>';
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(asked()).toBe(false);
  });

  it('never marks such a layer as unsaved work', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-esc-layer=""><input></div>';
    document.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('.modal-overlay').hasAttribute('data-nx-dirty')).toBe(false);
    expect(hasDirtyDialog()).toBe(false);
  });
});

// The bell's panel on a phone: full screen, never unmounted, `inert` and slid
// away while closed. Once something was typed in it, every navigation, Back
// and reload asked to discard changes for the rest of the session.
describe('dialogGuard and a popup that is closed but still in the page', () => {
  it('an inert popup is not open, and reopened it starts clean', () => {
    document.body.innerHTML = '<div class="modal-overlay"><input></div>';
    const popup = document.querySelector('.modal-overlay');
    popup.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect(hasDirtyDialog()).toBe(true);
    popup.setAttribute('inert', '');
    expect(hasDirtyDialog()).toBe(false);
    escape();
    expect(asked()).toBe(false);
    popup.removeAttribute('inert');
    expect(hasDirtyDialog()).toBe(false);
  });

  it('a hidden popup is not open either', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1" style="display: none"><input></div><div class="modal-overlay" data-nx-dirty="1" hidden><input></div>';
    expect(hasDirtyDialog()).toBe(false);
  });

  it('a sheet waiting under another sheet (inert from the sheet stack) still counts', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1" inert data-nx-under=""><input></div>';
    expect(hasDirtyDialog()).toBe(true);
  });
});

// A text selection dragged out of the popup and let go on the backdrop is a
// click on the backdrop to the browser. It is not a close, so nothing is asked.
describe('dialogGuard and a drag that ends on the backdrop', () => {
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  const down = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));

  it('drops the click without asking; a press on the backdrop still asks', () => {
    document.body.innerHTML = '<div class="modal-overlay" data-nx-dirty="1"><input></div>';
    const popup = document.querySelector('.modal-overlay');
    const seen = [];
    popup.addEventListener('click', () => seen.push('click'));
    down(popup.querySelector('input'));
    click(popup);
    expect(seen).toEqual([]);
    expect(asked()).toBe(false);
    down(popup);
    click(popup);
    expect(seen).toEqual([]);
    expect(asked()).toBe(true);
  });
});

