// Cloudflare Pages Function: same-site /api proxy for the BFF migration.
//
// Handles EVERY /api/* request on the Pages domain and forwards it to the Azure
// backend (stripping the /api prefix), so the BFF session cookie is FIRST-PARTY.
//
// Why a Pages Function instead of a standalone Worker + route: the greensglobal.com
// DNS zone lives on a DIFFERENT Cloudflare account (Craftywebbies) where we have no
// Workers permission, so a zone-level Worker Route can't be created. A Pages
// Function ships as part of THIS Pages deployment (on our own account), runs
// same-origin, and needs no Worker, no route, and no cross-account access.
// See docs/BFF-Migration-Plan.md.
//
// [[path]] is a catch-all, so this file handles /api and everything under it.
// Only /api/* hits this - all other paths are served as normal Pages static
// assets (so _headers / _redirects / the SPA fallback are untouched).

// Backend origins (Azure's randomized default hostnames - see the Asana OAuth
// setup note). Overridable per Pages project via an API_ORIGIN env var.
const DEV_ORIGIN  = 'https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net';
const PROD_ORIGIN = 'https://greens-nexus-api-ejfxdjcbevfxb2ht.westus2-01.azurewebsites.net';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Pick the backend: explicit override, else by hostname (dev.* -> dev backend).
  const origin = (env && env.API_ORIGIN)
    || (url.hostname.startsWith('dev.') ? DEV_ORIGIN : PROD_ORIGIN);

  // Strip the /api prefix: /api/auth/callback -> /auth/callback ; /api -> /
  const backendPath = url.pathname.replace(/^\/api/, '') || '/';
  const target = origin.replace(/\/+$/, '') + backendPath + url.search;

  // Rebuild the request to the backend, preserving method, headers (Cookie
  // included), and body. redirect:'manual' so the 302 from /auth/callback is
  // handed to the BROWSER (which follows it) - that's what lets the backend's
  // Set-Cookie land first-party on the browser.
  const proxied = new Request(target, {
    method: request.method,
    headers: request.headers,
    body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    redirect: 'manual',
  });

  // Return the backend response directly - preserves ALL headers, including the
  // multiple Set-Cookie headers (session + csrf + login-cookie clear).
  return fetch(proxied);
}
