// Operations > Site Map (Neil, Oct 20 2026): "an ops person should be able to
// see their property visually and go, what is my occupancy? what is the
// necessary maintenance?" The same 3D site model Asset Management shows
// (sitemodel/SiteModelPanel), for the facility picked in Operations, with
// layers - Occupancy, Days Vacant, Market, Maintenance - each with its own
// colors and legend. A unit's card adds the layer's facts and a Copy Customer
// Link for the customer unit map (/find/<token>, routers/unit_map.py).
//
// Loaded lazily from FacilityOperations: three.js stays out of the Operations chunk.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import WidgetBoundary from '../components/WidgetBoundary';
import { formatDate, formatDateTime } from '../lib/datetime';
import { SiteModelPanel, siteModelImages } from '../sitemodel/SiteModelPanel.jsx';
import { DAYS_STOPS, LAYERS, MAINT, MARKET, OCC, QUIET, UNKNOWN, hoverFact, layerColors, layerCounts, daysVacantOf, occupancyOf } from './siteMapLayers';

const LAYER_KEY = 'nexus.ops.siteMap.layer';
const readLayer = () => { try { const v = localStorage.getItem(LAYER_KEY); return LAYERS.some((l) => l.key === v) ? v : 'occupancy'; } catch { return 'occupancy'; } };
const saveLayer = (v) => { try { localStorage.setItem(LAYER_KEY, v); } catch { /* not remembered */ } };
const money = (c) => (c || c === 0 ? `$${Math.round(c / 100).toLocaleString('en-US')}` : '-');
const swatch = (c) => <i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, verticalAlign: -2, marginRight: 5, background: c }} />;

