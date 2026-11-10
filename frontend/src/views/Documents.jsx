import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { FileSignature, Folder, FolderOpen, LayoutTemplate, FileText, ClipboardList, FolderInput, Briefcase, Cable } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
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
import { askToLeave, hasUnsavedWork } from '../lib/dialogGuard';
import { takePendingOpen } from '../lib/pendingOpen';
import { ESIGN_PREFILL_PENDING } from '../lib/pdfToolsHandoff';

// Forms (Neil, 11/02/2026): the builder, the entries table and the entry
// panel, loaded when the tab is opened.
const FormsTab = lazy(() => import('../forms/FormsTab'));
// Filing & Sorting (Nov 2026): the Egnyte filing engine - scan #Unsorted,
// propose per the naming SOPs, apply. Loaded when the tab is opened.
const FilingTab = lazy(() => import('../filing/FilingTab'));
// Browse Files and Wiring (Neil, 11/10/2026): the Egnyte module, moved in.
const EgnyteApp = lazy(() => import('../egnyte/EgnyteApp'));

// ── Files module (the Documents module, renamed) ─────────────────────────────
// Neil, 11/10/2026: "move files into the documents module and rename that
// whole module to Files". The Egnyte browser is its first tab, Browse Files
// (and Wiring, managers, last); the view id stays 'documents'. Each half
// keeps its own grant: 'egnyte' shows Browse Files / Wiring, 'documents' the
// rest (filesTabs below); either one opens the module (App VIEW_ALT_GRANTS).
// Administrators see every tab, as before.
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
const FILES_TAB = { key: 'documents-files', label: 'Browse Files', Icon: FolderOpen };
// Manager+ only, mirroring require_manager on /egnyte/wiring.
const WIRING_TAB = { key: 'documents-wiring', label: 'Wiring', Icon: Cable, minRole: 'manager' };
const TABS = [
  { key: 'documents-browse', label: 'Documents', Icon: Folder },
  { key: 'documents-templates', label: 'Templates', Icon: LayoutTemplate },
  { key: 'documents-forms', label: 'Forms', Icon: ClipboardList },
  { key: 'documents-filing', label: 'Filing & Sorting', Icon: FolderInput },
  { key: 'documents-esign', label: 'Nexus Sign', Icon: FileSignature },
  { key: 'documents-pdf', label: 'PDF Tools', Icon: FileText },
];
// Hiring Documents (Pranshu, 11/04/2026: "through the document section only we
// can just open and start adding all the documents for each company, each
// role"): the SAME setup as Settings > Hiring & Onboarding > Hiring Documents -
// one panel, one set of packets, so a change in either place is the change in
// both. Shown to whoever may open it in Settings (an administrator or People
// editor, never the manager tier's own-team view).
const HIRING_TAB = { key: 'documents-hiring', label: 'Hiring Documents', Icon: Briefcase };
const PacketsModal = lazy(() => import('../components/HiringPacket').then(m => ({ default: m.PacketsModal })));

function HiringDocsTab({ toastOk, toastErr }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '20px 22px', background: 'var(--card)', marginTop: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 800 }}>Hiring Documents</div>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: '6px 0 14px', maxWidth: '70ch' }}>
        Offer letters, hiring packets, promotion letters and separation packages: which documents each company sends, for which
        roles and kind of hire, who signs, and Ready To Send. This is the same setup as Settings &gt; Hiring &amp; Onboarding &gt;
        Hiring Documents - a change made here is there too, and the other way round.
      </p>
      <button type="button" className="primary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12.5 }}>Open Hiring Documents</button>
      {open && (
        <Suspense fallback={<SkeletonBlocks count={4} height={44} />}>
          <PacketsModal onClose={() => setOpen(false)} toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}
    </div>
  );
}
// Old links, bells and emails keep landing: these tabs live in the library now.
const OLD_SUBS = { 'documents-dashboard': 'documents-browse', 'documents-hr-records': 'documents-browse' };

// Tour id this module reports to the server (routers/user_tours.py) - same
// pattern as the Task, Ticket and Support tours' own ids.
const DOCUMENTS_TOUR_ID = 'documents';

// The header's Create menu (Oct 29 2026): "documents-new" is the library with
// its New Document dialog open, "documents-esign-send" is Nexus Sign with the
// Send for Signature wizard open; the address then goes back to the tab.
const CREATE_SUBS = { 'documents-new': 'documents-browse', 'documents-esign-send': 'documents-esign' };

// The tab strip and the tour change the sub directly, not through App's navigate(),
// so unsaved work in PDF Tools (lib/dialogGuard.js) is asked about here.
function changeTab(onSubChange, next) {
  if (!hasUnsavedWork()) { onSubChange?.(next); return; }
  askToLeave().then((ok) => { if (ok) onSubChange?.(next); });
}

