import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Tickets on phones (Oct 2026): attachments, uploads and the reply composer.
// vitest.setup.js stubs matchMedia to "not a phone"; each test here picks the
// viewport itself, so both the phone path and the unchanged desktop path are
// pinned.

function setViewport(isMobile, { coarse = false } = {}) {
  window.matchMedia = (q) => ({
    matches: (isMobile && q.includes('max-width: 640px')) || (coarse && q.includes('pointer: coarse')),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

// jsdom has no layout: ProseMirror's scroll-into-view after a focus() asks a
// Range for its rects. A zero rect is enough for it to carry on.
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = zeroRect;

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const role = { grant: true };
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 1, canAccessModule: () => role.grant,
    myGrantedModules: new Map(), myEmail: 'agent@example.com' }),
}));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}));
const confirmAnswer = { value: true };
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => confirmAnswer.value), alert: vi.fn(), prompt: vi.fn() } }));
// Image prep is unit-tested on its own (lib/imagePrep.test.js); here it passes through.
vi.mock('../lib/imagePrep', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareImageForUpload: vi.fn(async (file) => ({ file, converted: false, heicUndecoded: false })),
}));

const STORE = 'https://proj.supabase.co/storage/v1/object/public/ticket-evidence/';
const uploads = { fail: false, hold: null, calls: [] };
vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: async (path) => {
          uploads.calls.push(path);
          if (uploads.hold) await uploads.hold;
          return uploads.fail ? { data: null, error: { message: 'network down' } } : { data: { path }, error: null };
        },
        getPublicUrl: (p) => ({ data: { publicUrl: STORE + p } }),
      }),
    },
  },
}));

const apiMock = {
  getTicketAttachments: vi.fn(async () => []),
  addTicketAttachment: vi.fn(async () => ({})),
  deleteTicketAttachment: vi.fn(async () => {}),
  getTicketComments: vi.fn(async () => []),
  deleteTicketComment: vi.fn(async () => {}),
  getPeopleDirectory: vi.fn(async () => []),
};
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => apiMock[k] || (() => Promise.resolve([])) }),
}));

const { TicketAttachments, AttachmentViewer, TicketConversation } = await import('./TicketsView');

const ATT = { id: 'a1', ticketId: 't1', name: 'keypad.jpg', size: '120 KB', kind: 'image', url: `${STORE}image-1.jpg` };
const png = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

