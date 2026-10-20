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
import { useMemo, useState } from 'react';
import { Avatar } from './components';
import { NX, FONT, btn, card } from './theme';
import { ago, updatePhrases } from './updatesText';
import { formatDateTime } from '../lib/datetime';

// Rows shown before "Show All" where the card is not filling a column.
const UPDATES_SHOWN = 8;

const joinPhrases = (phrases) => phrases.flatMap((p, i) => {
  const sep = i === 0 ? '' : i === phrases.length - 1 ? ' and ' : ', ';
  return [sep, p];
});

// Today / Yesterday / Earlier, by the LOCAL calendar date.
const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (localDay(d) === localDay(today)) return 'Today';
  if (localDay(d) === localDay(yesterday)) return 'Yesterday';
  return 'Earlier';
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
 */
export default function UpdatesCard({ updates, failed, nameOf, statusMeta, taskById, onOpen, fill = false, isMobile = false }) {
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => updates || [], [updates]);
  const forYou = rows.filter((u) => u.forYou).length;
  const list = filter === 'you' ? rows.filter((u) => u.forYou) : rows;
  const shown = fill || expanded ? list : list.slice(0, UPDATES_SHOWN);
  const sections = [];
  for (const u of shown) {
    const label = dayLabel(u.at);
    if (!sections.length || sections[sections.length - 1].label !== label) sections.push({ label, rows: [] });
    sections[sections.length - 1].rows.push(u);
  }

  const open = (u) => { if (u.taskId && taskById.has(u.taskId)) onOpen(u.taskId); };
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
  else if (list.length === 0) body = note('Nothing for you right now. Assignments, mentions and comments you need to act on will show here.');
  else {
    body = (
      <div style={fill ? { flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -8px', padding: '0 8px' } : undefined}>
        {sections.map((s) => (
          <section key={s.label} aria-label={s.label}>
            <div style={{ fontSize: 12, fontWeight: 600, color: NX.faint, padding: '12px 0 4px' }}>{s.label}</div>
            {s.rows.map((u, i) => {
              const t = taskById.get(u.taskId);
              const title = t?.title || u.entityTitle || u.entityCode || 'A task';
              const who = nameOf(u.actorId) || u.actorId || 'Someone';
              const phrases = updatePhrases(u, statusMeta);
              const sentence = phrases.map((p) => p.text);
              return (
                <div key={u.id} data-update-row data-for-you={u.forYou ? '' : undefined}
                  role={t ? 'button' : undefined} tabIndex={t ? 0 : undefined} className={t ? 'nx-row-hover' : undefined}
                  onClick={() => open(u)}
                  onKeyDown={(e) => { if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(u); } }}
                  title={`${who} ${sentence.join(', ')} · ${formatDateTime(u.at)}`}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 8px', margin: '0 -8px', borderRadius: 8,
                    borderTop: i === 0 ? 'none' : `1px solid ${NX.border2}`, cursor: t ? 'pointer' : 'default',
                    // Aimed at me: a thin rule down the left edge, not a chip.
                    boxShadow: u.forYou ? `inset 3px 0 0 ${NX.blue}` : 'none',
                  }}>
                  <Avatar email={u.actorId} name={who} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: t?.completed ? NX.faint : NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: t?.completed ? 'line-through' : 'none' }}>{title}</span>
                      <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{ago(u.at)}</span>
                    </div>
                    <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.4, marginTop: 1 }}>
                      <span style={{ fontWeight: 600, color: NX.ink }}>{who}</span>{' '}
                      {joinPhrases(phrases).map((p, k) => (typeof p === 'string' ? p
                        : <span key={k} style={p.forYou ? { color: NX.blue, fontWeight: 600 } : undefined}>{p.text}</span>))}
                      {u.relation === 'collaborator' && <span style={{ color: NX.faint }}> · Following</span>}
                    </div>
                    {u.preview && (
                      <div style={{ marginTop: 5, paddingLeft: 9, borderLeft: `2px solid ${NX.border}`, fontSize: 12.5, color: NX.dim, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
                        {u.preview}
                      </div>
                    )}
                  </div>
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
      </div>
    );
  }

  return (
    <div style={{
      ...card, borderRadius: 16, padding: isMobile ? '14px 14px 12px' : 20,
      ...(fill ? { height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } : {}),
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Updates</h2>
        <span style={{ fontSize: 12.5, color: NX.faint }}>On your tasks, last 14 days</span>
      </div>
      {rows.length > 0 && (
        <div role="tablist" aria-label="Which updates" style={{ display: 'flex', gap: 16, marginTop: 10, borderBottom: `1px solid ${NX.border}` }}>
          <button role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')} style={tabStyle(filter === 'all')}>All</button>
          <button role="tab" aria-selected={filter === 'you'} onClick={() => setFilter('you')} style={tabStyle(filter === 'you')}>
            For You{forYou > 0 ? ` (${forYou})` : ''}
          </button>
        </div>
      )}
      {body}
    </div>
  );
}
