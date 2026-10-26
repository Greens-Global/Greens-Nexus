// The status page: what is working right now, 90 days of history per
// component, and the incidents of the last two weeks. Server-rendered HTML
// (no scripts needed), refreshed every minute. /api/status is the same data
// as JSON.
import { COMPONENTS } from './components.js';
import { dayStatus, lastDays, uptimePct, worst } from './state.js';
import { dayLabel, escapeHtml, usDate, usDateTime } from './format.js';

export const HISTORY_DAYS = 90;
const INCIDENT_DAYS = 14;

const LABEL = {
  operational: 'Operational', degraded: 'Degraded Performance', down: 'Major Outage',
  maintenance: 'Under Maintenance', unknown: 'No Data',
};
const DAY_LABEL = {
  ok: 'No downtime recorded', degraded: 'Degraded performance', partial: 'Partial outage',
  major: 'Major outage', nodata: 'No data exists for this day',
};
const INCIDENT_STATUS = {
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring',
  resolved: 'Resolved', scheduled: 'Scheduled',
};

export async function buildStatus(store, now = new Date()) {
  const at = now.toISOString();
  const days = lastDays(HISTORY_DAYS, now);
  const [states, dayRows, maintenance, incidents] = await Promise.all([
    store.loadStates(), store.loadDays(days[0]), store.maintenanceNow(at),
    store.listIncidents(new Date(now.getTime() - INCIDENT_DAYS * 86400000).toISOString()),
  ]);
  const byKey = {};
  for (const r of dayRows) (byKey[r.key] ||= {})[r.day] = r;

  const components = COMPONENTS.map((c) => {
    const s = states[c.key];
    const status = maintenance.has(c.key) ? 'maintenance' : (s ? s.status : 'unknown');
    const rows = days.map((d) => byKey[c.key]?.[d]).filter(Boolean);
    return {
      key: c.key, name: c.name, description: c.description, status, label: LABEL[status] || status,
      note: status === 'operational' ? '' : (s?.note || ''),
      since: s?.since || null, lastChecked: s?.lastChecked || null,
      uptime: uptimePct(rows),
      days: days.map((d) => ({ day: d, status: dayStatus(byKey[c.key]?.[d]) })),
    };
  });

  const down = components.filter((c) => c.status === 'down');
  // Parts with no data yet do not colour the headline; only what was checked does.
  let overall = worst(components.map((c) => c.status).filter((st) => st !== 'unknown'));
  let headline = 'All Systems Operational';
  if (down.length) {
    const core = down.some((c) => c.key === 'web' || c.key === 'api');
    headline = core ? 'Major Outage' : 'Partial Outage';
  } else if (overall === 'degraded') headline = 'Some Systems Degraded';
  else if (components.some((c) => c.status === 'maintenance')) { headline = 'Maintenance in Progress'; overall = 'maintenance'; }
  else if (components.every((c) => c.status === 'unknown')) { headline = 'Waiting for the First Checks'; overall = 'unknown'; }

  const lastChecked = components.map((c) => c.lastChecked).filter(Boolean).sort().pop() || null;
  return {
    overall, headline, lastChecked, components,
    active: incidents.filter((i) => i.status !== 'resolved'),
    incidents: incidents.filter((i) => i.status === 'resolved' || i.impact !== 'maintenance'),
    incidentDays: lastDays(INCIDENT_DAYS, now).reverse(),
  };
}

