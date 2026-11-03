import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { nxSrcVitePlugin } from './scripts/nxsrc-plugin.mjs'
import { stampHtml } from './scripts/stamp-assets.mjs'

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

// The whiteboard engine ships 60 translations as separate dynamic imports
// (`import("./locales/xx-YY-<hash>.js")`). Nexus is English only and the
// engine's English strings are built in, so every one of those imports is
// pointed at one empty module here - otherwise rolldown emits sixty ~70 KB
// chunks (about 4 MB) that no one would ever download but the bundle budget
// still counts (Notes boards, Neil 11/02/2026).
//
// The same plugin stubs `@excalidraw/mermaid-to-excalidraw`: the engine
// reaches it only from its text-to-diagram dialog (off: aiEnabled={false})
// and from pasting Mermaid source, and it drags the whole Mermaid renderer
// in (about 2.5 MB more, landing in vendor-react and tripling first paint).
// The stub rejects, so a pasted Mermaid snippet lands as plain text.
const EXCALIDRAW_LOCALE_STUB = '\0excalidraw-locale-stub';
const EXCALIDRAW_MERMAID_STUB = '\0excalidraw-mermaid-stub';
function excalidrawLocaleStub() {
  return {
    name: 'nexus-excalidraw-locale-stub',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.includes('@excalidraw/excalidraw/dist/')) return null;
      if (/^\.\/locales\/.+\.js$/.test(source)) return EXCALIDRAW_LOCALE_STUB;
      if (source === '@excalidraw/mermaid-to-excalidraw') return EXCALIDRAW_MERMAID_STUB;
      return null;
    },
    load(id) {
      if (id === EXCALIDRAW_LOCALE_STUB) return 'export default {};';
      if (id === EXCALIDRAW_MERMAID_STUB) {
        return 'export async function parseMermaidToExcalidraw() { throw new Error("Diagrams from text are not available in Nexus."); }\nexport default { parseMermaidToExcalidraw };';
      }
      return null;
    },
  };
}


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
        const stamped = stampHtml(html, BUILD_ID);
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
      // Dev serve stamps every element - size is irrelevant locally.
      ? [nxSrcVitePlugin({ root: FRONTEND_ROOT, only: command === 'serve' || process.env.VITE_NX_SRC === 'all' ? undefined : process.env.VITE_NX_SRC === 'interactive' ? 'interactive' : 'handlers' })] : []),
    react(), versionManifest(), stampUnhashedAssets(), excalidrawLocaleStub(),
  ],
  base: '/',
  // Build Mode's local preview / e2e runs share the main checkout's node_modules
  // and point this at their own folder so they never rewrite its .vite cache.
  cacheDir: process.env.NX_VITE_CACHE_DIR || undefined,
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
          // The whiteboard engine (Notes boards, Neil 11/02/2026) has NO manual
          // chunk on purpose. It is reached only by the import() in
          // notes/board/engine/index.js (the adapter, engine/excalidraw.jsx,
          // is the one file that imports the package), and left alone rolldown
          // splits that import into its own lazy chunk (excalidraw-nx2-*, about
          // 540 KB plus the shared pieces in their usual chunks). A manual
          // 'vendor-excalidraw' chunk did the opposite: on rolldown a manual
          // chunk takes a module's whole static tree with it
          // (advancedChunks.includeDependenciesRecursively, default true), so it
          // swallowed react/jsx-runtime, @radix-ui/*, tslib, lodash.* and 50
          // other shared modules, every chunk that needed them imported the
          // 3 MB chunk statically, and the engine shipped on FIRST PAINT for
          // everyone. Measured 11/02/2026: entry static graph 5,448 KB with the
          // manual chunk, 2,628 KB without. check-bundle-size.mjs now guards
          // the first-paint graph (FIRST_PAINT_KB). Do not add one back.
          if (id.includes(EXCALIDRAW_LOCALE_STUB) || id.includes(EXCALIDRAW_MERMAID_STUB) || id.includes('node_modules/@excalidraw/')) return undefined;
          // ...and the libraries only the engine uses stay out of the catch-all
          // below too, so they ride its lazy chunk instead of vendor-react
          // (first paint). Measured 11/02/2026 with the CI's Supabase values:
          // vendor-react 1,192 KB with them in the catch-all.
          if (/node_modules\/(roughjs|points-on-curve|path-data-parser|hachure-fill|perfect-freehand|jotai|jotai-scope|tunnel-rat|fractional-indexing|es6-promise-pool|browser-fs-access|image-blob-reduce|pica|multimath|glur|png-chunk-text|png-chunks-encode|png-chunks-extract|crc-32|open-color|fuzzy|@braintree\/sanitize-url|canvas-roundrect-polyfill|@radix-ui|zustand|@excalidraw|laser-pointer|pwacompat|sliced|lodash\.throttle|lodash\.debounce)\//.test(id)) return undefined;
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
          // jsqr (Forms & Checklists, Neil 11/02/2026): the QR fallback for a
          // browser with no BarcodeDetector, reached only by FillForm's
          // ScanField `await import()`. In the catch-all it added ~130 KB to
          // vendor-react on first paint for everyone.
          if (id.includes('node_modules/jsqr'))       return 'vendor-jsqr';
          // heic2any bundles libheif (~1.4MB of wasm-ish decoder). It is only
          // reached from construction/lib/upload.js's `await import()`, and only
          // when a worker actually uploads an iPhone HEIC - which most uploads
          // are not. Left in the catch-all it tripled vendor-react to 2032KB and
          // shipped on first paint for every user of every module.
          if (id.includes('heic2any') || id.includes('libheif')) return 'vendor-heic';
          if (id.includes('exifr'))                   return 'vendor-exif';
          // Build Mode's screenshots (devnotes/lib/screenshot.js, a dynamic import):
          // only when a pin is taken, never on first paint (Oct 26).
          if (id.includes('modern-screenshot'))       return 'vendor-screenshot';
          // Google Photorealistic 3D Tiles (Site Map "Realistic 3D", Oct 20 2026):
          // the tiles renderer and the glTF / Draco loaders it pulls from three's
          // examples stay in that view's own lazy chunk (no manual chunk: a named
          // one pulled three itself in with it) - never with three or on boot.
          if (/node_modules\/(3d-tiles-renderer|pbf|pmtiles|@mapbox|fflate|three\/examples)\//.test(id)) return undefined;
          // three.js (~700 KB) only loads for the 3D site model (Asset Management
          // property page / the public unit finder) - keep it off first paint.
          if (id.includes('node_modules/three/'))     return 'vendor-three';
          // Live co-typing in Notes (Oct 30 2026): Yjs and its TipTap binding
          // stay in the shared-note editor's own lazy chunk (no manual chunk:
          // a named one pulls ProseMirror in with it and lands on first paint;
          // in the catch-all they pushed vendor-react past its 1000KB budget).
          if (/[\\/]node_modules[\\/](yjs|y-prosemirror|y-protocols|lib0)[\\/]/.test(id)
            || /@tiptap[\\/](extension-collaboration|y-tiptap)/.test(id)) return undefined;
          if (id.includes('node_modules'))            return 'vendor-react';
        },
      },
    },
  },
}))
