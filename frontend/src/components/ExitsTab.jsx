// People > Exits (Neil, Oct 27 2026): everyone leaving, and each leaver's
// final settlement statement - the last day, the final Time Sheet, leave per
// bucket, approved reimbursements not paid, the salary advance to recover,
// company items and the offboarding checklist. Greens' leave is use it or
// lose it: balances show for information, "Not Paid Out (Company Policy)",
// except where the law requires payout (California vacation). Money only
// with the Pay & Benefits grant. HR marks it Reviewed, generates the PDF
// (kept in the person's documents, filed to Egnyte), then closes the exit.
// The statement is information for payroll - Nexus does not run the final pay.
// Server side: routers/exit_statements.py + exit_statement.py.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, LogOut } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { formatDate, formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { Modal } from '../tasks/components';

const STATUS_COLOR = { open: '#b45309', reviewed: '#2563eb', filed: '#16a34a', closed: '#64748b' };
const day = (iso) => (iso ? formatDate(`${iso.slice(0, 10)}T12:00:00`) : '-');
const money = (n, cur) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur || ''}`; }
};
const num = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const H = { fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '16px 0 6px' };
const cell = { padding: '7px 10px', fontSize: 12.5, borderTop: '1px solid var(--line)' };
const small = { fontSize: 12, padding: '5px 10px' };

function Table({ head, rows }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))`, background: 'var(--mist)' }}>
        {head.map((h) => <div key={h} style={{ ...cell, borderTop: 'none', fontWeight: 700, fontSize: 11.5, color: 'var(--muted)' }}>{h}</div>)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))` }}>
          {r.map((c, j) => <div key={j} style={{ ...cell, color: 'var(--ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{c}</div>)}
        </div>
      ))}
    </div>
  );
}

const None = ({ children }) => <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{children}</div>;

/** One leaver's statement, with Review / Generate PDF / Close Exit. */
function StatementModal({ exit, onClose, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closing, setClosing] = useState(false);
  const load = useCallback(() => api.exitStatement(exit.employeeId)
    .then((d) => { setData(d); setErr(''); })
    .catch((e) => setErr(e?.message || 'Could not load the statement')), [exit.employeeId]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toastOk?.(ok); await load(); onChanged?.(); return true; }
    catch (e) { toastErr?.(e?.message || 'Could not save'); return false; }
    finally { setBusy(''); }
  };
  const st = data?.statement;
  const rv = data?.review;
  const canMoney = !!data?.canSeeMoney;
  const openDoc = async () => {
    try { const r = await api.getDocUrl(rv.documentId); if (r?.url) window.open(r.url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open the PDF'); }
  };
  const openSheet = () => {
    const l = st?.timesheet?.link;
    if (!l) return;
    openNotificationTarget(l);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: l.view, sub: l.sub } }));
    onClose();
  };
  const footer = st && (<>
    {rv?.documentId && canMoney && (
      <button type="button" className="secondary-btn" onClick={openDoc} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileText size={13} /> Open PDF</button>
    )}
    {rv?.status !== 'closed' && !closing && (
      <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => setClosing(true)}>Close Exit</button>
    )}
    {canMoney && rv?.status !== 'closed' && (
      <button type="button" className="secondary-btn" disabled={!!busy}
        onClick={() => run('review', () => api.reviewExitStatement(exit.employeeId), 'Marked Reviewed')}>
        {busy === 'review' ? <><Spinner size={13} /> Saving…</> : rv?.status === 'open' || rv?.reviewStale ? 'Mark Reviewed' : 'Review Again'}
      </button>
    )}
    {canMoney && rv?.status !== 'closed' && (
      <button type="button" className="primary-btn" disabled={!!busy || !['reviewed', 'filed'].includes(rv?.status) || rv?.reviewStale}
        title={rv?.status === 'open' ? 'Mark it Reviewed first' : rv?.reviewStale ? 'The figures changed - review it again first' : undefined}
        onClick={() => run('pdf', () => api.generateExitStatement(exit.employeeId), 'PDF generated and kept in their documents')}>
        {busy === 'pdf' ? <><Spinner size={13} /> Generating…</> : 'Generate PDF'}
      </button>
    )}
  </>);
  return (
    <Modal title={`Final Settlement - ${exit.name}`} onClose={onClose} footer={footer}>
      {err ? <div style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{err}</div>
        : !st ? <SkeletonBlocks count={4} height={60} />
          : (
            <div className="nx-fill">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <StatusLabel label={rv.statusLabel} color={STATUS_COLOR[rv.status]} />
                {rv.reviewStale && <span style={{ fontSize: 12, color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={13} /> Figures changed since the review</span>}
                {rv.reviewedByName && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Reviewed by {rv.reviewedByName} · {formatDateTime(rv.reviewedAt)}</span>}
                {rv.egnytePath && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Filed to Egnyte</span>}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 0 0' }}>
                {st.companyName || 'No company'} · {st.jobTitle || 'No title'} · {st.exitTypeLabel} · Last working day <strong style={{ color: 'var(--ink)' }}>{day(st.lastDay)}</strong> ({st.stage})
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Information for payroll - Nexus does not run the final pay.</div>
              {!canMoney && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Amounts are hidden - they need Pay &amp; Benefits access.</div>}

              <div style={H}>Final Time Sheet</div>
              {st.timesheet.periodStart ? (<>
                <Table head={['Pay Period', 'Status']} rows={[
                  [`${day(st.timesheet.periodStart)} - ${day(st.timesheet.periodEnd)}`, st.timesheet.statusLabel],
                  ...(st.timesheet.earlierOpen || []).map((p) => [`${day(p.periodStart)} - ${day(p.periodEnd)}`, 'Not Finalized']),
                ]} />
                <button type="button" className="secondary-btn" onClick={openSheet} style={{ ...small, marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <ExternalLink size={12} /> Open Time Sheet
                </button>
                {st.finalPay && (
                  <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 6 }}>
                    Gross pay {money(st.finalPay.grossPay, st.finalPay.currency)}
                    {st.finalPay.advanceRepayment !== undefined && <> · Salary Advance Repayment -{money(st.finalPay.advanceRepayment, st.finalPay.currency)} · Net pay {money(st.finalPay.netPay, st.finalPay.currency)}</>}
                  </div>
                )}
              </>) : <None>{st.timesheet.statusLabel}</None>}

              <div style={H}>Leave Balances</div>
              {st.leave.live ? (<>
                <Table head={['Leave', 'Hours', 'Days', 'Payout']}
                  rows={st.leave.buckets.map((b) => [b.label, num(b.hours), num(b.days), b.payout])} />
                {st.leave.payouts.map((p) => (
                  <div key={p.bucket} style={{ fontSize: 12.5, marginTop: 6, color: 'var(--ink)' }}>
                    <strong>{p.label}</strong> <StatusLabel label={p.flag} color="#7c3aed" size="sm" />{' '}
                    {p.amount !== undefined ? `${num(p.hours)} h x ${money(p.rate, p.currency)} per hour = ${money(p.amount, p.currency)}` : `${num(p.hours)} h`}
                  </div>
                ))}
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Leave is use it or lose it: unused leave is not paid out unless the law requires it.</div>
              </>) : <None>Leave balances are not set up for this person.</None>}

              <div style={H}>Approved Reimbursements Not Yet Paid</div>
              {st.reimbursements.owed.length ? (
                <Table head={['Expense', 'Status', 'Amount']}
                  rows={st.reimbursements.owed.map((r) => [r.item, r.statusLabel, r.amount !== undefined ? money(r.amount, r.currency) : '-'])} />
              ) : <None>None.</None>}
              {st.reimbursements.openCount > 0 && <None>{st.reimbursements.openCount} more waiting for approval.</None>}

              <div style={H}>Salary Advance To Recover</div>
              {st.advances.toRecover.length ? (
                <Table head={['Paid Out', 'Advance', 'Repaid', 'Balance']}
                  rows={st.advances.toRecover.map((a) => [day(a.paidOn), a.amount !== undefined ? money(a.amount, a.currency) : '-',
                    a.repaid !== undefined ? money(a.repaid, a.currency) : '-', a.balance !== undefined ? money(a.balance, a.currency) : '-'])} />
              ) : <None>None.</None>}
              {st.advances.notPaidOutCount > 0 && <None>{st.advances.notPaidOutCount} advance(s) requested or approved but not paid out - cancel them before the final pay.</None>}

              <div style={H}>Company Items</div>
              {st.items.held.length ? (
                <Table head={['Item', 'Serial', 'Held As']} rows={st.items.held.map((x) => [x.name, x.serial || '-', x.kind])} />
              ) : <None>No company items held.</None>}
              {st.items.closedAtLeft > 0 && <None>{st.items.closedAtLeft} item(s) were closed automatically when they were marked Left - confirm they came back.</None>}

              <div style={H}>Offboarding Checklist</div>
              {st.checklist.exists ? (<>
                <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>{st.checklist.done} of {st.checklist.total} steps done{st.checklist.overdue ? ` · ${st.checklist.overdue} overdue` : ''}</div>
                {st.checklist.open.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }}>
                    {st.checklist.open.map((o, i) => <li key={i}>{o.title}{o.dueDate ? ` - due ${day(o.dueDate)}` : ''}</li>)}
                  </ul>
                )}
              </>) : <None>No offboarding checklist.</None>}

              {canMoney && (Object.keys(st.summary.owedToEmployee).length > 0 || Object.keys(st.summary.toRecover).length > 0) && (<>
                <div style={H}>Summary</div>
                <Table head={['Line', 'Amount']} rows={[
                  ...Object.entries(st.summary.owedToEmployee).map(([c, v]) => ['Owed to the employee', money(v, c)]),
                  ...Object.entries(st.summary.toRecover).map(([c, v]) => ['To recover from the employee', money(v, c)]),
                ]} />
              </>)}

              {closing && (
                <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                  <textarea className="form-input" rows={2} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} style={{ width: '100%', resize: 'vertical' }}
                    aria-label="Why the exit is closed" placeholder={rv.status === 'filed' ? 'Note (optional)' : 'The statement is not filed - say why the exit is closed'} />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="secondary-btn" onClick={() => setClosing(false)} disabled={!!busy}>Back</button>
                    <button type="button" className="primary-btn" disabled={!!busy || (rv.status !== 'filed' && closeNote.trim().length < 3)}
                      onClick={() => run('close', () => api.closeExitStatement(exit.employeeId, closeNote.trim()), 'Exit closed').then((ok) => { if (ok) onClose(); })}>Close Exit</button>
                  </div>
                </div>
              )}
            </div>
          )}
    </Modal>
  );
}

export default function ExitsTab({ toastOk, toastErr }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.exitStatements(showClosed)
    .then((d) => { setRows(d?.exits || []); setErr(''); })
    .catch((e) => { setRows([]); setErr(e?.message || 'Could not load exits'); }), [showClosed]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="dash-card" data-exits-tab>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span className="dk-chip dk-chip--orange" style={{ width: 32, height: 32 }}><LogOut size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Exits In Progress</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Everyone leaving, and the final settlement statement payroll needs for each.</div>
        </div>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show Closed
        </label>
      </div>
      {err && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginBottom: 8 }}>{err}</div>}
      {!rows ? <SkeletonBlocks count={3} height={44} />
        : rows.length === 0 ? <None>Nobody is leaving right now.</None>
          : (
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              {rows.map((r, i) => (
                <button key={r.employeeId} type="button" onClick={() => setOpen(r)}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 1fr) auto', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left',
                    padding: '10px 12px', border: 'none', borderTop: i ? '1px solid var(--line)' : 'none', background: 'none', cursor: 'pointer', font: 'inherit' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[r.jobTitle, r.companyName].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>Last day {day(r.lastDay)}<span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{r.stage} · {r.exitTypeLabel}</span></span>
                  <span />
                  <StatusLabel label={r.statementStatusLabel} color={STATUS_COLOR[r.statementStatus]} size="sm" />
                </button>
              ))}
            </div>
          )}
      {open && <StatementModal exit={open} onClose={() => setOpen(null)} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}
