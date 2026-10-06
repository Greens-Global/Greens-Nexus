// The asset manager's side of property tickets (Pranshu, 10/06):
//   Needs Action      - resolved tickets not yet in the maintenance record, each
//                       with Add to Maintenance Record.
//   Add to record     - the Maintenance Record form, prefilled from the ticket,
//                       WITHOUT a status (logging it is the sign-off: the ticket
//                       closes). On the original ticket only: Next Service Due
//                       and how often it repeats - that starts a recurring service.
//   Recurring Services - each service as its parent ticket with every child it
//                       opened underneath, date and cost for each, and a total.
// Writes go through the property ticket endpoints (backend property_tickets.py);
// nothing here writes the Asset Management workspace.
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api } from '../../../api.js';
import { formatDate } from '../../../lib/datetime.js';
import { filesFromPaste } from '../../../tasks/lib';
import { uploadTicketEvidence } from '../../../tickets/evidenceUpload';
import { TICKET_STATUS, money } from '../../lib/propertyTickets.js';
import { currencyOptions, formatTotals } from '../../lib/currency.js';
import { readSchedule } from '../../lib/maintenanceLog.js';
import { StatusBadge } from '../shared/StatusBadge.jsx';
import { EmptyState } from '../shared/EmptyState.jsx';
import { Modal } from '../shared/Modal.jsx';

const UNITS = [['', 'One Time'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
const todayYmd = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const localYmd = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const repeatsLabel = (unit, every) => (!unit ? 'One Time'
  : `Every ${Number(every) > 1 ? `${every} ` : ''}${({ week: 'Week', month: 'Month', year: 'Year' })[unit]}${Number(every) > 1 ? 's' : ''}`);

const readOnlyBox = { fontSize: '0.85rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'not-allowed', display: 'flex', alignItems: 'center' };

const Field = ({ label, req, full, children }) => (
  <div className={full ? 'form-group form-group-full' : 'form-group'}>
    <label>{label}{req && <span style={{ color: 'hsl(var(--color-red))' }}> *</span>}</label>
    {children}
  </div>
);

/** A native select that reads as a dropdown (chevron) in every theme. */
function Dropdown({ value, onChange, children, style, ...rest }) {
  return (
    <div style={{ position: 'relative', ...style }}>
      <select className="form-input" value={value} onChange={onChange} {...rest}
        style={{ fontSize: '0.85rem', width: '100%', appearance: 'none', WebkitAppearance: 'none', paddingRight: 30, cursor: 'pointer' }}>
        {children}
      </select>
      <ChevronDown size={15} aria-hidden="true"
        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }} />
    </div>
  );
}

/** Next Service Due + how often it repeats - shared by the record form and Edit Schedule. */
function ScheduleFields({ value, onChange, optional = true }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const unitLabel = UNITS.find(([v]) => v === value.unit)?.[1] || '';
  return (<>
    <Field label="Next Service Due" req={!optional}>
      <input type="date" className="form-input" min={todayYmd()} value={value.nextDue || ''}
        onChange={(e) => set('nextDue', e.target.value)} style={{ fontSize: '0.85rem' }} />
    </Field>
    <Field label="Repeats">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {value.unit && (<>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Every</span>
          {/* A string while typing, so it can be cleared and retyped; checked on save. */}
          <input type="text" inputMode="numeric" className="form-input" value={value.every ?? ''} aria-label="Repeat every"
            onChange={(e) => set('every', e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
            style={{ fontSize: '0.85rem', width: 60, textAlign: 'center' }} />
        </>)}
        <Dropdown value={value.unit || ''} onChange={(e) => set('unit', e.target.value)} style={{ flex: 1 }} aria-label="Repeats">
          {UNITS.map(([v, l]) => <option key={v} value={v}>{v ? (value.unit ? l : `Every ${l.replace(/s$/, '')}`) : l}</option>)}
        </Dropdown>
      </div>
    </Field>
    {value.unit && !value.nextDue && (
      <div className="form-group form-group-full" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: -6 }}>
        Pick the Next Service Due - it repeats every {value.every || 'N'} {unitLabel.toLowerCase()} from that date.
      </div>
    )}
    {value.nextDue && (
      <div className="form-group form-group-full" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: -6 }}>
        You are reminded 15 days before. If no ticket is opened by {formatDate(value.nextDue)}, one opens
        automatically with these details{value.unit ? `, and the next one is scheduled ${repeatsLabel(value.unit, value.every || 1).toLowerCase()} after that` : ''}.
      </div>
    )}
  </>);
}

