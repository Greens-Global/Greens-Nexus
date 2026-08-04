import { useEffect, useRef } from 'react';

// Pre-auth sign-in landing for BFF cookie mode. main.jsx renders this when there
// is no session (and after sign-out). A real landing SCREEN, not a login box on
// blank: a green Nexus brand panel that states the value + a clean sign-in panel.
// Brand green = hsl(142 60% 35%) (the app's --color-green mark). One calm
// interactive moment (a cursor-tracking light on the green panel) + a staggered
// entrance. Reduced-motion safe. Product is "Nexus" only (white-label); Microsoft
// sign-in semantics stay.

const VALUES = [
  'One Microsoft sign-on for every tool',
  'Role-aware — you see exactly what’s yours',
  'From clock-in to approvals, all in one place',
];

export default function LandingPage() {
  const panelRef = useRef(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // A soft light that follows the cursor across the green panel - the one motion.
    let raf = 0, tx = 30, ty = 26, cx = 30, cy = 26;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 100;
      ty = ((e.clientY - r.top) / r.height) * 100;
    };
    const tick = () => {
      cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
      el.style.setProperty('--lx', cx.toFixed(2) + '%');
      el.style.setProperty('--ly', cy.toFixed(2) + '%');
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, []);

  const signIn = () => { window.location.href = '/api/auth/login'; };

  return (
    <div className="nxl-root">
      <style>{CSS}</style>

      {/* ── Brand / value panel ──────────────────────────────────────────── */}
      <section className="nxl-brand" ref={panelRef} aria-hidden="false">
        <div className="nxl-brand-light" aria-hidden="true" />
        <div className="nxl-brand-sheen" aria-hidden="true" />

        <header className="nxl-lockup" style={{ '--i': 0 }}>
          <span className="nxl-mark">N</span>
          <span className="nxl-word">Nexus</span>
        </header>

        <div className="nxl-brand-body">
          <h1 className="nxl-h1" style={{ '--i': 1 }}>Where everything comes together.</h1>
          <p className="nxl-lead" style={{ '--i': 2 }}>
            One secure, role-aware workspace for how your team actually works — items and
            equipment, people and time, tasks and documents, in a single place.
          </p>
          <ul className="nxl-values" style={{ '--i': 3 }}>
            {VALUES.map((v) => (
              <li key={v}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.4"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {v}
              </li>
            ))}
          </ul>
        </div>

        <div className="nxl-brand-foot" style={{ '--i': 4 }}>Secured by Microsoft Entra ID · single sign-on</div>
      </section>

      {/* ── Sign-in panel ────────────────────────────────────────────────── */}
      <section className="nxl-auth" role="main">
        <div className="nxl-auth-inner">
          <span className="nxl-mark nxl-mark--sm" style={{ '--i': 0 }} aria-hidden="true">N</span>
          <h2 className="nxl-auth-h" style={{ '--i': 1 }}>Sign in to Nexus</h2>
          <p className="nxl-auth-sub" style={{ '--i': 2 }}>Use your work account to continue.</p>

          <button className="nxl-btn" style={{ '--i': 3 }} onClick={signIn} type="button">
            <span className="nxl-ms" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
            </span>
            Sign in with Microsoft
          </button>

          <p className="nxl-fine" style={{ '--i': 4 }}>
            You’ll be redirected to Microsoft to sign in securely. No password is stored by Nexus.
          </p>
        </div>
      </section>
    </div>
  );
}

