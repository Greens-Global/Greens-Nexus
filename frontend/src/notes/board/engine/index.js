// The Board's drawing engine, behind one adapter (Neil, 11/02/2026).
//
// Neil's concern: "requiring Excalidraw may not scale with time". The lock-in
// is the element JSON, not the package - so the package is a replaceable
// part: this file is the contract and the lazy loader, `excalidraw.jsx` the
// one module in the repo that imports the package (scripts/
// check-engine-imports.mjs, run by `npm run lint`, fails any other), and
// everything else - Board.jsx, exportBoard.js, the live session - talks to
// the Engine object this hands out. Replacing the engine = a new adapter
// module satisfying the same contract, and nothing else moves.
//
// This file imports nothing of the engine. It is safe to import from
// anywhere (useNoteSync, the list) without pulling the 3 MB chunk in: the
// chunk is fetched by `loadEngine()` alone, the first time a board opens.
//
// The contract (`Engine`):
//   Canvas      React component: { scene, onChange(raw), look, readOnly,
//               viewportRef, onReady(handle), theme, name, phone, autoFocus,
//               collaborating, onPointerUpdate, topRight, menu }. `scene` is a
//               NexusScene (scene.js), fed once; `onChange` gives the engine's
//               live raw state { elements, appState, files }; `onReady` hands
//               the imperative handle up (getSceneElementsIncludingDeleted,
//               getSceneElements, getAppState, getFiles, addFiles,
//               updateScene({ elements?, appState?, collaborators?,
//               captureUpdate }), scrollToContent, setToast).
//   toScene     (raw: { elements, appState, files | filesMeta, look }) -> NexusScene
//   fromScene   (scene: NexusScene) -> raw the Canvas starts from
//   exportPng   (raw, { scale, background, padding, maxWidth }) -> Blob
//   exportSvg   (raw) -> string
//   reconcile   (local, remote) -> elements: newest copy per id, remote
//               repaired by the engine first
//   version     string
// and alongside the contract: `restore(elements, { refreshDimensions })` (the
// engine's repair), `copyPng(raw)`, `Menu` ({ Root, Item, Custom,
// Separator } for the board's own menu rows), `CAPTURE`, and the optional
// `markup` ({ setTool(handle, tool), setStyle(handle, appState),
// toggleStyle(handle), undo(root), redo(root), prepare(elements) } - the markup bar, markupTools.js; a board
// whose engine has none shows the engine's own tools alone).
//
// `NexusScene` is the saved `nexus-board` JSON (scene.js) - unchanged on
// disk by any of this.

/** The words a handle's updateScene takes for the undo stack: this person's
 *  own change (IMMEDIATELY) or another's work put on the canvas (NEVER). The
 *  adapter must map them onto the engine's own; excalidraw.test.jsx pins it. */
export const CAPTURE = Object.freeze({ IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER' });

export const ENGINE_MEMBERS = Object.freeze(['Canvas', 'toScene', 'fromScene', 'exportPng', 'exportSvg', 'reconcile', 'version']);

const defaultImporter = () => import('./excalidraw.jsx');
let importer = defaultImporter;
let loading = null;
let loaded = null;

/** Throws when a module is not the whole contract (a half-built adapter fails
 *  loudly here, into the fallback, never halfway through a board). */
export function validateEngine(eng) {
  if (!eng || typeof eng !== 'object') throw new Error('The drawing engine module is empty');
  const missing = ENGINE_MEMBERS.filter((k) => eng[k] == null);
  if (missing.length) throw new Error(`The drawing engine is missing ${missing.join(', ')}`);
  return eng;
}

/** The engine, loaded once (the vendor chunk) and shared. A load that fails
 *  (the chunk missing after a deploy, the CSP, offline) is NOT remembered:
 *  the next call - Retry - imports again. */
export function loadEngine() {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = Promise.resolve()
      .then(() => importer())
      .then((mod) => { loaded = validateEngine(mod?.default ?? mod); return loaded; })
      .catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/** The engine if it is already here (sync), else null. */
export function engineLoaded() { return loaded; }

/** Forget the loaded engine; with an importer, load from that instead (tests). */
export function resetEngine(nextImporter) {
  loaded = null;
  loading = null;
  importer = typeof nextImporter === 'function' ? nextImporter : defaultImporter;
}
