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
import BodModal from '../../components/BodModal';
import { punchDurable, replayPending, readPending } from '../../lib/punchQueue';
import { bodDurable } from '../../lib/bodQueue';
import { punchPosition } from '../../lib/geoPosition';
import { applyPunch, useTimeStatus, refetchTimeStatusFresh } from '../../lib/useTimeStatus';
import { pairLocalAgent } from '../../lib/agentPair';
import { formatTime } from '../../lib/datetime';
// The open shift's math is shared with the Time Clock tile so the two never
// disagree about today (Oct 14).
import { openSession } from './punchMath.js';

const STATUS_POLL_MS = 60000;

export const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
// Local calendar date as YYYY-MM-DD - the key the time clock's `days` map uses.
export const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
export const PUNCH_LABEL = { in: 'Punch In', out: 'Punch Out', break_start: 'Start Break', break_end: 'End Break' };
const CONSENT_TEXT = "Today's monitoring notice needs your acknowledgment first - open Time Clock to clock in.";
const CONSENT_SHORT = 'Acknowledge the notice in Time Clock.';
const PUNCH_DONE = { in: 'Clocked in', out: 'Clocked out', break_start: 'Break started', break_end: 'Back from break' };

/**
 * The pure view model: everything a punch tile shows, from /timeclock/status.
 * A null status (not loaded / failed) gives an 'unknown' state, never throws.
 */
