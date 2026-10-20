// Operations > Site Map (Neil, Oct 20 2026): "an ops person should be able to
// see their property visually and go, what is my occupancy? what is the
// necessary maintenance?" The same 3D site model Asset Management shows
// (sitemodel/SiteModelPanel), for the facility picked in Operations, with
// layers - Occupancy, Days Vacant, Market, Maintenance - each with its own
// colors and legend.
//
// Oct 20 2026 (Visesh's review): the map fills the screen and the panel beside
// it is the same height and scrolls on its own - Inventory, then the chosen
// unit (the main thing: tenant, lease and money facts, tickets, Report an
// Issue), then folded lists. The Customer Entrance and the Cubby template link
// live behind Customer Link Settings. ONE status per unit (the rent roll's
// word, a lease beats Cubby's ACTIVE_LEASE flag) feeds the badge, the tiles,
// the colors and Needs Attention. The facility comes from the page's Facility
// menu; this tab never offers its own picker.
//
// Loaded lazily from FacilityOperations: three.js stays out of the Operations chunk.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, LoadingState, SkeletonBlocks } from '../components/AsyncState';
import WidgetBoundary from '../components/WidgetBoundary';
import { formatDate, formatDateTime } from '../lib/datetime';
import { Modal } from '../tasks/components';
import { PropertyTicketComposer, PropertyTicketDrawer } from '../asset/components/maintenance/ticketMounts';
import { SiteModelPanel, siteModelImages } from '../sitemodel/SiteModelPanel.jsx';
import { DAYS_STOPS, LAYERS, MAINT, MARKET, QUIET, UNKNOWN, hoverFact, layerColors, layerCounts, daysVacantOf, occupancyOf } from './siteMapLayers';

const LAYER_KEY = 'nexus.ops.siteMap.layer';
const readLayer = () => { try { const v = localStorage.getItem(LAYER_KEY); return LAYERS.some((l) => l.key === v) ? v : 'occupancy'; } catch { return 'occupancy'; } };
const saveLayer = (v) => { try { localStorage.setItem(LAYER_KEY, v); } catch { /* not remembered */ } };
const money = (c) => (c || c === 0 ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}` : '-');
const swatch = (c) => <i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, verticalAlign: -2, marginRight: 5, background: c }} />;
const muted = { color: 'var(--text-muted)' };

/** "2 yr 3 mo", "5 mo", "12 days" - how long a tenant has had the unit. */
export function stayLength(days) {
  if (days == null) return '';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.44); const y = Math.floor(months / 12); const m = months % 12;
  return y ? `${y} yr${m ? ` ${m} mo` : ''}` : `${m} mo`;
}
const LEASE_WORD = { current: 'Current', 'past-due': 'Past Due', overlocked: 'Overlocked', 'moving-out': 'Moving Out' };
const TICKET_WORD = { new: 'New', open: 'Open', in_progress: 'In Progress', waiting_user: 'Waiting on User', waiting_vendor: 'Waiting on Vendor', on_hold: 'On Hold', resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened' };

/** The legend for the layers that are not occupancy (occupancy's legend is the Inventory tiles). */
function Legend({ layer, counts, maint }) {
  const item = (c, l, n) => <span key={l}>{swatch(c)}{l}{n != null ? ` (${n})` : ''}</span>;
  if (layer === 'days') {
    return (
      <div style={{ width: '100%' }}>
        <div aria-hidden="true" style={{ height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${DAYS_STOPS.map(([d, c]) => `${c} ${Math.round((d / 180) * 100)}%`).join(', ')})` }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, ...muted, marginTop: 2 }}><span>0 days</span><span>60</span><span>120</span><span>180+</span></div>
        <div style={{ display: 'flex', gap: '6px 12px', flexWrap: 'wrap', marginTop: 4 }}>{item(UNKNOWN, 'Days Not Known', counts.unknown || 0)}{item(QUIET, 'Not Vacant')}</div>
      </div>
    );
  }
  if (layer === 'market') return <>{item(MARKET.under, 'Under Market', counts.under || 0)}{item(MARKET.at, 'At Market', counts.at || 0)}{item(MARKET.over, 'Over Market', counts.over || 0)}{item(QUIET, 'No Market Data', counts.none || 0)}</>;
  if (layer === 'maintenance') {
    if (!maint?.connected) return <span style={muted}>Maintenance layer not connected yet</span>;
    return <>{item(MAINT.urgent, 'Urgent / High')}{item(MAINT.open, 'Open Items', counts.open || 0)}{item(QUIET, 'Nothing Open')}</>;
  }
  return null;
}

