import { useState, useEffect } from 'react';
import { externalAuthPost as post, useResendTimer } from '../lib/externalAuth';

// ── External-user activation (/activate/{token}) - Aug 18 passwordless flow ──
// Unauthenticated by definition: the single-use token from the invitation
// email is the credential (proof of inbox ownership). The page validates it,
// verifies a 6-digit code (SMS via sent.dm when a phone is available, email
// otherwise), and lands the guest in the app on the same session cookie
// employees get. Branded to match the login page; never renders blank - every
// state (loading, invalid, error) paints something.

const page = { minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f5f7', fontFamily: "'Figtree','Inter',sans-serif", padding: 20 };
const card = { width: 440, maxWidth: '100%', background: '#ffffff', borderRadius: 16, border: '1px solid #e5e7eb', padding: '30px 30px 26px', boxSizing: 'border-box' };
const field = { width: '100%', padding: '11px 13px', borderRadius: 9, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#fff' };
const label = { fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 5, display: 'block' };
const primaryBtn = { width: '100%', padding: '12px 18px', borderRadius: 10, border: 'none', background: '#0f3d2e', color: '#fff', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const quietBtn = { background: 'none', border: 'none', color: '#0f3d2e', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 6, textDecoration: 'underline' };

function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, background: '#0f3d2e', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17 }}>N</span>
      <span style={{ fontSize: 17, fontWeight: 800, color: '#111827' }}>Nexus</span>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#6b7280', marginLeft: 'auto' }}>GREENS GLOBAL</span>
    </div>
  );
}

