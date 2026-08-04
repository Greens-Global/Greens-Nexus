// Cloudflare Worker: R2 fallback for immutable build assets.
//
// PROBLEM IT SOLVES: during/after a deploy, a browser still running the PREVIOUS
// index.html requests its old hashed chunks (e.g. /assets/index-nx2-ABC123.js).
// Cloudflare Pages only serves the LATEST deploy, so those old hashes 404 ->
// ChunkLoadError. The app already self-heals (ViewErrorBoundary reloads), but that
// reload is only seamless if the old chunk can still be fetched. This Worker makes
// it so: on a 404 for /assets/*, it serves the archived copy from R2 (uploaded by
// the CI "Archive assets to R2" step), so the old client keeps working with NO
// reload, and the reload path becomes the rare last resort instead of the norm.
//
// DEPLOY (you - needs Cloudflare + R2 access):
//   1. Confirm the CI archive-assets workflow uploads built /assets/* into an R2
//      bucket. Note the exact key layout (see KEY MAPPING below) and bucket name.
//   2. wrangler.toml:
//        name = "nexus-asset-fallback"
//        main = "r2-asset-fallback.worker.js"
//        compatibility_date = "2026-08-01"
//        [[r2_buckets]]
//        binding = "ASSET_ARCHIVE"
//        bucket_name = "<your-r2-assets-bucket>"
//   3. Route it on BOTH zones (dev + prod) for the asset path only:
//        nexus.greensglobal.com/assets/*   and the dev host/assets/*
//      (Route only /assets/* so the Worker never touches HTML, the API, or auth.)
//   4. `wrangler deploy`. Verify: request a KNOWN-OLD chunk hash -> 200 with the
//      `X-Asset-Source: r2-fallback` header (below); a current chunk -> normal
//      origin 200 (no header); a truly-unknown path -> 404 (unchanged).
//
// KEY MAPPING: this assumes the R2 object key is the path WITHOUT the leading
// slash (e.g. request `/assets/index-nx2-ABC.js` -> R2 key `assets/index-nx2-ABC.js`).
// If the CI step archives under a different prefix, adjust `r2Key` to match - a
// mismatch just means the fallback never hits (safe: you keep the plain 404).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Guard ONLY immutable, content-hashed build assets. Everything else (HTML,
    // /api/*, /version.json, unhashed public files) passes straight through.
    if (request.method !== 'GET' || !url.pathname.startsWith('/assets/')) {
      return fetch(request);
    }

    // Live deploy (Cloudflare Pages) is the source of truth; try it first.
    const originResp = await fetch(request);
    if (originResp.status !== 404) return originResp;

    // 404 on the live deploy -> this is almost certainly an OLD chunk removed by a
    // newer deploy. Serve the archived copy from R2 so the old client keeps running.
    const r2Key = url.pathname.replace(/^\//, ''); // "/assets/x" -> "assets/x"
    let obj = null;
    try {
      obj = await env.ASSET_ARCHIVE.get(r2Key);
    } catch {
      return originResp; // R2 hiccup -> fall back to the original 404, never throw
    }
    if (!obj) return originResp; // genuinely unknown asset -> keep the 404

    const headers = new Headers();
    obj.writeHttpMetadata(headers); // content-type etc. from the archived object
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('X-Asset-Source', 'r2-fallback'); // so you can see fallbacks in logs
    return new Response(obj.body, { status: 200, headers });
  },
};
