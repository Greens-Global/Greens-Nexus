import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { nxSrcVitePlugin } from './scripts/nxsrc-plugin.mjs'

// Build Mode (Oct 24 2026). Dev builds stamp every host JSX element that has a
// handler or an aria / role attribute with data-nx-src="<fileId>:line:col"
// (scripts/nxsrc-plugin.mjs; the file table is /nx-src-files.json), so a pin
// can say which file and line drew the element it sits on (devnotes/lib/
// capture.js sourceOf). On for Cloudflare's dev branch build, with
// VITE_NX_SRC=1|interactive|all locally, and in `vite` dev serve; never on a
// production build. Component names were the other idea: rolldown's
// output.keepNames breaks the build (MISSING_EXPORT in underscore, Oct 24
// 2026) and esbuild.keepNames is a no-op under Vite 8, so the stamps are the
// one source of truth and componentsFor is best effort.
const DEV_BRANCH = process.env.CF_PAGES_BRANCH === 'dev';
const NX_SRC = DEV_BRANCH || !!process.env.VITE_NX_SRC;   // 1 | interactive | all
const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url));

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
// to always be: the new-version bar (useBuildVersion) compares it against
// /version.json to tell a user their tab is running superseded code, and the
// post-deploy gate waits for this exact id before asserting the site is healthy
// (without it the gate cannot tell "new build is fine" from "old build still
// being served").
const BUILD_ID = process.env.VITE_BUILD_ID
  || process.env.CF_PAGES_COMMIT_SHA
  || 'dev';
// When this build was cut. The announcement bar's new-version mode asks the
// API what came after it, to say what the waiting version brings
// (components/FeatureBanner.jsx, RUNNING_SINCE in lib/useBuildVersion.js).
const BUILD_TIME = new Date().toISOString();

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

export default defineConfig(({ command }) => ({
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(BUILD_TIME),
    'import.meta.env.VITE_NX_SRC': JSON.stringify(NX_SRC || command === 'serve' ? '1' : ''),
  },
  plugins: [
    // The stamps run before plugin-react's JSX compile (enforce: 'pre'); never
    // under vitest, where they would only slow the transforms down.
    // Measured Oct 24 2026 (plain build 14086 KB, cap 14600): every host
    // element with a full path = 16005 KB; elements with text / a handler /
    // aria, full path = 15600 KB; the same with the compact "<fileId>:line:col"
    // value = 14804 KB; elements with a handler or aria / role only, compact =
    // 14305 KB (8,491 stamps) - the default, the one that fits the budget. A
    // pin on plain text resolves to its nearest stamped ancestor (source.self
    // = false). VITE_NX_SRC=interactive or =all for the bigger modes locally.
    ...((NX_SRC || command === 'serve') && !process.env.VITEST
      ? [nxSrcVitePlugin({ root: FRONTEND_ROOT, only: process.env.VITE_NX_SRC === 'all' ? undefined : process.env.VITE_NX_SRC === 'interactive' ? 'interactive' : 'handlers' })] : []),
    react(), versionManifest(), stampUnhashedAssets(),
  ],
  base: '/',
  // Automatic JSX runtime for BOTH build and Vitest transforms (source files
  // don't import React; without this, Vitest transforms them classic and every
  // component render throws "React is not defined").
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  // Vitest: render-smoke tests run in jsdom. Catches runtime render crashes
  // (e.g. undefined.length) that build + lint cannot - the exact class of bug
  // that shipped the task-list crash on 2026-08-02.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.js',
    css: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
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
          // heic2any bundles libheif (~1.4MB of wasm-ish decoder). It is only
          // reached from construction/lib/upload.js's `await import()`, and only
          // when a worker actually uploads an iPhone HEIC - which most uploads
          // are not. Left in the catch-all it tripled vendor-react to 2032KB and
          // shipped on first paint for every user of every module.
          if (id.includes('heic2any') || id.includes('libheif')) return 'vendor-heic';
          if (id.includes('exifr'))                   return 'vendor-exif';
          // Google Photorealistic 3D Tiles (Site Map "Realistic 3D", Oct 20 2026):
          // the tiles renderer and the glTF / Draco loaders it pulls from three's
          // examples stay in that view's own lazy chunk (no manual chunk: a named
          // one pulled three itself in with it) - never with three or on boot.
          if (/node_modules\/(3d-tiles-renderer|pbf|pmtiles|@mapbox|fflate|three\/examples)\//.test(id)) return undefined;
          // three.js (~700 KB) only loads for the 3D site model (Asset Management
          // property page / the public unit finder) - keep it off first paint.
          if (id.includes('node_modules/three/'))     return 'vendor-three';
          if (id.includes('node_modules'))            return 'vendor-react';
        },
      },
    },
  },
}))
