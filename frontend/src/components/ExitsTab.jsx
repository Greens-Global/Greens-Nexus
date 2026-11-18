// People > Exits: a TRACKER of everyone leaving (Neil, 11/14/2026; the final
// settlement statement since Oct 27 2026). The list is In Progress / Closed,
// soonest last day first; each row is the person, their last day ("In 7
// days" in the Live accent while it is ahead, "Left 7 days ago" after) and
// ONE "Where It Stands" line of chips built on the server
// (exit_statement.exits_in_progress, one query per kind): Package,
// Checklist, Items, Access, Reports, Mailbox Handover and - Pay & Benefits
// only - Settlement. Yellow waits on someone, green is done, gray is just
// so. On a phone each exit is a card.
//
// A row opens ONE sheet, its sections in the chips' order, each with its
// action: Send Separation Package, the checklist, Received / Lost per item
// (Return Pending), Change Last Day, the mailbox handover, Open Profile, and
// the Final Settlement (Pay & Benefits only: Mark Reviewed, Generate PDF,
// Close Exit and Reopen - held). Greens' leave is use it or lose it: balances
// show "Not Paid Out (Company Policy)" except where the law requires payout
// (California vacation). The statement is information for payroll - Nexus
// does not run the final pay.
//
// A manager (not HR) sees their own direct reports' exits here: the tracker
// and the checklist only - never pay, the settlement, the package's contents
// or HR's notes (the server checks every row).
// Server side: routers/exit_statements.py + exit_statement.py.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, RefreshCw, CheckCircle, RotateCcw, Lock, User, Send, CalendarClock, ListChecks } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { formatDate, formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { openPersonProfile } from '../lib/personNav';
import { Modal, AvatarName } from '../tasks/components';
import { formatHoursHM, formatHoursWords } from '../lib/hoursText';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { ReturnPendingButtons } from './ReturnPending';
import { MailboxHandoverSteps, ChangeLastDayModal, SeparationPackageModal } from './HrPersonActions';

const STATUS_COLOR = { open: '#64748b', reviewed: '#2563eb', filed: '#16a34a', closed: '#64748b' };
// Waiting on someone = yellow (a warning, never orange); done = green; the rest gray.
const TONE = { warn: '#ca8a04', done: '#16a34a', neutral: '#64748b' };
const day = (iso) => (iso ? formatDate(`${iso.slice(0, 10)}T12:00:00`) : '-');
const money = (n, cur) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur || ''}`; }
};
const num = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const H = { fontSize: 14, fontWeight: 700, color: 'var(--ink)', margin: '20px 0 8px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const SUB = { fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '14px 0 6px' };
const cell = { padding: '7px 10px', fontSize: 13, borderTop: '1px solid var(--line)' };
const small = { fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 };

// Days between two YYYY-MM-DD dates (b - a), whole days.
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
/** "In 7 days" (Live accent - it is ahead) / "Last Day Today" / "Left 7 days ago" (muted). */
function whenWords(lastDay, today) {
  if (!lastDay || !today) return { text: '', live: false };
  const n = dayDiff(today, lastDay);
  if (n > 1) return { text: `In ${n} days`, live: true };
  if (n === 1) return { text: 'Tomorrow', live: true };
  if (n === 0) return { text: 'Last Day Today', live: true };
  return { text: n === -1 ? 'Left yesterday' : `Left ${-n} days ago`, live: false };
}

function useIsPhone() {
  const q = '(max-width: 640px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return undefined;
    const on = () => setPhone(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return phone;
}

function Table({ head, rows }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))`, background: 'var(--mist)' }}>
        {head.map((h) => <div key={h} style={{ ...cell, borderTop: 'none', fontWeight: 700, fontSize: 12, color: 'var(--muted)' }}>{h}</div>)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: `repeat(${head.length}, minmax(0, 1fr))` }}>
          {r.map((c, j) => <div key={j} style={{ ...cell, color: 'var(--ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{c}</div>)}
        </div>
      ))}
    </div>
  );
}

const None = ({ children }) => <div style={{ fontSize: 13, color: 'var(--muted)' }}>{children}</div>;
const Warn = ({ children }) => (
  <div style={{ fontSize: 13, color: 'var(--ink)', display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6 }}>
    <AlertTriangle size={14} style={{ color: TONE.warn, flexShrink: 0, marginTop: 2 }} /><span>{children}</span>
  </div>
);

