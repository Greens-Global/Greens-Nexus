// Share to Nexus - the app's side of the manifest's share_target.
//
// The phone's share sheet sends a photo, a file, some text or a link to the
// installed Nexus. public/sw.js answers that one POST: it keeps what was
// shared in a cache of its own (SHARE_CACHE, in this browser only) and opens
// the app at /?share=1, where components/ShareToNexus.jsx asks what to start
// with it - a ticket, a task or a note. This file reads that cache back,
// clears it, and turns the share into what each module's own create form is
// seeded with. Nothing is uploaded here: files travel as File objects into
// the form the person picked, and that form's own save uploads them.
//
// The cache is cleared when the share is used or dismissed, on sign out
// (lib/offline/read.js clearOfflineReadCache - so the next person on this
// browser never sees it) and a day after it arrived (sweepShare, on every
// app start). It is not the offline read cache and not the outbox, and it
// never holds an API answer.
//
// Installed Chrome and Edge only (Android and desktop): iOS has no Web Share
// Target, so nothing in the app offers this as a feature to turn on.
import { seedHtml } from '../support/ticketSeed';

// The same names public/sw.js writes with - change both together
// (shareTarget.test.js checks they match).
export const SHARE_CACHE = 'nexus-share';
export const SHARE_META = '/__nexus-share/meta';
export const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const store = () => (typeof caches !== 'undefined' && caches ? caches : null);

async function readMeta(cs) {
  if (!(await cs.has(SHARE_CACHE))) return null;
  const cache = await cs.open(SHARE_CACHE);
  const hit = await cache.match(SHARE_META);
  const meta = hit ? await hit.json() : null;
  return meta && typeof meta === 'object' ? { cache, meta } : null;
}

/** Remove what was shared from this browser. Never throws. */
export async function clearShare() {
  try { await store()?.delete(SHARE_CACHE); } catch { /* nothing kept, or no Cache Storage here */ }
}

/** Remove a share nobody came back to within a day. Never throws. */
export async function sweepShare(now = Date.now()) {
  try {
    const cs = store();
    if (!cs || !(await cs.has(SHARE_CACHE))) return;
    const got = await readMeta(cs).catch(() => null);
    if (!got || !(now - Number(got.meta.at) <= SHARE_MAX_AGE_MS)) await clearShare();
  } catch { /* best effort */ }
}

/**
 * What was shared and is still waiting:
 *   { at, title, text, url, files: File[], skipped }
 * or null when there is nothing (never shared, already used, older than a
 * day, or no Cache Storage here). `skipped` counts files the worker could
 * not keep (more than ten, or over the size it holds).
 */
export async function readShare(now = Date.now()) {
  try {
    const cs = store();
    if (!cs) return null;
    const got = await readMeta(cs);
    if (!got) return null;
    const { cache, meta } = got;
    if (!(now - Number(meta.at) <= SHARE_MAX_AGE_MS)) { await clearShare(); return null; }
    const files = [];
    let lost = 0;
    for (const f of Array.isArray(meta.files) ? meta.files : []) {
      const hit = f?.key ? await cache.match(f.key) : null;
      if (!hit) { lost += 1; continue; }
      const blob = await hit.blob();
      files.push(new File([blob], String(f.name || 'Shared File'), { type: f.type || blob.type || '', lastModified: Number(f.lastModified) || Number(meta.at) || now }));
    }
    const words = (v) => (typeof v === 'string' ? v.trim() : '');
    const shared = { at: Number(meta.at), title: words(meta.title), text: words(meta.text), url: words(meta.url), files, skipped: (Number(meta.skipped) || 0) + lost };
    return shared.title || shared.text || shared.url || files.length || shared.skipped ? shared : null;
  } catch { return null; }
}

const SUBJECT_MAX = 120;
const shorten = (line) => (line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 3).replace(/\s+\S*$/, '')}...` : line);

/**
 * The share as words: `subject` (a title line - the shared title, else the
 * first line of the text; a photo alone has none, so the form asks for one)
 * and `body` (the text, with the link on a line of its own unless the text
 * already carries it).
 */
export function shareWords(shared) {
  const { title = '', text = '', url = '' } = shared || {};
  const body = [text, url && !text.includes(url) ? url : ''].filter(Boolean).join('\n');
  const firstLine = (text.split(/\n/).find((l) => l.trim()) || '').trim();
  return { subject: shorten(title || firstLine), body };
}

// What each Quick Action takes from a share. Ticket and task carry the words
// AND the files, through the form's own attachment list (uploaded by its own
// save). A note carries the words only: Notes saves photos and clips through
// its editor's own upload, and other files not at all.
export const SHARE_ACTIONS = ['ticket', 'task', 'note'];
export const carriesFiles = (key) => key === 'ticket' || key === 'task';

/**
 * The seed lib/quickCreate.js runQuickAction hands that action's own form:
 *   ticket - CreateTicketModal `initial` { subject, description (plain text), files }
 *   task   - CreateTaskModal `defaults` { title, description (HTML), files }
 *   note   - Quick Note { html }, written at the end of today's note
 * null when the share has nothing that action takes.
 */
export function shareSeed(key, shared) {
  if (!shared) return null;
  const { subject, body } = shareWords(shared);
  const files = shared.files || [];
  if (key === 'ticket') {
    return subject || body || files.length ? { subject, description: body || subject, files } : null;
  }
  if (key === 'task') {
    // A one-line share is the title alone - not said twice.
    return subject || body || files.length ? { title: subject, description: body && body !== subject ? seedHtml(body) : '', files } : null;
  }
  if (key === 'note') {
    const lines = [shared.title && !body.startsWith(shared.title) ? shared.title : '', body].filter(Boolean).join('\n');
    return lines ? { html: seedHtml(lines) } : null;
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The line under a choice on the Share to Nexus sheet: what that form will
 *  start with - said plainly when a file cannot go along. */
export function carryLine(key, shared) {
  const files = shared?.files?.length || 0;
  const { subject, body } = shareWords(shared);
  const words = !!(subject || body);
  if (carriesFiles(key)) {
    if (words && files) return `Starts with the text filled in and ${plural(files, 'file')} attached.`;
    if (words) return 'Starts with the text filled in.';
    return files ? `Starts with ${plural(files, 'file')} attached.` : 'Starts a blank one.';
  }
  if (words) return files ? 'Takes the text only. Open the note and add the file from your phone.' : "Adds the text to today's Quick Note.";
  return files ? 'A note cannot take the file from here. Open the note and add it from your phone.' : "Opens today's Quick Note.";
}
