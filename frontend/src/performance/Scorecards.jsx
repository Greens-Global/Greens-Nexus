// Settings > Performance > KPI Scorecards (Charmi, 10/30/2026): one card per
// department of the company. Each KPI on it has a weight (the weights total
// 100), a target, a threshold and a cap; Nexus KPIs come from what Nexus
// records, manual ones are rated by a manager with a reason and may carry at
// most 30% of the weight. A change to a scorecard in force applies from the
// first of next month - the current month keeps its rules. Saved through the
// group's one Save row (CLAUDE.md "Settings saves one way").
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X, Target, Sparkles, Wand2 } from 'lucide-react';
import { api } from '../api';
import { SettingCard } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';
import { formatDate } from '../lib/datetime';

const UNIT_LABEL = { '%': '%', count: 'count', per100: 'per 100', rating: 'rating 1-5' };
const blankRow = (k) => ({ kpi: k.key, weight: 0, target: k.unit === '%' ? 90 : k.unit === 'rating' ? 4 : 10,
  threshold: k.unit === '%' ? 60 : k.unit === 'rating' ? 2 : 5, cap: k.unit === '%' ? 100 : k.unit === 'rating' ? 5 : 15 });

function weightsOf(items) { return (items || []).reduce((n, r) => n + (Number(r.weight) || 0), 0); }
function manualWeight(items, lib) { return (items || []).filter((r) => lib[r.kpi]?.source === 'manual').reduce((n, r) => n + (Number(r.weight) || 0), 0); }