/** The "Where It Stands" line: one chip per part of the exit. */
function Chips({ chips = [], only }) {
  const shown = only ? chips.filter((c) => c.key === only) : chips;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }}>
      {shown.map((c) => <StatusLabel key={c.key} label={c.label} color={TONE[c.tone] || TONE.neutral} size="sm" />)}
    </span>
  );
}

/** One exit, everything about it in the order of its chips. */
function ExitSheet({ exit, today, onClose, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [modal, setModal] = useState('');            // 'lastday' | 'package'
  const load = useCallback(() => api.exitStatement(exit.employeeId)
    .then((d) => { setData(d); setErr(''); })
    .catch((e) => setErr(e?.message || 'Could not load this exit')), [exit.employeeId]);
  useEffect(() => { load(); }, [load]);
  const reloadAll = () => { load(); onChanged?.(); };
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toastOk?.(ok); await load(); onChanged?.(); return true; }
    catch (e) { toastErr?.(e?.message || 'Could not save'); return false; }
    finally { setBusy(''); }
  };
  const st = data?.statement;
  const rv = data?.review;
  const tr = data?.tracker || exit;
  const cl = data?.checklist || {};
  const manager = !!data?.managerView;
  const canMoney = !!data?.canSeeMoney;
  const closed = rv?.status === 'closed';
  const person = { id: exit.employeeId, firstName: exit.firstName || exit.name, lastName: exit.lastName || '', workEmail: exit.email };
  const when = whenWords(tr.lastDay || exit.lastDay, today);
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
  const openProfile = () => { openPersonProfile(exit.email); onClose(); };
  // Their own checklist, on their People page (11/14/2026) - not the board of everyone's.
  const openChecklist = () => { openPersonProfile(exit.email, 'checklist'); onClose(); };
  const settle = (row) => async (outcome, body) => {
    await api.exitItemOutcome(exit.employeeId, row.rowKind, row.rowId, outcome, body);
    toastOk?.(outcome === 'lost' ? `${row.name} marked Lost.` : `${row.name} received.`);
  };
  const pkg = tr.package || {};
  const canSendPackage = !manager && ['none', 'declined'].includes(pkg.state);
  // One even grid on a phone (style.css .nx-exit-foot); a plain row on a computer.
  const footer = data && (<div className="nx-exit-foot">
    {exit.email && (
      <button type="button" className="secondary-btn" onClick={openProfile} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><User size={13} /> Open Profile</button>
    )}
    {rv?.documentId && canMoney && (
      <button type="button" className="secondary-btn" onClick={openDoc} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileText size={13} /> Open PDF</button>
    )}
    {canMoney && closed && (
      <HoldButton label="Reopen" doneLabel="Reopened" icon={RotateCcw} holdMs={HOLD_RECORD_MS} disabled={!!busy}
        fallbackMessage={`Reopen ${exit.name}'s exit? It goes back on the In Progress list as it was when it was closed.`}
        onConfirm={async () => {
          try { await api.reopenExitStatement(exit.employeeId); }
          catch (e) { throw new Error(e?.message || 'Could not reopen it.', { cause: e }); }
        }}
        onDone={() => { toastOk?.('Exit reopened.'); reloadAll(); }} />
    )}
    {canMoney && !closed && !closing && (
      <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => setClosing(true)}>Close Exit</button>
    )}
    {canMoney && !closed && (
      <button type="button" className="secondary-btn" disabled={!!busy}
        onClick={() => run('review', () => api.reviewExitStatement(exit.employeeId), 'Marked Reviewed')}>
        {busy === 'review' ? <><Spinner size={13} /> Saving…</> : rv?.status === 'open' || rv?.reviewStale ? 'Mark Reviewed' : 'Review Again'}
      </button>
    )}
    {canMoney && !closed && (
      <button type="button" className="primary-btn" disabled={!!busy || !['reviewed', 'filed'].includes(rv?.status) || rv?.reviewStale}
        title={rv?.status === 'open' ? 'Mark it Reviewed first' : rv?.reviewStale ? 'The figures changed - review it again first' : undefined}
        onClick={() => run('pdf', () => api.generateExitStatement(exit.employeeId), 'PDF generated and kept in their documents')}>
        {busy === 'pdf' ? <><Spinner size={13} /> Generating…</> : 'Generate PDF'}
      </button>
    )}
  </div>);
  const chip = (key) => <Chips chips={tr.chips} only={key} />;
  return (
    <Modal title={`Exit - ${exit.name}`} onClose={onClose} footer={footer}>
      {err ? <div style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{err}</div>
        : !data ? <SkeletonBlocks count={4} height={60} />
          : (
            <div data-exit-sheet>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                {[tr.jobTitle || exit.jobTitle, tr.companyName || exit.companyName, tr.exitTypeLabel || exit.exitTypeLabel].filter(Boolean).join(' · ')}
              </div>
              <div style={{ fontSize: 15, color: 'var(--ink)', marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span>Last day <strong>{day(tr.lastDay || exit.lastDay)}</strong></span>
                {when.text && <span style={{ fontSize: 13, fontWeight: 600, color: when.live ? 'var(--wk-live-ink)' : 'var(--muted)' }}>{when.text}</span>}
              </div>
              <div style={{ marginTop: 10 }}><Chips chips={tr.chips} /></div>

              {/* Package */}
              <div style={H}>Separation Package {chip('package')}</div>
              {manager ? <None>HR sends and tracks the paperwork.</None> : (<>
                <None>
                  {pkg.state === 'none' && 'No separation package is out for them.'}
                  {pkg.state === 'declined' && 'They declined the separation package.'}
                  {pkg.state === 'review' && 'The package is generated and waits for HR to check it - open their profile to review and send it.'}
                  {pkg.state === 'waiting_person' && `It is with ${exit.firstName || 'them'} to sign first; the company countersigns after.`}
                  {pkg.state === 'waiting_company' && 'They signed - the company countersigns now. Open their profile to sign it.'}
                  {pkg.state === 'signed' && 'Signed by everyone and filed with their documents.'}
                </None>
                {canSendPackage && (
                  <button type="button" className="secondary-btn" style={{ ...small, marginTop: 8 }} onClick={() => setModal('package')}>
                    <Send size={12} /> {['declined', 'voided', 'expired'].includes(pkg.status) ? 'Resend Separation Package' : 'Send Separation Package'}
                  </button>
                )}
              </>)}

              {/* Checklist */}
              <div style={H}>Offboarding Checklist {chip('checklist')}</div>
              {cl.exists ? (<>
                <div style={{ fontSize: 13, color: 'var(--ink)' }}>{cl.done} of {cl.total} steps done{cl.overdue ? ` · ${cl.overdue} overdue` : ''}</div>
                {(cl.open || []).length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--muted)' }}>
                    {cl.open.map((o, i) => <li key={i}>{o.title}{o.dueDate ? ` - due ${day(o.dueDate)}` : ''}</li>)}
                  </ul>
                )}
                {!manager && (
                  <button type="button" className="secondary-btn" style={{ ...small, marginTop: 8 }} onClick={openChecklist}><ListChecks size={12} /> Open Checklist</button>
                )}
              </>) : <None>No offboarding checklist.</None>}

              {!manager && st && (<>
                {/* Items */}
                <div style={H}>Company Items {chip('items')}</div>
                {st.items.held.length ? (
                  <Table head={['Item', 'Serial', 'Where It Is']} rows={st.items.held.map((x) => [
                    x.name,
                    x.serial || '-',
                    x.returnPending && x.rowId
                      ? <span key="rp" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                          <StatusLabel label="Return Pending" color={TONE.warn} size="sm" />
                          <ReturnPendingButtons item={x} holder={exit.name} settle={settle(x)} onDone={reloadAll} toastErr={toastErr} />
                        </span>
                      : x.kind,
                  ])} />
                ) : <None>No company items held.</None>}
                {st.items.held.some((x) => !x.returnPending) && st.stage === 'Leaving' && <None>Still with them - they return them from My Items before their last day.</None>}
                {st.items.held.some((x) => x.returnPending) && <None>Still out when they left: nobody else can borrow or be assigned it until it is Received or reported Lost.</None>}

                {/* Access */}
                <div style={H}>Access {chip('access')}</div>
                {(st.issues || []).map((x) => <Warn key={x.code}>{x.message}</Warn>)}
                <None>
                  {st.stage === 'Left'
                    ? 'Microsoft 365 sign-in, Nexus and their phones were ended when they were marked Left.'
                    : `They keep their access through ${day(st.lastDay)}; Nexus ends it the morning after.`}
                </None>
                {tr.scheduled && (
                  <button type="button" className="secondary-btn" style={{ ...small, marginTop: 8 }} onClick={() => setModal('lastday')}><CalendarClock size={12} /> Change Last Day</button>
                )}

                {/* Reports */}
                {tr.reportsToMove > 0 && (<>
                  <div style={H}>Direct Reports {chip('reports')}</div>
                  <None>
                    {tr.scheduled
                      ? `${tr.reportsToMove} still report to them. They move to the manager picked on Offboard when ${exit.firstName || 'they'} becomes Left.`
                      : `${tr.reportsToMove} still report to them - change their Reports To on People.`}
                  </None>
                </>)}

                {/* Mailbox handover */}
                {st.mailboxHandover && (<>
                  <div style={H}>Mailbox Handover {chip('mailbox')}</div>
                  {st.mailboxHandover.done ? (
                    <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <CheckCircle size={14} style={{ color: TONE.done }} /> Done{st.mailboxHandover.at ? ` ${formatDateTime(st.mailboxHandover.at)}` : ''}
                      <button type="button" className="secondary-btn" style={small} disabled={!!busy}
                        onClick={() => run('mbx', () => api.exitMailboxHandover(exit.employeeId, false), 'Mailbox handover marked not done')}>Not Done Yet</button>
                    </div>
                  ) : (<>
                    <MailboxHandoverSteps upn={st.email} trustees={st.mailboxHandover.delegateTo || []} toastOk={toastOk} toastErr={toastErr} />
                    <button type="button" className="primary-btn" style={{ ...small, marginTop: 8 }} disabled={!!busy}
                      onClick={() => run('mbx', () => api.exitMailboxHandover(exit.employeeId, true), 'Mailbox handover done')}>
                      {busy === 'mbx' ? <Spinner size={12} /> : <CheckCircle size={12} />} Mailbox Handover Done
                    </button>
                  </>)}
                </>)}
              </>)}

              {/* Final Settlement - Pay & Benefits only */}
              {canMoney && st && rv && (<>
                <div style={H}>Final Settlement {chip('settlement')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <StatusLabel label={rv.statusLabel} color={rv.egnyteFailed ? TONE.warn : STATUS_COLOR[rv.status]} />
                  {rv.reviewStale && <span style={{ fontSize: 12, color: TONE.warn, display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={13} /> Figures changed since the review</span>}
                  {rv.reviewedByName && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Reviewed by <AvatarName email={rv.reviewedBy} name={rv.reviewedByName} size={18} /> · {formatDateTime(rv.reviewedAt)}</span>}
                  {rv.egnytePath && !rv.egnyteFailed && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Filed to Egnyte</span>}
                  {rv.egnyteFailed && (
                    <button type="button" className="secondary-btn" disabled={!!busy} style={small}
                      onClick={() => run('egnyte', () => api.retryExitEgnyte(exit.employeeId), 'Copied to Egnyte')}>
                      {busy === 'egnyte' ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry Egnyte
                    </button>
                  )}
                </div>
                {rv.egnyteFailed && rv.egnyteError && <Warn>The PDF is kept in their documents in Nexus, but the Egnyte copy failed: {rv.egnyteError}</Warn>}
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Information for payroll - Nexus does not run the final pay.</div>

                <div style={SUB}>Final Time Sheet</div>
                {st.timesheet.periodStart ? (<>
                  <Table head={['Pay Period', 'Status']} rows={[
                    [`${day(st.timesheet.periodStart)} - ${day(st.timesheet.periodEnd)}`, st.timesheet.statusLabel],
                    ...(st.timesheet.earlierOpen || []).map((p) => [`${day(p.periodStart)} - ${day(p.periodEnd)}`, 'Not Finalized']),
                  ]} />
                  <div>
                    <button type="button" className="secondary-btn" onClick={openSheet} style={{ ...small, marginTop: 6 }}>
                      <ExternalLink size={12} /> Open Time Sheet
                    </button>
                  </div>
                  {st.finalPay && (
                    <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 6 }}>
                      Gross pay {money(st.finalPay.grossPay, st.finalPay.currency)}
                      {st.finalPay.advanceRepayment !== undefined && <> · Salary Advance Repayment -{money(st.finalPay.advanceRepayment, st.finalPay.currency)} · Net pay {money(st.finalPay.netPay, st.finalPay.currency)}</>}
                    </div>
                  )}
                </>) : <None>{st.timesheet.statusLabel}</None>}

                <div style={SUB}>Leave Balances</div>
                {st.leave.live ? (<>
                  <Table head={['Leave', 'Hours', 'Days', 'Payout']}
                    rows={st.leave.buckets.map((b) => [b.label, formatHoursHM(b.hours), num(b.days), b.payout])} />
                  {st.leave.payouts.map((p) => (
                    <div key={p.bucket} style={{ fontSize: 13, marginTop: 6, color: 'var(--ink)' }}>
                      <strong>{p.label}</strong> <StatusLabel label={p.flag} color="#7c3aed" size="sm" />{' '}
                      {p.amount !== undefined ? `${formatHoursWords(p.hours)} x ${money(p.rate, p.currency)} per hour = ${money(p.amount, p.currency)}` : formatHoursWords(p.hours)}
                    </div>
                  ))}
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Leave is use it or lose it: unused leave is not paid out unless the law requires it.</div>
                </>) : <None>Leave balances are not set up for this person.</None>}

                <div style={SUB}>Approved Reimbursements Not Yet Paid</div>
                {st.reimbursements.owed.length ? (
                  <Table head={['Expense', 'Status', 'Amount']}
                    rows={st.reimbursements.owed.map((r) => [r.item, r.statusLabel, r.amount !== undefined ? money(r.amount, r.currency) : '-'])} />
                ) : <None>None.</None>}
                {st.reimbursements.openCount > 0 && <None>{st.reimbursements.openCount} more waiting for approval.</None>}

                <div style={SUB}>Salary Advance To Recover</div>
                {st.advances.toRecover.length ? (
                  <Table head={['Paid Out', 'Advance', 'Repaid', 'Balance']}
                    rows={st.advances.toRecover.map((a) => [day(a.paidOn), a.amount !== undefined ? money(a.amount, a.currency) : '-',
                      a.repaid !== undefined ? money(a.repaid, a.currency) : '-', a.balance !== undefined ? money(a.balance, a.currency) : '-'])} />
                ) : <None>None.</None>}
                {st.advances.notPaidOutCount > 0 && <None>{st.advances.notPaidOutCount} advance(s) requested or approved but not paid out - cancel them before the final pay.</None>}

                {(Object.keys(st.summary.owedToEmployee).length > 0 || Object.keys(st.summary.toRecover).length > 0) && (<>
                  <div style={SUB}>Summary</div>
                  <Table head={['Line', 'Amount']} rows={[
                    ...Object.entries(st.summary.owedToEmployee).map(([c, v]) => ['Owed to the employee', money(v, c)]),
                    ...Object.entries(st.summary.toRecover).map(([c, v]) => ['To recover from the employee', money(v, c)]),
                  ]} />
                </>)}

                {closing && !closed && (
                  <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                    <textarea className="form-input" rows={2} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} style={{ width: '100%', resize: 'vertical' }}
                      aria-label="Why the exit is closed" placeholder={rv.status === 'filed' ? 'Note (optional)' : 'The statement is not filed - say why the exit is closed'} />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                      <button type="button" className="secondary-btn" onClick={() => setClosing(false)} disabled={!!busy}>Back</button>
                      <HoldButton label="Close Exit" doneLabel="Closed" icon={Lock} holdMs={HOLD_RECORD_MS}
                        disabled={!!busy || (rv.status !== 'filed' && closeNote.trim().length < 3)}
                        fallbackMessage={`Close ${exit.name}'s exit? It leaves the In Progress list (Reopen brings it back).`}
                        onConfirm={async () => {
                          try { await api.closeExitStatement(exit.employeeId, closeNote.trim()); }
                          catch (e) { throw new Error(e?.message || 'Could not close it.', { cause: e }); }
                        }}
                        onDone={() => { toastOk?.('Exit closed'); onChanged?.(); onClose(); }} />
                    </div>
                  </div>
                )}

                {(rv.history || []).length > 0 && (<>
                  <div style={SUB}>Activity</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 3 }}>
                    {rv.history.slice().reverse().slice(0, 12).map((h, i) => (
                      <li key={i}>{formatDateTime(h.at)} - {h.note || h.action.replace(/_/g, ' ')}{h.byName ? ` (${h.byName})` : ''}</li>
                    ))}
                  </ul>
                </>)}
              </>)}
              {!canMoney && !manager && st && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 20 }}>The final settlement needs Pay &amp; Benefits access.</div>}
            </div>
          )}
      {modal === 'lastday' && <ChangeLastDayModal employee={person} current={tr.lastDay} toastErr={toastErr}
        onClose={() => setModal('')}
        onDone={(ev) => { setModal(''); toastOk?.(ev.applyStatus === 'applied' ? `${exit.firstName || exit.name} is offboarded.` : `Last day moved to ${day(ev.effectiveDate)} - the package was not sent again.`); reloadAll(); }} />}
      {modal === 'package' && <SeparationPackageModal employee={person} toastErr={toastErr}
        onClose={() => setModal('')}
        onSent={() => { setModal(''); toastOk?.('Separation package sent - they sign first. HR countersigns from their profile.'); reloadAll(); }} />}
    </Modal>
  );
}

