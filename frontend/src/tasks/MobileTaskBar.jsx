// Task Module - Asana-style floating bottom bar for mobile: [filter] · [view ⇅] · [+].
// Replaces the stacked view-tabs strip + filter row on phones. Used by MyTasksView
// and TasksWorkspace; desktop keeps its own toolbars (this renders only on mobile).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, Plus, ChevronsUpDown, X, Check, ChevronLeft } from 'lucide-react';
import { NX, FONT, btn } from './theme';

// Bottom-anchored sheet (the top-anchored Modal in components.jsx doesn't fit here).
// `onBack` (optional) renders a back arrow - used for the Asana-style filter drill-in.
export function BottomSheet({ title, onClose, onBack, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (onBack || onClose)(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onBack]);
  return createPortal(
    <div className="nx-tasks-portal" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '82vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 -12px 40px rgba(0,0,0,0.28)',
        // A border gives the sheet a visible edge in dark mode, where the surface
        // is close to the canvas and the drop shadow is invisible.
        border: `1px solid ${NX.border}`, borderBottom: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '13px 18px', borderBottom: `1px solid ${NX.border}` }}>
          {onBack && <button onClick={onBack} style={{ ...btn('ghost'), padding: 6, marginLeft: -6 }} aria-label="Back"><ChevronLeft size={18} /></button>}
          <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{title}</div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6, marginLeft: 'auto' }} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
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
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 18,
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
