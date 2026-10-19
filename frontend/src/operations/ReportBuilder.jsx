// Operations > Reports > Report Builder (Neil, Oct 20): "take this variable,
// this variable, combine the two, and create a metric." Pick a dataset, the
// dimensions to group by, the measures (count / sum / average of a field) and
// formulas over them; run it; save it, share it, and let Nexus email it
// weekly or monthly. The server holds the list of what may be picked
// (GET /ops-reports/builder/registry) and refuses anything else.
// Lazy-loaded from Reports.jsx.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Plus, Save, Send, Share2, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import ReportTable from './ReportTable';

const PRESETS = [
  { name: 'Rent per Occupied Sq Ft', spec: { dataset: 'units', dimensions: ['facility'], period: 'this-month',
    measures: [{ id: 'rent', agg: 'sum', field: 'rent' }, { id: 'occ_sqft', agg: 'sum', field: 'occupied_area' }],
    formulas: [{ id: 'per_sqft', label: 'Rent per Occupied Sq Ft', expr: 'rent / occ_sqft', format: 'money' }] } },
  { name: 'Occupancy by Unit Type', spec: { dataset: 'units', dimensions: ['facility', 'unit_type'], period: 'this-month',
    measures: [{ id: 'units', agg: 'count', field: '' }, { id: 'occupied', agg: 'sum', field: 'occupied' }],
    formulas: [{ id: 'occ', label: 'Occupancy', expr: 'occupied / units', format: 'pct' }] } },
  { name: 'Collections by Month', spec: { dataset: 'payments', dimensions: ['facility', 'month'], period: 'last-12',
    measures: [{ id: 'collected', agg: 'sum', field: 'collected' }, { id: 'payments', agg: 'count', field: '' }, { id: 'failed', agg: 'sum', field: 'failed' }],
    formulas: [{ id: 'fail_rate', label: 'Failure Rate', expr: 'failed / payments', format: 'pct' }] } },
  { name: 'Lead Conversion by Source', spec: { dataset: 'leads', dimensions: ['source'], period: 'last-90',
    measures: [{ id: 'leads', agg: 'count', field: '' }, { id: 'converted', agg: 'sum', field: 'converted' }],
    formulas: [{ id: 'conv', label: 'Conversion Rate', expr: 'converted / leads', format: 'pct' }] } },
];

const blank = (dataset = 'units') => ({ dataset, dimensions: ['facility'], period: 'this-month',
  measures: [{ id: 'm1', agg: 'count', field: '' }], formulas: [] });
const nextId = (prefix, list) => { let n = list.length + 1; while (list.some((x) => x.id === `${prefix}${n}`)) n += 1; return `${prefix}${n}`; };
const describeSchedule = (r, weekdays) => (r.schedule === 'weekly' ? `Weekly on ${weekdays[r.scheduleDay] || 'Monday'}`
  : r.schedule === 'monthly' ? `Monthly on day ${r.scheduleDay}` : '');

