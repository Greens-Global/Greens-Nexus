import { Coffee, Play, LogOut, MonitorUp, MonitorX, MonitorPause, Clock, AlertTriangle } from 'lucide-react';
import { Spinner } from './AsyncState';

// The time clock as a chip (Neil, Oct 14 2026): the one drawing of a live
// shift, used by the sidebar (wide, or the rail tile when collapsed) and by
// the phone capsule's sheet. It draws only what the engine publishes
// (lib/timeclockStore.js); every action is the engine's own - quickBreak,
// quickPunchOut, startCapture, stopCapture - so nothing the floating capsule
// could do is lost here. Minimal on purpose: state and hours on one line,
// the two punches on the next, and the capture line only when the browser is
// the capturer. Nothing renders when there is no live shift.
//
// vm: { state: 'in' | 'break', timer, sinceLabel, lost, busy, breakBusy,
//       capture: null | { screens, paused, intervalMin, randomize },
//       actions: { toggleBreak, punchOut, toggleCapture, addScreen, openClock } }

export default function ClockChip({ vm, variant = 'wide', onAfterAction }) {
  if (!vm || (vm.state !== 'in' && vm.state !== 'break')) return null;
  const onBreak = vm.state === 'break';
  const { actions: a, capture } = vm;
  const tone = onBreak ? 'break' : 'in';
  const after = (fn) => () => { fn(); onAfterAction?.(); };

  if (variant === 'tile') {
    const label = `${onBreak ? 'On Break' : 'Working'} · ${vm.timer}${capture ? (capture.paused ? ' · capture paused' : capture.screens ? ' · recording' : '') : ''} - open the time clock`;
    return (
      <button type="button" className={`sbclock-tile sbclock-tile--${tone}`} onClick={a.openClock} title={label} aria-label={label}>
        <Clock aria-hidden="true" />
        <span className={`sbclock-dot${onBreak ? '' : ' sbclock-dot--live'}`} aria-hidden="true" />
        {capture && capture.screens > 0 && <span className={`sbclock-tile-cap${capture.paused ? ' is-paused' : ''}`} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <section className={`sbclock sbclock--${tone}${vm.lost ? ' sbclock--lost' : ''}`} aria-label="Time clock">
      <button type="button" className="sbclock-head" onClick={a.openClock} title="Open Time Clock">
        <span className={`sbclock-dot${onBreak ? '' : ' sbclock-dot--live'}`} aria-hidden="true" />
        <span className="sbclock-text">
          <span className="sbclock-state">{onBreak ? 'On Break' : 'Working'}</span>
          {vm.lost
            ? <span className="sbclock-sub sbclock-sub--lost"><AlertTriangle size={10} aria-hidden="true" /> A punch has not recorded - saved on this device</span>
            : <span className="sbclock-sub">{vm.sinceLabel}</span>}
        </span>
        <span className="sbclock-timer">{vm.timer}</span>
      </button>
      <div className="sbclock-row">
        <button type="button" className={`sbclock-btn sbclock-btn--${onBreak ? 'resume' : 'break'}`} onClick={after(a.toggleBreak)} disabled={vm.busy || vm.breakBusy}
          title={onBreak ? 'End your break and get back on the clock' : 'Start a break - your working time pauses'}>
          {vm.breakBusy ? <Spinner size={12} /> : onBreak ? <Play size={12} /> : <Coffee size={12} />}
          {onBreak ? 'End Break' : 'Break'}
        </button>
        <button type="button" className="sbclock-btn sbclock-btn--out" onClick={after(a.punchOut)} disabled={vm.busy} title="Punch out">
          {vm.busy ? <Spinner size={12} /> : <LogOut size={12} />}
          {vm.lost ? 'Retry' : 'Punch Out'}
        </button>
      </div>
      {capture && (
        <div className="sbclock-cap">
          <button type="button" className={`sbclock-cap-btn${capture.paused ? ' is-paused' : capture.screens ? ' is-on' : ''}`} onClick={a.toggleCapture}
            title={capture.paused
              ? 'Screen capture is paused for your break - no frames are saved until you end the break. Click to stop capture entirely.'
              : capture.screens
                ? `Screen capture is on (${capture.screens} screen${capture.screens === 1 ? '' : 's'}) - a frame of each is saved every ${capture.intervalMin} minute${capture.intervalMin === 1 ? '' : 's'}${capture.randomize ? ' (timing varies)' : ''}. Click to stop.`
                : 'Start work-session screen capture (you pick the screen; your browser shows a sharing indicator the whole time)'}>
            {capture.paused ? <MonitorPause size={11} /> : capture.screens ? <MonitorUp size={11} /> : <MonitorX size={11} />}
            {capture.paused ? 'Paused for break' : capture.screens ? `Recording${capture.screens > 1 ? ` · ${capture.screens} screens` : ''}` : 'Capture off'}
          </button>
          {capture.screens > 0 && (
            <button type="button" className="sbclock-cap-add" onClick={a.addScreen} title="Also capture another screen (pick your second monitor)" aria-label="Capture another screen">+</button>
          )}
        </div>
      )}
    </section>
  );
}
