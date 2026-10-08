import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Search, X } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { EntityPicker, control } from './reportControls';
import { POLL_MS, ScanProgress, entitiesScannedText, useLedgerScan } from './LedgerScan';
import { EgnyteField, folderName, useBackdropClose } from './LoanDialogs';

// + Add > From the Ledger (was "Set Up From the Ledger"): the proposals,
// ticked and created. The scan is a background job on the API (Oct 2: 145 s
// live), polled until the table.
//
// Oct 6 (Charmi, 10/04: "it reads 279 entities"): only ACTIVE entities are
// read - the historical (H) ones are left out unless Customize > Show
// historical entities is on - and only the entities picked on the Loans
// screen, when any are; as of TODAY (the screen's date), not a month end.
// Loans already paid off (nothing owed) are not proposed; intercompany
// payables are.
//
// Oct 7 (Charmi: "there should be a select all option and we can toggle
// based on our needs" - 80 rows, each pre-ticked, was 80 clicks):
//   - nearly full screen, so entity names stop wrapping to three lines;
//   - a header checkbox (Select All / None, part-ticked when some are) that
//     acts on the rows SHOWN - so "only External" is: filter Kind External,
//     tick the header;
//   - quick filters: Kind (External / Intercompany), Status (New / Set Up /
//     Removed), entity, and a search box (entity, GL, title, lender);
//   - only External loans start ticked (intercompany ones are often working
//     capital - the wrong loans of item 44 got in because everything was);
//   - loans removed under Loans (trash) are not offered again unless Show
//     Removed is on; ticking one sets it up again;
//   - the Documents / Statements folders can be wired per row now, or later
//     under Change Loan;
//   - the button keeps the live count and is disabled at 0.

const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const KIND = { external: 'External', intercompany: 'Intercompany', given: 'Loan Given' };
// Item 46 #7: no "Debit Balance" wording - the figure is the plain Balance,
// and a liability that is overpaid says so in plain words on hover.
export const DEBIT_NOTE = 'More has been paid on this account than is owed (a debit balance on a liability) - shown as a positive figure. Check the account is classified right.';
const keyOf = (p) => `${p.entityCode}|${p.glAccount}`;
const selectable = (p) => p.status === 'new' || p.status === 'dismissed';

export function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    wait: { fg: '#92400e', bg: 'rgba(180,83,9,0.13)' }, brand: { fg: 'var(--wk-brand, #2b45e1)', bg: 'var(--wk-brand-tint, #e8ecfd)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}

/** Which rows start ticked: the new External ones (Charmi, Oct 7 default). */
export function defaultPicked(rows = []) {
  return new Set(rows.filter((p) => p.status === 'new' && p.kind !== 'intercompany').map(keyOf));
}

/** The rows the filters let through. */
export function filterProposals(rows = [], { kind = 'all', status = 'all', entity = '', text = '', showRemoved = false } = {}) {
  const q = text.trim().toLowerCase();
  return rows.filter((p) => (showRemoved || p.status !== 'dismissed')
    && (kind === 'all' || (kind === 'intercompany') === (p.kind === 'intercompany'))
    && (status === 'all' || p.status === status)
    && (!entity || p.entityCode === entity)
    && (!q || [p.entityName, p.entityCode, p.glAccount, p.title, p.lender].some((v) => String(v || '').toLowerCase().includes(q))));
}

function Segment({ label, value, options, onChange }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</span>
      {options.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)} className={value === k ? 'primary-btn' : 'secondary-btn'}
          style={{ fontSize: '0.74rem', height: 26, padding: '0 10px' }}>{l}</button>
      ))}
    </div>
  );
}

function HeaderCheck({ shown, picked, onChange }) {
  const ref = useRef(null);
  const n = shown.filter((p) => picked.has(keyOf(p))).length;
  const all = shown.length > 0 && n === shown.length;
  const some = n > 0 && !all;
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return (
    <input ref={ref} type="checkbox" checked={all} disabled={!shown.length} aria-checked={some ? 'mixed' : all}
      aria-label={all ? 'Select none of the loans shown' : 'Select all the loans shown'} onChange={() => onChange(!all)} />
  );
}

