import { useState } from 'react';

// ── DayTimeline — a day's punches as a readable work/break bar ────────────────
// Auto-zooms to the punched window (not 0–24h), draws hour ticks underneath,
// and every segment is interactive: hover or click for exact times + duration.
// Green = working, amber = break, pulsing = still open. Shared by the employee
// Timesheet and HR → Time.

export function daySegments(punches) {
  const evs = (punches || []).filter(p => !p.voided)
    .map(p => ({ ...p, t: new Date(p.at + 'Z').getTime() }))
    .sort((a, b) => a.t - b.t);
  const segs = [];
  let workStart = null, breakStart = null;
  for (const p of evs) {
    if (p.kind === 'in') { if (workStart === null) workStart = p.t; }
    else if (p.kind === 'out') {
      if (breakStart !== null) { segs.push({ type: 'break', a: breakStart, b: p.t }); breakStart = null; }
      if (workStart !== null) { segs.push({ type: 'work', a: workStart, b: p.t }); workStart = null; }
    } else if (p.kind === 'break_start') { if (breakStart === null && workStart !== null) breakStart = p.t; }
    else if (p.kind === 'break_end') {
      if (breakStart !== null) { segs.push({ type: 'break', a: breakStart, b: p.t }); breakStart = null; }
    }
  }
  if (breakStart !== null) segs.push({ type: 'break', a: breakStart, b: Date.now(), open: true });
  if (workStart !== null) segs.push({ type: 'work', a: workStart, b: Date.now(), open: true });
  return segs;
}

const HOUR = 3600000;
const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

export function TimelineLegend() {
  const item = (color, label, pulse) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
      <span style={{ width: 14, height: 7, borderRadius: 4, background: color, animation: pulse ? 'pulse 2s ease-in-out infinite' : 'none' }} />
      {label}
    </span>
  );
  return (
    <span style={{ display: 'inline-flex', gap: 14 }}>
      {item('var(--pine)', 'Working')}
      {item('#f59e0b', 'Break')}
      {item('var(--pine)', 'Still on the clock', true)}
    </span>
  );
}

export default function DayTimeline({ punches, height = 24, ticks = true }) {
  const [tip, setTip] = useState(null);   // { x (0-100), text } — hover or pinned by click
  const [pinned, setPinned] = useState(false);
  const segs = daySegments(punches);
  if (!segs.length) return null;

  // Zoom to the actual punched window, padded to whole hours.
  const min = Math.floor(Math.min(...segs.map(s => s.a)) / HOUR) * HOUR;
  const max = Math.ceil(Math.max(...segs.map(s => s.b)) / HOUR) * HOUR;
  const span = Math.max(max - min, HOUR);
  const pct = (t) => ((t - min) / span) * 100;
  const live = segs.some(s => s.open);

  // Hour ticks — at most ~7 labels regardless of span.
  const hours = Math.round(span / HOUR);
  const step = Math.max(1, Math.ceil(hours / 6));
  const tickList = [];
  for (let t = min; t <= max; t += step * HOUR) tickList.push(t);

  const segTip = (s) => `${s.type === 'work' ? 'Working' : 'Break'} · ${fmtT(s.a)} → ${s.open ? 'now' : fmtT(s.b)} · ${fmtDur(s.b - s.a)}${s.open ? ' (running)' : ''}`;
  const hover = (s) => setTip({ x: Math.min(88, Math.max(6, (pct(s.a) + pct(s.b)) / 2)), text: segTip(s) });

  const segStyle = (s, isBreak) => ({
    position: 'absolute', left: `${pct(s.a)}%`, width: `${Math.max(0.7, pct(s.b) - pct(s.a))}%`,
    top: 3, bottom: 3, borderRadius: 6, cursor: 'pointer',
    background: isBreak ? '#f59e0b' : 'var(--pine)', opacity: isBreak ? 1 : 0.92,
    animation: s.open ? 'pulse 2s ease-in-out infinite' : 'none',
    transition: 'filter 0.1s',
  });

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative' }}
      onMouseLeave={() => { if (!pinned) setTip(null); }}>
      {tip && (
        <div style={{ position: 'absolute', bottom: '100%', left: `${tip.x}%`, transform: 'translate(-50%, -4px)',
          background: 'var(--ink)', color: 'var(--paper)', fontSize: 11, fontWeight: 600, padding: '4px 10px',
          borderRadius: 8, whiteSpace: 'nowrap', zIndex: 20, pointerEvents: 'none', boxShadow: 'var(--shadow-md)' }}>
          {tip.text}
        </div>
      )}
      <div style={{ position: 'relative', height, background: 'var(--mist)', borderRadius: 8 }}>
        {segs.filter(s => s.type === 'work').map((s, i) => (
          <div key={`w${i}`} style={segStyle(s, false)}
            onMouseEnter={() => { if (!pinned) hover(s); }}
            onClick={(e) => { e.stopPropagation(); hover(s); setPinned(p => !p); }} />
        ))}
        {segs.filter(s => s.type === 'break').map((s, i) => (
          <div key={`b${i}`} style={segStyle(s, true)}
            onMouseEnter={() => { if (!pinned) hover(s); }}
            onClick={(e) => { e.stopPropagation(); hover(s); setPinned(p => !p); }} />
        ))}
        {live && (
          <span style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', fontSize: 9, fontWeight: 800, color: 'var(--pine)', letterSpacing: '.04em' }}>NOW</span>
        )}
      </div>
      {ticks && (
        <div style={{ position: 'relative', height: 13, marginTop: 2 }}>
          {tickList.map(t => (
            <span key={t} style={{ position: 'absolute', left: `${pct(t)}%`, transform: 'translateX(-50%)',
              fontSize: 9, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
