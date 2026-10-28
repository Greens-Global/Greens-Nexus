// Paid leave balances (Neil / Charmi call, Oct 19 2026) - the rules live in
// backend/leave_balances.py. Two surfaces:
//   LeaveBalanceCard   - an employee's own vacation and sick time (Workday >
//                        Time Off), plus balanceFor() for the request form.
//   LeaveBalancesAdmin - People > Time > Time Off (HR; it was People > Leave
//                        until Oct 27 2026): the start date, the one-time import of
//                        the QuickBooks balances, everyone's balance, a
//                        person's policy, corrections, and the policies.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { SkeletonBlocks, Spinner } from './AsyncState';

// Which balance a leave type draws from - the same words as the server's
// leave_balances.bucket_of (sick and personal are one balance).
export function bucketOf(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  if (/vacation|pto|paid time off|annual/.test(n)) return 'vacation';
  if (/sick|personal|medical/.test(n)) return 'sick';
  return '';
}

const day = (d) => (d ? formatDate(`${String(d).slice(0, 10)}T12:00:00`) : '');
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "12.5 h", or "2 days" on a policy kept in days (India salaried).
export function fmtLeave(hours, policy) {
  const h = Number(hours) || 0;
  if (policy?.unit === 'days') {
    const d = round(h / (Number(policy.hoursPerDay) || 8));
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${round(h)} h`;
}

const LABEL = { vacation: 'Vacation', sick: 'Sick / Personal' };
const KIND = { opening: 'Opening Balance', accrual: 'Earned', used: 'Used', adjust: 'Adjustment',
  expire: 'Expired At Year End', carryover: 'Carried Over' };

// What the year end does to a bucket (leave_year_end.py, Oct 27 2026): Use
// It Or Lose It by default; California vacation never expires.
function yearEndHint(b, bucket, policy) {
  const y = b?.yearEnd?.[bucket];
  if (!y) return bucket === 'sick' ? `Use by ${day(b?.sick?.expiresOn)} - it doesn't carry over.` : '';
  if (y.exempt) return 'It carries over - California vacation does not expire.';
  if (y.effectiveMode === 'carry_all') return 'Unused time carries over.';
  if (y.effectiveMode === 'carry_cap') return `Up to ${fmtLeave(y.capHours, policy)} carries past ${day(y.nextClosing)}; the rest expires.`;
  return `Use by ${day(y.nextClosing)} - unused time expires.`;
}

function bucketHint(b, bucket, policy) {
  const x = b?.[bucket];
  if (!x) return '';
  if (bucket === 'sick') {
    if (x.method === 'none') return 'Not part of your policy.';
    if (!x.eligible && x.eligibleOn) return `Starts ${day(x.eligibleOn)}.`;
    return yearEndHint(b, 'sick', policy);
  }
  if (x.method === 'none') return 'Not part of your policy.';
  const end = yearEndHint(b, 'vacation', policy);
  if (x.method === 'per_hour') {
    if (x.accrualPerHour > 0) return `You earn ${round(x.accrualPerHour * 60)} min for every hour you work. ${end}`.trim();
    return x.next?.date ? `You start earning on ${day(x.next.date)}.` : 'You start earning after your first year.';
  }
  if (x.next?.date) return `${fmtLeave(x.next.hours, policy)} added on ${day(x.next.date)}. ${end}`.trim();
  return end;
}

// ── Employee ────────────────────────────────────────────────────────────────

export function useMyLeaveBalance() {
  const [bal, setBal] = useState(null);
  const load = useCallback(() => { api.leaveMyBalance().then(setBal).catch(() => setBal({ live: false })); }, []);
  useEffect(() => { load(); }, [load]);
  return [bal, load];
}

export function LeaveBalanceCard({ balance }) {
  if (balance === null) {
    return <div style={CARD}><SkeletonBlocks count={1} height={54} /></div>;
  }
  if (!balance?.live) return null;      // HR hasn't set balances up yet
  const pol = balance.policy;
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="wkc-chip"><CalendarClock size={14} /></span>
        <span style={HD}>My Paid Time Off</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{pol?.name}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {['vacation', 'sick'].map(k => {
          const x = balance[k] || {};
          return (
            <div key={k} style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '11px 13px', background: 'var(--mist)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{LABEL[k]}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', margin: '2px 0' }}>{fmtLeave(x.available, pol)}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{bucketHint(balance, k, pol)}</div>
              {(x.upcoming > 0 || x.pending > 0) && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {x.upcoming > 0 && <>{fmtLeave(x.upcoming, pol)} approved and coming up. </>}
                  {x.pending > 0 && <>{fmtLeave(x.pending, pol)} waiting for approval.</>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The line under the request form's Reason: what this type draws from and
// whether the request fits (the rest would be unpaid).
export function RequestBalanceHint({ balance, type, hours }) {
  const bucket = bucketOf(type);
  if (!balance?.live || !bucket || !balance[bucket]) return null;
  const x = balance[bucket];
  const have = (Number(x.available) || 0) - (Number(x.upcoming) || 0);
  const over = hours > 0 && hours > have + 0.001;
  return (
    <div style={{ fontSize: 12, color: over ? '#b45309' : 'var(--muted)' }}>
      {LABEL[bucket]} balance: {fmtLeave(have, balance.policy)} available.
      {over && <> This request is {fmtLeave(hours, balance.policy)} - the part over your balance would be unpaid.</>}
    </div>
  );
}

// ── HR ──────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  // email, vacation, sick - a header row is skipped; commas or tabs.
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = line.split(/[,\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
    if (!cells[0] || !cells[0].includes('@')) continue;
    const num = (v) => (v === undefined || v === '' ? null : Number(v));
    rows.push({ email: cells[0].toLowerCase(), vacation: num(cells[1]), sick: num(cells[2]) });
  }
  return rows;
}

const EMP_TYPES = [['full_time', 'Full Time'], ['part_time', 'Part Time'], ['contractor', 'Contractor'], ['intern', 'Intern']];

export default function LeaveBalancesAdmin({ toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [cut, setCut] = useState('');
  const [cutCo, setCutCo] = useState('');          // '' = the organization's start date; else a company's own (Oct 23)
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState('');            // 'import' | 'policies' | ''
  const [q, setQ] = useState('');
  const [person, setPerson] = useState(null);      // expanded email

  const load = useCallback(() => {
    setErr('');
    return api.leaveAdmin().then(d => { setData(d); setCut(d.cutover || ''); setCutCo(''); })
      .catch(e => { setErr(e?.status === 403 ? '' : (e?.message || 'Could not load leave balances.')); setData(e?.status === 403 ? false : null); });
  }, []);
  useEffect(() => { load(); }, [load]);

  if (data === false) return null;                 // not HR - nothing to show
  if (err) return <div style={{ ...CARD, color: 'hsl(var(--color-red))', fontSize: 13 }}>{err} <button className="secondary-btn" onClick={load} style={{ marginLeft: 8, fontSize: 12 }}>Retry</button></div>;
  if (data === null) return <div style={CARD}><SkeletonBlocks count={3} height={18} /></div>;

  const pols = data.policies || [];
  const polName = Object.fromEntries(pols.map(p => [p.id, p.name]));

  const cutRow = cutCo ? (data.companies || []).find(c => c.id === cutCo) : null;
  const savedCut = cutRow ? cutRow.cutover : (data.cutover || '');
  function pickCutCo(id) { setCutCo(id); const row = (data.companies || []).find(c => c.id === id); setCut((row ? row.cutover : data.cutover) || ''); }
  async function saveCutover(reset = false) {
    if (!cut && !reset) return;
    setBusy('cut');
    try {
      await api.leaveSetCutover(cut, cutCo, reset);
      toastOk?.(reset ? `${cutRow?.name || 'The company'} follows the organization's start date again.` : 'Start date saved.');
      await load();
    } catch (e) { toastErr?.(e?.message || 'Could not save the start date.'); }
    setBusy('');
  }
  async function recalc() {
    setBusy('recalc');
    try {
      const r = await api.leaveRecalculate();
      toastOk?.(`Recalculated ${r.periods} finalized pay period${r.periods === 1 ? '' : 's'}.${r.failed?.length ? ` ${r.failed.length} could not be read.` : ''}`);
      await load();
    } catch (e) { toastErr?.(e?.message || 'Could not recalculate.'); }
    setBusy('');
  }
  async function assign(email, pid) {
    try { await api.leaveAssign(email, pid); toastOk?.('Policy updated.'); await load(); }
    catch (e) { toastErr?.(e?.message || 'Could not change the policy.'); }
  }

  const needle = q.trim().toLowerCase();
  const people = (data.people || []).filter(p => !needle || p.name.toLowerCase().includes(needle) || p.email.includes(needle));

  return (
    <div style={{ ...CARD, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="wkc-chip"><CalendarClock size={14} /></span>
        <span style={HD}>Leave Balances</span>
        <span style={{ flex: 1 }} />
        {data.canSetup && data.cutover && (
          <button className="secondary-btn" onClick={recalc} disabled={busy === 'recalc'} title="Rebuild earned and used hours from every finalized pay period since the start date"
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'recalc' ? <Spinner size={12} /> : <RefreshCw size={12} />} Recalculate
          </button>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, maxWidth: 760 }}>
        Vacation and sick time in hours. Import what each person had in QuickBooks on the start date once; after that Nexus keeps it from finalized pay periods - vacation earned per hour worked, and the sick and vacation hours paid on the time sheet.
      </div>

      {data.canSetup && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {(data.companies || []).length > 0 && (
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={LBL}>For</span>
              <select className="form-input" value={cutCo} onChange={e => pickCutCo(e.target.value)} style={{ fontSize: 12.5 }} aria-label="Start date for">
                <option value="">Every company</option>
                {data.companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.own ? ' (its own)' : ''}</option>)}
              </select>
            </label>
          )}
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={LBL}>Start Date</span>
            <input className="form-input" type="date" value={cut} onChange={e => setCut(e.target.value)} style={{ fontSize: 12.5 }} />
          </label>
          <button className="primary-btn" onClick={() => saveCutover(false)} disabled={!cut || cut === savedCut || busy === 'cut'} style={{ fontSize: 12.5 }}>
            {busy === 'cut' ? <Spinner size={12} /> : 'Save Start Date'}
          </button>
          {cutRow?.own && (
            <button className="secondary-btn" onClick={() => saveCutover(true)} disabled={busy === 'cut'} style={{ fontSize: 12.5 }}>Use the Organization's</button>
          )}
          <span style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 9 }}>
            {cutCo
              ? (cutRow?.own ? `${cutRow.name} counts from ${day(cutRow.cutover)}, its own date.` : `${cutRow?.name || 'This company'} follows the organization's date${data.cutover ? ` (${day(data.cutover)})` : ''}.`)
              : (data.cutover ? `Balances count from ${day(data.cutover)}. A company can have a date of its own: pick it under For.` : 'Nothing shows to employees until a start date is set.')}
          </span>
        </div>
      )}
      {!data.canSetup && !data.cutover && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>An administrator sets the start date before balances can be loaded.</div>
      )}

      {data.cutover && (
        <Section title="Import Opening Balances" open={open === 'import'} onToggle={() => setOpen(open === 'import' ? '' : 'import')}>
          <ImportPanel onDone={load} toastOk={toastOk} toastErr={toastErr} cutover={data.cutover} />
        </Section>
      )}
      {data.canSetup && (
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 10px' }}>The policies themselves are under Settings &gt; Time &amp; Pay &gt; Leave Policies.</div>
      )}

      {data.cutover && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 8px' }}>
            <input className="form-input" placeholder="Search people" value={q} onChange={e => setQ(e.target.value)} style={{ fontSize: 12.5, maxWidth: 260 }} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{people.length} people</span>
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ ...ROW, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--mist)' }}>
              <span style={{ flex: '1 1 180px' }}>Person</span>
              <span style={{ flex: '0 0 170px' }}>Policy</span>
              <span style={{ flex: '0 0 100px', textAlign: 'right' }}>Vacation</span>
              <span style={{ flex: '0 0 100px', textAlign: 'right' }}>Sick</span>
              <span style={{ flex: '0 0 120px' }}>Sick Starts</span>
            </div>
            {people.length === 0 && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>No one matches.</div>}
            {people.map(p => (
              <div key={p.email} style={{ borderTop: '1px solid var(--line)' }}>
                <div style={{ ...ROW, cursor: 'pointer' }} onClick={() => setPerson(person === p.email ? null : p.email)}>
                  <span style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {person === p.email ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span style={{ fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  </span>
                  <span style={{ flex: '0 0 170px' }} onClick={e => e.stopPropagation()}>
                    <select className="form-input" value={p.policy?.assigned ? p.policy.id : ''} onChange={e => assign(p.email, e.target.value)}
                      aria-label={`Leave policy for ${p.name}`} style={{ fontSize: 12, padding: '4px 6px' }}>
                      <option value="">{p.policy?.assigned ? 'Default' : `Default (${polName[p.policy?.id] || p.policy?.name})`}</option>
                      {pols.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </span>
                  <span style={{ flex: '0 0 100px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtLeave(p.vacation?.available, p.policy)}</span>
                  <span style={{ flex: '0 0 100px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtLeave(p.sick?.available, p.policy)}</span>
                  <span style={{ flex: '0 0 120px', color: 'var(--muted)', fontSize: 12 }}>
                    {!p.startDate ? 'No start date' : p.sick?.eligible ? 'Eligible' : p.sick?.eligibleOn ? day(p.sick.eligibleOn) : '-'}
                  </span>
                </div>
                {person === p.email && <PersonDetail email={p.email} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, open, onToggle, children }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8 }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '10px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--ink)', fontFamily: 'inherit' }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
      </button>
      {open && <div style={{ padding: '0 12px 12px' }}>{children}</div>}
    </div>
  );
}

function ImportPanel({ onDone, toastOk, toastErr, cutover }) {
  const [text, setText] = useState('');
  const [unit, setUnit] = useState('hours');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const rows = parseCsv(text);

  async function readFile(e) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
    e.target.value = '';
  }
  async function run() {
    if (!rows.length) return;
    setBusy(true);
    try {
      const r = await api.leaveImport({ unit, rows });
      setResult(r);
      toastOk?.(`Imported ${r.imported} ${r.imported === 1 ? 'person' : 'people'}.`);
      if (!r.errors?.length) setText('');
      onDone?.();
    } catch (e) { toastErr?.(e?.message || 'Could not import.'); }
    setBusy(false);
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        One row per person: work email, vacation, sick - what they had left in QuickBooks on {day(cutover)}. Paste it or choose a CSV file. Importing someone again replaces their opening numbers.
      </div>
      <textarea className="form-input" rows={6} value={text} onChange={e => setText(e.target.value)} aria-label="Opening balances"
        placeholder={'email,vacation,sick\nmiranda@greensglobal.com,32,16'} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, resize: 'vertical' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Upload size={12} /> Choose CSV
          <input type="file" accept=".csv,text/csv,text/plain" onChange={readFile} style={{ display: 'none' }} />
        </label>
        <select className="form-input" value={unit} onChange={e => setUnit(e.target.value)} aria-label="Numbers are in" style={{ fontSize: 12, width: 'auto' }}>
          <option value="hours">Numbers Are Hours</option>
          <option value="days">Numbers Are Days</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} {rows.length === 1 ? 'row' : 'rows'} read</span>
        <span style={{ flex: 1 }} />
        <button className="primary-btn" onClick={run} disabled={!rows.length || busy} style={{ fontSize: 12.5 }}>
          {busy ? <Spinner size={12} /> : 'Import'}
        </button>
      </div>
      {result?.errors?.length > 0 && (
        <div style={{ fontSize: 12, color: '#b45309' }}>
          {result.errors.length} {result.errors.length === 1 ? 'row was' : 'rows were'} skipped:
          {result.errors.slice(0, 20).map(e => <div key={`${e.row}-${e.email}`}>Row {e.row} ({e.email || 'no email'}): {e.error}</div>)}
        </div>
      )}
    </div>
  );
}

function PersonDetail({ email, onChanged, toastOk, toastErr }) {
  const [b, setB] = useState(null);
  const [form, setForm] = useState({ bucket: 'vacation', hours: '', note: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.leavePersonBalance(email).then(setB).catch(() => setB(false)), [email]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    const hours = Number(form.hours);
    if (!hours) { toastErr?.('Enter the hours to add, or a negative number to take away.'); return; }
    if (!form.note.trim()) { toastErr?.('Add a note saying why.'); return; }
    setBusy(true);
    try {
      await api.leaveAdjust({ email, bucket: form.bucket, hours, note: form.note.trim() });
      toastOk?.('Balance adjusted.');
      setForm({ bucket: form.bucket, hours: '', note: '' });
      await load(); onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not adjust the balance.'); }
    setBusy(false);
  }

  if (b === null) return <div style={{ padding: 12 }}><SkeletonBlocks count={2} height={14} /></div>;
  if (b === false) return <div style={{ padding: 12, fontSize: 12.5, color: 'var(--muted)' }}>Could not load this person's balance.</div>;
  const pol = b.policy;
  const lines = [
    ...(b.sick?.grant ? [{ id: 'g-sick', bucket: 'sick', kind: 'Yearly Grant', hours: b.sick.grant.hours, date: b.sick.grant.date, note: `Policy ${pol.name}` }] : []),
    ...((b.vacation?.grants || []).map((g, i) => ({ id: `g-vac-${i}`, bucket: 'vacation', kind: 'Anniversary Grant', hours: g.hours, date: g.date, note: g.note }))),
    ...((b.entries || []).map(e => ({ ...e, kind: KIND[e.kind] || e.kind }))),
  ].sort((x, y) => String(y.date).localeCompare(String(x.date)));
  return (
    <div style={{ padding: '4px 14px 14px 32px', background: 'var(--mist)' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 8px' }}>
        {pol.name} - started {b.startDate ? day(b.startDate) : 'date not on file'}, {(EMP_TYPES.find(([v]) => v === b.employmentType) || ['', b.employmentType || 'type not set'])[1]}.
        {' '}Vacation: {bucketHint(b, 'vacation', pol)} Sick: {bucketHint(b, 'sick', pol)}
      </div>
      {b.canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
          <select className="form-input" value={form.bucket} onChange={e => setForm(f => ({ ...f, bucket: e.target.value }))} aria-label="Balance" style={{ fontSize: 12, width: 'auto' }}>
            <option value="vacation">Vacation</option>
            <option value="sick">Sick / Personal</option>
          </select>
          <input className="form-input" type="number" step="0.25" placeholder="Hours (+/-)" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} aria-label="Hours" style={{ fontSize: 12, width: 110 }} />
          <input className="form-input" placeholder="Why (required)" value={form.note} maxLength={300} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} aria-label="Note" style={{ fontSize: 12, flex: '1 1 200px' }} />
          <button className="secondary-btn" onClick={add} disabled={busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy ? <Spinner size={11} /> : <Plus size={12} />} Adjust
          </button>
        </div>
      )}
      {lines.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No changes yet. Import an opening balance or finalize a pay period.</div>
        : (
          <div style={{ display: 'grid', gap: 3, fontSize: 12 }}>
            {lines.slice(0, 60).map(l => (
              <div key={l.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ width: 82, color: 'var(--muted)' }}>{day(l.date)}</span>
                <span style={{ width: 110, fontWeight: 600 }}>{LABEL[l.bucket]}</span>
                <span style={{ width: 120 }}>{l.kind}</span>
                <span style={{ width: 70, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: l.hours < 0 ? '#b45309' : 'var(--ink)' }}>{l.hours > 0 ? '+' : ''}{round(l.hours)} h</span>
                <span style={{ flex: 1, minWidth: 140, color: 'var(--muted)' }}>{l.note}{l.by && l.by !== 'system' ? ` - ${l.by}` : ''}{l.at ? ` (${formatDateTime(l.at)})` : ''}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function PoliciesEditor({ policies, builtIn, onSaved, toastOk, toastErr }) {
  const [list, setList] = useState(() => policies.map(p => JSON.parse(JSON.stringify(p))));
  const [busy, setBusy] = useState(false);
  const upd = (i, fn) => setList(l => l.map((p, j) => (j === i ? fn(JSON.parse(JSON.stringify(p))) : p)));

  async function save() {
    setBusy(true);
    try {
      const body = Object.fromEntries(list.map(p => { const { assigned, ...rest } = p; void assigned; return [p.id, rest]; }));
      await api.leaveSavePolicies(body);
      toastOk?.('Policies saved.');
      onSaved?.();
    } catch (e) { toastErr?.(e?.message || 'Could not save the policies.'); }
    setBusy(false);
  }
  function addPolicy() {
    const id = `custom-${Date.now().toString(36)}`;
    setList(l => [...l, { id, name: 'New Policy', unit: 'hours', hoursPerDay: 8, eligibleTypes: ['full_time'],
      sick: { method: 'lump', hours: 0, afterDays: 90 }, vacation: { method: 'none' } }]);
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Hours throughout. Sick time is given at once after the waiting period, for the calendar year, and does not carry over. Vacation is earned per hour worked (by years of service) or added on each work anniversary, and carries over. After a change, use Recalculate.
      </div>
      {list.map((p, i) => (
        <div key={p.id} style={{ border: '1px solid var(--wk-line2)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={FIELD}><span style={LBL}>Name</span>
              <input className="form-input" value={p.name} onChange={e => upd(i, x => ({ ...x, name: e.target.value }))} style={{ fontSize: 12 }} /></label>
            <label style={FIELD}><span style={LBL}>Show In</span>
              <select className="form-input" value={p.unit} onChange={e => upd(i, x => ({ ...x, unit: e.target.value }))} style={{ fontSize: 12 }}>
                <option value="hours">Hours</option><option value="days">Days</option>
              </select></label>
            <label style={{ ...FIELD, width: 90 }}><span style={LBL}>Hours a Day</span>
              <input className="form-input" type="number" value={p.hoursPerDay} onChange={e => upd(i, x => ({ ...x, hoursPerDay: e.target.value }))} style={{ fontSize: 12 }} /></label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingBottom: 8 }}>
              {EMP_TYPES.map(([v, l]) => (
                <label key={v} style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={(p.eligibleTypes || []).includes(v)}
                    onChange={e => upd(i, x => ({ ...x, eligibleTypes: e.target.checked ? [...(x.eligibleTypes || []), v] : (x.eligibleTypes || []).filter(t => t !== v) }))} /> {l}
                </label>
              ))}
            </div>
            {!builtIn.includes(p.id) && (
              <button onClick={() => setList(l => l.filter((_, j) => j !== i))} title="Remove this policy" aria-label={`Remove ${p.name}`}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', paddingBottom: 8 }}><X size={14} /></button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={FIELD}><span style={LBL}>Sick</span>
              <select className="form-input" value={p.sick?.method || 'none'} onChange={e => upd(i, x => ({ ...x, sick: e.target.value === 'lump' ? { method: 'lump', hours: x.sick?.hours || 0, afterDays: x.sick?.afterDays ?? 90 } : { method: 'none' } }))} style={{ fontSize: 12 }}>
                <option value="none">None</option><option value="lump">Given Each Year</option>
              </select></label>
            {p.sick?.method === 'lump' && <>
              <label style={{ ...FIELD, width: 100 }}><span style={LBL}>Hours a Year</span>
                <input className="form-input" type="number" value={p.sick.hours} onChange={e => upd(i, x => ({ ...x, sick: { ...x.sick, hours: e.target.value } }))} style={{ fontSize: 12 }} /></label>
              <label style={{ ...FIELD, width: 110 }}><span style={LBL}>After Days</span>
                <input className="form-input" type="number" value={p.sick.afterDays} onChange={e => upd(i, x => ({ ...x, sick: { ...x.sick, afterDays: e.target.value } }))} style={{ fontSize: 12 }} /></label>
            </>}
            <label style={FIELD}><span style={LBL}>Vacation</span>
              <select className="form-input" value={p.vacation?.method || 'none'} onChange={e => upd(i, x => ({ ...x, vacation: e.target.value === 'none' ? { method: 'none' } : { method: e.target.value, tiers: x.vacation?.tiers?.length ? x.vacation.tiers : [{ fromYears: 1, hoursPerYear: 40 }], ...(e.target.value === 'per_hour' ? { baseHoursPerYear: x.vacation?.baseHoursPerYear || 2080 } : {}) } }))} style={{ fontSize: 12 }}>
                <option value="none">None</option><option value="per_hour">Earned Per Hour Worked</option><option value="anniversary">Added Each Anniversary</option>
              </select></label>
            {p.vacation?.method === 'per_hour' && (
              <label style={{ ...FIELD, width: 130 }}><span style={LBL}>Full-Time Hours a Year</span>
                <input className="form-input" type="number" value={p.vacation.baseHoursPerYear} onChange={e => upd(i, x => ({ ...x, vacation: { ...x.vacation, baseHoursPerYear: e.target.value } }))} style={{ fontSize: 12 }} /></label>
            )}
          </div>
          {p.vacation?.method && p.vacation.method !== 'none' && (
            <div style={{ display: 'grid', gap: 6 }}>
              {(p.vacation.tiers || []).map((t, k) => (
                <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
                  After
                  <input className="form-input" type="number" value={t.fromYears} aria-label="Years of service" onChange={e => upd(i, x => { x.vacation.tiers[k].fromYears = e.target.value; return x; })} style={{ fontSize: 12, width: 64 }} />
                  years:
                  <input className="form-input" type="number" value={t.hoursPerYear} aria-label="Hours a year" onChange={e => upd(i, x => { x.vacation.tiers[k].hoursPerYear = e.target.value; return x; })} style={{ fontSize: 12, width: 80 }} />
                  hours a year
                  <button onClick={() => upd(i, x => { x.vacation.tiers.splice(k, 1); return x; })} aria-label="Remove tier" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={12} /></button>
                </div>
              ))}
              <button className="secondary-btn" onClick={() => upd(i, x => { x.vacation.tiers = [...(x.vacation.tiers || []), { fromYears: 1, hoursPerYear: 40 }]; return x; })} style={{ fontSize: 11.5, justifySelf: 'start', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Plus size={11} /> Add Tier</button>
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="secondary-btn" onClick={addPolicy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Policy</button>
        <span style={{ flex: 1 }} />
        <button className="primary-btn" onClick={save} disabled={busy} style={{ fontSize: 12.5 }}>{busy ? <Spinner size={12} /> : 'Save Policies'}</button>
      </div>
    </div>
  );
}

// Settings > Time & Pay > Leave Policies (Oct 23): the policy library HR >
// Leave used to hold in an accordion. The start date stays with the import on
// HR > Leave; this shows it.
export function LeaveSetup({ toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    return api.leaveAdmin().then(setData)
      .catch(e => { setErr(e?.status === 403 ? '' : (e?.message || 'Could not load the leave policies.')); setData(e?.status === 403 ? false : null); });
  }, []);
  useEffect(() => { load(); }, [load]);
  if (data === false) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Only HR can see the leave policies.</div>;
  if (err) return <div style={{ color: 'hsl(var(--color-red))', fontSize: 13 }}>{err} <button className="secondary-btn" onClick={load} style={{ marginLeft: 8, fontSize: 12 }}>Retry</button></div>;
  if (data === null) return <SkeletonBlocks count={3} height={18} />;
  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
        {data.cutover ? `Balances count from ${day(data.cutover)}${(data.companies || []).some(c => c.own) ? ' (some companies have a date of their own)' : ''}.` : 'No start date yet - nothing shows to employees until one is set.'} The start dates and the opening balances are on People &gt; Time &gt; Time Off.
      </div>
      {data.canSetup
        ? <PoliciesEditor policies={data.policies || []} builtIn={data.defaults || []} onSaved={load} toastOk={toastOk} toastErr={toastErr} />
        : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Only an administrator can change the policies.</div>}
    </div>
  );
}

const CARD = { background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, boxShadow: 'var(--wk-shadow)' };
const HD = { fontSize: 14, fontWeight: 700, color: 'var(--ink)' };
const LBL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.03em' };
const FIELD = { display: 'grid', gap: 4, minWidth: 0 };
const ROW = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', fontSize: 12.5, flexWrap: 'wrap' };
