// People > Reports (Neil, Teams 11/02/2026: "Reports to be added to People
// Module - Filters - Company Directory, Contractors, Employees"). Three
// filterable, exportable lists over the people the viewer already sees -
// the server scoped the rows before they got here (company walls, the
// manager tier's team), so the reports can never show more than People does.
// Download CSV writes exactly the filtered table. No pay anywhere.
import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { formatDate } from '../lib/datetime';
import { csvName, downloadCsv } from '../operations/csv';

const fullName = e => (e.displayName || [e.firstName, e.lastName].filter(Boolean).join(' ')).trim();
const isExternal = e => ['guest', 'external'].includes(e?.identityType || 'internal');
const TYPE_LABEL = { full_time: 'Full Time', part_time: 'Part Time', contractor: 'Contractor', intern: 'Intern' };
const STATUS_LABEL = { onboarding: 'Onboarding', active: 'Active', inactive: 'Inactive', offboarded: 'Left', staged: 'Staged' };
const day = d => (d ? formatDate(`${String(d).slice(0, 10)}T12:00:00`) : '');

// Each report: who is in it, and its columns (label + value). `ctx` carries
// the entity-name and manager-name lookups.
const REPORTS = [
  {
    key: 'directory', label: 'Company Directory', file: 'Company Directory',
    hint: 'Everyone and how to reach them - employees, contractors and external partners.',
    rows: ({ people }) => people,
    columns: [
      { label: 'Name', value: e => fullName(e) },
      { label: 'Job Title', value: e => e.jobTitle || '' },
      { label: 'Department', value: e => e.department || '' },
      { label: 'Company', value: (e, ctx) => (isExternal(e) ? e.externalCompany : ctx.entityName(e.company)) || '' },
      { label: 'Work Email', value: e => e.workEmail || '' },
      { label: 'Phone', value: e => e.phone || '' },
      { label: 'Location', value: e => e.location || '' },
      { label: 'Type', value: e => (isExternal(e) ? 'External' : TYPE_LABEL[e.employmentType] || e.employmentType || '') },
      { label: 'Status', value: e => STATUS_LABEL[e.status] || e.status || '' },
    ],
  },
  {
    key: 'employees', label: 'Employees', file: 'Employees',
    hint: 'People on payroll - full time, part time and interns. Contractors and externals have their own report.',
    rows: ({ people }) => people.filter(e => !isExternal(e) && (e.employmentType || 'full_time') !== 'contractor'),
    columns: [
      { label: 'Code', value: e => e.employeeCode || '' },
      { label: 'Name', value: e => fullName(e) },
      { label: 'Job Title', value: e => e.jobTitle || '' },
      { label: 'Department', value: e => e.department || '' },
      { label: 'Company', value: (e, ctx) => ctx.entityName(e.company) || '' },
      { label: 'Type', value: e => TYPE_LABEL[e.employmentType] || e.employmentType || '' },
      { label: 'Country', value: e => e.country || '' },
      { label: 'Start Date', value: e => day(e.startDate) },
      { label: 'Manager', value: (e, ctx) => ctx.managerName(e.managerEmail) },
      { label: 'Status', value: e => STATUS_LABEL[e.status] || e.status || '' },
    ],
  },
  {
    key: 'contractors', label: 'Contractors', file: 'Contractors',
    hint: 'Independent contractors - engagement, billing client and contract end. Never their rate.',
    rows: ({ people }) => people.filter(e => !isExternal(e) && (e.employmentType || '') === 'contractor'),
    columns: [
      { label: 'Code', value: e => e.employeeCode || '' },
      { label: 'Name', value: e => fullName(e) },
      { label: 'Company', value: (e, ctx) => ctx.entityName(e.company) || '' },
      { label: 'Billing Client', value: e => e.contractor?.billing_client || '' },
      { label: 'Country', value: e => e.country || '' },
      { label: 'Start Date', value: e => day(e.startDate) },
      { label: 'Contract End', value: e => day(e.contractor?.contract_end) },
      { label: 'Manager', value: (e, ctx) => ctx.managerName(e.managerEmail) },
      { label: 'Status', value: e => STATUS_LABEL[e.status] || e.status || '' },
    ],
  },
];

