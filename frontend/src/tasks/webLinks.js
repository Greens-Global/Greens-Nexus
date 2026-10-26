// Task attachments: web links (Neil, Oct 22 2026 - Microsoft Planner parity).
// The pure helpers, apart from the components so they can be tested alone.
//
// A web link (kind "link") is a LINK to any web page, never a copy: nothing
// is uploaded, the server never fetches it, and it opens in a new tab with
// rel="noopener noreferrer". The server normalizes and checks the address
// (routers/tasks.py, _check_web_link); webLinkProblem says the same things up
// front so a bad paste is explained before it is sent. A link is never one
// of our storage URLs (that would be a file - attach it), so the storage
// viewer rewriting in api.js / lib/storageView.js never touches one.
import { VIEW_PREFIX } from '../lib/storageView';

export const isWebLink = (a) => a?.kind === 'link';

const LINK_MAX = 2000;
// Control, zero-width and direction-override characters - the server refuses
// every "hidden" character (Unicode categories C*, Zl, Zp); these are the ones
// a paste actually carries.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '').toLowerCase();

/** "" when the server will take `value` as a link, else what is wrong.
 *  A bare "example.com/page" is fine - the server makes it https. */
export function webLinkProblem(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'Paste the web address to link.';
  if (s.length > LINK_MAX) return 'That link is too long - 2,000 characters at most.';
  if (HIDDEN.test(s)) return 'That link has hidden characters in it. Copy it again and paste it here.';
  if (s.includes('\\')) return 'That link has a backslash in it. Copy it again and paste it here.';
  let rest = s;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  const hostPort = m && !s.slice(m[0].length).startsWith('//') && m[1].includes('.') && !/^https?$/i.test(m[1]);
  if (m && !hostPort) {
    if (!/^https?$/i.test(m[1])) return 'Only web links (http or https) can be added.';
    rest = s.slice(m[0].length);
    if (!rest.startsWith('//')) return 'That is not a valid link.';
    rest = rest.slice(2);
  } else if (s.startsWith('/')) {
    return 'Paste the full link, starting with https://';
  }
  const authority = rest.split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return 'Links with a user name or password in them cannot be added.';
  const host = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.replace(/:\d*$/, '');
  if (!host) return 'That link has no website in it.';
  if (hostProblem(host)) return "That link's website name is not valid.";
  if (ownFileLink(s, host)) return 'That is a file stored in Nexus. Attach the file instead of linking to it.';
  return '';
}

// The server's host rule (tasks._check_host): labels of 1-63 letters, digits
// and hyphens, no hyphen at either end, no empty label; an all-digit last
// label means an IPv4 address and must be a plain dotted quad; an IPv6
// address must look like one (the server parses it). An international name
// is checked in its ASCII (punycode) form, as the server stores it.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
function hostProblem(raw) {
  let host = raw;
  if (host.includes(':')) return /^[0-9a-f:.]+$/i.test(host) && (host.match(/:/g) || []).length >= 2 ? '' : 'bad';
  if (/[^\x21-\x7e]/.test(host)) {
    try { host = new URL(`https://${host}/`).hostname; } catch { return 'bad'; }
  }
  const labels = host.split('.');
  if (host.length > 253 || !labels.every((x) => LABEL.test(x))) return 'bad';
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return labels.length === 4 && labels.every((x) => /^(?:0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255) ? '' : 'bad';
  }
  return '';
}

// %2F and a double-encoded %252F read as "/" (the server's _unquoted).
function unquoted(text) {
  let out = String(text || '');
  for (let i = 0; i < 3; i += 1) {
    let next;
    try { next = decodeURIComponent(out); } catch { break; }
    if (next === out) break;
    out = next;
  }
  return out.toLowerCase();
}

const SUPABASE_HOST = (() => {
  try { return SUPABASE_URL ? new URL(SUPABASE_URL).hostname.replace(/\.$/, '').toLowerCase() : ''; } catch { return ''; }
})();
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A link into our own storage or the /files/view viewer - its host (http
 *  or https, a trailing dot, any port) with the storage path, or one carried
 *  in the query or fragment - is a file, not a link (tasks._own_file_url). */
function ownFileLink(s, host) {
  if (s.startsWith(VIEW_PREFIX)) return true;
  const after = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const cut = after.search(/[/?#]/);
  const tail = cut < 0 ? '' : after.slice(cut);
  const path = tail.split(/[?#]/, 1)[0];
  const extra = tail.slice(path.length);
  if (SUPABASE_HOST) {
    if (host.replace(/\.$/, '').toLowerCase() === SUPABASE_HOST && unquoted(path).includes('/storage/v1/')) return true;
    if (new RegExp(`${escRe(SUPABASE_HOST)}\\.?(?::\\d+)?/storage/v1/`).test(unquoted(extra))) return true;
  }
  return /\/files\/view\/?\?(?:[^#]*&)?u=/i.test(unquoted(tail));
}

/** The address a row may open: http(s) only, whatever the row says. */
export function safeLinkHref(a) {
  const u = String(a?.url || '');
  return /^https?:\/\//i.test(u) ? u : '';
}

/** "example.com" from "https://www.example.com/x" - the website, shown small
 *  under the name. An international site shows in its ASCII (xn--) form, the
 *  way the server stores it, so a look-alike reads as what it is. */
export function linkHost(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The display name, or the address when the link has none (the server
 *  stores the address as the name then). */
export const linkLabel = (a) => (a?.name && a.name !== a.url ? a.name : a?.url || '');

/** The name the edit box starts with: "" when the link shows its address. */
export const linkCustomName = (a) => (a?.name && a.name !== a.url ? a.name : '');
