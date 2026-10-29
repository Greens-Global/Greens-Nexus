import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Unsent words in a task (Neil, Oct 29 2026): a comment started in the
// drawer survives switching tabs, and closing the drawer asks Keep Editing /
// Discard / Post instead of dropping it.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const editTaskComment = vi.fn(() => Promise.resolve({}));
const addTaskChecklistItems = vi.fn(() => Promise.resolve({ items: [], task: null }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_t, k) => (k === 'editTaskComment' ? editTaskComment : k === 'addTaskChecklistItems' ? addTaskChecklistItems : () => Promise.resolve([])),
  }),
}));

const task = { id: 't', title: 'Fix roof', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false };

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');
const drafts = await import('./taskDrafts');
const { draftKey, setDraft, getDraft, hasWords, draftsFor, resetTaskDrafts } = drafts;

beforeEach(() => {
  resetTaskDrafts();
  editTaskComment.mockClear();
  addTaskChecklistItems.mockClear();
  state = {
    tasks: [task], taskById: { t: task }, teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false,
    projectName: () => '', teamName: () => '', nameOf: (e) => e, myEmail: 'me@x.com',
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
    getComments: vi.fn(() => Promise.resolve([])),
    addComment: vi.fn(() => Promise.resolve({ id: 'new' })), offerUndo: vi.fn(), toggleComplete: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(), createTeam: vi.fn(), applyServerTask: vi.fn(),
  };
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const startComment = (text) => setDraft(draftKey('t', 'comment'), { taskId: 't', kind: 'comment' }, { text });
const tabButton = (name) => screen.getAllByRole('button').find((b) => b.textContent.trim().startsWith(name));

describe('the draft store', () => {
  it('counts only boxes with words in them', () => {
    expect(hasWords({ kind: 'comment', text: '<p></p>' })).toBe(false);
    expect(hasWords({ kind: 'comment', text: '<p>Hi</p>' })).toBe(true);
    expect(hasWords({ kind: 'checklist', text: '   ' })).toBe(false);
    expect(hasWords({ kind: 'comment', text: '', files: [{ name: 'a.png' }] })).toBe(true);
    // An edit that still reads as the saved comment is nothing to lose.
    expect(hasWords({ kind: 'edit', text: '<p>Same</p>', original: '<p>Same</p>' })).toBe(false);
    expect(hasWords({ kind: 'edit', text: '<p>Changed</p>', original: '<p>Same</p>' })).toBe(true);
  });

  it('keeps each task its own drafts and survives a reload', () => {
    startComment('<p>On t</p>');
    setDraft(draftKey('u', 'comment'), { taskId: 'u', kind: 'comment' }, { text: '<p>On u</p>' });
    expect(draftsFor(['t']).map((d) => d.text)).toEqual(['<p>On t</p>']);
    expect(JSON.parse(localStorage.getItem('nexus.taskDrafts'))[draftKey('t', 'comment')].text).toBe('<p>On t</p>');
  });
});

describe('a comment started in the drawer', () => {
  it('is still there after switching tabs', async () => {
    startComment('<p>Half a thought</p>');
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} />);
    fireEvent.click(tabButton('Activity'));
    fireEvent.click(tabButton('Comments'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    expect(getDraft(draftKey('t', 'comment')).text).toBe('<p>Half a thought</p>');
  });

  it('marks the tab that holds it while another tab is open', () => {
    startComment('<p>Half a thought</p>');
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} initialTab="activity" />);
    expect(screen.getAllByLabelText('Unsent draft')).toHaveLength(1);
    expect(tabButton('Comments')).toContainElement(screen.getByLabelText('Unsent draft'));
  });

  it('closing asks instead of losing it; Keep Editing stays', () => {
    startComment('<p>Half a thought</p>');
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} initialTab="activity" />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Unsent Comment');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // Lands on the tab that holds the box.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('a click outside the drawer asks too', () => {
    startComment('<p>Half a thought</p>');
    const onClose = vi.fn();
    const { baseElement } = render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.mouseDown(baseElement.querySelector('.nx-tasks-portal'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Discard closes and forgets it', () => {
    startComment('<p>Half a thought</p>');
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalled();
    expect(draftsFor(['t'])).toEqual([]);
  });

  it('Post Comment posts it, then closes', async () => {
    startComment('<p>Half a thought</p>');
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.addComment).toHaveBeenCalledWith('t', '<p>Half a thought</p>', {});
    expect(draftsFor(['t'])).toEqual([]);
  });

  it('a refused post keeps the prompt and the words', async () => {
    startComment('<p>Half a thought</p>');
    state.addComment = vi.fn(() => Promise.reject(new Error('Offline')));
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Offline'));
    expect(onClose).not.toHaveBeenCalled();
    expect(draftsFor(['t'])).toHaveLength(1);
  });

  it('nothing unsent closes straight away', () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('the other unsent boxes in a task', () => {
  it('several drafts are sent together: an edit, a checklist line and a subtask', async () => {
    setDraft(draftKey('t', 'edit', 'c1'), { taskId: 't', kind: 'edit', commentId: 'c1' }, { text: '<p>Fixed</p>', original: '<p>Old</p>' });
    setDraft(draftKey('t', 'checklist'), { taskId: 't', kind: 'checklist' }, { text: 'Buy shingles' });
    setDraft(draftKey('t', 'subtask'), { taskId: 't', kind: 'subtask' }, { text: 'Call the roofer' });
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="t" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Unsent Work');
    fireEvent.click(screen.getByRole('button', { name: 'Send All' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(editTaskComment).toHaveBeenCalledWith('c1', { body: '<p>Fixed</p>' });
    expect(addTaskChecklistItems).toHaveBeenCalledWith('t', { title: 'Buy shingles' });
    expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call the roofer', parentTaskId: 't' }));
  });

  it('a checklist line being typed stays in the box, its section open', async () => {
    setDraft(draftKey('t', 'checklist'), { taskId: 't', kind: 'checklist' }, { text: 'Buy shingles' });
    render(<TaskDetailDrawer taskId="t" onClose={() => {}} />);
    expect(await screen.findByLabelText('Add checklist item')).toHaveValue('Buy shingles');
  });
});