function Legend({ layer, counts, maint }) {
  const item = (c, l, n) => <span key={l}>{swatch(c)}{l}{n != null ? ` (${n})` : ''}</span>;
  if (layer === 'days') {
    return (
      <div style={{ width: '100%' }}>
        <div aria-hidden="true" style={{ height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${DAYS_STOPS.map(([d, c]) => `${c} ${Math.round((d / 180) * 100)}%`).join(', ')})` }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}><span>0 days</span><span>60</span><span>120</span><span>180+</span></div>
        <div style={{ display: 'flex', gap: '6px 12px', flexWrap: 'wrap', marginTop: 4 }}>{item(UNKNOWN, 'Days Not Known', counts.unknown || 0)}{item(QUIET, 'Not Vacant')}{item('#ff7a00', 'Selected')}</div>
      </div>
    );
  }
  if (layer === 'market') return <>{item(MARKET.under, 'Under Market', counts.under || 0)}{item(MARKET.at, 'At Market', counts.at || 0)}{item(MARKET.over, 'Over Market', counts.over || 0)}{item(QUIET, 'No Market Data', counts.none || 0)}</>;
  if (layer === 'maintenance') {
    if (!maint?.connected) return <span style={{ color: 'var(--text-muted)' }}>Maintenance layer not connected yet</span>;
    return <>{item(MAINT.urgent, 'Urgent / High')}{item(MAINT.open, 'Open Items')}{item(QUIET, 'Nothing Open')}</>;
  }
  return <>{item(OCC.leased, 'Leased', counts.leased || 0)}{item(OCC.vacant, 'Vacant', counts.vacant || 0)}{item(OCC.bad, 'Out of Service', counts.bad || 0)}{item('#ff7a00', 'Selected')}</>;
}

function UnitFacts({ u, fact, layer, maint, facilityId }) {
  const [link, setLink] = useState({ status: 'idle', url: '', error: '' });
  const copy = async () => {
    setLink({ status: 'busy', url: '', error: '' });
    try {
      const r = await api.getOpsCustomerLink(facilityId, u.n);
      try { await navigator.clipboard.writeText(r.url); setLink({ status: 'copied', url: r.url, error: '' }); } catch { setLink({ status: 'shown', url: r.url, error: '' }); }
    } catch (e) { setLink({ status: 'idle', url: '', error: e?.message || 'Could not make the link' }); }
  };
  const occ = occupancyOf(u, fact); const days = daysVacantOf(u, fact);
  const items = maint?.units?.[u.n] || [];
  const row = (k, v, strong) => <><dt style={{ color: 'var(--text-muted)' }}>{k}</dt><dd style={{ margin: 0, fontWeight: strong ? 700 : 400 }}>{v}</dd></>;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border-color)', paddingTop: 8 }}>
      <b style={{ fontSize: 13 }}>Operations</b>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, margin: '6px 0 0' }}>
        {row('Status', occ === 'leased' ? 'Leased' : occ === 'vacant' ? 'Vacant' : 'Out of Service', layer === 'occupancy')}
        {fact?.type ? row('Pricing Group', fact.type) : null}
        {occ === 'leased' && fact ? row('Rent', `${money(fact.rent)}/mo`) : null}
        {fact ? row('Street Rate', `${money(fact.street)}/mo`) : null}
        {occ === 'vacant' ? row('Days Vacant', days == null ? 'Not known' : `${days}${fact?.vacantSince ? ` (since ${formatDate(fact.vacantSince)})` : ''}`, layer === 'days') : null}
        {row('Vs Market', fact?.market ? `${money(fact.rate)} vs ${money(fact.marketMedian)} median, ${fact.market === 'at' ? 'at market' : `${Math.abs(fact.marketPct || 0)}% ${fact.market}`}` : fact?.marketCount ? `Only ${fact.marketCount} competitor rate for this size` : 'No competitor rate for this size', layer === 'market')}
        {row('Open Items', !maint?.connected ? 'Maintenance layer not connected yet' : items.length ? `${items.length}` : 'None', layer === 'maintenance')}
      </dl>
      {maint?.connected && items.length ? (
        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
          {items.slice(0, 6).map((x) => <li key={`${x.kind}-${x.id}`}><b>{x.kind === 'ticket' ? 'Ticket' : 'Maintenance'}</b> · {x.title}{x.priority ? ` · ${x.priority}` : ''}{x.opened_at ? ` · opened ${formatDate(x.opened_at)}` : ''}</li>)}
        </ul>
      ) : null}
      {occ === 'vacant' && typeof days === 'number' && days >= 90 && <p style={{ fontSize: 12, margin: '6px 0 0', color: '#9a3412' }}>Empty {days} days - worth a look at this unit's rate.</p>}
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={copy} disabled={link.status === 'busy'}>{link.status === 'copied' ? 'Copied' : 'Copy Customer Link'}</button>
        {link.status === 'copied' && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Route-only map for this unit, no login.</span>}
        {link.error && <span role="alert" style={{ fontSize: 12, color: '#c43d2f' }}>{link.error}</span>}
      </div>
      {link.url && link.status === 'shown' && <input readOnly value={link.url} aria-label="Customer link" onFocus={(e) => e.target.select()} style={{ marginTop: 6, width: '100%', fontSize: 12, padding: '4px 6px' }} />}
    </div>
  );
}

function EntranceCard({ facilityId, entrance, template, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ lat: '', lng: '', note: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [copied, setCopied] = useState(false);
  const start = () => { setForm({ lat: entrance?.source === 'setting' ? String(entrance.lat) : '', lng: entrance?.source === 'setting' ? String(entrance.lng) : '', note: entrance?.note || '' }); setError(''); setEdit(true); };
  const save = async (e, clear = false) => {
    e?.preventDefault(); setBusy(true); setError('');
    // Paste "38.2918, -121.9680" straight from Google Maps into the latitude box
    let lat = form.lat, lng = form.lng; const both = String(lat).split(',');
    if (both.length === 2 && !String(lng).trim()) { lat = both[0]; lng = both[1]; }
    try {
      const body = clear ? { facility_id: facilityId } : { facility_id: facilityId, lat: lat === '' ? null : Number(lat), lng: lng === '' ? null : Number(lng), note: form.note };
      onSaved(await api.saveOpsEntrance(body)); setEdit(false);
    } catch (err) { setError(err?.message || 'Could not save'); } finally { setBusy(false); }
  };
  const copyTemplate = async () => { try { await navigator.clipboard.writeText(template); setCopied(true); } catch { setCopied(false); } };
  const input = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-color)', font: 'inherit', fontSize: 13, background: 'var(--bg-primary)', color: 'inherit' };
  return (
    <div className="dash-card" style={{ marginTop: 14 }}>
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">Customer Entrance</div>
          <div className="dash-card-sub">Where the customer map sends people. Google's pin for the street address can land on a neighbor; set the real gate here.</div>
        </div>
        {!edit && <button type="button" className="secondary-btn" onClick={start}>Edit Entrance</button>}
      </div>
      {!edit ? (
        <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>{entrance?.lat != null ? <>{entrance.lat}, {entrance.lng} · {entrance.source === 'setting' ? 'set here' : `the model's ${entrance.name || 'gate'}`}</> : 'No entrance pin yet.'}
            {entrance?.mapsUrl && <> · <a className="ops-link" href={entrance.mapsUrl} target="_blank" rel="noopener noreferrer">Open in Google Maps</a></>}</div>
          {entrance?.note && <div style={{ color: 'var(--text-muted)' }}>{entrance.note}</div>}
          {entrance?.updatedAt && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Updated {formatDateTime(entrance.updatedAt)}{entrance.updatedBy ? ` by ${entrance.updatedBy}` : ''}</div>}
        </div>
      ) : (
        <form onSubmit={save} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>Latitude<input style={input} value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="38.29186" inputMode="decimal" /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>Longitude<input style={input} value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="-121.96738" inputMode="decimal" /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, gridColumn: '1 / -1' }}>Note for customers<input style={input} value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Turn in at the green Greens Storage sign, past the landscape yard." /></label>
          <div style={{ display: 'flex', gap: 8, gridColumn: '1 / -1', flexWrap: 'wrap' }}>
            <button type="submit" className="primary-btn" disabled={busy}>Save</button>
            <button type="button" className="secondary-btn" onClick={() => setEdit(false)} disabled={busy}>Cancel</button>
            {entrance?.source === 'setting' && <button type="button" className="secondary-btn" onClick={(e) => save(e, true)} disabled={busy}>Use the Model's Gate</button>}
            {error && <span role="alert" style={{ fontSize: 12, color: '#c43d2f', alignSelf: 'center' }}>{error}</span>}
          </div>
        </form>
      )}
      {template && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <b>Cubby rental confirmation link</b>
          <p style={{ margin: '2px 0 6px', color: 'var(--text-muted)' }}>Paste into the facility's move-in / rental confirmation template. Cubby fills in the unit number; the link opens that unit's route only. Confirm the unit variable's name in Cubby's template editor (Standard Values).</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input readOnly value={template} aria-label="Cubby template link" onFocus={(e) => e.target.select()} style={{ ...input, flex: 1, minWidth: 0, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
            <button type="button" className="secondary-btn" onClick={copyTemplate}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SiteMap({ facility, facilities, onPick }) {
  const facilityId = facility?.id || '';
  const [withModel, setWithModel] = useState(null);
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const [maint, setMaint] = useState(null);
  const [layer, setLayerState] = useState(readLayer);
  const setLayer = (k) => { setLayerState(k); saveLayer(k); };

  useEffect(() => { let on = true; api.getOpsSiteMapFacilities().then((l) => on && setWithModel(l || [])).catch(() => on && setWithModel([])); return () => { on = false; }; }, []);
  const load = useCallback(() => {
    if (!facilityId) return undefined;
    let on = true;
    setState({ status: 'loading', data: null, error: null }); setMaint(null);
    api.getOpsSiteMap(facilityId).then((d) => on && setState({ status: 'ready', data: d, error: null }))
      .catch((e) => on && setState({ status: 'error', data: null, error: e }));
    api.getOpsMaintenanceMap(facilityId).then((m) => on && setMaint({ connected: true, units: m?.units || {}, property: m?.property || [] }))
      .catch((e) => on && setMaint({ connected: false, notFound: e?.status === 404 || e?.status === 405 }));
    return () => { on = false; };
  }, [facilityId]);
  useEffect(() => load(), [load]);

  const data = state.data;
  const units = data?.model?.units;
  const facts = useMemo(() => data?.facts || {}, [data]);
  const colors = useMemo(() => (units ? layerColors(layer, units, facts, maint) : null), [layer, units, facts, maint]);
  const counts = useMemo(() => (units ? layerCounts(layer, units, facts, maint) : {}), [layer, units, facts, maint]);
  const markers = useMemo(() => {
    if (layer !== 'maintenance' || !maint?.connected) return {};
    return Object.fromEntries(Object.entries(maint.units).filter(([, v]) => v?.length).map(([k, v]) => [k, v.length]));
  }, [layer, maint]);
  const hoverInfo = useCallback((u) => hoverFact(layer, u, facts, maint), [layer, facts, maint]);
  const renderUnitExtra = useCallback((u) => <UnitFacts u={u} fact={facts[u.n]} layer={layer} maint={maint} facilityId={facilityId} />, [facts, layer, maint, facilityId]);

  const hasModel = (id) => !withModel || withModel.some((m) => m.facilityId === id);
  if (!facility) {
    return (
      <div className="dash-card">
        <div className="dash-card-title">Choose a Facility</div>
        <div className="dash-card-sub" style={{ marginBottom: 14 }}>The site map shows one facility at a time.</div>
        <div className="ops-pills">
          {facilities.filter((f) => hasModel(f.id)).map((f) => <button type="button" key={f.id} className="ops-pill" aria-pressed="false" onClick={() => onPick(f.id)}>{f.shortName}</button>)}
        </div>
      </div>
    );
  }
  if (state.status === 'loading' || state.status === 'idle') return <LoadingState size="section" label="Loading the site map" minHeight={420} />;
  if (state.status === 'error') {
    return state.error?.status === 404
      ? <div className="dash-card"><div className="ops-empty">{facility.shortName} has no site model yet. Site models are built from the property's plans (Asset Management).</div></div>
      : <ErrorBanner message="Couldn't load the site map." onRetry={load} />;
  }
  const vacantLong = units.filter((u) => occupancyOf(u, facts[u.n]) === 'vacant' && (daysVacantOf(u, facts[u.n]) || 0) >= 90).length;
  return (
    <div>
      <div className="dash-card" style={{ marginBottom: 14, padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="ops-pills" role="group" aria-label="Layer">
            {LAYERS.map((l) => <button type="button" key={l.key} className="ops-pill" aria-pressed={layer === l.key} onClick={() => setLayer(l.key)}>{l.label}</button>)}
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {layer === 'occupancy' && 'Leased, vacant and out of service, from the Cubby rent roll.'}
            {layer === 'days' && `How long each vacant unit has been empty. ${vacantLong} vacant 90+ days.`}
            {layer === 'market' && `Our rate (rent if leased, street rate if vacant) against the median of competitor rates for that size on Market Rates. Within ${Math.round((data.marketBand || 0.05) * 100)}% is at market.`}
            {layer === 'maintenance' && (maint?.connected ? 'Units with open maintenance items or tickets.' : maint ? 'Maintenance layer not connected yet.' : 'Loading maintenance items…')}
          </span>
        </div>
        {layer === 'maintenance' && maint?.connected && maint.property?.length ? (
          <div style={{ marginTop: 8, fontSize: 12 }}><b>Property-wide ({maint.property.length}):</b> {maint.property.slice(0, 5).map((x) => x.title).join(' · ')}{maint.property.length > 5 ? ' …' : ''}</div>
        ) : null}
      </div>
      <WidgetBoundary name="ops-site-map" resetKey={`${facilityId}:${layer}`} fallback={<div className="dash-card"><div className="ops-empty">The site map hit a problem. Switch facility or layer to try again.</div></div>}>
        <SiteModelPanel model={data.model} mode="owner" images={siteModelImages(data.modelId)} unitColors={colors}
          legend={<Legend layer={layer} counts={counts} maint={maint} />} hoverInfo={hoverInfo} renderUnitExtra={renderUnitExtra}
          markers={markers} pinsEnabled={false} />
      </WidgetBoundary>
      <EntranceCard facilityId={facilityId} entrance={data.entrance} template={data.cubbyTemplate}
        onSaved={(entrance) => setState((s) => ({ ...s, data: { ...s.data, entrance } }))} />
    </div>
  );
}
