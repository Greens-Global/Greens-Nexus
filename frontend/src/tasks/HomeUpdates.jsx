// The Updates card on the Tasks Home (Neil, Oct 14 2026; reworked Oct 15:
// "a bit spammy - it should think about what is relevant").
//
// GET /tasks/activity/mine hands back UPDATES, not raw activity rows: the
// mailer, scheduler, Asana sync and automation rules are gone, one person's
// burst of edits on one task is folded into one update whose `parts` say
// everything that happened, and what is aimed at me (assigned me, mentioned
// me, gave me a comment to act on) is flagged `forYou`. This card turns the
// parts into one sentence, sorts the updates under Today / Yesterday /
// Earlier, and lets the person narrow the list to For You.
//
// Oct 21 2026 (Neil: "make it great"): For You is a short list of what is
// still waiting on me - an ask drops to Answered once I reply, resolve,
// approve or start - plus "you're unblocked"; several people's updates to one
// task on one day fold into one row; a due date pushed later reads as a slip;
// what arrived since I last looked carries a New dot (the stamp is kept on
// the server, POST /tasks/activity/mine/seen, so phone and desktop agree).
// A row opens its task AT the comment it is about, and the common answers
// happen on the row: Reply in the thread, a thumbs up, Resolve a comment
// handed to me, Approve / Decline an extension, Accept / Keep a proposed date.
// Days older than yesterday read as their date; Load More reads further back.
import { useMemo, useState } from 'react';
import { Activity, Check, CornerDownRight, ThumbsUp } from 'lucide-react';
import { Avatar } from './components';
import { NX, FONT, btn, card, input } from './theme';
import { api } from '../api';
import { StatusLabel } from '../components/StatusLabel';
import { ago, updatePhrases, foldByTask, needsMe, isAnswered, actorsLabel } from './updatesText';
import { formatDate, formatDateTime } from '../lib/datetime';

// Rows shown before "Show All" where the card is not filling a column.
const UPDATES_SHOWN = 8;

const joinPhrases = (phrases) => phrases.flatMap((p, i) => {
  const sep = i === 0 ? '' : i === phrases.length - 1 ? ' and ' : ', ';
  return [sep, p];
});

// Today / Yesterday / the date, by the LOCAL calendar date.
const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (localDay(d) === localDay(today)) return 'Today';
  if (localDay(d) === localDay(yesterday)) return 'Yesterday';
  return formatDate(d);
}

// Plain text from the row's reply box as the comment body the thread stores.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const replyBody = (text) => `<p>${esc(text.trim()).replace(/\n/g, '<br>')}</p>`;

const small = { ...btn('ghost'), padding: '5px 8px', fontSize: 12.5, gap: 5 };

/** The answers a row offers. Each one writes, then asks the card to re-read
 *  (the server decides what is answered); a refusal says so on the row. */
