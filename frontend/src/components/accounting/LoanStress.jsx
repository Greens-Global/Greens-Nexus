import { useEffect, useMemo, useState } from 'react';
import { Pencil, Save, Trash2, X } from 'lucide-react';
import { useBackdropClose } from './LoanDialogs';
import { api } from '../../api';
import Amount, { AmountInput, Figure } from './Amount';
import { formatDate } from '../../lib/datetime';
import { ColumnResizer, CustomizeButton, DENSITIES, EntityPicker, ExportMenu, Pager, control } from './reportControls';
import { useColumnWidths, useCustomizePrefs, usePaged } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import { downloadBlob } from './reportModel';
import { SHOCKS, normalizeLoan, stressAmortMonths, stressLoan, stressPortfolio } from './loanMath';

// Accounting -> Loans & Financing -> Stress Test (Charmi and Neil, 10/06: "if
// the interest rate were to go up, we should be able to calculate if the
// income will support the loan").
//
//   One loan    the rate shocks side by side (today, +100, +200, +300 bps
//               and a custom one): the annual debt service, DSCR against
//               the covenant, Pass / Below Covenant, the NOI cushion (how far
//               NOI can fall before the covenant breaks) and the break-even
//               rate (where DSCR = covenant). NOI starts from the loan's
//               trailing-12 on the Loans review and can be typed over. A
//               floating loan feels the shock now; a fixed one holds its
//               payment, and its shocked columns read as a refinance at
//               maturity. Scenarios worth keeping are saved (inputs only).
//   Portfolio   every loan under one shock, entity by entity - an entity's
//               NOI services all of its loans, the same DSCR the Loans
//               review shows - failing entities first.
// The arithmetic is loanMath.js (tested).
//
// Oct 7 (items 9, 12, 21, 32): the portfolio's toolbar reads like the rest of
// the module - the entity picker (search by number), then the standard
// Customize (Row Density, Rows per Page) and Export at its right end; a Pager
// under the entities (the totals and the export cover every entity); and
// columns resized by dragging a header edge.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const warn = { fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 };
const input = { ...control, width: '100%' };
const pct = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}%`);
const x = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}x`);
const bps = (v) => `${v > 0 ? '+' : ''}${v} bps`;
const breakEvenText = (be) => (be === 'above' ? 'Above 50%' : be == null ? 'Fails at Any Rate' : pct(be));
const shockText = (be) => (be === 'above' ? 'No Break-Even' : be == null ? 'Fails Today' : bps(be));

function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    brand: { fg: 'var(--wk-brand, #2b45e1)', bg: 'var(--wk-brand-tint, #e8ecfd)' }, muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}

const passChip = (ok) => (ok ? <Chip tone="ok">Pass</Chip> : <Chip tone="bad">Below Covenant</Chip>);

