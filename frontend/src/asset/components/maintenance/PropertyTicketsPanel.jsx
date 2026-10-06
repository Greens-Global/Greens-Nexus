// A property's tickets inside Asset Management (Neil, 10/05): Open Tickets and
// Closed Tickets (maintenance history). A summary per ticket; the ticket
// itself opens only for someone the ticket rules let in (canOpen), everyone
// else gets the summary card. Follow is offered only when the server says
// canFollow (asset editors, admins, the property's own asset manager) - never
// to a read-only viewer.
import { useState } from 'react';
import { api } from '../../../api.js';
import { formatDate } from '../../../lib/datetime.js';
import AsyncSection, { SkeletonBlocks } from '../../../components/AsyncState.jsx';
import { TICKET_STATUS, TICKET_PRIORITY, money, historyCsv, downloadCsv } from '../../lib/propertyTickets.js';
import { StatusBadge } from '../shared/StatusBadge.jsx';
import { EmptyState } from '../shared/EmptyState.jsx';
import { Modal } from '../shared/Modal.jsx';

function Row({ t, closed, onOpen }) {
  const [sLabel, sTone] = TICKET_STATUS[t.status] || [t.status, 'mut'];
  const [pLabel, pTone] = TICKET_PRIORITY[t.priority] || [t.priority, 'mut'];
  const meta = [t.category, t.location, t.onParcel ? `Parcel: ${t.propertyName}` : ''].filter(Boolean).join(' · ');
  return (
    <button type="button" onClick={() => onOpen(t)}
      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', marginBottom: 8, cursor: 'pointer', border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-card)', fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{t.codeLabel}</span>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)', flex: '1 1 200px' }}>{t.subject}</span>
        {t.approvalStatus === 'pending' && <StatusBadge tone="blue">Awaiting Approval</StatusBadge>}
        <StatusBadge tone={sTone}>{sLabel}</StatusBadge>
        {!closed && <StatusBadge tone={pTone}>{pLabel}</StatusBadge>}
        {closed && t.logged && <StatusBadge tone="green">Recorded</StatusBadge>}
        {closed && t.needsAction && <StatusBadge tone="red">Needs Action</StatusBadge>}
        {t.parentTicketId && <StatusBadge tone="blue">Service From {t.parentCodeLabel}</StatusBadge>}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
        {meta && <span>{meta} · </span>}
        {closed
          ? <>Closed {formatDate(t.resolvedAt) || '-'}{t.vendor ? ` · ${t.vendor}` : ''}{t.cost ? ` · ${money(t.cost)}` : ''}</>
          : <>{t.assigneeName ? `Assigned to ${t.assigneeName}` : 'Unassigned'} · Opened {formatDate(t.createdAt) || '-'}</>}
        {t.photoCount > 0 && ` · ${t.photoCount} photo${t.photoCount > 1 ? 's' : ''}`}
      </div>
      {closed && t.resolutionNote && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{t.resolutionNote}</div>
      )}
    </button>
  );
}

export function PropertyTicketsPanel({ mode, tickets, onOpen, onFollowAll, propertyName = '' }) {
  const { data, loading, error, reload } = tickets;
  const rows = mode === 'open' ? (data?.open || []) : (data?.history || []);
  const records = rows.filter((t) => t.maintenanceRecord);
  const noWork = rows.filter((t) => !t.maintenanceRecord);
  const [showNoWork, setShowNoWork] = useState(false);
  const unfollowed = (data?.open || []).filter((t) => !t.canOpen);
  return (
    <AsyncSection loading={loading && !data} error={error && !data ? error : null} onRetry={reload} isEmpty={!rows.length}
      errorMessage="This property's tickets couldn't be loaded right now - please try again."
      skeleton={<SkeletonBlocks count={3} height={64} />}
      emptyContent={<EmptyState>{mode === 'open'
        ? 'No open tickets at this property. Create one, or start a walkthrough to log several at once.'
        : 'No closed tickets yet. Closed tickets become this property\'s maintenance history.'}</EmptyState>}>
      {mode === 'open' ? (<>
        {data?.canFollow && unfollowed.length > 1 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="secondary-btn" onClick={() => onFollowAll(unfollowed)}>Follow All Open</button>
          </div>
        )}
        {rows.map((t) => <Row key={t.id} t={t} onOpen={onOpen} />)}
      </>) : (<>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, marginBottom: 12, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <span>Recorded <b style={{ color: 'var(--text-primary)' }}>{records.filter((t) => t.logged).length}</b></span>
          <span>Needs Action <b style={{ color: 'var(--text-primary)' }}>{records.filter((t) => t.needsAction).length}</b></span>
          <span>Last Closed <b style={{ color: 'var(--text-primary)' }}>{formatDate(records[0]?.resolvedAt) || '-'}</b></span>
          <span>Recorded Spend <b style={{ color: 'var(--text-primary)' }}>{Number(data?.spend) > 0 ? money(data.spend) : '-'}</b></span>
          <button className="secondary-btn" style={{ marginLeft: 'auto' }}
            onClick={() => downloadCsv(historyCsv(data, propertyName), `${propertyName || 'property'} - maintenance history.csv`)}>
            Export History CSV
          </button>
        </div>
        {records.map((t) => <Row key={t.id} t={t} closed onOpen={onOpen} />)}
        {noWork.length > 0 && (<>
          <button type="button" onClick={() => setShowNoWork((v) => !v)}
            style={{ border: 'none', background: 'none', padding: '6px 0', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            {showNoWork ? 'Hide' : 'Show'} Closed Without Work ({noWork.length})
          </button>
          {showNoWork && noWork.map((t) => <Row key={t.id} t={t} closed onOpen={onOpen} />)}
        </>)}
      </>)}
    </AsyncSection>
  );
}

/** For a ticket the viewer cannot open: what Asset Management may show, plus Follow. */
export function TicketSummaryModal({ t, propertyId, canFollow = false, onClose, onFollowed }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sLabel] = TICKET_STATUS[t.status] || [t.status];
  const follow = async () => {
    setBusy(true); setErr('');
    try { await api.followPropertyTicket(propertyId, t.id); onFollowed(t); }
    catch (e) { setErr(e.message || 'Could not follow this ticket.'); setBusy(false); }
  };
  const rows = [['Status', sLabel], ['Category', t.category], ['Location', t.location], ['Assigned To', t.assigneeName || 'Unassigned'],
    ['Raised By', t.requesterName], ['Opened', formatDate(t.createdAt)], ['Closed', formatDate(t.resolvedAt)],
    ['Resolution', t.resolutionNote], ['Vendor', t.vendor], ['Cost', money(t.cost)]].filter(([, v]) => v);
  return (
    <Modal title={`${t.codeLabel} · ${t.subject}`} onClose={onClose} footer={<>
      <button className="secondary-btn" onClick={onClose}>Close</button>
      {canFollow && <button className="primary-btn" onClick={follow} disabled={busy}>{busy ? 'Following…' : 'Follow This Ticket'}</button>}
    </>}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: '0.85rem' }}>
          <span style={{ width: 110, color: 'var(--text-secondary)' }}>{k}</span>
          <span style={{ flex: 1, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{v}</span>
        </div>
      ))}
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 12 }}>
        {canFollow
          ? 'Following adds you to the ticket\'s watchers, so you can open it, reply and hear about updates. It is recorded on the ticket.'
          : 'This is the summary Asset Management shows. To see the full ticket, ask the property\'s asset manager or the service desk.'}
      </div>
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: '0.8rem', marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
