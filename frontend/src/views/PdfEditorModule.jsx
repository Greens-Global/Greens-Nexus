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

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

const nexusTheme = () =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

// Cache-bust the iframe once per app load (not per render): the build id in
// production, or a fixed 'dev' tag locally so editor updates show on refresh.
// The theme rides along in the URL so the engine's FIRST paint already matches
// Nexus - computed once at module scope, which is fine because later changes go
// over postMessage (see below); putting live theme in src would remount the
// iframe and discard the open document.
const EDITOR_SRC = `/pdf-editor-app/index.html?v=${import.meta.env.VITE_BUILD_ID || 'dev'}`
  + `&theme=${nexusTheme()}`;

export default function PdfEditorModule() {
  const [hasDoc, setHasDoc] = useState(false);
  const frameRef = useRef(null);

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
  // The editor (in the iframe) posts its document state so the shell can hide
  // the Nexus top bar while editing but keep it on the landing screen. Re-emit
  // as a window event App.jsx listens to (to toggle the header). Reset to
  // "no doc" on unmount so the bar returns when the user navigates away.
  useEffect(() => {
    const onMsg = (e) => {
      // The engine is same-origin, so anything from another origin is not it.
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (d && d.type === 'pdf-editor:doc-state') {
        setHasDoc(!!d.hasDoc);
        window.dispatchEvent(new CustomEvent('nexus:pdf-doc-state', { detail: { hasDoc: !!d.hasDoc } }));
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      window.dispatchEvent(new CustomEvent('nexus:pdf-doc-state', { detail: { hasDoc: false } }));
    };
  }, []);

  return (
    <div className={`pdf-editor-module${hasDoc ? ' has-doc' : ''}`}>
      {/* Module header - icon chip, title, one line of context - so PDF Tools
          reads as part of Nexus, not a bare iframe. Hidden once a document is
          open (full-bleed editing mode). */}
      {!hasDoc && (
        <header className="pdf-editor-head">
          <span className="pdf-editor-head-icon" aria-hidden="true">
            <FileText size={18} />
          </span>
          <div>
            <h1>PDF Tools</h1>
            <p>Edit, convert, sign and organize PDFs without leaving Nexus.</p>
          </div>
        </header>
      )}
      <iframe
        ref={frameRef}
        src={EDITOR_SRC}
        title="PDF Tools"
        allow="clipboard-write"
        onLoad={() => {
          // Re-assert on load: the mount-time push can land before the engine
          // has attached its listener.
          try {
            frameRef.current?.contentWindow?.postMessage(
              { type: 'nexus:theme', theme: nexusTheme() }, window.location.origin);
          } catch { /* ignore */ }
        }}
      />
    </div>
  );
}
