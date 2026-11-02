// A Board - the Notes whiteboard (Neil, 11/02/2026). The Excalidraw engine
// (MIT, self-hosted) wrapped as a Nexus screen: our looks (Clean / Sketch),
// our menu (Fit, Export PNG / SVG / Copy / Download File), our images (the
// private bucket through files.js), our theme, and nothing of the engine's
// own hosted features. The caller (NotesPage) owns saving: Board hands it a
// serialized scene 800 ms after the last change and a PNG thumbnail 3 s
// after, and never talks to the API itself except to store an image.
//
// Lazy: NotesPage imports this file with React.lazy, so the engine's chunk
// (vendor-excalidraw) is fetched only when a board opens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, MainMenu, THEME, CaptureUpdateAction } from '@excalidraw/excalidraw';
import { Download, Image as ImageIcon, Copy, FileJson, Maximize2, Paperclip } from 'lucide-react';
import '@excalidraw/excalidraw/index.css';
import './board.css';
import { parseScene, serializeScene, applyLook, lookDefaults, emptyScene, LOOKS } from './scene';
import { uploadBoardFile, loadBoardFiles } from './files';
import { exportPng, exportSvg, exportThumb, copyPng, downloadBlob, downloadScene } from './exportBoard';
import { dataUrlToFile, storeTaskFile } from '../../tasks/lib';
import { api as nexusApi } from '../../api';
import { useKeyboardInset } from '../../lib/useVisualViewport';

// The engine fetches its fonts from here (copied from the package by
// scripts/copy-excalidraw-assets.mjs). Set before the first render so the
// first text element already measures with the right face.
export const ASSET_PATH = '/excalidraw-assets/';
if (typeof window !== 'undefined' && !window.EXCALIDRAW_ASSET_PATH) window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;

