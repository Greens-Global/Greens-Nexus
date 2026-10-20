// TicketAttachments - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { Paperclip, X, Download, ShieldAlert, Play } from 'lucide-react';
import { api } from '../api';
import { filesFromPaste } from '../tasks/lib';
import { NX, FONT, btn } from '../tasks/theme';
import { useIsMobile, useEscapeLayer } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { NO_RECORDING_TYPES } from './ticketMeta';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { toDownloadUrl } from '../lib/storageView';
import { uploadTicketEvidence } from './evidenceUpload';
import { attachmentKindOf, attachFailed, returnToTicketAfterRecording } from './ticketViewShared';
import { RecordUploadButtons } from './TicketEvidence';

// ── Attachment viewer ────────────────────────────────────────────────────────
// In-app viewer: images, recordings and PDFs open over the drawer instead of a
// new tab. z sits ABOVE the ticket modal (4000) and BELOW the recorder pill
// (6000). It is an Escape layer of its own (useEscapeLayer, the same stack
// every Modal is on), so Escape closes the viewer without also closing the
// drawer underneath; files with no inline renderer (docx, xlsx…) get a clean
// download card rather than a broken embed.
function AttachmentViewer({ att, onClose }) {
  useEscapeLayer(() => onClose());
  if (!att) return null;
  const isPdf = /\.pdf($|\?)/i.test(att.name || '') || /\.pdf($|\?)/i.test(att.url || '');
  const body = att.kind === 'image' ? (
    <img src={att.url} alt={att.name} style={{ maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8 }} />
  ) : att.kind === 'video' ? (
    <video src={att.url} controls autoPlay style={{ maxWidth: '92vw', maxHeight: '78vh', borderRadius: 8, background: '#000' }} />
  ) : isPdf ? (
    <iframe src={att.url} title={att.name} style={{ width: '92vw', height: '78vh', border: 'none', borderRadius: 8, background: '#fff' }} />
  ) : (
    <div onClick={(e) => e.stopPropagation()} style={{ background: NX.surface, borderRadius: 14, padding: '34px 44px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, maxWidth: '86vw' }}>
      <Paperclip size={30} style={{ color: NX.faint }} />
      <div style={{ fontSize: 14.5, fontWeight: 700, color: NX.ink, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
      <div style={{ fontSize: 12.5, color: NX.dim }}>No inline preview for this file type.</div>
      <a href={toDownloadUrl(att.url)} download={att.name} style={{ ...btn('primary'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Download size={14} /> Download
      </a>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 5500, background: 'rgba(9,14,11,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONT }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 20px', color: '#fff' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>{att.size}</span>
        <span style={{ flex: 1 }} />
        {att.url && <a href={toDownloadUrl(att.url)} download={att.name} title="Download" style={{ color: '#fff', opacity: 0.8, display: 'flex' }}><Download size={16} /></a>}
        <button onClick={onClose} aria-label="Close viewer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', display: 'flex', padding: 4 }}><X size={19} /></button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────────────────────
// Card size for the attachment gallery - wide/tall enough for a video thumbnail
// to actually read as a preview rather than an icon, narrow enough that a
// handful still fit before wrapping.
const ATT_CARD_W = 138;
const ATT_THUMB_H = 84;

function TicketAttachments({ ticketId, ticketType, canDelete = false }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  const [hoverId, setHoverId] = useState(null);
  const isMobile = useIsMobile();   // no hover on touch - actions stay visible instead
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
    const ok = await appDialog.confirm(`Remove "${a.name}" from this ticket? It cannot be brought back.`,
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
            const showActions = isMobile || hoverId === a.id;
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
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
  );
}

export { TicketAttachments };
