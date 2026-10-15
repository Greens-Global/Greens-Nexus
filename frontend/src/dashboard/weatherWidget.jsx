import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cloud, Wind, Droplets, Umbrella, SunMedium, Sunrise, Sunset, MapPin, Navigation, Search, RefreshCw, X,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { formatHHMM, formatTime, formatWeekday } from '../lib/datetime';
import { WEATHER_DEFAULT, sky, TONE } from './weatherLib';

// ── Weather widget (Neil, Sep 29: "a weather widget for the main screen ...
// people can add based on their location. make it great.") ────────────────
// Where: the person's own location (the browser asks once), or a city they
// pick. The forecast comes through our API (routers/weather.py - Open-Meteo,
// rounded to ~1 km before it leaves Nexus, cached 10 min).
//
// It grows with its tile: compact (temp + today's range), then details and a
// 12-hour strip, then the 7-day outlook with range bars. Tinted by the sky it
// shows - sun, night, cloud, rain, snow, storm - in both themes.

const HERE_KEY = 'nexus.weather.here';   // last known coords, so a revisit paints at once
const REFRESH_MS = 15 * 60 * 1000;
// A location prompt nobody answers never times out (the browser's own timeout
// only starts once permission is given), so after this long with no answer and
// nothing cached the tile offers the city picker instead of spinning forever.
const LOCATE_WAIT_MS = 10000;

// Content heights the layers need (desktop tile, inside the card padding):
// header ~19, now ~61, detail chips ~49, the 12-hour strip ~87, the sunrise /
// "Updated" footer ~17, 10px between each. Each tier shows only what fits -
// the shell clips, so a layer that does not fit is left out, never cut.
const MID_MIN_H = 160;      // header + now + details (~148)
const FOOTER_MIN_H = 185;   // ... + footer (~175)
const FULL_MIN_H = 285;     // ... + the hourly strip (~272)
const DAY_ROW_H = 27;

