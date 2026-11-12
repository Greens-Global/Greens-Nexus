// The Job's Changes tab (Neil, 11/03/2026, plan phase 3 "Extra Work Signed on
// Site"). Field Tickets: time and material written and signed on site
// (FieldTicketSheet - works with no signal). Change Orders: a job manager
// prices a signed ticket (or writes one), names the owner or client who
// signs, and - when someone inside the company must approve first - an
// approver, who finds it in their Approvals inbox. Sending makes ONE Nexus
// Sign envelope; the signature moves the job's contract value and target
// finish (the server, once). Money shows only to the people who may see the
// contract value; the crew sees their field tickets.
import { useMemo, useState } from 'react';
import { Plus, FileSignature, Send, Check, Undo2, X } from 'lucide-react';
import { api } from '../../api';
import { useRole } from '../../contexts/RoleContext';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { dialog } from '../../ui/dialog';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CARD, TONE, personName } from '../ui';
import Empty from '../Empty';
import { clientId, useLoad } from '../lib/job';
import { loadChanges } from '../constructionOffline';
import FieldTicketSheet from './FieldTicketSheet';
import { formatHoursWords } from '../../lib/hoursText';

const CO_STATUS = {
  draft: { label: 'Draft', color: TONE.slate },
  awaiting_approval: { label: 'Awaiting Approval', color: TONE.yellow },
  sent: { label: 'Sent', color: TONE.blue },
  signed: { label: 'Signed', color: TONE.green },
  declined: { label: 'Declined', color: TONE.red },
  void: { label: 'Void', color: TONE.gray },
};
const TICKET_STATUS = {
  open: { label: 'Not Signed', color: TONE.slate },
  signed: { label: 'Signed', color: TONE.green },
  priced: { label: 'Priced', color: TONE.blue },
  void: { label: 'Void', color: TONE.gray },
};

