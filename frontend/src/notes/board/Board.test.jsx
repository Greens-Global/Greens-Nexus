import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// jsdom has no canvas, so the engine is a stand-in that exposes what Board
// hands it and gives Board a fake imperative api.
const { engine, fakeApi, uploadBoardFile, loadBoardFiles, exportThumb } = vi.hoisted(() => {
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
  return { Excalidraw, MainMenu, THEME: { LIGHT: 'light', DARK: 'dark' }, CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' } };
});
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
vi.mock('./files', () => ({ uploadBoardFile, loadBoardFiles }));
vi.mock('./exportBoard', () => ({
  exportThumb, exportPng: vi.fn(async () => new Blob(['x'])), exportSvg: vi.fn(async () => '<svg/>'), copyPng: vi.fn(async () => {}),
  downloadBlob: vi.fn(), downloadScene: vi.fn(),
}));
const storeTaskFile = vi.hoisted(() => vi.fn(async () => 'https://x.supabase.co/storage/v1/object/public/task-files/notes/boards/note_1/markup.png'));
const attachMarkup = vi.hoisted(() => vi.fn(async () => ({ id: 'att_1' })));
vi.mock('../../tasks/lib', () => ({ dataUrlToFile: (d, name) => new File(['x'], name, { type: 'image/png' }), storeTaskFile }));
vi.mock('../../api', () => ({ api: { attachMarkup } }));

import Board from './Board';
import { SCENE_TYPE, FONT_SANS, FONT_HAND } from './scene';

const el = (over = {}) => ({ id: 'e1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, roughness: 1, version: 1, versionNonce: 1, isDeleted: false, updated: 1, ...over });
const note = (over = {}) => ({ id: 'note_1', title: 'Yard', kind: 'board', scene: '', canEdit: true, mine: true, sharedWith: [], ...over });

describe('Board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeApi.scene = []; fakeApi.files = {};
    Object.values(fakeApi).forEach((f) => typeof f?.mockClear === 'function' && f.mockClear());
    uploadBoardFile.mockReset(); loadBoardFiles.mockClear(); exportThumb.mockClear();
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

  it('opens read-only for a viewer, with no image tool and no clear canvas', async () => {
    await act(async () => { render(<Board note={note({ canEdit: false })} />); });
    expect(screen.getByTestId('engine').dataset.view).toBe('true');
    expect(screen.getByTestId('nx-board').className).toContain('is-view');
    expect(engine.props.UIOptions.tools.image).toBe(false);
    expect(screen.queryByText('Reset the canvas')).toBeNull();
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
    fakeApi.scene = [el(), el({ id: 'e2' })];
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

  it('a board made from a ticket offers Attach to <ticket>, which stores a PNG and posts it back through api.attachMarkup', async () => {
    storeTaskFile.mockClear(); attachMarkup.mockClear();
    const source = { kind: 'ticket', id: 't_1', label: 'Ticket #4 Leak', url: '/tickets?ticket=t_1' };
    render(<Board note={note({ source })} />);
    await act(async () => {});
    const item = screen.getByRole('button', { name: 'Attach to Ticket #4 Leak' });
    await act(async () => { fireEvent.click(item); });
    expect(storeTaskFile).toHaveBeenCalledTimes(1);
    expect(storeTaskFile.mock.calls[0][2]).toBe('notes/boards/note_1');
    expect(attachMarkup).toHaveBeenCalledWith(source, expect.objectContaining({ name: 'Yard.png', url: expect.stringContaining('markup.png') }));
    expect(fakeApi.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Attached to Ticket #4 Leak' }));
  });

  it('a board with a file or walkthrough source has no Attach item', async () => {
    render(<Board note={note({ source: { kind: 'walkthrough', id: 'p1', label: 'Walkthrough: lobby', url: '' } })} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /^Attach to/ })).toBeNull();
  });
});