const SELECT = { fontSize: 13, padding: '6px 8px' };

export default function PeopleReports({ employees, externals, entities }) {
  const [report, setReport] = useState('directory');
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('active');

  const def = REPORTS.find(r => r.key === report) || REPORTS[0];
  const everyone = useMemo(
    () => [...(employees || []), ...(report === 'directory' ? (externals || []) : [])]
      .sort((a, b) => fullName(a).localeCompare(fullName(b))),
    [employees, externals, report]);
  const ctx = useMemo(() => {
    const byId = Object.fromEntries((entities || []).map(en => [en.id, en.name]));
    const byEmail = Object.fromEntries(
      [...(employees || []), ...(externals || [])]
        .filter(e => e.workEmail).map(e => [e.workEmail.toLowerCase(), fullName(e)]));
    return {
      entityName: id => byId[id] || '',
      managerName: em => (em ? byEmail[String(em).toLowerCase()] || em : ''),
    };
  }, [employees, externals, entities]);

  const departments = useMemo(
    () => [...new Set(everyone.map(e => (e.department || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [everyone]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return def.rows({ people: everyone }).filter(e => {
      if (status && (e.status || 'active') !== status) return false;
      if (company && !isExternal(e) && (e.company || '') !== company) return false;
      if (company && isExternal(e)) return false;   // externals belong to no legal entity of ours
      if (dept && (e.department || '').trim() !== dept) return false;
      if (needle) {
        const hay = [fullName(e), e.workEmail, e.jobTitle, e.department, e.employeeCode,
          ctx.entityName(e.company), e.externalCompany].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [def, everyone, q, company, dept, status, ctx]);

  const exportCsv = () => {
    downloadCsv(
      csvName(def.file, ctx.entityName(company) || '', new Date().toISOString().slice(0, 10)),
      def.columns.map(c => c.label),
      rows.map(e => def.columns.map(c => c.value(e, ctx))));
  };

  return (
    <div>
      {/* Which report - a segmented strip, same grammar as the Time tab's inner lists. */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {REPORTS.map(r => (
          <button key={r.key} onClick={() => setReport(r.key)}
            style={{ padding: '7px 14px', borderRadius: 20, fontSize: 13, fontWeight: 700, fontFamily: 'Inter,sans-serif',
              border: `1px solid ${report === r.key ? 'var(--pine)' : 'var(--line)'}`, cursor: 'pointer', whiteSpace: 'nowrap',
              background: report === r.key ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
              color: report === r.key ? 'var(--ink)' : 'var(--muted)' }}>
            {r.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>{def.hint}</div>

      {/* Filters (Neil asked for them by name) + the export of exactly what shows. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="form-input" style={{ width: '100%', fontSize: 13, padding: '6px 8px 6px 28px' }}
            value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email, title, code" aria-label="Search the report" />
        </div>
        <select className="form-input" style={SELECT} value={company} onChange={e => setCompany(e.target.value)} aria-label="Company">
          <option value="">Every Company</option>
          {(entities || []).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <select className="form-input" style={SELECT} value={dept} onChange={e => setDept(e.target.value)} aria-label="Department">
          <option value="">Every Department</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="form-input" style={SELECT} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">Every Status</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
        <button className="secondary-btn" onClick={exportCsv} disabled={rows.length === 0}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Download size={14} /> Download CSV
        </button>
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'auto', background: 'var(--card)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
          <thead>
            <tr>
              {def.columns.map(c => (
                <th key={c.label} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700,
                  color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em',
                  background: 'var(--mist)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={def.columns.length} style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>
                No one matches these filters.
              </td></tr>
            )}
            {rows.map(e => (
              <tr key={e.id}>
                {def.columns.map(c => (
                  <td key={c.label} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)',
                    color: 'var(--ink)', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.value(e, ctx) || <span style={{ color: 'var(--muted)' }}>-</span>}
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
