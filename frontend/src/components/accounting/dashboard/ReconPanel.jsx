import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileUp, Paperclip } from 'lucide-react';
import { api } from '../../../api';
import { fmtMDY, mEnd, monthLong, mStart } from '../../../accounting/dashboard/model/months';
import { formatDateTime } from '../../../lib/datetime';
import { DateField } from '../../../tasks/components';
import { safeFileName, uploadToSupabase } from '../../../investor/lib/upload';
import SidePanel, { PanelSection } from '../SidePanel';
import EntryDetail from '../EntryDetail';
import { requestReportDrill } from '../drill';
import { BAD, Chip, OK, input, num } from './Bits';
import { useDash } from './DashContext';
import { loanIdOf } from './liabilityRecon';

// One account of the reconciliation list opened on the right (Charmi, 10/25,
// item 08: "Need to have the ability to drill down"), the list still beside
// it - Viral's BusAcTa two-way open: Open Full widens the panel over the whole
// screen, and the account's own report (Bank / Credit Card Activity, else the
// General Ledger on Reports) opens as a full page. The panel shows the
// account's status and its ledger lines for the dashboard's month; an entry
// number opens the journal entry.
//
// A mortgage, loan or line of credit (item 09; Neil, 10/25: "Intacct doesn't
// have it. Should do in Nexus.") also gets the month's reconciliation: the
// statement's ending balance against the ledger balance on the statement
// date, Mark Reconciled only at a 0.00 difference, an optional statement PDF,
// and Reopen for Accounting admins. Saved in Nexus only - never sent to
// Intacct.

const LINES = 500;
const money2 = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const parseAmount = (s) => {
  const t = String(s ?? '').replace(/[$,\s]/g, '');
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t);
  const v = Number(t.replace(/[()]/g, ''));
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
};
const statusTone = (s) => (s === 'Reconciled' ? 'ok' : s === 'Difference' || s === 'Behind' ? 'bad' : 'wait');
const lbl = { fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 };
const factGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 };

function Fact({ label, children, color }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '0.92rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color }}>{children}</div>
    </div>
  );
}

/** Where the row's status comes from, in words. */
function sourceText(r) {
  if (r.source === 'intacct') return `Intacct · ${r.intacctRef}${r.intacctMatch === 'gl' ? ' (matched on the GL account; Intacct gave it no entity)' : ''}`;
  if (r.source === 'nexus') return 'Reconciled in Nexus';
  if (r.source === 'mark') return r.mark ? `Marked in Nexus by ${r.mark.marked_by}` : 'Marked in Nexus';
  if (r.key?.startsWith('gl:')) return r.intacctOther ? `No Intacct bank record at this entity (Intacct has ${r.intacctOther} at another entity)` : 'No Intacct bank record';
  return r.liability ? 'Not reconciled in Nexus yet' : '-';
}

