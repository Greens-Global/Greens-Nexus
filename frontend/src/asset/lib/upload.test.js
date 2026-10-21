import { describe, it, expect, vi, beforeEach } from 'vitest';

// Files go to the private asset-files bucket and the record keeps a viewer URL;
// with no Supabase configured the helpers fall back to a data URL so local work
// keeps going (the server then accepts a data URL only when it has no storage either).
const state = { client: null, uploads: [] };
vi.mock('../../lib/supabase', () => ({ get supabase() { return state.client; }, supabaseUrl: 'https://proj.supabase.co' }));
vi.mock('../../lib/storageView', () => ({ toViewUrl: (u) => 'VIEW:' + u }));
vi.mock('./format.js', () => ({
  resizeImageToDataUrl: async () => 'data:image/jpeg;base64,QUJD',
  fileToDataUrl: async () => 'data:application/pdf;base64,QUJD',
}));

const fakeClient = () => ({
  storage: { from: (bucket) => ({
    upload: async (path, file, opts) => { state.uploads.push({ bucket, path, type: file.type, opts }); return { data: { path }, error: null }; },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
  }) },
});

describe('asset uploads', () => {
  beforeEach(() => { state.client = null; state.uploads = []; });

  it('stores a document in asset-files under its property and returns the viewer URL', async () => {
    const { storeAssetDocument } = await import('./upload.js');
    state.client = fakeClient();
    const { url, error } = await storeAssetDocument(new File(['x'], 'warranty.pdf', { type: 'application/pdf' }), 'gs-escondido');
    expect(error).toBeNull();
    expect(url).toMatch(/^VIEW:https:\/\/proj\.supabase\.co\/storage\/v1\/object\/public\/asset-files\/documents\/gs-escondido\/\d+-[a-z0-9]+\.pdf$/);
    expect(state.uploads[0].opts).toMatchObject({ upsert: false, cacheControl: '31536000' });
  });

  it('stores a photo as a resized JPEG in the photos folder', async () => {
    const { storeAssetImage } = await import('./upload.js');
    state.client = fakeClient();
    const url = await storeAssetImage(new File(['x'], 'front.HEIC', { type: 'image/heic' }), 'gs-escondido');
    expect(url).toMatch(/asset-files\/photos\/gs-escondido\/\d+-[a-z0-9]+\.jpg$/);
    expect(state.uploads[0].type).toBe('image/jpeg');
  });

  it('refuses a file type a record cannot hold and an oversize file', async () => {
    const { storeAssetDocument, uploadAssetFile, MAX_BYTES } = await import('./upload.js');
    state.client = fakeClient();
    expect((await storeAssetDocument(new File(['x'], 'clip.mp4', { type: 'video/mp4' }), 'a')).error).toMatch(/PDF, image/);
    const big = { name: 'big.pdf', type: 'application/pdf', size: MAX_BYTES + 1 };
    expect((await uploadAssetFile(big, { propertyId: 'a' })).error).toMatch(/limit is 25 MB/);
    expect(state.uploads).toHaveLength(0);
  });

  it('falls back to a data URL with no storage configured', async () => {
    const { storeAssetDocument, storeAssetImage } = await import('./upload.js');
    expect((await storeAssetDocument(new File(['x'], 'w.pdf', { type: 'application/pdf' }), 'a')).url).toMatch(/^data:application\/pdf/);
    expect(await storeAssetImage(new File(['x'], 'p.png', { type: 'image/png' }), 'a')).toMatch(/^data:image\/jpeg/);
  });
});
