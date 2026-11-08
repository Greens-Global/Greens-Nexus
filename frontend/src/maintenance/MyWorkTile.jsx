// Workday's My Tickets tile (Construction plan phase 5, Neil 11/03/2026;
// "My Work" until 11/04/2026; since 11/08/2026 one of the action pills under
// the clock card, the same anatomy as Ask HR - Neil's Workday cleanup). Shows when there is maintenance work for the person (GET
// /maintenance/my-work), and always - at 0, "Nothing open" - for someone on a
// maintenance team (`onTeam`, Neil 11/04/2026); the list is the lazy sheet.
// The page reads the work once through useMyMaintenanceWork.
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
  const count = work?.tickets?.length || 0;
  return { work, count, show: count > 0 || !!work?.onTeam, reload };
}

export default function MyWorkTile({ work, count = 0, show = count > 0, reload }) {
  const [open, setOpen] = useState(false);
  if (!show && !open) return null;
  const sub = work?.overdue ? `${work.overdue} overdue` : work?.preventive ? `${work.preventive} preventive`
    : count ? 'Assigned to you' : 'Nothing open';
  const close = () => { setOpen(false); reload?.(); };
  return (
    <>
      {show && (
        <button type="button" data-my-tickets className="dk-stat wd-stat wd-askhr wd-mywork" onClick={() => setOpen(true)}
          title="The maintenance tickets assigned to you, preventive first. Opens My Tickets."
          aria-label={`My Tickets, ${count} open${work?.overdue ? `, ${work.overdue} overdue` : ''}`}>
          <span className="wd-askhr-badge" aria-hidden="true">
            <Wrench size={18} />
            {work?.overdue > 0 && <span className="wd-askhr-dot" />}
          </span>
          <span className="wd-stat-text">
            <span className="wd-askhr-title">My Tickets</span>
            <span className={`wd-askhr-sub${work?.overdue ? ' wd-askhr-sub--new' : ''}`}>{count ? `${count} open · ${sub}` : sub}</span>
          </span>
          <ArrowRight className="wd-askhr-go" size={15} aria-hidden="true" />
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
