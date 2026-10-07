import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Database, FileText, FolderOpen, FolderUp, Mail, PenLine, Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Amount, { Figure, formatAmount } from './Amount';
import { formatDate } from '../../lib/datetime';
import { EntitiesPicker, ExportMenu, PeriodStepper, PopoverPanel, control, entityOptions, usePopover } from './reportControls';
import { downloadBlob, iso, presetRange } from './reportModel';
import { useAccountingPrefs } from './prefs';
import { linesFile } from './linesExport';
import SendReportDialog from './SendReportDialog';
import EntryDetail from './EntryDetail';
import LoanDetail, { INTEREST_SOURCE } from './LoanDetail';
import LoanSetupDialog, { Chip, DEBIT_NOTE } from './LoanSetupDialog';
import { EditLoanDialog, ManualLoanDialog, folderName, loanTypeLabel } from './LoanDialogs';
import { POLL_MS } from './LedgerScan';
import { LoanAmortizationDialog } from './LoanAmortization';
import { LoanStressDialog, LoanStressPortfolio } from './LoanStress';

// Accounting -> Loans & Financing (Neil and Charmi, 10/02: "Nothing has been
// done on Loans & Financing for me to review"). The loans table was empty on
// production, so the Data > Loans grid and every loan widget opened blank.
//
// Oct 6 (Charmi and Neil, feedback of 10/03-10/04), the screen as it is now:
//   - Filters on top like Reports: Entities (the Reports picker - "see only
//     Rajesh's loans"), the period with its arrows (Month-to-Date by default:
//     balances as of TODAY), Internal / External, and a quick text filter.
//   - The loans as of the period's end. A loan with nothing owed (paid off)
//     or marked inactive is CLOSED and hidden unless Customize > Show Closed
//     Loans - the old loans used to flood the list.
//   - Columns: Lender, Loan #, Entity, Monthly Payment, Original Principal,
//     Balance, Principal Paid, Interest Paid, Debt Service, Rate, Maturity,
//     DSCR, Type, Egnyte. No GL line under the name, no Debit Balance chip
//     (the balance is the positive amount owed; a debit balance gets a note
//     on hover), no Month Ago / Year Ago.
//   - Principal paid = the debits to the loan's liability account in the
//     period; interest paid = its own interest expense account (wired under
//     Change Loan, or matched by title) - read from the ledger, not derived.
//   - Click a loan: the payments in the period (every entry opens), and the
//     whole payment history in a section that opens and closes.
//   - Export as Reports does it: Excel, CSV, PDF, Email, Save to Files.
//   - + Add: From the Ledger (the scan, active entities only) or Manual.
//   - Skeleton rows while the ledger is read.
//   - Fix: "I added a few of the loans and they do not show up" - the API
//     cached the review for five minutes per worker; it is read fresh now,
//     and a failed read no longer says "No loans set up".
//
// The amortization schedule and stress test plug into the per-loan detail
// (LoanDetail's `extras`, see renderLoanExtras below).
//
// Oct 7 (Charmi and Neil):
//   - The pencil works again (Change Loan "closed by itself" - the cause and
//     the fix are in LoanDialogs.jsx: the backdrop took the second click of a
//     double-click, or a drag that ended outside the window, as "close"). The
//     review also reads with a long timeout: at the 18s default a slow ledger
//     read was aborted, retried three times and reported the whole API as
//     down, which remounts the screen when it comes back (App.jsx viewEpoch).
//   - A trash beside the pencil removes a loan, confirmed in place (Remove /
//     Keep - no browser dialog); a ledger loan is remembered as removed so
//     + Add > From the Ledger stops offering it.
//   - The period opens on the last closed month, not month-to-date (six days
//     into a month nothing has posted, so every loan read "-"); a period with
//     nothing posted says so ("No payments posted <range>").
//   - Draws only for a Line of Credit (Loan Type under Change Loan, guessed
//     from the GL title); the type shows beside the lender.
//   - Loans | Stress Test: the portfolio stress test is its own full-width
//     sub-tab (LoanStress.jsx) instead of a pop-up.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const dash = <span style={{ color: 'var(--text-muted)' }}>-</span>;
const toolbarButton = (active) => ({
  ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: active ? 600 : 400,
});
const panel = (width) => ({ width, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 });
const KIND = { external: 'External', intercompany: 'Intercompany', given: 'Loan Given' };
const TYPES = [['all', 'All Types'], ['external', 'External'], ['internal', 'Internal']];
const dscrText = (v) => (v == null ? '-' : `${v.toFixed(2)}x`);
const rateText = (r) => (r.ratePct == null ? '' : `${Number(r.ratePct).toFixed(2)}%${r.rateType ? ` ${r.rateType === 'variable' ? 'variable' : 'fixed'}` : ''}`);
const sumOf = (rows, k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
/** Not configured on this environment: the accounting service is not connected (503 from the API). */
export const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');

// Where the amortization schedule / stress test plug into a loan's detail
// (Charmi and Neil, 10/06): two buttons that open them over the screen.
const renderLoanExtras = (loan, { onPlan }) => (
  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
    <button type="button" className="secondary-btn" onClick={() => onPlan('amortization')} style={{ fontSize: '0.78rem', padding: '4px 12px' }}>Amortization Schedule</button>
    <button type="button" className="secondary-btn" onClick={() => onPlan('stress')} style={{ fontSize: '0.78rem', padding: '4px 12px' }}>Stress Test</button>
  </div>
);

/** The loans the filters let through, closed ones only when asked for. */
export function visibleLoans(loans, { type = 'all', text = '', showClosed = false } = {}) {
  const q = text.trim().toLowerCase();
  return loans.filter((r) => (showClosed || !r.closed)
    && (type === 'all' || (type === 'internal') === !!r.internal)
    && (!q || [r.lender, r.loanNo, r.entityName, r.entityCode, r.glAccount, r.notes].some((v) => String(v || '').toLowerCase().includes(q))));
}

/** Totals by lender or by entity over the loans shown. */
export function groupTotals(rows, key, labelKey) {
  const by = new Map();
  rows.forEach((r) => {
    const k = r[key] || '';
    if (!by.has(k)) by.set(k, { key: k, label: r[labelKey] || k || '(no lender)', loans: 0, balance: 0, debtServiceT12: 0, noiT12: 0, entities: new Set() });
    const g = by.get(k);
    g.loans += 1;
    g.balance += r.balance || 0;
    g.debtServiceT12 += r.debtServiceT12 || 0;
    if (!g.entities.has(r.entityCode)) { g.entities.add(r.entityCode); g.noiT12 += r.noiT12 || 0; }
  });
  return [...by.values()].map((g) => ({ ...g, dscr: g.debtServiceT12 > 0.005 ? Math.round((g.noiT12 / g.debtServiceT12) * 100) / 100 : null })).sort((a, b) => b.balance - a.balance);
}

// The loans on screen as a table for linesFile (Excel / CSV / PDF and the
// Email / Save to Files dialog) - the Reports tab's export path.
const EXPORT_COLUMNS = [
  { label: 'Lender', width: 200 }, { label: 'Loan #', width: 90 }, { label: 'Entity', width: 200 }, { label: 'Monthly Payment', num: true, width: 110 },
  { label: 'Original Principal', num: true, width: 120 }, { label: 'Balance', num: true, width: 120 }, { label: 'Principal Paid', num: true, width: 110 },
  { label: 'Interest Paid', num: true, width: 110 }, { label: 'Debt Service', num: true, width: 110 }, { label: 'Rate', width: 90 }, { label: 'Maturity', width: 90 },
  { label: 'DSCR', width: 70 }, { label: 'Type', width: 80 }, { label: 'Principal Account', width: 90 }, { label: 'Interest Account', width: 90 },
  { label: 'Loan Type', width: 90 }, { label: 'Draws', num: true, width: 100 }, { label: 'Documents Folder', width: 160 }, { label: 'Statements Folder', width: 160 },
];
export function loansTable(rows, { from, to, entityLabel }) {
  const n = (v) => (v == null ? '' : v);
  return {
    title: 'Loans & Financing',
    period: `${formatDate(from)} - ${formatDate(to)}`.replace(/\//g, '-'),
    subtitle: `${entityLabel} · ${formatDate(from)} - ${formatDate(to)} · balances as of ${formatDate(to)}`,
    columns: EXPORT_COLUMNS,
    rows: rows.map((r) => [r.lender, r.loanNo, r.entityName, n(r.monthlyPayment), n(r.originalPrincipal), r.balance, n(r.principalPaid), n(r.interestPaid), n(r.debtService),
      rateText(r), r.maturity ? formatDate(r.maturity) : '', dscrText(r.dscr), r.internal ? 'Internal' : 'External', r.glAccount || '', r.interestAccount || '',
      loanTypeLabel(r.loanType), r.lineOfCredit ? n(r.draws) : '', r.docsPath || '', r.statementsPath || '']),
    totals: ['Total', '', '', sumOf(rows, 'monthlyPayment'), sumOf(rows, 'originalPrincipal'), sumOf(rows, 'balance'), sumOf(rows, 'principalPaid'), sumOf(rows, 'interestPaid'), sumOf(rows, 'debtService'), '', '', '', '', '', '',
      '', sumOf(rows.filter((r) => r.lineOfCredit), 'draws'), '', ''],
  };
}

function SkeletonRows({ rows = 6, cols = 14 }) {
  return Array.from({ length: rows }, (_x, i) => (
    <tr key={`sk${i}`} aria-hidden="true">
      {Array.from({ length: cols }, (_y, j) => (
        <td key={j}><div className="nx-skel" style={{ height: 12, borderRadius: 4, width: j === 0 ? '80%' : '60%', marginLeft: j > 2 ? 'auto' : 0, '--i': i }} /></td>
      ))}
    </tr>
  ));
}

function AddMenu({ onLedger, onManual }) {
  const [open, setOpen, ref] = usePopover();
  const item = { display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left', border: 'none', background: 'none', borderRadius: 6, padding: '7px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-primary)' };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="primary-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
        <Plus size={14} /> Add
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align="right" role="menu" aria-label="Add a loan" style={{ ...panel(290), padding: 6 }}>
        <button type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onLedger(); }}>
          <Database size={14} style={{ color: 'var(--text-muted)', marginTop: 2 }} />
          <span><span style={{ display: 'block', fontWeight: 600 }}>From the Ledger</span><span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Liability accounts that look like loans in Intacct</span></span>
        </button>
        <button type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onManual(); }}>
          <PenLine size={14} style={{ color: 'var(--text-muted)', marginTop: 2 }} />
          <span><span style={{ display: 'block', fontWeight: 600 }}>Manual</span><span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>A loan that is not in Intacct</span></span>
        </button>
      </PopoverPanel>
    </div>
  );
}

