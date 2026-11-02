# Notes Whiteboard (Boards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A world-class whiteboard and markup tool inside Notes - a Board is a kind of note - that works on phone, tablet and web, with live collaboration, and lets anything in Nexus be marked up (Phase 2 in the same PR).

**Architecture:** The MIT Excalidraw engine (`@excalidraw/excalidraw` 0.18.x, self-hosted, English only) is wrapped by `frontend/src/notes/board/Board.jsx`, lazy-loaded as one `vendor-excalidraw` chunk. A Board is a `nexus_notes` row with `kind='board'`; its scene is JSON in a new `scene` column (2 MB cap), images are files in the private `task-files` bucket under `notes/boards/`, a PNG thumbnail is written on save. Live collaboration reuses the Notes encrypted Yjs transport over Supabase broadcast (`notes/collabRuntime.js`), with the board's elements in a `Y.Map`. Phase 2 adds a Mark Up action on every image surface, attach-back to tasks and tickets, a board embed node in rich notes, and templates.

**Tech Stack:** React 19 + Vite (rolldown manual chunks), `@excalidraw/excalidraw`, Yjs + y-protocols (present), TipTap (present), FastAPI + SQLAlchemy, Supabase storage + Realtime.

**Spec:** Design page https://claude.ai/artifact/GXys39HudBpDvNqkg7JUK2. Neil's decisions (11/02/2026): Excalidraw; raise the build budget 16,200 -> 19,200 KB with one documented exception for the engine chunk; Clean look by default with Sketch per board; live collaboration in Phase 1; boards live inside Notes; "Do phase 2 also".

## Global Constraints

- CSP is `script-src 'self'` and fonts from self only (`frontend/public/_headers`, a platform file - do NOT edit it): the engine, its fonts and locale must be self-hosted; no CDN, no `data:` scripts. Ship English only.
- Bundle budget (`frontend/scripts/check-bundle-size.mjs`): total 16,200 -> 19,200 KB, per-chunk 1,000 KB kept with ONE named exception `vendor-excalidraw` (document the reason in the file: Neil, 11/02/2026). The chunk is imported only when a board opens; first paint is unchanged.
- Notes rules (Neil, 10/30/2026): share as Can View / Can Edit to people only, no team sharing, no comments, no edit bells. Boards inherit them.
- Evidence buckets are PRIVATE: images go to `task-files` under `notes/boards/<noteId>/` via the Tasks uploader (`storeTaskFile` in `tasks/lib.js`); the scene keeps canonical URLs; the browser loads them through `GET /files/view`. Never a public bucket, never a `data:` URL saved in the scene.
- AI stays off. No Excalidraw hosted features (their AI, library hub, cloud links).
- American English, Title Case titles / buttons, sentence-case hints, no em dashes, dates via `lib/datetime`.
- Shared files (`models.py`, `main.py` migration lists, `api.js`, `tasks/components.jsx`) are append-only, minimal diff.
- Motion follows the house tokens; popups are sheets (the board itself is a full page / full-screen phone sheet, not a popup).

## Review Focus

1. A viewer (Can View) must never save a scene, a thumbnail or a file; the API refuses and the UI opens the engine in view mode.
2. A 2 MB+ scene, or a scene that is not `type: 'nexus-board'`, is refused with a clear 413 / 400 and the client keeps the last good scene.
3. Two editors moving the same element: the later version wins per element (`reconcileElements`), nobody's undo stack is polluted by remote changes, and a reconnect after a hidden tab resyncs without duplicating elements.
4. A pasted image lands in the bucket once; reloading the board shows it through the signed viewer; a dropped network during upload leaves no broken element.
5. Phone: the bottom tool strip clears the iOS keyboard strip, pinch zoom never scrolls the page, the Back gesture closes the sheet with the unsaved-work question Notes already asks.

## Interfaces (every task reads this)

