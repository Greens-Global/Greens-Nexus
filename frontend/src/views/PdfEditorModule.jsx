// ── PDF Editor module ─────────────────────────────────────────────────────────
// Standalone module hosting the Nexus PDF Editor. The editor engine is the
// battle-tested vanilla-JS app served as static assets from
// /public/pdf-editor-app (same-origin, so its OCR web workers function). It
// runs isolated in an iframe: React owns the shell, the engine owns the canvas.
//
// The directory is deliberately NOT named /pdf-editor: this module's SPA route
// IS /pdf-editor, and a real static directory of the same name shadows it on
// Cloudflare Pages (Pages resolves the directory before the SPA fallback, so
// /pdf-editor 308'd to /pdf-editor/ and served the bare engine with no Nexus
// shell - which is why a refresh "fixed" the blank frame but lost the sidebar).
// Keep the route and the asset path distinct.
//
// Full-bleed: the editor is an application, not a page — it cancels the
// viewport padding and fills everything below the top header exactly.
//
// Connected to the rest of Nexus (Neil, 11/02/2026). The engine's side is
// public/pdf-editor-app/nexus-bridge.js, this side is pdfTools/usePdfEngine.js;
// what travels between them is listed at the top of the bridge. A file can come
// from Egnyte or Documents and go back to Egnyte or on to Nexus Sign, the engine's
// one save pipeline builds what leaves, and the audit trail hears about each step
// (routers/pdf_tools.py). The Documents library holds structured documents, not
// PDF files, so there is deliberately no Save To Documents.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { api } from "../api";
import { Spinner } from "../components/AsyncState";
import EgnyteBrowser from "../components/EgnyteBrowser";
import WidgetBoundary from "../components/WidgetBoundary";
import { useRole } from "../contexts/RoleContext";
import { ConnectRequired } from "../egnyte/ui";
import { invalidateFolder, parentOf, normPath } from "../egnyte/lib";
import { setInlineDirty } from "../lib/dialogGuard";
import { setPendingOpen, takePendingOpen } from "../lib/pendingOpen";
import { ESIGN_PREFILL_PENDING, PDF_TOOLS_PENDING, isPdfName, pdfFileName } from "../lib/pdfToolsHandoff";
import { Modal } from "../tasks/components";
import { dialog } from "../ui/dialog";
import { HOLD_RECORD_MS } from "../ui/HoldButton";
import OpenFromDocuments from "./pdfTools/OpenFromDocuments";
import PdfNotice from "./pdfTools/PdfNotice";
import SaveToEgnyte from "./pdfTools/SaveToEgnyte";
import usePdfEngine from "./pdfTools/usePdfEngine";
import usePopGuard from "./pdfTools/usePopGuard";
import { browseProblem, openProblem, saveProblem, statusProblem } from "./pdfTools/words";

const nexusTheme = () =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

// Cache-bust the iframe once per app load (not per render): the build id in
// production, or a fixed 'dev' tag locally so editor updates show on refresh.
// The theme rides along in the URL so the engine's FIRST paint already matches
// Nexus - computed once at module scope, which is fine because later changes go
// over postMessage (see below); putting live theme in src would remount the
// iframe and discard the open document.
// Cache-bust the iframe. In production use the stable build id (so the editor
// caches well); in dev fall back to a per-load timestamp so a hard refresh
// always pulls the latest editor code instead of a stale cached index.html
// (which was serving old app.js/style.css even after bumping their ?v=).
const EDITOR_BUILD = import.meta.env.VITE_BUILD_ID || `dev-${Date.now()}`;
const EDITOR_SRC = `/pdf-editor-app/index.html?v=${EDITOR_BUILD}`
  + `&theme=${nexusTheme()}`;

// A big PDF is minutes, not the 18 seconds an ordinary call gets (api.js).
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;   // routers/egnyte.py MAX_UPLOAD_BYTES
const FOLDER_KEY = 'nexus:pdf-tools:egnyte-folder';

function rememberedFolder() {
  try { return localStorage.getItem(FOLDER_KEY) || ''; } catch { return ''; }
}
function rememberFolder(folder) {
  try { localStorage.setItem(FOLDER_KEY, folder); } catch { /* a convenience, nothing more */ }
}

// The listing's row is the only link that addresses a file; what the upload
// answers is a folder-style link Egnyte cannot resolve for a file, so with no row
// the folder is the honest place to send someone.
async function egnyteLink(folder, name, uploaded) {
  try {
    const row = ((await api.egnyteFolder(folder))?.files || [])
      .find((f) => String(f.name).toLowerCase() === String(name).toLowerCase());
    if (row?.webUrl) return row.webUrl;
  } catch { /* fall through to the folder */ }
  return uploaded?.webUrl ? uploaded.webUrl.replace(/\/[^/]*$/, '') : '';
}

