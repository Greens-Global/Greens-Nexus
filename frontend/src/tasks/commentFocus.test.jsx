import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Tasks Home > Updates opens a task AT the comment an update is about (Oct 21
// 2026): the drawer starts on Comments and scrolls that comment into view.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));

const task = { id: 't', title: 'Fix roof', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: [], commentIds: ['c1', 'c2'], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false };
const comment = (id, body) => ({ id, taskId: 't', authorId: 'sagar@x.com', body, createdAt: '2026-10-20T10:00:00Z',
  parentId: '', reactions: {}, assigneeId: '', resolvedAt: '', pinned: false });

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

let scrolled;
beforeEach(() => {
  state = {
    tasks: [task], taskById: { t: task }, teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false,
    projectName: () => '', teamName: () => '', nameOf: (e) => e, myEmail: 'me@x.com',
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
    getComments: vi.fn(() => Promise.resolve([comment('c1', '<p>First</p>'), comment('c2', '<p>Can you check this?</p>')])),
    addComment: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(() => Promise.resolve()), refresh: vi.fn(), createTeam: vi.fn(),
  };
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.getAttribute('data-comment-id')); };
});
afterEach(() => { delete Element.prototype.scrollIntoView; });

describe('opening a task at a comment', () => {
  it('lands on that comment', async () => {
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} focusComment={{ id: 'c2', threadId: 'c2' }} />);
    await waitFor(() => expect(scrolled).toEqual(['c2']));
  });

  it('falls back to the thread when the comment itself is not shown', async () => {
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} focusComment={{ id: 'gone', threadId: 'c1' }} />);
    await waitFor(() => expect(scrolled).toEqual(['c1']));
  });

  it('does nothing without one', async () => {
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(scrolled).toEqual([]);
  });
});