function FoldersDialog({ row, value, onSave, onClose }) {
  const [docs, setDocs] = useState(value?.docsPath || '');
  const [statements, setStatements] = useState(value?.statementsPath || '');
  const backdrop = useBackdropClose(onClose);
  return createPortal(
    <div className="modal-overlay" role="presentation" {...backdrop} style={{ zIndex: 520 }}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Loan Folders" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Loan Folders</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{row.title} - {row.entityName}. Optional: they can be wired later under Change Loan.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12 }}>
          <EgnyteField id="setup-docs" labelText="Documents Folder" value={docs} onChange={setDocs} />
          <EgnyteField id="setup-statements" labelText="Statements Folder" value={statements} onChange={setStatements} />
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => onSave({ docsPath: docs.trim(), statementsPath: statements.trim() })}>Use These Folders</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function LoanSetupDialog({ asof, entities = [], entityLabel = '', historical = false, onClose, onCreated, pollMs = POLL_MS }) {
  const scan = useLedgerScan(() => api.getLoanProposalsAsOf({ asof, entities, historical }), [asof, entities.join(','), historical], pollMs);
  const { data, progress, retry } = scan;
  const backdrop = useBackdropClose(onClose);
  const [error, setError] = useState('');
  // What is ticked belongs to the answer it was ticked on; a new answer starts
  // from the default (the new External loans).
  const [sel, setSel] = useState({ for: null, keys: new Set() });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [entity, setEntity] = useState('');
  const [text, setText] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [folders, setFolders] = useState({});        // key -> { docsPath, statementsPath }
  const [editing, setEditing] = useState(null);      // the row whose folders are being picked
  const scanError = scan.error ? (scan.error.message || 'Could not read the ledger.') : '';
  const rows = useMemo(() => data?.proposals || [], [data]);
  const picked = sel.for === data ? sel.keys : defaultPicked(rows);
  const setPicked = (fn) => setSel({ for: data, keys: fn(picked) });
  const shown = useMemo(() => filterProposals(rows, { kind, status, entity, text, showRemoved }), [rows, kind, status, entity, text, showRemoved]);
  const shownSelectable = shown.filter(selectable);
  // The entities the scan proposed loans on, for the module's entity picker
  // (Oct 7, item 12: search by number, code on the left).
  const entityList = useMemo(() => [...new Map(rows.map((p) => [p.entityCode, p.entityName])).entries()].map(([code, name]) => ({ code, name })), [rows]);
  const removedCount = rows.filter((p) => p.status === 'dismissed').length;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !editing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const toggle = (k) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const tickShown = (on) => setPicked((s) => { const n = new Set(s); shownSelectable.forEach((p) => (on ? n.add(keyOf(p)) : n.delete(keyOf(p)))); return n; });
  // Only what can be created counts: a ticked row hidden by Show Removed is not sent.
  const chosen = rows.filter((p) => selectable(p) && picked.has(keyOf(p)) && (showRemoved || p.status !== 'dismissed'));
  const count = chosen.length;
  const create = () => {
    const items = chosen.map((p) => ({ entityCode: p.entityCode, glAccount: p.glAccount, ...(folders[keyOf(p)] || {}) }));
    if (!items.length) return;
    setBusy(true);
    setError('');
    api.createLoansFromLedger({ asof, entities: entities.join(','), historical, items })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e?.message || 'Could not create the loans.'); setBusy(false); });
  };
  const where = entities.length ? entityLabel || `${entities.length} entities` : 'every active entity you may read';

  return createPortal(
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Add loans from the ledger"
        style={{ maxWidth: 'min(1480px, 96vw)', width: '96vw', height: '92vh', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Add Loans From the Ledger</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Liability accounts that look like loans on the balance sheet as of {formatDate(data?.asOf || asof)}, across {where}{historical ? ' (historical entities included)' : ''}. Nothing is typed: the balance is read from the ledger.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '12px 24px 6px', display: 'grid', gap: 10, alignContent: 'start', flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
              {removedCount && !showRemoved ? ` · ${removedCount} removed under Loans not offered` : ''}
            </div>
          )}
          {progress ? <ScanProgress progress={progress} /> : scanError ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} {done.created.length === 1 ? 'loan' : 'loans'} set up{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={keyOf(p)}>{p.lender || p.title} - {p.entityName}, GL {p.glAccount}, <Amount value={p.balance} /></div>)}
              {done.skipped.map((p) => <div key={keyOf(p)} style={{ color: 'var(--text-muted)' }}>{p.entityCode} GL {p.glAccount}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
              <strong style={{ color: 'var(--text-primary)' }}>No loan-like liability accounts found.</strong>
              <span>Looked at {data.liabilityAccounts ?? 0} liability {data.liabilityAccounts === 1 ? 'account' : 'accounts'} across {data.entitiesScanned ?? 0} {data.entitiesScanned === 1 ? 'entity' : 'entities'} for a title that says {(data.lookedFor || []).join(', ')}.</span>
              <span>If a loan sits on an account named differently, add it with + Add &gt; Manual and wire its principal account under Change Loan.</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <div style={{ position: 'relative' }}>
                  <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
                  <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search entity, GL, title, lender" aria-label="Search the proposed loans" style={{ ...control, width: 240, paddingLeft: 24 }} />
                </div>
                <Segment label="Kind" value={kind} onChange={setKind} options={[['all', 'All'], ['external', 'External'], ['intercompany', 'Intercompany']]} />
                <Segment label="Status" value={status} onChange={setStatus} options={[['all', 'All'], ['new', 'New'], ['set_up', 'Set Up'], ...(showRemoved ? [['dismissed', 'Removed']] : [])]} />
                <EntityPicker entities={entityList} value={entity} onChange={setEntity} noneLabel="All Entities" showHistorical />

                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', cursor: 'pointer' }}>
                  <input type="checkbox" data-nx-filter="1" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show Removed{removedCount ? ` (${removedCount})` : ''}
                </label>
                <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{shown.length} of {rows.length} shown · <strong>{count}</strong> ticked</span>
              </div>
              <div className="req-table-wrapper" style={{ overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ width: 30 }}><HeaderCheck shown={shownSelectable} picked={picked} onChange={tickShown} /></th>
                      <th>Entity</th><th>GL Account</th><th>Title</th><th style={num}>Balance</th><th>Lender</th><th>Kind</th><th>Type</th><th>Status</th><th>Folders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!shown.length && <tr><td colSpan={10} style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>No proposed loan matches the filters.</td></tr>}
                    {shown.map((p) => {
                      const k = keyOf(p);
                      const f = folders[k];
                      const nFolders = [f?.docsPath, f?.statementsPath].filter(Boolean).length;
                      return (
                        <tr key={k} style={p.status === 'set_up' ? { color: 'var(--text-muted)' } : undefined}>
                          <td>{selectable(p) ? <input type="checkbox" data-nx-filter="1" checked={picked.has(k)} onChange={() => toggle(k)} aria-label={`Create ${p.title} on ${p.entityName}`} /> : null}</td>
                          <td style={{ minWidth: 220 }}>{p.entityName} <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{p.entityCode}</span></td>
                          <td>{p.glAccount}</td><td style={{ minWidth: 220 }}>{p.title}</td>
                          <td style={num} title={p.debitBalance ? DEBIT_NOTE : undefined}><Amount value={Math.abs(p.balance)} />{p.debitBalance ? <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}> *</span> : null}</td>
                          <td>{p.lender || <span style={{ color: 'var(--text-muted)' }}>unknown - type it after</span>}</td>
                          <td><Chip tone={p.kind === 'intercompany' ? 'muted' : 'brand'}>{KIND[p.kind] || p.kind}</Chip></td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.76rem' }}>{p.loanType === 'line_of_credit' ? 'Line of Credit' : 'Term Loan'}</td>
                          <td>{p.status === 'set_up' ? <Chip tone="ok">Set Up</Chip> : p.status === 'dismissed' ? <Chip tone="muted" title={p.removedBy ? `Removed by ${p.removedBy}${p.removedAt ? ` on ${formatDate(p.removedAt)}` : ''} - tick it to set it up again` : 'Tick it to set it up again'}>Removed</Chip> : <Chip tone="wait">New</Chip>}</td>
                          <td>
                            {selectable(p) && (
                              <button type="button" className="secondary-btn" onClick={() => setEditing(p)} aria-label={`Folders of ${p.title} on ${p.entityName}`} title={nFolders ? [f.docsPath, f.statementsPath].filter(Boolean).map(folderName).join(', ') : 'Wire the Egnyte folders now (optional)'}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', height: 24, padding: '0 8px' }}>
                                <FolderOpen size={12} /> {nFolders ? `${nFolders} Set` : 'Add'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={done ? onCreated : onClose}>{done ? 'Done' : 'Cancel'}</button>
          {!done && rows.length > 0 && <button type="button" className="primary-btn" disabled={busy || !count} onClick={create}>{busy ? 'Creating...' : `Create ${count} ${count === 1 ? 'Loan' : 'Loans'}`}</button>}
        </div>
      </div>
      {editing && (
        <FoldersDialog row={editing} value={folders[keyOf(editing)]} onClose={() => setEditing(null)}
          onSave={(v) => { setFolders((m) => ({ ...m, [keyOf(editing)]: v })); setEditing(null); }} />
      )}
    </div>,
    document.body,
  );
}