export function AddToMaintenanceModal({ propertyId, t, onClose, onSaved }) {
  const isChild = !!t.parentTicketId;
  // Service Date and System / Area come from the ticket (its resolve day, its
  // category) - shown, not editable; the server derives them the same way.
  const serviceDate = localYmd(t.resolvedAt) || todayYmd();
  const [v, setV] = useState({
    description: t.resolutionNote ? `${t.subject} - ${t.resolutionNote}` : t.subject,
    vendor: t.vendor || '', cost: t.cost || '', currency: 'USD', notes: '',
  });
  const [schedule, setSchedule] = useState({ nextDue: '', unit: '', every: 1 });
  const [doc, setDoc] = useState(null);              // { name, url, status }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const dirty = !!(v.notes || doc || schedule.nextDue);

  const attach = (file) => {
    if (!file) return;
    setDoc({ name: file.name, url: '', status: 'uploading' });
    uploadTicketEvidence(file, 'invoice')
      .then((url) => setDoc({ name: file.name, url, status: 'done' }))
      .catch(() => setDoc({ name: file.name, url: '', status: 'failed' }));
  };
  const save = async () => {
    setErr('');
    const sched = isChild ? {} : readSchedule(schedule);
    if (sched.error) { setErr(sched.error); return; }
    if (doc?.status === 'uploading') { setErr('The invoice is still uploading.'); return; }
    if (doc?.status === 'failed') { setErr('The invoice did not upload - remove it or attach it again.'); return; }
    setBusy(true);
    try {
      await api.addMaintenanceRecord(propertyId, t.id, {
        description: v.description.trim(), vendor: v.vendor.trim(), cost: v.cost.trim(), currency: v.currency,
        notes: v.notes.trim(), doc_url: doc?.url || '', doc_name: doc?.name || '', ...sched,
      });
      onSaved();
    } catch (e) { setErr(e.message || 'Could not add it to the maintenance record.'); setBusy(false); }
  };

  return (
    <Modal title={`Add to Maintenance Record · ${t.codeLabel}`} onClose={onClose} isDirty={dirty} footer={<>
      <button className="secondary-btn" onClick={onClose}>Cancel</button>
      <button className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Add to Maintenance Record'}</button>
    </>}>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        <b style={{ color: 'var(--text-primary)' }}>{t.subject}</b>
        {t.assigneeName ? ` · worked by ${t.assigneeName}` : ''}{t.resolvedAt ? ` · resolved ${formatDate(t.resolvedAt)}` : ''}.
        Adding it closes the ticket.
      </div>
      <div className="form-grid" onPaste={(e) => { const f = filesFromPaste(e); if (f.length) { e.preventDefault(); attach(f[0]); } }}>
        <Field label="Service Date">
          <div className="form-input" style={readOnlyBox} title="From the ticket - the day it was resolved">{formatDate(serviceDate)}</div>
        </Field>
        <Field label="System / Area">
          <div className="form-input" style={readOnlyBox} title="From the ticket's category">{t.system || 'General Repair'}</div>
        </Field>
        <Field label="Work Performed" full>
          <textarea className="form-input" rows={2} value={v.description} onChange={set('description')} maxLength={2000} style={{ fontSize: '0.85rem' }} />
        </Field>
        <Field label="Contractor / Vendor">
          <input className="form-input" value={v.vendor} onChange={set('vendor')} maxLength={200} style={{ fontSize: '0.85rem' }} />
        </Field>
        <Field label="Cost">
          <div style={{ display: 'flex', gap: 6 }}>
            <Dropdown value={v.currency} onChange={set('currency')} style={{ flex: '0 0 104px' }} aria-label="Currency" title="Currency">
              {currencyOptions().map((c) => <option key={c.code} value={c.code} title={c.label}>{c.code}</option>)}
            </Dropdown>
            <input className="form-input" inputMode="decimal" placeholder="0.00" value={v.cost} onChange={set('cost')} style={{ fontSize: '0.85rem', flex: 1 }} aria-label="Cost" />
          </div>
        </Field>
        {isChild ? (
          <div className="form-group form-group-full" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Opened by a recurring service - its next date is set on the original ticket ({t.parentCodeLabel || 'Recurring Services'}).
          </div>
        ) : (
          <ScheduleFields value={schedule} onChange={setSchedule} />
        )}
        <Field label="Invoice / Report (Upload)" full>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label className="secondary-btn" style={{ cursor: 'pointer' }}>
              Upload File
              <input type="file" style={{ display: 'none' }} onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {doc ? (
              <span style={{ fontSize: '0.8rem', color: doc.status === 'failed' ? 'hsl(var(--color-red))' : 'var(--text-secondary)' }}>
                {doc.name}{doc.status === 'uploading' ? ' - uploading…' : doc.status === 'failed' ? ' - did not upload' : ''}
                <button type="button" onClick={() => setDoc(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', marginLeft: 6 }}>Remove</button>
              </span>
            ) : <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>or press Ctrl+V to paste a screenshot</span>}
          </div>
        </Field>
        <Field label="Notes" full>
          <textarea className="form-input" rows={2} value={v.notes} onChange={set('notes')} maxLength={2000} style={{ fontSize: '0.85rem' }} />
        </Field>
      </div>
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: '0.8rem', marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

export function NeedsActionPanel({ data, onOpen, onAdd }) {
  const rows = data?.needsAction || [];
  if (!rows.length) return <EmptyState>Nothing waiting. Resolved tickets at this property land here to be added to the maintenance record.</EmptyState>;
  return rows.map((t) => {
    const [sLabel, sTone] = TICKET_STATUS[t.status] || [t.status, 'mut'];
    return (
      <div key={t.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 8, border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-card)' }}>
        <button type="button" onClick={() => onOpen(t)} style={{ flex: '1 1 260px', textAlign: 'left', border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{t.codeLabel}</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t.subject}</span>
            <StatusBadge tone={sTone}>{sLabel}</StatusBadge>
            {t.parentTicketId && <StatusBadge tone="blue">Recurring Service</StatusBadge>}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            {[t.category, t.onParcel ? `Parcel: ${t.propertyName}` : '', t.resolvedAt ? `Resolved ${formatDate(t.resolvedAt)}` : '',
              t.vendor, t.cost ? money(t.cost) : ''].filter(Boolean).join(' · ')}
          </div>
          {t.resolutionNote && <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginTop: 4 }}>{t.resolutionNote}</div>}
        </button>
        {data?.canManage && <button className="primary-btn" onClick={() => onAdd(t)}>Add to Maintenance Record</button>}
      </div>
    );
  });
}

function EditScheduleModal({ propertyId, svc, onClose, onSaved }) {
  const [value, setValue] = useState({ nextDue: svc.nextDue, unit: svc.recurrenceUnit, every: svc.recurrenceEvery });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    const sched = readSchedule(value);
    if (sched.error) { setErr(sched.error); return; }
    setBusy(true); setErr('');
    try {
      await api.updateMaintenanceService(propertyId, svc.id, {
        next_due: sched.next_service_due, recurrence_unit: sched.recurrence_unit, recurrence_every: sched.recurrence_every,
        ...(svc.active ? {} : { active: true }),
      });
      onSaved();
    } catch (e) { setErr(e.message || 'Could not save the schedule.'); setBusy(false); }
  };
  return (
    <Modal title={`${svc.active ? 'Edit' : 'Restart'} Schedule · ${svc.subject}`} onClose={onClose} footer={<>
      <button className="secondary-btn" onClick={onClose}>Cancel</button>
      <button className="primary-btn" onClick={save} disabled={busy || !value.nextDue}>{busy ? 'Saving…' : 'Save Schedule'}</button>
    </>}>
      <div className="form-grid"><ScheduleFields value={value} onChange={setValue} optional={false} /></div>
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: '0.8rem', marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

export function RecurringServicesPanel({ propertyId, data, onOpen, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const services = data?.services || [];
  const all = [...(data?.open || []), ...(data?.history || [])];
  if (!services.length) {
    return <EmptyState>No recurring services yet. When you add a resolved ticket to the maintenance record, set its Next Service Due to schedule the next one.</EmptyState>;
  }
  const act = async (key, fn) => {
    setBusy(key); setErr('');
    try { await fn(); onChanged(); } catch (e) { setErr(e.message || 'That did not work.'); }
    setBusy('');
  };
  const th = { textAlign: 'left', padding: '6px 10px', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.03em' };
  const td = { padding: '8px 10px', fontSize: '0.82rem', color: 'var(--text-primary)', borderTop: '1px solid var(--border-color)' };
  return (<>
    {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: '0.8rem', marginBottom: 8 }}>{err}</div>}
    {services.map((s) => (
      <div key={s.id} style={{ border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-card)', marginBottom: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{s.subject}</span>
              <StatusBadge tone={s.active ? 'green' : 'mut'}>{s.active ? s.recurrenceLabel : 'Stopped'}</StatusBadge>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
              {s.system} · from {s.parentCodeLabel}
              {s.active ? ` · Next service ${formatDate(s.nextDue)}` : ''} · Total {formatTotals(s.totals) || '$0.00'}
            </div>
          </div>
          {data?.canManage && (<>
            {s.active && <button className="secondary-btn" disabled={busy === s.id}
              onClick={() => act(s.id, () => api.openMaintenanceServiceNow(propertyId, s.id))}>Open Ticket Now</button>}
            <button className="secondary-btn" onClick={() => setEditing(s)}>{s.active ? 'Edit Schedule' : 'Restart'}</button>
            {s.active && <button className="secondary-btn" disabled={busy === s.id}
              onClick={() => act(s.id, () => api.updateMaintenanceService(propertyId, s.id, { active: false }))}>Stop</button>}
          </>)}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Ticket</th><th style={th}>Date</th><th style={th}>Status</th><th style={th}>Vendor</th><th style={{ ...th, textAlign: 'right' }}>Cost</th></tr></thead>
            <tbody>
              {s.tickets.map((r) => {
                const [sLabel, sTone] = TICKET_STATUS[r.status] || [r.status, 'mut'];
                const row = all.find((x) => x.id === r.id);
                return (
                  <tr key={r.id}>
                    <td style={{ ...td, paddingLeft: r.isParent ? 10 : 30 }}>
                      <button type="button" onClick={() => row && onOpen(row)} style={{ border: 'none', background: 'none', padding: 0, cursor: row ? 'pointer' : 'default', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 'inherit', textAlign: 'left' }}>
                        {r.isParent ? '' : '↳ '}<b>{r.codeLabel}</b> {r.isParent ? '(Original)' : ''}
                      </button>
                    </td>
                    <td style={td}>{formatDate(r.date) || '-'}</td>
                    <td style={td}><StatusBadge tone={r.logged ? 'green' : sTone}>{r.logged ? 'Recorded' : sLabel}</StatusBadge></td>
                    <td style={td}>{r.vendor || '-'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{money(r.cost, r.currency) || '-'}</td>
                  </tr>
                );
              })}
              <tr><td style={{ ...td, fontWeight: 600 }} colSpan={4}>Total</td><td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{formatTotals(s.totals) || '$0.00'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    ))}
    {editing && <EditScheduleModal propertyId={propertyId} svc={editing} onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); onChanged(); }} />}
  </>);
}
