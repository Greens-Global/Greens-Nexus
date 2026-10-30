// Who this applies to: rule rows over People fields, named people, timing.
// Used by Policies (who signs), assignment rules and Training Plans.
import { useEffect, useMemo, useState } from 'react';
import { Users, X } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { api } from '../../api';
import { PeopleMultiPick } from './PeoplePick';
import { Av } from './Chips';
import { debounce } from '../lib';

const RULE_KEYS = [
  ['departments', 'Department'], ['job_titles', 'Job title'], ['locations', 'Location'],
  ['companies', 'Company'], ['employment_types', 'Employment type'], ['managers', 'Reports to'],
];

export function emptyAudience() {
  return { everyone: true, companies: [], departments: [], job_titles: [], locations: [], managers: [], people: [], employment_types: [], due_days: 14, renew_months: 0 };
}

export function normalizeAudience(a) {
  return { ...emptyAudience(), ...(a || {}), everyone: !!(a?.everyone) };
}

export default function AudienceModal({ value, onChange, onClose, title = 'Who This Applies To', timing = true, dueLabel = 'Due', renewLabel = 'Renew every' }) {
  const [a, setA] = useState(normalizeAudience(value));
  const [opts, setOpts] = useState(null);
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState(() => RULE_KEYS.filter(([k]) => (a[k] || []).length).map(([k]) => k));
  useEffect(() => { api.kbAudienceOptions().then(setOpts).catch(() => setOpts({})); }, []);
  const run = useMemo(() => debounce((aud) => api.kbAudiencePreview(aud).then(setPreview).catch(() => setPreview(null)), 250), []);
  useEffect(() => { run(a); }, [a, run]);
  const setList = (k, v) => setA((x) => ({ ...x, [k]: v, everyone: false }));
  const optionsFor = (k) => {
    if (!opts) return [];
    if (k === 'companies') return (opts.companies || []).map((c) => ({ v: c.id, l: c.name }));
    if (k === 'managers') return (opts.managers || []).map((m) => ({ v: m.email, l: m.name }));
    return (opts[k] || []).map((v) => ({ v, l: k === 'employment_types' ? v.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : v }));
  };
  const toggle = (k, v) => setList(k, (a[k] || []).includes(v) ? a[k].filter((x) => x !== v) : [...(a[k] || []), v]);
  const addRow = (k) => { if (!rows.includes(k)) setRows([...rows, k]); setA((x) => ({ ...x, everyone: false })); };
  const removeRow = (k) => { setRows(rows.filter((r) => r !== k)); setList(k, []); };
  const everyone = a.everyone || (!rows.length && !a.people.length);
  const save = () => { onChange({ ...a, everyone: everyone && !a.people.length }); onClose(); };

  return (
    <Modal title={title} onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
             <span className="kb-meta kb-grow">{preview ? <><b>{preview.count}</b> people match now. {preview.description}.</> : 'Counting...'}</span>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" onClick={save}>Save Audience</button></div>}>
      <div className="kb" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className={`kb-radio${everyone ? ' on' : ''}`}>
            <input type="radio" checked={everyone} onChange={() => { setRows([]); setA((x) => ({ ...x, everyone: true, companies: [], departments: [], job_titles: [], locations: [], managers: [], employment_types: [] })); }} />
            <span><b>Everyone</b><div className="kb-help">Every active employee, and every new hire from their start date.</div></span>
          </label>
          <label className={`kb-radio${!everyone ? ' on' : ''}`}>
            <input type="radio" checked={!everyone} onChange={() => { setA((x) => ({ ...x, everyone: false })); if (!rows.length) setRows(['departments']); }} />
            <span><b>People who match</b><div className="kb-help">All rules must match (AND). Inside a rule, any value counts (OR).</div></span>
          </label>
          {!everyone && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 8, borderLeft: '2px solid var(--kb-line)' }}>
              {rows.map((k, i) => {
                const label = RULE_KEYS.find(([kk]) => kk === k)?.[1] || k;
                const options = optionsFor(k);
                return (
                  <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="kb-tag" style={{ fontWeight: 700 }}>{i === 0 ? 'WHERE' : 'AND'}</span>
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{label}</span><span className="kb-meta">is any of</span>
                      <button type="button" className="kb-ibtn" style={{ width: 24, height: 24, marginLeft: 'auto', border: 0 }} aria-label="Remove rule" onClick={() => removeRow(k)}><X size={13} /></button>
                    </div>
                    <div className="kb-pills">
                      {options.length === 0 && <span className="kb-meta">People has no values for this yet.</span>}
                      {options.map((o) => <button key={o.v} type="button" className={`kb-pill${(a[k] || []).includes(o.v) ? ' on' : ''}`} onClick={() => toggle(k, o.v)}>{o.l}</button>)}
                    </div>
                  </div>
                );
              })}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span className="kb-meta">Add a rule:</span>
                {RULE_KEYS.filter(([k]) => !rows.includes(k)).map(([k, l]) => <button key={k} type="button" className="kb-btn sm" onClick={() => addRow(k)}>{l}</button>)}
              </div>
            </div>
          )}
          <div className="kb-field"><label>Named People (always included)</label><PeopleMultiPick value={a.people} onChange={(v) => setA((x) => ({ ...x, people: v }))} /></div>
          {timing && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="kb-field"><label>{dueLabel}</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="0" className="kb-input" style={{ width: 90 }} value={a.due_days} onChange={(e) => setA((x) => ({ ...x, due_days: Number(e.target.value) || 0 }))} /><span className="kb-meta">days after start date (or today)</span></div></div>
              <div className="kb-field"><label>{renewLabel}</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="0" className="kb-input" style={{ width: 90 }} value={a.renew_months} onChange={(e) => setA((x) => ({ ...x, renew_months: Number(e.target.value) || 0 }))} /><span className="kb-meta">months (0 = never)</span></div></div>
            </div>
          )}
        </div>
        <div className="kb-card soft" style={{ padding: 14, alignSelf: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Users size={16} style={{ color: 'var(--kb-green)' }} /><span className="kb-title">Matches Now</span><span className="kb-meta" style={{ marginLeft: 'auto' }}>{preview ? preview.count : '...'}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '44vh', overflow: 'auto' }}>
            {(preview?.sample || []).map((p) => (
              <div key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><Av name={p.name} email={p.email} size={22} /><span className="kb-grow kb-ellipsis">{p.name}</span><span className="kb-meta kb-ellipsis" style={{ maxWidth: 120 }}>{p.job_title || p.department}</span></div>
            ))}
            {preview && preview.count > (preview.sample || []).length && <div className="kb-meta">and {preview.count - preview.sample.length} more</div>}
            {preview && preview.count === 0 && <div className="kb-meta">Nobody matches yet.</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
