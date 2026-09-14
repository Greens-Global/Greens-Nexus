/*
THESIS: signing in feels like opening a premium work OS (canon, owner-pinned:
monday.com-grade) - a confident split hero: the product's world on the left,
one calm action on the right.
OWN-WORLD: Work OS (DESIGN.md) - brand panel with floating module cards
(CSS-drawn, no fabricated numbers), white sign-in column, Figtree type, one
Microsoft action. Accent defaults to green (Pranshu, Jul 28) and is a Global
Admin-configurable setting, not hardcoded - see ACCENT_PALETTES below and
backend/routers/branding.py.
STORY: an employee lands, sees what Nexus IS (tasks, time, people) at a
glance, presses the single button, and is at work.
FIRST VIEWPORT: left - brand mark, headline, module cards; right - "Welcome
to Nexus", Microsoft button, SSO note. Nothing else.
FORM: category standard played straight at full fidelity (owner's canon call,
Jul 28); craft bar monday.com's login.
*/
import { useEffect, useState } from "react";
import { useMsal } from "@azure/msal-react";
import { CheckSquare, Clock, Users, Boxes, Gauge, Receipt, FolderOpen } from "lucide-react";
import { loginRequest } from "../authConfig";
import { useBranding } from "../lib/queries";
import { BFF_MODE, clearSignedOutMarker } from "../bffAuth";
import { externalAuthPost, useResendTimer } from "../lib/externalAuth";

// Accent is a saved company setting, not hardcoded - see
// backend/routers/branding.py (no admin UI to change it any more as of Sep
// 9). The hero panel needs three gradient stops (not just one brand color),
// so this keeps its own small
// palette rather than trying to force everything through the single
// --wk-brand var the rest of the app reads (see lib/brandAccent.js).
const ACCENT_PALETTES = {
  blue:  { light: "#3a52e6", base: "#2b45e1", dark: "#1f36c7", tint: "#e8ecfd", shadow: "rgba(43,69,225,.28)" },
  green: { light: "hsl(142,55%,42%)", base: "hsl(142,60%,35%)", dark: "hsl(142,65%,25%)", tint: "hsla(142,60%,35%,0.14)", shadow: "hsla(142,60%,35%,.28)" },
};

