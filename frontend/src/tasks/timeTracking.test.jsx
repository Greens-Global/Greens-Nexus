import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { hasTimeData, projectTracksTime, taskTracksTime } from './lib';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// Time tracking per project (Oct 13 2026): Time / Actual are not shown by
// default - only where a project tracks time, or a task has time on it.

const { default: RichListView } = await import('./views/richlist');

const acct = { id: 'p-acct', name: '#General - Accounting', timeTracking: '' };
const itProj = { id: 'p-it', name: '#General - IT Support', timeTracking: '' };
const plain = (id, projectId, extra = {}) => ({
  id, title: id, status: 'not_started', priority: 'medium', projectId, assigneeId: '', teamId: '', dueOn: '', startOn: '',
  estimateHours: null, actualHours: null, followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [],
  completed: false, customFieldValues: {}, ...extra,
});
const tasks = [plain('a1', 'p-acct'), plain('a2', 'p-acct'), plain('i1', 'p-it', { estimateHours: 2 })];

describe('which projects track time', () => {
  it('automatic: only once a task in the project has time on it', () => {
    expect(projectTracksTime(acct, tasks)).toBe(false);
    expect(projectTracksTime(itProj, tasks)).toBe(true);
  });

  it('On and Off win over what the tasks hold', () => {
    expect(projectTracksTime({ ...acct, timeTracking: 'on' }, tasks)).toBe(true);
    expect(projectTracksTime({ ...itProj, timeTracking: 'off' }, tasks)).toBe(false);
  });

  it('a task with time on it keeps showing it, even in a project that is Off', () => {
    const off = [{ ...itProj, timeTracking: 'off' }];
    expect(taskTracksTime(tasks[2], off, tasks)).toBe(true);
    expect(taskTracksTime(tasks[0], [acct], tasks)).toBe(false);
    expect(hasTimeData({ estimateHours: 0, actualHours: 0 })).toBe(false);
  });
});

describe('the list in a project', () => {
  const store = {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), customFields: [], customStatuses: [],
    projects: [acct, itProj], teams: [], loading: false, statusOrder: ['not_started'],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } },
    projectName: () => '', teamById: () => null, teamName: () => '', setStatus: () => {}, toggleComplete: () => {},
    updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
  };
  const ctx = { nameOf: () => '', projectName: () => '', teamName: () => '', customFields: [] };
  const renderList = (projectId, projects = store.projects) => render(
    <RichListView visible={tasks.filter((t) => t.projectId === projectId)} group="status" ctx={ctx}
      store={{ ...store, projects }} people={[]} selected={new Set()} setSelected={() => {}} toggleSel={() => {}}
      onOpen={() => {}} lockedProjectId={projectId} hidden={new Set()} setHidden={() => {}} />,
  );

  beforeEach(() => {
    globalThis.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
  });

  it('has no Time / Actual columns where the project does not track time', () => {
    renderList('p-acct');
    expect(screen.queryByText('Time')).toBeNull();
    expect(screen.queryByText('Actual')).toBeNull();
  });

  it('has them where it does', () => {
    renderList('p-it');
    expect(screen.getByText('Time')).toBeTruthy();
    expect(screen.getByText('Actual')).toBeTruthy();
  });

  it('switched On, an untracked project gets them', () => {
    renderList('p-acct', [{ ...acct, timeTracking: 'on' }, itProj]);
    expect(screen.getByText('Time')).toBeTruthy();
  });
});
