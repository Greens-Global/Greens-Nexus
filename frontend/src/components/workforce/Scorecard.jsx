// Workforce Analytics > Scorecard (Neil, 10/10): who worked their expected
// hours last week and who did not. Backend workforce_scorecard.py builds the
// whole thing - expected minutes per day (published shift > shift preset >
// country standard: US 8h, India 9h), excused days (holidays, approved time
// off), punched hours with Sick / PTO as leave, late against the shift start -
// and this screen only shows it. The same report is what the weekly manager
// email carries, so the two can never disagree.
//
// Access: the 'workforce-scorecard' grant. Viewer = the manager's DIRECT
// reports (Neil, 10/10), Editor = their whole reporting line, Full / admin
// can switch to Everyone. The team-view picker
// in the header narrows it further on the client, like every other tab.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Mail, RefreshCw, Trophy, Info } from 'lucide-react';
import { api } from '../../api';
import { LoadingState } from '../AsyncState';
import { ViewNotice } from './WorkforceViews';
import { useWorkforceView } from './viewContext';
import { NX, FONT, btn } from '../../tasks/theme';
import { formatDate, formatHHMM } from '../../lib/datetime';

export const BAND_META = {
  absent:       { label: 'Absent',         color: '#b91c1c', tint: '#fef2f2' },
  well_below:   { label: 'Well Below',     color: '#c2410c', tint: '#fff7ed' },
  below:        { label: 'Below Expected', color: '#b45309', tint: '#fffbeb' },
  on_track:     { label: 'On Track',       color: '#15803d', tint: '#f0fdf4' },
  not_expected: { label: 'Not Expected',   color: '#6b7280', tint: '#f9fafb' },
  no_schedule:  { label: 'No Schedule',    color: '#6b7280', tint: '#f9fafb' },
};
const DAY_META = {
  full:     { label: 'Full',        color: '#15803d' },
  short:    { label: 'Short',       color: '#b45309' },
  absent:   { label: 'Absent',      color: '#b91c1c' },
  extra:    { label: 'Extra',       color: '#1d4ed8' },
  off:      { label: 'Off',         color: '#6b7280' },
  today:    { label: 'Today',       color: '#6b7280' },
  upcoming: { label: 'Upcoming',    color: '#9ca3af' },
};
const FLAG_LABEL = {
  missing_out: 'Missing clock-out', out_without_in: 'Clock-out without clock-in', edit_pending: 'Edit pending',
  manual: 'Manual punch', adjusted: 'Adjusted', out_of_fence: 'Out of fence', missing_break_end: 'Break never ended',
  long_break: 'Long break', auto_clock_out: 'Auto clock-out', unusually_long: 'Unusually long',
};

export const hrs = (min) => `${(Number(min || 0) / 60).toFixed(1)}h`;
// Calendar arithmetic on the date PARTS - toISOString() would shift a local
// midnight back a day in any UTC-positive zone (India) and the arrows would
// land on the wrong week.
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const weekFromUrl = () => {
  try {
    const w = new URLSearchParams(window.location.search).get('week') || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : '';
  } catch { return ''; }
};

function Chip({ meta, children }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 700,
      color: meta.color, background: meta.tint || `${meta.color}14`, whiteSpace: 'nowrap' }}>
      {children || meta.label}
    </span>
  );
}

function Tile({ label, value, color }) {
  return (
    <div style={{ flex: '1 1 110px', minWidth: 110, padding: '10px 14px', borderRadius: 10, background: color, color: '#fff' }}>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11.5, marginTop: 5, opacity: 0.92 }}>{label}</div>
    </div>
  );
}

function ScoreBar({ score, thresholds }) {
  if (score == null) return <span style={{ color: NX.faint }}>-</span>;
  // The same cut-offs the server banded with, so the bar never disagrees with the chip.
  const onTrack = Number(thresholds?.onTrackPct ?? 95);
  const below = Number(thresholds?.belowPct ?? 70);
  const color = score >= onTrack ? BAND_META.on_track.color : score >= below ? BAND_META.below.color : BAND_META.well_below.color;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: NX.border2 || '#eef0f3', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, score)}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontWeight: 700, fontSize: 12.5, color, width: 38, textAlign: 'right' }}>{score}%</span>
    </div>
  );
}

