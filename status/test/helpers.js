// An in-memory store with the same calls as d1Store, and a fake fetch that
// answers like Nexus does - healthy, or broken in a chosen way.

export function memoryStore() {
  const states = {};
  const daily = {};
  const incidents = [];
  const updates = [];
  return {
    states, daily, incidents, updates,
    async loadStates() { return JSON.parse(JSON.stringify(states)); },
    async saveState(key, s) { states[key] = { ...s }; },
    async recordDay(day, key, observed) {
      const r = (daily[`${day}|${key}`] ||= { day, key, total: 0, down: 0, degraded: 0 });
      r.total += 1; if (observed === 'down') r.down += 1; if (observed === 'degraded') r.degraded += 1;
    },
    async loadDays(firstDay) { return Object.values(daily).filter((r) => r.day >= firstDay); },
    async openIncident(inc) {
      const id = incidents.length + 1;
      incidents.push({ id, title: inc.title, impact: inc.impact, status: inc.status, components: (inc.components || []).join(','),
        auto: inc.auto ? 1 : 0, created_at: inc.createdAt, resolved_at: null, starts_at: inc.startsAt || null, ends_at: inc.endsAt || null });
      return id;
    },
    async addUpdate(id, status, message, at) {
      updates.push({ id: updates.length + 1, incident_id: id, status, message, created_at: at });
      const i = incidents.find((x) => x.id === id);
      i.status = status; if (status === 'resolved') i.resolved_at = at;
    },
    async openAutoIncidentFor(key) {
      return [...incidents].reverse().find((i) => i.auto && i.status !== 'resolved' && i.components.split(',').includes(key)) || null;
    },
    async getIncident(id) { return incidents.find((i) => i.id === id) || null; },
    async listIncidents(sinceIso) {
      return incidents.filter((i) => i.created_at >= sinceIso || i.status !== 'resolved')
        .map((i) => ({ ...i, updates: updates.filter((u) => u.incident_id === i.id).reverse() })).reverse();
    },
    async maintenanceNow(nowIso) {
      const keys = new Set();
      for (const i of incidents) {
        if (i.impact === 'maintenance' && i.status !== 'resolved' && i.starts_at <= nowIso && (!i.ends_at || i.ends_at >= nowIso)) {
          for (const k of i.components.split(',')) if (k) keys.add(k);
        }
      }
      return keys;
    },
    async pruneDays() {},
  };
}

export const ENV = { NEXUS_WEB_URL: 'https://nexus.example.com/', NEXUS_API_URL: 'https://api.example.com', STATUS_PAGE_URL: 'https://status.example.com' };

const HEALTHY_COMPONENTS = {
  overall: 'operational',
  components: Object.fromEntries(['database', 'storage', 'microsoft365', 'backgroundJobs', 'schema']
    .map((k) => [k, { status: 'operational', note: '' }])),
};

// broken: { web: 'down' | 'html-script', api: 'down', components: {key: status} }
export function fakeNexus(broken = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith('https://teams') || u.startsWith('https://hook')) return new Response('', { status: 202 });
    if (u === ENV.NEXUS_WEB_URL) {
      if (broken.web === 'down') throw new TypeError('fetch failed');
      return new Response('<html><script type="module" src="/assets/index-abc123.js"></script></html>', { headers: { 'content-type': 'text/html' } });
    }
    if (u.includes('/assets/index-abc123.js')) {
      return broken.web === 'html-script'
        ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
        : new Response('export {}', { headers: { 'content-type': 'text/javascript' } });
    }
    if (u === `${ENV.NEXUS_API_URL}/health`) {
      if (broken.api === 'down') return new Response('Bad Gateway', { status: 502 });
      return Response.json({ status: 'ok' });
    }
    if (u === `${ENV.NEXUS_API_URL}/health/components`) {
      const body = JSON.parse(JSON.stringify(HEALTHY_COMPONENTS));
      for (const [k, s] of Object.entries(broken.components || {})) body.components[k] = { status: s, note: s === 'down' ? 'Not reachable' : '' };
      return Response.json(body);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

export const minutes = (start, n) => new Date(new Date(start).getTime() + n * 60000);