const deg = (v) => (v == null ? '-' : `${Math.round(v)}°`);
// "2026-09-28T20:00" (the place's own wall clock) -> "8 PM"
const hourLabel = (iso) => { const h = Number(iso.slice(11, 13)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
// The place's own wall clock ("2026-09-28T06:40") -> "6:40 AM", never moved
// into the viewer's zone.
const clock12 = (iso) => (iso ? formatHHMM(iso.slice(11, 16)) : '');
const dayLabel = (ymd, i) => (i === 0 ? 'Today' : formatWeekday(ymd, 'short'));
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (d) => (d == null ? '' : COMPASS[Math.round(d / 45) % 8]);

function readHere() {
  try {
    const v = JSON.parse(localStorage.getItem(HERE_KEY) || 'null');
    return v && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? v : null;
  } catch { return null; }
}
function saveHere(v) {
  try { localStorage.setItem(HERE_KEY, JSON.stringify(v)); } catch { /* private mode: fine */ }
}

// The browser's position, once per visit; resolves null when refused/unavailable.
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ error: 'unsupported' }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => resolve({ error: e?.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

// Size tiers off the tile itself, not the window - a 3-wide tile on a big
// monitor is still a small tile.
function useBox() {
  const ref = useRef(null);
  const [box, setBox] = useState({ w: 320, h: 300 });
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

export default function WeatherWidget({ config = {}, updateConfig, phone = false }) {
  const cfg = { ...WEATHER_DEFAULT, ...config };
  const units = cfg.units === 'metric' ? 'metric' : 'imperial';
  const [ref, box] = useBox();
  // "My location": state (the browser answers later). A picked city: derived.
  const [here, setHere] = useState(readHere);
  const pickedLat = cfg.place?.lat, pickedLon = cfg.place?.lon;
  const picked = useMemo(() => (cfg.mode === 'place' && cfg.place ? { ...cfg.place, fixed: true } : null),
    [cfg.mode, pickedLat, pickedLon]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = cfg.mode === 'place' ? picked : here;
  const [locErr, setLocErr] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [placeName, setPlaceName] = useState('');
  const [searching, setSearching] = useState(false);   // the picker has a query: give it the room

  // Resolve WHERE: a picked city is fixed; "my location" asks the browser.
  useEffect(() => {
    if (cfg.mode === 'place') return undefined;
    let live = true, answered = false;
    const wait = setTimeout(() => { if (live && !answered && !readHere()) setLocErr('pending'); }, LOCATE_WAIT_MS);
    locate().then((p) => {
      answered = true;
      clearTimeout(wait);
      if (!live) return;
      if (p.error) { if (!readHere()) setLocErr(p.error); return; }
      const next = { lat: p.lat, lon: p.lon };
      saveHere(next);
      setLocErr('');
      // Same ~1 km cell as the cached spot: keep it (no second fetch).
      setHere(w => (w && w.lat.toFixed(2) === next.lat.toFixed(2) && w.lon.toFixed(2) === next.lon.toFixed(2) ? w : next));
    });
    return () => { live = false; clearTimeout(wait); };
  }, [cfg.mode]);

  const load = useCallback(async () => {
    if (!where) return;
    setBusy(true);
    try {
      setData(await api.weather(where.lat, where.lon, units));
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Weather is unavailable right now.');
    } finally {
      setBusy(false);
    }
  }, [where, units]);

  useEffect(() => { load(); }, [load]);
  // Keep it current: every 15 minutes while the tab is visible, and on coming
  // back to it when a refresh was missed.
  useEffect(() => pollWhileVisible(load, REFRESH_MS), [load]);

  // A name for "my location" ("Escondido, CA"); a picked city carries its own.
  useEffect(() => {
    if (!where || where.fixed) return undefined;
    let live = true;
    api.weatherPlaceName(where.lat, where.lon).then((r) => { if (live) setPlaceName(r?.name || ''); }).catch(() => {});
    return () => { live = false; };
  }, [where]);

  const pickCity = (p) => {
    const place = { name: p.name, region: p.region, country: p.country, countryCode: p.countryCode, lat: p.lat, lon: p.lon };
    updateConfig?.({ mode: 'place', place });
  };

  const tier = box.h < MID_MIN_H || box.w < 250 ? 'compact' : box.h < FULL_MIN_H ? 'mid' : 'full';
  const showFooter = box.h >= FOOTER_MIN_H;
  // The outlook fills whatever height is left under now / details / hours /
  // footer - as many days as fit, up to seven - so a tile never shows a
  // blank band and never needs its own scrollbar.
  const dayRows = tier === 'full' ? Math.min(7, Math.floor((box.h - FULL_MIN_H - 10) / DAY_ROW_H)) : 0;
  const s = data ? sky(data.current.code, data.current.isDay) : null;
  const rgb = TONE[s?.tone || 'cloud'];
  const title = where?.fixed
    ? [where.name, where.countryCode === 'US' ? where.region : (where.country || where.region)].filter(Boolean).join(', ')
    : (placeName || 'Your Location');   // only ever set for "my location"

  const shell = (children) => (
    <div ref={ref} className="dash-card" aria-label="Weather"
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
        backgroundImage: data ? `linear-gradient(160deg, rgba(${rgb},0.16) 0%, rgba(${rgb},0.05) 55%, transparent 100%)` : undefined }}>
      {children}
    </div>
  );

  // ── No location yet: the browser refused / cannot / never answered, and
  // nothing cached. At 2x2 there are ~88px inside the card, so a small tile
  // drops the heading, says it in a few words, and hides even that while a
  // search is typed so the results have the room. ──
  if (!where && (locErr || cfg.mode === 'place')) {
    const small = box.h < MID_MIN_H || box.w < 250;
    const msg = locErr === 'denied'
      ? (small ? 'Location is off. Pick a city.' : 'Location is turned off for Nexus in this browser. Pick a city instead, or allow location and reload.')
      : locErr === 'pending'
        ? (small ? 'No location yet. Pick a city.' : 'Your browser has not shared your location yet. Pick a city instead, or answer its location prompt.')
        : 'Pick a city to see its weather.';
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: small ? 6 : 10, flex: 1, minHeight: 0 }}>
        {!small && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <MapPin size={16} style={{ color: 'var(--muted)' }} />
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Weather</div>
          </div>
        )}
        {!(small && searching) && (
          <div title={msg} style={{ fontSize: small ? 12 : 12.5, color: 'var(--muted)', lineHeight: 1.45, flexShrink: 0 }}>{msg}</div>
        )}
        <CityPicker onPick={pickCity} autoFocus={false} fill phone={phone} onSearching={setSearching} />
      </div>,
    );
  }

  if (!data) {
    return shell(err
      ? <ErrorState text={err} onRetry={load} busy={busy} />
      : <SkeletonBlocks count={tier === 'compact' ? 2 : 3} height={tier === 'compact' ? 28 : 44} />);
  }

  const c = data.current, t = data.today, u = data.units;
  const HeroIcon = s.Icon;
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {where.fixed ? <MapPin size={13} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} /> : <Navigation size={12} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} />}
      <span title={where.fixed ? title : `${title} - from your location`}
        style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      {/* A 36px target on a phone; the negative margin keeps the header line
          its desktop height so the size tiers still hold. */}
      <button type="button" onClick={load} disabled={busy} title="Refresh" aria-label="Refresh weather"
        style={{ border: 'none', background: 'none', cursor: busy ? 'default' : 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          ...(phone ? { width: 36, height: 36, padding: 0, margin: '-9px -10px -9px auto' } : { marginLeft: 'auto', padding: 2 }) }}>
        <RefreshCw size={12} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
      </button>
    </div>
  );

  // ── Compact: the glance ──
  if (tier === 'compact') {
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, height: '100%' }}>
        {header}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <HeroIcon size={34} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.6} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.text} · H {deg(t.high)} L {deg(t.low)}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  const hours = data.hourly || [];
  const days = data.daily || [];
  const lo = Math.min(...days.map(d => d.low)), hi = Math.max(...days.map(d => d.high));
  const span = Math.max(1, hi - lo);
  const chips = [
    { Icon: Wind, label: 'Wind', value: `${Math.round(c.wind ?? 0)} ${u.wind} ${compass(c.windDir)}`.trim() },
    { Icon: Droplets, label: 'Humidity', value: `${Math.round(c.humidity ?? 0)}%` },
    { Icon: Umbrella, label: 'Rain', value: `${Math.round(t.precipChance ?? 0)}%` },
    ...(box.w >= 380 ? [{ Icon: SunMedium, label: 'UV', value: t.uvMax == null ? '-' : `${Math.round(t.uvMax)}` }] : []),
  ];

  return shell(
    // The tiers above keep this inside the tile; overflow:auto is only the
    // backstop for a font or zoom that runs taller than measured. (Not
    // .dash-scroll: its card-colored edge covers would band the sky tint.)
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, height: '100%', overflowY: 'auto', scrollbarWidth: 'thin' }}>
      {header}

      {/* Now */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <HeroIcon size={48} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.5} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{s.text}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            Feels like {deg(c.feelsLike)} · H {deg(t.high)} · L {deg(t.low)}
          </div>
        </div>
      </div>

      {/* Details */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${chips.length}, minmax(0, 1fr))`, gap: 6 }}>
        {chips.map(({ Icon, label, value }) => (
          <div key={label} title={label}
            style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 10, padding: '6px 8px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <Icon size={11} /> {label}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Next 12 hours */}
      {tier === 'full' && hours.length > 0 && (
        // Its own quiet scroller - .scroll-tabs paints a paper band on phones.
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2, flexShrink: 0, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }} aria-label="Next 12 hours">
          {hours.map((h, i) => {
            const hs = sky(h.code, h.isDay);
            return (
              <div key={h.time} style={{ flex: '0 0 auto', minWidth: 46, textAlign: 'center', padding: '6px 4px', borderRadius: 10,
                background: i === 0 ? `rgba(${rgb},0.14)` : 'transparent' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{i === 0 ? 'Now' : hourLabel(h.time)}</div>
                <hs.Icon size={17} style={{ color: `rgb(${TONE[hs.tone]})`, margin: '4px auto 2px', display: 'block' }} strokeWidth={1.8} />
                <div style={{ fontSize: 12.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{deg(h.temp)}</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#2563eb', minHeight: 12 }}>{h.precipChance >= 20 ? `${h.precipChance}%` : ''}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 7 days with range bars - the week's lowest low to highest high */}
      {dayRows >= 2 && days.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }} aria-label="Daily forecast">
          {days.slice(0, dayRows).map((d, i) => {
            const ds = sky(d.code, true);
            const left = ((d.low - lo) / span) * 100, width = Math.max(4, ((d.high - d.low) / span) * 100);
            return (
              <div key={d.date} style={{ display: 'grid', gridTemplateColumns: '46px 22px 34px 1fr 34px', alignItems: 'center', gap: 6, padding: '4px 2px', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                <span style={{ fontSize: 12.5, fontWeight: i === 0 ? 800 : 600 }}>{dayLabel(d.date, i)}</span>
                <ds.Icon size={16} style={{ color: `rgb(${TONE[ds.tone]})` }} strokeWidth={1.8} />
                <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{deg(d.low)}</span>
                <span title={`${d.precipChance ?? 0}% chance of rain`} style={{ position: 'relative', height: 6, borderRadius: 99, background: 'var(--mist)' }}>
                  <span style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, borderRadius: 99,
                    background: 'linear-gradient(90deg, #38bdf8, #fbbf24 70%, #f97316)' }} />
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{deg(d.high)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Sun + freshness */}
      {showFooter && (
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap', flexShrink: 0 }}>
          {t.sunrise && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sunrise size={12} /> {clock12(t.sunrise)}</span>}
          {t.sunset && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sunset size={12} /> {clock12(t.sunset)}</span>}
          {data.fetchedAt && <span style={{ marginLeft: 'auto' }}>Updated {formatTime(data.fetchedAt)}</span>}
        </div>
      )}
    </div>,
  );
}

function ErrorState({ text, onRetry, busy }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
      <Cloud size={22} />
      <span>{text}</span>
      <button type="button" className="secondary-btn" onClick={onRetry} disabled={busy} style={{ fontSize: 12 }}>Try Again</button>
    </div>
  );
}

// City search - used in the widget's own "pick a city" state and in its
// Configure / Add dialog.
// `fill` (the tile's own picker): take the height that is left and scroll
// the results inside it, so they are never cut off by the tile's edge.
export function CityPicker({ onPick, autoFocus = true, fill = false, phone = false, onSearching }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const term = q.trim();
  const active = term.length >= 2;
  const shown = active ? rows : [];
  useEffect(() => { onSearching?.(active); }, [active, onSearching]);
  useEffect(() => {
    if (term.length < 2) return undefined;
    let live = true;
    const t = setTimeout(() => {
      setBusy(true);
      api.weatherPlaces(term).then((r) => { if (live) setRows(r?.places || []); })
        .catch(() => { if (live) setRows([]); })
        .finally(() => { if (live) setBusy(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, ...(fill ? { flex: 1 } : null) }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        {/* 16px on a phone so iOS does not zoom the page on focus. */}
        <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus}
          placeholder="Search for a city" aria-label="Search for a city" style={{ paddingLeft: 32, width: '100%', ...(phone ? { fontSize: 16 } : null) }} />
      </div>
      {(shown.length > 0 || (busy && active)) && (
        <div role="listbox" aria-label="Cities" className="dash-scroll"
          style={{ border: '1px solid var(--wk-line2)', borderRadius: 10, maxHeight: 180, background: 'var(--card)', flex: '0 1 auto', minHeight: 0 }}>
          {busy && shown.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--muted)' }}>Searching…</div>}
          {shown.map((r) => (
            <button key={`${r.lat},${r.lon}`} type="button" role="option" aria-selected="false" onClick={() => { onPick(r); setQ(''); setRows([]); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', minHeight: phone ? 40 : undefined, boxSizing: 'border-box', border: 'none', borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
              <MapPin size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {[r.region, r.country].filter(Boolean).join(', ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Add / Configure fields: where, and which units.
export function WeatherConfigFields({ config, onChange }) {
  const cfg = { ...WEATHER_DEFAULT, ...config };
  const lbl = { fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 };
  const opt = (on) => ({ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', border: `1px solid ${on ? 'hsl(var(--color-blue))' : 'var(--wk-line2)'}`,
    borderRadius: 10, cursor: 'pointer', background: on ? 'hsla(var(--color-blue),0.06)' : 'var(--card)', fontSize: 13 });
  const place = cfg.place;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <span style={lbl}>Location</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={opt(cfg.mode === 'here')}>
            <input type="radio" name="wx-mode" checked={cfg.mode === 'here'} onChange={() => onChange({ mode: 'here' })} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}><Navigation size={12} /> My Current Location</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Follows you - your browser asks once. Only an approximate position (about 1 km) is used.</span>
            </span>
          </label>
          <label style={opt(cfg.mode === 'place')}>
            <input type="radio" name="wx-mode" checked={cfg.mode === 'place'} onChange={() => onChange({ mode: 'place' })} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}><MapPin size={12} /> A City</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>An office, a job site, or wherever you like to keep an eye on.</span>
            </span>
          </label>
        </div>
        {cfg.mode === 'place' && (
          <div style={{ marginTop: 8 }}>
            {place ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', border: '1px solid var(--wk-line2)', borderRadius: 10 }}>
                <MapPin size={14} style={{ color: 'hsl(var(--color-blue))' }} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{place.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{[place.region, place.country].filter(Boolean).join(', ')}</span>
                <button type="button" onClick={() => onChange({ place: null })} aria-label="Choose a different city"
                  style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={14} /></button>
              </div>
            ) : (
              <CityPicker onPick={(r) => onChange({ place: { name: r.name, region: r.region, country: r.country, countryCode: r.countryCode, lat: r.lat, lon: r.lon } })} />
            )}
          </div>
        )}
      </div>
      <div>
        <span style={lbl}>Units</span>
        <div role="radiogroup" aria-label="Units" style={{ display: 'inline-flex', border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden' }}>
          {[['imperial', '°F · mph'], ['metric', '°C · km/h']].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={cfg.units === k} onClick={() => onChange({ units: k })}
              style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                background: cfg.units === k ? 'hsl(var(--color-blue))' : 'var(--card)', color: cfg.units === k ? '#fff' : 'var(--ink)' }}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
