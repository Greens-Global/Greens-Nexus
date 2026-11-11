// Word's KeyTips (Neil, 11/11/2026): press and release Alt inside the
// document and every ribbon tab shows its letter (Home H, Insert N, Design
// G, Layout P, References S, Variables M - Word's Mailings - Review R, View
// W, the File menu F). Press one: that tab opens and its buttons show their
// letters; press a button's letters to run it. Escape steps back a level; a
// click anywhere, or focus leaving the document, ends it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const TAB_TIPS = { home: 'H', insert: 'N', design: 'G', layout: 'P', references: 'S', variables: 'M', review: 'R', view: 'W', tableDesign: 'JT', tableLayout: 'JL', shape: 'JD', picture: 'JP' };

const visible = (el) => {
  if (!el || el.disabled || el.closest('.is-overflow')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

// Letters for the buttons, Word's way: a button whose first letter no other
// button shares gets that letter; buttons sharing one get two letters (the
// first, then the next word's initial or the next letter that tells them
// apart). No code is the start of another, so typing is never ambiguous.
export function codesFor(labels) {
  const norm = labels.map((raw) => String(raw || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().toUpperCase() || 'X');
  const byFirst = new Map();
  norm.forEach((l, i) => { const f = l[0]; if (!byFirst.has(f)) byFirst.set(f, []); byFirst.get(f).push(i); });
  const out = new Array(labels.length);
  for (const [f, idxs] of byFirst) {
    if (idxs.length === 1) { out[idxs[0]] = f; continue; }
    const used = new Set();
    for (const i of idxs) {
      const words = norm[i].split(/\s+/);
      const letters = [...(words[1]?.[0] || ''), ...norm[i].slice(1).replace(/\s+/g, ''), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
      const second = letters.find((c) => !used.has(f + c));
      used.add(f + second);
      out[i] = f + second;
    }
  }
  return out;
}

export default function KeyTips({ rootRef, onTab }) {
  const [state, setState] = useState(null);   // { level: 'tabs' | 'buttons', items: [{ code, el }], typed }
  const stateRef = useRef(null);
  stateRef.current = state;

  useEffect(() => {
    let altAlone = false;
    const root = () => rootRef.current;
    const inside = () => !!root() && root().contains(document.activeElement);
    const tabItems = () => {
      const r = root();
      if (!r) return [];
      const items = [...r.querySelectorAll('.doc-ribbon-tab[data-tab]')].filter(visible)
        .map((el) => ({ code: TAB_TIPS[el.getAttribute('data-tab')], el, tab: el.getAttribute('data-tab') })).filter((i) => i.code);
      const file = [...r.querySelectorAll('.doc-mb-top')].find((b) => b.textContent.trim() === 'File');
      if (file) items.push({ code: 'F', el: file });
      return items;
    };
    const buttonItems = () => {
      const bar = root()?.querySelector('.doc-ribbon-bar');
      if (!bar) return [];
      const els = [...bar.querySelectorAll('button, [role="slider"]')].filter((el) => visible(el) && !el.closest('.doc-ribbon-panel'));
      const codes = codesFor(els.map((el) => el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent));
      return els.map((el, i) => ({ code: codes[i], el }));
    };
    const end = () => setState(null);
    const onKeyDown = (e) => {
      const st = stateRef.current;
      if (e.key === 'Alt') { altAlone = !e.ctrlKey && !e.metaKey && !e.shiftKey; return; }
      altAlone = false;
      if (!st) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (st.level === 'buttons') setState({ level: 'tabs', items: tabItems(), typed: '' }); else end();
        return;
      }
      if (!/^[a-z0-9]$/i.test(e.key) || e.ctrlKey || e.metaKey) { end(); return; }
      e.preventDefault(); e.stopPropagation();
      const typed = st.typed + e.key.toUpperCase();
      const exact = st.items.find((i) => i.code === typed);
      const partial = st.items.some((i) => i.code.startsWith(typed));
      if (exact) {
        if (st.level === 'tabs') {
          if (exact.tab) {
            onTab?.(exact.tab);
            requestAnimationFrame(() => requestAnimationFrame(() => setState({ level: 'buttons', items: buttonItems(), typed: '' })));
            setState(null);
          } else { exact.el.click(); end(); }
        } else { end(); exact.el.focus?.(); exact.el.click(); }
        return;
      }
      setState(partial ? { ...st, typed } : { ...st, typed: '' });
    };
    const onKeyUp = (e) => {
      if (e.key !== 'Alt' || !altAlone) return;
      altAlone = false;
      if (stateRef.current) { end(); return; }
      if (!inside()) return;
      e.preventDefault();
      setState({ level: 'tabs', items: tabItems(), typed: '' });
    };
    const onDown = () => { if (stateRef.current) end(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', end);
    };
  }, [rootRef, onTab]);

  if (!state || typeof document === 'undefined') return null;
  return createPortal(
    <div className="doc-keytips" aria-live="polite" aria-label="KeyTips">
      {state.items.filter((i) => i.code.startsWith(state.typed)).map((i) => {
        const r = i.el.getBoundingClientRect();
        return (
          <span key={`${i.code}-${r.left}-${r.top}`} className="doc-keytip" style={{ left: r.left + r.width / 2, top: state.level === 'tabs' ? r.bottom - 4 : r.bottom - 8 }}>
            {i.code}
          </span>
        );
      })}
    </div>,
    document.body,
  );
}
