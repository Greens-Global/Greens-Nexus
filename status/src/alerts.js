// Alerts go to a Teams channel through a Teams "Workflows" webhook (the
// replacement for the retired Office 365 connectors): in Teams, on the channel
// pick Workflows > "Post to a channel when a webhook request is received" and
// paste the URL it gives into the TEAMS_WEBHOOK_URL secret. More channels or
// any other receiver: ALERT_WEBHOOK_URLS (comma-separated), which gets the
// plain JSON event.
//
// One alert when a component goes down, one when it recovers - never one a
// minute while it stays down (the monitor only calls this on a change).
import { usDateTime, duration } from './format.js';

export function teamsCard(event) {
  const down = event.type === 'down';
  const title = down ? `${event.name} is down` : `${event.name} has recovered`;
  const facts = [
    { title: 'Status', value: down ? 'Down' : 'Operational' },
    { title: down ? 'Since' : 'Back At', value: usDateTime(event.at) },
  ];
  if (!down && event.since) facts.push({ title: 'Down For', value: duration(event.since, event.at) });
  if (event.note) facts.push({ title: 'Detail', value: event.note });
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Large', color: down ? 'Attention' : 'Good', wrap: true },
          { type: 'TextBlock', text: event.description || '', isSubtle: true, wrap: true, spacing: 'None' },
          { type: 'FactSet', facts },
        ],
        actions: event.pageUrl ? [{ type: 'Action.OpenUrl', title: 'Open the Status Page', url: event.pageUrl }] : [],
      },
    }],
  };
}

export async function notify(env, event, fetchImpl = fetch) {
  const sends = [];
  if (env.TEAMS_WEBHOOK_URL) {
    sends.push(fetchImpl(env.TEAMS_WEBHOOK_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(teamsCard(event)),
    }));
  }
  for (const url of String(env.ALERT_WEBHOOK_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    sends.push(fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'nexus-status', ...event }),
    }));
  }
  // One receiver failing must not stop the others or the monitor.
  const results = await Promise.allSettled(sends);
  return results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length;
}
