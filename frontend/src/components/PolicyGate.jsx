import { useState, useEffect } from 'react';
import { ShieldCheck, Loader2, Check } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { PolicyText, formatPolicyVersion } from '../lib/policyText';

// ── Sign-in company-policy & monitoring acknowledgment ────────────────────────
// Standing, portal-wide gate: the first time a person signs in - and again when
// the policy version changes - they must accept before the app loads. Acceptance
// is recorded server-side (who/when/version/ip/ua). Distinct from the per-day
// clock-in monitoring notice.
//
// The title, text and version come from the server (/policy/status, edited in
// Settings > Global Settings > Branding & Policies > Sign-In Policy) - nothing
// is hardcoded here any more. The text is rendered as plain text blocks
// (lib/policyText.jsx), never as HTML.
//
// SAFETY: fail-OPEN. We only block when the server explicitly says the current
// version is unaccepted AND sends the text to show; on any error, on a reply
// without the text (an older API mid-deploy), or in E2E we render the app, so a
// backend blip can never lock the whole company out. The person is simply asked
// again at their next sign-in. Accepting sends the version that was on screen;
// if a newer one was published meanwhile the server refuses (409) and the gate
// reloads the new text instead of recording a stale acceptance.
const _E2E = import.meta.env.VITE_E2E === 'true';

export default function PolicyGate({ children }) {
  // 'loading' → checking; 'ok' → accepted/skip; 'gate' → must accept
  const [state, setState] = useState(_E2E ? 'ok' : 'loading');
  const [policy, setPolicy] = useState(null);   // { title, body, version }
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load(live = () => true) {
    return api.policyStatus()
      .then(r => {
        if (!live()) return;
        if (r?.accepted === false && r.body && r.version) {
          setPolicy({ title: r.title || 'Company Policies', body: r.body, version: r.version });
          setState('gate');
        } else setState('ok');
      })
      .catch(() => { if (live()) setState('ok'); });   // fail-open on any error
  }

  useEffect(() => {
    if (_E2E) return;
    let live = true;
    load(() => live);
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function accept() {
    if (busy || !agree) return;
    setBusy(true); setErr('');
    try {
      await api.policyAccept(policy.version);
      setState('ok');
    } catch (e) {
      if (e?.status === 409) {
        await load();
        setAgree(false);
        setErr('The policy was just updated. Please review the new version below.');
      } else {
        setErr(e?.message || 'Could not record your acknowledgment. Please try again.');
      }
      setBusy(false);
    }
  }

  if (state === 'ok') return children;
  if (state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading" style={{ maxWidth: 620, margin: '12vh auto 0', padding: 20 }}>
        <SkeletonBlocks count={3} height={70} borderRadius={12} />
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
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{policy.title}</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>Please read and accept to continue.</p>
          </div>
        </div>

        <div style={{ padding: '18px 26px', overflowY: 'auto', flex: 1 }}>
          <PolicyText body={policy.body} />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Version {formatPolicyVersion(policy.version)} · <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>Privacy Policy</a> · <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>Terms & Conditions</a>
          </div>
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
            Accept & Continue
          </button>
        </div>
      </div>
    </div>
  );
}