function Field({ id, title, children, hint }) {
  return (
    <div>
      <label style={label} htmlFor={id}>{title}</label>
      {children}
      {hint && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function ShockPicker({ value, custom, onPick, onCustom }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Rate shock">
      {SHOCKS.map((s) => (
        <button key={s} type="button" className={value === s ? 'primary-btn' : 'secondary-btn'} onClick={() => onPick(s)} style={{ fontSize: '0.76rem', height: 28, padding: '0 10px' }}>{bps(s)}</button>
      ))}
      <input type="number" step="25" aria-label="Custom shock in basis points" placeholder="Custom bps" value={custom} onChange={(e) => onCustom(e.target.value)}
        style={{ ...control, width: 110, borderColor: value === 'custom' ? 'var(--wk-brand, #2b45e1)' : undefined }} />
    </div>
  );
}

function initialInputs(l, loan) {
  return {
    balance: l.balance > 0 ? l.balance : null,
    ratePct: l.ratePct ?? '',
    noi: l.noiT12,
    covenant: l.covenant,
    rateType: l.rateType,
    amortMonths: stressAmortMonths(loan),
    interestOnly: false,
    custom: '',
  };
}

/** One loan under rate shocks. Props: { loan, canEdit }. */
export default function LoanStress({ loan, canEdit = false }) {
  const l = useMemo(() => normalizeLoan(loan), [loan]);
  const [p, setP] = useState(() => initialInputs(l, loan));
  const [pick, setPick] = useState(200);
  const [scenarios, setScenarios] = useState([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch) => setP((v) => ({ ...v, ...patch }));

  useEffect(() => {
    let live = true;
    api.getLoanStressScenarios(l.id).then((d) => { if (live) setScenarios(d?.scenarios || []); }).catch(() => { /* none kept, or not available here: the test still works */ });
    return () => { live = false; };
  }, [l.id]);

  const customBps = p.custom === '' || Number.isNaN(Number(p.custom)) ? null : Math.round(Number(p.custom));
  const columns = useMemo(() => {
    const list = [0, ...SHOCKS];
    if (customBps != null && !list.includes(customBps)) list.push(customBps);
    return list.map((s) => ({ bps: s, r: stressLoan({ balance: p.balance, ratePct: p.ratePct, shockBps: s, noi: p.noi, covenant: p.covenant, rateType: p.rateType, amortMonths: p.amortMonths, interestOnly: p.interestOnly }) }));
  }, [p, customBps]);
  const chosen = pick === 'custom' ? customBps ?? 0 : pick;
  const focus = columns.find((c) => c.bps === chosen) || columns[0];
  const fixed = p.rateType === 'fixed';
  const missing = [!(Number(p.balance) > 0) && 'the balance', (p.ratePct === '' || p.ratePct == null) && 'the current rate', !(Number(p.noi) > 0) && 'the NOI'].filter(Boolean);

  const saveScenario = () => {
    const n = name.trim() || `${bps(chosen)} on ${pct(p.ratePct)}`;
    setSaving(true);
    setError('');
    api.saveLoanStressScenario(l.id, { name: n, params: { ...p, shockBps: chosen } })
      .then((d) => { setScenarios((s) => [d.scenario, ...s]); setName(''); })
      .catch((e) => setError(e?.message || 'Could not save the scenario.'))
      .finally(() => setSaving(false));
  };
  const apply = (s) => {
    const { shockBps, ...rest } = s.params || {};
    setP((v) => ({ ...v, ...rest }));
    if (SHOCKS.includes(shockBps)) setPick(shockBps);
    else { setPick('custom'); set({ custom: String(shockBps ?? '') }); }
  };
  const removeScenario = (s) => {
    api.deleteLoanStressScenario(l.id, s.id).then(() => setScenarios((list) => list.filter((y) => y.id !== s.id))).catch((e) => setError(e?.message || 'Could not remove it.'));
  };

  const rowsOut = [
    ['Rate', (c) => pct(c.r.stressedRate)],
    [fixed ? 'Debt Service at Refinance' : 'Annual Debt Service', (c) => <Amount value={c.r.refinanceDebtService} />],
    ['Increase', (c) => <Amount value={c.r.refinanceDebtService - c.r.baseDebtService} zero="dash" />],
    ['DSCR', (c) => <Figure text={x(fixed ? c.r.dscrAtRefinance : c.r.dscr)} />],
    ['Covenant', (c) => passChip(fixed ? c.r.passAtRefinance : c.r.pass)],
    ['NOI Cushion', (c) => <Amount value={fixed ? p.noi - c.r.covenant * c.r.refinanceDebtService : c.r.cushion} />],
  ];

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {error && <div style={bad}>{error}</div>}
      <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
        <div style={grid}>
          <Field id="st-bal" title="Balance"><AmountInput id="st-bal" value={p.balance} onChange={(v) => set({ balance: v })} style={input} /></Field>
          <Field id="st-rate" title="Current Rate %"><input id="st-rate" type="number" step="0.001" min="0" value={p.ratePct} onChange={(e) => set({ ratePct: e.target.value })} style={input} /></Field>
          <Field id="st-noi" title="NOI (Annual)" hint={l.noiT12 != null ? 'Trailing 12 from the ledger - type over it to test' : 'No trailing-12 NOI on file'}><AmountInput id="st-noi" value={p.noi} onChange={(v) => set({ noi: v })} style={input} /></Field>
          <Field id="st-cov" title="Covenant DSCR"><input id="st-cov" type="number" step="0.01" min="0" value={p.covenant} onChange={(e) => set({ covenant: e.target.value })} style={input} /></Field>
          <Field id="st-type" title="Rate Type"><select id="st-type" value={p.rateType} onChange={(e) => set({ rateType: e.target.value })} style={input}><option value="floating">Floating</option><option value="fixed">Fixed</option></select></Field>
          <Field id="st-amort" title="Amortization Left (Months)" hint={l.monthlyPi ? 'From the monthly P&I on file' : 'Default 300 (25 years)'}>
            <input id="st-amort" type="number" min="1" max="1200" value={p.amortMonths} disabled={p.interestOnly} onChange={(e) => set({ amortMonths: e.target.value })} style={input} />
          </Field>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}><input type="checkbox" checked={p.interestOnly} onChange={(e) => set({ interestOnly: e.target.checked })} /> Interest only</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ ...label, margin: 0 }}>Shock</span>
          <ShockPicker value={pick} custom={p.custom} onPick={setPick} onCustom={(v) => { set({ custom: v }); setPick('custom'); }} />
        </div>
        {missing.length > 0 && <div style={warn}>Enter {missing.join(', ')} to test this loan.</div>}
        {fixed && <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>A fixed rate holds the payment until maturity{l.maturity ? ` (${formatDate(l.maturity)})` : ''}: the shocked columns show what a refinance at that rate would cost.</div>}
      </div>

      {missing.length === 0 && (
        <>
          <div style={{ ...card, padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums' }}>
            <strong>{bps(chosen)}: </strong>
            {passChip(fixed ? focus.r.passAtRefinance : focus.r.pass)}
            <span>DSCR <strong>{x(fixed ? focus.r.dscrAtRefinance : focus.r.dscr)}</strong> vs {x(focus.r.covenant)}</span>
            <span>Break-Even Rate <strong>{breakEvenText(focus.r.breakEvenRate)}</strong></span>
            <span>Headroom <strong>{typeof focus.r.headroomBps === 'number' ? bps(focus.r.headroomBps) : shockText(focus.r.headroomBps)}</strong></span>
            {fixed && <span>Today <strong><Amount value={focus.r.baseDebtService} /></strong> a year, unchanged until maturity</span>}
          </div>
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr><th />{columns.map((c) => <th key={c.bps} style={{ ...num, background: c.bps === chosen ? 'var(--wk-brand-tint, #e8ecfd)' : undefined }}>{c.bps === 0 ? 'Today' : bps(c.bps)}</th>)}</tr></thead>
                <tbody>
                  {rowsOut.map(([title, cell], i) => (
                    <tr key={title} style={i % 2 ? { background: 'var(--bg-secondary)' } : undefined}>
                      <td style={{ fontWeight: 600 }}>{title}</td>
                      {columns.map((c) => <td key={c.bps} style={{ ...num, background: c.bps === chosen ? 'rgba(43,69,225,0.06)' : undefined }}>{cell(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div style={{ ...card, padding: 12, display: 'grid', gap: 8 }}>
        <strong style={{ fontSize: '0.82rem' }}>Saved Scenarios</strong>
        {!scenarios.length && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>None saved for this loan yet.</span>}
        {scenarios.map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '2px 10px' }} onClick={() => apply(s)}>Apply</button>
            <span style={{ fontWeight: 600 }}>{s.name}</span>
            <span style={{ color: 'var(--text-muted)' }}>{bps(s.params?.shockBps ?? 0)} · NOI <Amount value={s.params?.noi} /> · {s.by}{s.at ? `, ${formatDate(s.at)}` : ''}</span>
            {canEdit && <button type="button" aria-label={`Remove ${s.name}`} onClick={() => removeScenario(s)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', marginLeft: 'auto' }}><Trash2 size={13} /></button>}
          </div>
        ))}
        {canEdit && missing.length === 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" aria-label="Scenario name" placeholder={`${bps(chosen)} on ${pct(p.ratePct)}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={{ ...control, minWidth: 220 }} />
            <button type="button" className="secondary-btn" onClick={saveScenario} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}><Save size={14} /> {saving ? 'Saving...' : 'Save Scenario'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stress Test - Portfolio, a full-width tab (Charmi, Oct 7) ───────────────
// "Not a pop-up - a separate tab, full width", with filters, banding, a
// choice of NOI, an Addback column and edit / delete per row:
//   - Filters: entity, lender, loan type (Fixed / Variable / Line of
//     Credit), Below Covenant Only, a search box, and Show Excluded.
//   - NOI basis per entity, with a page-wide default: T12 (the ledger's
//     trailing twelve months, as on the Loans review), Annualized YTD (this
//     year to the period's end, x 365 / days) or Manual (typed).
//   - Addback per entity (typed, with a note - depreciation, one-off costs,
//     owner comp): Adjusted NOI = NOI + Addback drives the DSCR. Kept and
//     audited on the server (accounting_loan_plans.py), shown in exports.
//   - Per loan: the pencil opens Change Loan; the trash takes the loan out of
//     the stress run (restorable under Show Excluded) - it does NOT delete
//     the loan (that is the trash on the Loans tab).
export const NOI_BASES = [['t12', 'T12'], ['ytd', 'Annualized YTD'], ['manual', 'Manual']];
const basisLabel = (b) => (NOI_BASES.find(([k]) => k === b) || NOI_BASES[0])[1];
const LOAN_KINDS = [['all', 'All Types'], ['fixed', 'Fixed'], ['floating', 'Variable'], ['loc', 'Line of Credit']];
const iconBtn = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 };

/** NOI per entity: the basis picked (or the page default), the addback, the adjusted figure. */
export function entityNois(entities, { settings = {}, defaultBasis = 't12', t12 = {}, ytd = {} } = {}) {
  const out = {};
  entities.forEach((code) => {
    const s = settings[code] || {};
    const basis = s.noiBasis || defaultBasis;
    const base = basis === 'manual' ? (s.noiManual ?? null) : basis === 'ytd' ? (ytd[code]?.annualized ?? null) : (t12[code] ?? null);
    const addback = Number(s.addback) || 0;
    out[code] = { basis, base, addback, note: s.addbackNote || '', adjusted: base == null ? null : Math.round((Number(base) + addback) * 100) / 100 };
  });
  return out;
}

/** The loans the filters let through (before the shock). */
export function stressFilter(loans, { entity = '', lender = '', kind = 'all', text = '', excluded = new Set(), showExcluded = false } = {}) {
  const q = text.trim().toLowerCase();
  return loans.filter((r) => {
    const l = normalizeLoan(r);
    if (!showExcluded && excluded.has(String(r.id))) return false;
    if (entity && l.entityCode !== entity) return false;
    if (lender && (r.lender || '') !== lender) return false;
    if (kind === 'loc' && !r.lineOfCredit) return false;
    if ((kind === 'fixed' || kind === 'floating') && l.rateType !== kind) return false;
    return !q || [r.lender, r.loanNo, r.entityName, r.entityCode].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function AddbackCell({ code, name, value, note, canEdit, onSave }) {
  const [text, setText] = useState(note);     // keyed on the note by its row: a new note from the server starts it over
  if (!canEdit) {
    return <span title={note || undefined}>{value ? <Amount value={value} /> : <span style={{ color: 'var(--text-muted)' }}>-</span>}{note ? <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{note}</span> : null}</span>;
  }
  return (
    <div style={{ display: 'grid', gap: 3, minWidth: 140 }}>
      <AmountInput aria-label={`Addback of ${name}`} value={value || null} onChange={(v) => onSave(code, { addback: v })} style={{ ...control, width: 130, textAlign: 'right' }} />
      <input type="text" aria-label={`Addback note of ${name}`} placeholder="Note (e.g. depreciation)" value={text} maxLength={300}
        onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== note) onSave(code, { addbackNote: text }); }}
        style={{ ...control, width: 130, height: 24, fontSize: '0.7rem' }} />
    </div>
  );
}

// The portfolio table's columns: [key (saved widths), header, figure].
const STRESS_COLUMNS = [
  ['entity', 'Entity'], ['loans', 'Loans'], ['basis', 'NOI Basis'], ['noi', 'NOI', true], ['addback', 'Addback', true], ['adjusted', 'Adjusted NOI', true],
  ['dsToday', 'Debt Service Today', true], ['dsStressed', 'Debt Service Stressed', true], ['dscr', 'DSCR', true], ['result', 'Result'], ['cushion', 'NOI Cushion', true], ['breakEven', 'Break-Even Shock', true],
];

export function LoanStressPortfolio({ loans = [], canEdit = false, to = '', onEditLoan = null }) {
  const customize = useCustomizePrefs(['density', 'pageSize']);
  const py = DENSITIES.find((d) => d.key === customize.density)?.py || '5px';
  const cw = useColumnWidths('loanStress');
  const [pick, setPick] = useState(200);
  const [custom, setCustom] = useState('');
  const [overrides, setOverrides] = useState({});
  const [exporting, setExporting] = useState('');
  const [defaultBasis, setDefaultBasis] = useState('t12');
  const [settings, setSettings] = useState({});
  const [excluded, setExcluded] = useState(() => new Set());
  const [ytd, setYtd] = useState({ key: '', data: {} });
  const [error, setError] = useState('');
  const [f, setF] = useState({ entity: '', lender: '', kind: 'all', text: '', belowOnly: false, showExcluded: false });
  const setFilter = (patch) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    let alive = true;
    api.getLoanStressSettings?.()
      ?.then((d) => { if (alive) { setSettings(d?.entities || {}); setExcluded(new Set(d?.excluded || [])); } })
      ?.catch(() => { /* none kept, or not available here: the test still runs on T12 */ });
    return () => { alive = false; };
  }, []);

  const shock = pick === 'custom' ? (Number.isNaN(Number(custom)) ? 0 : Math.round(Number(custom) || 0)) : pick;
  const active = useMemo(() => loans.filter((r) => r.isActive !== false && (Number(r.balance) || 0) > 0), [loans]);
  const shown = useMemo(() => stressFilter(active, { ...f, excluded }), [active, f, excluded]);
  const codes = useMemo(() => [...new Set(shown.map((r) => normalizeLoan(r).entityCode).filter(Boolean))].sort(), [shown]);
  const t12 = useMemo(() => Object.fromEntries(active.map((r) => [normalizeLoan(r).entityCode, normalizeLoan(r).noiT12])), [active]);

  // Annualized YTD is read only for the entities that use it.
  const needYtd = codes.filter((c) => (settings[c]?.noiBasis || defaultBasis) === 'ytd');
  const ytdKey = `${needYtd.join(',')}|${to}`;
  useEffect(() => {
    if (!needYtd.length || !api.getLoanEntityNoi) return undefined;
    let alive = true;
    api.getLoanEntityNoi({ entities: needYtd, to }).then((d) => { if (alive) setYtd({ key: ytdKey, data: d?.entities || {} }); })
      .catch((e) => { if (alive) { setYtd({ key: ytdKey, data: {} }); setError(e?.message || 'Could not read the year-to-date NOI.'); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytdKey]);
  const ytdLoading = needYtd.length > 0 && ytd.key !== ytdKey;

  const nois = useMemo(() => entityNois(codes, { settings, defaultBasis, t12, ytd: ytd.data }), [codes, settings, defaultBasis, t12, ytd.data]);
  const entityNoi = useMemo(() => Object.fromEntries(Object.entries(nois).filter(([, n]) => n.adjusted != null).map(([c, n]) => [c, n.adjusted])), [nois]);
  const out = useMemo(() => stressPortfolio(shown.filter((r) => !excluded.has(String(r.id))), { shockBps: shock, overrides, entityNoi }), [shown, excluded, shock, overrides, entityNoi]);
  const rowsShown = f.belowOnly ? out.entities.filter((e) => !e.pass) : out.entities;
  // Rows per Page: the entities on this page; the totals and the export cover all of them.
  const paged = usePaged(rowsShown, customize.pageSize, [f, shock, defaultBasis]);
  const excludedShown = shown.filter((r) => excluded.has(String(r.id)));
  const noRate = shown.filter((r) => !excluded.has(String(r.id)) && normalizeLoan(r).ratePct == null).length;
  const lenders = useMemo(() => [...new Set(active.map((r) => r.lender || '').filter(Boolean))].sort((a, b) => a.localeCompare(b)), [active]);
  const entityList = useMemo(() => [...new Map(active.map((r) => [normalizeLoan(r).entityCode, normalizeLoan(r).entityName])).entries()].map(([code, name]) => ({ code, name })), [active]);

  const saveEntity = (code, patch) => {
    setSettings((m) => ({ ...m, [code]: { ...(m[code] || {}), ...patch } }));
    if (!api.saveLoanStressEntity) return;
    api.saveLoanStressEntity(code, patch)
      .then((d) => { if (d?.entity) setSettings((m) => ({ ...m, [code]: d.entity })); })
      .catch((e) => setError(e?.message || 'Could not save it.'));
  };
  const setLoanExcluded = (loan, on) => {
    const id = String(loan.id);
    setExcluded((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    api.setLoanStressExcluded?.(id, on)?.catch?.((e) => {
      setExcluded((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n; });
      setError(e?.message || 'Could not change it.');
    });
  };

  const doExport = async (format) => {
    setExporting(format);
    try {
      const { linesFile } = await import('./linesExport');
      const table = {
        title: `Loan Stress Test - ${bps(shock)}`,
        subtitle: `${out.totals.entities} entities · ${out.totals.loans} loans · ${out.totals.failing} below covenant${excluded.size ? ` · ${excluded.size} left out` : ''}`,
        columns: [{ label: 'Entity', width: 200 }, { label: 'Loans', width: 200 }, { label: 'NOI Basis', width: 90 }, { label: 'NOI', num: true, width: 110 }, { label: 'Addback', num: true, width: 100 },
          { label: 'Addback Note', width: 140 }, { label: 'Adjusted NOI', num: true, width: 110 }, { label: 'Debt Service Today', num: true, width: 120 },
          { label: 'Debt Service Stressed', num: true, width: 120 }, { label: 'DSCR Today', width: 70 }, { label: 'DSCR Stressed', width: 80 }, { label: 'Covenant', width: 70 },
          { label: 'Result', width: 100 }, { label: 'NOI Cushion', num: true, width: 110 }, { label: 'Break-Even Shock', width: 100 }],
        rows: rowsShown.map((e) => {
          const n = nois[e.entityCode] || {};
          return [e.entityName, e.loans.map((y) => `${y.lender || y.loanNo}${y.rateType === 'fixed' ? ' (fixed)' : ''}`).join(', '), basisLabel(n.basis), n.base ?? '', n.addback || '', n.note || '', e.noi,
            e.baseDebtService, e.debtService, x(e.dscrBase), x(e.dscr), x(e.covenant), e.pass ? 'Pass' : 'Below Covenant', e.cushion, shockText(e.breakEvenShockBps)];
        }),
        totals: ['Total', `${out.totals.loans} loans`, '', '', '', '', out.totals.noi, out.totals.baseDebtService, out.totals.debtService, '', x(out.totals.dscr), '', `${out.totals.failing} below`, '', ''],
      };
      const file = await linesFile(table, format);
      downloadBlob(file.name, file);
    } finally {
      setExporting('');
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{`
        .acct-stress tbody tr:nth-of-type(even) > td { background: color-mix(in srgb, var(--bg-secondary), var(--text-primary) 4%); }
        .acct-stress tbody tr.fail > td:first-child { box-shadow: inset 3px 0 0 var(--bad-fg, #dc2626); }
        .acct-stress thead th { position: sticky; top: 0; z-index: 1; background: var(--bg-card); }
        .acct-stress tbody td { padding-top: var(--stress-py, 5px); padding-bottom: var(--stress-py, 5px); }
      `}</style>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={{ ...label, margin: 0 }}>Shock</span>
        <ShockPicker value={pick} custom={custom} onPick={setPick} onCustom={(v) => { setCustom(v); setPick('custom'); }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}>
          <span style={{ ...label, margin: 0 }}>NOI</span>
          <select value={defaultBasis} onChange={(e) => setDefaultBasis(e.target.value)} aria-label="NOI basis for every entity" style={{ ...control }}>
            {NOI_BASES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
          <span>Debt Service <strong><Amount value={out.totals.baseDebtService} /></strong> to <strong><Amount value={out.totals.debtService} /></strong></span>
          <span>DSCR <strong>{x(out.totals.dscr)}</strong></span>
          <span>Below Covenant <strong style={{ color: out.totals.failing ? 'var(--bad-fg, #dc2626)' : undefined }}>{out.totals.failing}</strong></span>
        </div>
      </div>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <EntityPicker entities={entityList} value={f.entity} onChange={(code) => setFilter({ entity: code })} noneLabel="All Entities" showHistorical />
        <select value={f.lender} onChange={(e) => setFilter({ lender: e.target.value })} aria-label="Lender" style={{ ...control, maxWidth: 220 }}>
          <option value="">All Lenders</option>
          {lenders.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={f.kind} onChange={(e) => setFilter({ kind: e.target.value })} aria-label="Loan type" style={{ ...control }}>
          {LOAN_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input type="text" value={f.text} onChange={(e) => setFilter({ text: e.target.value })} placeholder="Filter loans" aria-label="Filter the stress test" style={{ ...control, width: 170 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}><input type="checkbox" data-nx-filter="1" checked={f.belowOnly} onChange={(e) => setFilter({ belowOnly: e.target.checked })} /> Below Covenant Only</label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}><input type="checkbox" data-nx-filter="1" checked={f.showExcluded} onChange={(e) => setFilter({ showExcluded: e.target.checked })} /> Show Excluded{excluded.size ? ` (${excluded.size})` : ''}</label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <CustomizeButton {...customize} />
          <ExportMenu disabled={!rowsShown.length} items={[
            { key: 'excel', label: 'Excel', hint: 'Every entity, totals in bold', onPick: () => doExport('excel'), busy: exporting === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per entity', onPick: () => doExport('csv'), busy: exporting === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => doExport('pdf'), busy: exporting === 'pdf' },
          ]} />
        </div>
      </div>
      {error && <div style={bad}>{error}</div>}
      {noRate > 0 && <div style={warn}>{noRate} {noRate === 1 ? 'loan has' : 'loans have'} no rate on file and {noRate === 1 ? 'is' : 'are'} tested at 0% - type the rate on the loan (pencil) to include it properly.</div>}
      {ytdLoading && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Reading the year-to-date NOI from the ledger...</div>}
      {!rowsShown.length ? <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{f.belowOnly && out.entities.length ? 'No entity is below its covenant at this shock.' : 'No active loans with a balance to test.'}</div> : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div className="req-table-wrapper" style={{ overflow: 'auto', maxHeight: '70vh' }}>
            <table className="req-table acct-stress" style={{ fontVariantNumeric: 'tabular-nums', '--stress-py': py }}>
              <thead>
                <tr>
                  {STRESS_COLUMNS.map(([k, l, isNum]) => (
                    <th key={k} aria-label={l} style={headStyle(cw.width(k), isNum ? num : null)}>{l}<ColumnResizer {...cw.resizer(k, l)} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((e) => {
                  const n = nois[e.entityCode] || { basis: defaultBasis, base: null, addback: 0, note: '' };
                  const s = settings[e.entityCode] || {};
                  return (
                    <tr key={e.entityCode} className={e.pass ? undefined : 'fail'}>
                      <td style={cellStyle(cw.width('entity'), { fontWeight: 600, minWidth: cw.width('entity') || 180 })} title={cw.width('entity') ? e.entityName : undefined}>{e.entityName}</td>
                      <td style={cellStyle(cw.width('loans'), { fontSize: '0.74rem' })}>
                        {e.loans.map((y) => (
                          <div key={y.id} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                            <span>{y.lender || y.loanNo || 'Loan'} · {pct(y.ratePct)}</span>
                            <select aria-label={`Rate type of ${y.lender || y.loanNo}`} value={y.rateType} onChange={(ev) => setOverrides((o) => ({ ...o, [y.id]: { ...o[y.id], rateType: ev.target.value } }))}
                              style={{ ...control, height: 22, fontSize: '0.7rem', padding: '0 4px' }}>
                              <option value="floating">Variable</option><option value="fixed">Fixed</option>
                            </select>
                            {onEditLoan && <button type="button" aria-label={`Edit ${y.lender || y.loanNo}`} title="Change Loan" onClick={() => onEditLoan(loans.find((r) => String(r.id) === String(y.id)) || y)} style={iconBtn}><Pencil size={12} /></button>}
                            {canEdit && <button type="button" aria-label={`Leave ${y.lender || y.loanNo} out of the stress test`} title="Leave out of the stress test (restorable under Show Excluded)" onClick={() => setLoanExcluded(y, true)} style={iconBtn}><Trash2 size={12} /></button>}
                          </div>
                        ))}
                      </td>
                      <td style={cellStyle(cw.width('basis'))}>
                        <select value={s.noiBasis || ''} disabled={!canEdit} onChange={(ev) => saveEntity(e.entityCode, { noiBasis: ev.target.value })} aria-label={`NOI basis of ${e.entityName}`} style={{ ...control, height: 26, fontSize: '0.72rem' }}>
                          <option value="">Default ({basisLabel(defaultBasis)})</option>
                          {NOI_BASES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </td>
                      <td style={cellStyle(cw.width('noi'), num)}>
                        {n.basis === 'manual' && canEdit
                          ? <AmountInput aria-label={`NOI of ${e.entityName}`} value={s.noiManual ?? null} onChange={(v) => saveEntity(e.entityCode, { noiManual: v })} style={{ ...control, width: 120, textAlign: 'right' }} />
                          : n.base == null ? <span style={{ color: 'var(--text-muted)' }}>{n.basis === 'ytd' && ytdLoading ? '...' : '-'}</span> : <Amount value={n.base} />}
                      </td>
                      <td style={cellStyle(cw.width('addback'), num)}><AddbackCell key={`${e.entityCode}|${n.note}`} code={e.entityCode} name={e.entityName} value={n.addback} note={n.note} canEdit={canEdit} onSave={saveEntity} /></td>
                      <td style={cellStyle(cw.width('adjusted'), num)}><strong><Amount value={e.noi} /></strong></td>
                      <td style={cellStyle(cw.width('dsToday'), num)}><Amount value={e.baseDebtService} /></td>
                      <td style={cellStyle(cw.width('dsStressed'), num)}><Amount value={e.debtService} /></td>
                      <td style={cellStyle(cw.width('dscr'), num)}><Figure text={`${x(e.dscrBase)} to ${x(e.dscr)}`} /></td>
                      <td style={cellStyle(cw.width('result'))}>{passChip(e.pass)} <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>min {x(e.covenant)}</span></td>
                      <td style={cellStyle(cw.width('cushion'), num)}><Amount value={e.cushion} /></td>
                      <td style={cellStyle(cw.width('breakEven'), num)}>{shockText(e.breakEvenShockBps)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)' }} />
        </div>
      )}
      {f.showExcluded
 && excludedShown.length > 0 && (
        <div style={{ ...card, padding: 12, display: 'grid', gap: 6 }}>
          <strong style={{ fontSize: '0.82rem' }}>Left Out of the Stress Test</strong>
          {excludedShown.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
              <span style={{ flex: 1 }}>{r.lender || r.loanNo} - {r.entityName} · <Amount value={r.balance} /></span>
              {canEdit && <button type="button" className="secondary-btn" onClick={() => setLoanExcluded(r, false)} style={{ fontSize: '0.74rem', padding: '2px 10px' }}>Restore</button>}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Adjusted NOI = NOI (the basis picked) + Addback, and drives the DSCR. Fixed loans keep today's payment. Break-even shock is the rise at which the entity's DSCR falls to its covenant.</div>
    </div>
  );
}

function Dialog({ title, subtitle, onClose, children, width = 980 }) {
  const backdrop = useBackdropClose(onClose);
  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width, width: '100%' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            {subtitle && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 18px', maxHeight: '78vh', overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

/** One loan's stress test in a dialog - opened from a Loans row. */
export function LoanStressDialog({ loan, canEdit = false, onClose }) {
  const l = normalizeLoan(loan);
  return (
    <Dialog title="Stress Test" subtitle={`${l.lender || 'Loan'}${l.loanNo ? ` #${l.loanNo}` : ''}${l.entityName ? ` · ${l.entityName}` : ''}`} onClose={onClose}>
      <LoanStress loan={loan} canEdit={canEdit} />
    </Dialog>
  );
}

/** Every loan under one shock in a dialog (kept for old callers; the Loans
 *  screen shows it as its own Stress Test tab now). */
export function LoanStressPortfolioDialog({ loans, onClose }) {
  return (
    <Dialog title="Stress Test - Portfolio" subtitle="Every active loan under the same rate shock, entity by entity." onClose={onClose} width={1180}>
      <LoanStressPortfolio loans={loans} />
    </Dialog>
  );
}
