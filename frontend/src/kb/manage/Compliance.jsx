// People by requirements: green, amber, red. Direct reports by default.
import { useEffect, useState } from 'react';
import { Bell, Download, Check } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Stat, Av } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, CELL_COLORS, fmtDate, plural } from '../lib';
import { toCsv } from '../../operations/csv';
import TrainingReport from './TrainingReport';

// Byte order mark: makes Excel read the file as UTF-8 (names with accents).
const BOM = String.fromCharCode(0xFEFF);

export default function Compliance({ me }) {
  const toast = useToast();
  const [scope, setScope] = useState('direct');
  const [company, setCompany] = useState('');
  const [department, setDepartment] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState([]);
  const load = () => { setErr(''); api.kbCompliance({ scope, company, department }).then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, [scope, company, department]); // eslint-disable-line react-hooks/exhaustive-deps
  const nudge = async (emails) => { try { const r = await api.kbComplianceNudge(emails); toast(r.nudged ? `Nudged ${plural(r.nudged, 'person', 'people')}` : 'Nothing to nudge, or already nudged today'); setPicked([]); } catch (e) { toast(errText(e), 'err'); } };
  const exportCsv = () => {
    const head = ['Name', 'Email', 'Department', 'Job Title', ...data.columns.map((c) => c.title)];
    const lines = data.people.map((p) => [p.name, p.email, p.department, p.job_title, ...data.columns.map((c) => { const cell = p.cells[c.key]; return cell ? `${cell.status}${cell.due ? ` (due ${fmtDate(cell.due)})` : ''}` : ''; })]);
    // toCsv defuses cells a spreadsheet would run as a formula (= + - @).
    saveBlob(new Blob([BOM, toCsv(head, lines)], { type: 'text/csv;charset=utf-8' }), `compliance-${scope}.csv`);
  };
  const behind = data ? data.people.filter((p) => p.counts.red > 0).map((p) => p.email) : [];

  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Compliance</h1>
        <div className="kb-seg">
          <button type="button" onClick={() => goKb('health')}>Health</button>
          <button type="button" className="on">Compliance</button>
          <button type="button" onClick={() => goKb('collections')}>Collections</button>
          <button type="button" onClick={() => goKb('plans')}>Plans and Rules</button>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="kb-btn" disabled={!data} onClick={exportCsv}><Download />CSV</button>
          <button type="button" className="kb-btn pri" disabled={!picked.length && !behind.length} onClick={() => nudge(picked.length ? picked : behind)}><Bell />Nudge {picked.length ? `${picked.length} Picked` : 'Everyone Behind'}</button>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="kb-seg">
          <button type="button" className={scope === 'direct' ? 'on' : ''} onClick={() => setScope('direct')}>My Direct Reports</button>
          <button type="button" className={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>My Whole Team</button>
          {(me?.can_manage || data?.filters?.can_company) && <button type="button" className={scope === 'company' ? 'on' : ''} onClick={() => setScope('company')}>Company</button>}
        </div>
        {data?.filters?.companies?.length > 1 && <select className="kb-select" style={{ width: 'auto' }} value={company} onChange={(e) => setCompany(e.target.value)}><option value="">All companies</option>{data.filters.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        {data?.filters?.departments?.length > 1 && <select className="kb-select" style={{ width: 'auto' }} value={department} onChange={(e) => setDepartment(e.target.value)}><option value="">All departments</option>{data.filters.departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
      </div>
      <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
        {data && (
          <>
            {me?.can_manage && <TrainingReport />}
            <div className="kb-stats">
              <Stat value={`${data.stats.compliant_pct}%`} label="of requirements met" color={data.stats.compliant_pct >= 90 ? '#1e7b4e' : '#b45309'} />
              <Stat value={data.stats.overdue} label="overdue or expired" color={data.stats.overdue ? '#dc2626' : undefined} />
              <Stat value={data.stats.due_soon} label="due soon or in progress" color={data.stats.due_soon ? '#d97706' : undefined} />
              <Stat value={`${data.stats.compliant_people} of ${data.stats.people}`} label="people fully compliant" />
            </div>
            {data.people.length === 0 && <div className="kb-card soft kb-empty">{scope === 'direct' ? 'No direct reports with requirements. Try My Whole Team.' : 'Nobody in this scope has training or policies assigned.'}</div>}
            {data.people.length > 0 && (
              <section className="kb-card" style={{ padding: 0, overflow: 'auto' }}>
                <table className="kb-table" style={{ minWidth: 640 }}>
                  <thead><tr>
                    <th className="kb-sticky-col" style={{ minWidth: 220 }}><label className="kb-check" style={{ fontSize: 11 }}><input type="checkbox" checked={picked.length > 0 && picked.length === behind.length} onChange={(e) => setPicked(e.target.checked ? behind : [])} />Person</label></th>
                    {data.columns.map((c) => <th key={c.key} style={{ minWidth: 120, maxWidth: 160 }}><a href="#c" onClick={(e) => { e.preventDefault(); goKb(c.kind === 'course' ? 'builder' : 'signatures', c.id); }} title={c.title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit' }}>{c.kind === 'policy' ? 'Sign: ' : ''}{c.title}</a></th>)}
                    <th>Done</th>
                  </tr></thead>
                  <tbody>
                    {data.people.map((p) => (
                      <tr key={p.email}>
                        <td className="kb-sticky-col"><label className="kb-check" style={{ fontSize: 13 }}><input type="checkbox" checked={picked.includes(p.email)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.email] : picked.filter((x) => x !== p.email))} /><Av name={p.name} email={p.email} size={24} /><span><span style={{ fontWeight: 600, display: 'block' }}>{p.name}</span><span className="kb-meta">{[p.job_title, p.department].filter(Boolean).join(' · ')}</span></span></label></td>
                        {data.columns.map((c) => {
                          const cell = p.cells[c.key];
                          if (!cell) return <td key={c.key}><span className="kb-meta">-</span></td>;
                          const tip = `${cell.status}${cell.due ? ` · due ${fmtDate(cell.due)}` : ''}${cell.expires ? ` · valid through ${fmtDate(cell.expires)}` : ''}${cell.days_overdue ? ` · ${cell.days_overdue} days overdue` : ''}`;
                          return <td key={c.key}><div className="kb-grid-cell" style={{ background: CELL_COLORS[cell.color] }} title={tip}>{cell.color === 'green' ? <Check size={14} /> : cell.days_overdue ? `${cell.days_overdue}d late` : cell.pct != null && cell.status === 'In Progress' ? `${cell.pct}%` : cell.status}</div></td>;
                        })}
                        <td style={{ whiteSpace: 'nowrap' }}><span style={{ color: CELL_COLORS.green, fontWeight: 600 }}>{p.counts.green}</span> / <span style={{ color: CELL_COLORS.amber, fontWeight: 600 }}>{p.counts.amber}</span> / <span style={{ color: CELL_COLORS.red, fontWeight: 600 }}>{p.counts.red}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <div className="kb-meta">Green: done and current. Amber: in progress, not started, or due within 14 days. Red: overdue or expired. Managers get a Monday digest of anyone red; a nudge sends one bell and one email now.</div>
          </>
        )}
      </AsyncSection>
    </div>
  );
}