/** One department's scorecard: the rows, the add box, the weights line, the Save row. */
function DepartmentCard({ dept, lib, kpis, manualMax, nextMonth, canEdit, busy, onSave }) {
  const saved = useMemo(() => {
    const v = dept.upcoming || dept.current;
    return { items: (v?.items || []).map(({ kpi, weight, target, threshold, cap }) => ({ kpi, weight, target, threshold, cap })), notes: v?.notes || '' };
  }, [dept]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  useGroupDirty(dirty);
  const items = draft?.items || [];
  const total = weightsOf(items);
  const manual = manualWeight(items, lib);
  const problems = [];
  if (items.length && total !== 100) problems.push(`Weights total ${total}%, not 100%`);
  if (manual > manualMax) problems.push(`Manual KPIs carry ${manual}%; at most ${manualMax}%`);
  const setRow = (i, p) => patch({ items: items.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const available = kpis.filter((k) => k.active && !items.some((r) => r.kpi === k.key));
  const status = dept.upcoming
    ? `Version ${dept.upcoming.version} applies from ${formatDate(dept.upcoming.effectiveFrom)}${dept.current ? `; version ${dept.current.version} runs to ${formatDate(dept.current.effectiveTo)}` : ''}.`
    : dept.current ? `Version ${dept.current.version}, in force since ${formatDate(dept.current.effectiveFrom)}. A change applies from ${formatDate(nextMonth)}.`
      : 'No scorecard yet - this department is not scored.';
  return (
    <SettingCard>
      <div className="nx-set-pad" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-scorecard={dept.name}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'inline-grid', placeItems: 'center', background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)' }}><Target size={15} /></span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{dept.name}{dept.unlisted && <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 }}>not under Settings &gt; Companies yet</span>}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{status}</div>
        </div>
        {canEdit && !items.length && (
          <button type="button" className="secondary-btn" style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}
            onClick={() => patch({ items: dept.suggestion.map(({ kpi, weight, target, threshold, cap }) => ({ kpi, weight, target, threshold, cap })) })}>
            <Wand2 size={13} /> Start From a Suggestion
          </button>
        )}
      </div>
      {items.length > 0 && (
        <div className="nx-set-pad" style={{ display: 'grid', gap: 6 }}>
          <div className="perf-sc-head"><span>KPI</span><span>Weight %</span><span>Target</span><span>Threshold</span><span>Cap</span><span /></div>
          {items.map((r, i) => {
            const k = lib[r.kpi] || { name: r.kpi, unit: '', source: 'nexus', direction: 'high' };
            return (
              <div className="perf-sc-row" key={r.kpi} data-kpi={r.kpi}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{k.name}</span>
                  <span className={`perf-sc-src ${k.source}`}>{k.source === 'manual' ? 'Manual' : 'Nexus'}</span>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{k.direction === 'low' ? 'Lower is better' : 'Higher is better'}{k.unit ? ` · ${UNIT_LABEL[k.unit] || k.unit}` : ''}{k.description ? ` · ${k.description}` : ''}</div>
                </span>
                <input className="form-input perf-sc-num" type="number" min={0} max={100} step={1} value={r.weight} disabled={!canEdit || busy} aria-label={`${k.name} weight`} onChange={(e) => setRow(i, { weight: e.target.value === '' ? '' : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} />
                <input className="form-input perf-sc-num" type="number" step="any" value={r.target} disabled={!canEdit || busy} aria-label={`${k.name} target`} onChange={(e) => setRow(i, { target: e.target.value })} />
                <input className="form-input perf-sc-num" type="number" step="any" value={r.threshold} disabled={!canEdit || busy} aria-label={`${k.name} threshold`} onChange={(e) => setRow(i, { threshold: e.target.value })} />
                <input className="form-input perf-sc-num" type="number" step="any" value={r.cap} disabled={!canEdit || busy} aria-label={`${k.name} cap`} onChange={(e) => setRow(i, { cap: e.target.value })} />
                {canEdit ? <button type="button" className="secondary-btn" style={{ padding: '4px 7px' }} aria-label={`Remove ${k.name}`} onClick={() => patch({ items: items.filter((_, j) => j !== i) })}><X size={13} /></button> : <span />}
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span className={`perf-sc-total${total === 100 ? ' is-ok' : ''}`}>Weights: {total}%</span>
            {manual > 0 && <span style={{ color: manual > manualMax ? 'var(--bad-fg)' : 'var(--muted)' }}>Manual: {manual}% (max {manualMax}%)</span>}
            {problems.map((p) => <span key={p} style={{ color: 'var(--bad-fg)', fontWeight: 600 }}>{p}</span>)}
          </div>
        </div>
      )}
      {canEdit && (
        <div className="nx-set-pad" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-input" style={{ minWidth: 260, fontSize: 13 }} value="" aria-label={`Add a KPI to ${dept.name}`} disabled={busy}
            onChange={(e) => { const k = kpis.find((x) => x.key === e.target.value); if (k) patch({ items: [...items, blankRow(k)] }); }}>
            <option value="">Add a KPI…</option>
            <optgroup label="Measured by Nexus">{available.filter((k) => k.source === 'nexus').map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}</optgroup>
            {available.some((k) => k.source === 'manual') && <optgroup label="Rated by a manager">{available.filter((k) => k.source === 'manual').map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}</optgroup>}
          </select>
          <input className="form-input" style={{ flex: 1, minWidth: 200, fontSize: 13 }} placeholder="Notes for this version (why it changed)" value={draft?.notes || ''} disabled={busy} onChange={(e) => patch({ notes: e.target.value })} />
        </div>
      )}
      {canEdit && (
        <div className="nx-set-pad" style={{ paddingTop: 0 }}>
          <SaveRow dirty={dirty} busy={busy} saveDisabled={problems.length > 0 || !items.length} onSave={() => onSave(dept.name, draft)} onDiscard={reset}
            note={items.length ? (dept.current && !dept.upcoming ? `Saving starts a new version from ${formatDate(nextMonth)}.` : dept.upcoming ? 'Editing the version that has not started yet.' : 'Saving starts scoring this month.') : 'Add KPIs, or start from a suggestion.'} />
        </div>
      )}
    </SettingCard>
  );
}

/** Add a manual KPI to the library (HR). */
function ManualKpiBox({ company, canEdit, onAdded, toastErr }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', description: '', unit: 'rating', direction: 'high' });
  const [busy, setBusy] = useState(false);
  if (!canEdit) return null;
  if (!open) return <button type="button" className="secondary-btn" style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => setOpen(true)}><Plus size={13} /> Add a Manual KPI</button>;
  async function add() {
    if (!f.name.trim()) return;
    setBusy(true);
    try { await api.perfKpiCreate({ company, ...f }); setOpen(false); setF({ name: '', description: '', unit: 'rating', direction: 'high' }); onAdded(); }
    catch (e) { toastErr?.(e?.message || 'Could not add the KPI.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid var(--line)', borderRadius: 12 }} data-manual-kpi="">
      <div style={{ fontWeight: 600, fontSize: 13 }}>A KPI a manager rates (with a written reason)</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 140px 150px', gap: 8 }}>
        <input className="form-input" placeholder="Name, e.g. Client Calls Returned" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Manual KPI name" />
        <select className="form-input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} aria-label="Unit">{Object.entries(UNIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="form-input" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} aria-label="Direction"><option value="high">Higher is better</option><option value="low">Lower is better</option></select>
      </div>
      <input className="form-input" placeholder="What it measures (optional)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Manual KPI description" />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={add} disabled={busy || !f.name.trim()}>Add KPI</button>
      </div>
    </div>
  );
}

export function ScorecardSettings({ company = '', toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!company) return;
    api.perfScorecards(company).then((d) => { setErr(''); setData(d); }).catch((e) => setErr(e?.message || 'Could not load the scorecards.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  const lib = useMemo(() => Object.fromEntries((data?.kpis || []).map((k) => [k.key, k])), [data]);

  async function save(department, draft) {
    setBusy(true);
    try {
      const out = await api.perfScorecardSave({ company, department, items: draft.items.map((r) => ({ ...r, weight: Number(r.weight), target: Number(r.target), threshold: Number(r.threshold), cap: Number(r.cap) })), notes: draft.notes || '' });
      toastOk?.(out.effectiveFrom > new Date().toISOString().slice(0, 10) ? `${department}: version ${out.version} applies from ${formatDate(out.effectiveFrom)}.` : `${department}: scorecard saved.`);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (!company) return <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>Pick a company to set its department scorecards.</p>;
  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  return (
    <div style={{ display: 'grid', gap: 12 }} data-scorecards="">
      <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Sparkles size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>Each department picks the KPIs it is scored on and how much each counts. Nexus KPIs are measured from what Nexus already records; manual ones are rated by the manager with a reason and may carry at most {data.manualMax}% of the weight. Rules change only from the first of a month, so a score is always explained by the rules that applied.</span>
      </p>
      {data.departments.length === 0 && <p className="nx-set-pad" style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>No departments yet - add them under Settings &gt; Companies &gt; Departments.</p>}
      {data.departments.map((d) => (
        <DepartmentCard key={d.name} dept={d} lib={lib} kpis={data.kpis} manualMax={data.manualMax} nextMonth={data.nextMonth} canEdit={data.canEdit} busy={busy} onSave={save} />
      ))}
      <ManualKpiBox company={company} canEdit={data.canEdit} onAdded={() => { toastOk?.('KPI added to the library.'); load(); }} toastErr={toastErr} />
    </div>
  );
}

export default ScorecardSettings;
