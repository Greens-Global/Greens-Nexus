// The punch clock as a hook (Oct 11) - pulled out of the My Time tile so the
// single-action Punch tile (widgets.jsx 'action' with action 'punch') runs
// the SAME flow instead of a lighter copy: status from /timeclock/status
// (polled while visible, refreshed on every punch made anywhere), the screen
// share started inside the click, the monitoring-consent stop, the
// beginning-of-day gate, the parked-punch replay, the location fix and the
// shared-PC pairing, then the durable punch and a plain-English note about
// what happened. Nothing here is new behavior - see MyTime.jsx for the why
// of each step; that file is now just the card around this hook.
//
// `modals` is a node the caller renders anywhere: the BodModal gates go
// to document.body through a portal (a transformed grid item would trap a
// position: fixed overlay) with click bubbling stopped, so a card whose own
// click opens Workday does not fire under the modal.
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import BodModal from '../../components/BodModal';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { punchDurable, replayPending, readPending } from '../../lib/punchQueue';
import { punchPosition } from '../../lib/geoPosition';
import { pairLocalAgent } from '../../lib/agentPair';
import { formatTime } from '../../lib/datetime';

const STATUS_POLL_MS = 60000;

export const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
// Local calendar date as YYYY-MM-DD - the key the time clock's `days` map uses.
export const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
export const PUNCH_LABEL = { in: 'Punch In', out: 'Punch Out', break_start: 'Start Break', break_end: 'End Break' };
const PUNCH_DONE = { in: 'Clocked in', out: 'Clocked out', break_start: 'Break started', break_end: 'Back from break' };

// Walk every punch the status payload carries (last 7 days) and return the
// open shift, if any: when it was clocked in and the minutes worked so far
// (breaks excluded, an open break frozen). Null when nothing is open.
function openSession(days, last, now) {
  const all = Object.values(days).flatMap(d => d?.punches || []).filter(p => p?.at && p.kind).sort((a, b) => a.at.localeCompare(b.at));
  if (!all.length) {
    // Older payload shape: elapsed from the last punch, paused on a break.
    if (!last?.at) return null;
    const inAt = utc(last.at);
    return { inAt, workedMin: last.kind === 'break_start' ? 0 : Math.max(0, Math.floor((now - inAt) / 60000)) };
  }
  let inAt = null, breakMs = 0, openBreak = null;
  for (const p of all) {
    if (p.kind === 'in') { inAt = utc(p.at); breakMs = 0; openBreak = null; }
    else if (p.kind === 'out') { inAt = null; breakMs = 0; openBreak = null; }
    else if (inAt && p.kind === 'break_start') openBreak = utc(p.at);
    else if (inAt && p.kind === 'break_end' && openBreak) { breakMs += utc(p.at) - openBreak; openBreak = null; }
  }
  if (!inAt) return null;
  const live = (now - inAt) - breakMs - (openBreak ? now - openBreak : 0);
  return { inAt, workedMin: Math.max(0, Math.floor(live / 60000)) };
}

/**
 * The pure view model: everything a punch tile shows, from /timeclock/status.
 * A null status (not loaded / failed) gives an 'unknown' state, never throws.
 */
export function deriveMyTime({ status, now = new Date() }) {
  const exempt = !!status?.timeTrackingExempt;
  const last = status?.lastPunch;
  const stale = !!status?.staleOpenShift;
  const clockedIn = !exempt && !!(last && last.kind !== 'out') && !stale;
  const onBreak = clockedIn && last?.kind === 'break_start';
  const state = exempt ? 'exempt' : !status ? 'unknown' : onBreak ? 'break' : clockedIn ? 'in' : 'out';
  const stateLabel = { exempt: 'Time Tracking Not Required', unknown: '', break: 'On Break', in: 'Clocked In', out: 'Clocked Out' }[state];
  // The open shift: its clock-in (what "since" names) and the minutes worked
  // so far. A day's workedMin counts only CLOSED segments, so the live one is
  // rebuilt from the day's punches - clock-in to now, less every break.
  const session = clockedIn ? openSession(status?.days || {}, last, now) : null;
  const since = onBreak && last?.at ? utc(last.at) : (session?.inAt || (clockedIn && last?.at ? utc(last.at) : null));
  const sinceLabel = since ? `since ${formatTime(since)}` : '';
  // Clocked out: when today's last shift ended, so the tile still says
  // something about the day; an older last punch means no shift yet today.
  // Nothing for a stale shift (the Workday page explains that one).
  const todayKey = localKey(now);
  const lastOutLabel = state !== 'out' || stale ? ''
    : last?.kind === 'out' && last.at && (last.localDate || localKey(utc(last.at))) === todayKey ? `Last clocked out at ${formatTime(utc(last.at))}`
    : 'Not clocked in today';
  // What the clock accepts next - the server's state machine, same list the
  // Time Clock screen and the floating pill read.
  const allowed = exempt || !status ? [] : (Array.isArray(status.allowed) && status.allowed.length ? status.allowed : (clockedIn ? (onBreak ? ['break_end', 'out'] : ['out', 'break_start']) : ['in']));
  const actions = allowed.filter(k => PUNCH_LABEL[k]).map(k => ({ kind: k, label: PUNCH_LABEL[k], primary: k === 'in' || k === 'out' }));
  // Today's closed segments plus the live session (paused on a break).
  const todayMin = (status?.days?.[todayKey]?.workedMin || 0) + (session ? session.workedMin : 0);
  return { exempt, state, stateLabel, since, sinceLabel, lastOutLabel, actions, todayMin, stale };
}

