// Nexus Status - a Cloudflare Worker, deliberately OUTSIDE Nexus (Sagar, Oct
// 27 2026): it keeps checking, alerting and showing the page while Nexus is
// down. See status/README.md.
//
//   cron, every minute  -> monitor.tick: check, update state, incidents, alerts
//   GET /               -> the status page
//   GET /api/status     -> the same as JSON
//   GET /health         -> this Worker is alive
//   POST /api/incidents                 (team only) post an incident or maintenance
//   POST /api/incidents/:id/updates     (team only) add an update / resolve it
//
// "Team only" = Authorization: Bearer <ADMIN_TOKEN secret>.
import { tick } from './monitor.js';
import { notify } from './alerts.js';
import { d1Store } from './store.js';
import { buildStatus, renderPage } from './page.js';
import { COMPONENTS } from './components.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Constant-time compare, so the token cannot be guessed a character at a time.
export function sameToken(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

const IMPACTS = new Set(['minor', 'major', 'maintenance']);
const STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved', 'scheduled']);
const KEYS = new Set(COMPONENTS.map((c) => c.key));

export async function handleAdmin(request, env, store, url, now = new Date()) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!sameToken(token, env.ADMIN_TOKEN)) return json({ detail: 'Not allowed' }, 401);
  const body = await request.json().catch(() => null);
  if (!body) return json({ detail: 'Send JSON' }, 400);
  const at = now.toISOString();

  const upd = url.pathname.match(/^\/api\/incidents\/(\d+)\/updates$/);
  if (upd) {
    const id = Number(upd[1]);
    if (!(await store.getIncident(id))) return json({ detail: 'No such incident' }, 404);
    if (!STATUSES.has(body.status) || !String(body.message || '').trim()) return json({ detail: 'status and message are required' }, 400);
    await store.addUpdate(id, body.status, String(body.message).trim().slice(0, 2000), at);
    return json({ ok: true, id });
  }
  if (url.pathname === '/api/incidents') {
    const title = String(body.title || '').trim().slice(0, 200);
    const impact = body.impact || 'major';
    const components = (body.components || []).filter((k) => KEYS.has(k));
    const message = String(body.message || '').trim().slice(0, 2000);
    if (!title || !IMPACTS.has(impact) || !message) return json({ detail: 'title, impact and message are required' }, 400);
    const status = impact === 'maintenance' ? 'scheduled' : (STATUSES.has(body.status) ? body.status : 'investigating');
    const id = await store.openIncident({
      title, impact, status, components, auto: false, createdAt: at,
      startsAt: body.startsAt || (impact === 'maintenance' ? at : null), endsAt: body.endsAt || null,
    });
    await store.addUpdate(id, status, message, at);
    return json({ ok: true, id }, 201);
  }
  return json({ detail: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = d1Store(env.DB);
    if (request.method === 'POST' && url.pathname.startsWith('/api/incidents')) return handleAdmin(request, env, store, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ detail: 'Method not allowed' }, 405);
    if (url.pathname === '/health') return json({ status: 'ok' });
    if (url.pathname === '/api/status') return json(await buildStatus(store));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderPage(await buildStatus(store)), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' },
      });
    }
    return json({ detail: 'Not found' }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick({ env, store: d1Store(env.DB), notify }));
  },
};
