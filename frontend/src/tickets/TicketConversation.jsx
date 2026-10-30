// TicketConversation - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { X, MessageSquare, MessageSquareText, Lock } from 'lucide-react';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { richBodyHtml } from '../tasks/lib';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { formatDateTime } from '../lib/datetime';
import { NX, chip, btn } from '../tasks/theme';
import { Avatar, usePeople, useImageZoom } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { NO_RECORDING_TYPES } from './ticketMeta';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { uploadTicketEvidence } from './evidenceUpload';
import SavedReplyPicker from './SavedReplyPicker';
import {
  attachmentKindOf,
  attachFailed,
  escapeHtml,
  returnToTicketAfterRecording,
} from './ticketViewShared';
import { RecordUploadButtons } from './TicketEvidence';

// ── Conversation thread ──────────────────────────────────────────────────────
// The same editor the task module's comments use (RichDescription), not a bare
// textarea: formatting, links and - the point of the change - @mentions, which
// this thread simply did not have (Sagar, Sept 2 2026). A mention is written as
// a mailto link, which is exactly what routers/task_util.extract_mentions reads
// on the way in, so one editor and one parser serve tasks and tickets both.
// The reply being written is the drawer's (`reply` / `onReplyChange`): it is
// posted with the rest of the ticket's changes when Done is clicked, never on
// its own - see TicketDrawer's `commit`.
function TicketConversation({ ticketId, ticketType, nameOf, canInternal = true, canDelete = false, newSince, reply, onReplyChange, onDone, savedReplies = false, ticket = null, myEmail = '' }) {
  const [rows, setRows] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [pickingReply, setPickingReply] = useState(false);
  // A saved reply lands in the composer, filled in, for editing - added after
  // whatever is already written, never sent on its own.
  const insertSaved = (html) => onReplyChange((r) => ({ ...r, body: isEmptyDoc(r.body) ? html : `${r.body || ''}${html}` }));
  const { body, internal } = reply;
  const setBody = (b) => onReplyChange((r) => ({ ...r, body: b }));
  const setInternal = (i) => onReplyChange((r) => ({ ...r, internal: i }));
  const people = usePeople();
  const [zoomImage, zoomViewer] = useImageZoom();
  // A comment updates the ticket row itself (last_comment_at, which drives
  // the "Needs a comment" staleness badge - ticketMeta.js's commentStale) -
  // reload() above only re-fetches the comment thread, so without this the
  // ticket sitting in TasksContext's own state still held the OLD
  // lastCommentAt, and the badge never cleared after actually commenting
  // (Pranshu, Sep 17 2026). reloadTickets() re-pulls the ticket list - only
  // the tickets, not the whole task workspace (Oct 2026 review) - so the
  // drawer (and every list/board cell showing this ticket) picks up the new
  // value.
  const { reloadTickets } = useTasks();
  const reload = () => api.getTicketComments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const del = async (c) => {
    const ok = await appDialog.confirm(`Delete this ${c.internal ? 'internal note' : 'comment'}? It cannot be brought back.`,
      { title: c.internal ? 'Delete Internal Note' : 'Delete Comment', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteTicketComment(c.id); }
    catch (e) { appDialog.alert(`Could not delete it: ${e?.message || e}`, { title: 'Not Deleted' }); return; }
    await Promise.all([reload(), reloadTickets?.()]);
  };

  // Record / attach from the conversation (Pranshu, Oct 6: "if the same issue
  // happens again there's no option to add a recording again"). The file goes
  // to the ticket's Attachments straight away, and a link to it is added to
  // the reply being written, so it is sent with the message on Done.
  const attach = async (f) => {
    setAttaching(true);
    const kind = attachmentKindOf(f);
    let url = '';
    try { url = await uploadTicketEvidence(f, kind); } catch (e) {
      appDialog.alert(`"${f.name}" couldn't be stored: ${e?.message || 'upload failed'}.`);
    }
    await api.addTicketAttachment(ticketId, { name: f.name, size: `${Math.max(1, Math.round(f.size / 1024))} KB`, kind, url }).catch(attachFailed(f.name));
    setAttaching(false);
    if (!url) return;
    const recording = kind === 'video' && /^ticket-recording-/.test(f.name);
    const text = recording ? 'Screen recording' : kind === 'audio' ? 'Voice note' : f.name;
    const what = recording ? 'Attached a screen recording' : kind === 'audio' ? 'Attached a voice note' : 'Attached';
    const link = `<p>${what}: <a href="${escapeHtml(url)}">${escapeHtml(text)}</a></p>`;
    onReplyChange((r) => ({ ...r, body: isEmptyDoc(r.body) ? link : `${r.body || ''}${link}` }));
  };

  return (
    <div>
      {zoomViewer}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        {rows === null ? <div style={{ padding: '6px 0' }}><SkeletonBlocks count={4} height={44} /></div>
          : rows.length === 0 ? <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No comments yet.</div>
            : rows.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 8, ...(c.internal ? { background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 10, padding: 8 } : {}),
                ...(newSince !== undefined && (c.createdAt || '') > newSince && !c.internal ? { background: 'rgba(37,99,235,0.06)', borderRadius: 10, padding: 8 } : {}) }}>
                <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId) || c.authorId}</span>
                    {c.internal && <span style={{ ...chip(NX.amber, 'rgba(245,158,11,0.16)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={10} /> Internal Note</span>}
                    {newSince !== undefined && (c.createdAt || '') > newSince && (
                      <span style={{ ...chip(NX.blue, 'rgba(37,99,235,0.14)'), fontSize: 10.5 }}>New</span>
                    )}
                    <span style={{ fontSize: 11, color: NX.faint }}>{formatDateTime(c.createdAt)}</span>
                    {canDelete && (
                      <button onClick={() => del(c)} title="Delete" aria-label="Delete comment" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>
                    )}
                  </div>
                  {/* richBodyHtml sanitizes, and wraps a plain-text body (every
                      comment written before this change) in paragraphs - so old
                      and new comments render the same way. */}
                  <div className="nx-rich-body" style={{ fontSize: 13, color: NX.dim, marginTop: 2 }} onClick={zoomImage}
                    dangerouslySetInnerHTML={{ __html: richBodyHtml(c.body, nameOf) }} />
                </div>
              </div>
            ))}
      </div>
      {/* Public reply vs internal note toggle - the desk's only. */}
      {canInternal && <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {[['reply', 'Public Reply', false], ['note', 'Internal Note', true]].map(([k, lab, isInt]) => (
          <button key={k} onClick={() => setInternal(isInt)} style={{
            ...btn('ghost'), padding: '5px 10px', fontSize: 12, borderRadius: 7,
            background: internal === isInt ? (isInt ? 'rgba(245,158,11,0.16)' : 'rgba(37,99,235,0.12)') : 'transparent',
            color: internal === isInt ? (isInt ? NX.amber : NX.blue) : NX.dim, fontWeight: internal === isInt ? 700 : 600,
          }}>{isInt ? <Lock size={12} /> : <MessageSquare size={12} />}{lab}</button>
        ))}
      </div>}
      {/* The internal-note tint moves to a wrapper: the editor owns its own box,
          and a note still has to LOOK unlike a public reply at a glance. */}
      <div style={internal ? { borderRadius: 10, padding: 2, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' } : undefined}>
        <RichDescription
          value={body}
          onChange={setBody}
          onSubmit={onDone}
          mentionPeople={people}
          minHeight={64}
          placeholder={internal ? 'Internal note - visible to agents, not the requester…' : canInternal ? 'Public reply…' : 'Write a reply…'}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <RecordUploadButtons compact disabled={attaching} showRecord={!NO_RECORDING_TYPES.includes(ticketType)}
          onFile={attach} onRecordingChange={returnToTicketAfterRecording(ticketId)} />
        {savedReplies && (
          <button type="button" onClick={() => setPickingReply(true)}
            style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <MessageSquareText size={13} /> Saved Replies
          </button>
        )}
        {attaching && <Spinner size={14} />}
        <span style={{ fontSize: 11, color: NX.faint }}>Saved to Attachments and linked in your reply. Ctrl+V pastes a screenshot straight into the reply.</span>
      </div>
      <div style={{ fontSize: 11, color: NX.faint, marginTop: 8 }}>
        {isEmptyDoc(body) ? (
          <>Type <b>@</b> to mention someone - they'll be added to the ticket and told.</>
        ) : (
          <span style={{ color: NX.amber, fontWeight: 600 }}>
            {internal ? 'Your note is added' : 'Your reply is sent'} with your other changes when you click Done (or ⌘/Ctrl+Enter).
          </span>
        )}
      </div>
      {pickingReply && (
        <SavedReplyPicker ticket={ticket} agentEmail={myEmail} nameOf={nameOf}
          onInsert={insertSaved} onClose={() => setPickingReply(false)} />
      )}
    </div>
  );
}

export { TicketConversation };
