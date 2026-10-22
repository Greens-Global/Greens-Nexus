import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { currentVersionsOf, egnyteLinkProblem, egnyteLinkInfo, egnyteCrumbs, safeEgnyteHref, canVersion } from './egnyteLinks';

// Task file versions and Egnyte links (Neil, Oct 22 2026): the list shows the
// current version of each file with a soft "V3"; Versions lists them all;
// an Egnyte link opens in Egnyte; Paste Egnyte Link takes only the company
// Egnyte host.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const api = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (() => Promise.resolve([])) }) }));
const uploadVersion = vi.hoisted(() => vi.fn());
vi.mock('./lib', async (orig) => ({ ...(await orig()), uploadTaskAttachmentVersion: (...a) => uploadVersion(...a) }));
const dialogConfirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => dialogConfirm(...a), alert: () => Promise.resolve() } }));

const ME = 'me@x.com';
const task = {
  id: 't1', title: 'Fix the pump', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: [], commentIds: [], attachmentIds: ['v3'], followerIds: [], tags: [], customFieldValues: {}, completed: false,
};
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

const file = (over) => ({ id: 'a1', name: 'plan.pdf', url: 'https://x/plan.pdf', size: '2 KB', kind: 'doc', addedBy: ME,
  addedAt: '2026-10-04T15:05:00', version: 1, versionGroup: 'a1', versionCount: 1, ...over });
const V3 = file({ id: 'v3', name: 'plan-v3.pdf', version: 3, versionCount: 3 });
const V2 = file({ id: 'v2', name: 'plan-v2.pdf', version: 2, versionCount: 3 });
const V1 = file({ id: 'a1', version: 1, versionCount: 3 });
const EGNYTE = { id: 'e1', name: 'Temecula Lease', kind: 'egnyte', egnyteKind: 'folder', egnytePath: '/Shared/Leases/Temecula Lease',
  url: 'https://greens.egnyte.com/app/index.do#storage/files/1/Shared/Leases/Temecula%20Lease', addedBy: 'other@x.com', version: 1, versionGroup: 'e1', versionCount: 1 };

