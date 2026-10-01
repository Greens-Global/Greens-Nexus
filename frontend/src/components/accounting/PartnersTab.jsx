import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Pencil, Search, X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { control } from './reportControls';
import { downloadBlob } from './reportModel';
import { formatDateTime } from '../../lib/datetime';
import { dialog } from '../../ui/dialog';

// Accounting > Vendors & Customers (Charmi and Neil, 10/01: "edit a vendor,
// change all the details and get pushed to manager for approval"). The
// records are Intacct's, read through the accounting app (contract V1);
// Nexus keeps the change requests. Editing a record does not change it: it
// files a request with the fields that differ, a manager approves or
// declines it from the Requests section (the requester gets a bell), and an
// approved change shows on the record as its current values with an
// "Awaiting Intacct" badge until it is keyed into Intacct from the CSV.
// Intacct stays the source of truth, one way.
//
// Until the accounting app ships the partners route (404 -> 501 from the
// backend) the Records section says so; Requests still works.

const KINDS = [{ key: 'vendor', label: 'Vendors' }, { key: 'customer', label: 'Customers' }];
const SECTIONS = [{ key: 'records', label: 'Records' }, { key: 'requests', label: 'Requests' }];
const FIELDS = [
  ['displayName', 'Display Name'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'],
  ['address.line1', 'Address Line 1'], ['address.line2', 'Address Line 2'], ['address.city', 'City'], ['address.state', 'State'], ['address.zip', 'ZIP'], ['address.country', 'Country'],
  ['terms', 'Terms'], ['status', 'Status'], ['taxId', 'Tax ID (last 4)'],
];
const FIELD_LABEL = Object.fromEntries(FIELDS);
const STATUS = {
  pending: { label: 'Pending Approval', fg: '#92400e', bg: 'rgba(180,83,9,0.13)' },
  approved: { label: 'Approved - Awaiting Intacct', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' },
  declined: { label: 'Declined', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
};
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-color)' };
const td = { padding: '5px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', verticalAlign: 'top' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const chip = (s) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: s.fg, background: s.bg, whiteSpace: 'nowrap' });
const getField = (rec, f) => (f.startsWith('address.') ? rec.address?.[f.slice(8)] || '' : rec[f] || '');
const setField = (rec, f, v) => (f.startsWith('address.') ? { ...rec, address: { ...(rec.address || {}), [f.slice(8)]: v } } : { ...rec, [f]: v });

/** The fields whose value differs, as the request carries them. */
export function diffPartner(before, after) {
  const out = {};
  FIELDS.forEach(([f]) => {
    const a = String(getField(before, f) ?? '').trim();
    const b = String(getField(after, f) ?? '').trim();
    if (a !== b) out[f] = { from: a, to: b };
  });
  return out;
}

export default function PartnersTab({ canApprove = false }) {
  const [kind, setKind] = useState('vendor');
  const [section, setSection] = useState('records');
  const [q, setQ] = useState('');
  const [records, setRecords] = useState(null);
  const [recState, setRecState] = useState({ loading: false, error: '', notReady: false });
  const [editing, setEditing] = useState(null);     // { before, after }
  const [requests, setRequests] = useState(null);
  const [reqStatus, setReqStatus] = useState('pending');
  const [busy, setBusy] = useState('');
  const seq = useRef(0);

  const loadRecords = useCallback((k, text) => {
    const mine = ++seq.current;
    setRecState({ loading: true, error: '', notReady: false });
    api.getAccountingPartners(k, text).then((d) => {
      if (mine !== seq.current) return;
      setRecords(d?.partners || []);
      setRecState({ loading: false, error: '', notReady: false });
    }).catch((e) => {
      if (mine !== seq.current) return;
      setRecords([]);
      setRecState({ loading: false, error: e?.status === 501 ? '' : (e?.message || 'Could not load the records.'), notReady: e?.status === 501 });
    });
  }, []);
  const loadRequests = useCallback((status, k) => {
    api.getAccountingPartnerChanges(status, k).then((d) => setRequests(d?.changes || [])).catch(() => setRequests([]));
  }, []);
  useEffect(() => { loadRecords(kind, ''); }, [kind, loadRecords]);
  useEffect(() => { loadRequests(reqStatus, kind); }, [reqStatus, kind, loadRequests]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (records || []).filter((r) => !s || [r.displayName, r.name, r.id, r.email, r.phone, r.entity].some((v) => String(v || '').toLowerCase().includes(s)));
  }, [records, q]);

  async function submitChange(e) {
    e.preventDefault();
    const changes = diffPartner(editing.before, editing.after);
    if (!Object.keys(changes).length) { await dialog.alert('Nothing changed.', { title: 'Change Request' }); return; }
    const note = await dialog.prompt('A note for the approver (optional):', { title: 'Send for Approval', confirmText: 'Send' });
    if (note === null) return;
    setBusy('submit');
    try {
      await api.createAccountingPartnerChange({ kind, partnerId: editing.before.id, partnerName: editing.before.displayName || editing.before.name, changes, note: note || '' });
      setEditing(null);
      loadRecords(kind, '');
      loadRequests(reqStatus, kind);
      setSection('requests');
      setReqStatus('pending');
    } catch (err) { await dialog.alert(err?.message || 'Could not send the request.', { title: 'Change Request' }); }
    setBusy('');
  }

  async function decide(r, decision) {
    const note = await dialog.prompt(decision === 'approve' ? 'Approve this change? A note is optional.' : 'Decline this change? Tell the requester why.', { title: decision === 'approve' ? 'Approve Change' : 'Decline Change', confirmText: decision === 'approve' ? 'Approve' : 'Decline' });
    if (note === null) return;
    setBusy(r.id);
    try { await api.decideAccountingPartnerChange(r.id, decision, note || ''); loadRequests(reqStatus, kind); loadRecords(kind, ''); }
    catch (err) { await dialog.alert(err?.message || 'Could not record the decision.', { title: 'Change Request' }); }
    setBusy('');
  }

  async function exportApproved() {
    setBusy('export');
    try { const { blob, filename } = await api.exportAccountingPartnerChanges('approved', kind); downloadBlob(filename, blob); }
    catch (err) { await dialog.alert(err?.message || 'Could not export.', { title: 'Export' }); }
    setBusy('');
  }

  const kindLabel = kind === 'vendor' ? 'vendor' : 'customer';

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
          {KINDS.map((k) => (
            <button key={k.key} type="button" onClick={() => { setKind(k.key); setEditing(null); }} aria-pressed={kind === k.key}
              style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: kind === k.key ? 700 : 500, border: `1px solid ${kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: kind === k.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
          {SECTIONS.map((s) => (
            <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
              style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
              {s.label}{s.key === 'requests' && reqStatus === 'pending' && requests?.length ? ` (${requests.length})` : ''}
            </button>
          ))}
        </div>
        {section === 'records' ? (
          <form onSubmit={(e) => { e.preventDefault(); loadRecords(kind, q.trim()); }} style={{ position: 'relative', flex: '1 1 220px', maxWidth: 380 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kindLabel}s by name, ID, email`} aria-label={`Search ${kindLabel}s`} style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </form>
        ) : (
          <>
            <select value={reqStatus} onChange={(e) => setReqStatus(e.target.value)} aria-label="Request status" style={control}>
              <option value="pending">Pending Approval</option>
              <option value="approved">Approved - Awaiting Intacct</option>
              <option value="declined">Declined</option>
              <option value="">All</option>
            </select>
            <button type="button" className="secondary-btn" disabled={busy === 'export'} onClick={exportApproved} style={{ marginLeft: 'auto', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export Approved CSV</button>
          </>
        )}
      </div>

      {section === 'records' && (recState.notReady ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: '1rem' }}>Vendors & Customers</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.86rem' }}>Not available yet - the accounting app needs its update. Once it serves the vendor and customer master, the records list here and edits go to a manager for approval.</p>
        </div>
      ) : (
        <AsyncSection loading={records === null} error={!!recState.error} errorMessage={recState.error} onRetry={() => loadRecords(kind, q.trim())} skeleton={<SkeletonBlocks count={2} />}>
          <div style={{ ...card, overflow: 'auto' }}>
            {!shown.length ? (
              <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>No {kindLabel}s{q ? ' match' : ' came back from the ledger'}.</p>
            ) : (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={th}>ID</th><th style={th}>Name</th><th style={th}>Email</th><th style={th}>Phone</th><th style={th}>City</th><th style={th}>Terms</th><th style={th}>Status</th><th style={th}>Entity</th><th style={th}></th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td style={td}>{r.id}</td>
                      <td style={td}>
                        <strong>{r.displayName || r.name}</strong>
                        {r.awaitingIntacct && <span style={{ ...chip(STATUS.approved), marginLeft: 6 }} title={`Approved changes not yet keyed into Intacct: ${Object.keys(r.intacctValues || {}).map((f) => FIELD_LABEL[f] || f).join(', ')}`}>Awaiting Intacct</span>}
                        {r.pendingChange && <span style={{ ...chip(STATUS.pending), marginLeft: 6 }}>Pending Approval</span>}
                      </td>
                      <td style={td}>{r.email}</td><td style={td}>{r.phone}</td><td style={td}>{r.address?.city}</td><td style={td}>{r.terms}</td><td style={td}>{r.status}</td><td style={td}>{r.entity}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button type="button" aria-label={`Edit ${r.displayName || r.name}`} disabled={r.pendingChange} title={r.pendingChange ? 'A change is already waiting for approval' : 'Edit - the change goes to a manager for approval'}
                          onClick={() => setEditing({ before: r, after: { ...r, address: { ...(r.address || {}) } } })}
                          style={{ border: 'none', background: 'none', padding: 4, cursor: r.pendingChange ? 'default' : 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </AsyncSection>
      ))}

      {section === 'requests' && (
        <AsyncSection loading={requests === null} skeleton={<SkeletonBlocks count={2} />}>
          <div style={{ ...card, overflow: 'auto' }}>
            {!requests?.length ? (
              <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>No {reqStatus ? STATUS[reqStatus]?.label.toLowerCase() : ''} requests for {kindLabel}s.</p>
            ) : (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={th}>Record</th><th style={th}>Changes</th><th style={th}>Requested</th><th style={th}>Status</th><th style={th}>Note</th>{canApprove && <th style={th}></th>}</tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td style={td}><strong>{r.partnerName || r.partnerId}</strong><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{r.partnerId}</div></td>
                      <td style={td}>
                        {Object.entries(r.changes || {}).map(([f, v]) => (
                          <div key={f}><span style={{ color: 'var(--text-secondary)' }}>{FIELD_LABEL[f] || f}:</span> <s style={{ color: 'var(--text-muted)' }}>{v.from || '(blank)'}</s> {'->'} <strong>{v.to || '(blank)'}</strong></div>
                        ))}
                      </td>
                      <td style={td}>{r.requestedByName}<div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{formatDateTime(r.requestedAt)}</div></td>
                      <td style={td}><span style={chip(STATUS[r.status] || STATUS.pending)}>{STATUS[r.status]?.label || r.status}</span>{r.decidedByName && <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{r.decidedByName} · {formatDateTime(r.decidedAt)}</div>}</td>
                      <td style={{ ...td, whiteSpace: 'pre-wrap', maxWidth: 260 }}>{r.note}</td>
                      {canApprove && (
                        <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {r.status === 'pending' && (
                            <>
                              <button type="button" className="primary-btn" disabled={busy === r.id} onClick={() => decide(r, 'approve')} style={{ fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 }}><Check size={12} /> Approve</button>
                              <button type="button" className="secondary-btn" disabled={busy === r.id} onClick={() => decide(r, 'decline')} style={{ fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Decline</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </AsyncSection>
      )}

      {editing && (
        <div role="dialog" aria-modal="true" aria-label={`Edit ${editing.before.displayName || editing.before.name}`} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <form onSubmit={submitChange} style={{ ...card, width: 'min(680px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Edit {kind === 'vendor' ? 'Vendor' : 'Customer'} {editing.before.id}</h3>
              <button type="button" aria-label="Close" onClick={() => setEditing(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}><X size={16} /></button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Nothing changes in Intacct from here. The fields you change go to a manager for approval; once approved they show on the record as "Awaiting Intacct" until keyed in.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              {FIELDS.map(([f, lbl]) => (
                <div key={f}>
                  <label htmlFor={`pf-${f}`} style={label}>{lbl}</label>
                  <input id={`pf-${f}`} type="text" value={getField(editing.after, f)} onChange={(e) => setEditing((cur) => ({ ...cur, after: setField(cur.after, f, e.target.value) }))} style={{ ...control, width: '100%' }} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="secondary-btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy === 'submit'}>Send for Approval</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