function LoansCustomize({ showClosed, onShowClosed, showHistorical, onShowHistorical, closedCount }) {
  const [open, setOpen, ref] = usePopover();
  const on = showClosed || showHistorical;
  const check = (checked, onChange, title, sub) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>{title}<span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{sub}</span></span>
    </label>
  );
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={toolbarButton(on)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Settings2 size={14} style={{ color: on ? 'inherit' : 'var(--text-muted)' }} /> Customize
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align="right" role="dialog" aria-label="Customize" style={{ ...panel(320), display: 'grid', gap: 10 }}>
        {check(showClosed, onShowClosed, 'Show Closed Loans', `Loans with nothing owed as of the date, or marked inactive${closedCount ? ` (${closedCount} now)` : ''}.`)}
        {check(showHistorical, onShowHistorical, 'Show historical entities', 'The (H) entities Intacct keeps for old books, in the Entities list and in + Add > From the Ledger.')}
      </PopoverPanel>
    </div>
  );
}

function Totals({ title, rows }) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: '0.8rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)' }}>{title}</div>
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>{title === 'By Lender' ? 'Lender' : 'Entity'}</th><th style={num}>Loans</th><th style={num}>Balance</th><th style={num}>Debt Service (T12)</th><th style={num}>NOI (T12)</th><th style={num}>DSCR</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key || g.label}>
              <td>{g.label || '(no lender)'}</td><td style={num}>{g.loans}</td><td style={num}><Amount value={g.balance} /></td><td style={num}><Amount value={g.debtServiceT12} zero="dash" /></td>
              <td style={num}><Amount value={g.noiT12} zero="dash" /></td><td style={num}><Figure text={dscrText(g.dscr)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shiftMonth = (m, by) => { const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + by; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function Maturities({ month, rows }) {
  const strip = Array.from({ length: 24 }, (_x, i) => shiftMonth(month, i));
  const by = new Map();
  rows.forEach((r) => {
    const m = (r.maturity || '').slice(0, 7);
    if (!m || m < month || m > strip[strip.length - 1]) return;
    if (!by.has(m)) by.set(m, { balance: 0, loans: [] });
    by.get(m).balance += r.balance;
    by.get(m).loans.push(r);
  });
  return (
    <div style={{ ...card, padding: '8px 12px', display: 'grid', gap: 6 }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>Maturities - Next 24 Months</div>
      {!by.size ? <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>No loan shown matures in the next 24 months (maturity dates are typed under Change Loan).</div> : (
        <div className="scroll-tabs" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
          {strip.map((m) => {
            const cell = by.get(m);
            return (
              <div key={m} title={cell ? cell.loans.map((l) => `${l.lender} #${l.loanNo} (${l.entityName}) ${formatAmount(l.balance)}`).join('\n') : ''}
                style={{ minWidth: 86, flex: '0 0 auto', border: `1px solid ${cell ? '#b45309' : 'var(--border-color)'}`, borderRadius: 8, padding: '4px 8px', background: cell ? 'rgba(180,83,9,0.10)' : 'var(--bg-secondary)', fontSize: '0.7rem' }}>
                <div style={{ fontWeight: 700 }}>{monthLabel(m)}</div>
                <div style={{ fontVariantNumeric: 'tabular-nums' }}>{cell ? <><Amount value={cell.balance} /><div style={{ color: 'var(--text-muted)' }}>{cell.loans.map((l) => l.lender || l.loanNo).join(', ')}</div></> : dash}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The last closed month (Charmi, item 46 #4): month-to-date six days in had
// nothing posted, so every loan read "-" and looked broken.
const firstPeriod = () => { const [f, t] = presetRange('last-month').map(iso); return { preset: 'last-month', from: f, to: t }; };
/** Nothing paid on any loan shown in the period (principal and interest). */
export const nothingPosted = (rows) => rows.length > 0 && rows.every((r) => !(Math.abs(Number(r.principalPaid) || 0) > 0.005) && !(Math.abs(Number(r.interestPaid) || 0) > 0.005));

// Trash beside the pencil: confirmed in place, never a browser dialog.
function RemoveCell({ loan, onRemove, onEdit }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = loan.lender || loan.loanNo;
  if (asking) {
    return (
      <span role="group" aria-label={`Remove ${name}?`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Remove?</span>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => { setBusy(true); onRemove(loan).finally(() => { setBusy(false); setAsking(false); }); }}
          style={{ fontSize: '0.72rem', height: 24, padding: '0 8px', background: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)' }}>{busy ? 'Removing...' : 'Remove'}</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => setAsking(false)} style={{ fontSize: '0.72rem', height: 24, padding: '0 8px' }}>Keep</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      <button type="button" className="icon-btn" aria-label={`Edit ${name}`} onClick={onEdit} style={{ padding: 4, color: 'var(--text-muted)' }}><Pencil size={13} /></button>
      <button type="button" className="icon-btn" aria-label={`Remove ${name}`} title="Remove this loan" onClick={() => setAsking(true)} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
    </span>
  );
}

export default function LoansTab({ canEdit = false }) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const showClosed = !!prefs.loansShowClosed;
  const showHistorical = !!prefs.showHistoricalEntities;
  const [period, setPeriod] = useState(firstPeriod);
  const [picked, setPicked] = useState([]);
  const [type, setType] = useState('all');
  const [text, setText] = useState('');
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  // The answer is kept with the key of the read it belongs to: a new read
  // (another period, other entities, after a save) shows as loading over
  // the last answer, without resetting state inside the effect.
  const [reloads, setReloads] = useState(0);
  const [res, setRes] = useState({ key: null, data: null, error: null });
  const [dialog, setDialog] = useState(null);   // 'ledger' | 'manual' | { edit: loan }
  const [open, setOpen] = useState(() => new Set());
  const [entry, setEntry] = useState(null);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState('');
  const [view, setView] = useState('loans');      // 'loans' | 'stress' (Oct 7: the stress test is its own tab)

  useEffect(() => {
    api.getAccountingLocations?.().then((d) => { setEntities(d?.entities || []); setLimited(!!d?.limited); }).catch(() => setEntities([]));
  }, []);

  const key = JSON.stringify([period.from, period.to, picked, reloads]);
  useEffect(() => {
    let alive = true;
    const read = api.getLoansReviewSlow || api.getLoansReview;
    read({ from: period.from, to: period.to, entities: picked })
      .then((d) => { if (alive) setRes({ key, data: d, error: null }); })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const load = () => setReloads((n) => n + 1);
  const loading = res.key !== key;
  const error = loading ? null : res.error;      // Error | null
  const review = res.data;

  const all = useMemo(() => review?.loans || [], [review]);
  const rows = useMemo(() => visibleLoans(all, { type, text, showClosed }), [all, type, text, showClosed]);
  const closedCount = all.filter((r) => r.closed).length;
  const hiddenClosed = showClosed ? 0 : closedCount;
  const unavailable = error && notAvailable(error);
  const to = review?.to || period.to;
  const from = review?.from || period.from;
  const opts = useMemo(() => entityOptions(entities, { showHistorical, keep: picked }), [entities, showHistorical, picked]);
  const entityLabel = !picked.length ? (limited ? 'All my entities' : 'All entities')
    : picked.length === 1 ? `${opts.find((o) => o.code === picked[0])?.name || 'Unnamed'} (${picked[0]})` : `${picked.length} entities`;
  const toggleOpen = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const onPeriod = (p) => {
    if (p.preset && p.preset !== 'custom') { const [f, t] = presetRange(p.preset).map(iso); setPeriod({ preset: p.preset, from: f, to: t }); return; }
    setPeriod((cur) => ({ ...cur, ...p }));
  };

  const openLoans = useMemo(() => all.filter((r) => !r.closed), [all]);
  const removeLoan = (loan) => api.deleteLoan(loan.id)
    .then((d) => {
      setSent({ text: `Removed ${loan.lender || loan.loanNo}${loan.entityName ? ` (${loan.entityName})` : ''}.${d?.dismissed ? ' + Add > From the Ledger will not offer it again unless Show Removed is on.' : ''}` });
      load();
    })
    .catch((e) => setSent({ text: e?.message || 'Could not remove the loan.', bad: true }));
  const table = () => loansTable(rows, { from, to, entityLabel });
  const exportAs = async (format) => {
    if (busy) return;
    setBusy(format);
    try {
      const file = await linesFile(table(), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setSent({ text: e?.message || 'Could not export the loans.', bad: true });
    } finally {
      setBusy('');
    }
  };

  const cols = 15 + (canEdit ? 1 : 0);
  const totals = { monthly: sumOf(rows, 'monthlyPayment'), original: sumOf(rows, 'originalPrincipal'), balance: sumOf(rows, 'balance'), principal: sumOf(rows, 'principalPaid'), interest: sumOf(rows, 'interestPaid'), ds: sumOf(rows, 'debtService') };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{`
        .acct-loans tbody.loan:nth-of-type(even) > tr.loan-row > td { background: color-mix(in srgb, var(--bg-secondary), var(--text-primary) 5%); }
        .acct-loans tbody.loan > tr.loan-row:hover > td { background: var(--wk-brand-tint, #e8ecfd); }
        .acct-loans tbody.loan > tr.loan-row { cursor: pointer; }
        .acct-loans tbody.loan > tr.loan-row.closed > td { color: var(--text-muted); }
      `}</style>
      <div className="scroll-tabs" role="tablist" aria-label="Loans & Financing" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)' }}>
        {[['loans', 'Loans'], ['stress', 'Stress Test']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: '0.82rem', fontWeight: view === k ? 700 : 500, whiteSpace: 'nowrap',
              color: view === k ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', borderBottom: `2px solid ${view === k ? 'var(--wk-brand, #2b45e1)' : 'transparent'}`, marginBottom: -1 }}>{l}</button>
        ))}
      </div>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <EntitiesPicker entities={entities} value={picked} onChange={setPicked} limited={limited} showHistorical={showHistorical} />
        <PeriodStepper config={period} period="range" onChange={onPeriod} />
        {view === 'loans' && <>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Internal or External" style={{ ...control, color: type === 'all' ? 'var(--text-primary)' : 'var(--wk-brand, #2b45e1)' }}>
          {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter loans" aria-label="Filter loans" style={{ ...control, width: 170, paddingLeft: 24 }} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            Loans <strong>{rows.length}</strong> · Balance <strong><Amount value={totals.balance} /></strong>
          </span>
          <LoansCustomize showClosed={showClosed} onShowClosed={(v) => setPrefs({ loansShowClosed: v })} showHistorical={showHistorical} onShowHistorical={(v) => setPrefs({ showHistoricalEntities: v })} closedCount={closedCount} />
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The loans shown, totals in bold', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per loan', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
            { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, the loans attached', Icon: Mail, onPick: () => setSending('email') },
            { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
          ]} />
          {canEdit && !unavailable && <AddMenu onLedger={() => setDialog('ledger')} onManual={() => setDialog('manual')} />}
        </div>
        </>}
        {view === 'stress' && <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>NOI (T12) and balances as of {formatDate(to)} - the period picks them</span>}
      </div>

      {sent && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: sent.bad ? 'var(--bad-fg, #dc2626)' : 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{sent.text}{sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer">Open the File</a></>}</span>
          <button type="button" className="secondary-btn" onClick={() => setSent(null)} style={{ fontSize: '0.74rem', padding: '2px 10px' }}>Dismiss</button>
        </div>
      )}
      {(review?.notes || []).length > 0 && <div style={{ fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' }}>{review.notes.join(' · ')} - open again to retry.</div>}

      {error && (unavailable ? (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Loans & Financing is not available here.</strong> The accounting service is not connected on this environment, so there is no ledger to read loans from.
        </div>
      ) : (
        <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{error.message || 'Could not read the loans.'}</span>
          <button type="button" className="secondary-btn" onClick={load} style={{ fontSize: '0.76rem' }}>Try Again</button>
        </div>
      ))}

      {/* A failed read is not "no loans" (Oct 6). */}
      {!error && !loading && review && !all.length && (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6, maxWidth: 760 }}>
          <strong style={{ color: 'var(--text-primary)' }}>No loans set up for {picked.length ? 'the entities picked' : 'the entities you may read'}.</strong>
          <span>+ Add &gt; From the Ledger reads each active entity's balance sheet as of {formatDate(to)} and proposes a loan for every liability account whose title says {(review?.lookedFor || []).join(', ')}. Accounts payable, credit cards, payroll, accrued, deferred and deposit balances are left out unless the title says loan.</span>
          <span>{canEdit ? 'Or + Add > Manual for a loan that is not in Intacct.' : 'An editor on Accounting can add them here.'}</span>
        </div>
      )}
      {view === 'stress' && !error && (loading && !review ? <div style={{ ...card, padding: 8 }}><table className="req-table"><tbody><SkeletonRows cols={8} /></tbody></table></div> : (
        <LoanStressPortfolio loans={openLoans} canEdit={canEdit} to={to} onEditLoan={canEdit ? (l) => setDialog({ edit: l }) : null} />
      ))}

      {view === 'loans' && !error && !loading && all.length > 0 && !rows.length && (
        <div style={{ ...card, padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
          No loan matches the filters{hiddenClosed ? ` - ${hiddenClosed} closed ${hiddenClosed === 1 ? 'loan is' : 'loans are'} hidden (Customize > Show Closed Loans)` : ''}.
        </div>
      )}
      {view === 'loans' && !error && !loading && nothingPosted(rows) && (
        <div role="status" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '6px 10px' }}>
          No payments posted {formatDate(from)} - {formatDate(to)} on the loans shown. Balances are as of {formatDate(to)}; pick another period with the arrows.
        </div>
      )}

      {view === 'loans' && !unavailable && (loading || rows.length > 0) && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-busy={loading}>
          <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="req-table acct-loans" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={{ width: 26 }} /><th>Lender</th><th>Loan #</th><th>Entity</th><th style={num}>Monthly Payment</th><th style={num}>Original Principal</th><th style={num}>Balance</th>
                  <th style={num}>Principal Paid</th><th style={num}>Interest Paid</th><th style={num}>Debt Service</th><th>Rate</th><th>Maturity</th><th style={num}>DSCR</th><th>Type</th><th>Egnyte</th>
                  {canEdit && <th style={{ width: 36 }} />}
                </tr>
              </thead>
              {loading && !review ? <tbody><SkeletonRows cols={cols} /></tbody> : rows.map((r) => {
                const isOpen = open.has(r.id);
                const stop = (e) => e.stopPropagation();
                return (
                  <tbody key={r.id} className="loan">
                    <tr className={`loan-row${r.closed ? ' closed' : ''}`} onClick={() => toggleOpen(r.id)} style={loading ? { opacity: 0.6 } : r.belowCovenant ? { boxShadow: 'inset 3px 0 0 var(--bad-fg, #dc2626)' } : undefined}>
                      <td><button type="button" className="icon-btn" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details of ${r.lender || r.loanNo}`} onClick={(e) => { stop(e); toggleOpen(r.id); }} style={{ padding: 2, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex' }}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td>
                      <td style={{ fontWeight: 600 }}>
                        <span>{r.lender || '(no lender)'}</span>
                        {r.lineOfCredit && <> <Chip tone="brand" title={r.loanTypeGuessed ? 'Read from the GL title - set it under Change Loan' : 'Set under Change Loan'}>Line of Credit</Chip></>}
                        {r.wiring === 'manual' && <> <Chip tone="muted" title="Kept by hand - not in Intacct">Manual</Chip></>}
                        {r.wiring === 'missing' && <> <Chip tone="wait" title={`GL ${r.glAccount} has no lines in this entity on the ledger - check the principal account under Change Loan.`}>Check Wiring</Chip></>}
                        {r.closed && <> <Chip tone="muted">Closed</Chip></>}
                      </td>
                      <td>{r.loanNo || dash}</td>
                      <td>{r.entityName}</td>
                      <td style={num}>{r.monthlyPayment == null ? dash : <Amount value={r.monthlyPayment} />}</td>
                      <td style={num} title={r.originalPrincipalEdited ? `Typed over the ledger${r.originalPrincipalLedger != null ? `'s ${formatAmount(r.originalPrincipalLedger)}` : ''}` : r.originalPrincipalDate ? `The first credit on the account, ${formatDate(r.originalPrincipalDate)}` : undefined}>
                        {r.originalPrincipal == null ? dash : <><Amount value={r.originalPrincipal} />{r.originalPrincipalEdited && <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginLeft: 4 }}>edited</span>}</>}
                      </td>
                      <td style={num} title={r.debitBalance ? DEBIT_NOTE : r.wiring === 'ok' ? `GL ${r.glAccount} as of ${formatDate(to)}` : undefined}>
                        {r.wiring === 'missing' ? dash : <Amount value={r.balance} />}{r.debitBalance && <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}> *</span>}
                      </td>
                      <td style={num} title={r.wiring === 'ok' ? `Debits to GL ${r.glAccount} in the period${r.lineOfCredit && r.draws ? `; draws (credits) ${formatAmount(r.draws)}` : ''}` : undefined}>{r.principalPaid == null ? dash : <Amount value={r.principalPaid} zero="dash" />}</td>
                      <td style={num} title={r.interestAccounts?.length ? `GL ${r.interestAccounts.map((a) => `${a.code} ${a.title}`).join(', ')} - ${INTEREST_SOURCE[r.interestSource] || ''}${r.interestSharedWith ? ` (with ${r.interestSharedWith} more)` : ''}` : 'No interest account - wire one under Change Loan'}>
                        {r.interestPaid == null ? dash : <Amount value={r.interestPaid} zero="dash" />}
                      </td>
                      <td style={num}><Amount value={r.debtService} zero="dash" /></td>
                      <td>{rateText(r) || dash}</td>
                      <td>{r.maturity ? formatDate(r.maturity) : dash}</td>
                      <td style={num}>
                        {r.dscr == null ? <span title="Nothing was serviced in the trailing twelve months" style={{ color: 'var(--text-muted)' }}>-</span>
                          : <Chip tone={r.belowCovenant ? 'bad' : 'ok'} title={`NOI ${formatAmount(r.noiT12)} over the entity's debt service ${formatAmount(r.entityDebtServiceT12)} (trailing 12); minimum ${r.covenantMin.toFixed(2)}x${r.covenantTyped ? '' : ' (default)'}`}>{dscrText(r.dscr)}</Chip>}
                      </td>
                      <td><Chip tone={r.internal ? 'muted' : 'brand'} title={r.kind === 'intercompany' ? 'Owed to another entity' : KIND[r.kind] || undefined}>{r.internal ? 'Internal' : 'External'}</Chip></td>
                      <td onClick={stop} style={{ whiteSpace: 'nowrap' }}>
                        {r.docsUrl ? <a href={r.docsUrl} target="_blank" rel="noreferrer" aria-label={`Loan documents of ${r.lender}`} title={`Documents: ${folderName(r.docsPath) || 'Egnyte'}`} style={{ marginRight: 8, color: 'var(--wk-brand, #2b45e1)' }}><FolderOpen size={14} /></a> : null}
                        {r.statementsUrl ? <a href={r.statementsUrl} target="_blank" rel="noreferrer" aria-label={`Loan statements of ${r.lender}`} title={`Statements: ${folderName(r.statementsPath) || 'Egnyte'}`} style={{ color: 'var(--wk-brand, #2b45e1)' }}><FileText size={14} /></a> : null}
                        {!r.docsUrl && !r.statementsUrl && dash}
                      </td>
                      {canEdit && <td onClick={stop} style={{ whiteSpace: 'nowrap' }}><RemoveCell loan={r} onEdit={() => setDialog({ edit: r })} onRemove={removeLoan} /></td>}
                    </tr>
                    {isOpen && (
                      <tr className="loan-detail">
                        <td colSpan={cols} style={{ padding: 0 }}>
                          <LoanDetail loan={r} from={from} to={to} onOpenEntry={(l) => setEntry({ id: l.entryId, no: l.entryNo })} extras={renderLoanExtras(r, { onPlan: (kind) => setDialog({ plan: kind, loan: r }) })} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
              {!loading && rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td /><td>Total</td><td /><td />
                    <td style={num}><Amount value={totals.monthly} zero="dash" /></td><td style={num}><Amount value={totals.original} zero="dash" /></td><td style={num}><Amount value={totals.balance} /></td>
                    <td style={num}><Amount value={totals.principal} zero="dash" /></td><td style={num}><Amount value={totals.interest} zero="dash" /></td><td style={num}><Amount value={totals.ds} zero="dash" /></td>
                    <td colSpan={cols - 10} style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-muted)' }}>{hiddenClosed ? `${hiddenClosed} closed ${hiddenClosed === 1 ? 'loan' : 'loans'} hidden` : ''}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {view === 'loans' && !loading && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
          <Totals title="By Lender" rows={groupTotals(rows, 'lender', 'lender')} />
          <Totals title="By Entity" rows={groupTotals(rows, 'entityCode', 'entityName')} />
        </div>
      )}
      {view === 'loans' && !loading && rows.length > 0 && <Maturities month={to.slice(0, 7)} rows={rows.filter((r) => !r.closed)} />}

      {dialog === 'ledger' && (
        <LoanSetupDialog asof={iso(new Date()) < to ? iso(new Date()) : to} entities={picked} entityLabel={entityLabel} historical={showHistorical}
          onClose={() => setDialog(null)} onCreated={() => { setDialog(null); load(); }} />
      )}
      {dialog === 'manual' && <ManualLoanDialog entities={entities} showHistorical={showHistorical} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog?.edit && <EditLoanDialog loan={dialog.edit} to={to} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog?.plan === 'amortization' && <LoanAmortizationDialog loan={dialog.loan} canEdit={canEdit} month={to.slice(0, 7)} onClose={() => setDialog(null)} />}
      {dialog?.plan === 'stress' && <LoanStressDialog loan={dialog.loan} canEdit={canEdit} onClose={() => setDialog(null)} />}
      {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
      {sending && (
        <SendReportDialog mode={sending} title="Loans & Financing" baseName={`Loans & Financing - ${entityLabel} - ${formatDate(to).replace(/\//g, '-')}`.replace(/[\\/:*?"<>|]+/g, ' ')} what="loan list"
          makeFile={async (format, name) => linesFile(table(), format, name)}
          onClose={() => setSending(null)} onDone={(t, url) => { setSending(null); setSent({ text: t, url }); }} />
      )}
    </div>
  );
}

/** The ledger scan dialog, still importable by its old name. */
export function SetupDialog({ month, asof, onClose, onCreated, pollMs = POLL_MS }) {
  const date = asof || (month ? (() => { const [y, m] = month.split('-').map(Number); return iso(new Date(y, m, 0)); })() : iso(new Date()));
  return <LoanSetupDialog asof={date} onClose={onClose} onCreated={onCreated} pollMs={pollMs} />;
}

export const _test = { dscrText, visibleLoans, groupTotals, loansTable };
