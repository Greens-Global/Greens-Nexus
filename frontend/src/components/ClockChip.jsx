import { Coffee, Play, LogOut, Clock, AlertTriangle, MonitorUp, MonitorX, MonitorPause, Plus } from 'lucide-react';
import { Spinner } from './AsyncState';

// The time clock as a chip (Neil, Oct 14 2026): the one drawing of a live
// shift, used by the sidebar (wide, or a column of icons when folded) and by
// the phone capsule's sheet. It draws only what the engine publishes
// (lib/timeclockStore.js); every action is the engine's own - quickBreak,
// quickPunchOut - so nothing the floating capsule could do is lost here.
// Minimal on purpose: state and hours on one line, Break and Punch Out on
// the next, and - only when the browser is the capturer - three quiet icons
// for monitoring (share or stop, add another screen, and the recording
// state), since the screen share is required at clock-in and at the end
// of a break and those two controls "cannot be gone" (Neil, Oct 14 2026).
// Nothing renders without a live shift.
//
// vm: { state: 'in' | 'break', timer, sinceLabel, lost, note, busy, breakBusy,
//       capture: null | { screens, paused, needed },
//       actions: { toggleBreak, punchOut, openClock, startCapture, stopCapture } }

export default function ClockChip({ vm, variant = 'wide', onAfterAction }) {
  if (!vm || (vm.state !== 'in' && vm.state !== 'break')) return null;
  const onBreak = vm.state === 'break';
  const { actions: a, capture } = vm;
  const tone = onBreak ? 'break' : 'in';
  // A sheet (the phone capsule) closes only once the action has resolved and
  // was not blocked - a declined screen share leaves the sheet open with the
  // engine's note in it.
  const after = (fn) => async () => { const ok = await fn(); if (ok !== false) onAfterAction?.(); };
  const breakTitle = onBreak ? 'End your break and get back on the clock' : 'Start a break - your working time pauses';
  const outTitle = vm.lost ? 'Retry the punch that has not recorded' : 'Punch out';

  if (variant === 'rail') {
    // A parked punch, a declined share or a dropped share must never hide
    // inside the rail: the state tile goes red with a warning icon and its
    // label says why (the wide chip spells it out; here the title does).
    const alert = vm.lost ? 'a punch has not recorded, retry below' : vm.note || '';
    const label = `${onBreak ? 'On Break' : 'Working'} · ${vm.timer}${alert ? ` · ${alert}` : ''} - open the time clock`;
    return (
      <div className={`sbclock-rail sbclock-rail--${tone}`} role="group" aria-label="Time clock">
        {alert && <span role="status" className="dk-sr-only">{alert}</span>}
        <button type="button" className={`sbclock-tile sbclock-tile--${tone}${alert ? ' sbclock-tile--lost' : ''}`} onClick={a.openClock} title={label} aria-label={label}>
          {alert ? <AlertTriangle aria-hidden="true" /> : <Clock aria-hidden="true" />}
          <span className={`sbclock-dot${onBreak ? '' : ' sbclock-dot--live'}`} aria-hidden="true" />
        </button>
        <button type="button" className={`sbclock-ico sbclock-ico--${onBreak ? 'resume' : 'break'}`} onClick={after(a.toggleBreak)} disabled={vm.busy || vm.breakBusy}
          title={breakTitle} aria-label={onBreak ? 'End Break' : 'Break'}>
          {vm.breakBusy ? <Spinner size={13} /> : onBreak ? <Play /> : <Coffee />}
        </button>
        <button type="button" className="sbclock-ico sbclock-ico--out" onClick={after(a.punchOut)} disabled={vm.busy}
          title={outTitle} aria-label={vm.lost ? 'Retry Punch Out' : 'Punch Out'}>
          {vm.busy ? <Spinner size={13} /> : <LogOut />}
        </button>
      </div>
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
            : vm.note
              ? <span className="sbclock-sub sbclock-sub--note" role="status">{vm.note}</span>
              : <span className="sbclock-sub">{vm.sinceLabel}</span>}
        </span>
        <span className="sbclock-timer">{vm.timer}</span>
      </button>
      <div className="sbclock-row">
        <button type="button" className={`sbclock-btn sbclock-btn--${onBreak ? 'resume' : 'break'}`} onClick={after(a.toggleBreak)} disabled={vm.busy || vm.breakBusy} title={breakTitle}>
          {vm.breakBusy ? <Spinner size={12} /> : onBreak ? <Play size={12} /> : <Coffee size={12} />}
          {onBreak ? 'End Break' : 'Break'}
        </button>
        <button type="button" className="sbclock-btn sbclock-btn--out" onClick={after(a.punchOut)} disabled={vm.busy} title={outTitle}>
          {vm.busy ? <Spinner size={12} /> : <LogOut size={12} />}
          {vm.lost ? 'Retry' : 'Punch Out'}
        </button>
      </div>
      {capture && (
        <div className="sbclock-mon" role="group" aria-label="Screen capture">
          <button type="button" className={`sbclock-mon-ico${capture.paused ? ' is-paused' : capture.screens ? ' is-on' : capture.needed ? ' is-needed' : ''}`}
            onClick={capture.screens ? a.stopCapture : a.startCapture}
            aria-label={capture.paused ? 'Capture paused for your break - stop capture' : capture.screens ? 'Recording - stop capture' : capture.needed ? 'Screen sharing stopped - share your screen again' : 'Share your screen'}
            title={capture.paused ? 'Screen capture is paused for your break - no frames are saved until you end it. Click to stop capture entirely.'
              : capture.screens ? `Recording ${capture.screens} screen${capture.screens === 1 ? '' : 's'} - click to stop capture`
              : capture.needed ? 'Screen sharing stopped - share your screen again to keep capturing'
              : 'Share your screen to start capture (your browser shows a sharing indicator the whole time)'}>
            {capture.paused ? <MonitorPause /> : capture.screens ? <MonitorUp /> : <MonitorX />}
          </button>
          {capture.screens > 0 && <span className="sbclock-mon-n" aria-hidden="true">{capture.screens}</span>}
          {capture.screens > 0 && (
            <button type="button" className="sbclock-mon-ico" onClick={a.startCapture} aria-label="Capture another screen" title="Also capture another screen - pick your second monitor"><Plus /></button>
          )}
        </div>
      )}
    </section>
  );
}
