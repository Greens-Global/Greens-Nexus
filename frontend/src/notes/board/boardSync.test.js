// A board's shared state (Notes whiteboard, Neil 11/02/2026): the engine's
// elements in a Yjs map, two browsers converging on the newest version of
// every element, nobody's undo stack touched by the other's work.
import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { REMOTE } from '../collabTransport';
import {
  ELEMENTS, FILES, LOCAL, CAPTURE_NEVER,
  seedBoardDoc, docElements, docFiles, validateBoardDoc, reconcile, createBoardBinding,
} from './boardSync';

const el = (id, over = {}) => ({
  id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, roughness: 0,
  version: 1, versionNonce: 100, isDeleted: false, updated: 1, ...over,
});
const scene = (elements, files = {}) => ({ type: 'nexus-board', version: 1, look: 'clean', elements, appState: {}, files });

/** A fake engine: what it holds, what it was told. */
function fakeApi(elements = []) {
  let held = elements.map((e) => ({ ...e }));
  const api = {
    updateScene: vi.fn(({ elements: next }) => { if (next) held = next.map((e) => ({ ...e })); }),
    getSceneElementsIncludingDeleted: () => held,
    getAppState: () => ({ selectedElementIds: {} }),
    addFiles: vi.fn(),
  };
  return api;
}

/** Two documents joined by hand: every update made on one lands on the other as REMOTE. */
function pair() {
  const a = new Y.Doc(), b = new Y.Doc();
  a.on('update', (u, origin) => { if (origin !== REMOTE) Y.applyUpdate(b, u, REMOTE); });
  b.on('update', (u, origin) => { if (origin !== REMOTE) Y.applyUpdate(a, u, REMOTE); });
  return [a, b];
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the shared document', () => {
  it('is seeded from a scene and reads back in order', () => {
    const doc = seedBoardDoc(scene([el('b', { index: 'a1' }), el('a', { index: 'a0' })], { f1: { id: 'f1', mimeType: 'image/png', url: 'https://x/f1.png', created: 1 } }));
    expect(doc.getMap(ELEMENTS).size).toBe(2);
    expect(docElements(doc).map((e) => e.id)).toEqual(['a', 'b']);      // by the engine's fractional index
    expect(docFiles(doc)).toEqual({ f1: { id: 'f1', mimeType: 'image/png', url: 'https://x/f1.png', created: 1 } });
    expect(() => validateBoardDoc(doc)).not.toThrow();
  });

  it('refuses a stored state that is not plain elements', () => {
    const doc = new Y.Doc();
    doc.getMap(ELEMENTS).set('x', 'not an element');
    expect(() => validateBoardDoc(doc)).toThrow();
    const doc2 = new Y.Doc();
    doc2.getMap(ELEMENTS).set('y', { id: 'y', type: 'rectangle', x: Number.NaN });
    expect(() => validateBoardDoc(doc2)).toThrow();
  });
});

