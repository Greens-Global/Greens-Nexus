// The document's menu bar, Google Docs style (Neil, 11/10/2026: "make the
// menu better" - the editor's top menu). File, Edit, View, Insert, Format,
// Tools, Help under the document's name, each a list of every command with
// its icon and keyboard shortcut, with fly-out submenus, beside a "Search the
// menus" box (Alt+/). The Word ribbon stays below it: the bar is the index of
// everything, the ribbon the quick buttons. Menus open through AnchoredMenu
// (never clipped, never off screen); once one is open, pointing at another
// opens it, and Left / Right step between them, as in Docs and Word.
//
// A menu is { label, items }; an item is '-' (a line), or
//   { label, icon, shortcut: 'Mod+B', onClick, disabled, checked, hint, items }
// `checked` (true / false) draws the tick column; `items` makes a submenu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Search, X } from 'lucide-react';
import AnchoredMenu from '../AnchoredMenu';
import { menuKeys } from './ui';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/** "Mod+Shift+V" -> "Ctrl+Shift+V" (or the Mac's symbols). */
export function shortcutText(s) {
  if (!s) return '';
  if (!IS_MAC) return s.replace(/Mod/g, 'Ctrl');
  return s.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃');
}

/** Every runnable command, with the path that leads to it (search, the shortcuts card). */
export function flattenMenus(menus) {
  const out = [];
  const walk = (items, path) => {
    for (const it of items || []) {
      if (!it || it === '-') continue;
      if (it.items) walk(it.items, [...path, it.label]);
      else if (it.onClick) out.push({ ...it, path });
    }
  };
  for (const m of menus) walk(m.items, [m.label]);
  return out;
}

function ItemRow({ it, onRun, onOpenSub, subOpen, hasChecks }) {
  const Icon = it.icon;
  const ref = useRef(null);
  const sub = !!it.items;
  return (
    <button ref={ref} type="button" role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={it.checked !== undefined ? !!it.checked : undefined} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? !!subOpen : undefined}
      className={`doc-ribbon-item doc-mb-item${subOpen ? ' is-open' : ''}`} disabled={it.disabled} title={it.title}
      onPointerEnter={() => onOpenSub(sub ? { item: it, el: ref.current } : null)}
      onClick={() => (sub ? onOpenSub({ item: it, el: ref.current, focus: true }) : onRun(it))}
      onKeyDown={(e) => { if (sub && (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); onOpenSub({ item: it, el: ref.current, focus: true }); } }}>
      <span className="doc-mb-icon" aria-hidden="true">
        {it.checked ? <Check size={14} /> : Icon ? <Icon size={14} /> : hasChecks ? null : null}
      </span>
      <span className="doc-mb-label">{it.label}</span>
      {it.hint && <span className="doc-mb-hint">{it.hint}</span>}
      {it.shortcut && <kbd className="doc-mb-key">{shortcutText(it.shortcut)}</kbd>}
      {sub && <ChevronRight size={13} className="doc-mb-chev" aria-hidden="true" />}
    </button>
  );
}

