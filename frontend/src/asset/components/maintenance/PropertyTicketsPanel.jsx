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
import { TICKET_STATUS, money, historyCsv, downloadCsv } from '../../lib/propertyTickets.js';
import { formatTotals } from '../../lib/currency.js';
import { Ticket, History } from 'lucide-react';
import { EmptyState } from '../shared/EmptyState.jsx';
import { SummarySentence } from '../shared/Toolbar.jsx';
import { Modal } from '../shared/Modal.jsx';
import { PropertyTicketsTable } from './PropertyTicketsTable.jsx';

export function PropertyTicketsPanel({ mode, tickets, onOpen, onFollowAll, propertyName = '' }) {
  const { data, loading, error, reload } = tickets;
  const rows = mode === 'open' ? (data?.open || []) : (data?.history || []);
  const unfollowed = (data?.open || []).filter((t) => !t.canOpen);
  return (
    <AsyncSection loading={loading && !data} error={error && !data ? error : null} onRetry={reload} isEmpty={!rows.length}
      errorMessage="This property's tickets couldn't be loaded right now - please try again."
      skeleton={<SkeletonBlocks count={3} height={64} />}
      emptyContent={mode === 'open'
        ? <EmptyState icon={Ticket} title="No open tickets">Nothing is open at this property. Report a Problem raises one; Batch Create logs several from a walkthrough.</EmptyState>
        : <EmptyState icon={History} title="No closed tickets yet">Closed tickets become this property&apos;s maintenance history.</EmptyState>}>
      {mode === 'open' ? (<>
        {data?.canFollow && unfollowed.length > 1 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 0 8px' }}>
            <button className="secondary-btn" onClick={() => onFollowAll(unfollowed)}>Follow All Open</button>
          </div>
        )}
        <PropertyTicketsTable rows={rows} onOpen={onOpen} tableKey="property-open-tickets" />
      </>) : (<>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 0' }}>
          <SummarySentence style={{ flex: '1 1 260px' }} parts={(() => {
            const logged = rows.filter((t) => t.logged).length;
            const needs = rows.filter((t) => t.needsAction).length;
            const spend = formatTotals(data?.spendTotals);
            return [
              `${rows.length} closed`,
              logged && `${logged} in the maintenance record`,
              needs && { text: `${needs} waiting to be added`, tone: 'red' },
              rows[0]?.resolvedAt && `last closed ${formatDate(rows[0].resolvedAt)}`,
              spend && `${spend} recorded spend`,
            ].filter(Boolean);
          })()} />
          <button className="secondary-btn" style={{ marginLeft: 'auto', height: 32, padding: '0 12px' }}
            onClick={() => downloadCsv(historyCsv(data, propertyName), `${propertyName || 'property'} - maintenance history.csv`)}>
            Export History CSV
          </button>
        </div>
        <PropertyTicketsTable rows={rows} onOpen={onOpen} tableKey="property-closed-tickets" />
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
  const rows = [['Status', sLabel], ['Category', t.category], ['Unit', t.unit], ['Location', t.location],['Assigned To', t.assigneeName || 'Unassigned'],
    ['Raised By', t.requesterName], ['Opened', formatDate(t.createdAt)], ['Closed', formatDate(t.resolvedAt)],
    ['Resolution', t.resolutionNote], ['Vendor', t.vendor], ['Cost', money(t.cost)]].filter(([, v]) => v);
  return (
    <Modal title={`${t.codeLabel} · ${t.subject}`} onClose={onClose} footer={<>
      <button className="secondary-btn" onClick={onClose}>Close</button>
      {canFollow && <button className="primary-btn" onClick={follow} disabled={busy}>{busy ? 'Following…' : 'Follow This Ticket'}</button>}
    </>}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13 }}>
          <span style={{ width: 110, color: 'var(--text-secondary)' }}>{k}</span>
          <span style={{ flex: 1, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{v}</span>
        </div>
      ))}
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 }}>
        {canFollow
          ? 'Following adds you to the ticket\'s watchers, so you can open it, reply and hear about updates. It is recorded on the ticket.'
          : 'This is the summary Asset Management shows. To see the full ticket, ask the property\'s asset manager or the service desk.'}
      </div>
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
