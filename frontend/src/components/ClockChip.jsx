import { Pause, Play, Square, MonitorUp, MonitorX, MonitorPause, Plus } from 'lucide-react';
import { Spinner } from './AsyncState';

// The time clock as one object (Neil, Oct 14 2026): a ring that fills with
// today's hours toward 8, wearing the color of where you are - green clocked
// in, amber on a break - and the media triad under it: Pause for a break,
// Play to resume, Stop to punch out, each button wearing the color of where
// it takes you. Used by the sidebar (wide, or a column of circles when
// folded) and by the phone capsule's sheet. It draws only what the engine
// publishes (lib/timeclockStore.js); every action is the engine's own, so
// nothing the floating capsule could do is lost here. Monitoring, when the
// browser is the capturer, is three quiet icons that show on hover (always
// on touch, and always when a required share has dropped). Nothing renders
// without a live shift.
//
// vm: { state: 'in' | 'break', timer, todayMin, sinceLabel, lost, note, busy, breakBusy,
//       capture: null | { screens, paused, needed, intervalMin, randomize },
//       actions: { toggleBreak, punchOut, openClock, startCapture, stopCapture } }

const DAY_MIN = 8 * 60;

// The ring: a track and an arc, `pct` of the way round, in the state's
// color. The arc sweeps to its value on mount and whenever it moves; a
// badge dot carries an alert (parked punch, declined share, dropped share).
export function ClockRing({ pct, tone, size = 40, stroke = 3.5, alert = false }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  return (
    <span className={`sbring sbring--${tone}`} style={{ width: size, height: size, '--sb-c': c }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="sbring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle className="sbring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <circle className="sbring-core" cx={size / 2} cy={size / 2} r={Math.max(2.5, size * 0.11)} />
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

export default function ClockChip({ vm, variant = 'wide', onAfterAction, leaving = false }) {
  if (!vm || (vm.state !== 'in' && vm.state !== 'break')) return null;
  const onBreak = vm.state === 'break';
  const { actions: a, capture } = vm;
  const tone = onBreak ? 'break' : 'in';
  const pct = leaving ? 0 : (vm.todayMin || 0) / DAY_MIN;
  // A sheet (the phone capsule) closes only once the action has resolved and
  // was not blocked - a declined screen share leaves the sheet open with the
  // engine's note in it.
  const after = (fn) => async () => { const ok = await fn(); if (ok !== false) onAfterAction?.(); };
  const alert = vm.note || (vm.lost ? 'A punch has not recorded - saved on this device, retry below' : capture?.needed ? 'Screen sharing stopped - share your screen again' : '');
  const stateLabel = onBreak ? 'On Break' : 'Clocked In';
  const breakTitle = onBreak ? 'Resume - end your break and get back on the clock' : 'Break - your working time pauses';
  const outTitle = vm.lost ? 'Retry the punch that has not recorded' : 'Punch out';

  if (variant === 'rail') {
    // A column of circles: the ring (opens the Time Clock - or re-opens the
    // share picker when a required share has dropped), then Pause / Play,
    // then Stop. An alert rides the ring as a red dot and its label.
    const ringLabel = `${stateLabel} · ${vm.timer}${alert ? ` · ${alert}` : ''} - ${capture?.needed ? 'share your screen again' : 'open the time clock'}`;
    return (
      <div className={`sbclock-rail sbclock-rail--${tone}${leaving ? ' is-leaving' : ''}`} role="group" aria-label="Time clock">
        {alert && <span role="status" className="dk-sr-only">{alert}</span>}
        <button type="button" className="sbclock-ringbtn" onClick={capture?.needed ? a.startCapture : a.openClock} title={ringLabel} aria-label={ringLabel}>
          <ClockRing pct={pct} tone={tone} alert={!!alert} />
        </button>
        <button type="button" className={`sbclock-circle sbclock-circle--${onBreak ? 'resume' : 'break'}`} onClick={after(a.toggleBreak)} disabled={vm.busy || vm.breakBusy}
          title={breakTitle} aria-label={onBreak ? 'Resume' : 'Break'}>
          {vm.breakBusy ? <Spinner size={13} /> : onBreak ? <Play /> : <Pause />}
        </button>
        <button type="button" className="sbclock-circle sbclock-circle--out" onClick={after(a.punchOut)} disabled={vm.busy}
          title={outTitle} aria-label={vm.lost ? 'Retry Punch Out' : 'Punch Out'}>
          {vm.busy ? <Spinner size={13} /> : <Square />}
        </button>
      </div>
    );
  }

  return (
    <section className={`sbclock sbclock--${tone}${leaving ? ' is-leaving' : ''}`} aria-label="Time clock">
      <button type="button" className="sbclock-head" onClick={a.openClock} title="Open Time Clock">
        <ClockRing pct={pct} tone={tone} alert={!!alert} />
        <span className="sbclock-text">
          <span className="sbclock-state">{stateLabel}</span>
          <span className="sbclock-sub">{vm.sinceLabel}</span>
        </span>
        <span className="sbclock-timer" key={vm.timer}>{vm.timer}</span>
      </button>
      {/* An alert is its own full-width line (a parked punch, a declined or
          dropped share); a dropped share's line is the way to share again. */}
      {alert && (
        capture?.needed && !vm.note && !vm.lost
          ? <button type="button" className="sbclock-alert sbclock-alert--btn" role="status" onClick={a.startCapture} title="Share your screen again to keep capturing">{alert}</button>
          : <span className="sbclock-alert" role="status">{alert}</span>
      )}
      <div className="sbclock-row">
        <button type="button" className={`sbclock-btn sbclock-btn--${onBreak ? 'resume' : 'break'}`} onClick={after(a.toggleBreak)} disabled={vm.busy || vm.breakBusy} title={breakTitle}>
          {vm.breakBusy ? <Spinner size={12} /> : onBreak ? <Play size={12} /> : <Pause size={12} />}
          {onBreak ? 'Resume' : 'Break'}
        </button>
        <button type="button" className="sbclock-btn sbclock-btn--out" onClick={after(a.punchOut)} disabled={vm.busy} title={outTitle}>
          {vm.busy ? <Spinner size={12} /> : <Square size={12} />}
          {vm.lost ? 'Retry' : 'Punch Out'}
        </button>
      </div>
      {capture && (
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
