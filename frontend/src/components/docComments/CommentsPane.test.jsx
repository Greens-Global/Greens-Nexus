// The Review pane lists threads, posts a comment from a draft, replies and
// resolves - against a mocked API, the way the server answers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
let rows = [];
vi.mock('../../api', () => ({
  api: {
    getDocComments: async () => rows,
    addDocComment: async (kind, id, data) => {
      calls.push(['add', data]);
      const c = { id: `c${rows.length + 1}`, docKind: kind, docId: id, parentId: data.parentId || '', author: 'me@x.test',
        authorName: 'Me', body: data.body, quote: data.quote || '', resolvedAt: '', createdAt: '2026-11-05T10:00:00+00:00' };
      rows = [...rows, c];
      return c;
    },
    updateDocComment: async (kind, id, cid, data) => {
      calls.push(['update', cid, data]);
      rows = rows.map((r) => (r.id === cid ? { ...r, ...(data.body ? { body: data.body } : {}), ...(data.resolved !== undefined ? { resolvedAt: data.resolved ? '2026-11-05T11:00:00+00:00' : '' } : {}) } : r));
      return rows.find((r) => r.id === cid);
    },
    deleteDocComment: async (kind, id, cid) => { calls.push(['delete', cid]); rows = rows.filter((r) => r.id !== cid && r.parentId !== cid); return { ok: true }; },
  },
}));

const { default: CommentsPane } = await import('./CommentsPane');
const { useDocComments } = await import('./useDocComments');

function Harness(props) {
  const store = useDocComments('document', 'd1');
  return <CommentsPane store={store} me="me@x.test" isAdmin={false} ownerEmail="owner@x.test" {...props} />;
}

beforeEach(() => {
  calls.length = 0;
  rows = [
    { id: 'r1', parentId: '', author: 'owner@x.test', authorName: 'Owner', body: 'Net 30?', quote: 'net 45', resolvedAt: '', createdAt: '2026-11-05T09:00:00+00:00' },
    { id: 'r1a', parentId: 'r1', author: 'me@x.test', authorName: 'Me', body: 'Yes', quote: '', resolvedAt: '', createdAt: '2026-11-05T09:05:00+00:00' },
  ];
});

describe('CommentsPane', () => {
  it('lists the thread with its quote and reply, and counts open threads', async () => {
    render(<Harness />);
    await screen.findByText('Net 30?');
    expect(screen.getByText('"net 45"')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
    expect(screen.getByLabelText('Comments').textContent).toContain('1');
  });

  it('posts a draft with its quote and hands the new comment back to the editor', async () => {
    const onDraftSaved = vi.fn();
    render(<Harness draft={{ quote: 'late fee', from: 3, to: 11 }} onDraftSaved={onDraftSaved} />);
    await screen.findByText('Net 30?');
    fireEvent.change(screen.getByPlaceholderText('Write a comment…'), { target: { value: 'Too steep' } });
    fireEvent.click(screen.getByText('Post'));
    await waitFor(() => expect(onDraftSaved).toHaveBeenCalled());
    expect(calls[0]).toEqual(['add', { body: 'Too steep', quote: 'late fee' }]);
    expect(onDraftSaved.mock.calls[0][0].id).toBe('c3');
    expect(onDraftSaved.mock.calls[0][1]).toEqual({ quote: 'late fee', from: 3, to: 11 });
  });

  it('replies, and a thread that is not mine has no Resolve', async () => {
    render(<Harness />);
    await screen.findByText('Net 30?');
    fireEvent.click(screen.getByText('Reply'));
    fireEvent.change(screen.getByPlaceholderText('Reply…'), { target: { value: 'Agreed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await screen.findByText('Agreed');
    expect(calls.at(-1)).toEqual(['add', { body: 'Agreed', parentId: 'r1' }]);
    expect(screen.queryByText('Resolve')).toBeNull();
  });

  it('lets the owner resolve, then shows it under Resolved', async () => {
    render(<Harness me="owner@x.test" />);
    await screen.findByText('Net 30?');
    fireEvent.click(screen.getByText('Resolve'));
    await waitFor(() => expect(calls.at(-1)).toEqual(['update', 'r1', { resolved: true }]));
    await waitFor(() => expect(screen.queryByText('Net 30?')).toBeNull());   // Open filter hides it
    fireEvent.click(screen.getByText('Resolved'));
    await screen.findByText('Net 30?');
    expect(screen.getByText('Reopen')).toBeTruthy();
  });
});
