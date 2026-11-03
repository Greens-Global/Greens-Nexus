// Construction in the field, with or without signal (Neil, 11/03/2026: full
// offline for field work NOW; plan phase 3; guide docs/Offline.md). Every
// field write of the daily log, the photo timeline, the punch list and field
// tickets goes through ONE outbox (lib/offline/outbox.js) with ONE idempotency
// mechanism: the entry's id, made on the phone, is the Idempotency-Key the
// server answers a resend with (backend/idempotency.py). Where a record needs
// an id before the server has seen it (a log started offline, a punch item
// added offline, a field ticket) the SAME id is the record's id, so later
// changes can point at it while it waits.
//
//   fieldWrite(kind, { payload, files, group, id, label })
//     online   -> sent now (photos uploaded now); no answer -> queued with the
//                 same id, so a write that did land is answered once
//     offline  -> queued; the outbox sends it, in order, when there is signal
//     a group with something still waiting (a log made offline) -> queued,
//                 so the order holds
//   Resolves { result } (sent now) or { queued: entry } (show <SyncState id>).
//
// Reads go through the phone (store.readThrough): the job's schedule (punch
// list), today's log prefill, the photo timeline, the Changes tab, the logs.
// prefetchJob(job) saves them while there is signal.
import { api } from '../api';
import { enqueue, registerKind, kindHandler, listEntries, newOutboxId } from '../lib/offline/outbox';
import { readThrough, isOffline, OfflineError } from '../lib/offline/store';
import { uploadConstructionMedia } from './lib/upload';

export const K = {
  LOG_CREATE: 'construction:log-create',
  LOG_PATCH: 'construction:log-patch',
  LOG_MEDIA: 'construction:log-media',
  LOG_SUBMIT: 'construction:log-submit',
  JOB_PHOTO: 'construction:job-photo',
  PUNCH_ADD: 'construction:punch-add',
  PUNCH_DONE: 'construction:punch-done',
  PUNCH_VERIFY: 'construction:punch-verify',
  TICKET: 'construction:field-ticket',
};

const unanswered = (e) => !!e && (e.isNetworkError || !e.status);

// ── Reads through the phone ──────────────────────────────────────────────────
export const loadSchedule = (jobId, opts) => readThrough(`construction:schedule:${jobId}`, () => api.getJobSchedule(jobId), opts);
export const loadPrefill = (jobId, day, opts) => readThrough(`construction:prefill:${jobId}:${day}`, () => api.getLogPrefill(jobId, day), opts);
export const loadTimeline = (jobId, opts) => readThrough(`construction:timeline:${jobId}`, () => api.getJobTimeline(jobId), opts);
export const loadChanges = (jobId, opts) => readThrough(`construction:changes:${jobId}`, () => api.getJobChanges(jobId), opts);
export const loadLogs = (jobId, opts) => readThrough(`construction:logs:${jobId}`, () => api.getConstructionLogs(jobId), opts);
export const loadProjects = (opts) => readThrough('construction:projects', () => api.getConstructionProjects(), opts);

/** Save what the field needs for this job while there is signal (quietly). */
const prefetched = new Map();
const PREFETCH_EVERY_MS = 5 * 60 * 1000;
export async function prefetchJob(job) {
  if (!job?.id || isOffline()) return;
  // Once a job every few minutes: the screens call this on every visit, and
  // the rate limiter counts every read.
  const last = prefetched.get(job.id) || 0;
  if (Date.now() - last < PREFETCH_EVERY_MS) return;
  prefetched.set(job.id, Date.now());
  await new Promise((r) => setTimeout(r, 1500));   // after the screen's own reads
  const day = job.today || '';
  for (const load of [() => loadSchedule(job.id), () => loadPrefill(job.id, day), () => loadTimeline(job.id),
    () => loadChanges(job.id), () => loadLogs(job.id)]) {
    try { await load(); } catch { /* the next visit tries again */ }
    if (isOffline()) break;
  }
}

// ── Photos: uploaded once, the upload's answer kept on the entry ─────────────
async function uploadPayload(ctx, blobId, projectId) {
  const raw = await ctx.uploadOnce(blobId, async (file) => {
    const { payload, error } = await uploadConstructionMedia(file, { projectId });
    // A file the rules refuse is an answer (Not Sent with the reason); a
    // failed upload is not - the outbox tries again.
    if (error) throw Object.assign(new Error(error), /not supported|limit is|empty|cannot be read/i.test(error) ? { status: 422 } : {});
    return JSON.stringify(payload);
  });
  try { return JSON.parse(raw); } catch { return { url: raw }; }
}

const idOf = (ctx, entry) => (entry.payload.createId && ctx.result(entry.payload.createId)?.id) || entry.payload.logId;

