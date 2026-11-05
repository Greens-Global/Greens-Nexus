// The comment threads of one document or template, kept in step with the
// server (routers/doc_comments.py) - the Review pane reads this, the editor
// only ever anchors ids. Every change goes to the server first and the list
// re-reads, so two people commenting on the same page never diverge.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';

export function useDocComments(kind, docId) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!docId) return;
    try {
      const rows = await api.getDocComments(kind, docId);
      setComments(Array.isArray(rows) ? rows : []);
      setError('');
    } catch (e) {
      setError(e?.message || 'Could not load the comments.');
    } finally {
      setLoading(false);
    }
  }, [kind, docId]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh]);

  const act = useCallback(async (fn) => {
    const out = await fn();
    await refresh();
    return out;
  }, [refresh]);

  return {
    comments, loading, error, refresh,
    add: (body, quote) => act(() => api.addDocComment(kind, docId, { body, quote: quote || '' })),
    reply: (parentId, body) => act(() => api.addDocComment(kind, docId, { body, parentId })),
    edit: (id, body) => act(() => api.updateDocComment(kind, docId, id, { body })),
    resolve: (id, resolved) => act(() => api.updateDocComment(kind, docId, id, { resolved })),
    remove: (id) => act(() => api.deleteDocComment(kind, docId, id)),
  };
}

/** Threads: each root with its replies, open ones first, newest root last. */
export function threadsOf(comments) {
  const roots = comments.filter((c) => !c.parentId);
  const replies = comments.filter((c) => c.parentId);
  const open = roots.filter((r) => !r.resolvedAt);
  const done = roots.filter((r) => r.resolvedAt);
  return [...open, ...done].map((root) => ({ root, replies: replies.filter((r) => r.parentId === root.id) }));
}
