// One minute of the monitor: check everything, move each component's state,
// count the minute on its day, and on a change open or resolve an incident
// and alert. Called by the Worker's cron (index.js); the store, fetch and
// notify are passed in so tests can drive it.
import { COMPONENTS, runChecks } from './components.js';
import { nextState, dayKey, lastDays } from './state.js';

const KEEP_DAYS = 400;

export async function tick({ env, store, fetchImpl = fetch, notify, now = new Date() }) {
  const at = now.toISOString();
  const results = await runChecks(env, fetchImpl);
  const states = await store.loadStates();
  const maintenance = await store.maintenanceNow(at);
  const day = dayKey(now);
  const events = [];

  for (const c of COMPONENTS) {
    const observed = results[c.key] || { status: 'unknown', note: '' };
    const prev = states[c.key];
    const { state, event } = nextState(prev && { ...prev }, observed.status, at);
    await store.saveState(c.key, {
      ...state, lastChecked: at, lastStatus: observed.status, note: observed.note || '', latencyMs: observed.latencyMs,
    });
    if (observed.status !== 'unknown') await store.recordDay(day, c.key, observed.status);
    if (!event || maintenance.has(c.key)) continue;   // planned work: no incident, no alert

    const base = { name: c.name, description: c.description, key: c.key, at, note: observed.note || '', pageUrl: env.STATUS_PAGE_URL || '' };
    if (event === 'down') {
      const id = await store.openIncident({
        title: `${c.name} is down`, impact: 'major', status: 'investigating', components: [c.key], auto: true, createdAt: at,
      });
      await store.addUpdate(id, 'investigating', `Automatic checks found ${c.name} not working${observed.note ? ` (${observed.note})` : ''}. The team has been alerted.`, at);
      events.push({ type: 'down', ...base });
    } else {
      const open = await store.openAutoIncidentFor(c.key);
      if (open) await store.addUpdate(open.id, 'resolved', `${c.name} is working again.`, at);
      events.push({ type: 'recovered', ...base, since: prev?.since });
    }
  }

  for (const e of events) {
    try { await notify(env, e, fetchImpl); } catch { /* an alert failing never stops the monitor */ }
  }
  // Once a day is plenty to trim old bars.
  if (now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
    await store.pruneDays(lastDays(KEEP_DAYS, now)[0]);
  }
  return { results, events };
}