// ── The kinds (kinds.js loads this module for any of them) ───────────────────
const handlers = {
  [K.LOG_CREATE]: {
    send: (e, ctx) => api.startConstructionLog(e.payload.projectId, e.payload.body, { headers: ctx.headers }),
    describe: (e) => ({ title: 'Daily Log', detail: `Started ${e.payload.body?.log_date || ''}` }),
  },
  [K.LOG_PATCH]: {
    send: (e, ctx) => api.updateConstructionLog(idOf(ctx, e), e.payload.patch, { headers: ctx.headers }),
    // A log submitted since (on another phone) takes no more edits: an answer.
    classify: (err) => (err?.status === 409 ? 'failed' : null),
    describe: () => ({ title: 'Daily Log', detail: 'Notes and conditions' }),
  },
  [K.LOG_MEDIA]: {
    async send(e, ctx) {
      const payload = await uploadPayload(ctx, e.blobs[0], e.payload.projectId);
      return api.createConstructionMedia(idOf(ctx, e), { ...payload, ...(e.payload.meta || {}) }, { headers: ctx.headers });
    },
    classify: (err) => (err?.status === 409 ? 'failed' : null),
    describe: () => ({ title: 'Daily Log', detail: 'Photo' }),
  },
  [K.LOG_SUBMIT]: {
    async send(e, ctx) {
      try {
        return await api.submitConstructionLogSigned(idOf(ctx, e), e.payload.signedName, { headers: ctx.headers });
      } catch (err) {
        // Submitted already (the answer was lost, then the key expired): done.
        if (err?.status === 409 && /already (submitted|processed|approved)/i.test(err.message || '')) return { alreadySubmitted: true };
        throw err;
      }
    },
    classify: (err) => (err?.status === 409 ? 'failed' : null),
    describe: () => ({ title: 'Daily Log', detail: 'Submit' }),
  },
  [K.JOB_PHOTO]: {
    async send(e, ctx) {
      const payload = await uploadPayload(ctx, e.blobs[0], e.payload.projectId);
      return api.addJobMedia(e.payload.projectId, { ...payload, ...(e.payload.meta || {}), id: e.id }, { headers: ctx.headers });
    },
    describe: () => ({ title: 'Job Photo', detail: '' }),
  },
  [K.PUNCH_ADD]: {
    send: (e, ctx) => api.addPunchItemQueued(e.payload.jobId, e.payload.body, { headers: ctx.headers }),
    describe: (e) => ({ title: 'Punch Item', detail: e.payload.body?.title || '' }),
  },
  [K.PUNCH_DONE]: {
    async send(e, ctx) {
      const photo = e.blobs?.length ? await uploadPayload(ctx, e.blobs[0], e.payload.jobId) : null;
      return api.setPunchDoneWithPhoto(e.payload.taskId, e.payload.done, photo, { headers: ctx.headers });
    },
    describe: (e) => ({ title: 'Punch Item', detail: e.payload.done ? 'Marked Done' : 'Not Done' }),
  },
  [K.PUNCH_VERIFY]: {
    send: (e, ctx) => api.setPunchVerifiedQueued(e.payload.taskId, e.payload.verified, { headers: ctx.headers }),
    describe: (e) => ({ title: 'Punch Item', detail: e.payload.verified ? 'Verified' : 'Unverified' }),
  },
  [K.TICKET]: {
    async send(e, ctx) {
      const { jobId, body, photoCount = 0 } = e.payload;
      const urls = [];
      for (let i = 0; i < photoCount; i += 1) urls.push((await uploadPayload(ctx, e.blobs[i], jobId)).url);
      const sigBlob = e.blobs[photoCount];
      const signature = sigBlob ? (await uploadPayload(ctx, sigBlob, jobId)).url : '';
      return api.createFieldTicket(jobId, { ...body, id: e.id, photo_urls: [...(body.photo_urls || []), ...urls],
        ...(signature ? { signature_url: signature } : {}) }, { headers: ctx.headers });
    },
    describe: (e) => ({ title: 'Field Ticket', detail: (e.payload.body?.description || '').slice(0, 60) }),
  },
};
/** Register every construction kind (at import; again after a test reset). */
export function registerConstructionKinds() { Object.entries(handlers).forEach(([k, h]) => registerKind(k, h)); }
registerConstructionKinds();

// ── One write, now or later ──────────────────────────────────────────────────
async function groupWaiting(group) {
  if (!group) return false;
  try {
    return (await listEntries()).some((x) => x.group === group && ['pending', 'sending', 'parked'].includes(x.state));
  } catch { return false; }
}

