import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { POLL_MS, ScanProgress, entitiesScannedText, useLedgerScan } from './LedgerScan';

// + Add > From the Ledger (was "Set Up From the Ledger"): the proposals,
// ticked and created. The scan is a background job on the API (Oct 2: 145 s
// live), polled until the table.
//
// Oct 6 (Charmi, 10/04: "it reads 279 entities"): only ACTIVE entities are
// read - the historical (H) ones are left out unless Customize > Show
// historical entities is on - and only the entities picked on the Loans
// screen, when any are; as of TODAY (the screen's date), not a month end.
// Loans already paid off (nothing owed) are not proposed; intercompany
// payables are. A liability with a debit balance shows as a positive figure
// with a note on hover, not a chip.

const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const KIND = { external: 'External', intercompany: 'Intercompany', given: 'Loan Given' };
export const DEBIT_NOTE = 'This liability carries a debit balance on the ledger (more paid in than owed); shown as a positive figure.';

export function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    wait: { fg: '#92400e', bg: 'rgba(180,83,9,0.13)' }, brand: { fg: 'var(--wk-brand, #2b45e1)', bg: 'var(--wk-brand-tint, #e8ecfd)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}

export default function LoanSetupDialog({ asof, entities = [], entityLabel = '', historical = false, onClose, onCreated, pollMs = POLL_MS }) {
  const scan = useLedgerScan(() => api.getLoanProposalsAsOf({ asof, entities, historical }), [asof, entities.join(','), historical], pollMs);
  const { data, progress, retry } = scan;
  const [error, setError] = useState('');
  const [unticked, setUnticked] = useState(() => new Set());   // every new row starts ticked; this holds what was unticked
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const scanError = scan.error ? (scan.error.message || 'Could not read the ledger.') : '';
  const rows = data?.proposals || [];
  const fresh = rows.filter((p) => p.status === 'new');
  const ticked = { has: (k) => !unticked.has(k) };
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const create = () => {
    const items = fresh.filter((p) => ticked.has(`${p.entityCode}|${p.glAccount}`)).map((p) => ({ entityCode: p.entityCode, glAccount: p.glAccount }));
    if (!items.length) return;
    setBusy(true);
    setError('');
    api.createLoansFromLedger({ asof, entities: entities.join(','), historical, items })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e?.message || 'Could not create the loans.'); setBusy(false); });
  };
  const count = fresh.filter((p) => ticked.has(`${p.entityCode}|${p.glAccount}`)).length;
  const where = entities.length ? entityLabel || `${entities.length} entities` : 'every active entity you may read';
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Add loans from the ledger" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Add Loans From the Ledger</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Liability accounts that look like loans on the balance sheet as of {formatDate(data?.asOf || asof)}, across {where}{historical ? ' (historical entities included)' : ''}. Nothing is typed: the balance is read from the ledger.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
          {error && <div style={bad}>{error}</div>}
          {scanError && (
            <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1 }}>{scanError}</span>
              <button type="button" className="secondary-btn" onClick={retry} style={{ fontSize: '0.76rem' }}>Try Again</button>
            </div>
          )}
          {(data?.notes || []).length > 0 && <div style={{ fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' }}>{data.notes.join(' · ')} - open again to retry.</div>}
          {data && !done && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              {entitiesScannedText(data)} · {data.liabilityAccounts ?? 0} liability {data.liabilityAccounts === 1 ? 'account' : 'accounts'}
              {data.paidOff ? ` · ${data.paidOff} paid off (nothing owed) left out` : ''}
            </div>
          )}
          {progress ? <ScanProgress progress={progress} /> : scanError ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} {done.created.length === 1 ? 'loan' : 'loans'} set up{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={`${p.entityCode}|${p.glAccount}`}>{p.lender || p.title} - {p.entityName}, GL {p.glAccount}, <Amount value={p.balance} /></div>)}
              {done.skipped.map((p) => <div key={`${p.entityCode}|${p.glAccount}`} style={{ color: 'var(--text-muted)' }}>{p.entityCode} GL {p.glAccount}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
              <strong style={{ color: 'var(--text-primary)' }}>No loan-like liability accounts found.</strong>
              <span>Looked at {data.liabilityAccounts ?? 0} liability {data.liabilityAccounts === 1 ? 'account' : 'accounts'} across {data.entitiesScanned ?? 0} {data.entitiesScanned === 1 ? 'entity' : 'entities'} for a title that says {(data.lookedFor || []).join(', ')}.</span>
              <span>If a loan sits on an account named differently, add it with + Add &gt; Manual and wire its principal account under Change Loan.</span>
            </div>
          ) : (
            <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr><th style={{ width: 30 }} /><th>Entity</th><th>GL Account</th><th>Title</th><th style={num}>Balance</th><th>Lender</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((p) => {
                    const k = `${p.entityCode}|${p.glAccount}`;
                    return (
                      <tr key={k} style={p.status === 'set_up' ? { color: 'var(--text-muted)' } : undefined}>
                        <td>{p.status === 'new' ? <input type="checkbox" checked={ticked.has(k)} onChange={() => toggle(k)} aria-label={`Create ${p.title} on ${p.entityName}`} /> : null}</td>
                        <td>{p.entityName}</td><td>{p.glAccount}</td><td>{p.title}</td>
                        <td style={num} title={p.debitBalance ? DEBIT_NOTE : undefined}><Amount value={Math.abs(p.balance)} />{p.debitBalance ? <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}> *</span> : null}</td>
                        <td>{p.lender || <span style={{ color: 'var(--text-muted)' }}>unknown - type it after</span>}</td>
                        <td><Chip tone={p.kind === 'intercompany' ? 'muted' : 'brand'}>{KIND[p.kind] || p.kind}</Chip></td>
                        <td>{p.status === 'set_up' ? <Chip tone="ok">Set Up</Chip> : <Chip tone="wait">New</Chip>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={done ? onCreated : onClose}>{done ? 'Done' : 'Cancel'}</button>
          {!done && rows.length > 0 && <button type="button" className="primary-btn" disabled={busy || !count} onClick={create}>{busy ? 'Creating...' : `Create ${count} ${count === 1 ? 'Loan' : 'Loans'}`}</button>}
        </div>
      </div>
    </div>
  );
}
