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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Download, Image as ImageIcon, Copy, FileJson, Maximize2, Eraser, X, Presentation, ChevronLeft, ChevronRight, ChevronUp, Plus, ListPlus, ArrowDownWideNarrow } from 'lucide-react';
import './board.css';
import { loadEngine, CAPTURE } from './engine';
import BoardFallback, { EngineBoundary, BoardLoading } from './engine/fallback';
import { parseScene, applyLook, lookDefaults, emptyScene, compact, sameScene, presentSlides, LOOKS, SCENE_MAX } from './scene';
import { uploadBoardFile, loadBoardFiles } from './files';
import { remoteWins } from './boardSync';
import { exportPng, exportSvg, exportThumb, copyPng, downloadBlob, downloadScene } from './exportBoard';
import { saveDraft, loadDraft, clearDraft } from './draft';
import MarkupBar from './MarkupBar';
import DiagramSheet from './diagram/DiagramSheet';
import { layout as layoutGraph, graphFromElements, bounds } from './diagram/graph';
import { newStamp, prefixGraph, stampBoxes, stampOf, stampSelection, mergeBuilt, placeOrigin } from './diagram/place';
import { loadGraph } from './diagram/sources';
import RecordCardSheet from './diagram/RecordCardSheet';
import { cardGraph, markCard, taskCards, refreshedCards } from './diagram/recordCards';
import { openRecord } from '../recordLink';
import { api as nexusApi } from '../../api';
import {
  DEFAULT_MARKUP, TOOL_KEYS, MARKUP_COLORS, isSizeKey, toolByKey, strokeStyle, toolFromEngine,
  commentPin, pinMeasurer, nextCommentNumber, stageToBoard, restyle, removeSelected, PLACE_TOOLS, colorByKey,
} from './markupTools';
import { sticky, withStickyText, nextSpot, stickyParts, selectedStickies, stickyWords, sortStickies, linkStickies, taskStickies, refreshedStickyFeet, votable, STICKY_SIZE } from './stickies';
import { MEET, readMeet, startTimer, pauseTimer, resumeTimer, addMinute, stopTimer, startVote, myVotes, toggleVote, tally, castCount, clearVotes, stampVotes, startSilent, endSilent } from './meet';
import { pinParts, selectedPin, threadOf, withThread, newThread, withReply, withResolved } from './threads';
import { recognizeInk, shapeFromInk } from './inkShape';
import { parseLength, scaleAt, dimension, area as areaShape, refreshMeasures } from './measure';
import { createViewStore } from './viewStore';
import BoardOverlay from './BoardOverlay';
import MeetBar from './MeetBar';
import SiteKitSheet, { kitPng, kitImage } from './siteKit';
import { importable, isPdfFile, importElements, blobToDataURL, placedWords } from './boardImport';
import { imageSize } from '../../lib/markup';
import { dataUrlToFile } from '../../tasks/lib';
import { exportFileName } from '../notesModel';
import { dialog } from '../../ui/dialog';
import { useKeyboardInset } from '../../lib/useVisualViewport';
import { formatDateTime } from '../../lib/datetime';

// Stickies to Tasks loads the Tasks store - only when someone asks for it.
const StickyTasks = lazy(() => import('./StickyTasks'));

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

// The markup bar's last ink, width and highlighter ink, per browser (a
// convenience - never board data; the tool itself always starts at Select so
// a board opened on a phone pans before it draws).
const MARKUP_PREF = 'nx-board-markup';
function readMarkupPref() {
  const base = { ...DEFAULT_MARKUP, tool: 'select' };
  try {
    const p = JSON.parse(localStorage.getItem(MARKUP_PREF) || '{}');
    const okColor = (k) => MARKUP_COLORS.some((c) => c.key === k);
    return {
      ...base,
      color: okColor(p.color) ? p.color : base.color,
      highlightColor: okColor(p.highlightColor) ? p.highlightColor : base.highlightColor,
      size: isSizeKey(p.size) ? p.size : base.size,
      inkShape: p.inkShape === true,
      snap: p.snap !== false,   // Snap and Align: on unless the person turned it off
    };
  } catch { return base; }
}
function writeMarkupPref(m) {
  try { localStorage.setItem(MARKUP_PREF, JSON.stringify({ color: m.color, highlightColor: m.highlightColor, size: m.size, inkShape: !!m.inkShape, snap: m.snap !== false })); } catch { /* private window */ }
}
// Tools the ink and width do not apply to (they draw nothing, or a picture).
const NO_INK = new Set(['select', 'hand', 'eraser', 'image', 'frame', 'laser', ...PLACE_TOOLS]);
// The ink dot picks a sticky's paper too: each ink has its paper.
const STICKY_FOR_INK = { ink: 'yellow', red: 'pink', amber: 'orange', yellow: 'yellow', green: 'green', blue: 'blue' };
// Private Writing keeps a person's stickies in this browser until the reveal (meet.js).
const trayKey = (noteId, me) => `nx-board-tray:${noteId}:${String(me || '').toLowerCase()}`;
function readTray(key) { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeTray(key, items) { try { if (items.length) localStorage.setItem(key, JSON.stringify(items)); else localStorage.removeItem(key); } catch { /* private window */ } }
const VIEW_MS = 150;
const SUMMON_FRESH_MS = 60_000;
const votableItems = (elements) => {
  const bound = new Set((elements || []).filter((e) => e && !e.isDeleted && e.type === 'text' && e.containerId).map((e) => e.containerId));
  return (elements || []).filter((e) => votable(e, bound.has(e?.id))).map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height }));
};
const anySelected = (ids) => !!ids && Object.keys(ids).some((k) => ids[k]);

