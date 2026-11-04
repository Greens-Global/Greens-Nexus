// The schedule around a time-off or shift request, in the Review panel
// (Team > Requests moved into Approvals, Neil 11/04/2026: "make sure that
// the necessary data is there for someone to make a decision"). The row's
// `context` (approvals_inbox.py) says whose week and which dates; ONE
// schedule read when the row is opened - never on the minute poll the nav
// counts share. A read that fails is simply no context.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import { addDaysIso } from '../components/shifts/shiftLib';
import { contextOf, daysOf, RequestContext } from '../components/shifts/requestContext';

export default function ScheduleContext({ row }) {
  const c = row?.context;
  const nameOf = useNameResolver();
  const [sched, setSched] = useState(null);
  const from = c?.from || '';
  const to = c?.to && c.to >= from ? (c.to < addDaysIso(from, 91) ? c.to : addDaysIso(from, 91)) : from;
  useEffect(() => {
    if (!from) return undefined;
    let live = true;
    setSched(null);
    Promise.resolve().then(() => api.timeSchedule(from, to))
      .then((r) => { if (live) setSched(r && Array.isArray(r.scheduled) ? r : null); })
      .catch(() => { if (live) setSched(null); });
    return () => { live = false; };
  }, [row?.key, from, to]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!c || !from) return null;
  const release = !c.email;
  const ctx = contextOf(sched, c.email || c.team, daysOf(from, to), c.skip || '', release);
  if (!ctx) return null;
  return (
    <div className="apv-sched" data-schedule-context="">
      <div className="apv-sched-h">On The Schedule</div>
      <RequestContext ctx={ctx} nameOf={(e) => nameOf(e)} />
    </div>
  );
}
