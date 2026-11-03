// The offline bar (field offline, Neil 11/03/2026; docs/Offline.md) - one
// quiet line across the top of the page whenever there is something to say:
//
//   no signal     "Offline - your changes are saved on this phone and will
//                  send when you are back online."  [3 Waiting]
//   signed out    "Signed out - sign in when you have signal to send."  [Sign In]
//   sending       "Sending 3 changes saved on this phone"  [Sync Now]
//   needs a choice / refused   "1 change needs your choice"  [Review]
//
// Review opens the list of what waits (OutboxPanel, loaded on first use).
// No motion beyond the inline spinner while sending, so reduced motion is
// respected by construction. White-label: no product name in the words.
import { lazy, Suspense, useEffect, useState } from 'react';
import { CloudOff, CloudUpload, AlertTriangle, LogIn } from 'lucide-react';
import { useOffline, changes } from '../../lib/offline/useOffline';
import { barShown, bootOffline } from '../../lib/offline/status';
import { Spinner } from '../AsyncState';

const OutboxPanel = lazy(() => import('./OutboxPanel'));

const bar = (tone) => ({
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '8px 16px', fontSize: 13, fontWeight: 500, lineHeight: 1.45,
  background: tone === 'warn' ? 'hsla(38, 92%, 50%, 0.12)' : 'var(--wk-hover, rgba(100,116,139,0.10))',
  color: 'var(--ink, #1f2937)',
  borderBottom: '1px solid var(--line, rgba(0,0,0,0.08))',
});
const chip = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
  fontSize: 12, fontWeight: 700, background: 'var(--card, #fff)', border: '1px solid var(--line, rgba(0,0,0,0.12))',
  color: 'var(--ink, #1f2937)', cursor: 'pointer', fontFamily: 'inherit', minHeight: 28,
};

async function signIn() {
  const [{ BFF_MODE, bffLogin }, { msalInstance }, { loginRequest }] = await Promise.all([
    import('../../bffAuth'), import('../../msalInstance'), import('../../authConfig'),
  ]);
  if (BFF_MODE) bffLogin();
  else msalInstance.loginRedirect(loginRequest).catch(() => {});
}

export default function OfflineBar() {
  const s = useOffline();
  const [open, setOpen] = useState(false);
  // The bar mounts with the signed-in shell: start the outbox there (at idle).
  useEffect(() => { bootOffline(); }, []);
  const shown = barShown(s);
  const review = s.entries.length > 0
    ? <button type="button" style={chip} onClick={() => setOpen(true)}>Review</button> : null;

  let tone = 'calm';
  let icon = <CloudOff size={15} aria-hidden="true" />;
  let words;
  let actions = null;
  if (!s.online) {
    words = s.signedOut
      ? 'Offline and signed out - your changes are saved on this phone. Sign in when you have signal to send.'
      : 'Offline - your changes are saved on this phone and will send when you are back online.';
    actions = s.waiting > 0 ? <button type="button" style={chip} onClick={() => setOpen(true)}>{s.waiting} Waiting</button> : review;
  } else if (s.signedOut) {
    tone = 'warn';
    icon = <LogIn size={15} aria-hidden="true" />;
    words = `Signed out - sign in when you have signal to send${s.waiting ? ` (${changes(s.waiting)} waiting)` : ''}.`;
    actions = <><button type="button" style={chip} onClick={signIn}>Sign In</button>{review}</>;
  } else if (s.conflicts > 0 || s.failed > 0) {
    tone = 'warn';
    icon = <AlertTriangle size={15} aria-hidden="true" />;
    const parts = [];
    if (s.conflicts) parts.push(`${changes(s.conflicts)} ${s.conflicts === 1 ? 'needs' : 'need'} your choice`);
    if (s.failed) parts.push(`${changes(s.failed)} not sent`);
    words = parts.join(', ').replace(/^./, (c) => c.toUpperCase());
    actions = <button type="button" style={chip} onClick={() => setOpen(true)}>Review</button>;
  } else if (s.waiting > 0) {
    icon = s.sending ? <Spinner size="inline" label="Sending" /> : <CloudUpload size={15} aria-hidden="true" />;
    words = `${s.sending ? 'Sending' : 'Waiting to send'} ${changes(s.waiting)} saved on this phone`;
    actions = <><button type="button" style={chip} onClick={() => s.syncNow()}>Sync Now</button>{review}</>;
  }

  return (
    <>
      {shown && words && (
        <div role="status" aria-live="polite" className="nx-offline-bar" style={bar(tone)}>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
          <span style={{ flex: '1 1 220px', minWidth: 0 }}>{words}</span>
          {actions && <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>{actions}</span>}
        </div>
      )}
      {open && (
        <Suspense fallback={null}>
          <OutboxPanel onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
