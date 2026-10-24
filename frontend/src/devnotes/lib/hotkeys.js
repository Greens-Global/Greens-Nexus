// Build Mode keys. The toggle (Ctrl+Shift+. / Cmd+Shift+.) is the shell's -
// it works whenever the person has Build Mode; the tool keys below only
// while the mode is on. Nothing fires while someone is typing, except Esc.

export function isToggleHotkey(e) {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return false;
  return e.key === '.' || e.key === '>' || e.code === 'Period';
}

export function isTyping(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

export const TOOL_KEYS = { p: 'pin', e: 'edit', r: 'rect', a: 'arrow', d: 'path', h: 'highlight', t: 'text', x: 'redact' };

// handlers: { tool(id), video(), voice(), queue(), undo(), escape(), color() }
export function installHotkeys(handlers) {
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { handlers.escape?.(e); return; }
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'z') { e.preventDefault(); handlers.undo?.(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (TOOL_KEYS[k]) { e.preventDefault(); handlers.tool?.(TOOL_KEYS[k]); return; }
    if (k === 'v') { e.preventDefault(); handlers.video?.(); return; }
    if (k === 'm') { e.preventDefault(); handlers.voice?.(); return; }
    if (k === 'q') { e.preventDefault(); handlers.queue?.(); return; }
    if (k === 'c') { e.preventDefault(); handlers.color?.(); }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