const rowsStyle = { display: 'grid', gridTemplateColumns: 'minmax(96px, auto) 1fr', gap: '4px 12px', fontSize: 13, margin: '6px 0 0' };
const Row = ({ k, children, strong, tone }) => (<><dt style={muted}>{k}</dt><dd style={{ margin: 0, fontWeight: strong ? 700 : 400, color: tone || undefined }}>{children}</dd></>);
const Head = ({ children, right }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 12, borderTop: '1px solid var(--border-color)', paddingTop: 8 }}>
    <b style={{ fontSize: 13 }}>{children}</b>{right}
  </div>
);

/** Who rents it and how the money stands (leased), or how long it has sat empty (vacant). */
function TenantFacts({ detail, fact, occ, days }) {
  const t = detail?.tenant;
  if (occ === 'leased') {
    if (!detail) return <div style={{ marginTop: 6 }}><SkeletonBlocks count={4} height={14} borderRadius={4} /></div>;
    if (!t) return <p style={{ fontSize: 12, margin: '6px 0 0', ...muted }}>{detail.connected ? 'Cubby has no tenant on this unit right now.' : 'Tenant details are not available - Cubby has not synced yet.'}</p>;
    const street = detail.street || fact?.street || 0;
    const gap = street && t.rent ? t.rent - street : 0;
    return (
      <dl style={rowsStyle}>
        <Row k="Tenant" strong>{t.name || 'Not named'}</Row>
        <Row k="Moved In">{t.moveIn ? `${formatDate(t.moveIn)} · ${stayLength(t.daysInUnit)}` : '-'}</Row>
        <Row k="Rent">{money(t.rent)}/mo{street ? <span style={muted}> vs street {money(street)}{gap ? ` (${money(Math.abs(gap))} ${gap < 0 ? 'under' : 'over'})` : ''}</span> : null}</Row>
        <Row k="Balance" tone={t.balance > 0 ? '#b42318' : undefined} strong={t.balance > 0}>{t.balance > 0 ? `${money(t.balance)} past due · ${t.daysPastDue} day${t.daysPastDue === 1 ? '' : 's'}` : 'Paid up'}</Row>
        {t.paidThrough ? <Row k="Paid Through">{formatDate(t.paidThrough)}</Row> : null}
        <Row k="Autopay">{t.autoPay ? 'On' : 'Off'}</Row>
        {t.rentChange ? <Row k="Next Rent Change">{money(t.rentChange.rent)}/mo on {formatDate(t.rentChange.date)}</Row> : null}
        <Row k="Lease Status" tone={t.leaseStatus === 'current' ? undefined : '#b54708'}>{LEASE_WORD[t.leaseStatus] || 'Current'}{t.leaseStatus === 'moving-out' && t.moveOut ? ` ${formatDate(t.moveOut)}` : ''}</Row>
      </dl>
    );
  }
  return (
    <dl style={rowsStyle}>
      <Row k="Days Vacant" strong>{occ === 'vacant' ? (days == null ? 'Not known' : `${days}${fact?.vacantSince ? ` (since ${formatDate(fact.vacantSince)})` : ''}`) : '-'}</Row>
      {fact ? <Row k="Street Rate">{money(fact.street)}/mo</Row> : null}
    </dl>
  );
}

