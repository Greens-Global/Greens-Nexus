// Bonus runs (Oct 30 2026). HR (People > Performance): start the run for a
// period that has ended, read every line with its money, adjust or exclude
// with a reason, read the fairness tables, approve, pay. A manager (Workday >
// Performance > My Team): the Bonus Review card - their people's score,
// payout and an adjustment within the plan's bound, never the money.
// Rules: backend/perf_bonus.py.
import { useCallback, useEffect, useState } from 'react';
import { BadgeDollarSign, Scale } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';
import { money } from '../components/retroPayModel';
import { formatDate } from '../lib/datetime';
import { NX } from '../tasks/theme';
import { card, cardHead, HD, LBL, muted } from './lib';
import { scoreColor } from './Score';

const RUN_STATUS = {
  review: { label: 'In Review', color: NX.amber },
  approved: { label: 'Approved', color: NX.blue },
  paid: { label: 'Paid', color: NX.green },
  cancelled: { label: 'Cancelled', color: '#64748b' },
};
const pct = (v) => (v == null ? '-' : `${v}%`);
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const signed = (v) => (!v ? '0%' : `${v > 0 ? '+' : ''}${v}%`);

// The periods HR may run: the last 12 ended months and 4 ended quarters.
export function endedPeriods(today = new Date()) {
  const out = [];
  const y = today.getFullYear(), m = today.getMonth();          // 0-based; the current month has not ended
  for (let i = 1; i <= 12; i++) {
    const d = new Date(y, m - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-US', { month: 'long' }) + ` ${d.getFullYear()}` });
  }
  const q = Math.floor(m / 3);                                   // the current quarter has not ended
  for (let i = 1; i <= 4; i++) {
    const qi = q - i, yy = y + Math.floor(qi / 4), qq = ((qi % 4) + 4) % 4;
    out.push({ key: `${yy}-Q${qq + 1}`, label: `Q${qq + 1} ${yy}` });
  }
  return out;
}

function AdjustModal({ line, hr, onClose, onSaved, toastErr }) {
  const [pctV, setPct] = useState(line.adjustPct || 0);
  const [reason, setReason] = useState(line.adjustReason || '');
  const [excluded, setExcluded] = useState(!!line.excluded);
  const [busy, setBusy] = useState(false);
  const bound = hr ? 100 : line.adjustMax;
  const ok = reason.trim() && Math.abs(Number(pctV)) <= bound;
  const save = () => {
    setBusy(true);
    api.perfBonusLineAdjust(line.id, { adjustPct: Number(pctV), reason, ...(hr ? { excluded } : {}) })
      .then(onSaved).catch((e) => toastErr?.(e.message || 'Could not save.')).finally(() => setBusy(false));
  };
  return (
    <Modal title={`Adjust ${line.name}`} onClose={onClose} isDirty={!!reason}
      footer={<><button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={!ok || busy} onClick={save}>{busy ? 'Saving...' : 'Save Adjustment'}</button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={muted}>Score {line.score ?? '-'} pays {pct(line.payoutPct)} of the target bonus. {hr ? 'HR may adjust by any amount or exclude the person.' : `You may adjust by up to ±${bound}%.`}</div>
        <label style={{ display: 'grid', gap: 4, maxWidth: 200 }}>
          <span style={LBL}>Adjustment (± %)</span>
          <input className="form-input" type="number" aria-label="Adjustment" value={pctV} min={-bound} max={bound} step="any" onChange={(e) => setPct(e.target.value)} />
        </label>
        {hr && (
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> Exclude from this run (no bonus)
          </label>
        )}
        <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={LBL}>Reason</span>
          <textarea className="form-input nx-fill" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={5} placeholder="Why - HR reads it beside the line." style={{ resize: 'vertical' }} />
        </label>
      </div>
    </Modal>
  );
}

function Lines({ lines, hr, canAdjust, onAdjust }) {
  const cols = hr ? 'minmax(0,1.6fr) minmax(0,1fr) 70px 80px 90px minmax(0,1fr) minmax(0,1fr) auto' : 'minmax(0,1.6fr) minmax(0,1fr) 70px 80px 90px auto';
  const head = { ...LBL, display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '6px 8px' };
  return (
    <div role="table" aria-label="Bonus lines" style={{ display: 'grid', overflowX: 'auto' }}>
      <div role="row" style={head}>
        <span role="columnheader">Person</span><span role="columnheader">Role</span><span role="columnheader">Score</span><span role="columnheader">Payout</span><span role="columnheader">Adjusted</span>
        {hr && <><span role="columnheader">Base Pay</span><span role="columnheader">Bonus</span></>}<span role="columnheader" />
      </div>
      {lines.map((ln) => (
        <div key={ln.id} role="row" data-line={ln.email} style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center', padding: '10px 8px', borderTop: '1px solid var(--line)', opacity: ln.excluded ? 0.55 : 1 }}>
          <span role="cell" style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{ln.name}{ln.excluded && <StatusLabel label="Excluded" color="#64748b" size="sm" style={{ marginLeft: 6 }} />}</span>
            <span style={{ display: 'block', ...muted, fontSize: 11.5 }}>
              {ln.managerName ? `Reports to ${ln.managerName}` : 'No manager'}{ln.note === 'no_pay_rate' ? ' - no pay rate on file' : ''}{ln.score == null ? ' - no score this period' : ln.measuredWeight < 100 ? ` - ${ln.measuredWeight}% of the weight measured` : ''}
            </span>
            {ln.adjustReason && <span style={{ display: 'block', ...muted, fontSize: 11.5 }}>{ln.adjustedByName}: &quot;{ln.adjustReason}&quot;</span>}
          </span>
          <span role="cell" style={{ fontSize: 12.5 }}>{ln.roleName}</span>
          <span role="cell" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: scoreColor(ln.score) }}>{ln.score ?? '-'}</span>
          <span role="cell" style={{ fontVariantNumeric: 'tabular-nums' }}>{pct(ln.payoutPct)}</span>
          <span role="cell" style={{ fontVariantNumeric: 'tabular-nums', color: ln.adjustPct ? 'var(--ink)' : 'var(--muted)' }}>{signed(ln.adjustPct)}</span>
          {hr && <>
            <span role="cell" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>{money(ln.basePay, ln.currency)}</span>
            <span role="cell" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{money(ln.finalAmount, ln.currency)}{ln.adjustPct ? <span style={{ ...muted, fontSize: 11, marginLeft: 4 }}>was {money(ln.computedAmount, ln.currency)}</span> : null}</span>
          </>}
          <span role="cell">{canAdjust && (hr || ln.score != null) && <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => onAdjust(ln)}>{ln.adjustPct || ln.excluded ? 'Change' : 'Adjust'}</button>}</span>
        </div>
      ))}
    </div>
  );
}

