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
// Oct 20 2026 (Visesh: "this looks glitchy when you have to scroll down to see
// options - make this screen better and organized"): no bar above the map any
// more. The Layer dropdown and Customer Link Settings (a gear) sit on the map
// top-right, the layer's explanation sits behind the legend's info button, the
// one search (units here, tenants and other facilities through Cubby) sits on
// the map top-left, and Property-Wide maintenance moved into the side panel.
// The map and panel fill the screen to its bottom edge, so nothing scrolls.
//
// Oct 20 2026 (Visesh: "the one in asset management is so much better"): the
// map and panel are production's Site Model again - solid status blocks on
// Satellite, the on-map button bar, Inventory 2x2 + legend (the layer's
// explanation under it), Needs Attention, Sources - still filling the screen.
//
// Loaded lazily from FacilityOperations: three.js stays out of the Operations chunk.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Settings } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState, SkeletonBlocks } from '../components/AsyncState';
import WidgetBoundary from '../components/WidgetBoundary';
import { formatDate, formatDateTime } from '../lib/datetime';
import { Modal } from '../tasks/components';
import { PropertyTicketComposer, PropertyTicketDrawer } from '../asset/components/maintenance/ticketMounts';
import { SiteModelPanel, siteModelImages } from '../sitemodel/SiteModelPanel.jsx';
import SectionPicker from './SectionPicker';
import { normalizeQuery } from '../sitemodel/unitQuery.js';
import { reasonGroup } from '../sitemodel/panelModel.js';
import DrillPanel from './DrillPanel';
import { LAYERS, hoverFact, layerBuckets, layerColors, daysVacantOf, occupancyOf } from './siteMapLayers';

