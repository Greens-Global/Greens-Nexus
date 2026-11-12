// Teams deep links, in one place (Frontline Reach, Neil 11/02/2026). Nexus
// has no chat of its own on purpose: Greens runs on Microsoft 365, every
// employee already has Teams, and Nexus posts into it. So wherever a person
// appears, Message and Call open Teams through these links - never a second
// inbox. The directory, My Team, the time sheet nudge, the credential owner
// link and the hover card all used to build these URLs by hand.
//
// The links are the documented https://teams.microsoft.com/l/... form, which
// the Teams desktop and phone apps claim when installed and the web client
// answers otherwise. `message` is prefilled in the compose box, nothing is sent.
const TEAMS = 'https://teams.microsoft.com/l';
const clean = (email) => String(email || '').trim();

export function teamsChatUrl(email, message = '') {
  const base = `${TEAMS}/chat/0/0?users=${encodeURIComponent(clean(email))}`;
  return message ? `${base}&message=${encodeURIComponent(message)}` : base;
}
export const teamsCallUrl = (email) => `${TEAMS}/call/0/0?users=${encodeURIComponent(clean(email))}`;
export const teamsVideoUrl = (email) => `${teamsCallUrl(email)}&withVideo=true`;

/** Who can be reached on Teams: internal staff with a work email. Externals
 *  (B2B guests) are not in the company tenant, and nobody messages themselves.
 *  Takes a person object from any roster (`external` from the Tasks roster,
 *  `isExternal` from the role context, `kind: 'guest'`) or a bare email. */
export function canReachOnTeams(person, myEmail = '') {
  if (!person) return false;
  const p = typeof person === 'string' ? { email: person } : person;
  const email = clean(p.email || p.workEmail);
  if (!email || !email.includes('@')) return false;
  if (p.external || p.isExternal || p.kind === 'guest' || p.kind === 'external') return false;
  if (myEmail && email.toLowerCase() === clean(myEmail).toLowerCase()) return false;
  return true;
}

/** A Teams meeting's chat (Meeting Notes, 11/12/2026): where Teams keeps the
 *  meeting's recording and its own recap - Nexus links there, never copies. */
export const teamsMeetingChatUrl = (threadId) => `${TEAMS}/chat/${encodeURIComponent(String(threadId || '').trim())}/0`;
