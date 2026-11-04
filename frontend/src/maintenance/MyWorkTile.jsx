// Workday's My Tickets tile (Construction plan phase 5, Neil 11/03/2026;
// "My Work" until 11/04/2026, when Neil made it a full-size tile in the stat
// row, left of the compact Ask HR / Reimbursements rows, beside Time With
// Us). Shows only when there is maintenance work for the person (GET
// /maintenance/my-work), like Fill a Form; the list itself is the lazy sheet.
// The page reads the work once through useMyMaintenanceWork, so its grid
// knows whether to make room for the tile.
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { ArrowRight, Wrench } from 'lucide-react';
import { api } from '../api';
import SheetGuard from './SheetGuard';

const MyWorkSheet = lazy(() => import('./MyWorkSheet'));

export function useMyMaintenanceWork() {
  const [work, setWork] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.getMyMaintenanceWork().then((d) => { if (live) setWork(d || null); }).catch(() => { if (live) setWork(null); });
    return () => { live = false; };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { work, count: work?.tickets?.length || 0, reload };
}

export default function MyWorkTile({ work, count = 0, reload }) {
  const [open, setOpen] = useState(false);
  if (!count && !open) return null;
  const sub = work?.overdue ? `${work.overdue} overdue` : work?.preventive ? `${work.preventive} preventive` : 'Assigned to you';
  const close = () => { setOpen(false); reload?.(); };
  return (
    <>
      {count > 0 && (
        <button type="button" data-my-tickets className="dk-stat wd-stat" onClick={() => setOpen(true)}
          title="The maintenance tickets assigned to you, preventive first. Opens My Tickets."
          aria-label={`My Tickets, ${count} open${work?.overdue ? `, ${work.overdue} overdue` : ''}`}>
          <span className="dk-chip dk-chip--blue"><Wrench /></span>
          <span className="wd-stat-text">
            <span className="dk-stat-num">{count}</span>
            <span className="dk-stat-label">My Tickets</span>
            <span className="dk-stat-sub" style={work?.overdue ? { color: 'hsl(var(--color-red))', fontWeight: 700 } : undefined}>{sub}</span>
          </span>
          <ArrowRight size={16} className="dk-stat-arrow" aria-hidden="true" />
        </button>
      )}
      {open && (
        <SheetGuard onClose={close}>
          <Suspense fallback={null}>
            <MyWorkSheet initial={work} onClose={close} />
          </Suspense>
        </SheetGuard>
      )}
    </>
  );
}
