// "Mentioned In" (Record Links, Neil 11/06/2026): the notes that link to a
// record with [[ (notes/recordLink.jsx), read from GET /notes/mentions -
// only notes the viewer may open, newest first. It shows nothing at all
// until there is something to show: most records are never linked, and an
// empty heading on every task would be noise.
//
//   <MentionedIn refKey="task:<id>" />            a heading and the rows
//   <MentionedIn refKey=... frame={(title, body) => <Section title={title}>{body}</Section>} />
//                                                 the caller's own section look
import { useEffect, useState } from 'react';
import { StickyNote, PenTool } from 'lucide-react';
import { api } from '../api';
import { NX, FONT } from '../tasks/theme';
import { formatDate } from '../lib/datetime';
import { safeRef, openRecord } from '../notes/recordLink';

const defaultFrame = (title, body) => (
  <div>
    <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8, fontFamily: FONT }}>{title}</div>
    {body}
  </div>
);

export default function MentionedIn({ refKey, frame = defaultFrame, nameOf }) {
  const ref = safeRef(refKey || '');
  const [rows, setRows] = useState({ ref: '', notes: [], total: 0 });
  useEffect(() => {
    if (!ref) return undefined;
    let alive = true;
    Promise.resolve().then(() => api.noteMentions(ref))
      .then((r) => { if (alive) setRows({ ref, notes: r?.notes || [], total: r?.total || 0 }); })
      .catch(() => { if (alive) setRows({ ref, notes: [], total: 0 }); });   // a quiet extra: no banner for it
    return () => { alive = false; };
  }, [ref]);
  if (!ref || rows.ref !== ref || !rows.notes.length) return null;
  const title = `Mentioned In (${rows.total})`;
  const body = (
    <div role="list" aria-label="Notes that link here" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.notes.map((n) => {
        const Icon = n.kind === 'board' ? PenTool : StickyNote;
        const who = n.mine ? '' : (nameOf ? nameOf(n.owner) : n.owner);
        return (
          <button key={n.id} type="button" role="listitem" onClick={() => openRecord(`note:${n.id}`)}
            title={`Open "${n.title || 'Untitled Note'}"`}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '6px 8px', border: 'none', borderRadius: 7,
              background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: FONT, color: NX.ink,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <Icon size={15} style={{ color: NX.faint, flexShrink: 0 }} aria-hidden="true" />
            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.title || (n.kind === 'board' ? 'Untitled Board' : 'Untitled Note')}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: NX.faint, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {[who && `from ${who}`, n.updatedAt && formatDate(n.updatedAt)].filter(Boolean).join(' · ')}
            </span>
          </button>
        );
      })}
      {rows.total > rows.notes.length && (
        <div style={{ fontSize: 12, color: NX.faint, padding: '4px 8px' }}>and {rows.total - rows.notes.length} more</div>
      )}
    </div>
  );
  return frame(title, body);
}
