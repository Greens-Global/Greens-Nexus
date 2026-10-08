import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Circle, CheckCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { formatTime, formatMonthDay, wallClock } from '../lib/datetime';

// ── Work Log (BOD/EOD) - a day's planned/completed/pending, read from the
// Time Clock's Beginning/End-of-day composer. Two surfaces share this same
// content renderer: the timesheet's per-day icon opens it in a drawer
// (WorkLogDrawer, below); the People profile's Work Logs tab expands it
// inline under the clicked day (see WorkLogContent + HR.jsx's WorkLogsSection).

// The composer's task list is free text (one item per line, optionally numbered
// and/or prefixed "Pending: "), not a structured field - split it into rows
// that read like the Tasks module's checklist rather than one dense caption.
function parseTaskLines(tasks) {
  return (tasks || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const pending = /^pending\s*:/i.test(line);
    const text = line.replace(/^pending\s*:\s*/i, '').replace(/^\d+[.)]\s*/, '');
    // "- done" can sit mid-sentence ("Client call - done, sending recap"), not
    // just at the end, so match it anywhere rather than only as a trailing suffix.
    const done = !pending && /-\s*done\b|\(done\)/i.test(text);
    return { text: text.replace(/\s*-\s*done\b,?\s*/i, ' ').replace(/\s*\(done\)\s*/i, ' ').trim(), pending, done };
  });
}

// kind: 'bod' items are a plan, not yet performed - they only ever show as
// open (never a green check, even if the free text happens to say "done").
// Only 'eod' items can be marked complete or pending.
export function TaskChecklist({ tasks, kind }) {
  const items = parseTaskLines(tasks);
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
      {items.map((it, i) => {
        const pending = kind === 'eod' && it.pending;
        const done = kind === 'eod' && it.done;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
            {pending
              ? <AlertTriangle size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0, marginTop: 1.5 }} />
              : done
                ? <CheckCircle size={14} style={{ color: 'hsl(var(--color-green))', flexShrink: 0, marginTop: 1.5 }} />
                : <Circle size={14} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 1.5 }} />}
            <span style={{ fontSize: 13, lineHeight: 1.4, color: pending ? 'hsl(var(--color-orange))' : 'var(--ink)', fontWeight: pending ? 600 : 400 }}>
              {pending && <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: '.04em', textTransform: 'uppercase', marginRight: 6 }}>Pending:</span>}
              {it.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// A Work Log punch time, on the EMPLOYEE'S clock (Oct 2): `tzOffsetMin` is
// the punching device's offset the API returns beside the time. A clock-out
// after midnight carries its own date ("2:30 AM, Oct 2") so it is never read
// as the workday's morning, and the zone shows when it is not the viewer's.
// Without an offset (older callers) it falls back to the viewer's clock.
export const punchTime = (iso, tzOffsetMin, workday) => {
  if (!iso) return '';
  if (tzOffsetMin === undefined || tzOffsetMin === null) return formatTime(`${iso}Z`);
  const w = wallClock(iso, tzOffsetMin);
  if (!w) return '';
  const day = workday && w.date !== workday ? `, ${formatMonthDay(`${w.date}T12:00:00`)}` : '';
  const zone = Number(tzOffsetMin) !== new Date().getTimezoneOffset() ? ` ${w.zone}` : '';
  return `${w.time}${day}${zone}`;
};

// Small icon button a timesheet row (or People tab day row) uses to open/expand
// the Work Log for its day.
export function WorkLogButton({ onClick, title = 'View work log' }) {
  return (
    <button onClick={onClick} title={title}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-brand, var(--pine))', display: 'inline-flex', padding: 2 }}>
      <FileText size={15} />
    </button>
  );
}

// The shared body: BEGINNING OF DAY / END OF DAY blocks with punch time,
// message, and task checklist. `data` is the GET /timeclock/bod/day payload
// (or null while loading, handled by the caller).
export function WorkLogContent({ data, err }) {
  if (err) return <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{err}</div>;
  if (data === null) return <SkeletonBlocks count={2} height={90} />;
  if (!data.bod && !data.eod) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>No work log posted for this day.</div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {[['Beginning of day', data.bod, 'bod', 'Punched in', data.punchInAt, data.punchInTz],
        ['End of day', data.eod, 'eod', 'Punched out', data.punchOutAt, data.punchOutTz]].map(([label, slot, kind, punchLabel, punchAt, punchTz]) => (
        <div key={label} style={{ background: 'var(--mist)', borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>{label}</span>
            {punchAt && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand, var(--ink))' }}>{punchLabel} {punchTime(punchAt, punchTz, data.date)}</span>
            )}
          </div>
          {slot ? (<>
            <div style={{ fontSize: 13, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{slot.message || <span style={{ color: 'var(--muted)' }}>(no message)</span>}</div>
            <TaskChecklist tasks={slot.tasks} kind={kind} />
          </>) : (
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No {label.toLowerCase()} post.</span>
          )}
        </div>
      ))}
    </div>
  );
}

// email/date identify the day; onClose closes the drawer. Fetches on mount -
// no caching, this is opened per-click and closed when done. Used by the
// timesheet's per-day icon (PayrollTimecard).
export default function WorkLogDrawer({ email, date, name = '', onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null); setErr('');
    api.timeBodDay(email, date).then(setData).catch(e => setErr(e?.message || 'Could not load the work log.'));
  }, [email, date]);

  // Lock the page behind the drawer while it's open - otherwise the underlying
  // page can still scroll, which shows a second scrollbar alongside the
  // drawer's own and reads as a layout bug.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // MM-DD-YYYY, per the wanted display format.
  const [y, mo, d] = date.split('-');
  const niceDate = `${mo}-${d}-${y}`;

  return createPortal(
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 3500, display: 'flex', justifyContent: 'flex-end' }}>
      <aside style={{ width: 460, maxWidth: '100%', height: '100%', background: 'var(--card)', borderLeft: '1px solid var(--wk-line2)', boxShadow: '-8px 0 40px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--wk-font, Inter, sans-serif)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileText size={17} style={{ color: 'var(--wk-brand, var(--pine))', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Work Log</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{name ? `${name} · ` : ''}{niceDate}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
          <WorkLogContent data={data} err={err} />
        </div>
      </aside>
    </div>,
    document.body
  );
}
