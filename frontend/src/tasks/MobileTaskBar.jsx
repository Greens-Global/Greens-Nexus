// Task Module - Asana-style floating bottom bar for mobile: [filter] · [view ⇅] · [+].
// Replaces the stacked view-tabs strip + filter row on phones. Used by MyTasksView
// and TasksWorkspace; desktop keeps its own toolbars (this renders only on mobile).
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, Plus, ChevronsUpDown, X, Check, ChevronLeft } from 'lucide-react';
import { NX, FONT, btn } from './theme';
import { useVisualViewport } from '../lib/useVisualViewport';
import { useIsMobile } from '../lib/useIsMobile';
import { useScrollLock } from '../lib/useScrollLock';
import { useDialogFocus, trapTab } from '../lib/useDialogFocus';
import { useBackToClose } from '../lib/useBackToClose';
import { isBypassing, confirmDiscard } from '../lib/dialogGuard';

// useVisualViewport (lib/useVisualViewport.js): the part of the screen the user
// can actually see. iOS Safari slides the keyboard OVER the layout viewport
// instead of shrinking it, so a sheet anchored with `inset: 0` ended up behind
// the keyboard with only its header showing (iPhone 14 / 17 Pro Max, Sept 28
// 2026). The sheet is pinned to the visual viewport instead; where the API is
// missing it falls back to inset: 0.

// Bottom-anchored sheet (the top-anchored Modal in components.jsx doesn't fit here).
// `onBack` (optional) renders a back arrow - used for the Asana-style filter drill-in.
export function BottomSheet({ title, onClose, onBack, children }) {
  const vv = useVisualViewport();
  const isMobile = useIsMobile();
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (onBack || onClose)(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onBack]);
  useScrollLock(isMobile);
  useDialogFocus(panelRef);
  // The phone's Back button does what Escape does: steps out of a drill-in
  // level when there is one, otherwise closes the sheet - asking first if
  // something typed in it would be lost (lib/dialogGuard.js marks that).
  useBackToClose(isMobile, () => {
    if (onBack) { onBack(); return; }
    if (overlayRef.current?.hasAttribute('data-nx-dirty') && !isBypassing()) {
      confirmDiscard().then((ok) => { if (ok) onClose(); });
      return;
    }
    onClose();
  });
  return createPortal(
    <div ref={overlayRef} className="nx-tasks-portal" onClick={onClose} style={{
      position: 'fixed', left: 0, right: 0,
      ...(vv ? { top: vv.top, height: vv.height } : { top: 0, bottom: 0 }),
      background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      {/* role="dialog" on the panel; .nx-sheet keeps style.css's generic
          phone bottom-sheet rules off it - this one is shaped here. */}
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapTab}
        className="nx-sheet" onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, outline: 'none',
        // A share of the VISIBLE height, so with the keyboard up the sheet
        // still fits above it and its body scrolls instead of hiding.
        maxHeight: vv ? Math.round(vv.height * 0.92) : '82vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 -12px 40px rgba(0,0,0,0.28)',
        // A border gives the sheet a visible edge in dark mode, where the surface
        // is close to the canvas and the drop shadow is invisible.
        border: `1px solid ${NX.border}`, borderBottom: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '13px 18px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          {onBack && <button onClick={onBack} style={{ ...btn('ghost'), padding: 6, marginLeft: -6 }} aria-label="Back"><ChevronLeft size={18} /></button>}
          <div id={titleId} style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{title}</div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6, marginLeft: 'auto' }} aria-label="Close"><X size={18} /></button>
        </div>
        {/* minHeight 0 is what lets this scroll: a flex child defaults to
            min-height auto, so without it the body grew past maxHeight and
            its lower fields were simply cut off. */}
        <div style={{
          padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', overflowY: 'auto', minHeight: 0, flex: '1 1 auto',
          overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
        }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// `hasModuleNav` (default true): the module shows its own bottom tab bar
// (MobileNav.jsx), so this floats above it. A screen without one (Tickets)
// passes false and the bar sits just above the home indicator instead.
// `createLabel`: what the + button is called (tooltip and screen readers).
export default function MobileTaskBar({ views, view, setView, onCreate, filterSheet, hasModuleNav = true, createLabel = 'Create task' }) {
  const [sheet, setSheet] = useState(null); // 'filter' | 'view' | null
  const current = views.find((v) => v.key === view) || views[0];
  const seg = { display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', color: NX.ink, fontFamily: FONT };

  return (
    <>
      <div style={{
        // Floats above the module's own bottom tab bar (Home/My Tasks/Projects/…
        // - MobileNav.jsx's TASK_ACTIONS), which reserves 64px + the safe-area
        // inset at the true screen bottom (see .main-content in style.css).
        position: 'fixed', left: '50%', transform: 'translateX(-50%)',
        bottom: hasModuleNav ? 'calc(64px + env(safe-area-inset-bottom) + 18px)' : 'calc(env(safe-area-inset-bottom) + 16px)',
        width: 'min(58vw, 320px)', height: 52,
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16,
        boxShadow: '0 10px 30px rgba(0,0,0,0.22)', display: 'flex', alignItems: 'stretch', zIndex: 2500, overflow: 'hidden',
      }}>
        <button onClick={() => setSheet('filter')} title="Filters & sort" aria-label="Filters & sort" style={{ ...seg, width: 54, color: NX.blue }}><SlidersHorizontal size={20} /></button>
        <span style={{ width: 1, background: NX.border, alignSelf: 'stretch' }} />
        <button onClick={() => setSheet('view')} style={{ ...seg, flex: 1, gap: 6, fontSize: 15, fontWeight: 600 }}>{current?.label} <ChevronsUpDown size={16} style={{ color: NX.faint }} /></button>
        <span style={{ width: 1, background: NX.border, alignSelf: 'stretch' }} />
        <button onClick={onCreate} title={createLabel} aria-label={createLabel} style={{ ...seg, width: 58, background: NX.primary, color: '#fff' }}><Plus size={22} /></button>
      </div>

      {sheet === 'view' && (
        <BottomSheet title="View" onClose={() => setSheet(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {views.map((v) => {
              const on = v.key === view;
              return (
                <button key={v.key} onClick={() => { setView(v.key); setSheet(null); }} style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 12px', border: 'none', borderRadius: 10,
                  background: on ? NX.surface2 : 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, fontFamily: FONT,
                  color: on ? NX.blue : NX.ink, textAlign: 'left',
                }}><v.icon size={18} /> <span style={{ flex: 1 }}>{v.label}</span> {on && <Check size={16} />}</button>
              );
            })}
          </div>
        </BottomSheet>
      )}

      {sheet === 'filter' && filterSheet(() => setSheet(null))}
    </>
  );
}
