// ── DayTimeline — a day's punches as a horizontal work/break bar ──────────────
// Green segments = working, amber = breaks (drawn on top, they happen inside a
// work span), a still-open segment pulses to "now". Hover any segment for its
// exact times. Shared by the employee Timesheet and HR → Time.

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

export default function DayTimeline({ punches, height = 24 }) {
  const segs = daySegments(punches);
  if (!segs.length) return null;
  const min = Math.min(...segs.map(s => s.a));
  const max = Math.max(...segs.map(s => s.b));
  const span = Math.max(max - min, 60000);
  const pct = (t) => ((t - min) / span) * 100;
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const live = segs.some(s => s.open);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmt(min)}</span>
      <div style={{ position: 'relative', flex: 1, height, background: 'var(--mist)', borderRadius: 8, overflow: 'hidden' }}>
        {segs.filter(s => s.type === 'work').map((s, i) => (
          <div key={`w${i}`} title={`Working ${fmt(s.a)} → ${s.open ? 'now' : fmt(s.b)}`}
            style={{ position: 'absolute', left: `${pct(s.a)}%`, width: `${Math.max(1, pct(s.b) - pct(s.a))}%`,
              top: 4, bottom: 4, borderRadius: 6, background: 'var(--pine)', opacity: 0.92,
              animation: s.open ? 'pulse 2s ease-in-out infinite' : 'none' }} />
        ))}
        {segs.filter(s => s.type === 'break').map((s, i) => (
          <div key={`b${i}`} title={`Break ${fmt(s.a)} → ${s.open ? 'now' : fmt(s.b)}`}
            style={{ position: 'absolute', left: `${pct(s.a)}%`, width: `${Math.max(1, pct(s.b) - pct(s.a))}%`,
              top: 4, bottom: 4, borderRadius: 6, background: '#f59e0b' }} />
        ))}
      </div>
      <span style={{ fontSize: 10.5, color: live ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: live ? 800 : 400, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {live ? 'now' : fmt(max)}
      </span>
    </div>
  );
}
