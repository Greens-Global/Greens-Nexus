import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Web links (Neil, Oct 22 2026 - Planner parity): Add Link attaches any web
// page as a link. The row shows a link icon, the name (or the address) and
// the website; it opens in a new tab, never the in-app viewer; it takes no
// versions; the person who added it or an editor edits or removes it, and a
// viewer only sees it. The storage-URL rewriting in api.js never touches it.

vi.mock('../bffAuth', () => ({ BFF_MODE: true }));
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const api = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (() => Promise.resolve([])) }) }));
const dialogConfirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => dialogConfirm(...a), alert: () => Promise.resolve() } }));

const ME = 'me@x.com';
const task = {
  id: 't1', title: 'Fix the pump', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: [], commentIds: [], attachmentIds: ['l1'], followerIds: [], tags: [], customFieldValues: {}, completed: false,
};
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { webLinkProblem, safeLinkHref, linkHost, linkLabel, linkCustomName, isWebLink } = await import('./webLinks');
const { rewriteResponseText, restoreRequestBody } = await import('../lib/storageView');
const { WebLinkRow, WebLinkModal } = await import('./attachmentParts');
const { FilesView } = await import('./views/more');
const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

const LINK = { id: 'l1', taskId: 't1', name: 'Vendor Portal', kind: 'link', url: 'https://www.vendor.example/portal?id=7',
  size: '', addedBy: ME, addedAt: '2026-10-22T09:00:00', version: 1, versionGroup: 'l1', versionCount: 1 };
const BARE = { ...LINK, id: 'l2', versionGroup: 'l2', name: 'https://docs.example.com/spec', url: 'https://docs.example.com/spec', addedBy: 'other@x.com' };

