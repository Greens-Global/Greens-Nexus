// Latest Comment - the last column of the ticket list (Neil, Oct 1 2026): the
// newest reply on each ticket, so the queue reads without opening every row.
// The server picks it (list_tickets' latestComment, one query for the whole
// list) and has already dropped internal notes for anyone who may not see
// them - this only renders what it was given. Clicking it opens the ticket on
// its Conversation tab.
import { Lock, MessageSquare } from 'lucide-react';
import { NX, FONT } from '../tasks/theme';
import { Avatar } from '../tasks/components';
import { formatDate, formatDateTime } from '../lib/datetime';

// The backend stamps times without a zone - they are UTC.
const asUtc = (iso) => (/Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);

// "just now" / "5m ago" / "3h ago" / "2d ago", then the US date once it is
// more than a week old - a relative time stops meaning much past that.
export function commentAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const ms = now - new Date(asUtc(iso)).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatDate(asUtc(iso));
}

// Plain text for the CSV export: "Name (MM/DD/YYYY h:mm AM): preview".
export function latestCommentText(c, nameOf) {
  if (!c) return '';
  const who = c.authorId ? (nameOf?.(c.authorId) || c.authorId) : '';
  const when = c.createdAt ? formatDateTime(asUtc(c.createdAt)) : '';
  return `${who}${when ? ` (${when})` : ''}${who || when ? ': ' : ''}${c.preview || ''}${c.internal ? ' [Internal]' : ''}`;
}

/** The cell itself. `compact` is the two-line version the phone card uses.
 *  `stacked` is the Support list's cell (Neil, 10/08): the author's picture
 *  instead of their name, then the comment wrapping onto two lines, the age
 *  underneath - the name is still in the tooltip and the aria label. */
export function LatestCommentPreview({ comment, nameOf, onOpen, compact = false, stacked = false }) {
  if (!comment) {
    return <span style={{ fontSize: 12, color: NX.faint }}>{compact ? '' : 'No comments yet'}</span>;
  }
  const who = comment.authorId ? (nameOf?.(comment.authorId) || comment.authorId) : 'Someone';
  const when = commentAgo(comment.createdAt);
  const full = `${who}${comment.internal ? ' (internal note)' : ''} - ${formatDateTime(asUtc(comment.createdAt))}\n${comment.preview || ''}`;
  if (stacked) {
    return (
      <button type="button" className="nx-latest-comment" title={full}
        aria-label={`Latest comment by ${who}, ${when}. Open the conversation`}
        onClick={(e) => { e.stopPropagation(); onOpen?.(); }}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', minWidth: 0, padding: '4px 6px',
          margin: '0 -6px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
          fontFamily: FONT, color: NX.ink, background: 'transparent',
        }}>
        <span style={{ position: 'relative', flexShrink: 0, marginTop: 1 }}>
          <Avatar email={comment.authorId} name={who} size={24} />
          {comment.internal && (
            <Lock size={10} aria-label="Internal note" style={{ position: 'absolute', right: -4, bottom: -3, color: NX.amber, background: NX.surface, borderRadius: '50%', padding: 1 }} />
          )}
        </span>
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span className="nx-clamp-2" style={{ fontSize: 12.5, lineHeight: 1.35, color: NX.ink, overflowWrap: 'anywhere' }}>{comment.preview}</span>
          {when && <span style={{ fontSize: 11, color: NX.faint }}>{when}</span>}
        </span>
      </button>
    );
  }
  return (
    <button type="button" className="nx-latest-comment" title={full}
      aria-label={`Latest comment by ${who}, ${when}. Open the conversation`}
      onClick={(e) => { e.stopPropagation(); onOpen?.(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0, padding: compact ? '6px 8px' : '3px 6px',
        margin: compact ? 0 : '0 -6px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
        fontFamily: FONT, color: NX.ink, background: compact ? NX.surface2 : 'transparent',
      }}>
      {comment.internal
        ? <Lock size={12} style={{ color: NX.amber, flexShrink: 0 }} aria-label="Internal note" />
        : <MessageSquare size={12} style={{ color: NX.faint, flexShrink: 0 }} />}
      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
        <b style={{ fontWeight: 600 }}>{who}</b>
        <span style={{ color: NX.dim }}>: {comment.preview}</span>
      </span>
      {when && <span style={{ flexShrink: 0, fontSize: 11.5, color: NX.faint }}>{when}</span>}
    </button>
  );
}
