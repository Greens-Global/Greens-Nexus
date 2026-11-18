import { useEffect, useRef, useState } from 'react';
import { useTimeclock, claimTimeclockSurface, openTimeClock } from '../lib/timeclockStore';
import { usePunchClock } from '../dashboard/essentials/usePunchClock.jsx';
import ClockChip from './ClockChip';

// The sidebar's time clock (Oct 14 2026). One chip, always the same element,
// so a state change animates in place (the dial drains and turns red on a
// punch-out, fills green on a punch-in) instead of one chip fading out and
// another in. While a shift is live it draws the engine's view-model
// (components/TimeclockWidget.jsx publishes it and stops drawing its own
// capsule while this surface claims it). Off the clock, Play is Punch In
// from the Punch tile's hook - that hook's whole clock-in flow (screen
// share, day-message gate, location, pairing) and its modals - mounted only
// then, so a live shift or an exempt person pays no second status poll.
// Nothing for an exempt person.

// The off-the-clock half: owns the Punch tile hook and its modals, hands the
// parent its punch through a ref and its busy flag and note as STATE (hooks
// cannot be conditional, components can). They were refs too until
// 11/17/2026: a ref changes without a render, so Play showed no spinner
// during the location wait and a failed punch showed no note until something
// else redrew the chip.
function OffClock({ handle, onBusy, onNote }) {
  const { busy, note, act, modals } = usePunchClock();
  useEffect(() => { handle.current = { punchIn: async () => { await act('in'); return true; } }; });
  useEffect(() => { onBusy(!!busy); }, [busy, onBusy]);
  useEffect(() => { onNote(note?.ok === false ? note.text : ''); }, [note, onNote]);
  return modals;
}

export default function SidebarClock({ collapsed }) {
  const tc = useTimeclock();
  const live = !!tc && (tc.state === 'in' || tc.state === 'break');
  useEffect(() => (live ? claimTimeclockSurface() : undefined), [live]);
  const off = useRef({ punchIn: null });
  const [offBusy, setOffBusy] = useState(false);
  const [offNote, setOffNote] = useState('');
  if (!tc || tc.state === 'exempt' || tc.state === 'unknown') return null;
  const vm = live ? tc : {
    ...tc,
    note: offNote, lost: false, capture: null,
    busy: offBusy ? 'in' : false,
    actions: { punchIn: () => off.current.punchIn?.(), openClock: openTimeClock },
  };
  return (
    <div className="sidebar-foot">
      <ClockChip vm={vm} variant={collapsed ? 'rail' : 'wide'} />
      {!live && <OffClock handle={off} onBusy={setOffBusy} onNote={setOffNote} />}
    </div>
  );
}
