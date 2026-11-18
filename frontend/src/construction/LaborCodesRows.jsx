// Labor Cost Codes on Edit Job (Round Three item 3, Neil, 11/11/2026): which
// of the job's Intacct cost codes the crew picks from when they punch in
// (construction/PunchCostCode.jsx on the Time Clock). The list to pick from
// is the job's own codes first (GET /construction/projects/{id}/cost-codes,
// the same as a commitment's). None listed = the Time Clock asks nothing.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { SettingRow, SettingCard } from '../components/settings/SettingsUI';

export default function LaborCodesRows({ labor }) {
  const { draft, patch, projectId } = labor;
  const [options, setOptions] = useState([]);
  const [pick, setPick] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getJobCostCodes(projectId))
      .then((d) => { if (live) setOptions(d?.codes || []); })
      .catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [projectId]);
  const chosen = new Set(draft.codes.map((c) => c.code));
  const left = options.filter((o) => !chosen.has(o.code));
  const add = () => {
    const o = options.find((x) => x.code === pick);
    if (!o) return;
    patch({ codes: [...draft.codes, { code: o.code, name: o.name || '' }] });
    setPick('');
  };
  return (
    <SettingCard>
      <SettingRow title="Labor Cost Codes" desc="The Intacct cost codes the crew picks from when they punch in on this job. Never required - with none listed, the Time Clock asks nothing.">
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }} data-labor-codes="">
          {draft.codes.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {draft.codes.map((c) => (
                <span key={c.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 10px', border: '1px solid var(--border-color)', borderRadius: 999, fontSize: 13 }}>
                  {c.name ? `${c.code} - ${c.name}` : c.code}
                  <button type="button" aria-label={`Remove ${c.code}`} onClick={() => patch({ codes: draft.codes.filter((x) => x.code !== c.code) })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex', color: 'var(--text-secondary)' }}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select aria-label="Add a Labor Cost Code" className="form-input" value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: 'min(280px, 60vw)' }}>
              <option value="">{left.length ? 'Pick a cost code' : 'No more cost codes to add'}</option>
              {left.map((o) => <option key={o.code} value={o.code}>{o.name ? `${o.code} - ${o.name}` : o.code}{o.onJob ? '' : ' (no lines on this job yet)'}</option>)}
            </select>
            <button type="button" className="secondary-btn" onClick={add} disabled={!pick} style={{ padding: '6px 12px', fontSize: 13 }}>Add</button>
          </div>
        </div>
      </SettingRow>
    </SettingCard>
  );
}
