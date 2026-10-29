// The header's Create menu (Neil, Oct 29 2026): a "+" beside the search bar
// that starts the everyday "new" things from any screen - a task, a ticket, a
// document, a request - without hunting for the module and its New button.
// What it offers, how each row opens its module's own create flow, and who
// sees which row: lib/quickCreate.js. This file is the button and the menu
// (the menu button pattern: Enter, Space or Down opens it on the first row,
// the arrows, Home and End move, Escape closes back to the "+", Tab or a
// click elsewhere closes).
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { ModalLoading } from './AsyncState';
import { visibleCreates, groupCreates, goTo } from '../lib/quickCreate';

const QuickActionModal = lazy(() => import('../dashboard/QuickActionModals.jsx'));

export default function QuickCreate() {
  const role = useRole() || {};
  const myEmail = role.myEmail || '';
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(null);   // a QuickActionModal kind
  // Performance's hasTeam, asked once per person when the menu first opens.
  const [team, setTeam] = useState({ email: '', has: false });
  const askedRef = useRef(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const mayOneOnOne = visibleCreates(role, { hasTeam: true }).some((i) => i.team);
  useEffect(() => {
    if (!open || !mayOneOnOne || askedRef.current === myEmail) return;
    askedRef.current = myEmail;
    api.perfMe().then((ctx) => setTeam({ email: myEmail, has: !!ctx?.hasTeam })).catch(() => {});
  }, [open, mayOneOnOne, myEmail]);

  const items = visibleCreates(role, { hasTeam: team.email === myEmail && team.has });
  const groups = groupCreates(items);

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  // Opening puts focus on the first row, so the arrow keys work at once.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open]);

  // A click or tap anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open, close]);

  function onMenuKey(e) {
    const rows = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    const at = rows.indexOf(document.activeElement);
    const move = (i) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
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
      <button ref={btnRef} type="button" className="icon-btn qc-btn" aria-label="Create" title="Create"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'qc-menu' : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}>
        <Plus style={{ width: 18, height: 18 }} strokeWidth={2.2} />
      </button>
      {open && (
        <div id="qc-menu" ref={menuRef} role="menu" aria-label="Create" className="header-user-dropdown qc-menu" onKeyDown={onMenuKey}>
          {groups.map((g, gi) => (
            <div key={g.label} role="group" aria-labelledby={`qc-sec-${gi}`}>
              {gi > 0 && <div className="hud-divider" role="separator" />}
              <div className="hud-sec" id={`qc-sec-${gi}`}>{g.label}</div>
              {g.items.map((it) => (
                <button key={it.key} type="button" role="menuitem" tabIndex={-1} className="hud-item qc-item" onClick={() => pick(it)}>
                  <it.Icon size={15} style={{ flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true" /> {it.label}
                </button>
              ))}
            </div>
          ))}
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