function Fairness({ f }) {
  const Table = ({ title, rows }) => (
    <div>
      <div style={{ ...LBL, marginBottom: 4 }}>{title}</div>
      <div role="table" aria-label={title} style={{ display: 'grid' }}>
        <div role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) 60px 80px 80px 80px 80px minmax(0,1.4fr)', gap: 8, padding: '4px 8px', ...LBL }}>
          <span>Group</span><span>People</span><span>Avg Score</span><span>Avg Payout</span><span>Avg Adjust</span><span>Spread</span><span>Flags</span>
        </div>
        {rows.map((r) => (
          <div key={r.key} role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) 60px 80px 80px 80px 80px minmax(0,1.4fr)', gap: 8, padding: '6px 8px', borderTop: '1px solid var(--line)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ fontWeight: 600 }}>{r.name}</span><span>{r.people}</span><span style={{ color: scoreColor(r.avgScore) }}>{r.avgScore ?? '-'}</span><span>{pct(r.avgPayout)}</span><span>{signed(r.avgAdjust)}</span><span>{r.spread ?? '-'}</span>
            <span>{r.flags.length ? r.flags.map((x) => <StatusLabel key={x} label={x} color={NX.amber} size="sm" style={{ marginRight: 4 }} />) : <span style={muted}>-</span>}</span>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <section style={{ display: 'grid', gap: 12 }} aria-label="Fairness">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Scale size={14} /><span style={HD}>Fairness</span><span style={muted}>the same figures by manager and by department, so a lenient or harsh hand shows before approval</span></div>
      <Table title="By Manager" rows={f.byManager} />
      <Table title="By Department" rows={f.byDepartment} />
    </section>
  );
}

