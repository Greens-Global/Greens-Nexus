// Cloudflare Worker: same-site /api proxy for the BFF migration.
//
// WHY: the BFF session cookie must be FIRST-PARTY. The app lives on
// nexus.greensglobal.com (Cloudflare Pages) and the backend on
// *.azurewebsites.net - different domains, so a backend-set cookie would be a
// blocked third-party cookie. This Worker serves the API from the app's OWN
// origin: it forwards {app-domain}/api/*  ->  {Azure backend}/*  (stripping the
// /api prefix), so the cookie the backend sets is scoped to the app domain.
// This is THE prerequisite for BFF - see docs/BFF-Migration-Plan.md.
//
// It proxies EVERYTHING under /api/* (not just /auth/*), so once the frontend
// switches to same-origin calls (VITE_API_BASE = "/api"), every backend route
// works through here too.
//
// DEPLOY (you):
//   1. wrangler.toml:
//        name = "nexus-api-proxy"
//        main = "api-proxy.worker.js"
//        compatibility_date = "2026-08-01"
//        # dev route (do dev FIRST). Add the prod route + a prod env later.
//        routes = [{ pattern = "dev.nexus.greensglobal.com/api/*", zone_name = "greensglobal.com" }]
//        [vars]
//        API_ORIGIN = "https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net"
//   2. `wrangler deploy`
//   3. Test: open https://<app-domain>/api/health  -> should return {"status":"ok"}
//      from the backend, served from the app's own origin. Then /api/auth/login.
//
// For PROD later: second route pattern nexus.greensglobal.com/api/* with
// API_ORIGIN = the prod backend host (greens-nexus-api-ejfxdjcbevfxb2ht.westus2-01…).

// Fallback if the API_ORIGIN var isn't set (dev backend).
const DEFAULT_ORIGIN = 'https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // This Worker is routed only on /api/*, but guard anyway.
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      return new Response('Not found', { status: 404 });
    }

    const origin = (env && env.API_ORIGIN) || DEFAULT_ORIGIN;
    // Strip the /api prefix: /api/auth/callback -> /auth/callback ; /api -> /
    const backendPath = url.pathname.replace(/^\/api/, '') || '/';
    const target = origin.replace(/\/+$/, '') + backendPath + url.search;

    // Rebuild the request to the backend, preserving method, headers (Cookie
    // included), and body. redirect:'manual' so the 302 from /auth/callback is
    // handed to the BROWSER (which follows it) instead of the Worker following it
    // - that's what lets the Set-Cookie land on the browser.
    const proxied = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
      redirect: 'manual',
    });

    // Returning the fetch Response directly preserves ALL response headers,
    // including multiple Set-Cookie headers (session + csrf + login-cookie clear).
    return fetch(proxied);
  },
};
