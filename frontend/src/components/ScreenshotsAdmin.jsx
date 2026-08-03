import { useState, useEffect, useCallback } from 'react';
import { X, Camera, ChevronLeft, Loader2, MoonStar } from 'lucide-react';
import { api } from '../api';
import ImageLightbox from './ImageLightbox';

// ── Admin → Screenshots - work-session capture gallery ───────────────────────
// Pick a day → people with captures → their frames (signed URLs, 1h expiry).
// Idle badge shows how long since the last keyboard/mouse input at capture.

const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export default function ScreenshotsAdmin({ onClose }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [people, setPeople] = useState(null);
  const [who, setWho] = useState(null);       // {email, name}
  const [shots, setShots] = useState(null);
  const [viewIdx, setViewIdx] = useState(null);   // open lightbox at this shot index

  const loadPeople = useCallback(() => {
    setPeople(null); setWho(null); setShots(null); setViewIdx(null);
    api.timeShots(date).then(r => setPeople(r.people || [])).catch(() => setPeople([]));
  }, [date]);
  useEffect(() => { loadPeople(); }, [loadPeople]);

  useEffect(() => {
    if (!who) return;
    setShots(null); setViewIdx(null);
    api.timeShots(date, who.email).then(r => setShots(r.shots || [])).catch(() => setShots([]));
  }, [who, date]);


  return (
    <>
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 900, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {who && (
            <button onClick={() => setWho(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
              <ChevronLeft size={17} />
            </button>
          )}
          <Camera size={16} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>
            Screenshots{who ? ` - ${who.name}` : ''}
          </h3>
          <input className="form-input" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ fontSize: 12, width: 150 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {!who && (
            people === null
              ? <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
              : people.length === 0
                ? <div style={{ textAlign: 'center', padding: '30px 20px', fontSize: 12.5, color: 'var(--muted)' }}>
                    No captures on this day. Frames are saved every 5 minutes while someone is clocked in with screen capture on.
                  </div>
                : <div style={{ display: 'grid', gap: 8 }}>
                    {people.map(p => (
                      <button key={p.email} onClick={() => setWho(p)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                          border: '1.5px solid var(--line)', background: 'var(--card)', fontFamily: 'Inter,sans-serif' }}>
                        <Camera size={15} style={{ color: 'var(--pine)' }} />
                        <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>{p.name}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{p.count} frame{p.count === 1 ? '' : 's'}</span>
                      </button>
                    ))}
                  </div>
          )}

          {who && (
            shots === null
              ? <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
              : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                  {shots.map((s, i) => (
                    <button key={s.id} onClick={() => setViewIdx(i)} title="Click to view - use arrow keys to browse"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--mist)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                      <img src={s.url} alt={`Capture ${localTime(s.at)}`} loading="lazy"
                        style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
                        <span style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--ink)' }}>{localTime(s.at)}</span>
                        <span style={{ fontSize: 10.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.activeView}</span>
                        {s.idleSec >= 300 && (
                          <span title={`No input for ${Math.round(s.idleSec / 60)} min at capture`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 800, color: '#b45309' }}>
                            <MoonStar size={10} /> idle {Math.round(s.idleSec / 60)}m
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
          )}
        </div>
      </div>
    </div>

    <ImageLightbox shots={shots} index={viewIdx} setIndex={setViewIdx} />
    </>
  );
}
