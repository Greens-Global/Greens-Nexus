// My Time (Essentials) - the simple punch tile (Neil, Oct 8: "a simple version
// of the Workday widget where it allows punch in, punch out, break and end
// break - doesn't need the full features; if clicked on, it should take them
// to Workday where the time clock actually lives"). Registered as 'my-time' in
// widgets.jsx with `timeTracked: true`, so a salaried (time-tracking-exempt)
// person never sees it placed or offered - the dashboard reads the flag from
// RoleContext (/roles/me) and leaves the tile out of their grid and gallery.
//
// What it shows: the state (Clocked In / On Break / Clocked Out) with when it
// began, today's hours so far, and the punch buttons the server allows next.
// Nothing else - next shift, time off, the pay period, time-card review and
// missing-punch fixes all live on the Workday page, which the whole card
// opens. Reads /timeclock/status, polling every 60s while the tab is visible
// and after every punch (here, on the Workday page or from the floating pill).
//
// Every punch is the real thing, not a hand-off. Punch Out / Start Break /
// End Break are the floating pill's quick flow (components/TimeclockWidget):
// land a parked punch first, then a durable punch with a location fix. Punch
// In follows the Time Clock screen's own order: screen share starts inside
// the click (the browser grants it only on a gesture), the beginning-of-day
// message gate when today's is still owed, then the punch with the full
// geofence budget and the shared-PC agent pairing. The one thing it cannot
// do is the disclosed-monitoring consent notice - that stays on the Time
// Clock screen, and the tile says so and points there.
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Clock, LogOut, Coffee, Play, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { api } from '../../api';
import { LoadingState } from '../../components/AsyncState';
import BodModal from '../../components/BodModal';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { punchDurable, replayPending, readPending } from '../../lib/punchQueue';
import { punchPosition } from '../../lib/geoPosition';
import { pairLocalAgent } from '../../lib/agentPair';
import { useIsMobile } from '../../lib/useIsMobile';
import { formatTime } from '../../lib/datetime';
import { DashCard, navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';

const STATUS_POLL_MS = 60000;

export const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
// Local calendar date as YYYY-MM-DD - the key the time clock's `days` map uses.
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
const PUNCH_LABEL = { in: 'Punch In', out: 'Punch Out', break_start: 'Start Break', break_end: 'End Break' };
const PUNCH_DONE = { in: 'Clocked in', out: 'Clocked out', break_start: 'Break started', break_end: 'Back from break' };
const ACTION_ICON = { in: Play, out: LogOut, break_start: Coffee, break_end: Play };

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
 * The pure view model: everything the tile shows, from /timeclock/status.
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

const lineStyle = { display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, lineHeight: 1.45 };
const linkBtn = { border: 'none', background: 'none', padding: 0, color: 'var(--wk-brand, hsl(var(--color-blue)))', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' };
const stop = (e) => e.stopPropagation();

export default function MyTime() {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState(null);         // null = pending; { error: true } = failed with nothing to show
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);             // { ok, text } - what the last punch did, or why it did not
  const [gate, setGate] = useState(null);             // 'bod' while the beginning-of-day message is owed
  const [eodOpen, setEodOpen] = useState(false);
  const alive = useRef(true);
  const clickedAt = useRef('');                       // when Punch In was pressed, carried through the gate
  const noteTimer = useRef(null);

  const loadStatus = useCallback(() => api.timeStatus()
    .then(s => { if (alive.current) setStatus(s || {}); })
    .catch(() => { if (alive.current) setStatus(s => s || { error: true }); }), []);

  useEffect(() => {
    alive.current = true;
    loadStatus();
    const stopPoll = pollWhileVisible(loadStatus, STATUS_POLL_MS);
    // A punch made on the Workday page or from the floating pill.
    window.addEventListener('nexus:timeclock-changed', loadStatus);
    return () => { alive.current = false; stopPoll(); clearTimeout(noteTimer.current); window.removeEventListener('nexus:timeclock-changed', loadStatus); };
  }, [loadStatus]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const vm = deriveMyTime({ status: status?.error ? null : status, now });
  const go = () => navigate('timeclock', 'overview');

  // A success note clears itself; a problem stays until the next punch.
  const say = (ok, text) => {
    clearTimeout(noteTimer.current);
    setNote({ ok, text });
    if (ok) noteTimer.current = setTimeout(() => { if (alive.current) setNote(null); }, 6000);
  };

  async function act(kind) {
    if (busy) return;
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
      if (status?.bodRequired && !status?.bodExempt) { setGate('bod'); return; }
    }
    await punch(kind);
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
        clickedAt: kind === 'in' ? clickedAt.current : undefined,
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
        loadStatus();
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
      if (alive.current) setBusy('');
    }
  }

  // "Already sent elsewhere" marker, so the gate does not ask again today.
  const bodMarker = () => api.timeBodRecord({ kind: 'bod', message: '(sent outside Nexus)', sent: false, tz_offset_min: new Date().getTimezoneOffset() }).catch(() => {});

  const btnBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: isMobile ? 44 : 34, padding: isMobile ? '0 14px' : '0 14px', fontSize: 13, flex: 1 };
  const stateColor = vm.state === 'break' ? 'hsl(var(--color-orange))' : vm.state === 'in' ? 'hsl(var(--color-green))' : 'var(--muted)';
  // The line under the title: what the last punch did (or why it did not),
  // else since when the state holds. It lives up here, not as a row of its
  // own, so the card never grows past its three rows.
  const subtitle = note ? (
    <span role={note.ok ? 'status' : 'alert'} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, color: note.ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', fontWeight: 600 }}>
      {note.ok ? <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />}
      <span>{note.text}</span>
    </span>
  ) : !status || status.error || vm.exempt ? undefined
    : vm.sinceLabel ? vm.sinceLabel.charAt(0).toUpperCase() + vm.sinceLabel.slice(1)
    : vm.lastOutLabel || undefined;

  return (
    <DashCard title="My Time" sub={subtitle} onClick={go}
      action={<button type="button" style={{ ...linkBtn, whiteSpace: 'nowrap', minHeight: isMobile ? 44 : undefined }} onClick={(e) => { stop(e); go(); }}>Open Time Clock <ArrowRight size={12} /></button>}>
      {!status ? (
        <LoadingState compact />
      ) : vm.exempt ? (
        <div style={{ ...noteStyle, padding: '6px 0', textAlign: 'left' }}>Time tracking is not required for your role.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {status.error ? (
            <div style={{ ...lineStyle, color: 'hsl(var(--color-red))' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1 }}>Could not load your time right now. <button type="button" style={linkBtn} onClick={(e) => { stop(e); loadStatus(); }}>Try Again</button></span>
            </div>
          ) : (
            <>
              {/* The state, and today's hours beside it - one glance. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700, color: stateColor }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: stateColor, flexShrink: 0 }} />
                  {vm.stateLabel}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.05, color: 'var(--wk-ink, var(--ink))', fontVariantNumeric: 'tabular-nums' }}>{fmtH(vm.todayMin)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Today</div>
                </div>
              </div>

              {/* The punches the clock accepts next. The buttons are the tile's
                  own targets - the card around them opens Workday. */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onClick={stop}>
                {vm.actions.map(a => {
                  const I = ACTION_ICON[a.kind] || Clock;
                  return (
                    <button key={a.kind} type="button" className={a.primary ? 'primary-btn' : 'secondary-btn'} style={btnBase}
                      disabled={!!busy} aria-busy={busy === a.kind || busy === `share:${a.kind}` || undefined} onClick={() => act(a.kind)}>
                      <I size={14} /> {busy === a.kind ? 'Recording…' : busy === `share:${a.kind}` ? 'Choose a screen…' : a.label}
                    </button>
                  );
                })}
              </div>

            </>
          )}
        </div>
      )}

      {/* The modals go to document.body: the grid item is transformed, which
          would trap their position: fixed overlay inside this small card.
          A portal keeps React's click bubbling, so stop it before it
          reaches the card's open-Workday handler. */}
      {gate === 'bod' && createPortal(
        <div onClick={stop}>
          <BodModal mode="bod" required
            onSent={() => { setGate(null); punch('in'); }}
            onSkip={() => { bodMarker(); setGate(null); punch('in'); }}
            onClose={() => { clickedAt.current = ''; setGate(null); }}
            toastOk={(t) => say(true, t)} toastErr={(t) => say(false, t)} />
        </div>, document.body)}
      {eodOpen && createPortal(
        <div onClick={stop}><BodModal mode="eod" onClose={() => setEodOpen(false)} toastOk={() => {}} toastErr={() => {}} /></div>, document.body)}
    </DashCard>
  );
}
