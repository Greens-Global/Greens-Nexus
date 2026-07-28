// Cloudflare Pages Function guarding /assets/* (Jul 28).
//
// The deploy-race poison: a hashed chunk requested mid-propagation used to get
// the SPA fallback (index.html, 200) and the _headers rule stamped that HTML
// "immutable, max-age=1y" under the CHUNK's URL - bricking that browser (and
// sometimes an edge PoP) until the next deploy changed every hash. _redirects
// cannot fix it (Pages ignores 404-status rewrite lines) and a root 404.html
// disables SPA routing for the whole app (both verified live, Jul 28).
//
// This function is the origin-side kill switch: serve the real static asset
// when it exists; if the platform hands back its HTML fallback (or a miss),
// return a plain uncacheable 404 instead. guard.js's retry then recovers the
// tab cleanly a moment later, and nothing poisonous is ever cacheable.
export async function onRequest({ request, env }) {
  const res = await env.ASSETS.fetch(request);
  const type = res.headers.get("content-type") || "";
  if (res.status === 404 || type.includes("text/html")) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  return res;
}