export function deriveMyTime({ status, now = new Date() }) {
  const last = status?.lastPunch;
  const stale = !!status?.staleOpenShift;
  const open = !!(last && last.kind !== 'out') && !stale;
  // Exempt people have no clock - unless one is still clocked in (the flag was
  // set mid-shift): the surface stays until they punch out, or the shift would
  // age into a Missing day nobody can close (Oct 16).
  const exempt = !!status?.timeTrackingExempt && !open;
  const clockedIn = !exempt && open;
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

// A clock-in that will not happen after all (the beginning-of-day prompt
// closed, the punch refused): the screen share started for it must not run on
// while the person is clocked out. TimeclockWidget only stops capture on a
// clocked-in -> clocked-out transition, which an abandoned clock-in never makes.
const dropCapture = () => { try { window.__nexusCapture?.stop?.(); } catch { /* engine not mounted */ } };

export function usePunchClock() {
  // The shared read (lib/useTimeStatus): every punch tile, the floating timer
  // and Workday watch ONE /timeclock/status query - a tile no longer polls on
  // its own beside it. Mapped to this hook's old shape: null = pending,
  // { error: true } = failed with nothing to show, {} = an empty answer.
  const shared = useTimeStatus({ pollMs: STATUS_POLL_MS });
  const status = shared.status || (shared.loaded ? {} : shared.failed ? { error: true } : null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);             // { ok, text } - what the last punch did, or why it did not
  // 'bod' while the beginning-of-day message is owed; 'break' / 'break_end'
  // while the break's reason / note prompt holds that punch.
  const [gate, setGate] = useState(null);
  const [eodOpen, setEodOpen] = useState(false);
  const alive = useRef(true);
  const clickedAt = useRef('');                       // when Punch In was pressed, carried through the gate
  // The location fix for the punch, started the moment the button is pressed
  // so it runs under the screen picker and the message prompt instead of
  // after them (up to 9s cold for a clock-in - most of the "lag" after Play).
  const posRef = useRef(null);
  const noteTimer = useRef(null);
  // Set for the whole of a tap's flow (share, gates, punch) - a second tap
  // before React re-renders the button busy must not start a second flow.
  const inFlight = useRef(false);

  // Resolves once the fresh answer is in (joins a read already on its way).
  // A punch made anywhere else re-reads it through 'nexus:timeclock-changed',
  // which useTimeStatus listens for itself.
  const reloadShared = shared.reload;
  const loadStatus = useCallback(() => Promise.resolve(reloadShared()).catch(() => {}), [reloadShared]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(noteTimer.current); };
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const vm = deriveMyTime({ status: status?.error ? null : status, now });

  // A success note clears itself; a problem stays until the next punch.
  // `short`: the same news in a few words, for the one-tap tile whose caption
  // has a line or two (the full sentence was clamped there, and its title
  // tooltip never shows on a phone).
  const say = (ok, text, short) => {
    clearTimeout(noteTimer.current);
    setNote({ ok, text, short: short || text });
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
    // The monitoring notice needs an acknowledgment this tile does not carry -
    // the Time Clock screen has it, right above its Punch In. Checked BEFORE
    // the screen picker: sharing a screen only to be sent elsewhere left the
    // stream running while clocked out.
    if (kind === 'in' && status?.monitoring?.consentRequired) {
      say(false, CONSENT_TEXT, CONSENT_SHORT);
      return false;
    }
    posRef.current = punchPosition(kind);
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
          : 'You need to share a screen to end your break. Choose a screen when your browser asks, then tap again.',
        kind === 'in' ? 'Share a screen to clock in.' : 'Share a screen to end your break.');
        return;
      }
    }
    if (kind === 'in') {
      clickedAt.current = new Date().toISOString().slice(0, 19);
      // Beginning-of-day message, when today's is still owed (bodRequired:
      // no message sent and no clock-in yet today; never for role-exempt
      // people). The punch records once it is sent or acknowledged. The
      // share above has to come first (the browser grants it only inside
      // this tap), so closing the prompt stops it again (see `modals`).
      if (status?.bodRequired && !status?.bodExempt) { setGate('bod'); return true; }
    }
    // End-of-day message BEFORE the clock-out (Oct 16: policy, enforced by
    // the server for every surface - it refuses an "out" with no EOD on
    // record). Sent or acknowledged, then the punch records.
    if (kind === 'out' && status?.eodRequired && !status?.bodExempt) {
      clickedAt.current = new Date().toISOString().slice(0, 19);
      setGate('eod');
      return true;
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
          if (kind === 'in') dropCapture();
          say(false, 'An earlier punch has not recorded yet. Open Time Clock to retry it before punching again.', 'An earlier punch is still pending.');
          return;
        }
      }
      const posP = posRef.current || punchPosition(kind);
      posRef.current = null;
      const [early, pairNonce] = await Promise.all([
        posP,
        kind === 'in' ? pairLocalAgent() : Promise.resolve(''),
      ]);
      // No fix from the early start (its permission bubble can sit behind the
      // share picker on a first use): ask once more now, as before - a denied
      // or unsupported device answers instantly, so this never waits twice.
      const pos = early ?? await punchPosition(kind);
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
        // Every surface flips now - the re-read below only confirms it.
        applyPunch(p);
        const where = p.geoStatus === 'in_fence' ? ` at ${p.workSiteName}`
          : p.geoStatus === 'out_of_fence' ? ' - out of location, flagged for review'
          : p.geoStatus === 'remote' ? ' - remote'
          : '';
        say(true, `${PUNCH_DONE[kind]} at ${formatTime(p.at ? utc(p.at) : new Date())}${where}.`);
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        if (kind === 'out' && res.result?.promptEod) setEodOpen(true);
        // Stay busy until the fresh status is in: re-enabling now would offer
        // the punch just made for one more round trip (a second tap reopened
        // the screen-share picker and got "Duplicate punch"). A fresh read,
        // never one that left before this punch landed.
        await Promise.resolve(refetchTimeStatusFresh()).catch(() => {});
        return;
      }
      // A clock-in that did not record and is not parked to record later.
      // Not on a 409, though: that is a state clash ("already clocked in" on
      // another device, or a duplicate) - the person may well be on the clock,
      // and dropping the share would leave that shift uncaptured. The server
      // refuses capture from anyone who is not clocked in, so a stray share
      // after a real clash ends there.
      if (kind === 'in' && !res.queued && res.error?.status !== 409) dropCapture();
      if (res.unreachable) {
        say(false, res.queued
          ? 'Nexus could not reach the server. Your punch is saved on this device and will record when the connection returns.'
          : 'Nexus could not reach the server and the punch did not record. Open Time Clock to retry.',
        res.queued ? 'Offline - saved, records later.' : 'Offline - not recorded.');
      } else if (kind === 'in' && (res.error?.detail?.code === 'monitoring_consent_required' || /monitoring_consent_required/i.test(res.error?.message || ''))) {
        say(false, CONSENT_TEXT, CONSENT_SHORT);
      } else if (res.error?.detail?.code === 'bod_required' || res.error?.detail?.code === 'eod_required') {
        // The server holds the policy: a stale status let the punch go out
        // without its message - open the prompt and the punch follows it.
        setGate(res.error.detail.code === 'bod_required' ? 'bod' : 'eod');
        return;
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
  // Awaited before the punch: the server wants it on record first (Oct 16).
  const bodMarker = (kind = 'bod') => bodDurable({ kind, message: '(sent outside Nexus)', sent: false, tz_offset_min: new Date().getTimezoneOffset() }).catch(() => {});

  const stop = (e) => e.stopPropagation();
  const modals = (
    <>
      {gate === 'bod' && createPortal(
        <div onClick={stop}>
          <BodModal mode="bod" required
            onSent={() => { setGate(null); punch('in').finally(() => { inFlight.current = false; }); }}
            onSkip={async () => { await bodMarker('bod'); setGate(null); punch('in').finally(() => { inFlight.current = false; }); }}
            // Closed without sending: no clock-in, so no screen share either.
            onClose={() => { dropCapture(); clickedAt.current = ''; inFlight.current = false; setGate(null); }}
            toastOk={(t) => say(true, t)} toastErr={(t) => say(false, t)} />
        </div>, document.body)}
      {gate === 'eod' && createPortal(
        <div onClick={stop}>
          <BodModal mode="eod" required
            onSent={() => { setGate(null); punch('out').finally(() => { inFlight.current = false; }); }}
            onSkip={async () => { await bodMarker('eod'); setGate(null); punch('out').finally(() => { inFlight.current = false; }); }}
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