export default function ReconPanel({ row, entityName, fullLink, onNavigate, canEdit, canManage, onSaved, onClose }) {
  const { period, book, m } = useDash();
  const [entry, setEntry] = useState(null);
  const [dirty, setDirty] = useState(false);
  const loanId = loanIdOf(row.key);
  const close = () => {
    if (dirty && !window.confirm('Discard the reconciliation you typed?')) return;
    onClose();
  };
  // Escape closes the panel - not while a journal entry is open on top of it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || entry) return;
      if (dirty && !window.confirm('Discard the reconciliation you typed?')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, dirty, onClose]);

  const openReports = () => requestReportDrill({ account: row.gl, accountName: row.name, from: mStart(period), to: mEnd(period), entity: row.entityCode || '' });
  const caption = [entityName, row.gl ? `GL ${row.gl}` : '', monthLong(period)].filter(Boolean).join(' · ');
  return (
    <>
      <SidePanel label="Account reconciliation" title={row.name} caption={caption} badges={<Chip tone={statusTone(row.status)}>{row.status}</Chip>} onClose={close}
        footer={(
          <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {fullLink ? <button type="button" className="secondary-btn" onClick={() => onNavigate(fullLink)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExternalLink size={13} /> {row.type === 'Credit Card' ? 'Open Credit Card Activity' : 'Open Bank Activity'}</button>
              : row.gl ? <button type="button" className="secondary-btn" onClick={openReports} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExternalLink size={13} /> Open in Reports</button> : null}
            <button type="button" className="secondary-btn" onClick={close}>Close</button>
          </div>
        )}>
        <PanelSection title="Status" caption={sourceText(row)}>
          <div style={factGrid}>
            <Fact label="Last Reconciled">{row.thru ? fmtMDY(row.thru) : row.key?.startsWith('gl:') && row.source !== 'intacct' && !row.mark ? 'No Intacct record' : 'Never'}</Fact>
            <Fact label="Reconciled Balance">{row.thru ? m(row.stmt, { cents: true }) : '-'}</Fact>
            <Fact label="Current Balance">{m(row.book, { cents: true })}</Fact>
            <Fact label="Difference" color={Math.abs(row.diff) >= 0.005 ? BAD : undefined}>{Math.abs(row.diff) >= 0.005 ? m(row.diff, { cents: true }) : '-'}</Fact>
          </div>
        </PanelSection>
        {loanId ? <LiabilityRecon loanId={loanId} period={period} canEdit={canEdit} canManage={canManage} onDirty={setDirty} onSaved={onSaved} /> : null}
        {row.gl ? <LedgerLines gl={row.gl} entity={row.entityCode} period={period} book={book} onOpenEntry={setEntry} />
          : <PanelSection title="Ledger Lines" caption="This account has no GL account, so there are no ledger lines to show."><span /></PanelSection>}
      </SidePanel>
      {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
    </>
  );
}

// ── The account's ledger lines for the month ────────────────────────────────
function LedgerLines({ gl, entity, period, book, onOpenEntry }) {
  // The answer carries the query it belongs to; another query reads as loading.
  const ask = [gl, entity || '', period, book || 'accrual'].join('|');
  const [got, setGot] = useState({ ask: null, error: '', data: null });
  useEffect(() => {
    let live = true;
    api.searchAccountingLedger({ account: gl, location: entity || '', from: mStart(period), to: mEnd(period), book: book || 'accrual', offset: 0, limit: LINES })
      .then((d) => { if (live) setGot({ ask, error: '', data: d }); })
      .catch((e) => { if (live) setGot({ ask, error: e?.message || 'Could not read the ledger lines.', data: null }); });
    return () => { live = false; };
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = got.ask === ask ? { loading: false, ...got } : { loading: true, error: '', data: null };
  const rows = state.data?.rows || [];
  const total = Number(state.data?.total) || rows.length;
  const debit = Number(state.data?.debit) || 0;
  const credit = Number(state.data?.credit) || 0;
  return (
    <PanelSection title="Ledger Lines" caption={`Every line posted to GL ${gl}${entity ? ` in ${entity}` : ''}, ${fmtMDY(mStart(period))} - ${fmtMDY(mEnd(period))}.`}>
      {state.loading ? <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Reading the ledger...</div>
        : state.error ? <div role="alert" style={{ fontSize: '0.8rem', color: BAD }}>{state.error}</div>
          : !rows.length ? <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nothing posted to this account this month.</div>
            : (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                  <span>{total} line{total === 1 ? '' : 's'}</span>
                  <span>Debits <strong>{money2(debit)}</strong></span>
                  <span>Credits <strong>{money2(credit)}</strong></span>
                  <span>Net <strong style={{ color: debit - credit < 0 ? BAD : undefined }}>{money2(debit - credit)}</strong></span>
                </div>
                {/* Its own scroll box: the heading row pins as one block. */}
                <div data-testid="recon-lines" style={{ maxHeight: '55vh', overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                  <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums', margin: 0 }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-card)' }}>
                      <tr><th>Date</th><th>Entry</th><th>Description</th><th style={num}>Debit</th><th style={num}>Credit</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.line_id || `${r.entry_id}-${i}`}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>{r.entry_date ? fmtMDY(String(r.entry_date).slice(0, 10)) : ''}</td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>{r.entry_id ? <button type="button" className="acct-drill" onClick={() => onOpenEntry({ id: r.entry_id, no: r.entry_no })} title="Open this journal entry">{r.entry_no || 'Open'}</button> : r.entry_no}</td>
                          <td style={{ fontSize: '0.78rem' }}><div>{r.description || r.memo || '-'}</div>{r.memo && r.description ? <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.memo}</div> : null}</td>
                          <td style={{ ...num, fontSize: '0.78rem' }}>{Number(r.debit) ? money2(r.debit) : ''}</td>
                          <td style={{ ...num, fontSize: '0.78rem' }}>{Number(r.credit) ? money2(r.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {total > rows.length ? <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Showing the first {rows.length} of {total}. Open the full report for every line.</div> : null}
              </div>
            )}
    </PanelSection>
  );
}

// ── A mortgage / loan / line of credit: this month's reconciliation ─────────
function LiabilityRecon({ loanId, period, canEdit, canManage, onDirty, onSaved }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ date: '', balance: '', note: '', fileUrl: null, fileName: '' });
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const fileRef = useRef(null);

  const load = (date) => api.getLiabilityRecon(loanId, period, date || '').then((d) => { setDetail(d); setError(''); return d; }).catch((e) => setError(e?.message || 'Could not read this reconciliation.'));
  // The panel is keyed by account and month, so this runs once per open.
  useEffect(() => {
    let live = true;
    api.getLiabilityRecon(loanId, period).then((d) => {
      if (!live) return;
      setDetail(d);
      const rec = d.record;
      setDraft({ date: rec?.statementDate || d.asOf, balance: rec?.statementBalance != null ? String(rec.statementBalance) : '', note: rec?.note || '', fileUrl: null, fileName: rec?.statementName || '' });
      onDirty(false);
    }).catch((e) => { if (live) setError(e?.message || 'Could not read this reconciliation.'); });
    return () => { live = false; };
  }, [loanId, period]); // eslint-disable-line react-hooks/exhaustive-deps

  const rec = detail?.record || null;
  const locked = rec?.status === 'reconciled';
  const stmt = parseAmount(draft.balance);
  const ledger = detail?.ledgerBalance ?? null;
  const diff = useMemo(() => (stmt == null || Number.isNaN(stmt) || ledger == null ? null : Math.round((stmt - ledger) * 100) / 100), [stmt, ledger]);
  const zero = diff != null && Math.abs(diff) < 0.005;
  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); onDirty(true); };
  // A different statement date reads the ledger again on that date.
  const setDate = (v) => { const d = v || mEnd(period); set({ date: d }); if (d !== draft.date) load(d); };

  if (error && !detail) return <PanelSection title={`Reconcile ${monthLong(period)}`}><div role="alert" style={{ fontSize: '0.8rem', color: BAD }}>{error}</div></PanelSection>;
  if (!detail) return <PanelSection title={`Reconcile ${monthLong(period)}`}><div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Reading the ledger...</div></PanelSection>;
  const noGl = !detail.loan.glAccount;

  const save = async (reconcile) => {
    if (stmt == null || Number.isNaN(stmt)) { setError('Type the statement\'s ending balance.'); return; }
    setBusy(reconcile ? 'reconcile' : 'save');
    setError('');
    try {
      const body = { statementBalance: stmt, statementDate: draft.date, note: draft.note, reconcile };
      if (draft.fileUrl !== null) { body.statementUrl = draft.fileUrl; body.statementName = draft.fileName; }
      await api.saveLiabilityRecon(loanId, period, body);
      const d = await load(draft.date);
      setDraft((x) => ({ ...x, fileUrl: null, fileName: d?.record?.statementName || x.fileName }));
      onDirty(false);
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not save.');
    } finally {
      setBusy('');
    }
  };
  const attach = async (file) => {
    if (!file) return;
    setBusy('upload');
    setError('');
    const path = `accounting/liability-recons/${safeFileName(loanId)}/${period}-${Date.now()}-${safeFileName(file.name)}`;
    // The private task-files bucket: the file opens only through the signed viewer.
    const up = await uploadToSupabase(file, 'task-files', path, ['application/pdf']);
    setBusy('');
    if (up.error || !up.url) { setError(up.error || 'The statement could not be stored.'); return; }
    set({ fileUrl: up.url, fileName: file.name });
  };
  const reopen = async () => {
    if (!reason.trim()) { setError('Say why the month is being reopened.'); return; }
    setBusy('reopen');
    setError('');
    try {
      await api.reopenLiabilityRecon(loanId, period, reason.trim());
      await load(draft.date);
      setReopening(false);
      setReason('');
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not reopen.');
    } finally {
      setBusy('');
    }
  };

  const fileUrl = draft.fileUrl ?? rec?.statementUrl ?? '';
  const readOnly = locked || !canEdit || noGl;
  return (
    <PanelSection title={`Reconcile ${monthLong(period)}`} caption="The lender statement's ending balance against the ledger. Saved in Nexus only - nothing is sent to Intacct.">
      <div style={{ display: 'grid', gap: 12 }}>
        {noGl ? <div style={{ fontSize: '0.8rem', color: BAD }}>This loan has no GL account. Set it in Loans & Financing first, so Nexus can read the ledger balance.</div> : null}
        <div style={factGrid}>
          <label>
            <span style={lbl}>Statement Date</span>
            <DateField value={draft.date} onChange={setDate} disabled={readOnly} max={mEnd(period)} />
          </label>
          <label>
            <span style={lbl}>Statement Ending Balance</span>
            <input aria-label="Statement Ending Balance" inputMode="decimal" value={draft.balance} disabled={readOnly} placeholder="0.00"
              onChange={(e) => set({ balance: e.target.value })} style={{ ...input, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
          </label>
          <Fact label={`Ledger Balance${detail.asOf ? ` on ${fmtMDY(detail.asOf)}` : ''}`}>{ledger == null ? '-' : money2(ledger)}</Fact>
          <Fact label="Difference" color={diff == null ? undefined : zero ? OK : BAD}>{diff == null ? '-' : money2(diff)}</Fact>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <input ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ''; }} />
          {!readOnly ? <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => fileRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><FileUp size={13} /> {fileUrl ? 'Replace Statement PDF' : 'Attach Statement PDF'}</button> : null}
          {fileUrl ? <a href={fileUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Paperclip size={13} /> {draft.fileName || rec?.statementName || 'Statement'}</a>
            : <span style={{ color: 'var(--text-muted)' }}>{busy === 'upload' ? 'Uploading...' : 'Statement PDF optional'}</span>}
          {!readOnly && fileUrl ? <button type="button" className="secondary-btn" onClick={() => set({ fileUrl: '', fileName: '' })} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>Remove</button> : null}
        </div>
        <label>
          <span style={lbl}>Note</span>
          <textarea value={draft.note} disabled={readOnly} rows={2} onChange={(e) => set({ note: e.target.value })} style={{ ...input, width: '100%', resize: 'vertical' }} />
        </label>
        {error ? <div role="alert" style={{ fontSize: '0.8rem', color: BAD }}>{error}</div> : null}
        {locked ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: '0.8rem', color: OK, fontWeight: 600 }}>Reconciled by {rec.reconciledBy} on {formatDateTime(rec.reconciledAt)}</div>
            {canManage && !reopening ? <div><button type="button" className="secondary-btn" onClick={() => setReopening(true)}>Reopen Month</button></div> : null}
            {!canManage ? <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Only an Accounting admin can reopen a reconciled month.</div> : null}
            {reopening ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <label><span style={lbl}>Why Reopen</span><textarea aria-label="Why Reopen" value={reason} rows={2} onChange={(e) => setReason(e.target.value)} style={{ ...input, width: '100%' }} /></label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="primary-btn" disabled={busy === 'reopen'} onClick={reopen}>Reopen</button>
                  <button type="button" className="secondary-btn" onClick={() => { setReopening(false); setReason(''); }}>Cancel</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : canEdit && !noGl ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" disabled={!!busy || stmt == null} onClick={() => save(false)}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
            <button type="button" className="primary-btn" disabled={!!busy || !zero} onClick={() => save(true)}
              title={zero ? 'Mark this month reconciled' : 'The difference must be 0.00 first'}>{busy === 'reconcile' ? 'Saving...' : 'Mark Reconciled'}</button>
            {!zero && diff != null ? <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Mark Reconciled opens at a 0.00 difference.</span> : null}
          </div>
        ) : !canEdit ? <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Read only: reconciling needs the Accounting editor level.</div> : null}
        {rec?.reopenedAt && !locked ? <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Reopened by {rec.reopenedBy} on {formatDateTime(rec.reopenedAt)}: {rec.reopenReason}</div> : null}
        <History history={detail.history} log={detail.log} />
      </div>
    </PanelSection>
  );
}