```js
// frontend/src/notes/board/scene.js  (pure)
export const SCENE_TYPE = 'nexus-board';
export const SCENE_MAX = 2_000_000;                  // characters of JSON
export const LOOKS = ['clean', 'sketch'];
export function emptyScene(look = 'clean') -> { type, version: 1, look, elements: [], appState: {...safe defaults}, files: {} }
export function parseScene(str) -> scene | null       // tolerant: '' -> emptyScene('clean'); wrong type -> null
export function serializeScene({ elements, appState, filesMeta, look }) -> string   // prunes appState to SAFE_APP_STATE_KEYS, drops deleted elements older than 1 day
export const SAFE_APP_STATE_KEYS = ['viewBackgroundColor', 'gridSize', 'gridModeEnabled', 'zenModeEnabled', 'currentItemFontFamily', 'currentItemRoughness', 'currentItemStrokeColor', 'currentItemBackgroundColor', 'scrollX', 'scrollY', 'zoom'];
export function lookDefaults(look) -> partial appState  // clean: roughness 0, font = the engine's normal sans family id, sloppiness 0, stroke #1c2420; sketch: roughness 1, hand font
export function applyLook(elements, look) -> elements   // flips roughness / fontFamily on every element

// frontend/src/notes/board/files.js
export async function uploadBoardFile(noteId, file) -> { id, mimeType, url, created }   // storeTaskFile under notes/boards/<noteId>/, id = sha of bytes (Excalidraw file id)
export async function loadBoardFiles(filesMeta) -> BinaryFiles                               // fetch each url via the signed viewer (api.js rewrites), to dataURL; failures skipped

// frontend/src/notes/board/Board.jsx  (default export; the engine lives here; lazy-imported by NotesPage)
<Board
  note={{ id, title, kind: 'board', scene: string, canEdit: bool, mine: bool, sharedWith: [], source?: {kind,id,label,url} }}
  isPhone={bool}
  look={'clean'|'sketch'}
  onLook={(look) => void}
  onScene={(sceneString) => void}          // debounced 800 ms inside Board; the caller saves (PATCH scene)
  onThumb={(pngBlob) => void}              // 480 px wide PNG, 3 s after the last change
  collab={collabHandle | null}             // from useBoardCollab (Task D); Board calls collab.attach(excalidrawAPI) once
  onApi={(excalidrawAPI) => void}          // for export menu and Phase 2
/>
// Board handles: self-hosted assets (window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'), langCode 'en-US',
// theme from the app's data-theme, UIOptions hiding the engine's own save/load/library/links,
// image insert via files.js, view mode when !canEdit, the Clean/Sketch toggle via onLook (rewrites elements with applyLook).

// frontend/src/notes/board/exportBoard.js
export async function exportPng(api, { scale = 2, background = true }) -> Blob
export async function exportSvg(api) -> string
export async function copyPng(api) -> void
export function downloadScene(note) -> void      // <title>.nexusboard.json

// frontend/src/notes/board/useBoardCollab.js  (Task D)
export function useBoardCollab({ note, canEdit, enabled }) -> { attach(api), status: 'off'|'connecting'|'live'|'stale', peers: [{email, name, color}], resync() }

// frontend/src/notes/board/templates.js  (Task E)
export const TEMPLATES = [{ key: 'blank'|'grid'|'kanban'|'timeline'|'floorplan', label, hint, scene: () => scene }]

// frontend/src/lib/markup.js  (Task E)
export async function openMarkup({ imageUrl, mimeType, source: { kind: 'task'|'ticket'|'note'|'walkthrough'|'file', id, label, url } }) -> navigates to the new board
export function canMarkUp(mimeType) -> bool      // image/* and application/pdf

// api.js (append)
api.createNote({ kind: 'board', title, scene, source, templateKey? })      // existing POST /notes with new fields
api.patchNote(id, { scene, thumbUrl, source, rev })
api.attachMarkup(source, { url, name })      // Task E: routes to addTaskAttachment / addTicketAttachment

// Backend (Task B)
nexus_notes: + scene Text default '', + thumb_url String default '', + source Text default '' (JSON)
nexus_note_versions: + scene Text default ''
POST /notes: kind 'board' allowed; scene validated (type, size); source validated (kind in set, id, label <= 200, url ours or '')
PATCH /notes/{id}: scene (owner or can edit; 413 over SCENE_MAX; 400 wrong type), thumbUrl (must be our storage URL), rev conflict as today
GET /notes, /notes/{id}: rows carry kind, thumbUrl, source; scene only on the single-note GET
versions: snapshot scene for boards; restore sets scene
collab: /collab seed and reset work for boards (seed = elements into Y.Map from scene); /collab GET unchanged
```

