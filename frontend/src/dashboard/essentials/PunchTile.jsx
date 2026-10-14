// The one-tap Punch tile (Oct 11) - the 'action' widget with action 'punch'.
// One button, one punch: whichever the clock accepts next (Punch In, Punch
// Out, or End Break while on a break), with the state and today's hours as
// the caption. Runs the real flow through usePunchClock - the same gates and
// the same durable punch as My Time and the Time Clock screen - so a tap here
// IS a punch, never a hand-off. Loaded lazily from widgets.jsx so boards
// without a punch tile never download the punch stack.
import { useEffect } from 'react';
import { Clock, LogOut, Coffee, Play } from 'lucide-react';
import { ActionFace, navigate } from '../widgets.jsx';
import { usePunchClock, nextPunch, fmtH } from './usePunchClock.jsx';

const ACTION_ICON = { in: Play, out: LogOut, break_start: Coffee, break_end: Play };
// One color per punch, so a glance says which way the clock will go.
const ACTION_COLOR = { in: 'green', out: 'orange', break_start: 'purple', break_end: 'blue' };

export default function PunchTile({ row }) {
  const { status, vm, busy, busyLabel, note, act, modals } = usePunchClock();
  const go = () => navigate('timeclock', 'overview');

  if (vm.exempt) {
    return <ActionFace row={row} Icon={Clock} color="green" label="Time Clock" sub="Time tracking is not required for your role." onClick={go} />;
  }
  if (!status) {
    return <ActionFace row={row} Icon={Clock} color="green" label="Punch Clock" sub="Loading…" disabled />;
  }
  const next = nextPunch(vm);
  if (status.error || !next) {
    return <ActionFace row={row} Icon={Clock} color="green" label="Open Time Clock" sub="Could not load your time right now." tone="bad" onClick={go} />;
  }
  const Icon = ACTION_ICON[next.kind] || Clock;
  // The caption: what the last tap did (or why it did not), else where the
  // day stands - clocked in since when with today's hours, on break since
  // when, or when the last shift ended.
  const sub = note ? note.text
    : vm.state === 'in' ? `Clocked in ${vm.sinceLabel} · ${fmtH(vm.todayMin)} today`
    : vm.state === 'break' ? `On break ${vm.sinceLabel}`
    : vm.lastOutLabel;
  const tone = note ? (note.ok ? 'ok' : 'bad') : vm.state === 'in' ? 'on' : undefined;
  return (
    <>
      <ActionFace row={row} Icon={Icon} color={ACTION_COLOR[next.kind] || 'green'}
        label={busyLabel(next.kind) || next.label} sub={sub} tone={tone}
        subRole={note ? (note.ok ? 'status' : 'alert') : undefined}
        busy={!!busy} onClick={() => act(next.kind)} />
      {modals}
    </>
  );
}

// The punch as one bare icon (Quick Actions, Icons Only - Oct 13): the same
// hook and flow as the tile, with the next punch as the icon and the state as
// the color (green to punch in, orange to punch out, purple for a break,
// blue to end one). There is no caption, so the plain-English note about
// what the tap did goes to the caller (`onNote`) to show where it can, and
// to a live region here so it is read out either way. A disabled icon while
// the status loads, the Time Clock itself for an exempt person or a failed
// status - never nothing.
export function PunchIcon({ className = 'qa-icon', onNote }) {
  const { status, vm, busy, busyLabel, note, act, modals } = usePunchClock();
  useEffect(() => { if (note?.text && onNote) onNote(note.text); }, [note, onNote]);
  const go = () => navigate('timeclock', 'overview');
  const next = status && !vm.exempt && !status.error ? nextPunch(vm) : null;
  const Icon = next ? (ACTION_ICON[next.kind] || Clock) : Clock;
  const color = next ? (ACTION_COLOR[next.kind] || 'green') : 'green';
  const label = !status ? 'Punch Clock' : vm.exempt ? 'Time Clock' : !next ? 'Open Time Clock'
    : (busyLabel(next.kind) || next.label);
  const detail = !status ? 'Loading…' : vm.state === 'in' ? `Clocked in ${vm.sinceLabel} · ${fmtH(vm.todayMin)} today`
    : vm.state === 'break' ? `On break ${vm.sinceLabel}` : vm.lastOutLabel;
  return (
    <>
      <button type="button" className={`${className} dk-chip--${color}${vm.state === 'in' ? ' qa-icon--live' : ''}`}
        title={detail ? `${label} - ${detail}` : label} aria-label={label} aria-busy={busy || undefined}
        disabled={!status} onClick={() => (busy ? undefined : next ? act(next.kind) : go())}>
        <Icon />
      </button>
      <span role="status" className="dk-sr-only">{note?.text || ''}</span>
      {modals}
    </>
  );
}
