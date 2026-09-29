// Shifts > Requests (Sep 30 2026), the counterpart of the Requests tab in
// Teams Shifts. One place for everyone to ASK - swap a shift, offer one,
// take an open one, ask for time off - and to see what waits on them and
// what became of what they asked. Managers and above also decide their
// team's requests here (the same inbox the schedule grid opens).
//
// Before this page a swap or an offer could only be started from a small
// button under one of your own published shifts, so anyone with nothing
// published that week never saw that it existed.
import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { toDateInputValue } from '../lib/datetime';
import { SkeletonBlocks } from './AsyncState';
import { NewRequestDialog, OpenShifts, ShiftRequestsList } from './ShiftSelfService';
import ShiftRequestsInbox from './ShiftRequestsInbox';
import { useShiftRequests } from './useShiftRequests';

const WEEKS_AHEAD = 8;   // how far ahead a shift can be picked for a swap or an offer

function plusDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

export default function ShiftRequestsPage({ canManage = false, toastOk, toastErr }) {
  const [start, end] = useMemo(() => {
    const today = new Date();
    return [toDateInputValue(today), toDateInputValue(plusDays(today, WEEKS_AHEAD * 7))];
  }, []);
  const [reqs, reloadReqs] = useShiftRequests(start, end);
  const [mine, setMine] = useState(null);       // my published shifts, today onward
  const [tick, setTick] = useState(0);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    api.timeMySchedule(start, end)
      .then(r => { if (live) setMine((r?.scheduled || []).filter(s => s.date >= start)); })
      .catch(() => { if (live) setMine([]); });
    return () => { live = false; };
  }, [start, end, tick]);

  const done = (msg) => { setAsking(false); toastOk?.(msg); reloadReqs(); setTick(t => t + 1); };
  const nothingYet = reqs && !(reqs.mine || []).length && !(reqs.incoming || []).length
    && !(reqs.settings?.openShifts && (reqs.openShifts || []).length);

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1, minWidth: 220 }}>
          A swap or an offer goes to your teammate first, then to a manager. Nothing on the schedule changes until a manager approves.
        </span>
        <button type="button" className="primary-btn" onClick={() => setAsking(true)} disabled={!reqs || mine === null}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Request
        </button>
      </div>

      {!reqs ? (
        <div style={{ marginTop: 16 }}><SkeletonBlocks count={3} height={56} /></div>
      ) : (
        <>
          <ShiftRequestsList reqs={reqs} onDone={done} />
          <OpenShifts reqs={reqs} onDone={done} />
          {nothingYet && (
            <div style={{ marginTop: 18, padding: '22px 16px', border: '1px dashed var(--wk-line2)', borderRadius: 12, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              No requests yet. Use New Request to swap or offer a shift, or to ask for time off.
            </div>
          )}
        </>
      )}

      {canManage && (
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>Waiting on a Manager</div>
          <ShiftRequestsInbox inline toastOk={toastOk} toastErr={toastErr} onChanged={() => { reloadReqs(); setTick(t => t + 1); }} />
        </div>
      )}

      {asking && (
        <NewRequestDialog reqs={reqs} myShifts={mine || []} onClose={() => setAsking(false)} onDone={done} />
      )}
    </div>
  );
}