---

### Task A: Engine, Board component, bundle (worktree `wt/board-engine`)

**Files:** Create `frontend/src/notes/board/{scene.js,scene.test.js,files.js,files.test.js,Board.jsx,Board.test.jsx,exportBoard.js,board.css}`, `frontend/scripts/copy-excalidraw-assets.mjs` (copies the used fonts from the package into `frontend/public/excalidraw-assets/`, run from `prebuild` and `predev`; add the output dir to .gitignore), modify `frontend/package.json` (dependency + scripts), `frontend/vite.config.js` (manual chunk `vendor-excalidraw` for `@excalidraw/` and `roughjs`/its deps; verify with the build which ids land there), `frontend/scripts/check-bundle-size.mjs` (total 19,200, exception list `{ 'vendor-excalidraw': 2000 }` with the reason comment).

- [ ] `npm i @excalidraw/excalidraw@^0.18.1` in the worktree; read `node_modules/@excalidraw/excalidraw/README.md` and `dist/types` for props, `exportToBlob`, `exportToSvg`, `serializeAsJSON`, `restoreElements`, `reconcileElements`, `getSceneVersion`, `MainMenu`, `UIOptions`, `langCode`, `EXCALIDRAW_ASSET_PATH`.
- [ ] `scene.test.js` → `scene.js` (emptyScene, parseScene tolerant/null, serializeScene prunes appState and drops old deleted elements, applyLook / lookDefaults). 
- [ ] `files.test.js` → `files.js` (upload path under notes/boards/<id>/, id derivation, loadBoardFiles skips failures).
- [ ] `Board.jsx` + `board.css` (Nexus palette for the engine's color picker via `initialData.appState` and the CSS variables the engine exposes; hide Library, Save to disk, Live collaboration, Links, Help from `UIOptions` / `MainMenu` and render our own menu: Clean / Sketch, Export PNG / SVG / Copy / Download file, Fit); view mode when `!canEdit`; phone: `isPhone` sets the engine's mobile layout and the bottom strip clears `env(safe-area-inset-bottom)` and the `useVisualViewport` offset (see `lib/useVisualViewport.js`). Render-smoke test with the engine mocked at module level (jsdom cannot run canvas) + a real `scene` round-trip test.
- [ ] Budget + chunk + assets script; `npm run build` passes with the exception; record the measured chunk sizes in the budget comment.
- [ ] Commit per step.

### Task B: Backend and data model (worktree `wt/board-api`)

**Files:** `backend/models.py` (append the four columns), `backend/main.py` (both migration lists: `ALTER TABLE nexus_notes ADD COLUMN IF NOT EXISTS scene TEXT DEFAULT ''`, `thumb_url`, `source`; `nexus_note_versions.scene`), `backend/routers/notes.py` (kind board, scene / thumbUrl / source handling, versions, restore, collab seed for boards), `backend/test_notes_boards.py` (new, one file per process; follow `backend/test_notes*.py` setup), `frontend/src/api.js` (append the fields; no new endpoints unless needed).

- [ ] Tests first: create board, scene saved and returned, viewer cannot save, 413 over cap, 400 wrong type, thumbUrl must be our storage, source validated, list rows carry kind/thumbUrl/source and no scene, versions snapshot + restore, trash/restore, daily/note paths unchanged.
- [ ] Implement; `backend/.venv/bin/python -m pytest backend/test_notes_boards.py -q`, the existing notes test files one by one, `backend/.venv/bin/ruff check backend/`.
- [ ] Commit per step.

### Task C: Notes UI wiring (worktree `wt/board-ui`)

**Files:** `frontend/src/notes/NotesPage.jsx` (New Board button beside New Note on desktop and in the phone header; NotePane renders `<Suspense fallback={<SkeletonBlocks/>}><Board .../></Suspense>` for `kind === 'board'` in place of the TipTap editor, full-bleed, title / tags / color / pin / share / history / trash exactly as a note; export menu swaps Markdown / Print for PNG / SVG / Copy / Download; status line and clash panel reuse; list row shows the thumbnail (`nt-row-thumb`, 64 x 40, object-fit cover) where the text preview is), `notes/notesModel.js` (`noteTitle` -> 'Untitled Board'), `notes/QuickNoteButton.jsx` / `QuickNotePanel.jsx` (New Board entry), `notes/NotesWidget.jsx` (boards listed with thumbnail), `notes/notes.css`, `notes/useNoteSync.js` (save path for `scene` with rev conflict), tests (`notes.test.jsx` additions, `NotesPage` board test with Board mocked).
- Import Board as `const Board = lazy(() => import('./board/Board'))`. Until Task A lands, develop against a stub at `notes/board/Board.jsx` that renders `<div data-testid="board-stub">` and the same props; Task A's real file replaces it at merge (keep the stub's prop names identical to the Interfaces block).

