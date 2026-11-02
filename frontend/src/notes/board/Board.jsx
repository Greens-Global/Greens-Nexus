// A Board - the Notes whiteboard (Neil, 11/02/2026). The drawing engine
// (behind the adapter in ./engine - this file never imports the package)
// wrapped as a Nexus screen: our looks (Clean / Sketch), our menu (Fit,
// Export as PNG / SVG, Copy as Picture, Download Board File, Canvas
// Background, Clear Board), our images (the private bucket through
// files.js), our theme, and nothing of the engine's own hosted features. The
// caller (NotesPage) owns saving: Board hands it a serialized scene 800 ms
// after the last change and a PNG thumbnail 3 s after, and never talks to
// the API itself except to store an image.
//
// Robustness (Neil, 11/02/2026):
//   - The engine is fetched by loadEngine() when the board mounts (the
//     engine's own lazy chunk). While it loads the stage shows a skeleton;
//     when it does not load (a deploy swapped the files, the CSP, offline)
//     or throws while drawing, the board shows its last saved picture
//     read-only with Retry (engine/fallback.jsx) - never blank, never a
//     throw to the page's error boundary.
//   - Every save goes to a local draft first (draft.js, IndexedDB, with
//     the rev it was drawn over); the save coming back clears it. A draft
//     left behind - the tab closed inside the save delay, offline, a crash -
//     is offered on the next open: Restore puts it on the canvas (merged,
//     repaired) and saves it; Discard forgets it.
//   - Before a save the scene is compacted (scene.js compact: deleted
//     elements more than a day old and files nothing points at go); a
//     scene still over the cap is refused here with a notice, never sent
//     as a 413.
//
// Lazy: NotesPage imports this file with React.lazy; the engine's chunk is
// fetched only when a board opens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Copy, FileJson, Maximize2, Eraser } from 'lucide-react';
import './board.css';
import { loadEngine, CAPTURE } from './engine';
import BoardFallback, { EngineBoundary, BoardLoading } from './engine/fallback';
import { parseScene, applyLook, lookDefaults, emptyScene, compact, sameScene, LOOKS, SCENE_MAX } from './scene';
import { uploadBoardFile, loadBoardFiles } from './files';
import { remoteWins } from './boardSync';
import { exportPng, exportSvg, exportThumb, copyPng, downloadBlob, downloadScene } from './exportBoard';
import { saveDraft, loadDraft, clearDraft } from './draft';
import { dataUrlToFile } from '../../tasks/lib';
import { exportFileName } from '../notesModel';
import { dialog } from '../../ui/dialog';
import { useKeyboardInset } from '../../lib/useVisualViewport';
import { formatDateTime } from '../../lib/datetime';

const SAVE_MS = 800;
const THUMB_MS = 3000;
const LOOK_LABEL = { clean: 'Clean', sketch: 'Sketch' };
const TOO_LARGE = 'This board is too large to save - move some of it to a new board.';
// Canvas Background: the engine's own picker row is sentence case and has no
// api to open it from our menu, so the menu offers these (the engine's own
// light swatches; dark mode inverts them like every engine color).
const CANVAS_COLORS = [
  { color: '#ffffff', label: 'White' }, { color: '#f8f9fa', label: 'Light Gray' }, { color: '#f5faff', label: 'Light Blue' },
  { color: '#fffce8', label: 'Light Yellow' }, { color: '#fdf8f6', label: 'Light Rose' },
];

const elKey = (e) => `${e?.version || 0}:${e?.versionNonce ?? 0}`;
const nonce = () => Math.floor(Math.random() * 0x7fffffff);

function readTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
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

/** The engine through the adapter: null while it loads, an error when it did not. Retry loads again. */
function useEngine() {
  const [engine, setEngine] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    loadEngine()
      .then((eng) => { if (alive) { setEngine(eng); setError(null); } })
      .catch((err) => { if (alive) { setEngine(null); setError(err || new Error('The drawing tools did not load')); } });
    return () => { alive = false; };
  }, [attempt]);
  const retry = useCallback(() => { setEngine(null); setError(null); setAttempt((n) => n + 1); }, []);
  return { engine, error, attempt, retry };
}

