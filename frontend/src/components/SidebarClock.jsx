import { useEffect, useRef, useState } from 'react';
import { useTimeclock, claimTimeclockSurface } from '../lib/timeclockStore';
import { usePunchClock } from '../dashboard/essentials/usePunchClock.jsx';
import ClockChip from './ClockChip';

// The sidebar's time clock (Oct 14 2026). While a shift is live it draws the
// engine's view-model (components/TimeclockWidget.jsx publishes it and stops
// drawing its own capsule while this surface claims it). Off the clock it
// draws the same chip from the Punch tile's hook - Play is Punch In, with
// that hook's whole clock-in flow (screen share, day-message gate, location,
// pairing) and its modals. Nothing for an exempt person. A punch-out holds
// the last live picture for 400ms so the dial drains and the chip settles
// into the off state instead of vanishing.
const navigateClock = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock' } }));

function OffClock({ variant }) {
  const { status, vm, busy, note, act, modals } = usePunchClock();
  if (!status || vm.exempt || status.error) return null;
  if (vm.state !== 'out') return null;   // the engine's picture is on its way
  const off = {
    state: 'out', sinceLabel: note?.text || vm.lastOutLabel, busy: busy ? 'in' : false, lost: false, note: '', capture: null,
    actions: { punchIn: async () => { await act('in'); return true; }, openClock: navigateClock },
  };
  return <><ClockChip vm={off} variant={variant} />{modals}</>;
}

export default function SidebarClock({ collapsed }) {
  const tc = useTimeclock();
  const live = !!tc && (tc.state === 'in' || tc.state === 'break');
  useEffect(() => (live ? claimTimeclockSurface() : undefined), [live]);
  const lastLive = useRef(null);
  useEffect(() => { if (live) lastLive.current = tc; }, [live, tc]);
  const [held, setHeld] = useState(null);
  useEffect(() => {
    if (live) { setHeld(null); return undefined; }
    if (!lastLive.current) return undefined;
    setHeld(lastLive.current);
    const t = setTimeout(() => { setHeld(null); lastLive.current = null; }, 420);
    return () => clearTimeout(t);
  }, [live]);
  const variant = collapsed ? 'rail' : 'wide';
  if (!tc || tc.state === 'exempt' || tc.state === 'unknown') return null;
  return (
    <div className="sidebar-foot">
      {live
        ? <ClockChip vm={tc} variant={variant} />
        : held
          ? <ClockChip vm={held} variant={variant} leaving />
          : <OffClock variant={variant} />}
    </div>
  );
}