beforeEach(() => {
  role.grant = true;
  confirmAnswer.value = true;
  uploads.fail = false;
  uploads.hold = null;
  uploads.calls = [];
  apiMock.getTicketAttachments.mockImplementation(async () => []);
  apiMock.deleteTicketAttachment.mockImplementation(async () => {});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ── Attachments tab ─────────────────────────────────────────────────────────
describe('Attachments tab on a phone', () => {
  it('offers camera and photo library next to Upload, and no Record Screen or Ctrl+V hint', async () => {
    setViewport(true);
    const { container } = render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    expect(screen.getByRole('button', { name: /Take Photo/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Photo Library/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeInTheDocument();
    const cam = container.querySelector('[data-testid="ticket-camera-input"]');
    expect(cam.getAttribute('capture')).toBe('environment');
    expect(cam.getAttribute('accept')).toBe('image/*');
    expect(container.querySelector('[data-testid="ticket-library-input"]').getAttribute('accept')).toBe('image/*');
    expect(screen.queryByRole('button', { name: /Record Screen/ })).toBeNull();
    expect(screen.queryByText(/Ctrl\+V/)).toBeNull();
  });

  it('desktop is unchanged: Record Screen and the Ctrl+V hint, no camera buttons', () => {
    setViewport(false);
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    expect(screen.getByRole('button', { name: /Record Screen/ })).toBeInTheDocument();
    expect(screen.getByText(/or press Ctrl\+V to paste a screenshot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Take Photo/ })).toBeNull();
  });

  it('counts uploads in flight and keeps saying so until every one finishes', async () => {
    setViewport(true);
    let release;
    uploads.hold = new Promise((r) => { release = r; });
    const { container } = render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    const lib = container.querySelector('[data-testid="ticket-library-input"]');
    await act(async () => { fireEvent.change(lib, { target: { files: [png('one.png'), png('two.png')] } }); });
    expect(screen.getByText('Uploading 2…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeDisabled();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByText(/Uploading/)).toBeNull());
    expect(apiMock.addTicketAttachment).toHaveBeenCalledTimes(2);
    for (const [, row] of apiMock.addTicketAttachment.mock.calls) {
      expect(row.url).toMatch(/ticket-evidence\/image-/);
      expect(row.kind).toBe('image');
    }
  });

  it('a failed upload records nothing and says so inline (no alert)', async () => {
    setViewport(true);
    uploads.fail = true;
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ticket-camera-input"]'), { target: { files: [png('gate.png')] } });
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/"gate.png" couldn't be uploaded: network down/));
    expect(apiMock.addTicketAttachment).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('Remove asks first, and Download / Remove are 36px targets apart', async () => {
    setViewport(true);
    apiMock.getTicketAttachments.mockImplementation(async () => [ATT]);
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    const remove = await screen.findByRole('button', { name: 'Remove keypad.jpg' });
    const download = screen.getByRole('link', { name: 'Download keypad.jpg' });
    expect(remove.style.width).toBe('36px');
    expect(remove.style.height).toBe('36px');
    expect(download.style.width).toBe('36px');
    expect(download.style.left).toBe('4px');
    expect(remove.style.right).toBe('4px');

    confirmAnswer.value = false;
    await act(async () => { fireEvent.click(remove); });
    expect(apiMock.deleteTicketAttachment).not.toHaveBeenCalled();

    confirmAnswer.value = true;
    await act(async () => { fireEvent.click(remove); });
    expect(apiMock.deleteTicketAttachment).toHaveBeenCalledWith('a1');
  });

  it('a refused delete is reported instead of swallowed', async () => {
    setViewport(true);
    apiMock.getTicketAttachments.mockImplementation(async () => [ATT]);
    apiMock.deleteTicketAttachment.mockImplementation(async () => { throw new Error("You don't have access to this screen"); });
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    const remove = await screen.findByRole('button', { name: 'Remove keypad.jpg' });
    await act(async () => { fireEvent.click(remove); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't remove "keypad.jpg"/));
  });

  it('hides Remove from someone without the desk grant (the server would 403)', async () => {
    setViewport(true);
    role.grant = false;
    apiMock.getTicketAttachments.mockImplementation(async () => [ATT]);
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    await screen.findByRole('link', { name: 'Download keypad.jpg' });
    expect(screen.queryByRole('button', { name: 'Remove keypad.jpg' })).toBeNull();
  });
});

// ── Viewer ──────────────────────────────────────────────────────────────────
describe('AttachmentViewer', () => {
  const pdf = { name: 'lease.pdf', size: '300 KB', kind: 'doc', url: `${STORE}doc-1.pdf` };

  it('on a phone a PDF is a card with Open and Download, never an iframe', () => {
    setViewport(true);
    const { baseElement } = render(<AttachmentViewer att={pdf} onClose={() => {}} />);
    expect(baseElement.querySelector('iframe')).toBeNull();
    const open = screen.getByRole('link', { name: /Open/ });
    expect(open.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: /^Download$/ })).toBeInTheDocument();
  });

  it('on a desktop a PDF still opens inline', () => {
    setViewport(false);
    const { baseElement } = render(<AttachmentViewer att={pdf} onClose={() => {}} />);
    expect(baseElement.querySelector('iframe')).not.toBeNull();
  });

  it('on a phone: 40px close, labeled download, dvh-sized playsInline video, name that gives way', () => {
    setViewport(true);
    const vid = { name: 'a-very-long-recording-name-that-would-push-the-close-button-off.webm', size: '2 MB', kind: 'video', url: `${STORE}video-1.webm` };
    const { baseElement } = render(<AttachmentViewer att={vid} onClose={() => {}} />);
    const close = screen.getByRole('button', { name: 'Close viewer' });
    expect(close.style.width).toBe('40px');
    expect(close.style.height).toBe('40px');
    expect(screen.getByRole('link', { name: `Download ${vid.name}` })).toBeInTheDocument();
    const video = baseElement.querySelector('video');
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.style.maxHeight).toBe('78dvh');
    const name = screen.getByText(vid.name);
    expect(name.style.minWidth).toMatch(/^0(px)?$/);
    expect(name.style.flex).toContain('1');
  });
});

// ── Conversation ────────────────────────────────────────────────────────────
function Conversation(props) {
  const [reply, setReply] = useState({ body: '', internal: false });
  props.spy?.(reply.body);
  return <TicketConversation ticketId="t1" nameOf={(e) => e} reply={reply} onReplyChange={setReply} onDone={() => {}} {...props} />;
}

describe('Conversation on a phone', () => {
  const COMMENT = { id: 'c1', ticketId: 't1', authorId: 'someone.with.a.really.long.name@example.com', body: '<p>hi</p>', internal: true, createdAt: '2026-10-01T15:00:00Z' };

  it('wraps the comment header, gives Delete a 36px target and a 12px timestamp', async () => {
    setViewport(true);
    apiMock.getTicketComments.mockImplementation(async () => [COMMENT]);
    render(<Conversation />);
    const del = await screen.findByRole('button', { name: 'Delete comment' });
    expect(del.style.width).toBe('36px');
    expect(del.style.height).toBe('36px');
    const head = screen.getByTestId('comment-head');
    expect(head.style.flexWrap).toBe('wrap');
    const name = screen.getByText(COMMENT.authorId);
    expect(name.style.textOverflow).toBe('ellipsis');
    expect(name.style.minWidth).toMatch(/^0(px)?$/);
    const time = head.lastChild;
    expect(time.style.fontSize).toBe('12px');
  });

  it('a picture picked into the reply is uploaded and embedded by URL - never base64', async () => {
    setViewport(true);
    apiMock.getTicketComments.mockImplementation(async () => []);
    let body = '';
    const { container } = render(<Conversation spy={(b) => { body = b; }} />);
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"][accept="image/*"]');
      expect(el).not.toBeNull();
      return el;
    });
    await act(async () => { fireEvent.change(input, { target: { files: [png('photo.png')] } }); });
    await waitFor(() => expect(body).toMatch(/<img[^>]+ticket-evidence\/image-/));
    expect(body).not.toMatch(/data:/);
    expect(uploads.calls.length).toBe(1);
    // Storage only: nothing reaches the requester until Done.
    expect(apiMock.addTicketAttachment).not.toHaveBeenCalled();
  });

  it('a failed upload in the reply says so and inserts nothing', async () => {
    setViewport(true);
    uploads.fail = true;
    apiMock.getTicketComments.mockImplementation(async () => []);
    let body = '';
    const { container } = render(<Conversation spy={(b) => { body = b; }} />);
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"][accept="image/*"]');
      expect(el).not.toBeNull();
      return el;
    });
    await act(async () => { fireEvent.change(input, { target: { files: [png('photo.png')] } }); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/"photo.png" couldn't be uploaded/));
    expect(body).not.toMatch(/<img/);
  });

  it('drops the Cmd/Ctrl+Enter hint on a phone, keeps it on a desktop', async () => {
    const withText = { body: '<p>on it</p>', internal: false };
    setViewport(true);
    const { unmount } = render(<TicketConversation ticketId="t1" nameOf={(e) => e} reply={withText} onReplyChange={() => {}} onDone={() => {}} />);
    await screen.findByText(/Your reply is sent/);
    expect(screen.queryByText(/Ctrl\+Enter/)).toBeNull();
    unmount();
    setViewport(false);
    render(<TicketConversation ticketId="t1" nameOf={(e) => e} reply={withText} onReplyChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/Ctrl\+Enter/)).toBeInTheDocument();
  });
});

// ── Review fixes ────────────────────────────────────────────────────────────
describe('touch devices wider than a phone (iPad, phone in landscape)', () => {
  const pdf = { name: 'lease.pdf', size: '300 KB', kind: 'doc', url: `${STORE}doc-1.pdf` };
  afterEach(() => { delete navigator.mediaDevices; });

  it('no Record Screen where touch is primary and getDisplayMedia is missing', () => {
    setViewport(false, { coarse: true });
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    expect(screen.queryByRole('button', { name: /Record Screen/ })).toBeNull();
  });

  it('a touch device that can record keeps the button', () => {
    setViewport(false, { coarse: true });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: () => {} }, configurable: true });
    render(<TicketAttachments ticketId="t1" ticketType="incident" />);
    expect(screen.getByRole('button', { name: /Record Screen/ })).toBeInTheDocument();
  });

  it('a PDF gets the card, not the iframe', () => {
    setViewport(false, { coarse: true });
    const { baseElement } = render(<AttachmentViewer att={pdf} onClose={() => {}} />);
    expect(baseElement.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument();
  });
});

describe('Remove confirmation and the drawer behind it', () => {
  it('Escape while the confirm is open does not reach the drawer\'s window listener', async () => {
    setViewport(true);   // actions always shown; the bug is the same on a desktop
    const { dialog } = await import('../ui/dialog');
    let answer;
    dialog.confirm.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    apiMock.getTicketAttachments.mockImplementation(async () => [ATT]);
    const drawerEscape = vi.fn();
    const onKey = (e) => { if (e.key === 'Escape') drawerEscape(); };
    window.addEventListener('keydown', onKey);
    try {
      render(<TicketAttachments ticketId="t1" ticketType="incident" />);
      const remove = await screen.findByRole('button', { name: 'Remove keypad.jpg' });
      await act(async () => { fireEvent.click(remove); });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(drawerEscape).not.toHaveBeenCalled();
      await act(async () => { answer(false); });
      // Once the confirm is gone, Escape reaches the drawer again.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(drawerEscape).toHaveBeenCalledTimes(1);
      expect(apiMock.deleteTicketAttachment).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });
});

describe('a reply with a picture still uploading', () => {
  it('rides on reply.uploading, says to wait, and holds Cmd/Ctrl+Enter until it lands', async () => {
    setViewport(false);
    apiMock.getTicketComments.mockImplementation(async () => []);
    let release;
    uploads.hold = new Promise((r) => { release = r; });
    const onDone = vi.fn();
    let latest = null;
    function Harness() {
      const [reply, setReply] = useState({ body: '', internal: false });
      latest = reply;
      return <TicketConversation ticketId="t1" nameOf={(e) => e} reply={reply} onReplyChange={setReply} onDone={onDone} />;
    }
    const { container } = render(<Harness />);
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"][accept="image/*"]');
      expect(el).not.toBeNull();
      return el;
    });
    await act(async () => { fireEvent.change(input, { target: { files: [png('photo.png')] } }); });
    await waitFor(() => expect(latest.uploading).toBe(1));
    expect(screen.getByText(/Wait for the upload to finish/)).toBeInTheDocument();
    const pm = container.querySelector('.ProseMirror');
    fireEvent.keyDown(pm, { key: 'Enter', ctrlKey: true });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(latest.uploading).toBe(0));
    await waitFor(() => expect(latest.body).toMatch(/<img/));
    fireEvent.keyDown(container.querySelector('.ProseMirror'), { key: 'Enter', ctrlKey: true });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