/** One exit on the list: the person, the last day, where it stands. */
function TrackerRow({ r, today, phone, first, onOpen }) {
  const when = whenWords(r.lastDay, today);
  const lastDay = (
    <span style={{ fontSize: 13, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
      {day(r.lastDay)}
      {when.text && <span style={{ display: 'block', fontSize: 12, fontWeight: when.live ? 600 : 400, color: when.live ? 'var(--wk-live-ink)' : 'var(--muted)' }}>{when.text}</span>}
    </span>
  );
  const who = (
    <span style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: phone ? 'normal' : 'nowrap' }}>{[r.jobTitle, r.exitTypeLabel].filter(Boolean).join(' · ')}</span>
    </span>
  );
  const base = { width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' };
  if (phone) {
    return (
      <button type="button" onClick={onOpen} className="dash-card" data-exit-row
        style={{ ...base, display: 'grid', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)' }}>
        <span style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>{who}<span style={{ textAlign: 'right' }}>{lastDay}</span></span>
        <Chips chips={r.chips} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} data-exit-row
      style={{ ...base, display: 'grid', gridTemplateColumns: 'minmax(180px, 1.1fr) 130px minmax(0, 3fr)', gap: 16, alignItems: 'center',
        padding: '12px 14px', borderTop: first ? 'none' : '1px solid var(--line)' }}>
      {who}
      {lastDay}
      <Chips chips={r.chips} />
    </button>
  );
}

export default function ExitsTab({ toastOk, toastErr }) {
  const [rows, setRows] = useState(null);
  const [today, setToday] = useState('');
  const [manager, setManager] = useState(false);
  const [err, setErr] = useState('');
  const [seg, setSeg] = useState('open');            // 'open' | 'closed'
  const [open, setOpen] = useState(null);
  const phone = useIsPhone();
  const load = useCallback(() => api.exitStatements(seg === 'closed')
    .then((d) => { setRows(d?.exits || []); setToday(d?.today || ''); setManager(!!d?.managerView); setErr(''); })
    .catch((e) => { setRows(null); setErr(e?.message || 'Could not load exits'); }), [seg]);
  useEffect(() => { load(); }, [load]);
  const shown = (rows || []).filter((r) => (seg === 'closed' ? r.closed : !r.closed));
  return (
    <div className={phone ? undefined : 'dash-card'} data-exits-tab>
      {/* The tab is named in the module bar (Neil, 11/06/2026) - no second title here. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="wk-seg" role="group" aria-label="Exits">
          {[['open', 'In Progress'], ['closed', 'Closed']].map(([k, l]) => (
            <button key={k} type="button" className={seg === k ? 'on' : undefined} aria-pressed={seg === k} onClick={() => setSeg(k)}>{l}</button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 200, fontSize: 13, color: 'var(--muted)' }}>
          {manager ? 'Your direct reports who are leaving - where each exit stands.' : 'Everyone leaving, soonest first - where each exit stands.'}
        </div>
      </div>
      {err ? (
        <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <AlertTriangle size={14} /> Could not load the exits: {err}
          <button type="button" className="secondary-btn" style={small} onClick={() => { setErr(''); load(); }}>Try Again</button>
        </div>
      ) : !rows ? <SkeletonBlocks count={3} height={phone ? 96 : 52} />
        : shown.length === 0 ? <None>{seg === 'closed' ? 'No closed exits.' : 'Nobody is leaving right now.'}</None>
          : phone ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {shown.map((r) => <TrackerRow key={r.employeeId} r={r} today={today} phone onOpen={() => setOpen(r)} />)}
            </div>
          ) : (
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.1fr) 130px minmax(0, 3fr)', gap: 16, padding: '8px 14px', background: 'var(--mist)', fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>
                <span>Person</span><span>Last Day</span><span>Where It Stands</span>
              </div>
              {shown.map((r) => <TrackerRow key={r.employeeId} r={r} today={today} first={false} onOpen={() => setOpen(r)} />)}
            </div>
          )}
      {open && <ExitSheet exit={open} today={today} onClose={() => setOpen(null)} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}
