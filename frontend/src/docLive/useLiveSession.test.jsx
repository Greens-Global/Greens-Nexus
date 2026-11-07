// A live save that lost the race merges the newer saved state and sends again
// - nobody's edit is dropped (useLiveSession.save).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';

const apiMock = vi.hoisted(() => ({
  documentCollab: vi.fn(), documentCollabSeed: vi.fn(), documentCollabReset: vi.fn(),
  documentHead: vi.fn(), updateDocument: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/supabase', () => ({ supabase: null }));

import { useLiveSession } from './useLiveSession';
import { toB64 } from '../notes/collabCrypto';

const seed = () => { const d = new Y.Doc(); d.getMap('cells').set('a', 1); return d; };

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.documentCollab.mockResolvedValue({ key: 'k', channel: 'c', keyTag: 't', ydoc: '', yepoch: '', rev: 1, content: {} });
  apiMock.documentCollabSeed.mockResolvedValue({});
});

describe('useLiveSession', () => {
  it('seeds, then merges a colleague\'s newer save on 409 and resends', async () => {
    const { result } = renderHook(() => useLiveSession({ docId: 'd1', enabled: true, me: 'a@x.com', name: 'A', seed, validate: () => {} }));
    await waitFor(() => expect(result.current.doc).toBeTruthy());
    expect(result.current.status).toBe('saves');

    // The colleague's state: the seeded one plus their own cell.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(result.current.doc));
    theirs.getMap('cells').set('b', 2);
    result.current.doc.getMap('cells').set('c', 3);

    apiMock.updateDocument
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, detail: { collab: { ydoc: toB64(Y.encodeStateAsUpdate(theirs)), rev: 2 } } }))
      .mockResolvedValueOnce({ currentVersion: 3 });
    await act(async () => { await result.current.save((doc) => doc.getMap('cells').toJSON()); });

    const second = apiMock.updateDocument.mock.calls[1][1];
    expect(second.rev).toBe(2);
    expect(second.content).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('restarts when the server dropped the live state', async () => {
    const { result } = renderHook(() => useLiveSession({ docId: 'd1', enabled: true, me: 'a@x.com', name: 'A', seed, validate: () => {} }));
    await waitFor(() => expect(result.current.doc).toBeTruthy());
    apiMock.updateDocument.mockRejectedValueOnce(Object.assign(new Error('reload'), { status: 409, detail: { epoch: true, collab: {} } }));
    await act(async () => { await expect(result.current.save(() => ({}))).rejects.toThrow(); });
    await waitFor(() => expect(apiMock.documentCollab).toHaveBeenCalledTimes(2));
  });
});
