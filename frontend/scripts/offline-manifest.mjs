// The offline app shell's file list (FULL OFFLINE for field work, Neil
// 11/03/2026; guide docs/Offline.md). A small Vite plugin:
//
//   generateBundle - works out which built files the phone must hold to open
//                    Nexus with no signal: the entry chunk and everything it
//                    imports statically (first paint), plus every chunk that
//                    holds one of OFFLINE_SCREENS below with ITS static
//                    imports, and the CSS those chunks bring;
//   writeBundle    - writes that list into dist/sw.js (the `const MANIFEST =
//                    null;` line of public/sw.js), with the build id. A new
//                    deploy is therefore a new sw.js, which is how browsers
//                    notice the update.
//
// A field screen that must open offline adds its source file here (and its
// queued kinds to src/lib/offline/kinds.js). Anything else a person opens
// online is saved by the worker as they go (cache first for /assets/*), so the
// list is the floor, not the ceiling. Keep it to field screens: every file
// here is downloaded by every phone after every deploy.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OFFLINE_SCREENS = [
  // The outbox, the store and their screens (src/lib/offline, components/offline).
  'src/lib/offline/',
  'src/components/offline/',
  // Forms: Fill a Form from Workday's tile and the shift card (the proof adoption).
  'src/forms/FillForm.jsx',
  'src/forms/FormsTile.jsx',
  'src/forms/formsOffline.js',
  // Workday: views/TimeClock.jsx is the Workday page (the punch card and the
  // overview), views/MyHR.jsx its overview with the Fill a Form tile and the
  // embedded My Shifts (the shift card's forms). The manager's planner
  // (views/Shifts.jsx, with its maps) is NOT a field screen - not here.
  'src/views/TimeClock.jsx',
  'src/views/MyHR.jsx',
  'src/components/MyShifts.jsx',
  'src/components/ESign.jsx',     // the signature pad a form's signature field opens
  'node_modules/jsqr/',           // a form's QR scan where the browser has no reader
  // Construction in the field (Neil, 11/03/2026, plan phase 3): the job page and its
  // field tabs (punch, photos, changes, closeout), Site Activity with the daily
  // log, and the outbox kinds. The manager-only weekly report is not here.
  'src/construction/constructionOffline.js',
  'src/construction/DailyLogCapture.jsx',
  'src/construction/SiteActivity.jsx',
  'src/construction/job/JobPage.jsx',
  'src/construction/job/PunchTab.jsx',
  'src/construction/job/PhotosTab.jsx',
  'src/construction/job/ChangesTab.jsx',
  'src/construction/job/FieldTicketSheet.jsx',
  'src/construction/job/CloseoutTab.jsx',
];

// Unhashed files the shell asks for (index.html's guard, the manifest, icons).
export const OFFLINE_STATIC = [
  '/guard.js',
  '/manifest.webmanifest',
  '/icons/nexus-192.png',
  '/icons/nexus-badge-96.png',
  '/icons/apple-touch-icon-180.png',
];

const PLACEHOLDER = /const MANIFEST = null;[^\n]*/;
const KILL_LINE = /const KILL = false;[^\n]*/;

/** The emergency switch (docs/Offline.md runbook): VITE_OFFLINE_SHELL=off at
 *  build time ships a worker that empties every shell cache, answers no
 *  request and keeps push. */
export const shellKilled = (env = process.env) => String(env.VITE_OFFLINE_SHELL || '').trim().toLowerCase() === 'off';

/** public/sw.js as the build writes it: the file list in, or the kill switch on. */
export function writeWorker(src, { buildId, assets, killed }) {
  if (!PLACEHOLDER.test(src)) throw new Error('offline-manifest: public/sw.js lost its `const MANIFEST = null;` line');
  if (!KILL_LINE.test(src)) throw new Error('offline-manifest: public/sw.js lost its `const KILL = false;` line');
  if (killed) return src.replace(KILL_LINE, 'const KILL = true; // VITE_OFFLINE_SHELL=off');
  const manifest = { build: buildId, assets, static: OFFLINE_STATIC };
  return src.replace(PLACEHOLDER, `const MANIFEST = ${JSON.stringify(manifest)};`);
}

const asList = (v) => (v ? [...v] : []);

/** The files to precache from a Rollup / Rolldown bundle object. */
export function offlineFiles(bundle, screens = OFFLINE_SCREENS) {
  const chunks = Object.values(bundle).filter((c) => c && c.type === 'chunk');
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const want = new Set();
  const add = (c) => {
    if (!c || want.has(c.fileName)) return;
    want.add(c.fileName);
    for (const css of asList(c.viteMetadata?.importedCss)) want.add(css);
    for (const f of c.imports || []) add(byFile.get(f));
  };
  for (const c of chunks) if (c.isEntry) add(c);
  const norm = (id) => String(id || '').replace(/\\/g, '/');
  for (const c of chunks) {
    const ids = (c.moduleIds || Object.keys(c.modules || {})).map(norm);
    if (ids.some((id) => screens.some((s) => id.includes(`/${s}`) || id.includes(s)))) add(c);
  }
  return [...want].filter((f) => f.startsWith('assets/')).sort().map((f) => `/${f}`);
}

export function offlineManifestPlugin({ buildId }) {
  let assets = [];
  return {
    name: 'nexus-offline-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      assets = offlineFiles(bundle);
    },
    writeBundle: {
      sequential: true,
      order: 'post',
      async handler(options) {
        const dir = options.dir || 'dist';
        const file = join(dir, 'sw.js');
        let src;
        try { src = await readFile(file, 'utf8'); } catch { return; }   // no worker in this build
        const killed = shellKilled();
        await writeFile(file, writeWorker(src, { buildId, assets, killed }));
        if (killed) console.log('offline shell: OFF (VITE_OFFLINE_SHELL=off) - sw.js empties its caches and answers no request; push stays');
        else console.log(`offline shell: ${assets.length} files precached by sw.js (build ${String(buildId).slice(0, 12)})`);
      },
    },
  };
}
