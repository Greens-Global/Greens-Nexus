// ── PDF Editor module ─────────────────────────────────────────────────────────
// Standalone module hosting the Nexus PDF Editor. The editor engine is the
// battle-tested vanilla-JS app served as static assets from
// /public/pdf-editor (same-origin, so its OCR web workers function). It runs
// isolated in an iframe: React owns the shell, the engine owns the canvas.
//
// Full-bleed: the editor is an application, not a page — it cancels the
// viewport padding and fills everything below the top header exactly.

// Cache-bust the iframe once per app load (not per render): the build id in
// production, or a fixed 'dev' tag locally so editor updates show on refresh.
const EDITOR_SRC = `/pdf-editor/index.html?v=${import.meta.env.VITE_BUILD_ID || 'dev'}`;

export default function PdfEditorModule() {
  return (
    <div className="pdf-editor-module">
      <iframe
        src={EDITOR_SRC}
        title="Nexus PDF Editor"
        allow="clipboard-write"
      />
    </div>
  );
}
