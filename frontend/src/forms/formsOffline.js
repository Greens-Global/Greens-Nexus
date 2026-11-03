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
import { readThrough, getCached, putBlob, swapBlobRefs, blobIdsIn, deleteBlobsFor, isOffline } from '../lib/offline/store';
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
  // A 409 here means the entryKey is another person's or another form's (a
  // reused key): Keep Mine files this entry under a fresh key.
  rebase(payload) {
    const key = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return { ...payload, body: { ...payload.body, entryKey: key } };
  },
  describe(entry) {
    return { title: entry.payload?.title || entry.label || 'Form', detail: 'Form' };
  },
};
registerKind(KIND, formsEntryKind);
