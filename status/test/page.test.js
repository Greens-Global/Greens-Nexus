import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, renderPage } from '../src/page.js';
import { handleAdmin, sameToken } from '../src/index.js';
import { memoryStore, minutes } from './helpers.js';

const NOW = new Date('2026-10-27T18:00:00Z');

test('before any check the page waits instead of claiming all is well', async () => {
  const s = await buildStatus(memoryStore(), NOW);
  assert.equal(s.headline, 'Waiting for the First Checks');
  assert.equal(s.components[0].days.length, 90);
  assert.ok(s.components[0].days.every((d) => d.status === 'nodata'));
});

test('headline follows the worst part; web or API down is a major outage', async () => {
  const store = memoryStore();
  for (const k of ['web', 'api', 'database', 'storage', 'microsoft365', 'backgroundJobs', 'schema']) {
    await store.saveState(k, { status: 'operational', failStreak: 0, okStreak: 1, since: NOW.toISOString(), lastChecked: NOW.toISOString() });
  }
  assert.equal((await buildStatus(store, NOW)).headline, 'All Systems Operational');
  store.states.schema.status = 'unknown';   // not configured: shows No Data, headline stays green
  const green = await buildStatus(store, NOW);
  assert.equal(green.headline, 'All Systems Operational');
  assert.equal(green.overall, 'operational');
  assert.equal(green.components.find((c) => c.key === 'schema').label, 'No Data');
  store.states.storage.status = 'down';
  assert.equal((await buildStatus(store, NOW)).headline, 'Partial Outage');
  store.states.api.status = 'down';
  const s = await buildStatus(store, NOW);
  assert.equal(s.headline, 'Major Outage');
  assert.equal(s.overall, 'down');
});

test('the page shows US dates, the 90-day bars and escapes what the team typed', async () => {
  const store = memoryStore();
  await store.saveState('api', { status: 'operational', failStreak: 0, okStreak: 1, since: NOW.toISOString(), lastChecked: NOW.toISOString() });
  await store.recordDay('2026-10-27', 'api', 'operational');
  await store.recordDay('2026-10-26', 'api', 'down');
  const id = await store.openIncident({ title: '<script>alert(1)</script>', impact: 'minor', status: 'investigating', components: ['api'], createdAt: minutes(NOW, -30).toISOString() });
  await store.addUpdate(id, 'investigating', 'Looking into it', minutes(NOW, -30).toISOString());
  const html = renderPage(await buildStatus(store, NOW));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(html, /10\/27\/2026/);
  assert.match(html, /title="10\/26\/2026 - Partial outage"/);
  assert.match(html, /Last check 10\/27\/2026 11:00 AM PDT/);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'no ISO dates on the page');
});

test('posting incidents needs the admin token', async () => {
  const store = memoryStore();
  const env = { ADMIN_TOKEN: 'right-token' };
  const post = (path, body, token) => handleAdmin(new Request(`https://s${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, store, new URL(`https://s${path}`), NOW);

  assert.equal((await post('/api/incidents', { title: 'x', message: 'y' }, 'wrong')).status, 401);
  const created = await post('/api/incidents', { title: 'Slow time sheets', impact: 'minor', components: ['api', 'nope'], message: 'Looking into it' }, 'right-token');
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(store.incidents[0].components, 'api');
  assert.equal((await post(`/api/incidents/${id}/updates`, { status: 'resolved', message: 'Fixed' }, 'right-token')).status, 200);
  assert.equal(store.incidents[0].status, 'resolved');
  assert.equal((await post('/api/incidents/99/updates', { status: 'resolved', message: 'x' }, 'right-token')).status, 404);
  const maint = await post('/api/incidents', { title: 'Upgrade', impact: 'maintenance', components: ['database'], message: 'Planned', startsAt: NOW.toISOString() }, 'right-token');
  assert.equal(maint.status, 201);
  assert.equal(store.incidents[1].status, 'scheduled');
});

test('token compare', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abd', 'abc'), false);
  assert.equal(sameToken('ab', 'abc'), false);
  assert.equal(sameToken('abc', ''), false);
});
