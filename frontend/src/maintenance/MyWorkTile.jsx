// Workday's My Work tile (Construction plan phase 5, Neil 11/03/2026): where
// field staff already go. Shows only when there is maintenance work for the
// person (GET /maintenance/my-work), like Fill a Form; the list itself is the
// lazy My Work sheet.
import { Suspense, lazy, useEffect, useState } from 'react';
import { ArrowRight, Wrench } from 'lucide-react';
import { api } from '../api';
import SheetGuard from './SheetGuard';

const MyWorkSheet = lazy(() => import('./MyWorkSheet'));

export default function MyWorkTile() {
  const [work, setWork] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    api.getMyMaintenanceWork().then((d) => { if (live) setWork(d); }).catch(() => { if (live) setWork(null); });
    return () => { live = false; };
  }, [open]);
  const count = work?.tickets?.length || 0;
  if (!count && !open) return null;
  const sub = work?.overdue ? `${count} open · ${work.overdue} overdue` : `${count} open${work?.preventive ? ` · ${work.preventive} preventive` : ''}`;
  return (
    <>
      {count > 0 && (
        <button type="button" className="dk-stat wd-stat wd-askhr wd-forms" onClick={() => setOpen(true)}
          aria-label={`My Work, ${sub}`}>
          <span className="wd-askhr-badge" aria-hidden="true"><Wrench size={18} /></span>
          <span className="wd-stat-text">
            <span className="wd-askhr-title">My Work</span>
            <span className={`wd-askhr-sub${work?.overdue ? ' wd-askhr-sub--new' : ''}`}>{sub}</span>
          </span>
          <span className="wd-askhr-cta" aria-hidden="true">Open <ArrowRight size={13} /></span>
          <ArrowRight className="wd-askhr-go" size={15} aria-hidden="true" />
        </button>
      )}
      {open && (
        <SheetGuard onClose={() => setOpen(false)}>
          <Suspense fallback={null}>
            <MyWorkSheet initial={work} onClose={() => setOpen(false)} />
          </Suspense>
        </SheetGuard>
      )}
    </>
  );
}
