// Task Module - one comment thread (Oct 2026): a root comment, its replies,
// reactions, and the action-item controls (assign to a person, resolve).
// Shared by the drawer's Comments tab and the Overview's "latest comments"
// preview, so the two cannot drift. Bodies are HTML (rich editor + Asana's
// html_text); richBodyHtml sanitizes them.
import { useRef, useState } from 'react';
import { Check, CheckCircle2, CornerDownRight, Download, Paperclip, Pencil, Pin, RotateCcw, SmilePlus, Trash2 } from 'lucide-react';
import { NX, FONT, btn } from './theme';
import { Avatar, AttachmentViewer, PersonDot, useImageZoom } from './components';
import { fmtDateTime, parseImportedAuthor, richBodyHtml, COMMENT_REACTIONS } from './lib';
import RichDescription, { isEmptyDoc } from './RichDescription';
import AnchoredMenu from '../components/AnchoredMenu';

/** "👍 2" chips plus a picker. `reactions` is {emoji: [emails]}. */
export function CommentReactions({ reactions = {}, myEmail, nameOf, onToggle, compact = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const entries = Object.entries(reactions || {}).filter(([, who]) => Array.isArray(who) && who.length);
  if (!entries.length && compact) return null;
  const names = (who) => who.map((e) => nameOf?.(e) || e).join(', ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: entries.length ? 6 : 0 }}>
      {entries.map(([emoji, who]) => {
        const mine = who.includes(myEmail);
        return (
          <button key={emoji} type="button" onClick={() => onToggle?.(emoji)} title={names(who)} aria-label={`${emoji} ${who.length}`}
            aria-pressed={mine}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999, fontSize: 12, cursor: 'pointer', fontFamily: FONT,
              border: `1px solid ${mine ? NX.blue : NX.border}`, background: mine ? `${NX.blue}14` : 'transparent', color: NX.ink }}>
            <span>{emoji}</span><span style={{ fontWeight: 600, color: mine ? NX.blue : NX.dim }}>{who.length}</span>
          </button>
        );
      })}
      {!compact && (
        <div ref={ref} style={{ display: 'inline-flex' }}>
          <button type="button" onClick={() => setOpen((o) => !o)} title="Add reaction" aria-label="Add reaction"
            style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><SmilePlus size={14} /></button>
          <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)}
            style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 6 }}>
            <div style={{ display: 'flex', gap: 2 }}>
              {COMMENT_REACTIONS.map((e) => (
                <button key={e} type="button" onClick={() => { onToggle?.(e); setOpen(false); }} aria-label={`React ${e}`}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, padding: '4px 5px', borderRadius: 6 }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = NX.hover)} onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}>
                  {e}
                </button>
              ))}
            </div>
          </AnchoredMenu>
        </div>
      )}
    </div>
  );
}

// Files attached while THIS comment was composed - see TaskAttachment.comment_id.
// An image renders as a real inline preview; anything else as a named card
// that opens the in-app viewer.
export function CommentAttachments({ items }) {
  const [view, setView] = useState(null);
  const card = (a, body) => {
    const href = a.dataUrl || a.url;
    const style = {
      display: 'flex', alignItems: 'center', gap: 10, width: 260, padding: '9px 12px',
      border: `1px solid ${NX.border}`, borderRadius: 10, textDecoration: 'none',
      opacity: href ? 1 : 0.65,
    };
    return href
      ? <button key={a.id} type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
          style={{ ...style, background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'inherit' }}>{body}</button>
      : <div key={a.id} style={style} title="This file failed to upload and isn't available - remove it and re-attach">{body}</div>;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {items.map((a) => {
        const href = a.dataUrl || a.url;
        if (a.kind === 'image' && href) {
          return (
            <button key={a.id} type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', alignSelf: 'flex-start' }}>
              <img src={href} alt={a.name}
                style={{ display: 'block', maxWidth: 320, maxHeight: 240, borderRadius: 10, border: `1px solid ${NX.border}`, objectFit: 'cover' }} />
            </button>
          );
        }
        return card(a, (
          <>
            <Paperclip size={16} style={{ color: NX.dim, flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: 11, color: NX.faint, display: 'flex', alignItems: 'center', gap: 4 }}>
                {href ? <><Download size={10} /> View or download</> : 'Not stored'}
              </div>
            </div>
          </>
        ));
      })}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
  );
}

