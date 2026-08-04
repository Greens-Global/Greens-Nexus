import { useEffect, useRef } from 'react';

// Pre-auth sign-in landing for BFF cookie mode. main.jsx renders this when there
// is no session (and after sign-out). Clean white work-OS canvas, one confident
// cobalt accent, a single calm interactive moment (a cursor-tracking glow), and a
// staggered entrance - the OG dark particle login was retired. Reduced-motion safe.
// Product is "Nexus" only (white-label); Microsoft sign-in semantics stay.

const MODULES = [
  { label: 'Tasks',     c: 'var(--wk-blue, #579bfc)' },
  { label: 'Items',     c: 'var(--wk-orange, #fdab3d)' },
  { label: 'Time clock', c: 'var(--wk-green, #00a25b)' },
  { label: 'People',    c: 'var(--wk-brand, #2b45e1)' },
  { label: 'Documents', c: 'var(--wk-red, #e2445c)' },
  { label: 'Assets',    c: '#8a63d2' },
];

export default function LandingPage() {
  const glowRef = useRef(null);

  useEffect(() => {
    const el = glowRef.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // Cursor-tracking glow, eased so it drifts rather than snaps - the one motion.
    let raf = 0, tx = 50, ty = 40, cx = 50, cy = 40;
    const onMove = (e) => {
      tx = (e.clientX / window.innerWidth) * 100;
      ty = (e.clientY / window.innerHeight) * 100;
    };
    const tick = () => {
      cx += (tx - cx) * 0.05; cy += (ty - cy) * 0.05;
      el.style.setProperty('--mx', cx.toFixed(2) + '%');
      el.style.setProperty('--my', cy.toFixed(2) + '%');
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
      <div ref={glowRef} className="nxl-glow" aria-hidden="true" />
      <div className="nxl-grid" aria-hidden="true" />

      <main className="nxl-card" role="main">
        <div className="nxl-mark" style={{ '--i': 0 }} aria-hidden="true">N</div>
        <div className="nxl-word" style={{ '--i': 1 }}>Nexus</div>

        <h1 className="nxl-h1" style={{ '--i': 2 }}>Everything your day runs on.</h1>
        <p className="nxl-sub" style={{ '--i': 3 }}>Sign in to your workspace to continue.</p>

        <button className="nxl-btn" style={{ '--i': 4 }} onClick={signIn} type="button">
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

        <div className="nxl-foot" style={{ '--i': 5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2 4 5v6c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V5l-8-3Z"
              stroke="currentColor" strokeWidth="1.6" strokelinejoin="round" />
          </svg>
          Single sign-on, secured by Microsoft Entra ID
        </div>

        <ul className="nxl-mods" style={{ '--i': 6 }} aria-label="Included in your workspace">
          {MODULES.map((m) => (
            <li key={m.label}><span className="nxl-dot" style={{ background: m.c }} />{m.label}</li>
          ))}
        </ul>
      </main>
    </div>
  );
}

const CSS = `
.nxl-root{
  position:fixed; inset:0; display:grid; place-items:center; padding:24px;
  background:var(--wk-bg,#f6f7fb);
  font-family:'Figtree','Inter',system-ui,-apple-system,sans-serif;
  color:var(--wk-ink,#323338); overflow:hidden; isolation:isolate;
}
.nxl-glow{
  position:absolute; inset:-20%; z-index:0; pointer-events:none;
  --mx:50%; --my:40%;
  background:
    radial-gradient(38vmax 38vmax at var(--mx) var(--my), rgba(43,69,225,.16), transparent 60%),
    radial-gradient(46vmax 40vmax at 82% 108%, rgba(87,155,252,.14), transparent 62%),
    radial-gradient(40vmax 40vmax at 6% -8%, rgba(138,99,210,.12), transparent 60%);
  filter:blur(8px); animation:nxl-breathe 14s ease-in-out infinite;
}
@keyframes nxl-breathe{ 0%,100%{transform:scale(1)} 50%{transform:scale(1.06)} }
.nxl-grid{
  position:absolute; inset:0; z-index:0; pointer-events:none; opacity:.5;
  background-image:radial-gradient(rgba(50,51,56,.06) 1px, transparent 1px);
  background-size:26px 26px;
  -webkit-mask-image:radial-gradient(70% 60% at 50% 45%, #000 0%, transparent 78%);
          mask-image:radial-gradient(70% 60% at 50% 45%, #000 0%, transparent 78%);
}
.nxl-card{
  position:relative; z-index:1; width:100%; max-width:404px;
  background:var(--wk-card,#fff); border:1px solid var(--wk-line2,#e6e9f2);
  border-radius:20px; padding:44px 40px 30px;
  box-shadow:0 24px 60px -20px rgba(29,33,57,.22), 0 4px 12px rgba(29,33,57,.05);
  text-align:center;
}
.nxl-mark{
  width:50px; height:50px; margin:0 auto; border-radius:14px;
  display:grid; place-items:center; font-weight:800; font-size:25px; color:#fff;
  background:linear-gradient(150deg,#3a53ea,#2b45e1 55%,#1f36c7);
  box-shadow:0 8px 20px -6px rgba(43,69,225,.55), inset 0 1px 0 rgba(255,255,255,.35);
}
.nxl-word{ margin-top:14px; font-size:14px; font-weight:600; letter-spacing:.12em;
  text-transform:uppercase; color:var(--wk-faint,#9699a6); }
.nxl-h1{ margin:20px 0 0; font-size:26px; line-height:1.16; font-weight:700;
  letter-spacing:-.02em; text-wrap:balance; }
.nxl-sub{ margin:10px 0 0; font-size:14.5px; line-height:1.5; color:var(--wk-dim,#676879); }
.nxl-btn{
  margin-top:28px; width:100%; height:48px; border:0; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:12px;
  font-family:inherit; font-size:15px; font-weight:600; color:#fff;
  background:var(--wk-brand,#2b45e1); border-radius:11px;
  box-shadow:0 6px 16px -6px rgba(43,69,225,.6);
  transition:transform .16s cubic-bezier(.16,1,.3,1), box-shadow .2s, background .2s;
}
.nxl-btn:hover{ background:var(--wk-brand-hover,#1f36c7); transform:translateY(-1px);
  box-shadow:0 10px 22px -8px rgba(43,69,225,.7); }
.nxl-btn:active{ transform:translateY(0); box-shadow:0 4px 12px -6px rgba(43,69,225,.6); }
.nxl-btn:focus-visible{ outline:2px solid var(--wk-brand,#2b45e1); outline-offset:3px; }
.nxl-ms{ width:26px; height:26px; border-radius:7px; background:#fff;
  display:grid; place-items:center; box-shadow:inset 0 0 0 1px rgba(0,0,0,.04); }
.nxl-foot{ margin-top:22px; display:flex; align-items:center; justify-content:center; gap:6px;
  font-size:12px; color:var(--wk-faint,#9699a6); }
.nxl-mods{ list-style:none; margin:26px 0 0; padding:20px 0 0; border-top:1px solid var(--wk-line2,#e6e9f2);
  display:flex; flex-wrap:wrap; justify-content:center; gap:8px 14px; }
.nxl-mods li{ display:inline-flex; align-items:center; gap:6px; font-size:12px;
  font-weight:500; color:var(--wk-dim,#676879); }
.nxl-dot{ width:7px; height:7px; border-radius:50%; }

/* One authored entrance: rise + fade, staggered, exponential ease, once. */
@keyframes nxl-rise{ from{opacity:0; transform:translateY(9px)} to{opacity:1; transform:translateY(0)} }
.nxl-mark,.nxl-word,.nxl-h1,.nxl-sub,.nxl-btn,.nxl-foot,.nxl-mods{
  opacity:0; animation:nxl-rise .5s cubic-bezier(.16,1,.3,1) forwards;
  animation-delay:calc(var(--i,0) * 70ms + 60ms);
}
.nxl-card{ animation:nxl-card .6s cubic-bezier(.16,1,.3,1) both; }
@keyframes nxl-card{ from{opacity:0; transform:translateY(14px) scale(.985)} to{opacity:1; transform:none} }

@media (max-width:480px){
  .nxl-card{ padding:36px 26px 26px; border-radius:18px; }
  .nxl-h1{ font-size:23px; }
}
@media (prefers-reduced-motion:reduce){
  .nxl-glow{ animation:none; }
  .nxl-mark,.nxl-word,.nxl-h1,.nxl-sub,.nxl-btn,.nxl-foot,.nxl-mods,.nxl-card{
    opacity:1; animation:none; transform:none;
  }
}
`;
