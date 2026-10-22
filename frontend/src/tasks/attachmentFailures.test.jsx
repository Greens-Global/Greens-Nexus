import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// Attachments that fail are said out loud (Oct 21 2026). An upload that the
// server refused used to vanish from the list with no word; removing a file
// had no confirm and swallowed a refusal.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const api = vi.hoisted(() => ({ deleteTaskAttachment: vi.fn(), getTaskAttachments: vi.fn(() => Promise.resolve([])) }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (() => Promise.resolve([])) }) }));
const upload = vi.hoisted(() => vi.fn());
vi.mock('./lib', async (orig) => ({ ...(await orig()), uploadTaskAttachment: (...a) => upload(...a) }));
const dialogConfirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => dialogConfirm(...a), alert: () => Promise.resolve() } }));

const task = {
  id: 't1', title: 'Fix the pump', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false,
};
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

beforeEach(() => {
  upload.mockReset(); api.deleteTaskAttachment.mockReset(); dialogConfirm.mockClear();
  api.getTaskAttachments.mockImplementation(() => Promise.resolve([]));
  state = {
    tasks: [task], taskById: { t1: task }, teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false, projectName: () => '', teamName: () => '', nameOf: (e) => e, myEmail: 'me@x.com',
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(), getComments: vi.fn(() => Promise.resolve([])),
    addComment: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(), refresh: vi.fn(),
  };
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

const pick = (file) => {
  // The Attachments section's own input sits just before its Attach File button.
  const input = screen.getByText('Attach File').closest('button').previousElementSibling;
  fireEvent.change(input, { target: { files: [file] } });
};

describe('task attachments', () => {
  it('a refused upload stays on screen with the reason and a Retry that works', async () => {
    upload.mockRejectedValueOnce(new Error('You need at least commenter access')).mockResolvedValueOnce({ id: 'a1' });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await act(async () => { pick(new File(['x'], 'photo.png', { type: 'image/png' })); });
    const row = await screen.findByTestId("upload-failed");
    expect(row.textContent).toContain('photo.png');
    expect(row.textContent).toContain('commenter access');
    await act(async () => { fireEvent.click(screen.getByText('Retry')); });
    expect(upload).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId('upload-failed')).toBeNull());
  });

  it('asks before removing a file, and says so when the server refuses', async () => {
    api.getTaskAttachments.mockImplementation(() => Promise.resolve([{ id: 'a1', name: 'quote.pdf', url: 'https://x/quote.pdf', size: '2 KB', kind: 'other', addedBy: 'me@x.com' }]));
    api.deleteTaskAttachment.mockRejectedValue(new Error('Not allowed'));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const remove = await screen.findByLabelText('Remove quote.pdf');
    dialogConfirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(remove); });
    expect(dialogConfirm).toHaveBeenCalledTimes(1);
    expect(api.deleteTaskAttachment).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove quote.pdf')); });
    expect(api.deleteTaskAttachment).toHaveBeenCalledWith('a1');
    expect((await screen.findByText(/Could not remove "quote.pdf"/)).textContent).toContain('Not allowed');
  });
});
