// The unsent-form draft (Forms & Checklists, Neil 11/02/2026). One draft per
// template on this device, under `nexus.formDraft.<templateId>`, carrying
// the entryKey it was started with - so a dropped signal, a closed browser
// or a retry sends the SAME entry once, never two. The fill screen offers it
// back ("You have an unsent Vehicle Check from 11/02/2026 2:14 PM") with
// Continue / Discard. Same shape as tickets/PropertyWalkthrough's draft.
import { formatDate, formatTime } from '../lib/datetime';

export const draftKey = (templateId) => `nexus.formDraft.${templateId}`;

/** A fresh entry key - a UUID where the browser has one. */
export function newEntryKey() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* no crypto */ }
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

/** Whether any answer holds something worth keeping. */
export const hasContent = (answers) => Object.values(answers || {}).some((v) => (Array.isArray(v) ? v.length > 0
  : v !== undefined && v !== null && v !== ''));

export function loadDraft(templateId) {
  try {
    const raw = localStorage.getItem(draftKey(templateId));
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d.entryKey === 'string' && d.entryKey && d.answers && typeof d.answers === 'object' ? d : null;
  } catch { return null; }
}

export function saveDraft(templateId, { entryKey, answers, title }) {
  try { localStorage.setItem(draftKey(templateId), JSON.stringify({ entryKey, answers, title: title || '', savedAt: new Date().toISOString() })); }
  catch { /* storage blocked or full - the form still sends */ }
}

export function clearDraft(templateId) {
  try { localStorage.removeItem(draftKey(templateId)); } catch { /* storage blocked */ }
}

/** "You have an unsent Vehicle Check from 11/02/2026 2:14 PM" */
export const draftNotice = (d) => `You have an unsent ${d?.title || 'form'} from ${formatDate(d?.savedAt)} ${formatTime(d?.savedAt)}`;
