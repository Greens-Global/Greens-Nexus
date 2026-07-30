import { useState, useEffect } from 'react';
import { ShieldCheck, Loader2, Check } from 'lucide-react';
import { api } from '../api';

// ── Sign-in company-policy & monitoring acknowledgment ────────────────────────
// Standing, portal-wide gate: the first time a person signs in - and again when
// POLICY_VERSION changes - they must accept before the app loads. Acceptance is
// recorded server-side (who/when/version/ip/ua). Distinct from the per-day
// clock-in monitoring notice.
//
// SAFETY: fail-OPEN. We only block when the server explicitly says the current
// version is unaccepted; on any error (or in E2E) we render the app, so a backend
// blip can never lock the whole company out.
//
// Keep POLICY_VERSION in lockstep with backend/routers/policy.py.
const POLICY_VERSION = '2026-07-21';
const _E2E = import.meta.env.VITE_E2E === 'true';

// ⚠️ PLACEHOLDER WORDING - replace the sections below with the company's
// finalized policy / T&C text (HR + legal). The mechanism (versioning, recording,
// re-prompt on change, downloadable copy) is what's built here; the exact legal
// language is yours to set.
const POLICY_SECTIONS = [
  { h: 'Acceptable use',
    p: 'Nexus and the devices you use to access it are company property, provided for work. Use them in line with your organization’s policies. Do not share your access or use the portal for anything unlawful.' },
  { h: 'Employee monitoring (please read)',
    p: 'On company-managed devices, while you are clocked in, Nexus may capture periodic screenshots of your work screen(s), record which applications and window titles are active, and measure your overall activity level. This is to verify worked time and support performance review. It does NOT capture your keystrokes, and it stops when you clock out. Capture never runs on a personal device unless you explicitly share your screen.' },
  { h: 'How the data is used',
    p: 'Monitoring data is visible to your manager and HR for time-verification, performance, and payroll purposes, and is retained per company policy. It is not sold or shared outside the company.' },
  { h: 'Your acknowledgment',
    p: 'By accepting, you confirm you have read and understood these policies and the monitoring described above, and you agree to comply while using Nexus on company devices. You can review the policies you have accepted at any time from your profile.' },
];

export default function PolicyGate({ children }) {
  // 'loading' → checking; 'ok' → accepted/skip; 'gate' → must accept
  const [state, setState] = useState(_E2E ? 'ok' : 'loading');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (_E2E) return;
    let live = true;
    api.policyStatus()
      .then(r => { if (live) setState(r?.accepted === false ? 'gate' : 'ok'); })
      .catch(() => { if (live) setState('ok'); });   // fail-open on any error
    return () => { live = false; };
  }, []);

  async function accept() {
    if (busy || !agree) return;
    setBusy(true); setErr('');
    try {
      await api.policyAccept();
      setState('ok');
    } catch (e) {
      setErr(e?.message || 'Could not record your acknowledgment. Please try again.');
      setBusy(false);
    }
  }

  if (state === 'ok') return children;
  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
      </div>
    );
  }

  // state === 'gate'
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--bg, #f4f5f7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: 'Inter,sans-serif' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
        width: '100%', maxWidth: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '20px 26px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 11 }}>
          <ShieldCheck size={22} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Company policies & monitoring</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>Please read and accept to continue.</p>
          </div>
        </div>

        <div style={{ padding: '18px 26px', overflowY: 'auto', flex: 1 }}>
          {POLICY_SECTIONS.map(s => (
            <div key={s.h} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>{s.h}</div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{s.p}</p>
            </div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Version {POLICY_VERSION}</div>
        </div>

        <div style={{ padding: '14px 26px 20px', borderTop: '1px solid var(--line)' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>I have read and understood the policies above, including the monitoring disclosure, and I agree to comply.</span>
          </label>
          {err && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>{err}</div>}
          <button className="primary-btn" onClick={accept} disabled={!agree || busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, padding: '11px 24px',
              opacity: (!agree || busy) ? 0.55 : 1 }}>
            {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={15} />}
            Accept & continue
          </button>
        </div>
      </div>
    </div>
  );
}
