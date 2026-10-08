// The decorated date in the Schedule toolbar (10/02 - "the date on the top is
// very raw, make it look better"): a small calendar tile (brand tint, the
// month and the first day), then "Sep 28 - Oct 4" large and "2026 · Week 40 ·
// This Week" small under it. The exact MM/DD/YYYY range is the tooltip. A
// click opens a compact month calendar with the visible range marked; a day
// jumps there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAnchor, useDismissBoth } from './Menu';
import { formatMonthYear, formatDate } from '../../lib/datetime';
import { isoDate, parseIso, rangeCaption, todayIso, weekStartOf } from './shiftLib';
import { useReducedMotion } from './motion';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function DateTile({ iso, size = 40 }) {
  const d = parseIso(iso);
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 10, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      background: 'var(--card)', border: '1px solid color-mix(in srgb, var(--wk-brand) 28%, var(--line))', boxShadow: '0 1px 2px rgba(15,23,42,0.05)' }}>
      <span style={{ background: 'var(--wk-brand)', color: '#fff', fontSize: size < 36 ? 8 : 8.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', textAlign: 'center', lineHeight: `${Math.round(size * 0.32)}px` }}>
        {MON[d.getMonth()]}
      </span>
      <span style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size < 36 ? 14 : 16, fontWeight: 800, color: 'var(--wk-brand)',
        background: 'var(--wk-brand-tint)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{d.getDate()}</span>
    </span>
  );
}

// A compact month: Monday- or Sunday-first as the schedule is, the visible
// range banded, today ringed.
export function MiniMonth({ first, last, weekStart = 'monday', onPick }) {
  const [month, setMonth] = useState(() => { const d = parseIso(first); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const start = weekStartOf(month, weekStart);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const heads = weekStart === 'sunday' ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const today = todayIso();
  const nav = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 5, borderRadius: 7, display: 'inline-flex' };
  return (
    <div style={{ width: 252 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, paddingLeft: 4 }}>{formatMonthYear(month)}</span>
        <button type="button" aria-label="Previous month" style={nav} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button type="button" aria-label="Next month" style={nav} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: 2 }}>
        {heads.map((h) => <span key={h} style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', padding: '4px 0' }}>{h}</span>)}
        {cells.map((d, i) => {
          const ds = isoDate(d);
          const inRange = ds >= first && ds <= last;
          const edgeL = inRange && (ds === first || i % 7 === 0);
          const edgeR = inRange && (ds === last || i % 7 === 6);
          const out = d.getMonth() !== month.getMonth();
          return (
            <button key={ds} type="button" onClick={() => onPick(ds)} aria-label={`Go to ${formatDate(ds)}`} aria-current={ds === today ? 'date' : undefined}
              style={{ height: 32, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
                fontWeight: inRange || ds === today ? 700 : 500, color: inRange ? 'var(--wk-brand)' : out ? 'var(--muted)' : 'var(--ink)', opacity: out && !inRange ? 0.55 : 1,
                background: inRange ? 'var(--wk-brand-tint)' : 'transparent',
                borderRadius: `${edgeL ? 8 : 0}px ${edgeR ? 8 : 0}px ${edgeR ? 8 : 0}px ${edgeL ? 8 : 0}px`,
                boxShadow: ds === today ? 'inset 0 0 0 1.5px var(--wk-brand)' : 'none' }}
              className="mini-day">{d.getDate()}</button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateBlock({ view, first, last, weekStart = 'monday', onPick, compact = false, slide = 0 }) {
  const reduce = useReducedMotion();
  const anim = !reduce && slide ? (slide > 0 ? 'm-slide-next' : 'm-slide-prev') : undefined;
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const close = useCallback(() => { setOpen(false); btnRef.current?.focus(); }, []);
  const ref = useRef(null);
  const popRef = useRef(null);
  useDismissBoth(open, [ref, popRef], close);
  const pos = useAnchor(open, btnRef, 278);
  const { title, caption, exact } = rangeCaption(view, first, last, weekStart);
  useEffect(() => { if (open && pos) popRef.current?.querySelector('[aria-current="date"], .mini-day')?.focus?.(); }, [open, !!pos]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${title}, ${caption}. Pick a date`} title={exact} className="date-block"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '2px 8px 2px 4px',
          borderRadius: 10, minWidth: 0, textAlign: 'left', color: 'var(--ink)' }}>
        <DateTile iso={first} size={compact ? 34 : 40} />
        <span key={`${view}|${first}`} className={anim} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.15 }}>
          <span data-range-title="" style={{ fontSize: compact ? 15.5 : 17, fontWeight: 650, letterSpacing: '-0.015em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
          <span data-range-caption="" style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{caption}</span>
        </span>
      </button>
      {open && pos && createPortal(
        <div ref={popRef} role="dialog" aria-label="Pick a date" className="m-menu" style={{ ...pos, width: undefined, zIndex: 1350, background: 'var(--card)', border: '1px solid var(--line)',
          borderRadius: 12, boxShadow: '0 16px 40px rgba(15,23,42,0.18)', padding: 12, fontFamily: 'Inter,sans-serif' }}>
          <MiniMonth first={first} last={last} weekStart={weekStart} onPick={(ds) => { onPick(ds); close(); }} />
        </div>,
        document.body,
      )}
    </div>
  );
}
