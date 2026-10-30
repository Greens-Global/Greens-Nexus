// Notes, working together (Neil, Oct 30 2026): a 409 merged block by block
// with no question, the open note re-read when someone else saved and who
// is here, the list's Updated dot, sharing straight to Can Edit, the
// history's who-changed-what - and live co-typing's pieces: the encrypted
// channel carries edits only to holders of the key, one browser seeds a
// note's shared state (a second joins the winner's), and the editor's own
// nodes (checklists, voice notes, mentions) survive the shared document.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook, cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const BOB = 'bob@greensglobal.com';
const P = (...xs) => xs.map((x) => `<p>${x}</p>`).join('');
const note = (over = {}) => ({
  id: 'note_1', kind: 'note', title: 'Budget Review', preview: 'a', body: P('a', 'b'),
  day: TODAY, tags: [], color: '', pinned: false, owner: 'neil@greensglobal.com', mine: true, can: 'owner',
  shared: true, sharedWith: [{ email: BOB, can: 'edit' }], trashedAt: '', rev: 3, words: 2,
  updatedAt: new Date().toISOString(), updatedBy: 'neil@greensglobal.com', editedBy: 'neil@greensglobal.com', unseen: false, ...over,
});

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteShare: vi.fn(), noteUnshare: vi.fn(),
  noteVersions: vi.fn(), noteRestoreVersion: vi.fn(), notePresence: vi.fn(), noteCollab: vi.fn(), noteCollabSeed: vi.fn(),
  getPeopleDirectory: vi.fn(), createTask: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import NotesPage from './NotesPage';
import NoteEditor from './NoteEditor';
import { useNoteCollab } from './useNoteCollab';
import { importKey, seal, open, toB64 } from './collabCrypto';
import * as rt from './collabRuntime';

if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });

beforeEach(() => {
  localStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.getPeopleDirectory.mockResolvedValue([{ email: BOB, name: 'Bob Brown' }, { email: 'neil@greensglobal.com', name: 'Neil Kadakia' }]);
  apiMock.notesList.mockResolvedValue({ notes: [note()], counts: { all: 1 }, tags: [] });
  apiMock.noteGet.mockResolvedValue(note());
  apiMock.notePresence.mockResolvedValue({ people: [], rev: 3 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const prose = () => document.querySelector('.ProseMirror');

describe('saves that cross', () => {
  it('merges someone else\'s save with no question and says so', async () => {
    const theirs = note({ rev: 4, body: P('a', 'b', 'c by Bob'), updatedBy: BOB });
    apiMock.noteUpdate
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, detail: { note: theirs } }))
      .mockResolvedValueOnce(note({ rev: 5, title: 'Budget Review Q4', body: P('a', 'b', 'c by Bob') }));
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    fireEvent.change(await screen.findByDisplayValue('Budget Review'), { target: { value: 'Budget Review Q4' } });
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(apiMock.noteUpdate.mock.calls[1][1]).toMatchObject({ rev: 4, title: 'Budget Review Q4', body: P('a', 'b', 'c by Bob') });
    expect(screen.queryByRole('button', { name: 'Keep Mine' })).toBeNull();
    expect(await screen.findByText(/merged with Bob Brown's changes/)).toBeTruthy();
  });
});

describe('an open note follows the others', () => {
  it('shows who is here and re-reads the note when someone else saved', async () => {
    apiMock.noteGet.mockResolvedValueOnce(note({ body: P('Old words') }))
      .mockResolvedValue(note({ rev: 4, body: P('New from Bob'), updatedBy: BOB, editedBy: BOB }));
    apiMock.notePresence.mockResolvedValue({ people: [{ email: BOB, state: 'editing' }], rev: 4 });
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    await waitFor(() => expect(prose()?.textContent).toContain('Old words'));
    expect(await screen.findByText('Bob Brown is editing', {}, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect(prose()?.textContent).toContain('New from Bob'));
    expect(screen.getByText(/Edited by Bob Brown/)).toBeTruthy();
    expect(apiMock.notePresence).toHaveBeenCalledWith('note_1', 'viewing');
  });

  it('a note someone else changed since you looked carries the Updated dot', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [note({ id: 'note_2', title: 'Launch', unseen: true, editedBy: BOB })], counts: { all: 1 }, tags: [] });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    expect(await screen.findByRole('img', { name: 'Updated since you last looked' })).toBeTruthy();
  });
});

describe('sharing and history', () => {
  it('shares straight to Can Edit', async () => {
    apiMock.noteGet.mockResolvedValue(note({ sharedWith: [], shared: false }));
    apiMock.noteShare.mockResolvedValue(note());
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    fireEvent.change(await screen.findByLabelText('What they may do'), { target: { value: 'edit' } });
    fireEvent.change(screen.getByLabelText('Find someone'), { target: { value: 'Bob' } });
    const pick = await waitFor(() => { const b = document.querySelector('.nt-person .nt-text-btn'); if (!b) throw new Error('no match yet'); return b; });
    fireEvent.click(pick);
    await waitFor(() => expect(apiMock.noteShare).toHaveBeenCalledWith('note_1', BOB, 'edit'));
  });

  it('Version History says who changed what, word by word', async () => {
    apiMock.noteVersions.mockResolvedValue([
      { id: 'v2', title: 'Budget Review', body: P('Call the HVAC vendor'), savedBy: BOB, createdAt: new Date().toISOString(), words: 4 },
      { id: 'v1', title: 'Budget Review', body: P('Call the vendor'), savedBy: 'neil@greensglobal.com', createdAt: new Date().toISOString(), words: 3 },
    ]);
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Version History/ }));
    expect(await screen.findByText(/What Bob Brown changed: 1 edited/)).toBeTruthy();
    expect(document.querySelector('.nt-diff ins')?.textContent).toBe('HVAC ');
    fireEvent.click(screen.getByRole('tab', { name: 'Compare With Now' }));
    expect(document.querySelector('.nt-diff').innerHTML).toContain('nt-diff');
  });
});