function RunDetail({ runId, onBack, onChanged, toastOk, toastErr }) {
  const [run, setRun] = useState(null);
  const [err, setErr] = useState('');
  const [adjust, setAdjust] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.perfBonusRun(runId).then(setRun).catch((e) => setErr(e.message || 'Could not load the run.')), [runId]);
  useEffect(() => { load(); }, [load]);
  const act = async (what) => {
    const asks = {
      approve: ['Approve this run? Lines lock; managers can no longer adjust.', 'Approve Run', 'Approve'],
      pay: [`Pay ${people(run.lines.filter((l) => !l.excluded && l.finalAmount > 0).length)} for ${run.label} onto the Time Sheets of the current pay period? Each person is told the amount. This cannot be undone here.`, 'Pay Run', 'Pay'],
      cancel: ['Cancel this run? Nothing is paid; you can start it again later.', 'Cancel Run', 'Cancel Run'],
    }[what];
    const ok = await dialog.confirm(asks[0], { title: asks[1], confirmText: asks[2], danger: what === 'cancel' });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await ({ approve: api.perfBonusRunApprove, pay: api.perfBonusRunPay, cancel: api.perfBonusRunCancel })[what](runId);
      toastOk?.(what === 'pay' ? `${r.paidLines} ${r.paidLines === 1 ? 'bonus' : 'bonuses'} added to the Time Sheets.` : what === 'approve' ? 'Run approved.' : 'Run cancelled.');
      onChanged(); load();
    } catch (e) { toastErr?.(e.message || 'Could not do that.'); } finally { setBusy(false); }
  };
  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!run) return <SkeletonBlocks count={3} height={56} />;
  const st = RUN_STATUS[run.status] || RUN_STATUS.review;
  return (
    <div style={{ display: 'grid', gap: 14 }} data-bonus-run={run.period}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={onBack} style={{ minHeight: 36 }}>&lsaquo; Runs</button>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{run.label}</span>
        <StatusLabel label={st.label} color={st.color} size="sm" />
        <span style={muted}>{people(run.lineCount)} · total <b data-total>{money(run.total || 0, run.lines[0]?.currency || 'USD')}</b>{run.approvedAt ? ` · approved ${formatDate(run.approvedAt.slice(0, 10))}` : ''}{run.paidAt ? ` · paid ${formatDate(run.paidAt.slice(0, 10))}` : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          {run.status === 'review' && <button type="button" className="secondary-btn" disabled={busy} onClick={() => act('cancel')}>Cancel Run</button>}
          {run.status === 'review' && <button type="button" className="primary-btn" disabled={busy} onClick={() => act('approve')}>Approve</button>}
          {run.status === 'approved' && <button type="button" className="primary-btn" disabled={busy} onClick={() => act('pay')}>Pay Onto Time Sheets</button>}
        </span>
      </div>
      {run.lines.length ? <Lines lines={run.lines} hr canAdjust={run.status === 'review'} onAdjust={setAdjust} /> : <div style={muted}>Nobody in this company holds a role with an active {run.period.includes('Q') ? 'quarterly' : 'monthly'} bonus plan.</div>}
      {run.lines.length > 0 && <Fairness f={run.fairness} />}
      {adjust && <AdjustModal line={adjust} hr onClose={() => setAdjust(null)} toastErr={toastErr} onSaved={() => { setAdjust(null); toastOk?.('Line updated.'); load(); }} />}
    </div>
  );
}