const money = (v) => {
  const n = Number(v || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const days = (n) => (n ? `${n > 0 ? '+' : ''}${n} day${Math.abs(n) === 1 ? '' : 's'}` : 'No schedule change');
const quiet = { fontSize: 13, color: 'var(--text-secondary)' };
const small = { padding: '6px 12px', fontSize: 13, minHeight: 36 };

function COSheet({ project, data, from, co, onClose, onSaved }) {
  const signed = (data.fieldTickets || []).filter((t) => t.status === 'signed');
  const [ticket, setTicket] = useState(from?.id || '');
  const src = signed.find((t) => t.id === ticket) || from || null;
  const [f, setF] = useState(() => ({
    title: co?.title || (src ? (src.description || '').split('\n')[0].slice(0, 120) : ''),
    reason: co?.reason || 'owner_request', description: co?.description || src?.description || '',
    amount: co ? String(co.amount) : '', schedule_impact_days: co ? String(co.scheduleImpactDays || 0) : '0',
    approver_email: co?.approverEmail || '',
    // Round Three (11/11/2026): a new one defaults to the job's client contact.
    signer_name: co ? (co.signerName || '') : (src?.customerName || project.clientContactName || ''),
    signer_email: co ? (co.signerEmail || '') : (src?.customerEmail || project.clientContactEmail || ''),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const approvers = [...new Set(project.managerEmails || [])];
  const save = async () => {
    setBusy(true); setError('');
    const body = { ...f, amount: Number(f.amount || 0), schedule_impact_days: parseInt(f.schedule_impact_days || '0', 10) || 0 };
    try {
      if (co) await api.updateChangeOrder(co.id, body);
      else await api.createChangeOrder(project.id, { ...body, id: clientId('co'), ...(ticket ? { field_ticket_id: ticket } : {}) });
      onSaved();
    } catch (e) { setError(e.message || 'Could not save the change order.'); setBusy(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content nx-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Change Order"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{co ? `Change Order ${co.number}` : 'New Change Order'}</h3>
          <button className="secondary-btn" onClick={onClose} aria-label="Close" style={{ padding: 8 }}><X size={16} /></button>
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{error}</div>}
        <div className="nx-scroll nx-fill" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {!co && (
            <label className="form-label">From a Field Ticket
              <select className="form-input" value={ticket} onChange={(e) => setTicket(e.target.value)}>
                <option value="">None - write it from scratch</option>
                {signed.map((t) => <option key={t.id} value={t.id}>{t.number} · {formatDate(t.workDate, t.workDate)} · {(t.description || '').slice(0, 50)}</option>)}
              </select>
            </label>
          )}
          <label className="form-label">Title<input className="form-input" value={f.title} onChange={set('title')} placeholder="e.g. Move the gas line" /></label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <label className="form-label">Reason
              <select className="form-input" value={f.reason} onChange={set('reason')}>
                {(data.reasons || []).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </label>
            <label className="form-label">Amount ($)<input className="form-input" type="number" step="0.01" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="e.g. 4200" /></label>
            <label className="form-label">Schedule Impact (Days)<input className="form-input" type="number" step="1" value={f.schedule_impact_days} onChange={set('schedule_impact_days')} /></label>
          </div>
          <label className="form-label">Description<textarea className="form-input" rows={4} value={f.description} onChange={set('description')} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <label className="form-label">Owner or Client Who Signs<input className="form-input" value={f.signer_name} onChange={set('signer_name')} placeholder="Their name" /></label>
            <label className="form-label">Their Email<input className="form-input" type="email" value={f.signer_email} onChange={set('signer_email')} placeholder="Where Nexus Sign sends it" /></label>
          </div>
          <label className="form-label">Approve Inside the Company First (optional)
            <select className="form-input" value={f.approver_email} onChange={set('approver_email')}>
              <option value="">No one - send it straight to the owner</option>
              {approvers.map((e) => <option key={e} value={e}>{personName(e, project.names)}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : 'Save Draft'}</button>
        </div>
      </div>
    </div>
  );
}

function COCard({ co, data, me, onChanged, onEdit, canPrice }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const st = CO_STATUS[co.status] || CO_STATUS.draft;
  const act = (k, fn) => async () => { setBusy(k); setError(''); try { await fn(); onChanged(); } catch (e) { setError(e.message || 'Could not do that.'); } setBusy(''); };
  const isApprover = co.approverEmail && co.approverEmail === me && co.status === 'awaiting_approval';
  const ticket = (data.fieldTickets || []).find((t) => t.id === co.fieldTicketId);
  return (
    <div data-change-order={co.id} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{co.number} {co.title}</b>
        <StatusLabel size="sm" label={st.label} color={st.color} />
        <span style={{ flex: 1 }} />
        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money(co.amount)}</b>
      </div>
      <div style={quiet}>
        {[co.reasonLabel, days(co.scheduleImpactDays), co.signerName ? `Signer ${co.signerName}` : 'No signer yet',
          co.approverName ? `Approver ${co.approverName}` : '', ticket ? `From ${ticket.number}` : ''].filter(Boolean).join(' · ')}
      </div>
      {co.status === 'signed' && (
        <div style={quiet}>Signed {formatDateTime(co.signedAt, '')}: contract {money(co.contractBefore)} to {money(co.contractAfter)}
          {co.finishBefore && co.finishAfter !== co.finishBefore ? `, target finish ${formatDate(co.finishBefore, '')} to ${formatDate(co.finishAfter, '')}` : ''}</div>
      )}
      {co.declineReason && ['declined', 'draft'].includes(co.status) && <div style={quiet}>{co.status === 'draft' ? 'Sent back' : 'Declined'}: {co.declineReason}</div>}
      {error && <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canPrice && co.status === 'draft' && <button className="secondary-btn" style={small} onClick={() => onEdit(co)}>Edit</button>}
        {canPrice && co.status === 'draft' && (
          <button className="primary-btn" style={small} disabled={!!busy} onClick={act('send', () => api.sendChangeOrder(co.id))}>
            <Send size={13} />{co.approverEmail && !co.approvedAt ? 'Send for Approval' : 'Send for Signature'}
          </button>
        )}
        {isApprover && (
          <>
            <button className="primary-btn" style={small} disabled={!!busy} onClick={act('approve', () => api.approveChangeOrder(co.id))}><Check size={13} />Approve</button>
            <button className="secondary-btn" style={small} disabled={!!busy} onClick={act('back', async () => {
              const note = await dialog.prompt('What should change before it is sent again?', { title: 'Send Back', confirmText: 'Send Back', required: true });
              if (!note) throw new Error('Not sent back - a note is needed.');
              return api.sendBackChangeOrder(co.id, note);
            })}><Undo2 size={13} />Send Back</button>
          </>
        )}
        {canPrice && ['draft', 'awaiting_approval', 'sent'].includes(co.status) && (
          <HoldButton label="Void" doneLabel="Voided" icon={X} holdMs={HOLD_RECORD_MS} size="sm"
            onConfirm={() => api.voidChangeOrder(co.id, 'voided by the job manager').then(onChanged)}
            fallbackMessage={`Void ${co.number}? An open signing request is voided too.`} />
        )}
      </div>
    </div>
  );
}

export default function ChangesTab({ project }) {
  const { myEmail } = useRole();
  const me = String(myEmail || '').toLowerCase();
  const { data, error, reload } = useLoad(() => loadChanges(project.id), project.id);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [coOpen, setCoOpen] = useState(null);     // { from } | { co } | {}
  const tickets = data?.fieldTickets || [];
  const cos = useMemo(() => data?.changeOrders || [], [data]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={3} height={80} borderRadius={12} />;
  const t = data.totals;

  return (
    <div>
      {data.canPrice && t && (
        <section style={{ ...CARD, marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }} aria-label="Contract">
          {[['Contract Value', money(data.contractValue)], ['Approved Changes', money(t.signed)], ['Pending Changes', money(t.pending)],
            ['Forecast', money((data.contractValue || 0) + (t.pending || 0))]].map(([k, v]) => (
            <div key={k}><div style={quiet}>{k}</div><div style={{ fontWeight: 700, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>
          ))}
          {data.targetFinishOn && <div><div style={quiet}>Target Finish</div><div style={{ fontWeight: 700 }}>{formatDate(data.targetFinishOn, '')}</div></div>}
        </section>
      )}

      <section style={{ ...CARD, marginBottom: 14 }} aria-label="Field Tickets">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: 18, margin: 0 }}>Field Tickets</h3>
          <span style={{ flex: 1 }} />
          {data.canWrite && <button className="primary-btn" onClick={() => setTicketOpen(true)}><Plus size={14} />New Field Ticket</button>}
        </div>
        <p style={{ ...quiet, margin: '0 0 12px' }}>Extra work, signed by the customer on site. Quantities only - a manager prices it as a change order.</p>
        {tickets.length === 0 ? <Empty icon={FileSignature} title="No field tickets" hint="When the customer asks for extra work, write it up here and have them sign on the phone." /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tickets.map((tk) => {
              const st = TICKET_STATUS[tk.status] || TICKET_STATUS.open;
              return (
                <div key={tk.id} data-field-ticket={tk.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{tk.number} · {formatDate(tk.workDate, tk.workDate)}</div>
                    <div style={{ ...quiet, overflowWrap: 'anywhere' }}>{tk.description}</div>
                    <div style={quiet}>{[tk.laborHours ? `${formatHoursWords(tk.laborHours, { compact: true })} labor` : '', tk.materials.length ? `${tk.materials.length} material${tk.materials.length === 1 ? '' : 's'}` : '',
                      tk.photoUrls.length ? `${tk.photoUrls.length} photo${tk.photoUrls.length === 1 ? '' : 's'}` : '', tk.signedName ? `Signed by ${tk.signedName}` : ''].filter(Boolean).join(' · ')}</div>
                  </div>
                  {tk.signatureUrl && <img src={tk.signatureUrl} alt={`Signature of ${tk.signedName}`} style={{ height: 34, background: '#fff', borderRadius: 4, border: '1px solid var(--border-color)' }} />}
                  <StatusLabel size="sm" label={st.label} color={st.color} />
                  {data.canPrice && tk.status === 'signed' && (
                    <button className="secondary-btn" style={small} onClick={() => setCoOpen({ from: tk })}>Price It</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data.canPrice && (
        <section style={CARD} aria-label="Change Orders">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h3 style={{ fontSize: 18, margin: 0 }}>Change Orders</h3>
            <span style={{ flex: 1 }} />
            <button className="secondary-btn" onClick={() => setCoOpen({})}><Plus size={14} />New Change Order</button>
          </div>
          {cos.length === 0 ? <Empty icon={FileSignature} title="No change orders" hint="Price a signed field ticket, or write a change order from scratch. The owner signs it in Nexus Sign." /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cos.map((co) => <COCard key={co.id} co={co} data={data} me={me} canPrice={data.canPrice} onChanged={reload} onEdit={(c) => setCoOpen({ co: c })} />)}
            </div>
          )}
        </section>
      )}

      {ticketOpen && <FieldTicketSheet project={project} today={data.today} onClose={() => setTicketOpen(false)} onSent={() => { setTicketOpen(false); reload(); }} />}
      {coOpen && <COSheet project={project} data={data} from={coOpen.from} co={coOpen.co} onClose={() => setCoOpen(null)} onSaved={() => { setCoOpen(null); reload(); }} />}
    </div>
  );
}