const LAYER_KEY = 'nexus.ops.siteMap.layer';
const readLayer = () => { try { const v = localStorage.getItem(LAYER_KEY); return LAYERS.some((l) => l.key === v) ? v : 'occupancy'; } catch { return 'occupancy'; } };
const saveLayer = (v) => { try { localStorage.setItem(LAYER_KEY, v); } catch { /* not remembered */ } };
const money = (c) => (c || c === 0 ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}` : '-');
const muted = { color: 'var(--text-muted)' };

/** "2 yr 3 mo", "5 mo", "12 days" - how long a tenant has had the unit. */
export function stayLength(days) {
  if (days == null) return '';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.44); const y = Math.floor(months / 12); const m = months % 12;
  return y ? `${y} yr${m ? ` ${m} mo` : ''}` : `${m} mo`;
}
const TICKET_WORD = { new: 'New', open: 'Open', in_progress: 'In Progress', waiting_user: 'Waiting on User', waiting_vendor: 'Waiting on Vendor', on_hold: 'On Hold', resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened' };

const rowsStyle = { display: 'grid', gridTemplateColumns: 'minmax(96px, auto) 1fr', gap: '4px 12px', fontSize: 13, margin: '6px 0 0' };
const Row = ({ k, children, strong, tone }) => (<><dt style={muted}>{k}</dt><dd style={{ margin: 0, fontWeight: strong ? 700 : 400, color: tone || undefined }}>{children}</dd></>);
const Head = ({ children, right }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 12, borderTop: '1px solid var(--border-color)', paddingTop: 8 }}>
    <b style={{ fontSize: 13 }}>{children}</b>{right}
  </div>
);

// The tenant card (Visesh, Oct 20 2026: "the tenant data is going too
// unlooked"): the tenant's NAME leads, then tenure and status chips, the three
// money figures, rent against street and market, their other units, the last
// payments, coverage, compliance, tickets and the actions. Name, unit and
// money only - never a phone, email or address (the endpoint carries none).
const TONE = {
  good: { background: '#e7f4ec', color: '#1f6f4a', borderColor: '#cbe6d6' },
  bad: { background: '#fdecea', color: '#b42318', borderColor: '#f6c9c4' },
  warn: { background: '#fff4e0', color: '#9a5b00', borderColor: '#f3dcae' },
  quiet: { background: 'var(--bg-secondary, #f2f1ec)', color: 'var(--text-muted, #5f6358)', borderColor: 'var(--border-color, #d9d6cc)' },
};
const Chip = ({ tone = 'quiet', children }) => <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999, border: '1px solid', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', ...TONE[tone] }}>{children}</span>;
const Figure = ({ label, value, tone, sub }) => (
  <div style={{ flex: '1 1 0', minWidth: 'max-content', padding: '8px 10px', background: 'var(--bg-primary, #fff)' }}>
    <div style={{ fontSize: 11, ...muted }}>{label}</div>
    <div style={{ fontSize: 15.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: tone || 'var(--text-primary, #1d1f1a)', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{value}</div>
    {sub ? <div style={{ fontSize: 11, ...muted }}>{sub}</div> : null}
  </div>
);
const Figures = ({ children }) => (
  <div className="sm-figures" style={{ display: 'flex', flexWrap: 'wrap', gap: 1, marginTop: 10, border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', background: 'var(--border-color)' }}>{children}</div>
);
const linkBtn = { border: 0, background: 'transparent', padding: 0, font: 'inherit', fontSize: 12.5, fontWeight: 600, color: 'var(--ops-s1, #1f6f4a)', cursor: 'pointer' };

/** Their rent against the street rate and the market median, as bars with words. */
function RateCompare({ rent, street, median, daysInUnit }) {
  const rows = [['Their Rent', rent, '#1f6f4a'], ['Street Rate', street, '#8a8f84'], ['Market Median', median, '#2563eb']].filter(([, v]) => v);
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map(([, v]) => v));
  const gap = street ? rent - street : 0;
  const candidate = gap < 0 && (daysInUnit || 0) >= 365;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 8px', alignItems: 'center', fontSize: 12 }}>
        {rows.map(([k, v, c]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={muted}>{k}</span>
            <span aria-hidden="true" style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary, #eef0ec)' }}><span style={{ display: 'block', height: 6, borderRadius: 3, width: `${Math.max(4, (100 * v) / max)}%`, background: c }} /></span>
            <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: 'var(--text-primary, #1d1f1a)' }}>{money(v)}</span>
          </div>
        ))}
      </div>
      {gap ? <div style={{ fontSize: 12, marginTop: 5, fontWeight: candidate ? 600 : 400, color: candidate ? '#9a5b00' : 'var(--text-muted)' }}>
        {money(Math.abs(gap))} {gap < 0 ? 'under' : 'over'} street{candidate ? ': rent increase candidate' : ''}
      </div> : street ? <div style={{ fontSize: 12, marginTop: 5, ...muted }}>At the street rate</div> : null}
    </div>
  );
}

const COVERAGE_WORD = { facility: 'Facility Plan', private: 'Private Policy', none: 'None' };

function TenantCard({ t, detail, fact, onLedger, pickUnit, openElsewhere }) {
  const street = detail.street || fact?.street || 0;
  const cov = t.coverage;
  const others = t.otherUnits || [];
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div className="sm-tenant-name" style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.2, color: 'var(--text-primary, #1d1f1a)', minWidth: 0, overflowWrap: 'anywhere' }}>{t.name || 'Not Named'}</div>
        {t.cubbyUrl ? <a className="ops-link" href={t.cubbyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, marginTop: 4 }}>Open in Cubby ↗</a> : null}
      </div>
      {t.moveIn ? <div style={{ fontSize: 12.5, ...muted, marginTop: 2 }}>Tenant {stayLength(t.daysInUnit)}, since {formatDate(t.moveIn)}</div> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
        {t.balance > 0 ? <Chip tone="bad">Past Due {t.daysPastDue} Day{t.daysPastDue === 1 ? '' : 's'}</Chip> : <Chip tone="good">Paid Up</Chip>}
        <Chip tone={t.autoPay ? 'good' : 'quiet'}>Autopay {t.autoPay ? 'On' : 'Off'}</Chip>
        {t.overlocked ? <Chip tone="bad">Overlocked</Chip> : null}
        {t.moveOut ? <Chip tone="warn">Moving Out {formatDate(t.moveOut)}</Chip> : null}
      </div>
      <Figures>
        <Figure label="Rent" value={`${money(t.rent)}`} sub="per month" />
        <Figure label="Balance" value={t.balance > 0 ? money(t.balance) : 'Paid Up'} tone={t.balance > 0 ? '#b42318' : '#1f6f4a'} sub={t.balance > 0 ? 'past due' : ''} />
        <Figure label="Paid Through" value={t.paidThrough ? formatDate(t.paidThrough) : '-'} />
      </Figures>
      <RateCompare rent={t.rent} street={street} median={fact?.marketMedian} daysInUnit={t.daysInUnit} />
      {t.rentChange ? <div style={{ fontSize: 12, marginTop: 6 }}><span style={muted}>Next rent change:</span> {money(t.rentChange.rent)}/mo on {formatDate(t.rentChange.date)}</div> : null}

      {others.length ? <>
        <Head>Their Other Units ({others.length})</Head>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          {others.map((o) => {
            const label = o.here ? o.unit : `${o.unit} · ${o.facility}`;
            const go = o.here ? () => pickUnit?.(o.unit) : openElsewhere(o);
            return go
              ? <button key={`${o.facilityId}:${o.unit}`} type="button" className="sm-unit-chip" onClick={go} title={o.here ? `Show ${o.unit} on the map` : `Open ${o.facility} and show ${o.unit}`}
                style={{ border: '1px solid var(--border-color)', background: 'var(--bg-primary)', borderRadius: 999, padding: '3px 10px', font: "500 12px ui-monospace, Menlo, monospace", color: 'inherit', cursor: 'pointer' }}>{label}</button>
              : <span key={`${o.facilityId}:${o.unit}`} style={{ fontSize: 12, padding: '3px 4px', ...muted }}>{label}</span>;
          })}
        </div>
      </> : null}

      <Head right={t.customerId ? <button type="button" style={linkBtn} onClick={onLedger}>View Full Ledger</button> : null}>Recent Payments</Head>
      {t.payments?.length ? (
        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5 }}>
          {t.payments.map((p, i) => (
            <li key={i} style={{ display: 'grid', gridTemplateColumns: '78px 1fr auto', gap: 8, color: p.failed ? '#b42318' : undefined }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDate(p.date)}</span>
              <span style={{ ...(p.failed ? {} : muted), minWidth: 0 }}>{p.method}{p.status && p.status !== 'Paid' ? ` · ${p.status}` : ''}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{money(p.amount)}</span>
            </li>
          ))}
        </ul>
      ) : <p style={{ fontSize: 12, margin: '6px 0 0', ...muted }}>No payments in the last year.</p>}

      <Head>Coverage and Lease</Head>
      <dl style={rowsStyle}>
        <Row k="Coverage" tone={cov?.kind === 'none' ? '#9a5b00' : undefined}>
          {COVERAGE_WORD[cov?.kind || 'none']}
          {cov?.kind === 'facility' && cov.amount ? <span style={muted}> · {money(cov.amount)} coverage</span> : null}
          {cov?.kind === 'private' ? <span style={muted}> · {cov.policyOnFile ? 'policy on file' : 'no policy on file'}{cov.policyExpires ? `, expires ${formatDate(cov.policyExpires)}` : ''}</span> : null}
        </Row>
        {Array.isArray(t.compliance) ? <Row k="Documents" tone={t.compliance.length ? '#b42318' : undefined}>{t.compliance.length ? `Missing: ${t.compliance.join(', ')}` : 'All in'}</Row> : null}
      </dl>
    </>
  );
}

/** A unit nobody rents: what it asks, how long it has sat, and why (out of service). */
function VacantCard({ u, fact, occ, days }) {
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{occ === 'bad' ? 'Out of Service' : 'Vacant Unit'}</div>
      {occ === 'bad' ? <div style={{ fontSize: 12.5, marginTop: 2 }}><span style={muted}>Reason:</span> <b>{reasonGroup(u.why, u.note)}</b>{u.note ? <span style={muted}> - {u.note.trim()}</span> : null}</div>
        : fact?.vacantSince ? <div style={{ fontSize: 12.5, ...muted, marginTop: 2 }}>Empty since {formatDate(fact.vacantSince)}</div> : null}
      <Figures>
        <Figure label="Street Rate" value={fact?.street ? money(fact.street) : '-'} sub="per month" />
        {occ === 'vacant' ? <Figure label="Days Vacant" value={days == null ? 'Not Known' : String(days)} tone={days >= 90 ? '#9a3412' : undefined} /> : null}
        <Figure label="Market Median" value={fact?.marketMedian ? money(fact.marketMedian) : '-'} sub={fact?.market ? (fact.market === 'at' ? 'at market' : `${Math.abs(fact.marketPct || 0)}% ${fact.market}`) : fact?.marketCount ? 'too few rates' : 'no rates'} />
      </Figures>
      {occ === 'vacant' && typeof days === 'number' && days >= 90 && <p style={{ fontSize: 12, margin: '6px 0 0', color: '#9a3412' }}>Empty {days} days - worth a look at this unit's rate.</p>}
    </>
  );
}

function UnitDetails({ u, fact, maint, facilityId, onOpenTicket, onReport, onLedger, pickUnit, openElsewhere, reload = 0 }) {
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
  const t = detail?.tenant;
  const ticketLine = (x) => (
    <li key={x.id}>
      <button type="button" onClick={() => onOpenTicket(x)} className="sm-ticket"
        style={{ width: '100%', display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', borderRadius: 8, padding: '5px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'inherit' }}>
        <b style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{x.subject || 'Ticket'}</b>
        <span style={{ ...muted, whiteSpace: 'nowrap' }}>{TICKET_WORD[x.status] || 'Open'} · {formatDate(x.closed ? (x.resolvedAt || x.createdAt) : x.createdAt)}</span>
      </button>
    </li>
  );
  let body;
  if (err) body = <p role="alert" style={{ fontSize: 12, color: '#c43d2f', margin: 0 }}>{err}</p>;
  else if (occ === 'leased') {
    body = !detail ? <SkeletonBlocks count={5} height={16} borderRadius={4} />
      : t ? <TenantCard t={t} detail={detail} fact={fact} onLedger={() => onLedger(t.customerId)} pickUnit={pickUnit} openElsewhere={openElsewhere} />
      : <p style={{ fontSize: 12, margin: 0, ...muted }}>{detail.connected ? 'Cubby has no tenant on this unit right now.' : 'Tenant details are not available - Cubby has not synced yet.'}</p>;
  } else body = <VacantCard u={u} fact={fact} occ={occ} days={days} />;
  return (
    <div>
      {fact?.type ? <div style={{ fontSize: 12, ...muted, marginTop: 2 }}>Pricing Group: {fact.type}</div> : null}
      <div className="sm-tenant" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>{body}</div>

      <Head>Tickets{detail ? ` (${tickets.open.length} Open)` : ''}</Head>
      {!detail && !err ? <div style={{ marginTop: 6 }}><SkeletonBlocks count={1} height={22} borderRadius={6} /></div> : (
        <>
          {tickets.open.length ? <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>{tickets.open.map(ticketLine)}</ul>
            : <p style={{ fontSize: 12, margin: '6px 0 0', ...muted }}>No open tickets on this unit.</p>}
          {tickets.recent.length ? <>
            <div style={{ fontSize: 12, fontWeight: 600, ...muted, margin: '8px 0 2px' }}>Recently Closed</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.8 }}>{tickets.recent.map(ticketLine)}</ul>
          </> : null}
          {otherItems.length ? <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, fontSize: 12 }}>{otherItems.slice(0, 4).map((x) => <li key={`m-${x.id}`}><b>Maintenance</b> · {x.title}{x.opened_at ? ` · ${formatDate(x.opened_at)}` : ''}</li>)}</ul> : null}
        </>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {t?.cubbyUrl ? <a className="secondary-btn" href={t.cubbyUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', fontSize: 12.5, padding: '5px 10px' }}>Open in Cubby</a> : null}
        <button type="button" className="secondary-btn" onClick={() => onReport(tickets.property)} disabled={!tickets.property} title={tickets.property ? '' : 'This facility is not linked to a property in Asset Management yet'} style={{ fontSize: 12.5, padding: '5px 10px' }}>Report an Issue</button>
        <button type="button" className="secondary-btn" onClick={copy} disabled={link.status === 'busy'} style={{ fontSize: 12.5, padding: '5px 10px' }}>{link.status === 'copied' ? 'Copied' : 'Copy Customer Link'}</button>
      </div>
      {link.status === 'copied' && <div style={{ fontSize: 12, marginTop: 4, ...muted }}>Route-only map for this unit, no login.</div>}
      {link.error && <div role="alert" style={{ fontSize: 12, marginTop: 4, color: '#c43d2f' }}>{link.error}</div>}
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

// Mounted beside the map (true) and in its crash fallback (false), so the page
// knows whether the map's search box is on screen after a boundary reset too.
function SearchHere({ on, onChange }) {
  useEffect(() => { onChange?.(on); }, [on, onChange]);
  return null;
}
function SearchGone({ onGone }) {
  useEffect(() => { onGone?.(false); }, [onGone]);
  return <div className="dash-card"><div className="ops-empty">The site map hit a problem. Switch facility or layer to try again.</div></div>;
}

// onMapSearch(true) once the map (and its search box) is on screen, false
// otherwise - the page shows its own tenant/unit Lookup whenever it is false.
export default function SiteMap({ facility, facilities = [], onPick = null, modelIds = null, onMapSearch = null }) {
  const facilityId = facility?.id || '';
  // A search hit at another facility switches the page's Facility, then opens
  // the unit once that facility's model is in (used once, then cleared).
  const pendingRef = useRef(null);
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const [maint, setMaint] = useState(null);
  const [layer, setLayerState] = useState(readLayer);
  const [settings, setSettings] = useState(false);
  const [openTicket, setOpenTicket] = useState(null);
  const [report, setReport] = useState(null);
  const [ledger, setLedger] = useState(null);   // ['tenant', facilityId, customerId] - the Reports drill-down
  const [reload, setReload] = useState(0);   // a ticket filed or changed from the card refreshes it
  const setLayer = (k) => { setLayerState(k); saveLayer(k); };
  const mapShown = !!facility && state.status === 'ready';
  useEffect(() => { onMapSearch?.(mapShown); }, [onMapSearch, mapShown]);
  useEffect(() => () => onMapSearch?.(false), [onMapSearch]);

  const load = useCallback(() => {
    if (!facilityId) return undefined;
    let on = true;
    setState({ status: 'loading', data: null, error: null }); setMaint(null);
    api.getOpsSiteMap(facilityId).then((d) => {
      if (!on) return;
      const p = pendingRef.current; pendingRef.current = null;
      setState({ status: 'ready', data: d, error: null, unit: p && p.facilityId === facilityId ? normalizeQuery(p.unit) : '' });
    })
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
  const buckets = useMemo(() => (units ? layerBuckets(layer, units, facts, maint) : null), [layer, units, facts, maint]);
  const statusOf = useCallback((u) => occupancyOf(u, facts[u.n]), [facts]);
  const markers = useMemo(() => {
    if (layer !== 'maintenance' || !maint?.connected) return {};
    return Object.fromEntries(Object.entries(maint.units).filter(([, v]) => v?.length).map(([k, v]) => [k, v.length]));
  }, [layer, maint]);
  const hoverInfo = useCallback((u) => hoverFact(layer, u, facts, maint), [layer, facts, maint]);
  // A tenant's unit at another facility: switch the page's Facility, then open the unit there.
  const openElsewhere = useCallback((o) => {
    if (!onPick || !facilities.some((f) => f.id === o.facilityId) || (Array.isArray(modelIds) && !modelIds.includes(o.facilityId))) return null;
    return () => { pendingRef.current = { facilityId: o.facilityId, unit: o.unit }; onPick(o.facilityId); };
  }, [onPick, facilities, modelIds]);
  const renderUnitExtra = useCallback((u, ctx) => (
    <UnitDetails key={u.n} u={u} fact={facts[u.n]} maint={maint} facilityId={facilityId} reload={reload}
      pickUnit={ctx?.pickUnit} openElsewhere={openElsewhere} onLedger={(cid) => cid && setLedger(['tenant', facilityId, cid])}
      onOpenTicket={(t) => setOpenTicket(t)} onReport={(p) => p && setReport({ id: p.id, name: p.name, unit: u.n })} />
  ), [facts, maint, facilityId, reload, openElsewhere]);
  // The map search's Cubby half: tenants anywhere, units at the other facilities.
  const remoteSearch = useCallback((q) => api.facilityOpsLookup(q).then((r) => (r?.results || []).map((h) => ({
    ...h, here: h.facilityId === facilityId, noMap: h.facilityId !== facilityId && Array.isArray(modelIds) && !modelIds.includes(h.facilityId),
  }))), [facilityId, modelIds]);
  const onRemoteHit = useCallback((h) => {
    if (!onPick || !facilities.some((f) => f.id === h.facilityId)) return;
    pendingRef.current = { facilityId: h.facilityId, unit: h.unit };
    onPick(h.facilityId);
  }, [onPick, facilities]);

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
    occupancy: 'Green is leased, yellow is vacant and ready to rent, red is out of service (not leased and cannot be rented). Click a color to show only those units on the map.',
    days: `How long each empty unit has sat empty - the darker, the longer. ${vacantLong} vacant 90+ days.`,
    market: `Our rate (rent if leased, street rate if vacant) against competitors' median for the same size. Within ${Math.round((data.marketBand || 0.05) * 100)}% counts as at market.`,
    maintenance: maint?.connected ? 'Units with open tickets or maintenance items - red is urgent.' : maint ? 'Maintenance layer not connected yet.' : 'Loading maintenance items…',
  }[layer];
  const vacantAll = units.filter((u) => u.n[0] !== 'M' && !u.gone && occupancyOf(u, facts[u.n]) === 'vacant').length;
  const layerTitle = { days: `Days Vacant · ${vacantAll} Vacant`, market: 'Market', maintenance: 'Maintenance' }[layer] || '';
  const toolbar = (
    <>
      <SectionPicker label="Layer" icon={Layers} value={layer} onChange={setLayer} className="ops-section--map"
        options={LAYERS.map((l) => ({ value: l.key, label: l.label }))} />
      <button type="button" className="sm-icon-btn" aria-label="Customer Link Settings" title="Customer Link Settings" onClick={() => setSettings(true)}>
        <Settings size={16} aria-hidden="true" />
      </button>
    </>
  );
  const property = layer === 'maintenance' && maint?.connected && maint.property?.length ? maint.property : null;
  const asideExtra = property ? (
    <details open className="sm-fold" style={{ borderTop: '1px solid var(--border-color, #d9d6cc)' }}>
      <summary style={{ padding: '11px 0', cursor: 'pointer', font: "600 13px 'Inter', system-ui, sans-serif", display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>Property-Wide ({property.length})</span><span aria-hidden="true" className="sm-chev" style={{ ...muted, fontSize: 11 }}>▶</span>
      </summary>
      <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 12px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        {property.map((x, i) => <li key={x.id || i} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{x.title}</span>
          {x.opened_at ? <span style={{ ...muted, whiteSpace: 'nowrap' }}>{formatDate(x.opened_at)}</span> : null}
        </li>)}
      </ul>
    </details>
  ) : null;
  return (
    <div>
      <WidgetBoundary name="ops-site-map" resetKey={`${facilityId}:${layer}`} fallback={<SearchGone onGone={onMapSearch} />}>
        <SearchHere on onChange={onMapSearch} />
        <SiteModelPanel key={data.modelId || facilityId} model={data.model} mode="owner" images={siteModelImages(data.modelId)} unitColors={colors} statusOf={statusOf} fill
          initialUnit={state.unit || ''} placeName={facility.shortName || ''} toolbar={toolbar} legendHint={hint} asideExtra={asideExtra}
          remoteSearch={remoteSearch} onRemoteHit={onRemoteHit}
          kpis={data.kpis || null} layerBuckets={buckets} layerTitle={layerTitle}
          layerNote={layer === 'maintenance' && !maint?.connected ? (maint ? 'Maintenance layer not connected yet.' : 'Loading maintenance items...') : ''} hoverInfo={hoverInfo} renderUnitExtra={renderUnitExtra}
          markers={markers} pinsEnabled={false} />
      </WidgetBoundary>
      {settings && <CustomerLinkSettings facilityId={facilityId} entrance={data.entrance} template={data.cubbyTemplate} onClose={() => setSettings(false)}
        onSaved={(entrance) => setState((s) => ({ ...s, data: { ...s.data, entrance } }))} />}
      {openTicket && <PropertyTicketDrawer ticketId={openTicket.id} onClose={() => { setOpenTicket(null); setReload((n) => n + 1); }} />}
      {ledger && <DrillPanel key={ledger.join(':')} target={ledger} onClose={() => setLedger(null)} />}
      {report && <PropertyTicketComposer property={report} onClose={() => { setReport(null); setReload((n) => n + 1); }} />}
    </div>
  );
}
