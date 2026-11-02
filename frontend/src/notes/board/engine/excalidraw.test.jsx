import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// The vitest.setup.js global mock stands in for the package; this file pins
// what the adapter does with it.
const { calls, restoreElements } = vi.hoisted(() => ({
  calls: { blob: [], svg: [], clip: [] },
  restoreElements: vi.fn((els) => (els || []).map((e) => { if (e.id === 'bad') throw new Error('malformed'); return { ...e, restored: true }; })),
}));
vi.mock('@excalidraw/excalidraw', () => {
  const React = require('react');
  const Excalidraw = (props) => {
    React.useEffect(() => { props.excalidrawAPI?.({ fake: true }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
    return React.createElement('div', { 'data-testid': 'engine', 'data-view': String(!!props.viewModeEnabled), 'data-theme': props.theme, 'data-lang': props.langCode, 'data-name': props.name },
      props.renderTopRightUI ? props.renderTopRightUI(false, {}) : null, props.children);
  };
  const pass = ({ children }) => React.createElement('div', null, children);
  const MainMenu = pass;
  MainMenu.Item = ({ children, onSelect }) => React.createElement('button', { type: 'button', onClick: onSelect }, children);
  MainMenu.ItemCustom = pass; MainMenu.Separator = () => React.createElement('hr');
  return {
    Excalidraw, MainMenu, restoreElements,
    THEME: { LIGHT: 'light', DARK: 'dark' },
    CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
    exportToBlob: vi.fn(async (o) => { calls.blob.push(o); return new Blob(['png'], { type: 'image/png' }); }),
    exportToSvg: vi.fn(async (o) => { calls.svg.push(o); const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', '10'); return s; }),
    exportToClipboard: vi.fn(async (o) => { calls.clip.push(o); }),
  };
});
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));

import engine, { captureWords } from './excalidraw';
import { ENGINE_MEMBERS, CAPTURE } from './index';
import { SCENE_TYPE, FONT_HAND, emptyScene } from '../scene';

const el = (over = {}) => ({ id: 'e1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: 1, ...over });

describe('engine adapter: the drawing package behind the contract', () => {
  it('is the whole contract, and its capture words are the engine\'s own', () => {
    for (const k of ENGINE_MEMBERS) expect(engine[k], k).toBeDefined();
    expect(engine.CAPTURE).toEqual(CAPTURE);
    expect(captureWords()).toEqual(CAPTURE);
    expect(engine.Menu.Root).toBeTypeOf('function');
    expect(engine.Menu.Item).toBeTypeOf('function');
  });

  it('fromScene feeds the engine and toScene reads it back as a nexus-board scene, unchanged on disk', () => {
    const scene = { ...emptyScene('sketch'), elements: [el()], appState: { gridSize: 20 }, files: { f1: { id: 'f1', mimeType: 'image/png', url: 'https://api/files/view?u=x', created: 1 } } };
    const raw = engine.fromScene(scene);
    expect(raw.elements).toHaveLength(1);
    expect(raw.appState.gridSize).toBe(20);
    expect(raw.appState.currentItemFontFamily).toBe(FONT_HAND);
    expect(raw.files).toEqual({});              // pictures load through the signed viewer, never from the scene
    expect(raw.scrollToContent).toBe(true);
    const back = engine.toScene({ elements: raw.elements, appState: { ...raw.appState, selectedElementIds: { e1: true }, collaborators: new Map() }, files: scene.files, look: 'sketch' });
    expect(back.type).toBe(SCENE_TYPE);
    expect(back.look).toBe('sketch');
    expect(back.elements.map((e) => e.id)).toEqual(['e1']);
    expect(back.appState.selectedElementIds).toBeUndefined();
    expect(back.appState.collaborators).toBeUndefined();
    expect(back.files.f1.url).toBe('https://api/files/view?u=x');
    expect(JSON.parse(JSON.stringify(back))).toEqual(back);   // plain JSON
  });

  it('restore repairs through the engine, sizes kept, and drops only the element it cannot draw', () => {
    restoreElements.mockClear();
    const out = engine.restore([el({ id: 'ok' }), el({ id: 'bad' })]);
    expect(out.map((e) => e.id)).toEqual(['ok']);
    expect(out[0].restored).toBe(true);
    expect(restoreElements).toHaveBeenCalledWith(expect.any(Array), null, { refreshDimensions: false });
    restoreElements.mockClear();
    engine.restore([el()], { refreshDimensions: true });
    expect(restoreElements).toHaveBeenLastCalledWith(expect.any(Array), null, { refreshDimensions: true });
  });

  it('reconcile takes the newer copy of each element and repairs what came from outside', () => {
    const local = [el({ id: 'a', version: 2 }), el({ id: 'b', version: 1 })];
    const remote = [el({ id: 'a', version: 1 }), el({ id: 'b', version: 3, x: 9 }), el({ id: 'c' })];
    const out = engine.reconcile(local, remote);
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].version).toBe(2);
    expect(out[1]).toMatchObject({ version: 3, x: 9, restored: true });
  });

  it('exports: PNG at 2x with a background and never the scene embedded; a bounded width; SVG as text; the clipboard as PNG', async () => {
    const raw = { elements: [el()], files: {}, appState: { zoom: { value: 1 }, exportEmbedScene: true } };
    const blob = await engine.exportPng(raw);
    expect(blob.type).toBe('image/png');
    const o = calls.blob.at(-1);
    expect(o.mimeType).toBe('image/png');
    expect(o.appState).toMatchObject({ exportScale: 2, exportBackground: true, exportEmbedScene: false, exportWithDarkMode: false });
    await engine.exportPng(raw, { scale: 1, background: false, maxWidth: 480 });
    const t = calls.blob.at(-1);
    expect(t.appState.exportBackground).toBe(false);
    expect(t.getDimensions(960, 480)).toEqual({ width: 480, height: 240, scale: 0.5 });
    expect(t.getDimensions(200, 100)).toEqual({ width: 200, height: 100, scale: 1 });
    expect(await engine.exportSvg(raw)).toContain('<svg');
    await engine.copyPng(raw);
    expect(calls.clip.at(-1).type).toBe('png');
  });

  it('Canvas mounts the engine self-hosted, in English, with none of its hosted features, and hands the handle up', async () => {
    const onReady = vi.fn();
    const ref = { current: null };
    await act(async () => {
      render(<engine.Canvas scene={emptyScene('clean')} onChange={() => {}} look="clean" readOnly={false} viewportRef={ref} onReady={onReady} theme="dark" name="Yard"
        topRight={<span>TR</span>}
        menu={<engine.Menu.Root><engine.Menu.Item onSelect={() => {}}>Fit to Screen</engine.Menu.Item></engine.Menu.Root>} />);
    });
    const eng = screen.getByTestId('engine');
    expect(eng.dataset.lang).toBe('en-US');
    expect(eng.dataset.theme).toBe('dark');
    expect(eng.dataset.view).toBe('false');
    expect(eng.dataset.name).toBe('Yard');
    expect(onReady).toHaveBeenCalledWith({ fake: true });
    expect(ref.current).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('TR')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fit to Screen' })).toBeTruthy();
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('/excalidraw-assets/');
  });

  it('a read-only Canvas is the engine\'s view mode with no image tool', async () => {
    await act(async () => { render(<engine.Canvas scene={emptyScene('clean')} onChange={() => {}} look="clean" readOnly />); });
    expect(screen.getByTestId('engine').dataset.view).toBe('true');
  });
});
