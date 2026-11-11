// A comment's thread beside its pin (Neil, 11/10/2026, threads.js): the first
// comment, the replies, Resolve / Reopen and a reply box with @mentions of
// the people who can open the board. With `thread` null it is the box for a
// NEW comment (the pin is placed when it is posted). Pure UI: what a post or
// a resolve does to the board is Board.jsx's.
import { useMemo, useRef, useState } from 'react';
import { X, Check, RotateCcw } from 'lucide-react';
import { formatDateTime } from '../../lib/datetime';
import { mentionAt, mentionsIn, REPLY_MAX } from './threads';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

function Words({ text, people }) {
  // @Full Name of someone on the board reads bold; everything else as typed.
  const names = (people || []).map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return <>{text}</>;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = String(text).split(new RegExp(`(@(?:${esc.join('|')}))`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p))}</>;
}

function Entry({ who, at, text, people }) {
  return (
    <div className="nx-th-entry">
      <div className="nx-th-who"><span>{who || 'Someone'}</span>{at ? <time>{formatDateTime(at)}</time> : null}</div>
      <div className="nx-th-text"><Words text={text} people={people} /></div>
    </div>
  );
}

export default function CommentThread({ number, thread, canEdit, people = [], style, phone = false, onPost, onResolve, onClose }) {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const box = useRef(null);
  const at = mentionAt(draft, caret);
  const matches = useMemo(() => {
    if (!at) return [];
    const q = at.query.toLowerCase();
    return people.filter((p) => p.name && p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q.split(' ')[0])) && p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [at, people]);

  const insert = (p) => {
    const before = draft.slice(0, at.start);
    const after = draft.slice(caret);
    const next = `${before}@${p.name} ${after.replace(/^\S*/, '').trimStart()}`;
    setDraft(next);
    const pos = before.length + p.name.length + 2;
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(pos, pos); setCaret(pos); });
  };
  const post = () => {
    const text = draft.trim();
    if (!text) return;
    onPost?.(text, mentionsIn(text, people));
    setDraft('');
  };
  const onKey = (e) => {
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return; }
    if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insert(matches[Math.min(pick, matches.length - 1)]); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); return; }
    if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
    e.stopPropagation();   // the engine's own shortcuts never fire while typing here
  };
  const isNew = !thread;
  const resolved = !!thread?.resolved;

  return (
    <div className={`nx-th${phone ? ' is-phone' : ''}`} style={style} role="dialog" aria-label={isNew ? 'New Comment' : `Comment ${number}`}
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} data-testid="nx-thread">
      <div className="nx-th-head">
        <span className="nx-th-title">{isNew ? 'New Comment' : `Comment ${number}`}</span>
        {!isNew && canEdit && (
          <button type="button" className="nx-th-btn" onClick={() => onResolve?.(!resolved)} title={resolved ? 'Reopen' : 'Resolve'}>
            {resolved ? <><RotateCcw size={14} aria-hidden /> Reopen</> : <><Check size={14} aria-hidden /> Resolve</>}
          </button>
        )}
        <button type="button" className="nx-th-btn is-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      {!isNew && (
        <div className="nx-th-list">
          <Entry who={thread.name} at={thread.at} text={thread.text} people={people} />
          {thread.replies.map((r) => <Entry key={r.id} who={r.name} at={r.at} text={r.text} people={people} />)}
          {resolved && <div className="nx-th-resolved">Resolved by {thread.resolved.name || 'someone'} {thread.resolved.at ? formatDateTime(thread.resolved.at) : ''}</div>}
        </div>
      )}
      {canEdit && (
        <div className="nx-th-compose">
          <textarea ref={box} autoFocus rows={isNew ? 3 : 2} maxLength={REPLY_MAX} value={draft}
            placeholder={isNew ? 'What should change here? Type @ to mention someone' : 'Reply - type @ to mention someone'}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setPick(0); }}
            onSelect={(e) => setCaret(e.target.selectionStart)} onKeyDown={onKey} aria-label={isNew ? 'Comment' : 'Reply'} />
          {matches.length > 0 && (
            <div className="nx-th-people" role="listbox" aria-label="Mention">
              {matches.map((p, i) => (
                <button key={p.email} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'is-on' : ''}
                  onPointerDown={(e) => e.preventDefault()} onClick={() => insert(p)}>{p.name}</button>
              ))}
            </div>
          )}
          <div className="nx-th-foot">
            <span className="nx-th-hint">{isMac ? 'Cmd' : 'Ctrl'}+Enter to post</span>
            <button type="button" className="nx-th-post" onClick={post} disabled={!draft.trim()}>{isNew ? 'Add Comment' : 'Reply'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
