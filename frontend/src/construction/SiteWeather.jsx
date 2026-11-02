// Construction - the weather at each jobsite (Neil, call of 10/30/2026).
//
// "When we're working on GS Temecula ... it should pull that address, it
// should pull that weather." The strip on the Construction Overview shows
// today at every active site at a glance - the sky, the temperature, the
// first wet hour, and a red flag when the Weather Watch thresholds, a 25 mph
// wind or a 95 F day say the work is at risk - and the card on a project
// shows that site's week with the full ten-day forecast a click away.
//
// Data: GET /construction/weather (one row per site, routers/construction.py)
// and GET /weather for a project's own card - both the widget's Open-Meteo
// cache, so a site costs one outbound call per ten minutes whoever looks.
import { useCallback, useEffect, useState } from 'react';
import { CloudSun, MapPin, Umbrella, Wind, Thermometer, AlertTriangle, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { formatDate, formatTime, formatWeekday } from '../lib/datetime';
import { sky, TONE, hourLabel, rainStart } from '../dashboard/weatherLib';
import { ForecastPopup } from '../dashboard/weatherWidget.jsx';
import { CARD } from './ui';

const REFRESH_MS = 15 * 60 * 1000;
const deg = (v) => (v == null ? '-' : `${Math.round(v)}°`);
const BLUE = '#2563eb', RED = 'hsl(var(--color-red))';

// The flag chip: what would stop the work, in the words a superintendent uses.
function FlagChip({ weather }) {
  const f = weather?.flag;
  if (!f) return null;
  const Icon = f === 'wind' ? Wind : f === 'heat' ? Thermometer : f === 'storm' ? AlertTriangle : Umbrella;
  const label = f === 'rain' ? 'Rain' : f === 'storm' ? 'Storms' : f === 'wind' ? 'Wind' : 'Heat';
  return (
    <span title={weather.flagDetail} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: '#fff', background: RED, borderRadius: 999, padding: '2px 8px' }}>
      <Icon size={11} /> {label}
    </span>
  );
}

// "Rain from 7 AM · 75%" / "Rain now · 75%" / "No rain expected"
function rainWords(w) {
  if (!w?.rainFrom) return 'No rain expected';
  const now = (w.current?.time || '').slice(0, 13);
  const at = w.rainFrom.slice(0, 13) <= now ? 'Rain now' : `Rain from ${hourLabel(w.rainFrom)}`;
  return w.rainChance != null ? `${at} · ${w.rainChance}%` : at;
}

