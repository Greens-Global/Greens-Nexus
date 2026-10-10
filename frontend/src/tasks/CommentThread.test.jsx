import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
    fireEvent.click(screen.getByLabelText('Add reaction'));
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
