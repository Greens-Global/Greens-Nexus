// Task Module - Asana-style floating bottom bar for mobile: [filter] · [view ⇅] · [+].
// Replaces the stacked view-tabs strip + filter row on phones. Used by MyTasksView
// and TasksWorkspace; desktop keeps its own toolbars (this renders only on mobile).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, Plus, ChevronsUpDown, X, Check, ChevronLeft } from 'lucide-react';
import { NX, FONT, btn } from './theme';

// The part of the screen the user can actually see. iOS Safari does not shrink
// the layout viewport (what `position: fixed; inset: 0` and `vh` measure) when
// the keyboard opens - it slides the keyboard OVER it - so a sheet anchored to
// the bottom of the layout viewport ends up behind the keyboard, with only its
// header showing (iPhone 14 / 17 Pro Max, Sept 28 2026). The visual viewport
// does shrink, so the overlay is pinned to that instead. Null where the API is
// missing, and the overlay falls back to inset: 0.
function useVisualViewport() {
  const read = () => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    return vv ? { top: vv.offsetTop, height: vv.height } : null;
  };
  const [box, setBox] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () => setBox(read());
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  return box;
}

// Bottom-anchored sheet (the top-anchored Modal in components.jsx doesn't fit here).
// `onBack` (optional) renders a back arrow - used for the Asana-style filter drill-in.
export function BottomSheet({ title, onClose, onBack, children }) {
  const vv = useVisualViewport();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (onBack || onClose)(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onBack]);
  return createPortal(
    <div className="nx-tasks-portal" onClick={onClose} style={{
      position: 'fixed', left: 0, right: 0,
      ...(vv ? { top: vv.top, height: vv.height } : { top: 0, bottom: 0 }),
      background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18,
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
          <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{title}</div>
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

export default function MobileTaskBar({ views, view, setView, onCreate, filterSheet }) {
  const [sheet, setSheet] = useState(null); // 'filter' | 'view' | null
  const current = views.find((v) => v.key === view) || views[0];
  const seg = { display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', color: NX.ink, fontFamily: FONT };

  return (
    <>
      <div style={{
        // Floats above the module's own bottom tab bar (Home/My Tasks/Projects/…
        // - MobileNav.jsx's TASK_ACTIONS), which reserves 64px + the safe-area
        // inset at the true screen bottom (see .main-content in style.css).
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(64px + env(safe-area-inset-bottom) + 18px)',
        width: 'min(58vw, 320px)', height: 52,
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16,
        boxShadow: '0 10px 30px rgba(0,0,0,0.22)', display: 'flex', alignItems: 'stretch', zIndex: 2500, overflow: 'hidden',
      }}>
        <button onClick={() => setSheet('filter')} title="Filters & sort" aria-label="Filters & sort" style={{ ...seg, width: 54, color: NX.blue }}><SlidersHorizontal size={20} /></button>
        <span style={{ width: 1, background: NX.border, alignSelf: 'stretch' }} />
        <button onClick={() => setSheet('view')} style={{ ...seg, flex: 1, gap: 6, fontSize: 15, fontWeight: 600 }}>{current?.label} <ChevronsUpDown size={16} style={{ color: NX.faint }} /></button>
        <span style={{ width: 1, background: NX.border, alignSelf: 'stretch' }} />
        <button onClick={onCreate} title="Create task" aria-label="Create task" style={{ ...seg, width: 58, background: NX.primary, color: '#fff' }}><Plus size={22} /></button>
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
