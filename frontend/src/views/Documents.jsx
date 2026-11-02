import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { FileSignature, Folder, LayoutTemplate, FileText, ClipboardList } from 'lucide-react';
import { api } from '../api';
import { useEntities } from '../lib/queries';
import ESign from '../components/ESign';
import PdfEditorModule from './PdfEditorModule';
import DocumentsBrowser from '../components/DocumentsBrowser';
import DocumentTemplates from '../components/DocumentTemplates';
import ModuleTabs from '../components/ModuleTabs';
import GuidedTour from '../components/GuidedTour';
import { useIsMobile } from '../lib/useIsMobile';
import { buildDocumentsTourSteps } from './documentsTourSteps';
import { registerTour } from '../lib/tours';
import { SkeletonBlocks } from '../components/AsyncState';

// Forms (Neil, 11/02/2026): the builder, the entries table and the entry
// panel, loaded when the tab is opened.
const FormsTab = lazy(() => import('../forms/FormsTab'));

// ── Documents module ─────────────────────────────────────────────────────────
// E-Sign was carved out of HR into its own top-level module (Jul 2026), then
// grown into a full DMS. Four tabs (Neil, 10/31/2026): Documents is one library
// that took in the old Dashboard, My Documents and HR Records tabs; Templates;
// Nexus Sign stays its own tab, unchanged; PDF Tools. Forms (Neil, 11/02/2026)
// is the fifth: field forms built as templates, their entries, review.
// Backend /esign/* routes are unchanged; the DMS half talks to the /documents/*
// router, Forms to /forms/*.
//
// Cross-module handoff: HR → Hiring "Send for signature" stashes an offer on
// window.__esignPrefill then fires nexus:navigate here. We read it on mount
// (fresh navigation) AND on a repeat nexus:navigate (already mounted), so the
// send wizard opens pre-filled either way.
const TABS = [
  { key: 'documents-browse', label: 'Documents', Icon: Folder },
  { key: 'documents-templates', label: 'Templates', Icon: LayoutTemplate },
  { key: 'documents-forms', label: 'Forms', Icon: ClipboardList },
  { key: 'documents-esign', label: 'Nexus Sign', Icon: FileSignature },
  { key: 'documents-pdf', label: 'PDF Tools', Icon: FileText },
];
// Old links, bells and emails keep landing: these tabs live in the library now.
const OLD_SUBS = { 'documents-dashboard': 'documents-browse', 'documents-hr-records': 'documents-browse' };

// Tour id this module reports to the server (routers/user_tours.py) - same
// pattern as the Task, Ticket and Support tours' own ids.
const DOCUMENTS_TOUR_ID = 'documents';

// The header's Create menu (Oct 29 2026): "documents-new" is the library with
// its New Document dialog open, "documents-esign-send" is Nexus Sign with the
// Send for Signature wizard open; the address then goes back to the tab.
const CREATE_SUBS = { 'documents-new': 'documents-browse', 'documents-esign-send': 'documents-esign' };

