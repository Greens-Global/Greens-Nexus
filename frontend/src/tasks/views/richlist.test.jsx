import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RichListView from './richlist';

// Render-smoke test for the task list. This is the exact guard that was missing
// on 2026-08-02: a merge left an orphaned `g.renderTasks.length` reference, the
// list threw "Cannot read properties of undefined (reading 'length')" at render,
// and the whole Tasks section died - yet build + lint passed. Rendering the
// component with real data shape catches that class of bug.

const mockTasks = [
  {
    id: 't1', title: 'First task', status: 'not_started', priority: 'medium',
    assigneeId: '', teamId: '', projectId: '', dueOn: '', startOn: '',
    estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [],
    attachmentIds: [], tags: [], completed: false, code: 'T-1', customFieldValues: {},
  },
  {
    id: 't2', title: 'Second task', status: 'in_progress', priority: 'high',
    assigneeId: '', teamId: '', projectId: '', dueOn: '2026-09-01', startOn: '',
    estimateHours: 2, followerIds: [], subtaskIds: [], commentIds: [],
    attachmentIds: [], tags: [], completed: false, code: 'T-2', customFieldValues: {},
  },
];

const store = {
  tasks: mockTasks,
  taskById: Object.fromEntries(mockTasks.map((t) => [t.id, t])),
  customFields: [],
  customStatuses: [],
  projects: [],
  teams: [],
  loading: false,
  statusOrder: ['not_started', 'in_progress', 'done'],
  statusMeta: {
    not_started: { label: 'Not Started', color: '#888', tint: '#eee' },
    in_progress: { label: 'In Progress', color: '#4488ff', tint: '#e6f0ff' },
    done: { label: 'Done', color: '#44aa44', tint: '#e8f5e8' },
  },
  projectName: () => 'Project',
  teamById: () => null,
  teamName: () => '',
  setStatus: () => {},
  toggleComplete: () => {},
  updateTask: () => Promise.resolve({}),
  createTask: () => Promise.resolve({}),
};

const ctx = { nameOf: () => '', projectName: () => 'Project', teamName: () => '', customFields: [] };

function renderList(props = {}) {
  return render(
    <RichListView
      visible={mockTasks}
      group="status"
      ctx={ctx}
      store={store}
      people={[]}
      selected={new Set()}
      toggleSel={() => {}}
      onOpen={() => {}}
      onSelectAll={() => {}}
      lockedProjectId=""
      hidden={new Set()}
      setHidden={() => {}}
      {...props}
    />,
  );
}

describe('RichListView (task list) render-smoke', () => {
  it('renders task rows without throwing', () => {
    renderList();
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task')).toBeInTheDocument();
  });

  it('renders an empty list without throwing', () => {
    const { container } = renderList({ visible: [] });
    expect(container).toBeTruthy();
  });
});