const CSS = `
.nxl-root{
  position:fixed; inset:0; display:grid; grid-template-columns:1.15fr .85fr;
  font-family:'Figtree','Inter',system-ui,-apple-system,sans-serif;
  color:var(--wk-ink,#323338); background:var(--wk-card,#fff); overflow:hidden;
}

/* ── Brand panel ──────────────────────────────────────────────────────── */
.nxl-brand{
  position:relative; overflow:hidden; isolation:isolate;
  display:flex; flex-direction:column; justify-content:space-between;
  padding:clamp(36px,4.4vw,68px);
  color:#eaf6ee;
  background:
    radial-gradient(120% 120% at 12% 8%, hsl(146 58% 30%), transparent 55%),
    linear-gradient(155deg, hsl(150 55% 20%) 0%, hsl(143 60% 30%) 55%, hsl(140 58% 34%) 100%);
}
.nxl-brand-light{
  position:absolute; inset:0; z-index:0; pointer-events:none; --lx:30%; --ly:26%;
  background:radial-gradient(30vmax 30vmax at var(--lx) var(--ly), rgba(255,255,255,.16), transparent 60%);
  transition:background .05s linear;
}
.nxl-brand-sheen{
  position:absolute; inset:-30%; z-index:0; pointer-events:none; opacity:.5;
  background:conic-gradient(from 210deg at 70% 30%, transparent, rgba(255,255,255,.10), transparent 40%);
  animation:nxl-sheen 22s linear infinite;
}
@keyframes nxl-sheen{ to{ transform:rotate(360deg); } }
.nxl-brand > *{ position:relative; z-index:1; }

.nxl-lockup{ display:flex; align-items:center; gap:12px; }
.nxl-mark{
  width:44px; height:44px; border-radius:12px; display:grid; place-items:center;
  font-weight:800; font-size:22px; color:#fff; flex-shrink:0;
  background:linear-gradient(150deg, hsl(142 62% 42%), hsl(146 64% 30%));
  box-shadow:0 8px 20px -6px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.4);
}
.nxl-word{ font-size:15px; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
  color:rgba(255,255,255,.9); }

.nxl-brand-body{ max-width:30ch; }
.nxl-h1{ margin:0; font-size:clamp(30px,3.5vw,46px); line-height:1.08; font-weight:800;
  letter-spacing:-.025em; color:#fff; text-wrap:balance; }
.nxl-lead{ margin:20px 0 0; font-size:clamp(14.5px,1.15vw,16px); line-height:1.6;
  color:rgba(234,246,238,.82); max-width:40ch; }
.nxl-values{ list-style:none; margin:30px 0 0; padding:0; display:flex; flex-direction:column; gap:13px; }
.nxl-values li{ display:flex; align-items:center; gap:11px; font-size:14.5px; font-weight:500;
  color:rgba(255,255,255,.94); }
.nxl-values svg{ color:hsl(140 70% 62%); flex-shrink:0; }
.nxl-brand-foot{ font-size:12.5px; color:rgba(234,246,238,.6); }

/* ── Auth panel ───────────────────────────────────────────────────────── */
.nxl-auth{ display:grid; place-items:center; padding:32px; background:var(--wk-card,#fff); }
.nxl-auth-inner{ width:100%; max-width:352px; text-align:center; }
.nxl-mark--sm{ margin:0 auto 22px;
  background:linear-gradient(150deg, hsl(142 60% 40%), hsl(146 62% 30%));
  box-shadow:0 8px 18px -6px hsla(145 60% 25% / .5), inset 0 1px 0 rgba(255,255,255,.35); }
.nxl-auth-h{ margin:0; font-size:23px; font-weight:700; letter-spacing:-.02em; color:var(--wk-ink,#323338); }
.nxl-auth-sub{ margin:9px 0 0; font-size:14.5px; color:var(--wk-dim,#676879); }
.nxl-btn{
  margin-top:28px; width:100%; height:50px; border:0; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:12px;
  font-family:inherit; font-size:15px; font-weight:600; color:#fff;
  background:hsl(142 60% 35%); border-radius:11px;
  box-shadow:0 8px 18px -6px hsla(145 60% 25% / .55);
  transition:transform .16s cubic-bezier(.16,1,.3,1), box-shadow .2s, background .2s, filter .2s;
}
.nxl-btn:hover{ background:hsl(144 62% 31%); transform:translateY(-1px);
  box-shadow:0 12px 24px -8px hsla(145 60% 22% / .6); }
.nxl-btn:active{ transform:translateY(0); }
.nxl-btn:focus-visible{ outline:2px solid hsl(142 60% 35%); outline-offset:3px; }
.nxl-ms{ width:26px; height:26px; border-radius:7px; background:#fff; display:grid; place-items:center; }
.nxl-fine{ margin:18px auto 0; max-width:30ch; font-size:12px; line-height:1.5; color:var(--wk-faint,#9699a6); }

/* ── One authored entrance ────────────────────────────────────────────── */
@keyframes nxl-rise{ from{opacity:0; transform:translateY(10px)} to{opacity:1; transform:translateY(0)} }
.nxl-lockup,.nxl-h1,.nxl-lead,.nxl-values,.nxl-brand-foot,
.nxl-mark--sm,.nxl-auth-h,.nxl-auth-sub,.nxl-btn,.nxl-fine{
  opacity:0; animation:nxl-rise .55s cubic-bezier(.16,1,.3,1) forwards;
  animation-delay:calc(var(--i,0) * 75ms + 80ms);
}

@media (max-width:860px){
  .nxl-root{ grid-template-columns:1fr; grid-template-rows:auto 1fr; }
  .nxl-brand{ padding:34px 30px; }
  .nxl-brand-body{ max-width:none; }
  .nxl-values{ display:none; }
  .nxl-h1{ font-size:28px; }
  .nxl-lead{ display:none; }
  .nxl-brand-foot{ display:none; }
}
@media (prefers-reduced-motion:reduce){
  .nxl-brand-sheen{ animation:none; }
  .nxl-lockup,.nxl-h1,.nxl-lead,.nxl-values,.nxl-brand-foot,
  .nxl-mark--sm,.nxl-auth-h,.nxl-auth-sub,.nxl-btn,.nxl-fine{
    opacity:1; animation:none; transform:none;
  }
}
`;