// ── live co-typing ─────────────────────────────────────────────────────────
function hub() {
  const rooms = new Map();
  return {
    client() {
      return {
        channel(name) {
          const ch = {
            name, handlers: [],
            on(_t, _f, fn) { this.handlers.push(fn); return this; },
            subscribe(cb) { if (!rooms.has(name)) rooms.set(name, []); rooms.get(name).push(ch); setTimeout(() => cb('SUBSCRIBED'), 0); return ch; },
            async send(msg) { (rooms.get(name) || []).filter((o) => o !== ch).forEach((o) => o.handlers.forEach((h) => h({ payload: msg.payload }))); return 'ok'; },
          };
          return ch;
        },
        removeChannel(ch) { const l = rooms.get(ch.name) || []; l.splice(l.indexOf(ch), 1); },
      };
    },
    sent: [],
  };
}
const newKey = () => importKey(toB64(webcrypto.getRandomValues(new Uint8Array(32))));
const text = (doc) => doc.getXmlFragment(rt.FIELD).toString();
const addParagraph = (doc, words) => {
  const p = new rt.Y.XmlElement('paragraph');
  p.insert(0, [new rt.Y.XmlText(words)]);
  doc.getXmlFragment(rt.FIELD).push([p]);
};

describe('the encrypted channel', () => {
  it('seals and opens; another key opens nothing', async () => {
    const k1 = await newKey(), k2 = await newKey();
    const sealed = await seal(k1, new TextEncoder().encode('gate code 4411'));
    expect(atob(sealed)).not.toContain('gate code');
    expect(new TextDecoder().decode(await open(k1, sealed))).toBe('gate code 4411');
    expect(await open(k2, sealed)).toBeNull();
  });

  it('two editors converge, a late joiner catches up, and a stranger on another epoch is ignored', async () => {
    const h = hub();
    const key = await newKey();
    const a = rt.seedDoc(P('Hello'));
    const b = new rt.Y.Doc();
    const hooks = () => ({ onLive: vi.fn(), onForeignEpoch: vi.fn(), onUnreadable: vi.fn() });
    const ha = hooks(), hb = hooks();
    const ca = rt.connect({ supabase: h.client(), channelName: 'c', key, epoch: 'e1', doc: a, awareness: rt.newAwareness(a, { name: 'Neil', color: '#000' }), hooks: ha });
    await new Promise((r) => setTimeout(r, 20));
    const cb = rt.connect({ supabase: h.client(), channelName: 'c', key, epoch: 'e1', doc: b, awareness: rt.newAwareness(b, { name: 'Bob', color: '#111' }), hooks: hb });
    await waitFor(() => expect(text(b)).toContain('Hello'));
    addParagraph(a, 'World');
    await waitFor(() => expect(text(b)).toContain('World'));
    addParagraph(b, 'From Bob');
    await waitFor(() => expect(text(a)).toContain('From Bob'));
    const stranger = rt.connect({ supabase: h.client(), channelName: 'c', key, epoch: 'e2', doc: new rt.Y.Doc(), awareness: rt.newAwareness(new rt.Y.Doc(), { name: 'X' }), hooks: hooks() });
    await waitFor(() => expect(ha.onForeignEpoch).toHaveBeenCalled());
    expect(text(a)).not.toContain('undefined');
    const thief = rt.connect({ supabase: h.client(), channelName: 'c', key: await newKey(), epoch: 'e1', doc: new rt.Y.Doc(), awareness: rt.newAwareness(new rt.Y.Doc(), { name: 'T' }), hooks: hooks() });
    await waitFor(() => expect(ha.onUnreadable).toHaveBeenCalled());
    [ca, cb, stranger, thief].forEach((c) => c.close());
  });
});

