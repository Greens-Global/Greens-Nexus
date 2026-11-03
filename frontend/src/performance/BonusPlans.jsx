// Settings > Performance > Bonus Plans (Oct 30 2026): one card per job role -
// the target % of base pay, how often it pays and the payout curve read off
// the monthly score. Rules: backend/perf_bonus.py. HR for the company edits;
// a run keeps the values it was priced with, so editing here never rewrites
// a past run.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign, History } from 'lucide-react';
import { Modal } from '../tasks/components';
import { formatDateTime } from '../lib/datetime';
import { api } from '../api';
import { SettingCard, Switch } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';

const FIELDS = [['target_pct', 'Target %'], ['period', 'Paid'], ['threshold_score', 'Threshold'], ['payout_at_threshold', 'At Threshold'], ['max_payout', 'Max'], ['adjust_max', 'Adjust ±'], ['review_weight', 'Review %'], ['active', 'On']];

function HistoryModal({ plan, role, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.perfBonusPlanHistory(plan.id).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])); }, [plan.id]);
  return (
    <Modal title={`${role.name} Bonus Plan History`} onClose={onClose} footer={<button type="button" className="secondary-btn" onClick={onClose}>Close</button>}>
      {!rows ? <Spinner size="section" /> : (
        <div role="table" aria-label="Plan history" className="nx-fill" style={{ display: 'grid', alignContent: 'start', overflow: 'auto' }}>
          <div role="row" style={{ display: 'grid', gridTemplateColumns: `minmax(0,1.6fr) repeat(${FIELDS.length}, minmax(0,1fr))`, gap: 8, padding: '4px 8px', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>
            <span>Saved</span>{FIELDS.map(([k, l]) => <span key={k}>{l}</span>)}
          </div>
          {rows.map((r) => (
            <div key={r.id} role="row" style={{ display: 'grid', gridTemplateColumns: `minmax(0,1.6fr) repeat(${FIELDS.length}, minmax(0,1fr))`, gap: 8, padding: '6px 8px', borderTop: '1px solid var(--line)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
              <span>{formatDateTime(r.at)}<span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{r.byName || r.by}</span></span>
              {FIELDS.map(([k]) => <span key={k}>{k === 'active' ? (r[k] ? 'Yes' : 'No') : String(r[k] ?? '')}</span>)}
            </div>
          ))}
          {rows.length === 0 && <div style={{ padding: 8, fontSize: 12.5, color: 'var(--muted)' }}>No saves recorded yet.</div>}
        </div>
      )}
    </Modal>
  );
}

const EMPTY = { targetPct: 0, period: 'monthly', thresholdScore: 60, payoutAtThreshold: 50, maxPayout: 100, adjustMax: 20, reviewWeight: 0, active: true };

// The same curve as perf_bonus.payout_pct, for the preview line.
export function payoutAt(p, score, over = 0) {
  const t = Number(p.thresholdScore), at = Number(p.payoutAtThreshold), mx = Number(p.maxPayout);
  if (score < t) return 0;
  const base = score >= 100 || t >= 100 ? 100 : at + (score - t) / (100 - t) * (100 - at);
  const stretch = mx > 100 ? over / 100 * (mx - 100) : 0;
  return Math.round(Math.min(base + stretch, mx) * 10) / 10;
}

function Num({ label, value, onChange, min = 0, max = 100, unit = '%', disabled, width = 88 }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input className="form-input" type="number" aria-label={label} value={value} min={min} max={max} step="any" disabled={disabled}
          onChange={(e) => onChange(e.target.value)} style={{ width, fontSize: 13, textAlign: 'right' }} />
        {unit && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{unit}</span>}
      </span>
    </label>
  );
}

function PlanCard({ role, canEdit, busy, onSave, onToggle }) {
  const [history, setHistory] = useState(false);
  const saved = useMemo(() => ({ ...EMPTY, ...(role.plan || {}) }), [role]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  useGroupDirty(dirty);
  const d = draft || saved;
  const n = (k) => Number(d[k]);
  const valid = n('targetPct') >= 0 && n('targetPct') <= 100 && n('thresholdScore') >= 0 && n('thresholdScore') < 100
    && n('payoutAtThreshold') >= 0 && n('payoutAtThreshold') <= 100 && n('maxPayout') >= 100 && n('maxPayout') <= 300 && n('adjustMax') >= 0 && n('adjustMax') <= 100
    && n('reviewWeight') >= 0 && n('reviewWeight') <= 100;
  const preview = `Score ${n('thresholdScore')} pays ${payoutAt(d, n('thresholdScore'))}% of target, 80 pays ${payoutAt(d, 80)}%, 100 pays 100%${n('maxPayout') > 100 ? `, up to ${n('maxPayout')}% when every KPI is over target` : ''}.${n('reviewWeight') > 0 ? ` The score is ${100 - n('reviewWeight')}% KPIs and ${n('reviewWeight')}% the latest review rating (Exceeds 100, Meets 85, Partly Meets 55, Below 0).` : ''}`;
  const status = !role.plan ? 'No bonus plan - people in this role are not on a bonus run.'
    : !role.plan.active ? 'Plan is off - the role is skipped by bonus runs.'
      : `${role.plan.targetPct}% of base pay, paid ${role.plan.period}${role.hasScorecard ? '' : ' - but the role has no KPI scorecard yet, so there is nothing to score'}.`;
  return (
    <SettingCard>
      <div className="nx-set-pad" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-bonus-plan={role.name}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'inline-grid', placeItems: 'center', background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)' }}><BadgeDollarSign size={15} /></span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{role.name}<span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 }}>{[role.department, `${role.members} ${role.members === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ')}</span></div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{status}</div>
        </div>
        {role.plan && <button type="button" className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => setHistory(true)}><History size={13} /> History</button>}
        {role.plan && <Switch checked={!!role.plan.active} disabled={!canEdit || busy} label={`${role.name} bonus plan on`} onChange={(v) => onToggle(role, v)} />}
      </div>
      <div className="nx-set-pad" style={{ paddingTop: 0, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <Num label="Target Bonus" value={d.targetPct} onChange={(v) => patch({ targetPct: v })} disabled={!canEdit || busy} unit="% of base pay" width={76} />
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Paid</span>
          <select className="form-input" aria-label={`${role.name} bonus period`} value={d.period} disabled={!canEdit || busy} onChange={(e) => patch({ period: e.target.value })} style={{ fontSize: 13 }}>
            <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
          </select>
        </label>
        <Num label="Threshold Score" value={d.thresholdScore} onChange={(v) => patch({ thresholdScore: v })} max={99} unit="" disabled={!canEdit || busy} width={64} />
        <Num label="Payout at Threshold" value={d.payoutAtThreshold} onChange={(v) => patch({ payoutAtThreshold: v })} disabled={!canEdit || busy} width={64} />
        <Num label="Maximum Payout" value={d.maxPayout} onChange={(v) => patch({ maxPayout: v })} min={100} max={300} disabled={!canEdit || busy} width={64} />
        <Num label="Manager May Adjust" value={d.adjustMax} onChange={(v) => patch({ adjustMax: v })} unit="± %" disabled={!canEdit || busy} width={64} />
        <Num label="From the Review" value={d.reviewWeight} onChange={(v) => patch({ reviewWeight: v })} unit="% of the score" disabled={!canEdit || busy} width={64} />
      </div>
      <div className="nx-set-pad" style={{ paddingTop: 0, fontSize: 12, color: 'var(--muted)' }} data-preview>{preview}</div>
      {history && role.plan && <HistoryModal plan={role.plan} role={role} onClose={() => setHistory(false)} />}
      {canEdit && (
        <div className="nx-set-pad" style={{ paddingTop: 0 }}>
          <SaveRow dirty={dirty || !role.plan} busy={busy} saveDisabled={!valid} onSave={() => onSave(role, { ...d, active: role.plan ? role.plan.active : true })} onDiscard={reset}
            note={role.plan ? 'Runs already started keep the values they were priced with.' : 'Saving puts this role on the next bonus run.'} />
        </div>
      )}
    </SettingCard>
  );
}

export function BonusPlanSettings({ company = '', toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!company) return;
    api.perfBonusPlans(company).then((d) => { setErr(''); setData(d); }).catch((e) => setErr(e?.message || 'Could not load the bonus plans.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);

  async function save(role, d) {
    setBusy(true);
    try {
      await api.perfBonusPlanSave({ company, roleId: role.id, targetPct: Number(d.targetPct), period: d.period, thresholdScore: Number(d.thresholdScore),
        payoutAtThreshold: Number(d.payoutAtThreshold), maxPayout: Number(d.maxPayout), adjustMax: Number(d.adjustMax), reviewWeight: Number(d.reviewWeight || 0), active: !!d.active });
      toastOk?.(`${role.name}: bonus plan saved.`); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); } finally { setBusy(false); }
  }

  if (!company) return <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>Pick a company to set its bonus plans.</p>;
  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  return (
    <div style={{ display: 'grid', gap: 12 }} data-bonus-plans="">
      <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
        A role&apos;s bonus is a percentage of base pay, earned by the monthly KPI score: nothing under the threshold score, a share of the target at the threshold, the full target at 100. A run prices every person in the role from their pay rate; managers may adjust within the bound with a reason; HR approves and pays onto the Time Sheet.
      </p>
      {data.roles.length === 0 && <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>No job roles yet - add them under People &gt; Roles.</p>}
      {data.roles.map((r) => <PlanCard key={r.id} role={r} canEdit onSave={save} busy={busy} onToggle={(role, v) => save(role, { ...EMPTY, ...role.plan, active: v })} />)}
    </div>
  );
}

export default BonusPlanSettings;
