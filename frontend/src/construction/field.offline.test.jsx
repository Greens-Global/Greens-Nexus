// Construction in the field with no signal (Neil, 11/03/2026: full offline for
// field work NOW; plan phase 3; docs/Offline.md). The flows that matter on a
// jobsite with no bars, on fake-indexeddb:
//   * a daily log started offline, a photo on it, the edits and the Submit
//     wait on the phone and go out ONCE, in order, the log's phone-made id
//     standing in until the server answers (and the server's id after);
//   * a punch item marked Done offline with its photo: the photo is uploaded
//     once and the Done sent once;
//   * a field ticket with photos and the customer's signature, captured with
//     no signal, lands as ONE ticket with both uploaded;
//   * the screen says Saved on This Phone (SyncState) and nothing is lost;
//   * every send carries the entry's id as the Idempotency-Key.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../msalInstance', () => ({ msalInstance: { getActiveAccount: () => null, getAllAccounts: () => [] }, msalReady: Promise.resolve() }));
vi.mock('../api', () => ({
  getActAsSessionId: () => null,
  api: {
    startConstructionLog: vi.fn(), updateConstructionLog: vi.fn(), createConstructionMedia: vi.fn(),
    submitConstructionLogSigned: vi.fn(), setPunchDoneWithPhoto: vi.fn(), createFieldTicket: vi.fn(),
    getLogPrefill: vi.fn(), getConstructionMedia: vi.fn(async () => []), addJobMedia: vi.fn(),
    deleteConstructionMedia: vi.fn(), removeConstructionMedia: vi.fn(),
  },
}));
let uploads = 0;
vi.mock('./lib/upload', () => ({
  uploadConstructionMedia: vi.fn(async (file) => { uploads += 1; return { error: null, payload: { kind: 'photo', url: `https://s/construction-media/construction/j1/${file.name}`, mime_type: file.type, size_bytes: file.size, storage_path: `construction/j1/${file.name}` } }; }),
  validate: () => '', kindOf: () => 'photo', filesFromPaste: () => [],
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'crew@greensglobal.com' }) }));
vi.mock('../lib/offline/kinds', () => ({ loadKind: async () => { (await import('./constructionOffline')).registerConstructionKinds(); return true; } }));

const idb = await import('../lib/offline/idb');
const ob = await import('../lib/offline/outbox');
const status = await import('../lib/offline/status');
const { _setIdentity } = await import('../lib/offline/identity');
const { api } = await import('../api');
const co = await import('./constructionOffline');
const { default: DailyLogCapture } = await import('./DailyLogCapture');

let online = true;
const project = { id: 'j1', name: 'Gate Motor Repair', today: '2026-11-03' };
const prefill = {
  date: '2026-11-03', weather: { text: 'Sunny, high 74°F / low 55°F', temperatureF: 68, source: 'forecast' },
  crew: { count: 3, hours: 21 }, photos: [], punch: { done: [], verified: [] }, forms: [], suggestedDelays: [],
};
const photo = (n) => new File([`bytes-${n}`], `${n}.jpg`, { type: 'image/jpeg' });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  idb._resetDb();
  ob._resetOutbox();
  co.registerConstructionKinds();
  status._resetStatus();
  uploads = 0;
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  _setIdentity({ email: 'crew@greensglobal.com' });
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); ob._resetOutbox(); _setIdentity(undefined); });

