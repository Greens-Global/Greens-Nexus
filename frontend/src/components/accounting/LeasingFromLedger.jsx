import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ListFilter, X } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { PopoverPanel, control, usePopover } from './reportControls';
import { POLL_MS, ScanOutcome, ScanProgress, entitiesScannedText, mergeScans, useLedgerScan, useScanRetry } from './LedgerScan';

// MRI -> + Add -> Set Up From the Ledger (Neil and Charmi, 10/02: "Did you
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
// every tenant twice, Oct 2), and the scan is a background job on the API,
// polled every three seconds until the table.
//
// Oct 6 (Charmi: "5 of 279 entities", and slow): the scan reads the ACTIVE
// leaf entities only - the historical (H) ones are skipped like the parents.
//
// Oct 7 (Charmi: most batches timed out, then "No rent postings found ...
// none had one" - false, most entities were never read): the scan has a time
// limit and says what it could not read - "Read 37 of 142 entities - 105
// could not be read" - with Retry for just those; the empty state never
// claims "none had one" while entities were skipped. Rent Accounts picks the
// rent income accounts by hand when their titles do not say rent.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const chip = (tone) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap',
  color: tone === 'ok' ? 'var(--ok-fg, #15803d)' : '#92400e', background: tone === 'ok' ? 'rgba(21,128,61,0.10)' : 'rgba(180,83,9,0.13)' });
const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');
const keyOf = (p) => `${p.entityCode}|${p.customerId}`;

