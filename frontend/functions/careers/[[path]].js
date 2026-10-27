// Cloudflare Pages Function: the public careers page for crawlers (Oct 27 2026).
//
// Nexus is a single-page app: every path serves the same empty index.html and
// React draws the page. Google can run that JavaScript, but it does so late
// and not always, and other job crawlers do not run it at all - so a
// JobPosting added by script alone is unreliable. This Function runs for
// every /careers/* request on the Pages domain and:
//
//   /careers/sitemap.xml            -> the API's sitemap of listed openings
//   /careers/<company>[/<opening>]  -> the normal app page (context.next()),
//                                      with the API's server-made <title>,
//                                      meta description, canonical link and
//                                      schema.org JobPosting JSON-LD put in its
//                                      <head>, and a plain-HTML copy of the
//                                      page in #root (React replaces it on load)
//
// The API builds and escapes all of it (backend/routers/careers.py
// /careers/page/...); nothing here composes HTML from data. If the API is
// slow or down, the visitor still gets the normal app page - never an error.
// Everything outside /careers/* is untouched (_headers, _redirects and the
// SPA fallback apply as before). Same backend choice as functions/api.

const DEV_ORIGIN  = 'https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net';
const PROD_ORIGIN = 'https://greens-nexus-api-ejfxdjcbevfxb2ht.westus2-01.azurewebsites.net';
const SEGMENT = /^[A-Za-z0-9-]{1,80}$/;
const TIMEOUT_MS = 2500;

function backend(url, env) {
  return ((env && env.API_ORIGIN) || (url.hostname.startsWith('dev.') ? DEV_ORIGIN : PROD_ORIGIN)).replace(/\/+$/, '');
}

async function fromApi(request, target) {
  // The visitor's address, as functions/api does, so the API's per-IP rate
  // limit sees the visitor and not Cloudflare.
  const headers = new Headers({ accept: 'application/json' });
  const visitor = request.headers.get('cf-connecting-ip');
  if (visitor) headers.set('X-Forwarded-For', visitor);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(target, { headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') return context.next();
  const url = new URL(request.url);
  const origin = backend(url, env);

  if (url.pathname === '/careers/sitemap.xml') {
    try {
      const r = await fromApi(request, `${origin}/careers/sitemap.xml`);
      if (r.ok) {
        return new Response(r.body, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=900' } });
      }
    } catch { /* fall through */ }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  const shell = await context.next();
  const segs = url.pathname.split('/').filter(Boolean);       // ['careers', company, opening?]
  if (segs.length < 2 || segs.length > 3 || !segs.slice(1).every((s) => SEGMENT.test(s))
      || !(shell.headers.get('content-type') || '').includes('text/html')) return shell;

  let seo = null;
  try {
    const r = await fromApi(request, `${origin}/careers/page/${segs.slice(1).map(encodeURIComponent).join('/')}`);
    if (r.ok) seo = await r.json();
  } catch { seo = null; }
  if (!seo || typeof seo.headHtml !== 'string' || typeof seo.bodyHtml !== 'string') return shell;

  const out = new HTMLRewriter()
    .on('title', { element(el) { if (seo.title) el.setInnerContent(String(seo.title)); } })
    .on('head', { element(el) { el.append(seo.headHtml, { html: true }); } })
    .on('div#root', { element(el) { el.setInnerContent(seo.bodyHtml, { html: true }); } })
    .transform(shell);
  // A page that names live openings must not sit in a cache for long.
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.delete('etag');            // the app shell's tag: a 304 on it would bring back an old copy
  headers.delete('content-length');
  return new Response(out.body, { status: out.status, headers });
}