function DayCells({ days }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6, padding: '10px 12px 12px', background: NX.surface2 }}>
      {days.map((d) => {
        const meta = DAY_META[d.status] || DAY_META.off;
        const flags = (d.flags || []).filter((f) => FLAG_LABEL[f]);
        return (
          <div key={d.date} style={{ border: `1px solid ${NX.border}`, borderRadius: 8, padding: '8px 9px', background: NX.surface, fontSize: 11.5, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, color: NX.ink }}>{d.weekday.slice(0, 3)}</span>
              <span style={{ color: NX.faint }}>{formatDate(d.date).slice(0, 5)}</span>
            </div>
            <div style={{ fontWeight: 700, color: meta.color }}>{meta.label}{d.late ? ' - Late' : ''}</div>
            <div style={{ color: NX.dim, marginTop: 3 }}>
              {d.workedMin ? `${hrs(d.workedMin)} worked` : d.leaveMin ? '' : (d.expectedMin ? 'No punch' : '')}
              {d.leaveMin ? `${d.workedMin ? ' + ' : ''}${hrs(d.leaveMin)} leave` : ''}
            </div>
            <div style={{ color: NX.faint, marginTop: 2 }}>
              {d.expectedMin ? `of ${hrs(d.expectedMin)}${d.shiftStart ? ` from ${formatHHMM(d.shiftStart)}` : ''}` : (d.reasonLabel || '')}
            </div>
            {flags.length > 0 && <div style={{ color: BAND_META.below.color, marginTop: 3 }}>{flags.map((f) => FLAG_LABEL[f]).join(', ')}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default function Scorecard() {
  const { inView, active } = useWorkforceView();
  // The REQUESTED week ('' = the server's default, the last complete week);
  // the week actually shown is data.weekStart, which the server normalizes
  // to the configured week start - never written back here, or every load
  // would fetch twice.
  const [week, setWeek] = useState(weekFromUrl);
  const [scope, setScope] = useState('team');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [band, setBand] = useState('');                    // '' = every band
  const [open, setOpen] = useState(() => new Set());
  const [mail, setMail] = useState({ busy: false, text: '', ok: true });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setErr('');
    api.getWorkforceScorecard({ ...(week ? { week_start: week } : {}), scope })
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) { setErr(e.message || String(e)); setData(null); } });
    return () => { live = false; };
  }, [week, scope, reloadKey]);

  const people = useMemo(() => (data?.people || []).filter((p) => inView(p.email)), [data, inView]);
  const shown = band ? people.filter((p) => p.band === band) : people;
  const counts = useMemo(() => {
    const c = { scored: 0, on_track: 0, below: 0, absent: 0, unscored: 0 };
    people.forEach((p) => {
      if (p.band === 'not_expected' || p.band === 'no_schedule') c.unscored += 1; else c.scored += 1;
      if (p.band === 'on_track') c.on_track += 1;
      if (p.band === 'below' || p.band === 'well_below') c.below += 1;
      if (p.band === 'absent') c.absent += 1;
    });
    return c;
  }, [people]);

  const toggle = (email) => setOpen((s) => { const n = new Set(s); n.has(email) ? n.delete(email) : n.add(email); return n; });
  const emailMe = async () => {
    setMail({ busy: true, text: '', ok: true });
    try {
      const r = await api.emailMeWorkforceScorecard(data?.weekStart || week, scope);
      setMail({ busy: false, ok: true, text: r.sent ? `Sent to ${r.to}.` : 'Nobody is on this scorecard, so there is nothing to send.' });
    } catch (e) { setMail({ busy: false, ok: false, text: e.message || String(e) }); }
  };

  if (err) return <div style={{ padding: 24, fontSize: 13, color: NX.red }}>{err}</div>;
  if (!data) return <LoadingState />;
  const t = data.thresholds || {};
  const std = data.standards || {};

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Trophy size={16} style={{ color: 'hsl(var(--color-green))' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Scorecard</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 8 }}>
          <button style={btn('ghost')} aria-label="Previous week" onClick={() => setWeek(addDays(data.weekStart, -7))}><ChevronLeft size={15} /></button>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 190, textAlign: 'center' }}>
            Week of {formatDate(data.weekStart)} - {formatDate(data.weekEnd)}
          </span>
          <button style={btn('ghost')} aria-label="Next week" onClick={() => setWeek(addDays(data.weekStart, 7))}><ChevronRight size={15} /></button>
        </div>
        <div style={{ flex: 1 }} />
        {data.canSeeCompany && (
          <div className="scroll-tabs" style={{ display: 'flex', gap: 2, border: `1px solid ${NX.border}`, borderRadius: 8, padding: 2 }}>
            {[['team', 'Direct Reports'], ['all', 'Everyone']].map(([k, lab]) => (
              <button key={k} onClick={() => setScope(k)} style={{ ...btn('ghost'), fontSize: 12, fontWeight: 600, padding: '4px 10px',
                background: scope === k ? 'var(--wk-brand-tint)' : 'transparent', color: scope === k ? NX.blue : NX.dim }}>{lab}</button>
            ))}
          </div>
        )}
        <button style={btn('ghost')} aria-label="Refresh" title="Refresh" onClick={() => setReloadKey((k) => k + 1)}><RefreshCw size={14} /></button>
        <button style={{ ...btn('outline'), opacity: mail.busy ? 0.6 : 1 }} disabled={mail.busy} onClick={emailMe}>
          <Mail size={14} /> {mail.busy ? 'Sending…' : 'Email Me This Report'}
        </button>
      </div>
      {mail.text && <div role="status" style={{ fontSize: 12.5, fontWeight: 600, color: mail.ok ? NX.green : NX.red, marginBottom: 10 }}>{mail.text}</div>}
      <ViewNotice shown={people.length} total={(data.people || []).length} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Tile label="Scored" value={counts.scored} color="#0f3d2e" />
        <Tile label="On Track" value={counts.on_track} color={BAND_META.on_track.color} />
        <Tile label="Below Expected" value={counts.below} color={BAND_META.below.color} />
        <Tile label="Absent All Week" value={counts.absent} color={BAND_META.absent.color} />
        <Tile label="Not Scored" value={counts.unscored} color={BAND_META.not_expected.color} />
      </div>

      <div className="scroll-tabs" style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {[['', 'All'], ...Object.entries(BAND_META).map(([k, m]) => [k, m.label])].map(([k, lab]) => {
          const n = k ? people.filter((p) => p.band === k).length : people.length;
          return (
            <button key={k || 'all'} onClick={() => setBand(k)} style={{ ...btn('ghost'), fontSize: 12, fontWeight: band === k ? 700 : 500,
              padding: '4px 10px', borderRadius: 999, border: `1px solid ${band === k ? NX.blue : NX.border}`, color: band === k ? NX.blue : NX.dim }}>
              {lab} ({n})
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', fontSize: 13, color: NX.faint, border: `1px dashed ${NX.border}`, borderRadius: 10 }}>
          {people.length === 0
            ? (active ? 'Nobody in this team view is on the scorecard for this week.'
              : scope === 'all' ? 'Nobody is on the scorecard for this week.'
                : data.scope === 'line'
                  ? 'Nobody in your reporting line is on the scorecard - hourly staff who report to you, directly or through others, appear here once they have started.'
                  : 'None of your direct reports are on the scorecard - hourly staff whose manager is you appear here once they have started.')
            : 'Nobody in this band.'}
        </div>
      ) : (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) repeat(3, minmax(60px, 0.7fr)) minmax(150px, 1.4fr) minmax(120px, 1fr) repeat(3, minmax(52px, 0.5fr)) 28px',
            gap: 8, padding: '8px 12px', background: NX.surface2, fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: NX.dim }}>
            <span>Person</span><span>Expected</span><span>Worked</span><span>Leave</span><span>Score</span><span>Status</span>
            <span title="Days with expected hours and no punch">Absent</span><span title="Days under expected hours">Short</span><span title="Clock-in after shift start + grace">Late</span><span />
          </div>
          {shown.map((p) => {
            const meta = BAND_META[p.band] || BAND_META.not_expected;
            const isOpen = open.has(p.email);
            return (
              <div key={p.email} style={{ borderTop: `1px solid ${NX.border2 || NX.border}` }}>
                <div role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => toggle(p.email)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(p.email); } }}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) repeat(3, minmax(60px, 0.7fr)) minmax(150px, 1.4fr) minmax(120px, 1fr) repeat(3, minmax(52px, 0.5fr)) 28px',
                    gap: 8, padding: '9px 12px', alignItems: 'center', fontSize: 12.5, cursor: 'pointer', background: isOpen ? meta.tint : 'transparent' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[p.jobTitle, p.managerName && `reports to ${p.managerName}`].filter(Boolean).join(' - ')}
                    </div>
                    {(p.missingPunches > 0 || p.activePct != null) && (
                      <div style={{ fontSize: 11.5, color: p.missingPunches ? BAND_META.below.color : NX.faint }}>
                        {[p.missingPunches ? `${p.missingPunches} missing punch${p.missingPunches === 1 ? '' : 'es'}` : '',
                          p.activePct != null ? `${p.activePct}% active at the computer` : ''].filter(Boolean).join(' - ')}
                      </div>
                    )}
                  </div>
                  <span>{hrs(p.expectedMin)}</span>
                  <span style={{ fontWeight: 600 }}>{hrs(p.workedMin)}</span>
                  <span style={{ color: p.leaveMin ? NX.ink : NX.faint }}>{p.leaveMin ? hrs(p.leaveMin) : '-'}</span>
                  <ScoreBar score={p.score} thresholds={t} />
                  <span><Chip meta={meta} /></span>
                  <span style={{ color: p.daysAbsent ? BAND_META.absent.color : NX.faint, fontWeight: p.daysAbsent ? 700 : 400 }}>{p.daysAbsent || '-'}</span>
                  <span style={{ color: p.daysShort ? BAND_META.below.color : NX.faint, fontWeight: p.daysShort ? 700 : 400 }}>{p.daysShort || '-'}</span>
                  <span style={{ color: p.daysLate ? BAND_META.below.color : NX.faint, fontWeight: p.daysLate ? 700 : 400 }}>{p.daysLate || '-'}</span>
                  <span style={{ color: NX.faint }}>{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                </div>
                {isOpen && <DayCells days={p.days || []} />}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 11.5, color: NX.faint, lineHeight: 1.5 }}>
        <Info size={13} style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          Expected hours come from each person's published shifts, else their shift preset, else the standard day
          ({Object.entries(std).filter(([k]) => k !== 'default').map(([k, v]) => `${k} ${v.hours}h`).join(', ')}) for full-time staff.
          Holidays and approved time off are excused; Sick / PTO punches count as leave. Score = hours covered / hours expected,
          On Track from {t.onTrackPct}%, Below Expected from {t.belowPct}%; a day within {t.shortToleranceMin} minutes of its target is full.
          Only days before each person's own today are scored. Click a row for the day-by-day breakdown.
        </div>
      </div>
    </div>
  );
}
