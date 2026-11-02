import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeTaskFile, viewerBlob } = vi.hoisted(() => ({ storeTaskFile: vi.fn(), viewerBlob: vi.fn() }));
vi.mock('../../tasks/lib', () => ({ storeTaskFile }));
vi.mock('../../api', () => ({ api: { viewerBlob } }));

import { uploadBoardFile, loadBoardFiles, boardFileId } from './files';

const png = (bytes = [137, 80, 78, 71]) => new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' });

describe('board files', () => {
  beforeEach(() => { storeTaskFile.mockReset(); viewerBlob.mockReset(); });

  it('derives the same id for the same bytes and a different one for different bytes', async () => {
    const a = await boardFileId(png());
    const b = await boardFileId(png());
    const c = await boardFileId(png([1, 2, 3]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-z0-9]{8,64}$/i);
  });

  it('uploads under notes/boards/<noteId>/ and returns the file meta the scene keeps', async () => {
    storeTaskFile.mockResolvedValue('https://api/files/view?u=https%3A%2F%2Fx.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Ftask-files%2Fnotes%2Fboards%2Fnote_1%2Fa.png');
    const meta = await uploadBoardFile('note_1', png());
    expect(storeTaskFile).toHaveBeenCalledTimes(1);
    expect(storeTaskFile.mock.calls[0][2]).toBe('notes/boards/note_1');
    expect(meta.mimeType).toBe('image/png');
    expect(meta.url).toContain('notes%2Fboards%2Fnote_1');
    expect(meta.id).toBe(await boardFileId(png()));
    expect(typeof meta.created).toBe('number');
    expect(meta.dataURL).toBeUndefined();
  });

  it('refuses a file that is not an image', async () => {
    await expect(uploadBoardFile('note_1', new File(['x'], 'a.exe', { type: 'application/octet-stream' }))).rejects.toThrow(/image/i);
    expect(storeTaskFile).not.toHaveBeenCalled();
  });

  it('loads each file through the signed viewer into a data URL and skips the ones that fail', async () => {
    viewerBlob.mockImplementation(async (u) => {
      if (u.includes('bad')) throw new Error('404');
      return { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
    });
    const out = await loadBoardFiles({
      f1: { id: 'f1', mimeType: 'image/png', url: 'https://api/files/view?u=good', created: 5 },
      f2: { id: 'f2', mimeType: 'image/png', url: 'https://api/files/view?u=bad', created: 6 },
    });
    expect(Object.keys(out)).toEqual(['f1']);
    expect(out.f1.id).toBe('f1');
    expect(out.f1.mimeType).toBe('image/png');
    expect(out.f1.created).toBe(5);
    expect(out.f1.dataURL).toMatch(/^data:image\/png;base64,/);
    expect(viewerBlob).toHaveBeenCalledTimes(2);
  });

  it('returns an empty map for nothing', async () => {
    expect(await loadBoardFiles(undefined)).toEqual({});
    expect(await loadBoardFiles({})).toEqual({});
  });
});