describe('a daily log with no signal', () => {
  it('starts on the phone from the saved prefill, and the log, its photo, the edit and the Submit go out once, in order', async () => {
    online = false;
    const log = await co.startLog(project, '2026-11-03', prefill);
    expect(log.local).toBe(true);
    expect(log.crewSize).toBe(3);
    expect(log.weather).toBe('Sunny, high 74°F / low 55°F');
    const p = await co.addLogPhoto(log, project, photo('north-wall'));
    const e = await co.saveLogPatch(log, { notes_raw: 'Footings poured', delays: [{ cause: 'weather', hours: 1.5, note: 'Rain' }] });
    const s = await co.submitLog(log, 'Crew Person');
    for (const out of [p, e, s]) expect(out.queued).toBeTruthy();
    expect(api.startConstructionLog).not.toHaveBeenCalled();

    // The server already had a draft for the day: it answers with ITS id, and
    // everything queued behind the start follows that id.
    const order = [];
    api.startConstructionLog.mockImplementation(async (pid, body, opts) => { order.push(['start', opts.headers['Idempotency-Key']]); return { id: 'srv-log-1', status: 'draft' }; });
    api.createConstructionMedia.mockImplementation(async (id, body) => { order.push(['media', id, body.url]); return { id: 'm1' }; });
    api.updateConstructionLog.mockImplementation(async (id, patch) => { order.push(['patch', id, patch.notes_raw]); return {}; });
    api.submitConstructionLogSigned.mockImplementation(async (id, name) => { order.push(['submit', id, name]); return { status: 'submitted' }; });
    online = true;
    await ob.flush({ manual: true });
    await ob.flush({ manual: true });        // again: nothing twice
    expect(order).toEqual([
      ['start', log.id],
      ['media', 'srv-log-1', 'https://s/construction-media/construction/j1/north-wall.jpg'],
      ['patch', 'srv-log-1', 'Footings poured'],
      ['submit', 'srv-log-1', 'Crew Person'],
    ]);
    expect(uploads).toBe(1);
    const body = api.startConstructionLog.mock.calls[0][1];
    expect(body).toEqual(expect.objectContaining({ id: log.id, log_date: '2026-11-03', crew_size: 3, weather_source: 'forecast' }));
    expect(body.prefill.crew).toEqual({ count: 3, hours: 21 });
  });

  it('the capture sheet says Saved on This Phone after an offline Submit, and keeps nothing back', async () => {
    online = false;
    const log = await co.startLog(project, '2026-11-03', prefill);
    const onSubmitted = vi.fn();
    const { container } = render(<DailyLogCapture log={log} project={project} onClose={() => {}} onSubmitted={onSubmitted} />);
    expect(screen.getByDisplayValue('Sunny, high 74°F / low 55°F')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Anything the photos do not show/i), { target: { value: 'Gate motor swapped' } });
    fireEvent.change(container.querySelector('input[accept="image/*"][capture="environment"]'), { target: { files: [photo('gate')] } });
    await waitFor(() => expect(container.querySelector('[data-capture-item]')).toBeTruthy());
    const submit = screen.getByRole('button', { name: /Submit/ });
    expect(submit).toBeDisabled();                         // the typed-name signature first
    fireEvent.change(screen.getByLabelText('Sign With Your Name'), { target: { value: 'Crew Person' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    expect(await screen.findByText('Saved on This Phone')).toBeInTheDocument();
    const waiting = (await ob.listEntries()).filter((x) => x.state !== 'sent').map((x) => x.kind);
    expect(waiting).toEqual(['construction:log-create', 'construction:log-media', 'construction:log-patch', 'construction:log-submit']);
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

describe('punch Done with no signal', () => {
  it('holds the photo, then uploads it once and sends Done once with the entry id as the key', async () => {
    online = false;
    const out = await co.markPunchDone('j1', 'punch-1', true, photo('done'));
    expect(out.queued.kind).toBe('construction:punch-done');
    api.setPunchDoneWithPhoto.mockResolvedValue({ id: 'punch-1', completed: true });
    online = true;
    await ob.flush({ manual: true });
    await ob.flush({ manual: true });
    expect(api.setPunchDoneWithPhoto).toHaveBeenCalledTimes(1);
    expect(api.setPunchDoneWithPhoto).toHaveBeenCalledWith('punch-1', true,
      expect.objectContaining({ url: 'https://s/construction-media/construction/j1/done.jpg' }),
      { headers: { 'Idempotency-Key': out.queued.id } });
    expect(uploads).toBe(1);
  });

  it('a send that gets no answer online is kept and sent again with the SAME key', async () => {
    const keys = [];
    api.setPunchDoneWithPhoto.mockImplementation(async (id, done, ph, opts) => {
      keys.push(opts.headers['Idempotency-Key']);
      if (keys.length === 1) throw Object.assign(new Error("Can't reach Nexus"), { isNetworkError: true });
      return {};
    });
    const out = await co.markPunchDone('j1', 'punch-2', true, photo('again'));
    expect(out.queued).toBeTruthy();
    await ob.flush({ manual: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('a field ticket and its signature with no signal', () => {
  it('lands as ONE ticket with the photos and the signature uploaded', async () => {
    online = false;
    const sig = new File(['sig'], 'signature.png', { type: 'image/png' });
    const out = await co.sendFieldTicket('j1', 'ft-phone-1', { description: 'Moved the gas line', customer_name: 'Dana Owens', signed_name: 'Dana Owens' },
      [photo('a'), photo('b')], sig);
    expect(out.queued.id).toBe('ft-phone-1');
    api.createFieldTicket.mockResolvedValue({ id: 'ft-phone-1', status: 'signed' });
    online = true;
    await ob.flush({ manual: true });
    await ob.flush({ manual: true });
    expect(api.createFieldTicket).toHaveBeenCalledTimes(1);
    const [jobId, body, opts] = api.createFieldTicket.mock.calls[0];
    expect(jobId).toBe('j1');
    expect(body.id).toBe('ft-phone-1');
    expect(body.photo_urls).toEqual(['https://s/construction-media/construction/j1/a.jpg', 'https://s/construction-media/construction/j1/b.jpg']);
    expect(body.signature_url).toBe('https://s/construction-media/construction/j1/signature.png');
    expect(opts.headers['Idempotency-Key']).toBe('ft-phone-1');
    expect(uploads).toBe(3);
  });
});
