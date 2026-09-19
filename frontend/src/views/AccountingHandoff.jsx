import { useEffect, useState } from 'react';
import { ShieldX, RefreshCw, ArrowLeft } from 'lucide-react';
import { api } from '../api';

// /sso/accounting - the "Login via Nexus" landing for accounting.greensglobal.com.
//
// The accounting app has no passwords: its login page sends people here,
// Nexus (already signed in through Microsoft by the time this renders) asks
// the backend for a one-time sign-in link, and the browser travels back with
// it. The backend only answers for people granted the "Nexus Accounting App"
// module in Roles & Access (or administrators), so a 403 here is the access
// decision - shown as Access Denied, never as a broken page.
//
// Rendered as a full-screen layer above the normal shell (see App.jsx).
//
// Deliberately plain (Neil, 09/18 - "Speed > Fancy"): this used to hold the
// page for ~2s of staged animation. Now the launch call fires on mount and the
// browser leaves the moment the link comes back; all anyone sees is a spinner.

export default function AccountingHandoff({ next }) {
  const [phase, setPhase] = useState('check'); // check | denied | error
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setPhase('check');
    setMessage('');
    api.launchAccounting(next)
      .then(({ url }) => {
        // replace() so Back does not return to a half-finished handoff.
        if (alive) window.location.replace(url);
      })
      .catch((e) => {
        if (!alive) return;
        const status = e?.status ?? e?.response?.status;
        const text = String(e?.message || '');
        if (status === 403 || /don't have access|403/i.test(text)) {
          setPhase('denied');
        } else {
          setPhase('error');
          setMessage(text || 'Could not reach Nexus Accounting.');
        }
      });
    return () => { alive = false; };
  }, [next, attempt]);

  if (phase === 'check') {
    return (
      <div role="status" aria-live="polite" style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
        <style>{`@keyframes nxHandoffSpin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--wk-brand, #2b45e1)', animation: 'nxHandoffSpin 0.8s linear infinite' }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.92rem' }}>Opening Nexus Accounting...</span>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ width: 'min(560px, 100%)', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 16, boxShadow: 'var(--shadow-md, 0 10px 30px rgba(0,0,0,.08))', padding: '32px 32px 28px' }}>
        {phase === 'denied' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--bad-bg)', color: 'var(--bad-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldX size={18} /></span>
              <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Access Denied</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.5, margin: 0 }}>
              Nexus Accounting is limited to people who have been granted the Nexus Accounting App in Roles &amp; Access. Ask an administrator to add you, then try again.
            </p>
          </>
        ) : (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.25rem' }}>Could Not Reach Nexus Accounting</h2>
            <p style={{ color: 'var(--bad-fg)', fontSize: '0.9rem', margin: 0 }}>{message}</p>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => { window.location.assign('/'); }}>
            <ArrowLeft size={15} /> Back to Nexus
          </button>
          <button type="button" className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => setAttempt((a) => a + 1)}>
            <RefreshCw size={15} /> Try Again
          </button>
        </div>
      </div>
    </div>
  );
}
