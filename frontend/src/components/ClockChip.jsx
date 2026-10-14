import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, Coffee, MonitorUp, MonitorX, MonitorPause, Plus } from 'lucide-react';
import { Spinner } from './AsyncState';

// The time clock as one object (Neil, Oct 14 2026): a dial that fills with
// today's hours toward 8, a status light in its center, wearing the color
// of where you are - green clocked in, amber on a break, red off the clock
// - and a transport control under it: Play, Pause, Stop, always all three.
// The lit one is where you are; it is outlined, and the outline slides to
// the next when the state changes. Play is Punch In when off the clock and
// Resume on a break; Pause starts a break; Stop punches out. Each button
// wears the color of where it takes you. Pausing lifts a coffee cup out of
// the button for a moment; resuming runs a sweep around the dial. Used by
// the sidebar (wide, or a column when folded) and the phone sheet. It draws
// only what it is handed (the engine's view-model, lib/timeclockStore.js,
// or the sidebar's off-the-clock one); every action is the engine's own.
//
// vm: { state: 'in' | 'break' | 'out', timer, todayMin, sinceLabel, lost, note, busy, breakBusy,
//       capture: null | { screens, paused, needed, intervalMin, randomize },
//       actions: { punchIn?, toggleBreak?, punchOut?, openClock, startCapture?, stopCapture? } }

const DAY_MIN = 8 * 60;
const TICKS = 8;

// The dial: a track with an hour tick at each eighth, an arc `pct` of the
// way round, and the light in the middle - all in the state's color.
export function ClockRing({ pct, tone, size = 40, stroke = 3.5, alert = false, sweep = false }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const a = (i / TICKS) * 2 * Math.PI - Math.PI / 2;
    const r1 = r - stroke * 0.95, r2 = r + stroke * 0.95;
    return <line key={i} className="sbring-tick" x1={cx + Math.cos(a) * r1} y1={cx + Math.sin(a) * r1} x2={cx + Math.cos(a) * r2} y2={cx + Math.sin(a) * r2} />;
  });
  return (
    <span className={`sbring sbring--${tone}${sweep ? ' sbring--sweep' : ''}`} style={{ width: size, height: size, '--sb-c': c }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="sbring-track" cx={cx} cy={cx} r={r} fill="none" strokeWidth={stroke} />
        <circle className="sbring-arc" cx={cx} cy={cx} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform={`rotate(-90 ${cx} ${cx})`} />
        {sweep && <circle className="sbring-sweep" cx={cx} cy={cx} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} transform={`rotate(-90 ${cx} ${cx})`} />}
        <g className="sbring-ticks" strokeWidth={1.2}>{ticks}</g>
        <circle className="sbring-core" cx={cx} cy={cx} r={size * 0.17} />
      </svg>
      {alert && <span className="sbring-alert" />}
    </span>
  );
}

function captureTitle(capture) {
  if (capture.paused) return 'Screen capture is paused for your break - no frames are saved until you end it. Click to stop capture entirely.';
  if (capture.screens) {
    const every = capture.intervalMin || 5;
    return `Recording ${capture.screens} screen${capture.screens === 1 ? '' : 's'} - a frame of each is saved every ${every} minute${every === 1 ? '' : 's'}${capture.randomize ? ' (timing varies)' : ''}. Click to stop capture.`;
  }
  if (capture.needed) return 'Screen sharing stopped - share your screen again to keep capturing';
  return 'Share your screen to start capture (your browser shows a sharing indicator the whole time)';
}

// Our own tooltip: a dark pill that rises in, a bold line and a quiet one.
function Tip({ title, sub, edge = '', children }) {
  return (
    <span className={`sbtt${edge ? ` sbtt--${edge}` : ''}`}>
      {children}
      <span className="sbtt-pop" role="tooltip"><b>{title}</b>{sub && <i>{sub}</i>}</span>
    </span>
  );
}