// One open list (a top menu, or a submenu flying out of an item).
function MenuList({ anchor, items, open, onClose, onRun, side = null, label, onKeyNav, focusFirst, depth = 0 }) {
  const [sub, setSub] = useState(null);   // { item, el, focus }
  const subAnchor = useMemo(() => ({ current: sub?.el || null }), [sub]);
  const hasChecks = items.some((it) => it && it !== '-' && it.checked !== undefined);
  const id = `doc-mb-${depth}-${String(label).replace(/\W+/g, '')}`;
  useEffect(() => {
    if (!open || !focusFirst) return undefined;
    const t = requestAnimationFrame(() => document.getElementById(id)?.querySelector('button:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, focusFirst, id]);
  // A submenu closes with its parent.
  const subOpen = open && !!sub;
  return (
    <AnchoredMenu anchorRef={anchor} open={open} onClose={onClose} side={side} id={id} aria-label={label}
      className="doc-toolbar doc-ribbon doc-ribbon-panel doc-mb-panel"
      onKeyDown={(e) => {
        if (e.target.closest('.doc-mb-panel') !== e.currentTarget) return;   // keys inside a submenu are its own
        if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && depth === 0) { e.preventDefault(); onKeyNav?.(e.key === 'ArrowLeft' ? -1 : 1); return; }
        menuKeys(e, (refocus) => onClose(refocus));
      }}>
      {items.map((it, i) => (it === '-' || !it ? <div key={i} className="doc-ribbon-sep" role="separator" /> : (
        <ItemRow key={it.label} it={it} hasChecks={hasChecks} subOpen={sub?.item === it}
          onRun={onRun} onOpenSub={(s) => setSub((cur) => (s ? s : cur?.focus ? cur : null))} />
      )))}
      {sub && (
        <MenuList anchor={subAnchor} items={sub.item.items} open={subOpen} side="right" label={sub.item.label} depth={depth + 1}
          focusFirst={!!sub.focus} onRun={onRun}
          onClose={(refocus) => { const el = sub.el; setSub(null); if (refocus === true) el?.focus(); }} />
      )}
    </AnchoredMenu>
  );
}

export default function MenuBar({ menus, onSearchFocusKey = true }) {
  const [openIdx, setOpenIdx] = useState(null);
  const [byKey, setByKey] = useState(false);
  const btns = useRef([]);
  // A ref-shaped handle on the open menu's button (AnchoredMenu reads .current).
  const anchor = useMemo(() => ({ get current() { return openIdx == null ? null : btns.current[openIdx]; } }), [openIdx]);
  const close = useCallback((refocus) => {
    setOpenIdx((i) => { if (refocus === true && i != null) btns.current[i]?.focus(); return null; });
  }, []);
  const run = useCallback((it) => { setOpenIdx(null); if (!it.disabled) it.onClick?.(); }, []);
  const step = (dir) => { setByKey(true); setOpenIdx((i) => { const n = (((i ?? 0) + dir) % menus.length + menus.length) % menus.length; btns.current[n]?.focus(); return n; }); };

  // Search the menus (Alt+/ - Google Docs' key).
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const all = useMemo(() => flattenMenus(menus), [menus]);
  const needle = q.trim().toLowerCase();
  const hits = needle ? all.filter((it) => `${it.path.join(' ')} ${it.label} ${it.keywords || ''}`.toLowerCase().includes(needle)).slice(0, 12) : [];
  useEffect(() => {
    if (!onSearchFocusKey) return undefined;
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSearchFocusKey]);
  const runHit = (it) => { setQ(''); setSearchOpen(false); searchRef.current?.blur(); if (!it.disabled) it.onClick?.(); };

  return (
    <div className="doc-mb" role="menubar" aria-label="Document menu">
      {menus.map((m, i) => (
        <button key={m.label} ref={(el) => { btns.current[i] = el; }} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={openIdx === i}
          className={`doc-mb-top${openIdx === i ? ' is-open' : ''}`}
          onClick={() => { setByKey(false); setOpenIdx((o) => (o === i ? null : i)); }}
          onPointerEnter={() => { if (openIdx != null && openIdx !== i) { setByKey(false); setOpenIdx(i); } }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setByKey(true); setOpenIdx(i); }
            else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length; btns.current[n]?.focus(); if (openIdx != null) setOpenIdx(n); }
          }}>
          {m.label}
        </button>
      ))}
      {openIdx != null && menus[openIdx] && (
        <MenuList key={openIdx} anchor={anchor} items={menus[openIdx].items} open label={menus[openIdx].label}
          focusFirst={byKey} onRun={run} onClose={close} onKeyNav={step} />
      )}
      {/* A magnifier that opens into the search box over the row (click, or Alt+/), so it never crowds the menus. */}
      <div className={`doc-mb-search${q || searchOpen ? ' is-open' : ''}`} onClick={() => searchRef.current?.focus()} title="Search the menus (Alt+/)">
        <Search size={15} strokeWidth={2.2} aria-hidden="true" style={{ flex: '0 0 auto' }} />
        <input ref={searchRef} value={q} placeholder="Search menus (Alt+/)" aria-label="Search the menus"
          onChange={(e) => { setQ(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onBlur={() => { if (!q) setSearchOpen(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) { e.preventDefault(); runHit(hits[0]); }
            else if (e.key === 'Escape') { setQ(''); setSearchOpen(false); e.currentTarget.blur(); }
            else if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); document.getElementById('doc-mb-search-list')?.querySelector('button')?.focus(); }
          }} />
        {q && <button type="button" className="doc-mb-search-clear" aria-label="Clear" onClick={() => { setQ(''); searchRef.current?.focus(); }}><X size={12} /></button>}
      </div>
      <AnchoredMenu anchorRef={searchRef} open={searchOpen && !!needle} onClose={() => setSearchOpen(false)} id="doc-mb-search-list" align="start"
        className="doc-toolbar doc-ribbon doc-ribbon-panel doc-mb-panel" style={{ width: 340 }} aria-label="Matching commands"
        onKeyDown={(e) => menuKeys(e, () => { setSearchOpen(false); searchRef.current?.focus(); })}>
        {hits.length ? hits.map((it) => (
          <button key={`${it.path.join('>')}>${it.label}`} type="button" role="menuitem" className="doc-ribbon-item doc-mb-item" disabled={it.disabled} onClick={() => runHit(it)}>
            <span className="doc-mb-icon" aria-hidden="true">{it.checked ? <Check size={14} /> : it.icon ? <it.icon size={14} /> : null}</span>
            <span className="doc-mb-label">{it.label}<span className="doc-mb-path">{it.path.join(' › ')}</span></span>
            {it.shortcut && <kbd className="doc-mb-key">{shortcutText(it.shortcut)}</kbd>}
          </button>
        )) : <div className="doc-ribbon-pick-none">No command matches "{q.trim()}".</div>}
      </AnchoredMenu>
    </div>
  );
}

/** Help > Keyboard Shortcuts: every shortcut the menus carry, by menu. */
export function ShortcutsCard({ menus, onClose }) {
  const rows = flattenMenus(menus).filter((it) => it.shortcut);
  const byMenu = rows.reduce((acc, it) => { (acc[it.path[0]] ||= []).push(it); return acc; }, {});
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content nx-popup nx-center doc-mb-keys" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="doc-mb-keys-head">
          <b>Keyboard Shortcuts</b>
          <button type="button" className="nx-docb-hbtn is-icon" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="doc-mb-keys-body">
          {Object.entries(byMenu).map(([menu, list]) => (
            <section key={menu}>
              <h4>{menu}</h4>
              {list.map((it) => (
                <div key={`${it.path.join('>')}>${it.label}`} className="doc-mb-keys-row"><span>{it.cardLabel || it.label}</span><kbd className="doc-mb-key">{shortcutText(it.shortcut)}</kbd></div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
