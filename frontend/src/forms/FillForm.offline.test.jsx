import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Fill a Form with no signal - the proof adoption of field offline (Neil,
// 11/03/2026; forms/formsOffline.js, docs/Offline.md). The real outbox and
// store run on an in-memory IndexedDB; only the network is faked.
//   * a form opened once online opens offline from the phone, and says so;
//   * a photo taken offline is held on the phone, not uploaded;
//   * Send offline saves the entry on the phone ("Saved on This Phone");
//   * back online it uploads the photo to task-files/forms/<entryKey>/ and
//     sends the entry ONCE with the same entryKey - a second flush sends
//     nothing more;
//   * online, a send that got no answer is queued too (same entryKey), never
//     lost and never sent twice by the screen.
const formGet = vi.fn();
const formSubmit = vi.fn();
const formsMine = vi.fn();
const storeTaskFile = vi.fn();
vi.mock('../api', () => ({
  api: { formGet: (...a) => formGet(...a), formSubmit: (...a) => formSubmit(...a), formsMine: (...a) => formsMine(...a) },
  getActAsSessionId: () => null,
}));
vi.mock('../tasks/lib', async (orig) => ({ ...(await orig()), storeTaskFile: (...a) => storeTaskFile(...a) }));
vi.mock('../msalInstance', () => ({
  msalInstance: { getActiveAccount: () => ({ username: 'crew@greensglobal.com' }), getAllAccounts: () => [{ username: 'crew@greensglobal.com' }] },
  msalReady: Promise.resolve(),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => true }));

const idb = await import('../lib/offline/idb');
const ob = await import('../lib/offline/outbox');
const status = await import('../lib/offline/status');
const forms = await import('./formsOffline');
const FillForm = (await import('./FillForm')).default;

const TEMPLATE = {
  id: 't1', title: 'Vehicle Check', category: 'vehicle', version: 1, workSites: [],
  fieldDefs: [
    { token: 'plate', label: 'Plate', type: 'text', required: true },
    { token: 'photos', label: 'Photos', type: 'photo' },
  ],
};
const ENTRY = { id: 'e1', templateId: 't1', title: 'Vehicle Check', status: 'submitted' };
const UPLOADED = 'https://x.supabase.co/storage/v1/object/public/task-files/forms/k/gate.jpg';
let online = true;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  idb._resetDb();
  ob._resetOutbox();
  ob.registerKind(forms.KIND, forms.formsEntryKind);
  status._resetStatus();
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  localStorage.clear();
  formGet.mockReset().mockResolvedValue(TEMPLATE);
  formSubmit.mockReset().mockResolvedValue(ENTRY);
  formsMine.mockReset().mockResolvedValue([{ id: 't1', title: 'Vehicle Check' }]);
  storeTaskFile.mockReset().mockResolvedValue(UPLOADED);
  await ob.startOutbox();
});
afterEach(() => { ob._resetOutbox(); });

const goOffline = () => { online = false; window.dispatchEvent(new Event('offline')); };
const goOnline = () => { online = true; window.dispatchEvent(new Event('online')); };
const pickPhoto = () => {
  const input = document.querySelector('input[type="file"]:not([capture])');
  const file = new File([new Uint8Array(64)], 'gate.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
};

describe('FillForm offline', () => {
  it('opens offline from the phone, holds the photo, saves the entry, and sends it once when back online', async () => {
    // Once online: the list and the form are saved on the phone.
    const list = await forms.loadMyForms();
    await forms.prefetchForms(list);
    expect(formGet).toHaveBeenCalledTimes(1);

    goOffline();
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    expect(document.body.textContent).toMatch(/Opened from this phone \(saved \d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2} [AP]M\)/);
    expect(formGet).toHaveBeenCalledTimes(1);                 // not asked again

    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-123' } });
    pickPhoto();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Photo 1' })).toBeTruthy());
    expect(storeTaskFile).not.toHaveBeenCalled();            // held on the phone

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    expect(screen.getByText('Waiting to Send')).toBeTruthy();
    expect(formSubmit).not.toHaveBeenCalled();
    expect(localStorage.getItem('nexus.formDraft.t1')).toBeNull();   // the outbox holds it now

    await act(async () => { goOnline(); });
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect(formSubmit).toHaveBeenCalledTimes(1);
    const [tid, body] = formSubmit.mock.calls[0];
    expect(tid).toBe('t1');
    expect(body.answers).toEqual({ plate: 'TX-123', photos: [UPLOADED] });
    expect(storeTaskFile).toHaveBeenCalledTimes(1);
    expect(storeTaskFile.mock.calls[0][2]).toBe(`forms/${body.entryKey}`);
    const [queued] = await ob.listEntries();
    expect(queued.id).toBe(body.entryKey);                    // the outbox id IS the entryKey

    await act(async () => { await ob.flush({ manual: true }); });
    expect(formSubmit).toHaveBeenCalledTimes(1);              // once
  });

  it('online, a send that got no answer is saved and resent with the same entryKey', async () => {
    formSubmit.mockRejectedValueOnce(Object.assign(new Error("Can't reach Nexus right now."), { isNetworkError: true }));
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    // The outbox sent it again by itself (the backoff is skipped by Sync Now).
    await act(async () => { await status.syncNow(); });
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect(formSubmit).toHaveBeenCalledTimes(2);
    expect(formSubmit.mock.calls[0][1].entryKey).toBe(formSubmit.mock.calls[1][1].entryKey);
  });

  it('a refusal online is shown as before and nothing is queued', async () => {
    formSubmit.mockRejectedValueOnce(Object.assign(new Error('You may not fill this form'), { status: 403 }));
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('You may not fill this form')).toBeTruthy();
    expect(await ob.listEntries()).toEqual([]);
  });
});