const ACTION = { saved: 'Saved', reconciled: 'Reconciled', reopened: 'Reopened' };

function History({ history = [], log = [] }) {
  if (!history.length && !log.length) return null;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {history.length ? (
        <div>
          <div style={{ ...lbl, marginBottom: 6 }}>Recent Months</div>
          <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums', margin: 0 }}>
            <thead><tr><th>Month</th><th>Statement Date</th><th style={num}>Statement</th><th style={num}>Difference</th><th>Status</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td style={{ fontSize: '0.78rem' }}>{monthLong(h.period)}</td>
                  <td style={{ fontSize: '0.78rem' }}>{h.statementDate ? fmtMDY(h.statementDate) : '-'}</td>
                  <td style={{ ...num, fontSize: '0.78rem' }}>{money2(h.statementBalance)}</td>
                  <td style={{ ...num, fontSize: '0.78rem' }}>{money2(h.difference)}</td>
                  <td>{h.status === 'reconciled' ? <Chip tone="ok">Reconciled</Chip> : <Chip tone="wait">Open</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {log.length ? (
        <div>
          <div style={{ ...lbl, marginBottom: 6 }}>Activity</div>
          {log.slice(0, 20).map((x) => (
            <div key={x.id} style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', padding: '3px 0' }}>
              {ACTION[x.action] || x.action} {monthLong(x.period)} by {x.by} on {formatDateTime(x.at)}{x.detail?.reason ? ` - ${x.detail.reason}` : ''}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