beforeEach(() => {
  for (const k of Object.keys(api)) delete api[k];
  uploadVersion.mockReset(); dialogConfirm.mockClear();
  state = {
    tasks: [task], taskById: { t1: task }, teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false, projectName: () => '', teamName: () => '', nameOf: (e) => (e === ME ? 'Me Myself' : e), myEmail: ME,
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(), getComments: vi.fn(() => Promise.resolve([])),
    addComment: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(), refresh: vi.fn(),
  };
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

describe('version and link helpers', () => {
  it('keeps the highest version of each file, in first-seen order', () => {
    const b = file({ id: 'b', name: 'b.pdf', versionGroup: 'b' });
    expect(currentVersionsOf([V1, b, V3, V2]).map((a) => a.id)).toEqual(['v3', 'b']);
    expect(currentVersionsOf([{ id: 'old', name: 'x' }]).map((a) => a.id)).toEqual(['old']);   // pre-versions row
  });

  it('only task files take versions', () => {
    expect(canVersion(V3)).toBe(true);
    expect(canVersion(EGNYTE)).toBe(false);
    expect(canVersion(file({ commentId: 'c1' }))).toBe(false);
  });

  it('a pasted link must be https on the company Egnyte host', () => {
    const host = 'greens.egnyte.com';
    expect(egnyteLinkProblem('https://greens.egnyte.com/fl/abc', host)).toBe('');
    expect(egnyteLinkProblem('https://GREENS.egnyte.com/navigate/file/abc', host)).toBe('');
    for (const bad of ['https://egnyte.com.evil.com/fl/x', 'https://greens.egnyte.com.evil.com/fl/x', 'https://evilgreens.egnyte.com/x',
      'https://greens.egnyte.com@evil.com/x', 'https://u:p@greens.egnyte.com/x', 'http://greens.egnyte.com/fl/x',
      'https://greens.egnyte.com:8443/x', 'javascript:alert(1)', 'data:text/html,hi', 'greens.egnyte.com/fl/x', '', 'https://greens.egnyte.com/a b']) {
      expect(egnyteLinkProblem(bad, host), bad).not.toBe('');
    }
    // Host unknown: the https shape is still checked.
    expect(egnyteLinkProblem('javascript:alert(1)', '')).not.toBe('');
    expect(egnyteLinkProblem('https://anything.example.com/x', '')).toBe('');
  });

  it('reads the path, name and folder-ness out of an Egnyte address-bar link', () => {
    expect(egnyteLinkInfo(EGNYTE.url)).toEqual({ path: '/Shared/Leases/Temecula Lease', name: 'Temecula Lease', isFolder: true });
    expect(egnyteLinkInfo('https://greens.egnyte.com/navigate/file/abc')).toEqual({ path: '', name: '', isFolder: false });
    expect(egnyteLinkInfo('https://greens.egnyte.com/fl/abc').isFolder).toBe(null);
    expect(egnyteCrumbs('/Shared/Leases/Temecula Lease')).toEqual(['Shared', 'Leases']);
    expect(safeEgnyteHref({ url: 'javascript:alert(1)' })).toBe('');
  });
});

describe('the Attachments list', () => {
  it('shows only the latest version with a V3 label and opens every version', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([V3, V2]));
    api.getTaskAttachmentVersions = vi.fn(() => Promise.resolve([V3, V2, V1]));
    api.deleteTaskAttachmentVersions = vi.fn(() => Promise.resolve());
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const rows = await screen.findAllByTestId('attachment-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('plan-v3.pdf');
    expect(rows[0].textContent).toContain('V3');
    expect(screen.queryByText('plan-v2.pdf')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByLabelText('Versions of plan-v3.pdf')); });
    const list = await screen.findByTestId('versions-list');
    const vrows = await within(list).findAllByTestId('version-row');
    expect(vrows.map((r) => r.textContent.match(/V\d/)[0])).toEqual(['V3', 'V2', 'V1']);
    expect(vrows[0].textContent).toContain('Current');
    expect(vrows[2].textContent).toContain('Me Myself');
    expect(vrows[2].textContent).toMatch(/10\/04\/2026, 3:05 PM/);
    expect(within(vrows[1]).getByLabelText('Download version 2')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Delete All Versions')); });
    expect(dialogConfirm).toHaveBeenCalled();
    expect(api.deleteTaskAttachmentVersions).toHaveBeenCalledWith('v3');
  });

  it('removing the current version says the one before takes over', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([V3]));
    api.deleteTaskAttachment = vi.fn(() => Promise.resolve());
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const remove = await screen.findByLabelText('Remove plan-v3.pdf');
    await act(async () => { fireEvent.click(remove); });
    expect(dialogConfirm.mock.calls[0][0]).toContain('version before it becomes the current one');
    expect(api.deleteTaskAttachment).toHaveBeenCalledWith('v3');
  });

  it('Upload New Version and a file dropped on the row both add a version', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([file()]));
    uploadVersion.mockResolvedValue({ id: 'v2' });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('Upload new version of plan.pdf'));
    const f1 = new File(['x'], 'plan-rev.pdf', { type: 'application/pdf' });
    await act(async () => { fireEvent.change(screen.getByTestId('version-input'), { target: { files: [f1] } }); });
    expect(uploadVersion).toHaveBeenCalledWith('a1', f1, expect.any(Function));
    const f2 = new File(['y'], 'plan-rev2.pdf', { type: 'application/pdf' });
    const row = screen.getByTestId('attachment-row');
    await act(async () => { fireEvent.drop(row, { dataTransfer: { files: [f2], types: ['Files'] } }); });
    expect(uploadVersion).toHaveBeenLastCalledWith('a1', f2, expect.any(Function));
  });

  it('a failed new version is said out loud', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([file()]));
    uploadVersion.mockRejectedValue(new Error('You need at least commenter access'));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('Upload new version of plan.pdf'));
    await act(async () => { fireEvent.change(screen.getByTestId('version-input'), { target: { files: [new File(['x'], 'p.pdf')] } }); });
    expect((await screen.findByText(/did not upload/)).textContent).toContain('commenter access');
  });

  it('an Egnyte link renders as a link to Egnyte, with no versions', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([EGNYTE]));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const row = await screen.findByTestId('egnyte-link');
    expect(row.textContent).toContain('Temecula Lease');
    expect(row.textContent).toContain('Shared › Leases');
    const open = within(row).getByText('Open In Egnyte').closest('a');
    expect(open.getAttribute('href')).toBe(EGNYTE.url);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(screen.queryByLabelText('Upload new version of Temecula Lease')).toBeNull();
    expect(screen.queryByTestId('attachment-row')).toBeNull();
  });
});