function CommentBody({ c, nameOf, editing, text, setText, onSave, onCancel, attachments }) {
  const [zoomImage, zoomViewer] = useImageZoom();
  const imported = parseImportedAuthor(c.body);
  const displayBody = imported ? imported.text : c.body;
  if (editing) {
    return (
      <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <RichDescription value={text} onChange={setText} minHeight={56} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button onClick={onSave} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Save</button>
          <button onClick={onCancel} style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12 }}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="nx-rich-view" style={{ marginTop: 2, color: NX.dim }} onClick={zoomImage}
        dangerouslySetInnerHTML={{ __html: richBodyHtml(displayBody, nameOf) }} />
      {zoomViewer}
      {attachments.length > 0 && <CommentAttachments items={attachments} />}
    </>
  );
}

/**
 * One comment row - the root or a reply. Hover actions: react, reply (root
 * only), assign / resolve (root only), pin, and edit / delete for the author.
 * The server decides who may pin, assign and resolve; the row offers them.
 */
function CommentRow({ c, isReply, nameOf, myEmail, people, attachments = [], onPin, onEdit, onDelete, onReact, onReply, onResolve, onAssign }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const [hover, setHover] = useState(false);
  const imported = parseImportedAuthor(c.body);
  const displayName = imported?.name || nameOf(c.authorId);
  const displayBody = imported ? imported.text : c.body;
  const mine = c.authorId === myEmail;
  const resolved = !!c.resolvedAt;
  const assignedToMe = c.assigneeId && c.assigneeId === myEmail;
  const act = (title, Icon, onClick, color = NX.faint) => (
    <button key={title} onClick={onClick} title={title} aria-label={title} style={{ ...btn('ghost'), padding: 4, color }}><Icon size={12} /></button>
  );
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', gap: 10, padding: 8, borderRadius: 10,
        background: c.pinned ? 'rgba(217,119,6,0.14)' : assignedToMe && !resolved ? `${NX.blue}0d` : 'transparent',
        marginLeft: isReply ? 28 : 0, borderLeft: isReply ? `2px solid ${NX.border}` : 'none' }}>
      <Avatar email={c.authorId} name={displayName} size={isReply ? 22 : 26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{displayName}</span>
          <span style={{ fontSize: 11, color: NX.faint }}>{fmtDateTime(c.createdAt)}</span>
          {c.editedAt && <span style={{ fontSize: 11, fontStyle: 'italic', color: NX.faint }}>(edited)</span>}
          {c.pinned && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.amber }}>Pinned</span>}
          {!isReply && c.assigneeId && (
            <span title={resolved ? `Resolved by ${nameOf(c.resolvedBy)} on ${fmtDateTime(c.resolvedAt)}` : `Assigned to ${nameOf(c.assigneeId)}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                color: resolved ? NX.green : NX.blue, background: resolved ? `${NX.green}14` : `${NX.blue}14` }}>
              {resolved ? <CheckCircle2 size={11} /> : <Avatar email={c.assigneeId} name={nameOf(c.assigneeId)} size={13} card={false} />}
              {resolved ? 'Resolved' : assignedToMe ? 'Assigned to you' : nameOf(c.assigneeId)}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>
            {!isReply && !resolved && onReply && act('Reply', CornerDownRight, onReply)}
            {!isReply && onAssign && (
              <span title={c.assigneeId ? 'Assigned - change' : 'Assign this comment to someone'} style={{ display: 'inline-flex', alignItems: 'center', padding: '0 3px' }}>
                <PersonDot value={c.assigneeId || ''} people={people} nameOf={nameOf} size={16} onChange={onAssign}
                  emptyTitle="Assign this comment to someone" nobodyLabel="Nobody (not an action item)" />
              </span>
            )}
            {!isReply && (c.assigneeId || resolved) && onResolve && (
              resolved ? act('Reopen', RotateCcw, () => onResolve(false)) : act('Resolve', Check, () => onResolve(true), NX.green)
            )}
            {onPin && act(c.pinned ? 'Unpin' : 'Pin', Pin, onPin)}
            {mine && act('Edit', Pencil, () => { setText(displayBody); setEditing(true); })}
            {mine && act('Delete', Trash2, onDelete)}
          </div>
        </div>
        <CommentBody c={c} nameOf={nameOf} editing={editing} text={text} setText={setText} attachments={attachments}
          onSave={() => { onEdit(text); setEditing(false); }} onCancel={() => setEditing(false)} />
        <CommentReactions reactions={c.reactions} myEmail={myEmail} nameOf={nameOf} onToggle={(e) => onReact?.(c, e)} />
      </div>
    </div>
  );
}

function ReplyComposer({ people, onPost, onCancel }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (isEmptyDoc(body) || busy) return;
    setBusy(true);
    try { await onPost(body); setBody(''); onCancel(); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginLeft: 28, marginTop: 4, paddingLeft: 10, borderLeft: `2px solid ${NX.border}` }} data-testid="reply-composer">
      <RichDescription value={body} onChange={setBody} onSubmit={post} mentionPeople={people} minHeight={48} autoFocus />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: NX.faint }}>Everyone in this thread is told. ⌘/Ctrl+Enter to post.</span>
        <button onClick={onCancel} style={{ ...btn('ghost'), marginLeft: 'auto', padding: '5px 10px', fontSize: 12 }}>Cancel</button>
        <button onClick={post} disabled={isEmptyDoc(body) || busy} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12, opacity: isEmptyDoc(body) || busy ? 0.5 : 1 }}>
          {busy ? 'Posting…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}

/**
 * thread: { root, replies } from lib.threadComments. Handlers all receive
 * the comment they act on. A resolved thread opens folded to one line.
 */
export default function CommentThread({ thread, nameOf, myEmail, people = [], attachments, onPin, onEdit, onDelete, onReply, onReact, onResolve, onAssign }) {
  const { root, replies } = thread;
  const [replying, setReplying] = useState(false);
  const resolved = !!root.resolvedAt;
  const [folded, setFolded] = useState(resolved);
  const att = (c) => attachments?.get?.(c.id) || [];
  if (resolved && folded) {
    return (
      <button type="button" onClick={() => setFolded(false)} aria-label="Show resolved comment"
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, fontFamily: FONT, textAlign: 'left', color: NX.faint, fontSize: 12.5 }}>
        <CheckCircle2 size={14} style={{ color: NX.green, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <b style={{ color: NX.dim }}>{nameOf(root.authorId)}</b>: {richBodyHtml(root.body, nameOf).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)}
        </span>
        <span style={{ flexShrink: 0 }}>Resolved by {nameOf(root.resolvedBy)}{replies.length ? ` · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : ''}</span>
      </button>
    );
  }
  return (
    <div style={{ opacity: resolved ? 0.75 : 1 }}>
      <CommentRow c={root} nameOf={nameOf} myEmail={myEmail} people={people} attachments={att(root)}
        onPin={onPin && (() => onPin(root))} onEdit={(t) => onEdit(root, t)} onDelete={() => onDelete(root)}
        onReact={onReact} onReply={onReply && (() => setReplying(true))}
        onResolve={onResolve && ((v) => onResolve(root, v))} onAssign={onAssign && ((email) => onAssign(root, email))} />
      {replies.map((r) => (
        <CommentRow key={r.id} c={r} isReply nameOf={nameOf} myEmail={myEmail} people={people} attachments={att(r)}
          onEdit={(t) => onEdit(r, t)} onDelete={() => onDelete(r)} onReact={onReact} />
      ))}
      {replying && onReply && <ReplyComposer people={people} onPost={(html) => onReply(root, html)} onCancel={() => setReplying(false)} />}
      {!replying && !resolved && onReply && replies.length > 0 && (
        <button type="button" onClick={() => setReplying(true)} style={{ ...btn('ghost'), marginLeft: 36, padding: '2px 6px', fontSize: 12, color: NX.primary || NX.blue }}>
          <CornerDownRight size={12} /> Reply
        </button>
      )}
      {resolved && (
        <button type="button" onClick={() => setFolded(true)} style={{ ...btn('ghost'), marginLeft: 8, padding: '2px 6px', fontSize: 11.5, color: NX.faint }}>Fold</button>
      )}
    </div>
  );
}