// The + buttons on a selected box (board/diagram/): where the box sits on
// the stage, or null when there is no single box to grow from.
const GRIP_BOXES = new Set(['rectangle', 'diamond', 'ellipse']);
const SIDE_WORD = { up: 'Above', right: 'to the Right', down: 'Below', left: 'to the Left' };
function gripFor(elements, appState) {
  const sel = appState?.selectedElementIds || {};
  const ids = Object.keys(sel).filter((k) => sel[k]);
  if (ids.length !== 1 || appState?.activeTool?.type !== 'selection' || appState?.editingTextElement
    || appState?.selectedElementsAreBeingDragged || appState?.resizingElement || appState?.newElement) return null;
  const el = (elements || []).find((e) => e.id === ids[0]);
  if (!el || el.isDeleted || el.locked || !GRIP_BOXES.has(el.type) || el.customData?.nexusComment) return null;
  const zoom = Number(appState?.zoom?.value) || 1;
  return {
    x: Math.round((el.x + (Number(appState.scrollX) || 0)) * zoom), y: Math.round((el.y + (Number(appState.scrollY) || 0)) * zoom),
    w: Math.round(el.width * zoom), h: Math.round(el.height * zoom),
  };
}
const sameGrip = (a, b) => (!a && !b) || (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

// Hide Tools (Neil, 11/06/2026): a computer's bar and zoom can fold away, per browser.
const TOOLS_HIDDEN = 'nx-board-tools-hidden';
const readToolsHidden = () => { try { return localStorage.getItem(TOOLS_HIDDEN) === '1'; } catch { return false; } };


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

export default function Board({ note, isPhone = false, look: lookProp, onLook, onScene, onThumb, collab = null, onApi, presentSignal = 0, people = [], me = null, focusPin = '' }) {
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
  // The markup bar (MarkupBar.jsx): an editor's, whenever the engine offers
  // it, and the ONE tool bar - the engine's own strip is hidden (its other
  // tools are under More Tools). On a phone it is all the chrome: the
  // engine's properties panel opens above it from Style.
  const markupApi = canEdit ? engine?.markup : null;
  const [mk, setMk] = useState(readMarkupPref);
  const mkRef = useRef(mk);
  useEffect(() => { mkRef.current = mk; }, [mk]);
  const [hasSelection, setHasSelection] = useState(false);
  // Diagrams (board/diagram/): the sheet open, the + buttons' box, Refresh.
  const diagramApi = canEdit ? engine?.diagram : null;
  const [dgSheet, setDgSheet] = useState(null);
  const [kitOpen, setKitOpen] = useState(false);   // the Storage Site Kit sheet     // 'text' | 'org' | 'workflow' | 'tasks' | 'record'
  const [grip, setGrip] = useState(null);
  const gripRef = useRef(null);
  const [canRefresh, setCanRefresh] = useState(false);
  const canRefreshRef = useRef(false);
  const selRef = useRef(false);
  const [phoneMore, setPhoneMore] = useState(false);
  // Where the canvas is scrolled (the overlays read it) and the facilitation
  // kit's hooks into the engine's onChange (filled further down).
  const viewStore = useMemo(() => createViewStore(), []);
  const hookRef = useRef({});
  const [styleOpen, setStyleOpen] = useState(false);
  const styleRef = useRef(false);
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
    // The markup bar follows the engine: the tool it is really on (its own
    // strip, a shortcut, text dropping back to Select) and whether anything
    // is selected - state only when either moved.
    const sel = anySelected(appState?.selectedElementIds);
    if (sel !== selRef.current) { selRef.current = sel; setHasSelection(sel); }
    const style = appState?.openMenu === 'shape';
    if (style !== styleRef.current) { styleRef.current = style; setStyleOpen(style); }
    const t = toolFromEngine(appState?.activeTool?.type, mkRef.current.tool);
    if (t && t !== mkRef.current.tool) setMk((m) => ({ ...m, tool: t }));
    const snapOn = appState?.objectsSnapModeEnabled;
    if (typeof snapOn === 'boolean' && snapOn !== (mkRef.current.snap !== false)) {
      const m = { ...mkRef.current, snap: snapOn };
      mkRef.current = m; setMk(m); writeMarkupPref(m);
    }
    const g = gripFor(elements, appState);
    if (!sameGrip(g, gripRef.current)) { gripRef.current = g; setGrip(g); }
    const st = sel ? stampOf(elements, appState?.selectedElementIds) : null;
    if (!!st !== canRefreshRef.current) { canRefreshRef.current = !!st; setCanRefresh(!!st); }
    storeNewFiles(files, elements);
    viewStore.set(appState);
    hookRef.current.seen?.(elements, appState);
    // Into the shared document first (the others see it as it is drawn),
    // then the save timer.
    collabRef.current?.onChange?.(elements, filesMeta.current, appState?.selectedElementIds);
    if (onlyRemote(elements)) return;
    if (hookRef.current.local?.(elements, appState)) return;   // it changed the board again; that change saves
    scheduleSave();
  }, [storeNewFiles, scheduleSave, onlyRemote, viewStore]);
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

  // ---- Present ------------------------------------------------------------
  // The board full screen with the tools away and a pill to step the slides;
  // the canvas under it takes no pointer, so nothing is drawn by accident.
  const rootRef = useRef(null);
  const [present, setPresent] = useState(null);     // { slides, i, fs }
  const presentRef = useRef(null);     // the same, read by the key and full screen listeners
  const showSlide = useCallback((slide) => { api?.scrollToContent(slide || undefined, { fitToContent: true, animate: true }); }, [api]);
  const startPresent = useCallback(() => {
    if (!api || presentRef.current) return;
    const slides = presentSlides(api.getSceneElementsIncludingDeleted());
    let fs = false;
    const el = rootRef.current;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      fs = true;
      try { el.requestFullscreen().catch(() => {}); } catch { /* refused: present in the page */ }
    }
    const p = { slides, i: 0, fs };
    presentRef.current = p;
    setPresent(p);
    try { collabRef.current?.awareness?.setLocalStateField('presenting', true); } catch { /* no session */ }
    showSlide(slides[0]);
  }, [api, showSlide]);
  const stepSlide = useCallback((d) => {
    const p = presentRef.current;
    if (!p) return;
    const i = Math.max(0, Math.min(p.slides.length - 1, p.i + d));
    if (i === p.i) return;
    presentRef.current = { ...p, i };
    setPresent(presentRef.current);
    showSlide(p.slides[i]);
  }, [showSlide]);
  const stopPresent = useCallback(() => {
    const p = presentRef.current;
    if (!p) return;
    presentRef.current = null;
    setPresent(null);
    try { collabRef.current?.awareness?.setLocalStateField('presenting', false); } catch { /* no session */ }
    if (p.fs && document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch { /* already out */ } }
    fit();
  }, [fit]);
  // The caller's Present button bumps the signal; it is taken once the engine is up.
  const seenSignal = useRef(presentSignal);
  useEffect(() => {
    if (!api || !presentSignal || presentSignal === seenSignal.current) return;
    seenSignal.current = presentSignal;
    startPresent();
  }, [presentSignal, api, startPresent]);
  useEffect(() => {
    if (!present) return undefined;
    const key = (e) => {
      const k = e.key;
      if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') stepSlide(1);
      else if (k === 'ArrowLeft' || k === 'PageUp') stepSlide(-1);
      else if (k === 'Escape') stopPresent();
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    // Esc in browser full screen leaves it with no keydown: that ends the show too.
    const fsChange = () => { if (presentRef.current?.fs && !document.fullscreenElement) stopPresent(); };
    window.addEventListener('keydown', key, true);
    document.addEventListener('fullscreenchange', fsChange);
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('fullscreenchange', fsChange); };
  }, [present, stepSlide, stopPresent]);

  // ---- Hide Tools (a computer) ---------------------------------------------
  const [toolsHiddenPref, setToolsHiddenPref] = useState(readToolsHidden);
  const toolsHiddenHere = toolsHiddenPref && !isPhone;
  const hideTools = useCallback((v) => {
    setToolsHiddenPref(v);
    try { localStorage.setItem(TOOLS_HIDDEN, v ? '1' : '0'); } catch { /* private window */ }
  }, []);
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

  // ---- The markup bar ---------------------------------------------------
  // Snap and Align (Neil, 11/10/2026: "make things autosnap and align"): the
  // engine's object snapping - edges, centers and equal gaps line up with
  // guides as a shape moves or resizes; Ctrl / Cmd held skips it for one drag.
  // A per-person pref, set on the engine once it is ready and on every change.
  useEffect(() => {
    if (api && markupApi) markupApi.setStyle(api, { objectsSnapModeEnabled: mk.snap !== false });
  }, [api, markupApi, mk.snap]);
  const toggleSnap = useCallback(() => {
    const m = { ...mkRef.current, snap: mkRef.current.snap === false };
    mkRef.current = m; setMk(m); writeMarkupPref(m);
  }, []);
  const inkFor = (m, tool = m.tool) => (tool === 'highlight' ? m.highlightColor : m.color);
  const chooseTool = useCallback((key) => {
    if (!api || !markupApi || !TOOL_KEYS.includes(key)) return;
    const m = { ...mkRef.current, tool: key };
    mkRef.current = m;
    setMk(m);
    markupApi.setTool(api, toolByKey(key));
    if (!NO_INK.has(key)) markupApi.setStyle(api, strokeStyle(key, inkFor(m, key), m.size));
  }, [api, markupApi]);
  // An ink or a width: the next stroke's, and - with Select on and something
  // picked - the selection's too (one undo step, carried to the others).
  const restyleSelection = useCallback((opts) => {
    if (!api || mkRef.current.tool !== 'select' || !selRef.current) return;
    const ids = api.getAppState()?.selectedElementIds;
    const els = api.getSceneElementsIncludingDeleted();
    const next = restyle(els, ids, opts);
    if (next !== els) { api.updateScene({ elements: next, captureUpdate: CAPTURE.IMMEDIATELY }); scheduleSave(); }
  }, [api, scheduleSave]);
  const chooseColor = useCallback((key) => {
    const cur = mkRef.current;
    const m = cur.tool === 'highlight' ? { ...cur, highlightColor: key } : { ...cur, color: key };
    mkRef.current = m; setMk(m); writeMarkupPref(m);
    if (api && markupApi && !NO_INK.has(m.tool)) markupApi.setStyle(api, strokeStyle(m.tool, inkFor(m), m.size));
    restyleSelection({ colorKey: key });
  }, [api, markupApi, restyleSelection]);
  const chooseSize = useCallback((key) => {
    const m = { ...mkRef.current, size: key };
    mkRef.current = m; setMk(m); writeMarkupPref(m);
    if (api && markupApi && !NO_INK.has(m.tool)) markupApi.setStyle(api, strokeStyle(m.tool, inkFor(m), m.size));
    restyleSelection({ sizeKey: key });
  }, [api, markupApi, restyleSelection]);
  const undo = useCallback(() => { markupApi?.undo(stageRef.current); }, [markupApi]);
  const toggleStyle = useCallback(() => { if (api) markupApi?.toggleStyle?.(api); }, [api, markupApi]);
  const redo = useCallback(() => { markupApi?.redo(stageRef.current); }, [markupApi]);
  const deleteSelected = useCallback(() => {
    if (!api) return;
    const els = api.getSceneElementsIncludingDeleted();
    const next = removeSelected(els, api.getAppState()?.selectedElementIds);
    if (next === els) return;
    api.updateScene({ elements: next, appState: { selectedElementIds: {} }, captureUpdate: CAPTURE.IMMEDIATELY });
    selRef.current = false; setHasSelection(false);
    scheduleSave();
  }, [api, scheduleSave]);
  // ---- Diagrams ------------------------------------------------------------
  // One diagram notice at a time; never over the board's too-large warning.
  const flashTimer = useRef(0);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = useCallback((text, error = false) => {
    clearTimeout(flashTimer.current);
    setNotice((n) => (n?.code === 'large' ? n : { text, error, code: 'diagram' }));
    flashTimer.current = setTimeout(() => setNotice((n) => (n?.code === 'diagram' ? null : n)), error ? 5000 : 3500);
  }, []);
  // A new diagram lands centered on what the stage shows, selected.
  const placeGraph = useCallback((graph, { dir = 'TB', source = '', ref = '', group = '' } = {}) => {
    if (!api || !diagramApi || !graph?.nodes?.length) return;
    const stamp = newStamp();
    const g = prefixGraph(graph, stamp);
    const r = stageRef.current?.getBoundingClientRect?.();
    const center = stageToBoard({ clientX: (r?.left || 0) + (r?.width || 0) / 2, clientY: (r?.top || 0) + (r?.height || 0) / 2 }, r, api.getAppState());
    const current = api.getSceneElementsIncludingDeleted();
    const placed = layoutGraph(g, { dir, origin: placeOrigin(center, bounds(layoutGraph(g, { dir })), current) });
    let built = diagramApi.build(placed, { look: lookRef.current });
    if (source) built = stampBoxes(built, g.nodes.map((n) => n.id), { id: stamp, source, ref, dir, ...(group ? { group } : {}) });
    const selected = Object.fromEntries(g.nodes.map((n) => [n.id, true]));
    api.updateScene({ elements: [...current, ...built], appState: { selectedElementIds: selected }, captureUpdate: CAPTURE.IMMEDIATELY });
    api.scrollToContent(built, { fitToContent: g.nodes.length > 1, animate: true });
    scheduleSave();
  }, [api, diagramApi, scheduleSave]);
  // Tidy Up: the selected boxes (or the whole board) laid out again, sizes,
  // colors and labels kept, as one change.
  const tidy = useCallback((dir) => {
    if (!api || !diagramApi) return;
    const els = api.getSceneElementsIncludingDeleted();
    const { graph, replaced, origin } = graphFromElements(els, api.getAppState()?.selectedElementIds);
    if (graph.nodes.length < 2) { flash('Nothing to tidy - select boxes joined by arrows, or nothing to tidy every diagram on the board.'); return; }
    const built = diagramApi.build(layoutGraph(graph, { dir, origin }), { look: lookRef.current });
    api.updateScene({ elements: mergeBuilt(els, built, replaced), captureUpdate: CAPTURE.IMMEDIATELY });
    scheduleSave();
  }, [api, diagramApi, flash, scheduleSave]);
  // Refresh from Source: a data diagram drawn again from today's data, where it is.
  const refreshDiagram = useCallback(async () => {
    if (!api || !diagramApi) return;
    const st = stampOf(api.getSceneElementsIncludingDeleted(), api.getAppState()?.selectedElementIds);
    if (!st) return;
    let graph;
    try { graph = await loadGraph(st.source, st.ref, { fresh: true, group: st.group || '' }); } catch { flash('The data did not load - the diagram is unchanged. Try again in a moment.', true); return; }
    if (!graph?.nodes?.length) { flash('There is nothing to draw from this source now - the diagram is unchanged.'); return; }
    const now = api.getSceneElementsIncludingDeleted();
    const mine = stampSelection(now, st.id);
    // Gone while the data loaded (deleted here or by someone else): nothing to
    // redraw - and an empty selection would read as the whole board.
    if (!Object.keys(mine).length) return;
    const { graph: was, replaced, origin } = graphFromElements(now, mine);
    // A group renamed on the board keeps the name it was given there.
    const named = new Map(was.groups.filter((x) => x.named).map((x) => [x.id, x.label]));
    const fresh = prefixGraph(graph, st.id);
    const g = { ...fresh, groups: (fresh.groups || []).map((x) => (named.has(x.id) ? { ...x, label: named.get(x.id), named: true } : x)) };
    const built = stampBoxes(diagramApi.build(layoutGraph(g, { dir: st.dir || 'TB', origin }), { look: lookRef.current }), g.nodes.map((n) => n.id), st);
    api.updateScene({ elements: mergeBuilt(now, built, replaced), captureUpdate: CAPTURE.IMMEDIATELY });
    scheduleSave();
    flash('Redrawn from today\'s data.');
  }, [api, diagramApi, flash, scheduleSave]);
  // Record Cards (11/07/2026, diagram/recordCards.js): a picked record lands
  // as one box that opens it; a task card says Open / Done.
  const placeRecord = useCallback(async (row) => {
    if (!api || !diagramApi || !row) return;
    const ref = `${row.kind === 'board' ? 'note' : row.kind}:${row.id}`;
    const state = row.kind === 'task' ? (await nexusApi.taskStates([row.id]).catch(() => null))?.tasks?.[row.id] : null;
    const stamp = newStamp();
    const g = prefixGraph(cardGraph(row, state), stamp);
    const r = stageRef.current?.getBoundingClientRect?.();
    const center = stageToBoard({ clientX: (r?.left || 0) + (r?.width || 0) / 2, clientY: (r?.top || 0) + (r?.height || 0) / 2 }, r, api.getAppState());
    const current = api.getSceneElementsIncludingDeleted();
    const placed = layoutGraph(g, { origin: placeOrigin(center, bounds(layoutGraph(g)), current) });
    const built = markCard(diagramApi.build(placed, { look: lookRef.current }), g.nodes[0].id, ref);
    api.updateScene({ elements: [...current, ...built], appState: { selectedElementIds: { [g.nodes[0].id]: true } }, captureUpdate: CAPTURE.IMMEDIATELY });
    api.scrollToContent(built, { fitToContent: false, animate: true });
    scheduleSave();
    flash('Added. Use the link button on the card to open it.');
  }, [api, diagramApi, scheduleSave, flash]);
  // An editor opening the board brings each task card's Open / Done line up
  // to date - once per board open, as newer versions (they sync and save).
  const cardsChecked = useRef(false);
  useEffect(() => {
    if (!api || !canEdit || cardsChecked.current) return;
    cardsChecked.current = true;
    const els0 = api.getSceneElementsIncludingDeleted();
    const ids = [...new Set([...taskCards(els0), ...taskStickies(els0)].map((c) => c.taskId))].slice(0, 50);
    if (!ids.length) return;
    nexusApi.taskStates(ids).then((res) => {
      const now = api.getSceneElementsIncludingDeleted();
      const changed = [...refreshedCards(now, res?.tasks), ...refreshedStickyFeet(now, res?.tasks)];
      if (!changed.length) return;
      const byId = new Map(changed.map((e) => [e.id, e]));
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => byId.get(e.id) || e), captureUpdate: CAPTURE.NEVER });
      scheduleSave();
    }).catch(() => {});
  }, [api, canEdit, scheduleSave]);
  const growBox = useCallback((side) => { diagramApi?.grow(stageRef.current, side); }, [diagramApi]);
  const onDiagram = useCallback((key) => {
    if (key.startsWith('shape:')) {
      placeGraph({ nodes: [{ id: 'n1', label: '', shape: key.slice(6) }], edges: [] });
      flash(isPhone ? 'Double-tap to type in it, or + to add the next box.' : 'Press Enter to type in it, or + to add the next box.');
    } else if (key.startsWith('tidy:')) tidy(key.slice(5));
    else if (key === 'refresh') refreshDiagram();
    else if (key === 'kit') setKitOpen(true);
    else setDgSheet(key);
  }, [placeGraph, tidy, refreshDiagram, flash, isPhone]);

  // ---- Meeting kit, stickies, threads, measure, ink (Neil, 11/10/2026) -----
  const chooseToolRef = useRef(null);
  chooseToolRef.current = chooseTool;
  const who = useMemo(() => ({ email: (me?.email || '').toLowerCase(), name: me?.name || me?.email || '' }), [me?.email, me?.name]);
  const followApi = engine?.follow || null;
  const measureFn = useMemo(() => pinMeasurer(look), [look]);
  const prep = useCallback((els) => (markupApi ? markupApi.prepare(els) : els), [markupApi]);
  const stageCenter = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect?.();
    return stageToBoard({ clientX: (r?.left || 0) + (r?.width || 0) / 2, clientY: (r?.top || 0) + (r?.height || 0) / 2 }, r, api?.getAppState());
  }, [api]);
  // An open thread reads the board as it is drawn: a change to its pin (here or from someone else) draws it again.
  const [, setDrawn] = useState(0);
  const commit = useCallback((elements, extra = {}) => {
    api.updateScene({ elements, captureUpdate: CAPTURE.IMMEDIATELY, ...extra });
    scheduleSave();
    setDrawn((n) => n + 1);
  }, [api, scheduleSave]);

  // The shared 'meet' map: the live session's, else this browser's own.
  const localMeet = useMemo(() => new Y.Doc().getMap(MEET), []);
  const meetMap = collab?.meet || localMeet;
  const [, setMeetTick] = useState(0);
  useEffect(() => {
    const f = () => setMeetTick((n) => n + 1);
    meetMap.observe(f);
    f();
    return () => meetMap.unobserve(f);
  }, [meetMap]);
  const meet = readMeet(meetMap);
  const votesNow = meet.vote ? tally(meetMap, meet.vote) : null;
  const mine = meet.vote ? myVotes(meetMap, meet.vote, who.email) : [];
  const [voteItems, setVoteItems] = useState([]);
  const voteOpenRef = useRef(false);
  voteOpenRef.current = !!meet.vote;
  useEffect(() => { if (meet.vote && api) setVoteItems(votableItems(api.getSceneElements())); }, [meet.vote?.id, api]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onMeet = useCallback((key) => {
    if (key.startsWith('timer:')) startTimer(meetMap, Number(key.slice(6)) * 60, who);
    else if (key.startsWith('vote:')) { startVote(meetMap, { perPerson: Number(key.slice(5)), ...who }); flash('Voting is open - click the dot on a sticky or box to vote.'); }
    else if (key === 'silent') { startSilent(meetMap, who); flash('Private Writing is on - new stickies stay hidden until they are revealed.'); }
    else if (key === 'summon') {
      try { collabRef.current?.awareness?.setLocalStateField('summon', { at: Date.now() }); flash('Everyone on the board is now following you.'); } catch { /* no session */ }
    }
  }, [meetMap, who, flash]);
  const onTimer = useCallback((a) => {
    if (a === 'pause') pauseTimer(meetMap); else if (a === 'resume') resumeTimer(meetMap);
    else if (a === 'add') addMinute(meetMap); else stopTimer(meetMap);
  }, [meetMap]);
  const onVote = useCallback((a) => {
    const vote = meetMap.get('vote');
    if (a === 'results' && vote && api) {
      const results = tally(meetMap, vote);
      if (results.size) commit(stampVotes(api.getSceneElementsIncludingDeleted(), results));
      flash(results.size ? 'The votes are on the board.' : 'Nobody voted - nothing was added.');
    }
    clearVotes(meetMap);
  }, [meetMap, api, commit, flash]);
  const castVote = useCallback((id) => {
    if (!toggleVote(meetMap, meetMap.get('vote'), who, id)) flash('You have used all your votes - take one back to move it.');
  }, [meetMap, who, flash]);

  // ---- Stickies: the composer, Private Writing's tray ----
  const tKey = trayKey(note?.id || '', who.email);
  const [tray, setTray] = useState(() => readTray(tKey));
  const setTrayBoth = useCallback((fn) => setTray((cur) => { const next = fn(cur); writeTray(tKey, next); return next; }), [tKey]);
  const [composer, setComposer] = useState(null);   // { key, boxId | trayId, x, y, text, colorKey }
  const stickyInk = () => STICKY_FOR_INK[mkRef.current.color] || 'yellow';
  const newStickyAt = useCallback((x, y, colorKey) => {
    if (meetMap.get('silent')) {
      const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setTrayBoth((cur) => [...cur, { id, x, y, text: '', colorKey }]);
      setComposer({ key: id, trayId: id, x, y, text: '', colorKey });
      return;
    }
    const els = api.getSceneElementsIncludingDeleted();
    const built = prep(sticky({ x, y, colorKey, by: who.email, name: who.name, look: lookRef.current }));
    commit([...els, ...built], { appState: { selectedElementIds: {} } });
    setComposer({ key: built[0].id, boxId: built[0].id, x, y, text: '', colorKey });
  }, [api, prep, who, commit, meetMap, setTrayBoth]);
  const placeSticky = useCallback((e) => {
    if (!api) return;
    const at = stageToBoard(e, stageRef.current?.getBoundingClientRect?.(), api.getAppState());
    newStickyAt(at.x - STICKY_SIZE / 2, at.y - STICKY_SIZE / 2, stickyInk());
  }, [api, newStickyAt]);   // eslint-disable-line react-hooks/exhaustive-deps
  const commitSticky = useCallback((text, dir) => {
    const c = composer;
    if (!c || !api) return;
    setComposer(null);
    const words = String(text || '').trim();
    if (c.trayId) {
      setTrayBoth((cur) => (words ? cur.map((t) => (t.id === c.trayId ? { ...t, text: words } : t)) : cur.filter((t) => t.id !== c.trayId)));
    } else {
      const els = api.getSceneElementsIncludingDeleted();
      const part = stickyParts(els).get(c.boxId);
      if (part && !words && !stickyWords(part)) commit(removeSelected(els, { [c.boxId]: true }));
      else if (part && words !== stickyWords(part)) commit(withStickyText(els, c.boxId, words, { look: lookRef.current, measureAt: (t, size) => measureFn(t) * (size / 16) }));
    }
    if (dir && words) {
      const at = c.trayId ? { x: c.x + (dir === 'down' ? 0 : STICKY_SIZE + 24), y: c.y + (dir === 'down' ? STICKY_SIZE + 24 : 0) }
        : nextSpot({ x: c.x, y: c.y }, dir, api.getSceneElementsIncludingDeleted());
      newStickyAt(at.x, at.y, c.colorKey);
    } else if (mkRef.current.tool === 'sticky') chooseToolRef.current?.('select');
  }, [composer, api, commit, newStickyAt, setTrayBoth, measureFn]);
  // The reveal: Private Writing ended - this person's hidden stickies go on the board.
  useEffect(() => {
    if (meet.silent || !api || !canEdit || !tray.length) return;
    const words = tray.filter((t) => String(t.text || '').trim());
    setTrayBoth(() => []);
    setComposer((c) => (c?.trayId ? null : c));
    if (!words.length) return;
    const els = api.getSceneElementsIncludingDeleted();
    const built = words.flatMap((t) => prep(sticky({ x: t.x, y: t.y, text: t.text, colorKey: t.colorKey, by: who.email, name: who.name, look: lookRef.current, measureAt: (x, size) => measureFn(x) * (size / 16) })));
    commit([...els, ...built]);
    flash(`Your ${words.length} ${words.length === 1 ? 'sticky is' : 'stickies are'} on the board.`);
  }, [meet.silent, api, canEdit, tray.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Selected stickies: Make Tasks, Sort ----
  const [selStickies, setSelStickies] = useState(0);
  const [tasksFor, setTasksFor] = useState(null);   // { lines, boxIds }
  const makeTasks = useCallback(() => {
    if (!api) return;
    const parts = selectedStickies(api.getSceneElementsIncludingDeleted(), api.getAppState()?.selectedElementIds).filter((p) => stickyWords(p));
    if (!parts.length) { flash('Write something on the stickies first.'); return; }
    setTasksFor({ lines: parts.map(stickyWords), boxIds: parts.map((p) => p.box.id) });
  }, [api, flash]);
  const tasksDone = useCallback((r) => {
    const f = tasksFor;
    const ids = r?.topLevelIds || [];
    if (!f || !api) return;
    if (ids.length === f.boxIds.length) {
      commit(linkStickies(api.getSceneElementsIncludingDeleted(), f.boxIds.map((boxId, i) => ({ boxId, taskId: ids[i] }))));
      flash(`${ids.length} ${ids.length === 1 ? 'task' : 'tasks'} made - each sticky now opens its task.`);
    } else if (ids.length) flash(`${ids.length} ${ids.length === 1 ? 'task' : 'tasks'} made. The list changed, so the stickies were not linked to them.`);
  }, [tasksFor, api, commit, flash]);
  const [sortOpen, setSortOpen] = useState(false);
  const sortBy = useCallback((by) => {
    setSortOpen(false);
    if (!api) return;
    const els = api.getSceneElementsIncludingDeleted();
    const next = sortStickies(els, api.getAppState()?.selectedElementIds, by, { look: lookRef.current });
    if (next === els) { flash('Select two or more stickies to sort.'); return; }
    commit(next);
  }, [api, commit, flash]);

  // ---- Comment threads ----
  const [threadAt, setThreadAt] = useState(null);   // { pin } | { isNew, x, y }
  const closedPin = useRef('');
  const threadPinRef = useRef('');
  const threadVerRef = useRef(0);
  threadPinRef.current = threadAt?.pin || '';
  const mentionable = useMemo(() => (people || []).filter((p) => p?.email && p.email.toLowerCase() !== who.email), [people, who.email]);
  const sendMentions = useCallback((pin, text, emails) => {
    if (!emails.length || !note?.id) return;
    nexusApi.boardMentions(note.id, { pin, text, emails })
      .then((r) => {
        const sent = (r?.sent || []).map((e) => mentionable.find((p) => p.email.toLowerCase() === e)?.name || e);
        if (sent.length) flash(`Notified ${sent.join(', ')}.`);
        if (r?.skipped?.length) flash(`${r.skipped.length === 1 ? 'One person' : `${r.skipped.length} people`} mentioned cannot open this board, so nobody told them.`, true);
      })
      .catch(() => flash('The mention was not sent - the comment is saved.', true));
  }, [note?.id, mentionable, flash]);
  const placeComment = useCallback((e) => {
    if (!api) return;
    const at = stageToBoard(e, stageRef.current?.getBoundingClientRect?.(), api.getAppState());
    chooseToolRef.current?.('select');
    setThreadAt({ isNew: true, x: at.x, y: at.y });
  }, [api]);
  const postThread = useCallback((text, emails) => {
    if (!api || !markupApi || !threadAt) return;
    const els = api.getSceneElementsIncludingDeleted();
    if (threadAt.isNew) {
      const thread = newThread(text, who);
      const pin = markupApi.prepare(commentPin({ x: threadAt.x, y: threadAt.y, text: thread.text, number: nextCommentNumber(els), colorKey: mkRef.current.color, look: lookRef.current, measure: measureFn, thread }));
      commit([...els, ...pin], { appState: { selectedElementIds: { [pin[0].id]: true } } });
      setThreadAt({ pin: pin[0].id });
      sendMentions(pin[0].id, text, emails);
      return;
    }
    const part = pinParts(els).get(threadAt.pin);
    if (!part) return;
    commit(withThread(els, threadAt.pin, withReply(threadOf(part), text, who), { look: lookRef.current, measure: measureFn, prepare: markupApi.prepare }));
    sendMentions(threadAt.pin, text, emails);
  }, [api, markupApi, threadAt, who, measureFn, commit, sendMentions]);
  const resolveThread = useCallback((on) => {
    if (!api || !markupApi || !threadAt?.pin) return;
    const els = api.getSceneElementsIncludingDeleted();
    const part = pinParts(els).get(threadAt.pin);
    if (part) commit(withThread(els, threadAt.pin, withResolved(threadOf(part), on, who), { look: lookRef.current, measure: measureFn, prepare: markupApi.prepare }));
  }, [api, markupApi, threadAt, who, measureFn, commit]);
  const closeThread = useCallback(() => { closedPin.current = threadAt?.pin || ''; setThreadAt(null); }, [threadAt]);
  // A bell's link (notes:<id>~<pin>) opens the board at its comment.
  const focused = useRef('');
  useEffect(() => {
    if (!api || !focusPin || focused.current === focusPin) return;
    focused.current = focusPin;
    const part = pinParts(api.getSceneElements()).get(focusPin);
    if (!part) return;
    api.updateScene({ appState: { selectedElementIds: { [focusPin]: true } }, captureUpdate: CAPTURE.NEVER });
    api.scrollToContent([part.box], { fitToContent: false, animate: true });
    setThreadAt({ pin: focusPin });
  }, [api, focusPin]);

  // ---- Measure ----
  const [measurePts, setMeasurePts] = useState({ points: [], hover: null });
  const imageUnder = (els, x, y) => [...els].reverse().find((e) => e && !e.isDeleted && e.type === 'image' && x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height);
  const finishMeasure = useCallback(async (points, tool) => {
    setMeasurePts({ points: [], hover: null });
    if (!api) return;
    const els = api.getSceneElementsIncludingDeleted();
    const color = colorByKey(mkRef.current.color).color;
    if (tool === 'area') {
      const px = scaleAt(els, { x: points[0][0], y: points[0][1] });
      if (!px) { flash('Set the scale first: choose Set Scale and draw over a length you know.', true); return; }
      commit([...els, ...prep(areaShape({ points, pxPerFt: px, color, look: lookRef.current }))]);
      return;
    }
    const [[x1, y1], [x2, y2]] = points;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 4) return;
    let px = tool === 'scale' ? null : scaleAt(els, { x: x1, y: y1 });
    let kind = 'length', on = '', onW = 0;
    if (!px) {
      const answer = await dialog.prompt('How long is this line in real life?', {
        title: 'Set Scale', confirmText: 'Set Scale', placeholder: '24\' 6"', required: true,
      });
      if (answer == null) return;
      const ft = parseLength(answer);
      if (!ft) { flash('That length was not understood - try 24\' 6" or 7.5 m.', true); return; }
      px = len / ft;
      kind = 'scale';
      const img = imageUnder(els, (x1 + x2) / 2, (y1 + y2) / 2);
      if (img) { on = img.id; onW = img.width; }
      flash(img ? 'Scale set for this picture. Measure Length and Measure Area now read in feet.' : 'Scale set for the board. Measure Length and Measure Area now read in feet.');
    }
    commit([...api.getSceneElementsIncludingDeleted(), ...prep(dimension({ x1, y1, x2, y2, pxPerFt: px, color, kind, on, onW, look: lookRef.current }))]);
    if (tool === 'scale') chooseToolRef.current?.('select');
  }, [api, commit, prep, flash]);
  const measureTap = useCallback((e, dbl = false) => {
    if (!api) return;
    const tool = mkRef.current.tool;
    const at = stageToBoard(e, stageRef.current?.getBoundingClientRect?.(), api.getAppState());
    const pts = measurePts.points;
    if (tool === 'area') {
      const z = Number(api.getAppState()?.zoom?.value) || 1;
      const nearFirst = pts.length >= 3 && Math.hypot(at.x - pts[0][0], at.y - pts[0][1]) * z < 12;
      if ((dbl || nearFirst) && pts.length >= 3) { finishMeasure(pts, 'area'); return; }
      if (!dbl) setMeasurePts({ points: [...pts, [at.x, at.y]], hover: null });
      return;
    }
    if (dbl) return;
    if (!pts.length) setMeasurePts({ points: [[at.x, at.y]], hover: null });
    else finishMeasure([pts[0], [at.x, at.y]], tool);
  }, [api, measurePts.points, finishMeasure]);
  const measureMove = useCallback((e) => {
    if (!api || !measurePts.points.length) return;
    const at = stageToBoard(e, stageRef.current?.getBoundingClientRect?.(), api.getAppState());
    setMeasurePts((m) => ({ ...m, hover: [at.x, at.y] }));
  }, [api, measurePts.points.length]);

  // ---- Storage Site Kit ----
  const placeKit = useCallback(async (name) => {
    if (!api) return;
    let dataURL;
    try { dataURL = await kitPng(name); } catch { flash('That drawing could not be drawn here - try again.', true); return; }
    const fileId = `kit-${name}`;
    if (!filesMeta.current[fileId]) api.addFiles([{ id: fileId, dataURL, mimeType: 'image/png', created: Date.now() }]);
    const c = stageCenter();
    const el = kitImage({ name, x: c.x - 100, y: c.y - 55 });
    commit([...api.getSceneElementsIncludingDeleted(), ...prep([el])], { appState: { selectedElementIds: { [el.id]: true } } });
    setKitOpen(false);
  }, [api, commit, prep, flash, stageCenter]);

  // ---- Import a picture or a PDF to mark up (boardImport.js) ----
  const [importing, setImporting] = useState(false);
  const importPictures = useCallback(async (list) => {
    if (!api || importing) return;
    const picked = importable(list);
    if (!picked.length) { flash('Pick a picture or a PDF.', true); return; }
    setImporting(true);
    const placed = [], engineFiles = [];
    const newId = () => `imp-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    let pages = 0, pictures = 0, left = 0;
    try {
      for (const f of picked) {
        if (isPdfFile(f)) {
          const { renderPdfPages } = await import('./pdfPage');
          const r = await renderPdfPages(f);
          left += r.total - r.pages.length;
          for (const p of r.pages) {
            const id = newId();
            engineFiles.push({ id, dataURL: await blobToDataURL(p.blob), mimeType: 'image/png', created: Date.now() });
            placed.push({ fileId: id, width: p.width, height: p.height, name: f.name, page: p.page });
            pages += 1;
          }
        } else {
          const id = newId();
          const { width, height } = await imageSize(f);
          engineFiles.push({ id, dataURL: await blobToDataURL(f), mimeType: f.type || 'image/png', created: Date.now() });
          placed.push({ fileId: id, width, height, name: f.name });
          pictures += 1;
        }
      }
    } catch {
      setImporting(false);
      flash('That file could not be read - is it a picture or a PDF?', true);
      return;
    }
    api.addFiles(engineFiles);
    const els = prep(importElements(placed, stageCenter()));
    // Behind everything already drawn, so the markup stays on top.
    commit([...els, ...api.getSceneElementsIncludingDeleted()], { appState: { selectedElementIds: {} } });
    setImporting(false);
    chooseTool('pen');
    const one = pages + pictures === 1;
    flash(`${placedWords(pages, pictures)} placed and locked, so you can draw right over ${one ? 'it' : 'them'} - right-click to unlock.${left > 0 ? ` Only the first ${pages} pages of the PDF were placed.` : ''}`);
  }, [api, importing, flash, prep, stageCenter, commit, chooseTool]);
  const pastePicture = useCallback(async () => {
    const files = [];
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => /^image\//.test(t) || t === 'application/pdf');
        if (type) files.push(new File([await item.getType(type)], type === 'application/pdf' ? 'Pasted.pdf' : 'Pasted Picture', { type }));
      }
    } catch {
      flash('The browser did not let Nexus read the clipboard - click the board and press Ctrl+V instead.', true);
      return;
    }
    if (!files.length) { flash('There is no picture on the clipboard - copy one first.', true); return; }
    importPictures(files);
  }, [flash, importPictures]);
  // A PDF pasted (Ctrl+V) or dropped on the board comes in the same way; a
  // picture stays the engine's own paste and drop (placed at the pointer).
  useEffect(() => {
    const root = stageRef.current;
    if (!canEdit || !api || !root) return undefined;
    const pdfs = (dt) => [...(dt?.files || [])].filter(isPdfFile);
    const typing = (t) => !!t?.closest?.('input, textarea, [contenteditable="true"]');
    const onPaste = (e) => {
      const here = root.contains(document.activeElement) || document.activeElement === document.body;
      if (typing(e.target) || !here) return;
      const got = pdfs(e.clipboardData);
      if (got.length) { e.preventDefault(); e.stopPropagation(); importPictures(got); }
    };
    const onDrop = (e) => {
      const got = pdfs(e.dataTransfer);
      if (got.length) { e.preventDefault(); e.stopPropagation(); importPictures(got); }
    };
    document.addEventListener('paste', onPaste, true);
    root.addEventListener('drop', onDrop, true);
    return () => { document.removeEventListener('paste', onPaste, true); root.removeEventListener('drop', onDrop, true); };
  }, [canEdit, api, importPictures]);

  // ---- Follow, Bring Everyone Here, the presenter's view ----
  const followRef = useRef('');
  const viewSent = useRef({ at: 0, timer: 0 });
  const peerSeen = useRef(new Map());   // clientId -> { summon, presenting, view }
  const fitTo = useCallback((view) => { if (api && followApi && Array.isArray(view) && view.length === 4) followApi.fit(api, view); }, [api, followApi]);
  const startFollow = useCallback((id, name) => {
    if (!api || !followApi) return;
    followRef.current = String(id);
    followApi.follow(api, String(id), name || '');
    fitTo(collabRef.current?.awareness?.getStates()?.get(Number(id))?.view);
  }, [api, followApi, fitTo]);
  useEffect(() => {
    const aw = collab?.awareness;
    if (!aw || !api || !followApi) return undefined;
    const mineId = collab.clientId;
    // What is already there when we join is not a fresh summon.
    aw.getStates().forEach((st, id) => { peerSeen.current.set(id, { summon: st?.summon?.at || 0, presenting: !!st?.presenting, view: st?.view }); });
    const onAware = () => {
      aw.getStates().forEach((st, id) => {
        if (id === mineId || !st?.user) return;
        const was = peerSeen.current.get(id) || {};
        const now = { summon: st.summon?.at || 0, presenting: !!st.presenting, view: st.view };
        peerSeen.current.set(id, now);
        if (now.summon > (was.summon || 0) && Date.now() - now.summon < SUMMON_FRESH_MS) startFollow(id, st.user.name);
        else if (now.presenting && !was.presenting) startFollow(id, st.user.name);
        else if (!now.presenting && was.presenting && followRef.current === String(id)) { followRef.current = ''; followApi.follow(api, null); }
        if (followRef.current === String(id) && now.view && String(now.view) !== String(was.view)) fitTo(now.view);
      });
    };
    aw.on('change', onAware);
    return () => aw.off('change', onAware);
  }, [collab?.awareness, collab?.clientId, api, followApi, startFollow, fitTo]);

  // What the engine's onChange tells the kit: `seen` for every change, `local`
  // for this person's own (it returns true when it changed the board again).
  const inkPending = useRef('');
  const selSeen = useRef('');
  hookRef.current.seen = (elements, appState) => {
    // follow mode: the engine's own avatar click sets who; fit to them at once
    const f = appState?.userToFollow?.socketId || '';
    if (f !== followRef.current) { followRef.current = f; if (f) fitTo(collabRef.current?.awareness?.getStates()?.get(Number(f))?.view); }
    // my view, for whoever follows me
    const aw = collabRef.current?.awareness;
    if (aw && followApi) {
      const send = () => { viewSent.current.timer = 0; viewSent.current.at = Date.now(); try { aw.setLocalStateField('view', followApi.view(api.getAppState())); } catch { /* closing */ } };
      if (!viewSent.current.timer) viewSent.current.timer = setTimeout(send, Math.max(0, VIEW_MS - (Date.now() - viewSent.current.at)));
    }
    // the selection: stickies (Make Tasks, Sort) and a comment's thread
    const ids = appState?.selectedElementIds || {};
    const key = Object.keys(ids).filter((k) => ids[k]).sort().join(',');
    if (key !== selSeen.current) {
      selSeen.current = key;
      setSelStickies(key ? selectedStickies(elements, ids).length : 0);
      const pin = key ? selectedPin(elements, ids) : '';
      if (pin && pin !== closedPin.current) setThreadAt({ pin });
      else if (!pin) { closedPin.current = ''; setThreadAt((t) => (t?.isNew ? t : null)); }
    }
    const open = threadPinRef.current && elements.find((e) => e.id === threadPinRef.current);
    if (open && open.version !== threadVerRef.current) { threadVerRef.current = open.version; setDrawn((n) => n + 1); }
    if (voteOpenRef.current) {
      const items = votableItems(elements);
      setVoteItems((cur) => (JSON.stringify(cur) === JSON.stringify(items) ? cur : items));
    }
  };
  hookRef.current.local = (elements, appState) => {
    if (!api || !propsRef.current.canEdit) return false;
    // Ink to Shape: a pen stroke just finished - a clean shape if it reads as one
    const drawing = appState?.newElement;
    if (drawing?.type === 'freedraw') inkPending.current = drawing.id;
    else if (inkPending.current && mkRef.current.inkShape && mkRef.current.tool === 'pen') {
      const id = inkPending.current;
      inkPending.current = '';
      const ink = elements.find((e) => e.id === id && !e.isDeleted);
      const rec = ink ? recognizeInk(ink) : null;
      if (rec) {
        const shapes = prep(shapeFromInk(ink, rec));
        const next = elements.map((e) => (e.id === id ? { ...e, isDeleted: true, version: (e.version || 0) + 1, versionNonce: nonce(), updated: Date.now() } : e));
        commit([...next, ...shapes]);
        return true;
      }
    } else inkPending.current = '';
    // a measure that was stretched reads its new length
    const changed = refreshMeasures(elements);
    if (changed.length) {
      const byId = new Map(changed.map((e) => [e.id, e]));
      api.updateScene({ elements: elements.map((e) => byId.get(e.id) || e), captureUpdate: CAPTURE.NEVER });
      scheduleSave();
      return true;
    }
    return false;
  };

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
      {!isPhone && <Menu.Item icon={<Presentation size={14} />} onSelect={startPresent}>Present</Menu.Item>}
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

  const showBar = !!(markupApi && api);
  const barOnly = showBar && isPhone;
  const toolsHidden = toolsHiddenHere && showBar;   // only an editor's bar folds away
  const sheetRow = (Icon, label, onClick) => (
    <button type="button" className="nx-mk-sheet-row" onClick={() => { setPhoneMore(false); onClick(); }}><Icon size={18} /> {label}</button>
  );
  return (
    <div ref={rootRef} className={`nx-board${isPhone ? ' is-phone' : ''}${canEdit ? '' : ' is-view'}${showBar ? ' has-markup' : ''}${barOnly ? ' is-markup-only' : ''}${toolsHidden ? ' is-tools-hidden' : ''}${present ? ' is-presenting' : ''}`} data-look={look}
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
                  onRecordOpen={openRecord}
                />
              </EngineBoundary>
            )}
        {showBar && PLACE_TOOLS.has(mk.tool) && !composer && !threadAt?.isNew && (() => {
          const t = mk.tool;
          const n = measurePts.points.length;
          const hint = t === 'comment' ? 'Tap where the comment goes'
            : t === 'sticky' ? 'Tap where the sticky goes'
              : t === 'area' ? (n < 3 ? 'Tap each corner of the area' : 'Tap the first corner again, or double-tap, to finish')
                : t === 'scale' ? (n ? 'Tap the other end' : 'Tap both ends of a length you know')
                  : (n ? 'Tap the end of the line' : 'Tap the start of the line');
          const tap = t === 'comment' ? placeComment : t === 'sticky' ? placeSticky : (e) => measureTap(e);
          return (
            <div className="nx-mk-place" data-testid="nx-markup-place" role="button" tabIndex={0} aria-label={hint}
              onClick={tap} onDoubleClick={t === 'area' ? (e) => measureTap(e, true) : undefined}
              onPointerMove={t === 'measure' || t === 'area' || t === 'scale' ? measureMove : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setMeasurePts({ points: [], hover: null }); chooseTool('select'); }
                else if (e.key === 'Enter' && t === 'area' && n >= 3) finishMeasure(measurePts.points, 'area');
              }}>
              <span className="nx-mk-place-hint">{hint}</span>
            </div>
          );
        })()}
        {api && (
          <BoardOverlay store={viewStore} phone={isPhone}
            stageSize={{ w: stageRef.current?.clientWidth || 0, h: stageRef.current?.clientHeight || 0 }}
            votes={meet.vote && canEdit && !present ? { items: voteItems, mine: new Set(mine), onToggle: castVote } : null}
            tray={tray.length ? { items: tray.filter((t) => t.id !== composer?.trayId), onEdit: (t) => setComposer({ key: `${t.id}e`, trayId: t.id, x: t.x, y: t.y, text: t.text, colorKey: t.colorKey }), onRemove: (id) => setTrayBoth((cur) => cur.filter((t) => t.id !== id)) } : null}
            composer={composer ? { ...composer, onCommit: commitSticky } : null}
            measure={['measure', 'area', 'scale'].includes(mk.tool) && measurePts.points.length ? { ...measurePts, closed: mk.tool === 'area' } : null}
            thread={(() => {
              if (!threadAt || present) return null;
              if (threadAt.isNew) return { box: { x: threadAt.x, y: threadAt.y, w: 0, h: 0 }, number: 0, thread: null, canEdit, people: mentionable, onPost: postThread, onClose: () => setThreadAt(null) };
              const part = pinParts(api.getSceneElements()).get(threadAt.pin);
              if (!part) return null;
              return {
                box: { x: part.box.x, y: part.box.y, w: part.box.width, h: part.box.height }, number: part.box.customData.nexusComment, thread: threadOf(part),
                canEdit, people: mentionable, onPost: postThread, onResolve: resolveThread, onClose: closeThread,
              };
            })()} />
        )}
        <MeetBar state={meet} canEdit={canEdit} myLeft={meet.vote ? meet.vote.perPerson - mine.length : 0} cast={votesNow ? castCount(votesNow) : 0}
          tray={tray.length} onTimer={onTimer} onVote={onVote} onReveal={() => endSilent(meetMap)} />
        {showBar && !toolsHidden && !present && selStickies > 0 && mk.tool === 'select' && (
          <div className="nx-sel-pill" role="toolbar" aria-label="Selected Stickies">
            <span className="nx-sel-count">{selStickies} {selStickies === 1 ? 'Sticky' : 'Stickies'}</span>
            <button type="button" onClick={makeTasks}><ListPlus size={15} aria-hidden /> Make {selStickies === 1 ? 'a Task' : 'Tasks'}</button>
            {selStickies > 1 && (
              <span className="nx-sel-sort">
                <button type="button" aria-expanded={sortOpen} onClick={() => setSortOpen((v) => !v)}><ArrowDownWideNarrow size={15} aria-hidden /> Sort</button>
                {sortOpen && (
                  <span className="nx-sel-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => sortBy('color')}>By Color</button>
                    <button type="button" role="menuitem" onClick={() => sortBy('author')}>By Author</button>
                    <button type="button" role="menuitem" onClick={() => sortBy('word')}>By Shared Word</button>
                  </span>
                )}
              </span>
            )}
          </div>
        )}
        {kitOpen && <SiteKitSheet onPick={placeKit} onClose={() => setKitOpen(false)} />}
        {tasksFor && (
          <Suspense fallback={null}>
            <StickyTasks lines={tasksFor.lines} onDone={tasksDone} onClose={() => setTasksFor(null)} />
          </Suspense>
        )}
        {showBar && !toolsHidden && !present && (
          <MarkupBar importer={{ onFiles: importPictures, onPaste: pastePicture, busy: importing }} diagram={diagramApi ? { onAction: onDiagram, canTidy: true, canRefresh } : null} phone={isPhone}
            meet={{ onAction: onMeet, canSilent: !meet.silent, canSummon: !!(collab?.awareness && followApi && collab?.peers?.length) }}
            snap={{ on: mk.snap !== false, onToggle: toggleSnap }} inkShape={{ on: !!mk.inkShape, onToggle: () => { const m = { ...mkRef.current, inkShape: !mkRef.current.inkShape }; mkRef.current = m; setMk(m); writeMarkupPref(m); } }} tool={mk.tool} colorKey={inkFor(mk)} sizeKey={mk.size} hasSelection={hasSelection}
            onTool={chooseTool} onColor={chooseColor} onSize={chooseSize} onUndo={undo} onRedo={redo} onDelete={deleteSelected}
            styleOpen={styleOpen} onStyle={isPhone ? toggleStyle : undefined}
            onMore={isPhone ? () => setPhoneMore(true) : undefined} onHide={isPhone ? undefined : () => hideTools(true)} />
        )}
        {toolsHidden && !present && (
          <button type="button" className="nx-board-show-tools" onClick={() => hideTools(false)}>
            <ChevronUp size={15} aria-hidden="true" /> Show Tools
          </button>
        )}
        {present && (<>
          <div className="nx-present-shield" aria-hidden="true" />
          <div className="nx-present-pill" role="toolbar" aria-label="Presenting">
            <button type="button" className="nx-mk-btn" onClick={() => stepSlide(-1)} disabled={present.i === 0} aria-label="Previous Slide" title="Previous (Left Arrow)"><ChevronLeft size={18} /></button>
            <span className="nx-present-count" aria-live="polite">{present.i + 1} of {present.slides.length}</span>
            <button type="button" className="nx-mk-btn" onClick={() => stepSlide(1)} disabled={present.i >= present.slides.length - 1} aria-label="Next Slide" title="Next (Right Arrow)"><ChevronRight size={18} /></button>
            <span className="nx-mk-sep" aria-hidden />
            <button type="button" className="nx-present-exit" onClick={stopPresent} title="Exit (Esc)"><X size={15} aria-hidden="true" /> Exit</button>
          </div>
        </>)}
        {showBar && diagramApi && grip && !toolsHidden && !present && (
          <div className="nx-dg-grip" style={{ left: grip.x, top: grip.y, width: grip.w, height: grip.h }}>
            {['up', 'right', 'down', 'left'].map((side) => (
              <button key={side} type="button" className={`nx-dg-plus is-${side}`} data-side={side}
                aria-label={`Add the Next Box ${SIDE_WORD[side]}`} title={isPhone ? 'Add the Next Box' : 'Add the Next Box (Ctrl + Arrow)'}
                onPointerDown={(e) => e.stopPropagation()} onClick={() => growBox(side)}>
                <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {dgSheet === 'record' && diagramApi && (
          <RecordCardSheet noteId={note?.id || ''} onClose={() => setDgSheet(null)}
            onPick={(row) => { setDgSheet(null); placeRecord(row); }} />
        )}
        {dgSheet && dgSheet !== 'record' && diagramApi && (
          <DiagramSheet mode={dgSheet} onClose={() => setDgSheet(null)}
            onPlace={(graph, opts) => { setDgSheet(null); placeGraph(graph, opts); }} />
        )}
        {notice && <div className={`nx-board-note${notice.error ? ' is-error' : ''}`} role="status">{notice.text}</div>}
        {showBar && isPhone && phoneMore && (
          <div className="nx-mk-sheet-wrap" onPointerDown={(e) => { if (e.target === e.currentTarget) setPhoneMore(false); }}>
            <div className="nx-mk-sheet" role="dialog" aria-label="Board Options">
              <div className="nx-mk-sheet-head">
                <span>Board</span>
                <button type="button" className="nx-mk-btn" onClick={() => setPhoneMore(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <div className="nx-board-menu-kicker">Look</div>
              {lookToggle}
              {sheetRow(Maximize2, 'Fit to Screen', fit)}
              {sheetRow(ImageIcon, 'Export as PNG', doExportPng)}
              {sheetRow(Copy, 'Copy as Picture', doCopy)}
              {sheetRow(FileJson, 'Download Board File', doDownload)}
              <div className="nx-board-menu-kicker">Canvas Background</div>
              <div className="nx-board-swatches" role="group" aria-label="Canvas Background">
                {CANVAS_COLORS.map((c) => (
                  <button key={c.color} type="button" className="nx-board-swatch" style={{ background: c.color }}
                    aria-label={c.label} title={c.label} onClick={() => setBackground(c.color)} />
                ))}
              </div>
              {sheetRow(Eraser, 'Clear Board', doClear)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
