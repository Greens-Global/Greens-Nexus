import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';

// The shell of PDF Tools, with the engine in the iframe stubbed: what the bridge
// would say is dispatched as window messages, and whatever is posted to the frame
// is recorded. The real engine and the real bridge are not loaded here (the bridge
// has nexusBridge.test.js, the engine's interface lands on another branch).

const h = vi.hoisted(() => ({
  role: { can: () => true, myGrantedModules: new Map() },
  confirm: null,
}));

vi.mock('../api', () => ({
  api: {
    egnyteStatus: vi.fn(),
    egnyteFolder: vi.fn(),
    egnyteFile: vi.fn(),
    egnyteUpload: vi.fn(),
    egnyteOauthStart: vi.fn(),
    pdfToolsEvent: vi.fn(() => Promise.resolve({ ok: true })),
    getDocumentLibrary: vi.fn(() => Promise.resolve([])),
    listPacketDocuments: vi.fn(() => Promise.resolve([])),
    exportDocumentPdf: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => h.role }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => h.confirm(...a) } }));
vi.mock('../ui/HoldButton', () => ({ HOLD_RECORD_MS: 1200, default: () => null }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, onClose }) => (
    <div role="dialog" aria-label={title}><button type="button" onClick={onClose}>Close Modal</button>{children}</div>
  ),
}));
vi.mock('../components/DocumentSidePanel', () => ({ StatusWord: ({ status }) => <span>{status.label}</span> }));

const { api } = await import('../api');
const { hasUnsavedWork, setInlineDirty } = await import('../lib/dialogGuard');
const { setPendingOpen, takePendingOpen, __clearPendingOpen } = await import('../lib/pendingOpen');
const { ESIGN_PREFILL_PENDING, PDF_TOOLS_PENDING } = await import('../lib/pdfToolsHandoff');
const { default: PdfEditorModule } = await import('./PdfEditorModule');

const ORIGIN = window.location.origin;

// A message as the browser would deliver it.
function deliver(data, { origin = ORIGIN, source } = {}) {
  const e = new Event('message');
  e.data = data;
  e.origin = origin;
  e.source = source;
  act(() => { window.dispatchEvent(e); });
}

// Mount the module with a stub engine answering behind the iframe.
function mount({ open = { ok: true, pages: 3 }, build = { ok: true, name: 'Lease.pdf', pages: 3 }, ready = true } = {}) {
  const view = render(<PdfEditorModule />);
  const frame = view.container.querySelector('iframe');
  const win = frame.contentWindow;
  const posted = [];
  const answer = (data) => setTimeout(() => deliver(data, { source: win }), 0);
  win.postMessage = vi.fn((msg, origin, transfer) => {
    posted.push({ msg, origin, transfer });
    if (msg.type === 'nexus:pdf-open') {
      answer({ type: 'pdf-bridge:reply', id: msg.id, name: msg.name, ...open });
    }
    if (msg.type === 'nexus:pdf-build') {
      answer({ type: 'pdf-bridge:reply', id: msg.id, bytes: new Uint8Array([1, 2, 3]).buffer, ...build });
    }
  });
  const say = (data, opts) => deliver(data, { source: win, ...opts });
  if (ready) say({ type: 'pdf-bridge:ready', engine: true });
  const sent = (type) => posted.filter(p => p.msg.type === type);
  const lastConfig = () => sent('nexus:pdf-config').at(-1)?.msg;
  return { ...view, frame, win, posted, say, sent, lastConfig };
}