describe('a read-only viewer', () => {
  it('sees the files and Versions, but no Upload New Version or Add From Egnyte', async () => {
    const t = { ...task, projectId: 'p1', assigneeIds: ['other@x.com'] };
    state = { ...state, tasks: [t], taskById: { t1: t },
      projects: [{ id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: 'viewer' } }] };
    api.getTaskAttachments = vi.fn(() => Promise.resolve([V3, EGNYTE]));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await screen.findByTestId('attachment-row');
    expect(screen.getByLabelText('Versions of plan-v3.pdf')).toBeTruthy();
    expect(screen.queryByLabelText('Upload new version of plan-v3.pdf')).toBeNull();
    expect(screen.queryByText('Add From Egnyte')).toBeNull();
    expect(screen.queryByLabelText('Remove Temecula Lease')).toBeNull();   // someone else's link
  });
});

describe('Add From Egnyte', () => {
  it('without a connection it explains and offers Paste Egnyte Link, company host only', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([]));
    api.egnyteStatus = vi.fn(() => Promise.resolve({ configured: true, webHost: 'greens.egnyte.com', oauth: { enabled: true, mustConnect: true } }));
    api.addTaskEgnyteLink = vi.fn(() => Promise.resolve({ id: 'e1' }));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const addBtn = await screen.findByText('Add From Egnyte');
    await act(async () => { fireEvent.click(addBtn); });
    expect((await screen.findByTestId('egnyte-blocked')).textContent).toContain('not connected');
    const box = screen.getByLabelText('Egnyte link');
    fireEvent.change(box, { target: { value: 'https://greens.egnyte.com.evil.com/fl/x' } });
    expect(screen.getByTestId('paste-problem').textContent).toContain('greens.egnyte.com');
    expect(screen.getByText('Add Link').closest('button').disabled).toBe(true);
    fireEvent.change(box, { target: { value: EGNYTE.url } });
    expect(screen.queryByTestId('paste-problem')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Add Link')); });
    expect(api.addTaskEgnyteLink).toHaveBeenCalledWith('t1', { url: EGNYTE.url, path: '/Shared/Leases/Temecula Lease', name: 'Temecula Lease', is_folder: true });
  });

  it('browses folders and links a picked file', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([]));
    api.egnyteStatus = vi.fn(() => Promise.resolve({ configured: true, webHost: 'greens.egnyte.com', oauth: { enabled: true, connected: true, mustConnect: false } }));
    api.egnyteFolder = vi.fn((p) => Promise.resolve(p === '/Shared/Plans'
      ? { path: p, folders: [], files: [{ name: 'site.pdf', path: '/Shared/Plans/site.pdf', size: 2048, webUrl: 'https://greens.egnyte.com/navigate/file/g1' }] }
      : { path: '/', folders: [{ name: 'Plans', path: '/Shared/Plans', webUrl: 'https://greens.egnyte.com/app/index.do#storage/files/1/Shared/Plans' }], files: [] }));
    api.addTaskEgnyteLink = vi.fn(() => Promise.resolve({ id: 'e2' }));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const addBtn = await screen.findByText('Add From Egnyte');
    await act(async () => { fireEvent.click(addBtn); });
    const plans = await screen.findByTitle('Open Plans');
    await act(async () => { fireEvent.click(plans); });
    const linkFile = await screen.findByText('Link File');
    await act(async () => { fireEvent.click(linkFile); });
    expect(api.addTaskEgnyteLink).toHaveBeenCalledWith('t1', { url: 'https://greens.egnyte.com/navigate/file/g1', path: '/Shared/Plans/site.pdf', name: 'site.pdf', is_folder: false });
    await waitFor(() => expect(screen.queryByText('Link File')).toBeNull());
  });
});
