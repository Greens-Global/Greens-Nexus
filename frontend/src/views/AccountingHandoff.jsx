import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldX, RefreshCw, ArrowLeft } from 'lucide-react';
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

const STEPS = [
  { key: 'arrive', label: 'Arrived from Nexus Accounting' },
  { key: 'check', label: 'Checking your access in Nexus' },
  { key: 'signin', label: 'Signing you in to Nexus Accounting' },
];

export default function AccountingHandoff({ next }) {
  const [phase, setPhase] = useState('check'); // check | signin | denied | error
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    started.current = true;
    let alive = true;
    setPhase('check');
    setMessage('');
    const t = setTimeout(() => {
      api.launchAccounting(next)
        .then(({ url }) => {
          if (!alive) return;
          setPhase('signin');
          // Let the dot travel back before the page leaves; replace() so Back
          // does not return to a half-finished handoff.
          setTimeout(() => { if (alive) window.location.replace(url); }, 1100);
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
    }, 900);
    return () => { alive = false; clearTimeout(t); };
  }, [next, attempt]);

  const stepState = (key) => {
    const order = ['arrive', 'check', 'signin'];
    const current = phase === 'signin' ? 2 : 1;
    const idx = order.indexOf(key);
    if (phase === 'denied' || phase === 'error') return idx < 1 ? 'done' : idx === 1 ? 'failed' : 'todo';
    return idx < current ? 'done' : idx === current ? 'active' : 'todo';
  };

  const traveling = phase === 'check' || phase === 'signin';
  const direction = phase === 'signin' ? 'back' : 'forward';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <style>{`
        @keyframes nxTravelForward { 0% { left: 0%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
        @keyframes nxTravelBack    { 0% { left: 100%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { left: 0%; opacity: 0; } }
        @keyframes nxNodePulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(43,69,225,0.28); } 50% { box-shadow: 0 0 0 14px rgba(43,69,225,0); } }
        @keyframes nxNodePulseGreen { 0%, 100% { box-shadow: 0 0 0 0 rgba(21,128,61,0.28); } 50% { box-shadow: 0 0 0 14px rgba(21,128,61,0); } }
      `}</style>
      <div style={{ width: 'min(560px, 100%)', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 16, boxShadow: 'var(--shadow-md, 0 10px 30px rgba(0,0,0,.08))', padding: '32px 32px 28px', animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
        {/* Travel track */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
          <Node label="Nexus Accounting" color="#15803d" pulse={phase === 'signin' ? 'nxNodePulseGreen' : null} />
          <div style={{ position: 'relative', flex: 1, height: 4, borderRadius: 2, background: 'var(--border-color)' }}>
            {traveling && (
              <span style={{
                position: 'absolute', top: -5, marginLeft: -7, width: 14, height: 14, borderRadius: '50%',
                background: direction === 'back' ? '#15803d' : 'var(--wk-brand, #2b45e1)',
                boxShadow: '0 0 0 4px rgba(43,69,225,0.15)',
                animation: `${direction === 'back' ? 'nxTravelBack' : 'nxTravelForward'} 1.1s ease-in-out infinite`,
              }} />
            )}
            {phase === 'denied' && <span style={{ position: 'absolute', left: '50%', top: -9, marginLeft: -11, width: 22, height: 22, borderRadius: '50%', background: 'var(--bad-bg)', color: 'var(--bad-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldX size={14} /></span>}
          </div>
          <Node label="Nexus" color="var(--wk-brand, #2b45e1)" pulse={phase === 'check' ? 'nxNodePulse' : null} />
        </div>

        {/* Headline */}
        {phase === 'denied' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--bad-bg)', color: 'var(--bad-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldX size={18} /></span>
              <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Access Denied</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.5, margin: '0 0 18px' }}>
              Nexus Accounting is limited to people who have been granted the Nexus Accounting App in Roles &amp; Access. Ask an administrator to add you, then try again.
            </p>
          </>
        ) : phase === 'error' ? (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.25rem' }}>Could not reach Nexus Accounting</h2>
            <p style={{ color: 'var(--bad-fg)', fontSize: '0.9rem', margin: '0 0 18px' }}>{message}</p>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: phase === 'signin' ? 'var(--ok-bg)' : 'var(--wk-brand-tint, #e8ecfd)', color: phase === 'signin' ? 'var(--ok-fg)' : 'var(--wk-brand, #2b45e1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldCheck size={18} /></span>
              <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{phase === 'signin' ? 'Access confirmed' : 'Checking your access'}</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', margin: '0 0 18px' }}>
              {phase === 'signin' ? 'Taking you back to Nexus Accounting, signed in.' : 'Nexus decides who can open the accounting app. One moment.'}
            </p>
          </>
        )}

        {/* Steps */}
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {STEPS.map((s) => {
            const st = stepState(s.key);
            const color = st === 'done' ? 'var(--ok-fg)' : st === 'active' ? 'var(--wk-brand, #2b45e1)' : st === 'failed' ? 'var(--bad-fg)' : 'var(--text-muted)';
            return (
              <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', color: st === 'todo' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${color}`, background: st === 'done' ? color : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700, animation: st === 'active' ? 'pulse 1.2s ease-in-out infinite' : 'none' }}>
                  {st === 'done' ? '✓' : st === 'failed' ? '!' : ''}
                </span>
                {s.label}
              </li>
            );
          })}
        </ol>

        {(phase === 'denied' || phase === 'error') && (
          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => { window.location.assign('/'); }}>
              <ArrowLeft size={15} /> Back to Nexus
            </button>
            <button type="button" className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => setAttempt((a) => a + 1)}>
              <RefreshCw size={15} /> Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Node({ label, color, pulse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, minWidth: 96 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22, letterSpacing: -1, animation: pulse ? `${pulse} 1.4s ease-out infinite` : 'none' }}>N</div>
      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'center' }}>{label}</span>
    </div>
  );
}