// ── The strip on the Construction Overview ──────────────────────────────────
export function SiteWeatherStrip({ onOpen }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api.getConstructionWeather().then(setData).catch(() => setData({ sites: [], failed: true })), []);
  useEffect(() => pollWhileVisible(load, REFRESH_MS), [load]);
  useEffect(() => { load(); }, [load]);
  const sites = data?.sites || [];
  if (data && !sites.length) return null;   // no active jobsites: nothing to say
  return (
    <div style={CARD} aria-label="Weather at each site">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: 0 }}>Weather At Each Site</h3>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Today at every active jobsite - open a site for its week</span>
      </div>
      {data === null ? <SkeletonBlocks count={2} height={64} borderRadius={8} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {sites.map((s) => {
            const w = s.weather;
            const sk = w ? sky(w.current?.code, w.current?.isDay !== false) : null;
            const rgb = TONE[sk?.tone || 'cloud'];
            return (
              <button key={s.projectId} type="button" onClick={() => onOpen?.(s.projectId)} title={w ? `Open ${s.name}` : s.reason}
                style={{ textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', border: `1px solid ${w?.flag ? RED : 'var(--border-color)'}`, borderRadius: 10, padding: '10px 12px', background: w ? `linear-gradient(160deg, rgba(${rgb},0.14), transparent 70%)` : 'var(--bg-primary)', color: 'var(--text-primary)', display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', minWidth: 0 }}>
                {sk ? <sk.Icon size={30} style={{ color: `rgb(${rgb})` }} strokeWidth={1.6} /> : <MapPin size={24} style={{ color: 'var(--text-secondary)' }} />}
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    <FlagChip weather={w} />
                  </span>
                  {w ? (
                    <>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <b style={{ color: 'var(--text-primary)', fontSize: 15 }}>{deg(w.current?.temp)}</b> {sk.text} · H {deg(w.today?.high)} L {deg(w.today?.low)}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: w.rainFrom ? BLUE : 'var(--text-secondary)' }}>{rainWords(w)}</span>
                    </>
                  ) : (
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>{s.reason}</span>
                  )}
                </span>
                <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── The card on one project ─────────────────────────────────────────────────
export function SiteWeatherCard({ project }) {
  const has = !!(project.latitude && project.longitude);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    if (!has) return;
    api.weather(project.latitude, project.longitude, 'imperial').then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e?.message || 'Weather is unavailable right now.'));
  }, [has, project.latitude, project.longitude]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => pollWhileVisible(load, REFRESH_MS), [load]);

  if (!has) {
    return (
      <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }} aria-label="Site weather">
        <CloudSun size={22} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 600 }}>No weather for this site yet</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }}>
            {project.address ? 'Nexus is finding this address on the map; the weather appears once it has.' : 'Add the jobsite address and Nexus finds it on the map for its weather.'}
          </div>
        </div>
      </div>
    );
  }
  const c = data?.current, t = data?.today, days = data?.daily || [];
  const sk = data ? sky(c.code, c.isDay) : null;
  const rgb = TONE[sk?.tone || 'cloud'];
  const rain = data ? rainStart(data.hourly) : null;
  const lo = Math.min(...days.map((d) => d.low)), hi = Math.max(...days.map((d) => d.high)), span = Math.max(1, hi - lo);
  return (
    <div style={{ ...CARD, backgroundImage: data ? `linear-gradient(160deg, rgba(${rgb},0.12), transparent 60%)` : undefined }} aria-label="Site weather">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: 0 }}>Weather At This Site</h3>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><MapPin size={12} /> {project.address || `${project.latitude}, ${project.longitude}`}</span>
        {data && <button type="button" className="secondary-btn" style={{ marginLeft: 'auto', fontSize: 12.5 }} onClick={() => setOpen(true)}>Full Forecast</button>}
      </div>
      {err && !data ? <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{err}</div>
        : !data ? <SkeletonBlocks count={2} height={44} borderRadius={8} /> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
              <sk.Icon size={44} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.5} />
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em' }}>{deg(c.temp)}</span>
                  <span style={{ fontWeight: 700 }}>{sk.text}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>H {deg(t.high)} · L {deg(t.low)} · Wind {Math.round(c.wind ?? 0)} {data.units.wind}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: rain ? BLUE : 'var(--text-secondary)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Umbrella size={12} /> {rain ? (rain === data.hourly[0] ? 'Rain now' : `Rain from ${hourLabel(rain.time)}`) + (rain.precipChance != null ? ` · ${rain.precipChance}%` : '') : 'No rain expected today'}
                </div>
              </div>
            </div>
            <div aria-label="This week at the site">
              {days.slice(0, 5).map((d, i) => {
                const ds = sky(d.code, true);
                const left = ((d.low - lo) / span) * 100, width = Math.max(4, ((d.high - d.low) / span) * 100);
                return (
                  <div key={d.date} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1fr) 22px minmax(70px, 1.2fr) 64px 36px minmax(60px, 2fr) 36px', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: i ? '1px solid var(--border-color)' : 'none', fontSize: 12.5 }}>
                    <span style={{ fontWeight: i === 0 ? 800 : 600 }}>{i === 0 ? 'Today' : formatWeekday(d.date, 'short')} <span style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: 11.5 }}>{formatDate(d.date)}</span></span>
                    <ds.Icon size={16} style={{ color: `rgb(${TONE[ds.tone]})` }} strokeWidth={1.8} />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ds.text}</span>
                    <span style={{ fontWeight: 700, color: (d.precipChance ?? 0) >= 20 ? BLUE : 'var(--text-secondary)' }}>{(d.precipChance ?? 0) >= 20 ? `${d.precipChance}%` : 'Dry'}</span>
                    <span style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>{deg(d.low)}</span>
                    <span style={{ position: 'relative', height: 6, borderRadius: 99, background: 'var(--border-color)' }}>
                      <span style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, borderRadius: 99, background: 'linear-gradient(90deg, #38bdf8, #fbbf24 70%, #f97316)' }} />
                    </span>
                    <span style={{ fontWeight: 700 }}>{deg(d.high)}</span>
                  </div>
                );
              })}
            </div>
            {data.fetchedAt && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8 }}>Updated {formatTime(data.fetchedAt)}</div>}
            {open && <ForecastPopup title={project.name} data={data} onClose={() => setOpen(false)} />}
          </>
        )}
    </div>
  );
}
