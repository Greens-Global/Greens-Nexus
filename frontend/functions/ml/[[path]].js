// Cloudflare Pages Function: the speech model for Meeting Notes (Neil,
// 11/12/2026, Phase 3 - meetings outside Teams, transcribed on the device).
//
// Whisper runs INSIDE the person's browser (frontend/src/notes/meetings/
// capture/): the audio never leaves their computer or phone, nothing is
// paid for, and no AI key is involved. The browser still has to download
// the speech runtime and the model once, and the CSP is self-only - so this
// Function serves them from OUR address and Cloudflare's edge keeps them:
//
//   /ml/rt/<file>   the runtime: transformers.js and the ONNX Runtime web
//                   build it embeds, from the npm packages on jsDelivr at
//                   EXACT versions, each checked against the SHA-256 taken
//                   from the npm tarball (RUNTIME below) before it is served
//                   or cached. Code that runs on our origin is never served
//                   unchecked.
//   /ml/hf/<model>/resolve/<rev>/<file>
//                   the model files, from Hugging Face's own repositories,
//                   only the models and files listed in MODELS (English
//                   Whisper, int8). Plain weights and settings, fetched over
//                   HTTPS from the publisher.
//
// Anything else is a 404 - never the SPA fallback, never an open proxy.
// Everything served is immutable and cached for a year at the edge and in
// the browser, so a person downloads the model once per device and the
// edge fetches it from the publisher once.

const RUNTIME = {
  'transformers.min.js': {
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js',
    sha256: '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb',
    type: 'text/javascript; charset=utf-8',
  },
  'ort-wasm-simd-threaded.asyncify.mjs': {
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs',
    sha256: '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611',
    type: 'text/javascript; charset=utf-8',
  },
  'ort-wasm-simd-threaded.asyncify.wasm': {
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm',
    sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082',
    type: 'application/wasm',
  },
};

// The models the screen may load, and the only files of theirs it asks for.
export const MODELS = ['Xenova/whisper-tiny.en', 'Xenova/whisper-base.en'];
export const MODEL_FILES = [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'processor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'added_tokens.json', 'special_tokens_map.json',
  'normalizer.json', 'vocab.json', 'merges.txt',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];
const REVISION = /^[A-Za-z0-9._-]{1,64}$/;
const YEAR = 'public, max-age=31536000, immutable';

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
const bad = (msg) => new Response(msg, { status: 502, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** What a path asks for: { kind: 'rt', file } | { kind: 'hf', url, type } | null. */
export function resolvePath(pathname) {
  const rt = /^\/ml\/rt\/([^/]+)$/.exec(pathname);
  if (rt) return RUNTIME[rt[1]] ? { kind: 'rt', file: rt[1] } : null;
  const hf = /^\/ml\/hf\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(pathname);
  if (!hf) return null;
  const [, model, revision, file] = hf;
  if (!MODELS.includes(model) || !REVISION.test(revision) || !MODEL_FILES.includes(file)) return null;
  const type = file.endsWith('.json') ? 'application/json; charset=utf-8'
    : file.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  return { kind: 'hf', url: `https://huggingface.co/${model}/resolve/${revision}/${file}`, type };
}

function served(body, type, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': YEAR, 'x-content-type-options': 'nosniff', ...extra },
  });
}

/** Fetch a runtime file and check its SHA-256 before anything is served or cached. */
export async function fetchRuntime(file, fetchImpl = fetch, subtle = crypto.subtle) {
  const spec = RUNTIME[file];
  const r = await fetchImpl(spec.url);
  if (!r.ok) return bad(`Could not fetch the speech runtime (${r.status})`);
  const buf = await r.arrayBuffer();
  if (hex(await subtle.digest('SHA-256', buf)) !== spec.sha256) return bad('The speech runtime did not match its checksum');
  return served(buf, spec.type);
}

export async function fetchModelFile(target, fetchImpl = fetch) {
  const r = await fetchImpl(target.url, { redirect: 'follow' });
  if (r.status === 404) return notFound();
  if (!r.ok) return bad(`Could not fetch the speech model (${r.status})`);
  return served(r.body, target.type);
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  const url = new URL(request.url);
  const target = resolvePath(url.pathname);
  if (!target) return notFound();

  // The edge copy first: one fetch from the publisher per edge, ever.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(url.origin + url.pathname, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit;
  }
  let res;
  try {
    res = target.kind === 'rt' ? await fetchRuntime(target.file) : await fetchModelFile(target);
  } catch {
    return bad('The speech model could not be reached - try again');
  }
  if (res.status === 200 && cache) {
    const copy = res.clone();
    if (context.waitUntil) context.waitUntil(cache.put(key, copy)); else await cache.put(key, copy);
  }
  return request.method === 'HEAD' ? new Response(null, res) : res;
}
