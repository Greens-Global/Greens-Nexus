import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BoardView from './board';

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