export default function Board({ note, isPhone = false, look: lookProp, onLook, onScene, onThumb, collab = null, onApi }) {
  const canEdit = !!note?.canEdit;
  const theme = useAppTheme();
  const kbInset = useKeyboardInset(isPhone);
  const { engine, error: engineError, attempt, retry } = useEngine();
  const engineRef = useRef(engine);
  useEffect(() => { engineRef.current = engine; }, [engine]);
  // The scene as it was handed to us - parsed once per note; the engine owns
  // it from there. A broken scene opens empty rather than crashing the page
  // (the caller already refuses to save over it: see NotesPage).
  const initial = useMemo(() => parseScene(note?.scene) || emptyScene('clean'), [note?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const look = LOOKS.includes(lookProp) ? lookProp : initial.look;
  const [api, setApi] = useState(null);
  const [notice, setNotice] = useState(null);     // { text, error, code }
  const [draftOffer, setDraftOffer] = useState(null);   // { scene, rev, at } from draft.js
  const stageRef = useRef(null);
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
  const propsRef = useRef({ onScene, onThumb, canEdit, noteId: note?.id, rev: note?.rev });
  // The live session (useBoardCollab), read through a ref so the engine's
  // callbacks stay stable while the session connects, restarts or ends.
  const collabRef = useRef(collab);
  useEffect(() => { lookRef.current = look; propsRef.current = { onScene, onThumb, canEdit, noteId: note?.id, rev: note?.rev }; collabRef.current = collab; });

  // Elements from outside this engine go through its repair (the adapter's
  // restore): sizes kept - the sender measured them.
  const restoreRemote = useCallback((elements) => {
    const eng = engineRef.current;
    return eng ? eng.restore(elements || [], { refreshDimensions: false }) : (elements || []);
  }, []);

  // The engine was re-mounted (Retry): the old handle is gone.
  useEffect(() => { setApi(null); }, [attempt]);

  // Hand the handle up once, load the images.
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
  }, [api, collab, onRemoteFiles, restoreRemote]);

  // The saved scene moved on under this board (a new rev this Board did not
  // just send: a save merged with someone else's shapes after a 409 or a
  // draft merge, or - for a viewer, who has no live session - anyone's
  // save). The newer drawing goes on the engine without a history entry:
  // a viewer takes it as is; an editor reconciles it with what is on the
  // canvas (newest version of each element wins) and does not save it back
  // - the elements that came this way are remembered so the engine's echo
  // schedules nothing. Our own save coming back marks the draft done - told
  // by the drawing, not the string (the server re-dumps the JSON with
  // non-ASCII escaped, so an emoji in a label would make our own save look
  // like someone else's).
  const seenScene = useRef(note?.scene);
  const fromScene = useRef(new Map());
  useEffect(() => {
    if (!api || note?.scene === seenScene.current) return;
    seenScene.current = note?.scene;
    if (canEdit && sameScene(note?.scene || '', lastSent.current)) {
      clearDraft(propsRef.current.noteId);
      return;
    }
    const next = parseScene(note?.scene);
    if (!next) return;
    const incoming = restoreRemote(next.elements);
    if (canEdit) {
      const current = api.getSceneElementsIncludingDeleted();
      const mine = new Map((current || []).map((e) => [e?.id, e]));
      const winners = incoming.filter((e) => e?.id && remoteWins(mine.get(e.id), e));
      if (winners.length) {
        for (const e of winners) fromScene.current.set(e.id, elKey(e));
        api.updateScene({ elements: engineRef.current.reconcile(current, winners), captureUpdate: CAPTURE.NEVER });
      }
    } else {
      api.updateScene({ elements: incoming, captureUpdate: CAPTURE.NEVER });
    }
    onRemoteFiles(next.files);
  }, [note?.scene, api, canEdit, onRemoteFiles, restoreRemote]);

  // A draft left behind by the last visit (draft.js): offered once the
  // engine is up, to an editor, whenever it is not the board as saved -
  // its rev does not matter (11/02/2026: a draft drawn over an older rev
  // was dropped, and the strokes in it were lost when a collaborator had
  // saved in between; Restore reconciles newest-wins, so an old draft can
  // never undo a newer save). One equal to the board is already saved.
  useEffect(() => {
    if (!api || !canEdit || !note?.id) return undefined;
    let alive = true;
    const noteId = note.id;
    loadDraft(noteId).then((d) => {
      if (!alive || !d) return;
      if (sameScene(d.scene, note.scene || '')) { clearDraft(noteId); return; }
      setDraftOffer(d);
    }).catch(() => { /* no draft */ });
    return () => { alive = false; };
  }, [api, canEdit, note?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const serialize = useCallback(() => {
    const eng = engineRef.current;
    if (!api || !eng) return '';
    // An image still on its way to the bucket stays out of the saved scene
    // until its file meta exists: a board closed mid-upload never keeps a
    // picture that can not load.
    const els = api.getSceneElementsIncludingDeleted()
      .filter((e) => !(e?.type === 'image' && e.fileId && !filesMeta.current[e.fileId] && uploading.current.has(e.fileId)));
    const scene = compact(eng.toScene({ elements: els, appState: api.getAppState(), files: filesMeta.current, look: lookRef.current }));
    return JSON.stringify(scene);
  }, [api]);

  // Hand the scene to the caller - only when it is not what was sent last,
  // never over the cap (the notice says so until a save fits), and into the
  // local draft first.
  const sendScene = useCallback(() => {
    savePending.current = false;
    const s = serialize();
    if (!s || s === lastSent.current) return;
    if (s.length > SCENE_MAX) {
      setNotice({ text: TOO_LARGE, error: true, code: 'large' });
      return;
    }
    setNotice((n) => (n?.code === 'large' ? null : n));
    lastSent.current = s;
    saveDraft(propsRef.current.noteId, s, { rev: propsRef.current.rev });
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

  // The draft's answer. Restore: its elements, repaired, merged into what is
  // on the canvas (a stroke drawn meanwhile stays), its pictures through the
  // viewer, then the save that makes it the board's. Discard: forgotten.
  const restoreDraft = useCallback(() => {
    const d = draftOffer;
    setDraftOffer(null);
    const eng = engineRef.current;
    if (!d || !api || !eng) return;
    const scene = parseScene(d.scene);
    if (!scene) { clearDraft(propsRef.current.noteId); return; }
    api.updateScene({ elements: eng.reconcile(api.getSceneElementsIncludingDeleted(), scene.elements), captureUpdate: CAPTURE.IMMEDIATELY });
    onRemoteFiles(scene.files);
    scheduleSave();
  }, [draftOffer, api, onRemoteFiles, scheduleSave]);
  const discardDraft = useCallback(() => {
    setDraftOffer(null);
    clearDraft(propsRef.current.noteId);
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
      const done = () => { uploading.current.delete(id); if (!uploading.current.size) setNotice((n) => (n?.code === 'large' ? n : null)); };
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
          setTimeout(() => setNotice((n) => (n?.error && n.code !== 'large' ? null : n)), 4000);
          const next = (elements || api.getSceneElementsIncludingDeleted()).map((el) => (el.type === 'image' && el.fileId === id && !el.isDeleted
            ? { ...el, isDeleted: true, version: (el.version || 0) + 1, versionNonce: nonce(), updated: Date.now() }
            : el));
          api.updateScene({ elements: next, captureUpdate: CAPTURE.NEVER });
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

  // The engine's live state after a change (the adapter's Canvas onChange).
  const onChange = useCallback(({ elements, appState, files }) => {
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
    const eng = engineRef.current;
    if (api && eng) {
      api.updateScene({
        // Text re-measures in its new face (refreshDimensions).
        elements: eng.restore(applyLook(api.getSceneElementsIncludingDeleted(), next), { refreshDimensions: true }),
        appState: lookDefaults(next),
        captureUpdate: CAPTURE.IMMEDIATELY,
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
    api.updateScene({ appState: { viewBackgroundColor: color }, captureUpdate: CAPTURE.IMMEDIATELY });
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
      : { ...e, isDeleted: true, version: (e.version || 0) + 1, versionNonce: nonce(), updated: now }));
    api.updateScene({ elements: next, captureUpdate: CAPTURE.IMMEDIATELY });
    scheduleSave();
  }, [api, scheduleSave]);

  const lookToggle = (
    <div className="nx-board-look" role="group" aria-label="Look">
      {LOOKS.map((k) => (
        <button key={k} type="button" aria-pressed={look === k} onClick={() => setLook(k)}>{LOOK_LABEL[k]}</button>
      ))}
    </div>
  );

  const Menu = engine?.Menu;
  const menu = Menu ? (
    <Menu.Root>
      {/* A viewer sees no Look rows and no editing items - hidden, not disabled. */}
      {canEdit && <Menu.Custom><div className="nx-board-menu-kicker">Look</div></Menu.Custom>}
      {canEdit && <Menu.Custom>{lookToggle}</Menu.Custom>}
      {canEdit && <Menu.Separator />}
      <Menu.Item icon={<Maximize2 size={14} />} onSelect={fit}>Fit to Screen</Menu.Item>
      <Menu.Separator />
      <Menu.Item icon={<ImageIcon size={14} />} onSelect={doExportPng}>Export as PNG</Menu.Item>
      <Menu.Item icon={<Download size={14} />} onSelect={doExportSvg}>Export as SVG</Menu.Item>
      <Menu.Item icon={<Copy size={14} />} onSelect={doCopy}>Copy as Picture</Menu.Item>
      <Menu.Item icon={<FileJson size={14} />} onSelect={doDownload}>Download Board File</Menu.Item>
      {canEdit && <Menu.Separator />}
      {canEdit && (
        <Menu.Custom>
          <div className="nx-board-menu-kicker">Canvas Background</div>
          <div className="nx-board-swatches" role="group" aria-label="Canvas Background">
            {CANVAS_COLORS.map((c) => (
              <button key={c.color} type="button" className="nx-board-swatch" style={{ background: c.color }}
                aria-label={c.label} title={c.label} onClick={() => setBackground(c.color)} />
            ))}
          </div>
        </Menu.Custom>
      )}
      {canEdit && <Menu.Item icon={<Eraser size={14} />} onSelect={doClear}>Clear Board</Menu.Item>}
    </Menu.Root>
  ) : null;

  return (
    <div className={`nx-board${isPhone ? ' is-phone' : ''}${canEdit ? '' : ' is-view'}`} data-look={look}
      style={kbInset ? { '--nx-kb-inset': `${kbInset}px` } : undefined} data-testid="nx-board">
      {draftOffer && canEdit && (
        <div className="nx-board-draft" role="status" aria-label="Unsaved drawing">
          <span className="nx-board-draft-text">You have unsaved drawing from {formatDateTime(draftOffer.at)} - put it back?</span>
          <button type="button" className="is-primary" onClick={restoreDraft}>Restore</button>
          <button type="button" onClick={discardDraft}>Discard</button>
        </div>
      )}
      <div className="nx-board-stage" ref={stageRef}>
        {engineError
          ? <BoardFallback note={note} onRetry={retry} />
          : !engine
            ? <BoardLoading />
            : (
              <EngineBoundary key={attempt} note={note} onRetry={retry}>
                <engine.Canvas
                  scene={initial}
                  onChange={onChange}
                  onReady={setApi}
                  look={look}
                  readOnly={!canEdit}
                  theme={theme}
                  name={note?.title || 'Untitled Board'}
                  phone={isPhone}
                  collaborating={!!collab}
                  onPointerUpdate={collab ? onPointerUpdate : undefined}
                  topRight={isPhone || !canEdit ? null : lookToggle}
                  menu={menu}
                />
              </EngineBoundary>
            )}
        {notice && <div className={`nx-board-note${notice.error ? ' is-error' : ''}`} role="status">{notice.text}</div>}
      </div>
    </div>
  );
}
