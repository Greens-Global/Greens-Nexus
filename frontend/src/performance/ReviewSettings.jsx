// Settings > Performance (Oct 27 2026): the review rating scale and the
// company values - an organization default a company may override
// (scoped_settings key "performance_reviews"). A cycle copies both when it is
// created, so a change here never rewrites a running cycle.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { SettingCard, SettingRow } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';

function useReviewSettings(company, onOverride, part) {
  const [meta, setMeta] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(() => {
    api.perfReviewSettings(company).then(m => { setLoadErr(''); setMeta(m); })
      .catch(e => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.((meta.overrides || []).includes(part)); }, [meta, company, onOverride, part]);
  return [meta, setMeta, loadErr, load];
}

function Footer({ meta, company, part, dirty, busy, onSave, onDiscard, onReset }) {
  if (!meta.canEdit) {
    return (
      <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
        {company ? 'Only HR for this company can change these.' : 'The default for every company is changed by HR with access to every company. Pick your company to set its own.'}
      </p>
    );
  }
  return (
    <div className="nx-set-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {dirty && <button type="button" className="primary-btn" disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</button>}
      {dirty && <button type="button" className="secondary-btn" disabled={busy} onClick={onDiscard}>Discard Changes</button>}
      {!!company && (meta.overrides || []).includes(part) && <button type="button" className="secondary-btn" disabled={busy} onClick={onReset}>Use the Default</button>}
    </div>
  );
}

export function ReviewScaleSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta, loadErr, load] = useReviewSettings(company, onOverride, 'ratingScale');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const scale = rows ?? meta?.ratingScale ?? [];
  async function save(reset = false) {
    setBusy(true);
    try {
      const m = await api.perfReviewSettingsSave({ company, rating_scale: reset ? undefined : scale, reset, part: 'ratingScale' });
      setMeta(m); setRows(null);
      toastOk?.(reset ? 'Back to the default for every company.' : 'Rating scale saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const edit = (i, label) => setRows(scale.map((r, j) => (j === i ? { ...r, label } : r)));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <SettingCard>
        {scale.map((r, i) => (
          <SettingRow key={r.value} title={`${r.value}`} desc={i === 0 ? 'The lowest rating' : i === scale.length - 1 ? 'The highest rating' : undefined}
            control={<span style={{ display: 'inline-flex', gap: 6 }}>
              <input className="form-input" value={r.label} disabled={!meta.canEdit || busy} aria-label={`Label for ${r.value}`} onChange={e => edit(i, e.target.value)} style={{ width: 220 }} />
              {meta.canEdit && scale.length > 2 && i === scale.length - 1 && (
                <button type="button" className="secondary-btn" aria-label="Remove the top point" title="Remove" style={{ padding: 6 }}
                  onClick={() => setRows(scale.slice(0, -1))}><Trash2 size={14} /></button>
              )}
            </span>} />
        ))}
      </SettingCard>
      {meta.canEdit && scale.length < 10 && (
        <div className="nx-set-pad"><button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setRows([...scale, { value: (scale[scale.length - 1]?.value || 0) + 1, label: '' }])}><Plus size={14} /> Add a Point</button></div>
      )}
      <Footer meta={meta} company={company} part="ratingScale" dirty={rows !== null} busy={busy} onSave={() => save(false)} onDiscard={() => setRows(null)} onReset={() => save(true)} />
    </div>
  );
}

export function CompanyValuesSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta, loadErr, load] = useReviewSettings(company, onOverride, 'values');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const values = rows ?? meta?.values ?? [];
  async function save(reset = false) {
    setBusy(true);
    try {
      const m = await api.perfReviewSettingsSave({ company, values: reset ? undefined : values.filter(v => v.name.trim()), reset, part: 'values' });
      setMeta(m); setRows(null);
      toastOk?.(reset ? 'Back to the default for every company.' : 'Company values saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const edit = (i, patch) => setRows(values.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {!values.length && <p className="nx-set-pad" style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>No company values yet - reviews then rate only the questions.</p>}
      {values.length > 0 && (
        <SettingCard>
          {values.map((v, i) => (
            <div key={v.id || i} className="nx-set-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="form-input" value={v.name} placeholder="Value" disabled={!meta.canEdit || busy} aria-label="Value name" onChange={e => edit(i, { name: e.target.value })} style={{ flex: '1 1 160px' }} />
              <input className="form-input" value={v.description || ''} placeholder="What it means (optional)" disabled={!meta.canEdit || busy} aria-label="Value description"
                onChange={e => edit(i, { description: e.target.value })} style={{ flex: '2 1 240px' }} />
              {meta.canEdit && <button type="button" className="secondary-btn" aria-label={`Remove ${v.name || 'value'}`} title="Remove" style={{ padding: 6 }}
                onClick={() => setRows(values.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}
            </div>
          ))}
        </SettingCard>
      )}
      {meta.canEdit && (
        <div className="nx-set-pad"><button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setRows([...values, { id: '', name: '', description: '' }])}><Plus size={14} /> Add a Value</button></div>
      )}
      <Footer meta={meta} company={company} part="values" dirty={rows !== null} busy={busy} onSave={() => save(false)} onDiscard={() => setRows(null)} onReset={() => save(true)} />
    </div>
  );
}
