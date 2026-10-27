// Leave History (Before Time Off) - the retired HR Leave tracker, read only
// (Neil, Oct 27 2026). Leave is requested and approved in Time Off now; the
// old hr_leave_requests rows are kept and shown here for HR, never edited.
// Collapsed until opened, so it costs nothing until someone looks.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { StatusLabel } from './StatusLabel';

const TYPE = { annual: 'Annual', sick: 'Sick', unpaid: 'Unpaid' };
const STATUS = {
  pending: ['Pending', '#b45309'], approved: ['Approved', '#15803d'], rejected: ['Rejected', '#b91c1c'],
};

export default function LeaveHistory() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [names, setNames] = useState({});
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setErr(''); setRows(null);
    Promise.all([api.getLeave(), api.getEmployees().catch(() => [])])
      .then(([leave, emps]) => {
        if (!live) return;
        setNames(Object.fromEntries((emps || []).map((e) => [e.id, `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.workEmail || e.id])));
        setRows(Array.isArray(leave) ? leave : []);
      })
      .catch((e) => { if (!live) return; if (e?.status === 403) setHidden(true); else setErr(e?.message || 'Could not load the leave history.'); });
    return () => { live = false; };
  }, [open, tick]);
  if (hidden) return null;
  return (
    <section aria-label="Leave History (Before Time Off)" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, margin: '14px 0', boxShadow: 'var(--wk-shadow)', fontFamily: 'var(--wk-font)', overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '13px 16px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
        <span className="wkc-chip"><History size={14} /></span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', flex: 1 }}>Leave History (Before Time Off)</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px' }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Leave recorded in the old HR Leave tracker, kept as it was. New leave is requested and approved in Time Off.
          </div>
          {err ? <ErrorBanner message={err} onRetry={() => setTick((t) => t + 1)} />
            : rows === null ? <SkeletonBlocks count={3} height={26} borderRadius={8} />
            : rows.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No leave was recorded there.</div>
            : (
              <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, overflow: 'hidden', maxHeight: 420, overflowY: 'auto' }}>
                {rows.map((r) => {
                  const [label, color] = STATUS[r.status] || [r.status, '#64748b'];
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                      <span style={{ fontWeight: 700, color: 'var(--ink)', minWidth: 140, flex: '1 1 160px' }}>{names[r.employeeId] || 'Unknown'}</span>
                      <span style={{ color: 'var(--muted)', flex: '2 1 220px', minWidth: 0 }}>
                        {TYPE[r.leaveType] || r.leaveType} · {r.days} day{r.days === 1 ? '' : 's'} · {formatDate(r.startDate, r.startDate)}
                        {r.endDate && r.endDate !== r.startDate ? ` - ${formatDate(r.endDate, r.endDate)}` : ''}
                        {r.reason ? ` · ${r.reason}` : ''}{r.decisionNote ? ` · Note: ${r.decisionNote}` : ''}
                      </span>
                      <StatusLabel label={label} color={color} size="sm" />
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </section>
  );
}
