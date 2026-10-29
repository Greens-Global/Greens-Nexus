// What people looked for and did not find (Help Center, Oct 2026). Failed
// Help searches, "searched in the ticket form, then filed the ticket anyway"
// and Ask Nexus answers the sources did not cover go to the server's search
// log (backend/routers/help_center.py), where Help Signals (administrators
// only, in Knowledge Base > Manage > Health) lists them - the cheapest way to
// see what the guide and the Knowledge Base are missing. The Health list that
// collection owners read keeps the Knowledge Base's own searches only.
//
// A search is logged once the person stops typing (never per keystroke), and
// the same words from the same box only once per session.
import { useEffect } from 'react';
import { api } from '../api';

export const MISS_PAUSE_MS = 1500;
// Which search box a logged search came from (kb_search_log.source).
export const SOURCE_NAMES = { kb: 'Knowledge Base', help: 'Help Search', ask: 'Ask Nexus', 'ticket-form': 'Ticket Form' };
const sent = new Set();

/** Record one search. Never throws - a log that fails is not the person's problem. */
export function logHelpSearch(q, results, source) {
  const text = String(q || '').trim();
  if (text.length < 3) return;
  const key = `${source}|${text.toLowerCase()}`;
  if (sent.has(key)) return;
  sent.add(key);
  try {
    api.helpSearchLog(text.slice(0, 200), Math.max(0, results | 0), source)?.catch?.(() => {});
  } catch { /* offline, or a test without the api */ }
}

/**
 * Log a Help search that found nothing, once the person pauses.
 * @param {string} q        what is in the box
 * @param {number} results  how many results it shows
 * @param {boolean} ready   false while results are still arriving (the Knowledge Base)
 */
export function useSearchMissLogger(q, results, ready = true) {
  useEffect(() => {
    const text = String(q || '').trim();
    if (!ready || results > 0 || text.length < 3) return undefined;
    const t = setTimeout(() => logHelpSearch(text, 0, 'help'), MISS_PAUSE_MS);
    return () => clearTimeout(t);
  }, [q, results, ready]);
}

/** Test seam - forget what was sent this session. */
export function __resetHelpLog() { sent.clear(); }
