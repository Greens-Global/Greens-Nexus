import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Cloud, Wind, Droplets, Umbrella, SunMedium, Sunrise, Sunset, MapPin, Navigation, Search, RefreshCw, X, HardHat,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { formatDate, formatHHMM, formatTime, formatWeekday } from '../lib/datetime';
import { Modal } from '../tasks/components';
import { WEATHER_DEFAULT, sky, TONE, rainStart, hourLabel } from './weatherLib';

// ── Weather widget (Neil, Sep 29: "a weather widget for the main screen ...
// people can add based on their location. make it great.") ────────────────
// Where: the person's own location (the browser asks once), or a city they
// pick. The forecast comes through our API (routers/weather.py - Open-Meteo,
// rounded to ~1 km before it leaves Nexus, cached 10 min).
//
// It grows with its tile: compact (temp + today's range), then details and a
// 12-hour strip, then the 7-day outlook with range bars. Tinted by the sky it
// shows - sun, night, cloud, rain, snow, storm - in both themes.
//
// Oct 31 2026 (Neil's call of 10/30: "this is the weather today, the high
// low, if it is going to rain an icon of the rain ... click it, hourly for
// today ... and the 10 day"): the face says when rain starts ("Rain from
// 2 PM"), and the whole tile opens the Forecast popup - today hour by hour,
// then the next ten days with rain amount and wind. The tiers above stay.

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
// Wide (Neil, 11/13/2026: "it just doesn't show anything extra as the width
// expands but the height doesn't"): from this width the tile lays out side by
// side and the extra width carries the forecast - the week as day columns
// beside a short tile, beside the details on a medium one, the week's list
// beside the hours on a tall one. Phones and narrow tiles keep the stack.
const WIDE_MIN_W = 520;
const DAY_COL_W = 62;

const STRIP_FADE_END = 'linear-gradient(90deg, #000 calc(100% - 24px), transparent)';
const STRIP_FADE_BOTH = 'linear-gradient(90deg, transparent, #000 16px, #000 calc(100% - 28px), transparent)';

const deg = (v) => (v == null ? '-' : `${Math.round(v)}°`);
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

