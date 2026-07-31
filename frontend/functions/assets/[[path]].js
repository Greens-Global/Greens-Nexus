// Cloudflare Pages Function guarding /assets/* (Jul 28; archive fallback Jul 30).
//
// PROBLEM 1 - deploy-race poison (solved Jul 28). A hashed chunk requested
// mid-propagation used to get the SPA fallback (index.html, 200) and _headers
// stamped that HTML immutable under the CHUNK's URL - bricking that browser
// until the URL changed, which for stable vendor chunks was never. Anything
// HTML/missing under /assets/* therefore becomes a plain uncacheable 404, so
// nothing poisonous is ever cacheable.
//
// PROBLEM 2 - Pages serves exactly ONE deployment and DELETES the previous
// chunks (solved here). A tab open across a deploy holds an index.html whose
// chunks no longer exist, so the moment it lazily imports a view it has not
// loaded yet, that import 404s. guard.js and ViewErrorBoundary recover, and the
// update prompt now warns first, but all three are reactions to a broken state.
//
// The cure is that a hashed URL should NEVER stop resolving. Content-hashed
// filenames are immutable by construction: an older deployment's copy of
// vendor-react-<hash>.js is byte-identical to what that URL always meant. So
// keep every asset ever shipped in an R2 bucket and fall back to it when the
// current deployment does not have the file. Old tabs keep working, the
// propagation window stops mattering, and a rollback cannot strand anyone.
//
// Binding: R2 bucket bound as ASSETS_ARCHIVE on the Pages project. Until that
// binding exists this behaves EXACTLY as before (plain no-store 404), so it is
// safe to deploy ahead of the bucket - there is no half-configured state.
//
// IMPORTANT: use context.next() to reach the static asset pipeline. The first
// version used env.ASSETS.fetch(request), which 404'd REAL assets on Pages
// (briefly broke fresh loads on dev, Jul 28 22:4x) - next() is the canonical
// Pages continuation into static serving.

const MISS = () => new Response("Not found", {
  status: 404,
  headers: { "content-type": "text/plain", "cache-control": "no-store" },
});

export async function onRequest(context) {
  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  const servedByDeployment = res.status !== 404 && !type.includes("text/html");
  if (servedByDeployment) return res;

  const bucket = context.env && context.env.ASSETS_ARCHIVE;
  if (!bucket) return MISS();

  // Key without the leading slash: "assets/vendor-react-nx2-abc123.js".
  const key = new URL(context.request.url).pathname.replace(/^\/+/, "");
  let object;
  try {
    object = await bucket.get(key);
  } catch {
    return MISS();                       // archive unavailable - fail as before
  }
  if (!object) return MISS();

  // writeHttpMetadata restores the content-type stored at upload time. Getting
  // that wrong is not cosmetic: a JS module served as text/plain is rejected by
  // the module loader exactly like the HTML poison this function exists to stop.
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get("content-type")) return MISS();
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-nexus-asset-source", "archive");   // so the deploy gate can see it worked
  if (object.httpEtag) headers.set("etag", object.httpEtag);

  return new Response(object.body, { status: 200, headers });
}
