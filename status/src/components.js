// What the page lists and how each part is checked. Every check runs from
// Cloudflare, outside Nexus: the web app and API are probed directly, and the
// rest come from the API's own /health/components report
// (backend/routers/health_components.py). When the API itself is down, those
// read "unknown" - the API row carries the outage.

export const COMPONENTS = [
  { key: 'web', name: 'Nexus Web App', description: 'nexus.greensglobal.com loads and starts' },
  { key: 'api', name: 'Nexus API', description: 'The server every screen talks to' },
  { key: 'database', name: 'Database', description: 'Where every record lives' },
  { key: 'storage', name: 'File Storage', description: 'Photos, receipts and documents' },
  { key: 'microsoft365', name: 'Sign-In, Email and Teams', description: 'Microsoft 365, used to sign in and to send email and Teams messages' },
  { key: 'backgroundJobs', name: 'Reminders and Background Jobs', description: 'Reminders, digests, alerts and scheduled work' },
  { key: 'schema', name: 'Modules', description: 'Every screen can read its data' },
];

export const SLOW_MS = { web: 5000, api: 3000 };
const TIMEOUT_MS = 10000;

async function timed(fetchImpl, url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, headers: { 'user-agent': 'nexus-status/1', ...(init.headers || {}) } });
    return { res, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function slow(key, ms) { return ms > (SLOW_MS[key] || 3000); }

// The page loads AND its main script really is JavaScript - a 200 with the
// app's fallback HTML in place of the script is the white-screen outage
// (same rule as .github/workflows/uptime.yml).
export async function checkWeb(webUrl, fetchImpl) {
  try {
    const { res, ms } = await timed(fetchImpl, webUrl);
    if (res.status !== 200) return { status: 'down', note: `Page answered ${res.status}`, latencyMs: ms };
    const html = await res.text();
    const entry = (html.match(/\/assets\/index-[^"']+\.js/) || [])[0];
    if (!entry) return { status: 'down', note: 'Page has no app script', latencyMs: ms };
    const js = await timed(fetchImpl, new URL(entry, webUrl).toString());
    const type = js.res.headers.get('content-type') || '';
    if (js.res.status !== 200 || !/javascript|ecmascript/.test(type)) {
      return { status: 'down', note: 'App script does not load', latencyMs: ms };
    }
    return { status: slow('web', ms) ? 'degraded' : 'operational', note: slow('web', ms) ? 'Slow to load' : '', latencyMs: ms };
  } catch {
    return { status: 'down', note: 'Not reachable' };
  }
}

export async function checkApi(apiUrl, fetchImpl) {
  try {
    const { res, ms } = await timed(fetchImpl, `${apiUrl}/health`);
    if (res.status !== 200) return { status: 'down', note: `Answered ${res.status}`, latencyMs: ms };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok') return { status: 'down', note: 'Unexpected answer', latencyMs: ms };
    return { status: slow('api', ms) ? 'degraded' : 'operational', note: slow('api', ms) ? 'Slow to answer' : '', latencyMs: ms };
  } catch {
    return { status: 'down', note: 'Not reachable' };
  }
}

const REPORTED = ['database', 'storage', 'microsoft365', 'backgroundJobs', 'schema'];
const VALID = new Set(['operational', 'degraded', 'down', 'unknown']);

export async function checkReported(apiUrl, fetchImpl) {
  const unknown = Object.fromEntries(REPORTED.map((k) => [k, { status: 'unknown', note: 'Waiting on the API' }]));
  try {
    const { res } = await timed(fetchImpl, `${apiUrl}/health/components`);
    if (res.status !== 200) return unknown;
    const body = await res.json();
    const out = {};
    for (const k of REPORTED) {
      const c = body?.components?.[k];
      out[k] = c && VALID.has(c.status)
        ? { status: c.status, note: String(c.note || '').slice(0, 80), ...(c.latencyMs != null ? { latencyMs: c.latencyMs } : {}) }
        : { status: 'unknown', note: '' };
    }
    return out;
  } catch {
    return unknown;
  }
}

// One check of everything. A failing probe gets one quick retry inside the
// same run, so a single dropped connection is not even a failed minute.
export async function runChecks(env, fetchImpl = fetch) {
  const web = env.NEXUS_WEB_URL;
  const api = String(env.NEXUS_API_URL || '').replace(/\/+$/, '');
  const retry = async (fn) => {
    const first = await fn();
    return first.status === 'down' ? fn() : first;
  };
  const [w, a] = await Promise.all([retry(() => checkWeb(web, fetchImpl)), retry(() => checkApi(api, fetchImpl))]);
  const reported = a.status === 'down'
    ? Object.fromEntries(REPORTED.map((k) => [k, { status: 'unknown', note: 'Waiting on the API' }]))
    : await checkReported(api, fetchImpl);
  return { web: w, api: a, ...reported };
}
