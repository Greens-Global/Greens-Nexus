// ── Step-up MFA — real, Entra-native re-verification before sensitive data ────
// Replaces the vault's old client-side "MFA theater" (browser-generated codes).
// `ensureStepUp()` guarantees the caller has a fresh, server-verified step-up
// session before proceeding: it checks the server, and if needed triggers a
// live Entra challenge (Microsoft Authenticator push, or SMS if registered),
// then verifies the resulting token server-side. One step-up unlocks a short
// burst so users aren't re-prompted per item.
//
// Usage in any click handler:
//   const r = await ensureStepUp();
//   if (!r.ok) return;            // cancelled / failed — do nothing
//   ...reveal the secret / open payroll...
//
// Mount <StepUpOverlay/> once (App.jsx) for the "approve the prompt…" UI.

import { useState, useEffect } from 'react';
import { ShieldCheck, Loader2, X } from 'lucide-react';
import { msalInstance } from '../msalInstance';
import { stepUpReauthRequest } from '../authConfig';
import { api } from '../api';

let _inFlight = null;   // dedupe concurrent challenges into one popup

function emit(detail) {
  try { window.dispatchEvent(new CustomEvent('nexus:stepup', { detail })); } catch { /* noop */ }
}

async function _run() {
  // 1) Already verified within the active window? Nothing to do.
  const st = await api.stepupStatus().catch(() => null);
  if (st && st.active) return { ok: true, already: true };

  // 2) Feature not enforced yet (Entra not configured) → no-op; the backend
  //    also no-ops require_stepup, so behaviour is unchanged until it's turned on.
  const cfg = await api.stepupConfig().catch(() => null);
  if (!cfg || !cfg.enforced) return { ok: true, enforced: false };

  // 3) Enforced → force a fresh Microsoft re-login via a FULL-PAGE REDIRECT.
  //    (Popups hung in some setups when the response couldn't hand back to the
  //    opener; a redirect can't hang.) The page navigates away now; on return,
  //    msalInstance's event handler verifies the fresh token server-side and
  //    signals 'verified'. The user then repeats their action with the session
  //    active. ensureStepUp resolves 'redirecting' just before the page unloads.
  emit({ phase: 'start' });
  try {
    sessionStorage.setItem('nexus:stepup:pending', '1');
    const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    await msalInstance.acquireTokenRedirect({ ...stepUpReauthRequest, account });
    return { ok: false, redirecting: true };
  } catch (e) {
    sessionStorage.removeItem('nexus:stepup:pending');
    emit({ phase: 'end', ok: false, error: String(e?.errorCode || e?.message || e) });
    return { ok: false, error: String(e) };
  }
}

// Guarantees a fresh step-up session (or a clean no-op when the feature is off /
// already satisfied). Concurrent calls share one in-flight challenge.
export function ensureStepUp() {
  if (_inFlight) return _inFlight;
  _inFlight = _run().finally(() => { _inFlight = null; });
  return _inFlight;
}

// True when an API error is the backend asking for step-up (require_stepup 403).
// Auto-loading views (payroll, HR comp) catch this to show a Verify gate rather
// than popping a challenge on mount (popups need a user gesture).
export function isStepUpRequired(err) {
  return err?.status === 403 &&
    (err?.detail?.code === 'stepup_required' || /stepup_required/i.test(err?.message || ''));
}

// Inline "verify to view" card for auto-loading sensitive views. The Verify
// button (a real user gesture) runs the Entra challenge, then calls onVerified.
export function StepUpNeeded({ label, onVerified }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function verify() {
    setBusy(true); setErr('');
    const r = await ensureStepUp();
    setBusy(false);
    if (r.ok) onVerified?.();
    else if (!r.cancelled) setErr('Verification didn’t complete. Please try again.');
  }
  return (
    <div style={{ maxWidth: 460, margin: '32px auto', textAlign: 'center', background: 'var(--card)',
      border: '1px solid var(--line)', borderRadius: 16, padding: '30px 26px', fontFamily: 'Inter,sans-serif' }}>
      <div style={{ width: 48, height: 48, borderRadius: '50%', margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'hsla(var(--color-blue),0.12)' }}>
        <ShieldCheck size={26} style={{ color: 'hsl(var(--color-blue))' }} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Verify your identity</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
        {label || 'This is sensitive information.'} Re-confirm your Microsoft sign-in to continue (with Authenticator / SMS if prompted).
      </div>
      {err && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginBottom: 12 }}>{err}</div>}
      <button className="primary-btn" onClick={verify} disabled={busy}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}>
        {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={14} />}
        {busy ? 'Verifying…' : 'Verify to view'}
      </button>
    </div>
  );
}

