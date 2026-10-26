import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from '../src/monitor.js';
import { runChecks, checkWeb } from '../src/components.js';
import { notify, teamsCard } from '../src/alerts.js';
import { memoryStore, fakeNexus, ENV, minutes } from './helpers.js';

const START = '2026-10-27T17:00:00Z';
const env = { ...ENV, TEAMS_WEBHOOK_URL: 'https://teams.example.com/hook' };

async function run(store, broken, n, from = 0) {
  const all = [];
  for (let i = 0; i < n; i += 1) {
    const { fetchImpl } = fakeNexus(broken);
    const sent = [];
    const r = await tick({ env, store, fetchImpl, now: minutes(START, from + i), notify: async (_e, ev) => { sent.push(ev); } });
    all.push(...sent);
    assert.ok(r.results);
  }
  return all;
}

test('healthy: everything operational, counted on the day, no alerts', async () => {
  const store = memoryStore();
  const sent = await run(store, {}, 3);
  assert.deepEqual(sent, []);
  assert.equal(store.states.api.status, 'operational');
  assert.equal(store.states.database.status, 'operational');
  assert.equal(store.daily['2026-10-27|api'].total, 3);
  assert.equal(store.incidents.length, 0);
});

test('an API outage: one alert, one incident, resolved with one recovery alert', async () => {
  const store = memoryStore();
  await run(store, {}, 2);
  const down = await run(store, { api: 'down' }, 6, 2);
  assert.deepEqual(down.map((e) => [e.type, e.key]), [['down', 'api']]);   // once, not every minute
  assert.equal(store.incidents.length, 1);
  assert.equal(store.incidents[0].status, 'investigating');
  // While the API is down the parts it reports on read unknown, not down.
  assert.equal(store.states.database.status, 'operational');
  assert.equal(store.states.database.lastStatus, 'unknown');
  const up = await run(store, {}, 3, 8);
  assert.deepEqual(up.map((e) => [e.type, e.key]), [['recovered', 'api']]);
  assert.equal(store.incidents[0].status, 'resolved');
  assert.equal(store.daily['2026-10-27|api'].down, 6);
});

test('a component Nexus reports down gets its own incident', async () => {
  const store = memoryStore();
  const sent = await run(store, { components: { storage: 'down' } }, 3);
  assert.deepEqual(sent.map((e) => e.key), ['storage']);
  assert.equal(store.incidents[0].title, 'File Storage is down');
});

test('during a maintenance window there is no incident and no alert', async () => {
  const store = memoryStore();
  await store.openIncident({ title: 'Database upgrade', impact: 'maintenance', status: 'scheduled', components: ['api'],
    createdAt: START, startsAt: START, endsAt: minutes(START, 60).toISOString() });
  const sent = await run(store, { api: 'down' }, 5);
  assert.deepEqual(sent, []);
  assert.equal(store.incidents.length, 1);
});

test('the white-screen failure is down even though the page answers 200', async () => {
  const { fetchImpl } = fakeNexus({ web: 'html-script' });
  const r = await checkWeb(ENV.NEXUS_WEB_URL, fetchImpl);
  assert.equal(r.status, 'down');
  assert.equal(r.note, 'App script does not load');
});

test('a failing probe is retried once in the same run', async () => {
  let n = 0;
  const { fetchImpl: healthy } = fakeNexus();
  const flaky = async (url, init) => {
    if (String(url) === `${ENV.NEXUS_API_URL}/health` && n++ === 0) throw new TypeError('reset');
    return healthy(url, init);
  };
  const r = await runChecks(ENV, flaky);
  assert.equal(r.api.status, 'operational');
});

test('alerts post a Teams card and to extra webhooks; one failing does not stop the rest', async () => {
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push(String(url));
    if (String(url).includes('broken')) throw new Error('down');
    return new Response('', { status: 202 });
  };
  const ok = await notify({ TEAMS_WEBHOOK_URL: 'https://teams.example.com/a', ALERT_WEBHOOK_URLS: 'https://hook.broken.com, https://hook.example.com' },
    { type: 'down', name: 'Nexus API', key: 'api', at: START }, fetchImpl);
  assert.equal(posted.length, 3);
  assert.equal(ok, 2);
  const card = teamsCard({ type: 'recovered', name: 'Nexus API', at: '2026-10-27T17:12:00Z', since: START, pageUrl: 'https://s' });
  const body = card.attachments[0].content;
  assert.equal(body.body[0].text, 'Nexus API has recovered');
  assert.deepEqual(body.body[2].facts.find((f) => f.title === 'Down For'), { title: 'Down For', value: '12 min' });
  assert.deepEqual(body.body[2].facts[1], { title: 'Back At', value: '10/27/2026 10:12 AM PDT' });
});