export default function LeasingFromLedger({ onClose, onCreated, pollMs = POLL_MS }) {
  const [accounts, setAccounts] = useState([]);   // rent accounts picked by hand ([] = the title rule)
  const scan = useLedgerScan(() => api.getLeaseProposalsFor({ accounts }), [accounts.join(',')], pollMs);
  const retry = useScanRetry((codes) => api.getLeaseProposalsFor({ entities: codes, accounts }), pollMs);
  const { progress } = scan;
  const data = useMemo(() => mergeScans(scan.data, retry.retries, keyOf), [scan.data, retry.retries]);
  const [error, setError] = useState(null);
  const [unticked, setUnticked] = useState(() => new Set());   // every new row starts ticked; this holds what was unticked
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const shown = error || scan.error;
  const rows = data?.proposals || [];
  const failed = data?.failed || [];
  const fresh = rows.filter((p) => p.status === 'new');
  const ticked = { has: (k) => !unticked.has(k) };
  const count = fresh.filter((p) => ticked.has(keyOf(p))).length;
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pickAccounts = (list) => { retry.reset(); setUnticked(new Set()); setAccounts(list); };
  const create = () => {
    const items = fresh.filter((p) => ticked.has(keyOf(p))).map((p) => ({ entityCode: p.entityCode, customerId: p.customerId }));
    if (!items.length) return;
    setBusy(true);
    setError(null);
    api.createLeasesFromLedger(accounts.length ? { items, accounts } : { items })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e); setBusy(false); });
  };
  const read = data ? (data.entitiesRead ?? (data.entitiesScanned ?? 0) - failed.length) : 0;
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
          {!done && <RentAccountsPicker value={accounts} onChange={pickAccounts} lookedFor={data?.lookedFor} />}
          {shown && (notAvailable(shown)
            ? <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>Not available here.</strong> The accounting service is not connected on this environment, so there is no ledger to read tenants from. Use New Lease.</div>
            : (
              <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flex: 1 }}>{shown.message || 'Could not read the ledger.'}</span>
                {scan.error && <button type="button" className="secondary-btn" onClick={scan.retry} style={{ fontSize: '0.76rem' }}>Try Again</button>}
              </div>
            ))}
          {data && !done && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{entitiesScannedText(data)}</div>}
          {data && !done && <ScanOutcome total={data.entitiesScanned ?? 0} failed={failed} onRetry={retry.run} running={retry.running} error={retry.error} />}
          {progress ? <ScanProgress progress={progress} /> : scan.error ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} {done.created.length === 1 ? 'lease' : 'leases'} set up{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={keyOf(p)}>{p.tenantName} at {p.entityName} - <Amount value={p.monthlyRent} /> a month from {monthLabel(p.firstMonth)}</div>)}
              {done.skipped.map((p) => <div key={keyOf(p)} style={{ color: 'var(--text-muted)' }}>{p.customerId} at {p.entityCode}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            shown && notAvailable(shown) ? null : (
              <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
                <strong style={{ color: 'var(--text-primary)' }}>{failed.length ? 'No rent postings found in the entities that were read.' : 'No rent postings found.'}</strong>
                <span>
                  {accounts.length ? `Looked for postings to account ${accounts.join(', ')}` : `Looked for income accounts whose title says ${(data.lookedFor || ['Rent', 'Rental', 'Lease']).join(', ')}`} in {read} {read === 1 ? 'active entity' : 'active entities'}
                  {failed.length ? ` (${failed.length} more could not be read - Retry them above before deciding)` : ''};
                  {data.entitiesWithRentAccounts
                    ? ` ${data.entitiesWithRentAccounts} had one (${(data.rentAccounts || []).map((a) => `${a.code} ${a.title}`).join(', ')}) but no customer posted to it in this window.`
                    : failed.length ? ' none of those had one.' : ' none had one.'}
                </span>
                <span>Pick the rent accounts above if their titles say something else, post rent in Intacct with the tenant as the customer, or add the lease by hand with New Lease.</span>
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

// Rent Accounts (Charmi, 10/07): the rent income accounts picked by hand, any
// income account with activity in the window - nothing picked = the title
// rule (Rent / Rental / Lease / Tenant). Applied with Done, so the scan does
// not start over at every tick.
export function RentAccountsPicker({ value, onChange, lookedFor }) {
  const [open, setOpen, ref] = usePopover();
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState('');
  const [draft, setDraft] = useState(value);
  const [find, setFind] = useState('');
  useEffect(() => {
    if (!open || list) return undefined;
    let alive = true;
    api.getLeaseIncomeAccounts()
      .then((d) => { if (alive) { setList(d?.accounts || []); setFailed(d?.error || ''); } })
      .catch((e) => { if (alive) { setList([]); setFailed(e?.message || 'Could not read the income accounts.'); } });
    return () => { alive = false; };
  }, [open, list]);
  const openIt = () => { setDraft(value); setFind(''); setOpen((v) => !v); };
  const chosen = new Set(draft);
  const s = find.trim().toLowerCase();
  const shown = (list || []).filter((a) => !s || a.code.toLowerCase().includes(s) || (a.title || '').toLowerCase().includes(s));
  const toggle = (code) => setDraft((d) => (d.includes(code) ? d.filter((c) => c !== code) : [...d, code]));
  const text = !value.length ? `Rent Accounts: By Title (${(lookedFor || ['Rent', 'Rental', 'Lease', 'Tenant']).join(', ')})` : `Rent Accounts: ${value.join(', ')}`;
  const on = value.length > 0;
  return (
    <div ref={ref} style={{ position: 'relative', justifySelf: 'start' }}>
      <button type="button" onClick={openIt} aria-haspopup="listbox" aria-expanded={open} aria-label="Rent accounts" title={text}
        style={{ ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 520, whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: on ? 600 : 400 }}>
        <ListFilter size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} role="listbox" aria-label="Rent accounts" aria-multiselectable="true"
        style={{ width: 420, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 }}>
        <input type="text" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an income account by number or title" aria-label="Find an income account" autoFocus style={{ ...control, width: '100%' }} />
        <div style={{ maxHeight: 'min(420px, calc(100vh - 260px))', overflowY: 'auto', marginTop: 6, display: 'grid', gap: 1 }}>
          {list === null ? <SkeletonBlocks count={2} /> : (
            <>
              {shown.map((a) => (
                <button key={a.code} type="button" role="option" aria-selected={chosen.has(a.code)} onClick={() => toggle(a.code)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', borderRadius: 6, background: chosen.has(a.code) ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}>
                  <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{chosen.has(a.code) ? <Check size={14} /> : null}</span>
                  <span className="acct-code">{a.code}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                  {a.rent && <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>By Title</span>}
                </button>
              ))}
              {!shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>{failed || (list.length ? 'No match.' : 'No income account has activity in the last twelve months.')}</div>}
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
          <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setDraft([])}>Use Titles</button>
          <span style={{ flex: 1, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{draft.length ? `${draft.length} picked` : 'Nothing picked: the titles decide.'}</span>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => { setOpen(false); if (draft.join(',') !== value.join(',')) onChange([...draft].sort()); }}>Done</button>
        </div>
      </PopoverPanel>
    </div>
  );
}