/** HR's Bonus Runs section (PerformanceAdmin). */
export function BonusRunsAdmin({ company, toastOk, toastErr }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!company) return;
    api.perfBonusRuns(company).then((r) => { setErr(''); setRuns(Array.isArray(r) ? r : []); }).catch((e) => setErr(e.message || 'Could not load the bonus runs.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  const start = async () => {
    if (!period) return;
    setBusy(true);
    try { const r = await api.perfBonusRunStart({ company, period }); toastOk?.(`Run started: ${people(r.lineCount)}.`); setPeriod(''); load(); setOpen(r.id); }
    catch (e) { toastErr?.(e.message || 'Could not start the run.'); } finally { setBusy(false); }
  };
  const taken = new Set((runs || []).filter((r) => r.status !== 'cancelled').map((r) => r.period));
  return (
    <section style={card} aria-label="Bonus Runs" data-bonus-runs>
      <div style={cardHead}>
        <span className="wkc-chip"><BadgeDollarSign size={14} /></span>
        <span style={HD}>Bonus Runs</span>
        {!open && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <select className="form-input" aria-label="Period to run" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ fontSize: 13, minHeight: 36 }}>
              <option value="">Period...</option>
              {endedPeriods().filter((p) => !taken.has(p.key)).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <button type="button" className="primary-btn" disabled={!period || busy} onClick={start} style={{ minHeight: 36 }}>Start a Run</button>
          </span>
        )}
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : open ? (
        <RunDetail runId={open} onBack={() => setOpen('')} onChanged={load} toastOk={toastOk} toastErr={toastErr} />
      ) : runs === null ? <SkeletonBlocks count={2} height={48} /> : runs.length === 0 ? (
        <div style={muted}>No bonus runs yet. Set each role&apos;s plan in Settings &gt; Performance &gt; Bonus Plans, then start the run for a period that has ended.</div>
      ) : (
        <div role="table" aria-label="Runs" style={{ display: 'grid' }}>
          {runs.map((r) => {
            const st = RUN_STATUS[r.status] || RUN_STATUS.review;
            return (
              <button key={r.id} type="button" role="row" className="nx-perf-trow" onClick={() => setOpen(r.id)}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) 110px minmax(0,1fr) minmax(0,1.4fr)', gap: 12, alignItems: 'center', padding: '12px 10px', border: 'none', borderTop: '1px solid var(--line)', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{r.label}</span>
                <span><StatusLabel label={st.label} color={st.color} size="sm" /></span>
                <span style={muted}>{people(r.lineCount)}</span>
                <span style={{ ...muted, fontSize: 12 }}>{r.paidAt ? `Paid ${formatDate(r.paidAt.slice(0, 10))}` : r.approvedAt ? `Approved ${formatDate(r.approvedAt.slice(0, 10))}` : `Started ${formatDate(r.createdAt.slice(0, 10))}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A manager's Bonus Review card (My Team): shows only while a run is in review for their people. */
export function BonusReviewCard({ toastOk, toastErr }) {
  const [runs, setRuns] = useState(null);
  const [adjust, setAdjust] = useState(null);
  const load = useCallback(() => api.perfBonusReview().then((r) => setRuns(Array.isArray(r) ? r : [])).catch(() => setRuns([])), []);
  useEffect(() => { load(); }, [load]);
  if (!runs || !runs.length) return null;
  return (
    <section style={card} aria-label="Bonus Review" data-bonus-review>
      <div style={cardHead}>
        <span className="wkc-chip"><BadgeDollarSign size={14} /></span>
        <span style={HD}>Bonus Review</span>
        <span style={muted}>HR has priced the period from the KPI scores. Adjust a person within the plan&apos;s bound, with a reason, before HR approves.</span>
      </div>
      {runs.map((r) => (
        <div key={r.id} style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</div>
          <Lines lines={r.lines} hr={false} canAdjust onAdjust={setAdjust} />
        </div>
      ))}
      {adjust && <AdjustModal line={adjust} hr={false} onClose={() => setAdjust(null)} toastErr={toastErr} onSaved={() => { setAdjust(null); toastOk?.('Adjustment saved.'); load(); }} />}
    </section>
  );
}
