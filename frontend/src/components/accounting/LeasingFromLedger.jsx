import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { POLL_MS, ScanProgress, entitiesScannedText, useLedgerScan } from './LedgerScan';

// MRI -> Leasing -> Set Up From the Ledger (Neil and Charmi, 10/02: "Did you
// work on ... MRI at all?" - production had no leases, so the rent roll was
// empty). A tenant is an Intacct customer and rent received is what posted
// to the lease's income accounts for that customer, so the ledger already
// knows the tenants: for every entity you may read, the income accounts
// titled Rent / Rental / Lease, the customers who posted to them in the last
// twelve months, and the month-by-month amounts. One lease is proposed per
// (entity, customer): tenant = the customer, property = the entity, monthly
// rent = the most common amount of the last three posted months, start = the
// first posted month. Tick + Create writes the leases the way New Lease does.
// A customer already on an active lease for that entity is shown as set up.
// Only LEAF entities are scanned (a parent rolls its children up and proposed
// every tenant twice, Oct 2), and the scan is a background job on the API
// (305 s live): polled every three seconds until the table.
//
// Oct 6 (Charmi: "5 of 279 entities", and slow): the scan reads the ACTIVE
// leaf entities only - the historical (H) ones are skipped like the parents
// - and in a few dozen reads instead of hundreds, so the progress bar counts
// what is actually read. The table is banded with a hover like the rent roll.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const chip = (tone) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap',
  color: tone === 'ok' ? 'var(--ok-fg, #15803d)' : '#92400e', background: tone === 'ok' ? 'rgba(21,128,61,0.10)' : 'rgba(180,83,9,0.13)' });
const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');
const keyOf = (p) => `${p.entityCode}|${p.customerId}`;

export default function LeasingFromLedger({ onClose, onCreated, pollMs = POLL_MS }) {
  const scan = useLedgerScan(() => api.getLeaseProposals(), [], pollMs);
  const { data, progress, retry } = scan;
  const [error, setError] = useState(null);
  const [unticked, setUnticked] = useState(() => new Set());   // every new row starts ticked; this holds what was unticked
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const shown = error || scan.error;
  const rows = data?.proposals || [];
  const fresh = rows.filter((p) => p.status === 'new');
  const ticked = { has: (k) => !unticked.has(k) };
  const count = fresh.filter((p) => ticked.has(keyOf(p))).length;
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const create = () => {
    const items = fresh.filter((p) => ticked.has(keyOf(p))).map((p) => ({ entityCode: p.entityCode, customerId: p.customerId }));
    if (!items.length) return;
    setBusy(true);
    setError(null);
    api.createLeasesFromLedger({ items })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e); setBusy(false); });
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Set up leases from the ledger" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Set Up From the Ledger</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Customers who posted to a rent income account in the last twelve months{data?.from ? ` (${monthLabel(data.from)} to ${monthLabel(data.to)})` : ''}, one lease each. The rent is the most common amount of the last three posted months; change it after if the lease says otherwise.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
          {shown && (notAvailable(shown)
            ? <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>Not available here.</strong> The accounting service is not connected on this environment, so there is no ledger to read tenants from. Use New Lease.</div>
            : (
              <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flex: 1 }}>{shown.message || 'Could not read the ledger.'}</span>
                {scan.error && <button type="button" className="secondary-btn" onClick={retry} style={{ fontSize: '0.76rem' }}>Try Again</button>}
              </div>
            ))}
          {(data?.notes || []).length > 0 && <div style={{ fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' }}>{data.notes.join(' · ')} - open again to retry.</div>}
          {data && !done && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{entitiesScannedText(data)}{data.historicalSkipped ? `; ${data.historicalSkipped} historical (H) ${data.historicalSkipped === 1 ? 'entity' : 'entities'} not read` : ''}</div>}
          {progress ? <ScanProgress progress={progress} /> : scan.error ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} {done.created.length === 1 ? 'lease' : 'leases'} set up{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={keyOf(p)}>{p.tenantName} at {p.entityName} - <Amount value={p.monthlyRent} /> a month from {monthLabel(p.firstMonth)}</div>)}
              {done.skipped.map((p) => <div key={keyOf(p)} style={{ color: 'var(--text-muted)' }}>{p.customerId} at {p.entityCode}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            shown && notAvailable(shown) ? null : (
              <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
                <strong style={{ color: 'var(--text-primary)' }}>No rent postings found.</strong>
                <span>
                  Looked for income accounts whose title says {(data.lookedFor || ['Rent', 'Rental', 'Lease']).join(', ')} in {data.entitiesScanned ?? 0} {data.entitiesScanned === 1 ? 'active entity' : 'active entities'};
                  {data.entitiesWithRentAccounts ? ` ${data.entitiesWithRentAccounts} had one (${(data.rentAccounts || []).map((a) => `${a.code} ${a.title}`).join(', ')}) but no customer posted to it in this window.` : ' none had one.'}
                </span>
                <span>Post rent in Intacct to an income account named that way, with the tenant as the customer, or add the lease by hand with New Lease.</span>
              </div>
            )
          ) : (
            <div className="acct-lines-wrap">
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead><tr><th style={{ width: 30 }} /><th>Property (Entity)</th><th>Tenant (Customer)</th><th>Income Accounts</th><th style={num}>Monthly Rent</th><th>First Posted</th><th style={num}>Months Posted</th><th style={num}>Received (12 Mo)</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((p) => {
                    const k = keyOf(p);
                    return (
                      <tr key={k} style={p.status === 'set_up' ? { color: 'var(--text-muted)' } : undefined}>
                        <td>{p.status === 'new' ? <input type="checkbox" checked={ticked.has(k)} onChange={() => toggle(k)} aria-label={`Create a lease for ${p.tenantName} at ${p.entityName}`} /> : null}</td>
                        <td>{p.entityName}</td>
                        <td><div>{p.tenantName}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{p.customerId}</div></td>
                        <td title={(p.accountTitles || []).join(', ')}>{(p.incomeAccounts || []).join(', ')}</td>
                        <td style={num}><Amount value={p.monthlyRent} /></td>
                        <td>{monthLabel(p.firstMonth)}</td>
                        <td style={num}>{p.postedMonths}</td>
                        <td style={num}><Amount value={p.received12} /></td>
                        <td>{p.status === 'set_up' ? <span style={chip('ok')}>Set Up</span> : <span style={chip('wait')}>New</span>}</td>
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
          {!done && rows.length > 0 && <button type="button" className="primary-btn" disabled={busy || !count} onClick={create}>{busy ? 'Creating...' : `Create ${count} ${count === 1 ? 'Lease' : 'Leases'}`}</button>}
        </div>
      </div>
    </div>
  );
}