describe('reconcile', () => {
  it('the newer version of an element wins; a tie goes to the lower nonce; new remote elements are appended', () => {
    const local = [el('a', { version: 2, versionNonce: 5, x: 1 }), el('b', { version: 1, versionNonce: 9, x: 1 })];
    const remote = [el('a', { version: 1, versionNonce: 1, x: 99 }), el('b', { version: 1, versionNonce: 3, x: 99 }), el('c', { version: 1, versionNonce: 1 })];
    const out = reconcile(local, remote);
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].x).toBe(1);     // local a is newer
    expect(out[1].x).toBe(99);    // same version, remote nonce 3 < local nonce 9
  });

  it('orders by the engine index when every element carries one', () => {
    const out = reconcile([el('a', { index: 'a2' })], [el('b', { index: 'a1' })]);
    expect(out.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('two browsers on one board', () => {
  it('converge, and the other side applies without capturing history', async () => {
    const [da, db] = pair();
    const apiA = fakeApi(), apiB = fakeApi();
    const ba = createBoardBinding({ doc: da, canEdit: true });
    const bb = createBoardBinding({ doc: db, canEdit: true });
    ba.attach(apiA); bb.attach(apiB);
    const r1 = el('r1');
    apiA.getSceneElementsIncludingDeleted().push(r1);
    ba.push([r1], {});
    await flush();
    expect(apiB.updateScene).toHaveBeenCalled();
    const call = apiB.updateScene.mock.calls.at(-1)[0];
    expect(call.captureUpdate).toBe(CAPTURE_NEVER);
    expect(call.elements.map((e) => e.id)).toEqual(['r1']);
    expect(apiB.updateScene.mock.calls.every((c) => c[0].captureUpdate === CAPTURE_NEVER)).toBe(true);
    // B moves it: A follows.
    const moved = { ...r1, x: 40, version: 2, versionNonce: 7 };
    bb.push([moved], {});
    await flush();
    expect(apiA.getSceneElementsIncludingDeleted()[0].x).toBe(40);
    // The echo of B's own change does not come back to B as a scene update.
    const before = apiB.updateScene.mock.calls.length;
    await flush();
    expect(apiB.updateScene.mock.calls.length).toBe(before);
    ba.detach(); bb.detach();
  });

  it('a deleted element travels as isDeleted', async () => {
    const [da, db] = pair();
    const apiA = fakeApi([el('r1')]), apiB = fakeApi([el('r1')]);
    const ba = createBoardBinding({ doc: da, canEdit: true });
    const bb = createBoardBinding({ doc: db, canEdit: true });
    ba.attach(apiA); bb.attach(apiB);
    ba.push([el('r1')], {});
    await flush();
    ba.push([el('r1', { isDeleted: true, version: 2, versionNonce: 3 })], {});
    await flush();
    expect(apiB.getSceneElementsIncludingDeleted()[0].isDeleted).toBe(true);
    ba.detach(); bb.detach();
  });

  it('two edits of the same element at the same version settle on the lower nonce, both sides', async () => {
    const [da, db] = pair();
    const apiA = fakeApi([el('r1')]), apiB = fakeApi([el('r1')]);
    const ba = createBoardBinding({ doc: da, canEdit: true });
    const bb = createBoardBinding({ doc: db, canEdit: true });
    ba.attach(apiA); bb.attach(apiB);
    ba.push([el('r1')], {});
    await flush();
    ba.push([el('r1', { x: 11, version: 2, versionNonce: 50 })], {});
    bb.push([el('r1', { x: 22, version: 2, versionNonce: 20 })], {});
    await flush();
    await flush();
    expect(apiA.getSceneElementsIncludingDeleted()[0].x).toBe(22);
    expect(apiB.getSceneElementsIncludingDeleted()[0].x).toBe(22);
    expect(da.getMap(ELEMENTS).get('r1').x).toBe(22);
    expect(db.getMap(ELEMENTS).get('r1').x).toBe(22);
    ba.detach(); bb.detach();
  });

  it('a viewer receives but never writes', async () => {
    const [da, db] = pair();
    const apiA = fakeApi(), apiV = fakeApi();
    const ba = createBoardBinding({ doc: da, canEdit: true });
    const bv = createBoardBinding({ doc: db, canEdit: false });
    ba.attach(apiA); bv.attach(apiV);
    const localWrites = vi.fn();
    db.on('update', (_u, origin) => { if (origin === LOCAL) localWrites(); });
    bv.push([el('mine')], {});
    ba.push([el('r1')], {});
    await flush();
    expect(localWrites).not.toHaveBeenCalled();
    expect(db.getMap(ELEMENTS).has('mine')).toBe(false);
    expect(apiV.getSceneElementsIncludingDeleted().map((e) => e.id)).toEqual(['r1']);
    ba.detach(); bv.detach();
  });

  it('a new image file arriving from the other side is handed to the caller once', async () => {
    const [da, db] = pair();
    const apiA = fakeApi(), apiB = fakeApi();
    const onRemoteFiles = vi.fn();
    const ba = createBoardBinding({ doc: da, canEdit: true });
    const bb = createBoardBinding({ doc: db, canEdit: true });
    ba.attach(apiA); bb.attach(apiB, { onRemoteFiles });
    const meta = { id: 'f1', mimeType: 'image/png', url: 'https://x/f1.png', created: 1 };
    ba.push([], { f1: meta });
    await flush();
    ba.push([], { f1: meta });     // again: nothing new
    await flush();
    expect(onRemoteFiles).toHaveBeenCalledTimes(1);
    expect(onRemoteFiles.mock.calls[0][0]).toEqual({ f1: meta });
    ba.detach(); bb.detach();
  });

  it('attaching to a document that already has elements puts them on the engine, and the engine\'s newer ones into the document', async () => {
    const doc = seedBoardDoc(scene([el('old', { x: 1 })]));
    const api = fakeApi([el('old', { x: 5, version: 3, versionNonce: 1 }), el('local')]);
    const b = createBoardBinding({ doc, canEdit: true });
    b.attach(api);
    await flush();
    expect(doc.getMap(ELEMENTS).get('old').x).toBe(5);
    expect(doc.getMap(ELEMENTS).has('local')).toBe(true);
    expect(api.getSceneElementsIncludingDeleted().map((e) => e.id).sort()).toEqual(['local', 'old']);
    b.detach();
  });
});

describe('files map', () => {
  it('FILES holds the meta the scene keeps', () => {
    const doc = seedBoardDoc(scene([], { f: { id: 'f', mimeType: 'image/png', url: 'u', created: 1 } }));
    expect(doc.getMap(FILES).get('f').url).toBe('u');
  });
});
