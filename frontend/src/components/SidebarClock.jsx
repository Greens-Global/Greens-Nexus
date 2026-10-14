import { useEffect } from 'react';
import { useTimeclock, claimTimeclockSurface } from '../lib/timeclockStore';
import { usePunchClock } from '../dashboard/essentials/usePunchClock.jsx';
import ClockChip from './ClockChip';

// The sidebar's time clock (Oct 14 2026). One chip, always the same element,
// so a state change animates in place (the dial drains and turns red on a
// punch-out, fills green on a punch-in) instead of one chip fading out and
// another in. While a shift is live it draws the engine's view-model
// (components/TimeclockWidget.jsx publishes it and stops drawing its own
// capsule while this surface claims it). Off the clock it draws the engine's
// off picture with Play as Punch In from the Punch tile's hook - that hook's
// whole clock-in flow (screen share, day-message gate, location, pairing)
// and its modals. Nothing for an exempt person.
const navigateClock = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock' } }));

export default function SidebarClock({ collapsed }) {
  const tc = useTimeclock();
  const live = !!tc && (tc.state === 'in' || tc.state === 'break');
  useEffect(() => (live ? claimTimeclockSurface() : undefined), [live]);
  const { busy, note, act, modals } = usePunchClock();
  if (!tc || tc.state === 'exempt' || tc.state === 'unknown') return null;
  const vm = live ? tc : {
    ...tc,
    sinceLabel: note?.text || tc.sinceLabel,
    busy: busy ? 'in' : false, lost: false, note: '', capture: null,
    actions: { punchIn: async () => { await act('in'); return true; }, openClock: navigateClock },
  };
  return (
    <div className="sidebar-foot">
      <ClockChip vm={vm} variant={collapsed ? 'rail' : 'wide'} />
      {!live && modals}
    </div>
  );
}
