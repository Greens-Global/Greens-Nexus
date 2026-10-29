import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { ExtraTimeStatus, ExtraTimeDecideModal } from './ExtraTime';
import { hm } from '../lib/extraTime';
import { Avatar, AvatarName } from '../tasks/components';

// People > Time > Extra Time (India Contractor policy, Neil, Oct 27 2026):
// the claims waiting on a decision, oldest first, and the last 60 days of
// decisions. Approve (all or fewer of the hours) or decline with a reason -
// the time sheet cannot be approved while a claim of its month is pending.
// The server decides who may decide (HR, the HR contact, a Global Admin -
// never on their own claim).
export default function ExtraTimeQueue({ toastOk, toastErr, onOpenTimecard, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [deciding, setDeciding] = useState(null);
  const load = useCallback(() => {
    setErr('');
    api.extraTimeQueue()
      .then((d) => { setData(d || { pending: [], decided: [] }); onChanged?.((d?.pending || []).length); })
      .catch((e) => setErr(e?.message || 'Could not load the Extra Time claims.'));
  }, [onChanged]);
  useEffect(() => { load(); }, [load]);

  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <SkeletonBlocks count={3} height={56} borderRadius={10} />;
  const cell = { padding: '8px 10px', borderTop: '1px solid var(--line)', fontSize: 12.5, verticalAlign: 'top' };
  const head = { padding: '8px 10px', fontSize: 12, fontWeight: 700, textAlign: 'left', color: 'var(--muted)', whiteSpace: 'nowrap' };
  const table = (rows, pending) => (
    <div style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 10, background: 'var(--card)' }}>
      <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={head}>Contractor</th><th style={head}>Day Worked</th><th style={head}>Status</th>
            <th style={head}>Claimed</th><th style={head}>Approved</th><th style={head}>The Work</th>
            <th style={head}>{pending ? 'Filed' : 'Decided'}</th><th style={head} />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td style={cell}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Avatar email={c.employeeEmail} name={c.name} size={26} />
                  <button type="button" onClick={() => onOpenTimecard?.(c.employeeEmail, c.periodStart, 'fixed')}
                    style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--wk-brand)', cursor: 'pointer' }}
                    title="Open the time sheet">{c.name}</button>
                </span>
              </td>
              <td style={cell}>{formatDate(c.date)}</td>
              <td style={cell}><ExtraTimeStatus claim={c} /></td>
              <td style={cell}>{hm(c.claimedMin)}</td>
              <td style={cell}>{c.status === 'approved' ? hm(c.approvedMin) : '-'}</td>
              <td style={{ ...cell, whiteSpace: 'pre-wrap', maxWidth: 360 }}>
                {c.note}
                {c.status === 'declined' && c.decisionNote && <div style={{ color: '#b91c1c', marginTop: 4 }}>Declined: {c.decisionNote}</div>}
              </td>
              <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                {pending ? formatDateTime(c.createdAt) : <>{formatDateTime(c.decidedAt)}{c.decidedByName ? <> by <AvatarName email={c.decidedBy} name={c.decidedByName} size={18} /></> : ''}</>}
              </td>
              <td style={cell}>
                {c.canDecide && <button className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setDeciding(c)}>{pending ? 'Decide' : 'Change'}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div data-testid="extra-time-queue" style={{ display: 'grid', gap: 18 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Extra Time to Review</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          India contractors claim hours past 9 on a workday, or weekend and holiday hours, with a note. Approved hours are paid at 1.35x the hourly equivalent of the daily rate; a month's time sheet waits until each claim is decided.
        </div>
        {data.pending.length ? table(data.pending, true)
          : <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>No Extra Time is waiting on a decision.</div>}
      </div>
      {data.decided.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>Decided in the Last 60 Days</div>
          {table(data.decided, false)}
        </div>
      )}
      {deciding && (
        <ExtraTimeDecideModal fd={{ date: deciding.date, claim: deciding }} name={deciding.name}
          onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); load(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}
