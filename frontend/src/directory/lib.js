// Contact Directory helpers (Support > Contact Directory, Oct 2026): pure
// functions the view and its tests share - search, grouping, the reporting
// tree, Teams links, availability styling, vCard and CSV export. No React,
// no network, so each is testable on its own.

// ── Reaching someone ───────────────────────────────────────────────────────
// Official Teams deep links: they open the desktop app when it is installed
// and Teams on the web otherwise. `users=` takes the person's work email.
const TEAMS = 'https://teams.microsoft.com/l';
export const teamsChat  = (email) => `${TEAMS}/chat/0/0?users=${encodeURIComponent(email)}`;
export const teamsCall  = (email) => `${TEAMS}/call/0/0?users=${encodeURIComponent(email)}`;
export const teamsVideo = (email) => `${TEAMS}/call/0/0?users=${encodeURIComponent(email)}&withVideo=true`;
export const mailto     = (email) => `mailto:${email}`;
export const telHref    = (phone) => `tel:${String(phone || '').replace(/[^+\d]/g, '')}`;

// ── Names and avatars ─────────────────────────────────────────────────────
export const initialsOf = (p) => {
  const a = (p.firstName || p.name || '?').trim();
  const b = (p.lastName || '').trim();
  return `${a[0] || ''}${b[0] || ''}`.toUpperCase() || '?';
};
// Same five hues the People module hands out (HR.jsx AVATAR_HUES), keyed on
// the email so a person keeps one color everywhere in the directory.
const HUES = ['215,75%,45%', '142,60%,35%', '30,80%,48%', '271,60%,48%', '350,65%,48%'];
export const hueOf = (key) => HUES[String(key || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length];

// ── Availability ──────────────────────────────────────────────────────────
// The server says WHAT (state + label + detail); this says how it looks. The
// dot colors match the app's status palette (tasks/theme.js) rather than
// inventing new ones.
export const AVAILABILITY_META = {
  in:        { color: '#16a34a', tint: 'rgba(22,163,74,0.12)',   short: 'In' },
  break:     { color: '#d97706', tint: 'rgba(217,119,6,0.14)',   short: 'Break' },
  out:       { color: '#9ca3af', tint: 'rgba(156,163,175,0.18)', short: 'Out' },
  scheduled: { color: '#2563eb', tint: 'rgba(37,99,235,0.12)',   short: 'Scheduled' },
  partial:   { color: '#d97706', tint: 'rgba(217,119,6,0.14)',   short: 'Partly Out' },
  off:       { color: '#dc2626', tint: 'rgba(220,38,38,0.12)',   short: 'Off' },
  holiday:   { color: '#7c3aed', tint: 'rgba(124,58,237,0.12)',  short: 'Holiday' },
};
export const isOffToday = (p) => ['off', 'holiday'].includes(p?.availability?.state);

// Teams presence (Graph availability/activity -> dot color + label), the
// same colors Teams uses so a dot here means what it means there.
const PRESENCE_COLOR = { green: '#16a34a', red: '#dc2626', amber: '#d97706', gray: '#9ca3af' };
const PRESENCE_BY_AVAILABILITY = {
  Available: ['green', 'Available'], AvailableIdle: ['green', 'Available'],
  Busy: ['red', 'Busy'], BusyIdle: ['red', 'Busy'], DoNotDisturb: ['red', 'Do Not Disturb'],
  Away: ['amber', 'Away'], BeRightBack: ['amber', 'Be Right Back'],
  Offline: ['gray', 'Offline'], PresenceUnknown: ['gray', 'Offline'],
};
const PRESENCE_ACTIVITY_LABEL = {
  InACall: 'In a Call', InAConferenceCall: 'In a Call', InAMeeting: 'In a Meeting', Presenting: 'Presenting',
  OutOfOffice: 'Out of Office', UrgentInterruptionsOnly: 'Urgent Only', OffWork: 'Off Work',
};
// {color, label} or null when Graph has nothing for the person.
export function presenceOf(presence) {
  if (!presence?.availability) return null;
  const [tone, label] = PRESENCE_BY_AVAILABILITY[presence.availability] || ['gray', presence.availability];
  return { color: PRESENCE_COLOR[tone], label: PRESENCE_ACTIVITY_LABEL[presence.activity] || label };
}

// ── Search ────────────────────────────────────────────────────────────────
// Every word typed must match somewhere in the person's name, title,
// department, division, company, office, city or email. "acc dan" finds Dan
// in Accounting; "dan acc" finds the same row. Ranking: a name that STARTS
// with the query wins, then a name containing it, then everything else, each
// band alphabetical - predictable beats clever.
const haystack = (p) => [p.name, p.firstName, p.lastName, p.jobTitle, p.designation, p.department, p.division,
  p.companyName, p.location, p.city, p.state, p.email].filter(Boolean).join(' ').toLowerCase();

export function searchPeople(people, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return people;
  const words = q.split(/\s+/).filter(Boolean);
  const hits = people.filter((p) => {
    const h = haystack(p);
    return words.every((w) => h.includes(w));
  });
  const band = (p) => {
    const n = (p.name || '').toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  return hits
    .map((p) => [band(p), p])
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .map(([, p]) => p);
}

// ── Grouping (Departments lens) ───────────────────────────────────────────
export const NO_DEPARTMENT = 'No Department';
const roleRank = (p) => (p.departmentRole === 'lead' ? 0 : p.departmentRole === 'backup' ? 1 : 2);
export const byLastName = (a, b) => (a.lastName || a.name).localeCompare(b.lastName || b.name) || a.name.localeCompare(b.name);

export function groupByDepartment(people) {
  const groups = new Map();
  for (const p of people) {
    const key = (p.department || '').trim() || NO_DEPARTMENT;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const names = [...groups.keys()].sort((a, b) => {
    if (a === NO_DEPARTMENT) return 1;
    if (b === NO_DEPARTMENT) return -1;
    return a.localeCompare(b);
  });
  return names.map((name) => ({
    name,
    people: groups.get(name).sort((a, b) => roleRank(a) - roleRank(b) || byLastName(a, b)),
  }));
}

// ── Reporting tree (Reporting Line lens) ──────────────────────────────────
// Roots are people whose manager is not in the list (no manager, or one the
// viewer cannot see). A manager cycle (A reports to B reports to A) must not
// hang the walk, so each person is placed once and a repeat is a root.
export function buildTree(people) {
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const kids = new Map();
  const roots = [];
  for (const p of people) {
    const m = (p.managerEmail || '').toLowerCase();
    if (m && m !== p.email && byEmail.has(m)) {
      if (!kids.has(m)) kids.set(m, []);
      kids.get(m).push(p);
    } else {
      roots.push(p);
    }
  }
  const seen = new Set();
  const node = (p, depth) => {
    seen.add(p.email);
    const children = (kids.get(p.email) || []).filter((c) => !seen.has(c.email)).sort(byLastName);
    return { person: p, depth, children: children.map((c) => node(c, depth + 1)) };
  };
  const tree = roots.sort(byLastName).map((r) => node(r, 0));
  // Anyone only reachable through a cycle never got placed - surface them.
  for (const p of people) if (!seen.has(p.email)) tree.push(node(p, 0));
  return tree;
}

// Walks up from a person to the top: [manager, manager's manager, ...].
export function chainUp(person, byEmail, max = 8) {
  const out = [];
  let cur = person;
  const seen = new Set([person.email]);
  while (cur && out.length < max) {
    const m = byEmail.get((cur.managerEmail || '').toLowerCase());
    if (!m || seen.has(m.email)) break;
    out.push(m);
    seen.add(m.email);
    cur = m;
  }
  return out;
}

export const directReports = (person, people) =>
  people.filter((p) => (p.managerEmail || '').toLowerCase() === person.email && p.email !== person.email).sort(byLastName);

// "My team" = my manager, my peers (same manager) and my direct reports.
export function myTeam(me, people) {
  if (!me) return [];
  const mgr = (me.managerEmail || '').toLowerCase();
  return people.filter((p) => p.email !== me.email && (
    p.email === mgr
    || (mgr && (p.managerEmail || '').toLowerCase() === mgr)
    || (p.managerEmail || '').toLowerCase() === me.email));
}

// ── Local time ────────────────────────────────────────────────────────────
export function localTimeLabel(timeZone, now = new Date()) {
  try {
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(now);
    const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(now).find((x) => x.type === 'timeZoneName')?.value || '';
    return `${time} ${zone}`.trim();
  } catch {
    return '';
  }
}

// Hours apart from the viewer, as "+9.5h" / "-3h" / '' when the same clock.
export function offsetFromViewer(timeZone, now = new Date()) {
  try {
    const minutesIn = (tz) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', day: '2-digit',
      }).formatToParts(now).map((p) => [p.type, p.value]));
      return Number(parts.day) * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
    };
    let diff = minutesIn(timeZone) - minutesIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // Month boundaries make the day term wrap; a real offset is never > 14h.
    if (diff > 14 * 60) diff -= 1440 * 28;
    if (diff < -14 * 60) diff += 1440 * 28;
    if (diff > 14 * 60 || diff < -14 * 60 || diff === 0) return '';
    const h = diff / 60;
    return `${h > 0 ? '+' : '-'}${Math.abs(h) % 1 === 0 ? Math.abs(h) : Math.abs(h).toFixed(1)}h`;
  } catch {
    return '';
  }
}

