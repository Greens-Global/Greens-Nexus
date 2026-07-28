// Cloudflare Pages Function guarding /assets/* (Jul 28).
//
// Deploy-race poison: a hashed chunk requested mid-propagation used to get the
// SPA fallback (index.html, 200) and _headers stamped that HTML immutable
// under the CHUNK's URL - bricking that browser until the URL changed (which,
// for stable vendor chunks, was never). This function turns any HTML/miss
// under /assets/* into a plain uncacheable 404 so nothing poisonous is ever
// cacheable; guard.js then recovers the tab cleanly.
//
// IMPORTANT: use context.next() to reach the static asset pipeline. The first
// version used env.ASSETS.fetch(request), which 404'd REAL assets on Pages
// (briefly broke fresh loads on dev, Jul 28 22:4x) - next() is the canonical
// Pages continuation into static serving. The 404s it returned were no-store,
// so nothing from that window was cacheable.
export async function onRequest(context) {
  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  if (res.status === 404 || type.includes("text/html")) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  return res;
}
