import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// The unified Audit Log (Settings > Logs): filters are dropdowns, an Act As
// entry shows its badge and the pushed comment, the detail drawer opens with
// the before -> after, Record History renders, and the screen falls back to
// the old GET /audit-logs list while /audit/events is not deployed.

const COMMENT_EVENT = {
  id: 'ev-1', at: '2026-10-20T15:14:00Z', module: 'tasks', moduleLabel: 'Tasks', action: 'comment',
  title: 'Commented on task "Q3 Close"', summary: '',
  actor: { email: 'visesh.lodha@example.com', name: 'Visesh Lodha' },
  actingAs: { email: 'amy.smith@example.com', name: 'Amy Smith' },
  target: { type: 'task', id: 't-9', label: 'Q3 Close', link: { view: 'tasks', sub: null, params: { taskId: 't-9' } } },
  changesCount: 1, ip: '10.0.0.1', source: 'web', undone: false,
  preview: [{ field: 'comment', label: 'Comment', before: null, after: '<p>Please send the reconciliation by Friday.</p>', kind: 'html' }],
};
const UPDATE_EVENT = {
  id: 'ev-2', at: '2026-10-20T14:00:00Z', module: 'tasks', moduleLabel: 'Tasks', action: 'update',
  title: 'Updated task "Q3 Close"', summary: '', actor: { email: 'neil@example.com', name: 'Neil Kadakia' }, actingAs: null,
  target: { type: 'task', id: 't-9', label: 'Q3 Close', link: { view: 'tasks' } }, changesCount: 4, ip: '', source: 'web', undone: false,
  preview: [{ field: 'status', label: 'Status', before: 'In Progress', after: 'Done', kind: 'text' }],
};

