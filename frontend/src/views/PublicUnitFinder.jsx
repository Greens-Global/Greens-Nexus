// /map/{propertyId} - the customer unit finder (Neil, Oct 11 2026). No login:
// a storage customer opens it from a link or QR code, types their unit number
// and sees where it is on the to-scale 3D model with directions from the gate.
// The model it loads is the customer-safe view (geometry and unit numbers,
// never occupancy or tenant data). An #anchor like /map/<id>#C214 preselects.
import { useEffect, useState } from 'react';
import { fetchPublicSiteModel } from '../api.js';
import { SiteModelPanel, siteModelImages } from '../sitemodel/SiteModelPanel.jsx';

export default function PublicUnitFinder({ propertyId }) {
  const [model, setModel] = useState(null); const [error, setError] = useState('');
  useEffect(() => { let on = true; fetchPublicSiteModel(propertyId).then((m) => on && setModel(m)).catch((e) => on && setError(e.message || 'Could not load the map')); return () => { on = false; }; }, [propertyId]);
  const initial = (window.location.hash || '').slice(1).toUpperCase();
  const name = model?.property?.name || 'Greens Storage';
  useEffect(() => { document.title = `${name} - Find Your Unit`; }, [name]);
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-secondary, #f3f1ec)', color: 'var(--text-primary, #1d1f1a)', fontFamily: "'Inter', system-ui, sans-serif", padding: '0 16px calc(24px + env(safe-area-inset-bottom, 0px))' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '14px 0 10px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>{name}</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)' }}>{model?.property?.address || ''}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted, #5f6358)' }}>Find Your Unit</span>
      </header>
      {error ? <div role="alert" style={{ padding: 24, textAlign: 'center', fontSize: 14 }}>{error}</div>
        : !model ? <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted, #5f6358)', fontSize: 14 }}>Loading the site map…</div>
        : <SiteModelPanel model={model} mode="customer" images={siteModelImages(propertyId)} initialUnit={initial} height="max(420px, calc(100dvh - 170px))" />}
    </div>
  );
}
