import { describe, it, expect } from 'vitest';
import { fieldHomeEnd } from './useDialogFocus';

function press(el, key, extra = {}) {
  let prevented = false;
  fieldHomeEnd({ key, target: el, preventDefault: () => { prevented = true; }, ...extra });
  return prevented;
}

describe('fieldHomeEnd', () => {
  it('moves the caret of a text input to the start or end and cancels the scroll', () => {
    const el = document.createElement('input');
    el.value = 'Hello World Project';
    document.body.appendChild(el);
    el.setSelectionRange(5, 5);
    expect(press(el, 'End')).toBe(true);
    expect([el.selectionStart, el.selectionEnd]).toEqual([19, 19]);
    expect(press(el, 'Home')).toBe(true);
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 0]);
  });
  it('extends the selection with Shift', () => {
    const el = document.createElement('input');
    el.value = 'Hello World';
    document.body.appendChild(el);
    el.setSelectionRange(6, 6);
    press(el, 'End', { shiftKey: true });
    expect([el.selectionStart, el.selectionEnd]).toEqual([6, 11]);
    el.setSelectionRange(6, 6);
    press(el, 'Home', { shiftKey: true });
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 6]);
  });
  it('leaves textareas, buttons, other keys and modified keys to the browser', () => {
    const ta = document.createElement('textarea');
    ta.value = 'a\nb';
    expect(press(ta, 'End')).toBe(false);
    const btn = document.createElement('button');
    expect(press(btn, 'Home')).toBe(false);
    const el = document.createElement('input');
    el.value = 'abc';
    expect(press(el, 'ArrowLeft')).toBe(false);
    expect(press(el, 'End', { metaKey: true })).toBe(false);
  });
});
