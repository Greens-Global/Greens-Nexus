// The Review pane of the Documents editor (Nov 2026): every comment thread
// on the page, like Word's Comments pane. A thread is the root (with the
// quote of the text it was made on), its replies, Resolve / Reopen; the
// author edits; the author or an administrator deletes - a thread is gone
// for good, so that is a hold (HoldButton, one record).
//
// The editor owns the anchors: clicking a thread asks it to scroll to the
// mark (`onSelect`), a new comment starts from the editor's selection
// (`draft` = { quote, from, to }) and the editor marks the text once the
// comment exists (`onDraftSaved`).
import { useState } from 'react';
import { MessageSquare, Check, RotateCcw, Reply, Pencil, X } from 'lucide-react';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDateTime } from '../../lib/datetime';
import { threadsOf } from './useDocComments';

const FILTERS = [['open', 'Open'], ['all', 'All'], ['mine', 'Mine'], ['resolved', 'Resolved']];

function Composer({ placeholder, initial = '', onSave, onCancel, saveLabel = 'Post' }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr('');
    try { await onSave(text.trim()); setText(''); }
    catch (e) { setErr(e?.message || 'That did not go through.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="doc-comment-composer">
      <textarea className="form-input" rows={3} value={text} placeholder={placeholder} autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') onCancel?.(); }} />
      {err && <div className="doc-comment-err">{err}</div>}
      <div className="doc-comment-actions">
        <button type="button" className="primary-btn" disabled={!text.trim() || busy} onClick={save}>{saveLabel}</button>
        {onCancel && <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>}
        <span className="doc-comment-hint">Ctrl+Enter to post</span>
      </div>
    </div>
  );
}

function Comment({ c, me, isAdmin, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const mine = c.author === me;
  return (
    <div className="doc-comment">
      <div className="doc-comment-head">
        <span className="doc-comment-author">{c.authorName || c.author}</span>
        <span className="doc-comment-when">{formatDateTime(c.createdAt, '')}{c.updatedAt && c.updatedAt !== c.createdAt ? ' (edited)' : ''}</span>
      </div>
      {editing ? (
        <Composer initial={c.body} saveLabel="Save" onCancel={() => setEditing(false)}
          onSave={async (t) => { await onEdit(c.id, t); setEditing(false); }} />
      ) : (
        <div className="doc-comment-body">{c.body}</div>
      )}
      {!editing && (mine || isAdmin) && (
        <div className="doc-comment-tools">
          {mine && <button type="button" onClick={() => setEditing(true)} title="Edit"><Pencil size={12} /> Edit</button>}
          <HoldButton label="Delete" doneLabel="Deleted" size="sm" holdMs={HOLD_RECORD_MS} onConfirm={() => onDelete(c.id)} />
        </div>
      )}
    </div>
  );
}

function Thread({ thread, me, isAdmin, ownerEmail, active, onSelect, actions }) {
  const { root, replies } = thread;
  const [replying, setReplying] = useState(false);
  const mayResolve = isAdmin || root.author === me || ownerEmail === me;
  const resolved = !!root.resolvedAt;
  return (
    <div className={`doc-thread${resolved ? ' is-resolved' : ''}${active ? ' is-active' : ''}`}
      onClick={() => onSelect?.(root.id)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(root.id); }}>
      {root.quote && <div className="doc-thread-quote" title="The text this comment was made on">"{root.quote}"</div>}
      <Comment c={root} me={me} isAdmin={isAdmin} onEdit={actions.edit} onDelete={actions.remove} />
      {replies.map((r) => <Comment key={r.id} c={r} me={me} isAdmin={isAdmin} onEdit={actions.edit} onDelete={actions.remove} />)}
      {replying ? (
        <Composer placeholder="Reply…" saveLabel="Reply" onCancel={() => setReplying(false)}
          onSave={async (t) => { await actions.reply(root.id, t); setReplying(false); }} />
      ) : (
        <div className="doc-thread-foot" onClick={(e) => e.stopPropagation()}>
          {!resolved && <button type="button" onClick={() => setReplying(true)}><Reply size={12} /> Reply</button>}
          {mayResolve && (resolved
            ? <button type="button" onClick={() => actions.resolve(root.id, false)}><RotateCcw size={12} /> Reopen</button>
            : <button type="button" onClick={() => actions.resolve(root.id, true)}><Check size={12} /> Resolve</button>)}
          {resolved && <span className="doc-thread-resolved">Resolved {formatDateTime(root.resolvedAt, '')}</span>}
        </div>
      )}
    </div>
  );
}

export default function CommentsPane({ store, me, isAdmin, ownerEmail, activeId, onSelect, draft, onDraftSaved, onDraftCancel, onClose }) {
  const [filter, setFilter] = useState('open');
  const threads = threadsOf(store.comments).filter(({ root }) => (
    filter === 'all' || (filter === 'open' && !root.resolvedAt) || (filter === 'resolved' && !!root.resolvedAt)
    || (filter === 'mine' && root.author === me)));
  const openCount = store.comments.filter((c) => !c.parentId && !c.resolvedAt).length;
  return (
    <aside className="doc-comments-pane" aria-label="Comments">
      <div className="doc-comments-head">
        <MessageSquare size={14} /> Comments
        <span className="doc-comments-count">{openCount}</span>
        <span style={{ flex: 1 }} />
        {onClose && <button type="button" className="doc-comments-close" onClick={onClose} title="Close"><X size={14} /></button>}
      </div>
      <div className="doc-comments-filters">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" className={filter === key ? 'is-active' : ''} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      {draft && (
        <div className="doc-thread is-new">
          {draft.quote && <div className="doc-thread-quote">"{draft.quote}"</div>}
          <Composer placeholder="Write a comment…" onCancel={onDraftCancel}
            onSave={async (t) => { const c = await store.add(t, draft.quote); onDraftSaved?.(c, draft); }} />
        </div>
      )}
      {store.error && <div className="doc-comment-err">{store.error}</div>}
      {store.loading ? (
        <p className="doc-comments-empty">Loading comments…</p>
      ) : threads.length === 0 && !draft ? (
        <p className="doc-comments-empty">
          {filter === 'open' ? 'No open comments. Select some text and click New Comment to start one.' : 'Nothing here.'}
        </p>
      ) : threads.map((t) => (
        <Thread key={t.root.id} thread={t} me={me} isAdmin={isAdmin} ownerEmail={ownerEmail}
          active={t.root.id === activeId} onSelect={onSelect} actions={store} />
      ))}
    </aside>
  );
}
