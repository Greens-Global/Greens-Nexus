// Live collaboration on a board (Notes whiteboard, Neil 11/02/2026): the
// first editor seeds the shared state from the saved scene, two browsers
// converge over the encrypted channel, the other side's work never enters
// this side's undo stack, a stranger on another session is ignored, a
// viewer's binding never writes, and a tab that was hidden catches up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';

const apiMock = vi.hoisted(() => ({ noteCollab: vi.fn(), noteCollabSeed: vi.fn(), noteCollabReset: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));

// One Realtime "service" for every client in a test (the same fake collab.test.jsx uses).
const hubState = vi.hoisted(() => ({ rooms: new Map() }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    channel(name) {
      const rooms = hubState.rooms;
      const ch = {
        name, handlers: [],
        on(_t, _f, fn) { this.handlers.push(fn); return this; },
        subscribe(cb) { if (!rooms.has(name)) rooms.set(name, []); rooms.get(name).push(ch); setTimeout(() => cb('SUBSCRIBED'), 0); return ch; },
        async send(msg) { (rooms.get(name) || []).filter((o) => o !== ch).forEach((o) => o.handlers.forEach((h) => h({ payload: msg.payload }))); return 'ok'; },
      };
      return ch;
    },
    // A channel closed after the next test cleared the rooms must not take a live one with it.
    removeChannel(ch) { const l = hubState.rooms.get(ch.name) || []; const i = l.indexOf(ch); if (i >= 0) l.splice(i, 1); },
  },
}));

import { useBoardCollab, collaboratorsFrom } from './useBoardCollab';
import { toB64 } from '../collabCrypto';
import * as rt from '../collabTransport';
import { ELEMENTS, CAPTURE_NEVER, seedBoardDoc } from './boardSync';

if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);

const el = (id, over = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 100, isDeleted: false, updated: 1, ...over });
const sceneOf = (elements) => JSON.stringify({ type: 'nexus-board', version: 1, look: 'clean', elements, appState: {}, files: {} });
const key = () => toB64(webcrypto.getRandomValues(new Uint8Array(32)));
const note = (over = {}) => ({ id: 'note_b1', kind: 'board', title: 'Yard', can: 'owner', mine: true, sharedWith: [{ email: 'bob@greensglobal.com', can: 'edit' }], ...over });

function fakeApi(elements = []) {
  let held = elements.map((e) => ({ ...e }));
  return {
    updateScene: vi.fn(({ elements: next }) => { if (next) held = next.map((e) => ({ ...e })); }),
    getSceneElementsIncludingDeleted: () => held,
    getAppState: () => ({ selectedElementIds: {} }),
    addFiles: vi.fn(),
  };
}

/** The server as the seeding path sees it: one stored state per board, first seed wins. */
function server(initial) {
  const st = { key: key(), channel: 'nx-note-b1', keyTag: 'k1', ydoc: '', yepoch: '', rev: 3, kind: 'board', scene: initial, title: 'Yard', body: '' };
  apiMock.noteCollab.mockImplementation(async () => ({ ...st }));
  apiMock.noteCollabSeed.mockImplementation(async (_id, d) => {
    if (st.yepoch) throw Object.assign(new Error('taken'), { status: 409, detail: { collab: { ydoc: st.ydoc, yepoch: st.yepoch, rev: st.rev } } });
    st.ydoc = d.ydoc; st.yepoch = d.yepoch;
    return { ydoc: st.ydoc, yepoch: st.yepoch, rev: st.rev };
  });
  apiMock.noteCollabReset.mockImplementation(async () => { st.ydoc = ''; st.yepoch = ''; return { ok: true }; });
  return st;
}