beforeEach(() => {
  for (const k of Object.keys(api)) delete api[k];
  dialogConfirm.mockClear();
  state = {
    tasks: [task], taskById: { t1: task }, teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false, projectName: () => '', teamName: () => '', nameOf: (e) => e, myEmail: ME,
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(), getComments: vi.fn(() => Promise.resolve([])),
    addComment: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(), refresh: vi.fn(),
  };
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

describe('link helpers', () => {
  it('takes http(s) links and a bare website, like the server', () => {
    for (const ok of ['https://example.com/page', 'http://example.com', 'example.com/page', 'www.example.com:8080/x',
      'https://example.com/my file.pdf', 'https://[2001:db8::1]:8080/x', 'HTTPS://Example.com/x',
      'https://greens.sharepoint.com/:w:/r/sites/Ops/Doc.docx?d=w1', 'https://site.example/files/view?menu=1']) {
      expect(webLinkProblem(ok), ok).toBe('');
    }
  });

  it('refuses what the server refuses, saying why', () => {
    const bad = {
      '': 'Paste the web address',
      'javascript:alert(1)': 'Only web links',
      'data:text/html,hi': 'Only web links',
      'file:///etc/passwd': 'Only web links',
      'vbscript:x': 'Only web links',
      'mailto:a@b.com': 'Only web links',
      'localhost:3000/x': 'Only web links',
      '/relative': 'full link',
      '//example.com/x': 'full link',
      'https:example.com': 'not a valid link',
      'https://user:pass@example.com/': 'user name or password',
      'https://example.com\\@evil.com/': 'backslash',
      [`https://example.com/a${String.fromCharCode(10)}b`]: 'hidden characters',
      [`https://example.com/${String.fromCharCode(0x202e)}exe.pdf`]: 'hidden characters',
      [`https://exa${String.fromCharCode(0x200b)}mple.com/`]: 'hidden characters',
      'https:///path': 'no website',
      [`https://example.com/${'a'.repeat(2000)}`]: 'too long',
      'https://example.supabase.co/storage/v1/object/public/task-files/a.png': 'stored in Nexus',
      '/api/files/view?u=https%3A%2F%2Fexample.supabase.co%2Fx': 'full link',
      'https://nexus.example.com/api/files/view?u=abc': 'stored in Nexus',
    };
    for (const [value, says] of Object.entries(bad)) {
      expect(webLinkProblem(value), JSON.stringify(value)).toContain(says);
      expect(webLinkProblem(value)).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it('opens only http(s), shows the website, and the name or the address', () => {
    expect(safeLinkHref({ url: 'javascript:alert(1)' })).toBe('');
    expect(safeLinkHref({ url: 'data:text/html,x' })).toBe('');
    expect(safeLinkHref(LINK)).toBe(LINK.url);
    expect(linkHost(LINK.url)).toBe('vendor.example');
    expect(linkHost('https://xn--bcher-kva.example/x')).toBe('xn--bcher-kva.example');
    expect(linkHost('not a url')).toBe('');
    expect(linkLabel(LINK)).toBe('Vendor Portal');
    expect(linkLabel(BARE)).toBe(BARE.url);
    expect(linkCustomName(BARE)).toBe('');
    expect(linkCustomName(LINK)).toBe('Vendor Portal');
    expect(isWebLink(LINK)).toBe(true);
    expect(isWebLink({ kind: 'egnyte' })).toBe(false);
  });

  it('the storage-URL rewriting leaves a link alone, both ways', () => {
    const rows = [LINK, BARE, { ...LINK, url: 'https://example.com/?next=/files/x' }];
    const text = JSON.stringify(rows);
    expect(rewriteResponseText(text)).toBe(text);
    const body = JSON.stringify({ url: LINK.url, name: LINK.name });
    expect(restoreRequestBody(body)).toBe(body);
  });
});

describe('a link row', () => {
  it('opens in a new tab with the name and the website, and offers only what it is given', () => {
    const onEdit = vi.fn();
    const { rerender } = render(<WebLinkRow a={LINK} onEdit={onEdit} onRemove={() => {}} />);
    const row = screen.getByTestId('web-link');
    const a = row.querySelector('a');
    expect(a.getAttribute('href')).toBe(LINK.url);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(row.textContent).toContain('Vendor Portal');
    expect(screen.getByTestId('link-host').textContent).toBe('vendor.example');
    fireEvent.click(screen.getByLabelText('Edit link Vendor Portal'));
    expect(onEdit).toHaveBeenCalled();
    rerender(<WebLinkRow a={BARE} />);
    expect(screen.getByTestId('web-link').textContent).toContain(BARE.url);
    expect(screen.queryByLabelText(/Edit link/)).toBeNull();
    expect(screen.queryByLabelText(/Remove/)).toBeNull();
  });

  it('a row whose address is not http(s) is shown but not openable', () => {
    render(<WebLinkRow a={{ ...LINK, url: 'javascript:alert(1)' }} />);
    expect(screen.getByTestId('web-link').querySelector('a')).toBeNull();
  });
});

describe('Add Link and Edit Link', () => {
  it('explains a bad address, then adds a good one with its name', async () => {
    api.addTaskLink = vi.fn(() => Promise.resolve({ ...LINK }));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<WebLinkModal taskId="t1" onClose={onClose} onSaved={onSaved} />);
    const box = screen.getByLabelText('Web address');
    fireEvent.change(box, { target: { value: 'javascript:alert(1)' } });
    expect(screen.getByTestId('link-problem').textContent).toContain('Only web links');
    const add = within(screen.getByRole('dialog')).getByRole('button', { name: /Add Link/ });
    expect(add.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'vendor.example/portal' } });
    expect(screen.queryByTestId('link-problem')).toBeNull();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: ' Vendor Portal ' } });
    expect(screen.getByTestId('link-preview').textContent).toContain('vendor.example');
    await act(async () => { fireEvent.click(add); });
    expect(api.addTaskLink).toHaveBeenCalledWith('t1', { url: 'vendor.example/portal', name: 'Vendor Portal' });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's refusal and stays open", async () => {
    api.addTaskLink = vi.fn(() => Promise.reject(new Error('That link is already on this task as "Spec".')));
    const onClose = vi.fn();
    render(<WebLinkModal taskId="t1" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'https://example.com/spec' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Add Link/ })); });
    expect((await screen.findByRole('alert')).textContent).toContain('already on this task');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edits the address and name of an existing link', async () => {
    api.updateTaskLink = vi.fn(() => Promise.resolve({ ...BARE }));
    render(<WebLinkModal link={BARE} onClose={() => {}} />);
    expect(screen.getByLabelText('Web address').value).toBe(BARE.url);
    expect(screen.getByLabelText('Display name').value).toBe('');
    const save = within(screen.getByRole('dialog')).getByRole('button', { name: /Save Link/ });
    expect(save.disabled).toBe(true);          // nothing changed yet
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Spec' } });
    await act(async () => { fireEvent.click(save); });
    expect(api.updateTaskLink).toHaveBeenCalledWith('l2', { url: BARE.url, name: 'Spec' });
  });
});

