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

import { useEffect, useState } from "react";

// Cache-bust the iframe once per app load (not per render): the build id in
// production, or a fixed 'dev' tag locally so editor updates show on refresh.
const EDITOR_SRC = `/pdf-editor-app/index.html?v=${import.meta.env.VITE_BUILD_ID || 'dev'}`;

export default function PdfEditorModule() {
  const [hasDoc, setHasDoc] = useState(false);
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
      <iframe
        src={EDITOR_SRC}
        title="Nexus PDF Editor"
        allow="clipboard-write"
      />
    </div>
  );
}
