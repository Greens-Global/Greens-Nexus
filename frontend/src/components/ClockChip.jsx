import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { planFor, playPlan, starSpec, FLOURISH_MS } from '../lib/flourishMotion';
import { Play, Pause, Square, MonitorUp, MonitorX, MonitorPause, Plus } from 'lucide-react';
import { Spinner } from './AsyncState';
import NavTip from './NavTip';

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

// The dial: a track with an hour tick at each eighth, an arc `pct` of the
// way round, and the light in the middle - all in the state's color.
// `ticks` = one per hour of the target, so a 4-hour shift reads as four.
export function ClockRing({ pct, tone, size = 40, stroke = 3.5, alert = false, sweep = false, ticks: tickCount = 8 }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  const TICKS = Math.max(2, Math.min(12, Math.round(tickCount)));
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

// The sidebar's tooltip (components/NavTip.jsx): the control's name, large,
// in a layer on the page - so the folded rail, which clips anything that
// leaves it, shows the same tooltip as the open sidebar. `detail` is only for
// a button that cannot be pressed right now (why not) and the status ring
// (its numbers). The span keeps each button's slot in the transport grid.
function Tip({ label, detail, tone, side, children }) {
  return <span className="sbtt"><NavTip label={label} detail={detail} tone={tone} side={side}>{children}</NavTip></span>;
}

// The flourish for a punch the server accepted (Neil, Oct 14 2026). It is
// drawn in a layer on the page, pinned over the button it came from, so it
// can travel RIGHT - clear of the tooltip that opens above the button, and
// past the folded rail's clipped edge:
//   coffee - Start Break: the cup pops, drifts right with a wobble, steam
//            curling up off it the whole way
//   check  - End Break: a check draws itself in green, then the same drift
//   in     - Punch In: green and gold stars burst up and to the right
//   out    - Punch Out: gold stars fan right and settle down, the day done
const STAR = 'M12 2.5l2.7 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.3 20l1.4-6.4L2.8 9.2l6.5-.7z';
const STEAM = ['M3 15c-2-3 2-5 0-8s2-5 0-7', 'M3 15c2-3-2-5 0-8s-2-5 0-7', 'M3 15c-1.5-3 1.5-5 0-8s1.5-5 0-7'];
export function Flourish({ kind, anchor: a }) {
  const box = useRef(null);
  // Pinned to the button's centre on the screen (written straight to the
  // node, no render), then the motion plan runs (lib/flourishMotion.js).
  useLayoutEffect(() => {
    const el = box.current, at = a?.current;
    if (!el || !at) return undefined;
    const r = at.getBoundingClientRect();
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = `${r.top + r.height / 2}px`;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reduce ? undefined : playPlan(el, planFor(kind));
  }, [a, kind]);
  return createPortal(
    <div ref={box} className={`sbfx sbfx--${kind}`} aria-hidden="true" data-flourish={kind}>
      {kind === 'coffee' && (
        <span className="sbfx-coffee" data-fx="body">
          <span className="sbfx-steam">
            {STEAM.map((d, i) => (
              <svg key={i} data-fx={`w${i}`} viewBox="0 0 6 16" style={{ left: 3 + i * 5 }}><path d={d} pathLength="1" /></svg>
            ))}
          </span>
          {/* Drawn here, not the Coffee icon: that icon carries three fixed
              steam ticks of its own, which sat under the moving steam. */}
          <svg className="sbfx-mug" viewBox="0 0 24 24">
            <path className="sbfx-mug-body" d="M4.5 8.5h12v5.2a5.3 5.3 0 0 1-5.3 5.3h-1.4a5.3 5.3 0 0 1-5.3-5.3z" />
            <path className="sbfx-mug-coffee" d="M5.6 10.4h9.8" />
            <path d="M16.5 10h1.3a2.6 2.6 0 0 1 0 5.2h-1.6" />
            <path d="M3 21.2h15" />
          </svg>
        </span>
      )}
      {kind === 'check' && (
        <>
          <span className="sbfx-pulse" data-fx="pulse" />
          <span className="sbfx-check" data-fx="body">
            <svg viewBox="0 0 24 24"><circle className="sbfx-disc" cx="12" cy="12" r="10.5" /><circle data-fx="ring" cx="12" cy="12" r="10.5" pathLength="1" /><path data-fx="tick" d="M7 12.5l3.3 3.3L17.2 8.8" pathLength="1" /></svg>
          </span>
        </>
      )}
      {(kind === 'in' || kind === 'out') && (
        <>
          <span className="sbfx-pulse" data-fx="pulse" />
          {starSpec(kind).map(([, , size], i) => (
            <svg key={i} data-fx={`s${i}`} className="sbfx-star" viewBox="0 0 24 24"
              style={{ width: size, height: size, left: -size / 2, top: -size / 2 }}>
              <path d={STAR} />
            </svg>
          ))}
        </>
      )}
    </div>,
    document.body,
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
  const playRef = useRef(null), pauseRef = useRef(null), stopRef = useRef(null);
  useEffect(() => {
    const from = prev.current; prev.current = state;
    const kind = from === 'in' && state === 'break' ? 'coffee'
      : from === 'break' && state === 'in' ? 'check'
        : from === 'out' && state === 'in' ? 'in'
          : (from === 'in' || from === 'break') && state === 'out' ? 'out' : '';
    if (!kind) return undefined;
    setFlourish(kind);
    // Cleared after its longest track (the steam's second puff, for the cup).
    const t = setTimeout(() => setFlourish(''), FLOURISH_MS[kind] + (kind === 'coffee' ? 300 : 150));
    return () => clearTimeout(t);
  }, [state]);
  // The dial still sweeps on a return to work (Resume or Punch In).
  const sweep = flourish === 'check' || flourish === 'in';
  const fxAnchor = flourish === 'coffee' ? pauseRef : flourish === 'out' ? stopRef : playRef;
  if (!vm || (state !== 'in' && state !== 'break' && state !== 'out')) return null;

  const { actions: a, capture } = vm;
  const onBreak = state === 'break', off = state === 'out';
  const tone = off ? 'out' : onBreak ? 'break' : 'in';
  const targetMin = vm.targetMin || DAY_MIN;
  const pct = leaving || off ? 0 : (vm.todayMin || 0) / targetMin;
  const tickCount = Math.round(targetMin / 60);
  // A sheet (the phone capsule) closes only once the action has resolved and
  // was not blocked - a declined screen share leaves the sheet open with the
  // engine's note in it.
  const after = (fn) => async () => { const ok = await fn(); if (ok !== false) onAfterAction?.(); };
  const alert = vm.note || (vm.lost ? 'A punch has not recorded - saved on this device, retry below'
    : capture?.needed ? 'Screen sharing stopped - share your screen again'
    : capture?.missing ? 'Second screen not shared - share it too' : '');
  const shareAlert = !!capture && (capture.needed || capture.missing) && !vm.note && !vm.lost;
  const stateLabel = off ? 'Clocked Out' : onBreak ? 'On Break' : 'Clocked In';
  const lit = off ? 0 : onBreak ? 1 : 0;
  const vertical = variant === 'rail';   // which of Play / Pause / Stop is where you are
  const busyAny = !!(vm.busy || vm.breakBusy);

  // Play: Punch In when off the clock, End Break on a break, the lit (inert)
  // state while clocked in. Pause: Start Break, or the lit state on a break.
  // Stop: Punch Out (Retry with a parked punch); off the clock it is dim.
  // A button you can press is named by what it does, one line, nothing more
  // (Neil, Oct 14 2026: the Punch In tip "should just say Punch In"); one you
  // cannot press right now says why underneath (`sub`). "End Break" rather
  // than "Resume": it says which thing ends.
  const play = off
    ? { label: 'Punch In', onClick: a.punchIn && after(a.punchIn), lit: true, tone: 'in' }
    : onBreak
      ? { label: 'End Break', onClick: after(a.toggleBreak), lit: false, next: true, tone: 'in' }
      : { label: 'Clocked In', sub: 'You are on the clock', onClick: null, lit: true };
  const pause = off
    ? { label: 'Start Break', sub: 'Punch in first', onClick: null, dim: true }
    : onBreak
      ? { label: 'On Break', sub: 'Press End Break to get back to work', onClick: null, lit: true }
      : { label: 'Start Break', onClick: after(a.toggleBreak), lit: false, tone: 'break' };
  const stop = off
    ? { label: 'Punch Out', sub: 'You are not punched in', onClick: null, dim: true }
    : { label: vm.lost ? 'Retry Punch Out' : 'Punch Out', sub: vm.lost ? 'The last punch has not recorded' : undefined, onClick: after(a.punchOut), lit: false, tone: 'out' };
  const side = vertical ? 'right' : 'top';

  const transport = (
    <div className={`sbtr sbtr--${tone}`} role="group" aria-label="Punch">
      {/* --sb-lit: which slot it sits on; the stylesheet moves it by a slot
          AND the gap between slots (sliding by its own width alone left it
          a gap short of Pause: Neil, Oct 14 2026). The outline is ONE element
          so the move is a transition - a re-keyed one mounted in place and
          never slid; only the landing pop inside it is re-keyed. */}
      <span className="sbtr-lit" style={{ '--sb-lit': lit }} aria-hidden="true"><i className="sbtr-land" key={`${tone}-${lit}`} /></span>
      <Tip label={play.label} detail={play.sub} tone={play.tone} side={side}>
        <button ref={playRef} type="button" className={`sbtr-btn sbtr-btn--play${play.lit ? ' is-lit' : ''}${play.next ? ' is-next' : ''}${!play.onClick ? ' is-inert' : ''}`}
          onClick={play.onClick || undefined} disabled={busyAny} aria-disabled={!play.onClick || undefined} aria-pressed={play.lit && !off ? true : undefined} aria-label={play.label}>
          {vm.busy === 'in' ? <Spinner size={12} /> : <Play />}
        </button>
      </Tip>
      <Tip label={pause.label} detail={pause.sub} tone={pause.tone} side={side}>
        <button ref={pauseRef} type="button" className={`sbtr-btn sbtr-btn--pause${pause.lit ? ' is-lit' : ''}${pause.dim ? ' is-dim' : ''}${!pause.onClick ? ' is-inert' : ''}`}
          onClick={pause.onClick || undefined} disabled={busyAny} aria-disabled={!pause.onClick || undefined} aria-pressed={pause.lit ? true : undefined} aria-label={pause.label}>
          {vm.breakBusy ? <Spinner size={12} /> : <Pause />}
        </button>
      </Tip>
      <Tip label={stop.label} detail={stop.sub} tone={stop.tone} side={side}>
        <button ref={stopRef} type="button" className={`sbtr-btn sbtr-btn--stop${stop.dim ? ' is-dim' : ''}${!stop.onClick ? ' is-inert' : ''}`}
          onClick={stop.onClick || undefined} disabled={busyAny} aria-disabled={!stop.onClick || undefined} aria-label={stop.label}>
          {vm.busy === true || vm.busy === 'out' ? <Spinner size={12} /> : <Square />}
        </button>
      </Tip>
      {flourish && flourish !== 'sweep' && <Flourish key={flourish} kind={flourish} anchor={fxAnchor} />}
    </div>
  );

  if (variant === 'rail') {
    const ringLabel = `${stateLabel}${live ? ` · ${vm.timer}` : ''}${alert ? ` · ${alert}` : ''} - open the time clock`;
    return (
      <div className={`sbclock-rail sbclock-rail--${tone}${leaving ? ' is-leaving' : ''}`} role="group" aria-label="Time clock">
        {alert && <span role="status" className="dk-sr-only">{alert}</span>}
        <Tip label={stateLabel} tone={tone} side="right" detail={`${live ? `${vm.timer} today · ` : ''}${vm.sinceLabel}${alert ? ` · ${alert}` : ''}`}>
          <button type="button" className="sbclock-ringbtn" onClick={a.openClock} aria-label={ringLabel}>
            <ClockRing pct={pct} tone={tone} alert={!!alert} sweep={sweep} size={36} stroke={3} ticks={tickCount} />
          </button>
        </Tip>
        {transport}
        {/* A share the policy needs (dropped, or a second screen): a fifth
            circle, red, only while it is needed - the fix without unfolding. */}
        {shareAlert && (
          <Tip label={capture.missing ? 'Share Your Second Screen' : 'Share Your Screen Again'} detail="Pick it when your browser asks" tone="out" side="right">
            <button type="button" className="sbtr-btn sbtr-btn--share" onClick={a.startCapture} aria-label={capture.missing ? 'Share your second screen' : 'Share your screen again'}><MonitorX /></button>
          </Tip>
        )}
      </div>
    );
  }

  return (
    <section className={`sbclock sbclock--${tone}${leaving ? ' is-leaving' : ''}`} aria-label="Time clock">
      <NavTip label="Open Time Clock" side="top">
      <button type="button" className="sbclock-head" onClick={a.openClock}>
        <ClockRing pct={pct} tone={tone} alert={!!alert} sweep={sweep} size={38} ticks={tickCount} />
        <span className="sbclock-text">
          <span className="sbclock-line">
            <span className="sbclock-state">{stateLabel}</span>
            {live && <span className="sbclock-timer" key={vm.timer}>{vm.timer}</span>}
          </span>
          <span className="sbclock-sub">{vm.sinceLabel}</span>
        </span>
      </button>
      </NavTip>
      {alert && (
        shareAlert
          ? (
            <NavTip label={capture.missing ? 'Share Your Second Screen' : 'Share Your Screen Again'} detail="Pick it when your browser asks" tone="out" side="top">
              <button type="button" className="sbclock-alert sbclock-alert--btn" role="status" onClick={a.startCapture}>{alert}</button>
            </NavTip>
          )
          : <span className="sbclock-alert" role="status">{alert}</span>
      )}
      {transport}
      {capture && live && (
        <div className={`sbclock-monwrap${capture.needed || capture.missing ? ' is-needed' : ''}`}>
        <div className="sbclock-mon" role="group" aria-label="Screen capture">
          <span className={`sbclock-mon-label${capture.paused ? ' is-paused' : capture.screens ? ' is-on' : ''}`}>
            {capture.paused ? 'Paused for Break' : capture.screens ? 'Recording' : 'Not Recording'}
            {capture.screens > 0 && !capture.paused && <em>{capture.expected > capture.screens ? `${capture.screens} of ${capture.expected}` : `${capture.screens} screen${capture.screens === 1 ? '' : 's'}`}</em>}
          </span>
          <NavTip label={capture.screens ? 'Stop Capture' : 'Share Your Screen'} detail={captureTitle(capture)} side="top">
          <button type="button" className={`sbclock-mon-ico${capture.paused ? ' is-paused' : capture.screens ? ' is-on' : capture.needed ? ' is-needed' : ''}`}
            onClick={capture.screens ? a.stopCapture : a.startCapture}
            aria-label={capture.paused ? 'Capture paused for your break - stop capture' : capture.screens ? 'Recording - stop capture' : capture.needed ? 'Screen sharing stopped - share your screen again' : 'Share your screen'}>
            {capture.paused ? <MonitorPause /> : capture.screens ? <MonitorUp /> : <MonitorX />}
          </button>
          </NavTip>
          {capture.screens > 0 && (
            <NavTip label="Capture Another Screen" detail="Pick your second monitor when your browser asks" side="top">
              <button type="button" className={`sbclock-mon-ico sbclock-mon-add${capture.missing ? ' is-needed' : ''}`} onClick={a.startCapture} aria-label="Capture another screen"><Plus /></button>
            </NavTip>
          )}
        </div>
        </div>
      )}
    </section>
  );
}
