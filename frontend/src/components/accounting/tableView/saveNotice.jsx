import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { saveFailureText, usePrefsSaveFailure } from '../prefs';

// Round 3, fix 6: a saved view that did not reach the person's account (over
// the 120,000-character layout limit, no connection, the server refused it)
// says so, in the app's toast style - it used to fail silently. One notice a
// screen however many tables it has: the first bar mounted shows it. On
// document.body, so the bar's own layout (the More menu) never counts it.

const SHOW_MS = 12000;
let owner = null;

export default function SaveNotice() {
  const me = useRef({});
  const [mine, setMine] = useState(false);
  useEffect(() => {
    if (!owner) { owner = me.current; setMine(true); }
    return () => { if (owner === me.current) owner = null; };
  }, []);
  const [failure, dismiss] = usePrefsSaveFailure();
  useEffect(() => {
    if (!failure || !mine) return undefined;
    const t = setTimeout(dismiss, SHOW_MS);
    return () => clearTimeout(t);
  }, [failure, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mine || !failure || typeof document === 'undefined') return null;
  return createPortal(
    <div role="alert" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'hsl(var(--color-red))', color: '#fff', borderRadius: 10, padding: '10px 12px 10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: 'min(560px, 90vw)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{saveFailureText(failure)}</span>
      <button type="button" onClick={dismiss} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', display: 'inline-flex', padding: 2, flexShrink: 0 }}><X size={14} /></button>
    </div>,
    document.body,
  );
}
