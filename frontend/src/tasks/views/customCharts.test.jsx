import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Custom charts live in the person's profile (Oct 2026): a chart saved here
// is sent to /task-prefs, an old localStorage document is lifted once, and
// an editor can share a chart onto the project for everyone.

const saveTaskTablePrefs = vi.fn(() => Promise.resolve({}));
let serverPrefs = {};
let serverDown = false;
vi.mock('../../api', () => ({
  api: {
    getTaskTablePrefs: () => (serverDown ? Promise.reject(new Error('down')) : Promise.resolve({ prefs: serverPrefs })),
    saveTaskTablePrefs: (...a) => saveTaskTablePrefs(...a),
    resetTaskTablePrefs: () => Promise.resolve({}),
    resetAllTaskTablePrefs: () => Promise.resolve({}),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));

const { CustomChartsPanel } = await import('./charts');
const { __setTablePrefsCache } = await import('../tableCols');

const chart = { id: 'c1', title: 'Open by status', style: 'bar', dimension: 'status', metric: 'count', filters: { statuses: [], priorities: [], assigneeIds: [] } };
const tasks = [{ id: 't1', status: 'in_progress', priority: 'high', assigneeIds: [] }];
const baseStore = { myEmail: 'me@greensglobal.com', nameOf: (e) => e, projectName: () => '', teamName: () => '', customStatuses: [], teams: [], projects: [], shareProjectChart: vi.fn(() => Promise.resolve({})), unshareProjectChart: vi.fn(() => Promise.resolve({})), projectById: () => null };

describe('CustomChartsPanel persistence', () => {
  beforeEach(() => {
    saveTaskTablePrefs.mockClear();
    saveTaskTablePrefs.mockImplementation(() => Promise.resolve({}));
    baseStore.shareProjectChart.mockReset(); baseStore.shareProjectChart.mockImplementation(() => Promise.resolve({}));
    baseStore.unshareProjectChart.mockReset(); baseStore.unshareProjectChart.mockImplementation(() => Promise.resolve({}));
    serverPrefs = {};
    serverDown = false;
    localStorage.clear();
    __setTablePrefsCache(null);
  });

  it('renders charts from the profile document', async () => {
    serverPrefs = { charts: { data: { workspace: [chart] } } };
    render(<CustomChartsPanel scopeKey="workspace" tasks={tasks} store={baseStore} />);
    expect(await screen.findByText('Open by status')).toBeInTheDocument();
  });

  it('lifts the old localStorage document into the profile once', async () => {
    localStorage.setItem('nexus.customCharts', JSON.stringify({ workspace: [chart] }));
    render(<CustomChartsPanel scopeKey="workspace" tasks={tasks} store={baseStore} />);
    expect(await screen.findByText('Open by status')).toBeInTheDocument();
    await waitFor(() => expect(saveTaskTablePrefs).toHaveBeenCalledWith('charts', { data: { workspace: [chart] } }));
    expect(localStorage.getItem('nexus.customCharts')).toBeNull();
  });

  it('does not lift while the server cannot be reached', async () => {
    serverDown = true;
    localStorage.setItem('nexus.customCharts', JSON.stringify({ workspace: [chart] }));
    render(<CustomChartsPanel scopeKey="workspace" tasks={tasks} store={baseStore} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(saveTaskTablePrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('nexus.customCharts')).not.toBeNull();
  });

  it('removing a chart saves the whole document back', async () => {
    serverPrefs = { charts: { data: { workspace: [chart], p1: [{ ...chart, id: 'c2', title: 'Other' }] } } };
    render(<CustomChartsPanel scopeKey="workspace" tasks={tasks} store={baseStore} />);
    await screen.findByText('Open by status');
    await act(async () => { fireEvent.click(screen.getByTitle('Remove')); });
    expect(saveTaskTablePrefs).toHaveBeenCalledWith('charts', { data: { workspace: [], p1: [{ ...chart, id: 'c2', title: 'Other' }] } });
  });

  it('an editor shares a chart onto the project and sees shared ones', async () => {
    serverPrefs = { charts: { data: { p1: [chart] } } };
    const project = { id: 'p1', ownerId: 'me@greensglobal.com', accessLevel: 'restricted', sharedCharts: [{ ...chart, id: 's1', title: 'Team view' }] };
    const store = { ...baseStore, projectById: (id) => (id === 'p1' ? project : null) };
    render(<CustomChartsPanel scopeKey="p1" tasks={tasks} store={store} />);
    expect(await screen.findByText('Team view')).toBeInTheDocument();
    expect(screen.getByText('Project Charts')).toBeInTheDocument();
    // Shared charts come with the project; the personal one arrives with the
    // saved preferences a tick later - wait for it before clicking.
    const share = await screen.findByLabelText('Share Open by status');
    await act(async () => { fireEvent.click(share); });
    expect(store.shareProjectChart).toHaveBeenCalledWith('p1', chart);
    expect(saveTaskTablePrefs).toHaveBeenCalledWith('charts', { data: { p1: [] } });
  });

  it('a share the server refuses leaves the personal chart where it was', async () => {
    serverPrefs = { charts: { data: { p1: [chart] } } };
    const project = { id: 'p1', ownerId: 'me@greensglobal.com', accessLevel: 'restricted', sharedCharts: [] };
    const store = { ...baseStore, projectById: () => project };
    store.shareProjectChart.mockImplementation(() => Promise.reject(new Error('At most 24 shared charts per project')));
    render(<CustomChartsPanel scopeKey="p1" tasks={tasks} store={store} />);
    await screen.findByText('Open by status');
    await act(async () => { fireEvent.click(screen.getByLabelText('Share Open by status')); });
    expect(saveTaskTablePrefs).not.toHaveBeenCalled();
    expect(screen.getByText('Open by status')).toBeInTheDocument();
    expect(screen.getByText('At most 24 shared charts per project')).toBeInTheDocument();
  });

  it('a viewer sees shared charts but no share controls', async () => {
    const project = { id: 'p1', ownerId: 'x', accessLevel: 'restricted', memberRoles: { 'me@greensglobal.com': 'viewer' }, memberIds: ['me@greensglobal.com'], sharedCharts: [{ ...chart, id: 's1', title: 'Team view' }] };
    const store = { ...baseStore, projectById: () => project };
    render(<CustomChartsPanel scopeKey="p1" tasks={tasks} store={store} />);
    expect(await screen.findByText('Team view')).toBeInTheDocument();
    expect(screen.queryByTitle('Remove')).toBeNull();
    expect(screen.queryByLabelText(/^Share /)).toBeNull();
  });
});