const api = vi.hoisted(() => ({
  auditEvents: vi.fn(), auditEvent: vi.fn(), auditRecordHistory: vi.fn(), auditFacets: vi.fn(), auditExport: vi.fn(),
  getAuditLogs: vi.fn(), getPeopleDirectory: vi.fn(() => Promise.resolve([])), getRolesDirectory: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../api', () => ({ api, saveBlob: vi.fn() }));

const AuditLog = (await import('./AuditLog')).default;
const { diffWords, filtersFromSearch, searchFromFilters } = await import('./auditModel');

beforeEach(() => {
  window.history.replaceState(null, '', '/admin-console/audit');
  api.auditEvents.mockResolvedValue({ events: [COMMENT_EVENT, UPDATE_EVENT], nextCursor: null });
  api.auditFacets.mockResolvedValue({
    modules: [{ key: 'tasks', label: 'Tasks', count: 12 }, { key: 'hr', label: 'HR', count: 3 }],
    actors: [{ email: 'neil@example.com', name: 'Neil Kadakia', count: 9 }],
    actions: [{ key: 'comment', count: 4 }],
  });
  api.auditEvent.mockImplementation((id) => Promise.resolve(id === 'ev-1' ? {
    ...COMMENT_EVENT,
    changes: [COMMENT_EVENT.preview[0], { field: 'status', label: 'Status', before: 'In Progress', after: 'Done', kind: 'text' }],
    request: { path: '/tasks/t-9/comments', method: 'POST', status: 201 },
    related: [UPDATE_EVENT],
  } : { ...UPDATE_EVENT, changes: UPDATE_EVENT.preview, related: [] }));
  api.auditRecordHistory.mockResolvedValue({ events: [
    { ...UPDATE_EVENT, id: 'h-1', title: 'Created task "Q3 Close"', action: 'create', changes: [{ field: 'status', label: 'Status', before: null, after: 'In Progress', kind: 'text' }] },
    { ...UPDATE_EVENT, id: 'h-2', changes: UPDATE_EVENT.preview },
  ] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); api.getPeopleDirectory.mockResolvedValue([]); api.getRolesDirectory.mockResolvedValue([]); });

describe('AuditLog', () => {
  it('renders the filters as dropdowns with facet counts', async () => {
    render(<AuditLog />);
    for (const name of ['Module', 'Acting As', 'Action', 'Date Range']) {
      expect(screen.getByRole('combobox', { name }).tagName).toBe('SELECT');
    }
    expect(await screen.findByRole('option', { name: 'Tasks (12)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Only Act As Actions' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Show System Activity/ })).not.toBeChecked();
    expect(await screen.findByText('15 events in the last 7 days')).toBeInTheDocument();
  });

  it('shows an Act As entry with its badge and the comment it pushed', async () => {
    render(<AuditLog />);
    expect(await screen.findByText('Acting as Amy Smith')).toBeInTheDocument();
    expect(screen.getByText('Please send the reconciliation by Friday.')).toBeInTheDocument();
    expect(screen.getByText('Commented on task "Q3 Close"')).toBeInTheDocument();
    expect(screen.getByText('+3 more')).toBeInTheDocument();
    // Day header in US format.
    expect(screen.getByRole('region', { name: /, 10\/20\/2026$/ })).toBeInTheDocument();
  });

  it('opens the detail drawer with the Act As note and the before/after', async () => {
    render(<AuditLog />);
    fireEvent.click(await screen.findByRole('button', { name: /Visesh Lodha: Commented/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Audit Event' });
    await waitFor(() => expect(api.auditEvent).toHaveBeenCalledWith('ev-1'));
    expect(within(dialog).getByRole('note')).toHaveTextContent('made this change while acting as Amy Smith');
    expect(await within(dialog).findByTestId('added-text')).toHaveTextContent('Please send the reconciliation by Friday.');
    expect(within(dialog).getByText('What Changed (2)')).toBeInTheDocument();
    expect(within(dialog).getByText('POST /tasks/t-9/comments (201)')).toBeInTheDocument();
    expect(within(dialog).getByText('Same Request')).toBeInTheDocument();
    expect(window.location.search).toContain('event=ev-1');
  });

  it('shows the record history oldest first', async () => {
    render(<AuditLog />);
    fireEvent.click(await screen.findByRole('button', { name: /Neil Kadakia: Updated/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Record History/ }));
    const list = await within(dialog).findByRole('list', { name: 'Record History' });
    expect(api.auditRecordHistory).toHaveBeenCalledWith('task', 't-9');
    const steps = within(list).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent('Created task "Q3 Close"');
    expect(steps[1]).toHaveTextContent('In Progress');
    expect(steps[1]).toHaveTextContent('Done');
  });

  it('reads its filters from the address bar', async () => {
    window.history.replaceState(null, '', '/admin-console/audit?module=tasks&action=comment');
    render(<AuditLog />);
    await waitFor(() => expect(api.auditEvents).toHaveBeenCalled());
    expect(api.auditEvents.mock.calls[0][0]).toMatchObject({ module: 'tasks', action: 'comment', include_system: 'false' });
    expect(screen.getByRole('button', { name: 'Clear Filters' })).toBeInTheDocument();
  });

  it('falls back to /audit-logs when /audit/events is not deployed', async () => {
    api.auditEvents.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    api.auditFacets.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    api.getAuditLogs.mockResolvedValue({ total: 1, rows: [{
      id: 7, timestamp: '2026-10-20T12:00:00', user_email: 'neil@example.com', user_name: 'Neil Kadakia',
      action: 'Approved a requisition', resource_type: 'requisition', resource_id: 'r-1',
      details: JSON.stringify({ acting_as: 'amy.smith@example.com', reason: 'ok' }), ip_address: '1.2.3.4',
    }] });
    render(<AuditLog />);
    expect(await screen.findByText('Approved a requisition')).toBeInTheDocument();
    expect(api.getAuditLogs).toHaveBeenCalled();
    expect(screen.getByText(/Showing the older log/)).toBeInTheDocument();
    expect(screen.getByText(/Acting as/)).toBeInTheDocument();
    expect(screen.getByText('1 event in the log')).toBeInTheDocument();
  });
});

describe('auditModel', () => {
  it('diffs words', () => {
    expect(diffWords('Status is open', 'Status is closed')).toEqual([
      { type: 'same', text: 'Status is ' }, { type: 'del', text: 'open' }, { type: 'add', text: 'closed' },
    ]);
  });
  it('round-trips filters through the address bar', () => {
    const f = filtersFromSearch('?module=hr&as=any&q=pay&system=1');
    expect(f).toMatchObject({ module: 'hr', as: 'any', q: 'pay', system: true, range: '7d' });
    expect(searchFromFilters(f, 'ev-3')).toBe('?module=hr&as=any&q=pay&system=1&event=ev-3');
  });
});
