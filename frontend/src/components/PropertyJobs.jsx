// A property's Jobs on its Asset Management page (Neil, 11/03/2026,
// construction plan phase 2): the construction jobs - work orders and
// projects - on this property, the open ones with their health and the most
// recent finished ones. READ ONLY, self-contained and mounted with one line in
// asset/App.jsx like PropertyLoans: it reads GET /construction/properties/{id}/jobs
// (api.getPropertyJobs), which applies the Construction walls and keeps a
// private property private (a 404 reads as nothing here). Nothing here writes
// the Asset Management workspace. A row opens the job.
import { useEffect, useState } from 'react';
import { HardHat } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { formatDate } from '../lib/datetime';

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '14px 16px', marginTop: 16 };
const HEALTH = { late: ['Late', '#dc2626'], at_risk: ['At Risk', '#ca8a04'], on_track: ['On Track', '#16a34a'], complete: ['Complete', '#2563eb'] };
const TYPE = { work_order: 'Work Order', project: 'Project' };
const open = (id) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'ops', sub: `project:${id}` } }));

function Row({ j, done }) {
  const h = HEALTH[j.health?.state];
  return (
    <button type="button" onClick={() => open(j.id)} data-property-job={j.id}
      style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0',
        background: 'none', border: 'none', borderTop: '1px solid var(--border-color)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
      <span style={{ minWidth: 0, fontSize: '0.86rem', color: 'var(--text-primary)' }}>
        <b>{j.name}</b>
        <span style={{ color: 'var(--text-secondary)' }}> · {TYPE[j.jobType] || 'Project'}{j.targetFinishOn ? ` · Target ${formatDate(j.targetFinishOn, j.targetFinishOn)}` : ''}</span>
      </span>
      {done ? <StatusLabel size="sm" label={j.status === 'archived' ? 'Archived' : 'Complete'} color="#64748b" />
        : h && <StatusLabel size="sm" label={h[0]} color={h[1]} />}
    </button>
  );
}

export default function PropertyJobs({ property }) {
  const id = property?.id || '';
  const [state, setState] = useState({ id: null, data: null });
  useEffect(() => {
    let live = true;
    if (!id) return undefined;
    Promise.resolve().then(() => api.getPropertyJobs(id))
      .then((data) => { if (live) setState({ id, data }); })
      .catch(() => { if (live) setState({ id, data: { open: [], recent: [], unavailable: true } }); });
    return () => { live = false; };
  }, [id]);
  const data = state.id === id ? state.data : null;
  if (data?.unavailable) return null;
  const openJobs = data?.open || [];
  const recent = data?.recent || [];
  return (
    <section style={card} aria-label="Jobs" data-property-jobs="">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.92rem', fontWeight: 700, marginBottom: 6 }}>
        <HardHat size={16} style={{ color: 'var(--text-secondary)' }} /> Jobs
        {data && <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{openJobs.length} open</span>}
      </div>
      {!data ? <SkeletonBlocks count={2} height={36} borderRadius={8} /> : (
        openJobs.length === 0 && recent.length === 0 ? (
          <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>No construction or maintenance jobs on this property.</div>
        ) : (
          <>
            {openJobs.map((j) => <Row key={j.id} j={j} />)}
            {recent.length > 0 && (
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', margin: '10px 0 2px' }}>Recent</div>
            )}
            {recent.map((j) => <Row key={j.id} j={j} done />)}
          </>
        )
      )}
    </section>
  );
}