const openDoc = (say, over = {}) => say({ type: 'pdf-bridge:state', hasDoc: true, dirty: false, name: 'Lease.pdf', pages: 3, redacted: false, ...over });
const ask = (say, action) => say({ type: 'pdf-bridge:action', action });
const blobOf = () => ({ blob: { arrayBuffer: () => Promise.resolve(new Uint8Array([7, 7]).buffer) }, filename: 'x.pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = { can: () => true, myGrantedModules: new Map() };
  h.confirm = vi.fn(() => Promise.resolve(true));
  __clearPendingOpen();
  setInlineDirty('pdf-tools', false);
  try { localStorage.clear(); } catch { /* jsdom */ }
  api.pdfToolsEvent.mockImplementation(() => Promise.resolve({ ok: true }));
  api.egnyteStatus.mockResolvedValue({ configured: true, oauth: { enabled: false, connected: false, mustConnect: false } });
  api.egnyteFolder.mockResolvedValue({ path: '/Shared', folders: [{ name: 'Leases', path: '/Shared/Leases' }], files: [{ name: 'Lease.pdf', path: '/Shared/Lease.pdf', webUrl: 'https://e/file/1' }, { name: 'Sheet.xlsx', path: '/Shared/Sheet.xlsx' }] });
  api.egnyteUpload.mockResolvedValue({ path: '/Shared/Lease.pdf', name: 'Lease.pdf', webUrl: 'https://e/app#storage/files/1/Shared/Lease.pdf' });
  api.egnyteFile.mockResolvedValue(blobOf());
});

afterEach(() => { cleanup(); });

describe('renders', () => {
  it('shows the landing header, the frame and the loading cover', () => {
    const { frame } = mount({ ready: false });
    expect(screen.getByRole('heading', { name: 'PDF Tools' })).toBeTruthy();
    expect(frame.getAttribute('src')).toMatch(/^\/pdf-editor-app\/index\.html\?v=/);
    expect(screen.getByText('Loading PDF Tools…')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByText('Loading PDF Tools…')).toBeNull();
  });

  it('goes full-bleed with a document and says so to App', () => {
    const seen = [];
    const onDoc = (e) => seen.push(e.detail.hasDoc);
    window.addEventListener('nexus:pdf-doc-state', onDoc);
    const { container, say } = mount();
    openDoc(say);
    expect(container.querySelector('.pdf-editor-module.has-doc')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'PDF Tools' })).toBeNull();
    cleanup();
    window.removeEventListener('nexus:pdf-doc-state', onDoc);
    expect(seen).toEqual([true, false]);
  });
});

describe('messages', () => {
  it('ignores a message from another origin', () => {
    const { say, container } = mount();
    openDoc(say, { dirty: true });
    expect(hasUnsavedWork()).toBe(true);
    say({ type: 'pdf-bridge:state', hasDoc: false }, { origin: 'https://evil.example' });
    say({ type: 'pdf-editor:doc-state', hasDoc: false }, { origin: 'https://evil.example' });
    expect(container.querySelector('.has-doc')).toBeTruthy();
    expect(hasUnsavedWork()).toBe(true);
  });

  it('ignores a same-origin message that is not from its own frame', () => {
    const { container } = mount();
    deliver({ type: 'pdf-bridge:state', hasDoc: true, dirty: true, name: 'x.pdf' }, { source: window });
    deliver({ type: 'pdf-bridge:action', action: 'open-egnyte' }, { source: null });
    expect(container.querySelector('.has-doc')).toBeNull();
    expect(hasUnsavedWork()).toBe(false);
    expect(api.egnyteStatus).not.toHaveBeenCalled();
  });

  it('sends to the exact origin, never a wildcard', async () => {
    const { posted, say } = mount();
    openDoc(say);
    ask(say, 'save-egnyte');
    await screen.findByRole('dialog', { name: 'Save To Egnyte' });
    expect(posted.length).toBeGreaterThan(0);
    posted.forEach(p => expect(p.origin).toBe(ORIGIN));
  });

  it('keeps listening to the engine\'s own doc-state message', () => {
    const { container, say } = mount();
    say({ type: 'pdf-editor:doc-state', hasDoc: true, dirty: true });
    expect(container.querySelector('.has-doc')).toBeTruthy();
    expect(hasUnsavedWork()).toBe(true);
  });

  it('tells the engine what this person may do', () => {
    h.role = { can: (r) => r === 'supervisor', myGrantedModules: new Map() };
    const { lastConfig } = mount();
    expect(lastConfig()).toMatchObject({ canSaveEgnyte: true, canDocuments: false, canSign: false, saveBack: null });
  });

  it('a grant opens Documents and Nexus Sign, an employee cannot upload', () => {
    h.role = { can: () => false, myGrantedModules: new Map([['documents', 'viewer']]) };
    const { lastConfig } = mount();
    expect(lastConfig()).toMatchObject({ canSaveEgnyte: false, canDocuments: true, canSign: true });
  });

  it('refuses an action this person may not take, whatever the frame says', async () => {
    h.role = { can: () => false, myGrantedModules: new Map() };
    const { say } = mount();
    openDoc(say);
    ask(say, 'open-documents');
    ask(say, 'save-egnyte');
    ask(say, 'save-back');
    ask(say, 'send-sign');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.egnyteStatus).not.toHaveBeenCalled();
    expect(takePendingOpen(ESIGN_PREFILL_PENDING)).toBeNull();
  });
});

