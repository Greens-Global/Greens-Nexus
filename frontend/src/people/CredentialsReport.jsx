import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { csvName, downloadCsv } from '../operations/csv';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { CredentialState } from './credentialState';
import { CRED_STATE } from './credentialStates';

// People > Reports > Licenses & Certifications (Neil, 11/11/2026, Deputy
// parity - "filter people by training expiring in 30 days"): every record of
// the active and onboarding people in the viewer's reach, soonest expiry
// first. The server scopes the rows (company walls); Download CSV writes
// exactly the filtered table.

const SELECT = { fontSize: 12.5, padding: '6px 8px' };
const COLUMNS = [
  ['Name', r => r.person],
  ['License or Certification', r => r.name],
  ['Status', r => CRED_STATE[r.state]?.label || ''],
  ['Expires', r => (r.expiresOn ? formatDate(r.expiresOn) : '')],
  ['Issued', r => (r.issuedOn ? formatDate(r.issuedOn) : '')],
  ['Issued By', r => r.issuer || ''],
  ['Number', r => (r.numberLast4 ? `ending ${r.numberLast4}` : '')],
  ['Verified', r => (r.verifiedAt ? 'Yes' : '')],
  ['Job Title', r => r.jobTitle || ''],
  ['Department', r => r.department || ''],
  ['Company', (r, ctx) => ctx.entityName(r.company)],
];

export default function CredentialsReport({ entities }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [typeId, setTypeId] = useState('');
  const [state, setState] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    api.hrCredentialsReport().then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the report.'); });
    return () => { live = false; };
  }, [tick]);

  const ctx = useMemo(() => {
    const byId = Object.fromEntries((entities || []).map(en => [en.id, en.name]));
    return { entityName: id => byId[id] || '' };
  }, [entities]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.credentials || []).filter((r) => {
      if (company && r.company !== company) return false;
      if (typeId && r.typeId !== typeId) return false;
      if (state === 'attention' ? !['expiring', 'expired'].includes(r.state) : state && r.state !== state) return false;
      if (needle && ![r.person, r.workEmail, r.name, r.jobTitle, r.department].filter(Boolean).join(' ').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, q, company, typeId, state]);

  if (error) return <ErrorBanner message={error} onRetry={() => setTick(t => t + 1)} />;
  if (!data) return <SkeletonBlocks count={3} height={36} />;

  const exportCsv = () => downloadCsv(
    csvName('Licenses and Certifications', ctx.entityName(company) || '', new Date().toISOString().slice(0, 10)),
    COLUMNS.map(([l]) => l), rows.map(r => COLUMNS.map(([, v]) => v(r, ctx))));

  return (
    <div data-credentials-report>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="form-input" style={{ width: '100%', fontSize: 12.5, padding: '6px 8px 6px 28px' }}
            value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, license, title" aria-label="Search the report" />
        </div>
        <select className="form-input" style={SELECT} value={typeId} onChange={e => setTypeId(e.target.value)} aria-label="License or certification">
          <option value="">Every License</option>
          {(data.types || []).map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (Archived)' : ''}</option>)}
        </select>
        <select className="form-input" style={SELECT} value={state} onChange={e => setState(e.target.value)} aria-label="Status">
          <option value="">Every Status</option>
          <option value="attention">{`Expired or Expiring in ${data.expiringDays || 30} Days`}</option>
          {Object.entries(CRED_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="form-input" style={SELECT} value={company} onChange={e => setCompany(e.target.value)} aria-label="Company">
          <option value="">Every Company</option>
          {(entities || []).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} {rows.length === 1 ? 'record' : 'records'}</span>
        <button className="secondary-btn" onClick={exportCsv} disabled={rows.length === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Download size={14} /> Download CSV
        </button>
      </div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'auto', background: 'var(--card)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 760 }}>
          <thead>
            <tr>
              {COLUMNS.map(([l]) => (
                <th key={l} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 12, fontWeight: 600, color: 'var(--muted)',
                  background: 'var(--mist)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length} style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>
                {(data.credentials || []).length ? 'Nothing matches these filters.' : 'No licenses or certifications on file yet.'}
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                {COLUMNS.map(([l, v]) => (
                  <td key={l} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', color: 'var(--ink)', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l === 'Status' ? <CredentialState state={r.state} /> : (v(r, ctx) || <span style={{ color: 'var(--muted)' }}>-</span>)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
