// Team Leave Calendar (Neil, Oct 27 2026) - one month of who is out, in the
// Time Off area (People > Time > Time Off and Workday > Time Off). The server
// (GET /timeclock/timeoff/calendar) decides whose leave the viewer sees and
// how much of it: their own team / company / everyone in full (approved and
// pending, with the kind of leave), the rest of their own team as "Out"
// (approved only), and a confidential request as "Out" to anyone who may not
// see its reason. Company holidays are marked. Desktop: a Sunday-first month
// grid. Phones: the days that have something, as a list.
import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCOPE_LINE = {
  all: 'Everyone - approved and pending time off.',
  company: 'Your company - approved and pending time off.',
  team: 'Your team - approved and pending time off; the rest of your team shows approved time off as Out.',
  own: 'Your team - approved time off shows as Out; your own requests show in full.',
};
const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const shift = (key, by) => { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + by, 1)); };
const hm12 = (v) => { const [h, m] = String(v || '').split(':').map(Number); return Number.isFinite(h) ? `${h % 12 || 12}:${pad(m || 0)} ${h >= 12 ? 'PM' : 'AM'}` : ''; };

// One person on one day: a soft chip - solid tint when approved, an outline
// while pending (Awaiting HR Approval says so).
function Chip({ e, full = false }) {
  const pending = e.status === 'pending';
  const first = full ? e.name : (e.name || '').split(' ')[0];
  const part = e.startTime && e.endTime ? ` ${hm12(e.startTime)} - ${hm12(e.endTime)}` : '';
  const state = pending ? (e.awaitingHr ? 'Awaiting HR Approval' : 'Pending') : 'Approved';
  return (
    <span title={`${e.name} - ${e.label}${part} (${state})`}
      style={{ display: 'block', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 6, marginTop: 3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        background: pending ? 'transparent' : 'hsla(var(--color-green),0.12)',
        border: pending ? '1px dashed hsla(var(--color-orange),0.7)' : '1px solid transparent',
        color: pending ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))' }}>
      {first}{full ? ` - ${e.label}${part}` : ''}{pending ? (e.awaitingHr ? ' - Awaiting HR' : ' - Pending') : ''}
    </span>
  );
}

export default function TeamLeaveCalendar() {
  const isMobile = useIsMobile();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [company, setCompany] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    let live = true;
    setErr(false); setData(null);
    api.timeOffCalendar(month, company)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [month, company]);
  useEffect(() => load(), [load]);

  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysIn = new Date(y, m, 0).getDate();
  const iso = (d) => `${month}-${pad(d)}`;
  const today = (() => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; })();
  const list = (v) => (Array.isArray(v) ? v : []);
  const entries = list(data?.entries);
  const holidays = list(data?.holidays);
  const companies = list(data?.companies);
  const onDay = (ds) => entries.filter((e) => e.startDate <= ds && ds <= e.endDate);
  const holidayOn = (ds) => holidays.filter((h) => h.date === ds);

  const btn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 32, height: 32, padding: '0 10px', fontSize: 12.5 };

  return (
    <section aria-label="Team Leave Calendar" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '14px 16px', margin: '14px 0', boxShadow: 'var(--wk-shadow)', fontFamily: 'var(--wk-font)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="wkc-chip"><CalendarDays size={14} /></span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Team Leave Calendar</span>
        <span style={{ flex: 1 }} />
        {companies.length > 0 && (
          <select className="form-input" aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)}
            style={{ fontSize: 12.5, padding: '4px 8px', width: 'auto', maxWidth: '100%' }}>
            <option value="">All Companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </select>
        )}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="secondary-btn" style={btn} aria-label="Previous Month" onClick={() => setMonth((k) => shift(k, -1))}><ChevronLeft size={14} /></button>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', minWidth: 120, textAlign: 'center' }}>{MONTHS[m - 1]} {y}</span>
          <button type="button" className="secondary-btn" style={btn} aria-label="Next Month" onClick={() => setMonth((k) => shift(k, 1))}><ChevronRight size={14} /></button>
          <button type="button" className="secondary-btn" style={btn} onClick={() => setMonth(monthKey(new Date()))}>Today</button>
        </div>
      </div>
      {data?.scope && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{SCOPE_LINE[data.scope] || ''}</div>}

      {err ? <ErrorBanner message="Couldn't load the leave calendar right now." onRetry={load} />
        : data === null ? <SkeletonBlocks count={isMobile ? 3 : 1} height={isMobile ? 44 : 320} borderRadius={12} />
        : isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: daysIn }, (_, i) => i + 1).map((d) => {
              const ds = iso(d);
              const out = onDay(ds);
              const hol = holidayOn(ds);
              if (!out.length && !hol.length) return null;
              return (
                <div key={ds} style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '8px 10px', background: ds === today ? 'var(--wk-brand-tint)' : 'var(--mist)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{WEEKDAYS[new Date(y, m - 1, d).getDay()]} {formatDate(ds, ds)}</div>
                  {hol.map((h) => <div key={h.name} style={{ fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-blue))', marginTop: 3 }}>Holiday - {h.name}</div>)}
                  {out.map((e) => <Chip key={e.id} e={e} full />)}
                </div>
              );
            })}
            {!entries.length && !holidays.length && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '14px 0' }}>Nobody is out this month.</div>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
              {WEEKDAYS.map((w) => <div key={w} style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', padding: '0 4px 4px' }}>{w}</div>)}
              {Array.from({ length: first.getDay() }, (_, i) => <div key={`pad-${i}`} />)}
              {Array.from({ length: daysIn }, (_, i) => i + 1).map((d) => {
                const ds = iso(d);
                const out = onDay(ds);
                const hol = holidayOn(ds);
                const weekend = [0, 6].includes(new Date(y, m - 1, d).getDay());
                const shown = out.slice(0, 3);
                return (
                  <div key={ds} style={{ minHeight: 92, borderRadius: 10, padding: '5px 6px', minWidth: 0,
                    background: ds === today ? 'var(--wk-brand-tint)' : weekend ? 'transparent' : 'var(--mist)',
                    border: `1px solid ${ds === today ? 'var(--wk-brand)' : 'var(--wk-line2)'}` }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: ds === today ? 'var(--wk-brand)' : 'var(--muted)' }}>{d}</div>
                    {hol.map((h) => (
                      <div key={h.name} title={`Holiday - ${h.name}`} style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-blue))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</div>
                    ))}
                    {shown.map((e) => <Chip key={e.id} e={e} />)}
                    {out.length > shown.length && (
                      <div title={out.slice(3).map((e) => `${e.name} - ${e.label}`).join('\n')}
                        style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', marginTop: 3 }}>+{out.length - shown.length} More</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--muted)' }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'hsla(var(--color-green),0.25)', marginRight: 5, verticalAlign: -1 }} />Approved</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, border: '1px dashed hsl(var(--color-orange))', marginRight: 5, verticalAlign: -1 }} />Pending</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'hsla(var(--color-blue),0.3)', marginRight: 5, verticalAlign: -1 }} />Holiday</span>
              {!entries.length && <span>Nobody is out this month.</span>}
            </div>
          </>
        )}
    </section>
  );
}
