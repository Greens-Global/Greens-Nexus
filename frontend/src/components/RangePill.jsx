import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDate } from '../lib/datetime';
import { DateField } from '../tasks/components';

// ONE bounded date-range control (11/03/2026): `‹ 11/02/2026 - 11/08/2026 ›`
// - the arrows step a whole period back or forward, clicking the dates opens
// a From / To popover, and an optional quick reset jumps back to the usual
// range. Every date-range filter on the Time screens uses this - never two
// loose date boxes on the page again.
//   start / end   ISO dates
//   onChange      (start, end) => void
//   reset         { label, range: () => [start, end] } - the quick reset
export default function RangePill({ start, end, onChange, reset = null }) {
  const [open, setOpen] = useState(false);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shift = (dir) => {
    const ms = 86400000;
    const s = new Date(start + 'T12:00:00'), e = new Date(end + 'T12:00:00');
    const span = Math.max(1, Math.round((e - s) / ms) + 1);
    onChange(iso(new Date(s.getTime() + dir * span * ms)), iso(new Date(e.getTime() + dir * span * ms)));
  };
  const navBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: '5px 4px', borderRadius: 7 };
  const dateBox = { border: '1px solid var(--wk-line2)', borderRadius: 8, padding: '6px 9px', background: 'var(--card)' };
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 1,
      border: '1px solid var(--wk-line2)', borderRadius: 9, background: 'var(--card)', padding: '1px 3px' }}>
      <button type="button" aria-label="Previous period" title="Previous period" onClick={() => shift(-1)} style={navBtn}><ChevronLeft size={14} /></button>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} title="Pick the dates"
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13, fontWeight: 600,
          color: 'var(--ink)', padding: '5px 5px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {formatDate(start)} - {formatDate(end)}
      </button>
      <button type="button" aria-label="Next period" title="Next period" onClick={() => shift(1)} style={navBtn}><ChevronRight size={14} /></button>
      {open && (<>
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 31, background: 'var(--card)',
          border: '1px solid var(--wk-line2)', borderRadius: 12, padding: 12, boxShadow: '0 12px 32px rgba(17,24,39,0.16)',
          display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          <DateField value={start} onChange={(v) => v && onChange(v, end >= v ? end : v)} title="From date" style={dateBox} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
          <DateField value={end} onChange={(v) => v && onChange(start <= v ? start : v, v)} title="To date" style={dateBox} />
          {reset && (
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }}
              onClick={() => { const [s, e] = reset.range(); onChange(s, e); setOpen(false); }}>{reset.label}</button>
          )}
        </div>
      </>)}
    </div>
  );
}