beforeEach(() => {
  hubState.rooms.clear();
  Object.values(apiMock).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const editor = (email, name) => renderHook(() => useBoardCollab({ note: note(), canEdit: true, enabled: true, me: email, name }));

describe('starting a board session', () => {
  it('the first editor seeds the shared state from the saved scene, with a fresh epoch', async () => {
    server(sceneOf([el('r1')]));
    const { result } = editor('neil@greensglobal.com', 'Neil');
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const sent = apiMock.noteCollabSeed.mock.calls[0][1];
    expect(sent.rev).toBe(3);
    expect(sent.yepoch).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(result.current.epoch).toBe(sent.yepoch);
    expect(rt.docFrom(sent.ydoc).getMap(ELEMENTS).get('r1')?.id).toBe('r1');
    await waitFor(() => expect(result.current.status).toBe('live'));
    expect(result.current.getHtml()).toBeNull();     // a board has no words to hand to a save
  });

  it('a second browser joins the first one\'s state instead of seeding again', async () => {
    server(sceneOf([el('r1')]));
    const a = editor('neil@greensglobal.com', 'Neil');
    await waitFor(() => expect(a.result.current.phase).toBe('ready'));
    const b = editor('bob@greensglobal.com', 'Bob');
    await waitFor(() => expect(b.result.current.phase).toBe('ready'));
    expect(b.result.current.epoch).toBe(a.result.current.epoch);
    expect(apiMock.noteCollabSeed).toHaveBeenCalledTimes(1);   // the server already had a state; the second browser loaded it
  });

  it('a stored state that is not plain elements is dropped once and rebuilt from the scene', async () => {
    const st = server(sceneOf([el('ok')]));
    const bad = new rt.Y.Doc(); bad.getMap(ELEMENTS).set('x', 'junk');
    st.ydoc = rt.encodeState(bad); st.yepoch = 'bad-epoch-01';
    const { result } = editor('neil@greensglobal.com', 'Neil');
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(apiMock.noteCollabReset).toHaveBeenCalledTimes(1);
    expect(result.current.epoch).not.toBe('bad-epoch-01');
  });

  it('off when not enabled', () => {
    const { result } = renderHook(() => useBoardCollab({ note: note(), canEdit: true, enabled: false, me: 'n', name: 'N' }));
    expect(result.current.status).toBe('off');
    expect(result.current.phase).toBe('off');
    expect(apiMock.noteCollab).not.toHaveBeenCalled();
  });
});

describe('two editors on one board', () => {
  it('converge over the channel; the other side applies without history, and sees who is here', async () => {
    server(sceneOf([]));
    const a = editor('neil@greensglobal.com', 'Neil');
    await waitFor(() => expect(a.result.current.status).toBe('live'));
    const b = editor('bob@greensglobal.com', 'Bob');
    await waitFor(() => expect(b.result.current.status).toBe('live'));
    const apiA = fakeApi(), apiB = fakeApi();
    act(() => { a.result.current.attach(apiA); b.result.current.attach(apiB); });
    // Neil draws a rectangle.
    const r1 = el('r1');
    apiA.getSceneElementsIncludingDeleted().push(r1);
    act(() => { a.result.current.onChange([r1], {}, { r1: true }); });
    await waitFor(() => expect(apiB.getSceneElementsIncludingDeleted().map((e) => e.id)).toEqual(['r1']));
    expect(apiB.updateScene.mock.calls.filter((c) => c[0].elements).every((c) => c[0].captureUpdate === CAPTURE_NEVER)).toBe(true);
    // Bob moves it; Neil follows.
    const moved = { ...r1, x: 50, version: 2, versionNonce: 7 };
    act(() => { b.result.current.onChange([moved], {}, {}); });
    await waitFor(() => expect(apiA.getSceneElementsIncludingDeleted()[0].x).toBe(50));
    // Bob deletes it; Neil's copy is marked deleted, not dropped.
    act(() => { b.result.current.onChange([{ ...moved, isDeleted: true, version: 3, versionNonce: 2 }], {}, {}); });
    await waitFor(() => expect(apiA.getSceneElementsIncludingDeleted()[0].isDeleted).toBe(true));
    // Presence: each sees the other by name, and the engine gets a collaborators map.
    await waitFor(() => expect(a.result.current.peers.map((p) => p.name)).toEqual(['Bob']));
    await waitFor(() => expect(b.result.current.peers.map((p) => p.name)).toEqual(['Neil']));
    const collabCall = apiB.updateScene.mock.calls.find((c) => c[0].collaborators);
    expect(collabCall).toBeTruthy();
    const who = [...collabCall[0].collaborators.values()].map((c) => c.username);
    expect(who).toContain('Neil');
  });

  it('the pointer and the selection travel as presence', async () => {
    server(sceneOf([]));
    const a = editor('neil@greensglobal.com', 'Neil');
    const b = editor('bob@greensglobal.com', 'Bob');
    await waitFor(() => expect(a.result.current.status).toBe('live'));
    await waitFor(() => expect(b.result.current.status).toBe('live'));
    const apiB = fakeApi();
    act(() => { b.result.current.attach(apiB); });
    act(() => {
      a.result.current.pointer({ pointer: { x: 12, y: 34, tool: 'pointer' }, button: 'down' });
      a.result.current.onChange([], {}, { s1: true });
    });
    await waitFor(() => {
      const calls = apiB.updateScene.mock.calls.filter((c) => c[0].collaborators);
      const neil = calls.length ? [...calls.at(-1)[0].collaborators.values()].find((c) => c.username === 'Neil') : null;
      expect(neil?.pointer).toEqual({ x: 12, y: 34, tool: 'pointer' });
      expect(neil?.button).toBe('down');
      expect(neil?.selectedElementIds).toEqual({ s1: true });
    });
  });

  it('a stranger on another epoch changes nothing', async () => {
    const st = server(sceneOf([]));
    const a = editor('neil@greensglobal.com', 'Neil');
    await waitFor(() => expect(a.result.current.status).toBe('live'));
    const apiA = fakeApi();
    act(() => { a.result.current.attach(apiA); });
    const { supabase } = await import('../../lib/supabase');
    const { importKey } = await import('../collabCrypto');
    const strangerDoc = seedBoardDoc({ elements: [el('intruder')], files: {} });
    const stranger = rt.connect({ supabase, channelName: st.channel, key: await importKey(st.key), noteId: 'note_b1', epoch: 'another-epoch-1', doc: strangerDoc,
      awareness: rt.newAwareness(strangerDoc, { name: 'X' }), hooks: {} });
    await new Promise((r) => setTimeout(r, 60));
    expect(apiA.getSceneElementsIncludingDeleted()).toEqual([]);
    // The hook asked the server whether a newer session exists (and it had not).
    expect(apiMock.noteCollab.mock.calls.length).toBeGreaterThanOrEqual(2);
    stranger.close();
  });

  it('a viewer\'s binding never writes a shape into the shared state', async () => {
    server(sceneOf([el('r1')]));
    const { result } = renderHook(() => useBoardCollab({ note: note({ can: 'read', mine: false }), canEdit: false, enabled: true, me: 'v@greensglobal.com', name: 'Viewer' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const apiV = fakeApi();
    act(() => { result.current.attach(apiV); });
    act(() => { result.current.onChange([el('mine')], {}, {}); });
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.docFrom(result.current.encodeState()).getMap(ELEMENTS).has('mine')).toBe(false);
    await waitFor(() => expect(apiV.getSceneElementsIncludingDeleted().map((e) => e.id)).toEqual(['r1']));
  });

  it('a hidden tab trusts nothing, and catches up when it comes back', async () => {
    server(sceneOf([]));
    const a = editor('neil@greensglobal.com', 'Neil');
    const b = editor('bob@greensglobal.com', 'Bob');
    await waitFor(() => expect(a.result.current.status).toBe('live'));
    await waitFor(() => expect(b.result.current.status).toBe('live'));
    const apiA = fakeApi(), apiB = fakeApi();
    act(() => { a.result.current.attach(apiA); b.result.current.attach(apiB); });
    let visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(b.result.current.status).toBe('stale'));
    act(() => { a.result.current.onChange([el('while-away')], {}, {}); });
    await new Promise((r) => setTimeout(r, 80));
    expect(apiB.getSceneElementsIncludingDeleted()).toEqual([]);
    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(b.result.current.status).toBe('live'));
    await waitFor(() => expect(apiB.getSceneElementsIncludingDeleted().map((e) => e.id)).toEqual(['while-away']));
    delete document.visibilityState;
  });
});

describe('collaboratorsFrom', () => {
  it('turns awareness into the engine\'s shape and leaves me out', () => {
    const doc = new rt.Y.Doc();
    const aw = rt.newAwareness(doc, { name: 'Me', color: '#000', email: 'me@x' });
    const states = new Map([
      [doc.clientID, { user: { name: 'Me' } }],
      [7, { user: { name: 'Bob', color: '#123456', email: 'bob@x' }, pointer: { x: 1, y: 2, tool: 'laser' }, button: 'down', sel: ['a', 'b'] }],
      [8, { user: { name: 'Amy', email: 'amy@x' } }],
    ]);
    aw.getStates = () => states;
    const out = collaboratorsFrom(aw, doc.clientID);
    expect([...out.keys()]).toEqual(['7', '8']);
    expect(out.get('7')).toMatchObject({ id: 'bob@x', username: 'Bob', color: { background: '#123456', stroke: '#123456' }, pointer: { x: 1, y: 2, tool: 'laser' }, button: 'down', selectedElementIds: { a: true, b: true } });
    expect(out.get('8').pointer).toBeUndefined();
    expect(out.get('8').button).toBe('up');
  });
});
