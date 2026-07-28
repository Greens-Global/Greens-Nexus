import { useState, useEffect } from 'react';
import { FileSignature, LayoutDashboard, Folder, LayoutTemplate } from 'lucide-react';
import { api } from '../api';
import ESign from '../components/ESign';
import DocumentsDashboard from '../components/DocumentsDashboard';
import DocumentsBrowser from '../components/DocumentsBrowser';
import DocumentTemplates from '../components/DocumentTemplates';
import DocumentsSearchBar from '../components/DocumentsSearchBar';
import ModuleTabs from '../components/ModuleTabs';

// ── Documents module ─────────────────────────────────────────────────────────
// E-Sign was carved out of HR into its own top-level module (Jul 2026), then
// grown into a full DMS: Dashboard + My Documents + Templates sit alongside
// the untouched E-Sign tab (whose own separate "Templates" sub-tab is for
// e-sign envelope templates - unrelated, unchanged). Backend /esign/* routes
// are unchanged; the DMS half talks to the new /documents/* router.
//
// Cross-module handoff: HR → Hiring "Send for signature" stashes an offer on
// window.__esignPrefill then fires nexus:navigate here. We read it on mount
// (fresh navigation) AND on a repeat nexus:navigate (already mounted), so the
// send wizard opens pre-filled either way.
const TABS = [
  { key: 'documents-dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { key: 'documents-browse', label: 'My Documents', Icon: Folder },
  { key: 'documents-templates', label: 'Templates', Icon: LayoutTemplate },
  { key: 'documents-esign', label: 'E-Sign', Icon: FileSignature },
];

export default function Documents({ activeSub, onSubChange }) {
  // Deep-links: 'documents-esign' / 'documents-esign-requests' both live on the
  // E-Sign tab - ESign reads the raw activeSub to pick its own sub-tab.
  const navSub = String(activeSub || '').startsWith('documents-esign') ? 'documents-esign' : activeSub;
  const sub = TABS.some(t => t.key === navSub) ? navSub : 'documents-dashboard';
  // "New Document"/"New Template" from the Dashboard hand off to the relevant
  // tab and ask it to pop its create dialog open - a bumped counter (not a
  // bool) so a second click while already on that tab still re-triggers it.
  const [browseCreateSignal, setBrowseCreateSignal] = useState(0);
  const [templateCreateSignal, setTemplateCreateSignal] = useState(0);
  // Search (Phase 6) hands off a specific id to open - {id, nonce} so picking
  // the same result twice in a row still re-triggers (nonce always bumps).
  const [openDocSignal, setOpenDocSignal] = useState(null);
  const [openTemplateSignal, setOpenTemplateSignal] = useState(null);

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
  // documents-only grant (no HR access) may 403 these - degrade to external
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
      <div className="view-header" style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="view-title-group">
          <h2>Documents</h2>
          <p>Send, sign and track company documents - one place</p>
        </div>
        <DocumentsSearchBar
          onOpenDocument={(id) => { onSubChange?.('documents-browse'); setOpenDocSignal({ id, nonce: Date.now() }); }}
          onOpenTemplate={(id) => { onSubChange?.('documents-templates'); setOpenTemplateSignal({ id, nonce: Date.now() }); }}
          onGoToEsignRequests={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign-requests' } }))} />
      </div>

      {/* Tabs */}
      {/* Desktop: tabs render centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

      {sub === 'documents-dashboard' && (
        <DocumentsDashboard
          onGoToBrowse={(openCreate) => { onSubChange?.('documents-browse'); if (openCreate) setBrowseCreateSignal(n => n + 1); }}
          onGoToTemplates={(openCreate) => { onSubChange?.('documents-templates'); if (openCreate) setTemplateCreateSignal(n => n + 1); }}
          onGoToEsign={() => onSubChange?.('documents-esign')} />
      )}

      {sub === 'documents-browse' && (
        <DocumentsBrowser openCreateSignal={browseCreateSignal} openDocSignal={openDocSignal}
          employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-templates' && (
        <DocumentTemplates openCreateSignal={templateCreateSignal} openTemplateSignal={openTemplateSignal}
          toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-esign' && (
        <ESign employees={employees} entities={entities} prefill={esignPrefill} navSub={activeSub}
          onPrefillConsumed={() => setEsignPrefill(null)} toastOk={toastOk} toastErr={toastErr}
          onSentRequest={(sent) => {
            // Phase 5 bridge: a send that originated from a Document Builder
            // export carries sourceDocumentId on the prefill - link the new
            // envelope back onto the document once it's actually sent.
            const docId = esignPrefill?.sourceDocumentId;
            if (docId) api.updateDocument(docId, { signRequestId: sent.id, status: 'final' }).catch(toastErr);
          }} />
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
