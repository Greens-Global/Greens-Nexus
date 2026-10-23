import { useState, useEffect, useCallback } from 'react';
import { X, Send, Eye } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { ErrorBanner, SkeletonBlocks, Spinner } from './AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { moneyPrefix } from '../asset/lib/currency';

// Contractor invoices (Oct 21): an India contractor's invoice is drafted when
// their Time Sheet is finalized; HR previews it here and clicks Approve & Send,
// which emails it to the company's Contractor Invoice Recipients with the
// contractor in cc. The time card shows the same invoice in a small card.

export const INVOICE_STATUS = {
  draft: { label: 'Awaiting Approval', bg: 'rgba(180,83,9,0.12)', color: '#b45309' },
  sent:  { label: 'Sent', bg: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' },
  void:  { label: 'Voided', bg: 'var(--wk-hover)', color: 'var(--muted)' },
};
export const money = (n, cur = 'INR') => `${moneyPrefix(cur)}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatusChip({ status }) {
  const s = INVOICE_STATUS[status] || { label: status, bg: 'var(--wk-hover)', color: 'var(--muted)' };
  return <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>;
}

// The PDF in a modal iframe (PacketReview's DocPreview): fetched as a blob
// through api - the endpoint is bearer-authenticated, so a bare link 401s.
export function InvoicePdfModal({ id, title, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let made = '';
    api.contractorInvoicePdf(id)
      .then(({ blob }) => { made = URL.createObjectURL(blob); setUrl(made); })
      .catch(e => { toastErr?.(e?.message || 'Could not open the invoice.'); onClose(); });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', height: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 800, fontSize: 14 }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {url ? <iframe title={title} src={url} style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px' }} />
          : <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>}
      </div>
    </div>
  );
}

// The small card under Time Sheet Review & Signature on a contractor's card.
// HR (canSend from the server - the Invoices tab's rule) sends a draft right
// here too: after the signature this card had only Preview, so the send
// looked missing (Oct 23).
export function InvoiceCard({ invoice, toastOk, toastErr, onSent }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const inv = invoice || null;
  const canSend = inv?.status === 'draft' && !!inv.canSend;
  const noRecipients = canSend && !(inv.recipients || []).length;
  async function send() {
    const to = inv.recipients.join(', ');
    const ok = await dialog.confirm(`Email invoice ${inv.number} (${money(inv.amount, inv.currency)}) to ${to}, with ${inv.employeeName || 'the contractor'} in cc?`, { title: 'Approve & Send', confirmText: 'Approve & Send' });
    if (!ok) return;
    setSending(true);
    try {
      const r = await api.contractorInvoiceSend(inv.id);
      toastOk?.(r.emailed ? `Invoice ${inv.number} sent to ${to}` : `Invoice ${inv.number} recorded - email is not configured here`);
      onSent?.();
    } catch (e) { toastErr?.(e?.message || 'Could not send the invoice.'); }
    finally { setSending(false); }
  }
  const text = !inv ? 'Drafted when this period is finalized.'
    : inv.status === 'draft' ? `Invoice ${inv.number} - ${money(inv.amount, inv.currency)} - Awaiting HR approval`
    : inv.status === 'sent' ? `Invoice ${inv.number} - ${money(inv.amount, inv.currency)} - Sent ${formatDateTime(inv.sentAt)}`
    : 'Voided (period reopened)';
  const btn = inv?.status === 'draft' ? 'Preview PDF' : inv?.status === 'sent' ? 'Open PDF' : '';
  return (
    <div data-testid="invoice-card" style={{ border: '1px solid var(--wk-line2)', borderRadius: 14, padding: '12px 16px', margin: '10px 0 14px', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 3 }}>Invoice</div>
        <span style={{ color: inv ? 'var(--ink)' : 'var(--muted)' }}>{text}</span>
      </div>
      {btn && <button type="button" className="secondary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12.5 }}>{btn}</button>}
      {canSend && (
        <button type="button" className="primary-btn" onClick={send} disabled={sending || noRecipients}
          title={noRecipients ? `No recipients set for ${inv.companyName || 'this company'} - add Contractor Invoice Recipients in Settings > Companies.` : undefined}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: noRecipients ? 0.55 : 1 }}>
          {sending ? <Spinner size={13} /> : <Send size={13} />} Approve &amp; Send
        </button>
      )}
      {open && <InvoicePdfModal id={inv.id} title={`Invoice ${inv.number}`} onClose={() => setOpen(false)} toastErr={toastErr} />}
    </div>
  );
}

const FILTERS = [['draft', 'Awaiting Approval'], ['sent', 'Sent'], ['all', 'All']];
const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 13, verticalAlign: 'middle' };

// HR's list: People > Time > Invoices. onChanged tells the tab band to recount drafts.
export default function ContractorInvoices({ toastOk, toastErr, onChanged }) {
  const [filter, setFilter] = useState('draft');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setError('');
    return api.contractorInvoices(filter)
      .then(r => setRows(r.invoices || []))
      .catch(e => { setError(e?.message || 'Could not load invoices.'); setRows([]); });
  }, [filter]);
  useEffect(() => { setRows(null); load(); }, [load]);

  async function send(inv) {
    const to = (inv.recipients || []).join(', ');
    const ok = await dialog.confirm(`Email invoice ${inv.number} (${money(inv.amount, inv.currency)}) to ${to}, with ${inv.employeeName || inv.employeeEmail} in cc?`, { title: 'Approve & Send', confirmText: 'Approve & Send' });
    if (!ok) return;
    setBusy(inv.id);
    try {
      const r = await api.contractorInvoiceSend(inv.id);
      toastOk?.(r.emailed ? `Invoice ${inv.number} sent to ${to}` : `Invoice ${inv.number} recorded - email is not configured here`);
      await load();
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not send the invoice.'); }
    finally { setBusy(''); }
  }

  return (
    <div>
      <div role="tablist" aria-label="Invoice status" style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 8, background: 'var(--wk-hover)', marginBottom: 14 }}>
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13, fontWeight: 600,
              background: filter === k ? 'var(--wk-card)' : 'transparent', color: filter === k ? 'var(--wk-ink)' : 'var(--wk-dim)', boxShadow: filter === k ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
            {l}
          </button>
        ))}
      </div>
      {error && <div style={{ marginBottom: 12 }}><ErrorBanner message={error} onRetry={load} /></div>}
      {rows === null && <SkeletonBlocks count={3} height={48} />}
      {rows !== null && rows.length === 0 && !error && (
        <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12 }}>No invoices yet.</div>
      )}
      {rows?.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Contractor', 'Company', 'Period', 'Invoice #', 'Amount', 'Status', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map(inv => {
                const noRecipients = !(inv.recipients || []).length;
                return (
                  <tr key={inv.id}>
                    <td style={td}><div style={{ fontWeight: 600 }}>{inv.employeeName || inv.employeeEmail}</div><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{inv.employeeEmail}</div></td>
                    <td style={td}>{inv.companyName || '-'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDate(inv.periodStart)} - {formatDate(inv.periodEnd)}</td>
                    <td style={td}>{inv.number}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{money(inv.amount, inv.currency)}</td>
                    <td style={td}><StatusChip status={inv.status} />{inv.status === 'sent' && inv.sentAt && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{formatDateTime(inv.sentAt)}</div>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                        <button type="button" className="secondary-btn" onClick={() => setPreview(inv)} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eye size={13} /> Preview</button>
                        {inv.status === 'draft' && (
                          <button type="button" className="primary-btn" disabled={noRecipients || busy === inv.id} onClick={() => send(inv)}
                            title={noRecipients ? `No recipients set for ${inv.companyName || 'this company'} - add Contractor Invoice Recipients in Settings > Companies.` : `To: ${(inv.recipients || []).join(', ')}`}
                            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: noRecipients ? 0.55 : 1 }}>
                            <Send size={13} /> Approve & Send
                          </button>
                        )}
                      </div>
                      {inv.status === 'draft' && noRecipients && (
                        <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 4, whiteSpace: 'normal', maxWidth: 260, textAlign: 'right' }}>
                          No recipients set for {inv.companyName || 'this company'} - add Contractor Invoice Recipients in Settings &gt; Companies.
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {preview && <InvoicePdfModal id={preview.id} title={`Invoice ${preview.number}`} onClose={() => setPreview(null)} toastErr={toastErr} />}
    </div>
  );
}