describe('links in the task drawer', () => {
  it('Add Link opens the form; a link row is a link, never a file row, and takes no versions', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([LINK, BARE]));
    api.updateTaskLink = vi.fn(() => Promise.resolve(LINK));
    api.deleteTaskAttachment = vi.fn(() => Promise.resolve());
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const rows = await screen.findAllByTestId('web-link');
    expect(rows).toHaveLength(2);
    expect(screen.queryByTestId('attachment-row')).toBeNull();
    expect(screen.queryByLabelText(/Upload new version/)).toBeNull();
    // No project: everybody edits, so both rows offer Edit and Remove.
    expect(screen.getByLabelText('Edit link Vendor Portal')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove Vendor Portal')); });
    expect(api.deleteTaskAttachment).toHaveBeenCalledWith('l1');
    await act(async () => { fireEvent.click(screen.getByText('Add Link')); });
    expect(within(screen.getByRole('dialog')).getByLabelText('Web address')).toBeTruthy();
  });

  it('a commenter edits their own link only; a viewer sees links but cannot add or change them', async () => {
    const t = { ...task, projectId: 'p1', assigneeIds: ['other@x.com'] };
    const project = (role) => [{ id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: role } }];
    api.getTaskAttachments = vi.fn(() => Promise.resolve([LINK, BARE]));
    state = { ...state, tasks: [t], taskById: { t1: t }, projects: project('commenter') };
    const { unmount } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await screen.findAllByTestId('web-link');
    expect(screen.getByText('Add Link')).toBeTruthy();
    expect(screen.getByLabelText('Edit link Vendor Portal')).toBeTruthy();       // mine
    expect(screen.queryByLabelText(`Edit link ${BARE.url}`)).toBeNull();          // someone else's
    expect(screen.queryByLabelText(`Remove ${BARE.url}`)).toBeNull();
    unmount();

    state = { ...state, projects: project('viewer') };
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const rows = await screen.findAllByTestId('web-link');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('a').getAttribute('href')).toBe(LINK.url);
    expect(screen.queryByText('Add Link')).toBeNull();
    expect(screen.queryByLabelText(/Edit link/)).toBeNull();
  });
});

describe('the Files view', () => {
  it('lists a link with its website, opening in a new tab - no download, no viewer', async () => {
    api.getTaskAttachments = vi.fn(() => Promise.resolve([LINK]));
    render(<FilesView tasks={[task]} onOpen={() => {}} nameOf={(e) => e} />);
    const a = await screen.findByTestId('files-web-link');
    expect(a.getAttribute('href')).toBe(LINK.url);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toContain('Vendor Portal');
    expect(screen.getByText(/vendor\.example/)).toBeTruthy();
    expect(screen.queryByTitle('Download')).toBeNull();
  });
});
