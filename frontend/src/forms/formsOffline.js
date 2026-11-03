// Fill a Form with no signal (field offline, Neil 11/03/2026; the proof
// adoption of docs/Offline.md). Still ONE engine and ONE entry store
// (CLAUDE.md, Forms): this only decides WHEN the existing send happens.
//
//   * loadMyForms() / loadForm(id) read through the phone (store.readThrough):
//     online from the server, saved for later; offline from what was saved.
//     prefetchForms(forms) saves every form's fill screen the first time the
//     list loads online, so a form never opened before still opens offline.
//   * keepPhoto(file, entryKey) holds a photo or signature taken offline on
//     the phone; the answer carries `nexus-offline:<id>` until it uploads.
//   * queueEntry(...) puts a finished entry in the outbox when it cannot go
//     now. The outbox's 'forms:entry' kind uploads the held photos to
//     task-files/forms/<entryKey>/ (each once - the URL is kept on the entry)
//     and then sends the SAME POST /forms/{id}/entries the screen sends,
//     idempotent on the entryKey the draft was started with - the server
//     answers a resend with the first entry, never a second row.
import { api } from '../api';
import { storeTaskFile } from '../tasks/lib';
import { readThrough, getCached, putBlob, swapBlobRefs, blobIdsIn, deleteBlobsFor, isOffline, adoptBlobs, blobRef, signedInEmail, deleteBlob, OfflineError } from '../lib/offline/store';
import { currentIdentity } from '../lib/offline/identity';
import { saveDraft, newEntryKey } from './formDraft';
import { enqueue, registerKind } from '../lib/offline/outbox';

export const KIND = 'forms:entry';
const FOLDER = (entryKey) => `forms/${entryKey}`;
const PREFETCH_MAX = 30;
const PREFETCH_STALE_MS = 6 * 3600 * 1000;

const asList = (r) => (Array.isArray(r) ? r : r?.forms || []);

/** The forms this person may fill (GET /forms/mine), kept on the phone. */
export async function loadMyForms(opts) {
  return asList(await readThrough('forms:mine', () => api.formsMine(), opts));
}

/** One form's fill screen (GET /forms/{id}), kept on the phone. */
export function loadForm(templateId, opts) {
  return readThrough(`forms:template:${templateId}`, () => api.formGet(templateId), opts);
}

/** Save the fill screen of every form on the list that this phone does not
 *  hold yet (or holds from more than 6 hours ago), one at a time, quietly. */
export async function prefetchForms(forms) {
  if (isOffline()) return 0;
  let n = 0;
  for (const f of (forms || []).slice(0, PREFETCH_MAX)) {
    if (!f?.id) continue;
    const have = await getCached(`forms:template:${f.id}`);
    if (have && Date.now() - Date.parse(have.savedAt) < PREFETCH_STALE_MS) continue;
    try { await loadForm(f.id); n += 1; } catch { /* the next list load tries again */ }
    if (isOffline()) break;
  }
  return n;
}

/** Hold a photo / signature on the phone for the entry `entryKey`. Returns
 *  the value the answer carries until it uploads. Throws an OfflineError
 *  when the phone is full. */
export async function keepPhoto(file, entryKey) {
  // Not while acting as someone: nothing waits on the phone under Act As
  // (outbox.js) - the photo needs signal then.
  if (currentIdentity()?.actAs) {
    throw new OfflineError('While you are acting as someone else, photos are not kept on this phone. Take it again when you have signal.', 'act-as');
  }
  const id = await putBlob(file, { ref: `draft:${entryKey}`, name: file?.name || 'photo.jpg' });
  return `nexus-offline:${id}`;
}

/** A discarded draft lets its held photos go. */
export const dropHeldPhotos = (entryKey) => deleteBlobsFor(`draft:${entryKey}`);

export const isOfflineNow = () => isOffline();

/** Does this send error mean "no answer" (so the entry should wait in the
 *  outbox) rather than a refusal the person must see? */
export const unanswered = (e) => !!e && (e.isNetworkError || !e.status);

/**
 * Queue a finished entry. `body` is exactly what the screen would POST:
 * { entryKey, answers, workSiteId, shiftId, source, gps? }. The outbox id IS
 * the entryKey, so the same entry queued twice is one entry.
 */
export function queueEntry({ templateId, title, body }) {
  return enqueue({
    id: body.entryKey,
    kind: KIND,
    group: KIND,
    label: title || 'Form',
    payload: { templateId, title: title || '', body },
    blobIds: blobIdsIn(body.answers),
  });
}

async function uploadHeld(file, entryKey) {
  try {
    return await storeTaskFile(file, null, FOLDER(entryKey));
  } catch (e) {
    // The storage answered no (too big, not allowed): an answer, not a
    // dropped signal - the entry is refused with the reason.
    if (e?.status && e.status < 500) throw Object.assign(new Error(`A photo could not be uploaded: ${e.message}`), { status: 422 });
    throw e;
  }
}

/** The outbox handler for a queued entry (registered below, once). */
export const formsEntryKind = {
  async send(entry, ctx) {
    const { templateId, body } = entry.payload;
    const answers = await swapBlobRefs(body.answers, (blobId) => ctx.uploadOnce(blobId, (file) => uploadHeld(file, body.entryKey)));
    return api.formSubmit(templateId, { ...body, answers });
  },
  // A 409 from POST /forms/{id}/entries (routers/forms.py) is either the
  // insert race ("Could not file the entry - try again": two tries of the
  // SAME entry crossed, the next try finds the first one by its entryKey and
  // gets it back) - so it is retried with the same key, never a new one,
  // which could file a second entry - or a key that is another person's or
  // another form's ("belongs to another entry"), which no retry can fix: a
  // refusal, fixed with "Open and Fix" (a fresh key - below).
  classify(e) {
    if (e?.status !== 409) return null;
    return /another entry/i.test(String(e?.message || '')) ? 'failed' : 'unknown';
  },
  // "Open and Fix" for an entry the server refused on replay (a 400 with the
  // form's own rule, a 403): the answers go back into the fill screen's draft
  // on this phone - same entryKey, photos already uploaded as their URLs and
  // the rest handed to the draft - and Workday opens the form, which offers
  // the draft. Nothing the person did is lost.
  async fix(entry, ctx) {
    const { templateId, title, body } = entry.payload;
    const keyTaken = /another entry/i.test(entry.error || '');
    const entryKey = keyTaken ? newEntryKey() : body.entryKey;
    const answers = await swapBlobRefs(body.answers, async (blobId) => {
      const url = await ctx.uploadedUrl(blobId);
      return url || blobRef(blobId);
    });
    const held = blobIdsIn(answers);
    await adoptBlobs(held, `draft:${entryKey}`);
    // Photos already uploaded travel as their URLs; their phone copies go.
    for (const id of entry.blobs || []) if (!held.includes(id)) await deleteBlob(id);
    saveDraft(templateId, { entryKey, answers, title }, signedInEmail());
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock', sub: `form:${templateId}` } }));
  },
  describe(entry) {
    return { title: entry.payload?.title || entry.label || 'Form', detail: 'Form' };
  },
};
registerKind(KIND, formsEntryKind);