const css = `
:root{--bg:#f6f7f9;--card:#ffffff;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--ok:#16a34a;--deg:#ca8a04;--part:#ea580c;--major:#dc2626;--maint:#2563eb;--nodata:#d1d5db;--brand:#1f7a40}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--card:#121821;--ink:#e5e7eb;--muted:#9ca3af;--line:#1f2937;--nodata:#374151}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5}
.wrap{max-width:880px;margin:0 auto;padding:28px 16px 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}
.brand{font-weight:800;letter-spacing:.14em;color:var(--brand);font-size:13px}.title{font-size:22px;font-weight:800;margin:2px 0 0}
.banner{border-radius:12px;padding:16px 18px;color:#fff;font-weight:700;font-size:17px;margin-bottom:18px}
.b-operational{background:var(--ok)}.b-degraded{background:var(--deg)}.b-down{background:var(--major)}.b-maintenance{background:var(--maint)}.b-unknown{background:#6b7280}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:18px}
.inc-active{padding:14px 18px;border-left:4px solid var(--major)}.inc-active.m{border-left-color:var(--maint)}
.comp{padding:14px 18px;border-top:1px solid var(--line)}.comp:first-child{border-top:0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.name{font-weight:700}.desc{color:var(--muted);font-size:12.5px}
.st{font-size:12.5px;font-weight:700;white-space:nowrap}.s-operational{color:var(--ok)}.s-degraded{color:var(--deg)}.s-down{color:var(--major)}.s-maintenance{color:var(--maint)}.s-unknown{color:var(--muted)}
.bars{display:flex;gap:2px;margin:10px 0 4px;height:30px}.bar{flex:1;border-radius:2px;min-width:2px}
.d-ok{background:var(--ok)}.d-degraded{background:var(--deg)}.d-partial{background:var(--part)}.d-major{background:var(--major)}.d-nodata{background:var(--nodata)}
.scale{display:flex;justify-content:space-between;color:var(--muted);font-size:11.5px}
.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--muted);font-size:12px;margin:-6px 0 18px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
h2{font-size:16px;margin:26px 0 10px}.day{padding:12px 18px;border-top:1px solid var(--line)}.day:first-child{border-top:0}
.day h3{margin:0 0 4px;font-size:13.5px}.none{color:var(--muted);font-size:13px}
.inc{margin:8px 0}.inc b{display:block}.upd{color:var(--muted);font-size:12.5px;margin-top:3px}.upd strong{color:var(--ink)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
@media (max-width:640px){.bar:nth-child(-n+60){display:none}.scale .far{display:none}.scale .near{display:inline}}
.scale .near{display:none}
`;

function incidentHtml(i) {
  const ups = (i.updates || []).map((u) => `<div class="upd"><strong>${escapeHtml(INCIDENT_STATUS[u.status] || u.status)}</strong> - ${escapeHtml(u.message)} <span>(${escapeHtml(usDateTime(u.created_at))})</span></div>`).join('');
  return `<div class="inc"><b>${escapeHtml(i.title)}</b>${ups}</div>`;
}

export function renderPage(s) {
  const active = s.active.map((i) => `<div class="card inc-active${i.impact === 'maintenance' ? ' m' : ''}">${incidentHtml(i)}</div>`).join('');
  const comps = s.components.map((c) => {
    const bars = c.days.map((d) => `<div class="bar d-${d.status}" title="${escapeHtml(`${dayLabel(d.day)} - ${DAY_LABEL[d.status]}`)}"></div>`).join('');
    const uptime = c.uptime == null ? 'No data yet' : `${c.uptime.toFixed(2)}% uptime`;
    return `<div class="comp"><div class="row"><div><div class="name">${escapeHtml(c.name)}</div><div class="desc">${escapeHtml(c.description)}</div></div>
<div class="st s-${c.status}">${escapeHtml(c.label)}${c.note ? ` - ${escapeHtml(c.note)}` : ''}</div></div>
<div class="bars" aria-label="${escapeHtml(c.name)}: last ${HISTORY_DAYS} days">${bars}</div>
<div class="scale"><span class="far">${HISTORY_DAYS} days ago</span><span class="near">30 days ago</span><span>${escapeHtml(uptime)}</span><span>Today</span></div></div>`;
  }).join('');
  const history = s.incidentDays.map((d) => {
    const list = s.incidents.filter((i) => usDate(i.created_at) === dayLabel(d));
    return `<div class="day"><h3>${escapeHtml(dayLabel(d))}</h3>${list.length ? list.map(incidentHtml).join('') : '<div class="none">No incidents reported.</div>'}</div>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Nexus Status</title><style>${css}</style></head><body><div class="wrap">
<header><div><div class="brand">GREENS GLOBAL</div><h1 class="title">Nexus Status</h1></div></header>
<div class="banner b-${s.overall}">${escapeHtml(s.headline)}</div>
${active}
<div class="card">${comps}</div>
<div class="legend"><span><i class="d-ok"></i>No Downtime</span><span><i class="d-degraded"></i>Degraded</span><span><i class="d-partial"></i>Partial Outage</span><span><i class="d-major"></i>Major Outage</span><span><i class="d-nodata"></i>No Data</span></div>
<h2>Past Incidents</h2><div class="card">${history}</div>
<footer>Checked every minute from outside Nexus.${s.lastChecked ? ` Last check ${escapeHtml(usDateTime(s.lastChecked))}.` : ''}</footer>
</div></body></html>`;
}
