// Focus handling for the shared Modal and BottomSheet (tasks/components.jsx,
// tasks/MobileTaskBar.jsx).
//
// - On open, focus moves INTO the dialog: onto the panel itself (tabIndex -1),
//   unless something inside already took it (an autoFocus field). The panel,
//   not its first field, so a phone does not pop its keyboard just because a
//   sheet opened.
// - On close, focus goes back to whatever had it before (the button that
//   opened the dialog), unless it has since moved somewhere else on purpose.
// - Tab / Shift+Tab cycle inside the panel. Focus that sits in a portaled
//   child (a SelectMenu, a date popover) is left alone.
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((el) => (
    el.tabIndex >= 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]')
    && el.style.display !== 'none' && el.style.visibility !== 'hidden'
  ));
}

export function useDialogFocus(panelRef) {
  // The opener, read on the FIRST render - before this commit applies any
  // autoFocus inside the dialog. Read in the effect it would already be that
  // field, gone with the dialog on close, and focus would fall to <body>.
  const opener = useRef(undefined);
  if (opener.current === undefined) opener.current = typeof document !== 'undefined' ? document.activeElement : null;
  useEffect(() => {
    const panel = panelRef.current;
    const prev = opener.current;
    if (panel && !panel.contains(document.activeElement)) {
      try { panel.focus({ preventScroll: true }); } catch { panel.focus(); }
    }
    return () => {
      const now = document.activeElement;
      // Only take focus back if it is nowhere in particular now (the dialog's
      // DOM is already gone, so it fell to <body>) or still inside the panel.
      const lost = !now || now === document.body || !now.isConnected || (panel && panel.contains(now));
      if (lost && prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [panelRef]);
}

// Home / End inside a text field of a dialog move ITS caret and nothing else.
// Chromium also scrolls the field's nearest scroll container (the dialog body,
// .nx-scroll, smooth) on those keys, so the page behind jumped and the caret
// was left where it was (Neil, Oct 21 2026: renaming a project). The field is
// moved by hand and the default - the scroll - is cancelled. Textareas keep
// the browser's own line-based Home / End.
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'password']);
export function fieldHomeEnd(e) {
  if ((e.key !== 'Home' && e.key !== 'End') || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  if (!el || el.tagName !== 'INPUT' || !TEXT_TYPES.has(el.type || '') || typeof el.setSelectionRange !== 'function') return;
  const len = (el.value || '').length;
  try {
    if (e.key === 'Home') el.setSelectionRange(0, e.shiftKey ? (el.selectionEnd ?? 0) : 0, 'backward');
    else el.setSelectionRange(e.shiftKey ? (el.selectionStart ?? len) : len, len, 'forward');
  } catch { return; }   // a type that has no selection: leave the browser to it
  e.preventDefault();
}

// onKeyDown for the panel: Home / End stay in their field, Tab stays inside the panel.
export function dialogKeyDown(e) {
  fieldHomeEnd(e);
  trapTab(e);
}

// Keeps Tab inside the panel.
export function trapTab(e) {
  if (e.key !== 'Tab') return;
  const panel = e.currentTarget;
  const active = document.activeElement;
  if (active !== panel && !panel.contains(active)) return;   // a portaled child menu
  const list = focusables(panel);
  if (!list.length) { e.preventDefault(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