export default function Documents({ activeSub, onSubChange }) {
  // Deep-links: 'documents-esign' / 'documents-esign-requests' both live on the
  // E-Sign tab - ESign reads the raw activeSub to pick its own sub-tab.
  const navSub = OLD_SUBS[activeSub] || CREATE_SUBS[activeSub] || (String(activeSub || '').startsWith('documents-esign') ? 'documents-esign'
    // Forms (11/02/2026): 'documents-forms:entry:<id>' is the Forms tab with that entry open.
    : String(activeSub || '').startsWith('documents-forms') ? 'documents-forms' : activeSub);
  const { can, canAccessModule, hrTeam } = useRole();
  const mayHire = !hrTeam && (can('administrator') || !!canAccessModule?.('hr', 'administrator', 'editor'));
  // The Documents half and the Egnyte half each need their own grant (or an
  // administrator); the same bar App.jsx uses to open a module.
  const mayDocs = !canAccessModule || !!canAccessModule('documents', 'administrator');
  const mayFiles = !canAccessModule || !!canAccessModule('egnyte', 'administrator');
  const docTabs = !mayDocs ? [] : mayHire ? [...TABS.slice(0, 2), HIRING_TAB, ...TABS.slice(2)] : TABS;
  const tabs = [
    ...(mayFiles ? [FILES_TAB] : []),
    ...docTabs,
    ...(mayFiles && can('manager') ? [WIRING_TAB] : []),
  ];
  const sub = tabs.some(t => t.key === navSub) ? navSub : (tabs[0]?.key || 'documents-browse');
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
  // The tour walks the Documents half; someone with only Browse Files gets
  // none of it (it would point at tabs they cannot see).
  const mayDocsRef = useRef(mayDocs);
  const onSubChangeRef = useRef(onSubChange);
  useEffect(() => { onSubChangeRef.current = onSubChange; isMobileRef.current = isMobile; mayDocsRef.current = mayDocs; });
  // The steps are built when the tour OPENS (never during render), so they
  // hold still while it runs; each step switches tabs at click time.
  const [tourSteps, setTourSteps] = useState(null);
  useEffect(() => {
    const openTour = () => setTourSteps(buildDocumentsTourSteps({
      go: (k) => changeTab(onSubChangeRef.current, k), isMobile: isMobileRef.current }));
    let cancelled = false;
    api.getToursSeen()
      .then(({ seen }) => { if (!cancelled && mayDocsRef.current && !seen?.[DOCUMENTS_TOUR_ID]) openTour(); })
      .catch(() => { /* can't confirm "seen" - skip the auto-tour rather than risk nagging on every flaky load */ });
    window.addEventListener('nexus:documents-tour', openTour);
    const unTour = registerTour('documents', 'Files', openTour);   // the Help panel's Take the Tour (lib/tours.js)
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

  // PDF Tools' Send For Signature (views/PdfEditorModule.jsx): the built PDF waits
  // here in a note for the Nexus Sign tab. A note, not window.__esignPrefill: from
  // the /pdf-editor address this view remounts, and the leaving instance's
  // nexus:navigate listener above would take the stash with it. No sourceDocumentId:
  // a Sign envelope from here must not mark some library document final.
  useEffect(() => {
    if (sub !== 'documents-esign') return;
    const fromPdfTools = takePendingOpen(ESIGN_PREFILL_PENDING);
    if (!fromPdfTools) return;
    esignSourceDocRef.current = null;
    setEsignPrefill(fromPdfTools);
  }, [sub]);

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
      {!pdfFullBleed && <ModuleTabs tabs={tabs} active={sub} onChange={(k) => changeTab(onSubChange, k)} mobileInline={false} overflow />}

      <div data-tour={`documents-screen-${sub}`}>
      {sub === 'documents-browse' && (
        <DocumentsBrowser openCreateSignal={browseCreateSignal} initialView={activeSub === 'documents-hr-records' ? 'hr' : ''}
          employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-templates' && (
        <DocumentTemplates employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'documents-hiring' && <HiringDocsTab toastOk={toastOk} toastErr={toastErr} />}

      {sub === 'documents-forms' && (
        <Suspense fallback={<SkeletonBlocks count={6} height={44} />}>
          <FormsTab toastOk={toastOk} toastErr={toastErr} activeSub={activeSub} />
        </Suspense>
      )}

      {sub === 'documents-filing' && (
        <Suspense fallback={<SkeletonBlocks count={6} height={44} />}>
          <FilingTab toastOk={toastOk} toastErr={toastErr} />
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

      {(sub === 'documents-files' || sub === 'documents-wiring') && (
        <Suspense fallback={<SkeletonBlocks count={6} height={44} />}>
          <EgnyteApp embedded activeSub={sub === 'documents-wiring' ? 'wiring' : 'browse'} />
        </Suspense>
      )}
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