export default function LoginPage() {
  const { instance } = useMsal();
  const [on, setOn] = useState(false);
  // One-shot notice for an account Nexus refused (external allowlist, Aug 17):
  // the person authenticated with Microsoft but isn't enrolled/active in Nexus.
  const [denied] = useState(() => {
    try {
      const d = sessionStorage.getItem('nexus:access-denied') || '';
      sessionStorage.removeItem('nexus:access-denied');
      return d;
    } catch { return ''; }
  });
  const { data: branding } = useBranding();
  const accent = branding?.accent === "blue" ? "blue" : "green";

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) { setOn(true); return; }
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // BFF cookie mode signs in via the server (/api/auth/login); MSAL mode uses the
  // redirect flow. Same button, same page - so prod and dev look identical either way.
  const signIn = () => {
    // Explicit click: lift the fresh-logout guard that suppresses AUTO re-login
    // (bffAuth.bffLogin) so the user's own sign-in is never blocked by it.
    clearSignedOutMarker();
    if (BFF_MODE) {
      // Pass the last signed-in email as login_hint so Entra preselects the
      // account instead of showing "Pick an account".
      let hint = '';
      try { hint = localStorage.getItem('nexus:lastEmail') || ''; } catch { /* storage blocked */ }
      window.location.href = "/api/auth/login" + (hint ? `?hint=${encodeURIComponent(hint)}` : '');
      return;
    }
    instance.loginRedirect(loginRequest);
  };

  // ── Partner Sign-In (Aug 18): passwordless flow for EXTERNAL users ─────────
  // Two quiet screens under the Microsoft button: email -> 6-digit code (SMS
  // to their verified phone via sent.dm, else email). Employees' MSAL flow is
  // untouched; the server always answers the email step generically, so this
  // screen can never confirm whether an account exists.
  const [partner, setPartner] = useState(null);         // null | 'email' | 'switch' | 'code'
  const [pEmail, setPEmail] = useState('');
  const [pCode, setPCode] = useState('');
  const [pBusy, setPBusy] = useState(false);
  const [pError, setPError] = useState('');
  // Account-switch confirmation (Aug 18): a browser already signed in as a
  // DIFFERENT account must confirm before the code sign-in replaces that
  // session. pSwitch holds who is signed in; pSwitchOk remembers Continue so
  // a resend doesn't re-ask.
  const [pSwitch, setPSwitch] = useState(null);
  const [pSwitchOk, setPSwitchOk] = useState(false);
  const [resendLeft, startResend] = useResendTimer();

  const exitPartner = () => { setPartner(null); setPSwitch(null); setPSwitchOk(false); setPError(''); };

  const partnerRequest = async (channel = '') => {
    if (!pEmail.trim() || !pEmail.includes('@')) { setPError('Enter your email address.'); return; }
    setPBusy(true); setPError('');
    try {
      const d = await externalAuthPost('/external-auth/request-code', { email: pEmail.trim(), channel });
      setPCode(''); startResend(30);
      if (d.sessionConflict && d.signedInAs && !pSwitchOk) {
        setPSwitch(d.signedInAs);
        setPartner('switch');
      } else {
        setPartner('code');
      }
    } catch { setPError('Could not reach the server - try again.'); }
    setPBusy(false);
  };

  const partnerVerify = async () => {
    setPBusy(true); setPError('');
    try {
      await externalAuthPost('/external-auth/login-verify', { email: pEmail.trim(), code: pCode.trim() });
      window.location.assign('/');
    } catch (e) {
      setPError(e.message || 'Invalid or expired code.');
      setPBusy(false);
    }
  };

  const P = ACCENT_PALETTES[accent];
  // What Nexus IS, at a glance. Insights & BI carries its own card next to
  // Operations rather than living inside the Operations line (Sagar, Sep 15).
  const PANELS = [
    { Icon: CheckSquare, tint: "#dff3fc", fg: "#0998c3", title: "Tasks", sub: "Projects, boards and deadlines" },
    { Icon: Clock,       tint: P.tint,     fg: P.base,    title: "Time & Attendance", sub: "Punch in, timesheets, payroll" },
    { Icon: Users,       tint: "#e6f7ef", fg: "#00a25b", title: "People", sub: "Profiles, leave and documents" },
    { Icon: Boxes,       tint: "#fff3e3", fg: "#c26f00", title: "Operations", sub: "Items, purchases and requisitions" },
    { Icon: Gauge,       tint: "#ecebfe", fg: "#5145cd", title: "Insights & BI", sub: "KPIs and analytics, every module" },
    { Icon: Receipt,     tint: "#f1ecfe", fg: "#6c3ef4", title: "Accounting", sub: "Invoices, bills and reconciliation" },
    { Icon: FolderOpen,  tint: "#e8f5f7", fg: "#0d7f94", title: "Files", sub: "Documents, storage and sharing" },
  ];

  return (
    <div className={`nxl${on ? " nxl-on" : ""}`}>
      {/* Left: the product's world - brand panel with floating module cards */}
      <aside className="nxl-hero" aria-hidden="true">
        <div className="nxl-hero-wash" />
        <div className="nxl-hero-brand" style={{ "--i": 0 }}>
          <span className="nxl-mark nxl-mark--inverse">N</span>
          <span className="nxl-hero-name">Nexus</span>
        </div>
        {/* One column, centered in the panel (Sagar, Sep 15). The panel only
            left-padded its content before, so on a wide screen the block sat
            hard against the left edge with an empty green half beside it. */}
        <div className="nxl-hero-inner">
          <h2 className="nxl-hero-title" style={{ "--i": 1 }}>Everything your company runs on.</h2>
          <p className="nxl-hero-sub" style={{ "--i": 2 }}>
            Tasks, time, people, items and documents - one workspace for the whole company.
          </p>
          <div className="nxl-cards" style={{ "--i": 3 }}>
            <div className="nxl-cards-grid">
              {PANELS.map((p) => (
                <div key={p.title} className="nxl-card">
                  <span className="nxl-card-chip" style={{ background: p.tint, color: p.fg }}><p.Icon size={16} /></span>
                  <span className="nxl-card-text">
                    <span className="nxl-card-title">{p.title}</span>
                    <span className="nxl-card-sub">{p.sub}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Right: one calm action */}
      <main className="nxl-stage">
        <div className="nxl-stage-inner">
          <div className="nxl-badge" style={{ "--i": 0 }} aria-hidden="true">N</div>

          {partner === null && (<>
          <h1 className="nxl-title" style={{ "--i": 1 }}>Welcome to Nexus</h1>
          <p className="nxl-sub" style={{ "--i": 2 }}>
            Sign in with your work account to continue.
          </p>

          {denied && (
            <p role="alert" style={{ margin: '0 0 14px', padding: '10px 14px', borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 13, lineHeight: 1.5, maxWidth: 340 }}>
              {denied}
            </p>
          )}

          {/* Both sign-in routes are boxes of the same width (Sagar, Sep 15):
              the partner route used to be a small underlined link under the
              note, which read as fine print rather than the alternative it is. */}
          <div className="nxl-actions" style={{ "--i": 3 }}>
            <button className="nxl-cta" onClick={signIn}>
              <svg width="18" height="18" viewBox="0 0 21 21" fill="none" aria-hidden="true">
                <rect width="10" height="10" fill="#F35325" />
                <rect x="11" width="10" height="10" fill="#81BC06" />
                <rect y="11" width="10" height="10" fill="#05A6F0" />
                <rect x="11" y="11" width="10" height="10" fill="#FFBA08" />
              </svg>
              Continue with Microsoft
            </button>
            <p className="nxl-note">Single sign-on with your work account</p>
            <button className="nxl-cta" onClick={() => { setPartner('email'); setPError(''); }}>
              Partner Sign-In
            </button>
          </div>
          </>)}

          {partner === 'email' && (<>
          <h1 className="nxl-title" style={{ "--i": 1 }}>Partner Sign-In</h1>
          <p className="nxl-sub" style={{ "--i": 2 }}>
            For invited external partners. Enter your email and we'll send you a one-time code.
          </p>
          <input type="email" autoFocus value={pEmail} placeholder="you@yourcompany.com"
            onChange={e => setPEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') partnerRequest(); }}
            style={{ width: '100%', maxWidth: 340, boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit', marginBottom: 12 }} />
          {pError && <p role="alert" style={{ margin: '0 0 12px', fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{pError}</p>}
          <button className="nxl-cta" style={{ "--i": 3 }} disabled={pBusy} onClick={() => partnerRequest()}>Send Code</button>
          <button onClick={exitPartner}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#6b7280', textDecoration: 'underline', padding: '8px 4px' }}>
            Back to Microsoft Sign-In
          </button>
          </>)}

          {partner === 'switch' && pSwitch && (<>
          <h1 className="nxl-title" style={{ "--i": 1 }}>Switch accounts?</h1>
          <p className="nxl-sub" style={{ "--i": 2 }}>
            You are signed in as <strong>{pSwitch.name}</strong>. Continuing signs that account out
            on this browser and signs in as <strong>{pEmail.trim()}</strong>.
          </p>
          <button className="nxl-cta" style={{ "--i": 3 }} onClick={() => { setPSwitchOk(true); setPartner('code'); }}>
            Continue
          </button>
          <button onClick={exitPartner}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#6b7280', textDecoration: 'underline', padding: '8px 4px' }}>
            Cancel
          </button>
          <p className="nxl-note" style={{ "--i": 4 }}>
            Cancel leaves your current sign-in untouched.
          </p>
          </>)}

          {partner === 'code' && (<>
          <h1 className="nxl-title" style={{ "--i": 1 }}>Enter your code</h1>
          <p className="nxl-sub" style={{ "--i": 2 }}>
            If this account exists, a 6-digit code was sent to the contact on file - check your phone and your email (including spam).
          </p>
          {/* 6-digit OTPs AND the admin's 8-character staged test code (Neil,
              Aug 25) both land here - accept alphanumeric up to 8. */}
          <input autoFocus maxLength={8} value={pCode} placeholder="______"
            onChange={e => setPCode(e.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 8))}
            onKeyDown={e => { if (e.key === 'Enter' && (pCode.length === 6 || pCode.length === 8)) partnerVerify(); }}
            style={{ width: '100%', maxWidth: 240, boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 24, letterSpacing: 8, textAlign: 'center', fontWeight: 700, fontFamily: 'inherit', marginBottom: 12 }} />
          {pError && <p role="alert" style={{ margin: '0 0 12px', fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{pError}</p>}
          <button className="nxl-cta" style={{ "--i": 3 }} disabled={pBusy || !(pCode.length === 6 || pCode.length === 8)} onClick={partnerVerify}>Verify and Sign In</button>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <button disabled={pBusy || resendLeft > 0} onClick={() => partnerRequest()}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#6b7280', textDecoration: 'underline', padding: '6px 4px', opacity: resendLeft ? 0.5 : 1 }}>
              {resendLeft > 0 ? `Resend in ${resendLeft}s` : 'Resend Code'}
            </button>
            <button disabled={pBusy || resendLeft > 0} onClick={() => partnerRequest('email')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#6b7280', textDecoration: 'underline', padding: '6px 4px', opacity: resendLeft ? 0.5 : 1 }}>
              Send to My Email Instead
            </button>
            <button disabled={pBusy} onClick={() => { setPartner('email'); setPError(''); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#6b7280', textDecoration: 'underline', padding: '6px 4px' }}>
              Different Email
            </button>
          </div>
          </>)}

        </div>
      </main>

      {/* Page corners, not the centered column (Sagar, Sep 15). These sit on
          the root so they stay put across every partner step. */}
      <p className="nxl-foot" style={{ "--i": 5 }}>Secure company workspace</p>
      <p className="nxl-legal" style={{ "--i": 6 }}>
        <a href="/privacy">Privacy Policy</a>
        <span aria-hidden="true"> · </span>
        <a href="/terms">Terms & Conditions</a>
      </p>

      <style>{`
        .nxl {
          position: fixed; inset: 0; overflow: hidden;
          background: #ffffff; color: #323338;
          font-family: 'Figtree', 'Inter', sans-serif;
          display: flex;
        }

        /* ── Left brand panel ── */
        .nxl-hero {
          position: relative;
          flex: 1 1 52%;
          background: linear-gradient(160deg, ${P.light} 0%, ${P.base} 55%, ${P.dark} 100%);
          color: #fff;
          display: flex; flex-direction: column; justify-content: center;
          padding: 56px clamp(36px, 6vw, 84px);
          overflow: hidden;
        }
        .nxl-hero-wash {
          position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(48% 42% at 88% 4%,  rgba(255,255,255,.13) 0%, rgba(255,255,255,0) 70%),
            radial-gradient(56% 48% at -4% 104%, rgba(15,23,90,.35)   0%, rgba(15,23,90,0)   70%);
        }
        .nxl-hero > * { position: relative; }
        .nxl-hero-inner { width: 100%; max-width: 552px; margin-inline: auto; }
        .nxl-hero-brand {
          position: absolute; top: 26px; left: clamp(36px, 6vw, 84px);
          display: flex; align-items: center; gap: 10px;
        }
        .nxl-mark {
          width: 32px; height: 32px; border-radius: 9px;
          display: inline-flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 16px;
        }
        .nxl-mark--inverse { background: rgba(255,255,255,.16); color: #fff; }
        .nxl-hero-name { font-size: 18px; font-weight: 800; letter-spacing: -.01em; }

        .nxl-hero-title {
          margin: 0;
          font-size: clamp(30px, 3.4vw, 42px);
          font-weight: 800; letter-spacing: -.02em; line-height: 1.1;
          max-width: 14ch;
        }
        .nxl-hero-sub {
          margin: 16px 0 0;
          font-size: clamp(14.5px, 1.35vw, 16.5px);
          line-height: 1.55; color: rgba(255,255,255,.78);
          max-width: 42ch;
        }

        .nxl-cards { margin-top: 30px; }
        .nxl-cards-grid {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
          transform: rotate(-1deg);
        }
        .nxl-card {
          display: flex; align-items: center; gap: 11px;
          background: #ffffff; color: #323338;
          border-radius: 13px; padding: 11px 14px;
          box-shadow: 0 14px 34px rgba(15, 23, 90, .28);
        }
        /* Four rows instead of seven leaves room to spare, so this only has to
           catch genuinely short windows now. */
        @media (max-height: 660px) {
          .nxl-cards { margin-top: 20px; }
          .nxl-cards-grid { gap: 9px; }
          .nxl-card { padding: 9px 12px; }
          .nxl-card-chip { width: 30px; height: 30px; }
        }
        /* One column again once the panel is too narrow to split. */
        @media (max-width: 1080px) {
          .nxl-hero-inner { max-width: 340px; }
          .nxl-cards-grid { grid-template-columns: minmax(0, 1fr); }
        }
        .nxl-card-chip {
          width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .nxl-card-text { display: flex; flex-direction: column; min-width: 0; }
        .nxl-card-title { font-size: 13.5px; font-weight: 700; }
        .nxl-card-sub { font-size: 12px; color: #676879; }

        /* ── Right sign-in column ── */
        .nxl-stage {
          flex: 1 1 48%;
          display: flex; align-items: center; justify-content: center;
          padding: 32px;
        }
        .nxl-stage-inner { display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 380px; }

        .nxl-hero > *:not(.nxl-hero-wash):not(.nxl-hero-inner), .nxl-hero-inner > *,
        .nxl-stage-inner > *, .nxl > .nxl-foot, .nxl > .nxl-legal {
          opacity: 0; transform: translateY(8px);
          transition: opacity .5s cubic-bezier(.16,1,.3,1), transform .5s cubic-bezier(.16,1,.3,1);
          transition-delay: calc(var(--i, 0) * 80ms + 60ms);
        }
        .nxl-on .nxl-hero > *:not(.nxl-hero-wash):not(.nxl-hero-inner), .nxl-on .nxl-hero-inner > *,
        .nxl-on .nxl-stage-inner > *,
        .nxl-on > .nxl-foot, .nxl-on > .nxl-legal { opacity: 1; transform: none; }
        .nxl-on .nxl-card:nth-child(1) { transform: rotate(-1.2deg) translateX(-6px); }
        .nxl-on .nxl-card:nth-child(2) { transform: rotate(.8deg) translateX(14px); }
        .nxl-on .nxl-card:nth-child(3) { transform: rotate(-.6deg); }

        .nxl-badge {
          width: 60px; height: 60px; border-radius: 15px;
          background: ${P.base}; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 28px;
          box-shadow: 0 10px 26px ${P.shadow};
          margin-bottom: 24px;
        }
        .nxl-title {
          font-size: clamp(26px, 3vw, 34px);
          font-weight: 800; letter-spacing: -.02em; line-height: 1.1;
          margin: 0; color: #323338;
        }
        .nxl-sub { margin: 12px 0 0; font-size: 15px; color: #676879; line-height: 1.55; }

        .nxl-cta {
          display: inline-flex; align-items: center; gap: 11px;
          margin-top: 30px;
          padding: 14px 28px;
          background: #ffffff; color: #323338;
          border: 1px solid #d0d4e4; border-radius: 10px;
          font-family: 'Figtree', 'Inter', sans-serif;
          font-size: 15.5px; font-weight: 700;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(29,33,57,.07);
          transition: box-shadow .16s ease, border-color .16s ease, transform .16s ease;
        }
        .nxl-cta:hover { box-shadow: 0 8px 22px rgba(29,33,57,.12); border-color: #b6bbd1; transform: translateY(-1px); }
        .nxl-cta:active { transform: translateY(0); }
        .nxl-cta:focus-visible { outline: 2px solid ${P.base}; outline-offset: 3px; }
        .nxl-cta svg { flex-shrink: 0; }

        .nxl-actions {
          display: flex; flex-direction: column; align-items: stretch;
          width: 100%; max-width: 300px; margin-top: 30px;
        }
        .nxl-actions .nxl-cta { width: 100%; justify-content: center; margin-top: 0; }
        .nxl-actions .nxl-note { margin: 14px 0; }
        .nxl-note { margin: 16px 0 0; font-size: 12.5px; color: #9699a6; }

        /* Pinned to the page corners. The left one sits over the green panel,
           so it is light; below 880px the panel is hidden and the area behind
           it turns white, hence the color flip in the responsive block. */
        .nxl-foot {
          position: absolute; left: clamp(36px, 6vw, 84px); bottom: 24px; margin: 0;
          font-size: 12px; color: rgba(255,255,255,.75); z-index: 2;
        }
        .nxl-legal {
          position: absolute; right: clamp(24px, 3vw, 48px); bottom: 24px; margin: 0;
          font-size: 12px; z-index: 2;
        }
        .nxl-legal a { color: #9699a6; text-decoration: underline; text-underline-offset: 2px; }
        .nxl-legal a:hover { color: #676879; }
        .nxl-legal span { color: #c3c6d4; }

        @media (max-width: 880px) {
          .nxl-hero { display: none; }
          .nxl-stage { padding: 24px 24px 64px; }
          .nxl-cta { width: 100%; justify-content: center; }
          /* No green panel left to sit on. */
          .nxl-foot { left: 24px; color: #9699a6; }
          .nxl-legal { right: 24px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .nxl-hero > *, .nxl-hero-inner > *, .nxl-stage-inner > *, .nxl > .nxl-foot, .nxl > .nxl-legal { transition: none !important; opacity: 1 !important; }
          .nxl-on .nxl-hero > *, .nxl-on .nxl-hero-inner > *, .nxl-on .nxl-stage-inner > *, .nxl-on > .nxl-foot, .nxl-on > .nxl-legal { transform: none; }
        }
      `}</style>
    </div>
  );
}
