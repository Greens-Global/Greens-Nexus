// Quick Note opened with words to start with (Share to Nexus, lib/
// shareTarget.js): they go in at the end of today's note, once, as if typed -
// after the note's own text, never instead of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const daily = (over = {}) => ({
  id: 'daily_1', kind: 'daily', title: '', preview: '', body: '<p>Morning list</p>', day: TODAY, tags: [], color: '', pinned: false,
  owner: 'neil@greensglobal.com', mine: true, can: 'owner', shared: false, sharedWith: [], trashedAt: '', rev: 3, words: 2,
  updatedAt: new Date().toISOString(), updatedBy: 'neil@greensglobal.com', ...over,
});

const apiMock = vi.hoisted(() => ({
  noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteDaily: vi.fn(),
  getPeopleDirectory: vi.fn(async () => []), createTask: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import QuickNotePanel from './QuickNotePanel';
import QuickNoteButton from './QuickNoteButton';

beforeEach(() => {
  localStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  apiMock.getPeopleDirectory.mockResolvedValue([]);
});

describe('Quick Note with words handed over', () => {
  it("adds them after today's text and saves the note with both", async () => {
    apiMock.noteDaily.mockResolvedValue({ note: daily() });
    apiMock.noteGet.mockResolvedValue(daily());
    apiMock.noteUpdate.mockImplementation(async (id, patch) => daily({ rev: 4, ...patch }));
    render(<QuickNotePanel onClose={vi.fn()} seed="<p>Gate keypad is dead</p>" />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toBe('Morning listGate keypad is dead'));
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalled(), { timeout: 4000 });
    const sent = JSON.stringify(apiMock.noteUpdate.mock.calls.at(-1));
    expect(sent).toContain('Morning list');
    expect(sent).toContain('Gate keypad is dead');
    // Once: another pass of the panel does not write it again.
    expect(document.querySelector('.ProseMirror').textContent.match(/Gate keypad is dead/g)).toHaveLength(1);
  });

  it("with no scratchpad yet, the words make today's note", async () => {
    apiMock.noteDaily.mockResolvedValue({ note: null });
    apiMock.noteCreate.mockImplementation(async (data) => daily({ ...data, rev: 1 }));
    apiMock.noteGet.mockImplementation(async () => daily({ body: '<p>Gate keypad is dead</p>', rev: 1 }));
    render(<QuickNotePanel onClose={vi.fn()} seed="<p>Gate keypad is dead</p>" />);
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledTimes(1));
    expect(apiMock.noteCreate.mock.calls[0][0]).toMatchObject({ kind: 'daily', day: TODAY });
    expect(apiMock.noteCreate.mock.calls[0][0].body).toContain('Gate keypad is dead');
    expect(document.querySelector('.ProseMirror').textContent).toBe('Gate keypad is dead');
  });

  it('without a seed nothing is written (the panel as it always was)', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: daily() });
    apiMock.noteGet.mockResolvedValue(daily());
    render(<QuickNotePanel onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toBe('Morning list'));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiMock.noteUpdate).not.toHaveBeenCalled();
  });

  it('the opener passes the words from the nexus:quick-note event, and forgets them on close', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: daily() });
    apiMock.noteGet.mockResolvedValue(daily());
    apiMock.noteUpdate.mockImplementation(async (id, patch) => daily({ rev: 4, ...patch }));
    render(<QuickNoteButton />);
    act(() => { window.dispatchEvent(new CustomEvent('nexus:quick-note', { detail: { seed: '<p>From the share sheet</p>' } })); });
    expect(await screen.findByRole('dialog', { name: 'Quick Note' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toBe('Morning listFrom the share sheet'));
    // Closed and opened again the plain way (the bolt's New Note): nothing is added.
    act(() => { screen.getByRole('button', { name: 'Close Quick Note' }).click(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => { window.dispatchEvent(new CustomEvent('nexus:quick-note', { detail: { seed: '' } })); });
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toContain('Morning list'));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('.ProseMirror').textContent).not.toMatch(/From the share sheet.*From the share sheet/);
  });
});
