import { useState } from 'react';
import { Link2, CheckCircle, AlertTriangle, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { metersBetween, googleMapsUrl } from '../lib/addressSearch';
import { Spinner } from './AsyncState';

// A location from its Google Maps link (Pranshu, Sep 30). The address search
// (OpenStreetMap) misses or misplaces many US addresses, so HR can paste the
// building's Google Maps link - or its coordinates - instead. The API reads
// the PLACE's own point out of the link (never the map view's centre, which
// can be hundreds of metres off) and opens short share links itself, so the
// geofence sits exactly where Google Maps shows the building. Since Oct 1 it
// is the ONLY way to place a location, and the API also returns the address
// the link points at, written the US way (site_address.py), plus a business
// name when the link names one - the form fills both from it.

const PRECISION = {
  place:       { ok: true,  label: 'Exact Place',   note: 'Taken from the place pinned in the link.' },
  pin:         { ok: true,  label: 'Exact Point',   note: 'Taken from the dropped pin in the link.' },
  coordinates: { ok: true,  label: 'Exact Point',   note: 'Taken from the coordinates you pasted.' },
  view:        { ok: false, label: 'Map View Only', note: 'This link only says where the map was looking, not a pinned place. Make sure the pin is on the building - or in Google Maps click the building first, then copy the link.' },
};
const FAR_MOVE_M = 1000;
const distText = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export default function WorkSiteLinkPanel({ link, point, savedPoint, onResolved }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(!link);

  async function resolve(value) {
    const v = (value ?? text).trim();
    if (!v || busy) return;
    setBusy(true); setError('');
    try {
      const r = await api.resolveWorkSiteLink(v);
      onResolved({ link: v, point: { lat: r.lat, lng: r.lng, precision: r.precision, label: r.label || '',
        address: r.address || '', placeName: r.placeName || '' } });
      setText(''); setHelp(false);
    } catch (e) {
      setError(e?.message || 'Could not read that link.');
    } finally { setBusy(false); }
  }

  const meta = point ? (PRECISION[point.precision] || PRECISION.coordinates) : null;
  const moved = point && savedPoint ? metersBetween(savedPoint, [point.lat, point.lng]) : 0;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Link2 size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="form-input" style={{ width: '100%', paddingLeft: 28, fontSize: 12.5 }} value={text}
            aria-label="Google Maps link or coordinates"
            placeholder={link ? 'Paste a new Google Maps link to move this location' : 'Paste the Google Maps link of the building'}
            onChange={e => { setText(e.target.value); setError(''); }}
            onPaste={e => { const v = e.clipboardData?.getData('text'); if (v && v.trim()) { e.preventDefault(); setText(v.trim()); resolve(v); } }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolve(); } }} />
        </div>
        <button type="button" className="secondary-btn" onClick={() => resolve()} disabled={busy || !text.trim()}
          style={{ padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          {busy ? <Spinner size={14} /> : <Link2 size={14} />} Use Link
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>Paste with Ctrl+V - it is read right away.</p>

      {error && (
        <div role="alert" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, color: 'hsl(var(--color-red))', margin: '8px 0 0', lineHeight: 1.45 }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{error}</span>
        </div>
      )}

      {point && meta && (
        <div data-testid="link-result" style={{ marginTop: 8, border: `1px solid ${meta.ok ? 'rgba(22,163,74,0.35)' : 'rgba(180,83,9,0.4)'}`, background: meta.ok ? 'rgba(22,163,74,0.06)' : 'rgba(180,83,9,0.07)', borderRadius: 10, padding: '9px 11px', fontSize: 12.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999,
              background: meta.ok ? 'rgba(22,163,74,0.14)' : 'rgba(180,83,9,0.14)', color: meta.ok ? '#15803d' : '#b45309' }}>
              {meta.ok ? <CheckCircle size={11} /> : <AlertTriangle size={11} />} {meta.label}
            </span>
            {(point.placeName || point.address) && (
              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                {point.placeName}{point.placeName && point.address ? ' - ' : ''}{point.address}
              </span>
            )}
          </div>
          <div style={{ color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>
            {meta.note} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{point.lat.toFixed(6)}, {point.lng.toFixed(6)}</span>
          </div>
          <a href={googleMapsUrl(point.lat, point.lng)} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 5, fontSize: 12, color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 }}>
            Check This Point in Google Maps <ExternalLink size={11} />
          </a>
          {savedPoint && moved >= 25 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6, fontSize: 12, color: moved >= FAR_MOVE_M ? 'hsl(var(--color-red))' : '#b45309', fontWeight: moved >= FAR_MOVE_M ? 700 : 500 }}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>This moves the location {distText(moved)} from where it is saved now.{moved >= FAR_MOVE_M ? ' Make sure it is the right building before saving.' : ''}</span>
            </div>
          )}
        </div>
      )}

      <button type="button" onClick={() => setHelp(h => !h)} aria-expanded={help}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8, padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
        {help ? <ChevronDown size={13} /> : <ChevronRight size={13} />} How to Copy the Link
      </button>
      {help && (
        <ol style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <li>Open <a href="https://www.google.com/maps" target="_blank" rel="noreferrer" style={{ color: 'var(--wk-brand, #2b45e1)' }}>Google Maps</a> and search the address.</li>
          <li>Click the building (or the spot where people punch in) so a red pin shows on it.</li>
          <li>Click <b>Share</b> - <b>Copy link</b>, then paste it here.</li>
          <li>Or right-click the exact spot and click the coordinates at the top of the menu to copy them.</li>
        </ol>
      )}
    </div>
  );
}