function RowActions({ u, done, onChanged }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [liked, setLiked] = useState(!!u.comment?.liked);
  const kinds = new Set((u.parts || []).map((p) => p.kind));
  const dateAsk = u.ask === 'open' && (kinds.has('extension_ask') || kinds.has('date_ask'));
  const c = u.comment;
  if (!dateAsk && !c) return null;

  const run = async (fn, after) => {
    setBusy(true); setError('');
    try { await fn(); after?.(); onChanged?.(); } catch { setError('That did not save. Try again, or open the task.'); }
    finally { setBusy(false); }
  };
  const send = () => { if (text.trim()) run(() => api.addTaskComment(u.taskId, { body: replyBody(text), parent_id: c.threadId }), () => { setText(''); setReplying(false); }); };
  const stop = (e) => e.stopPropagation();

  return (
    <div onClick={stop} onKeyDown={stop} style={{ paddingLeft: 40, marginTop: -4, paddingBottom: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
        {dateAsk && kinds.has('extension_ask') && <>
          <button disabled={busy} onClick={() => run(() => api.respondTaskDue(u.taskId, true))} style={{ ...small, color: NX.green }}><Check size={13} />Approve</button>
          <button disabled={busy} onClick={() => run(() => api.respondTaskDue(u.taskId, false))} style={small}>Decline</button>
        </>}
        {dateAsk && kinds.has('date_ask') && <>
          <button disabled={busy} onClick={() => run(() => api.respondTaskDue(u.taskId, true))} style={{ ...small, color: NX.green }}><Check size={13} />Accept Date</button>
          <button disabled={busy} onClick={() => run(() => api.respondTaskDue(u.taskId, false))} style={small}>Keep Current Date</button>
        </>}
        {c && !replying && <button disabled={busy} onClick={() => setReplying(true)} style={small}><CornerDownRight size={13} />Reply</button>}
        {c && <button disabled={busy} aria-pressed={liked} title={liked ? 'Remove Thumbs Up' : 'Thumbs Up'}
          onClick={() => run(() => api.reactTaskComment(c.id, '👍'), () => setLiked((v) => !v))}
          style={{ ...small, color: liked ? NX.blue : NX.dim }}><ThumbsUp size={13} fill={liked ? 'currentColor' : 'none'} />{liked ? 'Liked' : 'Like'}</button>}
        {c?.canResolve && !done && <button disabled={busy} onClick={() => run(() => api.editTaskComment(c.id, { resolved: true }))} style={{ ...small, color: NX.green }}><Check size={13} />Resolve</button>}
      </div>
      {replying && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Reply"
            placeholder="Write a reply. Enter sends, Shift+Enter adds a line."
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') setReplying(false); }}
            style={{ ...input, resize: 'vertical', fontFamily: FONT, fontSize: 13 }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setReplying(false); setText(''); }} style={small}>Cancel</button>
            <button disabled={busy || !text.trim()} onClick={send} style={{ ...btn('primary'), padding: '6px 12px', fontSize: 12.5, opacity: text.trim() ? 1 : 0.5 }}>Send</button>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 12, color: NX.red, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

const tabStyle = (on) => ({
  border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 0 6px', fontFamily: FONT,
  fontSize: 13, fontWeight: 600, color: on ? NX.blue : NX.dim,
  borderBottom: `2px solid ${on ? NX.blue : 'transparent'}`,
});

/**
 * @param updates  the feed, or null before the first read
 * @param failed   the read failed (with nothing read before it)
 * @param fill     the card fills a column the layout sized (the desktop core
 *                 row): the list scrolls inside it, no Show All
 * @param seenAt   when I last looked at the card before this visit ('' =
 *                 never, null = not known yet): newer updates are New
 * @param projectOf  a task id's project name ('' = none)
 * @param onChanged  a row's answer was saved: read the feed again
 * @param onLoadMore read further back (absent = nothing more to read)
 */
export default function UpdatesCard({ updates, failed, nameOf, statusMeta, taskById, onOpen, fill = false, isMobile = false, seenAt = null,
  projectOf = () => '', onChanged, onLoadMore }) {
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => updates || [], [updates]);
  const folded = useMemo(() => foldByTask(rows, dayLabel), [rows]);
  const waiting = rows.filter(needsMe);
  const answered = rows.filter((u) => u.forYou && isAnswered(u));
  // All: by day. For You: what still waits on me, then what I have answered.
  const list = filter === 'you' ? [...waiting, ...answered] : folded;
  const shown = fill || expanded ? list : list.slice(0, UPDATES_SHOWN);
  const sections = [];
  for (const u of shown) {
    const label = filter === 'you' ? (isAnswered(u) ? 'Answered' : 'Waiting on You') : dayLabel(u.at);
    if (!sections.length || sections[sections.length - 1].label !== label) sections.push({ label, rows: [] });
    sections[sections.length - 1].rows.push(u);
  }
  const seen = seenAt ? new Date(seenAt).getTime() : NaN;
  const isNew = (u) => Number.isFinite(seen) && new Date(u.at).getTime() > seen;
  const newCount = rows.filter(isNew).length;

  // At the comment the update is about, when there is one.
  const open = (u) => { if (u.taskId && taskById.has(u.taskId)) onOpen(u.taskId, u.comment ? { ...u.comment, taskId: u.taskId } : null); };
  const note = (text) => <p style={{ padding: '18px 0', margin: 0, textAlign: 'center', fontSize: 13, color: NX.faint }}>{text}</p>;

  let body;
  if (updates === null && failed) body = note('Updates could not be loaded. They will be tried again when something changes.');
  else if (updates === null) {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="skel" style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0 }} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="skel" style={{ width: `${70 - i * 10}%`, height: 12 }} />
              <span className="skel" style={{ width: `${48 - i * 6}%`, height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    );
  } else if (rows.length === 0) body = note('Nothing new on your tasks in the last 14 days.');
  else if (list.length === 0) body = note('Nothing waiting on you. Assignments, mentions, comments and date requests for you will show here.');
  else {
    body = (
      <div style={fill ? { flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -8px', padding: '0 8px' } : undefined}>
        {sections.map((s) => (
          <section key={s.label} aria-label={s.label}>
            <div style={{ fontSize: 12, fontWeight: 600, color: NX.faint, padding: '12px 0 4px' }}>{s.label}</div>
            {s.rows.map((u, i) => {
              const t = taskById.get(u.taskId);
              const title = t?.title || u.entityTitle || u.entityCode || 'A task';
              const who = u.actors ? actorsLabel(u.actors, nameOf) : (nameOf(u.actorId) || u.actorId || 'Someone');
              const phrases = updatePhrases(u, statusMeta);
              const sentence = phrases.map((p) => p.text);
              const done = isAnswered(u);
              const fresh = isNew(u);
              const project = projectOf(u.taskId);
              return (
                <div key={u.id} style={{
                  borderTop: i === 0 ? 'none' : `1px solid ${NX.border2}`, margin: '0 -8px', padding: '0 8px',
                  // Still waiting on me: a thin rule down the left edge of the whole row, buttons included.
                  boxShadow: needsMe(u) ? `inset 3px 0 0 ${NX.blue}` : 'none',
                }}>
                <div data-update-row data-for-you={u.forYou ? '' : undefined}
                  data-answered={done ? '' : undefined} data-new={fresh ? '' : undefined}
                  role={t ? 'button' : undefined} tabIndex={t ? 0 : undefined} className={t ? 'nx-row-hover' : undefined}
                  onClick={() => open(u)}
                  onKeyDown={(e) => { if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(u); } }}
                  title={`${who} ${sentence.join(', ')} · ${formatDateTime(u.at)}${done ? ` · ${u.ask}` : ''}`}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 8px', margin: '0 -8px', borderRadius: 8,
                    cursor: t ? 'pointer' : 'default',
                  }}>
                  <Avatar email={u.actorId} name={nameOf(u.actorId) || u.actorId || 'Someone'} size={30} />
                  <div style={{ flex: 1, minWidth: 0, opacity: done ? 0.72 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, overflow: 'hidden' }}>
                        <span style={{ minWidth: 0, fontSize: 13.5, fontWeight: 600, color: t?.completed ? NX.faint : NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: t?.completed ? 'line-through' : 'none' }}>{title}</span>
                        {project && <span data-update-project style={{ flexShrink: 1, minWidth: 0, maxWidth: '45%', fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</span>}
                      </span>
                      {done && <StatusLabel label={u.ask} color="#16a34a" size="sm" style={{ flexShrink: 0, alignSelf: 'center' }} />}
                      <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        {fresh && <span role="img" aria-label="New" title="New since you last looked" style={{ width: 7, height: 7, borderRadius: '50%', background: NX.blue }} />}
                        {ago(u.at)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.4, marginTop: 1 }}>
                      <span style={{ fontWeight: 600, color: NX.ink }}>{who}</span>{' '}
                      {joinPhrases(phrases).map((p, k) => (typeof p === 'string' ? p
                        : <span key={k} style={p.forYou && !done ? { color: NX.blue, fontWeight: 600 }
                          : p.slip ? { color: NX.amber, fontWeight: 600 } : undefined}>{p.text}</span>))}
                      {u.relation === 'collaborator' && <span style={{ color: NX.faint }}> · Following</span>}
                      {u.relation === 'owner' && <span style={{ color: NX.faint }}> · You Own This</span>}
                    </div>
                    {u.preview && (
                      <div style={{ marginTop: 5, paddingLeft: 9, borderLeft: `2px solid ${NX.border}`, fontSize: 12.5, color: NX.dim, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
                        {u.preview}
                      </div>
                    )}
                  </div>
                </div>
                <RowActions u={u} done={done} onChanged={onChanged} />
                </div>
              );
            })}
          </section>
        ))}
        {!fill && list.length > UPDATES_SHOWN && (
          <button onClick={() => setExpanded((a) => !a)} style={{ ...btn('ghost'), padding: '10px 0 0', color: NX.blue, fontSize: 13 }}>
            {expanded ? 'Show Fewer' : `Show All ${list.length}`}
          </button>
        )}
        {onLoadMore && filter === 'all' && (fill || expanded || list.length <= UPDATES_SHOWN) && (
          <button onClick={onLoadMore} style={{ ...btn('ghost'), padding: '10px 0 0', marginLeft: !fill && list.length > UPDATES_SHOWN ? 16 : 0, color: NX.blue, fontSize: 13 }}>
            Load More
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{
      ...card, borderRadius: 16, padding: isMobile ? '14px 14px 12px' : 20,
      ...(fill ? { height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } : {}),
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        {/* The Home cards' one header (homeWidgets.WidgetHeader): a soft chip, then the title. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${NX.blue}1f`, color: NX.blue }}><Activity size={15} /></span>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Updates</h2>
        </span>
        <span style={{ fontSize: 12.5, color: NX.faint }}>
          {newCount > 0 && <span style={{ color: NX.blue, fontWeight: 600 }}>{newCount} New · </span>}
          On your tasks, last 14 days
        </span>
      </div>
      {rows.length > 0 && (
        <div role="tablist" aria-label="Which updates" style={{ display: 'flex', gap: 16, marginTop: 10, borderBottom: `1px solid ${NX.border}` }}>
          <button role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')} style={tabStyle(filter === 'all')}>All</button>
          <button role="tab" aria-selected={filter === 'you'} onClick={() => setFilter('you')} style={tabStyle(filter === 'you')}>
            For You{waiting.length > 0 ? ` (${waiting.length})` : ''}
          </button>
        </div>
      )}
      {body}
    </div>
  );
}