describe('leaving with unsaved work', () => {
  it('follows the engine\'s dirty state and clears on unmount', () => {
    const { say, unmount } = mount();
    expect(hasUnsavedWork()).toBe(false);
    openDoc(say, { dirty: true });
    expect(hasUnsavedWork()).toBe(true);
    openDoc(say, { dirty: false });
    expect(hasUnsavedWork()).toBe(false);
    openDoc(say, { dirty: true });
    expect(hasUnsavedWork()).toBe(true);
    unmount();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('clears when the engine reloads to close the file', () => {
    const { say, container } = mount();
    openDoc(say, { dirty: true });
    say({ type: 'pdf-bridge:ready', engine: true });
    expect(hasUnsavedWork()).toBe(false);
    expect(container.querySelector('.has-doc')).toBeNull();
  });
});

describe('Open In PDF Tools from another screen', () => {
  it('opens an Egnyte file left in the note and remembers where it came from', async () => {
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: '/Shared/Leases/Lease.pdf', name: 'Lease.pdf' });
    const { sent, lastConfig } = mount();
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
    const { msg, origin, transfer } = sent('nexus:pdf-open')[0];
    expect(api.egnyteFile.mock.calls[0][0]).toBe('/Shared/Leases/Lease.pdf');
    expect(api.egnyteFile.mock.calls[0][1].timeoutMs).toBeGreaterThan(18000);
    expect(msg.name).toBe('Lease.pdf');
    expect(origin).toBe(ORIGIN);
    expect(transfer).toEqual([msg.bytes]);
    await waitFor(() => expect(lastConfig().saveBack).toEqual({ folder: '/Shared/Leases', name: 'Lease.pdf' }));
    expect(api.pdfToolsEvent).toHaveBeenCalledWith({ action: 'open', fileName: 'Lease.pdf', pages: 3, source: '/Shared/Leases/Lease.pdf' });
    expect(takePendingOpen(PDF_TOOLS_PENDING)).toBeNull();
  });

  it('opens a Documents row through its own loader, with nothing to save back to', async () => {
    const load = vi.fn(() => Promise.resolve(blobOf()));
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'documents', id: 'd1', title: 'Offer: Ada', name: 'Offer Ada.pdf', load });
    const { sent, lastConfig } = mount();
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(sent('nexus:pdf-open')[0].msg.name).toBe('Offer Ada.pdf');
    await waitFor(() => expect(api.pdfToolsEvent).toHaveBeenCalled());
    expect(lastConfig().saveBack).toBeNull();
    expect(api.pdfToolsEvent.mock.calls[0][0].source).toBe('Documents: Offer: Ada');
  });

  it('says why in words when the file cannot be fetched, and tries again', async () => {
    api.egnyteFile.mockRejectedValueOnce(Object.assign(new Error('API error 500: boom'), { status: 500 }));
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: '/Shared/Lease.pdf', name: 'Lease.pdf' });
    const { sent } = mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not open that file from Egnyte/);
    expect(alert.textContent).not.toMatch(/500|boom/);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
  });

  it('says so when the engine cannot take the file', async () => {
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: '/Shared/Lease.pdf', name: 'Lease.pdf' });
    mount({ open: { ok: false, error: 'bad pdf' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/bad pdf/);
  });
});

