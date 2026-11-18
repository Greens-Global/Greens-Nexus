// The speech-model Function (functions/ml/[[path]].js, Meeting Notes Phase 3):
// only the listed runtime files and model files, runtime code checked against
// its pinned SHA-256 before it is served, never an open proxy.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolvePath, fetchRuntime, fetchModelFile, onRequest, MODELS } from '../../../../functions/ml/[[path]].js';

const PIN = '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb';
const hexToBuf = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16))).buffer;

describe('speech model Function', () => {
  it('serves only the pinned runtime and the listed model files', () => {
    expect(resolvePath('/ml/rt/transformers.min.js')).toEqual({ kind: 'rt', file: 'transformers.min.js' });
    expect(resolvePath('/ml/rt/ort-wasm-simd-threaded.asyncify.wasm')?.kind).toBe('rt');
    expect(resolvePath('/ml/rt/evil.js')).toBeNull();
    const hf = resolvePath('/ml/hf/Xenova/whisper-base.en/resolve/main/onnx/encoder_model_quantized.onnx');
    expect(hf).toEqual({ kind: 'hf', url: 'https://huggingface.co/Xenova/whisper-base.en/resolve/main/onnx/encoder_model_quantized.onnx', type: 'application/octet-stream' });
    expect(resolvePath('/ml/hf/Xenova/whisper-tiny.en/resolve/main/config.json')?.type).toContain('application/json');
    expect(MODELS).toEqual(['Xenova/whisper-tiny.en', 'Xenova/whisper-base.en']);
    for (const p of [
      '/ml/hf/someone/else/resolve/main/config.json',                         // not our model
      '/ml/hf/Xenova/whisper-base.en/resolve/main/onnx/model.onnx',           // not a listed file
      '/ml/hf/Xenova/whisper-base.en/resolve/../../x/resolve/main/config.json',
      '/ml/hf/Xenova/whisper-base.en/resolve/ma%20in/config.json',            // odd revision
      '/ml/other',
    ]) expect(resolvePath(p)).toBeNull();
  });

  it('refuses runtime code that does not match its pinned checksum', async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    // A stand-in digest: Node's own WebCrypto (CI runs Node 24) refuses a buffer
    // made in the test environment's other realm; Workers have one realm.
    const subtle = { digest: vi.fn(async (alg, data) => { expect(alg).toBe('SHA-256'); expect(data).toBeInstanceOf(Uint8Array); const h = createHash('sha256').update(Buffer.from(data)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.length); }) };
    const r = await fetchRuntime('transformers.min.js', f, subtle);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('checksum');
    expect(f).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js');
  });

  it('serves runtime code that matches, immutable for a year', async () => {
    const f = vi.fn(async () => new Response('code'));
    const subtle = { digest: vi.fn(async () => hexToBuf(PIN)) };
    const r = await fetchRuntime('transformers.min.js', f, subtle);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(await r.text()).toBe('code');
  });

  it('passes a missing model file through as a 404 and an upstream failure as a 502', async () => {
    const target = resolvePath('/ml/hf/Xenova/whisper-tiny.en/resolve/main/processor_config.json');
    expect((await fetchModelFile(target, async () => new Response('x', { status: 404 }))).status).toBe(404);
    expect((await fetchModelFile(target, async () => new Response('x', { status: 500 }))).status).toBe(502);
    expect((await fetchModelFile(target, async () => new Response('{"a":1}'))).status).toBe(200);
  });

  it('answers anything else with a plain 404, and never a write', async () => {
    const res = await onRequest({ request: new Request('https://nexus.example/ml/hf/x/y/resolve/main/config.json'), env: {} });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const post = await onRequest({ request: new Request('https://nexus.example/ml/rt/transformers.min.js', { method: 'POST' }), env: {} });
    expect(post.status).toBe(404);
  });
});