/** See the file's header. `files` are File/Blob objects (photos, a signature). */
export async function fieldWrite(kind, { payload, files = [], group = '', id = '', label = '', after = [] }) {
  const entryId = id || newOutboxId();
  const queue = () => enqueue({ id: entryId, kind, group: group || kind, payload, blobs: files, label, after })
    .then((entry) => ({ queued: entry }));
  if (isOffline() || await groupWaiting(group)) return queue();
  const handler = kindHandler(kind);
  const direct = { id: entryId, kind, payload, blobs: files.map((_, i) => `direct:${i}`) };
  const ctx = {
    idempotencyKey: entryId,
    headers: { 'Idempotency-Key': entryId },
    uploadOnce: async (blobId, upload) => upload(files[Number(String(blobId).split(':')[1])]),
    result: () => null,
    uploadedUrl: () => null,
  };
  try {
    return { result: await handler.send(direct, ctx) };
  } catch (e) {
    if (!unanswered(e)) throw e;
    // This browser cannot keep it (private browsing, Act As): the person sees
    // the send's own failure and keeps what they typed on screen.
    try { return await queue(); } catch (q) { if (q instanceof OfflineError) throw e; throw q; }
  }
}

// ── The daily log ────────────────────────────────────────────────────────────
const logGroup = (logId) => `construction:log:${logId}`;

/** Start today's log. Online: the server drafts it (its prefill); offline: a
 *  log made here from the phone's saved prefill, sent when there is signal. */
export async function startLog(project, day, prefill) {
  const logId = `log-${newOutboxId()}`;
  const body = { id: logId, log_date: day };
  let first = null;
  if (!isOffline()) {
    try { return await api.startConstructionLog(project.id, body, { headers: { 'Idempotency-Key': logId } }); } catch (e) { if (!unanswered(e)) throw e; first = e; }
  }
  const crew = prefill?.crew || {};
  const w = prefill?.weather || null;
  const local = {
    ...body, weather: w?.text || '', temperature_f: w?.temperatureF ?? null, crew_size: crew.count || null,
    hours_worked: crew.hours || null, weather_source: w ? 'forecast' : '', delays: prefill?.suggestedDelays || [],
    prefill: prefill ? { at: new Date().toISOString(), weather: w, crew: { count: crew.count || 0, hours: crew.hours || 0 },
      photos: (prefill.photos || []).map((p) => p.id), punchDone: (prefill.punch?.done || []).map((p) => p.id),
      punchVerified: (prefill.punch?.verified || []).map((p) => p.id), forms: (prefill.forms || []).map((f) => f.id) } : null,
  };
  let entry;
  try {
    entry = await enqueue({ id: logId, kind: K.LOG_CREATE, group: logGroup(logId), label: 'Daily Log',
      payload: { projectId: project.id, body: local } });
  } catch (q) {
    if (first && q instanceof OfflineError) throw first;   // this browser cannot keep it: the send's own failure
    throw q;
  }
  return {
    id: logId, projectId: project.id, logDate: day, status: 'draft', local: true, createEntryId: entry.id,
    notes: '', weather: local.weather, temperatureF: local.temperature_f || 0, crewSize: local.crew_size || 0,
    hoursWorked: local.hours_worked || 0, tags: [], delays: local.delays, prefill: local.prefill || {},
  };
}

const logPayload = (log, extra) => ({ logId: log.id, createId: log.createEntryId || '', ...extra });

export const saveLogPatch = (log, patch) => fieldWrite(K.LOG_PATCH, { payload: logPayload(log, { patch }), group: logGroup(log.id), label: 'Daily Log' });
export const addLogPhoto = (log, project, file, meta = {}) => fieldWrite(K.LOG_MEDIA, {
  payload: logPayload(log, { projectId: project.id, meta }), files: [file], group: logGroup(log.id), label: 'Daily Log Photo',
});
export const submitLog = (log, signedName) => fieldWrite(K.LOG_SUBMIT, { payload: logPayload(log, { signedName }), group: logGroup(log.id), label: 'Daily Log' });

// ── Job photos, punch, field tickets ─────────────────────────────────────────
export const addJobPhoto = (project, file, meta = {}) => fieldWrite(K.JOB_PHOTO, {
  payload: { projectId: project.id, meta }, files: [file], group: `construction:photos:${project.id}`, label: 'Job Photo',
});
const punchGroup = (jobId) => `construction:punch:${jobId}`;
export const addPunch = (jobId, body) => fieldWrite(K.PUNCH_ADD, { id: body.id, payload: { jobId, body }, group: punchGroup(jobId), label: 'Punch Item' });
export const markPunchDone = (jobId, taskId, done, photo) => fieldWrite(K.PUNCH_DONE, {
  payload: { jobId, taskId, done }, files: photo ? [photo] : [], group: punchGroup(jobId), label: 'Punch Item',
});
export const markPunchVerified = (jobId, taskId, verified) => fieldWrite(K.PUNCH_VERIFY, {
  payload: { jobId, taskId, verified }, group: punchGroup(jobId), label: 'Punch Item',
});
/** A field ticket, photos and the customer's signature with it. */
export const sendFieldTicket = (jobId, id, body, photos = [], signature = null) => fieldWrite(K.TICKET, {
  id, payload: { jobId, body, photoCount: photos.length }, files: [...photos, ...(signature ? [signature] : [])],
  group: `construction:ticket:${id}`, label: 'Field Ticket',
});