// The week as columns - day, sky, high, low, rain - for the wide layouts.
// `tight` (a short tile) keeps the day, sky and high only.
// `beside` (in a row): it takes the row's leftover width; under the hours it
// takes the column's width and only its own height.
function DayCols({ days, tight = false, beside = false }) {
  return (
    <div aria-label="Daily forecast" style={{ ...(beside ? { flex: 1 } : { flex: 'none', width: '100%' }), minWidth: 0, display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gap: 4 }}>
      {days.map((d, i) => {
        const ds = sky(d.code, true);
        return (
          <div key={d.date} title={`${ds.text} - ${d.precipChance ?? 0}% chance of rain`}
            style={{ textAlign: 'center', padding: tight ? '3px 2px' : '6px 2px', minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: i === 0 ? 800 : 700, color: i === 0 ? 'var(--ink)' : 'var(--muted)', whiteSpace: 'nowrap' }}>{dayLabel(d.date, i)}</div>
            <ds.Icon size={18} style={{ color: `rgb(${TONE[ds.tone]})`, margin: '4px auto 2px', display: 'block' }} strokeWidth={1.8} />
            <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{deg(d.high)}</div>
            {!tight && <div style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{deg(d.low)}</div>}
            {!tight && <div style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', minHeight: 12 }}>{(d.precipChance ?? 0) >= 20 ? `${d.precipChance}%` : ''}</div>}
          </div>
        );
      })}
    </div>
  );
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

// `phone` (the board is the phone stack): the tile is as tall as what it shows
// (`phoneFit: 'content'` in widgets.jsx), so it is laid out by the size it was
// given on the board - `size.h` - never by its own measured height, which on a
// phone is the content's. 2 rows or less: the glance; 3-4: the details, the
// hours and sunrise / sunset; 5 and up: the week as well.
const phoneLevel = (size) => { const h = size?.h ?? 4; return h <= 2 ? 1 : h <= 4 ? 2 : 3; };

export default function WeatherWidget({ config = {}, updateConfig, phone = false, size }) {
  const cfg = { ...WEATHER_DEFAULT, ...config };
  const units = cfg.units === 'metric' ? 'metric' : 'imperial';
  const [ref, box] = useBox();
  // "My location": state (the browser answers later). A picked city, or a
  // construction project (Neil, 10/30/2026 - "GS Temecula"): derived.
  const [here, setHere] = useState(readHere);
  const fixedPlace = cfg.mode === 'place' ? cfg.place : cfg.mode === 'project' ? cfg.project : null;
  const pickedLat = fixedPlace?.lat, pickedLon = fixedPlace?.lon;
  const picked = useMemo(() => (fixedPlace ? { ...fixedPlace, fixed: true } : null),
    [cfg.mode, pickedLat, pickedLon]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = cfg.mode === 'here' ? here : picked;
  const [locErr, setLocErr] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [placeName, setPlaceName] = useState('');
  const [searching, setSearching] = useState(false);   // the picker has a query: give it the room
  const [open, setOpen] = useState(false);              // the Forecast popup

  // Resolve WHERE: a picked city is fixed; "my location" asks the browser.
  useEffect(() => {
    if (cfg.mode !== 'here') return undefined;
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
  const wide = !phone && box.w >= WIDE_MIN_W;
  // The outlook fills whatever height is left under now / details / hours /
  // footer - as many days as fit, up to seven - so a tile never shows a
  // blank band and never needs its own scrollbar.
  const dayRows = tier === 'full' ? Math.min(7, Math.floor((box.h - FULL_MIN_H - 10) / DAY_ROW_H)) : 0;
  const s = data ? sky(data.current.code, data.current.isDay) : null;
  const rgb = TONE[s?.tone || 'cloud'];
  const title = where?.fixed
    ? (cfg.mode === 'project' ? where.name : [where.name, where.countryCode === 'US' ? where.region : (where.country || where.region)].filter(Boolean).join(', '))
    : (placeName || 'Your Location');   // only ever set for "my location"

  // With a forecast the whole tile is the way into the popup (Enter / Space
  // too); the Refresh button stops the click so it stays a refresh.
  const openable = !!data;
  const shell = (children) => (
    <div ref={ref} className="dash-card" aria-label="Weather"
      role={openable ? 'button' : undefined} tabIndex={openable ? 0 : undefined}
      title={openable ? 'Open the forecast' : undefined}
      onClick={openable ? () => setOpen(true) : undefined}
      onKeyDown={openable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } } : undefined}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
        cursor: openable ? 'pointer' : undefined,
        backgroundImage: data ? `linear-gradient(160deg, rgba(${rgb},0.16) 0%, rgba(${rgb},0.05) 55%, transparent 100%)` : undefined }}>
      {children}
      {open && data && <ForecastPopup title={title} data={data} onClose={() => setOpen(false)} />}
    </div>
  );

  // ── No location yet: the browser refused / cannot / never answered, and
  // nothing cached. At 2x2 there are ~88px inside the card, so a small tile
  // drops the heading, says it in a few words, and hides even that while a
  // search is typed so the results have the room. ──
  if (!where && (locErr || cfg.mode !== 'here')) {
    // A phone tile is as tall as what it shows, so it always has the room
    // for the whole sentence.
    const small = !phone && (box.h < MID_MIN_H || box.w < 250);
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
            <div style={{ fontSize: 13, fontWeight: 700 }}>Weather</div>
          </div>
        )}
        {!(small && searching) && (
          <div title={msg} style={{ fontSize: small ? 12 : 13, color: 'var(--muted)', lineHeight: 1.45, flexShrink: 0 }}>{msg}</div>
        )}
        <CityPicker onPick={pickCity} autoFocus={false} fill phone={phone} onSearching={setSearching} />
      </div>,
    );
  }

  if (!data) {
    return shell(err
      ? <ErrorState text={err} onRetry={load} busy={busy} />
      : <SkeletonBlocks count={(phone ? phoneLevel(size) === 1 : tier === 'compact') ? 2 : 3} height={(phone ? phoneLevel(size) === 1 : tier === 'compact') ? 28 : 44} />);
  }

  const c = data.current, t = data.today, u = data.units;
  const HeroIcon = s.Icon;
  const rain = rainStart(data.hourly);
  // "Rain now · 60%" / "Rain from 2 PM · 60%" - the one line a crew reads.
  const rainLine = rain && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: '#2563eb', minWidth: 0, maxWidth: '100%' }} aria-label="Rain">
      <Umbrella size={12} style={{ flexShrink: 0 }} />
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
        {rain === data.hourly[0] ? 'Rain now' : `Rain from ${hourLabel(rain.time)}`}{rain.precipChance != null ? ` · ${rain.precipChance}%` : ''}
      </span>
    </div>
  );
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {where.fixed ? <MapPin size={13} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} /> : <Navigation size={12} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} />}
      <span title={where.fixed ? title : `${title} - from your location`}
        style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      {/* A 36px target on a phone; the negative margin keeps the header line
          its desktop height so the size tiers still hold. */}
      <button type="button" onClick={(e) => { e.stopPropagation(); load(); }} disabled={busy} title="Refresh" aria-label="Refresh weather"
        style={{ border: 'none', background: 'none', cursor: busy ? 'default' : 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          ...(phone ? { width: 36, height: 36, padding: 0, margin: '-9px -10px -9px auto' } : { marginLeft: 'auto', padding: 2 }) }}>
        <RefreshCw size={12} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
      </button>
    </div>
  );

  const hours = data.hourly || [];
  const days = data.daily || [];
  const lo = Math.min(...days.map(d => d.low)), hi = Math.max(...days.map(d => d.high));
  const span = Math.max(1, hi - lo);

  // ── Compact: the glance ──
  if (!phone && tier === 'compact') {
    // Short but wide: the glance on the left, the week beside it.
    const cols = wide ? Math.min(7, days.length, Math.floor((box.w - 240) / DAY_COL_W)) : 0;
    if (cols >= 3) {
      return shell(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, height: '100%' }}>
          {header}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto', maxWidth: 220, minWidth: 0 }}>
              <HeroIcon size={34} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.6} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.text} · H {deg(t.high)} L {deg(t.low)}
                </div>
                {rainLine}
              </div>
            </div>
            <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)', flexShrink: 0 }} />
            <DayCols days={days.slice(0, cols)} tight={box.h < 120} beside />
          </div>
        </div>,
      );
    }
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, height: '100%' }}>
        {header}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          {box.w >= 190 && <HeroIcon size={34} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.6} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.text} · H {deg(t.high)} L {deg(t.low)}
            </div>
            {rainLine}
          </div>
        </div>
      </div>,
    );
  }

  // Side by side, the left column's width (the details live there).
  const leftW = tier === 'full' ? Math.max(280, Math.min(460, box.w * 0.52)) : Math.max(260, Math.min(380, box.w * 0.42));
  const chips = [
    { Icon: Wind, label: 'Wind', value: `${Math.round(c.wind ?? 0)} ${u.wind} ${compass(c.windDir)}`.trim() },
    { Icon: Droplets, label: 'Humidity', value: `${Math.round(c.humidity ?? 0)}%` },
    { Icon: Umbrella, label: 'Rain', value: `${Math.round(t.precipChance ?? 0)}%` },
    ...((phone || wide ? (phone ? box.w : leftW) : box.w) >= 300 ? [{ Icon: SunMedium, label: 'UV', value: t.uvMax == null ? '-' : `${Math.round(t.uvMax)}` }] : []),
  ];

  // The pieces, shared by the stacked and the wide layouts.
  const nowEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <HeroIcon size={48} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.5} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{s.text}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Feels like {deg(c.feelsLike)} · H {deg(t.high)} · L {deg(t.low)}</span>
          {rainLine}
        </div>
      </div>
    </div>
  );
  const detailsEl = (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${chips.length}, minmax(0, 1fr))`, gap: 10, padding: '2px 0' }}>
      {chips.map(({ Icon, label, value }) => (
        <div key={label} title={label} style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
            <Icon size={12} style={{ flexShrink: 0 }} /> {label}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
        </div>
      ))}
    </div>
  );
  // The next hours (the API sends a day; the strip scrolls) - its own quiet
  // scroller (.scroll-tabs paints a paper band on phones).
  const hoursEl = hours.length > 0 && (
      // The strip fades out at its edge, so an hour that runs under it reads
      // as "more this way", not as a column cut in half. On a phone it runs
      // out to the card's edges (the phone card's 16px padding) like a native strip.
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2, flexShrink: 0, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
        ...(phone
          ? { margin: '0 -16px', padding: '0 16px 2px', scrollPaddingInline: 16, maskImage: STRIP_FADE_BOTH, WebkitMaskImage: STRIP_FADE_BOTH }
          : { maskImage: STRIP_FADE_END, WebkitMaskImage: STRIP_FADE_END }) }} aria-label="Hourly">
        {hours.map((h, i) => {
          const hs = sky(h.code, h.isDay);
          return (
            <div key={h.time} style={{ flex: '0 0 auto', minWidth: 46, textAlign: 'center', padding: '6px 4px' }}>
              <div style={{ fontSize: 11, fontWeight: i === 0 ? 800 : 700, color: i === 0 ? 'var(--ink)' : 'var(--muted)', whiteSpace: 'nowrap' }}>{i === 0 ? 'Now' : hourLabel(h.time)}</div>
              <hs.Icon size={17} style={{ color: `rgb(${TONE[hs.tone]})`, margin: '4px auto 2px', display: 'block' }} strokeWidth={1.8} />
              <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{deg(h.temp)}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', minHeight: 12 }}>{h.precipChance >= 20 ? `${h.precipChance}%` : ''}</div>
            </div>
          );
        })}
      </div>
  );
  // The week with range bars - its lowest low to highest high.
  const dayList = (rows) => rows >= 2 && days.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }} aria-label="Daily forecast">
        {days.slice(0, rows).map((d, i) => {
          const ds = sky(d.code, true);
          const left = ((d.low - lo) / span) * 100, width = Math.max(4, ((d.high - d.low) / span) * 100);
          return (
            <div key={d.date} style={{ display: 'grid', gridTemplateColumns: '46px 22px 34px 1fr 34px', alignItems: 'center', gap: 6, padding: '4px 2px', borderTop: i ? '1px solid var(--line)' : 'none' }}>
              <span style={{ fontSize: 13, fontWeight: i === 0 ? 800 : 600 }}>{dayLabel(d.date, i)}</span>
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
  );
  // Sun + freshness.
  const footerEl = (
      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap', flexShrink: 0 }}>
        {t.sunrise && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sunrise size={12} /> {clock12(t.sunrise)}</span>}
        {t.sunset && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sunset size={12} /> {clock12(t.sunset)}</span>}
        {data.fetchedAt && <span style={{ marginLeft: 'auto' }}>Updated {formatTime(data.fetchedAt)}</span>}
      </div>
  );

  // ── Phone: content-sized, by the size the tile has on the board ──
  // Tight the way a phone's own weather widget is (11/17/2026): the
  // details are one quiet line, whole facts wrapping between them, and the
  // sunrise / "Updated" footer is left to the Forecast popup a tap away.
  if (phone) {
    const level = phoneLevel(size);
    const facts = [
      `Wind ${Math.round(c.wind ?? 0)} ${u.wind} ${compass(c.windDir)}`.trim(),
      `Humidity ${Math.round(c.humidity ?? 0)}%`,
      t.uvMax != null && `UV ${Math.round(t.uvMax)}`,
    ].filter(Boolean);
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        {header}
        {nowEl}
        {level >= 2 && (
          <div aria-label="Details" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', fontSize: 13, color: 'var(--muted)' }}>
            {facts.map((f) => <span key={f} style={{ whiteSpace: 'nowrap' }}>{f}</span>)}
          </div>
        )}
        {level >= 2 && hoursEl}
        {level >= 3 && dayList(Math.min(7, days.length))}
      </div>,
    );
  }

  // ── Wide: side by side, the extra width carrying the forecast ──
  if (wide) {
    const full = tier === 'full';
    const cols = Math.min(7, days.length, Math.floor((box.w - leftW - 24) / DAY_COL_W));
    return shell(
      <div style={{ display: 'flex', gap: 18, minHeight: 0, height: '100%' }}>
        <div style={{ flex: `0 0 ${Math.round(leftW)}px`, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', scrollbarWidth: 'thin' }}>
          {header}
          {nowEl}
          {detailsEl}
          {full && hoursEl}
          {showFooter && footerEl}
        </div>
        <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: full ? 'flex-start' : 'center', overflow: 'hidden' }}>
          {full
            ? dayList(Math.min(7, Math.floor(box.h / (DAY_ROW_H + 2))))
            : (<>
                {box.h >= 200 && hoursEl}
                {cols >= 2 && <DayCols days={days.slice(0, cols)} />}
              </>)}
        </div>
      </div>,
    );
  }

  return shell(
    // The tiers above keep this inside the tile; overflow:auto is only the
    // backstop for a font or zoom that runs taller than measured. (Not
    // .dash-scroll: its card-colored edge covers would band the sky tint.)
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, height: '100%', overflowY: 'auto', scrollbarWidth: 'thin' }}>
      {header}
      {nowEl}
      {detailsEl}
      {tier === 'full' && hoursEl}
      {dayList(dayRows)}
      {showFooter && footerEl}
    </div>,
  );
}

// The Forecast popup (Neil, 10/30/2026): today hour by hour, then the next
// ten days - each with its sky, the chance and amount of rain and the wind,
// the facts a crew plans a work window on. Read only; the tile's refresh
// keeps it current.
//
// 11/17/2026 (Neil: "still getting a little cropped when you click on it"):
// a day's row needed ~590px, so on a phone - and in any sheet narrower than
// that - the high, its range bar and the wind ran off the right edge. The
// rows now read the popup's OWN width (not the window's: a landscape phone
// gets a centered card, a desktop a 60% sheet): from WIDE_ROW_W a day is one
// line; below it, two - the day and its range, then the date, sky, rain and
// wind in words. No rectangles (Neil, 11/17/2026): no tinted panel behind
// "now", no box per hour, no uppercase eyebrows - type, space and hairlines.
const WIDE_ROW_W = 620;
const sectionHead = { fontSize: 15, fontWeight: 700, color: 'var(--ink)', margin: '0 0 10px' };
const rainInk = '#2563eb';

// The width of an element, measured before paint so the first frame is
// already the right layout, and kept current as it resizes.
function useWidth(initial = 0) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const now = el.getBoundingClientRect().width;
    if (now > 0) setW(now);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => { if (e.contentRect.width > 0) setW(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function ForecastPopup({ title, data, onClose }) {
  const c = data.current, t = data.today, u = data.units;
  const s = sky(c.code, c.isDay);
  const hours = data.hourly || [];
  const days = data.daily || [];
  const lo = Math.min(...days.map((d) => d.low)), hi = Math.max(...days.map((d) => d.high));
  const span = Math.max(1, hi - lo);
  const rgb = TONE[s.tone];
  const amount = (v) => (v == null || v < 0.005 ? '' : `${v < 1 ? v.toFixed(2).replace(/^0/, '') : v.toFixed(1)} ${u.precip}`);
  const rain = rainStart(hours);
  const [boxRef, width] = useWidth();
  // The rain lines under each hour are kept only on a day that has rain in
  // it, so a dry day's rows sit close and a wet day's rows all line up.
  const anyRain = hours.some((h) => (h.precipChance ?? 0) >= 20 || amount(h.precip));
  const wideRows = width >= WIDE_ROW_W;
  const facts = [
    `Wind ${Math.round(c.wind ?? 0)} ${u.wind} ${compass(c.windDir)}`.trim(),
    `Humidity ${Math.round(c.humidity ?? 0)}%`,
    t.uvMax != null && `UV ${Math.round(t.uvMax)}`,
    t.sunrise && `Sunrise ${clock12(t.sunrise)}`,
    t.sunset && `Sunset ${clock12(t.sunset)}`,
  ].filter(Boolean);
  // "70% · .45 in" when rain is in it, else "Dry".
  const dayRain = (d) => {
    const pct = d.precipChance ?? 0, amt = amount(d.precipSum);
    return pct >= 20 || amt ? { wet: pct >= 20, text: `${pct}%${amt ? ` · ${amt}` : ''}` } : { wet: false, text: 'Dry' };
  };
  const bar = (d) => {
    const left = ((d.low - lo) / span) * 100, w = Math.max(4, ((d.high - d.low) / span) * 100);
    return (
      <span aria-hidden="true" style={{ position: 'relative', height: 6, borderRadius: 99, background: 'var(--mist)', minWidth: 0 }}>
        <span style={{ position: 'absolute', left: `${left}%`, width: `${w}%`, top: 0, bottom: 0, borderRadius: 99, background: 'linear-gradient(90deg, #38bdf8, #fbbf24 70%, #f97316)' }} />
      </span>
    );
  };
  const num = { fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
  return (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Modal title={`Forecast - ${title}`} onClose={onClose}>
        <div ref={boxRef} style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          {/* Now */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <s.Icon size={48} style={{ color: `rgb(${rgb})`, flexShrink: 0 }} strokeWidth={1.5} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 32, fontWeight: 800, lineHeight: 1, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{deg(c.temp)}</span>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{s.text}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>H {deg(t.high)} · L {deg(t.low)} · Feels like {deg(c.feelsLike)}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: rain ? rainInk : 'var(--muted)' }}>
              <Umbrella size={14} style={{ flexShrink: 0 }} />
              {rain ? `${rain === hours[0] ? 'Rain now' : `Rain from ${hourLabel(rain.time)}`}${rain.precipChance != null ? ` · ${rain.precipChance}%` : ''}` : 'No rain expected today'}
            </div>
            {/* Each fact whole on its line: a wrap falls between them, never inside one. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 13, color: 'var(--muted)' }}>
              {facts.map((f) => <span key={f} style={{ whiteSpace: 'nowrap' }}>{f}</span>)}
            </div>
          </div>

          {/* Today, hour by hour */}
          {hours.length > 0 && (
            <div>
              <h3 style={sectionHead}>Today, Hour By Hour</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))', columnGap: 4, rowGap: 14 }} aria-label="Today, hour by hour">
                {hours.map((h, i) => {
                  const hs = sky(h.code, h.isDay);
                  return (
                    <div key={h.time} style={{ textAlign: 'center', minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: i === 0 ? 800 : 600, color: i === 0 ? 'var(--ink)' : 'var(--muted)' }}>{i === 0 ? 'Now' : hourLabel(h.time)}</div>
                      <hs.Icon size={18} style={{ color: `rgb(${TONE[hs.tone]})`, margin: '6px auto 4px', display: 'block' }} strokeWidth={1.8} />
                      <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{deg(h.temp)}</div>
                      {anyRain && <div style={{ fontSize: 11, fontWeight: 600, color: rainInk, minHeight: 14 }}>{(h.precipChance ?? 0) >= 20 ? `${h.precipChance}%` : ''}</div>}
                      {anyRain && <div style={{ fontSize: 11, color: 'var(--muted)', minHeight: 14 }}>{amount(h.precip)}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* The next ten days */}
          {days.length > 0 && (
            <div>
              <h3 style={sectionHead}>Next {days.length} Days</h3>
              <div style={{ display: 'flex', flexDirection: 'column' }} aria-label="Next 10 Days">
                {days.map((d, i) => {
                  const ds = sky(d.code, true);
                  const r = dayRain(d);
                  const dayName = <span style={{ fontSize: 13, fontWeight: i === 0 ? 800 : 600, whiteSpace: 'nowrap' }}>{dayLabel(d.date, i)}</span>;
                  const icon = <ds.Icon size={18} style={{ color: `rgb(${TONE[ds.tone]})` }} strokeWidth={1.8} aria-hidden="true" />;
                  const wind = d.windMax != null ? `Wind ${Math.round(d.windMax)} ${u.wind}` : '';
                  const rowBase = { padding: '10px 0', borderTop: i ? '1px solid var(--line)' : 'none', minWidth: 0 };
                  if (wideRows) {
                    return (
                      <div key={d.date} style={{ ...rowBase, display: 'grid', gridTemplateColumns: 'minmax(124px, 1.2fr) 22px minmax(0, 1.3fr) 96px 36px minmax(60px, 2fr) 36px 76px', alignItems: 'center', columnGap: 10 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{dayName} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(d.date)}</span></span>
                        {icon}
                        <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ds.text}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: r.wet ? rainInk : 'var(--muted)', whiteSpace: 'nowrap' }}>{r.text}</span>
                        <span style={{ ...num, color: 'var(--muted)' }}>{deg(d.low)}</span>
                        {bar(d)}
                        <span style={{ ...num, fontWeight: 700, textAlign: 'left' }}>{deg(d.high)}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>{d.windMax != null ? `${Math.round(d.windMax)} ${u.wind}` : ''}</span>
                      </div>
                    );
                  }
                  // Two lines: the day and its range, then the rest in words.
                  return (
                    <div key={d.date} style={{ ...rowBase, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 22px 34px minmax(56px, 104px) 34px', alignItems: 'center', columnGap: 8, rowGap: 3 }}>
                      {dayName}
                      {icon}
                      <span style={{ ...num, color: 'var(--muted)' }}>{deg(d.low)}</span>
                      {bar(d)}
                      <span style={{ ...num, fontWeight: 700 }}>{deg(d.high)}</span>
                      {/* Each fact stays whole: a narrow phone wraps between them. */}
                      <span style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, minWidth: 0 }}>
                        {[
                          <span key="d">{formatDate(d.date)}</span>,
                          <span key="s">{ds.text}</span>,
                          <span key="r" style={{ color: r.wet ? rainInk : undefined, fontWeight: r.wet ? 700 : undefined }}>{r.text === 'Dry' ? 'Dry' : `${ds.tone === 'snow' ? 'Snow' : 'Rain'} ${r.text}`}</span>,
                          wind && <span key="w">{wind}</span>,
                        ].filter(Boolean).map((el, k) => (
                          // The space before the dot sits outside the unbreakable span: that is where a line may break.
                          <Fragment key={el.key}>{k > 0 && ' '}<span style={{ whiteSpace: 'nowrap' }}>{k > 0 && '· '}{el}</span></Fragment>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {data.fetchedAt && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Updated {formatTime(data.fetchedAt)} · Open-Meteo</div>}
        </div>
      </Modal>
    </div>
  );
}

function ErrorState({ text, onRetry, busy }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
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
          placeholder="Search for a city" aria-label="Search for a city" style={{ paddingLeft: 32, width: '100%', ...(phone ? { fontSize: /* type-ok: iOS zooms a field under 16px */ 16 } : null) }} />
      </div>
      {(shown.length > 0 || (busy && active)) && (
        <div role="listbox" aria-label="Cities" className="dash-scroll"
          style={{ border: '1px solid var(--wk-line2)', borderRadius: 10, maxHeight: 180, background: 'var(--card)', flex: '0 1 auto', minHeight: 0 }}>
          {busy && shown.length === 0 && <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--muted)' }}>Searching…</div>}
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

// The construction projects the person may see that have a map point - the
// address placed by the server (construction_weather.py).
function ProjectPicker({ onPick }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    (api.getConstructionProjects?.() || Promise.resolve([]))
      .then((list) => { if (live) setRows((list || []).filter((p) => p.latitude && p.longitude && !p.archived && (p.status || 'active') === 'active')); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);
  if (rows === null) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading projects…</div>;
  if (!rows.length) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>No active construction project you can see has a map point yet. Add the jobsite address in Construction and it appears here.</div>;
  return (
    <div role="listbox" aria-label="Construction projects" className="dash-scroll" style={{ border: '1px solid var(--wk-line2)', borderRadius: 10, maxHeight: 180, background: 'var(--card)' }}>
      {rows.map((p) => (
        <button key={p.id} type="button" role="option" aria-selected="false" onClick={() => onPick({ id: p.id, name: p.name, address: p.address || '', lat: p.latitude, lon: p.longitude })}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', boxSizing: 'border-box', border: 'none', borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
          <MapPin size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address}</span>
        </button>
      ))}
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
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>An office, or wherever you like to keep an eye on.</span>
            </span>
          </label>
          <label style={opt(cfg.mode === 'project')}>
            <input type="radio" name="wx-mode" checked={cfg.mode === 'project'} onChange={() => onChange({ mode: 'project' })} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}><HardHat size={12} /> A Construction Project</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>The weather at that jobsite's address, however far away it is.</span>
            </span>
          </label>
        </div>
        {cfg.mode === 'project' && (
          <div style={{ marginTop: 8 }}>
            {cfg.project ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', border: '1px solid var(--wk-line2)', borderRadius: 10 }}>
                <MapPin size={14} style={{ color: 'hsl(var(--color-blue))' }} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{cfg.project.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.project.address}</span>
                <button type="button" onClick={() => onChange({ project: null })} aria-label="Choose a different project"
                  style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={14} /></button>
              </div>
            ) : <ProjectPicker onPick={(p) => onChange({ project: p })} />}
          </div>
        )}
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
              style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                background: cfg.units === k ? 'hsl(var(--color-blue))' : 'var(--card)', color: cfg.units === k ? '#fff' : 'var(--ink)' }}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
