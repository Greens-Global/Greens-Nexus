import { useState } from 'react';
import { MapPin, ChevronDown } from 'lucide-react';
import { Card } from '../shared/Card.jsx';
import { snapMap } from '../../lib/format.js';

/**
 * Build a clean "Street, City, State Zip" search string from an asset's address fields.
 * Strips redundant city/county mentions that are sometimes duplicated inside the free-text
 * `address` line itself (e.g. address="123 Main St, Springfield" + city="Springfield"),
 * and back-fills state/zip from the address text if they're missing as separate fields.
 */
function formatAddressForSearch(asset) {
  const city = String(asset.city || '').replace(/^\s*(city|town|county)\s+of\s+/i, '').trim();
  let state = String(asset.state || '').trim();
  let zip = String(asset.zip || '').trim();
  const cityLower = city.toLowerCase();
  const rawAddress = String(asset.address || '').trim();

  if (!zip) {
    const m = rawAddress.match(/\b([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?\b/);
    if (m) {
      zip = m[2];
      state ||= m[1].toUpperCase();
    }
  }

  // A segment of the comma-split address is "redundant" if it's just the county, the
  // state+zip, or a restatement of the city — those get dropped from the street portion.
  const isRedundantSegment = (segment) => {
    const lower = segment.toLowerCase();
    return !!(
      /^county\s+of\s+/i.test(segment) ||
      /\bcounty$/i.test(segment) ||
      /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(segment) ||
      (state && lower === state.toLowerCase()) ||
      (zip && lower === zip) ||
      (cityLower && (lower === cityLower || lower === `city of ${cityLower}` || lower === `town of ${cityLower}`))
    );
  };

  const segments = rawAddress.split(',').map((s) => s.trim()).filter(Boolean);
  const cityIndex = segments.findIndex((segment) => {
    const lower = segment.toLowerCase();
    return cityLower && (lower === cityLower || lower === `city of ${cityLower}` || lower === `town of ${cityLower}`);
  });
  const street = (cityIndex >= 0 ? segments.slice(0, cityIndex) : segments)
    .filter((segment) => !isRedundantSegment(segment))
    .join(', ')
    .replace(/^(\d+[a-z]?),\s+/i, '$1 ')
    .trim();

  return [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || street;
}

/** Append " County" to a county name if it isn't already suffixed with it. Empty-safe. */
function withCountySuffix(county) {
  const s = String(county ?? '').trim();
  if (!s) return '';
  return /county$/i.test(s) ? s : s + ' County';
}

/** Convert a pasted Google Maps URL into an embeddable `/maps?...&output=embed` iframe src. */
function toEmbedUrl(url) {
  if (url.includes('/maps/embed')) return url;

  const atCoords = url.match(/@(-?\d[\d.]*),(-?\d[\d.]*)/);
  if (atCoords) return `https://www.google.com/maps?q=${atCoords[1]},${atCoords[2]}&z=16&output=embed`;

  const queryParam = url.match(/[?&](?:q|query)=([^&]+)/);
  if (queryParam) return `https://www.google.com/maps?q=${queryParam[1]}&output=embed`;

  const placeIndex = url.indexOf('/maps/place/');
  if (placeIndex >= 0) {
    const placeName = url.slice(placeIndex + 12).split('@')[0].split('/')[0].split('?')[0];
    if (placeName) return `https://www.google.com/maps?q=${placeName}&output=embed`;
  }

  return '';
}

/**
 * Per-asset embedded map card: shows a Google Maps preview (iframe) plus "Open in Google
 * Maps" / expand-to-fullscreen actions. Prefers an exact pin from a pasted Google Maps link
 * (`p.mapUrl`, or the "Google Maps Link" snapshot field for records that predate the
 * top-level field); falls back to a plain address search when no link is on file.
 *
 * Props: `p` — the asset record. `n` — optional number shown in a small badge in the header
 * (used when this card is one of several numbered sections on the page). `onSave` — optional;
 * when provided, an editable "paste a link" input is shown and committed on blur.
 */
export function PropertyMapLink({ p: asset, n: number, onSave }) {
  const searchText = [formatAddressForSearch(asset), asset.county ? withCountySuffix(asset.county) : ''].filter(Boolean).join(', ');
  const searchQuery = encodeURIComponent(searchText || asset.name || '');
  const customLink = (asset.mapUrl || snapMap(asset)['google maps link'] || '').trim();

  const customEmbedUrl = customLink ? toEmbedUrl(customLink) : '';
  const embedUrl = customEmbedUrl || `https://www.google.com/maps?q=${searchQuery}&output=embed`;
  const openUrl = customLink || `https://www.google.com/maps/search/?api=1&query=${searchQuery}`;
  const hasLocation = !!(searchText || customLink);

  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <Card>
      <div
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse' : 'Expand'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          cursor: 'pointer',
          userSelect: 'none',
          marginBottom: open ? 14 : 0,
          paddingBottom: open ? 10 : 0,
          borderBottom: open ? '1px solid var(--border-color)' : 'none',
        }}
      >
        {number != null && (
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#fff',
              backgroundColor: 'var(--pine)',
            }}
          >
            {number}
          </span>
        )}
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Map</strong>
        {customLink && open && (
          <span
            style={{
              fontSize: '0.66rem',
              fontWeight: 700,
              color: 'hsl(var(--color-green))',
              backgroundColor: 'hsl(var(--color-green) / 0.12)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            EXACT PIN
          </span>
        )}
        <ChevronDown
          size={18}
          style={{
            marginLeft: 'auto',
            color: 'var(--text-secondary)',
            transition: 'transform 0.2s',
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        />
      </div>

      {open && onSave && (
        <input
          className="form-input"
          defaultValue={customLink}
          placeholder="Paste a Google Maps link…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
          }}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value !== customLink) onSave({ 'Google Maps Link': value });
          }}
          style={{ width: '100%', fontSize: '0.76rem', padding: '5px 10px', marginBottom: 10 }}
        />
      )}

      {open && (hasLocation ? (
        <>
          <iframe
            title="Property map"
            src={embedUrl}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            style={{ width: '100%', height: 380, border: '1px solid var(--border-color)', borderRadius: 10, display: 'block' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <a
              href={openUrl}
              target="_blank"
              rel="noreferrer"
              className="secondary-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', fontSize: '0.78rem', padding: '5px 12px' }}
            >
              <MapPin size={14} />
              Open in Google Maps
            </a>
            <button className="secondary-btn" onClick={() => setFullscreen(true)} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>
              ⤢ Expand
            </button>
            {(customLink ? !customEmbedUrl : true) && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {customLink
                  ? 'Showing the area — paste a full maps.google.com link (with the @lat,lng) to drop the pin exactly; your link still powers Open in Google Maps'
                  : 'Tip: paste a Google Maps link in Project Details for a 100% accurate pin'}
              </span>
            )}
          </div>
        </>
      ) : (
        <div
          style={{
            height: 200,
            borderRadius: 10,
            border: '1px dashed var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            fontSize: '0.82rem',
            backgroundColor: 'var(--bg-secondary)',
          }}
        >
          Add an address or Google Maps link to show the map.
        </div>
      ))}

      {fullscreen && (
        <div
          onClick={() => setFullscreen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            backgroundColor: 'rgba(0,0,0,0.82)',
            display: 'flex',
            flexDirection: 'column',
            padding: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, color: '#fff' }}>
            <strong style={{ fontSize: '1rem' }}>{asset.name || 'Map'}</strong>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ color: '#fff', fontSize: '0.82rem', textDecoration: 'underline' }}
              >
                Open in Google Maps
              </a>
              <button
                onClick={() => setFullscreen(false)}
                style={{ border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: '0.85rem' }}
              >
                Close ✕
              </button>
            </div>
          </div>
          <iframe
            title="Property map full"
            src={embedUrl}
            onClick={(e) => e.stopPropagation()}
            style={{ flex: 1, width: '100%', border: 'none', borderRadius: 10, backgroundColor: '#fff' }}
          />
        </div>
      )}
    </Card>
  );
}