describe('Open From Egnyte', () => {
  it('shows why when Egnyte is not set up, never a listing error', async () => {
    api.egnyteStatus.mockResolvedValue({ configured: false, oauth: null });
    const { say } = mount();
    ask(say, 'open-egnyte');
    const box = await screen.findByRole('dialog', { name: 'Egnyte' });
    expect(box.textContent).toMatch(/not connected to Nexus yet/);
    expect(api.egnyteFolder).not.toHaveBeenCalled();
  });

  it('asks this person to connect their own account', async () => {
    api.egnyteStatus.mockResolvedValue({ configured: true, oauth: { enabled: true, connected: false, mustConnect: true } });
    const { say } = mount();
    ask(say, 'open-egnyte');
    await screen.findByText('Connect Your Egnyte Account');
    expect(api.egnyteFolder).not.toHaveBeenCalled();
  });

  it('says so when the status call itself fails', async () => {
    api.egnyteStatus.mockRejectedValue(Object.assign(new Error('API error 502'), { status: 502 }));
    const { say } = mount();
    ask(say, 'open-egnyte');
    const box = await screen.findByRole('dialog', { name: 'Egnyte' });
    expect(box.textContent).toMatch(/Could not reach Egnyte/);
    expect(box.textContent).not.toMatch(/502/);
  });

  it('turns a refused listing into words', async () => {
    api.egnyteFolder.mockRejectedValue(Object.assign(new Error("You don't have access to this screen"), { status: 403 }));
    const { say } = mount();
    ask(say, 'open-egnyte');
    const box = await screen.findByRole('dialog', { name: 'Open From Egnyte' });
    await waitFor(() => expect(box.textContent).toMatch(/does not have access to Egnyte/));
  });

  it('browses with only PDFs selectable, then opens the pick', async () => {
    const { say, sent } = mount();
    ask(say, 'open-egnyte');
    await screen.findByRole('button', { name: 'Lease.pdf' });
    expect(screen.getByRole('button', { name: 'Sheet.xlsx' }).disabled).toBe(true);
    expect(api.egnyteFolder).toHaveBeenCalledWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Lease.pdf' }));
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
    expect(h.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Open From Egnyte' })).toBeNull();
  });

  it('asks with a hold before unsaved edits are lost, and keeps them on No', async () => {
    h.confirm = vi.fn(() => Promise.resolve(false));
    const { say, sent } = mount();
    openDoc(say, { dirty: true, name: 'Draft.pdf' });
    ask(say, 'open-egnyte');
    fireEvent.click(await screen.findByRole('button', { name: 'Lease.pdf' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    const [message, options] = h.confirm.mock.calls[0];
    expect(message).toMatch(/Draft\.pdf/);
    expect(options).toMatchObject({ hold: true, cancelText: 'Keep Editing' });
    expect(api.egnyteFile).not.toHaveBeenCalled();
    expect(sent('nexus:pdf-open').length).toBe(0);
    expect(hasUnsavedWork()).toBe(true);
  });

  it('opens once the person has said to discard', async () => {
    const { say, sent } = mount();
    openDoc(say, { dirty: true, name: 'Draft.pdf' });
    ask(say, 'open-egnyte');
    fireEvent.click(await screen.findByRole('button', { name: 'Lease.pdf' }));
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
  });
});

describe('Open From Documents', () => {
  it('lists only the rows with a PDF and opens the pick', async () => {
    api.getDocumentLibrary.mockResolvedValue([
      { id: 'd1', kind: 'document', title: 'Offer Letter', status: 'final', updatedAt: '2026-10-04T10:00:00Z' },
      { id: 'e1', kind: 'envelope', title: 'Envelope Only', status: 'final', signStatus: 'pending' },
    ]);
    api.exportDocumentPdf.mockResolvedValue(blobOf());
    const { say, sent } = mount();
    ask(say, 'open-documents');
    const row = await screen.findByRole('button', { name: /Offer Letter/ });
    expect(row.textContent).toMatch(/10\/04\/2026/);
    expect(screen.queryByText('Envelope Only')).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(sent('nexus:pdf-open').length).toBe(1));
    expect(api.exportDocumentPdf).toHaveBeenCalledWith('d1');
    expect(sent('nexus:pdf-open')[0].msg.name).toBe('Offer Letter.pdf');
  });

  it('a person with no HR access still gets the library', async () => {
    api.listPacketDocuments.mockRejectedValue(Object.assign(new Error('403'), { status: 403 }));
    api.getDocumentLibrary.mockResolvedValue([{ id: 'd1', kind: 'document', title: 'Offer Letter', status: 'final' }]);
    const { say } = mount();
    ask(say, 'open-documents');
    expect(await screen.findByRole('button', { name: /Offer Letter/ })).toBeTruthy();
  });

  it('says why when the library cannot load, and tries again', async () => {
    api.getDocumentLibrary.mockRejectedValueOnce(Object.assign(new Error('API error 500'), { status: 500 }));
    const { say } = mount();
    ask(say, 'open-documents');
    await screen.findByText(/Could not load your documents/);
    api.getDocumentLibrary.mockResolvedValue([{ id: 'd1', kind: 'document', title: 'Offer Letter', status: 'final' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: /Offer Letter/ })).toBeTruthy();
  });
});

describe('Save To Egnyte', () => {
  const openSave = async (say, name = 'New.pdf') => {
    openDoc(say, { name });
    ask(say, 'save-egnyte');
    await screen.findByRole('dialog', { name: 'Save To Egnyte' });
    await screen.findByRole('button', { name: 'Lease.pdf' });
  };
  const goInto = async () => {
    // The listing above is the root until a folder is clicked: nothing can be saved there.
    expect(screen.getByRole('button', { name: 'Save In This Folder' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leases' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save In This Folder' }).disabled).toBe(false));
  };

  it('saves a new name, marks it saved and says where with a link', async () => {
    const { say, sent, lastConfig } = mount();
    await openSave(say);
    await goInto();
    api.egnyteUpload.mockResolvedValue({ path: '/Shared/Leases/New.pdf', name: 'New.pdf', webUrl: 'https://e/app#storage/files/1/Shared/Leases/New.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    const status = await screen.findByText('Saved to /Shared/Leases/New.pdf');
    const [folder, file, opts] = api.egnyteUpload.mock.calls[0];
    expect(folder).toBe('/Shared/Leases');
    expect(file.name).toBe('New.pdf');
    expect(file.type).toBe('application/pdf');
    expect(opts).toMatchObject({ noRetry: true });
    expect(opts.timeoutMs).toBeGreaterThan(18000);
    expect(status).toBeTruthy();
    expect(sent('nexus:pdf-mark-saved').length).toBe(1);
    expect(screen.queryByRole('dialog', { name: 'Save To Egnyte' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: /Open In Egnyte/ }).getAttribute('href')).toBeTruthy());
    expect(lastConfig().saveBack).toEqual({ folder: '/Shared/Leases', name: 'New.pdf' });
    expect(api.pdfToolsEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'save_egnyte', fileName: 'New.pdf', pages: 3, destination: '/Shared/Leases/New.pdf',
    }));
  });

  it('links to the file itself when the listing has it', async () => {
    api.egnyteFolder.mockResolvedValue({ folders: [{ name: 'Leases', path: '/Shared/Leases' }], files: [{ name: 'Lease.pdf', path: '/x', webUrl: 'https://e/file/1' }] });
    const { say } = mount();
    await openSave(say, 'Lease.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Leases' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save In This Folder' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace (Adds New Version)' }));
    const link = await screen.findByRole('link', { name: /Open In Egnyte/ });
    expect(link.getAttribute('href')).toBe('https://e/file/1');
  });

  it('asks when the name is taken: Replace adds a version', async () => {
    const { say } = mount();
    await openSave(say, 'lease.PDF');
    await goInto();
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    const ask2 = await screen.findByRole('alert');
    expect(ask2.textContent).toMatch(/Lease\.pdf is already in this folder/);
    expect(api.egnyteUpload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace (Adds New Version)' }));
    await waitFor(() => expect(api.egnyteUpload).toHaveBeenCalledTimes(1));
    expect(api.egnyteUpload.mock.calls[0][1].name).toBe('Lease.pdf');
  });

  it('asks when the name is taken: Use A New Name offers a free one', async () => {
    const { say } = mount();
    await openSave(say, 'Lease.pdf');
    await goInto();
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use A New Name' }));
    expect(screen.getByLabelText('File Name').value).toBe('Lease (1).pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    await waitFor(() => expect(api.egnyteUpload).toHaveBeenCalledTimes(1));
    expect(api.egnyteUpload.mock.calls[0][1].name).toBe('Lease (1).pdf');
  });

  it('never writes blind when the folder cannot be listed', async () => {
    const { say } = mount();
    await openSave(say);
    await goInto();
    api.egnyteFolder.mockRejectedValueOnce(Object.assign(new Error('API error 500'), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/500/);
    expect(api.egnyteUpload).not.toHaveBeenCalled();
  });

  it('shows a failed upload in place and keeps the document open and unsaved', async () => {
    const { say, sent, container } = mount();
    openDoc(say, { name: 'New.pdf', dirty: true });
    ask(say, 'save-egnyte');
    await screen.findByRole('button', { name: 'Lease.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Leases' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save In This Folder' }).disabled).toBe(false));
    api.egnyteUpload.mockRejectedValue(Object.assign(new Error('API error 500: stack'), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/still open here/);
    expect(alert.textContent).not.toMatch(/stack/);
    expect(screen.getByRole('dialog', { name: 'Save To Egnyte' })).toBeTruthy();
    expect(sent('nexus:pdf-mark-saved').length).toBe(0);
    expect(hasUnsavedWork()).toBe(true);
    expect(container.querySelector('.has-doc')).toBeTruthy();
    expect(api.pdfToolsEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'save_egnyte' }));
  });

  it('says too large before uploading a PDF past the limit', async () => {
    const { say } = mount({ build: { ok: true, name: 'Big.pdf', pages: 1, bytes: new ArrayBuffer(100 * 1024 * 1024 + 1) } });
    await openSave(say, 'Big.pdf');
    await goInto();
    fireEvent.click(screen.getByRole('button', { name: 'Save In This Folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too large/);
    expect(api.egnyteUpload).not.toHaveBeenCalled();
  });

  it('warns about version history on a redacted file', async () => {
    const { say } = mount();
    openDoc(say, { redacted: true });
    ask(say, 'save-egnyte');
    await screen.findByRole('dialog', { name: 'Save To Egnyte' });
    expect(screen.getByText(/unredacted original in\s+its version history/)).toBeTruthy();
  });
});

describe('Save Back', () => {
  const opened = async (mountOpts) => {
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: '/Shared/Leases/Lease.pdf', name: 'Lease.pdf' });
    const m = mount(mountOpts);
    await waitFor(() => expect(m.lastConfig().saveBack).toBeTruthy());
    return m;
  };

  it('saves to the file\'s own folder in one click', async () => {
    const { say, sent } = await opened();
    api.egnyteUpload.mockResolvedValue({ path: '/Shared/Leases/Lease.pdf', name: 'Lease.pdf' });
    ask(say, 'save-back');
    await screen.findByText('Saved to /Shared/Leases/Lease.pdf');
    expect(api.egnyteUpload.mock.calls[0][0]).toBe('/Shared/Leases');
    expect(sent('nexus:pdf-mark-saved').length).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the document open on failure and offers the way forward', async () => {
    const { say, sent } = await opened();
    openDoc(say, { dirty: true });
    api.egnyteUpload.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    ask(say, 'save-back');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/still open here/);
    expect(hasUnsavedWork()).toBe(true);
    expect(sent('nexus:pdf-mark-saved').length).toBe(0);
    expect(screen.getByRole('button', { name: 'Choose Another Folder' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await screen.findByText(/Saved to/);
    expect(api.egnyteUpload).toHaveBeenCalledTimes(2);
  });

  it('a redacted file does not go back in one click', async () => {
    const { say } = await opened();
    openDoc(say, { redacted: true });
    ask(say, 'save-back');
    await screen.findByRole('dialog', { name: 'Save To Egnyte' });
    expect(api.egnyteUpload).not.toHaveBeenCalled();
  });

  it('a different file from this computer forgets the Egnyte source', async () => {
    const { say, lastConfig } = await opened();
    openDoc(say, { name: 'Other.pdf' });
    await waitFor(() => expect(lastConfig().saveBack).toBeNull());
    expect(api.pdfToolsEvent).toHaveBeenCalledWith({ action: 'open', fileName: 'Other.pdf', pages: 3, source: 'This Computer' });
  });

  it('a same-name replace from this computer forgets it too', async () => {
    const { say, lastConfig } = await opened();
    say({ type: 'pdf-bridge:local-open', name: 'Lease.pdf', pages: 3 });
    await waitFor(() => expect(lastConfig().saveBack).toBeNull());
  });

  it('closing the file forgets it', async () => {
    const { say, lastConfig } = await opened();
    say({ type: 'pdf-bridge:ready', engine: true });
    await waitFor(() => expect(lastConfig().saveBack).toBeNull());
  });
});

describe('Send For Signature', () => {
  it('hands the built PDF to Nexus Sign and moves there with no leave prompt', async () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    const { say } = mount();
    openDoc(say, { dirty: true });
    ask(say, 'send-sign');
    await waitFor(() => expect(nav).toHaveBeenCalled());
    window.removeEventListener('nexus:navigate', nav);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'documents', sub: 'documents-esign' });
    expect(hasUnsavedWork()).toBe(false);
    const prefill = takePendingOpen(ESIGN_PREFILL_PENDING);
    expect(prefill).toMatchObject({ title: 'Lease', source: 'pdf', parties: [] });
    expect(prefill.sourceDocumentId).toBeUndefined();
    expect(prefill.file.name).toBe('Lease.pdf');
    expect(prefill.file.type).toBe('application/pdf');
    expect(api.pdfToolsEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'send_sign', fileName: 'Lease.pdf', destination: 'Nexus Sign' }));
  });

  it('does not ask for a clean file', async () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    const { say } = mount();
    openDoc(say);
    ask(say, 'send-sign');
    await waitFor(() => expect(nav).toHaveBeenCalled());
    window.removeEventListener('nexus:navigate', nav);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('stays put when the person keeps editing', async () => {
    h.confirm = vi.fn(() => Promise.resolve(false));
    const { say, sent } = mount();
    openDoc(say, { dirty: true });
    ask(say, 'send-sign');
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(sent('nexus:pdf-build').length).toBe(0);
    expect(hasUnsavedWork()).toBe(true);
  });

  it('keeps the document open when the PDF cannot be built', async () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    const { say } = mount({ build: { ok: false, error: 'pipeline broke' } });
    openDoc(say, { dirty: true });
    ask(say, 'send-sign');
    const alert = await screen.findByRole('alert');
    window.removeEventListener('nexus:navigate', nav);
    expect(alert.textContent).toMatch(/still open here/);
    expect(alert.textContent).not.toMatch(/pipeline/);
    expect(nav).not.toHaveBeenCalled();
    expect(hasUnsavedWork()).toBe(true);
    expect(takePendingOpen(ESIGN_PREFILL_PENDING)).toBeNull();
  });
});

describe('who did what', () => {
  it('reports what the engine did, with where the file came from', async () => {
    setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: '/Shared/Lease.pdf', name: 'Lease.pdf' });
    const { say, lastConfig } = mount();
    await waitFor(() => expect(lastConfig().saveBack).toBeTruthy());
    api.pdfToolsEvent.mockClear();
    say({ type: 'pdf-bridge:did', action: 'redact', name: 'Lease.pdf', pages: 3 });
    say({ type: 'pdf-bridge:did', action: 'download', name: 'Lease.pdf', pages: 3 });
    expect(api.pdfToolsEvent.mock.calls.map(c => c[0])).toEqual([
      { action: 'redact', fileName: 'Lease.pdf', pages: 3, source: '/Shared/Lease.pdf', destination: '' },
      { action: 'download', fileName: 'Lease.pdf', pages: 3, source: '/Shared/Lease.pdf', destination: 'This Computer' },
    ]);
  });

  it('never gets in the way when the report fails', async () => {
    api.pdfToolsEvent.mockImplementation(() => Promise.reject(new Error('down')));
    const { say } = mount();
    openDoc(say, { name: 'A.pdf' });
    say({ type: 'pdf-bridge:did', action: 'download', name: 'A.pdf', pages: 1 });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();

    api.pdfToolsEvent.mockImplementation(() => { throw new Error('sync'); });
    say({ type: 'pdf-bridge:did', action: 'export', name: 'A.pdf', pages: 1 });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