export default function Documents({ activeSub, onSubChange }) {
  // Deep-links: 'documents-esign' / 'documents-esign-requests' both live on the
  // E-Sign tab - ESign reads the raw activeSub to pick its own sub-tab.
  const navSub = OLD_SUBS[activeSub] || CREATE_SUBS[activeSub] || (String(activeSub || '').startsWith('documents-esign') ? 'documents-esign'
    // Forms (11/02/2026): 'documents-forms:entry:<id>' is the Forms tab with that entry open.
    : String(activeSub || '').startsWith('documents-forms') ? 'documents-forms' : activeSub);
  const tabs = TABS;
  const sub = tabs.some(t => t.key === navSub) ? navSub : 'documents-browse';
  // The + menu's New Document asks the library to pop its create dialog open - a
  // bumped counter (not a bool) so a second click while already there re-triggers it.
  const [browseCreateSignal, setBrowseCreateSignal] = useState(0);
  const [createSeenSub, setCreateSeenSub] = useState(null);
  if (activeSub !== createSeenSub) {
    setCreateSeenSub(activeSub);
    if (CREATE_SUBS[activeSub] === 'documents-browse') setBrowseCreateSignal(n => n + 1);
  }
  useEffect(() => {
    if (CREATE_SUBS[activeSub]) onSubChange?.(CREATE_SUBS[activeSub]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSub]);

  // When a PDF is open in the PDF Editor tab, the editor goes full-bleed
  // (App.jsx hides the Nexus header). Hide Documents' own title + tab strip too
  // so the editor gets the whole viewport, matching its old standalone mode.
  // Full-bleed the moment the PDF Tools tab is active (Neil, Aug 2026): the
  // Documents title + tab strip are redundant there and waste space, so PDF
  // Tools takes over the whole content area right away - not only once a doc
  // is open.
  const pdfFullBleed = sub === 'documents-pdf';

  const [employees, setEmployees] = useState([]);
  const { data: entities = [] } = useEntities();
  const [toast, setToast] = useState(null);
  const [esignPrefill, setEsignPrefill] = useState(() => {
    // Fresh navigation from HR Hiring: the prefill was stashed before this view
    // mounted, so the nexus:navigate event already fired. Pick it up here.
    const p = window.__esignPrefill;
    window.__esignPrefill = null;
    return p || null;
  });
  // Which Document Builder document this envelope came from. Kept separately
  // because esignPrefill is released the moment the wizard has applied it (a
  // prefill left lying around gets re-applied on the next remount and wipes
  // the sender's work) - but the link back to the document is only needed
  // later, once the envelope is actually sent.
  const esignSourceDocRef = useRef(esignPrefill?.sourceDocumentId || null);

  // Guided tour (Oct 1) - same pattern as the Task module's (views/Tasks.jsx):
  // runs itself once per person on their first visit, never again on its own,
  // and replays from the profile menu's "Tour" row (TopHeader, gated on
  // activeView === 'documents'), which fires nexus:documents-tour. "Seen" is
  // server-side, per person - routers/user_tours.py - so a new browser or
  // device does not repeat it.
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  const onSubChangeRef = useRef(onSubChange);
  useEffect(() => { onSubChangeRef.current = onSubChange; isMobileRef.current = isMobile; });
  // The steps are built when the tour OPENS (never during render), so they
  // hold still while it runs; each step switches tabs at click time.
  const [tourSteps, setTourSteps] = useState(null);
  useEffect(() => {
    const openTour = () => setTourSteps(buildDocumentsTourSteps({
      go: (k) => onSubChangeRef.current?.(k), isMobile: isMobileRef.current }));
    let cancelled = false;
    api.getToursSeen()
      .then(({ seen }) => { if (!cancelled && !seen?.[DOCUMENTS_TOUR_ID]) openTour(); })
      .catch(() => { /* can't confirm "seen" - skip the auto-tour rather than risk nagging on every flaky load */ });
    window.addEventListener('nexus:documents-tour', openTour);
    const unTour = registerTour('documents', 'Documents', openTour);   // the Help panel's Take the Tour (lib/tours.js)
    return () => { cancelled = true; window.removeEventListener('nexus:documents-tour', openTour); unTour(); };
  }, []);
  const closeTour = () => {
    setTourSteps(null);
    api.markTourSeen(DOCUMENTS_TOUR_ID).catch(() => {});
  };

  const toastErr = msg => { setToast({ msg, kind: 'error' }); setTimeout(() => setToast(null), 5000); };
  const toastOk  = msg => { setToast({ msg, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };

  // Employees + entities feed the Send wizard's internal-signer picker. A
  // documents-only grant (no HR access) may 403 these - degrade to external
  // parties rather than break the module.
  useEffect(() => {
    api.getEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  // Repeat "Send for signature" while already on Documents: nexus:navigate fires
  // but the view/sub may be a no-op, so consume the stashed prefill here too.
  useEffect(() => {
    const onNav = (e) => {
      if (e.detail?.view === 'documents' && window.__esignPrefill) {
        esignSourceDocRef.current = window.__esignPrefill.sourceDocumentId || null;
        setEsignPrefill(window.__esignPrefill);
        window.__esignPrefill = null;
      }
    };
    window.addEventListener('nexus:navigate', onNav);
    return () => window.removeEventListener('nexus:navigate', onNav);
  }, []);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* No module header. Sagar, Sep 17: "we don't need this on any page,
          anyway we're having a search bar in all pages already - why keep
          multiple". Documents, Templates and Nexus Sign each carry their
          own search over their own list, so a fourth box that searched across
          all three was a second way to do the same thing, sitting on a band of
          chrome that pushed every screen down by ~90px. The tab strip below is
          the module's navigation. This also removed the only caller of
          DocumentsSearchBar (deleted) and of the open-by-id signals. */}
      {/* Tabs */}
      {/* Desktop: tabs render centered in the top header. Phones get them as
          the bottom bar instead (MobileNav.jsx's DOCUMENT_ACTIONS, the same
          icon-over-label treatment the Task and Item modules use), so the
          in-page strip is suppressed there - two strips would be the same
          navigation twice. */}
      {!pdfFullBleed && <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} mobileInline={false} overflow />}

      <div data-tour={`documents-screen-${sub}`}>
      {sub === 'documents-browse' && (
        <DocumentsBrowser openCreateSignal={browseCreateSignal} initialView={activeSub === 'documents-hr-records' ? 'hr' : ''}
          employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-templates' && (
        <DocumentTemplates employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-forms' && (
        <Suspense fallback={<SkeletonBlocks count={6} height={44} />}>
          <FormsTab toastOk={toastOk} toastErr={toastErr} activeSub={activeSub} />
        </Suspense>
      )}

      {sub === 'documents-esign' && (
        <ESign employees={employees} entities={entities} prefill={esignPrefill} navSub={activeSub}
          onPrefillConsumed={() => setEsignPrefill(null)} toastOk={toastOk} toastErr={toastErr}
          onSentRequest={(sent) => {
            // Phase 5 bridge: a send that originated from a Document Builder
            // export carries sourceDocumentId on the prefill - link the new
            // envelope back onto the document once it's actually sent.
            const docId = esignSourceDocRef.current;
            if (docId) api.updateDocument(docId, { signRequestId: sent.id, status: 'final' }).catch(toastErr);
          }} />
      )}

      {sub === 'documents-pdf' && <PdfEditorModule />}
      </div>

      {tourSteps && <GuidedTour steps={tourSteps} onClose={closeTour} />}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
