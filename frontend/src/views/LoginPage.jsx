/*
THESIS: signing in feels like opening a premium work OS (canon, owner-pinned:
monday.com-grade) — clean, white, confident, zero clutter.
OWN-WORLD: Work OS (DESIGN.md) — white ground with faint brand-tinted washes,
Figtree type, brand #2b45e1 mark, one Microsoft action.
STORY: an employee lands, instantly trusts it ("this is a real product"),
presses the single button, and is at work.
FIRST VIEWPORT: brand mark top-left, centered column — mark, "Welcome to
Nexus", one-line promise, Microsoft button, SSO note. Nothing else.
FORM: category standard played straight at full fidelity (user's canon call,
Jul 28); craft bar monday.com's login.
*/
import { useEffect, useState } from "react";
import { useMsal } from "@azure/msal-react";
import { loginRequest } from "../authConfig";

export default function LoginPage() {
  const { instance } = useMsal();
  const [on, setOn] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) { setOn(true); return; }
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className={`nxl${on ? " nxl-on" : ""}`}>
      <div className="nxl-wash" aria-hidden="true" />

      <header className="nxl-top">
        <span className="nxl-mark">N</span>
        <span className="nxl-brand">Nexus</span>
      </header>

      <main className="nxl-stage">
        <div className="nxl-badge" style={{ "--i": 0 }} aria-hidden="true">N</div>
        <h1 className="nxl-title" style={{ "--i": 1 }}>Welcome to Nexus</h1>
        <p className="nxl-sub" style={{ "--i": 2 }}>
          One place to run every operation — tasks, items, people, time, and more.
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
      </main>

      <footer className="nxl-foot" style={{ "--i": 5 }}>
        Secure company workspace
      </footer>

      <style>{`
        .nxl {
          position: fixed; inset: 0; overflow: hidden;
          background: #ffffff; color: #323338;
          font-family: 'Figtree', 'Inter', sans-serif;
          display: flex; flex-direction: column;
        }
        .nxl-wash {
          position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(52% 44% at 12% -6%,  rgba(43,69,225,.09)  0%, rgba(43,69,225,0)  70%),
            radial-gradient(46% 40% at 100% 12%, rgba(0,200,117,.07)  0%, rgba(0,200,117,0)  70%),
            radial-gradient(56% 44% at 50% 112%, rgba(253,171,61,.08) 0%, rgba(253,171,61,0) 70%);
        }

        .nxl-top {
          position: relative; z-index: 1;
          display: flex; align-items: center; gap: 9px;
          padding: 22px 28px;
        }
        .nxl-mark {
          width: 30px; height: 30px; border-radius: 8px;
          background: #2b45e1; color: #fff;
          display: inline-flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 15px;
        }
        .nxl-brand { font-size: 17px; font-weight: 800; letter-spacing: -.01em; }

        .nxl-stage {
          position: relative; z-index: 1;
          flex: 1;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          text-align: center; padding: 24px;
          margin-top: -30px;
        }
        .nxl-stage > *, .nxl-foot {
          opacity: 0; transform: translateY(8px);
          transition: opacity .5s cubic-bezier(.16,1,.3,1), transform .5s cubic-bezier(.16,1,.3,1);
          transition-delay: calc(var(--i) * 80ms + 60ms);
        }
        .nxl-on .nxl-stage > *, .nxl-on .nxl-foot { opacity: 1; transform: none; }

        .nxl-badge {
          width: 64px; height: 64px; border-radius: 16px;
          background: #2b45e1; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 30px;
          box-shadow: 0 10px 26px rgba(43,69,225,.28);
          margin-bottom: 26px;
        }
        .nxl-title {
          font-size: clamp(30px, 4.4vw, 44px);
          font-weight: 800; letter-spacing: -.02em; line-height: 1.08;
          margin: 0;
          color: #323338;
        }
        .nxl-sub {
          margin: 14px 0 0;
          font-size: clamp(14.5px, 1.6vw, 16.5px);
          color: #676879; line-height: 1.55;
          max-width: 46ch;
        }

        .nxl-cta {
          display: inline-flex; align-items: center; gap: 11px;
          margin-top: 34px;
          padding: 14px 28px;
          background: #ffffff; color: #323338;
          border: 1px solid #d0d4e4; border-radius: 8px;
          font-family: 'Figtree', 'Inter', sans-serif;
          font-size: 15.5px; font-weight: 700;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(29,33,57,.07);
          transition: box-shadow .16s ease, border-color .16s ease, transform .16s ease;
        }
        .nxl-cta:hover { box-shadow: 0 8px 22px rgba(29,33,57,.12); border-color: #b6bbd1; transform: translateY(-1px); }
        .nxl-cta:active { transform: translateY(0); }
        .nxl-cta:focus-visible { outline: 2px solid #2b45e1; outline-offset: 3px; }
        .nxl-cta svg { flex-shrink: 0; }

        .nxl-note { margin: 18px 0 0; font-size: 12.5px; color: #9699a6; }

        .nxl-foot {
          position: relative; z-index: 1;
          text-align: center; padding: 20px;
          font-size: 12px; color: #9699a6;
        }

        @media (max-width: 560px) {
          .nxl-cta { width: 100%; justify-content: center; }
          .nxl-stage { padding: 20px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .nxl-stage > *, .nxl-foot { transition: none; opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  );
}
