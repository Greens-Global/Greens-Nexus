import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// jsdom has no canvas, so the engine is a stand-in that exposes what Board
// hands it and gives Board a fake imperative api.
const { engine, fakeApi, uploadBoardFile, loadBoardFiles, exportThumb, restoreElements, confirm, exportPng, downloadBlob, draft, engineLoad } = vi.hoisted(() => {
  const fakeApi = {
    scene: [], appState: { zoom: { value: 1 }, viewBackgroundColor: '#ffffff' }, files: {},
    getSceneElementsIncludingDeleted: vi.fn(() => fakeApi.scene),
    getSceneElements: vi.fn(() => fakeApi.scene.filter((e) => !e.isDeleted)),
    getAppState: vi.fn(() => fakeApi.appState),
    getFiles: vi.fn(() => fakeApi.files),
    addFiles: vi.fn(),
    updateScene: vi.fn((p) => { if (p.elements) fakeApi.scene = p.elements; }),
    scrollToContent: vi.fn(),
    setToast: vi.fn(),
  };
  return {
    fakeApi,
    engine: { props: null },
    uploadBoardFile: vi.fn(),
    loadBoardFiles: vi.fn(async () => ({})),
    exportThumb: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    // The engine's repair: a pass-through that marks what went through it.
    restoreElements: vi.fn((els) => (els || []).map((e) => ({ ...e, restored: true }))),
    confirm: vi.fn(async () => true),
    exportPng: vi.fn(async () => new Blob(['x'])),
    downloadBlob: vi.fn(),
    // The local draft (draft.js) - IndexedDB is not here; the unit tests cover it.
    draft: { saveDraft: vi.fn(async () => true), loadDraft: vi.fn(async () => null), clearDraft: vi.fn(async () => {}) },
    // `next` replaces the adapter's loadEngine for one test (a chunk that does not load).
    engineLoad: { next: null },
  };
});
vi.mock('@excalidraw/excalidraw', () => {
  const React = require('react');
  const Excalidraw = (props) => {
    engine.props = props;
    React.useEffect(() => { props.excalidrawAPI?.(fakeApi); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
    return React.createElement('div', { 'data-testid': 'engine', 'data-view': String(!!props.viewModeEnabled), 'data-theme': props.theme, 'data-lang': props.langCode },
      props.renderTopRightUI ? props.renderTopRightUI(false, {}) : null, props.children);
  };
  const pass = ({ children }) => React.createElement('div', null, children);
  const MainMenu = pass;
  MainMenu.Item = ({ children, onSelect }) => React.createElement('button', { type: 'button', onClick: onSelect }, children);
  MainMenu.ItemCustom = pass; MainMenu.Separator = () => null;
  MainMenu.DefaultItems = { ChangeCanvasBackground: () => React.createElement('div', null, 'Canvas background'), ClearCanvas: () => React.createElement('div', null, 'Reset the canvas') };
  return { Excalidraw, MainMenu, restoreElements, THEME: { LIGHT: 'light', DARK: 'dark' }, CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' } };
});
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
vi.mock('./files', () => ({ uploadBoardFile, loadBoardFiles }));
vi.mock('./exportBoard', () => ({
  exportThumb, exportPng, exportSvg: vi.fn(async () => '<svg/>'), copyPng: vi.fn(async () => {}),
  downloadBlob, downloadScene: vi.fn(),
}));
vi.mock('../../tasks/lib', () => ({ dataUrlToFile: (d, name) => new File(['x'], name, { type: 'image/png' }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm, alert: vi.fn() } }));
vi.mock('./draft', () => draft);
vi.mock('./engine', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, loadEngine: (...a) => (engineLoad.next ? engineLoad.next(...a) : real.loadEngine(...a)) };
});

import Board from './Board';
import { loadEngine } from './engine';
import { SCENE_TYPE, FONT_SANS, FONT_HAND, DELETED_KEEP_MS } from './scene';

const el = (over = {}) => ({ id: 'e1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, roughness: 1, version: 1, versionNonce: 1, isDeleted: false, updated: 1, ...over });
const note = (over = {}) => ({ id: 'note_1', title: 'Yard', kind: 'board', scene: '', canEdit: true, mine: true, sharedWith: [], ...over });

describe('Board', () => {
  // The adapter's first import() is real module loading, longer than one
  // act() flush; warmed here so every test finds the engine at once.
  beforeAll(async () => { await loadEngine(); });
  beforeEach(() => {
    vi.useFakeTimers();
    fakeApi.scene = []; fakeApi.files = {};
    Object.values(fakeApi).forEach((f) => typeof f?.mockClear === 'function' && f.mockClear());
    uploadBoardFile.mockReset(); loadBoardFiles.mockClear(); exportThumb.mockClear(); restoreElements.mockClear();
    confirm.mockReset(); confirm.mockResolvedValue(true); exportPng.mockClear(); downloadBlob.mockClear();
    draft.saveDraft.mockClear(); draft.loadDraft.mockReset(); draft.loadDraft.mockResolvedValue(null); draft.clearDraft.mockClear();
    engineLoad.next = null;
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('mounts the engine self-hosted, in English, editable, following the app theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const onApi = vi.fn();
    await act(async () => { render(<Board note={note()} onApi={onApi} />); });
    const eng = screen.getByTestId('engine');
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('/excalidraw-assets/');
    expect(eng.dataset.lang).toBe('en-US');
    expect(eng.dataset.view).toBe('false');
    expect(eng.dataset.theme).toBe('dark');
    expect(onApi).toHaveBeenCalledWith(fakeApi);
    // none of the engine's own hosted actions
    expect(engine.props.UIOptions.canvasActions).toMatchObject({ export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false });
    expect(engine.props.aiEnabled).toBe(false);
    expect(engine.props.validateEmbeddable).toBe(false);
  });

  it('opens read-only for a viewer, with no image tool, no Look rows and no editing items', async () => {
    await act(async () => { render(<Board note={note({ canEdit: false })} />); });
    expect(screen.getByTestId('engine').dataset.view).toBe('true');
    expect(screen.getByTestId('nx-board').className).toContain('is-view');
    expect(engine.props.UIOptions.tools.image).toBe(false);
    expect(screen.queryByText('Reset the canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear Board' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Canvas Background' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clean' })).toBeNull();
    expect(screen.queryByText('Look')).toBeNull();
    // the exports stay
    expect(screen.getByRole('button', { name: 'Export as PNG' })).toBeTruthy();
  });

  it('the menu uses the one set of words, never the engine\'s defaults', async () => {
    await act(async () => { render(<Board note={note()} />); });
    for (const name of ['Fit to Screen', 'Export as PNG', 'Export as SVG', 'Copy as Picture', 'Download Board File', 'Clear Board']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('group', { name: 'Canvas Background' })).toBeTruthy();
    expect(screen.queryByText('Canvas background')).toBeNull();
    expect(screen.queryByText('Reset the canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Attach to/ })).toBeNull();
  });

  it('Export as PNG names the file the way the Notes menu does', async () => {
    await act(async () => { render(<Board note={note({ title: 'Yard: North / South' })} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export as PNG' })); });
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Yard North South.png');
  });

  it('Copy as Picture says so in the house words', async () => {
    await act(async () => { render(<Board note={note()} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy as Picture' })); });
    expect(fakeApi.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied as a picture' }));
  });

  it('Clear Board asks first, then marks every shape deleted with a new version (undoable, carried to the others)', async () => {
    fakeApi.scene = [el(), el({ id: 'e2', version: 4 })];
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear Board' })); });
    expect(confirm).toHaveBeenCalledWith('Clear everything on this board?', { title: 'Clear Board', confirmText: 'Clear', danger: true });
    expect(fakeApi.scene.every((e) => !e.isDeleted)).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear Board' })); });
    const call = fakeApi.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe('IMMEDIATELY');
    expect(call.elements.every((e) => e.isDeleted)).toBe(true);
    expect(call.elements.find((e) => e.id === 'e2').version).toBe(5);
    act(() => { vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
  });

  it('Canvas Background sets the engine\'s background and saves', async () => {
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    fireEvent.click(screen.getByRole('button', { name: 'Light Blue' }));
    expect(fakeApi.updateScene).toHaveBeenLastCalledWith({ appState: { viewBackgroundColor: '#f5faff' }, captureUpdate: 'IMMEDIATELY' });
  });

  it('feeds the saved scene in, loads its images through the viewer, and saves 800 ms after a change', async () => {
    const scene = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'sketch', elements: [el()], appState: { gridSize: 20 }, files: { f1: { id: 'f1', mimeType: 'image/png', url: 'https://api/files/view?u=x', created: 1 } } });
    loadBoardFiles.mockResolvedValueOnce({ f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 } });
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note({ scene })} look="sketch" onScene={onScene} />); });
    expect(engine.props.initialData.elements).toHaveLength(1);
    expect(engine.props.initialData.appState.gridSize).toBe(20);
    expect(engine.props.initialData.appState.currentItemFontFamily).toBe(FONT_HAND);
    expect(loadBoardFiles).toHaveBeenCalledWith({ f1: expect.objectContaining({ url: 'https://api/files/view?u=x' }) });
    expect(fakeApi.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: 'f1' })]);
    fakeApi.scene = [el(), el({ id: 'e2', type: 'image', fileId: 'f1' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); });
    expect(onScene).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(799); });
    expect(onScene).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onScene).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(onScene.mock.calls[0][0]);
    expect(saved.type).toBe(SCENE_TYPE);
    expect(saved.look).toBe('sketch');
    expect(saved.elements.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(saved.files.f1.url).toBe('https://api/files/view?u=x');
  });

  it('writes a thumbnail 3 s after the last change', async () => {
    const onThumb = vi.fn();
    await act(async () => { render(<Board note={note()} onThumb={onThumb} />); });
    act(() => { engine.props.onChange([el()], fakeApi.appState, {}); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(exportThumb).toHaveBeenCalledWith(fakeApi);
    expect(onThumb).toHaveBeenCalledTimes(1);
  });

  it('never saves or stores for a viewer', async () => {
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note({ canEdit: false })} onScene={onScene} />); });
    act(() => { engine.props.onChange([el()], fakeApi.appState, { f9: { id: 'f9', dataURL: 'data:image/png;base64,AA', mimeType: 'image/png' } }); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onScene).not.toHaveBeenCalled();
    expect(uploadBoardFile).not.toHaveBeenCalled();
  });

  it('switching the look rewrites the elements, tells the caller and saves', async () => {
    const onLook = vi.fn(); const onScene = vi.fn();
    fakeApi.scene = [el(), el({ id: 't', type: 'text', fontFamily: FONT_HAND })];
    await act(async () => { render(<Board note={note()} look="sketch" onLook={onLook} onScene={onScene} />); });
    fireEvent.click(screen.getAllByRole('button', { name: 'Clean' })[0]);
    expect(onLook).toHaveBeenCalledWith('clean');
    const call = fakeApi.updateScene.mock.calls.at(-1)[0];
    expect(call.elements[0].roughness).toBe(0);
    expect(call.elements[1].fontFamily).toBe(FONT_SANS);
    // text re-measures in its new face
    expect(restoreElements).toHaveBeenLastCalledWith(expect.any(Array), null, { refreshDimensions: true });
    expect(call.elements[1].restored).toBe(true);
    expect(call.appState.currentItemRoughness).toBe(0);
    expect(call.captureUpdate).toBe('IMMEDIATELY');
    act(() => { vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalled();
  });

  it('stores a new image in the bucket and keeps its URL in the saved scene; a failed upload removes the picture', async () => {
    const onScene = vi.fn();
    uploadBoardFile.mockResolvedValueOnce({ id: 'f1', mimeType: 'image/png', url: 'https://api/files/view?u=stored', created: 7 });
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    fakeApi.scene = [el({ id: 'img', type: 'image', fileId: 'f1' })];
    await act(async () => { engine.props.onChange(fakeApi.scene, fakeApi.appState, { f1: { id: 'f1', dataURL: 'data:image/png;base64,AA', mimeType: 'image/png' } }); });
    expect(uploadBoardFile).toHaveBeenCalledTimes(1);
    expect(uploadBoardFile.mock.calls[0][0]).toBe('note_1');
    await act(async () => { vi.advanceTimersByTime(800); });
    const saved = JSON.parse(onScene.mock.calls.at(-1)[0]);
    expect(saved.files.f1.url).toBe('https://api/files/view?u=stored');
    expect(saved.files.f1.dataURL).toBeUndefined();
    // the same file again is not re-uploaded
    await act(async () => { engine.props.onChange(fakeApi.scene, fakeApi.appState, { f1: { id: 'f1', dataURL: 'data:image/png;base64,AA', mimeType: 'image/png' } }); });
    expect(uploadBoardFile).toHaveBeenCalledTimes(1);
    // a failed one takes its element off the board
    uploadBoardFile.mockRejectedValueOnce(new Error('upload failed'));
    fakeApi.scene = [...fakeApi.scene, el({ id: 'img2', type: 'image', fileId: 'f2' })];
    await act(async () => { engine.props.onChange(fakeApi.scene, fakeApi.appState, { f2: { id: 'f2', dataURL: 'data:image/png;base64,BB', mimeType: 'image/png' } }); });
    const last = fakeApi.updateScene.mock.calls.at(-1)[0];
    expect(last.elements.find((e) => e.id === 'img2').isDeleted).toBe(true);
    expect(last.captureUpdate).toBe('NEVER');
    expect(screen.getByRole('status')).toHaveTextContent(/not stored/);
  });

  it('a phone board carries the phone class and the keyboard inset variable hook', async () => {
    await act(async () => { render(<Board note={note()} isPhone />); });
    expect(screen.getByTestId('nx-board').className).toContain('is-phone');
    expect(engine.props.renderTopRightUI).toBeUndefined();     // the look toggle lives in the menu on a phone
  });

  // ── live collaboration (useBoardCollab) ──────────────────────────────────
  it('attaches the live session to the engine, hands it the pointer, and pushes every change into it', async () => {
    const collab = { attach: vi.fn(), onChange: vi.fn(), pointer: vi.fn() };
    await act(async () => { render(<Board note={note()} look="clean" onScene={vi.fn()} collab={collab} />); });
    expect(collab.attach).toHaveBeenCalledWith(fakeApi, { onRemoteFiles: expect.any(Function), restore: expect.any(Function) });
    // the session's elements go through the engine's repair, sizes kept
    const { restore } = collab.attach.mock.calls[0][1];
    expect(restore([el({ id: 'r9' })])[0]).toMatchObject({ id: 'r9', restored: true });
    expect(restoreElements).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'r9' })], null, { refreshDimensions: false });
    expect(engine.props.isCollaborating).toBe(true);
    engine.props.onPointerUpdate({ pointer: { x: 3, y: 4, tool: 'pointer' }, button: 'down' });
    expect(collab.pointer).toHaveBeenCalledWith({ pointer: { x: 3, y: 4, tool: 'pointer' }, button: 'down' });
    fakeApi.scene = [el()];
    act(() => { engine.props.onChange(fakeApi.scene, { ...fakeApi.appState, selectedElementIds: { e1: true } }, {}); });
    expect(collab.onChange).toHaveBeenCalledWith(fakeApi.scene, expect.any(Object), { e1: true });
  });

  it('an image the others added shows through the viewer and rides in the next save', async () => {
    const collab = { attach: vi.fn(), onChange: vi.fn(), pointer: vi.fn() };
    const onScene = vi.fn();
    loadBoardFiles.mockResolvedValueOnce({ f9: { id: 'f9', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 } });
    await act(async () => { render(<Board note={note()} look="clean" onScene={onScene} collab={collab} />); });
    const { onRemoteFiles } = collab.attach.mock.calls[0][1];
    const meta = { id: 'f9', mimeType: 'image/png', url: 'https://api/files/view?u=f9', created: 1 };
    await act(async () => { onRemoteFiles({ f9: meta }); });
    expect(loadBoardFiles).toHaveBeenCalledWith({ f9: meta });
    expect(fakeApi.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: 'f9' })]);
    // the picture's element arrives over the session too; a save then carries the meta
    fakeApi.scene = [el({ id: 'pic', type: 'image', fileId: 'f9' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(JSON.parse(onScene.mock.calls[0][0]).files.f9.url).toBe('https://api/files/view?u=f9');
  });

  it('a viewer follows the saved scene as it moves on, without a history entry', async () => {
    const first = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el()], appState: {}, files: {} });
    const { rerender } = render(<Board note={note({ scene: first, canEdit: false })} look="clean" />);
    await act(async () => {});
    fakeApi.updateScene.mockClear();
    const next = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el(), el({ id: 'e2' })], appState: {}, files: {} });
    await act(async () => { rerender(<Board note={note({ scene: next, canEdit: false })} look="clean" />); });
    expect(fakeApi.updateScene).toHaveBeenCalledWith({ elements: expect.arrayContaining([expect.objectContaining({ id: 'e2', restored: true })]), captureUpdate: 'NEVER' });
    expect(restoreElements).toHaveBeenLastCalledWith(expect.any(Array), null, { refreshDimensions: false });
  });

  it('an editor merges a saved scene that moved on (another person\'s shapes) into the canvas, without saving it back', async () => {
    const first = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el()], appState: {}, files: {} });
    const onScene = vi.fn(); const onThumb = vi.fn();
    fakeApi.scene = [el(), el({ id: 'mine', version: 2 })];
    const { rerender } = render(<Board note={note({ scene: first })} look="clean" onScene={onScene} onThumb={onThumb} />);
    await act(async () => {});
    // `mine` was drawn here (and saved) before the merge arrived.
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    onScene.mockClear(); onThumb.mockClear();
    fakeApi.updateScene.mockClear();
    // The server's copy after a merge: Bob moved e1 (version 3) and drew b1; it also holds an older copy of `mine`.
    const merged = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', appState: {}, files: {},
      elements: [el({ x: 99, version: 3, versionNonce: 5 }), el({ id: 'b1' }), el({ id: 'mine', version: 1 })] });
    await act(async () => { rerender(<Board note={note({ scene: merged })} look="clean" onScene={onScene} onThumb={onThumb} />); });
    const call = fakeApi.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe('NEVER');
    expect(call.elements.map((e) => e.id)).toEqual(['e1', 'mine', 'b1']);
    expect(call.elements.find((e) => e.id === 'e1')).toMatchObject({ x: 99, version: 3, restored: true });
    expect(call.elements.find((e) => e.id === 'mine').version).toBe(2);      // this person's newer copy stays
    // The engine echoes the update: nothing is saved back.
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(onScene).not.toHaveBeenCalled();
    expect(onThumb).not.toHaveBeenCalled();
  });

  it('an editor\'s own save coming back as the note\'s scene is not put on the canvas again', async () => {
    const onScene = vi.fn();
    const { rerender } = render(<Board note={note()} look="clean" onScene={onScene} />);
    await act(async () => {});
    fakeApi.scene = [el()];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    const sent = onScene.mock.calls[0][0];
    fakeApi.updateScene.mockClear();
    await act(async () => { rerender(<Board note={note({ scene: sent })} look="clean" onScene={onScene} />); });
    expect(fakeApi.updateScene).not.toHaveBeenCalled();
  });

  it('an own save that comes back re-dumped by the server (an emoji escaped as \\uXXXX) is still known as ours', async () => {
    const onScene = vi.fn();
    const { rerender } = render(<Board note={note({ rev: 4 })} look="clean" onScene={onScene} />);
    await act(async () => {});
    fakeApi.scene = [el({ id: 't', type: 'text', text: 'Yard 😀 café' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    const sent = onScene.mock.calls[0][0];
    // Python's json.dumps(ensure_ascii=True) spelling of the same scene
    const theirs = sent.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(theirs).not.toBe(sent);
    fakeApi.updateScene.mockClear();
    await act(async () => { rerender(<Board note={note({ rev: 5, scene: theirs })} look="clean" onScene={onScene} />); });
    expect(fakeApi.updateScene).not.toHaveBeenCalled();
    expect(draft.clearDraft).toHaveBeenCalledWith('note_1');
  });

  // ── saving: flush, no repeats, not the others' strokes ─────────────────
  it('Back / Close inside the save delay still hands over the last stroke, once', async () => {
    const onScene = vi.fn();
    const { unmount } = render(<Board note={note()} onScene={onScene} />);
    await act(async () => {});
    fakeApi.scene = [el()];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(onScene).not.toHaveBeenCalled();
    unmount();
    expect(onScene).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onScene.mock.calls[0][0]).elements.map((e) => e.id)).toEqual(['e1']);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onScene).toHaveBeenCalledTimes(1);
  });

  it('nothing pending at unmount sends nothing; a viewer never sends', async () => {
    const onScene = vi.fn();
    const a = render(<Board note={note()} onScene={onScene} />);
    await act(async () => {});
    a.unmount();
    const b = render(<Board note={note({ canEdit: false })} onScene={onScene} />);
    await act(async () => {});
    act(() => { engine.props.onChange([el()], fakeApi.appState, {}); });
    b.unmount();
    expect(onScene).not.toHaveBeenCalled();
  });

  it('a change that serializes the same as the last one sent (a selection) is not sent again', async () => {
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    fakeApi.scene = [el()];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    act(() => { engine.props.onChange(fakeApi.scene, { ...fakeApi.appState, selectedElementIds: { e1: true } }, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    // a pan is kept with the scene
    fakeApi.appState = { ...fakeApi.appState, scrollX: 120 };
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(2);
    expect(JSON.parse(onScene.mock.calls[1][0]).appState.scrollX).toBe(120);
    fakeApi.appState = { zoom: { value: 1 }, viewBackgroundColor: '#ffffff' };
  });

  it('opening a board and changing nothing sends nothing', async () => {
    const saved = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el()], appState: {}, files: {} });
    const onScene = vi.fn();
    fakeApi.scene = [el()];
    fakeApi.appState = {};
    await act(async () => { render(<Board note={note({ scene: saved })} look="clean" onScene={onScene} />); });
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).not.toHaveBeenCalled();
    fakeApi.appState = { zoom: { value: 1 }, viewBackgroundColor: '#ffffff' };
  });

  it('the others\' strokes put on the engine by the live session do not schedule a save here', async () => {
    const onScene = vi.fn(); const onThumb = vi.fn();
    const remote = el({ id: 'r1', version: 3, versionNonce: 9 });
    const collab = { attach: vi.fn(), onChange: vi.fn(), pointer: vi.fn(), isRemoteElement: (e) => e.id === 'r1' && e.version === 3 };
    await act(async () => { render(<Board note={note()} onScene={onScene} onThumb={onThumb} collab={collab} />); });
    fakeApi.scene = [remote];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(onScene).not.toHaveBeenCalled();
    expect(onThumb).not.toHaveBeenCalled();
    // a stroke drawn here alongside it is saved
    fakeApi.scene = [remote, el({ id: 'mine' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    // this person moving the remote shape is theirs
    fakeApi.scene = [{ ...remote, x: 50, version: 4, versionNonce: 2 }, el({ id: 'mine' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(2);
  });

  // ── images: one meta per engine id; nothing half-uploaded saved ────────
  it('an uploaded image is kept under the engine\'s file id only', async () => {
    const onScene = vi.fn();
    uploadBoardFile.mockResolvedValueOnce({ id: 'sha-of-bytes', mimeType: 'image/png', url: 'https://api/files/view?u=stored', created: 7 });
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    fakeApi.scene = [el({ id: 'img', type: 'image', fileId: 'engine-id' })];
    await act(async () => { engine.props.onChange(fakeApi.scene, fakeApi.appState, { 'engine-id': { id: 'engine-id', dataURL: 'data:image/png;base64,AA', mimeType: 'image/png' } }); });
    await act(async () => { vi.advanceTimersByTime(800); });
    const saved = JSON.parse(onScene.mock.calls.at(-1)[0]);
    expect(Object.keys(saved.files)).toEqual(['engine-id']);
    expect(saved.files['engine-id'].id).toBe('engine-id');
  });

  it('a board closed while an image is uploading saves without that image (no missing-picture mark)', async () => {
    const onScene = vi.fn();
    uploadBoardFile.mockReturnValueOnce(new Promise(() => {}));     // never finishes
    const { unmount } = render(<Board note={note()} onScene={onScene} />);
    await act(async () => {});
    fakeApi.scene = [el(), el({ id: 'img', type: 'image', fileId: 'f5' })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, { f5: { id: 'f5', dataURL: 'data:image/png;base64,AA', mimeType: 'image/png' } }); });
    unmount();
    const saved = JSON.parse(onScene.mock.calls.at(-1)[0]);
    expect(saved.elements.map((e) => e.id)).toEqual(['e1']);
    expect(saved.files.f5).toBeUndefined();
  });

  // ── robustness (Neil, 11/02/2026): the engine behind the adapter ─────────
  it('the drawing tools not loading shows the last picture read-only with Retry - never blank, never a throw; Retry loads again', async () => {
    engineLoad.next = async () => { throw new Error('Failed to fetch dynamically imported module'); };
    const onApi = vi.fn();
    await act(async () => { render(<Board note={note({ thumbUrl: 'https://api/files/view?u=thumb' })} onApi={onApi} />); });
    expect(screen.queryByTestId('engine')).toBeNull();
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://api/files/view?u=thumb');
    expect(screen.getByText('The drawing tools did not load.')).toBeTruthy();
    expect(onApi).not.toHaveBeenCalled();
    expect(document.body.textContent.toLowerCase()).not.toContain('excalidraw');
    engineLoad.next = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByTestId('engine')).toBeTruthy();
    expect(onApi).toHaveBeenCalledWith(fakeApi);
  });

  it('while the engine loads the stage shows a skeleton, not nothing', async () => {
    let release;
    engineLoad.next = () => new Promise((r) => { release = r; });
    const { container } = render(<Board note={note()} />);
    await act(async () => {});
    expect(container.querySelector('.nx-skel')).toBeTruthy();
    expect(screen.queryByTestId('engine')).toBeNull();
    const real = await vi.importActual('./engine');
    await act(async () => { release(await real.loadEngine()); });
    expect(screen.getByTestId('engine')).toBeTruthy();
  });

  it('every save first goes to the local draft with the rev; the save coming back clears it', async () => {
    const onScene = vi.fn();
    const { rerender } = render(<Board note={note({ rev: 7 })} onScene={onScene} />);
    await act(async () => {});
    fakeApi.scene = [el()];
    await act(async () => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    const sent = onScene.mock.calls[0][0];
    expect(draft.saveDraft).toHaveBeenCalledWith('note_1', sent, { rev: 7 });
    expect(draft.clearDraft).not.toHaveBeenCalled();
    await act(async () => { rerender(<Board note={note({ rev: 8, scene: sent })} onScene={onScene} />); });
    expect(draft.clearDraft).toHaveBeenCalledWith('note_1');
  });

  it('a draft newer than the saved board is offered on open: Restore puts it on the canvas and saves it', async () => {
    const saved = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el()], appState: {}, files: {} });
    const mine = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el(), el({ id: 'drawn', version: 2 })], appState: { scrollX: 5 }, files: {} });
    draft.loadDraft.mockResolvedValue({ scene: mine, rev: 3, at: new Date(2026, 10, 2, 14, 14).getTime() });
    const onScene = vi.fn();
    fakeApi.scene = [el()];
    await act(async () => { render(<Board note={note({ rev: 3, scene: saved })} look="clean" onScene={onScene} />); });
    const banner = screen.getByRole('status', { name: /unsaved drawing/i });
    expect(banner.textContent).toContain('You have unsaved drawing from 11/02/2026, 2:14 PM');
    fakeApi.updateScene.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
    const call = fakeApi.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe('IMMEDIATELY');
    expect(call.elements.map((e) => e.id)).toEqual(['e1', 'drawn']);
    expect(call.elements[1].restored).toBe(true);     // through the engine's repair
    expect(screen.queryByRole('status', { name: /unsaved drawing/i })).toBeNull();
    act(() => { vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onScene.mock.calls[0][0]).elements.map((e) => e.id)).toEqual(['e1', 'drawn']);
  });

  it('Discard forgets the draft; a draft from an older rev with other strokes IS offered (Restore reconciles newest-wins); one equal to the board, or a viewer\'s board, is never offered', async () => {
    const saved = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el()], appState: {}, files: {} });
    const mine = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el({ id: 'z' })], appState: {}, files: {} });
    draft.loadDraft.mockResolvedValue({ scene: mine, rev: 3, at: Date.now() });
    const a = render(<Board note={note({ rev: 3, scene: saved })} look="clean" onScene={vi.fn()} />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })); });
    expect(draft.clearDraft).toHaveBeenCalledWith('note_1');
    expect(screen.queryByRole('status', { name: /unsaved drawing/i })).toBeNull();
    a.unmount();
    // drawn over an older rev: a collaborator saved in between, but the
    // strokes in the draft are not on the board - it is offered, and
    // Restore merges newest-wins over what the board has now (11/02/2026:
    // the rev gate dropped these and lost the strokes)
    draft.clearDraft.mockClear();
    draft.loadDraft.mockResolvedValue({ scene: mine, rev: 2, at: Date.now() });
    fakeApi.scene = [el()];
    const b = render(<Board note={note({ rev: 3, scene: saved })} look="clean" onScene={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole('status', { name: /unsaved drawing/i })).toBeTruthy();
    expect(draft.clearDraft).not.toHaveBeenCalled();
    fakeApi.updateScene.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
    expect(fakeApi.updateScene.mock.calls.at(-1)[0].elements.map((e) => e.id)).toEqual(['e1', 'z']);
    b.unmount();
    // the same as the board: nothing to offer - even when the server's
    // spelling of the JSON differs (non-ASCII escaped)
    draft.clearDraft.mockClear();
    const savedWithEmoji = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el({ id: 't', type: 'text', text: 'Yard 😀' })], appState: {}, files: {} });
    const serverSpelling = savedWithEmoji.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    draft.loadDraft.mockResolvedValue({ scene: savedWithEmoji, rev: 3, at: Date.now() });
    const c = render(<Board note={note({ rev: 3, scene: serverSpelling })} look="clean" onScene={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByRole('status', { name: /unsaved drawing/i })).toBeNull();
    expect(draft.clearDraft).toHaveBeenCalledWith('note_1');
    c.unmount();
    // a viewer cannot save a draft back
    draft.loadDraft.mockResolvedValue({ scene: mine, rev: 3, at: Date.now() });
    render(<Board note={note({ rev: 3, scene: saved, canEdit: false })} look="clean" />);
    await act(async () => {});
    expect(screen.queryByRole('status', { name: /unsaved drawing/i })).toBeNull();
  });

  it('a board over the size cap is not sent (no 413) - it says so until a save fits', async () => {
    const onScene = vi.fn();
    await act(async () => { render(<Board note={note()} onScene={onScene} />); });
    fakeApi.scene = [el({ id: 'huge', type: 'text', text: 'x'.repeat(2_000_100) })];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).not.toHaveBeenCalled();
    expect(draft.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('This board is too large to save - move some of it to a new board.');
    fakeApi.scene = [el()];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    expect(onScene).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/too large/)).toBeNull();
  });

  it('a save compacts: a deletion more than a day old and the file only it used are left out; one from an hour ago is still carried', async () => {
    const file = (id) => ({ id, mimeType: 'image/png', url: `https://api/files/view?u=${id}`, created: 1 });
    const stale = el({ id: 'gone', type: 'image', fileId: 'fOld', isDeleted: true, updated: Date.now() - DELETED_KEEP_MS - 60_000 });
    const recent = el({ id: 'hourAgo', type: 'image', fileId: 'fHour', isDeleted: true, updated: Date.now() - 3600_000 });
    const saved = JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'clean', elements: [el(), stale, recent], appState: {},
      files: { fOld: file('fOld'), fHour: file('fHour') } });
    const onScene = vi.fn();
    fakeApi.scene = [el(), stale, recent];
    await act(async () => { render(<Board note={note({ scene: saved })} look="clean" onScene={onScene} />); });
    fakeApi.scene = [el({ x: 5, version: 2 }), stale, recent];
    act(() => { engine.props.onChange(fakeApi.scene, fakeApi.appState, {}); vi.advanceTimersByTime(800); });
    const out = JSON.parse(onScene.mock.calls[0][0]);
    // the hour-old deletion rides along for a collaborator who saved in
    // between and has not seen it yet - never pruned by this tab's own clock
    expect(out.elements.map((e) => e.id)).toEqual(['e1', 'hourAgo']);
    expect(Object.keys(out.files)).toEqual(['fHour']);
  });
});
