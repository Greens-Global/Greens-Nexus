import { useEffect, useState } from 'react';
import { Users, AlertTriangle, CheckCircle } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';

// Fence check (Sep 30): before a site's point or radius is saved, how the last
// 30 days of punches near it would be judged - so a pin that would turn a
// crew's on-site punches into "Out of Location" shows up BEFORE it is saved,
// not on next week's timecards. Same rule as the time clock (GPS accuracy
// credit, rough fixes never inside). Only dots and counts, never names.

// `moved` = editing a saved site: compare with its saved fence (point or radius).
export default function WorkSiteFenceCheck({ lat, lng, radiusM, siteId = '', moved = false, onPoints }) {
  // The answer is kept with the question it answers: while it is for another
  // point/radius the panel shows it as checking (debounced 600 ms).
  const [result, setResult] = useState(null);   // { key, data } | { key, failed }
  const la = Number(lat), ln = Number(lng);
  const has = lat !== '' && lng !== '' && Number.isFinite(la) && Number.isFinite(ln);
  const r = Math.max(25, Number(radiusM) || 150);
  const key = has ? `${la},${ln},${r},${siteId}` : '';

  useEffect(() => {
    if (!key) { onPoints?.(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api.workSiteFenceCheck({ lat: la, lng: ln, radiusM: r, siteId })
        .then(d => { if (alive) { setResult({ key, data: d }); onPoints?.(d.points || []); } })
        .catch(() => { if (alive) { setResult({ key, failed: true }); onPoints?.(null); } });
    }, 600);
    return () => { alive = false; clearTimeout(t); };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!has) return null;
  const busy = result?.key !== key;
  const failed = !busy && !!result?.failed;
  const data = result?.data || null;
  const box = { marginTop: 10, border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.5 };
  if (!data) {
    return <div style={{ ...box, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
      {busy ? <><Spinner size={13} /> Checking recent punches at this spot...</> : failed ? 'Could not check recent punches right now.' : null}
    </div>;
  }
  const saved = data.savedInside;
  const lost = moved && saved != null ? saved - data.inside : 0;
  const gained = moved && saved != null ? data.inside - saved : 0;
  const outsideNear = data.near - data.inside;
  return (
    <div data-testid="fence-check" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--ink)' }}>
        <Users size={13} /> Punches Here, Last {data.days} Days {busy && <Spinner size={12} />}
      </div>
      {data.near === 0 ? (
        <div style={{ color: 'var(--muted)' }}>No punches near this spot in the last {data.days} days. The dots on the map will show them once people punch here.</div>
      ) : (
        <div style={{ color: 'var(--muted)' }}>
          <b style={{ color: '#15803d' }}>{data.inside}</b> punch{data.inside === 1 ? '' : 'es'} from {data.people} {data.people === 1 ? 'person' : 'people'} fall inside this fence
          {outsideNear > 0 && <>; <b style={{ color: 'hsl(var(--color-red))' }}>{outsideNear}</b> nearby fall outside it (red dots)</>}.
        </div>
      )}
      {lost > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4, color: 'hsl(var(--color-red))', fontWeight: 600 }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{lost} punch{lost === 1 ? '' : 'es'} inside the saved fence would become Out of Location with this change. Check the pin before saving.</span>
        </div>
      )}
      {gained > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4, color: '#15803d', fontWeight: 600 }}>
          <CheckCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{gained} more punch{gained === 1 ? '' : 'es'} count as on-site than with the saved fence.</span>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Past punches are rechecked against the saved fence on every timecard.</div>
    </div>
  );
}
