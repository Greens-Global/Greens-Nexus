import { describe, it, expect, vi, beforeEach } from 'vitest';

// The inline fallback: with no Supabase configured, small files are stored as a
// base64 data: URL in the row itself, exactly as the Task module has always
// stored small attachments. This is what makes the construction module
// exercisable on a laptop with nothing but SQLite.
//
// supabase is mocked to null - that is the whole precondition for the branch.
vi.mock('../../lib/supabase', () => ({ supabase: null }));

import { uploadConstructionMedia, MAX_INLINE } from './upload';

const photo = (bytes = 8, name = 'site.jpg', type = 'image/jpeg') =>
  new File([new Uint8Array(bytes)], name, { type });

beforeEach(() => vi.clearAllMocks());

describe('uploadConstructionMedia with no storage configured', () => {
  it('inlines a small photo as a data URL', async () => {
    const { payload, error } = await uploadConstructionMedia(photo(), { projectId: 'p1' });
    expect(error).toBeNull();
    expect(payload.url.startsWith('data:image/jpeg')).toBe(true);
    expect(payload.kind).toBe('photo');
  });

  it('leaves storage_path empty, because no object exists', async () => {
    // A synthesized path would describe a Supabase object that was never
    // written, and send the rebuild sweep looking for it.
    const { payload } = await uploadConstructionMedia(photo(), { projectId: 'p1' });
    expect(payload.storage_path).toBe('');
  });

  it('refuses a file too large to inline, and says why', async () => {
    // Construction allows 100 MB video and base64 inflates by ~33%, so inlining
    // a clip would put tens of megabytes in one row and ship it to every client
    // that lists the log.
    const big = photo(MAX_INLINE + 1, 'clip.mp4', 'video/mp4');
    const { payload, error } = await uploadConstructionMedia(big, { projectId: 'p1' });
    expect(payload).toBeNull();
    expect(error).toMatch(/2 MB/);
    // The worker needs to know the typed half of the log still lands.
    expect(error).toMatch(/notes, crew size and hours will still save/i);
  });

  it('still enforces the normal validation rules first', async () => {
    const { payload, error } = await uploadConstructionMedia(
      photo(8, 'notes.txt', 'text/plain'), { projectId: 'p1' });
    expect(payload).toBeNull();
    expect(error).toMatch(/not supported/i);
  });

  it('reports the serving size and type, not a guess', async () => {
    const { payload } = await uploadConstructionMedia(photo(64), { projectId: 'p1' });
    expect(payload.size_bytes).toBe(64);
    expect(payload.mime_type).toBe('image/jpeg');
    expect(payload.original_name).toBe('site.jpg');
  });
});
