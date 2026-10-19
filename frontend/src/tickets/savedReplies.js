// Saved replies (canned responses) for the ticket desk (Oct 2026) - the one
// placeholder implementation. backend/routers/ticket_saved_replies.py lists
// the same names (PLACEHOLDERS); keep the two in step.
//
// A saved reply is inserted into the drawer's reply composer with these
// filled in, then edited there - it is never sent on its own. Anything else
// in braces is left exactly as typed, so "{order_number}" stays for the agent
// to fill by hand.
import { ticketNo } from './ticketMeta';

export const PLACEHOLDERS = [
  { key: 'requester_first_name', label: "Requester's first name", example: 'Maria' },
  { key: 'requester_name', label: "Requester's full name", example: 'Maria Lopez' },
  { key: 'ticket_number', label: 'Ticket number', example: 'Ticket #1042' },
  { key: 'ticket_subject', label: 'Ticket subject', example: 'Printer jam on the 2nd floor' },
  { key: 'agent_first_name', label: 'Your first name', example: 'Sam' },
  { key: 'agent_name', label: 'Your full name', example: 'Sam Patel' },
];

const KEYS = new Set(PLACEHOLDERS.map((p) => p.key));

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// A person's display name, never a bare address: "maria.lopez@x.com" reads
// as "Maria Lopez" - the same fallback the ticket emails use (_name_of).
export function displayName(name, email) {
  const n = String(name || '').trim();
  if (n && n.toLowerCase() !== String(email || '').toLowerCase()) return n;
  const local = String(email || '').split('@')[0] || '';
  return local.split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

/** The values for one ticket and one agent. `nameOf(email)` is the drawer's
 *  name lookup (it falls back to the address for people it does not know). */
export function placeholderValues({ ticket, agentEmail, nameOf }) {
  const look = (email) => (email ? displayName(nameOf ? nameOf(email) : '', email) : '');
  const requester = look(ticket?.requesterId || '');
  const agent = look(agentEmail || '');
  return {
    requester_first_name: firstName(requester),
    requester_name: requester,
    ticket_number: ticketNo(ticket?.code || ''),
    ticket_subject: ticket?.subject || '',
    agent_first_name: firstName(agent),
    agent_name: agent,
  };
}

/** Fill the known placeholders in a reply body. `html`: the body is HTML, so
 *  values are escaped (a subject like "a < b" must stay text). Unknown names,
 *  and known ones with no value, are left exactly as typed. */
export function fillPlaceholders(text, values, { html = true } = {}) {
  return String(text || '').replace(/\{([a-z_]+)\}/g, (whole, key) => {
    if (!KEYS.has(key)) return whole;
    const v = values?.[key];
    if (v === undefined || v === null || v === '') return whole;
    return html ? escapeHtml(v) : String(v);
  });
}

/** Plain text of a body, for search and the one-line preview in lists. */
export function replyText(body) {
  return String(body || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h[1-4])>/gi, ' ')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/** The picker's order: replies for the ticket's help topic first, then the
 *  rest - each group by how often it is used, then by title. `query` matches
 *  title, text and topic, case-insensitively. */
export function rankReplies(replies, { topic = '', query = '' } = {}) {
  const t = String(topic || '').trim().toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  return (replies || [])
    .filter((r) => !q || `${r.title} ${replyText(r.body)} ${r.helpTopic || ''}`.toLowerCase().includes(q))
    .map((r) => ({ ...r, matchesTopic: !!t && String(r.helpTopic || '').trim().toLowerCase() === t }))
    .sort((a, b) => (Number(b.matchesTopic) - Number(a.matchesTopic))
      || ((b.useCount || 0) - (a.useCount || 0))
      || String(a.title || '').localeCompare(String(b.title || '')));
}
