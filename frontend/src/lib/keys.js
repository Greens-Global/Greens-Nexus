// Keyboard helpers shared by the header search, the Help menu and any screen
// with a "/" shortcut - one answer to "is the person typing right now?".

export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable || !!el.closest?.('[contenteditable="true"], [contenteditable=""]');
}

// The header's phone breakpoint (style.css hides the desktop bar at 900px).
export const PHONE_QUERY = '(max-width: 900px)';
export const isPhone = () => !!window.matchMedia?.(PHONE_QUERY).matches;

// Is this keydown the search shortcut? Ctrl/Cmd+K anywhere, or "/" when
// nothing is being typed.
export function isSearchShortcut(e) {
  if (e.defaultPrevented) return false;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return true;
  return e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target) && !isTypingTarget(document.activeElement);
}
