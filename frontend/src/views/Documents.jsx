import { useState, useEffect } from 'react';
import { api } from '../api';
import ESign from '../components/ESign';

// ── Documents module ─────────────────────────────────────────────────────────
// E-Sign was carved out of HR into its own top-level module (Jul 2026). The
// module renders a horizontal tab strip (currently just E-Sign; more document
// tools land here later) and hosts <ESign>. Backend /esign/* routes are
// unchanged — only the navigation/deep-link keys moved from hr-* to documents-*.
//
// Cross-module handoff: HR → Hiring "Send for signature" stashes an offer on
// window.__esignPrefill then fires nexus:navigate here. We read it on mount
// (fresh navigation) AND on a repeat nexus:navigate (already mounted), so the
// send wizard opens pre-filled either way.
const TABS = [
  ['documents-esign', 'E-Sign'],
];

export default function Documents({ activeSub, onSubChange }) {
  // Deep-links: 'documents-esign' / 'documents-esign-requests' both live on the
  // E-Sign tab — ESign reads the raw activeSub to pick its own sub-tab.
  const navSub = String(activeSub || '').startsWith('documents-esign') ? 'documents-esign' : activeSub;
  const sub = TABS.some(([key]) => key === navSub) ? navSub : 'documents-esign';

  const [employees, setEmployees] = useState([]);
  const [entities, setEntities] = useState([]);
  const [toast, setToast] = useState(null);
  const [esignPrefill, setEsignPrefill] = useState(() => {
    // Fresh navigation from HR Hiring: the prefill was stashed before this view
    // mounted, so the nexus:navigate event already fired. Pick it up here.
    const p = window.__esignPrefill;
    window.__esignPrefill = null;
    return p || null;
  });

  const toastErr = msg => { setToast({ msg, kind: 'error' }); setTimeout(() => setToast(null), 5000); };
  const toastOk  = msg => { setToast({ msg, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };

  // Employees + entities feed the Send wizard's internal-signer picker. A
  // documents-only grant (no HR access) may 403 these — degrade to external
  // parties rather than break the module.
  useEffect(() => {
    api.getEmployees().then(setEmployees).catch(() => setEmployees([]));
    api.getEntities().then(setEntities).catch(() => setEntities([]));
  }, []);

  // Repeat "Send for signature" while already on Documents: nexus:navigate fires
  // but the view/sub may be a no-op, so consume the stashed prefill here too.
  useEffect(() => {
    const onNav = (e) => {
      if (e.detail?.view === 'documents' && window.__esignPrefill) {
        setEsignPrefill(window.__esignPrefill);
        window.__esignPrefill = null;
      }
    };
    window.addEventListener('nexus:navigate', onNav);
    return () => window.removeEventListener('nexus:navigate', onNav);
  }, []);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div className="view-title-group">
          <h2>Documents</h2>
          <p>Send, sign and track company documents — one place</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="chip-row scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => onSubChange ? onSubChange(key) : null}
            style={{ padding: '7px 16px', borderRadius: 10, border: `1px solid ${sub === key ? 'var(--pine)' : 'var(--line)'}`, background: sub === key ? 'hsla(var(--color-green),0.08)' : 'var(--card)', color: sub === key ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: sub === key ? 700 : 600, fontSize: 13, cursor: 'pointer', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {label}
          </button>
        ))}
      </div>

      {sub === 'documents-esign' && (
        <ESign employees={employees} entities={entities} prefill={esignPrefill} navSub={activeSub}
          onPrefillConsumed={() => setEsignPrefill(null)} toastOk={toastOk} toastErr={toastErr} />
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
