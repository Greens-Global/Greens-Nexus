// TicketAttachments - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { Paperclip, X, Download, ShieldAlert, Play, AudioLines } from 'lucide-react';
import { api } from '../api';
import { filesFromPaste } from '../tasks/lib';
import { NX } from '../tasks/theme';
import { useIsMobile, AttachmentViewer } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { NO_RECORDING_TYPES } from './ticketMeta';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { toDownloadUrl } from '../lib/storageView';
import { uploadTicketEvidence } from './evidenceUpload';
import { attachmentKindOf, attachFailed, returnToTicketAfterRecording } from './ticketViewShared';
import { RecordUploadButtons } from './TicketEvidence';

// ── Attachment viewer ────────────────────────────────────────────────────────
// The shared in-app viewer (tasks/components.jsx AttachmentViewer, 11/02/2026):
// images, recordings, voice notes and PDFs open over the drawer, Escape closes
// only the viewer, and a picture or a PDF page offers Mark Up - a board that
// can be attached back to this ticket (`markupSource`).

// ── Attachments ──────────────────────────────────────────────────────────────
// Card size for the attachment gallery - wide/tall enough for a video thumbnail
// to actually read as a preview rather than an icon, narrow enough that a
// handful still fit before wrapping.
const ATT_CARD_W = 138;
const ATT_THUMB_H = 84;

// `markupSource` (11/02/2026): the ticket as the place a markup board goes back to.
function TicketAttachments({ ticketId, ticketType, canDelete = false, markupSource = null }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  const [hoverId, setHoverId] = useState(null);
  const isMobile = useIsMobile();
  // No hover on touch - actions stay visible instead. A tablet or a phone on
  // its side is wider than the phone breakpoint, so ask about hover itself.
  const noHover = useIsMobile('(hover: none)');
  const reload = () => api.getTicketAttachments(ticketId).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ticketId]);

  const sendFile = async (f) => {
    setBusy(true);
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = attachmentKindOf(f);
    let url = '';
    try {
      url = await uploadTicketEvidence(f, kind);
    } catch (e) {
      appDialog.alert(`"${f.name}" was recorded but couldn't be stored: ${e?.message || 'upload failed'}. It won't be playable/downloadable.`);
    }
    await api.addTicketAttachment(ticketId, { name: f.name, size, kind, url }).catch(attachFailed(f.name));
    setBusy(false);
    reload();
  };
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendFile(f); };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); files.forEach(sendFile); } };
  const del = async (a) => {
    const ok = await appDialog.confirm(`Remove "${a.name}" from this ticket? It stops showing here and cannot be brought back; the stored copy is kept with the ticket's records.`,
      { title: 'Remove Attachment', confirmText: 'Remove', danger: true });
    if (!ok) return;
    try { await api.deleteTicketAttachment(a.id); }
    catch (e) { appDialog.alert(`Could not remove the attachment: ${e?.message || e}`, { title: 'Not Removed' }); }
    reload();
  };
  // Recording from an EXISTING ticket's Attachments tab, mirroring the create
  // form's onRecChange (recordingDraft.js): sendFile already uploads fine
  // even if this component unmounts mid-flight (it's just async API calls,
  // no navigation involved). What's missing without this is getting the
  // person BACK to this ticket once they stop - if they're still looking at
  // it, isTicketDrawerOpen is true and there's nothing to do (sendFile's own
  // reload() refreshes the list). If they navigated away - closed the
  // drawer, switched tickets, or left the module entirely - stash the id and
  // fire both the live event (drawer already mounted, showing something
  // else) and the module navigate (TicketsView itself unmounted) so
  // whichever one applies brings this exact ticket back up.
  const onRecChange = returnToTicketAfterRecording(ticketId);

  return (
    <div onPaste={onPaste} tabIndex={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <RecordUploadButtons onFile={sendFile} disabled={busy} showRecord={!NO_RECORDING_TYPES.includes(ticketType)}
          onRecordingChange={onRecChange} />
        {busy && <Spinner size={14} />}
        <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>
      </div>
      {rows === null ? (
        <div style={{ padding: '6px 0' }}>
          <SkeletonBlocks count={4} height={ATT_THUMB_H + 40} borderRadius={12}
            gridTemplateColumns={`repeat(auto-fill, minmax(${ATT_CARD_W}px, ${ATT_CARD_W}px))`} />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No attachments yet.</div>
      ) : (
        // A small card gallery, not a row of tags: a real thumbnail earns a
        // click, a filename buried in a chip does not - a screen recording
        // especially needs to read as "press play", not as a broken image.
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {rows.map((a) => {
            const failed = !a.url;
            const showActions = isMobile || noHover || hoverId === a.id;
            const actionBtn = { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.62)', color: '#fff', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'none' };
            return (
              <div key={a.id} onMouseEnter={() => setHoverId(a.id)} onMouseLeave={() => setHoverId((h) => (h === a.id ? null : h))}
                style={{ width: ATT_CARD_W, border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface, position: 'relative' }}>
                <button type="button" disabled={failed} onClick={() => a.url && setView(a)}
                  title={failed ? "This file failed to upload and isn't available - remove it and re-attach" : `View ${a.name}`}
                  style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: failed ? 'default' : 'pointer' }}>
                  <div style={{ position: 'relative', width: '100%', height: ATT_THUMB_H, background: NX.border2, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: failed ? 0.5 : 1 }}>
                    {a.kind === 'image' && a.url ? (
                      <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : a.kind === 'video' && a.url ? (
                      <>
                        {/* preload+seek past frame 0 - webm's first frame is often
                            solid black, which used to make every recording look
                            like a broken embed rather than a clickable preview. */}
                        <video src={a.url} muted preload="metadata" playsInline
                          onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = 0.1; } catch { /* ignore */ } }}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                        <span style={{ position: 'absolute', width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Play size={14} fill="#fff" style={{ color: '#fff', marginLeft: 2 }} />
                        </span>
                      </>
                    ) : a.kind === 'video' ? (
                      <Play size={22} style={{ color: NX.faint }} />
                    ) : a.kind === 'audio' ? (
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: NX.dim, fontSize: 11.5, fontWeight: 600 }}>
                        <AudioLines size={24} style={{ color: NX.primary }} aria-hidden="true" />Voice Note
                      </span>
                    ) : (
                      <Paperclip size={22} style={{ color: NX.faint }} />
                    )}
                    {failed && (
                      <span title="Upload failed" style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: '50%', background: NX.red, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <ShieldAlert size={12} style={{ color: '#fff' }} />
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '7px 9px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: failed ? NX.faint : NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: failed ? 'line-through' : 'none' }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: NX.faint, marginTop: 1 }}>{a.size}</div>
                  </div>
                </button>
                {showActions && (
                  <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex', gap: 4 }}>
                    {a.url && <a href={toDownloadUrl(a.url)} download={a.name} title="Download" style={actionBtn}><Download size={12} /></a>}
                    {canDelete && <button onClick={() => del(a)} title="Remove" aria-label={`Remove ${a.name}`} style={actionBtn}><X size={12} /></button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} markupSource={markupSource || { kind: 'ticket', id: ticketId, label: 'Ticket', url: `/tickets?ticket=${encodeURIComponent(ticketId)}` }} />}
    </div>
  );
}

export { TicketAttachments };
