// Keyboard behavior shared by every search-and-pick menu in Nexus (Oct 13 2026).
//
// Typing "sa" into the Assignee picker filtered the list, but nothing showed
// which row Enter would take, the arrow keys did nothing, and Tab threw focus
// out of the form (the menu is portaled to <body>). Now:
//   - the row Enter takes is highlighted, and starts on the best match;
//   - Up / Down move the highlight (it scrolls into view);
//   - Tab takes the highlighted row - once something was typed or arrowed
//     to - then closes the menu and moves on to the next field, so a form can
//     be filled in without the mouse;
//   - on a closed picker's trigger, typing a letter opens it with that letter
//     already in the search box, and Down opens it.
// The highlight is the `data-nav-active` attribute (style.css), so every
// picker gets the same look whatever its own row styling is.
import { useEffect, useId, useState } from 'react';
import { focusables } from './useDialogFocus';

/**
 * items     the pickable rows, in display order (captions and other
 *           non-pickable rows left out)
 * onPick    (item, index) - Enter
 * onTab     (itemOrNull, shiftKey) - Tab; itemOrNull is the highlighted row
 *           when the user typed or arrowed, else null. Omit to leave Tab alone.
 * query     the search text - a new query puts the highlight back on top
 * open      whether the menu is showing - reopening resets the highlight.
 *           A list that is always on screen (a filter panel) passes whether
 *           something is typed, so it shows no highlight until it is searched.
 * startAt   where the highlight sits while nothing is typed (the current
 *           value's row, say)
 */
export function useListNav(items, { onPick, onTab, query = '', open = true, startAt = 0 } = {}) {
  const key = `${open ? 1 : 0}|${query}`;
  const typed = String(query || '').trim() !== '';
  const start = typed ? 0 : Math.max(0, startAt || 0);
  const [state, setState] = useState({ key, index: start, moved: false });
  let { index, moved } = state;
  if (state.key !== key) {
    index = start; moved = false;
    setState({ key, index: start, moved: false });
  }
  const n = items.length;
  const active = n ? Math.min(Math.max(index, 0), n - 1) : -1;
  const base = useId();
  const optionId = (i) => `${base}nav${i}`;

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${base}nav${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, base]);

  const move = (i) => setState((s) => ({ ...s, index: i, moved: true }));
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) move(Math.min(active + 1, n - 1)); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (n) move(Math.max(active - 1, 0)); return true; }
    if (e.key === 'Enter') {
      // Not on a list that is not showing (an always-on filter list passes
      // open = something typed): Enter in an empty box must pick nobody.
      if (!open || e.nativeEvent?.isComposing || active < 0) return false;
      e.preventDefault();
      onPick?.(items[active], active);
      return true;
    }
    if (e.key === 'Tab' && onTab) {
      e.preventDefault();
      onTab((typed || moved) && active >= 0 ? items[active] : null, e.shiftKey);
      return true;
    }
    return false;
  };
  // Spread onto row i. Mouse MOVE, not enter: a list scrolled by the arrow
  // keys slides rows under a still pointer, and enter would steal the
  // highlight back from the keyboard.
  const optionProps = (i) => ({
    id: optionId(i),
    role: 'option',
    'aria-selected': open && i === active,
    'data-nav-active': open && i === active ? '' : undefined,
    onMouseMove: () => { if (i !== active) setState((s) => ({ ...s, index: i })); },
  });
  const inputProps = {
    role: 'combobox',
    'aria-expanded': open,
    'aria-autocomplete': 'list',
    'aria-activedescendant': open && active >= 0 ? optionId(active) : undefined,
  };
  return { active, onKeyDown, optionProps, inputProps };
}

/** onKeyDown for a CLOSED picker's trigger: a printable key opens the menu
 *  with that key typed, ArrowDown opens it empty. `openWith(text)`. */
export function openPickerOnKey(e, openWith) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); openWith(''); return true; }
  if (e.key.length === 1 && e.key !== ' ') { e.preventDefault(); openWith(e.key); return true; }
  return false;
}

/** onFocus for a menu's search box: caret at the end, so a picker opened by
 *  typing "s" keeps "s" ahead of the next key rather than behind it. */
export function caretToEnd(e) {
  const el = e.target;
  const len = (el.value || '').length;
  try { el.setSelectionRange(len, len); } catch { /* not a text input */ }
}

/** After a picker closes on Tab: focus the field after (or, with Shift,
 *  before) its trigger - within the dialog it sits in, else the page. */
export function focusNextField(from, backwards = false) {
  if (!from || !from.isConnected) return;
  const root = from.closest('[role="dialog"]') || document.body;
  const list = focusables(root);
  const i = list.indexOf(from);
  let next = null;
  if (i >= 0) {
    next = backwards
      ? list[i - 1]
      : list.slice(i + 1).find((el) => !from.contains(el));
    // Off either end of a dialog: wrap, the way its own Tab trap does.
    if (!next && root !== document.body) next = backwards ? list[list.length - 1] : list[0];
  }
  try { (next || from).focus({ preventScroll: false }); } catch { (next || from).focus(); }
}
