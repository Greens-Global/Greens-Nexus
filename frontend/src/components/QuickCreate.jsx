// The header's Quick Actions menu (Neil, 11/12/2026): a green bolt beside the
// search bar that starts the everyday things from any screen - a task, a
// ticket, a note, a request - without hunting for the module and its New
// button. It took over from the "+" Create menu (Neil, Oct 29 2026).
// What it offers, how each row opens its module's own create flow, who sees
// which row and how the rows are laid out: lib/quickCreate.js. This file is
// the button and the menu, in two steps:
//   First tap  - the top row (four icons, one tap each) and a row per group.
//   Second tap - a group row slides to its own list, with a line back.
// The menu button pattern: Enter, Space or Down opens it on the first action;
// the arrows, Home and End move (Left and Right walk the top row); Right
// opens a group and Left or Escape steps back out of one; a letter jumps to
// the next row that starts with it; Escape closes back to the bolt; Tab or a
// click elsewhere closes. C then T from anywhere opens New Task (Neil,
// 11/07/2026, keyboard triage) - never while typing or over an open dialog.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ArrowLeft } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { ModalLoading } from './AsyncState';
import BoltIcon from './icons/BoltIcon';
import { visibleActions, layoutActions, goTo } from '../lib/quickCreate';

const QuickActionModal = lazy(() => import('../dashboard/QuickActionModals.jsx'));

const NAME = 'Quick Actions';
// "C T" reads "C then T" in a tooltip.
const spoken = (keys) => keys.split(' ').join(' then ');

function Keys({ keys }) {
  return (
    <span className="hud-end" aria-hidden="true">
      {keys.split(' ').map((k) => <span key={k} className="hud-kbd">{k}</span>)}
    </span>
  );
}