export default function ClockChip({ vm, variant = 'wide', onAfterAction, leaving = false }) {
  const state = vm?.state;
  const live = state === 'in' || state === 'break';
  // The flourish for a state change: a coffee cup rises out of Pause when a
  // break starts, a sweep runs round the dial when it ends. Keyed on the
  // transition, not the state, so a page that opens on a break shows nothing.
  const prev = useRef(state);
  const [flourish, setFlourish] = useState('');
  useEffect(() => {
    const from = prev.current; prev.current = state;
    if (from === 'in' && state === 'break') setFlourish('coffee');
    else if (from === 'break' && state === 'in') setFlourish('sweep');
    else if (from === 'out' && state === 'in') setFlourish('sweep');
    else return undefined;
    const t = setTimeout(() => setFlourish(''), 800);
    return () => clearTimeout(t);
  }, [state]);
  if (!vm || (state !== 'in' && state !== 'break' && state !== 'out')) return null;

  const { actions: a, capture } = vm;
  const onBreak = state === 'break', off = state === 'out';
  const tone = off ? 'out' : onBreak ? 'break' : 'in';
  const pct = leaving || off ? 0 : (vm.todayMin || 0) / DAY_MIN;
  // A sheet (the phone capsule) closes only once the action has resolved and
  // was not blocked - a declined screen share leaves the sheet open with the
  // engine's note in it.
  const after = (fn) => async () => { const ok = await fn(); if (ok !== false) onAfterAction?.(); };
  const alert = vm.note || (vm.lost ? 'A punch has not recorded - saved on this device, retry below' : capture?.needed ? 'Screen sharing stopped - share your screen again' : '');
  const stateLabel = off ? 'Clocked Out' : onBreak ? 'On Break' : 'Clocked In';
  const lit = off ? 0 : onBreak ? 1 : 0;   // which of Play / Pause / Stop is where you are
  const busyAny = !!(vm.busy || vm.breakBusy);

  // Play: Punch In when off the clock, Resume on a break, the lit (inert)
  // state while clocked in. Pause: Start Break, or the lit state on a break.
  // Stop: Punch Out (Retry with a parked punch); off the clock it is dim.
  const play = off
    ? { label: 'Punch In', sub: 'Start your shift', onClick: a.punchIn && after(a.punchIn), lit: true }
    : onBreak
      ? { label: 'Resume', sub: 'Back on the clock', onClick: after(a.toggleBreak), lit: false, next: true }
      : { label: 'Clocked In', sub: 'You are on the clock', onClick: null, lit: true };
  const pause = off
    ? { label: 'Start Break', sub: 'Punch in first', onClick: null, dim: true }
    : onBreak
      ? { label: 'On Break', sub: 'Press Play to resume', onClick: null, lit: true }
      : { label: 'Start Break', sub: 'Your working time pauses', onClick: after(a.toggleBreak), lit: false };
  const stop = off
    ? { label: 'Punch Out', sub: 'You are off the clock', onClick: null, dim: true }
    : { label: vm.lost ? 'Retry Punch Out' : 'Punch Out', sub: vm.lost ? 'The last punch has not recorded' : 'Ends your shift', onClick: after(a.punchOut), lit: false };

  const vertical = variant === 'rail';
  const transport = (
    <div className={`sbtr sbtr--${tone}`} role="group" aria-label="Punch">
      <span className="sbtr-lit" style={{ transform: vertical ? `translateY(${lit * 100}%)` : `translateX(${lit * 100}%)` }} aria-hidden="true" />
      <Tip title={play.label} sub={play.sub} edge={vertical ? '' : 'start'}>
        <button type="button" className={`sbtr-btn sbtr-btn--play${play.lit ? ' is-lit' : ''}${play.next ? ' is-next' : ''}${!play.onClick ? ' is-inert' : ''}`}
          onClick={play.onClick || undefined} disabled={busyAny} aria-disabled={!play.onClick || undefined} aria-pressed={play.lit && !off ? true : undefined} aria-label={play.label}>
          {vm.busy === 'in' ? <Spinner size={12} /> : <Play />}
        </button>
      </Tip>
      <Tip title={pause.label} sub={pause.sub}>
        <button type="button" className={`sbtr-btn sbtr-btn--pause${pause.lit ? ' is-lit' : ''}${pause.dim ? ' is-dim' : ''}${!pause.onClick ? ' is-inert' : ''}`}
          onClick={pause.onClick || undefined} disabled={busyAny} aria-disabled={!pause.onClick || undefined} aria-pressed={pause.lit ? true : undefined} aria-label={pause.label}>
          {vm.breakBusy ? <Spinner size={12} /> : <Pause />}
          {flourish === 'coffee' && (
            <span className="sbtr-coffee" aria-hidden="true"><Coffee /><i /><i /></span>
          )}
        </button>
      </Tip>
      <Tip title={stop.label} sub={stop.sub} edge={vertical ? '' : 'end'}>
        <button type="button" className={`sbtr-btn sbtr-btn--stop${stop.dim ? ' is-dim' : ''}${!stop.onClick ? ' is-inert' : ''}`}
          onClick={stop.onClick || undefined} disabled={busyAny} aria-disabled={!stop.onClick || undefined} aria-label={stop.label}>
          {vm.busy === true || vm.busy === 'out' ? <Spinner size={12} /> : <Square />}
        </button>
      </Tip>
    </div>
  );

  if (variant === 'rail') {
    const ringLabel = `${stateLabel}${live ? ` · ${vm.timer}` : ''}${alert ? ` · ${alert}` : ''} - ${capture?.needed ? 'share your screen again' : 'open the time clock'}`;
    return (
      <div className={`sbclock-rail sbclock-rail--${tone}${leaving ? ' is-leaving' : ''}`} role="group" aria-label="Time clock">
        {alert && <span role="status" className="dk-sr-only">{alert}</span>}
        <Tip title={stateLabel} sub={live ? `${vm.timer} today · ${vm.sinceLabel}` : vm.sinceLabel}>
          <button type="button" className="sbclock-ringbtn" onClick={capture?.needed ? a.startCapture : a.openClock} aria-label={ringLabel}>
            <ClockRing pct={pct} tone={tone} alert={!!alert} sweep={flourish === 'sweep'} />
          </button>
        </Tip>
        {transport}
      </div>
    );
  }

  return (
    <section className={`sbclock sbclock--${tone}${leaving ? ' is-leaving' : ''}`} aria-label="Time clock">
      <button type="button" className="sbclock-head" onClick={capture?.needed ? a.startCapture : a.openClock} title={capture?.needed ? 'Share your screen again' : 'Open Time Clock'}>
        <ClockRing pct={pct} tone={tone} alert={!!alert} sweep={flourish === 'sweep'} size={38} />
        <span className="sbclock-text">
          <span className="sbclock-line">
            <span className="sbclock-state">{stateLabel}</span>
            {live && <span className="sbclock-timer" key={vm.timer}>{vm.timer}</span>}
          </span>
          <span className="sbclock-sub">{vm.sinceLabel}</span>
        </span>
      </button>
      {alert && (
        capture?.needed && !vm.note && !vm.lost
          ? <button type="button" className="sbclock-alert sbclock-alert--btn" role="status" onClick={a.startCapture} title="Share your screen again to keep capturing">{alert}</button>
          : <span className="sbclock-alert" role="status">{alert}</span>
      )}
      {transport}
      {capture && live && (
        <div className={`sbclock-monwrap${capture.needed ? ' is-needed' : ''}`}>
        <div className="sbclock-mon" role="group" aria-label="Screen capture">
          <button type="button" className={`sbclock-mon-ico${capture.paused ? ' is-paused' : capture.screens ? ' is-on' : capture.needed ? ' is-needed' : ''}`}
            onClick={capture.screens ? a.stopCapture : a.startCapture} title={captureTitle(capture)}
            aria-label={capture.paused ? 'Capture paused for your break - stop capture' : capture.screens ? 'Recording - stop capture' : capture.needed ? 'Screen sharing stopped - share your screen again' : 'Share your screen'}>
            {capture.paused ? <MonitorPause /> : capture.screens ? <MonitorUp /> : <MonitorX />}
          </button>
          {capture.screens > 0 && <span className="sbclock-mon-n" aria-hidden="true">{capture.screens}</span>}
          {capture.screens > 0 && (
            <button type="button" className="sbclock-mon-ico" onClick={a.startCapture} aria-label="Capture another screen" title="Also capture another screen - pick your second monitor"><Plus /></button>
          )}
        </div>
        </div>
      )}
    </section>
  );
}
