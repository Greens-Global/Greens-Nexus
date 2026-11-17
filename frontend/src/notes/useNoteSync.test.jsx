// useNoteSync when the note can no longer be saved by this person
// (11/17/2026): a save to a note in the Trash (a 409 carrying the note), to a
// share that became read only (403) or to a note that is gone (404) used to
// be re-sent forever - at once for the Trash, every 800 ms for the others,
// even after leaving the note. It is dropped once, and the screen shows where
// the note stands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ noteGet: vi.fn(), noteUpdate: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import { useNoteSync, SAVE_MS } from './useNoteSync';
import { readDraft, writeDraft } from './notesModel';

const note = (over = {}) => ({
  id: 'note_1', kind: 'note', title: 'Plan', body: '<p>one</p>', rev: 3, can: 'edit', mine: false,
  updatedBy: 'amy@greensglobal.com', trashedAt: '', ...over,
});
const refusal = (status, detail) => Object.assign(new Error(typeof detail === 'string' ? detail : detail.message), { status, detail });

beforeEach(() => {
  localStorage.clear();
  apiMock.noteGet.mockReset();
  apiMock.noteUpdate.mockReset();
  apiMock.noteGet.mockResolvedValue(note());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

const tick = (ms) => act(async () => { vi.advanceTimersByTime(ms); });
const typed = async (result) => {
  await waitFor(() => expect(result.current.status).toBe('saved'));
  act(() => { result.current.edit({ body: '<p>one</p><p>two</p>' }); });
  await tick(SAVE_MS + 50);
};

describe('a save the note can no longer take is sent once', () => {
  it('in the Trash: one save, then the server copy, read only, the draft kept on the device', async () => {
    const trashed = note({ trashedAt: '2026-11-17T18:00:00Z' });
    apiMock.noteUpdate.mockRejectedValue(refusal(409, { message: 'This note is in the Trash - restore it to edit.', note: trashed }));
    const { result } = renderHook(() => useNoteSync('note_1'));
    await typed(result);
    await waitFor(() => expect(result.current.note?.trashedAt).toBe(trashed.trashedAt));
    expect(result.current.status).toBe('saved');
    expect(result.current.conflict).toBeNull();
    await tick(SAVE_MS * 6);
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);      // never re-sent
    expect(readDraft('note_1')?.body).toContain('two');       // what was typed is not thrown away
  });

  it('in the Trash: leaving the note does not start the saves again', async () => {
    const trashed = note({ trashedAt: '2026-11-17T18:00:00Z' });
    apiMock.noteUpdate.mockRejectedValue(refusal(409, { message: 'This note is in the Trash - restore it to edit.', note: trashed }));
    const { result, unmount } = renderHook(() => useNoteSync('note_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => { result.current.edit({ body: '<p>one</p><p>two</p>' }); });
    unmount();                                               // the cleanup saves what is pending
    await tick(SAVE_MS * 6);
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);
  });

  it('a trashed note opened with a draft sends nothing', async () => {
    writeDraft('note_1', { rev: 3, title: 'Plan', body: '<p>one</p><p>two</p>', baseTitle: 'Plan', baseBody: '<p>one</p>' });
    apiMock.noteGet.mockResolvedValue(note({ trashedAt: '2026-11-17T18:00:00Z' }));
    const { result } = renderHook(() => useNoteSync('note_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    await tick(SAVE_MS * 3);
    expect(apiMock.noteUpdate).not.toHaveBeenCalled();
    expect(readDraft('note_1')?.body).toContain('two');       // waits for a restore
  });

  it('403 (the share became read only): one save, then the note is read again and shows Read Only', async () => {
    apiMock.noteUpdate.mockRejectedValue(refusal(403, 'This note was shared with you to read only'));
    const { result } = renderHook(() => useNoteSync('note_1'));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    apiMock.noteGet.mockResolvedValue(note({ can: 'read' }));
    act(() => { result.current.edit({ body: '<p>one</p><p>two</p>' }); });
    await tick(SAVE_MS + 50);
    await waitFor(() => expect(result.current.note?.can).toBe('read'));
    expect(result.current.status).toBe('saved');
    await tick(SAVE_MS * 6);
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);
    expect(apiMock.noteGet).toHaveBeenCalledTimes(2);         // the open, and the one re-read
  });

  it('404 (deleted, or no longer shared): one save, then "not available"', async () => {
    apiMock.noteUpdate.mockRejectedValue(refusal(404, 'Note not found'));
    const { result } = renderHook(() => useNoteSync('note_1'));
    await typed(result);
    await waitFor(() => expect(result.current.status).toBe('missing'));
    expect(result.current.note).toBeNull();
    await tick(SAVE_MS * 6);
    expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1);
  });

  it('a network failure still retries (unchanged)', async () => {
    apiMock.noteUpdate.mockRejectedValue(new Error('Failed to fetch'));
    const { result } = renderHook(() => useNoteSync('note_1'));
    await typed(result);
    await waitFor(() => expect(result.current.status).toBe('error'));
    await tick(SAVE_MS * 3);
    expect(apiMock.noteUpdate.mock.calls.length).toBeGreaterThan(1);
  });
});