const SAVE_MS = 800;
const THUMB_MS = 3000;
const LOOK_LABEL = { clean: 'Clean', sketch: 'Sketch' };

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
    collab.attach(api, { onRemoteFiles });
  }, [api, collab, onRemoteFiles]);

  // A viewer has no live session (the channel key is the editors' alone):
  // when the saved scene moves on under it, the new drawing goes on the
  // engine as-is, never into a history it cannot use anyway.
  const seenScene = useRef(note?.scene);
  useEffect(() => {
    if (canEdit || !api || note?.scene === seenScene.current) return;
    seenScene.current = note?.scene;
    const next = parseScene(note?.scene);
    if (!next) return;
    api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.NEVER });
    onRemoteFiles(next.files);
  }, [note?.scene, api, canEdit, onRemoteFiles]);

  const serialize = useCallback(() => {
    if (!api) return '';
    return serializeScene({
      elements: api.getSceneElementsIncludingDeleted(),
      appState: api.getAppState(),
      filesMeta: filesMeta.current,
      look: lookRef.current,
    });
  }, [api]);

  const scheduleSave = useCallback(() => {
    if (!propsRef.current.canEdit) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { const s = serialize(); if (s) propsRef.current.onScene?.(s); }, SAVE_MS);
    if (propsRef.current.onThumb) {
      clearTimeout(thumbTimer.current);
      thumbTimer.current = setTimeout(async () => {
        try { const blob = await exportThumb(api); if (blob) propsRef.current.onThumb?.(blob); } catch { /* a thumbnail is a nicety */ }
      }, THUMB_MS);
    }
  }, [api, serialize]);
  useEffect(() => () => { clearTimeout(saveTimer.current); clearTimeout(thumbTimer.current); }, []);

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
          filesMeta.current[meta.id] = meta;
          if (meta.id !== id) filesMeta.current[id] = { ...meta, id };
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

  const onChange = useCallback((elements, appState, files) => {
    storeNewFiles(files, elements);
    // Into the shared document first (the others see it as it is drawn),
    // then the save timer.
    collabRef.current?.onChange?.(elements, filesMeta.current, appState?.selectedElementIds);
    scheduleSave();
  }, [storeNewFiles, scheduleSave]);
  // Where the pointer is, for the others' cursors (the session throttles it).
  const onPointerUpdate = useCallback((payload) => { collabRef.current?.pointer?.(payload); }, []);

  const setLook = useCallback((next) => {
    if (!LOOKS.includes(next) || next === lookRef.current) return;
    lookRef.current = next;
    onLook?.(next);
    if (api) {
      api.updateScene({
        elements: applyLook(api.getSceneElementsIncludingDeleted(), next),
        appState: lookDefaults(next),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      scheduleSave();
    }
  }, [api, onLook, scheduleSave]);

  const fit = useCallback(() => { api?.scrollToContent(undefined, { fitToContent: true, animate: true }); }, [api]);
  const toast = useCallback((message) => { try { api?.setToast({ message, duration: 2000 }); } catch { /* engine not ready */ } }, [api]);
  const doExportPng = useCallback(async () => { if (!api) return; downloadBlob(await exportPng(api), `${note?.title || 'Untitled Board'}.png`); }, [api, note?.title]);
  const doExportSvg = useCallback(async () => { if (!api) return; downloadBlob(new Blob([await exportSvg(api)], { type: 'image/svg+xml' }), `${note?.title || 'Untitled Board'}.svg`); }, [api, note?.title]);
  const doCopy = useCallback(async () => { if (!api) return; try { await copyPng(api); toast('Copied as an image'); } catch { toast('Could not copy - try Export PNG'); } }, [api, toast]);
  const doDownload = useCallback(() => { downloadScene({ ...note, filesMeta: filesMeta.current }, api, lookRef.current); }, [api, note]);
  // Mark Up Anything (11/02/2026): a board made from a task's or a ticket's
  // picture goes back there as a PNG attachment - the ordinary attachment
  // path (api.attachMarkup), the picture stored like every board image.
  const attachable = ['task', 'ticket'].includes(note?.source?.kind);
  const doAttach = useCallback(async () => {
    const source = note?.source;
    if (!api || !source) return;
    try {
      const blob = await exportPng(api);
      const name = `${(note?.title || 'Mark Up').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      const url = await storeTaskFile(file, undefined, `notes/boards/${note?.id}`);
      if (!url) throw new Error('the picture could not be stored');
      await nexusApi.attachMarkup(source, { url, name, size: `${Math.max(1, Math.round(blob.size / 1024))} KB` });
      toast(`Attached to ${source.label}`);
    } catch (e) {
      toast(`Could not attach: ${e?.message || 'try again'}`);
    }
  }, [api, note, toast]);

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
        <button key={k} type="button" aria-pressed={look === k} onClick={() => setLook(k)} disabled={!canEdit}>{LOOK_LABEL[k]}</button>
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
            <MainMenu.ItemCustom><div className="nx-board-menu-kicker">Look</div></MainMenu.ItemCustom>
            <MainMenu.ItemCustom>{lookToggle}</MainMenu.ItemCustom>
            <MainMenu.Separator />
            <MainMenu.Item icon={<Maximize2 size={14} />} onSelect={fit}>Fit to Screen</MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item icon={<ImageIcon size={14} />} onSelect={doExportPng}>Export PNG</MainMenu.Item>
            <MainMenu.Item icon={<Download size={14} />} onSelect={doExportSvg}>Export SVG</MainMenu.Item>
            <MainMenu.Item icon={<Copy size={14} />} onSelect={doCopy}>Copy as Image</MainMenu.Item>
            <MainMenu.Item icon={<FileJson size={14} />} onSelect={doDownload}>Download Board File</MainMenu.Item>
            {attachable && <MainMenu.Separator />}
            {attachable && <MainMenu.Item icon={<Paperclip size={14} />} onSelect={doAttach}>{`Attach to ${note.source.label}`}</MainMenu.Item>}
            {canEdit && <MainMenu.Separator />}
            {canEdit && <MainMenu.DefaultItems.ChangeCanvasBackground />}
            {canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          </MainMenu>
        </Excalidraw>
        {notice && <div className={`nx-board-note${notice.error ? ' is-error' : ''}`} role="status">{notice.text}</div>}
      </div>
    </div>
  );
}