export default function ExternalActivate({ token }) {
  // switch = the account-switch confirmation (Aug 18, Visesh: activating a
  // guest silently replaced his admin session - now it warns first).
  const [phase, setPhase] = useState('loading');   // loading | invalid | switch | intro | code | done
  const [invite, setInvite] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState(null);      // { channel, hint }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalidMsg, setInvalidMsg] = useState('');
  const [resendLeft, startResend] = useResendTimer();

  useEffect(() => {
    let dead = false;
    post('/external-auth/activate/lookup', { token })
      .then(d => {
        if (dead) return;
        setInvite(d);
        // A DIFFERENT account already signed in on this browser: confirm the
        // switch before anything else - same email skips straight through.
        setPhase(d.sessionConflict && d.signedInAs ? 'switch' : 'intro');
      })
      .catch(e => { if (!dead) { setInvalidMsg(e.message); setPhase('invalid'); } });
    return () => { dead = true; };
  }, [token]);

  const sendCode = async (channel = '') => {
    setBusy(true); setError('');
    try {
      const d = await post('/external-auth/activate/send-code', { token, phone: phone.trim(), channel });
      setSentTo({ channel: d.channel, hint: d.hint, delivered: d.delivered });
      setPhase('code'); setCode(''); startResend(30);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const verify = async () => {
    setBusy(true); setError('');
    try {
      await post('/external-auth/activate/verify', { token, code: code.trim() });
      setPhase('done');
      window.location.assign('/');
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div style={page}>
      <div style={card}>
        <Brand />

        {phase === 'loading' && (
          <div style={{ padding: '38px 0', textAlign: 'center' }}>
            <div style={{ width: 30, height: 30, margin: '0 auto 12px', borderRadius: '50%', border: '3px solid #e5e7eb', borderTopColor: '#0f3d2e', animation: 'spin .7s linear infinite' }} />
            <div style={{ fontSize: 13.5, color: '#6b7280' }}>Checking your invitation…</div>
            <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
          </div>
        )}

        {phase === 'invalid' && (
          <div style={{ padding: '18px 0 6px' }}>
            <h1 style={{ margin: '0 0 10px', fontSize: 19, color: '#111827' }}>This link is not valid</h1>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: '#6b7280' }}>
              {invalidMsg || 'This invitation link is invalid, already used, or expired - ask your Greens Global contact to send a new one.'}
            </p>
          </div>
        )}

        {phase === 'switch' && invite && (
          <>
            <h1 style={{ margin: '0 0 8px', fontSize: 20, color: '#111827' }}>Switch accounts?</h1>
            <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.6, color: '#374151' }}>
              You are signed in as <strong>{invite.signedInAs?.name}</strong>. Continuing signs that
              account out on this browser and activates this invitation for <strong>{invite.email}</strong>.
            </p>
            <div style={{ display: 'grid', gap: 9 }}>
              <button style={primaryBtn} onClick={() => setPhase('intro')}>Continue</button>
              <button style={{ ...primaryBtn, background: '#fff', color: '#0f3d2e', border: '1.5px solid #0f3d2e' }}
                onClick={() => window.location.assign('/')}>
                Cancel
              </button>
            </div>
            <p style={{ margin: '14px 0 0', fontSize: 12, lineHeight: 1.55, color: '#6b7280' }}>
              Cancel leaves your current sign-in untouched and takes you back to Nexus.
            </p>
          </>
        )}

        {phase === 'intro' && invite && (
          <>
            <h1 style={{ margin: '0 0 8px', fontSize: 20, color: '#111827' }}>Welcome, {invite.firstName || invite.name}</h1>
            <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.6, color: '#374151' }}>
              {invite.invitedBy} invited you{invite.company ? ` (${invite.company})` : ''} to Greens Global Nexus.
              Verify it's you to finish setting up your access.
            </p>
            <div style={{ marginBottom: 13 }}>
              <span style={label}>Email</span>
              <input style={{ ...field, background: '#f9fafb', color: '#6b7280' }} value={invite.email} readOnly />
            </div>
            {invite.hasPhone ? (
              <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.55, color: '#374151' }}>
                We can text a code to the phone ending {invite.phoneMasked}.
              </p>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <span style={label}>Mobile phone (optional - lets you sign in by text next time)</span>
                <input style={field} type="tel" placeholder="+1 555 555 1234" value={phone}
                  onChange={e => setPhone(e.target.value)} />
              </div>
            )}
            {error && <div style={{ margin: '0 0 12px', fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{error}</div>}
            <div style={{ display: 'grid', gap: 9 }}>
              {(invite.hasPhone || phone.trim()) && (
                <button style={primaryBtn} disabled={busy} onClick={() => sendCode('')}>Text Me a Code</button>
              )}
              <button style={(invite.hasPhone || phone.trim()) ? { ...primaryBtn, background: '#fff', color: '#0f3d2e', border: '1.5px solid #0f3d2e' } : primaryBtn}
                disabled={busy} onClick={() => sendCode('email')}>
                Email Me a Code
              </button>
            </div>
          </>
        )}

        {phase === 'code' && (
          <>
            <h1 style={{ margin: '0 0 8px', fontSize: 20, color: '#111827' }}>Enter your code</h1>
            <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.6, color: '#374151' }}>
              {sentTo?.delivered === false
                ? 'We could not send the code automatically - use resend, or contact your Greens Global contact.'
                : sentTo?.channel === 'sms'
                  ? `We texted a 6-digit code to ${sentTo.hint}.`
                  : 'We emailed you a 6-digit code. Check spam if you don\'t see it.'}
            </p>
            <input style={{ ...field, fontSize: 24, letterSpacing: 10, textAlign: 'center', fontWeight: 700 }}
              inputMode="numeric" autoFocus maxLength={6} placeholder="______" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter' && code.length === 6) verify(); }} />
            {error && <div style={{ margin: '10px 0 0', fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{error}</div>}
            <button style={{ ...primaryBtn, marginTop: 14 }} disabled={busy || code.length !== 6} onClick={verify}>
              Verify and Continue
            </button>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
              <button style={{ ...quietBtn, opacity: resendLeft ? 0.5 : 1 }} disabled={busy || resendLeft > 0}
                onClick={() => sendCode(sentTo?.channel === 'sms' ? '' : 'email')}>
                {resendLeft > 0 ? `Resend in ${resendLeft}s` : 'Resend Code'}
              </button>
              {sentTo?.channel === 'sms' && (
                <button style={{ ...quietBtn, opacity: resendLeft ? 0.5 : 1 }} disabled={busy || resendLeft > 0}
                  onClick={() => sendCode('email')}>
                  Send to My Email Instead
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'done' && (
          <div style={{ padding: '26px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#111827', marginBottom: 6 }}>You're in</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>Taking you to Nexus…</div>
          </div>
        )}
      </div>
    </div>
  );
}
