// A Board - the Notes whiteboard (Neil, 11/02/2026). The Excalidraw engine
// (MIT, self-hosted) wrapped as a Nexus screen: our looks (Clean / Sketch),
// our menu (Fit, Export as PNG / SVG, Copy as Picture, Download Board File,
// Canvas Background, Clear Board), our images (the
// private bucket through files.js), our theme, and nothing of the engine's
// own hosted features. The caller (NotesPage) owns saving: Board hands it a
// serialized scene 800 ms after the last change and a PNG thumbnail 3 s
// after, and never talks to the API itself except to store an image.
//
// Lazy: NotesPage imports this file with React.lazy, so the engine's chunk
// (vendor-excalidraw) is fetched only when a board opens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, MainMenu, THEME, CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw';
import { Download, Image as ImageIcon, Copy, FileJson, Maximize2, Eraser } from 'lucide-react';
import '@excalidraw/excalidraw/index.css';
import './board.css';
import { parseScene, serializeScene, applyLook, lookDefaults, emptyScene, LOOKS } from './scene';
import { uploadBoardFile, loadBoardFiles } from './files';
import { reconcile, remoteWins } from './boardSync';
import { exportPng, exportSvg, exportThumb, copyPng, downloadBlob, downloadScene } from './exportBoard';
import { dataUrlToFile } from '../../tasks/lib';
import { exportFileName } from '../notesModel';
import { dialog } from '../../ui/dialog';
import { useKeyboardInset } from '../../lib/useVisualViewport';

// The engine fetches its fonts from here (copied from the package by
// scripts/copy-excalidraw-assets.mjs). Set before the first render so the
// first text element already measures with the right face.
export const ASSET_PATH = '/excalidraw-assets/';
if (typeof window !== 'undefined' && !window.EXCALIDRAW_ASSET_PATH) window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;

const SAVE_MS = 800;
const THUMB_MS = 3000;
const LOOK_LABEL = { clean: 'Clean', sketch: 'Sketch' };
// Canvas Background: the engine's own picker row is sentence case and has no
// api to open it from our menu, so the menu offers these (the engine's own
// light swatches; dark mode inverts them like every engine color).
const CANVAS_COLORS = [
  { color: '#ffffff', label: 'White' }, { color: '#f8f9fa', label: 'Light Gray' }, { color: '#f5faff', label: 'Light Blue' },
  { color: '#fffce8', label: 'Light Yellow' }, { color: '#fdf8f6', label: 'Light Rose' },
];

// Elements that come from outside this engine (another browser over the live
// session, a refreshed saved scene) go through the engine's own repair
// first, so one malformed element never throws inside the canvas loop.
// Text keeps its saved size (refreshDimensions: false) - the sender measured it.
function restoreRemote(elements) {
  try { return restoreElements(elements || [], null, { refreshDimensions: false }); } catch { /* fall back one by one */ }
  const out = [];
  for (const el of elements || []) {
    try { out.push(...restoreElements([el], null, { refreshDimensions: false })); } catch { /* dropped: it could not be drawn */ }
  }
  return out;
}

const elKey = (e) => `${e?.version || 0}:${e?.versionNonce ?? 0}`;

function readTheme() {
  if (typeof document === 'undefined') return THEME.LIGHT;
  return document.documentElement.getAttribute('data-theme') === 'dark' ? THEME.DARK : THEME.LIGHT;
}

/** The app's light / dark, followed live (the profile menu switches it). */
function useAppTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