// ── Export ────────────────────────────────────────────────────────────────
// vCard 3.0 - what Outlook, iOS and Android all import. Values are escaped
// per RFC 6350 (commas, semicolons, backslashes, newlines).
const vEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
export function vCardOf(p) {
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    `N:${vEsc(p.lastName)};${vEsc(p.firstName)};;;`,
    `FN:${vEsc(p.name)}`,
  ];
  if (p.companyName || p.department) lines.push(`ORG:${vEsc(p.companyName)};${vEsc(p.department)}`);
  if (p.jobTitle) lines.push(`TITLE:${vEsc(p.jobTitle)}`);
  if (p.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${p.email}`);
  if (p.officePhone) lines.push(`TEL;TYPE=WORK,VOICE:${vEsc(p.officePhone)}`);
  if (p.mobile) lines.push(`TEL;TYPE=CELL,VOICE:${vEsc(p.mobile)}`);
  if (p.city || p.state || p.country) lines.push(`ADR;TYPE=WORK:;;;${vEsc(p.city)};${vEsc(p.state)};;${vEsc(p.country)}`);
  if (p.photoUrl) lines.push(`PHOTO;VALUE=URI:${p.photoUrl}`);
  if (p.linkedinUrl) lines.push(`URL:${p.linkedinUrl}`);
  if (p.timeZone) lines.push(`TZ:${p.timeZone}`);
  lines.push(`REV:${new Date().toISOString()}`, 'END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_COLUMNS = [
  ['Name', (p) => p.name], ['Title', (p) => p.jobTitle], ['Department', (p) => p.department],
  ['Company', (p) => p.companyName], ['Email', (p) => p.email], ['Office Phone', (p) => p.officePhone],
  ['Mobile', (p) => p.mobile], ['Reports To', (p) => p.managerName], ['Office', (p) => p.location],
  ['City', (p) => p.city], ['State', (p) => p.state], ['Country', (p) => p.country],
];
export function csvOf(people) {
  const head = CSV_COLUMNS.map(([h]) => h).join(',');
  const rows = people.map((p) => CSV_COLUMNS.map(([, f]) => csvCell(f(p))).join(','));
  return [head, ...rows].join('\r\n') + '\r\n';
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (s) => String(s || 'contact').replace(/[^\w.-]+/g, '_');

// ── Pinned contacts (per browser; a convenience, not shared state) ───────
const PIN_KEY = 'nexus-directory-pins';
export function readPins() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]').filter((x) => typeof x === 'string'); } catch { return []; }
}
export function writePins(pins) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch { /* private mode */ }
}
