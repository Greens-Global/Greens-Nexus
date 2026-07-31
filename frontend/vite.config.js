import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cache namespace (Jul 28, "nx2"): rotates EVERY asset URL past the poisoned
// cache entries from tonight's deploy races. Vendor chunk hashes are stable
// across deploys (their content never changes), so a browser/edge that cached
// the SPA-fallback HTML under vendor-react-<hash>.js was bricked FOREVER -
// no redeploy ever changed that URL (Neil: "spins until I open incognito").
// Bumping the filename prefix gives every asset a never-before-seen URL in
// one shot, no user action needed. The /assets/* Pages Function guarantees
// nothing poisonous is cacheable from here on, so this should never need a
// bump again - but if it ever does, increment nx2 -> nx3.
const CACHE_NS = 'nx2';

// Build identity. Every deploy path supplies a commit sha somewhere:
//   - the wrangler workflows pass VITE_BUILD_ID explicitly,
//   - Cloudflare Pages' own Git builds (how dev deploys) set CF_PAGES_COMMIT_SHA,
//   - a laptop gets 'dev'.
// Two consumers depend on this being real rather than the literal 'dev' it used
// to always be: the update prompt (useBuildVersion) compares it against
// /version.json to tell a user their tab is running superseded code, and the
// post-deploy gate waits for this exact id before asserting the site is healthy
// (without it the gate cannot tell "new build is fine" from "old build still
// being served").
const BUILD_ID = process.env.VITE_BUILD_ID
  || process.env.CF_PAGES_COMMIT_SHA
  || 'dev';

// Emitted as a real file rather than only baked into the bundle, so it can be
// fetched (no-store) by a running tab and by CI without parsing the bundle.
const versionManifest = () => ({
  name: 'nexus-version-manifest',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId: BUILD_ID }) + '\n',
    });
  },
});

// Vite content-hashes everything it bundles into /assets, and _headers marks
// those immutable - correct, and self-correcting on every deploy. Anything under
// public/ is copied VERBATIM: fixed filename, no hash. Cloudflare Pages serves
// those with `max-age=31536000, must-revalidate`, and must-revalidate does not
// bite until the year is up, so one visit pins that file in a browser for a YEAR.
//
// That has now bitten twice:
//   - the PDF engine (app.js/adobe-ui.js/style.css): the theme-sync fix was live
//     at the edge and unreachable for exactly the people who had opened the
//     editor before.
//   - public/guard.js, the BOOT WATCHDOG itself, referenced unhashed from
//     index.html. Every improvement to it was invisible to anyone who had ever
//     loaded Nexus - including the fix that stops the white screen. A watchdog
//     you cannot update is the worst thing in the list to get wrong.
//
// A _headers rule does not solve it: `/pdf-editor-app/*  Cache-Control: no-cache`
// was verified NOT to apply to sub-resources on Pages (only the directory's
// index.html picks up no-cache, from Pages' own HTML handling). So make it
// structural instead of header-dependent - stamp ?v=<BUILD_ID> onto every local
// unhashed script/stylesheet in every emitted HTML file. New id each deploy means
// new URLs, so an update can never be shadowed by a cached copy, whatever the
// cache headers say or whatever host this ends up on.
//
// /assets/* is skipped: already content-hashed, so a query would be redundant.
// Absolute and data: URLs are left alone.
const stampUnhashedAssets = () => ({
  name: 'nexus-stamp-unhashed-assets',
  writeBundle: {
    sequential: true,
    order: 'post',
    async handler(options) {
      const { readFile, writeFile, readdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dir = options.dir || 'dist';
      let entries = [];
      try {
        entries = (await readdir(dir, { recursive: true })).filter(f => f.endsWith('.html'));
      } catch { return; }
      for (const rel of entries) {
        const file = join(dir, rel);
        const html = await readFile(file, 'utf8');
        const stamped = html.replace(
          /((?:src|href)=")(?!https?:|\/\/|data:|\/assets\/)([^"?#]+\.(?:js|css))"/g,
          `$1$2?v=${BUILD_ID}"`,
        );
        if (stamped !== html) await writeFile(file, stamped);
      }
    },
  },
});

export default defineConfig({
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID) },
  plugins: [react(), versionManifest(), stampUnhashedAssets()],
  base: '/',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${CACHE_NS}-[hash].js`,
        chunkFileNames: `assets/[name]-${CACHE_NS}-[hash].js`,
        assetFileNames: `assets/[name]-${CACHE_NS}-[hash][extname]`,
        // Split vendors into separate cached chunks — same approach as Amazon, Netflix, etc.
        // Each chunk loads in parallel and is cached independently by the browser.
        manualChunks(id) {
          if (id.includes('@azure/msal-browser') || id.includes('@azure/msal-react')) return 'vendor-msal';
          if (id.includes('@supabase/supabase-js'))  return 'vendor-supabase';
          if (id.includes('lucide-react'))            return 'vendor-icons';
          // Heavy libs get their OWN chunks so they load on demand instead of on
          // first paint. They're only reached from lazy views / dynamic import()s,
          // so once they're out of the vendor catch-all below they stop shipping
          // on boot. (Previously the catch-all forced ALL node_modules into one
          // 2.7MB chunk, defeating the lazy-loading the source already does.)
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory-vendor')) return 'vendor-charts';
          if (id.includes('xlsx'))                    return 'vendor-xlsx';
          if (id.includes('pdf-lib') || id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('mammoth'))                 return 'vendor-docx';
          if (id.includes('leaflet'))                 return 'vendor-maps';
          if (id.includes('qrcode'))                  return 'vendor-qr';
          if (id.includes('node_modules'))            return 'vendor-react';
        },
      },
    },
  },
})
