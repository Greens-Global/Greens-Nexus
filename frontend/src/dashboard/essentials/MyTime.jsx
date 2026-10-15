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
// opens.
//
// The punches themselves - status polling, the screen-share start, the
// monitoring-consent stop, the beginning-of-day gate, the parked-punch
// replay, the location fix, the shared-PC pairing and the durable punch -
// live in usePunchClock.jsx (Oct 11), shared with the one-tap Punch action
// tile so both run the real flow. This file is the card around that hook.
import { Clock, LogOut, Coffee, Play, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { LoadingState } from '../../components/AsyncState';
import { useIsMobile } from '../../lib/useIsMobile';
import { DashCard, navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';
import { usePunchClock, deriveMyTime, fmtH } from './usePunchClock.jsx';

// Kept here for the tests and anyone who imported them from this file.
export { deriveMyTime, fmtH };

const ACTION_ICON = { in: Play, out: LogOut, break_start: Coffee, break_end: Play };
const lineStyle = { display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, lineHeight: 1.45 };
const linkBtn = { border: 'none', background: 'none', padding: 0, color: 'var(--wk-brand, hsl(var(--color-blue)))', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' };
const stop = (e) => e.stopPropagation();

export default function MyTime({ phone }) {
  // The grid says when the board is a phone stack; outside it, the viewport.
  const isMobileViewport = useIsMobile();
  const isMobile = phone ?? isMobileViewport;
  const { status, vm, busy, busyLabel, note, act, loadStatus, modals } = usePunchClock();
  const go = () => navigate('timeclock', 'overview');

  // Side by side on ONE row, always: at the default 3x3 (a ~230px-wide body)
  // "Punch Out" + "Start Break" used to wrap, and the second row was cut in
  // half by the card's 202px height. Each button takes half the row and
  // shrinks (tighter padding, then an ellipsis) instead of wrapping.
  // Height budget at 3x3: 162px inside the padding - header ~49 (66 with a
  // two-line note) + state row 41 + gap 8 + buttons 36 = 134 (151).
  const btnBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: isMobile ? 44 : 36, padding: '0 8px', fontSize: 12.5, flex: '1 1 0', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' };
  const stateColor = vm.state === 'break' ? 'hsl(var(--color-orange))' : vm.state === 'in' ? 'hsl(var(--color-green))' : 'var(--muted)';
  // The line under the title: what the last punch did (or why it did not),
  // else since when the state holds. It lives up here, not as a row of its
  // own, so the card never grows past its three rows.
  const subtitle = note ? (
    <span role={note.ok ? 'status' : 'alert'} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, color: note.ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', fontWeight: 600 }}>
      {note.ok ? <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />}
      {/* Two lines at most on a desktop card (its height is fixed); a phone
          card grows, so the whole note shows there. */}
      <span title={note.text} style={isMobile ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{note.text}</span>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap' }} onClick={stop}>
                {vm.actions.map(a => {
                  const I = ACTION_ICON[a.kind] || Clock;
                  return (
                    <button key={a.kind} type="button" className={a.primary ? 'primary-btn' : 'secondary-btn'} style={btnBase}
                      disabled={!!busy} aria-busy={busy === a.kind || busy === `share:${a.kind}` || undefined} onClick={() => act(a.kind)}>
                      <I size={14} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{busyLabel(a.kind) || a.label}</span>
                    </button>
                  );
                })}
              </div>

            </>
          )}
        </div>
      )}

      {/* The gates go to document.body (see usePunchClock) - rendered here so
          they mount and unmount with the card. */}
      {modals}
    </DashCard>
  );
}