export default function QuickCreate() {
  const role = useRole() || {};
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState('');             // '' = the first tap, else the open group's key
  const [composing, setComposing] = useState(null);   // a QuickActionModal kind
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [cameFrom, setCameFrom] = useState('');       // the group just stepped back out of

  const items = visibleActions(role);
  const { tiles, rows } = layoutActions(items);
  const group = rows.find((r) => r.kind === 'group' && r.key === level) || null;

  const close = useCallback((refocus) => {
    setOpen(false);
    setLevel('');
    setCameFrom('');
    if (refocus) btnRef.current?.focus();
  }, []);
  const stepBack = useCallback(() => { setCameFrom(level); setLevel(''); }, [level]);

  // Opening, or stepping into a group, puts focus on the first action, so
  // the arrow keys work at once; stepping back returns it to the group's row.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const back = !level && cameFrom ? menu?.querySelector(`[data-group="${cameFrom}"]`) : null;
    (back || menu?.querySelector('[role="menuitem"]:not(.qc-back)'))?.focus();
  }, [open, level, cameFrom]);

  // A click or tap anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open, close]);

  // C then T within a second opens New Task, when this person may make one.
  const canTask = items.some((it) => it.key === 'task');
  useEffect(() => {
    if (!canTask) return undefined;
    let armedAt = 0;
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest?.('.excalidraw'))) return;
      if (document.querySelector('[role=dialog]')) return;
      const key = (e.key || '').toLowerCase();
      if (key === 't' && armedAt && Date.now() - armedAt < 1000) { e.preventDefault(); armedAt = 0; close(false); setComposing('task'); return; }
      armedAt = key === 'c' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canTask, close]);

  function onMenuKey(e) {
    const all = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    const el = document.activeElement;
    const at = all.indexOf(el);
    const onTile = !!el?.classList?.contains('qc-tile');
    const focus = (node) => { if (node) { e.preventDefault(); node.focus(); } };
    const move = (i) => focus(all[(i + all.length) % all.length]);
    const firstRow = all.find((n) => !n.classList.contains('qc-tile'));
    if (e.key === 'ArrowDown') { if (onTile && firstRow) focus(firstRow); else move(at + 1); }
    else if (e.key === 'ArrowUp') { if (onTile) move(-1); else if (el === firstRow && all[0] !== firstRow) focus(all[0]); else move(at - 1); }
    else if (e.key === 'ArrowRight') { if (el?.dataset?.group) { e.preventDefault(); setLevel(el.dataset.group); } else if (onTile) move(at + 1); }
    else if (e.key === 'ArrowLeft') { if (level) { e.preventDefault(); stepBack(); } else if (onTile) move(at - 1); }
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (level) stepBack(); else close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A letter jumps to the next row that starts with it ("t": Task, then Ticket).
      const ch = e.key.toLowerCase();
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      focus(order.find((n) => (n.dataset.ta || '').startsWith(ch)));
    }
  }

  function pick(it) {
    close(false);
    if (it.compose) setComposing(it.compose);
    else if (it.run) it.run();
    else if (it.go) goTo(it.go[0], it.go[1]);
  }

  if (!items.length) return null;

  return (
    <div className="qc-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="icon-btn qc-btn" aria-label={NAME} title={NAME}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'qc-menu' : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}>
        <BoltIcon size={24} className="qc-bolt" />
      </button>
      {open && (
        <div id="qc-menu" ref={menuRef} role="menu" aria-label={group ? group.label : NAME} className="header-user-dropdown qc-menu" onKeyDown={onMenuKey}>
          {!group ? (
            <div role="none" className={`qc-level${cameFrom ? ' is-back' : ''}`}>
              <div className="hud-sec" aria-hidden="true">{NAME}</div>
              {tiles.length > 0 && (
                <div className="qc-tiles" role="none">
                  {tiles.map((it) => (
                    <button key={it.key} type="button" role="menuitem" tabIndex={-1} className="qc-tile" data-ta={it.short.toLowerCase()}
                      title={it.keys ? `${it.label} (${spoken(it.keys)})` : undefined} aria-keyshortcuts={it.keys || undefined} onClick={() => pick(it)}>
                      <span className="qc-tile-ico" aria-hidden="true"><it.Icon size={20} /></span>
                      <span className="qc-tile-label">{it.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {tiles.length > 0 && rows.length > 0 && <div className="hud-divider" role="separator" />}
              {rows.map((r) => (r.kind === 'group' ? (
                <button key={r.key} type="button" role="menuitem" tabIndex={-1} className="hud-item qc-item qc-group" data-group={r.key} data-ta={r.label.toLowerCase()}
                  aria-haspopup="menu" aria-expanded="false" aria-label={r.label} title={r.hint} onClick={() => setLevel(r.key)}>
                  <r.Icon size={15} style={{ flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true" />
                  <span className="qc-group-text">
                    <span className="qc-group-name">{r.label}</span>
                    <span className="qc-group-hint">{r.hint}</span>
                  </span>
                  <ChevronRight size={15} className="qc-chev" aria-hidden="true" />
                </button>
              ) : (
                <button key={r.item.key} type="button" role="menuitem" tabIndex={-1} className="hud-item qc-item" data-ta={r.item.label.toLowerCase()} onClick={() => pick(r.item)}>
                  <r.item.Icon size={15} style={{ flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true" /> {r.item.label}
                </button>
              )))}
            </div>
          ) : (
            <div role="none" className="qc-level qc-sub" key={group.key}>
              <button type="button" role="menuitem" tabIndex={-1} className="hud-item qc-item qc-back" aria-label={`Back to ${NAME}`} onClick={stepBack}>
                <ArrowLeft size={14} aria-hidden="true" /> {NAME}
              </button>
              <div className="qc-title" aria-hidden="true">{group.label}</div>
              {group.items.map((it) => (
                <button key={it.key} type="button" role="menuitem" tabIndex={-1} className="hud-item qc-item" data-ta={it.short.toLowerCase()}
                  aria-keyshortcuts={it.keys || undefined} onClick={() => pick(it)}>
                  <it.Icon size={15} style={{ flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true" /> {it.short}
                  {it.keys && <Keys keys={it.keys} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* At the page root: the header's backdrop blur would box a fixed overlay. */}
      {composing && createPortal(
        <Suspense fallback={<ModalLoading />}>
          <QuickActionModal kind={composing} onClose={() => setComposing(null)} />
        </Suspense>,
        document.body,
      )}
    </div>
  );
}
