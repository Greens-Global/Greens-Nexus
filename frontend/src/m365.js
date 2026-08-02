// ── Microsoft 365 quick actions - Outlook mail + calendar ────────────────────
// Delegated Graph, mirroring teamsGraph.js: acts AS the signed-in user.
//
// Mail.Send and Calendars.ReadWrite need ADMIN CONSENT on the Entra app
// registration. Until that is granted these helpers cannot get a token, so
// every one of them falls back to an Outlook web deep link prefilled with
// whatever the user typed - nothing they entered is lost, the compose just
// finishes in Outlook instead of in Nexus. Once consent lands, the silent
// token starts succeeding and the same buttons send in-place with no code
// change and no redeploy.
//
// Silent-only on purpose: acquireTokenPopup has hung the browser here before
// (see the step-up re-auth commit), and a quick action must never hang the
// dashboard. Admin consent pre-authorises the scopes tenant-wide, so silent
// acquisition is exactly what succeeds once it is granted.
import { msalInstance } from './msalInstance';
import { GRAPH } from './teamsGraph';

export const MAIL_SCOPES  = ['Mail.Send'];
export const EVENT_SCOPES = ['Calendars.ReadWrite'];

const OUTLOOK_MAIL     = 'https://outlook.office.com/mail/deeplink/compose';
const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/deeplink/compose';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// null when the scopes are not consented yet (or no account) - callers deep-link.
async function tokenFor(scopes) {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await withTimeout(msalInstance.acquireTokenSilent({ scopes, account }), 6000);
    return r.accessToken;
  } catch { return null; }
}

async function graphPost(path, tok, body, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${GRAPH}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`Graph ${r.status}: ${(await r.text()).slice(0, 180)}`);
    return true;
  } finally { clearTimeout(t); }
}

const qs = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

const openTab = (url) => window.open(url, '_blank', 'noopener,noreferrer');

export const myTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

// ── Mail ─────────────────────────────────────────────────────────────────────
// { to: [email], subject, body } → { sent: true } in-app, or { sent: false }
// after handing off to Outlook web with the same content prefilled.
export async function sendMail({ to = [], cc = [], subject = '', body = '' }) {
  const recipients = to.filter(Boolean);
  if (!recipients.length) throw new Error('Add at least one recipient.');

  const tok = await tokenFor(MAIL_SCOPES);
  if (tok) {
    const addr = (a) => ({ emailAddress: { address: a } });
    await graphPost('/me/sendMail', tok, {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: recipients.map(addr),
        ccRecipients: cc.filter(Boolean).map(addr),
      },
      saveToSentItems: true,
    });
    return { sent: true };
  }

  openTab(`${OUTLOOK_MAIL}?${qs({ to: recipients.join(';'), cc: cc.filter(Boolean).join(';'), subject, body })}`);
  return { sent: false };
}

// ── Calendar ─────────────────────────────────────────────────────────────────
// start/end are local wall-clock strings ("2026-07-30T14:00") - Graph gets them
// with an explicit timeZone so no UTC conversion happens on the way out.
export async function createEvent({ subject = '', start, end, location = '', body = '', attendees = [] }) {
  if (!start || !end) throw new Error('Pick a start and end time.');
  if (new Date(end) <= new Date(start)) throw new Error('End time must be after the start time.');

  const guests = attendees.filter(Boolean);
  const tok = await tokenFor(EVENT_SCOPES);
  if (tok) {
    const tz = myTimeZone();
    await graphPost('/me/events', tok, {
      subject,
      body: { contentType: 'Text', content: body },
      start: { dateTime: start, timeZone: tz },
      end:   { dateTime: end,   timeZone: tz },
      location: { displayName: location },
      attendees: guests.map((a) => ({ emailAddress: { address: a }, type: 'required' })),
    });
    return { sent: true };
  }

  openTab(`${OUTLOOK_CALENDAR}?${qs({ subject, startdt: start, enddt: end, location, body, to: guests.join(';') })}`);
  return { sent: false };
}