- [ ] Tests → implement → `npx vitest run src/notes` → lint; commit per step.

### Task D: Live collaboration for boards (after A + B merge; worktree `wt/board-collab`)

**Files:** `frontend/src/notes/collabTransport.js` (extracted from `collabRuntime.js`: channel, seal/open with the note key, epoch, wire types 0-4, hello / diff / vector / presence, trust gate, resync; `collabRuntime.js` keeps the TipTap half and imports the transport; `collab.test.jsx` stays green), `frontend/src/notes/board/useBoardCollab.js` + test, `backend/routers/notes.py` collab seed for boards (if Task B did not), `Board.jsx` (attach: local `onChange` -> diff by element `version`/`versionNonce` -> `Y.Map` transaction with origin local; remote update -> `reconcileElements(local, remote, appState)` -> `api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })`; awareness -> `api.updateScene({ collaborators })` with pointer, selectedElementIds, username, color), presence line in NotePane shows peers.

- [ ] Transport extraction with the existing tests green → hook tests (two docs in one test converge; remote change does not enter local history; stale epoch ignored) → wire into Board → commit per step.

### Task E: Phase 2 - Mark Up Anything, attach back, embed, templates (after C merges; worktree `wt/board-markup`)

**Files:** `frontend/src/lib/markup.js` + test; `frontend/src/tasks/components.jsx` `AttachmentViewer` gains a "Mark Up" button for images and PDFs (append-only; the button calls `openMarkup` with `source` from the viewer's context props - add an optional `markupSource` prop that Tasks and Tickets pass); `frontend/src/tickets/PropertyWalkthrough.jsx` photos; `frontend/src/notes/noteMedia.jsx` / the image node: Mark Up on a note image; PDF -> PNG via `pdfjs-dist` (already bundled in `vendor-pdf`) with a page picker (`notes/board/pdfPage.js`); `Board.jsx` menu: "Attach to <source label>" when `note.source` exists (export PNG -> `storeTaskFile` -> `api.attachMarkup`); `notes/noteExtensions.js` + `notes/board/BoardEmbed.jsx`: TipTap node `boardEmbed` (thumbnail + title, click opens the board; "Insert Board" in the editor toolbar lists the person's boards); `notes/board/templates.js` + `TemplatePicker.jsx` (Blank, Grid, Kanban with three frames, Timeline, Floor Plan with a 1 ft grid scale note) shown on New Board (phone: a sheet); backend: `api.attachMarkup` routes to the existing task / ticket attachment endpoints (no new endpoint); the board title defaults to "Mark Up: <label>".

- [ ] Tests → implement → full `npx vitest run` → lint → build; commit per step.

### Task F: Docs, review, PR (main branch)

- [ ] CLAUDE.md bullet under Frontend conventions: Boards are notes (`kind='board'`, `scene` JSON, 2 MB, images in `task-files` under notes/boards/), the engine is self-hosted and lazy in `vendor-excalidraw` (the one budget exception, Neil 11/02/2026), Clean default / Sketch per board, collaboration over the Notes transport, Mark Up from any image through `lib/markup.js` - never a second drawing engine or a second markup path.
- [ ] Three reviewers, fix pass, `npm run build`, PR against dev. Merge only on Neil's OK. Release note: new columns need no RLS (existing tables); run `get_advisors` anyway.