// One global overlay shown while an Entra challenge is in flight.
if (typeof document !== 'undefined' && !document.getElementById('stepup-anim')) {
  const s = document.createElement('style');
  s.id = 'stepup-anim';
  s.textContent = `@keyframes suFade{from{opacity:0}to{opacity:1}}
    @keyframes suPop{from{transform:translateY(8px) scale(.98)}to{transform:none}}`;
  document.head.appendChild(s);
}

export function StepUpOverlay() {
  const [state, setState] = useState(null);   // null idle | {phase:'start'|'verified'|'error'}
  useEffect(() => {
    // On load, if we just returned from a step-up redirect that succeeded, the
    // msal handler fires 'verified' — but it may fire before this mounts, so also
    // show the success note if the marker was just cleared this session.
    const on = (e) => {
      const d = e.detail || {};
      if (d.phase === 'start') setState({ phase: 'start' });
      else if (d.phase === 'verified') setState({ phase: 'verified' });
      else if (d.phase === 'end') {
        if (d.ok || !d.error) setState(null);
        else setState({ phase: 'error', error: d.error });
      }
    };
    window.addEventListener('nexus:stepup', on);
    return () => window.removeEventListener('nexus:stepup', on);
  }, []);
  // Auto-dismiss the success note.
  useEffect(() => {
    if (state?.phase !== 'verified') return;
    const t = setTimeout(() => setState(null), 3200);
    return () => clearTimeout(t);
  }, [state]);
  if (!state) return null;

  const card = (children) => (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center',
      background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(3px)', animation: 'suFade .15s ease' }}>
      <div style={{ width: 'min(92vw, 380px)', background: 'var(--card)', border: '1px solid var(--line)',
        borderRadius: 16, padding: '26px 24px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center',
        fontFamily: 'Inter,sans-serif', animation: 'suPop .2s cubic-bezier(.22,1,.36,1)' }}>{children}</div>
    </div>
  );

  if (state.phase === 'error') return card(<>
    <div style={{ width: 44, height: 44, borderRadius: '50%', margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'hsla(var(--color-red),0.12)' }}>
      <X size={22} style={{ color: 'hsl(var(--color-red))' }} /></div>
    <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Verification didn’t complete</div>
    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>We couldn’t confirm your identity. Nothing was shown. Please try again.</div>
    <button className="primary-btn" onClick={() => setState(null)} style={{ fontSize: 13 }}>Close</button>
  </>);

  if (state.phase === 'verified') return card(<>
    <div style={{ width: 46, height: 46, borderRadius: '50%', margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'hsla(var(--color-green),0.14)' }}>
      <ShieldCheck size={24} style={{ color: 'hsl(var(--color-green))' }} /></div>
    <div style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Identity verified</div>
    <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>You can now view the protected information for the next few minutes.</div>
  </>);

  // 'start' — redirecting to Microsoft
  return card(<>
    <div style={{ width: 46, height: 46, borderRadius: '50%', margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'hsla(var(--color-blue),0.12)' }}>
      <ShieldCheck size={24} style={{ color: 'hsl(var(--color-blue))' }} /></div>
    <div style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Confirming it’s you</div>
    <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16 }}>
      Taking you to <strong>Microsoft</strong> to re-confirm your sign-in — approve the Authenticator / SMS prompt if asked. You’ll come right back.
    </div>
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12 }}>
      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Redirecting…
    </div>
  </>);
}