function UnitDetails({ u, fact, layer, maint, facilityId, onOpenTicket, onReport, reload = 0 }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [link, setLink] = useState({ status: 'idle', url: '', error: '' });
  useEffect(() => {
    let on = true; setDetail(null); setErr(''); setLink({ status: 'idle', url: '', error: '' });
    api.getOpsSiteMapUnit(facilityId, u.n).then((d) => on && setDetail(d)).catch((e) => on && setErr(e?.message || 'Could not load this unit'));
    return () => { on = false; };
  }, [facilityId, u.n, reload]);
  const copy = async () => {
    setLink({ status: 'busy', url: '', error: '' });
    try {
      const r = await api.getOpsCustomerLink(facilityId, u.n);
      try { await navigator.clipboard.writeText(r.url); setLink({ status: 'copied', url: r.url, error: '' }); } catch { setLink({ status: 'shown', url: r.url, error: '' }); }
    } catch (e) { setLink({ status: 'idle', url: '', error: e?.message || 'Could not make the link' }); }
  };
  const occ = occupancyOf(u, fact); const days = daysVacantOf(u, fact);
  const tickets = detail?.tickets || { open: [], recent: [], property: null };
  const otherItems = (maint?.units?.[u.n] || []).filter((x) => x.kind !== 'ticket');
  const cubbyUrl = detail?.tenant?.cubbyUrl;
  const ticketLine = (t) => (
    <li key={t.id}>
      <button type="button" onClick={() => onOpenTicket(t)} className="sm-ticket"
        style={{ width: '100%', display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', borderRadius: 8, padding: '5px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'inherit' }}>
        <b style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject || 'Ticket'}</b>
        <span style={{ ...muted, whiteSpace: 'nowrap' }}>{TICKET_WORD[t.status] || 'Open'} · {formatDate(t.closed ? (t.resolvedAt || t.createdAt) : t.createdAt)}</span>
      </button>
    </li>
  );
  return (
    <div>
      <Head right={cubbyUrl ? <a className="ops-link" href={cubbyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>Open in Cubby ↗</a> : null}>{occ === 'leased' ? 'Tenant' : 'Vacancy'}</Head>
      {err ? <p role="alert" style={{ fontSize: 12, color: '#c43d2f', margin: '6px 0 0' }}>{err}</p> : <TenantFacts detail={detail} fact={fact} occ={occ} days={days} />}

      <Head>Pricing</Head>
      <dl style={rowsStyle}>
        {fact?.type ? <Row k="Pricing Group">{fact.type}</Row> : null}
        <Row k="Vs Market" strong={layer === 'market'}>{fact?.market ? `${money(fact.rate)} vs ${money(fact.marketMedian)} median, ${fact.market === 'at' ? 'at market' : `${Math.abs(fact.marketPct || 0)}% ${fact.market}`}` : fact?.marketCount ? `Only ${fact.marketCount} competitor rate for this size` : 'No competitor rate for this size'}</Row>
      </dl>
      {occ === 'vacant' && typeof days === 'number' && days >= 90 && <p style={{ fontSize: 12, margin: '6px 0 0', color: '#9a3412' }}>Empty {days} days - worth a look at this unit's rate.</p>}

      <Head right={<button type="button" className="secondary-btn" onClick={() => onReport(tickets.property)} disabled={!tickets.property} title={tickets.property ? '' : 'This facility is not linked to a property in Asset Management yet'} style={{ fontSize: 12, padding: '3px 10px' }}>Report an Issue</button>}>
        Tickets{detail ? ` (${tickets.open.length} Open)` : ''}
      </Head>
      {!detail && !err ? <div style={{ marginTop: 6 }}><SkeletonBlocks count={2} height={22} borderRadius={6} /></div> : (
        <>
          {tickets.open.length ? <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>{tickets.open.map(ticketLine)}</ul>
            : <p style={{ fontSize: 12, margin: '6px 0 0', ...muted }}>No open tickets on this unit.</p>}
          {tickets.recent.length ? <>
            <div style={{ fontSize: 11, ...muted, margin: '8px 0 2px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Recently Closed</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.8 }}>{tickets.recent.map(ticketLine)}</ul>
          </> : null}
          {otherItems.length ? <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, fontSize: 12 }}>{otherItems.slice(0, 4).map((x) => <li key={`m-${x.id}`}><b>Maintenance</b> · {x.title}{x.opened_at ? ` · ${formatDate(x.opened_at)}` : ''}</li>)}</ul> : null}
        </>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={copy} disabled={link.status === 'busy'}>{link.status === 'copied' ? 'Copied' : 'Copy Customer Link'}</button>
        {link.status === 'copied' && <span style={{ fontSize: 12, ...muted }}>Route-only map for this unit, no login.</span>}
        {link.error && <span role="alert" style={{ fontSize: 12, color: '#c43d2f' }}>{link.error}</span>}
      </div>
      {link.url && link.status === 'shown' && <input readOnly value={link.url} aria-label="Customer link" onFocus={(e) => e.target.select()} style={{ marginTop: 6, width: '100%', fontSize: 12, padding: '4px 6px' }} />}
    </div>
  );
}

/** Customer Entrance + the Cubby rental confirmation link, in a 60vw dialog. */
function CustomerLinkSettings({ facilityId, entrance, template, onSaved, onClose }) {
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
    <Modal title="Customer Link Settings" onClose={onClose} minHeight="60vh" isDirty={edit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontSize: 13 }}>
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <b style={{ fontSize: 14 }}>Customer Entrance</b>
              <p style={{ margin: '2px 0 0', ...muted }}>Where the customer map sends people. Google's pin for the street address can land on a neighbor; set the real gate here.</p>
            </div>
            {!edit && <button type="button" className="secondary-btn" onClick={start}>Edit Entrance</button>}
          </div>
          {!edit ? (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div>{entrance?.lat != null ? <>{entrance.lat}, {entrance.lng} · {entrance.source === 'setting' ? 'set here' : `the model's ${entrance.name || 'gate'}`}</> : 'No entrance pin yet.'}
                {entrance?.mapsUrl && <> · <a className="ops-link" href={entrance.mapsUrl} target="_blank" rel="noopener noreferrer">Open in Google Maps</a></>}</div>
              {entrance?.note && <div style={muted}>{entrance.note}</div>}
              {entrance?.updatedAt && <div style={{ ...muted, fontSize: 12 }}>Updated {formatDateTime(entrance.updatedAt)}{entrance.updatedBy ? ` by ${entrance.updatedBy}` : ''}</div>}
            </div>
          ) : (
            <form onSubmit={save} style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, alignItems: 'end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>Latitude<input style={input} value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="38.29186" inputMode="decimal" /></label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>Longitude<input style={input} value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="-121.96738" inputMode="decimal" /></label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, gridColumn: '1 / -1' }}>Note for Customers<input style={input} value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Turn in at the green Greens Storage sign, past the landscape yard." /></label>
              <div style={{ display: 'flex', gap: 8, gridColumn: '1 / -1', flexWrap: 'wrap' }}>
                <button type="submit" className="primary-btn" disabled={busy}>Save</button>
                <button type="button" className="secondary-btn" onClick={() => setEdit(false)} disabled={busy}>Cancel</button>
                {entrance?.source === 'setting' && <button type="button" className="secondary-btn" onClick={(e) => save(e, true)} disabled={busy}>Use the Model's Gate</button>}
                {error && <span role="alert" style={{ fontSize: 12, color: '#c43d2f', alignSelf: 'center' }}>{error}</span>}
              </div>
            </form>
          )}
        </section>
        {template && (
          <section>
            <b style={{ fontSize: 14 }}>Cubby Rental Confirmation Link</b>
            <p style={{ margin: '2px 0 8px', ...muted }}>Paste into the facility's move-in / rental confirmation template. Cubby fills in the unit number; the link opens that unit's route only. Confirm the unit variable's name in Cubby's template editor (Standard Values).</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input readOnly value={template} aria-label="Cubby template link" onFocus={(e) => e.target.select()} style={{ ...input, flex: 1, minWidth: 0, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
              <button type="button" className="secondary-btn" onClick={copyTemplate}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

export default function SiteMap({ facility }) {
  const facilityId = facility?.id || '';
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const [maint, setMaint] = useState(null);
  const [layer, setLayerState] = useState(readLayer);
  const [settings, setSettings] = useState(false);
  const [openTicket, setOpenTicket] = useState(null);
  const [report, setReport] = useState(null);
  const [reload, setReload] = useState(0);   // a ticket filed or changed from the card refreshes it
  const setLayer = (k) => { setLayerState(k); saveLayer(k); };

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
  const statusOf = useCallback((u) => occupancyOf(u, facts[u.n]), [facts]);
  const markers = useMemo(() => {
    if (layer !== 'maintenance' || !maint?.connected) return {};
    return Object.fromEntries(Object.entries(maint.units).filter(([, v]) => v?.length).map(([k, v]) => [k, v.length]));
  }, [layer, maint]);
  const hoverInfo = useCallback((u) => hoverFact(layer, u, facts, maint), [layer, facts, maint]);
  const renderUnitExtra = useCallback((u) => (
    <UnitDetails key={u.n} u={u} fact={facts[u.n]} layer={layer} maint={maint} facilityId={facilityId} reload={reload}
      onOpenTicket={(t) => setOpenTicket(t)} onReport={(p) => p && setReport({ id: p.id, name: p.name, unit: u.n })} />
  ), [facts, layer, maint, facilityId, reload]);

  if (!facility) {
    return (
      <div className="dash-card"><div className="ops-empty">Pick a facility above to see the Site Map.</div></div>
    );
  }
  if (state.status === 'loading' || state.status === 'idle') return <LoadingState size="section" label="Loading the site map" minHeight={520} />;
  if (state.status === 'error') {
    return state.error?.status === 404
      ? <div className="dash-card"><div className="ops-empty">{facility.shortName} has no site model yet. Site models are built from the property's plans (Asset Management).</div></div>
      : <ErrorBanner message="Couldn't load the site map." onRetry={load} />;
  }
  const vacantLong = units.filter((u) => occupancyOf(u, facts[u.n]) === 'vacant' && (daysVacantOf(u, facts[u.n]) || 0) >= 90).length;
  const hint = {
    occupancy: 'Green is leased, yellow is vacant and ready to rent, red is out of service (not leased and can\'t be rented).',
    days: `How long each empty unit has sat empty - the darker, the longer. ${vacantLong} vacant 90+ days.`,
    market: `Our rate (rent if leased, street rate if vacant) against competitors' median for the same size. Within ${Math.round((data.marketBand || 0.05) * 100)}% counts as at market.`,
    maintenance: maint?.connected ? 'Units with open tickets or maintenance items - red is urgent.' : maint ? 'Maintenance layer not connected yet.' : 'Loading maintenance items…',
  }[layer];
  return (
    <div>
      <div className="dash-card" style={{ marginBottom: 12, padding: '8px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="ops-pills" role="group" aria-label="Layer">
            {LAYERS.map((l) => <button type="button" key={l.key} className="ops-pill" aria-pressed={layer === l.key} onClick={() => setLayer(l.key)}>{l.label}</button>)}
          </div>
          <span style={{ fontSize: 12, ...muted, flex: '1 1 240px', minWidth: 0 }}>{hint}</span>
          <button type="button" className="secondary-btn" onClick={() => setSettings(true)}>Customer Link Settings</button>
        </div>
        {layer === 'maintenance' && maint?.connected && maint.property?.length ? (
          <div style={{ marginTop: 8, fontSize: 12 }}><b>Property-Wide ({maint.property.length}):</b> {maint.property.slice(0, 5).map((x) => x.title).join(' · ')}{maint.property.length > 5 ? ' …' : ''}</div>
        ) : null}
      </div>
      <WidgetBoundary name="ops-site-map" resetKey={`${facilityId}:${layer}`} fallback={<div className="dash-card"><div className="ops-empty">The site map hit a problem. Switch facility or layer to try again.</div></div>}>
        <SiteModelPanel model={data.model} mode="owner" images={siteModelImages(data.modelId)} unitColors={colors} statusOf={statusOf} fill
          legend={layer === 'occupancy' ? null : <Legend layer={layer} counts={counts} maint={maint} />} hoverInfo={hoverInfo} renderUnitExtra={renderUnitExtra}
          markers={markers} pinsEnabled={false} />
      </WidgetBoundary>
      {settings && <CustomerLinkSettings facilityId={facilityId} entrance={data.entrance} template={data.cubbyTemplate} onClose={() => setSettings(false)}
        onSaved={(entrance) => setState((s) => ({ ...s, data: { ...s.data, entrance } }))} />}
      {openTicket && <PropertyTicketDrawer ticketId={openTicket.id} onClose={() => { setOpenTicket(null); setReload((n) => n + 1); }} />}
      {report && <PropertyTicketComposer property={report} onClose={() => { setReport(null); setReload((n) => n + 1); }} />}
    </div>
  );
}
