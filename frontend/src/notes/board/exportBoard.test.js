import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exportToBlob, exportToSvg, exportToClipboard } = vi.hoisted(() => ({
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  exportToSvg: vi.fn(async () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('width', '10'); return s; }),
  exportToClipboard: vi.fn(async () => {}),
}));
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob, exportToSvg, exportToClipboard }));

import { exportPng, exportSvg, exportThumb, copyPng, downloadScene } from './exportBoard';
import { SCENE_TYPE } from './scene';

const api = {
  getSceneElements: () => [{ id: 'a', type: 'rectangle', isDeleted: false }],
  getSceneElementsIncludingDeleted: () => [{ id: 'a', type: 'rectangle', isDeleted: false }, { id: 'b', isDeleted: true, updated: Date.now() }],
  getAppState: () => ({ zoom: { value: 1 }, selectedElementIds: { a: true }, exportEmbedScene: true }),
  getFiles: () => ({}),
};

describe('exportBoard', () => {
  beforeEach(() => { exportToBlob.mockClear(); exportToSvg.mockClear(); exportToClipboard.mockClear(); });

  it('PNG is 2x with a background by default, never embedding the scene', async () => {
    const blob = await exportPng(api);
    expect(blob.type).toBe('image/png');
    const opts = exportToBlob.mock.calls[0][0];
    expect(opts.mimeType).toBe('image/png');
    expect(opts.appState.exportScale).toBe(2);
    expect(opts.appState.exportBackground).toBe(true);
    expect(opts.appState.exportEmbedScene).toBe(false);
    await exportPng(api, { background: false, scale: 1 });
    expect(exportToBlob.mock.calls[1][0].appState.exportBackground).toBe(false);
  });

  it('the thumbnail scales to 480 px wide and skips an empty board', async () => {
    await exportThumb(api);
    const opts = exportToBlob.mock.calls[0][0];
    expect(opts.getDimensions(960, 480)).toEqual({ width: 480, height: 240, scale: 0.5 });
    expect(opts.getDimensions(200, 100)).toEqual({ width: 200, height: 100, scale: 1 });
    expect(await exportThumb({ ...api, getSceneElements: () => [] })).toBeNull();
  });

  it('SVG serializes the engine element; copy asks the clipboard for a PNG', async () => {
    expect(await exportSvg(api)).toContain('<svg');
    await copyPng(api);
    expect(exportToClipboard.mock.calls[0][0].type).toBe('png');
  });

  it('the board file is the serialized scene from the engine when an api is given', () => {
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const n = realCreate(tag);
      if (tag === 'a') n.click = () => clicks.push({ href: n.href, download: n.download });
      return n;
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    downloadScene({ id: 'n', title: 'Yard: Plan/2', scene: '', filesMeta: {} }, api, 'clean');
    expect(clicks[0].download).toBe('Yard- Plan-2.nexusboard.json');
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/json');
    document.createElement.mockRestore();
  });

  it('without an api the saved scene string is what downloads', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    const scene = JSON.stringify({ type: SCENE_TYPE, elements: [] });
    downloadScene({ title: 'T', scene });
    const blob = globalThis.URL.createObjectURL.mock.calls[0][0];
    const text = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
    expect(text).toBe(scene);
  });
});
