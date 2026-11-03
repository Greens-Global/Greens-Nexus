// Stamp ?v=<build id> onto every local unhashed script / stylesheet in an HTML
// file. public/ is copied verbatim and Cloudflare Pages caches it for a year,
// so a new URL per deploy is the only thing that gets a fix to people who have
// opened the page before (see the long note in vite.config.js).
//
// A URL that already carries a hand-set ?v= is re-stamped, not skipped: the PDF
// engine's index.html kept ?v=20260829d for months because the old pattern
// stopped at the "?". /assets/* is already content-hashed; absolute and data:
// URLs are left alone. Runtime-loaded files (the pdf.js worker, the lazy libs)
// read the page's own stamp - see _assetUrl in pdf-editor-app/app.js.
const LOCAL_ASSET = /((?:src|href)=")(?!https?:|\/\/|data:|\/assets\/)([^"?#]+\.(?:js|css))(?:\?v=[^"#]*)?"/g;

export const stampHtml = (html, buildId) => html.replace(LOCAL_ASSET, `$1$2?v=${buildId}"`);
