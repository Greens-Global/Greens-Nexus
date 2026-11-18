import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Comment threads (Oct 2026): grouping, reactions, the reply composer, and
// the assigned / resolved states.

vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]), getPersonPhotos: () => Promise.resolve({}) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
// The rich editor is TipTap; a textarea stands in so the reply composer can be driven.
vi.mock('./RichDescription', () => ({
  default: ({ value, onChange }) => <textarea aria-label="rich" value={value} onChange={(e) => onChange(e.target.value)} />,
  isEmptyDoc: (v) => !String(v || '').trim(),
}));

const { threadComments } = await import('./lib');
const CommentThread = (await import('./CommentThread')).default;
const { CommentReactions } = await import('./CommentThread');

const me = 'me@greensglobal.com';
const nameOf = (e) => ({ [me]: 'Me Myself', 'ann@greensglobal.com': 'Ann Author', 'bob@greensglobal.com': 'Bob' }[e] || e);

describe('threadComments', () => {
  it('groups replies under their root and keeps order', () => {
    const rows = [
      { id: 'a', createdAt: '1' }, { id: 'a1', parentId: 'a', createdAt: '2' },
      { id: 'b', createdAt: '3' }, { id: 'a2', parentId: 'a', createdAt: '4' },
      { id: 'orphan', parentId: 'gone', createdAt: '5' },
    ];
    const t = threadComments(rows);
    expect(t.map((x) => x.root.id)).toEqual(['a', 'b', 'orphan']);
    expect(t[0].replies.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(t[1].replies).toEqual([]);
  });
});

describe('CommentReactions', () => {
  it('shows counts, marks mine, and toggles', () => {
    const onToggle = vi.fn();
    render(<CommentReactions reactions={{ '👍': ['bob@greensglobal.com', me], '🎉': ['bob@greensglobal.com'] }} myEmail={me} nameOf={nameOf} onToggle={onToggle} />);
    const thumbs = screen.getByLabelText('👍 2');
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('🎉 1')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(thumbs);
    expect(onToggle).toHaveBeenCalledWith('👍');
    fireEvent.click(screen.getByLabelText('Add Reaction'));
    fireEvent.click(screen.getByLabelText('React 🔥'));
    expect(onToggle).toHaveBeenCalledWith('🔥');
  });
});

describe('CommentThread', () => {
  const root = { id: 'r', authorId: 'ann@greensglobal.com', body: '<p>Which pump?</p>', createdAt: '2026-10-01T10:00:00Z', reactions: {} };
  const reply = { id: 'r1', parentId: 'r', authorId: 'bob@greensglobal.com', body: '<p>East</p>', createdAt: '2026-10-01T11:00:00Z', reactions: {} };
  const base = { nameOf, myEmail: me, attachments: new Map(), onPin: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onReact: vi.fn(), onResolve: vi.fn(), onAssign: vi.fn() };

  it('renders the root and its replies and posts a reply through the composer', async () => {
    const onReply = vi.fn(() => Promise.resolve());
    render(<CommentThread thread={{ root, replies: [reply] }} {...base} onReply={onReply} />);
    expect(screen.getByText('Which pump?')).toBeInTheDocument();
    expect(screen.getByText('East')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Reply$/ })[0]);   // the hover action; the composer's own Reply comes after
    const box = screen.getByLabelText('rich');
    fireEvent.change(box, { target: { value: '<p>Thanks</p>' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Reply$/ }).pop());
    await screen.findByText('Which pump?');
    expect(onReply).toHaveBeenCalledWith(root, '<p>Thanks</p>');
  });

  it('shows an assigned comment as an action item and offers Resolve', () => {
    const assigned = { ...root, assigneeId: me };
    render(<CommentThread thread={{ root: assigned, replies: [] }} {...base} />);
    expect(screen.getByText('Assigned to you')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Resolve'));
    expect(base.onResolve).toHaveBeenCalledWith(assigned, true);
  });

  it('folds a resolved thread to one line and reopens on click', () => {
    const done = { ...root, assigneeId: me, resolvedAt: '2026-10-02T10:00:00Z', resolvedBy: me };
    render(<CommentThread thread={{ root: done, replies: [reply] }} {...base} />);
    const line = screen.getByLabelText('Show resolved comment');
    expect(line).toHaveTextContent('Resolved by Me Myself');
    expect(line).toHaveTextContent('1 reply');
    fireEvent.click(line);
    expect(screen.getByText('Which pump?')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reopen'));
    expect(base.onResolve).toHaveBeenCalledWith(done, false);
  });
});

// A reply or an edit that fails (11/17/2026): the box stays open with the
// words in it and says so - it used to clear the draft and close.
describe('CommentThread when a reply or an edit fails', () => {
  const root = { id: 'rf', authorId: me, body: '<p>Which pump?</p>', createdAt: '2026-10-01T10:00:00Z', reactions: {} };
  const base = { nameOf, myEmail: me, attachments: new Map(), onPin: vi.fn(), onDelete: vi.fn(), onReact: vi.fn(), onResolve: vi.fn(), onAssign: vi.fn() };

  it('keeps a reply that did not post in the box, with the reason', async () => {
    const onReply = vi.fn(() => Promise.reject(new Error("Can't reach Nexus right now.")));
    render(<CommentThread taskId="t-fail-reply" thread={{ root, replies: [] }} {...base} onEdit={vi.fn()} onReply={onReply} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reply$/ }));
    fireEvent.change(screen.getByLabelText('rich'), { target: { value: '<p>East pump</p>' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Reply$/ }).pop());
    expect(await screen.findByRole('alert')).toHaveTextContent("Your reply did not post. Can't reach Nexus right now.");
    expect(screen.getByTestId('reply-composer')).toBeInTheDocument();
    expect(screen.getByLabelText('rich').value).toBe('<p>East pump</p>');
    // The button is back, so it can be sent again.
    expect(screen.getAllByRole('button', { name: /^Reply$/ }).pop()).not.toBeDisabled();
  });

  it('keeps an edit that was not saved open, and closes it once it saves', async () => {
    const onEdit = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('You can only edit your own comments.')))
      .mockImplementationOnce(() => Promise.resolve());
    render(<CommentThread taskId="t-fail-edit" thread={{ root, replies: [] }} {...base} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText('Edit'));
    fireEvent.change(screen.getByLabelText('rich'), { target: { value: '<p>The east pump</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your edit was not saved. You can only edit your own comments.');
    expect(screen.getByLabelText('rich').value).toBe('<p>The east pump</p>');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('rich')).toBeNull());
    expect(onEdit).toHaveBeenLastCalledWith(root, '<p>The east pump</p>');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('CommentThread resolved state', () => {
  const nameOf2 = (e) => ({ 'ann@greensglobal.com': 'Ann Author' }[e] || e);
  const base = { nameOf: nameOf2, myEmail: 'me@greensglobal.com', attachments: new Map(), onPin: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onReact: vi.fn(), onResolve: vi.fn(), onAssign: vi.fn(), onReply: vi.fn() };
  const open = { id: 'r', authorId: 'ann@greensglobal.com', body: '<p>Tom &amp; Jerry?</p>', createdAt: '2026-10-01T10:00:00Z', reactions: {} };

  it('folds when the thread becomes resolved without a remount, and decodes entities on the folded line', () => {
    const { rerender } = render(<CommentThread thread={{ root: open, replies: [] }} {...base} />);
    expect(screen.getByText('Tom & Jerry?')).toBeInTheDocument();
    rerender(<CommentThread thread={{ root: { ...open, resolvedAt: '2026-10-02T10:00:00Z', resolvedBy: 'ann@greensglobal.com' }, replies: [] }} {...base} />);
    const line = screen.getByLabelText('Show resolved comment');
    expect(line.textContent).toContain('Tom & Jerry?');
    expect(line.textContent).not.toContain('&amp;');
    fireEvent.click(line);
    expect(screen.queryByLabelText('Show resolved comment')).toBeNull();
    // Reopened and resolved again later: folds again.
    rerender(<CommentThread thread={{ root: { ...open, resolvedAt: '2026-10-03T10:00:00Z', resolvedBy: 'ann@greensglobal.com' }, replies: [] }} {...base} />);
    expect(screen.getByLabelText('Show resolved comment')).toBeInTheDocument();
  });
});
