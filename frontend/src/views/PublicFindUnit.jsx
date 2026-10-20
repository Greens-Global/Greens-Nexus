// /find/<token> - a storage customer's own unit map (Neil, Oct 20 2026). No login.
// Sent in the rental confirmation: the facility's address, the real entrance
// with an Open in Google Maps link (not the street-address pin - at Fairfield
// that lands in the landscape yard next door), and the 3D model with ONLY the
// path from the gate and this customer's unit. The server sends one unit and no
// occupancy (routers/unit_map.customer_view); there is no search box.
//
// /find/u?f=<facility>&k=<key>&unit=<unit> is the Cubby template form: the
// server checks the facility key, signs a token, and the address bar is swapped
// to /find/<token> so the link the customer bookmarks is the signed one.
import { useEffect, useState } from 'react';
import { fetchPublicUnitMap, fetchPublicUnitMapTemplate } from '../api.js';
import WidgetBoundary from '../components/WidgetBoundary';
import { SiteModelPanel, siteModelImages } from '../sitemodel/SiteModelPanel.jsx';
import { routeSteps, unitDirections, unitKindLabel } from '../sitemodel/siteModelViewer.js';
import { googleMapsDirectionsUrl } from '../sitemodel/siteModelDirections.js';

const FONT = "'Inter', system-ui, sans-serif";
const muted = { color: 'var(--text-muted, #5f6358)' };
const card = { border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 12, padding: 14, background: 'var(--bg-primary, #fff)' };

export default function PublicFindUnit({ token, search = '' }) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    let on = true;
    const q = new URLSearchParams(search || '');
    const p = token === 'u' ? fetchPublicUnitMapTemplate({ f: q.get('f'), k: q.get('k'), unit: q.get('unit') }) : fetchPublicUnitMap(token);
    p.then((d) => {
      if (!on) return;
      setData(d);
      if (d.token) { try { window.history.replaceState(null, '', `/find/${d.token}`); } catch { /* keep the template address */ } }
    }).catch((e) => on && setError(e.message || 'Could not load the map'));
    return () => { on = false; };
  }, [token, search]);
  const name = data?.property?.name || 'Greens Storage';
  const unit = data?.unit;
  useEffect(() => { document.title = unit ? `${name} - Unit ${unit.n}` : `${name} - Your Unit`; }, [name, unit]);
  const steps = unit ? routeSteps(data, unit) : [];
  const ent = data?.entrance;
  // Through the gate and on to the unit itself (Oct 20), not just to the facility.
  let unitMaps = null;
  try { unitMaps = unit ? googleMapsDirectionsUrl(data, { unit, gateLatLng: ent?.lat != null ? [ent.lat, ent.lng] : null }) : null; } catch { unitMaps = null; }
  const mapsHref = unitMaps || ent?.mapsUrl;
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-secondary, #f3f1ec)', color: 'var(--text-primary, #1d1f1a)', fontFamily: FONT, padding: '0 16px calc(24px + env(safe-area-inset-bottom, 0px))' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '14px 0 10px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>{name}</h1>
        <span style={{ fontSize: 13, ...muted }}>{data?.property?.address || ''}</span>
        {unit && <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600 }}>Your Unit: <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{unit.n}</span></span>}
      </header>
      {error ? <div role="alert" style={{ ...card, textAlign: 'center', fontSize: 14 }}>{error}</div>
        : !data ? <div style={{ padding: 60, textAlign: 'center', fontSize: 14, ...muted }}>Loading your map…</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }} aria-label="Getting here">
              <div>
                <h2 style={{ fontSize: 14, margin: '0 0 4px' }}>Getting Here</h2>
                <p style={{ fontSize: 13, margin: 0 }}>{data.property?.address}</p>
                <p style={{ fontSize: 13, margin: '4px 0 0', ...muted }}>Use the {ent?.name || 'entrance'} pin, not the street address - map apps can drop the address pin on a neighbor.</p>
                {ent?.note && <p style={{ fontSize: 13, margin: '6px 0 0', fontWeight: 600 }}>{ent.note}</p>}
                {mapsHref && <a href={mapsHref} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 10, background: '#1f6f4a', color: '#fff', padding: '8px 14px', borderRadius: 8, fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>Open in Google Maps</a>}
              </div>
              <div>
                <h2 style={{ fontSize: 14, margin: '0 0 4px' }}>Your Unit</h2>
                <div style={{ fontSize: 13 }}><b style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 16 }}>{unit.n}</b> · {unitKindLabel(unit)}{unit.w && unit.d ? ` · ${unit.w} × ${unit.d} ft` : ''}</div>
                <div style={{ fontSize: 13, ...muted }}>{data.building}{unit.f > 1 ? `, Level ${unit.f}` : ''}</div>
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }} aria-label="Directions">{unitDirections(data, unit).map((s, i) => <li key={i} style={{ margin: '3px 0' }}>{s}</li>)}</ol>
              </div>
            </section>
            <WidgetBoundary name="public-find-unit" fallback={<div style={card}>The map could not be drawn on this device. The directions above still get you there.</div>}>
              <SiteModelPanel model={data} mode="customer" images={siteModelImages(data.property?.id)} initialUnit={unit.n} hideSearch fitRoute
                height="max(380px, calc(100dvh - 330px))" />
            </WidgetBoundary>
            <p style={{ fontSize: 12, margin: 0, ...muted }}>{steps.length} steps from the gate to {unit.n}. Tap a step to see it on the map. Positions are drawn to scale from the site plans; the office can help if anything looks different on site.</p>
          </div>
        )}
    </div>
  );
}