export default function Board({ note, isPhone = false, look: lookProp, onLook, onScene, onThumb, collab = null, onApi }) {
  const canEdit = !!note?.canEdit;
  const theme = useAppTheme();
  const kbInset = useKeyboardInset(isPhone);
  // The scene as it was handed to us - parsed once per note; the engine owns
  // it from there. A broken scene opens empty rather than crashing the page
  // (the caller already refuses to save over it: see NotesPage).
  const initial = useMemo(() => parseScene(note?.scene) || emptyScene('clean'), [note?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const look = LOOKS.includes(lookProp) ? lookProp : initial.look;
  const [api, setApi] = useState(null);
  const [notice, setNotice] = useState(null);     // { text, error }
  // File meta the scene keeps (id -> {id, mimeType, url, created}); uploads add to it.
  const filesMeta = useRef({ ...initial.files });
  const uploading = useRef(new Set());
  const saveTimer = useRef(0);
  const thumbTimer = useRef(0);
  const savePending = useRef(false);
  // The last scene handed to onScene (starting from the saved one): a change
  // that serializes the same (a selection, a hover) is never sent again.
  const lastSent = useRef(note?.scene || '');
  // Each element's version as this engine last reported it, to tell a change
  // drawn here from one the live session put on the engine.
  const seenEls = useRef(new Map(initial.elements.map((e) => [e.id, elKey(e)])));
  const lookRef = useRef(look);
  const propsRef = useRef({ onScene, onThumb, canEdit, noteId: note?.id });
  // The live session (useBoardCollab), read through a ref so the engine's
  // callbacks stay stable while the session connects, restarts or ends.
  const collabRef = useRef(collab);
  useEffect(() => { lookRef.current = look; propsRef.current = { onScene, onThumb, canEdit, noteId: note?.id }; collabRef.current = collab; });

  const initialData = useMemo(() => ({
    elements: initial.elements,
    appState: { ...lookDefaults(initial.look), ...initial.appState },
    files: {},     // loaded below through the signed viewer
    scrollToContent: initial.elements.length > 0,
  }), [initial]);

  // Hand the api up once, load the images.
  useEffect(() => {
    if (!api) return undefined;
    onApi?.(api);
    let alive = true;
    const metas = { ...filesMeta.current };
    if (Object.keys(metas).length) {
      loadBoardFiles(metas).then((files) => { if (alive && Object.keys(files).length) api.addFiles(Object.values(files)); });
    }
    return () => { alive = false; };
  }, [api]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Images the others added arrive as meta over the live session: remember
  // them so the saved scene keeps them, and show them through the viewer.
  const onRemoteFiles = useCallback((metas) => {
    const fresh = {};
    for (const [id, meta] of Object.entries(metas || {})) {
      if (!filesMeta.current[id] && meta?.url) { filesMeta.current[id] = meta; fresh[id] = meta; }
    }
    if (!api || !Object.keys(fresh).length) return;
    loadBoardFiles(fresh).then((files) => { if (Object.keys(files).length) api.addFiles(Object.values(files)); });
  }, [api]);

  // Attach the live session to the engine - again when the session object
  // changes (it connected, or was rebuilt); attach is idempotent.
  useEffect(() => {
    if (!api || !collab?.attach) return;
    collab.attach(api, { onRemoteFiles, restore: restoreRemote });
  }, [api, collab, onRemoteFiles]);

  // The saved scene moved on under this board (a new rev this Board did not
  // just send: a save merged with someone else's shapes after a 409 or a
  // draft merge, or - for a viewer, who has no live session - anyone's
  // save). The newer drawing goes on the engine without a history entry:
  // a viewer takes it as is; an editor reconciles it with what is on the
  // canvas (newest version of each element wins) and does not save it back
  // - the elements that came this way are remembered so the engine's echo
  // schedules nothing.
  const seenScene = useRef(note?.scene);
  const fromScene = useRef(new Map());
  useEffect(() => {
    if (!api || note?.scene === seenScene.current) return;
    seenScene.current = note?.scene;
    if (canEdit && note?.scene === lastSent.current) return;     // our own save coming back
    const next = parseScene(note?.scene);
    if (!next) return;
    const incoming = restoreRemote(next.elements);
    if (canEdit) {
      const current = api.getSceneElementsIncludingDeleted();
      const mine = new Map((current || []).map((e) => [e?.id, e]));
      const winners = incoming.filter((e) => e?.id && remoteWins(mine.get(e.id), e));
      if (winners.length) {
        for (const e of winners) fromScene.current.set(e.id, elKey(e));
        api.updateScene({ elements: reconcile(current, winners), captureUpdate: CaptureUpdateAction.NEVER });
      }
    } else {
      api.updateScene({ elements: incoming, captureUpdate: CaptureUpdateAction.NEVER });
    }
    onRemoteFiles(next.files);
  }, [note?.scene, api, canEdit, onRemoteFiles]);

  const serialize = useCallback(() => {
    if (!api) return '';
    // An image still on its way to the bucket stays out of the saved scene
    // until its file meta exists: a board closed mid-upload never keeps a
    // picture that can not load.
    const els = api.getSceneElementsIncludingDeleted()
      .filter((e) => !(e?.type === 'image' && e.fileId && !filesMeta.current[e.fileId] && uploading.current.has(e.fileId)));
    return serializeScene({
      elements: els,
      appState: api.getAppState(),
      filesMeta: filesMeta.current,
      look: lookRef.current,
    });
  }, [api]);

  // Hand the scene to the caller - only when it is not what was sent last.
  const sendScene = useCallback(() => {
    savePending.current = false;
    const s = serialize();
    if (!s || s === lastSent.current) return;
    lastSent.current = s;
    propsRef.current.onScene?.(s);
  }, [serialize]);
  const sendRef = useRef(sendScene);
  useEffect(() => { sendRef.current = sendScene; }, [sendScene]);

  const scheduleSave = useCallback(() => {
    if (!propsRef.current.canEdit) return;
    clearTimeout(saveTimer.current);
    savePending.current = true;
    saveTimer.current = setTimeout(() => sendRef.current(), SAVE_MS);
    if (propsRef.current.onThumb) {
      clearTimeout(thumbTimer.current);
      thumbTimer.current = setTimeout(async () => {
        try { const blob = await exportThumb(api); if (blob) propsRef.current.onThumb?.(blob); } catch { /* a thumbnail is a nicety */ }
      }, THUMB_MS);
    }
  }, [api]);
  // Back / Close inside the 800 ms after the last stroke: the stroke is
  // handed over now, not dropped with the timer.
  useEffect(() => () => {
    if (savePending.current && propsRef.current.canEdit) {
      try { sendRef.current(); } catch { /* the engine is already gone */ }
    }
    clearTimeout(saveTimer.current); clearTimeout(thumbTimer.current);
  }, []);

  // A new image in the engine's file map (pasted, dropped, picked) goes to the
  // bucket; the scene keeps its URL. If the upload fails, the image elements
  // that point at it are removed so the board never keeps a broken picture.
  const storeNewFiles = useCallback((files, elements) => {
    if (!api || !propsRef.current.canEdit) return;
    for (const [id, f] of Object.entries(files || {})) {
      if (filesMeta.current[id] || uploading.current.has(id) || !f?.dataURL) continue;
      uploading.current.add(id);
      setNotice({ text: 'Storing the image…' });
      const file = dataUrlToFile(f.dataURL, `board-${id.slice(0, 8)}.${(f.mimeType || 'image/png').split('/')[1] || 'png'}`);
      const done = () => { uploading.current.delete(id); if (!uploading.current.size) setNotice(null); };
      if (!file) { done(); continue; }
      uploadBoardFile(propsRef.current.noteId, file)
        .then((meta) => {
          // Keyed by the ENGINE's file id - the one its image elements carry.
          filesMeta.current[id] = { ...meta, id };
          done();
          // The others learn of the image through the live session's file meta.
          collabRef.current?.onChange?.(api.getSceneElementsIncludingDeleted(), filesMeta.current, api.getAppState?.()?.selectedElementIds);
          scheduleSave();
        })
        .catch((e) => {
          done();
          setNotice({ text: `The image was not stored: ${e?.message || 'upload failed'}`, error: true });
          setTimeout(() => setNotice((n) => (n?.error ? null : n)), 4000);
          const next = (elements || api.getSceneElementsIncludingDeleted()).map((el) => (el.type === 'image' && el.fileId === id && !el.isDeleted
            ? { ...el, isDeleted: true, version: (el.version || 0) + 1, versionNonce: Math.floor(Math.random() * 0x7fffffff), updated: Date.now() }
            : el));
          api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
          scheduleSave();
        });
    }
  }, [api, scheduleSave]);

  // Did this change come only from the live session (the others' strokes put
  // on this engine)? Then the person who drew it saves it, not us. A change
  // with no element moved (a pan, a zoom) is this person's own.
  const onlyRemote = useCallback((elements) => {
    const isRemote = collabRef.current?.isRemoteElement;
    const next = new Map();
    let changed = false, local = false;
    for (const e of elements || []) {
      if (!e?.id) continue;
      const k = elKey(e);
      next.set(e.id, k);
      if (seenEls.current.get(e.id) === k) continue;
      changed = true;
      const outside = fromScene.current.get(e.id) === k || (isRemote && isRemote(e));
      if (!outside) local = true;
    }
    seenEls.current = next;
    return changed && !local;
  }, []);

  const onChange = useCallback((elements, appState, files) => {
    storeNewFiles(files, elements);
    // Into the shared document first (the others see it as it is drawn),
    // then the save timer.
    collabRef.current?.onChange?.(elements, filesMeta.current, appState?.selectedElementIds);
    if (onlyRemote(elements)) return;
    scheduleSave();
  }, [storeNewFiles, scheduleSave, onlyRemote]);
  // Where the pointer is, for the others' cursors (the session throttles it).
  const onPointerUpdate = useCallback((payload) => { collabRef.current?.pointer?.(payload); }, []);

  const setLook = useCallback((next) => {
    if (!LOOKS.includes(next) || next === lookRef.current) return;
    lookRef.current = next;
    onLook?.(next);
    if (api) {
      api.updateScene({
        // Text re-measures in its new face (refreshDimensions).
        elements: restoreElements(applyLook(api.getSceneElementsIncludingDeleted(), next), null, { refreshDimensions: true }),
        appState: lookDefaults(next),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      scheduleSave();
    }
  }, [api, onLook, scheduleSave]);

  const fit = useCallback(() => { api?.scrollToContent(undefined, { fitToContent: true, animate: true }); }, [api]);
  const toast = useCallback((message) => { try { api?.setToast({ message, duration: 2000 }); } catch { /* engine not ready */ } }, [api]);
  const doExportPng = useCallback(async () => { if (!api) return; downloadBlob(await exportPng(api), exportFileName(note, 'png')); }, [api, note]);
  const doExportSvg = useCallback(async () => { if (!api) return; downloadBlob(new Blob([await exportSvg(api)], { type: 'image/svg+xml' }), exportFileName(note, 'svg')); }, [api, note]);
  const doCopy = useCallback(async () => { if (!api) return; try { await copyPng(api); toast('Copied as a picture'); } catch { toast('Could not copy - try Export as PNG'); } }, [api, toast]);
  const doDownload = useCallback(() => { downloadScene({ ...note, filesMeta: filesMeta.current }, api, lookRef.current); }, [api, note]);
  const setBackground = useCallback((color) => {
    if (!api || !propsRef.current.canEdit) return;
    api.updateScene({ appState: { viewBackgroundColor: color }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
  }, [api, scheduleSave]);
  // Clear Board asks first; every shape is marked deleted (a new version
  // each) rather than the engine's reset, so the live session carries the
  // clearing to the others and Undo brings it back.
  const doClear = useCallback(async () => {
    if (!api || !propsRef.current.canEdit) return;
    const ok = await dialog.confirm('Clear everything on this board?', { title: 'Clear Board', confirmText: 'Clear', danger: true });
    if (!ok) return;
    const now = Date.now();
    const next = api.getSceneElementsIncludingDeleted().map((e) => (e.isDeleted ? e
      : { ...e, isDeleted: true, version: (e.version || 0) + 1, versionNonce: Math.floor(Math.random() * 0x7fffffff), updated: now }));
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
  }, [api, scheduleSave]);

  const uiOptions = useMemo(() => ({
    canvasActions: {
      changeViewBackgroundColor: canEdit,
      clearCanvas: canEdit,
      export: false,            // our menu exports; never the engine's dialog (it links to its own service)
      loadScene: false,
      saveToActiveFile: false,
      saveAsImage: false,
      toggleTheme: false,       // follows the app's theme
    },
    tools: { image: canEdit },
  }), [canEdit]);

  const lookToggle = (
    <div className="nx-board-look" role="group" aria-label="Look">
      {LOOKS.map((k) => (
        <button key={k} type="button" aria-pressed={look === k} onClick={() => setLook(k)}>{LOOK_LABEL[k]}</button>
      ))}
    </div>
  );

  return (
    <div className={`nx-board${isPhone ? ' is-phone' : ''}${canEdit ? '' : ' is-view'}`} data-look={look}
      style={kbInset ? { '--nx-kb-inset': `${kbInset}px` } : undefined} data-testid="nx-board">
      <div className="nx-board-stage">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initialData}
          onChange={onChange}
          viewModeEnabled={!canEdit}
          theme={theme}
          langCode="en-US"
          name={note?.title || 'Untitled Board'}
          UIOptions={uiOptions}
          aiEnabled={false}
          validateEmbeddable={false}
          detectScroll={false}
          handleKeyboardGlobally={false}
          autoFocus={canEdit && !isPhone}
          isCollaborating={!!collab}
          onPointerUpdate={collab ? onPointerUpdate : undefined}
          renderTopRightUI={isPhone || !canEdit ? undefined : () => lookToggle}
        >
          <MainMenu>
            {/* A viewer sees no Look rows and no editing items - hidden, not disabled. */}
            {canEdit && <MainMenu.ItemCustom><div className="nx-board-menu-kicker">Look</div></MainMenu.ItemCustom>}
            {canEdit && <MainMenu.ItemCustom>{lookToggle}</MainMenu.ItemCustom>}
            {canEdit && <MainMenu.Separator />}
            <MainMenu.Item icon={<Maximize2 size={14} />} onSelect={fit}>Fit to Screen</MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item icon={<ImageIcon size={14} />} onSelect={doExportPng}>Export as PNG</MainMenu.Item>
            <MainMenu.Item icon={<Download size={14} />} onSelect={doExportSvg}>Export as SVG</MainMenu.Item>
            <MainMenu.Item icon={<Copy size={14} />} onSelect={doCopy}>Copy as Picture</MainMenu.Item>
            <MainMenu.Item icon={<FileJson size={14} />} onSelect={doDownload}>Download Board File</MainMenu.Item>
            {canEdit && <MainMenu.Separator />}
            {canEdit && (
              <MainMenu.ItemCustom>
                <div className="nx-board-menu-kicker">Canvas Background</div>
                <div className="nx-board-swatches" role="group" aria-label="Canvas Background">
                  {CANVAS_COLORS.map((c) => (
                    <button key={c.color} type="button" className="nx-board-swatch" style={{ background: c.color }}
                      aria-label={c.label} title={c.label} onClick={() => setBackground(c.color)} />
                  ))}
                </div>
              </MainMenu.ItemCustom>
            )}
            {canEdit && <MainMenu.Item icon={<Eraser size={14} />} onSelect={doClear}>Clear Board</MainMenu.Item>}
          </MainMenu>
        </Excalidraw>
        {notice && <div className={`nx-board-note${notice.error ? ' is-error' : ''}`} role="status">{notice.text}</div>}
      </div>
    </div>
  );
}
