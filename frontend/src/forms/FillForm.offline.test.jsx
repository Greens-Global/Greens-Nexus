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
const actAs = vi.hoisted(() => ({ id: null }));
vi.mock('../api', () => ({
  api: { formGet: (...a) => formGet(...a), formSubmit: (...a) => formSubmit(...a), formsMine: (...a) => formsMine(...a) },
  getActAsSessionId: () => actAs.id,
}));
vi.mock('../tasks/lib', async (orig) => ({ ...(await orig()), storeTaskFile: (...a) => storeTaskFile(...a) }));
vi.mock('../msalInstance', () => ({
  msalInstance: { getActiveAccount: () => ({ username: 'crew@greensglobal.com' }), getAllAccounts: () => [{ username: 'crew@greensglobal.com' }] },
  msalReady: Promise.resolve(),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => true }));
// The draft is the signed-in person's (formDraft.js keys it by email).
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'crew@greensglobal.com' }) }));

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
  actAs.id = null;
  await ob.startOutbox();
});
afterEach(() => { ob._resetOutbox(); });

const goOffline = () => { online = false; window.dispatchEvent(new Event('offline')); };
// Open the form once online, so the phone has it (the save is not awaited by readThrough).
const prime = async () => { await forms.loadForm('t1'); await new Promise((r) => setTimeout(r, 30)); };
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
    expect(localStorage.getItem('nexus.formDraft.crew@greensglobal.com.t1')).toBeNull();   // the outbox holds it now

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

  it('a 409 on replay (two tries crossed) is retried with the SAME entryKey - never a second entry', async () => {
    await prime();
    goOffline();
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    formSubmit.mockRejectedValueOnce(Object.assign(new Error('Could not file the entry - try again'), { status: 409 }));
    await act(async () => { goOnline(); });
    await waitFor(() => expect(formSubmit).toHaveBeenCalled());
    // A race, not a choice: never "Needs Your Choice" - it goes again by itself.
    await act(async () => { await ob.flush({ manual: true }); });
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect((await ob.listEntries())[0].state).toBe('sent');
    expect(formSubmit).toHaveBeenCalledTimes(2);
    expect(formSubmit.mock.calls[1][1].entryKey).toBe(formSubmit.mock.calls[0][1].entryKey);
  });

  it('refused on replay: Open and Fix puts the answers and photos back in the form with the same entryKey', async () => {
    await prime();
    goOffline();
    const first = render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-77' } });
    pickPhoto();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Photo 1' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    first.unmount();
    // The photo uploads, then the server refuses the entry (a form rule).
    formSubmit.mockRejectedValueOnce(Object.assign(new Error('Plate: must be 6 letters'), { status: 400 }));
    await act(async () => { goOnline(); });
    await waitFor(async () => expect((await ob.listEntries())[0].state).toBe('failed'));
    const [failed] = await ob.listEntries();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    expect(await ob.fixEntry(failed.id)).toBe(true);
    window.removeEventListener('nexus:navigate', nav);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'timeclock', sub: 'form:t1' });
    expect(await ob.listEntries()).toEqual([]);
    const draft = JSON.parse(localStorage.getItem('nexus.formDraft.crew@greensglobal.com.t1'));
    expect(draft.entryKey).toBe(failed.payload.body.entryKey);
    expect(draft.answers).toEqual({ plate: 'TX-77', photos: [UPLOADED] });   // uploaded once, kept as its URL
    // The form opens with the draft offered; Continue and Send files the same entry.
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX7777' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(2));
    expect(formSubmit.mock.calls[1][1].entryKey).toBe(failed.payload.body.entryKey);
    expect(formSubmit.mock.calls[1][1].answers.photos).toEqual([UPLOADED]);
    expect(storeTaskFile).toHaveBeenCalledTimes(1);
  });

  it('a photo still on the phone goes back to the draft too (it was never uploaded)', async () => {
    await prime();
    goOffline();
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-5' } });
    pickPhoto();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Photo 1' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Saved on This Phone')).toBeTruthy();
    // Mark it refused without sending (as if the upload's storage said no).
    const [q] = await ob.listEntries();
    await idb.put('outbox', { ...q, state: 'failed', error: 'A photo could not be uploaded: too big' });
    ob._resetOutbox();
    ob.registerKind(forms.KIND, forms.formsEntryKind);
    expect(await ob.fixEntry(q.id)).toBe(true);
    const draft = JSON.parse(localStorage.getItem('nexus.formDraft.crew@greensglobal.com.t1'));
    const ref = draft.answers.photos[0];
    expect(ref).toMatch(/^nexus-offline:/);
    const { getBlob } = await import('../lib/offline/store');
    expect(await getBlob(ref.slice('nexus-offline:'.length))).not.toBeNull();
  });

  it('while acting as someone, an offline Send is not kept on the phone - it says so', async () => {
    actAs.id = 'session-1';
    await prime();
    goOffline();
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.change(screen.getByLabelText('Plate'), { target: { value: 'TX-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/While you are acting as someone else, changes are not saved on this phone/)).toBeTruthy();
    expect(await ob.listEntries()).toEqual([]);
  });
});
