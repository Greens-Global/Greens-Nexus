import { describe, it, expect } from 'vitest';
import {
  SCENE_TYPE, SCENE_MAX, LOOKS, SAFE_APP_STATE_KEYS,
  emptyScene, parseScene, serializeScene, buildScene, compact, lookDefaults, applyLook,
} from './scene';

const el = (over = {}) => ({
  id: 'e1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, roughness: 1,
  version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), ...over,
});

describe('board scene', () => {
  it('starts empty, clean, with safe app state only', () => {
    const s = emptyScene();
    expect(s.type).toBe(SCENE_TYPE);
    expect(s.version).toBe(1);
    expect(s.look).toBe('clean');
    expect(s.elements).toEqual([]);
    expect(s.files).toEqual({});
    for (const k of Object.keys(s.appState)) expect(SAFE_APP_STATE_KEYS).toContain(k);
    expect(s.appState.currentItemRoughness).toBe(0);
    expect(emptyScene('sketch').look).toBe('sketch');
    expect(LOOKS).toEqual(['clean', 'sketch']);
    expect(SCENE_MAX).toBe(2_000_000);
  });

  it('parses tolerantly: blank is an empty clean scene, garbage and the wrong type are null', () => {
    expect(parseScene('')).toEqual(emptyScene('clean'));
    expect(parseScene(null)).toEqual(emptyScene('clean'));
    expect(parseScene('{not json')).toBeNull();
    expect(parseScene(JSON.stringify({ type: 'excalidraw', elements: [] }))).toBeNull();
    const ok = parseScene(JSON.stringify({ type: SCENE_TYPE, version: 1, look: 'sketch', elements: [el()], appState: { zoom: { value: 2 }, collaborators: 'x' }, files: { f: { id: 'f', url: 'u' } } }));
    expect(ok.look).toBe('sketch');
    expect(ok.elements).toHaveLength(1);
    expect(ok.appState.zoom).toEqual({ value: 2 });
    expect(ok.appState.collaborators).toBeUndefined();     // only safe keys survive
    expect(ok.files.f.url).toBe('u');
    // An unknown look falls back to clean, a missing elements list to []
    expect(parseScene(JSON.stringify({ type: SCENE_TYPE, look: 'neon' })).look).toBe('clean');
    expect(parseScene(JSON.stringify({ type: SCENE_TYPE })).elements).toEqual([]);
  });

  it('serializes with pruned app state, no data URLs, and drops old deleted elements', () => {
    const old = Date.now() - 2 * 24 * 3600 * 1000;
    const out = serializeScene({
      elements: [el(), el({ id: 'gone-old', isDeleted: true, updated: old }), el({ id: 'gone-new', isDeleted: true, updated: Date.now() })],
      appState: { zoom: { value: 1.5 }, scrollX: 3, selectedElementIds: { e1: true }, collaborators: new Map(), viewBackgroundColor: '#fff' },
      filesMeta: { f1: { id: 'f1', mimeType: 'image/png', url: 'https://x/y.png', created: 1, dataURL: 'data:image/png;base64,AAAA' } },
      look: 'clean',
    });
    const s = JSON.parse(out);
    expect(s.type).toBe(SCENE_TYPE);
    expect(s.elements.map((e) => e.id)).toEqual(['e1', 'gone-new']);
    expect(Object.keys(s.appState).sort()).toEqual(['scrollX', 'viewBackgroundColor', 'zoom']);
    expect(s.files.f1.dataURL).toBeUndefined();
    expect(s.files.f1.url).toBe('https://x/y.png');
    expect(out).not.toContain('data:image');
  });

  it('round-trips through parse', () => {
    const str = serializeScene({ elements: [el()], appState: { gridSize: 20 }, filesMeta: {}, look: 'sketch' });
    const back = parseScene(str);
    expect(back.look).toBe('sketch');
    expect(back.appState.gridSize).toBe(20);
    expect(back.elements[0].id).toBe('e1');
  });

  it('look defaults: clean is straight and sans, sketch is rough and hand-drawn', () => {
    const clean = lookDefaults('clean');
    const sketch = lookDefaults('sketch');
    expect(clean.currentItemRoughness).toBe(0);
    expect(sketch.currentItemRoughness).toBe(1);
    expect(clean.currentItemFontFamily).not.toBe(sketch.currentItemFontFamily);
    expect(clean.currentItemStrokeColor).toBe('#1c2420');
    expect(lookDefaults('nonsense')).toEqual(clean);
  });

  it('applyLook rewrites roughness on shapes and the font on text, bumping versions, leaving other fields alone', () => {
    const text = el({ id: 't', type: 'text', fontFamily: 5, roughness: 1 });
    const shape = el({ id: 's', roughness: 1, strokeColor: '#b91c1c' });
    const out = applyLook([text, shape], 'clean');
    expect(out).toHaveLength(2);
    expect(out[0].fontFamily).toBe(lookDefaults('clean').currentItemFontFamily);
    expect(out[0].roughness).toBe(0);
    expect(out[1].roughness).toBe(0);
    expect(out[1].strokeColor).toBe('#b91c1c');
    expect(out[1].version).toBe(2);
    expect(out[1].versionNonce).not.toBe(shape.versionNonce);
    expect(out[1]).not.toBe(shape);                     // new objects, the engine re-renders them
    // sketch puts the hand font and roughness back
    const back = applyLook(out, 'sketch');
    expect(back[0].fontFamily).toBe(lookDefaults('sketch').currentItemFontFamily);
    expect(back[1].roughness).toBe(1);
    // an element already in the look is returned as the same object (no needless re-render)
    const same = applyLook(back, 'sketch');
    expect(same[1]).toBe(back[1]);
  });

  it('never keeps a data: URL as a file (images live in the bucket)', () => {
    const out = JSON.parse(serializeScene({ elements: [], appState: {}, look: 'clean', filesMeta: {
      ok: { id: 'ok', mimeType: 'image/png', url: 'https://api/files/view?u=x', created: 1 },
      inl: { id: 'inl', mimeType: 'image/png', url: 'data:image/png;base64,AAAA', created: 1 },
      sp: { id: 'sp', mimeType: 'image/png', url: '  DATA:image/png;base64,AAAA', created: 1 },
    } }));
    expect(Object.keys(out.files)).toEqual(['ok']);
    const parsed = parseScene(JSON.stringify({ type: 'nexus-board', elements: [], files: { inl: { id: 'inl', url: 'data:image/png;base64,AA' } } }));
    expect(parsed.files).toEqual({});
  });

  // ── compact: the scene guard before a save (Neil, 11/02/2026) ───────────
  it('compact drops deleted elements older than the last save and keeps the rest', () => {
    const savedAt = Date.now() - 60_000;      // inside buildScene's 24 h carry window
    const scene = buildScene({
      elements: [
        el({ id: 'live', updated: 10 }),
        el({ id: 'oldGone', isDeleted: true, updated: savedAt - 1 }),
        el({ id: 'atSave', isDeleted: true, updated: savedAt }),
        el({ id: 'newGone', isDeleted: true, updated: savedAt + 5 }),
      ],
      appState: {}, filesMeta: {}, look: 'clean',
    });
    const out = compact(scene, { savedAt });
    expect(out.elements.map((e) => e.id)).toEqual(['live', 'atSave', 'newGone']);
    // untouched input, same shape on disk
    expect(scene.elements).toHaveLength(4);
    expect(out.type).toBe(SCENE_TYPE);
    expect(Object.keys(out)).toEqual(Object.keys(scene));
  });

  it('compact drops files no element references, keeping those a kept element (live or still-carried deleted) points at', () => {
    const f = (id) => ({ id, mimeType: 'image/png', url: `https://api/files/view?u=${id}`, created: 1 });
    const now = Date.now();
    const scene = buildScene({
      elements: [
        el({ id: 'img1', type: 'image', fileId: 'a', updated: now - 90_000 }),
        el({ id: 'img2', type: 'image', fileId: 'b', isDeleted: true, updated: now - 10_000 }),
        el({ id: 'img3', type: 'image', fileId: 'c', isDeleted: true, updated: now - 90_000 }),
      ],
      appState: {}, filesMeta: { a: f('a'), b: f('b'), c: f('c'), orphan: f('orphan') }, look: 'clean',
    });
    const out = compact(scene, { savedAt: now - 60_000 });
    expect(out.elements.map((e) => e.id)).toEqual(['img1', 'img2']);
    expect(Object.keys(out.files).sort()).toEqual(['a', 'b']);
  });

  it('compact with no save yet keeps every deleted element; a scene that is not a scene comes back as is', () => {
    const scene = buildScene({ elements: [el({ id: 'gone', isDeleted: true, updated: Date.now() - 5 })], appState: {}, filesMeta: {}, look: 'clean' });
    expect(compact(scene).elements).toHaveLength(1);
    expect(compact(scene, { savedAt: 0 }).elements).toHaveLength(1);
    expect(compact(null)).toBeNull();
  });

  it('serializeScene is buildScene as JSON', () => {
    const input = { elements: [el()], appState: { gridSize: 20 }, filesMeta: {}, look: 'sketch' };
    expect(serializeScene(input)).toBe(JSON.stringify(buildScene(input)));
  });
});