describe('starting a live session', () => {
  const winnerHtml = '<p>Winner words</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li></ul>'
    + '<audio src="https://x.supabase.co/storage/v1/object/public/task-files/notes/a.m4a" controls="" preload="metadata"></audio>'
    + '<p><a href="mailto:bob@greensglobal.com">@Bob Brown</a></p>';

  it('a second browser joins the first one\'s state instead of seeding the words again', async () => {
    const winner = rt.encodeState(rt.seedDoc(winnerHtml));
    const key = toB64(webcrypto.getRandomValues(new Uint8Array(32)));
    apiMock.noteCollab.mockResolvedValue({ key, channel: 'nx-note-x', ydoc: '', yepoch: '', rev: 3, body: P('Mine') });
    apiMock.noteCollabSeed.mockRejectedValue(Object.assign(new Error('taken'), { status: 409, detail: { collab: { ydoc: winner, yepoch: 'winner-epoch-1', rev: 3 } } }));
    const { result } = renderHook(() => useNoteCollab('note_1', { enabled: true, me: 'neil@greensglobal.com', name: 'Neil Kadakia' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.epoch).toBe('winner-epoch-1');
    expect(apiMock.noteCollabSeed).toHaveBeenCalledTimes(1);
    // The editor on that state: the words and the editor's own nodes come through the shared document.
    render(<NoteEditor collab={result.current} onChange={() => {}} />);
    await waitFor(() => expect(prose()?.textContent).toContain('Winner words'));
    const html = result.current.getHtml();
    expect(html).not.toContain('Mine');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('<audio src="https://x.supabase.co/storage/v1/object/public/task-files/notes/a.m4a"');
    expect(html).toContain('href="mailto:bob@greensglobal.com"');
  });

  it('the first browser seeds it, with a fresh epoch', async () => {
    apiMock.noteCollab.mockResolvedValue({ key: toB64(webcrypto.getRandomValues(new Uint8Array(32))), channel: 'nx-note-y', ydoc: '', yepoch: '', rev: 7, body: P('Seed me') });
    apiMock.noteCollabSeed.mockImplementation(async (_id, d) => ({ ydoc: d.ydoc, yepoch: d.yepoch, rev: 7 }));
    const { result } = renderHook(() => useNoteCollab('note_1', { enabled: true, me: 'neil@greensglobal.com', name: 'Neil' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const sent = apiMock.noteCollabSeed.mock.calls[0][1];
    expect(sent.rev).toBe(7);
    expect(sent.yepoch).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(result.current.epoch).toBe(sent.yepoch);
    expect(text(rt.docFrom(sent.ydoc))).toContain('Seed me');
  });
});
