// useNoteSync for a Board (11/02/2026 review fixes): a board never sends a
// body (an old draft's body: '' was refused by the server and re-sent every
// 800 ms forever), and a save the server refuses for what it carries (413
// too large, 400 not a board) is not re-sent - the field is dropped and the
// server's words come back as `problem`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ noteGet: vi.fn(), noteUpdate: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import { useNoteSync, mergeScenes, SAVE_MS } from './useNoteSync';
import { writeDraft, readDraft } from './notesModel';

const scene = (els, files = {}) => JSON.stringify({ type: 'nexus-board', version: 1, look: 'clean', appState: {}, files, elements: els });
const SERVER = scene([{ id: 'a', type: 'rectangle', version: 1 }]);
const board = (over = {}) => ({
  id: 'board_1', kind: 'board', title: 'Yard Layout', body: '', scene: SERVER, rev: 3, can: 'owner', mine: true,
  updatedBy: 'amy@greensglobal.com', trashedAt: '', ...over,
});

beforeEach(() => {
  localStorage.clear();
  apiMock.noteGet.mockReset();
  apiMock.noteUpdate.mockReset();
  apiMock.noteGet.mockResolvedValue(board());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

const tick = (ms) => act(async () => { vi.advanceTimersByTime(ms); });

describe('a board never sends a body', () => {
  it('an old draft with body "" restores the scene only', async () => {
    writeDraft('board_1', { rev: 3, title: 'Yard Layout', body: '', baseBody: '', scene: scene([{ id: 'a', type: 'rectangle', version: 1 }, { id: 'n', type: 'ellipse', version: 1 }]) });
    apiMock.noteUpdate.mockResolvedValue(board({ rev: 4 }));
    const { result } = renderHook(() => useNoteSync('board_1'));
    await waitFor(() => expect(result.current.status).toBe('dirty'));
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1));
    const sent = apiMock.noteUpdate.mock.calls[0][1];
    expect(sent).not.toHaveProperty('body');
    expect(sent).not.toHaveProperty('title');       // unchanged: not sent
    expect(JSON.parse(sent.scene).elements.map((e) => e.id)).toEqual(['a', 'n']);
    await waitFor(() => expect(result.current.status).toBe('saved'));
  });

  it('edit({ body }) on a board saves nothing, and the draft keeps no body', async () => {
    const { result } = renderHook(() => useNoteSync('board_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => { result.current.edit({ body: '' }); });
    await tick(SAVE_MS + 50);
    expect(apiMock.noteUpdate).not.toHaveBeenCalled();
    apiMock.noteUpdate.mockResolvedValue(board({ rev: 4 }));
    act(() => { result.current.edit({ scene: scene([{ id: 'a', type: 'rectangle', version: 2 }]), body: '' }); });
    const draft = readDraft('board_1');
    expect(draft).not.toHaveProperty('body');
    expect(draft).not.toHaveProperty('baseBody');
    expect(draft.scene).toContain('"version":2');
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1));
    expect(apiMock.noteUpdate.mock.calls[0][1]).not.toHaveProperty('body');
  });
});

describe('a refused board save is not re-sent', () => {
  it('413: drops the scene, says why, keeps the last good scene, sends nothing more until the next change', async () => {
    const tooBig = 'This board is too large to save - move part of it to a second board.';
    apiMock.noteUpdate.mockRejectedValueOnce(Object.assign(new Error(tooBig), { status: 413, detail: tooBig }));
    const { result } = renderHook(() => useNoteSync('board_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => { result.current.edit({ scene: scene([{ id: 'a', type: 'rectangle', version: 2 }, { id: 'huge', type: 'image', version: 1 }]) }); });
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.problem).toBe(tooBig);
    await tick(SAVE_MS * 5);
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);      // never re-sent
    // The next change goes out, and a good save clears the problem.
    apiMock.noteUpdate.mockResolvedValueOnce(board({ rev: 4 }));
    act(() => { result.current.edit({ scene: scene([{ id: 'a', type: 'rectangle', version: 3 }]) }); });
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(result.current.problem).toBe('');
  });

  it('400 on the thumbnail drops only the thumbnail; a typed title still goes out', async () => {
    apiMock.noteUpdate.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400, detail: 'A thumbnail must be in our storage' }));
    apiMock.noteUpdate.mockResolvedValueOnce(board({ rev: 4, title: 'Gate Plan' }));
    const { result } = renderHook(() => useNoteSync('board_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => { result.current.setFields({ thumbUrl: 'https://evil.example/x.png' }); });
    await waitFor(() => expect(result.current.problem).toBe('A thumbnail must be in our storage'));
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);
    act(() => { result.current.edit({ title: 'Gate Plan' }); });
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(2));
    expect(apiMock.noteUpdate.mock.calls[1][1]).toEqual({ rev: 3, title: 'Gate Plan' });
  });
});

describe('mergeScenes', () => {
  it('keeps both sides\' new shapes, the newer copy of one shape, then the lower nonce; files are the union', () => {
    const mine = scene([{ id: 'a', version: 2, versionNonce: 9, x: 1 }, { id: 'm', version: 1 }, { id: 't', version: 4, versionNonce: 1 }], { f1: { id: 'f1', url: 'u1', mimeType: 'image/png', created: 1 } });
    const theirs = scene([{ id: 'a', version: 5, x: 50 }, { id: 'o', version: 1 }, { id: 't', version: 4, versionNonce: 7 }], { f2: { id: 'f2', url: 'u2', mimeType: 'image/png', created: 1 } });
    const out = JSON.parse(mergeScenes(mine, theirs));
    expect(out.elements.map((e) => e.id).sort()).toEqual(['a', 'm', 'o', 't']);
    expect(out.elements.find((e) => e.id === 'a').x).toBe(50);
    expect(out.elements.find((e) => e.id === 't').versionNonce).toBe(1);
    expect(Object.keys(out.files).sort()).toEqual(['f1', 'f2']);
    expect(mergeScenes(mine, mine)).toBe(mine);
    expect(mergeScenes('not json', theirs)).toBe(theirs);
  });
});