export default function PdfEditorModule() {
  const role = useRole();
  const canSaveEgnyte = !!role?.can?.('supervisor');
  const canDocuments = !!(role?.can?.('administrator') || role?.myGrantedModules?.has?.('documents'));

  const [ready, setReady] = useState(false);   // iframe finished loading
  const frameRef = useRef(null);
  // What the person is doing over the editor: 'egnyte-open' | 'documents-open' | 'egnyte-save' | { problem } | { connect }
  const [panel, setPanel] = useState(null);
  const [notice, setNotice] = useState(null);
  const [working, setWorking] = useState('');   // the cover's words, while a file comes in
  const sendingRef = useRef(false);   // a one-click save or send is under way: a second click is not a second upload
  // Where the open file came from, so Save can go back there.
  const [source, setSource] = useState(null);
  const sourceRef = useRef(null);
  useEffect(() => { sourceRef.current = source; }, [source]);

  const logEvent = useCallback((action, fields) => {
    try {
      api.pdfToolsEvent({ action, ...fields })?.catch?.(() => {});
    } catch { /* the trail must never get in the way of the work */ }
  }, []);

  const config = useMemo(() => ({
    canSign: canDocuments,
    canDocuments,
    canSaveEgnyte,
    saveBack: source?.kind === 'egnyte' ? { folder: source.folder, name: source.name } : null,
  }), [canDocuments, canSaveEgnyte, source]);

  // Filled in below: the bridge's asks need functions that need the engine.
  const actionRef = useRef(() => {});

  const engine = usePdfEngine(frameRef, config, {
    onAction: (action) => actionRef.current(action),
    onDid: (d) => logEvent(d.action, {
      fileName: d.name, pages: d.pages, source: sourceRef.current?.label || '',
      destination: d.action === 'download' || d.action === 'export' ? 'This Computer' : '',
    }),
    onLocalOpen: (d) => {
      setSource(null);
      setNotice(null);
      logEvent('open', { fileName: d.name, pages: d.pages, source: 'This Computer' });
    },
    onClosed: () => { setSource(null); setNotice(null); },
  });
  const { doc, docRef, openBytes, build, markSaved, sendConfig } = engine;

  useEffect(() => { sendConfig(); }, [config, sendConfig]);

  // Back and Forward do not pass through navigate().
  usePopGuard(doc.hasDoc && doc.dirty);

  // Keep the engine's theme locked to Nexus's (owner request Jul 30: consistent
  // theme across every module). App.jsx writes data-theme onto <html>, so watch
  // that attribute rather than plumbing the theme state down through props.
  useEffect(() => {
    const push = () => {
      const w = frameRef.current?.contentWindow;
      if (!w) return;
      try { w.postMessage({ type: 'nexus:theme', theme: nexusTheme() }, window.location.origin); } catch { /* frame not ready */ }
    };
    push();
    const obs = new MutationObserver(push);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // ── opening ────────────────────────────────────────────────────────────────

  const loadAndOpen = useCallback(async (target) => {
    setNotice(null);
    setWorking(`Opening ${target.name || target.title || 'your file'}...`);
    try {
      const fetched = target.kind === 'egnyte'
        ? await api.egnyteFile(target.path, { timeoutMs: TRANSFER_TIMEOUT_MS, noRetry: true })
        : await target.load();
      const bytes = await fetched.blob.arrayBuffer();
      const name = target.kind === 'egnyte' ? target.name : pdfFileName(target.title || fetched.filename);
      const opened = await openBytes(bytes, name);
      const label = target.kind === 'egnyte' ? target.path : `Documents: ${target.title}`;
      setSource(target.kind === 'egnyte'
        ? { kind: 'egnyte', folder: parentOf(target.path), name, path: normPath(target.path), label }
        : { kind: 'documents', label });
      logEvent('open', { fileName: opened.name || name, pages: opened.pages, source: label });
    } catch (err) {
      setNotice({ tone: 'error', text: openProblem(target, err), retry: () => loadAndOpen(target) });
    } finally {
      setWorking('');
    }
  }, [openBytes, logEvent]);

  // Opening another file is where unsaved edits would actually go, so that is
  // when to ask, not when someone is only looking through a folder.
  const pickToOpen = useCallback(async (target) => {
    setPanel(null);
    if (docRef.current.hasDoc && docRef.current.dirty) {
      const ok = await dialog.confirm(
        `Your unsaved edits to ${docRef.current.name || 'this file'} will be lost if you open ${target.name || target.title}.`,
        { title: 'Discard Unsaved Edits?', hold: true, holdMs: HOLD_RECORD_MS, confirmText: 'Discard And Open',
          doneText: 'Discarded', cancelText: 'Keep Editing' });
      if (!ok) return;
    }
    loadAndOpen(target);
  }, [docRef, loadAndOpen]);

  // Open In PDF Tools from another screen left a note (lib/pdfToolsHandoff.js).
  const [pending] = useState(() => takePendingOpen(PDF_TOOLS_PENDING));
  const pendingStarted = useRef(false);
  useEffect(() => {
    if (!pending || pendingStarted.current) return;
    pendingStarted.current = true;
    loadAndOpen(pending);
  }, [pending, loadAndOpen]);

  // ── Egnyte: why not, in words, before any listing is tried ─────────────────

  const egnyteThen = useCallback(async (next) => {
    const status = await api.egnyteStatus().catch(() => null);
    const problem = statusProblem(status);
    if (problem) { setPanel({ problem }); return; }
    if (status.oauth?.mustConnect) { setPanel({ connect: true }); return; }
    setPanel(next);
  }, []);

  // ── saving ─────────────────────────────────────────────────────────────────

  const saveTo = useCallback(async (folder, name) => {
    const out = await build();
    if (out.bytes.byteLength > MAX_UPLOAD_BYTES) throw Object.assign(new Error('too large'), { tooLarge: true });
    const fileName = pdfFileName(name);
    const file = new File([out.bytes], fileName, { type: 'application/pdf' });
    const saved = await api.egnyteUpload(folder, file, { timeoutMs: TRANSFER_TIMEOUT_MS, noRetry: true });
    const where = saved?.path || `${folder}/${fileName}`;
    invalidateFolder(folder);
    markSaved();
    setSource({ kind: 'egnyte', folder, name: fileName, path: where, label: where });
    rememberFolder(folder);
    logEvent('save_egnyte', { fileName, pages: out.pages, source: sourceRef.current?.label || '', destination: where });
    setNotice({ tone: 'ok', text: `Saved to ${where}`, link: await egnyteLink(folder, fileName, saved) });
  }, [build, markSaved, logEvent]);

  const saveBack = useCallback(async () => {
    const from = sourceRef.current;
    if (from?.kind !== 'egnyte') return;
    // Redactions never go back in one click: the old version stays in Egnyte.
    if (docRef.current.redacted) { egnyteThen('egnyte-save'); return; }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setNotice({ tone: 'info', text: `Saving to ${from.folder || 'Egnyte'}...`, busy: true });
    try {
      await saveTo(from.folder, from.name);
    } catch (err) {
      setNotice({ tone: 'error', text: saveProblem(err), retry: saveBack, pickFolder: () => egnyteThen('egnyte-save') });
    } finally {
      sendingRef.current = false;
    }
  }, [docRef, egnyteThen, saveTo]);

  // ── signing ────────────────────────────────────────────────────────────────

  const sendForSignature = useCallback(async () => {
    if (sendingRef.current) return;
    if (docRef.current.dirty) {
      const ok = await dialog.confirm(
        'Your edits go with this copy to Nexus Sign and PDF Tools closes the file, so cancelling the send there does not bring them back. Save first to keep a copy.',
        { title: 'Send This Version?', confirmText: 'Continue To Nexus Sign', cancelText: 'Keep Editing' });
      if (!ok) return;
    }
    sendingRef.current = true;
    setNotice({ tone: 'info', text: 'Preparing your PDF for Nexus Sign...', busy: true });
    try {
      const out = await build();
      const name = pdfFileName(out.name || docRef.current.name);
      setPendingOpen(ESIGN_PREFILL_PENDING, {
        title: name.replace(/\.pdf$/i, ''),
        file: new File([out.bytes], name, { type: 'application/pdf' }),
        source: 'pdf',
        parties: [],
      });
      logEvent('send_sign', { fileName: name, pages: out.pages, source: sourceRef.current?.label || '', destination: 'Nexus Sign' });
      setInlineDirty('pdf-tools', false);
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
    } catch {
      setNotice({ tone: 'error', text: 'Could not prepare this PDF for Nexus Sign. Your document is still open here.', retry: sendForSignature });
    } finally {
      sendingRef.current = false;
    }
  }, [build, docRef, logEvent]);

  useEffect(() => {
    actionRef.current = (action) => {
      if (action === 'open-egnyte') egnyteThen('egnyte-open');
      else if (action === 'open-documents' && canDocuments) setPanel('documents-open');
      else if (action === 'save-egnyte' && canSaveEgnyte) egnyteThen('egnyte-save');
      else if (action === 'save-back' && canSaveEgnyte) saveBack();
      else if (action === 'send-sign' && canDocuments) sendForSignature();
    };
  }, [canDocuments, canSaveEgnyte, egnyteThen, saveBack, sendForSignature]);

  const closePanel = () => setPanel(null);
  const startFolder = source?.kind === 'egnyte' ? source.folder : rememberedFolder();

  return (
    <div className={`pdf-editor-module${doc.hasDoc ? ' has-doc' : ''}`}>
      {/* Module header - icon chip, title, one line of context - so PDF Tools
          reads as part of Nexus, not a bare iframe. Hidden once a document is
          open (full-bleed editing mode). */}
      {!doc.hasDoc && (
        <header className="pdf-editor-head">
          <span className="pdf-editor-head-icon" aria-hidden="true">
            <FileText size={18} />
          </span>
          <div>
            <h1>PDF Tools</h1>
            <p>Edit, convert and organize PDFs without leaving Nexus.</p>
          </div>
        </header>
      )}
      {/* Loading cover: hide the iframe until it has fully loaded, so the user
          never sees the editor flash a half-rendered / bfcache state for a
          moment when entering the module. Fades out once onLoad fires. It also
          covers a file on its way in from Egnyte or Documents. */}
      {(!ready || working) && (
        <div className="pdf-editor-loading" role={working ? 'status' : undefined} aria-hidden={working ? undefined : 'true'}>
          <Spinner size="view" />
          <span>{working || 'Loading PDF Tools…'}</span>
        </div>
      )}
      <iframe
        ref={frameRef}
        src={EDITOR_SRC}
        title="PDF Tools"
        allow="clipboard-write"
        style={{ opacity: ready ? 1 : 0 }}
        onLoad={() => {
          setReady(true);
          // Re-assert on load: the mount-time push can land before the engine
          // has attached its listener.
          try {
            frameRef.current?.contentWindow?.postMessage(
              { type: 'nexus:theme', theme: nexusTheme() }, window.location.origin);
          } catch { /* ignore */ }
        }}
      />
      <PdfNotice notice={notice} onDismiss={() => setNotice(null)} />
      {/* A dialog that throws must not take the iframe, and the open document,
          down with it, so these sit under a boundary of their own. */}
      {panel && createPortal(
        <WidgetBoundary name="pdf-tools-dialog" resetKey={String(panel)} fallback={<PanelFailed onClose={closePanel} />}>
          {panel === 'egnyte-open' && (
            <EgnyteBrowser title="Open From Egnyte" browse={api.egnyteFolder} startPath={startFolder} onClose={closePanel}
              canPick={(f) => isPdfName(f.name)} pickHint="Only PDFs open in PDF Tools" describeError={browseProblem}
              onFileClick={(f) => pickToOpen({ kind: 'egnyte', path: f.path, name: f.name })} />
          )}
          {panel === 'documents-open' && <OpenFromDocuments onPick={pickToOpen} onClose={closePanel} />}
          {panel === 'egnyte-save' && (
            <SaveToEgnyte defaultName={pdfFileName(doc.name)} startPath={startFolder} redacted={doc.redacted}
              onSave={saveTo} onClose={closePanel} />
          )}
          {panel.problem && (
            <Modal title="Egnyte" onClose={closePanel} placement="center">
              <div className="nx-fill" style={{ justifyContent: 'center', textAlign: 'center', fontSize: 14, color: 'var(--ink)' }}>{panel.problem}</div>
            </Modal>
          )}
          {panel.connect && (
            <Modal title="Egnyte" onClose={closePanel} placement="center">
              <div className="nx-fill" style={{ justifyContent: 'center' }}><ConnectRequired /></div>
            </Modal>
          )}
        </WidgetBoundary>,
        document.body,
      )}
    </div>
  );
}

function PanelFailed({ onClose }) {
  return (
    <Modal title="Something Went Wrong" onClose={onClose} placement="center">
      <div className="nx-fill" style={{ justifyContent: 'center', textAlign: 'center', fontSize: 14 }}>
        This dialog could not open. Your document is still open behind it.
      </div>
    </Modal>
  );
}
