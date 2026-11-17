// A property's Jobs on its Asset Management page (Neil, 11/03/2026,
// construction plan phase 2): the construction jobs - work orders and
// projects - on this property, the open ones with their health and the most
// recent finished ones. READ ONLY, self-contained: it reads
// GET /construction/properties/{id}/jobs (api.getPropertyJobs), which applies
// the Construction walls and keeps a private property private (a 404 reads as
// nothing here). Nothing here writes the Asset Management workspace. A row
// opens the job.
//
// The look (Neil, 11/17/2026): no card, hairline rows, the health as colored
// words. `variant="rail"` is the overview rail's Work block: the open jobs
// only, no heading of its own; `onLoaded(data)` tells the block what came back
// so it can say "No open tickets or construction jobs" in one line.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { formatDate } from '../lib/datetime';

const HEALTH = { late: ['Late', 'hsl(var(--color-red))'], at_risk: ['At Risk', 'hsl(var(--color-orange))'], on_track: ['On Track', 'hsl(var(--color-green))'], complete: ['Complete', 'hsl(var(--color-blue))'] };
const TYPE = { work_order: 'Work Order', project: 'Project' };
const open = (id) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'ops', sub: `project:${id}` } }));

function Row({ j, done, rail }) {
  const h = HEALTH[j.health?.state];
  const state = done ? [j.status === 'archived' ? 'Archived' : 'Complete', 'var(--text-muted)'] : h;
  return (
    <button type="button" onClick={() => open(j.id)} data-property-job={j.id}
      style={{ display: 'flex', width: '100%', alignItems: rail ? 'flex-start' : 'baseline', flexDirection: rail ? 'column' : 'row', justifyContent: 'space-between', gap: rail ? 2 : 10, padding: rail ? '6px 0' : '9px 0',
        background: 'none', border: 'none', borderTop: rail ? 'none' : '1px solid var(--border-color)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
      <span style={{ minWidth: 0, fontSize: 13, color: 'var(--text-primary)', fontWeight: rail ? 500 : 600 }}>
        {j.name}
        {!rail && <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> · {TYPE[j.jobType] || 'Project'}{j.targetFinishOn ? ` · Target ${formatDate(j.targetFinishOn, j.targetFinishOn)}` : ''}</span>}
      </span>
      {rail ? (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {TYPE[j.jobType] || 'Project'}{j.targetFinishOn ? ` · Target ${formatDate(j.targetFinishOn, j.targetFinishOn)}` : ''}
          {state && <> · <span style={{ color: state[1], fontWeight: 600 }}>{state[0]}</span></>}
        </span>
      ) : state && <span style={{ fontSize: 13, fontWeight: 500, color: state[1], whiteSpace: 'nowrap' }}>{state[0]}</span>}
    </button>
  );
}

export default function PropertyJobs({ property, variant = 'full', onLoaded = null }) {
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
  useEffect(() => { if (data && onLoaded) onLoaded(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data?.unavailable) return null;
  const openJobs = data?.open || [];
  const recent = data?.recent || [];
  if (variant === 'rail') {
    if (!data) return <SkeletonBlocks count={1} height={32} borderRadius={8} />;
    return openJobs.length ? <div aria-label="Open jobs" role="group" data-property-jobs="">{openJobs.map((j) => <Row key={j.id} j={j} rail />)}</div> : null;
  }
  return (
    <section style={{ margin: '24px 0 0' }} aria-label="Jobs" data-property-jobs="">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Jobs</h3>
        {data && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>{openJobs.length ? `${openJobs.length} open` : 'none open'}</span>}
      </div>
      {!data ? <SkeletonBlocks count={2} height={36} borderRadius={8} /> : (
        openJobs.length === 0 && recent.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No construction or maintenance jobs on this property.</div>
        ) : (
          <>
            {openJobs.map((j) => <Row key={j.id} j={j} />)}
            {recent.length > 0 && (
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '12px 0 2px' }}>Recent</div>
            )}
            {recent.map((j) => <Row key={j.id} j={j} done />)}
          </>
        )
      )}
    </section>
  );
}
