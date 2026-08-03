import { useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';

// Reusable full-screen image viewer: opens an image over the app (no new tab),
// with prev/next (on-screen buttons + ← / → keys), a counter, an "open full size"
// link, and Esc / click-outside to close. Shared by the Screenshots gallery
// (dashboard modal) and the Time admin Screenshots tab.
//   shots:    [{ id, url, at?, activeView?, idleSec? }]
//   index:    the open shot's index, or null when closed
//   setIndex: (i | updater) => void   (pass null to close)
const t = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export default function ImageLightbox({ shots, index, setIndex }) {
  useEffect(() => {
    if (index === null || index === undefined || !shots) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setIndex(null);
      else if (e.key === 'ArrowRight') { e.preventDefault(); setIndex(i => (i !== null && i < shots.length - 1 ? i + 1 : i)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex(i => (i !== null && i > 0 ? i - 1 : i)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, shots, setIndex]);

  if (index === null || index === undefined || !shots || !shots[index]) return null;
  const s = shots[index];
  const atStart = index === 0, atEnd = index === shots.length - 1;
  const step = (e, d) => { e.stopPropagation(); setIndex(i => Math.min(shots.length - 1, Math.max(0, i + d))); };
  const navBtn = (side, disabled) => ({ position: 'absolute', [side]: 12, top: '50%', transform: 'translateY(-50%)', width: 46, height: 46, borderRadius: 999, border: 'none', background: 'rgba(255,255,255,0.14)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.25 : 1 });

  return (
    <div onClick={() => setIndex(null)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.86)', zIndex: 1470, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Inter,sans-serif' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', color: '#fff' }}>
        {s.at && <span style={{ fontSize: 14, fontWeight: 700 }}>{t(s.at)}</span>}
        <span style={{ fontSize: 12.5, opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.activeView || ''}{s.idleSec >= 300 ? ` · idle ${Math.round(s.idleSec / 60)}m` : ''}
        </span>
        <span style={{ fontSize: 12.5, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{index + 1} / {shots.length}</span>
        <a href={s.url} target="_blank" rel="noopener noreferrer" title="Open full size in a new tab"
          style={{ color: '#fff', opacity: 0.75, display: 'flex' }}><ExternalLink size={16} /></a>
        <button onClick={() => setIndex(null)} aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', display: 'flex', padding: 4 }}><X size={20} /></button>
      </div>
      <button onClick={(e) => step(e, -1)} disabled={atStart} aria-label="Previous frame" style={navBtn('left', atStart)}><ChevronLeft size={26} /></button>
      <img src={s.url} alt={`Capture ${t(s.at)}`} onClick={e => e.stopPropagation()}
        style={{ maxWidth: '90vw', maxHeight: '80vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 10px 50px rgba(0,0,0,0.6)' }} />
      <button onClick={(e) => step(e, 1)} disabled={atEnd} aria-label="Next frame" style={navBtn('right', atEnd)}><ChevronRight size={26} /></button>
    </div>
  );
}