function SaveDialog({ initial, registry, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.getPeopleDirectory().then((p) => setPeople(Array.isArray(p) ? p : [])).catch(() => setPeople([])); }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const nameOf = (email) => people.find((p) => (p.email || '').toLowerCase() === email)?.name || email;
  const add = () => {
    const hit = people.find((p) => p.email && (p.email.toLowerCase() === pick.toLowerCase() || p.name === pick));
    if (!hit) { setError('Pick someone from Nexus People.'); return; }
    const email = hit.email.toLowerCase();
    if (!form.recipients.includes(email)) set('recipients', [...form.recipients, email]);
    setPick(''); setError('');
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { name: form.name, spec: form.spec, shared: form.shared, schedule: form.schedule,
        scheduleDay: Number(form.scheduleDay), recipients: form.recipients };
      const out = form.id ? await api.updateOpsSavedReport(form.id, body) : await api.createOpsSavedReport(body);
      onSaved(out.report);
    } catch (err) {
      setError(err?.message || 'The report was not saved.');
    } finally { setBusy(false); }
  };
  return (
    <div className="ops-drill-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="ops-drill dash-card" role="dialog" aria-modal="true" aria-label="Save Report" onSubmit={submit}>
        <div className="ops-drill-head">
          <h3 style={{ margin: 0, fontSize: 18, flex: 1 }}>{form.id ? 'Update Saved Report' : 'Save Report'}</h3>
          <button type="button" className="ops-x" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="ops-drill-body ops-form" style={{ borderTop: 'none', marginTop: 0 }}>
          <label style={{ gridColumn: '1 / -1' }}>Name
            <input className="form-input" value={form.name} maxLength={120} required onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="ops-watch" style={{ gridColumn: '1 / -1', flexDirection: 'row' }}>
            <input type="checkbox" checked={form.shared} onChange={(e) => set('shared', e.target.checked)} /> Share with the Operations team
          </label>
          <label>Send Automatically
            <select className="form-input" value={form.schedule} onChange={(e) => {
              const v = e.target.value;
              setForm((f) => ({ ...f, schedule: v, scheduleDay: v === 'monthly' ? Math.max(1, Number(f.scheduleDay) || 1) : Math.min(6, Number(f.scheduleDay) || 0) }));
            }}>
              {registry.schedules.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          {form.schedule === 'weekly' && (
            <label>Every
              <select className="form-input" value={form.scheduleDay} onChange={(e) => set('scheduleDay', Number(e.target.value))}>
                {registry.weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {form.schedule === 'monthly' && (
            <label>Day of the Month
              <input className="form-input" type="number" min={1} max={28} value={form.scheduleDay} onChange={(e) => set('scheduleDay', e.target.value)} />
            </label>
          )}
          {form.schedule && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Send To
                <span style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" list="ops-rb-people" value={pick} placeholder="Name or email from Nexus People" onChange={(e) => setPick(e.target.value)} />
                  <button type="button" className="secondary-btn" onClick={add}>Add</button>
                </span>
              </label>
              <datalist id="ops-rb-people">{people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}</datalist>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {form.recipients.map((r) => (
                  <span key={r} className="ops-chip">{nameOf(r)}
                    <button type="button" className="ops-x" aria-label={`Remove ${nameOf(r)}`} onClick={() => set('recipients', form.recipients.filter((x) => x !== r))}><X size={12} /></button>
                  </span>
                ))}
              </div>
              <p className="ops-note" style={{ marginTop: 8 }}>Sent at 7:00 AM Pacific with the table in the email and the CSV attached. The period is the one picked in the report.</p>
            </div>
          )}
          {error && <p className="ops-form-error" role="alert">{error}</p>}
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving...' : 'Save Report'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Share with one person from Nexus People: the report becomes visible to the
// Operations team and the person is told on their bell (server-side).
function ShareDialog({ report, onClose, onShared }) {
  const [people, setPeople] = useState([]);
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.getPeopleDirectory().then((p) => setPeople(Array.isArray(p) ? p : [])).catch(() => setPeople([])); }, []);
  const submit = async (e) => {
    e.preventDefault();
    const hit = people.find((p) => p.email && (p.email.toLowerCase() === who.trim().toLowerCase() || p.name === who.trim()));
    if (!hit) { setError('Pick someone from Nexus People.'); return; }
    setBusy(true); setError('');
    try {
      await api.shareOpsSavedReport(report.id, hit.email.toLowerCase(), note);
      onShared(hit.name || hit.email);
    } catch (err) {
      setError(err?.message || 'The report was not shared.');
    } finally { setBusy(false); }
  };
  return (
    <div className="ops-drill-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="ops-drill dash-card" role="dialog" aria-modal="true" aria-label="Share Report" onSubmit={submit}>
        <div className="ops-drill-head">
          <h3 style={{ margin: 0, fontSize: 18, flex: 1 }}>Share {report.name}</h3>
          <button type="button" className="ops-x" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="ops-drill-body ops-form" style={{ borderTop: 'none', marginTop: 0 }}>
          <label style={{ gridColumn: '1 / -1' }}>Person
            <input className="form-input" list="ops-rb-share-people" value={who} required placeholder="Name or email from Nexus People" onChange={(e) => setWho(e.target.value)} />
          </label>
          <datalist id="ops-rb-share-people">{people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}</datalist>
          <label style={{ gridColumn: '1 / -1' }}>Note (Optional)
            <textarea className="form-input" rows={3} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="ops-note" style={{ gridColumn: '1 / -1', margin: 0 }}>The report becomes visible to the Operations team; this person is told on their bell.</p>
          {error && <p className="ops-form-error" role="alert">{error}</p>}
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Sharing...' : 'Share Report'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function ReportBuilder({ scope, facilities }) {
  const [registry, setRegistry] = useState(null);
  const [failed, setFailed] = useState('');
  const [spec, setSpec] = useState(blank());
  const [current, setCurrent] = useState(null);      // the saved report being edited
  const [result, setResult] = useState({ status: 'idle' });
  const [saved, setSaved] = useState([]);
  const [saving, setSaving] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [notice, setNotice] = useState('');
  const one = scope.length === 1 && facilities.length > 1 ? scope[0] : null;

  const loadSaved = useCallback(() => api.opsSavedReports().then((o) => setSaved(o.reports || [])).catch(() => {}), []);
  useEffect(() => {
    api.opsBuilderRegistry().then(setRegistry).catch(() => setFailed("Couldn't load the Report Builder."));
    loadSaved();
  }, [loadSaved]);

  const ds = useMemo(() => registry?.datasets.find((d) => d.key === spec.dataset), [registry, spec.dataset]);
  const fullSpec = useMemo(() => ({ ...spec, facilities: one ? [one.id] : [] }), [spec, one]);
  const ids = [...spec.measures.map((m) => m.id), ...spec.formulas.map((f) => f.id)];

  const run = async (s = fullSpec) => {
    setResult((r) => ({ ...r, status: 'loading' }));
    try {
      setResult({ status: 'ready', data: await api.opsBuilderRun(s) });
    } catch (err) {
      setResult({ status: 'error', error: err?.message || 'The report could not run.' });
    }
  };

  const update = (patch) => setSpec((s) => ({ ...s, ...patch }));
  const setMeasure = (i, patch) => update({ measures: spec.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setFormula = (i, patch) => update({ formulas: spec.formulas.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const toggleDim = (k) => update({ dimensions: spec.dimensions.includes(k) ? spec.dimensions.filter((d) => d !== k)
    : spec.dimensions.length < registry.limits.dimensions ? [...spec.dimensions, k] : spec.dimensions });

  const loadSpec = (s, report = null) => {
    setSpec({ ...blank(s.dataset), ...s, filters: s.filters || [] });
    setCurrent(report);
    setResult({ status: 'idle' });
    run({ ...s, facilities: report ? s.facilities || [] : (one ? [one.id] : []) });
  };

  const act = async (fn, ok) => {
    setNotice('');
    try { await fn(); setNotice(ok); loadSaved(); } catch (err) { setNotice(err?.message || 'That did not work.'); }
  };

  if (failed) return <ErrorBanner message={failed} />;
  if (!registry || !ds) return <div className="dash-card"><SkeletonBlocks count={3} height={70} /></div>;

  return (
    <>
      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">Report Builder{current ? `: ${current.name}` : ''}</div>
            <div className="dash-card-sub">Group Cubby data by what matters, measure it, and combine measures into your own metric. {ds.about}</div>
          </div>
        </div>
        <div className="ops-rep-bar" style={{ flexWrap: 'wrap' }}>
          <span className="ops-note" style={{ margin: 0 }}>Start From</span>
          {PRESETS.map((p) => <button key={p.name} type="button" className="ops-chip" onClick={() => loadSpec(p.spec)}>{p.name}</button>)}
        </div>

        <div className="ops-form" style={{ marginTop: 6 }}>
          <label>Dataset
            <select className="form-input" value={spec.dataset} onChange={(e) => { setSpec(blank(e.target.value)); setCurrent(null); }}>
              {registry.datasets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          {ds.dated && (
            <label>Period
              <select className="form-input" value={spec.period} onChange={(e) => update({ period: e.target.value })}>
                {registry.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
          )}
          {ds.dated && spec.period === 'custom' && (
            <>
              <label>From<input type="date" className="form-input" value={spec.from || ''} onChange={(e) => update({ from: e.target.value })} /></label>
              <label>To<input type="date" className="form-input" value={spec.to || ''} onChange={(e) => update({ to: e.target.value })} /></label>
            </>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="ops-drill-h">Group By (up to {registry.limits.dimensions})</div>
            <div className="ops-pills">
              {ds.dimensions.map((d) => (
                <button key={d.key} type="button" className="ops-pill" aria-pressed={spec.dimensions.includes(d.key)} onClick={() => toggleDim(d.key)}>{d.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="ops-drill-h">Measures</div>
          {spec.measures.map((m, i) => (
            <div key={i} className="ops-rb-line">
              <code className="ops-rb-id" title="Use this name in a formula">{m.id}</code>
              <select className="form-input" aria-label="Aggregation" value={m.agg} onChange={(e) => setMeasure(i, { agg: e.target.value, field: e.target.value === 'count' ? '' : (m.field || ds.fields[0].key) })}>
                {registry.aggregations.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
              {m.agg !== 'count' && (
                <select className="form-input" aria-label="Field" value={m.field} onChange={(e) => setMeasure(i, { field: e.target.value })}>
                  {ds.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              )}
              {m.agg === 'count' && <span className="ops-note" style={{ margin: 0 }}>Number of {ds.label.toLowerCase()}</span>}
              <button type="button" className="ops-x" aria-label={`Remove ${m.id}`} disabled={spec.measures.length === 1}
                onClick={() => update({ measures: spec.measures.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>
          ))}
          {spec.measures.length < registry.limits.measures && (
            <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => update({ measures: [...spec.measures, { id: nextId('m', [...spec.measures, ...spec.formulas]), agg: 'sum', field: ds.fields[0].key }] })}>
              <Plus size={14} aria-hidden="true" /> Add Measure
            </button>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="ops-drill-h">Formulas</div>
          <p className="ops-note" style={{ margin: '0 0 8px' }}>Combine measures with + - * / and parentheses, e.g. {spec.measures.length > 1 ? `${spec.measures[0].id} / ${spec.measures[1].id}` : 'm1 / m2'}. Names: {ids.join(', ')}.</p>
          {spec.formulas.map((f, i) => (
            <div key={i} className="ops-rb-line">
              <code className="ops-rb-id">{f.id}</code>
              <input className="form-input" aria-label="Formula name" placeholder="Name" value={f.label} onChange={(e) => setFormula(i, { label: e.target.value })} />
              <input className="form-input" aria-label="Formula" placeholder="m1 / m2" value={f.expr} onChange={(e) => setFormula(i, { expr: e.target.value })} style={{ fontFamily: 'monospace' }} />
              <select className="form-input" aria-label="Show as" value={f.format} onChange={(e) => setFormula(i, { format: e.target.value })}>
                <option value="number">Number</option><option value="money">Dollars</option><option value="pct">Percent</option><option value="area">Sq Ft</option>
              </select>
              <button type="button" className="ops-x" aria-label={`Remove ${f.id}`} onClick={() => update({ formulas: spec.formulas.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>
          ))}
          {spec.formulas.length < registry.limits.formulas && (
            <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => update({ formulas: [...spec.formulas, { id: nextId('f', [...spec.measures, ...spec.formulas]), label: '', expr: '', format: 'number' }] })}>
              <Plus size={14} aria-hidden="true" /> Add Formula
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => run()} disabled={result.status === 'loading'}>
            <Play size={14} aria-hidden="true" /> {result.status === 'loading' ? 'Running...' : 'Run Report'}
          </button>
          <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setSaving(current
              ? { id: current.id, name: current.name, shared: current.shared, schedule: current.schedule, scheduleDay: current.scheduleDay, recipients: current.recipients, spec: fullSpec }
              : { name: '', shared: false, schedule: '', scheduleDay: 0, recipients: [], spec: fullSpec })}>
            <Save size={14} aria-hidden="true" /> {current?.canEdit ? 'Update Saved Report' : 'Save Report'}
          </button>
          {current?.canEdit && (
            <button type="button" className="secondary-btn" onClick={() => { setCurrent(null); }}>Save as New</button>
          )}
        </div>
        <p className="ops-note" style={{ marginTop: 10 }}>Facilities: {one ? one.shortName : 'All Facilities'} (the picker at the top of the page).</p>
      </div>

      {result.status === 'error' && <ErrorBanner message={result.error} />}
      {result.data && (
        <div className="dash-card" style={{ opacity: result.status === 'loading' ? 0.55 : 1 }}>
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">{current?.name || 'Results'}</div>
              <div className="dash-card-sub">
                {result.data.dataset} - {result.data.facility} - {result.data.period
                  ? `${formatDate(result.data.period.from)} - ${formatDate(result.data.period.to)}`
                  : `as of ${formatDate(result.data.asOf)}`} - {result.data.count.toLocaleString('en-US')} {result.data.dataset.toLowerCase()} counted
              </div>
            </div>
          </div>
          <ReportTable title={current?.name || 'Ops Report'} where={result.data.facility} asOf={result.data.period?.to || result.data.asOf}
            columns={result.data.columns} rows={result.data.rows} totals={result.data.totals} empty="Nothing matches. Try a longer period or fewer groups." />
        </div>
      )}

      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">Saved Reports</div>
            <div className="dash-card-sub">Yours, and the ones shared with the Operations team. A scheduled report emails itself.</div>
          </div>
        </div>
        {notice && <p className="ops-note" role="status" style={{ margin: '0 0 10px' }}>{notice}</p>}
        {!saved.length ? <div className="ops-empty">No saved reports yet. Build one above and press Save Report.</div> : (
          <ul className="ops-reports">
            {saved.map((r) => (
              <li key={r.id} className="ops-report ops-comp">
                <div>
                  <div className="ops-report-title">
                    {r.name}
                    {r.shared && <span className="status-badge pill-info">Shared</span>}
                    {r.schedule && <span className="status-badge pill-ok">{describeSchedule(r, registry.weekdays)}</span>}
                  </div>
                  <div className="ops-report-about">
                    {registry.datasets.find((d) => d.key === r.spec.dataset)?.label}{r.mine ? '' : ` - by ${r.owner}`}
                    {r.schedule ? ` - to ${r.recipients.length} ${r.recipients.length === 1 ? 'person' : 'people'}` : ''}
                    {r.lastSentAt ? ` - last sent ${formatDateTime(r.lastSentAt)}` : ''}
                    {r.lastError ? ' - the last send failed and will be retried' : ''}
                  </div>
                </div>
                <div className="ops-comp-actions">
                  <button type="button" className="secondary-btn" onClick={() => loadSpec(r.spec, r)}>Open</button>
                  {r.canEdit && (
                    <>
                      <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        onClick={() => act(() => api.sendOpsSavedReport(r.id, true), `${r.name} was emailed to you.`)}>
                        <Send size={14} aria-hidden="true" /> Email Me
                      </button>
                      <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        onClick={() => setSharing(r)}>
                        <Share2 size={14} aria-hidden="true" /> Share
                      </button>
                      <button type="button" className="ops-x" aria-label={`Delete ${r.name}`}
                        onClick={() => { if (window.confirm(`Delete ${r.name}?`)) act(() => api.deleteOpsSavedReport(r.id), `${r.name} was deleted.`); }}>
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sharing && (
        <ShareDialog report={sharing} onClose={() => setSharing(null)}
          onShared={(who) => { setSharing(null); setNotice(`${sharing.name} was shared with ${who}. They were told on their bell.`); loadSaved(); }} />
      )}
      {saving && (
        <SaveDialog initial={saving} registry={registry} onClose={() => setSaving(null)}
          onSaved={(report) => { setSaving(null); setCurrent(report); setNotice(`${report.name} was saved.`); loadSaved(); }} />
      )}
    </>
  );
}