// The one punch a single-button tile offers: on a break, End Break (coming
// back is what the person is here for); otherwise the primary punch (in /
// out). Null when nothing is allowed (loading, exempt, failed).
export function nextPunch(vm) {
  if (!vm?.actions?.length) return null;
  if (vm.state === 'break') return vm.actions.find(a => a.kind === 'break_end') || vm.actions[0];
  return vm.actions.find(a => a.primary) || vm.actions[0];
}

export function usePunchClock() {
  const [status, setStatus] = useState(null);         // null = pending; { error: true } = failed with nothing to show
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);             // { ok, text } - what the last punch did, or why it did not
  // 'bod' while the beginning-of-day message is owed; 'break' / 'break_end'
  // while the break's reason / note prompt holds that punch.
  const [gate, setGate] = useState(null);
  const [eodOpen, setEodOpen] = useState(false);
  const alive = useRef(true);
  const clickedAt = useRef('');                       // when Punch In was pressed, carried through the gate
  const noteTimer = useRef(null);
  // Set for the whole of a tap's flow (share, gates, punch) - a second tap
  // before React re-renders the button busy must not start a second flow.
  const inFlight = useRef(false);

  const loadStatus = useCallback(() => api.timeStatus()
    .then(s => { if (alive.current) setStatus(s || {}); })
    .catch(() => { if (alive.current) setStatus(s => s || { error: true }); }), []);

  useEffect(() => {
    alive.current = true;
    loadStatus();
    const stopPoll = pollWhileVisible(loadStatus, STATUS_POLL_MS);
    // A punch made on the Workday page, from the floating pill or another tile.
    window.addEventListener('nexus:timeclock-changed', loadStatus);
    return () => { alive.current = false; stopPoll(); clearTimeout(noteTimer.current); window.removeEventListener('nexus:timeclock-changed', loadStatus); };
  }, [loadStatus]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const vm = deriveMyTime({ status: status?.error ? null : status, now });

  // A success note clears itself; a problem stays until the next punch.
  const say = (ok, text) => {
    clearTimeout(noteTimer.current);
    setNote({ ok, text });
    if (ok) noteTimer.current = setTimeout(() => { if (alive.current) setNote(null); }, 6000);
  };

  async function act(kind) {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    // Released here unless the beginning-of-day gate takes the flow over
    // (its send / skip / close release it).
    let handedToGate = false;
    try {
      handedToGate = await runAct(kind);
    } finally {
      if (!handedToGate) inFlight.current = false;
    }
  }

  async function runAct(kind) {
    setNote(null);
    // Screen share for a clock-in / back-from-break, started from within this
    // click: the browser only grants sharing on a user gesture. start()
    // resolves true when a stream is live or capture isn't required here, so
    // a false means "required but declined" - the punch waits.
    if (kind === 'in' || kind === 'break_end') {
      // The browser's picker is open meanwhile - say so on the button.
      setBusy(`share:${kind}`);
      let ok = true;
      try { ok = await (window.__nexusCapture?.start?.() ?? Promise.resolve(true)); }
      finally { if (alive.current) setBusy(''); }
      if (!ok) {
        say(false, kind === 'in'
          ? 'You need to share a screen to clock in. Choose a screen when your browser asks, then tap again.'
          : 'You need to share a screen to end your break. Choose a screen when your browser asks, then tap again.');
        return;
      }
    }
    if (kind === 'in') {
      // The monitoring notice needs an acknowledgment this tile does not
      // carry - the Time Clock screen has it, right above its Punch In.
      if (status?.monitoring?.consentRequired) {
        say(false, "Today's monitoring notice needs your acknowledgment first - open Time Clock to clock in.");
        return;
      }
      clickedAt.current = new Date().toISOString().slice(0, 19);
      // Beginning-of-day message, when today's is still owed (bodRequired:
      // no message sent and no clock-in yet today; never for role-exempt
      // people). The punch records once it is sent or acknowledged.
      if (status?.bodRequired && !status?.bodExempt) { setGate('bod'); return true; }
    }
    // A break asks for its reason on the way out and offers a note on the way
    // back, posted to the person's chat - the same prompts the Time Clock
    // screen holds the punch behind (the sidebar chip skipped them: Neil,
    // Oct 14 2026). The punch records once the message is sent; closing the
    // prompt cancels it. Role-flagged people (bodExempt) punch straight through.
    if ((kind === 'break_start' || kind === 'break_end') && !status?.bodExempt) {
      clickedAt.current = new Date().toISOString().slice(0, 19);
      setGate(kind === 'break_start' ? 'break' : 'break_end');
      return true;
    }
    await punch(kind);
    return false;
  }

  // The durable punch itself: land a parked punch first (punching past it
  // would drop it for good), then this one with a location fix (punchPosition:
  // the full geofence budget on the way in, a short one otherwise) plus the
  // shared-PC pairing on the way in.
  async function punch(kind) {
    setBusy(kind);
    try {
      const held = readPending();
      if (held) {
        const r = await replayPending();
        if (!r?.restored && !r?.dropped) {
          say(false, 'An earlier punch has not recorded yet. Open Time Clock to retry it before punching again.');
          return;
        }
      }
      const [pos, pairNonce] = await Promise.all([
        punchPosition(kind),
        kind === 'in' ? pairLocalAgent() : Promise.resolve(''),
      ]);
      const res = await punchDurable({
        kind, tzOffsetMin: new Date().getTimezoneOffset(), pos,
        // The moment the button was pressed, when a prompt stood between it
        // and the punch (the server backdates, bounded to 15 minutes).
        clickedAt: clickedAt.current || undefined,
        extra: pairNonce ? { pair_nonce: pairNonce } : null,
      });
      if (res.ok) {
        clickedAt.current = '';
        const p = res.punch || {};
        const where = p.geoStatus === 'in_fence' ? ` at ${p.workSiteName}`
          : p.geoStatus === 'out_of_fence' ? ' - out of location, flagged for review'
          : p.geoStatus === 'remote' ? ' - remote'
          : '';
        say(true, `${PUNCH_DONE[kind]} at ${formatTime(p.at ? utc(p.at) : new Date())}${where}.`);
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        if (kind === 'out' && res.result?.promptEod) setEodOpen(true);
        // Stay busy until the fresh status is in: re-enabling now would offer
        // the punch just made for one more round trip (a second tap reopened
        // the screen-share picker and got "Duplicate punch").
        await loadStatus();
      } else if (res.unreachable) {
        say(false, res.queued
          ? 'Nexus could not reach the server. Your punch is saved on this device and will record when the connection returns.'
          : 'Nexus could not reach the server and the punch did not record. Open Time Clock to retry.');
      } else if (kind === 'in' && (res.error?.detail?.code === 'monitoring_consent_required' || /monitoring_consent_required/i.test(res.error?.message || ''))) {
        say(false, "Today's monitoring notice needs your acknowledgment first - open Time Clock to clock in.");
      } else {
        say(false, res.error?.message || 'Punch failed.');
      }
    } finally {
      // One stamp per tap: a refused gated punch must not hand its moment to
      // the next, ungated one (a Punch Out backdated up to 15 minutes).
      clickedAt.current = '';
      if (alive.current) setBusy('');
    }
  }

  // "Already sent elsewhere" marker, so the gate does not ask again today.
  const bodMarker = () => api.timeBodRecord({ kind: 'bod', message: '(sent outside Nexus)', sent: false, tz_offset_min: new Date().getTimezoneOffset() }).catch(() => {});

  const stop = (e) => e.stopPropagation();
  const modals = (
    <>
      {gate === 'bod' && createPortal(
        <div onClick={stop}>
          <BodModal mode="bod" required
            onSent={() => { setGate(null); punch('in').finally(() => { inFlight.current = false; }); }}
            onSkip={() => { bodMarker(); setGate(null); punch('in').finally(() => { inFlight.current = false; }); }}
            onClose={() => { clickedAt.current = ''; inFlight.current = false; setGate(null); }}
            toastOk={(t) => say(true, t)} toastErr={(t) => say(false, t)} />
        </div>, document.body)}
      {(gate === 'break' || gate === 'break_end') && createPortal(
        <div onClick={stop}>
          <BodModal mode={gate} required
            onSent={() => { const kind = gate === 'break' ? 'break_start' : 'break_end'; setGate(null); punch(kind).finally(() => { inFlight.current = false; }); }}
            onClose={() => { clickedAt.current = ''; inFlight.current = false; setGate(null); }}
            toastOk={(t) => say(true, t)} toastErr={(t) => say(false, t)} />
        </div>, document.body)}
      {eodOpen && createPortal(
        <div onClick={stop}><BodModal mode="eod" onClose={() => setEodOpen(false)} toastOk={() => {}} toastErr={() => {}} /></div>, document.body)}
    </>
  );

  // What a button for `kind` should read while the hook works on it.
  const busyLabel = (kind) => busy === kind ? 'Recording…' : busy === `share:${kind}` ? 'Choose a screen…' : null;

  return { status, now, vm, busy, busyLabel, note, act, loadStatus, modals };
}
