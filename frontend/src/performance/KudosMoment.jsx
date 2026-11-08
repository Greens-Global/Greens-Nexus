// The recipient's moment (Neil, 11/08/2026): a kudos you have not seen yet
// slides in once as a small card - bottom right on a computer, the bottom
// of the screen on a phone - with the sender, the value and the whole
// message. Say Thanks posts your thanks (the reply; the sender gets one
// bell), Close marks it seen; either way it never comes back. Never under
// Act As. Mounted once in the shell (App.jsx), reads GET /kudos/unseen once
// per load.
import { useEffect, useRef, useState } from 'react';
import { Award, X } from 'lucide-react';
import { api, getActAsSessionId } from '../api';
import { Avatar } from '../tasks/components';
import { burstConfetti } from '../ui/Confetti';
import { ValueLabel } from './Kudos';

const shown = new Set();   // ids this load has already put on screen - a remount never repeats one
const CONFETTI_DELAY_MS = 120;   // the burst comes from the card as it arrives, not before

export default function KudosMoment() {
  const [queue, setQueue] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (getActAsSessionId()) return;
    let on = true;
    api.perfKudosUnseen().then(rows => {
      if (!on || !Array.isArray(rows)) return;
      const fresh = rows.filter(k => !shown.has(k.id));
      fresh.forEach(k => shown.add(k.id));
      setQueue(fresh);
    }).catch(() => {});
    return () => { on = false; };
  }, []);
  // Confetti, well done (Neil, 11/08/2026): once per card appearance - not
  // again on Say Thanks or Close; nothing under reduced motion (Confetti.jsx).
  const cardRef = useRef(null);
  const kid = queue[0]?.id || '';
  useEffect(() => {
    if (!kid) return undefined;
    let stop = () => {};
    const t = setTimeout(() => { if (cardRef.current) stop = burstConfetti(cardRef.current.getBoundingClientRect()); }, CONFETTI_DELAY_MS);
    return () => { clearTimeout(t); stop(); };
  }, [kid]);
  const k = queue[0];
  if (!k) return null;
  const next = () => { setQueue(q => q.slice(1)); setNote(''); };
  async function act(fn) {
    setBusy(true);
    try { await fn(); } catch { /* seen or thanked on the next load */ }
    finally { setBusy(false); next(); }
  }
  return (
    <div ref={cardRef} className="nx-kudos-moment" role="dialog" aria-label={`${k.fromName} sent you kudos`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="wkc-chip"><Award size={14} /></span>
        <Avatar email={k.fromEmail} name={k.fromName} size={28} card={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{k.fromName} sent you kudos</div>
          <ValueLabel value={k.value} />
        </div>
        <button type="button" className="nx-perf-icon-btn" aria-label="Dismiss" title="Dismiss" disabled={busy}
          onClick={() => act(() => api.perfKudosSeen(k.id))}><X size={15} /></button>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto' }}>{k.message}</div>
      <form onSubmit={e => { e.preventDefault(); act(() => api.perfKudosThank(k.id, note.trim())); }} style={{ display: 'grid', gap: 8 }}>
        <input className="form-input" value={note} onChange={e => setNote(e.target.value.slice(0, 200))} aria-label="Your reply"
          placeholder="A word back (optional)" style={{ fontSize: 16, padding: '7px 10px' }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(() => api.perfKudosSeen(k.id))} style={{ minHeight: 34 }}>Close</button>
          <button type="submit" className="primary-btn" disabled={busy} style={{ minHeight: 34 }}>Say Thanks</button>
        </div>
      </form>
    </div>
  );
}
