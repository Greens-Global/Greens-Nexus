import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../api';
import { turnOnLocation } from '../lib/punchLocation';
import { useIsMobile } from '../lib/useIsMobile';

// Location Off at clock-in (Neil, Oct 21 2026). The punch never waits on a
// location; a clock-in that landed without one raises this red bar - the
// priority bar's shape, in red - until the person answers it:
//   Turn On - the browser's own Allow prompt (or the steps to allow it when
//             it is blocked); the fix goes on that clock-in.
//   Skip    - the clock-in reads Location Off and the manager gets a notice.
// The punch response says when to ask (`locationAsk`; never for people exempt
// from screen monitoring) and lib/punchQueue.js raises `nexus:location-ask`.
// It is remembered in this browser so a reload does not lose it.

const STORE_KEY = 'nexus:location-ask';
const MAX_AGE_MS = 16 * 60 * 60 * 1000;   // the length of a shift; the server answers Skip that long

const BAR = {
  position: 'sticky', top: 0, zIndex: 60,
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', margin: '0 0 8px',
  background: '#FDE2E2', color: '#7f1d1d', border: '1px solid #f19999', borderRadius: 10, fontSize: '0.84rem',
  boxShadow: '0 2px 8px rgba(127, 29, 29, 0.14)',
};
const BTN = { border: '1px solid #e07a7a', background: '#fff1f1', color: '#7f1d1d', borderRadius: 8, padding: '4px 10px', font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 };
const PRIMARY = { ...BTN, background: '#b91c1c', borderColor: '#b91c1c', color: '#fff' };
const DONE = { ...BAR, background: '#DCFCE7', color: '#14532d', border: '1px solid #86efac', boxShadow: 'none' };

export const LOCATION_ASK_TEXT = 'It looks like you have turned off your location. Nexus uses location analytics for the team - please turn it on so Nexus can work properly.';

function readAsk() {
  try {
    const at = Number(localStorage.getItem(STORE_KEY) || 0);
    return at > 0 && Date.now() - at < MAX_AGE_MS;
  } catch { return false; }
}
function writeAsk(on) {
  try {
    if (on) localStorage.setItem(STORE_KEY, String(Date.now()));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage blocked - the bar still shows for this page */ }
}

export default function LocationNoticeBar() {
  const phone = useIsMobile();
  const [ask, setAsk] = useState(readAsk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  useEffect(() => {
    const on = () => { writeAsk(true); setAsk(true); setDone(''); setError(''); };
    window.addEventListener('nexus:location-ask', on);
    return () => window.removeEventListener('nexus:location-ask', on);
  }, []);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(''), 5000);
    return () => clearTimeout(t);
  }, [done]);
  const finish = (msg) => { writeAsk(false); setAsk(false); setDone(msg); };

  const turnOn = async () => {
    setBusy(true); setError('');
    try {
      const pos = await turnOnLocation();
      if (!pos) return;   // Not Now - the bar stays, Skip is still there
      await api.timePunchLocation(pos).catch(() => null);   // too late to place it is fine: location is on from here
      finish('Thank you - your location is on.');
    } finally { setBusy(false); }
  };
  const skip = async () => {
    setBusy(true); setError('');
    try {
      await api.timePunchLocationSkip();
      finish('Okay - your clock-in shows Location Off on your Time Sheet.');
    } catch (e) {
      setError(e?.message || 'Could not save that. Please try again.');
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div role="status" style={DONE}>
        <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
        <span>{done}</span>
      </div>
    );
  }
  if (!ask) return null;
  const buttons = (
    <span style={{ display: 'inline-flex', gap: 8, flexShrink: 0 }}>
      <button type="button" style={BTN} onClick={skip} disabled={busy}>Skip</button>
      <button type="button" style={PRIMARY} onClick={turnOn} disabled={busy}>{busy ? 'Working...' : 'Turn On'}</button>
    </span>
  );
  return (
    <div role="alert" aria-label="Location is off" style={phone ? { ...BAR, display: 'block', padding: '8px 10px' } : BAR}>
      <div style={{ display: 'flex', alignItems: phone ? 'flex-start' : 'center', gap: 10, flex: 1, minWidth: 0 }}>
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: phone ? 2 : 0 }} />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
          <strong>Needs Attention: Location Is Off</strong>
          <span style={phone ? { display: 'block', marginTop: 2 } : { marginLeft: 8 }}>{LOCATION_ASK_TEXT}</span>
          {error && <span style={{ display: 'block', marginTop: 2, fontWeight: 600 }}>{error}</span>}
        </div>
      </div>
      {phone ? <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>{buttons}</div> : buttons}
    </div>
  );
}
