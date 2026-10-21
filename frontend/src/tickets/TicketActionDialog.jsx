// TicketActionDialog - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useState } from 'react';
import { Star } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';
import { Modal } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { requiredHint, TICKET_RESOLUTION, label, field, ticketNoShort } from './ticketMeta';
import { TicketSelect } from './TicketAtoms';
import { textToHtml, CSAT_LABELS } from './ticketViewShared';

// ── Resolve / Confirm / Reopen (Neil, Sep 30) ────────────────────────────────
// The three moves that close the loop on a ticket, each asking for the one
// thing that makes it useful later:
//   resolve - the desk writes what was done ("when you close a ticket, you
//             need to put in what the resolution of the ticket is"). Required,
//             and the server refuses a resolve without it.
//   confirm - the requester rates how it was handled, 1-5 stars ("you need to
//             give them stars... comments are optional"). Stars required.
//   reopen  - the requester says why it is not fixed.
//   self_resolve - the requester marks their own ticket Resolved while it is
//             still Open or being worked (Neil, Oct 1: "a colleague helped
//             me"). "What fixed it?" is optional and goes out as a public
//             reply; the server records the resolution as theirs.
// A dialog rather than window.prompt so the rating can be stars and the note
// can be more than one line. `onSubmit(patch)` does the save and returns a
// promise; the caller decides how (the TasksContext store, or Support's api).
export function TicketActionDialog({ mode, ticket, targetStatus = 'resolved', onSubmit, onClose }) {
  const [note, setNote] = useState(ticket?.resolutionNote || '');
  const [resolution, setResolution] = useState(ticket?.resolution || 'fixed');
  // The maintenance record's vendor and cost (Property Tickets) - only for a
  // ticket linked to a property; kept from a previous resolve after a reopen.
  const [vendor, setVendor] = useState(ticket?.maintenanceVendor || '');
  const [cost, setCost] = useState(ticket?.maintenanceCost || '');
  const onProperty = !!ticket?.propertyAssetId;
  const costBad = onProperty && cost.trim() !== '' && !/^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(cost.trim());
  const noteBad = !note.trim();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [showErr, setShowErr] = useState(false);
  const invalid = mode === 'resolve' ? (noteBad || costBad) : mode === 'confirm' ? rating < 1
    : mode === 'self_resolve' ? false : !reason.trim();
  const title = mode === 'resolve' ? (targetStatus === 'closed' ? 'Close Ticket' : 'Resolve Ticket')
    : mode === 'self_resolve' ? 'Mark Resolved'
    : mode === 'confirm' ? 'How Satisfied Are You?' : 'Reopen Ticket';
  const go = async () => {
    if (busy) return;
    if (invalid) { setShowErr(true); return; }
    setBusy(true);
    const patch = mode === 'resolve'
      ? { status: targetStatus, resolution, resolutionNote: note.trim(),
          ...(onProperty && (vendor.trim() || ticket?.maintenanceVendor) ? { maintenanceVendor: vendor.trim() } : {}),
          ...(onProperty && (cost.trim() || ticket?.maintenanceCost) ? { maintenanceCost: cost.trim() } : {}) }
      : mode === 'self_resolve'
        ? { status: 'resolved', ...(comment.trim() ? { comment: textToHtml(comment) } : {}) }
      : mode === 'confirm'
        ? { status: 'closed', csatRating: rating, csatComment: comment.trim() }
        : { status: 'reopened', reopen_reason: reason.trim() };
    // onSubmit resolving to exactly `false` means nothing was saved (the
    // person chose Keep Editing over someone else's change) - stay open
    // rather than closing as if it had worked.
    try {
      if ((await onSubmit(patch)) === false) { setBusy(false); return; }
      onClose();
    } catch (e) { appDialog.alert(e?.message || String(e)); setBusy(false); }
  };
  return (
    // The shared popup size (60vw, at least 60vh; a full-screen sheet on
    // phones) - it was a fixed 480px box floating mid-page.
    <Modal title={title} onClose={onClose} minHeight="60vh" footer={
      <>
        <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={go} disabled={busy}>
          {busy ? 'Saving…' : (mode === 'resolve' || mode === 'self_resolve') ? (targetStatus === 'closed' ? 'Close Ticket' : 'Mark Resolved')
            : mode === 'confirm' ? 'Submit and Close Ticket' : 'Reopen'}
        </button>
      </>
    }>
      {ticket && (
        <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14 }}>
          <b style={{ color: NX.ink }}>{ticketNoShort(ticket.code)}</b> · {ticket.subject}
        </div>
      )}
      {mode === 'resolve' && (<>
        <div className="nx-fill" style={field}>
          <label style={label}>Resolution <span style={{ color: NX.red }}>*</span></label>
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={2000}
            placeholder="What was done to fix it? e.g. Replaced the ballast in the front office light."
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, ...(showErr && noteBad ? { borderColor: NX.red } : null) }} />
          {showErr && noteBad && <div style={requiredHint}>Required - the requester sees this, and it is the record for next time.</div>}
        </div>
        <div style={field}>
          <label style={label}>Outcome</label>
          <TicketSelect value={resolution} onChange={setResolution}
            options={TICKET_RESOLUTION.map((r) => [r.key, r.label])} />
        </div>
        {onProperty && (<>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10 }}>
            <div style={field}>
              <label style={label}>Vendor</label>
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={200}
                placeholder="e.g. ABC Plumbing" style={{ ...inputStyle, fontFamily: FONT }} />
            </div>
            <div style={field}>
              <label style={label}>Cost</label>
              <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="$0.00"
                style={{ ...inputStyle, fontFamily: FONT, ...(showErr && costBad ? { borderColor: NX.red } : null) }} />
              {showErr && costBad && <div style={requiredHint}>An amount like 1250.50</div>}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: -6, marginBottom: 12 }}>
            Optional - goes on {ticket.propertyName || 'the property'}'s maintenance record and its Total Spend.
          </div>
        </>)}
      </>)}
      {mode === 'self_resolve' && (
        <div className="nx-fill" style={field}>
          <label style={label}>What fixed it? (optional)</label>
          <textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={1000}
            placeholder="e.g. A colleague showed me how to reconnect the printer."
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Posted on the ticket's conversation so the team knows. You can still reopen it if the problem comes back.
          </div>
        </div>
      )}
      {mode === 'confirm' && (<>
        <div style={field}>
          <label style={label}>How satisfied are you with how your ticket was handled? <span style={{ color: NX.red }}>*</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} onMouseEnter={() => setHover(n)}
                style={{ border: 'none', background: 'none', padding: 2, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
                <Star size={28} style={{ color: (hover || rating) >= n ? NX.amber : NX.border, fill: (hover || rating) >= n ? NX.amber : 'none' }} />
              </button>
            ))}
            {(hover || rating) > 0 && <span style={{ fontSize: 13, color: NX.ink, fontWeight: 600, marginLeft: 8 }}>{CSAT_LABELS[hover || rating]}</span>}
          </div>
          {showErr && invalid && <div style={requiredHint}>Pick 1 to 5 stars to close the ticket.</div>}
        </div>
        {ticket?.resolutionNote && (
          <div style={{ fontSize: 12.5, color: NX.dim, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '8px 10px', marginBottom: 14, whiteSpace: 'pre-wrap' }}>
            <b style={{ color: NX.ink }}>Resolution:</b> {ticket.resolutionNote}
          </div>
        )}
        <div className="nx-fill" style={field}>
          <label style={label}>Anything you would like to tell the team? (optional)</label>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={1000}
            placeholder="Anything the team should know?" style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>
      </>)}
      {mode === 'reopen' && (
        <div className="nx-fill" style={field}>
          <label style={label}>Why are you reopening it? <span style={{ color: NX.red }}>*</span></label>
          <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000}
            placeholder="e.g. The light went out again this morning."
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, ...(showErr && invalid ? { borderColor: NX.red } : null) }} />
          {showErr && invalid && <div style={requiredHint}>Required</div>}
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>The ticket goes back to the team with its full history.</div>
        </div>
      )}
    </Modal>
  );
}
