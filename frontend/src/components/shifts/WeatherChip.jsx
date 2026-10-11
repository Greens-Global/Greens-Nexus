import { CloudRain, CloudLightning, TriangleAlert } from 'lucide-react';

// The weather band on a schedule day (Weather Call, Oct 2026). The API's
// `weather` rows are one per group and day, written by the half-hourly
// watch; the grid shows the worst band among the groups on screen. Quiet
// days carry nothing. Heads-up is blue, Major orange, a warning red.

export const BAND_RANK = { quiet: 0, heads_up: 1, major: 2, warning: 3 };
export const BAND_LABEL = { heads_up: 'Rain likely', major: 'Major rain', warning: 'Weather warning' };
const BAND_COLOR = { heads_up: 'hsl(var(--color-blue))', major: 'hsl(var(--color-orange))', warning: 'hsl(var(--color-red))' };

// { date: { band, chance, inches, storm, alerts, windowStart, windowEnd, groups: [names] } }
// for the groups in view (every group when none is a group row).
export function weatherByDay(rows = [], visibleGroupIds = null, groupNames = {}) {
  const out = {};
  rows.forEach((w) => {
    if (!w || !w.date || !BAND_RANK[w.band]) return;
    if (visibleGroupIds && visibleGroupIds.size && !visibleGroupIds.has(w.groupId)) return;
    const cur = out[w.date];
    const name = groupNames[w.groupId] || '';
    // The worst band's group comes first in groupIds: a click opens that one.
    if (!cur || BAND_RANK[w.band] > BAND_RANK[cur.band]) out[w.date] = { ...w, groups: [...(cur?.groups || []), name].filter(Boolean), groupIds: [w.groupId, ...(cur?.groupIds || [])] };
    else { cur.groups = [...cur.groups, name].filter(Boolean); cur.groupIds = [...cur.groupIds, w.groupId]; }
  });
  return out;
}

export function weatherText(w) {
  if (!w) return '';
  const head = w.band === 'warning' && w.alerts?.length ? w.alerts.join(', ') : w.storm ? 'Thunderstorms' : BAND_LABEL[w.band] || 'Rain';
  const when = w.windowStart && w.windowEnd ? ` during ${w.windowStart} - ${w.windowEnd}` : '';
  const who = w.groups?.length ? ` (${w.groups.join(', ')})` : '';
  return `${head}: ${w.chance}% chance, ${Number(w.inches || 0).toFixed(2)} in${when}${who}`;
}

export default function WeatherChip({ w, compact = false, size = 13, onClick = null }) {
  if (!w || !BAND_RANK[w.band]) return null;
  const Icon = w.band === 'warning' ? TriangleAlert : w.storm ? CloudLightning : CloudRain;
  const color = BAND_COLOR[w.band] || 'var(--muted)';
  const text = weatherText(w);
  const inner = (
    <>
      <Icon size={size} style={{ flexShrink: 0 }} />
      {!compact && <span style={{ fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{w.chance}%</span>}
    </>
  );
  const style = { display: 'inline-flex', alignItems: 'center', gap: 3, color, flexShrink: 0, lineHeight: 1 };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={text} aria-label={text} data-weather={w.band}
        style={{ ...style, border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>{inner}</button>
    );
  }
  return <span title={text} aria-label={text} role="img" data-weather={w.band} style={style}>{inner}</span>;
}
