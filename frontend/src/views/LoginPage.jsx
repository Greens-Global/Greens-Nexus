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
import { CheckSquare, Clock, Users } from "lucide-react";
import { loginRequest } from "../authConfig";
import { useBranding } from "../lib/queries";
import { BFF_MODE } from "../bffAuth";

// Accent is a Global Admin-configurable setting (AdminPanel -> Branding), not
// hardcoded - see backend/routers/branding.py. The hero panel needs three
// gradient stops (not just one brand color), so this keeps its own small
// palette rather than trying to force everything through the single
// --wk-brand var the rest of the app reads (see lib/brandAccent.js).
const ACCENT_PALETTES = {
  blue:  { light: "#3a52e6", base: "#2b45e1", dark: "#1f36c7", tint: "#e8ecfd", shadow: "rgba(43,69,225,.28)" },
  green: { light: "hsl(142,55%,42%)", base: "hsl(142,60%,35%)", dark: "hsl(142,65%,25%)", tint: "hsla(142,60%,35%,0.14)", shadow: "hsla(142,60%,35%,.28)" },
};

export default function LoginPage() {
  const { instance } = useMsal();
  const [on, setOn] = useState(false);
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
    if (BFF_MODE) { window.location.href = "/api/auth/login"; return; }
    instance.loginRedirect(loginRequest);
  };

  const P = ACCENT_PALETTES[accent];
  const PANELS = [
    { Icon: CheckSquare, tint: "#dff3fc", fg: "#0998c3", title: "Tasks", sub: "Projects, boards and deadlines" },
    { Icon: Clock,       tint: P.tint,     fg: P.base,    title: "Time Clock", sub: "Punch in, timesheets, payroll" },
    { Icon: Users,       tint: "#e6f7ef", fg: "#00a25b", title: "People", sub: "Profiles, leave and documents" },
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
        <h2 className="nxl-hero-title" style={{ "--i": 1 }}>Everything your company runs on.</h2>
        <p className="nxl-hero-sub" style={{ "--i": 2 }}>
          Tasks, time, people, items and documents - one workspace for the whole company.
        </p>
        <div className="nxl-cards" style={{ "--i": 3 }}>
          {PANELS.map((p, i) => (
            <div key={p.title} className="nxl-card" style={{ "--i": 3 + i }}>
              <span className="nxl-card-chip" style={{ background: p.tint, color: p.fg }}><p.Icon size={16} /></span>
              <span className="nxl-card-text">
                <span className="nxl-card-title">{p.title}</span>
                <span className="nxl-card-sub">{p.sub}</span>
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* Right: one calm action */}
      <main className="nxl-stage">
        <div className="nxl-stage-inner">
          <div className="nxl-badge" style={{ "--i": 0 }} aria-hidden="true">N</div>
          <h1 className="nxl-title" style={{ "--i": 1 }}>Welcome to Nexus</h1>
          <p className="nxl-sub" style={{ "--i": 2 }}>
            Sign in with your work account to continue.
          </p>

          <button className="nxl-cta" style={{ "--i": 3 }} onClick={() => instance.loginRedirect(loginRequest)}>
            <svg width="18" height="18" viewBox="0 0 21 21" fill="none" aria-hidden="true">
              <rect width="10" height="10" fill="#F35325" />
              <rect x="11" width="10" height="10" fill="#81BC06" />
              <rect y="11" width="10" height="10" fill="#05A6F0" />
              <rect x="11" y="11" width="10" height="10" fill="#FFBA08" />
            </svg>
            Continue with Microsoft
          </button>

          <p className="nxl-note" style={{ "--i": 4 }}>
            Single sign-on with your work account · Microsoft Entra ID
          </p>
          <p className="nxl-foot" style={{ "--i": 5 }}>Secure company workspace</p>
        </div>
      </main>

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

        .nxl-cards { display: flex; flex-direction: column; gap: 14px; margin-top: 40px; max-width: 340px; }
        .nxl-card {
          display: flex; align-items: center; gap: 12px;
          background: #ffffff; color: #323338;
          border-radius: 13px; padding: 13px 16px;
          box-shadow: 0 14px 34px rgba(15, 23, 90, .28);
        }
        .nxl-card:nth-child(1) { transform: rotate(-1.2deg) translateX(-6px); }
        .nxl-card:nth-child(2) { transform: rotate(.8deg) translateX(14px); }
        .nxl-card:nth-child(3) { transform: rotate(-.6deg); }
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

        .nxl-hero > *:not(.nxl-hero-wash), .nxl-stage-inner > * {
          opacity: 0; transform: translateY(8px);
          transition: opacity .5s cubic-bezier(.16,1,.3,1), transform .5s cubic-bezier(.16,1,.3,1);
          transition-delay: calc(var(--i, 0) * 80ms + 60ms);
        }
        .nxl-on .nxl-hero > *:not(.nxl-hero-wash), .nxl-on .nxl-stage-inner > * { opacity: 1; transform: none; }
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

        .nxl-note { margin: 16px 0 0; font-size: 12.5px; color: #9699a6; }
        .nxl-foot { margin: 34px 0 0; font-size: 12px; color: #9699a6; }

        @media (max-width: 880px) {
          .nxl-hero { display: none; }
          .nxl-stage { padding: 24px; }
          .nxl-cta { width: 100%; justify-content: center; }
        }

        @media (prefers-reduced-motion: reduce) {
          .nxl-hero > *, .nxl-stage-inner > * { transition: none !important; opacity: 1 !important; }
          .nxl-on .nxl-hero > *, .nxl-on .nxl-stage-inner > * { transform: none; }
        }
      `}</style>
    </div>
  );
}
