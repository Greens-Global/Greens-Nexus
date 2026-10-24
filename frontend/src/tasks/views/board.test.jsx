import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BoardView from './board';
import { wipStorageKey } from '../lib';

// Render-smoke for the Board view (the crash's sibling - it also caps/renders
// tasks per column). Mounting it with real data shape catches render crashes
// that build + lint miss.

const mockTasks = [
  { id: 't1', title: 'Board task A', status: 'not_started', priority: 'medium', assigneeId: '', teamId: '', projectId: '', dueOn: '', followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, code: 'B-1', customFieldValues: {} },
  { id: 't2', title: 'Board task B', status: 'in_progress', priority: 'high', assigneeId: '', teamId: '', projectId: '', dueOn: '', followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, code: 'B-2', customFieldValues: {} },
];

const store = {
  tasks: mockTasks,
  customFields: [],
  customStatuses: [],
  projects: [],
  statusMeta: {
    not_started: { label: 'Not Started', color: '#888', tint: '#eee' },
    in_progress: { label: 'In Progress', color: '#4488ff', tint: '#e6f0ff' },
    done: { label: 'Done', color: '#44aa44', tint: '#e8f5e8' },
  },
  statusOrder: ['not_started', 'in_progress', 'done'],
  projectName: () => 'Project',
  addComment: () => Promise.resolve(),
  createCustomStatus: () => Promise.resolve(),
  createTask: () => Promise.resolve({}),
  deleteCustomStatus: () => Promise.resolve(),
  setStatus: () => {},
  toggleComplete: () => {},
  updateTask: () => Promise.resolve({}),
};

const ctx = { nameOf: () => '', projectName: () => 'Project', teamName: () => '' };

describe('BoardView render-smoke', () => {
  it('renders task cards without throwing', () => {
    render(<BoardView visible={mockTasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="" defaultAssigneeId="" />);
    expect(screen.getByText('Board task A')).toBeInTheDocument();
  });

  it('renders an empty board without throwing', () => {
    const { container } = render(<BoardView visible={[]} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="" defaultAssigneeId="" />);
    expect(container).toBeTruthy();
  });
});

describe('board card comment (Oct 21 2026)', () => {
  const openComment = () => {
    const card = screen.getByText('Board task A').closest('[data-task-row]');
    fireEvent.click(card.querySelector('button[aria-label="Add Comment"]'));
  };

  it('keeps the draft and says why when the comment does not post', async () => {
    const failing = { ...store, addComment: () => Promise.reject(new Error('You need at least commenter access')) };
    render(<BoardView visible={mockTasks} ctx={ctx} store={failing} onOpen={() => {}} lockedProjectId="" defaultAssigneeId="" />);
    openComment();
    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Ready for review' } });
    await act(async () => { fireEvent.click(screen.getByText('Post')); });
    expect(screen.getByPlaceholderText('Add a comment…').value).toBe('Ready for review');
    expect(screen.getByRole('alert').textContent).toMatch(/commenter access/);
  });

  it('clears and closes once the comment has posted', async () => {
    let posted = null;
    const ok = { ...store, addComment: (id, body) => { posted = [id, body]; return Promise.resolve({ id: 'c1' }); } };
    render(<BoardView visible={mockTasks} ctx={ctx} store={ok} onOpen={() => {}} lockedProjectId="" defaultAssigneeId="" />);
    openComment();
    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Done' } });
    await act(async () => { fireEvent.click(screen.getByText('Post')); });
    expect(posted).toEqual(['t1', 'Done']);
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull();
  });
});

describe('board WIP limits are per board (Oct 21 2026)', () => {
  beforeEach(() => localStorage.clear());

  it('keys each project, My Tasks and the unscoped board apart', () => {
    expect(wipStorageKey('p1', '')).toBe('nexus.board.wip:project:p1');
    expect(wipStorageKey('p2', 'me@x.com')).toBe('nexus.board.wip:project:p2');
    expect(wipStorageKey('', 'me@x.com')).toBe('nexus.board.wip:mine');
    expect(wipStorageKey('', '')).toBe('nexus.board.wip:all');
  });

  it("one project's limit does not show on another project's board, and the old shared key is not read", () => {
    localStorage.setItem('nexus.board.wip', JSON.stringify({ not_started: 1 }));
    localStorage.setItem(wipStorageKey('p1', ''), JSON.stringify({ in_progress: 5 }));
    const { rerender } = render(<BoardView visible={mockTasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" defaultAssigneeId="" />);
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    expect(screen.queryByText('1 / 1')).toBeNull();
    rerender(<BoardView visible={mockTasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p2" defaultAssigneeId="" />);
    expect(screen.queryByText('1 / 5')).toBeNull();
    expect(screen.queryByText('1 / 1')).toBeNull();
  });
});

describe('board keyboard path (Oct 21 2026)', () => {
  it('a card is focusable and Enter opens it; keys in its own controls do not', () => {
    const onOpen = vi.fn();
    render(<BoardView visible={mockTasks} ctx={ctx} store={store} onOpen={onOpen} lockedProjectId="" defaultAssigneeId="" />);
    const card = screen.getByText('Board task A').closest('[data-task-row]');
    expect(card.tabIndex).toBe(0);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('t1');
    onOpen.mockClear();
    fireEvent.keyDown(card.querySelector('button'), { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Move To changes the status without a drag, and does not open the card', async () => {
    const onOpen = vi.fn();
    const setStatus = vi.fn(() => Promise.resolve());
    render(<BoardView visible={mockTasks} ctx={ctx} store={{ ...store, setStatus }} onOpen={onOpen} lockedProjectId="" defaultAssigneeId="" />);
    fireEvent.click(screen.getByLabelText('Move Board task A to another status'));
    const menu = await screen.findByRole('menu', { name: 'Move To' });
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.find((b) => b.textContent.includes('Not Started')).disabled).toBe(true);   // where it is now
    fireEvent.click(items.find((b) => b.textContent.includes('In Progress')));
    expect(setStatus).toHaveBeenCalledWith('t1', 'in_progress');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
