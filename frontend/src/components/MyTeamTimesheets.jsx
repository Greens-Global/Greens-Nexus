import { useEffect, useMemo, useState } from 'react';
import { Users, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';

// My Team's Timesheets (Pranshu, 10/06): every timesheet of the people who
// report to you - waiting on you, back with them, signing, completed - and who
// has not handed in the current period yet. Reached from Workday, so a manager
// needs no People module; hours only, never pay (the server sends none).
// Clicking a row opens that timesheet (onOpen(reviewId)). Renders nothing for
// someone nobody reports to.

const STATUS = {
  with_manager: ['Waiting on You', '#b45309'],
  with_employee: ['Back With Employee', '#2563eb'],
  signing: ['Signing', '#7c3aed'],
  completed: ['Completed', '#16a34a'],
  not_submitted: ['Not Submitted', 'var(--muted)'],
};
const label = (s) => STATUS[s]?.[0] || (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

export default function MyTeamTimesheets({ onOpen }) {
  const [data, setData] = useState(null);
  const [who, setWho] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => api.timesheetReviewTeam().then((r) => { if (live) setData(r || { reviews: [], notSubmitted: [] }); }).catch(() => {});
    load();
    window.addEventListener('nexus:timesheet-review-changed', load);
    return () => { live = false; window.removeEventListener('nexus:timesheet-review-changed', load); };
  }, []);
  const people = useMemo(() => {
    const m = new Map();
    [...(data?.reviews || []), ...(data?.notSubmitted || [])].forEach((r) => m.set(r.employeeEmail, r.name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  if (!data || (!data.reviews?.length && !data.notSubmitted?.length)) return null;
  const rows = (data.reviews || []).filter((r) => (!who || r.employeeEmail === who) && (!status || r.status === status));
  const waiting = (data.notSubmitted || []).filter((r) => !who || r.employeeEmail === who);
  const cell = { padding: '8px 10px', fontSize: 12.5, borderTop: '1px solid var(--line)', textAlign: 'left' };
  const head = { ...cell, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', borderTop: 'none' };
  return (
    <div style={{ marginBottom: 16, border: '1px solid var(--wk-line2)', background: 'var(--card)', borderRadius: 12, padding: '12px 16px', boxShadow: 'var(--wk-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Users size={15} style={{ color: 'var(--wk-brand)' }} />
        <span style={{ fontWeight: 800, fontSize: 13.5, flex: 1 }}>My Team&apos;s Timesheets</span>
        <select className="form-input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by employee" style={{ fontSize: 12, width: 'auto' }}>
          <option value="">Everyone</option>
          {people.map(([em, name]) => <option key={em} value={em}>{name}</option>)}
        </select>
        <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" style={{ fontSize: 12, width: 'auto' }}>
          <option value="">All Statuses</option>
          {['with_manager', 'with_employee', 'signing', 'completed'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      {waiting.length > 0 && !status && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          Not submitted yet for the current period: {waiting.map((w) => `${w.name} (${formatDate(w.periodStart)} - ${formatDate(w.periodEnd)})`).join(', ')}
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>No timesheets match.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead><tr><th style={head}>Employee</th><th style={head}>Period</th><th style={head}>Status</th><th style={head}>Hours</th><th style={head}>Submitted</th><th style={head} /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onOpen?.(r.id)} style={{ cursor: 'pointer' }} className="nx-row-hover">
                  <td style={{ ...cell, fontWeight: 700 }}>{r.name}</td>
                  <td style={cell}>{formatDate(r.periodStart)} - {formatDate(r.periodEnd)}</td>
                  <td style={{ ...cell, fontWeight: 700, color: STATUS[r.status]?.[1] || 'var(--ink)' }}>{label(r.status)}</td>
                  <td style={cell}>{r.workedMin ? hm(r.workedMin) : '-'}</td>
                  <td style={cell}>{r.submittedAt ? formatDate(r.submittedAt) : '-'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); onOpen?.(r.id); }}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>Open <ChevronRight size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
